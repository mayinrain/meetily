"use client";
import type { RefObject } from 'react';
import type { MeetingSummary, Summary, Transcript } from '@/types';
import { BlockNoteSummaryView, type BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';
import { SummaryUpdaterButtonGroup } from './SummaryUpdaterButtonGroup';
import { Button } from '@/components/ui/button';
import { hasVisibleSummaryContent } from '@/lib/summary-content';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
interface SummaryPanelProps {
  meeting: {
    id: string;
    title: string;
    created_at: string;
  };
  meetingTitle: string;
  isSummaryDirty: boolean;
  summaryRef: RefObject<BlockNoteSummaryViewRef>;
  isSaving: boolean;
  onSaveAll: () => Promise<void>;
  onCopySummary: () => Promise<void>;
  aiSummary: MeetingSummary | null;
  summaryStatus: 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';
  transcripts: Transcript[];
  onGenerateSummary: (customPrompt: string) => Promise<void>;
  onStopGeneration: () => void;
  onSaveSummary: (summary: MeetingSummary) => Promise<void>;
  onSummaryChange: (summary: Summary) => void;
  onDirtyChange: (isDirty: boolean) => void;
  summaryError: string | null;
  onRegenerateSummary: () => Promise<void>;
}

export function SummaryPanel(props: SummaryPanelProps) {
  const { meeting, aiSummary, summaryStatus, summaryRef } = props;
  const busy = ['processing', 'summarizing', 'regenerating'].includes(summaryStatus);
  const hasSummary = hasVisibleSummaryContent(aiSummary);
  return <div className="flex h-full min-h-0 flex-col bg-white">
    <div className="flex flex-wrap justify-center gap-2 border-b border-gray-200 p-4">
      <Button size="sm" variant="outline" disabled={!props.transcripts.length && !busy}
        onClick={() => busy ? props.onStopGeneration() : hasSummary ? props.onRegenerateSummary() : props.onGenerateSummary('')}>
        {busy ? '取消生成' : hasSummary ? '重新生成' : '生成纪要'}
      </Button>
      {hasSummary && !busy && <SummaryUpdaterButtonGroup isSaving={props.isSaving} isDirty={props.isSummaryDirty}
        onSave={props.onSaveAll} onCopy={props.onCopySummary} onExport={async () => {
          try {
            const markdown = await summaryRef.current?.getMarkdown();
            if (!markdown?.trim()) throw new Error('没有可导出的纪要');
            const path = await invoke<string | null>('export_meeting_summary', { meetingId: meeting.id, markdown });
            if (path) toast.success('纪要已导出');
          } catch { toast.error('导出失败，请重试'); }
        }} />}
    </div>
    {props.summaryError && <p role="alert" className="p-4 text-sm text-red-700">纪要生成失败，转写已保留。请检查本地模型服务后重试。</p>}
    {busy ? <p role="status" className="p-6 text-gray-600">正在生成会议纪要…</p>
      : hasSummary ? <div className="flex-1 overflow-y-auto p-5">
        <BlockNoteSummaryView ref={summaryRef} summaryData={aiSummary} onSave={props.onSaveSummary}
          onSummaryChange={props.onSummaryChange} onDirtyChange={props.onDirtyChange}
          status={summaryStatus} onRegenerateSummary={props.onRegenerateSummary}
          meeting={{ ...meeting, title: props.meetingTitle }} />
      </div> : <p className="p-6 text-sm text-gray-600">纪要尚未生成。转写保存后，可点击“生成纪要”。</p>}
  </div>;
}
