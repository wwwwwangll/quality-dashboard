import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync,backup as sqliteBackup} from 'node:sqlite';
import {appError} from './store.mjs';
import {createWorkflowService} from './workflow.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const day=(at=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
const clean=s=>String(s||'').slice(0,500);
function walk(dir){if(!fs.existsSync(dir))return [];return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isSymbolicLink()?[]:e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
export function createSystemService({store,fileRoot=store.fileRoot}){
 let timer,backing;
 const workflow=createWorkflowService({store,fileRoot});
 function settings(){const s=store.get('settings','system')||{};return {...s,notifications:{mode:'mock',enabled:false,dueSoonHours:24,overdueHour:10,groups:[],...(s.notifications||{}),mode:'mock'},backup:{retentionDays:30,...s.backup}};}
 function assertAdmin(user){if(user?.role!=='admin')throw appError('仅管理员可以执行系统操作',403);}
 function rootBackup(){const configured=settings().backup?.target;return configured?path.resolve(configured):path.join(store.dataDir,'backups');}
 async function backup(user={id:'system'},reason='每日备份'){
  if(backing)return backing;
  backing=(async()=>{const root=rootBackup();fs.mkdirSync(root,{recursive:true});const id=day()+'-'+Date.now()+'-'+randomUUID().slice(0,8),target=path.join(root,id);fs.mkdirSync(target);
   try{await sqliteBackup(store.db,path.join(target,'quality.sqlite'));const entries=[];
    for(const source of walk(fileRoot)){const relative=path.relative(fileRoot,source),dest=path.join(target,'attachments',relative);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(source,dest);entries.push({path:path.join('attachments',relative).replaceAll('\\','/'),size:fs.statSync(dest).size,sha256:digest(fs.readFileSync(dest))});}
    const dbfile=path.join(target,'quality.sqlite');entries.unshift({path:'quality.sqlite',size:fs.statSync(dbfile).size,sha256:digest(fs.readFileSync(dbfile))});const checkDb=new DatabaseSync(dbfile,{readOnly:true});let counts;try{counts=checkDb.prepare('SELECT kind,count(*) count FROM records GROUP BY kind').all();}finally{checkDb.close();}
    const manifest={format:'quality-backup-v1',id,environment:store.environment,createdAt:new Date().toISOString(),reason,counts,entries};fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2));
    const verification=verify(id);store.put('backups',id,{id,status:verification.ok?'ready':'failed',createdAt:manifest.createdAt,reason,fileCount:entries.length,verification});store.audit(user,'backup.created',{id,ok:verification.ok});
    for(const e of fs.readdirSync(root,{withFileTypes:true})){if(!e.isDirectory())continue;const p=path.resolve(root,e.name);if(p===path.resolve(target)||!p.startsWith(path.resolve(root)+path.sep))continue;const m=path.join(p,'manifest.json');if(!fs.existsSync(m))continue;let old;try{old=JSON.parse(fs.readFileSync(m));}catch{continue;}if(old.format==='quality-backup-v1'&&Date.now()-Date.parse(old.createdAt)>(settings().backup.retentionDays||30)*86400000)fs.rmSync(p,{recursive:true});}
    return {id,status:verification.ok?'ready':'failed',verification};
   }catch(e){store.put('backups',id,{id,status:'failed',createdAt:new Date().toISOString(),error:clean(e.message)});throw e;}finally{backing=null;}})();return backing;
 }
 function verify(id){if(!/^[\w-]+$/.test(id||''))throw appError('备份编号无效');const root=rootBackup(),source=path.resolve(root,id);if(!source.startsWith(path.resolve(root)+path.sep))throw appError('备份路径无效');const mf=path.join(source,'manifest.json');if(!fs.existsSync(mf))throw appError('备份不存在',404);const m=JSON.parse(fs.readFileSync(mf));if(m.environment!==store.environment)throw appError('禁止混用测试和正式备份',403);const failures=[];
  for(const e of m.entries||[]){const p=path.resolve(source,e.path);if(!p.startsWith(source+path.sep)||!fs.existsSync(p)||digest(fs.readFileSync(p))!==e.sha256)failures.push(e.path);}
  if(failures.length)return {ok:false,failures};const restore=path.join(store.dataDir,'restore-check',id+'-'+Date.now());fs.mkdirSync(restore,{recursive:true});fs.copyFileSync(path.join(source,'quality.sqlite'),path.join(restore,'quality.sqlite'));const db=new DatabaseSync(path.join(restore,'quality.sqlite'),{readOnly:true});let integrity,counts;try{integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;counts=db.prepare('SELECT kind,count(*) count FROM records GROUP BY kind').all();}finally{db.close();}
  for(const e of m.entries.filter(e=>e.path!=='quality.sqlite')){const dest=path.resolve(restore,e.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.resolve(source,e.path),dest);if(digest(fs.readFileSync(dest))!==e.sha256)failures.push(e.path);}
  if(JSON.stringify(counts)!==JSON.stringify(m.counts))failures.push('数据库记录数量不符');
  return {ok:integrity==='ok'&&!failures.length,integrity,fileCount:m.entries.length,counts,failures,restoredTo:restore};
 }
 function notificationPreview(at=new Date()){
  const options=settings().notifications,now=+new Date(at),out=[],users=new Map(store.list('users').map(u=>[u.id,u])),W=workflow.engine().W;
  const add=(record,t,route)=>{
   if(!t.owner||!t.due)return;const due=Date.parse(t.due.includes('T')?t.due:t.due+'T23:59:59.999+08:00'),delta=due-now;
   if(!Number.isFinite(due)||delta>Number(options.dueSoonHours??24)*3600000)return;const type=delta<0?'overdue':'due-soon',u=users.get(t.owner);if(!u||u.enabled===false)return;
   const group=(options.groups||[]).find(g=>g.department===u.dept)||(options.groups||[]).find(g=>!g.department||g.department==='*')||{name:options.groupName||'未配置群组'};
   const key=digest([record.id,t.id,t.due,t.owner,type,day(new Date(now))].join('|')),days=Math.max(0,Math.ceil(-delta/86400000));
   const text=`${type==='overdue'?'任务超期':'任务即将到期'}\n事项：${record.id} ${record.title||''}\n任务：${t.title}\n责任人：${u.name}\n截止：${t.due}${days?'\n超期：'+days+'天':''}\n处理入口：${options.baseUrl||(store.environment==='production'?'http://127.0.0.1:3869':'http://127.0.0.1:3868')}/${route}`;
   out.push({id:key,...(record.analysisId?{analysisId:record.analysisId}:{}),faultId:record.faultId,taskId:t.id,owner:t.owner,department:u.dept,type,due:t.due,overdueDays:days,group:group.name||'未配置群组',missingGroup:!group.name||group.name==='未配置群组',missingMapping:!u.wecomUserId,payload:{msgtype:'text',text:{content:text,mentioned_list:u.wecomUserId?[u.wecomUserId]:[]}},status:'mock',mock:true});
  };
  for(const source of store.list('analyses').filter(x=>x.status==='active'&&!x.archived)){
   const item=JSON.parse(JSON.stringify(source));try{W.ensure(item);}catch{continue;}
   for(const t of item.workflow.tasks){
    if(!['draft','returned'].includes(t.status)||!W.taskEnabled(item,t)||t.stage>item.stage)continue;
    if(t.kind==='production'&&!item.workflow.d8.production.productionAt)continue;
    add({id:item.id,analysisId:item.id,faultId:item.faultId,title:item.title},t,'#analysis/'+encodeURIComponent(item.id)+'/'+encodeURIComponent(t.id));
   }
  }
  for(const assignment of store.list('preliminaryAssignments').filter(p=>p.status==='assigned')){
   const fault=store.get('faults',assignment.faultId);if(!fault)continue;
   add({id:'preliminary:'+assignment.id,faultId:fault.id,title:fault.product||fault.model||'报故初步分析'},{id:'preliminary:'+assignment.id,owner:assignment.userId,due:assignment.due,title:'报故初步失效分析'},'#fault/'+encodeURIComponent(fault.id));
  }
  return out;
 }
 function runNotifications(user,{at=new Date(),scheduled=false}={}){
  const options=settings().notifications,hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(at));
  const planned=notificationPreview(at).filter(m=>!scheduled||m.type!=='overdue'||hour>=Number(options.overdueHour??10));let created=0;
  for(const m of planned)if(!store.get('outbox',m.id)){store.put('outbox',m.id,{...m,createdAt:new Date(at).toISOString(),result:'模拟记录，未调用企业微信；缺少映射时不能实现真实@'});created++;}
  store.audit(user||'system','notifications.mock',{created,scheduled});return {mode:'mock',created,total:planned.length,messages:planned};
 }
 function migratePreview(body){const bundle=body.bundle||body;if(!Array.isArray(bundle.analyses)&&!Array.isArray(bundle.items)&&!Array.isArray(bundle.faults))throw appError('请上传包含analyses/items、faults及可选files的迁移包');const analyses=bundle.analyses||bundle.items||[],faults=bundle.faults||[],claims=bundle.claims||[],files=bundle.files||[];if(analyses.length+faults.length+claims.length>50000)throw appError('单次迁移记录过多');const missingFiles=[];function scan(v){if(!v||typeof v!=='object')return;if(Array.isArray(v.files))for(const f of v.files)if(f?.id&&!files.some(x=>x.id===f.id)&&!store.get('files',f.id))missingFiles.push(f.id);for(const[k,x]of Object.entries(v))if(k!=='files'&&typeof x==='object')Array.isArray(x)?x.forEach(scan):scan(x);}analyses.forEach(scan);const conflicts=[...analyses.filter(x=>store.get('analyses',x.id)).map(x=>x.id),...faults.filter(x=>store.get('faults',x.id)).map(x=>x.id)];const id=randomUUID();store.put('migration',id,{analyses,faults,claims,files,createdAt:new Date().toISOString()});return {id,counts:{analyses:analyses.length,faults:faults.length,claims:claims.length,files:files.length},conflicts,missingFiles:[...new Set(missingFiles)],requiresPeopleMapping:true};}
 function migrateCommit(user,body){const p=store.get('migration',body.id);if(!p)throw appError('迁移预览不存在');if(p.committed)return p.result;const map=body.peopleMap||{},existing=new Set(store.list('users').map(u=>u.id));for(const id of Object.values(map))if(!existing.has(id))throw appError('人员映射包含不存在的账号');
  const personKeys=new Set(['owner','reviewer','personId','authorId','acceptedBy','submittedBy','actorId','assignedBy','confirmedBy','closedBy','by','from','to']);function remap(v){if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){if(k==='legacyOriginal')continue;if(['allocations','bonuses'].includes(k)&&x&&typeof x==='object'&&!Array.isArray(x)){v[k]=Object.fromEntries(Object.entries(x).map(([id,score])=>[map[id]||id,score]));Object.values(v[k]).forEach(remap);}else if(personKeys.has(k)&&typeof x==='string'&&map[x])v[k]=map[x];else if(typeof x==='object')Array.isArray(x)?x.forEach(remap):remap(x);}}
  const result={added:0,skipped:0,missingFiles:[]};for(const f of p.files||[]){if(!/^[\w.-]+$/.test(f.id||'')||f.id.startsWith('.'))throw appError('迁移附件编号无效');if(store.get('files',f.id))continue;if(!f.base64){result.missingFiles.push(f.id);continue;}const bytes=Buffer.from(f.base64,'base64');if(bytes.length>10*1024*1024)throw appError('迁移附件超过10MB');const hash=digest(bytes);if(f.sha256&&f.sha256!==hash)throw appError('迁移附件校验失败');fs.writeFileSync(path.join(fileRoot,f.id),bytes,{flag:'wx'});const m={...f,size:bytes.length,sha256:hash,uploadedBy:user.id};delete m.base64;store.put('files',f.id,m);}
  for(const[kind,rows]of [['faults',p.faults],['claims',p.claims],['analyses',p.analyses]])for(const source of rows||[]){if(!source.id||store.get(kind,source.id)){result.skipped++;continue;}const row=JSON.parse(JSON.stringify(source));row.legacyOriginal=JSON.parse(JSON.stringify(source));remap(row);row.migratedAt=new Date().toISOString();row.migratedBy=user.id;if(kind==='analyses'){row.history=[...(row.history||[]),{at:new Date().toISOString(),actor:user.name,text:'管理员手动迁移，原内容及人员映射留存'}];row.unmappedPeople=[...new Set([row.owner,...(row.team||[]).map(m=>m.personId)].filter(id=>id&&!existing.has(id)))];}store.put(kind,row.id,row);result.added++;}
  store.put('migration',p.id,{...p,committed:true,result});store.audit(user,'migration.commit',result);return result;
 }
 async function api(action,{user,body={}}){assertAdmin(user);if(action==='backup')return backup(user,body.reason||'管理员手动备份');if(action==='verify-backup')return verify(body.id||store.list('backups').filter(x=>x.status==='ready').at(-1)?.id);if(action==='notifications-preview')return {mode:'mock',messages:notificationPreview()};if(action==='notifications-run')return runNotifications(user);if(action==='migrate-preview')return migratePreview(body);if(action==='migrate-commit')return migrateCommit(user,body);if(action==='settings'){const previous=settings(),next=body.settings||body;delete next.action;if(next.notifications?.mode&&next.notifications.mode!=='mock')throw appError('本测试版仅模拟发送，真实通道由公司IT按接入说明部署');const result={...previous,...next,notifications:{...previous.notifications,...next.notifications,mode:'mock'}};if(result.backup.retentionDays<1||result.backup.retentionDays>3650)throw appError('备份保留天数须为1至3650');store.put('settings','system',result,{actor:user,event:'settings.update'});return settings();}if(action==='overview')return {settings:settings(),backups:store.list('backups'),outbox:store.list('outbox').slice(-100)};throw appError('未知系统操作');}
 async function tick(){try{const last=store.list('backups').filter(x=>x.status==='ready').at(-1);if(!last||day(new Date(last.createdAt))!==day())await backup({id:'system'},'每日自动备份／启动补做');if(settings().notifications.enabled)runNotifications({id:'system'},{scheduled:true});}catch(e){store.audit('system','scheduler.failed',{message:clean(e.message)});}}
 return {api,backup,verify,notificationPreview,runNotifications,settings,start(){if(timer)return;void tick();timer=setInterval(()=>void tick(),60*1000);timer.unref();},async stop(){clearInterval(timer);timer=null;if(backing)await backing.catch(()=>{});}};
}
