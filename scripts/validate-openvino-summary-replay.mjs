// Full recorded-text preflight. Accelerated arrivals exclude live ASR, diarization and DB save.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { runLive, writeJson } from '../frontend/src-tauri/resources/summary-workflow/live.mjs';
import { startOpenVino } from '../frontend/src-tauri/resources/summary-workflow/runtime-openvino.mjs';
import { sourceRows } from '../frontend/src-tauri/resources/summary-workflow/round.mjs';
import { planChunk } from '../frontend/src-tauri/resources/summary-workflow/sections.mjs';

const [input, directory, python, modelPath, device] = process.argv.slice(2);
if (!input || !directory || !python || !modelPath || !['CPU', 'GPU'].includes(device) || fs.existsSync(directory))
  throw new Error('Expected captured input, fresh output directory, Python, IR model directory and CPU/GPU');
fs.mkdirSync(directory, { recursive: true });
process.env.MEETILY_WORKFLOW_MODEL = path.join(modelPath, 'openvino_model.bin');
process.env.MEETILY_WORKFLOW_SERVER = python;
const raw = fs.readFileSync(input), captured = JSON.parse(raw), batches = captured.result.batches;
const rows = batches.flatMap(sourceRows), sources = batches.flatMap(b => b.segments);
const snapshot = { status: 'running', transcript_segments: sources, result: { batches, source_segments: sources } };
writeJson(path.join(directory, 'input.json'), snapshot);
writeJson(path.join(directory, 'validation-mode.json'), { mode: 'accelerated-recorded-text-summary-only',
  model: 'Qwen3-1.7B', backend: 'OpenVINO', device, source_sha256: createHash('sha256').update(raw).digest('hex'),
  segments: rows.length, source_batches: batches.length,
  excluded: ['ASR', 'VAD', 'diarization', 'microphone', 'real-time backlog', 'desktop save'] });
const controller = new AbortController(), began = Date.now();
const modelFactory = (directory, signal) => startOpenVino(directory, signal, device);
const running = runLive(directory, { signal: controller.signal, modelFactory });
try {
  let lastNotes = -1;
  while (true) {
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
    if (state.notes.length !== lastNotes) {
      console.log(JSON.stringify({ notes: state.notes.length, cursor: state.cursor, pending_characters: state.pending_characters }));
      lastNotes = state.notes.length;
    }
    if (state.status === 'failed') break;
    if ((!state.active && !planChunk(rows, state.cursor)) || state.recording_note_failures) {
      writeJson(path.join(directory, 'input.json'), { ...snapshot, status: 'completed', recording_stopped_at: Date.now() });
      break;
    }
    if (Date.now() - began > 1800000) throw new Error('Text preflight exceeded 30 minutes before finalization');
    await sleep(250);
  }
  const state = await running;
  fs.writeFileSync(path.join(directory, 'minutes-raw.md'), state.markdown);
  console.log(JSON.stringify({ status: state.status, route: state.route, notes: state.notes.length,
    elapsed_s: state.worker_elapsed_s, finalization_s: state.settled_seconds_after_stop, error: state.error }));
  process.exitCode = state.status === 'ready' ? 0 : 1;
} finally { controller.abort(); await running; }
