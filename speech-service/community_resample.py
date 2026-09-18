"""Continuous 48 kHz to 16 kHz resampling with the scipy default FIR context."""
import numpy as np
from scipy.signal import resample_poly


class PCM16k:
    def __init__(self, sample_rate):
        if sample_rate not in (16000, 48000):
            raise ValueError('Expected 16 or 48 kHz mono PCM')
        self.rate = sample_rate
        self.buffer = np.empty(0, dtype=np.float32)
        self.base = self.total = self.emitted = 0

    def accept(self, samples, finished=False):
        samples = np.asarray(samples, dtype=np.float32)
        if self.rate == 16000:
            return samples
        self.buffer = np.concatenate((self.buffer, samples))
        self.total += len(samples)
        # Default resample_poly(1, 3) has 30 source samples on each side.
        end = (self.total+2)//3 if finished else max(0, (self.total-30)//3)
        if end <= self.emitted:
            return np.empty(0, dtype=np.float32)
        output = resample_poly(self.buffer, 1, 3)
        result = output[self.emitted-self.base//3:end-self.base//3].copy()
        self.emitted = end
        keep_from = max(0, end*3-30)
        self.buffer = self.buffer[keep_from-self.base:].copy()
        self.base = keep_from
        return result
