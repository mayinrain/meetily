// Cheap lexical recall for the prototype; candidates are not verified facts.
// Only current-batch text selects memory, so preceding unrelated lines do not bias recall.
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const common = new Set(['我们','你们','他们','这个','那个','现在','可以','需要','已经','没有','进行',
  '负责','完成','提交','时间','上午','下午','之前','之后','保持','不变','安排','新增','修订']);
const terms = text => new Set([...segmenter.segment(text)].filter(s => s.isWordLike && s.segment.length > 1 && !common.has(s.segment)).map(s => s.segment));

export function selectRelevantFacts(facts, batch, limit = 4) {
  const current = terms(batch.map(r => r.text).join('\n'));
  const indexed = facts.map(fact => ({ fact, words: terms(fact.text) }));
  const frequency = new Map();
  for (const { words } of indexed) for (const word of words) frequency.set(word, (frequency.get(word) || 0) + 1);
  return indexed.map(({ fact, words }) => ({ fact, score: [...words].reduce((sum, word) => sum + (current.has(word)
    ? Math.log(1 + (facts.length + 1) / (frequency.get(word) + 1)) : 0), 0) / Math.sqrt(Math.max(1, words.size)) }))
    .filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id))
    .slice(0, limit).map(r => r.fact);
}
