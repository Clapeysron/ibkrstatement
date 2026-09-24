import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseIbkrReport } from '../src/parser.js';
import { decodeReportFile } from '../src/encoding.js';
import * as model from '../src/dashboard-model.js';
import { createRealizedChart } from '../src/interactive-chart.js';
import { account, completeReport, chineseReport, forex } from './fixtures.js';

function harness() {
  const listeners={};
  const root={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[],addEventListener:(name,fn)=>listeners[name]=fn};
  const document={querySelector:()=>root,documentElement:{dataset:{},lang:''}};
  const sandbox=vm.createContext({document,Intl,URLSearchParams,window:{location:{search:''},scrollTo(){}},localStorage:{getItem:()=>null,setItem(){}},parseIbkrReport,decodeReportFile,createRealizedChart,...model});
  const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'');
  vm.runInContext(source,sandbox);
  const api=vm.runInContext('({state,render,parseText,positionsPage,modal,capitalBase,displayProfit})',sandbox);
  return {...api,root,listeners};
}

test('Chinese and English CSV render all eight dashboard pages',()=>{
  for(const csv of [completeReport,chineseReport]){
    const app=harness();app.parseText(csv,'test.csv');assert.ok(app.state.data);
    for(const page of ['positions','analysis','calendar','summary','ranking','assets','cash','orders']){
      app.state.page=page;app.render();assert.match(app.root.innerHTML,/CSV 报表/);
      assert.doesNotMatch(app.root.innerHTML,/NaN|undefined|Infinity/);
    }
  }
});
test('UI describes snapshot prices and realized-only calendar without benchmark placeholders',()=>{
  const app=harness();app.parseText(chineseReport,'test.csv');
  assert.match(app.root.innerHTML,/累计已实现交易盈亏/);
  assert.doesNotMatch(app.root.innerHTML,/标普|实时价格|当日订单|策略订单/);
  app.state.page='positions';app.render();assert.match(app.root.innerHTML,/收盘价 \/ 成本价/);
  app.state.page='calendar';app.state.calendarMetric='rate';app.render();
  assert.match(app.root.innerHTML,/非每日账户收益率/);
});
test('missing input and invalid currency fail visibly without stale report or injection',()=>{
  const app=harness();app.parseText(completeReport,'valid.csv');
  app.parseText(account.replace(',USD',',<img src=x onerror=alert(1)>'),'bad.csv');
  assert.equal(app.state.data,null);assert.match(app.root.innerHTML,/无效币种/);assert.doesNotMatch(app.root.innerHTML,/<img|onerror/);
  app.parseText('','empty.csv');assert.match(app.root.innerHTML,/没有可解析的内容/);
  app.parseText(account+forex,'missing-rate.csv');assert.match(app.root.innerHTML,/缺少 HKD/);
});
test('unknown NAV and returns do not become fabricated zero returns',()=>{
  const app=harness();app.parseText(account,'empty.csv');assert.match(app.root.innerHTML,/区间账户收益率未提供/);
  assert.doesNotMatch(app.root.innerHTML,/>0\.00%/);assert.equal(app.capitalBase(),null);assert.equal(app.displayProfit(12,'rate'),'—');
  app.state.chartMode='rate';app.render();assert.match(app.root.innerHTML,/缺少有效投入基数/);
});
test('fixed-base percentage is distinct from statement time weighted return',()=>{
  const app=harness();app.parseText(chineseReport,'test.csv');
  app.state.data.navChange.push({key:'depositsAndWithdrawals',label:'出入金',value:1000});
  app.state.data.navDetails.changeKeys.push('depositsAndWithdrawals');
  assert.equal(app.capitalBase(),2005);assert.equal(app.displayProfit(200.5,'rate'),'+10.00%');
  app.state.chartMode='rate';app.render();assert.match(app.root.innerHTML,/占投入比/);assert.match(app.root.innerHTML,/固定基数 2,005\.00/);
});
test('all report-provided text stays escaped, including detail modal',()=>{
  const app=harness();app.parseText(chineseReport,'<img src=x>.csv');
  app.state.data.instruments=[{symbol:'ABC',name:'<img src=x onerror=alert(1)>',assetCategory:'Stocks'}];
  app.state.page='positions';app.render();assert.doesNotMatch(app.root.innerHTML,/<img/);assert.match(app.root.innerHTML,/&lt;img/);
  app.state.modal={kind:'trade',index:0};app.render();assert.doesNotMatch(app.root.innerHTML,/<img/);assert.match(app.root.innerHTML,/&lt;img/);
});
test('commission detail keeps its own currency and original report time',()=>{
  const app=harness();app.parseText(completeReport,'test.csv');
  const i=app.state.data.tradeDetails.findIndex(t=>t.assetCategory==='Forex');
  app.state.modal={kind:'trade',index:i};app.render();
  assert.match(app.root.innerHTML,/-0\.35 USD/);assert.match(app.root.innerHTML,/2026-01-03, 12:00:00/);
  assert.doesNotMatch(app.root.innerHTML,/美东|市价委托|已全部成交/);
});
test('option symbol details normalize category between rankings and trade records',()=>{
  const app=harness();app.parseText(completeReport,'test.csv');
  const t=app.state.data.tradeDetails[0];t.symbol='ABC 260116C00100000';t.assetCategory='Equity and Index Options';
  Object.assign(app.state.data.positions[0],{symbol:t.symbol,assetCategory:t.assetCategory,quantity:-1});
  app.state.modal={kind:'symbol',symbol:t.symbol,assetCategory:'Options'};app.render();
  assert.match(app.root.innerHTML,/data-trade="0"/);
  assert.match(app.modal(),/class="security-tags">期权 · 空头<\/span>/);
});

test('missing Trades renders unknown totals while an explicitly empty trade section renders zero',()=>{
  const app=harness();app.parseText(account,'missing.csv');
  assert.match(app.root.innerHTML,/<div class="big-amount neutral">—<\/div>/);
  app.state.data.sectionStats.Trades=0;app.render();
  assert.match(app.root.innerHTML,/<div class="big-amount neutral">0\.00<\/div>/);
});

test('holdings omit redundant stock labels but preserve option and short-position information',()=>{
  const app=harness();app.parseText(chineseReport,'test.csv');
  const position=app.state.data.positions[0];
  assert.match(app.positionsPage(),/<button class="security-code holding-name"[^>]*>ABC<\/button>/);
  assert.doesNotMatch(app.positionsPage(),/class="security-tags">股票/);
  position.quantity=-10;position.assetCategory='Options';
  assert.match(app.positionsPage(),/<span class="security-tags">期权 · 空头<\/span>/);
});

test('security identities use code before name across lists, previews and details',()=>{
  const app=harness();app.parseText(chineseReport,'test.csv');
  app.state.data.instruments=[{symbol:'ABC',name:'Example Company',assetCategory:'Stocks'}];
  for(const page of ['positions','analysis','summary','ranking','cash','orders']){
    app.state.page=page;app.render();
    assert.match(app.root.innerHTML,/class="security-code[^"\n]*"[^>]*>ABC<\/(?:strong|button)><span class="security-name"[^>]*>Example Company<\/span>/,page);
    assert.doesNotMatch(app.root.innerHTML,/ABC · 股票|class="security-tags">股票/,page);
  }
  app.state.modal={kind:'trade',index:0};
  assert.match(app.modal(),/class="security-code"[^>]*>ABC<\/strong><span class="security-name"[^>]*>Example Company<\/span>/);
  app.state.modal={kind:'symbol',symbol:'ABC',assetCategory:'Stocks'};
  assert.match(app.modal(),/id="dialog-title">ABC<\/h2>/);
  assert.match(app.modal(),/class="security-name">Example Company<\/span>/);
});

test('distribution exposes reported cash separately and never invents unavailable cash',()=>{
  const app=harness();app.parseText(chineseReport,'test.csv');
  app.state.data.nav.cash=100;app.state.data.navDetails.hasCash=true;
  assert.match(app.positionsPage(),/现金<\/strong>/);
  app.state.data.nav.cash=-100;
  assert.match(app.positionsPage(),/现金借款<\/strong>/);
  app.state.data.navDetails.hasCash=false;
  assert.doesNotMatch(app.positionsPage(),/现金(?:借款)?<\/strong>/);
  assert.match(app.positionsPage(),/报表未提供现金余额/);
});

test('year and month calendars show profit values without transaction counts',()=>{
  const app=harness();app.parseText(chineseReport,'test.csv');app.state.page='calendar';
  for(const mode of ['year','month']){
    app.state.calendarMode=mode;app.render();
    assert.doesNotMatch(app.root.innerHTML,/笔成交/);
    assert.match(app.root.innerHTML,/\+18\.00/);
  }
});

test('interactive chart retains selected dates across display modes and clips uncovered dates',()=>{
  const app=harness();app.parseText(chineseReport,'test.csv');
  app.state.chartDate='2026-01-03';app.render();
  assert.match(app.root.innerHTML,/role="slider"/);
  assert.match(app.root.innerHTML,/data-chart-daily/);
  assert.match(app.root.innerHTML,/data-chart-total/);
  assert.match(app.root.innerHTML,/>2026\/01\/03<\/text>/);
  assert.doesNotMatch(app.root.innerHTML,/chart-label[^>]*>2026\/01\/01/);
  app.state.chartMode='rate';app.render();
  assert.equal(app.state.chartDate,'2026-01-03');
});
