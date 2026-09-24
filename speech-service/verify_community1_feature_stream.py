"""Check that incremental feature windows reproduce whole-file Community-1."""
import argparse
import json
import os
from pathlib import Path
import time
import wave


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--audio', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.environ.update(HF_HUB_OFFLINE='1', PYANNOTE_METRICS_ENABLED='0',
                      OMP_NUM_THREADS='4', MKL_NUM_THREADS='4', OPENBLAS_NUM_THREADS='4')
    import numpy as np
    import torch
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    from pyannote.audio import Pipeline
    from community1_feature_stream import CommunityFeatureStream, finalize_features
    from community1_shared_frames import enable_shared_frames

    pipeline = Pipeline.from_pretrained(str(args.model.resolve()))
    pipeline.segmentation_batch_size = 1
    pipeline.embedding_batch_size = 1
    enable_shared_frames(pipeline)
    with wave.open(str(args.audio)) as source:
        samples = np.frombuffer(source.readframes(20*16000), dtype='<i2').astype(np.float32)/32768
    reports = []
    for duration in [20.0, 19.4375, 3.75]:
        clip = samples[:round(duration*16000)]
        file = {'waveform': torch.from_numpy(clip).unsqueeze(0), 'sample_rate': 16000}
        expected_seg = pipeline.get_segmentations(file)
        expected_emb = pipeline.get_embeddings(file, expected_seg, exclude_overlap=True)
        expected_output = finalize_features(pipeline, expected_seg, expected_emb)
        stream = CommunityFeatureStream(pipeline)
        ends = sorted({round(t*16000) for t in [0.31, 3.0, 10, 10.42, 14.9, 19.5, duration] if t <= duration})
        pos = 0
        batches = []
        for end in ends:
            started = time.perf_counter()
            stream.accept(clip[pos:end])
            if stream.processed_windows:
                snapshot_seg, snapshot_emb = stream.snapshot_features()
                finalize_features(pipeline, snapshot_seg, snapshot_emb)
            batches.append(dict(end_s=end/16000, compute_s=time.perf_counter()-started,
                                retained_audio_samples=len(stream.buffer)))
            assert len(stream.buffer) < stream.window
            pos = end
        started = time.perf_counter()
        seg, emb = stream.finish_features()
        actual_output = finalize_features(pipeline, seg, emb)
        tail_s = time.perf_counter()-started
        np.testing.assert_array_equal(seg.data, expected_seg.data)
        np.testing.assert_allclose(emb, expected_emb, atol=1e-4, rtol=1e-4, equal_nan=True)
        for field in ['speaker_diarization', 'exclusive_speaker_diarization']:
            def rows(output):
                return [(s.start, s.end, label) for s, _, label in getattr(output, field).itertracks(yield_label=True)]
            assert rows(actual_output) == rows(expected_output), field
        reports.append(dict(duration_s=duration, passed=True, model_windows=len(seg.data),
                            final_tail_s=tail_s, batches=batches))
        print(json.dumps(reports[-1]), flush=True)
    args.output.write_text(json.dumps(dict(passed=True, cases=reports,
        scope='arbitrary dispatch boundaries test window coverage; not a real-time ASR concurrency test'), indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
