import type { ModalType } from '@/hooks/useModalState';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
export function SettingsModals({ modals, messages, onClose }: {
  modals: Record<ModalType, boolean>;
  messages: { errorAlert: string; chunkDropWarning: string; modelSelector: string };
  onClose: (name: ModalType) => void;
}) {
  const name = modals.modelSelector ? 'modelSelector' : modals.errorAlert ? 'errorAlert' : 'chunkDropWarning';
  return <Dialog open={modals.modelSelector || modals.errorAlert || modals.chunkDropWarning} onOpenChange={open => { if (!open) onClose(name); }}>
    <DialogContent><DialogTitle>{name === 'modelSelector' ? '语音模型不可用' : '会议录制提示'}</DialogTitle>
      <DialogDescription>{name === 'modelSelector' ? '本地语音服务尚未就绪。请检查模型文件和离线服务，恢复后重新开始会议。'
        : name === 'chunkDropWarning' ? '部分音频未能及时处理，请检查设备和系统负载。已保存的内容仍然保留。' : '录制遇到问题，请检查音频设备、权限和本地语音服务后重试。'}</DialogDescription>
      {messages[name] && <details className="text-sm"><summary>诊断信息</summary><pre className="whitespace-pre-wrap break-all">{messages[name]}</pre></details>}
      <Button onClick={() => onClose(name)}>知道了</Button>
    </DialogContent>
  </Dialog>;
}
