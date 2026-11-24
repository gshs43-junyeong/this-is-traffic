/* =============================================================================
   pmain.js — 주차장 시뮬레이터 앱 (입력 · 카메라 · HUD · 설정)
   ========================================================================== */
'use strict';

const PCFG_DEFAULT = {
  W: 64, D: 52, U: 4, B: 2,
  inRate: 220, outRate: 200, thruRate: 240, initOcc: 0.55,
  revShare: 0.7, gate: 'lpr', guide: false, balk: 7, seed: 7,
};
const PPRESETS = {
  tower: { W: 52, D: 46, U: 6, B: 0, inRate: 200, outRate: 160, initOcc: 0.5, label: '주차타워' },
  under: { W: 72, D: 56, U: 0, B: 3, inRate: 240, outRate: 220, initOcc: 0.6, label: '지하주차장' },
  mixed: { W: 64, D: 52, U: 4, B: 2, inRate: 220, outRate: 200, initOcc: 0.55, label: '복합' },
  rush: { W: 64, D: 52, U: 3, B: 2, inRate: 520, outRate: 60, initOcc: 0.7, label: '출근 몰림' },
  leave: { W: 64, D: 52, U: 3, B: 2, inRate: 40, outRate: 600, initOcc: 0.95, label: '퇴근 몰림' },
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
    requestAnimationFrame((t) => this.loop(t));
  },

  rebuild() {
    const c = this.cfg;
    c.U = clamp(c.U | 0, 0, 20); c.B = clamp(c.B | 0, 0, 10);
    if (c.U + c.B < 1) c.U = 1;
    this.G = buildGarage(c);
    this.sim = new ParkSim(this.G, c);
    PScene.init(this.G, this.sim);
    if (Render.gl) PScene.uploaded = false;
    this.cut = this.G.NL - 1;
    this.sel = null; this.mode = 'orbit';
    const G = this.G;
    this.cam.tx = G.W / 2; this.cam.ty = G.D / 2 - 4; this.cam.tz = G.levels[this.cut].z;
    this.cam.dist = clamp(Math.hypot(G.W, G.D) * 1.05 + G.NL * 3, 60, 320);
    this.fillPanel();
    const S = this.sim.summary();
    this.toast(`${G.levels[0].name}~${G.levels[G.NL - 1].name} · 주차면 ${S.total}면 · 경사로 최대 ${fmt1(G.grade * 100)}%`, 4);
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
    this.updateCam(raw);
    const t1 = performance.now();
    PScene.draw(this.ctx, this.W, this.H, this.camPose, { cut: this.cut, skyCtx: this.skyCtx, time: this.sim.time, sel: this.sel, follow: this.mode === 'follow', guide: this.cfg.guide, dt: raw * (this.paused ? 0 : this.speed) });
    this.overlay();
    this.drawMs = (this.drawMs || 0) * 0.9 + (performance.now() - t1) * 0.1;
    this.hudT = (this.hudT || 0) + raw;
    if (this.hudT > 0.25) { this.hudT = 0; this.hud(); }
    requestAnimationFrame((tt) => this.loop(tt));
  },

  /* ---------- 카메라 ---------- */
  updateCam(dt) {
    const G = this.G, c = this.cam;
    const v = this.sel;
    if (v && v.mode === 'done') { this.sel = null; this.mode = 'orbit'; this.updMode(); }
    if (this.mode === 'follow' && this.sel) {
      const s = this.sel;
      const k = 1 - Math.exp(-dt / 0.35);
      const wantYaw = s.h;
      this.fYaw = this.fYaw == null ? wantYaw : this.fYaw + wrapPi(wantYaw - this.fYaw) * k;
      const back = 8.5, up = 3.2;
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
      const dx = s.x - px, dy = s.y - py, dz = s.z + 1.0 - pz;
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

  /* ---------- 입력 ---------- */
  bindInput() {
    const cv = this.cv;
    let drag = null;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, b: e.button, sx: e.clientX, sy: e.clientY, pan: e.button === 2 || e.shiftKey };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      const c = this.cam;
      if (this.mode === 'follow') { if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) { this.mode = 'orbit'; this.retarget(); this.updMode(); } else return; }
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
      else if (k === 't' || k === 'T') this.setMode(this.mode === 'top' ? 'orbit' : 'top');
      else if (k === 'f' || k === 'F') this.followRandom();
      else if (k === 'Escape') { if ($('#panel').classList.contains('on')) this.panel(false); else { this.sel = null; this.setMode('orbit'); } }
      else if (k === 'p' || k === 'P') this.panel(!$('#panel').classList.contains('on'));
    });
  },
  retarget() {
    const s = this.sel; if (!s) return;
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
    this.sel = best;
    this.hud();
  },
  followRandom() {
    const c = this.sim.cars.filter((v) => (v.mode === 'drive' && v.inside) || v.mode === 'man');
    if (!c.length) { this.toast('지금 움직이는 차가 없습니다', 2); return; }
    this.sel = this.sim.rng.pick(c);
    this.setMode('follow');
  },
  setMode(m) {
    if (m === 'follow' && !this.sel) { this.followRandom(); return; }
    this.mode = m; this.fPos = null; this.fYaw = null;
    if (m !== 'follow' && this.sel) this.retarget();
    this.updMode();
  },
  updMode() { for (const b of $$('[data-mode]')) b.classList.toggle('on', b.dataset.mode === this.mode); },
  setCut(c) { this.cut = clamp(c, 0, this.G.NL - 1); if (this.mode === 'follow') this.setMode('orbit'); this.hud(); },
  setSpeed(s) { this.speed = s; for (const b of $$('[data-speed]')) b.classList.toggle('on', +b.dataset.speed === s); },
  togglePause() { this.paused = !this.paused; $('#bPause').textContent = this.paused ? '▶ 재생' : '⏸ 일시정지'; },

  /* ---------- UI ---------- */
  bindUI() {
    $('#bPause').onclick = () => this.togglePause();
    for (const b of $$('[data-speed]')) b.onclick = () => this.setSpeed(+b.dataset.speed);
    for (const b of $$('[data-mode]')) b.onclick = () => this.setMode(b.dataset.mode);
    $('#bUp').onclick = () => this.setCut(this.cut + 1);
    $('#bDn').onclick = () => this.setCut(this.cut - 1);
    $('#bSet').onclick = () => this.panel(true);
    $('#bIn').onclick = () => { const n = +$('#nBatch').value; this.sim.addArrivals(n); this.toast(`${n}대가 앞 도로로 옵니다`, 2); };
    $('#bOut').onclick = () => { const n = +$('#nBatch').value; const k = this.sim.addDepartures(n); this.toast(k ? `${k}대가 출차를 시작합니다 (통로가 비면 빠져나옵니다)` : '세워 둔 차가 없습니다', 2.5); };
    $('#bClose').onclick = () => this.panel(false);
    $('#bApply').onclick = () => { this.readPanel(true); this.panel(false); this.rebuild(); };
    for (const b of $$('[data-preset]')) b.onclick = () => {
      const p = PPRESETS[b.dataset.preset];
      Object.assign(this.cfg, p); delete this.cfg.label;
      this.fillPanel(); this.readPanel(true); this.panel(false); this.rebuild();
    };
    // 수요 · 운영 값은 다시 짓지 않고 바로 반영
    for (const id of ['inRate', 'outRate', 'thruRate', 'revShare', 'balk']) {
      const el = $('#c_' + id);
      el.addEventListener('input', () => { this.readPanel(false); this.live(); });
    }
    for (const id of ['guide', 'gate']) $('#c_' + id).addEventListener('change', () => { this.readPanel(false); this.live(); });
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
  panel(on) { $('#panel').classList.toggle('on', on); if (on) this.fillPanel(); },
  fields: {
    W: [(v) => v + ' m'], D: [(v) => v + ' m'], U: [(v) => v === 0 ? '없음 (지면 광장)' : v + '개 층'], B: [(v) => v === 0 ? '없음' : v + '개 층'],
    inRate: [(v) => v + ' 대/시'], outRate: [(v) => v + ' 대/시'], thruRate: [(v) => v + ' 대/시'],
    initOcc: [(v) => Math.round(v * 100) + ' %'], revShare: [(v) => Math.round(v * 100) + ' %'], balk: [(v) => v + ' 대'], seed: [(v) => '' + v],
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
    this.est();
  },
  readPanel(all) {
    const c = this.cfg;
    for (const k in this.fields) {
      const el = $('#c_' + k); if (!el) continue;
      const v = +el.value;
      if (all || !['W', 'D', 'U', 'B', 'initOcc', 'seed'].includes(k)) c[k] = v;
      const o = $('#v_' + k); if (o) o.textContent = this.fields[k][0](v);
    }
    c.guide = $('#c_guide').checked; c.gate = $('#c_gate').value;
    this.est();
    this.save();
  },
  /** 설정 창의 규모 미리 셈 — 짓기 전에 면 수를 알려 준다 */
  est() {
    const W = +$('#c_W').value, D = +$('#c_D').value, U = +$('#c_U').value, B = +$('#c_B').value;
    try {
      const g = buildGarage({ W, D, U, B, seed: 1 });
      $('#estOut').textContent = `${g.levels[0].name}~${g.levels[g.NL - 1].name} (${g.NL}개 층) · 주차면 ${g.stalls.length}면 · 층당 약 ${Math.round(g.stalls.length / Math.max(1, g.levels.filter((l) => l.park).length))}면 · 경사로 ${fmt1(g.Lr)} m, 최대 경사 ${fmt1(g.grade * 100)} %`;
    } catch (e) { $('#estOut').textContent = '배치 불가: ' + e.message; }
  },

  hud() {
    const S = this.sim.summary(), G = this.G;
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
    st('#sHunt', S.hunting + ' 대');
    st('#sMan', S.man + ' 대');
    st('#sQin', S.qIn + ' 대' + (S.coming ? ` (+${S.coming} 오는 중)` : ''));
    st('#sQout', (S.qOut + S.wantOut) + ' 대');
    st('#sSearch', S.searchAvg ? mmss(S.searchAvg) : '—');
    st('#sExit', S.exitAvg ? mmss(S.exitAvg) : '—');
    st('#sQueue', S.queueAvg ? mmss(S.queueAvg) : '—');
    st('#sIO', `${S.inN} / ${S.outN}`);
    st('#sLost', `${S.lost} / ${S.gaveUp}`);
    st('#clock', mmss(this.sim.time) + (this.speed > 1 ? ` · ×${this.speed}` : ''));
    st('#perf', `${(this.drawMs || 0).toFixed(1)} ms · 계산 ${(this.simMs || 0).toFixed(1)} ms · ${this.sim.cars.length} 대`);
    // 선택한 차
    const v = this.sel, box = $('#selBox');
    if (v && v.mode !== 'done') {
      box.style.display = 'block';
      const what = v.mode === 'parked' ? (v.leaving ? '출차 대기 (통로가 빌 때까지)' : '주차 중') :
        v.mode === 'man' ? ({ revIn: '후면주차 중 (후진)', fwdIn: '전면주차 중', outFwd: '출차 — 앞으로 빠짐', outRev: '출차 — 후진으로 빠짐' }[v.man.kind]) :
          v.role === 'thru' ? '통과 차량' : v.done ? '나가는 중' : !v.inside ? (v.balk ? '대기열이 길어 지나감' : '입구로') :
            v.leaving ? '출구로' : v.giveUp ? '못 찾고 나감' : v.plan ? (v.plan.how === 'rev' ? '후면주차 준비' : '전면주차 준비') :
              v.waitFor ? '나가는 차를 기다림' : v.stall ? (v.guided ? '배정된 면으로' : '고른 면으로') : '빈 자리 찾는 중';
      const lv = G.levels[PScene.lvAt(v.z)].name;
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
    if (this.mode !== 'follow') {
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
      // 입구 · 출구
      for (const [ed, t] of [[G.entry, '입구'], [G.exit, '출구']]) {
        const q0 = ed.at(ed.gate.s - 6), q = Render.point(q0.x, q0.y, 2.6);
        if (!q) continue;
        ctx.fillStyle = '#10141bcc'; const w = ctx.measureText(t).width + 12;
        ctx.fillRect(q.x - w / 2, q.y - 10, w, 20);
        ctx.fillStyle = t === '입구' ? '#7fe0a8' : '#ffc07a'; ctx.fillText(t, q.x, q.y);
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
