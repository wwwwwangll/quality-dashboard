// PUBLISH-001-R1：托管数据导出与启动保护。
//
// 覆盖：
//   1. 启动器遇到无法确认归属的 -wal/-shm：保留文件、停止启动、给出可操作提示；
//   2. 停止启动后，-wal 里已提交但未写回主库的记录仍然可读（不丢数据）；
//   3. 导出工具拒绝覆盖已有目录、拒绝与源目录重叠的输出路径；
//   4. 正常导出：把 -wal 里的已提交记录带进自包含库，可读回，且源库字节不变；
//   5. 源库损坏：不产出任何可发布目录。
//
// 只用临时合成数据，不接触交付包、线上库或真实数据。
// 运行：local-app/runtime/node.exe --test local-app/test/online-publish.test.mjs

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const root = path.resolve(appDir, '..');
const launcher = path.join(appDir, 'start-online.mjs');
const exporter = path.join(root, 'online-publish', 'make-online-data.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quality-publish-test-'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// 造一个「已提交但仍在 -wal 里」的源库：写入后不 close、不 checkpoint，直接退出进程。
// 这样主库里没有这些行，只有 -wal 有；任何“删掉 -wal”的做法都会丢数据。
function makeSource(dir, rows = 3) {
  fs.mkdirSync(dir, {recursive: true});
  const scripts = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-publish-fixture-'));
  const scriptFile = path.join(scripts, 'make-wal.mjs');
  fs.writeFileSync(scriptFile, [
    "import {DatabaseSync} from 'node:sqlite';",
    'const [file, count] = process.argv.slice(2);',
    'const db = new DatabaseSync(file);',
    "db.exec('PRAGMA journal_mode=WAL');",
    "db.exec('PRAGMA wal_autocheckpoint=0');",
    "db.exec('CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id))');",
    "const insert = db.prepare('INSERT INTO records VALUES(?,?,?,?,?)');",
    "for (let i = 1; i <= Number(count); i += 1) insert.run('faults', 'F-WAL-' + i, JSON.stringify({id: 'F-WAL-' + i, product: '合成件' + i}), 1, '2026-01-01T00:00:00.000Z');",
    'process.exit(0);'
  ].join('\n'));
  const db = path.join(dir, 'quality.sqlite');
  const run = spawnSync(process.execPath, [scriptFile, db, String(rows)], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.ok(fs.existsSync(db + '-wal'), '合成源库应留下 -wal');
  assert.ok(fs.statSync(db + '-wal').size > 0, '-wal 不应为空');
  return db;
}

function runLauncher(dataDir) {
  return spawnSync(process.execPath, [launcher], {
    encoding: 'utf8',
    timeout: 60000,
    env: {...process.env, PORT: '0', QUALITY_ENV: 'test', QUALITY_DATA_DIR: dataDir}
  });
}

const runExport = (args, timeout = 120000) => spawnSync(process.execPath, [exporter, ...args], {encoding: 'utf8', timeout});

test('启动器：遇到无法确认归属的 -wal 时保留文件并停止启动', () => {
  const dir = tmp();
  const db = makeSource(dir, 2);
  const before = {db: sha(db), wal: sha(db + '-wal')};

  const run = runLauncher(dir);

  assert.equal(run.status, 2, '应以退出码 2 停止启动，实际输出：' + run.stdout + run.stderr);
  assert.match(run.stderr, /无法确认归属/);
  assert.match(run.stderr, /quality\.sqlite-wal/);
  assert.match(run.stderr, /wal_checkpoint/, '应给出可操作的恢复命令');
  assert.match(run.stderr, /移走，不是删除/);
  assert.doesNotMatch(run.stdout, /云托管服务/, '不应真的启动服务');

  assert.ok(fs.existsSync(db + '-wal'), '-wal 必须原样保留');
  assert.equal(sha(db + '-wal'), before.wal, '-wal 内容不得被改动');
  assert.equal(sha(db), before.db, '主库内容不得被改动');
});

test('停止启动后，-wal 里已提交但未写回主库的记录仍然可读', () => {
  const dir = tmp();
  const db = makeSource(dir, 3);

  const run = runLauncher(dir);
  assert.equal(run.status, 2);
  assert.ok(fs.existsSync(db + '-wal'), '拒绝启动后 -wal 仍应在');

  // 按提示的方式打开一次：SQLite 会回放 -wal，已提交的行必须还在
  const conn = new DatabaseSync(db);
  try {
    assert.deepEqual(conn.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check), ['ok']);
    assert.deepEqual(conn.prepare('SELECT id FROM records ORDER BY id').all().map(r => r.id), ['F-WAL-1', 'F-WAL-2', 'F-WAL-3']);
  } finally {
    conn.close();
  }
});

test('导出工具：拒绝覆盖已有目录，且不清空原内容', () => {
  const base = tmp();
  const src = path.join(base, 'data', 'test');
  makeSource(src, 1);
  const out = path.join(base, 'existing');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'keep.txt'), '不要动我', 'utf8');

  const run = runExport(['--from', src, '--out', out]);

  assert.equal(run.status, 4, run.stdout + run.stderr);
  assert.match(run.stderr, /输出目录已存在/);
  assert.equal(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8'), '不要动我');
  assert.ok(!fs.existsSync(path.join(out, 'quality.sqlite')), '不得写入任何数据库文件');
});

test('导出工具：拒绝与源目录重叠的输出路径', () => {
  const base = tmp();
  const src = path.join(base, 'data', 'test');
  makeSource(src, 1);

  const inside = runExport(['--from', src, '--out', path.join(src, 'publish')]);
  assert.equal(inside.status, 4, inside.stdout + inside.stderr);
  assert.match(inside.stderr, /源目录内部/);
  assert.ok(!fs.existsSync(path.join(src, 'publish')));

  const same = runExport(['--from', src, '--out', src]);
  assert.equal(same.status, 4, same.stdout + same.stderr);
  assert.ok(fs.existsSync(path.join(src, 'quality.sqlite')), '源库必须还在');
});

test('导出工具：正常导出，带上 -wal 里的已提交记录，且不改动源库', () => {
  const base = tmp();
  const src = path.join(base, 'data', 'test');
  const db = makeSource(src, 4);
  const before = {db: sha(db), wal: sha(db + '-wal')};
  const out = path.join(base, 'published');

  const run = runExport(['--from', src, '--out', out]);
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const info = JSON.parse(run.stdout);
  assert.equal(info.ok, true);
  assert.equal(info.sourceWalUsed, true, '应识别并带上 -wal');
  assert.deepEqual(info.sourceIntegrity, ['ok']);
  assert.deepEqual(info.exportIntegrity, ['ok']);
  assert.equal(info.records.faults, 4, '导出库应包含 -wal 里的 4 条已提交记录');
  assert.equal(info.journalMode, 'delete');
  assert.ok(!fs.existsSync(path.join(out, 'quality.sqlite-wal')), '导出目录不应带 -wal');

  const conn = new DatabaseSync(path.join(out, 'quality.sqlite'), {readOnly: true});
  try {
    assert.deepEqual(conn.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check), ['ok']);
    assert.deepEqual(conn.prepare('SELECT id FROM records ORDER BY id').all().map(r => r.id), ['F-WAL-1', 'F-WAL-2', 'F-WAL-3', 'F-WAL-4']);
  } finally {
    conn.close();
  }

  assert.equal(sha(db), before.db, '源主库字节不应变化');
  assert.equal(sha(db + '-wal'), before.wal, '源 -wal 字节不应变化（没有被回放或截断）');
});

test('导出工具：源目录下名为 ..export 的输出也按“内部”拒绝', () => {
  const base = tmp();
  const src = path.join(base, 'data', 'test');
  makeSource(src, 1);
  const out = path.join(src, '..export'); // 字面以 .. 开头，但它是源目录里的一个普通目录名

  const run = runExport(['--from', src, '--out', out]);

  assert.equal(run.status, 4, '应以 4（危险输出路径）退出，实际：' + run.stdout + run.stderr);
  assert.match(run.stderr, /源目录内部/);
  assert.ok(!fs.existsSync(out), '不得创建 ..export 目录');
});

test('导出工具：输出父目录经 junction 指回源目录时同样拒绝', () => {
  const base = tmp();
  const src = path.join(base, 'data', 'test');
  makeSource(src, 1);
  const link = path.join(base, 'link');
  fs.symlinkSync(src, link, 'junction');
  const out = path.join(link, 'published');

  const run = runExport(['--from', src, '--out', out]);

  assert.equal(run.status, 4, '应以 4（危险输出路径）退出，实际：' + run.stdout + run.stderr);
  assert.match(run.stderr, /源目录内部/);
  assert.match(run.stderr, /经链接解析后/, '提示里应显示真实路径，便于排查');
  assert.ok(!fs.existsSync(path.join(src, 'published')), '不得经 junction 在源目录里建目录');
  assert.ok(!fs.existsSync(out), '不得创建该输出目录');
});

test('导出工具：真实路径无法确认时明确报错，且在创建任何目录前停止', () => {
  const base = tmp();
  const src = path.join(base, 'data', 'test');
  makeSource(src, 1);

  // 自指 junction：解析它稳定报 ELOOP，不需要管理员权限，可重复复现
  const loop = path.join(base, 'loop');
  fs.symlinkSync(loop, loop, 'junction');
  const out = path.join(loop, 'published');

  const stagingPrefix = 'quality-publish-export-';
  const stagingBefore = new Set(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(stagingPrefix)));

  let run;
  try {
    run = runExport(['--from', src, '--out', out]);

    assert.equal(run.status, 4, '应以 4（危险输出路径）退出，实际：' + run.stdout + run.stderr);
    assert.match(run.stderr, /无法确认真实路径/, '应明确说明真实路径无法确认，而不是猜一个路径继续判断');
    assert.match(run.stderr, /ELOOP/, '应带上具体错误码，便于排查');
    assert.match(run.stderr, /本次没有创建任何目录/);

    assert.ok(!fs.existsSync(out), '不得创建输出目录');
    const strays = fs.readdirSync(src).filter(name => !/^quality\.sqlite(-wal|-shm)?$/.test(name));
    assert.deepEqual(strays, [], '源目录内不应出现新文件或新目录');

    const stagingAfter = fs.readdirSync(os.tmpdir())
      .filter(name => name.startsWith(stagingPrefix) && !stagingBefore.has(name));
    assert.deepEqual(stagingAfter, [], '不应创建临时导出目录');
  } finally {
    try { fs.unlinkSync(loop); } catch {} // 先摘掉 junction，再删临时根，避免递归进环
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test('导出工具：源库损坏时不产出任何发布目录', () => {
  const base = tmp();
  const src = path.join(base, 'data', 'test');
  const db = makeSource(src, 500);

  // 先把 -wal 合并进主库（模拟一份“已经落盘”的库），再破坏中间的数据页
  const merge = new DatabaseSync(db);
  try { merge.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { merge.close(); }

  const fd = fs.openSync(db, 'r+');
  try {
    const garbage = Buffer.alloc(4096, 0xa5);
    const size = fs.statSync(db).size;
    for (let offset = 4096; offset + garbage.length <= size && offset < 4096 * 9; offset += 4096) fs.writeSync(fd, garbage, 0, garbage.length, offset);
  } finally {
    fs.closeSync(fd);
  }

  const out = path.join(base, 'published');
  const run = runExport(['--from', src, '--out', out]);

  assert.equal(run.status, 3, '应以 3（校验/导出失败）退出，实际：' + run.stdout + run.stderr);
  assert.match(run.stderr, /导出失败/);
  assert.ok(!fs.existsSync(out), '校验失败时不得留下输出目录');
});
