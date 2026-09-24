// Prototype memory: validate the whole patch before replacing the store.
// context records the processing interval for search, not supporting evidence.
export const sections = ['讨论', '决定', '行动', '待确认'];
export function patchFacts(store, patch, batch) {
  const next = { nextId: store.nextId, facts: [...store.facts] };
  for (const id of patch.remove || []) {
    if (!next.facts.some(f => f.id === id)) throw new Error('未知事实编号：' + id);
    next.facts = next.facts.filter(f => f.id !== id);
  }
  for (const change of patch.upsert) {
    const previous = next.facts.find(f => f.id === change.id);
    const section = change.section ?? previous?.section;
    if (!sections.includes(section)) throw new Error('章节必须是讨论、决定、行动或待确认');
    if (!change.text.trim() || change.text.length > 180) throw new Error('每条事实需1–180字');
    let id = change.id;
    if (id === 'new') {
      const same = next.facts.find(f => f.section === section && f.text === change.text.trim());
      id = same?.id || 'F' + String(next.nextId++).padStart(4, '0');
    } else if (!next.facts.some(f => f.id === id)) throw new Error('未知事实编号：' + id);
    const fact = { id, section, text: change.text.trim(),
      context: { start: batch[0].start, end: batch.at(-1).end, speakers: [...new Set(batch.flatMap(r => r.speakers))] } };
    const index = next.facts.findIndex(f => f.id === id);
    if (index < 0) next.facts.push(fact); else next.facts[index] = fact;
  }
  return next;
}

export function renderFacts(store) {
  return sections.map(section => '## ' + section + '\n' + (store.facts.filter(f => f.section === section)
    .map(f => '- ' + f.text).join('\n') || '暂无。')).join('\n\n');
}
