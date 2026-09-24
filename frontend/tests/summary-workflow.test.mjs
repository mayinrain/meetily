import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { runLive, validateSnapshot, writeJson } from '../src-tauri/resources/summary-workflow/live.mjs';

const row = (id, text, start = 0, end = 20) => ({ id, text, audio_start_time: start,
  audio_end_time: end, speaker_ids: [1], needs_review: false });
const batch = (batch_id, segments) => ({ batch_id, segments });
const snapshot = (batches, stopped = false) => ({ status: stopped ? 'completed' : 'running',
  ...(stopped ? { recording_stopped_at: Date.now() } : {}),
  result: { batches, source_segments: batches.flatMap(b => b.segments) } });
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await sleep(10); }
  throw new Error('Timed out');
}
async function harness(t, outputs, delay = 0) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-workflow-'));
  const requests = []; let active = 0, maximum = 0, stops = 0;
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/apply-template') return res.end(JSON.stringify({ prompt: 'rendered' }));
    if (req.url === '/tokenize') return res.end(JSON.stringify({ tokens: [1, 2] }));
    requests.push(body); active++; maximum = Math.max(maximum, active);
    const output = outputs[requests.length - 1];
    await sleep(delay); active--;
    res.end(JSON.stringify({ usage: { prompt_tokens: 2 }, choices: [{ finish_reason: output?.finish || 'stop',
      message: { content: output?.text || '无新增' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true }); });
  const modelFactory = async () => ({ base: `http://127.0.0.1:${server.address().port}`, stop: async () => { stops++; } });
  const send = value => writeJson(path.join(directory, 'input.json'), value);
  const state = () => JSON.parse(fs.readFileSync(path.join(directory, 'state.json')));
  const run = options => runLive(directory, { modelFactory, pollMs: 10,
    freeMemory: () => 2 ** 32, ...options });
  return { directory, requests, run, send, state, maximum: () => maximum, stops: () => stops };
}

test('live arrivals queue behind one request; revisions and tail persist without a final model rewrite', async t => {
  const h = await harness(t, [{ text: '## 行动\n- 小林周五提交周报。' },
    { text: '## 修订\n- 已有 F0001：小林改为下周一上午十点提交周报。' },
    { text: '## 待确认\n- 预算两万元待批准。' }], 70);
  const first = batch(0, [row('a', '小林周五提交周报。')]);
  h.send(snapshot([first])); const running = h.run();
  await until(() => h.requests.length === 1);
  const second = batch(1, [row('b', '周报改为下周一上午十点提交，小林负责。', 20, 40)]);
  const tail = batch(2, [row('c', '两万元预算还没有批准。', 40, 45)]);
  h.send(snapshot([first, second, tail], true));
  const state = await running;
  assert.equal(state.status, 'ready'); assert.equal(state.completed_batches, 3);
  assert.equal(h.maximum(), 1); assert.equal(h.stops(), 1); assert.equal(h.requests.length, 3);
  assert.equal(state.facts.facts.length, 2); assert.equal(state.facts.facts[0].id, 'F0001');
  assert.match(state.markdown, /下周一上午十点/); assert.doesNotMatch(state.markdown, /F0001|\[a\]|周五/);
  assert.ok(state.maximum_queued_batches >= 3); assert.equal(state.pending_batches, 0);
  const firstPrompt = h.requests[0].messages[1].content[0].text;
  assert.doesNotMatch(firstPrompt, /预算|下周一/);
  assert.match(h.requests[1].messages[1].content[0].text, /F0001/);
  assert.equal(h.state().markdown, state.markdown);
});

test('a 20-second meeting immediately flushes one uncertain-speaker batch', async t => {
  const h = await harness(t, [{ text: '## 讨论\n- 讨论住房方案。' }]);
  const source = row('short', '讨论住房方案。'); source.speaker_ids = [1, 2]; source.needs_review = true;
  h.send(snapshot([batch(0, [source])], true));
  const state = await h.run();
  assert.equal(state.status, 'ready'); assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].messages[1].content[0].text, /说话人1\/2\(待核对\)/);
  assert.equal(state.source_segments.length, 1);
});

test('failed atomic edit stays failed and visible while later batches still run', async t => {
  const h = await harness(t, [{ text: '## 讨论\n- 合法新增。\n## 修订\n- F0099：非法覆盖。' },
    { text: '## 行动\n- 小王提供报价。' }]);
  h.send(snapshot([batch(0, [row('a', '讨论预算。')]), batch(1, [row('b', '小王提供报价。', 20, 30)])], true));
  const state = await h.run();
  assert.equal(state.status, 'failed'); assert.equal(state.failed_batches, 1); assert.equal(state.pending_batches, 1);
  assert.equal(state.completed_batches, 1); assert.equal(h.requests.length, 2);
  assert.doesNotMatch(state.markdown, /合法新增|非法覆盖/); assert.match(state.markdown, /小王提供报价/);
});

test('backlog includes ASR rows still waiting for speaker labels', async t => {
  const h = await harness(t, [{ text: '无新增' }], 80);
  const first = batch(0, [row('a', '讨论住房。')]);
  const tail = batch(1, [row('b', '尾部安排。', 20, 25)]);
  const early = snapshot([first]);
  early.transcript_segments = [first.segments[0], tail.segments[0]];
  early.recording_stopped_at = Date.now();
  h.send(early); const running = h.run();
  await until(() => h.requests.length === 1);
  assert.equal(h.state().unsaved_segments_at_stop, 2);
  assert.equal(h.state().observed_segments, 2);
  h.send(snapshot([first, tail], true));
  const state = await running;
  assert.equal(state.unsaved_segments, 0);
  assert.equal(state.status, 'ready');
});

test('truncated output never commits a partial fact', async t => {
  const h = await harness(t, [{ text: '## 行动\n- 提交报告。', finish: 'length' }]);
  h.send(snapshot([batch(0, [row('a', '提交报告。')])], true));
  const state = await h.run();
  assert.equal(state.completed_batches, 0); assert.equal(state.facts.facts.length, 0);
  assert.equal(state.status, 'failed');
});

test('stop deadline aborts an in-flight request, preserves transcript and releases the model', async t => {
  const h = await harness(t, [{ text: '## 行动\n- 不得提交。' }], 200);
  h.send(snapshot([batch(0, [row('a', '原始录音文本。')])], true));
  const state = await h.run({ drainMs: 100 });
  assert.equal(state.status, 'failed'); assert.equal(state.facts.facts.length, 0);
  assert.equal(state.source_segments[0].text, '原始录音文本。'); assert.equal(h.stops(), 1);
});

test('cancel and memory pressure stop requests without committing late output', async t => {
  for (const mode of ['cancel', 'memory']) {
    const h = await harness(t, [{ text: '## 行动\n- 不得提交。' }], 200);
    h.send(snapshot([batch(0, [row('a', '完整原文。')])]));
    let memory = 2 ** 32;
    const running = h.run({ freeMemory: () => memory });
    await until(() => h.requests.length === 1);
    if (mode === 'cancel') fs.writeFileSync(path.join(h.directory, 'cancel'), 'cancel');
    else memory = 100;
    const state = await running;
    assert.equal(state.status, 'failed'); assert.equal(state.completed_batches, 0); assert.equal(h.stops(), 1);
  }
});

test('immutable speaker prefix, source coverage, duplicate IDs and changed labels are enforced', () => {
  const b = batch(0, [row('a', '原文。')]);
  assert.equal(validateSnapshot([], snapshot([b], true)).length, 1);
  assert.throws(() => validateSnapshot([b], snapshot([])), /changed/);
  const changed = structuredClone(b); changed.segments[0].speaker_ids = [2];
  assert.throws(() => validateSnapshot([b], snapshot([changed])), /changed/);
  assert.throws(() => validateSnapshot([], snapshot([b, batch(1, [row('a', '重复。')])])), /Duplicated/);
  const missing = snapshot([b], true); missing.result.source_segments.push(row('missing', '尾句。'));
  assert.throws(() => validateSnapshot([], missing), /cover/);
});
