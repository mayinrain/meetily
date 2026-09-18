"""A reused Windows PID must start new resource counters and retain its new name."""
import json
import os
from pathlib import Path
import runpy
from types import SimpleNamespace
from unittest.mock import patch


def test_pid_reuse_resets_cached_process(tmp_path):
    tick = 0
    output, stop = tmp_path/'samples.jsonl', tmp_path/'stop'

    class Process:
        def __init__(self, pid):
            self.pid, self.birth, self.calls = pid, (1 if tick < 2 else 2), 0
            self.info = dict(exe=str(tmp_path/'app.exe'))

        def create_time(self):
            return self.birth

        def name(self):
            return 'old-app.exe' if self.birth == 1 else 'new-app.exe'

        def children(self, recursive):
            return []

        def memory_info(self):
            return SimpleNamespace(rss=1024, private=2048)

        def cpu_percent(self):
            self.calls += 1
            return self.calls

    def sleep(_):
        nonlocal tick
        tick += 1
        if tick == 3:
            stop.touch()

    fake = SimpleNamespace(Process=Process, process_iter=lambda _: [Process(7)],
                           NoSuchProcess=ProcessLookupError, AccessDenied=PermissionError,
                           virtual_memory=lambda: SimpleNamespace(available=8192))
    script = Path(os.environ.get('MONITOR_UNDER_TEST', Path(__file__).with_name('monitor.py')))
    argv = [str(script), '--root', str(tmp_path), '--output', str(output), '--stop-file', str(stop)]
    with patch.dict('sys.modules', psutil=fake), patch('sys.argv', argv), patch('time.sleep', sleep):
        runpy.run_path(str(script), run_name='__main__')
    rows = [json.loads(line)['processes'][0] for line in output.read_text().splitlines()]
    assert [row['name'] for row in rows] == ['old-app.exe', 'old-app.exe', 'new-app.exe']
    assert [row['cpu_percent'] for row in rows] == [1, 2, 1]
    assert [row['create_time'] for row in rows] == [1, 1, 2]
