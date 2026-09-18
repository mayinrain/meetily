"""Streaming PCM must match whole-file resampling and preserve unlimited IDs."""
import io
import struct
from types import SimpleNamespace

import numpy as np
import pytest
from scipy.signal import resample_poly

from community_resample import PCM16k
from community_config import CommunityConfig
from live_speaker_streams import LiveSpeakerStreams
from process_community_speakers import integer_turns, live_packets
from speaker_jobs import SpeakerJobs


@pytest.mark.parametrize('length', [1, 29, 30, 31, 47999, 48000, 48001, 96007])
def test_48k_stream_matches_whole_resampling_without_lost_tail(length):
    samples = np.random.default_rng(4).normal(size=length).astype(np.float32)
    stream = PCM16k(48000)
    actual = [stream.accept(samples[i:i+137]) for i in range(0, length, 137)]
    actual.append(stream.accept([], finished=True))
    np.testing.assert_allclose(np.concatenate(actual), resample_poly(samples, 1, 3), atol=1e-6)
    assert len(stream.buffer) <= 30


def test_original_16k_samples_do_not_change():
    samples = np.array([0.125, -0.5, 0], dtype=np.float32)
    np.testing.assert_array_equal(PCM16k(16000).accept(samples), samples)


def test_packet_disconnect_never_counts_as_success():
    with pytest.raises(EOFError):
        list(live_packets(io.BytesIO(struct.pack('<I', 8)+bytes(4)), 16000))
    with pytest.raises(ValueError):
        list(live_packets(io.BytesIO(struct.pack('<I', 64004)), 16000))
    assert list(live_packets(io.BytesIO(bytes(4)), 16000)) == []


def test_exclusive_and_overlapping_outputs_share_ids_beyond_four():
    class Annotation:
        def __init__(self, rows): self.rows = rows
        def itertracks(self, **_): return iter(self.rows)
    rows = [(SimpleNamespace(start=i, end=i+2), None, f'person-{i}') for i in range(6)]
    output = SimpleNamespace(speaker_diarization=Annotation(rows),
        exclusive_speaker_diarization=Annotation(rows[:3]+[rows[5]]))
    raw, exclusive = integer_turns(output)
    assert [r['speaker'] for r in raw] == [1, 2, 3, 4, 5, 6]
    assert [r['speaker'] for r in exclusive] == [1, 2, 3, 6]


def test_service_uses_isolated_python_for_both_live_and_saved_jobs(tmp_path):
    config = CommunityConfig('/isolated/python', '/local/community')
    live = LiveSpeakerStreams(tmp_path, config, None, None)
    saved = SpeakerJobs(tmp_path, config, None, None)
    for command in (live.command(tmp_path, 48000), saved.command(tmp_path, {'audio_path':'saved.mp4'})):
        assert command[0] == '/isolated/python'
        assert command[1].endswith('process_community_speakers.py')
        assert '--library' not in command
    assert not live.available and not saved.available
