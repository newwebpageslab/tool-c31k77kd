// 분석 로직: 주 사용 자릿수, 첫/막콜, 이동속도·이동불가, 위치 불명확, 좌표 중복, 연속 반복콜, 통계

import { state } from './store.js';
import { haversineKm, lngDiffKm, fmtPct, fmtNum } from './util.js';

export const GOOD_GEO = new Set(['auto', 'gps', 'manual']);

/** 지도에 표시 가능한(확정된) 거래처 좌표 */
export function placeCoords(key) {
  const g = state.geo[key];
  return g && GOOD_GEO.has(g.status) && Number.isFinite(g.lat) && Number.isFinite(g.lng) ? g : null;
}

/** 위치 제외 거래처: 위치 관리에서 직접 지정했거나 거래처명에 제외 키워드가 포함되면 제외 */
export function isExcludedPlace(name, key) {
  return !!state.placeExcludes[key] || excludeKeywordsOf(name).length > 0;
}

/** 거래처명에 포함된 제외 키워드 목록 */
export function excludeKeywordsOf(name) {
  return state.settings.excludeKeywords.filter((k) => k && name.includes(k));
}

/** 이동불가 속도 범위 문구: "80km/h 초과 100km/h 미만" */
export function speedRangeText(S = state.settings) {
  return S.speedMax ? `${S.speedLimit}km/h 초과 ${S.speedMax}km/h 미만` : `${S.speedLimit}km/h 초과`;
}

/** 특이건: 이상 자릿수 · 이동불가 · 좌표중복 (자동 판정, 항상 목록에 표시) */
export function isSpecial(r) {
  return !!(r.anom || r.imp || r.dupX);
}

/** 즐겨찾기 ★ (사용자가 직접 표시, 기본 없음) */
export function isFav(r) {
  return !!state.favs[r.id];
}

export function otherDigit(main) {
  if (main === '7자리') return '13자리';
  if (main === '13자리') return '7자리';
  return '';
}

export const deviceOf = (digits) => (digits === '13자리' ? '애플·조작앱' : digits === '7자리' ? '삼성(갤럭시)' : '');

/** 데이터 전체에 파생값 계산(설정·좌표가 바뀔 때마다 다시 호출) */
export function computeAll() {
  const ds = state.dataset;
  if (!ds) return;
  const S = state.settings;
  const rows = ds.rows;

  // 주 사용 자릿수(사원별 전체 기간 기준)
  const digitCnt = {};
  for (const r of rows) {
    if (r.type !== '콜' || !r.digits) continue;
    const c = (digitCnt[r.code] ||= {});
    c[r.digits] = (c[r.digits] || 0) + 1;
  }
  for (const e of Object.values(ds.employees)) {
    const c = digitCnt[e.code] || {};
    e.digitCounts = c;
    e.mainDigit = Object.keys(c).sort((a, b) => c[b] - c[a])[0] || '';
  }

  // 좌표 중복(사원별 동일 X좌표가 서로 다른 일자 또는 거래처에서 반복)
  const dupMap = new Map();
  for (const r of rows) {
    r.xKey = r.x != null && r.type === '콜' ? `${r.code}|${r.x.toFixed(10)}` : null;
    if (!r.xKey) continue;
    let d = dupMap.get(r.xKey);
    if (!d) dupMap.set(r.xKey, (d = { count: 0, dates: new Set(), places: new Set() }));
    d.count++;
    d.dates.add(r.date);
    d.places.add(r.placeKey);
  }

  // 일자별 그룹
  const days = new Map();
  for (const r of rows) {
    const k = `${r.code}|${r.date}`;
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(r);
  }

  for (const dayRows of days.values()) {
    dayRows.sort((a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9) || (a.sec ?? 0) - (b.sec ?? 0) || a.ord - b.ord);
    const main = ds.employees[dayRows[0].code]?.mainDigit;
    const calls = dayRows.filter((r) => r.type === '콜');
    const first = calls[0];
    const last = calls[calls.length - 1];

    let lastValid = null;
    let prev = null;
    let runStart = 0;
    dayRows.forEach((r, i) => {
      r.dayIndex = i + 1;
      r.fl = r === first && r === last ? '첫·막콜' : r === first ? '첫콜' : r === last ? '막콜' : '';
      r.anom = r.type === '콜' && !!r.digits && !!main && r.digits !== main;
      r.excl = isExcludedPlace(r.place, r.placeKey);
      r.dt = r.dist = r.speed = null;
      r.distSrc = '';
      r.imp = false;
      r.prevId = null;

      // 좌표 중복
      const d = r.xKey ? dupMap.get(r.xKey) : null;
      r.dupX = d && d.count >= 2 && (d.dates.size >= 2 || d.places.size >= 2) ? d.count : 0;

      // 위치 불명확(콜 X좌표 vs 거래처 확정 좌표): 문제 판정이 아니라 지도 좌표 정확도 참고용
      r.misKm = null;
      r.mis = false;
      if (r.type === '콜' && r.x != null && !r.excl) {
        const c = placeCoords(r.placeKey);
        if (c) {
          r.misKm = r.y != null ? haversineKm(r.y, r.x, c.lat, c.lng) : lngDiffKm(r.x, c.lng, c.lat);
          r.mis = r.misKm > S.mismatchKm;
        }
      }

      // 이동속도: 위치 제외 거래처는 건너뛰고 직전 유효 기록과 비교
      if (!r.excl) {
        if (lastValid) {
          r.prevId = lastValid.id;
          r.dt = r.sec != null && lastValid.sec != null ? r.sec - lastValid.sec : null;
          const adjacent = prev === lastValid;
          const cA = placeCoords(lastValid.placeKey);
          const cB = placeCoords(r.placeKey);
          const mapDist = cA && cB ? haversineKm(cA.lat, cA.lng, cB.lat, cB.lng) : null;
          if (S.distPriority === 'file' && adjacent && r.distFile != null) { r.dist = r.distFile; r.distSrc = '엑셀'; }
          else if (mapDist != null) { r.dist = mapDist; r.distSrc = '지도'; }
          else if (adjacent && r.distFile != null) { r.dist = r.distFile; r.distSrc = '엑셀'; }
          if (r.dist != null && r.dt != null && r.dt >= 0) {
            r.speed = r.dt > 0 ? r.dist / (r.dt / 3600) : r.dist > 0 ? Infinity : 0;
            // 이동불가: 속도 범위(초과 ~ 미만) 안 + 앞뒤 기록이 위치 제외 거래처가 아닐 때
            const nearExcl = !!(dayRows[i - 1]?.excl || dayRows[i + 1]?.excl);
            r.imp = !nearExcl && r.dist >= S.minDistKm && r.speed > S.speedLimit && (!S.speedMax || r.speed < S.speedMax);
          }
        }
        lastValid = r;
      }

      // 연속 반복콜(같은 거래처에서 연달아 등록)
      if (i > 0 && !(r.type === '콜' && prev.type === '콜' && prev.placeKey === r.placeKey)) runStart = i;
      const len = i - runStart + 1;
      for (let j = runStart; j <= i; j++) dayRows[j].run = r.type === '콜' ? len : 1;
      prev = r;
    });
  }
}

/** 선택 범위 통계 */
export function calcStats(rows, code = null) {
  const emp = code ? state.dataset.employees[code] : null;
  const calls = rows.filter((r) => r.type === '콜');
  const cards = rows.filter((r) => r.type === '법카');
  const anom = calls.filter((r) => r.anom);
  const flCalls = calls.filter((r) => r.fl);
  const flAnom = anom.filter((r) => r.fl);
  const digit = {};
  for (const r of calls) if (r.digits) digit[r.digits] = (digit[r.digits] || 0) + 1;

  const dupGroups = new Map();
  for (const r of calls) {
    if (!r.dupX) continue;
    let g = dupGroups.get(r.xKey);
    if (!g) dupGroups.set(r.xKey, (g = { x: r.xRaw || String(r.x), code: r.code, name: r.name, count: 0, dates: new Set(), places: new Set() }));
    g.count++;
    g.dates.add(r.date);
    g.places.add(r.place);
  }
  const dupList = [...dupGroups.values()].sort((a, b) => b.count - a.count);

  const regions = new Map();
  for (const r of rows) {
    if (r.excl) continue;
    const g = regions.get(r.region) || { region: r.region, calls: 0, callsAnom: 0, cards: 0 };
    if (r.type === '콜') { g.calls++; if (r.anom) g.callsAnom++; }
    else g.cards++;
    regions.set(r.region, g);
  }

  // 일자별 자릿수: 같은 날 7·13자리가 섞인 "혼용일"과 특정 일자 이후 주 자릿수가 바뀐 "전환"
  const dayDigit = new Map();
  for (const r of calls) {
    if (!r.digits) continue;
    const k = `${r.code}|${r.date}`;
    const d = dayDigit.get(k) || {};
    d[r.digits] = (d[r.digits] || 0) + 1;
    dayDigit.set(k, d);
  }
  const mixedDays = [...dayDigit.values()].filter((d) => Object.keys(d).length > 1).length;
  const digitSwitch = code ? detectDigitSwitch(dayDigit) : null;

  const midCalls = calls.length - flCalls.length;
  return {
    mixedDays,
    digitDays: dayDigit.size,
    digitSwitch,
    emp,
    rows: rows.length,
    calls: calls.length,
    cards: cards.length,
    cardAmount: cards.reduce((s, r) => s + (r.amount || 0), 0),
    days: new Set(rows.map((r) => `${r.code}|${r.date}`)).size,
    employees: new Set(rows.map((r) => r.code)).size,
    digit,
    main: emp?.mainDigit || '',
    mainCount: emp ? digit[emp.mainDigit] || 0 : null,
    anom: anom.length,
    anomRate: calls.length ? anom.length / calls.length : null,
    conc: anom.length ? flAnom.length / anom.length : null,
    baseline: calls.length ? flCalls.length / calls.length : null,
    flAnomRate: flCalls.length ? flAnom.length / flCalls.length : null,
    midAnomRate: midCalls ? (anom.length - flAnom.length) / midCalls : null,
    firstAnom: anom.filter((r) => r.fl.includes('첫')).length,
    lastAnom: anom.filter((r) => r.fl.includes('막')).length,
    flAnom: flAnom.length,
    imp: rows.filter((r) => r.imp).length,
    mis: calls.filter((r) => r.mis).length,
    misChecked: calls.filter((r) => r.misKm != null).length,
    dupList,
    dupRows: calls.filter((r) => r.dupX).length,
    maxRun: calls.reduce((m, r) => Math.max(m, r.run || 0), 0),
    special: rows.filter(isSpecial).length,
    favs: rows.filter(isFav).length,
    regions: [...regions.values()].sort((a, b) => b.calls + b.cards - (a.calls + a.cards)),
  };
}

/** 일자별 다수 자릿수가 어느 날을 기점으로 바뀌어 유지되는지 탐지(기기 변경 가능성) */
function detectDigitSwitch(dayDigit) {
  const days = [...dayDigit.entries()]
    .map(([k, d]) => ({ date: k.split('|')[1], major: Object.keys(d).sort((a, b) => d[b] - d[a])[0] }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const n = days.length;
  let best = null;
  for (let k = 5; k <= n - 5; k++) {
    const from = days[0].major;
    const to = days[k].major;
    if (from === to) continue;
    const agree = days.slice(0, k).filter((d) => d.major === from).length + days.slice(k).filter((d) => d.major === to).length;
    const score = agree / n;
    if (score >= 0.85 && (!best || score > best.score)) best = { date: days[k].date, from, to, score };
  }
  return best;
}

/** 사원별 요약 행(전체 보기용) */
export function employeeSummaries(rows) {
  const byCode = new Map();
  for (const r of rows) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }
  return [...byCode.entries()].map(([code, rs]) => {
    const s = calcStats(rs, code);
    return { code, ...s, emp: state.dataset.employees[code] };
  });
}

/** 판정 사유 문자열 */
export function reasonsOf(r) {
  const out = [];
  if (r.anom) out.push('이상자릿수');
  if (r.anom && r.fl) out.push(r.fl);
  if (r.imp) out.push('이동불가');
  if (r.dupX) out.push('좌표중복');
  if (r.run >= 5) out.push(`반복${r.run}회`);
  if (r.excl) out.push('위치제외');
  return out;
}

/** 보고서 초안 문장 */
export function draftSentences(s) {
  if (!s.emp) return [];
  const S = state.settings;
  const main = s.main;
  const other = otherDigit(main);
  const out = [];
  if (main && s.calls) {
    const mainShare = (s.mainCount || 0) / s.calls;
    let line = `${main} 콜(${fmtPct(mainShare, 0)})을 기본으로 사용하는 담당자`;
    if (s.anom) {
      line += main === '7자리' ? '임에도' : '이나,';
      line += ` ${other} 콜(${fmtPct(s.anomRate, 0)}, ${fmtNum(s.anom)}건)이`;
      if (s.conc != null && s.baseline != null && s.anom >= 3 && s.conc >= s.baseline * 1.5) {
        line += ` 첫·막콜에 집중되어 발생함(이상 콜의 ${fmtPct(s.conc, 0)}가 첫·막콜로, 기대치 ${fmtPct(s.baseline, 0)}의 ${fmtNum(s.conc / s.baseline, 1)}배).`;
      } else line += ' 발생함.';
    } else line += '로 이상 자릿수 콜은 확인되지 않음.';
    out.push(line);
  }
  if (s.mixedDays) out.push(`7자리·13자리 콜이 같은 날 함께 등록된 날이 ${fmtNum(s.mixedDays)}일(콜 등록일 ${fmtNum(s.digitDays)}일 중) 확인됨.`);
  if (s.digitSwitch) out.push(`${s.digitSwitch.date} 이후 ${s.digitSwitch.to} 콜 위주로 전환됨(기기 변경 여부 확인 필요).`);
  if (s.imp) out.push(`거래처 간 이동속도가 ${speedRangeText(S)}로 이동이 불가능한 구간이 ${fmtNum(s.imp)}건 확인됨.`);
  if (s.dupList.length) {
    const d = s.dupList[0];
    out.push(`동일한 X좌표(${d.x})가 ${d.count}회(${d.dates.size}개 일자, ${d.places.size}개 거래처) 반복 등록됨.`);
  }
  return out;
}
