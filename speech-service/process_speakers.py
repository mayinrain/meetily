"""Process a saved recording after ASR has released its model.

The native stream lives for the whole meeting. Results are exposed only after
complete natural-segment batches; bounded internal reads do not create new
speech segments, reset speaker state, or remove pauses from the time axis.
"""
import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import subprocess
import time
import wave

import numpy as np

from core import Run, ffmpeg_path, save_json, sha256
from atomic_json import write_json as write_progress
from nemo_stream import NativeSpeakerStream
from speaker_batches import annotate_segments, plan_batches


@dataclass
class SpeakerConfig:
    library: str
    model: str
    target_span_s: float = 30
    threads: int = 4  # Fixed by the native v0.1.0 CPU implementation.
    gpu: int = -1


def process_recording(audio_path, segments, config, run):
    plan = plan_batches(segments, config.target_span_s, recording_finished=True)
    save_json(run.path/'dispatch-plan.json', plan)
    run.event('model_files', files=[dict(path=str(Path(p).resolve()), sha256=sha256(p))
                                   for p in (config.library, config.model)])
    wav_path = run.path/'input.wav'
    started = time.perf_counter()
    command = [ffmpeg_path(), '-nostdin', '-v', 'error', '-i', str(audio_path),
               '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', str(wav_path)]
    with (run.path/'decode.log').open('x') as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    run.event('decoded', command=command, duration_s=time.perf_counter()-started,
              audio_sha256=sha256(wav_path))
    engine = None
    try:
        with wave.open(str(wav_path), 'rb') as source:
            total_frames = source.getnframes()
            # Reject stale/mismatched segment metadata rather than silently trim it.
            if segments and max(s['audio_end_time'] for s in segments) > total_frames/16000 + 0.03:
                raise ValueError('Transcript timestamps exceed the saved audio')
            started = time.perf_counter()
            engine = NativeSpeakerStream(config.library, config.model, config.gpu)
            load_s = time.perf_counter()-started
            run.event('model_loaded', duration_s=load_s)
            batches = list(plan['batches'])
            if not batches or batches[-1]['end'] < total_frames/16000:
                batches.append(dict(end=total_frames/16000, segment_ids=[], reason='recording_end'))
            inference_s = 0.0
            for index, batch in enumerate(batches):
                endpoint = min(total_frames, round(batch['end']*16000))
                started = time.perf_counter()
                # VAD padding can overlap. Feed each sample once, including gaps.
                while source.tell() < endpoint:
                    data = source.readframes(min(endpoint-source.tell(), 16000))
                    samples = np.frombuffer(data, dtype='<i2').astype(np.float32)/32768
                    engine.push(samples)
                elapsed = time.perf_counter()-started
                inference_s += elapsed
                write_progress(run.path/'progress.json', dict(audio_end_s=source.tell()/16000,
                    audio_duration_s=total_frames/16000, completed_batches=index+1,
                    total_batches=len(batches)))
                run.event('speaker_batch', index=index, audio_end_s=endpoint/16000,
                          segment_ids=batch['segment_ids'], reason=batch['reason'], inference_s=elapsed)
            started = time.perf_counter()
            turns = engine.finish()
            inference_s += time.perf_counter()-started
        save_json(run.path/'speaker-turns.raw.json', turns)
        result = dict(run_id=run.id, audio_duration_s=total_frames/16000,
                      turns=turns, segments=annotate_segments(segments, turns),
                      speaker_count=len({t['speaker'] for t in turns}),
                      identity_status='anonymous', model_load_s=load_s, inference_s=inference_s)
        save_json(run.path/'result.json', result)
        return result
    finally:
        if engine is not None:
            engine.close()
            run.event('model_released')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('audio', type=Path)
    parser.add_argument('--transcripts', type=Path, required=True)
    parser.add_argument('--library', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--runs', type=Path, required=True)
    parser.add_argument('--meeting-id', required=True)
    parser.add_argument('--target', type=float, choices=[30, 60], default=30)
    parser.add_argument('--gpu', type=int, choices=[-1, 0], default=-1)
    args = parser.parse_args()
    config = SpeakerConfig(str(args.library.resolve()), str(args.model.resolve()), args.target, gpu=args.gpu)
    segments = json.loads(args.transcripts.read_text(encoding='utf-8-sig'))['segments']
    run = Run(args.runs, 'meeting-speakers', config, phase='diarization', cold_start=True,
              execution_provider='cpu' if args.gpu == -1 else 'GPU 0; verify worker.log',
              meeting_id=args.meeting_id, quantization='Q8_0',
              audio_path=str(args.audio.resolve()), audio_sha256=sha256(args.audio),
              transcripts_sha256=sha256(args.transcripts), mode='after-recording')
    print(run.path, flush=True)
    try:
        result = process_recording(args.audio, segments, config, run)
        run.finish(audio_duration_s=result['audio_duration_s'],
                   model_load_s=result['model_load_s'], inference_s=result['inference_s'],
                   speaker_count=result['speaker_count'], turn_count=len(result['turns']))
    except BaseException as error:
        run.fail(error)
        raise


if __name__ == '__main__':
    main()
