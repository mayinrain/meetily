"""Read bounded framed PCM from the service; keep one speaker state per recording."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys
import time

import numpy as np
import psutil

from core import Run, save_json, sha256
from nemo_stream import NativeSpeakerStream
from process_speakers import SpeakerConfig, write_progress
from speaker_batches import annotate_segments, plan_batches


def read_exact(stream, count):
    data = bytearray()
    while len(data) < count:
        block = stream.read(count-len(data))
        if not block:
            raise EOFError('Recording disconnected without finalization')
        data.extend(block)
    return data


def process(directory, sample_rate, config, run, source):
    engine = None
    frames, published, inference_s = 0, 0, 0.0
    audio_hash = hashlib.sha256()
    segments, result = [], None
    metadata_mtime = None
    metadata = directory/'transcripts.json'
    try:
        started = time.perf_counter()
        engine = NativeSpeakerStream(config.library, config.model, config.gpu)
        load_s = time.perf_counter()-started
        run.event('model_loaded', duration_s=load_s, requested_gpu=config.gpu)
        while True:
            count, = struct.unpack('<I', read_exact(source, 4))
            if count > sample_rate*4 or count % 4:
                raise ValueError('Expected at most one second of complete float32 PCM')
            finished = count == 0
            began = time.perf_counter()
            if finished:
                turns = engine.finish()
            else:
                if psutil.virtual_memory().available < 512*1024*1024:
                    raise RuntimeError('Less than 512 MiB system memory available')
                data = read_exact(source, count)
                audio_hash.update(data)
                pcm = np.frombuffer(data, dtype='<f4')
                engine.push(pcm, sample_rate)
                frames += len(pcm)
            inference_s += time.perf_counter()-began
            modified = metadata.stat().st_mtime_ns
            if modified != metadata_mtime or finished:
                segments = json.loads(metadata.read_text(encoding='utf-8'))['segments']
                plan = plan_batches(segments, config.target_span_s, finished)
                metadata_mtime = modified
            eligible = [b for b in plan['batches'] if b['end'] <= frames/sample_rate+0.03]
            if finished and segments and max(s['audio_end_time'] for s in segments) > frames/sample_rate+0.03:
                raise ValueError('Transcript timestamps exceed received recording audio')
            if finished or len(eligible) > published:
                if not finished:
                    turns = engine.turns()
                ids = {i for b in eligible for i in b['segment_ids']}
                visible = segments if finished else [s for s in segments if s['id'] in ids]
                result = dict(run_id=run.id, audio_duration_s=frames/sample_rate, turns=turns,
                    published_through_s=max((s['audio_end_time'] for s in visible), default=0),
                    input_pcm_sha256=audio_hash.hexdigest(), input_sample_rate=sample_rate, input_frames=frames,
                    segments=annotate_segments(visible, turns), speaker_count=len({t['speaker'] for t in turns}),
                    identity_status='anonymous', provisional=not finished, model_load_s=load_s, inference_s=inference_s)
                published = len(eligible)
                run.event('speaker_snapshot', audio_end_s=frames/sample_rate,
                          complete_batches=published, segments=len(visible), provisional=not finished)
            progress = dict(audio_end_s=frames/sample_rate, received_frames=frames,
                            completed_batches=published, result=result)
            write_progress(directory/'progress.json', progress)
            if finished:
                result['source_segments'] = segments
                save_json(run.path/'result.json', result)
                save_json(run.path/'dispatch-plan.json', plan)
                save_json(run.path/'transcripts.json', dict(segments=segments))
                return result
    finally:
        if engine is not None:
            engine.close()
            run.event('model_released')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--library', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--gpu', type=int, default=-1)
    parser.add_argument('--sample-rate', type=int, choices=[16000, 48000], required=True)
    parser.add_argument('--target', type=float, default=30)
    args = parser.parse_args()
    config = SpeakerConfig(args.library, args.model, target_span_s=args.target, gpu=args.gpu)
    run = Run(args.directory, 'meeting-speakers', config, mode='recording-live',
              execution_provider='verify requested device in worker.log', sample_rate=args.sample_rate,
              model_files=[dict(path=p, sha256=sha256(p)) for p in (config.library, config.model)])
    try:
        result = process(args.directory, args.sample_rate, config, run, sys.stdin.buffer)
        run.finish(audio_duration_s=result['audio_duration_s'], inference_s=result['inference_s'],
                   speaker_count=result['speaker_count'])
    except BaseException as error:
        run.fail(error)
        raise


if __name__ == '__main__':
    main()
