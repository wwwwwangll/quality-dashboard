(function(){
'use strict';
const C=window.AnalysisCore,W=window.AnalysisWorkflow,U=window.AnalysisWorkflowUI;
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)],clone=x=>JSON.parse(JSON.stringify(x)),E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const roleNames={admin:'管理员','quality-engineer':'质量工程师','failure-analyst':'失效分析人员',worker:'执行人员',viewer:'看板与报告查看','freeze-clerk':'变更管理员'};
const permNames={'analysis.manage':'管理完整8D','analysis.start':'开启8D','tasks.assign':'分派任务','tasks.review':'验收与确认','tasks.transfer':'转交自己的任务','imports.manage':'导入OA数据','preliminary.write':'填写初步失效分析','freeze.number.write':'填写D2冻结编号及数量'};
const stateNames={active:'进行中',closed:'已关闭',pending:'待审批',draft:'待完成',returned:'退回补充',submitted:'待验收',accepted:'已完成'};
const S={data:null,user:null,csrf:'',route:'overview',query:'',workFilter:'mine',period:'month',date:C.dateNow(),analysis:null,stage:'follow',forms:[],entries:new Map(),importPreview:null,importSource:null,metrics:null,todoTab:'todo',todoApplied:{},workbench:null,todoLoading:false,busy:false};
let toastTimer,v4,guide,groupAdmin,tutorial;
function toast(s){$('#toast').textContent=s;$('#toast').style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').style.display='none',4500)}
async function api(path,body,method){const opt={method:method||(body===undefined?'GET':'POST'),headers:{}};if(body!==undefined){opt.headers['content-type']='application/json';opt.body=JSON.stringify(body)}if(opt.method!=='GET')opt.headers['x-csrf-token']=S.csrf;const r=await fetch(path,opt);const data=await r.json().catch(()=>({error:'服务返回了无法读取的响应'}));if(!r.ok){const error=new Error(data.error||'请求失败');error.status=r.status;error.details=data.details;throw error}return data}
function can(p){return S.user?.role==='admin'||S.user?.permissions?.includes(p)}
function manage(){return can('analysis.manage')}
function person(id){return S.data?.users?.find(u=>u.id===id)||S.data?.historicalPeople?.find(u=>u.id===id)||{id,name:id||'未指定',dept:''}}
function itemData(value){return value?.item||value?.record||value?.data?.workflow&&value.data||value}
function money(v){return v==null?'待补充':Number(v).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}
function claimMoney(x,k){return x[k+'Cents']!=null?x[k+'Cents']/100:x[k]??null}
function userOpts(selected,all=true){return '<option value="">请选择人员</option>'+S.data.users.filter(u=>u.enabled!==false&&(all||u.role==='failure-analyst'||u.permissions?.includes('preliminary.write'))).map(u=>'<option value="'+E(u.id)+'" '+(selected===u.id?'selected':'')+'>'+E(u.name)+' · '+E(u.dept)+'</option>').join('')}
function field(label,name,value='',type='text',extra=''){return '<label>'+E(label)+(type==='textarea'?'<textarea name="'+name+'" '+extra+'>'+E(value)+'</textarea>':'<input name="'+name+'" type="'+type+'" value="'+E(value)+'" '+extra+'>')+'</label>'}
function sourceHTML(f){return '<div class="source-info">'+[['报故单号',f.id],['报故日期',f.date],['报故人员',f.reporter],['产品名称',f.product],['产品型号',f.model],['料号',f.material||f.partNo||'待补充'],['SN',f.sn],['客户',f.customer],['项目',f.project],['涉及数量',f.quantity==null?'待补充':f.quantity+' pcs']].map(([l,v])=>'<div><span>'+E(l)+'</span><p>'+E(v||'待补充')+'</p></div>').join('')+'<div class="wide"><span>故障描述</span><p class="text-wrap">'+E(f.description)+'</p></div><div class="wide"><span>发生地点与工况</span><p>'+E(f.condition||'待补充')+'</p></div></div>'}
function analysisPreliminaryHTML(x){const old=x.preliminarySnapshot||[],latest=prelimRecords(x.faultId).filter(p=>p.status==='submitted');if(x.status==='closed')return preliminaryHTML(x.faultId,old);const changed=latest.filter(p=>!old.some(v=>v.id===p.id&&v.version===p.version));return preliminaryHTML(x.faultId,old)+(changed.length?'<div class="work-notice">初步分析有更新：以下记录在开启8D后新增或修订。原参考快照仍保留，最新结论不自动作为D4已验证根因。</div>'+preliminaryHTML(x.faultId,changed):'')}
function archiveState(x){const a=(S.data.archives||[]).find(a=>a.analysisId===x.id||a.id===x.id);return ({ready:'已归档',failed:'生成失败，可重试',generating:'正在生成',pending:'等待生成'})[a?.status||x.pdf?.status]||'尚未生成'}
function photos(files=[]){return '<div class="photo-grid">'+files.map(f=>'<a href="/api/files/'+encodeURIComponent(f.id)+'" target="_blank" rel="noopener">'+(String(f.type).startsWith('image/')?'<img loading="lazy" src="/api/files/'+encodeURIComponent(f.id)+'" alt="'+E(f.name)+'"><br>':'↓ ')+E(f.name)+'</a>').join('')+'</div>'}
function historyHTML(rows=[]){return rows.length?rows.map(r=>'<div class="history-row"><small>'+E(r.at||r.date||'')+' · '+E(r.actor||r.by||'')+'</small><span class="text-wrap">'+E(r.text||r.action||r.reason||JSON.stringify(r))+'</span></div>').join(''):'<p class="help">暂无操作记录。</p>'}
function prelimRecords(faultId){return (S.data.preliminary||[]).filter(p=>p.faultId===faultId)}
function preliminaryHTML(faultId,records=null){const a=records||prelimRecords(faultId);return a.length?a.map(p=>'<article class="prelim"><div class="action-row"><h4>'+E(person(p.owner||p.authorId||p.userId).name)+' · 初步分析 <span class="tag">'+(p.status==='submitted'?'已提交':'草稿')+'</span></h4>'+(!records&&(p.owner||p.authorId||p.userId)===S.user.id?'<button class="work-btn compact" data-prelim-edit="'+E(p.id)+'" data-fault="'+E(faultId)+'">编辑我的记录</button>':'')+'</div><p class="help">'+E(p.updatedAt||p.createdAt||'')+(p.due?' · 期限 '+E(p.due):'')+'</p><p><b>现象：</b><span class="text-wrap">'+E(p.phenomenon||'未填写')+'</span></p><p><b>检查过程：</b><span class="text-wrap">'+E(p.process||'未填写')+'</span></p><p><b>初步结论：</b><span class="text-wrap">'+E(p.conclusion||'未填写')+'</span></p>'+photos(p.files)+(p.history?.length?'<button class="work-btn compact" data-prelim-history="'+E(p.id)+'">版本记录</button>':'')+'</article>').join(''):'<p class="help">尚无初步分析记录。初步分析用于后续参考，不代替D4验证。</p>'}
async function refresh(){S.data=await api('/api/bootstrap');S.user=S.data.user;S.csrf=S.data.csrf||S.csrf;S.data.queues=S.user.groupId&&!can('analysis.view')?{rows:[]}:await api('/api/queues');S.workbench=null;if(Array.isArray(S.data.settings))S.data.settings=S.data.settings.find(r=>r.id==='system')||{};C.people.splice(0,C.people.length,...[...S.data.users,...(S.data.historicalPeople||[])].map(u=>({...u,roles:(u.role==='admin'||u.permissions?.includes('analysis.manage'))?['quality-manager']:[]})));const deps=[...new Set([...C.departments,...S.data.users.map(u=>u.dept).filter(Boolean)])];C.departments.splice(0,C.departments.length,...deps);if(S.user.mustChangePassword&&!S.forms.some(f=>f.type==='password'))setTimeout(changePassword,0);if(S.analysis){const current=S.data.analyses.find(x=>x.id===S.analysis.id);if(current)S.analysis=itemData(await api('/api/analyses/'+encodeURIComponent(current.id)))}render();renderDialogs();}
async function boot(){try{const status=await api('/api/status');try{await refresh();await openHash()}catch(e){if(e.status!==401)throw e;renderLogin(status)}}catch(e){$('#app').innerHTML='<div class="login"><h1>本机服务未连接</h1><p class="error">'+E(e.message)+'</p><button class="work-btn" onclick="location.reload()">重试</button></div>'}}
function renderLogin(status){WorkspaceNavigation.unmount();document.getElementById('testTutorial')?.remove();S.data=null;S.user=null;$('#dialogRoot').innerHTML='';$('#app').innerHTML='<div class="login"><div class="brandline">客户质量管理系统</div><h1>'+(status.initialized?'登录':'创建首位管理员')+'</h1><p class="help">'+(status.initialized?'使用管理员分配的真实账号登录。身份与业务权限由服务端验证。':'安装包不包含默认密码，请在本机设置管理员账号。')+'</p><span class="env">'+E(status.environment==='production'?'正式环境':'测试环境 · 模拟数据')+'</span><form id="authForm">'+field('用户名','username','','text','required autocomplete="username"')+(!status.initialized?field('管理员姓名','name','','text','required autocomplete="name"'):'')+field('密码','password','','password','required minlength="10" autocomplete="'+(status.initialized?'current-password':'new-password')+'"')+'<button class="work-btn accent" type="submit">'+(status.initialized?'登录':'创建管理员并进入')+'</button><p id="authError" class="error"></p></form><p class="help">测试和正式数据分别保存。本机关闭时，其他设备无法访问此服务。'+(status.environment==='test'&&status.initialized?'<br>测试初始密码：Test@2026-用户名，例如管理员 admin / Test@2026-admin。<br>完整账号表在安装目录：测试账号密码表.txt；自行改密后以新密码为准。':'')+'</p></div>';$('#authForm').onsubmit=async ev=>{ev.preventDefault();const form=ev.target,b=form.querySelector('button');b.disabled=true;try{const d=await api(status.initialized?'/api/login':'/api/setup',Object.fromEntries(new FormData(form)));S.csrf=d.csrf;await refresh();await openHash()}catch(e){$('#authError').textContent=e.message}finally{b.disabled=false}}}
const recordLists=window.QualityRecords.create({escape:E});
let recordUserId,metricRequest=0;
const nav=[['overview','◈','质量总览'],['todo','▣','我的待办与进度'],['work','◷','8D 分析台账'],['faults','▤','报故与初步分析'],['claims','¥','索赔记录'],['closure','▦','部门按期关闭率'],['archives','▧','8D报告库'],['imports','↑','OA数据导入'],['users','♙','账号权限'],['system','⚙','备份与对接'],['guide','?','使用说明']];
const routePermissions={overview:'dashboard.view',closure:'dashboard.view',faults:'faults.view',claims:'claims.view',archives:'pdf.view',work:'analysis.view',todo:'analysis.view',imports:'imports.manage'};
const navigationGroups=[
  {label:'质量看板',routes:['overview']},
  {label:'我的待办与进度',routes:['todo']},
  {label:'报故与初步分析',routes:['faults']},
  {label:'8D 分析',routes:['work','closure','archives']},
  {label:'索赔记录',routes:['claims']},
  {label:'基础数据与管理',routes:['users','system','guide']}
];
function routeAllowed(id){
  if(!nav.some(([route])=>route===id))return false;
  if(S.user.role==='viewer'&&!['overview','archives','guide'].includes(id))return false;
  if(S.user.role==='freeze-clerk'&&!['work','guide'].includes(id))return false;
  if(['users','system'].includes(id)&&S.user.role!=='admin')return false;
  if(id==='imports'&&!can('imports.manage'))return false;
  return !S.user.groupId||!routePermissions[id]||can(routePermissions[id]);
}
function routeButton(id,label,selected){
  return '<button type="button" data-route="'+id+'"'+(selected?' aria-current="page"':'')+'>'+E(label)+'</button>';
}
function navigationHTML(){
  const groups=navigationGroups.map(group=>({...group,routes:group.routes.filter(routeAllowed)})).filter(group=>group.routes.length);
  const currentRoute=S.route==='imports'?S.importContext?.route:S.route;
  const current=groups.find(group=>group.routes.includes(currentRoute));
  const main=groups.map(group=>routeButton(group.routes[0],group.label,current===group)).join('');
  const sub=current&&current.routes.length>1?'<nav class="review-subnav" aria-label="模块导航">'+current.routes.map(id=>routeButton(id,nav.find(([route])=>route===id)[2],id===S.route)).join('')+'</nav>':'';
  const environment=S.data.environment==='production'?'正式环境':'测试环境';
  return '<header class="review-masthead"><strong>客户质量管理系统</strong><nav class="review-nav" aria-label="主导航">'+main+'</nav><span class="review-badge">'+environment+'</span><details class="review-profile"><summary>'+E(S.user.name)+'</summary><div class="local-profile"><b>'+E(S.user.name)+'</b><small>'+E(S.user.dept)+' · '+E(roleNames[S.user.role])+'</small><button class="work-btn compact" data-action="change-password">修改密码</button><button class="work-btn compact" data-action="logout">退出</button></div></details></header>'+sub;
}
function render(){
  if(!S.data)return;
  pageRenderCount++;
  WorkspaceNavigation.unmount();
  $('#app').innerHTML='<div class="app-shell">'+navigationHTML()+'<div class="main-wrap"><main class="content" id="page" data-ui-route="'+E(S.route)+'"></main></div></div>';
  const views={overview:renderOverview,todo:renderTodo,work:renderWork,faults:renderFaults,claims:renderClaims,closure:renderClosure,archives:renderArchives,imports:renderImports,users:renderUsers,system:renderSystem,guide:renderGuide};(views[S.route]||renderOverview)();}

function title(h,p='',actions=''){return '<div class="title-row"><div><h1>'+h+'</h1><p>'+p+'</p></div><div class="action-row">'+actions+'</div></div>'}
function queryRows(rows,fields){const q=S.query.trim().toLowerCase();return rows.filter(r=>!q||fields.map(k=>typeof k==='function'?k(r):r[k]).join(' ').toLowerCase().includes(q))}
function recordSearch(placeholder,kind){
  const html=searchBar(placeholder);
  return can('imports.manage')?html.replace('</div>',QualityRecords.importButton(kind,E)+'</div>'):html;
}
function searchBar(placeholder){return '<div class="toolbar"><input id="pageSearch" type="search" value="'+E(S.query)+'" placeholder="'+E(placeholder)+'" aria-label="'+E(placeholder)+'"><button class="work-btn" data-action="refresh">刷新</button></div>'}
function renderDashboard(){S.dashboard ||= LocalAnalytics.init(C.dateNow());const queue=queueRows(),preliminary=(S.data.queues?.rows||[]).filter(r=>!r.analysisId&&r.faultId);$('#page').innerHTML=title('质量管理总览','按真实导入的索赔记录统计；报故、索赔、8D分别管理。')+'<section class="panel"><div class="title-row"><h3>下一步需要处理</h3><button class="work-btn" data-route="todo">我的待办 →</button></div>'+preliminary.slice(0,3).map(p=>'<button class="row-button" data-open-fault="'+E(p.faultId)+'"><strong>待完成初步分析 · '+E(p.faultId)+'</strong><span class="right">'+E(p.due)+' →</span></button>').join('')+queue.slice(0,4).map(({x,t,type,stage})=>'<button class="row-button" data-open-analysis="'+E(x.id)+'" data-stage="'+E(t?.stage||stage||'follow')+'" '+(t?'data-task="'+E(t.id)+'"':'')+'><strong>'+E(type)+' · '+E(t?.title||C.stages.find(s=>s.id===stage)?.name||'阶段内容')+'</strong><span class="right">'+E(t?.due||'')+' →</span><small>'+E(x.title)+'</small></button>').join('')+(queue.length||preliminary.length?'':'<p class="help">当前没有需要你处理的事项。</p>')+'</section>'+LocalAnalytics.render(S.data,S.dashboard);}
function downloadText(text,name,type='text/csv;charset=utf-8'){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function csv(rows){return '\uFEFF'+rows.map(r=>r.map(v=>{let text=String(v??'');if(/^[\u0000-\u0020]*[=+@-]|^[\t\r\n]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"'}).join(',')).join('\r\n')}
function queueRows(){if(S.data.queues?.rows)return S.data.queues.rows.filter(r=>r.analysisId).map(r=>({x:S.data.analyses.find(x=>x.id===r.analysisId),t:S.data.analyses.find(x=>x.id===r.analysisId)?.workflow?.tasks.find(t=>t.id===r.taskId),stage:r.stage,type:({'unassigned':'待分配','review':'待验收','returned':'退回补充','todo':'待完成','submitted':'已提交待验收','stage-confirm':'待阶段确认','close':'可关单','missing':'待补充','waiting-production':'等待生产'})[r.type]||r.type})).filter(r=>r.x);const result=[];for(const x of S.data.analyses.filter(x=>x.status==='active')){W.ensure(x);const current=C.stages.find(s=>!x.stages[s.id].done&&!x.stages[s.id].na)?.id||'D8';for(const t of x.workflow.tasks.filter(t=>W.taskEnabled(x,t)&&t.stage<=current)){if(['draft','returned'].includes(t.status)&&(!t.owner||!t.due)){if(manage())result.push({x,t,type:'待分配'});}else if(['draft','returned'].includes(t.status)&&t.owner===S.user.id)result.push({x,t,type:t.status==='returned'?'退回补充':'待完成'});else if(t.status==='submitted'&&can('tasks.review'))result.push({x,t,type:'待验收'});else if(t.status==='submitted'&&t.owner===S.user.id)result.push({x,t,type:'已提交待验收'});}if(manage()&&!C.validateStage(x,current)&&!x.stages[current].done)result.push({x,t:null,type:'待阶段确认',stage:current});if(manage()&&!C.closureError(x))result.push({x,t:null,type:'可关单',stage:'D8'});}return result}
function renderOverview(){return renderDashboard()}
function renderWork(){
  const items=recordLists.filter('work',queryRows(S.data.analyses,['id','title','faultId',x=>x.revised?.model,x=>x.revised?.partNo]),S.data);
  $('#page').innerHTML=title('8D 分析台账','全部8D分析单与分析进度；待办、分派与验收统一在“我的待办与进度”处理。','<button class="work-btn accent" data-route="todo">查看我的待办 →</button>')
    +searchBar('搜索8D编号、报故编号、料号、产品或问题')
    +recordLists.filters('work',S.data,items.length)
    +(routeAllowed('todo')?'':preliminaryPendingHTML())
    +'<section class="panel table-wrap" style="margin-top:16px"><table><thead><tr><th>8D编号</th><th>报故编号</th><th>分析标题</th><th>阶段与进度</th><th>操作</th></tr></thead><tbody>'
    +items.map(x=>{W.ensure(x);const p=W.progress(x);return '<tr><td>'+E(x.id)+'</td><td>'+E(x.faultId)+'</td><td><strong>'+E(x.title)+'</strong></td><td><span class="tag '+(x.status==='closed'?'good':'')+'">'+E(stateNames[x.status])+'</span> <small>阶段 '+p.stagesDone+'/'+p.stagesTotal+' · 任务 '+p.tasksDone+'/'+p.tasksTotal+' · 待确认 '+p.pending+'</small></td><td><button class="work-btn accent" data-open-analysis="'+E(x.id)+'">'+(x.status==='closed'?'查看归档':'进入8D')+' →</button></td></tr>'}).join('')
    +'</tbody></table>'+(items.length?'':'<div class="empty">没有匹配的 8D 分析。清空搜索或重置筛选后再试。</div>')+'</section>';}
function renderFaults(){const rows=recordLists.filter('faults',queryRows(S.data.faults,['id','material','product','model','customer','description']),S.data);$('#page').innerHTML=title('报故与初步分析','先收集事实与初步失效分析，由质量工程师选择是否开展8D。')+recordSearch('搜索报故编号、料号、产品、客户或故障','fault')+recordLists.filters('faults',S.data,rows.length)+'<section class="panel table-wrap"><table><thead><tr><th>报故编号／日期</th><th>产品／故障</th><th>客户／数量</th><th>初步分析</th><th>操作</th></tr></thead><tbody>'+rows.map(f=>{const x=S.data.analyses.find(x=>x.faultId===f.id),p=prelimRecords(f.id);return '<tr><td>'+E(f.id)+'<small>'+E(f.date)+'</small></td><td>'+E(f.model||f.product)+'<small>'+E(f.description)+'</small></td><td>'+E(f.customer)+'<small>'+(f.quantity==null?'数量待补充':E(f.quantity)+' pcs')+'</small></td><td>'+p.filter(x=>x.status==='submitted').length+' 份已提交'+(f.preliminaryAssignment?'<small>分派：'+E(person(f.preliminaryAssignment.userId||f.preliminaryAssignment.owner).name)+'</small>':'')+'</td><td><button class="work-btn compact" data-open-fault="'+E(f.id)+'">查看报故</button> '+(x?'<button class="work-btn compact" data-open-analysis="'+E(x.id)+'">已有8D</button>':can('analysis.start')?'<button class="work-btn compact accent" data-start-analysis="'+E(f.id)+'">开启8D</button>':'')+'</td></tr>'}).join('')+'</tbody></table>'+(rows.length?'':'<div class="empty">暂无匹配的报故记录。</div>')+'</section>';}
function claimCanManage(){return S.user.role==='admin'||can('analysis.manage')}
function renderClaims(){const rows=recordLists.filter('claims',queryRows(S.data.claims,['id','material','product','model','customer','issue','faultId',x=>x.state?.ownerName,x=>x.state?.stageLabel]),S.data);const actions=(claimCanManage()?'<button class="work-btn accent" data-claim-new>＋ 新增索赔</button> ':'')+'<button class="work-btn" data-action="export-claims">导出当前清单</button>';$('#page').innerHTML=title('索赔记录','保留原22项字段；新增、办理、整单转办与责任分摊由当前经办人完成，权限与合计由服务端校验。',actions)+recordSearch('搜索索赔编号、料号、产品、客户、经办人或报故单','claim')+recordLists.filters('claims',S.data,rows.length)+QualityRecords.claimTable(rows,E,money,{me:S.user.id,canManage:claimCanManage()});}
function renderArchives(){const rows=queryRows(S.data.analyses.filter(x=>x.status==='closed'),['id','faultId','title',x=>x.revised?.partNo||x.revised?.material,x=>x.revised?.model,x=>x.revised?.product]);$('#page').innerHTML=title('8D报告库','关单报告按快照归档，全员可以搜索、预览及下载。')+searchBar('输入料号、产品名称、型号或报告编号')+'<section class="panel">'+rows.map(x=>'<article class="work-card"><div><small>'+E(x.id)+' · '+E(x.closedAt||'')+'</small><h3>'+E(x.title)+'</h3><p>料号：'+E(x.revised?.partNo||x.revised?.material||'待补充')+' · '+E(x.revised?.model)+'</p><p class="help">PDF状态：'+E(archiveState(x))+'</p></div><div class="action-row"><button class="work-btn" data-open-analysis="'+E(x.id)+'">查看8D</button><button class="work-btn accent" data-open-pdf="'+E(x.id)+'">预览PDF</button>'+(manage()?'<button class="work-btn compact" data-retry-pdf="'+E(x.id)+'">生成／重试</button>':'')+'</div></article>').join('')+(rows.length?'':'<div class="empty">暂无匹配的已关闭报告。</div>')+'</section>';}
async function renderClosure(){const token=++metricRequest;
  S.metricFilter ||= {from:C.dateNow().slice(0,7)+'-01',to:C.dateNow(),department:''};
  const filter=S.metricFilter;
  const departments=[...new Set([...(S.data.users||[]).map(user=>user.dept).filter(Boolean),...(S.metrics?.departments||[]).map(group=>group.department),filter.department].filter(Boolean))].sort();
  const options=departments.map(dept=>'<option value="'+E(dept)+'" '+(dept===filter.department?'selected':'')+'>'+E(dept)+'</option>').join('');
  $('#page').innerHTML=title('部门任务按期关闭率')+'<div class="toolbar review-closure-controls" role="group" aria-label="部门关闭率筛选"><label>开始日期<input type="date" id="metricFrom" required value="'+E(filter.from)+'"></label><label>结束日期<input type="date" id="metricTo" required value="'+E(filter.to)+'"></label><label>部门<select id="metricDepartment"><option value="">全部部门</option>'+options+'</select></label><button type="button" class="work-btn accent" data-action="metric-refresh">确定</button><button type="button" class="work-btn" data-action="metric-reset">重置</button></div><div id="metricResult" class="panel">正在计算…</div>';
  S.metrics=null;
  try{
    const params=new URLSearchParams({from:filter.from,to:filter.to});
    if(filter.department)params.set('department',filter.department);
    const d=await api('/api/metrics?'+params);
    if(S.route!=='closure'||token!==metricRequest)return;
    S.metrics=d;$('#metricResult').innerHTML='<p class="help">统计周期 '+E(d.start)+' 至 '+E(d.end)+' · 截至 '+E(d.cutoff)+'。未到期任务不计入；跨部门转交改算新部门，完成后固定归属。</p><div class="table-wrap"><table><thead><tr><th>执行责任部门</th><th>到期任务</th><th>按期完成</th><th>逾期完成</th><th>待验收</th><th>逾期未完成</th><th>往期积压</th><th>按期关闭率</th></tr></thead><tbody>'+(d.departments||[]).map(r=>'<tr><td><button class="work-btn compact" data-metric-dept="'+E(r.department)+'">'+E(r.department)+'</button></td>'+['total','onTime','lateCompleted','pendingReview','overdueOpen','backlog'].map(k=>'<td><button class="text-btn" data-metric-dept="'+E(r.department)+'" data-metric-type="'+k+'">'+(r[k]??0)+'</button></td>').join('')+'<td>'+(r.rate==null?'—':r.rate.toFixed(1)+'%')+'<div class="bar"><i style="width:'+(r.rate==null?0:r.rate)+'%"></i></div></td></tr>').join('')+'</tbody></table></div>'}catch(e){if(S.route==='closure'&&token===metricRequest)$('#metricResult').innerHTML='<p class="error">'+E(e.message)+'</p>'}}
const faultFieldNames={id:'报故单号（必填）',date:'报故日期（必填）',product:'产品名称（必填）',model:'产品型号',material:'料号',customer:'客户',project:'项目',reporter:'报故人员',description:'故障描述（必填）',condition:'发生地点／工况',quantity:'数量（pcs）'};
const claimFieldNames={id:'索赔编号（必填）',date:'索赔日期（必填）',product:'产品名称',model:'产品型号',material:'料号',customer:'客户（必填）',issue:'索赔问题',amount:'索赔金额（元，必填）',waiver:'减免金额（元）',actual:'实际赔付（元）',faultId:'关联报故单号（可空）',dept:'责任部门',deadline:'截止日期',status:'状态'};
Object.assign(faultFieldNames,{sn:'SN',category:'产品类别',sourcing:'自制／外购',dept:'责任部门',secondary:'次要责任部门',diagnosis:'分析判定',major:'重大质量问题',batch:'批量问题',projectType:'项目阶段',reasonType:'问题分类'});
Object.assign(claimFieldNames,{category:'产品类别',sourcing:'自制／外购',agreed:'同意索赔（元）',rejected:'拒绝索赔（元）',estimated:'预计赔付（元）',negotiation:'协商状态'});
Object.assign(faultFieldNames,{assemblyMaterial:'故障件总成料号',customerCode:'客户编码',customerMaterialName:'客户物料名称',organization:'内部组织',trackingNo:'物流单号',firstHandler:'第一经手人',resolution:'解决措施',contact:'联系人',contactPhone:'联系电话',recovered:'是否已全部追回',claimId:'索赔单号',repair:'维修方式',inspection:'是否需要检测单',documentStatus:'文档状态'});
Object.assign(claimFieldNames,Object.fromEntries(QualityRecords.claimColumns.map(([key,label])=>[key,label])));
Object.assign(claimFieldNames,{id:'索赔单号（必填）',date:'索赔日期（可与处理日期二选一）',processingDate:'处理日期（可与索赔日期二选一）',customer:'客户名称（必填）',amount:'索赔金额（元，必填）'});
// 办理新增字段只用于详情展示，不并入OA导入字段映射，避免把内部字段当成可导入列。
const claimExtraNames={stage:'办理阶段',ownerId:'经办人账号',ownerName:'当前经办人',deadline:'办理期限',status:'OA处理状态',processNote:'处理结果',source:'记录来源',createdAt:'新增时间',transferredAt:'最近转办时间',startedAt:'开始办理时间',processedAt:'处理提交时间',completedAt:'结束时间'};
const importFields={fault:faultFieldNames,claim:claimFieldNames,shipment:{id:'发货统计编号（必填）',date:'统计月份（必填）',category:'产品类别（必填）',quantity:'发货数量（必填）',dept:'部门'},product:{id:'映射编号（必填）',material:'料号（必填）',product:'产品名称（必填）',category:'产品类别（必填）',sourcing:'自制／外购'}};
function renderImports(){if(!can('imports.manage')){$('#page').innerHTML='<div class="empty">此账号没有导入权限。</div>';return}const p=S.importPreview;$('#page').innerHTML=title(S.importContext?.label||'数据导入','支持 .xlsx 和 .csv；旧版 .xls 请先另存为 .xlsx。')+'<section class="panel"><form id="importForm"><div class="field-grid"><label>导入类型<select name="kind" id="importKind"><option value="fault" '+(S.importSource?.kind==='fault'?'selected':'')+'>报故表 → 报故工作台</option><option value="claim" '+(S.importSource?.kind==='claim'?'selected':'')+'>索赔表 → 金额统计</option><option value="shipment" '+(S.importSource?.kind==='shipment'?'selected':'')+'>月度发货表 → 比率分母</option><option value="product" '+(S.importSource?.kind==='product'?'selected':'')+'>产品分类与料号映射</option></select></label><label>选择OA文件<input id="importFile" type="file" accept=".xlsx,.csv" required></label></div><p class="help">报故和索赔分别入库；不要求每笔索赔都有报故单号。只按明确编号关联。</p><button class="work-btn accent" type="submit">读取并预览</button> <a class="work-btn" id="templateDownload" href="/api/imports/templates?kind='+(S.importSource?.kind||'fault')+'">下载字段模板</a></form></section><section id="importPreview">'+(p?importPreviewHTML(p):'<div class="panel"><p class="help">上传后匹配列名，提交前显示新增、重复、变更和错误行。</p></div>')+'</section>';const context=S.importContext;
  if(context){
    const selector=$('#importKind');selector.value=context.kind;selector.disabled=true;selector.closest('label').hidden=true;
    $('#templateDownload').href='/api/imports/templates?kind='+encodeURIComponent(context.kind);
    $('#importForm').insertAdjacentHTML('beforebegin','<div class="review-import-heading"><h2>'+E(context.label)+'</h2><button type="button" class="work-btn" data-route="'+E(context.route)+'">返回原模块</button></div>');
  }
  $('#importForm').onsubmit=async ev=>{ev.preventDefault();const f=$('#importFile').files[0];if(!f)return;if(!/\.(xlsx|csv)$/i.test(f.name))return toast('请上传.xlsx或.csv文件');if(f.size>15*1024*1024)return toast('表格不能超过15MB');S.importSource={name:f.name,base64:await fileBase64(f),kind:$('#importKind').value};await previewImport()};}
function importPreviewHTML(p){const fields=importFields[S.importSource?.kind||'fault'];return '<section class="v4-import-actions panel"><strong>预览完成 · 尚未导入</strong><p>有效 '+(p.valid??0)+' 行 · 错误 '+(p.errors?.length||0)+' 行</p><label class="checkline"><input type="checkbox" id="importUpdate">我已核对变更，允许更新已有来源单据（人工分析不覆盖）</label><div class="action-row"><button class="work-btn accent" data-action="import-commit" '+(p.errors?.length?'disabled':'')+'>确认导入</button><button class="work-btn" data-action="import-errors">下载错误行说明</button></div></section><section class="panel"><div class="title-row"><h3>字段对应与导入预览</h3><span class="tag">'+E(p.total??p.rows?.length??0)+' 行</span></div><label>工作表<select id="importSheet">'+(p.sheets||[p.sheet]).map(s=>'<option '+(p.sheet===s?'selected':'')+'>'+E(s)+'</option>').join('')+'</select></label><div class="field-grid" style="margin-top:15px">'+Object.entries(fields).map(([k,l])=>'<label>'+E(l)+'<select data-import-field="'+k+'"><option value="">不导入／待补充</option>'+(p.headers||[]).map(h=>'<option value="'+E(h)+'" '+(p.mapping?.[k]===h?'selected':'')+'>'+E(h)+'</option>').join('')+'</select></label>').join('')+'</div><p class="help">金额空白保留为未知。已有记录不会在预览时被修改。</p><button class="work-btn" data-action="import-remap">按当前列名重新校验</button></section><section class="panel"><div class="kpis">'+[['有效',p.valid??0],['重复',Array.isArray(p.duplicates)?p.duplicates.length:p.duplicates||0],['变更',Array.isArray(p.changes)?p.changes.length:p.changes||0],['错误',p.errors?.length||0]].map(([l,n])=>'<div class="kpi"><small>'+l+'</small><b>'+n+'</b></div>').join('')+'</div><div class="table-wrap"><table><thead><tr><th>行</th><th>结果</th><th>数据预览</th><th>错误／差异</th></tr></thead><tbody>'+(p.rows||[]).slice(0,100).map(r=>'<tr><td>'+E(r.rowNumber)+'</td><td><span class="tag '+(r.status==='error'?'danger':'')+'">'+E(({new:'新增',duplicate:'重复跳过',update:'待更新',error:'有错误'})[r.status]||r.status)+'</span></td><td class="import-cell">'+Object.entries(r.data||{}).map(([k,v])=>E(fields[k]||k)+'：'+E(v)).join('<br>')+'</td><td class="import-cell">'+E([...(r.errors||[]),...(Array.isArray(r.changes)?r.changes.map(x=>typeof x==='string'?x:JSON.stringify(x)):r.changes?[JSON.stringify(r.changes)]:[])].join('\n'))+'</td></tr>').join('')+'</tbody></table></div><p class="help">界面预览前100行，校验覆盖全部行。有错误时请修正文件并重新预览。</p></section>';}
async function previewImport(overrides={}){try{S.importPreview=await api('/api/imports/preview',{...S.importSource,...overrides});renderImports();toast('预览完成，尚未修改业务记录')}catch(e){toast(e.message)}}
function renderUsers(){if(groupAdmin&&S.data.groups?.length)return groupAdmin.render();$('#page').innerHTML=title('账号与权限','禁用账号后保留人员历史记录。','<button class="work-btn accent" data-user-edit="new">＋ 创建账号</button>')+'<section class="panel table-wrap"><table><thead><tr><th>姓名／账号</th><th>部门</th><th>角色</th><th>状态</th><th>企业微信映射</th><th>操作</th></tr></thead><tbody>'+S.data.users.filter(u=>!u.archived).map(u=>'<tr><td>'+E(u.name)+'<small>'+E(u.username)+'</small></td><td>'+E(u.dept)+'</td><td>'+E(roleNames[u.role])+'</td><td><span class="tag '+(u.enabled!==false?'good':'danger')+'">'+(u.enabled!==false?'启用':'禁用')+'</span></td><td>'+E(u.wecomUserId||'未配置')+'</td><td><button class="work-btn compact" data-user-edit="'+E(u.id)+'">权限／编辑</button> <button class="work-btn compact" data-user-reset="'+E(u.id)+'">重置密码</button></td></tr>').join('')+'</tbody></table></section>';}
function defaultPerms(role){if(role==='viewer')return [];if(role==='freeze-clerk')return ['freeze.number.write'];if(role==='admin')return Object.keys(permNames);if(role==='quality-engineer')return ['analysis.manage','analysis.start','tasks.assign','tasks.review','tasks.transfer','imports.manage'];if(role==='failure-analyst')return ['preliminary.write','tasks.transfer'];return ['tasks.transfer']}
function userEditor(id){const u=id==='new'?{name:'',username:'',dept:'',role:'worker',enabled:true,permissions:defaultPerms('worker')}:S.data.users.find(u=>u.id===id);pushForm({type:'user',userId:id,title:id==='new'?'创建真实账号':'编辑账号权限',html:'<form id="userForm"><div class="field-grid">'+field('姓名','name',u.name,'text','required')+field('用户名','username',u.username,'text',id!=='new'?'disabled':'required')+field('部门','dept',u.dept,'text','required')+'<label>角色模板<select name="role" id="userRole">'+Object.entries(roleNames).map(([k,l])=>'<option value="'+k+'" '+(u.role===k?'selected':'')+'>'+l+'</option>').join('')+'</select></label>'+(id==='new'?field('初始密码（至少10位）','password','','password','required minlength="10" autocomplete="new-password"'):'')+field('企业微信UserID（IT填写）','wecomUserId',u.wecomUserId||'')+'</div><label class="checkline"><input type="checkbox" name="enabled" '+(u.enabled!==false?'checked':'')+'>允许登录</label><h3>业务操作权限</h3><p class="help">所有账号均有业务查看权。账号与系统设置仅管理员拥有。</p><div class="permission-list">'+Object.entries(permNames).map(([p,l])=>'<label><input type="checkbox" name="permissions" value="'+p+'" '+((u.permissions||defaultPerms(u.role)).includes(p)?'checked':'')+'>'+E(l)+'</label>').join('')+'</div></form>',save:async()=>{const f=$('#userForm'),v=Object.fromEntries(new FormData(f));v.enabled=f.elements.enabled.checked;v.permissions=$$('[name="permissions"]:checked').map(e=>e.value);if(id!=='new')v.version=u.version;await api(id==='new'?'/api/users':'/api/users/'+encodeURIComponent(id),v,id==='new'?'POST':'PATCH');await refresh();popForm();toast('账号权限已保存')}})}
function renderSystem(){const settings=S.data.settings||{},n=settings.notifications||settings.wecom||{};$('#page').innerHTML=title('备份与企业微信对接','管理员专属；默认模拟通知，不向真实群发送消息。')+'<div class="grid2"><section class="panel"><h3>数据库、附件与PDF备份</h3><p class="help">默认保留30天，错过后启动补做。升级前应额外备份，恢复须在独立目录先验证。</p><div class="action-row"><button class="work-btn accent" data-system="backup">立即备份</button><button class="work-btn" data-system="verify-backup">验证最近备份</button></div><div id="backupResult"></div><h4 style="margin-top:24px">旧浏览器记录手动迁移</h4><p class="help">先导出旧记录与附件，选择迁移JSON。预览不覆盖数据；测试只用模拟记录。</p><label>迁移文件<input id="migrationFile" type="file" accept=".json"></label><button class="work-btn" data-action="migration-preview">预览迁移</button></section><section class="panel"><h3>企业微信群提醒预留</h3><p class="help">Webhook密钥由IT在服务器配置，不进入前端或Git。真实@依赖账号的企业微信UserID。</p><form id="notificationForm"><div class="field-grid"><label>通道<select name="mode"><option value="mock">模拟 · 不发送真实消息</option></select></label>'+field('提前提醒小时数','dueSoonHours',n.dueSoonHours??24,'number','min="1" max="168"')+field('每日超期提醒小时（北京时间）','overdueHour',n.overdueHour??10,'number','min="0" max="23"')+field('群组配置名称','groupName',n.groupName||'质量任务提醒群')+field('公司部署访问地址','baseUrl',n.baseUrl||location.origin)+'</div><label class="checkline"><input name="enabled" type="checkbox" '+(n.enabled?'checked':'')+'>启用模拟扫描</label><button class="work-btn" type="submit">保存模拟配置</button></form><div class="action-row" style="margin-top:15px"><button class="work-btn" data-system="notifications-preview">预览提醒</button><button class="work-btn" data-system="notifications-run">运行模拟提醒</button></div><div id="notificationResult"></div></section></div><section class="panel"><h3>系统记录</h3>'+historyHTML(settings.history||S.data.outbox||[])+'</section>';$('#notificationForm').onsubmit=async ev=>{ev.preventDefault();const f=ev.target,v=Object.fromEntries(new FormData(f));v.enabled=f.elements.enabled.checked;v.dueSoonHours=Number(v.dueSoonHours);v.overdueHour=Number(v.overdueHour);v.mode='mock';await run(async()=>{v.groups=[{name:v.groupName||'质量任务提醒群'}];await api('/api/system/actions',{action:'settings',settings:{notifications:v}});await refresh();toast('模拟通知配置已保存')})}}
function renderGuide(){$('#page').innerHTML=title('本机版使用说明','账号 → OA导入 → 初步分析 → 8D → PDF归档。')+'<article class="panel local-guide">'+[['账号准备','管理员创建权限组并配置组默认及个人允许／禁止。质量部各岗位拥有完整质量业务权限，其他部门默认查看公司看板和报告并办理自己的任务，变更管理员也属于质量部管理组。仅管理员管理账号和系统。'],['OA上传','分别选择产品分类、报故、月度发货或索赔表，上传.xlsx或.csv，匹配列名、核对预览并确认。索赔无需强制关联报故，重复单号不会重复统计。'],['初步分析','失效分析人员可主动打开报故填写自己的结论与照片，质量工程师也能指定人员和期限。初步结论直接供8D参考，不代替D4已验证根因。'],['8D协作','D1分派九个维度的人员、期限及照片要求；D4从各维度内部L1开始排查，最高L4。卡片直接选择无问题并确认，不要求描述或照片；是根因时填写详细描述及证据，有问题但尚未明确则继续拆分，待确认不能作为最终答案。质量工程师逐项通过或驳回，驳回不少于20字。根因进入D5，D6只对所选措施开展实验。库存数量由责任人提交即完成，不验收、不计分。'],['D2统一确认','D2只保留一个入口。质量工程师选择问题分类、是否冻结、变更管理员及期限后即可确定保存，不要求代填编号和数量。现场补充与复现描述选填。料号、SN自动带入；变更管理员登录自己的账号，填写冻结编号（冻结时必填）及两类数量，数量单位固定pcs，无则填0，未知先保存草稿。提交即完成，无需逐项验收、不计分。旧SN及冻结任务保留在该窗口的历史记录中。'],['跟进概览与办理顺序','跟进概览集中展示当前账号待分配、待确认、待完成的事项，点击直接定位；D1—D8不重复显示引导面板。质量工程师可以跨阶段提前分派责任人、期限和证据要求，阶段确认仍按顺序进行；责任人仅办理自己当前的任务；九宫格提交后回到卡片显示已提交状态，并开放下一项，其余任务提交后进入自己的下一项，其他任务可查看。D3不再填写临时遏制摘要，按六类数量及返工方案任务判断进度。'],['填写提示','D1—D8弹窗标明必填、选填、条件必填或责任人必填。条件关闭或未选的项目不因此要求填写，质量工程师设置与责任人成果分别校验。'],['任务转交','责任人可转给启用账号，新人员自动加入D1，原期限和过程资料保留。跨部门改算新部门；转交任务最终积分由质量工程师确认双方贡献。'],['部门关闭率','周、月、年度统计已到期任务。按期验收通过的最终提交时间用于判断，免验收任务采用提交完成时间。无到期任务显示“—”，点击数字看明细。'],['PDF和备份','质量工程师或管理员在满足阶段和首产条件后关闭，自动生成PDF。所有人在报告库按料号、名称查找。管理员检查完整备份和恢复验证结果。'],['公司部署与企业微信','测试和正式数据分开。当前提醒是模拟模式，IT或公司DeepSeek按部署包说明配置群、UserID和后台运行，先在测试群验证实际@。电脑关机时无法运行服务和定时任务。']].map(([h,p],i)=>'<section><h3>'+(i+1)+'. '+h+'</h3><p>'+p+'</p></section>').join('')+'</article>';}
function displayItem(value=S.analysis){const x=clone(value);W.ensure(x);if(manage()&&x.status==='active')x.owner=S.user.id;return x}
function ctx(){return {actor:S.user.id,manage:manage(),items:S.data.analyses,faults:S.data.faults}}
const originalContribution=W.contribution;W.contribution=x=>x.finalContributions||x.contributions||originalContribution(x);const originalReviewer=W.reviewerFor;W.reviewerFor=(x,t)=>can('tasks.review')?S.user.id:'__quality_review_pool__';
function activeTeam(x){return x.team.filter(m=>!m.inactive)}
function registerEntry(title,html,key){S.entries.set(key,{title,html});return '<button class="row-button" data-config="'+E(key)+'"><strong>'+E(title)+'</strong><span class="right">查看详情 →</span></button>'}
function project(html){const wrap=document.createElement('div');wrap.innerHTML=html;wrap.querySelectorAll('[data-wf-task-card]').forEach(el=>{if(el.closest('[data-ad-inline]'))return;const id=el.dataset.wfTaskCard,t=S.analysis.workflow.tasks.find(t=>t.id===id);if(!t)return;const b=document.createElement('button');b.type='button';b.className='row-button';b.dataset.openTask=id;b.innerHTML='<strong>'+E(t.kind==='quantity'?t.data.category:t.title||'未命名任务')+'</strong><span class="right">'+E(person(t.owner).name)+' · '+E(t.due||'未设期限')+' · '+E(stateNames[t.status])+'　查看详情 →</span>'+(t.kind==='quantity'?'<small>'+(t.data.quantity==null||t.data.quantity===''?'数量待确认':E(t.data.quantity)+' pcs')+'</small>':'');el.replaceWith(b)});let idx=0;wrap.querySelectorAll('details').forEach(el=>{if(!wrap.contains(el)||el.closest('[data-ad-inline]'))return;const summary=el.querySelector(':scope > summary');if(!summary)return;const heading=summary.textContent.trim(),key=el.dataset.adKey||S.stage+':detail:'+idx++;summary.remove();const b=document.createElement('div');b.innerHTML=registerEntry(heading,el.innerHTML,key);el.replaceWith(b.firstElementChild)});return wrap.innerHTML}
function stageHTML(){const x=displayItem(),id=S.stage;S.entries.clear();if(id==='follow')return project(U.renderOverview(x,ctx()));if(id==='history')return historyHTML(x.history);if(id==='D1')return '<h3>团队组建</h3><p class="help">只显示本次团队。点击成员编辑职责；增加成员在独立窗口完成。</p>'+activeTeam(x).map(m=>'<button class="row-button" data-team-member="'+E(m.personId)+'"><strong>'+E(person(m.personId).name)+' · '+E(person(m.personId).dept)+'</strong><span class="right">'+(manage()?'编辑职责 →':'查看 →')+'</span><small>'+E(m.role)+'</small></button>').join('')+(manage()?'<button class="work-btn accent" data-team-member="new">＋ 增加团队成员</button>':'')+registerEntry('共同目标、任务分工与阶段证据',nativeFieldsHTML('D1'),'native:D1');let h='';if(id==='D2'){h+='<div class="title-row"><h3>报故基础信息</h3>'+(manage()?'<button class="work-btn" data-action="edit-basic">修改基础信息</button>':'')+'</div>'+sourceHTML({...x.snapshot,...x.revised,material:x.revised.partNo||x.snapshot.material});h+='<h3>初步失效分析（参考）</h3>'+analysisPreliminaryHTML(x);const raw=U.renderStage(x,id,ctx()),w=document.createElement('div');w.innerHTML=raw;const section=w.querySelector('.wf-stage-extra');if(section){const nodes=[...section.children],firstTask=nodes.findIndex(n=>n.matches('[data-wf-task-card]'));if(firstTask!==0){const split=firstTask<0?nodes.length:firstTask;const config=nodes.slice(0,split).map(n=>n.outerHTML).join('');for(const n of nodes.slice(0,split))n.remove();h+=registerEntry('问题分类、复现描述与冻结设置',config,'D2:classification');}}h+=project(w.innerHTML);return h;}if(id==='D8')return transferScoreOverview(x)+registerEntry('总结与遗留问题结论',nativeFieldsHTML(id),'native:'+id)+registerEntry('团队贡献评价',project(U.renderStage(x,id,ctx())),'D8:scores');h+=project(U.renderStage(x,id,ctx()));if(id==='D8')h=transferScoreOverview(x)+registerEntry('总结与遗留问题结论',nativeFieldsHTML(id),'native:'+id)+h;if(['D3','D5','D7'].includes(id)&&manage())h+=registerEntry('阶段适用性设置','<label class="checkline"><input type="checkbox" name="stageNa" '+(x.stages[id].na?'checked':'')+'>本阶段不适用</label>'+field('不适用原因','stageNaReason',x.stages[id].naReason,'textarea'),'na:'+id);return h}
function nativeFieldsHTML(id){const x=S.analysis,s=x.stages[id],disabled=!manage()||x.status!=='active';return '<div class="field-grid">'+C.stages.find(s=>s.id===id).fields.map(([k,l])=>field(l,'native-'+k,s.fields[k]||'','textarea',disabled?'disabled':'')).join('')+'</div>'+(id==='D1'?'<label>是否需要本阶段证据<select name="stageEvidence" '+(disabled?'disabled':'')+'><option value="false" '+(!s.requiresEvidence?'selected':'')+'>不需要</option><option value="true" '+(s.requiresEvidence?'selected':'')+'>需要</option></select></label>'+photos(s.files)+'<label data-stage-upload-label '+(!s.requiresEvidence?'hidden':'')+'>上传本阶段证据<input type="file" data-stage-upload="D1" '+(disabled?'disabled':'')+'></label>':'')}
function renderAnalysis(){const x=S.analysis;W.ensure(x);return '<section class="modal" id="analysisModal"><header class="modal-head"><div><small>'+E(x.id)+' / 8D ANALYSIS · '+E(stateNames[x.status])+'</small><h2>'+E(x.title)+'</h2></div><button class="work-btn" data-action="close-analysis-view">返回清单 ×</button></header><div class="analysis-layout"><nav class="analysis-nav">'+[['follow','◷','跟进概览'],...C.stages.map(s=>[s.id,s.id,s.name]),['history','☷','处理历史']].map(([id,c,l])=>'<button data-stage-nav="'+id+'" class="'+(S.stage===id?'selected':'')+'">'+c+'　'+l+(x.stages[id]?.done?' ✓':'')+'</button>').join('')+'</nav><div class="analysis-main" id="analysisMain">'+stageHTML()+'</div></div><footer class="modal-foot"><small>服务器保存 · 当前身份 '+E(S.user.name)+' · '+E(roleNames[S.user.role])+'</small><div class="action-row">'+(x.status==='active'&&manage()&&S.stage.startsWith('D')?'<button class="work-btn accent" data-action="finish-stage">完成 '+S.stage+' 阶段 ✓</button>':'')+(x.status==='active'&&manage()&&S.stage==='D8'?'<button class="work-btn accent" data-action="close-8d">确认关闭并生成PDF</button>':'')+(x.status==='active'&&S.user.role==='admin'?'<button class="work-btn danger" data-action="archive-analysis">移除当前分析（保留历史）</button>':'')+(x.status==='closed'?'<button class="work-btn accent" data-open-pdf="'+E(x.id)+'">查看归档PDF</button>':'')+'</div></footer></section>'}
function taskExtras(t){let h='';if(manage()&&t.kind==='cause'&&!t.submissions?.length&&['draft','returned'].includes(t.status))h+='<button class="work-btn danger" data-remove-cause="'+E(t.id)+'">移除此人员分工</button>';if(S.analysis.status==='active'&&t.owner===S.user.id&&['draft','returned'].includes(t.status)&&can('tasks.transfer'))h+='<section class="form-section"><h4>转交未完成任务</h4><p class="help">转交保留原期限、成果与历史，并将新负责人加入D1。</p><button class="work-btn" data-transfer-task="'+E(t.id)+'">转交给其他责任人</button></section>';const transfers=t.transfers||t.transferHistory||[];if(transfers.length)h+='<section class="form-section"><h4>转交与贡献记录</h4>'+historyHTML(transfers)+(manage()&&t.status==='accepted'&&!W.isQuantity(t)?'<button class="work-btn" data-score-transfer="'+E(t.id)+'">评定双方任务积分</button>':'')+'</section>';return h}
function transferScoreOverview(x){const tasks=x.workflow.tasks.filter(t=>t.transfers?.length&&!W.isQuantity(t)&&W.taskEnabled(x,t));return tasks.length?'<section class="form-section"><h3>转交任务贡献评定</h3><p class="help">由质量工程师确认各参与人的实际贡献，任务总分不重复计算。</p>'+tasks.map(t=>'<button class="row-button" '+(manage()&&t.status==='accepted'?'data-score-transfer="'+E(t.id)+'"':'data-open-task="'+E(t.id)+'"')+'><strong>'+E(t.title)+'</strong><span class="right">'+(t.transferEvaluation?.confirmed?'已确认':t.status==='accepted'?'待评定':'等待任务验收')+' →</span></button>').join('')+'</section>':''}

function permissionTaskHTML(x,t){const holder=document.createElement('div');holder.innerHTML=U.taskHTML(x,t,ctx());const configuration=new Set(['title','owner','reviewer','due','base','scope']),own=manage()||t.owner===S.user.id;for(const el of holder.querySelectorAll('[data-wf-task-bind]')){if(configuration.has(el.dataset.wfTaskBind)){if(!can('tasks.assign'))el.disabled=true;}else if((!own||!window.TaskSequence.allowed(S.analysis,S.user,t.id))&&!['initiative','evidenceScore','ratingReason'].includes(el.dataset.wfTaskBind))el.disabled=true;}if(!own){for(const el of holder.querySelectorAll('[data-wf-task-array],[data-wf-upload],[data-wf-link-name],[data-wf-link-url],[data-wf-bind]'))el.disabled=true;for(const el of holder.querySelectorAll('[data-wf-action]'))if(el.dataset.wfAction!=='save-task'&&!(can('tasks.review')&&['accept-task','return-task'].includes(el.dataset.wfAction)))el.disabled=true;}return holder.innerHTML.replaceAll('质量管理员','管理员或质量工程师').replaceAll('提交负责人确认','提交').replaceAll('等待 未指定 验收','等待质量工程师验收队列');}

function formBody(f){if(f.render)return f.render();if(f.type==='task'){const x=f.temp||displayItem(),t=x.workflow.tasks.find(t=>t.id===f.taskId);if(can('tasks.assign')&&x.status==='active')x.owner=S.user.id;return permissionTaskHTML(x,t)+taskExtras(t)}if(f.type==='config'){const entry=S.entries.get(f.key);return entry?.html||f.html||'<p class="help">此项已更新，请返回阶段重新进入。</p>'}return f.html||''}
let dialogsRenderCount=0,pageRenderCount=0,renderDeferred=false,renderDeferredDirty=false;
function renderDialogs(){if(renderDeferred){renderDeferredDirty=true;return;}dialogsRenderCount++;renderDialogsNow();}
// 一次打开动作里连续 pushForm 会重复整屏重绘；延迟到动作结束只画一次，减少无谓重建。
let deferEnabled=true;
function deferRenders(fn){if(!deferEnabled)return fn();renderDeferred=true;try{return fn()}finally{renderDeferred=false;if(renderDeferredDirty){renderDeferredDirty=false;renderDialogs();}}}
function renderDialogsNow(){const root=$('#dialogRoot'),f=S.forms.at(-1);let h='';if(S.analysis){const original=S.analysis;try{if(f?.temp)S.analysis=f.temp;h=renderAnalysis()}finally{S.analysis=original}}if(f)h+='<section class="modal" id="formModal" style="z-index:100"><header class="modal-head"><div><small>质量管理 · '+E(roleNames[S.user.role])+'</small><h2>'+E(f.title)+'</h2></div><button class="work-btn" data-action="close-form">返回 ×</button></header><div class="modal-body" id="formBody">'+formBody(f)+'</div><footer class="modal-foot"><p id="formError" class="error"></p><div class="action-row"><button class="work-btn" data-action="close-form">返回</button>'+((f.save||['task','config'].includes(f.type))?'<button class="work-btn accent" data-action="save-form" '+(f.readonly?'disabled':'')+'>确定</button>':'')+'</div></footer></section>';root.innerHTML=h;document.body.style.overflow=S.analysis||f?'hidden':'';v4?.afterRender();guide?.attach();tutorial?.paint();}
function pushForm(f){S.forms.push(f);renderDialogs();$('#formBody input:not(:disabled),#formBody textarea:not(:disabled)')?.focus()}
function popForm(){S.forms.pop();renderDialogs()}
function openTask(id){const t=S.analysis.workflow.tasks.find(t=>t.id===id);if(t)pushForm({type:'task',taskId:id,title:t.title||'任务详情',readonly:S.analysis.status!=='active'||!(['draft','returned'].includes(t.status)&&(manage()||can('tasks.assign')||t.owner===S.user.id))})}
function captureForm(){const f=S.forms.at(-1);if(!f)return null;let x=clone(f.temp||displayItem());if(f.type==='task'&&can('tasks.assign')&&x.status==='active')x.owner=S.user.id;U.capture(x,$('#formBody'),ctx());f.temp=x;return x}
async function command(action,payload={}){const next=itemData(await api('/api/analyses/'+encodeURIComponent(S.analysis.id)+'/commands',{...payload,action,version:S.analysis.version}));if(next?.workflow){S.analysis=next;const ix=S.data.analyses.findIndex(x=>x.id===next.id);if(ix>=0)S.data.analyses[ix]=clone(next);S.forms.forEach(f=>delete f.temp)}return next}
async function saveAnalysisForm(){if(S.forms.at(-1)?.type?.startsWith('v4-'))return;const f=S.forms.at(-1),before=clone(S.analysis),x=captureForm();if(!x)return;const cards=[...$('#formBody').querySelectorAll('[data-wf-task-card]')];const ids=new Set(cards.map(e=>e.dataset.wfTaskCard));if(f.taskId)ids.add(f.taskId);for(const id of ids){const t=x.workflow.tasks.find(t=>t.id===id),old=before.workflow.tasks.find(t=>t.id===id);if(!t||!old||!['draft','returned'].includes(old.status))continue;let keys=[];if(manage()||can('tasks.assign'))keys.push('title','owner','reviewer','due','base','scope');if(manage())keys.push('evidenceRequired','causeId','measureIds');if(manage()||old.owner===S.user.id)keys.push('result','data','files','links');let patch=Object.fromEntries(keys.filter(k=>t[k]!==undefined).map(k=>[k,t[k]]));if(Object.hasOwn(patch,'data'))patch.data=cleanTaskData(t,x);if(t.causeId===old.causeId)delete patch.causeId;if(JSON.stringify(t.measureIds)===JSON.stringify(old.measureIds))delete patch.measureIds;if(JSON.stringify(patch)!==JSON.stringify(Object.fromEntries(Object.keys(patch).map(k=>[k,old[k]]))))await command('save-task',{taskId:id,patch});}
 if(manage()){const config={};for(const k of ['d2','d4','d6','d8']){const allowed={d2:['reproductionDescription','major','batch','freeze','freezeNumber','snScope'],d4:['occurrenceResponsibility'],d6:['withdrawal'],d8:['similar','recurrence','horizontal','horizontalReason','lessons','production']}[k],changed={};for(const key of allowed)if(JSON.stringify(x.workflow[k][key])!==JSON.stringify(before.workflow[k][key])){changed[key]=x.workflow[k][key];if(key==='production')changed[key]=Object.fromEntries(['enabled','mode','product','model','revision','effectiveDate','message','departments','engineers'].map(v=>[v,x.workflow[k][key][v]]));}if(Object.keys(changed).length)config[k]=changed;}const payload={stage:S.stage};if(Object.keys(config).length)payload.config=config;const native={};for(const [k] of C.stages.find(s=>s.id===S.stage)?.fields||[]){const el=$('[name="native-'+k+'"]');if(el)native[k]=el.value}if(Object.keys(native).length)payload.fields=native;const ev=$('[name="stageEvidence"]');if(ev)payload.requiresEvidence=ev.value==='true';const na=$('[name="stageNa"]');if(na){payload.na=na.checked;payload.naReason=$('[name="stageNaReason"]').value}if(S.stage==='D8'&&JSON.stringify(x.bonuses)!==JSON.stringify(before.bonuses))payload.bonuses=x.bonuses;if(Object.keys(payload).length>1)await command('patch-stage',payload);}
 await refresh();toast('已保存到本机数据库');}
/* ---------- 打开分析：统一读取生命周期（REQ-002-LIVE-003 + R1） ----------
 * 读取响应头、读取正文、JSON 解析、结构校验都在同一次可恢复流程里；
 * 取消/离开/被新请求取代都让令牌失效并中止请求，迟到结果不改写新页面。 */
const openTimings=[];
const OPEN_PHASE={start:'准备请求',headers:'等待响应头',body:'读取正文',parse:'解析内容',shape:'校验内容',response:'服务返回错误'};
let openSeq=0,openRequest=null;
function openHint(text='正在打开…'){
  let box=$('#openHint');
  if(!box){
    box=document.createElement('div');box.id='openHint';box.className='open-hint';box.setAttribute('role','status');
    box.innerHTML='<span class="open-hint-text">正在打开…</span><button type="button" class="work-btn compact" data-open-cancel>取消</button>';
    document.body.append(box);
    box.querySelector('[data-open-cancel]').onclick=()=>{if(cancelOpen('cancel'))toast('已取消打开')};
  }
  box.querySelector('.open-hint-text').textContent=text;box.hidden=false;return box;
}
function hideOpenHint(){const box=$('#openHint');if(box)box.hidden=true;}
function removeOpenFailure(){$('#openFailure')?.remove();}
// 取消、离开事项、被新请求取代时统一失效：令牌+1 并中止可中止请求；只清理这一次读取的提示与失败框。
function cancelOpen(reason='cancel'){
  const request=openRequest;
  openSeq++;
  openRequest=null;
  if(request)request.controller.abort(reason);
  hideOpenHint();
  removeOpenFailure();
  return !!request;
}
function openFailure(message,retry){
  removeOpenFailure();
  const box=document.createElement('section');box.id='openFailure';box.className='modal open-failure';
  box.innerHTML='<header class="modal-head"><div><small>打开事项</small><h2>没能打开这个事项</h2></div><button class="work-btn" data-open-close>关闭 ×</button></header><div class="modal-body"><p class="error">'+E(message)+'</p><p class="help">可以重试，或返回待办继续处理其他事项；已经保存的数据不受影响。</p></div><footer class="modal-foot"><div class="action-row"><button class="work-btn" data-open-close>返回</button><button class="work-btn accent" data-open-retry>重试</button></div></footer>';
  $('#dialogRoot').append(box);
  box.querySelectorAll('[data-open-close]').forEach(button=>button.onclick=()=>{box.remove();cancelOpen('close')});
  box.querySelector('[data-open-retry]').onclick=()=>{box.remove();retry()};
}
// 清单里选中的节点已经被处理/删除/任务失效：给"已更新"并提供刷新与返回，不落进空白或无关草稿。
function openStalePanel(detail,onRefresh){
  removeOpenFailure();
  const box=document.createElement('section');box.id='openFailure';box.className='modal open-failure';
  box.innerHTML='<header class="modal-head"><div><small>待办已变化</small><h2>该事项已更新，请刷新待办</h2></div><button class="work-btn" data-open-close>关闭 ×</button></header><div class="modal-body"><p>'+E(detail||'这条待审核事项已经由其他人处理，或状态已改变，原来的入口不再指向可审核内容。')+'</p><p class="help">刷新待办后再进入，不会打开空白页或无关草稿。</p></div><footer class="modal-foot"><div class="action-row"><button class="work-btn" data-open-close>返回待办</button><button class="work-btn accent" data-open-refresh>刷新待办</button></div></footer>';
  $('#dialogRoot').append(box);
  box.querySelectorAll('[data-open-close]').forEach(button=>button.onclick=()=>{box.remove();cancelOpen('close')});
  box.querySelector('[data-open-refresh]').onclick=()=>{box.remove();if(onRefresh)return onRefresh();S.workbench=null;if(S.route!=='todo')S.route='todo';render()};
}
function recordOpenTiming(entry){openTimings.push(entry);if(openTimings.length>30)openTimings.shift();}
function gridSubmittedIds(item,dimensionId){
  const d=item?.nineGrid?.dimensions.find(d=>d.id===dimensionId),ids=[];
  const walk=nodes=>{for(const n of nodes||[]){if(n.review==='submitted')ids.push(n.id);walk(n.children);}};
  if(d)walk(d.nodes);
  return ids;
}
// 通用详情契约：既有分析接口返回的详情都带编号与流程。传统 8D 合法响应本来就没有 nineGrid，不能因此判成坏响应。
function detailShapeError(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return '响应缺少分析详情字段，无法安全打开';
  if(!body.id||!body.workflow||typeof body.workflow!=='object'||Array.isArray(body.workflow))return '响应缺少分析详情字段，无法安全打开';
  return '';
}
// 九宫格特有结构只在这次确实要落到九宫格视图时校验：维度任务、九宫格节点任务，或九宫格分析本身（流程里带维度任务）。
// 传统 8D 的流程任务没有 kind==='grid'/gridRoot，走原来的阶段页面，不需要也不应该被要求 nineGrid。
function opensGridDetail(item,task){
  const tasks=item?.workflow?.tasks||[];
  const target=task?tasks.find(t=>t.id===task):null;
  if(target)return target.kind==='grid'||!!target.gridRoot;
  return tasks.some(t=>t.kind==='grid'||!!t.gridRoot);
}
function gridShapeError(item){
  const grid=item?.nineGrid;
  if(!grid||typeof grid!=='object'||!Array.isArray(grid.dimensions)||!grid.dimensions.length)return '响应缺少九宫格分析结构，无法进入该事项';
  return '';
}
async function openAnalysis(id,stage,task,options={}){
  const token=++openSeq;
  if(openRequest)openRequest.controller.abort('superseded');
  const timeout=Number(options.timeoutMs||S.openTimeoutMs||30000);
  const controller=new AbortController();
  const request={token,controller,id};
  openRequest=request;
  const timing={id,clickAt:performance.now(),requestStart:0,requestEnd:0,firstFormAt:0,dialogs:0,ok:false,timedOut:false,canceled:false,phase:'start',error:''};
  const scrollY=window.scrollY;
  openHint();
  const timer=setTimeout(()=>controller.abort('timeout'),timeout);
  let detail=null;
  try{
    timing.requestStart=performance.now();
    timing.phase='headers';
    const response=await fetch('/api/analyses/'+encodeURIComponent(id),{headers:{accept:'application/json'},credentials:'same-origin',signal:controller.signal});
    timing.phase='body';
    const text=await response.text();
    timing.phase='parse';
    let body=null,parseError='';
    if(text)try{body=JSON.parse(text)}catch(e){parseError=e.message||'无法解析'}
    timing.phase='response';
    if(!response.ok)throw Object.assign(Error(body?.error||('打开失败（'+response.status+'）')),{status:response.status});
    timing.phase='shape';
    if(!body||typeof body!=='object'||Array.isArray(body)){if(parseError)timing.phase='parse';throw Error(parseError?'响应不是有效的 JSON：'+parseError:'响应内容为空，无法读取分析详情');}
    const shapeError=detailShapeError(body);if(shapeError)throw Error(shapeError);
    // 传统 8D 是合法响应（有 id/workflow、没有 nineGrid）：不给旧单补空字段，也不放松通用契约；
    // 只有进入九宫格事项时才要求九宫格结构，缺了就按可恢复失败收尾。
    if(opensGridDetail(body,task)){const gridError=gridShapeError(body);if(gridError)throw Error(gridError);}
    detail=body;
  }catch(error){
    clearTimeout(timer);
    if(openRequest===request)openRequest=null;
    const reason=String(controller.signal.reason||'');
    const canceled=controller.signal.aborted&&reason==='cancel';
    const superseded=token!==openSeq;
    timing.requestEnd=performance.now();
    if(canceled||superseded){timing.canceled=canceled;timing.error=canceled?'canceled':'superseded';recordOpenTiming(timing);return}
    const timedOut=controller.signal.aborted&&reason==='timeout';
    timing.timedOut=timedOut;timing.error=error.message||'打开失败';
    hideOpenHint();recordOpenTiming(timing);
    const where=OPEN_PHASE[timing.phase]||timing.phase;
    openFailure(timedOut?'打开超过 '+Math.round(timeout/1000)+' 秒仍未返回（停在'+where+'），可能是网络或服务繁忙。':(error.message||'打开失败')+'（阶段：'+where+'）',()=>run(()=>openAnalysis(id,stage,task,{...options,timeoutMs:timeout})));
    return;
  }
  clearTimeout(timer);
  if(openRequest===request)openRequest=null;
  if(token!==openSeq)return; // 迟到的成功不能覆盖后来打开的页面
  timing.requestEnd=performance.now();
  const fresh=itemData(detail);
  const target=task?fresh.workflow?.tasks?.find(t=>t.id===task):null;
  const dimensionId=target?.kind==='grid'?(target.data?.dimension||''):'';
  const asked=Array.isArray(options.reviewNodes)?options.reviewNodes.filter(Boolean):[];
  let keepForms=false;
  if(asked.length){
    const current=dimensionId?gridSubmittedIds(fresh,dimensionId):[];
    const alive=asked.filter(nodeId=>current.includes(nodeId));
    const listForm=options.listDimension?S.forms.find(f=>f.type==='v4-review-list'&&f.dimension===options.listDimension):null;
    // 从清单进入：点的那一条必须自己还在已提交集合里，不能拿同维度其它节点顶替；
    // 清单本身改写为最新 nodeIds，返回时看到的是刷新后的清单而不是旧闭包。
    const lostFromList=!!options.fromList&&asked.length===1&&!alive.includes(asked[0]);
    if(listForm)listForm.nodeIds=(!target||!dimensionId)?[]:[...current];
    if(!target||!dimensionId||!alive.length||lostFromList){
      hideOpenHint();timing.error='stale';recordOpenTiming(timing);
      const taskGone=!target||!dimensionId;
      const message=taskGone?'这个维度的分析任务已失效或已改派，原来的入口不再可用。':lostFromList?'这条结论已由其他人审核处理或已删除，清单已刷新为当前可审核的内容。':'';
      if(options.fromList){
        if(taskGone){
          // 维度任务没了，分析视图和清单本身都取不到负责人/状态，先收掉它们，否则渲染异常会把“已更新”提示一起吞掉。
          S.analysis=null;S.forms=listForm?S.forms.filter(f=>f!==listForm):S.forms;renderDialogs();
        }else{
          S.analysis=fresh;S.guided=false;S.stage=stage||'follow';
          if(listForm&&S.forms.at(-1)===listForm)renderDialogs(); // 先画刷新后的清单，再把提示盖在上面
        }
      }
      openStalePanel(message);
      return;
    }
    options={...options,reviewNodes:alive};
    keepForms=!!options.fromList; // 清单留在下面，退出审核页可以回到刷新后的清单
  }
  S.analysis=fresh;S.guided=manage()&&fresh.status==='active';S.stage=stage||'follow';if(!keepForms)S.forms=[];
  const before=dialogsRenderCount;
  deferRenders(()=>{
    if(target&&dimensionId){
      const nodes=options.reviewNodes||[];
      if(nodes.length===1)return v4.openNode(dimensionId,nodes[0]);
      if(nodes.length>1)return v4.openReviewList(dimensionId,nodes);
    }
    if(task)return openTask(task);
    if(!stage&&!manage()){const pending=rootPending();if(pending?.dimension)v4.openGrid(pending.dimension);}
  });
  if(dialogsRenderCount===before)renderDialogs();
  timing.dialogs=dialogsRenderCount-before;timing.firstFormAt=performance.now();timing.ok=true;
  hideOpenHint();recordOpenTiming(timing);
  if(scrollY>0)S.openReturn={route:S.route,scrollY};
}
function rootPending(){return window.TaskSequence.pending(S.analysis,S.user)[0];}
function basicEditor(){const x=S.analysis;pushForm({type:'basic',title:'修改分析基础信息',html:'<form id="basicForm"><div class="field-grid">'+[['product','产品名称'],['model','产品型号'],['partNo','料号'],['customer','客户'],['project','项目'],['quantity','涉及数量（pcs）']].map(([k,l])=>field(l,k,x.revised[k]??'',k==='quantity'?'number':'text')).join('')+'</div>'+field('问题描述','description',x.stages.D2.fields.description||x.revised.description,'textarea')+field('发生地点与工况','condition',x.stages.D2.fields.condition||x.revised.condition,'textarea')+field('影响范围与数量说明','impact',x.stages.D2.fields.impact||'','textarea')+field('修改理由（有修订时必填）','editReason',x.stages.D2.fields.editReason||'','textarea')+'</form>',save:async()=>{const v=Object.fromEntries(new FormData($('#basicForm'))),revised={...x.revised};for(const k of ['product','model','partNo','customer','project','quantity','description','condition'])revised[k]=v[k];await command('patch-stage',{stage:'D2',revised,fields:{description:v.description,condition:v.condition,impact:v.impact,editReason:v.editReason}});await refresh();popForm();toast('基础信息已更新，原报故快照保留')}})}
function teamEditor(id){const x=S.analysis,m=x.team.find(m=>m.personId===id);pushForm({type:'team',title:id==='new'?'增加团队成员':'成员职责与分工',readonly:!manage()||x.status!=='active',html:'<form id="teamForm"><label>团队成员<select name="personId" '+(m?'disabled':'')+'>'+userOpts(m?.personId)+'</select></label>'+field('本次职责与分工','role',m?.role||'','textarea')+'</form>'+(m&&manage()&&id!==x.owner?'<button class="work-btn danger" data-remove-member="'+E(id)+'">从当前团队移除（历史保留）</button>':''),save:async()=>{if(!manage())return;const v=Object.fromEntries(new FormData($('#teamForm'))),pid=m?.personId||v.personId;if(!pid||!v.role.trim())throw Error('请选择成员并填写职责分工');const team=clone(x.team),target=team.find(m=>m.personId===pid);if(target){target.role=v.role;target.inactive=false}else team.push({personId:pid,role:v.role});await command('patch-stage',{stage:'D1',team});await refresh();popForm();toast('团队已更新')}})}
function faultView(id){const f=S.data.faults.find(f=>f.id===id),x=S.data.analyses.find(x=>x.faultId===id);pushForm({type:'fault',faultId:id,title:'报故详情 · '+f.id,html:sourceHTML(f)+'<div class="action-row">'+(can('preliminary.write')?'<button class="work-btn accent" data-add-prelim="'+E(id)+'">＋ 填写我的初步分析</button>':'')+(can('tasks.assign')?'<button class="work-btn" data-assign-prelim="'+E(id)+'">指定初步分析人员与期限</button>':'')+(x?'<button class="work-btn" data-open-analysis="'+E(x.id)+'">查看已有8D</button>':can('analysis.start')?'<button class="work-btn" data-start-analysis="'+E(id)+'">开启8D分析</button>':'')+'</div><h3 style="margin-top:24px">初步失效分析</h3>'+preliminaryHTML(id)})}
/* ---------- 我的待办与进度：真实聚合（初步分析 / 8D含复测与SQE / 索赔整单） ---------- */
const TODO_SOURCE={analysis:'8D任务',preliminary:'初步分析',claim:'索赔'};
let todoRequest=0,allocTimer=null;
function claimById(id){return S.data.claims.find(c=>c.id===id)}
function engineerOptions(selected,exclude){
  const list=(S.workbench?.engineers)||S.data.users.filter(u=>u.enabled!==false&&(u.role==='quality-engineer'||u.permissions?.includes('analysis.manage'))).map(u=>({id:u.id,name:u.name,dept:u.dept||''}));
  return '<option value="">请选择质量工程师</option>'+list.filter(u=>u.id!==exclude).map(u=>'<option value="'+E(u.id)+'" '+(u.id===selected?'selected':'')+'>'+E(u.name)+' · '+E(u.dept)+'</option>').join('');
}
function deptOptions(selected){
  const list=[...new Set([...S.data.users.map(u=>u.dept).filter(Boolean),...(S.data.claims||[]).flatMap(c=>(c.state?.shares||[]).map(s=>s.dept)),selected].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
  return '<option value="">请选择部门</option>'+list.map(dept=>'<option value="'+E(dept)+'" '+(dept===selected?'selected':'')+'>'+E(dept)+'</option>').join('');
}
function allocRowHTML(row){
  return '<div class="review-filter-row" data-alloc-row><select data-alloc-dept aria-label="责任部门">'+deptOptions(row.dept)+'</select><input data-alloc-ratio type="number" step="0.01" min="0" max="100" value="'+E(row.ratio??'')+'" aria-label="责任比例（百分数，最多两位小数）"><button type="button" class="work-btn compact" data-alloc-remove>删除</button></div>';
}
function allocRowsFrom(boxId='allocRows'){
  const box=document.getElementById(boxId);if(!box)return [];
  return [...box.querySelectorAll('[data-alloc-row]')].map(row=>({dept:row.querySelector('[data-alloc-dept]').value,ratio:row.querySelector('[data-alloc-ratio]').value})).filter(row=>row.dept||String(row.ratio).trim()!=='');
}
function allocPreviewHTML(d){
  const table=['amount','agreed','actual'].map(key=>{
    const item=d.amounts[key]||{};
    if(!item.allocation)return '<tr><td>'+E(item.label)+'</td><td>金额待补充</td><td colspan="2">未知金额不按 0 分摊</td></tr>';
    return '<tr><td>'+E(item.label)+'</td><td>'+money(item.amount)+'</td><td>'+item.allocation.rows.map(row=>E(row.dept)+' '+money(row.cents/100)).join('<br>')+'</td><td>'+(item.allocation.unallocated?money(item.allocation.unallocated/100)+' 未分配':'—')+'</td></tr>';
  }).join('');
  return '<p class="help">当前合计 <strong>'+d.total.toFixed(2)+'%</strong> · '+(d.complete?'已满 100%，可以确认。':'未满 100%，只能保存草稿；确认必须 100%。')+'</p>'+
    '<div class="table-wrap"><table><thead><tr><th>金额口径</th><th>金额（元）</th><th>按当前比例</th><th>差额</th></tr></thead><tbody>'+table+'</tbody></table></div>';
}
async function previewAllocation({box='allocRows',preview='allocPreview',error='allocError',amounts}){
  try{
    const d=await api('/api/claim-shares/preview',{shares:allocRowsFrom(box),amounts});
    const target=document.getElementById(preview);if(!target)return;
    target.innerHTML=allocPreviewHTML(d);
    const message=document.getElementById(error);if(message)message.textContent='';
  }catch(e){const message=document.getElementById(error);if(message)message.textContent=e.message;}
}
async function refreshAllocPreview(){
  const form=$('#allocForm');if(!form)return;
  const r=claimById(form.dataset.claim);if(!r)return;
  const amounts={};for(const key of ['amount','agreed','actual'])amounts[key]=r[key+'Cents']!=null?r[key+'Cents']/100:(r[key]??'');
  await previewAllocation({amounts});
}
async function refreshNewClaimPreview(){
  if(!document.getElementById('allocRowsNew'))return;
  const value=name=>document.querySelector('#claimForm [name="'+name+'"]')?.value??'';
  await previewAllocation({box:'allocRowsNew',preview:'allocPreviewNew',error:'claimError',amounts:{amount:value('amount'),agreed:value('agreed'),actual:value('actual')}});
}
async function saveClaimShares(confirm){
  const form=$('#allocForm');if(!form)return;
  const id=form.dataset.claim,r=claimById(id);
  try{
    const out=await api('/api/claims/'+encodeURIComponent(id)+'/shares',{shares:allocRowsFrom(),reason:$('#allocReason').value,confirm,version:r.version},'PUT');
    S.forms=[];await refresh();claimView(id);
    toast(out.unchanged?(out.message||'未修改'):confirm?'责任分摊已确认，基线已更新':'分摊草稿已保存，原确认基线保留');
  }catch(e){const box=$('#allocError');if(box)box.textContent=e.message;else toast(e.message)}
}
function claimSharesForm(id){
  const r=claimById(id),state=r?.state||{};
  const current=(state.shares||[]).length?state.shares:(r?.dept?[{dept:r.dept,ratio:100}]:[]);
  const rows=current.length?current:[{dept:'',ratio:''}];
  pushForm({type:'claim-shares',title:'维护责任分摊 · '+id,html:'<form id="allocForm" data-claim="'+E(id)+'">'+
    '<p class="help">上次确认分摊：'+E(state.confirmedLabel||'未确认')+'。部门不重复，比例最多两位小数，草稿可未分完，确认必须合计 100.00%。</p>'+
    '<div id="allocRows">'+rows.map(allocRowHTML).join('')+'</div>'+
    '<div class="action-row" style="margin:10px 0"><button type="button" class="work-btn" data-alloc-add>＋ 增加部门</button></div>'+
    '<label>修改原因（修改已确认比例时必填，最多200字）<textarea id="allocReason"></textarea></label>'+
    '<div id="allocPreview" class="panel"><p class="help">正在按服务端同一算法计算…</p></div><p id="allocError" class="error"></p>'+
    '<div class="action-row"><button type="button" class="work-btn" data-shares-save>保存草稿</button><button type="button" class="work-btn accent" data-shares-confirm>确认分摊</button></div>'+
    '</form><p class="help">金额整数分，余分归占比最大部门；同占比按部门顺序固定，早先确认值保留在历史里。</p>'});
  refreshAllocPreview();
}
async function claimCommand(id,body){
  const r=claimById(id);if(!r)return;
  await api('/api/claims/'+encodeURIComponent(id)+'/actions',{...body,version:r.version});
  S.forms=[];await refresh();claimView(id);toast('已保存');
}
function claimProcessForm(id){
  const r=claimById(id);
  pushForm({type:'claim-processed',title:'提交处理结果 · '+id,html:'<form id="claimProcessForm">'+field('处理措施与结果（必填，最多2000字）','note',r?.processNote||'','textarea')+field('办理期限','deadline',r?.deadline||'','date')+'</form><p class="help">提交后进入待结算；必须再确认结算结论才能结束，金额本身不能作为结束依据。</p>',save:async()=>{const v=Object.fromEntries(new FormData($('#claimProcessForm')));await claimCommand(id,{action:'processed',note:v.note,deadline:v.deadline})}});
}
function claimCompleteForm(id){
  pushForm({type:'claim-complete',title:'确认结束 · '+id,html:'<form id="claimCompleteForm"><label>结算结论<select name="mode"><option value="赔付">赔付</option><option value="无需赔付">无需赔付</option></select></label>'+field('实际赔付金额（元，赔付时填写；留空沿用已登记的实际赔付／承认金额）','amount','','number','step="0.01" min="0"')+field('结算结论说明（必填，至少4字）','note','','textarea')+'</form><p class="help">无需赔付须写明判定依据；已完成的索赔不能重开或再次办理。</p>',save:async()=>{const v=Object.fromEntries(new FormData($('#claimCompleteForm')));await claimCommand(id,{action:'complete',settlement:{mode:v.mode,amount:v.amount,note:v.note}})}});
}
function claimTransferForm(id){
  const r=claimById(id),state=r?.state||{};
  pushForm({type:'claim-transfer',title:(state.ownerId?'整单转办':'指定经办人')+' · '+id,html:'<form id="claimTransferForm"><label>接收经办人（启用质量工程师）<select name="to">'+engineerOptions('',state.ownerId)+'</select></label>'+field('转办原因（必填，最多500字）','reason','','textarea')+'</form><p class="help">整单转办保留资料、原期限、金额、责任比例与历史；转出后原经办人不能继续办理，也不改变8D闭案责任。</p>',save:async()=>{const v=Object.fromEntries(new FormData($('#claimTransferForm')));if(!v.to)throw Error('请选择接收经办人');await claimCommand(id,{action:'transfer',to:v.to,reason:v.reason})}});
}
function newClaim(){
  const inputs=QualityRecords.claimColumns.map(([key,label,type])=>{
    if(key==='photo')return '';
    if(type==='money')return field(label,key,'','number','step="0.01" min="0"');
    if(type==='number')return field(label,key,'','number','step="1" min="0"');
    if(type==='date')return field(label,key,'','date');
    if(['issue','remarks','handlingResult','responsibility','failureMode','logisticsName'].includes(key))return field(label,key,'','textarea');
    return field(label,key,'');
  }).join('');
  pushForm({type:'claim-new',title:'新增索赔',html:'<form id="claimForm"><div class="field-grid">'+inputs+
    field('索赔日期（看板统计口径，可与处理日期一致）','date','','date')+
    field('减免金额（元）','waiver','','number','step="0.01" min="0"')+
    field('实际赔付（元）','actual','','number','step="0.01" min="0"')+
    '<label>当前经办人（启用质量工程师）<select name="ownerId">'+engineerOptions(S.user.id,'')+'</select></label>'+
    field('办理期限','deadline',C.dateAdd(C.dateNow(),7),'date')+
    '<label>故障照片（可选）<input id="claimPhoto" type="file" accept="image/*"></label>'+
    '</div><h3>责任分摊（可选，保存为草稿）</h3><p class="help">部门不重复，比例最多两位小数；草稿可先不分完，确认必须合计 100.00%，与详情同一算法。</p><div id="allocRowsNew">'+allocRowHTML({dept:'',ratio:''})+'</div><div class="action-row" style="margin:10px 0"><button type="button" class="work-btn" data-alloc-add="new">＋ 增加部门</button></div><div id="allocPreviewNew" class="panel"><p class="help">填写金额或比例后显示分摊预览。</p></div></form><p class="help">保留原22项字段；金额按元填写、最多两位小数，未知留空，不用 0 冒充。单号必须唯一，重复请直接办理原单。</p><p id="claimError" class="error"></p>',
    save:async()=>{
      const v=Object.fromEntries(new FormData($('#claimForm')));
      const shares=allocRowsFrom('allocRowsNew');
      if(shares.length)v.shares=shares;
      const file=$('#claimPhoto')?.files[0];
      if(file){const uploaded=await uploadFile(file);v.photo=uploaded.id}
      await api('/api/claims',v);
      S.forms=[];await refresh();toast('索赔已新增，已进入经办人待办');
    }});
}
function applyTodoFilters(){
  const tab=S.todoTab||'todo',next={q:$('#todoQuery')?.value||'',from:$('#todoFrom')?.value||'',to:$('#todoTo')?.value||''};
  if(tab!=='claims')next.source=$('#todoSource')?.value||'';
  if(tab==='claims')next.stage=$('#todoStage')?.value||'';
  if(tab==='done')next.doneKind=$('#todoKind')?.value||'';
  if(tab!=='done')next.overdue=$('#todoOverdue')?.value||'';
  if(next.from&&next.to&&next.from>next.to){toast('开始日期不能晚于结束日期');return}
  S.todoApplied=next;paintTodo();
}
document.addEventListener('input',ev=>{if(ev.target.tagName==='SELECT')return;
  if(ev.target.closest('#allocForm')){clearTimeout(allocTimer);allocTimer=setTimeout(()=>refreshAllocPreview(),350);return}
  if(ev.target.closest('#allocRowsNew')||(ev.target.closest('#claimForm')&&['amount','agreed','actual'].includes(ev.target.name))){clearTimeout(allocTimer);allocTimer=setTimeout(()=>refreshNewClaimPreview(),350);}
});
document.addEventListener('change',ev=>{
  if(ev.target.closest('#allocForm')){clearTimeout(allocTimer);refreshAllocPreview();return}
  if(ev.target.closest('#allocRowsNew')){clearTimeout(allocTimer);refreshNewClaimPreview();}
});
async function renderTodo(){
  const token=++todoRequest;
  $('#page').innerHTML=title('我的待办与进度','统一读取真实初步分析、复测、8D、SQE 任务与索赔整单待办；质量处置与索赔进度分开统计。')+'<section class="panel"><p class="help">正在读取真实待办…</p></section>';
  if(!S.workbench){
    try{
      const data=await api('/api/workbench');
      if(S.route!=='todo'||token!==todoRequest)return;
      S.workbench=data;
    }catch(e){
      if(S.route==='todo'&&token===todoRequest)$('#page').innerHTML=title('我的待办与进度')+'<section class="panel"><p class="error">'+E(e.message)+'</p></section>';
      return;
    }
  }
  if(S.route!=='todo'||token!==todoRequest)return;
  paintTodo();
}
function qualityProgressRows(){
  const today=C.dateNow();
  return (S.data.analyses||[]).filter(a=>!a.archived&&a.status==='active').map(a=>{
    const tasks=(a.workflow?.tasks||[]).filter(t=>!t.archived&&!t.gridRoot&&['draft','returned','submitted'].includes(t.status));
    const current=tasks[0]||null,stageId=current?.stage||a.stage||'D1';
    return {id:a.id,faultId:a.faultId,title:a.title||a.faultId||'8D分析',stage:stageId+' '+(C.stages.find(s=>s.id===stageId)?.name||''),ownerName:current?(current.owner?person(current.owner).name:'待分派'):'质量工程师',next:!current?'阶段已齐，待确认与关单':current.status==='submitted'?'待质量工程师验收':current.status==='returned'?'已退回，待责任人修改':'责任人填写中',due:String(current?.due||'').slice(0,10),overdue:!!(current?.due&&current.status!=='submitted'&&String(current.due)<today)};
  }).sort((a,b)=>String(a.due||'9999').localeCompare(String(b.due||'9999'))||String(a.title).localeCompare(String(b.title),'zh-CN'));
}
function paintTodo(){
  const tab=S.todoTab||'todo',wb=S.workbench||{todo:[],done:[],counts:{},engineers:[]},f=S.todoApplied||{};
  const q=String(f.q||'').trim().toLowerCase();
  const text=row=>[row.title,row.refTitle,row.ownerName,row.stage,row.claimId,row.next].filter(Boolean).join(' ').toLowerCase();
  const matchQ=row=>!q||text(row).includes(q);
  const matchSource=row=>!f.source||row.source===f.source;
  const matchOverdue=row=>!f.overdue||String(!!row.overdue)===(f.overdue==='是');
  const matchKind=row=>!f.doneKind||(row.kind||'')===f.doneKind;
  const dateKey=(row,kind)=>String((kind==='done'?row.doneAt:(row.due??row.state?.due))||'').slice(0,10);
  const matchDate=(row,kind)=>{if(!f.from&&!f.to)return true;const day=dateKey(row,kind);return !!day&&(!f.from||day>=f.from)&&(!f.to||day<=f.to)};
  const counts=wb.counts||{},claimCounts=counts.claims||{};
  const stageOptions=['待处理','处理中','待结算','已完成'].map(stage=>'<option value="'+stage+'" '+(f.stage===stage?'selected':'')+'>'+stage+'</option>').join('');
  const doneOptions=[['completed','已完成'],['transferred','已转出']].map(([key,label])=>'<option value="'+key+'" '+(f.doneKind===key?'selected':'')+'>'+label+'</option>').join('');
  const sourceDisabled=tab==='claims',overdueDisabled=tab==='done';
  let body='',total=0,missing=0,outside=0;
  // 日期条件不满足的原因分开统计：真正没有日期 vs 有日期但不在所选范围，不能用一句话混称。
  const splitDates=(base,rows,kind)=>{const dropped=base.filter(row=>!matchDate(row,kind));missing=dropped.filter(row=>!dateKey(row,kind)).length;outside=dropped.length-missing;};
  if(tab==='todo'){
    const base=(wb.todo||[]).filter(row=>matchSource(row)&&matchOverdue(row)&&matchQ(row));
    const rows=base.filter(row=>matchDate(row,'todo'));
    splitDates(base,rows,'todo');total=rows.length;
    body='<section class="panel table-wrap" id="todoBody"><table><thead><tr><th>事项</th><th>来源</th><th>当前阶段／待办</th><th>期限</th><th>操作</th></tr></thead><tbody>'+(rows.map(row=>{
      const open=row.source==='claim'?'data-open-claim="'+E(row.claimId)+'"':row.source==='preliminary'?'data-open-fault="'+E(row.faultId)+'"':'data-open-analysis="'+E(row.analysisId)+'" data-stage="'+E(row.stage||'follow')+'"'+(row.taskId?' data-task="'+E(row.taskId)+'"':'')+(row.reviewNodeIds?.length?' data-review-nodes="'+E(row.reviewNodeIds.join(','))+'"':'');
      return '<tr><td><strong>'+E(row.title)+'</strong>'+(row.refTitle?'<small>'+E(row.refTitle)+'</small>':'')+(row.claimId?'<small>索赔 '+E(row.claimId)+'</small>':'')+'</td><td>'+E(TODO_SOURCE[row.source]||row.source)+'</td><td>'+E(row.stage||'—')+(row.kind&&row.kind!=='claim'?'<small>'+E(row.kindLabel||row.kind)+'</small>':'')+'</td><td>'+E(row.due||'未设期限')+(row.overdue?'<small>已逾期</small>':'')+'</td><td><button type="button" class="work-btn compact accent" '+open+'>'+E(row.action||'查看事项')+' →</button></td></tr>';
    }).join('')||'<tr><td colspan="5">当前没有需要你处理的事项。</td></tr>')+'</tbody></table></section>';
  }else if(tab==='done'){
    const base=(wb.done||[]).filter(row=>matchSource(row)&&matchKind(row)&&matchQ(row));
    const rows=base.filter(row=>matchDate(row,'done'));
    splitDates(base,rows,'done');total=rows.length;
    body='<section class="panel table-wrap" id="todoBody"><table><thead><tr><th>事项</th><th>来源</th><th>结果</th><th>时间</th><th>操作</th></tr></thead><tbody>'+(rows.map(row=>{
      const open=row.source==='claim'?'data-open-claim="'+E(row.claimId)+'"':'data-open-analysis="'+E(row.analysisId)+'" data-stage="'+E(row.stage||'follow')+'"'+(row.taskId?' data-task="'+E(row.taskId)+'"':'');
      return '<tr><td><strong>'+E(row.title)+'</strong>'+(row.refTitle?'<small>'+E(row.refTitle)+'</small>':'')+(row.claimId?'<small>索赔 '+E(row.claimId)+'</small>':'')+'</td><td>'+E(TODO_SOURCE[row.source]||row.source)+'</td><td>'+E(row.kind==='transferred'?'已转出给 '+(row.transferTo||row.ownerName||'—'):'已完成')+(row.kind==='transferred'&&row.stage?'<small>'+E(row.stage)+'</small>':'')+'</td><td>'+E(String(row.doneAt||'').slice(0,16).replace('T',' '))+'</td><td><button type="button" class="work-btn compact" '+open+'>只读查看 →</button></td></tr>';
    }).join('')||'<tr><td colspan="5">暂无已处理或已转出的记录。</td></tr>')+'</tbody></table><p class="help">已转出记录在接收人办结后仍可回看，但不计入你的完成业绩；往返转办只保留一条当前待办。</p></section>';
  }else{
    const claims=(S.data.claims||[]);
    const base=claims.filter(claim=>{const state=claim.state||{};const row={title:claim.id,refTitle:claim.customer,ownerName:state.ownerName,stage:state.stage||'',claimId:claim.id,due:state.due};return matchQ(row)&&(!f.stage||state.stage===f.stage)&&matchOverdue({overdue:state.overdue})});
    const rows=base.filter(claim=>matchDate({due:claim.state?.due},'todo')).sort((a,b)=>{const order=['待处理','处理中','待结算','已完成'],ai=order.indexOf(a.state?.stage||''),bi=order.indexOf(b.state?.stage||'');return (ai<0?9:ai)-(bi<0?9:bi)||String(a.deadline||'9999').localeCompare(String(b.deadline||'9999'));});
    splitDates(base,rows,'todo');total=rows.length;
    const allQuality=qualityProgressRows(),qualityBase=allQuality.filter(row=>matchQ(row)),quality=qualityBase.filter(row=>matchDate(row,'todo'));
    const qualityDropped=qualityBase.filter(row=>!matchDate(row,'todo')),qualityMissing=qualityDropped.filter(row=>!dateKey(row,'todo')).length,qualityOutside=qualityDropped.length-qualityMissing;
    const qualityTable='<table><thead><tr><th>分析事项</th><th>当前阶段</th><th>当前办理人</th><th>下一步</th><th>期限</th></tr></thead><tbody>'+(quality.map(row=>'<tr><td><strong>'+E(row.title)+'</strong><small>'+E(row.faultId||'')+'</small></td><td>'+E(row.stage)+'</td><td>'+E(row.ownerName)+'</td><td>'+E(row.next)+'</td><td>'+E(row.due||'未设期限')+(row.overdue?'<small>已逾期</small>':'')+'</td></tr>').join('')||'<tr><td colspan="5">当前没有进行中的质量处置（8D）事项。</td></tr>')+'</tbody></table>';
    const claimTable='<table><thead><tr><th>索赔单号</th><th>客户／不合格描述</th><th>办理阶段</th><th>经办人</th><th>期限</th><th>责任分摊</th><th>索赔金额</th><th>实际赔付</th><th>操作</th></tr></thead><tbody>'+(rows.map(claim=>{const state=claim.state||{};return '<tr><td>'+E(claim.id)+'</td><td>'+E(claim.customer||'—')+'<small>'+E(claim.issue||'')+'</small></td><td><span class="tag '+(state.done?'good':state.overdue?'danger':'')+'">'+E(state.stageLabel||'未开始')+'</span></td><td>'+E(state.ownerName||'待分配')+'</td><td>'+E(state.due||'期限待补充')+(state.overdue?'<small>已逾期</small>':'')+'</td><td class="text-wrap">'+E(state.sharesLabel||'未分摊')+'<small>'+(state.sharesConfirmed?'已确认':'未确认')+'</small></td><td>'+(claim.amountCents==null?'待补充':money(claim.amountCents/100))+'</td><td>'+(claim.actualCents==null?'未知':money(claim.actualCents/100))+'</td><td><button type="button" class="work-btn compact accent" data-open-claim="'+E(claim.id)+'">查看办理 →</button></td></tr>'}).join('')||'<tr><td colspan="9">暂无可见的索赔记录。</td></tr>')+'</tbody></table>';
    body='<div id="todoBody"><section class="panel"><h3>质量处置（8D）· 进行中 '+quality.length+' 项</h3><p class="help">按8D真实任务读取当前阶段、办理人与下一步，与索赔结清分开，不把8D关单当作索赔已完成。</p><div class="table-wrap">'+qualityTable+'</div>'+((qualityMissing||qualityOutside)?'<p class="help">另有 '+(qualityMissing+qualityOutside)+' 项不符合日期条件（'+[qualityMissing?qualityMissing+' 项未填写期限':'',qualityOutside?qualityOutside+' 项日期不在所选范围':''].filter(Boolean).join('，')+'），未计入当前结果。</p>':'')+'</section><section class="panel"><h3>索赔整单 · 在办 '+((claimCounts['待处理']||0)+(claimCounts['处理中']||0)+(claimCounts['待结算']||0))+' 单／已完成 '+(claimCounts['已完成']||0)+' 单</h3><p class="help">索赔进度按整单办理阶段统计，与8D关闭分开，不把8D关单当作索赔结清。已完成单显示结算后的实际赔付。</p><div class="table-wrap">'+claimTable+'</div></section></div>';
  }
  const tabs=[['todo','待我处理 ('+(counts.todo??0)+')'],['done','我已处理·已转出 ('+(counts.done??0)+')'],['claims','案件进度 ('+((claimCounts['待处理']||0)+(claimCounts['处理中']||0)+(claimCounts['待结算']||0))+' 在办)']];
  const hints=[sourceDisabled?'案件进度按索赔单与8D事项展示，来源条件不适用，已禁用。':'',overdueDisabled?'已处理／已转出记录不判定逾期，逾期条件已禁用。':'',(missing||outside)?'另有 '+(missing+outside)+' 条不符合日期条件（'+[missing?missing+' 条未填写'+(tab==='done'?'完成时间':'办理期限'):'',outside?outside+' 条日期不在所选范围':''].filter(Boolean).join('，')+'），未计入当前结果。':'','筛选点“确定”后生效，“重置”恢复全部条件。'].filter(Boolean).join(' ');
  $('#page').innerHTML=title('我的待办与进度','统一读取真实初步分析、复测、8D、SQE 任务与索赔整单待办；质量处置与索赔进度分开统计。')+
    '<div class="kpis">'+[['待我处理',counts.todo??0],['已逾期',counts.overdue??0],['已处理／已转出',counts.done??0],['索赔在办',(claimCounts['待处理']||0)+(claimCounts['处理中']||0)+(claimCounts['待结算']||0)],['索赔已完成',claimCounts['已完成']||0]].map(([label,value])=>'<div class="kpi"><small>'+label+'</small><b>'+value+'</b></div>').join('')+'</div>'+
    '<div class="pill-tabs">'+tabs.map(([key,label])=>'<button type="button" data-todo-tab="'+key+'" class="'+(tab===key?'active':'')+'">'+E(label)+'</button>').join('')+'</div>'+
    '<form class="panel review-list-filters" id="todoFilters"><div class="review-filter-rows">'+
      '<div class="review-filter-row"><span>关键字</span><div><input id="todoQuery" type="search" value="'+E(f.q||'')+'" placeholder="事项、编号、经办人" aria-label="关键字"></div></div>'+
      '<div class="review-filter-row"><span>来源</span><div><select id="todoSource" aria-label="来源" '+(sourceDisabled?'disabled':'')+'><option value="">全部来源</option>'+[['analysis','8D任务'],['preliminary','初步分析'],['claim','索赔']].map(([key,label])=>'<option value="'+key+'" '+(f.source===key?'selected':'')+'>'+label+'</option>').join('')+'</select></div></div>'+
      (tab==='claims'?'<div class="review-filter-row"><span>办理阶段</span><div><select id="todoStage" aria-label="办理阶段"><option value="">全部阶段</option>'+stageOptions+'</select></div></div>':'')+
      (tab==='done'?'<div class="review-filter-row"><span>结果</span><div><select id="todoKind" aria-label="结果"><option value="">全部结果</option>'+doneOptions+'</select></div></div>':'')+
      '<div class="review-filter-row"><span>起止日期</span><div><input id="todoFrom" type="date" value="'+E(f.from||'')+'" aria-label="开始日期"><span>至</span><input id="todoTo" type="date" value="'+E(f.to||'')+'" aria-label="结束日期"></div></div>'+
      '<div class="review-filter-row"><span>只看逾期</span><div><select id="todoOverdue" aria-label="只看逾期" '+(overdueDisabled?'disabled':'')+'><option value="">不限</option><option value="是" '+(f.overdue==='是'?'selected':'')+'>是</option><option value="否" '+(f.overdue==='否'?'selected':'')+'>否</option></select></div></div>'+
    '</div><div class="review-filter-actions"><button type="button" class="work-btn accent" data-todo-apply>确定</button><button type="button" class="work-btn" data-todo-reset>重置</button><span class="review-filter-count" role="status">共 '+total+' 条</span></div></form>'+
    '<p class="help" id="todoHint">'+E(hints)+'</p>'+body;
}
function preliminaryEditor(faultId,id){const p=id?S.data.preliminary.find(p=>p.id===id):null;const f={type:'preliminary',faultId,title:p?'编辑我的初步分析':'填写初步失效分析',files:clone(p?.files||[]),html:'<form id="preliminaryForm">'+field('故障现象','phenomenon',p?.phenomenon||'','textarea')+field('检查过程／分析记录','process',p?.process||'','textarea')+field('初步分析结论','conclusion',p?.conclusion||'','textarea')+'<label>记录状态<select name="status"><option value="draft" '+(p?.status!=='submitted'?'selected':'')+'>保存草稿</option><option value="submitted" '+(p?.status==='submitted'?'selected':'')+'>提交初步结论</option></select></label><label>上传分析照片<input type="file" id="preliminaryUpload" accept="image/*" multiple></label><div id="preliminaryPhotos">'+photos(p?.files||[])+'</div></form><p class="help">初步结论供8D参考，不能替代D4根因验证。修改后保留原版本和照片。</p>',save:async()=>{const body={...Object.fromEntries(new FormData($('#preliminaryForm'))),files:f.files};if(p){body.id=p.id;body.version=p.version}await api('/api/faults/'+encodeURIComponent(faultId)+'/preliminary',body);S.forms=[];await refresh();faultView(faultId);toast('初步分析已保存')}};pushForm(f)}
function assignPreliminary(faultId){pushForm({type:'assign-preliminary',title:'分派初步失效分析',html:'<form id="assignPreliminaryForm"><label>失效分析人员<select name="userId">'+userOpts('',false)+'</select></label>'+field('完成期限','due','','date')+'</form>',save:async()=>{await api('/api/faults/'+encodeURIComponent(faultId)+'/assign',Object.fromEntries(new FormData($('#assignPreliminaryForm'))));await refresh();popForm();toast('初步分析任务已分派')}})}
function claimView(id){const r=S.data.claims.find(r=>r.id===id);if(!r)return;const st=r.state||{},canWrite=claimCanManage(),mine=st.ownerId===S.user.id,done=!!st.done;const actions=[];if(canWrite&&mine&&!done){if(!st.stage||st.stage==='待处理')actions.push('<button class="work-btn accent" data-claim-start="'+E(id)+'">开始办理</button>');if(st.stage==='处理中')actions.push('<button class="work-btn accent" data-claim-processed="'+E(id)+'">提交处理结果</button>');if(st.stage==='待结算')actions.push('<button class="work-btn accent" data-claim-complete="'+E(id)+'">确认结束</button>');}if(canWrite&&!done&&(mine||!st.ownerId||S.user.role==='admin'))actions.push('<button class="work-btn" data-claim-transfer="'+E(id)+'">'+(st.ownerId?'整单转办':'指定经办人')+'</button>');if(canWrite&&!done&&(mine||S.user.role==='admin'))actions.push('<button class="work-btn" data-claim-shares="'+E(id)+'">维护责任分摊</button>');if(!st.stage&&manage())actions.push('<button class="work-btn" data-claim-progress="'+E(id)+'">旧版更新处理进度</button>');const alloc=st.allocations||{};const allocTable=['amount','agreed','actual'].map(key=>{const item=alloc[key]||{};const rows=item.allocation?.rows||[];return '<tr><td>'+E(item.label||key)+'</td><td>'+(item.amountCents==null?'待补充':money(item.amount))+'</td><td>'+(rows.length?rows.map(row=>E(row.dept)+' '+money(row.cents/100)).join('<br>'):'无已确认分摊')+'</td><td>'+(item.allocation?.unallocated?money(item.allocation.unallocated/100)+' 未分配':'—')+'</td></tr>'}).join('');pushForm({type:'claim',title:'索赔详情 · '+id,html:'<div class="source-info">'+Object.entries({...r,version:undefined,state:undefined}).filter(([k,v])=>v!==undefined&&!['history','id'].includes(k)&&typeof v!=='object').map(([k,v])=>'<div><span>'+E(claimFieldNames[k]||claimExtraNames[k]||k)+'</span><p>'+E(v)+'</p></div>').join('')+'</div><p class="text-wrap">'+E(r.issue||'')+'</p>'+(r.photo?'<h3>故障照片</h3>'+(typeof r.photo==='object'?photos([r.photo]):'<button class="work-btn" data-wf-download="'+E(r.photo)+'">查看照片</button>'):'')+'<h3>办理状态</h3><div class="source-info">'+[['当前经办人',st.ownerName||'待分配'],['办理阶段',st.stageLabel||'未开始'],['办理期限',st.due||'期限待补充'],['是否逾期',st.overdue?'是':'否'],['责任分摊',(st.sharesLabel||'未分摊')+'（'+(st.sharesConfirmed?'已确认':'未确认')+'）'],['上次确认分摊',st.confirmedLabel||'未确认'],['实际赔付',r.actualCents==null?'未知（未结算）':'¥'+(r.actualCents/100).toFixed(2)],['结算结论',st.settlement?(st.settlement.mode+(st.settlement.amount==null?'':' '+money(st.settlement.amount)+' 元')+'：'+E(st.settlement.note||'')):'未结算'],['OA处理状态',r.status||'未填']].map(([k,v])=>'<div><span>'+E(k)+'</span><p>'+E(v)+'</p></div>').join('')+'</div>'+(st.legacy?'<p class="help">历史单据未登记经办人或分摊基线，按原 OA 数据展示；需要办理时请先指定经办人，系统不会自动归给当前账号，也不会从草稿推断旧确认值。</p>':'')+(actions.length?'<h3>可执行操作</h3><div class="action-row">'+actions.join(' ')+'</div>':'')+'<h3>责任分摊与金额</h3><div class="table-wrap"><table><thead><tr><th>金额口径</th><th>金额（元）</th><th>按已确认比例分摊</th><th>差额</th></tr></thead><tbody>'+allocTable+'</tbody></table></div><p class="help">提出、承认与实际赔付按同一比例分摊；金额整数分，余分归占比最大部门；同占比按部门名称固定顺序（与录入行序无关）。未知金额不按 0 分摊，结算后以结算金额为有效实际赔付。</p>'+(can('imports.manage')?'<form id="claimLinkForm"><label>明确关联的报故单号（可不关联）<select name="faultId"><option value="">未关联报故</option>'+S.data.faults.map(f=>'<option value="'+E(f.id)+'" '+(r.faultId===f.id?'selected':'')+'>'+E(f.id)+' · '+E(f.product)+'</option>').join('')+'</select></label></form>':'')+historyHTML(r.history||[]),save:can('imports.manage')?async()=>{await api('/api/claims/'+encodeURIComponent(id),{version:r.version,faultId:$('#claimLinkForm').elements.faultId.value},'PATCH');await refresh();popForm();toast('索赔关联已更新，金额未改变')}:null})}
function transferEditor(taskId){const t=S.analysis.workflow.tasks.find(t=>t.id===taskId);pushForm({type:'transfer',title:'转交任务 · '+t.title,html:'<form id="transferForm"><label>新负责人<select name="to">'+userOpts('')+'</select></label>'+field('转交原因及已有工作说明','reason','','textarea')+'</form><p class="help">原期限 '+E(t.due||'未设期限')+' 保留。新负责人自动加入D1，原记录和照片继续保留，部门指标归新负责人部门。</p>',save:async()=>{const v=Object.fromEntries(new FormData($('#transferForm')));await command('transfer',{taskId,...v});await refresh();S.forms=[];renderDialogs();toast('任务已转交，D1团队已同步')}})}
function scoreTransfer(taskId){const t=S.analysis.workflow.tasks.find(t=>t.id===taskId),ids=[...new Set([t.owner,...(t.transfers||[]).flatMap(t=>[t.from,t.to])])],total=W.taskPoints(t);pushForm({type:'score-transfer',title:'评定转交任务贡献',html:'<p>本任务最终积分：<b>'+Number(total).toFixed(4)+'</b></p><p class="help">按双方实际工作分配，合计须等于本任务积分，不能重复计分。</p><form id="transferScoreForm">'+ids.map(id=>field(person(id).name+' · '+person(id).dept,'score-'+id,t.transferEvaluation?.allocations?.find(a=>a.personId===id)?.points??'','number','min="0" step="0.0001"')).join('')+field('评定理由与贡献依据','reason',t.transferEvaluation?.reason||'','textarea')+'</form>',save:async()=>{const form=$('#transferScoreForm'),allocations=ids.map(id=>({personId:id,points:Number(form.elements['score-'+id].value||0)}));await command('score-transfer',{taskId,allocations,reason:form.elements.reason.value});await refresh();popForm();toast('转交贡献已确认')}})}
function changePassword(){pushForm({type:'password',title:S.user.mustChangePassword?'请先修改临时密码':'修改我的密码',html:'<form id="passwordForm">'+field('当前密码','currentPassword','','password','required autocomplete="current-password"')+field('新密码（至少10位）','password','','password','required minlength="10" autocomplete="new-password"')+'</form>',save:async()=>{await api('/api/change-password',Object.fromEntries(new FormData($('#passwordForm'))));S.analysis=null;S.forms=[];S.csrf='';toast('密码已修改，请重新登录');await boot()}})}
function metricDetail(dept,type){const group=S.metrics.departments.find(x=>x.department===dept),rows=type==='backlog'?(S.metrics.backlog||[]).filter(t=>t.department===dept):(group?.tasks||[]).filter(t=>!type||type==='total'||type==='onTime'&&t.completed&&Date.parse(t.completedAt)<=Date.parse(t.due+'T23:59:59+08:00')||type==='lateCompleted'&&t.completed&&Date.parse(t.completedAt)>Date.parse(t.due+'T23:59:59+08:00')||type==='pendingReview'&&t.awaitingReview||type==='overdueOpen'&&!t.completed&&!t.awaitingReview);pushForm({type:'metric',title:dept+' · 部门到期任务明细',html:'<p class="help">'+E(S.metrics.start)+' 至 '+E(S.metrics.end)+'</p>'+rows.map(t=>'<button class="row-button" '+(t.analysisId?'data-open-analysis="'+E(t.analysisId)+'" data-stage="'+E(t.stage)+'" data-task="'+E(t.taskId||t.id)+'"':'data-open-fault="'+E(t.faultId)+'"')+'><strong>'+E(t.title)+'</strong><span class="right">'+E(t.due)+' · '+E(t.ownerName)+'</span><small>'+E(t.completed?'完成于 '+t.completedAt:t.awaitingReview?'待验收':'未完成')+'</small></button>').join('')+(rows.length?'':'<p class="help">此项没有任务。</p>')})}
function preliminaryPendingHTML(){const rows=(S.data.queues?.rows||[]).filter(r=>!r.analysisId&&r.faultId);return rows.length?'<section class="panel"><h3>我待完成的初步失效分析</h3>'+rows.map(r=>'<button class="row-button" data-open-fault="'+E(r.faultId)+'"><strong>'+E(r.label||'报故初步失效分析')+' · '+E(r.faultId)+'</strong><span class="right">'+E(r.due)+(r.overdue?' · 已超期':'')+' →</span></button>').join('')+'</section>':''}
function claimProgress(id){const r=S.data.claims.find(r=>r.id===id),states=['待处理','处理中','待验证','已闭环'];pushForm({type:'claim-progress',title:'更新客诉处理进度',html:'<form id="claimProgressForm"><label>处理状态<select name="status">'+states.map(s=>'<option '+(r.status===s?'selected':'')+'>'+s+'</option>').join('')+'</select></label>'+field('截止日期','deadline',r.deadline||C.dateAdd(C.dateNow(),7),'date')+field('处理措施／最新进展','note',r.note||'','textarea')+'</form><p class="help">请依次推进状态，已闭环记录不能直接重开。客诉状态与8D分析状态分别记录。</p>',save:async()=>{await api('/api/claims/'+encodeURIComponent(id),{...Object.fromEntries(new FormData($('#claimProgressForm'))),version:r.version},'PATCH');S.forms=[];await refresh();claimView(id);toast('客诉处理进度已保存')}})}
async function run(fn){if(S.busy)return;S.busy=true;document.body.setAttribute('aria-busy','true');try{await fn()}catch(e){const target=$('#formError')||$('#authError');if(target)target.textContent=e.message+(e.status===409?'；请返回刷新后再操作。':'');toast(e.message);if(e.status===401){S.analysis=null;S.forms=[];await boot()}}finally{S.busy=false;document.body.removeAttribute('aria-busy')}}
async function uploadFile(file){if(file.size>10*1024*1024)throw Error('单个附件不能超过10MB');const response=await fetch('/api/files',{method:'POST',headers:{'content-type':file.type||'application/octet-stream','x-file-name':encodeURIComponent(file.name),'x-csrf-token':S.csrf},body:file});const d=await response.json();if(!response.ok)throw Error(d.error||'上传失败');return d}
function fileBase64(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(Error('文件无法读取'));r.readAsDataURL(file)})}
function localValue(el,name){return el.closest('.wf-root,.wf-task')?.querySelector('[data-wf-local="'+name+'"]')?.value||$('#formBody [data-wf-local="'+name+'"]')?.value||''}
function cleanTaskData(t,x){const keys={quantity:['quantity','unit'],freeze:['sn','productionQty','material','shippedQty'],sn:['quantity','sn','snScope','snapshotAt','unit'],cause:['primary','secondary'],scheme:['categories'],rework:['categories'],measure:[],implementation:['measureId','scope'],verification:['scope','criteria','sample','window','decision'],production:['scope','decision'],horizontal:['targets']}[t.kind]||['targets','measureKey'];const data=Object.fromEntries(keys.filter(k=>Object.hasOwn(t.data||{},k)).map(k=>[k,t.data[k]]));if(W.isLesson?.(t))data.lessonRecord=Object.fromEntries(['phenomenon','rootCause','effective','failed','scope','evidence'].map(k=>[k,x.workflow.d8.lessons[k]]));return data}
function migrationPeopleHTML(bundle){const people=[...new Set((bundle.analyses||bundle.items||[]).flatMap(x=>[x.owner,...(x.team||[]).map(m=>m.personId),...(x.workflow?.tasks||[]).flatMap(t=>[t.owner,t.reviewer])]).filter(Boolean))];return '<h3>旧人员与真实账号对应</h3><p class="help">未选择的身份作为原历史保留，不会自动创建可登录账号；需要继续处理的事项请完成映射。</p><div class="field-grid">'+people.map(id=>'<label>'+E(id)+'<select data-legacy-person="'+E(id)+'"><option value="">保留原历史身份</option>'+S.data.users.map(u=>'<option value="'+E(u.id)+'">'+E(u.name)+' · '+E(u.dept)+'</option>').join('')+'</select></label>').join('')+'</div>'}
async function openHash(){if(!S.data)return;const parts=location.hash.slice(1).split('/');if(parts[0]==='analysis'&&parts[1]){const id=decodeURIComponent(parts[1]),task=parts[2]?decodeURIComponent(parts[2]):'',x=S.data.analyses.find(x=>x.id===id);if(x)await openAnalysis(id,x.workflow?.tasks.find(t=>t.id===task)?.stage||'follow',task)}else if(parts[0]==='fault'&&parts[1]){const id=decodeURIComponent(parts[1]);if(S.data.faults.some(f=>f.id===id))faultView(id)}}
async function workflowAction(a,el){const taskId=el.dataset.taskId,t=taskId&&S.analysis.workflow.tasks.find(t=>t.id===taskId);if(['add-link','remove-link','remove-file'].includes(a)){const x=captureForm(),task=x.workflow.tasks.find(t=>t.id===taskId);if(a==='add-link'){const card=el.closest('.wf-task'),name=card.querySelector('[data-wf-link-name]').value.trim(),url=card.querySelector('[data-wf-link-url]').value.trim();let u;try{u=new URL(url)}catch{throw Error('请输入有效证据网址')}if(!name||!['http:','https:'].includes(u.protocol))throw Error('请填写名称及http/https链接');task.links.push({name,url:u.href})}else if(a==='remove-link')task.links.splice(Number(el.dataset.index),1);else task.files=task.files.filter(f=>f.id!==el.dataset.fileId);S.forms.at(-1).temp=x;renderDialogs();return}
 const ratingBefore=['accept-task','confirm-quality'].includes(a)?captureForm()?.workflow.tasks.find(t=>t.id===taskId):null;if(['submit-task','confirm-quality','save-task','verification-failed'].includes(a))await saveAnalysisForm();let v={taskId};if(['accept-task','confirm-quality'].includes(a)){const task=ratingBefore||captureForm()?.workflow.tasks.find(t=>t.id===taskId)||t;v={...v,initiative:task.initiative,evidenceScore:task.evidenceScore,ratingReason:task.ratingReason};}if(a==='return-task')v.reason=$('[data-wf-task-bind="ratingReason"][data-task-id="'+taskId+'"]')?.value||'';
 if(a==='create-measure')v={causeId:el.dataset.causeId};if(a==='create-experiment')v={measureIds:$$('[data-experiment-measure]:checked').map(e=>e.dataset.experimentMeasure)};if(a==='cancel-experiment')v.reason=localValue(el,'cancel.reason');if(a==='verification-failed')v.target=localValue(el,'failureTarget')||'D4';if(a==='add-task')v={stage:el.dataset.stage,kind:el.dataset.kind,title:el.dataset.kind==='sn'?'SN生产数量确认':'协作任务'};if(a==='link-measure')v.causeId=captureForm()?.workflow.tasks.find(t=>t.id===taskId)?.causeId;if(a==='link-experiment')v.measureIds=captureForm()?.workflow.tasks.find(t=>t.id===taskId)?.measureIds;if(a==='simulate-order')v={order:{id:localValue(el,'order.id'),createdAt:localValue(el,'order.createdAt')+'T09:00:00+08:00',product:localValue(el,'order.product'),model:localValue(el,'order.model'),revision:localValue(el,'order.revision')}};if(a==='simulate-production')v={orderId:S.analysis.workflow.d8.production.orderId};if(a==='check-month'){await refresh();toast('已检查首产或一个月提醒条件');return}if(a==='save-task'){toast('草稿已保存');return}if(a==='reopen-linked'&&!confirm('重新编辑将要求后续关联重新确认，原提交保留。是否继续？'))return;
 if(a==='open-original'){S.forms=[];await openAnalysis(el.dataset.originalId);return}if(a==='link-lesson'){const similar=clone(S.analysis.workflow.d8.similar);if(!similar.some(s=>s.id===el.dataset.sourceId&&s.type==='措施可借鉴'))similar.push({id:el.dataset.sourceId,type:'措施可借鉴'});await command('patch-stage',{stage:'D7',config:{d8:{similar}}});await refresh();toast('已关联经验条目');return}if(a==='reset-bonus'){await command('patch-stage',{stage:'D8',bonuses:{[el.dataset.personId]:{points:0,reason:'按新版规则清零，原评价保留历史',evidence:''}}});await refresh();return}if(a==='create-recurrence'){const originalId=localValue(el,'recurrence.source'),faultId=localValue(el,'recurrence.fault'),reason=localValue(el,'recurrence.reason').trim();if(!originalId||!faultId||!reason)throw Error('请选择原已关闭8D、新报故并说明复发判断');S.analysis=itemData(await api('/api/analyses',{faultId,originalId,mode:'nine-grid'}));await command('patch-stage',{stage:'D7',config:{d8:{recurrence:{originalId,reason}}}});S.forms=[];await refresh();await openAnalysis(S.analysis.id,'D1');toast('已新建复发分析，原报告保留');return}if(a==='add-similar'||a==='remove-similar'){const similar=clone(S.analysis.workflow.d8.similar);if(a==='add-similar'){const id=localValue(el,'similar.id'),type=localValue(el,'similar.type');if(!id)throw Error('请选择关联分析');similar.push({id,type})}else similar.splice(Number(el.dataset.index),1);await command('patch-stage',{stage:'D7',config:{d8:{similar}}});}else await command(a,v);const newId=S.analysis.newTaskId;await refresh();if(newId){S.forms=[];renderDialogs();openTask(newId)}else renderDialogs();toast('操作已保存')}
function applyRoute(d){
  if(d.route==='imports'){
    const context=QualityRecords.importTypes[d.importKind];
    if(!can('imports.manage')||!context)return false;
    S.importContext={...context,kind:d.importKind};
    S.importSource=null;S.importPreview=null;
  }
  cancelOpen('route');
  S.route=d.route;S.query='';S.forms=[];S.analysis=null;render();renderDialogs();return true;
}
document.addEventListener('click',ev=>{const el=ev.target.closest('button,a[data-action],[data-dash-start]');if(!el)return;if(el.type==='submit'&&el.form)return;const d=el.dataset;if(!Object.keys(d).length)return;
 // 一次慢读取不能把导航一起锁死：离开该事项就中止并失效本次读取，业务保存不受影响。
 if(d.route){ev.preventDefault();if(!S.busy)run(async()=>{applyRoute(d)});else if(openRequest)applyRoute(d);return}
 if(S.busy)return;
 ev.preventDefault();run(async()=>{
 if(d.openAnalysis){await openAnalysis(d.openAnalysis,d.stage,d.task,{reviewNodes:String(d.reviewNodes||'').split(',').filter(Boolean)});return}
 if(d.reviewNode){await openAnalysis(d.reviewAnalysis,d.reviewStage||'follow',d.reviewTask||'',{reviewNodes:[d.reviewNode],fromList:true,listDimension:d.reviewDimension});return}
 if(d.openFault){faultView(d.openFault);return}
 if(d.startAnalysis){const item=itemData(await api('/api/analyses',{faultId:d.startAnalysis,mode:'nine-grid'}));S.forms=[];await refresh();await openAnalysis(item.id,'D1');return}
 if(d.claimProgress){claimProgress(d.claimProgress);return}if(d.openClaim){claimView(d.openClaim);return}
 if(d.claimAct){claimView(d.claimAct);return}
 if(el.hasAttribute('data-claim-new')){newClaim();return}
 if(d.claimStart){if(!confirm('开始办理该索赔？'))return;await claimCommand(d.claimStart,{action:'start'});return}
 if(d.claimProcessed){claimProcessForm(d.claimProcessed);return}
 if(d.claimComplete){claimCompleteForm(d.claimComplete);return}
 if(d.claimTransfer){claimTransferForm(d.claimTransfer);return}
 if(d.claimShares){claimSharesForm(d.claimShares);return}
 if(el.hasAttribute('data-shares-save')){await saveClaimShares(false);return}
 if(el.hasAttribute('data-shares-confirm')){await saveClaimShares(true);return}
 if(el.hasAttribute('data-alloc-add')){const newForm=el.getAttribute('data-alloc-add')==='new',boxId=newForm?'allocRowsNew':'allocRows';document.getElementById(boxId).insertAdjacentHTML('beforeend',allocRowHTML({dept:'',ratio:''}));await (newForm?refreshNewClaimPreview():refreshAllocPreview());return}
 if(el.hasAttribute('data-alloc-remove')){const row=el.closest('[data-alloc-row]'),box=row.parentElement,rows=box.querySelectorAll('[data-alloc-row]');if(rows.length<=1){row.querySelector('[data-alloc-dept]').value='';row.querySelector('[data-alloc-ratio]').value=''}else row.remove();await (box.id==='allocRowsNew'?refreshNewClaimPreview():refreshAllocPreview());return}
 if(d.todoTab){S.todoTab=d.todoTab;S.todoApplied={q:S.todoApplied?.q||''};paintTodo();return}
 if(el.hasAttribute('data-todo-apply')){applyTodoFilters();return}
 if(el.hasAttribute('data-todo-reset')){S.todoApplied={};paintTodo();return}
 if(d.userEdit){userEditor(d.userEdit);return}
 if(d.userReset){pushForm({type:'reset',title:'重置 '+person(d.userReset).name+' 的密码',html:'<form id="resetForm">'+field('新临时密码（至少10位）','password','','password','minlength="10" autocomplete="new-password"')+'</form><p class="help">重置后该账号需重新登录并修改临时密码。</p>',save:async()=>{await api('/api/users/'+encodeURIComponent(d.userReset)+'/reset-password',Object.fromEntries(new FormData($('#resetForm'))));await refresh();popForm();toast('密码已重置')}});return}
 if(d.stageNav){S.forms=[];S.stage=d.stageNav;renderDialogs();return}
 if(d.openTask){openTask(d.openTask);return}
 if(d.config){const entry=S.entries.get(d.config);pushForm({type:'config',key:d.config,title:entry.title,html:entry.html,readonly:!manage()||S.analysis.status!=='active'});return}
 if(d.teamMember){teamEditor(d.teamMember);return}
 if(d.removeMember){if(!confirm('移除当前成员？历史记录与积分保留。'))return;const team=clone(S.analysis.team),m=team.find(m=>m.personId===d.removeMember);m.inactive=true;await command('patch-stage',{stage:'D1',team});await refresh();popForm();return}
 if(d.localAddCause){const next=await command('add-task',{stage:'D4',kind:'cause',section:d.localAddCause,title:(d.localAddCause==='occurrence'?'产生原因':'流出原因')+' · 人员分析'});await refresh();openTask(next.newTaskId||S.analysis.workflow.tasks.at(-1).id);return}
 if(d.removeCause){if(!confirm('移除此项未提交的原因分析人员分工？历史记录不删除。'))return;await command('remove-cause',{taskId:d.removeCause});S.forms=[];await refresh();renderDialogs();return}if(d.transferTask){transferEditor(d.transferTask);return}
 if(d.scoreTransfer){scoreTransfer(d.scoreTransfer);return}
 if(d.addPrelim){preliminaryEditor(d.addPrelim);return}
 if(d.prelimEdit){preliminaryEditor(d.fault,d.prelimEdit);return}
 if(d.assignPrelim){assignPreliminary(d.assignPrelim);return}
 if(d.prelimHistory){const p=S.data.preliminary.find(p=>p.id===d.prelimHistory);pushForm({type:'history',title:'初步分析版本记录',html:(p.history||[]).map(h=>'<section class="prelim"><small>'+E(h.at)+' · v'+E(h.version)+'</small><p>'+E(h.phenomenon)+'</p><p>'+E(h.process)+'</p><p>'+E(h.conclusion)+'</p>'+photos(h.files)+'</section>').join('')});return}
 if(d.wfLocate){S.forms=[];S.stage=d.wfLocate;renderDialogs();if(d.wfTask)openTask(d.wfTask);return}
 if(d.wfDownload){window.open('/api/files/'+encodeURIComponent(d.wfDownload),'_blank','noopener');return}
 if(d.wfAction){await workflowAction(d.wfAction,el);return}
 if(d.openPdf){pushForm({type:'pdf',title:'8D归档PDF',html:'<p><a class="work-btn" href="/api/archives/'+encodeURIComponent(d.openPdf)+'/pdf?download=1" target="_blank" rel="noopener">下载PDF</a></p><iframe title="8D归档PDF" class="pdf-view" src="/api/archives/'+encodeURIComponent(d.openPdf)+'/pdf"></iframe><p class="help">若生成尚未完成或失败，请返回报告库检查状态，由质量工程师重试。</p>'});return}
 if(d.retryPdf){await api('/api/archives/'+encodeURIComponent(d.retryPdf)+'/retry',{});await refresh();toast('已请求生成PDF');return}
 if(d.metricDept){metricDetail(d.metricDept,d.metricType);return}
 if(d.system){const result=await api('/api/system/actions',{action:d.system});const target=d.system.startsWith('notifications')?$('#notificationResult'):$('#backupResult');if(target)target.innerHTML='<pre class="code">'+E(JSON.stringify(result,null,2))+'</pre>';else toast('已完成 '+d.system);return}
 if(d.dashDrill||d.dashStart){const rows=LocalAnalytics.drill(S.data,S.dashboard,d.dashDrill||'all',d.dashKey,d.dashStart,d.dashEnd);pushForm({type:'dash-drill',title:'索赔明细 · '+(d.dashKey||d.dashStart||'当前范围'),html:'<p class="help">共 '+rows.length+' 笔，点击编号打开详情。</p>'+LocalAnalytics.table(rows)});return}const a=d.action;
 if(a==='refresh'){await refresh();toast('已刷新');return}
 if(a==='logout'){await api('/api/logout',{});S.analysis=null;S.forms=[];await boot();return}
 if(a==='change-password'){changePassword();return}
 if(a==='close-form'){popForm();return}
 if(a==='save-form'){const f=S.forms.at(-1);if(f.readonly)return;if(f.save)await f.save();else await saveAnalysisForm();toast('已经完成提交');if(S.guided&&manage()&&['basic','config','team'].includes(f.type)){S.forms=[];await guide.next({automatic:true});}return}
 if(a==='archive-analysis'){if(!confirm('移除此分析及其待办？资料与处理历史会保留，可由管理员恢复。'))return;await command('archive-analysis',{reason:'管理员移除误建或不再使用的分析，历史资料保留'});S.analysis=null;S.forms=[];await refresh();renderDialogs();toast('分析已移除，历史已保留');return;}
 if(a==='close-analysis-view'){cancelOpen('close');S.analysis=null;S.forms=[];renderDialogs();render();if(S.openReturn){window.scrollTo(0,S.openReturn.scrollY);S.openReturn=null}return}
 if(a==='edit-basic'){basicEditor();return}
 if(a==='finish-stage'){await command('finish-stage',{stage:S.stage});S.forms=[];await refresh();S.stage=guide?.current()||S.stage;renderDialogs();toast('阶段已确认，已进入'+S.stage);return}
 if(a==='close-8d'){if(!confirm('确认完成8D并生成归档PDF？关闭后保留最终快照。'))return;await command('close');await refresh();renderDialogs();toast('8D已关闭，PDF正在生成');return}
 if(a==='dash-reset'){S.dashboard=LocalAnalytics.init(C.dateNow());renderOverview();return}if(a==='dash-export'){const rows=LocalAnalytics.rows(S.data,S.dashboard);downloadText(csv([['索赔编号','日期','产品','型号','客户','索赔金额','减免金额','实际赔付','部门','状态'],...rows.map(r=>[r.id,r.date,r.product,r.model,r.customer,claimMoney(r,'amount'),claimMoney(r,'waiver'),claimMoney(r,'actual'),r.dept,r.status])]),'索赔当前范围.csv');return}if(a==='metric-refresh'||a==='metric-reset'){
    if(a==='metric-reset')S.metricFilter={from:C.dateNow().slice(0,7)+'-01',to:C.dateNow(),department:''};
    else{
      const from=$('#metricFrom'),to=$('#metricTo');
      to.setCustomValidity(from.value&&to.value&&from.value>to.value?'结束日期不能早于开始日期':'');
      if(!from.reportValidity()||!to.reportValidity())return;
      S.metricFilter={from:from.value,to:to.value,department:$('#metricDepartment').value};
    }
    await renderClosure();document.querySelector('[data-action="'+a+'"]')?.focus({preventScroll:true});return;
  }
 if(a==='import-remap'){const mapping=Object.fromEntries($$('[data-import-field]').map(e=>[e.dataset.importField,e.value]));await previewImport({mapping,sheet:$('#importSheet').value});return}
 if(a==='import-commit'){const result=await api('/api/imports/'+encodeURIComponent(S.importPreview.batchId)+'/commit',{updateExisting:$('#importUpdate').checked});S.importPreview=null;await refresh();pushForm({type:'import-result',title:'导入结果',html:'<pre class="code">'+E(JSON.stringify(result,null,2))+'</pre>'});return}
 if(a==='import-errors'){downloadText(csv([['行号','错误'],...(S.importPreview.errors||[]).map(e=>[e.rowNumber,e.message])]),'OA导入错误说明.csv');return}
 if(a==='export-claims'){const rows=recordLists.filter('claims',queryRows(S.data.claims,['id','material','product','model','customer','issue','faultId',x=>x.state?.ownerName,x=>x.state?.stageLabel]),S.data);downloadText(csv(QualityRecords.claimExport(rows,{state:true})),'索赔清单-'+C.dateNow()+'.csv');return}
 if(a==='migration-preview'){const f=$('#migrationFile').files[0];if(!f)throw Error('请选择迁移JSON');if(f.size>17*1024*1024)throw Error('迁移JSON不能超过17MB');const data=JSON.parse(await f.text()),result=await api('/api/system/actions',{action:'migrate-preview',bundle:data});pushForm({type:'migration',title:'迁移预览（尚未写入）',html:'<pre class="code">'+E(JSON.stringify(result,null,2))+'</pre>'+migrationPeopleHTML(data)+'<p class="help">确认后仅新增未存在记录，不覆盖已有报告。原人员需要由管理员核对。</p>',save:async()=>{await api('/api/system/actions',{action:'migrate-commit',id:result.id,peopleMap:Object.fromEntries($$('[data-legacy-person]').filter(e=>e.value).map(e=>[e.dataset.legacyPerson,e.value]))});S.forms=[];await refresh();toast('迁移完成')}});return}
 });});
document.addEventListener('compositionstart',e=>{if(e.target.id==='pageSearch')S.searchComposing=true;});
function renderRecordList(kind,focus){
  ({faults:renderFaults,claims:renderClaims,work:renderWork})[kind]();
  if(focus)document.querySelector('[data-list-filter] '+focus)?.focus({preventScroll:true});
}
document.addEventListener('input',event=>{
  const form=event.target.closest('[data-list-filter]');
  if(!form)return;
  for(const input of form.querySelectorAll('input'))input.setCustomValidity('');
  recordLists.capture(form);
});
document.addEventListener('change',event=>{
  const form=event.target.closest('[data-list-filter]');
  if(form)recordLists.capture(form);
});
document.addEventListener('submit',event=>{
  const form=event.target.closest('[data-list-filter]');
  if(!form)return;
  event.preventDefault();
  if(recordLists.apply(form))renderRecordList(form.dataset.listFilter,'[type="submit"]');
});
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-expand-filters],[data-clear-list-filter]');
  if(!button)return;
  const form=button.closest('[data-list-filter]');if(!form)return;
  if(button.hasAttribute('data-expand-filters')){recordLists.toggle(form);return;}
  recordLists.reset(form.dataset.listFilter);S.query='';
  renderRecordList(form.dataset.listFilter,'[data-clear-list-filter]');
});
document.addEventListener('compositionend',e=>{S.searchComposing=false;if(e.target.id==='pageSearch')e.target.dispatchEvent(new Event('input',{bubbles:true}));});
document.addEventListener('input',ev=>{if(ev.target.id==='pageSearch'){if(ev.isComposing||S.searchComposing)return;const cursor=ev.target.selectionStart;S.query=ev.target.value;const views={work:renderWork,faults:renderFaults,claims:renderClaims,archives:renderArchives};views[S.route]?.();$('#pageSearch')?.focus();$('#pageSearch')?.setSelectionRange(cursor,cursor)}});
document.addEventListener('change',ev=>{const el=ev.target;if(el.name==='stageEvidence'){const label=$('[data-stage-upload-label]');if(label)label.hidden=el.value!=='true';return}if(el.id.startsWith('dash')){const map={dashPeriod:'period',dashYear:'year',dashInterval:'interval',dashFrom:'from',dashTo:'to',dashProduct:'product',dashDepartment:'department',dashRankMode:'rankMode',dashDepartmentMode:'departmentMode',dashRepeatMode:'repeatMode'},key=map[el.id];if(key){S.dashboard[key]=['year','interval'].includes(key)?Number(el.value):el.value;if(key==='period')S.dashboard.interval=el.value==='quarter'?Math.ceil(Number(C.dateNow().slice(5,7))/3):el.value==='week'?LocalAnalytics.currentWeek(C.dateNow()):Number(C.dateNow().slice(5,7));if(S.dashboard.from>S.dashboard.to){toast('开始日期不能晚于结束日期');return}renderOverview();}return}if(el.id==='importKind'){const a=$('#templateDownload');if(a)a.href='/api/imports/templates?kind='+el.value;S.importPreview=null;S.importSource=null;$('#importPreview').innerHTML='<section class="panel"><p class="help">类型已更改，请读取文件并重新预览。</p></section>';return}if(el.id==='userRole'){const perms=defaultPerms(el.value);$$('[name="permissions"]').forEach(p=>p.checked=perms.includes(p.value));return}if(el.dataset.preventionKey){run(async()=>{const next=await command('select-prevention',{key:el.dataset.preventionKey,selected:el.checked});await refresh();if(el.checked&&next.newTaskId)openTask(next.newTaskId)});return}if(el.dataset.wfUpload){run(async()=>{const file=el.files[0];if(!file)return;const x=captureForm(),t=x.workflow.tasks.find(t=>t.id===el.dataset.wfUpload);t.files.push(await uploadFile(file));S.forms.at(-1).temp=x;renderDialogs();toast('已上传，保存任务后关联资料')});return}if(el.id==='preliminaryUpload'){run(async()=>{const f=S.forms.at(-1);for(const file of el.files){if(!file.type.startsWith('image/'))throw Error('初步分析只上传图片');f.files.push(await uploadFile(file))}$('#preliminaryPhotos').innerHTML=photos(f.files);toast('分析照片已上传')});return}if(el.dataset.stageUpload){run(async()=>{const file=el.files[0];if(!file)return;await saveAnalysisForm();const uploaded=await uploadFile(file),s=S.analysis.stages[el.dataset.stageUpload];await command('patch-stage',{stage:el.dataset.stageUpload,files:[...s.files,uploaded]});await refresh();toast('阶段证据已保存')});return}if(el.closest('#formBody')&&el.matches('[data-wf-refresh]')){captureForm();renderDialogs()}});
document.addEventListener('keydown',ev=>{if(ev.key==='Escape'){if(S.forms.length){ev.preventDefault();popForm()}else if(S.analysis){ev.preventDefault();S.analysis=null;renderDialogs();render()}}if(ev.key==='Tab'&&(S.forms.length||S.analysis)){const root=S.forms.length?$('#formModal'):$('#analysisModal'),all=[...root.querySelectorAll('button,input,select,textarea,a[href]')].filter(e=>!e.disabled&&e.offsetParent!==null),first=all[0],last=all.at(-1);if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last?.focus()}else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first?.focus()}}});

const originalRender=render,originalStage=stageHTML;
v4=window.V4UI({S,E,$,api,command,refresh,pushForm,popForm,renderDialogs,render:()=>render(),toast,run,uploadFile,person,manage,can,openAnalysis,photos,field,originalStageHTML:originalStage,sourceHTML,analysisPreliminaryHTML,faultView,cleanTaskData,guide:()=>guide});
stageHTML=v4.stageHTML;openTask=v4.openTask;teamEditor=v4.teamEditor;
guide=window.AnalysisGuideUI({S,E,$,renderDialogs,pushForm,command,refresh,toast,run,manage,openTask:id=>openTask(id),basicEditor,originalStageHTML:()=>stageHTML(),v4:()=>v4});
renderDashboard=function(){S.board ||= window.QualityDashboard.newBoard(BoardV4,C.dateNow(),'faults');$('#page').innerHTML=BoardV4.render(S.data,S.board);for(const field of document.querySelectorAll('.v4-board-dimensions select[data-board]')){const draft=S.board.dimensionDraft?.[field.dataset.board];if(draft!==undefined)field.value=draft;}
  if(can('imports.manage')&&S.board.mode==='faults'){
    const buttons=QualityRecords.importButton('shipment',E)+QualityRecords.importButton('product',E);
    const tabs=$('.review-board-tabs');
    if(tabs)tabs.insertAdjacentHTML('beforeend','<span class="review-board-imports">'+buttons+'</span>');
    else $('#page').insertAdjacentHTML('afterbegin','<div class="action-row review-board-imports">'+buttons+'</div>');
  }};
render=function(){
  if(!S.data)return;
  const viewer=S.user.role==='viewer',clerk=S.user.role==='freeze-clerk';
  originalRender();
  if(clerk){const xs=S.data.analyses.filter(x=>x.freezeAssignment?.owner===S.user.id);$('#page').innerHTML=title('冻结编号与数量填报','处理分派给你的D2冻结编号、SN生产数量及料号发货数量。')+xs.map(x=>'<section class="panel"><h3>'+E(x.title)+'</h3><p>料号 '+E(x.revised?.partNo||x.snapshot?.material)+' · SN '+E(x.snapshot?.sn)+' · 期限 '+E(x.freezeAssignment.due)+'</p><p>冻结编号：'+E(x.workflow.d2.freeze?(x.workflow.d2.freezeNumber||'待填写'):'未选择冻结')+'</p><p>填报状态：'+E(x.freezeAssignment.status==='completed'?'已完成':'待填报')+'</p><button class="work-btn accent" data-v4="freeze-number" data-analysis="'+E(x.id)+'">查看／填写D2编号与数量</button></section>').join('');}if(viewer)for(const b of document.querySelectorAll('[data-open-analysis]'))b.remove();v4.afterRender();};


groupAdmin=window.GroupAdmin({S,E,$,api,pushForm,refresh,toast});
 tutorial=window.TestWalkthrough({S,E,render:()=>render(),renderDialogs,toast});
 const render43=render;
 render=function(){
   if(!S.data)return;
   if(recordUserId!==S.user.id){recordLists.resetAll();S.board=null;S.reviewBoards=null;S.importContext=null;S.importSource=null;S.importPreview=null;S.metricFilter=null;S.workbench=null;S.todoApplied={};S.todoTab='todo';recordUserId=S.user.id;}
   if(!routeAllowed(S.route))S.route=S.user.role==='freeze-clerk'&&routeAllowed('work')?'work':routeAllowed('overview')?'overview':'guide';
   render43();
   document.querySelectorAll('[data-route]').forEach(button=>{if(!routeAllowed(button.dataset.route))button.remove();});
   tutorial?.paint();
 };
 window.QualityLocal={get state(){return clone({user:S.user,route:S.route,stage:S.stage,analysis:S.analysis,data:S.data})},get openTiming(){return openTimings.slice()},get renderCounts(){return {page:pageRenderCount,dialogs:dialogsRenderCount}},setOpenTimeout(ms){S.openTimeoutMs=Number(ms)||0},setDeferredRenders(on){deferEnabled=!!on},reloadWorkbench(){S.workbench=null;if(S.route==='todo')render()},open(id,stage,task,options){return openAnalysis(id,stage,task,options||{})}};
window.addEventListener('hashchange',()=>run(openHash));
boot();
})();
