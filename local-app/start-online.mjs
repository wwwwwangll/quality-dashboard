// 云托管发布入口：监听平台注入的 PORT、绑定 0.0.0.0、适配反向代理。
// 本机使用请继续用 scripts/start.ps1 或「立即启动.cmd」，本文件不改变本机启动方式。
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const self = fileURLToPath(import.meta.url);
const major = Number(process.versions.node.split('.')[0]);

// node:sqlite 在 Node 22.5–23.3 需要实验开关；Node 24 起无需
if (major < 24 && !process.execArgv.includes('--experimental-sqlite')) {
  const child = spawn(process.execPath, ['--experimental-sqlite', self], {stdio: 'inherit', env: process.env});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
} else {
  const here = path.dirname(self);

  // 托管环境通常是 Node 22 LTS，显式允许 22.5 以上；本机仍按 24.x 校验
  process.env.QUALITY_ALLOW_NODE22 = process.env.QUALITY_ALLOW_NODE22 || '1';
  process.env.QUALITY_ENV = process.env.QUALITY_ENV || 'test';
  process.env.QUALITY_DATA_DIR = process.env.QUALITY_DATA_DIR || path.join(here, 'data', 'test');
  // 反代会改写 Host 并提供 X-Forwarded-*，需要信任代理才能取到 https 协议
  process.env.QUALITY_TRUST_PROXY = process.env.QUALITY_TRUST_PROXY || '1';
  // 反代改写 Host 后主机名校验放行，跨站校验改由域名白名单判断
  process.env.QUALITY_ALLOWED_HOSTS = process.env.QUALITY_ALLOWED_HOSTS || '*';
  process.env.QUALITY_ALLOWED_ORIGINS = process.env.QUALITY_ALLOWED_ORIGINS || '.workbuddy.host';

  const port = Number(process.env.PORT || process.env.QUALITY_PORT || 3868);
  const {startServer} = await import('./server.mjs');
  const runtime = await startServer({dataDir: process.env.QUALITY_DATA_DIR, environment: process.env.QUALITY_ENV, host: '0.0.0.0', port});
  console.log(`质量管理云托管服务：${runtime.address} （${process.env.QUALITY_ENV}）`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    runtime.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
