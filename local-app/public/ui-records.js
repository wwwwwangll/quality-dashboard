(function(root){
  'use strict';
  const claimColumns=[
    ['processingDate','处理日期','date'],['id','索赔单号'],['nonconformityId','不合格单号'],['customer','客户名称','choice'],
    ['failureMode','失效模式'],['customerMaterial','客户料号'],['material','内部料号'],['sn','SN号'],
    ['logisticsName','物流名称'],['issue','不合格描述'],['quantity','数量','number'],['amount','索赔金额','money'],
    ['agreed','承认金额','money'],['photo','故障照片','photo'],['customerInitiator','客户发起人'],
    ['location','厂内/厂外','choice'],['responsibility','责任判定','choice'],['handlingResult','处理结果'],
    ['handler','处理人','choice'],['supplierAmount','供应商索赔金额','money'],['supplierAgreed','供应商承认金额','money'],['remarks','备注']
  ];
  // 办理状态列：由服务端按 store 真实数据计算（不经前端推断），追加在原22列之后，保证原字段与列序不变。
  const claimStateColumns=[
    ['ownerName','当前经办人','choice'],['stageLabel','办理阶段','choice'],['due','办理期限','text'],
    ['sharesLabel','责任分摊','choice'],['actual','实际赔付','money'],['confirmedLabel','分摊确认','choice'],['overdueLabel','是否逾期','choice']
  ];
  const reportFields=[
    ['id','投诉编号'],['reporter','投诉人','choice'],['material','投诉物料号'],['product','投诉物料名称'],
    ['assemblyMaterial','故障件总成料号（4/5X料号）'],['description','故障现象描述'],['customerCode','客户编码'],
    ['customerMaterialName','客户物料名称'],['category','产品类别','choice'],['sn','投诉SN'],['customer','客户名称','choice'],
    ['organization','内部组织','choice'],['trackingNo','物流单号'],['firstHandler','第一经手人','choice'],
    ['date','投诉日期','date'],['resolution','解决措施','choice'],['contact','联系人'],['contactPhone','联系电话'],
    ['recovered','是否已全部追回','choice'],['claimId','索赔单号'],['repair','维修方式','choice'],
    ['inspection','是否需要检测单','choice'],['documentStatus','文档状态','choice'],['analysisStatus','分析进度','choice']
  ];
  const workFields=[
    ['analysisId','8D编号'],['faultId','投诉编号'],['reporter','投诉人','choice'],['material','投诉物料号'],
    ['product','投诉物料名称'],['title','分析标题'],['customer','客户名称','choice'],['category','产品类别','choice'],
    ['stage','当前阶段','choice'],['analysisStatus','8D状态','choice'],['date','投诉日期','date']
  ];
  const importTypes={
    fault:{label:'导入投诉表',route:'faults'},claim:{label:'导入索赔表',route:'claims'},
    shipment:{label:'导入月度发货表',route:'overview'},product:{label:'导入产品分类与料号映射',route:'overview'}
  };
  const isSet=value=>value!==''&&value!==undefined&&value!==null;
  const unique=values=>[...new Set(values.filter(isSet).map(String))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
  const currency=(row,key)=>row[key+'Cents']!=null?row[key+'Cents']/100:row[key]??null;
  const fieldsFor=kind=>kind==='claims'?[...claimColumns,...claimStateColumns]:kind==='work'?workFields:reportFields;
  function valuesFor(kind,row,data){
    const report=kind==='work'?data.faults.find(f=>f.id===row.faultId)||row.snapshot||{}:row;
    const values={...report,category:report.category||data.products?.find(p=>p.material===report.material)?.category||''};
    if(kind==='work')Object.assign(values,{
      analysisId:row.id,faultId:row.faultId,title:row.title,stage:row.stage,
      analysisStatus:({active:'进行中',closed:'已关闭',draft:'草稿'})[row.status]||row.status
    });
    if(kind==='claims'){
      for(const[key,,type]of claimColumns)if(type==='money')values[key]=currency(row,key);
      values.photo=row.photo?'有照片':'无照片';
      const state=row.state||{};
      Object.assign(values,{
        ownerName:state.ownerName||'待分配',
        stageLabel:state.stageLabel||'未开始',
        due:state.due||'期限待补充',
        sharesLabel:state.sharesLabel||'未分摊',
        confirmedLabel:state.sharesConfirmed?'已确认':'未确认',
        overdueLabel:state.overdue?'是':'否'
      });
    }
    if(kind==='faults')values.analysisStatus=data.analyses.some(a=>a.faultId===row.id)?'已有 8D':
      data.preliminary.some(p=>p.faultId===row.id&&p.status==='submitted')?'已提交初步分析':'未开展 8D';
    return values;
  }
  function matches(kind,row,data,filters={}){
    const values=valuesFor(kind,row,data);
    return fieldsFor(kind).every(([key,,type])=>{
      const value=values[key];
      if(type==='date')return (!filters.from&&!filters.to)||(!!value&&(!filters.from||value>=filters.from)&&(!filters.to||value<=filters.to));
      if(type==='number'||type==='money'){
        const min=filters[key+'Min'],max=filters[key+'Max'];
        if(!isSet(min)&&!isSet(max))return true;
        return value!=null&&Number.isFinite(Number(value))&&(!isSet(min)||Number(value)>=Number(min))&&(!isSet(max)||Number(value)<=Number(max));
      }
      if(!isSet(filters[key]))return true;
      return type==='choice'||type==='photo'?String(value??'')===String(filters[key]):
        String(value??'').toLowerCase().includes(String(filters[key]).trim().toLowerCase());
    });
  }
  function validate(kind,values){
    for(const key of ['from','to']){
      if(values[key]){
        const date=new Date(values[key]+'T00:00:00Z');
        if(!/^\d{4}-\d{2}-\d{2}$/.test(values[key])||!Number.isFinite(+date)||date.toISOString().slice(0,10)!==values[key]){
          return {field:key,message:'请选择有效日期。'};
        }
      }
    }
    if(values.from&&values.to&&values.from>values.to)return {field:'to',message:'结束日期不能早于开始日期。'};
    for(const[key,label,type]of fieldsFor(kind)){
      if(type!=='money'&&type!=='number')continue;
      const min=values[key+'Min'],max=values[key+'Max'];
      for(const[suffix,value]of [['Min',min],['Max',max]]){
        if(isSet(value)&&!Number.isFinite(Number(value)))return {field:key+suffix,message:label+'必须是有效数字。'};
      }
      if(isSet(min)&&isSet(max)&&Number(min)>Number(max))return {field:key+'Max',message:label+'的最大值不能小于最小值。'};
    }
    return null;
  }
  function create({escape:E}){
    const states=Object.fromEntries(['faults','claims','work'].map(kind=>[kind,{applied:{},draft:{},expanded:false}]));
    function filter(kind,rows,data){return rows.filter(row=>matches(kind,row,data,states[kind].applied));}
    function capture(form){states[form.dataset.listFilter].draft=Object.fromEntries(new FormData(form));}
    function apply(form){
      capture(form);
      const state=states[form.dataset.listFilter],error=validate(form.dataset.listFilter,state.draft);
      if(error){
        state.expanded=true;
        const extra=form.querySelector('[data-extra-filters]');
        if(extra)extra.hidden=false;
        const toggle=form.querySelector('[data-expand-filters]');
        toggle?.setAttribute('aria-expanded','true');
        if(toggle)toggle.textContent='收起筛选';
        form.elements[error.field].setCustomValidity(error.message);
        form.elements[error.field].reportValidity();
        return false;
      }
      state.applied={...state.draft};
      return true;
    }
    function reset(kind){states[kind].applied={};states[kind].draft={};}
    function toggle(form){
      const state=states[form.dataset.listFilter];
      state.expanded=!state.expanded;
      form.querySelector('[data-extra-filters]').hidden=!state.expanded;
      const button=form.querySelector('[data-expand-filters]');
      button.textContent=state.expanded?'收起筛选':'展开筛选';
      button.setAttribute('aria-expanded',String(state.expanded));
    }
    function filters(kind,data,count){
      const state=states[kind],values=state.draft;
      const rows=(kind==='work'?data.analyses:data[kind]).map(row=>valuesFor(kind,row,data));
      function input(key,label,type='text'){
        return '<input aria-label="'+E(label)+'" type="'+type+'" name="'+key+'" value="'+E(values[key]??'')+'"'+
          (type==='number'?' step="any"':'')+'>';
      }
      function row([key,label,type]){
        let control=input(key,label);
        if(type==='choice'||type==='photo'){
          const choices=unique([...rows.map(item=>item[key]),values[key]]);
          control='<select aria-label="'+E(label)+'" name="'+key+'"><option value="">不限</option>'+
            choices.map(value=>'<option value="'+E(value)+'"'+(String(values[key])===value?' selected':'')+'>'+E(value)+'</option>').join('')+'</select>';
        }
        if(type==='date')control=input('from',label+'开始','date')+'<span>至</span>'+input('to',label+'结束','date');
        if(type==='money'||type==='number')control=input(key+'Min',label+'最小值','number')+'<span>至</span>'+input(key+'Max',label+'最大值','number');
        return '<div class="review-filter-row"><span>'+E(label)+'</span><div>'+control+'</div></div>';
      }
      const fields=fieldsFor(kind);
      return '<form class="panel review-list-filters" data-list-filter="'+kind+'" aria-label="列表筛选">'+
        '<div class="review-filter-rows">'+fields.slice(0,4).map(row).join('')+'<div data-extra-filters'+(state.expanded?'':' hidden')+'>'+
        fields.slice(4).map(row).join('')+'</div></div><div class="review-filter-actions">'+
        '<button type="submit" class="work-btn accent">确定</button><button type="button" class="work-btn" data-clear-list-filter>重置</button>'+
        '<button type="button" class="work-btn" data-expand-filters aria-expanded="'+state.expanded+'">'+
        (state.expanded?'收起筛选':'展开筛选')+'</button><span class="review-filter-count" role="status">共 '+count+' 条</span></div></form>';
    }
    return {filter,filters,capture,apply,reset,toggle,resetAll(){for(const kind of Object.keys(states)){reset(kind);states[kind].expanded=false;}}};
  }
  function claimExport(rows,options={}){
    const stateRows=!!options.state;
    const stateValues=row=>{
      const state=row.state||{};
      return [state.ownerName||'待分配',state.stageLabel||'未开始',state.due||'',state.sharesLabel||'未分摊',row.actualCents==null?'':(row.actualCents/100).toFixed(2),row.state?.settlement?(row.state.settlement.mode==='赔付'?'赔付':'无需赔付'):(state.sharesConfirmed?'已确认':'未确认'),state.overdue?'是':'否'];
    };
    return [
      [...claimColumns.map(([,label])=>label),...(stateRows?claimStateColumns.map(([,label])=>label):[])],
      ...rows.map(row=>{
        const base=claimColumns.map(([key,,type])=>
          type==='money'?currency(row,key):key==='photo'&&row.photo&&typeof row.photo==='object'?row.photo.id||row.photo.name||'':row[key]??'');
        return stateRows?[...base,...stateValues(row)]:base;
      })
    ];
  }
  function claimTable(rows,E,money,options={}){
    const me=options.me||'',canManage=!!options.canManage;
    const cell=([key,,type],row)=>{
      if(key==='ownerName'){const state=row.state||{},value=state.ownerName||'待分配';return '<td>'+E(value)+(state.unassigned?'<small>待分配</small>':'')+'</td>';}
      if(key==='stageLabel'){const state=row.state||{};return '<td><span class="tag '+(state.done?'good':state.overdue?'danger':'')+'">'+E(state.stageLabel||'未开始')+'</span>'+(state.legacy?'<small>保留OA状态 '+E(row.status||'未填')+'</small>':'')+'</td>';}
      if(key==='due'){const state=row.state||{};return '<td>'+(state.due?E(state.due):'期限待补充')+(state.overdue?'<small>已逾期</small>':'')+'</td>';}
      if(key==='sharesLabel'){const state=row.state||{},shares=Array.isArray(state.shares)?state.shares:[];return '<td class="text-wrap">'+E(state.sharesLabel||'未分摊')+(shares.length?'<small>合计 '+Number(state.shareTotal||0).toFixed(2)+'%</small>':'')+'</td>';}
      if(key==='confirmedLabel'){const state=row.state||{};return '<td><span class="tag '+(state.sharesConfirmed?'good':'')+'">'+(state.sharesConfirmed?'已确认':'未确认')+'</span></td>';}
      if(key==='overdueLabel'){const state=row.state||{};return '<td>'+(state.overdue?'<span class="tag danger">逾期</span>':'—')+'</td>';}
      if(type==='money'){const value=currency(row,key);return '<td>'+(value==null?'—':E(money(value)))+'</td>';}
      return '';
    };
    const content=rows.map(row=>'<tr>'+claimColumns.map(([key,,type])=>{
      const value=type==='money'?currency(row,key):row[key];
      const label=value==null||value===''?'—':E(type==='money'?money(value):value);
      if(key==='id')return '<td><button class="text-btn" data-open-claim="'+E(row.id)+'">'+label+'</button></td>';
      if(key==='photo'&&value)return '<td><button class="work-btn compact" data-wf-download="'+E(typeof value==='object'?value.id:value)+'">查看照片</button></td>';
      return '<td>'+label+'</td>';
    }).join('')+claimStateColumns.map(column=>cell(column,row)).join('')+
      '<td>'+(canManage&&row.state&&row.state.ownerId===me&&!row.state.done
        ?'<button class="work-btn compact accent" data-claim-act="'+E(row.id)+'">办理</button>'
        :'<button class="work-btn compact" data-open-claim="'+E(row.id)+'">查看</button>')+'</td></tr>').join('');
    const total=claimColumns.length+claimStateColumns.length+1;
    return '<section class="panel table-wrap review-claims-table" tabindex="0" aria-label="索赔记录，可横向滚动"><table><thead><tr>'+
      claimColumns.map(([,label])=>'<th scope="col">'+label+'</th>').join('')+
      claimStateColumns.map(([,label])=>'<th scope="col">'+label+'</th>').join('')+
      '<th scope="col">操作</th></tr></thead><tbody>'+
      (content||'<tr><td colspan="'+total+'">暂无匹配的索赔记录。</td></tr>')+'</tbody></table></section>';
  }
  function importButton(kind,E){
    const item=importTypes[kind];
    if(!item)return '';
    return '<button type="button" class="work-btn" data-route="imports" data-import-kind="'+kind+'">'+E(item.label)+'</button>';
  }
  root.QualityRecords={create,claimColumns,claimStateColumns,claimExport,claimTable,importTypes,importButton,currency,matches,validate,valuesFor};
})(window);
