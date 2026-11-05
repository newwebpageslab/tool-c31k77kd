// 정렬·페이지 이동이 가능한 범용 테이블
// 열 머리글 클릭: 오름차순 → 내림차순 → 원래 순서

import { esc, fmtNum } from './util.js';

export class DataTable {
  /**
   * @param {HTMLElement} container
   * @param {{columns: Array, pageSize?: number, onRowClick?: Function, onAction?: Function, rowClass?: Function, emptyText?: string}} opts
   * columns: { key, label, tip?, align?, width?, value(row) 정렬값, html(row) 표시 HTML, cls? }
   */
  constructor(container, opts) {
    this.el = container;
    this.opts = opts;
    this.rows = [];
    this.sort = null;
    this.page = 0;
    this.pageSize = opts.pageSize || 100;
    this.view = [];
    this.selectedId = null;
    this.el.classList.add('dt');
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('change', (e) => {
      if (e.target.matches('.dt-size')) {
        this.pageSize = Number(e.target.value);
        this.page = 0;
        this.opts.onPageSize?.(this.pageSize);
        this.render();
      }
    });
  }

  setRows(rows, { keepPage = false } = {}) {
    this.rows = rows;
    if (!keepPage) this.page = 0;
    this.render();
  }

  sorted() {
    if (!this.sort) return this.rows;
    const col = this.opts.columns.find((c) => c.key === this.sort.key);
    if (!col) return this.rows;
    const get = col.value || ((r) => r[col.key]);
    const dir = this.sort.dir === 'asc' ? 1 : -1;
    return this.rows
      .map((r, i) => ({ r, v: get(r), i }))
      .sort((a, b) => {
        const av = a.v;
        const bv = b.v;
        const an = av == null || av === '';
        const bn = bv == null || bv === '';
        if (an && bn) return a.i - b.i;
        if (an) return 1;
        if (bn) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir || a.i - b.i;
        return String(av).localeCompare(String(bv), 'ko', { numeric: true }) * dir || a.i - b.i;
      })
      .map((x) => x.r);
  }

  render() {
    const { columns, rowClass, emptyText = '표시할 데이터가 없습니다.' } = this.opts;
    const all = this.sorted();
    const pages = Math.max(1, Math.ceil(all.length / this.pageSize));
    this.page = Math.min(this.page, pages - 1);
    const start = this.page * this.pageSize;
    this.view = all.slice(start, start + this.pageSize);

    const head = columns.map((c) => {
      const active = this.sort?.key === c.key;
      const arrow = active ? (this.sort.dir === 'asc' ? '▲' : '▼') : '↕';
      const sortable = c.sortable !== false;
      return `<th class="${c.align ? `a-${c.align}` : ''} ${sortable ? 'sortable' : ''} ${active ? 'sorted' : ''}" ${sortable ? `data-sort="${c.key}"` : ''}
        style="${c.width ? `min-width:${c.width}px;` : ''}" ${c.tip ? `data-tip="${esc(c.tip)}"` : ''}>
        <span class="th-in">${esc(c.label)}${sortable ? `<i class="sort-ind">${arrow}</i>` : ''}</span></th>`;
    }).join('');

    const body = this.view.length
      ? this.view.map((r, i) => `<tr data-i="${i}" class="${rowClass ? rowClass(r) : ''} ${r.id && r.id === this.selectedId ? 'is-selected' : ''}">${
        columns.map((c) => `<td class="${c.align ? `a-${c.align}` : ''} ${c.cls || ''}">${c.html ? c.html(r) : esc(r[c.key])}</td>`).join('')
      }</tr>`).join('')
      : `<tr><td class="dt-empty" colspan="${columns.length}">${esc(emptyText)}</td></tr>`;

    const sizes = [50, 100, 200, 500, 1000];
    this.el.innerHTML = `
      <div class="dt-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <div class="dt-foot">
        <span class="muted">${all.length ? `${fmtNum(start + 1)}–${fmtNum(start + this.view.length)}` : 0} / 총 ${fmtNum(all.length)}건</span>
        <div class="dt-pager">
          <select class="dt-size" aria-label="페이지당 행 수">${sizes.map((s) => `<option value="${s}" ${s === this.pageSize ? 'selected' : ''}>${s}행</option>`).join('')}</select>
          <button class="btn btn-sm" data-page="first" ${this.page === 0 ? 'disabled' : ''} aria-label="처음">«</button>
          <button class="btn btn-sm" data-page="prev" ${this.page === 0 ? 'disabled' : ''} aria-label="이전">‹</button>
          <span class="dt-pageno">${this.page + 1} / ${pages}</span>
          <button class="btn btn-sm" data-page="next" ${this.page >= pages - 1 ? 'disabled' : ''} aria-label="다음">›</button>
          <button class="btn btn-sm" data-page="last" ${this.page >= pages - 1 ? 'disabled' : ''} aria-label="마지막">»</button>
        </div>
      </div>`;
  }

  onClick(e) {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      if (!this.sort || this.sort.key !== key) this.sort = { key, dir: 'asc' };
      else if (this.sort.dir === 'asc') this.sort = { key, dir: 'desc' };
      else this.sort = null;
      this.render();
      return;
    }
    const pg = e.target.closest('[data-page]');
    if (pg) {
      const pages = Math.max(1, Math.ceil(this.rows.length / this.pageSize));
      const m = { first: 0, prev: this.page - 1, next: this.page + 1, last: pages - 1 };
      this.page = Math.max(0, Math.min(pages - 1, m[pg.dataset.page]));
      this.render();
      this.el.querySelector('.dt-scroll')?.scrollTo({ top: 0 });
      return;
    }
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const row = this.view[Number(tr.dataset.i)];
    const act = e.target.closest('[data-action]');
    if (act) {
      e.stopPropagation();
      this.opts.onAction?.(act.dataset.action, row, act, e);
      return;
    }
    if (e.target.closest('input, select, textarea, a')) return;
    this.selectedId = row.id;
    this.el.querySelectorAll('tr.is-selected').forEach((t) => t.classList.remove('is-selected'));
    tr.classList.add('is-selected');
    this.opts.onRowClick?.(row, e);
  }
}
