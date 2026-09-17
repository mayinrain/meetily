import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface SpeakerState {
  job: {
    job_id: string;
    status: string;
    error?: string;
    progress?: { audio_end_s: number; audio_duration_s: number };
    result?: {
      turns: { start: number; end: number; speaker: number }[];
      segments: { segment_id: string; speaker_ids: number[]; needs_review: boolean }[];
      speaker_count: number;
      published_through_s?: number;
    };
  };
  names: Record<string, string>;
  overrides: Record<string, number | null>;
}

export function useMeetingSpeakers(meetingId?: string, enabled = false) {
  const [state, setState] = useState<SpeakerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const currentMeeting = useRef(meetingId);
  const autoAttempted = useRef<string | null>(null);
  currentMeeting.current = meetingId;

  const refresh = useCallback(async () => {
    if (!meetingId || !enabled) return null;
    try {
      const value = await invoke<SpeakerState | null>('get_meeting_speakers', { meetingId });
      if (currentMeeting.current === meetingId) { setState(value); setError(null); }
      return value;
    } catch (reason) {
      if (currentMeeting.current === meetingId) setError(String(reason));
      return null;
    }
  }, [meetingId, enabled]);

  useEffect(() => {
    if (state?.job.status !== 'running') return;
    // Schedule after each completed request so a slow service cannot pile up polls.
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const value = await refresh();
      if (!stopped && (!value || value.job.status === 'running')) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [state?.job.status, refresh]);

  const action = useCallback(async (command: string, args: Record<string, unknown> = {}) => {
    if (!meetingId) return;
    setLoading(true);
    setError(null);
    try {
      await invoke(command, { meetingId, ...args });
      await refresh();
    } catch (reason) {
      if (currentMeeting.current === meetingId) setError(String(reason));
    } finally { if (currentMeeting.current === meetingId) setLoading(false); }
  }, [meetingId, refresh]);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setError(null);
    setLoading(false);
    const load = async () => {
      const value = await refresh();
      if (cancelled || !enabled || !meetingId || value || autoAttempted.current === meetingId
        || new URLSearchParams(window.location.search).get('source') !== 'recording') return;
      autoAttempted.current = meetingId;
      try {
        const available = await invoke<boolean>('speaker_service_available');
        if (!cancelled && available) await action('start_meeting_speakers');
      } catch (reason) { if (!cancelled) setError(String(reason)); }
    };
    void load();
    return () => { cancelled = true; };
  }, [refresh, action, enabled, meetingId]);

  const speakerIds = useMemo(() => state?.job.status === 'completed'
    ? [...new Set(state.job.result?.turns.map(t => t.speaker) ?? [])].sort((a, b) => a - b) : [], [state]);
  const annotations = useMemo(() => new Map(state?.job.status === 'completed'
    ? state.job.result?.segments.map(s => [s.segment_id, s]) ?? [] : []), [state]);
  const name = useCallback((id: number) => state?.names[String(id)] || `说话人 ${id}`, [state?.names]);
  const label = useCallback((segmentId: string) => {
    if (state?.job.status !== 'completed') return undefined;
    if (Object.prototype.hasOwnProperty.call(state.overrides, segmentId)) {
      const id = state.overrides[segmentId];
      return id === null ? '未确认（人工）' : `${name(id)}（人工）`;
    }
    const segment = annotations.get(segmentId);
    if (!segment?.speaker_ids.length) return '待确认';
    return segment.speaker_ids.map(name).join(' / ') + (segment.needs_review ? ' · 待校正' : '');
  }, [state, annotations, name]);
  return { state, error, loading, action, speakerIds, name, label };
}
