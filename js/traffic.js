/* =============================================================================
   traffic.js — 미시 교통류 모델

   차두 추종 : IDM (Intelligent Driver Model)
       Treiber, Hennecke & Helbing (2000), "Congested traffic states in
       empirical observations and microscopic simulations", Phys. Rev. E 62, 1805.
         dv/dt = a [ 1 - (v/v0)^delta - (s*(v,dv)/s)^2 ]
         s*(v,dv) = s0 + max(0, v T + v dv / (2 sqrt(a b)))

   확률 가속 : Ornstein-Uhlenbeck 잡음 항 (Treiber & Kesting 2013, 11.3.4절)
       결정론적 IDM 만으로는 실측만큼 정체파가 잘 생기지 않는다. 유색잡음을
       더하면 임계밀도 부근에서 stop-and-go 파가 자발적으로 형성된다.

   지각 지연 : 반응시간 만큼 지연된 선행차 상태를 참조 (Human Driver Model,
       Treiber, Kesting & Helbing (2006), Physica A 360, 71).

   차로 변경 : MOBIL (Minimizing Overall Braking Induced by Lane changes)
       Kesting, Treiber & Helbing (2007), TRR 1999, 86.
         안전  : a_new_follower > -b_safe
         유인  : da_self + p (da_new_follower + da_old_follower) > da_th + bias
       bias 에 우측주행 원칙(지정차로제)과 강제 차로변경 압력을 싣는다.

   차로변경 후 완화 : 합류 직후에는 희망 차두시간을 줄였다가 회복시킨다
       (Laval & Leclercq 2008 의 relaxation) — 없으면 합류부 용량이 과소평가된다.

   동력 한계 : 엔진출력·구름저항·공기저항·종단경사를 반영해 자유가속을 제한한다.
       중차량이 오르막에서 기어 다니며 이동 병목(moving bottleneck)을 만든다.
   ========================================================================== */
'use strict';

/* 차종 제원
   기본값은 Treiber & Kesting (2013) Table 11.2.
   희망 차두시간 T 는 도로용량편람(2013)의 기본구간 용량 2,200 승용차/시/차로에
   맞춰 재보정했다. 표의 대표값 1.5 s 를 그대로 쓰면 IDM 평형해의 용량이
   1,700 대/시/차로 수준에 그쳐 실측과 맞지 않는다. */
const VCLASS = {
  car: {
    key: 'car', name: '승용차', share: 0.85,
    len: 4.70, wid: 1.83, hei: 1.46, mass: 1500, power: 110e3, CdA: 0.66, Cr: 0.010,
    v0: 122 * KMH, T: 0.98, s0: 1.9, a: 1.55, b: 2.00, delta: 4,
    politeness: 0.25, aNoise: 0.24, pce: 1.0, heavy: false,
  },
  bus: {
    key: 'bus', name: '버스', share: 0.05,
    len: 12.0, wid: 2.50, hei: 3.35, mass: 15000, power: 235e3, CdA: 4.80, Cr: 0.008,
    v0: 101 * KMH, T: 1.25, s0: 2.5, a: 0.95, b: 1.70, delta: 4,
    politeness: 0.35, aNoise: 0.16, pce: 1.5, heavy: true,
  },
  truck: {
    key: 'truck', name: '화물차', share: 0.10,
    len: 16.70, wid: 2.50, hei: 4.00, mass: 32000, power: 340e3, CdA: 6.20, Cr: 0.007,
    v0: 90 * KMH, T: 1.50, s0: 3.0, a: 0.75, b: 1.50, delta: 4,
    politeness: 0.40, aNoise: 0.14, pce: 1.5, heavy: true,
  },
};

/* 한국 승용차 차체색 분포에 가깝게 */
const CAR_COLORS = [
  ['#e9eaec', 32], ['#8d9299', 17], ['#26282c', 19], ['#b6bcc4', 11],
  ['#2f4f8a', 7], ['#8e2c2c', 5], ['#2c5c46', 3], ['#7a5a2c', 3], ['#c8892a', 3],
];
const TRUCK_COLORS = [['#e6e8ea', 40], ['#2a4a86', 20], ['#9aa1a8', 15], ['#8f2f2f', 10], ['#2f6b4a', 8], ['#c9a227', 7]];
const BUS_COLORS = [['#e8e9ec', 35], ['#2b5ea8', 25], ['#1f7a52', 15], ['#9c2b2b', 12], ['#d8a72a', 13]];

/* 차종별 파생 상수 — 매 스텝 나눗셈을 피하려고 미리 접어 둔다 */
for (const k in VCLASS) {
  const p = VCLASS[k];
  p.powEff = 0.9 * p.power / p.mass;      // 구동효율 반영 출력/질량
  p.dragK = 0.5 * RHO * p.CdA / p.mass;   // 공기저항 계수
  p.CrG = GRAV * p.Cr;                    // 구름저항 가속도
}

const MOBIL = { bSafe: 4.0, dAth: 0.20, biasRight: 0.30 };
const DT = 0.04;                 // 물리 적분 간격 (s)
const NOISE_K = Math.sqrt(2 * DT / 6);   // OU 잡음 확산항 계수 (tau = 6 s)
const U_LERP = 1 - Math.exp(-DT / 0.62);  // 횡방향 접근 계수
const HIST = 48;                 // 지각지연용 이력 버퍼 길이 (48 * 0.04 = 1.92 s)
const RAMP_LEN = 340;            // 램프 연장 (m)
const RAMP_OFF = 33;             // 램프 종점의 본선 이격 (m)
const SIM_BACK = 1100;           // 플레이어 뒤로 계산할 거리 (m)
const SIM_AHEAD = 3200;          // 플레이어 앞으로 계산할 거리 (m)

let _vid = 1;

class Vehicle {
  constructor() { this.hs = new Float32Array(HIST); this.hv = new Float32Array(HIST); }
  init(cls, rng, cfg) {
    this.id = _vid++;
    this.cls = cls; this.p = VCLASS[cls];
    const p = this.p;
    this.len = p.len; this.wid = p.wid; this.hei = p.hei;
    // 희망속도: 개인차(표준편차 10%) x 제한속도 준수도
    const comp = clamp(rng.normal(1.08, 0.07), 0.90, 1.30);
    this.v0own = Math.max(15, p.v0 * clamp(rng.normal(1, 0.10), 0.75, 1.30));
    this.v0lim = cfg.limit * KMH * comp;
    this.Tbase = Math.max(0.5, p.T * clamp(rng.normal(1, 0.12), 0.65, 1.5));
    this.aggr = clamp(rng.normal(1, 0.15), 0.6, 1.5);   // 공격성 — 가속·차로변경 성향
    this.sqrtAB = Math.sqrt(p.a * this.aggr * p.b);
    this.color = rng.weighted(cls === 'car' ? CAR_COLORS : cls === 'truck' ? TRUCK_COLORS : BUS_COLORS);
    this.s = 0; this.v = 0; this.a = 0; this.u = 0; this.uT = 0;
    this.lane = 0; this.laneT = 0; this.yawRel = 0;
    this.eta = 0; this.relax = 0; this.blink = 0; this.lcCool = 0; this.decide = rng.next() * 0.4;
    this.exitS = Infinity; this.t0 = 0; this.s0enter = 0;
    this.obstacle = false; this.isPlayer = false; this.brake = 0; this.alive = true;
    this.dz = 0; this.rampT = 0;
    this.hn = 0; this.hs.fill(0); this.hv.fill(0);
    this.missed = false; this.onRamp = null; this.rs = 0;
    this.courteous = rng.chance(0.72);      // 양보하는 운전자 비율
    this.yieldStamp = -1; this.yieldTo = null; this.yieldUrg = 0;
    this.stuck = 0;
    return this;
  }
  /** 이력 기록 (지각 지연에 쓴다) */
  pushHist() { this.hs[this.hn] = this.s; this.hv[this.hn] = this.v; this.hn = (this.hn + 1) % HIST; }
  /** delaySteps 스텝 전의 상태 */
  pastS(d) { return this.hs[(this.hn - 1 - d + HIST * 2) % HIST]; }
  pastV(d) { return this.hv[(this.hn - 1 - d + HIST * 2) % HIST]; }
}

/* ---------- IDM ---------- */
/**
 * IDM 가속도. 가속지수 delta 는 모든 차종에서 4 이므로 x^4 로 특수화했다
 * (매 스텝 수만 번 불리는 지점이라 Math.pow 비용이 그대로 프레임에 나타난다).
 * @param v      자차 속도
 * @param v0     유효 희망속도
 * @param s      순 차두거리 (범퍼 간)
 * @param dv     접근속도 v - v_lead
 * @param sqrtAB sqrt(a*b) — 차량마다 상수
 */
function idmAccel(v, v0, s, dv, aMax, T, s0, sqrtAB) {
  const sStar = s0 + Math.max(0, v * T + v * dv / (2 * sqrtAB));
  const g = s > 0.15 ? s : 0.15;
  let x = v0 > 0.1 ? v / v0 : 3; if (x < 0) x = 0; else if (x > 3) x = 3;
  const x2 = x * x, r = sStar / g;
  return aMax * (1 - x2 * x2 - r * r);
}

/* =============================================================================
   Corridor — 한 방향의 차도
   ========================================================================== */
class Corridor {
  /**
   * @param {Road} road
   * @param {number} dir  +1 주행(계측) 방향 / -1 반대 방향
   */
  constructor(road, dir, cfg, seed) {
    this.road = road; this.dir = dir; this.cfg = cfg;
    this.L = road.len;
    this.rng = new RNG(seed);
    this.nLane = cfg.lanes;
    this.lanes = [];
    for (let i = 0; i <= this.nLane; i++) this.lanes.push([]);   // 마지막 = 부가차로
    this.pool = [];
    this.time = 0;
    this.buildAux();
    this.buildRamps();
    this.precompute();
    this.spawnWait = 0; this.queueUp = 0; this.entered = 0; this.rejected = 0;
    this.stepId = 0;
    this.incidents = [];
    this.incidentTimer = this.rng.exp(3600 / Math.max(cfg.incidentRate, 1e-6));
    this.stat = {
      exited: 0, vehSec: 0, delaySec: 0, distM: 0,
      byCls: { car: { n: 0, tt: 0, ff: 0 }, bus: { n: 0, tt: 0, ff: 0 }, truck: { n: 0, tt: 0, ff: 0 } },
    };
    if (dir > 0) this.buildDetectors();
  }

  /* ---------- 부가차로(가감속차로·오르막차로) ---------- */
  buildAux() {
    const L = this.L, dir = this.dir;
    const raw = [];
    this.icLocal = [];
    for (const ic of this.road.ics) {
      const sl = dir > 0 ? ic.s : L - ic.s;
      if (sl < 900 || sl > L - 1400) continue;
      this.icLocal.push({ s: sl, name: ic.name, rest: ic.rest });
      raw.push({ s0: sl - 320, s1: sl, type: 'decel', ic: sl });        // 감속차로
      raw.push({ s0: sl + 380, s1: sl + 700, type: 'accel', ic: sl });  // 가속차로
    }
    this.icLocal.sort((a, b) => a.s - b.s);

    // 오르막차로 — 3% 이상 오르막이 700 m 넘게 이어지면 설치한다
    const ds = 8;
    let runS = -1;
    for (let s = 0; s <= L; s += ds) {
      const g = this.gradeAt(s);
      if (g >= 0.03) { if (runS < 0) runS = s; }
      else {
        if (runS >= 0 && s - runS >= 700) raw.push({ s0: runS + 150, s1: Math.min(L - 60, s + 250), type: 'climb', ic: -1 });
        runS = -1;
      }
    }
    // 겹치면 하나의 연속 부가차로로 합친다
    raw.sort((a, b) => a.s0 - b.s0);
    const out = [];
    for (const r of raw) {
      r.s0 = clamp(r.s0, 0, L); r.s1 = clamp(r.s1, 0, L);
      if (r.s1 - r.s0 < 80) continue;
      const last = out[out.length - 1];
      if (last && r.s0 <= last.s1 + 90) { last.s1 = Math.max(last.s1, r.s1); last.type = last.type === r.type ? last.type : 'aux'; }
      else out.push({ ...r });
    }
    this.aux = out;
  }

  /** station 의 부가차로 (없으면 null) */
  auxAt(s) {
    if (!this.auxA) {                                   // precompute 이전 (buildRamps 중) 대비
      for (const a of this.aux) if (s >= a.s0 && s <= a.s1) return a;
      return null;
    }
    const a = this.auxA[this.jOf(s)];
    return a < 0 ? null : this.aux[a];
  }
  /** 부가차로 폭 계수 0..1 (테이퍼) */
  auxWidth(s) {
    const a = this.auxAt(s); if (!a) return 0;
    const inT = clamp((s - a.s0) / 70, 0, 1), outT = clamp((a.s1 - s) / 70, 0, 1);
    return smoothstep(Math.min(inT, outT));
  }
  nLaneAt(s) { return this.nLane + (this.auxAt(s) ? 1 : 0); }

  /* ---------- 램프 ----------
     노즈(gore)에서 t 만큼 떨어진 지점의 횡거와 높이차.
     처음 80 m 는 1:16 테이퍼로 갈라지고, 그 뒤로는 일정 곡률(2차 곡선)로 벌어진다.
     실제 다이아몬드형 인터체인지의 진출입로가 이 모양이다. */
  /* 램프 평면선형. 노즈에서 1:14 로 떨어져 나가 점점 크게 휘는 3차 곡선이다.
     구간을 나눠 이어 붙이면 이음매에서 기울기가 튀어 꺾여 보이므로,
     전 구간을 하나의 매끄러운(C1) 식으로 둔다. */
  rampLat(t) {
    const base = this.laneU(this.nLane);
    if (t <= 0) return base;
    const x = Math.min(t / RAMP_LEN, 1.15);
    return base + RAMP_OFF * (0.74 * x + 0.26 * x * x * x);
  }
  /* 램프 종단은 본선보다 아주 조금만 내려간다. 크게 내리면 주변 지형에 묻혀
     화면에서 사라진다 — 실제로도 인터체인지 근처는 완만하게 붙인다. */
  rampDz(t) {
    if (t <= 0) return 0;
    const x = Math.min(t / RAMP_LEN, 1.15);
    return -1.5 * x * x;
  }
  /** 본선 갓길 바깥 가장자리 (램프가 여기서부터 모습을 드러낸다) */
  outerEdge() { return RoadStd.shL + RoadStd.laneW * this.nLane + RoadStd.shR; }
  get rampLen() { return RAMP_LEN; }

  buildRamps() {
    this.onRamps = []; this.offRamps = [];
    for (const ic of this.icLocal) {
      const acc = this.auxAt(ic.s + 420);
      this.onRamps.push({
        s: ic.s + 380, name: ic.name, queue: [], len: 320, wait: 0, served: 0, rejected: 0,
        auxEnd: acc ? acc.s1 : ic.s + 700, qDelay: 0,
      });
      this.offRamps.push({ s: ic.s, name: ic.name, taken: 0, out: [] });
    }
  }

  /* ---------- 도로 상태 조회 (진행 방향 기준) ---------- */
  /* 매 스텝 수만 번 불리는 경로이므로, 차량과 무관한 도로 측 값은 진행방향
     기준 배열로 미리 펴 두고 인덱스 한 번으로 읽는다. */
  precompute() {
    const R = this.road, n = R.n, ds = R.ds;
    this.ds = ds; this.nS = n;
    this.capA = new Float32Array(n);    // 곡선부 한계속도 (m/s)
    this.multA = new Float32Array(n);   // 터널·기상에 의한 희망속도 배율
    this.hfA = new Float32Array(n);     // 차두시간 배율
    this.gradeA = new Float32Array(n);  // 진행방향 종단경사
    this.structA = new Uint8Array(n);
    this.auxA = new Int16Array(n);
    const rain = this.cfg.weather === 'rain';
    for (let j = 0; j < n; j++) {
      const i = this.dir > 0 ? j : (n - 1 - j);
      const st = R.struct[i];
      this.capA[j] = R.vCurve[i];
      this.multA[j] = (st === 2 ? 0.93 : 1) * (rain ? 0.90 : 1);
      this.hfA[j] = (st === 2 ? 1.12 : 1) * (rain ? 1.15 : 1);
      this.gradeA[j] = R.grade[i] * this.dir;
      this.structA[j] = st;
      this.auxA[j] = -1;
    }
    for (let a = 0; a < this.aux.length; a++) {
      const j0 = clamp(Math.round(this.aux[a].s0 / ds), 0, n - 1);
      const j1 = clamp(Math.round(this.aux[a].s1 / ds), 0, n - 1);
      for (let j = j0; j <= j1; j++) this.auxA[j] = a;
    }
  }
  /** 기상 조건이 바뀌면 배율 배열을 다시 만든다 */
  rebuildCaps() { this.precompute(); }

  jOf(s) { const j = (s / this.road.ds + 0.5) | 0; return j < 0 ? 0 : j >= this.road.n ? this.road.n - 1 : j; }
  roadS(s) { return this.dir > 0 ? s : this.L - s; }
  geo(s) { return this.road.at(this.roadS(s)); }
  gradeAt(s) {
    if (!this.gradeA) return this.road.grade[this.road.idxOf(this.roadS(s))] * this.dir;  // precompute 이전
    return this.gradeA[this.jOf(s)];
  }
  /** 사고로 인한 감속 배율 (구경 지체) */
  incidentMult(s) {
    let m = 1;
    for (let i = 0; i < this.incidents.length; i++) {
      const d = s - this.incidents[i].s;
      if (d > -450 && d < 160) m *= this.incidents[i].lane < 0 ? 0.88 : 0.72;
    }
    return m;
  }
  /** 위치별 유효 희망속도 상한 (m/s) */
  limitAt(s, veh) {
    const j = this.jOf(s);
    let lim = veh.v0own < veh.v0lim ? veh.v0own : veh.v0lim;
    if (this.capA[j] < lim) lim = this.capA[j];
    lim *= this.multA[j];
    return this.incidents.length ? lim * this.incidentMult(s) : lim;
  }
  /** 차두시간 보정 (터널·강우 시 커진다) */
  headwayFactor(s) { return this.hfA[this.jOf(s)]; }

  /* ---------- 차로 기하 ---------- */
  /* 횡거 u 는 '차도 안쪽(중앙분리대 쪽) 가장자리'에서 잰다.
     중심선 기준이 아니다 — 터널의 쌍굴 이격 때문에 두 차도 사이 간격이
     구간마다 달라지므로, 중심선 기준으로 두면 차량 위치가 어긋난다. */
  laneU(i) { return RoadStd.shL + RoadStd.laneW * (i + 0.5); }
  /** 차도 안쪽 가장자리의 중심선 기준 위치 (부호 포함) */
  medAt(s) { return this.road.medHalfAt(this.roadS(s)); }
  /** 차도 국소 횡거 -> 중심선 기준 횡거 */
  toRoadU(s, u) { return this.dir > 0 ? this.medAt(s) + u : -(this.medAt(s) + u); }
  /** 중차량이 들어갈 수 있는 가장 왼쪽 차로 (지정차로제) */
  heavyMinLane() {
    if (!this.cfg.laneRule) return 0;
    return this.nLane >= 4 ? 2 : this.nLane >= 3 ? 1 : 0;
  }
  laneAllowed(veh, i, s) {
    if (i < 0) return false;
    const nl = this.nLaneAt(s);
    if (i >= nl) return false;
    if (i === this.nLane) {                       // 부가차로
      const a = this.auxAt(s); if (!a) return false;
      // 가속차로는 램프 진입차 전용, 감속차로는 유출차 전용, 오르막차로만 저속차에 열려 있다.
      // 이 구분이 없으면 본선 차량이 부가차로를 주행차로로 써 버려 종점마다 병목이 생긴다.
      if (a.type === 'climb') return veh.p.heavy || veh.v < 22;
      if (a.type === 'accel') return false;
      return isFinite(veh.exitS) && veh.exitS <= a.s1 + 60;
    }
    if (veh.p.heavy && i < this.heavyMinLane() && !veh.ruleBreaker) return false;
    return true;
  }

  /* ---------- 이웃 탐색 ---------- */
  /** 차로 배열에서 s 보다 앞(큰 s)의 첫 차량 인덱스 */
  seek(arr, s) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].s <= s) lo = m + 1; else hi = m; }
    return lo;
  }

  /* =========================== 스텝 =========================== */
  step(dt, player) {
    this.time += dt;
    // 계산 대상 구간을 플레이어를 따라 옮기고, 새로 드러난 앞쪽을 목표 밀도로 채운다
    if (this.focusS != null) {
      const w = this.window();
      if (this.filledTo == null) this.filledTo = w[1];
      if (w[1] > this.filledTo + 60) {
        this.fillRange(Math.max(this.filledTo, w[0]), w[1], 600);
        this.filledTo = w[1];
      }
      if (w[1] < this.filledTo) this.filledTo = w[1];
    }
    const dSteps = Math.round(this.cfg.reactionTime / DT);

    // 1) 배열 정렬 및 인덱스 갱신
    for (let li = 0; li < this.lanes.length; li++) {
      const arr = this.lanes[li];
      insertionSortByS(arr);
      for (let j = 0; j < arr.length; j++) arr[j].idx = j;
    }
    // 2) 협조 양보 표시 — 강제 합류 중인 차 뒤에 자리를 내주게 한다
    this.markYields();
    // 3) 가속도 계산
    for (let li = 0; li < this.lanes.length; li++) {
      const arr = this.lanes[li];
      for (let j = 0; j < arr.length; j++) {
        const v = arr[j];
        if (v.obstacle) continue;
        if (v.isPlayer && !player.auto) continue;
        v.a = this.accelFor(v, arr[j + 1], dSteps);
      }
    }
    // 4) 차로 변경 판단
    for (let li = 0; li < this.lanes.length; li++) {
      const arr = this.lanes[li];
      for (let j = arr.length - 1; j >= 0; j--) {
        const v = arr[j];
        if (v.obstacle) continue;
        if (v.isPlayer && !player.auto) continue;
        v.decide -= dt;
        if (v.decide > 0) continue;
        v.decide = 0.30 + this.rng.next() * 0.25;
        this.tryLaneChange(v, dSteps);
      }
    }
    // 5) 적분
    for (let li = 0; li < this.lanes.length; li++) {
      const arr = this.lanes[li];
      for (let j = 0; j < arr.length; j++) {
        const v = arr[j];
        if (v.obstacle) continue;
        if (v.isPlayer && !player.auto) { v.pushHist(); continue; }
        this.integrate(v, dt);
      }
    }
    // 6) 유출입·사고·검지
    this.handleRamps(dt);
    this.spawn(dt);
    this.cull();
    this.updateIncidents(dt);
    if (this.dir > 0) this.sampleDetectors(dt);
  }

  /** IDM + 동력한계 + 종단경사 + 강제 감속요인 */
  accelFor(v, lead, dSteps) {
    const p = v.p;
    const s = v.s;
    const v0 = this.limitAt(s, v);
    const hf = this.headwayFactor(s);
    const relaxT = 1 - 0.55 * v.relax, relaxS = 1 - 0.40 * v.relax;
    const T = v.Tbase * hf * relaxT;
    const s0 = p.s0 * relaxS;
    const aMax = p.a * v.aggr;

    let acc = 1e9;
    // 선행차 (지각 지연 반영)
    if (lead) {
      let gap, dv;
      if (dSteps > 0 && !lead.obstacle) {
        // 반응시간 만큼 지연된 선행차 상태를 본다 (Human Driver Model).
        gap = lead.pastS(dSteps) - v.pastS(dSteps) - lead.len;
        dv = v.pastV(dSteps) - lead.pastV(dSteps);
        // 다만 실제 간격이 위험할 만큼 좁아졌으면 즉시 현재 값으로 반응한다.
        // (이 보정을 상시 적용하면 늘 더 좁은 쪽을 보게 되어 용량이 과소평가된다)
        const now = lead.s - v.s - lead.len;
        if (now < gap * 0.62 || now < 6) { gap = now; dv = v.v - lead.v; }
      } else { gap = lead.s - v.s - lead.len; dv = v.v - lead.v; }
      acc = Math.min(acc, idmAccel(v.v, v0, gap, dv, aMax, T, s0, v.sqrtAB));
    } else {
      let x = v.v / v0; if (x > 3) x = 3;
      acc = Math.min(acc, aMax * (1 - x * x * x * x));
    }
    // 협조 양보 — 합류차를 부드럽게 선행차로 취급한다 (급제동은 하지 않는다)
    if (v.yieldStamp === this.stepId && v.yieldTo) {
      const m = v.yieldTo;
      const gap = m.s - v.s - m.len - 1.0;
      const aY = idmAccel(v.v, v0, gap, v.v - m.v, aMax, T * (0.35 + 0.45 * v.yieldUrg), s0 * 0.5, v.sqrtAB);
      const soft = aY < -2.6 ? -2.6 : aY;
      if (soft < acc) acc = soft;
    }
    // 부가차로 종점 / 램프 종점 / 사고 차단 — 가상의 정지 장애물
    const stopAt = this.hardStopAhead(v);
    if (stopAt !== null) {
      const gap = stopAt - v.s;
      acc = Math.min(acc, idmAccel(v.v, v0, gap, v.v, aMax, T, s0, v.sqrtAB));
    }
    // 동력·저항 한계 — 종단경사는 여기(구동력 여유)에 들어간다.
    // IDM 이 낸 요구가속에서 g·i 를 그냥 빼면 승용차마저 오르막에서 감속해 버린다.
    // 실제로는 여유 출력이 있는 차는 경사에서도 희망속도를 유지하고,
    // 출력이 모자란 중차량만 등판 평형속도까지 떨어진다(이동 병목).
    const grade = this.gradeAt(s);
    const aFree = p.powEff / (v.v > 4 ? v.v : 4) - p.CrG - p.dragK * v.v * v.v - GRAV * grade;
    if (acc > aFree) acc = aFree;
    // 유색잡음 (Ornstein-Uhlenbeck)
    const tauN = 6;
    v.eta += (-v.eta / tauN) * DT + p.aNoise * this.cfg.noise * NOISE_K * this.rng.normalFast();
    v.eta = clamp(v.eta, -0.8, 0.8);
    acc += v.eta;
    return clamp(acc, -9.5, 4.0);
  }

  /* ---------- 협조 양보 ----------
     MOBIL 만으로는 강제 합류가 성립하지 않는다. 본선 차량이 아무도 자리를
     내주지 않으면 가속차로 종점에서 합류차가 그대로 서 버리기 때문이다.
     실제 교통에서 관측되는 양보 거동(courtesy yielding)을 넣어 준다. */
  markYields() {
    this.stepId++;
    const auxArr = this.lanes[this.nLane];
    for (let i = 0; i < auxArr.length; i++) {
      const v = auxArr[i];
      if (v.obstacle) continue;
      const a = this.auxAt(v.s);
      const end = a ? a.s1 : v.s;
      const urg = clamp(1 - (end - v.s) / 260, 0, 1);
      if (urg < 0.20) continue;
      this.requestYield(v, this.nLane - 1, urg);
    }
    for (let n = 0; n < this.incidents.length; n++) {
      const inc = this.incidents[n];
      if (inc.lane < 0) continue;
      const arr = this.lanes[inc.lane];
      const k0 = this.seek(arr, inc.s - 600), k1 = this.seek(arr, inc.s);
      for (let i = k0; i < k1; i++) {
        const v = arr[i]; if (v.obstacle) continue;
        const urg = clamp(1 - (inc.s - v.s) / 500, 0, 1);
        if (urg < 0.25) continue;
        this.requestYield(v, inc.lane > 0 ? inc.lane - 1 : 1, urg);
      }
    }
  }
  requestYield(v, tl, urg) {
    if (tl < 0 || tl >= this.lanes.length) return;
    const arr = this.lanes[tl];
    const k = this.seek(arr, v.s);
    const foll = arr[k - 1];
    if (!foll || foll.obstacle || !foll.courteous) return;
    if (v.s - foll.s > 75) return;
    if (foll.yieldStamp === this.stepId && foll.yieldUrg >= urg) return;
    foll.yieldStamp = this.stepId; foll.yieldTo = v; foll.yieldUrg = urg;
  }

  /** 앞에서 반드시 멈춰야 하는 지점 (없으면 null) */
  hardStopAhead(v) {
    let stop = null;
    if (v.lane === this.nLane) {                       // 부가차로 종점
      const a = this.auxAt(v.s);
      if (a) stop = a.s1 - 6;
      else stop = v.s + 2;                             // 이미 벗어난 비정상 상태
    }
    return stop;
  }

  integrate(v, dt) {
    const vNew = v.v + v.a * dt;
    if (vNew < 0) { v.s += Math.max(0, -0.5 * v.v * v.v / v.a); v.v = 0; }
    else { v.s += (v.v + 0.5 * v.a * dt) * dt; v.v = vNew; }
    v.brake = v.a < -0.6 ? 1 : 0;
    if (v.v < 1.5 && v.lane === this.nLane) v.stuck += dt; else v.stuck = 0;
    v.relax = Math.max(0, v.relax - dt / 4.0);
    v.lcCool = Math.max(0, v.lcCool - dt);
    // 횡방향 — 차로 중심으로 부드럽게 이동
    const uPrev = v.u;
    v.u += (v.uT - v.u) * U_LERP;      // 차로 중심으로 지수 접근 (tau = 0.62 s)
    v.yawRel = v.v > 1 ? Math.atan2((v.u - uPrev) / dt, v.v) : 0;
    if (Math.abs(v.u - v.uT) < 0.06) v.blink = 0;
    v.pushHist();
  }

  /* ---------- MOBIL ---------- */
  tryLaneChange(v, dSteps) {
    // 부가차로 종점에서 오래 갇힌 차는 물리적 여유만 있으면 밀고 들어간다.
    // 실제로도 이런 차 때문에 본선이 한 번 출렁이며 용량 저하(capacity drop)가 일어난다.
    if (v.stuck > 12 && v.lane === this.nLane) {
      const tl = this.nLane - 1, arr = this.lanes[tl];
      const k = this.seek(arr, v.s);
      const lead = arr[k] || null, foll = arr[k - 1] || null;
      if ((!lead || lead.s - v.s - lead.len > 1.5) && (!foll || v.s - foll.s - v.len > 1.5)) {
        this.doLaneChange(v, tl); v.stuck = 0; return;
      }
    }
    if (v.lcCool > 0) return;
    const cur = v.lane;
    const nl = this.nLaneAt(v.s);
    const opts = [];
    if (cur - 1 >= 0 && this.laneAllowed(v, cur - 1, v.s)) opts.push(cur - 1);
    if (cur + 1 < this.lanes.length && this.laneAllowed(v, cur + 1, v.s)) opts.push(cur + 1);
    if (!opts.length) return;

    const mand = this.mandatory(v);        // {dir:-1|0|1, urg:0..1}
    let bestGain = -Infinity, bestLane = -1;

    const arrCur = this.lanes[cur];
    const leadCur = arrCur[v.idx + 1] || null;
    const aCur = this.mobilAccel(v, leadCur, v.s, v.v);
    const followCur = arrCur[v.idx - 1] || null;
    const aOldF = followCur && !followCur.obstacle ? this.mobilAccel(followCur, v, followCur.s, followCur.v) : 0;
    const aOldFn = followCur && !followCur.obstacle ? this.mobilAccel(followCur, leadCur, followCur.s, followCur.v) : 0;

    for (const tl of opts) {
      const arr = this.lanes[tl];
      const k = this.seek(arr, v.s);
      const lead = arr[k] || null, foll = arr[k - 1] || null;
      // 물리적으로 들어갈 자리가 있어야 한다
      if (lead && lead.s - v.s - lead.len < 0.6) continue;
      if (foll && v.s - foll.s - v.len < 0.6) continue;

      const aNew = this.mobilAccel(v, lead, v.s, v.v);
      const aNewF = foll && !foll.obstacle ? this.mobilAccel(foll, lead, foll.s, foll.v) : 0;
      const aNewFn = foll && !foll.obstacle ? this.mobilAccel(foll, v, foll.s, foll.v) : 0;

      const dirLC = tl > cur ? 1 : -1;
      const urg = (mand.dir === dirLC) ? mand.urg : 0;
      const bSafe = lerp(MOBIL.bSafe, 9.5, urg) * (foll && foll.p.heavy ? 0.8 : 1);
      if (foll && !foll.obstacle && aNewFn < -bSafe) continue;
      if (foll && foll.obstacle) continue;
      if (lead && lead.obstacle && lead.s - v.s < 120) continue;   // 사고 차로로는 안 들어간다

      // 우측주행 원칙: 오른쪽으로 가면 유인, 왼쪽으로 가면 저항
      let bias = dirLC > 0 ? -MOBIL.biasRight : MOBIL.biasRight;
      if (v.p.heavy && this.cfg.laneRule) bias += dirLC > 0 ? -0.25 : 0.45;
      // 강제 차로변경 압력
      if (mand.dir === dirLC) bias -= 7.0 * urg;
      else if (mand.dir === -dirLC) bias += 5.0 * mand.urg;

      const p = v.p.politeness;
      const gain = (aNew - aCur) + p * ((aNewFn - aNewF) + (aOldFn - aOldF)) - bias;
      const thr = MOBIL.dAth / v.aggr;
      if (gain > thr && gain > bestGain) { bestGain = gain; bestLane = tl; }
    }
    if (bestLane >= 0) this.doLaneChange(v, bestLane);
  }

  /** MOBIL 내부용 간이 IDM (잡음·동력한계 제외) */
  mobilAccel(v, lead, s, vel) {
    const p = v.p;
    const v0 = this.limitAt(s, v);
    const T = v.Tbase * this.headwayFactor(s);
    if (!lead) { let x = clamp(vel / v0, 0, 3); return p.a * v.aggr * (1 - x * x * x * x); }
    const gap = lead.s - s - lead.len;
    return idmAccel(vel, v0, gap, vel - lead.v, p.a * v.aggr, T, p.s0, v.sqrtAB);
  }

  /** 강제 차로변경 필요성 — 방향과 절박도 */
  mandatory(v) {
    let dir = 0, urg = 0;
    // (a) 부가차로 종점
    if (v.lane === this.nLane) {
      const a = this.auxAt(v.s);
      const end = a ? a.s1 : v.s;
      urg = clamp(1 - (end - v.s) / 260, 0, 1);
      return { dir: -1, urg: Math.max(urg, 0.15) };
    }
    // (b) 유출 예정
    if (isFinite(v.exitS)) {
      const d = v.exitS - v.s;
      if (d > -30) {
        const aux = this.auxAt(v.s);
        const want = (aux && aux.type !== 'climb' && v.s > v.exitS - 320) ? this.nLane : this.nLane - 1;
        if (v.lane < want) return { dir: 1, urg: clamp(1 - d / 1100, 0, 1) };
        if (v.lane > want) return { dir: -1, urg: clamp(1 - d / 1100, 0, 1) };
      }
    }
    // (c) 전방 차단 사고
    for (const inc of this.incidents) {
      if (inc.lane !== v.lane) continue;
      const d = inc.s - v.s;
      if (d > 0 && d < 700) {
        const away = v.lane > 0 ? -1 : 1;
        return { dir: away, urg: clamp(1 - d / 500, 0, 1) };
      }
    }
    // (d) 지정차로제 위반 상태의 중차량
    if (v.p.heavy && this.cfg.laneRule && v.lane < this.heavyMinLane() && !v.ruleBreaker) {
      return { dir: 1, urg: 0.5 };
    }
    return { dir, urg };
  }

  doLaneChange(v, tl) {
    const from = this.lanes[v.lane];
    const k = from.indexOf(v);
    if (k >= 0) from.splice(k, 1);
    v.lane = tl;
    const arr = this.lanes[tl];
    arr.splice(this.seek(arr, v.s), 0, v);
    v.uT = this.laneU(tl);
    v.relax = 1;
    v.lcCool = 1.6;
    v.blink = tl > v.laneT ? 1 : -1;
    v.laneT = tl;
  }

  /* ---------- 유입 ---------- */
  demandNow() {
    const c = this.cfg;
    let q = c.demand * c.lanes;
    if (c.peak) {
      // 첨두 프로파일: 30분에 걸쳐 수요가 용량을 넘어섰다가 되돌아온다
      const t = this.time / 60;
      const f = 0.62 + 0.55 * Math.exp(-Math.pow((t - 22) / 13, 2));
      q *= f;
    }
    return q;
  }

  pickClass() {
    const c = this.cfg;
    const tr = c.truckPct / 100, bs = c.busPct / 100;
    const r = this.rng.next();
    if (r < tr) return 'truck';
    if (r < tr + bs) return 'bus';
    return 'car';
  }

  newVehicle(cls) {
    const v = this.pool.pop() || new Vehicle();
    v.init(cls, this.rng, this.cfg);
    if (v.p.heavy && this.rng.chance(0.12)) v.ruleBreaker = true; else v.ruleBreaker = false;
    return v;
  }

  /** 유출 인터체인지 배정 */
  assignExit(v, fromS) {
    const p = this.cfg.exitPct / 100;
    for (const r of this.offRamps) {
      if (r.s < fromS + 700) continue;
      if (this.rng.chance(p)) { v.exitS = r.s; return; }
    }
    v.exitS = Infinity;
  }

  /** 모의 대상 구간 — 플레이어 주변만 계산한다 */
  window() {
    const f = this.focusS != null ? this.focusS : 0;
    return [Math.max(0, f - SIM_BACK), Math.min(this.L, f + SIM_AHEAD)];
  }

  /* 시작하자마자 설정한 밀도가 보이도록 창 안을 미리 채운다.
     시간으로 채우면 40 km 를 메우는 데 20분 넘게 걸려서, 출발할 때 앞이 텅 빈다.
     자유류 평형 차두로 깔아 둔 뒤 짧게 돌려 IDM 이 자리를 잡게 한다. */
  prefill(maxVeh) {
    const w = this.window();
    const n = this.fillRange(w[0], w[1], maxVeh || 4000);
    this.filledTo = w[1];
    return n;
  }

  /** [s0, s1] 구간을 목표 밀도로 채운다 */
  fillRange(s0, s1, cap) {
    const q = this.demandNow();
    if (q <= 0 || s1 <= s0) return 0;
    let placed = 0;
    const minLane = this.heavyMinLane();
    const heavyLanes = Math.max(1, this.nLane - minLane);
    // 중차량이 갈 수 있는 차로에만 몰아 넣되, 전체 구성비는 유지되게 비율을 키운다
    const heavyBoost = this.nLane / heavyLanes;
    const perLane = q / this.nLane;
    const meanHw = 3600 / Math.max(perLane, 1);          // 평균 차두시간 (s)

    for (let li = 0; li < this.nLane; li++) {
      const arr = this.lanes[li];
      let s = s0 + this.rng.range(5, 90);
      while (s < s1 && placed < cap) {
        let cls = this.pickClass();
        if (VCLASS[cls].heavy) {
          if (li < minLane || !this.rng.chance(Math.min(1, heavyBoost))) cls = 'car';
        }
        const v = this.newVehicle(cls);
        const j = this.jOf(s);
        const vDes = Math.min(v.v0own, v.v0lim, this.capA[j]) * this.multA[j];
        v.s = s; v.v = vDes * this.rng.range(0.94, 1.0);
        v.lane = li; v.laneT = li;
        v.u = v.uT = this.laneU(li);
        v.t0 = this.time; v.s0enter = s;
        for (let h = 0; h < HIST; h++) { v.hs[h] = v.s - v.v * (HIST - h) * DT; v.hv[h] = v.v; }
        this.assignExit(v, s);
        arr.splice(this.seek(arr, s), 0, v);
        placed++;
        // 다음 차까지의 거리 — 포아송 도착을 거리로 환산하고 최소 안전 차두를 지킨다
        const minGap = v.len + v.p.s0 + v.v * v.Tbase * 0.85;
        s += Math.max(minGap, v.v * this.rng.exp(meanHw));
      }
    }
    for (let li = 0; li < this.lanes.length; li++) {
      insertionSortByS(this.lanes[li]);
      for (let k = 0; k < this.lanes[li].length; k++) this.lanes[li][k].idx = k;
    }
    this.entered += placed;
    return placed;
  }

  spawn(dt) {
    const q = this.demandNow();
    if (q <= 0) return;
    this.spawnWait -= dt;
    if (this.spawnWait > 0) return;
    this.spawnWait += this.rng.exp(3600 / q);
    // 상류 경계에서 넣을 수 있는 차로를 고른다 — 앞 간격이 가장 넉넉한 곳
    const cls = this.pickClass();
    const v = this.newVehicle(cls);
    // 유입 경계는 창의 뒤쪽 끝이다 — 플레이어를 따라 함께 움직인다
    const bnd = this.window()[0];
    let best = -1, bestGap = -Infinity, bestLead = null;
    const minLane = v.p.heavy ? this.heavyMinLane() : 0;
    for (let i = minLane; i < this.nLane; i++) {
      const arr = this.lanes[i];
      const k = this.seek(arr, bnd);
      const lead = arr[k] || null;
      const gap = lead ? lead.s - lead.len - bnd : 1e5;
      if (gap > bestGap) { bestGap = gap; best = i; bestLead = lead; }
    }
    const vDes = Math.min(v.v0own, v.v0lim);
    // 경계에 자리가 없으면 상류(음의 station)에 붙여 대기행렬을 만든다.
    // 수요가 용량을 넘으면 여기에 줄이 서고, 그 길이가 곧 상류 지체다.
    const need = v.p.s0 + vDes * v.Tbase * 0.55 + 1.5;
    let sIns = bnd;
    if (bestLead && bestLead.s - bestLead.len - bnd < need) sIns = bestLead.s - bestLead.len - need;
    if (best < 0 || sIns < bnd - 1200) { this.pool.push(v); this.rejected++; this.queueUp++; return; }
    v.s = sIns; v.lane = best; v.laneT = best;
    v.u = v.uT = this.laneU(best);
    v.v = Math.min(vDes, bestLead ? Math.max(bestLead.v, 8) : vDes);
    v.t0 = this.time; v.s0enter = sIns;
    // 이력은 반드시 실제 투입 위치를 기준으로 채운다. 0 기준으로 채우면
    // 상류 대기열(음의 station)에 넣은 차가 자기 앞 간격을 음수로 지각해 급제동한다.
    for (let h = 0; h < HIST; h++) { v.hs[h] = v.s - v.v * (HIST - h) * DT; v.hv[h] = v.v; }
    this.assignExit(v, 0);
    this.lanes[best].splice(0, 0, v);
    this.entered++;
    this.queueUp = Math.max(0, this.queueUp - 1);
  }

  /* ---------- 램프 ---------- */
  handleRamps(dt) {
    const qRamp = this.demandNow() * (this.cfg.rampPct / 100);
    for (const r of this.onRamps) {
      // 램프 도착
      r.wait -= dt;
      if (r.wait <= 0) {
        r.wait += this.rng.exp(3600 / Math.max(qRamp / Math.max(this.onRamps.length, 1), 1e-6));
        const v = this.newVehicle(this.pickClass());
        v.rs = 0; v.v = 52 * KMH; v.t0 = this.time; v.onRamp = r;
        v.s = r.s - r.len; v.lane = this.nLane; v.laneT = this.nLane;
        v.rampT = r.len;
        v.u = v.uT = this.rampLat(r.len); v.dz = this.rampDz(r.len);
        for (let h = 0; h < HIST; h++) { v.hs[h] = v.s; v.hv[h] = v.v; }
        r.queue.push(v);
      }
      // 램프 위 주행 (자체 IDM)
      for (let i = r.queue.length - 1; i >= 0; i--) {
        const v = r.queue[i];
        const lead = r.queue[i + 1] || null;
        const v0 = Math.min(v.v0own, 80 * KMH);
        let acc;
        if (lead) acc = idmAccel(v.v, v0, lead.s - v.s - lead.len, v.v - lead.v, v.p.a * v.aggr, v.Tbase, v.p.s0, v.sqrtAB);
        else { const x = clamp(v.v / v0, 0, 3); acc = v.p.a * v.aggr * (1 - x * x * x * x); }
        // 합류 가능 여부 — 불가하면 노즈에서 정지
        if (!lead) {
          const aux = this.lanes[this.nLane];
          const k = this.seek(aux, r.s);
          const nose = aux[k] || null, back = aux[k - 1] || null;
          const room = (!nose || nose.s - r.s - nose.len > 6) && (!back || r.s - back.s - v.len > 4);
          if (!room) acc = Math.min(acc, idmAccel(v.v, v0, Math.max(r.s - v.s, 0.2), v.v, v.p.a, v.Tbase, v.p.s0, v.sqrtAB));
        }
        const aF = v.p.powEff / Math.max(v.v, 4) - v.p.CrG - v.p.dragK * v.v * v.v - GRAV * this.gradeAt(v.s);
        acc = clamp(Math.min(acc, aF), -8, 3.5);
        v.a = acc;
        const vn = v.v + acc * dt;
        if (vn < 0) { v.v = 0; } else { v.s += (v.v + 0.5 * acc * dt) * dt; v.v = vn; }
        const tr = Math.max(0, r.s - v.s);
        v.u = this.rampLat(tr); v.dz = this.rampDz(tr);
        v.rampT = tr;
        v.pushHist();
        if (v.s >= r.s) {
          // 본선 가속차로로 진입
          const aux = this.lanes[this.nLane];
          const k = this.seek(aux, v.s);
          const nose = aux[k] || null, back = aux[k - 1] || null;
          if ((!nose || nose.s - v.s - nose.len > 3) && (!back || v.s - back.s - v.len > 3)) {
            r.queue.splice(i, 1);
            v.onRamp = null; v.relax = 1; v.s0enter = v.s; v.dz = 0; v.rampT = 0;
            v.lane = this.nLane; v.laneT = this.nLane; v.uT = this.laneU(this.nLane);
            aux.splice(k, 0, v);
            this.assignExit(v, v.s);
            r.served++; this.entered++;
          } else { v.s = r.s - 0.2; v.v = Math.min(v.v, 3); }
        }
      }
      r.qDelay += r.queue.length * dt;
    }
    // 진출 램프 — 빠져나간 차를 램프 끝까지 굴려 보낸다.
    // 노즈에서 그냥 사라지면 통행이 어수선해 보인다.
    for (const o of this.offRamps) {
      for (let i = o.out.length - 1; i >= 0; i--) {
        const v = o.out[i];
        const lead = o.out[i + 1] || null;
        const v0 = Math.min(v.v0own, 72 * KMH);
        let acc;
        if (lead) acc = idmAccel(v.v, v0, lead.s - v.s - lead.len, v.v - lead.v, v.p.a * v.aggr, v.Tbase, v.p.s0, v.sqrtAB);
        else { const x = clamp(v.v / v0, 0, 3); acc = v.p.a * v.aggr * (1 - x * x * x * x); }
        v.a = clamp(acc, -6, 3);
        const vn = v.v + v.a * dt;
        if (vn < 0) v.v = 0; else { v.s += (v.v + 0.5 * v.a * dt) * dt; v.v = vn; }
        const t = Math.max(0, v.s - o.s);
        v.u = this.rampLat(t); v.dz = this.rampDz(t); v.rampT = t;
        v.pushHist();
        if (t > this.rampLen) { o.out.splice(i, 1); v.alive = false; if (this.pool.length < 2500) this.pool.push(v); }
      }
    }
  }

  /* ---------- 이탈 ---------- */
  cull() {
    for (let li = 0; li < this.lanes.length; li++) {
      const arr = this.lanes[li];
      for (let j = arr.length - 1; j >= 0; j--) {
        const v = arr[j];
        if (v.obstacle) continue;
        let out = false, exitedHere = null;
        if (v.s >= this.L - 5) out = true;
        // 창 밖으로 벗어난 차는 지운다 (플레이어 뒤로 멀어졌거나 너무 앞서 나간 차)
        if (!out && !v.isPlayer && this.focusS != null) {
          const d = v.s - this.focusS;
          if (d < -SIM_BACK - 150 || d > SIM_AHEAD + 250) { out = true; }
        }
        // 유출 램프에서 빠져나감 (부가차로에 있고 노즈를 지났을 때)
        if (!out && isFinite(v.exitS) && li === this.nLane && v.s >= v.exitS && v.s < v.exitS + 60) {
          out = true;
          const r = this.offRamps.find(o => Math.abs(o.s - v.exitS) < 1);
          if (r) { r.taken++; exitedHere = r; }
        }
        if (!out && isFinite(v.exitS) && v.s > v.exitS + 80) { v.missed = true; v.exitS = Infinity; }
        if (out) {
          if (!v.isPlayer) this.record(v);
          arr.splice(j, 1);
          // 인터체인지로 빠지는 차는 램프 위에서 계속 달리게 넘긴다
          if (!v.isPlayer && exitedHere) {
            v.lane = -1; v.dz = 0; v.rampT = 0;
            exitedHere.out.push(v);
            exitedHere.out.sort((a, b) => a.s - b.s);
            continue;
          }
          if (v.isPlayer) { v.s = 0; v.t0 = this.time; this.playerWrapped = true; arr.splice(0, 0, v); continue; }
          v.alive = false;
          if (this.pool.length < 2500) this.pool.push(v);
        }
      }
    }
  }

  record(v) {
    const dist = v.s - v.s0enter;
    if (dist < 200) return;
    const tt = this.time - v.t0;
    const vff = Math.min(v.v0own, v.v0lim);
    const ff = dist / vff;
    const st = this.stat;
    st.exited++; st.vehSec += tt; st.delaySec += Math.max(0, tt - ff); st.distM += dist;
    const c = st.byCls[v.cls]; c.n++; c.tt += tt; c.ff += ff;
  }

  /* ---------- 사고·고장 ---------- */
  updateIncidents(dt) {
    this.incidentTimer -= dt;
    if (this.incidentTimer <= 0 && this.cfg.incidentRate > 0) {
      this.incidentTimer = this.rng.exp(3600 / this.cfg.incidentRate);
      this.addIncident();
    }
    for (let i = this.incidents.length - 1; i >= 0; i--) {
      const inc = this.incidents[i];
      inc.t -= dt;
      if (inc.t <= 0) this.removeIncident(i);
    }
  }

  addIncident(opt) {
    const laneBlock = opt ? opt.laneBlock : this.rng.chance(0.32);
    const s = opt ? opt.s : this.rng.range(this.L * 0.15, this.L * 0.85);
    const lane = laneBlock ? (opt && opt.lane != null ? opt.lane : this.rng.int(0, this.nLane - 1)) : -1;
    const inc = {
      s, lane, t: laneBlock ? this.rng.range(500, 1500) : this.rng.range(360, 1100),
      total: 0, veh: null, cls: this.rng.weighted([['car', 6], ['truck', 3], ['bus', 1]]),
      kind: laneBlock ? '차로 차단 사고' : '갓길 고장차',
    };
    inc.total = inc.t;
    if (laneBlock) {
      const o = this.newVehicle(inc.cls);
      o.obstacle = true; o.v = 0; o.a = 0; o.s = s; o.lane = lane;
      o.u = o.uT = this.laneU(lane); o.yawRel = this.rng.range(-0.35, 0.35);
      inc.veh = o;
      const arr = this.lanes[lane];
      arr.splice(this.seek(arr, s), 0, o);
    } else {
      const o = this.newVehicle(inc.cls);
      o.obstacle = true; o.v = 0; o.a = 0; o.s = s; o.lane = -1;
      o.u = o.uT = this.laneU(this.nLane - 1) + RoadStd.laneW * 0.5 + RoadStd.shR * 0.55;
      inc.veh = o;      // 갓길 차량은 차로 배열에 넣지 않는다
    }
    this.incidents.push(inc);
    return inc;
  }

  removeIncident(i) {
    const inc = this.incidents[i];
    if (inc.veh && inc.lane >= 0) {
      const arr = this.lanes[inc.lane];
      const k = arr.indexOf(inc.veh);
      if (k >= 0) arr.splice(k, 1);
    }
    this.incidents.splice(i, 1);
  }

  /* ---------- 검지기 / 시공간 속도장 ---------- */
  buildDetectors() {
    this.detSpacing = 500;
    this.dets = [];
    // 경계 유입의 영향을 받는 상류 500 m 는 계측에서 뺀다
    for (let s = this.detSpacing; s <= this.L - 200; s += this.detSpacing) {
      this.dets.push({ s, n: 0, invV: 0, pce: 0, acc: 0, q: 0, v: 0, k: 0, hist: [] });
    }
    this.aggT = 60;                    // 집계 간격 (s)
    this.aggAcc = 0;
    this.fd = [];                      // 교통량-밀도 산점 (기본구간 도표)
    // 시공간 속도장
    this.cellLen = 100;
    this.nCell = Math.ceil(this.L / this.cellLen);
    this.stRows = [];                  // 각 행 = 한 시각의 셀별 평균속도
    this.stAcc = 0; this.stPeriod = 3;
    this.maxRows = 480;
  }

  sampleDetectors(dt) {
    // 검지기 통과 계수 — 지난 스텝 위치와 비교
    for (let li = 0; li < this.lanes.length; li++) {
      const arr = this.lanes[li];
      for (let j = 0; j < arr.length; j++) {
        const v = arr[j];
        if (v.obstacle) continue;
        const prev = v.pastS(1);
        const i0 = Math.floor(prev / this.detSpacing), i1 = Math.floor(v.s / this.detSpacing);
        if (i1 > i0 && i1 >= 0 && i1 < this.dets.length && v.v > 0.1) {
          const d = this.dets[i1];
          d.n++; d.invV += 1 / Math.max(v.v, 0.5);
          d.pce += v.p.pce + 20 * Math.max(0, Math.abs(this.gradeAt(v.s)) - 0.02) * (v.p.heavy ? 1 : 0);
        }
      }
    }
    this.aggAcc += dt;
    if (this.aggAcc >= this.aggT) {
      const T = this.aggAcc; this.aggAcc = 0;
      for (const d of this.dets) {
        d.q = d.n * 3600 / T;                                   // veh/h
        d.v = d.n > 0 ? (d.n / d.invV) : NaN;                   // 공간평균속도 m/s
        d.k = d.n > 0 ? d.q / (d.v * 3.6) : 0;                  // veh/km
        const pceRate = d.n > 0 ? d.pce / d.n : 1;
        if (d.n >= 3) {
          this.fd.push({ k: d.k * pceRate / this.nLane, q: d.q * pceRate / this.nLane, v: d.v * 3.6 });
          if (this.fd.length > 4000) this.fd.shift();
        }
        d.hist.push({ q: d.q, v: d.v, k: d.k });
        if (d.hist.length > 240) d.hist.shift();
        d.n = 0; d.invV = 0; d.pce = 0;
      }
    }
    // 시공간 속도장
    this.stAcc += dt;
    if (this.stAcc >= this.stPeriod) {
      this.stAcc = 0;
      const sum = new Float32Array(this.nCell), cnt = new Float32Array(this.nCell);
      for (const arr of this.lanes) {
        for (const v of arr) {
          if (v.obstacle) continue;
          const c = clamp(Math.floor(v.s / this.cellLen), 0, this.nCell - 1);
          sum[c] += v.v; cnt[c]++;
        }
      }
      const row = new Float32Array(this.nCell);
      for (let c = 0; c < this.nCell; c++) row[c] = cnt[c] > 0 ? sum[c] / cnt[c] : -1;
      this.stRows.push(row);
      if (this.stRows.length > this.maxRows) this.stRows.shift();
    }
  }

  /* ---------- 조회 ---------- */
  count() { let n = 0; for (const arr of this.lanes) for (const v of arr) if (!v.obstacle) n++; return n; }
  /** 상류 경계에 밀려 대기 중인 차량 수 */
  upstreamQueue() {
    const bnd = this.window()[0];
    let n = 0; for (const arr of this.lanes) for (const v of arr) { if (v.obstacle) continue; if (v.s < bnd) n++; }
    return n;
  }
  /** 특정 위치 주변의 교통 상태 (밀도 veh/km/차로, 평균속도) */
  localState(s, win) {
    win = win || 500;
    let n = 0, sv = 0, pce = 0;
    for (const arr of this.lanes) {
      const a = this.seek(arr, s - win), b = this.seek(arr, s + win);
      for (let i = a; i < b; i++) { const v = arr[i]; if (v.obstacle) continue; n++; sv += v.v; pce += v.p.pce; }
    }
    const km = 2 * win / 1000;
    return { n, k: n / km / this.nLane, kp: pce / km / this.nLane, v: n ? sv / n * 3.6 : NaN };
  }
  /** 다음 인터체인지 */
  nextIC(s) { for (const ic of this.icLocal) if (ic.s > s) return ic; return null; }
}

/** 거의 정렬된 배열용 삽입정렬 — 매 스텝 순서가 조금만 바뀌므로 O(n) 에 가깝다 */
function insertionSortByS(arr) {
  for (let i = 1; i < arr.length; i++) {
    const x = arr[i]; let j = i - 1;
    while (j >= 0 && arr[j].s > x.s) { arr[j + 1] = arr[j]; j--; }
    arr[j + 1] = x;
  }
}

/** 밀도(pc/km/차로) -> HCM 서비스수준 */
function losOf(kp) {
  if (!isFinite(kp)) return '-';
  if (kp <= 7) return 'A'; if (kp <= 11) return 'B'; if (kp <= 16) return 'C';
  if (kp <= 22) return 'D'; if (kp <= 28) return 'E'; return 'F';
}
