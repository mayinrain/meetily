"""Deepgram wire format using native token onset points, never invented word spans."""
from datetime import datetime, timezone

from core import MODEL_NAME


def words(segment):
    tokens, times = segment["tokens"], segment["timestamps"]
    if len(tokens) != len(times):
        raise ValueError("ASR token/timestamp count mismatch")
    # SenseVoice supplies CTC token starts, not word end times. Preserve point
    # intervals explicitly; a consumer needing spans must run an aligner.
    return [dict(word=token, punctuated_word=token, start=t, end=t,
                 confidence=0.0, speaker=None)
            for token, t in zip(tokens, times)]


def metadata(run):
    return dict(request_id=run.id, model_uuid=MODEL_NAME,
                model_info=dict(name=MODEL_NAME, version="2024-07-17-int8", arch="sensevoice"),
                extra=dict(timestamp_granularity="token_start_point",
                           confidence_available=False, service_version=run.config["service_version"]))


def stream_result(segment, run, channels, finalized=False):
    return dict(type="Results", start=segment["start"], duration=segment["end"]-segment["start"],
                is_final=True, speech_final=True, from_finalize=finalized,
                channel_index=[segment["channel"], channels], metadata=metadata(run),
                channel=dict(alternatives=[dict(transcript=segment["text"], words=words(segment),
                                                confidence=0.0, languages=["zh", "en"])]))


def terminal(run, duration, channels):
    return dict(type="Metadata", request_id=run.id, created=datetime.now(timezone.utc).isoformat(),
                duration=duration, channels=channels)


def batch_result(segments, run, duration, channel_count):
    channels = []
    for c in range(channel_count):
        selected = [s for s in segments if s["channel"] == c]
        channels.append(dict(alternatives=[dict(transcript="".join(s["text"] for s in selected),
                                               confidence=0.0, words=[w for s in selected for w in words(s)])]))
    return dict(metadata=dict(**metadata(run), duration=duration), results=dict(channels=channels))
