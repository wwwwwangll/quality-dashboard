// REQ-002-LIVE-003-R2 浏览器专项：传统 8D 兼容（无 nineGrid）+ 九宫格结构校验边界 + 真实台账按钮。
// 真实 Edge 无头 + CDP，关键入口用 Input.dispatchMouseEvent 真实命中；只写本机临时合成库，不碰线上。
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
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-live003r2-test-'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-live003r2-browser-'));
const output = new URL('../test-results/live003-r2/screenshots/', import.meta.url);
await fs.mkdir(output, { recursive: true });

let runtime, browser, socket;
const issues = [], checks = [], diagnostics = [], dialogs = [];
const startedAt = Date.now();
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

  // ---- 合成夹具：一份传统 8D（不带 mode）+ 一份九宫格 8D ----
  const userByName = name => runtime.store.list('users').find(u => u.username === name);
  const admin = client(), owner = client();
  assert.equal((await admin.req('/api/login', { username: 'admin', password: credentials.admin })).status, 200);
  assert.equal((await owner.req('/api/login', { username: 'quality', password: credentials.quality })).status, 200);

  runtime.store.put('faults', 'BG-R2-LEGACY', { date: '2026-11-24', product: 'R2传统8D兼容', material: 'PN-L3', sn: 'SN-R2L', description: '低温上电黑屏（传统模式）', condition: '低温首次上电', quantity: 2, customer: '模拟客户', dept: '质量部' }, { event: 'test.fixture' });
  const legacyCreated = await admin.req('/api/analyses', { faultId: 'BG-R2-LEGACY' });
  assert.equal(legacyCreated.status, 201, JSON.stringify(legacyCreated.data));
  const LEGACY = legacyCreated.data.id;
  const legacyOf = async () => (await admin.req('/api/analyses/' + LEGACY)).data;
  const legacyDetail = await legacyOf();
  const legacyVersion = legacyDetail.version;
  const legacyTasks = legacyDetail.workflow?.tasks || [];

  runtime.store.put('faults', 'BG-R2-GRID', { date: '2026-11-24', product: 'R2九宫格兼容', material: 'PN-L3', sn: 'SN-R2G', description: '低温上电闪烁（九宫格模式）', condition: '低温首次上电', quantity: 3, customer: '模拟客户', dept: '质量部' }, { event: 'test.fixture' });
  const gridCreated = await admin.req('/api/analyses', { faultId: 'BG-R2-GRID', mode: 'nine-grid' });
  assert.equal(gridCreated.status, 201, JSON.stringify(gridCreated.data));
  const GRID = gridCreated.data.id;
  const gridOf = async () => (await admin.req('/api/analyses/' + GRID)).data;
  const gridVersion = async () => (await gridOf()).version;
  assert.equal((await admin.req('/api/analyses/' + GRID + '/commands', { action: 'grid-assign', dimension: 'design', owner: userByName('quality').id, due: '2026-12-05', base: 2, evidenceRequired: false, version: await gridVersion() })).status, 200);
  const designDimension = async () => (await gridOf()).nineGrid.dimensions.find(d => d.id === 'design');
  const submitNode = async label => {
    assert.equal((await owner.req('/api/analyses/' + GRID + '/commands', { action: 'grid-add', dimension: 'design', version: await gridVersion() })).status, 200);
    const node = (await designDimension()).nodes.at(-1);
    assert.equal((await owner.req('/api/analyses/' + GRID + '/commands', { action: 'grid-save', dimension: 'design', nodeId: node.id, label, status: 'clear', version: await gridVersion() })).status, 200);
    assert.equal((await owner.req('/api/analyses/' + GRID + '/commands', { action: 'grid-submit', dimension: 'design', nodeId: node.id, version: await gridVersion() })).status, 200);
    return node.id;
  };
  const NODE_A = await submitNode('L1 R2九宫格已提交结论A');

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
        // 意外确认框一律拒绝并记为失败：自动接受会把分析归档掉，污染后续用例与本轮结论。
        dialogs.push({ at: Date.now() - startedAt, message: message.params?.message || '' });
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
  const text = selector => run(selector => document.querySelector(selector)?.textContent || '', selector);
  async function capture(name) { const image = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(new URL(name + '.png', output), Buffer.from(image.data, 'base64')); }
  function check(label, condition) { assert.ok(condition, label); checks.push(label); console.log('PASS', checks.length, label); }
  // 真实鼠标点击：滚动到可视区域 → elementFromPoint 命中自己或后代 → Input.dispatchMouseEvent。
  // 滚动统一用 instant：无头 Edge 在长时间空闲后不出帧，window.scrollTo(x,y) 会同步等一次提交易卡住（R2 已定位，非应用阻塞）。
  async function tap(selector) {
    const point = await run(async selector => {
      const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
      const list = [...document.querySelectorAll(selector)];
      if (!list.length) throw Error('缺少可点击元素 ' + selector);
      for (const element of [...list].reverse()) {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await settle();
        let rect = element.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight + 1) {
          window.scrollTo({ top: Math.max(0, (document.scrollingElement?.scrollTop || 0) + rect.top - 120), left: 0, behavior: 'instant' });
          await settle(60);
          rect = element.getBoundingClientRect();
        }
        if (rect.width < 2 || rect.height < 2) continue;
        if (rect.top < 0 || rect.left < 0 || rect.bottom > window.innerHeight + 1 || rect.right > window.innerWidth + 1) continue;
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === element || element.contains(hit))) return { x, y };
      }
      const detail = list.map(element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return JSON.stringify({ text: (element.textContent || '').trim().slice(0, 12), rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)], viewport: [window.innerWidth, window.innerHeight], scroll: [window.scrollX, window.scrollY], modal: document.querySelectorAll('.modal').length, hit: hit ? hit.tagName + '.' + hit.className + '#' + hit.id : 'null' });
      }).join(' | ');
      throw Error('元素不可点击（被遮挡或不在可视区域）' + selector + ' → ' + detail);
    }, selector);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
  const click = selector => run(selector => { const element = document.querySelector(selector); if (!element) throw Error('Missing ' + selector); element.click(); }, selector);
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: runtime.address });
  await until(() => run(() => !!document.querySelector('#authForm')), 'login form');
  async function login(username) {
    await run((name, password) => { const form = document.querySelector('#authForm'); form.elements.username.value = name; form.elements.password.value = password; form.requestSubmit(); }, username, credentials[username]);
    await until(() => run(() => !!document.querySelector('.review-nav')), 'navigation ' + username);
    await run(() => document.querySelector('[data-tutorial=hide]')?.click());
  }
  async function route(id) {
    await tap('.review-nav [data-route="' + id + '"],.review-subnav [data-route="' + id + '"]');
    await until(() => run(id => window.QualityLocal.state.route === id, id), 'route ' + id);
    await delay(150);
  }
  const todoLoaded = () => until(() => run(() => !!document.querySelector('#todoBody') && !document.querySelector('#todoBody').textContent.includes('正在读取')), 'todo loaded');
  const reloadTodo = async () => { await route('todo'); await todoLoaded(); await run(() => window.QualityLocal.reloadWorkbench()); await delay(400); await todoLoaded(); };
  const modalOpen = () => until(() => run(() => !!document.querySelector('#analysisModal')), 'analysis modal');
  async function closeAll() {
    for (let step = 0; step < 5; step++) {
      if (await run(() => !!document.querySelector('#formModal'))) { await tap('#formModal [data-action=close-form]'); await delay(150); continue; }
      if (await run(() => !!document.querySelector('#analysisModal'))) { await tap('#analysisModal [data-action=close-analysis-view]'); await delay(150); continue; }
      return;
    }
  }
  const panelInViewport = () => run(() => { const el = document.querySelector('#openFailure'); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 60 && r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1; });
  const idle = () => until(() => run(() => !document.body.hasAttribute('aria-busy')), 'idle');
  // 用真实按钮定位：台账/待办里指向这份分析的 data-open-analysis 按钮，不靠文案猜。
  const markButton = (analysisId, attribute = 'data-r2-target') => run((analysisId, attribute) => {
    const button = document.querySelector('#page [data-open-analysis="' + analysisId + '"]');
    if (!button) return '';
    document.querySelectorAll('[' + attribute + ']').forEach(element => element.removeAttribute(attribute));
    button.setAttribute(attribute, '1');
    return button.textContent.trim();
  }, analysisId, attribute);
  // 审核行带 data-review-nodes，和“待分配/待补充”行区分开，避免点错入口。
  const markReview = (analysisId, attribute) => run((analysisId, attribute) => {
    const button = document.querySelector('#todoBody [data-open-analysis="' + analysisId + '"][data-review-nodes]');
    if (!button) return '';
    document.querySelectorAll('[' + attribute + ']').forEach(element => element.removeAttribute(attribute));
    button.setAttribute(attribute, '1');
    return button.textContent.trim();
  }, analysisId, attribute);
  const planResponse = body => run(body => {
    window.__realFetch = window.__realFetch || window.fetch.bind(window);
    window.fetch = (url, opts = {}) => {
      const target = String(url);
      if (!target.includes('/api/analyses/') || target.includes('/commands')) return window.__realFetch(url, opts);
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    };
  }, body);
  const stripGridShape = () => run(() => {
    window.__realFetch = window.__realFetch || window.fetch.bind(window);
    window.fetch = (url, opts = {}) => {
      const target = String(url);
      if (!target.includes('/api/analyses/') || target.includes('/commands')) return window.__realFetch(url, opts);
      return window.__realFetch(url, opts).then(async response => {
        const body = await response.json();
        delete body.nineGrid; // 合成“九宫格结构缺失”，只影响这次读取
        return new Response(JSON.stringify(body), { status: response.status, headers: { 'content-type': 'application/json' } });
      });
    };
  });
  const restoreFetch = () => run(() => { if (window.__realFetch) window.fetch = window.__realFetch; });

  /* ================= R2-1 数据面：传统 8D 是合法旧数据，不是坏响应 ================= */
  check('传统8D详情有 id/workflow 但没有 nineGrid（合法旧数据）', !!legacyDetail.id && !!legacyDetail.workflow && !('nineGrid' in legacyDetail));
  check('传统8D流程里没有九宫格维度任务（判据可靠）', legacyTasks.length > 0 && legacyTasks.every(t => t.kind !== 'grid' && !t.gridRoot));
  const gridDetail = await gridOf();
  check('九宫格详情仍带 nineGrid 结构', Array.isArray(gridDetail.nineGrid?.dimensions) && gridDetail.nineGrid.dimensions.length === 9);

  await login('admin');
  /* ================= R2-1 台账真实按钮打开传统 8D ================= */
  await route('work');
  await until(() => run(id => !!document.querySelector('#page [data-open-analysis="' + id + '"]'), LEGACY), 'ledger row ' + LEGACY);
  const ledgerLabel = await markButton(LEGACY);
  check('台账为传统8D提供真实“进入8D”按钮', /进入8D/.test(ledgerLabel));
  await tap('[data-r2-target]');
  await modalOpen();
  check('台账真实按钮能打开传统8D（没有“缺少分析详情字段”）', await run(() => !document.querySelector('#openFailure') && (document.querySelector('#analysisModal .modal-head h2')?.textContent || '').includes('R2传统8D兼容')));
  check('传统8D打开后进入跟进概览而不是九宫格视图', await run(() => !!document.querySelector('#analysisMain .wf-root, #analysisMain') && !document.querySelector('.v4-grid') && document.querySelector('#analysisMain').textContent.length > 80));
  await capture('R2-01-传统8D台账打开');
  await click('[data-stage-nav=D4]');
  await delay(150);
  check('传统8D的D4仍是旧版阶段页并说明可切换', await run(() => { const main = document.querySelector('#analysisMain'); return /旧版分析/.test(main.textContent) && !!main.querySelector('[data-v4="enable-grid"]') && !document.querySelector('#openFailure'); }));
  await capture('R2-02-传统8D-D4旧版阶段页');
  await closeAll();
  await until(() => run(() => !document.querySelector('#analysisModal')), 'close legacy analysis');

  /* ================= R2-1 已有任务可进入 ================= */
  await reloadTodo();
  const taskLabel = await run(id => {
    const buttons = [...document.querySelectorAll('#todoBody [data-open-analysis="' + id + '"][data-task]')];
    // 指定“半成品数量确认”，避免依赖待办排序：点到的行和后面检查的标题必须是同一条。
    const button = buttons.find(item => (item.closest('tr')?.textContent || '').includes('半成品数量确认')) || buttons[0];
    if (!button) return '';
    document.querySelectorAll('[data-r2-task]').forEach(element => element.removeAttribute('data-r2-task'));
    button.setAttribute('data-r2-task', '1');
    return (button.closest('tr')?.textContent || '').trim();
  }, LEGACY);
  check('传统8D的已有任务出现在待办里', taskLabel.includes('半成品数量确认'));
  await tap('[data-r2-task]');
  await until(() => run(() => !!document.querySelector('#formModal #v4Task')), 'legacy task form');
  check('传统8D已有任务可以真实进入任务表单', await run(() => { const title = document.querySelector('#formModal .modal-head h2')?.textContent || ''; return title.includes('半成品数量确认') && !!document.querySelector('#formModal #v4Task'); }));
  await capture('R2-03-传统8D任务表单');
  await closeAll();
  await until(() => run(() => !document.querySelector('#analysisModal') && !document.querySelector('#formModal')), 'close legacy task');

  /* ================= R2-1 打开后不给旧单补字段 ================= */
  const legacyAfter = await legacyOf();
  check('打开传统8D后服务端仍没有 nineGrid（没有补空字段掩盖）', !('nineGrid' in legacyAfter) && legacyAfter.version === legacyVersion);

  /* ================= 九宫格单节点直达 / 多节点复核仍然可用 ================= */
  const gridButton = await markReview(GRID, 'data-r2-grid');
  check('九宫格审核待办仍有真实入口', !!gridButton);
  await tap('[data-r2-grid]');
  await until(() => run(() => !!document.querySelector('#v4Node')), 'grid node direct');
  check('九宫格单节点仍可直达审核页', await run(() => (document.querySelector('#formModal .modal-head h2')?.textContent || '').includes('R2九宫格已提交结论A') && !!document.querySelector('.v4-review')));
  await closeAll();
  const NODE_B = await submitNode('L1 R2九宫格已提交结论B');
  assert.ok(NODE_B);
  await reloadTodo();
  await markReview(GRID, 'data-r2-grid');
  await tap('[data-r2-grid]');
  await until(() => run(() => !!document.querySelector('.v4-review-list [data-node]')), 'grid review list');
  check('九宫格多节点仍先给清单', await run(() => document.querySelectorAll('.v4-review-list [data-node]').length === 2));
  await run(() => document.querySelectorAll('.v4-review-list [data-node]')[1].click());
  await until(() => run(() => !!document.querySelector('#v4Node')), 'grid node from list');
  check('九宫格清单仍能进入选中节点', await run(() => (document.querySelector('#formModal .modal-head h2')?.textContent || '').includes('R2九宫格已提交结论B')));
  await capture('R2-04-九宫格多节点清单');
  await closeAll();
  await until(() => run(() => !document.querySelector('#analysisModal')), 'close grid list');

  /* ================= 九宫格特有校验只在进入九宫格事项时执行 ================= */
  await stripGridShape();
  await reloadTodo();
  await markReview(GRID, 'data-r2-grid');
  await tap('[data-r2-grid]');
  await until(() => run(() => !!document.querySelector('#openFailure')), 'grid shape failure');
  check('九宫格结构缺失时给可恢复提示并写明校验阶段', /缺少九宫格分析结构/.test(await text('#openFailure')) && /校验内容/.test(await text('#openFailure')) && (await run(() => !!document.querySelector('#openFailure [data-open-retry]'))));
  check('九宫格结构缺失提示在可视区域', await panelInViewport());
  await capture('R2-05-九宫格结构缺失');
  await restoreFetch();
  await tap('#openFailure [data-open-close]');
  await until(() => run(() => !document.querySelector('#openFailure')), 'close grid shape failure');

  /* ================= 通用坏响应仍可恢复（传统 8D 入口） ================= */
  await route('work');
  await until(() => run(id => !!document.querySelector('#page [data-open-analysis="' + id + '"]'), LEGACY), 'ledger row again');
  // 三种真坏响应各自停在真实阶段：空正文/缺通用字段是“校验内容”，非法 JSON 是“解析内容”。
  const badCases = [
    ['', /为空|无法读取/, /校验内容/],
    ['{不是JSON', /不是有效的 JSON/, /解析内容/],
    ['{"id":"x"}', /缺少分析详情字段/, /校验内容/]
  ];
  for (const [body, pattern, phase] of badCases) {
    await planResponse(body);
    await markButton(LEGACY);
    await tap('[data-r2-target]');
    await until(() => run(() => !!document.querySelector('#openFailure')), 'bad response ' + JSON.stringify(body).slice(0, 12));
    const failure = await text('#openFailure');
    check('坏响应仍按可恢复失败处理：' + (body ? JSON.stringify(body).slice(0, 14) : '空正文'), pattern.test(failure) && phase.test(failure) && (await run(() => !!document.querySelector('#openFailure [data-open-retry]'))));
    await tap('#openFailure [data-open-close]');
    await until(() => run(() => !document.querySelector('#openFailure')), 'close bad response');
  }
  await restoreFetch();

  /* ================= 收尾：页面仍可交互、没有意外确认框 ================= */
  await restoreFetch();
  await route('work');
  await idle();
  check('坏响应收尾后仍能正常切回台账', await run(() => window.QualityLocal.state.route === 'work' && !!document.querySelector('#page [data-open-analysis]')));
  check('没有出现意外确认框（归档等破坏性确认）', dialogs.length === 0);
  check('浏览器无未捕获异常', issues.length === 0);
  const legacyFinal = await legacyOf();
  check('全过程没有给传统8D补写 nineGrid 或改动版本', !('nineGrid' in legacyFinal) && legacyFinal.version === legacyVersion);

  console.log(JSON.stringify({ ok: true, checks: checks.length, details: checks, errors: issues, diagnostics, dialogs, elapsedMs: Date.now() - startedAt }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, checks: checks.length, details: checks, error: String(error && error.stack || error), errors: issues, diagnostics, dialogs, elapsedMs: Date.now() - startedAt }, null, 2));
  process.exitCode = 1;
} finally {
  try { socket?.close(); } catch { }
  try { browser?.kill(); } catch { }
  try { await runtime?.close(); } catch { }
}
