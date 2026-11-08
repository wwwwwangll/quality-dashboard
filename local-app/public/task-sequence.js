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
    return d?G.reviewNodes(d).filter(G.nodeDraft).map(n=>({stage:'D4',taskId:t.id,dimension:d.id,nodeId:n.id,label:d.label+' / L'+n.level+' '+(n.label||'待填写标题'),due:t.due})):[];
   });
 }
 function allowed(item,user,taskId,nodeId='',W=root.AnalysisWorkflow,G=root.NineGrid){
  if(manager(user))return true;
  const queue=pending(item,user,W,G),first=queue[0];
  if(item?.nineGrid?.version===2&&first?.stage==='D4'&&queue.some(row=>row.taskId===taskId&&row.dimension)){
   const d=item.nineGrid.dimensions.find(d=>d.taskId===taskId);
   return !nodeId||G.flat(d.nodes).some(n=>n.id===nodeId&&G.nodeDraft(n));
  }
  return !!first&&first.taskId===taskId&&(!nodeId||first.nodeId===nodeId);
 }
 root.TaskSequence={pending,allowed,manager};
})(typeof window!=='undefined'?window:globalThis);
