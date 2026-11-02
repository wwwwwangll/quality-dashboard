import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { startServer } from '../server.mjs';

const appDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dateNow=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const addDays=(s,n)=>{const d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
function syntheticPhoto(){
  // A deliberately synthetic screen illustration, never a customer photograph.
  const width=480,height=240,pixels=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=y*(width*3+1)+1+x*3;let color=[28,49,65];if(x>70&&x<410&&y>30&&y<200)color=[84,100,112];if(x>80&&x<400&&y>40&&y<190)color=[4,8,14];if(x>225&&x<255&&y>200&&y<215)color=[84,100,112];if(x>180&&x<300&&y>=215&&y<224)color=[84,100,112];if(x>381&&x<387&&y>194&&y<198)color=[70,220,160];pixels.set(color,p);}
  const crc=bytes=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
  const chunk=(kind,bytes)=>{const name=Buffer.from(kind),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(bytes.length);checksum.writeUInt32BE(crc(Buffer.concat([name,bytes])));return Buffer.concat([size,name,bytes,checksum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}

test('HTTP全流程：真实账号、OA导入、初步分析、转交、失败重试、D1—D8关单及全员PDF',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quality-http-full-test-')),checks=[],output=path.join(appDir,'test-results');let runtime;
  const check=(name,fn)=>{fn();checks.push({name,passed:true});};
  try{
    runtime=await startServer({dataDir:dir,environment:'test',testMode:true});
    const client=()=>{let cookie='',csrf='';return {async request(route,body,method=body===undefined?'GET':'POST',headers={}){const response=await fetch(runtime.address+route,{method,headers:{'x-quality-test':'true',...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(body!==undefined&&!Buffer.isBuffer(body)?{'content-type':'application/json'}:{}),...headers},...(body!==undefined?{body:Buffer.isBuffer(body)?body:JSON.stringify(body)}:{})});const incoming=response.headers.get('set-cookie');if(incoming)cookie=incoming.split(';')[0];const data=response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());if(data?.csrf)csrf=data.csrf;return {status:response.status,data};},async ok(route,body,method,headers){const result=await this.request(route,body,method,headers);assert.ok(result.status>=200&&result.status<300,`${method||'POST'} ${route}: ${result.status} ${JSON.stringify(result.data).slice(0,1500)}`);return result.data;}};};
    const admin=client(),qe=client(),qe2=client(),fa=client(),worker=client(),worker2=client(),anonymous=client(),today=dateNow(),due=addDays(today,3);
    const setup=await admin.ok('/api/setup',{username:'flow-admin',name:'测试管理员',password:'Synthetic-Admin-2026'});const users={admin:setup.user};
    for(const [key,role,name,dept,c]of [['qe','quality-engineer','测试质量工程师甲','质量部',qe],['qe2','quality-engineer','测试质量工程师乙','质量部',qe2],['fa','failure-analyst','测试失效分析工程师','失效分析部',fa],['worker','worker','测试设计工程师','智能化研究院',worker],['worker2','worker','测试工艺工程师','工艺部',worker2]]){
      users[key]=await admin.ok('/api/users',{username:'flow-'+key,name,dept,role,password:'Synthetic-'+key+'-2026'});await c.ok('/api/login',{username:'flow-'+key,password:'Synthetic-'+key+'-2026'});
    }
    check('四种角色及两名独立质量工程师均真实登录',()=>{assert.equal(users.fa.role,'failure-analyst');assert.notEqual(users.qe.id,users.qe2.id);});
    assert.equal((await worker.request('/api/users')).status,403);assert.equal((await qe.request('/api/users')).status,403);
    const importCsv=async(kind,text)=>{const preview=await qe.ok('/api/imports/preview',{kind,name:'模拟OA-'+kind+'.csv',base64:Buffer.from(text).toString('base64')});assert.equal(preview.errors.length,0,JSON.stringify(preview.errors));return qe.ok('/api/imports/'+preview.batchId+'/commit',{});};
    const faultCsv=`报故单号,报故日期,产品名称,产品型号,料号,客户名称,故障信息,数量,发生地点与工况,报故人员\r\nBG-HTTP-BLACK,${today},显示屏,A01,PN-HTTP-BLACK,模拟客户,低温首次上电偶发黑屏重新上电恢复,1,低温首次上电,模拟现场人员\r\n`;
    await importCsv('fault',faultCsv);
    const claimCsv=`索赔编号,索赔日期,客户名称,产品名称,料号,索赔金额,减免金额,实际赔付,报故单号\r\nCL-HTTP-1,${today},模拟客户,显示屏,PN-HTTP-BLACK,1200.50,100,1100.50,BG-HTTP-BLACK\r\nCL-HTTP-2,${today},模拟客户,显示屏,PN-HTTP-BLACK,50,0,50,BG-HTTP-BLACK\r\nCL-HTTP-3,${today},模拟客户,显示屏,PN-HTTP-BLACK,350,,,\r\n`;
    await importCsv('claim',claimCsv);await importCsv('claim',claimCsv);
    let bootstrap=await qe.ok('/api/bootstrap');assert.equal((await worker.ok('/api/bootstrap')).faults.length,0);check('OA两表导入、同故障多笔索赔、独立索赔及重复导入均正确',()=>{assert.equal(bootstrap.faults.length,1);assert.equal(bootstrap.claims.length,3);assert.equal(bootstrap.claims.reduce((s,r)=>s+r.amountCents,0),160050);assert.equal(bootstrap.claims.filter(r=>r.faultIds.includes('BG-HTTP-BLACK')).length,2);assert.equal(bootstrap.claims.find(r=>r.id==='CL-HTTP-3').waiverCents,null);assert.ok(!JSON.stringify(bootstrap).includes('passwordHash'));});
    const photo=syntheticPhoto();const attachment=await fa.ok('/api/files',photo,'POST',{'content-type':'image/png','x-file-name':encodeURIComponent('模拟显示屏黑屏示意图.png')});
    await qe.ok('/api/faults/BG-HTTP-BLACK/assign',{userId:users.fa.id,due});
    const preliminary=await fa.ok('/api/faults/BG-HTTP-BLACK/preliminary',{phenomenon:'模拟案例：低温首次上电黑屏，重启恢复',process:'示波器观察复位与电源稳定时序；附件为自动生成的模拟示意图',conclusion:'初步怀疑复位释放早于电源稳定，需在8D进一步确认',files:[attachment],status:'submitted'});
    assert.equal((await worker.request('/api/analyses',{faultId:'BG-HTTP-BLACK'})).status,403);
    let item=await qe.ok('/api/analyses',{faultId:'BG-HTTP-BLACK'});
    check('失效分析分派、照片上传和初步结论进入8D快照，料号未丢失',()=>{assert.equal(item.preliminarySnapshot[0].id,preliminary.id);assert.equal(item.preliminarySnapshot[0].files[0].id,attachment.id);assert.equal(item.revised.partNo,'PN-HTTP-BLACK');});
    const cmd=async(action,body={},c=qe)=>{item=await c.ok('/api/analyses/'+item.id+'/commands',{action,version:item.version,...body});return item;};
    const task=id=>item.workflow.tasks.find(t=>t.id===id);
    const finish=async stage=>{try{return await cmd('finish-stage',{stage});}catch(e){throw Error(e.message+' CHECKLIST '+JSON.stringify(item.checklist));}};
    await cmd('patch-stage',{stage:'D1',fields:{goal:'消除模拟显示屏黑屏问题，并固化有效措施',weightReason:'根据各项任务的真实工作和贡献评定'},team:[{personId:users.qe.id,role:'组织分派与验收'},{personId:users.qe2.id,role:'共享验收与关单'},{personId:users.fa.id,role:'初步失效分析与经验总结'},{personId:users.worker.id,role:'产生原因及永久措施分析'}]});await finish('D1');
    const configure=async(id,{owner=users.worker.id,dueDate=due,base=1,evidence=false,title,scope='提交可复核结果'}={})=>cmd('save-task',{taskId:id,patch:{...(title?{title}:{}),owner,reviewer:users.qe.id,due:dueDate,base,scope,evidenceRequired:evidence}});
    const submit=async(id,{c=worker,data={},result='按任务要求完成并记录',files=[],links=[]}={})=>{await cmd('save-task',{taskId:id,patch:{result,data,files,links}},c);await cmd('submit-task',{taskId:id},c);};
    const accept=async(id,c=qe2)=>{await cmd('accept-task',{taskId:id,initiative:100,...(task(id).evidenceRequired?{evidenceScore:100}:{}),ratingReason:'模拟测试：按约定提交，内容和证据可复核'},c);};
    await cmd('patch-stage',{stage:'D2',fields:{description:'低温首次上电偶发黑屏重新上电恢复',condition:'低温首次上电',impact:'模拟报故1pcs，追溯SN生产100pcs，料号发货60pcs'},config:{d2:{reproductionDescription:'低温首次启动可观察到黑屏，重新上电后恢复',freeze:true,freezeNumber:'FZ-HTTP-001'}}});const freeze=item.workflow.tasks.find(t=>t.kind==='freeze');await configure(freeze.id);await submit(freeze.id,{data:{sn:'SN-HTTP-001至100',material:'PN-HTTP-BLACK',productionQty:100,shippedQty:60},result:''});await accept(freeze.id);await finish('D2');
    await cmd('patch-stage',{stage:'D3',fields:{containment:'对库存和在制品增加低温首次开机筛选',execution:'六类数量分别确认，返工方案覆盖全部适用阶段'}});
    for(const t of item.workflow.tasks.filter(t=>t.kind==='quantity')){await configure(t.id);await submit(t.id,{data:{quantity:t.data.category==='成品'?10:0},result:''});assert.equal(task(t.id).status,'accepted');}
    const plan=item.workflow.tasks.find(t=>t.kind==='rework');await configure(plan.id,{evidence:true,scope:'按固件修订及低温启动检查方案处理'});await submit(plan.id,{data:{categories:['原材料','半成品','成品','在途品','客户端成品']},result:'返工方案和范围已确认（模拟记录）',files:[attachment]});await accept(plan.id);await finish('D3');
    await cmd('patch-stage',{stage:'D4',config:{d4:{occurrenceResponsibility:{primary:'智能化研究院',secondary:['工艺部']}}}});
    const occurrence=item.workflow.tasks.find(t=>t.kind==='cause'&&t.data.section==='occurrence');await configure(occurrence.id,{base:2,evidence:true,scope:'分析复位时序为什么会造成低温黑屏，并记录复现依据'});await cmd('save-task',{taskId:occurrence.id,patch:{result:'已完成初始波形检查，需工艺工程师补充复测',files:[attachment]}},worker);
    const priorDue=task(occurrence.id).due;await cmd('transfer',{taskId:occurrence.id,to:users.worker2.id,reason:'设计已完成波形采样，转工艺复测验证'},worker);
    check('转交自动加入D1，保留原负责人、期限和原成果',()=>{assert.ok(item.team.some(m=>m.personId===users.worker2.id));assert.ok(item.team.some(m=>m.personId===users.worker.id));assert.equal(task(occurrence.id).due,priorDue);assert.equal(task(occurrence.id).transfers[0].snapshot.result,'已完成初始波形检查，需工艺工程师补充复测');});
    assert.equal((await worker.request('/api/analyses/'+item.id+'/commands',{action:'save-task',version:item.version,taskId:occurrence.id,patch:{result:'原负责人越权修改'}})).status,403);
    await submit(occurrence.id,{c:worker2,result:'模拟确认：复位信号释放早于电源稳定，低温裕量不足触发黑屏',files:[attachment]});await accept(occurrence.id);await cmd('score-transfer',{taskId:occurrence.id,reason:'设计采样贡献0.5分，工艺复测并验证根因贡献1.5分',allocations:[{personId:users.worker.id,points:0.5},{personId:users.worker2.id,points:1.5}]});
    for(const t of item.workflow.tasks.filter(t=>t.kind==='cause'&&t.id!==occurrence.id)){await configure(t.id);await submit(t.id,{result:t.data.section==='escape'?'出厂检验只覆盖常温连续运行，未覆盖低温首次上电':'流出原因主责为质量部，次要为工艺部',data:t.data.section==='escapeDept'?{primary:'质量部',secondary:['工艺部']}:{} });await accept(t.id);}
    await finish('D4');
    const measures=[];for(const cause of item.workflow.tasks.filter(t=>t.kind==='cause'&&['occurrence','escape'].includes(t.data.section))){await cmd('create-measure',{causeId:cause.id});const id=item.newTaskId;measures.push(id);await configure(id,{title:cause.data.section==='occurrence'?'启动复位延时增加至5ms':'将低温首次开机纳入检验规范',scope:'手写永久措施及执行要求'});await submit(id,{result:''});await accept(id);}await finish('D5');
    await cmd('create-experiment',{measureIds:[measures[0]]});const failedId=item.newTaskId;await configure(failedId,{title:'5ms启动延时低温实验',evidence:true});const experimentData={scope:'A01低温首次启动',criteria:'连续20次启动均显示正常',sample:'模拟样品5pcs',window:'模拟20轮启动',decision:'未通过'};
    await cmd('save-task',{taskId:failedId,patch:{result:'模拟实验未通过：5ms延时仍有低温启动黑屏',data:experimentData,files:[attachment]}},worker);await cmd('verification-failed',{taskId:failedId,target:'D5'},worker);
    await cmd('reopen-linked',{taskId:measures[0]});await cmd('save-task',{taskId:measures[0],patch:{title:'启动复位延时增加至20ms，并检查电源稳定裕量'}});await submit(measures[0],{result:''});await accept(measures[0]);await finish('D5');
    await cmd('repeat-verification',{taskId:failedId});const retryId=item.newTaskId;await cmd('link-experiment',{taskId:retryId,measureIds:[measures[0]]});await configure(retryId,{title:'20ms启动延时低温复验',evidence:true});await submit(retryId,{result:'模拟复验通过：5pcs样品连续20轮低温首次启动正常',data:{...experimentData,decision:'通过'},files:[attachment]});await accept(retryId);
    await cmd('patch-stage',{stage:'D6',config:{d6:{withdrawal:'20ms永久措施完成验证，控制计划生效后撤除临时筛选'}}});await finish('D6');
    check('失败实验保留、措施修订后复验通过，未选择的另一措施未被强制安排实验',()=>{assert.ok(task(failedId).retired);assert.ok(task(failedId).submissions.some(s=>s.status==='failed'));assert.equal(task(retryId).data.decision,'通过');assert.ok(!item.workflow.tasks.some(t=>t.kind==='verification'&&t.measureIds.includes(measures[1])));});
    await cmd('select-prevention',{key:'cp',selected:true});const cp=item.newTaskId;await configure(cp,{evidence:true});await submit(cp,{result:'模拟控制计划已增加低温首次启动检查，记录见附件',files:[attachment]});await accept(cp);
    await cmd('select-prevention',{key:'lessons',selected:true});const lesson=item.newTaskId;await configure(lesson,{owner:users.fa.id});await submit(lesson,{c:fa,result:'已记录设计时序裕量和检验覆盖方面的经验教训',data:{lessonRecord:{phenomenon:'低温首次上电黑屏',rootCause:'复位时序裕量不足，检验漏覆盖',effective:'20ms复位延时及低温首次启动检查',failed:'单纯重启及5ms延时未防止复发',scope:'本模拟A01平台；其他平台需评估时序',evidence:'本次8D模拟波形与复验记录'}}});await accept(lesson);
    await cmd('patch-stage',{stage:'D7',config:{d8:{horizontal:true}}});const horizontal=item.workflow.tasks.find(t=>t.kind==='horizontal');await configure(horizontal.id,{owner:users.worker2.id,evidence:true,scope:'同平台A02显示屏进行时序裕量排查'});await submit(horizontal.id,{c:worker2,result:'模拟横向排查完成，同平台已评估并落实检查',files:[attachment]});await accept(horizontal.id);await finish('D7');
    await cmd('patch-stage',{stage:'D8',fields:{summary:'模拟黑屏案例完成：确认发生原因及流出原因，永久措施经失败改进后复验通过，控制计划、经验教训和横向展开已完成。'}});await finish('D8');
    assert.equal((await fa.request('/api/analyses/'+item.id+'/commands',{action:'close',version:item.version})).status,403);
    await cmd('close',{comment:'质量工程师乙确认模拟案例闭环'},qe2);
    bootstrap=await worker.ok('/api/bootstrap');const archived=bootstrap.archives.find(a=>a.id===item.id||a.analysisId===item.id);assert.equal(archived?.status,'ready',JSON.stringify(archived));
    const pdf=(await worker.ok('/api/archives/'+item.id+'/pdf'));assert.equal(pdf.subarray(0,5).toString(),'%PDF-');const document=await PDFDocument.load(pdf);assert.ok(document.getPageCount()>=5);assert.equal(document.getTitle(),item.title);
    for(const c of[fa,worker2,qe,qe2,admin])assert.equal((await c.request('/api/archives/'+item.id+'/pdf')).status,200);assert.equal((await anonymous.request('/api/archives/'+item.id+'/pdf')).status,401);
    check('完整8D由第二位质量工程师直接关单，真实PDF全员可查看',()=>{assert.equal(item.status,'closed');assert.equal(item.closedBy,users.qe2.id);assert.equal(item.approval.required,false);assert.equal(item.finalContributions.reduce((s,r)=>s+r.share,0),100);assert.ok(bootstrap.analyses.some(a=>a.status==='closed'&&a.revised.partNo==='PN-HTTP-BLACK'));});
    fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'black-screen-report.pdf'),pdf);fs.writeFileSync(path.join(output,'black-screen-record.json'),JSON.stringify(item,null,2));fs.writeFileSync(path.join(output,'full-http-flow-results.json'),JSON.stringify({status:'passed',syntheticDataOnly:true,generatedAt:new Date().toISOString(),checks,pdf:{pages:document.getPageCount(),bytes:pdf.length}},null,2));
  }finally{await runtime?.close();if(dir.startsWith(path.join(os.tmpdir(),'quality-http-full-test-')))fs.rmSync(dir,{recursive:true,force:true});}
});
