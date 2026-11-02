import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {PDFDocument,rgb} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {fileURLToPath} from 'node:url';
import {requireRecord} from './access.mjs';
import {appError} from './store.mjs';
import {hasPermission} from './auth.mjs';

const appDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const labels={product:'产品名称',model:'产品型号',partNo:'料号',material:'料号',customer:'客户',project:'项目',description:'问题描述',condition:'工况',quantity:'数量',goal:'共同目标与协作说明',weightReason:'分工依据',impact:'影响范围',editReason:'修订说明',containment:'临时措施',execution:'执行情况',summary:'总结',section:'原因类型',primary:'主责部门',secondary:'次要部门',sn:'SN',productionQty:'SN生产数量',shippedQty:'已发货数量',category:'产品类别',categories:'适用范围',criteria:'验收标准',scope:'验证范围',sample:'验证样本',window:'观察期',decision:'验证结论',targets:'横向展开对象',phenomenon:'现象',process:'检查过程',conclusion:'初步结论',rootCause:'根因',effective:'有效措施',failed:'失败尝试',evidence:'证据',confirmed:'已确认',reproductionDescription:'现场复现描述',major:'重大质量问题',batch:'批量问题',freeze:'产品冻结',freezeNumber:'冻结编号',withdrawal:'临时措施撤除结论',reason:'原因',output:'实际输出',method:'验证方法'};
Object.assign(labels,{unit:'单位',measureKey:'预防措施类型',lessonRecord:'经验教训记录',enabled:'启用',mode:'提醒方式',revision:'版本',effectiveDate:'整改生效日期',message:'订单质量提示',departments:'通知部门',engineers:'通知工程师',orderId:'匹配订单',matchedAt:'匹配时间',productionAt:'首次生产时间',reminderState:'提醒状态',events:'事件记录',from:'原负责人',to:'新负责人',fromName:'原负责人',toName:'新负责人',fromDept:'原部门',toDept:'新部门',at:'时间',by:'确认人',total:'任务总分',allocations:'贡献分配',personId:'人员',points:'积分'});
const clean=v=>String(v??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
Object.assign(labels,{confirmedAt:'确认时间',originalId:'原报告编号'});
const enums={section:{occurrence:'产生原因',escape:'流出原因',escapeDept:'流出原因责任部门'},mode:{month:'整改生效满一个月提醒',production:'首次生产复核后提醒'},measureKey:{cp:'更新控制计划CP',lessons:'经验教训记录'}};
function value(v,key=''){if(Array.isArray(v))return v.map(x=>value(x,key)).filter(Boolean).join('、');if(v===true)return '是';if(v===false)return '否';if(v&&typeof v==='object')return Object.entries(v).map(([k,x])=>{const rendered=value(x,k);return rendered.trim()?(Object.hasOwn(labels,k)?labels[k]:k)+'：'+rendered:''}).filter(Boolean).join('；');if(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v)))return new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});return enums[key]&&Object.hasOwn(enums[key],v)?enums[key][v]:clean(v);}
export function createArchiveService({store,fileRoot=store.fileRoot,renderPdf}){
 const running=new Map();
 async function makePdf(snapshot){
  const userName=id=>(snapshot.peopleSnapshot||[]).find(p=>p.id===id)?.name||store.get('users',id)?.name||id||'未指定';
  const doc=await PDFDocument.create();doc.registerFontkit(fontkit);
  const fontPath=path.join(appDir,'assets','NotoSansSC-Regular.ttf');if(!fs.existsSync(fontPath))throw Error('缺少随包中文字体，请检查安装包完整性');
  const font=await doc.embedFont(fs.readFileSync(fontPath),{subset:true});
  doc.setTitle(snapshot.title||'8D分析报告');doc.setAuthor('质见质量管理系统');doc.setSubject(snapshot.id);doc.setCreationDate(new Date());
  const pages=[];let page,y;const width=595.28,height=841.89,margin=44,bodyWidth=width-2*margin;
  function addPage(){page=doc.addPage([width,height]);pages.push(page);y=height-58;page.drawText('质见 / 8D 分析归档',{x:margin,y:height-28,size:9,font,color:rgb(.28,.4,.48)});page.drawLine({start:{x:margin,y:height-36},end:{x:width-margin,y:height-36},color:rgb(.82,.87,.9),thickness:.5});}
  function ensure(n){if(!page||y-n<48)addPage();}
  function wrap(text,size,max=bodyWidth){const out=[];for(const line of clean(text).split(/\r?\n/)){let s='';for(const char of line){if(s&&font.widthOfTextAtSize(s+char,size)>max){out.push(s);s=char}else s+=char;}out.push(s||' ');}return out;}
  function text(t,size=10,color=rgb(.12,.18,.24)){for(const line of wrap(t,size)){ensure(size*1.65);page.drawText(line,{x:margin,y,size,font,color});y-=size*1.65;}y-=4;}
  function heading(t,level=1){ensure(level===1?85:64);y-=level===1?12:6;text(t,level===1?16:12,rgb(.04,.36,.43));}
  function field(k,v){if(v!==undefined&&v!==null&&value(v,k).trim())text((Object.hasOwn(labels,k)?labels[k]:k)+'：'+value(v,k));}
  addPage();heading(snapshot.title||'8D分析报告');text('报告编号：'+snapshot.id+'    报故单：'+snapshot.faultId);text('关单时间：'+value(snapshot.closedAt||'历史记录未提供')+'    归档生成：'+new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}));
  heading('基础信息');for(const[k,v]of Object.entries(snapshot.revised||{}))field(k,v);
  heading('报故初步失效分析');const preliminary=snapshot.preliminarySnapshot||[];if(!preliminary.length)text('未记录初步分析。');for(const p of preliminary){text('分析人员：'+userName(p.authorId||p.owner)+'    提交时间：'+value(p.submittedAt||p.updatedAt||''));for(const k of ['phenomenon','process','conclusion'])field(k,p[k]);}
  const allFiles=[];const takeFiles=a=>{for(const f of a||[])if(f?.id&&!allFiles.some(x=>x.id===f.id))allFiles.push(f);};preliminary.forEach(p=>takeFiles(p.files));
  const stageNames={D1:'团队组建',D2:'问题描述',D3:'临时遏制',D4:'根因分析',D5:'永久纠正',D6:'实施验证',D7:'防止再发',D8:'总结关闭'};
  for(const [id,name]of Object.entries(stageNames)){
   heading(id+' '+name);const s=snapshot.stages?.[id]||{};text('阶段状态：'+(s.na?'不适用：'+s.naReason:s.done?'已确认完成':'历史记录未完成'));
   if(id==='D1')for(const m of snapshot.team||[])text(userName(m.personId)+(m.inactive?'（历史成员）':'')+' / '+(m.role||''));
   for(const[k,v]of Object.entries(s.fields||{}))field(k,v);takeFiles(s.files);for(const l of s.links||[])field('资料链接',l.name+' '+l.url);
   const w=snapshot.workflow||{};if(id==='D2')for(const[k,v]of Object.entries(w.d2||{}))if(!/Id$/.test(k)&&k!=='unified')field(({major:'重大质量问题',batch:'批量问题',freeze:'是否产品冻结',freezeNumber:'冻结编号',reproductionDescription:'现场补充描述（选填）',snScope:'SN范围'})[k]||k,v);
   if(id==='D4'&&!snapshot.nineGrid)field('产生原因责任部门',w.d4?.occurrenceResponsibility);
   if(id==='D6'){field('withdrawal',w.d6?.withdrawal);field('首产跟踪',w.d8?.production?.enabled?w.d8.production:'未启用');}
   if(id==='D7'){field('类似问题',w.d8?.similar);field('复发关联',w.d8?.recurrence);field('横向展开',w.d8?.horizontal);field('经验教训',w.d8?.lessons);}
   if(id==='D4'&&snapshot.nineGrid){for(const d of snapshot.nineGrid.dimensions){heading('九宫格 · '+d.label,2);const dt=w.tasks.find(t=>t.id===d.taskId);text('分析责任人：'+userName(dt?.owner)+' / 期限：'+(dt?.due||'未分派'));field('完成提交时间',dt?.submittedAt);field('确认时间',dt?.acceptedAt);field('评分说明',dt?.ratingReason);const walk=(nodes,path=[])=>{for(const n of nodes){const p=[...path,n.label];text('L'+n.level+' / '+p.join(' → '));text('判断：'+({issue:'有问题',clear:'无问题',pending:'待确认'}[n.status]||'未评估')+' / 审核：'+({accepted:'已通过',submitted:'待审核',returned:'已驳回',draft:'草稿'}[n.review]||n.review)+(n.rootCause?' / 已证实根因':''));field('详细依据',n.description);field('驳回原因',n.returnReason);takeFiles(n.files);for(const l of n.links||[])field('证据链接',l.name+' '+l.url);for(const h of n.history||[])if(['accepted','returned'].includes(h.action))text('审核记录：'+userName(h.by)+' / '+value(h.at)+' / '+(h.reason||h.action));walk(n.children||[],p);}};walk(d.nodes);}}
   for(const t of(w.tasks||[]).filter(t=>t.stage===id&&!t.gridRoot&&t.kind!=='grid')){
    heading(t.title||'任务',2);text('责任人：'+userName(t.owner)+'    截止：'+(t.due||'未提供')+'    状态：'+({accepted:'已完成',submitted:'待验收',draft:'待提交',returned:'退回补充'}[t.status]||t.status));
    if(t.archived||t.previousPlan||t.previousProduction||t.experimentCancelled||t.retired)text('历史／取消记录，保留追溯。');
    const measureNames=(t.measureIds||[]).map(id=>{let recorded=t.measureSnapshots?.[id];try{if(typeof recorded==='string')recorded=JSON.parse(recorded);}catch{return id;}return recorded?.title||id;});
    field('完成提交时间',t.submittedAt);field('确认时间',t.acceptedAt);field('任务要求',t.scope);field('对应原因',t.causeSnapshot);field('关联措施（当次快照）',measureNames);field('实际输出',t.result);for(const[k,v]of Object.entries(t.data||{}))field(t.kind==='d2-fill'?({productionQty:'SN对应生产数量（pcs）',shippedQty:'料号发货数量（pcs）',freezeNumber:'冻结编号',sn:'SN（源信息）',material:'料号（源信息）',unit:'单位'})[k]||k:k,v);
    field('评分说明',t.ratingReason);
    for(const transfer of t.transfers||[])field('转交记录',(transfer.fromName||userName(transfer.from))+(transfer.fromDept?'（'+transfer.fromDept+'）':'')+' → '+(transfer.toName||userName(transfer.to))+(transfer.toDept?'（'+transfer.toDept+'）':'')+'；时间：'+value(transfer.at)+'；操作人：'+userName(transfer.by)+'；原因：'+(transfer.reason||'未提供'));
    if(t.transferEvaluation){const e=t.transferEvaluation;field('转交贡献评定',(e.confirmed?'已确认':'待确认')+'；任务总分：'+value(e.total)+'；'+(e.allocations||[]).map(a=>userName(a.personId)+' '+value(a.points)+'分').join('、')+'；依据：'+(e.reason||'未提供')+'；确认人：'+userName(e.by)+'；时间：'+value(e.at));}
    takeFiles(t.files);for(const l of t.links||[])field('证据链接',l.name+' '+l.url);
    for(const sub of t.submissions||[]){if(['returned','failed'].includes(sub.status)){heading('失败／退回记录',2);field('时间',sub.at);field('结论',sub.result);field('原因',sub.reason||sub.ratingReason);}takeFiles(sub.files);}
   }
  }
  heading('最终贡献评价');const scores=snapshot.finalContributions||snapshot.contributions||[];if(!scores.length)text('见任务评分与D8评定记录。');for(const r of scores)text(userName(r.personId)+'：积分 '+Number(r.final??r.points??r.base??0).toFixed(2)+'，贡献占比 '+Number(r.share||0).toFixed(2)+'%');
  heading('图片与附件');if(!allFiles.length)text('无附件。');
  for(const ref of allFiles){const metadata=store.get('files',ref.id)||ref;field('附件',metadata.name||ref.id);if(!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/.test(ref.id)){text('附件编号无效，未读取文件。');continue;}const p=path.join(fileRoot,ref.id);if(!fs.existsSync(p)){text('附件文件缺失，请核查迁移／备份完整性。');continue;}if(/^image\/(png|jpeg|jpg)$/.test(metadata.type||'')){
    try{const bytes=fs.readFileSync(p),im=/png/.test(metadata.type)?await doc.embedPng(bytes):await doc.embedJpg(bytes);const scale=Math.min(bodyWidth/im.width,250/im.height,1);ensure(im.height*scale+25);page.drawImage(im,{x:margin,y:y-im.height*scale,width:im.width*scale,height:im.height*scale});y-=im.height*scale+18;}catch{text('该图片无法嵌入，请查看原附件。');}
   }else text('此格式以原附件提供，不在PDF中嵌入。');}
  heading('操作历史');const actions={'patch-stage':'更新阶段内容','save-task':'保存任务','submit-task':'提交任务','accept-task':'验收通过','return-task':'退回补充','finish-stage':'确认阶段完成','transfer':'转交任务','score-transfer':'评定转交贡献','create-measure':'建立永久措施','create-experiment':'建立实验','repeat-verification':'开展复验','reopen-linked':'重新编辑措施','verification-failed':'记录实验失败','select-prevention':'选择预防措施','close':'关闭并归档','grid-assign':'分派九宫格维度','grid-save':'保存分析节点','grid-split':'拆分下层九宫格','grid-submit':'提交分析结论','grid-review':'审核分析结论','assign-freeze-number':'分派冻结编号','save-freeze-number':'填写冻结编号'};for(const h of snapshot.history||[]){let log=h.text||'';for(const[k,v]of Object.entries(actions))log=log.replace('8D操作：'+k,v).replace('九宫格：'+k,v);text(value(h.at||'')+' '+(h.actor||'')+'：'+log);}
  pages.forEach((p,i)=>p.drawText(snapshot.id+'    第 '+(i+1)+' / '+pages.length+' 页',{x:margin,y:25,font,size:8,color:rgb(.4,.45,.5)}));
  return Buffer.from(await doc.save());
 }
 async function generate(item,{retry=false}={}){
  if(item.status!=='closed')throw appError('仅已关闭报告可以归档');if(running.has(item.id))return running.get(item.id);
  const old=store.get('archive',item.id);if(old?.status==='ready'&&!retry)return old;
  const snapshot=old?.snapshot||JSON.parse(JSON.stringify(item.closeSnapshot||item));
  const job=(async()=>{let r=store.put('archive',item.id,{...old,analysisId:item.id,status:'generating',snapshot,error:'',generatedAt:old?.generatedAt||null});try{
    const bytes=await (renderPdf||makePdf)(snapshot),relative=path.join('pdf',item.id.replace(/[^\p{L}\p{N}_.-]/gu,'_')+'-'+randomUUID()+'.pdf');fs.mkdirSync(path.join(fileRoot,'pdf'),{recursive:true});fs.writeFileSync(path.join(fileRoot,relative),bytes,{flag:'wx'});
    r=store.put('archive',item.id,{...r,status:'ready',path:relative,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),generatedAt:new Date().toISOString(),error:''});store.audit('system','pdf.ready',{analysisId:item.id,size:bytes.length});const current=store.get('analyses',item.id);if(current?.status==='closed')store.put('analyses',item.id,{...current,pdf:{...current.pdf,status:'ready',archiveId:item.id,generatedAt:r.generatedAt,size:r.size}},{expectedVersion:current.version});return r;
   }catch(e){const current=store.get('analyses',item.id);if(current?.status==='closed')store.put('analyses',item.id,{...current,pdf:{...current.pdf,status:'failed',error:'PDF生成失败，请重试'}},{expectedVersion:current.version});return store.put('archive',item.id,{...r,status:'failed',error:String(e.message).slice(0,500)});}finally{running.delete(item.id);}})();running.set(item.id,job);return job;
 }
 async function api(action,{user,id}){if(!user)throw appError('请先登录',401);requireRecord(store,user,'analyses',id);if(action==='retry'){if(!hasPermission(user,'tasks.review'))throw appError('仅管理员或质量工程师可以生成归档',403);const item=store.get('analyses',id);if(!item)throw appError('报告不存在',404);return generate(item,{retry:true});}if(action==='pdf'){const a=store.get('archive',id);if(!a||a.status!=='ready')throw appError('PDF尚未成功生成',409);const p=path.resolve(fileRoot,a.path);if(!p.startsWith(path.resolve(fileRoot)+path.sep)||!fs.existsSync(p))throw appError('归档文件不存在，请重新生成',404);return {buffer:fs.readFileSync(p),type:'application/pdf',name:id+'-8D报告.pdf'};}throw appError('未知归档操作');}
 return {api,generate,makePdf,async resume(){for(const a of store.list('archive').filter(a=>a.status==='generating')){const item=store.get('analyses',a.analysisId);if(item)await generate(item,{retry:true});}}};
}
