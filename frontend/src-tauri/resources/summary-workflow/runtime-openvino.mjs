import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export async function startOpenVino(directory, signal, device = 'CPU') {
  const python = process.env.MEETILY_WORKFLOW_SERVER, model = process.env.MEETILY_WORKFLOW_MODEL;
  if (!python || !model || !fs.existsSync(python) || !fs.existsSync(model))
    throw new Error('Configured OpenVINO Python or Qwen3-1.7B weights are missing');
  const log = fs.openSync(path.join(directory, 'openvino-server.log'), 'a');
  const child = spawn(python, ['-u', fileURLToPath(new URL('./openvino-server.py', import.meta.url)),
    path.dirname(model), directory, '--device', device], { stdio: ['ignore', log, log], windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1' } });
  fs.closeSync(log);
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const exited = new Promise(resolve => child.once('close', resolve));
  const kill = () => {
    if (child.exitCode !== null || !child.pid) return;
    // Windows venv Python launches a child interpreter; release only our own tree.
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
      catch { if (child.exitCode === null) child.kill(); }
    } else child.kill();
  };
  process.once('exit', kill);
  const stop = async () => { kill(); await exited; process.removeListener('exit', kill); };
  try {
    const ready = path.join(directory, 'openvino-server.json'), began = Date.now();
    while (true) {
      signal.throwIfAborted();
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode) throw new Error('OpenVINO server exited before ready');
      if (fs.existsSync(ready)) {
        const state = JSON.parse(fs.readFileSync(ready, 'utf8'));
        fs.writeFileSync(path.join(directory, 'model-process.json'), JSON.stringify({
          pid: state.pid, server: python, model, backend: 'openvino', device: state.device }));
        return { ...state, id: 'Qwen3-1.7B', stop };
      }
      if (Date.now()-began > 120000) throw new Error('OpenVINO startup exceeded 120 seconds');
      await sleep(100, undefined, { signal });
    }
  } catch (error) { await stop(); throw error; }
}
