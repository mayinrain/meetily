"""One cancellable speaker worker, sharing the service's ASR exclusion lock."""
import asyncio
import json
from pathlib import Path
import re
import sys
import uuid

from fastapi import HTTPException
import psutil

from speaker_batches import plan_batches


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


class SpeakerJobs:
    def __init__(self, runs, config, busy, ensure_asr_unloaded):
        self.root = Path(runs).resolve()/'speaker-jobs'
        self.config, self.busy, self.ensure_asr_unloaded = config, busy, ensure_asr_unloaded
        self.active = None
        self.tasks = set()

    @property
    def available(self):
        if getattr(self.config, 'backend', None) == 'pyannote-community-1':
            return self.config.available
        return self.config is not None and all(Path(p).is_file() for p in
                                               [self.config.library, self.config.model])

    def directory(self, job_id):
        if not re.fullmatch(r'[0-9a-f]{32}', job_id):
            raise HTTPException(404, 'Speaker job not found')
        directory = self.root/job_id
        if not (directory/'state.json').is_file():
            raise HTTPException(404, 'Speaker job not found')
        return directory

    def status(self, job_id):
        directory = self.directory(job_id)
        status = json.loads((directory/'state.json').read_text(encoding='utf-8'))
        if status['status'] == 'running' and self.active != job_id:
            status.update(status='interrupted', error='Service stopped before the worker completed')
            write_json(directory/'state.json', status)
        if status['status'] == 'completed':
            status['result'] = json.loads((directory/'result.json').read_text(encoding='utf-8'))
        else:
            progress = list((directory/'meeting-speakers').glob('*/progress.json'))
            if len(progress) == 1:
                # Worker progress uses atomic replacement as polling can race writes.
                status['progress'] = json.loads(progress[0].read_text(encoding='utf-8'))
        return status

    def command(self, directory, request):
        if getattr(self.config, 'backend', None) == 'pyannote-community-1':
            return [self.config.python, str(Path(__file__).with_name('process_community_speakers.py')),
                    str(directory), '--model', self.config.model, '--threads', str(self.config.threads),
                    '--audio', request['audio_path']]
        return [sys.executable, str(Path(__file__).with_name('process_speakers.py')),
                request['audio_path'], '--transcripts', str(directory/'transcripts.json'),
                '--library', self.config.library, '--model', self.config.model,
                '--runs', str(directory), '--meeting-id', request['meeting_id'],
                '--target', str(int(self.config.target_span_s)), '--gpu', str(getattr(self.config, 'gpu', -1))]

    async def start(self, request):
        if not self.available:
            raise HTTPException(503, 'Local speaker model/runtime is not configured')
        if self.busy.locked():
            raise HTTPException(409, 'Another audio task is active')
        try:
            plan_batches(request['segments'], self.config.target_span_s, True)
            if not Path(request['audio_path']).is_file():
                raise ValueError('Saved recording not found')
            if not isinstance(request['meeting_id'], str) or not request['meeting_id']:
                raise ValueError('Meeting ID is required')
        except (KeyError, TypeError, ValueError) as error:
            raise HTTPException(400, str(error)) from error
        await self.busy.acquire()
        try:
            await self.ensure_asr_unloaded()
            job_id = uuid.uuid4().hex
            directory = self.root/job_id
            directory.mkdir(parents=True)
            write_json(directory/'transcripts.json', {'segments': request['segments']})
            write_json(directory/'request.json', request)
            write_json(directory/'state.json', dict(job_id=job_id, meeting_id=request['meeting_id'], status='running'))
            self.active = job_id
            task = asyncio.create_task(self.run(job_id, directory, request))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
            return self.status(job_id)
        except BaseException:
            self.busy.release()
            raise

    async def run(self, job_id, directory, request):
        process = None
        status = dict(job_id=job_id, meeting_id=request['meeting_id'])
        try:
            with (directory/'worker.log').open('xb') as log:
                process = await asyncio.create_subprocess_exec(*self.command(directory, request),
                    stdout=log, stderr=asyncio.subprocess.STDOUT)
                while process.returncode is None:
                    if (directory/'cancel').exists():
                        await self.terminate(process)
                        status.update(status='cancelled')
                        break
                    try:
                        await asyncio.wait_for(process.wait(), timeout=0.25)
                    except asyncio.TimeoutError:
                        continue
                else:
                    if process.returncode:
                        raise RuntimeError(f'Speaker worker exited {process.returncode}; see worker.log')
                    results = list((directory/'meeting-speakers').glob('*/result.json'))
                    if len(results) != 1:
                        raise RuntimeError('Speaker worker did not produce one result')
                    result = json.loads(results[0].read_text(encoding='utf-8'))
                    write_json(directory/'result.json', result)
                    status.update(status='completed')
        except asyncio.CancelledError:
            if process is not None:
                await self.terminate(process)
            status.update(status='interrupted', error='Service is shutting down')
        except Exception as error:
            if process is not None and process.returncode is None:
                await self.terminate(process)
            status.update(status='failed', error=str(error))
        finally:
            try:
                write_json(directory/'state.json', status)
            finally:
                self.active = None
                self.busy.release()

    async def terminate(self, process):
        if process.returncode is not None:
            return
        # These are only this job's children (e.g. its bounded FFmpeg decode).
        try:
            children = psutil.Process(process.pid).children(recursive=True)
        except psutil.NoSuchProcess:
            children = []
        for child in children:
            try:
                child.terminate()
            except psutil.NoSuchProcess:
                pass
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), timeout=3)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        _, alive = await asyncio.to_thread(psutil.wait_procs, children, timeout=3)
        for child in alive:
            try:
                child.kill()
            except psutil.NoSuchProcess:
                pass

    async def cancel(self, job_id):
        directory = self.directory(job_id)
        if self.active == job_id:
            (directory/'cancel').touch()
        return self.status(job_id)

    async def close(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
