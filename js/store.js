// 상태 저장소: 업로드 데이터·좌표·특이건 체크·이력은 IndexedDB, 설정·카카오 키는 localStorage에 저장
// 모든 데이터는 사용자 PC의 브라우저 안에만 저장되며 외부로 전송되지 않는다.

import { debounce, nowStamp } from './util.js';

export const APP_VERSION = '1.5.5';

const DB_NAME = 'gpscall-monitor';
const STORE = 'kv';
const LS_SETTINGS = 'gpscall.settings';
const LS_KAKAO = 'gpscall.kakaoKey';

export const DEFAULT_SETTINGS = {
  speedLimit: 100, // 이동불가 판정 속도 하한(km/h, 초과)
  speedMax: 0, // 이동불가 판정 속도 상한(km/h, 미만) — 0이면 제한 없음
  minDistKm: 0.5, // 이 거리 미만 이동은 속도 판정 제외(콜 인정 반경 300m 고려)
  mismatchKm: 0.5, // 콜 X좌표와 거래처 위치의 동서 거리 차이 기준(km)
  distPriority: 'file', // 'file' = 엑셀 이동거리 우선, 'map' = 지도 좌표 직선거리 우선
  excludeKeywords: [
    '스타벅스', '에스씨케이컴퍼니', '다이소', '유피소프트', '고속', '철도', '버스', '항공', '에스알', '신화푸드', '신화아이푸드', '신화케이푸드',
    '올킹', '우체국', '갤럭시아', '씨제이프레시웨이', '택시', 'ARS', '전화결제', '키오스크', '인터넷상거래', '에스엠하이플러스', '정보통신',
  ],
  pageSize: 100,
};

export const state = {
  dataset: null, // { fileName, loadedAt, rows, employees, period, warnings }
  geo: {}, // placeKey → { status, lat, lng, addr, matchName, candidates, ... }
  favs: {}, // rowId → true (즐겨찾기 ★, 기본은 비어 있음)
  memos: {}, // rowId → 메모
  homes: {}, // 사원코드 → { addr, lat, lng }
  history: [], // 수정 이력
  placeEdits: {}, // placeKey → { sido, sigungu }
  placeExcludes: {}, // placeKey → true (위치 관리에서 직접 위치제외로 지정한 거래처)
  settings: { ...DEFAULT_SETTINGS },
  kakaoKey: '',
  filter: { gubun: '', team: '', code: '', from: '', to: '' },
};

const PERSIST_KEYS = ['dataset', 'geo', 'favs', 'memos', 'homes', 'history', 'placeEdits', 'placeExcludes'];

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function idbRequest(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  }));
}

const idbGet = (key) => idbRequest('readonly', (s) => s.get(key));
const idbSet = (key, val) => idbRequest('readwrite', (s) => s.put(val, key));
/** 지정한 저장 항목을 즉시 삭제(페이지 새로고침 전에 완료되도록 대기) */
export async function deleteStored(keys) {
  for (const key of keys) await idbRequest('readwrite', (s) => s.delete(key));
}

export async function loadAll() {
  try {
    for (const key of PERSIST_KEYS) {
      const v = await idbGet(key);
      if (v != null) state[key] = v;
    }
    // v1.1 이하: 특이건 수동 체크(flags)를 즐겨찾기로 이관
    const oldFlags = await idbGet('flags');
    if (oldFlags) {
      for (const [id, on] of Object.entries(oldFlags)) if (on === true) state.favs[id] = true;
      await idbSet('favs', state.favs);
      await idbRequest('readwrite', (s) => s.delete('flags'));
    }
  } catch (e) {
    console.error('IndexedDB 로드 실패', e);
  }
  try {
    const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
    state.settings = { ...DEFAULT_SETTINGS, ...s };
    // v1.5.1: 새 기본 제외 키워드를 기존 목록에 추가(한 번만, 사용자가 넣은 키워드는 유지)
    if (!state.settings.kwV151) {
      state.settings.excludeKeywords = [...new Set([...state.settings.excludeKeywords, ...DEFAULT_SETTINGS.excludeKeywords])];
      state.settings.kwV151 = true;
      saveSettings();
    }
    state.kakaoKey = localStorage.getItem(LS_KAKAO) || '';
  } catch {
    state.settings = { ...DEFAULT_SETTINGS };
  }
}

const savers = {};
/** 지정 키를 IndexedDB에 저장(연속 호출 시 묶어서 저장) */
export function save(key) {
  if (!savers[key]) {
    savers[key] = debounce(() => {
      idbSet(key, state[key]).catch((e) => console.error(`${key} 저장 실패`, e));
    }, 300);
  }
  savers[key]();
}

export function saveSettings() {
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); } catch (e) { console.error(e); }
}

export function saveKakaoKey(key) {
  state.kakaoKey = key;
  try {
    if (key) localStorage.setItem(LS_KAKAO, key);
    else localStorage.removeItem(LS_KAKAO);
  } catch (e) { console.error(e); }
}

/** 수정 이력 기록 */
export function logHistory(type, target, before, after, reason = '') {
  state.history.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: nowStamp(),
    type,
    target,
    before: before ?? '',
    after: after ?? '',
    reason,
  });
  save('history');
  emit('history-changed');
}

/** 백업용 작업 내역(업로드 원본 데이터와 카카오 키 제외) */
export function exportWorkState() {
  const { geo, favs, memos, homes, history, placeEdits, placeExcludes, settings } = state;
  return { app: 'gpscall-monitor', version: 2, exportedAt: nowStamp(), geo, favs, memos, homes, history, placeEdits, placeExcludes, settings };
}

export function importWorkState(obj) {
  if (!obj || obj.app !== 'gpscall-monitor') throw new Error('이 플랫폼의 백업 파일이 아닙니다.');
  for (const key of ['geo', 'favs', 'memos', 'homes', 'placeEdits', 'placeExcludes']) {
    if (obj[key]) { state[key] = { ...state[key], ...obj[key] }; save(key); }
  }
  if (Array.isArray(obj.history)) {
    const ids = new Set(state.history.map((h) => h.id));
    state.history = [...obj.history.filter((h) => !ids.has(h.id)), ...state.history].sort((a, b) => (a.ts < b.ts ? 1 : -1));
    save('history');
  }
  if (obj.settings) { state.settings = { ...DEFAULT_SETTINGS, ...obj.settings }; saveSettings(); }
}

/* ---------- 간단한 이벤트 버스 ---------- */
const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));
