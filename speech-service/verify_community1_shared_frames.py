"""Compare actual Community-1 embeddings before enabling frame reuse."""
import argparse
import json
import os
from pathlib import Path
import time
import wave


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--audio-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.environ.update(HF_HUB_OFFLINE='1', PYANNOTE_METRICS_ENABLED='0',
                      OMP_NUM_THREADS='4', MKL_NUM_THREADS='4', OPENBLAS_NUM_THREADS='4')
    import numpy as np
    import torch
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    from pyannote.audio import Pipeline
    from community1_shared_frames import shared_embeddings

    pipeline = Pipeline.from_pretrained(str(args.model.resolve()))
    pipeline.segmentation_batch_size = 1
    pipeline.embedding_batch_size = 1
    reports = []
    for name in ['opening', 'turn-taking', 'second-meeting', 'silence']:
        if name == 'silence':
            samples = np.zeros(12*16000, dtype=np.float32)
        else:
            with wave.open(str(args.audio_dir/f'{name}.wav')) as source:
                samples = np.frombuffer(source.readframes(20*16000), dtype='<i2').astype(np.float32)/32768
        file = {'waveform': torch.from_numpy(samples).unsqueeze(0), 'sample_rate': 16000}
        segmentations = pipeline.get_segmentations(file)
        if not pipeline._segmentation.model.specifications.powerset:
            raise ValueError('Expected the fixed Community-1 powerset model')
        started = time.perf_counter()
        expected = pipeline.get_embeddings(file, segmentations, exclude_overlap=True)
        baseline_s = time.perf_counter()-started
        started = time.perf_counter()
        actual = shared_embeddings(pipeline, file, segmentations, exclude_overlap=True)
        shared_s = time.perf_counter()-started
        np.testing.assert_allclose(actual, expected, rtol=1e-4, atol=1e-4, equal_nan=True)
        finite = np.isfinite(expected)
        reports.append(dict(clip=name, passed=True, shape=list(expected.shape),
                            finite_values=int(finite.sum()),
                            max_absolute_difference=float(np.max(np.abs(actual[finite]-expected[finite]))) if finite.any() else 0,
                            baseline_embedding_s=baseline_s, shared_embedding_s=shared_s))
        print(json.dumps(reports[-1]), flush=True)
    args.output.write_text(json.dumps(dict(passed=True, rtol=1e-4, atol=1e-4, cases=reports), indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
