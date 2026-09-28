'use client';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type Model = 'builtin' | 'intranet';
export default function SettingsPage() {
  const [model, setModel] = useState<Model | null>(null);
  const [saving, setSaving] = useState(false), [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void invoke<Model>('get_summary_model').then(value => { if (active) setModel(value); })
      .catch(() => { if (active) setMessage('无法读取总结模型设置，请重新打开此页。'); });
    return () => { active = false; };
  }, []);
  const choose = async (value: Model) => {
    if (saving || value === model) return;
    setSaving(true); setMessage('');
    try { await invoke('set_summary_model', { model: value }); setModel(value); setMessage('已保存'); }
    catch { setMessage('保存失败，请重试。'); }
    finally { setSaving(false); }
  };
  return <main className="h-full overflow-y-auto bg-white px-6 py-8">
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-8 text-2xl font-semibold">设置</h1>
      <fieldset disabled={model === null || saving}>
        <legend className="mb-3 text-base font-medium">总结模型</legend>
        <div className="space-y-3">
          {([['builtin', '内置模型（Qwen3-1.7B）'], ['intranet', '内网模型（Qwen3.5-35B-A3B）']] as const).map(([value, label]) =>
            <label key={value} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-4 ${model === value ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}>
              <input type="radio" name="summary-model" value={value} checked={model === value} onChange={() => void choose(value)} />
              <span>{label}</span>
            </label>)}
        </div>
        <p className="mt-4 text-sm leading-6 text-gray-600">用于新会议的会中笔记、会后总结，以及手动重新生成的纪要。进行中的会议继续使用开始时选择的模型。</p>
      </fieldset>
      <p role="status" className="mt-4 text-sm text-gray-600">{saving ? '正在保存…' : message || (model === null ? '正在读取设置…' : '')}</p>
    </div>
  </main>;
}
