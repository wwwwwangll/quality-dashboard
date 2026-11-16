# 云托管发布说明（v4.3.0）

本目录只负责「把本机版发布成公网网址供其他电脑、手机登录查看」，不改变本机版和正式版的启动方式。

## 与业务无关的四处适配

| 位置 | 改动 | 影响面 |
| --- | --- | --- |
| `local-app/server.mjs` | `QUALITY_ALLOWED_HOSTS=*` 时放行任意 Host；跨站校验改用 `QUALITY_ALLOWED_ORIGINS` 域名白名单；`QUALITY_TRUST_PROXY` 支持任意值；`QUALITY_ALLOW_NODE22=1` 时 Node 校验放宽到 22.5 | 不设这些环境变量时行为与 v4.3.0 完全一致 |
| `local-app/lib/workflow.mjs` | 共享8D引擎目录 `dist` 或 `engine` 自动识别 | 本机仍是 `dist`，无变化 |
| `local-app/lib/system.mjs` | `node:sqlite` 的 `backup` 不存在时（Node 22.13 一类），退化为 WAL 合并后复制文件 | Node 24 仍走原生 `backup` |
| `local-app/start-online.mjs`（新增） | 云托管入口：读 `PORT`、绑定 `0.0.0.0`、设置上述环境变量、Node 22 自动补 `--experimental-sqlite`；`journal_mode` 走删除模式；发现无法确认归属的 `-wal/-shm` 时保留文件并**停止启动** | 只在云端启动时使用 |

## 为什么需要把 dist 改名

托管平台上传时会剔除 `node_modules` 和名为 `dist` 的构建产物目录，而 `dist` 里放的是共享 8D 引擎（`analysis-core.js` / `analysis-workflow.js`）。发布前把它复制成 `engine`，代码侧两种目录名都能识别。

## 生成发布目录

```bash
# 0. 前置条件：源目录必须已停写，且所有数据库连接都已关闭（停服务、确认没有进程占用）
# 1. 导出数据：输出目录必须是还不存在的新目录，且与源目录互不包含
node online-publish/make-online-data.mjs --from local-app/data/test --out ../quality-online-data

# 2. 生成发布目录
node online-publish/build-online.mjs --out ../quality-online --data ../quality-online-data
```

- `make-online-data.mjs --from`：源数据目录（含 `quality.sqlite`），只读，不会被修改
- `make-online-data.mjs --out`：**必须不存在**的新目录；已存在会被拒绝，程序不会删除、清空任何已有目录
- `build-online.mjs --out`：构建输出目录（这个脚本会整体重建自己的输出目录，只能用在你自己的产物目录上）
- `build-online.mjs --data`：可选，携带一份合成测试数据（含固定测试账号，仅限演示）；正式数据一律不带

> **导出只支持「已停写、连接已关闭」的数据目录。**
> 本工具不锁库、不接管正在运行的连接，只是把当时的文件复制一份再校验。
> 如果导出时还有进程在写，复制出来的副本本身就可能不一致——`integrity_check` 只能说明这份副本“内部自洽”，
> **不能**证明导出期间源库没变，也不构成并发快照一致性的保证。请先停服务再导出。

### 导出数据：为什么必须用 make-online-data.mjs

托管平台按文件做快照/恢复，而 SQLite 默认是 WAL：已提交的页可能只写在 `quality.sqlite-wal` 里。
如果发布只替换主库文件、宿主机上还留着上一版 `-wal`，新库会被套上旧 WAL，主键索引与数据行对不上，
表现为 `/api/bootstrap`、`/api/queues`、`/api/metrics` 全部 500（`integrity_check` 报 `row N missing from index`）。

这个脚本的做法（每一步都是为了让失败停在导出阶段，而不是上线后）：

1. **只读源目录**：把 `quality.sqlite` 和 `quality.sqlite-wal` 按字节复制到临时目录，之后所有操作用副本；
   不执行 `PRAGMA wal_checkpoint`，也不原地打开源库，源库文件字节不变。
2. **只写新目录**：`--out` 已存在直接拒绝（退出码 4）；与源目录的包含关系按**真实路径 + 路径段**判断，
   `--out` 落在源目录内、或源目录落在 `--out` 内都拒绝——包括名字以 `..` 开头的目录（如 `..export`），
   以及父目录经 junction / 符号链接指回源目录的情况（判重发生在创建目录之前）。
3. **两次完整性校验**：源（副本）与 `VACUUM INTO` 产物各跑一次 `PRAGMA integrity_check`；
   任一失败就退出（退出码 3），**不创建输出目录**，避免把校验失败的产物当成可发布数据。
4. 通过后才创建输出目录并落盘，落盘后再校验一次；这一步失败会删掉本次产物（仅限本次新建的目录）。

导出结果是一个不依赖 WAL 的单文件库（`journal_mode=delete`），目录里不带 `-wal/-shm`。

### 恢复 / 重新发布线上数据（安全步骤）

1. **先停写入**：停掉线上服务，并确认没有进程仍占用数据库（`-wal`/`-shm` 不再被打开），再动数据库文件。
2. **先备份现场**：把线上数据目录整体复制一份（含 `quality.sqlite`、`-wal`、`-shm`、附件），带时间戳留档。
3. **处理日志文件（不要直接删）**：如果目录里有 `quality.sqlite-wal` / `-shm`，先判断归属：
   - 需要保留数据：在可信环境用同一套 Node 打开该库，让 SQLite 回放并核验，再导出：
     ```bash
     node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);console.log(db.prepare('PRAGMA integrity_check').all());db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close()" <数据目录>/quality.sqlite
     ```
   - 确认是废弃数据：**移走**（不是删除）`-wal`/`-shm`，保留在备份里。
4. **用导出工具产出干净库**：确认服务已停（第 1 步），再执行 `make-online-data.mjs --from <现场备份> --out <新目录>`，
   确认输出 `ok: true`。
5. **替换并验证**：用新目录里的 `quality.sqlite` 替换线上库，启动后跑一次 `PRAGMA integrity_check`，
   并抽查关键数据（报故条数、8D 份数、账号数）。

### 已知边界（不要当成保证）

- 文件级快照与 SQLite 的持久化之间没有原子性：**任何快照方式都无法保证进程被强杀时不出现半写状态**。
  这里做的只是「导出时不依赖 WAL、恢复时不替人删文件、校验不过就拒绝发布」。
- **`integrity_check` 不是并发一致性的证明**：它只能说明被检查的那份文件内部结构自洽。
  导出期间源库若仍在写入，副本可能“自洽但落后/夹杂”，此时校验未必报错；所以前置条件是“已停写 + 连接已关闭”，
  校验只是最后一道兜底，不代替停写。
- 平台侧如何快照/恢复不在本仓库控制范围内；恢复后仍应执行第 5 步的校验与抽查。

输出目录结构：

```
quality-online/
├── engine/                  # 原 dist，共享8D引擎
└── local-app/
    ├── server.mjs
    ├── start-online.mjs     # 启动入口
    ├── lib/ public/ assets/ examples/ scripts/
    ├── package.json package-lock.json
    └── data/test/           # 仅当传了 --data
```

## 平台侧配置

- 安装命令：`npm ci --prefix local-app`
- 启动命令：`node local-app/start-online.mjs`
- 端口：平台注入 `PORT`
- 环境变量（可选覆盖）：
  - `QUALITY_ALLOWED_ORIGINS`：默认 `.workbuddy.host`，换平台时改成实际域名后缀，多个用逗号分隔
  - `QUALITY_DATA_DIR`：默认 `local-app/data/test`
  - `QUALITY_ENV`：默认 `test`
  - `QUALITY_SQLITE_JOURNAL`：默认 `delete`（云端关闭 WAL）；本机 `start.mjs` 不设该变量，仍是 WAL

> 启动时若数据目录里已存在 `quality.sqlite-wal` / `-shm`，进程会打印提示后**以退出码 2 停止**（文件保留不动）。
> 这在平台上表现为“启动失败”，按上一节「恢复 / 重新发布线上数据」处理即可，不要在平台上点重启硬撑。

## 安全边界

1. **只上传源码与合成数据**，不上传 `node_modules`、`runtime`、真实数据库、附件、备份、日志。
2. **固定测试口令只在 `test` 环境**：`admin / Test@2026-admin`，其余为 `Test@2026-用户名`。正式环境（`production`）不创建任何测试账号，管理员由公司指定人员首次创建。
3. **公网链接不是正式站**：拿到链接的人只能到登录页，数据在账号后面；不要把正式数据放进托管环境。
4. **托管数据与本机数据互不相通**：线上是独立副本，本机改动不会自动同步到线上，线上改动也不回传。
5. 发布公网站点属于对外发布动作，需经确认后执行；本仓库不包含任何自动部署脚本。
