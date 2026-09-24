// Exercise the actual fixed queue, HTTP boundary and atomic store without model cost.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-workflow-'));
const requests = [];
const answers = ['## 行动\n- 小林负责周报，周五交。', '## 修订\n- F0001：小林负责周报，周一交。',
  '## 行动\n- 不应部分写入\n## 修订\n- F9999：错误编号', '## 行动\n- 截断不能保存', '## 讨论\n- 最后一批内容'];
let slow = false, concurrent = 0, peak = 0;
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  if (req.url === '/apply-template') { res.end(JSON.stringify({ prompt: 'fake' })); return; }
  if (req.url === '/tokenize') { res.end(JSON.stringify({ tokens: [1, 2, 3] })); return; }
  assert.equal(req.url, '/v1/chat/completions'); requests.push(payload);
  peak = Math.max(peak, ++concurrent); const index = requests.length - 1;
  await new Promise(resolve => setTimeout(resolve, slow ? 300 : 35)); concurrent--;
  res.end(JSON.stringify({ choices: [{ finish_reason: index === 3 ? 'length' : 'stop', message: { role: 'assistant', content: answers[index] || '## 讨论\n- 迟到回复' } }],
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function run(name, fixture, drain) {
  const file = path.join(scratch, name + '.json'), out = path.join(scratch, name);
  fs.writeFileSync(file, JSON.stringify(fixture));
  const child = spawn(process.execPath, ['workflow.mjs', file, out, 'batch-facts', String(fixture.at(-1).end), String(drain)],
    { env: { ...process.env, MODEL_PROFILE: 'qwen4-off', MODEL_URL: `http://127.0.0.1:${server.address().port}/v1` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0, output);
  return { metrics: JSON.parse(fs.readFileSync(path.join(out, 'metrics.json'), 'utf8')),
    facts: JSON.parse(fs.readFileSync(path.join(out, 'facts.json'), 'utf8')),
    events: fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
}
try {
  const fixture = [1, 2, 3, 4, 5].map(n => ({ id: 'S000' + n, start: (n - 1) / 100, end: n / 100,
    ready_at: n / 100, speakers: [1], text: n <= 2 ? '小林周报交付' : '会议内容' + n }));
  const result = await run('normal', fixture, 5);
  assert.equal(peak, 1); assert.equal(requests.length, 5);
  assert.ok(requests.every(p => !('tools' in p) && !('tool_choice' in p) && p.stream === false));
  assert.ok(JSON.stringify(requests[1].messages).includes('F0001 [行动] 小林负责周报，周五交。'));
  assert.ok(!JSON.stringify(requests[0].messages).includes('S0002'));
  assert.equal(result.metrics.calls, 5); assert.equal(result.metrics.toolCalls, 0);
  assert.equal(result.metrics.textSubmissions, 3); assert.equal(result.metrics.failures, 2);
  assert.equal(result.metrics.unsavedAtStop, 5); assert.deepEqual(result.metrics.unsavedRows, ['S0003', 'S0004']);
  assert.equal(result.metrics.submittedRows, 3); assert.equal(result.metrics.semanticCoverageMeasured, false);
  assert.deepEqual(result.facts.facts.map(f => f.text), ['小林负责周报，周一交。', '最后一批内容']);
  assert.equal(result.events.filter(e => e.type === 'round_end').length, 5);
  requests.length = 0;
  const spaced = fixture.map((row, i) => ({ ...row, start: i * .12, end: (i + 1) * .12, ready_at: (i + 1) * .12 }));
  const failedBeforeStop = await run('failed-before-stop', spaced, 5);
  assert.equal(failedBeforeStop.metrics.pendingProcessingAtStop, 1);
  assert.equal(failedBeforeStop.metrics.unsavedAtStop, 3);
  assert.equal(failedBeforeStop.metrics.backlogAtStopFraction, 3 / 5, 'Failed batches must remain in the unsubmitted backlog');
  slow = true;
  const deadline = await run('deadline', [fixture[0]], .1);
  assert.equal(deadline.metrics.drainDeadlineHit, true); assert.equal(deadline.metrics.submittedRows, 0);
  assert.equal(deadline.facts.facts.length, 0); assert.equal(requests.length, 6);
  console.log('PASS: one serial request per batch, no tools/retries/future text; relevant old fact revised; invalid/truncated batch rolled back; later batches continue; deadline abort never saves.');
} finally { server.closeAllConnections(); server.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
