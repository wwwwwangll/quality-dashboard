// 生成可上传的「自包含」数据目录：把 SQLite 压成单文件，不带 -wal/-shm。
//
// 为什么需要它：云托管平台按文件做快照/恢复。SQLite 默认 WAL 模式下，已提交的页可能只存在于
// quality.sqlite-wal 里；发布只替换主库文件时，宿主机上残留的旧 -wal 会被套到新库上，
// 造成索引与数据行不一致（integrity_check 报 row missing from index、接口 500）。
//
// 安全边界（本工具只做这几件事）：
//   1. 只读源目录：先按字节复制主库与 -wal 到临时目录，再对副本做 VACUUM INTO，源库一个字节都不改；
//   2. 只写新目录：输出目录必须不存在，且与源目录互不包含（按真实路径判断，能识别 junction / 符号链接），
//      绝不覆盖、绝不清空已有目录；
//   3. 真实路径确认不了就不做判断：只把 ENOENT（这一段确实不存在）当作“可以继续往上找父目录”；
//      遇到 EACCES / EPERM / ELOOP 等错误，说明路径本身无法解析，直接以退出码 4 停止，
//      并在创建任何临时目录或输出目录之前退出——不猜一个路径去做包含关系判断；
//   4. 不动源库日志：不执行 PRAGMA wal_checkpoint，也不原地打开源库；
//   5. 校验不合格就不产出：源（副本）或导出库任一 integrity_check 失败，都不留下可发布目录。
//
// 前置条件（不满足就不要导出）：
//   源目录必须处于「停写」状态，且所有数据库连接都已关闭（停掉服务、确认没有进程占用）。
//   本工具校验的是复制那一刻的文件内容，integrity_check 只能说明这份副本自身是完整的，
//   不能证明导出期间源库没被写入，也不构成并发快照一致性的保证。
//
// 用法：
//   node online-publish/make-online-data.mjs --from local-app/data/test --out ../quality-online-data
// 输出目录可直接作为 build-online.mjs 的 --data 参数：
//   node online-publish/build-online.mjs --out ../quality-online --data ../quality-online-data
//
// 退出码：0 成功；1 参数错误；2 源目录/源库不可用；3 完整性校验或导出失败；4 输出路径危险。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const EXIT = {ok: 0, usage: 1, source: 2, corrupt: 3, unsafeOut: 4};

const args = process.argv.slice(2);
const argValue = name => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1] || ''; };
const rawFrom = argValue('--from');
const rawOut = argValue('--out');

function fail(code, message, hint) {
  console.error('导出失败：' + message);
  if (hint) console.error('处理办法：' + hint);
  process.exit(code);
}

if (!rawFrom || !rawOut) {
  fail(EXIT.usage, '缺少 --from 或 --out。', '例如：node online-publish/make-online-data.mjs --from local-app/data/test --out ../quality-online-data');
}

const fromDir = path.resolve(rawFrom);
const outDir = path.resolve(rawOut);
const sourceDb = path.join(fromDir, 'quality.sqlite');

// ---- 1. 源目录检查（只读） ----
if (!fs.existsSync(fromDir) || !fs.statSync(fromDir).isDirectory()) fail(EXIT.source, '源目录不存在或不是目录：' + fromDir);
if (!fs.existsSync(sourceDb)) fail(EXIT.source, '源目录里没有 quality.sqlite：' + fromDir, '请指向质见的 data/test 这类数据目录。');

// ---- 2. 输出路径检查：必须是不存在的新目录，且与源目录无重叠 ----
// 只比字面路径不够：名字以 `..` 开头的目录（如 `..export`）会被误判成上级目录；
// 输出的父目录也可能是指回源目录的 junction / 符号链接。这里统一换算成「最近已存在父目录的真实路径 +
// 尚未创建的尾段」，再按路径段比较包含关系，避免 ../ 前缀、大小写、junction 造成的漏判。
const realpathOfNearest = target => {
  let current = path.resolve(target);
  const missing = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...missing); }
    catch (error) {
      // 只有「这一段确实不存在」（ENOENT）才可以继续向上找父目录。
      // EACCES / EPERM / ELOOP 等错误说明这个路径本身无法解析：既不能当成「不存在」放行，
      // 也不该猜一个真实路径去做包含关系判断，必须停下来让人处理。
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...missing);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
};
const toSegments = p => realpathOfNearest(p)
  .split(/[\\/]+/)
  .filter(Boolean)
  .map(seg => (process.platform === 'win32' ? seg.toLowerCase() : seg));
const sameDir = (a, b) => toSegments(a).join('/') === toSegments(b).join('/');
const within = (child, parent) => {
  const c = toSegments(child), p = toSegments(parent);
  return c.length > p.length && p.every((seg, index) => c[index] === seg);
};
const resolveHint = raw => {
  const resolved = path.resolve(raw);
  try {
    const real = realpathOfNearest(raw);
    return resolved === real ? real : real + '（传入：' + resolved + '，经链接解析后）';
  } catch (error) {
    // 提示语本身不能因为解析失败而丢掉：退回字面路径，并说明真实路径没确认出来
    return resolved + '（真实路径无法确认：' + (error.code || error.name || '未知错误') + '）';
  }
};

// 三处判断放在同一个 try 里：任何一步无法确认真实路径，都在创建任何目录之前停下。
try {
  if (fs.existsSync(outDir)) {
    fail(EXIT.unsafeOut, '输出目录已存在，拒绝覆盖：' + resolveHint(outDir), '换一个还不存在的目录名，或先自行备份并移走旧目录。本工具不会删除已有目录。');
  }
  if (sameDir(outDir, fromDir) || within(outDir, fromDir)) {
    fail(EXIT.unsafeOut, '输出目录落在源目录内部（已按真实路径判断），会污染源数据：' + resolveHint(outDir), '把 --out 指到源目录之外的新目录；名字以 .. 开头不算“上级目录”。');
  }
  if (within(fromDir, outDir)) {
    fail(EXIT.unsafeOut, '源目录落在输出目录内部（已按真实路径判断），导出会与源数据混在一起：' + resolveHint(outDir), '把 --out 指到与源目录并列或更远的位置。');
  }
} catch (error) {
  // 权限不足、链接成环、路径非法等情况：真实路径无法确认，就不能判断是否重叠，宁可停下。
  // 此处在 mkdtempSync / mkdirSync 之前，磁盘上还没有任何本工具创建的目录。
  const code = error.code || error.name || '未知错误';
  fail(EXIT.unsafeOut, '无法确认真实路径（' + code + '），无法判断输出目录是否与源目录重叠：' + path.resolve(rawOut),
    '确认该路径及其上级目录存在且可访问（权限不足、链接成环、路径非法都会导致无法解析），或换一个可访问的新目录。本次没有创建任何目录。');
}

// ---- 3. 复制到临时目录后再处理，源库全程只读 ----
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-publish-export-'));
const cleanupStaging = () => { try { fs.rmSync(staging, {recursive: true, force: true}); } catch {} };
process.on('exit', cleanupStaging);

const stagedDb = path.join(staging, 'quality.sqlite');
fs.copyFileSync(sourceDb, stagedDb);
const sourceWal = sourceDb + '-wal';
const hasWal = fs.existsSync(sourceWal) && fs.statSync(sourceWal).size > 0;
if (hasWal) fs.copyFileSync(sourceWal, stagedDb + '-wal');

const check = file => {
  const db = new DatabaseSync(file, {readOnly: true});
  try { return db.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check); }
  finally { db.close(); }
};

// 源（副本）完整性：副本与源库字节一致、-wal 也一起带过来了，等价于校验源库当前内容
let sourceCheck;
try {
  const probe = new DatabaseSync(stagedDb);
  try {
    sourceCheck = probe.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check);
    probe.exec('PRAGMA journal_mode=DELETE'); // 只作用于副本：-wal 的内容并回副本主文件
  } finally { probe.close(); }
} catch (error) {
  fail(EXIT.corrupt, '源库无法打开或已损坏：' + error.message, '先在源端排查（可用同一套 Node 执行 PRAGMA integrity_check）；损坏的库不要发布。');
}
if (sourceCheck.join('|') !== 'ok') {
  fail(EXIT.corrupt, '源库完整性校验未通过：' + sourceCheck.join('；'), '换一份完好的库，或先修复并重新校验；本次不会产出任何发布目录。');
}

// ---- 4. VACUUM INTO 出单文件库（不 checkpoint 源） ----
const publishedDb = path.join(staging, 'publish.sqlite');
let exported;
try {
  const db = new DatabaseSync(stagedDb);
  try {
    db.exec("VACUUM INTO '" + publishedDb.replaceAll("'", "''") + "'");
  } finally { db.close(); }
  const out = new DatabaseSync(publishedDb);
  try {
    exported = {
      integrity: out.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check),
      records: out.prepare('SELECT kind, COUNT(*) n FROM records GROUP BY kind ORDER BY kind').all().map(r => [r.kind, r.n])
    };
    out.exec('PRAGMA journal_mode=DELETE');
  } finally { out.close(); }
} catch (error) {
  fail(EXIT.corrupt, '导出库生成失败：' + error.message, '检查磁盘空间与权限后重试；失败不会留下发布目录。');
}
if (exported.integrity.join('|') !== 'ok') {
  fail(EXIT.corrupt, '导出库完整性校验未通过：' + exported.integrity.join('；'), '这次导出不可用；本工具不会留下可被误发布的数据。');
}

// ---- 5. 校验通过后才创建输出目录（已存在则失败，不覆盖） ----
try {
  fs.mkdirSync(path.dirname(outDir), {recursive: true});
  fs.mkdirSync(outDir); // 不带 recursive：目录已存在会抛 EEXIST
} catch (error) {
  fail(EXIT.unsafeOut, '无法创建输出目录：' + error.message, '确认父目录可写，或换一个不存在的目录名。');
}

try {
  // 附件、PDF、账号表等业务文件照抄；数据库文件与运行时残留单独处理
  for (const entry of fs.readdirSync(fromDir, {withFileTypes: true})) {
    if (entry.name === 'quality.sqlite' || entry.name.startsWith('quality.sqlite-') || entry.name === 'restore-check') continue;
    fs.cpSync(path.join(fromDir, entry.name), path.join(outDir, entry.name), {recursive: true});
  }
  fs.copyFileSync(publishedDb, path.join(outDir, 'quality.sqlite'));
} catch (error) {
  try { fs.rmSync(outDir, {recursive: true, force: true}); } catch {}
  fail(EXIT.corrupt, '写入输出目录失败：' + error.message, '已回滚本次创建的空目录，请处理后重试。');
}

// ---- 6. 落盘后再校验一次：不合格就撤掉这次产物 ----
let finalCheck;
try {
  finalCheck = check(path.join(outDir, 'quality.sqlite'));
} catch (error) {
  try { fs.rmSync(outDir, {recursive: true, force: true}); } catch {}
  fail(EXIT.corrupt, '输出库无法再次打开：' + error.message, '已删除本次产物；不要使用该目录发布。');
}
if (finalCheck.join('|') !== 'ok') {
  try { fs.rmSync(outDir, {recursive: true, force: true}); } catch {}
  fail(EXIT.corrupt, '输出库完整性校验未通过：' + finalCheck.join('；'), '已删除本次产物；不要使用该目录发布。');
}

const journal = (() => {
  const db = new DatabaseSync(path.join(outDir, 'quality.sqlite'));
  try { return db.prepare('PRAGMA journal_mode').all()[0]?.journal_mode; } finally { db.close(); }
})();

console.log(JSON.stringify({
  out: outDir,
  source: fromDir,
  sourceWalUsed: hasWal,
  sourceIntegrity: sourceCheck,
  exportIntegrity: exported.integrity,
  journalMode: journal,
  records: Object.fromEntries(exported.records),
  size: fs.statSync(path.join(outDir, 'quality.sqlite')).size,
  precondition: '源目录须已停写且所有数据库连接已关闭；integrity_check 只说明这份副本自身完整，不代表导出期间源库未被写入',
  ok: true
}, null, 2));
process.exit(EXIT.ok);
