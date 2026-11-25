/* =============================================================================
   csim.js — 도시 교통 시뮬레이터: 격자 도로망 · 신호 교차로 · 차로 단위 주행

   도로망 (평면, x = 동 · y = 북)
     교차로가 NX × NY 격자로 블록 길이 B 마다 놓인다. 모든 도로는 방향마다 n 차로(1~3)이고,
     차로 0 이 중앙선 쪽(1차로), 차로 n-1 이 길가 쪽이다. 우측통행.
     바깥 교차로에서는 도로가 도시 밖으로 CITY.stub m 이어지고 그 끝이 출입 지점(게이트)이다.
     블록 사이 도로(안쪽 구간)마다 가운데에 건물 출입구(존)가 있어 차가 길가 차로에서 나오고 들어간다.

   교차로 — 진입 차로 끝(정지선)과 진출 차로 시작을 잇는 회전 경로(연결로).
     좌회전 = 1차로 → 1차로, 우회전 = 끝 차로 → 끝 차로, 직진 = 같은 차로끼리. 유턴은 없다.
     신호는 4 현시 · 황색 3 s · 전적색 2 s.
       'lead'     직진 후 좌회전: 남북 직진(+우회전) → 남북 좌회전 → 동서 직진(+우회전) → 동서 좌회전
       'approach' 방향별 동시: 북 → 동 → 남 → 서 진입로가 차례로 (직진 · 좌 · 우회전 함께)
     적신호 우회전: 정지선에 1.5 s 넘게 선 뒤, 들어갈 차로로 오는 다른 흐름이 없으면 간다.
     ★ 녹색이어도 진출 차로에 내 차 길이만큼 자리가 없으면 정지선에서 기다린다(교차로 막기 금지).

   차 — IDM(고속도로와 같은 식). 다음 교차로 회전에 맞는 차로로 미리 바꾸고(안전 간격이 날 때),
     직진 차는 앞이 막힌 차로를 피해 옆 차로로 옮기기도 한다. 경로는 출발 때와 교차로를 지날 때
     지금 소통 상황(구간마다 최근 통행 시간)으로 다시 고른다.
   ========================================================================== */
'use strict';

const CITY = {
  LW: 3.3,             // 차로 폭
  MED: 0.25,           // 중앙선 반폭
  vLim: 50 * KMH,      // 제한속도
  stub: 170,           // 도시 밖으로 이어지는 도로 길이
  yellow: 3, allRed: 2,
  dt: 0.1,
  turnPen: { L: 14, S: 0, R: 5 },     // 경로 고를 때 회전 벌점 (s)
  vConn: { L: 7.0, S: 50 * KMH, R: 4.6 },   // 교차로 안 속도 상한 (좌회전 반경 ~15 m, 우회전 ~6 m)
};
const CCLASS = [
  { key: 'mini', name: '경차', share: 0.10, len: 3.60, wid: 1.60, hei: 1.52 },
  { key: 'sedan', name: '승용', share: 0.48, len: 4.75, wid: 1.84, hei: 1.45 },
  { key: 'suv', name: 'SUV', share: 0.32, len: 4.70, wid: 1.90, hei: 1.72 },
  { key: 'van', name: '승합', share: 0.10, len: 5.15, wid: 1.99, hei: 1.86 },
];
const SIDES = ['N', 'E', 'S', 'W'];
const SIDE_V = { N: [0, 1], E: [1, 0], S: [0, -1], W: [-1, 0] };

/* ---------- 경로(폴리라인) ---------- */
class CPath {
  constructor(X, Y, step) {
    // 일정 간격으로 다시 뽑는다
    const n = X.length, S = [0];
    for (let i = 1; i < n; i++) S.push(S[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]));
    const L = S[n - 1], m = Math.max(2, Math.round(L / (step || 0.5)) + 1);
    this.x = new Float32Array(m); this.y = new Float32Array(m); this.h = new Float32Array(m);
    let j = 0;
    for (let i = 0; i < m; i++) {
      const s = L * i / (m - 1);
      while (j < n - 2 && S[j + 1] < s) j++;
      const t = clamp((s - S[j]) / ((S[j + 1] - S[j]) || 1), 0, 1);
      this.x[i] = X[j] + (X[j + 1] - X[j]) * t; this.y[i] = Y[j] + (Y[j + 1] - Y[j]) * t;
    }
    for (let i = 0; i < m; i++) { const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1); this.h[i] = Math.atan2(this.y[b] - this.y[a], this.x[b] - this.x[a]); }
    this.n = m; this.len = L; this.step = L / (m - 1);
  }
  at(s, o) {
    o = o || {};
    if (s <= 0) { o.x = this.x[0] + Math.cos(this.h[0]) * s; o.y = this.y[0] + Math.sin(this.h[0]) * s; o.h = this.h[0]; return o; }
    if (s >= this.len) { const e = this.n - 1, d = s - this.len; o.x = this.x[e] + Math.cos(this.h[e]) * d; o.y = this.y[e] + Math.sin(this.h[e]) * d; o.h = this.h[e]; return o; }
    const f = s / this.step, i = Math.min(this.n - 2, f | 0), t = f - i;
    o.x = this.x[i] + (this.x[i + 1] - this.x[i]) * t; o.y = this.y[i] + (this.y[i + 1] - this.y[i]) * t;
    o.h = this.h[i] + wrapPi(this.h[i + 1] - this.h[i]) * t;
    return o;
  }
}

/* ---------- 도로망 ---------- */
function buildCity(cfg) {
  const NX = clamp(cfg.NX | 0, 2, 10), NY = clamp(cfg.NY | 0, 2, 10), B = clamp(+cfg.B || 120, 70, 300), n = clamp(cfg.lanes | 0, 1, 3);
  const LW = CITY.LW, half = CITY.MED + LW * n;          // 도로 반폭 (중앙선 ~ 길가)
  const box = half + 4.5;                                 // 교차로 중심 ~ 정지선 (횡단보도 몫)
  const C = { cfg, NX, NY, B, n, half, box, ints: [], links: [], lanes: [], conns: [], gatesIn: [], gatesOut: [], zones: [] };
  C.W = (NX - 1) * B; C.D = (NY - 1) * B;
  let eid = 0;
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    C.ints.push({ id: C.ints.length, i, j, x: i * B, y: j * B, inL: {}, outL: {}, conns: [], cmap: new Map(), dSum: 0, dN: 0, dEma: 0, los: 'A' });
  }
  const at = (i, j) => (i >= 0 && j >= 0 && i < NX && j < NY ? C.ints[j * NX + i] : null);
  /** 방향 (dx, dy) 으로 달리는 구간. a, b 는 교차로(없으면 게이트 좌표) */
  const mkLink = (ax, ay, bx, by, A, Bn) => {
    const L = Math.hypot(bx - ax, by - ay), dx = (bx - ax) / L, dy = (by - ay) / L;
    const rx = dy, ry = -dx;                               // 진행 방향 오른쪽
    const s0 = A ? box : 0, s1 = L - (Bn ? box : 0);
    const link = { id: C.links.length, from: A, to: Bn, dx, dy, h: Math.atan2(dy, dx), len: s1 - s0, lanes: [], zone: null, tt: 0, ttN: 0 };
    for (let k = 0; k < n; k++) {
      const off = CITY.MED + LW * (k + 0.5);
      const X = [ax + dx * s0 + rx * off, ax + dx * s1 + rx * off], Y = [ay + dy * s0 + ry * off, ay + dy * s1 + ry * off];
      const ln = new CPath(X, Y, 1.0);
      Object.assign(ln, { id: eid++, kind: 'lane', link, k, cars: [], inConns: [], off, req: [] });
      link.lanes.push(ln); C.lanes.push(ln);
    }
    link.tt = link.len / CITY.vLim + (Bn ? 12 : 0);
    C.links.push(link);
    return link;
  };
  for (const I of C.ints) {
    for (const sd of SIDES) {
      const [vx, vy] = SIDE_V[sd], J = at(I.i + vx, I.j + vy);
      if (J) {
        if (!I.outL[sd]) {      // I → J 와 J → I 를 한 번에
          const f = mkLink(I.x, I.y, J.x, J.y, I, J), r = mkLink(J.x, J.y, I.x, I.y, J, I);
          I.outL[sd] = f; J.inL[opp(sd)] = f; J.outL[opp(sd)] = r; I.inL[sd] = r;
          // 안쪽 구간 — 가운데에 건물 출입구 (길가 차로)
          for (const l of [f, r]) { l.zone = { s: l.len / 2, link: l }; C.zones.push(l.zone); }
        }
      } else {                 // 도시 밖 — 들어오는 길 · 나가는 길
        const gx = I.x + vx * (CITY.stub + box), gy = I.y + vy * (CITY.stub + box);
        const inn = mkLink(gx, gy, I.x, I.y, null, I), out = mkLink(I.x, I.y, gx, gy, I, null);
        I.inL[sd] = inn; I.outL[sd] = out; inn.gate = out.gate = { x: gx, y: gy, side: sd, int: I };
        C.gatesIn.push(inn); C.gatesOut.push(out);
      }
    }
  }
  // 교차로 연결로 — 진입로(들어오는 쪽 sd) 에서 나가는 쪽으로
  for (const I of C.ints) {
    for (const sd of SIDES) {
      const Lin = I.inL[sd];
      for (const so of SIDES) {
        if (so === sd) continue;                           // 유턴 없음
        const Lout = I.outL[so];
        const cr = Lin.dx * Lout.dy - Lin.dy * Lout.dx;
        const mv = Math.abs(cr) < 0.5 ? 'S' : cr > 0 ? 'L' : 'R';
        const pairs = mv === 'S' ? [...Array(n).keys()].map((k) => [k, k]) : mv === 'L' ? [[0, 0]] : [[n - 1, n - 1]];
        for (const [ki, ko] of pairs) {
          const a = Lin.lanes[ki], b = Lout.lanes[ko];
          const P0 = a.at(a.len), P1 = b.at(0);
          let X, Y;
          if (mv === 'S') { X = [P0.x, P1.x]; Y = [P0.y, P1.y]; }
          else {                // 두 차로 중심선의 교점을 조절점으로 한 2차 베지어
            const d0x = Math.cos(P0.h), d0y = Math.sin(P0.h), d1x = Math.cos(P1.h), d1y = Math.sin(P1.h);
            const den = d0x * d1y - d0y * d1x, t = ((P1.x - P0.x) * d1y - (P1.y - P0.y) * d1x) / den;
            const cx = P0.x + d0x * t, cy = P0.y + d0y * t;
            X = []; Y = [];
            for (let q = 0; q <= 20; q++) { const u = q / 20, w0 = (1 - u) * (1 - u), w1 = 2 * u * (1 - u), w2 = u * u; X.push(w0 * P0.x + w1 * cx + w2 * P1.x); Y.push(w0 * P0.y + w1 * cy + w2 * P1.y); }
          }
          const cn = new CPath(X, Y, 0.5);
          Object.assign(cn, { id: eid++, kind: 'conn', from: a, to: b, mv, ap: sd, int: I, cars: [], vmax: CITY.vConn[mv] });
          b.inConns.push(cn); I.conns.push(cn); C.conns.push(cn);
          I.cmap.set(a.id + '>' + Lout.id, cn);
        }
      }
    }
  }
  C.edgeCount = eid;
  return C;
}
function opp(sd) { return { N: 'S', S: 'N', E: 'W', W: 'E' }[sd]; }
/** 들어오는 구간 Lin 에서 나가는 구간 Lout 으로 도는 방향 */
function turnOf(Lin, Lout) { const cr = Lin.dx * Lout.dy - Lin.dy * Lout.dx; return Math.abs(cr) < 0.5 ? 'S' : cr > 0 ? 'L' : 'R'; }

/* ---------- 신호 ---------- */
/** 현시 계획 — [{ members: Set('NS' 같은 진입로+회전), g }] 와 주기 */
function signalPlan(cfg) {
  const C = clamp(+cfg.cycle || 100, 40, 200), lost = 4 * (CITY.yellow + CITY.allRed), av = Math.max(28, C - lost);
  const mk = (aps, mvs) => { const s = new Set(); for (const a of aps) for (const m of mvs) s.add(a + m); return s; };
  let ph;
  if (cfg.phase === 'approach') ph = SIDES.map((a) => ({ members: mk([a], 'LSR'), share: 0.25 }));
  else ph = [{ members: mk('NS', 'SR'), share: 0.33 }, { members: mk('NS', 'L'), share: 0.17 }, { members: mk('EW', 'SR'), share: 0.33 }, { members: mk('EW', 'L'), share: 0.17 }];
  for (const p of ph) p.g = Math.max(6, av * p.share);
  const cyc = ph.reduce((a, p) => a + p.g + CITY.yellow + CITY.allRed, 0);
  return { ph, cyc };
}

/* ---------- 차 ---------- */
let cityCarSeq = 0;
class CCar {
  constructor(sim) {
    const rng = sim.rng, c = rng.weighted(CCLASS.map((k) => [k, k.share]));
    this.id = ++cityCarSeq; this.cls = c;
    this.len = c.len * rng.range(0.97, 1.03); this.wid = c.wid; this.hei = c.hei;
    this.color = rng.weighted(CAR_COLORS);
    this.vMul = rng.range(0.88, 1.12);
    this.T = rng.range(1.0, 1.5); this.s0 = rng.range(1.6, 2.4);
    this.a = rng.range(1.2, 1.8); this.b = 2.2; this.sqrtAB = Math.sqrt(this.a * this.b);
    this.edge = null; this.s = 0; this.v = 0; this.acc = 0;
    this.route = []; this.ri = 0; this.conn = null;
    this.lcT = 0; this.lc = 0;                    // 차로 바꾸기 — 쉬는 시간 · 옆으로 남은 거리(그림)
    this.x = 0; this.y = 0; this.z = 0; this.h = 0; this.p = 0;
    this.stopT = 0; this.stops = 0; this.moving = false;
    this.dAp = 0;                                 // 지금 진입로에서 쌓인 지체
    this.brake = false; this.blink = 0;
  }
}

/* ---------- 시뮬레이터 ---------- */
class CitySim {
  constructor(C, cfg) {
    this.C = C; this.cfg = cfg; this.rng = new RNG('city:' + (cfg.seed | 0));
    this.time = 0; this.cars = [];
    this.pendGate = []; this.pendZone = [];        // 길이 막혀 아직 못 나온 차 (출발 시각을 지닌다)
    this.st = { done: 0, trips: [], spawned: 0, hist: [], lost: 0 };
    this.tTrip = this.nextExp(cfg.demand);
    this.histT = 0;
    this.retime();
  }
  /** 신호 계획 · 교차로마다 시작 어긋남 — 신호 방식 · 연동을 바꾸면 다시 부른다 (달리던 차는 그대로) */
  retime() {
    const C = this.C, cfg = this.cfg;
    this.plan = signalPlan(cfg);
    // 연동 — 동서 직진 녹색이 동쪽으로 제한속도의 0.9 배(45 km/h)로 달린 시간만큼 늦게 켜지게 (녹색 물결)
    const prog = CITY.vLim * 0.9;
    for (const I of C.ints) {
      I.offset = cfg.coord ? ((I.x / prog) % this.plan.cyc) : this.rng.range(0, this.plan.cyc);
      // 동서 직진 현시 시작 시각을 맞춘다
      if (cfg.coord) { const p = this.plan.ph; let t0 = 0; const k = cfg.phase === 'approach' ? 3 : 2; for (let q = 0; q < k; q++) t0 += p[q].g + CITY.yellow + CITY.allRed; I.offset = (I.offset + t0) % this.plan.cyc; }
    }
  }
  nextExp(rate) { return rate > 0 ? this.rng.exp(3600 / rate) : Infinity; }

  /** 진입로 ap 의 회전 mv 의 신호 — 'G' · 'Y' · 'R' */
  sig(I, ap, mv) {
    const P = this.plan; let t = (this.time - I.offset) % P.cyc; if (t < 0) t += P.cyc;
    for (const p of P.ph) {
      if (t < p.g) return p.members.has(ap + mv) ? 'G' : 'R';
      t -= p.g;
      if (t < CITY.yellow) return p.members.has(ap + mv) ? 'Y' : 'R';
      t -= CITY.yellow;
      if (t < CITY.allRed) return 'R';
      t -= CITY.allRed;
    }
    return 'R';
  }
  /** 지금 녹색인 현시 번호 (그림 · 표시용) */
  phaseNow(I) {
    const P = this.plan; let t = (this.time - I.offset) % P.cyc; if (t < 0) t += P.cyc;
    for (let q = 0; q < P.ph.length; q++) { const p = P.ph[q], d = p.g + CITY.yellow + CITY.allRed; if (t < d) return { q, t, left: d - t }; t -= d; }
    return { q: 0, t: 0, left: 0 };
  }

  /* ----- 경로 ----- */
  /** 구간 그래프 다익스트라 — 지금 구간 L 에서 목표 구간 goal 까지 (구간 목록, L 포함) */
  route(L, goal) {
    const N = this.C.links.length;
    const dist = this._rd || (this._rd = new Float64Array(N)), prev = this._rp || (this._rp = new Int32Array(N));
    dist.fill(Infinity); prev.fill(-1); dist[L.id] = 0;
    const heap = [[0, L.id]];
    const links = this.C.links;
    while (heap.length) {
      const [d, u] = heapPop(heap);
      if (d > dist[u]) continue;
      if (u === goal.id) break;
      const A = links[u], I = A.to;
      if (!I) continue;
      for (const sd of SIDES) {
        const M = I.outL[sd];
        if (!M || (M.to === A.from && M.from === A.to)) continue;   // 유턴
        const nd = d + M.tt + CITY.turnPen[turnOf(A, M)];
        if (nd < dist[M.id]) { dist[M.id] = nd; prev[M.id] = u; heapPush(heap, [nd, M.id]); }
      }
    }
    if (dist[goal.id] === Infinity) return null;
    const out = []; for (let k = goal.id; k !== -1; k = prev[k]) out.push(links[k]);
    return out.reverse();
  }

  /* ----- 출발 ----- */
  newTrip() {
    const C = this.C, rng = this.rng, pIn = clamp(+this.cfg.inner || 0, 0, 1);
    const fromZone = C.zones.length && rng.chance(pIn), toZone = C.zones.length && rng.chance(pIn);
    const o = fromZone ? { zone: rng.pick(C.zones) } : { gate: rng.pick(C.gatesIn) };
    let d = null;
    for (let k = 0; k < 6 && !d; k++) {
      d = toZone ? { zone: rng.pick(C.zones) } : { gate: rng.pick(C.gatesOut) };
      const oL = o.zone ? o.zone.link : o.gate, dL = d.zone ? d.zone.link : d.gate;
      if (oL === dL || (o.gate && d.gate && o.gate.gate.int === d.gate.gate.int && o.gate.gate.side === d.gate.gate.side)) d = null;
    }
    if (!d) return;
    const t = { o, d, t0: this.time };
    (o.zone ? this.pendZone : this.pendGate).push(t);
  }
  /** 대기 중인 출발을 도로에 올린다 — 자리가 나면 */
  launch() {
    for (const list of [this.pendGate, this.pendZone]) {
      for (let k = 0; k < list.length; k++) {
        if (this.tryLaunch(list[k])) { list.splice(k, 1); k--; }
      }
    }
    // 오래 못 나온 출발은 버린다 (도시가 막혀 들어올 수 없다)
    for (const list of [this.pendGate, this.pendZone]) while (list.length && this.time - list[0].t0 > 600) { list.shift(); this.st.lost++; }
  }
  tryLaunch(t) {
    const L = t.o.zone ? t.o.zone.link : t.o.gate, goal = t.d.zone ? t.d.zone.link : t.d.gate;
    if (t.r === undefined) t.r = this.route(L, goal);      // 경로는 한 번만 — 자리가 날 때까지 기다리는 동안 다시 셈하지 않는다
    const r = t.r;
    if (!r) return true;                       // 갈 수 없는 짝 — 버린다
    const v = new CCar(this);
    v.route = r; v.ri = 0; v.trip = t; v.dest = t.d; v.ff = 0;
    for (let q = 1; q < r.length; q++) v.ff += r[q].len / CITY.vLim;
    let lane, s;
    if (t.o.zone) {                             // 건물 출입구 — 길가 차로 끝에서 끼어든다
      lane = L.lanes[L.lanes.length - 1]; s = t.o.zone.s;
      const { lead, fol } = this.around(lane, s);
      if ((lead && lead.s - lead.len - s < 8) || (fol && s - v.len - fol.s < 6 + fol.v * 1.6)) return false;
      v.v = 0;
    } else {                                    // 도시 밖에서 — 다음 회전에 맞는 차로 중 앞이 가장 빈 곳
      const want = this.wantLanes(v, L);
      let best = null, bs = -1;
      for (const ln of want) { const r0 = ln.cars[0], sp = r0 ? r0.s - r0.len : 1e9; if (sp > bs) { bs = sp; best = ln; } }
      if (bs < v.len + 8) return false;
      lane = best; s = 0; v.v = Math.min(CITY.vLim * 0.7, best.cars[0] ? best.cars[0].v : CITY.vLim * 0.7);
    }
    v.edge = lane; v.s = s; v.tLink = this.time;
    this.insertSorted(lane, v);
    this.pickConn(v);
    this.cars.push(v); this.st.spawned++;
    this.pose(v);
    return true;
  }

  /* ----- 차로 ----- */
  insertSorted(edge, v) { const a = edge.cars; let i = a.length; while (i > 0 && a[i - 1].s > v.s) i--; a.splice(i, 0, v); }
  remove(edge, v) { const a = edge.cars, i = a.indexOf(v); if (i >= 0) a.splice(i, 1); }
  /** 차로 위 s 의 앞차 · 뒤차 */
  around(lane, s) {
    let lead = null, fol = null;
    for (const c of lane.cars) { if (c.s > s) { lead = c; break; } fol = c; }
    return { lead, fol };
  }
  /** 이 구간에서 다음 교차로 회전(또는 출구)에 쓸 수 있는 차로들 */
  wantLanes(v, L) {
    const nx = v.route[v.route.indexOf(L) + 1];
    if (!nx) {
      if (v.dest && v.dest.zone && v.dest.zone.link === L) return [L.lanes[L.lanes.length - 1]];
      return L.lanes;
    }
    const I = L.to, out = [];
    for (const ln of L.lanes) if (I.cmap.has(ln.id + '>' + nx.id)) out.push(ln);
    return out.length ? out : L.lanes;
  }
  pickConn(v) {
    const L = v.edge.link, nx = v.route[v.ri + 1];
    v.conn = nx && L.to ? L.to.cmap.get(v.edge.id + '>' + nx.id) || null : null;
  }

  /* ----- 한 걸음 ----- */
  step(dt) {
    let t = dt;
    while (t > 1e-9) { const h = Math.min(CITY.dt, t); this.sub(h); t -= h; }
  }
  sub(dt) {
    this.time += dt;
    const cfg = this.cfg;
    while (this.time >= this.tTrip) { this.newTrip(); this.tTrip += this.nextExp(cfg.demand); }
    this.launch();
    for (const ln of this.C.lanes) if (ln.req.length) ln.req.length = 0;
    for (const v of this.cars) this.decide(v, dt);
    this.unjam();
    for (const v of this.cars) v.acc = this.accel(v);
    const fin = [];
    for (const v of this.cars) {
      const nv = Math.max(0, v.v + v.acc * dt);
      v.s += (v.v + nv) * 0.5 * dt; v.v = nv;
      v.brake = v.acc < -0.8 || (v.v < 0.1 && v.acc < 0.05);
      if (v.v < 0.3) { v.stopT += dt; if (v.moving) { v.stops++; v.moving = false; } } else { v.stopT = 0; if (v.v > 2) v.moving = true; }
      if (v.edge.kind === 'lane' && v.edge.link.to) v.dAp += dt * (1 - Math.min(1, v.v / CITY.vLim));
      if (v.lc) v.lc = Math.sign(v.lc) * Math.max(0, Math.abs(v.lc) - dt * 1.3);
      v.lcT -= dt;
      if (v.teleport || this.advance(v)) fin.push(v);
    }
    for (const v of fin) this.finish(v);
    for (const v of this.cars) this.pose(v);
    this.histT += dt;
    if (this.histT >= 10) { this.histT = 0; this.record(); }
  }

  /** 차로 바꾸기 (필수 · 임의) — 구간 위 차로에서만 */
  decide(v, dt) {
    const e = v.edge;
    if (e.kind !== 'lane') return;
    const L = e.link, want = this.wantLanes(v, L);
    const dEnd = e.len - v.s;
    const ok = want.includes(e);
    // ★ 끝까지 차로를 못 바꿔 정지선에 8 s 넘게 섰으면, 이 차로에서 갈 수 있는 방향으로 경로를 다시 잡는다
    //   (그대로 두면 그 차로가 영영 막혔다 — 3 차로에서 좌회전 차가 두 칸을 못 옮겨 274 대가 섰다)
    if (!ok && dEnd < 4 && v.v < 0.5 && v.stopT > 8 && L.to) { this.detour(v); return; }
    if (!ok && dEnd < 70) {             // 옆 차로 뒷차에게 끼어들 틈을 부탁한다
      const k = want[0].k > e.k ? e.k + 1 : e.k - 1;
      L.lanes[k].req.push(v);
    }
    if (v.lcT > 0) return;
    let target = null, must = false;
    if (!ok) {             // 필수 — 원하는 차로 쪽으로 한 칸
      const k = want[0].k > e.k ? e.k + 1 : e.k - 1; target = L.lanes[k]; must = true;
    } else if (want.length > 1 && dEnd > 30 && v.v < CITY.vLim * 0.6) {
      // 임의 — 앞이 막힌 차로에서 옆 차로가 훨씬 비었으면
      const me = this.gapAhead(e, v);
      for (const dk of [-1, 1]) {
        const ln = L.lanes[e.k + dk];
        if (!ln || !want.includes(ln)) continue;
        const { lead } = this.around(ln, v.s);
        const g = lead ? lead.s - lead.len - v.s : dEnd;
        if (g > me + 25 && (!lead || lead.v > 1 || g > 40)) { target = ln; break; }
      }
    }
    if (!target) return;
    if (v.dest && v.dest.zone && v.dest.zone.link === L && v.s > v.dest.zone.s) return;
    // 안전 — 옆 차로의 앞뒤 간격
    const { lead, fol } = this.around(target, v.s);
    const gL = lead ? lead.s - lead.len - v.s : 1e9, gF = fol ? v.s - v.len - fol.s : 1e9;
    const need = must && dEnd < 40 ? 0.6 : 1;
    if (gL < (2 + v.v * 0.5) * need || gF < (2.5 + (fol ? fol.v * 0.9 : 0)) * need) return;
    this.remove(e, v); v.edge = target; this.insertSorted(target, v);
    v.lc = e.off - target.off;                  // 그림 — 옛 차로 자리에서 미끄러져 온다 (오른쪽이 +)
    v.lcT = must ? 1.5 : 4;
    this.pickConn(v);
  }
  /** 놓친 회전 — 지금 차로에서 갈 수 있는 길 가운데 목적지까지 가장 빠른 쪽으로 */
  detour(v) {
    const e = v.edge, I = e.link.to, goal = v.dest.zone ? v.dest.zone.link : v.dest.gate;
    let best = null, bc = Infinity;
    for (const cn of I.conns) {
      if (cn.from !== e) continue;
      const r = this.route(cn.to.link, goal);
      if (!r) continue;
      let c = 0; for (const L of r) c += L.tt;
      if (c < bc) { bc = c; best = r; }
    }
    if (best) { v.route = v.route.slice(0, v.ri + 1).concat(best); this.pickConn(v); this.st.detour = (this.st.detour | 0) + 1; }
  }
  /** 교착 해소 — 정지선 맨 앞에서 4 분 넘게 진출 차로 자리를 못 얻은 차는 도로망에서 뺀다 (SUMO 의 teleport 와 같은 마지막 장치) */
  unjam() {
    if ((this._uj = (this._uj || 0) + 1) % 20) return;
    for (const v of this.cars) {
      if (v.stopT < 240 || v.edge.kind !== 'lane') continue;
      const e = v.edge; if (e.cars[e.cars.length - 1] !== v || e.len - v.s > 6) continue;
      v.teleport = true;
    }
  }
  gapAhead(e, v) { const i = e.cars.indexOf(v), l = e.cars[i + 1]; return l ? l.s - l.len - v.s : e.len - v.s; }

  /** 진출 차로에 내 차가 들어갈 자리가 있나 (연결로 위 차 몫까지 뺀다) */
  spaceOK(cn, v) {
    const out = cn.to, r = out.cars[0];
    let room = r ? r.s - r.len : out.len;
    if (r && r.v > 4) room += 10;
    for (const k of out.inConns) for (const c of k.cars) room -= c.len + 2;
    return room > v.len + 2.5;
  }
  /** 적신호 우회전 — 들어갈 차로로 오는 다른 흐름이 없을 때 */
  rtorOK(v) {
    const cn = v.conn, I = cn.int;
    if (!this.spaceOK(cn, v)) return false;
    for (const k of cn.to.inConns) {
      if (k === cn) continue;
      if (k.cars.length) return false;
      if (this.sig(I, k.ap, k.mv) !== 'R') {
        const a = k.from;
        for (let q = a.cars.length - 1; q >= 0; q--) { const c = a.cars[q]; if (a.len - c.s > 45) break; if (c.conn === k) return false; }
      }
    }
    return true;
  }

  accel(v) {
    const e = v.edge;
    const v0 = CITY.vLim * v.vMul;
    let vDes = e.kind === 'conn' ? Math.min(v0, e.vmax) : v0;
    let acc = Infinity;
    const lim = (gap, dv) => { const a = idmAccel(v.v, vDes, gap, dv, v.a, v.T, v.s0, v.sqrtAB); if (a < acc) acc = a; };
    // 앞차 (이 간선 → 다음 간선들, 80 m 까지)
    const i = e.cars.indexOf(v);
    let lead = e.cars[i + 1], gap = lead ? lead.s - lead.len - v.s : 0, dist = e.len - v.s;
    if (!lead) {
      let nx = e.kind === 'lane' ? v.conn : e.to, base = dist;
      for (let hop = 0; nx && hop < 2 && base < 80; hop++) {
        if (nx.cars.length) { lead = nx.cars[0]; gap = base + lead.s - lead.len; break; }
        base += nx.len; nx = nx.kind === 'conn' ? nx.to : null;
      }
    }
    if (lead) lim(gap, v.v - lead.v);
    if (e.kind === 'lane' && e.req.length) {
      for (const r of e.req) {
        const g = r.s - r.len - v.s;
        if (r !== v && g > -1 && g < 25 && v.v < 9) lim(Math.max(0.3, g), v.v - r.v);
      }
    }
    // 앞 교차로 회전 속도에 맞춰 미리 줄인다
    if (e.kind === 'lane' && v.conn && v.conn.mv !== 'S') {
      const vc = v.conn.vmax, va = Math.sqrt(vc * vc + 2 * 1.6 * Math.max(0, dist));
      if (va < vDes) { vDes = va; lim(1e4, 0); }
    }
    if (e.kind === 'lane') {
      const L = e.link;
      // 목적지 출입구 — 길가 차로에서 멈추듯 들어간다
      if (v.dest && v.dest.zone && v.dest.zone.link === L) {
        const ds = v.dest.zone.s - v.s;
        if (ds > 0) { const va = Math.sqrt(2.0 * 2 * ds) + 2.5; if (va < vDes) { vDes = va; lim(1e4, 0); } }
      }
      // 정지선
      if (L.to) {
        let stop = false;
        if (!v.conn) stop = true;                               // 차로를 못 바꿨다 — 끝에서 기다린다
        else if (!v.go) {
          const s = this.sig(L.to, v.conn.ap, v.conn.mv);
          if (s === 'G') stop = !this.spaceOK(v.conn, v);
          else if (s === 'Y') {
            if (v.yDec == null) v.yDec = dist < v.v * v.v / (2 * 3.2) + 1.5;    // 멈출 수 없으면 간다
            stop = !v.yDec;
          } else {
            stop = true;
            if (v.conn.mv === 'R' && v.stopT > 1.5 && dist < 3 && this.rtorOK(v)) { stop = false; v.go = true; }
          }
          if (s !== 'Y') v.yDec = null;
        }
        if (stop) lim(Math.max(0.05, dist - 0.4), v.v);
      } else if (!v.conn && v.route[v.ri + 1]) lim(Math.max(0.05, dist - 0.4), v.v);
    }
    if (acc === Infinity) acc = idmAccel(v.v, vDes, 1e4, 0, v.a, v.T, v.s0, v.sqrtAB);
    return clamp(acc, -8, v.a);
  }

  /** 간선 끝을 넘으면 다음 간선으로 — 끝났으면 true */
  advance(v) {
    const e = v.edge;
    if (e.kind === 'lane' && v.dest && v.dest.zone && v.dest.zone.link === e.link && v.s >= v.dest.zone.s - 0.5) {
      if (e.k === e.link.lanes.length - 1 || v.s > v.dest.zone.s + 25) return true;      // 출입구로 (놓치면 다음에서라도)
    }
    while (v.s >= v.edge.len) {
      const cur = v.edge;
      if (cur.kind === 'lane') {
        if (!cur.link.to) return true;                         // 도시 밖으로
        if (!v.conn) { v.s = cur.len; v.v = 0; return false; }
        this.remove(cur, v); v.s -= cur.len; v.edge = v.conn; v.conn.cars.push(v);
        // 진입로 지체를 교차로에 쌓는다
        const I = cur.link.to; I.dSum += v.dAp; I.dN++; v.dAp = 0;
        v.go = false; v.yDec = null;
      } else {
        const out = cur.to;
        this.remove(cur, v); v.s -= cur.len; v.edge = out; out.cars.unshift(v);
        // 지난 구간 통행 시간 → 경로 고르기용
        const L0 = v.route[v.ri]; const tt = this.time - v.tLink; L0.tt = L0.tt * 0.8 + tt * 0.2; v.tLink = this.time;
        v.ri++;
        // 소통이 바뀌었을 수 있다 — 가끔 다시 고른다
        if (this.rng.chance(0.35)) {
          const goal = v.dest.zone ? v.dest.zone.link : v.dest.gate, r = this.route(out.link, goal);
          if (r) { v.route = v.route.slice(0, v.ri).concat(r); }
        }
        this.pickConn(v);
      }
    }
    return false;
  }
  finish(v) {
    this.remove(v.edge, v);
    const i = this.cars.indexOf(v); if (i >= 0) this.cars.splice(i, 1);
    v.gone = true;
    if (v.teleport) { this.st.unjam = (this.st.unjam | 0) + 1; return; }
    const tt = this.time - v.trip.t0;
    this.st.done++;
    this.st.trips.push({ t: this.time, tt, delay: Math.max(0, tt - v.ff), stops: v.stops, ff: v.ff });
    if (this.st.trips.length > 4000) this.st.trips.shift();
  }

  pose(v) {
    const p = v.edge.at(v.s, this._pp || (this._pp = {}));
    let x = p.x, y = p.y;
    if (v.lc) { x += Math.sin(p.h) * v.lc; y -= Math.cos(p.h) * v.lc; }
    // 앞범퍼 기준 → 차 가운데
    v.h = p.h; v.x = x - Math.cos(p.h) * v.len / 2; v.y = y - Math.sin(p.h) * v.len / 2; v.z = 0; v.p = 0;
  }

  /* ----- 기록 ----- */
  record() {
    const S = this.summary();
    this.st.hist.push({ t: this.time, n: S.n, vAvg: S.vAvg, done: this.st.done, queued: S.queued });
    if (this.st.hist.length > 720) this.st.hist.shift();
    for (const I of this.C.ints) {        // 교차로 지체 → 서비스 수준
      if (I.dN) { const d = I.dSum / I.dN; I.dEma = I.dEma ? I.dEma * 0.7 + d * 0.3 : d; I.dSum = 0; I.dN = 0; }
      I.los = losCity(I.dEma);
    }
  }
  summary() {
    let n = 0, vs = 0, queued = 0;
    for (const v of this.cars) { n++; vs += v.v; if (v.v < 1) queued++; }
    const rec = this.st.trips.filter((t) => this.time - t.t < 600);
    const avg = (f) => (rec.length ? rec.reduce((a, t) => a + f(t), 0) / rec.length : 0);
    return {
      n, vAvg: n ? vs / n : 0, queued, done: this.st.done, perH: Math.round(rec.length * 3600 / Math.max(60, Math.min(600, this.time))),
      tt: avg((t) => t.tt), delay: avg((t) => t.delay), stops: avg((t) => t.stops), waiting: this.pendGate.length + this.pendZone.length, lost: this.st.lost,
      unjam: this.st.unjam | 0, detour: this.st.detour | 0,
    };
  }
}
/** HCM 신호교차로 서비스 수준 — 차당 제어지체 (s) */
function losCity(d) { return d <= 10 ? 'A' : d <= 20 ? 'B' : d <= 35 ? 'C' : d <= 55 ? 'D' : d <= 80 ? 'E' : 'F'; }

/* ---------- 작은 이진 힙 ---------- */
function heapPush(h, x) { h.push(x); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; } }
function heapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && h[l][0] < h[m][0]) m = l; if (r < h.length && h[r][0] < h[m][0]) m = r; if (m === i) break; [h[m], h[i]] = [h[i], h[m]]; i = m; } }
  return top;
}
