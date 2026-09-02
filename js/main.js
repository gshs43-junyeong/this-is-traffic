/* =============================================================================
   main.js — 루프 / 조작 / 플레이어 차량 / 카메라 / 음향
   ========================================================================== */
'use strict';

const CFG_DEFAULT = {
  seed: 20260902, length: 40000, lanes: 3,
  icSpacing: 5500,     // 인터체인지 평균 간격 (m) — 실제 간격은 여기서 ±40% 로 흔들린다
  endless: true,       // 구간 끝에 닿으면 새 지형을 이어서 만든다
  demand: 1500,        // 대/시/차로 (상류 유입 수요)
  truckPct: 10, busPct: 5,
  rampPct: 12,         // 본선 수요 대비 램프 진입 비율
  exitPct: 12,         // 인터체인지별 유출 비율
  limit: 100,          // 제한속도 km/h
  incidentRate: 0.5,   // 돌발상황 건/시
  reactionTime: 0.5,   // 지각 반응시간 s
  noise: 1.0,          // 가속도 잡음 배율
  laneRule: true,      // 지정차로제
  weather: 'dry',      // dry | rain
  peak: false,         // 첨두 수요 프로파일
  timeOfDay: 'day',    // day | dusk | night
  twoWay: true,        // 반대편 차도 모의
  lka: true,           // 차선유지보조
  relief: 55,          // 지형 기복(산의 높이) 0~100
  density: 50,         // 산 밀도 0~100
  ruggedness: 50,      // 험준도(사면이 날선 정도) 0~100
  tunnelSep: 26,       // 쌍굴 이격 (m)
  view: 'cockpit',     // cockpit | chase | high
};

const WB = 2.75;                       // 축거 m
const MU = { dry: 0.88, rain: 0.62 };  // 노면 마찰

const App = {
  cfg: Object.assign({}, CFG_DEFAULT),
  paused: false, dirty: false, frame: 0, simTime: 0, speedMul: 1,
  auto: false, showMap: true,

  init() {
    this.cv = document.getElementById('view');
    this.ctx = this.cv.getContext('2d', { alpha: false });
    this.mapCv = document.getElementById('mapCv');
    UI.init(this);
    this.bindInput();
    this.rebuild();
    addEventListener('resize', () => this.resize());
    this.resize();
    this.last = performance.now();
    setTimeout(() => { const k = document.getElementById('keys'); if (k) k.classList.add('fade'); }, 14000);
    requestAnimationFrame((t) => this.loop(t));
  },

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    this.cv.width = Math.max(320, Math.round(w * dpr));
    this.cv.height = Math.max(240, Math.round(h * dpr));
    this.W = this.cv.width; this.H = this.cv.height;
    // 화면이 크면 묘사 거리를 줄여 프레임을 지킨다
    Render.quality = this.W > 1900 ? 0.82 : 1;
  },

  /* ---------- 세계 재생성 ---------- */
  rebuild() {
    const c = this.cfg;
    this.road = new Road({
      seed: c.seed | 0, length: c.length,
      terrain: { relief: c.relief, density: c.density, ruggedness: c.ruggedness },
      tunnelSep: c.tunnelSep, icSpacing: c.icSpacing,
    });
    this.corrA = new Corridor(this.road, 1, c, (c.seed | 0) * 7 + 1);
    this.corrB = c.twoWay ? new Corridor(this.road, -1, c, (c.seed | 0) * 7 + 2) : null;
    this.simTime = 0; this.dirty = false;
    this.makePlayer();
    // 내 차 주변을 설정한 밀도로 미리 깔고, 짧게 돌려 자리를 잡게 한다
    this.corrA.focusS = this.player.s;
    if (this.corrB) this.corrB.focusS = this.corrA.L - this.player.s;
    this.corrA.prefill(); if (this.corrB) this.corrB.prefill();
    this.warm(30);
    UI.toast(this.roadSummary(), 5);
  },
  roadSummary() {
    const r = this.road;
    const br = r.structs.filter(s => s.type === 'bridge').length;
    const tu = r.structs.filter(s => s.type === 'tunnel').length;
    let minR = Infinity;
    for (let i = 0; i < r.n; i++) { const k = Math.abs(r.K[i]); if (k > 1e-7 && 1 / k < minR) minR = 1 / k; }
    let mg = 0; for (let i = 0; i < r.n; i++) mg = Math.max(mg, Math.abs(r.grade[i]));
    return `노선 생성 — ${fmt1(r.len / 1000)}km · ${this.cfg.lanes}차로 · 교량 ${br} · 터널 ${tu} · IC ${r.ics.length}` +
      ` · 최소반경 ${isFinite(minR) ? fmt0(minR) + 'm' : '직선'} · 최대경사 ${fmt1(mg * 100)}%`;
  },
  warm(sec) {
    const n = Math.round(sec / DT);
    const stub = { auto: true };
    for (let i = 0; i < n; i++) {
      this.corrA.step(DT, stub);
      if (this.corrB) this.corrB.step(DT, stub);
    }
    this.simTime += sec;
  },

  makePlayer() {
    const c = this.corrA;
    const p = new Vehicle().init('car', c.rng, this.cfg);
    p.isPlayer = true;
    p.color = '#2f6fd0';      // 내 차 — 채도 있는 한 색으로 고정
    p.lane = p.laneT = c.nLane - 1;
    p.s = 400; p.v = 80 * KMH;
    p.u = p.uT = c.laneU(p.lane);
    p.eps = 0; p.throttle = 0; p.brakeIn = 0; p.steer = 0;
    p.t0 = this.simTime; p.s0enter = p.s;
    p.offRoad = false; p.crashT = 0; p.dist = 0; p.driveT = 0;
    for (let h = 0; h < HIST; h++) { p.hs[h] = p.s - p.v * (HIST - h) * DT; p.hv[h] = p.v; }
    c.lanes[p.lane].splice(c.seek(c.lanes[p.lane], p.s), 0, p);
    this.player = p;
    this.cam = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
    this.camInit = false;
  },

  markDirty() { this.dirty = true; const b = document.getElementById('btnRegen'); if (b) b.classList.add('warn'); },
  /** 재생성 없이 즉시 반영되는 설정 */
  applyLive(key) {
    if (key === 'weather') { this.corrA.rebuildCaps(); if (this.corrB) this.corrB.rebuildCaps(); }
    if (key === 'lanes' || key === 'twoWay') this.rebuildTraffic();
    if (key === 'timeOfDay' || key === 'view') { /* 렌더러가 매 프레임 읽는다 */ }
  },

  /** 도로는 그대로 두고 교통만 다시 세운다 — 차로 수를 즉시 바꿀 수 있다 */
  rebuildTraffic() {
    const c = this.cfg;
    const keepS = this.player ? this.player.s : 400;
    const keepV = this.player ? this.player.v : 80 * KMH;
    this.corrA = new Corridor(this.road, 1, c, (c.seed | 0) * 7 + 1);
    this.corrB = c.twoWay ? new Corridor(this.road, -1, c, (c.seed | 0) * 7 + 2) : null;
    this.makePlayer();
    this.player.s = clamp(keepS, 100, this.corrA.L - 400);
    this.player.v = keepV;
    const arr = this.corrA.lanes[this.player.lane];
    const k = arr.indexOf(this.player); if (k >= 0) arr.splice(k, 1);
    arr.splice(this.corrA.seek(arr, this.player.s), 0, this.player);
    this.corrA.focusS = this.player.s;
    if (this.corrB) this.corrB.focusS = this.corrA.L - this.player.s;
    this.corrA.prefill(); if (this.corrB) this.corrB.prefill();
    this.warm(25);
  },

  /* ---------- 프리셋 ---------- */
  preset(name) {
    const c = this.cfg;
    const set = (o) => { Object.assign(c, o); for (const inp of $$('[data-cfg]')) { const k = inp.dataset.cfg; if (inp.type === 'checkbox') inp.checked = !!c[k]; else inp.value = c[k]; const out = inp.parentElement.querySelector('.val'); if (out) out.textContent = UI.fmtCfg(k, c[k]); } };
    switch (name) {
      case 'free': set({ demand: 900, rampPct: 8, incidentRate: 0, peak: false }); UI.toast('자유류 — 수요 900대/시/차로', 3); break;
      case 'near': set({ demand: 1700, rampPct: 12, incidentRate: 0, peak: false }); UI.toast('임계 상태 — 작은 교란도 정체로 자란다', 4); break;
      case 'jam': set({ demand: 2100, rampPct: 20, incidentRate: 0.4, peak: false }); UI.toast('혼잡 — 합류부 병목에서 정체가 시작된다', 4); break;
      case 'peak': set({ demand: 1400, rampPct: 16, incidentRate: 0.3, peak: true }); UI.toast('첨두 — 수요가 용량을 넘었다가 되돌아온다', 4); break;
      case 'rain': set({ weather: 'rain', timeOfDay: 'dusk', demand: 1600 }); UI.toast('우천 — 희망속도·차두시간이 나빠진다', 4); break;
      case 'night': set({ timeOfDay: 'night', demand: 800 }); UI.toast('야간 — 통행량이 적다', 3); break;
      case 'plain': set({ relief: 12, density: 20, ruggedness: 15 }); this.rebuild(); UI.toast('평야부 — 길게 뻗은 완만한 선형', 3.5); return;
      case 'hill': set({ relief: 45, density: 45, ruggedness: 40 }); this.rebuild(); UI.toast('구릉지 — 완만한 굽이와 짧은 터널', 3.5); return;
      case 'mount': set({ relief: 82, density: 72, ruggedness: 78 }); this.rebuild(); UI.toast('산악부 — 최소반경에 가까운 굽이, 긴 터널과 교량', 4); return;
    }
    this.corrA.rebuildCaps(); if (this.corrB) this.corrB.rebuildCaps();
    UI.togglePanel(false);
  },

  action(a) {
    switch (a) {
      case 'auto': this.auto = !this.auto; this.player.auto = this.auto;
        UI.toast(this.auto ? '자율주행 — 이 차도 IDM·MOBIL 로 달린다' : '수동 운전', 2.5); break;
      case 'cam': {
        const order = ['chase', 'cockpit', 'high'];
        this.cfg.view = order[(order.indexOf(this.cfg.view) + 1) % order.length];
        UI.toast({ chase: '추적 시점', cockpit: '운전석 시점', high: '상공 시점' }[this.cfg.view], 1.6); break;
      }
      case 'incident': {
        const s = this.player.s + 900;
        if (s < this.corrA.L - 500) {
          const inc = this.corrA.addIncident({ laneBlock: true, s, lane: this.corrA.rng.int(0, this.corrA.nLane - 1) });
          UI.toast('전방 900m ' + (inc.lane + 1) + '차로 차단 사고 발생', 4);
        }
        break;
      }
      case 'map': this.showMap = !this.showMap; this.mapCv.style.display = this.showMap ? '' : 'none'; break;
      case 'speed': this.speedMul = this.speedMul >= 4 ? 1 : this.speedMul * 2;
        UI.toast('모의 배속 ' + this.speedMul + '배', 1.6); break;
      case 'reset': this.resetPlayer(); break;
    }
    this.syncButtons();
  },
  syncButtons() {
    const ba = document.querySelector('[data-act="auto"]'); if (ba) ba.classList.toggle('on', this.auto);
    const bs = document.querySelector('[data-act="speed"]'); if (bs) bs.textContent = '배속 ×' + this.speedMul;
  },

  resetPlayer() {
    const p = this.player, c = this.corrA;
    const arr = c.lanes[p.lane]; const k = arr.indexOf(p); if (k >= 0) arr.splice(k, 1);
    p.s = 400; p.v = 80 * KMH; p.lane = p.laneT = c.nLane - 1;
    p.u = p.uT = c.laneU(p.lane); p.eps = 0; p.crashT = 0; p.t0 = this.simTime; p.s0enter = p.s;
    for (let h = 0; h < HIST; h++) { p.hs[h] = p.s - p.v * (HIST - h) * DT; p.hv[h] = p.v; }
    c.lanes[p.lane].splice(c.seek(c.lanes[p.lane], p.s), 0, p);
    UI.toast('시점으로 되돌렸습니다', 2);
  },

  /* ---------- 입력 ---------- */
  bindInput() {
    this.key = {};
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      Sound.arm();
      const k = e.key.toLowerCase();
      this.key[k] = 1;
      if (k === 'c') this.action('cam');
      else if (k === 'p') this.action('auto');
      else if (k === 'i') this.action('incident');
      else if (k === 'm') this.action('map');
      else if (k === 'escape' || k === 'tab') { e.preventDefault(); UI.togglePanel(!this.paused); }
      else if (k === 'r') this.action('reset');
      else if (k === 'x') this.action('speed');
      else if (k === 'n') Sound.toggle();
      if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
    });
    addEventListener('keyup', (e) => { this.key[e.key.toLowerCase()] = 0; });
    addEventListener('blur', () => { this.key = {}; });
    this.cv.addEventListener('pointerdown', () => Sound.arm());
  },

  /* ---------- 플레이어 물리 ---------- */
  drivePlayer(dt) {
    const p = this.player, c = this.corrA, cfg = this.cfg;
    const K = this.key;
    const up = K['w'] || K['arrowup'], down = K['s'] || K['arrowdown'];
    const left = K['a'] || K['arrowleft'], right = K['d'] || K['arrowright'];
    const hard = K[' '];

    p.throttle = approach(p.throttle, up ? 1 : 0, 0.14, dt);
    p.brakeIn = approach(p.brakeIn, (down ? 1 : 0) || (hard ? 1 : 0), 0.08, dt);
    const steerIn = (right ? 1 : 0) - (left ? 1 : 0);
    // 꺾을 때는 빠르게, 놓을 때는 조금 더 빠르게 돌아온다 (셀프 얼라이닝)
    p.steer = approach(p.steer, steerIn, steerIn ? 0.085 : 0.055, dt);

    const pp = p.p, grade = c.gradeAt(p.s);
    // 종방향
    let a = 0;
    a += pp.powEff / Math.max(p.v, 4) * p.throttle;
    a -= MU[cfg.weather] * GRAV * p.brakeIn * (hard ? 1 : 0.82);
    a -= pp.CrG + pp.dragK * p.v * p.v + GRAV * grade;
    if (p.throttle < 0.05 && p.brakeIn < 0.05) a -= 0.45;      // 엔진 브레이크
    if (p.offRoad) a -= 1.6;                         // 갓길·노면 밖 저항
    if (p.crashT > 0) a -= 6;
    p.a = clamp(a, -MU[cfg.weather] * GRAV, 4.5);
    const vN = p.v + p.a * dt;
    p.v = vN < 0 ? 0 : vN;
    p.brake = p.brakeIn > 0.15 ? 1 : 0;

    // 횡방향 — 곡선 좌표계 자전거 모델
    const g = c.geo(p.s);
    const kap = g.kap * c.dir;                        // 진행방향 기준 곡률
    const aLatMax = 6.4;
    const tanMax = p.v > 3 ? clamp(aLatMax * WB / (p.v * p.v), 0.004, 0.55) : 0.55;
    const delta = Math.atan(-p.steer * tanMax);       // 오른쪽 입력 = 시계방향
    let dEps = p.v * Math.tan(delta) / WB - kap * p.v * Math.cos(p.eps);
    if (!steerIn && cfg.lka && p.v > 4) {
      // 차선유지보조 — 가장 가까운 차로 중심을 향한 PD 제어.
      // 이게 없으면 곡선부에서 조향을 놓는 순간 바깥으로 밀려난다(실제 차의 거동이지만
      // 키보드 조작으로는 계속 붙잡고 있어야 해서 관찰에 방해가 된다).
      const nl = c.nLaneAt(p.s);
      const li = clamp(Math.round((p.u - RoadStd.shL) / RoadStd.laneW - 0.5), 0, nl - 1);
      const err = c.laneU(li) - p.u;                 // + 면 왼쪽으로 가야 한다
      // 곡선을 놓쳐 밀려나지 않을 만큼만 거든다. 너무 세면 레일 위를 달리는 느낌이 된다.
      const epsWant = clamp(-err * 0.11, -0.075, 0.075);
      dEps += (epsWant - p.eps) * 1.15;
    } else if (!steerIn) {
      dEps += (0 - p.eps) * 0.8;
    }
    p.eps = clamp(p.eps + dEps * dt, -0.42, 0.42);
    p.u -= p.v * Math.sin(p.eps) * dt;
    p.s += p.v * Math.cos(p.eps) * dt;
    p.yawRel = p.eps;

    // 차로 밖 판정 (갓길 / 중앙분리대)
    const nl = c.nLaneAt(p.s);
    const uMin = 0.30, uMax = RoadStd.shL + RoadStd.laneW * nl + RoadStd.shR - 0.9;
    const wasOff = p.offRoad;
    p.offRoad = p.u < RoadStd.shL - 0.2 || p.u > RoadStd.shL + RoadStd.laneW * nl + 0.3;
    if (p.u < uMin) { p.u = uMin; p.eps = Math.max(p.eps, 0); this.crash('중앙분리대와 접촉'); }
    if (p.u > uMax) { p.u = uMax; p.eps = Math.min(p.eps, 0); this.crash('길어깨 바깥으로 이탈'); }
    if (p.offRoad && !wasOff) UI.toast('차로를 벗어났습니다', 1.6);

    // 소속 차로 갱신
    const li = clamp(Math.round((p.u - RoadStd.shL) / RoadStd.laneW - 0.5), 0, c.lanes.length - 1);
    if (li !== p.lane) {
      const from = c.lanes[p.lane], k = from.indexOf(p); if (k >= 0) from.splice(k, 1);
      p.lane = li; p.laneT = li;
      c.lanes[li].splice(c.seek(c.lanes[li], p.s), 0, p);
    }
    p.uT = p.u;
    p.crashT = Math.max(0, p.crashT - dt);
    p.dist += p.v * dt; p.driveT += dt;
    this.checkCollision();
  },

  crash(why) {
    const p = this.player;
    if (p.crashT > 0) return;
    p.crashT = 1.4; p.v *= 0.55;
    UI.toast('⚠ ' + why, 2.5);
    this.shake = 1;
  },

  checkCollision() {
    const p = this.player, c = this.corrA;
    for (let li = Math.max(0, p.lane - 1); li <= Math.min(c.lanes.length - 1, p.lane + 1); li++) {
      const arr = c.lanes[li];
      const k = c.seek(arr, p.s);
      for (let j = k - 2; j <= k + 1; j++) {
        const o = arr[j];
        if (!o || o === p) continue;
        const dLon = p.s - o.s;
        const overlapLon = dLon > 0 ? (dLon - o.len < 0.1 && dLon > 0) : (-dLon - p.len < 0.1 && -dLon > 0);
        const near = Math.abs(dLon) < Math.max(p.len, o.len) + 0.2;
        if (!near) continue;
        if (Math.abs(p.u - o.u) < (p.wid + o.wid) * 0.5 - 0.12) {
          this.crash(o.obstacle ? '정지 차량과 충돌' : VCLASS[o.cls].name + '와(과) 접촉');
          const rel = p.v - o.v;
          p.v -= Math.max(0, rel) * 0.5;
          if (!o.obstacle) o.v = Math.max(0, o.v - 2);
          p.u += sgn(p.u - o.u) * 0.5;
          return;
        }
      }
    }
  },

  /* ---------- 카메라 ---------- */
  updateCam(dt) {
    const p = this.player, c = this.corrA, rd = this.road, view = this.cfg.view;
    const back = (view === 'cockpit' ? 0.35 : view === 'chase' ? 8.2 : 30) + (this.surge || 0);
    const up = view === 'cockpit' ? 1.22 : view === 'chase' ? 2.3 : 16;
    const sC = p.s - back;
    const g = c.geo(sC);
    const u = c.dir > 0 ? (g.med + p.u) : -(g.med + p.u);
    const nx = Math.sin(g.hdg), ny = -Math.cos(g.hdg);
    const tx = g.x + nx * u * (view === 'high' ? 0.5 : 1);
    const ty = g.y + ny * u * (view === 'high' ? 0.5 : 1);
    const tz = g.z + rd.crossZ(g, u) + up;
    // 조향한 쪽을 조금 먼저 본다 — 굽이를 미리 읽게 되어 조작이 붙는다
    const look = (view === 'cockpit' ? 0.85 : 0.35) * p.eps + (view === 'high' ? 0 : 0.10 * (p.steer || 0));
    const yawT = g.hdg + (c.dir > 0 ? 0 : Math.PI) + look;
    // 앞쪽 도로의 종단경사를 보고 시선을 맞춘다
    const ahead = c.geo(Math.min(p.s + 70, c.L - 1));
    const pitchT = Math.atan2((ahead.z - g.z), 70) * (view === 'high' ? 0.4 : 1) - (view === 'high' ? 0.30 : 0.028);
    // 편경사에 더해, 횡가속만큼 차체가 기운다
    const aLat = p.v * p.v * Math.abs(g.kap) * sgn(g.kap) * c.dir;
    // 편경사 + 횡가속 + 조향입력. 조향에 직접 묶인 롤이 꺾는 감각을 만든다.
    const rollT = (view === 'cockpit' ? -g.e * 0.75 : -g.e * 0.35) * c.dir
      + clamp(aLat * 0.020, -0.13, 0.13)
      - (p.steer || 0) * (view === 'high' ? 0.010 : 0.055) * clamp(p.v / 22, 0, 1);

    const cam = this.cam;
    if (!this.camInit) { cam.x = tx; cam.y = ty; cam.z = tz; cam.yaw = yawT; cam.pitch = pitchT; cam.roll = rollT; this.camInit = true; }
    const tau = view === 'cockpit' ? 0.04 : 0.10;
    cam.x = approach(cam.x, tx, tau, dt); cam.y = approach(cam.y, ty, tau, dt); cam.z = approach(cam.z, tz, tau, dt);
    cam.yaw += wrapPi(yawT - cam.yaw) * (1 - Math.exp(-dt / (view === 'cockpit' ? 0.05 : 0.13)));
    cam.pitch = approach(cam.pitch, pitchT, 0.18, dt);
    cam.roll = approach(cam.roll, rollT, 0.22, dt);
    // 가감속에 따라 카메라가 앞뒤로 밀린다 (같은 스프링에 얹는다)
    const surgeT = clamp((p.a || 0) * -0.09, -0.45, 0.55);
    this.surge = approach(this.surge || 0, surgeT, 0.22, dt);
    // 속도에 따라 화각을 넓혀 속도감을 준다
    const fovT = (view === 'cockpit' ? 53 : 52) + 10 * clamp(p.v / 40, 0, 1);
    this.fov = approach(this.fov || fovT, fovT, 0.5, dt);
    Render.fov = this.fov * Math.PI / 180;
    // 노면 진동 — 빠를수록, 갓길에서는 더 크게
    const buzz = (p.v / 62) * (p.offRoad ? 3.2 : 0.5) * (view === 'cockpit' ? 1 : 0.45);
    if (buzz > 0.02) {
      cam.pitch += (Math.random() - 0.5) * 0.0016 * buzz;
      cam.roll += (Math.random() - 0.5) * 0.0022 * buzz;
    }
    // 충돌 흔들림
    this.shake = Math.max(0, (this.shake || 0) - dt * 1.8);
    if (this.shake > 0) {
      cam.yaw += (Math.random() - 0.5) * 0.02 * this.shake;
      cam.pitch += (Math.random() - 0.5) * 0.02 * this.shake;
    }
    this.sCam = sC;
  },

  /* ---------- 루프 ---------- */
  loop(ts) {
    const raw = (ts - this.last) / 1000;
    this.last = ts;
    const dt = Math.min(0.1, raw);
    this.frame++;

    if (!this.paused) {
      this.acc = (this.acc || 0) + dt * this.speedMul;
      let n = 0;
      if (this.auto) this.player.offRoad = false;
      while (this.acc >= DT && n < 16) {
        if (!this.auto) this.drivePlayer(DT);
        // 계산 대상 구간을 내 차 위치에 맞춘다
        this.corrA.focusS = this.player.s;
        if (this.corrB) this.corrB.focusS = this.corrA.L - this.player.s;
        this.corrA.step(DT, this.player);
        if (this.corrB) this.corrB.step(DT, { auto: true });
        this.simTime += DT; this.acc -= DT; n++;
      }
      if (this.acc > DT * 20) this.acc = 0;
      // 구간 끝에 닿으면 새 시드로 지형을 다시 짜 이어 달린다
      if (this.cfg.endless && this.corrA.playerWrapped) {
        this.corrA.playerWrapped = false;
        this.cfg.seed = (this.cfg.seed * 1103515245 + 12345) >>> 8;
        const keepV = this.player.v;
        this.rebuild();
        this.player.v = keepV;
        UI.toast('새 구간 — ' + this.roadSummary(), 5);
      }
      this.updateCam(dt);
    }

    this.render();
    UI.update(dt);
    if (this.showMap && this.frame % 3 === 0) UI.drawMap(this.mapCv, this);
    if (this.paused && this.frame % 30 === 0) UI.drawCharts();
    Sound.update(this);
    requestAnimationFrame((t) => this.loop(t));
  },

  render() {
    const p = this.player, c = this.corrA;
    const inTunnel = c.structA ? c.structA[c.jOf(p.s)] === 2 : false;
    Scene.draw(this.ctx, this.W, this.H, {
      road: this.road, corrA: this.corrA, corrB: this.corrB,
      cam: this.cam, sCam: c.roadS(this.sCam || p.s),
      timeOfDay: this.cfg.timeOfDay, weather: this.cfg.weather,
      inTunnel, time: this.simTime, sunAz: 0.9,
      hidePlayer: this.cfg.view === 'cockpit',
    });
    if (this.cfg.view === 'cockpit') this.dashboard();
  },

  /** 운전석 시점 — 보닛과 A필러.
      보닛이 화면 아래를 잡아 주면 속도가 몸으로 읽힌다. */
  dashboard() {
    const ctx = this.ctx, W = this.W, H = this.H;
    const p = this.player;
    // 조향·가감속에 따라 보닛이 아주 조금 흔들린다
    const tilt = (p.steer || 0) * W * 0.012;
    const bob = clamp((p.a || 0) * -0.004, -0.02, 0.02) * H;

    const top = H * 0.755 + bob;
    ctx.fillStyle = '#20242b';
    ctx.beginPath();
    ctx.moveTo(-W * 0.1, H + 2);
    ctx.lineTo(-W * 0.1, top + H * 0.05);
    ctx.quadraticCurveTo(W * 0.5 + tilt, top - H * 0.045, W * 1.1, top + H * 0.05);
    ctx.lineTo(W * 1.1, H + 2);
    ctx.closePath(); ctx.fill();
    // 보닛 반사 — 위쪽 가장자리를 밝게
    const g = ctx.createLinearGradient(0, top - H * 0.04, 0, top + H * 0.07);
    g.addColorStop(0, '#4a525f'); g.addColorStop(1, '#20242b00');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-W * 0.1, top + H * 0.05);
    ctx.quadraticCurveTo(W * 0.5 + tilt, top - H * 0.045, W * 1.1, top + H * 0.05);
    ctx.lineTo(W * 1.1, top + H * 0.10);
    ctx.quadraticCurveTo(W * 0.5 + tilt, top + H * 0.005, -W * 0.1, top + H * 0.10);
    ctx.closePath(); ctx.fill();
    // A 필러
    ctx.fillStyle = '#161a20';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W * 0.045, 0); ctx.lineTo(0, H * 0.46); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(W, 0); ctx.lineTo(W * 0.955, 0); ctx.lineTo(W, H * 0.46); ctx.closePath(); ctx.fill();
    // 루프 라인
    ctx.fillStyle = '#161a20';
    ctx.fillRect(0, 0, W, H * 0.022);
  },
};

/* =============================================================================
   Sound — 엔진·주행풍을 합성으로 만든다 (외부 음원 없음)
   ========================================================================== */
const Sound = {
  on: true, ready: false,
  arm() {
    if (this.ready || !this.on) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.on = false; return; }
    const ac = new AC(); this.ac = ac;
    this.master = ac.createGain(); this.master.gain.value = 0.0; this.master.connect(ac.destination);
    // 엔진 — 톱니파 두 개
    this.o1 = ac.createOscillator(); this.o1.type = 'sawtooth';
    this.o2 = ac.createOscillator(); this.o2.type = 'square';
    this.eg = ac.createGain(); this.eg.gain.value = 0.10;
    this.lp = ac.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 700;
    this.o1.connect(this.eg); this.o2.connect(this.eg); this.eg.connect(this.lp); this.lp.connect(this.master);
    // 주행풍 — 화이트노이즈 + 밴드패스
    const len = ac.sampleRate * 2;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = ac.createBufferSource(); this.noise.buffer = buf; this.noise.loop = true;
    this.bp = ac.createBiquadFilter(); this.bp.type = 'bandpass'; this.bp.frequency.value = 900; this.bp.Q.value = 0.6;
    this.ng = ac.createGain(); this.ng.gain.value = 0.0;
    this.noise.connect(this.bp); this.bp.connect(this.ng); this.ng.connect(this.master);
    this.o1.start(); this.o2.start(); this.noise.start();
    this.master.gain.linearRampToValueAtTime(0.5, ac.currentTime + 0.6);
    this.ready = true;
  },
  toggle() {
    this.on = !this.on;
    if (this.master) this.master.gain.value = this.on ? 0.5 : 0;
    UI.toast(this.on ? '소리 켬' : '소리 끔', 1.4);
  },
  update(app) {
    if (!this.ready || !this.on) return;
    const p = app.player, t = this.ac.currentTime;
    const v = p.v;
    // 가상 변속: 속도를 5단으로 나눠 회전수를 만든다
    const gear = clamp(Math.floor(v / 9), 0, 4);
    const rpm = 55 + (v - gear * 9) * 13 + (p.throttle || 0) * 22;
    this.o1.frequency.setTargetAtTime(rpm, t, 0.08);
    this.o2.frequency.setTargetAtTime(rpm * 0.5, t, 0.08);
    this.eg.gain.setTargetAtTime(0.035 + (p.throttle || 0) * 0.075, t, 0.15);
    this.lp.frequency.setTargetAtTime(420 + v * 12, t, 0.2);
    this.ng.gain.setTargetAtTime(clamp(v / 46, 0, 1) * 0.11 + (p.offRoad ? 0.10 : 0), t, 0.12);
    // 터널 안에서는 소리가 갇힌다
    const tun = app.corrA.structA && app.corrA.structA[app.corrA.jOf(p.s)] === 2;
    this.bp.frequency.setTargetAtTime(tun ? 420 : 900, t, 0.3);
  },
};

addEventListener('DOMContentLoaded', () => App.init());
