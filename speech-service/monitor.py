"""Sample all test applications and their children without launching any models."""
import argparse
import json
from pathlib import Path
import time

import psutil

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--stop-file', type=Path, required=True)
args = parser.parse_args()
known = {}
started = time.time()
with args.output.open('x', encoding='utf-8', buffering=1) as log:
    while not args.stop_file.exists():
        targets = {}
        for process in psutil.process_iter(['pid', 'name', 'exe']):
            try:
                exe = process.info['exe']
                if exe and Path(exe).is_relative_to(args.root):
                    targets[process.pid] = process
                    targets.update({child.pid: child for child in process.children(recursive=True)})
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        rows = []
        for pid, process in targets.items():
            try:
                # Windows reuses PIDs: retain CPU counters only for the same
                # process lifetime, otherwise cached names/counters can be stale.
                current = psutil.Process(pid)
                previous = known.get(pid)
                if previous is None or previous.create_time() != current.create_time():
                    known[pid] = current
                process = known[pid]
                memory = process.memory_info()
                rows.append(dict(pid=pid, name=process.name(), cpu_percent=process.cpu_percent(),
                                 create_time=process.create_time(),
                                 rss_bytes=memory.rss, private_bytes=getattr(memory, 'private', None)))
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        known = {pid: process for pid, process in known.items() if pid in targets}
        log.write(json.dumps(dict(unix_time=time.time(), elapsed_s=time.time()-started,
                                  system_available_bytes=psutil.virtual_memory().available,
                                  processes=rows)) + '\n')
        time.sleep(1)
