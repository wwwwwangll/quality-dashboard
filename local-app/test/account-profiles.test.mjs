import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {seedPreview} from '../scripts/seed-preview.mjs';import {createStore} from '../lib/store.mjs';
test('新测试包含细分质量与研发岗位，账号按九组归类并实际删除旧登录，旧目录不能重复初始化',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quality-account-profiles-test-'));let store;
 try{await seedPreview(dir,{complete:false,passwords:false});store=createStore({dataDir:dir,environment:'test',testMode:true});
  assert.equal(store.list('users').length,27);assert.equal(store.list('users').filter(u=>u.enabled&&!u.archived).length,27);
  for(const id of ['quality','project','electric','intelligence'])assert.equal(store.get('users',id),null);for(const id of ['system1','system2'])assert.equal(store.get('users',id).groupId,'systems');
  for(const id of ['cqe','apqe','pqe','sqe','qse','quality_manager','changsha_qe','changsha_qm'])assert.equal(store.get('users',id).role,'quality-engineer');
  assert.equal(store.get('users','after_sales').dept,'质量部');assert.equal(store.get('users','sales').role,'worker');
  const active=store.list('analyses').find(x=>x.status==='active');assert.equal(active.workflow.tasks.find(t=>t.kind==='grid'&&t.data.dimension==='design').owner,'intelligence_struct');
  store.close();store=null;await assert.rejects(seedPreview(dir,{complete:false}),/不会覆盖/);
 }finally{store?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
