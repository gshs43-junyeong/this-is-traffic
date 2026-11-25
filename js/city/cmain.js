/* =============================================================================
   cmain.js — 도시 교통 시뮬레이터 앱 (입력 · 카메라 · HUD · 설정)
   ========================================================================== */
'use strict';

const CCFG_DEFAULT = { NX: 4, NY: 4, B: 140, lanes: 2, cycle: 100, phase: 'lead', coord: false, demand: 2000, inner: 0.4, seed: 1 };
const CPRESETS = {
  base: {},
  wave: { coord: true, demand: 2200, label: '녹색 물결' },
  rush: { demand: 4000, inner: 0.25, label: '출퇴근 혼잡' },
  big: { NX: 7, NY: 7, B: 130, demand: 4200, label: '넓은 도시' },
  narrow: { lanes: 1, demand: 900, cycle: 80, label: '좁은 길' },
  avenue: { lanes: 3, B: 220, NX: 4, NY: 3, cycle: 120, demand: 2200, label: '대로' },
};
const PHASE_NAME = {
  lead: ['남북 직진', '남북 좌회전', '동서 직진', '동서 좌회전'],
  approach: ['북쪽 진입', '동쪽 진입', '남쪽 진입', '서쪽 진입'],
};
const SIDE_KO = { N: '북', E: '동', S: '남', W: '서' };
const MV_KO = { L: '좌회전', S: '직진', R: '우회전' };

const CApp = {
  cfg: Object.assign({}, CCFG_DEFAULT),
  paused: false, speed: 1, mode: 'orbit', flow: false, night: false,
  cam: { yaw: 0.9, pitch: -0.72, dist: 400, tx: 0, ty: 0, tz: 0 },
  sel: null, selI: null,

  init() {
    try { const s = JSON.parse(localStorage.getItem('citycfg') || 'null'); if (s) Object.assign(this.cfg, s); } catch (e) { /* 저장소가 막혀도 기본값으로 돈다 */ }
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
    addEventListener('resize', () => this.resize());
    this.resize();
    this.rebuild();
    this.last = performance.now();
    try {
      if (!localStorage.getItem('cityHint')) {
        setTimeout(() => this.toast('교차로를 누르면 신호 현시 · 서비스 수준이, 차를 누르면 갈 길이 보입니다 · 설정(P)에서 도로망과 수요를 정합니다', 7), 4000);
        localStorage.setItem('cityHint', '1');
      }
    } catch (e) { /* 안내만 빠진다 */ }
    requestAnimationFrame((t) => this.loop(t));
  },

  rebuild() {
    const c = this.cfg;
    this.C = buildCity(c);
    this.sim = new CitySim(this.C, c);
    // 처음부터 빈 도시가 아니게 — 4 분을 미리 돌려 둔다
    const t0 = performance.now();
    while (this.sim.time < 240 && performance.now() - t0 < 1500) this.sim.step(2);
    CScene.init(this.C, this.sim, this.night);
    if (Render.gl) CScene.uploaded = false;
    this.sel = null; this.selI = null; this.mode = 'orbit';
    const C = this.C, asp = (this.cv.clientHeight || 1) / (this.cv.clientWidth || 1);
    this.cam.tx = C.W / 2; this.cam.ty = C.D / 2; this.cam.tz = 0;
    this.cam.dist = clamp((Math.hypot(C.W, C.D) * 0.95 + 160) * Math.max(1, asp * 0.95), 120, 1600);
    this.fillPanel();
    this.updBtns();
    this.toast(`교차로 ${C.NX}×${C.NY} · 블록 ${C.B} m · 왕복 ${C.n * 2}차로 · 시간당 ${fmt0(c.demand)}대`, 4);
    this.updMode();
  },

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    for (const cv of [this.cv, this.skyCv, this.glCv]) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    this.W = this.cv.width; this.H = this.cv.height;
  },

  loop(t) {
    const raw = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    if (!this.paused) {
      // 한 프레임 계산은 30 ms 까지 — 넘치면 배속을 덜 낸다 (화면이 멎지 않게)
      const t0 = performance.now();
      let left = raw * this.speed;
      while (left > 1e-6 && performance.now() - t0 < 30) { const h = Math.min(0.5, left); this.sim.step(h); left -= h; }
      this.lag = left > 1e-6;
      this.simMs = (this.simMs || 0) * 0.9 + (performance.now() - t0) * 0.1;
    }
    this.updateCam(raw);
    const t1 = performance.now();
    CScene.draw(this.ctx, this.W, this.H, this.camPose, {
      skyCtx: this.skyCtx, sel: this.sel, selI: this.selI, flow: this.flow,
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
    if (this.sel && this.sel.gone) {          // 따라가던 차가 도착했다 — 비슷한 곳의 다른 차로
      const g = this.sel; this.sel = null;
      if (this.mode === 'follow' || this.mode === 'driver') this.followNear(g.x, g.y);
      this.updMode();
    }
    const s = this.sel;
    if (this.mode === 'driver' && s) {
      const ch = Math.cos(s.h), sh = Math.sin(s.h), x = s.x + ch * s.len * 0.02 - sh * s.wid * 0.22, y = s.y + sh * s.len * 0.02 + ch * s.wid * 0.22;
      this.dYaw = this.dYaw == null ? s.h : this.dYaw + wrapPi(s.h - this.dYaw) * Math.min(1, dt * 10);
      this.camPose = { x, y, z: 1.12 * s.hei / 1.45, yaw: this.dYaw, pitch: -0.06 };
      return;
    }
    if (this.mode === 'follow' && s) {
      const k = 1 - Math.exp(-dt / 0.4);
      this.fYaw = this.fYaw == null ? s.h : this.fYaw + wrapPi(s.h - this.fYaw) * k;
      const x = s.x - Math.cos(this.fYaw) * 11, y = s.y - Math.sin(this.fYaw) * 11, z = 4.6;
      this.fPos = this.fPos ? this.fPos.map((p, i) => p + ([x, y, z][i] - p) * Math.min(1, k * 2)) : [x, y, z];
      const [px, py, pz] = this.fPos, dx = s.x - px, dy = s.y - py;
      this.camPose = { x: px, y: py, z: pz, yaw: Math.atan2(dy, dx), pitch: Math.atan2(1.2 - pz, Math.hypot(dx, dy)) };
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
    for (const v of this.sim.cars) { const d = Math.hypot(v.x - x, v.y - y) + (v.v < 1 ? 60 : 0); if (d < bd) { bd = d; best = v; } }
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
      const c = this.cam, k = c.dist / 650, C = this.C;
      c.tx += (-Math.sin(c.yaw) * dx + Math.cos(c.yaw) * dy) * k;
      c.ty += (Math.cos(c.yaw) * dx + Math.sin(c.yaw) * dy) * k;
      c.tx = clamp(c.tx, -300, C.W + 300); c.ty = clamp(c.ty, -300, C.D + 300);
    };
    cv.addEventListener('pointerdown', (e) => {
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
        if (q.d > 10 && pinch.d > 10) c.dist = clamp(c.dist * pinch.d / q.d, 15, 1800);
        pan(q.x - pinch.x, q.y - pinch.y);
        pinch = q;
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      const c = this.cam;
      if (this.mode === 'follow' || this.mode === 'driver') {
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) { this.toOrbitAtSel(); } else return;
      }
      if (drag.pan) pan(dx, dy);
      else {
        c.yaw -= dx * 0.006;
        if (this.mode === 'top') { this.mode = 'orbit'; this.updMode(); }
        c.pitch = clamp(c.pitch - dy * 0.005, -1.52, -0.06);
      }
    });
    cv.addEventListener('pointerup', (e) => {
      lift(e);
      if (drag && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5 && drag.b === 0) this.pick(e.clientX, e.clientY);
      drag = null;
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.mode === 'follow' || this.mode === 'driver') this.toOrbitAtSel();
      this.cam.dist = clamp(this.cam.dist * Math.exp(e.deltaY * 0.0012), 15, 1800);
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === ' ') { e.preventDefault(); this.togglePause(); }
      else if (k >= '1' && k <= '5') this.setSpeed([1, 2, 5, 10, 20][+k - 1]);
      else if (k === 't') this.setMode(this.mode === 'top' ? 'orbit' : 'top');
      else if (k === 'f') this.setMode('follow');
      else if (k === 'v') this.setMode(this.mode === 'driver' ? 'follow' : 'driver');
      else if (k === 'h') this.toggleFlow();
      else if (k === 'n') this.toggleNight();
      else if (k === 'g') this.togglePhase();
      else if (k === 'c') this.toggleCoord();
      else if (k === 'Escape') { if ($('#panel').classList.contains('on')) this.panel(false); else { this.sel = null; this.selI = null; this.setMode('orbit'); } }
      else if (k === 'p') this.panel(!$('#panel').classList.contains('on'));
    });
  },
  toOrbitAtSel() {
    const s = this.sel, c = this.cam;
    this.mode = 'orbit';
    if (s) { c.tx = s.x; c.ty = s.y; c.dist = Math.min(c.dist, 90); c.yaw = s.h; }
    this.updMode();
  },
  /** 화면 점 → 가장 가까운 차 (24 px 안), 없으면 땅 위 교차로 */
  pick(cx, cy) {
    const r = this.cv.getBoundingClientRect(), k = this.W / r.width, px = (cx - r.left) * k, py = (cy - r.top) * k;
    let best = null, bd = 24 * k;
    for (const v of this.sim.cars) {
      const q = Render.point(v.x, v.y, 0.8); if (!q) continue;
      const d = Math.hypot(q.x - px, q.y - py); if (d < bd) { bd = d; best = v; }
    }
    if (best) { this.sel = best; this.selI = null; this.updMode(); return; }
    // 땅(z = 0)과 시선의 교점
    const P = this.camPose, fx = Render.fx, fy = Render.fy, fz = Render.fz;
    const sx = (px - this.W / 2) / Render.focal, sy = -(py - this.H / 2) / Render.focal;
    const dx = fx + Render.rx * sx + Render.ux * sy, dy = fy + Render.ry * sx + Render.uy * sy, dz = fz + Render.rz * sx + Render.uz * sy;
    if (dz >= -1e-3) { this.sel = null; this.selI = null; return; }
    const tt = -P.z / dz, gx = P.x + dx * tt, gy = P.y + dy * tt;
    let bi = null, bdi = this.C.box + 8;
    for (const I of this.C.ints) { const d = Math.hypot(I.x - gx, I.y - gy); if (d < bdi) { bdi = d; bi = I; } }
    this.selI = bi; this.sel = null;
    if (this.mode !== 'top') this.mode = 'orbit';
    this.updMode();
  },
  setMode(m) {
    if ((m === 'follow' || m === 'driver') && !this.sel) {
      // 고른 차가 없으면 화면 가운데 근처에서 달리는 차를 고른다
      const c = this.cam; this.followNear(c.tx, c.ty);
      if (!this.sel) { this.toast('따라갈 차가 없습니다'); return; }
    }
    if (m === 'orbit' && (this.mode === 'follow' || this.mode === 'driver')) { this.toOrbitAtSel(); return; }
    this.mode = m;
    this.updMode();
  },
  updMode() { for (const b of $$('[data-mode]')) b.classList.toggle('on', b.dataset.mode === this.mode); },
  setSpeed(s) { this.speed = s; for (const b of $$('[data-speed]')) b.classList.toggle('on', +b.dataset.speed === s); },
  togglePause() { this.paused = !this.paused; $('#bPause').textContent = this.paused ? '▶ 계속' : '⏸ 일시정지'; $('#bPause').classList.toggle('on', this.paused); },
  toggleFlow() { this.flow = !this.flow; this.updBtns(); },
  toggleNight() {
    this.night = !this.night;
    PNIGHT = this.night;
    CScene.buildStatic(); CScene.uploaded = false;       // 바깥 색 · 창 불빛이 바뀐다
    this.updBtns();
  },
  /** 신호 방식 · 연동은 도로망은 두고 신호 계획만 바꾼다 (달리던 차는 그대로) */
  togglePhase() {
    this.cfg.phase = this.cfg.phase === 'lead' ? 'approach' : 'lead';
    this.resignal();
    this.toast(this.cfg.phase === 'lead' ? '신호: 직진 후 좌회전 (4 현시)' : '신호: 방향별 동시 (진입로마다 차례로)');
  },
  toggleCoord() {
    this.cfg.coord = !this.cfg.coord;
    this.resignal();
    this.toast(this.cfg.coord ? '녹색 물결 켬 — 동서 직진 녹색이 동쪽으로 45 km/h 로 번진다' : '연동 끔 — 교차로마다 신호 시작이 제각각');
  },
  resignal() {
    const sim = this.sim, cfg = this.cfg;
    sim.cfg = cfg; sim.retime();
    for (const I of this.C.ints) { I.dEma = 0; I.dSum = 0; I.dN = 0; }   // 서비스 수준은 새 신호로 다시 잰다
    this.save(); this.updBtns(); this.fillPanel();
  },
  updBtns() {
    $('#bFlow').classList.toggle('on', this.flow);
    $('#bNight').textContent = this.night ? '야간' : '주간'; $('#bNight').classList.toggle('on', this.night);
    $('#bSig').textContent = this.cfg.phase === 'lead' ? '직진 후 좌회전' : '방향별 동시';
    $('#bCoord').textContent = this.cfg.coord ? '연동 켬' : '연동 끔'; $('#bCoord').classList.toggle('on', !!this.cfg.coord);
  },
  save() { try { localStorage.setItem('citycfg', JSON.stringify(this.cfg)); } catch (e) { /* 저장 못 해도 돈다 */ } },

  /* ---------- 설정 ---------- */
  bindUI() {
    $('#bPause').onclick = () => this.togglePause();
    for (const b of $$('[data-speed]')) b.onclick = () => this.setSpeed(+b.dataset.speed);
    for (const b of $$('[data-mode]')) b.onclick = () => this.setMode(b.dataset.mode);
    $('#bFlow').onclick = () => this.toggleFlow();
    $('#bNight').onclick = () => this.toggleNight();
    $('#bSig').onclick = () => this.togglePhase();
    $('#bCoord').onclick = () => this.toggleCoord();
    $('#bSet').onclick = () => this.panel(true);
    $('#bClose').onclick = () => this.panel(false);
    $('#bApply').onclick = () => { this.readPanel(); this.save(); this.panel(false); this.rebuild(); };
    for (const b of $$('[data-preset]')) b.onclick = () => {
      const p = CPRESETS[b.dataset.preset];
      Object.assign(this.cfg, CCFG_DEFAULT, p); delete this.cfg.label;
      this.save(); this.panel(false); this.rebuild();
    };
    for (const el of $$('#panel input, #panel select')) el.addEventListener('input', () => { this.readPanel(true); this.est(); });
    this.setSpeed(1);
  },
  panel(on) {
    $('#panel').classList.toggle('on', on);
    if (on) { this.fillPanel(); this.analysis(); }
  },
  fillPanel() {
    const c = this.cfg;
    for (const k of ['NX', 'NY', 'B', 'seed', 'cycle', 'demand', 'inner']) $('#c_' + k).value = c[k];
    $('#c_lanes').value = String(c.lanes); $('#c_phase').value = c.phase; $('#c_coord').checked = !!c.coord;
    this.readPanel(true); this.est();
  },
  /** 패널 값을 읽는다 — onlyLabels 면 숫자 표시만 고친다 */
  readPanel(onlyLabels) {
    const v = (id) => +$('#c_' + id).value;
    $('#v_NX').textContent = v('NX'); $('#v_NY').textContent = v('NY'); $('#v_B').textContent = v('B') + ' m';
    $('#v_seed').textContent = v('seed'); $('#v_cycle').textContent = v('cycle') + ' 초';
    $('#v_demand').textContent = fmt0(v('demand')) + ' 대/시'; $('#v_inner').textContent = Math.round(v('inner') * 100) + ' %';
    if (onlyLabels) return;
    const c = this.cfg;
    for (const k of ['NX', 'NY', 'B', 'seed', 'cycle', 'demand', 'inner']) c[k] = v(k);
    c.lanes = +$('#c_lanes').value; c.phase = $('#c_phase').value; c.coord = $('#c_coord').checked;
  },
  /** 규모 · 수요 미리 셈 — 도시 밖 출입로의 용량과 수요를 견준다 */
  est() {
    const v = (id) => +$('#c_' + id).value, NX = v('NX'), NY = v('NY'), B = v('B'), n = +$('#c_lanes').value;
    const gates = 2 * (NX + NY), ints = NX * NY, km = ((NX - 1) * NY + (NY - 1) * NX) * B / 1000;
    $('#estOut').textContent = `교차로 ${ints}곳 · 도시 안 도로 ${fmt1(km)} km (왕복 ${n * 2}차로) · 도시 밖 출입로 ${gates}곳 · 건물 출입구 ${2 * ((NX - 1) * NY + (NY - 1) * NX)}곳`;
    /* 무리 없이 받는 수요 — 바깥 출입로 하나당 차로 수에 따라 시간당 85 · 200 · 230 대 (시드 여럿으로 1 시간씩 돌려
       서비스 수준 F 가 생기기 시작하는 수요를 잰 값: 4×4 왕복 4차로 ≈ 3,300 · 왕복 2차로 ≈ 1,300) */
    const cap = gates * [85, 200, 230][n - 1];
    const dem = v('demand'), w = $('#demWarn');
    if (dem > cap * 1.1) { w.textContent = `수요(시간당 ${fmt0(dem)}대)가 이 도로망이 무리 없이 받는 양(약 ${fmt0(Math.round(cap / 100) * 100)}대)을 넘습니다 — 대기열이 교차로를 거슬러 넘치고, 꼼짝 못 하는 교착이 생기기 쉽습니다.`; w.classList.add('on'); }
    else w.classList.remove('on');
  },
  analysis() {
    const C = this.C;
    const rows = C.ints.map((I) => {
      let q = 0; for (const sd of SIDES) for (const ln of I.inL[sd].lanes) for (const v of ln.cars) if (v.v < 1) q++;
      return { I, q };
    }).sort((a, b) => b.I.dEma - a.I.dEma).slice(0, 12);
    let h = '<table><tr><th>교차로 (지체 큰 순)</th><th>평균 지체</th><th>서비스 수준</th><th>멈춘 차</th></tr>';
    for (const { I, q } of rows) h += `<tr><td>${this.intName(I)}</td><td>${fmt1(I.dEma)} 초</td><td style="color:${LOS_COL[I.los]};font-weight:700">${I.los}</td><td>${q}</td></tr>`;
    h += '</table>';
    $('#anaOut').innerHTML = h;
  },
  intName(I) { return `${String.fromCharCode(65 + I.i)}${I.j + 1}`; },

  /* ---------- HUD ---------- */
  hud() {
    const sim = this.sim, S = sim.summary(), C = this.C;
    $('#sCars').textContent = fmt0(S.n) + ' 대';
    $('#sV').textContent = '평균 ' + fmt1(S.vAvg * MS2K) + ' km/h';
    $('#sQ').textContent = fmt0(S.queued);
    $('#sPerH').textContent = fmt0(S.perH) + ' 대/시';
    $('#sTT').textContent = S.tt ? mmss(S.tt) : '—';
    $('#sDelay').textContent = S.tt ? mmss(S.delay) : '—';
    $('#sStops').textContent = S.tt ? fmt1(S.stops) + ' 번' : '—';
    $('#sWait').textContent = fmt0(S.waiting) + (S.lost ? ` (포기 ${S.lost})` : '');
    $('#sJam').textContent = `${S.unjam} · ${S.detour}`;
    $('#clock').textContent = mmss(sim.time) + (this.lag ? ' (계산 밀림)' : '');
    const cnt = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
    for (const I of C.ints) cnt[I.los]++;
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
    line((p) => p.vAvg, CITY.vLim, '#5fc48f');
  },
  selInfo() {
    const box = $('#selBox'), sim = this.sim;
    if (this.selI) {
      const I = this.selI, ph = sim.phaseNow(I), names = PHASE_NAME[this.cfg.phase];
      let q = ''; let tot = 0;
      for (const sd of SIDES) {
        let n = 0; for (const ln of I.inL[sd].lanes) for (const v of ln.cars) if (v.v < 1) n++;
        tot += n; q += `<div class="row"><span class="k">${SIDE_KO[sd]}쪽에서 오는 길 — 멈춘 차</span><span class="v">${n}</span></div>`;
      }
      const P = sim.plan.ph[ph.q], inG = ph.t < P.g;
      box.innerHTML = `<h3>교차로 ${this.intName(I)}</h3>` +
        `<div class="ph">${names.map((nm, k) => `<span class="${k === ph.q ? 'on' : ''}">${nm}</span>`).join('')}</div>` +
        `<div class="row"><span class="k">지금</span><span class="v">${names[ph.q]} ${inG ? '녹색' : ph.t < P.g + CITY.yellow ? '황색' : '전적색'} · ${Math.ceil(inG ? P.g - ph.t : ph.left)} 초</span></div>` +
        `<div class="row"><span class="k">주기 · 시작 어긋남</span><span class="v">${Math.round(sim.plan.cyc)} 초 · ${Math.round(I.offset)} 초</span></div>` +
        `<div class="row"><span class="k">평균 지체 · 서비스 수준</span><span class="v">${fmt1(I.dEma)} 초 · <b style="color:${LOS_COL[I.los]}">${I.los}</b></span></div>` +
        q + `<div class="hint">신호 방식(G) · 연동(C)을 바꿔 지체가 어떻게 달라지는지 보세요. 멈춘 차 ${tot}대.</div>`;
      box.style.display = 'block';
      return;
    }
    const v = this.sel;
    if (!v || v.gone) { box.style.display = 'none'; return; }
    const from = v.trip.o.zone ? '도심 건물' : `도시 밖 (${SIDE_KO[v.trip.o.gate.gate.side]}쪽)`, to = v.dest.zone ? '도심 건물' : `도시 밖 (${SIDE_KO[v.dest.gate.gate.side]}쪽)`;
    let next = '—';
    if (v.edge.kind === 'conn') next = MV_KO[v.edge.mv] + ' 중';
    else if (v.conn) next = `${MV_KO[v.conn.mv]} (${Math.round(v.edge.len - v.s)} m 앞)`;
    else if (v.dest.zone && v.dest.zone.link === v.edge.link) next = `목적지 건물 (${Math.max(0, Math.round(v.dest.zone.s - v.s))} m 앞)`;
    else if (!v.edge.link || !v.edge.link.to) next = '도시 밖으로';
    let left = 0; for (let q = v.ri + 1; q < v.route.length; q++) left += v.route[q].len + C_box2(this.C);
    box.innerHTML = `<h3>${v.cls.name} #${v.id}</h3>` +
      `<div class="row"><span class="k">출발 → 목적지</span><span class="v">${from} → ${to}</span></div>` +
      `<div class="row"><span class="k">속도</span><span class="v">${fmt1(v.v * MS2K)} km/h</span></div>` +
      `<div class="row"><span class="k">다음</span><span class="v">${next}</span></div>` +
      `<div class="row"><span class="k">달린 시간 · 정지</span><span class="v">${mmss(sim.time - v.trip.t0)} · ${v.stops} 번</span></div>` +
      `<div class="row"><span class="k">남은 길</span><span class="v">약 ${distStr(left + (v.edge.len - v.s))}</span></div>` +
      `<div class="hint">하늘색 띠가 앞으로 갈 길 — 막히면 교차로에서 다시 고른다. F 따라가기 · V 운전석.</div>`;
    box.style.display = 'block';
  },
  /** 교차로 이름표 · 소통 지도일 때 서비스 수준 글자 */
  overlay() {
    const g = this.ctx;
    if (!this.flow || this.mode === 'driver' || this.mode === 'follow') return;
    const k = this.H / 900;
    g.font = `700 ${Math.round(13 * k + 2)}px system-ui,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const I of this.C.ints) {
      const q = Render.point(I.x, I.y, 14); if (!q || q.z > 2500) continue;
      const r = 11 * k + 3;
      g.fillStyle = '#0d1118d0'; g.beginPath(); g.arc(q.x, q.y, r, 0, TAU); g.fill();
      g.strokeStyle = LOS_COL[I.los]; g.lineWidth = 2.5 * k + 0.5; g.stroke();
      g.fillStyle = LOS_COL[I.los]; g.fillText(I.los, q.x, q.y + 0.5);
    }
  },
  toast(msg, sec) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.remove('on'), (sec || 2.5) * 1000);
  },
};
/** 교차로를 지나는 길이 (정지선 ~ 다음 구간 시작) */
function C_box2(C) { return 2 * C.box; }

addEventListener('DOMContentLoaded', () => CApp.init());
