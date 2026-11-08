# 云托管发布说明（v4.3.0）

本目录只负责「把本机版发布成公网网址供其他电脑、手机登录查看」，不改变本机版和正式版的启动方式。

## 与业务无关的四处适配

| 位置 | 改动 | 影响面 |
| --- | --- | --- |
| `local-app/server.mjs` | `QUALITY_ALLOWED_HOSTS=*` 时放行任意 Host；跨站校验改用 `QUALITY_ALLOWED_ORIGINS` 域名白名单；`QUALITY_TRUST_PROXY` 支持任意值；`QUALITY_ALLOW_NODE22=1` 时 Node 校验放宽到 22.5 | 不设这些环境变量时行为与 v4.3.0 完全一致 |
| `local-app/lib/workflow.mjs` | 共享8D引擎目录 `dist` 或 `engine` 自动识别 | 本机仍是 `dist`，无变化 |
| `local-app/lib/system.mjs` | `node:sqlite` 的 `backup` 不存在时（Node 22.13 一类），退化为 WAL 合并后复制文件 | Node 24 仍走原生 `backup` |
| `local-app/start-online.mjs`（新增） | 云托管入口：读 `PORT`、绑定 `0.0.0.0`、设置上述环境变量、Node 22 自动补 `--experimental-sqlite` | 只在云端启动时使用 |

## 为什么需要把 dist 改名

托管平台上传时会剔除 `node_modules` 和名为 `dist` 的构建产物目录，而 `dist` 里放的是共享 8D 引擎（`analysis-core.js` / `analysis-workflow.js`）。发布前把它复制成 `engine`，代码侧两种目录名都能识别。

## 生成发布目录

```bash
node online-publish/build-online.mjs --out ../quality-online --data local-app/data/test
```

- `--out`：输出目录（会被整体重建）
- `--data`：可选，携带一份合成测试数据（含固定测试账号，仅限演示）；正式数据一律不带

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

## 安全边界

1. **只上传源码与合成数据**，不上传 `node_modules`、`runtime`、真实数据库、附件、备份、日志。
2. **固定测试口令只在 `test` 环境**：`admin / Test@2026-admin`，其余为 `Test@2026-用户名`。正式环境（`production`）不创建任何测试账号，管理员由公司指定人员首次创建。
3. **公网链接不是正式站**：拿到链接的人只能到登录页，数据在账号后面；不要把正式数据放进托管环境。
4. **托管数据与本机数据互不相通**：线上是独立副本，本机改动不会自动同步到线上，线上改动也不回传。
5. 发布公网站点属于对外发布动作，需经确认后执行；本仓库不包含任何自动部署脚本。
