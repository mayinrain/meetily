import copy

from community_batches import MeetingSpeakerBatches
from speaker_batches import plan_batches


def turn(start, end, speaker):
    return dict(start=start, end=end, speaker=speaker)


def segment(i):
    return dict(id=str(i), text=f'original {i}', audio_start_time=i*10., audio_end_time=(i+1)*10.)


def test_permutation_new_speaker_and_returning_absent_speaker_keep_history():
    state = MeetingSpeakerBatches()
    rows = [segment(i) for i in range(6)]
    plan = plan_batches(rows, 20)['batches']
    first = [turn(0, 10, 0), turn(10, 20, 1)]
    state.publish(first, first, plan[:1], rows)
    frozen = copy.deepcopy(state.batches[0])
    # A new person appears; old labels change globally, and person 1 is absent
    # from the newest buffer. Full accumulated history still anchors their ID.
    second = [turn(0, 10, 2), turn(10, 30, 0), turn(30, 40, 1)]
    state.publish(second, second, plan[:2], rows)
    third = [turn(0, 10, 1), turn(10, 30, 2), turn(30, 40, 0), turn(40, 60, 1)]
    state.publish(third, third, plan, rows)
    assert [b['segments'][0]['speaker_ids'] for b in state.batches] == [[1], [2], [1]]
    assert state.batches[1]['segments'][1]['speaker_ids'] == [3]
    assert state.batches[0] == frozen
    before = copy.deepcopy(state.result(rows))
    state.publish(third, third, plan, rows)
    assert state.result(rows) == before
    assert [s['text'] for b in state.batches for s in b['segments']] == [s['text'] for s in rows]


def test_short_stop_flush_and_overlaps_remain_explicit():
    rows = [segment(0)]
    raw = [turn(0, 10, 7), turn(5, 7, 8)]
    exclusive = [turn(0, 5, 7), turn(5, 7, 8), turn(7, 10, 7)]
    state = MeetingSpeakerBatches()
    assert plan_batches(rows, 60)['batches'] == []
    state.publish(raw, exclusive, plan_batches(rows, 60, True)['batches'], rows)
    assert state.batches[0]['segments'][0]['needs_review']
    assert state.batches[0]['segments'][0]['speaker_ids'] == [1, 2]
    assert len(state.raw_turns) == 2
    assert len(state.turns) == 3
    assert state.through == 10


def test_later_cluster_merge_is_reported_without_rewriting_published_text_or_ids():
    rows = [segment(i) for i in range(4)]
    state = MeetingSpeakerBatches()
    plan = plan_batches(rows, 20)['batches']
    first = [turn(0, 10, 0), turn(10, 20, 1)]
    state.publish(first, first, plan[:1], rows)
    frozen = copy.deepcopy(state.batches[0])
    merged = [turn(0, 40, 0)]
    state.publish(merged, merged, plan, rows)
    assert state.history_conflicts_s > 0
    assert state.batches[0] == frozen
    assert all(s['needs_review'] for s in state.batches[1]['segments'])


def test_final_audio_without_asr_text_still_has_speaker_turns():
    state = MeetingSpeakerBatches()
    turns = [turn(1, 8, 0)]
    state.publish(turns, turns, [], [], final_end=10)
    result = state.result([])
    assert result['speaker_count'] == 1
    assert result['turns'] == [turn(1, 8, 1)]
    assert result['batches'] == []


def test_stop_preserves_untranscribed_audio_after_last_published_batch():
    rows = [segment(i) for i in range(2)]
    state = MeetingSpeakerBatches()
    batches = plan_batches(rows, 20)['batches']
    state.publish([turn(0, 20, 0)], [turn(0, 20, 0)], batches, rows)
    frozen = copy.deepcopy(state.batches)
    final = [turn(0, 24, 5)]
    state.publish(final, final, batches, rows, final_end=25)
    assert state.turns[-1] == turn(20, 24, 1)
    assert state.batches == frozen
