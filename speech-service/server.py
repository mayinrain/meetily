"""Loopback-only ASR with one isolated recording speaker stream; summaries stay separate."""
import argparse
import asyncio
import gc
from contextlib import asynccontextmanager
import json
from pathlib import Path
import wave

import numpy as np
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
import uvicorn

from core import Config, Engine, Run, Session, SAMPLE_RATE, save_json, sha256, transcribe_file
from protocol import batch_result, stream_result, terminal
from speaker_jobs import SpeakerJobs
from live_speaker_streams import LiveSpeakerStreams


def create_app(config, runs, engine_factory=Engine, speaker_config=None):
    state = {"engine": None}
    busy = asyncio.Lock()

    async def release_asr():
        state["engine"] = None
        gc.collect()
        state["run"].event("model_released", reason="next_pipeline_stage")

    async def ensure_asr_unloaded():
        # Called while holding busy: model loading cannot race this check.
        # Recordings have idle gaps between /v1/segment requests, so an idle
        # request lock alone is not permission to unload their ASR model.
        if state['engine'] is not None:
            raise HTTPException(409, 'Finish transcription and unload ASR before speaker processing')

    speaker_jobs = SpeakerJobs(runs, speaker_config, busy, ensure_asr_unloaded)

    def require_asr():
        if state['engine'] is None:
            raise HTTPException(409, 'Prepare recording ASR before opening the speaker stream')

    live_speakers = LiveSpeakerStreams(runs, speaker_config, busy, require_asr)

    @asynccontextmanager
    async def lifespan(app):
        run = Run(runs, "service", config, cold_start=True)
        state["run"] = run
        try:
            # An idle service reserves no ASR model. Meetily prepares it before
            # recording/import, and saved meetings can go straight to speakers.
            run.event("service_ready", asr_loaded=False)
            try:
                yield
            finally:
                await live_speakers.close()
                await speaker_jobs.close()
            state["engine"] = None
            run.event("model_released")
            run.finish()
        except BaseException as exc:
            run.fail(exc)
            raise

    app = FastAPI(lifespan=lifespan)

    @app.get("/health")
    async def health():
        return dict(status="ready" if state["engine"] else "not_ready", busy=busy.locked(),
                    provider="cpu", model="sensevoice-small-int8", timestamp_granularity="token_start",
                    speakers_available=speaker_jobs.available,
                    speaker_model=getattr(speaker_config, 'backend', 'sortformer' if speaker_config else None),
                    speaker_stream_available=live_speakers.available,
                    speaker_stream_active=live_speakers.active is not None)

    async def limited_body(request, limit):
        body = bytearray()
        async for block in request.stream():
            if len(body)+len(block) > limit:
                raise HTTPException(413, 'Recording speaker request is too large')
            body.extend(block)
        return body

    async def speaker_json(request):
        try:
            value = json.loads(await limited_body(request, 4*1024*1024))
            if not isinstance(value, dict):
                raise ValueError('Expected a recording speaker object')
            return value
        except (ValueError, UnicodeDecodeError) as error:
            raise HTTPException(400, str(error)) from error

    @app.post('/v1/speaker-streams')
    async def open_speaker_stream(request: Request):
        data = await speaker_json(request)
        return await live_speakers.start(data.get('sample_rate'))

    @app.get('/v1/speaker-streams/{job_id}')
    async def get_speaker_stream(job_id: str):
        return live_speakers.status(job_id)

    @app.post('/v1/speaker-streams/{job_id}/audio')
    async def speaker_stream_audio(job_id: str, offset: int, request: Request):
        return await live_speakers.audio(job_id, offset, await limited_body(request, 48000*4))

    @app.post('/v1/speaker-streams/{job_id}/segments')
    async def speaker_stream_segments(job_id: str, request: Request):
        data = await speaker_json(request)
        return await live_speakers.segments(job_id, data.get('segments'))

    @app.post('/v1/speaker-streams/{job_id}/finish')
    async def finish_speaker_stream(job_id: str):
        return await live_speakers.finish(job_id)

    @app.post('/v1/speaker-streams/{job_id}/cancel')
    async def cancel_speaker_stream(job_id: str):
        return await live_speakers.cancel(job_id)

    @app.post("/v1/speakers")
    async def start_speakers(request: Request):
        body = await request.body()
        if len(body) > 4*1024*1024:
            raise HTTPException(413, "Speaker metadata exceeds 4 MiB")
        try:
            data = json.loads(body)
            if not isinstance(data, dict):
                raise ValueError('Expected a meeting request object')
        except (ValueError, UnicodeDecodeError) as error:
            raise HTTPException(400, str(error)) from error
        return await speaker_jobs.start(data)

    @app.get("/v1/speakers/{job_id}")
    async def get_speakers(job_id: str):
        return speaker_jobs.status(job_id)

    @app.post("/v1/speakers/{job_id}/cancel")
    async def cancel_speakers(job_id: str):
        return await speaker_jobs.cancel(job_id)

    @app.post("/v1/models/unload")
    async def unload():
        if busy.locked() or live_speakers.active:
            raise HTTPException(409, "Transcription is active")
        async with busy:
            await release_asr()
        return {"status": "unloaded"}

    @app.post("/v1/models/load")
    async def load():
        if busy.locked():
            raise HTTPException(409, "Transcription is active")
        async with busy:
            if state["engine"] is None:
                state["engine"] = await asyncio.to_thread(engine_factory, config, state["run"])
        return {"status": "ready"}

    @app.post("/v1/listen")
    async def listen_file(request: Request):
        if state["engine"] is None:
            raise HTTPException(503, "ASR model is unloaded; load it before transcribing")
        if busy.locked():
            raise HTTPException(409, "Another recording or transcription is active")
        async with busy:
            run = Run(runs, request.headers.get("x-application", "anarlog"), config, cold_start=False)
            path = run.path / "input.wav"
            try:
                count = 0
                with open(path, "xb") as audio:
                    async for data in request.stream():
                        count += len(data)
                        if count > 512*1024*1024:
                            raise ValueError("Audio upload exceeds 512 MiB")
                        audio.write(data)
                run.event("input_saved", sha256=await asyncio.to_thread(sha256, path), bytes=count)
                segments, metrics = await asyncio.to_thread(transcribe_file, state["engine"], run, path)
                result = batch_result(segments, run, metrics["audio_duration_s"], metrics["channels"])
                save_json(run.path / "response.json", result)
                run.finish(**metrics)
                return result
            except Exception as exc:
                run.fail(exc)
                raise HTTPException(400 if isinstance(exc, (ValueError, wave.Error)) else 500, str(exc))

    @app.post("/v1/segment")
    async def listen_segment(request: Request):
        if state["engine"] is None:
            raise HTTPException(503, "ASR model is unloaded; load it before transcribing")
        # Meetily has already run VAD; do not segment a second time.
        if busy.locked():
            raise HTTPException(409, "Another recording or transcription is active")
        async with busy:
            run = Run(runs, "meetily", config, cold_start=False,
                      parent_run_id=request.headers.get("x-run-id"))
            try:
                body = await request.body()
                if len(body) % 4 or not body or len(body) > SAMPLE_RATE*120*4:
                    raise ValueError("Expected up to 120 s of float32 little-endian mono at 16 kHz")
                samples = np.frombuffer(body, dtype="<f4")
                if not np.isfinite(samples).all():
                    raise ValueError("Non-finite audio")
                result = await asyncio.to_thread(state["engine"].decode, samples, 0.0, run, "0:0")
                save_json(run.path / "segment.raw.json", result)
                run.finish(audio_duration_s=len(samples)/SAMPLE_RATE)
                return dict(**result, run_id=run.id)
            except Exception as exc:
                run.fail(exc)
                raise HTTPException(400 if isinstance(exc, ValueError) else 500, str(exc))

    @app.websocket("/v1/listen")
    async def listen_stream(ws: WebSocket):
        await ws.accept()
        if busy.locked():
            await ws.close(code=1013, reason="Another recording or transcription is active")
            return
        async with busy:
            run = Run(runs, "anarlog", config, cold_start=False, mode="stream")
            audio = None
            try:
                if state["engine"] is None:
                    raise ValueError("ASR model is unloaded; load it before transcribing")
                rate = int(ws.query_params.get("sample_rate", "16000"))
                channels = int(ws.query_params.get("channels", "1"))
                if rate != SAMPLE_RATE or channels not in (1, 2) or ws.query_params.get("encoding", "linear16") != "linear16":
                    raise ValueError("Streaming requires linear16, 16000 Hz, 1 or 2 channels")
                sessions = [Session(state["engine"], run, c) for c in range(channels)]
                audio = wave.open(str(run.path / "recording.wav"), "wb")
                audio.setnchannels(channels)
                audio.setsampwidth(2)
                audio.setframerate(SAMPLE_RATE)
                pending = b""
                while True:
                    message = await ws.receive()
                    if message["type"] == "websocket.disconnect":
                        raise WebSocketDisconnect(message.get("code", 1006))
                    if message.get("bytes") is not None:
                        pending += message["bytes"]
                        end = len(pending)//(2*channels)*(2*channels)
                        data, pending = pending[:end], pending[end:]
                        audio.writeframesraw(data)
                        samples = np.frombuffer(data, dtype="<i2").reshape(-1, channels).astype(np.float32)/32768
                        for c, session in enumerate(sessions):
                            results = await asyncio.to_thread(session.feed, samples[:, c])
                            for result in results:
                                await ws.send_json(stream_result(result, run, channels))
                    else:
                        control = json.loads(message.get("text", "{}"))
                        kind = control.get("type")
                        run.event("control_received", control=kind)
                        if kind == "KeepAlive":
                            continue
                        if kind not in ("Finalize", "CloseStream"):
                            raise ValueError("Unsupported control message")
                        if pending:
                            raise ValueError("Incomplete final PCM frame")
                        for session in sessions:
                            results = await asyncio.to_thread(session.finish)
                            for result in results:
                                await ws.send_json(stream_result(result, run, channels, finalized=True))
                        duration = sessions[0].samples/SAMPLE_RATE
                        save_json(run.path / "segments.raw.json", [s for session in sessions for s in session.segments])
                        audio.close()
                        audio = None
                        await ws.send_json(terminal(run, duration, channels))
                        run.finish(audio_duration_s=duration)
                        await ws.close()
                        break
            except WebSocketDisconnect as exc:
                run.event("client_disconnected", code=exc.code)
                run.finish("aborted", reason="Client disconnected without finalization")
            except Exception as exc:
                run.fail(exc)
                await ws.send_json(dict(type="Error", error_code=None, error_message=str(exc), provider="sensevoice"))
                await ws.close(code=1003)
            finally:
                if audio is not None:
                    audio.close()

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", required=True)
    parser.add_argument("--runs", required=True)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--speaker-library", type=Path, help="Local NeMo-Speech.cpp v0.1.0 C ABI library")
    parser.add_argument("--speaker-model", type=Path, help="Local Sortformer v2 Q8_0 GGUF")
    parser.add_argument("--speaker-gpu", type=int, choices=[-1, 0], default=-1,
                        help="-1: CPU; 0: first GPU in the configured native library")
    parser.add_argument('--community-model', type=Path, help='Local Community-1 pipeline directory')
    parser.add_argument('--community-python', type=Path, help='Dedicated Community-1 Python executable')
    parser.add_argument("--stop-file", type=Path, help="Create this file to request a graceful test-server shutdown")
    args = parser.parse_args()
    if args.stop_file and args.stop_file.exists():
        parser.error("Stop file already exists; choose a new run-specific path")
    if bool(args.speaker_library) != bool(args.speaker_model):
        parser.error("Configure both speaker library and model")
    if bool(args.community_model) != bool(args.community_python):
        parser.error('Configure both Community-1 model and dedicated Python')
    if args.community_model and args.speaker_model:
        parser.error('Configure exactly one speaker backend')
    speaker_config = None
    if args.community_model:
        from community_config import CommunityConfig
        speaker_config = CommunityConfig(str(args.community_python.resolve()), str(args.community_model.resolve()))
        if not speaker_config.available:
            parser.error('Community-1 runtime or model files are missing')
    elif args.speaker_library:
        from process_speakers import SpeakerConfig
        speaker_config = SpeakerConfig(str(args.speaker_library.resolve()), str(args.speaker_model.resolve()), gpu=args.speaker_gpu)
    instance = uvicorn.Server(uvicorn.Config(
        create_app(Config(models=args.models, threads=args.threads), args.runs, speaker_config=speaker_config),
        host="127.0.0.1", port=args.port, ws_max_queue=16, ws_max_size=1024*1024))

    async def serve():
        task = asyncio.create_task(instance.serve())
        while not task.done():
            if args.stop_file and args.stop_file.exists():
                instance.should_exit = True
            await asyncio.sleep(0.5)
        await task

    asyncio.run(serve())
