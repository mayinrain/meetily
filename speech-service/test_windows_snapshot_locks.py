"""Real Windows read handles must not abort live snapshot publication."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time

import pytest

from process_speakers import write_progress
from speaker_jobs import write_json

pytestmark = pytest.mark.skipif(os.name != 'nt', reason='Windows delete-sharing semantics')


def release_later(reader):
    def release():
        time.sleep(0.075)
        reader.close()
    thread = threading.Thread(target=release)
    thread.start()
    return thread


@pytest.mark.parametrize('writer', [write_progress, write_json])
def test_brief_reader_does_not_abort_publication(tmp_path, writer):
    path = tmp_path/'snapshot.json'
    writer(path, {'revision': 1})
    # Python's Windows read handle does not share delete access.
    release = release_later(path.open('rb'))
    try:
        writer(path, {'revision': 2})
    finally:
        release.join()
    assert json.loads(path.read_text()) == {'revision': 2}
    assert list(tmp_path.iterdir()) == [path]


@pytest.mark.parametrize('writer', [write_progress, write_json])
def test_persistent_reader_keeps_previous_snapshot(tmp_path, writer):
    path = tmp_path/'snapshot.json'
    writer(path, {'revision': 1})
    with path.open('rb'):
        with pytest.raises(PermissionError):
            writer(path, {'revision': 2})
    assert json.loads(path.read_text()) == {'revision': 1}


@pytest.mark.parametrize('transient', [True, False])
def test_node_snapshot_under_windows_read_lock(tmp_path, transient):
    node = os.environ.get('MEETILY_WORKFLOW_NODE') or shutil.which('node')
    if not node:
        pytest.skip('Node runtime not configured')
    module = Path(__file__).resolve().parents[1]/'frontend/src-tauri/resources/summary-workflow/live.mjs'
    path = tmp_path/'state.json'
    path.write_text('{"revision":1}')
    script = f"""
import {{ writeJson }} from {json.dumps(module.as_uri())};
console.log('ready');
process.stdin.once('data', () => {{
  writeJson({json.dumps(str(path))}, {{ revision: 2 }});
  process.stdin.pause();
}});
"""
    with path.open('rb') as reader:
        child = subprocess.Popen([node, '--input-type=module', '--eval', script],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        release = None
        try:
            assert child.stdout.readline().strip() == b'ready'
            if transient:
                release = release_later(reader)
            _, error = child.communicate(b'go\n', timeout=10)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            if release:
                release.join()
    assert (child.returncode == 0) == transient, error.decode(errors='replace')
    assert json.loads(path.read_text()) == {'revision': 2 if transient else 1}
    if transient:
        assert list(tmp_path.iterdir()) == [path]
