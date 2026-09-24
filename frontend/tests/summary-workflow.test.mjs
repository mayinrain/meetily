import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { planChunk, slices, formatSources, splitMaterial, reduceSection } from '../src-tauri/resources/summary-workflow/sections.mjs';
import { createGenerator } from '../src-tauri/resources/summary-workflow/generation.mjs';
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
async function harness(t, outputs, delay = 0, tokenCount = () => 2) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-workflow-'));
  const requests = []; let active = 0, maximum = 0, stops = 0;
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/apply-template') return res.end(JSON.stringify({ prompt: JSON.stringify(body.messages) }));
    if (req.url === '/tokenize') return res.end(JSON.stringify({ tokens: Array(tokenCount(body.content)).fill(1) }));
    requests.push(body); active++; maximum = Math.max(maximum, active);
    const output = typeof outputs === 'function' ? outputs(body, requests.length) : outputs[requests.length - 1];
    await sleep(delay); active--;
    res.end(JSON.stringify({ usage: { prompt_tokens: tokenCount(JSON.stringify(body.messages)) }, choices: [{ finish_reason: output?.finish || 'stop',
      message: { content: output?.text || '## 内容概览\n讨论会议安排。' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true }); });
  const modelFactory = async () => ({ base: `http://127.0.0.1:${server.address().port}`, stop: async () => { stops++; } });
  const send = value => writeJson(path.join(directory, 'input.json'), value);
  const state = () => JSON.parse(fs.readFileSync(path.join(directory, 'state.json')));
  const run = options => runLive(directory, { modelFactory, pollMs: 10,
    freeMemory: () => 2 ** 32, ...options });
  return { directory, requests, run, send, state, base: `http://127.0.0.1:${server.address().port}`,
    maximum: () => maximum, stops: () => stops };
}

test('slow non-streaming generation is governed by the application deadline', async t => {
  const h = await harness(t, [{ text: note() }], 2000);
  // Accelerate HTTP-client timers; the server delay and AbortSignal deadline stay real.
  // This reproduces fetch's independent 300-second headers timeout in under two seconds.
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => realSetTimeout(fn, Math.min(ms, 1), ...args));
  const signal = AbortSignal.timeout(600000);
  const generator = createGenerator({ base: h.base, directory: h.directory, writeJson, log: () => {}, signal });
  assert.equal(await generator.generate('recording_note', '整理会议', '讨论住宿', 1280), note());
  assert.equal(signal.aborted, false);
});


const note = (label = '本段') => `## 内容概览\n${label}讨论预算和推进安排。\n## 主要讨论\n- ${label}提出先试点再扩展。\n## 结论\n未提及\n## 明确待办\n- [ ] 提供报价。\n## 未决问题\n- 预算待确认。`;
const long = label => `${label}预算为两万元，先试点再扩展。`.repeat(85);

test('character chunks preserve full sentences, readable labels, offsets and overlap', () => {
  const rows = [{ id: 'a', text: '甲'.repeat(1194) + '预算3.5万元。尾句完整。', speakers: [1] }];
  const first = planChunk(rows, 0);
  assert.ok(first.material.endsWith('预算3.5万元。'));
  assert.equal(first.buffer, '');
  assert.equal(first.end, rows[0].text.indexOf('尾句'));
  assert.equal(slices(rows, first.end).map(r => r.text).join(''), '尾句完整。');
  const expanded = [...rows, { id: 'b', text: long('乙'), speakers: [2] }];
  const second = planChunk(expanded, first.end);
  assert.equal(second.buffer, formatSources(slices(expanded, first.end - 300, first.end)));
  assert.match(second.material, /尾句完整/);
  assert.equal(planChunk([{ text: '短会。', speakers: [1] }], 0), null);
  const unpunctuated = [{ text: '甲'.repeat(1300), speakers: [1] }];
  assert.equal(planChunk(unpunctuated, 0).end, 1300);
});

test('20-second meetings use complete source directly, not an empty incremental fact patch', async t => {
  const h = await harness(t, [{ text: note() }]);
  const source = row('short', '扩建住房，新增人员需要住宿。'); source.speaker_ids = [1, 2]; source.needs_review = true;
  h.send(snapshot([batch(0, [source])], true));
  const state = await h.run();
  assert.equal(state.status, 'ready'); assert.equal(state.route, 'direct'); assert.equal(state.final_report_complete, true);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].max_tokens, 1800);
  assert.match(h.requests[0].messages[1].content[0].text, /待确认：扩建住房/);
  assert.equal(state.unsaved_segments, 0); assert.equal(state.completed_batches, 1); assert.equal(h.stops(), 1);
  assert.equal(state.within_post_stop_target, true);
});

test('one saved note still finalizes from the whole transcript, not that note', async t => {
  const h = await harness(t, [{ text: note('会中') }, { text: note('会后') }]);
  const first = batch(0, [row('a', long('甲'))]);
  h.send(snapshot([first])); const running = h.run();
  await until(() => h.state().notes.length === 1);
  h.send(snapshot([first], true));
  const state = await running;
  assert.equal(state.route, 'direct'); assert.equal(state.status, 'ready');
  assert.match(h.requests.at(-1).messages[1].content[0].text, /甲预算为两万元/);
  assert.doesNotMatch(h.requests.at(-1).messages[1].content[0].text, /会中讨论/);
});

test('two notes close by combining same-name sections, preserving a final tail and serial calls', async t => {
  const h = await harness(t, body => ({ text: body.messages[0].content.startsWith('你整理')
    ? '该章整合了全部材料。' : note('分段') }), 20);
  const first = batch(0, [row('a', long('甲'))]);
  h.send(snapshot([first])); const running = h.run();
  await until(() => h.state().notes.length === 1);
  const second = batch(1, [row('b', long('乙'), 20, 40)]);
  h.send(snapshot([first, second]));
  await until(() => h.state().notes.length >= 2);
  const tail = batch(2, [row('c', '最后新增预算审批事项。', 40, 45)]);
  h.send(snapshot([first, second, tail], true));
  const state = await running;
  assert.equal(state.status, 'ready'); assert.equal(state.route, 'section_wise');
  assert.equal(state.completed_batches, 3); assert.equal(state.unsaved_segments, 0);
  assert.equal(h.maximum(), 1); assert.equal(h.stops(), 1);
  assert.ok(h.requests.some(r => r.max_tokens === 1280 && r.messages[1].content[0].text.includes('最后新增预算审批事项')));
  const sectionCalls = h.requests.filter(r => r.max_tokens === 2048);
  assert.equal(sectionCalls.length, 4); // Empty conclusion needs no model call.
  assert.ok(sectionCalls[1].messages[1].content[0].text.match(/先试点再扩展/g).length >= 2);
  assert.equal(h.requests.at(-1).max_tokens, 2048); // No additional whole-report rewrite.
  assert.match(state.markdown, /## 结论\n未提及/);
});

test('stop cancels a pending note, keeps its cursor unchanged and hands complete text to finalization', async t => {
  const h = await harness(t, [{ text: note('不得提交') }, { text: note('最终') }], 150);
  const first = batch(0, [row('a', long('甲'))]);
  h.send(snapshot([first])); const running = h.run();
  await until(() => h.requests.length === 1);
  h.send(snapshot([first], true));
  const state = await running;
  assert.equal(state.status, 'ready'); assert.equal(state.notes.length, 0); assert.equal(state.route, 'direct');
  assert.match(h.requests[1].messages[1].content[0].text, /甲预算/);
  assert.doesNotMatch(state.markdown, /不得提交/);
  const checkpoints = fs.readdirSync(path.join(h.directory, 'calls')).map(f => JSON.parse(fs.readFileSync(path.join(h.directory, 'calls', f))));
  assert.ok(checkpoints.some(c => c.status === 'cancelled'));
});

test('a truncated recording note does not consume source; final full-source generation can recover it', async t => {
  const h = await harness(t, [{ text: note('半截'), finish: 'length' }, { text: note('恢复') }]);
  const first = batch(0, [row('a', long('甲'))]);
  h.send(snapshot([first])); const running = h.run();
  await until(() => h.state().recording_note_failures === 1);
  assert.equal(h.state().cursor, 0); assert.equal(h.state().notes.length, 0);
  h.send(snapshot([first], true));
  const state = await running;
  assert.equal(state.status, 'ready'); assert.match(state.markdown, /恢复/); assert.doesNotMatch(state.markdown, /半截/);
});

test('a final generation failure preserves raw sources and never labels a partial report complete', async t => {
  const h = await harness(t, [{ text: note(), finish: 'length' }]);
  h.send(snapshot([batch(0, [row('a', '必须保存的原文。')])], true));
  const state = await h.run();
  assert.equal(state.status, 'failed'); assert.equal(state.final_report_complete, false);
  assert.equal(state.source_segments[0].text, '必须保存的原文。'); assert.equal(state.within_post_stop_target, false);
});

test('long chapters that fit context are split before output truncation, with every sentence preserved', async t => {
  const discussion = '- 住房补贴方案仍待讨论。\n'.repeat(90);
  const material = text => text.split('<该章节的全部分片材料>\n')[1]?.split('\n</该章节的全部分片材料>')[0];
  const h = await harness(t, body => {
    const source = material(body.messages[1].content[0].text);
    if (source !== undefined) return { text: source.length > 1600 ? '被截断的前半章' : source,
      finish: source.length > 1600 ? 'length' : 'stop' };
    return { text: `## 主要讨论\n${discussion}` };
  }, 0, text => Array.from(text).length);
  const first = batch(0, [row('a', '甲'.repeat(1300) + '。')]);
  const second = batch(1, [row('b', '乙'.repeat(1300) + '。', 20, 40)]);
  h.send(snapshot([first])); const running = h.run();
  await until(() => h.state().notes.length === 1);
  h.send(snapshot([first, second]));
  await until(() => h.state().notes.length === 2);
  h.send(snapshot([first, second], true));
  const state = await running;
  assert.equal(state.status, 'ready');
  assert.equal(state.final_report_complete, true);
  assert.equal(state.markdown.match(/住房补贴方案仍待讨论。/g).length, 180);
  assert.doesNotMatch(state.markdown, /被截断/);
  const calls = h.requests.filter(r => material(r.messages[1].content[0].text) !== undefined);
  assert.ok(calls.length > 1);
  assert.equal(calls.map(r => material(r.messages[1].content[0].text)).join(''), state.notes.map(n => n.content.split('## 主要讨论\n')[1].trim()).join('\n\n'));
  assert.equal(h.maximum(), 1);
});

test('backlog includes text awaiting speaker labels and clears only after final sources arrive', async t => {
  const h = await harness(t, [{ text: note() }]);
  const first = batch(0, [row('a', '讨论住房。')]), tail = batch(1, [row('b', '尾部安排。', 20, 25)]);
  const early = snapshot([first]); early.transcript_segments = [first.segments[0], tail.segments[0]];
  early.recording_stopped_at = Date.now(); h.send(early);
  const running = h.run();
  await until(() => h.state().observed_segments === 2);
  assert.equal(h.state().unsaved_segments, 2); assert.equal(h.requests.length, 0);
  assert.equal(h.state().unsaved_segments_at_stop, 2);
  h.send(snapshot([first, tail], true));
  const state = await running;
  assert.equal(state.status, 'ready'); assert.equal(state.unsaved_segments, 0);
});

test('hard stop deadline, cancellation and memory pressure release the owned model', async t => {
  for (const mode of ['deadline', 'cancel', 'memory']) {
    const h = await harness(t, [{ text: note('不得提交') }], 200);
    h.send(snapshot([batch(0, [row('a', mode === 'deadline' ? '原始录音文本。' : long('甲'))])], mode === 'deadline'));
    let memory = 2 ** 32;
    const running = h.run({ drainMs: mode === 'deadline' ? 100 : 1200000, freeMemory: () => memory });
    await until(() => h.requests.length === 1);
    if (mode === 'cancel') fs.writeFileSync(path.join(h.directory, 'cancel'), 'cancel');
    if (mode === 'memory') memory = 100;
    const state = await running;
    assert.equal(state.status, 'failed'); assert.equal(state.final_report_complete, false); assert.equal(h.stops(), 1);
  }
});

test('successful identical generations reuse persisted checkpoints without another model call', async t => {
  const h = await harness(t, [{ text: note() }]);
  // The harness model base is available through a temporary one-request live run.
  h.send(snapshot([batch(0, [row('a', '短会。')])], true));
  await h.run();
  const file = fs.readdirSync(path.join(h.directory, 'calls'))[0];
  const saved = JSON.parse(fs.readFileSync(path.join(h.directory, 'calls', file)));
  const generator = createGenerator({ base: 'http://127.0.0.1:1', directory: h.directory,
    writeJson, log: () => {}, signal: new AbortController().signal });
  const result = await generator.generate(saved.stage, saved.request.messages[0].content,
    saved.request.messages[1].content[0].text, saved.request.max_tokens);
  assert.equal(result, saved.content); assert.equal(h.requests.length, 1);
});

test('oversized material is split without loss and only the affected chapter is reduced', async () => {
  const text = '预算😀是三万元。实施后再复核。'.repeat(20);
  const parts = await splitMaterial(text, async s => Array.from(s).length <= 55);
  assert.equal(parts.join(''), text); assert.ok(parts.every(s => !/[\uD800-\uDBFF]$/.test(s)));
  const result = await reduceSection(text, async s => s.length <= 80, async s => s);
  assert.ok(result.replace(/\n/g, '').includes('实施后再复核'));
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
