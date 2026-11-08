// Group templates contain business permissions only. System/account administration
// remains exclusive to the administrator, irrespective of overrides.
export const readPermissions=['dashboard.view','analysis.view','faults.view','claims.view','files.view','pdf.view'];
export const extraPermissions=[...readPermissions,'tasks.submit','analysis.close'];
export const qualityPermissions=[...readPermissions,'tasks.submit','analysis.manage','analysis.start','tasks.assign','tasks.review','tasks.transfer','imports.manage','preliminary.write','freeze.number.write','analysis.close'];
export const workerPermissions=[...readPermissions,'tasks.submit','tasks.transfer'];
export const groupTemplates=[['quality','质量部',qualityPermissions],['intelligence','智能化研究院',workerPermissions],['systems','系统所',workerPermissions],['electric','电动化研究院',workerPermissions],['engineering','工程部',workerPermissions],['logistics','储运部',workerPermissions],['production','生产部',workerPermissions],['sales','销售部',workerPermissions],['commerce','商务部',workerPermissions]];
export const testProfiles=[
 ['admin','管理员','admin','质量部',''],
 ...[['cqe','客户质量工程师'],['apqe','前期质量工程师'],['pqe','过程质量工程师'],['sqe','供应商质量工程师'],['quality_manager','质量经理'],['qse','质量体系工程师'],['failure','失效分析'],['changsha_qe','长沙质量工程师'],['changsha_qm','长沙质量经理'],['after_sales','售后服务部'],['change','变更管理员']].map(([id,name])=>[id,name,'quality-engineer','质量部','quality']),
 ...['intelligence','electric'].flatMap(g=>[['struct','结构工程师'],['sw','软件工程师'],['hw','硬件工程师'],['project','项目工程师']].map(([id,name])=>[g+'_'+id,(g==='intelligence'?'智能化研究院':'电动化研究院')+name,'worker',g==='intelligence'?'智能化研究院':'电动化研究院',g])),
 ['system1','系统一所','worker','系统所','systems'],['system2','系统二所','worker','系统所','systems'],
 ...[['engineering','工程部'],['logistics','储运部'],['production','生产部'],['sales','销售部'],['commerce','商务部']].map(([id,name])=>[id,name,'worker',name,id])
];
export const obsoleteAccounts=['quality','project','intelligence','electric','electric_system','intelligence_system','changsha_system'];
export const initialTestPassword=username=>'Test@2026-'+username;
export const passwordTable=()=> '仅限本机模拟测试，正式环境不创建这些账号。\r\n双击“立即启动.cmd”，访问 http://127.0.0.1:3870/\r\n固定初始密码规则：Test@2026-用户名（大小写及符号须一致）。\r\n这是初始密码表；自行改密后不会在重启时恢复，管理员可重置。\r\n\r\n'+testProfiles.map(([id,name,,dept])=>`${dept} / ${name}\t账号：${id}\t初始密码：${initialTestPassword(id)}`).join('\r\n')+'\r\n';
export const d2Eligible=u=>!!u&&u.enabled!==false&&(u.role==='freeze-clerk'||u.d2FillEligible===true);
