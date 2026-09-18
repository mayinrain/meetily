"""Reuse WeSpeaker convolution frames across local speakers in one audio window.

For pyannote.audio 4.0.7 Community-1 only. Keep the upstream overlap masks,
short-clean-speech fallback, pooling and embedding weights unchanged.
"""
import math
from types import MethodType

import numpy as np
import torch


def shared_embeddings(self, file, binary_segmentations, exclude_overlap=False, hook=None):
    masks = binary_segmentations.data
    num_chunks, num_frames, num_speakers = masks.shape
    duration = binary_segmentations.sliding_window.duration
    if exclude_overlap:
        minimum = math.ceil(num_frames * self._embedding.min_num_samples
                            / (duration * self._embedding.sample_rate))
        clean = masks * (masks.sum(axis=2, keepdims=True) < 2)
        # Upstream replaces NaN before deciding whether to use the clean mask.
        clean = np.nan_to_num(clean, nan=0.0).astype(np.float32)
        masks = np.nan_to_num(masks, nan=0.0).astype(np.float32)
        masks = np.where(clean.sum(axis=1, keepdims=True) > minimum, clean, masks)
    else:
        masks = np.nan_to_num(masks, nan=0.0).astype(np.float32)

    model = self._embedding.model_
    batch_size = self.embedding_batch_size  # Number of distinct audio windows.
    total = math.ceil(num_chunks/batch_size)
    if hook:
        hook('embeddings', None, total=total, completed=0)
    batches = []
    with torch.inference_mode():
        for start in range(0, num_chunks, batch_size):
            end = min(start+batch_size, num_chunks)
            waveforms = torch.stack([
                self._audio.crop(file, binary_segmentations.sliding_window[i], mode='pad')[0]
                for i in range(start, end)
            ]).to(self._embedding.device)
            weights = torch.from_numpy(masks[start:end].transpose(0, 2, 1).copy()).to(self._embedding.device)
            frames = model.forward_frames(waveforms)
            embeddings = model.forward_embedding(frames, weights=weights).cpu().numpy()
            if embeddings.shape[:2] != (end-start, num_speakers):
                raise ValueError('Unexpected multi-speaker embedding shape')
            batches.append(embeddings)
            if hook:
                hook('embeddings', None, total=total, completed=len(batches))
    return np.concatenate(batches)


def enable_shared_frames(pipeline):
    from pyannote.audio.models.embedding.wespeaker import WeSpeakerResNet34

    if not isinstance(pipeline._embedding.model_, WeSpeakerResNet34):
        raise ValueError('Shared frames are validated only for Community-1 WeSpeakerResNet34')
    if pipeline.training:
        raise ValueError('This benchmark path does not implement training caches')
    pipeline.get_embeddings = MethodType(shared_embeddings, pipeline)
