import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../public/ui-records.js',import.meta.url),'utf8');
function load(){
  const context=vm.createContext({window:{},FormData:class{
    constructor(form){this.entries=form.entries;}
    [Symbol.iterator](){return this.entries[Symbol.iterator]();}
  }});
  vm.runInContext(source,context);
  return context.window.QualityRecords;
}
const E=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const data={
  faults:[{id:'F1',customer:'客户甲',date:'2026-01-04',material:'P1',description:'启动异常'}],
  products:[{material:'P1',category:'控制器'}],analyses:[{id:'A1',faultId:'F1',title:'启动异常',status:'active'}],
  preliminary:[]
};
test('claim processing date and nonconformity are independent of legacy fields',()=>{
  const Q=load(),row={id:'C1',date:'2026-01-01',faultId:'F1',amountCents:10000};
  assert.equal(Q.matches('claims',row,data,{from:'2026-01-01'}),false);
  assert.equal(Q.matches('claims',row,data,{nonconformityId:'F1'}),false);
  const cells=Q.claimExport([row]);
  assert.equal(cells[1][0],'');
  assert.equal(cells[1][2],'');
  assert.equal(Q.claimColumns.length,22);
});
test('signed amount ranges include zero and negative values but exclude unknown',()=>{
  const Q=load();
  assert.equal(Q.matches('claims',{amountCents:-250},data,{amountMin:'-3',amountMax:'-1'}),true);
  assert.equal(Q.matches('claims',{amountCents:0},data,{amountMin:'0',amountMax:'0'}),true);
  assert.equal(Q.matches('claims',{amountCents:null},data,{amountMin:'0'}),false);
  assert.equal(Q.matches('claims',{supplierAgreedCents:0},data,{supplierAgreedMax:'0'}),true);
  assert.equal(Q.matches('claims',{supplierAgreedCents:null},data,{supplierAgreedMax:'0'}),false);
});
test('work filters use visible fault fields with snapshot fallback',()=>{
  const Q=load();
  assert.equal(Q.matches('work',data.analyses[0],data,{customer:'客户甲',category:'控制器',analysisStatus:'进行中'}),true);
  assert.equal(Q.matches('work',data.analyses[0],data,{analysisStatus:'已关闭'}),false);
  const detached={id:'A2',faultId:'missing',status:'closed',snapshot:{customer:'历史客户',date:'2025-12-01'}};
  assert.equal(Q.matches('work',detached,data,{customer:'历史客户',to:'2025-12-31'}),true);
});
test('draft filters do not apply until confirmed, reset and modules are independent',()=>{
  const Q=load(),lists=Q.create({escape:E}),row=data.faults[0];
  const form={dataset:{listFilter:'faults'},entries:[['customer','客户乙']]};
  lists.capture(form);
  assert.equal(lists.filter('faults',[row],data).length,1);
  assert.equal(lists.apply(form),true);
  assert.equal(lists.filter('faults',[row],data).length,0);
  assert.equal(lists.filter('claims',[{id:'C1',customer:'客户甲'}],data).length,1);
  lists.reset('faults');
  assert.equal(lists.filter('faults',[row],data).length,1);
});
test('validation rejects invalid dates and reversed ranges without banning signed amounts',()=>{
  const Q=load();
  assert.equal(Q.validate('claims',{from:'2026-02-30'}).field,'from');
  assert.equal(Q.validate('claims',{from:'2026-05-01',to:'2026-04-01'}).field,'to');
  assert.equal(Q.validate('claims',{amountMin:'2',amountMax:'-1'}).field,'amountMax');
  assert.equal(Q.validate('claims',{amountMin:'Infinity'}).field,'amountMin');
  assert.equal(Q.validate('claims',{amountMin:'-5',amountMax:'-1'}),null);
});
test('table escapes source values and preserves zero, unknown, photo and export column order',()=>{
  const Q=load(),row={id:'<script>',processingDate:'2026-05-01',amountCents:0,photo:{id:'photo-1',name:'故障照片'}};
  const html=Q.claimTable([row],E,n=>Number(n).toFixed(2));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('>0.00</td>'));
  assert.ok(html.includes('>—</td>'));
  assert.ok(html.includes('data-wf-download="photo-1"'));
  const exported=Q.claimExport([row]);
  assert.equal(exported[0].join('|'),Q.claimColumns.map(([,label])=>label).join('|'));
  assert.equal(exported[1][13],'photo-1');
  assert.equal(exported[1][11],0);
  assert.equal(exported[1][12],null);
});
test('filter options come from visible records and escaped labels',()=>{
  const Q=load(),lists=Q.create({escape:E});
  const html=lists.filters('faults',{...data,faults:[{...data.faults[0],customer:'<客户>'}]},1);
  assert.ok(html.includes('&lt;客户&gt;'));
  assert.ok(!html.includes('<客户>'));
  assert.ok(html.includes('data-expand-filters'));
  assert.ok(html.includes('data-clear-list-filter'));
  assert.ok(!html.includes('min="0"'));
});
