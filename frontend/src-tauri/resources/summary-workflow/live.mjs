import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { emptyStore, sourceRows, runRound, renderFacts } from './round.mjs';
import { startModel } from './runtime.mjs';

export function writeJson(file, value) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

export function validateSnapshot(previous, snapshot) {
  if (!['running', 'completed'].includes(snapshot.status)) throw new Error(snapshot.error || 'Speaker analysis failed');
  const batches = snapshot.result?.batches || [];
  if (!Array.isArray(batches) || batches.length < previous.length ||
      previous.some((b, i) => JSON.stringify(b) !== JSON.stringify(batches[i])))
    throw new Error('Published speaker batches changed');
  const ids = new Set();
  let end = -1;
  for (const [index, batch] of batches.entries()) {
    if (batch.batch_id !== index) throw new Error('Speaker batches are not contiguous');
    for (const row of sourceRows(batch)) {
      if (ids.has(row.id) || row.start < end) throw new Error('Duplicated or unordered transcript');
      ids.add(row.id); end = row.start;
    }
  }
  if (snapshot.status === 'completed') {
    const rows = batches.flatMap(b => b.segments), sources = snapshot.result?.source_segments;
    if (!Array.isArray(sources) || rows.length !== sources.length || rows.some((r, i) =>
      ['id', 'text', 'audio_start_time', 'audio_end_time'].some(k => r[k] !== sources[i][k])))
      throw new Error('Final speaker batches do not cover the saved transcript');
  }
  return batches;
}

// The inbox is cumulative and atomic: snapshots may coalesce, complete batches cannot be lost.
export async function runLive(directory, { signal, modelFactory = startModel, freeMemory = () => {
    // The native host supplies available (including reclaimable) memory, not just free pages.
    const file = path.join(directory, 'memory.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).available_bytes : os.freemem();
  },
    drainMs = 120000, pollMs = 250 } = {}) {
  const began = Date.now(), abort = new AbortController();
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const state = { workflow: 'fixed-facts-v1', model: 'qwen3.5:4b', status: 'recording',
    facts: emptyStore(), batches: [], source_segments: [], completed_batches: 0,
    queued_batches: 0, failed_batches: 0, maximum_queued_batches: 0, recording_active: true,
    minimum_available_bytes: null, stopped_at: null, observed_segments: 0, semantic_quality_verified: false };
  let desired = [], finalInput = false, model, active = false, lastInbox = '', maximumPublished = 0;
  const events = path.join(directory, 'events.jsonl');
  const log = (type, data = {}) => fs.appendFileSync(events, JSON.stringify({ elapsed_s: (Date.now() - began) / 1000, type, ...data }) + '\n');
  const persist = () => {
    state.queued_batches = Math.max(0, desired.length - state.batches.length);
    state.maximum_queued_batches = Math.max(state.maximum_queued_batches, state.queued_batches);
    state.pending_batches = state.queued_batches + state.failed_batches;
    state.unsaved_segments = state.observed_segments - state.batches.filter(b => b.status === 'saved')
      .reduce((n, b) => n + b.source.segments.length, 0);
    state.active = active;
    state.markdown = renderFacts(state.facts);
    writeJson(path.join(directory, 'state.json'), state);
  };
  const poll = () => {
    try {
      const available = freeMemory();
      state.minimum_available_bytes = Math.min(state.minimum_available_bytes ?? available, available);
      if (!Number.isFinite(available) || available < 768 * 1024 * 1024) throw new Error('Less than 768 MiB available; recording and transcript are preserved');
      if (fs.existsSync(path.join(directory, 'cancel'))) throw new Error('Recording summary cancelled');
      const inbox = path.join(directory, 'input.json');
      if (fs.existsSync(inbox)) {
        const raw = fs.readFileSync(inbox, 'utf8');
        if (raw !== lastInbox) {
          const snapshot = JSON.parse(raw);
          desired = validateSnapshot(desired, snapshot);
          state.source_segments = snapshot.result?.source_segments || [];
          state.observed_segments = (snapshot.transcript_segments || state.source_segments).length;
          finalInput = snapshot.status === 'completed';
          if (snapshot.recording_stopped_at && !state.stopped_at) {
            state.stopped_at = snapshot.recording_stopped_at;
            state.recording_active = false;
            state.unsaved_segments_at_stop = state.observed_segments - state.batches
              .filter(b => b.status === 'saved').reduce((n, b) => n + b.source.segments.length, 0);
            log('recording_stopped', { unsaved_segments: state.unsaved_segments_at_stop });
          }
          if (desired.length > maximumPublished) {
            log('batches_received', { total: desired.length, completed: state.completed_batches });
            maximumPublished = desired.length;
          }
          lastInbox = raw;
        }
      }
      if (state.stopped_at && Date.now() - state.stopped_at >= drainMs) throw new Error('Summary drain exceeded 120 seconds');
      persist();
    } catch (error) { abort.abort(error); }
  };
  persist(); poll();
  const timer = setInterval(poll, pollMs);
  try {
    while (true) {
      combined.throwIfAborted();
      const batch = desired[state.batches.length];
      if (!batch) {
        if (finalInput) break;
        await sleep(pollMs, undefined, { signal: combined });
        continue;
      }
      if (!model) model = await modelFactory(directory, combined);
      const started = Date.now(); active = true; persist();
      const index = batch.batch_id;
      const rows = sourceRows(batch), previous = desired.slice(0, index).flatMap(sourceRows).slice(-2);
      const record = { source: batch, status: 'failed' };
      log('round_started', { batch_id: index });
      try {
        const next = await runRound({ base: model.base, store: state.facts, batch: rows, previous,
          signal: AbortSignal.any([combined, AbortSignal.timeout(300000)]),
          log: (type, data) => log(type, { batch_id: index, ...data }) });
        combined.throwIfAborted();
        state.facts = next; record.status = 'saved'; state.completed_batches++;
      } catch (error) {
        record.error = String(error); state.failed_batches++;
        log('round_failed', { batch_id: index, error: record.error });
      }
      record.elapsed_s = (Date.now() - started) / 1000;
      record.completed_during_recording = state.recording_active;
      state.batches.push(record); active = false; persist();
      log('round_finished', { batch_id: index, status: record.status, duration_s: record.elapsed_s });
    }
    state.status = state.failed_batches ? 'failed' : 'ready';
    if (state.failed_batches) state.error = `${state.failed_batches} batches were not saved; partial draft is preserved`;
  } catch (error) {
    state.status = 'failed'; state.error = String(abort.signal.reason || error);
  } finally {
    clearInterval(timer);
    if (model) await model.stop();
    active = false;
    state.settled_seconds_after_stop = state.stopped_at ? (Date.now() - state.stopped_at) / 1000 : null;
    state.worker_elapsed_s = (Date.now() - began) / 1000;
    persist(); log('finished', { status: state.status, error: state.error });
  }
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  if (!directory || fs.existsSync(path.join(directory, 'state.json'))) throw new Error('Expected a fresh recording directory');
  const controller = new AbortController();
  process.stdin.resume();
  process.stdin.on('end', () => controller.abort(new Error('Application disconnected')));
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => controller.abort(new Error('Recording summary cancelled')));
  const state = await runLive(directory, { signal: controller.signal });
  process.stdin.destroy();
  process.exitCode = state.status === 'ready' ? 0 : 1;
}
