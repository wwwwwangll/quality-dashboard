import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/store.mjs';
import { createWorkflowService } from '../lib/workflow.mjs';
import { createImportService } from '../lib/imports.mjs';
import { canReadFile } from '../lib/access.mjs';
function fixture(){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'quality-ui-integration-test-'));
  const store=createStore({dataDir,environment:'test',testMode:true});
  const users=[
    {id:'admin',name:'模拟管理员',role:'admin',dept:'质量部',enabled:true},
    {id:'a',name:'模拟甲',role:'worker',dept:'部门甲',enabled:true},
    {id:'b',name:'模拟乙',role:'worker',dept:'部门乙',enabled:true}
  ];
  for(const user of users)store.put('users',user.id,user);
  const wf=createWorkflowService({store,fileRoot:store.fileRoot,clock:()=>new Date('2026-11-18T02:00:00Z')});
  const imports=createImportService({store});
  const csv=(headers,row)=>({kind:'claim',name:'synthetic.csv',base64:Buffer.from([headers,row].map(cells=>cells.map(value=>'"'+String(value??'').replaceAll('"','""')+'"').join(',')).join('\n')).toString('base64')});
  const cleanup=()=>{store.close();fs.rmSync(dataDir,{recursive:true,force:true});};
  return {store,wf,imports,csv,users,cleanup};
}
test('起止日期统计保持原到期口径且部门范围取交集，旧周期仍可用',async()=>{
  const f=fixture();try{
    f.store.put('preliminaryAssignments','early',{faultId:'fault',userId:'a',due:'2026-10-03',status:'completed',completedAt:'2026-10-03T03:00:00Z'});
    f.store.put('preliminaryAssignments','late',{faultId:'fault',userId:'a',due:'2026-10-05',status:'completed',completedAt:'2026-10-06T03:00:00Z'});
    f.store.put('preliminaryAssignments','backlog',{faultId:'fault',userId:'a',due:'2026-09-01',status:'assigned'});
    f.store.put('preliminaryAssignments','other',{faultId:'fault',userId:'b',due:'2026-10-06',status:'assigned'});
    const metrics=await f.wf.api('metrics',{user:f.users[0],body:{from:'2026-10-01',to:'2026-10-31',department:'部门甲'}});
    assert.equal(metrics.departments.length,1);assert.equal(metrics.departments[0].total,2);
    assert.equal(metrics.departments[0].onTime,1);assert.equal(metrics.departments[0].lateCompleted,1);assert.equal(metrics.departments[0].backlog,1);
    assert.equal(metrics.departments[0].rate,50);
    const denied=await f.wf.api('metrics',{user:f.users[1],body:{from:'2026-10-01',to:'2026-10-31',department:'部门乙'}});
    assert.deepEqual(denied.departments,[]);assert.deepEqual(denied.tasks,[]);assert.deepEqual(denied.backlog,[]);
    const old=await f.wf.api('metrics',{user:f.users[0],body:{period:'month',date:'2026-10-12'}});
    assert.equal(old.start,'2026-10-01');assert.equal(old.end,'2026-10-31');
  }finally{f.cleanup();}
});
test('指标区间拒绝缺日期、非法日期和倒置日期，未来截止于当前时刻',async()=>{
  const f=fixture();try{
    for(const body of [{from:'2026-10-01'},{from:'2026-02-30',to:'2026-03-01'},{from:'2026-11-01',to:'2026-10-01'}]){
      await assert.rejects(f.wf.api('metrics',{user:f.users[0],body}),/起止日期/);
    }
    const result=await f.wf.api('metrics',{user:f.users[0],body:{from:'2026-01-01',to:'2026-12-31'}});
    assert.equal(result.cutoff,'2026-11-18T02:00:00.000Z');
  }finally{f.cleanup();}
});
test('新索赔22字段导入保留处理日期、独立不合格单号及精确供应商金额',async()=>{
  const f=fixture();try{
    const header=['索赔单号','处理日期','客户名称','索赔金额','承认金额','不合格单号','供应商索赔金额','供应商承认金额','数量','厂内/厂外'];
    const preview=await f.imports.preview(f.csv(header,['CL-NEW','2026-11-16','模拟客户',123.45,100,'NC-001',30.12,0,2,'厂内']),f.users[0]);
    assert.deepEqual(preview.errors,[]);
    f.imports.commit(preview.batchId,{},f.users[0]);
    const row=f.store.get('claims','CL-NEW');
    assert.equal(row.processingDate,'2026-11-16');assert.equal(row.date,undefined);assert.equal(row.nonconformityId,'NC-001');assert.equal(row.faultId,'');
    assert.equal(row.amountCents,12345);assert.equal(row.agreedCents,10000);assert.equal(row.supplierAmountCents,3012);assert.equal(row.supplierAgreedCents,0);
    assert.equal(row.quantity,2);
  }finally{f.cleanup();}
});
test('旧索赔模板更新不会清空处理日期、不合格编号和供应商金额',async()=>{
  const f=fixture();try{
    const initial=await f.imports.preview(f.csv(['索赔单号','处理日期','客户名称','索赔金额','不合格单号','供应商承认金额'],
      ['CL-OLD','2026-11-16','模拟客户',100,'NC-OLD',12.34]),f.users[0]);
    f.imports.commit(initial.batchId,{},f.users[0]);
    const update=await f.imports.preview(f.csv(['索赔编号','索赔日期','客户名称','索赔金额'],['CL-OLD','2026-11-17','模拟客户',101]),f.users[0]);
    f.imports.commit(update.batchId,{updateExisting:true},f.users[0]);
    const row=f.store.get('claims','CL-OLD');
    assert.equal(row.date,'2026-11-17');assert.equal(row.processingDate,'2026-11-16');assert.equal(row.nonconformityId,'NC-OLD');assert.equal(row.supplierAgreedCents,1234);
    const unknown=await f.imports.preview(f.csv(['索赔编号','索赔日期','客户名称','索赔金额'],['CL-UNKNOWN','2026-11-17','模拟客户',100]),f.users[0]);
    assert.equal(unknown.rows[0].data.supplierAgreedCents,undefined);
  }finally{f.cleanup();}
});
test('供应商金额、数量、处理日期的非法输入在真实预览阶段被拒绝',async()=>{
  const f=fixture();try{
    const header=['索赔单号','处理日期','客户名称','索赔金额','供应商索赔金额','供应商承认金额','数量'];
    for(const row of [
      ['BAD','2026-11-16','模拟客户',100,1,2,1],
      ['BAD','2026-02-30','模拟客户',100,2,1,1],
      ['BAD','2026-11-16','模拟客户',100,2,1,-1],
      ['BAD','2026-11-16','模拟客户',100,2,'1.234',1]
    ]){
      const preview=await f.imports.preview(f.csv(header,row),f.users[0]);
      assert.equal(preview.errors.length,1);assert.throws(()=>f.imports.commit(preview.batchId,{},f.users[0]));
    }
  }finally{f.cleanup();}
});
test('故障照片仅关联有权读取的已上传文件，外部URL及他人附件被拒绝',async()=>{
  const f=fixture();try{
    const uploader={...f.users[1],permissions:['imports.manage']};
    f.store.put('files','photo-1',{id:'photo-1',name:'模拟.png',type:'image/png',size:10,uploadedBy:'a'});
    f.store.put('files','photo-2',{id:'photo-2',name:'其他.png',type:'image/png',size:10,uploadedBy:'b'});
    const header=['索赔单号','处理日期','客户名称','索赔金额','故障照片','责任部门'];
    for(const bad of ['https://example.invalid/private.png','photo-2']){
      const preview=await f.imports.preview(f.csv(header,['CL-PHOTO','2026-11-16','模拟客户',100,bad,'部门甲']),uploader);
      assert.equal(preview.errors.length,1);
    }
    const preview=await f.imports.preview(f.csv(header,['CL-PHOTO','2026-11-16','模拟客户',100,'photo-1','部门甲']),uploader);
    assert.deepEqual(preview.errors,[]);f.imports.commit(preview.batchId,{},uploader);
    assert.equal(f.store.get('claims','CL-PHOTO').photo.id,'photo-1');
    assert.equal(canReadFile(f.store,f.users[2],'photo-1'),false);
  }finally{f.cleanup();}
});

test('仅更新供应商金额一列也按合并后的现有值校验',async()=>{
 const f=fixture();try{
  const initial=await f.imports.preview(f.csv(['索赔单号','处理日期','客户名称','索赔金额','供应商索赔金额','供应商承认金额'],['CL-SUP','2026-11-16','模拟客户',1000,100,80]),f.users[0]);
  f.imports.commit(initial.batchId,{},f.users[0]);
  for(const [field,value]of [['供应商索赔金额',50],['供应商承认金额',120]]){
   const update=await f.imports.preview(f.csv(['索赔单号','处理日期','客户名称','索赔金额',field],['CL-SUP','2026-11-16','模拟客户',1000,value]),f.users[0]);
   assert.equal(update.errors.length,1);assert.match(update.errors[0].message,/供应商承认金额不能超过/);
   assert.throws(()=>f.imports.commit(update.batchId,{updateExisting:true},f.users[0]));
  }
  const row=f.store.get('claims','CL-SUP');assert.equal(row.supplierAmountCents,10000);assert.equal(row.supplierAgreedCents,8000);
 }finally{f.cleanup();}
});

test('确认导入再次核验合并后供应商金额且整批回滚',async()=>{
 const f=fixture();try{
  const preview=await f.imports.preview(f.csv(['索赔单号','处理日期','客户名称','索赔金额','供应商索赔金额','供应商承认金额'],['CL-SUP','2026-11-16','模拟客户',1000,100,80]),f.users[0]);
  const batch=f.store.get('imports',preview.batchId);batch.rows[0].data.supplierAmountCents=5000;batch.rows[0].data.supplierAmount=50;f.store.put('imports',batch.batchId,batch);
  assert.throws(()=>f.imports.commit(preview.batchId,{},f.users[0]),/供应商承认金额不能超过/);
  assert.equal(f.store.get('claims','CL-SUP'),null);assert.equal(f.store.get('imports',batch.batchId).status,'preview');
 }finally{f.cleanup();}
});

