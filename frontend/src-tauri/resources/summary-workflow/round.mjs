import { systemPrompt } from './prompt.mjs';
import { patchFacts, renderFacts } from './facts.mjs';
import { parseWorkflowSubmission } from './workflow-submissions.mjs';
import { selectRelevantFacts } from './relevant-memory.mjs';

export { renderFacts };
export const emptyStore = () => ({ nextId: 1, facts: [] });
const rowText = r => `[${r.id}] ${r.start.toFixed(2)}–${r.end.toFixed(2)}s 说话人${r.speakers.join('/') || '未知'}${r.uncertain ? '(待核对)' : ''}：${r.text}`;

export function sourceRows(batch) {
  if (!Array.isArray(batch.segments) || !batch.segments.length) throw new Error('Empty speaker batch');
  return batch.segments.map(r => {
    if (typeof r.id !== 'string' || !r.id || typeof r.text !== 'string' ||
        !Number.isFinite(r.audio_start_time) || !Number.isFinite(r.audio_end_time) ||
        r.audio_start_time < 0 || r.audio_end_time <= r.audio_start_time ||
        !Array.isArray(r.speaker_ids)) throw new Error('Invalid speaker-labelled segment');
    return { id: r.id, text: r.text, start: r.audio_start_time, end: r.audio_end_time,
      speakers: r.speaker_ids, uncertain: r.needs_review === true };
  });
}

// Both the live adapter and the replay use the same parser, recall and patch rules.
export async function runRound({ base, store, batch, previous, signal, log = () => {} }) {
  const recent = selectRelevantFacts(store.facts, batch);
  const prompt = `已有${store.facts.length}条待核对草稿；未改的自动保留。\n` +
    (recent.length ? '相关旧条目候选（不变的不输出）：\n' + recent.map(f => `${f.id} [${f.section}] ${f.text}`).join('\n') + '\n' : '') +
    (previous.length ? '前文衔接（不属于本批新增范围）：\n' + previous.map(rowText).join('\n') + '\n' : '') +
    '本批新增完整原文：\n' + batch.map(rowText).join('\n');
  const payload = { model: 'Qwen3.5-4B', messages: [{ role: 'system', content: systemPrompt },
    { role: 'user', content: [{ type: 'text', text: prompt }] }], stream: false, max_tokens: 650,
    temperature: 0.2, top_p: 0.9, top_k: 40, min_p: 0, repeat_penalty: 1,
    presence_penalty: 0, repeat_last_n: 64, seed: 42, chat_template_kwargs: { enable_thinking: false } };
  async function post(endpoint, body) {
    const response = await fetch(base + endpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) throw new Error(endpoint + ': HTTP ' + response.status);
    return response.json();
  }
  log('memory_selected', { ids: recent.map(f => f.id) });
  const rendered = await post('/apply-template', payload);
  const encoded = await post('/tokenize', { content: rendered.prompt, add_special: false, parse_special: true });
  const promptTokens = encoded.tokens.length;
  if (promptTokens + 650 > 6144) throw new Error(`Context exceeds 6144: ${promptTokens} + 650`);
  log('request', { payload, renderedPrompt: rendered.prompt, promptTokens });
  const response = await post('/v1/chat/completions', payload);
  log('response', { response });
  signal.throwIfAborted();
  if (response.usage?.prompt_tokens !== promptTokens) throw new Error('Tokenizer/usage mismatch');
  const choice = response.choices?.[0];
  if (choice?.finish_reason !== 'stop' || choice.message.tool_calls?.length)
    throw new Error('Incomplete or unexpected model response');
  const submission = parseWorkflowSubmission(choice.message.content || '', new Set(recent.map(f => f.id)));
  const next = patchFacts(store, submission.patch, batch);
  log('fact_patch', { ...submission, before: store, after: next });
  return next;
}
