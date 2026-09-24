from contextlib import nullcontext
import sys
import threading
from types import SimpleNamespace

import numpy as np
import pytest

from community1_feature_stream import CommunityFeatureStream, finalize_features


@pytest.fixture
def fake_runtime(monkeypatch):
    class Feature:
        def __init__(self, data, sliding_window):
            self.data, self.sliding_window = data, sliding_window
    monkeypatch.setitem(sys.modules, 'pyannote.core', SimpleNamespace(SlidingWindowFeature=Feature))
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(inference_mode=nullcontext))


def test_snapshot_does_not_consume_or_modify_future_features(fake_runtime):
    class Stream(CommunityFeatureStream):
        def _extract(self, samples, expected_windows):
            windows = [np.pad(samples[i*self.step:i*self.step+self.window],
                              (0, max(0, self.window-len(samples[i*self.step:i*self.step+self.window]))))
                       for i in range(expected_windows)]
            self.window_spec = 'fixed-grid'
            self.segmentation_blocks.append(np.array(windows))
            self.embedding_blocks.append(np.array(windows).sum(axis=1, keepdims=True))
            self.processed_windows += expected_windows
    pipeline = SimpleNamespace(_segmentation=SimpleNamespace(duration=.01, step=.001,
        model=SimpleNamespace(specifications=SimpleNamespace(powerset=True))))
    samples = np.arange(403, dtype=np.float32)
    baseline, inspected = Stream(pipeline), Stream(pipeline)
    baseline.accept(samples)
    for start in range(0, len(samples), 47):
        inspected.accept(samples[start:start+47])
        if inspected.processed_windows:
            before = inspected.buffer.copy()
            seg, emb = inspected.snapshot_features()
            seg.data[:] = -1
            emb[:] = -1
            np.testing.assert_array_equal(inspected.buffer, before)
            assert not inspected.closed
    expected_seg, expected_emb = baseline.finish_features()
    actual_seg, actual_emb = inspected.finish_features()
    np.testing.assert_array_equal(actual_seg.data, expected_seg.data)
    np.testing.assert_array_equal(actual_emb, expected_emb)
    with pytest.raises(ValueError):
        inspected.snapshot_features()


def test_background_clustering_does_not_replace_capture_methods(fake_runtime):
    entered, release = threading.Event(), threading.Event()
    class Pipeline:
        weights = object()
        def get_segmentations(self, *_): return 'live segmentation'
        def get_embeddings(self, *_): return 'live embeddings'
        def apply(self, _):
            entered.set()
            assert release.wait(2)
            return self.get_segmentations(), self.get_embeddings(), self.weights
    pipeline = Pipeline()
    output = []
    thread = threading.Thread(target=lambda: output.append(finalize_features(pipeline, 'snapshot', 'embeddings')))
    thread.start()
    try:
        assert entered.wait(2)
        assert pipeline.get_segmentations() == 'live segmentation'
        assert pipeline.get_embeddings() == 'live embeddings'
    finally:
        release.set()
        thread.join(2)
    assert output == [('snapshot', 'embeddings', pipeline.weights)]
