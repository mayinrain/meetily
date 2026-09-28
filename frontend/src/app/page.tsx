'use client';

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RecordingControls } from '@/components/RecordingControls';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import Analytics from '@/lib/analytics';
import { SettingsModals } from './_components/SettingsModal';
import { TranscriptPanel } from './_components/TranscriptPanel';
import { useModalState } from '@/hooks/useModalState';
import { useRecordingStateSync } from '@/hooks/useRecordingStateSync';
import { useRecordingStart } from '@/hooks/useRecordingStart';
import { useRecordingStop } from '@/hooks/useRecordingStop';
import { useTranscriptRecovery } from '@/hooks/useTranscriptRecovery';
import { TranscriptRecovery } from '@/components/TranscriptRecovery';
import { indexedDBService } from '@/services/indexedDBService';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { DeviceSelection } from '@/components/DeviceSelection';
import { MeetingDetailsSplitView, type MeetingDetailsTab } from '@/components/MeetingDetails/MeetingDetailsSplitView';
import { SummaryProgressPanel, audioTime } from '@/components/SummaryProgress';
import { useSummaryProgress } from '@/hooks/useSummaryProgress';

export default function Home() {
  // Local page state (not moved to contexts)
  const [isRecording, setIsRecordingState] = useState(false);
  const barHeights: string[] = [];
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);

  // Use contexts for state management
  const { meetingTitle, setMeetingTitle } = useTranscripts();
  const { transcriptModelConfig, selectedDevices, setSelectedDevices } = useConfig();
  const recordingState = useRecordingState();

  // Extract status from global state
  const { status, isStopping, isProcessing, isSaving } = recordingState;

  // Hooks
  const { setIsMeetingActive, refetchMeetings } = useSidebar();
  const { modals, messages, showModal, hideModal } = useModalState(transcriptModelConfig);
  const { isRecordingDisabled, setIsRecordingDisabled } = useRecordingStateSync(isRecording, setIsRecordingState, setIsMeetingActive);
  const { handleRecordingStart } = useRecordingStart(isRecording, setIsRecordingState, showModal);

  const startMeeting = useCallback(async () => {
    await invoke('stop_audio_level_monitoring');
    await handleRecordingStart();
  }, [handleRecordingStart]);

  // Get handleRecordingStop function and setIsStopping (state comes from global context)
  const { handleRecordingStop, setIsStopping } = useRecordingStop(
    setIsRecordingState,
    setIsRecordingDisabled
  );

  const stopMeeting = useCallback((callApi = true) => handleRecordingStop(callApi), [handleRecordingStop]);
  const showTranscriptionError = useCallback((message: string) => showModal('errorAlert', message), [showModal]);

  // Recovery hook
  const {
    recoverableMeetings,
    isLoading: isLoadingRecovery,
    isRecovering,
    checkForRecoverableTranscripts,
    recoverMeeting,
    loadMeetingTranscripts,
    deleteRecoverableMeeting
  } = useTranscriptRecovery();

  const router = useRouter();
  const [activeTab, setActiveTab] = useState<MeetingDetailsTab>('transcript');
  const activeMeeting = recordingState.isRecording || isStopping || isProcessing || isSaving;
  const summaryProgress = useSummaryProgress(undefined, activeMeeting);
  useEffect(() => {
    if (sessionStorage.getItem('meeting-workspace-tab') === 'summary') setActiveTab('summary');
  }, []);

  useEffect(() => {
    // Track page view
    Analytics.trackPageView('home');
  }, []);

  // Startup recovery check
  useEffect(() => {
    const performStartupChecks = async () => {
      try {
        // Skip recovery check if currently recording or processing stop
        // This prevents the recovery dialog from showing when:
        if (recordingState.isRecording ||
          status === RecordingStatus.STOPPING ||
          status === RecordingStatus.PROCESSING_TRANSCRIPTS ||
          status === RecordingStatus.SAVING) {
          console.log('Skipping recovery check - recording in progress or processing');
          return;
        }

        // 1. Clean up old meetings (7+ days)
        try {
          await indexedDBService.deleteOldMeetings(7);
        } catch (error) {
          console.warn('⚠️ Failed to clean up old meetings:', error);
        }

        // 2. Clean up saved meetings (24+ hours after save)
        try {
          await indexedDBService.deleteSavedMeetings(24);
        } catch (error) {
          console.warn('⚠️ Failed to clean up saved meetings:', error);
        }

        // 3. Always check for recoverable meetings on startup
        // Don't skip based on sessionStorage - we need to check every time
        await checkForRecoverableTranscripts();
      } catch (error) {
        console.error('Failed to perform startup checks:', error);
      }
    };

    performStartupChecks();
  }, [checkForRecoverableTranscripts, recordingState.isRecording, status]);

  // Watch for recoverable meetings changes and show dialog once per session
  useEffect(() => {
    // Only show dialog if we have meetings and haven't shown it yet this session
    if (recoverableMeetings.length > 0) {
      const shownThisSession = sessionStorage.getItem('recovery_dialog_shown');
      if (!shownThisSession) {
        setShowRecoveryDialog(true);
        sessionStorage.setItem('recovery_dialog_shown', 'true');
      }
    }
  }, [recoverableMeetings]);

  // Handle recovery with toast notifications and navigation
  const handleRecovery = async (meetingId: string) => {
    try {
      const result = await recoverMeeting(meetingId);

      if (result.success) {
        toast.success('会议已恢复', {
          description: result.audioRecoveryStatus?.status === 'success'
            ? '转写和录音已恢复'
            : '转写已恢复，暂无录音',
          action: result.meetingId ? {
            label: '查看会议',
            onClick: () => {
              router.push(`/meeting-details?id=${result.meetingId}`);
            }
          } : undefined,
          duration: 10000,
        });

        // Refresh sidebar to show the newly recovered meeting
        await refetchMeetings();

        // If no more recoverable meetings, clear session flag so dialog can show again
        if (recoverableMeetings.length === 0) {
          sessionStorage.removeItem('recovery_dialog_shown');
        }

        // Auto-navigate after a short delay
        if (result.meetingId) {
          setTimeout(() => {
            router.push(`/meeting-details?id=${result.meetingId}`);
          }, 2000);
        }
      }
    } catch (error) {
      toast.error('恢复会议失败', {
        description: '请检查本地会议文件和保存目录权限后重试。',
      });
      throw error;
    }
  };

  // Handle dialog close - clear session flag if no meetings left
  const handleDialogClose = () => {
    setShowRecoveryDialog(false);
    // If user closes dialog and there are no more meetings, clear the flag
    // This allows the dialog to show again next session if new meetings appear
    if (recoverableMeetings.length === 0) {
      sessionStorage.removeItem('recovery_dialog_shown');
    }
  };

  // Computed values using global status
  const isProcessingStop = status === RecordingStatus.PROCESSING_TRANSCRIPTS || isProcessing;

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* All Modals supported*/}
      <SettingsModals
        modals={modals}
        messages={messages}
        onClose={hideModal}
      />

      {/* Recovery Dialog */}
      <TranscriptRecovery
        isOpen={showRecoveryDialog}
        onClose={handleDialogClose}
        recoverableMeetings={recoverableMeetings}
        onRecover={handleRecovery}
        onDelete={deleteRecoverableMeeting}
        onLoadPreview={loadMeetingTranscripts}
      />
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-white px-5 py-4">
        <div className="min-w-0 flex-1">
          {activeMeeting ? <h1 className="break-words text-lg font-semibold">{meetingTitle || '会议进行中'}</h1>
            : <h1 className="text-lg font-semibold">开始会议</h1>}
          {activeMeeting && <p className="mt-1 text-sm text-gray-600">{recordingState.isPaused ? '已暂停' : isSaving ? '正在保存会议' : isProcessingStop ? '正在收尾转写' : '会议进行中'} · {audioTime(recordingState.activeDuration || 0)}</p>}
        </div>
        {activeMeeting && <RecordingControls isRecording={recordingState.isRecording}
          onRecordingStop={stopMeeting} onRecordingStart={startMeeting}
          onTranscriptReceived={() => {}} onStopInitiated={() => setIsStopping(true)} barHeights={barHeights}
          onTranscriptionError={showTranscriptionError}
          isRecordingDisabled={isRecordingDisabled} isParentProcessing={isProcessingStop || isSaving} />}
      </header>
      {!activeMeeting ? <div className="flex-1 overflow-y-auto bg-white p-6">
        <div className="mx-auto max-w-xl space-y-6 py-6">
          <div><label htmlFor="meeting-title" className="mb-2 block text-sm font-medium">会议标题</label>
            <input id="meeting-title" className="w-full rounded-md border border-gray-300 p-3 text-sm" placeholder="未填写时按开始时间命名"
              value={meetingTitle} onChange={e => setMeetingTitle(e.target.value)} /></div>
          <DeviceSelection selectedDevices={selectedDevices} onDeviceChange={setSelectedDevices} disabled={recordingState.isStartingRecording} />
          <RecordingControls isRecording={false} onRecordingStop={stopMeeting} onRecordingStart={startMeeting}
            onTranscriptReceived={() => {}} barHeights={barHeights}
            onTranscriptionError={showTranscriptionError}
            isRecordingDisabled={isRecordingDisabled} isParentProcessing={false} />
        </div>
      </div> : <MeetingDetailsSplitView activeTab={activeTab} onTabChange={tab => {
        setActiveTab(tab); sessionStorage.setItem('meeting-workspace-tab', tab);
      }} transcript={<TranscriptPanel isProcessingStop={isProcessingStop} isStopping={isStopping} showModal={showModal} />}
        summary={<SummaryProgressPanel progress={summaryProgress} />} />}
    </div>
  );
}
