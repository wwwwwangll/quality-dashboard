// Defaults for a NEW, empty test package only. Never run against an existing installation.
export const profiles=[
 ['cqe','客户质量工程师','quality-engineer','质量部'],
 ['apqe','前期质量工程师','quality-engineer','质量部'],
 ['pqe','过程质量工程师','quality-engineer','质量部'],
 ['sqe','供应商质量工程师','quality-engineer','质量部'],
 ['quality_manager','质量经理','quality-engineer','质量部'],
 ['qse','质量体系工程师','quality-engineer','质量部'],
 ['intelligence_struct','智能化研究院结构工程师','worker','智能化研究院'],
 ['intelligence_hw','智能化研究院硬件工程师','worker','智能化研究院'],
 ['intelligence_sw','智能化研究院软件工程师','worker','智能化研究院'],
 ['electric_struct','电动化研究院结构工程师','worker','电动化研究院'],
 ['electric_hw','电动化研究院硬件工程师','worker','电动化研究院'],
 ['electric_sw','电动化研究院软件工程师','worker','电动化研究院'],
 ['electric_system','电动化系统所','worker','电动化系统所'],
 ['intelligence_system','智能化研究院系统所','worker','智能化研究院系统所'],
 ['changsha_qe','长沙质量工程师','quality-engineer','质量部'],
 ['changsha_system','长沙系统所','worker','长沙系统所'],
 ['changsha_qm','长沙质量经理','quality-engineer','质量部'],
 ['electric_project','电动化研究院项目部','worker','电动化研究院项目部'],
 ['intelligence_project','智能化研究院项目部','worker','智能化研究院项目部'],
 ['after_sales','售后服务部','worker','质量部']
];
export const retired=['system1','system2','electric','intelligence'];
export const replacement={system1:'intelligence_system',system2:'electric_system',electric:'electric_hw',intelligence:'intelligence_hw'};
