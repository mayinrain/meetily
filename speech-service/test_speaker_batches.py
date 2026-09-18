import math

import pytest

from speaker_batches import annotate_segments, plan_batches


def segment(i, start, end):
    return dict(id=str(i), audio_start_time=start, audio_end_time=end, text='完整原文')


@pytest.mark.parametrize('rows', [
    [segment(1, 0, 40), segment(2, 0, math.nan)],
    [segment(1, 20, 60), segment(2, 1, 10)],
    [segment(1, 0, 40), segment(1, 42, 55)],
])
def test_rejects_invalid_segments_even_across_batches(rows):
    with pytest.raises(ValueError):
        plan_batches(rows, 30, True)


def test_long_natural_segment_kept_whole_then_tail_flushed():
    rows = [segment(1, 2, 20), segment(2, 21, 143), segment(3, 144, 147)]
    result = plan_batches(rows, 60, True)
    assert [(b['end'], b['segment_ids']) for b in result['batches']] == [(143, ['1', '2']), (147, ['3'])]
    assert rows[1]['text'] == '完整原文'


def test_mixed_and_unknown_text_are_not_assigned_a_fabricated_speaker():
    rows = [segment(1, 0, 5), segment(2, 5, 9), segment(3, 10, 11)]
    turns = [dict(start=1, end=7, speaker=0), dict(start=6, end=8, speaker=1)]
    result = annotate_segments(rows, turns)
    assert result[0]['speaker_ids'] == [0] and not result[0]['needs_review']
    assert result[1]['speaker_ids'] == [0, 1] and result[1]['needs_review']
    assert result[2]['speaker_ids'] == [] and result[2]['needs_review']
    assert result[1]['intervals'] == [dict(start=5, end=7, speaker=0), dict(start=6, end=8, speaker=1)]
    assert all(s['text'] == '完整原文' for s in rows)
