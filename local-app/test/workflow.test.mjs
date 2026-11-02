import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createStore } from '../lib/store.mjs';
import { createWorkflowService } from '../lib/workflow.mjs';

function fixture(){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'quality-workflow-test-'));
  const store=createStore({dataDir,environment:'test',testMode:true});
  const users=[
    {id:'admin',name:'管理员',dept:'质量部',role:'admin',enabled:true},
    {id:'qe',name:'质量工程师甲',dept:'质量部',role:'quality-engineer',enabled:true},
    {id:'qe2',name:'质量工程师乙',dept:'质量部',role:'quality-engineer',enabled:true},
    {id:'fa',name:'失效分析甲',dept:'失效分析部',role:'failure-analyst',enabled:true},
    {id:'fa2',name:'失效分析乙',dept:'失效分析部',role:'failure-analyst',enabled:true},
    {id:'worker',name:'设计工程师',dept:'智能化研究院',role:'worker',enabled:true},
    {id:'worker2',name:'工艺工程师',dept:'工艺部',role:'worker',enabled:true}
  ];for(const u of users)store.put('users',u.id,u);
  const fault=store.put('faults','BG-SYNTHETIC-001',{date:'2026-10-26',product:'显示屏',model:'A01',partNo:'PN-BLACK-001',customer:'测试客户',project:'测试项目',description:'屏幕低温启动偶发黑屏，重新上电恢复',condition:'低温首次上电',quantity:1,reporter:'测试报故人',version:1});
  let time=new Date('2026-10-29T04:00:00.000Z');const closed=[];
  const wf=createWorkflowService({store,fileRoot:store.fileRoot,clock:()=>time,onClosed:async item=>closed.push(item)});
  const user=id=>store.get('users',id);
  const api=(action,body={},id,who='qe')=>wf.api(action,{user:user(who),body,id});
  const create=()=>api('create',{faultId:fault.id});
  const command=(item,action,body={},who='qe')=>api('command',{action,version:store.get('analyses',item.id).version,...body},item.id,who);
  return {store,wf,users,fault,user,api,create,command,closed,setTime:v=>{time=new Date(v)},cleanup(){store.close();fs.rmSync(dataDir,{recursive:true,force:true});}};
}
async function withFixture(fn){const f=fixture();try{await fn(f)}finally{f.cleanup()}}
const expectError=async(promise,pattern,status)=>{await assert.rejects(promise,e=>(!status||e.status===status)&&pattern.test(e.message));};
test('独立分派权限能调整既有任务人员期限，但不能填写他人成果或修改阶段',()=>withFixture(async f=>{const {item,id}=await assignedGeneral(f);const p=f.user('worker2');f.store.put('users',p.id,{...p,permissions:['tasks.assign']});f.store.put('faults',f.fault.id,{...f.fault,dept:'工艺部'});await f.command(item,'save-task',{taskId:id,patch:{due:'2026-11-02'}},'worker2');assert.equal(f.store.get('analyses',item.id).workflow.tasks.find(t=>t.id===id).due,'2026-11-02');await expectError(f.command(item,'save-task',{taskId:id,patch:{result:'冒充他人完成'}},'worker2'),/自己的|责任人/,403);await expectError(f.command(item,'patch-stage',{stage:'D1',fields:{goal:'无权修改'}} ,'worker2'),/权限/,403);}));
test('取消分派权限后不能改负责人，但可保存允许的成果；管理改派保留原人贡献评定',()=>withFixture(async f=>{const {item,id}=await assignedGeneral(f);const old=f.user('qe2');f.store.put('users',old.id,{...old,permissions:['analysis.manage','tasks.review']});await expectError(f.command(item,'save-task',{taskId:id,patch:{owner:'worker2'}},'qe2'),/权限/,403);await f.command(item,'save-task',{taskId:id,patch:{result:'核对已完成检查记录'}},'worker');const moved=await f.command(item,'save-task',{taskId:id,patch:{owner:'worker2'}});assert.equal(moved.workflow.tasks.find(t=>t.id===id).transfers[0].from,'worker');assert.equal(moved.workflow.tasks.find(t=>t.id===id).transferEvaluation,null);}));
async function assignedGeneral(f,{stage='D1',who='worker',due='2026-10-30',base=2,evidence=false}={}){
  let item=f.store.list('analyses')[0]||await f.create();
  item=await f.command(item,'patch-stage',{stage:'D1',team:[{personId:'qe',role:'组织与验收'},{personId:'qe2',role:'共享验收'},{personId:'worker',role:'产生原因分析'},{personId:'worker2',role:'工艺措施'}]});
  item=await f.command(item,'add-task',{stage,kind:'general',title:'模拟协作任务'});const id=item.newTaskId;
  item=await f.command(item,'save-task',{taskId:id,patch:{owner:who,due,base,evidenceRequired:evidence,scope:'提交可复核分析记录'}});
  return {item,id};
}

test('真实人员替代演示me；重复开启同一报故被拒绝',()=>withFixture(async f=>{
  const item=await f.create();assert.equal(item.owner,'qe');assert.equal(item.team[0].personId,'qe');assert.equal(item.revised.partNo,'PN-BLACK-001');assert.equal(item.approval.required,false);assert.ok(item.version);
  await expectError(f.create(),/已纳入/,409);
  await expectError(f.api('create',{faultId:f.fault.id},undefined,'worker'),/权限/,403);
}));

test('失效分析可主动填写、本人改版；8D保留发布快照',()=>withFixture(async f=>{
  const p=await f.api('preliminary',{phenomenon:'黑屏',process:'低温复测',conclusion:'疑似上电时序',status:'submitted'},f.fault.id,'fa');
  let item=await f.create();assert.equal(item.preliminarySnapshot[0].conclusion,'疑似上电时序');
  await expectError(f.api('preliminary',{id:p.id,version:p.version,conclusion:'修改他人成果'},f.fault.id,'fa2'),/自己的|责任人/,403);
  const next=await f.api('preliminary',{id:p.id,version:p.version,conclusion:'疑似复位释放提前',status:'submitted'},f.fault.id,'fa');
  assert.equal(next.history.length,1);assert.equal(next.history[0].conclusion,'疑似上电时序');assert.equal(f.store.get('analyses',item.id).preliminarySnapshot[0].conclusion,'疑似上电时序');
  await expectError(f.api('preliminary',{id:p.id,version:p.version,conclusion:'旧版本覆盖'},f.fault.id,'fa'),/刷新/,409);
}));

test('质量工程师分派初步分析且发布后自动完成；其他FA仍可补充',()=>withFixture(async f=>{
  await expectError(f.api('assign',{userId:'fa',due:'2026-10-30'},f.fault.id,'worker'),/权限/,403);
  const a=await f.api('assign',{userId:'fa',due:'2026-10-30'},f.fault.id);assert.equal(a.status,'assigned');
  assert.ok((await f.api('queues',{},undefined,'fa')).rows.some(r=>r.faultId===f.fault.id));
  await f.api('preliminary',{phenomenon:'黑屏',process:'示波器采样',conclusion:'复位异常',status:'submitted'},f.fault.id,'fa2');assert.equal(f.store.get('preliminaryAssignments',f.fault.id).status,'assigned');
  await f.api('preliminary',{phenomenon:'黑屏',process:'复测',conclusion:'复位时序待验证',status:'submitted'},f.fault.id,'fa');assert.equal(f.store.get('preliminaryAssignments',f.fault.id).status,'completed');
}));

test('执行人员不能配置阶段、改责任人、篡改状态或写他人任务',()=>withFixture(async f=>{
  const {item,id}=await assignedGeneral(f);
  for(const patch of [{owner:'worker2'},{status:'accepted'},{initiative:100},{due:'2026-11-30'}])await expectError(f.command(item,'save-task',{taskId:id,patch},'worker'),/不允许/,403);
  await expectError(f.command(item,'patch-stage',{stage:'D1',fields:{goal:'越权'}},'worker'),/权限/,403);
  await expectError(f.command(item,'save-task',{taskId:id,patch:{result:'越权'}},'worker2'),/分派/,403);
  await expectError(f.command(item,'accept-task',{taskId:id},'worker'),/权限/,403);
}));

test('服务器校验版本，旧标签页无法覆盖更新',()=>withFixture(async f=>{
  const {item,id}=await assignedGeneral(f);const version=item.version;
  const next=await f.command(item,'save-task',{taskId:id,patch:{result:'第一份结果'}},'worker');assert.equal(next.version,version+1);
  await expectError(f.api('command',{action:'save-task',version,taskId:id,patch:{result:'旧结果'}},item.id,'worker'),/刷新/,409);
  assert.equal(f.store.get('analyses',item.id).workflow.tasks.find(t=>t.id===id).result,'第一份结果');
}));

test('拒绝原型字段、伪造附件和危险证据链接，失败不写入',()=>withFixture(async f=>{
  const {item,id}=await assignedGeneral(f),version=f.store.get('analyses',item.id).version;
  await expectError(f.command(item,'save-task',{taskId:id,patch:JSON.parse('{"__proto__":{"polluted":true}}')},'worker'),/字段无效/);
  await expectError(f.command(item,'save-task',{taskId:id,patch:{data:JSON.parse('{"constructor":{"prototype":{"polluted":true}}}')}},'worker'),/字段无效/);
  await expectError(f.command(item,'save-task',{taskId:id,patch:{files:[{id:'../../secret',name:'伪造附件'}]}},'worker'),/附件不存在/);
  await expectError(f.command(item,'save-task',{taskId:id,patch:{links:[{name:'恶意',url:'javascript:alert(1)'}]}},'worker'),/有效证据/);
  assert.equal({}.polluted,undefined);assert.equal(f.store.get('analyses',item.id).version,version);
}));

test('共享质量工程师验收，等待验收不计责任人延期；关闭率取提交时间',()=>withFixture(async f=>{
  f.setTime('2026-10-26T01:00:00Z');const u=f.user('worker2');f.store.put('users',u.id,{...u,dept:'工艺部'});const {item,id}=await assignedGeneral(f,{due:'2026-10-27'});
  await f.command(item,'save-task',{taskId:id,patch:{result:'复位延时经示波器验证'}},'worker');await f.command(item,'submit-task',{taskId:id},'worker');
  f.setTime('2026-10-29T04:00:00Z');const accepted=await f.command(item,'accept-task',{taskId:id,initiative:80,ratingReason:'按计划主动完成，证据不要求'},'qe2');const t=accepted.workflow.tasks.find(t=>t.id===id);assert.equal(t.acceptedBy,'qe2');assert.equal(f.wf.engine().W.timing(t).score,100);
  const metrics=await f.api('metrics',{period:'month',date:'2026-10-29'});const dept=metrics.departments.find(d=>d.department==='智能化研究院');assert.equal(dept.onTime,1);assert.equal(dept.rate,100);assert.equal(dept.lateCompleted,0);
  await expectError(f.command(accepted,'accept-task',{taskId:id,initiative:100,ratingReason:'重复验收'}),/先提交/);
}));

test('单独取消验收权限后不能凭管理权限验收',()=>withFixture(async f=>{
  const {item,id}=await assignedGeneral(f);await f.command(item,'save-task',{taskId:id,patch:{result:'已完成'}},'worker');await f.command(item,'submit-task',{taskId:id},'worker');
  const qe=f.user('qe2');f.store.put('users',qe.id,{...qe,permissions:['analysis.manage','tasks.assign']});
  await expectError(f.command(item,'accept-task',{taskId:id,initiative:80,ratingReason:'测试'},'qe2'),/权限/,403);
}));

test('跨部门转交保留原期限和记录、自动更新D1，指标随新部门',()=>withFixture(async f=>{
  const {item,id}=await assignedGeneral(f,{due:'2026-10-27'});const original=f.store.get('analyses',item.id).workflow.tasks.find(t=>t.id===id);
  const moved=await f.command(item,'transfer',{taskId:id,to:'worker2',reason:'需要工艺部继续确认整改方案'},'worker');const t=moved.workflow.tasks.find(t=>t.id===id);
  assert.equal(t.owner,'worker2');assert.equal(t.due,original.due);assert.equal(t.assignedAt,original.assignedAt);assert.equal(t.transfers[0].from,'worker');assert.ok(moved.team.some(m=>m.personId==='worker2'));assert.ok(moved.team.some(m=>m.personId==='worker'));
  const m=await f.api('metrics',{period:'month',date:'2026-10-29'});assert.equal(m.departments.find(d=>d.department==='工艺部').total,1);assert.equal(m.departments.find(d=>d.department==='智能化研究院').total,0);
  await expectError(f.command(moved,'save-task',{taskId:id,patch:{result:'原负责人继续写'}},'worker'),/自己的|责任人/,403);
}));

test('转交双方积分必须由质量工程师确认，合计不得重复领取',()=>withFixture(async f=>{
  const {item,id}=await assignedGeneral(f,{due:'2026-10-30'});await f.command(item,'transfer',{taskId:id,to:'worker2',reason:'分工协作'},'worker');await f.command(item,'save-task',{taskId:id,patch:{result:'旧人员完成采样，新人员完成工艺验证'}},'worker2');await f.command(item,'submit-task',{taskId:id},'worker2');
  let accepted=await f.command(item,'accept-task',{taskId:id,initiative:100,ratingReason:'双方均有独立成果'});const task=accepted.workflow.tasks.find(t=>t.id===id);assert.equal(f.wf.engine().W.taskPoints(task),2);assert.ok(accepted.contributions.find(r=>r.personId==='worker2').pending>0);
  await expectError(f.command(item,'score-transfer',{taskId:id,reason:'错误重复计分',allocations:[{personId:'worker',points:2},{personId:'worker2',points:2}]}),/合计/);
  accepted=await f.command(item,'score-transfer',{taskId:id,reason:'采样及工艺验证各承担一半',allocations:[{personId:'worker',points:1},{personId:'worker2',points:1}]});assert.equal(accepted.contributions.find(r=>r.personId==='worker').base,1);assert.equal(accepted.contributions.find(r=>r.personId==='worker2').base,1);assert.equal(accepted.contributions.reduce((s,r)=>s+r.share,0),100);
  await expectError(f.command(item,'transfer',{taskId:id,to:'worker',reason:'完成后转交'},'worker2'),/未提交/);
}));

test('库存未知与零分开，提交即完成，无验收和积分',()=>withFixture(async f=>{
  let item=await f.create();await f.command(item,'patch-stage',{stage:'D1',team:[{personId:'qe',role:'管理'},{personId:'worker',role:'库存确认'}]});const id=item.workflow.tasks.find(t=>t.kind==='quantity').id;
  await f.command(item,'save-task',{taskId:id,patch:{owner:'worker',due:'2026-10-27'}});await expectError(f.command(item,'submit-task',{taskId:id},'worker'),/非负整数/);
  await f.command(item,'save-task',{taskId:id,patch:{data:{quantity:0,unit:'pcs'}}},'worker');item=await f.command(item,'submit-task',{taskId:id},'worker');const t=item.workflow.tasks.find(t=>t.id===id);assert.equal(t.status,'accepted');assert.equal(f.wf.engine().W.taskPoints(t),null);assert.equal(t.data.quantity,0);
}));

test('统计使用周一至周日，排除未到期任务和取消任务，空分母为null',()=>withFixture(async f=>{
  let {item,id}=await assignedGeneral(f,{due:'2026-11-30'});let m=await f.api('metrics',{period:'week',date:'2026-10-29'});assert.equal(m.start,'2026-10-26');assert.equal(m.end,'2026-11-01');assert.equal(m.tasks.length,0);assert.equal(m.departments.find(d=>d.department==='智能化研究院').rate,null);
  const raw=f.store.get('analyses',item.id),task=raw.workflow.tasks.find(t=>t.id===id);task.due='2026-10-27';task.experimentCancelled=true;f.store.put('analyses',raw.id,raw);m=await f.api('metrics',{period:'year',date:'2026-10-29'});assert.equal(m.tasks.length,0);
}));

test('任务完成部门快照不会随人员以后调岗改变',()=>withFixture(async f=>{
  const {item,id}=await assignedGeneral(f,{due:'2026-10-27'});await f.command(item,'save-task',{taskId:id,patch:{result:'分析完成'}},'worker');await f.command(item,'submit-task',{taskId:id},'worker');await f.command(item,'accept-task',{taskId:id,initiative:100,ratingReason:'结果确认'});
  const before=await f.api('metrics',{period:'month',date:'2026-10-29'});assert.equal(before.departments.find(d=>d.department==='智能化研究院').total,1);
  const moved=f.user('worker');f.store.put('users',moved.id,{...moved,dept:'新设部门'});const after=await f.api('metrics',{period:'month',date:'2026-10-29'});assert.equal(after.departments.find(d=>d.department==='智能化研究院').total,1);assert.equal(after.departments.find(d=>d.department==='新设部门').total,0);
}));

test('管理人员可提前分派各阶段，未分派的未来任务不出现在执行人员待办',()=>withFixture(async f=>{
  const item=await f.create();const q=await f.api('queues');assert.ok(q.rows.length>0);assert.ok(q.rows.some(r=>r.type==='unassigned'&&r.stage==='D3'));const w=await f.api('queues',{},undefined,'worker');assert.equal(w.rows.length,0);const keys=q.rows.map(r=>[r.analysisId,r.stage,r.taskId,r.type,r.label].join('|'));assert.equal(new Set(keys).size,keys.length);
}));

test('执行人员可填写自己的经验教训，内容修改后撤销原确认',()=>withFixture(async f=>{
  let item=await f.create();await f.command(item,'patch-stage',{stage:'D1',team:[{personId:'qe',role:'管理'},{personId:'worker',role:'经验教训'}]});item=await f.command(item,'select-prevention',{key:'lessons',selected:true});const id=item.newTaskId;
  await f.command(item,'save-task',{taskId:id,patch:{owner:'worker',due:'2026-10-30',base:1,evidenceRequired:false}});
  item=await f.command(item,'save-task',{taskId:id,patch:{result:'总结上电时序设计教训',data:{lessonRecord:{phenomenon:'黑屏',rootCause:'时序',effective:'延时',failed:'仅重启',scope:'A01',evidence:'示波器记录'}}}},'worker');assert.equal(item.workflow.d8.lessons.rootCause,'时序');assert.equal(item.workflow.d8.lessons.confirmed,false);
}));

test('OA源单同步保留人工修订和原快照，更新自动字段并要求阶段重确认',()=>withFixture(async f=>{
  let item=await f.create();item=await f.command(item,'patch-stage',{stage:'D2',revised:{customer:'人工核实客户'},fields:{description:'人工补充：低温黑屏伴随复位信号异常',condition:f.fault.condition,editReason:'客户和故障细节已现场核实'}});
  const latest={...f.fault,model:'A02',customer:'OA更新客户',description:'OA补充黑屏发生条件',condition:'新工况',material:'PN-SOURCE-UPDATED'};delete latest.partNo;f.store.put('faults',f.fault.id,latest);
  item=await f.command(item,'sync-source');assert.equal(item.revised.customer,'人工核实客户');assert.equal(item.stages.D2.fields.description,'人工补充：低温黑屏伴随复位信号异常');assert.equal(item.revised.description,'OA补充黑屏发生条件');assert.equal(item.stages.D2.fields.condition,'新工况');assert.equal(item.revised.model,'A02');assert.equal(item.revised.partNo,'PN-SOURCE-UPDATED');assert.equal(item.sourceSyncHistory[0].previousSnapshot.description,f.fault.description);assert.equal(item.stages.D2.done,false);assert.equal(item.stages.D8.done,false);assert.equal(item.sourceUpdateAvailable,false);
  await expectError(f.command(item,'sync-source',{},'worker'),/范围/,404);
}));

test('额外原因移除保留已验收内容和积分，固定原因只解除分派',()=>withFixture(async f=>{
  let item=await f.create();item=await f.command(item,'add-task',{stage:'D4',kind:'cause',section:'escape',title:'附加流出原因'});const id=item.newTaskId;
  await f.command(item,'save-task',{taskId:id,patch:{owner:'worker',due:'2026-10-30',scope:'确认补充流出原因',base:1,evidenceRequired:false}});await f.command(item,'save-task',{taskId:id,patch:{result:'抽样覆盖不足'}},'worker');await f.command(item,'submit-task',{taskId:id},'worker');await f.command(item,'accept-task',{taskId:id,initiative:100,ratingReason:'原因补充已确认'});item=await f.command(item,'remove-cause',{taskId:id,reason:'重复原因合并，原分析贡献保留'});const archived=item.workflow.tasks.find(t=>t.id===id);assert.equal(archived.archived,true);assert.equal(archived.status,'accepted');assert.equal(archived.result,'抽样覆盖不足');assert.equal(archived.submissions[0].status,'accepted');assert.equal(item.contributions.find(r=>r.personId==='worker').base,1);
  const main=item.workflow.tasks.find(t=>t.id===item.workflow.d4.occurrenceTaskId);await f.command(item,'save-task',{taskId:main.id,patch:{owner:'worker',due:'2026-10-30',scope:'产生原因',base:1,evidenceRequired:false}});await f.command(item,'save-task',{taskId:main.id,patch:{result:'尚未提交的原始分析内容'}},'worker');item=await f.command(item,'remove-cause',{taskId:main.id});const current=item.workflow.tasks.find(t=>t.id===main.id);assert.equal(current.owner,'');assert.ok(!current.archived);assert.equal(current.result,'尚未提交的原始分析内容');assert.equal(current.due,'2026-10-30');
}));

test('有关联措施的原因不可移除，固定库存任务不能当作普通任务删除',()=>withFixture(async f=>{
  let item=await f.create();item=await f.command(item,'add-task',{stage:'D4',kind:'cause',section:'escape',title:'额外原因'});const id=item.newTaskId;
  await f.command(item,'save-task',{taskId:id,patch:{owner:'worker',due:'2026-10-30',scope:'分析流出',base:1,evidenceRequired:false}});await f.command(item,'save-task',{taskId:id,patch:{result:'检验遗漏'}},'worker');await f.command(item,'submit-task',{taskId:id},'worker');await f.command(item,'accept-task',{taskId:id,initiative:100,ratingReason:'确认'});await f.command(item,'create-measure',{causeId:id});
  await expectError(f.command(item,'remove-cause',{taskId:id}),/已关联永久措施/);const quantity=item.workflow.tasks.find(t=>t.kind==='quantity');await expectError(f.command(item,'delete-task',{taskId:quantity.id}),/固定流程/);
}));

test('D1删除人员退回其未验收任务、保留已验收任务，真实负责人不可删除',()=>withFixture(async f=>{
  const a=await assignedGeneral(f,{who:'worker'}),b=await assignedGeneral(f,{who:'worker2'});await f.command(a.item,'save-task',{taskId:a.id,patch:{result:'设计分析提交'}},'worker');await f.command(a.item,'submit-task',{taskId:a.id},'worker');await f.command(b.item,'save-task',{taskId:b.id,patch:{result:'工艺工作完成'}},'worker2');await f.command(b.item,'submit-task',{taskId:b.id},'worker2');await f.command(b.item,'accept-task',{taskId:b.id,initiative:100,ratingReason:'已验收工作'});
  let item=await f.command(a.item,'patch-stage',{stage:'D1',team:[{personId:'qe',role:'原事项负责人'},{personId:'qe2',role:'调整分工'},{personId:'worker',role:'历史设计成员',inactive:true},{personId:'worker2',role:'历史工艺成员',inactive:true}]},'qe2');const pending=item.workflow.tasks.find(t=>t.id===a.id),accepted=item.workflow.tasks.find(t=>t.id===b.id);assert.equal(item.owner,'qe');assert.equal(pending.owner,'');assert.equal(pending.status,'returned');assert.equal(pending.result,'设计分析提交');assert.equal(pending.submissions[0].status,'returned');assert.equal(accepted.owner,'worker2');assert.equal(accepted.status,'accepted');assert.equal(item.contributions.find(r=>r.personId==='worker2').base,2);
  await expectError(f.command(item,'patch-stage',{stage:'D1',team:[{personId:'qe2',role:'试图移除原负责人'}]},'qe2'),/负责人须保留/);
}));

test('完整D1—D8按需零实验关单，保留快照和历史且不改原报故',()=>withFixture(async f=>{
  let item=await f.create();const cmd=async(action,body={},who='qe')=>{item=await f.command(item,action,body,who);return item;};
  const finish=stage=>cmd('finish-stage',{stage});
  await cmd('patch-stage',{stage:'D1',fields:{goal:'解决屏幕黑屏，避免复发',weightReason:'按实际任务分工计分'},team:[{personId:'qe',role:'组织与验收'},{personId:'worker',role:'根因与措施'}]});await finish('D1');
  await cmd('patch-stage',{stage:'D2',fields:{description:f.fault.description,condition:f.fault.condition,impact:'涉及1pcs'},config:{d2:{reproductionDescription:'低温首次上电黑屏，重启恢复'}}});await cmd('add-task',{stage:'D2',kind:'sn',title:'SN数量确认'});let id=item.newTaskId;
  const complete=async(id,{title,scope='记录分析结果',data={},result='已完成并核对',evidence=false}={})=>{await cmd('save-task',{taskId:id,patch:{...(title?{title}:{}),owner:'worker',reviewer:'qe',due:'2026-10-30',base:1,scope,evidenceRequired:evidence}});await cmd('save-task',{taskId:id,patch:{result,data}},'worker');await cmd('submit-task',{taskId:id},'worker');const task=item.workflow.tasks.find(t=>t.id===id);if(task.status==='submitted')await cmd('accept-task',{taskId:id,initiative:100,...(evidence?{evidenceScore:100}:{}),ratingReason:'按约定完成，结果可复核'});};
  await complete(id,{data:{sn:'SN-001',quantity:100}});await finish('D2');
  await cmd('patch-stage',{stage:'D3',fields:{containment:'临时增加低温开机筛选',execution:'已覆盖在制及库存'}});
  for(const task of item.workflow.tasks.filter(t=>t.kind==='quantity')){await cmd('save-task',{taskId:task.id,patch:{owner:'worker',due:'2026-10-30'}});await cmd('save-task',{taskId:task.id,patch:{data:{quantity:0}}},'worker');await cmd('submit-task',{taskId:task.id},'worker');}
  const plan=item.workflow.tasks.find(t=>t.kind==='rework');f.store.put('files','evidence-plan',{name:'返工方案.pdf',type:'application/pdf',size:1,sha256:'synthetic',uploadedBy:'worker'});await cmd('save-task',{taskId:plan.id,patch:{owner:'worker',reviewer:'qe',due:'2026-10-30',base:1,scope:'返工固件更新'}});await cmd('save-task',{taskId:plan.id,patch:{result:'更新完成',data:{categories:['原材料','半成品','成品','在途品','客户端成品']},files:[{id:'evidence-plan'}]}},'worker');await cmd('submit-task',{taskId:plan.id},'worker');await cmd('accept-task',{taskId:plan.id,initiative:100,evidenceScore:100,ratingReason:'方案和适用范围已确认'});await finish('D3');
  await cmd('patch-stage',{stage:'D4',config:{d4:{occurrenceResponsibility:{primary:'智能化研究院',secondary:[]}}}});
  for(const task of item.workflow.tasks.filter(t=>t.kind==='cause'))await complete(task.id,{result:task.data.section==='occurrence'?'复位释放早于电源稳定':task.data.section==='escape'?'出厂未覆盖低温首次启动':'检验责任归属质量部',data:task.data.section==='escapeDept'?{primary:'质量部',secondary:[]}:{} });
  await finish('D4');
  for(const cause of item.workflow.tasks.filter(t=>t.kind==='cause'&&['occurrence','escape'].includes(t.data.section))){await cmd('create-measure',{causeId:cause.id});const mid=item.newTaskId;await complete(mid,{title:cause.data.section==='occurrence'?'增加复位延时':'增加低温开机检验',result:''});}
  await finish('D5');await cmd('patch-stage',{stage:'D6',config:{d6:{withdrawal:'措施已生效，可撤除临时筛选；不新增实验任务'}}});await finish('D6');
  await cmd('select-prevention',{key:'cp',selected:true});await complete(item.newTaskId,{result:'控制计划已增加低温开机测试'});await cmd('patch-stage',{stage:'D7',config:{d8:{horizontal:false,horizontalReason:'同类平台已覆盖，暂无其他型号'}}});await finish('D7');
  await cmd('patch-stage',{stage:'D8',fields:{summary:'发生原因和流出原因已消除，措施固化到控制计划'}});await finish('D8');await cmd('close');
  assert.equal(item.status,'closed');assert.equal(f.closed.length,1);assert.ok(item.finalContributions.length);assert.equal(item.workflow.tasks.filter(t=>t.kind==='verification').length,0);assert.ok(item.closeSnapshot);assert.equal(f.store.get('faults',f.fault.id).description,f.fault.description);assert.equal(item.approval.required,false);
  await expectError(cmd('patch-stage',{stage:'D8',fields:{summary:'关闭后修改'}}),/已关闭/);
}));

test('责任人只能顺序填写和提交自己的任务，质量工程师可跨阶段分派',()=>withFixture(async f=>{
 let x=await f.create();const a=x.workflow.tasks.find(t=>t.kind==='quantity');
 x=await f.command(x,'save-task',{taskId:a.id,patch:{owner:'worker',due:'2026-11-03',evidenceRequired:false}});
 x=await f.command(x,'add-task',{stage:'D7',kind:'general',title:'后续预防任务'});const id=x.newTaskId;
 await f.command(x,'save-task',{taskId:id,patch:{owner:'worker',reviewer:'qe',due:'2026-11-09',base:1,evidenceRequired:false}});
 await expectError(f.command(x,'save-task',{taskId:id,patch:{result:'尝试跳过库存'}},'worker'),/请先完成当前任务/,409);
 await expectError(f.command(x,'submit-task',{taskId:id},'worker'),/请先完成当前任务/,409);
 await f.command(x,'save-task',{taskId:a.id,patch:{data:{quantity:0}}},'worker');await f.command(x,'submit-task',{taskId:a.id},'worker');
 await f.command(x,'save-task',{taskId:id,patch:{result:'按顺序办理，记录已补全'}},'worker');await f.command(x,'submit-task',{taskId:id},'worker');
 assert.equal(f.store.get('analyses',x.id).workflow.tasks.find(t=>t.id===id).status,'submitted');
}));
test('读取进度不修改原对象、D3取消摘要校验且历史字段保留、提交指纹忽略对象键顺序',()=>withFixture(async f=>{
 const x=await f.create(),{C,W}=f.wf.engine();delete x.workflow;const original=JSON.stringify(x);W.progress(x);W.checklist(x);assert.equal(JSON.stringify(x),original);
 W.ensure(x);x.stages.D3.fields={containment:'',execution:''};assert.ok(!W.checklist(x).some(i=>i.stage==='D3'&&/临时措施与覆盖范围|措施实施结果/.test(i.label)));
 assert.doesNotMatch(C.validateStage(x,'D3'),/关键内容/);
 x.team.push({personId:'worker',role:'模拟数量填报'});const t=W.newTask('D3','quantity','测试数量');Object.assign(t,{owner:'worker',due:'2026-11-02',data:{category:'成品',quantity:0,unit:'pcs'}});x.workflow.tasks.push(t);
 assert.equal(W.submitTask(x,t.id),'');t.data={unit:'pcs',quantity:0,category:'成品'};assert.equal(W.currentSubmission(t),true);t.data.quantity=1;assert.equal(W.currentSubmission(t),false);
}));
test('移除误建分析保留历史与附件，待办不再显示，不按标题误删另一份分析',()=>withFixture(async f=>{
 const x=await f.create();await f.command(x,'archive-analysis',{reason:'删除误建的模拟任务，保留完整历史记录'});
 const saved=f.store.get('analyses',x.id);assert.equal(saved.archived,true);assert.equal(saved.faultId,x.faultId);assert.equal((await f.api('queues')).rows.length,0);assert.equal(f.wf.metricTasks().filter(t=>t.analysisId===x.id).length,0);
 assert.ok(saved.history.some(h=>h.text.includes('archive-analysis')));
}));
