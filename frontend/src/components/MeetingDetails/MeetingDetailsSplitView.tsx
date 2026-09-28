'use client';
import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
export type MeetingDetailsTab = 'transcript' | 'summary';
export function MeetingDetailsSplitView({ transcript, summary, activeTab, onTabChange }: {
  transcript: ReactNode; summary: ReactNode; activeTab: MeetingDetailsTab; onTabChange: (tab: MeetingDetailsTab) => void;
}) {
  return <Tabs value={activeTab} onValueChange={value => onTabChange(value as MeetingDetailsTab)}
    className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden">
    <TabsList className="h-12 shrink-0 justify-start gap-4 rounded-none border-b border-gray-200 bg-white px-5">
      <TabsTrigger value="transcript" className="px-4">会议转写</TabsTrigger>
      <TabsTrigger value="summary" className="px-4">会议总结</TabsTrigger>
    </TabsList>
    <TabsContent value="transcript" forceMount className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">{transcript}</TabsContent>
    <TabsContent value="summary" forceMount className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">{summary}</TabsContent>
  </Tabs>;
}
