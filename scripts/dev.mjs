// 开发脚本：并行启动 Vite（渲染）与 Electron（主进程，加载 dev URL）
import { spawn } from 'node:child_process';

const vite = spawn('npx', ['vite', '--port', '5199', '--strictPort'], { shell: true, stdio: 'inherit' });

const waitFor = (url, timeoutMs = 30000): Promise<void> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const ping = async (): Promise<void> => {
      try {
        const r = await fetch(url);
        if (r.ok) return resolve();
      } catch {
        /* 未就绪 */
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('Vite 启动超时'));
      setTimeout(() => void ping(), 400);
    };
    void ping();
  });

try {
  await waitFor('http://localhost:5199');
} catch (e) {
  vite.kill();
  console.error((e as Error).message);
  process.exit(1);
}

const isWin = process.platform === 'win32';
const npxCmd = isWin ? 'npx.cmd' : 'npx';
const electron = spawn(npxCmd, ['electron', '.'], {
  shell: true,
  stdio: 'inherit',
  env: { ...process.env, HELPWORK_DEV_URL: 'http://localhost:5199' }
});

const bye = (): void => {
  vite.kill();
  electron.kill();
};
electron.on('exit', bye);
process.on('SIGINT', () => {
  bye();
  process.exit(0);
});
