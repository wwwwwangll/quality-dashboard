# 公司部署与AI交接 · 4.0.0-preview

## 交付结构与默认运行方式

Windows x64，自带已测试的 Node v24.22.1；内置SQLite已在随包运行时下完成回归测试。更换运行时或依赖后必须重跑回归，不能仅替换node.exe就宣称验证通过。

`local-app/server.mjs` 为后端；`local-app/public` 为本机前端；`dist` 保留并提供已验证的8D规则和样式，不可从部署包移除。`local-app/runtime`、`node_modules`、字体和许可证随包提供。测试／正式数据库在不同目录，Cookie会话也按环境分开。

首次只监听127.0.0.1，新版测试端口3870，正式端口3869。新版测试包首次运行会自动创建明确标识的模拟数据与14个随机密码账号，密码仅写入本包test目录。正式入口始终为空数据，不自动加载模拟内容。原3868安装版不覆盖。程序不会自动把测试数据复制进正式环境。`RELEASE-MANIFEST.json`列出交付文件SHA256；启动正式环境之前会校验完整性。

## 给公司电脑上AI的执行说明

> 请先阅读本交接说明和开始使用说明。首先校验发布包，只在test环境启动，使用你自己创建的假数据验证。不得读取正式数据库、正式附件、备份或导出文件，也不得把公司OA文件上传公网。不要清空或覆盖任何已有数据目录。测试与正式环境必须分开数据库、账号、会话、附件和备份位置，并由IT配置运行账号和目录ACL，使测试账号无正式数据读取权限。修改后提供变更说明、测试报告、升级及回退步骤。正式发布由指定人员确认执行；代码回退不会自动恢复数据库。

校验：在包根目录执行 `local-app\runtime\node.exe local-app\scripts\verify-package.mjs --release`。

源码测试：在 `local-app` 目录执行 `runtime\node.exe --test --test-concurrency=1 test/*.test.mjs`。浏览器测试分别为 `test/browser-smoke.mjs`，已包含新版九宫格和多账号弹窗操作检查，使用独立Edge配置和临时模拟数据目录。测试程序不得连接production。

## IT需要确认

1. 运行电脑为Windows x64，安装位置、空闲磁盘及是否可持续开机。
2. 使用独立的低权限服务账号，程序目录只读，业务目录可写；数据库必须放本机磁盘，不将SQLite直接放共享盘供多台电脑同时打开。
3. 若开放内网访问，配置固定IP／内网域名、防火墙和HTTPS反向代理；前端、API和附件保持同源。不要直接暴露公网。
4. `QUALITY_ENV=test|production`、`QUALITY_DATA_DIR`、`QUALITY_HOST`、`QUALITY_PORT` 和 `QUALITY_ALLOWED_HOSTS` 必须明确配置；非本机域名需加入允许列表。首次管理员只允许本机初始化。
5. 若使用HTTPS，设置 `QUALITY_HTTPS=1` 并核对代理信任和安全Cookie；部署后验证登录、CSRF、附件和PDF访问。应用默认不自动信任任意代理。
6. 配置常驻服务／计划任务，确保关机后不会声称提醒仍正常执行。
7. 将备份目标配置到独立设备，明确备份失败处理人、恢复操作人和正式发布人。

## 备份、升级与恢复

应用使用SQLite一致性快照并复制不可变附件及PDF，生成清单和哈希；验证时恢复到独立校验目录，不覆盖在线库。

手动备份示例：

```powershell
local-app\runtime\node.exe local-app\scripts\operational.mjs backup --environment test --data-dir "D:\QualityDashboard\local-app\data\test"
local-app\runtime\node.exe local-app\scripts\operational.mjs verify-backup --environment test --data-dir "D:\QualityDashboard\local-app\data\test"
```

恢复到新目录：

```powershell
local-app\runtime\node.exe local-app\scripts\operational.mjs restore --environment test --data-dir "D:\QualityDashboard\local-app\data\test" --id "备份编号" --target "D:\QualityRecoveredTest"
```

正式恢复额外要求操作人明确 `--confirm-production`，且目标仍必须是全新独立目录。核对记录数量、照片、PDF并重新设置登录会话后，再由IT停服务并人工切换目录。升级前额外备份；保留旧程序包，先做数据库版本兼容检查，不能盲目把旧程序指向新结构数据库。

## 企业微信预留接口

当前应用通道固定为mock。`lib/wecom-adapter.mjs`提供可注入传输的适配器，测试不会调用真实网络。Webhook密钥只放服务端受保护配置或环境变量，不放浏览器、Git和日志。

配置模板在`local-app/examples/wecom-config.example.json`。其中`notifications`与系统设置对应；账号的`wecomUserId`在管理员账号界面填写；`webhookEnvironment`仅记录IT拟采用的服务端环境变量名称，当前程序不读取其中的密钥。默认消息结构见下面的联调脚本输出，业务消息由`lib/system.mjs`生成。

无需数据库或密钥即可执行模拟联调：在包根目录运行`local-app\runtime\node.exe local-app\scripts\check-wecom.mjs`。可附加一个模板JSON路径。脚本只接受mock配置，使用假UserID和注入的假响应，验证缺少映射时阻止发送、`mentioned_list`参数以及接口受理状态；不会访问网络，也不会读取环境变量。它不能代替公司测试群的真实联调。

IT／公司AI完成以下接入：确认当前租户可用的群机器人接口；把账号映射到真实企业微信UserID；配置群和内部可访问的业务链接；将发件箱接入适配器并启用发送工作进程。真实启用必须显式 `mode=wecom` 和 `enableLive=true`，本轮页面不能开启。

消息采用text类型，包含事项、任务、截止时间、超期天数和链接，`mentioned_list`填真实UserID。普通文本写“@姓名”不能当作真实@。先在测试群核验可用性、群成员映射、限流和实际@效果；接口成功仅表示受理，不代表已读或完成任务。

本机预留规则：提前24小时，超期按北京时间每日10点后提醒，时间可配置；按任务、期限、责任人、提醒类型和日期去重。转交后改催新负责人；提交待验收后停止催执行人，完成／取消／不适用不提醒。含超时结果不明、失败、限流等状态；结果不明不能无条件重发造成重复@。

官方核验入口：

- 群消息推送：https://developer.work.weixin.qq.com/document/path/99110
- 原群机器人说明：https://developer.work.weixin.qq.com/document/path/91770
- 成员UserID：https://developer.work.weixin.qq.com/document/path/90196

本次未在公司租户完成真实消息验证，发送限制和实际字段支持由IT按当前官方文档核对。

## 新版权限与分析数据

所有范围由后端access模块控制。非质量部门按判责/任务参与显示本部门相关记录；销售/商务只读看板与闭环PDF；变更管理员虽在质量部，仅操作自己冻结编号。账号归档保留引用，存储密码不可回显。新报告mode=nine-grid；旧报告不静默转换。九维入口内部从L1到L4，结论与任务积分分开，根因代理不重复计分。

## OA与财务数据

采用上传文件，不连接真实OA。另支持产品分类与月度发货表导入；只按明确编号去重，月度发货不可混用全局汇总和部门拆分重复计算。支持xlsx和UTF-8／常见中文编码CSV，单文件15MB，最多20000行／200列；旧xls需要另存。原始列和值随导入批次保留，按来源单号幂等；更新已有关联记录需预览差异，不静默同步8D。索赔允许不关联报故，金额以整数分保存，当前仅统计人民币，不自动折算其他币种。

## 密码和审计

密码使用带独立盐的scrypt专用哈希；会话Cookie为HttpOnly和SameSite，写接口有CSRF与来源检查。账号停用、权限修改或重置密码使旧会话失效。复核权限、人员、任务状态均从服务器读取，客户端不能自报管理员。真实修改应走分派、提交、验收等命令接口，不能开放整份JSON覆盖入口。后台账号、导入、转交、验收、关单与系统操作留痕。
