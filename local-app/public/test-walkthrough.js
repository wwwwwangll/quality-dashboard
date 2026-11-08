(function(root){'use strict';
// An instructional cursor only: advancing/skipping never invokes business writes.
function stepsFor(user,analysis,queue=[]){const can=k=>user.role==='admin'||user.permissions?.includes(k),steps=[];
 const add=(id,title,text,route,stage,target)=>steps.push({id,title,text,route,stage,target});
 if(!analysis){add('welcome','从这里开始测试','先看当前账号的姓名、权限组。指引只帮助定位，不会替你提交、验收或关单。','work');if(can('analysis.start'))add('start','选择报故并开启8D','打开“报故与初步分析”，选择一条问题，核对基础信息，再点击开启8D。不要把所有报故都开启分析。','faults',null,'[data-open-fault]');add('todo','查看属于自己的待办','在“我的分析与待办”选择一个分派给自己的任务；没有任务时，先用质量部账号分派，再切换回来。','work');if(user.role==='admin')add('users','准备协作账号','账号与权限组中可查看27个默认账号，修改组权限或个人覆盖。固定初始密码见安装目录“测试账号密码表.txt”。','users');if(can('pdf.view'))add('archive','查阅已关闭报告','进入8D报告库，按料号、产品名称或报告编号搜索并打开PDF。','archives');return steps;}
 if(can('analysis.manage')){
  add('follow','先看当前分析进度','跟进概览集中显示待分配、待验收、待阶段确认。你可以跨阶段配置分工；阶段确认仍遵循闭环规则。',null,'follow');
  const text={D1:'组建团队；为九个分析维度逐一指定责任人、完成期限及照片要求。团队职责自动带入，可按实际调整。',D2:'核对自动带入的报故信息；打开统一确认窗口，选择问题分类、是否冻结，并分派变更管理员和期限。编号及数量由责任人填写，现场补充选填。',D3:'分别分派六类数量及返工方案。数量由责任人填写、提交即完成，无须验收及计分；返工方案按选择的范围上传资料。',D4:'九宫格由各责任人排查。无问题可直接确认；确定根因时补充描述与证据；还需拆分时最多到L4。质量人员通过或驳回，驳回原因至少20字。',D5:'已通过的根因在外面显示；针对具体根因手写永久措施，分派责任人、期限和证据要求。',D6:'查看永久措施，只为需要实验的措施创建实验任务；设置验证人员、期限和证据。并检查下次生产通知／复核配置。',D7:'勾选适用的预防措施，再指定人员、期限、证据与审批人。按实际填写横向展开、经验教训及类似问题关联。',D8:'核对全部阶段和贡献评价；满足既有条件后确认阶段并关单。系统生成PDF，失败可重试。'};
  for(const stage of Object.keys(text))add(stage,stage+' · '+({D1:'团队与分工',D2:'问题及冻结',D3:'临时遏制',D4:'九宫格分析',D5:'永久措施',D6:'实施验证',D7:'防止再发',D8:'总结归档'}[stage]),text[stage]+' 填写后请点击业务窗口“确定”，看到提交提示，再回到指引点“下一步”。',null,stage);
 }else{
  add('own','打开自己当前的任务','点击“跟进概览”中的本人待办。任务按顺序办理；其他步骤可以查看，不能跳过未完成任务。',null,'follow');
  const own=(analysis.workflow?.tasks||[]).filter(t=>t.owner===user.id&&!t.archived&&!['accepted','cancelled','completed'].includes(t.status));
  for(const t of own)add('task:'+t.id,t.title||'完成分派任务',t.kind==='grid'?'打开九宫格，在卡片选择无问题、有问题或待确认。仅确认根因时填写原因及证据；正式提交后等待质量人员审核。':t.stage==='D2'?'料号、SN自动带入。填写分派给你的冻结编号及生产／发货数量，无则填0、未知先存草稿；点击确定提交。':'填写本人任务所需内容及证据。必填未完成不能提交；完成后按提示办理下一项，待验收任务无需重复提交。',null,t.stage,'[data-open-task="'+t.id+'"]');
  add('submitted','检查提交状态','操作成功应显示“已完成提交”或对应成功提示；重新打开应能看到保存内容。待验收任务等待质量人员确认，驳回后按原因补充。',null,'follow');
 }
 return steps;
}
root.TestWalkthroughSteps=stepsFor;
root.TestWalkthrough=function(ctx){const {S,E,render,renderDialogs,toast}=ctx;let state=null,lastKey='',rootEl;
 const key=()=> 'quality-tutorial-v43:'+S.user.id+':'+(S.analysis?.id||'workspace');
 function save(){try{localStorage.setItem(lastKey,JSON.stringify(state));}catch{}}
 function load(){if(!S.user||S.data?.environment!=='test')return false;const k=key();if(k!==lastKey){lastKey=k;try{state=JSON.parse(localStorage.getItem(k)||'null');}catch{state=null;}state ||= {index:0,open:true,skipped:[]};}return true;}
 function paint(){if(!load()){document.getElementById('testTutorial')?.remove();return;}const steps=stepsFor(S.user,S.analysis,S.data.queues?.rows),i=Math.min(state.index,steps.length-1),step=steps[i];if(!step)return;const dialog=document.querySelector('#formModal > .modal-head')||document.querySelector('#analysisModal > .modal-head');const page=document.querySelector('#page');if(!dialog&&!page)return;rootEl=document.getElementById('testTutorial');if(!rootEl){rootEl=document.createElement('aside');rootEl.id='testTutorial';rootEl.setAttribute('aria-label','测试操作指引');}if(dialog){if(dialog.nextElementSibling!==rootEl)dialog.after(rootEl);}else if(page.previousElementSibling!==rootEl)page.before(rootEl);rootEl.innerHTML=state.open?'<div class="tutorial-card"><div class="title-row"><strong>测试操作指引 '+(i+1)+' / '+steps.length+'</strong><button type="button" class="work-btn compact" data-tutorial="hide" aria-label="收起指引">收起</button></div><h3>'+E(step.title)+'</h3><p>'+E(step.text)+'</p><small>跳过只跳过本条提示，不代表任务完成。</small><div class="action-row"><button class="work-btn" data-tutorial="locate">前往此步骤</button><button class="work-btn" data-tutorial="skip">跳过提示</button><button class="work-btn accent" data-tutorial="next">'+(i===steps.length-1?'完成指引':'下一步')+'</button></div><button class="tutorial-restart" data-tutorial="restart">从头查看</button></div>':'<button class="work-btn accent" data-tutorial="show">测试操作指引</button>';}
 function navigate(step){if(step.route){S.forms=[];S.analysis=null;S.route=step.route;render();renderDialogs();}else if(step.stage&&S.analysis){S.forms=[];S.stage=step.stage;renderDialogs();}if(step.target){const el=document.querySelector(step.target);if(el){el.scrollIntoView({block:'center',behavior:'smooth'});el.classList.add('tutorial-target');setTimeout(()=>el.classList.remove('tutorial-target'),3000);}}}
 document.addEventListener('click',e=>{const b=e.target.closest('[data-tutorial]');if(!b)return;e.preventDefault();e.stopImmediatePropagation();if(!load())return;const steps=stepsFor(S.user,S.analysis),action=b.dataset.tutorial,i=Math.min(state.index,steps.length-1);if(action==='locate'){navigate(steps[i]);return paint();}if(action==='hide')state.open=false;if(action==='show')state.open=true;if(action==='restart'){state.index=0;state.open=true;}if(['next','skip'].includes(action)){if(action==='skip')state.skipped.push(steps[i].id);if(i<steps.length-1){state.index=i+1;if(S.analysis&&steps[state.index].stage)navigate(steps[state.index]);}else{state.open=false;toast('操作指引已完成；实际任务以系统状态为准');}}save();paint();},true);
 return {paint,steps:()=>stepsFor(S.user,S.analysis)};
};
})(typeof window==='undefined'?globalThis:window);
