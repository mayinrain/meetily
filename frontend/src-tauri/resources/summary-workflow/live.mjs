import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { sourceRows } from './round.mjs';
import { startModel } from './runtime.mjs';
import { createGenerator } from './generation.mjs';
import { createProgress, ranges, joinMaterials, materialRanges } from './progress.mjs';
import { sections, planChunk, slices, formatSources, chunkTokens, sectionTokens, sectionPromptTokens, directTokens,
  chunkSystem, directSystem, chunkPrompt, sectionPrompt,
  renderNotes, renderSections, extractSections, splitMaterial } from './sections.mjs';

export function writeJson(file, value) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  const deadline = performance.now() + 250;
  try {
    while (true) {
      try { fs.renameSync(temporary, file); return; }
      catch (error) {
        if (process.platform !== 'win32' || !['EACCES', 'EPERM', 'EBUSY'].includes(error.code)
            || performance.now() >= deadline) throw error;
        // A Python reader on Windows can briefly deny delete sharing.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } finally { fs.rmSync(temporary, { force: true }); }
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
    const native = path.join(directory, 'memory.json');
    const file = fs.existsSync(native) ? native : path.join(directory, 'openvino-memory.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).available_bytes : os.freemem();
  },
    drainMs = 1800000, pollMs = 250, onProgress = () => {} } = {}) {
  const began = Date.now(), abort = new AbortController();
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const state = { workflow: 'section-notes-v1',
    model: process.env.MEETILY_WORKFLOW_BACKEND === 'openvino' ? 'Qwen3-1.7B' : 'qwen3.5:4b',
    status: 'recording', phase: 'collecting',
    notes: [], cursor: 0, final_sections: {}, batches: [], source_segments: [], completed_batches: 0,
    queued_batches: 0, failed_batches: 0, maximum_queued_batches: 0, recording_active: true,
    minimum_available_bytes: null, stopped_at: null, observed_segments: 0, semantic_quality_verified: false,
    post_stop_target_seconds: 120, maximum_pending_characters: 0, final_report_complete: false };
  let desired = [], rows = [], finalInput = false, model, generator, active = false, lastInbox = '', maximumPublished = 0;
  let activeChunk, chunkFailureAt = -1, requestNumber = 0, lastPersist = 0;
  const progress = createProgress(directory, writeJson, onProgress);
  const events = path.join(directory, 'events.jsonl');
  const log = (type, data = {}) => fs.appendFileSync(events, JSON.stringify({ elapsed_s: (Date.now() - began) / 1000, type, ...data }) + '\n');
  const persist = (force = true) => {
    let chars = 0, completeRows = 0;
    for (const row of rows) { chars += row.text.length; if (chars <= state.cursor) completeRows++; }
    let batchEnd = 0;
    for (const batch of desired) {
      batchEnd += batch.segments.reduce((sum, row) => sum + row.text.length, 0);
      if (batchEnd <= state.cursor && !state.batches[batch.batch_id]) state.batches.push({
        source: batch, status: 'saved', completed_during_recording: state.recording_active });
    }
    state.completed_batches = state.batches.length;
    state.queued_batches = Math.max(0, desired.length - state.batches.length);
    state.maximum_queued_batches = Math.max(state.maximum_queued_batches, state.queued_batches);
    state.pending_batches = state.queued_batches;
    state.unsaved_segments = Math.max(0, state.observed_segments - completeRows);
    state.pending_characters = Math.max(0, chars - state.cursor);
    state.maximum_pending_characters = Math.max(state.maximum_pending_characters, state.pending_characters);
    state.active = active;
    if (!state.final_report_complete) state.markdown = renderNotes(state.notes);
    if (force || Date.now() - lastPersist >= 2000) {
      writeJson(path.join(directory, 'state.json'), state); lastPersist = Date.now();
    }
    const covered = rows.slice(0, completeRows).at(-1)?.end || 0;
    const phase = active || progress.state.retry ? progress.state.phase : state.status === 'failed' ? 'failed'
      : state.status === 'ready' ? 'saving' : !state.recording_active && !finalInput ? 'waiting_final_transcripts'
      : finalInput ? 'preparing_sections' : chunkFailureAt === state.cursor ? 'note_failed' : rows.length ? 'collecting' : 'waiting_transcripts';
    if (progress.state.phase !== phase || progress.state.queued_batches !== state.queued_batches
        || progress.state.covered_through !== covered || progress.state.completed_notes !== state.notes.length)
      progress.update({ phase, queued_batches: state.queued_batches, covered_through: covered,
        completed_notes: state.notes.length, notes: state.notes });
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
          rows = desired.flatMap(sourceRows);
          state.source_segments = snapshot.result?.source_segments || [];
          state.observed_segments = (snapshot.transcript_segments || state.source_segments).length;
          finalInput = snapshot.status === 'completed';
          if (snapshot.recording_stopped_at && !state.stopped_at) {
            state.stopped_at = snapshot.recording_stopped_at;
            state.recording_active = false;
            let end = 0;
            const savedRows = rows.filter(row => { end += row.text.length; return end <= state.cursor; }).length;
            state.unsaved_segments_at_stop = Math.max(0, state.observed_segments - savedRows);
            // Finish owns the uncommitted tail. Do not wait for or commit a late recording note.
            activeChunk?.abort(new Error('Recording ended; final summary takes over the tail'));
            log('recording_stopped', { unsaved_segments: state.unsaved_segments_at_stop });
          }
          if (desired.length > maximumPublished) {
            log('batches_received', { total: desired.length, completed: state.completed_batches });
            maximumPublished = desired.length;
          }
          lastInbox = raw;
        }
      }
      if (state.stopped_at && Date.now() - state.stopped_at >= drainMs)
        throw new Error(`Summary exceeded experiment limit (${drainMs / 1000} seconds)`);
      persist(false);
    } catch (error) { abort.abort(error); }
  };
  persist(); poll();
  const timer = setInterval(poll, pollMs);
  async function ensureModel() {
    if (!model) {
      progress.update({ phase: 'preparing_model' });
      model = await modelFactory(directory, combined);
      if (model.id) state.model = model.id;
      generator = createGenerator({ base: model.base, modelId: model.id, directory, writeJson, log, signal: combined,
        retries: model.retries, reconnect: model.reconnect, onText: text => progress.text(text),
        onRetry: retry => progress.update({ phase: 'retrying', retry, error: null,
          current: progress.state.current ? { ...progress.state.current, request_id: String(++requestNumber), draft: '' } : null }),
        onAttempt: ({ stage }) => progress.update({ phase: stage, retry: null }) });
    }
  }
  async function generate(stage, system, user, tokens, signal = combined, source = {}) {
    active = true;
    progress.update({ phase: 'preparing_model', current: { request_id: String(++requestNumber), stage, draft: '', ...source }, error: null });
    try {
      await ensureModel();
      state.phase = stage; progress.update({ phase: stage }); persist();
      return await generator.generate(stage, system, user, tokens,
        AbortSignal.any([signal, AbortSignal.timeout(600000)]));
    } catch (error) {
      // A cancelled/failed fragment is never included in completed notes or chapters.
      progress.update({ current: null, retry: null, error: signal.aborted ? null : String(error) });
      throw error;
    } finally { active = false; }
  }
  function saveNote(content, start, end, elapsed, duringRecording) {
    state.notes.push({ content, start, end, elapsed_s: elapsed,
      completed_during_recording: duringRecording,
      ranges: ranges(slices(rows, start, end)),
      sources: slices(rows, start, end).map(r => ({ id: r.id, from: r.from, to: r.to, audio_start_time: r.start, audio_end_time: r.end })) });
    state.cursor = end; progress.update({ current: null }); persist();
    log('note_saved', { index: state.notes.length - 1, start, end, during_recording: duringRecording });
  }
  try {
    while (true) {
      combined.throwIfAborted();
      if (finalInput) break;
      const chunk = state.recording_active && chunkFailureAt !== state.cursor ? planChunk(rows, state.cursor) : null;
      if (!chunk) {
        await sleep(pollMs, undefined, { signal: combined });
        continue;
      }
      const started = Date.now(); activeChunk = new AbortController();
      try {
        const content = await generate('recording_note', chunkSystem, chunkPrompt(chunk.material, chunk.buffer),
          chunkTokens, AbortSignal.any([combined, activeChunk.signal]), { ranges: ranges(slices(rows, chunk.start, chunk.end)) });
        combined.throwIfAborted();
        activeChunk.signal.throwIfAborted();
        saveNote(content, chunk.start, chunk.end, (Date.now() - started) / 1000, true);
      } catch (error) {
        combined.throwIfAborted();
        if (!activeChunk.signal.aborted) {
          // A failed chunk never advances the cursor. Finalization still sees its full source.
          chunkFailureAt = state.cursor;
          state.recording_note_failures = (state.recording_note_failures || 0) + 1;
          progress.update({ phase: 'note_failed', error: String(error) });
          log('note_failed', { cursor: state.cursor, error: String(error) });
        }
      } finally { activeChunk = null; }
    }
    const total = rows.reduce((sum, row) => sum + row.text.length, 0);
    state.finalization_started_at = Date.now();
    const fullSource = formatSources(rows);
    let direct = state.notes.length < 2 || fullSource.length <= 1200;
    if (direct && fullSource.length > 1200) {
      active = true; await ensureModel();
      direct = await generator.fits(directSystem, `<完整会议转写>\n${fullSource}\n</完整会议转写>`, directTokens);
      active = false;
    }
    if (!rows.length) {
      state.markdown = renderSections(new Map()); state.route = 'empty';
    } else if (direct) {
      state.route = 'direct';
      const content = await generate('direct_final', directSystem,
        `<完整会议转写>\n${formatSources(rows)}\n</完整会议转写>`, directTokens, combined, { whole_meeting: true, ranges: ranges(rows) });
      const parsed = extractSections(content);
      if (!parsed.size) parsed.set(sections[0], content);
      state.markdown = renderSections(parsed); state.cursor = total;
    } else {
      state.route = 'section_wise'; active = true; await ensureModel(); active = false;
      const tailStart = state.cursor, tailRows = slices(rows, tailStart), tail = formatSources(tailRows);
      if (tail) {
        // Mirror formatSources' turn joins while retaining ASR provenance.
        const turns = [];
        for (const row of tailRows) {
          const label = row.uncertain || row.speakers.length !== 1 ? '待确认' : `发言人${row.speakers[0]}`;
          if (label !== '待确认' && turns.at(-1)?.label === label) turns.at(-1).rows.push(row);
          else turns.push({ label, rows: [row] });
        }
        const entries = turns.flatMap((turn, i) => turn.rows.map((row, j) => ({
          text: (j === 0 ? (i ? '\n' : '') + turn.label + '：' : '') + row.text,
          ranges: ranges([row]) })));
        const mapped = joinMaterials(entries, '');
        if (mapped.text !== tail) throw new Error('Tail provenance mismatch');
        const parts = await splitMaterial(tail, part => generator.fits(chunkSystem, chunkPrompt(part), chunkTokens));
        const notes = [], started = Date.now(); let offset = 0;
        for (const [index, part] of parts.entries()) {
          const source = materialRanges(mapped, offset, offset + part.length); offset += part.length;
          const content = await generate('tail_note', chunkSystem, chunkPrompt(part), chunkTokens, combined,
            { ranges: source, group: index + 1, groups: parts.length });
          notes.push({ content, start: tailStart, end: total, ranges: source,
            completed_during_recording: false, elapsed_s: (Date.now() - started) / 1000, tail_part: true });
        }
        // Commit the source cursor only after all tail groups succeeded.
        state.notes.push(...notes); state.cursor = total; progress.update({ current: null }); persist();
      }
      const final = new Map();
      for (const section of sections) {
        const entries = state.notes.flatMap(note => {
          const parsed = extractSections(note.content);
          const text = parsed.size ? parsed.get(section) : section === sections[0] ? note.content : '';
          return text && text !== '未提及' ? [{ text, ranges: note.ranges }] : [];
        });
        const mapped = joinMaterials(entries), outputs = [];
        if (mapped.text) {
          const parts = await splitMaterial(mapped.text, part => {
            const p = sectionPrompt(section, part);
            return generator.fits(p.system, p.user, sectionTokens, model.sectionPromptTokens || sectionPromptTokens);
          });
          let offset = 0;
          for (const [index, part] of parts.entries()) {
            const source = materialRanges(mapped, offset, offset + part.length); offset += part.length;
            const p = sectionPrompt(section, part);
            outputs.push(await generate(`section:${section}`, p.system, p.user, sectionTokens, combined,
              { section, group: index + 1, groups: parts.length, ranges: source }));
          }
        }
        const content = outputs.join('\n\n') || '未提及';
        final.set(section, content); state.final_sections[section] = content;
        progress.update({ current: null, completed_sections: final.size,
          chapters: [...final].map(([title, content]) => ({ title, content })) }); persist();
      }
      state.markdown = renderSections(final);
    }
    combined.throwIfAborted();
    state.final_report_complete = true; state.status = 'ready'; state.phase = 'complete';
    progress.update({ current: null, phase: 'saving', draft: state.markdown });
  } catch (error) {
    state.status = 'failed'; state.error = String(abort.signal.reason || error); state.failed_batches++;
    progress.update({ current: null, retry: null, phase: 'failed', error: state.error });
  } finally {
    clearInterval(timer);
    if (model) await model.stop();
    active = false;
    state.settled_seconds_after_stop = state.stopped_at ? (Date.now() - state.stopped_at) / 1000 : null;
    state.within_post_stop_target = state.status === 'ready' && state.settled_seconds_after_stop !== null && state.settled_seconds_after_stop <= 120;
    state.worker_elapsed_s = (Date.now() - began) / 1000;
    persist(); progress.close(); log('finished', { status: state.status, error: state.error });
  }
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Expected a fresh recording directory');
  const file = path.join(directory, 'state.json');
  const initial = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (initial && (initial.status !== 'starting' || initial.workflow !== 'section-notes-v1'))
    throw new Error('Expected a fresh recording directory');
  const controller = new AbortController();
  process.stdin.resume();
  process.stdin.on('end', () => controller.abort(new Error('Application disconnected')));
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => controller.abort(new Error('Recording summary cancelled')));
  const state = await runLive(directory, { signal: controller.signal,
    onProgress: value => process.stdout.write(JSON.stringify(value) + '\n') });
  process.stdin.destroy();
  process.exitCode = state.status === 'ready' ? 0 : 1;
}
