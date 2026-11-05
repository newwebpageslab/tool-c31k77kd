// 대시보드: KPI, 사원 정보, 사용지역, 일별·시간대 차트, 보고서 초안/사원별 요약, 전체 백데이터

import { state, emit, saveSettings } from './store.js';
import { calcStats, employeeSummaries, draftSentences, isSpecial, isFav, reasonsOf, otherDigit, speedRangeText } from './analysis.js';
import { DataTable } from './table.js';
import { $, esc, fmtNum, fmtPct, infoIcon, weekdayKo, exportXlsx, toast } from './util.js';

// 툴팁: 정의 → 산식 → 판단 기준 순서로 간결하게
const TIP = {
  calls: '선택 범위의 GPS 콜 건수\n① 법카 사용 건 제외\n② 일평균 = 콜 수 ÷ 근무일',
  main: '사원별 전체 기간 최다 좌표 자릿수\n① 7자리: 삼성(갤럭시)\n② 13자리: 아이폰 또는 GPS 조작앱',
  anomRate: '이상 비율 = 비주력 자릿수 콜 ÷ 전체 콜\n선정 기준\n① 이상 비율 20% 이상\n② 주력 7자리 + 13자리 10건 이상',
  anom: '주 사용 자릿수와 다른 자릿수의 콜 건수',
  conc: '집중률 = 첫·막콜인 이상 콜 ÷ 이상 콜\n기대치 = 첫·막콜 ÷ 전체 콜\n집중률 > 기대치 1.5배 → 출퇴근 콜 조작 의심',
  imp: '속도 = 직전 기록과의 거리 ÷ 시간 차\n① 거리: 엑셀 이동거리 우선, 없으면 지도 직선거리\n② 판정: 선택한 속도 범위 + 0.5km 이상 이동\n③ 위치 제외 거래처와 그 앞뒤 기록은 판정 제외',
  dup: '동일 X좌표가 다른 일자·거래처에서 반복 등록된 횟수',
  mixed: '같은 날 7자리·13자리 콜이 함께 등록된 날 수\n① 하루 중 기기 교체는 부자연스러움 → 조작앱·대리콜 의심\n② 전환: 특정일 이후 자릿수가 바뀌어 유지(기기 변경 여부 확인)',
  special: '자동 판정된 특이건 수\n① 이상 자릿수 콜\n② 이동불가\n③ 좌표중복\n★ 즐겨찾기는 별도 표시',
  region: '콜·법카의 지역 분포(위치 제외 거래처 제외)\n① 광역시: 구 단위\n② 도: 시·군 단위',
};

let backTable = null;
let summaryTable = null;
let quick = 'all';
let search = '';
let currentRows = [];
let currentCode = null;

/* ---------------- KPI ---------------- */
function kpi({ label, value, sub = '', tip, tone = '', extra = '' }) {
  return `<div class="kpi ${tone}">
    <div class="kpi-label">${esc(label)} ${tip ? infoIcon(tip) : ''}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-sub">${sub}</div>${extra}
  </div>`;
}

/* ---------------- 이동불가 속도 범위 슬라이더(손잡이 2개, 바 1개) ---------------- */
const SPEED_STEP = 5;
const SPEED_SCALE_MAX = 200; // 오른쪽 끝 = "200 이상"(상한 없음): 300km/h 같은 기록도 포함

/** 슬라이더 위치 → 화면 문구 */
function speedLabel(lo, hi, max) {
  return hi >= max ? `${fmtNum(lo)}km/h 초과` : `${fmtNum(lo)} ~ ${fmtNum(hi)}km/h`;
}

/** 손잡이 사이 채움 구간(--lo, --hi)과 문구 갱신 */
function paintSpeedSlider(wrap) {
  const [lo, hi] = wrap.querySelectorAll('input');
  const max = Number(lo.max);
  wrap.style.setProperty('--lo', `${(Number(lo.value) / max) * 100}%`);
  wrap.style.setProperty('--hi', `${(Number(hi.value) / max) * 100}%`);
  // 두 손잡이가 오른쪽 끝에서 겹치면 아래쪽(하한) 손잡이를 위로 올려 잡을 수 있게
  lo.classList.toggle('on-top', Number(lo.value) > max / 2);
  wrap.parentElement.querySelector('output').textContent = speedLabel(Number(lo.value), Number(hi.value), max);
}

function speedSliderHtml(S) {
  const max = SPEED_SCALE_MAX;
  const lo = Math.min(Math.max(0, S.speedLimit), max - SPEED_STEP);
  const hi = S.speedMax && S.speedMax < max ? Math.max(S.speedMax, lo + SPEED_STEP) : max;
  return `<div class="speed-range">
    <div class="range2" style="--lo:${(lo / max) * 100}%;--hi:${(hi / max) * 100}%">
      <input type="range" id="speedMin" min="0" max="${max}" step="${SPEED_STEP}" value="${lo}" class="${lo > max / 2 ? 'on-top' : ''}" aria-label="이동불가 속도 하한(초과, km/h)">
      <input type="range" id="speedMax" min="0" max="${max}" step="${SPEED_STEP}" value="${hi}" aria-label="이동불가 속도 상한(미만, km/h)">
    </div>
    <div class="range2-scale"><span>0</span><output>${speedLabel(lo, hi, max)}</output><span>${fmtNum(max)} 이상</span></div>
  </div>`;
}

export function renderKpis(rows, code) {
  const s = calcStats(rows, code);
  const single = !!code;
  const S = state.settings;
  const dash = '<span class="dash">-</span>';
  const mainTxt = single && s.main ? `${esc(s.main)}` : dash;
  const concTone = single && s.conc != null && s.baseline != null && s.anom >= 3 && s.conc >= s.baseline * 1.5 ? 'tone-warn' : '';
  const topDup = s.dupList[0];

  const other = otherDigit(s.main);
  const digitSub = ['13자리', '7자리'].filter((d) => s.digit[d] != null).map((d) => `${d} ${fmtNum(s.digit[d])}콜`).join(' / ');
  const daySub = single
    ? `${fmtNum(s.days)}일 근무 · 일평균 ${s.days ? fmtNum(s.calls / s.days, 1) : '-'}콜`
    : `${fmtNum(s.employees)}명 · 인당 일평균 ${s.days ? fmtNum(s.calls / s.days, 1) : '-'}콜`;

  $('#kpis').innerHTML = [
    kpi({ label: '전체 콜', value: `${fmtNum(s.calls)}<small>콜</small>`, sub: daySub, tip: TIP.calls }),
    kpi({ label: '주 사용 자릿수', value: mainTxt, sub: single ? digitSub || '-' : '사원 선택 시 표시', tip: TIP.main }),
    kpi({ label: '이상 비율', value: single ? fmtPct(s.anomRate) : dash, sub: single && other ? `${other} 콜 비중` : '사원 선택 시 표시', tip: TIP.anomRate, tone: single && s.anomRate >= 0.2 ? 'tone-warn' : '' }),
    kpi({ label: '이상 건수', value: single ? `${fmtNum(s.anom)}<small>건</small>` : dash, sub: single && other ? `${other} 콜 건수` : '사원 선택 시 표시', tip: TIP.anom, tone: single && s.anom >= 10 ? 'tone-warn' : '' }),
    kpi({ label: '첫/막콜 집중률', value: single ? fmtPct(s.conc) : dash, sub: single ? `기대치 ${fmtPct(s.baseline)}${s.conc != null && s.baseline ? ` · ${fmtNum(s.conc / s.baseline, 1)}배` : ''}` : '사원 선택 시 표시', tip: TIP.conc, tone: concTone }),
    kpi({
      label: '이동 불가', value: `${fmtNum(s.imp)}<small>건</small>`, sub: speedRangeText(S), tip: TIP.imp, tone: s.imp ? 'tone-danger' : '',
      extra: speedSliderHtml(S),
    }),
    kpi({
      label: '자릿수 혼용일', value: `${fmtNum(s.mixedDays)}<small>일</small>`, tip: TIP.mixed, tone: s.mixedDays ? 'tone-warn' : '',
      sub: s.digitSwitch ? `<b class="txt-warn">${esc(s.digitSwitch.date.slice(5).replace('-', '/'))}부터 ${esc(s.digitSwitch.to)} 전환</b>` : `콜 등록 ${fmtNum(s.digitDays)}일 중`,
    }),
    kpi({ label: '좌표 중복', value: topDup ? `${fmtNum(topDup.count)}<small>회</small>` : `0<small>회</small>`, sub: topDup ? `X ${esc(topDup.x)}` : '반복 좌표 없음', tip: TIP.dup, tone: topDup ? 'tone-danger' : '' }),
    kpi({
      label: '특이건', value: `${fmtNum(s.special)}<small>건</small>`, sub: `즐겨찾기 ${fmtNum(s.favs)}건 · <button class="link" data-goto="flags">목록 보기 →</button>`, tip: TIP.special,
      extra: `<ul class="kpi-breakdown">
        <li>이상 자릿수 콜 <b>${fmtNum(s.anom)}</b>건</li>
        <li>이동불가 <b>${fmtNum(s.imp)}</b>건</li>
        <li>좌표중복 <b>${fmtNum(s.dupRows)}</b>건</li>
      </ul>`,
    }),
  ].join('');

  renderRegions(s);
  renderCharts(rows, code);
  renderSummary(rows, code, s);
}

/* ---------------- 사원 정보(스크롤 시 상단 고정) ---------------- */
export function renderEmployeeHead(code, rows = currentRows) {
  const box = $('#empHead');
  if (!code) {
    const n = new Set(rows.map((r) => r.code)).size;
    box.innerHTML = `<div class="emp-main"><div class="emp-avatar all">전체</div>
      <div class="emp-name">전체 사원 <span class="muted">${fmtNum(n)}명</span></div></div>
      <dl class="emp-facts">
        <div><dt>정상 자릿수</dt><dd><i class="dg dg-ok"></i>사원별 주 사용</dd></div>
        <div><dt>이상 자릿수</dt><dd><i class="dg dg-anom"></i>그 외 자릿수</dd></div>
      </dl>`;
    return;
  }
  const e = state.dataset.employees[code];
  const s = calcStats(rows, code);
  const other = otherDigit(e.mainDigit);
  const home = state.homes[code];
  const teamHist = e.teams.length > 1 ? ` data-tip="소속 이력: ${esc(e.teams.join(' → '))}"` : '';
  box.innerHTML = `
    <div class="emp-main">
      <div class="emp-avatar">${esc((e.name || '?').slice(0, 1))}</div>
      <div class="emp-id">
        <div class="emp-name">${esc(e.name)}</div>
        <div class="emp-meta"><span>${esc(code.startsWith('시트:') ? '사번 없음' : code)}</span><span${teamHist}>${esc([e.gubun, e.team].filter(Boolean).join(' · '))}${e.teams.length > 1 ? ' ↻' : ''}</span></div>
      </div>
    </div>
    <dl class="emp-facts">
      ${e.target?.checkType ? `<div><dt>점검유형</dt><dd>${esc(e.target.checkType)}</dd></div>` : ''}
      <div><dt>정상 자릿수</dt><dd><i class="dg dg-ok"></i>${esc(e.mainDigit || '-')}</dd></div>
      <div><dt>이상 자릿수</dt><dd><i class="dg dg-anom"></i>${esc(other || '-')}</dd></div>
      <div><dt>이상 비율</dt><dd class="${s.anomRate >= 0.2 ? 'txt-warn' : ''}">${fmtPct(s.anomRate)}</dd></div>
    </dl>
    <button class="btn btn-sm emp-home" data-act="home">${home ? '집 위치 수정' : '+ 집 위치'}</button>`;
}

/* ---------------- 사용 지역 ---------------- */
function renderRegions(s) {
  const top = s.regions.slice(0, 10);
  const max = Math.max(1, ...top.map((r) => r.calls + r.cards));
  const total = s.regions.reduce((a, r) => a + r.calls + r.cards, 0) || 1;
  $('#regionCard').innerHTML = `
    <div class="card-head"><h3>사용 지역 ${infoIcon(TIP.region)}</h3><span class="muted">${fmtNum(s.regions.length)}개 지역</span></div>
    <div class="legend"><span><i class="lg lg-ok"></i>콜(정상 자릿수)</span><span><i class="lg lg-anom"></i>콜(이상 자릿수)</span><span><i class="lg lg-card"></i>법카</span></div>
    <div class="bars">${top.map((r) => `
      <div class="bar-row" data-tip="${esc(r.region)}\n① 정상 자릿수 콜 ${r.calls - r.callsAnom}건\n② 이상 자릿수 콜 ${r.callsAnom}건\n③ 법카 ${r.cards}건">
        <span class="bar-label">${esc(r.region)}</span>
        <span class="bar-track"><i class="bar-call" style="width:${((r.calls - r.callsAnom) / max) * 100}%"></i><i class="bar-anom" style="width:${(r.callsAnom / max) * 100}%"></i><i class="bar-card" style="width:${(r.cards / max) * 100}%"></i></span>
        <span class="bar-val">${fmtPct((r.calls + r.cards) / total, 0)}</span>
      </div>`).join('') || '<p class="muted">데이터 없음</p>'}
    </div>
    ${s.regions.length > 10 ? `<p class="muted small">외 ${s.regions.length - 10}개 지역</p>` : ''}`;
}

/* ---------------- 차트(일별 / 시간대별) ---------------- */
function stackedBars({ keys, series, labelEvery = 1, labelOf, height = 150, tipOf }) {
  const n = keys.length || 1;
  const max = Math.max(1, ...keys.map((k) => series.reduce((s, se) => s + (se.data[k] || 0), 0)));
  const W = 100 / n;
  const bars = keys.map((k, i) => {
    let acc = 0;
    const segs = series.map((se) => {
      const v = se.data[k] || 0;
      const h = (v / max) * 100;
      const seg = v ? `<i class="${se.cls}" style="height:${h}%;bottom:${acc}%"></i>` : '';
      acc += h;
      return seg;
    }).join('');
    return `<div class="col" style="left:${i * W}%;width:${W}%" data-tip="${esc(tipOf(k))}"><div class="col-in">${segs}</div>${i % labelEvery === 0 ? `<span class="col-lbl">${esc(labelOf(k))}</span>` : ''}</div>`;
  }).join('');
  return `<div class="chart" style="height:${height}px"><span class="chart-max">${max}</span>${bars}</div>`;
}

function renderCharts(rows) {
  const calls = rows.filter((r) => r.type === '콜');
  const byDay = { ok: {}, anom: {} };
  const byHour = { ok: {}, anom: {} };
  for (const r of calls) {
    const t = r.anom ? 'anom' : 'ok';
    byDay[t][r.date] = (byDay[t][r.date] || 0) + 1;
    if (r.sec != null) {
      const h = Math.floor(r.sec / 3600);
      byHour[t][h] = (byHour[t][h] || 0) + 1;
    }
  }
  const days = [...new Set(calls.map((r) => r.date))].sort();
  const hours = [];
  const hs = calls.filter((r) => r.sec != null).map((r) => Math.floor(r.sec / 3600));
  const hMin = Math.min(7, ...hs);
  const hMax = Math.max(20, ...hs);
  for (let h = hMin; h <= hMax; h++) hours.push(h);
  const series = (d) => [{ data: d.ok, cls: 'seg-ok' }, { data: d.anom, cls: 'seg-anom' }];

  $('#chartCard').innerHTML = `
    <div class="card-head"><h3>콜 패턴 ${infoIcon('① 파랑: 주 사용 자릿수 콜\n② 주황: 이상 자릿수 콜\n③ 주황이 출퇴근 시간대에 몰리면 첫·막콜 조작 의심')}</h3>
      <div class="legend"><span><i class="lg lg-ok"></i>정상 자릿수</span><span><i class="lg lg-anom"></i>이상 자릿수</span></div></div>
    <div class="chart-title">일별 콜</div>
    ${days.length ? stackedBars({
      keys: days, series: series(byDay), labelEvery: Math.max(1, Math.ceil(days.length / 10)),
      labelOf: (d) => d.slice(5).replace('-', '/'),
      tipOf: (d) => `${d}(${weekdayKo(d)}) 정상 ${byDay.ok[d] || 0} · 이상 ${byDay.anom[d] || 0}`,
    }) : '<p class="muted">데이터 없음</p>'}
    <div class="chart-title">시간대별 콜</div>
    ${calls.length ? stackedBars({
      keys: hours, series: series(byHour), labelOf: (h) => `${h}시`, height: 120,
      tipOf: (h) => `${h}시대 정상 ${byHour.ok[h] || 0} · 이상 ${byHour.anom[h] || 0}`,
    }) : ''}`;
}

/* ---------------- 보고서 초안 / 사원별 요약 ---------------- */
function renderSummary(rows, code, s) {
  const box = $('#summaryCard');
  if (code) {
    const lines = draftSentences(s);
    box.innerHTML = `
      <div class="card-head"><h3>보고서 초안 ${infoIcon('선택 범위의 수치로 자동 작성')}</h3>
        <button class="btn btn-sm" data-act="copy-draft">문장 복사</button></div>
      <ul class="draft">${lines.map((l) => `<li>${esc(l)}</li>`).join('') || '<li class="muted">특이사항 없음</li>'}</ul>`;
    return;
  }
  box.innerHTML = `<div class="card-head"><h3>사원별 요약</h3><span class="muted small">행을 누르면 해당 사원 보기</span></div><div id="sumTable"></div>`;
  summaryTable = new DataTable($('#sumTable'), {
    pageSize: 50,
    onRowClick: (r) => emit('select-employee', r.code),
    columns: [
      { key: 'gubun', label: '구분', value: (r) => r.emp.gubun, html: (r) => esc(r.emp.gubun) },
      { key: 'team', label: '팀명', value: (r) => r.emp.team, html: (r) => esc(r.emp.team) },
      { key: 'name', label: '사원명', value: (r) => r.emp.name, html: (r) => `<b>${esc(r.emp.name)}</b> <span class="muted">${esc(r.code)}</span>` },
      { key: 'type', label: '점검유형', value: (r) => r.emp.target?.checkType, html: (r) => esc(r.emp.target?.checkType || '-') },
      { key: 'calls', label: '콜', align: 'right', html: (r) => fmtNum(r.calls) },
      { key: 'main', label: '주 자릿수', html: (r) => esc(r.main || '-') },
      { key: 'anomRate', label: '이상 비율', align: 'right', html: (r) => `<span class="${r.anomRate >= 0.2 ? 'txt-warn' : ''}">${fmtPct(r.anomRate)}</span>` },
      { key: 'anom', label: '이상 건수', align: 'right', html: (r) => fmtNum(r.anom) },
      { key: 'conc', label: '첫/막 집중률', align: 'right', tip: TIP.conc, html: (r) => `${fmtPct(r.conc)} <span class="muted small">/ ${fmtPct(r.baseline, 0)}</span>` },
      { key: 'mixedDays', label: '혼용일', align: 'right', tip: TIP.mixed, html: (r) => `${fmtNum(r.mixedDays)}<span class="muted small"> / ${fmtNum(r.digitDays)}일</span>` },
      { key: 'imp', label: '이동불가', align: 'right', html: (r) => `<span class="${r.imp ? 'txt-danger' : ''}">${fmtNum(r.imp)}</span>` },
      { key: 'dup', label: '좌표중복(최다)', align: 'right', value: (r) => r.dupList[0]?.count || 0, html: (r) => (r.dupList[0] ? `${r.dupList[0].count}회` : '-') },
      { key: 'special', label: '특이건', align: 'right', html: (r) => fmtNum(r.special) },
    ],
  });
  summaryTable.setRows(employeeSummaries(rows));
}

/* ---------------- 백데이터 ---------------- */
const speedHtml = (r) => {
  if (r.speed == null) return '';
  const v = Number.isFinite(r.speed) ? fmtNum(r.speed, 0) : '∞';
  return `<span class="${r.imp ? 'txt-danger strong' : ''}" title="${r.dist != null ? `${fmtNum(r.dist, 1)}km(${r.distSrc}) / ${r.dt}초` : ''}">${v}</span>`;
};

const BACK_COLUMNS = [
  { key: 'fav', label: '★', width: 36, align: 'center', value: (r) => (isFav(r) ? 1 : 0), html: (r) => `<button class="flag-btn sm ${isFav(r) ? 'on' : ''}" data-action="fav" aria-label="즐겨찾기">★</button>`, tip: '즐겨찾기 표시·해제' },
  { key: 'team', label: '팀명' },
  { key: 'name', label: '사원명' },
  { key: 'date', label: '일자', html: (r) => `${esc(r.date)} <span class="muted small">${weekdayKo(r.date)}</span>` },
  { key: 'seq', label: '방문순서', align: 'right' },
  { key: 'sec', label: '방문시간', html: (r) => esc(r.time) },
  { key: 'place', label: '거래처명', width: 160, cls: 'cell-wrap' },
  { key: 'amount', label: '총금액', align: 'right', html: (r) => (r.amount ? fmtNum(r.amount) : '') },
  { key: 'sido', label: '시도', html: (r) => (r.sido ? esc(r.sido) : r.regionInferred ? `<span class="muted" title="같은 거래처명 기록에서 보완">${esc(r.sidoN)}</span>` : '') },
  { key: 'sigungu', label: '시군구', html: (r) => (r.sigungu ? esc(r.sigungu) : r.regionInferred ? `<span class="muted" title="같은 거래처명 기록에서 보완">${esc(r.sggN)}</span>` : '') },
  { key: 'type', label: '구분', html: (r) => `<span class="badge ${r.type === '법카' ? 'badge-green' : 'badge-gray'}">${esc(r.type)}</span>` },
  { key: 'digits', label: '자릿수', html: (r) => (r.digits ? `<span class="badge ${r.anom ? 'badge-orange' : 'badge-blue'}">${esc(r.digits)}</span>` : '') },
  { key: 'phone', label: '구분(핸드폰)' },
  { key: 'distFile', label: '이동거리(km)', align: 'right', html: (r) => (r.distFile != null ? fmtNum(r.distFile, 1) : '') },
  { key: 'minFile', label: '이동시간(분)', align: 'right', html: (r) => (r.minFile != null ? fmtNum(r.minFile) : '') },
  { key: 'x', label: 'X좌표(수정)', html: (r) => `<span class="mono">${esc(r.xRaw)}</span>` },
  { key: 'fl', label: '첫/막콜', tip: '① 첫콜: 그날 첫 번째 콜\n② 막콜: 그날 마지막 콜', html: (r) => (r.fl ? `<span class="badge badge-purple">${esc(r.fl)}</span>` : '') },
  { key: 'speed', label: '이동속도(km/h)', align: 'right', tip: '직전 기록 → 현재 기록 속도\n(위치 제외 거래처 제외)', value: (r) => (r.speed == null ? null : Number.isFinite(r.speed) ? r.speed : 1e9), html: speedHtml },
  { key: 'reason', label: '판정', value: (r) => reasonsOf(r).join(','), html: (r) => reasonsOf(r).map((x) => `<span class="badge ${/불가|중복/.test(x) ? 'badge-red' : x === '위치제외' ? 'badge-gray' : 'badge-orange'}">${esc(x)}</span>`).join(' ') },
];

const QUICK = [
  ['all', '전체'], ['call', '콜'], ['card', '법카'], ['special', '특이건'], ['fav', '★ 즐겨찾기'], ['anom', '이상 자릿수'],
  ['fl', '첫·막콜'], ['imp', '이동불가'], ['dup', '좌표중복'],
];
const QUICK_FN = {
  all: () => true, call: (r) => r.type === '콜', card: (r) => r.type === '법카', special: isSpecial, fav: isFav, anom: (r) => r.anom,
  fl: (r) => !!r.fl, imp: (r) => r.imp, dup: (r) => r.dupX > 0,
};

export function initBackTable() {
  $('#quickFilters').innerHTML = QUICK.map(([k, l]) => `<button class="chip ${k === quick ? 'on' : ''}" data-quick="${k}">${l}</button>`).join('');
  $('#quickFilters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-quick]');
    if (!b) return;
    quick = b.dataset.quick;
    $('#quickFilters').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
    updateBackTable();
  });
  let t;
  $('#backSearch').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { search = e.target.value.trim(); updateBackTable(); }, 200);
  });
  $('#backExport').addEventListener('click', exportBack);
  backTable = new DataTable($('#backTable'), {
    pageSize: state.settings.pageSize,
    onPageSize: (n) => { state.settings.pageSize = n; saveSettings(); },
    columns: BACK_COLUMNS,
    rowClass: (r) => (r.imp ? 'row-imp' : r.anom ? 'row-anom' : ''),
    onRowClick: (r) => emit('open-panel', { code: r.code, date: r.date, focusKey: r.placeKey, focusRowId: r.id, locate: true }),
    onAction: (act, r) => { if (act === 'fav') emit('toggle-fav', r); },
  });
  // 대시보드 내 버튼
  const view = $('#view-dashboard');
  view.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'home') emit('edit-home', currentCode);
    if (act === 'copy-draft') {
      const txt = [...document.querySelectorAll('.draft li')].map((li) => `- ${li.textContent}`).join('\n');
      navigator.clipboard?.writeText(txt).then(() => toast('보고서 초안을 복사했습니다.', 'ok'), () => toast('복사에 실패했습니다.', 'error'));
    }
  });
  // 이동불가 속도 범위: 하한(초과) < 상한(미만) 유지, 상한이 끝값(200 이상)이면 상한 없음
  const speedInputs = () => [$('#speedMin'), $('#speedMax')];
  view.addEventListener('input', (e) => {
    if (e.target.id !== 'speedMin' && e.target.id !== 'speedMax') return;
    const [lo, hi] = speedInputs();
    if (Number(hi.value) - Number(lo.value) < SPEED_STEP) {
      if (e.target === lo) lo.value = Number(hi.value) - SPEED_STEP;
      else hi.value = Number(lo.value) + SPEED_STEP;
    }
    paintSpeedSlider(lo.parentElement);
  });
  view.addEventListener('change', (e) => {
    if (e.target.id !== 'speedMin' && e.target.id !== 'speedMax') return;
    const [lo, hi] = speedInputs();
    state.settings.speedLimit = Number(lo.value);
    state.settings.speedMax = Number(hi.value) >= Number(hi.max) ? 0 : Number(hi.value);
    saveSettings();
    emit('settings-changed');
  });
}

function backRows() {
  const fn = QUICK_FN[quick] || QUICK_FN.all;
  const q = search.toLowerCase();
  return currentRows.filter((r) => fn(r) && (!q || r.place.toLowerCase().includes(q) || r.name.includes(q) || r.region.includes(q)));
}

export function updateBackTable(keepPage = false) {
  if (!backTable) return;
  const rows = backRows();
  $('#backCount').textContent = `${fmtNum(rows.length)}건`;
  backTable.setRows(rows, { keepPage });
}

export function setDashboardRows(rows, code) {
  currentRows = rows;
  currentCode = code;
  renderEmployeeHead(code, rows);
  renderKpis(rows, code);
  updateBackTable();
}

export function refreshFlagsInDashboard() {
  renderKpis(currentRows, currentCode);
  updateBackTable(true);
}

function exportBack() {
  const rows = backRows();
  const head = ['사원코드', '팀명', '사원명', '일자', '방문순서', '방문시간', '거래처명', '총금액', '시도', '시군구', '구분', '자릿수', '구분(핸드폰)', '이동거리(km)', '이동시간(분)', 'X좌표(수정)', '첫/막콜', '계산거리(km)', '거리출처', '시간차(초)', '이동속도(km/h)', '판정', '특이건', '즐겨찾기', '비고'];
  const data = rows.map((r) => [
    r.code, r.team, r.name, r.date, r.seq, r.time, r.place, r.amount, r.sido, r.sigungu, r.type, r.digits, r.phone, r.distFile, r.minFile, r.xRaw,
    r.fl, r.dist != null ? Math.round(r.dist * 100) / 100 : '', r.distSrc, r.dt ?? '', r.speed == null ? '' : Number.isFinite(r.speed) ? Math.round(r.speed) : '∞',
    reasonsOf(r).join(', '), isSpecial(r) ? 'Y' : '', isFav(r) ? 'Y' : '', state.memos[r.id] || '',
  ]);
  exportXlsx(`GPS콜_백데이터_${new Date().toISOString().slice(0, 10)}.xlsx`, [{ name: '백데이터', rows: [head, ...data] }]);
}
