import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';

export function createGenerator({ base, directory, writeJson, log, signal, modelId = 'Qwen3.5-4B' }) {
  const calls = path.join(directory, 'calls'); fs.mkdirSync(calls, { recursive: true });
  const file = process.env.MEETILY_WORKFLOW_MODEL;
  const stat = file && fs.existsSync(file) ? fs.statSync(file) : null;
  const identity = { file, size: stat?.size, modified: stat?.mtimeMs };
  const payload = (system, user, maxTokens) => ({ model: modelId,
    messages: [{ role: 'system', content: system }, { role: 'user', content: [{ type: 'text', text: user }] }],
    stream: false, max_tokens: maxTokens, temperature: 0.2, top_p: 0.9, top_k: 40,
    min_p: 0, repeat_penalty: 1, presence_penalty: 0, repeat_last_n: 64, seed: 42,
    chat_template_kwargs: { enable_thinking: false } });
  async function post(endpoint, body, requestSignal = signal) {
    // Local non-streaming inference can take over 300 seconds. Native fetch has
    // a separate headers deadline that fires before our 600-second AbortSignal.
    const response = await new Promise((resolve, reject) => {
      const request = http.request(base + endpoint, { method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json' }, signal: requestSignal }, resolve);
      request.on('error', reject);
      request.end(JSON.stringify(body));
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      throw new Error(`${endpoint}: HTTP ${response.statusCode}`);
    }
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async function measure(system, user, maxTokens, requestSignal) {
    const rendered = await post('/apply-template', payload(system, user, maxTokens), requestSignal);
    const encoded = await post('/tokenize', { content: rendered.prompt, add_special: false, parse_special: true }, requestSignal);
    return { prompt: rendered.prompt, tokens: encoded.tokens.length };
  }
  return {
    fits: async (system, user, maxTokens, maxPromptTokens = 6144) =>
      (await measure(system, user, maxTokens)).tokens <= Math.min(6144 - maxTokens, maxPromptTokens),
    async generate(stage, system, user, maxTokens, requestSignal = signal) {
      const body = payload(system, user, maxTokens);
      const key = createHash('sha256').update(JSON.stringify({ stage, identity, body })).digest('hex');
      const checkpoint = path.join(calls, key + '.json');
      if (fs.existsSync(checkpoint)) {
        const saved = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
        if (saved.status === 'success' && saved.content?.trim()) {
          requestSignal.throwIfAborted(); log('generation_reused', { stage, key }); return saved.content;
        }
      }
      const budget = await measure(system, user, maxTokens, requestSignal);
      if (budget.tokens + maxTokens > 6144) throw new Error(`Context exceeds 6144: ${budget.tokens} + ${maxTokens}`);
      const began = Date.now(), saved = { stage, key, status: 'running', request: body, prompt_tokens: budget.tokens };
      writeJson(checkpoint, saved); log('request', { stage, key, payload: body, promptTokens: budget.tokens });
      try {
        const response = await post('/v1/chat/completions', body, requestSignal);
        requestSignal.throwIfAborted();
        const choice = response.choices?.[0];
        if (response.usage?.prompt_tokens !== budget.tokens) throw new Error('Tokenizer/usage mismatch');
        if (choice?.finish_reason !== 'stop' || choice.message.tool_calls?.length) throw new Error('Incomplete model response');
        const content = (choice.message.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        if (!content) throw new Error('Empty model response');
        Object.assign(saved, { status: 'success', content, response, elapsed_s: (Date.now() - began) / 1000 });
        writeJson(checkpoint, saved); log('generation_finished', { stage, key, elapsed_s: saved.elapsed_s, usage: response.usage });
        return content;
      } catch (error) {
        Object.assign(saved, { status: requestSignal.aborted ? 'cancelled' : 'failed', error: String(error), elapsed_s: (Date.now() - began) / 1000 });
        writeJson(checkpoint, saved); log('generation_failed', { stage, key, error: saved.error }); throw error;
      }
    },
  };
}
