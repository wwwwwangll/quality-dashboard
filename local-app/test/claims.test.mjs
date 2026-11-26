// 阶段B自测：索赔整单办理与我的待办（真实服务端）。
// 覆盖任务单六类：持久化、越权拒绝、转办只读回看、分摊原因与尾差、版本冲突、存量兼容。
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {startServer} from '../server.mjs';
import {allocateCents,normalizeShares,stageOf,createClaimService} from '../lib/claims.mjs';

let runtime,root,admin,qe,qe2,worker,outsider;
function client(){let cookie='',csrf='';return {async request(route,body,method=body?'POST':'GET',headers={}){const response=await fetch(runtime.address+route,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),'x-quality-test':'true',...headers},...(body?{body:JSON.stringify(body)}:{})});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const result=response.headers.get('content-type')?.includes('application/json')?await response.json():await response.text();if(result.csrf)csrf=result.csrf;return {status:response.status,data:result};}}}
const claimById=id=>runtime.store.get('claims',id);

before(async()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'quality-claims-test-'));
  runtime=await startServer({dataDir:root,environment:'test',testMode:true});
  admin=client();await admin.request('/api/setup',{username:'admin',name:'测试管理员',password:'Test-Admin-12345'});
  const make=async(username,name,dept,role)=>{const created=await admin.request('/api/users',{username,name,dept,role,password:'Test-User-123456'});assert.equal(created.status,201,JSON.stringify(created.data));const c=client();assert.equal((await c.request('/api/login',{username,password:'Test-User-123456'})).status,200);return c;};
  qe=await make('qe1','质量甲','质量部','quality-engineer');
  qe2=await make('qe2','质量乙','质量部','quality-engineer');
  worker=await make('worker1','生产甲','生产部','worker');
  outsider=await make('outsider','生产乙','工程部','worker');
});
after(async()=>{await runtime?.close();if(root&&root.startsWith(path.join(os.tmpdir(),'quality-claims-test-')))fs.rmSync(root,{recursive:true,force:true})});

test('分摊算法：整数分、余分归最大占比、同占比按部门固定顺序且与行序无关',async()=>{
  const shares=normalizeShares([{dept:'研发部',ratio:33.33},{dept:'生产部',ratio:33.33},{dept:'质量部',ratio:33.34}]).shares;
  assert.deepEqual(allocateCents(3,shares).rows.map(row=>row.cents),[0,0,3]);
  assert.deepEqual(allocateCents(1234,shares).rows.map(row=>row.cents),[411,411,412]);
  const half=normalizeShares([{dept:'研发部',ratio:50},{dept:'生产部',ratio:50}]).shares;
  // 同占比余分不再随提交行序，按部门名称固定顺序（生产部 < 研发部）。
  assert.deepEqual(allocateCents(1,half).rows.map(row=>row.cents),[0,1]);
  // 0.01 元 50/50 交换行序：每部门所得不变，合计仍为 1 分。
  const byDept=(shareRows,total)=>new Map(allocateCents(total,shareRows).rows.map(row=>[row.dept,row.cents]));
  const forward=byDept(half,1),backward=byDept([...half].reverse(),1);
  assert.deepEqual([...forward.entries()].sort(),[...backward.entries()].sort());
  assert.equal([...forward.values()].reduce((sum,value)=>sum+value,0),1);
  assert.equal(forward.get('生产部'),1);
  assert.equal(forward.get('研发部'),0);
  // 三个同占比部门同样只给固定顺序的第一家，其余为 0。
  const thirds=normalizeShares([{dept:'质量部',ratio:33.33},{dept:'研发部',ratio:33.33},{dept:'生产部',ratio:33.34}]).shares;
  assert.deepEqual(allocateCents(1,thirds).rows.map(row=>row.cents),[0,0,1]);
  assert.deepEqual(allocateCents(10000,half).rows.map(row=>row.cents),[5000,5000]);
  const partial=normalizeShares([{dept:'研发部',ratio:80}]);
  const preview=allocateCents(10000,partial.shares);
  assert.equal(preview.complete,false);
  assert.equal(preview.unallocated,2000);
  assert.deepEqual(preview.rows.map(row=>row.cents),[8000]);
  assert.equal(normalizeShares([{dept:'研发部',ratio:100}]).totalBasis,10000);
  assert.throws(()=>normalizeShares([{dept:'研发部',ratio:33.333}]),/两位小数/);
  assert.throws(()=>normalizeShares([{dept:'研发部',ratio:50},{dept:'研发部',ratio:50}]),/不能重复/);
  assert.throws(()=>normalizeShares([{dept:'研发部',ratio:60},{dept:'生产部',ratio:60}]),/不能超过/);
  assert.throws(()=>normalizeShares([{dept:'研发部',ratio:80}],{requireFull:true}),/必须为 100.00%/);
  assert.equal(stageOf({stage:'待结算'}),'待结算');
  assert.equal(stageOf({status:'已闭环'}),'');
});

test('新增索赔进入指定质量工程师待办，刷新与服务重启后仍在，一单一人',async()=>{
  assert.equal((await worker.request('/api/claims',{id:'CL-W-1',customer:'越权客户',amount:1})).status,403);
  const created=await qe.request('/api/claims',{id:'CL-NEW-1',date:'2026-11-24',customer:'测试客户',issue:'外观划伤',amount:'1234.56',agreed:'1000',actual:'900',ownerId:runtime.store.list('users').find(u=>u.name==='质量甲').id,deadline:'2026-12-01'});
  assert.equal(created.status,201,JSON.stringify(created.data));
  const claim=claimById('CL-NEW-1');
  assert.equal(claim.stage,'待处理');
  assert.equal(claim.amountCents,123456);
  assert.equal(claim.ownerName,'质量甲');
  assert.equal(claim.deadline,'2026-12-01');
  assert.equal(claim.faultIds.length,0);
  assert.equal((await qe.request('/api/claims',{id:'CL-NEW-1',date:'2026-11-24',customer:'重复',amount:1})).status,409);
  const todo=(await qe.request('/api/workbench')).data.todo.filter(row=>row.source==='claim');
  assert.equal(todo.length,1);
  assert.equal(todo[0].claimId,'CL-NEW-1');
  assert.equal((await qe2.request('/api/workbench')).data.todo.filter(row=>row.source==='claim').length,0);
  assert.equal((await qe2.request('/api/claims',{id:'CL-NEW-1',customer:'重复',date:'2026-11-24',amount:1})).status,409);
  const noOwner=await qe.request('/api/claims',{id:'CL-LEGACY-NOOWNER',date:'2026-11-20',customer:'待分配客户',amount:'0.01',ownerId:runtime.store.list('users').find(u=>u.name==='质量甲').id});
  assert.equal(noOwner.status,201);
  await runtime.close();
  runtime=await startServer({dataDir:root,environment:'test',testMode:true});
  qe=client();await qe.request('/api/login',{username:'qe1',password:'Test-User-123456'});
  qe2=client();await qe2.request('/api/login',{username:'qe2',password:'Test-User-123456'});
  worker=client();await worker.request('/api/login',{username:'worker1',password:'Test-User-123456'});
  outsider=client();await outsider.request('/api/login',{username:'outsider',password:'Test-User-123456'});
  const afterRestart=claimById('CL-NEW-1');
  assert.equal(afterRestart.stage,'待处理');
  assert.equal(afterRestart.amountCents,123456);
  assert.equal(afterRestart.ownerName,'质量甲');
  assert.equal((await qe.request('/api/workbench')).data.todo.filter(row=>row.source==='claim').length,2);
});

test('服务端拒绝非经办人、非质量工程师与不可见账号的写入，数据无变化',async()=>{
  const before=claimById('CL-NEW-1');
  const start={action:'start',version:before.version};
  assert.equal((await worker.request('/api/claims/CL-NEW-1/actions',start)).status,404);
  assert.equal((await qe2.request('/api/claims/CL-NEW-1/actions',start)).status,403);
  assert.equal((await outsider.request('/api/claims/CL-NEW-1/actions',start)).status,404);
  assert.equal((await qe2.request('/api/claims/CL-NEW-1/shares',{version:before.version,shares:[{dept:'研发部',ratio:100}],confirm:true},'PUT')).status,403);
  assert.equal((await worker.request('/api/claims/CL-NEW-1/shares',{version:before.version,shares:[{dept:'生产部',ratio:100}],confirm:true},'PUT')).status,404);
  assert.equal((await outsider.request('/api/bootstrap')).status,200);
  const afterAttempts=claimById('CL-NEW-1');
  assert.equal(afterAttempts.version,before.version);
  assert.equal(afterAttempts.stage,'待处理');
  assert.equal(afterAttempts.shares,undefined);
  assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='claim.create' AND json_extract(details,'$.id')='CL-NEW-1'").get().n,1);
  const outsiderClaims=(await outsider.request('/api/bootstrap')).data.claims;
  assert.equal(outsiderClaims.some(row=>row.id==='CL-NEW-1'),false);
});

test('分摊：修改已确认比例必须填原因；首次草稿可确认；空草稿不抹基线；重复确认不重复记账',async()=>{
  let claim=claimById('CL-NEW-1');
  const draft=await qe.request('/api/claims/CL-NEW-1/shares',{version:claim.version,shares:[{dept:'研发部',ratio:80}],confirm:false},'PUT');
  assert.equal(draft.status,200);
  claim=claimById('CL-NEW-1');
  assert.equal(claim.shares[0].ratio,80);
  assert.equal(claim.confirmedShares,undefined);
  const partialConfirm=await qe.request('/api/claims/CL-NEW-1/shares',{version:claim.version,shares:[{dept:'研发部',ratio:80}],confirm:true},'PUT');
  assert.equal(partialConfirm.status,400);
  assert.match(partialConfirm.data.error,/100.00%/);
  const firstConfirm=await qe.request('/api/claims/CL-NEW-1/shares',{version:claim.version,shares:[{dept:'研发部',ratio:60},{dept:'生产部',ratio:40}],confirm:true},'PUT');
  assert.equal(firstConfirm.status,200,JSON.stringify(firstConfirm.data));
  claim=claimById('CL-NEW-1');
  assert.equal(claim.sharesConfirmed,true);
  assert.deepEqual(claim.confirmedShares.map(s=>[s.dept,s.ratio]),[['研发部',60],['生产部',40]]);
  assert.ok(claim.history.some(row=>row.text.includes('首次录入责任分摊')));
  const repeat=await qe.request('/api/claims/CL-NEW-1/shares',{version:claim.version,shares:[{dept:'研发部',ratio:60},{dept:'生产部',ratio:40}],confirm:true},'PUT');
  assert.equal(repeat.status,200);
  assert.equal(repeat.data.unchanged,true);
  assert.equal(claimById('CL-NEW-1').version,claim.version);
  const noReason=await qe.request('/api/claims/CL-NEW-1/shares',{version:claim.version,shares:[{dept:'研发部',ratio:70},{dept:'生产部',ratio:30}],confirm:true},'PUT');
  assert.equal(noReason.status,400);
  assert.match(noReason.data.error,/必须填写修改原因/);
  assert.deepEqual(claimById('CL-NEW-1').confirmedShares.map(s=>[s.dept,s.ratio]),[['研发部',60],['生产部',40]]);
  const withReason=await qe.request('/api/claims/CL-NEW-1/shares',{version:claim.version,shares:[{dept:'研发部',ratio:70},{dept:'生产部',ratio:30}],confirm:true,reason:'复测判定研发部承担主要责任'},'PUT');
  assert.equal(withReason.status,200,JSON.stringify(withReason.data));
  claim=claimById('CL-NEW-1');
  assert.deepEqual(claim.confirmedShares.map(s=>[s.dept,s.ratio]),[['研发部',70],['生产部',30]]);
  const last=claim.history.at(-1).text;
  assert.match(last,/原确认：研发部 60.00% \/ 生产部 40.00%/);
  assert.match(last,/研发部 70.00% \/ 生产部 30.00%/);
  assert.match(last,/复测判定研发部承担主要责任/);
  const emptyDraft=await qe.request('/api/claims/CL-NEW-1/shares',{version:claim.version,shares:[],confirm:false},'PUT');
  assert.equal(emptyDraft.status,200);
  claim=claimById('CL-NEW-1');
  assert.deepEqual(claim.shares,[]);
  assert.deepEqual(claim.confirmedShares.map(s=>[s.dept,s.ratio]),[['研发部',70],['生产部',30]]);
  assert.equal(claim.sharesConfirmed,false);
  const emptyConfirm=await qe.request('/api/claims/CL-NEW-1/shares',{version:claim.version,shares:[],confirm:true},'PUT');
  assert.equal(emptyConfirm.status,400);
  const rerecord=await qe.request('/api/claims/CL-NEW-1/shares',{version:claim.version,shares:[{dept:'研发部',ratio:70},{dept:'生产部',ratio:30}],confirm:true},'PUT');
  assert.equal(rerecord.status,200,JSON.stringify(rerecord.data));
  assert.equal(rerecord.data.unchanged,false);
  const restored=claimById('CL-NEW-1');
  assert.deepEqual(restored.confirmedShares.map(s=>[s.dept,s.ratio]),[['研发部',70],['生产部',30]]);
  assert.equal(restored.sharesConfirmed,true);
  assert.match(restored.history.at(-1).text,/与上次确认一致/);
});

test('0.01元尾差按最大占比落分，未知金额不按0分摊',async()=>{
  const tiny=await qe.request('/api/claims',{id:'CL-TINY',date:'2026-11-24',customer:'尾差客户',amount:'0.01',ownerId:runtime.store.list('users').find(u=>u.name==='质量甲').id});
  assert.equal(tiny.status,201,JSON.stringify(tiny.data));
  const claim=claimById('CL-TINY');
  assert.equal(claim.amountCents,1);
  assert.equal(claim.agreedCents,null);
  const preview=await qe.request('/api/claim-shares/preview',{shares:[{dept:'研发部',ratio:33.33},{dept:'生产部',ratio:33.33},{dept:'质量部',ratio:33.34}],amounts:{amount:0.01,agreed:''}});
  assert.equal(preview.status,200);
  assert.deepEqual(preview.data.amounts.amount.allocation.rows.map(row=>row.cents),[0,0,1]);
  assert.equal(preview.data.amounts.agreed.amountCents,null);
  assert.equal(preview.data.amounts.agreed.allocation,null);
  const confirmed=await qe.request('/api/claims/CL-TINY/shares',{version:claim.version,shares:[{dept:'研发部',ratio:33.33},{dept:'生产部',ratio:33.33},{dept:'质量部',ratio:33.34}],confirm:true},'PUT');
  assert.equal(confirmed.status,200);
  const detail=(await qe.request('/api/bootstrap')).data.claims.find(row=>row.id==='CL-TINY');
  assert.deepEqual(detail.state.allocations.amount.allocation.rows.map(row=>row.cents),[0,0,1]);
  assert.equal(detail.state.allocations.agreed.allocation,null);
  assert.match(detail.state.sharesLabel,/质量部 33\.34%/);
});

test('整单转办：原因必填、保留期限金额比例，转出人失去办理权，接收人办结后仍可只读回看',async()=>{
  let claim=claimById('CL-NEW-1');
  assert.equal((await qe.request('/api/claims/CL-NEW-1/actions',{action:'transfer',to:runtime.store.list('users').find(u=>u.name==='质量乙').id,version:claim.version})).status,400);
  assert.equal((await qe.request('/api/claims/CL-NEW-1/actions',{action:'transfer',to:runtime.store.list('users').find(u=>u.name==='生产甲').id,reason:'交给生产',version:claim.version})).status,400);
  const transferred=await qe.request('/api/claims/CL-NEW-1/actions',{action:'transfer',to:runtime.store.list('users').find(u=>u.name==='质量乙').id,reason:'客户转由乙方跟进',version:claim.version});
  assert.equal(transferred.status,200,JSON.stringify(transferred.data));
  claim=claimById('CL-NEW-1');
  assert.equal(claim.ownerName,'质量乙');
  assert.equal(claim.deadline,'2026-12-01');
  assert.equal(claim.amountCents,123456);
  assert.deepEqual(claim.confirmedShares.map(s=>[s.dept,s.ratio]),[['研发部',70],['生产部',30]]);
  assert.equal(claim.transfers.at(-1).reason,'客户转由乙方跟进');
  assert.equal((await qe.request('/api/claims/CL-NEW-1/actions',{action:'start',version:claim.version})).status,403);
  assert.equal((await qe2.request('/api/claims/CL-NEW-1/actions',{action:'start',version:claim.version})).status,200);
  claim=claimById('CL-NEW-1');
  const started=claim.stage;
  assert.equal(started,'处理中');
  assert.equal((await qe2.request('/api/claims/CL-NEW-1/actions',{action:'processed',note:'已与客户确认复测方案并完成返工',version:claim.version})).status,200);
  claim=claimById('CL-NEW-1');
  assert.equal(claim.stage,'待结算');
  assert.equal((await qe2.request('/api/claims/CL-NEW-1/actions',{action:'complete',version:claim.version,settlement:{mode:'赔付',amount:'900',note:'按协商结果赔付'}})).status,200);
  claim=claimById('CL-NEW-1');
  assert.equal(claim.stage,'已完成');
  assert.equal(claim.settlement.amountCents,90000);
  const originatorDone=(await qe.request('/api/workbench')).data.done.filter(row=>row.source==='claim'&&row.claimId==='CL-NEW-1');
  assert.equal(originatorDone.length,1);
  assert.equal(originatorDone[0].kind,'transferred');
  assert.equal(originatorDone[0].transferTo,'质量乙');
  assert.equal((await qe.request('/api/workbench')).data.todo.some(row=>row.claimId==='CL-NEW-1'),false);
  assert.equal((await qe2.request('/api/workbench')).data.done.some(row=>row.claimId==='CL-NEW-1'&&row.kind==='completed'),true);
  const readOnly=await qe.request('/api/bootstrap');
  assert.equal(readOnly.data.claims.find(row=>row.id==='CL-NEW-1').state.done,true);
  assert.equal((await qe.request('/api/claims/CL-NEW-1/actions',{action:'start',version:claim.version})).status,403);
  assert.equal(runtime.store.list('analyses').length,0);
});

test('阶段校验：处理结果与结算结论不能省略，金额不能单独作为结束依据',async()=>{
  const created=await qe.request('/api/claims',{id:'CL-STAGE',date:'2026-11-24',customer:'阶段客户',amount:'100',actual:'100',ownerId:runtime.store.list('users').find(u=>u.name==='质量甲').id});
  assert.equal(created.status,201);
  let claim=claimById('CL-STAGE');
  assert.equal((await qe.request('/api/claims/CL-STAGE/actions',{action:'processed',note:'跳过开始',version:claim.version})).status,400);
  assert.equal((await qe.request('/api/claims/CL-STAGE/actions',{action:'complete',version:claim.version,settlement:{mode:'赔付',amount:'100',note:'直接结束'}})).status,400);
  assert.equal((await qe.request('/api/claims/CL-STAGE/actions',{action:'start',version:claim.version})).status,200);
  claim=claimById('CL-STAGE');
  const noNote=await qe.request('/api/claims/CL-STAGE/actions',{action:'processed',note:'   ',version:claim.version});
  assert.equal(noNote.status,400);
  assert.match(noNote.data.error,/处理措施与结果/);
  assert.equal((await qe.request('/api/claims/CL-STAGE/actions',{action:'processed',note:'更换供应商来料并完成复检',version:claim.version})).status,200);
  claim=claimById('CL-STAGE');
  assert.equal((await qe.request('/api/claims/CL-STAGE/actions',{action:'complete',version:claim.version,settlement:{mode:'赔付',note:''}})).status,400);
  const noBasis=await qe.request('/api/claims/CL-STAGE/actions',{action:'complete',version:claim.version,settlement:{mode:'无需赔付',note:'客户'}});
  assert.equal(noBasis.status,400);
  const noPay=await qe.request('/api/claims/CL-STAGE/actions',{action:'complete',version:claim.version,settlement:{mode:'无需赔付',note:'客户自行处理，不涉及赔付'}});
  assert.equal(noPay.status,200,JSON.stringify(noPay.data));
  claim=claimById('CL-STAGE');
  assert.equal(claim.stage,'已完成');
  assert.equal(claim.settlement.mode,'无需赔付');
  assert.equal(claim.settlement.amountCents,null);
});

test('并发同版本只写入一次，冲突返回409且不部分写入',async()=>{
  const created=await qe.request('/api/claims',{id:'CL-RACE',date:'2026-11-24',customer:'并发客户',amount:'500',ownerId:runtime.store.list('users').find(u=>u.name==='质量甲').id});
  assert.equal(created.status,201);
  const claim=claimById('CL-RACE');
  const payload={action:'start',version:claim.version};
  const [first,second]=await Promise.all([qe.request('/api/claims/CL-RACE/actions',payload),qe.request('/api/claims/CL-RACE/actions',payload)]);
  const statuses=[first.status,second.status].sort();
  assert.deepEqual(statuses,[200,409]);
  const after=claimById('CL-RACE');
  assert.equal(after.version,claim.version+1);
  assert.equal(after.stage,'处理中');
  assert.equal(after.history.filter(row=>row.text.startsWith('开始办理')).length,1);
  const sharesPayload={version:after.version,shares:[{dept:'研发部',ratio:50},{dept:'生产部',ratio:50}],confirm:true};
  const [a,b]=await Promise.all([qe.request('/api/claims/CL-RACE/shares',sharesPayload,'PUT'),qe.request('/api/claims/CL-RACE/shares',sharesPayload,'PUT')]);
  assert.deepEqual([a.status,b.status].sort(),[200,409]);
  const settled=claimById('CL-RACE');
  assert.equal(settled.confirmedShares.length,2);
  assert.equal(settled.history.filter(row=>row.text.includes('首次录入责任分摊')).length,1);
  assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='claim.shares.confirm' AND json_extract(details,'$.id')='CL-RACE'").get().n,1);
});

test('存量兼容：旧记录显示待分配/未确认，旧状态路径与导入不受影响',async()=>{
  const legacy={id:'CL-OLD-1',date:'2026-10-01',customer:'旧客户',amount:500,amountCents:50000,waiverCents:null,actualCents:null,status:'待验证',dept:'生产部',deadline:'2026-10-10',history:[],faultIds:[]};
  runtime.store.put('claims','CL-OLD-1',legacy,{event:'fixture'});
  const data=(await qe.request('/api/bootstrap')).data.claims.find(row=>row.id==='CL-OLD-1');
  assert.equal(data.state.ownerName,'');
  assert.equal(data.state.stage,'');
  assert.equal(data.state.stageLabel,'旧状态：待验证');
  assert.equal(data.state.legacy,true);
  assert.equal(data.state.sharesConfirmed,false);
  assert.match(data.state.sharesLabel,/未确认/);
  assert.equal(data.state.overdue,true);
  const detail=(await qe.request('/api/bootstrap')).data.claims.find(row=>row.id==='CL-OLD-1');
  assert.equal(detail.state.allocations.amount.allocation,null);
  const unassigned=await qe.request('/api/claims/CL-OLD-1/actions',{action:'start',version:data.version});
  assert.equal(unassigned.status,409);
  assert.match(unassigned.data.error,/尚未分配经办人/);
  const oldPath=await qe.request('/api/claims/CL-OLD-1',{version:data.version,status:'已闭环',note:'旧路径继续推进'},'PATCH');
  assert.equal(oldPath.status,200,JSON.stringify(oldPath.data));
  assert.equal(claimById('CL-OLD-1').status,'已闭环');
  assert.equal(claimById('CL-OLD-1').stage,undefined);
  const csv='索赔编号,索赔日期,客户名称,索赔金额\r\nCL-IMP-1,2026-11-24,导入客户,88.88\r\n';
  const preview=await qe.request('/api/imports/preview',{kind:'claim',name:'claim.csv',base64:Buffer.from(csv).toString('base64')});
  assert.equal(preview.status,200);
  assert.equal((await qe.request('/api/imports/'+preview.data.batchId+'/commit',{})).data.inserted,1);
  const imported=claimById('CL-IMP-1');
  assert.equal(imported.amountCents,8888);
  assert.equal(imported.stage,undefined);
  assert.equal((await qe.request('/api/bootstrap')).data.claims.find(row=>row.id==='CL-IMP-1').state.unassigned,true);
  assert.equal((await admin.request('/api/claims/CL-IMP-1/actions',{action:'transfer',to:runtime.store.list('users').find(u=>u.name==='质量甲').id,reason:'管理员指定经办人',version:imported.version})).status,200);
  assert.equal(claimById('CL-IMP-1').ownerName,'质量甲');
});

test('新增可带分摊草稿；往返转办只保留一条当前待办，完成后只计一次',async()=>{
  const me=runtime.store.list('users').find(u=>u.name==='质量甲'),peer=runtime.store.list('users').find(u=>u.name==='质量乙');
  const over=await qe.request('/api/claims',{id:'CL-OVER',date:'2026-11-24',customer:'超比例客户',amount:'10',shares:[{dept:'质量部',ratio:60},{dept:'生产部',ratio:60}],ownerId:me.id});
  assert.equal(over.status,400);
  const created=await qe.request('/api/claims',{id:'CL-ROUND',date:'2026-11-24',customer:'往返客户',amount:'10',shares:[{dept:'质量部',ratio:100}],ownerId:me.id});
  assert.equal(created.status,201,JSON.stringify(created.data));
  let claim=claimById('CL-ROUND');
  assert.deepEqual(claim.shares.map(s=>[s.dept,s.ratio]),[['质量部',100]]);
  assert.equal(claim.confirmedShares,undefined);
  assert.equal(claim.sharesConfirmed,false);
  assert.equal((await qe.request('/api/claims/CL-ROUND/actions',{action:'transfer',to:peer.id,reason:'临时转出',version:claim.version})).status,200);
  claim=claimById('CL-ROUND');
  assert.equal((await qe2.request('/api/claims/CL-ROUND/actions',{action:'transfer',to:me.id,reason:'转回原经办人',version:claim.version})).status,200);
  claim=claimById('CL-ROUND');
  assert.equal(claim.transfers.length,2);
  const todo=(await qe.request('/api/workbench')).data;
  assert.equal(todo.todo.filter(row=>row.claimId==='CL-ROUND').length,1);
  assert.equal(todo.done.filter(row=>row.claimId==='CL-ROUND').length,0);
  assert.equal((await qe.request('/api/claims/CL-ROUND/actions',{action:'start',version:claim.version})).status,200);
  claim=claimById('CL-ROUND');
  assert.equal((await qe.request('/api/claims/CL-ROUND/actions',{action:'processed',note:'往返转办后继续办理并完成复检',version:claim.version})).status,200);
  claim=claimById('CL-ROUND');
  assert.equal((await qe.request('/api/claims/CL-ROUND/actions',{action:'complete',version:claim.version,settlement:{mode:'赔付',amount:'10',note:'按整单金额结清'}})).status,200);
  const done=(await qe.request('/api/workbench')).data.done.filter(row=>row.claimId==='CL-ROUND');
  assert.equal(done.length,1);
  assert.equal(done[0].kind,'completed');
});

test('R1-1 结算金额即有效实际赔付，赔付与无需赔付同口径',async()=>{
  const trigger=async(id,extra)=>{
    assert.equal((await qe.request('/api/claims',{id,date:'2026-11-24',customer:'结算口径客户',amount:'1000',deadline:'2026-12-05'})).status,201);
    let claim=claimById(id);
    assert.equal((await qe.request('/api/claims/'+id+'/shares',{version:claim.version,shares:[{dept:'研发部',ratio:100}],confirm:true},'PUT')).status,200);
    for(const [action,body] of [['start',{}],['processed',{note:'已更换供应商并完成复检'}],['complete',extra]]){
      claim=claimById(id);
      assert.equal((await qe.request('/api/claims/'+id+'/actions',{version:claim.version,action,...body})).status,200,action);
    }
  };
  await trigger('CL-R1-MONEY',{settlement:{mode:'赔付',amount:'500',note:'与客户确认赔付五百元'}});
  let boot=(await qe.request('/api/bootstrap')).data,row=boot.claims.find(x=>x.id==='CL-R1-MONEY');
  assert.equal(row.actualCents,50000);
  assert.equal(row.actual,500);
  assert.equal(row.state.effectiveActualCents,50000);
  assert.equal(row.state.allocations.actual.amountCents,50000);
  assert.equal(row.state.allocations.actual.allocation.rows[0].cents,50000);
  assert.equal(row.settlement.amountCents,50000);
  assert.equal(row.state.settlement.amount,500);
  // 原始值若与结算不同需单独保留，不能顶替有效结算值
  assert.equal(claimById('CL-R1-MONEY').actualCents,50000);
  await trigger('CL-R1-NOPAY',{settlement:{mode:'无需赔付',note:'客户自行返修，公司不承担赔付'}});
  boot=(await qe.request('/api/bootstrap')).data;
  row=boot.claims.find(x=>x.id==='CL-R1-NOPAY');
  assert.equal(row.actualCents,0);
  assert.equal(row.state.allocations.actual.amountCents,0);
  assert.equal(row.state.allocations.actual.amount,0);
  assert.equal(row.settlement.mode,'无需赔付');
  assert.equal(row.state.done,true);
});

test('R1-2 旧PATCH不能绕过新模型的经办人与状态规则，历史单路径保留',async()=>{
  assert.equal((await qe.request('/api/claims',{id:'CL-R1-PATCH',date:'2026-11-24',customer:'旧接口客户',amount:'100',deadline:'2026-12-01'})).status,201);
  let claim=claimById('CL-R1-PATCH'),version=claim.version;
  const other=await qe2.request('/api/claims/CL-R1-PATCH',{version,status:'处理中',note:'其他QE通过旧接口修改'},'PATCH');
  assert.equal(other.status,409,JSON.stringify(other.data));
  assert.equal(claimById('CL-R1-PATCH').version,version);
  assert.equal(claimById('CL-R1-PATCH').stage,'待处理');
  const otherDeadline=await qe2.request('/api/claims/CL-R1-PATCH',{version,deadline:'2026-12-09'},'PATCH');
  assert.equal(otherDeadline.status,403);
  assert.equal(claimById('CL-R1-PATCH').version,version);
  // 经办人本人经旧接口只能改期限，状态仍须走办理动作
  const ownDeadline=await qe.request('/api/claims/CL-R1-PATCH',{version,deadline:'2026-12-09'},'PATCH');
  assert.equal(ownDeadline.status,200,JSON.stringify(ownDeadline.data));
  claim=claimById('CL-R1-PATCH');
  assert.equal(claim.deadline,'2026-12-09');
  assert.equal(claim.stage,'待处理');
  // 历史单（无 stage）仍可用旧路径推进
  runtime.store.put('claims','CL-R1-LEGACY',{id:'CL-R1-LEGACY',date:'2026-10-01',customer:'历史客户',amount:100,amountCents:10000,status:'待验证',dept:'生产部',deadline:'2026-10-10',history:[],faultIds:[]},{event:'fixture'});
  const legacy=claimById('CL-R1-LEGACY');
  const closed=await qe2.request('/api/claims/CL-R1-LEGACY',{version:legacy.version,status:'已闭环',note:'历史路径继续推进'},'PATCH');
  assert.equal(closed.status,200,JSON.stringify(closed.data));
  assert.equal(claimById('CL-R1-LEGACY').status,'已闭环');
});

test('R1-3 审计写失败时业务记录与确认状态整体回滚',async()=>{
  assert.equal((await qe.request('/api/claims',{id:'CL-R1-ATOMIC',date:'2026-11-24',customer:'事务客户',amount:'100',deadline:'2026-12-01'})).status,201);
  const before=claimById('CL-R1-ATOMIC');
  runtime.store.db.exec("CREATE TEMP TRIGGER r1_claim_audit_fail BEFORE INSERT ON audit WHEN NEW.event='claim.shares.confirm' BEGIN SELECT RAISE(ABORT,'r1-injected-audit-failure'); END");
  let failed;
  try{
    failed=await qe.request('/api/claims/CL-R1-ATOMIC/shares',{version:before.version,shares:[{dept:'研发部',ratio:100}],confirm:true},'PUT');
  }finally{
    runtime.store.db.exec('DROP TRIGGER r1_claim_audit_fail');
  }
  assert.ok(failed.status>=500,'审计失败应返回错误状态');
  const after=claimById('CL-R1-ATOMIC');
  assert.equal(after.version,before.version);
  assert.equal(after.sharesConfirmed,undefined);
  assert.equal(after.confirmedShares,undefined);
  assert.equal((after.history||[]).length,(before.history||[]).length);
  // 故障解除后同一版本仍可正常确认，说明前次失败没有留下半成品
  const retry=await qe.request('/api/claims/CL-R1-ATOMIC/shares',{version:before.version,shares:[{dept:'研发部',ratio:100}],confirm:true},'PUT');
  assert.equal(retry.status,200,JSON.stringify(retry.data));
  assert.equal(claimById('CL-R1-ATOMIC').sharesConfirmed,true);
});

test('R1-4 已完成索赔的服务端只读：分摊、版本与历史不变',async()=>{
  const before=claimById('CL-R1-MONEY');
  const historyLength=(before.history||[]).length;
  const changed=await qe.request('/api/claims/CL-R1-MONEY/shares',{version:before.version,shares:[{dept:'生产部',ratio:100}],reason:'已结案后改写分摊',confirm:true},'PUT');
  assert.equal(changed.status,409,JSON.stringify(changed.data));
  const after=claimById('CL-R1-MONEY');
  assert.equal(after.version,before.version);
  assert.deepEqual(after.confirmedShares,[{dept:'研发部',ratio:100}]);
  assert.equal((after.history||[]).length,historyLength);
  // 草稿同样被拒绝，避免以草稿改口径
  const draft=await qe.request('/api/claims/CL-R1-MONEY/shares',{version:before.version,shares:[{dept:'生产部',ratio:100}],confirm:false},'PUT');
  assert.equal(draft.status,409);
  assert.equal(claimById('CL-R1-MONEY').version,before.version);
  // 管理员也不能从普通入口改写
  const adminTry=await admin.request('/api/claims/CL-R1-MONEY/shares',{version:before.version,shares:[{dept:'生产部',ratio:100}],confirm:true},'PUT');
  assert.equal(adminTry.status,409);
});

test('R1-5 受限账号跨部门转出后保留只读回看，不能再写',async()=>{
  const created=await admin.request('/api/users',{username:'r1limited',name:'非全览QE',dept:'研发部',role:'quality-engineer',permissions:[],password:'Test-User-123456'});
  assert.equal(created.status,201,JSON.stringify(created.data));
  const limited=client();assert.equal((await limited.request('/api/login',{username:'r1limited',password:'Test-User-123456'})).status,200);
  assert.equal((await limited.request('/api/claims',{id:'CL-R1-SCOPE',date:'2026-11-24',customer:'范围客户',amount:'10',deadline:'2026-12-01'})).status,201);
  const target=runtime.store.list('users').find(user=>user.name==='质量乙');
  let claim=claimById('CL-R1-SCOPE');
  assert.equal((await limited.request('/api/claims/CL-R1-SCOPE/actions',{version:claim.version,action:'transfer',to:target.id,reason:'跨部门转给质量部'})).status,200);
  // 转出后：工作台保留只读历史，详情与分摊仍可见，但不能继续写
  const wb=(await limited.request('/api/workbench')).data;
  assert.equal(wb.todo.filter(row=>row.claimId==='CL-R1-SCOPE').length,0);
  assert.equal(wb.done.filter(row=>row.claimId==='CL-R1-SCOPE'&&row.kind==='transferred').length,1);
  const boot=(await limited.request('/api/bootstrap')).data;
  const visible=boot.claims.find(x=>x.id==='CL-R1-SCOPE');
  assert.ok(visible,'转出人应能只读回看自己转出的单据');
  assert.equal(visible.state.ownerName,'质量乙');
  claim=claimById('CL-R1-SCOPE');
  assert.equal((await limited.request('/api/claims/CL-R1-SCOPE/actions',{version:claim.version,action:'start'})).status,403);
  assert.equal((await limited.request('/api/claims/CL-R1-SCOPE/shares',{version:claim.version,shares:[{dept:'研发部',ratio:100}],confirm:true},'PUT')).status,403);
  // 接收人办结后转出人仍可回看
  claim=claimById('CL-R1-SCOPE');
  assert.equal((await qe2.request('/api/claims/CL-R1-SCOPE/actions',{version:claim.version,action:'start'})).status,200);
  claim=claimById('CL-R1-SCOPE');
  assert.equal((await qe2.request('/api/claims/CL-R1-SCOPE/actions',{version:claim.version,action:'processed',note:'接收人完成处理并复检'})).status,200);
  claim=claimById('CL-R1-SCOPE');
  assert.equal((await qe2.request('/api/claims/CL-R1-SCOPE/actions',{version:claim.version,action:'complete',settlement:{mode:'无需赔付',note:'金额极小，客户放弃赔付'}})).status,200);
  const boot2=(await limited.request('/api/bootstrap')).data;
  assert.ok(boot2.claims.find(x=>x.id==='CL-R1-SCOPE'),'接收人办结后转出人仍应只读可见');
  const wb2=(await limited.request('/api/workbench')).data;
  assert.equal(wb2.done.filter(row=>row.claimId==='CL-R1-SCOPE').length,1);
});

test('R2-1 期限修改纳入统一写权限、终态与事务',async()=>{
  const created=await admin.request('/api/users',{username:'r2down',name:'降权甲',dept:'质量部',role:'quality-engineer',password:'Test-User-123456'});
  assert.equal(created.status,201,JSON.stringify(created.data));
  const down=client();assert.equal((await down.request('/api/login',{username:'r2down',password:'Test-User-123456'})).status,200);
  assert.equal((await down.request('/api/claims',{id:'CL-R2-DOWN',date:'2026-11-24',customer:'降权客户',amount:'10',deadline:'2026-12-01'})).status,201);

  assert.equal((await qe.request('/api/claims',{id:'CL-R2-DEADLINE',date:'2026-11-24',customer:'期限客户',amount:'100',deadline:'2026-12-01'})).status,201);
  let claim=claimById('CL-R2-DEADLINE'),version=claim.version;
  // 在办本人可以改期限，且只改期限、不推进阶段
  const own=await qe.request('/api/claims/CL-R2-DEADLINE',{version,deadline:'2026-12-09'},'PATCH');
  assert.equal(own.status,200,JSON.stringify(own.data));
  claim=claimById('CL-R2-DEADLINE');
  assert.equal(claim.deadline,'2026-12-09');
  assert.equal(claim.stage,'待处理');
  assert.ok((claim.history||[]).some(item=>String(item.text).includes('更新办理期限')));
  // 其他QE与过期版本都拒绝，记录不变
  assert.equal((await qe2.request('/api/claims/CL-R2-DEADLINE',{version:claim.version,deadline:'2026-12-15'},'PATCH')).status,403);
  assert.equal((await qe.request('/api/claims/CL-R2-DEADLINE',{version,deadline:'2026-12-15'},'PATCH')).status,409);
  assert.equal(claimById('CL-R2-DEADLINE').version,claim.version);
  assert.equal(claimById('CL-R2-DEADLINE').deadline,'2026-12-09');
  // 已完成：本人与管理员都不能从普通期限入口改写
  const done=claimById('CL-R1-MONEY');
  assert.equal((await qe.request('/api/claims/CL-R1-MONEY',{version:done.version,deadline:'2027-01-01'},'PATCH')).status,409);
  assert.equal((await admin.request('/api/claims/CL-R1-MONEY',{version:done.version,deadline:'2027-01-01'},'PATCH')).status,409);
  assert.equal(claimById('CL-R1-MONEY').version,done.version);
  assert.equal(claimById('CL-R1-MONEY').deadline,done.deadline);
  // 降权为普通员工后（重新登录）不能改自己原单期限
  const target=runtime.store.list('users').find(u=>u.username==='r2down');
  const downgraded=await admin.request('/api/users/'+target.id,{version:target.version,role:'worker',permissions:[]},'PATCH');
  assert.equal(downgraded.status,200,JSON.stringify(downgraded.data));
  const again=client();assert.equal((await again.request('/api/login',{username:'r2down',password:'Test-User-123456'})).status,200);
  const beforeDown=claimById('CL-R2-DOWN');
  const blocked=await again.request('/api/claims/CL-R2-DOWN',{version:beforeDown.version,deadline:'2026-12-20'},'PATCH');
  assert.equal(blocked.status,403,JSON.stringify(blocked.data));
  assert.equal(claimById('CL-R2-DOWN').deadline,'2026-12-01');
  assert.equal(claimById('CL-R2-DOWN').version,beforeDown.version);
  // 审计失败整体回滚，同版本可重试
  const before=claimById('CL-R2-DEADLINE');
  runtime.store.db.exec("CREATE TEMP TRIGGER r2_claim_deadline_fail BEFORE INSERT ON audit WHEN NEW.event='claim.deadline' BEGIN SELECT RAISE(ABORT,'r2-injected-audit-failure'); END");
  let failed;
  try{failed=await qe.request('/api/claims/CL-R2-DEADLINE',{version:before.version,deadline:'2026-12-31'},'PATCH');}
  finally{runtime.store.db.exec('DROP TRIGGER r2_claim_deadline_fail');}
  assert.ok(failed.status>=500,'审计失败应返回错误状态');
  const after=claimById('CL-R2-DEADLINE');
  assert.equal(after.version,before.version);
  assert.equal(after.deadline,before.deadline);
  assert.equal((after.history||[]).length,(before.history||[]).length);
  assert.equal((await qe.request('/api/claims/CL-R2-DEADLINE',{version:before.version,deadline:'2026-12-31'},'PATCH')).status,200);
  // legacy 进度与报故关联两条独立路径保持
  runtime.store.put('claims','CL-R2-LEGACY',{id:'CL-R2-LEGACY',date:'2026-10-01',customer:'历史客户',amount:100,amountCents:10000,status:'待处理',dept:'生产部',deadline:'2026-10-10',history:[],faultIds:[]},{event:'fixture'});
  const legacy=claimById('CL-R2-LEGACY');
  assert.equal((await qe.request('/api/claims/CL-R2-LEGACY',{version:legacy.version,status:'处理中',note:'历史单继续推进'},'PATCH')).status,200);
  assert.equal(claimById('CL-R2-LEGACY').status,'处理中');
  const linkClaim=claimById('CL-R2-DEADLINE');
  assert.equal((await qe.request('/api/claims/CL-R2-DEADLINE',{version:linkClaim.version,faultId:''},'PATCH')).status,200);
});

test('待办条目不外露队列类型码，且多条初步分析不被合并',async()=>{
  // 8D队列返回的是类型码（unassigned/review/missing），界面必须显示中文；
  // 初步分析没有 analysisId，若用 analysisId 做去重键会把多条初步任务并成一条。
  const people=[{id:'u-wb',username:'qe-wb',name:'质量甲',dept:'质量部',role:'quality-engineer',enabled:true,permissions:['analysis.view','claims.view']}];
  const store={list:kind=>kind==='users'?people:[],get:()=>null,put:()=>{throw Error('待办只读，不应写入')}};
  const service=createClaimService({store});
  const queueRows=[
    {type:'unassigned',analysisId:'',taskId:'',faultId:'F-WB-1',label:'待分配任务一',due:'2026-12-01'},
    {type:'unassigned',analysisId:'',taskId:'',faultId:'F-WB-2',label:'待分配任务二',due:'2026-12-02'},
    {type:'missing',analysisId:'A-WB-1',taskId:'T-WB-1',faultId:'F-WB-3',label:'半成品数量确认',stage:'D3',due:'2026-12-03'}
  ];
  const wb=service.api('workbench',{user:people[0],queueRows});
  assert.equal(wb.todo.length,3);
  assert.equal(wb.todo.filter(row=>row.source==='preliminary').length,2);
  assert.equal(wb.todo.filter(row=>row.source==='analysis').length,1);
  assert.deepEqual([...new Set(wb.todo.map(row=>row.kindLabel))].sort(),['待分配','待补充']);
  assert.equal(wb.todo.some(row=>['unassigned','review','missing','stage-confirm'].includes(row.kindLabel)),false);
  assert.deepEqual(wb.todo.map(row=>row.kind).sort(),['missing','unassigned','unassigned']);
});

test('待办透传审核节点集合与动作文案，未知类型只允许查看',async()=>{
  const people=[{id:'u-wb2',username:'qe-wb2',name:'质量乙',dept:'质量部',role:'quality-engineer',enabled:true,permissions:['analysis.view','claims.view']}];
  const store={list:kind=>kind==='users'?people:[],get:()=>null,put:()=>{throw Error('待办只读，不应写入')}};
  const service=createClaimService({store});
  const wb=service.api('workbench',{user:people[0],queueRows:[
    {type:'review',analysisId:'A-1',taskId:'T-1',faultId:'F-1',label:'九宫格结论待审核：设计质量',stage:'D4',reviewNodeIds:['NODE-1','NODE-2']},
    {type:'unassigned',analysisId:'A-1',taskId:'T-2',faultId:'F-1',label:'半成品数量确认',stage:'D3'},
    {type:'brand-new-type',analysisId:'A-1',taskId:'T-3',faultId:'F-1',label:'未知类型事项',stage:'D5'}
  ]});
  const review=wb.todo.find(row=>row.kind==='review');
  assert.deepEqual(review.reviewNodeIds,['NODE-1','NODE-2']);
  assert.equal(review.action,'审核');
  assert.equal(review.kindLabel,'待验收');
  assert.equal(wb.todo.find(row=>row.kind==='unassigned').action,'分配');
  const unknown=wb.todo.find(row=>row.kind==='brand-new-type');
  assert.equal(unknown.action,'查看事项','未知类型不能伪装成可办理');
  assert.equal(wb.todo.some(row=>row.action==='brand-new-type'||row.action==='undefined'),false);
  assert.equal(wb.todo.filter(row=>row.reviewNodeIds).length,1,'只有审核行携带节点集合');
});
