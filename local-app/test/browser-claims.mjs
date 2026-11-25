// 阶段B浏览器自测：真实索赔新增、办理、分摊、转办与“我的待办与进度”。
// 复用仓库既有的 Edge CDP 测试方式，不引入新依赖；截图与结果写入 test-results/claims。
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
const { validatedUser, hashPassword } = await load('lib/auth.mjs');
const { randomUUID } = await import('node:crypto');
const data = await fs.mkdtemp(path.join(os.tmpdir(),'quality-claims-ui-test-'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(),'quality-claims-ui-browser-'));
const output = new URL('../test-results/claims/screenshots/',import.meta.url);
await fs.mkdir(output,{recursive:true});
let runtime, browser, socket;
const issues = [], checks = [];
async function until(check, label) {
  for(let attempt=0;attempt<160;attempt++){
    if(await check())return;
    await delay(100);
  }
  throw Error('Timed out: '+label+' '+issues.join(' | '));
}
try {
  await seedPreview(data,{legacyAccounts:true});
  const credentials = Object.fromEntries((await fs.readFile(path.join(data,'测试账号.txt'),'utf8')).split(/\r?\n/).map(line=>line.match(/：([a-z0-9]+)\s+密码：(\S+)/)).filter(Boolean).map(match=>[match[1],match[2]]));
  runtime = await startServer({dataDir:data,environment:'test',testMode:true});
  // 第二名质量工程师仅用于整单转办用例，属测试夹具，不进入发布数据。
  const peer=validatedUser({username:'qe-ui-2',name:'质量乙',dept:'质量部',role:'quality-engineer'});
  runtime.store.put('users',randomUUID(),{...peer,passwordHash:await hashPassword('Test-Qe2-123456'),createdAt:new Date().toISOString(),mustChangePassword:false},{event:'test.fixture'});
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
  function check(label, condition){assert.ok(condition,label);checks.push(label);console.log('PASS',checks.length,label);}
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:runtime.address});
  await until(()=>run(()=>!!document.querySelector('#authForm')),'login form');
  async function login(username){
    await run((name,password)=>{const form=document.querySelector('#authForm');form.elements.username.value=name;form.elements.password.value=password;form.requestSubmit();},username,credentials[username]);
    await until(()=>run(()=>!!document.querySelector('.review-nav')),'navigation '+username);
  }
  async function route(id){
    await click('.review-nav [data-route="'+id+'"],.review-subnav [data-route="'+id+'"]');
    await until(()=>run(id=>window.QualityLocal.state.route===id&&document.querySelector('#page').dataset.uiRoute===id,id),'route '+id);
    await delay(150);
  }
  const text=selector=>run(selector=>document.querySelector(selector)?.textContent||'',selector);
  const fill=(selector,value)=>run((selector,value)=>{const element=document.querySelector(selector);if(!element)throw Error('Missing '+selector);element.value=value;element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));},selector,value);

  await login('quality');
  check('质量工程师真实会话',await run(()=>window.QualityLocal.state.user.username==='quality'));
  const navRoutes=await run(()=>[...document.querySelectorAll('.review-nav button,.review-subnav button')].map(button=>button.dataset.route));
  check('我的待办与进度为独立主导航',navRoutes.includes('todo'));
  const waitGone=selector=>until(()=>run(selector=>!document.querySelector(selector),selector),'gone '+selector);
  const hideTutorial=()=>run(()=>document.querySelector('[data-tutorial=hide]')?.click());
  await hideTutorial();
  await route('claims');
  check('索赔清单保留原22列并追加办理状态列',await run(()=>{const heads=[...document.querySelectorAll('.review-claims-table thead th')].map(th=>th.textContent);return heads.length===30&&heads[0]==='处理日期'&&heads[21]==='备注'&&heads[22]==='当前经办人'&&heads[23]==='办理阶段'&&heads[26]==='实际赔付'&&heads[28]==='是否逾期'&&heads[29]==='操作';}));
  await capture('01-索赔清单');
  await click('[data-claim-new]');
  await until(()=>run(()=>!!document.querySelector('#claimForm')),'new claim form');
  const newFormFields=await run(()=>[...document.querySelectorAll('#claimForm [name]')].map(input=>input.name));
  check('新增表单覆盖原22项字段并含经办人与期限',['id','customer','amount','issue','processingDate','supplierAgreed','remarks','ownerId','deadline'].every(name=>newFormFields.includes(name)));
  await run(()=>{const value=(name,text)=>{const input=document.querySelector('#claimForm [name="'+name+'"]');if(!input)throw Error('缺少字段 '+name);input.value=text;};value('id','CL-UI-001');value('processingDate','2026-11-20');value('customer','界面测试客户');value('issue','外观划伤与包装破损');value('amount','1234.56');value('agreed','1000');value('actual','900');value('deadline','2026-09-30');});
  await run(()=>{const row=document.querySelector('#allocRowsNew [data-alloc-row]');row.querySelector('[data-alloc-dept]').value='质量部';row.querySelector('[data-alloc-ratio]').value='100';row.querySelector('[data-alloc-ratio]').dispatchEvent(new Event('input',{bubbles:true}));});
  await until(()=>run(()=>document.querySelector('#allocPreviewNew').textContent.includes('100.00%')),'create preview');
  check('新增表单用同一算法预览分摊',await run(()=>{const t=document.querySelector('#allocPreviewNew').textContent;return t.includes('1,234.56')&&t.includes('1,000.00')&&t.includes('900.00');}));
  await click('[data-action=save-form]');
  await waitGone('#claimForm');
  await until(()=>run(()=>document.querySelector('#page').textContent.includes('CL-UI-001')),'new claim row');
  check('新增时的分摊以草稿保存并标未确认',await run(()=>{const row=[...document.querySelectorAll('.review-claims-table tbody tr')].find(tr=>tr.textContent.includes('CL-UI-001'));return !!row&&row.textContent.includes('质量部 100.00%')&&row.textContent.includes('未确认');}));
  check('新增后进入真实清单，经办人默认为本人',await run(()=>{const row=[...document.querySelectorAll('.review-claims-table tbody tr')].find(tr=>tr.textContent.includes('CL-UI-001'));return !!row&&row.textContent.includes('质量工程师');}));
  check('逾期标记来自真实期限',await run(()=>{const row=[...document.querySelectorAll('.review-claims-table tbody tr')].find(tr=>tr.textContent.includes('CL-UI-001'));return row.textContent.includes('逾期');}));
  await capture('02-新增索赔行');
  await run(()=>{window.confirm=()=>true;});
  await click('.review-claims-table tbody tr [data-claim-act]');
  await until(()=>run(()=>document.querySelector('#dialogRoot').textContent.includes('办理状态')),'claim detail');
  check('详情显示阶段、未确认分摊与金额分摊表',await run(()=>{const t=document.querySelector('#dialogRoot').textContent;return t.includes('待处理')&&t.includes('未确认')&&t.includes('按已确认比例分摊');}));
  await capture('03-索赔详情');
  await click('[data-claim-shares]');
  await until(()=>run(()=>!!document.querySelector('#allocForm')),'alloc form');
  await until(()=>run(()=>document.querySelector('#allocPreview').textContent.includes('当前合计')),'alloc preview');
  check('分摊预览显示真实金额口径',await run(()=>{const t=document.querySelector('#allocPreview').textContent;return t.includes('1,234.56')&&t.includes('1,000.00')&&t.includes('900.00');}));
  await run(()=>{const rows=document.querySelectorAll('#allocRows [data-alloc-row]');rows[0].querySelector('[data-alloc-dept]').value='质量部';rows[0].querySelector('[data-alloc-ratio]').value='60';rows[0].querySelector('[data-alloc-ratio]').dispatchEvent(new Event('input',{bubbles:true}));});
  await click('[data-alloc-add]');
  await run(()=>{const rows=document.querySelectorAll('#allocRows [data-alloc-row]');const second=rows[rows.length-1];second.querySelector('[data-alloc-dept]').value='生产部';second.querySelector('[data-alloc-ratio]').value='40';second.querySelector('[data-alloc-ratio]').dispatchEvent(new Event('input',{bubbles:true}));});
  await until(()=>run(()=>document.querySelector('#allocPreview').textContent.includes('100.00%')&&document.querySelector('#allocPreview').textContent.includes('740.74')),'two dept preview');
  check('两部门按比例分摊到分且合计100%',await run(()=>{const t=document.querySelector('#allocPreview').textContent;return t.includes('质量部')&&t.includes('生产部')&&t.includes('493.82');}));
  await capture('04-分摊预览');
  await click('[data-shares-confirm]');
  await waitGone('#allocForm');
  await until(()=>run(()=>document.querySelector('#dialogRoot').textContent.includes('首次录入责任分摊')),'first confirm history');
  check('确认后写入基线并保留首次录入历史',await run(()=>{const t=document.querySelector('#dialogRoot').textContent;return t.includes('质量部 60.00% / 生产部 40.00%')&&t.includes('已确认');}));
  await click('[data-claim-shares]');
  await until(()=>run(()=>!!document.querySelector('#allocForm')),'alloc form again');
  await run(()=>{const rows=document.querySelectorAll('#allocRows [data-alloc-row]');rows[0].querySelector('[data-alloc-ratio]').value='70';rows[0].querySelector('[data-alloc-ratio]').dispatchEvent(new Event('input',{bubbles:true}));rows[1].querySelector('[data-alloc-ratio]').value='30';rows[1].querySelector('[data-alloc-ratio]').dispatchEvent(new Event('input',{bubbles:true}));});
  await click('[data-shares-confirm]');
  await until(()=>run(()=>document.querySelector('#allocError')?.textContent.includes('修改原因')),'reason required');
  check('修改已确认比例服务端要求填写原因',await run(()=>document.querySelector('#allocForm')!==null&&document.querySelector('#allocError').textContent.includes('修改原因')));
  await capture('05-分摊缺原因被拒');
  await fill('#allocReason','复测确认主要责任在质量部');
  await click('[data-shares-confirm]');
  await waitGone('#allocForm');
  await until(()=>run(()=>document.querySelector('#dialogRoot').textContent.includes('质量部 70.00% / 生产部 30.00%')),'shares updated');
  check('填写原因后更新基线并保留原确认值与原因',await run(()=>{const t=document.querySelector('#dialogRoot').textContent;return t.includes('原确认：质量部 60.00% / 生产部 40.00%')&&t.includes('复测确认主要责任在质量部');}));
  await click('[data-claim-start]');
  await until(()=>run(()=>!!document.querySelector('[data-claim-processed]')),'claim started');
  check('开始办理后阶段为处理中',await run(()=>document.querySelector('#dialogRoot').textContent.includes('处理中')));
  await click('[data-claim-processed]');
  await until(()=>run(()=>!!document.querySelector('#claimProcessForm')),'processed form');
  await run(()=>{const note=document.querySelector('#claimProcessForm [name=note]');note.value='已与客户确认返工方案并完成复检';const due=document.querySelector('#claimProcessForm [name=deadline]');due.value='2026-12-15';});
  await click('[data-action=save-form]');
  await waitGone('#claimProcessForm');
  await until(()=>run(()=>document.querySelector('#dialogRoot').textContent.includes('2026-12-15')),'deadline updated');
  check('提交处理结果进入待结算并更新期限',await run(()=>{const t=document.querySelector('#dialogRoot').textContent;return t.includes('待结算')&&t.includes('2026-12-15');}));
  await click('[data-claim-complete]');
  await until(()=>run(()=>!!document.querySelector('#claimCompleteForm')),'complete form');
  await click('[data-action=save-form]');
  await until(()=>run(()=>document.querySelector('#formError').textContent.includes('结算结论')),'complete rejected');
  check('结束不能只凭金额，必须写结算结论',await run(()=>document.querySelector('#claimCompleteForm')!==null&&document.querySelector('#formError').textContent.includes('结算结论')));
  await run(()=>{const form=document.querySelector('#claimCompleteForm');form.elements.mode.value='无需赔付';const note=document.querySelector('#claimCompleteForm [name=note]');note.value='客户自行处理外观返修，不涉及赔付';});
  await click('[data-action=save-form]');
  await waitGone('#claimCompleteForm');
  await until(()=>run(()=>document.querySelector('#dialogRoot').textContent.includes('不涉及赔付')),'claim completed');
  check('无需赔付须有结论才能结束',await run(()=>document.querySelector('#dialogRoot').textContent.includes('已完成')));
  await capture('06-索赔已完成');
  await run(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  await delay(250);
  await hideTutorial();
  await route('todo');
  await until(()=>run(()=>!!document.querySelector('#todoBody')&&!document.querySelector('#todoBody').textContent.includes('正在读取')),'workbench loaded');
  check('待办页签含待我处理/已处理已转出/案件进度',await run(()=>['待我处理','我已处理','案件进度'].every(label=>document.querySelector('#page').textContent.includes(label))));
  check('案件进度统计真实索赔阶段',await run(()=>document.querySelector('#page').textContent.includes('索赔已完成')));
  await click('[data-todo-tab="claims"]');
  await until(()=>run(()=>document.querySelector('#page').textContent.includes('CL-UI-001')),'claim in progress tab');
  check('案件进度显示真实索赔阶段与分摊',await run(()=>{const row=[...document.querySelectorAll('#todoBody tbody tr')].find(tr=>tr.textContent.includes('CL-UI-001'));return !!row&&row.textContent.includes('已完成')&&row.textContent.includes('质量部 70.00% / 生产部 30.00%');}));
  check('来源条件在案件进度页签禁用并说明',await run(()=>document.querySelector('#todoSource').disabled&&document.querySelector('#todoHint').textContent.includes('来源条件不适用')));
  await capture('07-案件进度');
  await click('[data-todo-tab="done"]');
  await until(()=>run(()=>document.querySelector('#page').textContent.includes('CL-UI-001')),'done tab claim');
  check('已处理页签回看本人办结的索赔',await run(()=>{const row=[...document.querySelectorAll('#todoBody tbody tr')].find(tr=>tr.textContent.includes('CL-UI-001'));return !!row&&row.textContent.includes('已完成')&&row.textContent.includes('只读查看');}));
  check('逾期条件在已处理页签禁用并说明',await run(()=>document.querySelector('#todoOverdue').disabled&&document.querySelector('#todoHint').textContent.includes('不判定逾期')));
  await capture('08-已处理回看');
  await click('[data-todo-tab="todo"]');
  await until(()=>run(()=>!!document.querySelector('#todoSource')&&!document.querySelector('#todoSource').disabled),'todo tab filters');
  await run(()=>{document.querySelector('#todoOverdue').value='是';document.querySelector('[data-todo-apply]').click();});
  await until(()=>run(()=>document.querySelector('#page').textContent.includes('只看逾期')),'overdue applied');
  check('只看逾期筛选真实生效并影响条数',await run(()=>{const count=document.querySelector('.review-filter-count').textContent;const rows=document.querySelectorAll('#todoBody tbody tr').length;return /共 \d+ 条/.test(count)&&rows<=1;}));
  await run(()=>document.querySelector('[data-todo-reset]').click());
  await delay(200);
  check('重置恢复全部筛选条件',await run(()=>document.querySelector('#todoOverdue').value===''&&/[1-9]\d* 条|共 \d+ 条/.test(document.querySelector('.review-filter-count').textContent)));
  await route('claims');
  await click('[data-claim-new]');
  await until(()=>run(()=>!!document.querySelector('#claimForm')),'second claim form');
  await run(()=>{const value=(name,text)=>{const input=document.querySelector('#claimForm [name="'+name+'"]');if(!input)throw Error('缺少字段 '+name);input.value=text;};value('id','CL-UI-002');value('date','2026-11-22');value('customer','转办测试客户');value('amount','0.01');value('deadline','2026-12-31');});
  await click('[data-action=save-form]');
  await waitGone('#claimForm');
  await until(()=>run(()=>document.querySelector('#page').textContent.includes('CL-UI-002')),'second claim row');
  await click('[data-claim-act="CL-UI-002"]');
  await until(()=>run(()=>!!document.querySelector('[data-claim-transfer]')),'transfer entry');
  await click('[data-claim-transfer]');
  await until(()=>run(()=>!!document.querySelector('#claimTransferForm')),'transfer form');
  await click('[data-action=save-form]');
  await until(()=>run(()=>document.querySelector('#formError').textContent.length>0),'transfer requires target');
  check('整单转办未选接收人时服务端拒绝',await run(()=>document.querySelector('#claimTransferForm')!==null&&document.querySelector('#formError').textContent.includes('接收')));
  const target=await run(()=>[...document.querySelectorAll('#claimTransferForm [name=to] option')].map(option=>option.value).filter(Boolean)[0]);
  await run(target=>{const form=document.querySelector('#claimTransferForm');form.elements.to.value=target;const reason=document.querySelector('#claimTransferForm [name=reason]');reason.value='客户由另一质量工程师跟进';},target);
  await click('[data-action=save-form]');
  await waitGone('#claimTransferForm');
  await until(()=>run(()=>document.querySelector('#dialogRoot').textContent.includes('客户由另一质量工程师跟进')),'transfer recorded');
  check('转办后原经办人不再显示办理入口',await run(()=>!document.querySelector('[data-claim-start]')&&!document.querySelector('[data-claim-processed]')&&!document.querySelector('[data-claim-shares]')));
  await capture('09-整单转办');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
  await send('Page.navigate',{url:runtime.address});
  await until(()=>run(()=>!!document.querySelector('.review-nav')),'reload narrow');
  await route('claims');
  check('390px 索赔宽表在表内横向滚动，页面不溢出',await run(()=>{const wrap=document.querySelector('.review-claims-table');return !!wrap&&wrap.scrollWidth>wrap.clientWidth&&document.documentElement.scrollWidth<=392;}));
  await route('todo');
  await until(()=>run(()=>!!document.querySelector('#todoBody')),'narrow todo');
  check('390px 待办页仍可操作',await run(()=>document.querySelectorAll('#todoBody tbody tr').length>=0&&document.querySelector('[data-todo-tab=todo]')!==null));
  await capture('10-390px待办');
  check('浏览器无未捕获异常',issues.length===0);
  const result={ok:true,checks:checks.length,details:checks,errors:issues};
  await fs.writeFile(new URL('../test-results/claims/browser-results.json',import.meta.url),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{
  socket?.close();
  if(browser&&browser.exitCode===null){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill();await Promise.race([exited,delay(3000)]);}
  await runtime?.close();
  await fs.rm(data,{recursive:true,force:true,maxRetries:3});
  await fs.rm(profile,{recursive:true,force:true,maxRetries:3}).catch(()=>{});
}
