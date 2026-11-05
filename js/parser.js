// 엑셀 파싱: 파일별로 "점검대상자" 시트와 사원별(소속_이름) 시트를 읽고, 여러 파일을 사원코드 기준으로 취합

import { normDate, parseTimeToSec, secToHMS } from './util.js';

const clean = (s) => String(s ?? '').replace(/\s+/g, '').trim();
const text = (s) => String(s ?? '').trim();
const toNum = (v) => {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/* ---------- 지역명 정규화 ---------- */
const SIDO_SHORT = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
const SIDO_FULL = [
  ['충청북도', '충북'], ['충청남도', '충남'], ['전라북도', '전북'], ['전북특별자치도', '전북'],
  ['전라남도', '전남'], ['경상북도', '경북'], ['경상남도', '경남'],
];
export const METRO = new Set(['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종']);

export function normSido(s) {
  const c = clean(s);
  if (!c) return '';
  for (const [full, short] of SIDO_FULL) if (c.startsWith(full)) return short;
  const two = c.slice(0, 2);
  return SIDO_SHORT.includes(two) ? two : c;
}

/** "인천부평구" → "부평구", "경기도 성남시" → "성남시" (시도 접두어 제거) */
export function normSigungu(sgg, sido) {
  let c = clean(sgg);
  if (!c) return '';
  for (const [full] of SIDO_FULL) if (c.startsWith(full) && c.length > full.length) c = c.slice(full.length);
  const longPrefix = c.match(/^(서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|경기도|강원특별자치도|강원도|제주특별자치도)/);
  if (longPrefix && c.length > longPrefix[0].length) c = c.slice(longPrefix[0].length);
  const sd = sido || c.slice(0, 2);
  if (SIDO_SHORT.includes(sd) && c.startsWith(sd) && c.length > sd.length + 1) c = c.slice(sd.length);
  // "창원시의창구" → "창원의창구" (원본 데이터의 표기 방식으로 통일)
  const cityGu = c.match(/^(\S{2,}?)시(\S+구)$/);
  if (cityGu) c = cityGu[1] + cityGu[2];
  return c;
}

/** 사용지역 분석용 지역 단위: 광역시는 "인천 부평구", 도는 "충북 청주시" */
export function regionLabel(sido, sgg) {
  if (!sido && !sgg) return '지역 미상';
  if (!sgg) return sido;
  if (!sido) return sgg;
  if (METRO.has(sido)) return `${sido} ${sgg}`;
  const m = sgg.match(/^(.+?[시군])/);
  if (m) return `${sido} ${m[1]}`;
  if (sgg.endsWith('구') && sgg.length >= 4) return `${sido} ${sgg.slice(0, 2)}시`;
  return `${sido} ${sgg}`;
}

const toAoa = (ws) => XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: false });

function decimalsOf(raw) {
  const s = String(raw);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** 엑셀 파일 1개 → 점검대상자 목록 + 원시 행 */
export function parseFile(wb, fileName) {
  const warnings = [];
  const targets = [];

  const targetName = wb.SheetNames.find((n) => clean(n).includes('점검대상자'));
  if (targetName) {
    const aoa = toAoa(wb.Sheets[targetName]);
    const hi = aoa.findIndex((r) => r.some((c) => clean(c) === '사원코드'));
    if (hi >= 0) {
      const H = aoa[hi].map(clean);
      const get = (r, n) => { const i = H.indexOf(n); return i < 0 ? '' : text(r[i]); };
      for (const r of aoa.slice(hi + 1)) {
        const code = get(r, '사원코드');
        if (!code) continue;
        const info = {
          code, gubun: get(r, '구분'), team: get(r, '팀명'), name: get(r, '사원명'),
          checkType: get(r, '점검유형'), checkValue: get(r, '점검값'), checkNote: get(r, '처리여부'), sheet: get(r, '시트명'),
        };
        if (!info.sheet) info.sheet = `${info.gubun}_${info.name}`;
        targets.push(info);
      }
    } else warnings.push(`[${fileName}] "점검대상자" 시트에 "사원코드" 열이 없습니다.`);
  }

  const rows = [];
  for (const sn of wb.SheetNames) {
    if (sn === targetName) continue;
    const aoa = toAoa(wb.Sheets[sn]);
    const hi = aoa.slice(0, 15).findIndex((r) => {
      const c = r.map(clean);
      return c.includes('거래처명') && c.includes('일자');
    });
    if (hi < 0) {
      warnings.push(`[${fileName}] "${sn}" 시트: 머리글(일자·거래처명)이 없어 건너뜀`);
      continue;
    }
    const H = aoa[hi].map(clean);
    const col = (...names) => {
      for (const n of names) { const i = H.indexOf(n); if (i >= 0) return i; }
      for (const n of names) { const i = H.findIndex((h) => h.startsWith(n)); if (i >= 0) return i; }
      return -1;
    };
    const C = {
      team: col('팀명'), name: col('사원명'), code: col('사원코드', '사번'), date: col('일자'), seq: col('방문순서'),
      time: col('방문시간(time)', '방문시간'), place: col('거래처명'), amount: col('총금액', '금액'),
      sido: col('시도'), sgg: col('시군구'), type: H.indexOf('구분'), digits: col('자릿수'),
      phone: col('구분(핸드폰)'), dist: col('이동거리(km)', '이동거리'), mins: col('이동시간(분)', '이동시간'),
      x: col('X좌표(수정)', 'X좌표'), y: col('Y좌표(수정)', 'Y좌표'),
    };
    let skipped = 0;
    for (let i = hi + 1; i < aoa.length; i++) {
      const r = aoa[i];
      const g = (k) => (C[k] >= 0 ? r[C[k]] : '');
      const place = text(g('place'));
      const date = normDate(g('date'));
      if (!place && !date) continue;
      if (!date || !place) { skipped++; continue; }
      const typeRaw = clean(g('type'));
      const type = typeRaw.includes('카') ? '법카' : '콜';
      const xRaw = g('x');
      const x = toNum(xRaw);
      let digits = clean(g('digits'));
      const dm = digits.match(/\d+/);
      digits = dm ? `${dm[0]}자리` : '';
      if (!digits && type === '콜' && x != null) digits = decimalsOf(xRaw) >= 10 ? '13자리' : '7자리';
      const sec = parseTimeToSec(g('time'));
      rows.push({
        file: fileName, sheet: sn, codeCol: text(g('code')),
        team: text(g('team')), name: text(g('name')), date, seq: toNum(g('seq')), sec,
        time: sec == null ? text(g('time')) : secToHMS(sec), place, amount: toNum(g('amount')),
        sido: text(g('sido')), sigungu: text(g('sgg')), type, digits, phone: text(g('phone')),
        distFile: toNum(g('dist')), minFile: toNum(g('mins')),
        x, xRaw: xRaw === '' || xRaw == null ? '' : String(xRaw), y: toNum(g('y')),
      });
    }
    if (skipped) warnings.push(`[${fileName}] "${sn}" 시트: 일자·거래처명이 빈 ${skipped}행 제외`);
  }
  return { fileName, targets, rows, warnings };
}

/**
 * 여러 파일 결과(+기존 데이터)를 사원코드 기준으로 취합해 데이터셋 생성
 * @param {Array} parts parseFile 결과 목록
 * @param {object|null} base 기존 데이터셋(추가 모드일 때)
 */
export function buildDataset(parts, base = null) {
  const warnings = parts.flatMap((p) => p.warnings);
  const targetBySheet = {};
  const targetByCode = {};
  for (const t of [...(base?.targets || []), ...parts.flatMap((p) => p.targets)]) {
    targetBySheet[clean(t.sheet)] = t;
    targetByCode[t.code] = t;
  }
  const hasTargets = Object.keys(targetByCode).length > 0;

  // 행 취합: 파일 간 동일한 기록은 한 번만 반영(같은 파일 안의 동일 기록은 유지)
  const rows = [];
  const globalCount = new Map();
  const contentKey = (r) => `${r.code}|${r.date}|${r.sec ?? r.time}|${r.place}|${r.type}|${r.xRaw}|${r.amount ?? ''}`;
  const addSource = (list) => {
    const local = new Map();
    let dup = 0;
    for (const r of list) {
      const k = contentKey(r);
      const n = (local.get(k) || 0) + 1;
      local.set(k, n);
      if (n <= (globalCount.get(k) || 0)) { dup++; continue; }
      globalCount.set(k, n);
      rows.push(r);
    }
    return dup;
  };
  if (base?.rows) addSource(base.rows);
  // 시트 → 점검대상자 매칭: ① 시트명 일치 ② 시트명 포함(엑셀 31자 잘림 등) ③ 사원명 일치(유일할 때)
  const targets = Object.values(targetByCode);
  const sheetTarget = new Map();
  const findTarget = (sheet, sheetRows) => {
    const cs = clean(sheet);
    if (targetBySheet[cs]) return targetBySheet[cs];
    const part = targets.filter((t) => clean(t.sheet) && (clean(t.sheet).includes(cs) || cs.includes(clean(t.sheet))));
    if (part.length === 1) return part[0];
    const nameCount = {};
    for (const r of sheetRows) if (r.name) nameCount[r.name] = (nameCount[r.name] || 0) + 1;
    const rowName = Object.keys(nameCount).sort((a, b) => nameCount[b] - nameCount[a])[0];
    for (const nm of [rowName, sheet.split('_').pop()].filter(Boolean)) {
      const byName = targets.filter((t) => clean(t.name) === clean(nm));
      if (byName.length === 1) return byName[0];
    }
    return null;
  };
  const unmapped = new Set();
  for (const p of parts) {
    const bySheet = new Map();
    for (const r of p.rows) {
      if (!bySheet.has(r.sheet)) bySheet.set(r.sheet, []);
      bySheet.get(r.sheet).push(r);
    }
    for (const [sheet, rs] of bySheet) sheetTarget.set(`${p.fileName}|${sheet}`, findTarget(sheet, rs));
    for (const r of p.rows) {
      const t = sheetTarget.get(`${p.fileName}|${r.sheet}`);
      r.code = r.codeCol || t?.code || `시트:${r.sheet}`;
      r.gubun = t?.gubun || (r.sheet.includes('_') ? r.sheet.split('_')[0] : '');
      if (!r.codeCol && !t && hasTargets) unmapped.add(r.sheet);
    }
    const dup = addSource(p.rows);
    if (dup) warnings.push(`[${p.fileName}] 이미 불러온 기록과 중복된 ${dup}건은 한 번만 반영`);
  }
  for (const sn of unmapped) warnings.push(`"${sn}" 시트가 점검대상자 목록에 없어 시트명을 사원 식별값으로 사용`);
  if (!hasTargets) warnings.push('"점검대상자" 시트가 없어 시트명을 사원 식별값으로 사용');

  rows.forEach((r, i) => { r.ord = i; });

  // 지역 정규화 + 빈 지역은 같은 거래처명의 유일한 지역으로 보완
  const regionsByName = new Map();
  for (const r of rows) {
    r.sidoN = normSido(r.sido);
    r.sggN = normSigungu(r.sigungu, r.sidoN);
    if (r.sidoN || r.sggN) {
      if (!regionsByName.has(r.place)) regionsByName.set(r.place, new Set());
      regionsByName.get(r.place).add(`${r.sidoN}|${r.sggN}`);
    }
  }
  for (const r of rows) {
    r.regionInferred = false;
    if (!r.sidoN && !r.sggN) {
      const set = regionsByName.get(r.place);
      if (set && set.size === 1) {
        [r.sidoN, r.sggN] = [...set][0].split('|');
        r.regionInferred = true;
      }
    }
    r.placeKey = `${r.sidoN}|${r.sggN}|${r.place.replace(/\s+/g, ' ')}`;
    r.region = regionLabel(r.sidoN, r.sggN);
  }

  // 행 고유 ID(재업로드해도 동일하게 유지되도록 내용 기반)
  const seen = new Map();
  for (const r of rows) {
    const idBase = `${r.code}|${r.date}|${r.sec ?? r.time}|${r.place}`;
    const n = (seen.get(idBase) || 0) + 1;
    seen.set(idBase, n);
    r.id = n > 1 ? `${idBase}#${n}` : idBase;
  }

  // 사원 정보(사원코드 기준) — 최신 팀명·사원명은 가장 최근 일자의 행
  const employees = {};
  const sorted = [...rows].sort((a, b) => (a.date === b.date ? (a.seq ?? 0) - (b.seq ?? 0) : a.date < b.date ? -1 : 1));
  for (const r of sorted) {
    const e = employees[r.code] || (employees[r.code] = {
      code: r.code, gubun: r.gubun, team: '', name: '', teams: [], names: [], sheets: [], target: targetByCode[r.code] || null,
    });
    if (r.team && !e.teams.includes(r.team)) e.teams.push(r.team);
    if (r.name && !e.names.includes(r.name)) e.names.push(r.name);
    if (!e.sheets.includes(r.sheet)) e.sheets.push(r.sheet);
    if (r.team) e.team = r.team;
    if (r.name) e.name = r.name;
    if (!e.gubun && r.gubun) e.gubun = r.gubun;
  }
  for (const e of Object.values(employees)) {
    if (!e.name) e.name = e.target?.name || e.code;
    if (!e.team) e.team = e.target?.team || '';
    if (!e.gubun) e.gubun = e.target?.gubun || '';
  }

  const dates = rows.map((r) => r.date).sort();
  const fileNames = [...new Set([...(base?.fileNames || []), ...parts.map((p) => p.fileName)])];
  return {
    fileName: fileNames.length > 1 ? `${fileNames[0]} 외 ${fileNames.length - 1}개` : fileNames[0] || '',
    fileNames,
    loadedAt: new Date().toISOString(),
    rows,
    employees,
    targets: Object.values(targetByCode),
    period: { min: dates[0] || '', max: dates[dates.length - 1] || '' },
    warnings,
  };
}
