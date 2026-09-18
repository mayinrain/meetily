import io
import json
import os
import subprocess
from pathlib import Path
import wave
from scipy.io import wavfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

from core import Config, Engine, Run, Session, ffmpeg_path, read_wav, write_wav
from protocol import words
from server import create_app

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "shared/models"
SAMPLE = Path(os.environ.get("MEETING_TEST_AUDIO", ROOT / "shared/audio/meeting-speech-16k.wav"))


@pytest.fixture
def config():
    if not (MODELS / "silero_vad.onnx").exists():
        pytest.skip("Local model files required for real inference tests")
    return Config(str(MODELS))


@pytest.fixture
def client(config, tmp_path):
    with TestClient(create_app(config, tmp_path / "runs")) as client:
        assert client.post('/v1/models/load').status_code == 200
        yield client


def test_idle_start_does_not_allocate_asr(tmp_path):
    calls = []
    with TestClient(create_app(Config(str(tmp_path)), tmp_path/'runs',
                              engine_factory=lambda *_: calls.append('loaded') or object())) as client:
        assert client.get('/health').json()['status'] == 'not_ready'
        assert calls == []
        assert client.post('/v1/models/load').status_code == 200
        assert calls == ['loaded']
        assert client.post('/v1/models/load').status_code == 200
        assert calls == ['loaded']


def pcm_bytes(seconds=8):
    samples = read_wav(SAMPLE, duration=seconds)
    return (samples*32768).astype("<i2").tobytes()


def wav_bytes(pcm, channels=1):
    out = io.BytesIO()
    with wave.open(out, "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(pcm)
    return out.getvalue()


def test_token_points_preserved_without_fabricated_end_times():
    result = words(dict(tokens=["中", "文"], timestamps=[1.1, 1.46], durations=[]))
    assert [(w["start"], w["end"]) for w in result] == [(1.1, 1.1), (1.46, 1.46)]
    assert all(w["speaker"] is None for w in result)


def test_timestamp_mismatch_is_an_error():
    with pytest.raises(ValueError):
        words(dict(tokens=["中"], timestamps=[]))


def test_tail_flush_and_arbitrary_chunks_match(config, tmp_path):
    run = Run(tmp_path, "test", config)
    try:
        engine = Engine(config, run)
        samples = read_wav(SAMPLE, duration=8.17)[:, 0]
        whole = Session(engine, run)
        whole.feed(samples)
        whole.finish()
        split = Session(engine, run)
        for pos in range(0, len(samples), 317):
            split.feed(samples[pos:pos+317])
        tail = split.finish()
        assert tail, "An actively spoken final segment must be flushed"
        assert split.finish() == []
        assert split.samples == len(samples)
        assert [(s["start"], s["end"], s["text"]) for s in split.segments] == [
            (s["start"], s["end"], s["text"]) for s in whole.segments]
        assert all(s["end"] <= len(samples)/16000 for s in split.segments)
        with pytest.raises(ValueError):
            split.feed(samples[:1])
    finally:
        run.finish()


def test_stream_matches_file_and_acks_finalize(client):
    pcm = pcm_bytes(8.17)
    expected = client.post("/v1/listen", content=wav_bytes(pcm))
    assert expected.status_code == 200, expected.text
    with client.websocket_connect("/v1/listen?sample_rate=16000&encoding=linear16&channels=1") as ws:
        # Deliberately split sample bytes across messages, including the last one.
        for pos in range(0, len(pcm), 997):
            ws.send_bytes(pcm[pos:pos+997])
        ws.send_json({"type": "KeepAlive"})
        ws.send_json({"type": "Finalize"})
        events = []
        while True:
            event = ws.receive_json()
            events.append(event)
            if event["type"] == "Metadata":
                break
        results = [e for e in events if e["type"] == "Results"]
        assert any(r["from_finalize"] for r in results)
        assert "".join(r["channel"]["alternatives"][0]["transcript"] for r in results) == expected.json()["results"]["channels"][0]["alternatives"][0]["transcript"]
        assert events[-1]["duration"] == 8.17


def test_silent_stream_is_finalized(client):
    with client.websocket_connect("/v1/listen") as ws:
        ws.send_bytes(bytes(16000*2))
        ws.send_json({"type": "CloseStream"})
        result = ws.receive_json()
        assert result["type"] == "Metadata"
        assert result["duration"] == 1


def test_rejects_unsupported_rate_and_incomplete_frame(client):
    with client.websocket_connect("/v1/listen?sample_rate=48000") as ws:
        assert ws.receive_json()["type"] == "Error"
    with client.websocket_connect("/v1/listen") as ws:
        ws.send_bytes(b"\x00")
        ws.send_json({"type": "Finalize"})
        assert "Incomplete" in ws.receive_json()["error_message"]


def test_meetily_segment_has_real_result_and_rejects_invalid_audio(client):
    samples = read_wav(SAMPLE, offset=2, duration=4)[:, 0]
    result = client.post("/v1/segment", content=samples.astype("<f4").tobytes())
    assert result.status_code == 200
    assert result.json()["text"]
    assert result.json()["durations"] == []
    assert client.post("/v1/segment", content=b"bad").status_code == 400
    assert client.post("/v1/segment", content=np.array([np.nan], dtype="<f4").tobytes()).status_code == 400


def test_bad_wav_preserves_failure_record(client, tmp_path):
    result = client.post("/v1/listen", content=b"not a wav")
    assert result.status_code == 400
    statuses = [json.loads(p.read_text()) for p in (tmp_path/"runs/anarlog").glob("*/status.json")]
    assert statuses[-1]["status"] == "failed"


def test_second_job_rejected_while_recording(client):
    with client.websocket_connect("/v1/listen") as ws:
        ws.send_bytes(bytes(32000))
        assert client.get("/health").json()["busy"]
        assert client.post("/v1/listen", content=b"x").status_code == 409
        ws.send_json({"type": "Finalize"})
        assert ws.receive_json()["type"] == "Metadata"


def test_models_release_between_stages(client):
    assert client.post("/v1/models/unload").json()["status"] == "unloaded"
    assert client.get("/health").json()["status"] == "not_ready"
    assert client.post("/v1/listen", content=b"audio").status_code == 503
    assert client.post("/v1/models/load").json()["status"] == "ready"
    assert client.get("/health").json()["status"] == "ready"


def test_anarlog_float_wav_matches_pcm16(client):
    pcm = pcm_bytes(8.17)
    expected = client.post("/v1/listen", content=wav_bytes(pcm))
    out = io.BytesIO()
    wavfile.write(out, 16000, np.frombuffer(pcm, dtype='<i2').astype(np.float32)/32768)
    result = client.post("/v1/listen", content=out.getvalue())
    assert result.status_code == 200, result.text
    assert result.json()['results'] == expected.json()['results']


def test_anarlog_compressed_import_transcribes(client, tmp_path):
    source = tmp_path/'source.wav'
    source.write_bytes(wav_bytes(pcm_bytes(8.17)))
    encoded = tmp_path/'audio.mp3'
    subprocess.run([ffmpeg_path(), '-nostdin', '-loglevel', 'error', '-i', str(source), str(encoded)], check=True)
    result = client.post('/v1/listen', content=encoded.read_bytes())
    assert result.status_code == 200, result.text
    alternative = result.json()['results']['channels'][0]['alternatives'][0]
    assert '北京' in alternative['transcript']
    assert alternative['words']
