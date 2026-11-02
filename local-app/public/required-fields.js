(function(root){'use strict';
// These labels describe submission requirements, not whether a draft can be saved.
function annotate(S){const body=document.querySelector('#formBody');if(!body||!S.analysis)return;const f=S.forms.at(-1),x=S.analysis,W=root.AnalysisWorkflow,t=x.workflow.tasks.find(t=>t.id===f?.taskId),stage=S.stage;if(f?.type==='v4-grid')return;
 if(!body.querySelector('.field-requirement-legend'))body.insertAdjacentHTML('afterbegin','<p class="field-requirement-legend">带“必填”的内容用于正式提交；草稿可逐步补充。“条件必填”按当前选择生效，“责任人必填”由任务接收人填写。</p>');
 const basicRequired=['product','model','customer','quantity','description','condition','impact'];
 function rule(el){const k=el.name||el.dataset.wfBind||el.dataset.wfTaskBind||el.dataset.wfLocal||el.dataset.wfArray||el.dataset.wfTaskArray||'';
  if(el.type==='hidden')return '';
  if(k.startsWith('native-')){const required={D1:['goal','weightReason'],D2:['description','condition','impact'],D3:['containment','execution'],D8:['summary']}[stage]||[];return required.includes(k.slice(7))?'必填':'选填';}
  if(f.type==='basic')return k==='editReason'?'条件必填：修改基础信息时':basicRequired.includes(k)?'必填':'选填';
  if(f.type==='transfer'||f.type==='score-transfer')return '必填';
  if(el.dataset.wfBonus)return el.dataset.wfBonus==='points'?'选填，默认0':'条件必填：加分大于0时';
  if(k==='d8.recurrence.reason')return '必填：复发分析需说明';
  if(k.startsWith('recurrence.'))return '条件必填：新建复发分析时';
  if(k.startsWith('similar.'))return '条件必填：添加类似问题关联时';
  if(k==='cancel.reason')return '条件必填：取消实验时';
  if(k.startsWith('order.'))return k==='order.revision'?'选填':'条件必填：模拟订单时';
  if(f.type==='v4-assign')return ['owner','due','base','evidenceRequired'].includes(k)?'必填':'选填';
  if(f.type==='v4-split')return '必填';
  if(f.type==='v4-team')return k==='team-person'?'必填':'自动带入';
  if(f.type==='v4-node'){if(['label','status','rootCause'].includes(k))return '责任人必填';if(k==='description')return '根因必填';if(k==='reviewReason')return '驳回时必填，至少20字';if(['initiative','evidenceScore'].includes(k))return '确认评价时必填';if(el.type==='file')return '条件必填：根因须证据，需要照片时须图片';return '选填';}
  if(f.type==='v4-task'||el.dataset.wfTaskBind){const target=t||x.workflow.tasks.find(t=>t.id===el.dataset.taskId),key=k.replace(/^data\./,'');
   if(['title','owner','due','base','reviewer','evidenceRequired'].includes(key))return '分派时必填';
   if(['quantity','productionQty','shippedQty','scope','criteria','sample','window','decision','result'].includes(key))return '责任人必填';
   if(key==='categories')return '责任人必填，至少选择一项';
   if(['primary','causeId','measureIds'].includes(key))return '必填，关联内容至少一项';
   if(['sn','material','unit'].includes(key))return '自动带入';
   if(['initiative','evidenceScore','ratingReason'].includes(key))return key==='evidenceScore'&&!W.evidenceRequired(target)?'不参与评分':'确认评价时必填';
   if(key==='reviewReason')return '验收或退回时必填';
   if(el.type==='file')return target&&W.evidenceRequired(target)?target.kind==='rework'?'责任人必填：上传返工方案文件':target.kind==='cause'?'责任人必填：上传图片':'责任人必填：附件或有效链接':'选填';
  }
  if(k==='stageNaReason')return '条件必填：选择不适用时';
  if(k==='d6.withdrawal')return '必填';
  if(k==='d8.horizontalReason')return '必填：不开展横向展开时';
  if(k.startsWith('d8.lessons.'))return '条件必填：选择经验教训任务时';
  if(k.startsWith('d8.production.')){const key=k.split('.').at(-1);return ['enabled','revision'].includes(key)?'选填':x.workflow.d8.production.enabled?'必填：启用首产通知时':'选填';}
  if(el.hasAttribute('data-stage-upload')||f.type==='v4-evidence'&&el.type==='file')return x.stages[stage]?.requiresEvidence||f.required?'必填：至少一份阶段证据':'选填';
  if(el.type==='file')return '选填：按任务证据要求提交';
  if(/reason|evidence/i.test(k)&&el.closest('.wf-bonus'))return '条件必填：加分大于0时';
  if(el.required)return '必填';
  return '选填';
 }
 for(const el of body.querySelectorAll('input,select,textarea')){if(el.type==='hidden')continue;const label=el.closest('label');if(!label){if(el.previousElementSibling?.classList.contains('field-requirement'))continue;const mark=rule(el),span=document.createElement('span');span.className='field-requirement optional';span.textContent=(el.getAttribute('aria-label')||el.placeholder||'输入内容')+'（'+mark+'）';el.before(span);continue;}
  // D2 owns its operation-specific labels; do not replace them with generic task rules.
  if(f.type==='v4-d2')continue;
  if(label.querySelector(':scope > .field-requirement'))continue;
  const mark=rule(el);if(!mark)continue;const span=document.createElement('span');span.className='field-requirement '+(/必填/.test(mark)?'required':'optional');span.textContent='（'+mark+'）';label.insertBefore(span,[...label.childNodes].find(n=>n===el||n.nodeType===1&&n.contains(el))||el);
  el.setAttribute('aria-required',String(mark==='必填'||mark==='责任人必填'||mark==='分派时必填'));
 }
}
root.RequiredFields={annotate};
})(window);
