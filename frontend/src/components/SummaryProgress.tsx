'use client';
import { useEffect, useRef, useState } from 'react';
import type { AudioRange, SummaryProgress as Progress } from '@/hooks/useSummaryProgress';

export const audioTime = (seconds = 0) => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};
const sourceTimes = (ranges?: AudioRange[]) => ranges?.map(r => `${audioTime(r.start)}–${audioTime(r.end)}`).join('、') || '等待来源时间';
const shortTimes = (ranges?: AudioRange[]) => sourceTimes(ranges?.slice(0, 2)) + ((ranges?.length || 0) > 2 ? ` 等 ${ranges!.length} 个来源时段` : '');
function SourceTimes({ ranges }: { ranges?: AudioRange[] }) {
  return (ranges?.length || 0) > 2 ? <details className="text-sm text-gray-600"><summary className="cursor-pointer">{shortTimes(ranges)}</summary>
    <p className="mt-2 leading-6">{sourceTimes(ranges)}</p></details> : <span>{sourceTimes(ranges)}</span>;
}
const labels: Record<string, string> = {
  waiting_transcripts: '等待完整转写和说话人结果', collecting: '正在积累会议材料',
  preparing_sections: '正在准备最终章节', preparing_model: '正在准备总结模型', recording_note: '正在总结', tail_note: '正在补齐尾部笔记',
  waiting_final_transcripts: '等待转写和说话人收尾', direct_final: '正在生成整场纪要',
  saving: '正在保存纪要', completed: '已完成', failed: '总结未完成',
  note_failed: '本段未完成，会后将接管原文', unavailable: '暂时无法读取总结进度',
};
function CompletedNote({ title, text, ranges }: { title: string; text: string; ranges?: AudioRange[] }) {
  const [open, setOpen] = useState(false);
  return <details className="border-b border-gray-200 py-3" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm text-gray-700">{title}</summary>
    {open && <div className="whitespace-pre-wrap break-words pt-3 text-sm leading-7 text-gray-800">{ranges && <p className="mb-2 text-xs text-gray-600">来源音频：{sourceTimes(ranges)}</p>}{text}</div>}
  </details>;
}
export function SummaryProgressPanel({ progress, onRetry }: { progress: Progress | null; onRetry?: () => void }) {
  const scroll = useRef<HTMLDivElement>(null), follow = useRef(true);
  const [atLatest, setAtLatest] = useState(true);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [progress?.seq]);
  const current = progress?.current;
  return <div className="relative flex h-full min-h-0 flex-col bg-white">
    <div className="border-b border-gray-200 px-5 py-4">
      <p role="status" className="font-medium text-gray-900">{current?.section
        ? `正在整理${current.section}，第 ${current.group}/${current.groups} 组`
        : labels[progress?.phase || 'waiting_transcripts'] || '正在整理会议纪要'}</p>
      <p className="mt-1 text-sm text-gray-600">已完成 {progress?.completed_notes || 0} 段 · 已整理至 {audioTime(progress?.covered_through)} · 等待整理 {progress?.queued_batches || 0} 批转写
        {!!progress?.completed_sections && ` · 已完成 ${progress.completed_sections} 个章节`}</p>
    </div>
    <div ref={scroll} className="flex-1 overflow-y-auto px-5 py-4" onScroll={event => {
      const el = event.currentTarget;
      follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
      setAtLatest(follow.current);
    }}>
      <div className="mx-auto max-w-3xl">
        {progress?.notes?.map((note, i) => <CompletedNote key={i}
          title={`${note.completed_during_recording ? '会中笔记' : '尾部笔记'} ${i + 1} · ${shortTimes(note.ranges)}`} text={note.content} ranges={note.ranges} />)}
        {progress?.chapters?.map(chapter => <CompletedNote key={chapter.title} title={`已整理章节 · ${chapter.title}`} text={chapter.content} />)}
        {progress?.error && <p role="alert" className="my-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          {progress.phase === 'failed' ? '总结未能完成，原始转写和已完成笔记已保留。可在会议详情重新生成。' : '当前总结暂不可用，原始转写继续保留。'}
          <details className="mt-2"><summary className="cursor-pointer">诊断信息</summary><pre className="mt-2 whitespace-pre-wrap break-all">{progress.error}</pre></details>
        </p>}
        {progress?.phase === 'failed' && onRetry && <button className="my-2 rounded-md border border-gray-300 px-3 py-2 text-sm" onClick={onRetry}>重新生成纪要</button>}
        {current && <section className="py-5">
          <p className="mb-2 text-sm text-gray-600">{current.whole_meeting ? '整场会议' : '分段来源'} · 生成中草稿</p>
          {!current.whole_meeting && <SourceTimes ranges={current.ranges} />}
          <p className="my-3 text-xs text-gray-600">时间范围按原始转写段标注。</p>
          <div className="whitespace-pre-wrap break-words text-sm leading-7 text-gray-900">{current.draft || '正在处理材料，正文生成后会在这里持续追加。'}</div>
        </section>}
        {progress?.phase === 'saving' && progress.draft && <div className="whitespace-pre-wrap break-words py-4 text-sm leading-7">{progress.draft}</div>}
        {!current && !progress?.notes?.length && !progress?.error && progress?.phase !== 'saving' &&
          <p className="py-8 text-sm leading-7 text-gray-600">完整转写和说话人结果就绪后开始整理。会议结束后，这里会继续生成并保存最终纪要。</p>}
      </div>
    </div>
    {!atLatest && <button className="absolute bottom-4 right-5 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm" onClick={() => {
      follow.current = true; setAtLatest(true); if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    }}>回到最新内容</button>}
  </div>;
}
