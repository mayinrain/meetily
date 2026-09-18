import hashlib
import io
import json
import struct

import pytest

from core import Run
import process_live_speakers as module
from process_speakers import SpeakerConfig


def test_continuous_native_state_publishes_natural_batch_and_flushes_tail(tmp_path, monkeypatch):
    instances = []
    class Native:
        def __init__(self, *_):
            self.frames = self.finished = self.closed = 0
            self.rates = []
            instances.append(self)
        def push(self, pcm, rate):
            self.frames += len(pcm)
            self.rates.append(rate)
        def turns(self):
            return [dict(start=0, end=self.frames/16000, speaker=1)]
        def finish(self):
            self.finished += 1
            return self.turns()
        def close(self):
            self.closed += 1
    monkeypatch.setattr(module, 'NativeSpeakerStream', Native)
    rows = [dict(id='a', audio_start_time=0, audio_end_time=1.5),
            dict(id='b', audio_start_time=1.6, audio_end_time=2)]
    (tmp_path/'transcripts.json').write_text(json.dumps(dict(segments=rows)))
    pcm = bytes(16000*4)
    wire = (struct.pack('<I', len(pcm))+pcm)*2+struct.pack('<I', 0)
    config = SpeakerConfig('unused', 'unused', target_span_s=1)
    run = Run(tmp_path, 'test', config)
    try:
        result = module.process(tmp_path, 16000, config, run, io.BytesIO(wire))
        run.finish()
    except BaseException as error:
        run.fail(error)
        raise
    assert len(instances) == 1
    native, = instances
    assert native.frames == 32000 and native.finished == native.closed == 1
    assert native.rates == [16000, 16000]
    assert result['input_pcm_sha256'] == hashlib.sha256(pcm*2).hexdigest()
    assert [s['segment_id'] for s in result['segments']] == ['a', 'b']
    assert result['source_segments'] == rows
    assert result['published_through_s'] == 2
    events = [json.loads(line) for line in (run.path/'events.jsonl').read_text().splitlines()]
    snapshots = [e for e in events if e['event']=='speaker_snapshot']
    assert [(s['audio_end_s'], s['segments'], s['provisional']) for s in snapshots] == [(2,1,True),(2,2,False)]


def test_protocol_eof_is_not_a_successful_finish():
    with pytest.raises(EOFError):
        module.read_exact(io.BytesIO(b'abc'), 4)
