// 生成可直接上传到云托管平台的发布目录。
// 平台限制：只暴露一个 HTTP 端口；上传时排除 node_modules 和名为 dist 的构建产物目录。
// 因此本脚本把共享8D引擎 dist 复制为 engine，代码侧 dist/engine 两种布局都支持。
//
// 用法：
//   node online-publish/build-online.mjs --out ../quality-online [--data local-app/data/test]
//
// 上传平台时使用：
//   安装命令：npm ci --prefix local-app
//   启动命令：node local-app/start-online.mjs
//   端口：平台注入 PORT

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = name => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1] || ''; };

const out = argValue('--out');
if (!out) {
  console.error('缺少 --out：请指定发布目录，例如 --out ../quality-online');
  process.exit(1);
}
const outDir = path.resolve(out);
const dataSource = argValue('--data');

const copyDirs = ['lib', 'public', 'assets', 'examples', 'scripts'];
const copyFiles = ['server.mjs', 'start-online.mjs', 'package.json', 'package-lock.json'];
const skipNames = new Set(['node_modules', 'runtime', 'test', 'test-results', '.run', 'logs', 'data', 'upgrade-backups']);

function copyTree(from, to) {
  fs.mkdirSync(to, {recursive: true});
  for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
    if (skipNames.has(entry.name) || entry.name.startsWith('.')) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

// 先校验输入，避免生成到一半留下残目录
const distDir = path.join(root, 'dist');
if (!fs.existsSync(path.join(distDir, 'analysis-core.js'))) {
  console.error('缺少共享8D引擎：dist/analysis-core.js 不存在');
  process.exit(1);
}
const appDir = path.join(root, 'local-app');
for (const name of copyFiles) {
  if (!fs.existsSync(path.join(appDir, name))) { console.error(`缺少必需文件：local-app/${name}`); process.exit(1); }
}
let dataDir = '';
if (dataSource) {
  dataDir = path.resolve(dataSource);
  if (!fs.existsSync(path.join(dataDir, 'quality.sqlite'))) { console.error(`数据目录无效：${dataDir}`); process.exit(1); }
}

if (fs.existsSync(outDir)) {
  if (!fs.existsSync(path.join(outDir, 'local-app'))) {
    console.error(`目标目录已存在且不像发布目录，已停止：${outDir}`);
    process.exit(1);
  }
  fs.rmSync(outDir, {recursive: true, force: true});
}
fs.mkdirSync(outDir, {recursive: true});

// 共享引擎：dist → engine
fs.cpSync(distDir, path.join(outDir, 'engine'), {recursive: true});

// 应用源码
const outApp = path.join(outDir, 'local-app');
fs.mkdirSync(outApp, {recursive: true});
for (const name of copyDirs) {
  const from = path.join(appDir, name);
  if (fs.existsSync(from)) copyTree(from, path.join(outApp, name));
}
for (const name of copyFiles) {
  fs.copyFileSync(path.join(appDir, name), path.join(outApp, name));
}

// 可选：随包携带合成测试数据（含固定测试账号与假数据，仅用于演示环境）
if (dataDir) {
  fs.cpSync(dataDir, path.join(outApp, 'data', 'test'), {recursive: true, filter: source => !/quality\.sqlite-(wal|shm)$/.test(source) && !/[\\/]restore-check([\\/]|$)/.test(source)});
}

const required = ['engine/analysis-core.js', 'local-app/server.mjs', 'local-app/start-online.mjs', 'local-app/package-lock.json'];
const missing = required.filter(name => !fs.existsSync(path.join(outDir, name)));
if (missing.length) {
  console.error('发布目录校验失败，缺少：' + missing.join('、'));
  process.exit(1);
}

console.log(JSON.stringify({
  out: outDir,
  hasData: !!dataDir,
  install: 'npm ci --prefix local-app',
  start: 'node local-app/start-online.mjs',
  note: '端口由平台注入 PORT；QUALITY_ALLOWED_ORIGINS 默认 .workbuddy.host，换平台需改为实际域名后缀'
}, null, 2));
