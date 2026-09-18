"""Community-1 runs in its own Python environment, separate from ASR."""
from dataclasses import dataclass
from pathlib import Path


@dataclass
class CommunityConfig:
    python: str
    model: str
    threads: int = 4
    target_span_s: float = 60
    backend: str = 'pyannote-community-1'

    @property
    def available(self):
        root = Path(self.model)
        return Path(self.python).is_file() and all((root/name).is_file() for name in
            ('config.yaml', 'segmentation/pytorch_model.bin', 'embedding/pytorch_model.bin',
             'plda/plda.npz', 'plda/xvec_transform.npz'))
