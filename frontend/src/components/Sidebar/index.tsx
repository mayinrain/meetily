'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { Plus, Search, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Mic, Settings } from 'lucide-react';
import { useSidebar, type CurrentMeeting } from './SidebarProvider';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';

export default function Sidebar() {
  const router = useRouter();
  const { meetings, currentMeeting, setCurrentMeeting, refetchMeetings, isCollapsed, toggleCollapse,
    searchTranscripts, searchResults, isSearching } = useSidebar();
  const { isRecording, isProcessing, isSaving, isStartingRecording, isStopping } = useRecordingState();
  const { setMeetingTitle } = useTranscripts();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<CurrentMeeting | null>(null);
  const [deleting, setDeleting] = useState<CurrentMeeting | null>(null);
  const [title, setTitle] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => { void searchTranscripts(query); }, 300);
    return () => clearTimeout(timer);
  }, [query, searchTranscripts]);
  const visible = meetings.filter(m => !query.trim() || m.title.toLowerCase().includes(query.toLowerCase()) || searchResults.some(r => r.id === m.id));
  const open = (meeting: CurrentMeeting) => { setCurrentMeeting(meeting); router.push(`/meeting-details?id=${encodeURIComponent(meeting.id)}`); };
  const start = () => {
    if (!isRecording && !isProcessing && !isSaving && !isStartingRecording && !isStopping) setMeetingTitle('');
    setCurrentMeeting(null); router.push('/');
  };
  const save = async () => {
    if (!editing || !title.trim() || busy) return;
    setBusy(true);
    try {
      await invoke('api_save_meeting_title', { meetingId: editing.id, title: title.trim() });
      if (currentMeeting?.id === editing.id) setCurrentMeeting({ ...editing, title: title.trim() });
      await refetchMeetings(); setEditing(null); toast.success('会议已重命名');
    } catch { toast.error('重命名失败，请重试'); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      await invoke('api_delete_meeting', { meetingId: deleting.id });
      if (currentMeeting?.id === deleting.id) { setCurrentMeeting(null); router.push('/'); }
      await refetchMeetings(); setDeleting(null); toast.success('会议已删除');
    } catch { toast.error('删除失败，请重试'); } finally { setBusy(false); }
  };
  return <>
    <aside className={`fixed inset-y-0 left-0 z-20 flex flex-col border-r border-gray-200 bg-gray-50 ${isCollapsed ? 'w-16' : 'w-64'}`} aria-label="会议记录">
      <div className="flex h-16 shrink-0 items-center justify-between px-4">
        {!isCollapsed && <h1 className="text-base font-semibold">会议记录</h1>}
        <button onClick={toggleCollapse} title={isCollapsed ? '展开会议列表' : '收起会议列表'} aria-label={isCollapsed ? '展开会议列表' : '收起会议列表'}>
          {isCollapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
        </button>
      </div>
      <div className="px-3 pb-3">
        <Button onClick={start} className="w-full gap-2" title={isRecording ? '返回进行中的会议' : '开始会议'}>
          {isRecording ? <Mic size={18} /> : <Plus size={18} />}{!isCollapsed && (isRecording ? '会议进行中' : '开始会议')}
        </Button>
      </div>
      {!isCollapsed && <>
        <label className="relative mx-3 mb-4"><Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-600" />
          <Input aria-label="搜索会议" placeholder="搜索会议" value={query} onChange={e => setQuery(e.target.value)} className="pl-8 bg-white" />
        </label>
        <nav className="flex-1 overflow-y-auto px-2 pb-4" aria-label="历史会议">
          {isSearching && <p role="status" className="px-2 py-2 text-sm text-gray-600">正在搜索…</p>}
          {visible.map(meeting => <div key={meeting.id} className={`flex items-center rounded-md ${currentMeeting?.id === meeting.id ? 'bg-blue-50 text-blue-800' : 'hover:bg-gray-100'}`}>
            <button className="min-w-0 flex-1 truncate px-3 py-3 text-left text-sm" title={meeting.title} onClick={() => open(meeting)}>{meeting.title}</button>
            <DropdownMenu><DropdownMenuTrigger asChild><button className="p-2" aria-label={`${meeting.title}的操作`}><MoreHorizontal size={16} /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => { setEditing(meeting); setTitle(meeting.title); }}>重命名</DropdownMenuItem>
                <DropdownMenuItem className="text-red-700" onSelect={() => setDeleting(meeting)}>删除会议</DropdownMenuItem></DropdownMenuContent>
            </DropdownMenu>
          </div>)}
          {!visible.length && <p className="px-3 py-4 text-sm text-gray-600">{query ? '没有找到匹配的会议' : '还没有会议记录，点击“开始会议”创建。'}</p>}
        </nav>
      </>}
      <div className="mt-auto shrink-0 border-t border-gray-200 p-3">
        <Button variant="ghost" className="w-full justify-start gap-2" title="设置" aria-label="设置" onClick={() => router.push('/settings')}>
          <Settings size={18} />{!isCollapsed && '设置'}
        </Button>
      </div>
    </aside>
    <Dialog open={!!editing} onOpenChange={open => { if (!open && !busy) setEditing(null); }}><DialogContent><DialogTitle>重命名会议</DialogTitle><DialogDescription>输入便于查找的会议标题。</DialogDescription>
      <Input aria-label="会议标题" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void save(); }} />
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setEditing(null)}>取消</Button><Button disabled={busy || !title.trim()} onClick={() => void save()}>{busy ? '正在保存…' : '保存'}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={!!deleting} onOpenChange={open => { if (!open && !busy) setDeleting(null); }}><DialogContent><DialogTitle>删除会议</DialogTitle><DialogDescription>确定删除“{deleting?.title}”及其关联数据？此操作无法撤销。</DialogDescription>
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? '正在删除…' : '删除'}</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}
