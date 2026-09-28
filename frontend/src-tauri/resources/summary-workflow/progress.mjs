import path from 'node:path';

// Source intervals remain ASR boundaries, including when only part of a row is used.
export function ranges(rows) {
  const sorted = rows.map(r => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start);
  const result = [];
  for (const range of sorted) {
    const last = result.at(-1);
    if (last && range.start <= last.end + 1e-6) last.end = Math.max(last.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

// Keep provenance alongside the exact text passed to the existing splitter.
export function joinMaterials(entries, separator = '\n\n') {
  let text = '';
  const spans = entries.map((entry, index) => {
    if (index) text += separator;
    const from = text.length; text += entry.text;
    return { from, to: text.length, ranges: entry.ranges };
  });
  return { text, spans };
}
export function materialRanges(material, from, to) {
  return ranges(material.spans.filter(s => s.to > from && s.from < to).flatMap(s => s.ranges));
}

export function createProgress(directory, writeJson, send = () => {}) {
  const state = { seq: 0, phase: 'waiting_transcripts', current: null, notes: [], chapters: [],
    completed_notes: 0, completed_sections: 0, queued_batches: 0, covered_through: 0, error: null };
  let delivered = '', latest = '', lastSave = 0;
  const persist = (force = false) => {
    if (force || Date.now() - lastSave >= 2000) {
      writeJson(path.join(directory, 'progress.json'), state); lastSave = Date.now();
    }
  };
  const flush = () => {
    if (!state.current || latest === delivered) return;
    if (!latest.startsWith(delivered)) throw new Error('Non-append summary output');
    const text = latest.slice(delivered.length);
    state.current.draft = latest; delivered = latest;
    send({ kind: 'delta', seq: ++state.seq, request_id: state.current.request_id, text });
    persist();
  };
  const timer = setInterval(flush, 300);
  return {
    state,
    update(value) {
      flush(); Object.assign(state, value);
      if ('current' in value) delivered = latest = value.current?.draft || '';
      send({ kind: 'snapshot', ...state, seq: ++state.seq }); persist(true);
    },
    text(value) { latest = value; },
    close() { flush(); clearInterval(timer); persist(true); },
  };
}
