import { Button } from '@/components/ui/button';
import { useMeetingSpeakers } from '@/hooks/useMeetingSpeakers';

export function SpeakerControls({ speakers }: { speakers: ReturnType<typeof useMeetingSpeakers> }) {
  const { state, action, loading, error, speakerIds, name } = speakers;
  const running = state?.job.status === 'running';
  const progress = state?.job.progress;
  return <div className="px-4 py-2 border-b border-gray-200 text-sm space-y-2">
    <div className="flex items-center gap-2 flex-wrap">
      <Button size="sm" variant="outline" disabled={loading || running}
        onClick={() => void action('start_meeting_speakers')}>
        {state?.job.status === 'completed' ? '重新分析说话人' : '分析说话人'}
      </Button>
      {running && <>
        <span role="status">正在处理说话人{progress && progress.audio_duration_s > 0
          ? ` · ${Math.min(100, Math.floor(progress.audio_end_s / progress.audio_duration_s * 100))}%` : '…'}</span>
        <Button size="sm" variant="ghost" disabled={loading}
          onClick={() => void action('cancel_meeting_speakers')}>取消</Button>
      </>}
      {state?.job.status === 'completed' && <span>{speakerIds.length} 位说话人</span>}
    </div>
    {(error || state?.job.error) && <p role="alert" className="text-red-600">{error || state?.job.error}</p>}
    {['cancelled', 'interrupted'].includes(state?.job.status ?? '') && <p>处理已停止，可重新分析。</p>}
    {speakerIds.length > 0 && <details>
      <summary className="cursor-pointer text-gray-600">手动命名说话人</summary>
      <div className="flex gap-2 flex-wrap mt-2">
        {speakerIds.map(id => <label key={`${id}:${name(id)}`} className="flex items-center gap-2">
          <span>说话人 {id}</span>
          <input aria-label={`说话人 ${id} 的显示名称`} defaultValue={state?.names[String(id)] ?? ''}
            placeholder={`说话人 ${id}`} maxLength={80} disabled={loading}
            className="w-32 border rounded px-2 py-1"
            onBlur={event => { if (event.target.value.trim() !== (state?.names[String(id)] ?? ''))
              void action('name_meeting_speaker', { speakerId: id, name: event.target.value }); }} />
        </label>)}
      </div>
      <p className="text-xs text-gray-500 mt-2">名称由你指定；声纹身份登记另行处理。</p>
    </details>}
  </div>;
}
