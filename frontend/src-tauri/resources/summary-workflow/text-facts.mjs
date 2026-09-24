// Prototype: final text carries explicit edits, without per-fact source citations.

export function parseFactText(text, visibleFactIds) {
  if (text.trim() === '无新增') return { upsert: [], remove: [], removalReasons: {} };
  const patch = { upsert: [], remove: [], removalReasons: {} };
  const edited = new Set();
  let section = '', pending = '', explicitlyEmpty = false;
  const editId = id => {
    if (!visibleFactIds.has(id)) throw new Error('条目尚未提供，请先查询：' + id);
    if (edited.has(id)) throw new Error('同一条目只能编辑一次：' + id);
    edited.add(id);
  };
  const flush = () => {
    if (!pending) return;
    if (!section) throw new Error('要点之前需有## 讨论、决定、行动或待确认标题');
    let body = pending.trim(), id = 'new';
    const replacement = body.match(/^(F\d{4})[：:]\s*(.*)$/u);
    if (replacement) { id = replacement[1]; body = replacement[2]; editId(id); }
    if (section === '修订' && id === 'new') throw new Error('修订需指定已有F编号');
    if (!body || body.length > 80) throw new Error('要点需1–80字');
    if (body.includes('修订后的完整要点')) throw new Error('请写实际会议内容，不要写编辑模板');
    patch.upsert.push({ id, ...(section === '修订' ? {} : { section }), text: body });
    pending = '';
  };
  for (const line of text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    const heading = line.match(/^(?:#{1,3}\s*)?(讨论|决定|行动|待确认|修订)[：:]?$/u);
    const deletion = line.match(/^删除\s+(F\d{4})[：:]\s*(.+)$/u);
    if (heading) { flush(); section = heading[1]; continue; }
    if (deletion) {
      flush(); editId(deletion[1]); patch.remove.push(deletion[1]);
      patch.removalReasons[deletion[1]] = deletion[2]; continue;
    }
    const bullet = line.match(/^(?:[-*]|\d+[.)、])\s+(.+)$/u);
    const emptyLabel = (bullet?.[1] || line).replace(/[。.]$/u, '');
    if (section && ['暂无', '无', '无新增', '无新增' + section].includes(emptyLabel)) { flush(); explicitlyEmpty = true; continue; }
    if (bullet) { flush(); pending = bullet[1]; continue; }
    if (!pending) throw new Error('只输出章节、列表要点或删除说明');
    pending += ' ' + line;
  }
  flush();
  if (!patch.upsert.length && !patch.remove.length && !explicitlyEmpty) throw new Error('无新增信息请明确回复“无新增”');
  return patch;
}
