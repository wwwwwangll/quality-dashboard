// REQ-002-LIVE-003-R1 浏览器反例专项。
// 覆盖：200 响应头后正文卡住/取消/非法正文、失败重试期间切模块的迟到响应、清单选中节点的最新状态复核、
// 只读原因三个分支（未设期限/前序未完成/已关闭）、以及真实 30 秒超时后的连续交互链。
// 真实 Edge 无头 + CDP；关键点击走 Input.dispatchMouseEvent（真实命中测试），只写本机临时合成库，不碰线上。
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
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-live003r1-test-'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-live003r1-browser-'));
const output = new URL('../test-results/live003-r1/screenshots/', import.meta.url);
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
  const seeded = await seedPreview(data, { legacyAccounts: true });
  const CLOSED_ID = seeded.closedId;
  assert.ok(CLOSED_ID, '种子数据应包含一份已关闭的 8D，用于“已关闭”只读分支');
  const credentials = Object.fromEntries((await fs.readFile(path.join(data, '测试账号.txt'), 'utf8')).split(/\r?\n/).map(line => line.match(/：([a-z0-9]+)\s+密码：(\S+)/)).filter(Boolean).map(match => [match[1], match[2]]));
  runtime = await startServer({ dataDir: data, environment: 'test', testMode: true });

  // ---- 合成夹具：两份九宫格分析；AID 用于主体，AID2 用于“取消 A 后打开 B” ----
  const userByName = name => runtime.store.list('users').find(u => u.username === name);
  const admin = client(), owner = client(), worker = client();
  assert.equal((await admin.req('/api/login', { username: 'admin', password: credentials.admin })).status, 200);
  assert.equal((await owner.req('/api/login', { username: 'quality', password: credentials.quality })).status, 200);
  assert.equal((await worker.req('/api/login', { username: 'intelligence', password: credentials.intelligence })).status, 200);
  const makeAnalysis = async (faultId, label, ownerName = 'quality') => {
    runtime.store.put('faults', faultId, { date: '2026-11-21', product: '模拟显示屏', material: 'PN-L3', sn: 'SN-' + faultId, description: label, condition: '低温首次上电', quantity: 2, customer: '模拟客户', dept: '质量部' }, { event: 'test.fixture' });
    const created = await admin.req('/api/analyses', { faultId, mode: 'nine-grid' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.id;
    const detail = async () => (await admin.req('/api/analyses/' + id)).data;
    const version = async () => (await detail()).version;
    assert.equal((await admin.req('/api/analyses/' + id + '/commands', { action: 'grid-assign', dimension: 'design', owner: userByName(ownerName).id, due: '2026-12-05', base: 2, evidenceRequired: false, version: await version() })).status, 200);
    const qcmd = async (action, body) => owner.req('/api/analyses/' + id + '/commands', { ...body, action, version: await version() });
    const dimension = async () => (await detail()).nineGrid.dimensions.find(d => d.id === 'design');
    const submitNode = async text => {
      await qcmd('grid-add', { dimension: 'design' });
      const node = (await dimension()).nodes.at(-1);
      assert.equal((await qcmd('grid-save', { dimension: 'design', nodeId: node.id, label: text, status: 'clear' })).status, 200);
      assert.equal((await qcmd('grid-submit', { dimension: 'design', nodeId: node.id })).status, 200);
      return node.id;
    };
    return { id, detail, version, qcmd, dimension, submitNode };
  };
  const main = await makeAnalysis('BG-LIVE003R1A', '低温上电黑屏（R1 主体）');
  const AID = main.id;
  const second = await makeAnalysis('BG-LIVE003R1B', '低温上电闪烁（R1 对照）');
  const AID2 = second.id;
  const NODE_A = await main.submitNode('L1 R1已提交结论A');
  const NODE_B = await main.submitNode('L1 R1已提交结论B');
  const secondNode = await second.submitNode('L1 R1对照分析结论');
  // 对照分析先审完，避免待办里出现两条审核行导致入口歧义；它只用于“取消 A 后打开 B”。
  assert.equal((await admin.req('/api/analyses/' + AID2 + '/commands', { action: 'grid-review', dimension: 'design', nodeId: secondNode, decision: 'accepted', reason: 'R1 合成测试：对照分析先审完', initiative: 80, evidenceScore: 100, version: await second.version() })).status, 200);
  const reviewOf = async (dimension, id) => (await dimension()).nodes.find(n => n.id === id)?.review;

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
        // R2：意外确认框一律拒绝并记为失败，绝不自动接受。
        // 自动接受“移除此分析及其待办？”会把分析归档掉，后面的断言跑在被污染的数据上，失败原因也被掩盖。
        dialogs.push({ message: message.params?.message || '', type: message.params?.type || '' });
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
  // 真实鼠标点击：滚动到可视区域 → 逐个候选做命中测试（elementFromPoint 必须命中自己或其后代）→ Input.dispatchMouseEvent。
  // 命中不到就报出被谁挡住，避免把“应用没反应”和“测试点空了”混在一起。
  async function tap(selector) {
    const point = await run(async selector => {
      // 不用 requestAnimationFrame：无头浏览器长时间等待后可能停止出帧，rAF 不回调会让 evaluate 假死（上一轮 20 秒冻结的形态）。
      // 滚动用 instant，坐标取 getBoundingClientRect（强制布局），再用定时器让出一次任务队列即可。
      const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
      const list = [...document.querySelectorAll(selector)];
      if (!list.length) throw Error('缺少可点击元素 ' + selector);
      for (const element of [...list].reverse()) {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await settle();
        let rect = element.getBoundingClientRect();
        // 顶部导航在文档流里、只能横向滚动，scrollIntoView 不会把整页滚上来；像用户那样把页面滚到位再看。
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
        return JSON.stringify({ text: (element.textContent || '').trim().slice(0, 12), rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)], viewport: [window.innerWidth, window.innerHeight], scroll: [window.scrollX, window.scrollY], overflow: getComputedStyle(document.body).overflow + '/' + getComputedStyle(document.documentElement).overflow, modal: document.querySelectorAll('.modal').length, hit: hit ? hit.tagName + '.' + hit.className + '#' + hit.id : 'null' });
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
  async function switchUser(username) {
    if (!(await run(() => !!document.querySelector('#authForm')))) {
      await run(() => document.querySelector('[data-action=logout]')?.click());
      await until(() => run(() => !!document.querySelector('#authForm')), 'logout before ' + username);
    }
    await login(username);
  }
  async function route(id) {
    await tap('.review-nav [data-route="' + id + '"],.review-subnav [data-route="' + id + '"]');
    await until(() => run(id => window.QualityLocal.state.route === id, id), 'route ' + id);
    await delay(150);
  }
  const todoLoaded = () => until(() => run(() => !!document.querySelector('#todoBody') && !document.querySelector('#todoBody').textContent.includes('正在读取')), 'todo loaded');
  const auditRow = () => run(() => [...document.querySelectorAll('#todoBody tbody tr')].findIndex(tr => tr.textContent.includes('九宫格') || tr.textContent.includes('结论')));
  const clickAudit = async () => {
    const label = await run(() => {
      const row = [...document.querySelectorAll('#todoBody tbody tr')].find(tr => tr.textContent.includes('结论') || tr.textContent.includes('九宫格'));
      if (!row) return '';
      const button = row.querySelector('button');
      if (!button) return '';
      document.querySelectorAll('[data-r1-audit]').forEach(el => el.removeAttribute('data-r1-audit'));
      button.setAttribute('data-r1-audit', '1');
      return button.textContent.trim();
    });
    if (!label) throw Error('待办里找不到审核事项');
    await tap('[data-r1-audit]');
    return label;
  };
  const modalOpen = () => until(() => run(() => !!document.querySelector('#analysisModal')), 'analysis modal');
  // 表单盖在分析页上面，真实用户要先返回表单再返回待办；不能用脚本直接点被盖住的按钮。
  async function closeAll() {
    for (let step = 0; step < 5; step++) {
      if (await run(() => !!document.querySelector('#formModal'))) { await tap('#formModal [data-action=close-form]'); await delay(150); continue; }
      if (await run(() => !!document.querySelector('#analysisModal'))) { await tap('#analysisModal [data-action=close-analysis-view]'); await delay(150); continue; }
      return;
    }
  }
  const panelInViewport = () => run(() => { const el = document.querySelector('#openFailure'); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 60 && r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1; });
  const idle = () => until(() => run(() => !document.body.hasAttribute('aria-busy')), 'idle');
  const hintVisible = () => run(() => { const el = document.querySelector('#openHint'); if (!el || el.hidden) return false; const r = el.getBoundingClientRect(); return r.width > 80 && r.height > 10 && r.bottom <= window.innerHeight + 1; });
  const hintGone = () => run(() => { const el = document.querySelector('#openHint'); return !el || el.hidden; });
  const reloadTodo = async () => { await route('todo'); await todoLoaded(); await run(() => window.QualityLocal.reloadWorkbench()); await delay(400); await todoLoaded(); };
  const openNodeFromDimension = async (dimension, nodeId, analysisId) => {
    if (analysisId) { await run(id => window.QualityLocal.open(id, 'D4'), analysisId); await modalOpen(); }
    await run(dimension => { const card = document.querySelector('.v4-grid-card[data-v4="grid"][data-dimension="' + dimension + '"]'); if (!card) throw Error('找不到维度卡片 ' + dimension); card.click(); }, dimension);
    try {
      await until(() => run(nodeId => !!document.querySelector('[data-v4="node"][data-node="' + nodeId + '"]'), nodeId), 'node button ' + nodeId);
    } catch (error) {
      const view = await run(nodeId => ({ analysis: window.QualityLocal.state.analysis?.id, stage: window.QualityLocal.state.stage, cards: [...document.querySelectorAll('.v4-grid-card')].map(c => c.dataset.v4 + ':' + c.dataset.dimension), nodes: [...document.querySelectorAll('[data-v4][data-node]')].map(b => b.dataset.v4 + ':' + b.dataset.node).slice(0, 12), modal: document.querySelectorAll('.modal').length, target: nodeId, text: (document.querySelector('#analysisMain')?.textContent || '').slice(0, 240) }), nodeId);
      throw Error('维度里找不到可点击的节点按钮：' + JSON.stringify(view));
    }
    await tap('[data-v4="node"][data-node="' + nodeId + '"]');
    await until(() => run(() => !!document.querySelector('#v4Node')), 'node view ' + nodeId);
  };
  // 200 响应头先到、正文永远读不完：abort 时按真实 fetch 语义让正文读取失败。
  const stallBodyFetch = () => run(() => {
    window.__realFetch = window.__realFetch || window.fetch.bind(window);
    window.__stallCount = 0;
    window.fetch = (url, opts = {}) => {
      const target = String(url);
      if (!target.includes('/api/analyses/') || target.includes('/commands')) return window.__realFetch(url, opts);
      window.__stallCount++;
      const signal = opts.signal;
      const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"id":"pending","workflow":')); signal?.addEventListener('abort', () => { try { controller.error(new DOMException('aborted', 'AbortError')); } catch { } }); } });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    };
  });
  // 详情读取按计划延迟返回：不理会 abort（模拟响应已经在路上），用于迟到成功/迟到失败。
  const planFetch = (delays, failures = []) => run((delays, failures) => {
    window.__realFetch = window.__realFetch || window.fetch.bind(window);
    let served = 0;
    window.fetch = (url, opts = {}) => {
      const target = String(url);
      if (!target.includes('/api/analyses/') || target.includes('/commands')) return window.__realFetch(url, opts);
      const index = served++;
      const wait = delays[Math.min(index, delays.length - 1)];
      return new Promise(resolve => setTimeout(() => {
        if (failures.includes(index)) return resolve(new Response(JSON.stringify({ error: '模拟迟到的服务错误' }), { status: 500, headers: { 'content-type': 'application/json' } }));
        window.__realFetch(url, { ...opts, signal: undefined }).then(resolve, () => resolve(new Response(JSON.stringify({ error: '模拟迟到的网络错误' }), { status: 500, headers: { 'content-type': 'application/json' } })));
      }, wait));
    };
  }, delays, failures);
  const restoreFetch = () => run(() => { window.fetch = window.__realFetch || window.fetch.bind(window); window.QualityLocal.setOpenTimeout(0); });
  // 触发打开但不等结果：evaluate 若 await 这个 promise 会一直等到请求结束，就看不到“正在打开”的状态了。
  const startOpen = id => evaluate('window.QualityLocal.open(' + JSON.stringify(id) + ",'D4'); 'started'");

  await login('admin');
  await reloadTodo();
  check('审核待办存在，测试起点有效', (await auditRow()) >= 0);

  /* ================= R1-1：正文读取（200 头之后） ================= */
  // 1) 正文卡住 + 超时
  await run(() => window.QualityLocal.setOpenTimeout(900));
  await stallBodyFetch();
  const issuesBefore = issues.length;
  await clickAudit();
  await delay(250);
  check('正文未读完时加载提示真实可见且可取消', (await hintVisible()) && (await run(() => !!document.querySelector('#openHint [data-open-cancel]'))));
  await until(() => run(() => !!document.querySelector('#openFailure')), '正文超时失败框');
  check('正文读取超时给出可恢复提示并写明停在读取正文', /超过/.test(await text('#openFailure')) && /读取正文/.test(await text('#openFailure')) && (await run(() => !!document.querySelector('#openFailure [data-open-retry]'))));
  check('正文超时提示显示在可视区域', await panelInViewport());
  check('正文超时后加载提示收尾', await hintGone());
  await idle();
  check('正文超时后忙锁释放', await run(() => !document.body.hasAttribute('aria-busy')));
  check('正文超时不再抛 TypeError 且不落进分析页', issues.length === issuesBefore && (await run(() => !document.querySelector('#analysisModal') && !window.QualityLocal.state.analysis)));
  check('正文超时计时停在读取正文阶段', await run(() => { const last = window.QualityLocal.openTiming.at(-1); return last.timedOut === true && last.phase === 'body'; }));
  await capture('R1-01-正文超时');
  // 2) 超时后重试成功，并能继续筛选与打开事项
  await restoreFetch();
  await tap('#openFailure [data-open-retry]');
  await modalOpen();
  check('正文超时后重试可正常打开', await run(() => !!document.querySelector('#analysisModal') && !!document.querySelector('.v4-review, .v4-review-list, #v4Node')));
  await closeAll();
  await until(() => run(() => !document.querySelector('#analysisModal')), 'close after retry');
  await run(() => { const source = document.querySelector('#todoSource'); if (!source) throw Error('缺少来源筛选'); source.value = 'analysis'; source.dispatchEvent(new Event('change', { bubbles: true })); });
  await tap('[data-todo-apply]');
  await delay(250);
  check('正文超时恢复后仍可继续筛选', await run(() => (document.querySelector('#todoSource')?.value || '') === 'analysis' && !document.querySelector('#todoBody').textContent.includes('正在读取')));
  await clickAudit();
  await modalOpen();
  check('正文超时恢复后仍可继续打开事项', await run(() => !!document.querySelector('#analysisModal')));
  await closeAll();
  await run(() => { document.querySelector('[data-todo-reset]')?.click(); });
  await delay(250);

  // 3) 正文读取中取消：静默收尾
  await run(() => window.QualityLocal.setOpenTimeout(4000));
  await stallBodyFetch();
  await clickAudit();
  await delay(300);
  check('正文读取中显示取消入口', (await hintVisible()) && (await run(() => !!document.querySelector('#openHint [data-open-cancel]'))));
  await tap('#openHint [data-open-cancel]');
  await delay(500);
  check('正文读取中取消保持静默：不弹失败框、不留提示', (await run(() => !document.querySelector('#openFailure'))) && (await hintGone()));
  check('正文读取中取消不会打开旧事项', await run(() => !document.querySelector('#analysisModal') && !window.QualityLocal.state.analysis));
  await idle();
  check('正文读取中取消后忙锁释放', await run(() => !document.body.hasAttribute('aria-busy')));
  check('取消的计时记录标记为取消而不是失败', await run(() => { const last = window.QualityLocal.openTiming.at(-1); return last.canceled === true && last.timedOut === false; }));
  await restoreFetch();

  // 4) 正文非法 JSON / 空响应 / 结构缺字段
  await run(() => { window.__realFetch = window.__realFetch || window.fetch.bind(window); window.fetch = (url, opts = {}) => { const target = String(url); if (!target.includes('/api/analyses/') || target.includes('/commands')) return window.__realFetch(url, opts); return Promise.resolve(new Response('{"id":"broken",', { status: 200, headers: { 'content-type': 'application/json' } })); }; });
  await clickAudit();
  await until(() => run(() => !!document.querySelector('#openFailure')), '非法 JSON');
  check('正文不是合法 JSON 时给出可恢复提示并标明解析阶段', /JSON/.test(await text('#openFailure')) && /解析内容/.test(await text('#openFailure')));
  check('非法 JSON 不落进分析页', await run(() => !document.querySelector('#analysisModal') && !window.QualityLocal.state.analysis));
  await tap('#openFailure [data-open-close]');
  await run(() => { window.fetch = (url, opts = {}) => { const target = String(url); if (!target.includes('/api/analyses/') || target.includes('/commands')) return window.__realFetch(url, opts); return Promise.resolve(new Response('', { status: 200, headers: { 'content-type': 'application/json' } })); }; });
  await clickAudit();
  await until(() => run(() => !!document.querySelector('#openFailure')), '空响应');
  check('空响应不当成合法分析并说明原因', /为空|无法读取/.test(await text('#openFailure')) && /校验内容/.test(await text('#openFailure')));
  await tap('#openFailure [data-open-close]');
  await run(() => { window.fetch = (url, opts = {}) => { const target = String(url); if (!target.includes('/api/analyses/') || target.includes('/commands')) return window.__realFetch(url, opts); return Promise.resolve(new Response('{"id":"x"}', { status: 200, headers: { 'content-type': 'application/json' } })); }; });
  await clickAudit();
  await until(() => run(() => !!document.querySelector('#openFailure')), '结构缺字段');
  check('响应缺少分析详情字段时拒绝打开', /缺少分析详情字段/.test(await text('#openFailure')));
  await tap('#openFailure [data-open-close]');
  await restoreFetch();

  /* ================= R1-2：重试后导航的迟到响应 ================= */
  const failFast = () => run(() => { window.__realFetch = window.__realFetch || window.fetch.bind(window); window.fetch = (url, opts = {}) => { const target = String(url); if (!target.includes('/api/analyses/') || target.includes('/commands')) return window.__realFetch(url, opts); return Promise.reject(new TypeError('模拟网络失败')); }; });
  // 1) 失败 → 延迟重试 → 切索赔 → 旧成功到达
  await run(() => window.QualityLocal.setOpenTimeout(0));
  await failFast();
  await clickAudit();
  await until(() => run(() => !!document.querySelector('#openFailure')), '首次失败');
  await planFetch([1200]);
  await tap('#openFailure [data-open-retry]');
  await delay(250);
  check('重试读取中加载提示可见', await hintVisible());
  await route('claims');
  await delay(1500);
  check('重试期间切模块后旧分析不会被迟到响应弹回', await run(() => window.QualityLocal.state.route === 'claims' && !document.querySelector('#analysisModal') && !window.QualityLocal.state.analysis));
  check('重试期间切模块后不留加载提示与失败框', (await hintGone()) && (await run(() => !document.querySelector('#openFailure'))));
  check('切模块后页面停留在索赔模块且没有残留表单', await run(() => /索赔/.test(document.querySelector('#page')?.textContent || '') && !document.querySelector('#formModal')));
  await capture('R1-02-重试后切模块');
  // 2) 同一流程，迟到的是失败
  await reloadTodo();
  await failFast();
  await clickAudit();
  await until(() => run(() => !!document.querySelector('#openFailure')), '再次失败');
  await planFetch([1200], [0]);
  await tap('#openFailure [data-open-retry]');
  await delay(250);
  await route('claims');
  await delay(1500);
  check('迟到的失败也不会在新模块上弹出失败框', await run(() => window.QualityLocal.state.route === 'claims' && !document.querySelector('#openFailure') && !document.querySelector('#analysisModal')));
  await reloadTodo();
  // 3) 取消 A 后打开 B，再收到 A
  await planFetch([1200, 0]);
  await startOpen(AID);
  await delay(300);
  check('打开 A 时加载提示可见', await hintVisible());
  await tap('#openHint [data-open-cancel]');
  await startOpen(AID2);
  await modalOpen();
  const bShown = await run(() => window.QualityLocal.state.analysis?.id);
  check('取消 A 后可以打开 B', bShown === AID2);
  await delay(1400);
  check('A 的迟到成功不会覆盖 B', await run(id => window.QualityLocal.state.analysis?.id === id && !!document.querySelector('#analysisModal'), AID2));
  await closeAll();
  await until(() => run(() => !document.querySelector('#analysisModal')), 'close B');
  // 4) 旧请求收尾后仍可取消 B
  await planFetch([400, 1800]);
  await startOpen(AID);
  await delay(80);
  await startOpen(AID2);
  await delay(520);
  check('旧请求收尾不会清掉新请求的加载提示', await hintVisible());
  await tap('#openHint [data-open-cancel]');
  await delay(1600);
  check('旧请求收尾后仍可取消新请求', await run(() => !document.querySelector('#analysisModal') && !window.QualityLocal.state.analysis && !document.querySelector('#openFailure')));
  check('取消新请求后提示已收尾', await hintGone());
  await restoreFetch();
  // 5) 重试连点只产生一次有效读取
  await failFast();
  await clickAudit();
  await until(() => run(() => !!document.querySelector('#openFailure')), '连点前失败');
  await run(() => { window.__hits = 0; window.fetch = (url, opts = {}) => { const target = String(url); if (!target.includes('/api/analyses/') || target.includes('/commands')) return window.__realFetch(url, opts); window.__hits++; return new Promise(resolve => setTimeout(() => window.__realFetch(url, opts).then(resolve), 700)); }; });
  await run(() => { const button = document.querySelector('#openFailure [data-open-retry]'); button.click(); button.click(); button.click(); });
  await modalOpen();
  check('重试连点只有一个有效读取', await run(() => window.__hits === 1));
  check('重试连点只画出一个分析页', await run(() => document.querySelectorAll('#analysisModal').length === 1));
  await closeAll();
  await restoreFetch();

  /* ================= 真实 30 秒超时后的连续交互链 ================= */
  const CHAIN_NODE = await main.submitNode('L1 R1超时链待审核');
  assert.ok(CHAIN_NODE);
  await reloadTodo();
  await run(() => {
    window.__beat = { max: 0, last: performance.now(), ticks: 0 };
    clearInterval(window.__beatTimer);
    window.__beatTimer = setInterval(() => { const now = performance.now(); window.__beat.max = Math.max(window.__beat.max, now - window.__beat.last); window.__beat.last = now; window.__beat.ticks++; }, 50);
    window.__realFetch = window.__realFetch || window.fetch.bind(window);
    window.__c30 = 0;
    window.fetch = (url, opts = {}) => { const target = String(url); if (!target.includes('/api/analyses/') || target.includes('/commands')) return window.__realFetch(url, opts); window.__c30++; return new Promise((resolve, reject) => { opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); }); };
  });
  const chainStart = Date.now();
  await clickAudit();
  await until(() => run(() => !!document.querySelector('#openFailure')), '默认30秒超时', 500);
  const chainWaited = Date.now() - chainStart;
  check('默认30秒超时给出可恢复提示', /超过\s*30\s*秒/.test(await text('#openFailure')) && chainWaited >= 29000);
  check('30秒超时提示在可视区域且带重试', (await panelInViewport()) && (await run(() => !!document.querySelector('#openFailure [data-open-retry]'))));
  await capture('R1-03-30秒超时');
  await run(() => { window.fetch = window.__realFetch; });
  await tap('#openFailure [data-open-retry]');
  await modalOpen();
  check('30秒超时后重试成功', await run(() => !!document.querySelector('#analysisModal') && !!document.querySelector('.v4-review, .v4-review-list, #v4Node')));
  await closeAll();
  await until(() => run(() => !document.querySelector('#analysisModal')), '关闭分析页');
  await run(() => { const source = document.querySelector('#todoSource'); if (!source) throw Error('缺少来源筛选'); source.value = 'analysis'; source.dispatchEvent(new Event('change', { bubbles: true })); });
  await tap('[data-todo-apply]');
  await delay(250);
  check('超时恢复后“确定筛选”生效', await run(() => (document.querySelector('#todoSource')?.value || '') === 'analysis' && !document.querySelector('#todoBody').textContent.includes('正在读取')));
  await tap('[data-todo-reset]');
  await delay(250);
  check('超时恢复后“重置”生效', await run(() => (document.querySelector('#todoSource')?.value || '') === ''));
  await route('claims');
  check('超时恢复后可切到索赔模块', await run(() => /索赔/.test(document.querySelector('#page')?.textContent || '')));
  await route('todo');
  await todoLoaded();
  check('从索赔回到待办正常', await run(() => window.QualityLocal.state.route === 'todo' && !!document.querySelector('#todoBody')));
  await clickAudit();
  await modalOpen();
  if (await run(() => !!document.querySelector('.v4-review-list [data-node]'))) { await tap('.v4-review-list [data-node]'); await until(() => run(() => !!document.querySelector('#v4Node')), '超时链节点审核页'); }
  await run(() => { const area = document.querySelector('[name=reviewReason]'); if (!area) throw Error('审核页缺少审核说明输入'); area.value = 'R1 连续交互：30 秒超时恢复后仍可填写审核说明'; area.dispatchEvent(new Event('input', { bubbles: true })); });
  check('超时恢复后可真实输入审核说明', await run(() => (document.querySelector('[name=reviewReason]')?.value || '').includes('超时恢复后仍可填写审核说明')));
  check('连续交互期间主线程没有长时间无响应', await run(() => window.__beat.ticks > 20 && window.__beat.max < 1500));
  check('30秒超时只请求一次且不自动重试', await run(() => window.__c30 === 1));
  await run(() => clearInterval(window.__beatTimer));
  await closeAll();
  await restoreFetch();

  /* ================= 只读原因三分支 ================= */
  // 未设期限：负责人与节点都在，只是维度任务没有完成期限（产品接口不允许把已分派维度改成无期限，
  // 这里在本机合成库注入该状态，验证前端说的原因与实际条件一致；用完立刻还原）。
  const designTask = async () => { const taskId = (await main.dimension()).taskId; return (await main.detail()).workflow.tasks.find(t => t.id === taskId); };
  const dueTask = await designTask();
  const dueSnapshot = JSON.parse(JSON.stringify(runtime.store.get('analyses', AID)));
  const noDueState = JSON.parse(JSON.stringify(dueSnapshot));
  const noDueTask = noDueState.workflow.tasks.find(t => t.id === dueTask.id);
  assert.ok(noDueTask, '应能找到设计维度的任务');
  noDueTask.due = '';
  runtime.store.put('analyses', AID, noDueState, { expectedVersion: dueSnapshot.version, event: 'test.simulate-missing-due' });
  await switchUser('quality');
  await openNodeFromDimension('design', (await main.dimension()).nodes[0].id, AID);
  const noDue = await text('.v4-readonly-reason');
  check('未设期限时说明真实原因而不是角色', noDue.includes('只读') && noDue.includes('期限') && noDue.includes('分派'));
  await capture('R1-04-只读原因-未设期限');
  await closeAll();
  await switchUser('admin');
  runtime.store.put('analyses', AID, dueSnapshot, { expectedVersion: runtime.store.get('analyses', AID).version, event: 'test.restore-dimension-due' });

  // 前序未完成：只有非管理权限的负责人会走到序列判断（有 analysis.manage 的账号在 allowed() 里直接放行），
  // 所以这里用执行人员做维度负责人，再用产品自己的 add-task 建一条更早阶段的待办给他。
  const third = await makeAnalysis('BG-LIVE003R1C', '低温上电花屏（R1 前序）', 'intelligence');
  const AID3 = third.id;
  const addedEarly = await owner.req('/api/analyses/' + AID3 + '/commands', { action: 'add-task', stage: 'D2', kind: 'general', title: 'R1 合成前序任务', version: await third.version() });
  assert.equal(addedEarly.status, 200, JSON.stringify(addedEarly.data));
  const earlyId = addedEarly.data.newTaskId;
  const assignEarly = await owner.req('/api/analyses/' + AID3 + '/commands', { action: 'save-task', taskId: earlyId, patch: { owner: userByName('intelligence').id, due: '2026-12-02' }, version: await third.version() });
  assert.equal(assignEarly.status, 200, JSON.stringify(assignEarly.data));
  const earlyState = (await third.detail()).workflow.tasks.find(t => t.id === earlyId);
  assert.ok(earlyState && earlyState.owner === userByName('intelligence').id && earlyState.due === '2026-12-02', '前序任务应已分派并设期限：' + JSON.stringify(earlyState));
  await switchUser('intelligence');
  await openNodeFromDimension('design', (await third.dimension()).nodes[0].id, AID3);
  const blocked = await text('.v4-readonly-reason');
  check('前序未完成时指出前序任务而不是笼统只读', blocked.includes('前序任务未完成') && blocked.includes('只读'));
  await capture('R1-05-只读原因-前序未完成');
  await closeAll();
  await switchUser('admin');
  assert.equal((await admin.req('/api/analyses/' + AID3 + '/commands', { action: 'archive-analysis', reason: 'R1 合成测试：前序分支验证完成后清理', version: await third.version() })).status, 200);

  // 已关闭：种子里的已关闭 8D，节点只能查看
  const closedDetail = (await admin.req('/api/analyses/' + CLOSED_ID)).data;
  const closedDim = closedDetail.nineGrid.dimensions.find(d => d.id === 'design');
  const closedNode = closedDim.nodes[0];
  await openNodeFromDimension('design', closedNode.id, CLOSED_ID);
  const closedReason = await text('.v4-readonly-reason');
  check('已关闭分析说明只能查看历史内容', /已关闭|待审批/.test(closedReason) && /历史/.test(closedReason));
  check('已关闭分析的节点表单不可编辑', await run(() => { const input = document.querySelector('#v4Node [name=label]'); return !!input && input.disabled; }));
  await capture('R1-06-只读原因-已关闭');
  await closeAll();

  /* ================= R1-3：清单选中节点的最新状态复核 ================= */
  const NODE_C = await main.submitNode('L1 R1清单节点C');
  const NODE_D = await main.submitNode('L1 R1清单节点D');
  await reloadTodo();
  await clickAudit();
  await until(() => run(() => document.querySelectorAll('.v4-review-list [data-node]').length >= 2), '清单打开');
  const listCount = await run(() => document.querySelectorAll('.v4-review-list [data-node]').length);
  check('清单列出全部待审核节点', listCount >= 2 && (await run(id => !!document.querySelector('.v4-review-list [data-node="' + id + '"]'), NODE_C)) && (await run(id => !!document.querySelector('.v4-review-list [data-node="' + id + '"]'), NODE_D)));
  // 清单刚渲染出来时上一个动作可能还在收尾（全局忙锁会忽略点击），先等锁释放再点。
  const listNodeClick = async id => { await idle(); await tap('.v4-review-list [data-node="' + id + '"]'); await delay(150); };
  // 另一个客户端（独立 API 会话）先审核其中一条
  assert.equal((await admin.req('/api/analyses/' + AID + '/commands', { action: 'grid-review', dimension: 'design', nodeId: NODE_D, decision: 'accepted', reason: 'R1 合成测试：另一客户端先审', initiative: 80, evidenceScore: 100, version: await main.version() })).status, 200);
  await listNodeClick(NODE_D);
  await until(() => run(() => !!document.querySelector('#openFailure')), '清单节点已被他人审核');
  check('清单里被他人审核的节点提示已更新', (await text('#openFailure')).includes('该事项已更新'));
  check('已更新提示显示在可视区域', await panelInViewport());
  check('提示说明该结论已被处理或删除', /审核处理|已删除/.test(await text('#openFailure')));
  check('返回使用刷新后的清单，不再包含已处理节点', await run((id, count) => document.querySelectorAll('.v4-review-list [data-node]').length === count - 1 && !document.querySelector('.v4-review-list [data-node="' + id + '"]'), NODE_D, listCount));
  await capture('R1-07-清单节点已被他人审核');
  await tap('#openFailure [data-open-close]');
  await listNodeClick(NODE_C);
  await until(() => run(() => !!document.querySelector('#v4Node')), '清单剩余节点');
  check('清单中其余待审核节点仍可进入', (await text('#formModal .modal-head h2')).includes('R1清单节点C') && (await run(() => !!document.querySelector('.v4-review'))));
  await run(() => { const area = document.querySelector('[name=reviewReason]'); area.value = 'R1 合成测试：清单复核后仍可完成审核'; area.dispatchEvent(new Event('input', { bubbles: true })); });
  await tap('[data-v4=node-accept]');
  await until(async () => (await reviewOf(main.dimension, NODE_C)) === 'accepted', 'C 审核通过');
  check('清单复核后仍能完成审核并写回服务端', (await reviewOf(main.dimension, NODE_C)) === 'accepted');
  await closeAll();

  // 节点删除：他人驳回后责任人删除该方向，清单里那一条应显示已更新，同清单其它节点继续可办
  const NODE_E = await main.submitNode('L1 R1清单节点E');
  const NODE_F = await main.submitNode('L1 R1清单节点F');
  await reloadTodo();
  await clickAudit();
  await until(() => run(() => document.querySelectorAll('.v4-review-list [data-node]').length >= 2), '删除场景清单');
  assert.equal((await admin.req('/api/analyses/' + AID + '/commands', { action: 'grid-review', dimension: 'design', nodeId: NODE_F, decision: 'returned', reason: 'R1 合成测试：请补充低温上电波形对比与复位延时记录后再提交审核', version: await main.version() })).status, 200);
  assert.equal((await owner.req('/api/analyses/' + AID + '/commands', { action: 'grid-remove', dimension: 'design', nodeId: NODE_F, version: await main.version() })).status, 200);
  await listNodeClick(NODE_F);
  await until(() => run(() => !!document.querySelector('#openFailure')), '清单节点已删除');
  check('节点被删除后清单点击显示已更新', (await text('#openFailure')).includes('该事项已更新'));
  check('删除后提示可见且清单已收缩到剩余节点', (await panelInViewport()) && (await run(id => !document.querySelector('.v4-review-list [data-node="' + id + '"]'), NODE_F)));
  await capture('R1-08-清单节点已删除');
  await tap('#openFailure [data-open-close]');
  await listNodeClick(NODE_E);
  await until(() => run(() => !!document.querySelector('#v4Node')), '删除场景剩余节点');
  check('删除场景中同清单其它节点仍可办', (await text('#formModal .modal-head h2')).includes('R1清单节点E'));
  await run(() => document.querySelector('[data-action=close-form]')?.click());
  await delay(200);
  await closeAll();

  // 维度任务失效：合成库里移除该维度任务（产品指令禁止删除已提交维度，这里模拟历史脏数据/并发改派）
  const NODE_G = await main.submitNode('L1 R1清单节点G');
  await reloadTodo();
  await clickAudit();
  await until(() => run(() => document.querySelectorAll('.v4-review-list [data-node]').length >= 1), '任务失效场景清单');
  const snapshot = JSON.parse(JSON.stringify(runtime.store.get('analyses', AID)));
  const missing = JSON.parse(JSON.stringify(snapshot));
  const designDimension = missing.nineGrid.dimensions.find(d => d.id === 'design');
  missing.workflow.tasks = missing.workflow.tasks.filter(t => t.id !== designDimension.taskId);
  runtime.store.put('analyses', AID, missing, { expectedVersion: snapshot.version, event: 'test.simulate-missing-dimension-task' });
  await listNodeClick(NODE_G);
  try {
    await until(() => run(() => !!document.querySelector('#openFailure')), '维度任务失效', 60);
  } catch (error) {
    const view = await run(() => ({ busy: document.body.hasAttribute('aria-busy'), toast: document.querySelector('#toast')?.textContent, hint: !!document.querySelector('#openHint') && !document.querySelector('#openHint').hidden, failure: !!document.querySelector('#openFailure'), dialog: [...document.querySelectorAll('#dialogRoot > *')].map(el => el.id || el.className), list: [...document.querySelectorAll('.v4-review-list [data-node]')].map(b => b.dataset.node), analysis: window.QualityLocal.state.analysis?.id, timing: window.QualityLocal.openTiming.slice(-1) }));
    await capture('R1-10-任务失效诊断');
    throw Error('维度任务失效未出现提示：' + JSON.stringify(view));
  }
  check('维度任务失效时提示已更新并可刷新', (await text('#openFailure')).includes('该事项已更新') && /失效|改派/.test(await text('#openFailure')));
  check('维度任务失效提示可见且有刷新入口', (await panelInViewport()) && (await run(() => !!document.querySelector('#openFailure [data-open-refresh]'))));
  await capture('R1-09-维度任务失效');
  await tap('#openFailure [data-open-refresh]');
  await delay(400);
  check('刷新后回到待办且不再显示旧清单', await run(() => window.QualityLocal.state.route === 'todo' && !document.querySelector('#openFailure')));
  runtime.store.put('analyses', AID, snapshot, { expectedVersion: runtime.store.get('analyses', AID).version, event: 'test.restore-after-simulated-corruption' });

  check('浏览器无未捕获异常', issues.length === 0);
  check('没有出现意外确认框（拒绝归档等破坏性确认）', dialogs.length === 0);

  // R2 回归：加载提示的“取消”不能和任何破坏性按钮共用坐标。
  // 之前提示固定在右下角，与分析页 footer 的“移除当前分析（保留历史）”重叠；提示收起的一瞬间点取消会穿透到归档。
  await run(id => window.QualityLocal.open(id, 'D4'), AID);
  await modalOpen();
  const overlap = await run(() => {
    const hint = document.querySelector('#openHint');
    if (!hint) return { error: '缺少加载提示元素' };
    const wasHidden = hint.hidden;
    hint.hidden = false;
    const box = hint.getBoundingClientRect();
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const danger = [...document.querySelectorAll('#analysisModal .work-btn.danger, #analysisModal [data-action="archive-analysis"]')].map(button => ({ text: (button.textContent || '').trim(), rect: button.getBoundingClientRect() }));
    const result = { overlap: danger.filter(item => hit(box, item.rect)).map(item => item.text), hint: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)], danger: danger.map(item => [item.text, Math.round(item.rect.top), Math.round(item.rect.bottom)]) };
    hint.hidden = wasHidden;
    return result;
  });
  check('加载提示不压在分析页的破坏性操作上', overlap.error === undefined && overlap.overlap.length === 0);
  await closeAll();
  await until(() => run(() => !document.querySelector('#analysisModal')), 'close analysis after overlap check');

  const report = {
    at: new Date().toISOString(),
    checks: checks.length,
    details: checks,
    chain: { waitedMs: chainWaited, steps: ['30秒超时', '重试成功', '关闭', '确定筛选', '重置', '切索赔', '回待办', '重开审核', '输入审核说明'] },
    notes: {
      bodyStall: '用 ReadableStream 模拟“200 响应头已到、正文永不结束”，abort 时按真实 fetch 语义让正文读取失败；未改产品代码、未改服务端。',
      delayedResponses: '迟到成功/失败通过“先发真实请求、再延迟交付结果、忽略 abort”模拟响应已在路上。',
      dimensionTaskMissing: '产品指令禁止删除已提交维度的任务，因此在本机合成库直接移除该任务模拟历史脏数据；用完立刻还原并记录事件名。',
      closedAnalysis: '使用种子数据里真实走完 8D 并 close 的分析，不经注入。'
    },
    diagnostics,
    dialogs,
    errors: issues
  };
  await fs.writeFile(new URL('../test-results/live003-r1/report.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, checks: checks.length, details: checks, chainMs: chainWaited, errors: issues, diagnostics, dialogs }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, checks: checks.length, details: checks, error: String(error && error.stack || error), errors: issues, diagnostics, dialogs }, null, 2));
  process.exitCode = 1;
} finally {
  try { socket?.close(); } catch { }
  try { browser?.kill(); } catch { }
  try { await runtime?.close(); } catch { }
}
