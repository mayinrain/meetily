// Summary-only quality preflight using a previously captured immutable speaker snapshot.
// Arrivals are accelerated; these timings are NOT live backlog or microphone benchmarks.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { runLive, writeJson } from '../frontend/src-tauri/resources/summary-workflow/live.mjs';
import { sourceRows } from '../frontend/src-tauri/resources/summary-workflow/round.mjs';
import { planChunk } from '../frontend/src-tauri/resources/summary-workflow/sections.mjs';

const [input, directory] = process.argv.slice(2);
if (!input || !directory || fs.existsSync(directory)) throw new Error('Usage: node validate-section-summary-replay.mjs captured-input.json fresh-output-directory');
fs.mkdirSync(directory, { recursive: true });
const raw = fs.readFileSync(input), captured = JSON.parse(raw);
const batches = captured.result.batches, rows = batches.flatMap(sourceRows);
const sources = batches.flatMap(b => b.segments);
const snapshot = { status: 'running', transcript_segments: sources, result: { batches, source_segments: sources } };
writeJson(path.join(directory, 'input.json'), snapshot);
writeJson(path.join(directory, 'validation-mode.json'), { mode: 'accelerated-recorded-text-summary-only',
  source_sha256: createHash('sha256').update(raw).digest('hex'), segments: rows.length,
  excluded: ['ASR', 'VAD', 'diarization', 'microphone', 'real-time backlog', 'desktop save'] });
const controller = new AbortController(), began = Date.now();
// macOS os.freemem excludes reclaimable pages; match the native host's available-memory metric.
let measuredAt = 0, available;
const freeMemory = process.env.MEETILY_BENCH_PYTHON ? () => {
  if (Date.now() - measuredAt > 1000) {
    available = Number(execFileSync(process.env.MEETILY_BENCH_PYTHON,
      ['-c', 'import psutil; print(psutil.virtual_memory().available)'], { encoding: 'utf8', timeout: 5000 }).trim());
    measuredAt = Date.now();
  }
  return available;
} : undefined;
const running = runLive(directory, { signal: controller.signal, ...(freeMemory ? { freeMemory } : {}) });
let lastNotes = -1;
try {
  while (true) {
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json')));
    if (state.notes.length !== lastNotes) {
      console.log(JSON.stringify({ notes: state.notes.length, cursor: state.cursor, pending_characters: state.pending_characters }));
      lastNotes = state.notes.length;
    }
    if (state.status === 'failed') break;
    if ((!state.active && !planChunk(rows, state.cursor)) || state.recording_note_failures) {
      writeJson(path.join(directory, 'input.json'), { ...snapshot, status: 'completed', recording_stopped_at: Date.now() });
      break;
    }
    if (Date.now() - began > 1800000) throw new Error('Summary-only preflight exceeded 30 minutes');
    await sleep(250);
  }
  const state = await running;
  fs.writeFileSync(path.join(directory, 'minutes-raw.md'), state.markdown);
  console.log(JSON.stringify({ status: state.status, route: state.route, notes: state.notes.length,
    elapsed_s: state.worker_elapsed_s, finalization_s: state.settled_seconds_after_stop, error: state.error }));
  process.exitCode = state.status === 'ready' ? 0 : 1;
} finally { controller.abort(); await running; }
