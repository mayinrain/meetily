"""Publish immutable natural batches with identities anchored to meeting history."""
import numpy as np
from scipy.optimize import linear_sum_assignment

from speaker_batches import annotate_segments


class MeetingSpeakerBatches:
    def __init__(self):
        self.turns, self.raw_turns, self.batches = [], [], []
        self.through = 0.0
        self.next_id = 1
        self.history_conflicts_s = 0.0

    def _identity_map(self, raw, exclusive):
        current = list(dict.fromkeys(t['speaker'] for t in raw))
        previous = sorted({t['speaker'] for t in self.turns})
        mapping = {}
        uncertain = set()
        if current and previous:
            scores = np.zeros((len(current), len(previous)))
            current_indices = {s: i for i, s in enumerate(current)}
            previous_indices = {s: i for i, s in enumerate(previous)}
            # Exclusive intervals are ordered and nonoverlapping: linear sweep.
            j = 0
            for turn in exclusive:
                while j < len(self.turns) and self.turns[j]['end'] <= turn['start']:
                    j += 1
                k = j
                while k < len(self.turns) and self.turns[k]['start'] < turn['end']:
                    old = self.turns[k]
                    overlap = min(turn['end'], old['end'])-max(turn['start'], old['start'])
                    if overlap > 0:
                        scores[current_indices[turn['speaker']], previous_indices[old['speaker']]] += overlap
                    k += 1
            rows, columns = linear_sum_assignment(-scores)
            for row, column in zip(rows, columns):
                if scores[row, column] >= 0.5 and scores[row, column] >= 0.6*scores[row].sum():
                    mapping[current[row]] = previous[column]
            matched = sum(scores[current_indices[label], previous_indices[identity]]
                          for label, identity in mapping.items())
            self.history_conflicts_s = float(scores.sum()-matched)
            for label, row in current_indices.items():
                accepted = scores[row, previous_indices[mapping[label]]] if label in mapping else 0
                if scores[row].sum()-accepted >= 0.5:
                    uncertain.add(label)
        for label in current:
            if label not in mapping:
                mapping[label] = self.next_id
                self.next_id += 1
        return mapping, uncertain

    def publish(self, raw, exclusive, batches, segments, final_end=None):
        pending = batches[len(self.batches):]
        if not pending and (final_end is None or final_end <= self.through):
            return
        end = final_end if final_end is not None else pending[-1]['end']
        if end <= self.through:
            raise ValueError('Published batch endpoints must increase')
        mapping, uncertain = self._identity_map(raw, exclusive)

        def append(target, incoming):
            for turn in incoming:
                lo, hi = max(self.through, turn['start']), min(end, turn['end'])
                if hi > lo:
                    value = dict(start=lo, end=hi, speaker=mapping[turn['speaker']])
                    if turn['speaker'] in uncertain:
                        value['identity_uncertain'] = True
                    target.append(value)

        append(self.raw_turns, raw)
        append(self.turns, exclusive)
        by_id = {s['id']: s for s in segments}
        for batch in pending:
            source = [by_id[sid] for sid in batch['segment_ids']]
            annotations = annotate_segments(source, self.turns)
            labelled = [dict(row, **{k: annotation[k] for k in ('speaker_ids', 'needs_review', 'intervals')})
                        for row, annotation in zip(source, annotations)]
            self.batches.append(dict(batch, batch_id=len(self.batches), segments=labelled))
        self.through = end

    def result(self, segments):
        return dict(turns=self.turns, raw_turns=self.raw_turns, batches=self.batches,
                    segments=annotate_segments(segments, self.turns), source_segments=segments,
                    published_through_s=self.through,
                    speaker_count=len({t['speaker'] for t in self.raw_turns}),
                    identity_status='anonymous', identity_strategy='meeting_history_frozen_batches',
                    history_conflicts_s=self.history_conflicts_s, alignment_output='exclusive')
