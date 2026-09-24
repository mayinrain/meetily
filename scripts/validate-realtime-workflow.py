"""1x real-model API replay: live ASR/VAD -> Community-1 batches -> section-wise report.

This excludes microphone capture, AAC encoding and the desktop UI/SQLite save.
Use a fresh output directory. No model text or speaker labels are precomputed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
import time

import httpx
import numpy as np
import psutil

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT/'speech-service'))
from core import Config, Engine, Run, Session, read_wav


def atomic(file, value):
    temporary = file.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temporary.replace(file)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--audio', type=Path, required=True)
    p.add_argument('--models', type=Path, required=True)
    p.add_argument('--community-python', type=Path, required=True)
    p.add_argument('--llama-server', type=Path, required=True)
    p.add_argument('--node', default=shutil.which('node'))
    p.add_argument('--seconds', type=float, default=180)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    run = args.output
    workflow = run/'workflow'
    workflow.mkdir()
    runtime = run/'runtime'
    shutil.copytree(ROOT/'frontend/src-tauri/resources/summary-workflow', runtime)
    service_source = run/'speech-source'
    service_source.mkdir()
    for file in (ROOT/'speech-service').iterdir():
        if file.suffix == '.py' or file.name.startswith('requirements'):
            shutil.copy2(file, service_source/file.name)
    shutil.copy2(__file__, run/'replay-driver.py')
    source_files = [run/'replay-driver.py', *runtime.glob('*.mjs'), *service_source.iterdir()]
    atomic(run/'source-manifest.json', {str(f.relative_to(run)): hashlib.sha256(f.read_bytes()).hexdigest()
                                      for f in source_files})
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    client = httpx.Client(base_url=f'http://127.0.0.1:{port}', timeout=30, trust_env=False)
    env = dict(os.environ, MEETILY_WORKFLOW_SERVER=str(args.llama_server.resolve()),
               MEETILY_WORKFLOW_MODEL=str((args.models/'Qwen3.5-4B-Q4_K_M.gguf').resolve()))
    server = node = None
    stop = threading.Event()
    samples = read_wav(args.audio, duration=args.seconds).mean(axis=1)
    metrics = dict(mode='real-model-1x-api-replay', duration_s=len(samples)/16000,
                   excludes=['microphone', 'AAC', 'desktop UI', 'SQLite'], platform=sys.platform)

    def monitor():
        with (run/'resources.jsonl').open('w') as f:
            while not stop.wait(.5):
                available = psutil.virtual_memory().available
                rss = 0
                for process in [psutil.Process(), *psutil.Process().children(recursive=True)]:
                    try:
                        rss += process.memory_info().rss
                    except psutil.Error:
                        pass
                atomic(workflow/'memory.json', dict(available_bytes=available))
                f.write(json.dumps(dict(t=time.time(), rss_bytes=rss, available_bytes=available))+'\n')
                f.flush()
    atomic(workflow/'memory.json', dict(available_bytes=psutil.virtual_memory().available))
    thread = threading.Thread(target=monitor)
    thread.start()

    def request(method, route, **kwargs):
        response = client.request(method, route, **kwargs)
        response.raise_for_status()
        return response.json()

    try:
        with (run/'speech.log').open('w') as log:
            server = subprocess.Popen([sys.executable, '-u', service_source/'server.py',
                '--port', str(port), '--models', args.models, '--runs', run/'speech', '--threads', '2',
                '--community-python', args.community_python, '--community-model', args.models/'pyannote-community-1',
                '--stop-file', run/'service.stop'], stdout=log, stderr=log)
        deadline = time.monotonic()+30
        while True:
            try:
                request('GET', '/health')
                break
            except httpx.TransportError:
                if server.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Speech service startup failed')
                time.sleep(.1)
        request('POST', '/v1/models/load')
        job = request('POST', '/v1/speaker-streams', json=dict(sample_rate=16000))
        base = '/v1/speaker-streams/'+job['job_id']
        with (run/'summary.stderr.log').open('w') as log:
            node = subprocess.Popen([args.node, runtime/'live.mjs', workflow],
                env=env, stdin=subprocess.PIPE, stdout=log, stderr=log)

        class RemoteEngine:
            config = Config(str(args.models), threads=2)
            new_vad = Engine.new_vad
            def decode(self, pcm, start, *unused):
                began = time.monotonic()
                output = request('POST', '/v1/segment', content=pcm.astype('<f4').tobytes())
                return dict(id='segment-'+str(len(rows)), text=output['text'], start=start,
                            end=start+len(pcm)/16000, inference_s=time.monotonic()-began)

        rows = []
        source_run = Run(run/'vad', 'meetily', RemoteEngine.config, mode='actual VAD with HTTP ASR')
        session = Session(RemoteEngine(), source_run)
        epoch = time.monotonic()
        stopped_at = None
        maximum_lag = 0

        def publish(new_rows):
            for row in new_rows:
                rows.append(dict(id='segment-'+str(len(rows)), text=row['text'],
                    audio_start_time=row['start'], audio_end_time=row['end']))
            if new_rows:
                request('POST', base+'/segments', json=dict(segments=rows))
            snapshot = request('GET', base)
            snapshot['recording_stopped_at'] = stopped_at
            snapshot['transcript_segments'] = rows
            atomic(workflow/'input.json', snapshot)
            return snapshot

        for position in range(0, len(samples), 16000):
            chunk = samples[position:position+16000]
            release = epoch+(position+len(chunk))/16000
            time.sleep(max(0, release-time.monotonic()))
            maximum_lag = max(maximum_lag, time.monotonic()-release)
            request('POST', base+f'/audio?offset={position}', content=chunk.astype('<f4').tobytes())
            snapshot = publish(session.feed(chunk))
            if snapshot['status'] != 'running':
                raise RuntimeError(snapshot.get('error', 'Speaker process failed'))
        stopped_at = round(time.time()*1000)
        stop_clock = time.monotonic()
        publish(session.finish())
        source_run.finish(segment_count=len(rows))
        request('POST', base+'/finish')
        while True:
            snapshot = publish([])
            if snapshot['status'] != 'running':
                break
            if time.monotonic()-stop_clock > 120:
                raise TimeoutError('Speaker drain timed out')
            time.sleep(.2)
        if snapshot['status'] != 'completed':
            raise RuntimeError(snapshot.get('error', 'Speaker analysis failed'))
        metrics['speakers_seconds_after_stop'] = time.monotonic()-stop_clock
        request('POST', '/v1/models/unload')
        metrics['worker_exit'] = node.wait(timeout=max(5, 1210-(time.monotonic()-stop_clock)))
        summary = json.loads((workflow/'state.json').read_text())
        labelled = [s for b in snapshot['result']['batches'] for s in b['segments']]
        assert len(labelled) == len(rows)
        assert all(all(a[k] == b[k] for k in ('id', 'text', 'audio_start_time', 'audio_end_time')) for a, b in zip(rows, labelled))
        metrics.update(status=summary['status'], segments=len(rows), batches=len(summary['batches']),
                       completed_batches=summary['completed_batches'], failed_batches=summary['failed_batches'],
                       maximum_audio_lag_s=maximum_lag, summary_seconds_after_stop=time.monotonic()-stop_clock,
                       within_post_stop_target=summary['within_post_stop_target'], route=summary.get('route'),
                       notes=len(summary['notes']), maximum_pending_characters=summary['maximum_pending_characters'],
                       error=summary.get('error'))
        atomic(run/'speakers.json', snapshot)
        atomic(run/'transcripts.json', rows)
    except BaseException as error:
        metrics.update(status='failed', error=str(error))
        raise
    finally:
        if node is not None:
            if node.poll() is None:
                (workflow/'cancel').touch()
                node.stdin.close()
                node.wait(timeout=10)
        if server is not None and server.poll() is None:
            (run/'service.stop').touch()
            server.wait(timeout=30)
        stop.set()
        thread.join()
        client.close()
        records = [json.loads(line) for line in (run/'resources.jsonl').read_text().splitlines()]
        metrics['process_tree_peak_rss_bytes'] = max((r['rss_bytes'] for r in records), default=0)
        metrics['system_available_min_bytes'] = min((r['available_bytes'] for r in records), default=0)
        atomic(run/'metrics.json', metrics)
        print(json.dumps(metrics, ensure_ascii=False))


if __name__ == '__main__':
    main()
