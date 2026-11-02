(function(root){
 'use strict';
 const manager=user=>user?.role==='admin'||user?.permissions?.includes('analysis.manage');
 // The sequence belongs to this report and this account, never another person's work.
 function pending(item,user,W=root.AnalysisWorkflow,G=root.NineGrid){
  if(!item||item.status!=='active'||!user)return [];
  return (item.workflow?.tasks||[]).map((task,index)=>({task,index}))
   .filter(({task:t})=>t.owner===user.id&&W.taskEnabled(item,t)&&!t.gridRoot&&['draft','returned'].includes(t.status)&&t.due)
   .sort((a,b)=>Number(a.task.stage.slice(1))-Number(b.task.stage.slice(1))||a.index-b.index)
   .flatMap(({task:t})=>{
    if(t.kind==='production'&&!item.workflow.d8.production.productionAt)return [];
    if(t.kind!=='grid')return [{stage:t.stage,taskId:t.id,label:t.title,due:t.due}];
    const d=item.nineGrid?.dimensions.find(d=>d.taskId===t.id);
    return d?G.leaves(d.nodes).filter(n=>['draft','returned'].includes(n.review)).map(n=>({stage:'D4',taskId:t.id,dimension:d.id,nodeId:n.id,label:d.label+' / L'+n.level+' '+n.label,due:t.due})):[];
   });
 }
 function allowed(item,user,taskId,nodeId='',W=root.AnalysisWorkflow,G=root.NineGrid){
  if(manager(user))return true;
  const first=pending(item,user,W,G)[0];
  return !!first&&first.taskId===taskId&&(!nodeId||first.nodeId===nodeId);
 }
 root.TaskSequence={pending,allowed,manager};
})(typeof window!=='undefined'?window:globalThis);
