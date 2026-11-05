// 카카오 지도: 거래처 마커(클러스터링), 하루 동선(선 연결), 집 위치
// 대시보드·특이건 탭이 각각 MapView 인스턴스를 가진다.

import { state, emit } from './store.js';
import { placeCoords } from './analysis.js';
import { esc, fmtNum, compressRanges, haversineKm, sleep } from './util.js';

function clusterStyle(size, color) {
  return {
    width: `${size}px`, height: `${size}px`, lineHeight: `${size - 6}px`, background: color, color: '#fff',
    borderRadius: '50%', textAlign: 'center', fontWeight: '700', fontSize: '13px',
    border: '3px solid rgba(255,255,255,.92)', boxShadow: '0 6px 16px rgba(0,0,0,.18)',
  };
}

const ROUTE_COLOR = '#4f63f5'; // 동선 점선 · 콜 핀 색(style.css --c-pin과 동일)
const ROUTE_BAD = '#ff3b30'; // 이동불가 구간

const ZOOM_MS = 280; // 지도 확대·축소 애니메이션 시간
const FOCUS_MAX_LEVEL = 5; // 거래처로 이동했을 때의 최대 축척
const FLY_MAX_LEVEL = 13; // 먼 거리 이동 시 축소 한계
const metersPerPixel = (level) => 2 ** (level - 3); // 카카오 지도 레벨별 대략의 축척
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

const byTime = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.dayIndex || 0) - (b.dayIndex || 0));

export class MapView {
  /** @param {string} id 이벤트 구분용 이름('dash' | 'flags') */
  constructor(id) {
    this.id = id;
    this.map = null;
    this.clusterer = null;
    this.placeOverlays = [];
    this.routeObjects = [];
    this.homeOverlay = null;
    this.pulse = null;
    this.ctx = { rows: [], code: null, routeOn: false, routeDay: null, homeOn: true, places: new Map() };
  }

  get ready() { return !!this.map; }

  init(el) {
    const { maps } = window.kakao;
    this.el = el;
    this.map = new maps.Map(el, { center: new maps.LatLng(36.4, 127.6), level: 12 });
    this.map.addControl(new maps.ZoomControl(), maps.ControlPosition.RIGHT);
    // 사용자가 지도를 끌면 진행 중인 자동 이동을 멈춤
    maps.event.addListener(this.map, 'dragstart', () => this.cancelFly());
    this.clusterer = new maps.MarkerClusterer({
      map: this.map,
      averageCenter: true,
      minLevel: 5, // 넓게 볼 때(레벨 5 이상) 인접 마커를 묶고, 확대하면 풀림
      gridSize: 60,
      calculator: [10, 30, 80],
      styles: [clusterStyle(36, 'rgba(10,132,255,.92)'), clusterStyle(42, 'rgba(0,113,227,.92)'), clusterStyle(50, 'rgba(94,92,230,.92)'), clusterStyle(58, 'rgba(175,82,222,.92)')],
    });
  }

  relayout() { this.map?.relayout(); }

  clear() {
    this.clusterer?.clear();
    this.placeOverlays.forEach((o) => o.setMap(null));
    this.placeOverlays = [];
    this.routeObjects.forEach((o) => o.setMap(null));
    this.routeObjects = [];
    this.homeOverlay?.setMap(null);
    this.homeOverlay = null;
    this.routeCard?.remove();
    this.routeCard = null;
  }

  /** yAnchor 1 = 핀 끝(아래)이 좌표에 오도록 */
  overlay(position, el, z = 1, yAnchor = 0.5) {
    return new window.kakao.maps.CustomOverlay({ position, content: el, xAnchor: 0.5, yAnchor, clickable: true, zIndex: z });
  }

  get routeActive() {
    return !!(this.ctx.routeOn && this.ctx.code && this.ctx.routeDay);
  }

  /**
   * @param {Array} rows 표시할 기록
   * @param {{code?, routeOn?, routeDay?, homeOn?, view?: 'first'|'fit'|'keep', firstRows?: Array}} opts
   * view: first = 첫 기록 위치로 이동, fit = 전체가 보이게, keep = 현재 화면 유지
   */
  render(rows, { code = null, routeOn, routeDay, homeOn, view = 'keep', firstRows } = {}) {
    const ctx = this.ctx;
    ctx.rows = rows;
    ctx.code = code;
    if (routeOn !== undefined) ctx.routeOn = routeOn;
    if (routeDay !== undefined) ctx.routeDay = routeDay;
    if (homeOn !== undefined) ctx.homeOn = homeOn;

    const summary = { places: 0, unresolved: new Set(), excluded: new Set() };
    ctx.places = new Map();
    for (const r of rows) {
      if (r.excl) { summary.excluded.add(r.placeKey); continue; }
      const c = placeCoords(r.placeKey);
      if (!c) { summary.unresolved.add(r.placeKey); continue; }
      let p = ctx.places.get(r.placeKey);
      if (!p) ctx.places.set(r.placeKey, (p = { key: r.placeKey, name: r.place, lat: c.lat, lng: c.lng, rows: [] }));
      p.rows.push(r);
    }
    summary.places = ctx.places.size;
    if (!this.map) return summary;

    this.clear();
    if (this.routeActive) this.drawRoute();
    else this.drawPlaces();
    this.drawHome();
    if (view === 'fit') this.fit();
    if (view === 'first') this.goFirst(firstRows);
    return summary;
  }

  drawPlaces() {
    const { maps } = window.kakao;
    for (const p of this.ctx.places.values()) {
      const calls = p.rows.filter((r) => r.type === '콜');
      const anom = calls.filter((r) => r.anom).length;
      const imp = p.rows.some((r) => r.imp);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `mpin ${calls.length ? '' : 'mpin-card'} ${anom ? 'mpin-anom' : ''} ${imp ? 'mpin-imp' : ''}`;
      el.innerHTML = `<span class="mpin-head">${p.rows.length > 99 ? '99+' : p.rows.length}</span><i class="mpin-tail"></i>`;
      el.title = `${p.name}\n콜 ${calls.length}건 · 이상 ${anom}건 · 법카 ${p.rows.length - calls.length}건`;
      el.addEventListener('click', (e) => { e.stopPropagation(); this.openPlace(p.key); });
      this.placeOverlays.push(this.overlay(new maps.LatLng(p.lat, p.lng), el, anom ? 3 : 2, 1));
    }
    this.clusterer.addMarkers(this.placeOverlays);
  }

  dayRows() {
    const { code, routeDay } = this.ctx;
    return this.ctx.rows.filter((r) => r.code === code && r.date === routeDay).sort(byTime);
  }

  drawRoute() {
    const { maps } = window.kakao;
    const pts = this.dayRows().filter((r) => !r.excl && placeCoords(r.placeKey));
    for (let i = 1; i < pts.length; i++) {
      const a = placeCoords(pts[i - 1].placeKey);
      const b = placeCoords(pts[i].placeKey);
      if (a.lat === b.lat && a.lng === b.lng) continue;
      const bad = pts[i].imp && pts[i].prevId === pts[i - 1].id;
      // 점선 동선(방향은 핀 번호로 표시). 둥근 점 모양은 CSS(.map-el path)에서 보정
      this.routeObjects.push(new maps.Polyline({
        map: this.map,
        path: [new maps.LatLng(a.lat, a.lng), new maps.LatLng(b.lat, b.lng)],
        strokeWeight: 6,
        strokeColor: bad ? ROUTE_BAD : ROUTE_COLOR,
        strokeOpacity: 0.95,
        strokeStyle: 'shortdot',
        zIndex: bad ? 5 : 4,
      }));
    }
    const stops = new Map();
    for (const r of pts) {
      if (!stops.has(r.placeKey)) stops.set(r.placeKey, []);
      stops.get(r.placeKey).push(r);
    }
    for (const [key, rs] of stops) {
      const c = placeCoords(key);
      const anom = rs.some((r) => r.anom);
      const fl = [...new Set(rs.map((r) => r.fl).filter(Boolean))];
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `mpin ${rs.every((r) => r.type === '법카') ? 'mpin-card' : ''} ${anom ? 'mpin-anom' : ''} ${rs.some((r) => r.imp) ? 'mpin-imp' : ''}`;
      el.innerHTML = `<span class="mpin-head">${esc(compressRanges(rs.map((r) => r.dayIndex)))}</span>${fl.length ? `<em class="mpin-tag">${esc(fl.join('·'))}</em>` : ''}<i class="mpin-tail"></i>`;
      el.title = `${rs[0].place}\n${rs.map((r) => `${r.dayIndex}. ${r.time} ${r.type}${r.digits ? ` ${r.digits}` : ''}`).join('\n')}`;
      el.addEventListener('click', (e) => { e.stopPropagation(); this.openPlace(key, { code: this.ctx.code, date: this.ctx.routeDay }); });
      const ov = this.overlay(new maps.LatLng(c.lat, c.lng), el, anom ? 8 : 7, 1);
      ov.setMap(this.map);
      this.routeObjects.push(ov);
    }
    this.drawRouteCard(stops.size);
  }

  /** 지도 하단 떠 있는 카드: 하루 총 이동거리 */
  drawRouteCard(stopCount) {
    const host = this.el?.parentElement;
    const rs = this.routeSummary();
    if (!host || !rs) return;
    const card = document.createElement('div');
    card.className = 'route-card';
    card.innerHTML = `<b>${fmtNum(rs.km, 1)} km</b><span>하루 총 이동거리 · ${fmtNum(stopCount)}개 지점</span>`;
    host.appendChild(card);
    this.routeCard = card;
  }

  drawHome() {
    const { code, homeOn } = this.ctx;
    if (!homeOn || !code) return;
    const h = state.homes[code];
    if (!h || !Number.isFinite(h.lat)) return;
    const el = document.createElement('div');
    el.className = 'home-pin';
    el.title = `집: ${h.addr || ''}`;
    el.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 3 2 11h3v9h6v-6h2v6h6v-9h3z"/></svg><span>집</span>';
    this.homeOverlay = this.overlay(new window.kakao.maps.LatLng(h.lat, h.lng), el, 9);
    this.homeOverlay.setMap(this.map);
  }

  openPlace(key, prefer) {
    const rows = this.ctx.rows.filter((r) => r.placeKey === key);
    emit('open-panel', { focusKey: key, rows, prefer, source: this.id });
  }

  /** 첫 기록(가장 이른 날짜의 첫 콜) 위치로 이동 */
  goFirst(candidates) {
    if (!this.map) return;
    this.cancelFly();
    const list = (candidates || (this.routeActive ? this.dayRows() : this.ctx.rows)).filter((r) => !r.excl && placeCoords(r.placeKey));
    const pick = [...list].sort(byTime).find((r) => r.type === '콜') || [...list].sort(byTime)[0];
    if (!pick) { this.fit(); return; }
    const c = placeCoords(pick.placeKey);
    this.map.setLevel(this.routeActive ? 6 : 5);
    this.map.setCenter(new window.kakao.maps.LatLng(c.lat, c.lng));
  }

  fit() {
    if (!this.map) return;
    this.cancelFly();
    const { maps } = window.kakao;
    const bounds = new maps.LatLngBounds();
    let n = 0;
    for (const p of this.ctx.places.values()) {
      if (this.routeActive && !p.rows.some((r) => r.code === this.ctx.code && r.date === this.ctx.routeDay)) continue;
      bounds.extend(new maps.LatLng(p.lat, p.lng));
      n++;
    }
    const h = this.ctx.code && this.ctx.homeOn ? state.homes[this.ctx.code] : null;
    if (h && Number.isFinite(h.lat)) { bounds.extend(new maps.LatLng(h.lat, h.lng)); n++; }
    if (n === 1) {
      this.map.setCenter(bounds.getSouthWest());
      this.map.setLevel(5);
    } else if (n > 1) this.map.setBounds(bounds, 40, 40, 40, 40);
  }

  /** 특정 거래처로 이동 + 강조 효과 */
  focus(key) {
    const c = placeCoords(key);
    if (!this.map || !c) return false;
    const { maps } = window.kakao;
    const pos = new maps.LatLng(c.lat, c.lng);
    this.flyTo(c.lat, c.lng);
    this.pulse?.setMap(null);
    const el = document.createElement('div');
    el.className = 'pulse';
    this.pulse = new maps.CustomOverlay({ position: pos, content: el, xAnchor: 0.5, yAnchor: 0.5, zIndex: 0 });
    this.pulse.setMap(this.map);
    setTimeout(() => this.pulse?.setMap(null), 2600);
    return true;
  }

  cancelFly() {
    this.flyId = (this.flyId || 0) + 1;
    this.flyEndLevel = null;
  }

  /**
   * 목적지까지 부드럽게 이동. 카카오 panTo는 화면 밖으로 멀어지면 순간 이동하므로 직접 움직인다.
   * 먼 곳이면 두 지점이 한 화면에 들어올 만큼 축소 → 이동 → 다시 확대.
   */
  async flyTo(lat, lng) {
    const endLevelBefore = this.flyEndLevel; // 이동 중 다른 항목을 눌러도 원래 축척으로 돌아오도록 유지
    this.cancelFly();
    const id = this.flyId;
    const alive = () => id === this.flyId;
    const { maps } = window.kakao;
    const level = this.map.getLevel();
    const endLevel = Math.min(endLevelBefore ?? level, FOCUS_MAX_LEVEL);
    this.flyEndLevel = endLevel;
    if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.map.setLevel(endLevel);
      this.map.setCenter(new maps.LatLng(lat, lng));
      this.flyEndLevel = null;
      return;
    }
    const from = this.map.getCenter();
    const startLat = from.getLat();
    const startLng = from.getLng();
    const meters = haversineKm(startLat, startLng, lat, lng) * 1000;
    const width = this.el?.clientWidth || 800;
    let flyLevel = level;
    while (flyLevel < FLY_MAX_LEVEL && meters / metersPerPixel(flyLevel) > width * 0.8) flyLevel++;
    if (flyLevel > level) {
      this.map.setLevel(flyLevel, { animate: { duration: ZOOM_MS } });
      await sleep(ZOOM_MS);
      if (!alive()) return;
    }
    const pixels = meters / metersPerPixel(flyLevel);
    const duration = Math.min(900, Math.max(400, 350 + pixels * 0.5));
    await new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        if (!alive()) { resolve(); return; }
        const t = Math.min(1, (now - start) / duration);
        const e = easeInOutCubic(t);
        this.map.setCenter(new maps.LatLng(startLat + (lat - startLat) * e, startLng + (lng - startLng) * e));
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    if (!alive()) return;
    if (this.map.getLevel() !== endLevel) this.map.setLevel(endLevel, { animate: { duration: ZOOM_MS } });
    this.flyEndLevel = null;
  }

  routeSummary() {
    if (!this.routeActive) return null;
    const rows = this.dayRows();
    return {
      total: rows.length,
      imp: rows.filter((r) => r.imp).length,
      anom: rows.filter((r) => r.anom).length,
      noCoord: rows.filter((r) => !r.excl && !placeCoords(r.placeKey)).length,
      km: rows.reduce((s, r) => s + (r.dist || 0), 0),
    };
  }
}

export const fmtKm = (v) => (v == null ? '-' : `${fmtNum(v, 1)}km`);
