import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hasPermission,permissionsFor } from './auth.mjs';
import {d2Eligible} from './group-policy.mjs';
import {gridCommand} from './grid-service.mjs';
import {scopedData,requireRecord,globalView,canReadFile} from './access.mjs';

// 共享8D引擎目录：本地为 dist；云托管上传会排除 dist，发布包内改名为 engine
const DIST = ['dist','engine'].map(name=>path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../'+name)).find(dir=>fs.existsSync(path.join(dir,'analysis-core.js')))||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../dist');
const coreSource = fs.readFileSync(path.join(DIST, 'analysis-core.js'), 'utf8');
let workflowSource = fs.readFileSync(path.join(DIST, 'analysis-workflow.js'), 'utf8').replaceAll('\r\n','\n');
// Keep the tested engine. The local service, rather than a caller-supplied person ID,
// supplies the authorised quality-engineer review identity.
const reviewerNeedle="const reviewerFor = (item, t) => t.stage === 'D4' && t.kind === 'cause' ? 'me' : t.reviewer;";
const contributionNeedle="const row = byPerson.get(task.owner); if (!row || isQuantity(task)) continue;\n      const points = taskPoints(task);\n      if (points === null) row.pending += 1; else row.base += points;";
if(!workflowSource.includes(reviewerNeedle)||!workflowSource.includes(contributionNeedle))throw Error('8D引擎接口已变化，请先执行兼容性检查');
workflowSource = workflowSource.replace(
  "const reviewerFor = (item, t) => t.stage === 'D4' && t.kind === 'cause' ? 'me' : t.reviewer;",
  "const reviewerFor = (item, t) => root.__localReviewActor || (t.stage === 'D4' && t.kind === 'cause' ? item.owner : t.reviewer);"
);
workflowSource = workflowSource.replace(
  "const row = byPerson.get(task.owner); if (!row || isQuantity(task)) continue;\n      const points = taskPoints(task);\n      if (points === null) row.pending += 1; else row.base += points;",
  `const row = byPerson.get(task.owner); if (!row || isQuantity(task)) continue;
      const points = taskPoints(task);
      if (task.transfers?.length) {
        const e=task.transferEvaluation;
        if(points!==null&&e?.confirmed&&Math.abs(Number(e.total)-points)<1e-6){
          for(const a of e.allocations||[]){const p=byPerson.get(a.personId);if(p)p.base+=Number(a.points);}
        }else for(const id of new Set([task.owner,...task.transfers.flatMap(t=>[t.from,t.to])])){const p=byPerson.get(id);if(p)p.pending+=1;}
      } else if (points === null) row.pending += 1; else row.base += points;`
);
const STAGES = ['D1','D2','D3','D4','D5','D6','D7','D8'];
const clone = x => JSON.parse(JSON.stringify(x));
const str = x => String(x ?? '').trim();
const unsafe = new Set(['__proto__','prototype','constructor']);
export function workflowError(message, status = 400) { return Object.assign(new Error(message), { status }); }
const fail = (message, status) => { throw workflowError(message, status); };
const ensure = (condition, message, status) => { if (!condition) fail(message, status); };
const cleanObject = x => { ensure(x && typeof x === 'object' && !Array.isArray(x), '提交内容须为对象'); for(const k of Object.keys(x))ensure(!unsafe.has(k),'字段无效'); return x; };
const dateStamp = d => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const dateValid = value => /^\d{4}-\d{2}-\d{2}$/.test(str(value)) && Number.isFinite(Date.parse(value+'T00:00:00+08:00')) && dateStamp(new Date(value+'T00:00:00+08:00'))===value;
const dueInstant = value => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(str(value))?value+'T23:59:59.999+08:00':value);
function isManager(user) { return enabled(user) && (user?.role === 'admin' || hasPermission(user,'analysis.manage')); }
function canReview(user) { return enabled(user) && (user?.role === 'admin' || hasPermission(user,'tasks.review')); }
function checkPermission(user, key) { ensure(user?.enabled && (user.role === 'admin' || hasPermission(user,key)), '当前账号没有此操作权限', 403); }
const enabled = u => u && u.enabled !== false;
function engine(users, now, reviewActor) {
  const NativeDate=Date;
  class ClockDate extends NativeDate { constructor(...args){super(...(args.length?args:[now]));} static now(){return new NativeDate(now).getTime();} }
  const context=vm.createContext({Date:ClockDate,Intl,URL,crypto:{randomUUID},console:{warn(){},log(){}},__localReviewActor:reviewActor||''});
  vm.runInContext(coreSource,context,{filename:'analysis-core.js'});
  vm.runInContext(workflowSource,context,{filename:'analysis-workflow.js'});
  vm.runInContext(fs.readFileSync(path.join(DIST,'../local-app/public/nine-grid-core.js'),'utf8'),context); 
  vm.runInContext(fs.readFileSync(path.join(DIST,'../local-app/public/task-sequence.js'),'utf8'),context);
  context.AnalysisCore.people.splice(0,context.AnalysisCore.people.length,...users.map(u=>({id:u.id,name:u.name,dept:u.dept||'',roles:isManager(u)||canReview(u)?['quality-manager']:[]})));
  for(const u of users)if(u.dept&&!context.AnalysisCore.departments.includes(u.dept))context.AnalysisCore.departments.push(u.dept);
  return {C:context.AnalysisCore,W:context.AnalysisWorkflow,G:context.NineGrid,F:context.TaskSequence};
}
function periodRange(period, date, now) {
  ensure(['week','month','year'].includes(period),'统计周期无效');ensure(dateValid(date),'统计日期无效');
  let start,end; const d=new Date(date+'T00:00:00Z');
  if(period==='week'){d.setUTCDate(d.getUTCDate()-(d.getUTCDay()||7)+1);start=d.toISOString().slice(0,10);d.setUTCDate(d.getUTCDate()+6);end=d.toISOString().slice(0,10);}
  if(period==='month'){start=date.slice(0,7)+'-01';end=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).toISOString().slice(0,10);}
  if(period==='year'){start=date.slice(0,4)+'-01-01';end=date.slice(0,4)+'-12-31';}
  return {period,start,end,cutoff:new Date(Math.min(dueInstant(end),+now)).toISOString()};
}

export function createWorkflowService({store,fileRoot,onClosed=async()=>{},clock=()=>new Date()}) {
  const allUsers=()=>[...store.list('users'),...store.list('historicalPeople').filter(p=>!store.get('users',p.id))];
  const userBy=id=>allUsers().find(u=>u.id===id);
  const stamp=(user,text,now)=>({at:now.toISOString(),actor:user.name,actorId:user.id,text});
  const history=(item,user,text,now)=>{item.history ||= [];item.history.push(stamp(user,text,now));};
  const preliminaryFor=faultId=>store.list('preliminary').filter(p=>p.faultId===faultId&&p.status==='submitted');
  const requireVersion=(record,version)=>ensure(Number.isInteger(version)&&record.version===version,'记录已被其他人员更新，请刷新后重试',409);
  function files(input,user) {
    ensure(Array.isArray(input)&&input.length<=100,'附件列表无效');
    return input.map(f=>{const found=store.get('files',str(f.id));ensure(found&&canReadFile(store,user,found.id),'附件不存在或无权关联',404);return {id:found.id,name:found.name,size:found.size,type:found.type,sha256:found.sha256};});
  }
  function links(input) {
    ensure(Array.isArray(input)&&input.length<=100,'证据链接列表无效');return input.map(l=>{const name=str(l.name);let url;try{url=new URL(l.url);}catch{fail('请输入有效证据名称和链接');}ensure(name&&['http:','https:'].includes(url.protocol),'请输入有效证据名称和链接');return {name,url:url.href};});
  }
  function usersForEngine(){return allUsers().map(u=>({...u,groupId:'',permissions:permissionsFor(u),enabled:enabled(u)}));}
  function validateTaskActor(item,t,user,manager) { ensure(t,'任务不存在',404);ensure(item.status==='active','已关闭或待审批事项不能修改');ensure(manager||t.owner===user.id,'只能填写分派给自己的任务',403);ensure(['draft','returned'].includes(t.status),'任务已提交或已验收，不能直接修改'); }
  function addMember(item,id,role='任务协作') {if(!item.team.some(m=>m.personId===id))item.team.push({personId:id,role});else item.team.find(m=>m.personId===id).inactive=false;}
  function invalidate(item,from) {const index=STAGES.indexOf(from);for(const stage of STAGES.slice(index))item.stages[stage].done=false;if(STAGES.indexOf(item.stage)>index)item.stage=from;}
  function decorate(item,C,W) { const result=clone(item);W.ensure(result);result.contributions=clone(C.contribution(result));result.progress=clone(W.progress(result));result.checklist=clone(W.checklist(result,clock().toISOString()));return result; }
  function persist(item,user,event,oldVersion,C,W,now,details={}) {
    delete item.contributions;delete item.progress;delete item.checklist;delete item.newTaskId;
    history(item,user,event,now);
    if(item.status==='closed'&&event==='8D操作：close'){delete item.closeSnapshot;item.closeSnapshot=clone(item);}
    return decorate(store.put('analyses',item.id,item,{expectedVersion:oldVersion,actor:user.id,event,details}),C,W);
  }
  function taskSnapshot(item,t,now) {
    t.reportingDept=userBy(t.owner)?.dept||'未设置部门';
    if(t.status==='accepted'&&(!t.completedDept||t.completedAt!==t.submittedAt)){t.completedDept=t.reportingDept;t.completedAt=t.submittedAt||now.toISOString();}
  }
  function validateReferences(item,t) {
    ensure(!t.owner||enabled(userBy(t.owner))&&!['viewer','freeze-clerk'].includes(userBy(t.owner).role),'请选择启用的执行账号作为任务责任人');
    ensure(!t.reviewer||enabled(userBy(t.reviewer)),'请选择启用的确认人员');
    if(t.owner&&!item.team.some(m=>m.personId===t.owner&&!m.inactive))addMember(item,t.owner,'任务协作：'+t.title);
    if(t.reviewer&&!item.team.some(m=>m.personId===t.reviewer&&!m.inactive))addMember(item,t.reviewer,'任务验收');
    if(t.owner)ensure(item.team.some(m=>m.personId===t.owner&&!m.inactive),'责任人须先加入团队');
    if(t.reviewer)ensure(item.team.some(m=>m.personId===t.reviewer&&!m.inactive),'确认人须先加入团队');
    if(t.due)ensure(dateValid(t.due),'完成期限无效');
  }
  function patchTask(item,t,patch,user,manager,C,W,now) {
    const assigner=hasPermission(user,'tasks.assign');validateTaskActor(item,t,user,manager||assigner);cleanObject(patch);
    const configKeys=['title','scope','owner','reviewer','due','base','evidenceRequired','causeId','measureIds'];
    const outputKeys=['result','data','files','links'];
    for(const key of Object.keys(patch)){ensure((manager||assigner?[...configKeys,...outputKeys]:outputKeys).includes(key),'不允许修改任务字段：'+key,403);if(outputKeys.includes(key))ensure(t.owner===user.id,'实际成果只能由被分派的责任人填写',403);if(['evidenceRequired','causeId','measureIds'].includes(key))ensure(manager,'此项需要8D管理权限',403);}
    if(Object.keys(patch).some(k=>['owner','reviewer','due','base','scope','title'].includes(k)&&String(patch[k]??'')!==String(t[k]??'')))checkPermission(user,'tasks.assign');
    const originalOwner=t.owner;
    for(const key of configKeys.filter(k=>!['evidenceRequired','causeId','measureIds'].includes(k)))if(Object.hasOwn(patch,key))t[key]=key==='base'?patch[key]===null?null:Number(patch[key]):str(patch[key]);
    if(Object.hasOwn(patch,'evidenceRequired')){ensure(typeof patch.evidenceRequired==='boolean','证据要求无效');if(t.simpleFreeze)ensure(!patch.evidenceRequired,'冻结填报不要求任务证据');else {const e=W.setEvidenceRequirement(item,t.id,patch.evidenceRequired,user.id);if(e)fail(e);}}
    if(Object.hasOwn(patch,'result'))t.result=str(patch.result).slice(0,12000);
    if(Object.hasOwn(patch,'data')){
      cleanObject(patch.data);
      const fields={quantity:['quantity'],freeze:['sn','productionQty','material','shippedQty'],sn:['quantity','sn','snScope','snapshotAt'],cause:['primary','secondary'],scheme:['categories'],rework:['categories'],measure:[],implementation:['measureId','scope'],verification:['scope','criteria','sample','window','decision'],production:['scope','decision'],horizontal:['targets']};
      const allowed=fields[t.kind]||['targets'];
      for(const [key,value]of Object.entries(patch.data)){
        if(key==='section'){ensure(manager&&value===t.data.section,'不能修改原因分区',403);continue;}
        if(key==='unit'){ensure(value===(W.isQuantity(t)?'pcs':t.data.unit),'数量单位不可更改');continue;}
        if(key==='measureKey'){ensure(value===t.data.measureKey,'不能修改预防措施类别');continue;}
        if(key==='lessonRecord'){
          ensure(W.isLesson(t),'只有经验教训任务可填写此内容');cleanObject(value);
          for(const [k,v]of Object.entries(value)){ensure(['phenomenon','rootCause','effective','failed','scope','evidence'].includes(k),'经验教训字段无效');item.workflow.d8.lessons[k]=str(v);}
          item.workflow.d8.lessons.confirmed=false;continue;
        }
        ensure(allowed.includes(key),'不允许修改结果字段：'+key,403);
        t.data[key]=Array.isArray(value)?value.map(str):typeof value==='number'?value:str(value);
      }
    }
    if(Object.hasOwn(patch,'files'))t.files=files(patch.files,user);
    if(Object.hasOwn(patch,'links'))t.links=links(patch.links);
    if(Object.hasOwn(patch,'causeId')){const error=W.linkMeasure(item,t.id,patch.causeId,user.id);if(error)fail(error);}
    if(Object.hasOwn(patch,'measureIds')){const error=W.linkExperiment(item,t.id,patch.measureIds,user.id);if(error)fail(error);}
    if(t.owner&&!t.reviewer&&!W.isQuantity(t)&&t.kind!=='cause')t.reviewer=item.owner;
    if(originalOwner&&t.owner&&originalOwner!==t.owner&&enabled(userBy(t.owner)))addMember(item,t.owner,'任务协作：'+t.title);
    validateReferences(item,t);
    if(originalOwner&&originalOwner!==t.owner){t.assignmentHistory ||= [];t.assignmentHistory.push({from:originalOwner,to:t.owner,at:now.toISOString(),by:user.id,reason:'质量工程师调整分派'});if(t.owner){t.transfers ||= [];t.transfers.push({from:originalOwner,to:t.owner,fromName:userBy(originalOwner)?.name||originalOwner,toName:userBy(t.owner)?.name||t.owner,fromDept:userBy(originalOwner)?.dept||'',toDept:userBy(t.owner)?.dept||'',at:now.toISOString(),by:user.id,reason:'管理人员调整分派，原成果保留'});}t.transferEvaluation=null;}
    taskSnapshot(item,t,now);invalidate(item,t.stage);
  }
  function patchStage(item,body,user,C,W,now,originalOwner=item.owner) {
    checkPermission(user,'analysis.manage');const id=body.stage;ensure(STAGES.includes(id),'阶段无效');const s=item.stages[id];
    if(body.fields){cleanObject(body.fields);for(const [key,value]of Object.entries(body.fields)){ensure(C.stages.find(v=>v.id===id).fields.some(([k])=>k===key),'阶段字段无效');s.fields[key]=str(value).slice(0,12000);}}
    for(const key of ['na','naReason','requiresEvidence'])if(Object.hasOwn(body,key))s[key]=key==='naReason'?str(body[key]):!!body[key];
    if(body.files)s.files=files(body.files,user);if(body.links)s.links=links(body.links);
    if(body.team){
      checkPermission(user,'tasks.assign');ensure(id==='D1'&&Array.isArray(body.team)&&body.team.length,'团队成员不能为空');const seen=new Set();const next=body.team.map(m=>{ensure(userBy(m.personId)&&!seen.has(m.personId),'团队成员无效或重复');seen.add(m.personId);return {personId:m.personId,role:str(m.role),inactive:!!m.inactive};});
      ensure(next.some(m=>m.personId===originalOwner&&!m.inactive),'事项负责人须保留在团队中');
      for(const old of item.team)if(!seen.has(old.personId))next.push({...old,inactive:true});const removed=new Set(next.filter(m=>m.inactive).map(m=>m.personId));
      for(const task of item.workflow.tasks){if(task.status==='accepted')continue;const ownerRemoved=removed.has(task.owner),reviewerRemoved=removed.has(task.reviewer);if(!ownerRemoved&&!reviewerRemoved)continue;
        task.assignmentHistory ||= [];task.assignmentHistory.push({from:task.owner,to:ownerRemoved?'':task.owner,reviewerFrom:task.reviewer,reviewerTo:reviewerRemoved?originalOwner:task.reviewer,at:now.toISOString(),by:user.id,reason:'D1移除团队成员，保留成果并待重新分派'});
        if(task.status==='submitted'){task.status='returned';task.acceptedAt='';task.returnReason='D1成员变更，任务退回待重新分派；原提交内容保留';const previous=task.submissions?.at(-1);if(previous)Object.assign(previous,{status:'returned',reviewedAt:now.toISOString(),reviewer:user.id,reason:task.returnReason});}
        if(ownerRemoved)task.owner='';if(reviewerRemoved)task.reviewer=originalOwner;task.transferEvaluation=null;
      }
      item.team=next;
    }
    if(body.revised){ensure(id==='D2','只能在D2修改基础信息');cleanObject(body.revised);for(const [key,value]of Object.entries(body.revised)){ensure(['product','model','customer','project','description','condition','quantity','partNo'].includes(key),'基础信息字段无效');item.revised[key]=str(value);}}
    if(body.meta){cleanObject(body.meta);for(const [key,value]of Object.entries(body.meta)){ensure(['nextAction','followDate','deadline','waiting'].includes(key),'跟进字段无效');item[key]=str(value);}}
    if(body.bonuses){ensure(id==='D8','只能在D8评定加分');cleanObject(body.bonuses);for(const [personId,b]of Object.entries(body.bonuses)){ensure(item.team.some(m=>m.personId===personId),'加分成员不在团队');item.bonuses[personId]={points:Number(b.points),reason:str(b.reason),evidence:str(b.evidence),confirmed:true,confirmedBy:user.id};}}
    if(body.config){cleanObject(body.config);const allowed={d2:['reproductionDescription','major','batch','freeze','freezeNumber','snScope'],d4:['occurrenceResponsibility'],d6:['withdrawal'],d8:['similar','recurrence','horizontal','horizontalReason','lessons','production']};
      for(const [section,patch]of Object.entries(body.config)){ensure(allowed[section],'流程配置无效');ensure((section==='d2'&&id==='D2')||(section==='d4'&&id==='D4')||(section==='d6'&&id==='D6')||(section==='d8'&&['D6','D7','D8'].includes(id)),'配置不属于当前阶段');cleanObject(patch);
        for(const [key,value]of Object.entries(patch)){ensure(allowed[section].includes(key),'流程配置字段无效');if(section==='d2'&&item.workflow.d2.unified)ensure(!['freezeNumber','freeze','major','batch','reproductionDescription'].includes(key),'请通过D2统一窗口修改设置，冻结编号由变更管理员填写');
          if(key==='occurrenceResponsibility'){cleanObject(value);const next={primary:str(value.primary),secondary:Array.isArray(value.secondary)?value.secondary.map(str):[]};const old=item.workflow.d4.occurrenceResponsibility;if(JSON.stringify([next.primary,next.secondary])!==JSON.stringify([old.primary,old.secondary]))item.workflow.d4.occurrenceResponsibility={...next,confirmed:false,confirmedAt:''};}
          else if(key==='lessons'){cleanObject(value);const next=item.workflow.d8.lessons;for(const [k,v]of Object.entries(value)){ensure(['phenomenon','rootCause','effective','failed','scope','evidence','confirmed'].includes(k),'经验教训字段无效');if(k==='confirmed')continue;if(next[k]!==str(v))next.confirmed=false;next[k]=str(v);}}
          else if(key==='production'){cleanObject(value);const valid=['enabled','mode','product','model','revision','effectiveDate','message','departments','engineers'];for(const [k,v]of Object.entries(value)){ensure(valid.includes(k),'首产配置字段无效');item.workflow.d8.production[k]=k==='enabled'?!!v:Array.isArray(v)?v.map(str):str(v);}}
          else if(key==='recurrence'){cleanObject(value);ensure(!value.originalId||store.get('analyses',value.originalId)?.status==='closed','请选择已关闭的原8D');item.workflow.d8.recurrence={originalId:str(value.originalId),reason:str(value.reason)};}
          else if(key==='similar'){ensure(Array.isArray(value),'类似问题格式无效');item.workflow.d8.similar=value.map(v=>{ensure(store.get('analyses',v.id),'类似问题不存在');ensure(['现象相似','根因相同','措施可借鉴'].includes(v.type),'类似关系无效');return {id:v.id,type:v.type};});}
          else item.workflow[section][key]=typeof value==='boolean'?value:str(value);
        }
      }
      for(const [active,stage,kind,title]of [[item.workflow.d2.freeze,'D2','freeze','产品冻结数量填报'],[item.workflow.d8.horizontal,'D7','horizontal','同类产品横向展开'],[item.workflow.d8.production.enabled,'D6','production','整改后首次生产复核']])if(active&&!item.workflow.tasks.some(t=>t.kind===kind)){const t=W.newTask(stage,kind,title);t.reviewer=item.owner;item.workflow.tasks.push(t);}
      W.ensure(item);if(id==='D2')for(const task of item.workflow.tasks.filter(t=>t.kind==='freeze'&&!t.archived&&t.status!=='accepted')){task.data.material=item.revised.partNo||item.snapshot.material||task.data.material||'';task.data.sn=item.revised.sn||item.snapshot.sn||item.workflow.d2.snScope||task.data.sn||'';}
    }
    invalidate(item,id);
  }
  function preliminary(action,{user,body,id},now) {
    const fault=store.get('faults',id);ensure(fault,'报故不存在',404);
    if(action==='assign'){checkPermission(user,'tasks.assign');const assignee=userBy(body.userId);ensure(enabled(assignee)&&hasPermission(assignee,'preliminary.write'),'请选择启用的失效分析人员');ensure(dateValid(body.due),'请选择有效完成期限');const previous=store.get('preliminaryAssignments',id);return store.put('preliminaryAssignments',id,{faultId:id,userId:assignee.id,due:body.due,assignedBy:user.id,assignedAt:now.toISOString(),status:'assigned',history:[...(previous?.history||[]),stamp(user,'分派初步分析给 '+assignee.name,now)]},{actor:user.id,event:'分派报故初步分析'});}
    checkPermission(user,'preliminary.write');const previous=body.id?store.get('preliminary',body.id):null;
    if(body.id){ensure(previous&&previous.faultId===id,'初步分析记录不存在',404);ensure(previous.authorId===user.id,'只能修改自己的分析记录',403);requireVersion(previous,body.version);}
    const status=body.remove?'archived':body.status||'draft';ensure(['draft','submitted','archived'].includes(status),'初步分析状态无效');
    const record={...(previous||{}),id:previous?.id||randomUUID(),faultId:id,authorId:user.id,authorName:user.name,department:user.dept||'',phenomenon:str(body.phenomenon??previous?.phenomenon),process:str(body.process??previous?.process),conclusion:str(body.conclusion??previous?.conclusion),files:body.files?files(body.files,user):previous?.files||[],status,createdAt:previous?.createdAt||now.toISOString(),updatedAt:now.toISOString(),history:[...(previous?.history||[])]};
    if(status==='submitted')ensure(record.phenomenon&&record.process&&record.conclusion,'请填写现象、检查过程和初步结论');
    if(previous)record.history.push({version:previous.version,at:now.toISOString(),by:user.id,phenomenon:previous.phenomenon,process:previous.process,conclusion:previous.conclusion,files:previous.files,status:previous.status});
    if(status==='submitted')record.submittedAt=now.toISOString();
    const saved=store.put('preliminary',record.id,record,{expectedVersion:previous?.version,actor:user.id,event:'保存报故初步分析'});
    const assignment=store.get('preliminaryAssignments',id);if(assignment?.userId===user.id&&status==='submitted')store.put('preliminaryAssignments',id,{...assignment,status:'completed',completedAt:now.toISOString(),recordId:record.id,completedDept:user.dept||'未设置部门'},{expectedVersion:assignment.version,actor:user.id,event:'完成初步分析任务'});
    return saved;
  }
  function metricTasks(W) {
    const tasks=[];
    for(const item of store.list('analyses').filter(x=>!x.archived)){W.ensure(item);for(const t of item.workflow.tasks.filter(t=>W.taskEnabled(item,t))){const user=userBy(t.owner),complete=t.status==='accepted'&&W.currentSubmission(t);tasks.push({analysisId:item.id,faultId:item.faultId,id:t.id,taskId:t.id,title:t.title,stage:t.stage,owner:t.owner,ownerName:user?.name||'历史人员',department:complete?t.completedDept||t.reportingDept||user?.dept||'未设置部门':t.reportingDept||user?.dept||'未设置部门',due:t.due,status:t.status,completedAt:complete?t.submittedAt||t.completedAt:'',completed:complete,awaitingReview:t.status==='submitted'});}}
    for(const p of store.list('preliminaryAssignments')){const user=userBy(p.userId);tasks.push({faultId:p.faultId,id:'preliminary:'+p.id,taskId:'preliminary:'+p.id,title:'报故初步失效分析',stage:'初步分析',owner:p.userId,ownerName:user?.name||'历史人员',department:p.completedDept||user?.dept||'未设置部门',due:p.due,status:p.status,completedAt:p.completedAt||'',completed:p.status==='completed',awaitingReview:false});}
    return tasks;
  }
  function metrics(body,W,now) {
    const range=periodRange(body.period||'month',body.date||dateStamp(now),now),cutoff=Date.parse(range.cutoff),start=Date.parse(range.start+'T00:00:00+08:00');
    const all=metricTasks(W).filter(t=>Number.isFinite(dueInstant(t.due))&&dueInstant(t.due)<=cutoff),window=all.filter(t=>dueInstant(t.due)>=start);
    const departments=[...new Set([...allUsers().map(u=>u.dept||'未设置部门'),...all.map(t=>t.department)])].map(department=>{
      const tasks=window.filter(t=>t.department===department),onTime=tasks.filter(t=>t.completed&&Date.parse(t.completedAt)<=dueInstant(t.due)).length,lateCompleted=tasks.filter(t=>t.completed&&Date.parse(t.completedAt)>dueInstant(t.due)).length,pendingReview=tasks.filter(t=>!t.completed&&t.awaitingReview).length,overdueOpen=tasks.filter(t=>!t.completed&&!t.awaitingReview).length,backlog=all.filter(t=>t.department===department&&dueInstant(t.due)<start&&!t.completed).length;
      return {department,total:tasks.length,onTime,lateCompleted,pendingReview,overdueOpen,backlog,rate:tasks.length?Math.round(onTime/tasks.length*10000)/100:null,tasks};
    });return {...range,departments,tasks:window,backlog:all.filter(t=>dueInstant(t.due)<start&&!t.completed)};
  }
  function GSubmitted(item,t){const d=item.nineGrid?.dimensions.find(d=>d.taskId===t.id);const any=nodes=>nodes.some(n=>n.review==='submitted'||any(n.children||[]));return d&&any(d.nodes);}
  function queues(user,C,W,now) {
    const rows=[],manager=isManager(user);for(const item of scopedData(store,user).analyses){if(item.status!=='active'||item.archived)continue;W.ensure(item);const current=STAGES.find(id=>!W.stageComplete(item,id))||'D8',index=STAGES.indexOf(current);
      for(const t of item.workflow.tasks.filter(t=>W.taskEnabled(item,t)&&(manager||STAGES.indexOf(t.stage)<=index||t.kind==='grid'||t.owner===user.id))){
        const base={analysisId:item.id,faultId:item.faultId,taskId:t.id,stage:t.stage,title:item.title,label:t.title,owner:t.owner,due:t.due,overdue:!!t.due&&dueInstant(t.due)<+now};
        if(t.kind==='production'&&!item.workflow.d8.production.productionAt){if(manager||t.owner===user.id)rows.push({...base,type:'waiting-production',label:'等待首次生产：'+t.title,overdue:false});continue;}
        if(t.kind==='grid'&&manager&&GSubmitted(item,t))rows.push({...base,type:'review',label:'九宫格结论待审核：'+t.title});
        if(manager&&(!t.owner||!t.due||!W.isQuantity(t)&&![1,2,3].includes(Number(t.base))))rows.push({...base,type:'unassigned'});
        else if(t.status==='submitted'&&(manager||t.owner===user.id)&&!(manager&&t.kind==='grid'))rows.push({...base,type:manager?'review':'submitted',overdue:manager&&base.overdue});
        else if(['draft','returned'].includes(t.status)&&t.owner===user.id)rows.push({...base,type:t.status==='returned'?'returned':'todo'});
      }
      if(manager){for(const issue of W.checklist(item,now.toISOString()).filter(i=>STAGES.indexOf(i.stage)<=index&&!i.taskId&&['missing','evidence','confirmation'].includes(i.type)))rows.push({analysisId:item.id,faultId:item.faultId,stage:issue.stage,taskId:issue.taskId||'',type:issue.type==='confirmation'?'stage-confirm':'missing',label:issue.label,owner:user.id,due:issue.due||'',overdue:issue.overdue});if(STAGES.every(id=>W.stageComplete(item,id))&&!C.closureError(item))rows.push({analysisId:item.id,stage:'D8',type:'close',label:'全部阶段已确认，可以关单',owner:user.id});}
    }
    for(const p of store.list('preliminaryAssignments').filter(p=>p.status!=='completed'&&p.userId===user.id))rows.push({faultId:p.faultId,taskId:'preliminary:'+p.id,stage:'初步分析',type:'todo',label:'报故初步失效分析',owner:user.id,due:p.due,overdue:dueInstant(p.due)<+now});
    const unique=new Set();for(let i=rows.length-1;i>=0;i--){const r=rows[i],key=[r.analysisId||r.faultId,r.stage,r.taskId,r.type,r.label].join('|');if(unique.has(key))rows.splice(i,1);else unique.add(key);}
    const counts={};for(const r of rows)counts[r.type]=(counts[r.type]||0)+1;return {rows,counts};
  }
  async function api(action,{user,body={},id}={}) {
    ensure(user&&enabled(user),'请先登录',401);const now=clock(),manager=isManager(user),{C,W,G,F}=engine(usersForEngine(),now,canReview(user)?user.id:'');
    if(action==='preliminary'||action==='assign')return preliminary(action,{user,body,id},now);
    if(action==='metrics'){const m=metrics(body,W,now);if(globalView(user))return m;m.departments=m.departments.filter(d=>d.department===user.dept);m.tasks=m.tasks.filter(t=>t.department===user.dept);m.backlog=m.backlog.filter(t=>t.department===user.dept);return m;}
    if(action==='queues')return queues(user,C,W,now);
    if(action==='create'){
      checkPermission(user,'analysis.start');const fault=store.get('faults',body.faultId);ensure(fault,'报故不存在',404);ensure(!store.list('analyses').some(x=>!x.archived&&x.faultId===fault.id),'该报故已纳入8D，请查看已有事项',409);
      let item;if(body.originalId){const source=store.get('analyses',body.originalId);ensure(source?.status==='closed','复发关联原8D须已关闭');item=W.createRecurrence(source,fault,C,dateStamp(now));}else item=C.createItem(fault,dateStamp(now));
      item.id='QA-'+randomUUID();item.owner=user.id;item.team=[{personId:user.id,role:'质量分析组织、分派与验收'}];item.tasks=[];item.revised.partNo=str(fault.partNo||fault.material);item.snapshot.partNo=str(fault.partNo||fault.material);item.approval={required:false,reviewer:'',status:'none',comment:''};item.history=[];item.preliminarySnapshot=clone(preliminaryFor(fault.id));item.createdAt=now.toISOString();item.stage='D1';W.ensure(item);for(const t of item.workflow.tasks)t.reviewer=user.id;
      if(body.mode==='nine-grid')G.init(item,W);
      if(item.workflow.d2.freeze){for(const t of item.workflow.tasks.filter(t=>t.kind==='freeze')){t.data.material=item.revised.partNo;t.data.sn=fault.sn||'';}}
      return persist(item,user,'从报故单开启8D，保留初步分析快照',undefined,C,W,now);
    }
    if(action==='get'){
      const item=requireRecord(store,user,'analyses',id);return decorate(item,C,W);
    }
    ensure(action==='command','操作无效');requireRecord(store,user,'analyses',id);const item=store.get('analyses',id);ensure(item,'分析事项不存在',404);const writePermissions={'patch-stage':'analysis.manage','sync-source':'analysis.manage','archive-analysis':'analysis.manage','add-task':'tasks.assign','remove-cause':'tasks.assign','delete-task':'tasks.assign','configure-d2':'analysis.manage','assign-freeze-number':'analysis.manage','grid-assign':'analysis.manage','enable-nine-grid':'analysis.manage','grid-review':'tasks.review','finish-stage':'tasks.review','close':'tasks.review','accept-task':'tasks.review','return-task':'tasks.review','confirm-quality':'tasks.review','score-transfer':'tasks.review','create-measure':'analysis.manage','create-experiment':'analysis.manage','link-measure':'analysis.manage','link-experiment':'analysis.manage','select-prevention':'analysis.manage','reopen-linked':'analysis.manage','reopen-task':'analysis.manage','cancel-experiment':'analysis.manage','repeat-verification':'analysis.manage','confirm-lessons':'analysis.manage','simulate-order':'analysis.manage','simulate-production':'analysis.manage'};if(writePermissions[body.action])checkPermission(user,writePermissions[body.action]);if(user.groupId&&['configure-d2','assign-freeze-number','grid-assign','add-task','create-measure','create-experiment','select-prevention'].includes(body.action))checkPermission(user,'tasks.assign');if(user.groupId&&body.action==='close')checkPermission(user,'analysis.close');if(user.groupId&&['save-task','submit-task','grid-save','grid-submit','grid-split','grid-add','grid-remove','save-d2-fill','save-freeze-number'].includes(body.action))checkPermission(user,'tasks.submit');
    if(!manager){
      if(['save-task','submit-task','verification-failed','transfer'].includes(body.action)){const task=item.workflow?.tasks?.find(t=>t.id===body.taskId);const configOnly=body.action==='save-task'&&hasPermission(user,'tasks.assign')&&Object.keys(body.patch||{}).every(k=>['title','scope','owner','reviewer','due','base','evidenceRequired','causeId','measureIds'].includes(k));ensure(task&&(task.owner===user.id||configOnly),'只能填写分派给自己的任务',403);}
      if(['grid-save','grid-submit','grid-split','grid-add','grid-remove'].includes(body.action)){const dimension=G.dimension(item,body.dimension),task=item.workflow?.tasks?.find(t=>t.id===dimension?.taskId);ensure(task&&task.owner===user.id,'只有被分派的责任人可以填写分析内容',403);}
      if(['save-d2-fill','save-freeze-number'].includes(body.action))ensure(d2Eligible(user)&&item.freezeAssignment?.owner===user.id,'仅被分派的变更管理员可以填写冻结编号和数量',403);
    }
    requireVersion(item,body.version);ensure(item.status==='active','该分析已关闭或待审批，不能直接修改');W.ensure(item);
    const originalOwner=item.owner;if(manager)item.owner=user.id;
    const command=body.action;let t=item.workflow.tasks.find(t=>t.id===body.taskId),newTaskId='';
    if(!manager){
      const output=['save-task','submit-task','verification-failed'].includes(command);
      const nodeOutput=['grid-save','grid-submit','grid-split','grid-add','grid-remove'].includes(command);
      const gridTask=nodeOutput?item.workflow.tasks.find(v=>v.id===G.dimension(item,body.dimension)?.taskId):null;
      if(output&&t?.owner===user.id||nodeOutput&&gridTask?.owner===user.id){
        const next=F.pending(item,user,W,G)[0];
        ensure(F.allowed(item,user,t?.id||gridTask.id,nodeOutput?body.nodeId:'',W,G),
          '请先完成当前任务：'+(next?.label||'等待质量工程师完成任务分派'),409);
      }
    }
    if(t?.kind==='d2-fill')fail('请通过D2统一填报窗口操作',403);
    const own=()=>{validateTaskActor(item,t,user,manager);ensure(t.owner===user.id,'请由分派的责任人提交成果',403);};
    const management=()=>checkPermission(user,'analysis.manage');
    const checkEngine=result=>{if(typeof result==='string'&&result)fail(result);if(result?.error)fail(result.error);if(result?.task)newTaskId=result.task.id;return result;};
    if(command==='grid-review')checkPermission(user,'tasks.review');
    if(t?.gridRoot||t?.kind==='grid'&&!['transfer','score-transfer'].includes(command))fail('九宫格分析须通过节点提交与审核接口处理',403);
    if(command.startsWith('grid-')||command==='enable-nine-grid'){gridCommand(item,body,user,{G,W,manager,files,links,userBy,addMember,now});invalidate(item,command==='grid-assign'?'D1':'D4');item.owner=originalOwner;return persist(item,user,'九宫格：'+command,body.version,C,W,now,{taskId:G.dimension(item,body.dimension)?.taskId,nodeId:body.nodeId,dimension:body.dimension});}
    if(command==='configure-d2'){
      management();checkPermission(user,'tasks.assign');const owner=userBy(body.owner);
      ensure(d2Eligible(owner)&&enabled(owner),'请选择启用的变更管理员');ensure(dateValid(body.due),'请选择有效完成期限');
      for(const key of ['major','batch','freeze'])ensure(typeof body[key]==='boolean','问题分类与冻结选项无效');
      const d=item.workflow.d2;let task=item.workflow.tasks.find(t=>t.id===d.fillTaskId&&t.kind==='d2-fill');
      const changed=!task||task.owner!==owner.id||task.due!==body.due||d.freeze!==body.freeze;
      if(!task){task=W.newTask('D2','d2-fill','冻结编号与生产、发货数量填报');task.evidenceRequired=false;task.data={productionQty:'',shippedQty:'',freezeNumber:'',sn:item.snapshot.sn||'',material:item.revised.partNo||item.snapshot.material||'',unit:'pcs'};item.workflow.tasks.push(task);d.fillTaskId=task.id;}
      if(changed){task.assignmentHistory||=[];task.assignmentHistory.push({from:task.owner,to:owner.id,oldDue:task.due,due:body.due,by:user.id,at:now.toISOString()});task.status='draft';task.acceptedAt='';task.assignedAt=now.toISOString();}
      Object.assign(task,{owner:owner.id,due:body.due,reviewer:'',base:null,evidenceRequired:false});
      Object.assign(d,{unified:true,major:body.major,batch:body.batch,freeze:body.freeze,reproductionDescription:str(body.reproductionDescription).slice(0,12000)});
      item.freezeAssignment={...(item.freezeAssignment||{}),owner:owner.id,due:body.due,status:task.status==='accepted'?'completed':'draft',taskId:task.id,history:[...(item.freezeAssignment?.history||[]),stamp(user,'保存D2分类并分派冻结编号及数量填报',now)]};
      addMember(item,owner.id,'填写冻结编号、SN生产数量及料号发货数量');taskSnapshot(item,task,now);invalidate(item,'D2');item.owner=originalOwner;
      return persist(item,user,'D2设置与分派已保存，等待变更管理员填报',body.version,C,W,now,{taskId:task.id});
    }
    if(command==='save-d2-fill'){checkPermission(user,'freeze.number.write');
      const d=item.workflow.d2,task=item.workflow.tasks.find(t=>t.id===d.fillTaskId&&t.kind==='d2-fill');
      ensure(d.unified&&task,'请先由质量工程师完成D2分派');ensure(d2Eligible(user)&&enabled(user)&&task.owner===user.id,'仅被分派的变更管理员可以填写冻结编号和数量',403);
      ensure(['draft','returned','accepted'].includes(task.status),'此填报当前不可修改');
      const data=body.data;cleanObject(data);ensure(Object.keys(data).every(k=>['freezeNumber','productionQty','shippedQty'].includes(k)),'填报字段无效');
      const next={...task.data};for(const key of ['productionQty','shippedQty'])if(Object.hasOwn(data,key)){const v=str(data[key]);ensure(v===''||/^\d+$/.test(v)&&Number.isSafeInteger(Number(v)), '数量须为非负整数（未知留空，无则填0）');next[key]=v===''?'':Number(v);}
      if(Object.hasOwn(data,'freezeNumber')){ensure(str(data.freezeNumber).length<=100,'冻结编号最多100字');next.freezeNumber=str(data.freezeNumber);}
      const correcting=task.status==='accepted';
      if(correcting&&JSON.stringify(next)===JSON.stringify(task.data))return decorate(item,C,W);
      if(correcting){task.status='draft';task.submittedAt='';task.acceptedAt='';task.acceptedBy='';task.completedAt='';task.completedDept='';Object.assign(item.freezeAssignment,{status:'draft',completedAt:''});}
      task.data=next;
      if(body.submit){checkEngine(W.submitTask(item,task.id,now.toISOString()));taskSnapshot(item,task,now);if(d.freeze)d.freezeNumber=next.freezeNumber;Object.assign(item.freezeAssignment,{status:'completed',completedAt:now.toISOString()});}
      item.freezeAssignment.history||=[];item.freezeAssignment.history.push(stamp(user,body.submit?(correcting?'更正冻结编号与数量并完成，保留原提交记录':'提交冻结编号与数量并完成'):'保存冻结编号与数量草稿',now));invalidate(item,'D2');item.owner=originalOwner;
      return persist(item,user,body.submit?'变更管理员完成D2填报（免验收、不计分）':'保存D2填报草稿',body.version,C,W,now,{taskId:task.id});
    }
    if(command==='assign-freeze-number'){ensure(!item.workflow.d2.unified,'请通过D2统一窗口调整分派');management();const owner=userBy(body.owner);ensure(d2Eligible(owner)&&owner.enabled!==false,'请选择变更管理员');ensure(dateValid(body.due),'请选择冻结编号完成期限');item.freezeAssignment={owner:owner.id,due:body.due,status:'draft',history:[...(item.freezeAssignment?.history||[]),stamp(user,'分派冻结编号填写',now)]};addMember(item,owner.id,'填写冻结编号');item.owner=originalOwner;return persist(item,user,'分派冻结编号',body.version,C,W,now);}
    if(command==='save-freeze-number'){ensure(!item.workflow.d2.unified,'请在D2统一窗口同时填写编号和数量');ensure(d2Eligible(user)&&item.freezeAssignment?.owner===user.id,'只能填写分派给自己的冻结编号',403);ensure(str(body.number)&&str(body.number).length<=100,'请填写有效冻结编号');item.workflow.d2.freezeNumber=str(body.number);item.freezeAssignment.status='completed';item.freezeAssignment.completedAt=now.toISOString();item.freezeAssignment.history.push(stamp(user,'提交冻结编号',now));item.owner=originalOwner;return persist(item,user,'提交冻结编号',body.version,C,W,now);}
    ensure(user.role!=='freeze-clerk'&&user.role!=='viewer','此账号无此写入权限',403);
    switch(command){
      case 'archive-analysis':management();ensure(str(body.reason),'请填写移除原因');item.archived=true;item.archivedAt=now.toISOString();item.archivedBy=user.id;item.archiveReason=str(body.reason);break;
      case 'patch-stage':patchStage(item,body,user,C,W,now,originalOwner);break;
      case 'sync-source':{
        management();const latest=store.get('faults',item.faultId);ensure(latest,'原报故单不存在',404);const prior=clone(item.snapshot),priorRevised=clone(item.revised),next={...clone(latest),partNo:str(latest.partNo||latest.material)};
        for(const key of Object.keys(item.revised))if(next[key]===undefined)next[key]='';
        C.syncSource(item,next);if(next.quantity===null&&String(priorRevised.quantity)===String(prior.quantity))item.revised.quantity='';
        for(const key of ['description','condition'])if(!str(item.stages.D2.fields[key])||String(item.stages.D2.fields[key])===String(prior[key]??''))item.stages.D2.fields[key]=str(item.revised[key]);
        const oldImpact='报故涉及 '+prior.quantity+' 件，影响范围待确认';if(item.stages.D2.fields.impact===oldImpact)item.stages.D2.fields.impact=next.quantity===null?'报故涉及数量待确认':'报故涉及 '+next.quantity+' 件，影响范围待确认';
        item.sourceSyncHistory ||= [];item.sourceSyncHistory.push({at:now.toISOString(),by:user.id,previousSnapshot:prior,sourceVersion:latest.version,previousRevised:priorRevised});item.sourceUpdateAvailable=false;if(!item.stages.D1.done)item.stage='D1';break;
      }
      case 'save-task':patchTask(item,t,body.patch||{},user,manager,C,W,now);break;
      case 'submit-task':own();validateReferences(item,t);checkEngine(W.submitTask(item,t.id,now.toISOString()));taskSnapshot(item,t,now);break;
      case 'accept-task':checkPermission(user,'tasks.review');ensure(t,'任务不存在',404);for(const k of ['initiative','evidenceScore','ratingReason'])if(Object.hasOwn(body,k))t[k]=k==='ratingReason'?str(body[k]):Number(body[k]);checkEngine(W.acceptTask(item,t.id,user.id,now.toISOString()));taskSnapshot(item,t,now);break;
      case 'return-task':checkPermission(user,'tasks.review');checkEngine(W.returnTask(item,t?.id,user.id,body.reason,now.toISOString()));break;
      case 'confirm-quality':checkPermission(user,'tasks.review');ensure(t,'任务不存在',404);for(const k of ['initiative','evidenceScore','ratingReason'])if(Object.hasOwn(body,k))t[k]=k==='ratingReason'?str(body[k]):Number(body[k]);checkEngine(W.confirmQualityTask(item,t.id,user.id,now.toISOString()));taskSnapshot(item,t,now);break;
      case 'add-task':{
        checkPermission(user,'tasks.assign');ensure(STAGES.includes(body.stage),'任务阶段无效');ensure(['general','sn','freeze','cause','horizontal','production'].includes(body.kind),'请使用对应功能建立此类任务');
        if(body.kind==='sn')ensure(!item.workflow.tasks.some(t=>t.kind==='sn'&&W.taskEnabled(item,t)),'只能保留一项当前SN数量确认');
        const next=W.newTask(body.stage,body.kind,str(body.title)||'协作任务');if(body.kind==='cause'){ensure(body.stage==='D4'&&['occurrence','escape','escapeDept'].includes(body.section),'原因分区无效');next.data.section=body.section;}next.reviewer=user.id;item.workflow.tasks.push(next);if(body.kind==='sn')item.workflow.d2.primarySnId=next.id;newTaskId=next.id;invalidate(item,body.stage);break;}
      case 'remove-cause':
      case 'delete-task':{
        checkPermission(user,'tasks.assign');ensure(t&&!t.archived,'任务不存在或已移除',404);ensure(t.status!=='submitted','请先退回待验收任务，再调整或移除人员');
        if(t.kind==='cause'){
          ensure(['occurrence','escape'].includes(t.data.section),'责任部门确认记录不能移除');ensure(!item.workflow.tasks.some(m=>m.kind==='measure'&&!m.archived&&m.causeId===t.id),'此原因已关联永久措施，不能移除');
          const same=item.workflow.tasks.filter(v=>v.kind==='cause'&&v.data.section===t.data.section&&!v.archived);
          if(t.id===item.workflow.d4.occurrenceTaskId||same.length<=1){ensure(['draft','returned'].includes(t.status),'至少保留一条本类原因；已确认内容不能直接清空');t.assignmentHistory ||= [];t.assignmentHistory.push({from:t.owner,to:'',at:now.toISOString(),by:user.id,reason:str(body.reason)||'移除分析人员，保留必需原因项目及已有内容'});t.owner='';t.transferEvaluation=null;invalidate(item,t.stage);break;}
        }else ensure(t.kind==='general','此为固定流程任务，请使用对应设置取消或调整');
        t.archived=true;t.archivedAt=now.toISOString();t.archivedBy=user.id;t.archiveReason=str(body.reason)||'质量工程师移除协作任务，原记录与已获积分保留';invalidate(item,t.stage);break;
      }
      case 'create-measure':management();checkEngine(W.createMeasure(item,body.causeId,user.id));break;
      case 'create-experiment':management();checkEngine(W.createExperiment(item,body.measureIds,user.id));break;
      case 'link-measure':management();checkEngine(W.linkMeasure(item,t?.id,body.causeId??t?.causeId,user.id));break;
      case 'link-experiment':management();checkEngine(W.linkExperiment(item,t?.id,body.measureIds??t?.measureIds,user.id));break;
      case 'cancel-experiment':management();checkEngine(W.cancelExperiment(item,t?.id,user.id,body.reason,now.toISOString()));break;
      case 'repeat-verification':management();checkEngine(W.repeatVerification(item,t?.id,user.id,now.toISOString()));break;
      case 'select-prevention':management();checkEngine(W.selectPrevention(item,body.key,!!body.selected,user.id));invalidate(item,'D7');break;
      case 'reopen-linked':management();checkEngine(W.reopenLinkedTask(item,t?.id,user.id));if(t){t.transferEvaluation=null;invalidate(item,t.stage);}break;
      case 'reopen-task':management();ensure(t&&['submitted','accepted'].includes(t.status),'只能重新编辑已提交任务');ensure(str(body.reason),'请填写重新编辑原因');t.status='returned';t.returnReason=str(body.reason);t.acceptedAt='';t.transferEvaluation=null;invalidate(item,t.stage);break;
      case 'confirm-lessons':management();{const lesson=item.workflow.tasks.find(t=>W.isLesson(t)&&W.taskEnabled(item,t));ensure(lesson?.status==='accepted'&&W.currentSubmission(lesson),'请先验收经验教训任务');item.workflow.d8.lessons.confirmed=true;}break;
      case 'simulate-order':management();checkEngine(W.simulateOrder(item,body.order||{},now.toISOString()));break;
      case 'simulate-production':management();checkEngine(W.simulateProduction(item,body.orderId||item.workflow.d8.production.orderId,now.toISOString()));break;
      case 'verification-failed':{
        own();ensure(t.kind==='verification','请选择实验任务');ensure(str(t.result)&&(!W.evidenceRequired(t)||W.evidencePresent(t)),'请先填写失败结果和证据');const target=body.target==='D5'?'D5':'D4';t.data.decision='未通过';t.submissions.push({at:now.toISOString(),status:'failed',result:t.result,data:clone(t.data),files:clone(t.files),links:clone(t.links)});item.stage=target;invalidate(item,target);break;}
      case 'transfer':{
        checkPermission(user,'tasks.transfer');ensure(t&&t.owner===user.id,'只能转交自己负责的任务',403);ensure(['draft','returned'].includes(t.status)&&W.taskEnabled(item,t),'只能转交未提交的有效任务');const target=userBy(body.to);ensure(enabled(target)&&target.id!==user.id&&!['viewer','freeze-clerk'].includes(target.role),'请选择其他启用的执行账号');ensure(str(body.reason),'请填写转交原因');t.transfers ||= [];t.transfers.push({from:user.id,to:target.id,fromName:user.name,toName:target.name,fromDept:t.reportingDept||user.dept,toDept:target.dept,at:now.toISOString(),reason:str(body.reason),snapshot:{result:t.result,data:clone(t.data||{}),files:clone(t.files||[]),links:clone(t.links||[])}});addMember(item,target.id,'任务协作：'+t.title);t.owner=target.id;t.reportingDept=target.dept||'未设置部门';t.transferEvaluation=null;invalidate(item,t.stage);break;}
      case 'score-transfer':{
        management();ensure(t?.transfers?.length,'此任务没有转交记录');const total=W.taskPoints(t);ensure(total!==null,'请先完成任务验收再评定转交贡献');ensure(str(body.reason),'请填写双方实际贡献及评分依据');ensure(Array.isArray(body.allocations)&&body.allocations.length,'请填写贡献分配');const participants=new Set([t.owner,...t.transfers.flatMap(t=>[t.from,t.to])]),seen=new Set();let sum=0;const allocations=body.allocations.map(a=>{ensure(participants.has(a.personId)&&!seen.has(a.personId),'评分成员无效或重复');seen.add(a.personId);const points=Number(a.points);ensure(Number.isFinite(points)&&points>=0,'贡献积分须为非负数');sum+=points;return {personId:a.personId,points};});ensure(Math.abs(sum-total)<1e-6,'双方积分合计须等于该任务最终积分 '+total);t.transferEvaluation={confirmed:true,total,allocations,reason:str(body.reason),by:user.id,at:now.toISOString()};break;}
      case 'finish-stage':{
        checkPermission(user,'tasks.review');ensure(STAGES.includes(body.stage),'阶段无效');const index=STAGES.indexOf(body.stage);ensure(STAGES.slice(0,index).every(id=>W.stageComplete(item,id)),'请先确认前面的阶段');const error=C.validateStage(item,body.stage);if(error)fail(error);if(body.stage==='D8')for(const task of item.workflow.tasks.filter(t=>W.taskEnabled(item,t)&&t.transfers?.length&&!W.isQuantity(t)))ensure(task.transferEvaluation?.confirmed,'转交任务的贡献积分待质量工程师评定');item.stages[body.stage].done=true;item.stage=STAGES[Math.min(index+1,7)];break;}
      case 'close':{
        checkPermission(user,'tasks.review');item.approval={required:false,reviewer:'',status:'approved',comment:str(body.comment),confirmedBy:user.id};const error=C.closureError(item);if(error)fail(error);for(const task of item.workflow.tasks.filter(t=>W.taskEnabled(item,t)&&t.transfers?.length&&!W.isQuantity(t)))ensure(task.transferEvaluation?.confirmed,'转交任务的贡献积分尚未确认');item.status='closed';item.closedAt=now.toISOString();item.closedBy=user.id;item.preliminaryStartSnapshot=clone(item.preliminarySnapshot||[]);item.preliminarySnapshot=clone(preliminaryFor(item.faultId));item.preliminaryClosureSnapshot=clone(item.preliminarySnapshot);item.peopleSnapshot=allUsers().map(u=>({id:u.id,name:u.name,dept:u.dept||''}));item.finalContributions=clone(C.contribution(item));item.pdf={status:'pending',requestedAt:now.toISOString()};item.closeSnapshot=clone(item);break;}
      default:fail('不支持的任务操作：'+command);
    }
    if(newTaskId){const added=item.workflow.tasks.find(t=>t.id===newTaskId);if(added&&!added.reviewer)added.reviewer=user.id;}
    item.owner=originalOwner;
    const saved=persist(item,user,'8D操作：'+command,body.version,C,W,now,{taskId:body.taskId||newTaskId||undefined});
    if(command==='close'){try{await onClosed(clone(saved));}catch(e){const current=store.get('analyses',id);store.put('analyses',id,{...current,pdf:{status:'failed',error:'PDF生成失败，请重试',requestedAt:now.toISOString()}},{expectedVersion:current.version,actor:user.id,event:'PDF生成失败'});}return decorate(store.get('analyses',id),C,W);}
    if(newTaskId)saved.newTaskId=newTaskId;return saved;
  }
  return {api,engine:()=>engine(usersForEngine(),clock()),metricTasks:()=>metricTasks(engine(usersForEngine(),clock()).W)};
}
