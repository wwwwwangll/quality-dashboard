(function(root){'use strict';
root.GridUI=function(ctx){
 const {S,E,$,command,refresh,pushForm,renderDialogs,toast,manage,person,field,photos,filesHTML,run}=ctx,G=root.NineGrid;
 const dim=id=>G.dimension(S.analysis,id),task=d=>S.analysis.workflow.tasks.find(t=>t.id===d.taskId),node=(d,id)=>G.flat(d.nodes).find(n=>n.id===id);
 const review={draft:'未提交',returned:'退回补充',submitted:'已提交 · 待审核',accepted:'已通过'};
 const choice=n=>n.rootCause?'root':n.status||'';
 const custom=()=>S.analysis.nineGrid?.version===2;
 const canEdit=(d,n)=>S.analysis.status==='active'&&task(d).owner===S.user.id&&!!task(d).due&&root.TaskSequence.allowed(S.analysis,S.user,d.taskId,n.id)&&G.nodeDraft(n)&&(custom()||!n.children.length);
 const options=[['','请选择'],['clear','不是根因／无问题'],['root','是根本原因'],['issue','有问题，继续分析'],['pending','待确认']];
 const actionLabel=v=>({clear:'确认并提交',root:'填写根因与证据',issue:'继续下层分析',pending:'保存待确认'})[v]||'先选择判断';
 function openGrid(id,parentId='',notice=''){
  if(!dim(id))return;
  if(custom())return openCustomGrid(id,notice);
  const f={type:'v4-grid',dimension:id,parentId,title:dim(id).label+' · '+(parentId?'L'+(node(dim(id),parentId).level+1):'L1')+'分析',choices:{}};
  f.render=()=>{const d=dim(id),t=task(d),parent=parentId?node(d,parentId):null,ns=parent?.children||d.nodes;
   return '<div class="v4-row"><span>负责人：'+E(person(t.owner).name)+'</span><span>期限：'+E(t.due||'尚未分派')+'</span>'+(manage()&&S.analysis.status==='active'?'<button class="work-btn" data-v4="assign" data-dimension="'+id+'">调整分派</button>':'')+'</div>'+(notice?'<p class="grid-success" role="status">'+E(notice)+'</p>':'')+'<p class="help">直接选择判断后确认。只有根因需要填写详细描述和证据；有问题但未明确时，可继续分析到L4。已提交的结果在原卡片保留。</p>'+(parent?'<button class="work-btn compact" data-v4="grid" data-dimension="'+id+'" '+(parent.parent?'data-parent="'+parent.parent+'"':'')+'>返回上一层</button>':'')+'<div class="v4-grid grid-simple">'+ns.map(n=>{
    const editable=canEdit(d,n),v=f.choices[n.id]??choice(n),waiting=n.review==='submitted';
    return '<article class="v4-grid-card '+E(n.status)+'" data-node-card="'+E(n.id)+'"><small>L'+n.level+' · '+E(review[n.review])+'</small><button type="button" class="grid-card-title" data-v4="node" data-dimension="'+id+'" data-node="'+n.id+'"><strong>'+E(n.label)+'</strong></button><label>是否为根本原因 <small>（必选）</small><select aria-label="'+E(n.label)+'判断" data-grid-choice data-dimension="'+id+'" data-node="'+n.id+'" '+(!editable?'disabled':'')+'>'+options.map(([key,label])=>'<option value="'+key+'" '+(v===key?'selected':'')+' '+(key==='issue'&&n.level>=4?'disabled':'')+'>'+label+'</option>').join('')+'</select></label>'+(n.description?'<p class="grid-summary">'+E(n.description.slice(0,100))+'</p>':'')+(n.rootCause?'<small>根因证据 '+(n.files?.length||0)+' 份</small>':'')+(n.returnReason?'<p class="error">驳回：'+E(n.returnReason)+'</p>':'')+'<div class="v4-row">'+(n.children.length?'<button type="button" class="work-btn" data-v4="grid" data-dimension="'+id+'" data-parent="'+n.id+'">进入下层分析</button>':editable?'<button type="button" class="work-btn accent" data-v4="grid-apply" data-dimension="'+id+'" data-node="'+n.id+'" '+(!v?'disabled':'')+'>'+actionLabel(v)+'</button>':'<button type="button" class="work-btn" data-v4="node" data-dimension="'+id+'" data-node="'+n.id+'">'+(manage()&&waiting?'审核结论':'查看已提交结果')+'</button>')+'</div></article>';
   }).join('')+'</div>';
  };pushForm(f);
 }
 function openCustomGrid(id,notice=''){
  const f={type:'v4-grid',dimension:id,title:dim(id).label+' · 自定义根因分析',titles:Object.create(null)};
  f.render=()=>{
   const d=dim(id),t=task(d),all=G.flat(d.nodes),reviewable=G.reviewNodes(d);
   const buttons=(n,actions)=>actions.map(([key,label])=>'<button type="button" class="work-btn compact'+(key==='custom-remove'?' danger':'')+'" data-v4="'+key+'" data-dimension="'+E(id)+'" data-node="'+E(n.id)+'">'+label+'</button>').join(' ');
   return '<div class="v4-row"><span>负责人：'+E(person(t.owner).name)+'</span><span>期限：'+E(t.due||'尚未分派')+'</span><span>已审核 '+reviewable.filter(n=>n.review==='accepted').length+'/'+reviewable.length+'</span></div>'+
    (notice?'<p class="grid-success" role="status">'+E(notice)+'</p>':'')+
    '<p class="help">填写分析方向，可自由新增同级或下级，最多到 L4。确定根因后填写详细描述并附证据。已排除的末级方向可直接提交无问题结论。</p>'+
    all.map(n=>{
     const editable=canEdit(d,n),parent=node(d,n.parent),structural=['draft','returned'].includes(t.status);
     const actions=editable?[['custom-save','保存方向'],['custom-root','认定为根本原因']]:[];
     if(editable&&structural){
      if(!parent||G.nodeDraft(parent))actions.push(['custom-sibling','＋ 同级']);
      if(n.level<4)actions.push(['custom-child','＋ 下级']);
      if((all.length>1)&&(!parent||G.nodeDraft(parent))&&G.flat([n]).every(G.nodeDraft))actions.push(['custom-remove','删除']);
     }
     if(editable&&!n.children.length&&!n.rootCause)actions.push(['custom-clear','无问题，提交审核']);
     if(!editable)actions.push(['node',manage()&&n.review==='submitted'?'审核结论':'查看详情']);
     return '<article class="panel" style="margin-inline-start:'+(n.level-1)*12+'px"><div class="v4-row"><strong>L'+n.level+'</strong><span>'+E(review[n.review])+'</span>'+(n.rootCause?'<span class="tag">根本原因</span>':'')+'</div>'+
      (editable?'<label>分析方向<input data-custom-title="'+E(n.id)+'" maxlength="100" placeholder="填写分析方向" value="'+E(f.titles[n.id]??n.label)+'"></label>':'<p>'+E(n.label||'待填写标题')+'</p>')+
      (n.description?'<p class="text-wrap">'+E(n.description)+'</p>':'')+(n.returnReason?'<p class="error">驳回：'+E(n.returnReason)+'</p>':'')+
      '<div class="v4-row">'+buttons(n,actions)+'</div></article>';
    }).join('');
  };
  pushForm(f);
 }
 function readNode(){const f=S.forms.at(-1),form=$('#v4Node'),n=node(dim(f.dimension),f.nodeId);const rootCause=form.elements.rootCause.value==='true';return {label:form.elements.label?.value??n.label,status:rootCause?'issue':form.elements.status?.value||n.status,description:form.elements.description?.value??n.description,rootCause,files:f.files,links:f.links};}
 function openNode(id,nodeId,initial){
  const d=dim(id),n=node(d,nodeId);if(!n)return;
  const f={type:'v4-node',dimension:id,nodeId,title:d.label+' / L'+n.level+' · '+(n.label||'待填写标题'),files:G.copy(n.files||[]),links:G.copy(n.links||[]),draft:initial?{...G.copy(n),...initial}:null};
  f.render=()=>{const d=dim(id),n=node(d,nodeId),editable=canEdit(d,n),v=f.draft||n;
   return '<div class="v4-row"><span class="tag">'+E(review[n.review])+'</span><span>负责人：'+E(person(task(d).owner).name)+'</span></div>'+(n.review==='submitted'?'<p class="grid-success">已经完成提交，等待质量工程师审核。</p>':'')+(n.returnReason?'<p class="v4-review returned">'+E(n.returnReason)+'</p>':'')+'<form id="v4Node" class="v4-form">'+field('分析选项','label',v.label,'text',editable?'':'disabled')+'<label>是否为根本原因<select name="rootCause" '+(!editable?'disabled':'')+'><option value="false" '+(!v.rootCause?'selected':'')+'>不是／尚未明确</option><option value="true" '+(v.rootCause?'selected':'')+'>是根本原因</option></select></label>'+(v.rootCause?'<input type="hidden" name="status" value="issue"><p class="wide">已确认根因 · 红灯</p>':'<label>判断<select name="status" '+(!editable?'disabled':'')+'><option value="">请选择</option>'+[['clear','无问题'],['pending','待确认'],['issue','有问题，继续分析']].map(([key,label])=>'<option value="'+key+'" '+(v.status===key?'selected':'')+'>'+label+'</option>').join('')+'</select></label>')+(v.rootCause?'<div class="wide">'+field('根因详细描述','description',v.description,'textarea',editable?'':'disabled')+'</div>'+(editable?filesHTML(f,task(d).evidenceRequired,'根因证据与照片'):'<div class="wide">'+photos(n.files||[])+(n.links||[]).map(l=>'<p><a href="'+E(l.url)+'" target="_blank" rel="noopener">'+E(l.name)+'</a></p>').join('')+'</div>'):n.description?'<p class="wide text-wrap">'+E(n.description)+'</p>':'')+'</form>'+(n.children.length?'<button type="button" class="work-btn" data-v4="grid" data-dimension="'+id+'" data-parent="'+n.id+'">进入下层分析</button>':'')+'<p class="v4-requirements" data-v4-errors></p>'+(editable?'<div class="v4-row"><button type="button" class="work-btn" data-v4="node-save">保存草稿</button><button type="button" class="work-btn accent" data-v4="node-submit">提交审核</button>'+(!custom()&&!v.rootCause&&n.level<4?'<button type="button" class="work-btn" data-v4="split">继续下层分析</button>':'')+'</div>':'')+(manage()&&n.review==='submitted'?'<section class="v4-review"><h3>质量工程师审核</h3>'+field('审核说明／驳回原因（驳回至少20字）','reviewReason','','textarea')+'<div class="v4-form"><label>主动性<select name="initiative"><option value="80">80 · 按计划履职</option><option value="100">100 · 主动推动</option><option value="60">60 · 经催办完成</option><option value="0">0 · 无贡献</option></select></label><label>证据有效性<select name="evidenceScore"><option value="100">100 · 有效</option><option value="80">80 · 补充后通过</option><option value="60">60 · 补做后通过</option></select></label></div><p class="help">维度全部审核后只计分一次。</p><button type="button" class="work-btn accent" data-v4="node-accept">通过</button> <button type="button" class="work-btn danger" data-v4="node-return">驳回</button></section>':'')+(n.history?.length?'<section><h4>提交与审核历史</h4>'+n.history.map(h=>'<div class="v4-audit">'+E(h.at)+' · '+E(person(h.by).name)+' · '+E(review[h.action]||h.action)+'<p>'+E(h.description||h.reason||'')+'</p></div>').join('')+'</section>':'');
  };
  f.capture=()=>{if($('#v4Node'))f.draft=readNode();};
  if(canEdit(d,n))f.save=()=>submit(id,nodeId,readNode());pushForm(f);
 }
 async function returnGrid(id,nodeId,message){await refresh();const d=dim(id),n=node(d,nodeId),previous=S.forms.find(f=>f.dimension===id&&f.titles);S.forms=[];renderDialogs();openGrid(id,n?.parent||'',message);if(previous&&custom()){delete previous.titles[nodeId];Object.assign(S.forms.at(-1).titles,previous.titles);renderDialogs();}toast(message);}
 async function saveNode(){const f=S.forms.at(-1),patch=readNode();await command('grid-save',{dimension:f.dimension,nodeId:f.nodeId,...patch});await refresh();f.draft=null;const n=node(dim(f.dimension),f.nodeId);f.files=G.copy(n.files);f.links=G.copy(n.links);renderDialogs();toast('草稿已保存');return patch;}
 async function submit(id,nodeId,patch){await command('grid-submit',{dimension:id,nodeId,patch});await returnGrid(id,nodeId,'已经完成提交，等待质量工程师审核');}
 function split(id,nodeId){const n=node(dim(id),nodeId);pushForm({type:'v4-split',dimension:id,nodeId,title:'下一层九个分析方向',html:'<form id="v4Split">'+['现象与范围','输入条件','设计与参数','材料与部件','工艺与装配','测试与测量','环境与使用','接口与变更','其他原因'].map((l,i)=>field('方向'+(i+1),'label'+i,l)).join('')+'</form>',save:async()=>{const labels=Array.from({length:9},(_,i)=>$('#v4Split').elements['label'+i].value);await command('grid-save',{dimension:id,nodeId,status:'issue',rootCause:false});await command('grid-split',{dimension:id,nodeId,labels});await refresh();S.forms=[];renderDialogs();openGrid(id,nodeId,'已经完成提交：已建立下层分析');toast('已经完成提交：已建立下层分析');}});}
 const ownsAction=a=>['grid-apply','node-save','node-submit','split','node-accept','node-return','custom-save','custom-root','custom-sibling','custom-child','custom-remove','custom-clear'].includes(a);
 async function click(el){const a=el.dataset.v4,f=S.forms.at(-1),id=el.dataset.dimension||f.dimension,nodeId=el.dataset.node||f.nodeId;
  if(a.startsWith('custom-')){
   const d=dim(id),n=node(d,nodeId);
   if(!n||!canEdit(d,n))throw Error('只能修改分派给自己的未提交分析方向');
   const label=f.titles[nodeId]??n.label;
   if(a==='custom-root')return openNode(id,nodeId,{label,status:'issue',rootCause:true});
   if(a==='custom-clear')return submit(id,nodeId,{label,status:'clear',rootCause:false});
   if(a==='custom-remove'){
    const count=G.flat([n]).length-1;
    if(!confirm(count?'确认删除此分析方向及其 '+count+' 个下级？':'确认删除此分析方向？'))return;
    await command('grid-remove',{dimension:id,nodeId});
    delete f.titles[nodeId];
   }else{
    if(a==='custom-save'||label!==n.label){
     await command('grid-save',{dimension:id,nodeId,label});
     delete f.titles[nodeId];
    }
    if(a==='custom-child'||a==='custom-sibling'){
     await command('grid-add',{dimension:id,parentId:a==='custom-child'?n.id:n.parent});
    }
   }
   await refresh();toast(a==='custom-remove'?'分析方向已删除':a==='custom-save'?'分析方向已保存':'已新增分析方向');return;
  }
  if(a==='grid-apply'){const d=dim(id),n=node(d,nodeId);if(!canEdit(d,n))throw Error('请先完成当前未完成任务，已提交结果可查看');const v=f.choices[nodeId]??choice(n);if(v==='root')return openNode(id,nodeId,{status:'issue',rootCause:true});if(v==='issue')return split(id,nodeId);if(v==='pending'){await command('grid-save',{dimension:id,nodeId,status:'pending',rootCause:false});return returnGrid(id,nodeId,'待确认已保存，尚未完成提交');}if(v==='clear')return submit(id,nodeId,{status:'clear',rootCause:false});throw Error('请先选择判断');}
  if(a==='node-save')return saveNode();if(a==='node-submit')return submit(id,nodeId,readNode());
  if(a==='split'){await saveNode();return split(id,nodeId);}
  if(a==='node-accept'||a==='node-return'){await command('grid-review',{dimension:id,nodeId,decision:a==='node-accept'?'accepted':'returned',reason:$('[name="reviewReason"]').value,initiative:Number($('[name="initiative"]').value),evidenceScore:Number($('[name="evidenceScore"]').value)});return returnGrid(id,nodeId,a==='node-accept'?'已经完成提交：审核通过':'已经完成提交：已驳回并记录原因');}
 }
 function validate(){const f=S.forms.at(-1);if(f?.type!=='v4-node')return;const d=dim(f.dimension),n=node(d,f.nodeId);if(canEdit(d,n)&&$('#v4Node')){const errors=G.nodeIssues({...n,...readNode()},task(d));for(const b of document.querySelectorAll('[data-v4="node-submit"],[data-action="save-form"]'))b.disabled=!!errors.length;const label=$('[data-v4-errors]');if(label)label.textContent=errors.length?'尚缺：'+errors.join('；'):'';}const back=$('[data-v4="node-return"]');if(back)back.disabled=Array.from(($('[name="reviewReason"]')?.value||'').replace(/\s/g,'')).length<20;}
 document.addEventListener('input',ev=>{const f=S.forms.at(-1),id=ev.target.dataset.customTitle;if(id&&f?.titles)f.titles[id]=ev.target.value;});
 document.addEventListener('change',ev=>{const el=ev.target,f=S.forms.at(-1);if(el.hasAttribute('data-grid-choice')&&f?.type==='v4-grid'){f.choices[el.dataset.node]=el.value;const button=el.closest('[data-node-card]').querySelector('[data-v4="grid-apply"]');if(button){button.disabled=!el.value;button.textContent=actionLabel(el.value);}if(el.value==='root')run(()=>openNode(f.dimension,el.dataset.node,{status:'issue',rootCause:true}));return;}if(f?.type==='v4-node'&&el.closest('#v4Node')&&el.name==='rootCause'){f.capture();if(f.draft.rootCause)f.draft.status='issue';renderDialogs();}},true);
 return {openGrid,openNode,readNode,saveNode,validate,ownsAction,click};
};
})(window);
