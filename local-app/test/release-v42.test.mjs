import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {startServer} from '../server.mjs';
import {hashPassword} from '../lib/auth.mjs';
import {createWorkflowService} from '../lib/workflow.mjs';
import {createArchiveService} from '../lib/archive.mjs';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quality-v42-regression-test-'));
let runtime,store,admin,qe,worker,outsider,viewer,clerk,wf,serial=0;
const password='Synthetic-Regression-2026';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfN8AAAAASUVORK5CYII=','base64');
async function client(id){const response=await fetch(runtime.address+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:id,password})}),login=await response.json();assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0];return async(url,body)=>{const res=await fetch(runtime.address+url,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':login.csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});const bytes=Buffer.from(await res.arrayBuffer());let data;try{data=JSON.parse(bytes)}catch{data=bytes.toString()}return {status:res.status,data};};}
before(async()=>{runtime=await startServer({dataDir:dir,environment:'test',testMode:true});store=runtime.store;const passwordHash=await hashPassword(password);for(const[id,role,dept]of [['admin','admin','质量部'],['qe','quality-engineer','质量部'],['worker','worker','智能化研究院'],['outsider','worker','储运部'],['viewer','viewer','销售部'],['clerk','freeze-clerk','质量部']])store.put('users',id,{username:id,name:'模拟'+id,role,dept,enabled:true,passwordHash,mustChangePassword:false});admin=await client('admin');qe=await client('qe');worker=await client('worker');outsider=await client('outsider');viewer=await client('viewer');clerk=await client('clerk');wf=createWorkflowService({store});store.put('files','SYN-PHOTO',{name:'模拟照片.png',type:'image/png',size:png.length,uploadedBy:'worker'});fs.writeFileSync(path.join(store.fileRoot,'SYN-PHOTO'),png);});
after(async()=>{await runtime.close();fs.rmSync(dir,{recursive:true,force:true});});
async function analysis(mode){const id='BG-SYNTHETIC-'+(++serial);store.put('faults',id,{date:'2026-11-01',product:'模拟显示屏',material:'SYN-PN',sn:'SYN-SN',description:'模拟黑屏'});const r=await qe('/api/analyses',{faultId:id,...(mode?{mode}: {})});assert.equal(r.status,201);return r.data.id;}
const cmd=(as,id,action,body={})=>as('/api/analyses/'+id+'/commands',{action,version:store.get('analyses',id).version,...body});
async function assignedGrid(evidenceRequired=true){
 const id=await analysis('nine-grid'),legacy=store.get('analyses',id),{G}=wf.engine();
 legacy.nineGrid.version=1;
 for(const d of legacy.nineGrid.dimensions)d.nodes=G.nodes(G.dims.find(([key])=>key===d.id)[2]);
 store.put('analyses',id,legacy);
 const r=await cmd(qe,id,'grid-assign',{dimension:'design',owner:'worker',due:'2026-11-15',base:2,evidenceRequired});
 assert.equal(r.status,200);
 return {id,node:r.data.nineGrid.dimensions[0].nodes[0].id,taskId:r.data.nineGrid.dimensions[0].taskId};
}

test('附件与PDF的大小写变体均不可绕过范围，已授权标准路径仍可读',async()=>{
 store.put('files','SYN-SECRET',{name:'模拟独立附件.txt',type:'text/plain',size:14,uploadedBy:'admin'});fs.writeFileSync(path.join(store.fileRoot,'SYN-SECRET'),'SYNTHETIC ONLY');
 for(const url of ['/api/files/SYN-SECRET','/API/Files/SYN-SECRET','/api/Files/SYN-SECRET','/Api/files/SYN-SECRET'])assert.equal((await outsider(url)).status,404,url);
 assert.equal((await admin('/api/files/SYN-SECRET')).status,200);
 const id=await analysis();const x=store.get('analyses',id);store.put('analyses',id,{...x,status:'closed'});const archive=createArchiveService({store,renderPdf:async()=>Buffer.from('%PDF-1.7\nSIMULATED')});await archive.generate(store.get('analyses',id));
 for(const prefix of ['/api/archives/','/API/Archives/','/api/Archives/'])assert.equal((await clerk(prefix+id+'/pdf')).status,404,prefix);
 assert.equal((await qe('/api/archives/'+id+'/pdf')).status,200);
 await assert.rejects(archive.api('pdf',{user:store.get('users','clerk'),id}),/范围/);
});

test('仅加入D1的跨部门团队成员可以查看，仍不能代写他人任务，移除后撤销范围',async()=>{
 const id=await analysis();let x=store.get('analyses',id);x.team.push({personId:'outsider',role:'模拟协作'});store.put('analyses',id,x);assert.equal((await outsider('/api/analyses/'+id)).status,200);
 assert.equal((await cmd(outsider,id,'patch-stage',{stage:'D1',fields:{goal:'越权'},version:0})).status,403);
 x=store.get('analyses',id);x.team.find(m=>m.personId==='outsider').inactive=true;store.put('analyses',id,x);assert.equal((await outsider('/api/analyses/'+id)).status,404);
});

test('部门查看角色能读取仅本部门指标，不能管理账号或操作任务',async()=>{
 const metrics=await viewer('/api/metrics?period=month&date=2026-11-01');assert.equal(metrics.status,200);assert.ok(metrics.data.departments.every(d=>d.department==='销售部'));assert.ok(metrics.data.tasks.every(d=>d.department==='销售部'));assert.equal((await viewer('/api/users')).status,403);
});

test('九宫格无问题直接确认，照片要求不强迫非根因上传或填写说明',async()=>{
 const {id,node}=await assignedGrid(true);const r=await cmd(worker,id,'grid-submit',{dimension:'design',nodeId:node,patch:{status:'clear',rootCause:false}});assert.equal(r.status,200);const n=r.data.nineGrid.dimensions[0].nodes[0];assert.equal(n.review,'submitted');assert.equal(n.description,'');assert.equal(n.status,'clear');assert.equal(n.files.length,0);assert.equal(n.policyVersion,2);
 assert.equal((await cmd(qe,id,'grid-review',{dimension:'design',nodeId:node,decision:'accepted',reason:'无问题核对通过'})).status,200);
});

test('根因选择自动转为红灯，提交描述照片一次保存并可回读，旧历史不被覆盖',async()=>{
 const {id,node}=await assignedGrid(true);const r=await cmd(worker,id,'grid-submit',{dimension:'design',nodeId:node,patch:{status:'clear',rootCause:true,description:'模拟低温复位提前释放导致黑屏',files:[{id:'SYN-PHOTO'}]}});assert.equal(r.status,200);const reread=await worker('/api/analyses/'+id),n=reread.data.nineGrid.dimensions[0].nodes[0];assert.equal(n.status,'issue');assert.equal(n.rootCause,true);assert.equal(n.description,'模拟低温复位提前释放导致黑屏');assert.equal(n.files[0].id,'SYN-PHOTO');assert.equal(n.history.length,1);assert.equal(n.history[0].files[0].id,'SYN-PHOTO');
 const attempted=await cmd(worker,id,'grid-save',{dimension:'design',nodeId:node,files:[]});assert.equal(attempted.status,409);assert.equal(store.get('analyses',id).nineGrid.dimensions[0].nodes[0].files.length,1);
});

test('缺少根因证据时整笔提交失败，不留下部分保存；草稿可以移除照片',async()=>{
 const {id,node}=await assignedGrid(true);let before=store.get('analyses',id);const r=await cmd(worker,id,'grid-submit',{dimension:'design',nodeId:node,patch:{rootCause:true,status:'issue',description:'模拟根因'}});assert.equal(r.status,400);assert.equal(store.get('analyses',id).version,before.version);assert.equal(store.get('analyses',id).nineGrid.dimensions[0].nodes[0].description,'');
 assert.equal((await cmd(worker,id,'grid-save',{dimension:'design',nodeId:node,status:'issue',rootCause:true,description:'模拟根因',files:[{id:'SYN-PHOTO'}]})).status,200);
 assert.equal((await cmd(worker,id,'grid-save',{dimension:'design',nodeId:node,files:[]})).status,200);assert.equal(store.get('analyses',id).nineGrid.dimensions[0].nodes[0].files.length,0);assert.ok(store.get('files','SYN-PHOTO'));assert.ok(fs.existsSync(path.join(store.fileRoot,'SYN-PHOTO')));
});

test('九宫格保持责任人顺序、驳回20字规则与重提历史',async()=>{
 const {id,node}=await assignedGrid(false);const later=store.get('analyses',id).nineGrid.dimensions[0].nodes[1].id;assert.equal((await cmd(worker,id,'grid-submit',{dimension:'design',nodeId:later,patch:{status:'clear',rootCause:false}})).status,409);
 await cmd(worker,id,'grid-submit',{dimension:'design',nodeId:node,patch:{status:'clear',rootCause:false}});assert.equal((await cmd(qe,id,'grid-review',{dimension:'design',nodeId:node,decision:'returned',reason:'不充分'})).status,400);
 const reason='请补充本次实际检查的项目及检查记录以便确认没有遗漏相关风险';assert.equal((await cmd(qe,id,'grid-review',{dimension:'design',nodeId:node,decision:'returned',reason})).status,200);assert.equal((await cmd(worker,id,'grid-submit',{dimension:'design',nodeId:node,patch:{status:'clear',description:'按要求补充核查'}})).status,200);const history=store.get('analyses',id).nineGrid.dimensions[0].nodes[0].history;assert.equal(history.length,3);assert.equal(history[1].reason,reason);
});

test('审计按时间、记录、任务筛选并分页，恶意或无效查询不进入SQL',async()=>{
 const {id,node,taskId}=await assignedGrid(false);await cmd(worker,id,'grid-submit',{dimension:'design',nodeId:node,patch:{status:'clear',rootCause:false}});
 const one=await admin('/api/audit?limit=1');assert.equal(one.status,200);assert.equal(one.data.length,1);assert.equal((await admin('/api/audit?since=2099-01-01')).data.length,0);assert.equal((await admin('/api/audit?offset=999999')).data.length,0);
 const matches=await admin('/api/audit?analysisId='+id+'&taskId='+taskId);assert.ok(matches.data.length>=1);assert.ok(matches.data.every(e=>e.details.id===id&&e.details.taskId===taskId));assert.equal(matches.data[0].details.nodeId,node);
 for(const q of ['limit=-1','limit=301','limit=abc','offset=-1','since=nonsense'])assert.equal((await admin('/api/audit?'+q)).status,400,q);
});

test('PDF生成和重试同步业务摘要状态，关闭快照与历史资料保持原样',async()=>{
 const id=await analysis(),x=store.get('analyses',id);x.status='closed';x.pdf={status:'pending'};x.closeSnapshot={synthetic:'immutable',pdf:{status:'pending'}};store.put('analyses',id,x);
 let fail=true;const archive=createArchiveService({store,renderPdf:async()=>{if(fail)throw Error('synthetic failure');return Buffer.from('%PDF-1.7\nSIMULATED');}});await archive.generate(x);assert.equal(store.get('analyses',id).pdf.status,'failed');fail=false;await archive.generate(store.get('analyses',id),{retry:true});assert.equal(store.get('archive',id).status,'ready');assert.equal(store.get('analyses',id).pdf.status,'ready');assert.deepEqual(store.get('analyses',id).closeSnapshot,x.closeSnapshot);
});

test('账号状态清单反映启用停用，不包含密码、散列和会话',async()=>{
 const r=await admin('/api/users/export.csv');assert.equal(r.status,200);assert.ok(r.data.includes('当前状态'));assert.ok(r.data.includes('worker'));assert.ok(!r.data.includes('scrypt-v1'));assert.ok(!r.data.includes(password));assert.equal((await worker('/api/users/export.csv')).status,403);
});

test('任务专属证据要求准确：普通任务接受链接，返工文件和图片要求不能被链接替代',()=>{
 const {W}=wf.engine();assert.equal(W.evidencePresent({kind:'general',stage:'D5',links:[{name:'模拟报告',url:'https://example.com/report'}]}),true);assert.equal(W.evidencePresent({kind:'rework',stage:'D3',policyVersion:4,links:[{name:'模拟报告',url:'https://example.com/report'}]}),false);
});

test('不得把他人无权查看的附件ID关联到自己的根因以绕过下载权限',async()=>{const {id,node}=await assignedGrid(true);const r=await cmd(worker,id,'grid-submit',{dimension:'design',nodeId:node,patch:{status:'issue',rootCause:true,description:'模拟恶意关联',files:[{id:'SYN-SECRET'}]}});assert.equal(r.status,404);assert.equal((await worker('/api/files/SYN-SECRET')).status,404);assert.equal(store.get('analyses',id).nineGrid.dimensions[0].nodes[0].review,'draft');});
