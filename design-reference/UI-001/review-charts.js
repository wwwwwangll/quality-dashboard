(() => {
  const palette = ['#7462bc','#389b83','#d39b45','#a38bd0','#76b6a0','#c1b4dd','#acbd87','#d7bb88'];
  const number = value => Number(value).toLocaleString('zh-CN', { maximumFractionDigits:2 });
  const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const empty = '<p class="empty">当前范围暂无数据</p>';
  function donut(rows, kind, field, E) {
    const total = rows.reduce((sum, row) => sum + Math.max(0,row.value),0);
    if (!total) return empty;
    const circumference = 2 * Math.PI * 66;
    let offset = 0;
    const segments = rows.map((row,index) => {
      const length = Math.max(0,row.value) / total * circumference;
      const segment = '<circle cx="100" cy="100" r="66" fill="none" stroke="' + palette[index % palette.length] +
        '" stroke-width="22" stroke-dasharray="' + length + ' ' + (circumference-length) +
        '" stroke-dashoffset="' + (-offset) + '" transform="rotate(-90 100 100)"><title>' +
        E(row.label) + '：' + number(row.value) + '（' + (row.value/total*100).toFixed(1) + '%）</title></circle>';
      offset += length;
      return segment;
    }).join('');
    const unit = kind === 'claim' ? '元' : '件';
    return '<div class="review-donut"><svg viewBox="0 0 200 200" role="img" aria-label="' +
      E(field === 'category' ? '产品类别占比' : '自制与外购索赔金额占比') + '">' + segments +
      '<text x="100" y="96" text-anchor="middle" style="font-size:23px;fill:#302e29;font-weight:600">' + number(total) +
      '</text><text x="100" y="120" text-anchor="middle">合计 · ' + unit + '</text></svg><div class="review-donut-legend">' +
      rows.map((row,index) => '<button type="button" data-v4="board-detail" data-kind="' + kind + '" data-field="' +
        field + '" data-value="' + E(row.label) + '"><i style="background:' + palette[index % palette.length] +
        '"></i><span>' + E(row.label) + '</span><b>' + (row.value/total*100).toFixed(1) +
        '% · ' + number(row.value) + '</b></button>').join('') + '</div></div>';
  }
  function lineChart(rows, previous, unit) {
    if (!rows.length) return empty;
    const width = Math.max(600,rows.length*48), height = 240;
    const left = 58, top = 22, bottom = 195, right = width-22;
    const peak = Math.max(1,...rows.flatMap(row => [row.value??0,row.previous??0]));
    const magnitude = 10 ** Math.floor(Math.log10(peak / 4));
    const tickStep = [1,2,2.5,5,10].map(step => step * magnitude).find(step => step >= peak / 4);
    const maximum = tickStep * 4;
    const x = index => rows.length===1 ? (left+right)/2 : left+index*(right-left)/(rows.length-1);
    const y = value => bottom-value/maximum*(bottom-top);
    const labels = rows.map((row,index) => '<text x="' + x(index) + '" y="219" text-anchor="middle">' +
      escape(row.label) + '</text>').join('');
    const grid = [0,.25,.5,.75,1].map(tick => '<line x1="' + left + '" x2="' + right + '" y1="' +
      y(maximum*tick) + '" y2="' + y(maximum*tick) + '" stroke="#e2dfd7" stroke-opacity=".85"/><text x="' +
      (left-8) + '" y="' + (y(maximum*tick)+4) + '" text-anchor="end">' + number(maximum*tick) + '</text>').join('');
    function series(key,color,dashed) {
      let commands = '', segmentOpen = false;
      for (const [index,row] of rows.entries()) {
        if (row[key] == null) { segmentOpen = false; continue; }
        commands += (segmentOpen ? ' L' : ' M') + x(index) + ',' + y(row[key]);
        segmentOpen = true;
      }
      return '<path d="' + commands + '" fill="none" stroke="' + color + '" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"' +
        (dashed ? ' stroke-dasharray="5 4"' : '') + '/>' + rows.map((row,index) => row[key] == null ? '' :
        '<circle cx="' + x(index) + '" cy="' + y(row[key]) + '" r="3.5" fill="white" stroke="' + color + '" stroke-width="2"><title>' +
        escape(row.label) + ' · ' + (key === 'previous' ? '上年同月' : '所选范围') + '：' + number(row[key]) + unit + '</title></circle>').join('');
    }
    const currentColor = previous ? '#7462bc' : '#389b83';
    return '<div class="review-chart-scroll'+(previous?'':' review-amount-trend')+'"><svg class="review-line-chart" viewBox="0 0 ' + width + ' ' + height +
      '" role="img" aria-label="月度趋势，单位' + unit + '">' + grid + labels + series('value',currentColor,false) +
      (previous?series('previous','#d39b45',true):'') +
      '<text x="' + left + '" y="12">单位 · ' + unit + '</text></svg></div>' +
      '<div class="review-chart-legend'+(previous?'':' review-amount-legend')+'"><span><i></i>所选范围</span>' +
      (previous?'<span><i class="previous"></i>上年同月</span>':'') + '</div>';
  }
  function trend(series) {
    return lineChart(series.map(row => ({
      label: row.month.slice(2), value:row.future?null:row.quantity, previous:row.previous
    })),true,'件') + '<p class="review-chart-note">未来月份不绘制本年数据点；部分月份与上年整月的口径以原统计说明为准。</p>';
  }
  function monthlyAmount(rows,kind,field,E) {
    if (!rows.length) return empty;
    return lineChart([...rows].sort((a,b)=>a.label.localeCompare(b.label)).map(row => ({
      label:row.label.slice(2), value:row.value
    })),false,'元') + '<details><summary class="review-chart-note">查看月度金额与明细入口</summary>' +
      rows.slice().sort((a,b)=>a.label.localeCompare(b.label)).map(row => '<button class="work-btn compact" data-v4="board-detail" data-kind="' +
        kind + '" data-field="' + field + '" data-value="' + E(row.label) + '">' + E(row.label) + ' · ' + number(row.value) + '元</button>').join(' ') + '</details>';
  }
  window.QualityCharts = { donut, trend, monthlyAmount };
})();
