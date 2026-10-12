import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export const intranetModel = 'Qwen3.8-Flash-Next-UD-Q4_K_XL';
// llama-server bound to loopback on the model host; only reachable through our own forward.
export const intranetPort = 18085;
const temporary = message => Object.assign(new Error(message), { retryable: true });

// The forward belongs to this worker. The remote model server stays running.
export async function startIntranet(directory, signal) {
  const file = process.env.MEETILY_INTRANET_CONFIG;
  if (!file || !fs.existsSync(file)) throw new Error('内网模型连接尚未配置');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!config.host || !config.user || !Number.isInteger(config.port)
      || !fs.existsSync(config.identity_file || '') || !fs.existsSync(config.known_hosts || ''))
    throw new Error('内网模型 SSH 配置或密钥文件不可用');
  const tunnels = new Set();
  let backend;
  async function tunnel(remotePort, requestSignal) {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    requestSignal.throwIfAborted();
    const output = fs.openSync(path.join(directory, 'ssh.log'), 'a');
    const child = spawn(config.ssh || 'ssh', ['-N', '-T', '-p', String(config.port),
      '-i', config.identity_file, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${config.known_hosts}`,
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
      '-L', `127.0.0.1:${port}:127.0.0.1:${remotePort}`, `${config.user}@${config.host}`],
      { stdio: ['ignore', output, output], windowsHide: true });
    fs.closeSync(output);
    const item = { child, base: `http://127.0.0.1:${port}`, error: null };
    item.closed = new Promise(resolve => child.once('close', resolve));
    child.on('error', error => { item.error = error; }); tunnels.add(item);
    return item;
  }
  const isAlive = item => item && !item.error && item.child.exitCode === null && !item.child.signalCode;
  async function json(item, route, requestSignal) {
    // SSH opens its listening socket after authentication, independently of spawn().
    const deadline = Date.now() + 15000;
    while (true) {
      requestSignal.throwIfAborted();
      if (!isAlive(item)) throw temporary('内网模型 SSH 连接已断开，请检查 ssh.log');
      try {
        const response = await fetch(item.base + route, { signal: AbortSignal.any([requestSignal, AbortSignal.timeout(10000)]) });
        if (!response.ok) throw Object.assign(new Error(`内网模型服务 HTTP ${response.status}`),
          { retryable: [408, 425, 429, 500, 502, 503, 504].includes(response.status) });
        return await response.json();
      } catch (error) {
        requestSignal.throwIfAborted();
        if ('retryable' in error) throw error;
        if (Date.now() >= deadline) throw temporary('内网模型连接超时');
        await sleep(250, undefined, { signal: requestSignal });
      }
    }
  }
  async function close(item) {
    if (!item) return;
    if (item.child.exitCode === null && !item.child.signalCode) item.child.kill();
    await item.closed; tunnels.delete(item);
  }
  async function reset() {
    await Promise.all([...tunnels].map(close)); backend = null;
  }
  const kill = () => { for (const item of tunnels) item.child.kill(); };
  process.once('exit', kill);
  return {
    // Repetition guard kept as a safety net; Qwen3.8-Flash-Next did not loop at presence_penalty 0.
    id: intranetModel, retries: 3, rejectRepeatedOutput: true,
    async base(requestSignal = signal) {
      if (isAlive(backend)) return backend.base;
      await reset();
      backend = await tunnel(intranetPort, requestSignal);
      // llama-server answers 503 while weights are still loading; json() treats that as retryable.
      const health = await json(backend, '/health', requestSignal);
      if (health.status !== 'ok') throw temporary('内网模型正在准备，请稍候');
      const models = await json(backend, '/v1/models', requestSignal);
      if (!models.data?.some(m => m.id === intranetModel)) throw new Error('内网模型标识不匹配');
      fs.writeFileSync(path.join(directory, 'model-process.json'), JSON.stringify({
        backend: 'intranet', model: intranetModel, remote_port: intranetPort,
        tunnel_pids: [...tunnels].map(t => t.child.pid) }));
      return backend.base;
    },
    reconnect: reset,
    async stop() { await reset(); process.removeListener('exit', kill); },
  };
}
