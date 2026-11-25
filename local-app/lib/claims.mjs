// 索赔整单办理：新增、经办人、阶段、期限、整单转办与责任分摊。
// 设计约束（见 handoff/REQ-002-LIVE-001）：
// 1. 不覆盖 OA 来源字段。`status` 仍由导入维护，办理阶段单独存于 `stage`，历史“待验证/已闭环”不改义。
// 2. 分摊比例单位与 local-analytics.js 一致：`shares:[{dept,ratio}]`，ratio 为百分数（40.5 表示 40.5%）。
//    金额分摊在内部换算为万分比整数再按分取整，避免 100 倍与浮点差错。
// 3. 草稿 `shares`、最后确认基线 `confirmedShares`、是否曾确认分别持久化；草稿不覆盖基线。
// 4. 每次写入都是单条 store.put（带 expectedVersion），确认状态、基线与审计一次提交，冲突整体不写入。
import {appError} from './store.mjs';
import {hasPermission} from './auth.mjs';
import {scopedData} from './access.mjs';

export const CLAIM_STAGES=['待处理','处理中','待结算','已完成'];
export const CLAIM_END='已完成';
// 参与分摊的金额字段（提出/承认/实际赔付按同一比例）
export const ALLOCATION_FIELDS=[['amount','索赔金额'],['agreed','承认金额'],['actual','实际赔付']];
const MONEY_FIELDS=[['amount','索赔金额',false],['waiver','减免金额',true],['actual','实际赔付',true],['agreed','承认金额',true],['rejected','拒绝索赔金额',true],['estimated','预计赔付金额',true],['supplierAmount','供应商索赔金额',true],['supplierAgreed','供应商承认金额',true]];
const TEXT_FIELDS=['processingDate','nonconformityId','customer','failureMode','customerMaterial','material','sn','logisticsName','issue','customerInitiator','location','responsibility','handlingResult','handler','remarks','date'];
const str=v=>String(v??'').trim();
const fail=(message,status=400)=>{throw appError(message,status)};
const dateStamp=d=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const dateValid=value=>/^\d{4}-\d{2}-\d{2}$/.test(str(value))&&Number.isFinite(Date.parse(str(value)+'T00:00:00+08:00'))&&dateStamp(new Date(str(value)+'T00:00:00+08:00'))===str(value);
const ratio2=value=>Math.round(Number(value)*100)/100;
const pct=value=>ratio2(value).toFixed(2)+'%';
const sameShares=(a,b)=>{
  const left=(Array.isArray(a)?a:[]).filter(x=>x&&x.dept),right=(Array.isArray(b)?b:[]).filter(x=>x&&x.dept);
  if(left.length!==right.length)return false;
  return left.every((x,i)=>x.dept===right[i].dept&&ratio2(x.ratio)===ratio2(right[i].ratio));
};
export const stageOf=claim=>CLAIM_STAGES.includes(str(claim?.stage))?str(claim.stage):'';
const legacyClosed=claim=>['closed','已关闭','已闭环'].includes(str(claim?.status));

export function normalizeShares(input,{requireFull=false}={}){
  if(!Array.isArray(input))fail('请提交责任部门与比例');
  if(input.length>50)fail('责任分摊的部门过多');
  const seen=new Set(),shares=[];
  for(const raw of input){
    const dept=str(raw?.dept);
    if(!dept)fail('请选择责任部门');
    if(dept.length>80)fail('责任部门名称过长');
    if(seen.has(dept))fail('责任部门不能重复：'+dept);
    seen.add(dept);
    const value=raw?.ratio;
    if(value===null||value===undefined||str(value)==='')fail('请填写'+dept+'的责任比例');
    const number=Number(value);
    if(!Number.isFinite(number))fail(dept+'的责任比例无效');
    if(number<0||number>100)fail(dept+'的责任比例须在 0 到 100 之间');
    const ratio=ratio2(number);
    if(Math.abs(number-ratio)>1e-9)fail(dept+'的责任比例最多两位小数');
    shares.push({dept,ratio});
  }
  const totalBasis=shares.reduce((n,s)=>n+Math.round(s.ratio*100),0);
  if(totalBasis>10000)fail('责任分摊合计不能超过 100.00%，当前 '+(totalBasis/100).toFixed(2)+'%');
  if(requireFull&&totalBasis!==10000)fail('责任分摊合计必须为 100.00%，当前 '+(totalBasis/100).toFixed(2)+'%');
  return {shares,totalBasis,total:totalBasis/100};
}

// 整数分分摊：逐部门向下取整；仅在合计 100% 时把余分整体给占比最大者。
// 同占比按部门名称固定排序（与提交行序无关），换行序不能悄悄改变财务归属。
export function allocateCents(totalCents,shares){
  if(totalCents===null||totalCents===undefined)return null;
  const rows=shares.map(share=>{
    const basis=Math.round(Number(share.ratio)*100);
    return {dept:share.dept,ratio:ratio2(share.ratio),basis,cents:Math.floor(totalCents*basis/10000)};
  });
  const totalBasis=rows.reduce((n,row)=>n+row.basis,0);
  let allocated=rows.reduce((n,row)=>n+row.cents,0),remainder=totalCents-allocated;
  if(totalBasis===10000&&remainder!==0&&rows.length){
    const target=[...rows].sort((a,b)=>b.basis-a.basis||(a.dept<b.dept?-1:a.dept>b.dept?1:0))[0];
    target.cents+=remainder;allocated+=remainder;remainder=0;
  }
  return {rows,totalBasis,allocated,unallocated:remainder,complete:totalBasis===10000};
}

// 结算金额是“有效实际赔付”的唯一口径：赔付以结算金额为准，无需赔付为 0；
// 未结算时才回落到历史实际赔付字段。原始导入值单独保留，便于追溯 OA 来源。
const SETTLEMENT_MODES=['赔付','无需赔付'];
function settlementOf(claim){
  const value=claim?.settlement;
  return value&&typeof value==='object'&&SETTLEMENT_MODES.includes(str(value.mode))?value:null;
}
export function settlementCents(claim){
  const settlement=settlementOf(claim);
  if(!settlement)return null;
  if(str(settlement.mode)==='无需赔付')return 0;
  const cents=settlement.amountCents??(settlement.amount===null||settlement.amount===undefined?null:Math.round(Number(settlement.amount)*100));
  return Number.isFinite(cents)?cents:null;
}
export function effectiveActualCents(claim){
  const settled=settlementCents(claim);
  if(settled!==null)return settled;
  const cents=claim?.actualCents??(claim?.actual===null||claim?.actual===undefined?null:Math.round(Number(claim.actual)*100));
  return Number.isFinite(cents)?cents:null;
}
// 对外统一读模型：列表、详情、分摊、导出与看板都读同一份 actual/actualCents。
function readClaim(claim){
  const cents=effectiveActualCents(claim),settlement=settlementOf(claim),settled=settlementCents(claim);
  const original=claim?.importedActualCents??null;
  return {
    ...claim,
    actualCents:cents,actual:money(cents),
    settlement:settlement?{...settlement,amountCents:settled,amount:money(settled)}:(claim?.settlement??null),
    importedActualCents:original,importedActual:money(original)
  };
}

function centsOf(value,label,optional=false){
  const text=str(value).replace(/[¥￥,，\s]/g,'');
  if(!text){if(optional)return null;fail('请填写'+label)}
  if(!/^\d+(\.\d{1,2})?$/.test(text))fail(label+'须为非负金额，最多两位小数');
  const [whole,fraction='']=text.split('.'),cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(cents)||cents>1e13)fail(label+'超出支持范围');
  return cents;
}
const money=cents=>cents===null||cents===undefined?null:cents/100;
const sharesText=shares=>shares.map(share=>share.dept+' '+pct(share.ratio)).join(' / ');
const allocationsFor=(claim,shares)=>{
  const result={};
  for(const [key,label] of ALLOCATION_FIELDS){
    const cents=claim[key+'Cents']??(claim[key]===null||claim[key]===undefined?null:Math.round(Number(claim[key])*100));
    result[key]={label,amountCents:cents,amount:money(cents),allocation:cents===null||!shares.length?null:allocateCents(cents,shares)};
  }
  return result;
};

export function createClaimService({store}){
  const people=()=>store.list('users');
  const now=()=>new Date();
  const stamp=()=>now().toISOString();
  const isEngineer=user=>!!user&&user.enabled!==false&&(user.role==='quality-engineer'||hasPermission(user,'analysis.manage'));
  const canManage=user=>!!user&&(user.role==='admin'||isEngineer(user));

  function decorateOne(claim,users){
    const view=readClaim(claim);
    const stage=stageOf(view),ownerId=str(view.ownerId),owner=users.find(user=>user.id===ownerId);
    const shares=(Array.isArray(view.shares)?view.shares:[]).filter(share=>share&&share.dept);
    const baseline=(Array.isArray(view.confirmedShares)?view.confirmedShares:[]).filter(share=>share&&share.dept);
    const done=stage===CLAIM_END||(!stage&&legacyClosed(view));
    const due=str(view.deadline),today=dateStamp(now());
    const confirmed=baseline.length>0&&sameShares(shares,baseline);
    return {
      stage,
      stageLabel:stage||(str(view.status)?'旧状态：'+str(view.status):'未开始'),
      legacy:!stage,
      ownerId,ownerName:owner?.name||str(view.ownerName)||'',unassigned:!ownerId,
      due,overdue:!!due&&!done&&due<today,done,
      shares,shareTotal:ratio2(shares.reduce((n,share)=>n+Number(share.ratio||0),0)),
      sharesLabel:shares.length?sharesText(shares):(str(view.dept)?str(view.dept)+' 100.00%（主责部门，未确认）':'未分摊'),
      sharesConfirmed:confirmed,confirmedShares:baseline,
      confirmedLabel:baseline.length?sharesText(baseline):'未确认',
      allocations:allocationsFor(view,baseline),
      settlement:view.settlement||null,
      effectiveActualCents:view.actualCents,effectiveActual:view.actual
    };
  }
  function decorate(list,users=people()){return (list||[]).map(claim=>({...readClaim(claim),state:decorateOne(claim,users)}));}

  function previewShares(user,body){
    if(!canManage(user))fail('只有质量工程师可以维护责任分摊',403);
    const {shares,totalBasis,total}=normalizeShares(body.shares);
    const amounts={},labels={};
    for(const [key,label] of ALLOCATION_FIELDS){
      labels[key]=label;
      const provided=body.amounts?.[key];
      const cents=provided===undefined||provided===null||str(provided)===''?null:centsOf(provided,label,true);
      amounts[key]={label,amountCents:cents,amount:money(cents),allocation:cents===null?null:allocateCents(cents,shares)};
    }
    return {shares,totalBasis,total,complete:totalBasis===10000,amounts,labels};
  }

  function claimFields(body,users,user){
    const id=str(body.id);
    if(!id||id.length>80)fail('请填写索赔单号（最多80字）');
    if(/[\u0000-\u001f]/.test(id))fail('索赔单号含无效字符');
    const date=str(body.date),processingDate=str(body.processingDate);
    if(date&&!dateValid(date))fail('索赔日期无效');
    if(processingDate&&!dateValid(processingDate))fail('处理日期无效');
    if(!date&&!processingDate)fail('索赔日期或处理日期至少填写一项');
    const customer=str(body.customer);
    if(!customer)fail('请填写客户名称');
    if(customer.length>120)fail('客户名称过长');
    const data={id};
    for(const key of TEXT_FIELDS){
      if(body[key]===undefined)continue;
      const value=str(body[key]);
      if(value.length>8000)fail('字段内容不能超过8000字');
      data[key]=value;
    }
    if(!data.date&&!processingDate)data.date=dateStamp(now());
    // 看板按索赔日期统计；只填处理日期时用处理日期补位，避免新增单据落在统计范围之外。
    if(!data.date)data.date=processingDate;
    const quantity=body.quantity===undefined||str(body.quantity)===''?null:Number(body.quantity);
    if(quantity!==null&&(!Number.isSafeInteger(quantity)||quantity<0))fail('索赔数量须为非负整数，未知请留空');
    data.quantity=quantity;
    const cents={};
    for(const [key,label,optional] of MONEY_FIELDS)cents[key]=centsOf(body[key],label,optional);
    if(cents.waiver!==null&&cents.waiver>cents.amount)fail('减免金额不能超过索赔金额');
    if(cents.agreed!==null&&cents.agreed>cents.amount)fail('同意索赔金额不能超过索赔金额');
    if(cents.rejected!==null&&cents.rejected>cents.amount)fail('拒绝索赔金额不能超过索赔金额');
    if(cents.agreed!==null&&cents.rejected!==null&&cents.agreed+cents.rejected>cents.amount)fail('同意及拒绝金额不能超过申请金额');
    if(cents.supplierAgreed!==null&&cents.supplierAmount!==null&&cents.supplierAgreed>cents.supplierAmount)fail('供应商承认金额不能超过供应商索赔金额');
    for(const [key] of MONEY_FIELDS){data[key+'Cents']=cents[key];data[key]=money(cents[key]);}
    const location=str(body.location);
    if(location&&!['厂内','厂外'].includes(location))fail('厂内/厂外须填写厂内或厂外');
    const currency=str(body.currency).toUpperCase();
    if(currency&&!['CNY','RMB','人民币','¥','￥'].includes(currency))fail('当前金额统计仅支持人民币，请拆分其他币种');
    data.currency='CNY';
    const faultId=str(body.faultId);
    if(faultId&&!store.get('faults',faultId))fail('关联报故单不存在，请先导入报故表或留空后续关联');
    data.faultId=faultId;data.faultIds=faultId?[faultId]:[];
    const deadline=str(body.deadline);
    if(deadline&&!dateValid(deadline))fail('办理期限无效');
    data.deadline=deadline;
    if(!deadline)data.deadline='';
    const photo=str(body.photo);
    data.photo=photo?photo:null;
    return data;
  }

  function create(user,body){
    if(!canManage(user))fail('只有质量工程师可以新增索赔',403);
    const users=people();
    const data=claimFields(body,users,user);
    if(store.get('claims',data.id))fail('该索赔单号已存在，请直接在清单中办理原单',409);
    const ownerId=str(body.ownerId)||user.id,target=users.find(user=>user.id===ownerId);
    if(!target||target.enabled===false)fail('请选择启用的经办人');
    if(!isEngineer(target))fail('经办人须为质量工程师');
    if(!data.deadline)data.deadline=dateStamp(new Date(Date.parse(data.date||data.processingDate)+7*86400000));
    const record={...data,stage:'待处理',status:str(body.status)||'待处理',ownerId:target.id,ownerName:target.name,source:'manual',createdAt:stamp(),createdBy:user.id,history:[{at:stamp(),actor:user.name,actorId:user.id,text:'新增索赔：登记经办人 '+target.name+'；办理期限 '+data.deadline}]};
    if(body.shares!==undefined&&body.shares!==null){
      const draft=normalizeShares(body.shares);
      if(draft.shares.length){
        record.shares=draft.shares;record.sharesConfirmed=false;record.sharesUpdatedAt=stamp();
        record.history.push({at:stamp(),actor:user.name,actorId:user.id,text:'新增时录入责任分摊草稿：'+sharesText(draft.shares)+'（合计 '+draft.total.toFixed(2)+'%；未确认，确认须 100%）'});
      }
    }
    return store.put('claims',data.id,record,{actor:user,event:'claim.create',details:{id:data.id,ownerId:target.id,deadline:data.deadline}});
  }

  function saveShares(user,id,body){
    const old=store.get('claims',id);
    if(!old)fail('索赔记录不存在',404);
    if(body.version===undefined)fail('请提供记录版本号');
    if(Number(body.version)!==old.version)fail('记录已被其他人更新，请刷新后重试',409,{currentVersion:old.version});
    const users=people(),state=decorateOne(old,users),baseline=state.confirmedShares,hadConfirm=baseline.length>0;
    if(user.role!=='admin'){
      if(!canManage(user))fail('只有质量工程师可以维护责任分摊',403);
      if(!state.ownerId)fail('此索赔尚未分配经办人，请先指定经办人再维护分摊',409);
      if(state.ownerId!==user.id)fail('只有当前经办人可以维护此索赔的责任分摊',403);
    }
    // 已完成是终态：普通分摊入口不再接受草稿或确认，版本、基线与历史保持不动。
    if(state.done)fail('索赔已完成，责任分摊不可再修改；如需纠错请另行走管理员纠错流程（本轮未开放）',409);
    const reason=str(body.reason);
    if(reason.length>200)fail('修改原因不能超过200字');
    if(body.confirm!==true&&body.confirm!==false&&body.confirm!==undefined)fail('确认标记无效');
    if(body.confirm!==true){
      const {shares,totalBasis,total}=normalizeShares(body.shares);
      if(sameShares(state.shares,shares))return {ok:true,unchanged:true,message:'草稿未变化，未记录修改。'};
      const next={...old,shares,sharesUpdatedAt:stamp(),sharesConfirmed:hadConfirm&&sameShares(shares,baseline)};
      const before=state.shares.length?sharesText(state.shares):'未分摊';
      next.history=[...(old.history||[]),{at:stamp(),actor:user.name,actorId:user.id,text:'保存责任分摊草稿：'+sharesText(shares)+'（当前合计 '+total.toFixed(2)+'%；原草稿：'+before+'；上次确认：'+(hadConfirm?sharesText(baseline):'无')+(reason?'；原因：'+reason:'')+'；未确认）'}];
      const saved=store.put('claims',old.id,next,{expectedVersion:body.version,actor:user,event:'claim.shares.draft',details:{id:old.id,totalBasis}});
      return {...saved,unchanged:false};
    }
    const {shares,totalBasis}=normalizeShares(body.shares,{requireFull:true});
    const changedBaseline=!sameShares(shares,baseline);
    if(hadConfirm&&changedBaseline&&!reason)fail('修改已确认的分摊比例必须填写修改原因，确认前请补齐。');
    if(!changedBaseline&&state.sharesConfirmed)return {ok:true,unchanged:true,message:'已确认且比例未变化，无需重复确认。'};
    const note=!hadConfirm?'首次录入责任分摊：':changedBaseline?'确认责任分摊修改：':'确认责任分摊（与上次确认一致）：';
    const next={
      ...old,shares,confirmedShares:shares,sharesConfirmed:true,
      sharesConfirmedAt:stamp(),sharesConfirmedBy:user.id,sharesUpdatedAt:stamp()
    };
    next.history=[...(old.history||[]),{at:stamp(),actor:user.name,actorId:user.id,text:note+sharesText(shares)+'（原确认：'+(hadConfirm?sharesText(baseline):'无')+'；原因：'+(reason||(hadConfirm?'未修改':'首次录入'))+'；合计 100.00%）'}];
    const saved=store.put('claims',old.id,next,{expectedVersion:body.version,actor:user,event:'claim.shares.confirm',details:{id:old.id,totalBasis,changed:changedBaseline,hadConfirm}});
    return {...saved,unchanged:false};
  }

  // 新模型期限修改：属于新模型写操作，和办理/分摊共用同一套资格、经办人、终态、版本与事务规则，
  // 不再作为旧 PATCH 的例外分支。legacy 单据（无 stage）仍走原进度路径。
  function setDeadline(user,id,body){
    const old=store.get('claims',id);
    if(!old)fail('索赔记录不存在',404);
    if(body.version===undefined)fail('请提供记录版本号');
    if(Number(body.version)!==old.version)fail('记录已被其他人更新，请刷新后重试',409);
    const state=decorateOne(old,people());
    if(user.role!=='admin'){
      if(!canManage(user))fail('只有质量工程师可以修改办理期限',403);
      if(!state.ownerId)fail('此索赔尚未分配经办人，请先转办指定',409);
      if(state.ownerId!==user.id)fail('只有当前经办人可以修改办理期限',403);
    }
    // 已完成是终态：管理员也不能从普通期限入口改写，本轮不另设纠错流程。
    if(state.done)fail('已完成的索赔不能再修改办理期限',409);
    const deadline=str(body.deadline??old.deadline??'');
    if(deadline&&!dateValid(deadline))fail('办理期限无效');
    const next={...old};
    const changed=deadline!==str(old.deadline);
    if(changed)next.deadline=deadline;
    // 与旧路径保持一致的组合请求：同一事务内可同时提交报故关联（独立权限）。
    if(Object.hasOwn(body,'faultId')){
      if(!hasPermission(user,'imports.manage'))fail('当前账号没有此操作权限',403);
      const faultId=str(body.faultId);
      if(faultId&&!store.get('faults',faultId))fail('请选择存在的报故单号');
      Object.assign(next,{faultId,faultIds:faultId?[faultId]:[],linkUpdatedAt:stamp()});
    }
    if(!changed&&!Object.hasOwn(body,'faultId'))return old;
    next.history=[...(old.history||[]),...(changed?[{at:stamp(),actor:user.name,actorId:user.id,text:'更新办理期限：'+(str(old.deadline)||'未设')+' → '+(deadline||'未设')}]:[])];
    return store.put('claims',old.id,next,{expectedVersion:body.version,actor:user,event:changed?'claim.deadline':'claim.link',details:{id:old.id,deadline}});
  }

  function command(user,id,body){
    const old=store.get('claims',id);
    if(!old)fail('索赔记录不存在',404);
    if(body.version===undefined)fail('请提供记录版本号');
    if(Number(body.version)!==old.version)fail('记录已被其他人更新，请刷新后重试',409,{currentVersion:old.version});
    const users=people(),state=decorateOne(old,users),action=str(body.action);
    if(action==='transfer'){
      const reason=str(body.reason);
      if(!reason)fail('请填写整单转办原因');
      if(reason.length>500)fail('转办原因不能超过500字');
      const to=str(body.to),target=users.find(user=>user.id===to);
      if(!target||target.enabled===false)fail('请选择启用的接收人');
      if(!isEngineer(target))fail('整单转办只能交给质量工程师');
      if(target.id===(state.ownerId||''))fail('接收人已是当前经办人');
      if(state.done)fail('已完成的索赔不能转办');
      if(user.role!=='admin'){
        if(!canManage(user))fail('当前账号没有整单转办权限',403);
        if(!state.ownerId)fail('此索赔尚未分配经办人，请先由质量工程师指定',409);
        if(state.ownerId!==user.id)fail('只有当前经办人可以整单转办',403);
      }
      const next={...old,ownerId:target.id,ownerName:target.name,transferredAt:stamp()};
      next.transfers=[...(old.transfers||[]),{from:state.ownerId||'',fromName:state.ownerName||'待分配',to:target.id,toName:target.name,at:stamp(),by:user.id,byName:user.name,reason,stage:state.stage||''}];
      next.history=[...(old.history||[]),{at:stamp(),actor:user.name,actorId:user.id,text:'整单转办：'+(state.ownerName||'待分配')+' → '+target.name+'；原因：'+reason+'；期限 '+str(old.deadline||'未设')+'、金额与分摊比例原样保留'}];
      return store.put('claims',old.id,next,{expectedVersion:body.version,actor:user,event:'claim.transfer',details:{id:old.id,from:state.ownerId||'',to:target.id,reason}});
    }
    if(!['start','processed','complete'].includes(action))fail('操作无效');
    if(user.role!=='admin'){
      if(!canManage(user))fail('只有质量工程师可以办理索赔',403);
      if(!state.ownerId)fail('此索赔尚未分配经办人，请先转办指定',409);
      if(state.ownerId!==user.id)fail('只有当前经办人可以办理此索赔',403);
    }
    if(state.done)fail('已完成的索赔不能再次办理');
    const note=str(body.note);
    if(note.length>2000)fail('说明不能超过2000字');
    if(action==='start'){
      if(state.stage&&state.stage!=='待处理')fail('当前阶段为“'+state.stage+'”，不能重复开始办理');
      const next={...old,stage:'处理中',startedAt:stamp(),startedBy:user.id};
      next.history=[...(old.history||[]),{at:stamp(),actor:user.name,actorId:user.id,text:'开始办理：'+(state.stage||'未开始')+' → 处理中'+(state.legacy?'（原OA状态：'+str(old.status||'未填')+'，未改动）':'')}];
      return store.put('claims',old.id,next,{expectedVersion:body.version,actor:user,event:'claim.start',details:{id:old.id}});
    }
    if(action==='processed'){
      if(state.stage!=='处理中')fail(state.stage?'请按 待处理 → 处理中 → 待结算 顺序办理':'请先开始办理后再提交处理结果');
      if(!note)fail('请填写处理措施与结果，才能进入待结算');
      const next={...old,stage:'待结算',processNote:note,processedAt:stamp(),processedBy:user.id};
      if(str(body.deadline)){
        if(!dateValid(body.deadline))fail('办理期限无效');
        next.deadline=str(body.deadline);
      }
      next.history=[...(old.history||[]),{at:stamp(),actor:user.name,actorId:user.id,text:'处理完成 → 待结算：'+note}];
      return store.put('claims',old.id,next,{expectedVersion:body.version,actor:user,event:'claim.processed',details:{id:old.id}});
    }
    if(state.stage!=='待结算')fail(state.stage?'请先提交处理结果再确认结束':'请先提交处理结果再确认结束');
    const mode=str(body.settlement?.mode||body.mode);
    if(!['赔付','无需赔付'].includes(mode))fail('请选择结算结论：赔付或无需赔付');
    const conclusion=str(body.settlement?.note||body.note);
    if(!conclusion)fail('请填写结算结论说明，不能只凭金额结束');
    if(conclusion.length<4)fail('结算结论说明至少4个字');
    let amountCents=null;
    if(mode==='赔付'){
      const provided=body.settlement?.amount??body.amount;
      if(provided===undefined||provided===null||str(provided)===''){
        const known=old.actualCents??old.agreedCents??null;
        if(known===null)fail('请填写实际赔付金额，或选择无需赔付并说明依据');
        amountCents=known;
      }else amountCents=centsOf(provided,'实际赔付金额');
    }
    const next={...old,stage:CLAIM_END,completedAt:stamp(),completedBy:user.id,settlement:{mode,amountCents,amount:money(amountCents),note:conclusion,at:stamp(),by:user.id,byName:user.name}};
    // 结算即有效实际赔付：金额、状态与审计同一次提交，列表/详情/分摊/导出/看板同口径。
    const effective=mode==='赔付'?(amountCents??null):0;
    const originalActual=old.actualCents??null;
    if(originalActual!==effective){
      next.importedActualCents=old.importedActualCents??originalActual;
      next.importedActual=money(next.importedActualCents);
    }
    next.actualCents=effective;next.actual=money(effective);
    next.history=[...(old.history||[]),{at:stamp(),actor:user.name,actorId:user.id,text:'结束索赔：'+mode+(amountCents===null?'':' '+money(amountCents).toFixed(2)+'元')+'；结论：'+conclusion+(originalActual!==effective?'；实际赔付字段按结算金额更新（原值 '+(originalActual===null?'未知':money(originalActual).toFixed(2)+'元')+' 已单独保留）':'')}];
    return store.put('claims',old.id,next,{expectedVersion:body.version,actor:user,event:'claim.complete',details:{id:old.id,mode,amountCents}});
  }

  // 我的待办与进度：复用8D真实任务队列，附加本人索赔整单待办；已处理/已转出可只读回看。
  function workbench(user,queueRows=[]){
    const users=people(),claims=scopedData(store,user).claims,today=dateStamp(now());
    const todo=[],done=[],seen=new Set(),doneSeen=new Set();
    const push=(list,set,row)=>{
      const key=[row.source,row.refId,row.kind||''].join('|');
      if(set.has(key))return;set.add(key);list.push(row);
    };
    for(const row of queueRows){
      push(todo,seen,{
        source:row.analysisId?'analysis':'preliminary',
        refId:row.taskId||row.analysisId,
        kind:row.type,
        title:row.label||row.title||'8D任务',
        refTitle:row.title||'',
        stage:row.stage||'',
        ownerName:user.name,
        due:row.due||'',
        overdue:!!row.overdue,
        analysisId:row.analysisId||'',
        faultId:row.faultId||'',
        taskId:row.taskId||'',
        claimId:'',
        action:'办理'
      });
    }
    for(const claim of claims){
      const state=decorateOne(claim,users);
      if(state.ownerId===user.id&&!state.done){
        push(todo,seen,{source:'claim',refId:claim.id,kind:'claim',title:claim.issue||claim.customer||'索赔办理',refTitle:claim.customer||'',stage:state.stage||'待处理',ownerName:user.name,due:state.due,overdue:state.overdue,analysisId:'',faultId:str(claim.faultId),taskId:'',claimId:claim.id,action:'办理索赔'});
      }
      if(state.done&&state.ownerId===user.id){
        push(done,doneSeen,{source:'claim',refId:claim.id,kind:'completed',title:claim.issue||claim.customer||'索赔办理',stage:state.stageLabel,doneAt:str(claim.completedAt||claim.sharesConfirmedAt||''),ownerName:state.ownerName,overdue:false,claimId:claim.id,analysisId:'',faultId:'',taskId:'',transferTo:''});
      }
      for(const item of claim.transfers||[]){
        if(item.from!==user.id||state.ownerId===user.id)continue;
        push(done,doneSeen,{source:'claim',refId:claim.id,kind:'transferred',title:claim.issue||claim.customer||'索赔办理',stage:state.stageLabel,doneAt:str(item.at),ownerName:item.toName||'',overdue:false,claimId:claim.id,analysisId:'',faultId:'',taskId:'',transferTo:item.toName||''});
      }
    }
    const visible=scopedData(store,user);
    for(const analysis of visible.analyses){
      for(const task of analysis.workflow?.tasks||[]){
        if(task.archived||task.gridRoot)continue;
        const transfers=task.transfers||[];
        if(task.owner===user.id&&task.status==='accepted'){
          push(done,doneSeen,{source:'analysis',refId:task.id,kind:'completed',title:task.title||'8D任务',refTitle:analysis.title||'',stage:task.stage||'',doneAt:str(task.submittedAt||task.acceptedAt||''),ownerName:user.name,overdue:false,analysisId:analysis.id,faultId:analysis.faultId||'',taskId:task.id,claimId:'',transferTo:''});
        }
        for(const transfer of transfers){
          if(transfer.from!==user.id||task.owner===user.id)continue;
          const received=users.find(person=>person.id===task.owner)?.name||transfer.toName||'';
          push(done,doneSeen,{source:'analysis',refId:task.id,kind:'transferred',title:task.title||'8D任务',refTitle:analysis.title||'',stage:task.status==='accepted'?'接收人已办结':task.status==='submitted'?'接收人已提交':'接收人办理中',doneAt:str(transfer.at),ownerName:received,overdue:false,analysisId:analysis.id,faultId:analysis.faultId||'',taskId:task.id,claimId:'',transferTo:received});
        }
      }
    }
    const progress={};
    for(const stage of CLAIM_STAGES)progress[stage]=0;
    for(const claim of claims){const state=decorateOne(claim,users);if(state.stage)progress[state.stage]=(progress[state.stage]||0)+1;}
    return {
      generatedAt:stamp(),today,
      todo:todo.sort((a,b)=>(b.overdue?1:0)-(a.overdue?1:0)||String(a.due||'9999').localeCompare(String(b.due||'9999'))),
      done:done.sort((a,b)=>String(b.doneAt).localeCompare(String(a.doneAt))).slice(0,200),
      counts:{todo:todo.length,done:done.length,overdue:todo.filter(row=>row.overdue).length,claims:progress},
      engineers:users.filter(isEngineer).map(user=>({id:user.id,name:user.name,dept:user.dept||''}))
    };
  }

  // 写操作整体置于同一事务：业务记录、确认基线、版本与审计要么一起提交，要么一起回滚。
  // 复用 store 已有的事务封装，不改变其它模块的写入语义。
  const atomic=fn=>store.transaction(fn);
  function api(action,{user,body={},id,queueRows}={}){
    if(!user)fail('请先登录',401);
    if(action==='workbench')return workbench(user,queueRows);
    if(action==='preview')return previewShares(user,body);
    if(action==='create')return atomic(()=>create(user,body));
    if(action==='shares')return atomic(()=>saveShares(user,id,body));
    if(action==='deadline')return atomic(()=>setDeadline(user,id,body));
    if(action==='command')return atomic(()=>command(user,id,body));
    fail('操作无效');
  }
  return {api,decorate,decorateOne,stageOf,canManage,isEngineer,settlementCents,effectiveActualCents};
}
