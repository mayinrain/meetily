import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGenerator, visibleBody } from '../src-tauri/resources/summary-workflow/generation.mjs';
import { ranges, joinMaterials, materialRanges, createProgress } from '../src-tauri/resources/summary-workflow/progress.mjs';
import { writeJson } from '../src-tauri/resources/summary-workflow/live.mjs';

async function streamServer(t, serve) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-stream-'));
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/apply-template') return res.end(JSON.stringify({ prompt: '会议原文' }));
    if (req.url === '/tokenize') return res.end(JSON.stringify({ tokens: [1, 2] }));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    await serve(res, body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(directory, { force: true, recursive: true }); });
  return { directory, base: `http://127.0.0.1:${server.address().port}`, writeJson, log: () => {}, signal: AbortSignal.timeout(5000) };
}
const frame = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\r\n\r\n`;
const delta = content => frame({ choices: [{ delta: { content } }] });
const final = (finish = 'stop') => frame({ choices: [{ finish_reason: finish }], usage: { prompt_tokens: 2, completion_tokens: 8 } });

test('real UTF-8 byte fragments arrive before completion, without exposing split thinking tags', async t => {
  let finished = false, early = false;
  const outputs = [];
  const options = await streamServer(t, async res => {
    const chunks = ['<thi', 'nk>内部推理', '</think>', '讨论住宿', '与扩员。😀'];
    for (const text of chunks) {
      for (const byte of Buffer.from(delta(text))) res.write(Buffer.from([byte]));
      await sleep(15);
    }
    finished = true; res.end(final() + frame('[DONE]'));
  });
  const generator = createGenerator({ ...options, onText: text => { outputs.push(text); if (text) early ||= !finished; } });
  assert.equal(await generator.generate('direct_final', '系统', '原文', 1800), '讨论住宿与扩员。😀');
  assert.ok(early); assert.ok(outputs.every(text => !text.includes('推理') && !text.includes('<')));
  assert.equal(visibleBody('正文<think>未结束思考', true), '正文');
});

for (const failure of ['truncated', 'length', 'error', 'usage']) test(`stream ${failure} cannot commit successful output`, async t => {
  const options = await streamServer(t, async res => {
    res.write(delta('半段正文'));
    if (failure === 'truncated') res.end();
    if (failure === 'length') res.end(final('length') + frame('[DONE]'));
    if (failure === 'error') res.end(frame({ error: '生成失败' }));
    if (failure === 'usage') res.end(frame({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 999 } }) + frame('[DONE]'));
  });
  await assert.rejects(createGenerator(options).generate('recording_note', '系统', '原文', 1280));
  const calls = fs.readdirSync(path.join(options.directory, 'calls')).map(file => JSON.parse(fs.readFileSync(path.join(options.directory, 'calls', file))));
  assert.equal(calls.length, 1); assert.equal(calls[0].status, 'failed');
});

test('abort after a visible fragment preserves cancellation and never commits a note', async t => {
  const abort = new AbortController();
  const options = await streamServer(t, async res => { res.write(delta('正在生成')); await sleep(100); res.end(final() + frame('[DONE]')); });
  const generator = createGenerator({ ...options, signal: abort.signal, onText: () => abort.abort() });
  await assert.rejects(generator.generate('recording_note', '系统', '原文', 1280));
  const file = fs.readdirSync(path.join(options.directory, 'calls'))[0];
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.directory, 'calls', file))).status, 'cancelled');
});

test('provenance keeps source gaps and maps split material to covering ASR rows', () => {
  assert.deepEqual(ranges([{ start: 10, end: 20 }, { start: 100, end: 120 }, { start: 15, end: 25 }]), [{ start: 10, end: 25 }, { start: 100, end: 120 }]);
  const material = joinMaterials([{ text: '甲的句子', ranges: [{ start: 10, end: 20 }] }, { text: '乙的句子', ranges: [{ start: 100, end: 120 }] }]);
  assert.deepEqual(materialRanges(material, 2, 3), [{ start: 10, end: 20 }]);
  assert.deepEqual(materialRanges(material, 3, 8), [{ start: 10, end: 20 }, { start: 100, end: 120 }]);
});

test('text events are throttled, sequenced and flushed before state transitions', async () => {
  const events = [], writes = [];
  const progress = createProgress('/unused', (file, value) => writes.push(JSON.parse(JSON.stringify(value))), value => events.push(JSON.parse(JSON.stringify(value))));
  try {
    progress.update({ phase: 'recording_note', current: { request_id: '1', draft: '' } });
    for (let i = 1; i <= 100; i++) progress.text('文'.repeat(i));
    assert.equal(events.length, 1);
    await sleep(340);
    assert.equal(events.length, 2); assert.equal(events[1].text.length, 100);
    progress.text('文'.repeat(101)); progress.update({ current: null, phase: 'collecting' });
    assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4]);
    assert.equal(events[2].text, '文'); assert.equal(events[3].current, null);
    assert.equal(writes.length, 2);
  } finally { progress.close(); }
});
