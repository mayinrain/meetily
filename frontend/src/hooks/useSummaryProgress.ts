import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type AudioRange = { start: number; end: number };
export interface SummaryProgress {
  job_id: string;
  seq: number;
  phase: string;
  current?: { request_id: string; stage: string; draft: string; ranges?: AudioRange[];
    whole_meeting?: boolean; section?: string; group?: number; groups?: number } | null;
  notes?: { content: string; ranges: AudioRange[]; completed_during_recording: boolean }[];
  chapters?: { title: string; content: string }[];
  completed_notes?: number;
  completed_sections?: number;
  covered_through?: number;
  queued_batches?: number;
  draft?: string;
  error?: string | null;
}
type ProgressEvent = SummaryProgress & { kind: 'snapshot' | 'delta'; request_id?: string; text?: string };

export function applySummaryEvent(state: SummaryProgress | null, event: ProgressEvent): SummaryProgress | null {
  if (!state || event.job_id !== state.job_id || event.seq <= state.seq || state.phase === 'completed') return state;
  if (event.kind === 'snapshot') return event;
  if (event.seq !== state.seq + 1 || !state.current || event.request_id !== state.current.request_id) return state;
  return { ...state, seq: event.seq, current: { ...state.current, draft: state.current.draft + (event.text || '') } };
}

// Subscribe before loading a snapshot. A small independent poll repairs event gaps
// and observes the DB commit, even after the speaker worker has finished.
export function useSummaryProgress(meetingId?: string, enabled = true) {
  const [progress, setProgress] = useState<SummaryProgress | null>(null);
  const loadedScope = useRef<string | undefined>(undefined);
  const scope = meetingId || 'recording';
  useEffect(() => {
    setProgress(null); loadedScope.current = scope;
    if (!enabled) return;
    let stopped = false, loading = true;
    let latest: SummaryProgress | null = null;
    let pending: ProgressEvent[] = [];
    let unlisten: (() => void) | undefined, timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const known = latest?.job_id ? { job_id: latest.job_id, seq: latest.seq, phase: latest.phase } : null;
        const value = await invoke<SummaryProgress | null>('get_summary_progress', { meetingId: meetingId || null, known });
        if (stopped) return;
        const queued = pending; pending = [];
        if (value && (!latest || latest.job_id !== value.job_id || value.seq >= latest.seq)) latest = value;
        for (const event of queued) latest = applySummaryEvent(latest, event);
        setProgress(latest);
        loading = false;
        if (latest?.phase === 'completed' || latest?.phase === 'failed' || (meetingId && !latest)) return;
      } catch (error) {
        if (!stopped) setProgress(previous => previous || { job_id: '', seq: 0, phase: 'unavailable', error: String(error) });
      }
      if (!stopped) timer = setTimeout(refresh, 2000);
    };
    void listen<ProgressEvent>('meeting-summary-progress', ({ payload }) => {
      if (stopped) return;
      if (loading) pending.push(payload);
      else { latest = applySummaryEvent(latest, payload); setProgress(latest); }
    }).then(dispose => {
      if (stopped) { dispose(); return; }
      unlisten = dispose; void refresh();
    }).catch(() => { if (!stopped) void refresh(); });
    return () => { stopped = true; clearTimeout(timer); unlisten?.(); pending = []; };
  }, [meetingId, enabled]);
  return enabled && loadedScope.current === scope ? progress : null;
}
