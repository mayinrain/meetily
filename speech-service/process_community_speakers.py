"""Accumulate Community-1 features and publish labelled natural batches during capture.

PCM packets are transport units, not independent diarization segments. Model
windows retain context and all original ASR segments remain intact.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time
import wave

from community_config import CommunityConfig


def read_exact(source, count):
    data = bytearray()
    while len(data) < count:
        part = source.read(count-len(data))
        if not part:
            raise EOFError('Speaker audio disconnected before finalization')
        data.extend(part)
    return data


def integer_turns(output):
    # Labels are meeting-local, ordered by first appearance; never limited to 4.
    names = {}
    raw = []
    for segment, _, label in output.speaker_diarization.itertracks(yield_label=True):
        speaker = names.setdefault(label, len(names)+1)
        raw.append(dict(start=float(segment.start), end=float(segment.end), speaker=speaker))
    exclusive = [dict(start=float(s.start), end=float(s.end), speaker=names[label])
                 for s, _, label in output.exclusive_speaker_diarization.itertracks(yield_label=True)]
    return raw, exclusive


def process(directory, sample_rate, config, run, packets, segments_path):
    import numpy as np
    import psutil
    import torch
    from pyannote.audio import Pipeline
    from community1_feature_stream import CommunityFeatureStream, finalize_features
    from community1_shared_frames import enable_shared_frames
    from community_resample import PCM16k
    from core import save_json, sha256
    from process_speakers import write_progress
    from speaker_batches import plan_batches
    from community_batches import MeetingSpeakerBatches

    torch.set_num_threads(config.threads)
    torch.set_num_interop_threads(1)
    torch.manual_seed(0)
    np.random.seed(0)
    run.event('model_files', files=[dict(path=str(p.relative_to(config.model)), sha256=sha256(p))
        for p in sorted(Path(config.model).rglob('*')) if p.is_file() and '.cache' not in p.parts])
    began = time.perf_counter()
    pipeline = Pipeline.from_pretrained(config.model)
    pipeline.to(torch.device('cpu'))
    pipeline.segmentation_batch_size = pipeline.embedding_batch_size = 1
    enable_shared_frames(pipeline)
    load_s = time.perf_counter()-began
    run.event('model_loaded', duration_s=load_s)
    stream, resampler = CommunityFeatureStream(pipeline), PCM16k(sample_rate)
    published = MeetingSpeakerBatches()
    frames, compute_s, last_progress = 0, 0.0, 0.0
    metadata_mtime, segments, plan = None, [], {'batches': []}
    digest = hashlib.sha256()
    # One in-flight snapshot bounds memory and keeps slow cumulative clustering
    # out of the PCM reader. Completed ASR batches remain queued in their plan.
    cluster_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='speaker-clustering')
    pending = None

    def cluster_snapshot(segmentation, embeddings):
        began = time.perf_counter()
        output = finalize_features(pipeline, segmentation, embeddings, uri=directory.name)
        return *integer_turns(output), time.perf_counter()-began

    def publish_ready(wait=False):
        nonlocal pending, compute_s
        if pending is None or (not wait and not pending[0].done()):
            return
        future, eligible, source = pending
        raw, exclusive, clustering_s = future.result()
        published.publish(raw, exclusive, eligible, source)
        compute_s += clustering_s
        ids = {sid for b in eligible for sid in b['segment_ids']}
        visible = [row for row in source if row['id'] in ids]
        snapshot = dict(published.result(visible), provisional=True, model=config.backend,
                        audio_duration_s=frames/sample_rate, inference_s=compute_s)
        write_progress(directory/'published.json', snapshot)
        save_json(run.path/f'batch-{len(published.batches):04}.json', snapshot)
        run.event('speaker_batch', batches=len(published.batches), through_s=published.through,
                  history_conflicts_s=published.history_conflicts_s, clustering_s=clustering_s)
        pending = None

    for data in packets:
        if psutil.virtual_memory().available < 512*1024*1024:
            raise RuntimeError('Less than 512 MiB available; recording and ASR can continue')
        pcm = np.frombuffer(data, dtype='<f4')
        if not np.isfinite(pcm).all():
            raise ValueError('Non-finite speaker PCM')
        digest.update(data)
        frames += len(pcm)
        began = time.perf_counter()
        stream.accept(resampler.accept(pcm))
        compute_s += time.perf_counter()-began
        publish_ready()
        modified = segments_path.stat().st_mtime_ns
        if modified != metadata_mtime:
            segments = json.loads(segments_path.read_text(encoding='utf-8-sig'))['segments']
            plan = plan_batches(segments, config.target_span_s)
            metadata_mtime = modified
        # Keep half a model window of future context before committing a batch.
        eligible = [b for b in plan['batches'] if b['end'] <= stream.complete_through_s-5]
        if pending is None and len(eligible) > len(published.batches):
            segmentation, embeddings = stream.snapshot_features()
            pending = (cluster_pool.submit(cluster_snapshot, segmentation, embeddings), eligible, segments)
        if time.perf_counter()-last_progress >= 1:
            progress = dict(audio_end_s=frames/sample_rate, received_frames=frames,
                            phase='features', feature_windows=stream.processed_windows,
                            inference_s=compute_s, result=None)
            write_progress(directory/'progress.json', progress)
            write_progress(run.path/'progress.json', progress)
            last_progress = time.perf_counter()
    eos = time.perf_counter()
    publish_ready(wait=True)
    cluster_pool.shutdown(wait=True)
    run.event('input_finished', input_frames=frames, input_pcm_sha256=digest.hexdigest())
    segments = json.loads(segments_path.read_text(encoding='utf-8-sig'))['segments']
    plan = plan_batches(segments, config.target_span_s, recording_finished=True)
    duration = frames/sample_rate
    if segments and max(row['audio_end_time'] for row in segments) > duration+0.03:
        raise ValueError('Transcript timestamps exceed received recording audio')
    # A quick stop before any PCM is still a valid empty recording.
    if frames:
        stream.accept(resampler.accept(np.empty(0, dtype=np.float32), finished=True))
        segmentation, embeddings = stream.finish_features()
        output = finalize_features(pipeline, segmentation, embeddings, uri=directory.name)
        raw, turns = integer_turns(output)
    else:
        raw, turns = [], []
    published.publish(raw, turns, plan['batches'], segments, final_end=duration)
    finalized = time.perf_counter()
    annotations = published.result(segments)
    aligned = time.perf_counter()
    result = dict(run_id=run.id, model=config.backend, audio_duration_s=duration,
                  input_sample_rate=sample_rate, input_frames=frames, input_pcm_sha256=digest.hexdigest(),
                  **annotations,
                  provisional=False, model_load_s=load_s, inference_s=compute_s+finalized-eos,
                  finalization_s=finalized-eos, temporal_alignment_s=aligned-finalized)
    save_json(run.path/'speaker-turns.raw.json', result['raw_turns'])
    save_json(run.path/'speaker-turns.exclusive.json', result['turns'])
    save_json(run.path/'transcripts.json', dict(segments=segments))
    save_json(run.path/'result.json', result)
    saved = time.perf_counter()
    run.event('attributed_transcript_saved', eos_to_saved_s=saved-eos,
              temporal_alignment_s=aligned-finalized, result_save_s=saved-aligned)
    run.finish(audio_duration_s=duration, inference_s=result['inference_s'],
               input_frames=frames, input_pcm_sha256=digest.hexdigest(), speaker_count=result['speaker_count'],
               eos_to_saved_s=saved-eos, temporal_alignment_s=aligned-finalized, result_save_s=saved-aligned)
    return result


def live_packets(source, sample_rate):
    while True:
        count, = struct.unpack('<I', read_exact(source, 4))
        if count == 0:
            return
        if count > sample_rate*4 or count % 4:
            raise ValueError('Expected at most one second of mono float32 PCM')
        yield read_exact(source, count)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--sample-rate', type=int, choices=[16000, 48000], default=48000)
    parser.add_argument('--audio', type=Path, help='Saved-audio retry/import instead of live framed PCM')
    args = parser.parse_args()
    if args.threads < 1:
        parser.error('threads must be positive')
    os.environ.update(HF_HUB_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', PYANNOTE_METRICS_ENABLED='0',
                      OMP_NUM_THREADS=str(args.threads), MKL_NUM_THREADS=str(args.threads),
                      OPENBLAS_NUM_THREADS=str(args.threads))
    import numpy as np
    from core import Run, ffmpeg_path
    config = CommunityConfig(sys.executable, str(args.model.resolve()), threads=args.threads)
    run = Run(args.directory, 'meeting-speakers', config, mode='saved' if args.audio else 'recording-live',
              execution_provider='pytorch-cpu', quantization='FP32', offline_flags=True,
              timing_scope='Worker EOS to attributed JSON saved; API/client/application timing recorded separately')
    print(run.path, flush=True)
    try:
        if args.audio:
            # Disk-backed decode avoids retaining an entire meeting in RAM.
            decoded = run.path/'input.wav'
            with (run.path/'decode.log').open('x') as log:
                subprocess.run([ffmpeg_path(), '-nostdin', '-v', 'error', '-i', str(args.audio),
                    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', str(decoded)],
                    stdout=log, stderr=subprocess.STDOUT, check=True)
            with wave.open(str(decoded), 'rb') as source:
                def packets():
                    while data := source.readframes(16000):
                        yield (np.frombuffer(data, dtype='<i2').astype(np.float32)/32768).tobytes()
                process(args.directory, 16000, config, run, packets(), args.directory/'transcripts.json')
        else:
            process(args.directory, args.sample_rate, config, run,
                    live_packets(sys.stdin.buffer, args.sample_rate), args.directory/'transcripts.json')
    except BaseException as error:
        run.fail(error)
        raise


if __name__ == '__main__':
    main()
