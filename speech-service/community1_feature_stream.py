"""Experimental Community-1 feature accumulation; cluster once at meeting end.

Call accept only when a complete natural-segment batch is available. Internal
10-second model windows keep the exact whole-file grid and overlap. No local
speaker labels are published or matched between batches.
"""
import numpy as np


class CommunityFeatureStream:
    def __init__(self, pipeline):
        if not pipeline._segmentation.model.specifications.powerset:
            raise ValueError('Only the fixed Community-1 powerset model is supported')
        self.pipeline = pipeline
        self.rate = 16000
        self.window = round(pipeline._segmentation.duration*self.rate)
        self.step = round(pipeline._segmentation.step*self.rate)
        self.buffer = np.empty(0, dtype=np.float32)
        self.total = 0
        self.processed_windows = 0
        self.segmentation_blocks = []
        self.embedding_blocks = []
        self.closed = False
        self.window_spec = None

    def _extract(self, samples, expected_windows):
        import torch

        file = {'waveform': torch.from_numpy(samples).unsqueeze(0), 'sample_rate': self.rate}
        with torch.inference_mode():
            segmentations = self.pipeline.get_segmentations(file)
            if len(segmentations.data) != expected_windows:
                raise ValueError('Chunk boundaries differ from the whole-file model grid')
            embeddings = self.pipeline.get_embeddings(file, segmentations,
                exclude_overlap=self.pipeline.embedding_exclude_overlap)
        self.window_spec = segmentations.sliding_window
        self.segmentation_blocks.append(segmentations.data)
        self.embedding_blocks.append(embeddings)
        self.processed_windows += expected_windows

    def accept(self, samples):
        if self.closed:
            raise ValueError('Feature stream already finished')
        samples = np.asarray(samples, dtype=np.float32)
        if samples.ndim != 1 or not np.isfinite(samples).all():
            raise ValueError('Expected finite mono PCM at 16 kHz')
        self.total += len(samples)
        self.buffer = np.concatenate((self.buffer, samples))
        count = max(0, (len(self.buffer)-self.window)//self.step+1)
        if count:
            # An exact last window end prevents upstream from padding a premature
            # tail. The overlap stays buffered for the next natural batch.
            self._extract(self.buffer[:(count-1)*self.step+self.window], count)
            self.buffer = self.buffer[count*self.step:].copy()

    def finish_features(self):
        from pyannote.core import SlidingWindowFeature

        if self.closed or self.total == 0:
            raise ValueError('Expected a nonempty, unfinished feature stream')
        self.closed = True
        # Match Inference.slide: even when only overlap remains, do not invent
        # an extra padded chunk at exact grid-aligned recording ends.
        if self.total < self.window or (self.total-self.window) % self.step:
            self._extract(self.buffer, 1)
        self.buffer = np.empty(0, dtype=np.float32)
        segmentations = SlidingWindowFeature(np.concatenate(self.segmentation_blocks), self.window_spec)
        embeddings = np.concatenate(self.embedding_blocks)
        self.segmentation_blocks.clear()
        self.embedding_blocks.clear()
        return segmentations, embeddings


def finalize_features(pipeline, segmentations, embeddings, uri='meeting'):
    """Run stock counting, global VBx clustering and reconstruction on ready features."""
    import torch

    original_segmentation, original_embeddings = pipeline.get_segmentations, pipeline.get_embeddings
    try:
        pipeline.get_segmentations = lambda *a, **kw: segmentations
        pipeline.get_embeddings = lambda *a, **kw: embeddings
        # apply does not decode audio after both feature providers are replaced.
        with torch.inference_mode():
            return pipeline.apply({'uri': uri})
    finally:
        pipeline.get_segmentations, pipeline.get_embeddings = original_segmentation, original_embeddings
