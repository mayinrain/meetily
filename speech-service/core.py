"""Shared offline SenseVoice inference. Audio positions are always seconds, not wall time."""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import platform
import re
import shutil
import sys
import subprocess
import threading
import time
import traceback
import uuid
import wave
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import psutil
import sherpa_onnx
from scipy.signal import resample_poly
from scipy.io import wavfile

SAMPLE_RATE = 16000
MODEL_NAME = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"


def sha256(path):
    with open(path, "rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def save_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def source_version():
    digest = hashlib.sha256()
    for path in sorted(Path(__file__).parent.glob("*.py")):
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


@dataclass
class Config:
    models: str
    threads: int = 2
    language: str = "auto"
    max_speech: float = 10.0
    min_silence: float = 0.35
    min_speech: float = 0.1
    threshold: float = 0.5

    def __post_init__(self):
        if self.threads < 1 or self.max_speech <= 0 or self.min_silence <= 0:
            raise ValueError("Invalid inference/VAD configuration")


class Run:
    """Append-only per-run events, sampled resources, config, and final status."""
    def __init__(self, root, app, config, **metadata):
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", app):
            raise ValueError("Invalid application name")
        self.id = time.strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:12]
        self.path = Path(root) / app / self.id
        self.path.mkdir(parents=True, exist_ok=False)
        source = self.path / "source"
        source.mkdir()
        for file in Path(__file__).parent.iterdir():
            if file.suffix == ".py" or file.name.startswith("requirements"):
                shutil.copy2(file, source / file.name)
        self.started = time.perf_counter()
        self.config = dict(run_id=self.id, app=app, config=asdict(config),
                           service_version=source_version(), command=sys.argv,
                           platform=platform.platform(), python=sys.version,
                           packages={p: importlib.metadata.version(p) for p in
                                     ("sherpa-onnx", "numpy", "scipy", "psutil")},
                           execution_provider="cpu", device=platform.processor(),
                           quantization="int8")
        self.config.update(metadata)
        save_json(self.path / "config.json", self.config)
        self.events = open(self.path / "events.jsonl", "x", encoding="utf-8", buffering=1)
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.process = psutil.Process()
        self.peaks = {"rss_bytes": 0, "private_bytes": 0, "system_available_min_bytes": psutil.virtual_memory().available}
        self.status = "running"
        self.event("run_started")
        save_json(self.path / "status.json", {"status": self.status})
        self.sampler = threading.Thread(target=self._sample, daemon=True)
        self.sampler.start()

    def event(self, kind, **data):
        row = dict(run_id=self.id, elapsed_s=time.perf_counter() - self.started,
                   unix_time=time.time(), event=kind, **data)
        with self.lock:
            self.events.write(json.dumps(row, ensure_ascii=False) + "\n")

    def _sample(self):
        with open(self.path / "resources.jsonl", "x", encoding="utf-8", buffering=1) as out:
            while True:
                mem = self.process.memory_info()
                row = dict(elapsed_s=time.perf_counter() - self.started,
                           cpu_percent=self.process.cpu_percent(), rss_bytes=mem.rss,
                           private_bytes=getattr(mem, "private", None),
                           vms_bytes=mem.vms, system_available_bytes=psutil.virtual_memory().available)
                self.peaks["rss_bytes"] = max(self.peaks["rss_bytes"], mem.rss)
                self.peaks["private_bytes"] = max(self.peaks["private_bytes"], getattr(mem, "private", 0))
                self.peaks["system_available_min_bytes"] = min(self.peaks["system_available_min_bytes"], row["system_available_bytes"])
                out.write(json.dumps(row) + "\n")
                if self.stopped.wait(0.2):
                    break

    def finish(self, status="completed", **metrics):
        if self.status != "running":
            return
        self.status = status
        self.stopped.set()
        self.sampler.join()
        self.event("run_finished", status=status, **metrics)
        save_json(self.path / "status.json", dict(status=status, elapsed_s=time.perf_counter()-self.started,
                                                  peaks=self.peaks, **metrics))
        self.events.close()

    def fail(self, exc):
        self.event("error", error=str(exc), traceback=traceback.format_exc())
        self.finish("aborted" if isinstance(exc, KeyboardInterrupt) else "failed", error=str(exc))


class Engine:
    def __init__(self, config: Config, run: Run):
        self.config = config
        self.lock = threading.Lock()
        model_dir = Path(config.models) / MODEL_NAME
        model = model_dir / "model.int8.onnx"
        tokens = model_dir / "tokens.txt"
        vad = Path(config.models) / "silero_vad.onnx"
        run.event("model_files", files=[dict(path=str(p.resolve()), sha256=sha256(p)) for p in (model, tokens, vad)])
        started = time.perf_counter()
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model), tokens=str(tokens), num_threads=config.threads,
            provider="cpu", language=config.language, use_itn=True)
        self.load_s = time.perf_counter() - started
        run.event("model_loaded", duration_s=self.load_s, provider="cpu", threads=config.threads)

    def new_vad(self):
        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = str(Path(self.config.models) / "silero_vad.onnx")
        config.silero_vad.min_silence_duration = self.config.min_silence
        config.silero_vad.min_speech_duration = self.config.min_speech
        config.silero_vad.max_speech_duration = self.config.max_speech
        config.silero_vad.threshold = self.config.threshold
        config.sample_rate = SAMPLE_RATE
        config.num_threads = 1
        config.provider = "cpu"
        return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=30)

    def decode(self, samples, start, run, segment_id, channel=0):
        queued = time.perf_counter()
        with self.lock:
            started = time.perf_counter()
            stream = self.recognizer.create_stream()
            stream.accept_waveform(SAMPLE_RATE, samples)
            self.recognizer.decode_stream(stream)
            output = stream.result
            result = {key: getattr(output, key) for key in
                      ("text", "tokens", "timestamps", "durations", "lang", "emotion", "event")}
        elapsed = time.perf_counter() - started
        segment = dict(id=segment_id, channel=channel, start=start,
                       end=start+len(samples)/SAMPLE_RATE, text=result["text"].strip(),
                       tokens=result.get("tokens", []),
                       timestamps=[start+t for t in result.get("timestamps", [])],
                       durations=result.get("durations", []),
                       timestamp_granularity="token_start", speaker=None,
                       inference_s=elapsed, queue_s=started-queued, raw=result)
        run.event("asr_final", **segment)
        return segment


class Session:
    """Incremental 16 kHz channel with bounded VAD storage and idempotent tail flush."""
    def __init__(self, engine, run, channel=0):
        self.engine, self.run, self.channel = engine, run, channel
        self.vad = engine.new_vad()
        self.pending = np.empty(0, dtype=np.float32)
        self.samples = 0
        self.closed = False
        self.segments = []

    def _drain(self):
        results = []
        while not self.vad.empty():
            front = self.vad.front
            start = front.start
            samples = np.asarray(front.samples, dtype=np.float32).copy()
            self.vad.pop()
            samples = samples[:max(0, self.samples-start)]
            if len(samples):
                result = self.engine.decode(samples, start/SAMPLE_RATE, self.run,
                                            f"{self.channel}:{len(self.segments)}", self.channel)
                self.segments.append(result)
                results.append(result)
        return results

    def feed(self, samples):
        if self.closed:
            raise ValueError("Session already finalized")
        samples = np.asarray(samples, dtype=np.float32)
        if samples.ndim != 1 or not np.isfinite(samples).all():
            raise ValueError("Expected finite mono audio")
        self.samples += len(samples)
        data = np.concatenate((self.pending, samples))
        end = len(data)//512*512
        results = []
        for pos in range(0, end, 512):
            self.vad.accept_waveform(data[pos:pos+512])
            results.extend(self._drain())
        self.pending = data[end:].copy()
        return results

    def finish(self):
        if self.closed:
            return []
        self.closed = True
        if len(self.pending):
            self.vad.accept_waveform(np.pad(self.pending, (0, 512-len(self.pending))))
            self.pending = np.empty(0, dtype=np.float32)
        self.vad.flush()
        results = self._drain()
        self.run.event("audio_finalized", channel=self.channel, samples=self.samples,
                       audio_duration_s=self.samples/SAMPLE_RATE, segments=len(self.segments))
        return results


def read_wav(path, offset=0.0, duration=None):
    if offset < 0 or (duration is not None and duration <= 0):
        raise ValueError("Expected a non-negative offset and positive duration")
    try:
        with wave.open(str(path), "rb") as audio:
            rate, channels = audio.getframerate(), audio.getnchannels()
            if audio.getsampwidth() != 2 or audio.getcomptype() != "NONE":
                raise ValueError("Expected PCM16 or float32 WAV")
            audio.setpos(round(offset*rate))
            count = audio.getnframes()-audio.tell() if duration is None else round(duration*rate)
            samples = np.frombuffer(audio.readframes(count), dtype="<i2").astype(np.float32)/32768
            samples = samples.reshape(-1, channels)
    except wave.Error:
        # Anarlog's recording pipeline also writes IEEE float32 WAV (format 3).
        rate, data = wavfile.read(str(path), mmap=True)
        if data.dtype != np.float32:
            raise ValueError("Expected PCM16 or float32 WAV")
        start = round(offset*rate)
        stop = None if duration is None else start+round(duration*rate)
        samples = np.asarray(data[start:stop]).copy()
        if samples.ndim == 1:
            samples = samples[:, None]
    if len(samples) == 0 or not np.isfinite(samples).all():
        raise ValueError("Expected nonempty, finite audio")
    if rate != SAMPLE_RATE:
        from math import gcd
        common = gcd(rate, SAMPLE_RATE)
        samples = resample_poly(samples, SAMPLE_RATE//common, rate//common, axis=0).astype(np.float32)
    return samples


def write_wav(path, samples):
    samples = np.asarray(samples)
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1 if samples.ndim == 1 else samples.shape[1])
        audio.setsampwidth(2)
        audio.setframerate(SAMPLE_RATE)
        audio.writeframes((np.clip(samples, -1, 32767/32768)*32768).astype("<i2").tobytes())


def ffmpeg_path():
    bundled = Path(__file__).resolve().parent.parent / 'tools/ffmpeg.exe'
    executable = os.environ.get('MEETING_FFMPEG') or (str(bundled) if bundled.exists() else shutil.which('ffmpeg'))
    if not executable:
        raise ValueError('FFmpeg is required for compressed recordings')
    return executable


def read_audio(path, run, offset=0.0, duration=None):
    with open(path, 'rb') as audio:
        header = audio.read(12)
    if header[:4] == b'RIFF' and header[8:12] == b'WAVE':
        return read_wav(path, offset, duration)
    # Anarlog normalizes imported audio to MP3 before sending it to its provider.
    executable = ffmpeg_path()
    decoded = run.path / 'decoded-16k.wav'
    command = [executable, '-nostdin', '-hide_banner', '-n', '-protocol_whitelist', 'file,pipe',
               '-i', str(path), '-vn', '-c:a', 'pcm_s16le', '-ar', str(SAMPLE_RATE), str(decoded)]
    run.event('decode_started', command=command, executable_sha256=sha256(executable))
    started = time.perf_counter()
    with open(run.path / 'decode.log', 'xb') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        raise ValueError('Audio decoding failed; details retained in decode.log')
    run.event('decode_completed', duration_s=time.perf_counter()-started, sha256=sha256(decoded))
    return read_wav(decoded, offset, duration)


def transcribe_file(engine, run, path, offset=0.0, duration=None):
    started = time.perf_counter()
    samples = read_audio(path, run, offset, duration)
    run.event("preprocess_completed", duration_s=time.perf_counter()-started,
              audio_duration_s=len(samples)/SAMPLE_RATE, offset_s=offset, channels=samples.shape[1])
    sessions = [Session(engine, run, c) for c in range(samples.shape[1])]
    for pos in range(0, len(samples), SAMPLE_RATE):
        for c, session in enumerate(sessions):
            session.feed(samples[pos:pos+SAMPLE_RATE, c])
    for session in sessions:
        session.finish()
    segments = sorted([s for session in sessions for s in session.segments], key=lambda s:(s["start"], s["channel"]))
    save_json(run.path / "segments.raw.json", segments)
    (run.path / "transcript.txt").write_text("\n".join(f'[{s["start"]:.3f}, {s["end"]:.3f}] {s["text"]}' for s in segments), encoding="utf-8")
    elapsed = time.perf_counter()-started
    return segments, dict(audio_duration_s=len(samples)/SAMPLE_RATE, processing_s=elapsed,
                          channels=samples.shape[1],
                          rtf=elapsed/(len(samples)/SAMPLE_RATE) if len(samples) else 0,
                          inference_s=sum(s["inference_s"] for s in segments), segments=len(segments))
