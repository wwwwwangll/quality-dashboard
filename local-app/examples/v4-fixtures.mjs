// Deliberately invented demonstration records. Never derived from company data.
export const accountTemplates=[
 ['admin','管理员','admin','质量部'],['quality','质量工程师','quality-engineer','质量部'],['failure','失效分析','failure-analyst','质量部'],
 ['intelligence','智能化研究院','worker','智能化研究院'],['electric','电动化研究院','worker','电动化研究院'],['system1','系统一所','worker','系统一所'],['system2','系统二所','worker','系统二所'],['engineering','工程部','worker','工程部'],['production','生产部','worker','生产部'],['project','项目部','worker','项目部'],['logistics','储运部','worker','储运部'],
 ['sales','销售部','viewer','销售部'],['commerce','商务部','viewer','商务部'],['change','变更管理员','freeze-clerk','质量部']
];
export function fixtureData(){
 const categories=['显示器类','控制器类','传感器类','电源模块类','手柄类','线束类'],departments=['智能化研究院','电动化研究院','系统一所','系统二所','工程部','生产部','项目部','储运部','销售部','商务部'];
 const products=categories.map((category,i)=>({id:'MOCK-P'+i,material:'MOCK-PN-'+String(i+1).padStart(3,'0'),product:['显示屏','控制器','称重传感器','电源模块','操作手柄','连接线束'][i],category,sourcing:i<4?'自制':'外购'}));
 const faults=[],claims=[],shipments=[];
 for(const year of [2025,2026])for(let month=1;month<=12;month++)for(let i=0;i<categories.length;i++){
 const m=String(month).padStart(2,'0'),p=products[i],id=`MOCK-BG-${year}${m}-${i+1}`,quantity=1+(month+i+(year===2025?3:0))%9,dept=departments[(month+i)%departments.length];
 faults.push({id,date:`${year}-${m}-08`,...Object.fromEntries(['product','material','category','sourcing'].map(k=>[k,p[k]])),model:'M'+(i+1),sn:`MOCK-SN-${year}${m}-${i+1}`,customer:'模拟客户'+(1+(i+month)%4),project:'模拟项目'+(1+i%3),reporter:'模拟现场人员',description:i===0?'低温首次上电黑屏，重启恢复':'模拟'+p.product+'异常待核查',condition:'模拟现场运行',quantity,dept,secondary:month%3===0?'销售部':'商务部',diagnosis:month%4===0?'待分析':'产品质量问题',major:month%3===0?'是':'否',batch:quantity>5?'是':'否',projectType:month%2?'量产':'新品',reasonType:['设计开发','变更','检验策划'][i%3],status:'待处理'});
 shipments.push({id:`MOCK-SH-${year}${m}-${i+1}`,date:`${year}-${m}-01`,category:p.category,quantity:1000+month*60+i*90,dept});
 if(i<2)claims.push({id:`MOCK-CL-${year}${m}-${i+1}`,date:`${year}-${m}-10`,product:p.product,material:p.material,category:p.category,sourcing:p.sourcing,customer:'模拟客户'+(1+(i+month)%4),issue:'模拟索赔事项',amount:1000+month*100+i*50,agreed:600+month*30,rejected:400+month*70+i*50,actual:month%3?500+month*20:null,estimated:month%3?null:600+month*30,waiver:null,faultId:id,dept,negotiation:month%3?'协商完成':'待协商'});
 }
 return {products,faults,shipments,claims};
}
export const columns={
 product:{id:'产品编号',material:'料号',product:'产品名称',category:'产品类别',sourcing:'自制外购'},
 fault:{id:'报故单号',date:'报故日期',product:'产品名称',model:'产品型号',material:'料号',sn:'SN',category:'产品类别',sourcing:'自制外购',customer:'客户名称',project:'项目名称',reporter:'报故人员',description:'故障信息',condition:'发生地点与工况',quantity:'报故数量',dept:'责任部门',secondary:'次要责任部门',diagnosis:'问题判定',major:'重大质量问题',batch:'批量问题',projectType:'项目阶段',reasonType:'问题分类'},
 shipment:{id:'发货统计编号',date:'统计月份',category:'产品类别',quantity:'发货数量',dept:'部门'},
 claim:{id:'索赔编号',date:'索赔日期',product:'产品名称',material:'料号',category:'产品类别',sourcing:'自制外购',customer:'客户名称',issue:'索赔原因',amount:'索赔金额',agreed:'同意索赔金额',rejected:'拒绝索赔金额',actual:'实际赔付',estimated:'预计赔付金额',waiver:'减免金额',faultId:'报故单号',dept:'责任部门',negotiation:'协商状态'}
};
export const datasetKey={product:'products',fault:'faults',shipment:'shipments',claim:'claims'};
export function toCSV(kind,rows){const keys=Object.keys(columns[kind]),cell=v=>'"'+String(v??'').replaceAll('"','""')+'"';return '\uFEFF'+[Object.values(columns[kind]),...rows.map(r=>keys.map(k=>r[k]??''))].map(row=>row.map(cell).join(',')).join('\r\n');}
