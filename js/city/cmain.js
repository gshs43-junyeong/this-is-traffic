/* =============================================================================
   cmain.js — 도시 교통 시뮬레이터 앱 (입력 · 카메라 · HUD · 설정 · 편집 모드 전환)

   지도(cmap) → 도로망(compileNet) → 시뮬레이션(CitySim) → 그림(CScene).
   편집 모드(E)에서는 차를 멈추고 지도를 고친다(cedit). 고칠 때마다 도로망 · 그림을 새로 짓고,
   편집을 마치면 시뮬레이션을 새로 시작한다(4 분을 미리 돌려 빈 도시가 아니게).
   ========================================================================== */
'use strict';

const CCFG_DEFAULT = { demand: 2000, inner: 0.5, seed: 1, coord: false };
const SIDE_KO = { N: '북', E: '동', S: '남', W: '서' };
const MV_KO = { L: '좌회전', S: '직진', R: '우회전' };
const MAP_KEY = 'citymap2';

const CApp = {
  cfg: Object.assign({}, CCFG_DEFAULT),
  paused: false, speed: 1, mode: 'orbit', flow: false, night: false, editing: false,
  cam: { yaw: 0.9, pitch: -0.72, dist: 600, tx: 0, ty: 0, tz: 0 },
  sel: null, selN: null, selB: null,

  init() {
    try { const s = JSON.parse(localStorage.getItem('citycfg2') || 'null'); if (s) Object.assign(this.cfg, s); } catch (e) { /* 기본값 */ }
    try { const m = JSON.parse(localStorage.getItem(MAP_KEY) || 'null'); if (m && Array.isArray(m.nodes) && m.nodes.length) this.map = m; } catch (e) { /* 견본으로 */ }
    if (!this.map) this.map = makeTemplate('highway', { seed: 1 });
    this.cv = $('#view'); this.skyCv = $('#sky'); this.glCv = $('#gl');
    const wantGL = !/[?&]gl=0/.test(location.search);
    if (wantGL && Render.initGL(this.glCv)) {
      document.body.classList.add('gl');
      this.skyCtx = this.skyCv.getContext('2d', { alpha: false });
      this.ctx = this.cv.getContext('2d', { alpha: true });
      try { CScene.initGL(Render.gl); } catch (e) { console.warn(e); }
      Render.onLost = () => { document.body.classList.remove('gl'); this.skyCtx = null; this.toast('그래픽 가속을 잃었습니다 — 새로 고침하세요', 5); };
    } else {
      this.ctx = this.cv.getContext('2d', { alpha: false });
      $('#noGL').style.display = 'block';
    }
    this.bindUI();
    this.bindInput();
    CEdit.init(this);
    addEventListener('resize', () => this.resize());
    this.resize();
    this.rebuild(true);
    this.last = performance.now();
    try {
      if (!localStorage.getItem('cityHint2')) {
        setTimeout(() => this.toast('편집(E)에서 도로를 그리고 곡선 · 고가 · 지하 · 고속도로 · 차로 · 건물을 바꿉니다 · 교차로 · 차 · 건물을 누르면 자세히', 8), 3500);
        localStorage.setItem('cityHint2', '1');
      }
    } catch (e) { /* 안내만 빠진다 */ }
    requestAnimationFrame((t) => this.loop(t));
  },

  /** 지도 → 도로망 → (편집 중이 아니면) 시뮬레이션 → 그림 */
  rebuild(reframe) {
    this.net = compileNet(this.map);
    if (this.editing) this.sim = null;
    else {
      this.sim = new CitySim(this.net, this.cfg);
      const t0 = performance.now();
      while (this.sim.time < 240 && performance.now() - t0 < 1500) this.sim.step(2);
    }
    CScene.init(this.net, this.sim, this.night, this.cfg.seed);
    if (Render.gl) CScene.uploaded = false;
    this.sel = null; this.selN = null; this.selB = null;
    if (reframe) this.frame();
    this.fillPanel();
    this.updBtns();
    this.updMode();
  },
  /** 편집기가 지도를 고친 뒤 */
  mapChanged(reframe) {
    try { localStorage.setItem(MAP_KEY, JSON.stringify(this.map)); } catch (e) { /* 너무 크면 저장만 빠진다 */ }
    this.net = compileNet(this.map);
    CScene.init(this.net, null, this.night, this.cfg.seed);
    if (Render.gl) CScene.uploaded = false;
    if (reframe) this.frame();
    CEdit.panel();
    this.mapInfo();
  },
  frame() {
    const b = CScene.bounds(), asp = (this.cv.clientHeight || 1) / (this.cv.clientWidth || 1);
    this.cam.tx = (b.x0 + b.x1) / 2; this.cam.ty = (b.y0 + b.y1) / 2; this.cam.tz = 0;
    // 도시 밖으로 길게 뻗은 출입로는 빼고 크기를 잰다
    let r = 0; for (const N of this.net.nodes) if (!N.gate) r = Math.max(r, Math.hypot(N.x - this.cam.tx, N.y - this.cam.ty));
    this.cam.dist = clamp((r * 2.1 + 160) * Math.max(1, asp * 0.95), 150, 2600);
  },
  setEdit(on) {
    if (on === this.editing) return;
    this.editing = on;
    document.body.classList.toggle('editing', on);
    if (on) {
      this.mode = 'orbit';
      this.cam.pitch = Math.min(this.cam.pitch, -1.05);
      this.sim = null;
      CScene.init(this.net, null, this.night, this.cfg.seed); CScene.uploaded = false;
      CEdit.syncBar(); CEdit.panel(); this.mapInfo();
      this.toast('편집 — 도로(R) · 건물(B) · 지우개(X) · 선택(V), 되돌리기 Ctrl+Z, 다 되면 E', 4);
    } else {
      CEdit.chain = null; CEdit.sel = null; CEdit.panel();
      this.rebuild(false);
      this.toast(`도시 ${this.net.nodes.filter((n) => !n.gate).length}개 교차로 · 도로 ${this.net.roads.length}개 · 건물 ${this.net.blds.length}채로 다시 시작`, 3);
    }
    this.updMode();
  },
  /** 편집 중 지도 요약 · 문제 */
  mapInfo() {
    const net = this.net, el = $('#eInfo'); if (!el) return;
    const ctl = {}; for (const N of net.nodes) ctl[N.ctl] = (ctl[N.ctl] || 0) + 1;
    let km = 0; for (const R of net.roads) km += R.L / 1000;
    const noAcc = net.blds.filter((B) => !B.din).length;
    el.innerHTML = `도로 ${fmt1(km)} km · 신호 ${ctl.signal || 0} · 일시정지 ${ctl.stop || 0} · 합류 ${ctl.merge || 0} · 출입구 ${ctl.gate || 0} · 건물 ${net.blds.length}` +
      (noAcc ? ` · <b style="color:#e0a63a">길 없는 건물 ${noAcc}</b>` : '') +
      (net.warn.length ? `<br><b style="color:#e2574c">⚠ ${net.warn.map((w) => `#${w.road} ${w.msg}`).slice(0, 3).join(' · ')}</b>` : '') +
      (!net.gates.length ? '<br><b style="color:#e0a63a">끝이 열린 도로(도시 밖 출입구)가 없어 밖에서 오는 차가 없습니다</b>' : '');
  },

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.dpr = dpr;
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    for (const cv of [this.cv, this.skyCv, this.glCv]) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    this.W = this.cv.width; this.H = this.cv.height;
  },

  loop(t) {
    const raw = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    if (!this.paused && this.sim) {
      const t0 = performance.now();
      let left = raw * this.speed;
      while (left > 1e-6 && performance.now() - t0 < 30) { const h = Math.min(0.5, left); this.sim.step(h); left -= h; }
      this.lag = left > 1e-6;
      this.simMs = (this.simMs || 0) * 0.9 + (performance.now() - t0) * 0.1;
    }
    this.updateCam(raw);
    const t1 = performance.now();
    const es = this.editing ? CEdit.sel : null;
    CScene.draw(this.ctx, this.W, this.H, this.camPose, {
      skyCtx: this.skyCtx, sel: this.sel, flow: this.flow && !this.editing, edit: this.editing,
      selN: this.editing ? (es && es.t === 'node' ? this.net.nodeById.get(es.id) : null) : this.selN,
      selB: this.editing ? (es && es.t === 'bld' ? this.map.blds.find((b) => b.id === es.id) : null) : this.selB,
      selR: this.editing && es && es.t === 'road' ? this.net.roadById.get(es.id) : null,
      follow: this.mode === 'follow' || this.mode === 'driver', hide: this.mode === 'driver' ? this.sel : null,
    });
    this.overlay();
    this.drawMs = (this.drawMs || 0) * 0.9 + (performance.now() - t1) * 0.1;
    this.hudT = (this.hudT || 0) + raw;
    if (this.hudT > 0.25) {
      this.hudT = 0; this.hud();
      this.anaT = (this.anaT || 0) + 1;
      if (this.anaT % 8 === 0 && $('#panel').classList.contains('on')) this.analysis();
    }
    requestAnimationFrame((tt) => this.loop(tt));
  },

  /* ---------- 카메라 ---------- */
  updateCam(dt) {
    const c = this.cam;
    if (this.sel && this.sel.gone) {
      const g = this.sel; this.sel = null;
      if (this.mode === 'follow' || this.mode === 'driver') this.followNear(g.x, g.y);
      this.updMode();
    }
    const s = this.sel;
    if (this.mode === 'driver' && s) {
      const ch = Math.cos(s.h), sh = Math.sin(s.h), x = s.x + ch * s.len * 0.02 - sh * s.wid * 0.22, y = s.y + sh * s.len * 0.02 + ch * s.wid * 0.22;
      this.dYaw = this.dYaw == null ? s.h : this.dYaw + wrapPi(s.h - this.dYaw) * Math.min(1, dt * 10);
      this.camPose = { x, y, z: s.z + 1.12 * s.hei / 1.45, yaw: this.dYaw, pitch: (s.p || 0) - 0.06 };
      return;
    }
    if (this.mode === 'follow' && s) {
      const k = 1 - Math.exp(-dt / 0.4);
      this.fYaw = this.fYaw == null ? s.h : this.fYaw + wrapPi(s.h - this.fYaw) * k;
      const x = s.x - Math.cos(this.fYaw) * 11, y = s.y - Math.sin(this.fYaw) * 11, z = s.z + 4.6;
      this.fPos = this.fPos ? this.fPos.map((p, i) => p + ([x, y, z][i] - p) * Math.min(1, k * 2)) : [x, y, z];
      const [px, py, pz] = this.fPos, dx = s.x - px, dy = s.y - py;
      this.camPose = { x: px, y: py, z: pz, yaw: Math.atan2(dy, dx), pitch: Math.atan2(s.z + 1.2 - pz, Math.hypot(dx, dy)) };
      return;
    }
    if ((this.mode === 'follow' || this.mode === 'driver') && !s) { this.mode = 'orbit'; this.updMode(); }
    if (this.mode === 'top') c.pitch = approach(c.pitch, -1.5, 0.25, dt);
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    const x = c.tx - Math.cos(c.yaw) * cp * c.dist, y = c.ty - Math.sin(c.yaw) * cp * c.dist, z = c.tz - sp * c.dist;
    this.camPose = { x, y, z: Math.max(z, 2), yaw: c.yaw, pitch: c.pitch };
    this.fPos = null; this.fYaw = null; this.dYaw = null;
  },
  followNear(x, y) {
    let best = null, bd = Infinity;
    if (this.sim) for (const v of this.sim.cars) { const d = Math.hypot(v.x - x, v.y - y) + (v.v < 1 ? 60 : 0); if (d < bd) { bd = d; best = v; } }
    this.sel = best;
    if (!best) this.mode = 'orbit';
  },

  /* ---------- 입력 ---------- */
  bindInput() {
    const cv = this.cv;
    let drag = null;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    const pts = new Map();
    let pinch = null;
    const pinchState = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
    const pan = (dx, dy) => {
      const c = this.cam, k = c.dist / 650, b = CScene.bounds();
      c.tx += (-Math.sin(c.yaw) * dx + Math.cos(c.yaw) * dy) * k;
      c.ty += (Math.cos(c.yaw) * dx + Math.sin(c.yaw) * dy) * k;
      c.tx = clamp(c.tx, b.x0 - 400, b.x1 + 400); c.ty = clamp(c.ty, b.y0 - 400, b.y1 + 400);
    };
    const px = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * this.W / r.width, (e.clientY - r.top) * this.H / r.height]; };
    cv.addEventListener('pointerdown', (e) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      cv.setPointerCapture(e.pointerId);
      if (pts.size === 2) { pinch = pinchState(); drag = null; CEdit.drag = null; return; }
      const pan0 = e.button === 2 || e.shiftKey;
      drag = { x: e.clientX, y: e.clientY, b: e.button, sx: e.clientX, sy: e.clientY, pan: pan0, ed: false };
      if (this.editing && e.button === 2 && CEdit.cancel()) { drag = null; return; }
      if (this.editing && e.button === 0 && !e.shiftKey) { const [x, y] = px(e); drag.ed = CEdit.down(x, y); }
    });
    const lift = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
    cv.addEventListener('pointercancel', (e) => { lift(e); drag = null; CEdit.drag = null; });
    cv.addEventListener('pointermove', (e) => {
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.editing) { const [x, y] = px(e); CEdit.move(x, y); }
      if (pinch && pts.size === 2) {
        const q = pinchState(), c = this.cam;
        if (q.d > 10 && pinch.d > 10) c.dist = clamp(c.dist * pinch.d / q.d, 15, 3000);
        pan(q.x - pinch.x, q.y - pinch.y);
        pinch = q;
        return;
      }
      if (!drag || drag.ed) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      const c = this.cam;
      if (this.mode === 'follow' || this.mode === 'driver') {
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) this.toOrbitAtSel(); else return;
      }
      if (drag.pan) pan(dx, dy);
      else {
        c.yaw -= dx * 0.006;
        if (this.mode === 'top') { this.mode = 'orbit'; this.updMode(); }
        c.pitch = clamp(c.pitch - dy * 0.005, -1.54, -0.06);
      }
    });
    cv.addEventListener('pointerup', (e) => {
      lift(e);
      const click = drag && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5 && drag.b === 0;
      if (this.editing && drag && drag.b === 0 && !drag.pan) { const [x, y] = px(e); CEdit.up(x, y, click); }
      else if (click && !this.editing) { const [x, y] = px(e); this.pick(x, y); }
      drag = null;
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.mode === 'follow' || this.mode === 'driver') this.toOrbitAtSel();
      this.cam.dist = clamp(this.cam.dist * Math.exp(e.deltaY * 0.0012), 15, 3000);
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (this.editing) {
        if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) CEdit.doRedo(); else CEdit.doUndo(); return; }
        if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); CEdit.doRedo(); return; }
        if (k === 'v') return CEdit.setTool('select');
        if (k === 'r') return CEdit.setTool('road');
        if (k === 'b') return CEdit.setTool('bld');
        if (k === 'x') return CEdit.setTool('erase');
        if ((k === 'Delete' || k === 'Backspace') && CEdit.sel) { const s = CEdit.sel, m = this.map; CEdit.edit(() => { if (s.t === 'road') deleteRoad(m, s.id); else if (s.t === 'node') deleteNode(m, s.id); else m.blds.splice(m.blds.findIndex((b) => b.id === s.id), 1); }); CEdit.sel = null; CEdit.panel(); return; }
        if (k === 'Escape') { if (!CEdit.cancel() && $('#panel').classList.contains('on')) this.panel(false); return; }
        if (k === 'e') return this.setEdit(false);
        if (k === 't') return this.setMode(this.mode === 'top' ? 'orbit' : 'top');
        if (k === 'p') return this.panel(!$('#panel').classList.contains('on'));
        return;
      }
      if (k === ' ') { e.preventDefault(); this.togglePause(); }
      else if (k >= '1' && k <= '5') this.setSpeed([1, 2, 5, 10, 20][+k - 1]);
      else if (k === 'e') this.setEdit(true);
      else if (k === 't') this.setMode(this.mode === 'top' ? 'orbit' : 'top');
      else if (k === 'f') this.setMode('follow');
      else if (k === 'v') this.setMode(this.mode === 'driver' ? 'follow' : 'driver');
      else if (k === 'h') this.toggleFlow();
      else if (k === 'n') this.toggleNight();
      else if (k === 'g') this.togglePhase();
      else if (k === 'c') this.toggleCoord();
      else if (k === 'Escape') { if ($('#panel').classList.contains('on')) this.panel(false); else { this.sel = null; this.selN = null; this.selB = null; this.setMode('orbit'); } }
      else if (k === 'p') this.panel(!$('#panel').classList.contains('on'));
    });
  },
  toOrbitAtSel() {
    const s = this.sel, c = this.cam;
    this.mode = 'orbit';
    if (s) { c.tx = s.x; c.ty = s.y; c.tz = Math.max(0, s.z); c.dist = Math.min(c.dist, 90); c.yaw = s.h; }
    this.updMode();
  },
  /** 화면 점 → 차 (24 px 안) · 교차로 · 건물 */
  pick(px, py) {
    let best = null, bd = 24 * this.dpr;
    if (this.sim) for (const v of this.sim.cars) {
      const q = Render.point(v.x, v.y, v.z + 0.8); if (!q) continue;
      const d = Math.hypot(q.x - px, q.y - py); if (d < bd) { bd = d; best = v; }
    }
    this.sel = null; this.selN = null; this.selB = null;
    if (best) { this.sel = best; this.updMode(); return; }
    let bn = null, bdn = 26 * this.dpr;
    for (const N of this.net.nodes) { if (N.legs.length < 3) continue; const q = Render.point(N.x, N.y, N.z); if (!q) continue; const d = Math.hypot(q.x - px, q.y - py) - Math.max(0, ...N.legs.map((l) => l.sb)) * q.s * 0.6; if (d < bdn) { bdn = d; bn = N; } }
    if (bn) { this.selN = bn; this.updMode(); return; }
    const g = CEdit.ground(px, py, 0);
    if (g) for (const B of this.net.blds) if (distRect(g.x, g.y, B.m) < 0.5) { this.selB = B; break; }
    this.updMode();
  },
  setMode(m) {
    if ((m === 'follow' || m === 'driver') && !this.sel) {
      const c = this.cam; this.followNear(c.tx, c.ty);
      if (!this.sel) { this.toast(this.editing ? '편집 중에는 차가 없습니다 — E 로 편집을 마치세요' : '따라갈 차가 없습니다'); return; }
    }
    if (m === 'orbit' && (this.mode === 'follow' || this.mode === 'driver')) { this.toOrbitAtSel(); return; }
    this.mode = m;
    this.updMode();
  },
  updMode() { for (const b of $$('[data-mode]')) b.classList.toggle('on', b.dataset.mode === this.mode); $('#bEdit').classList.toggle('on', this.editing); },
  setSpeed(s) { this.speed = s; for (const b of $$('[data-speed]')) b.classList.toggle('on', +b.dataset.speed === s); },
  togglePause() { this.paused = !this.paused; $('#bPause').textContent = this.paused ? '▶ 계속' : '⏸ 일시정지'; $('#bPause').classList.toggle('on', this.paused); },
  toggleFlow() { this.flow = !this.flow; this.updBtns(); },
  toggleNight() {
    this.night = !this.night;
    PNIGHT = this.night;
    CScene.buildStatic(); CScene.uploaded = false;
    this.updBtns();
  },
  /** 신호 방식 · 연동 — 도로망은 두고 신호 계획만 (달리는 차는 그대로) */
  togglePhase() {
    this.map.sig.phase = this.map.sig.phase === 'approach' ? 'lead' : 'approach';
    this.resignal();
    this.toast(this.map.sig.phase === 'lead' ? '신호: 직진 후 좌회전 (마주 보는 길끼리 직진 → 좌회전)' : '신호: 방향별 동시 (진입로마다 차례로)');
  },
  toggleCoord() {
    this.cfg.coord = !this.cfg.coord;
    this.resignal();
    this.toast(this.cfg.coord ? '녹색 물결 켬 — 동쪽으로 가는 직진 녹색이 45 km/h 로 번진다' : '연동 끔 — 교차로마다 신호 시작이 제각각');
  },
  resignal() {
    for (const N of this.net.nodes) if (N.ctl === 'signal') { for (const c of N.conns) c.greens = []; signalPlanNode(N, this.map.sig); N.dEma = 0; N.dSum = 0; N.dN = 0; }
    if (this.sim) { this.sim.cfg = this.cfg; this.sim.retime(); }
    this.save(); this.updBtns(); this.fillPanel();
  },
  updBtns() {
    $('#bFlow').classList.toggle('on', this.flow);
    $('#bNight').textContent = this.night ? '야간' : '주간'; $('#bNight').classList.toggle('on', this.night);
    $('#bSig').textContent = this.map.sig.phase === 'approach' ? '방향별 동시' : '직진 후 좌회전';
    $('#bCoord').textContent = this.cfg.coord ? '연동 켬' : '연동 끔'; $('#bCoord').classList.toggle('on', !!this.cfg.coord);
  },
  save() {
    try { localStorage.setItem('citycfg2', JSON.stringify(this.cfg)); localStorage.setItem(MAP_KEY, JSON.stringify(this.map)); } catch (e) { /* 저장만 빠진다 */ }
  },

  /* ---------- 설정 ---------- */
  bindUI() {
    $('#bPause').onclick = () => this.togglePause();
    for (const b of $$('[data-speed]')) b.onclick = () => this.setSpeed(+b.dataset.speed);
    for (const b of $$('[data-mode]')) b.onclick = () => this.setMode(b.dataset.mode);
    $('#bFlow').onclick = () => this.toggleFlow();
    $('#bNight').onclick = () => this.toggleNight();
    $('#bSig').onclick = () => this.togglePhase();
    $('#bCoord').onclick = () => this.toggleCoord();
    $('#bEdit').onclick = () => this.setEdit(!this.editing);
    $('#bSet').onclick = () => this.panel(true);
    $('#bClose').onclick = () => this.panel(false);
    $('#bApply').onclick = () => { this.readPanel(); this.save(); this.panel(false); if (this.editing) this.setEdit(false); else this.rebuild(false); };
    for (const b of $$('[data-ptpl]')) b.onclick = () => {
      const v = (id) => +$('#t_' + id).value;
      const o = b.dataset.ptpl === 'grid' ? { NX: v('NX'), NY: v('NY'), B: v('B'), lanes: v('lanes'), seed: this.cfg.seed } : { seed: this.cfg.seed };
      CEdit.undo.push(JSON.stringify(this.map));
      this.map = makeTemplate(b.dataset.ptpl, o);
      this.readPanel(); this.save(); this.panel(false);
      if (this.editing) this.mapChanged(true); else this.rebuild(true);
      this.toast(`${this.map.name} — 건물 ${this.map.blds.length}채`, 3);
    };
    for (const el of $$('#panel input, #panel select')) el.addEventListener('input', () => this.readPanel(true));
    this.setSpeed(1);
  },
  panel(on) {
    $('#panel').classList.toggle('on', on);
    if (on) { this.fillPanel(); this.analysis(); }
  },
  fillPanel() {
    const c = this.cfg;
    $('#c_demand').value = c.demand; $('#c_inner').value = c.inner; $('#c_seed').value = c.seed; $('#c_coord').checked = !!c.coord;
    $('#c_phase').value = this.map.sig.phase || 'lead'; $('#c_cycle').value = this.map.sig.cycle || 100;
    this.readPanel(true);
  },
  readPanel(onlyLabels) {
    const v = (id) => +$('#' + id).value;
    $('#v_demand').textContent = fmt0(v('c_demand')) + ' 대/시'; $('#v_inner').textContent = Math.round(v('c_inner') * 100) + ' %';
    $('#v_seed').textContent = v('c_seed'); $('#v_cycle').textContent = v('c_cycle') + ' 초';
    for (const k of ['NX', 'NY', 'B', 'lanes']) { const el = $('#vt_' + k); if (el) el.textContent = $('#t_' + k).value + (k === 'B' ? ' m' : ''); }
    if (onlyLabels) return;
    const c = this.cfg;
    c.demand = v('c_demand'); c.inner = v('c_inner'); c.seed = v('c_seed'); c.coord = $('#c_coord').checked;
    this.map.sig.phase = $('#c_phase').value; this.map.sig.cycle = v('c_cycle');
  },
  analysis() {
    const N = this.net.nodes.filter((n) => n.ctl === 'signal' || n.ctl === 'stop').sort((a, b) => b.dEma - a.dEma).slice(0, 12);
    let h = '<table><tr><th>교차로 (지체 큰 순)</th><th>제어</th><th>평균 지체</th><th>서비스 수준</th><th>멈춘 차</th></tr>';
    for (const n of N) {
      let q = 0; for (const L of n.inLinks) for (const ln of L.lanes) for (const v of ln.cars) if (v.v < 1) q++;
      h += `<tr><td>#${n.id} (${n.legs.length}갈래)</td><td>${n.ctl === 'signal' ? '신호' : '일시정지'}</td><td>${fmt1(n.dEma)} 초</td><td style="color:${LOS_COL[n.los]};font-weight:700">${n.los}</td><td>${q}</td></tr>`;
    }
    $('#anaOut').innerHTML = h + '</table>';
  },

  /* ---------- HUD ---------- */
  hud() {
    const sim = this.sim;
    if (!sim) {
      $('#sCars').textContent = '편집 중'; $('#sV').textContent = '차 멈춤';
      $('#clock').textContent = '—';
      $('#perf').textContent = `그리기 ${fmt1(this.drawMs || 0)} ms`;
      return;
    }
    const S = sim.summary();
    $('#sCars').textContent = fmt0(S.n) + ' 대';
    $('#sV').textContent = '평균 ' + fmt1(S.vAvg * MS2K) + ' km/h';
    $('#sQ').textContent = fmt0(S.queued);
    $('#sPerH').textContent = fmt0(S.perH) + ' 대/시';
    $('#sTT').textContent = S.tt ? mmss(S.tt) : '—';
    $('#sDelay').textContent = S.tt ? mmss(S.delay) : '—';
    $('#sStops').textContent = S.tt ? fmt1(S.stops) + ' 번' : '—';
    $('#sPark').textContent = S.cap ? `${fmt0(S.occ)} / ${fmt0(S.cap)} (${Math.round(S.occ / S.cap * 100)}%)` : '—';
    $('#sBio').textContent = `${fmt0(S.bIn)} · ${fmt0(S.bOut)}`;
    $('#sJam').textContent = `${S.unjam} · ${S.detour}`;
    $('#clock').textContent = mmss(sim.time) + (this.lag ? ' (계산 밀림)' : '');
    const cnt = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
    for (const N of this.net.nodes) if (N.ctl === 'signal' || N.ctl === 'stop') cnt[N.los]++;
    $('#losBar').innerHTML = Object.keys(cnt).filter((k) => cnt[k]).map((k) => `<i style="background:${LOS_COL[k]};flex:${cnt[k]}">${k}</i>`).join('');
    this.chart();
    this.selInfo();
    $('#perf').textContent = `계산 ${fmt1(this.simMs || 0)} ms · 그리기 ${fmt1(this.drawMs || 0)} ms`;
  },
  chart() {
    const cv = $('#chart'), g = cv.getContext('2d'), W = cv.width, H = cv.height, hs = this.sim.st.hist;
    g.clearRect(0, 0, W, H); g.fillStyle = '#0c1016'; g.fillRect(0, 0, W, H);
    if (hs.length < 2) return;
    const n = Math.min(hs.length, 180), a = hs.slice(-n);
    let mx = 10; for (const p of a) mx = Math.max(mx, p.n);
    const line = (f, top, col) => {
      g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
      a.forEach((p, i) => { const x = i / (n - 1) * W, y = H - 4 - f(p) / top * (H - 10); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
    };
    line((p) => p.n, mx, '#e0a63a');
    line((p) => p.queued, mx, '#e2574c');
    line((p) => p.vAvg, 60 * KMH, '#5fc48f');
  },
  selInfo() {
    const box = $('#selBox'), sim = this.sim;
    if (this.editing || !sim) { box.style.display = 'none'; return; }
    if (this.selN) {
      const N = this.selN;
      let h = `<h3>교차로 #${N.id} · ${N.legs.length}갈래 · ${N.ctl === 'signal' ? '신호' : N.ctl === 'stop' ? '일시정지' : N.ctl === 'merge' ? '고속 합류 · 분류' : '제어 없음'}</h3>`;
      if (N.plan) {
        const ph = sim.phaseNow(N), P = N.plan.ph[ph.q], inG = ph.t < P.g;
        h += `<div class="ph">${N.plan.ph.map((p, k) => `<span class="${k === ph.q ? 'on' : ''}">${this.phaseName(N, p)}</span>`).join('')}</div>`;
        h += `<div class="row"><span class="k">지금</span><span class="v">${inG ? '녹색' : ph.t < P.g + CN.Y ? '황색' : '전적색'} · ${Math.ceil(inG ? P.g - ph.t : ph.left)} 초</span></div>`;
        h += `<div class="row"><span class="k">주기 · 시작 어긋남</span><span class="v">${Math.round(N.plan.cyc)} 초 · ${Math.round(N.offset)} 초</span></div>`;
      }
      if (N.ctl === 'signal' || N.ctl === 'stop') h += `<div class="row"><span class="k">평균 지체 · 서비스 수준</span><span class="v">${fmt1(N.dEma)} 초 · <b style="color:${LOS_COL[N.los]}">${N.los}</b></span></div>`;
      for (const L of N.inLinks) {
        let n = 0; for (const ln of L.lanes) for (const v of ln.cars) if (v.v < 1) n++;
        h += `<div class="row"><span class="k">${this.dirName(L)}에서 오는 ${L.road.cl.name} (${L.lanes.map((ln) => ln.mv ? { L: '↰', S: '↑', R: '↱', LS: '↰↑', SR: '↑↱', LSR: '↰↑↱', LR: '↰↱' }[ln.mv] || ln.mv : '').join(' ')})</span><span class="v">${n}</span></div>`;
      }
      box.innerHTML = h + `<div class="hint">신호 방식(G) · 연동(C) · 편집(E)에서 이 교차로의 회전 차로 · 제어를 바꿔 보세요.</div>`;
      box.style.display = 'block'; return;
    }
    if (this.selB) {
      const B = this.selB, b = B.m;
      box.innerHTML = `<h3>건물 #${b.id} · ${BLD_KIND[b.kind] || ''} · ${Math.round(b.h)} m</h3>` +
        `<div class="row"><span class="k">주차</span><span class="v">${B.occ} / ${B.cap} 대</span></div>` +
        `<div class="row"><span class="k">들어옴 · 나감</span><span class="v">${B.nIn} · ${B.nOut}</span></div>` +
        `<div class="row"><span class="k">오는 중 · 문 앞 대기</span><span class="v">${B.inbound} · ${B.queue}</span></div>` +
        `<div class="hint">${B.din ? `도로 #${B.acc.road} 길가 차로에서 진입로로 들어가고, 나올 때는 차로 틈을 본다.` : '붙을 길이 없어 차가 드나들지 않는다.'}</div>`;
      box.style.display = 'block'; return;
    }
    const v = this.sel;
    if (!v || v.gone) { box.style.display = 'none'; return; }
    const nm = (o) => (o.bld ? `건물 #${o.bld.id} (${BLD_KIND[o.bld.m.kind] || ''})` : `도시 밖 (#${o.gate.N.id})`);
    let next = '—';
    const e = v.edge;
    if (e.kind === 'conn') next = MV_KO[e.mv] + ' 중';
    else if (e.kind === 'din') next = '건물로 들어가는 중';
    else if (e.kind === 'dout') next = '건물에서 나와 차로 틈을 보는 중';
    else if (v.conn) next = `${MV_KO[v.conn.mv]} (${Math.round(e.len - v.s)} m 앞)`;
    else if (v.dest.bld && v.dest.bld.link === e.link) next = `목적지 건물 (${Math.max(0, Math.round(v.dest.bld.sIn - v.s))} m 앞)`;
    else if (e.link && e.link.to.gate) next = '도시 밖으로';
    const road = e.link ? `${e.link.road.cl.name} ${LEVEL_KO[e.link.road.level] !== '지상' ? '(' + (v.z > 2 ? '고가' : v.z < -2 ? '지하' : '지상') + ')' : ''}` : e.kind === 'conn' ? '교차로 안' : '진입로';
    let left = 0; for (let q = v.ri + 1; q < v.route.length; q++) left += v.route[q].len;
    box.innerHTML = `<h3>${v.cls.name} #${v.id}</h3>` +
      `<div class="row"><span class="k">출발</span><span class="v">${nm(v.trip.o)}</span></div>` +
      `<div class="row"><span class="k">목적지</span><span class="v">${nm(v.dest)}</span></div>` +
      `<div class="row"><span class="k">지금 · 속도</span><span class="v">${road} · ${fmt1(v.v * MS2K)} km/h</span></div>` +
      `<div class="row"><span class="k">다음</span><span class="v">${next}</span></div>` +
      `<div class="row"><span class="k">달린 시간 · 정지</span><span class="v">${mmss(sim.time - v.trip.t0)} · ${v.stops} 번</span></div>` +
      `<div class="row"><span class="k">남은 길</span><span class="v">약 ${distStr(left + (e.len - v.s))}</span></div>` +
      `<div class="hint">하늘색 띠가 앞으로 갈 길 — 막히면 교차로에서 다시 고른다. F 따라가기 · V 운전석.</div>`;
    box.style.display = 'block';
  },
  dirName(L) { const o = L.center(L.len, {}), h = wrapPi(o.h + Math.PI), a = ((h * 180 / Math.PI) + 360) % 360; return ['동', '북동', '북', '북서', '서', '남서', '남', '남동'][Math.round(a / 45) % 8] + '쪽'; },
  phaseName(N, p) {
    const dirs = [...new Set(p.legs.map((l) => this.dirName(l.inLink).replace('쪽', '')))].join('·');
    return dirs + (p.kind === 'S' ? ' 직진' : p.kind === 'L' ? ' 좌회전' : ' 진입');
  },
  /** 소통 지도일 때 교차로 서비스 수준 글자 · 편집 덧그림 */
  overlay() {
    const g = this.ctx;
    if (this.editing) { CEdit.overlay(g); return; }
    if (!this.flow || this.mode === 'driver' || this.mode === 'follow') return;
    const k = this.H / 900;
    g.font = `700 ${Math.round(13 * k + 2)}px system-ui,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const N of this.net.nodes) {
      if (N.ctl !== 'signal' && N.ctl !== 'stop') continue;
      const q = Render.point(N.x, N.y, N.z + 14); if (!q || q.z > 3000) continue;
      const r = 11 * k + 3;
      g.fillStyle = '#0d1118d0'; g.beginPath(); g.arc(q.x, q.y, r, 0, TAU); g.fill();
      g.strokeStyle = LOS_COL[N.los]; g.lineWidth = 2.5 * k + 0.5; g.stroke();
      g.fillStyle = LOS_COL[N.los]; g.fillText(N.los, q.x, q.y + 0.5);
    }
    g.textBaseline = 'alphabetic';
  },
  toast(msg, sec) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.remove('on'), (sec || 2.5) * 1000);
  },
};

addEventListener('DOMContentLoaded', () => CApp.init());
