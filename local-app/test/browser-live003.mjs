// REQ-002-LIVE-003 浏览器专项：审核办理直达、只读原因、加载反馈与计时。
// 真实 Edge 无头 + CDP，真实点击目标控件；只写本机临时库，不碰线上。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const app = path.resolve(process.argv[2] || fileURLToPath(new URL('../', import.meta.url)));
const load = file => import(pathToFileURL(path.join(app, file)).href);
const { seedPreview } = await load('scripts/seed-preview.mjs');
const { startServer } = await load('server.mjs');
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-live003-test-'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-live003-browser-'));
const output = new URL('../test-results/live003/screenshots/', import.meta.url);
await fs.mkdir(output, { recursive: true });

let runtime, browser, socket;
const issues = [], checks = [], diagnostics = [], dialogs = [];
async function until(check, label, tries = 200) {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (await check()) return;
    await delay(100);
  }
  throw Error('Timed out: ' + label + ' ' + issues.join(' | '));
}
function client() {
  let cookie = '', csrf = '';
  return {
    async req(route, body, method = body ? 'POST' : 'GET') {
      const response = await fetch(runtime.address + route, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), 'x-quality-test': 'true' },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const type = response.headers.get('content-type') || '';
      const payload = type.includes('json') ? await response.json() : await response.text();
      if (payload && payload.csrf) csrf = payload.csrf;
      return { status: response.status, data: payload };
    }
  };
}

try {
  await seedPreview(data, { legacyAccounts: true });
  const credentials = Object.fromEntries((await fs.readFile(path.join(data, '测试账号.txt'), 'utf8')).split(/\r?\n/).map(line => line.match(/：([a-z0-9]+)\s+密码：(\S+)/)).filter(Boolean).map(match => [match[1], match[2]]));
  runtime = await startServer({ dataDir: data, environment: 'test', testMode: true });

  // ---- 合成夹具：一条九宫格分析，design 维度归质量工程师；保留一个未提交 L1，另建可审核节点 ----
  const userByName = name => runtime.store.list('users').find(u => u.username === name);
  const admin = client(), owner = client(), worker = client();
  assert.equal((await admin.req('/api/login', { username: 'admin', password: credentials.admin })).status, 200);
  assert.equal((await owner.req('/api/login', { username: 'quality', password: credentials.quality })).status, 200);
  assert.equal((await worker.req('/api/login', { username: 'intelligence', password: credentials.intelligence })).status, 200);
  runtime.store.put('faults', 'BG-LIVE003', { date: '2026-11-20', product: '模拟显示屏', material: 'PN-L3', sn: 'SN-L3', description: '低温上电黑屏', condition: '低温首次上电', quantity: 2, customer: '模拟客户', dept: '质量部' }, { event: 'test.fixture' });
  const created = await admin.req('/api/analyses', { faultId: 'BG-LIVE003', mode: 'nine-grid' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const AID = created.data.id;
  const detail = async () => (await admin.req('/api/analyses/' + AID)).data;
  const version = async () => (await detail()).version;
  assert.equal((await admin.req('/api/analyses/' + AID + '/commands', { action: 'grid-assign', dimension: 'design', owner: userByName('quality').id, due: '2026-12-05', base: 2, evidenceRequired: false, version: await version() })).status, 200);
  const dimension = async () => (await detail()).nineGrid.dimensions.find(d => d.id === 'design');
  const qcmd = async (action, body) => owner.req('/api/analyses/' + AID + '/commands', { ...body, action, version: await version() });
  const submitNode = async label => {
    await qcmd('grid-add', { dimension: 'design' });
    const d = await dimension();
    const node = d.nodes.at(-1);
    assert.equal((await qcmd('grid-save', { dimension: 'design', nodeId: node.id, label, status: 'clear' })).status, 200);
    assert.equal((await qcmd('grid-submit', { dimension: 'design', nodeId: node.id })).status, 200);
    return node.id;
  };
  const nodeReview = async id => (await dimension()).nodes.find(n => n.id === id)?.review;
  const NODE_A = await submitNode('L1 已提交结论A');
  const draftNode = (await dimension()).nodes[0];

  browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let endpoint = '';
  await until(async () => { endpoint = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => ''); return endpoint; }, 'debug endpoint');
  const port = endpoint.split(/\r?\n/)[0];
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data: raw }) => {
    const message = JSON.parse(raw);
    if (message.method === 'Runtime.exceptionThrown') issues.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (['Page.javascriptDialogOpening', 'Inspector.targetCrashed', 'Runtime.executionContextDestroyed', 'Page.frameDetached'].includes(message.method)) {
      diagnostics.push(message.method + ' ' + JSON.stringify(message.params || {}).slice(0, 160));
      if (message.method === 'Page.javascriptDialogOpening') {
        // R2：意外确认框一律拒绝并记为失败。自动接受会把分析归档掉，后续用例是在被污染的数据上跑。
        dialogs.push({ message: message.params?.message || '' });
        send('Page.handleJavaScriptDialog', { accept: false }).catch(() => { });
      }
    }
    const job = pending.get(message.id);
    if (job) { pending.delete(message.id); message.error ? job.reject(Error(message.error.message)) : job.resolve(message.result); }
  });
  function send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); }
  async function evaluate(expression) {
    const result = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      new Promise((_, reject) => setTimeout(() => reject(Error('evaluate 超时（页面无响应或会话断开）：' + expression.slice(0, 120))), 20000))
    ]);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  const run = (fn, ...args) => evaluate('(' + fn.toString() + ')(' + args.map(value => JSON.stringify(value)).join(',') + ')');
  const click = selector => run(selector => { const element = document.querySelector(selector); if (!element) throw Error('Missing ' + selector); element.click(); }, selector);
  const text = selector => run(selector => document.querySelector(selector)?.textContent || '', selector);
  async function capture(name) { const image = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(new URL(name + '.png', output), Buffer.from(image.data, 'base64')); }
  function check(label, condition) { assert.ok(condition, label); checks.push(label); console.log('PASS', checks.length, label); }
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: runtime.address });
  await until(() => run(() => !!document.querySelector('#authForm')), 'login form');
  async function login(username) {
    await run((name, password) => { const form = document.querySelector('#authForm'); form.elements.username.value = name; form.elements.password.value = password; form.requestSubmit(); }, username, credentials[username]);
    await until(() => run(() => !!document.querySelector('.review-nav')), 'navigation ' + username);
    await run(() => document.querySelector('[data-tutorial=hide]')?.click());
  }
  // 已登录时先退出再登录，避免直接找 #authForm 落空。
  async function switchUser(username) {
    if (!(await run(() => !!document.querySelector('#authForm')))) {
      await run(() => document.querySelector('[data-action=logout]')?.click());
      await until(() => run(() => !!document.querySelector('#authForm')), 'logout before ' + username);
    }
    await login(username);
  }
  async function route(id) {
    await click('.review-nav [data-route="' + id + '"],.review-subnav [data-route="' + id + '"]');
    await until(() => run(id => window.QualityLocal.state.route === id, id), 'route ' + id);
    await delay(120);
  }
  const todoLoaded = () => until(() => run(() => !!document.querySelector('#todoBody') && !document.querySelector('#todoBody').textContent.includes('正在读取')), 'todo loaded');
  const auditRow = () => run(() => [...document.querySelectorAll('#todoBody tbody tr')].findIndex(tr => tr.textContent.includes('九宫格') || tr.textContent.includes('结论')));
  const clickAudit = () => run(() => { const row = [...document.querySelectorAll('#todoBody tbody tr')].find(tr => tr.textContent.includes('结论') || tr.textContent.includes('九宫格')); if (!row) throw Error('待办里找不到审核事项'); const button = row.querySelector('button'); if (!button) throw Error('缺少动作按钮'); button.click(); return button.textContent.trim(); });
  const modalOpen = () => until(() => run(() => !!document.querySelector('#analysisModal')), 'analysis modal');
  // 弹窗必须在可视区域内：只查 DOM 文本会把“看不见的提示”当成通过。
  const panelInViewport = () => run(() => { const el = document.querySelector('#openFailure'); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 60 && r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1; });
  // 全局忙锁（S.busy）期间点击会被忽略，动作之间等它释放，避免把“点了没反应”误判为功能缺陷。
  const idle = () => until(() => run(() => !document.body.hasAttribute('aria-busy')), 'idle');
  const reloadTodo = async () => { await route('todo'); await todoLoaded(); await run(() => window.QualityLocal.reloadWorkbench()); await delay(400); await todoLoaded(); };
  // D4 阶段视图先给九个维度卡片，进入维度后才出现节点按钮；两段都真实点击。
  // 自定义分析方向（version 2）用 article.panel，内置九宫格用 [data-node-card]，统一按 [data-v4=node][data-node] 定位。
  const openNodeFromDimension = async (dimension, nodeId) => {
    await run(dimension => { const card = document.querySelector('.v4-grid-card[data-v4="grid"][data-dimension="' + dimension + '"]'); if (!card) throw Error('找不到维度卡片 ' + dimension); card.click(); }, dimension);
    await until(() => run(nodeId => !!document.querySelector('[data-v4="node"][data-node="' + nodeId + '"]'), nodeId), 'node button ' + nodeId);
    await run(nodeId => { document.querySelector('[data-v4="node"][data-node="' + nodeId + '"]').click(); }, nodeId);
    await until(() => run(() => !!document.querySelector('#v4Node')), 'node view ' + nodeId);
  };

  await login('admin');
  await route('todo'); await todoLoaded();
  const actionText = await run(() => { const row = [...document.querySelectorAll('#todoBody tbody tr')].find(tr => tr.textContent.includes('结论') || tr.textContent.includes('九宫格')); return row?.querySelector('button')?.textContent.trim() || ''; });
  check('待办按真实类型显示“审核”而不是统一“办理”', /审核/.test(actionText) && !/办理/.test(actionText));
  await clickAudit();
  await modalOpen();
  const directTitle = await text('#formModal .modal-head h2');
  check('审核待办直达已提交节点而不是未提交的L1', directTitle.includes('已提交结论A') && !directTitle.includes(draftNode.label || '###'));
  check('直达页提供审核区且不改分析内容', await run(() => !!document.querySelector('#v4Node') && !!document.querySelector('.v4-review') && document.querySelector('#v4Node [name=label]').disabled));
  await capture('01-审核直达已提交节点');

  // 返回，再造第二个已提交节点，验证多节点清单
  await click('[data-action=close-analysis-view]');
  await delay(200);
  const NODE_B = await submitNode('L1 已提交结论B');
  await reloadTodo();
  await clickAudit();
  await until(() => run(() => document.body.textContent.includes('待审核结论')), 'review list');
  check('多条已提交结论先给清单，不替用户猜', await run(() => document.querySelectorAll('.v4-review-list [data-node]').length === 2));
  await capture('02-待审核清单');
  await run(() => document.querySelectorAll('.v4-review-list [data-node]')[1].click());
  await until(() => run(() => !!document.querySelector('#v4Node')), 'node open from list');
  check('清单逐个进入正确节点', (await text('#formModal .modal-head h2')).includes('已提交结论B'));
  await click('[data-action=close-form]');
  check('从节点返回仍在待审核清单', await run(() => document.body.textContent.includes('待审核结论') && document.querySelectorAll('.v4-review-list [data-node]').length === 2));
  await click('[data-action=close-analysis-view]');

  // 已被人处理：待办仍是旧数据，点击时才以最新详情核对
  for (const id of [NODE_A, NODE_B]) {
    assert.equal((await admin.req('/api/analyses/' + AID + '/commands', { action: 'grid-review', dimension: 'design', nodeId: id, decision: 'accepted', reason: '合成测试：他人已先审', initiative: 80, evidenceScore: 100, version: await version() })).status, 200);
  }
  await clickAudit();
  await until(() => run(() => !!document.querySelector('#openFailure')), 'stale panel');
  check('节点已被他人处理时提示已更新并可刷新', (await text('#openFailure')).includes('该事项已更新'));
  check('待办已更新提示确实显示在可视区域', await panelInViewport());
  await capture('03-待办已更新');
  await click('#openFailure [data-open-refresh]');
  await reloadTodo();

  // 只读原因：管理员不是负责人，查看未提交 L1
  await run(id => window.QualityLocal.open(id, 'D4'), AID);
  await modalOpen();
  await openNodeFromDimension('design', draftNode.id);
  const reasonText = await text('.v4-readonly-reason');
  check('非负责人查看未提交节点时说明只读原因与负责人', reasonText.includes('只读') && reasonText.includes('负责人') && reasonText.includes('填写'));
  await capture('04-只读原因');
  await click('[data-action=close-analysis-view]');

  // 负责人可以填写，且不出现只读提示（version 2 自定义方向在维度树内直接填）
  await switchUser('quality');
  await run(id => window.QualityLocal.open(id, 'D4'), AID);
  await modalOpen();
  await run(() => { const card = document.querySelector('.v4-grid-card[data-v4="grid"][data-dimension="design"]'); if (!card) throw Error('找不到维度卡片 design'); card.click(); });
  await until(() => run(id => !!document.querySelector('input[data-custom-title="' + id + '"]'), draftNode.id), 'owner editable title');
  check('负责人可填写且没有被只读拦截', await run(id => { const input = document.querySelector('input[data-custom-title="' + id + '"]'); return !!input && !input.disabled && !document.querySelector('.v4-readonly-reason'); }, draftNode.id));
  await run(id => { const input = document.querySelector('input[data-custom-title="' + id + '"]'); input.value = 'L1 负责人补充方向'; input.dispatchEvent(new Event('input', { bubbles: true })); }, draftNode.id);
  await click('[data-v4="custom-save"][data-node="' + draftNode.id + '"]');
  await until(async () => (await dimension()).nodes.find(n => n.id === draftNode.id)?.label === 'L1 负责人补充方向', 'owner save');
  check('负责人填写内容真实保存到服务端', (await dimension()).nodes.find(n => n.id === draftNode.id)?.label === 'L1 负责人补充方向');
  await idle();
  await run(id => { document.querySelector('[data-v4="custom-root"][data-node="' + id + '"]').click(); }, draftNode.id);
  await until(() => run(() => !!document.querySelector('#v4Node')), 'owner node form');
  check('负责人打开节点表单可编辑且无只读提示', await run(() => !document.querySelector('.v4-readonly-reason') && !document.querySelector('#v4Node [name=label]').disabled));
  await click('[data-action=close-analysis-view]');

  // 审核通过 + 合规驳回（真实点击，仅本机库）
  const NODE_C = await submitNode('L1 已提交结论C');
  // 权限：执行人员不在该分析可见范围内（404）、只读角色 403；已提交内容不能被直接覆盖（400）
  const forbidden = await worker.req('/api/analyses/' + AID + '/commands', { ...{ action: 'grid-review', dimension: 'design', nodeId: NODE_C, decision: 'accepted', reason: '合成测试：越权尝试', initiative: 80, evidenceScore: 100 }, version: await version() });
  check('无审核权限的账号直调审核接口被服务端拒绝', [403, 404].includes(forbidden.status) && (await nodeReview(NODE_C)) === 'submitted');
  const lockedWrite = await owner.req('/api/analyses/' + AID + '/commands', { ...{ action: 'grid-save', dimension: 'design', nodeId: NODE_C, label: '合成测试：改已提交内容', status: 'clear' }, version: await version() });
  check('已提交内容不能被直接改写', lockedWrite.status === 400 && /已提交或通过/.test(lockedWrite.data?.error || '') && (await dimension()).nodes.find(n => n.id === NODE_C)?.label === 'L1 已提交结论C');
  await switchUser('admin');
  await reloadTodo();
  await clickAudit();
  await until(() => run(() => !!document.querySelector('#v4Node')), 'node C');
  await run(() => { const area = document.querySelector('[name=reviewReason]'); area.value = '合成测试：证据充分，同意作为结论'; });
  await click('[data-v4=node-accept]');
  await until(() => run(() => !!document.querySelector('#analysisModal') && !document.querySelector('#v4Node')), 'accepted back to grid');
  check('审核通过走真实点击并写回服务端', await nodeReview(NODE_C) === 'accepted');
  const reviewed = (await dimension()).nodes.find(n => n.id === NODE_C);
  check('审核写入审计历史并记录审核人', (reviewed?.history || []).some(h => h.action === 'accepted' && h.by === userByName('admin').id));
  await click('[data-action=close-analysis-view]');

  const NODE_D = await submitNode('L1 已提交结论D');
  await reloadTodo();
  await clickAudit();
  await until(() => run(() => !!document.querySelector('#v4Node')), 'node D');
  await run(() => { const area = document.querySelector('[name=reviewReason]'); area.value = '证据不足'; area.dispatchEvent(new Event('input', { bubbles: true })); });
  check('驳回原因不足20字时按钮保持禁用', await run(() => document.querySelector('[data-v4=node-return]').disabled));
  await run(() => { const area = document.querySelector('[name=reviewReason]'); area.value = '合成测试：请补充低温上电波形对比与复位延时记录后再提交审核'; area.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('[data-v4=node-return]');
  await until(async () => (await nodeReview(NODE_D)) === 'returned', 'node D returned');
  check('合规驳回写回退回状态与原因', await nodeReview(NODE_D) === 'returned');
  await until(() => run(() => !document.querySelector('#v4Node')), 'back to grid after return');
  await click('[data-action=close-analysis-view]');
  const aidRows = (await admin.req('/api/workbench')).data.todo.filter(row => JSON.stringify(row).includes(AID));
  check('待审核结论处理完后队列不再给出审核上下文', aidRows.every(row => !(row.reviewNodeIds || []).length));

  // 加载反馈：延迟、失败、超时、取消、连点
  const NODE_E = await submitNode('L1 已提交结论E');
  await reloadTodo();
  await run(() => { const real = window.fetch.bind(window); window.__realFetch = real; window.__fetchCount = 0; window.fetch = (url, opts = {}) => { if (String(url).includes('/api/analyses/') && !String(url).includes('/commands')) { window.__fetchCount++; return new Promise((resolve, reject) => { opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); setTimeout(() => real(url, opts).then(resolve, reject), 1200); }); } return real(url, opts); }; });
  const startedAt = Date.now();
  await clickAudit();
  await delay(150);
  check('点击后200ms内可见“正在打开…”', await run(() => { const box = document.querySelector('#openHint'); if (!box || box.hidden || !box.textContent.includes('正在打开')) return false; const r = box.getBoundingClientRect(); return r.width > 80 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1; }));
  await capture('05-正在打开');
  await modalOpen();
  check('慢请求完成后只做一次整屏重绘', await run(() => { const list = window.QualityLocal.openTiming; const last = list[list.length - 1]; return last.dialogs === 1 && last.requestEnd - last.clickAt >= 1000; }));
  check('计时记录覆盖点击→请求→响应→可用表单', await run(() => { const last = window.QualityLocal.openTiming.at(-1); return last.clickAt > 0 && last.requestStart >= last.clickAt && last.requestEnd >= last.requestStart && last.firstFormAt >= last.requestEnd && last.ok === true; }));
  const elapsed = Date.now() - startedAt;
  await click('[data-action=close-analysis-view]');

  // 连续点击只发一次请求
  await run(() => { window.__fetchCount = 0; });
  await run(() => { const row = [...document.querySelectorAll('#todoBody tbody tr')].find(tr => tr.textContent.includes('结论') || tr.textContent.includes('九宫格')); row.querySelector('button').click(); setTimeout(() => { const again = [...document.querySelectorAll('#todoBody tbody tr')].find(tr => tr.textContent.includes('结论') || tr.textContent.includes('九宫格')); again?.querySelector('button')?.click(); }, 40); });
  await modalOpen();
  check('连续点击同一办理只发一次请求', await run(() => window.__fetchCount === 1));
  await click('[data-action=close-analysis-view]');

  // 默认阈值（30 秒）真跑一次：不缩短超时，验证文案、忙状态释放与不自动重试。
  // 放在回归中段而不是末尾：后面还有筛选/滚动、取消、失败、短超时等真实交互，页面或事件循环卡住会立刻失败。
  await run(() => { window.__slowCount = 0; window.fetch = (url, opts = {}) => { if (String(url).includes('/api/analyses/') && !String(url).includes('/commands')) { window.__slowCount++; return new Promise((resolve, reject) => { opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); }); } return window.__realFetch(url, opts); }; });
  const slowStartedAt = Date.now();
  await clickAudit();
  await until(() => run(() => !!document.querySelector('#openFailure')), 'default 30s timeout', 400);
  const slowElapsed = Date.now() - slowStartedAt;
  check('默认30秒超时给可恢复提示与重试入口', /超过\s*30\s*秒/.test(await text('#openFailure')) && (await run(() => !!document.querySelector('#openFailure [data-open-retry]'))));
  check('超时提示显示在可视区域', await panelInViewport());
  await idle();
  check('超时后忙状态释放且只请求一次不自动重试', (await run(() => !document.body.hasAttribute('aria-busy') && window.__slowCount === 1)) && slowElapsed >= 29000 && slowElapsed < 40000);
  await capture('07-超时可重试');
  await run(() => { window.fetch = window.__realFetch; });
  await click('#openFailure [data-open-retry]');
  await modalOpen();
  check('30秒超时后重试可正常打开（页面仍可交互）', await run(() => !!document.querySelector('#analysisModal') && !!document.querySelector('#v4Node, .v4-grid-card')));
  await click('[data-action=close-analysis-view]');

  // 返回保留筛选与滚动位置
  // R2 定位：无头 Edge 长时间空闲（上面真跑了 30 秒超时）后不再出帧，window.scrollTo(x,y) 会同步等一次提交，
  // 本机实测同一位置偶发 352ms~20 秒以上不返回；此时页面本身是活的（同一时刻 evaluate `1+1` 只要 2ms，
  // aria-busy 已释放、没有弹窗）。所以用滚动 API 的即时形式把页面滚到位并回读确认，仍按“用户滚动后再打开/返回”的语义断言。
  await run(() => { const form = document.querySelector('[data-list-filter="work"], #page form'); const source = document.querySelector('#todoSource'); if (source) { source.value = 'analysis'; } });
  await run(() => { const apply = document.querySelector('[data-todo-apply]'); apply?.click(); });
  await delay(200);
  const beforeFilter = await run(() => document.querySelector('#todoSource')?.value || '');
  await run(() => { window.scrollTo({ top: 420, left: 0, behavior: 'instant' }); });
  await until(() => run(() => window.scrollY > 0), 'scroll to 420');
  await delay(80);
  const beforeScroll = await run(() => window.scrollY);
  check('待办页能滚到下方位置（返回保留滚动位置的前置条件）', beforeScroll > 0);
  await clickAudit();
  await modalOpen();
  await click('[data-action=close-analysis-view]');
  await delay(200);
  check('返回待办保留原筛选与滚动位置', await run((value, top) => (document.querySelector('#todoSource')?.value || '') === value && Math.abs(window.scrollY - top) < 40, beforeFilter, beforeScroll));

  // 取消后迟到响应不得覆盖
  await run(() => { window.fetch = (url, opts = {}) => { if (String(url).includes('/api/analyses/') && !String(url).includes('/commands')) { return new Promise((resolve, reject) => { opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); setTimeout(() => window.__realFetch(url, opts).then(resolve, reject), 1500); }); } return window.__realFetch(url, opts); }; });
  await clickAudit();
  await delay(200);
  await click('#openHint [data-open-cancel]');
  await delay(1600);
  check('取消后不再打开、迟到响应被丢弃', await run(() => !document.querySelector('#analysisModal') && !window.QualityLocal.state.analysis));
  check('取消后忙状态释放，其他操作可继续', await run(() => !document.body.hasAttribute('aria-busy')));

  // 失败可重试
  await run(() => { window.fetch = (url, opts = {}) => { if (String(url).includes('/api/analyses/') && !String(url).includes('/commands')) return Promise.reject(new TypeError('模拟网络失败')); return window.__realFetch(url, opts); }; });
  await clickAudit();
  await until(() => run(() => !!document.querySelector('#openFailure')), 'failure panel');
  check('请求失败给出可恢复提示与重试入口', (await text('#openFailure')).includes('没能打开'));
  check('失败提示显示在可视区域并带重试按钮', (await panelInViewport()) && (await run(() => !!document.querySelector('#openFailure [data-open-retry]'))));
  await capture('06-打开失败可重试');
  await run(() => { window.fetch = window.__realFetch; });
  await click('#openFailure [data-open-retry]');
  await modalOpen();
  check('失败后重试可以正常打开', await run(() => !!document.querySelector('#analysisModal')));
  await click('[data-action=close-analysis-view]');

  // 超时
  await run(() => { window.QualityLocal.setOpenTimeout(700); window.fetch = (url, opts = {}) => { if (String(url).includes('/api/analyses/') && !String(url).includes('/commands')) return new Promise((resolve, reject) => { opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); }); return window.__realFetch(url, opts); }; });
  await clickAudit();
  await until(() => run(() => !!document.querySelector('#openFailure')), 'timeout panel');
  check('读取超时给出可恢复提示', /超过\s*\d+\s*秒/.test(await text('#openFailure')));
  await run(() => { window.fetch = window.__realFetch; window.QualityLocal.setOpenTimeout(0); });
  await click('#openFailure [data-open-retry]');
  await modalOpen();
  await click('[data-action=close-analysis-view]');

  check('浏览器无未捕获异常', issues.length === 0);
  check('没有出现意外确认框（归档等破坏性确认）', dialogs.length === 0);

  // 同环境计时：合并重绘开/关各 5 次，记录中位数（本机接口，不含外网波动）
  const samples = { merged: [], separate: [] };
  for (const mode of ['merged', 'separate']) {
    await run(on => window.QualityLocal.setDeferredRenders(on), mode === 'merged');
    for (let index = 0; index < 5; index++) {
      const timing = await evaluate('(async()=>{await window.QualityLocal.open(' + JSON.stringify(AID) + ',"D4");const list=window.QualityLocal.openTiming;const last=list[list.length-1];document.querySelector("[data-action=close-analysis-view]")?.click();return {clickToForm:Math.round(last.firstFormAt-last.clickAt),request:Math.round(last.requestEnd-last.requestStart),dialogs:last.dialogs};})()');
      samples[mode].push(timing);
      await delay(150);
    }
  }
  await run(() => window.QualityLocal.setDeferredRenders(true));
  const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
  const timingReport = {
    at: new Date().toISOString(),
    note: '本机合成库，Edge 无头，1440x1000，本机接口；不含外网波动，不能外推为公网固定秒数。clickToForm=点击到首个可用表单，request=请求往返，dialogs=本次动作内全量重绘次数。',
    modeMeaning: {
      merged: '合并渲染开启（默认）：一次动作内的重绘收敛到收尾一次',
      separate: '合并渲染关闭：pushForm 内立即可见，收尾重绘由计数守卫拦住'
    },
    legacyReference: '旧实现（HEAD local-app.js:146）先 renderDialogs() 清空、再由 openTask/openGrid 渲染一次，静态为 2 次全量重绘；旧版无计时钩子，未外推旧版耗时。',
    samples,
    median: {
      merged: { clickToForm: median(samples.merged.map(s => s.clickToForm)), request: median(samples.merged.map(s => s.request)), dialogs: median(samples.merged.map(s => s.dialogs)) },
      separate: { clickToForm: median(samples.separate.map(s => s.clickToForm)), request: median(samples.separate.map(s => s.request)), dialogs: median(samples.separate.map(s => s.dialogs)) }
    },
    elapsedFirstOpenMs: elapsed
  };
  await fs.writeFile(new URL('../test-results/live003/timing.json', import.meta.url), JSON.stringify(timingReport, null, 2));
  console.log('TIMING', JSON.stringify(timingReport.median));
  console.log(JSON.stringify({ ok: true, checks: checks.length, details: checks, timing: timingReport.median, errors: issues, diagnostics, dialogs }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, checks: checks.length, details: checks, error: String(error && error.stack || error), errors: issues, diagnostics, dialogs }, null, 2));
  process.exitCode = 1;
} finally {
  try { socket?.close(); } catch { }
  try { browser?.kill(); } catch { }
  try { await runtime?.close(); } catch { }
}
