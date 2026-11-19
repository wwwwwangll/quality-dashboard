import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/ui-charts.js',import.meta.url),'utf8');
const context=vm.createContext({window:{}});
vm.runInContext(source,context);
const chart=context.window.QualityCharts;
const escape=value=>String(value).replaceAll('<','&lt;').replaceAll('"','&quot;');
test('零数量类别仍可查看原记录，不误报无数据',()=>{
  const output=chart.donut([{label:'显示屏',value:0}],'fault','category',escape);
  assert.doesNotMatch(output,/暂无数据|NaN|Infinity/);
  assert.match(output,/data-value="显示屏"/);
  assert.match(output,/无占比/);
  assert.match(chart.donut([],'fault','category',escape),/暂无数据/);
});
test('稀疏月度金额补齐时间轴并断线，真实零值仍保留',()=>{
  const output=chart.monthlyAmount([{label:'2026-01',value:0},{label:'2026-12',value:20}],'claim','month',escape);
  assert.match(output,/26-02/);
  assert.match(output,/26-11/);
  const path=output.match(/<path d="([^"]+)"/)[1];
  assert.equal((path.match(/ M/g)||[]).length,2);
  assert.doesNotMatch(path,/ L/);
  assert.match(output,/所选范围：0元/);
});
test('未来月份不画本年数据，长周期提供可滚动的时间轴',()=>{
  const series=Array.from({length:24},(_,index)=>({month:(2025+Math.floor(index/12))+'-'+String(index%12+1).padStart(2,'0'),quantity:0,previous:1,future:index===23}));
  const output=chart.trend(series);
  assert.match(output,/min-width:1152px/);
  assert.match(output,/2026-12 尚未到达，本年未统计/);
  assert.doesNotMatch(output,/2026-12 本年0件/);
});
test('图例和时间轴文本按传入内容转义',()=>{
  const output=chart.donut([{label:'<img src=x>',value:3}],'fault','category',escape);
  assert.doesNotMatch(output,/<img/);
  assert.match(output,/&lt;img/);
});
