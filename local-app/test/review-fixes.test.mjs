import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(app,p),'utf8');
test('未来月份标注未到，不作为本年零报故；历史月份仍显示实际0',()=>{
 const ctx=vm.createContext({window:{}});vm.runInContext(read('public/local-analytics.js'),ctx);ctx.window.LocalAnalytics=ctx.window.LocalAnalytics;
 vm.runInContext(read('public/dashboard-v4.js'),ctx);const b=ctx.window.BoardV4.state('2026-11-01');b.modules=['trend'];
 const html=ctx.window.BoardV4.render({faults:[],claims:[],products:[],shipments:[]},b,{rows:[]});
 assert.match(html,/2026-12 尚未到达，本年未统计/);assert.doesNotMatch(html,/2026-12 本年0件/);assert.match(html,/2026-01 本年0件/);
});
test('CSV公式文本含前置空格、TAB、回车也按文本导出，普通汉字不被改写',()=>{
 const source=read('public/local-app.js').split('\n').find(l=>l.startsWith('function csv(')),ctx=vm.createContext({});vm.runInContext(source,ctx);
 for(const value of ['=1+1',' +SUM(1,2)','\t=1','\r@SUM(1,2)'])assert.ok(ctx.csv([[value]]).startsWith('\uFEFF"\''));
 assert.equal(ctx.csv([['显示屏']]),'\uFEFF"显示屏"');
});
test('旧静态站主要动态文本转义，不拼入未经转义的料号客户名称',()=>{
 const source=read('../dist/app.js'),ctx=vm.createContext({});vm.runInContext(source.split('\n')[0]+'\nthis.escape=escapeHTML;',ctx);
 assert.equal(ctx.escape('<img src=x onerror="alert(1)">'),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
 for(const key of ['id','model','issue','customer','name'])assert.ok(!source.includes('${r.'+key+'}'));
 assert.ok(!source.includes('preserveAspectRatio="none"'));
});

test('发布依赖声明与锁定文件一致，干净安装不会发生版本冲突',()=>{
 const manifest=JSON.parse(read('package.json')),lock=JSON.parse(read('package-lock.json'));
 for(const [name,version] of Object.entries(manifest.dependencies)){
  assert.equal(lock.packages[''].dependencies[name],version,name+' root lock');
  assert.equal(lock.packages['node_modules/'+name].version,version,name+' resolved lock');
 }
});
