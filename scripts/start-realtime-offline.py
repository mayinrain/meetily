"""Start the integrated Windows build against locally installed offline runtimes."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import uuid

import psutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path.home()/'meeting-offline')
    parser.add_argument('--app', type=Path, required=True, help='EXE built from this integration branch')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    python = root/'speech-service/.venv/Scripts/python.exe'
    community = root/'tools/community1-bench-01/.venv/Scripts/python.exe'
    node = root/'tools/node-v22.23.1-win-x64/node.exe'
    llama = root/'tools/llama-b10809/llama-server.exe'
    model = root/'shared/models/Qwen3.5-4B-Q4_K_M.gguf'
    speakers = root/'shared/models/pyannote-community-1'
    service = Path(__file__).resolve().parent.parent/'speech-service/server.py'
    ffmpeg = root/'tools/ffmpeg.exe'
    for file in [args.app, python, community, node, llama, model, speakers/'config.yaml', service, ffmpeg]:
        if not file.is_file():
            raise FileNotFoundError(file)
    if args.check:
        print(json.dumps(dict(files_ready=True, app=str(args.app), service=str(service))))
        return
    if os.name != 'nt':
        parser.error('This launcher targets the prepared Windows installation')
    if any((p.info['name'] or '').lower() == 'meetily.exe' for p in psutil.process_iter(['name'])):
        raise RuntimeError('Exit the running Meetily instance before starting this build')
    run = root/'runs'/('realtime-'+uuid.uuid4().hex)
    run.mkdir(parents=True)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def health():
        try:
            with opener.open('http://127.0.0.1:8765/health', timeout=2) as response:
                value = json.load(response)
        except OSError:
            return None
        if not (value.get('speaker_batch_publication') and value.get('speaker_stream_available')
                and value.get('model') == 'sensevoice-small-int8'):
            raise RuntimeError('Port 8765 has an incompatible service; stop its launcher first')
        return value

    def spawn(name, command, env):
        with (run/(name+'.stdout.log')).open('wb') as out, (run/(name+'.stderr.log')).open('wb') as err:
            return subprocess.Popen(command, env=env, stdout=out, stderr=err,
                                    creationflags=subprocess.CREATE_NO_WINDOW)

    owned = None
    stop = run/'service.stop'
    env = dict(os.environ, MEETING_FFMPEG=str(ffmpeg), MEETILY_WORKFLOW_NODE=str(node),
               MEETILY_WORKFLOW_SERVER=str(llama), MEETILY_WORKFLOW_MODEL=str(model))
    try:
        if health() is None:
            owned = spawn('speech', [python, '-u', service, '--models', root/'shared/models',
                '--runs', root/'runs', '--threads', '2', '--community-python', community,
                '--community-model', speakers, '--stop-file', stop], env)
            deadline = time.monotonic()+30
            while health() is None:
                if owned.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Speech service did not start; see '+str(run))
                time.sleep(.25)
        app = spawn('app', [args.app, '--log-file', run/'app.log'], env)
        code = app.wait()
        (run/'exit.json').write_text(json.dumps(dict(app_exit=code)), encoding='utf-8')
        if code:
            raise RuntimeError('Meetily exited with code '+str(code))
    finally:
        if owned is not None and owned.poll() is None:
            stop.touch()
            owned.wait(timeout=30)


if __name__ == '__main__':
    main()
