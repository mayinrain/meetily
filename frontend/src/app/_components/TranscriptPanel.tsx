import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { PermissionWarning } from '@/components/PermissionWarning';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, GlobeIcon } from 'lucide-react';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { ModalType } from '@/hooks/useModalState';
import { useIsLinux } from '@/hooks/usePlatform';
import { useMemo } from 'react';
import { useRecordingSpeakers } from '@/hooks/useRecordingSpeakers';

/**
 * TranscriptPanel Component
 *
 * Displays transcript content with controls for copying and language settings.
 * Uses TranscriptContext, ConfigContext, and RecordingStateContext internally.
 */

interface TranscriptPanelProps {
  // indicates stop-processing state for transcripts; derived from backend statuses.
  isProcessingStop: boolean;
  isStopping: boolean;
  showModal: (name: ModalType, message?: string) => void;
}

export function TranscriptPanel({
  isProcessingStop,
  isStopping,
  showModal
}: TranscriptPanelProps) {
  // Contexts
  const { transcripts, transcriptContainerRef, copyTranscript } = useTranscripts();
  const { transcriptModelConfig } = useConfig();
  const { isRecording, isPaused } = useRecordingState();
  const { checkPermissions, isChecking, hasSystemAudio, hasMicrophone } = usePermissionCheck();
  const isLinux = useIsLinux();
  const speakers = useRecordingSpeakers(isRecording || isStopping || isProcessingStop);

  // Convert transcripts to segments for virtualized view
  const segments = useMemo(() =>
    transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
    })),
    [transcripts]
  );

  return (
    <div ref={transcriptContainerRef} className="w-full min-h-0 border-r border-gray-200 bg-white flex flex-col overflow-hidden">
      {/* Title area - Sticky header */}
      <div className="sticky top-0 z-10 bg-white p-4 border-gray-200">
        <div className="flex flex-col space-y-3">
          <div className="flex  flex-col space-y-2">
            <div className="flex justify-center  items-center space-x-2">
              <ButtonGroup>
                {transcripts?.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={copyTranscript}
                    title="Copy Transcript"
                  >
                    <Copy />
                    <span className='hidden md:inline'>
                      Copy
                    </span>
                  </Button>
                )}
                {transcriptModelConfig.provider === "localWhisper" &&
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => showModal('languageSettings')}
                    title="Language"
                  >
                    <GlobeIcon />
                    <span className='hidden md:inline'>
                      Language
                    </span>
                  </Button>
                }
              </ButtonGroup>
            </div>
          </div>
        </div>
      </div>

      {/* Permission Warning - Not needed on Linux */}
      {!isRecording && !isChecking && !isLinux && (
        <div className="flex justify-center px-4 pt-4">
          <PermissionWarning
            hasMicrophone={hasMicrophone}
            hasSystemAudio={hasSystemAudio}
            onRecheck={checkPermissions}
            isRechecking={isChecking}
          />
        </div>
      )}

      {speakers?.error && <p role="status" className="px-4 text-sm text-amber-700">
        说话人分析已停止，录音和转写继续保留，可在保存后重新分析。
      </p>}
      {speakers?.status === 'running' && !speakers.result && <p role="status" className="px-4 text-sm text-gray-500">
        正在积累声纹，完整语音批次处理后显示说话人。
      </p>}
      {speakers?.summary && <p role="status" className="px-4 text-sm text-gray-500">
        {speakers.summary.error
          ? '分段摘要已停止，已完成内容和原始转写已保留。'
          : speakers.summary.workflow === 'section-notes-v1'
            ? `已生成 ${speakers.summary.completed_notes ?? 0} 份分段笔记，待整理 ${speakers.summary.pending_characters ?? 0} 字。`
            : `分段纪要已完成 ${speakers.summary.completed_batches} 批，待处理 ${speakers.summary.queued_batches} 批${speakers.summary.failed_batches ? `，失败 ${speakers.summary.failed_batches} 批` : ''}。`}
      </p>}

      {/* Transcript content */}
      <div className="flex-1 min-h-0 pb-20">
        <div className="flex h-full min-h-0 justify-center">
          <div className="w-2/3 h-full min-h-0 max-w-[750px]">
            <VirtualizedTranscriptView
              segments={segments}
              isRecording={isRecording}
              isPaused={isPaused}
              isProcessing={isProcessingStop}
              isStopping={isStopping}
              enableStreaming={isRecording}
              showConfidence={true}
              renderSpeaker={id => {
                const segment = segments.find(s => s.id === id);
                if (!segment || !speakers?.result || !['running', 'completed'].includes(speakers.status)) return null;
                // The publication boundary comes from complete ASR batches, not raw PCM ticks.
                const published = speakers.result.published_through_s ?? 0;
                if (!segment.endTime || segment.endTime > published+1e-6) return null;
                const ids = [...new Set(speakers.result.turns.filter(t =>
                  t.end > segment.timestamp && t.start < (segment.endTime ?? segment.timestamp)
                ).map(t => t.speaker))].sort((a, b) => a-b);
                return <span>{ids.length ? ids.map(s => `说话人 ${s}`).join(' / ') : '待确认'}
                  {speakers.status === 'running' ? ' · 暂定' : ''}</span>;
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
