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
  phantomSeed: false,
  jamMemory: 0.25,     // 정체 기억 세기 — 정체를 겪은 뒤 차두시간 증가율 (용량 저하)
  initJam: 0,          // 시작할 때 전방에 깔아 두는 유령정체 길이 m (0 = 없음)   // 유령정체 프리셋에서 구조물 접근부 초기 교란을 강제
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
  bridgeShare: -10,    // 구조물 중 교량 비율 % (음수 = 지형대로)
  view: 'cockpit',     // cockpit | chase | high
  gfx: false,          // 그래픽 향상 (셰이더 후처리 · 표면 잔결) — WebGL 일 때만
};

const WB = 2.75;                       // 축거 m
const MU = { dry: 0.88, rain: 0.62 };  // 노면 마찰

const App = {
  cfg: Object.assign({}, CFG_DEFAULT),
  paused: false, dirty: false, frame: 0, simTime: 0, speedMul: 1,
  auto: false, showMap: true,

  init() {
    this.cv = document.getElementById('view');
    /* 3D 는 WebGL(깊이 버퍼)로 그린다. 하늘·원경은 아래 2D 캔버스, 비·보닛 같은 효과는 위 2D 캔버스.
       WebGL 을 못 쓰는 기기는 예전처럼 한 장의 캔버스 2D 로 그린다. ?gl=0 으로 강제할 수 있다. */
    this.skyCv = document.getElementById('sky');
    this.glCv = document.getElementById('gl');
    const wantGL = !/[?&]gl=0/.test(location.search);
    if (wantGL && Render.initGL(this.glCv)) {
      document.body.classList.add('gl');
      this.skyCtx = this.skyCv.getContext('2d', { alpha: false });
      this.ctx = this.cv.getContext('2d', { alpha: true });
      Render.onLost = () => {           // 문맥을 잃으면 캔버스 2D 로 계속 달린다
        document.body.classList.remove('gl');
        this.skyCtx = null;
        UI.toast && UI.toast('그래픽 가속을 잃어 기본 렌더로 전환했습니다', 4);
      };
    } else {
      this.ctx = this.cv.getContext('2d', { alpha: false });
    }
    this.mapCv = document.getElementById('mapCv');
    if (/[?&]fx=1/.test(location.search)) this.cfg.gfx = true;
    Render.skyCanvas = this.skyCv;
    Render.enhance = !!(this.cfg.gfx && Render.gl);
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
    const dpr = Math.min(devicePixelRatio || 1, 2) * (this.res || 1);
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    this.cv.width = Math.max(320, Math.round(w * dpr));
    this.cv.height = Math.max(240, Math.round(h * dpr));
    for (const c of [this.skyCv, this.glCv]) if (c) { c.width = this.cv.width; c.height = this.cv.height; }
    this.W = this.cv.width; this.H = this.cv.height;
    // 화면이 크면 묘사 거리를 줄여 프레임을 지킨다
    this.qBase = this.W > 1900 ? 0.82 : 1;
    Render.quality = Math.min(Render.quality || 1, this.qBase);
  },

  /* 성능 자동 조절 — 느린 기기에서 프레임을 지킨다.
     프레임 시간(지수평균)이 25 ms 를 넘으면 먼저 묘사 거리를, 그래도 느리면 렌더 해상도를
     낮춘다. 14 ms 아래로 여유가 생기면 천천히 되돌린다. 2 초마다 한 단계씩만 움직여
     화질이 깜빡이지 않게 한다. */
  adapt(raw) {
    if (!(raw > 0) || raw > 0.25) return;                 // 탭 전환·일시정지 직후는 무시
    this.fMs = this.fMs ? this.fMs * 0.94 + raw * 1000 * 0.06 : raw * 1000;
    this.adaptT = (this.adaptT || 0) + raw;
    if (this.adaptT < 2) return;
    this.adaptT = 0;
    const q = Render.quality, res = this.res || 1;
    if (this.fMs > 25) {
      if (q > 0.62) Render.quality = Math.max(0.6, q - 0.1);
      else if (res > 0.62) { this.res = Math.max(0.6, res - 0.15); this.resize(); }
    } else if (this.fMs < 14) {
      if (res < 1) { this.res = Math.min(1, res + 0.1); this.resize(); }
      else if (q < this.qBase) Render.quality = Math.min(this.qBase, q + 0.05);
    }
  },

  /* ---------- 세계 재생성 ---------- */
  rebuild() {
    const c = this.cfg;
    this.road = new Road({
      seed: c.seed | 0, length: c.length,
      terrain: { relief: c.relief, density: c.density, ruggedness: c.ruggedness },
      tunnelSep: c.tunnelSep, icSpacing: c.icSpacing,
      bridgeShare: c.bridgeShare >= 0 ? c.bridgeShare / 100 : null,
    });
    this.corrA = new Corridor(this.road, 1, c, (c.seed | 0) * 7 + 1);
    this.corrB = c.twoWay ? new Corridor(this.road, -1, c, (c.seed | 0) * 7 + 2) : null;
    this.simTime = 0; this.dirty = false;
    this.makePlayer();
    // 전체 노선을 설정 수요로 채우고, 짧게 돌려 초기 교통류를 안정시킨다
    this.corrA.prefill(); if (this.corrB) this.corrB.prefill();
    this.warm(30);
    // 안정화 뒤 시설 상류에서 확률적으로 교란을 시작한다. 프리셋은 발생을 보장한다.
    this.corrA.seedFeaturePhantomJams(c.phantomSeed);
    if (this.corrB) this.corrB.seedFeaturePhantomJams(c.phantomSeed);
    UI.toast(this.roadSummary(), 5);
    if (c.initJam > 0) this.makeJam(c.initJam, 2600);
  },
  /** 전방 ahead m 지점에 머리를 둔 길이 len 의 유령정체를 만든다 (반대편 차도에도 같은 거리에) */
  makeJam(len, ahead) {
    const p = this.player;
    const n = this.corrA.seedWideJam(p.s + ahead, len);
    if (this.corrB) this.corrB.seedWideJam(this.corrB.L - p.s + ahead * 0.6, len);
    UI.toast(`전방 ${fmt1(ahead / 1000)} km 에 유령정체 ${fmt1(len / 1000)} km (${n}대) — 상류로 밀려 내려온다`, 4);
  },
  roadSummary() {
    const r = this.road;
    const br = r.structs.filter(s => s.type === 'bridge').length;
    const tu = r.structs.filter(s => s.type === 'tunnel').length;
    let minR = Infinity;
    for (let i = 0; i < r.n; i++) { const k = Math.abs(r.K[i]); if (k > 1e-7 && 1 / k < minR) minR = 1 / k; }
    let mg = 0; for (let i = 0; i < r.n; i++) mg = Math.max(mg, Math.abs(r.grade[i]));
    let lb = 0, lt = 0; for (const st of r.structs) if (st.type === 'bridge') lb += st.len; else lt += st.len;
    const ratio = lb + lt > 0 ? ` (길이 ${Math.round(100 * lb / (lb + lt))}:${Math.round(100 * lt / (lb + lt))})` : '';
    return `노선 생성 — ${fmt1(r.len / 1000)}km · ${this.cfg.lanes}차로 · 교량 ${br} · 터널 ${tu}${ratio} · IC ${r.ics.length}` +
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
    p.auto = this.auto;       // 새 구간으로 넘어가도 자율주행·관전 상태를 잇는다
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
    if (key === 'gfx') {
      if (!Render.gl) { UI.toast('그래픽 향상은 WebGL 이 켜져 있을 때만 쓸 수 있습니다', 3); return; }
      Render.enhance = !!this.cfg.gfx;
      if (Render.enhance && !Render.initFx()) { Render.enhance = false; UI.toast('이 기기에서는 그래픽 향상 셰이더를 쓸 수 없습니다', 3); return; }
      UI.toast(Render.enhance ? '그래픽 향상 켬 — 표면 질감 · 블룸 · FXAA · 색 보정' : '그래픽 향상 끔', 2.5);
    }
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
    this.corrA.prefill(); if (this.corrB) this.corrB.prefill();
    this.warm(25);
    this.corrA.seedFeaturePhantomJams(c.phantomSeed);
    if (this.corrB) this.corrB.seedFeaturePhantomJams(c.phantomSeed);
  },

  /* ---------- 프리셋 ---------- */
  preset(name) {
    const c = this.cfg;
    const set = (o) => { Object.assign(c, o); for (const inp of $$('[data-cfg]')) { const k = inp.dataset.cfg; if (inp.type === 'checkbox') inp.checked = !!c[k]; else inp.value = c[k]; const out = inp.parentElement.querySelector('.val'); if (out) out.textContent = UI.fmtCfg(k, c[k]); } };
    switch (name) {
      case 'free':
        set({ demand: 900, rampPct: 8, incidentRate: 0, peak: false, noise: 1.0, reactionTime: 0.5, phantomSeed: false, jamMemory: 0.25, initJam: 0 });
        this.rebuild(); UI.toast('자유류 — 수요 900대/시/차로', 3); return;
      case 'near':
        set({ demand: 1700, rampPct: 12, incidentRate: 0, peak: false, noise: 1.0, reactionTime: 0.5, phantomSeed: false, jamMemory: 0.25, initJam: 0 });
        this.rebuild(); UI.toast('임계 상태 — 수요와 램프 합류로 작은 파동을 관찰', 4); return;
      case 'phantom':
        set({ demand: 1950, rampPct: 0, incidentRate: 0, peak: false, noise: 1.6, reactionTime: 0.8, phantomSeed: true, jamMemory: 0.3, initJam: 800 });
        this.rebuild(); UI.toast('유령정체 — 한 대의 가벼운 브레이크가 정지파로 자라 상류로 번진다', 4); return;
      case 'longjam':
        set({ demand: 2100, rampPct: 10, incidentRate: 0, peak: false, noise: 1.3, reactionTime: 0.7, phantomSeed: true, jamMemory: 0.55, initJam: 1500 });
        this.rebuild(); UI.toast('긴 유령정체 — 빠져나가는 양이 들어오는 양보다 적어 정체가 길어진다', 4.5); return;
      case 'jam':
        set({ demand: 2100, rampPct: 20, incidentRate: 0.4, peak: false, noise: 1.0, reactionTime: 0.5, phantomSeed: false, jamMemory: 0.25, initJam: 0 });
        this.rebuild(); UI.toast('혼잡 — 과포화 유입과 합류 병목', 4); return;
      case 'peak':
        set({ demand: 1400, rampPct: 16, incidentRate: 0.3, peak: true, noise: 1.0, reactionTime: 0.5, phantomSeed: false, jamMemory: 0.25, initJam: 0 });
        this.rebuild(); UI.toast('첨두 — 수요가 용량을 넘었다가 되돌아온다', 4); return;
      case 'rain': set({ weather: 'rain', timeOfDay: 'dusk', demand: 1600, phantomSeed: false }); UI.toast('우천 — 희망속도·차두시간이 나빠진다', 4); break;
      case 'night': set({ timeOfDay: 'night', demand: 800, phantomSeed: false }); UI.toast('야간 — 통행량이 적다', 3); break;
      case 'plain': set({ relief: 12, density: 20, ruggedness: 15 }); this.rebuild(); UI.toast('평야부 — 길게 뻗은 완만한 선형', 3.5); return;
      case 'hill': set({ relief: 45, density: 45, ruggedness: 40 }); this.rebuild(); UI.toast('구릉지 — 완만한 굽이와 짧은 터널', 3.5); return;
      case 'mount': set({ relief: 82, density: 72, ruggedness: 78 }); this.rebuild(); UI.toast('산악부 — 최소반경에 가까운 굽이, 긴 터널과 교량', 4); return;
    }
    this.corrA.rebuildCaps(); if (this.corrB) this.corrB.rebuildCaps();
    UI.togglePanel(false);
  },

  action(a) {
    switch (a) {
      case 'auto':
        if (this.spec) {   // 관전 중에는 내 차를 자율주행으로 묶어 두고, 복귀 후 상태만 바꾼다
          this.spec.wasAuto = !this.spec.wasAuto;
          UI.toast('관전을 마치면 ' + (this.spec.wasAuto ? '자율주행' : '수동 운전') + '으로 돌아갑니다', 2.5); break;
        }
        this.auto = !this.auto; this.player.auto = this.auto;
        UI.toast(this.auto ? '자율주행 — 이 차도 IDM·MOBIL 로 달린다' : '수동 운전', 2.5); break;
      case 'spectate':
        if (this.spec) this.exitSpectate();
        else this.spectate(this.player.s + 80, true);
        break;
      case 'cam': {
        if (this.spec) { this.exitSpectate(); break; }
        const order = ['chase', 'cockpit', 'high'];
        this.cfg.view = order[(order.indexOf(this.cfg.view) + 1) % order.length];
        UI.toast({ chase: '추적 시점', cockpit: '운전석 시점', high: '상공 시점' }[this.cfg.view], 1.6); break;
      }
      case 'incident': {
        // 관전 중이면 관전 지점 앞 250 m 에 낸다 — 정체가 눈앞에서 자라는 것을 본다
        const s = this.spec ? this.spec.s + 250 : this.player.s + 900;
        if (s < this.corrA.L - 500) {
          const inc = this.corrA.addIncident({ laneBlock: true, s, lane: this.corrA.rng.int(0, this.corrA.nLane - 1) });
          UI.toast((this.spec ? '관전 지점 앞 250m ' : '전방 900m ') + (inc.lane + 1) + '차로 차단 사고 발생', 4);
        }
        break;
      }
      case 'phantomjam': this.makeJam(Math.max(this.cfg.initJam, 1000), 1800); break;
      case 'map': this.showMap = !this.showMap; this.mapCv.style.display = this.showMap ? '' : 'none'; break;
      case 'speed': this.speedMul = this.speedMul >= 4 ? 1 : this.speedMul * 2;
        UI.toast('모의 배속 ' + this.speedMul + '배', 1.6); break;
      case 'reset': if (this.spec) this.exitSpectate(); else this.resetPlayer(); break;
      case 'specPrev': this.specJump(-1); break;
      case 'specNext': this.specJump(1); break;
      case 'specZoomIn': if (this.spec) this.spec.dist = clamp(this.spec.dist / 1.5, 6, 420); break;
      case 'specZoomOut': if (this.spec) this.spec.dist = clamp(this.spec.dist * 1.5, 6, 420); break;
      case 'specTop':   // 낮게 옆에서 → 비스듬히 → 거의 수직으로 내려다보기, 를 돌아가며
        if (this.spec) { const P = [-0.15, -0.45, -1.3]; const i = P.findIndex(v => v < this.spec.pitch - 0.05); this.spec.pitch = P[i < 0 ? 0 : i]; }
        break;
      case 'specTurn': if (this.spec) this.spec.yawRel = wrapPi(this.spec.yawRel + Math.PI); break;
    }
    this.syncButtons();
  },
  syncButtons() {
    const ba = document.querySelector('[data-act="auto"]'); if (ba) ba.classList.toggle('on', this.auto);
    const bv = document.querySelector('[data-act="spectate"]'); if (bv) bv.classList.toggle('on', !!this.spec);
    document.body.classList.toggle('spec', !!this.spec);
    const bs = document.querySelector('[data-act="speed"]'); if (bs) bs.textContent = '배속 ×' + this.speedMul;
  },

  /* ---------- 관전 모드 ----------
     도로 위 한 지점(본선 중앙분리대 위)을 초점으로 두고, 그 둘레를 도는 카메라로 교통류를 본다.
     내 차는 그동안 자율주행으로 계속 달리고, 모의는 전 구간에서 그대로 돈다.
     초점은 corrA(내 차 진행방향) 국소 좌표 s 로 둔다 — 지도와 같은 좌표다. */
  spectate(s, fromCar) {
    const c = this.corrA;
    s = clamp(s, 60, c.L - 60);
    if (!this.spec) {
      this.spec = {
        s, yawRel: fromCar ? 0.0 : 0.75, pitch: fromCar ? -0.22 : -0.42, dist: fromCar ? 45 : 90,
        wasAuto: this.auto,
      };
      this.auto = true; this.player.auto = true;
      this.key = {}; this.specInit = false;
      UI.toast('관전 모드 — 드래그 회전 · 휠 확대 · W/S 이동 · [ ] 시설 이동 · 지도 클릭 · V 복귀', 5);
    } else {
      this.spec.s = s;
    }
    this.specLabel();
    this.syncButtons();
  },
  exitSpectate() {
    if (!this.spec) return;
    this.auto = this.spec.wasAuto; this.player.auto = this.auto;
    this.spec = null; this.camInit = false; this.key = {};
    UI.toast('내 차로 돌아왔습니다', 1.8);
    this.syncButtons();
  },
  /** 관전 지점을 앞뒤의 시설(IC · 터널 · 교량 · 돌발상황)로 옮긴다 */
  specJump(dir) {
    if (!this.spec) { this.spectate(this.player.s + 80, true); return; }
    const c = this.corrA, pts = [];
    for (const ic of c.icLocal) pts.push({ s: ic.s, name: ic.name });
    for (const st of this.road.structs) {
      const a = c.dir > 0 ? st.s0 : c.L - st.s1, b = c.dir > 0 ? st.s1 : c.L - st.s0;
      pts.push({ s: a - 40, name: (st.name || (st.type === 'tunnel' ? '터널' : '교량')) + ' 입구' });
      if (st.type === 'tunnel') pts.push({ s: b + 30, name: (st.name || '터널') + ' 출구' });
    }
    for (const inc of c.incidents) pts.push({ s: inc.s - 60, name: '돌발상황 · ' + inc.kind });
    pts.sort((a, b) => a.s - b.s);
    const cur = this.spec.s;
    let pick = null;
    if (dir > 0) { for (const p of pts) if (p.s > cur + 5) { pick = p; break; } }
    else { for (let i = pts.length - 1; i >= 0; i--) if (pts[i].s < cur - 5) { pick = pts[i]; break; } }
    if (!pick) { UI.toast(dir > 0 ? '앞쪽에 더 이상 시설이 없습니다' : '뒤쪽에 더 이상 시설이 없습니다', 1.6); return; }
    this.spec.s = clamp(pick.s, 60, c.L - 60);
    UI.toast('관전 지점 — ' + pick.name + ' (' + fmt1(this.spec.s / 1000) + ' km)', 2.2);
  },
  specLabel() {
    if (this.spec) UI.toast('관전 지점 ' + fmt1(this.spec.s / 1000) + ' km', 1.4);
  },

  /** 관전 카메라 — 초점 둘레의 궤도. 키 입력은 실제 경과 시간(rawDt)으로 받는다. */
  updateSpecCam(dt) {
    const sp = this.spec, c = this.corrA, rd = this.road, k = this.key;
    sp.s = clamp(sp.s, 60, c.L - 60);
    // 키 조작: W/S 도로를 따라 이동, A/D 회전, Q/E 확대·축소, R/F 고개 (Shift 빠르게)
    const fast = k.shift ? 4 : 1;
    const mv = (k.w || k.arrowup ? 1 : 0) - (k.s || k.arrowdown ? 1 : 0);
    if (mv) sp.s = clamp(sp.s + mv * dt * fast * (25 + sp.dist * 0.8), 60, c.L - 60);
    const rot = (k.d || k.arrowright ? 1 : 0) - (k.a || k.arrowleft ? 1 : 0);
    sp.yawRel = wrapPi(sp.yawRel - rot * dt * 1.2);
    const zm = (k.e ? 1 : 0) - (k.q ? 1 : 0);
    if (zm) sp.dist = clamp(sp.dist * Math.exp(-zm * dt * 1.4), 6, 420);
    const tl = (k.f ? 1 : 0) - (k.t ? 1 : 0);
    if (tl) sp.pitch = clamp(sp.pitch - tl * dt * 0.8, -1.45, -0.02);

    const g = c.geo(sp.s);
    const fwd = g.hdg + (c.dir > 0 ? 0 : Math.PI);
    const inTun = c.structA && c.structA[c.jOf(sp.s)] === 2;
    const nx = Math.sin(g.hdg), ny = -Math.cos(g.hdg);
    /* 초점은 보통 중앙분리대 위(양방향이 함께 보인다). 쌍굴에서는 두 굴이 갈라져 그 자리가
       암반 속이므로, 내 차 진행방향 굴의 차도 한가운데로 옮긴다. */
    const half = c.outerEdge() * 0.5;
    const uF = inTun ? (c.dir > 0 ? g.med + half : -(g.med + half)) : 0;
    const fx = g.x + nx * uF, fy = g.y + ny * uF, fz = g.z + rd.crossZ(g, uF) + 1.2;
    let yaw = fwd + sp.yawRel, dist = sp.dist, pitch = sp.pitch;
    if (inTun) { dist = Math.min(dist, 40); pitch = Math.max(pitch, -0.35); }
    const cp = Math.cos(pitch);
    let tx = fx - Math.cos(yaw) * cp * dist, ty = fy - Math.sin(yaw) * cp * dist;
    let tz = fz - Math.sin(pitch) * dist;
    if (inTun) {
      // 굴 안에서는 굴 단면 안에 머문다 — 옆으로는 차도 폭만큼, 위로는 천장 아래까지
      const lat = (tx - fx) * nx + (ty - fy) * ny;
      const lim = half - 0.5;
      if (Math.abs(lat) > lim) { const d = (Math.abs(lat) - lim) * sgn(lat); tx -= nx * d; ty -= ny * d; }
      tz = Math.min(tz, g.z + RoadStd.tunnelH - 1.4);
    } else {
      tz = Math.max(tz, Math.max(rd.terrain(tx, ty), rd.waterZ) + 2.5);
    }
    // 위치가 땅에 밀려 올라가도 시선은 늘 초점을 향한다
    const dx = fx - tx, dy = fy - ty, dz = fz - tz;
    const yawT = Math.atan2(dy, dx), pitchT = Math.atan2(dz, Math.hypot(dx, dy));

    const cam = this.cam;
    // 처음 들어올 때와 멀리 건너뛸 때는 바로 옮긴다 — 산을 뚫고 날아가는 모습을 보이지 않는다
    if (!this.camInit || !this.specInit || Math.hypot(cam.x - tx, cam.y - ty) > 600) {
      cam.x = tx; cam.y = ty; cam.z = tz; cam.yaw = yawT; cam.pitch = pitchT; cam.roll = 0;
      this.camInit = true; this.specInit = true;
    }
    const tau = 0.08;
    cam.x = approach(cam.x, tx, tau, dt); cam.y = approach(cam.y, ty, tau, dt); cam.z = approach(cam.z, tz, tau, dt);
    cam.yaw += wrapPi(yawT - cam.yaw) * (1 - Math.exp(-dt / tau));
    cam.pitch = approach(cam.pitch, pitchT, tau, dt);
    cam.roll = approach(cam.roll, 0, 0.2, dt);
    this.fov = approach(this.fov || 55, 55, 0.4, dt);
    Render.fov = this.fov * Math.PI / 180;
    this.sCam = sp.s;
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
      if (k === 'v') this.action('spectate');
      else if (k === '[') this.action('specPrev');
      else if (k === ']') this.action('specNext');
      else if (k === 'c') this.action('cam');
      else if (k === 'p') this.action('auto');
      else if (k === 'i') this.action('incident');
      else if (k === 'm') this.action('map');
      else if (k === 'j') this.action('phantomjam');
      else if (k === 'escape' || k === 'tab') { e.preventDefault(); UI.togglePanel(!this.paused); }
      else if (k === 'r') this.action('reset');
      else if (k === 'x') this.action('speed');
      else if (k === 'n') Sound.toggle();
      if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
    });
    addEventListener('keyup', (e) => { this.key[e.key.toLowerCase()] = 0; });
    addEventListener('blur', () => { this.key = {}; });
    this.cv.addEventListener('pointerdown', () => Sound.arm());

    // 관전 카메라 — 화면을 끌어 돌리고, 휠로 당기고 민다
    let drag = null;
    this.cv.addEventListener('pointerdown', (e) => {
      if (!this.spec) return;
      drag = { x: e.clientX, y: e.clientY };
      this.cv.setPointerCapture(e.pointerId);
    });
    this.cv.addEventListener('pointermove', (e) => {
      if (!drag || !this.spec) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      this.spec.yawRel = wrapPi(this.spec.yawRel - dx * 0.006);
      this.spec.pitch = clamp(this.spec.pitch - dy * 0.005, -1.45, -0.02);
    });
    const end = () => { drag = null; };
    this.cv.addEventListener('pointerup', end);
    this.cv.addEventListener('pointercancel', end);
    this.cv.addEventListener('wheel', (e) => {
      if (!this.spec) return;
      e.preventDefault();
      this.spec.dist = clamp(this.spec.dist * Math.exp(e.deltaY * 0.0012), 6, 420);
    }, { passive: false });

    // 지도를 누르면 그 지점에서 관전한다 (누른 채로 끌면 지점이 따라간다)
    const mapS = (e) => {
      const cv = this.mapCv, r = cv.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * cv.width;
      return clamp((x - 4) / (cv.width - 8), 0, 1) * this.corrA.L;
    };
    let mapDrag = false;
    this.mapCv.addEventListener('pointerdown', (e) => {
      Sound.arm();
      mapDrag = true; this.mapCv.setPointerCapture(e.pointerId);
      this.spectate(mapS(e), false);
    });
    this.mapCv.addEventListener('pointermove', (e) => { if (mapDrag && this.spec) this.spec.s = clamp(mapS(e), 60, this.corrA.L - 60); });
    const mEnd = () => { if (mapDrag) { mapDrag = false; this.specLabel(); } };
    this.mapCv.addEventListener('pointerup', mEnd);
    this.mapCv.addEventListener('pointercancel', mEnd);
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
    const p = this.player, c = this.corrA, rd = this.road;
    /* 상공 시점도 굴 안에서는 추적 시점 높이로 내려온다 — 굴 천장 높이에서 아래를 내려다보면
       굴 벽과 산 옆면만 화면을 채웠다. 다시 밖으로 나오면 같은 스프링으로 부드럽게 올라간다. */
    const inTun = c.structA && (c.structA[c.jOf(p.s)] === 2 || c.structA[c.jOf(Math.max(0, p.s - 30))] === 2);
    const view = this.cfg.view === 'high' && inTun ? 'chase' : this.cfg.view;
    const back = (view === 'cockpit' ? 0.35 : view === 'chase' ? 8.2 : 30) + (this.surge || 0);
    const up = view === 'cockpit' ? 1.22 : view === 'chase' ? 2.3 : 16;
    const sC = p.s - back;
    const g = c.geo(sC);
    const u = c.dir > 0 ? (g.med + p.u) : -(g.med + p.u);
    const nx = Math.sin(g.hdg), ny = -Math.cos(g.hdg);
    const tx = g.x + nx * u * (view === 'high' ? 0.5 : 1);
    const ty = g.y + ny * u * (view === 'high' ? 0.5 : 1);
    let tz = g.z + rd.crossZ(g, u) + up;
    /* 상공·추적 시점 카메라가 산속에 묻히지 않게 한다. 굴 안이면 천장 아래로, 땅 위면 지면 위로.
       ★ 그대로 두면 터널 출구 근처에서 카메라가 산 안에 들어가 화면이 지형 면으로 뒤덮였다. */
    if (view !== 'cockpit') {
      if (c.structA && c.structA[c.jOf(sC)] === 2) tz = Math.min(tz, g.z + RoadStd.tunnelH - 1.4);
      else tz = Math.max(tz, Math.max(rd.terrain(tx, ty), rd.waterZ) + 2.5);
    }
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
    if (!this.paused) this.adapt(raw);

    if (!this.paused) {
      this.acc = (this.acc || 0) + dt * this.speedMul;
      let n = 0;
      if (this.auto) this.player.offRoad = false;
      while (this.acc >= DT && n < 16) {
        if (!this.auto) this.drivePlayer(DT);
        // 플레이어 위치와 무관하게 전체 구간의 교통류를 계속 계산한다
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
      if (this.spec) this.updateSpecCam(dt); else this.updateCam(dt);
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
    const sp = this.spec;
    let inTunnel = c.structA ? c.structA[c.jOf(sp ? sp.s : p.s)] === 2 : false;
    // 관전 카메라가 굴 위로 떠 있으면 굴 밖 풍경으로 그린다
    if (sp && inTunnel) { const g = c.geo(sp.s); inTunnel = this.cam.z < g.z + RoadStd.tunnelH; }
    Scene.draw(this.ctx, this.W, this.H, {
      road: this.road, corrA: this.corrA, corrB: this.corrB,
      cam: this.cam, sCam: c.roadS(this.sCam || p.s),
      timeOfDay: this.cfg.timeOfDay, weather: this.cfg.weather,
      inTunnel, time: this.simTime, sunAz: 0.9,
      hidePlayer: !sp && this.cfg.view === 'cockpit',
      spectate: !!sp, specR: sp ? Render.drawDist * 0.7 + sp.dist : 0,
      skyCtx: this.skyCtx,
    });
    if (!sp && this.cfg.view === 'cockpit') this.dashboard();
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
    this.eg.gain.setTargetAtTime(app.spec ? 0 : 0.035 + (p.throttle || 0) * 0.075, t, 0.15);
    this.lp.frequency.setTargetAtTime(420 + v * 12, t, 0.2);
    this.ng.gain.setTargetAtTime(app.spec ? 0.03 : clamp(v / 46, 0, 1) * 0.11 + (p.offRoad ? 0.10 : 0), t, 0.12);
    // 터널 안에서는 소리가 갇힌다
    const tun = app.corrA.structA && app.corrA.structA[app.corrA.jOf(p.s)] === 2;
    this.bp.frequency.setTargetAtTime(tun ? 420 : 900, t, 0.3);
  },
};

addEventListener('DOMContentLoaded', () => App.init());
