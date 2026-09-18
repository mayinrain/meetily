"""Exercise real child-process completion, cancellation and ASR exclusion."""
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from core import Config
from server import create_app
from speaker_jobs import SpeakerJobs


@pytest.fixture
def setup(tmp_path, monkeypatch):
    worker = tmp_path/'worker.py'
    worker.write_text('''import json,sys,time
from pathlib import Path
root,mode=Path(sys.argv[1]),sys.argv[2]
if mode == "wait":
    time.sleep(30)
elif mode == "fail":
    sys.exit(7)
else:
    out=root/"meeting-speakers"/"test-run"
    out.mkdir(parents=True)
    (out/"result.json").write_text(json.dumps({"turns":[],"segments":[],"identity_status":"anonymous"}))
''')
    mode = {'value': 'wait'}
    monkeypatch.setattr(SpeakerJobs, 'command', lambda self, directory, request:
                        [sys.executable, str(worker), str(directory), mode['value']])
    model = tmp_path/'model'
    model.touch()
    config = SimpleNamespace(library=str(model), model=str(model), target_span_s=30)
    request = dict(audio_path=str(model), meeting_id='meeting-test', segments=[
        dict(id='seg1', audio_start_time=0, audio_end_time=3)])
    app = create_app(Config(str(tmp_path)), tmp_path/'runs', engine_factory=lambda *_: object(), speaker_config=config)
    with TestClient(app) as client:
        assert client.post('/v1/models/load').status_code == 200
        yield client, request, mode, tmp_path


def wait_status(client, job_id, expected):
    deadline = time.monotonic()+5
    while time.monotonic() < deadline:
        response = client.get('/v1/speakers/'+job_id)
        assert response.status_code == 200, response.text
        if response.json()['status'] == expected:
            return response.json()
        time.sleep(0.02)
    pytest.fail(response.text)


def start(client, request):
    assert client.post('/v1/models/unload').status_code == 200
    response = client.post('/v1/speakers', json=request)
    assert response.status_code == 200, response.text
    return response.json()['job_id']


def test_loaded_asr_is_protected_even_between_segment_requests(setup):
    client, request, _, _ = setup
    assert not client.get('/health').json()['busy']
    assert client.post('/v1/speakers', json=request).status_code == 409
    assert client.get('/health').json()['status'] == 'ready'
    assert not client.get('/health').json()['busy']


def test_cancel_worker_releases_lock_and_keeps_asr_unloaded(setup):
    client, request, _, _ = setup
    job_id = start(client, request)
    assert client.get('/health').json()['busy']
    assert client.post('/v1/models/load').status_code == 409
    assert client.post('/v1/speakers', json=request).status_code == 409
    assert client.post(f'/v1/speakers/{job_id}/cancel').status_code == 200
    wait_status(client, job_id, 'cancelled')
    health = client.get('/health').json()
    assert health['status'] == 'not_ready' and not health['busy']
    assert client.post('/v1/models/load').status_code == 200


@pytest.mark.parametrize('mode_value,expected', [('success', 'completed'), ('fail', 'failed')])
def test_worker_completion_or_failure_is_persisted(setup, mode_value, expected):
    client, request, mode, root = setup
    mode['value'] = mode_value
    job_id = start(client, request)
    status = wait_status(client, job_id, expected)
    assert not client.get('/health').json()['busy']
    saved = json.loads((root/'runs/speaker-jobs'/job_id/'state.json').read_text())
    assert saved['status'] == expected
    if expected == 'completed':
        assert status['result']['identity_status'] == 'anonymous'
    else:
        assert '7' in status['error']


def test_invalid_request_does_not_take_lock_or_create_job(setup):
    client, request, _, root = setup
    assert client.post('/v1/models/unload').status_code == 200
    request['segments'][0]['audio_end_time'] = -1
    assert client.post('/v1/speakers', json=request).status_code == 400
    assert not client.get('/health').json()['busy']
    assert not (root/'runs/speaker-jobs').exists()
    assert client.get('/v1/speakers/not-a-job').status_code == 404
