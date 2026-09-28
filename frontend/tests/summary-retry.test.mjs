import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createGenerator } from '../src-tauri/resources/summary-workflow/generation.mjs';
import { createProgress } from '../src-tauri/resources/summary-workflow/progress.mjs';
import { writeJson } from '../src-tauri/resources/summary-workflow/live.mjs';
const frame = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const delta = content => frame({ choices: [{ delta: { content } }] });
const success = (reason = 'stop', tokens = 2) => delta('完整新正文') + frame({ choices: [{ finish_reason: reason }], usage: { prompt_tokens: tokens } }) + frame('[DONE]');
async function setup(t, serve) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-retry-'));
  let attempts = 0, reconnects = 0;
  const retries = [], events = [];
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    if (req.url === '/apply-template') return res.end(JSON.stringify({ prompt: '原文' }));
    if (req.url === '/tokenize') return res.end(JSON.stringify({ tokens: [1, 2] }));
    serve(res, ++attempts);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const progress = createProgress(directory, writeJson, e => events.push(structuredClone(e)));
  progress.update({ phase: 'recording_note', current: { request_id: '1', draft: '' } });
  t.after(() => { progress.close(); server.closeAllConnections(); server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const abort = new AbortController();
  const options = { base: `http://127.0.0.1:${server.address().port}`, directory, writeJson, log: () => {}, signal: abort.signal,
    retries: 3, retryDelays: [1, 2, 3], reconnect: async () => { reconnects++; }, onText: text => progress.text(text),
    onRetry: value => { retries.push(value); progress.update({ phase: 'retrying', current: { request_id: String(value.attempt + 1), draft: '' } }); } };
  return { options, retries, events, abort, attempts: () => attempts, reconnects: () => reconnects,
    saved: () => fs.readdirSync(path.join(directory, 'calls')).map(f => JSON.parse(fs.readFileSync(path.join(directory, 'calls', f)))) };
}
for (const mode of ['503', '429', 'reset', 'truncated', 'timeout']) test(`${mode} retries whole generation and commits once`, async t => {
  const h = await setup(t, (res, number) => {
    if (number === 1 && ['503', '429'].includes(mode)) { res.writeHead(Number(mode)); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (number === 1) {
      res.write(delta('不能计入完成的半段'));
      if (mode === 'reset') return setTimeout(() => res.destroy(), 5);
      if (mode === 'truncated') return res.end();
      if (mode === 'timeout') return;
    }
    res.end(success());
  });
  assert.equal(await createGenerator({ ...h.options, attemptTimeoutMs: mode === 'timeout' ? 50 : 5000 }).generate('recording_note', '系统', '原文', 100), '完整新正文');
  assert.equal(h.attempts(), 2); assert.equal(h.reconnects(), 1); assert.equal(h.saved().length, 1);
  assert.equal(h.saved()[0].status, 'success'); assert.equal(h.saved()[0].content, '完整新正文');
  assert.ok(h.events.some(e => e.phase === 'retrying' && e.current.draft === '' && e.current.request_id === '2'));
});
test('retry exhaustion preserves failed checkpoint without content', async t => {
  const h = await setup(t, res => { res.writeHead(503); res.end(); });
  await assert.rejects(createGenerator(h.options).generate('section:结论', '系统', '原文', 100));
  assert.equal(h.attempts(), 4); assert.equal(h.retries.length, 3);
  assert.equal(h.saved()[0].status, 'failed'); assert.equal(h.saved()[0].content, undefined);
});
for (const mode of ['401', '400', 'length', 'usage']) test(`${mode} fails without retry`, async t => {
  const h = await setup(t, res => {
    if (['401', '400'].includes(mode)) { res.writeHead(Number(mode)); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(success(mode === 'length' ? 'length' : 'stop', mode === 'usage' ? 999 : 2));
  });
  await assert.rejects(createGenerator(h.options).generate('direct_final', '系统', '原文', 100));
  assert.equal(h.attempts(), 1); assert.equal(h.retries.length, 0);
});
test('cancel during backoff promptly stops further requests', async t => {
  const h = await setup(t, res => { res.writeHead(503); res.end(); });
  const generator = createGenerator({ ...h.options, retryDelays: [10000, 10000, 10000],
    onRetry: () => setTimeout(() => h.abort.abort(), 5) });
  const began = Date.now();
  await assert.rejects(generator.generate('tail_note', '系统', '原文', 100));
  assert.ok(Date.now() - began < 1000); assert.equal(h.attempts(), 1); assert.equal(h.saved()[0].status, 'cancelled');
});
