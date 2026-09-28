import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

export function isTransient(error) {
  return error.retryable === true || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
    'ENETUNREACH', 'EHOSTUNREACH', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code);
}

// Hold incomplete tags and thinking text across network frames; only body text is public.
export function visibleBody(raw, complete = false) {
  let body = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
  if (!complete) body = body.replace(/<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/i, '');
  return body;
}

export function createGenerator({ base, directory, writeJson, log, signal, modelId = 'Qwen3.5-4B',
    stream = true, onText = () => {}, retries = 0, reconnect = async () => {},
    onRetry = () => {}, onAttempt = () => {}, retryDelays = [2000, 5000, 10000], attemptTimeoutMs = retries ? 180000 : 600000 }) {
  const calls = path.join(directory, 'calls'); fs.mkdirSync(calls, { recursive: true });
  const file = process.env.MEETILY_WORKFLOW_MODEL;
  const stat = file && fs.existsSync(file) ? fs.statSync(file) : null;
  const identity = { file, size: stat?.size, modified: stat?.mtimeMs };
  const payload = (system, user, maxTokens) => ({ model: modelId,
    messages: [{ role: 'system', content: system }, { role: 'user', content: [{ type: 'text', text: user }] }],
    stream, stream_options: { include_usage: true }, max_tokens: maxTokens, temperature: 0, top_p: 0.9, top_k: 40,
    min_p: 0, repeat_penalty: 1, presence_penalty: 0, repeat_last_n: 64, seed: 42,
    chat_template_kwargs: { enable_thinking: false } });
  async function post(endpoint, body, requestSignal = signal) {
    // Local non-streaming inference can take over 300 seconds. Native fetch has
    // a separate headers deadline that fires before our 600-second AbortSignal.
    const url = (typeof base === 'function' ? await base(requestSignal) : base) + endpoint;
    const response = await new Promise((resolve, reject) => {
      const request = http.request(url, { method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json' }, signal: requestSignal }, resolve);
      request.on('error', reject);
      request.end(JSON.stringify(body));
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.destroy();
      throw Object.assign(new Error(`${endpoint}: HTTP ${response.statusCode}`),
        { retryable: [408, 425, 429, 500, 502, 503, 504].includes(response.statusCode) });
    }
    try {
      if (response.headers['content-type']?.includes('text/event-stream')) {
        response.setEncoding('utf8');
        let buffer = '', raw = '', done = false, finish, usage, final, toolCalls = false;
        for await (const chunk of response) {
          buffer += chunk;
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
            if (!data) continue;
            if (data === '[DONE]') { done = true; continue; }
            if (done) throw new Error('Data after stream completion');
            const value = JSON.parse(data);
            if (value.error) throw Object.assign(new Error(JSON.stringify(value.error)),
              { retryable: [408, 429, 500, 502, 503, 504].includes(value.error.code) });
            const choice = value.choices?.[0];
            if (choice?.delta?.content) { raw += choice.delta.content; onText(visibleBody(raw)); }
            toolCalls ||= !!choice?.delta?.tool_calls?.length;
            if (choice?.finish_reason) finish = choice.finish_reason;
            if (value.usage) usage = value.usage;
            if (choice?.message) final = value;
          }
        }
        if (!done || !finish || buffer.trim()) throw Object.assign(new Error('Incomplete model stream'), { retryable: true });
        if (toolCalls) throw new Error('Unexpected model tool call');
        if (final && final.choices[0].message.content !== raw) throw new Error('Stream/final content mismatch');
        return final || { usage, choices: [{ finish_reason: finish, message: { content: raw } }] };
      }
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { response.destroy(); }
  }
  async function attempt(stage, requestSignal, work) {
    for (let number = 0; ; number++) {
      requestSignal.throwIfAborted();
      const timeout = AbortSignal.timeout(attemptTimeoutMs);
      const current = AbortSignal.any([requestSignal, timeout]);
      onAttempt({ stage, attempt: number + 1 });
      try { return await work(current, number + 1); }
      catch (error) {
        requestSignal.throwIfAborted();
        if (number >= retries || (!timeout.aborted && !isTransient(error))) throw error;
        const delay_ms = retryDelays[number];
        const retry = { stage, attempt: number + 1, max_retries: retries, delay_ms, error: String(error) };
        log('generation_retry', retry); onRetry(retry);
        await reconnect();
        await sleep(delay_ms, undefined, { signal: requestSignal });
      }
    }
  }
  async function measure(system, user, maxTokens, requestSignal) {
    const rendered = await post('/apply-template', payload(system, user, maxTokens), requestSignal);
    const encoded = await post('/tokenize', { content: rendered.prompt, add_special: false, parse_special: true }, requestSignal);
    return { prompt: rendered.prompt, tokens: encoded.tokens.length };
  }
  return {
    fits: async (system, user, maxTokens, maxPromptTokens = 6144) =>
      attempt('preparing_sections', signal, async requestSignal =>
        (await measure(system, user, maxTokens, requestSignal)).tokens <= Math.min(6144 - maxTokens, maxPromptTokens)),
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
      const began = Date.now(), saved = { stage, key, status: 'running', request: body };
      writeJson(checkpoint, saved);
      try {
        return await attempt(stage, requestSignal, async (currentSignal, number) => {
          const budget = await measure(system, user, maxTokens, currentSignal);
          if (budget.tokens + maxTokens > 6144) throw new Error(`Context exceeds 6144: ${budget.tokens} + ${maxTokens}`);
          Object.assign(saved, { prompt_tokens: budget.tokens, attempts: number });
          log('request', { stage, key, payload: body, promptTokens: budget.tokens, attempt: number });
          const response = await post('/v1/chat/completions', body, currentSignal);
          currentSignal.throwIfAborted();
          const choice = response.choices?.[0];
          Object.assign(saved, { finish_reason: choice?.finish_reason, usage: response.usage });
          if (response.usage?.prompt_tokens !== budget.tokens) throw new Error('Tokenizer/usage mismatch');
          if (choice?.finish_reason !== 'stop' || choice.message.tool_calls?.length)
            throw new Error(`Incomplete model response (${choice?.finish_reason || 'missing finish reason'})`);
          const content = visibleBody(choice.message.content || '', true).trim();
          if (!content) throw new Error('Empty model response');
          Object.assign(saved, { status: 'success', content, response, elapsed_s: (Date.now() - began) / 1000 });
          writeJson(checkpoint, saved); log('generation_finished', { stage, key, elapsed_s: saved.elapsed_s, usage: response.usage });
          return content;
        });
      } catch (error) {
        Object.assign(saved, { status: requestSignal.aborted ? 'cancelled' : 'failed', error: String(error), elapsed_s: (Date.now() - began) / 1000 });
        writeJson(checkpoint, saved); log('generation_failed', { stage, key, error: saved.error }); throw error;
      }
    },
  };
}
