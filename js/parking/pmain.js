/* =============================================================================
   pmain.js — 주차장 시뮬레이터 앱 (입력 · 카메라 · HUD · 설정)
   ========================================================================== */
'use strict';

const PCFG_DEFAULT = {
  W: 64, D: 52, U: 4, B: 2,
  inRate: 220, outRate: 200, thruRate: 240, initOcc: 0.55,
  revShare: 0.7, gate: 'lpr', guide: false, balk: 7, seed: 7, lanes: 1, kind: 'ramp', pattern: 'flat', throat: 0,
};
const PPRESETS = {
  tower: { W: 52, D: 46, U: 6, B: 0, inRate: 200, outRate: 160, initOcc: 0.5, label: '주차타워' },
  under: { W: 72, D: 56, U: 0, B: 3, inRate: 240, outRate: 220, initOcc: 0.6, label: '지하주차장' },
  mixed: { W: 64, D: 52, U: 4, B: 2, inRate: 220, outRate: 200, initOcc: 0.55, label: '복합' },
  rush: { W: 64, D: 52, U: 3, B: 2, inRate: 520, outRate: 60, initOcc: 0.7, label: '출근 몰림' },
  leave: { W: 64, D: 52, U: 3, B: 2, inRate: 40, outRate: 600, initOcc: 0.95, label: '퇴근 몰림' },
  office: { W: 64, D: 52, U: 3, B: 2, inRate: 300, outRate: 300, initOcc: 0.05, pattern: 'office', label: '업무시설 하루' },
  mech: { kind: 'mech', W: 40, D: 52, U: 12, B: 0, inRate: 120, outRate: 100, initOcc: 0.6, label: '기계식 주차타워' },
};

/** 기계식 승강기 단계 → 고른 차 칸의 상태 글 */
const MECH_STATE = {
  in: '입고실로 들어가는 중', alight: '입고실 — 운전자가 내리는 중', up: '승강기가 칸 높이로 오르는 중', push: '칸으로 밀어 넣는 중', down: '입고 — 승강기 복귀',
  fetch: '출고 — 승강기가 칸으로 가는 중', pull: '출고 — 칸에서 끌어내는 중', lower: '출고 — 1층으로 내려오는 중', turn: '출고 — 턴테이블이 차를 돌리는 중',
  board: '출고 — 운전자가 타는 중', out: '출고 — 출구로', clear: '출고 — 출구로',
};

const PApp = {
  cfg: Object.assign({}, PCFG_DEFAULT),
  paused: false, speed: 1, time: 0, mode: 'orbit',
  cam: { yaw: 2.3, pitch: -0.62, dist: 95, tx: 0, ty: 0, tz: 0 },
  cut: 0, sel: null,

  init() {
    try { const s = JSON.parse(localStorage.getItem('parkcfg') || 'null'); if (s) Object.assign(this.cfg, s); } catch (e) { /* 저장소가 막혀도 기본값으로 돈다 */ }
    this.cv = $('#view'); this.skyCv = $('#sky'); this.glCv = $('#gl');
    const wantGL = !/[?&]gl=0/.test(location.search);
    if (wantGL && Render.initGL(this.glCv)) {
      document.body.classList.add('gl');
      this.skyCtx = this.skyCv.getContext('2d', { alpha: false });
      this.ctx = this.cv.getContext('2d', { alpha: true });
      try { PScene.initGL(Render.gl); } catch (e) { console.warn(e); }
      Render.onLost = () => { document.body.classList.remove('gl'); this.skyCtx = null; this.toast('그래픽 가속을 잃었습니다 — 새로 고침하세요', 5); };
    } else {
      this.ctx = this.cv.getContext('2d', { alpha: false });
      $('#noGL').style.display = 'block';
    }
    this.bindUI();
    this.bindInput();
    this.rebuild();
    addEventListener('resize', () => this.resize());
    this.resize();
    this.last = performance.now();
    // 처음 온 사람에게 한 번 — 규모 · 차량 수는 설정에서
    try {
      if (!localStorage.getItem('parkHint')) {
        setTimeout(() => this.toast('설정(P)에서 형식 · 가로 · 세로 · 층수와 들어오고 나가는 차량 수를 정할 수 있습니다', 6), 4500);
        localStorage.setItem('parkHint', '1');
      }
    } catch (e) { /* 저장소가 막혀도 안내만 빠진다 */ }
    requestAnimationFrame((t) => this.loop(t));
  },

  rebuild() {
    const c = this.cfg;
    c.U = clamp(c.U | 0, 0, 20); c.B = clamp(c.B | 0, 0, 10);
    if (c.U + c.B < 1) c.U = 1;
    const mech = c.kind === 'mech';
    this.G = mech ? buildMech(c) : buildGarage(c);
    this.sim = mech ? new MechSim(this.G, c) : new ParkSim(this.G, c);
    PScene.init(this.G, this.sim, this.night);
    // 따라가던 차가 주차를 마치면 내린 운전자를 따라 계단실까지 간다
    this.sim.onPed = (p) => { if (this.sel === p.car && !p.toCar && (this.mode === 'follow' || this.mode === 'driver')) { this.sel = p; if (this.mode === 'driver') this.setMode('follow'); } };
    this.sim.onPedEnd = (p) => { if (this.sel === p) { this.sel = p.car; if (!p.toCar) this.setMode('orbit'); } };
    if (Render.gl) PScene.uploaded = false;
    this.cut = this.G.NL - 1;
    this.sel = null; this.mode = 'orbit';
    const G = this.G;
    this.cam.tx = G.W / 2; this.cam.ty = G.D / 2 - 4; this.cam.tz = G.levels[this.cut].z;
    // 세로 화면(휴대폰)에서는 가로 시야가 좁아 더 물러선다
    const asp = (this.cv.clientHeight || 1) / (this.cv.clientWidth || 1);
    this.cam.dist = clamp((Math.hypot(G.W, G.D) * 1.05 + G.NL * 3) * Math.max(1, asp * 0.95), 60, 420);
    this.fillPanel();
    // 기계식에는 통로가 없어 열지도 · 고장 차가 뜻이 없다
    for (const id of ['#bHeat', '#bInc']) { const b = $(id); if (b) { b.disabled = !!this.G.mech; b.style.opacity = this.G.mech ? 0.35 : 1; } }
    if (this.G.mech && this.heat) this.toggleHeat();
    const S = this.sim.summary();
    this.toast(G.mech ? `기계식 주차타워 ${G.towers.length}기 · 탑마다 ${G.NL}단 · 주차면 ${S.total}면 — 입고실에 세우면 승강기가 칸에 넣습니다`
      : `${G.levels[0].name}~${G.levels[G.NL - 1].name} · 주차면 ${S.total}면 · 경사로 최대 ${fmt1(G.grade * 100)}%`, 4);
    this.updMode();
  },

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    for (const c of [this.cv, this.skyCv, this.glCv]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    this.W = this.cv.width; this.H = this.cv.height;
  },

  loop(t) {
    const raw = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    if (!this.paused) {
      const dt = raw * this.speed;
      const t0 = performance.now();
      this.sim.step(dt);
      this.simMs = (this.simMs || 0) * 0.9 + (performance.now() - t0) * 0.1;
      this.time += raw;
    }
    if (this.tour) this.tourStep(raw);
    this.updateCam(raw);
    const t1 = performance.now();
    PScene.draw(this.ctx, this.W, this.H, this.camPose, { cut: this.cut, skyCtx: this.skyCtx, time: this.sim.time, sel: this.sel, follow: this.mode === 'follow' || this.mode === 'driver', hide: this.mode === 'driver' ? this.sel : null, heat: this.heat, guide: this.cfg.guide, dt: raw * (this.paused ? 0 : this.speed) });
    this.overlay();
    this.drawMs = (this.drawMs || 0) * 0.9 + (performance.now() - t1) * 0.1;
    this.hudT = (this.hudT || 0) + raw;
    if (this.hudT > 0.25) { this.hudT = 0; this.hud(); this.anaT = (this.anaT || 0) + 1; if (this.anaT % 8 === 0 && $('#panel').classList.contains('on')) this.analysis(); }
    requestAnimationFrame((tt) => this.loop(tt));
  },

  /* ---------- 카메라 ---------- */
  updateCam(dt) {
    const G = this.G, c = this.cam;
    const v = this.sel;
    if (v && v.mode === 'done') { this.sel = null; this.mode = 'orbit'; this.updMode(); }
    // 운전석 시점 — 따라가는 차의 운전석(왼쪽 앞)에서 본다. 그 차는 그리지 않는다
    if (this.mode === 'driver' && this.sel && !this.sel.pts) {
      const s = this.sel, ch = Math.cos(s.h), sh = Math.sin(s.h);
      const fwd = s.len * 0.02, left = s.wid * 0.22, eye = 1.12 * s.hei / 1.45;
      const x = s.x + ch * fwd - sh * left, y = s.y + sh * fwd + ch * left;
      this.dYaw = this.dYaw == null ? s.h : this.dYaw + wrapPi(s.h - this.dYaw) * Math.min(1, dt * 10);
      this.camPose = { x, y, z: s.z + eye, yaw: this.dYaw, pitch: (s.p || 0) - 0.08 };
      this.cut = G.NL - 1;
      return;
    }
    if (this.mode === 'driver' && (!this.sel || this.sel.pts)) this.mode = 'follow';
    if (this.mode === 'follow' && this.sel) {
      const s = this.sel;
      const k = 1 - Math.exp(-dt / 0.35);
      const wantYaw = s.h;
      this.fYaw = this.fYaw == null ? wantYaw : this.fYaw + wrapPi(wantYaw - this.fYaw) * k;
      const ped = !!s.pts, back = ped ? 5.0 : 8.5, up = ped ? 2.7 : 3.2;
      let x = s.x - Math.cos(this.fYaw) * back, y = s.y - Math.sin(this.fYaw) * back, z = s.z + up;
      const lv = PScene.lvAt(s.z);
      const inside = s.z > -900 && x > -1 && x < G.W + 1 && y > -1 && y < G.D + 1;
      if (inside) {
        x = clamp(x, 0.6, G.W - 0.6); y = clamp(y, 0.6, G.D - 0.6);
        const ceil = G.levels[lv].z + G.H - PK.slab - 0.35;
        if (lv < G.NL - 1 || G.levels[lv].under) z = Math.min(z, Math.max(s.z + 1.4, ceil));
      }
      this.fPos = this.fPos ? this.fPos.map((p, i) => p + ([x, y, z][i] - p) * Math.min(1, k * 2)) : [x, y, z];
      const [px, py, pz] = this.fPos;
      const dx = s.x - px, dy = s.y - py, dz = s.z + (ped ? 1.2 : 1.0) - pz;
      this.camPose = { x: px, y: py, z: pz, yaw: Math.atan2(dy, dx), pitch: Math.atan2(dz, Math.hypot(dx, dy)) };
      this.cut = G.NL - 1;
      return;
    }
    if (this.mode === 'top') { c.pitch = approach(c.pitch, -1.5, 0.25, dt); }
    const tz = G.levels[this.cut].z;
    c.tz = approach(c.tz, tz, 0.3, dt);
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    const x = c.tx - Math.cos(c.yaw) * cp * c.dist, y = c.ty - Math.sin(c.yaw) * cp * c.dist, z = c.tz - sp * c.dist;
    this.camPose = { x, y, z: Math.max(z, c.tz + 1.5), yaw: c.yaw, pitch: c.pitch };
  },

  /** 높이의 층 이름 — 기계식 탑 1층(입출고실 · 로비)은 칸 층이 아니다 */
  lvName(z) {
    const G = this.G;
    if (G.towers && z < MK.ground - 0.6) return '1F (입출고실)';
    return G.levels[PScene.lvAt(z)].name;
  },

  /* ---------- 입력 ---------- */
  bindInput() {
    const cv = this.cv;
    let drag = null;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    // 두 손가락: 벌리고 오므려 확대 · 함께 밀어 이동
    const pts = new Map();
    let pinch = null;
    const pinchState = () => {
      const [a, b2] = [...pts.values()];
      return { d: Math.hypot(a.x - b2.x, a.y - b2.y), x: (a.x + b2.x) / 2, y: (a.y + b2.y) / 2 };
    };
    cv.addEventListener('pointerdown', (e) => {
      if (this.tour) this.toggleTour();               // 손으로 시점을 잡으면 자동 관람을 멈춘다
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      cv.setPointerCapture(e.pointerId);
      if (pts.size === 2) { pinch = pinchState(); drag = null; return; }
      drag = { x: e.clientX, y: e.clientY, b: e.button, sx: e.clientX, sy: e.clientY, pan: e.button === 2 || e.shiftKey };
    });
    const lift = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
    cv.addEventListener('pointercancel', (e) => { lift(e); drag = null; });
    cv.addEventListener('pointermove', (e) => {
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) {
        const q = pinchState(), c = this.cam;
        if (q.d > 10 && pinch.d > 10) c.dist = clamp(c.dist * pinch.d / q.d, 12, 420);
        const k = c.dist / 650, dx = q.x - pinch.x, dy = q.y - pinch.y;
        c.tx += (-Math.sin(c.yaw) * dx + Math.cos(c.yaw) * dy) * k;
        c.ty += (Math.cos(c.yaw) * dx + Math.sin(c.yaw) * dy) * k;
        pinch = q;
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      const c = this.cam;
      if (this.mode === 'follow' || this.mode === 'driver') { if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) { this.mode = 'orbit'; this.retarget(); this.updMode(); } else return; }
      if (drag.pan) {
        // 화면 오른쪽 = (sin yaw, -cos yaw), 화면 앞 = (cos yaw, sin yaw) — 끌면 땅을 잡아 끄는 느낌
        const k = c.dist / 650;
        c.tx += (-Math.sin(c.yaw) * dx + Math.cos(c.yaw) * dy) * k;
        c.ty += (Math.cos(c.yaw) * dx + Math.sin(c.yaw) * dy) * k;
        c.tx = clamp(c.tx, -60, this.G.W + 60); c.ty = clamp(c.ty, -60, this.G.D + 60);
      } else {
        c.yaw -= dx * 0.006;
        if (this.mode === 'top') this.mode = 'orbit', this.updMode();
        c.pitch = clamp(c.pitch - dy * 0.005, -1.52, -0.08);
      }
    });
    cv.addEventListener('pointerup', (e) => {
      lift(e);
      if (drag && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5 && drag.b === 0) this.pick(e.clientX, e.clientY);
      drag = null;
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.dist = clamp(this.cam.dist * Math.exp(e.deltaY * 0.0012), 12, 420);
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      const k = e.key;
      if (k === ' ') { e.preventDefault(); this.togglePause(); }
      else if (k === 'PageUp' || k === ']' || k === 'e' || k === 'E') this.setCut(this.cut + 1);
      else if (k === 'PageDown' || k === '[' || k === 'q' || k === 'Q') this.setCut(this.cut - 1);
      else if (k >= '1' && k <= '5') this.setSpeed([1, 2, 5, 10, 30][+k - 1]);
      else if (k === 't' || k === 'T') { if (this.tour) this.toggleTour(); this.setMode(this.mode === 'top' ? 'orbit' : 'top'); }
      else if (k === 'f' || k === 'F') { if (this.tour) this.toggleTour(); this.followRandom(); }
      else if (k === 'a' || k === 'A') this.toggleTour();
      else if (k === 'v' || k === 'V') { if (this.tour) this.toggleTour(); this.setMode(this.mode === 'driver' ? 'follow' : 'driver'); }
      else if (k === 'h' || k === 'H') this.toggleHeat();
      else if (k === 'n' || k === 'N') this.toggleNight();
      else if (k === 'i' || k === 'I') this.incident();
      else if (k === 'Escape') { if ($('#panel').classList.contains('on')) this.panel(false); else { if (this.tour) this.toggleTour(); this.sel = null; this.setMode('orbit'); } }
      else if (k === 'p' || k === 'P') this.panel(!$('#panel').classList.contains('on'));
    });
  },
  retarget() {
    const s = this.sel; if (!s) return;
    if (s.gone) { this.sel = s.car || null; return this.retarget(); }
    this.cam.tx = s.x; this.cam.ty = s.y; this.cam.dist = Math.min(this.cam.dist, 40);
    this.cut = PScene.lvAt(s.z);
  },
  pick(cx, cy) {
    const r = this.cv.getBoundingClientRect(), dpr = this.W / r.width;
    const px = (cx - r.left) * dpr, py = (cy - r.top) * dpr;
    let best = null, bd = 34 * dpr;
    const zCut = this.G.levels[this.cut].z + this.G.H * 0.98;
    for (const v of this.sim.cars) {
      if (v.mode === 'done' || (this.mode !== 'follow' && v.z > zCut - 0.6)) continue;
      const q = Render.point(v.x, v.y, v.z + 0.8);
      if (!q) continue;
      const d = Math.hypot(q.x - px, q.y - py);
      if (d < bd) { bd = d; best = v; }
    }
    for (const p of this.sim.peds) {
      if (p.delay > 0 || (this.mode !== 'follow' && p.z > zCut - 0.6)) continue;
      const q = Render.point(p.x, p.y, p.z + 1.0);
      if (!q) continue;
      const d = Math.hypot(q.x - px, q.y - py);
      if (d < bd) { bd = d; best = p; }
    }
    this.sel = best;
    this.hud();
  },
  /** 자동 관람 — 볼 만한 장면(주차 조작 · 빈 자리 찾기 · 출차 · 승강기)을 골라 15 초 남짓씩 옮겨 다닌다 */
  toggleTour() {
    this.tour = !this.tour; this.tourT = 0; this.tourLast = null;
    $('#bTour').classList.toggle('on', this.tour);
    if (this.tour) this.toast('자동 관람 — 볼 만한 장면을 골라 옮겨 다닙니다 (화면을 끌거나 A 로 멈춤)', 3.5);
    else this.toast('자동 관람을 멈췄습니다', 1.5);
  },
  tourStep(dt) {
    const s = this.sel;
    this.tourT -= dt;
    // 따라가던 차가 주차를 마치거나 나가면 조금 더 보고 넘어간다
    if (s && this.tourKind === 'car' && (s.mode === 'done' || (s.mode === 'parked' && !s.leaving)) && this.tourT > 2.5) this.tourT = 2.5;
    if (s && this.tourKind === 'tower' && this.tourTower && this.tourTower.state === 'idle' && this.tourT > 2) this.tourT = 2;
    if (this.tourT > 0 && s && s.mode !== 'done') return;
    const G = this.G, sim = this.sim, C = [];
    const add = (w, o) => { if (o.car !== this.tourLast) C.push(Object.assign({ w }, o)); };
    if (G.mech) {
      for (const T of G.towers) if (T.carOn && T.state !== 'idle') add(['lower', 'turn', 'board', 'push', 'up'].includes(T.state) ? 4 : 2, { kind: 'tower', T, car: T.carOn });
      for (const v of sim.cars) if (v.mode === 'drive' && v.role === 'park' && v.edge && v.edge.kind === 'entry') add(0.6, { kind: 'car', car: v });
    } else {
      for (const v of sim.cars) {
        if (v.mode === 'man') add(5, { kind: 'car', car: v });
        else if (v.mode === 'drive' && v.plan) add(4, { kind: 'car', car: v });
        else if (v.mode === 'drive' && v.inside && v.searching && !v.done) add(1.5, { kind: 'car', car: v });
        else if (v.mode === 'drive' && v.inside && v.leaving && !v.done) add(1, { kind: 'car', car: v });
      }
      for (const p of sim.peds) if (p.toCar && p.car && p.k < p.pts.length - 2) add(0.5, { kind: 'car', car: p });
    }
    if (!C.length) for (const v of sim.cars) if (v.mode === 'drive' && v.role === 'park' && !v.done) add(1, { kind: 'car', car: v });   // 아직 안에 차가 없으면 들어오는 차
    if (!C.length) { this.tourT = 1.5; return; }
    let r = Math.random() * C.reduce((a, c) => a + c.w, 0), pick = C[0];
    for (const c of C) { r -= c.w; if (r <= 0) { pick = c; break; } }
    this.tourLast = pick.car; this.tourKind = pick.kind; this.tourTower = pick.T || null;
    this.sel = pick.car;
    if (pick.kind === 'tower') {
      this.setMode('orbit');
      Object.assign(this.cam, { tx: pick.T.x + 0.6, ty: 1.5, dist: 20 + Math.random() * 8, yaw: Math.PI / 2 + (Math.random() - 0.5) * 0.9, pitch: -0.32 });
      this.cut = 0;
      this.tourT = 16 + Math.random() * 6;
    } else {
      this.setMode('follow');
      this.tourT = 13 + Math.random() * 6;
    }
  },
  followRandom() {
    const c = this.sim.cars.filter((v) => (v.mode === 'drive' && v.inside) || v.mode === 'man');
    if (!c.length) { this.toast('지금 움직이는 차가 없습니다', 2); return; }
    this.sel = this.sim.rng.pick(c);
    this.setMode('follow');
  },
  setMode(m) {
    if ((m === 'follow' || m === 'driver') && !this.sel) { this.followRandom(); if (m === 'driver' && this.sel) this.mode = 'driver'; this.updMode(); return; }
    this.dYaw = null;
    this.mode = m; this.fPos = null; this.fYaw = null;
    if (m !== 'follow' && this.sel) this.retarget();
    this.updMode();
  },
  updMode() { for (const b of $$('[data-mode]')) b.classList.toggle('on', b.dataset.mode === this.mode); },
  setCut(c) { this.cut = clamp(c, 0, this.G.NL - 1); if (this.mode === 'follow') this.setMode('orbit'); this.hud(); },
  /** 주간 · 야간 — 바깥 색이 구워진 고정 메쉬를 다시 짓는다 (큰 주차장은 1 초 남짓) */
  toggleNight() {
    this.night = !this.night;
    PScene.init(this.G, this.sim, this.night);
    if (Render.gl) PScene.uploaded = false;
    $('#bNight').classList.toggle('on', this.night);
    $('#bNight').textContent = this.night ? '야간' : '주간';
  },
  /** 통로 고장 차 — 그 차를 비추고 알린다 */
  incident() {
    if (this.G.mech) { this.toast('기계식에는 통로가 없습니다', 2); return; }
    const v = this.sim.incident();
    if (!v) { this.toast(this.sim.brokenCar ? '이미 고장 난 차가 있습니다' : '지금 통로를 달리는 차가 없습니다', 2.5); return; }
    this.sel = v; this.cut = PScene.lvAt(v.z); this.mode = 'orbit'; this.retarget(); this.updMode();
    this.toast(`${this.G.levels[PScene.lvAt(v.z)].name} 통로에서 차가 고장으로 섰습니다 — ${Math.round((v.brokenUntil - this.sim.time) / 60)}분쯤 뒤 움직입니다`, 4);
  },
  toggleHeat() {
    this.heat = !this.heat; $('#bHeat').classList.toggle('on', this.heat);
    if (this.heat) this.toast('탐색 열지도 — 빈 자리를 찾는 차가 오래 머문 통로일수록 붉다 (보이는 층)', 3.5);
  },
  setSpeed(s) { this.speed = s; for (const b of $$('[data-speed]')) b.classList.toggle('on', +b.dataset.speed === s); },
  togglePause() { this.paused = !this.paused; $('#bPause').textContent = this.paused ? '▶ 재생' : '⏸ 일시정지'; },

  /* ---------- UI ---------- */
  bindUI() {
    $('#bPause').onclick = () => this.togglePause();
    for (const b of $$('[data-speed]')) b.onclick = () => this.setSpeed(+b.dataset.speed);
    for (const b of $$('[data-mode]')) b.onclick = () => { if (this.tour) this.toggleTour(); this.setMode(b.dataset.mode); };
    $('#bTour').onclick = () => this.toggleTour();
    $('#bUp').onclick = () => this.setCut(this.cut + 1);
    $('#bHeat').onclick = () => this.toggleHeat();
    $('#bNight').onclick = () => this.toggleNight();
    $('#bInc').onclick = () => this.incident();
    $('#bDn').onclick = () => this.setCut(this.cut - 1);
    $('#bSet').onclick = () => this.panel(true);
    $('#bCsv').onclick = () => this.download();
    $('#bPv').onclick = () => this.preview();
    $('#bIn').onclick = () => { const n = +$('#nBatch').value; this.sim.addArrivals(n); this.toast(`${n}대가 앞 도로로 옵니다`, 2); };
    $('#bOut').onclick = () => { const n = +$('#nBatch').value; const k = this.sim.addDepartures(n); this.toast(k ? `${k}대가 출차를 시작합니다 (통로가 비면 빠져나옵니다)` : '세워 둔 차가 없습니다', 2.5); };
    $('#bClose').onclick = () => this.panel(false);
    $('#bApply').onclick = () => { this.readPanel(true); this.panel(false); this.rebuild(); };
    for (const b of $$('[data-preset]')) b.onclick = () => {
      const p = PPRESETS[b.dataset.preset];
      Object.assign(this.cfg, { kind: 'ramp', pattern: 'flat' }, p); delete this.cfg.label;
      this.fillPanel(); this.readPanel(true); this.panel(false); this.rebuild();
    };
    // 수요 · 운영 값은 다시 짓지 않고 바로 반영
    for (const id of ['inRate', 'outRate', 'thruRate', 'revShare', 'balk']) {
      const el = $('#c_' + id);
      el.addEventListener('input', () => { this.readPanel(false); this.live(); });
    }
    for (const id of ['guide', 'gate', 'pattern']) $('#c_' + id).addEventListener('change', () => { this.readPanel(false); this.live(); });
    $('#c_kind').addEventListener('change', () => { this.est(); this.dimFields(); });
    for (const id of ['#c_gate', '#c_lanes']) $(id).addEventListener('change', () => this.demWarn());
    for (const el of $$('#panel input[type=range]')) el.addEventListener('input', () => this.readPanel(false));
    this.setSpeed(1);
  },
  live() {
    const s = this.sim, c = this.cfg;
    s.cfg = c;
    s.tIn = s.time + s.nextExp(c.inRate); s.tOut = s.time + s.nextExp(c.outRate);
    s.tThru = s.time + s.nextExp(c.thruRate); s.tThruE = s.time + s.nextExp(c.thruRate);
    this.save();
  },
  save() { try { localStorage.setItem('parkcfg', JSON.stringify(this.cfg)); } catch (e) { /* 무시 */ } },
  panel(on) { $('#panel').classList.toggle('on', on); if (on) { this.fillPanel(); this.analysis(); } },
  /** 미리 돌려 보기 — 설정 몇 벌을 화면 밖에서 1 시간씩 돌려 표로 견준다 (화면이 멈추지 않게 조금씩) */
  preview() {
    if (this.pv) { this.pv = false; $('#bPv').textContent = '비교 실행'; $('#pvMsg').textContent = '멈췄습니다'; return; }   // 돌리는 중에 다시 누르면 멈춘다
    const base = Object.assign({}, this.cfg), mech = base.kind === 'mech';
    const V = [['지금 설정', {}]];
    if (mech) {
      const nT = (W) => Math.max(1, Math.floor((Math.max(12, W) - 7.2) / MK.space) + 1), n = nT(base.W);
      V.push([`탑 ${n + 1}기 (1기 더)`, { W: base.W + MK.space }]);
      if (n > 1) V.push([`탑 ${n - 1}기 (1기 덜)`, { W: base.W - MK.space }]);
    } else {
      V.push([base.guide ? '유도 끔' : '유도 켬', { guide: !base.guide }]);
      V.push([base.gate === 'lpr' ? '주차권 · 출구 정산' : '번호판 인식', { gate: base.gate === 'lpr' ? 'ticket' : 'lpr' }]);
      V.push([(base.lanes | 0) >= 2 ? '차단기 1차로' : '차단기 2차로', { lanes: (base.lanes | 0) >= 2 ? 1 : 2 }]);
      V.push([(base.throat | 0) > 0 ? '진입 완충 없음' : '진입 완충 25 m', { throat: (base.throat | 0) > 0 ? 0 : 25 }]);
    }
    const rows = [], DUR = 3600, run = this.pvRun = (this.pvRun || 0) + 1;   // 멈추고 곧바로 다시 눌러도 옛 계산이 끼어들지 않게
    let vi = -1, sim = null, t = 0, qMax = 0;
    const next = () => {
      vi++;
      if (vi >= V.length) { this.pv = false; $('#bPv').textContent = '비교 실행'; $('#pvMsg').textContent = '끝 — 같은 시드 · 처음부터 1 시간'; return; }
      const c = Object.assign({}, base, V[vi][1]);
      const G = mech ? buildMech(c) : buildGarage(c);
      sim = mech ? new MechSim(G, c) : new ParkSim(G, c);
      t = 0; qMax = 0;
    };
    const q = (a, f) => { if (!a.length) return '—'; const b = a.slice().sort((x, y) => x - y); return mmss(b[Math.min(b.length - 1, Math.floor(b.length * f))]); };
    const draw = () => {
      let h = '<tr style="color:#8d96a8"><th style="text-align:left">설정</th><th>입차</th><th>출차</th><th>주차 소요 중앙 · 90%</th><th>출차 소요 중앙 · 90%</th><th>입구 대기 최대</th><th>지나감 · 포기</th></tr>';
      // 열마다 가장 나은 값은 굵게 (두 줄 넘게 끝났을 때)
      const best = {};
      if (rows.length > 1) for (const c of ['inN', 'outN', 'park', 'exit', 'qMax', 'lost']) best[c] = Math.min(...rows.map((r) => r.k[c]));
      const td = (r, c, txt) => `<td style="text-align:right${rows.length > 1 && r.k[c] === best[c] ? ';font-weight:700;color:#fff' : ''}">${txt}</td>`;
      for (const r of rows) h += `<tr${r.base ? ' style="color:#7fe0a8"' : ''}><td>${r.name}</td>${td(r, 'inN', r.inN)}${td(r, 'outN', r.outN)}${td(r, 'park', r.park)}${td(r, 'exit', r.exit)}${td(r, 'qMax', r.qMax + ' 대')}${td(r, 'lost', r.lost + ' · ' + r.gaveUp)}</tr>`;
      $('#pvTable').innerHTML = h;
    };
    const work = () => {
      if (!this.pv || this.pvRun !== run) return;
      const t0 = performance.now();
      while (performance.now() - t0 < 45 && t < DUR) {
        sim.step(1); t++;
        if (t % 10 === 0) qMax = Math.max(qMax, sim.summary().qIn);
      }
      $('#pvMsg').textContent = `계산 중 — ${vi + 1}/${V.length} · ${Math.round(t / DUR * 100)}%`;
      if (t >= DUR) {
        const st = sim.st;
        const med = (a) => { if (!a.length) return Infinity; const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
        rows.push({ name: V[vi][0], base: vi === 0, inN: st.inN, outN: st.outN, park: q(st.search, 0.5) + ' · ' + q(st.search, 0.9), exit: q(st.exitT, 0.5) + ' · ' + q(st.exitT, 0.9), qMax, lost: st.lost, gaveUp: st.gaveUp,
          k: { inN: -st.inN, outN: -st.outN, park: med(st.search), exit: med(st.exitT), qMax, lost: st.lost + st.gaveUp } });
        draw(); next();
      }
      if (this.pv && this.pvRun === run) setTimeout(work, 0);
    };
    this.pv = true; $('#bPv').textContent = '멈춤'; rows.length = 0; draw();
    next(); work();
  },

  /** 기록 내려받기 — 시계열과 차마다의 기록을 CSV 두 묶음으로 (엑셀이 한글을 읽게 BOM) */
  download() {
    const st = this.sim.st, q = (x) => (typeof x === 'number' ? (Math.round(x * 100) / 100) : '"' + String(x).replace(/"/g, '""') + '"');
    const lines = ['# 시계열 (10 초 간격)', 'sim_s,hour,occupied,total,searching,maneuvering,queue_in,queue_out,entered,exited,passed_by'];
    for (const r of st.hist2 || []) lines.push([r.t, r.h, r.occ, r.total, r.hunt, r.man, r.qIn, r.qOut, r.inN, r.outN, r.lost].map(q).join(','));
    lines.push('', '# 차마다의 기록 (주차 · 입고 = 차단기/문 앞부터 주차까지, 출차 · 출고 = 호출부터 출구까지)', 'sim_s,event,car_id,class,duration_s,level,stall_type,search_distance_m');
    for (const r of st.log || []) lines.push([r.t, r.kind, r.id, r.cls, r.dur, r.level, r.type, r.cruise].map(q).join(','));
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `parking-${this.G.mech ? 'mech' : 'ramp'}-${Math.round(this.sim.time)}s.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  /** 분석 칸 — 소요 시간 분포(분 단위 막대)와 층별 표 */
  analysis() {
    const hist = (id, lab, arr) => {
      const cv = $(id), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
      ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#0d1118'; ctx.fillRect(0, 0, W, H);
      const a = arr.slice().sort((x, y) => x - y);
      if (!a.length) { $(lab).textContent = '기록 없음'; ctx.fillStyle = '#69728a'; ctx.font = '22px system-ui'; ctx.fillText('아직 기록이 없습니다', 20, H / 2); return; }
      const q = (f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
      $(lab).textContent = `${a.length}대 · 중앙 ${mmss(q(0.5))} · 90% ${mmss(q(0.9))}`;
      const bw = 30, nb = Math.max(4, Math.min(20, Math.ceil(q(0.98) / bw) + 1));      // 30 초 칸
      const c = new Array(nb).fill(0);
      for (const x of a) c[Math.min(nb - 1, Math.floor(x / bw))]++;
      const mx = Math.max(...c), pw = (W - 40) / nb;
      ctx.font = '18px system-ui'; ctx.textAlign = 'center';
      c.forEach((n, i) => {
        const h = (H - 40) * n / mx;
        ctx.fillStyle = '#5fc48f'; ctx.fillRect(30 + i * pw + 2, H - 28 - h, pw - 4, h);
        if (i % 2 === 0) { ctx.fillStyle = '#8d96a8'; ctx.fillText(mmss(i * bw), 30 + i * pw + 2, H - 6); }
      });
      const xm = 30 + q(0.5) / bw * pw;
      ctx.strokeStyle = '#e0a63a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(xm, 6); ctx.lineTo(xm, H - 28); ctx.stroke();
    };
    const st = this.sim.st;
    hist('#hSearch', '#aSearch', st.search);
    if (st.cruise && st.cruise.length && !this.G.mech) {
      const c = st.cruise.slice().sort((a, b) => a - b);
      $('#aSearch').textContent += ` · 주차까지 주행 중앙 ${Math.round(c[c.length >> 1])} m`;
    }
    hist('#hExit', '#aExit', st.exitT);
    const S = this.sim.summary(), G = this.G;
    let h = '<tr style="color:#8d96a8"><th style="text-align:left">층</th><th>면</th><th>점유</th><th>점유율</th><th>지금 찾는 차</th></tr>';
    const hunt = G.levels.map(() => 0);
    for (const v of this.sim.cars) if (v.inside && v.searching && v.edge && v.edge.level >= 0) hunt[v.edge.level]++;
    for (let i = G.NL - 1; i >= 0; i--) {
      const p = S.per[i];
      h += `<tr><td>${G.levels[i].name}</td><td style="text-align:right">${p.n}</td><td style="text-align:right">${p.occ}</td><td style="text-align:right">${p.n ? Math.round(p.occ / p.n * 100) + '%' : '—'}</td><td style="text-align:right">${hunt[i]}</td></tr>`;
    }
    $('#lvTable').innerHTML = h;
  },
  fields: {
    W: [(v) => v + ' m'], D: [(v) => v + ' m'], U: [(v) => $('#c_kind').value === 'mech' ? Math.max(1, v) + ' 단' : v === 0 ? '없음 (지면 광장)' : v + '개 층'], B: [(v) => v === 0 ? '없음' : v + ($('#c_kind').value === 'mech' ? ' 단' : '개 층')],
    inRate: [(v) => v + ' 대/시'], outRate: [(v) => v + ' 대/시'], thruRate: [(v) => v + ' 대/시'],
    initOcc: [(v) => Math.round(v * 100) + ' %'], revShare: [(v) => Math.round(v * 100) + ' %'], balk: [(v) => v + ' 대'], seed: [(v) => '' + v], throat: [(v) => v === 0 ? '없음' : v + ' m'],
  },
  fillPanel() {
    const c = this.cfg;
    for (const k in this.fields) {
      const el = $('#c_' + k); if (!el) continue;
      el.value = c[k];
      const o = $('#v_' + k); if (o) o.textContent = this.fields[k][0](+c[k]);
    }
    $('#c_guide').checked = !!c.guide;
    $('#c_gate').value = c.gate;
    $('#c_pattern').value = c.pattern || 'flat';
    $('#c_lanes').value = String(c.lanes || 1);
    $('#c_kind').value = c.kind || 'ramp';
    this.dimFields();
    this.est();
  },
  readPanel(all) {
    const c = this.cfg;
    for (const k in this.fields) {
      const el = $('#c_' + k); if (!el) continue;
      const v = +el.value;
      if (all || !['W', 'D', 'U', 'B', 'initOcc', 'seed', 'throat'].includes(k)) c[k] = v;
      const o = $('#v_' + k); if (o) o.textContent = this.fields[k][0](v);
    }
    c.guide = $('#c_guide').checked; c.gate = $('#c_gate').value; c.pattern = $('#c_pattern').value;
    if (all) { c.lanes = +$('#c_lanes').value; c.kind = $('#c_kind').value; }
    this.est();
    this.save();
  },
  /** 기계식에서 쓰지 않는 칸은 흐리게 */
  dimFields() {
    const mech = $('#c_kind').value === 'mech';
    for (const id of ['c_D', 'c_lanes', 'c_guide', 'c_gate', 'c_revShare', 'c_throat']) {
      const f = $('#' + id) && $('#' + id).closest('.fld');
      if (f) { f.style.opacity = mech ? 0.4 : 1; f.title = mech ? '기계식에서는 쓰지 않는다' : ''; }
    }
    // 규모 칸의 이름 · 설명도 형식에 맞춘다
    $('#c_kind').closest('.fld').querySelector('.hint').textContent = mech
      ? '기계식은 가로 9.4 m 마다 탑 1기, 지상 층수 = 칸 단수(층마다 좌우 2칸), 지하 = 피트 단수. 세로는 쓰지 않는다.'
      : '자주식은 서쪽 칸에 오르내리는 경사로, 층마다 일방통행 순환로와 직각주차 통로를 둔다.';
    const H = {
      W: ['가로 (동서)', mech ? '탑 1 기가 9.4 m — 가로가 길수록 탑이 늘어 승강기가 많아진다.' : '서쪽 7.6 m 는 경사로 칸. 통로 하나가 양쪽 주차열과 함께 16 m 를 쓴다.'],
      U: [mech ? '칸 단수 (지상)' : '지상 층수', mech ? '1 층은 입출고실 · 대기 로비, 그 위로 단마다 좌우 2 칸.' : '1층이 입구층. 0 이면 지면은 광장이고 주차는 지하에만.'],
      B: [mech ? '피트 단수 (지하)' : '지하 층수', mech ? '승강기가 지하로도 내려가 칸을 더 둔다.' : '층고 3.2 m, 지하층은 옹벽으로 둘러싸인다.'],
    };
    for (const k in H) {
      const f = $('#c_' + k).closest('.fld'), lab = f.querySelector('label'), val = $('#v_' + k);
      lab.firstChild.textContent = H[k][0] + ' ';
      f.querySelector('.hint').textContent = H[k][1];
      if (val) val.textContent = this.fields[k][0](+$('#c_' + k).value);
    }
  },
  /** 수요가 처리량을 넘으면 미리 알린다 — 처리량은 이 모형에서 잰 값 (README 의 측정) */
  demWarn() {
    const v = (id) => +$('#' + id).value;
    const inR = v('c_inRate'), outR = v('c_outRate'), mech = $('#c_kind').value === 'mech';
    const W = [];
    if (mech) {
      const nT = Math.max(1, Math.floor((Math.max(12, v('c_W')) - 7.2) / MK.space) + 1), U = Math.max(1, v('c_U'));
      const avgZ = MK.ground + MK.pitch * (U - 1) / 2;
      const per = Math.round(3600 / (40 + 1.25 * avgZ)), cap = per * nT;          // 탑 하나가 한 시간에 넣고 빼는 대수 (잰 값에 맞춘 근사)
      if (inR + outR > cap * 0.85) W.push(`입고 + 출고 ${inR + outR}대/시가 승강기 처리량(탑 ${nT}기 × 약 ${per}대/시 = ${cap}대/시)에 ${inR + outR > cap ? '넘칩니다' : '가깝습니다'} — 진입로 대기와 출고 대기가 길어지고, 줄이 넘치면 지나가는 차가 생깁니다. 가로를 늘려 탑을 더하면 줄어듭니다.`);
    } else {
      const lpr = $('#c_gate').value === 'lpr', two = +$('#c_lanes').value >= 2;
      const exitCap = lpr ? (two ? 420 : 400) : (two ? 195 : 165);
      if (outR > exitCap * 0.9) W.push(`나가는 차 ${outR}대/시가 출구 처리량(${lpr ? '번호판 인식' : '주차권 정산'} · 차단기 ${two ? 2 : 1}차로 약 ${exitCap}대/시)에 ${outR > exitCap ? '넘칩니다' : '가깝습니다'} — 출구 대기열이 안쪽 통로로 번져 들어오는 차까지 막습니다.${lpr ? '' : ' 번호판 인식으로 바꾸면 두 배 남짓이 됩니다.'}`);
      if (inR > 300) W.push(`들어오는 차 ${inR}대/시 — 입구 바로 뒤 통로에서 주차하는 차가 길을 막아, 이 모형에서는 시간당 210~320대쯤에서 진입로에 줄이 섭니다. 병목이 차단기가 아니라 입구 뒤 통로라 차단기를 두 차로로 늘려도 거의 그대로이고, 진입 완충을 25 m 두면 늘어납니다(64×52 에서 329 → 411 대/시, 면은 9 % 줄어든다).`);
    }
    const el = $('#demWarn');
    el.innerHTML = W.map((w) => '⚠ ' + w).join('<br>');
    el.classList.toggle('on', W.length > 0);
  },
  /** 설정 창의 규모 미리 셈 — 짓기 전에 면 수를 알려 준다 */
  est() {
    this.demWarn();
    const W = +$('#c_W').value, D = +$('#c_D').value, U = +$('#c_U').value, B = +$('#c_B').value;
    try {
      if ($('#c_kind').value === 'mech') {
        const g = buildMech({ W, D, U: Math.max(1, U), B, seed: 1 });
        $('#estOut').textContent = `기계식 주차타워 ${g.towers.length}기 (가로 ${fmt1(g.W)} m) · 탑마다 ${g.NL}단 × 2칸 · 총 ${g.stalls.length}면 · 높이 약 ${fmt1(g.levels[g.NL - 1].z + MK.pitch + 0.7)} m — 세로는 쓰지 않는다`;
        return;
      }
      const g = buildGarage({ W, D, U, B, seed: 1, throat: +$('#c_throat').value });
      $('#estOut').textContent = `${g.levels[0].name}~${g.levels[g.NL - 1].name} (${g.NL}개 층) · 주차면 ${g.stalls.length}면 · 층당 약 ${Math.round(g.stalls.length / Math.max(1, g.levels.filter((l) => l.park).length))}면 · 경사로 ${fmt1(g.Lr)} m, 최대 경사 ${fmt1(g.grade * 100)} %`;
    } catch (e) { $('#estOut').textContent = '배치 불가: ' + e.message; }
  },

  hud() {
    const S = this.sim.summary(), G = this.G;
    this.lastS = S;
    // 층별 점유
    let h = '';
    for (let i = G.NL - 1; i >= 0; i--) {
      const L = G.levels[i], p = S.per[i];
      const f = p.n ? p.occ / p.n : 0;
      const col = f > 0.95 ? '#e2574c' : f > 0.8 ? '#e0a63a' : '#5fc48f';
      h += `<div class="lv${i === this.cut ? ' cur' : ''}" data-lv="${i}"><b>${L.name}</b><span class="bar"><i style="width:${(f * 100).toFixed(1)}%;background:${col}"></i></span><em>${p.n ? p.n - p.occ + ' 빈' : '광장'}</em></div>`;
    }
    $('#lvList').innerHTML = h;
    for (const el of $$('#lvList .lv')) el.onclick = () => this.setCut(+el.dataset.lv);
    $('#occAll').textContent = `${S.occ} / ${S.total}`;
    $('#occPct').textContent = Math.round(S.occ / Math.max(1, S.total) * 100) + '%';
    const full = S.free <= S.hunting;
    $('#fullSign').className = full ? 'full on' : 'full';
    $('#fullSign').textContent = full ? '만 차' : '빈 자리 ' + Math.max(0, S.free - S.hunting);
    const st = (id, v) => { $(id).textContent = v; };
    if (this.G.mech) {
      st('#kHunt', '가동 중인 승강기'); st('#kMan', '승강기 · 입고실의 차'); st('#kQin', '입고 대기 (진입로 · 도로)');
      st('#kQout', '출고 호출 대기'); st('#kSearch', '평균 입고 소요 (문 앞→칸)');
      st('#sHunt', this.G.towers.filter((T) => T.state !== 'idle').length + ' / ' + this.G.towers.length + ' 기');
    } else {
      st('#kHunt', '빈 자리 찾는 차'); st('#kMan', '주차 · 출차 조작 중'); st('#kQin', '입구 대기');
      st('#kQout', '출차 대기'); st('#kSearch', '평균 주차 소요 (차단기→주차)');
    }
    if (!this.G.mech) st('#sHunt', S.hunting + ' 대');
    st('#sMan', S.man + ' 대');
    st('#sQin', S.qIn + ' 대' + (S.coming ? ` (+${S.coming} 오는 중)` : ''));
    st('#sQout', (S.qOut + S.wantOut) + ' 대');
    st('#sSearch', S.searchAvg ? mmss(S.searchAvg) : '—');
    st('#sExit', S.exitAvg ? mmss(S.exitAvg) : '—');
    st('#sQueue', S.queueAvg ? mmss(S.queueAvg) : '—');
    st('#sIO', `${S.inN} / ${S.outN}`);
    st('#sLost', `${S.lost} / ${S.gaveUp}` + (S.unjam ? ` · 교착 ${S.unjam}` : ''));
    // 최근 기록 — 주차 · 출차가 끝날 때마다 한 줄 (누르면 그 차를 고른다)
    const L = this.sim.st.log || [];
    if (L.length !== this.logN || this.sim !== this.logSim) {
      this.logN = L.length; this.logSim = this.sim;
      const pat = this.cfg.pattern && this.cfg.pattern !== 'flat';
      const when = (t) => { if (!pat) return mmss(t); const h = this.sim.hour() - (this.sim.time - t) / 3600; return pad2(Math.floor(h)) + ':' + pad2(Math.floor((h % 1) * 60)); };
      const col = { 주차: '#7fe0a8', 입고: '#7fe0a8', 출차: '#ffd59f', 출고: '#ffd59f' };
      $('#evLog').innerHTML = L.slice(-4).reverse().map((e) =>
        `<div data-id="${e.id}"><span class="t">${when(e.t)}</span><span style="color:${col[e.kind]}">${e.kind}</span><span>${e.cls} #${e.id}${e.level ? ' · ' + e.level : ''}</span><span class="d">${mmss(e.dur)}</span></div>`).join('') ||
        '<div style="color:#69728a;cursor:default">주차 · 출차가 끝나면 여기 쌓입니다</div>';
      for (const el of $$('#evLog [data-id]')) el.onclick = () => {
        const v = this.sim.cars.find((c) => c.id === +el.dataset.id);
        if (v && v.mode !== 'done') { this.sel = v; if (this.mode === 'orbit' || this.mode === 'top') this.retarget(); } else this.toast('그 차는 이미 나갔습니다', 2);
      };
    }
    const fb = $('#flowBox');
    $('#selBox').style.top = fb.offsetHeight ? (fb.offsetTop + fb.offsetHeight + 10) + 'px' : '';
    const pat = this.cfg.pattern && this.cfg.pattern !== 'flat';
    if (pat) { const h = this.sim.hour(); st('#clock', `${pad2(Math.floor(h))}:${pad2(Math.floor((h % 1) * 60))}` + (this.speed > 1 ? ` · ×${this.speed}` : '')); }
    else st('#clock', mmss(this.sim.time) + (this.speed > 1 ? ` · ×${this.speed}` : ''));
    // 하루 패턴이면 해 질 무렵 · 새벽에 저절로 주야를 바꾼다
    if (pat) { const h = this.sim.hour(), dark = h >= 19.3 || h < 6.2; if (dark !== !!this.night) this.toggleNight(); }
    st('#perf', `${(this.drawMs || 0).toFixed(1)} ms · 계산 ${(this.simMs || 0).toFixed(1)} ms · ${this.sim.cars.length} 대`);
    // 선택한 차
    const v = this.sel, box = $('#selBox');
    if (v && v.pts) {
      box.style.display = 'block';
      const mech = !!G.towers, at = v.k >= v.pts.length - 1;
      const pst = v.delay > 0 ? '차에서 내리는 중' : v.hold ? (at ? '로비에서 차를 기다리는 중' : '로비로 걸어가는 중') : v.toCar ? '차로 걸어가는 중' : mech ? '밖으로 걸어 나가는 중' : '계단실로 걸어가는 중';
      box.innerHTML = `<h3>운전자${v.car ? ' (' + v.car.cls.name + ' #' + v.car.id + ')' : ''}</h3><div class="row"><span class="k">상태</span><span class="v">${pst}</span></div>` +
        `<div class="row"><span class="k">층</span><span class="v">${this.lvName(v.z)}</span></div>` +
        `<div class="row"><span class="k">걷는 속도</span><span class="v">${fmt1(v.sp * 3.6)} km/h</span></div><div class="hint">${v.toCar ? '차에 타면 그 차를 따라갑니다' : mech ? '차가 내려와 돌면 걸어가 탑니다' : '계단실에 닿으면 차 위로 돌아갑니다'}</div>`;
    } else if (v && v.mode !== 'done') {
      box.style.display = 'block';
      const T = v.stall && v.stall.tower, qi = T ? T.q.indexOf(v) : -1;
      const what = v.mode === 'parked' ? (v.leaving ? (qi >= 0 ? (qi === 0 && T.carOn !== v ? '출고 차례 — 승강기를 기다림' : `출고 대기 — 앞에 ${qi}대`) : T ? '운전자가 로비로 오는 중' : v.driverAway ? '운전자가 차로 오는 중' : '출차 대기 (통로가 빌 때까지)') : '주차 중') :
        v.mode === 'mech' ? (MECH_STATE[T && T.state] || (v.leaving ? '출고 중' : '입고 중')) :
        v.mode === 'man' ? ({ revIn: '후면주차 중 (후진)', fwdIn: '전면주차 중', outFwd: '출차 — 앞으로 빠짐', outRev: '출차 — 후진으로 빠짐' }[v.man.kind]) :
          v.role === 'thru' ? '통과 차량' : v.done ? '나가는 중' : !v.inside ? (v.balk ? '대기열이 길어 지나감' : '입구로') :
            v.broken ? '고장 — 비상등 켜고 서 있음' : v.leaving ? '출구로' : v.giveUp ? '못 찾고 나감' : v.plan ? (v.plan.how === 'rev' ? '후면주차 준비' : '전면주차 준비') :
              v.waitFor ? '나가는 차를 기다림' : v.stall ? (v.guided ? '배정된 면으로' : '고른 면으로') : '빈 자리 찾는 중';
      const lv = this.lvName(v.z);
      const tIn = v.tGate ? this.sim.time - v.tGate : 0;
      box.innerHTML = `<h3>${v.cls.name} #${v.id}</h3><div class="row"><span class="k">상태</span><span class="v">${what}</span></div>` +
        `<div class="row"><span class="k">층</span><span class="v">${lv}</span></div>` +
        `<div class="row"><span class="k">속도</span><span class="v">${fmt1(v.v * 3.6)} km/h</span></div>` +
        (v.mode !== 'parked' && v.inside && v.tGate ? `<div class="row"><span class="k">입차 후</span><span class="v">${mmss(tIn)}</span></div>` : '') +
        (v.mode === 'parked' ? `<div class="row"><span class="k">주차 시간</span><span class="v">${mmss(Math.max(0, this.sim.time - v.tPark))}</span></div>` : '') +
        `<div class="hint">F: 다른 차 따라가기 · Esc: 선택 해제</div>`;
    } else box.style.display = 'none';
    this.chart();
  },
  chart() {
    const cv = $('#chart'), ctx = cv.getContext('2d'), h = this.sim.st.hist;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1118'; ctx.fillRect(0, 0, W, H);
    if (h.length < 2) return;
    const tot = this.sim.G.stalls.length || 1;
    const n = h.length, x = (i) => (i / (n - 1)) * (W - 4) + 2;
    const line = (f, col, max) => {
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath();
      h.forEach((p, i) => { const y = H - 3 - clamp(f(p) / max, 0, 1) * (H - 8); if (i) ctx.lineTo(x(i), y); else ctx.moveTo(x(i), y); });
      ctx.stroke();
    };
    let mx = 4; for (const p of h) mx = Math.max(mx, p.hunt, p.qIn);
    line((p) => p.occ / tot, '#5fc48f', 1);
    line((p) => p.hunt, '#e0a63a', mx);
    line((p) => p.qIn, '#e2574c', mx);
  },
  overlay() {
    const ctx = this.ctx, G = this.G;
    // 층 이름표 — 경사로 칸 바깥 벽에
    ctx.font = `600 ${Math.round(12 * this.H / 900 + 6)}px system-ui,sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (this.mode !== 'follow' && this.mode !== 'driver' && G.mech) {
      for (const T of G.towers) {
        const q = Render.point(T.x, -0.4, MK.ground + 0.6);
        if (!q) continue;
        const nin = T.lin.cars.filter((c) => c !== T.carOn).length;
        const doing = T.state === 'idle' ? '' : ['fetch', 'pull', 'lower', 'turn', 'board', 'out', 'clear'].includes(T.state) ? ' ▼출고' : ' ▲입고';
        const t = `${T.idx + 1}호기${doing}` + (nin ? ` · 입고 대기 ${nin}` : '') + (T.q.length ? ` · 출고 대기 ${T.q.length}` : '');
        const w = ctx.measureText(t).width + 10;
        ctx.fillStyle = '#10141bcc'; ctx.fillRect(q.x - w / 2, q.y - 9, w, 18);
        ctx.fillStyle = T.state === 'idle' ? '#7fe0a8' : '#ffd59f'; ctx.fillText(t, q.x, q.y);
      }
    } else if (this.mode !== 'follow' && this.mode !== 'driver') {
      {
        const L = G.levels[this.cut];
        const q = Render.point(PK.RW / 2, G.D - 1.2, L.z + 2.0);
        if (q) {
          ctx.font = `700 ${Math.round(16 * this.H / 900 + 8)}px system-ui,sans-serif`;
          const w = ctx.measureText(L.name).width + 16;
          ctx.fillStyle = '#10141bcc'; ctx.fillRect(q.x - w / 2, q.y - 14, w, 28);
          ctx.fillStyle = '#ffffff'; ctx.fillText(L.name, q.x, q.y);
          ctx.font = `600 ${Math.round(12 * this.H / 900 + 6)}px system-ui,sans-serif`;
        }
      }
      // 경사로 방향 — 이 층에서 오르는 곳 · 내려가는 곳
      {
        const i = this.cut, L = G.levels[i];
        // 두 경사로는 3.7 m 떨어져 있어 이름표가 겹친다 — 한 장에 나란히
        const parts = [];
        if (i < G.NL - 1) parts.push(['▲ ' + G.levels[i + 1].name, '#9fd8ff']);
        if (i > 0) parts.push(['▼ ' + G.levels[i - 1].name, '#ffd59f']);
        const q = parts.length && Render.point(PK.RW / 2, G.y_rt - 3, L.z + 1.8);
        if (q) {
          const ws = parts.map(([t]) => ctx.measureText(t).width), gap = 10;
          const tw = ws.reduce((a, b) => a + b, 0) + gap * (parts.length - 1) + 12;
          ctx.fillStyle = '#10141bcc'; ctx.fillRect(q.x - tw / 2, q.y - 9, tw, 18);
          let x = q.x - tw / 2 + 6;
          ctx.textAlign = 'left';
          parts.forEach(([t, col], k) => { ctx.fillStyle = col; ctx.fillText(t, x, q.y); x += ws[k] + gap; });
          ctx.textAlign = 'center';
        }
      }
      // 입구 · 출구
      // 입구 안내판 — 빈 자리 수 (찾는 차 몫은 뺀다) · 만차
      const S = this.lastS || this.sim.summary(), freeN = Math.max(0, S.free - S.hunting);
      for (const [ed, t] of [[G.gated.find((e) => e.kind === 'entry'), freeN ? `입구 · 빈 자리 ${freeN}` : '입구 · 만차'], [G.gated.find((e) => e.kind === 'exit'), '출구']]) {
        const q0 = ed.at(ed.gate.s - 6), q = Render.point(q0.x, q0.y, 2.6);
        if (!q) continue;
        ctx.fillStyle = '#10141bcc'; const w = ctx.measureText(t).width + 12;
        ctx.fillRect(q.x - w / 2, q.y - 10, w, 20);
        ctx.fillStyle = t === '출구' ? '#ffc07a' : freeN ? '#7fe0a8' : '#ff6b5e'; ctx.fillText(t, q.x, q.y);
      }
      // 진입 완충 — 면을 뺀 자리가 빠진 것처럼 보이지 않게 (그 층이 맨 위로 보일 때만)
      const th = +G.cfg.throat || 0, en = G.entryEnd;
      if (th > 0 && en && en.level === this.cut) {
        const q = Render.point(en.x, en.y + 3, en.z + 0.4), t = `진입 완충 ${th} m — 주차면 없음`;
        if (q) { const w = ctx.measureText(t).width + 12; ctx.fillStyle = '#10141bcc'; ctx.fillRect(q.x - w / 2, q.y - 10, w, 20); ctx.fillStyle = '#ffd59f'; ctx.fillText(t, q.x, q.y); }
      }
    }
    // 비네트
    const W = this.W, H = this.H;
    const vg = ctx.createRadialGradient(W / 2, H * 0.52, H * 0.5, W / 2, H * 0.52, H * 1.05);
    vg.addColorStop(0, '#00000000'); vg.addColorStop(1, '#00000030');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  },
  toast(msg, sec) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.remove('on'), (sec || 2.5) * 1000);
  },
};

addEventListener('load', () => PApp.init());
