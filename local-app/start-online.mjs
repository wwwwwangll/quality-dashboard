// 云托管发布入口：监听平台注入的 PORT、绑定 0.0.0.0、适配反向代理。
// 本机使用请继续用 scripts/start.ps1 或「立即启动.cmd」，本文件不改变本机启动方式。
import {spawn} from 'node:child_process';
import fs from 'node:fs';
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
  // 云托管按文件做快照/恢复，WAL 里的已提交页可能留在 -wal 而主库被单独替换，恢复后索引与数据不一致。
  // 托管环境改用回滚日志（删除模式），让每次提交都落在主库文件里；本机默认仍是 WAL。
  process.env.QUALITY_SQLITE_JOURNAL = process.env.QUALITY_SQLITE_JOURNAL || 'delete';

  // 不自动删除、也不自动回放数据库日志文件：无法确认归属时保留现场并停止启动。
  // -wal 里可能有已提交但还没写回主库的记录，删掉就是数据丢失；把旧 -wal 套到新主库上又会造成索引与数据不一致。
  const dataDir = process.env.QUALITY_DATA_DIR;
  const dbFile = path.join(dataDir, 'quality.sqlite');
  const stray = ['-wal', '-shm']
    .map(suffix => dbFile + suffix)
    .filter(file => fs.existsSync(file));
  if (stray.length) {
    const describe = file => {
      const stat = fs.statSync(file);
      return '  ' + file + '（' + stat.size + ' 字节，修改于 ' + stat.mtime.toISOString().replace('T', ' ').slice(0, 19) + '）';
    };
    console.error([
      '检测到无法确认归属的 SQLite 日志文件，已停止启动；文件原样保留，没有删除也没有回放。',
      ...stray.map(describe),
      '',
      '-wal 里可能包含已提交、但尚未写回主库的记录：直接删除会丢数据，',
      '把上一次的 -wal 套到新主库上则会让索引和数据行对不上（表现为接口 500、integrity_check 报 row missing from index）。',
      '本启动器不会替你决定这些文件的去留。',
      '',
      '请确认归属后按其中一种方式处理，再重新启动：',
      '  1) 这些数据要保留：在可信环境用同一套 Node 打开该库，让 SQLite 回放 -wal 并核验后再发布：',
      '     node -e "const {DatabaseSync}=require(\'node:sqlite\');const db=new DatabaseSync(process.argv[1]);console.log(db.prepare(\'PRAGMA integrity_check\').all());db.exec(\'PRAGMA wal_checkpoint(TRUNCATE)\');db.close()" "' + dbFile + '"',
      '  2) 确认是废弃数据：先整体备份数据目录，再把 quality.sqlite-wal / quality.sqlite-shm 移走（移走，不是删除），然后重新启动。',
      '',
      '处理完再执行一次部署/启动即可。'
    ].join('\n'));
    process.exit(2);
  }
  // 反代会改写 Host 并提供 X-Forwarded-*，需要信任代理才能取到 https 协议
  process.env.QUALITY_TRUST_PROXY = process.env.QUALITY_TRUST_PROXY || '1';
  // 反代改写 Host 后主机名校验放行，跨站校验改由域名白名单判断
  process.env.QUALITY_ALLOWED_HOSTS = process.env.QUALITY_ALLOWED_HOSTS || '*';
  process.env.QUALITY_ALLOWED_ORIGINS = process.env.QUALITY_ALLOWED_ORIGINS || '.workbuddy.host';

  const port = Number(process.env.PORT || process.env.QUALITY_PORT || 3868);
  const {startServer} = await import('./server.mjs');
  const runtime = await startServer({dataDir, environment: process.env.QUALITY_ENV, host: '0.0.0.0', port});
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
