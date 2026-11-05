// 탭 화면: 특이건 목록, 위치 관리(좌표·주소 수정), 수정 이력, 설정 + 집 위치 모달

import { state, save, saveSettings, saveKakaoKey, logHistory, emit, exportWorkState, importWorkState, deleteStored, DEFAULT_SETTINGS } from './store.js';
import { isSpecial, isFav, reasonsOf, placeCoords, excludeKeywordsOf } from './analysis.js';
import { buildPlaces, searchCandidates, addressSearch, keywordSearch, isKakaoReady, GEO_LABEL } from './geo.js';
import { normSido } from './parser.js';
import { DataTable } from './table.js';
import { $, esc, fmtNum, weekdayKo, exportXlsx, openModal, confirmDialog, toast, downloadBlob, infoIcon, lngDiffKm } from './util.js';
import { lockNow } from './gate.js';

/* =========================================================
   특이건 목록
   ========================================================= */
let flagTable = null;
let flagRowsCache = [];
let flagList = []; // 현재 표에 보이는 기록(지도와 공유)

const FLAG_FILTERS = {
  all: (r) => isSpecial(r) || isFav(r),
  fl: (r) => isSpecial(r) && !!r.fl,
  imp: (r) => r.imp,
  fav: isFav,
};

let flagHits = []; // 필터에 해당하는 특이건(일자 전체 확장 전)
export const getFlagList = () => flagList;
export const getFlagHits = () => flagHits;

export function initFlagsView() {
  flagTable = new DataTable($('#flagTable'), {
    pageSize: 100,
    emptyText: '해당하는 기록이 없습니다.',
    rowClass: (r) => `${r.imp ? 'row-imp' : r.anom ? 'row-anom' : ''} ${$('#flagDayAll').checked && !isSpecial(r) && !isFav(r) ? 'row-context' : ''}`,
    onRowClick: (r) => emit('open-panel', { code: r.code, date: r.date, focusKey: r.placeKey, focusRowId: r.id, locate: true, source: 'flags' }),
    onAction: (act, r) => { if (act === 'fav') emit('toggle-fav', r); },
    columns: [
      { key: 'fav', label: '★', align: 'center', value: (r) => (isFav(r) ? 1 : 0), html: (r) => `<button class="flag-btn sm ${isFav(r) ? 'on' : ''}" data-action="fav" aria-label="즐겨찾기">★</button>` },
      { key: 'name', label: '사원명', html: (r) => `<b>${esc(state.dataset.employees[r.code]?.name || r.name)}</b>` },
      { key: 'team', label: '팀명', html: (r) => esc(state.dataset.employees[r.code]?.team || r.team) },
      { key: 'date', label: '일자', html: (r) => `${esc(r.date)} <span class="muted small">${weekdayKo(r.date)}</span>` },
      { key: 'sec', label: '시간', html: (r) => esc(r.time) },
      { key: 'type', label: '구분', html: (r) => (r.type === '법카' ? '법인카드' : 'GPS CALL') },
      { key: 'place', label: '거래처명', width: 160, cls: 'cell-wrap' },
      { key: 'region', label: '주소' },
      { key: 'digits', label: '자릿수', html: (r) => (r.digits ? `<span class="badge ${r.anom ? 'badge-orange' : 'badge-blue'}">${esc(r.digits)}</span>` : '-') },
      { key: 'fl', label: '첫/막콜', html: (r) => (r.fl ? `<span class="badge badge-purple">${esc(r.fl)}</span>` : '') },
      { key: 'speed', label: '이동속도', align: 'right', value: (r) => (r.speed == null ? null : Number.isFinite(r.speed) ? r.speed : 1e9), html: (r) => (r.speed == null ? '' : `<span class="${r.imp ? 'txt-danger strong' : ''}">${Number.isFinite(r.speed) ? fmtNum(r.speed, 0) : '∞'}</span>`) },
      { key: 'reason', label: '판정', value: (r) => reasonsOf(r).join(','), html: (r) => reasonsOf(r).map((x) => `<span class="badge ${/불가|중복/.test(x) ? 'badge-red' : x === '위치제외' ? 'badge-gray' : 'badge-orange'}">${esc(x)}</span>`).join(' ') },
      { key: 'memo', label: '비고', width: 220, sortable: false, html: (r) => `<input class="input input-sm memo" data-memo="${esc(r.id)}" value="${esc(state.memos[r.id] || '')}" placeholder="비고 입력">` },
    ],
  });
  $('#flagTable').addEventListener('change', (e) => {
    const id = e.target.dataset.memo;
    if (!id) return;
    const v = e.target.value.trim();
    if (v) state.memos[id] = v;
    else delete state.memos[id];
    save('memos');
    toast('비고를 저장했습니다.', 'ok', 1600);
  });
  $('#flagExport').addEventListener('click', exportFlags);
  $('#flagGroupBy').addEventListener('change', () => { renderFlagsView(flagRowsCache); emit('flag-list-changed'); });
  $('#flagDayAll').addEventListener('change', () => { renderFlagsView(flagRowsCache); emit('flag-list-changed'); });
}

export function renderFlagsView(rows) {
  flagRowsCache = rows;
  const special = rows.filter(isSpecial);
  const favs = rows.filter(isFav);
  const fn = FLAG_FILTERS[$('#flagGroupBy').value] || FLAG_FILTERS.all;
  const hits = rows.filter(fn);
  flagHits = hits;
  // "해당 일자 전체" 켜면: 특이건이 있는 날(사원·일자)의 전체 기록을 함께 표시
  if ($('#flagDayAll').checked) {
    const days = new Set(hits.map((r) => `${r.code}|${r.date}`));
    flagList = rows.filter((r) => days.has(`${r.code}|${r.date}`));
  } else flagList = hits;
  const byEmp = new Map();
  for (const r of special) byEmp.set(r.code, (byEmp.get(r.code) || 0) + 1);
  $('#flagSummary').innerHTML = `
    <span class="pill">특이건 <b>${fmtNum(special.length)}</b></span>
    <span class="pill">★ 즐겨찾기 <b>${fmtNum(favs.length)}</b></span>
    ${byEmp.size > 1 ? [...byEmp.entries()].map(([c, n]) => `<button class="pill pill-btn" data-emp="${esc(c)}">${esc(state.dataset.employees[c]?.name || c)} <b>${n}</b></button>`).join('') : ''}`;
  $('#flagSummary').onclick = (e) => {
    const b = e.target.closest('[data-emp]');
    if (b) emit('select-employee', b.dataset.emp);
  };
  flagTable.setRows(flagList, { keepPage: true });
}

function exportFlags() {
  const rows = flagList;
  if (!rows.length) { toast('내보낼 기록이 없습니다.', 'warn'); return; }
  // 보고서 표 형식: 구분 / 일자 / 시간 / 거래처명 / 주소 / X좌표 자릿수 / Y좌표 자릿수
  const head = ['사원코드', '팀명', '사원명', '구분', '일자', '시간', '거래처명', '주소', 'X좌표 자릿수', 'Y좌표 자릿수', '첫/막콜', '이동거리(km)', '이동속도(km/h)', '판정', '특이건', '즐겨찾기', '비고'];
  const data = rows.map((r) => {
    const e = state.dataset.employees[r.code];
    return [
      r.code, e?.team || r.team, e?.name || r.name, r.type === '법카' ? '법인카드' : 'GPS CALL', r.date, r.time.slice(0, 5), r.place,
      [r.sidoN, r.sggN].filter(Boolean).join(' '), r.digits || '-', r.digits || '-', r.fl,
      r.dist != null ? Math.round(r.dist * 10) / 10 : '', r.speed == null ? '' : Number.isFinite(r.speed) ? Math.round(r.speed) : '∞',
      reasonsOf(r).join(', '), isSpecial(r) ? 'Y' : '', isFav(r) ? 'Y' : '', state.memos[r.id] || '',
    ];
  });
  exportXlsx(`GPS콜_특이건_${new Date().toISOString().slice(0, 10)}.xlsx`, [{ name: '특이건', rows: [head, ...data] }]);
}

/* =========================================================
   위치 관리
   ========================================================= */
let placeTable = null;
let placeFilter = 'all';
let placeSearch = '';
let placeRows = []; // 상단 선택 범위의 기록
let placeList = []; // 현재 표에 보이는 거래처
let placeAll = []; // 선택 범위의 거래처 전체
const placeSel = new Set();

// 화면 항목(칩) → 세부 상태. 세부 상태는 표의 상태 칸에 그대로 표시
export const NEED_CHECK = new Set(['ambiguous', 'notfound', 'error', 'pending']);
const AUTO_SET = new Set(['auto', 'gps']);
const PLACE_FILTERS = {
  all: () => true,
  need: (s) => NEED_CHECK.has(s),
  auto: (s) => AUTO_SET.has(s),
  manual: (s) => s === 'manual',
  excluded: (s) => s === 'excluded',
};

const statusOf = (p) => (p.excluded ? 'excluded' : state.geo[p.key]?.status || 'pending');
const placeLabel = (p) => `${p.name} (${[p.sidoN, p.sggN].filter(Boolean).join(' ')})`;

function updateSelUi() {
  const n = placeSel.size;
  const selected = placeAll.filter((p) => placeSel.has(p.key));
  $('#placeSelCount').textContent = `${fmtNum(n)}곳 선택`;
  $('#placeBulkNearest').disabled = !n;
  $('#placeBulkExclude').disabled = !selected.some((p) => !p.excluded);
  $('#placeBulkInclude').disabled = !selected.some((p) => p.excluded);
  const all = $('#placeSelAll');
  all.checked = placeList.length > 0 && placeList.every((p) => placeSel.has(p.key));
  all.indeterminate = !all.checked && placeList.some((p) => placeSel.has(p.key));
}

export function initPlacesView() {
  placeTable = new DataTable($('#placeTable'), {
    pageSize: 100,
    emptyText: '선택 범위에 거래처가 없습니다.',
    onRowClick: (p) => openPlaceEditor(p.key),
    onAction: (act, p, el) => {
      if (act === 'edit') openPlaceEditor(p.key);
      if (act === 'sel') {
        if (el.checked) placeSel.add(p.key);
        else placeSel.delete(p.key);
        updateSelUi();
      }
    },
    columns: [
      { key: 'sel', label: '선택', sortable: false, align: 'center', html: (p) => `<input type="checkbox" class="row-check" data-action="sel" ${placeSel.has(p.key) ? 'checked' : ''} aria-label="${esc(p.name)} 선택">` },
      { key: 'status', label: '상태', value: statusOf, html: (p) => `<span class="badge geo-${statusOf(p)}">${GEO_LABEL[statusOf(p)]}</span>` },
      { key: 'name', label: '거래처명', width: 180, cls: 'cell-wrap', html: (p) => `<b>${esc(p.name)}</b>` },
      { key: 'type', label: '구분' },
      { key: 'region', label: '시도·시군구', value: (p) => `${p.sidoN} ${p.sggN}`, html: (p) => `${esc([p.sidoN, p.sggN].filter(Boolean).join(' ') || '-')}${state.placeEdits[p.key]?.sido != null || state.placeEdits[p.key]?.sigungu != null ? ' <span class="badge badge-purple">수정</span>' : ''}${p.regionInferred ? ' <span class="badge badge-gray">보완</span>' : ''}` },
      { key: 'addr', label: '매칭 주소', width: 200, cls: 'cell-wrap', value: (p) => state.geo[p.key]?.addr, html: (p) => `${esc(state.geo[p.key]?.matchName || '')}<br><span class="muted small">${esc(state.geo[p.key]?.addr || '')}</span>` },
      { key: 'lat', label: 'Y(위도)', align: 'right', value: (p) => placeCoords(p.key)?.lat, html: (p) => `<span class="mono">${placeCoords(p.key)?.lat?.toFixed(6) ?? ''}</span>` },
      { key: 'lng', label: 'X(경도)', align: 'right', value: (p) => placeCoords(p.key)?.lng, html: (p) => `<span class="mono">${placeCoords(p.key)?.lng?.toFixed(6) ?? ''}</span>` },
      { key: 'visits', label: '방문', align: 'right' },
      { key: 'emp', label: '사원', value: (p) => [...p.names].join(','), html: (p) => esc([...p.names].join(', ')) },
      { key: 'edit', label: '', sortable: false, html: () => '<button class="btn btn-sm" data-action="edit">수정</button>' },
    ],
  });
  $('#placeChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pf]');
    if (!b) return;
    placeFilter = b.dataset.pf;
    renderPlacesView();
  });
  let t;
  $('#placeSearch').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { placeSearch = e.target.value.trim(); renderPlacesView(); }, 200);
  });
  $('#placeRegeocode').addEventListener('click', () => emit('run-geocode', { force: true }));
  $('#placeSelAll').addEventListener('change', (e) => {
    for (const p of placeList) {
      if (e.target.checked) placeSel.add(p.key);
      else placeSel.delete(p.key);
    }
    placeTable.render();
    updateSelUi();
  });
  $('#placeBulkNearest').addEventListener('click', () => bulkNearest([...placeSel]));
  $('#placeBulkExclude').addEventListener('click', () => bulkExclude(true));
  $('#placeBulkInclude').addEventListener('click', () => bulkExclude(false));
}

/** 선택한 거래처를 위치제외로 일괄 지정(on) 또는 해제. 지정·해제 모두 수정 이력에 기록 */
function bulkExclude(on) {
  const places = placeAll.filter((p) => placeSel.has(p.key));
  const keywordOnly = [];
  let done = 0;
  for (const p of places) {
    const direct = !!state.placeExcludes[p.key];
    if (on && !p.excluded) {
      state.placeExcludes[p.key] = true;
      logHistory('거래처 위치제외', placeLabel(p), '', '지정', '위치 관리 일괄 지정');
      done++;
    }
    if (!on && direct) {
      delete state.placeExcludes[p.key];
      logHistory('거래처 위치제외', placeLabel(p), '지정', '해제', '위치 관리 일괄 해제');
      done++;
    }
    if (!on && excludeKeywordsOf(p.name).length) keywordOnly.push(`${p.name} — 키워드 "${excludeKeywordsOf(p.name).join(', ')}"`);
  }
  placeSel.clear();
  save('placeExcludes');
  emit('settings-changed');
  if (keywordOnly.length) {
    openModal({
      title: `${fmtNum(done)}곳 해제 · ${fmtNum(keywordOnly.length)}곳은 키워드로 제외 중`,
      body: `<p class="small muted">아래 거래처는 위치 제외 키워드에 해당합니다. 해제하려면 설정에서 키워드를 삭제하세요.</p><ul class="warn-list">${keywordOnly.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`,
      actions: [{ label: '확인', kind: 'primary', onClick: (c) => c() }],
    });
  } else toast(`${fmtNum(done)}곳을 위치제외${on ? '로 지정' : '에서 해제'}했습니다.`, 'ok');
}

export function renderPlacesView(rows) {
  if (!state.dataset) return;
  if (rows) placeRows = rows;
  // 선택 범위 안의 거래처만, 방문 수도 범위 기준
  const visits = new Map();
  for (const r of placeRows) visits.set(r.placeKey, (visits.get(r.placeKey) || 0) + 1);
  const all = buildPlaces().filter((p) => visits.has(p.key)).map((p) => ({ ...p, visits: visits.get(p.key) }));
  for (const k of [...placeSel]) if (!visits.has(k)) placeSel.delete(k);
  const counts = {};
  for (const p of all) counts[statusOf(p)] = (counts[statusOf(p)] || 0) + 1;
  const countIn = (set) => [...set].reduce((sum, s) => sum + (counts[s] || 0), 0);
  placeAll = all;
  const chips = [['all', '전체', all.length], ['need', '확인 필요', countIn(NEED_CHECK)], ['auto', '자동', countIn(AUTO_SET)], ['manual', '수동', counts.manual], ['excluded', '위치제외', counts.excluded]];
  $('#placeChips').innerHTML = chips.map(([k, l, n]) => `<button class="chip ${placeFilter === k ? 'on' : ''} ${k === 'need' && n ? 'chip-warn' : ''}" data-pf="${k}">${l} <b>${fmtNum(n || 0)}</b></button>`).join('');
  const q = placeSearch.toLowerCase();
  placeList = all.filter((p) => {
    const ok = PLACE_FILTERS[placeFilter](statusOf(p));
    return ok && (!q || p.name.toLowerCase().includes(q));
  }).sort((a, b) => b.visits - a.visits);
  placeTable.setRows(placeList, { keepPage: true });
  updateSelUi();
}

/** 선택한 거래처를 검색 후보 중 콜 X좌표(경도 중앙값)와 가장 가까운 곳으로 일괄 지정 */
async function bulkNearest(keys) {
  const places = buildPlaces().filter((p) => keys.includes(p.key));
  const btn = $('#placeBulkNearest');
  btn.disabled = true;
  const skipped = [];
  let done = 0;
  for (const [i, p] of places.entries()) {
    btn.textContent = `처리 중 ${i + 1}/${places.length}`;
    if (p.excluded) { skipped.push(`${p.name} — 위치 제외`); continue; }
    if (p.gpsX == null) { skipped.push(`${p.name} — 콜 X좌표 없음(법카 등)`); continue; }
    let cands = (state.geo[p.key]?.candidates || []).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
    if (!cands.length && isKakaoReady()) {
      const { list } = await searchCandidates(p);
      cands = list;
    }
    const named = cands.filter((c) => c.ns == null || c.ns >= 2);
    if (named.length) cands = named;
    if (!cands.length) { skipped.push(`${p.name} — 검색 후보 없음`); continue; }
    const best = cands
      .map((c) => ({ ...c, d: lngDiffKm(c.lng, p.gpsX, c.lat) }))
      .sort((a, b) => a.d - b.d)[0];
    const g = state.geo[p.key] || {};
    const before = Number.isFinite(g.lat) ? `${g.lng.toFixed(6)}, ${g.lat.toFixed(6)} (${GEO_LABEL[g.status] || ''})` : GEO_LABEL[g.status] || '미검색';
    state.geo[p.key] = { ...g, status: 'manual', lat: best.lat, lng: best.lng, addr: best.addr || '', matchName: best.name || '', ts: Date.now() };
    logHistory('거래처 좌표', `${p.name} (${[p.sidoN, p.sggN].filter(Boolean).join(' ')})`, before, `${best.lng.toFixed(6)}, ${best.lat.toFixed(6)}`, `일괄 지정: 콜 X좌표 최근접 ${best.d.toFixed(2)}km`);
    done++;
  }
  btn.textContent = '콜 X좌표 최근접으로 일괄 지정';
  placeSel.clear();
  save('geo');
  emit('geo-updated');
  if (skipped.length) {
    openModal({
      title: `${done}곳 지정 · ${skipped.length}곳 제외`,
      body: `<ul class="warn-list">${skipped.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`,
      actions: [{ label: '확인', kind: 'primary', onClick: (c) => c() }],
    });
  } else toast(`${done}곳을 지정했습니다.`, 'ok');
}

/** 거래처 위치·주소 수정 모달 */
export function openPlaceEditor(key) {
  const p = buildPlaces().find((x) => x.key === key);
  if (!p) return;
  const g = state.geo[key] || {};
  const pe = state.placeEdits[key] || {};
  const body = document.createElement('div');
  body.className = 'editor';
  body.innerHTML = `
    <div class="ed-info">
      <div class="ed-title">${esc(p.name)}</div>
      <div class="muted small">원본 주소: ${esc([p.rawSido, p.rawSgg].filter(Boolean).join(' ') || '(비어 있음)')} · 방문 ${p.visits}건 · ${esc([...p.names].join(', '))}</div>
      <div class="small">현재 상태: <span class="badge geo-${statusOf(p)}">${GEO_LABEL[statusOf(p)]}</span> ${esc(g.addr || '')}
      ${p.gpsX != null ? `<span class="muted"> · 콜 X좌표 중앙값 ${p.gpsX.toFixed(6)}</span>` : ''}</div>
    </div>
    <fieldset class="ed-sec"><legend>1. 주소 정보 수정</legend>
      <div class="form-row">
        <label>시도<input class="input" id="edSido" value="${esc(pe.sido ?? p.sidoN)}" placeholder="예: 인천"></label>
        <label>시군구<input class="input" id="edSgg" value="${esc(pe.sigungu ?? p.sggN)}" placeholder="예: 부평구"></label>
      </div>
    </fieldset>
    <fieldset class="ed-sec"><legend>2. 후보에서 선택 ${infoIcon('카카오 장소검색 결과\n거리 = 콜 X좌표 중앙값과의 동서 거리')}</legend>
      <div class="form-row"><input class="input grow" id="edQuery" value="${esc([p.sidoN, p.sggN, p.name].filter(Boolean).join(' '))}"><button class="btn" id="edSearch">검색</button></div>
      <div class="cands" id="edCands">${renderCands(g.candidates || [])}</div>
    </fieldset>
    <fieldset class="ed-sec"><legend>3. 좌표 직접 입력</legend>
      <div class="form-row">
        <label>X좌표 (경도)<input class="input mono" id="edX" inputmode="decimal" value="${g.lng ?? ''}" placeholder="126.7024414"></label>
        <label>Y좌표 (위도)<input class="input mono" id="edY" inputmode="decimal" value="${g.lat ?? ''}" placeholder="37.4893812"></label>
      </div>
      <p class="muted small">카카오맵에서 장소를 우클릭 → "좌표 확인" 또는 네이버/카카오 지도 URL에서 좌표를 확인할 수 있습니다.</p>
    </fieldset>
    <fieldset class="ed-sec"><legend>4. 위치 제외</legend>
      <div class="form-row"><span class="grow small">${!p.excluded ? '제외되지 않음' : excludeKeywordsOf(p.name).length ? `제외 중 · 키워드 <b>${esc(excludeKeywordsOf(p.name).join(', '))}</b>` : '제외 중 · 위치 관리에서 직접 지정'}</span>
      <button type="button" class="btn btn-sm" id="edExclKw">제외 키워드 설정</button></div>
    </fieldset>
    <label class="ed-reason">수정 사유<input class="input" id="edReason" placeholder="예: 동일 상호 다수, 실제 방문 지점으로 정정"></label>`;

  $('#edExclKw', body).addEventListener('click', () => openExcludeEditor(p.name));
  const cands = () => $('#edCands', body);
  cands().addEventListener('click', (e) => {
    const c = e.target.closest('[data-lat]');
    if (!c) return;
    $('#edX', body).value = c.dataset.lng;
    $('#edY', body).value = c.dataset.lat;
    cands().querySelectorAll('.cand').forEach((x) => x.classList.toggle('on', x === c));
    body.dataset.pickName = c.dataset.name;
    body.dataset.pickAddr = c.dataset.addr;
  });
  $('#edSearch', body).addEventListener('click', async () => {
    if (!isKakaoReady()) { toast('카카오 지도가 연결되어 있지 않습니다. 설정에서 키를 입력하세요.', 'warn'); return; }
    cands().innerHTML = '<p class="muted">검색 중…</p>';
    const { list } = await searchCandidates({ ...p, sidoN: normSido($('#edSido', body).value), sggN: $('#edSgg', body).value.replace(/\s+/g, '') }, $('#edQuery', body).value.trim());
    cands().innerHTML = renderCands(list.slice(0, 12));
  });

  openModal({
    title: '거래처 위치·주소 수정',
    body,
    wide: true,
    actions: [
      { label: '취소', onClick: (c) => c() },
      { label: '저장', kind: 'primary', onClick: (close) => savePlaceEdit(p, body, close) },
    ],
  });
}

function renderCands(list) {
  if (!list.length) return '<p class="muted small">후보가 없습니다. 검색어를 바꿔 다시 검색하거나 좌표를 직접 입력하세요.</p>';
  return list.map((c) => `<button type="button" class="cand" data-lat="${c.lat}" data-lng="${c.lng}" data-name="${esc(c.name)}" data-addr="${esc(c.addr)}">
    <b>${esc(c.name)}</b> <span class="muted small">${esc(c.catName || '')}</span><br>
    <span class="small">${esc(c.addr)}</span>${c.gpsKm != null ? ` <span class="badge ${c.gpsKm <= 0.5 ? 'badge-green' : 'badge-gray'}">콜 X좌표와 ${c.gpsKm.toFixed(2)}km</span>` : ''}
  </button>`).join('');
}

function savePlaceEdit(p, body, close) {
  const key = p.key;
  const reason = $('#edReason', body).value.trim();
  const sido = $('#edSido', body).value.trim();
  const sgg = $('#edSgg', body).value.trim();
  const xs = $('#edX', body).value.trim();
  const ys = $('#edY', body).value.trim();
  const g = state.geo[key] || {};
  const pe = { ...(state.placeEdits[key] || {}) };
  const target = `${p.name} (${[p.sidoN, p.sggN].filter(Boolean).join(' ')})`;
  let changed = false;

  if (xs || ys) {
    const x = Number(xs);
    const y = Number(ys);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 124 || x > 132 || y < 33 || y > 39) {
      toast('좌표를 확인하세요. X(경도)는 124~132, Y(위도)는 33~39 범위여야 합니다.', 'error', 4500);
      return;
    }
    if (g.status !== 'manual' || g.lat !== y || g.lng !== x) {
      const before = Number.isFinite(g.lat) ? `${g.lng.toFixed(6)}, ${g.lat.toFixed(6)} (${GEO_LABEL[g.status] || ''})` : GEO_LABEL[g.status] || '미검색';
      state.geo[key] = { ...g, status: 'manual', lat: y, lng: x, addr: body.dataset.pickAddr || g.addr || '', matchName: body.dataset.pickName || g.matchName || '', ts: Date.now() };
      logHistory('거래처 좌표', target, before, `${x.toFixed(6)}, ${y.toFixed(6)}`, reason);
      changed = true;
    }
  }
  const regionChanged = normSido(sido) !== p.sidoN || sgg.replace(/\s+/g, '') !== p.sggN;
  if (regionChanged) {
    logHistory('거래처 주소', p.name, [p.sidoN, p.sggN].filter(Boolean).join(' ') || '(없음)', `${sido} ${sgg}`.trim(), reason);
    pe.sido = sido;
    pe.sigungu = sgg;
    if (state.geo[key]?.status !== 'manual') delete state.geo[key]; // 좌표를 직접 넣지 않았다면 새 주소로 다시 검색
    changed = true;
  }
  if (!changed) { close(); return; }
  state.placeEdits[key] = pe;
  save('placeEdits');
  save('geo');
  close();
  toast('저장했습니다.', 'ok');
  emit('geo-updated');
  if (regionChanged && state.geo[key] === undefined) emit('run-geocode', { force: false });
}

/* =========================================================
   위치 제외 키워드(거래처명에 포함되면 제외)
   ========================================================= */
function setKeywords(next, target, before, after) {
  state.settings.excludeKeywords = next;
  saveSettings();
  logHistory('위치 제외 키워드', target, before, after);
  if (document.querySelector('#kwList')) renderSettings();
  emit('settings-changed');
}

/** 거래처명 기준 위치 제외 키워드 추가·수정·삭제 */
export function openExcludeEditor(placeName) {
  const matched = excludeKeywordsOf(placeName);
  const body = document.createElement('div');
  body.className = 'editor';
  body.innerHTML = `
    <div class="ed-info"><div class="ed-title">${esc(placeName)}</div>
      <div class="small muted">거래처명에 키워드가 포함되면 지도·이동속도 계산에서 제외</div></div>
    ${matched.length ? `<fieldset class="ed-sec"><legend>적용 중인 키워드</legend>
      ${matched.map((k) => `<div class="form-row kw-edit"><input class="input grow" data-old="${esc(k)}" value="${esc(k)}">
        <button type="button" class="btn btn-sm" data-kw-save="${esc(k)}">수정</button>
        <button type="button" class="btn btn-sm btn-danger" data-kw-del="${esc(k)}">삭제</button></div>`).join('')}
    </fieldset>` : ''}
    <fieldset class="ed-sec"><legend>${matched.length ? '키워드 추가' : '제외 키워드 추가'}</legend>
      <div class="form-row"><input class="input grow" id="exNew" value="${matched.length ? '' : esc(placeName)}" placeholder="예: 다이소">
      <button type="button" class="btn btn-primary btn-sm" id="exAdd">추가</button></div>
      <p class="small muted">필요한 단어만 남기세요. 예) "다이소 청주점" → "다이소"</p>
    </fieldset>`;
  const modal = openModal({ title: '위치 제외 키워드', body, actions: [{ label: '닫기', onClick: (c) => c() }] });
  const kws = () => state.settings.excludeKeywords;
  body.addEventListener('click', (e) => {
    const del = e.target.closest('[data-kw-del]')?.dataset.kwDel;
    if (del) {
      setKeywords(kws().filter((k) => k !== del), del, '포함', '삭제');
      toast(`"${del}" 키워드를 삭제했습니다.`, 'ok');
      modal.close();
      return;
    }
    const old = e.target.closest('[data-kw-save]')?.dataset.kwSave;
    if (old) {
      const v = body.querySelector(`input[data-old="${CSS.escape(old)}"]`).value.trim();
      if (!v || v === old) return;
      setKeywords([...new Set(kws().map((k) => (k === old ? v : k)))], old, old, v);
      toast(`"${old}" → "${v}"로 수정했습니다.`, 'ok');
      modal.close();
      return;
    }
    if (e.target.closest('#exAdd')) {
      const v = $('#exNew', body).value.trim();
      if (!v) return;
      if (kws().includes(v)) { toast('이미 있는 키워드입니다.', 'warn'); return; }
      setKeywords([...kws(), v], v, '', '추가');
      toast(`"${v}" 키워드를 추가했습니다.`, 'ok');
      modal.close();
    }
  });
}

/* =========================================================
   수정 이력
   ========================================================= */
let histTable = null;
let histList = []; // 현재 표에 보이는 이력
const histSel = new Set();

function updateHistSelUi() {
  $('#histSelCount').textContent = `${fmtNum(histSel.size)}건 선택`;
  $('#histDelete').disabled = !histSel.size;
  const all = $('#histSelAll');
  all.checked = histList.length > 0 && histList.every((h) => histSel.has(h.id));
  all.indeterminate = !all.checked && histList.some((h) => histSel.has(h.id));
}

function removeHistory(keep) {
  state.history = state.history.filter(keep);
  histSel.clear();
  save('history');
  emit('history-changed');
}

export function initHistoryView() {
  histTable = new DataTable($('#histTable'), {
    pageSize: 100,
    emptyText: '수정 이력이 없습니다.',
    onAction: (act, h, el) => {
      if (act !== 'sel') return;
      if (el.checked) histSel.add(h.id);
      else histSel.delete(h.id);
      updateHistSelUi();
    },
    columns: [
      { key: 'sel', label: '선택', sortable: false, align: 'center', html: (h) => `<input type="checkbox" class="row-check" data-action="sel" ${histSel.has(h.id) ? 'checked' : ''} aria-label="이력 선택">` },
      { key: 'ts', label: '일시', width: 150 },
      { key: 'type', label: '유형', html: (h) => `<span class="badge badge-gray">${esc(h.type)}</span>` },
      { key: 'target', label: '대상', width: 180, cls: 'cell-wrap' },
      { key: 'before', label: '변경 전', cls: 'cell-wrap' },
      { key: 'after', label: '변경 후', cls: 'cell-wrap' },
      { key: 'reason', label: '사유', cls: 'cell-wrap' },
    ],
  });
  $('#histType').addEventListener('change', renderHistoryView);
  $('#histSelAll').addEventListener('change', (e) => {
    for (const h of histList) {
      if (e.target.checked) histSel.add(h.id);
      else histSel.delete(h.id);
    }
    histTable.render();
    updateHistSelUi();
  });
  $('#histDelete').addEventListener('click', async () => {
    const n = histSel.size;
    if (!await confirmDialog('이력 삭제', `선택한 이력 ${fmtNum(n)}건을 삭제합니다. 되돌릴 수 없습니다. 필요하면 먼저 엑셀로 내보내세요.`, '삭제')) return;
    removeHistory((h) => !histSel.has(h.id));
    toast(`이력 ${fmtNum(n)}건을 삭제했습니다.`, 'ok');
  });
  $('#histExport').addEventListener('click', () => {
    exportXlsx(`GPS콜_수정이력_${new Date().toISOString().slice(0, 10)}.xlsx`, [{
      name: '수정이력', rows: [['일시', '유형', '대상', '변경 전', '변경 후', '사유'], ...state.history.map((h) => [h.ts, h.type, h.target, h.before, h.after, h.reason])],
    }]);
  });
}

export function renderHistoryView() {
  const types = [...new Set(state.history.map((h) => h.type))];
  const sel = $('#histType');
  const cur = sel.value;
  sel.innerHTML = `<option value="">전체 유형 (${state.history.length})</option>${types.map((t) => `<option ${t === cur ? 'selected' : ''}>${esc(t)}</option>`).join('')}`;
  const activeType = sel.value; // 고른 유형의 이력이 모두 삭제되면 "전체 유형"으로 돌아감
  histList = activeType ? state.history.filter((h) => h.type === activeType) : state.history;
  histTable.setRows(histList, { keepPage: true });
  updateHistSelUi();
}

/* =========================================================
   설정
   ========================================================= */
export function renderSettings() {
  const S = state.settings;
  $('#view-settings').innerHTML = `
  <div class="settings">
    <section class="card">
      <div class="card-head"><h3>카카오 지도 API</h3><span class="badge ${isKakaoReady() ? 'badge-green' : 'badge-gray'}">${isKakaoReady() ? '연결됨' : '미연결'}</span></div>
      <div class="form-row">
        <label class="grow">JavaScript 키<input class="input mono" id="setKey" type="password" autocomplete="off" value="${esc(state.kakaoKey)}" placeholder="카카오 개발자 콘솔의 JavaScript 키"></label>
        <button class="btn btn-primary" id="setKeySave" type="button">저장</button>
      </div>
      <ol class="help">
        <li><a href="https://developers.kakao.com" target="_blank" rel="noopener">developers.kakao.com</a> → 내 애플리케이션 → 앱 추가</li>
        <li>앱 설정 → 플랫폼 → Web 플랫폼 등록 → 사이트 도메인에 <code>${esc(location.origin)}</code> 입력</li>
        <li>제품 설정 → 카카오맵 활성화 → 앱 키의 <b>JavaScript 키</b>를 위에 입력</li>
      </ol>
      <p class="notice">키는 이 PC 브라우저(localStorage)에만 저장됩니다.<br>위치 검색 시 <b>거래처명과 시도·시군구</b>만 카카오로 전송되며, 사원명·사번·콜 내역은 전송되지 않습니다.</p>
    </section>

    <section class="card">
      <div class="card-head"><h3>분석 기준</h3><button class="btn btn-sm" id="setReset">기본값</button></div>
      <div class="form-grid">
        <label><span class="lbl">이동불가 속도 · 초과 (km/h) ${infoIcon('차량 기준\n이 속도를 넘으면 이동불가')}</span><input class="input" type="number" id="setSpeed" min="0" max="5000" value="${S.speedLimit}"></label>
        <label><span class="lbl">이동불가 속도 · 미만 (km/h) ${infoIcon('이 속도 미만만 이동불가로 판정\n0 = 제한 없음')}</span><input class="input" type="number" id="setSpeedMax" min="0" max="5000" value="${S.speedMax || 0}"></label>
        <label><span class="lbl">최소 이동거리 (km) ${infoIcon('미만 이동은 속도 판정 제외\n(콜 인정 반경 약 300m 오차 보정)')}</span><input class="input" type="number" step="0.1" id="setMinDist" min="0" value="${S.minDistKm}"></label>
        <label><span class="lbl">위치 불명확 기준 (km) ${infoIcon('콜 X좌표 ↔ 거래처 경도 동서 거리\n초과 시 위치불명확(참고용)')}</span><input class="input" type="number" step="0.1" id="setMis" min="0.1" value="${S.mismatchKm}"></label>
        <label><span class="lbl">거리 산정 우선순위 ${infoIcon('① 엑셀: 원본 이동거리(직전 행 기준)\n② 지도: 거래처 좌표 간 직선거리')}</span><select class="input" id="setDist">
          <option value="file" ${S.distPriority === 'file' ? 'selected' : ''}>엑셀 이동거리 우선</option>
          <option value="map" ${S.distPriority === 'map' ? 'selected' : ''}>지도 좌표 직선거리 우선</option></select></label>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>위치 제외 키워드 ${infoIcon('거래처명에 포함 시 본사 주소로 잡힐 수 있음\n① 지도·속도 계산 제외\n② 방문 내역 패널에는 표시')}</h3></div>
      <div class="kw-list" id="kwList">${S.excludeKeywords.map((k) => `<span class="kw">${esc(k)}<button data-kw="${esc(k)}" aria-label="${esc(k)} 삭제">✕</button></span>`).join('')}</div>
      <div class="form-row"><input class="input grow" id="kwInput" placeholder="추가할 키워드 (예: 쿠팡, 네이버페이)"><button class="btn" id="kwAdd">추가</button></div>
    </section>

    <section class="card">
      <div class="card-head"><h3>데이터 관리</h3></div>
      <p class="muted small">업로드한 엑셀 데이터와 작업 내역(좌표·특이건 체크·메모·집 위치·이력)은 이 PC 브라우저(IndexedDB)에 저장됩니다.<br>다른 PC로 옮기거나 팀원과 공유하려면 작업 내역을 백업하세요.</p>
      <div class="btn-row">
        <button class="btn" id="bkExport">작업 내역 백업(JSON)</button>
        <label class="btn">백업 불러오기<input type="file" id="bkImport" accept=".json" hidden></label>
        <button class="btn btn-danger" id="clearData">데이터 삭제</button>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>접속 잠금</h3></div>
      <p class="muted small">자리를 비울 때 메인 화면으로 돌아갑니다. 다시 들어오려면 비밀번호를 입력합니다.</p>
      <div class="btn-row">
        <button class="btn" id="pwLock">지금 잠그기</button>
      </div>
    </section>
  </div>`;
  bindSettings();
}

function bindSettings() {
  const v = $('#view-settings');
  $('#pwLock', v).onclick = lockNow;
  $('#setKeySave', v).onclick = () => {
    const key = $('#setKey', v).value.trim();
    const hadKey = !!state.kakaoKey;
    const changed = key !== state.kakaoKey;
    saveKakaoKey(key);
    if (changed) logHistory('설정', '카카오 키', hadKey ? '등록됨' : '없음', key ? '변경' : '삭제');
    toast(key ? '키를 저장했습니다.' : '키를 삭제했습니다.', 'ok');
    emit('kakao-key', { changed });
  };
  const num = (id, key) => {
    $(id, v).onchange = (e) => {
      const n = Number(e.target.value);
      if (!Number.isFinite(n) || n < 0) { e.target.value = state.settings[key]; return; }
      state.settings[key] = n;
      saveSettings();
      emit('settings-changed');
    };
  };
  num('#setSpeed', 'speedLimit');
  num('#setSpeedMax', 'speedMax');
  num('#setMinDist', 'minDistKm');
  num('#setMis', 'mismatchKm');
  $('#setDist', v).onchange = (e) => { state.settings.distPriority = e.target.value; saveSettings(); emit('settings-changed'); };
  $('#setReset', v).onclick = () => {
    const { excludeKeywords, pageSize, kwV151 } = state.settings;
    state.settings = { ...DEFAULT_SETTINGS, excludeKeywords, pageSize, kwV151 };
    saveSettings();
    renderSettings();
    emit('settings-changed');
  };
  $('#kwList', v).onclick = (e) => {
    const b = e.target.closest('[data-kw]');
    if (!b) return;
    const k = b.dataset.kw;
    state.settings.excludeKeywords = state.settings.excludeKeywords.filter((x) => x !== k);
    saveSettings();
    logHistory('위치 제외 키워드', k, '포함', '삭제');
    renderSettings();
    emit('settings-changed');
  };
  const addKw = () => {
    const k = $('#kwInput', v).value.trim();
    if (!k || state.settings.excludeKeywords.includes(k)) return;
    state.settings.excludeKeywords = [...state.settings.excludeKeywords, k];
    saveSettings();
    logHistory('위치 제외 키워드', k, '', '추가');
    renderSettings();
    emit('settings-changed');
  };
  $('#kwAdd', v).onclick = addKw;
  $('#kwInput', v).onkeydown = (e) => { if (e.key === 'Enter') addKw(); };
  $('#bkExport', v).onclick = () => {
    downloadBlob(new Blob([JSON.stringify(exportWorkState(), null, 1)], { type: 'application/json' }), `GPS콜_작업백업_${new Date().toISOString().slice(0, 10)}.json`);
  };
  $('#bkImport', v).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      importWorkState(JSON.parse(await f.text()));
      toast('백업을 불러왔습니다.', 'ok');
      emit('settings-changed');
      emit('geo-updated');
    } catch (err) {
      toast(`불러오기 실패: ${err.message}`, 'error', 5000);
    }
    e.target.value = '';
  };
  $('#clearData', v).onclick = openDeleteDialog;
}

/** 삭제할 항목을 직접 선택(기본: 카카오 키·위치 제외 키워드를 뺀 전체) */
const DELETE_ITEMS = [
  { key: 'dataset', label: '업로드 데이터', desc: '불러온 엑셀 내역', on: true },
  { key: 'geo', label: '거래처 좌표', desc: '자동·수동으로 지정한 위치', on: true },
  { key: 'placeEdits', label: '거래처 주소 수정', desc: '시도·시군구 수정 내용', on: true },
  { key: 'placeExcludes', label: '거래처 위치제외 지정', desc: '위치 관리에서 직접 지정한 곳', on: true },
  { key: 'favs', label: '즐겨찾기 ★', on: true },
  { key: 'memos', label: '비고', on: true },
  { key: 'homes', label: '집 위치', on: true },
  { key: 'history', label: '수정 이력', on: true },
  { key: 'analysis', label: '분석 기준', desc: '속도·거리 기준을 기본값으로', on: true },
  { key: 'kakaoKey', label: '카카오 키', on: false },
  { key: 'keywords', label: '위치 제외 키워드', desc: '기본 키워드로 되돌림', on: false },
];

function openDeleteDialog() {
  const body = document.createElement('div');
  body.className = 'editor';
  body.innerHTML = `
    <p class="small muted">선택한 항목만 삭제합니다. 되돌릴 수 없으니 필요하면 먼저 백업하세요.</p>
    <div class="del-list">${DELETE_ITEMS.map((it) => `
      <label class="check del-item"><input type="checkbox" value="${it.key}" ${it.on ? 'checked' : ''}>
        <span><b>${esc(it.label)}</b>${it.desc ? ` <span class="muted small">${esc(it.desc)}</span>` : ''}</span></label>`).join('')}
    </div>
    <div class="form-row"><button type="button" class="btn btn-sm" id="delAll">전체 선택</button><button type="button" class="btn btn-sm" id="delNone">선택 해제</button></div>`;
  const boxes = () => Array.from(body.querySelectorAll('input[type=checkbox]'));
  body.querySelector('#delAll').onclick = () => boxes().forEach((b) => { b.checked = true; });
  body.querySelector('#delNone').onclick = () => boxes().forEach((b) => { b.checked = false; });
  openModal({
    title: '데이터 삭제',
    body,
    actions: [
      { label: '취소', onClick: (c) => c() },
      {
        label: '선택 항목 삭제', kind: 'danger', onClick: async (close) => {
          const keys = boxes().filter((b) => b.checked).map((b) => b.value);
          if (!keys.length) { toast('삭제할 항목을 선택하세요.', 'warn'); return; }
          close();
          await deleteData(keys);
          location.reload();
        },
      },
    ],
  });
}

async function deleteData(keys) {
  const stored = keys.filter((k) => ['dataset', 'geo', 'placeEdits', 'placeExcludes', 'favs', 'memos', 'homes', 'history'].includes(k));
  await deleteStored(stored);
  if (keys.includes('kakaoKey')) saveKakaoKey('');
  if (keys.includes('analysis') || keys.includes('keywords')) {
    const cur = state.settings;
    state.settings = {
      ...DEFAULT_SETTINGS,
      pageSize: cur.pageSize, kwV151: true,
      excludeKeywords: keys.includes('keywords') ? [...DEFAULT_SETTINGS.excludeKeywords] : cur.excludeKeywords,
      ...(keys.includes('analysis') ? {} : { speedLimit: cur.speedLimit, speedMax: cur.speedMax, minDistKm: cur.minDistKm, mismatchKm: cur.mismatchKm, distPriority: cur.distPriority }),
    };
    saveSettings();
  }
}

/* =========================================================
   집 위치
   ========================================================= */
export function openHomeEditor(code) {
  const e = state.dataset.employees[code];
  const h = state.homes[code] || {};
  const body = document.createElement('div');
  body.className = 'editor';
  body.innerHTML = `
    <p class="muted small">${esc(e.name)}(${esc(code)})의 집 위치를 등록하면 지도에 표시하고, 집 ↔ 첫콜·막콜 거리를 보여줍니다. 집 주소는 이 PC에만 저장되며, 검색 시 입력한 주소만 카카오로 전송됩니다.</p>
    <div class="form-row"><input class="input grow" id="hmAddr" value="${esc(h.addr || '')}" placeholder="도로명 또는 지번 주소"><button class="btn" id="hmSearch">주소 검색</button></div>
    <div class="cands" id="hmCands"></div>
    <div class="form-row">
      <label>X좌표 (경도)<input class="input mono" id="hmX" value="${h.lng ?? ''}"></label>
      <label>Y좌표 (위도)<input class="input mono" id="hmY" value="${h.lat ?? ''}"></label>
    </div>`;
  $('#hmSearch', body).onclick = async () => {
    if (!isKakaoReady()) { toast('카카오 지도가 연결되어 있지 않습니다. 좌표를 직접 입력하거나 설정에서 키를 입력하세요.', 'warn', 4500); return; }
    const q = $('#hmAddr', body).value.trim();
    if (!q) return;
    let list = (await addressSearch(q)).map((d) => ({ name: d.address_name, addr: d.road_address?.address_name || d.address_name, lat: +d.y, lng: +d.x }));
    if (!list.length) list = ((await keywordSearch(q)) || []).map((d) => ({ name: d.place_name, addr: d.road_address_name || d.address_name, lat: +d.y, lng: +d.x }));
    $('#hmCands', body).innerHTML = renderCands(list.slice(0, 8));
  };
  $('#hmCands', body).onclick = (ev) => {
    const c = ev.target.closest('[data-lat]');
    if (!c) return;
    $('#hmX', body).value = c.dataset.lng;
    $('#hmY', body).value = c.dataset.lat;
    $('#hmAddr', body).value = c.dataset.addr;
    $$cands(body).forEach((x) => x.classList.toggle('on', x === c));
  };
  const actions = [{ label: '취소', onClick: (c) => c() }];
  if (state.homes[code]) {
    actions.unshift({
      label: '삭제', kind: 'danger', onClick: (close) => {
        logHistory('집 정보', `${e.name}(${code})`, h.addr || '', '삭제');
        delete state.homes[code];
        save('homes');
        close();
        emit('home-changed');
      },
    });
  }
  actions.push({
    label: '저장', kind: 'primary', onClick: (close) => {
      const x = Number($('#hmX', body).value);
      const y = Number($('#hmY', body).value);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 124 || x > 132 || y < 33 || y > 39) {
        toast('주소를 검색해 선택하거나 올바른 좌표를 입력하세요.', 'error');
        return;
      }
      const addr = $('#hmAddr', body).value.trim();
      logHistory('집 정보', `${e.name}(${code})`, h.addr || '', addr || `${x}, ${y}`);
      state.homes[code] = { addr, lat: y, lng: x };
      save('homes');
      close();
      emit('home-changed');
    },
  });
  openModal({ title: '집 위치 등록', body, actions });
}

const $$cands = (root) => Array.from(root.querySelectorAll('.cand'));
