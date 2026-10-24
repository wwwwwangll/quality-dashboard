(function (root) {
  'use strict';
  const DAY = 86400000;
  const quantityCategories = ['半成品', '成品', '原材料', '库存品', '在途品', '客户端成品'];
  const preventionGroups = [
    {title:'质量策划与标准文件更新',items:[['pfmea','更新 PFMEA（过程失效模式与影响分析）'],['dfmea','更新 DFMEA（设计失效模式与影响分析）'],['cp','更新 CP（控制计划）'],['sop','更新 SOP/WI（标准作业程序／作业指导书）'],['pfd','更新过程流程图（PFD）'],['drawing','更新产品图纸／技术规范'],['inspection','更新检验标准／检验指导书']]},
    {title:'生产过程与管理机制完善',items:[['maintenance','更新设备点检／预防性维护计划'],['tooling','更新工装、夹具、模具管理标准'],['poka','更新防错装置及防错验证标准'],['response','更新异常响应／反应计划'],['training','更新人员培训及岗位资格要求']]},
    {title:'质量体系与经验沉淀',items:[['system','更新质量管理程序／制度'],['standard','更新设计或工艺标准化规范'],['lessons','更新经验教训库（Lessons Learned）'],['audit','纳入分层过程审核（LPA）／内部审核']]},
    {title:'其他',items:[['other','其他预防再发措施']]}
  ];
  const preventionOptions=preventionGroups.flatMap(g=>g.items);
  const isLesson=t=>t.kind==='prevention'&&t.data?.measureKey==='lessons';
  const toolOptions = ['鱼骨图', '故障树', '5WHY', '变更分析'];
  const stageIds = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];
  const optionalStages = ['D3', 'D5', 'D7'];
  const oldFields = {
    D1: { goal: '共同目标与协作说明', weightReason: '基础工作分与分工依据' },
    D2: { description: '问题描述', condition: '发生地点与工况', impact: '影响范围与数量' },
    D3: { containment: '临时措施与覆盖范围', execution: '措施实施结果' },
    D4: { environment: '复现环境与条件', steps: '复现步骤与次数', result: '复现实验结果', rootCause: '已验证的发生根因', escapeCause: '流出原因', proof: '根因验证依据' },
    D5: { actions: '永久整改方案及对应根因', plan: '方案验证依据' },
    D6: { implementation: '措施实施范围与结果', method: '验证方法与通过标准', verification: '效果验证结果' },
    D7: { prevention: '预防措施', extension: '类似产品排查结果' },
    D8: { summary: '分析总结' }
  };
  const text = value => String(value == null ? '' : value).trim();
  const clone = value => JSON.parse(JSON.stringify(value));
  const nowISO = () => new Date().toISOString();
  function instant(value, endOfDate) {
    if (!value) return NaN;
    let input = text(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) input += endOfDate ? 'T23:59:59.999+08:00' : 'T00:00:00+08:00';
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(input)) input += '+08:00';
    return Date.parse(input);
  }
  function validDate(value) {
    if (!text(value) || !Number.isFinite(instant(value))) return false;
    const date = text(value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const [y, m, d] = date.split('-').map(Number);
    const test = new Date(Date.UTC(y, m - 1, d));
    return test.getUTCFullYear() === y && test.getUTCMonth() === m - 1 && test.getUTCDate() === d;
  }
  const hasNumber = value => text(value) !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
  const hasEvidence = task => (task.files || []).some(f => text(f.id) && text(f.name)) || (task.links || []).some(l => {
    try { return !!text(l.name) && ['http:', 'https:'].includes(new URL(l.url).protocol); } catch (_) { return false; }
  });
  function defaults(item) {
    return {
      version: 4, tasks: [], legacyClosed: item.status === 'closed', legacyPending: item.status === 'pending',
      legacyTasks: clone(item.tasks || []), legacyBonuses: clone(item.bonuses || {}),
      d2: { reproductionDescription: '', major: false, batch: false, freeze: false, freezeNumber: '', snScope: '' },
      d3: { samePlan: '' },
      d4: { tools: [], reproductionRelation: '待验证', rootCauseRef: '', relationEvidence: '' },
      d6: { withdrawal: '' },
      d8: {
        similar: [], recurrence: { originalId: '', reason: '' }, horizontal: false, horizontalReason: '',
        lessons: { phenomenon: '', rootCause: '', effective: '', failed: '', scope: '', evidence: '', confirmed: false },
        production: { enabled: false, mode: 'month', product: '', model: '', revision: '', effectiveDate: '', message: '', departments: [], engineers: [], orderId: '', matchedAt: '', productionAt: '', reminderState: 'pending', events: [] }
      }
    };
  }
  function fillMissing(target, source) {
    for (const [key, value] of Object.entries(source)) {
      if (target[key] === undefined || target[key] === null) target[key] = clone(value);
      else if (value && typeof value === 'object' && !Array.isArray(value) && typeof target[key] === 'object' && !Array.isArray(target[key])) fillMissing(target[key], value);
    }
    return target;
  }
  const causeSections = { occurrence: '产生原因', escape: '流出原因', occurrenceDept: '产生原因责任部门', escapeDept: '流出原因责任部门' };
  const isQuantity = t => t.kind === 'quantity' && t.policyVersion === 4;
  const evidenceRequired = t => t.simpleFreeze ? false : t.policyVersion === 4 ? !!t.evidenceRequired : true;
  const isQualityManager = actor => root.AnalysisCore?.isQualityManager(actor) === true;
  const reviewerFor = (item, t) => t.stage === 'D4' && t.kind === 'cause' ? 'me' : t.reviewer;
  const isImage = f => /^image\//i.test(f.type || '') || /\.(png|jpe?g|gif|webp|bmp|heic|avif)$/i.test(f.name || '');
  function evidencePresent(t) {
    if (t.stage === 'D4' && t.kind === 'cause') return (t.files || []).some(f => text(f.id) && isImage(f));
    if (t.kind === 'rework' && t.policyVersion === 4) return (t.files || []).some(f => text(f.id) && text(f.name));
    return hasEvidence(t);
  }
  function upgrade(item) {
    const w = item.workflow;
    if (w.version >= 4) return;
    // Preserve original payloads and scores; retired records remain available in history and exports.
    w.archiveV3 = clone({ d4: w.d4, stageD4: item.stages.D4, responsibility: item.responsibility, reproduction: item.reproduction });
    if (w.legacyClosed || w.legacyPending || item.status !== 'active') { w.frozenV3 = !w.legacyClosed && !w.legacyPending; w.version = 4; return; }
    const additions = [];
    for (const t of w.tasks) {
      if (t.stage === 'D4' || t.kind === 'quantity') {
        t.archived = true;
        if (t.kind === 'quantity') {
          const existing = additions.find(n => n.data.category === t.data.category);
          if (existing) { existing.data.quantity = ''; existing.unitReview = '旧版此分类有多条数量记录，请重新确认pcs数量'; continue; }
          const n = newTask('D3', 'quantity', (t.data.category || '') + '数量确认');
          n.owner = t.owner; n.due = t.due; n.assignedAt = t.assignedAt; n.data.category = t.data.category;
          const convertible = ['pcs', '件'].includes(text(t.data.unit).toLowerCase());
          if (convertible && text(t.data.quantity) !== '' && Number.isInteger(Number(t.data.quantity)) && Number(t.data.quantity) >= 0) n.data.quantity = t.data.quantity;
          n.previousQuantityId = t.id;
          if (!convertible) n.unitReview = '原单位为 ' + (t.data.unit || '未填写') + '，请重新确认 pcs 数量';
          additions.push(n);
        }
      } else if (['draft', 'returned'].includes(t.status)) {
        t.policyVersion = 4; t.evidenceRequired = t.stage !== 'D1';
      }
    }
    w.tasks.push(...additions); w.version = 4;
    // Reconfirm the new D4 responsibilities; never infer primary/secondary roles from old percentages.
    if (!w.legacyClosed && !w.legacyPending) for (const id of ['D4','D5','D6','D7','D8']) item.stages[id].done = false;
  }
  function ensure(item) {
    if (!item.workflow) item.workflow = defaults(item);
    else fillMissing(item.workflow, defaults(item));
    upgrade(item);
    const w = item.workflow;
    if (!w.uiRevision5 && item.status === 'active' && !w.legacyClosed && !w.legacyPending && !w.frozenV3) {
      const candidates=w.tasks.filter(t=>!t.archived&&t.kind==='sn');
      if(candidates.length)w.d2.primarySnId=(candidates.find(t=>t.status==='accepted')||candidates.find(t=>text(t.data?.quantity)!==''||text(t.result))||candidates[0]).id;
      if(w.tasks.some(t=>t.kind==='scheme'&&!t.archived))for(const t of w.tasks.filter(t=>t.kind==='rework'&&!t.archived))t.previousReworkArea=true;
      for(const old of w.tasks.filter(t=>t.kind==='freeze'&&t.status==='accepted'&&!t.simpleFreeze&&!t.archived)){
        old.previousFreezeRecord=true;
        const task=newTask('D2','freeze','产品冻结数量填报');task.owner=old.owner;task.reviewer=old.reviewer;task.base=old.base;w.tasks.push(task);
      }
      for(const t of w.tasks.filter(t=>t.kind==='freeze'&&t.status!=='accepted'&&!t.archived)){
        t.previousFreezeSnapshot=clone(t);t.simpleFreeze=true;t.policyVersion=4;t.evidenceRequired=false;
        if(t.title==='产品冻结执行与证明')t.title='产品冻结数量填报';
        fillMissing(t.data,{sn:'',productionQty:'',material:'',shippedQty:'',unit:'pcs'});
        if(t.status==='submitted')t.status='returned';
      }
      w.uiRevision5=true;
    }
    if(w.uiRevision5&&!w.tasks.some(t=>t.id===w.d2.primarySnId&&!t.archived))w.d2.primarySnId=w.tasks.find(t=>t.kind==='sn'&&!t.archived)?.id||'';
    if (!w.legacyClosed && !w.legacyPending && !w.frozenV3) {
      for (const category of quantityCategories) if (!w.tasks.some(t => !t.archived && t.kind === 'quantity' && t.data.category === category)) {
        const t = newTask('D3', 'quantity', category + '数量确认'); t.data.category = category; w.tasks.push(t);
      }
      for (const [section, title] of Object.entries(causeSections).filter(([key])=>key!=='occurrenceDept')) if (!w.tasks.some(t => !t.archived && t.kind === 'cause' && t.data.section === section)) {
        const t = newTask('D4', 'cause', title); t.data.section = section; w.tasks.push(t);
      }
    }
    if(item.status==='active'&&!w.legacyClosed&&!w.legacyPending&&!w.frozenV3) {
      if(!w.d7)w.d7={};
      if(!w.uiRevision6){
        const plans=w.tasks.filter(t=>!t.archived&&!t.previousReworkArea&&['scheme','rework'].includes(t.kind));
        const preferred=plans.find(t=>t.status==='accepted')||plans.find(t=>t.status==='submitted')||plans.find(t=>text(t.result)||t.files?.length||t.links?.length||t.owner||t.data?.categories?.length)||plans[0];
        if(preferred)w.d3.primaryPlanId=preferred.id;
        const oldDept=w.tasks.filter(t=>!t.archived&&t.kind==='cause'&&t.data.section==='occurrenceDept');
        const dept=oldDept.find(t=>t.status==='accepted')||oldDept.find(t=>t.data.primary)||oldDept[0];
        w.d4.occurrenceResponsibility=clone({primary:dept?.data.primary||'',secondary:dept?.data.secondary||[],confirmed:dept?.status==='accepted',confirmedAt:dept?.acceptedAt||''});
        w.d4.occurrenceTaskId=w.tasks.find(t=>!t.archived&&t.kind==='cause'&&t.data.section==='occurrence')?.id||'';
        for(const t of oldDept)t.mergedOccurrenceHistory=true;
        for(const t of w.tasks){if(t.kind==='production')t.stage='D6';if(t.kind==='horizontal')t.stage='D7';}
        const oldLessons=w.d8.lessons;
        if(!w.tasks.some(isLesson)&&Object.entries(oldLessons).some(([k,v])=>k!=='confirmed'&&text(v))){const t=newTask('D7','prevention','更新经验教训库（Lessons Learned）');t.data.measureKey='lessons';w.tasks.push(t);}
        w.uiRevision6=true;
      }
      let primary=w.tasks.find(t=>t.id===w.d3.primaryPlanId&&!t.archived);
      if(!primary){primary=w.tasks.find(t=>!t.archived&&!t.previousReworkArea&&['scheme','rework'].includes(t.kind));if(!primary){primary=newTask('D3','rework','返工方案');w.tasks.push(primary)}w.d3.primaryPlanId=primary.id;}
      for(const t of w.tasks.filter(t=>['scheme','rework'].includes(t.kind)&&!t.archived))t.previousPlan=t.id!==w.d3.primaryPlanId;
      if(!w.tasks.some(t=>t.id===w.d4.occurrenceTaskId&&!t.archived))w.d4.occurrenceTaskId=w.tasks.find(t=>!t.archived&&t.kind==='cause'&&t.data.section==='occurrence')?.id||'';
      for(const t of w.tasks.filter(t=>t.kind==='cause'&&t.data.section==='occurrenceDept'))t.mergedOccurrenceHistory=true;
      for(const t of w.tasks){if(t.kind==='production')t.stage='D6';if(t.kind==='horizontal')t.stage='D7';}
    }
    return w;
  }
  function selectPrevention(item,key,selected,actor){
    if(item.status!=='active'||actor!==item.owner)return {error:'只有事项负责人可以选择措施'};
    const w=ensure(item),option=preventionOptions.find(v=>v[0]===key);
    if(!option)return {error:'无效的预防措施'};
    let task=w.tasks.find(t=>!t.archived&&t.kind==='prevention'&&t.data?.measureKey===key);
    if(!task&&selected){task=newTask('D7','prevention',option[1]);task.data.measureKey=key;w.tasks.push(task);}
    if(task)task.d7Deselected=!selected;
    return {error:'',task};
  }
  function occurrenceIssues(item){
    const d=item.workflow.d4.occurrenceResponsibility||{},depts=root.AnalysisCore.departments;
    if(!depts.includes(d.primary))return '请选择产生原因主责部门';
    if(!Array.isArray(d.secondary)||d.secondary.some(v=>!depts.includes(v)||v===d.primary)||new Set(d.secondary).size!==d.secondary.length)return '产生原因次要部门须有效、不重复且不能与主责相同';
    return '';
  }
  function newTask(stage, kind, title) {
    const data = kind === 'quantity' ? { category: '', quantity: '', unit: 'pcs' }
      : kind === 'freeze' ? { sn:'', productionQty:'', material:'', shippedQty:'', unit:'pcs' }
      : kind === 'cause' ? { section: '', primary: '', secondary: [] }
      : kind === 'sn' ? { quantity: '', unit: '件', sn: '', snapshotAt: '' }
      : ['scheme', 'rework'].includes(kind) ? { categories: [] }
      : kind === 'measure' ? { rootCause: '', criteria: '', risk: '', control: '' }
      : kind === 'implementation' ? { measureId: '' }
      : kind === 'verification' ? { scope: '', criteria: '', sample: '', window: '', decision: '待验证' }
      : {};
    return { id: root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2), stage, kind, simpleFreeze: kind === 'freeze', policyVersion: 4, evidenceRequired: stage !== 'D1' && !['quantity','freeze'].includes(kind), title: title || '', scope: '', owner: '', reviewer: '', due: '', assignedAt: nowISO(), submittedAt: '', acceptedAt: '', status: 'draft', base: null, initiative: null, evidenceScore: null, ratingReason: '', result: '', links: [], files: [], submissions: [], data };
  }
  function taskEnabled(item, task) {
    const w = ensure(item);
    if (task.archived || task.previousPlan || task.mergedOccurrenceHistory || task.d7Deselected) return false;
    if (task.previousReworkArea) return false;
    if (task.previousFreezeRecord) return false;
    if (task.kind==='sn' && w.uiRevision5 && (w.d2.freeze || task.id!==w.d2.primarySnId)) return false;
    if (task.retired && task.status !== 'accepted') return false;
    if (optionalStages.includes(task.stage) && item.stages && item.stages[task.stage] && item.stages[task.stage].na && text(item.stages[task.stage].naReason)) return false;
    if (task.kind === 'freeze') return !!w.d2.freeze;
    if (task.kind === 'horizontal') return !!w.d8.horizontal;
    if (task.kind === 'production') return !!w.d8.production.enabled && (w.d8.production.reminderState !== 'handled' || task.status === 'accepted');
    return true;
  }
  function taskIssues(item, task, setupOnly) {
    const result = [], add = (type, label) => result.push({ type, label });
    const team = new Set((item.team || []).map(m => m.personId)), data = task.data || {};
    if (!text(task.title)) add('missing', '缺少任务名称');
    if (!task.owner || !team.has(task.owner)) add('missing', '请选择团队内的任务责任人');
    if (!isQuantity(task) && task.kind !== 'cause' && (!task.reviewer || !team.has(task.reviewer))) add('missing', task.stage==='D7'?'请选择团队内的审批人':'请选择团队内的验收人');
    if (!validDate(task.due)) add('missing', '缺少有效截止时间');
    if (!isQuantity(task) && (![1, 2, 3].includes(Number(task.base)) || task.base === null || text(task.base) === '')) add('missing', '请确认基础工作分（1、2、3分）');
    if (setupOnly) return result;
    if (task.kind === 'quantity') {
      if (!quantityCategories.includes(data.category)) add('missing', '数量分类无效');
      if (!hasNumber(data.quantity) || !Number.isInteger(Number(data.quantity))) add('missing', '数量须为非负整数（未知留空，确认没有填0）');
      if (isQuantity(task) && data.unit !== 'pcs') add('missing', '数量单位必须为pcs');
      if (task.unitReview) add('missing', task.unitReview);
    }
    if (task.kind === 'cause') {
      if (!causeSections[data.section]) add('missing', 'D4分区无效');
      if (!text(task.scope)) add('missing', '请填写本部分的输出要求');
      if (['occurrenceDept','escapeDept'].includes(data.section)) {
        const depts = root.AnalysisCore.departments;
        if (!depts.includes(data.primary)) add('missing', '请选择主责部门');
        if (!Array.isArray(data.secondary) || data.secondary.some(d => !depts.includes(d) || d === data.primary) || new Set(data.secondary).size !== data.secondary.length) add('missing', '次要部门须有效、不重复且不能与主责部门相同');
      }
    }
    if(task.simpleFreeze){
      if(!text(data.sn))add('missing','请填写SN号或涉及SN范围');
      if(!text(data.material))add('missing','请填写料号');
      for(const [k,label] of [['productionQty','SN对应生产数量'],['shippedQty','料号已发货数量']])if(!hasNumber(data[k])||!Number.isInteger(Number(data[k])))add('missing',label+'须为非负整数（未知留空，没有填0）');
    }
    if (task.kind === 'sn') {
      if (!text(data.sn || data.snScope || ensure(item).d2.snScope || task.scope)) add('missing', '缺少涉及SN或追溯范围');
      if (!hasNumber(data.quantity)) add('missing', '缺少已确认的涉及生产数量');
      if (!text(data.unit)) add('missing', '缺少生产数量单位');
    }
    if (['scheme', 'rework'].includes(task.kind) && !(data.categories || []).some(c => quantityCategories.includes(c))) add('missing', '请勾选处理方案的适用产品阶段');
    if (task.kind === 'measure') {
      if (!text(data.rootCause)) add('missing', '缺少措施对应根因');
      if (!text(data.criteria)) add('missing', '缺少预先约定的验收标准');
      if (!text(data.risk)) add('missing', '缺少新增风险及控制说明（无风险也请说明）');
      if (!text(data.control)) add('missing', '缺少新增风险的控制办法（无新增风险也请说明）');
    }
    if (task.kind === 'implementation') {
      if (!ensure(item).tasks.some(t => t.kind === 'measure' && t.id === data.measureId)) add('missing', '请选择本次实施对应的永久措施');
      if (!text(data.scope)) add('missing', '缺少实际实施范围');
    }
    if (task.kind === 'verification') {
      for (const [key, label] of Object.entries({ scope: '验证范围', criteria: '通过标准', sample: '验证样本', window: '观察期' })) if (!text(data[key])) add('missing', '缺少' + label);
      if (!['通过', '未通过'].includes(data.decision)) add('missing', '请填写明确的验证判定');
    }
    if(isLesson(task))for(const [key,label]of Object.entries({phenomenon:'故障现象',rootCause:'根本原因',effective:'有效措施',failed:'失败尝试与教训',scope:'适用范围及不适用条件',evidence:'证据和原分析引用'}))if(!text(ensure(item).d8.lessons[key]))add('missing','经验教训缺少'+label);
    if(task.kind==='cause'&&task.id===item.workflow.d4.occurrenceTaskId){const e=occurrenceIssues(item);if(e)add('missing',e);}
    if (task.kind === 'horizontal' && !text(task.scope)) add('missing', '缺少横向展开适用对象');
    if (task.kind === 'production' && !ensure(item).d8.production.productionAt) add('missing', '尚未记录首次生产事件，不能提前提交首产复核');
    if (!isQuantity(task) && !task.simpleFreeze && !text(task.result)) add('missing', '缺少任务结果或执行说明');
    if (evidenceRequired(task) && !evidencePresent(task)) add('evidence', '缺少有效证据附件或资料链接');
    return result;
  }
  function findTask(item, id) { return ensure(item).tasks.find(t => t.id === id); }
  function taskPayload(task) {
    return JSON.stringify({ ...(task.policyVersion === 4 ? { evidenceRequired: task.evidenceRequired } : {}), title: task.title, scope: task.scope, owner: task.owner, reviewer: task.reviewer, due: task.due, assignedAt: task.assignedAt, base: task.base, result: task.result, data: task.data || {}, links: task.links || [], files: task.files || [] });
  }
  function currentSubmission(task) {
    const submission = (task.submissions || []).at(-1);
    return !submission || submission.at === task.submittedAt && (!submission.payload || submission.payload === taskPayload(task));
  }
  function submitTask(item, id, at) {
    const task = findTask(item, id);
    if (!task || !taskEnabled(item, task)) return '当前任务不存在或未启用';
    if (item.status !== 'active') return '当前事项不可提交任务';
    if (!['draft', 'returned'].includes(task.status) && currentSubmission(task)) return task.status === 'accepted' ? '此任务已经验收，修改后请重新提交' : '此任务已提交，等待验收';
    if(isLesson(task)){const record=clone(ensure(item).d8.lessons);delete record.confirmed;task.data.lessonRecord=record;}
    const issue = taskIssues(item, task)[0];
    if (issue) return issue.label;
    const timestamp = at || nowISO();
    if (!Number.isFinite(instant(timestamp))) return '提交时间无效';
    task.status = isQuantity(task) ? 'accepted' : 'submitted'; task.submittedAt = timestamp; task.acceptedAt = isQuantity(task) ? timestamp : '';
    task.submissions = task.submissions || [];
    task.submissions.push({ at: timestamp, status: task.status, payload: taskPayload(task), result: task.result, data: clone(task.data || {}), files: clone(task.files || []), links: clone(task.links || []) });
    return '';
  }
  function setEvidenceRequirement(item,id,value,actor){
    if(!isQualityManager(actor))return '仅质量管理员可设置证据要求';
    const task=findTask(item,id);if(item.status!=='active'||!task||task.archived||!['draft','returned'].includes(task.status))return '此任务当前不可更改证据要求';
    if(task.simpleFreeze)return '冻结填报不要求任务证据';
    task.policyVersion=4;task.evidenceRequired=!!value;return '';
  }
  function confirmQualityTask(item,id,actor,at){
    if(!isQualityManager(actor))return '仅质量管理员可以确定';
    const task=findTask(item,id);if(item.status!=='active'||!task||task.kind!=='cause'||task.archived)return '此项当前不可确定';
    if(task.id===item.workflow.d4.occurrenceTaskId){const e=occurrenceIssues(item);if(e)return e;
      if(task.status==='accepted'){item.workflow.d4.occurrenceResponsibility.confirmed=true;item.workflow.d4.occurrenceResponsibility.confirmedAt=at||nowISO();return '';}}
    if(!text(task.result)){
      if(!['draft','returned'].includes(task.status))return '请先填写实际结果再确定';
      const error=taskIssues(item,task,true)[0];if(error)return error.label;
      if(!text(task.scope))return '请填写要求输出的内容';
      task.assignmentConfirmedAt=at||nowISO();return '';
    }
    const issue=taskIssues(item,task)[0];if(issue)return issue.label;
    const rating=ratingError(task);if(rating)return rating;
    if(task.status!=='submitted'||!currentSubmission(task)){const error=submitTask(item,id,at);if(error)return error;}
    return acceptTask(item,id,actor,at);
  }
  function ratingError(task) {
    if (!text(task.initiative) || ![0, 60, 80, 100].includes(Number(task.initiative))) return '请选择主动性评分';
    if (evidenceRequired(task) && (!text(task.evidenceScore) || ![0, 60, 80, 100].includes(Number(task.evidenceScore)))) return '请选择证据有效性评分';
    if (evidenceRequired(task) && Number(task.evidenceScore) === 0) return '无效证据不能通过验收，请退回补充';
    if (!text(task.ratingReason)) return '请填写评分事实与验收说明';
    return '';
  }
  function acceptTask(item, id, actor, at) {
    const task = findTask(item, id);
    if (!task || !taskEnabled(item, task)) return '当前任务不存在或未启用';
    if (item.status !== 'active') return '当前事项不可验收任务';
    if (actor !== reviewerFor(item, task)) return '只能由指定验收人确认此任务';
    if (task.status !== 'submitted') return '请先提交任务及证据后再验收';
    const lastSubmission = (task.submissions || []).at(-1);
    if (lastSubmission && lastSubmission.payload && lastSubmission.payload !== taskPayload(task)) return '提交后任务内容已修改，请重新提交后再验收';
    const issue = taskIssues(item, task)[0];
    if (issue) return issue.label;
    const error = ratingError(task);
    if (error) return error;
    const timestamp = at || nowISO();
    if (!Number.isFinite(instant(timestamp)) || instant(timestamp) < instant(task.submittedAt)) return '验收时间不能早于提交时间';
    if(isLesson(task)){const record=clone(ensure(item).d8.lessons);delete record.confirmed;if(JSON.stringify(record)!==JSON.stringify(task.data.lessonRecord))return '经验教训内容已变化，请重新提交审批';item.workflow.d8.lessons.confirmed=true;}
    if(task.id===item.workflow.d4.occurrenceTaskId)item.workflow.d4.occurrenceResponsibility.confirmed=true;
    task.status = 'accepted'; task.acceptedAt = timestamp; task.acceptedBy = actor;
    const submission = (task.submissions || []).at(-1);
    if (submission) Object.assign(submission, { status: 'accepted', reviewedAt: timestamp, reviewer: actor, initiative: Number(task.initiative), evidenceScore: Number(task.evidenceScore), ratingReason: task.ratingReason });
    return '';
  }
  function returnTask(item, id, actor, reason, at) {
    const task = findTask(item, id);
    if (!task || !taskEnabled(item, task)) return '当前任务不存在或未启用';
    if (item.status !== 'active') return '当前事项不可退回任务';
    if (actor !== reviewerFor(item, task)) return '只能由指定验收人退回此任务';
    if (task.status !== 'submitted') return '只能退回待验收任务';
    if (!text(reason)) return '请填写退回原因';
    const timestamp = at || nowISO();
    if (!Number.isFinite(instant(timestamp)) || instant(timestamp) < instant(task.submittedAt)) return '退回时间无效';
    task.status = 'returned'; task.acceptedAt = ''; task.returnReason = text(reason);
    const submission = (task.submissions || []).at(-1);
    if (submission) Object.assign(submission, { status: 'returned', reviewedAt: timestamp, reviewer: actor, reason: text(reason) });
    return '';
  }
  function replacementFor(item, task) {
    return ensure(item).tasks.find(candidate => candidate.id === task.supersededBy && candidate.previousTaskId === task.id && candidate.stage === 'D6' && candidate.kind === 'verification');
  }
  function repeatVerification(item, id, actor, at) {
    const source = findTask(item, id);
    const fail = error => ({ error, task: null });
    if (item.status !== 'active' || actor !== item.owner) return fail('只有事项负责人可以重新开展效果验证');
    if (!source || source.stage !== 'D6' || source.kind !== 'verification' || (source.data || {}).decision !== '未通过') return fail('请选择验证未通过的效果验证任务');
    if (replacementFor(item, source)) return fail('本次失败验证已经建立后续验证任务，请继续处理该任务');
    const timestamp = at || nowISO();
    if (!Number.isFinite(instant(timestamp))) return fail('重新开展验证的时间无效');
    const task = newTask('D6', 'verification', (text(source.title) || '效果验证') + ' · 重新验证');
    task.assignedAt = timestamp;
    task.owner = source.owner || ''; task.reviewer = source.reviewer || ''; task.scope = source.scope || '';
    for (const key of ['scope', 'criteria', 'sample', 'window']) task.data[key] = (source.data || {})[key] || '';
    task.previousTaskId = source.id;
    source.supersededBy = task.id; source.retired = true; source.retiredAt = timestamp;
    ensure(item).tasks.push(task);
    return { error: '', task };
  }
  function timing(task) {
    const due = instant(task.due, true), actual = instant(task.submittedAt), assigned = instant(task.assignedAt);
    if (!Number.isFinite(due) || !Number.isFinite(actual) || !Number.isFinite(assigned)) return { score: null, deltaDays: null, delayRatio: null };
    const deltaDays = (due - actual) / DAY, ratio = Math.max(0, actual - due) / Math.max(DAY, due - assigned);
    const score = ratio <= 0 ? 100 : ratio <= 0.1 + 1e-12 ? 90 : ratio <= 0.25 + 1e-12 ? 75 : ratio <= 0.5 + 1e-12 ? 50 : 0;
    return { score, deltaDays, delayRatio: ratio };
  }
  function taskPoints(task) {
    if (isQuantity(task)) return null;
    if (task.status !== 'accepted' || ratingError(task) || ![1, 2, 3].includes(Number(task.base)) || (evidenceRequired(task) && !evidencePresent(task)) || (!task.simpleFreeze && !text(task.result)) || !currentSubmission(task)) return null;
    const time = timing(task).score;
    if (time === null) return null;
    return Number(task.base) * (evidenceRequired(task) ? Number(task.initiative) * 0.2 + time * 0.3 + Number(task.evidenceScore) * 0.5 : Number(task.initiative) * 0.4 + time * 0.6) / 100;
  }
  function contribution(item) {
    const w = ensure(item), rows = (item.team || []).map(member => ({ ...member, base: 0, bonus: 0, share: 0, pending: 0 }));
    const byPerson = new Map(rows.map(row => [row.personId, row]));
    for (const task of w.tasks.filter(t => t.status === 'accepted' || taskEnabled(item, t))) {
      const row = byPerson.get(task.owner); if (!row || isQuantity(task)) continue;
      const points = taskPoints(task);
      if (points === null) row.pending += 1; else row.base += points;
    }
    for (const row of rows) {
      const bonus = (item.bonuses || {})[row.personId];
      if (bonus && bonus.confirmed && hasNumber(bonus.points) && text(bonus.reason) && text(bonus.evidence)) row.bonus = Math.min(Number(bonus.points), row.base * 0.1);
      row.bonusCap = Math.round(row.base * 0.1 * 1000000) / 1000000;
    }
    const total = rows.reduce((sum, row) => sum + row.base + row.bonus, 0);
    if (total > 0) {
      const shares = rows.map((row, index) => ({ index, raw: (row.base + row.bonus) / total * 10000 }));
      let remaining = 10000 - shares.reduce((sum, share) => sum + Math.floor(share.raw), 0);
      const ranked = shares.slice().sort((a, b) => (b.raw % 1) - (a.raw % 1) || a.index - b.index);
      const additions = new Set(ranked.slice(0, remaining).map(s => s.index));
      rows.forEach((row, index) => { row.share = (Math.floor(shares[index].raw) + (additions.has(index) ? 1 : 0)) / 100; });
    }
    return rows;
  }
  function validateBonuses(item) {
    const scores = contribution(item);
    for (const row of scores) {
      const bonus = (item.bonuses || {})[row.personId];
      if (!bonus || !text(bonus.points) || Number(bonus.points) === 0) continue;
      if (!bonus.confirmed) return '原有加分需在新规则下复核确认';
      if (!hasNumber(bonus.points)) return 'D8加分须为非负数';
      if (Number(bonus.points) > row.base * 0.1 + 1e-9) return 'D8加分不能超过个人已获得任务积分的10%';
      if (!text(bonus.reason) || !text(bonus.evidence)) return 'D8加分需填写理由和证据';
    }
    return '';
  }
  function stageAdditions(item, id) {
    const w = ensure(item), issues = [], add = label => issues.push({ type: 'missing', label });
    const tasks = w.tasks.filter(t => t.stage === id && taskEnabled(item, t));
    const requireKind = (kind, label) => { if (!tasks.some(t => t.kind === kind)) add(label); };
    if (id === 'D1') {
      if (!(item.team || []).length) add('请至少选择一位团队成员');
      if ((item.team || []).some(m => !m.inactive && !text(m.role))) add('请补充每位团队成员的职责分工');
      if(item.stages.D1.requiresEvidence&&!hasEvidence(item.stages.D1))issues.push({type:'evidence',label:'D1团队组建缺少要求的证据'});
    }
    if (id === 'D2') {
      if (!text(w.d2.reproductionDescription)) add('缺少报故现场的故障复现描述');
      if(!w.d2.freeze)requireKind('sn', '请分派SN涉及生产数量确认任务');
      if (w.d2.freeze) {
        if (!text(w.d2.freezeNumber)) add('缺少冻结编号');
        requireKind('freeze', '请分派产品冻结执行任务');
      }
    }
    if (id === 'D3') {
      for (const category of quantityCategories) if (!tasks.some(t => t.kind === 'quantity' && (t.data || {}).category === category)) add('请分派' + category + '数量确认任务');
      if (!tasks.some(t=>['scheme','rework'].includes(t.kind))) add('请分派返工方案任务');
      const keys = new Set();
      for (const task of tasks.filter(t => t.kind === 'quantity')) {
        const d = task.data || {}, key = d.category;
        if (d.category && keys.has(key)) add('存在同一范围的重复数量记录，请核对，不能重复累加');
        keys.add(key);
      }
    }
    if (id === 'D4') {
      for (const [section, label] of Object.entries(causeSections).filter(([key])=>!w.uiRevision6||key!=='occurrenceDept')) if (!tasks.some(t => t.kind === 'cause' && t.data.section === section)) add('请分派' + label + '任务');
    }
    if(id==='D4'&&w.uiRevision6&&!w.d4.occurrenceResponsibility.confirmed)issues.push({type:'confirmation',label:'产生原因及责任部门待一并确定',taskId:w.d4.occurrenceTaskId});
    if (id === 'D5') requireKind('measure', '请分派对应根因的永久措施任务');
    if (id === 'D6') {
      requireKind('implementation', '请分派措施实施任务'); requireKind('verification', '请分派独立效果验证任务');
      if (!text(w.d6.withdrawal)) add('请明确D3临时措施是否可以撤除');
      if (w.tasks.some(t => t.stage === 'D6' && t.kind === 'verification' && (t.data || {}).decision === '未通过' && !replacementFor(item, t))) add('效果验证未通过，请返回原因或措施分析，并重新开展验证');
    }
    if (id === 'D6') {
      const p = w.d8.production;
      if (p.enabled) {
        if (!['month', 'production'].includes(p.mode)) add('请选择首产跟踪提醒方式');
        for (const [key, label] of Object.entries({ product: '产品', model: '型号', message: 'MES订单质量提示' })) if (!text(p[key])) add('首产跟踪缺少' + label);
        if (!validDate(p.effectiveDate)) add('缺少有效的整改措施生效日');
        if (!p.departments.length) add('请选择通知部门');
        if (!p.engineers.length) add('请选择通知工程师');
        requireKind('production', '请分派首产复核任务并填写期限');
      }
    }
    if (id === 'D7') {
      if(!tasks.some(t=>['prevention','horizontal'].includes(t.kind)))add('请选择防止再发措施或开展横向展开；不适用请说明原因');
      if(w.d8.horizontal)requireKind('horizontal','请分派横向展开任务');
      else if(!text(w.d8.horizontalReason))add('请说明不开展横向展开的原因');
      if(tasks.some(isLesson)&&!w.d8.lessons.confirmed)issues.push({type:'confirmation',label:'经验教训条目待审批确认入库',taskId:tasks.find(isLesson).id});
    }
    if (id === 'D8') {
      if (w.d8.recurrence.originalId && !text(w.d8.recurrence.reason)) add('缺少原措施失效原因的复查说明');
      const bonusError = validateBonuses(item); if (bonusError) add(bonusError);
    }
    return issues;
  }
  function stageIssues(item, id, includeExisting) {
    const w = ensure(item), stage = item.stages && item.stages[id];
    if (!stage) return [{ type: 'missing', label: '缺少' + id + '阶段记录' }];
    if (w.legacyClosed || w.legacyPending || w.frozenV3) return [];
    if (stage.na) {
      if (['D1', 'D2', 'D4', 'D6', 'D8'].includes(id)) return [{ type: 'missing', label: id + '是必要阶段，不能标记不适用' }];
      return text(stage.naReason) ? [] : [{ type: 'missing', label: '请填写本阶段不适用的原因' }];
    }
    const issues = includeExisting ? Object.entries(id === 'D4' || id==='D7'&&w.uiRevision6 ? {} : oldFields[id]).filter(([key]) => !text((stage.fields || {})[key])).map(([, label]) => ({ type: 'missing', label: '缺少' + label })) : [];
    issues.push(...stageAdditions(item, id));
    if (includeExisting && id === 'D2') {
      const revised = item.revised || {}, snapshot = item.snapshot || {};
      if (!text(revised.product) || !text(revised.model) || !text(revised.customer)) issues.push({ type: 'missing', label: '请补全产品、型号及客户' });
      if (!Number.isInteger(Number(revised.quantity)) || Number(revised.quantity) <= 0) issues.push({ type: 'missing', label: '报故涉及数量须为正整数' });
      if (Object.keys(revised).some(key => String(revised[key]) !== String(snapshot[key])) && !text((stage.fields || {}).editReason)) issues.push({ type: 'missing', label: '修订报故后缺少分析修订说明' });
    }
    if (includeExisting && id === 'D6' && item.effectiveness !== '通过') issues.push({ type: 'missing', label: '效果验证尚未通过' });
    for (const task of w.tasks.filter(t => t.stage === id && taskEnabled(item, t))) {
      const futureProduction = task.kind === 'production';
      const taskMissing = taskIssues(item, task, futureProduction);
      for (const issue of taskMissing) issues.push({ ...issue, taskId: task.id, owner: task.owner, due: task.due, label: (task.title || '未命名任务') + '：' + issue.label });
      if (task.status === 'accepted' && !isQuantity(task) && ratingError(task)) issues.push({ type: 'acceptance', taskId: task.id, owner: reviewerFor(item, task), due: task.due, label: (task.title || '任务') + '：' + ratingError(task) });
      if (['accepted', 'submitted'].includes(task.status) && !currentSubmission(task)) issues.push({ type: 'task', taskId: task.id, owner: task.owner, due: task.due, label: (task.title || '任务') + '提交后内容有变化，请重新提交验收' });
      else if (task.status === 'submitted') issues.push({ type: 'acceptance', taskId: task.id, owner: reviewerFor(item, task), due: task.due, label: (task.title || '任务') + (task.kind === 'cause' ? '待事项负责人确认' : task.stage==='D7'?'待指定审批人确认':'待指定人员验收') });
      else if (task.status !== 'accepted') issues.push({ type: 'task', taskId: task.id, owner: task.owner, due: task.due, label: (task.title || '任务') + (task.status === 'returned' ? '已退回，待补充重提' : '尚未提交完成') });
    }
    return issues;
  }
  function validateStage(item, id) {
    if (!stageIds.includes(id)) return '无效的8D阶段';
    // The host retains its original field validation; only additions are returned here.
    const issues = stageIssues(item, id, false).filter(issue => {
      const task = issue.taskId && findTask(item, issue.taskId);
      // Future first-production work is visible on the progress panel, without requiring a future order to exist before D8 can be confirmed.
      return !(task && task.kind === 'production' && ['task', 'acceptance'].includes(issue.type));
    });
    return issues.length ? issues[0].label : '';
  }
  function blocksStage(item, issue) {
    const task = issue.taskId && findTask(item, issue.taskId);
    return !(task && task.kind === 'production' && ['task', 'acceptance'].includes(issue.type));
  }
  function checklist(item, at) {
    const w = ensure(item); if (w.legacyClosed || w.legacyPending || w.frozenV3) return [];
    const timestamp = instant(at || nowISO()), result = [];
    for (const id of stageIds) {
      const stage = item.stages && item.stages[id], issues = stageIssues(item, id, true);
      for (const issue of issues) result.push({ stage: id, owner: item.owner, ...issue, overdue: !!issue.due && Number.isFinite(instant(issue.due, true)) && instant(issue.due, true) < timestamp && (!issue.taskId || findTask(item, issue.taskId).status !== 'accepted') });
      if (stage && !stage.na && !stage.done && !issues.some(issue => blocksStage(item, issue))) result.push({ stage: id, type: 'confirmation', label: id + '资料及任务已完成，待阶段确认', owner: item.owner, overdue: false });
    }
    return result;
  }
  function progress(item) {
    const w = ensure(item), tasks = w.tasks.filter(t => taskEnabled(item, t));
    const applicable = stageIds.filter(id => !(optionalStages.includes(id) && item.stages && item.stages[id] && item.stages[id].na && text(item.stages[id].naReason)));
    const missing = checklist(item);
    return { stagesDone: applicable.filter(id => stageComplete(item, id)).length, stagesTotal: applicable.length, tasksDone: tasks.filter(t => isQuantity(t) ? t.status === 'accepted' && currentSubmission(t) : taskPoints(t) !== null).length, tasksTotal: tasks.length, pending: missing.filter(issue => ['acceptance', 'confirmation'].includes(issue.type)).length };
  }
  function stageComplete(item, id) {
    const w = ensure(item), stage = item.stages && item.stages[id];
    return !!stage && !!stage.done && (w.legacyClosed || w.legacyPending || !stageIssues(item, id, true).some(issue => blocksStage(item, issue)));
  }
  function monthDueDate(date) {
    if (!validDate(date)) return '';
    const [year, month, day] = text(date).slice(0, 10).split('-').map(Number);
    const start = new Date(Date.UTC(year, month, 1));
    const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    start.setUTCDate(Math.min(day, lastDay));
    return start.toISOString().slice(0, 10);
  }
  function refreshReminder(item, at) {
    const w = ensure(item), p = w.d8.production;
    if (!p.enabled) return p.reminderState;
    if (p.reminderState === 'handled') return p.reminderState;
    const timestamp = instant(at || nowISO());
    const ready = p.mode === 'month' ? validDate(p.effectiveDate) && timestamp >= instant(monthDueDate(p.effectiveDate)) : p.mode === 'production' && !!p.productionAt && w.tasks.some(t => t.kind === 'production' && taskPoints(t) !== null);
    p.reminderState = ready ? 'ready' : 'pending';
    return p.reminderState;
  }
  function simulateOrder(item, order, at) {
    const p = ensure(item).d8.production, timestamp = at || nowISO();
    if (!p.enabled) return '请先启用首产跟踪配置';
    if (p.orderId) return '已关联整改生效后的首个订单，不重复匹配后续订单';
    if (!validDate(p.effectiveDate) || !text(p.product) || !text(p.model)) return '请先填写产品、型号及整改生效日';
    if (!order || !text(order.id)) return '缺少模拟订单编号';
    const normalized = value => text(value).toLowerCase();
    if (normalized(order.product) !== normalized(p.product) || normalized(order.model) !== normalized(p.model) || text(p.revision) && normalized(order.revision) !== normalized(p.revision)) return '该订单的产品、型号或版本不符合首产跟踪条件';
    if (!validDate(order.createdAt) || instant(order.createdAt) < instant(p.effectiveDate)) return '该订单早于整改生效日，不属于整改后首个订单';
    if (!Number.isFinite(instant(timestamp)) || instant(order.createdAt) > instant(timestamp)) return '订单时间不能晚于模拟时间';
    p.orderId = text(order.id); p.matchedAt = timestamp; p.order = clone(order);
    p.events.push({ type: 'order_prompt', at: timestamp, orderId: p.orderId, text: p.message, mock: true, result: '模拟已匹配；未写入真实MES' });
    return '';
  }
  function simulateProduction(item, orderId, at) {
    const p = ensure(item).d8.production, timestamp = at || nowISO();
    if (!p.enabled) return '请先启用首产跟踪配置';
    if (!p.orderId || orderId !== p.orderId) return '请先匹配整改后的首个符合条件订单';
    if (p.productionAt) return '此订单已模拟首次生产，不重复触发通知';
    if (!p.engineers.length || !p.departments.length) return '请先选择通知部门和工程师';
    if (!Number.isFinite(instant(timestamp)) || instant(timestamp) < instant(p.order && p.order.createdAt || p.matchedAt)) return '首次生产时间不能早于订单创建时间';
    p.productionAt = timestamp;
    p.events.push({ type: 'production_notice', at: timestamp, orderId, text: p.message, departments: clone(p.departments), engineers: clone(p.engineers), mock: true, result: '模拟通知记录；未发送真实企业微信消息' });
    refreshReminder(item, timestamp);
    return '';
  }
  function createRecurrence(source, fault, core, today) {
    if (!source || source.status !== 'closed') throw Error('请选择已经关闭的原8D记录');
    if (!fault || !fault.id || fault.id === source.faultId) throw Error('复发需选择新的报故单，不能覆盖原报故');
    if (!core || typeof core.createItem !== 'function') throw Error('分析数据引擎不可用');
    const item = core.createItem(clone(fault), today);
    // The core's historical allocation template is not an estimate of new work.
    item.tasks = [];
    const w = ensure(item);
    w.d8.recurrence = { originalId: source.id, reason: '' };
    item.nextAction = '复查原8D ' + source.id + '的措施失效原因，安排本次复发分析';
    item.history = item.history || [];
    item.history.push({ at: today, actor: '质量管理员', text: '作为复发问题新建分析，关联原8D ' + source.id + '；原分析及关闭记录保留' });
    return item;
  }
  const api = { preventionGroups, preventionOptions, selectPrevention, isLesson, occurrenceIssues, isQualityManager, setEvidenceRequirement, confirmQualityTask, isQuantity, evidenceRequired, evidencePresent, reviewerFor, causeSections, currentSubmission, ensure, newTask, taskEnabled, taskIssues, submitTask, acceptTask, returnTask, repeatVerification, replacementFor, timing, taskPoints, contribution, validateBonuses, validateStage, checklist, progress, stageComplete, createRecurrence, simulateOrder, simulateProduction, refreshReminder, monthDueDate, quantityCategories, toolOptions, hasEvidence };
  root.AnalysisWorkflow = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
