// 오른쪽 슬라이드 패널: 선택한 거래처·일자의 방문 내역을 시간순으로 표시

import { state, emit } from './store.js';
import { isFav, isSpecial, placeCoords } from './analysis.js';
import { GEO_LABEL } from './geo.js';
import { $, esc, fmtNum, fmtDuration, weekdayKo, haversineKm, secToHM } from './util.js';

const panel = () => $('#panel');
let current = null; // { code, date, focusKey, focusRowId, choices, source }
let suppressClick = false;

export function isPanelOpen() {
  return panel().classList.contains('open');
}

/**
 * @param {{focusKey?: string, focusRowId?: string, rows?: Array, code?: string, date?: string, prefer?: {code,date}}} opts
 * rows: 해당 거래처의 방문 기록(일자 선택 칩 생성용)
 */
export function openPanel(opts) {
  const choices = [];
  if (opts.rows?.length) {
    const seen = new Set();
    for (const r of [...opts.rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
      const k = `${r.code}|${r.date}`;
      if (seen.has(k)) continue;
      seen.add(k);
      choices.push({ code: r.code, date: r.date, anom: opts.rows.some((x) => x.code === r.code && x.date === r.date && x.anom) });
    }
  }
  let code = opts.code;
  let date = opts.date;
  if (!code && choices.length) {
    const pref = opts.prefer && choices.find((c) => c.code === opts.prefer.code && c.date === opts.prefer.date);
    const pick = pref || choices.find((c) => c.anom) || choices[choices.length - 1];
    code = pick.code;
    date = pick.date;
  }
  current = { code, date, focusKey: opts.focusKey || null, focusRowId: opts.focusRowId || null, choices, source: opts.source || 'dash' };
  render();
  const p = panel();
  p.classList.add('open');
  p.setAttribute('aria-hidden', 'false');
  document.body.classList.add('panel-open');
}

export function closePanel() {
  const p = panel();
  p.classList.remove('open');
  p.setAttribute('aria-hidden', 'true');
  p.dataset.day = '';
  document.body.classList.remove('panel-open');
  current = null;
}

export function refreshPanel() {
  if (current && isPanelOpen()) render();
}

export const panelSource = () => (current && isPanelOpen() ? current.source : null);

// 날짜 이동 대상(특이건이 있는 날) 목록 제공 함수: (source) => [{ code, date }]
let navProvider = () => [];
export function setPanelNav(fn) { navProvider = fn; }

function navInfo() {
  const days = navProvider(current.source) || [];
  const idx = days.findIndex((d) => d.code === current.code && d.date === current.date);
  return { days, idx };
}

/** 특이건 날짜 이동(dir = -1 이전, +1 다음) */
function stepDay(dir) {
  const { days, idx } = navInfo();
  if (!days.length) return;
  let next;
  if (idx >= 0) next = days[idx + dir];
  else {
    // 현재 날짜가 목록에 없으면 가까운 날짜로
    const key = `${current.date}|${current.code}`;
    const sorted = days.map((d, i) => ({ ...d, i, k: `${d.date}|${d.code}` }));
    next = dir > 0 ? sorted.find((d) => d.k > key) : [...sorted].reverse().find((d) => d.k < key);
  }
  if (!next) return;
  const first = dayRowsOf(next.code, next.date).find((r) => isSpecial(r) || isFav(r));
  current = { ...current, code: next.code, date: next.date, focusRowId: first?.id || null, focusKey: first?.placeKey || null, choices: [] };
  render();
  emit('panel-day', { code: next.code, date: next.date, source: current.source, focusKey: current.focusKey });
}

function dayRowsOf(code, date) {
  return state.dataset.rows.filter((r) => r.code === code && r.date === date).sort((a, b) => a.dayIndex - b.dayIndex);
}

function render() {
  const p = panel();
  if (!current || !state.dataset) return;
  const { code, date, focusKey, focusRowId, choices } = current;
  const emp = state.dataset.employees[code];
  const rows = dayRowsOf(code, date);
  const calls = rows.filter((r) => r.type === '콜');
  const first = calls[0];
  const last = calls[calls.length - 1];
  const home = state.homes[code];

  const focusRow = focusKey ? rows.find((r) => r.placeKey === focusKey) || state.dataset.rows.find((r) => r.placeKey === focusKey) : null;
  const geo = focusKey ? state.geo[focusKey] : null;

  // 집 ↔ 첫콜/막콜 거리
  let homeInfo = '';
  if (home && Number.isFinite(home.lat)) {
    const d = (r) => {
      const c = r && placeCoords(r.placeKey);
      return c ? haversineKm(home.lat, home.lng, c.lat, c.lng) : null;
    };
    const d1 = d(first);
    const d2 = d(last);
    homeInfo = `<div class="pn-home" data-tip="집 ↔ 첫콜·막콜 거래처 직선거리">
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 3 2 11h3v9h6v-6h2v6h6v-9h3z"/></svg>
      집→첫콜 ${d1 == null ? '-' : `${fmtNum(d1, 1)}km`} · 막콜→집 ${d2 == null ? '-' : `${fmtNum(d2, 1)}km`}</div>`;
  }

  const chips = choices.length > 1 ? `<div class="pn-chips" role="tablist" aria-label="방문 일자">${choices.map((c) => {
    const e = state.dataset.employees[c.code];
    const on = c.code === code && c.date === date;
    return `<button class="chip ${on ? 'on' : ''} ${c.anom ? 'chip-warn' : ''}" data-choice="${esc(c.code)}|${esc(c.date)}">${esc(c.date.slice(5))}(${weekdayKo(c.date)})${new Set(choices.map((x) => x.code)).size > 1 ? ` · ${esc(e?.name || c.code)}` : ''}</button>`;
  }).join('')}</div>` : '';

  const placeBlock = focusRow ? `
    <div class="pn-place">
      <div class="pn-place-name">${esc(focusRow.place)}</div>
      <div class="pn-place-meta">${esc([focusRow.sidoN, focusRow.sggN].filter(Boolean).join(' ') || '지역 미상')}${focusRow.regionInferred ? ' <span class="badge badge-gray" data-tip="원본 지역 공란\n같은 거래처명 기록으로 보완">지역 보완</span>' : ''}</div>
      <div class="pn-place-meta">${focusRow.excl ? '<span class="badge badge-gray">위치 제외 거래처</span>' : geo ? `<span class="badge geo-${geo.status}">${GEO_LABEL[geo.status] || geo.status}</span> ${esc(geo.addr || '')}` : '<span class="badge badge-gray">미검색</span>'}</div>
      <div class="pn-place-actions">
        <button class="btn btn-sm" data-act="edit-place">위치·주소 수정</button>
        ${placeCoords(focusKey) ? '<button class="btn btn-sm" data-act="locate">지도에서 보기</button>' : ''}
      </div>
    </div>` : '';

  let items = '';
  rows.forEach((r, i) => {
    if (i > 0 && !r.excl && r.prevId) {
      const speedTxt = r.speed == null ? '' : !Number.isFinite(r.speed) ? '동시각' : `${fmtNum(r.speed, 0)}km/h`;
      items += `<div class="tl-gap ${r.imp ? 'imp' : ''}">
        <span>${r.dist != null ? `${fmtNum(r.dist, 1)}km` : '거리 미상'} · ${fmtDuration(r.dt)}${speedTxt ? ` · ${speedTxt}` : ''}</span>
        ${r.imp ? '<span class="badge badge-red">이동불가</span>' : ''}
      </div>`;
    }
    const isFocus = (focusRowId && r.id === focusRowId) || (!focusRowId && focusKey && r.placeKey === focusKey);
    const fav = isFav(r);
    const badges = [
      r.type === '법카' ? `<span class="badge badge-green">법카${r.amount ? ` ${fmtNum(r.amount)}원` : ''}</span>` : '',
      r.digits ? `<span class="badge ${r.anom ? 'badge-orange' : 'badge-blue'}">${esc(r.digits)}</span>` : '',
      r.fl ? `<span class="badge badge-purple">${esc(r.fl)}</span>` : '',
      r.mis ? `<span class="badge badge-gray" data-tip="콜 X좌표 ↔ 거래처 동서 거리 ${fmtNum(r.misKm, 2)}km">위치불명확</span>` : '',
      r.dupX ? `<span class="badge badge-red" data-tip="동일 X좌표 ${r.dupX}회 반복">좌표중복</span>` : '',
      r.excl ? '<span class="badge badge-gray" data-tip="주소 부정확(본사 등)\n지도·속도 계산 제외">위치제외</span>' : '',
      !r.excl && !placeCoords(r.placeKey) ? '<span class="badge badge-gray">좌표 미확정</span>' : '',
    ].join('');
    items += `<div class="tl-item ${isFocus ? 'focus' : ''} ${r.type === '법카' ? 'is-card' : ''}" data-row="${esc(r.id)}">
      <div class="tl-time">${esc(r.time.slice(0, 5))}<small>${esc(r.time.slice(5))}</small></div>
      <div class="tl-dot ${r.type === '법카' ? 'dot-pay' : r.anom ? 'dot-anom' : 'dot-call'}"></div>
      <div class="tl-body">
        <div class="tl-name"><span class="tl-idx">${r.dayIndex}</span>${esc(r.place)}</div>
        <div class="tl-badges">${badges}</div>
        <div class="tl-meta">${esc(r.region)}${r.xRaw ? ` · X ${esc(r.xRaw)}` : ''}</div>
      </div>
      <button class="flag-btn ${fav ? 'on' : ''}" data-flag="${esc(r.id)}" aria-pressed="${fav}" data-tip="${fav ? '즐겨찾기 해제' : '즐겨찾기'}">★</button>
    </div>`;
  });

  const anomN = calls.filter((r) => r.anom).length;
  const impN = rows.filter((r) => r.imp).length;
  // 같은 날을 다시 그릴 때는 스크롤 위치를 유지하고 선택 항목까지 부드럽게 이동
  const dayKey = `${code}|${date}`;
  const sameDay = p.dataset.day === dayKey && isPanelOpen();
  const prevScroll = sameDay ? p.querySelector('.pn-scroll')?.scrollTop || 0 : 0;
  p.dataset.day = dayKey;
  const nav = navInfo();
  const navHtml = nav.days.length ? `
    <div class="pn-nav">
      <button class="icon-btn" data-act="prev-day" aria-label="이전 특이건 날짜" ${nav.idx === 0 ? 'disabled' : ''}>‹</button>
      <button class="icon-btn" data-act="next-day" aria-label="다음 특이건 날짜" ${nav.idx === nav.days.length - 1 ? 'disabled' : ''}>›</button>
      <span class="pn-count" data-tip="특이건이 있는 날짜 중 순서">${nav.idx >= 0 ? nav.idx + 1 : '–'}/${nav.days.length}</span>
    </div>` : '';
  p.innerHTML = `
    <div class="pn-head">
      <div>
        <div class="pn-eyebrow">${esc(emp?.team || '')} · ${esc(emp?.name || code)}${code.startsWith('시트:') ? '' : ` (${esc(code)})`}</div>
        <div class="pn-date"><h2>${esc(date)} <span class="muted">(${weekdayKo(date)})</span></h2>${navHtml}</div>
      </div>
      <button class="icon-btn" data-act="close" aria-label="패널 닫기">✕</button>
    </div>
    ${chips}
    <div class="pn-scroll">
      ${placeBlock}
      <div class="pn-stats">
        <div><b>${calls.length}</b><span>콜</span></div>
        <div><b>${rows.length - calls.length}</b><span>법카</span></div>
        <div class="${anomN ? 'warn' : ''}"><b>${anomN}</b><span>이상 자릿수</span></div>
        <div class="${impN ? 'danger' : ''}"><b>${impN}</b><span>이동불가</span></div>
      </div>
      <div class="pn-fl">첫콜 <b>${first ? secToHM(first.sec) : '-'}</b>${first?.anom ? ' <span class="badge badge-orange">이상</span>' : ''}
        <span class="sep"></span>막콜 <b>${last ? secToHM(last.sec) : '-'}</b>${last?.anom ? ' <span class="badge badge-orange">이상</span>' : ''}</div>
      ${homeInfo}
      <div class="timeline">${items || '<p class="muted">기록이 없습니다.</p>'}</div>
      <p class="pn-hint">항목을 길게 누르면 거래처 위치·주소 수정</p>
    </div>`;

  const scroller = p.querySelector('.pn-scroll');
  scroller.scrollTop = prevScroll;
  const f = p.querySelector('.tl-item.focus');
  if (!f) return;
  const fr = f.getBoundingClientRect();
  const sr = scroller.getBoundingClientRect();
  const visible = fr.top >= sr.top + 8 && fr.bottom <= sr.bottom - 8;
  if (sameDay && visible) return;
  const target = scroller.scrollTop + (fr.top - sr.top) - (sr.height - fr.height) / 2;
  scroller.scrollTo({ top: Math.max(0, target), behavior: sameDay ? 'smooth' : 'auto' });
}

export function initPanel() {
  const p = panel();
  p.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') { closePanel(); return; }
    if (act === 'prev-day') { stepDay(-1); return; }
    if (act === 'next-day') { stepDay(1); return; }
    if (act === 'edit-place') { emit('edit-place', current.focusKey); return; }
    if (act === 'locate') { emit('focus-place', { key: current.focusKey, source: current.source }); return; }
    const flag = e.target.closest('[data-flag]');
    if (flag) {
      const row = state.dataset.rows.find((r) => r.id === flag.dataset.flag);
      if (row) emit('toggle-fav', row);
      return;
    }
    const chip = e.target.closest('[data-choice]');
    if (chip) {
      const [code, date] = chip.dataset.choice.split('|');
      current = { ...current, code, date, focusRowId: null };
      render();
      emit('panel-day', { code, date, source: current.source });
      return;
    }
    const item = e.target.closest('.tl-item');
    if (item && suppressClick) { suppressClick = false; return; }
    if (item) {
      const row = state.dataset.rows.find((r) => r.id === item.dataset.row);
      if (!row) return;
      current.focusRowId = row.id;
      current.focusKey = row.placeKey;
      render();
      emit('focus-place', { key: row.placeKey, source: current.source });
    }
  });

  // 길게 누르기(0.55초) 또는 우클릭 → 거래처 위치·주소 수정(위치 관리 탭과 같은 화면)
  let timer = null;
  let start = null;
  const cancel = () => { clearTimeout(timer); timer = null; p.querySelector('.tl-item.pressing')?.classList.remove('pressing'); };
  const fire = (item) => {
    const row = state.dataset.rows.find((r) => r.id === item.dataset.row);
    if (row) emit('edit-place', row.placeKey);
  };
  p.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('.tl-item');
    if (!item || e.button !== 0 || e.target.closest('[data-flag]')) return;
    start = { x: e.clientX, y: e.clientY };
    item.classList.add('pressing');
    timer = setTimeout(() => { cancel(); suppressClick = true; fire(item); }, 550);
  });
  p.addEventListener('pointermove', (e) => {
    if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel();
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => p.addEventListener(ev, () => { if (timer) cancel(); }));
  p.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.tl-item');
    if (!item) return;
    e.preventDefault();
    cancel();
    fire(item);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isPanelOpen() && !document.querySelector('.modal-wrap')) closePanel();
  });
}
