import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { SummaryProgress } from '../../src/hooks/useSummaryProgress';
const core = { ...await import('@tauri-apps/api/core') };
const events = { ...await import('@tauri-apps/api/event') };
const readers: ((value: SummaryProgress | null) => void)[] = [];
const requests: any[] = [];
let listener: (event: any) => void;
let unlistened = 0;
mock.module('@tauri-apps/api/core', () => ({ ...core, invoke: (_: string, args: any) => { requests.push(args); return new Promise(resolve => readers.push(resolve as any)); } }));
mock.module('@tauri-apps/api/event', () => ({ ...events, listen: async (_: string, handler: any) => { listener = handler; return () => { unlistened++; }; } }));
const { useSummaryProgress, applySummaryEvent } = await import('../../src/hooks/useSummaryProgress');
let current: SummaryProgress | null, renderer: ReactTestRenderer;
const state = (job_id = 'a', seq = 1): SummaryProgress => ({ job_id, seq, phase: 'recording_note', current: { request_id: 'r1', stage: 'recording_note', draft: '开始' } });
function Probe({ id, revision = 0 }: { id: string; revision?: number }) { current = useSummaryProgress(id, true, revision); return null; }
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); readers.length = 0; requests.length = 0; });
afterAll(() => { mock.module('@tauri-apps/api/core', () => core); mock.module('@tauri-apps/api/event', () => events); });

test('duplicate, late, mismatched request and other-meeting deltas do not alter the panel', () => {
  const before = state();
  for (const event of [
    { job_id: 'b', seq: 2, request_id: 'r1' }, { job_id: 'a', seq: 1, request_id: 'r1' },
    { job_id: 'a', seq: 2, request_id: 'old' }, { job_id: 'a', seq: 3, request_id: 'r1' },
  ]) expect(applySummaryEvent(before, { ...event, phase: '', kind: 'delta', text: '迟到' })).toBe(before);
  expect(applySummaryEvent(before, { job_id: 'a', seq: 2, phase: '', kind: 'delta', request_id: 'r1', text: '正文' })?.current?.draft).toBe('开始正文');
});
test('an event between subscription and snapshot load is preserved', async () => {
  await act(async () => { renderer = create(<Probe id="meeting-a" />); });
  await act(async () => {
    listener({ payload: { job_id: 'a', seq: 2, kind: 'delta', request_id: 'r1', text: '正文' } });
    readers.shift()!(state());
  });
  expect(current?.current?.draft).toBe('开始正文');
});
test('switching meetings ignores a stale snapshot and unsubscribes the old listener', async () => {
  await act(async () => { renderer = create(<Probe id="meeting-a" />); });
  const old = readers.shift()!;
  await act(async () => renderer.update(<Probe id="meeting-b" />));
  await act(async () => { readers.shift()!(state('b')); old(state('a')); });
  expect(current?.job_id).toBe('b'); expect(unlistened).toBeGreaterThan(0);
  await act(async () => listener({ payload: { job_id: 'a', seq: 99, kind: 'snapshot', current: { draft: '旧会' } } }));
  expect(current?.job_id).toBe('b');
});
test('unchanged snapshots keep polling with the latest event cursor and repair missed deltas', async () => {
  await act(async () => { renderer = create(<Probe id="meeting-a" />); });
  expect(requests[0].known).toBeNull();
  await act(async () => readers.shift()!(state()));
  await act(async () => listener({ payload: { job_id: 'a', seq: 2, kind: 'delta', request_id: 'r1', text: '正文' } }));
  await act(async () => new Promise(resolve => setTimeout(resolve, 2100)));
  expect(requests[1].known).toEqual({ job_id: 'a', seq: 2, phase: 'recording_note' });
  await act(async () => readers.shift()!(null));
  expect(current?.current?.draft).toBe('开始正文');
  await act(async () => listener({ payload: { job_id: 'a', seq: 4, kind: 'delta', request_id: 'r1', text: '遗漏前文' } }));
  await act(async () => new Promise(resolve => setTimeout(resolve, 2100)));
  expect(requests[2].known.seq).toBe(2);
  await act(async () => readers.shift()!({ ...state('a', 4), current: { request_id: 'r1', stage: 'recording_note', draft: '完整正文' } }));
  expect(current?.current?.draft).toBe('完整正文');
}, 10000);


test('regeneration reloads a new job after the previous job completed', async () => {
  await act(async () => { renderer = create(<Probe id="meeting-a" />); });
  await act(async () => readers.shift()!({ ...state(), phase: 'completed' }));
  await act(async () => renderer.update(<Probe id="meeting-a" revision={1} />));
  expect(requests.at(-1).known).toBeNull();
  await act(async () => readers.shift()!(state('new-job')));
  expect(current?.job_id).toBe('new-job');
  await act(async () => listener({ payload: { job_id: 'a', seq: 99, kind: 'snapshot', phase: 'completed' } }));
  expect(current?.job_id).toBe('new-job');
});
