// Replay actual failed replies through the storage boundary; no model or reference injection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseWorkflowSubmission } from './workflow-submissions';
import { patchFacts } from './facts';
import { selectRelevantFacts } from './relevant-memory';
const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/workflow-submissions.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/workflow-memory.json', import.meta.url), 'utf8'));
const batches = captured.rounds.map(round => fixture.filter(row => round.ids.includes(row.id)));
const replies = captured.rounds.map(round => round.reply);
let store = { nextId: 1, facts: [] }, submitted = 0;
const failures = [];
// First six legacy replies are pure additions. The last legacy reply uses the old
// ambiguous edit syntax: test its wording under the NEW explicit revision heading.
for (const [index, batch] of batches.entries()) {
  const visible = new Set(selectRelevantFacts(store.facts, batch).map(f => f.id));
  const text = index === 6 ? replies[index].replace('## 行动', '## 修订') : replies[index];
  try { store = patchFacts(store, parseWorkflowSubmission(text, visible).patch, batch); submitted++; }
  catch (error) { failures.push({ batch: index + 1, error: String(error) }); }
}
console.log(JSON.stringify({ submitted, failures }));
assert.equal(submitted, 7, 'Captured additions and an explicit revision must save without changing factual wording');
assert.equal(store.facts.length, 7);
assert.match(store.facts.find(f => f.id === 'F0001').text, /小林.*下周一上午十点/);
assert.ok(store.facts.some(f => f.id !== 'F0001' && f.text === '仓库盘点交给小郑，周四下班前完成。'));
assert.deepEqual(store.facts.map(f => f.id), ['F0001','F0002','F0003','F0004','F0005','F0006','F0007']);
const reportOnly = { nextId: 2, facts: [store.facts[0]] };
const savedBefore = structuredClone(reportOnly);
for (const text of ['## 修订\n- F0001：错误覆盖', '删除 F0001：删除旧报告'])
  assert.throws(() => parseWorkflowSubmission(text, new Set()));
assert.throws(() => parseWorkflowSubmission('## 行动\n- 正常新增\n## 修订\n- F9999：错误修改', new Set(['F0001'])));
assert.deepEqual(reportOnly, savedBefore);
const mixed = parseWorkflowSubmission('## 行动\n- F0001：新的培训安排\n## 修订 行动\nF0001：小林负责周报，下周一上午十点交。', new Set(['F0001']));
const next = patchFacts(reportOnly, mixed.patch, batches.at(-1));
assert.deepEqual(next.facts.map(f => f.id), ['F0001','F0002']);
assert.match(next.facts[0].text, /小林.*下周一/);
assert.equal(next.facts[1].text, '新的培训安排');
const legacyRevision = parseWorkflowSubmission(replies[6], new Set(['F0001']));
assert.equal(legacyRevision.patch.upsert[0].id, 'new', 'Old ambiguous syntax must not silently authorize an overwrite');
assert.throws(() => parseWorkflowSubmission('## 修订\n- F0001：一次修改\n## 修订 行动\n- F0001：重复修改', new Set(['F0001'])));
// A real native response copied the prompt's word “已有” before its correct ID.
const nativeRevision = captured.nativeRevision;
const nativePatch = parseWorkflowSubmission(nativeRevision, new Set(['F0001']));
assert.equal(nativePatch.patch.upsert[0].id, 'F0001');
assert.equal(nativePatch.patch.upsert[0].text, nativeRevision.split('F0001：')[1]);
assert.throws(() => parseWorkflowSubmission(nativeRevision, new Set()));
assert.throws(() => parseWorkflowSubmission(nativeRevision.replace('F0001', 'F9999'), new Set(['F0001'])));
assert.equal(parseWorkflowSubmission('## 修订\n已有 F0001：只改格式', new Set(['F0001'])).patch.upsert[0].id, 'F0001');
console.log('PASS: captured additions and explicit revision preserve wording; program-owned IDs cannot overwrite an old task in ordinary sections; unknown/duplicate edits rejected. Legacy headings do not silently authorize revisions.');
