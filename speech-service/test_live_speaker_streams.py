"""Real child-process protocol tests; native inference is verified separately on Windows."""
import hashlib
import json
import struct
import sys
import time
from types import SimpleNamespace

from fastapi.testclient import TestClient
import numpy as np
import pytest

from core import Config
from live_speaker_streams import LiveSpeakerStreams
from server import create_app


@pytest.fixture
def setup(tmp_path, monkeypatch):
    worker = tmp_path/'worker.py'
    worker.write_text('''import hashlib,json,struct,sys
from pathlib import Path
root,mode=Path(sys.argv[1]),sys.argv[2]
if mode == 'fail': sys.exit(7)
frames=0
h=hashlib.sha256()
while True:
 header=sys.stdin.buffer.read(4)
 if len(header)!=4: sys.exit(8)
 count,=struct.unpack('<I',header)
 if not count: break
 data=sys.stdin.buffer.read(count)
 if len(data)!=count: sys.exit(9)
 frames+=count//4
 h.update(data)
rows=json.loads((root/'transcripts.json').read_text())['segments']
out=root/'meeting-speakers'/'fake-run'
out.mkdir(parents=True)
(out/'result.json').write_text(json.dumps(dict(turns=[],segments=rows,frames=frames,sha256=h.hexdigest())))
''')
    mode = {'value': 'normal'}
    monkeypatch.setattr(LiveSpeakerStreams, 'command', lambda self, directory, sample_rate:
                        [sys.executable, str(worker), str(directory), mode['value']])
    model = tmp_path/'model'
    model.touch()
    config = SimpleNamespace(library=str(model), model=str(model), target_span_s=30)

    class Engine:
        def __init__(self, *_):
            pass
        def decode(self, samples, *_):
            return dict(text='real ASR request reached decoder', frames=len(samples))

    app = create_app(Config(str(tmp_path)), tmp_path/'runs', engine_factory=Engine, speaker_config=config)
    with TestClient(app) as client:
        yield client, mode, tmp_path


def wait_status(client, job_id, expected):
    deadline = time.monotonic()+5
    while time.monotonic() < deadline:
        response = client.get('/v1/speaker-streams/'+job_id)
        if response.json()['status'] == expected:
            return response.json()
        time.sleep(.02)
    pytest.fail(response.text)


def begin(client):
    assert client.post('/v1/models/load').status_code == 200
    response = client.post('/v1/speaker-streams', json=dict(sample_rate=48000))
    assert response.status_code == 200, response.text
    return response.json()['job_id']


def test_stream_and_asr_run_together_then_final_result_persists(setup):
    client, _, root = setup
    assert client.post('/v1/speaker-streams', json=dict(sample_rate=48000)).status_code == 409
    job = begin(client)
    base = '/v1/speaker-streams/'+job
    pcm = np.zeros(48000, dtype='<f4').tobytes()
    assert client.post(base+'/audio?offset=0', content=pcm).json()['received_frames'] == 48000
    assert client.post('/v1/segment', content=pcm[:16000*4]).status_code == 200
    assert client.post('/v1/models/unload').status_code == 409
    assert client.post('/v1/speaker-streams', json=dict(sample_rate=48000)).status_code == 409
    rows = [dict(id='a', audio_start_time=0, audio_end_time=1, text='original')]
    assert client.post(base+'/segments', json=dict(segments=rows)).status_code == 200
    assert client.post(base+'/finish').status_code == 200
    completed = wait_status(client, job, 'completed')
    assert client.post(base+'/finish').json()['status'] == 'completed'
    assert completed['result']['frames'] == 48000
    assert completed['result']['sha256'] == hashlib.sha256(pcm).hexdigest()
    assert completed['result']['segments'] == rows
    assert json.loads((root/'runs/live-speaker-jobs'/job/'state.json').read_text())['status'] == 'completed'
    assert client.get('/health').json()['status'] == 'ready'
    assert not client.get('/health').json()['speaker_stream_active']
    assert client.post('/v1/models/unload').status_code == 200


def test_bad_audio_and_changed_metadata_leave_valid_stream_usable(setup):
    client, _, _ = setup
    job = begin(client)
    base = '/v1/speaker-streams/'+job
    assert client.post(base+'/audio?offset=1', content=bytes(4)).status_code == 409
    assert client.post(base+'/audio?offset=0', content=b'bad').status_code == 400
    assert client.post(base+'/audio?offset=0', content=struct.pack('<f', float('nan'))).status_code == 400
    assert client.post(base+'/audio?offset=0', content=bytes(48000*4+4)).status_code == 413
    rows = [dict(id='a', audio_start_time=0, audio_end_time=1)]
    assert client.post(base+'/segments', json=dict(segments=rows)).status_code == 200
    assert client.post(base+'/segments', json=dict(segments=[])).status_code == 400
    assert client.post(base+'/audio?offset=0', content=bytes(4)).status_code == 200
    assert client.post(base+'/cancel').json()['status'] == 'cancelled'
    assert client.post('/v1/segment', content=bytes(4)).status_code == 200
    assert client.post(base+'/audio?offset=1', content=bytes(4)).status_code == 409


def test_native_process_failure_does_not_unload_or_block_asr(setup):
    client, mode, _ = setup
    mode['value'] = 'fail'
    job = begin(client)
    failed = wait_status(client, job, 'failed')
    assert '7' in failed['error']
    assert client.post('/v1/segment', content=bytes(4)).status_code == 200
    assert not client.get('/health').json()['speaker_stream_active']
    mode['value'] = 'normal'
    next_job = begin(client)
    assert next_job != job
    assert client.post('/v1/speaker-streams/'+next_job+'/cancel').json()['status'] == 'cancelled'


def test_service_shutdown_terminates_live_worker(tmp_path, monkeypatch):
    monkeypatch.setattr(LiveSpeakerStreams, 'command', lambda *_:
                        [sys.executable, '-c', 'import time; time.sleep(60)'])
    model = tmp_path/'model'
    model.touch()
    config = SimpleNamespace(library=str(model), model=str(model), target_span_s=30)
    app = create_app(Config(str(tmp_path)), tmp_path/'runs', engine_factory=lambda *_: object(), speaker_config=config)
    with TestClient(app) as client:
        job = begin(client)
    assert json.loads((tmp_path/'runs/live-speaker-jobs'/job/'state.json').read_text())['status'] == 'interrupted'
