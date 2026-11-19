(function(root){
  'use strict';
  const amountKeys=['amountMin','amountMax','agreedMin','agreedMax'];
  const money=(row,key)=>row[key+'Cents']!=null?row[key+'Cents']/100:row[key]??null;
  function within(value,min,max){
    return (!min&&!max)||(value!=null&&(!min||value>=Number(min))&&(!max||value<=Number(max)));
  }
  function currentAmounts(){
    return Object.fromEntries(amountKeys.map(key=>[key,document.querySelector('[data-review-amount="'+key+'"]')?.value||'']));
  }
  root.QualityDashboard={
    newBoard(Board,today,mode){
      return {...Board.state(today),mode,modules:Board.modules.map(([key])=>key).filter(key=>mode==='claims'?key==='finance':key!=='finance')};
    },
    boardTabs(mode){
      return [['faults','报故看板'],['claims','索赔看板']].map(([key,label])=>
        '<button type="button" data-v4="board-mode" data-mode="'+key+'" aria-pressed="'+(mode===key)+'">'+label+'</button>').join('');
    },
    currentAmounts,
    readAmounts(){
      const values=currentAmounts();
      for(const key of ['amount','agreed']){
        const min=document.querySelector('[data-review-amount="'+key+'Min"]'),max=document.querySelector('[data-review-amount="'+key+'Max"]');
        if(max)max.setCustomValidity(min?.value&&max.value&&Number(min.value)>Number(max.value)?'最大金额不能小于最小金额。':'');
        if(min&&!min.reportValidity()||max&&!max.reportValidity())return null;
      }
      return values;
    },
    matchesAmounts(row,ranges={}){
      return within(money(row,'amount'),ranges.amountMin,ranges.amountMax)&&within(money(row,'agreed'),ranges.agreedMin,ranges.agreedMax);
    },
    amountFields(board,E){
      const values=board.amountDraft||board.amountRanges||{};
      const field=(key,label,boundary)=>'<input aria-label="'+label+boundary+'" placeholder="'+boundary+'" type="number" min="0" step="0.01" data-review-amount="'+key+'" value="'+E(values[key]||'')+'">';
      return [['amount','提出索赔金额'],['agreed','承认索赔金额']].map(([key,label])=>
        '<fieldset class="review-amount"><legend>'+label+'（元）</legend>'+field(key+'Min',label,'最小值')+'<span>至</span>'+field(key+'Max',label,'最大值')+'</fieldset>').join('');
    },
    transferKpi(rows,format){
      const known=rows.map(row=>money(row,'supplierAgreed')).filter(value=>value!=null);
      const total=known.reduce((sum,value)=>sum+Math.round(value*100),0)/100;
      return '<div class="kpi"><small>转嫁金额</small><b>'+(known.length?format(total):'—')+'</b><small>元 · 供应商承认金额'+
        (known.length<rows.length?' · '+(rows.length-known.length)+' 笔未填':'')+'</small></div>';
    }
  };
  document.addEventListener('input',event=>{
    if(event.target.matches('[data-review-amount]'))document.querySelectorAll('[data-review-amount]').forEach(field=>field.setCustomValidity(''));
  });
})(window);
