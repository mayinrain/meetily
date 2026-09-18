"""Complete Meetily segments determine dispatch boundaries; audio remains continuous."""
import math


def plan_batches(segments, target_s, recording_finished=False):
    if not math.isfinite(target_s) or target_s <= 0:
        raise ValueError('Expected a positive target duration')
    batches, pending, seen = [], [], set()
    start = end = previous = None
    for segment in segments:
        lo, hi = segment['audio_start_time'], segment['audio_end_time']
        if (not math.isfinite(lo) or not math.isfinite(hi) or lo < 0 or hi <= lo
                or (previous is not None and lo < previous) or segment['id'] in seen):
            raise ValueError('Expected uniquely identified complete segments in audio order')
        seen.add(segment['id'])
        previous = lo
        start = lo if start is None else min(start, lo)
        end = hi if end is None else max(end, hi)
        pending.append(segment)
        if end-start >= target_s:
            batches.append(dict(start=start, end=end, segment_ids=[s['id'] for s in pending],
                                reason='target_reached_at_segment_end'))
            pending, start, end = [], None, None
    if recording_finished and pending:
        batches.append(dict(start=start, end=end, segment_ids=[s['id'] for s in pending],
                            reason='recording_finished'))
        pending = []
    return dict(target_span_s=target_s, batches=batches, pending_segment_ids=[s['id'] for s in pending])


def annotate_segments(segments, turns):
    """Keep natural text segments intact and expose every intersecting speaker.

    Multiple speakers remain ambiguous at text level: VAD padding or an actual
    speaker change may cause the intersection. Do not invent word boundaries.
    """
    annotations = []
    for segment in segments:
        intervals = [dict(speaker=t['speaker'],
                          start=max(segment['audio_start_time'], t['start']),
                          end=min(segment['audio_end_time'], t['end'])) for t in turns
                     if t['end'] > segment['audio_start_time'] and t['start'] < segment['audio_end_time']]
        speakers = sorted({t['speaker'] for t in intervals})
        annotations.append(dict(segment_id=segment['id'], speaker_ids=speakers,
                                needs_review=len(speakers) != 1, intervals=intervals))
    return annotations
