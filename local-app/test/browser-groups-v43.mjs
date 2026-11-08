import {spawn} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import {seedPreview} from '../scripts/seed-preview.mjs';import {startServer} from '../server.mjs';import {testProfiles,initialTestPassword} from '../lib/group-policy.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(root,'test-results');fs.mkdirSync(out,{recursive:true});const testDir=fs.mkdtempSync(path.join(os.tmpdir(),'quality-v43-browser-test-'));await seedPreview(testDir,{complete:false});const runtime=await startServer({dataDir:testDir,testMode:true}),passwords=Object.fromEntries(testProfiles.map(p=>[p[0],initialTestPassword(p[0])])),targetId=runtime.store.list('analyses')[0].id;
const port=9344,profile=fs.mkdtempSync(path.join(os.tmpdir(),'quality-v43-edge-test-')),child=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket,seq=0;const pending=new Map(),errors=[],checks=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});}
async function run(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
const ef=(fn,...args)=>run('('+fn.toString()+')('+args.map(x=>JSON.stringify(x)).join(',')+')');
async function wait(fn,msg='UI not ready'){for(let i=0;i<100;i++){try{if(await ef(fn))return;}catch{}await delay(80);}throw Error(msg);}
const click=async s=>{await ef(s=>{const e=document.querySelector(s);if(!e)throw Error('Missing '+s);if(e.disabled)throw Error('Disabled '+s);e.click();},s);await delay(90);await wait(()=>!document.body.hasAttribute('aria-busy'));};
const set=async(s,v)=>ef((s,v)=>{const e=document.querySelector(s);if(!e)throw Error('Missing '+s);if(e.type==='checkbox')e.checked=v;else e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));},s,v);
const check=(name,v)=>{assert.ok(v,name);checks.push(name);};
const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
async function api(url,body){return ef(async(url,body)=>{const opt={method:body===null?'GET':'POST',headers:{}};if(body!==null){opt.headers['content-type']='application/json';opt.headers['x-csrf-token']=window.QualityLocal.state.data.csrf;opt.body=JSON.stringify(body);}const r=await fetch(url,opt),d=await r.json();if(!r.ok)throw Error(r.status+' '+d.error);return d;},url,body??null);}
async function login(user){await wait(()=>!!document.querySelector('#authForm'));await set('[name=username]',user);await set('[name=password]',passwords[user]);await click('#authForm button[type=submit]');await wait(()=>!!window.QualityLocal.state.user);}
async function logout(){await ef(()=>{location.hash='';});await click('[data-action=logout]');await wait(()=>!!document.querySelector('#authForm'));assert.ok(!await ef(()=>!!document.querySelector('#testTutorial')),'退出登录清除旧账号指引');}
async function clearForms(){for(let i=0;i<12&&await ef(()=>!!document.querySelector('#formModal'));i++)await click('[data-action=close-form]');}
try{
 let pages;for(let i=0;i<80;i++){try{pages=await(await fetch('http://127.0.0.1:'+port+'/json')).json();if(pages.some(p=>p.type==='page'))break;}catch{}await delay(100);}assert.ok(pages?.length);socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise(r=>socket.onopen=r);socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.method==='Page.javascriptDialogOpening')send('Page.handleJavaScriptDialog',{accept:true});if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:runtime.address});
await login('admin');check('管理员拥有账号分组管理',await ef(()=>window.QualityLocal.state.user.role==='admin'));

async function viewport(width, height=1000) {
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await delay(320);
}
const railWidth=()=>ef(()=>document.querySelector('.workspace-nav-rail').getBoundingClientRect().width);
async function assertWorkspace(width, expanded) {
  const info=await ef(()=>{
    const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();
    const overlap=(a,b)=>a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1;
    const rail=rect('.workspace-nav-rail'), main=rect('.main-wrap'), header=rect('.workspace-breadcrumb');
    const guide=rect('#testTutorial'), button=rect('.workspace-nav-open');
    return {rail,main,overflow:document.documentElement.scrollWidth-innerWidth,
      navOverlap:overlap(rail,main),buttonOverlap:overlap(button,header),
      guideOverlap:['.v4-module-tabs','.v4-board-filter','.v4-kpis','.v4-chart']
        .filter(s=>document.querySelector(s)).some(s=>overlap(guide,rect(s)))};
  });
  if(info.overflow>1||info.navOverlap||info.buttonOverlap||info.guideOverlap||(expanded?info.rail.width<180:(width<=900?info.rail.height>1:info.rail.width>1)))console.error(info);
  check(width+'px '+(expanded?'expanded':'collapsed')+' workspace stays in flow',
    info.overflow<=1&&!info.navOverlap&&!info.buttonOverlap&&!info.guideOverlap&&
    (expanded?info.rail.width>=180:(width<=900?info.rail.height<=1:info.rail.width<=1)));
}
async function dragTo(delta, expected) {
  const {x,y}=await ef(()=>{const r=document.querySelector('.workspace-nav-resize').getBoundingClientRect();return {x:r.left+4,y:r.top+100};});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+delta,y,button:'left',buttons:1});
  try {
    check('mouse drag updates grid before release to '+expected,
      await railWidth()===expected&&await ef(()=>document.documentElement.classList.contains('workspace-nav-drag-active')));
  } finally {
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+delta,y,button:'left',clickCount:1});
  }
  check('drag cleanup',await ef(()=>!document.documentElement.classList.contains('workspace-nav-drag-active')));
}
check('default navigation width is 240',await railWidth()===240);
for(const width of [1920,1440,1366,1024]){
  await viewport(width);
  await assertWorkspace(width,true);
  await click('.workspace-nav-close');await delay(230);
  await assertWorkspace(width,false);
  await click('.workspace-nav-open');await delay(230);
}
await dragTo(300,360);
await dragTo(-275,180);
await dragTo(132,312);
await click('.workspace-nav-close');await delay(230);
await send('Page.reload');await delay(650);await wait(()=>!!document.querySelector('.workspace-nav-open:not([hidden])'));
await assertWorkspace(1024,false);
await click('.workspace-nav-open');await delay(230);
check('refresh and reopen restore 312px',await railWidth()===312);
await viewport(901);
check('responsive cap keeps 640px for content',await ef(()=>{
  const shell=document.querySelector('.app-shell');
  return shell.querySelector('.workspace-nav-rail').getBoundingClientRect().width===shell.clientWidth-640 &&
    shell.querySelector('.main-wrap').getBoundingClientRect().width>=639;
}));
await viewport(1024);
check('widening restores preferred width',await railWidth()===312);
await viewport(390,844);
await assertWorkspace(390,true);
await click('.workspace-nav-close');await delay(230);
await assertWorkspace(390,false);
await click('.workspace-nav-open');await delay(230);
await viewport(1440);
await ef(()=>document.querySelector('.workspace-nav-resize').focus());
await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight'});
await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight'});
await delay(320);
check('keyboard separator increases width',await railWidth()===322);
await click('.v4-module-tabs [data-route=work]');
check('route retains navigation width',await railWidth()===322);

check('登录后自动显示操作指引',await ef(()=>!!document.querySelector('.tutorial-card')));await click('[data-tutorial=hide]');await click('[data-route=users]');check('显示9组与27账号',await ef(()=>document.querySelectorAll('[data-ga-group]').length===10&&document.querySelectorAll('[data-ga-user]').length===28));await click('[data-ga-user=cqe]');check('个人权限继承及来源可见',await ef(()=>document.querySelector('[data-ga-effective="tasks.assign"]').textContent.includes('继承质量部')));await set('[name="override:tasks.assign"]','deny');await ef(()=>document.querySelector('[name="override:tasks.assign"]').dispatchEvent(new Event('change',{bubbles:true})));check('个人禁止预览立即更新',await ef(()=>document.querySelector('[data-ga-effective="tasks.assign"]').textContent.includes('禁止')));await clearForms();await logout();
await login('cqe');check('preferences are isolated by account',await railWidth()===240);await ef(id=>{location.hash='#analysis/'+id},targetId);await wait(()=>!!document.querySelector('#analysisModal'));check('分析内指引从跟进开始',await ef(()=>document.querySelector('.tutorial-card').textContent.includes('先看当前分析进度')));check('guide in modal flow',await ef(()=>document.querySelector('#analysisModal > .modal-head + #testTutorial')?.getBoundingClientRect().bottom<=document.querySelector('#testTutorial').nextElementSibling.getBoundingClientRect().top));const before=JSON.stringify(runtime.store.get('analyses',targetId));await click('[data-tutorial=skip]');check('跳过提示定位D1且不改变业务记录',before===JSON.stringify(runtime.store.get('analyses',targetId))&&await ef(()=>window.QualityLocal.state.stage==='D1'));await click('[data-tutorial=next]');check('下一步定位D2',await ef(()=>window.QualityLocal.state.stage==='D2'));await click('[data-tutorial=hide]');await click('[data-d2-open]');await ef(()=>{const f=document.querySelector('#d2Form');f.elements.owner.value='change';f.elements.due.value='2026-12-31';f.elements.freeze.checked=true;f.elements.due.dispatchEvent(new Event('change',{bubbles:true}));});await click('[data-action=save-form]');await wait(()=>!document.querySelector('#d2Form'));check('质量部能分派但无需代填数量',runtime.store.get('analyses',targetId).freezeAssignment.owner==='change');await click('[data-action=close-analysis-view]');await logout();
await login('change');check('变更管理员属于质量部高权限组',await ef(()=>window.QualityLocal.state.user.groupId==='quality'&&window.QualityLocal.state.user.permissions.includes('tasks.review')));await click('[data-tutorial=hide]');await ef(id=>{location.hash='#analysis/'+id},targetId);await wait(()=>!!document.querySelector('#analysisModal'));await click('[data-stage-nav=D2]');await click('[data-d2-open]');check('变更管理员本人编号数量可编辑',await ef(()=>!document.querySelector('[name=productionQty]').disabled&&!document.querySelector('[name=freezeNumber]').disabled));await set('[name=freezeNumber]','MOCK-43');await set('[name=productionQty]','100');await set('[name=shippedQty]','60');await click('[data-action=save-form]');await wait(()=>!document.querySelector('#d2Form'));check('数量提交成功且保存到共享库',runtime.store.get('analyses',targetId).freezeAssignment.status==='completed');await click('[data-action=close-analysis-view]');await logout();
await login('intelligence_struct');check('执行账号也有测试指引',await ef(()=>!!document.querySelector('.tutorial-card')));await click('[data-tutorial=hide]');await click('[data-route=work]');check('待办含分派的九宫格',await ef(()=>document.querySelectorAll('[data-open-analysis][data-task]').length>0));await click('[data-open-analysis="'+targetId+'"][data-task]');check('本人分析引导显示任务说明',await ef(()=>document.querySelector('.tutorial-card').textContent.includes('打开自己当前的任务')));await click('[data-tutorial=next]');check('执行账号下一步定位自己阶段',await ef(()=>window.QualityLocal.state.stage==='D4'));await click('[data-tutorial=hide]');await click('[data-action=close-analysis-view]');await logout();
await login('sales');check('销售账号有指引及全公司查看',await ef(()=>!!document.querySelector('.tutorial-card')&&window.QualityLocal.state.data.faults.length===144&&!window.QualityLocal.state.user.permissions.includes('analysis.start')));await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await shot('v43-tutorial-mobile');check('手机指引未横向溢出',await ef(()=>document.querySelector('#testTutorial').getBoundingClientRect().right<=innerWidth));check('无浏览器运行错误',errors.length===0);fs.writeFileSync(path.join(out,'browser-groups-v43-results.json'),JSON.stringify({passed:checks.length,checks,errors},null,2));console.log(JSON.stringify({passed:checks.length,checks,errors}));
}catch(e){try{await shot('v43-guide-failed');fs.writeFileSync(path.join(out,'v43-guide-failed.txt'),await ef(()=>document.body.innerText));}catch{}console.error(e.stack);fs.writeFileSync(path.join(out,'browser-groups-v43-results.json'),JSON.stringify({checks,errors,failure:e.message},null,2));process.exitCode=1;}finally{if(socket){try{await send('Browser.close')}catch{}socket.close();}child.kill();await runtime.close();}
