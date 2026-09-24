import { parseFactText } from './text-facts.mjs';

// Ordinary sections only append; only explicit revision sections may edit IDs.
// The program owns IDs even when the model labels a new note with an existing one.
export function parseWorkflowSubmission(text, visibleFactIds) {
  const normalizations = [];
  const revisionSections = new Map();
  let revision = false, targetSection;
  const normalizedText = text.split(/\r?\n/).map((line, index) => {
    const heading = line.trim().match(/^(?:#{1,3}\s*)?(讨论|决定|行动|待确认|修订)(?:[\s：:]+(讨论|决定|行动|待确认))?[：:]?$/u);
    if (heading) {
      revision = heading[1] === '修订'; targetSection = revision ? heading[2] : undefined;
      if (!revision && heading[2]) throw new Error('只有修订章节可指定目标分类');
      return '## ' + heading[1];
    }
    const existingLabel = /^(\s*(?:(?:[-*]|\d+[.)、])\s+)?)已有\s*(F\d{4}[：:])/u;
    if (existingLabel.test(line)) {
      line = line.replace(existingLabel, '$1$2');
      normalizations.push({ line: index + 1, kind: 'existing-id-label' });
    }
    if (/^\s*F\d{4}[：:]/u.test(line)) {
      line = '- ' + line.trim();
      normalizations.push({ line: index + 1, kind: 'missing-list-marker' });
    }
    const labelled = line.match(/^(\s*(?:[-*]|\d+[.)、])\s+)(F\d{4})[：:]\s*(.*)$/u);
    if (!revision && labelled) {
      line = labelled[1] + labelled[3];
      normalizations.push({ line: index + 1, kind: 'append-id-assigned-by-program', modelId: labelled[2] });
    }
    if (revision && labelled && targetSection) revisionSections.set(labelled[2], targetSection);
    return line;
  }).join('\n');
  const patch = parseFactText(normalizedText, visibleFactIds);
  for (const change of patch.upsert)
    if (revisionSections.has(change.id)) change.section = revisionSections.get(change.id);
  return { patch, normalizedText, normalizations, writeMode: 'explicit-new-or-revision' };
}
