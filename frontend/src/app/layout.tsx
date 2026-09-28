"use client";
import './globals.css';
import { Source_Sans_3 } from 'next/font/google';
import { Toaster } from 'sonner';
import Sidebar from '@/components/Sidebar';
import MainContent from '@/components/MainContent';
import { SidebarProvider } from '@/components/Sidebar/SidebarProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RecordingStateProvider } from '@/contexts/RecordingStateContext';
import { TranscriptProvider } from '@/contexts/TranscriptContext';
import { ConfigProvider } from '@/contexts/ConfigContext';
import { RecordingPostProcessingProvider } from '@/contexts/RecordingPostProcessingProvider';
const font = Source_Sans_3({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-source-sans-3' });
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body className={`${font.variable} font-sans antialiased`}>
    <RecordingStateProvider><TranscriptProvider><ConfigProvider><SidebarProvider><TooltipProvider>
      <RecordingPostProcessingProvider><div className="flex"><Sidebar /><MainContent>{children}</MainContent></div></RecordingPostProcessingProvider>
      <Toaster richColors />
    </TooltipProvider></SidebarProvider></ConfigProvider></TranscriptProvider></RecordingStateProvider>
  </body></html>;
}
