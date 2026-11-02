import {hasPermission} from './auth.mjs';
import {appError} from './store.mjs';
export const isReader=u=>u?.role==='viewer';
export const isFreeze=u=>u?.role==='freeze-clerk';
export const globalView=u=>u?.role==='admin'||(!isFreeze(u)&&!isReader(u)&&(hasPermission(u,'analysis.manage')||u?.dept==='质量部'));
const array=v=>Array.isArray(v)?v:typeof v==='string'?v.split(/[、,，;；]/).map(x=>x.trim()).filter(Boolean):[];
export function scopedData(store,user){
 const users=store.list('users'),analyses=store.list('analyses').filter(a=>!a.archived),faults=store.list('faults'),claims=store.list('claims');
 if(globalView(user))return {analyses,faults,claims,shipments:store.list('shipments'),products:store.list('products'),global:true};
 const departmentIds=new Set(users.filter(u=>u.dept&&u.dept===user.dept).map(u=>u.id));
 const direct=r=>!!user.dept&&[r.dept,r.department,r.primary,...array(r.secondary),...array(r.departments),...array(r.relatedDepartments),...(r.shares||[]).map(s=>s.dept)].includes(user.dept);
 const preliminaryIds=new Set(store.list('preliminaryAssignments').filter(p=>departmentIds.has(p.userId)).map(p=>p.faultId));
 const related=a=>isFreeze(user)?a.freezeAssignment?.owner===user.id:preliminaryIds.has(a.faultId)||direct(faults.find(f=>f.id===a.faultId)||{})||direct(a)||a.workflow?.tasks?.some(t=>!t.archived&&!t.gridRoot&&(departmentIds.has(t.owner)||(t.transfers||[]).some(h=>h.fromDept===user.dept||h.toDept===user.dept)))||a.nineGrid?.dimensions.some(d=>d.nodes.some(n=>direct(n)));
 const permitted=analyses.filter(related),faultIds=new Set(permitted.map(a=>a.faultId));
 let selectedFaults=faults.filter(f=>isFreeze(user)?faultIds.has(f.id):faultIds.has(f.id)||direct(f)||preliminaryIds.has(f.id));
 const ids=new Set(selectedFaults.map(f=>f.id));
 const selectedClaims=isFreeze(user)?[]:claims.filter(c=>direct(c)||[c.faultId,...array(c.faultIds)].some(id=>ids.has(id)));
 return {analyses:permitted,faults:selectedFaults,claims:selectedClaims,shipments:store.list('shipments').filter(direct),products:store.list('products').filter(p=>selectedFaults.some(f=>f.material===p.material)),global:false};
}
export function requireRecord(store,user,kind,id){
 const visible=scopedData(store,user);
 if(!visible[kind]?.some(r=>r.id===id))throw appError('记录不存在或不在本账号可查看范围内',404);
 return store.get(kind,id);
}
export function canReadFile(store,user,id){
 if(globalView(user))return true;
 const file=store.get('files',id);if(file?.uploadedBy===user.id)return true;
 const v=scopedData(store,user),allowedFaults=new Set(v.faults.map(f=>f.id));
 const related=[...v.analyses,...v.faults,...v.claims,...store.list('preliminary').filter(p=>allowedFaults.has(p.faultId)),...store.list('archive').filter(a=>v.analyses.some(i=>i.id===a.analysisId))];
 const walk=x=>{if(!x||typeof x!=='object')return false;if(x.id===id&&('type'in x||'size'in x||'name'in x))return true;return Object.values(x).some(v=>Array.isArray(v)?v.some(walk):typeof v==='object'&&walk(v));};
 return related.some(walk);
}
