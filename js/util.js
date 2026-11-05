// 공통 유틸리티: 포맷, 날짜/시간 파싱, 거리 계산, 토스트, 툴팁, 모달

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const pad = (n) => String(n).padStart(2, '0');

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtNum(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return '-';
  if (!Number.isFinite(n)) return '∞';
  return n.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(r, digits = 1) {
  if (r == null || !Number.isFinite(r)) return '-';
  return `${(r * 100).toFixed(digits)}%`;
}

export function secToHMS(sec) {
  if (sec == null) return '';
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}

export function secToHM(sec) {
  if (sec == null) return '';
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}`;
}

/** 경과 시간(초)을 사람이 읽기 쉬운 형태로 */
export function fmtDuration(sec) {
  if (sec == null) return '-';
  if (sec < 60) return `${sec}초`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/** 엑셀 시간(소수) 또는 "오전 9:13:26" / "13:05" 형태 문자열 → 하루 기준 초 */
export function parseTimeToSec(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round((v % 1) * 86400) % 86400;
  if (v instanceof Date) return v.getHours() * 3600 + v.getMinutes() * 60 + v.getSeconds();
  const s = String(v).trim();
  const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  let h = +m[1];
  const isPm = /오후|PM/i.test(s);
  const isAm = /오전|AM/i.test(s);
  if (isPm && h < 12) h += 12;
  if (isAm && h === 12) h = 0;
  return h * 3600 + +m[2] * 60 + +(m[3] || 0);
}

/** 엑셀 일련번호 / Date / "2026.07.01" 등 → "YYYY-MM-DD" */
export function normDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null;
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = String(v).trim();
  let m = s.match(/(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/^\d+(\.\d+)?$/.test(s)) return normDate(Number(s));
  return null;
}

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
export function weekdayKo(iso) {
  if (!iso) return '';
  const [y, mo, d] = iso.split('-').map(Number);
  return WEEK[new Date(y, mo - 1, d).getDay()];
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 경도 차이만으로 계산한 동서 방향 거리(km) — Y좌표가 없을 때의 최소 거리 */
export function lngDiffKm(lng1, lng2, lat) {
  return Math.abs(lng1 - lng2) * 111.32 * Math.cos((lat * Math.PI) / 180);
}

export function median(arr) {
  const a = arr.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 연속된 숫자를 "3–7, 9" 형태로 압축 */
export function compressRanges(nums) {
  const out = [];
  let start = null;
  let prev = null;
  for (const n of nums) {
    if (start === null) { start = prev = n; continue; }
    if (n === prev + 1) { prev = n; continue; }
    out.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = prev = n;
  }
  if (start !== null) out.push(start === prev ? `${start}` : `${start}–${prev}`);
  return out.join(', ');
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** SheetJS로 2차원 배열을 엑셀 파일로 저장 */
export function exportXlsx(filename, sheets) {
  const wb = XLSX.utils.book_new();
  for (const { name, rows } of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = (rows[0] || []).map((h) => ({ wch: Math.max(8, Math.min(40, String(h).length * 2 + 4)) }));
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename);
}

/* ---------- 토스트 ---------- */
export function toast(message, kind = 'info', ms = 3200) {
  const root = $('#toastRoot');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', 'status');
  el.textContent = message;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/* ---------- 툴팁: [data-tip] 요소에 마우스를 올리면 표시 ---------- */
export function initTooltips() {
  const tip = $('#tip');
  let current = null;
  const show = (target) => {
    const text = target.getAttribute('data-tip');
    if (!text) return;
    current = target;
    tip.innerHTML = esc(text).replace(/\n/g, '<br>');
    tip.classList.add('show');
    const r = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = r.bottom + 8;
    if (top + th > window.innerHeight - 8) top = r.top - th - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  const hide = () => {
    current = null;
    tip.classList.remove('show');
  };
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t && t !== current) show(t);
    else if (!t && current) hide();
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t) show(t);
  });
  document.addEventListener('focusout', hide);
  window.addEventListener('scroll', hide, true);
}

/** 계산 방법 등을 설명하는 ⓘ 아이콘 */
export function infoIcon(text) {
  return `<span class="info" tabindex="0" data-tip="${esc(text)}" aria-label="설명">i</span>`;
}

/* ---------- 모달 ---------- */
export function openModal({ title, body, actions = [], wide = false, onClose }) {
  const root = $('#modalRoot');
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `
    <div class="modal-scrim"></div>
    <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="닫기">✕</button></div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>
    </div>`;
  const bodyEl = $('.modal-body', wrap);
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  const foot = $('.modal-foot', wrap);
  const close = () => {
    wrap.classList.remove('show');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => wrap.remove(), 220);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.kind ? `btn-${a.kind}` : ''}`;
    b.textContent = a.label;
    b.addEventListener('click', () => a.onClick?.(close));
    foot.appendChild(b);
  }
  if (!actions.length) foot.remove();
  wrap.addEventListener('click', (e) => {
    if (e.target.matches('.modal-scrim') || e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);
  root.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('show'));
  return { el: wrap, body: bodyEl, close };
}

export function confirmDialog(title, message, okLabel = '확인', kind = 'danger') {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p class="modal-text">${esc(message)}</p>`,
      actions: [
        { label: '취소', onClick: (c) => { c(); resolve(false); } },
        { label: okLabel, kind, onClick: (c) => { c(); resolve(true); } },
      ],
    });
  });
}
