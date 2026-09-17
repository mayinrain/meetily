import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { SpeakerState } from './useMeetingSpeakers';

type RecordingSpeakers = SpeakerState['job'];

export function useRecordingSpeakers(active: boolean) {
  const [state, setState] = useState<RecordingSpeakers | null>(null);
  useEffect(() => {
    setState(null);
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await invoke<RecordingSpeakers | null>('get_recording_speakers');
        if (!stopped) setState(value);
      } catch (reason) {
        if (!stopped) setState({ job_id: '', status: 'failed', error: String(reason) });
      }
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [active]);
  return state;
}
