"""One isolated, bounded speaker stream alongside the recording's ASR model."""
import asyncio
import json
from pathlib import Path
import re
import struct
import sys
import uuid

from fastapi import HTTPException
import numpy as np

from speaker_batches import plan_batches
from speaker_jobs import write_json


class LiveSpeakerStreams:
    def __init__(self, runs, config, busy, require_asr):
        self.root = Path(runs).resolve()/'live-speaker-jobs'
        self.config, self.busy, self.require_asr = config, busy, require_asr
        self.active = None
        self.process = self.task = None
        self.input_lock = asyncio.Lock()
        self.frames = 0
        self.accepting = False

    @property
    def available(self):
        if getattr(self.config, 'backend', None) == 'pyannote-community-1':
            return self.config.available
        return self.config is not None and all(Path(p).is_file() for p in
                                               [self.config.library, self.config.model])

    def directory(self, job_id):
        if not re.fullmatch(r'[0-9a-f]{32}', job_id):
            raise HTTPException(404, 'Recording speaker stream not found')
        directory = self.root/job_id
        if not (directory/'state.json').is_file():
            raise HTTPException(404, 'Recording speaker stream not found')
        return directory

    def status(self, job_id):
        directory = self.directory(job_id)
        state = json.loads((directory/'state.json').read_text(encoding='utf-8'))
        if state['status'] == 'running' and self.active != job_id:
            state.update(status='interrupted', error='Service restarted before finalization')
            write_json(directory/'state.json', state)
        if state['status'] == 'completed':
            state['result'] = json.loads((directory/'result.json').read_text(encoding='utf-8'))
        elif (directory/'progress.json').is_file():
            progress = json.loads((directory/'progress.json').read_text(encoding='utf-8'))
            state['result'] = progress.pop('result', None)
            if state['result'] is None and (directory/'published.json').is_file():
                state['result'] = json.loads((directory/'published.json').read_text(encoding='utf-8'))
            state['progress'] = progress
        return state

    def command(self, directory, sample_rate):
        if getattr(self.config, 'backend', None) == 'pyannote-community-1':
            return [self.config.python, str(Path(__file__).with_name('process_community_speakers.py')),
                    str(directory), '--model', self.config.model, '--threads', str(self.config.threads),
                    '--sample-rate', str(sample_rate)]
        return [sys.executable, str(Path(__file__).with_name('process_live_speakers.py')), str(directory),
                '--library', self.config.library, '--model', self.config.model,
                '--gpu', str(getattr(self.config, 'gpu', -1)), '--sample-rate', str(sample_rate),
                '--target', str(self.config.target_span_s)]

    async def start(self, sample_rate):
        if not self.available:
            raise HTTPException(503, 'Recording speaker model/runtime is not configured')
        if type(sample_rate) is not int or sample_rate not in (16000, 48000):
            raise HTTPException(400, 'Expected mono float32 at 16000 or 48000 Hz')
        if self.busy.locked() or self.active:
            raise HTTPException(409, 'Another audio task is active')
        async with self.busy, self.input_lock:
            self.require_asr()
            job_id = uuid.uuid4().hex
            directory = self.root/job_id
            directory.mkdir(parents=True)
            write_json(directory/'transcripts.json', dict(segments=[]))
            write_json(directory/'state.json', dict(job_id=job_id, status='running', mode='recording-live',
                                                   sample_rate=sample_rate))
            try:
                with (directory/'worker.log').open('xb') as log:
                    self.process = await asyncio.create_subprocess_exec(*self.command(directory, sample_rate),
                        stdin=asyncio.subprocess.PIPE, stdout=log, stderr=asyncio.subprocess.STDOUT)
            except Exception as error:
                write_json(directory/'state.json', dict(job_id=job_id, status='failed', error=str(error)))
                raise HTTPException(500, 'Could not start recording speaker worker') from error
            self.active, self.frames, self.sample_rate, self.accepting = job_id, 0, sample_rate, True
            self.task = asyncio.create_task(self.watch(job_id, directory, self.process))
            return self.status(job_id)

    def require_active(self, job_id):
        directory = self.directory(job_id)
        if self.active != job_id or not self.accepting:
            raise HTTPException(409, 'Speaker stream no longer accepts recording input')
        return directory

    async def send(self, data):
        try:
            self.process.stdin.write(struct.pack('<I', len(data))+data)
            # No unbounded application queue: backpressure propagates to the client.
            await asyncio.wait_for(self.process.stdin.drain(), timeout=10)
        except (BrokenPipeError, ConnectionResetError, asyncio.TimeoutError) as error:
            await self.stop_worker('failed', 'Speaker input stopped or stalled')
            raise HTTPException(503, 'Speaker input stopped or stalled; recording audio is preserved') from error

    async def audio(self, job_id, offset, data):
        async with self.input_lock:
            self.require_active(job_id)
            if offset != self.frames:
                raise HTTPException(409, 'Non-contiguous speaker audio frame offset')
            if not data or len(data) % 4 or len(data) > self.sample_rate*4:
                raise HTTPException(400, 'Expected at most one second of mono float32 PCM')
            if not np.isfinite(np.frombuffer(data, dtype='<f4')).all():
                raise HTTPException(400, 'Non-finite speaker audio')
            await self.send(data)
            self.frames += len(data)//4
            return dict(received_frames=self.frames)

    async def segments(self, job_id, segments):
        async with self.input_lock:
            directory = self.require_active(job_id)
            try:
                if not isinstance(segments, list):
                    raise ValueError('Expected original complete segments')
                plan_batches(segments, self.config.target_span_s)
                previous = json.loads((directory/'transcripts.json').read_text(encoding='utf-8'))['segments']
                if segments[:len(previous)] != previous:
                    raise ValueError('Recording segments must preserve the previously submitted prefix')
            except (KeyError, TypeError, ValueError) as error:
                raise HTTPException(400, str(error)) from error
            write_json(directory/'transcripts.json', dict(segments=segments))
            return dict(segments=len(segments))

    async def finish(self, job_id):
        async with self.input_lock:
            self.directory(job_id)
            if self.active != job_id or not self.accepting:
                return self.status(job_id)
            self.require_active(job_id)
            self.accepting = False
            await self.send(b'')
            self.process.stdin.close()
            return self.status(job_id)

    async def watch(self, job_id, directory, process):
        try:
            code = await process.wait()
            state = self.status(job_id)
            state.pop('result', None)
            state.pop('progress', None)
            if state['status'] != 'running':
                return
            if code:
                state.update(status='failed', error=f'Speaker worker exited {code}; see worker.log')
            else:
                results = list((directory/'meeting-speakers').glob('*/result.json'))
                if len(results) != 1 or self.accepting:
                    state.update(status='failed', error='Speaker worker exited before finalization')
                else:
                    write_json(directory/'result.json', json.loads(results[0].read_text(encoding='utf-8')))
                    state.update(status='completed')
            write_json(directory/'state.json', state)
        except Exception as error:
            write_json(directory/'state.json', dict(job_id=job_id, mode='recording-live', status='failed', error=str(error)))
        finally:
            if self.active == job_id:
                self.active = None
                self.accepting = False

    async def stop_worker(self, status, reason):
        if not self.active:
            return
        directory = self.directory(self.active)
        write_json(directory/'state.json', dict(job_id=self.active, mode='recording-live', status=status, error=reason))
        self.accepting = False
        if self.process.returncode is None:
            try:
                self.process.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(self.process.wait(), timeout=3)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self.task:
            await self.task

    async def cancel(self, job_id):
        async with self.input_lock:
            self.directory(job_id)
            if self.active == job_id:
                await self.stop_worker('cancelled', 'Recording speaker analysis cancelled')
            return self.status(job_id)

    async def close(self):
        async with self.input_lock:
            await self.stop_worker('interrupted', 'Speech service is shutting down')
