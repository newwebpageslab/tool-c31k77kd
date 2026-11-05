// 카카오 지도 SDK 로드 및 거래처 위치 검색(지오코딩)
// 외부 전송 범위: 거래처명 + 시도/시군구(검색어)만 카카오 장소검색 API로 전송된다. 사원명·사번은 전송하지 않는다.

import { state, save, emit } from './store.js';
import { normSido } from './parser.js';
import { isExcludedPlace } from './analysis.js';
import { median, lngDiffKm, sleep } from './util.js';

let loadPromise = null;
let kakaoReady = false;
export const isKakaoReady = () => kakaoReady;

export function loadKakao(key) {
  if (kakaoReady) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    if (!key) { reject(new Error('설정에서 카카오 JavaScript 키를 입력하세요.')); return; }
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services,clusterer&autoload=false`;
    const timer = setTimeout(() => reject(new Error(`카카오 지도 응답이 없습니다. 키와 등록 도메인(${location.origin})을 확인하세요.`)), 12000);
    s.onload = () => {
      if (!window.kakao?.maps?.load) { clearTimeout(timer); reject(new Error('카카오 SDK 초기화에 실패했습니다. 키를 확인하세요.')); return; }
      window.kakao.maps.load(() => { clearTimeout(timer); kakaoReady = true; resolve(); });
    };
    s.onerror = () => { clearTimeout(timer); reject(new Error('카카오 SDK를 불러오지 못했습니다. 키·도메인 등록·네트워크를 확인하세요.')); };
    document.head.appendChild(s);
  });
  loadPromise.catch(() => { loadPromise = null; });
  return loadPromise;
}

let placesSvc = null;
let geocoderSvc = null;

/** 장소 키워드 검색. 오류 시 null, 결과 없음은 [] */
export function keywordSearch(query) {
  placesSvc ||= new kakao.maps.services.Places();
  const { Status } = kakao.maps.services;
  return new Promise((resolve) => {
    placesSvc.keywordSearch(query, (data, status) => {
      if (status === Status.OK) resolve(data);
      else if (status === Status.ZERO_RESULT) resolve([]);
      else resolve(null);
    }, { size: 15 });
  });
}

export function addressSearch(query) {
  geocoderSvc ||= new kakao.maps.services.Geocoder();
  const { Status } = kakao.maps.services;
  return new Promise((resolve) => {
    geocoderSvc.addressSearch(query, (data, status) => resolve(status === Status.OK ? data : []));
  });
}

const compactName = (s) => String(s || '')
  .replace(/\(.*?\)|\[.*?\]/g, '')
  .replace(/의료법인|재단법인|사단법인|학교법인|주식회사|㈜|\(주\)/g, '')
  .replace(/[\s·.,\-_]/g, '')
  .toLowerCase();

function nameScore(a, b) {
  const x = compactName(a);
  const y = compactName(b);
  if (!x || !y) return 0;
  if (x === y) return 3;
  if (x.includes(y) || y.includes(x)) return 2;
  return 1;
}

function regionMatch(addr, sidoN, sggN) {
  const t = String(addr || '').split(/\s+/);
  const sidoOk = !sidoN || normSido(t[0]) === sidoN;
  if (!sggN || sidoN === '세종') return { sidoOk, sggOk: true };
  const t1 = t[1] || '';
  const t2 = t[2] || '';
  const variants = new Set([t1, t1 + t2, t1.replace(/시$/, '') + t2, t2]);
  return { sidoOk, sggOk: variants.has(sggN) };
}

function toCandidate(d, place, gpsX) {
  const lat = Number(d.y);
  const lng = Number(d.x);
  return {
    id: d.id,
    name: d.place_name,
    addr: d.road_address_name || d.address_name,
    jibun: d.address_name,
    cat: d.category_group_code || '',
    catName: (d.category_name || '').split('>').pop().trim(),
    lat,
    lng,
    ns: nameScore(place.name, d.place_name),
    rm: regionMatch(d.address_name, place.sidoN, place.sggN),
    gpsKm: gpsX != null ? lngDiffKm(lng, gpsX, lat) : null,
  };
}

/** 거래처 목록(placeKey 기준) 생성 */
export function buildPlaces() {
  const ds = state.dataset;
  if (!ds) return [];
  const map = new Map();
  for (const r of ds.rows) {
    let p = map.get(r.placeKey);
    if (!p) {
      const pe = state.placeEdits[r.placeKey] || {};
      p = {
        key: r.placeKey, name: r.place, rawSido: r.sido, rawSgg: r.sigungu,
        sidoN: pe.sido != null ? normSido(pe.sido) : r.sidoN,
        sggN: pe.sigungu != null ? pe.sigungu.replace(/\s+/g, '') : r.sggN,
        regionInferred: r.regionInferred, types: new Set(), xs: [], visits: 0, codes: new Set(), names: new Set(),
      };
      map.set(r.placeKey, p);
    }
    p.types.add(r.type);
    p.visits++;
    p.codes.add(r.code);
    p.names.add(r.name);
    if (r.type === '콜' && r.x != null) p.xs.push(r.x);
  }
  for (const p of map.values()) {
    p.type = p.types.has('콜') ? '콜' : '법카';
    p.gpsX = median(p.xs);
    p.excluded = isExcludedPlace(p.name, p.key);
  }
  return [...map.values()];
}

/** 후보 검색: 지역+이름, 이름 단독 순으로 검색해 후보 목록 반환 */
export async function searchCandidates(place, customQuery) {
  const regionText = [place.sidoN, place.sggN].filter(Boolean).join(' ');
  const queries = customQuery ? [customQuery] : regionText ? [`${regionText} ${place.name}`, place.name] : [place.name];
  const all = new Map();
  let error = false;
  for (const q of queries) {
    const res = await keywordSearch(q);
    if (res === null) { error = true; continue; }
    for (const d of res) if (!all.has(d.id)) all.set(d.id, toCandidate(d, place, place.gpsX));
    if ([...all.values()].some((c) => c.ns >= 2 && c.rm.sidoOk && c.rm.sggOk)) break;
    await sleep(80);
  }
  return { list: [...all.values()], error };
}

const slim = (c) => ({ name: c.name, addr: c.addr, lat: c.lat, lng: c.lng, catName: c.catName, gpsKm: c.gpsKm, ns: c.ns });

/** 거래처 1곳 자동 위치 판정 */
export async function geocodePlace(place) {
  const { list, error } = await searchCandidates(place);
  if (error && !list.length) return { status: 'error' };
  const regionKnown = !!(place.sidoN || place.sggN);
  let pool = regionKnown ? list.filter((c) => c.rm.sidoOk && c.rm.sggOk) : list;
  if (!pool.length && regionKnown) pool = list.filter((c) => c.rm.sidoOk);
  let use = pool.filter((c) => c.ns >= 2);
  const candidates = (use.length ? use : pool.length ? pool : list).slice(0, 8).map(slim);
  if (!use.length) return { status: list.length ? 'ambiguous' : 'notfound', candidates };

  const exact = use.filter((c) => c.ns === 3);
  if (exact.length) use = exact;
  if (place.type === '콜') {
    const medical = use.filter((c) => c.cat === 'HP8' || c.cat === 'PM9');
    if (medical.length) use = medical;
  }
  const pick = (c, status) => ({ status, lat: c.lat, lng: c.lng, addr: c.addr, matchName: c.name, candidates });
  if (use.length === 1) return pick(use[0], 'auto');

  // 동일 이름 후보가 여러 곳이면 해당 거래처 콜들의 X좌표(경도) 중앙값과 가장 가까운 곳을 선택
  if (place.gpsX != null) {
    const sorted = [...use].sort((a, b) => a.gpsKm - b.gpsKm);
    const [c1, c2] = sorted;
    if (c1.gpsKm <= 1 && (!c2 || c2.gpsKm - c1.gpsKm >= 0.5)) return pick(c1, 'gps');
  }
  return { status: 'ambiguous', candidates };
}

let runToken = 0;
/** 미검색 거래처 일괄 위치 검색 */
export async function geocodeAll({ force = false, onProgress } = {}) {
  if (!kakaoReady || !state.dataset) return;
  const token = ++runToken;
  const places = buildPlaces().filter((p) => {
    if (p.excluded) return false;
    const g = state.geo[p.key];
    if (!g || g.status === 'error') return true;
    if (g.status === 'manual') return false;
    return force && g.status !== 'auto' && g.status !== 'gps';
  });
  let done = 0;
  onProgress?.(done, places.length);
  for (const p of places) {
    if (token !== runToken) return;
    try {
      const res = await geocodePlace(p);
      if (state.geo[p.key]?.status === 'manual') continue;
      state.geo[p.key] = { ...res, ts: Date.now() };
    } catch (e) {
      console.error('위치 검색 오류', p.name, e);
      state.geo[p.key] = { status: 'error', ts: Date.now() };
    }
    done++;
    onProgress?.(done, places.length);
    if (done % 15 === 0) { save('geo'); emit('geo-updated'); }
    await sleep(120);
  }
  save('geo');
  emit('geo-updated');
}

export const GEO_LABEL = {
  auto: '자동', gps: 'GPS보정', manual: '수동', ambiguous: '확인필요', notfound: '검색실패', error: '오류', pending: '미검색', excluded: '위치제외',
};
