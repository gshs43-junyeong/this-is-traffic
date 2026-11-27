/* =============================================================================
   cedit.js — 도시 편집기: 도로 그리기 · 곡선 · 고가 · 지하 · 고속도로 · 차로 · 회전 차로 · 건물

   도구
     선택  노드 끌기(옮기기) · 도로 고르면 조절점 둘이 나오고 끌면 곡선 · 건물 끌기. 고른 것의 속성은 오른쪽 창.
     도로  누를 때마다 점을 이어 도로를 놓는다(Esc · 우클릭으로 끝). 기존 노드에 붙고, 도로 위를 누르면 그 자리를 잘라
           교차로를 만든다. 같은 높이로 겹치는 도로와는 저절로 교차로가 생기고, 높이가 다르면(고가 · 지하) 입체 교차.
     건물  끌어서 사각형. 출입구는 가장 가까운 길에 저절로 붙는다.
     지우개 누른 것을 지운다.
   고칠 때마다 지도를 저장(브라우저)하고 도로망을 새로 짓는다. 편집을 마치면 시뮬레이션을 새로 시작한다.
   ========================================================================== */
'use strict';

const CEdit = {
  tool: 'select',
  road: { cls: 'street', n: 2, level: 'ground', oneway: false },
  bld: { kind: 'office', h: 24 },
  sel: null,                 // { t: 'node'|'road'|'bld', id }
  chain: null,               // 도로 그리는 중 — 마지막 점 { node? , x, y }
  undo: [], redo: [],
  hover: null, cursor: null,

  init(app) {
    this.app = app;
    for (const b of $$('[data-tool]')) b.onclick = () => this.setTool(b.dataset.tool);
    $('#eCls').onchange = (e) => { this.road.cls = e.target.value; const cl = RCLS[this.road.cls]; this.road.n = cl.lanes[0]; this.road.oneway = !cl.lanes[1]; $('#eLanes').value = this.road.n; $('#eOne').checked = this.road.oneway; if (cl.fast && this.road.level === 'ground' && this.road.cls === 'highway') { /* 고속도로는 보통 고가 */ } this.setTool('road'); };
    $('#eLanes').onchange = (e) => { this.road.n = clamp(+e.target.value | 0, 1, 6); };
    $('#eLevel').onchange = (e) => { this.road.level = e.target.value; this.setTool('road'); };
    $('#eOne').onchange = (e) => { this.road.oneway = e.target.checked; };
    $('#eKind').onchange = (e) => { this.bld.kind = e.target.value; this.setTool('bld'); };
    $('#eUndo').onclick = () => this.doUndo();
    $('#eRedo').onclick = () => this.doRedo();
    $('#eFill').onclick = () => this.edit(() => { const n = autofill(this.app.map, (this.app.cfg.seed | 0) + this.app.map.blds.length, 1); this.app.toast(`건물 ${n}채를 길가 빈 땅에 놓았습니다`); });
    $('#eClearB').onclick = () => this.edit(() => { this.app.map.blds = []; });
    $('#eClearAll').onclick = () => { if (confirm('지도를 모두 지울까요? (되돌리기로 살릴 수 있습니다)')) this.edit(() => { const m = newMap(); m.sig = this.app.map.sig; this.app.map = m; }); };
    $('#eExport').onclick = () => this.exportMap();
    $('#eImport').onclick = () => $('#eFile').click();
    $('#eFile').onchange = (e) => this.importMap(e.target.files[0]);
    $('#eDone').onclick = () => this.app.setEdit(false);
    for (const b of $$('[data-tpl]')) b.onclick = () => this.edit(() => { this.app.map = makeTemplate(b.dataset.tpl, { seed: this.app.cfg.seed | 0, NX: 4, NY: 4, B: 150, lanes: 2 }); this.sel = null; }, true);
    this.syncBar();
  },
  setTool(t) {
    this.tool = t; this.chain = null;
    for (const b of $$('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
    $('#eRoadOpt').style.display = t === 'road' ? 'flex' : 'none';
    $('#eBldOpt').style.display = t === 'bld' ? 'flex' : 'none';
    this.app.cv.style.cursor = t === 'select' ? 'default' : 'crosshair';
    const tip = { select: '노드 · 조절점 · 건물을 끌어 옮기고, 누르면 속성을 고칩니다', road: '누를 때마다 도로를 잇습니다 — 도로 위를 누르면 교차로, Esc · 우클릭으로 끝', bld: '끌어서 건물을 놓습니다 — 출입구는 가까운 길에 붙습니다', erase: '누른 도로 · 노드 · 건물을 지웁니다' }[t];
    $('#eTip').textContent = tip;
  },
  syncBar() {
    $('#eCls').value = this.road.cls; $('#eLanes').value = this.road.n; $('#eLevel').value = this.road.level; $('#eOne').checked = this.road.oneway; $('#eKind').value = this.bld.kind;
    this.setTool(this.tool);
  },

  /* ---------- 고치기 · 되돌리기 ---------- */
  /** f 가 지도를 고친다 — 고치기 전 모습을 되돌리기에 쌓고, 저장하고, 도로망을 새로 짓는다 */
  edit(f, reframe) {
    const before = JSON.stringify(this.app.map);
    try { f(); } catch (e) { console.error(e); this.app.toast('고치지 못했습니다: ' + e.message, 4); this.app.map = JSON.parse(before); }
    if (JSON.stringify(this.app.map) === before) return;
    this.undo.push(before); if (this.undo.length > 60) this.undo.shift();
    this.redo = [];
    this.app.mapChanged(reframe);
  },
  doUndo() { if (!this.undo.length) return; this.redo.push(JSON.stringify(this.app.map)); this.app.map = JSON.parse(this.undo.pop()); this.sel = null; this.app.mapChanged(); },
  doRedo() { if (!this.redo.length) return; this.undo.push(JSON.stringify(this.app.map)); this.app.map = JSON.parse(this.redo.pop()); this.sel = null; this.app.mapChanged(); },
  exportMap() {
    const blob = new Blob([JSON.stringify(this.app.map)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (this.app.map.name || 'city') + '.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  importMap(file) {
    if (!file) return;
    file.text().then((s) => {
      const m = JSON.parse(s);
      if (!Array.isArray(m.nodes) || !Array.isArray(m.roads)) throw new Error('도시 지도 파일이 아닙니다');
      m.blds = m.blds || []; m.sig = m.sig || { phase: 'lead', cycle: 100 }; m.nid = Math.max(m.nid || 1, 1 + Math.max(0, ...m.nodes.map((n) => n.id), ...m.roads.map((r) => r.id), ...m.blds.map((b) => b.id)));
      this.edit(() => { this.app.map = m; this.sel = null; }, true);
    }).catch((e) => this.app.toast('불러오지 못했습니다: ' + e.message, 4));
    $('#eFile').value = '';
  },

  /* ---------- 고르기 (화면 좌표) ---------- */
  /** 화면 점 → 땅(높이 z) 위 점 */
  ground(px, py, z) {
    const P = this.app.camPose, sx = (px - this.app.W / 2) / Render.focal, sy = -(py - this.app.H / 2) / Render.focal;
    const dx = Render.fx + Render.rx * sx + Render.ux * sy, dy = Render.fy + Render.ry * sx + Render.uy * sy, dz = Render.fz + Render.rz * sx + Render.uz * sy;
    if (Math.abs(dz) < 1e-4) return null;
    const t = ((z || 0) - P.z) / dz; if (t < 0) return null;
    return { x: P.x + dx * t, y: P.y + dy * t };
  },
  hitNode(px, py, r) {
    let best = null, bd = (r || 14) * this.app.dpr;
    for (const n of this.app.map.nodes) { const q = Render.point(n.x, n.y, LEVEL_Z[n.level] || 0); if (!q) continue; const d = Math.hypot(q.x - px, q.y - py); if (d < bd) { bd = d; best = n; } }
    return best;
  },
  hitRoad(px, py) {
    let best = null, bd = 12 * this.app.dpr, bsc = 0;
    for (const R of this.app.net.roads) {
      const g = R.g;
      for (let i = 0; i < g.n; i += 3) { const q = Render.point(g.x[i], g.y[i], g.z[i]); if (!q) continue; const d = Math.hypot(q.x - px, q.y - py); if (d < bd) { bd = d; best = R; bsc = i * g.step; } }
    }
    return best ? { R: best, sc: bsc } : null;
  },
  hitBld(px, py) {
    const g = this.ground(px, py, 0); if (!g) return null;
    for (const b of this.app.map.blds) if (distRect(g.x, g.y, b) < 0.5) return b;
    return null;
  },
  handles() {
    const s = this.sel; if (!s || s.t !== 'road') return [];
    const r = mapRoad(this.app.map, s.id); if (!r) return [];
    const A = mapNode(this.app.map, r.a), B = mapNode(this.app.map, r.b), P = roadCtl(A, B, r);
    return [{ k: 'c1', x: P[1][0], y: P[1][1] }, { k: 'c2', x: P[2][0], y: P[2][1] }];
  },
  hitHandle(px, py) {
    for (const h of this.handles()) { const q = Render.point(h.x, h.y, 0); if (q && Math.hypot(q.x - px, q.y - py) < 12 * this.app.dpr) return h; }
    return null;
  },
  snap(v) { return Math.round(v / 2) * 2; },

  /* ---------- 마우스 ---------- */
  /** 왼쪽 누름 — 편집기가 맡으면 true (아니면 시점 돌리기) */
  down(px, py) {
    const map = this.app.map;
    if (this.tool === 'select') {
      const h = this.hitHandle(px, py);
      if (h) { this.drag = { t: 'handle', k: h.k, id: this.sel.id, before: JSON.stringify(map) }; return true; }
      const n = this.hitNode(px, py);
      if (n) { this.sel = { t: 'node', id: n.id }; this.drag = { t: 'node', id: n.id, before: JSON.stringify(map), moved: false }; this.panel(); return true; }
      const r = this.hitRoad(px, py);
      if (r) { this.sel = { t: 'road', id: r.R.id }; this.panel(); return true; }
      const b = this.hitBld(px, py);
      if (b) { const g = this.ground(px, py, 0); this.sel = { t: 'bld', id: b.id }; this.drag = { t: 'bld', id: b.id, dx: b.x - g.x, dy: b.y - g.y, before: JSON.stringify(map), moved: false }; this.panel(); return true; }
      if (this.sel) { this.sel = null; this.panel(); }
      return false;
    }
    if (this.tool === 'bld') {
      const g = this.ground(px, py, 0); if (!g) return false;
      this.drag = { t: 'rect', x0: g.x, y0: g.y, x1: g.x, y1: g.y };
      return true;
    }
    return true;      // 도로 · 지우개는 뗄 때 (클릭)
  },
  move(px, py) {
    this.cursor = [px, py];
    const d = this.drag;
    if (!d) return;
    const map = this.app.map;
    if (d.t === 'node') {
      const n = mapNode(map, d.id), g = this.ground(px, py, LEVEL_Z[n.level] || 0); if (!g) return;
      moveNode(map, d.id, this.snap(g.x), this.snap(g.y)); d.moved = true;
    } else if (d.t === 'handle') {
      const r = mapRoad(map, d.id), g = this.ground(px, py, 0); if (!g || !r) return;
      if (!r.c1 || !r.c2) { const A = mapNode(map, r.a), B = mapNode(map, r.b), P = roadCtl(A, B, r); r.c1 = P[1]; r.c2 = P[2]; }
      r[d.k] = [this.snap(g.x), this.snap(g.y)]; d.moved = true;
    } else if (d.t === 'bld') {
      const b = map.blds.find((q) => q.id === d.id), g = this.ground(px, py, 0); if (!g || !b) return;
      b.x = this.snap(g.x + d.dx); b.y = this.snap(g.y + d.dy); delete b.acc; d.moved = true;
    } else if (d.t === 'rect') {
      const g = this.ground(px, py, 0); if (g) { d.x1 = g.x; d.y1 = g.y; }
    }
  },
  up(px, py, click) {
    const d = this.drag; this.drag = null;
    const map = this.app.map;
    if (d && (d.t === 'node' || d.t === 'handle' || d.t === 'bld')) {
      if (d.moved) {
        // 끄는 동안 바뀐 지도를 '고치기' 하나로 — 고치기 전 모습은 끌기 시작할 때 것
        const now = JSON.stringify(map);
        this.app.map = JSON.parse(d.before);
        this.edit(() => { this.app.map = JSON.parse(now); if (d.t === 'node') this.mergeNear(d.id); });
      }
      return;
    }
    if (d && d.t === 'rect') {
      const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
      if (w < 6 || h < 6) return;
      // 가까운 길과 나란하게 돌린다
      const cx = (d.x0 + d.x1) / 2, cy = (d.y0 + d.y1) / 2;
      this.edit(() => {
        const b = { id: map.nid++, x: Math.round(cx * 10) / 10, y: Math.round(cy * 10) / 10, w: Math.round(w), d: Math.round(h), rot: 0, h: this.bld.kind === 'shop' ? 8 : this.bld.kind === 'parking' ? 15 : this.bld.h, kind: this.bld.kind };
        map.blds.push(b);
        this.sel = { t: 'bld', id: b.id };
      });
      this.panel();
      return;
    }
    if (!click) return;
    if (this.tool === 'road') this.roadClick(px, py);
    else if (this.tool === 'erase') this.eraseClick(px, py);
  },
  /** 끈 노드가 다른 노드 위에 놓이면 하나로 합친다 */
  mergeNear(id) {
    const map = this.app.map, n = mapNode(map, id); if (!n) return;
    const o = map.nodes.find((m) => m !== n && Math.hypot(m.x - n.x, m.y - n.y) < 4 && m.level === n.level);
    if (!o) return;
    for (const r of map.roads) { if (r.a === id) r.a = o.id; if (r.b === id) r.b = o.id; }
    map.roads = map.roads.filter((r) => r.a !== r.b);
    map.nodes.splice(map.nodes.indexOf(n), 1);
  },
  /** 도로 도구 — 점 하나 (노드 · 도로 위 · 빈 땅) */
  roadClick(px, py) {
    const map = this.app.map, lv = this.road.level === 'tunnel' ? 'ground' : this.road.level === 'bridge' && this.road.cls === 'highway' ? 'bridge' : 'ground';
    const z = LEVEL_Z[lv];
    let pt = null;
    const n = this.hitNode(px, py);
    if (n) pt = { node: n.id };
    else {
      const hr = this.hitRoad(px, py);
      if (hr) pt = { road: hr.R.id, sc: hr.sc };
      else { const g = this.ground(px, py, z); if (!g) return; pt = { x: this.snap(g.x), y: this.snap(g.y) }; }
    }
    if (!this.chain) {
      // 첫 점 — 도로 위면 지금 자르지 않고 둘째 점에서 함께
      this.chain = pt;
      this.app.toast('다음 점을 누르세요 — Esc · 우클릭으로 끝', 2);
      return;
    }
    const a = this.chain, opts = { cls: this.road.cls, level: this.road.level, lanes: this.road.oneway ? [this.road.n, 0] : [this.road.n, this.road.n] };
    let endId = null;
    this.edit(() => {
      const idOf = (p) => {
        if (p.node) return p.node;
        if (p.road) { const r = mapRoad(map, p.road); if (r) return splitRoad(map, p.road, p.sc).id; }
        return addNode(map, p.x, p.y, lv).id;
      };
      const ia = idOf(a), ib = idOf(pt);
      if (ia === ib) return;
      const A = mapNode(map, ia), B = mapNode(map, ib);
      if (Math.hypot(A.x - B.x, A.y - B.y) < 8) return;
      if (map.roads.some((r) => (r.a === ia && r.b === ib) || (r.a === ib && r.b === ia))) return;
      addRoad(map, ia, ib, opts);
      endId = ib;
      // 교차로로 잘렸으면 마지막 조각을 고른다
      const last = map.roads.filter((q) => q.a === ib || q.b === ib).pop();
      this.sel = last ? { t: 'road', id: last.id } : null;
    });
    this.chain = endId ? { node: endId } : null;
    this.panel();
  },
  eraseClick(px, py) {
    const map = this.app.map;
    const n = this.hitNode(px, py, 10);
    if (n) { this.edit(() => deleteNode(map, n.id)); return; }
    const r = this.hitRoad(px, py);
    if (r) { this.edit(() => deleteRoad(map, r.R.id)); return; }
    const b = this.hitBld(px, py);
    if (b) this.edit(() => { map.blds.splice(map.blds.indexOf(b), 1); });
  },
  cancel() { if (this.chain) { this.chain = null; return true; } if (this.sel) { this.sel = null; this.panel(); return true; } return false; },

  /* ---------- 그리기 (2D 덧그림) ---------- */
  overlay(g) {
    const app = this.app, map = app.map, k = app.dpr;
    g.lineCap = 'round';
    // 노드 — 게이트는 네모, 신호는 동그라미, 나머지는 작은 점
    for (const N of app.net.nodes) {
      const q = Render.point(N.x, N.y, N.z + 0.3); if (!q || q.z > 3000) continue;
      const sel = this.sel && this.sel.t === 'node' && this.sel.id === N.id;
      g.fillStyle = sel ? '#5fd0ff' : N.gate ? '#f0b44a' : N.ctl === 'signal' ? '#5fc48f' : N.ctl === 'stop' ? '#e2574c' : N.ctl === 'merge' ? '#b48cf0' : '#c9ced8';
      g.strokeStyle = '#0b0d12'; g.lineWidth = 2 * k;
      const r = (N.gate ? 6 : N.legs.length > 2 ? 6 : 4) * k;
      g.beginPath(); if (N.gate) g.rect(q.x - r, q.y - r, r * 2, r * 2); else g.arc(q.x, q.y, r, 0, TAU); g.fill(); g.stroke();
    }
    // 고른 도로의 조절점
    const hs = this.handles();
    if (hs.length) {
      const r = mapRoad(map, this.sel.id), A = mapNode(map, r.a), B = mapNode(map, r.b);
      const pa = Render.point(A.x, A.y, 0), pb = Render.point(B.x, B.y, 0), p1 = Render.point(hs[0].x, hs[0].y, 0), p2 = Render.point(hs[1].x, hs[1].y, 0);
      if (pa && pb && p1 && p2) {
        g.strokeStyle = '#5fd0ffaa'; g.lineWidth = 1.5 * k; g.setLineDash([5 * k, 4 * k]);
        g.beginPath(); g.moveTo(pa.x, pa.y); g.lineTo(p1.x, p1.y); g.moveTo(pb.x, pb.y); g.lineTo(p2.x, p2.y); g.stroke(); g.setLineDash([]);
        for (const p of [p1, p2]) { g.fillStyle = '#5fd0ff'; g.strokeStyle = '#0b0d12'; g.lineWidth = 2 * k; g.beginPath(); g.rect(p.x - 6 * k, p.y - 6 * k, 12 * k, 12 * k); g.fill(); g.stroke(); }
      }
    }
    // 그리는 중인 도로
    if (this.tool === 'road' && this.chain && this.cursor) {
      const a = this.chain, n = a.node ? mapNode(map, a.node) : null;
      let ax, ay, az = 0;
      if (n) { ax = n.x; ay = n.y; az = LEVEL_Z[n.level] || 0; }
      else if (a.road) { const R = app.net.roadById.get(a.road), o = R ? shapeAt(R.g, a.sc) : null; if (o) { ax = o.x; ay = o.y; az = o.z; } }
      else { ax = a.x; ay = a.y; }
      const p = Render.point(ax, ay, az), gq = this.ground(this.cursor[0], this.cursor[1], 0);
      if (p && gq) {
        const q = Render.point(gq.x, gq.y, 0);
        if (q) {
          const cl = RCLS[this.road.cls], w = Math.max(3, (this.road.oneway ? this.road.n : this.road.n * 2) * cl.LW / 2) * 2;
          const sc = q.s || 1;
          g.strokeStyle = this.road.level === 'bridge' ? '#f0b44acc' : this.road.level === 'tunnel' ? '#b48cf0cc' : '#5fd0ffaa';
          g.lineWidth = Math.max(3 * k, w * sc); g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
          const L = Math.hypot(gq.x - ax, gq.y - ay);
          g.fillStyle = '#e6e9ef'; g.font = `600 ${12 * k}px system-ui,sans-serif`; g.textAlign = 'left';
          g.fillText(`${Math.round(L)} m`, q.x + 10 * k, q.y - 8 * k);
        }
      }
    }
    // 건물 끌기
    const d = this.drag;
    if (d && d.t === 'rect') {
      const P = [[d.x0, d.y0], [d.x1, d.y0], [d.x1, d.y1], [d.x0, d.y1]].map(([x, y]) => Render.point(x, y, 0));
      if (P.every(Boolean)) { g.fillStyle = '#5fd0ff33'; g.strokeStyle = '#5fd0ff'; g.lineWidth = 2 * k; g.beginPath(); P.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.fill(); g.stroke(); }
    }
    // 문제 표시 — 합류 못 하는 램프 · 겹친 교차로
    for (const w of app.net.warn) {
      const R = app.net.roadById.get(w.road); if (!R) continue;
      const o = shapeAt(R.g, R.L / 2), q = Render.point(o.x, o.y, o.z + 2); if (!q) continue;
      g.fillStyle = '#e2574c'; g.beginPath(); g.arc(q.x, q.y, 9 * k, 0, TAU); g.fill();
      g.fillStyle = '#fff'; g.font = `700 ${12 * k}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('!', q.x, q.y + 0.5);
      g.textBaseline = 'alphabetic';
    }
  },

  /* ---------- 속성 창 ---------- */
  panel() {
    const box = $('#propBox'), s = this.sel, map = this.app.map, net = this.app.net;
    if (!s || !this.app.editing) { box.style.display = 'none'; return; }
    let h = '';
    if (s.t === 'road') {
      const r = mapRoad(map, s.id); if (!r) { this.sel = null; return this.panel(); }
      const R = net.roadById.get(r.id), A = mapNode(map, r.a), B = mapNode(map, r.b);
      h += `<h3>도로 #${r.id} · ${R ? Math.round(R.L) + ' m' : ''}</h3>`;
      h += this.sel1('종류', 'pCls', Object.entries(RCLS).map(([k, c]) => [k, c.name]), r.cls);
      h += `<div class="pr"><label>차로 (방향마다)</label><span><input type="number" id="pNa" min="0" max="6" value="${r.lanes[0]}"> <i>${this.nodeName(A)}→${this.nodeName(B)}</i></span><span><input type="number" id="pNb" min="0" max="6" value="${r.lanes[1]}"> <i>${this.nodeName(B)}→${this.nodeName(A)}</i></span></div>`;
      h += this.sel1('높이', 'pLevel', [['ground', '지상 — 두 끝을 잇는다'], ['bridge', '고가 — 가운데를 7.5 m 로 (고가차도)'], ['tunnel', '지하 — 가운데를 -8 m 로 (지하차도)']], r.level || 'ground');
      h += `<div class="pbtns"><button id="pStraight">${r.c1 ? '직선으로' : '곡선: 조절점을 끄세요'}</button><button id="pFlip">방향 바꾸기</button><button id="pDel" class="bad">지우기</button></div>`;
      // 끝마다 회전 차로 · 차로별 방향
      for (const end of ['b', 'a']) {
        const N = end === 'b' ? B : A, L = R && R.links[end === 'b' ? 0 : 1];
        if (!L || !net.nodeById.get(N.id) || net.nodeById.get(N.id).legs.length < 3) continue;
        const E = (r.ends && r.ends[end]) || {};
        h += `<div class="pend"><b>${this.nodeName(end === 'b' ? A : B)} → ${this.nodeName(N)} 교차로 앞</b>`;
        h += `<div class="pr"><label>좌회전 전용</label><select data-end="${end}" data-k="bl">${[0, 1, 2].map((v) => `<option ${(E.bl | 0) === v ? 'selected' : ''}>${v}</option>`).join('')}</select><label>우회전 전용</label><select data-end="${end}" data-k="br">${[0, 1].map((v) => `<option ${(E.br | 0) === v ? 'selected' : ''}>${v}</option>`).join('')}</select><label>길이</label><input type="number" data-end="${end}" data-k="len" min="15" max="150" step="5" value="${E.len || CN.bayLen}"></div>`;
        h += `<div class="lanes">${L.endLanes.map((ln, i) => `<span class="ln"><em>${ln.type === 'bayL' ? '좌' : ln.type === 'bayR' ? '우' : i + 1}</em>${['L', 'S', 'R'].map((m) => `<button data-end="${end}" data-ln="${i}" data-mv="${m}" class="${ln.mv.includes(m) ? 'on' : ''}">${{ L: '↰', S: '↑', R: '↱' }[m]}</button>`).join('')}</span>`).join('')}${Array.isArray(E.mv) ? `<button data-end="${end}" data-auto="1" class="auto">자동</button>` : ''}</div></div>`;
      }
    } else if (s.t === 'node') {
      const n = mapNode(map, s.id); if (!n) { this.sel = null; return this.panel(); }
      const N = net.nodeById.get(n.id);
      h += `<h3>노드 ${this.nodeName(n)} · 갈래 ${N ? N.legs.length : 0}</h3>`;
      if (N && N.legs.length === 1) h += this.sel1('끝', 'pGate', [['auto', '자동 (' + (N.gate ? '도시 밖 출입구' : '막다른 길') + ')'], ['1', '도시 밖 출입구 — 차가 들어오고 나간다'], ['0', '막다른 길 — 돌림 원에서 돌아 나온다']], n.gate === true ? '1' : n.gate === false ? '0' : 'auto');
      if (N && N.gate) h += `<div class="pr"><label>드나드는 양 (배)</label><input type="number" id="pW" min="0.2" max="10" step="0.2" value="${n.w || 1}"></div>`;
      else if (N && N.ctl === 'end') h += '';
      else if (N && N.ctl === 'merge') h += `<div class="pnote">고속도로 합류 · 분류 — 신호 없이 가속 · 감속 차로로 드나든다.</div>`;
      else {
        h += this.sel1('제어', 'pCtl', [['auto', '자동 (' + ({ signal: '신호', stop: '일시정지', none: '없음' }[N ? N.ctl : 'none'] || '') + ')'], ['signal', '신호'], ['stop', '일시정지 — 작은 길이 선다'], ['none', '없음 — 엇갈리면 먼저 온 차']], n.ctl || 'auto');
        if (N && N.ctl === 'signal') {
          h += this.sel1('신호 방식', 'pPhase', [['', '지도 기본'], ['lead', '직진 후 좌회전'], ['approach', '방향별 동시']], n.phase || '');
          h += `<div class="pr"><label>주기 (초, 빈칸이면 기본)</label><input type="number" id="pCycle" min="40" max="200" step="5" value="${n.cycle || ''}" placeholder="${Math.round(N.plan ? N.plan.cyc : 100)}"></div>`;
        }
      }
      h += this.sel1('높이', 'pNLevel', [['ground', '지상 0 m'], ['bridge', '고가 7.5 m'], ['tunnel', '지하 -8 m']], n.level || 'ground');
      h += `<div class="pbtns"><button id="pDel" class="bad">노드와 붙은 도로 지우기</button></div>`;
    } else if (s.t === 'bld') {
      const b = map.blds.find((q) => q.id === s.id); if (!b) { this.sel = null; return this.panel(); }
      const B = net.blds.find((q) => q.id === b.id);
      h += `<h3>건물 #${b.id} · ${BLD_KIND[b.kind] || ''}</h3>`;
      h += this.sel1('용도', 'pKind', Object.entries(BLD_KIND), b.kind);
      h += `<div class="pr"><label>높이 (m)</label><input type="number" id="pH" min="4" max="200" step="1" value="${Math.round(b.h)}"><label>주차 (대)</label><input type="number" id="pCap" min="0" max="2000" step="5" value="${b.cap || ''}" placeholder="${B ? B.cap : bldCap(b)}"></div>`;
      h += `<div class="pr"><label>가로 · 세로 (m)</label><input type="number" id="pBw" min="6" max="200" value="${Math.round(b.w)}"><input type="number" id="pBd" min="6" max="200" value="${Math.round(b.d)}"><label>돌림 (°)</label><input type="number" id="pRot" step="5" value="${Math.round((b.rot || 0) * 180 / Math.PI)}"></div>`;
      h += `<div class="pnote">${B && B.din ? `출입구 — 도로 #${B.acc.road} ${B.acc.side > 0 ? '오른쪽' : '왼쪽'} 길가 차로에서 드나든다.` : '<b style="color:#e2574c">붙을 길이 없다</b> — 지상 일반도로 가까이(160 m 안) 옮기세요. 도시 밖 출입로 · 고속도로에는 붙지 않는다.'}</div>`;
      h += `<div class="pbtns"><button id="pFace">가까운 길과 나란히</button><button id="pDel" class="bad">지우기</button></div>`;
    }
    box.innerHTML = h;
    box.style.display = 'block';
    this.bindPanel();
  },
  sel1(label, id, opts, val) { return `<div class="pr"><label>${label}</label><select id="${id}">${opts.map(([k, t]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`; },
  nodeName(n) { return n ? '#' + n.id : '?'; },
  bindPanel() {
    const map = this.app.map, s = this.sel;
    const on = (id, ev, f) => { const el = $('#' + id); if (el) el.addEventListener(ev, f); };
    if (s.t === 'road') {
      const r = () => mapRoad(map, s.id);
      on('pCls', 'change', (e) => this.edit(() => { const q = r(), cl = RCLS[e.target.value]; q.cls = e.target.value; if (cl.fast && !q.lanes[1] && e.target.value === 'highway') q.lanes = cl.lanes.slice(); }));
      on('pNa', 'change', (e) => this.edit(() => { const q = r(); q.lanes[0] = clamp(+e.target.value | 0, 0, 6); if (!q.lanes[0] && !q.lanes[1]) q.lanes[0] = 1; }));
      on('pNb', 'change', (e) => this.edit(() => { const q = r(); q.lanes[1] = clamp(+e.target.value | 0, 0, 6); if (!q.lanes[0] && !q.lanes[1]) q.lanes[1] = 1; }));
      on('pLevel', 'change', (e) => this.edit(() => { r().level = e.target.value; autoSplit(map, s.id); }));
      on('pStraight', 'click', () => this.edit(() => straighten(r())));
      on('pFlip', 'click', () => this.edit(() => { const q = r(); [q.a, q.b] = [q.b, q.a]; q.lanes = [q.lanes[1], q.lanes[0]]; [q.c1, q.c2] = [q.c2, q.c1]; if (!q.c1) { delete q.c1; delete q.c2; } q.ends = { a: q.ends.b, b: q.ends.a }; }));
      on('pDel', 'click', () => { this.edit(() => deleteRoad(map, s.id)); this.sel = null; this.panel(); });
      for (const el of $$('#propBox [data-k]')) el.addEventListener('change', () => this.edit(() => { const q = r(), E = (q.ends[el.dataset.end] = q.ends[el.dataset.end] || {}); E[el.dataset.k] = +el.value; delete E.mv; }));
      for (const el of $$('#propBox [data-mv]')) el.addEventListener('click', () => this.edit(() => {
        const q = r(), end = el.dataset.end, R = this.app.net.roadById.get(q.id), L = R.links[end === 'b' ? 0 : 1];
        const E = (q.ends[end] = q.ends[end] || {});
        const cur = Array.isArray(E.mv) && E.mv.length === L.endLanes.length ? E.mv.slice() : L.endLanes.map((ln) => ln.mv);
        const i = +el.dataset.ln, m = el.dataset.mv;
        cur[i] = cur[i].includes(m) ? cur[i].replace(m, '') : 'LSR'.split('').filter((c) => cur[i].includes(c) || c === m).join('');
        if (!cur[i]) return;
        E.mv = cur;
      }));
      for (const el of $$('#propBox [data-auto]')) el.addEventListener('click', () => this.edit(() => { delete r().ends[el.dataset.end].mv; }));
    } else if (s.t === 'node') {
      const n = () => mapNode(map, s.id);
      on('pCtl', 'change', (e) => this.edit(() => { n().ctl = e.target.value; }));
      on('pPhase', 'change', (e) => this.edit(() => { if (e.target.value) n().phase = e.target.value; else delete n().phase; }));
      on('pCycle', 'change', (e) => this.edit(() => { const v = +e.target.value; if (v) n().cycle = clamp(v, 40, 200); else delete n().cycle; }));
      on('pW', 'change', (e) => this.edit(() => { n().w = clamp(+e.target.value || 1, 0.2, 10); }));
      on('pGate', 'change', (e) => this.edit(() => { if (e.target.value === 'auto') delete n().gate; else n().gate = e.target.value === '1'; }));
      on('pNLevel', 'change', (e) => this.edit(() => { n().level = e.target.value; }));
      on('pDel', 'click', () => { this.edit(() => deleteNode(map, s.id)); this.sel = null; this.panel(); });
    } else if (s.t === 'bld') {
      const b = () => map.blds.find((q) => q.id === s.id);
      on('pKind', 'change', (e) => this.edit(() => { b().kind = e.target.value; }));
      on('pH', 'change', (e) => this.edit(() => { b().h = clamp(+e.target.value, 4, 200); }));
      on('pCap', 'change', (e) => this.edit(() => { const v = +e.target.value; if (v) b().cap = clamp(v, 1, 2000); else delete b().cap; }));
      on('pBw', 'change', (e) => this.edit(() => { b().w = clamp(+e.target.value, 6, 200); }));
      on('pBd', 'change', (e) => this.edit(() => { b().d = clamp(+e.target.value, 6, 200); }));
      on('pRot', 'change', (e) => this.edit(() => { b().rot = (+e.target.value || 0) * Math.PI / 180; delete b().acc; }));
      on('pFace', 'click', () => this.edit(() => { const q = b(), a = nearestAccess(this.app.net, q); if (!a) return; const R = this.app.net.roadById.get(a.road), o = shapeAt(R.g, a.sc); q.rot = o.h; delete q.acc; }));
      on('pDel', 'click', () => { this.edit(() => { const q = b(); map.blds.splice(map.blds.indexOf(q), 1); }); this.sel = null; this.panel(); });
    }
  },
};
