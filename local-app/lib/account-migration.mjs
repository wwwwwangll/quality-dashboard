import fs from 'node:fs';
import path from 'node:path';
import {hashPassword} from './auth.mjs';
import {appError} from './store.mjs';
import {groupTemplates,testProfiles,obsoleteAccounts,initialTestPassword,passwordTable} from './group-policy.mjs';

export function deleteLogin(store,id,actor='system',{transaction=true}={}){
 const old=store.get('users',id);if(!old)return;
 if(old.role==='admin'&&store.list('users').filter(u=>u.role==='admin'&&u.enabled!==false).length<=1)throw appError('不能删除最后一个启用管理员');
 const remove=()=>{
  store.put('historicalPeople',id,{name:old.name,username:old.username,dept:old.dept||'',deletedAt:new Date().toISOString(),enabled:false,historical:true},{actor,event:'user.identity.preserve'});
  for(const item of store.list('analyses').filter(a=>a.status!=='closed')){
   let changed=false;
   for(const task of item.workflow?.tasks||[]){if(task.archived||['accepted','completed','cancelled'].includes(task.status))continue;
    for(const key of ['owner','reviewer'])if(task[key]===id){task[key]='';task.reassignmentRequired=true;task.reassignmentFrom=id;if(task.status==='submitted'){task.status='returned';task.returnReason='负责人账号已删除，等待质量人员重新分派，原提交记录保留。';}changed=true;}
   }
   if(item.freezeAssignment?.owner===id&&item.freezeAssignment.status!=='completed'){item.freezeAssignment.owner='';changed=true;}
   for(const d of item.nineGrid?.dimensions||[])if(d.owner===id){d.owner='';changed=true;}
   if(item.owner===id){item.owner=store.list('users').find(u=>u.id!==id&&u.enabled!==false&&(u.groupId==='quality'||u.role==='admin'))?.id||'';changed=true;}
   if(changed){item.history ||= [];item.history.push({at:new Date().toISOString(),actor:'系统',text:`账号 ${old.name} 已删除，未完成任务等待重新分派；原始记录保留。`});store.put('analyses',item.id,item,{actor,event:'user.delete.reassignment'});}
  }
  store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);store.remove('users',id,{actor,event:'user.delete'});
 };if(transaction)store.transaction(remove);else remove();
}
export async function migrateTestAccounts(store,{writeCredentials=true,fresh=false}={}){
 if(store.environment!=='test')throw Error('固定测试账号禁止写入正式环境');
 if(store.get('settings','accounts-v43'))return {migrated:false};
 // Password derivation is deliberately outside the synchronous transaction.
 const prepared=[];for(const p of testProfiles)prepared.push({p,hash:await hashPassword(initialTestPassword(p[0]))});
 store.transaction(()=>{
  for(const [id,name,permissions]of groupTemplates)store.put('groups',id,{name,permissions,builtin:true},{event:'group.install'});
  for(const {p:[username,name,role,dept,groupId],hash}of prepared){const old=store.list('users').find(u=>u.username===username),id=old?.id||username;store.put('users',id,{...old,username,name,role,dept,groupId,permissionOverrides:{},permissions:role==='admin'?['*']:[],enabled:true,archived:false,d2FillEligible:username==='change',passwordHash:hash,mustChangePassword:false,synthetic:true},{event:'test.account.profile43'});}
  // On new fake-data installs, retain the useful example assignments under the
  // new profiles. On existing installs, deleted owners require reassignment.
  if(fresh){const remap={quality:'cqe',project:'intelligence_project',intelligence:'intelligence_struct',electric:'electric_hw',intelligence_system:'system1',electric_system:'system2',changsha_system:'system1'};
   const visit=o=>{if(!o||typeof o!=='object')return;for(const [k,v]of Object.entries(o)){if(['owner','reviewer','personId'].includes(k)&&remap[v])o[k]=remap[v];else if(v&&typeof v==='object')visit(v);}};
   for(const a of store.list('analyses').filter(a=>a.status!=='closed')){visit(a);store.put('analyses',a.id,a);}
  }
  store.db.prepare('DELETE FROM sessions').run();
  for(const username of obsoleteAccounts){const u=store.list('users').find(x=>x.username===username);if(u)deleteLogin(store,u.id,'system',{transaction:false});}
  store.put('settings','accounts-v43',{appliedAt:new Date().toISOString(),count:testProfiles.length,event:'固定初始密码已一次性应用；后续启动不重置'});
 });

 if(writeCredentials){fs.writeFileSync(path.join(store.dataDir,'测试账号.txt'),passwordTable(),'utf8');}
 return {migrated:true,accounts:testProfiles.length};
}
