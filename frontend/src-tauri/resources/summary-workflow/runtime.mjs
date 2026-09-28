import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { startOpenVino } from './runtime-openvino.mjs';

// Only the child started here is owned or stopped. Never attach to another model server.
export async function startModel(directory, signal) {
  if (process.env.MEETILY_WORKFLOW_BACKEND === 'openvino') return startOpenVino(directory, signal);
  const server = process.env.MEETILY_WORKFLOW_SERVER, model = process.env.MEETILY_WORKFLOW_MODEL;
  if (!server || !model || !fs.existsSync(server) || !fs.existsSync(model))
    throw new Error('Configured llama.cpp server or Qwen3.5-4B model is missing');
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const args = ['-m', model, '-a', 'Qwen3.5-4B', '--host', '127.0.0.1', '--port', String(port),
    '-c', '6144', '-np', '1', '-t', '2', '-tb', '2', '-b', '64', '-ub', '64', '-ngl', '0',
    '--device', 'none', '--load-mode', 'none', '--fit', 'off', '--cache-ram', '0',
    '--no-context-shift', '--jinja', '--reasoning', 'off', '--reasoning-format', 'deepseek'];
  const output = fs.openSync(path.join(directory, 'model.stdout.log'), 'a');
  const errors = fs.openSync(path.join(directory, 'model.stderr.log'), 'a');
  const child = spawn(server, args, { stdio: ['ignore', output, errors], windowsHide: true });
  fs.closeSync(output); fs.closeSync(errors);
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const exited = new Promise(resolve => child.once('close', resolve));
  const kill = () => { if (child.exitCode === null) child.kill('SIGKILL'); };
  process.once('exit', kill);
  const stop = async () => { kill(); await exited; process.removeListener('exit', kill); };
  fs.writeFileSync(path.join(directory, 'model-process.json'), JSON.stringify({ pid: child.pid, server, args }));
  try {
    const deadline = Date.now() + 60000;
    while (true) {
      signal.throwIfAborted();
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode) throw new Error('Local model server exited');
      try {
        const response = await fetch(base + '/health', { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
        if (response.ok) return { base, stop };
      } catch (error) { if (signal.aborted) throw error; }
      if (Date.now() > deadline) throw new Error('Local model server startup timed out');
      await sleep(100, undefined, { signal });
    }
  } catch (error) { await stop(); throw error; }
}
