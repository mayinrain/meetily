import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
const core = { ...await import('@tauri-apps/api/core') };
let stored = 'intranet', fail = false;
const invoke = mock(async (command: string, args?: { model: string }) => {
  if (command === 'get_summary_model') return stored;
  if (fail) throw new Error('write failed');
  stored = args!.model;
});
const installMock = () => mock.module('@tauri-apps/api/core', () => ({ ...core, invoke }));
installMock();
beforeEach(installMock);
afterAll(() => mock.module('@tauri-apps/api/core', () => core));
const { default: Settings } = await import('../../src/app/settings/page');
let renderer: ReactTestRenderer;
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); fail = false; });
test('loads saved choice and saves exactly the chosen summary model', async () => {
  await act(async () => { renderer = create(<Settings />); });
  const radios = () => renderer.root.findAllByType('input');
  expect(radios().length).toBe(2);
  expect(radios().find(r => r.props.value === 'intranet')!.props.checked).toBe(true);
  await act(async () => { await radios().find(r => r.props.value === 'builtin')!.props.onChange(); });
  expect(stored).toBe('builtin');
  expect(JSON.stringify(renderer.toJSON())).toContain('Qwen3.5-35B-A3B');
  expect(JSON.stringify(renderer.toJSON())).toContain('Qwen3-1.7B');
  expect(invoke).toHaveBeenCalledWith('set_summary_model', { model: 'builtin' });
});
test('failed save keeps last persisted selection and shows Chinese error', async () => {
  stored = 'builtin'; fail = true;
  await act(async () => { renderer = create(<Settings />); });
  await act(async () => { await renderer.root.findAllByType('input').find(r => r.props.value === 'intranet')!.props.onChange(); });
  expect(renderer.root.findAllByType('input').find(r => r.props.value === 'builtin')!.props.checked).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain('保存失败，请重试');
});
