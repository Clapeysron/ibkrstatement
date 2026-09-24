import { parseIbkrReport } from './parser.js';
import { decodeReportFile } from './encoding.js';
import { createRealizedChart } from './interactive-chart.js';
import { reportRange, selectRange, filterTrades, instrumentFor, dailyRealized, rankRealized, cashRecords, assetBridge, holdingTotals, holdingDistribution } from './dashboard-model.js';

const app = document.querySelector('#app');
let activeChart = null;
const pages = [
  ['positions', '当前持仓', 'pie'], ['analysis', '资产盈亏分析', 'chart'],
  ['calendar', '收益日历', 'calendar'], ['summary', '盈亏总结', 'wallet'],
  ['ranking', '盈亏排行榜', 'rank'], ['assets', '我的资产', 'flow'],
  ['cash', '资金记录', 'list'], ['orders', '成交查询', 'search']
];
const periods = [['month', '本月'], ['1m', '近 1 月'], ['6m', '近 6 月'], ['year', '本年'], ['1y', '近 1 年'], ['all', '全部']];
const paths = {
  chart: '<path d="M4 19V5m0 14h16M7 14l4-5 4 3 5-7"/>',
  pie: '<path d="M12 3v9h9A9 9 0 1 1 12 3Z"/><path d="M16 3.8a8 8 0 0 1 4.2 4.2H16Z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h1m6 0h1m-8 3h1"/>',
  wallet: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18m-5 4h5v4h-5Z"/>',
  rank: '<path d="M4 20V12h5v8m0 0V4h6v16m0 0v-9h5v9M2 20h20"/>',
  flow: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="9" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M9 6h3v12H9m3-6h3"/>',
  list: '<path d="M8 5h12M8 12h12M8 19h12M3 5h1m-1 7h1m-1 7h1"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20 15A8.5 8.5 0 0 1 9 4a8.5 8.5 0 1 0 11 11Z"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m14 5-7 7 7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  filter: '<path d="M3 4h18l-7 8v7l-4 2v-9Z"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  check: '<path d="m5 12 4 4L19 6"/>'
};
const colors = ['#ff5900', '#389cff', '#00b89c', '#ffb23f', '#a99af0', '#ed7fa9'];
const state = {
  data: null, page: 'analysis', sourceName: '', demo: false, error: '', loading: false,
  theme: localStorage.getItem('ibkr-analytics-theme') || 'dark', range: 'year',
  chartMode: 'amount', chartDate: null, calendarMode: 'month', calendarMetric: 'amount', calendarMonth: '', selectedDay: '',
  rankingSide: 'profit', asset: 'all', search: '', holdSort: 'value', holdDesc: true, holdView: 'value',
  recordsPeriod: 'all', side: 'all', currency: 'all', recordType: 'all', dateFrom: '', dateTo: '',
  showFilters: false, limit: 40, modal: null
};
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const number = (value, digits = 2) => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) : '—';
const signed = (value, digits = 2) => Number.isFinite(value) ? (value > 0 ? '+' : '') + number(value, digits) : '—';
const tone = value => value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral';
const compact = value => !Number.isFinite(value) ? '—' : Math.abs(value) >= 10000 ? signed(value / 10000) + '万' : Math.abs(value) >= 1000 ? signed(value / 1000) + 'K' : signed(value);
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.chart}</svg>`;
const currency = () => state.data?.baseCurrency || 'USD';
const title = () => pages.find(p => p[0] === state.page)?.[1] || '资产盈亏分析';
const range = () => selectRange(state.data, state.range);
const hasTrades = () => Object.hasOwn(state.data?.sectionStats || {}, 'Trades');
const dateText = date => date ? date.replaceAll('-', '/') : '—';
const category = value => ({Stocks: '股票', Options: '期权', 'Equity and Index Options': '期权', Forex: '外汇'}[value] || value || '证券');
const empty = (heading, body = '') => `<div class="empty-state">${icon('chart')}<strong>${esc(heading)}</strong>${body ? `<p>${esc(body)}</p>` : ''}</div>`;
const info = (kind = 'data', label = '查看数据说明') => `<button class="icon-button small" data-action="info" data-info="${kind}" aria-label="${label}">${icon('info')}</button>`;
const go = (page, label, cls = 'text-link') => `<button class="${cls}" data-page="${page}">${label}${icon('chevron')}</button>`;
const segment = (key, values, selected) => `<div class="segmented">${values.map(([v,l]) => `<button data-set="${key}" data-value="${v}" class="${selected === v ? 'active' : ''}" aria-pressed="${selected === v}">${l}</button>`).join('')}</div>`;
const periodTabs = (key = 'range', selected = state.range) => `<div class="period-tabs" aria-label="统计期间">${periods.map(([v,l]) => `<button class="chip ${selected === v ? 'active' : ''}" data-set="${key}" data-value="${v}" aria-pressed="${selected === v}">${l}</button>`).join('')}</div>`;
const panelHead = (heading, right = '', sub = '') => `<div class="panel-head"><div><h2 class="panel-title">${heading}</h2>${sub ? `<p class="panel-subtitle">${sub}</p>` : ''}</div>${right}</div>`;

function securityTags(assetCategory, short = false) {
  const label = category(assetCategory);
  const tags = [label !== '股票' && label !== '证券' ? label : '', short ? '空头' : ''].filter(Boolean);
  return tags.length ? `<span class="security-tags">${esc(tags.join(' · '))}</span>` : '';
}
function securityLabel(symbol, assetCategory, { name, clickable = false, short = false } = {}) {
  const meta = instrumentFor(state.data, symbol, assetCategory);
  const description = name || meta.name;
  const primary = clickable
    ? `<button class="security-code holding-name" data-symbol="${esc(symbol)}" data-category="${esc(assetCategory)}" title="${esc(symbol)}">${esc(symbol)}</button>`
    : `<strong class="security-code" title="${esc(symbol)}">${esc(symbol)}</strong>`;
  return `${primary}${description && description !== symbol ? `<span class="security-name" title="${esc(description)}">${esc(description)}</span>` : ''}${securityTags(assetCategory || meta.assetCategory,short)}`;
}

function render() {
  activeChart = null;
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.lang = 'zh-CN';
  app.innerHTML = state.data ? dashboard() : upload();
  activeChart?.mount(app.querySelector('[data-realized-chart]'));
  document.body?.classList?.toggle('modal-open',Boolean(state.modal));
  if (!state.modal && state.focusReturn) {
    const {key,value}=state.focusReturn;
    [...app.querySelectorAll('[data-'+key+']')].find(el=>el.getAttribute('data-'+key)===value)?.focus();
    state.focusReturn=null;
  }
  if (state.modal) {
    const dialog = app.querySelector('[role="dialog"]');
    dialog?.querySelector('button')?.focus();
  }
}
function brand() { return `<div class="brand"><span class="brand-mark">${icon('chart')}</span><div><strong>IBKR</strong><span>账户分析</span></div></div>`; }
function themeButton() { return `<button class="icon-button" data-action="theme" aria-label="切换为${state.theme === 'dark' ? '白天' : '黑夜'}模式" title="切换主题">${icon(state.theme === 'dark' ? 'sun' : 'moon')}</button>`; }
function upload() {
  return `<div class="upload-layout"><header class="upload-header">${brand()}${themeButton()}</header><main class="upload-card">
    <div class="upload-heading"><span class="account-avatar">${icon('wallet')}</span><h1>你的投资，一目了然</h1><p class="muted">导入 IBKR 活动报表，查看持仓与交易表现。</p></div>
    <div class="dropzone" id="dropzone">${icon('upload')}<h2>导入活动报表</h2><p>拖放 CSV / TXT 文件到这里</p><button class="button primary" data-action="choose" ${state.loading ? 'disabled' : ''}>${state.loading ? '正在读取…' : '选择报表文件'}</button><p class="muted">支持中文和英文 Activity Statement</p></div>
    <input class="file-input" id="fileInput" type="file" accept=".csv,.txt,text/csv,text/plain" aria-label="选择报表文件">
    ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ''}
    <div class="upload-actions"><span>${icon('lock')} 文件仅在本地浏览器中解析</span><button class="text-link" data-action="sample" ${state.loading ? 'disabled' : ''}>查看示例 ${icon('chevron')}</button></div>
    <details class="paste-area"><summary>粘贴 CSV 文本</summary><textarea id="pasteInput" aria-label="CSV 报表文本" placeholder="将完整 CSV 内容粘贴到这里"></textarea><button class="button" data-action="parse">解析文本</button></details>
    <details class="import-help"><summary>如何导出 IBKR 报表</summary><p>在 IBKR Client Portal 中进入「表现与报告 → 报表」，选择活动报表（Activity Statement），设置期间后导出 CSV。页面展示的数据截至报表结束日。</p></details>
  </main><footer class="upload-footer">IBKR 账户分析 · 本地报表工具</footer></div>`;
}
function dashboard() {
  const data = state.data;
  const rr = reportRange(data);
  const account = data.accountInfo.account || '本地账户';
  const mask = account.length > 5 ? account.slice(0,1) + '••••' + account.slice(-4) : account;
  return `<div class="app-shell"><aside class="sidebar">${brand()}<nav class="sidebar-nav" aria-label="报表导航">${pages.map(([id,label,ic]) => `<button class="nav-item ${state.page === id ? 'active' : ''}" data-page="${id}" ${state.page === id ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></button>`).join('')}</nav><div class="sidebar-footer"><span>${icon('lock')} 本地解析 · 数据不上传</span><button class="button subtle" data-action="import">${icon('upload')} 导入新报表</button></div></aside>
    <div class="workspace" data-page="${state.page}"><header class="topbar"><div class="topbar-title">${['calendar','summary','ranking','assets'].includes(state.page) ? `<button class="icon-button mobile-back" data-page="analysis" aria-label="返回分析">${icon('back')}</button>` : ''}<h1>${title()}</h1><span class="muted">截至 ${dateText(rr.end)}</span></div><div class="topbar-actions">${themeButton()}<button class="icon-button" data-action="export" aria-label="导出解析数据">${icon('download')}</button><button class="button subtle" data-action="import" aria-label="导入报表">${icon('upload')}<span>导入报表</span></button></div></header>
    <div class="account-strip"><span class="account-avatar">${icon('wallet')}</span><div class="account-meta"><strong>证券账户 <span class="muted">(${esc(mask)})</span></strong><span>${esc(currency())} 本位币 <span class="account-period">· ${dateText(rr.start)} – ${dateText(rr.end)}</span></span></div>${state.demo ? '<span class="source-badge demo">示例数据</span>' : '<span class="source-badge">CSV 报表</span>'}${info('data')}</div>
    <main class="content" id="mainContent" data-page="${state.page}">${renderPage()}</main>
    <footer class="data-footer">数据截至报表结束日 · ${esc(state.sourceName)} ${data.accountInfo.reportGeneratedAt ? `· 报表生成：${esc(data.accountInfo.reportGeneratedAt)}` : ''}</footer></div>
    <nav class="mobile-nav" aria-label="移动导航">${[['positions','持仓','pie'],['analysis','分析','chart'],['cash','资金','wallet'],['orders','成交','list']].map(([id,label,ic]) => `<button class="${(state.page === id || id === 'analysis' && ['calendar','summary','ranking','assets'].includes(state.page)) ? 'active' : ''}" data-page="${id}">${icon(ic)}<span>${label}</span></button>`).join('')}</nav>
    ${state.modal ? modal() : ''}</div>`;
}
function renderPage() {
  if (state.page === 'positions') return positionsPage();
  if (state.page === 'calendar') return calendarCard(false);
  if (state.page === 'summary') return summaryPage();
  if (state.page === 'ranking') return rankingPage();
  if (state.page === 'assets') return assetsCard(false);
  if (state.page === 'cash') return cashPage();
  if (state.page === 'orders') return ordersPage();
  return analysisPage();
}
function metric(label, value, sub = '', cls = '') { return `<div class="metric"><span class="muted">${label}</span><strong class="amount ${cls}">${value}</strong>${sub ? `<span class="subvalue">${sub}</span>` : ''}</div>`; }
function positionsPage() {
  const d = state.data, totals = holdingTotals(d), allocation = holdingDistribution(d);
  const query = state.search.trim().toLowerCase();
  let rows = d.positions.filter(p => !query || `${p.symbol} ${instrumentFor(d,p.symbol,p.assetCategory).name}`.toLowerCase().includes(query));
  rows = [...rows].sort((a,b) => { const key = ({value:'baseValue',profit:'baseUnrealizedPL',symbol:'symbol'})[state.holdSort] || 'baseValue'; const delta = typeof a[key] === 'string' ? a[key].localeCompare(b[key]) : a[key] - b[key]; return delta * (state.holdDesc ? -1 : 1); });
  const groups = [...new Set(rows.map(p => p.currency))];
  const net = d.navDetails?.hasNav ? d.nav.total : null;
  return `<section class="panel positions-panel">${panelHead('持仓分布', `<span class="muted">${d.positions.length} 只持仓</span>`)}
    <div class="holdings-summary">${metric(`持仓市值 (${esc(currency())})`,number(totals.value))}${metric('持仓盈亏',signed(totals.unrealized),'未实现盈亏',tone(totals.unrealized))}${metric('期末总资产',number(net),'含现金及应计项目')}</div>
    ${distribution(allocation)}
    <div class="toolbar"><label class="search-field">${icon('search')}<input data-input="search" value="${esc(state.search)}" placeholder="搜索证券名称或代码" aria-label="搜索持仓"></label><span class="muted">价格：报表收盘价</span></div>
    ${rows.length ? groups.map(ccy => `<div class="holding-group"><h3>${esc(ccy)} 资产 <span class="muted">${number(rows.filter(p => p.currency === ccy).reduce((s,p) => s+p.value,0))}</span></h3><div class="hold-mobile-switch">${segment('holdView',[['value','市值 / 价格'],['profit','盈亏 / 占比']],state.holdView)}</div><div class="table-wrap"><table class="holdings-table" data-hold-view="${state.holdView}"><thead><tr><th><button data-sort="symbol">代码 / 名称 ↕</button></th><th class="valuation-col"><button data-sort="value">市值 / 数量 ↕</button></th><th class="valuation-col">收盘价 / 成本价</th><th class="profit-col"><button data-sort="profit">持仓盈亏 ↕</button></th><th class="profit-col">资产占比</th></tr></thead><tbody>${rows.filter(p => p.currency === ccy).map(p => {
      const meta = instrumentFor(d,p.symbol,p.assetCategory);
      const cost = Number.isFinite(p.costPrice) ? p.costPrice : p.quantity && p.multiplier ? p.costBasis/(p.quantity*p.multiplier) : null;
      const pct = p.costBasis ? p.unrealizedPL/Math.abs(p.costBasis)*100 : null;
      return `<tr><td>${securityLabel(p.symbol,p.assetCategory,{name:meta.name,clickable:true,short:p.quantity<0})}</td><td class="valuation-col">${number(p.value)}<span class="subvalue">${number(p.quantity,Number.isInteger(p.quantity)?0:4)}</span></td><td class="valuation-col">${number(p.closePrice,3)}<span class="subvalue">${number(cost,3)}</span></td><td class="profit-col ${tone(p.unrealizedPL)}">${signed(p.unrealizedPL)}<span class="subvalue inherit">${Number.isFinite(pct) ? signed(pct)+'%' : '—'}</span></td><td class="profit-col">${net ? number(p.baseValue/net*100)+'%' : '—'}</td></tr>`;
    }).join('')}</tbody></table></div></div>`).join('') : empty('没有匹配的持仓','试试其他证券代码或名称。')}
    <p class="footnote">市值、价格及盈亏按各行原币种展示；资产占比以本位币市值 ÷ 期末总资产计算。分布图按证券${allocation.cash!==null?'与现金':''}的本位币绝对金额计算，不含应计利息等项目。${allocation.hasShort?'负持仓及现金借款按绝对金额计入分布。':''}${allocation.cash===null?'报表未提供现金余额，未计入分布。':''}</p></section>`;
}
function distribution(allocation) {
  if (!allocation.items.length) return '';
  const items = allocation.items.map((p,i) => ({...p,label:p.kind==='cash'?(p.value<0?'现金借款':'现金'):p.kind==='other'?'其他证券':p.symbol,color:p.kind==='cash'?'#8c9eae':colors[i%colors.length]}));
  const tooltip = p => `${p.label} ${number(p.weight*100)}% · ${number(p.value)} ${currency()}`;
  return `${allocation.total ? `<div class="distribution-bar" aria-label="证券与现金分布">${items.filter(p=>p.weight>0).map(p => `<span style="width:${p.weight*100}%;background:${p.color}" title="${esc(tooltip(p))}"></span>`).join('')}</div>` : ''}<div class="distribution-legend">${items.map(p => `<span class="distribution-item" title="${esc(tooltip(p))}"><i class="legend-dot" style="background:${p.color}"></i><span class="distribution-security">${p.kind==='security'?securityLabel(p.symbol,p.assetCategory,{name:p.name,short:p.value<0}):`<strong class="security-code">${p.label}</strong>`}</span><b>${number(p.weight*100,1)}%</b></span>`).join('')}</div>`;
}
function capitalBase() {
  const b=assetBridge(state.data);
  return Number.isFinite(b.start)&&Number.isFinite(b.netIn)&&b.start+b.netIn>0 ? b.start+b.netIn : null;
}
function displayProfit(value,mode='amount') {
  if(mode==='amount')return signed(value);
  const base=capitalBase();
  return base&&Number.isFinite(value)?signed(value/base*100)+'%':'—';
}
function analysisPage() {
  const d=state.data,r=range(),bridge=assetBridge(d),trades=filterTrades(d,r);
  const daily=dailyRealized(d,r),realized=hasTrades()?daily.reduce((s,x)=>s+x.value,0):null;
  const full=r.isFull&&d.navDetails?.hasReturn;
  const volume=hasTrades()?trades.reduce((s,t)=>s+t.baseGrossValue,0):null,symbols=new Set(trades.filter(t=>t.assetCategory==='Stocks').map(t=>t.symbol));
  const percent=state.chartMode==='rate';
  return `${periodTabs()}<section class="panel analysis-primary"><div class="performance-hero"><div class="hero-label">累计已实现交易盈亏 ${percent?'占投入比':'('+esc(currency())+')'} ${info('performance')}</div><div class="big-amount ${tone(realized)}">${displayProfit(realized,state.chartMode)}</div><div class="hero-return"><span class="${full?tone(d.nav.rateOfReturn):'muted'}">${full?signed(d.nav.rateOfReturn)+'%':'—'}</span><span class="muted">${full?'报表整期账户收益率':'区间账户收益率未提供'}</span></div><p class="muted">${dateText(r.start)} – ${dateText(r.end)}</p></div>
    <div class="chart-switch">${segment('chartMode',[['amount','盈亏金额'],['rate','盈亏百分比']],state.chartMode)}</div>
    <div class="chart-meta"><span><i class="legend-dot" style="background:var(--positive)"></i>我的已实现盈亏</span><span class="muted">${percent?'占固定投入基数':esc(currency())}</span></div>
    ${percent&&!capitalBase()?empty('缺少有效投入基数','需要报表期初资产和出入金数据，且合计大于零。'):lineChart(daily,r,percent?capitalBase():null)}
    <p class="footnote">${percent?'百分比 = 累计已实现盈亏 ÷（报表期初资产 + 已识别净投入）。使用固定基数 '+number(capitalBase())+' '+esc(currency())+'，用于衡量已实现盈亏占比。':'按成交日累计股票及期权已实现盈亏，包含已计入损益的佣金；不包含持仓浮盈变化、外汇及利息等账户变动。'}${r.partialCoverage?' 当前区间仅包含报表覆盖的数据。':''}</p></section>
    <div class="stat-pair"><section class="panel mini-stat"><span class="muted">累计成交金额 (${esc(currency())})</span><strong>${number(volume)}</strong><span>交易股票数 ${symbols.size}</span></section><section class="panel mini-stat"><span class="muted">期末总资产 (${esc(currency())})</span><strong>${number(bridge.navTotal)}</strong><span>报表整期账户盈亏 <b class="${tone(bridge.profit)}">${signed(bridge.profit)}</b></span></section></div>
    <div class="two-col analysis-grid">${calendarCard(true)}<div class="stack">${summaryCard()}${rankingCard(true)}</div></div>${assetsCard(true)}`;
}
function lineChart(days,r,base=null) {
  if (!days.length) return empty('当前期间没有已实现交易记录');
  const coverage = reportRange(state.data);
  const chartRange = { start: coverage.start > r.start ? coverage.start : r.start, end: r.end };
  activeChart = createRealizedChart({
    days, range: chartRange, base, currency: currency(), selectedDate: state.chartDate,
    mobile: window.matchMedia?.('(max-width: 600px)')?.matches,
    onSelect: date => { state.chartDate = date; }
  });
  return activeChart?.html || empty('当前期间没有已实现交易记录');
}
function calendarCard(preview) {
  const rr=reportRange(state.data),month=state.calendarMonth || rr.end?.slice(0,7);
  if(!month)return `<section class="panel">${panelHead('收益日历')}${empty('没有可用日期','导入包含有效成交日期的报表。')}</section>`;
  const [year,mo]=month.split('-').map(Number),dayRows=dailyRealized(state.data,{start:`${year}-01-01`,end:`${year}-12-31`});
  const byDay=new Map(dayRows.map(d=>[d.date,d]));
  const rrStart=rr.start?.slice(0,7),rrEnd=rr.end?.slice(0,7);
  const titleText=`收益日历 (${esc(currency())})`;
  let grid='';
  if(state.calendarMode==='year') {
    grid=`<div class="year-grid">${Array.from({length:12},(_,i)=>{const m=`${year}-${String(i+1).padStart(2,'0')}`,rows=dayRows.filter(d=>d.date.startsWith(m)),value=rows.reduce((s,d)=>s+d.value,0);return `<button class="year-cell ${rows.length?tone(value):''}" data-month="${m}" ${m<rrStart||m>rrEnd?'disabled':''}><span>${i+1} 月</span><strong>${rows.length?(state.calendarMetric==='amount'?compact(value):displayProfit(value,'rate')):'—'}</strong></button>`;}).join('')}</div>`;
  } else {
    const offset=new Date(year,mo-1,1).getDay(),count=new Date(year,mo,0).getDate();
    grid=`<div class="calendar-grid">${['日','一','二','三','四','五','六'].map(w=>`<div class="calendar-weekday">${w}</div>`).join('')}${Array.from({length:offset},()=>'<div class="calendar-day empty"></div>').join('')}${Array.from({length:count},(_,i)=>{const date=`${month}-${String(i+1).padStart(2,'0')}`,row=byDay.get(date),value=row?.value;return `<button class="calendar-day ${row?(value>0?'profit':value<0?'loss':''):''} ${state.selectedDay===date?'selected':''}" data-day="${date}" ${!row?'disabled':''} aria-label="${date}${row?` 已实现盈亏 ${displayProfit(value,state.calendarMetric)}`:' 无成交记录'}"><span class="day-number">${String(i+1).padStart(2,'0')}</span><span class="day-value">${row?(state.calendarMetric==='amount'?compact(value):displayProfit(value,'rate')):''}</span></button>`;}).join('')}</div>`;
  }
  return `<section class="panel calendar-panel">${panelHead(titleText,preview?go('calendar','查看全部'):info('calendar'),'股票及期权 · 已实现交易盈亏')}<div class="calendar-toolbar"><div class="month-picker"><button class="icon-button small" data-action="prev-month" aria-label="上${state.calendarMode==='year'?'年':'月'}" ${month<=rrStart?'disabled':''}>${icon('back')}</button><strong>${state.calendarMode==='year'?year:month.replace('-','/')}</strong><button class="icon-button small" data-action="next-month" aria-label="下${state.calendarMode==='year'?'年':'月'}" ${month>=rrEnd?'disabled':''}>${icon('chevron')}</button></div><div class="calendar-switches">${segment('calendarMode',[['year','年'],['month','月']],state.calendarMode)}${segment('calendarMetric',[['amount','金额'],['rate','百分比']],state.calendarMetric)}</div></div>${grid}
  ${state.calendarMetric==='rate'?'<p class="footnote">百分比为该日或该月已实现盈亏 ÷ 报表固定投入基数（期初资产 + 已识别净投入），非每日账户收益率。</p>':'<p class="footnote">空白日期表示没有成交记录；不代表账户当日盈亏为零。</p>'}
  ${state.selectedDay&&state.calendarMode==='month'&&state.selectedDay.startsWith(month)?`<div class="calendar-selection"><strong>${dateText(state.selectedDay)}</strong><span class="${tone(byDay.get(state.selectedDay)?.value)}">${signed(byDay.get(state.selectedDay)?.value)} ${esc(currency())}</span><button class="text-link" data-action="day-orders">查看当日成交${icon('chevron')}</button></div>`:''}</section>`;
}
function rankRows(preview=false) {
  let rows=rankRealized(state.data,range(),state.asset);
  rows=state.rankingSide==='profit'?rows.filter(x=>x.value>0):rows.filter(x=>x.value<0).sort((a,b)=>a.value-b.value);
  if(preview)rows=rows.slice(0,5);
  const max=Math.max(...rows.map(x=>Math.abs(x.value)),1);
  return rows.length?`<div class="rank-list">${rows.map((p,i)=>`<button class="rank-row" data-symbol="${esc(p.symbol)}" data-category="${esc(p.assetCategory)}"><span class="rank-fill ${tone(p.value)}" style="width:${Math.abs(p.value)/max*100}%"></span><span class="rank-number">${i+1}</span><span class="rank-symbol">${securityLabel(p.symbol,p.assetCategory,{name:p.name})}</span><span class="rank-amount ${tone(p.value)}">${signed(p.value)}</span></button>`).join('')}</div>`:empty(state.rankingSide==='profit'?'当前期间没有盈利标的':'当前期间没有亏损标的');
}
function rankingCard(preview) {
  return `<section class="panel ranking-panel">${panelHead(`${state.range==='year'?'本年':'区间'}盈亏排行榜 (${esc(currency())})`,preview?go('ranking','盈亏详情'):info('performance'),'已实现交易盈亏')}${segment('rankingSide',[['profit',preview?'盈利 Top5':'盈利'],['loss',preview?'亏损 Top5':'亏损']],state.rankingSide)}<div class="list-heading"><span>排行榜</span><span>盈亏总额</span></div>${rankRows(preview)}</section>`;
}
function rankingPage() {return `${periodTabs()}${assetTabs()}<p class="page-subtitle">${dateText(range().start)} – ${dateText(range().end)} · 点击证券查看成交明细</p>${rankingCard(false)}`;}
function assetTabs() { return `<div class="toolbar">${segment('asset',[['all','全部'],['Stocks','股票'],['Options','期权']],state.asset)}</div>`; }
function summaryCard() {
  const ranks=rankRealized(state.data,range());
  const sum=hasTrades()?ranks.reduce((s,p)=>s+p.value,0):null,best=ranks.find(p=>p.value>0),worst=[...ranks].reverse().find(p=>p.value<0);
  return `<section class="panel summary-panel">${panelHead(`${state.range==='year'?'本年':'区间'}盈亏总结 (${esc(currency())})`,go('summary','盈亏明细'))}<div class="summary-total"><span>股票及期权累计已实现盈亏</span><strong class="${tone(sum)}">${signed(sum)}</strong></div><div class="summary-duel"><div class="duel-gain"><span>盈利最多 ↗</span><div class="security-identity">${best?securityLabel(best.symbol,best.assetCategory,{name:best.name}):'<strong>暂无</strong>'}</div><b>${best?signed(best.value):'—'}</b></div><div class="duel-loss"><span>亏损最多 ↘</span><div class="security-identity">${worst?securityLabel(worst.symbol,worst.assetCategory,{name:worst.name}):'<strong>暂无</strong>'}</div><b>${worst?signed(worst.value):'—'}</b></div></div></section>`;
}
function summaryPage() {
  const rows=rankRealized(state.data,range(),state.asset),sum=hasTrades()?rows.reduce((s,p)=>s+p.value,0):null;
  return `${periodTabs()}${assetTabs()}<section class="panel summary-hero"><p class="muted">${dateText(range().start)} – ${dateText(range().end)}</p><h2>累计已实现盈亏 (${esc(currency())}) ${info('performance')}</h2><div class="big-amount ${tone(sum)}">${signed(sum)}</div></section><section class="panel">${panelHead('盈亏明细','<span class="muted">按已实现盈亏排序</span>')}<div class="list-heading"><span>代码 / 名称</span><span>盈亏金额</span></div>${rows.length?`<div class="record-list">${rows.map(p=>`<button class="record-row" data-symbol="${esc(p.symbol)}" data-category="${esc(p.assetCategory)}"><span class="record-main">${securityLabel(p.symbol,p.assetCategory,{name:p.name})}</span><span class="record-right ${tone(p.value)}"><strong>${signed(p.value)}</strong><span class="muted">${p.count} 笔成交</span></span></button>`).join('')}</div>`:empty('当前期间没有已实现盈亏记录')}</section>`;
}
function assetsCard(preview) {
  const b=assetBridge(state.data),rr=reportRange(state.data);
  const node=(label,value,cls='')=>`<div class="flow-node ${cls}"><span>${label}</span><strong class="${cls==='emphasis'?'':tone(value)}">${number(value)}</strong></div>`;
  const discrepancy=Number.isFinite(b.navTotal)&&Number.isFinite(b.end)?b.navTotal-b.end:null;
  return `<section class="panel assets-panel">${panelHead('我的资产',preview?go('assets','资产详情'):info('assets'),`${dateText(rr.start)} – ${dateText(rr.end)} · 报表整期`)}<div class="toolbar"><span class="chip active">${esc(currency())}</span><span class="muted">本位币汇总</span></div><div class="flow-diagram"><div class="flow-column">${node('现金净流入',b.cashIn)}${node('股票赠与',b.stockIn)}${node('其他资产净流入',null)}</div><div class="flow-connector" aria-hidden="true"></div><div class="flow-column">${node('期初总资产',b.start)}${node('已识别净投入',b.netIn)}${node('盈亏额',b.profit)}</div><div class="flow-connector" aria-hidden="true"></div><div class="flow-column final">${node('期末总资产',b.end,'emphasis')}</div></div><p class="footnote">盈亏额 = 期末总资产 − 期初总资产 − 已识别净投入。净投入包括报表出入金与股票赠与；报表未列出的其他资产转入转出显示“—”。</p>
  ${Number.isFinite(discrepancy)&&Math.abs(discrepancy)>.01?`<p class="notice">净资产值与净值变更区块的期末金额相差 ${number(discrepancy)} ${esc(currency())}，请核对原始报表。</p>`:''}
  ${!preview?`<div class="asset-detail"><h3>净值变动明细</h3>${(b.items||[]).map(item=>`<div class="detail-line"><span>${esc(item.label)}</span><strong class="${tone(item.value)}">${signed(item.value)}</strong></div>`).join('')}${Number.isFinite(b.reconciliation)&&Math.abs(b.reconciliation)>.01?`<div class="detail-line"><span>未归类差额</span><strong>${signed(b.reconciliation)}</strong></div>`:''}</div>`:''}<div class="panel-bottom">${go('cash','查看资金记录')}</div></section>`;
}
function recordRange() {
  const r=selectRange(state.data,state.recordsPeriod);
  return {...r,start:state.dateFrom||(state.recordsPeriod==='all'?null:r.start),end:state.dateTo||(state.recordsPeriod==='all'?null:r.end)};
}
function recordFilters(cash=false) {
  const currencies=[...new Set([...state.data.tradeDetails.map(t=>t.currency),...state.data.tradeDetails.map(t=>t.commissionCurrency),...(state.data.cashTransactions||[]).map(t=>t.currency)])].filter(Boolean).sort();
  return `<div class="toolbar record-toolbar"><label class="search-field">${icon('search')}<input data-input="search" value="${esc(state.search)}" placeholder="输入证券名称或代码的关键字" aria-label="搜索${cash?'资金记录':'成交记录'}"></label><button class="icon-button ${state.showFilters?'active':''}" data-action="filters" aria-label="筛选记录" aria-expanded="${state.showFilters}">${icon('filter')}</button></div>${periodTabs('recordsPeriod',state.recordsPeriod)}${state.showFilters?`<div class="filter-row"><label>开始日期<input type="date" data-change="dateFrom" value="${state.dateFrom}"></label><label>结束日期<input type="date" data-change="dateTo" value="${state.dateTo}"></label><label>币种<select data-change="currency"><option value="all">全部币种</option>${currencies.map(c=>`<option ${state.currency===c?'selected':''}>${esc(c)}</option>`).join('')}</select></label>${cash?`<label>记录类型<select data-change="recordType">${[['all','全部'],['buy','买入成交'],['sell','卖出成交'],['commission','交易手续费'],['deposit','入金'],['withdrawal','出金'],['interest','利息'],['fee','其他费用'],['dividend','股息'],['withholdingTax','代扣税']].map(([v,l])=>`<option value="${v}" ${state.recordType===v?'selected':''}>${l}</option>`).join('')}</select></label>`:`<label>资产类别<select data-change="asset">${[['all','全部'],['Stocks','股票'],['Options','期权'],['Forex','外汇']].map(([v,l])=>`<option value="${v}" ${state.asset===v?'selected':''}>${l}</option>`).join('')}</select></label>`}<button class="button subtle" data-action="clear-filters">重置筛选</button></div>`:''}${state.dateFrom&&state.dateTo&&state.dateFrom>state.dateTo?'<p class="error" role="alert">开始日期不能晚于结束日期。</p>':''}`;
}
function more(total) {return total>state.limit?`<div class="pagination"><button class="button subtle" data-action="more">加载更多 <span class="muted">${state.limit} / ${total}</span>${icon('down')}</button></div>`:`<div class="pagination muted">共 ${total} 条记录</div>`;}
function cashPage() {
  const r=recordRange(),q=state.search.trim().toLowerCase();
  const rows=cashRecords(state.data).filter(t=>(!r.start||t.date>=r.start)&&(!r.end||t.date<=r.end)&&(state.currency==='all'||state.currency===t.currency)&&(state.recordType==='all'||state.recordType===t.type)&&(!q||`${t.symbol} ${t.description} ${instrumentFor(state.data,t.symbol).name}`.toLowerCase().includes(q)));
  let lastMonth='';
  return `<section class="panel records-panel">${panelHead('资金记录',info('cash'))}${recordFilters(true)}<p class="footnote">成交款项、关联手续费及报表现金流水按原币种展示。手续费日期为关联成交日期。</p>${rows.length?`<div class="record-list">${rows.slice(0,state.limit).map(t=>{let heading='';const m=t.date.slice(0,7);if(m!==lastMonth){lastMonth=m;heading=`<h3 class="record-month">${m.replace('-',' 年 ')} 月</h3>`;}return `${heading}${cashRow(t)}`;}).join('')}</div>${more(rows.length)}`:empty('没有匹配的资金记录','调整日期、币种或记录类型后再试。')}</section>`;
}
function cashRow(t) {
  const trade = Number.isInteger(t.tradeIndex) ? state.data.tradeDetails[t.tradeIndex] : null;
  const quantity = Number.isFinite(t.quantity) ? ` · ${number(Math.abs(t.quantity),Number.isInteger(t.quantity)?0:4)}` : '';
  return `<button class="record-row ${t.symbol?'cash-security-row':''}" ${trade?`data-trade="${t.tradeIndex}"`:`data-cash="${esc(t.id)}"`}><span class="record-main">${t.symbol?securityLabel(t.symbol,trade?.assetCategory):`<strong>${esc(t.title)}</strong>`}<span class="record-meta">${esc(t.dateTimeText||dateText(t.date))}</span></span><span class="record-right"><strong>${t.amount<0?'-':t.amount>0?'+':''}${esc(t.currency)} ${number(Math.abs(t.amount))}</strong><span>${esc(t.symbol?t.title:t.description||'')}${quantity}</span></span></button>`;
}
function ordersPage() {
  const r=recordRange();
  const rows=filterTrades(state.data,r,{query:state.search,asset:state.asset,currency:state.currency,side:state.side});
  return `<section class="panel records-panel">${panelHead('历史成交',info('orders'))}${recordFilters()}<div class="toolbar">${segment('side',[['all','全部'],['Buy','买入'],['Sell','卖出']],state.side)}<span class="muted">${rows.length} 笔成交</span></div><div class="table-wrap"><table class="orders-table"><thead><tr><th>代码 / 名称</th><th>数量 / 成交价</th><th>方向</th><th>成交时间</th></tr></thead><tbody>${rows.slice(0,state.limit).map(t=>{const meta=instrumentFor(state.data,t.symbol,t.assetCategory),index=state.data.tradeDetails.indexOf(t);return `<tr data-trade="${index}" tabindex="0" role="button" aria-label="查看 ${esc(t.symbol)} ${t.side==='Buy'?'买入':'卖出'}成交详情"><td>${securityLabel(t.symbol,t.assetCategory,{name:meta.name})}</td><td>${number(Math.abs(t.quantity),Number.isInteger(t.quantity)?0:4)}<span class="subvalue">${number(t.price,3)} ${esc(t.currency)}</span></td><td class="${t.side==='Buy'?'positive':'negative'}">${t.side==='Buy'?'买入':'卖出'}<span class="subvalue muted">成交记录</span></td><td>${dateText(t.date)}<span class="subvalue">${esc(tradeClock(t))}</span></td></tr>`;}).join('')}</tbody></table></div>${!rows.length?empty('没有匹配的成交记录','调整搜索或筛选条件后再试。'):more(rows.length)}<p class="footnote">时间保留报表原始记录。这里只查询实际成交，不包含未成交委托、撤单或状态历史。</p></section>`;
}
function tradeClock(t) {return t.dateTimeText?.match(/\d{1,2}:\d{2}(?::\d{2})?/)?.[0] || '时间未提供';}
function modal() {
  const m=state.modal;
  let heading='',body='';
  if(m.kind==='trade') {
    const t=state.data.tradeDetails[m.index];if(!t)return '';
    const meta=instrumentFor(state.data,t.symbol,t.assetCategory);heading='成交详情';
    body=`<div class="detail-security"><div class="security-identity">${securityLabel(t.symbol,t.assetCategory,{name:meta.name})}</div><strong class="${t.side==='Buy'?'positive':'negative'}">${t.side==='Buy'?'买入':'卖出'}</strong></div>${detailGrid([['成交时间',t.dateTimeText||t.date],['币种',t.currency],['成交数量',number(Math.abs(t.quantity),Number.isInteger(t.quantity)?0:4)],['成交价格',number(t.price,4)],['成交款项',signed(t.proceeds)+' '+t.currency],['手续费',signed(t.commission)+' '+t.commissionCurrency],['已实现盈亏',signed(t.realizedPL)+' '+t.currency],['报表交易代码',t.code||'—']])}<p class="footnote">成交款项与手续费分开展示；已实现盈亏沿用 IBKR 口径，不再重复扣费。</p>`;
  } else if(m.kind==='symbol') {
    const meta=instrumentFor(state.data,m.symbol,m.assetCategory);heading=m.symbol;
    const trades=filterTrades(state.data,range(),{query:m.symbol}).filter(t=>t.symbol===m.symbol&&(!m.assetCategory||category(t.assetCategory)===category(m.assetCategory)));
    const position=state.data.positions.find(p=>p.symbol===m.symbol&&(!m.assetCategory||category(p.assetCategory)===category(m.assetCategory)));
    body=`<div class="detail-security"><span class="security-name">${meta.name!==m.symbol?esc(meta.name):''}</span>${securityTags(m.assetCategory||meta.assetCategory,position?.quantity<0)}${meta.exchange?`<span class="muted">${esc(meta.exchange)}</span>`:''}</div>${position?detailGrid([['持仓数量',number(position.quantity,Number.isInteger(position.quantity)?0:4)],['报表收盘价',number(position.closePrice,3)+' '+position.currency],['持仓市值',number(position.value)+' '+position.currency],['未实现盈亏',signed(position.unrealizedPL)+' '+position.currency]]):''}<h3>区间成交明细</h3><p class="muted">${dateText(range().start)} – ${dateText(range().end)}</p><div class="record-list">${trades.map(t=>`<button class="record-row" data-trade="${state.data.tradeDetails.indexOf(t)}"><span class="record-main"><strong class="${t.side==='Buy'?'positive':'negative'}">${t.side==='Buy'?'买入':'卖出'} ${number(Math.abs(t.quantity),Number.isInteger(t.quantity)?0:4)}</strong><span>${dateText(t.date)} ${esc(tradeClock(t))}</span></span><span class="record-right"><strong>${number(t.price,3)} ${esc(t.currency)}</strong><span>已实现 ${signed(t.realizedPL)}</span></span></button>`).join('')||empty('该期间没有成交记录')}</div>`;
  } else if(m.kind==='cash') {
    const t=cashRecords(state.data).find(t=>t.id===m.id);if(!t)return '';
    heading=t.title;body=(t.symbol?`<div class="detail-security"><div class="security-identity">${securityLabel(t.symbol)}</div></div>`:'')+detailGrid([['日期',dateText(t.date)],['类型',t.title],['币种',t.currency],['金额',signed(t.amount)],['说明',t.description||'—']]);
  } else {
    heading='数据与计算说明';
    const notes={
      performance:['盈亏金额的口径','图表、日历、分时段总结和排行榜使用股票及期权逐笔成交的已实现盈亏，不包含每日未实现盈亏变化。','报表时间加权收益率仅适用于报表整期；子区间不会复用该收益率。','盈亏百分比以报表期初资产与已识别净投入之和为固定基数；它是已实现盈亏占比，与上方时间加权账户收益率的口径不同。'],
      calendar:['收益日历','按报表成交日期汇总已实现盈亏。没有成交的日期保持空白。','股票及期权已实现盈亏已经计入相关佣金，不重复扣除。百分比按报表固定投入基数计算，不代表当日账户收益率。'],
      assets:['资产变动口径','期末 − 期初 − 已识别净投入 = 盈亏额。净投入包括出入金与股票赠与。','利息、佣金、税费等属于盈亏变动，不作为资金投入。未提供的资产转入转出不会用残差填充。'],
      cash:['资金记录','展示报表中的逐笔成交款项、关联手续费及可识别的出入金、利息、股息、税费。','手续费使用报表成交时间作为关联日期，不代表实际扣费结算时刻。各笔以其原始币种显示。'],
      orders:['成交查询','使用 Trades 中的 Order 记录。股票名称与交易所来自金融产品信息。','报表没有完整的委托状态历史，本页面只展示成交数量、成交价格、款项及手续费。']
    };
    const n=notes[m.info]||['报表数据','文件仅在当前浏览器中解析，不上传服务器；刷新页面后需重新导入。','所有价格及资产均为报表快照，非实时数据。跨币种统计沿用报表汇率，不代表逐笔历史汇率。'];
    body=`<h3>${n[0]}</h3>${n.slice(1).map(p=>`<p>${p}</p>`).join('')}${m.info==='data'?`<div class="detail-grid"><div class="detail-cell"><span>已识别区块</span><strong>${Object.keys(state.data.sectionStats).length}</strong></div><div class="detail-cell"><span>成交记录</span><strong>${state.data.tradeDetails.length}</strong></div></div><details><summary>查看解析区块</summary>${Object.entries(state.data.sectionStats).map(([k,v])=>`<div class="detail-line"><span>${esc(k)}</span><strong>${v}</strong></div>`).join('')}</details>${state.data.warnings.length?`<p class="notice">解析诊断：${state.data.warnings.map(esc).join('、')}</p>`:''}`:''}`;
  }
  return `<div class="dialog-backdrop" data-action="backdrop"><section class="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header><h2 id="dialog-title">${esc(heading)}</h2><button class="icon-button" data-action="close" aria-label="关闭详情">${icon('close')}</button></header>${body}</section></div>`;
}
function detailGrid(items) {return `<div class="detail-grid">${items.map(([k,v])=>`<div class="detail-cell"><span>${k}</span><strong>${esc(v)}</strong></div>`).join('')}</div>`;}

function navigate(page) {
  if(page==='orders'&&state.page==='calendar'&&state.selectedDay){state.dateFrom=state.selectedDay;state.dateTo=state.selectedDay;state.showFilters=true;}else{state.dateFrom='';state.dateTo='';}
  state.page=page;state.modal=null;state.search='';state.limit=40;state.asset='all';state.side='all';render();window.scrollTo?.({top:0,behavior:'instant'});
}
function parseText(text,name,demo=false) {
  try {
    if(!String(text||'').trim())throw new Error('没有可解析的内容，请先选择文件或粘贴 CSV。');
    const data=parseIbkrReport(text);
    if(!Object.keys(data.sectionStats).length)throw new Error('未识别到报表区块，请导入 IBKR Activity Statement CSV/TXT。');
    state.data=data;state.sourceName=name;state.demo=demo;state.error='';state.page='analysis';
    state.search='';state.range='year';state.chartMode='amount';state.chartDate=null;state.calendarMonth=reportRange(data).end?.slice(0,7)||'';state.selectedDay='';state.modal=null;state.limit=40;
    state.asset='all';state.side='all';state.currency='all';state.recordsPeriod='all';state.recordType='all';state.dateFrom='';state.dateTo='';state.showFilters=false;
  }catch(error){state.data=null;state.error=error.code==='missingExchangeRate'?`缺少 ${error.currency} 的本位币汇率。请导出包含汇率的报表后重新导入。`:error.code==='invalidCurrency'?'报表包含无效币种代码，请检查原始 CSV。':error.message||'报表解析失败，请检查文件格式。';}
  state.loading=false;render();
}
async function readFile(file) {
  if(!file)return;state.loading=true;state.error='';render();
  try{const decoded=decodeReportFile(await file.arrayBuffer());parseText(decoded.text,file.name,false);}catch{state.loading=false;state.error='文件读取失败，请重新选择 CSV/TXT 报表。';render();}
}
async function sample() {
  state.loading=true;state.error='';render();
  try{const response=await fetch('./samples/ibkr-sample-demo.csv');if(!response.ok)throw new Error();parseText(await response.text(),'ibkr-sample-demo.csv',true);}catch{state.loading=false;state.error='示例读取失败，请使用 npm run serve 启动本地服务。';render();}
}
function exportJson(){const url=URL.createObjectURL(new Blob([JSON.stringify(state.data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='ibkr-report.json';a.click();URL.revokeObjectURL(url);}
function changeMonth(delta) {
  const m=state.calendarMonth,[year,month]=m.split('-').map(Number),d=new Date(year,month-1+(state.calendarMode==='year'?12:1)*delta,1),rr=reportRange(state.data);
  const next=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  state.calendarMonth=next<(rr.start?.slice(0,7)||next)?rr.start.slice(0,7):next>(rr.end?.slice(0,7)||next)?rr.end.slice(0,7):next;state.selectedDay='';
}
app.addEventListener('click',event=>{
  const el=event.target.closest('button,[data-trade],[data-action]');if(!el)return;
  if(el.dataset.page){navigate(el.dataset.page);return;}
  if(el.dataset.set){state[el.dataset.set]=el.dataset.value;state.limit=40;if(el.dataset.set==='recordsPeriod'){state.dateFrom='';state.dateTo='';}render();return;}
  if(el.dataset.sort){state.holdDesc=state.holdSort===el.dataset.sort?!state.holdDesc:true;state.holdSort=el.dataset.sort;render();return;}
  if(el.dataset.symbol){if(!state.modal)state.focusReturn={key:'symbol',value:el.dataset.symbol};state.modal={kind:'symbol',symbol:el.dataset.symbol,assetCategory:el.dataset.category};render();return;}
  if(el.dataset.trade!==undefined){if(!state.modal)state.focusReturn={key:'trade',value:el.dataset.trade};state.modal={kind:'trade',index:Number(el.dataset.trade)};render();return;}
  if(el.dataset.cash){if(!state.modal)state.focusReturn={key:'cash',value:el.dataset.cash};state.modal={kind:'cash',id:el.dataset.cash};render();return;}
  if(el.dataset.day){state.selectedDay=el.dataset.day;render();return;}
  if(el.dataset.month){state.calendarMonth=el.dataset.month;state.calendarMode='month';state.selectedDay='';render();return;}
  const action=el.dataset.action;
  if(action==='day-orders'){state.dateFrom=state.selectedDay;state.dateTo=state.selectedDay;state.showFilters=true;state.page='orders';state.search='';state.limit=40;state.recordsPeriod='all';state.asset='all';state.side='all';}
  else if(action==='theme'){state.theme=state.theme==='dark'?'light':'dark';localStorage.setItem('ibkr-analytics-theme',state.theme);}
  else if(action==='choose'){app.querySelector('#fileInput')?.click();return;}
  else if(action==='sample'){sample();return;}
  else if(action==='parse'){parseText(app.querySelector('#pasteInput')?.value||'','粘贴的报表');return;}
  else if(action==='import'){state.data=null;state.error='';state.modal=null;}
  else if(action==='export'){exportJson();return;}
  else if(action==='info'){state.focusReturn={key:'info',value:el.dataset.info};state.modal={kind:'info',info:el.dataset.info};}
  else if(action==='close'){state.modal=null;}
  else if(action==='backdrop'){if(event.target!==el)return;state.modal=null;}
  else if(action==='filters'){state.showFilters=!state.showFilters;}
  else if(action==='clear-filters'){state.currency='all';state.asset='all';state.side='all';state.recordType='all';state.dateFrom='';state.dateTo='';state.recordsPeriod='all';state.search='';}
  else if(action==='more'){state.limit+=40;}
  else if(action==='prev-month'){changeMonth(-1);}
  else if(action==='next-month'){changeMonth(1);}
  else return;
  render();
});
app.addEventListener('change',event=>{const el=event.target;if(el.id==='fileInput'){readFile(el.files?.[0]);return;}if(el.dataset.change){state[el.dataset.change]=el.value;state.limit=40;render();}});
app.addEventListener('input',event=>{const el=event.target;if(!el.dataset.input)return;const key=el.dataset.input,start=el.selectionStart;state[key]=el.value;state.limit=40;render();const next=app.querySelector(`[data-input="${key}"]`);next?.focus();next?.setSelectionRange(start,start);});
app.addEventListener('dragover',event=>{const zone=event.target.closest('#dropzone');if(zone){event.preventDefault();zone.classList.add('dragging');}});
app.addEventListener('dragleave',event=>{event.target.closest('#dropzone')?.classList.remove('dragging');});
app.addEventListener('drop',event=>{if(event.target.closest('#dropzone')){event.preventDefault();readFile(event.dataTransfer?.files?.[0]);}});
app.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&state.modal){state.modal=null;render();return;}
  if(state.modal&&event.key==='Tab'){const els=[...app.querySelectorAll('[role="dialog"] button,[role="dialog"] input,[role="dialog"] summary')],first=els[0],last=els.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  if((event.key==='Enter'||event.key===' ')&&event.target.matches('tr[data-trade]')){event.preventDefault();state.modal={kind:'trade',index:Number(event.target.dataset.trade)};render();}
});
window.matchMedia?.('(max-width: 600px)')?.addEventListener?.('change',()=>{if(state.data&&state.page==='analysis')render();});
render();
if(new URLSearchParams(window.location.search).get('sample')==='1')sample();
