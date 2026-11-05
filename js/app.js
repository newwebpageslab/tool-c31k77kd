// 앱 진입점: 업로드·분석 진행, 필터, 탭 전환, 모듈 간 이벤트 연결

import { state, loadAll, save, on, emit, logHistory, APP_VERSION } from './store.js';
import { parseFile, buildDataset } from './parser.js';
import { computeAll, isSpecial, placeCoords } from './analysis.js';
import { loadKakao, isKakaoReady, geocodeAll, buildPlaces } from './geo.js';
import { MapView } from './mapview.js';
import { initPanel, openPanel, refreshPanel, closePanel, isPanelOpen, panelSource, setPanelNav } from './panel.js';
import { initBackTable, setDashboardRows, refreshFlagsInDashboard, renderEmployeeHead } from './dashboard.js';
import {
  initFlagsView, renderFlagsView, getFlagList, getFlagHits, initPlacesView, renderPlacesView, openPlaceEditor,
  initHistoryView, renderHistoryView, renderSettings, openHomeEditor, openExcludeEditor, NEED_CHECK,
} from './tabs.js';
import { requireUnlock } from './gate.js';
import { $, $$, esc, fmtNum, toast, initTooltips, weekdayKo, debounce, openModal, sleep } from './util.js';

const ui = {
  tab: 'dashboard', routeOn: true, routeDay: null, homeOn: true, geoBusy: false, analyzing: false, staged: [],
  flagRoute: null, // 특이건 지도에서 동선을 보여줄 { code, date }
  flagView: 'first', // 특이건 탭이 다음에 보일 때 적용할 지도 화면
};
const dashMap = new MapView('dash');
const flagMap = new MapView('flags');
const mapOf = (source) => (source === 'flags' ? flagMap : dashMap);
let fp = null;
// 진행률 화면이 그려질 틈을 주는 대기(rAF는 백그라운드 탭에서 멈추므로 타이머 사용)
const tick = () => new Promise((r) => setTimeout(r, 16));

/* ---------------- 필터 ---------------- */
function employeesFiltered() {
  const { gubun, team } = state.filter;
  return Object.values(state.dataset.employees)
    .filter((e) => (!gubun || e.gubun === gubun) && (!team || e.team === team))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.code.localeCompare(b.code));
}

function filteredRows() {
  if (!state.dataset) return [];
  const { code, from, to } = state.filter;
  const codes = new Set(code ? [code] : employeesFiltered().map((e) => e.code));
  return state.dataset.rows.filter((r) => codes.has(r.code) && (!from || r.date >= from) && (!to || r.date <= to));
}

function buildFilterOptions() {
  const emps = Object.values(state.dataset.employees);
  const f = state.filter;
  const gubuns = [...new Set(emps.map((e) => e.gubun).filter(Boolean))].sort();
  $('#fGubun').innerHTML = `<option value="">전체 구분</option>${gubuns.map((g) => `<option ${g === f.gubun ? 'selected' : ''}>${esc(g)}</option>`).join('')}`;
  const teams = [...new Set(emps.filter((e) => !f.gubun || e.gubun === f.gubun).map((e) => e.team).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  if (f.team && !teams.includes(f.team)) f.team = '';
  $('#fTeam').innerHTML = `<option value="">전체 팀</option>${teams.map((t) => `<option ${t === f.team ? 'selected' : ''}>${esc(t)}</option>`).join('')}`;
  const list = employeesFiltered();
  if (f.code && !list.some((e) => e.code === f.code)) f.code = '';
  // 동명이인이 있을 때만 사번을 덧붙여 구분
  const nameCount = {};
  for (const e of list) nameCount[e.name] = (nameCount[e.name] || 0) + 1;
  $('#fEmp').innerHTML = `<option value="">전체 사원</option>${list.map((e) => `<option value="${esc(e.code)}" ${e.code === f.code ? 'selected' : ''}>${esc(e.name)}${nameCount[e.name] > 1 ? ` (${esc(e.code)})` : ''}</option>`).join('')}`;
  const byCode = [...list].sort((a, b) => a.code.localeCompare(b.code, 'ko', { numeric: true }));
  // 사번을 찾지 못한 사원은 "사번 없음(이름)"으로 표시
  const codeLabel = (e) => (e.code.startsWith('시트:') ? `사번 없음 (${e.name})` : e.code);
  $('#fCode').innerHTML = `<option value="">전체 사번</option>${byCode.map((e) => `<option value="${esc(e.code)}" ${e.code === f.code ? 'selected' : ''}>${esc(codeLabel(e))}</option>`).join('')}`;
}

function bindFilters() {
  $('#fGubun').onchange = (e) => { state.filter.gubun = e.target.value; state.filter.team = ''; state.filter.code = ''; applyFilter(); };
  $('#fTeam').onchange = (e) => { state.filter.team = e.target.value; state.filter.code = ''; applyFilter(); };
  $('#fEmp').onchange = (e) => { state.filter.code = e.target.value; applyFilter(); };
  $('#fCode').onchange = (e) => { state.filter.code = e.target.value; applyFilter(); };
  $('#fReset').onclick = () => {
    state.filter = { gubun: '', team: '', code: '', from: '', to: '' };
    fp?.clear(false);
    applyFilter();
  };
  $('#datePresets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-from]');
    if (b) setDateRange(b.dataset.from, b.dataset.to);
  });
}

function setDateRange(from, to) {
  state.filter.from = from;
  state.filter.to = to;
  if (fp) {
    if (from) fp.setDate([from, to], false);
    else fp.clear(false);
  } else {
    $('#dFrom').value = from;
    $('#dTo').value = to;
  }
  applyFilter();
}

/** 선택된 기간 버튼 강조 */
function markPresets() {
  const { from, to } = state.filter;
  $$('#datePresets .chip').forEach((c) => c.classList.toggle('on', c.dataset.from === from && c.dataset.to === to));
}

/** flatpickr 연도 선택: 연도를 누르면 3×3 연도 타일 표시 */
function enhanceYearPicker(inst) {
  const years = new Set(state.dataset.rows.map((r) => Number(r.date.slice(0, 4))));
  const cm = inst.calendarContainer.querySelector('.flatpickr-current-month');
  if (!cm || cm.querySelector('.fp-year-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fp-year-btn';
  cm.appendChild(btn);
  const grid = document.createElement('div');
  grid.className = 'fp-year-grid';
  inst.calendarContainer.appendChild(grid);
  const draw = () => {
    const y = inst.currentYear;
    btn.textContent = `${y}년`;
    grid.innerHTML = Array.from({ length: 9 }, (_, i) => y - 4 + i)
      .map((v) => `<button type="button" class="fp-year ${v === y ? 'on' : ''} ${years.has(v) ? 'has' : ''}" data-y="${v}">${v}</button>`).join('');
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); draw(); grid.classList.toggle('show'); });
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('[data-y]');
    if (!b) return;
    e.stopPropagation();
    inst.changeYear(Number(b.dataset.y));
    grid.classList.remove('show');
    draw();
  });
  inst.config.onYearChange.push(draw);
  inst.config.onOpen.push(() => { grid.classList.remove('show'); draw(); });
  draw();
}

function initDatePicker() {
  const { min, max } = state.dataset.period;
  const host = $('#dateHost');
  fp?.destroy();
  fp = null;
  if (window.flatpickr) {
    host.innerHTML = '<input id="dateRange" class="input date-input" placeholder="점검 기간 선택" readonly>';
    fp = window.flatpickr('#dateRange', {
      mode: 'range', dateFormat: 'Y-m-d', locale: 'ko', monthSelectorType: 'dropdown',
      defaultDate: state.filter.from ? [state.filter.from, state.filter.to] : null,
      onReady: (_d, _s, inst) => enhanceYearPicker(inst),
      onClose(sel, _str, inst) {
        const fmt = (d) => inst.formatDate(d, 'Y-m-d');
        if (sel.length === 2) { state.filter.from = fmt(sel[0]); state.filter.to = fmt(sel[1]); }
        else if (sel.length === 1) { state.filter.from = state.filter.to = fmt(sel[0]); }
        else { state.filter.from = state.filter.to = ''; }
        applyFilter();
      },
    });
    if (!state.filter.from && min) fp.jumpToDate(min);
  } else {
    host.innerHTML = `<input type="date" id="dFrom" class="input" value="${state.filter.from}"> ~ <input type="date" id="dTo" class="input" value="${state.filter.to}">`;
    host.onchange = () => { state.filter.from = $('#dFrom').value; state.filter.to = $('#dTo').value; applyFilter(); };
  }
  const months = [...new Set(state.dataset.rows.map((r) => r.date.slice(0, 7)))].sort();
  const multiYear = new Set(months.map((m) => m.slice(0, 4))).size > 1;
  const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };
  $('#datePresets').innerHTML = `<button class="chip" data-from="" data-to="">전체 기간</button>${months.map((m) => `<button class="chip" data-from="${m}-01" data-to="${lastDay(m)}">${multiYear ? `${m.slice(2, 4)}년 ` : ''}${Number(m.slice(5))}월</button>`).join('')}`;
  markPresets();
}

function applyFilter() {
  buildFilterOptions();
  markPresets();
  ui.routeDay = null;
  ui.flagRoute = null;
  refresh({ fit: true });
}

/* ---------------- 화면 갱신 ---------------- */
function refresh({ fit = false } = {}) {
  if (!state.dataset) return;
  const rows = filteredRows();
  const code = state.filter.code || null;
  setDashboardRows(rows, code);
  updateMap(rows, code, fit);
  renderFlagsView(rows);
  if (fit) ui.flagView = 'first';
  if (ui.tab === 'flags') showFlagMap();
  renderPlacesView(rows);
  renderHistoryView();
  updateBadges(rows);
  updateContext(rows, code);
}

const refreshSoft = debounce(() => { if (ui.analyzing) return; computeAll(); refresh(); refreshPanel(); }, 250);

/** 대시보드 외 탭 상단의 현재 선택 범위 표시 */
function updateContext(rows, code) {
  const f = state.filter;
  const e = code ? state.dataset.employees[code] : null;
  const who = e ? `${e.name} (${e.code})` : f.team || f.gubun || '전체 사원';
  const range = f.from ? `${f.from} ~ ${f.to}` : '전체 기간';
  $$('[data-ctx]').forEach((el) => { el.innerHTML = `<span class="muted">선택 범위</span> <b>${esc(who)}</b> · ${esc(range)} · ${fmtNum(rows.length)}건`; });
}

function updateBadges(rows) {
  const special = rows.filter(isSpecial).length;
  $('#badgeFlags').textContent = special ? fmtNum(special) : '';
  const keys = new Set(rows.map((r) => r.placeKey));
  const need = buildPlaces().filter((p) => keys.has(p.key) && !p.excluded && NEED_CHECK.has(state.geo[p.key]?.status || 'pending')).length;
  $('#badgePlaces').textContent = need ? fmtNum(need) : '';
  $('#badgeHistory').textContent = state.history.length ? fmtNum(state.history.length) : '';
}

/* ---------------- 지도 ---------------- */
function updateMap(rows, code, fit) {
  const days = code ? [...new Set(rows.map((r) => r.date))].sort() : [];
  if (code && (!ui.routeDay || !days.includes(ui.routeDay))) ui.routeDay = days[0] || null;
  if (!code) ui.routeDay = null;

  const routeToggle = $('#routeToggle');
  routeToggle.disabled = !code;
  routeToggle.checked = ui.routeOn && !!code;
  $('#routeSwitch').dataset.tip = code ? '선택한 날의 방문 순서를 선으로 연결\n빨간 점선 = 이동불가 구간' : '사원을 선택하면 사용할 수 있습니다';
  const dayStats = new Map();
  for (const r of rows) {
    const d = dayStats.get(r.date) || { anom: 0, imp: 0 };
    if (r.anom) d.anom++;
    if (r.imp) d.imp++;
    dayStats.set(r.date, d);
  }
  $('#daySelect').innerHTML = days.map((d) => {
    const s = dayStats.get(d);
    const mark = s.imp ? ' ⛔' : s.anom ? ' ⚠' : '';
    return `<option value="${d}" ${d === ui.routeDay ? 'selected' : ''}>${d} (${weekdayKo(d)})${mark}</option>`;
  }).join('');
  $('#dayStep').hidden = !(code && ui.routeOn);
  $('#homeSwitch').hidden = !code;
  $('#homeToggle').checked = ui.homeOn;

  // 처음 화면: 가장 이른 날짜의 첫 콜 위치
  const summary = dashMap.render(rows, { code, view: fit ? 'first' : 'keep', routeOn: ui.routeOn && !!code, routeDay: ui.routeDay, homeOn: ui.homeOn });
  $('#mapStatus').innerHTML = mapNotes(dashMap, summary);

  const rs = ui.routeOn && code ? dashMap.routeSummary() : null;
  $('#routeInfo').innerHTML = rs ? `
    <span>기록 <b>${rs.total}</b>건</span>
    <span>이상 자릿수 <b class="${rs.anom ? 'txt-warn' : ''}">${rs.anom}</b></span>
    <span>이동불가 <b class="${rs.imp ? 'txt-danger' : ''}">${rs.imp}</b></span>
    <span>이동거리 <b>${fmtNum(rs.km, 1)}km</b></span>
    ${rs.noCoord ? `<span class="muted">좌표 미확정 ${rs.noCoord}건 제외</span>` : ''}
    <button class="btn btn-sm" id="openDay">방문 내역 열기</button>` : '';
}

function bindMapToolbar() {
  $('#routeToggle').onchange = (e) => { ui.routeOn = e.target.checked; refreshMapOnly(true); };
  $('#homeToggle').onchange = (e) => { ui.homeOn = e.target.checked; refreshMapOnly(false); };
  $('#daySelect').onchange = (e) => { ui.routeDay = e.target.value; refreshMapOnly(true); };
  const step = (dir) => {
    const opts = $$('#daySelect option').map((o) => o.value);
    const i = opts.indexOf(ui.routeDay) + dir;
    if (i >= 0 && i < opts.length) { ui.routeDay = opts[i]; refreshMapOnly(true); }
  };
  $('#dayPrev').onclick = () => step(-1);
  $('#dayNext').onclick = () => step(1);
  $('#mapFit').onclick = () => dashMap.fit();
  $('#mapCard').addEventListener('click', (e) => {
    if (e.target.closest('#openDay')) openPanel({ code: state.filter.code, date: ui.routeDay });
  });
  $('#flagMapFit').onclick = () => flagMap.fit();
  $('#flagMapReset').onclick = () => { ui.flagRoute = null; renderFlagMap('first'); };
}

function refreshMapOnly(fit) {
  updateMap(filteredRows(), state.filter.code || null, fit);
}

function mapNotes(view, summary) {
  const notes = [];
  if (!view.ready) notes.push(state.kakaoKey ? '지도 연결 중' : '카카오 키 필요');
  notes.push(`표시 ${fmtNum(summary.places)}곳`);
  if (summary.unresolved.size) notes.push(`<button class="link warn" data-goto="places">좌표 미확정 ${fmtNum(summary.unresolved.size)}곳</button>`);
  if (summary.excluded.size) notes.push(`<span data-tip="위치 제외 키워드 포함 거래처">위치 제외 ${fmtNum(summary.excluded.size)}곳</span>`);
  return notes.join(' · ');
}

/** 특이건 지도: 기본은 특이건 위치, 표에서 기록을 누르면 그날 동선 */
function renderFlagMap(view = 'keep') {
  if (!state.dataset) return;
  const list = getFlagList();
  const route = ui.flagRoute;
  let summary;
  if (route) {
    const rows = filteredRows().filter((r) => r.code === route.code && r.date === route.date);
    summary = flagMap.render(rows, { code: route.code, routeOn: true, routeDay: route.date, homeOn: true, view });
    const e = state.dataset.employees[route.code];
    $('#flagMapTitle').textContent = `${e?.name || route.code} · ${route.date}(${weekdayKo(route.date)}) 동선`;
  } else {
    summary = flagMap.render(list, { code: null, routeOn: false, view, firstRows: list.filter(isSpecial) });
    $('#flagMapTitle').textContent = '특이건 위치';
  }
  $('#flagMapReset').hidden = !route;
  $('#flagMapStatus').innerHTML = mapNotes(flagMap, summary);
}

/** 카카오 SDK 로드 + 지도 생성(실패 시 안내 표시) */
async function connectKakao() {
  const empties = [$('#mapEmpty'), $('#flagMapEmpty')];
  const show = (html) => empties.forEach((el) => { el.hidden = !html; if (html) el.innerHTML = html; });
  if (!state.kakaoKey) {
    show('<div><b>카카오 JavaScript 키가 필요합니다</b><p>설정에서 한 번 입력하면 저장됩니다.</p><button class="btn btn-primary" data-goto="settings">설정으로 이동</button></div>');
    return false;
  }
  show('<div><span class="spinner"></span> 지도 연결 중</div>');
  try {
    await loadKakao(state.kakaoKey);
    show('');
    if (!dashMap.ready) dashMap.init($('#map'));
    if (!flagMap.ready) flagMap.init($('#flagMap'));
    renderSettings();
    return true;
  } catch (err) {
    show(`<div><b>카카오 지도를 불러오지 못했습니다</b><p>${esc(err.message)}</p><button class="btn" data-goto="settings">설정 확인</button></div>`);
    return false;
  }
}

async function runGeocode({ force, onProgress } = {}) {
  if (!isKakaoReady()) { if (!onProgress) toast('카카오 지도가 연결된 후 실행할 수 있습니다.', 'warn'); return; }
  if (ui.geoBusy) return;
  ui.geoBusy = true;
  const pill = $('#geoProgress');
  try {
    await geocodeAll({
      force,
      onProgress: (done, total) => {
        onProgress?.(done, total);
        if (ui.analyzing) return;
        pill.hidden = total === 0 || done >= total;
        pill.innerHTML = `<span class="spinner"></span> 위치 확인 ${done}/${total}`;
      },
    });
  } finally {
    ui.geoBusy = false;
    pill.hidden = true;
  }
}

/* ---------------- 탭 ---------------- */
function switchTab(tab) {
  ui.tab = tab;
  $$('.tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on);
  });
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${tab}`; });
  if (tab !== 'dashboard') closePanelIfNeeded();
  if (tab === 'dashboard') setTimeout(() => dashMap.relayout(), 0);
  // 다른 화면에서 연 패널은 닫음(패널 클릭이 엉뚱한 지도로 가지 않도록)
  const src = panelSource();
  if (src && ((tab === 'dashboard' && src === 'flags') || (tab === 'flags' && src === 'dash'))) closePanel();
  if (tab === 'flags') {
    // 숨겨져 있던 지도는 크기를 다시 계산한 뒤 그려야 위치가 맞음
    setTimeout(() => { flagMap.relayout(); showFlagMap(); }, 0);
  }
  window.scrollTo({ top: 0 });
}

/** 특이건 탭 지도 갱신. 처음 화면이면 첫 특이건 날짜로 패널을 열고 그 위치를 보여줌 */
function showFlagMap() {
  const first = ui.flagView === 'first';
  ui.flagView = 'keep';
  if (!first) { renderFlagMap('keep'); return; }
  ui.flagRoute = null;
  const hit = [...getFlagHits()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.code.localeCompare(b.code) || a.dayIndex - b.dayIndex))[0];
  renderFlagMap('first');
  if (hit) emit('open-panel', { code: hit.code, date: hit.date, focusKey: hit.placeKey, focusRowId: hit.id, source: 'flags' });
}

/** 패널 날짜 이동 대상: 특이건(또는 필터 결과)이 있는 날짜 */
function navDays(source) {
  const rows = source === 'flags' ? getFlagHits() : filteredRows().filter(isSpecial);
  const seen = new Map();
  for (const r of rows) seen.set(`${r.date}|${r.code}`, { code: r.code, date: r.date });
  return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
}

function closePanelIfNeeded() {
  if (ui.tab === 'upload' || ui.tab === 'settings') closePanel();
}

function bindTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (t) switchTab(t.dataset.tab);
  });
  document.body.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) switchTab(go.dataset.goto);
  });
}

/* ---------------- 업로드 → 분석 시작 ---------------- */
function showUpload() {
  renderStaged();
  switchTab('upload');
}

function stageFiles(fileList) {
  const files = [...fileList].filter((f) => /\.(xlsx|xlsm|xls)$/i.test(f.name));
  if (fileList.length && !files.length) { toast('엑셀 파일(.xlsx)만 추가할 수 있습니다.', 'error'); return; }
  for (const f of files) {
    if (!ui.staged.some((s) => s.name === f.name && s.size === f.size)) ui.staged.push(f);
  }
  if (ui.tab !== 'upload') switchTab('upload');
  renderStaged();
}

function renderStaged() {
  const list = $('#stagedList');
  list.innerHTML = ui.staged.map((f, i) => `
    <li><span class="file-ico" aria-hidden="true">XLS</span><span class="file-name" title="${esc(f.name)}">${esc(f.name)}</span>
    <span class="muted small">${fmtNum(f.size / 1024, 0)}KB</span><button class="icon-btn" data-unstage="${i}" aria-label="${esc(f.name)} 제외">✕</button></li>`).join('');
  list.hidden = !ui.staged.length;
  $('#startAnalysis').disabled = !ui.staged.length;
  $('#startAnalysis').textContent = ui.staged.length ? `분석 시작 (${ui.staged.length}개 파일)` : '분석 시작';
  $('#appendWrap').hidden = !state.dataset;
  $('#cancelUpload').hidden = !state.dataset;
}

function setProgress(pct, step) {
  const p = Math.max(0, Math.min(100, pct));
  const ring = $('#loaderRing');
  const len = 2 * Math.PI * 52;
  ring.style.strokeDasharray = `${len}`;
  ring.style.strokeDashoffset = `${len * (1 - p / 100)}`;
  $('#loaderPct').textContent = `${Math.round(p)}%`;
  if (step) $('#loaderStep').textContent = step;
}

function showLoader(show) {
  $('#loader').hidden = !show;
  document.body.classList.toggle('loading', show);
}

async function startAnalysis() {
  const files = [...ui.staged];
  if (!files.length || ui.analyzing) return;
  const append = !!state.dataset && $('#appendMode').checked;
  ui.analyzing = true;
  closePanel();
  showLoader(true);
  setProgress(0, '파일 읽는 중');
  try {
    const parts = [];
    const failed = [];
    for (let i = 0; i < files.length; i++) {
      setProgress(3 + (i / files.length) * 37, `파일 읽는 중 (${i + 1}/${files.length})`);
      await tick();
      try {
        const wb = XLSX.read(new Uint8Array(await files[i].arrayBuffer()), { type: 'array' });
        parts.push(parseFile(wb, files[i].name));
      } catch (e) {
        failed.push(`${files[i].name}: ${e.message}`);
      }
    }
    setProgress(42, '데이터 취합 중');
    await tick();
    const ds = buildDataset(parts, append ? state.dataset : null);
    ds.warnings.unshift(...failed.map((f) => `읽기 실패 — ${f}`));
    if (!ds.rows.length) {
      showLoader(false);
      openModal({ title: '분석할 데이터가 없습니다', body: `<ul class="warn-list">${(ds.warnings.length ? ds.warnings : ['사원별 시트에서 콜·법카 내역을 찾지 못했습니다.']).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`, actions: [{ label: '확인', kind: 'primary', onClick: (c) => c() }] });
      return;
    }
    state.dataset = ds;
    state.filter = { gubun: '', team: '', code: '', from: '', to: '' };
    save('dataset');
    logHistory('데이터 업로드', files.map((f) => f.name).join(', '), append ? '추가' : '', `${Object.keys(ds.employees).length}명 · ${ds.rows.length}건 (${ds.period.min} ~ ${ds.period.max})`);

    setProgress(52, '지표 계산 중');
    await tick();
    computeAll();

    if (state.kakaoKey) {
      setProgress(58, '지도 연결 중');
      await connectKakao();
    }
    if (isKakaoReady()) {
      await runGeocode({
        force: false,
        onProgress: (d, t) => setProgress(60 + (t ? d / t : 1) * 34, t ? `거래처 위치 확인 중 (${d}/${t})` : '거래처 위치 확인 완료'),
      });
      computeAll();
    }
    setProgress(96, '화면 구성 중');
    await tick();
    ui.staged = [];
    onDataset();
    switchTab('dashboard');
    setProgress(100, '완료');
    await sleep(350);
    showLoader(false);
    if (ds.warnings.length) {
      openModal({ title: '확인이 필요한 항목', body: `<ul class="warn-list">${ds.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`, actions: [{ label: '확인', kind: 'primary', onClick: (c) => c() }] });
    }
  } catch (e) {
    console.error(e);
    showLoader(false);
    toast(`분석 중 오류가 발생했습니다: ${e.message}`, 'error', 6000);
  } finally {
    ui.analyzing = false;
    showLoader(false);
  }
}

function bindUpload() {
  $('#openUpload').onclick = showUpload;
  $('#fileInput').onchange = (e) => { stageFiles(e.target.files); e.target.value = ''; };
  $('#stagedList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unstage]');
    if (!b) return;
    ui.staged.splice(Number(b.dataset.unstage), 1);
    renderStaged();
  });
  $('#startAnalysis').onclick = startAnalysis;
  $('#cancelUpload').onclick = () => { ui.staged = []; switchTab('dashboard'); };
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    if (!ui.analyzing && e.dataTransfer?.files?.length) stageFiles(e.dataTransfer.files);
  });
}

function onDataset() {
  computeAll();
  $$('.needs-data').forEach((el) => el.removeAttribute('hidden'));
  const ds = state.dataset;
  $('#dataMeta').textContent = `${ds.fileName} 분석 결과`;
  $('#dataMeta').title = (ds.fileNames || [ds.fileName]).join('\n');
  buildFilterOptions();
  initDatePicker();
  refresh({ fit: true });
}

/* ---------------- 패널이 열려도 본문 너비는 그대로, 왼쪽으로 이동 ---------------- */
function updateShift() {
  const main = $('main');
  const vw = document.documentElement.clientWidth;
  if (!isPanelOpen() || vw < 900) { document.documentElement.style.setProperty('--shift', '0px'); return; }
  const w = main.offsetWidth;
  const left = (vw - w) / 2;
  const panelW = $('#panel').offsetWidth + 20;
  const target = Math.max(16, Math.min(left, vw - panelW - 16 - w));
  document.documentElement.style.setProperty('--shift', `${-(left - target)}px`);
}

/* ---------------- 이벤트 연결 ---------------- */
function bindBus() {
  on('open-panel', (d) => {
    const source = d.source || (ui.tab === 'flags' ? 'flags' : 'dash');
    openPanel({ ...d, source });
    const code = d.code || null;
    if (source === 'flags') {
      // 특이건 탭에서 누르면 항상 특이건 지도에서 그날 동선을 보여줌
      if (code && d.date && (ui.flagRoute?.code !== code || ui.flagRoute?.date !== d.date)) {
        ui.flagRoute = { code, date: d.date };
        renderFlagMap('keep');
      }
      if (d.focusKey) flagMap.focus(d.focusKey);
      return;
    }
    if (code && code === state.filter.code && d.date && ui.routeOn && d.date !== ui.routeDay) {
      ui.routeDay = d.date;
      refreshMapOnly(false);
    }
    if (d.locate && d.focusKey && ui.tab === 'dashboard') dashMap.focus(d.focusKey);
  });
  on('panel-day', ({ code, date, source, focusKey }) => {
    if (source === 'flags') {
      ui.flagRoute = { code, date };
      renderFlagMap('first');
      if (focusKey) flagMap.focus(focusKey);
      return;
    }
    if (code === state.filter.code && ui.routeOn) {
      ui.routeDay = date;
      refreshMapOnly(true);
      if (focusKey) dashMap.focus(focusKey);
    }
  });
  on('focus-place', ({ key, source }) => {
    if (!placeCoords(key)) { toast('좌표가 확정되지 않은 거래처입니다.', 'warn'); return; }
    const target = source === 'flags' ? 'flags' : 'dashboard';
    if (ui.tab !== target) switchTab(target);
    const card = $(target === 'flags' ? '#flagMapCard' : '#mapCard').getBoundingClientRect();
    if (card.bottom < 120 || card.top > window.innerHeight - 120) $(target === 'flags' ? '#flagMapCard' : '#mapCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => mapOf(source).focus(key), 150);
  });
  on('toggle-fav', (row) => {
    if (state.favs[row.id]) delete state.favs[row.id];
    else state.favs[row.id] = true;
    save('favs');
    refreshFlagsInDashboard();
    renderFlagsView(filteredRows());
    if (ui.tab === 'flags') renderFlagMap('keep');
    refreshPanel();
    updateBadges(filteredRows());
  });
  on('flag-list-changed', () => renderFlagMap('first'));
  on('exclude-place', ({ name }) => openExcludeEditor(name));
  on('edit-place', (key) => openPlaceEditor(key));
  on('edit-home', (code) => openHomeEditor(code));
  on('home-changed', () => { renderEmployeeHead(state.filter.code || null, filteredRows()); refreshMapOnly(true); refreshPanel(); });
  on('geo-updated', () => refreshSoft());
  on('settings-changed', () => refreshSoft());
  on('select-employee', (code) => {
    state.filter.gubun = '';
    state.filter.team = '';
    state.filter.code = state.dataset.employees[code] ? code : '';
    switchTab('dashboard');
    applyFilter();
  });
  on('goto-tab', (t) => switchTab(t));
  on('run-geocode', (o) => runGeocode(o).then(() => refreshSoft()));
  on('history-changed', () => { if (state.dataset) { renderHistoryView(); $('#badgeHistory').textContent = state.history.length ? fmtNum(state.history.length) : ''; } });
  on('kakao-key', async ({ changed }) => {
    if (isKakaoReady() && changed) { toast('새 키는 페이지를 새로고침하면 적용됩니다.', 'info', 5000); return; }
    if (await connectKakao() && state.dataset) { refresh({ fit: true }); runGeocode({ force: false }); }
  });
}

/* ---------------- 시작 ---------------- */
async function init() {
  await requireUnlock(); // 비밀번호를 확인하기 전에는 저장된 데이터를 읽지 않음
  const topbar = $('.topbar');
  new ResizeObserver(() => document.documentElement.style.setProperty('--header-h', `${topbar.offsetHeight}px`)).observe(topbar);
  new MutationObserver(updateShift).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', debounce(updateShift, 100));
  initTooltips();
  initPanel();
  setPanelNav(navDays);
  await loadAll();
  $('#appVersion').textContent = `v${APP_VERSION}`;
  bindTabs();
  bindUpload();
  bindFilters();
  bindMapToolbar();
  initBackTable();
  initFlagsView();
  initPlacesView();
  initHistoryView();
  renderSettings();
  bindBus();
  if (state.dataset) {
    onDataset();
    switchTab('dashboard');
  } else showUpload();
  if (await connectKakao() && state.dataset) {
    refresh({ fit: true });
    runGeocode({ force: false });
  }
}

// 개발·점검용: 콘솔에서 File 객체 목록으로 분석 실행
window.__gpsMonitor = { stageFiles, startAnalysis, state, maps: { dashMap, flagMap }, refresh: () => refresh({ fit: true }), switchTab };

init();
