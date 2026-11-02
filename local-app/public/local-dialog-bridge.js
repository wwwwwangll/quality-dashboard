(function(){
 const E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 window.AnalysisDialogs={causeHTML(x,ctx){return ['occurrence','escape'].map(section=>{const tasks=x.workflow.tasks.filter(t=>t.kind==='cause'&&!t.archived&&(section==='occurrence'?t.data.section==='occurrence':['escape','escapeDept'].includes(t.data.section)));return '<section class="wf-cause-group"><div class="wf-section-head"><h4>'+ (section==='occurrence'?'产生原因':'流出原因')+'</h4>'+(ctx.manage?'<button class="work-btn compact" data-local-add-cause="'+section+'">＋ 增加分析人员</button>':'')+'</div>'+tasks.map(t=>window.AnalysisWorkflowUI.taskHTML(x,t,ctx)).join('')+'</section>'}).join('')},reset(){}};
})();
