// REQ-002-LIVE-001-R1 浏览器回归：结算读模型、已完成只读、受限转出回看与照片读取、
// 日期/历史筛选、双进度、草稿前后统计一致。复用既有 Edge CDP 方式，结果写入 test-results/r1。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const app = path.resolve(process.argv[2] || fileURLToPath(new URL('../', import.meta.url)));
const load = file => import(pathToFileURL(path.join(app, file)).href);
const { startServer } = await load('server.mjs');
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-r1-ui-test-'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-r1-ui-browser-'));
const output = new URL('../test-results/r1/screenshots/', import.meta.url);
await fs.mkdir(output, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let runtime, browser, socket;
const issues = [], checks = [];

function client() {
  let cookie = '', csrf = '';
  return {
    async raw(route, body, method = 'POST', headers = {}) {
      const response = await fetch(runtime.address + route, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), 'x-quality-test': 'true', ...headers },
        ...(body ? { body } : {})
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const text = await response.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      if (parsed && parsed.csrf) csrf = parsed.csrf;
      return { status: response.status, data: parsed };
    },
    async upload(buffer, name) {
      return this.raw('/api/files', buffer, 'POST', { 'content-type': 'image/png', 'x-file-name': encodeURIComponent(name) });
    },
    request(route, body, method) { return this.raw(route, body ? JSON.stringify(body) : undefined, method || (body ? 'POST' : 'GET')); }
  };
}

async function until(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await delay(100); }
  throw Error('Timed out: ' + label + ' ' + issues.join(' | '));
}

try {
  runtime = await startServer({ dataDir: data, environment: 'test', testMode: true });
  const admin = client();
  await admin.request('/api/setup', { username: 'admin', name: 'R1管理员', password: 'Test-Admin-12345' });
  const makeUser = async (username, name, dept, extra = {}) => {
    const created = await admin.request('/api/users', { username, name, dept, role: 'quality-engineer', password: 'Test-User-123456', ...extra });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const c = client();
    assert.equal((await c.request('/api/login', { username, password: 'Test-User-123456' })).status, 200);
    return c;
  };
  const qe1 = await makeUser('r1qe1', '质量甲', '质量部');
  const qe2 = await makeUser('r1qe2', '质量乙', '质量部');
  const limited = await makeUser('r1limited', '非全览QE', '研发部', { permissions: [] });
  const users = runtime.store.list('users');
  const idOf = name => users.find(user => user.name === name).id;
  const claimOf = id => runtime.store.get('claims', id);
  const advance = async (clientInstance, id, steps) => {
    for (const [action, extra] of steps) {
      const current = claimOf(id);
      const result = await clientInstance.request('/api/claims/' + id + '/actions', { version: current.version, action, ...extra });
      assert.equal(result.status, 200, action + ' ' + JSON.stringify(result.data));
    }
  };

  // 夹具1：已完成、结算 500 元，含故障照片
  const photo1 = await qe1.upload(PNG, '结算单故障照片.png');
  assert.equal(photo1.status, 201, JSON.stringify(photo1.data));
  assert.equal((await qe1.request('/api/claims', { id: 'CL-R1-UI-DONE', date: '2026-11-20', customer: '结算读模型客户', issue: '外观划伤', amount: '1000', deadline: '2026-12-05', photo: photo1.data.id })).status, 201);
  let claim = claimOf('CL-R1-UI-DONE');
  assert.equal((await qe1.request('/api/claims/CL-R1-UI-DONE/shares', { version: claim.version, shares: [{ dept: '研发部', ratio: 60 }, { dept: '生产部', ratio: 40 }], confirm: true }, 'PUT')).status, 200);
  await advance(qe1, 'CL-R1-UI-DONE', [['start', {}], ['processed', { note: '更换供应商来料并复检' }], ['complete', { settlement: { mode: '赔付', amount: '500', note: '与客户确认赔付五百元' } }]]);

  // 夹具2：已确认 60/40，随后保存 80/20 草稿（基线与草稿不一致）
  assert.equal((await qe1.request('/api/claims', { id: 'CL-R1-UI-DRAFT', date: '2026-11-20', customer: '草稿统计客户', issue: '尺寸超差', amount: '1000', deadline: '2026-12-08' })).status, 201);
  claim = claimOf('CL-R1-UI-DRAFT');
  assert.equal((await qe1.request('/api/claims/CL-R1-UI-DRAFT/shares', { version: claim.version, shares: [{ dept: '研发部', ratio: 60 }, { dept: '生产部', ratio: 40 }], confirm: true }, 'PUT')).status, 200);

  // 夹具4：在办、确实没有办理期限的存量单（新建接口会给默认期限，这里直接落一条历史数据），
  // 用于区分日期提示里的“未填写”和“日期不在所选范围”。
  runtime.store.put('claims', 'CL-R1-UI-NODATE', { id: 'CL-R1-UI-NODATE', date: '2026-11-22', customer: '无期限客户', issue: '标签错贴', amount: 100, amountCents: 10000, stage: '待处理', dept: '质量部', history: [], faultIds: [] }, { event: 'fixture' });

  // 夹具3：受限 QE 建单带照片，跨部门转给质量部
  const photo2 = await limited.upload(PNG, '转办故障照片.png');
  assert.equal(photo2.status, 201, JSON.stringify(photo2.data));
  assert.equal((await limited.request('/api/claims', { id: 'CL-R1-UI-SCOPE', date: '2026-11-21', customer: '受限转出客户', amount: '10', deadline: '2026-12-01', photo: photo2.data.id })).status, 201);
  claim = claimOf('CL-R1-UI-SCOPE');
  assert.equal((await limited.request('/api/claims/CL-R1-UI-SCOPE/actions', { version: claim.version, action: 'transfer', to: idOf('质量乙'), reason: '跨部门转给质量部' })).status, 200);

  browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
  ], { windowsHide: true, stdio: 'ignore' });
  let endpoint = '';
  await until(async () => { endpoint = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => ''); return endpoint; }, 'debug endpoint');
  const port = endpoint.split(/\r?\n/)[0];
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') issues.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const job = pending.get(message.id);
    if (job) { pending.delete(message.id); message.error ? job.reject(Error(message.error.message)) : job.resolve(message.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  const run = (fn, ...args) => evaluate('(' + fn.toString() + ')(' + args.map(value => JSON.stringify(value)).join(',') + ')');
  const click = selector => run(selector => { const element = document.querySelector(selector); if (!element) throw Error('Missing ' + selector); element.click(); }, selector);
  const text = selector => run(selector => document.querySelector(selector)?.textContent || '', selector);
  const fill = (selector, value) => run((selector, value) => { const element = document.querySelector(selector); if (!element) throw Error('Missing ' + selector); element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }, selector, value);
  async function capture(name) { const image = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(new URL(name + '.png', output), Buffer.from(image.data, 'base64')); }
  const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log('PASS', checks.length, label); };
  const route = async id => { await click('.review-nav [data-route="' + id + '"],.review-subnav [data-route="' + id + '"]'); await until(() => run(id => window.QualityLocal.state.route === id, id), 'route ' + id); await delay(150); };
  async function loginAs(username) {
    await send('Network.clearBrowserCookies');
    await send('Page.navigate', { url: runtime.address });
    await until(() => run(() => !!document.querySelector('#authForm')), 'login form ' + username);
    await run((name, password) => { const form = document.querySelector('#authForm'); form.elements.username.value = name; form.elements.password.value = password; form.requestSubmit(); }, username, 'Test-User-123456');
    await until(() => run(() => !!document.querySelector('.review-nav')), 'nav ' + username);
    await run(() => { const hide = document.querySelector('[data-tutorial=hide]'); if (hide) hide.click(); });
    await delay(150);
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  // —— 1. 结算后各金额视图一致 ——
  await loginAs('r1qe1');
  await route('claims');
  const doneRow = await run(() => { const row = [...document.querySelectorAll('.review-claims-table tbody tr')].find(tr => tr.textContent.includes('CL-R1-UI-DONE')); return row ? row.textContent : ''; });
  check('已完成单列表显示结算后的实际赔付', doneRow.includes('500.00') && doneRow.includes('已完成'));
  await run(() => { const row = [...document.querySelectorAll('.review-claims-table tbody tr')].find(tr => tr.textContent.includes('CL-R1-UI-DONE')); row.querySelector('[data-open-claim]').click(); });
  await until(() => run(() => document.querySelector('#dialogRoot')?.textContent.includes('结算结论')), 'done detail');
  const detailText = await text('#dialogRoot');
  check('详情显示结算结论与有效实际赔付', detailText.includes('与客户确认赔付五百元') && detailText.includes('¥500.00'));
  check('已完成单详情不提供分摊与办理入口', await run(() => !document.querySelector('[data-claim-shares]') && !document.querySelector('[data-claim-start]') && !document.querySelector('[data-claim-processed]')));
  await capture('01-已完成结算读模型');
  await run(() => document.querySelector('[data-action=close-form]')?.click());

  // —— R2-2 案件进度金额列：索赔金额与实际赔付分列 ——
  await route('todo');
  await click('[data-todo-tab=claims]');
  await until(() => run(() => document.querySelector('#todoBody')?.textContent.includes('CL-R1-UI-DONE')), 'claims progress table');
  const tableInfo = await run(() => {
    const table = [...document.querySelectorAll('#todoBody table')].find(item => item.textContent.includes('索赔单号'));
    if (!table) return null;
    return {
      heads: [...table.querySelectorAll('thead th')].map(cell => cell.textContent.trim()),
      rows: [...table.querySelectorAll('tbody tr')].map(row => [...row.children].map(cell => cell.textContent.trim()))
    };
  });
  assert.ok(tableInfo, '案件进度应包含索赔整单表');
  const amountIndex = tableInfo.heads.indexOf('索赔金额'), actualIndex = tableInfo.heads.indexOf('实际赔付');
  check('案件进度同时保留索赔金额与实际赔付两列', amountIndex >= 0 && actualIndex === amountIndex + 1);
  const doneCells = tableInfo.rows.find(cells => cells[0] === 'CL-R1-UI-DONE');
  check('已完成行按列显示提出金额与实际赔付', !!doneCells && doneCells[amountIndex] === '1,000.00' && doneCells[actualIndex] === '500.00');
  const openCells = tableInfo.rows.find(cells => cells[0] === 'CL-R1-UI-NODATE');
  check('未结算行实际赔付保持未知且不覆盖索赔金额', !!openCells && openCells[amountIndex] === '100.00' && openCells[actualIndex] === '未知');
  // 日期条件：同时存在“未填写”和“不在所选范围”两种原因
  await fill('#todoFrom', '2026-11-19');
  await fill('#todoTo', '2026-11-20');
  await click('[data-todo-apply]');
  await until(() => run(() => document.querySelector('#todoHint')?.textContent.includes('不符合日期条件')), 'mixed date hint');
  const mixedHint = await text('#todoHint');
  check('日期提示同时区分未填写与范围外两种原因', mixedHint.includes('条未填写办理期限') && mixedHint.includes('条日期不在所选范围'));
  await capture('07-金额分列与日期原因');
  await click('[data-todo-reset]');
  await click('[data-todo-tab=done]');
  await until(() => run(() => !!document.querySelector('#todoKind')), 'done tab for date hint');
  await fill('#todoFrom', '2030-01-01');
  await fill('#todoTo', '2030-12-31');
  await click('[data-todo-apply]');
  await until(() => run(() => document.querySelector('#todoHint')?.textContent.includes('不符合日期条件')), 'outside only hint');
  const outsideHint = await text('#todoHint');
  check('有日期但范围外的记录不再被说成未填写', outsideHint.includes('条日期不在所选范围') && !outsideHint.includes('未填写'));
  await click('[data-todo-reset]');
  await click('[data-todo-tab=todo]');

  // —— 2. 草稿不改变正式统计 ——
  await route('overview');
  // 当前挂载的是 v4 看板（不展示部门份额金额），份额口径的真实调用在 LocalAnalytics；
  // 这里直接调用同一渲染函数，验证草稿不会改变正式责任金额。
  const deptPanel = () => run(() => {
    const data = window.QualityLocal.state.data;
    const state = { ...window.LocalAnalytics.init('2026-11-24'), period: 'custom', from: '2026-01-01', to: '2026-12-31', department: '', product: '', rankMode: 'count', departmentMode: 'amount' };
    const box = document.createElement('div');
    box.innerHTML = window.LocalAnalytics.render(data, state);
    const panel = [...box.querySelectorAll('.panel')].find(item => item.textContent.includes('部门责任排行'));
    return panel ? panel.textContent : '';
  });
  const beforeDraft = await deptPanel();
  assert.ok(beforeDraft.includes('研发部') && beforeDraft.includes('0.12万') && beforeDraft.includes('0.08万'), '部门责任排行应按已确认比例计 1,200 / 800 元 :: ' + beforeDraft.slice(0, 300));
  claim = claimOf('CL-R1-UI-DRAFT');
  assert.equal((await qe1.request('/api/claims/CL-R1-UI-DRAFT/shares', { version: claim.version, shares: [{ dept: '研发部', ratio: 80 }, { dept: '生产部', ratio: 20 }], confirm: false }, 'PUT')).status, 200);
  await send('Page.navigate', { url: runtime.address });
  await until(() => run(() => !!document.querySelector('.review-nav')), 'reload after draft');
  await route('overview');
  const afterDraft = await deptPanel();
  check('未确认草稿不改变看板正式责任金额', beforeDraft === afterDraft && afterDraft.includes('0.12万'));
  await capture('02-草稿前后统计一致');

  // —— 3. 受限账号转出后的只读回看与照片 ——
  await loginAs('r1limited');
  await route('todo');
  check('待办筛选含起止日期与结果条件', await run(() => !!document.querySelector('#todoFrom') && !!document.querySelector('#todoTo')));
  await click('[data-todo-tab=done]');
  await until(() => run(() => !!document.querySelector('#todoKind')), 'done tab');
  await fill('#todoKind', 'transferred');
  await click('[data-todo-apply]');
  await until(() => run(() => document.querySelector('#todoBody')?.textContent?.includes('CL-R1-UI-SCOPE')), 'transferred row');
  check('已转出记录可按结果筛选并保留回看入口', await run(() => document.querySelector('#todoBody')?.textContent?.includes('已转出给 质量乙')));
  await capture('03-已转出筛选');
  await fill('#todoFrom', '2030-01-01');
  await fill('#todoTo', '2030-12-31');
  await click('[data-todo-apply]');
  await until(() => run(() => document.querySelector('#todoHint')?.textContent?.includes('不符合日期条件')), 'date excluded hint');
  const limitedHint = await text('#todoHint');
  check('日期筛选生效并准确说明范围外记录', (await text('.review-filter-count')).includes('共 0 条') && limitedHint.includes('日期不在所选范围') && !limitedHint.includes('未填写'));
  await click('[data-todo-reset]');
  await until(() => run(() => document.querySelectorAll('#todoBody tbody tr').length > 0 && !document.querySelector('#todoFrom').value), 'reset filters');
  check('重置恢复全部筛选条件', await run(() => document.querySelector('#todoBody')?.textContent?.includes('CL-R1-UI-SCOPE')));
  await click('[data-todo-tab=claims]');
  await until(() => run(() => document.querySelector('#page')?.textContent?.includes('质量处置（8D）')), 'dual progress');
  const progressText = await run(() => document.querySelector('#page').textContent);
  check('案件进度含质量处置与索赔两条独立进度', progressText.includes('质量处置（8D）') && progressText.includes('索赔整单') && progressText.includes('当前办理人'));
  await capture('04-双进度');
  await click('[data-todo-tab=done]');
  await until(() => run(() => document.querySelector('#todoBody')?.textContent?.includes('CL-R1-UI-SCOPE')), 'done tab again');
  await run(() => { const row = [...document.querySelectorAll('#todoBody tbody tr')].find(tr => tr.textContent.includes('CL-R1-UI-SCOPE')); row.querySelector('[data-open-claim]').click(); });
  await until(() => run(() => document.querySelector('#dialogRoot')?.textContent.includes('CL-R1-UI-SCOPE')), 'readonly detail');
  const readonlyText = await text('#dialogRoot');
  check('转出人只读回看详情且无办理入口', readonlyText.includes('质量乙') && await run(() => !document.querySelector('[data-claim-start]') && !document.querySelector('[data-claim-shares]')));
  const photoId = await run(() => document.querySelector('[data-wf-download]')?.dataset.wfDownload || '');
  check('转出人详情保留故障照片入口', !!photoId);
  const limitedPhoto = await run(async id => { const response = await fetch('/api/files/' + id, { credentials: 'include' }); return { status: response.status, type: response.headers.get('content-type') || '' }; }, photoId);
  check('转出人可读取故障照片', limitedPhoto.status === 200 && limitedPhoto.type.includes('image/png'));
  await capture('05-转出人只读回看与照片');

  // —— 4. 接收人读取同一条故障照片 ——
  await loginAs('r1qe2');
  await route('todo');
  await until(() => run(() => document.querySelector('#todoBody')?.textContent.includes('CL-R1-UI-SCOPE')), 'receiver todo');
  const receiverPhoto = await run(async id => { const response = await fetch('/api/files/' + id, { credentials: 'include' }); return { status: response.status, type: response.headers.get('content-type') || '' }; }, photo2.data.id);
  check('接收人可读取转办单的故障照片', receiverPhoto.status === 200 && receiverPhoto.type.includes('image/png'));
  await capture('06-接收人待办');

  check('浏览器无未捕获异常', issues.length === 0);
  const result = { ok: true, checks: checks.length, details: checks, errors: issues };
  await fs.writeFile(new URL('../test-results/r1/browser-results.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await Promise.race([exited, delay(3000)]); }
  await runtime?.close();
  await fs.rm(data, { recursive: true, force: true, maxRetries: 3 });
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
