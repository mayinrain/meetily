"use client";

import { Transcript, TranscriptSegmentData } from '@/types';
import { TranscriptView } from '@/components/TranscriptView';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { TranscriptButtonGroup } from './TranscriptButtonGroup';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { useMeetingSpeakers } from '@/hooks/useMeetingSpeakers';
import { SpeakerControls } from './SpeakerControls';

interface TranscriptPanelProps {
  transcripts: Transcript[];
  customPrompt: string;
  onPromptChange: (value: string) => void;
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  isRecording: boolean;
  disableAutoScroll?: boolean;

  // Optional pagination props (when using virtualization)
  usePagination?: boolean;
  segments?: TranscriptSegmentData[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;

  // Retranscription props
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;
}

export function TranscriptPanel({
  transcripts,
  customPrompt,
  onPromptChange,
  onCopyTranscript,
  onOpenMeetingFolder,
  isRecording,
  disableAutoScroll = false,
  usePagination = false,
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
}: TranscriptPanelProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const speakers = useMeetingSpeakers(meetingId, !!audioPath && !isRecording);

  const renderSpeaker = useCallback((segmentId: string) => {
    if (speakers.state?.job.status !== 'completed') return null;
    const overrides = speakers.state.overrides;
    const value = Object.prototype.hasOwnProperty.call(overrides, segmentId)
      ? overrides[segmentId] === null ? 'unknown' : String(overrides[segmentId]) : 'model';
    return <div className="flex flex-wrap items-center gap-2 mb-1 text-xs text-gray-600">
      <span>{speakers.label(segmentId)}</span>
      <select aria-label="校正本段说话人" value={value} disabled={speakers.loading}
        className="border rounded px-1 py-0.5 bg-white"
        onChange={event => void speakers.action('correct_meeting_speaker', {
          segmentId, restoreModel: event.target.value === 'model',
          speakerId: ['model', 'unknown'].includes(event.target.value) ? null : Number(event.target.value),
        })}>
        <option value="model">模型结果</option>
        <option value="unknown">未确认</option>
        {speakers.speakerIds.map(id => <option key={id} value={id}>{speakers.name(id)}</option>)}
      </select>
    </div>;
  }, [speakers]);

  useEffect(() => {
    let cancelled = false;
    setAudioPath(null);
    setAudioReady(false);
    setAudioError(null);
    if (meetingId && !isRecording) {
      invoke<string | null>('get_meeting_audio_path', { meetingId })
        .then(path => { if (!cancelled) setAudioPath(path); })
        .catch(() => { if (!cancelled) setAudioError('Unable to load recording.'); });
    }
    return () => { cancelled = true; };
  }, [meetingId, isRecording]);

  const seekAudio = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !audioReady) return;
    audio.currentTime = Math.min(Math.max(0, seconds), audio.duration);
    audio.play().catch(error => {
      if (error.name !== 'AbortError') setAudioError('Unable to play recording.');
    });
  }, [audioReady]);

  useEffect(() => {
    const seek = (event: Event) => {
      const detail = (event as CustomEvent<{ meetingId: string; seconds: number }>).detail;
      if (detail.meetingId === meetingId && Number.isFinite(detail.seconds)) seekAudio(detail.seconds);
    };
    window.addEventListener('meetily-seek-recording', seek);
    return () => window.removeEventListener('meetily-seek-recording', seek);
  }, [meetingId, seekAudio]);

  // Convert transcripts to segments if pagination is not used but we want virtualization
  const convertedSegments = useMemo(() => {
    if (usePagination && segments) {
      return segments;
    }
    // Convert transcripts to segments for virtualization
    return transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
    }));
  }, [transcripts, usePagination, segments]);

  return (
    <div className="flex h-full min-w-0 w-full bg-white flex-col relative @container">
      {/* Title area */}
      <div className="p-4 border-b border-gray-200">
        <TranscriptButtonGroup
          transcriptCount={usePagination ? (totalCount ?? convertedSegments.length) : (transcripts?.length || 0)}
          onCopyTranscript={onCopyTranscript}
          onOpenMeetingFolder={onOpenMeetingFolder}
          meetingId={meetingId}
          meetingFolderPath={meetingFolderPath}
          onRefetchTranscripts={onRefetchTranscripts}
        />
      </div>

      {audioPath && (
        <div className="px-4 py-2 border-b border-gray-200">
          <audio
            ref={audioRef}
            controls
            preload="metadata"
            aria-label="Meeting recording"
            className="w-full h-10"
            src={convertFileSrc(audioPath)}
            onLoadedMetadata={() => setAudioReady(true)}
            onError={() => { setAudioReady(false); setAudioError('Unable to play recording.'); }}
          />
        </div>
      )}
      {audioError && <p role="alert" className="px-4 py-2 text-sm text-red-600">{audioError}</p>}
      {audioPath && !isRecording && <SpeakerControls speakers={speakers} />}

      {/* Transcript content - use virtualized view for better performance */}
      <div className="flex-1 overflow-hidden pb-4">
        <VirtualizedTranscriptView
          segments={convertedSegments}
          isRecording={isRecording}
          isPaused={false}
          isProcessing={false}
          isStopping={false}
          enableStreaming={false}
          showConfidence={true}
          disableAutoScroll={disableAutoScroll}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
          onSeek={audioReady ? seekAudio : undefined}
          renderSpeaker={renderSpeaker}
        />
      </div>

      {/* Custom prompt input at bottom of transcript section */}
      {!isRecording && convertedSegments.length > 0 && (
        <div className="p-1 border-t border-gray-200">
          <textarea
            placeholder="Add context for AI summary. For example people involved, meeting overview, objective etc..."
            className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 bg-white shadow-sm min-h-[80px] resize-y"
            value={customPrompt}
            onChange={(e) => onPromptChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
