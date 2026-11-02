(function(root){'use strict';
const C=()=>root.AnalysisCore,W=()=>root.AnalysisWorkflow,G=()=>root.NineGrid;
const hints={D1:'依次指定九个维度的分析负责人、期限和照片要求，系统自动带入团队职责。',D2:'核对报故事实；统一设置分类并分派变更管理员填报冻结编号与数量，现场补充描述选填。',D3:'记录临时遏制，分派六类数量及返工方案；数量由责任人填写。',D4:'跟进九宫格排查，逐条审核结论；等待分析时不会让你代填。',D5:'针对每个通过的根因建立永久措施，再分派实施人员和期限。',D6:'按实际需要选择措施开展实验，验收已安排的验证，并明确临时措施能否撤除。',D7:'选择防止再发措施，完成横向展开、经验教训等适用内容。',D8:'完成总结和贡献评价，满足条件后关单并生成PDF。'};
function current(x){return C().stages.find(s=>!W().stageComplete(x,s.id))?.id||'D8';}
function plan(x,user,users=[],requestedStage){
 const stage=requestedStage||current(x),actions=[],waiting=[],manager=user.role==='admin'||user.permissions?.includes('analysis.manage'),assign=user.role==='admin'||user.permissions?.includes('tasks.assign'),review=user.role==='admin'||user.permissions?.includes('tasks.review'),live=id=>users.some(u=>u.id===id&&u.enabled!==false&&!u.archived),add=(label,type,extra={})=>actions.push({label,type,...extra});
 if(x.status!=='active')return {stage,actions,waiting,closed:true,hint:'报告已关闭，可查看历史和归档PDF。'};
 const tasks=x.workflow.tasks.filter(t=>t.stage===stage&&W().taskEnabled(x,t)&&!t.gridRoot&&t.kind!=='grid'&&t.kind!=='production');
 const issues=W().checklist(x).filter(i=>i.stage===stage&&!i.taskId&&i.type!=='confirmation');
 if(stage==='D1'&&x.nineGrid&&manager){for(const d of x.nineGrid.dimensions){const t=x.workflow.tasks.find(t=>t.id===d.taskId);if(!live(t?.owner)||!t.due||![1,2,3].includes(Number(t.base)))add((t?.owner&&!live(t.owner)?'重新分派已停用人员的任务：':'分派分析任务：')+d.label,'dimension',{dimension:d.id});}if(x.stages.D1.requiresEvidence&&!x.stages.D1.files?.length&&!x.stages.D1.links?.length)add('补充D1要求的阶段证据','evidence');}
 else if(stage==='D4'&&x.nineGrid){for(const d of x.nineGrid.dimensions){const t=x.workflow.tasks.find(t=>t.id===d.taskId);if(!live(t.owner)||!t.due){if(assign)add('重新分派：'+d.label,'dimension',{dimension:d.id});continue;}for(const n of G().leaves(d.nodes)){if(n.review==='submitted'&&review)add('审核：'+d.label+' / L'+n.level+' '+n.label,'node',{dimension:d.id,node:n.id});else if(['draft','returned'].includes(n.review)&&t.owner===user.id)add('填写：'+d.label+' / L'+n.level+' '+n.label,'node',{dimension:d.id,node:n.id});}if(t.status!=='accepted'&&t.owner!==user.id&&!G().leaves(d.nodes).some(n=>n.review==='submitted'))waiting.push({label:d.label,owner:t.owner,due:t.due,type:'grid',dimension:d.id});}}
 else {
  if(stage==='D2'&&manager){const s=x.stages.D2.fields,r=x.revised;if(!s.description?.trim()||!s.condition?.trim()||!s.impact?.trim()||!r.product||!r.model||!r.customer||!(Number(r.quantity)>0)||Object.keys(r).some(k=>String(r[k])!==String(x.snapshot[k]))&&!s.editReason?.trim())add('核对并补全报故基础信息','basic');}
  if(stage==='D5'&&manager&&!x.stages.D5.na)for(const cause of W().causes(x).filter(c=>W().causeReady(x,c)))if(!tasks.some(t=>t.kind==='measure'&&t.causeId===cause.id))add('制定永久措施：'+(cause.result||cause.title),'measure',{cause:cause.id});
  if(stage==='D2'&&assign){const d=x.workflow.d2,t=x.workflow.tasks.find(t=>t.id===d.fillTaskId);if(!d.unified||!t||!live(t.owner)||!t.due)add('确认D2设置并分派变更管理员','d2');}
  for(const i of manager?issues:[]){if(stage==='D2')continue;if(stage==='D3'&&/临时措施|执行结果/.test(i.label))continue;const target=stage==='D2'?{key:'D2:classification'}:stage==='D6'?{match:/首产|通知|生效日/.test(i.label)?'下次生产':'临时措施是否可以撤除'}:stage==='D7'?{match:/防止再发|预防措施/.test(i.label)?'防止再发':/横向/.test(i.label)?'横向展开':/经验/.test(i.label)?'经验教训':'防止再发'}:stage==='D8'?{key:/加分|贡献/.test(i.label)?'D8:scores':'native:D8'}:{key:'native:'+stage};if(!actions.some(a=>a.type==='entry'&&a.key===target.key&&a.match===target.match))add(i.label,'entry',target);}
  if(stage==='D8'&&manager&&!x.stages.D8.fields.summary?.trim()&&!actions.some(a=>a.key==='native:D8'))add('填写分析总结与遗留问题结论','entry',{key:'native:D8'});
  for(const t of tasks){if(stage==='D2'&&t.kind!=='d2-fill')continue;if(t.status==='accepted')continue;const missing=!live(t.owner)||!t.due||!W().isQuantity(t)&&![1,2,3].includes(Number(t.base));if(missing&&assign)add('分派任务：'+t.title,'task',{task:t.id});else if(t.status==='submitted'&&review)add('验收：'+t.title,'task',{task:t.id});else if(t.owner===user.id&&['draft','returned'].includes(t.status))add('完成自己的任务：'+t.title,'task',{task:t.id});else waiting.push({label:t.title,owner:t.owner,due:t.due,type:'task',task:t.id});}
 }
 const error=C().validateStage(x,stage);
 if(manager&&!actions.length&&!waiting.length&&error&&stage===current(x))add(error,'entry',{match:stage==='D7'?'防止再发':'',key:stage==='D8'?'native:D8':undefined});
 const ready=!error&&!actions.length&&!waiting.length;
 if(ready&&manager&&stage===current(x)){if(C().stages.every(s=>W().stageComplete(x,s.id))){const e=C().closureError(x);if(e)waiting.push({label:e});else add('确认关单并生成PDF','close');}else add('确认完成'+stage+'，进入'+(stage==='D8'?'关单检查':'D'+(Number(stage.slice(1))+1)),'finish');}
 return {stage,hint:hints[stage],actions,waiting,error,ready,manager,allStagesDone:C().stages.every(s=>W().stageComplete(x,s.id))};
}
root.AnalysisGuide={current,plan,hints};

root.AnalysisGuideUI=function(ctx){
 const {S,E,$,renderDialogs,pushForm,command,refresh,toast,run,manage,openTask,basicEditor,originalStageHTML}=ctx;
 let busy=false;
 const get=(stage)=>plan(S.analysis,S.user,S.data.users,stage);
 function board(){
  const x=S.analysis,manager=manage(),rows=[];
  if(x.status!=='active')return {rows,manager};
  if(manager){
   for(const s of C().stages){
    const p=get(s.id);
    for(const a of p.actions)rows.push({...a,stage:s.id,category:['finish','close'].includes(a.type)||/^(审核|验收)/.test(a.label)?'confirm':a.type==='dimension'||a.type==='d2'||/^分派/.test(a.label)?'assign':a.task||a.node?'todo':'setup'});
   }
  }else{
   const list=root.TaskSequence.pending(x,S.user);
   for(const [index,t]of list.entries())rows.push({stage:t.stage,label:t.label,type:t.nodeId?'node':'task',dimension:t.dimension,node:t.nodeId,task:t.taskId,category:'todo',blocked:index>0});
  }
  return {rows,manager};
 }
 function panel(){
  const x=S.analysis,{rows,manager}=board(),progress=W().progress(x);
  const counts={assign:0,confirm:0,todo:0,setup:0};rows.forEach(r=>counts[r.category]++);
  const submitted=x.workflow.tasks.filter(t=>t.owner===S.user.id&&W().taskEnabled(x,t)&&t.status==='submitted'&&!t.gridRoot).length;
  return '<section class="guide-panel follow-board" aria-label="我的8D跟进看板"><div class="title-row"><h2>我的8D跟进看板</h2><button class="work-btn" data-guide="refresh">刷新进度</button></div><p class="help">'+(manager?'可自由切换D1—D8提前分派；阶段确认仍按闭环条件进行。':'按顺序办理自己的任务，提交成功后自动进入下一项；其他记录可查看。')+'</p><div class="kpis">'+[['阶段完成',progress.stagesDone+'/8'],...(manager?[['待分配',counts.assign],['待确认',counts.confirm],['待设置',counts.setup]]:[['待完成',counts.todo],['已提交待验收',submitted]])].map(([l,n])=>'<div class="kpi"><small>'+l+'</small><b>'+n+'</b></div>').join('')+'</div><div class="follow-stage-grid">'+C().stages.map(s=>{
   const entries=rows.map((a,index)=>({...a,index})).filter(a=>a.stage===s.id),done=W().stageComplete(x,s.id);
   return '<article class="follow-stage-card"><h3>'+s.id+' · '+E(s.name)+(done?' <span class="tag good">已确认</span>':'')+'</h3>'+(entries.length?entries.map(a=>'<button class="row-button" data-guide="board-action" data-index="'+a.index+'" '+(a.blocked?'disabled':'')+'><strong>'+E(a.label)+'</strong><small>'+({assign:'待分配',confirm:'待确认',todo:a.blocked?'等待前项提交':'待完成',setup:'待设置'})[a.category]+' →</small></button>').join(''):'<p class="help">当前没有需要你办理的事项</p>')+'</article>';
  }).join('')+'</div>'+(manager?'<button class="work-btn accent" data-guide="next">继续当前未完成步骤</button>':'')+'</section>';
 }
 function entry(a){
  if(a.type==='basic')return basicEditor();if(a.type==='evidence')return ctx.v4().evidence();
  let record=a.key&&S.entries.get(a.key);if(!record&&a.match)record=[...S.entries.values()].find(e=>e.title.includes(a.match));
  if(record)return pushForm({type:'config',key:[...S.entries].find(([,v])=>v===record)[0],title:record.title,html:record.html,readonly:false});
  const f={type:'config',title:S.stage+' · '+(a.match||'补充阶段内容'),readonly:false};
  f.render=()=>{const original=S.analysis;try{if(f.temp)S.analysis=f.temp;return originalStageHTML();}finally{S.analysis=original;}};pushForm(f);
 }
 async function act(a){
  if(!a||a.blocked)return;
  S.forms=[];S.stage=a.stage||get().stage;renderDialogs();
  if(a.type==='d2')return ctx.v4().openD2();if(a.type==='dimension')return ctx.v4().assign(a.dimension);
  if(a.type==='node')return ctx.v4().openNode(a.dimension,a.node);if(a.type==='task')return openTask(a.task);
  if(['entry','basic','evidence'].includes(a.type))return entry(a);
  if(a.type==='measure'){const created=await command('create-measure',{causeId:a.cause});const id=created.newTaskId;await refresh();return openTask(id);}
  if(a.type==='finish'){await command('finish-stage',{stage:S.stage});await refresh();S.stage='follow';renderDialogs();toast('阶段已确认，跟进看板已更新');return;}
  if(a.type==='close'){if(!root.confirm('确认完成8D并生成归档PDF？'))return;await command('close');await refresh();S.stage='follow';renderDialogs();toast('8D已关闭，PDF已请求生成');}
 }
 async function next({automatic=false}={}){
  S.guided=true;const stage=/^D[1-8]$/.test(S.stage)?S.stage:current(S.analysis),p=get(stage);
  const a=p.actions.find(a=>!automatic||!['finish','close'].includes(a.type));
  if(a)return act({...a,stage});
  S.forms=[];S.stage='follow';renderDialogs();
  toast(p.waiting.length?'已保存分派，等待责任人处理':'当前内容已保存，请在跟进看板继续办理');
 }
 function attach(){
  const x=S.analysis;if(!x)return;
  if(S.stage==='follow'){const main=$('#analysisMain');if(main)main.innerHTML=panel();}
  const button=$('[data-action="finish-stage"]');
  if(button){const err=C().validateStage(x,S.stage),previous=C().stages.slice(0,C().stages.findIndex(s=>s.id===S.stage)).some(s=>!W().stageComplete(x,s.id));button.disabled=!!err||previous;button.title=err||(previous?'可以提前分派；请先确认前序阶段':'');}
  const close=$('[data-action="close-8d"]');if(close){close.disabled=!!C().closureError(x);close.title=C().closureError(x)||'';}
 }
 document.addEventListener('click',ev=>{
  const el=ev.target.closest('[data-guide]');if(!el)return;ev.preventDefault();ev.stopImmediatePropagation();if(busy||el.disabled)return;
  run(async()=>{busy=true;try{if(el.dataset.guide==='refresh'){await refresh();return toast('进度已刷新');}if(el.dataset.guide==='board-action')return await act(board().rows[Number(el.dataset.index)]);await next();}finally{busy=false;}});
 },true);
 return {attach,next,current:()=>current(S.analysis),plan:get,board,panel};
};
})(typeof window!=='undefined'?window:globalThis);
