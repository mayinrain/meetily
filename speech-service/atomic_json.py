"""Publish complete JSON snapshots despite brief Windows reader locks."""
import json
import os
import time


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    deadline = time.monotonic()+0.25
    try:
        while True:
            try:
                temporary.replace(path)
                return
            except PermissionError as error:
                if os.name != 'nt' or error.winerror not in (5, 32, 33) or time.monotonic() >= deadline:
                    raise
                time.sleep(0.01)
    finally:
        temporary.unlink(missing_ok=True)
