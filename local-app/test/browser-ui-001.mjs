import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const app = path.resolve(process.argv[2] || fileURLToPath(new URL('../', import.meta.url)));
const load = file => import(pathToFileURL(path.join(app,file)).href);
const { seedPreview } = await load('scripts/seed-preview.mjs');
const { startServer } = await load('server.mjs');
const data = await fs.mkdtemp(path.join(os.tmpdir(),'quality-live-ui-test-'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(),'quality-live-ui-browser-'));
const output = new URL('../test-results/ui-001/screenshots/',import.meta.url);
await fs.mkdir(output,{recursive:true});
let runtime, browser, socket;
const issues = [], checks = [];
async function until(check, label) {
  for(let attempt=0;attempt<120;attempt++){
    if(await check())return;
    await delay(100);
  }
  throw Error('Timed out: '+label+' '+issues.join(' | '));
}
try {
  await seedPreview(data,{legacyAccounts:true});
  const credentials = Object.fromEntries((await fs.readFile(path.join(data,'测试账号.txt'),'utf8')).split(/\r?\n/).map(line=>line.match(/：([a-z0-9]+)\s+密码：(\S+)/)).filter(Boolean).map(match=>[match[1],match[2]]));
  runtime = await startServer({dataDir:data,environment:'test',testMode:true});
  browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',[
    '--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'
  ],{windowsHide:true,stdio:'ignore'});
  let endpoint='';
  await until(async()=>{endpoint=await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8').catch(()=>'');return endpoint;},'debug endpoint');
  const port=endpoint.split(/\r?\n/)[0];
  const pages=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let sequence=0;
  const pending=new Map();
  socket.addEventListener('message',({data})=>{
    const message=JSON.parse(data);
    if(message.method==='Runtime.exceptionThrown') issues.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
    const job=pending.get(message.id);
    if(job){pending.delete(message.id);message.error?job.reject(Error(message.error.message)):job.resolve(message.result);}
  });
  function send(method,params={}){
    return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  }
  async function evaluate(expression){
    const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
  }
  const run=(fn,...args)=>evaluate('('+fn.toString()+')('+args.map(value=>JSON.stringify(value)).join(',')+')');
  const click=selector=>run(selector=>{const element=document.querySelector(selector);if(!element)throw Error('Missing '+selector);element.click();},selector);
  async function capture(name){
    const image=await send('Page.captureScreenshot',{format:'png'});
    await fs.writeFile(new URL(name+'.png',output),Buffer.from(image.data,'base64'));
  }
  function check(label, condition){assert.ok(condition,label);checks.push(label);}
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:runtime.address});
  await until(()=>run(()=>!!document.querySelector('#authForm')),'real login');
  check('真实登录页仍需要账号密码',await run(()=>!!document.querySelector('#authForm [name=password]')));
  async function login(username){
    await run((name,password)=>{const form=document.querySelector('#authForm');form.elements.username.value=name;form.elements.password.value=password;form.requestSubmit();},username,credentials[username]);
    await until(()=>run(()=>!!document.querySelector('.review-nav')),'authenticated navigation '+username);
  }
  await login('admin');
  check('管理员真实会话加载',await run(()=>window.QualityLocal.state.user.role==='admin'));
  check('五个顶部模块',await run(()=>document.querySelectorAll('.review-nav button').length===5));
  check('白色卡片及深红品牌',await run(()=>getComputedStyle(document.querySelector('.v4-board-filter')).backgroundColor==='rgb(255, 255, 255)'&&getComputedStyle(document.querySelector('.review-nav [aria-current]')).color==='rgb(166, 40, 53)'));
  check('报故看板七项数量指标，索赔指标独立',await run(()=>document.querySelectorAll('.v4-kpis .kpi').length===7));
  check('新图表且无离线数据注入',await run(()=>!!document.querySelector('.review-line-chart')&&!!document.querySelector('.review-donut')&&!document.getElementById('preview-fixtures')));
  await capture('01-真实质量看板');
  const totals=()=>run(()=>document.querySelector('.v4-kpis .kpi b').textContent);
  const originalTotal=await totals();
  await run(()=>{const field=document.querySelector('[data-board=to]');field.value=field.value.slice(0,4)+'-01-31';field.dispatchEvent(new Event('change',{bubbles:true}));});
  check('修改日期尚不应用',await totals()===originalTotal);
  await click('[data-v4=board-apply-dates]');
  check('日期确定后真实数据改变',await totals()!==originalTotal);
  await click('[data-mode=claims]');
  check('索赔看板独立且显示转嫁口径',await run(()=>document.querySelector('#page').textContent.includes('转嫁金额')&&!document.querySelector('#page').textContent.includes('月度报故趋势')));
  await capture('07-真实索赔看板');
  const claimAmount=()=>run(()=>document.querySelector('.review-claim-kpis .kpi:nth-child(2) b').textContent);
  const originalClaimAmount=await claimAmount();
  await run(()=>{const field=document.querySelector('[data-review-amount=amountMin]');field.value='999999999';field.dispatchEvent(new Event('input',{bubbles:true}));});
  check('索赔金额草稿未立即改变统计',await claimAmount()===originalClaimAmount);
  await click('[data-v4=board-apply-dates]');
  check('索赔金额确定后真实筛选为无匹配',Number((await claimAmount()).replaceAll(',',''))===0);
  await click('[data-v4=board-reset]');
  check('索赔金额重置恢复原金额',await claimAmount()===originalClaimAmount);
  await click('[data-mode=faults]');
  check('切回保留报故日期',await run(()=>document.querySelector('[data-board=to]').value.endsWith('-01-31')));
  await click('[data-v4=board-reset]');
  check('看板重置恢复本年原数量',await totals()===originalTotal);
  await click('.review-donut-legend button');
  await until(()=>run(()=>document.querySelector('#dialogRoot').textContent.includes('明细')),'chart details');
  check('图表可追溯真实记录',await run(()=>document.querySelector('#dialogRoot').textContent.includes('MOCK')));
  await run(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  async function route(id){
    await click('.review-nav [data-route="'+id+'"],.review-subnav [data-route="'+id+'"]');
    await until(()=>run(id=>window.QualityLocal.state.route===id&&document.querySelector('#page').dataset.uiRoute===id,id),'route '+id);
    await delay(100);
  }
  await route('faults');
  check('所有报故列表仍可访问',await run(()=>document.querySelectorAll('#page tbody tr').length===window.QualityLocal.state.data.faults.length));
  await capture('02-真实报故列表');
  await run(()=>{const form=document.querySelector('[data-list-filter=faults]');form.elements.customer.selectedIndex=1;form.requestSubmit();});
  await until(()=>run(()=>document.querySelectorAll('#page tbody tr').length<144),'fault customer filter');
  check('报故列表筛选真实客户记录',await run(()=>document.querySelectorAll('#page tbody tr').length>0));
  await click('[data-clear-list-filter]');
  await click('#page [data-open-fault]');
  await until(()=>run(()=>document.querySelector('#dialogRoot').textContent.includes('报故详情')),'fault details');
  check('原报故全部主要字段及初步分析保留',await run(()=>['SN','料号','初步失效分析','发生地点'].every(text=>document.querySelector('#dialogRoot').textContent.includes(text))));
  await capture('03-真实报故详情');
  await run(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  await route('work');
  await click('.review-subnav [data-route=closure]');
  await until(()=>run(()=>!!document.querySelector('#metricResult table')),'department metrics');
  check('8D模块容纳部门关闭率',await run(()=>document.querySelector('.review-nav [aria-current]').textContent.includes('8D')));
  await capture('04-真实部门关闭率');
  const metricBefore=await run(()=>document.querySelector('#metricResult tbody').textContent);
  await run(()=>{document.getElementById('metricFrom').value='2026-01-01';document.getElementById('metricDepartment').selectedIndex=1;});
  await click('[data-action=metric-refresh]');
  await until(()=>run(()=>document.querySelectorAll('#metricResult tbody tr').length===1),'custom department metrics');
  check('起止时间及部门查询真实接口',await run(()=>document.getElementById('metricResult').textContent.includes('2026-01-01')));
  await click('[data-action=metric-reset]');
  await until(()=>run(()=>!!document.querySelector('#metricResult table')),'metric reset');
  check('部门指标重置恢复原统计',await run(()=>document.querySelector('#metricResult tbody').textContent)===metricBefore);
  await route('archives');
  check('报告库仍能预览PDF',await run(()=>!!document.querySelector('[data-open-pdf]')));
  await route('claims');
  check('原索赔详情与导出保留',await run(()=>!!document.querySelector('[data-open-claim]')&&!!document.querySelector('[data-action=export-claims]')));
  check('索赔表恰为22个确认字段',await run(()=>document.querySelectorAll('.review-claims-table th').length===22));
  await capture('08-真实索赔记录');
  await click('[data-expand-filters]');
  check('索赔高级筛选展开',await run(()=>!document.querySelector('[data-extra-filters]').hidden));
  await run(()=>{const form=document.querySelector('[data-list-filter=claims]');form.elements.customer.selectedIndex=1;form.requestSubmit();});
  check('索赔客户筛选作用于真实记录',await run(()=>{const rows=document.querySelectorAll('.review-claims-table tbody tr');return rows.length>0&&rows.length<window.QualityLocal.state.data.claims.length;}));
  await click('[data-clear-list-filter]');
  check('索赔筛选重置恢复全部记录',await run(()=>document.querySelectorAll('.review-claims-table tbody tr').length===window.QualityLocal.state.data.claims.length));
  await click('[data-expand-filters]');
  check('索赔高级筛选收起',await run(()=>document.querySelector('[data-extra-filters]').hidden));
  async function importEntry(kind,back){
    await click('[data-import-kind="'+kind+'"]');
    await until(()=>run(()=>!!document.getElementById('importForm')),'import '+kind);
    check(kind+'导入已预选且锁定类型',await run(kind=>document.getElementById('importKind').value===kind&&document.getElementById('importKind').disabled,kind));
    if(back){await route(back);}
  }
  await importEntry('claim','claims');
  await route('faults');
  await importEntry('fault');
  check('原导入模板与预览保留',await run(()=>!!document.querySelector('#importForm')&&!!document.querySelector('#templateDownload')));
  const csv='报故单号,报故日期,产品名称,故障信息,数量\nUI-REAL-IMPORT,2026-11-19,模拟屏幕,模拟导入检查,1\n';
  await run(async text=>{
    const csrf=window.QualityLocal.state.data.csrf;
    const request=(url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)}).then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.error);return data;});
    const preview=await request('/api/imports/preview',{kind:'fault',name:'ui-real.csv',base64:btoa(unescape(encodeURIComponent(text)))});
    if(preview.errors.length)throw Error('Import preview validation failed');
    const result=await request('/api/imports/'+preview.batchId+'/commit',{});
    if(result.inserted!==1)throw Error('Expected one inserted synthetic report');
    const response=await fetch('/api/bootstrap');
    const data=await response.json();
    if(data.faults.filter(row=>row.id==='UI-REAL-IMPORT').length!==1)throw Error('Imported synthetic report not found');
  },csv);
  await route('overview');
  await importEntry('shipment','overview');
  await importEntry('product','overview');
  await route('users');
  await route('system');
  await route('guide');
  check('原管理与使用说明页面可达',await run(()=>document.querySelector('#page').textContent.length>100));
  await route('work');
  await run(()=>{location.hash='#analysis/'+encodeURIComponent(window.QualityLocal.state.data.analyses.find(item=>item.status==='active').id);});
  await until(()=>run(()=>!!document.querySelector('#analysisModal')),'8D analysis');
  check('8D D1到D8导航保留',await run(()=>document.querySelectorAll('[data-stage-nav]').length>=8));
  await capture('05-真实8D详情');
  await run(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  await route('overview');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  check('窄屏看板无整页横溢',await run(()=>document.documentElement.scrollWidth<=innerWidth+2));
  await capture('06-真实窄屏看板');
  await route('faults');
  check('窄屏报故无整页横溢',await run(()=>document.documentElement.scrollWidth<=innerWidth+2));
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await route('overview');
  await click('[data-mode=claims]');
  await run(()=>{const input=document.querySelector('[data-review-amount=amountMin]');input.value='12345';input.dispatchEvent(new Event('input',{bubbles:true}));});
  await click('[data-mode=faults]');
  await run(()=>{const input=document.querySelector('[data-board=to]');input.value=input.value.slice(0,4)+'-01-31';input.dispatchEvent(new Event('change',{bubbles:true}));});
  for(const username of ['sales','change','engineering']){
    await click('[data-action=logout]');
    await until(()=>run(()=>!!document.querySelector('#authForm')),'logout');
    await login(username);
    const routes=await run(()=>[...document.querySelectorAll('.review-nav button,.review-subnav button')].map(button=>button.dataset.route));
    if(username==='sales'){
      check('同页切换账号清除上一账号的日期草稿',await run(()=>!document.querySelector('[data-board=to]').value.endsWith('-01-31')));
      await click('[data-mode=claims]');
      check('同页切换账号清除上一账号的金额草稿',await run(()=>document.querySelector('[data-review-amount=amountMin]').value===''));
    }
    if(username==='sales')check('查看账号未获得报故索赔和管理入口',!routes.includes('faults')&&!routes.includes('claims')&&!routes.includes('users')&&!routes.includes('imports'));
    if(username==='change')check('编号填报账号保留专用工作台',await run(()=>document.querySelector('#page').textContent.includes('冻结编号与数量填报')));
    if(username==='engineering')check('执行账号未获得管理员入口',!routes.includes('users')&&!routes.includes('system'));
  }
  check('浏览器无未捕获异常',issues.length===0);
  const result={ok:true,checks:checks.length,details:checks,errors:issues};
  await fs.writeFile(new URL('../test-results/ui-001/browser-results.json',import.meta.url),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{
  socket?.close();
  if(browser&&browser.exitCode===null){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill();await Promise.race([exited,delay(3000)]);}
  await runtime?.close();
  await fs.rm(data,{recursive:true,force:true,maxRetries:3});
  await fs.rm(profile,{recursive:true,force:true,maxRetries:3}).catch(()=>{});
}


