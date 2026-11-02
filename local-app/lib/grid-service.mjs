import {appError} from './store.mjs';
export function gridCommand(item,body,user,{G,W,manager,files,links,userBy,addMember,now}){
 const fail=m=>{throw appError(m)},check=(v,m)=>{if(!v)fail(m)},text=G.text;
 if(body.action==='enable-nine-grid'){
  check(manager,'仅质量工程师或管理员可启用九宫格');check(!item.nineGrid,'九宫格已启用');G.init(item,W);return;
 }
 const d=G.dimension(item,body.dimension);check(d,'九宫格维度不存在');const t=item.workflow.tasks.find(t=>t.id===d.taskId);check(t,'分析任务不存在');
 if(body.action==='grid-assign'){
  check(manager,'仅质量工程师或管理员可分派');const owner=userBy(body.owner);check(owner&&owner.enabled!==false&&!['viewer','freeze-clerk'].includes(owner.role),'请选择启用的执行账号');check(/^\d{4}-\d{2}-\d{2}$/.test(body.due)&&new Date(body.due+'T00:00:00Z').toISOString().slice(0,10)===body.due,'请选择有效完成期限');check([1,2,3].includes(Number(body.base)),'请选择基础工作分');check(typeof body.evidenceRequired==='boolean','请选择照片要求');check(!['submitted','accepted'].includes(t.status),'已提交或通过的维度不可直接改派');
  addMember(item,owner.id,G.duties[owner.dept]||'负责已分派的分析任务');Object.assign(t,{owner:owner.id,due:body.due,base:Number(body.base),evidenceRequired:body.evidenceRequired,reviewer:user.id,reportingDept:owner.dept,assignmentConfirmedAt:now.toISOString()});return;
 }
 const n=G.flat(d.nodes).find(n=>n.id===body.nodeId);check(n,'分析节点不存在');
 if(body.action==='grid-review'){
  check(manager,'仅质量工程师或管理员可审核');check(n.review==='submitted','请先由责任人提交该结论');check(['accepted','returned'].includes(body.decision),'审核结果无效');const reason=text(body.reason);if(body.decision==='returned')check(Array.from(reason.replace(/\s/g,'')).length>=20,'驳回原因须不少于20字（不含空白）');
  n.review=body.decision;n.history.push({at:now.toISOString(),by:user.id,action:body.decision,reason});n.reviewedBy=user.id;n.reviewedAt=now.toISOString();n.returnReason=body.decision==='returned'?reason:'';
  if(n.rootCause&&n.review==='accepted'){
   let proxy=item.workflow.tasks.find(x=>x.gridNodeId===n.id);if(!proxy){proxy=W.newTask('D4','cause',d.label+' · '+n.label);item.workflow.tasks.push(proxy);}Object.assign(proxy,{gridRoot:true,gridNodeId:n.id,gridDimension:d.id,owner:t.owner,reviewer:user.id,due:t.due,base:0,status:'accepted',result:n.description,scope:'九宫格证据确认根因',files:G.copy(n.files),links:G.copy(n.links),submittedAt:n.submittedAt,acceptedAt:now.toISOString(),data:{section:'occurrence'},submissions:[]});
  }
  const terminal=G.leaves(d.nodes);if(terminal.every(n=>n.review==='accepted')){
   const initiative=Number(body.initiative??80),evidenceScore=Number(body.evidenceScore??100);check([0,60,80,100].includes(initiative),'主动性评分无效');check(!t.evidenceRequired||[60,80,100].includes(evidenceScore),'证据评分无效');
   Object.assign(t,{status:'accepted',result:terminal.map(n=>n.label+'：'+n.description).join('\n'),files:terminal.flatMap(n=>n.files),links:terminal.flatMap(n=>n.links),initiative,evidenceScore,ratingReason:reason||'依据本维度全部已审核排查记录确认',acceptedAt:now.toISOString(),submittedAt:terminal.map(n=>n.submittedAt).sort().at(-1),completedDept:userBy(t.owner)?.dept||'',completedAt:terminal.map(n=>n.submittedAt).sort().at(-1)});t.submissions.push({at:t.submittedAt,status:'accepted',result:t.result});
  }else t.status=terminal.some(n=>n.review==='returned')?'returned':terminal.every(n=>['submitted','accepted'].includes(n.review))?'submitted':'draft';return;
 }
 check(t.owner===user.id,'只有被分派的责任人可以填写分析内容');check(!['submitted','accepted'].includes(n.review),'该结论已提交或通过，不可直接覆盖');
 if(body.action==='grid-save'){
  if(body.label!==undefined){check(text(body.label)&&text(body.label).length<=100,'选项名称须为1至100字');n.label=text(body.label);}
  if(body.status!==undefined){check(['issue','clear','pending'].includes(body.status),'请选择三种判断之一');if(n.children.length)check(body.status==='issue','已有下层分析的节点保持有问题');n.status=body.status;}
  if(body.description!==undefined)n.description=text(body.description).slice(0,12000);if(body.rootCause!==undefined){check(typeof body.rootCause==='boolean','根因标记无效');check(!body.rootCause||!n.children.length,'已有下层节点不能同时提交为根因');n.rootCause=body.rootCause;}
  if(body.files)n.files=files(body.files,user);if(body.links)n.links=links(body.links);return;
 }
 if(body.action==='grid-split'){
  check(n.status==='issue','仅有问题的节点可继续拆分');check(n.level<4,'最多拆分到L4；未确认时保留待确认，不强行认定根因');check(!n.children.length,'该节点已有下层分析');const labels=body.labels||['现象与范围','输入条件','设计与参数','材料与部件','工艺与装配','测试与测量','环境与使用','接口与变更','其他原因'];check(Array.isArray(labels)&&labels.length===9&&labels.every(x=>text(x)&&text(x).length<=100),'下层须有九个有效分析方向');n.rootCause=false;n.children=G.nodes(labels.map(text),n.level+1,n.id);return;
 }
 if(body.action==='grid-submit'){
  check(!n.children.length,'请提交下层具体结论');const errors=G.nodeIssues(n,t);check(!errors.length,errors[0]);n.review='submitted';n.submittedAt=now.toISOString();n.history.push({at:n.submittedAt,by:user.id,action:'submitted',description:n.description,status:n.status,rootCause:n.rootCause,files:G.copy(n.files),links:G.copy(n.links)});t.status=G.leaves(d.nodes).every(n=>['submitted','accepted'].includes(n.review))?'submitted':'draft';return;
 }
 fail('不支持的九宫格操作');
}
