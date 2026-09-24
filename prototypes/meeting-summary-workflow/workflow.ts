// Experimental fixed workflow: one model call per complete batch, then an atomic patch.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { patchFacts, renderFacts } from './facts';
import { parseWorkflowSubmission } from './workflow-submissions';
import { selectRelevantFacts } from './relevant-memory';
import profiles from './model-profiles.json';

const [fixturePath, out, mode = 'batch-facts', durationArg = '0', drainArg = '120'] = process.argv.slice(2);
if (!fixturePath || !out || mode !== 'batch-facts') throw new Error('workflow <fixture.json> <new-output-dir> batch-facts [duration-seconds] [drain-seconds]');
const modelProfile = process.env.MODEL_PROFILE || 'qwen4-off';
const profile = profiles[modelProfile];
if (!profile) throw new Error('Unknown model profile: ' + modelProfile);
const all = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const duration = Number(durationArg) || all.at(-1).end, drain = Number(drainArg);
if (!(duration > 0) || !(drain > 0)) throw new Error('Duration and drain must be positive');
const fixture = all.filter(r => r.end <= duration);
fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(path.join(out, 'events.jsonl'))) throw new Error('Output directory already contains a run');
const t0 = performance.now(), now = () => (performance.now() - t0) / 1000;
const log = (type, data = {}) => fs.appendFileSync(path.join(out, 'events.jsonl'), JSON.stringify({ t: now(), type, ...data }) + '\n');
const write = (name, data) => fs.writeFileSync(path.join(out, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
const rows = [], queue = [], awaitingPublication = [];
const attempted = new Set(), submittedRows = new Set();
let factStore = { nextId: 1, facts: [] };
let active = null, worker = null, controller = null, inputStopped = false, deadlineHit = false;
let maximumQueue = 0, arrivalWithBacklog = 0, calls = 0, failures = 0, textSubmissions = 0;
const unsaved = (subset = rows) => subset.filter(r => !submittedRows.has(r.id)).map(r => r.id);
const rowText = r => `[${r.id}] ${r.start.toFixed(2)}–${r.end.toFixed(2)}s 说话人${r.speakers.join('/') || '未知'}${r.uncertain ? '(待核对)' : ''}：${r.text}`;
const persist = () => {
  write('facts.json', factStore); write('minutes.md', renderFacts(factStore));
  write('processing.json', rows.map(r => ({ id: r.id, submitted: submittedRows.has(r.id), semanticQualityVerified: false })));
};
// Factuality instructions unchanged; new records and explicit revisions have separate scopes.
import { systemPrompt } from '../../frontend/src-tauri/resources/summary-workflow/prompt.mjs';
const base = (process.env.MODEL_URL || 'http://127.0.0.1:18791/v1').replace(/\/v1\/?$/, '');
async function post(endpoint, body, signal) {
  const response = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!response.ok) throw new Error(endpoint + ': HTTP ' + response.status);
  return response.json();
}
async function runRound(batch) {
  active = batch; controller = new AbortController();
  const start = now(); let submitted = false;
  log('round_start', { ids: batch.map(r => r.id), queue: queue.length });
  const first = rows.findIndex(r => r.id === batch[0].id), previous = rows.slice(Math.max(0, first - 2), first);
  const recent = selectRelevantFacts(factStore.facts, batch);
  log('memory_selected', { strategy: 'lexical-current-batch', totalFacts: factStore.facts.length, ids: recent.map(f => f.id) });
  const prompt = `已有${factStore.facts.length}条待核对草稿；未改的自动保留。\n` +
    (recent.length ? '相关旧条目候选（不变的不输出）：\n' + recent.map(f => `${f.id} [${f.section}] ${f.text}`).join('\n') + '\n' : '') +
    (previous.length ? '前文衔接（不属于本批新增范围）：\n' + previous.map(rowText).join('\n') + '\n' : '') +
    '本批新增完整原文：\n' + batch.map(rowText).join('\n');
  const payload = { model: profile.id, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: [{ type: 'text', text: prompt }] }],
    stream: false, max_tokens: profile.maxTokens, ...profile.sampling, seed: 42, chat_template_kwargs: { enable_thinking: profile.thinking } };
  try {
    const rendered = await post('/apply-template', payload, controller.signal);
    const encoded = await post('/tokenize', { content: rendered.prompt, add_special: profile.addSpecialTokens || false, parse_special: true }, controller.signal);
    const promptTokens = encoded.tokens.length;
    log('token_budget', { promptTokens, maxOutputTokens: payload.max_tokens, context: 6144 });
    if (promptTokens + payload.max_tokens > 6144) throw new Error(`Context exceeds 6144: ${promptTokens} + ${payload.max_tokens}`);
    calls++; log('request', { round: batch.map(r => r.id), payload });
    const response = await post('/v1/chat/completions', payload, controller.signal);
    log('response', { response, renderedPrompt: rendered.prompt });
    if (deadlineHit) throw new Error('Response arrived after deadline');
    if (response.usage.prompt_tokens !== promptTokens) throw new Error('Tokenizer/usage mismatch');
    const choice = response.choices[0];
    if (choice.finish_reason !== 'stop' || choice.message.tool_calls?.length) throw new Error('Incomplete or unexpected tool response: ' + choice.finish_reason);
    const { patch, ...submission } = parseWorkflowSubmission(choice.message.content || '', new Set(recent.map(f => f.id)));
    log('submission_normalized', submission);
    const next = patchFacts(factStore, patch, batch);
    log('fact_patch', { patch, before: factStore, after: next });
    factStore = next; batch.forEach(r => submittedRows.add(r.id)); submitted = true; textSubmissions++; persist();
    log('saved', { markdown: renderFacts(factStore), facts: factStore.facts.length });
  } catch (error) {
    failures++; log('error', { message: String(error), ids: batch.map(r => r.id) });
  }
  batch.forEach(r => attempted.add(r.id));
  log('round_end', { ids: batch.map(r => r.id), elapsed: now() - start, submitted, failed: !submitted,
    unsavedRows: unsaved(batch), semanticQualityVerified: false, queue: queue.length });
  persist(); active = null; controller = null;
}
function wake() {
  if (worker || deadlineHit) return;
  worker = (async () => { while (queue.length && !deadlineHit) await runRound(queue.shift()); })()
    .finally(() => { worker = null; if (queue.length && !deadlineHit) wake(); });
}
function publish() {
  if (!awaitingPublication.length) return;
  const batch = awaitingPublication.splice(0); queue.push(batch); maximumQueue = Math.max(maximumQueue, queue.length);
  log('batch_published', { ids: batch.map(r => r.id) }); wake();
}
function arrive(row) {
  const r = { ...row, arrived: now() }; rows.push(r); awaitingPublication.push(r);
  fs.appendFileSync(path.join(out, 'meeting.jsonl'), JSON.stringify(r) + '\n');
  if (queue.length || active) arrivalWithBacklog++;
  log('arrival', { id: r.id, audioEnd: r.end, busy: !!active });
  if (r.end >= (r.ready_at ?? r.end)) publish();
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
write('config.json', { fixturePath, mode: 'fixed-workflow', duration, drain, modelProfile, profile, systemPrompt,
  replay: '1x text arrival at audio_end, precomputed speaker labels; excludes ASR/C1 latency',
  maxCallsPerBatch: 1, maxQueriesPerBatch: 0, overlapRows: 2, relatedDraftLimit: 4, memoryStrategy: 'lexical-current-batch',
  finalModelReview: false, requiresCitations: false, semanticCoverageMeasured: false });
persist();
const statusTimer = setInterval(() => write('status.json', { elapsed: now(), arrived: rows.length, attempted: attempted.size,
  unsavedRows: unsaved().length, queuedBatches: queue.length, active: active?.map(r => r.id), calls, failures, inputStopped }), 15000);
for (const row of fixture) { await sleep(Math.max(0, (row.end - now()) * 1000)); arrive(row); }
await sleep(Math.max(0, (duration - now()) * 1000)); inputStopped = true; publish();
const stopStats = { t: now(), arrived: rows.length, attempted: attempted.size, unsavedRows: unsaved().length,
  queuedBatches: queue.length, pendingProcessing: rows.length - attempted.size };
log('input_stopped', stopStats);
const guard = setTimeout(() => { deadlineHit = true; controller?.abort(); log('drain_deadline', {}); }, drain * 1000);
while (worker) await worker;
clearTimeout(guard); clearInterval(statusTimer); persist();
const metrics = { mode: 'fixed-workflow', duration, wallSeconds: now(), arrived: rows.length, attempted: attempted.size,
  pendingProcessingAtStop: stopStats.pendingProcessing, backlogAtStopFraction: stopStats.unsavedRows / rows.length,
  unsavedAtStop: stopStats.unsavedRows, maxQueuedBatches: maximumQueue, arrivalWhileBusyFraction: arrivalWithBacklog / rows.length,
  settledSecondsAfterStop: deadlineHit ? null : now() - stopStats.t, drainSecondsObserved: now() - stopStats.t,
  drainDeadlineHit: deadlineHit, calls, toolCalls: 0, failures, textSubmissions, semanticCoverageMeasured: false,
  submittedRows: submittedRows.size, unsavedRows: unsaved(), unattempted: rows.filter(r => !attempted.has(r.id)).map(r => r.id),
  status: deadlineHit ? 'deadline' : 'needs_semantic_review', finalModelReview: false, nodePeakRssMiB: process.resourceUsage().maxRSS / 1024 };
write('metrics.json', metrics); write('status.json', metrics); console.log(JSON.stringify(metrics));
