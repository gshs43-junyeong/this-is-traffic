/* =============================================================================
   park.js — 주차장 안의 미시 교통 (차량 단위)

   주행     : IDM (traffic.js 의 idmAccel 을 그대로 쓴다). 주차장 서행값으로 다시 맞춘
              v0 ≈ 10 km/h, T = 1.0 s, s0 = 1.5 m. 모서리는 곡률 제한속도(횡가속 1.1 m/s²).
   합류     : 합류점을 한 대씩 예약한다(먼저 온 차 우선). 본선(순환로 · 도로) 차가
              3.5 s 안에 닿으면 곁가지 차는 들어가지 않는다(간격 수락).
              나가는 쪽에 자리가 없으면 예약하지 않는다(교차로 막기 금지).
   주차     : 탐색 차는 앞 2~16 m 의 빈 면을 보고 고른다. 후면주차(후진 진입, 한국에서 흔함)는
              면을 지나쳐 멈춘 뒤 원호로 후진하고, 뒤차는 면 앞에서 기다린다. 전면주차는
              감속하며 바로 돌아 들어간다. 조작 동안 통로의 그 구간은 막힌다.
   출차     : 통로가 비었을 때만 빠져나온다(뒤에서 오는 차의 정지거리까지 확인).
   탐색     : 유도 시스템이 없으면 아직 보지 않은 가장 가까운 통로를 차례로 돈다
              (층을 다 보면 다음 층). 통로 입구에서 빈 면이 하나도 안 보이면 75 % 는 건너뛴다.
              유도 시스템이 있으면 차단기에서 빈 면을 하나 배정받아 최단경로로 간다.
   ========================================================================== */
'use strict';

const PCLASS = [
  { key: 'mini', name: '경차', share: 0.10, len: 3.60, wid: 1.60, hei: 1.52 },
  { key: 'sedan', name: '승용', share: 0.48, len: 4.75, wid: 1.84, hei: 1.45 },
  { key: 'suv', name: 'SUV', share: 0.32, len: 4.70, wid: 1.90, hei: 1.72 },
  { key: 'van', name: '승합', share: 0.10, len: 5.15, wid: 1.99, hei: 1.86 },
];
const PDT = 0.05;
const R_REV = 4.6, R_FWD = 4.0, R_OUT = 4.4;
const V_MAN_F = 1.35, V_MAN_R = 0.85;

let carSeq = 0;
class PCar {
  constructor(sim, role, forceKey) {
    const rng = sim.rng;
    const c = forceKey ? PCLASS.find((k) => k.key === forceKey) : rng.weighted(PCLASS.map((k) => [k, k.share]));
    this.id = ++carSeq; this.cls = c; this.role = role;
    this.len = c.len * rng.range(0.97, 1.03); this.wid = c.wid; this.hei = c.hei;
    this.wb = this.len * 0.6; this.ohF = this.len * 0.2; this.ohR = this.len * 0.2;
    this.color = rng.weighted(CAR_COLORS);
    this.mode = 'drive';
    this.edge = null; this.s = 0; this.v = 0; this.acc = 0;
    this.route = []; this.ri = 0; this.path = null;
    this.prev = null;
    this.vMul = rng.range(0.85, 1.18);
    this.T = rng.range(0.85, 1.25); this.s0 = rng.range(1.2, 1.9);
    this.a = rng.range(1.0, 1.5); this.b = 1.9;
    this.sqrtAB = Math.sqrt(this.a * this.b);
    this.stall = null; this.plan = null; this.man = null;
    this.visited = new Set(); this.seen = new Set();
    this.res = [];              // 예약한 합류 노드들
    this.blink = 0; this.brake = false; this.rev = false;
    this.x = 0; this.y = 0; this.z = 0; this.h = 0; this.p = 0;
    this.t0 = sim.time; this.tGate = 0; this.tPark = 0; this.tReq = 0; this.waitT = 0; this.stopT = 0;
    this.searching = false; this.leaving = false; this.pref = 1;
    this.blinkPhase = rng.next();
    // 전용 구획 자격 — 장애인 표지 4 %, 전기차 15 % (경차 제외), 경형 구획은 경차만
    this.dis = rng.chance(0.04); this.ev = c.key !== 'mini' && rng.chance(0.15);
    this.rude = rng.chance(0.04);          // 전용 구획을 무시하는 운전자
  }
}

/** 이 차가 이 면을 써도 되는가 (전용 구획) */
function stallOk(v, s) {
  if (!s.type || s.type === 'gen') return true;
  if (v.rude) return s.type !== 'dis';
  if (s.type === 'dis') return v.dis;
  if (s.type === 'ev') return v.ev;
  if (s.type === 'mini') return v.cls.key === 'mini';
  return true;
}

class ParkSim {
  constructor(G, cfg) {
    this.G = G; this.cfg = cfg;
    this.rng = new RNG('park:' + (cfg.seed | 0));
    this.time = 0;
    this.cars = [];
    this.tIn = this.nextExp(cfg.inRate); this.tOut = this.nextExp(cfg.outRate);
    this.tThru = this.nextExp(cfg.thruRate); this.tThruE = this.nextExp(cfg.thruRate);
    this.pending = 0;
    this.st = { inN: 0, outN: 0, lost: 0, gaveUp: 0, search: [], exitT: [], queueT: [], hist: [] };
    this.histT = 0;
    this.peds = [];
    this.prefill(cfg.initOcc);
  }
  /** 통로 고장 — 통로를 달리던 차 한 대가 2~4 분 비상등을 켜고 선다 */
  incident() {
    if (this.brokenCar) return null;
    const c = this.act.filter((v) => v.mode === 'drive' && v.inside && v.v > 0.5 && v.edge && (v.edge.kind === 'loop' || v.edge.kind === 'aisle'));
    if (!c.length) return null;
    const v = this.rng.pick(c);
    v.broken = true; v.brokenUntil = this.time + this.rng.range(120, 240); v.blink = 2;
    this.brokenCar = v;
    return v;
  }
  /** 지금 n 대를 더 들여보낸다 (앞 도로에 차례로 나타난다) */
  addArrivals(n) { this.batch = (this.batch || 0) + n; }
  /** 세워 둔 차 n 대에게 지금 출차를 시킨다 (오래 세운 차부터) */
  addDepartures(n) {
    const cand = this.cars.filter((v) => v.mode === 'parked' && !v.leaving).sort((a, b) => a.tPark - b.tPark);
    let k = 0;
    for (const v of cand) { if (k >= n) break; this.callDriver(v); k++; }
    return k;
  }
  /** 시각 (0~24 h) — 하루 패턴은 아침 7 시에서 시작한다 */
  hour() { return ((this.cfg.pattern && this.cfg.pattern !== 'flat' ? 7 : 0) + this.time / 3600) % 24; }
  /** 시각별 수요 비율 (최대 1). 업무시설: 출근 8~9 시 · 퇴근 18~19 시, 상가: 오후 · 저녁 */
  profile() {
    const P = this.cfg.pattern;
    if (!P || P === 'flat') return { in: 1, out: 1, thru: 1 };
    const h = this.hour(), g = (c, w) => Math.exp(-0.5 * ((h - c) / w) ** 2);
    if (P === 'office') return {
      in: Math.min(1, 0.03 + g(8.4, 0.7) + 0.1 * g(13.1, 0.5) + 0.06 * g(19.5, 1.2)),
      out: Math.min(1, 0.015 + g(18.3, 0.8) + 0.08 * g(12.1, 0.5) + 0.03 * g(15, 2)),
      thru: Math.min(1, 0.25 + 0.75 * Math.max(g(8.3, 1.2), g(18.3, 1.3))),
    };
    return {          // 상가 · 쇼핑
      in: Math.min(1, 0.03 + 0.55 * g(12.3, 1.2) + g(16.5, 2.0) + 0.6 * g(19.5, 1.2)),
      out: Math.min(1, 0.03 + 0.45 * g(14, 1.3) + 0.9 * g(18.8, 2.0) + 0.7 * g(21.2, 0.9)),
      thru: Math.min(1, 0.3 + 0.7 * g(17.5, 3)),
    };
  }
  nextExp(rate) { return rate > 0 ? this.rng.exp(3600 / rate) : Infinity; }

  /* ---------- 시작 점유 ---------- */
  prefill(frac) {
    const st = this.G.stalls.slice();
    for (let i = st.length - 1; i > 0; i--) { const j = Math.floor(this.rng.next() * (i + 1)); const t = st[i]; st[i] = st[j]; st[j] = t; }
    const n = Math.round(st.length * clamp(frac, 0, 1));
    for (let i = 0; i < n; i++) {
      const s = st[i];
      // 전용 구획에는 자격 있는 차를 — 장애인전용은 절반쯤 비워 둔다
      if (s.type === 'dis' && this.rng.chance(0.5)) continue;
      const v = new PCar(this, 'park', s.type === 'mini' ? 'mini' : null);
      if (s.type === 'dis') v.dis = true;
      if (s.type === 'ev') v.ev = true;
      this.parkAt(v, s, this.rng.chance(this.cfg.revShare) ? 'out' : 'in');
      v.tPark = -this.rng.range(0, 3600);
      this.cars.push(v);
    }
  }
  /** 면에 세워 둔다. nose: 'out' = 후면주차(머리가 통로 쪽), 'in' = 전면주차 */
  parkAt(v, s, nose) {
    v.mode = 'parked'; v.stall = s; v.nose = nose; v.v = 0; v.edge = null;
    s.state = 'occ'; s.car = v;
    const j = this.rng;
    v.x = s.cx + s.ax * j.range(-0.15, 0.15); v.y = s.cy + s.ay * j.range(-0.15, 0.15);
    // 차 중심은 면 중심에서 통로 반대쪽으로 조금 — 앞범퍼가 면 끝선에 닿게
    const back = (PK.stallL - v.len) * 0.5 - 0.15;
    v.x += s.nx * back * 0.6; v.y += s.ny * back * 0.6;
    v.z = s.z; v.p = 0;
    v.h = (nose === 'out' ? Math.atan2(-s.ny, -s.nx) : Math.atan2(s.ny, s.nx)) + j.range(-0.03, 0.03);
    v.blink = 0; v.brake = false; v.rev = false; v.inside = true;
    this.dirty = true; this.actDirty = true;
  }

  /* ---------- 진행 ---------- */
  step(dtTotal) {
    let t = dtTotal;
    while (t > 1e-6) {
      const dt = Math.min(PDT, t);
      this.sub(dt);
      t -= dt;
    }
  }
  sub(dt) {
    const G = this.G, cfg = this.cfg;
    this.time += dt;
    // 도착 — 주차하러 오는 차 · 통과 교통
    /* 하루 패턴이면 설정값을 최대치로 두고 시각별 비율로 솎아 낸다(비균질 포아송 — thinning) */
    const pf = this.profile();
    if (this.time >= this.tIn) { if (this.rng.next() < pf.in) this.pending++; this.tIn = this.time + this.nextExp(cfg.inRate); }
    if (this.pending > 0 && this.spawn(G.streetIn, 'park')) this.pending--;
    if (this.batch > 0) { const v = this.spawn(G.streetIn, 'park'); if (v) { v.noBalk = true; this.batch--; } }   // 일부러 보낸 차는 지나치지 않는다
    if (this.time >= this.tThru) { if (this.rng.next() > pf.thru || this.spawn(G.streetIn, 'thru')) this.tThru = this.time + this.nextExp(cfg.thruRate); }
    if (this.time >= this.tThruE) { if (this.rng.next() > pf.thru || this.spawn(G.streetEB, 'thru')) this.tThruE = this.time + this.nextExp(cfg.thruRate); }
    // 출차 요청 — 세워 둔 차 하나를 고른다
    if (this.time >= this.tOut && this.rng.next() >= pf.out) this.tOut = this.time + this.nextExp(cfg.outRate);
    if (this.time >= this.tOut) {
      this.tOut = this.time + this.nextExp(cfg.outRate);
      // 무작위로 몇 번 뽑아 보고(수천 대를 매번 훑지 않게), 안 되면 전부 훑는다
      const ok = (v) => v && v.mode === 'parked' && !v.leaving && this.time - v.tPark > 45;
      let pick = null;
      for (let t = 0; t < 30 && !pick; t++) { const v = this.cars[Math.floor(this.rng.next() * this.cars.length)]; if (ok(v)) pick = v; }
      if (!pick) { const cand = this.cars.filter(ok); if (cand.length) pick = this.rng.pick(cand); }
      if (pick) this.callDriver(pick);
    }
    // 움직이는 차만 돈다 — 세워 둔 차는 출차할 때까지 건드리지 않는다
    if (this.actDirty || !this.act) this.rebuildAct();
    for (const v of this.act) {
      if (v.mode === 'drive') this.drive(v, dt);
      else if (v.mode === 'man') this.maneuver(v, dt);
      else if (v.mode === 'parked' && v.leaving) {
        if (v.driverAway) continue;          // 운전자가 아직 차로 걸어오는 중
        v.tryT -= dt;
        if (v.tryT <= 0) { v.tryT = 0.5; this.tryUnpark(v); }
        v.blink = (v.nose === 'out' ? 1 : -1) * v.stall.side * -1;
      }
    }
    // 간선 위 차 정렬
    for (const ed of G.edges) if (ed.cars.length > 1) sortByS(ed.cars);
    if (this.peds.length) this.walk(dt);
    if (this.brokenCar && this.time > this.brokenCar.brokenUntil) { this.brokenCar.broken = false; this.brokenCar.blink = 0; this.brokenCar = null; }
    // 교착 풀기 — 합류점 앞에서 4 분 넘게 선 차는 경로 앞의 빈자리로 옮긴다 (SUMO 의 teleport 와 같은 장치)
    this.jamT = (this.jamT || 0) + dt;
    if (this.jamT > 5) {
      this.jamT = 0;
      for (const v of this.act) if (v.mode === 'drive' && v.stopT > 240 && v.why instanceof PNode) this.unjam(v);
    }
    // 기록
    this.histT += dt;
    if (this.histT >= 10) { this.histT = 0; this.record(); }
  }

  rebuildAct() {
    let k = 0;
    for (const v of this.cars) if (v.mode !== 'done') this.cars[k++] = v;
    this.cars.length = k;
    this.act = this.cars.filter((v) => v.mode === 'drive' || v.mode === 'man' || (v.mode === 'parked' && v.leaving));
    this.actDirty = false;
  }
  spawn(ed, role) {
    const last = ed.cars[0];
    if (last && last.s - last.len < 14) return false;
    const v = new PCar(this, role);
    v.edge = ed; v.s = 2; v.v = ed.vmax * 0.85; v.route = [ed]; v.ri = 0;
    if (role === 'park') {
      const G = this.G;
      v.pref = G.B === 0 ? 1 : G.U === 0 ? -1 : (this.rng.chance(G.B / (G.U + G.B)) ? -1 : 1);
      v.tArr = this.time;
    }
    ed.cars.unshift(v);
    this.cars.push(v); this.actDirty = true;
    this.planAhead(v);
    this.pose(v);
    return v;
  }

  /* ---------- 경로 ---------- */
  planAhead(v, n) {
    while (v.route.length - v.ri < (n || 4)) {
      const last = v.route[v.route.length - 1];
      const nd = last.to;
      if (!nd.outs.length) break;
      const nx = this.choose(v, nd);
      if (!nx) break;
      v.route.push(nx);
    }
  }
  choose(v, nd) {
    const outs = nd.outs;
    if (outs.length === 1) return outs[0];
    // 차단기 차로가 둘이면 줄이 짧은 쪽으로
    if (outs.every((e) => e.gate)) {
      let best = outs[0], bc = Infinity;
      for (const e of outs) { const c = e.cars.length + (e.gate.busy ? 1 : 0) + this.rng.next() * 0.5; if (c < bc) { bc = c; best = e; } }
      return best;
    }
    if (v.role === 'thru' || v.done) return outs.find((e) => e.kind === 'street') || outs[0];
    if (v.path && v.path.length) {
      if (v.path[0].from === nd) return v.path.shift();
      v.path = null;
    }
    const G = this.G;
    if (v.leaving || v.giveUp) {
      const p = routeTo(G, nd, G.exit) || [];
      v.path = p; return v.path.shift() || outs[0];
    }
    if (!v.inside) {   // 도로 위 — 진입로로
      const ent = outs.find((e) => e.kind === 'entry');
      if (ent && !v.balk) return ent;
      return outs.find((e) => e.kind === 'street');
    }
    if (v.stall) {
      const p = routeTo(G, nd, v.stall.ed, true);
      if (p) { v.path = p; return v.path.shift(); }
    }
    return this.searchChoice(v, nd);
  }
  /** 탐색 — 아직 안 본 가장 가까운 주차 통로로 (층을 옮기면 벌점, 선호 방향을 거스르면 큰 벌점) */
  searchChoice(v, nd) {
    const G = this.G, rng = this.rng;
    // 통로 입구에서 들여다보기 — 빈 면이 안 보이면 대개 건너뛴다
    for (const e of nd.outs) {
      if (e.kind === 'aisle' && !v.visited.has(e.id) && !v.seen.has('g' + e.id)) {
        v.seen.add('g' + e.id);
        let free = 0; for (const s of e.stalls) if ((s.state === 'free' || (s.state === 'leave' && s.car && !s.car.driverAway)) && stallOk(v, s)) free++;
        if (!free && rng.chance(0.75)) v.visited.add(e.id);
        else if (free) v.seen.add('f' + e.id);
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      const best = this.nearestUnvisited(v, nd);
      if (best) return best;
      v.visited.clear(); v.seen.clear();   // 다 봤다 — 처음부터 다시 돈다
    }
    return nd.outs.find((e) => e.kind !== 'exit') || nd.outs[0];
  }
  nearestUnvisited(v, nd) {
    const G = this.G, N = G.nodes.length;
    const dist = this._d || (this._d = new Float64Array(N));
    const first = this._f || (this._f = new Array(N));
    dist.fill(Infinity); first.fill(null);
    dist[nd.id] = 0;
    const open = [nd], done = this._dn || (this._dn = new Uint8Array(N)); done.fill(0);
    let best = null, bc = Infinity;
    const lv0 = nd.level;
    while (open.length) {
      let bi = 0; for (let i = 1; i < open.length; i++) if (dist[open[i].id] < dist[open[bi].id]) bi = i;
      const u = open[bi]; open[bi] = open[open.length - 1]; open.pop();
      if (done[u.id]) continue; done[u.id] = 1;
      if (dist[u.id] > bc) break;
      for (const ed of u.outs) {
        if (ed.kind === 'exit' || ed.kind === 'street') continue;
        const f = u === nd ? ed : first[u.id];
        if (ed.stalls.length && !v.visited.has(ed.id)) {
          const dl = ed.level - lv0;
          /* 면이 많은 통로를 먼저 (같은 거리에서 둘레길 3 면보다 통로 16 면을 고른다).
             입구에서 들여다보고 빈 면을 본 통로는 더 끌린다 */
          let c = dist[u.id] + Math.abs(dl) * 45 - Math.min(30, ed.stalls.length * 2);
          if (v.seen.has('f' + ed.id)) c -= 25;
          if (dl !== 0 && Math.sign(dl) !== v.pref) c += 350;
          if (c < bc) { bc = c; best = f; }
        }
        const w = ed.len + (ed.kind === 'rampA' || ed.kind === 'rampB' ? 8 : 0) + (ed.cars.some((c) => c.broken) ? 120 : 0);
        const to = ed.to;
        if (dist[u.id] + w < dist[to.id]) { dist[to.id] = dist[u.id] + w; first[to.id] = f; open.push(to); }
      }
    }
    return best;
  }

  /* ---------- 주행 ---------- */
  drive(v, dt) {
    const acc = this.accel(v);
    v.brake = acc < -0.6 || (v.v < 0.05 && acc < 0.05);
    v.acc = acc;
    const nv = Math.max(0, v.v + acc * dt);
    v.s += (v.v + nv) * 0.5 * dt;
    v.v = nv;
    if (v.v < 0.1) v.stopT += dt; else v.stopT = 0;
    if (v.searching && v.inside && v.edge) v.edge.hunt = (v.edge.hunt || 0) + dt;   // 탐색 열지도
    // 간선 넘기기
    while (v.edge && v.s > v.edge.len) {
      const nx = v.route[v.ri + 1];
      if (!nx) {
        if (this.G.sinks.has(v.edge.to.id)) { this.finish(v); return; }
        v.s = v.edge.len; v.v = 0; break;
      }
      v.s -= v.edge.len;
      this.moveTo(v, nx);
    }
    if (v.mode !== 'drive') return;
    this.releaseRes(v);
    if (v.role === 'park' && !v.inside && !v.balkChk && !v.noBalk && v.edge === this.G.streetIn && v.edge.len - v.s < 45) {
      v.balkChk = true;
      // 입구 대기열이 길거나 '만차' 표시가 켜져 있으면 대개 들어가지 않고 지나간다
      const S = this.summary();
      if (S.qIn >= this.cfg.balk || (S.free - S.hunting <= 0 && this.rng.chance(0.8))) { v.balk = true; this.st.lost++; v.role = 'thru'; v.route.length = v.ri + 1; this.planAhead(v); }
    }
    // ★ 면을 잡았거나 주차 계획이 있는 차는 포기시키지 않는다 — 계획(후진 대기 구간)을 쥔 채 포기하면 통로가 영영 막힌다
    // 도로에서 입구 차례를 기다리다 만차가 이어지면 포기하고 지나간다 (진입로에 들어선 차는 차단기 앞에서 기다린다)
    if (v.role === 'park' && !v.inside && v.edge.kind === 'street' && v.stopT > 45 && (v.stopT > 120 || !this.admit())) {
      v.balk = true; this.st.lost++; v.role = 'thru'; v.route.length = v.ri + 1; v.path = null; this.planAhead(v);
    }
    if (v.inside && v.searching && !v.giveUp && !v.stall && !v.plan && this.time - v.tGate > 720) {
      v.giveUp = true; v.searching = false; this.st.gaveUp++;
      if (v.stall) { if (v.stall.next === v) v.stall.next = null; else if (v.stall.car === v) { v.stall.state = 'free'; v.stall.car = null; } v.stall = null; }
      v.waitFor = false; v.route.length = v.ri + 1; v.path = null; this.planAhead(v);
    }
    if (v.waitFor) {
      v.waitT = (v.waitT || 0) + dt;
      if (v.waitT > 45 || !v.stall || v.stall.next !== v) {
        if (v.stall && v.stall.next === v) v.stall.next = null;
        if (v.stall && v.stall.car === v && v.stall.state === 'res') { v.stall.state = 'free'; v.stall.car = null; }
        if (!v.plan) v.stall = null;
        v.waitFor = false; v.waitT = 0;
      }
    }
    this.gateLogic(v, dt);
    if (v.mode !== 'drive') return;
    if (v.inside && !v.leaving && !v.giveUp) this.parkLogic(v, dt);
    this.pose(v);
    // 갈림길에서 꺾기 전 방향지시등 (15 m 앞까지)
    v.tbT = (v.tbT || 0) - dt;
    if (v.tbT <= 0) {
      v.tbT = 0.5; v.tblink = 0;
      let d = v.edge.len - v.s;
      for (let i = v.ri; i < v.route.length - 1 && d < 15; i++) {
        const e = v.route[i], nx = v.route[i + 1];
        if (e.to.outs.length > 1) {
          const dh = wrapPi(nx.at(Math.min(5, nx.len)).h - e.h[e.n - 1]);
          if (Math.abs(dh) > 0.6) v.tblink = Math.sign(dh);
          break;
        }
        d += nx.len;
      }
    }
  }
  moveTo(v, nx) {
    const old = v.edge;
    const i = old.cars.indexOf(v); if (i >= 0) old.cars.splice(i, 1);
    // 차단기 차로가 짧으면 꽁무니가 차단기를 지나기 전에 다음 간선으로 넘어간다 — 그때 닫는다
    if (old.gate && old.gate.open === v) { old.gate.open = null; old.gate.close = 1; }
    v.prev = old;
    v.edge = nx; v.ri++;
    nx.cars.push(v);
    if (nx.stalls.length && v.searching) v.visited.add(nx.id);
    // 경로는 짧게 유지
    if (v.ri > 6) { v.route.splice(0, v.ri - 1); v.ri = 1; }
    this.planAhead(v);
  }
  finish(v) {
    const i = v.edge.cars.indexOf(v); if (i >= 0) v.edge.cars.splice(i, 1);
    this.dropRes(v);
    v.mode = 'done'; this.actDirty = true;
  }

  /** 앞을 훑어 가장 강한 감속 요인을 IDM 으로 낸다 */
  accel(v) {
    const G = this.G;
    if (v.broken) { v.why = 'broken'; return -Math.min(3, v.v / 0.3 + 0.5); }      // 고장 — 그 자리에 선다
    let ed = v.edge, base = -v.s, k = v.ri;
    // 희망속도 — 간선 제한 · 탐색 서행 · 앞쪽 곡률
    let v0 = ed.vmax * v.vMul;
    if (v.searching && ed.stalls.length) v0 = Math.min(v0, 2.1 * v.vMul);
    let acc = Infinity;
    const look = 8 + v.v * 6;
    let curv = Infinity;
    const self = v;
    let why = null;
    const obst = (gap, vl, w) => {
      const a = idmAccel(v.v, v0, gap, v.v - vl, v.a, v.T, v.s0, v.sqrtAB);
      if (a < acc) { acc = a; why = w; }
    };
    let leaderFound = false;
    for (let guard = 0; guard < 6 && ed; guard++) {
      // 곡률
      for (let d = Math.max(0, -base); d < ed.len && base + d < 14; d += 1.0) {
        const vc = ed.vcAt(d), dd = Math.max(0, base + d);
        const va = Math.sqrt(vc * vc + 2 * 0.9 * dd);
        if (va < curv) curv = va;
      }
      // 앞차
      if (!leaderFound) {
        let best = null, bs = Infinity;
        for (const c of ed.cars) {
          if (c === self) continue;
          const d = base + c.s;
          if (d > 0.01 && d < bs) { bs = d; best = c; }
        }
        if (best) { obst(bs - best.len, best.v, best); leaderFound = true; }
      }
      // 막힌 구간
      for (const b of ed.blk) {
        if (b.own === self) continue;
        // 주행 중인 차가 건 구간(후면주차 대기)은 그 차 뒤에서 오는 차에게만 해당한다
        if (b.own.mode === 'drive' && b.own.edge === ed && b.own.s < -base) continue;
        const d0 = base + b.s0, d1 = base + b.s1;
        if (d1 <= 0) continue;
        if (d0 < -0.3) continue;            // 이미 그 안에 있다 — 소유자가 자리를 확인하고 막았다
        obst(Math.max(0.1, d0), 0, b);
      }
      // 주차 정지 목표
      if (v.plan && v.plan.ed === ed) {
        if (v.plan.how === 'rev' && !v.plan.go) obst(Math.max(0.05, base + v.plan.sStop + v.s0 - 0.01), 0);
        if (v.plan.how === 'fwd') { const d = Math.max(0, base + v.plan.sTurn); v0 = Math.min(v0, Math.sqrt(V_MAN_F * V_MAN_F + 2 * 1.1 * d)); }
      }
      // 나가는 차를 기다린다 — 그 차의 조작 구간 뒤에서
      if (v.waitFor && v.stall && v.stall.ed === ed && v.stall.car) {
        const hold = v.stall.s - (v.stall.car.nose === 'in' ? 11.5 : 6.5);
        if (base + hold > -0.5) obst(Math.max(0.05, base + hold + v.s0), 0);
      }
      // 차단기
      if (ed.gate && ed.gate.open !== self) {
        const d = base + ed.gate.s;
        if (d > -0.3) obst(Math.max(0.05, d + v.s0 - 0.8), 0, ed.gate);
      }
      // 합류점
      const nd = ed.to, dN = base + ed.len;
      // 앞에 차가 끼어들었으면(출차 등) 쥔 예약을 놓는다 — 줄의 맨 앞 차만 합류점을 쥔다
      if (nd.res === self && leaderFound) { nd.res = null; const ri = v.res.indexOf(nd); if (ri >= 0) v.res.splice(ri, 1); }
      if (nd.ins.length > 1 && nd.res !== self) {
        const need = v.v * v.v / (2 * 1.4) + 5;
        // 줄의 맨 앞 차만 예약한다 (뒤차가 먼저 잡으면 앞차가 못 들어가 서로 막힌다)
        if (!nd.res && !leaderFound && dN < need && this.canEnter(v, ed, nd, v.mWait > 3, k)) { nd.res = self; v.res.push(nd); v.mWait = 0; }
        if (nd.res !== self) {
          obst(Math.max(0.05, dN - 0.6), 0, nd);
          if (dN < 4 && v.v < 0.4) v.mWait = (v.mWait || 0) + PDT;    // 합류를 기다린 시간 — 길어지면 끼어든다(지퍼)
        }
      }
      // 길이 끝 (경로가 안 정해졌다)
      const nx = v.route[k + 1];
      if (!nx) { if (!G.sinks.has(nd.id)) obst(Math.max(0.05, dN), 0, 'end'); break; }
      base += ed.len; k++;
      ed = nx;
      if (base > look + 20) break;
    }
    // 차 앞을 건너는 사람 — 차체 폭 + 0.6 m 안, 9 m 앞까지
    if (this.peds.length && v.inside !== false) {
      const ch = Math.cos(v.h), sh = Math.sin(v.h), fx = v.x + ch * v.len / 2, fy = v.y + sh * v.len / 2;
      for (const p of this.peds) {
        if (p.delay > 0 || Math.abs(p.z - v.z) > 1.3) continue;
        const dx = p.x - fx, dy = p.y - fy, al = dx * ch + dy * sh, lt = -dx * sh + dy * ch;
        if (al > -0.6 && al < 9 && Math.abs(lt) < v.wid / 2 + 0.6) obst(Math.max(0.1, al - 0.9), 0, p);
      }
    }
    v.why = why;
    if (curv < v0) v0 = curv;
    if (acc === Infinity) acc = idmAccel(v.v, v0, 1e4, 0, v.a, v.T, v.s0, v.sqrtAB);
    else acc = Math.min(acc, idmAccel(v.v, v0, 1e4, 0, v.a, v.T, v.s0, v.sqrtAB));
    // 정지 마찰 — 멈춘 차가 아주 작은 가속으로 기어가지 않게
    return clamp(acc, -7, v.a);
  }
  /** 합류 간격 수락 + 나가는 쪽 여유 */
  canEnter(v, ed, nd, urgent, k) {
    // 나가는 쪽 여유 — 내 경로를 따라 차 길이 + 1 m 안에 선 차나 막힌 구간이 있으면 들어가지 않는다
    const need = v.len + 1.0;
    let off = 0;
    for (let i = k + 1; i < v.route.length && off < need; i++) {
      const out = v.route[i];
      let tail = Infinity;
      for (const c of out.cars) if (c !== v && c.s - c.len < tail) tail = c.s - c.len;
      for (const b of out.blk) if (b.own !== v && !(b.own.mode === 'drive' && b.own.edge === out) && b.s0 < tail) tail = b.s0;
      if (off + tail < need) return false;
      off += out.len;
    }
    const major = nd.ins.find((e) => e.kind === 'loop' || e.kind === 'street');
    if (major && major !== ed) {
      /* 간격 수락 2.8 s. 3 초 넘게 기다린 차는 본선 차가 바로 앞(6 m)만 아니면 들어간다 —
         본선 차가 예약을 보고 양보한다(실제 주차장의 교대 합류). 이것이 없으면 붐비는 순환로가
         경사로 도착 차를 끝없이 세워 두고, 그 줄이 위층 순환로까지 올라가 고리로 막힌다 */
      const tGap = urgent ? 0 : 2.8, dMin = urgent ? 6 : 4;
      const chk = (E, extra) => {
        for (const c of E.cars) {
          if (c === v) continue;
          const d = E.len - c.s + extra;
          if (d < 0) continue;
          if (d / Math.max(c.v, 0.6) < tGap && d < 30) return true;
          if (d < dMin) return true;
        }
        return false;
      };
      if (chk(major, 0)) return false;
      for (const P of major.from.ins) if (chk(P, major.len)) return false;
    }
    return true;
  }
  /** 예약한 합류점을 차 꽁무니가 지나면 놓는다 (경로상 아직 앞에 있으면 붙든다) */
  releaseRes(v) {
    if (!v.res.length) return;
    for (let k = v.res.length - 1; k >= 0; k--) {
      const nd = v.res[k];
      let passed = true;
      for (let i = v.ri; i < v.route.length; i++) {
        const e = v.route[i];
        if (e.to === nd) { passed = false; break; }
        if (e.from === nd) { passed = v.s - v.len > 0.8; break; }
      }
      if (passed) { if (nd.res === v) nd.res = null; v.res.splice(k, 1); }
    }
  }
  dropRes(v) { for (const nd of v.res) if (nd.res === v) nd.res = null; v.res.length = 0; }

  /* ---------- 차단기 ---------- */
  gateLogic(v, dt) {
    const g = v.edge.gate;
    if (!g) return;
    // 연 차 · 정산 중인 차가 이 차로를 떠났으면(교착 풀기로 옮겨진 경우 등) 풀어 준다
    if (g.open && g.open.edge !== v.edge) g.open = null;
    if (g.busy && (g.busy.edge !== v.edge || g.busy.mode !== 'drive')) g.busy = null;
    if (g.open === v) {
      if (v.s - v.len > g.s + 0.6) { g.open = null; g.close = 1; }
      return;
    }
    if (g.busy === v) {
      g.t -= dt;
      if (g.t <= 0) {
        if (g.kind === 'in' && !this.admit()) { g.t = 1.0; g.full = true; return; }
        g.full = false;
        g.busy = null; g.open = v; g.lift = 0;
        this.passGate(v, g);
      }
      return;
    }
    if (!g.busy && !g.open && v.v < 0.25 && g.s - v.s < 1.6 && g.s - v.s > -0.4) {
      g.busy = v;
      const lpr = this.cfg.gate === 'lpr';
      g.t = g.kind === 'in' ? (lpr ? this.rng.range(1.4, 2.6) : this.rng.range(5, 9))
        : (lpr ? this.rng.range(1.6, 3.2) : this.rng.range(9, 22));
      g.tot = g.t;
    }
  }
  /** 만차 판정 — 빈 면이 탐색 중인 차보다 많아야 들인다 */
  admit() {
    let free = 0, hunting = 0;
    for (const s of this.G.stalls) if (s.state === 'free') free++;
    for (const v of this.cars) if (v.inside && v.searching && !v.stall) hunting++;
    return free - hunting > 0;
  }
  passGate(v, g) {
    if (g.kind === 'in') {
      v.inside = true; v.tGate = this.time; this.st.inN++;
      this.st.queueT.push(this.time - v.tArr);
      v.searching = true;
      if (this.cfg.guide) this.assign(v);
      v.route.length = v.ri + 1; v.path = null;
      this.planAhead(v);
    } else {
      this.st.outN++;
      this.st.exitT.push(this.time - v.tReq);
      v.done = true; v.inside = false;
      v.route.length = v.ri + 1; v.path = null;
      this.planAhead(v);
    }
  }
  /** 유도 시스템 — 진입로 끝에서 가까운 빈 면 (같은 거리면 아래층 · 낮은 번호) */
  assign(v) {
    const G = this.G;
    if (!G._dEnt) {        // 진입로 끝에서 모든 간선 시작점까지 — 다익스트라 한 번
      G._dEnt = new Map();
      const N = G.nodes.length, dist = new Float64Array(N).fill(Infinity), done = new Uint8Array(N);
      const from = G.entryEnd; dist[from.id] = 0;
      const open = [from];
      while (open.length) {
        let bi = 0; for (let i = 1; i < open.length; i++) if (dist[open[i].id] < dist[open[bi].id]) bi = i;
        const u = open[bi]; open[bi] = open[open.length - 1]; open.pop();
        if (done[u.id]) continue; done[u.id] = 1;
        for (const ed of u.outs) {
          if (ed.kind === 'exit' || ed.kind === 'street') continue;
          const w = ed.len + (ed.kind === 'rampA' || ed.kind === 'rampB' ? 8 : 0);
          if (dist[u.id] + w < dist[ed.to.id]) { dist[ed.to.id] = dist[u.id] + w; open.push(ed.to); }
        }
      }
      for (const ed of G.parkEdges) G._dEnt.set(ed.id, dist[ed.from.id]);
    }
    let best = null, bc = Infinity;
    for (const s of G.stalls) {
      if (s.state !== 'free' || !stallOk(v, s)) continue;
      const c = G._dEnt.get(s.ed.id) + s.s + this.rng.range(0, 25) - (((s.type === 'ev' && v.ev) || (s.type === 'dis' && v.dis)) ? 40 : 0);
      if (c < bc) { bc = c; best = s; }
    }
    if (best) { best.state = 'res'; best.car = v; v.stall = best; v.guided = true; v.searching = false; }
  }

  /* ---------- 주차 ---------- */
  parkLogic(v, dt) {
    const ed = v.edge;
    if (v.stall && !v.plan) {
      if (v.stall.ed === ed && v.stall.state === 'res' && v.stall.car === v) this.tryPlan(v);
      return;
    }
    if (v.plan) {
      const P = v.plan;
      /* 앞차가 서 있어 정지점에 못 닿으면 조금 모자란 자리에서 그대로 후진을 시작한다
         (기다리면 앞차는 합류점에서, 뒤차는 이 차의 대기 구간에서 서로 막힌다) */
      if (P.how === 'rev' && !P.go && v.v < 0.12 && Math.abs(v.s - P.sStop) < (v.stopT > 1.5 ? 1.7 : 0.9)) { P.go = true; this.startMan(v, 'revIn'); }
      else if (P.how === 'fwd' && (v.s >= P.sTurn - 0.05 || (v.v < 0.1 && v.stopT > 1 && v.s >= P.sTurn - 1.2))) this.startMan(v, 'fwdIn');
      return;
    }
    if (!v.searching || !ed.stalls.length) return;
    // 앞쪽 빈 면 고르기 (면마다 한 번만 판단)
    for (const s of ed.stalls) {
      const d = s.s - v.s;
      if (d < 2 || d > 16) continue;
      if (v.seen.has(s.id)) continue;
      // 나가려는 차는 운전자가 타서 깜빡이를 켰을 때만 '곧 빈다'로 보인다
      if (s.state !== 'free' && !(s.state === 'leave' && !s.next && s.car && !s.car.driverAway)) continue;
      if (!stallOk(v, s)) continue;
      v.seen.add(s.id);
      // 자기 전용 구획(충전 · 장애인)은 거의 늘 고르고, 그런 차는 일반 면을 조금 덜 고른다 (전용 구획을 찾아 더 간다)
      const mine = (s.type === 'ev' && v.ev) || (s.type === 'dis' && v.dis);
      const pAcc = s.state === 'leave' ? 0.7 : mine ? 0.99 : (v.ev || v.dis) ? 0.8 : 0.92;
      if (!this.rng.chance(pAcc)) continue;
      if (s.state === 'leave') {
        const hold = s.s - (s.car && s.car.nose === 'in' ? 11.5 : 6.5);
        if (v.s + v.v * v.v / 3 > hold) continue;
        s.next = v; v.stall = s; v.waitFor = true; v.waitT = 0; v.blink = s.side; return;
      }
      s.state = 'res'; s.car = v; v.stall = s; v.revPick = this.rng.chance(this.cfg.revShare);
      /* 바로 못 넣으면(옆 조작 · 뒤차) 면을 잡아 둔 채 다가가며 다시 본다 — 면을 놓으면
         붐빌수록 탐색 차가 빈 면을 지나쳐 계속 돌고, 그 차들이 다시 통로를 막는다 */
      if (!this.tryPlan(v) && v.stall === s && v.s > s.s - 1.5) { s.state = 'free'; s.car = null; v.stall = null; continue; }
      return;
    }
  }
  /** 후면주차가 되면 후면, 아니면 전면 */
  tryPlan(v) {
    const s = v.stall, ed = s.ed;
    const sStop = s.s + R_REV + v.wb + v.ohF;
    const sTurn = s.s - R_FWD + v.wb + v.ohF;
    const brk = v.v * v.v / (2 * 1.6);
    let fol = -Infinity;
    for (const c of ed.cars) if (c !== v && c.s < v.s && c.s > fol) fol = c.s;
    if (fol === -Infinity && v.prev) for (const c of v.prev.cars) if (c !== v) fol = Math.max(fol, c.s - v.prev.len);
    const folOk = fol < s.s - 4.6 - 2.5;
    const blkOk = (a, b) => ed.blk.every((q) => q.own === v || q.s1 < a || q.s0 > b);
    if (v.revPick == null) v.revPick = this.rng.chance(this.cfg.revShare);
    const wantRev = v.revPick;
    // 앞차가 정지점 근처에 서 있으면 지나쳐 설 자리가 없다
    let leadOk = true;
    for (const c of ed.cars) if (c !== v && c.s > v.s && c.s - c.len < sStop + 1.2 && c.v < 1.0) leadOk = false;
    if (sStop > ed.len - 6 && ed.to.res && ed.to.res !== v) leadOk = false;
    if (wantRev && leadOk && sStop < ed.len - 0.3 && v.s + brk < sStop + 0.5 && folOk && blkOk(s.s - 4.6, sStop + 0.6)) {
      v.plan = { how: 'rev', ed, sStop };
      v.plan.blk = { s0: s.s - 4.6, s1: sStop + 0.6, own: v };
      ed.blk.push(v.plan.blk);
      v.blink = s.side;
      return true;
    }
    const brkF = Math.max(0, v.v * v.v - V_MAN_F * V_MAN_F) / (2 * 1.4);
    if (v.s + brkF < sTurn && blkOk(s.s - R_FWD - 2, s.s + 3)) {
      v.plan = { how: 'fwd', ed, sTurn };
      v.blink = s.side;
      return true;
    }
    if (v.s > s.s - 1.5) {  // 지나쳤다 — 유도 차는 한 바퀴 더, 탐색 차는 포기
      if (v.guided) { v.path = null; v.route.length = v.ri + 1; this.planAhead(v); }
      else { s.state = 'free'; s.car = null; v.stall = null; }
    }
    return false;
  }

  /** 조작 경로 만들기 — 면 국소좌표(X: 통로 진행방향, Y: 면에서 통로 쪽)의 뒤축 궤적 */
  startMan(v, kind) {
    const s = v.stall, ed = s.ed;
    const segs = [];
    const lp = this.localOf(s, v);          // 지금 뒤축 위치 (국소)
    const wb = v.wb, Yc = -(PK.aisle / 2 + PK.stallL / 2);
    const arc = (cx, cy, R, a0, a1, dir) => ({ t: 'arc', cx, cy, R, a0, a1, dir });
    const line = (x0, y0, h0, x1, y1, h1, dir) => ({ t: 'line', x0, y0, h0, x1, y1, h1, dir });
    const rng = this.rng;
    if (kind === 'revIn') {
      const Xr = clamp(lp.x, 3.3, 6.0);
      const R = Xr, Yf = Yc - wb / 2 + 0.25;
      segs.push({ t: 'wait', d: rng.range(0.6, 1.3) });
      segs.push(arc(Xr, -R, R, Math.PI / 2, Math.PI, -1));
      if (rng.chance(0.4)) {           // 한 번 고쳐 넣기 — 조금 앞으로 갔다가 다시 후진
        const dx = rng.range(-0.25, 0.25);
        segs.push(line(0, -R, Math.PI / 2, dx, -R - 1.2, Math.PI / 2 + dx * 0.15, -1));
        segs.push({ t: 'wait', d: rng.range(0.5, 1.0) });
        segs.push(line(dx, -R - 1.2, Math.PI / 2 + dx * 0.15, dx * 0.4, -R + 0.2, Math.PI / 2, 1));
        segs.push({ t: 'wait', d: rng.range(0.5, 1.0) });
        segs.push(line(dx * 0.4, -R + 0.2, Math.PI / 2, 0, Yf, Math.PI / 2, -1));
      } else segs.push(line(0, -R, Math.PI / 2, 0, Yf, Math.PI / 2, -1));
      v.nose = 'out';
    } else if (kind === 'fwdIn') {
      const Xs = lp.x, R = R_FWD, Yf = Yc + wb / 2 + 0.2;
      segs.push(arc(Xs, -R, R, Math.PI / 2, 0, 1));
      segs.push(line(Xs + R, -R, -Math.PI / 2, 0, Yf, -Math.PI / 2, 1));
      v.nose = 'in';
      v.plan.blk = { s0: s.s - R_FWD - 2.5, s1: s.s + 3.2, own: v };
      ed.blk.push(v.plan.blk);
    } else if (kind === 'outFwd') {        // 머리가 통로 쪽 — 앞으로 나와 진행방향으로 돈다
      const Y0 = lp.y, R = R_OUT;
      segs.push({ t: 'wait', d: rng.range(0.8, 2.0) });
      segs.push(line(lp.x, Y0, Math.PI / 2, 0, -R, Math.PI / 2, 1));
      segs.push(arc(R, -R, R, Math.PI, Math.PI / 2, 1));
    } else if (kind === 'outRev') {        // 머리가 안쪽 — 후진으로 빠져 진행방향을 향한다
      const Y0 = lp.y, R = R_OUT;
      segs.push({ t: 'wait', d: rng.range(0.8, 2.0) });
      segs.push(line(lp.x, Y0, -Math.PI / 2, 0, -R, -Math.PI / 2, -1));
      segs.push(arc(-R, -R, R, 0, Math.PI / 2, -1));
      segs.push({ t: 'wait', d: rng.range(0.6, 1.2) });
    }
    // 시작 뒤축과 경로 시작점의 어긋남은 첫 구간에서 메운다
    v.man = { kind, segs, k: 0, u: 0, sp: 0, t: 0, x0: lp.x, y0: lp.y, h0: lp.h, blend: 1 };
    if (v.mode === 'drive') {
      const i = ed.cars.indexOf(v); if (i >= 0) ed.cars.splice(i, 1);
      this.dropRes(v);
    }
    v.mode = 'man';
    v.searching = false;
  }
  /** 차의 뒤축 위치를 면 국소좌표로 */
  localOf(s, v) {
    const ch = Math.cos(v.h), sh = Math.sin(v.h);
    const rx = v.x - ch * v.wb / 2, ry = v.y - sh * v.wb / 2;
    const dx = rx - s.ox, dy = ry - s.oy;
    // 국소 Y 축 = -n
    const X = dx * s.ax + dy * s.ay, Y = -(dx * s.nx + dy * s.ny);
    const hx = ch * s.ax + sh * s.ay, hy = -(ch * s.nx + sh * s.ny);
    return { x: X, y: Y, h: Math.atan2(hy, hx) };
  }
  toWorld(s, X, Y, th, v) {
    const wx = s.ox + X * s.ax - Y * s.nx, wy = s.oy + X * s.ay - Y * s.ny;
    const dx = Math.cos(th) * s.ax - Math.sin(th) * s.nx, dy = Math.cos(th) * s.ay - Math.sin(th) * s.ny;
    const h = Math.atan2(dy, dx);
    v.h = h;
    v.x = wx + Math.cos(h) * v.wb / 2; v.y = wy + Math.sin(h) * v.wb / 2;
    v.z = s.z; v.p = 0;
  }
  segLen(g) {
    if (g.t === 'arc') return Math.abs(g.a1 - g.a0) * g.R;
    if (g.t === 'line') return Math.hypot(g.x1 - g.x0, g.y1 - g.y0) + Math.abs(wrapPi(g.h1 - g.h0)) * 0.8;
    return 0;
  }
  maneuver(v, dt) {
    const M = v.man, s = v.stall;
    const g = M.segs[M.k];
    if (!g) { this.endMan(v); return; }
    if (g.t === 'wait') {
      M.t += dt; v.v = 0; v.brake = true;
      if (M.t >= g.d) { M.k++; M.t = 0; M.u = 0; }
      return;
    }
    const L = Math.max(0.05, this.segLen(g));
    const vmax = g.dir > 0 ? V_MAN_F : V_MAN_R;
    const dEnd = L - M.u;
    const tgt = Math.min(vmax, Math.sqrt(0.02 + 2 * 0.55 * Math.max(0, dEnd)));
    M.sp = M.sp < tgt ? Math.min(tgt, M.sp + 0.8 * dt) : tgt;
    M.u += M.sp * dt;
    v.v = M.sp; v.rev = g.dir < 0; v.brake = M.sp < 0.15;
    const f = clamp(M.u / L, 0, 1);
    let X, Y, th;
    if (g.t === 'arc') {
      const a = g.a0 + (g.a1 - g.a0) * f;
      X = g.cx + g.R * Math.cos(a); Y = g.cy + g.R * Math.sin(a);
      // 원호 접선 방향 — 진행(앞/뒤)에 따라 차 머리 방향을 정한다
      const ta = a + (g.a1 > g.a0 ? Math.PI / 2 : -Math.PI / 2);
      th = g.dir > 0 ? ta : ta + Math.PI;
    } else {
      X = g.x0 + (g.x1 - g.x0) * f; Y = g.y0 + (g.y1 - g.y0) * f;
      th = g.h0 + wrapPi(g.h1 - g.h0) * f;
    }
    // 첫 구간: 실제 시작 자세에서 매끄럽게 넘어간다
    if (M.blend > 0) {
      M.blend = Math.max(0, 1 - (M.k === 0 || (M.k === 1 && M.segs[0].t === 'wait') ? f * 1.6 : 1));
      if (M.blend > 0) {
        const b = smoothstep(M.blend);
        X += (M.x0 - (g.t === 'arc' ? g.cx + g.R * Math.cos(g.a0) : g.x0)) * b;
        Y += (M.y0 - (g.t === 'arc' ? g.cy + g.R * Math.sin(g.a0) : g.y0)) * b;
      }
    }
    this.toWorld(s, X, Y, th, v);
    // 전면주차: 원호를 다 돌면 통로를 풀어 준다
    if (M.kind === 'fwdIn' && M.k >= 1 && v.plan && v.plan.blk) { this.dropBlk(v.plan.blk); v.plan.blk = null; }
    if (f >= 1) { M.k++; M.u = 0; M.sp *= 0.3; }
  }
  dropBlk(b) {
    if (!b) return;
    for (const ed of [b.ed].filter(Boolean)) { const i = ed.blk.indexOf(b); if (i >= 0) ed.blk.splice(i, 1); }
    for (const ed of this.G.parkEdges) { const i = ed.blk.indexOf(b); if (i >= 0) ed.blk.splice(i, 1); }
  }
  endMan(v) {
    const M = v.man, s = v.stall;
    if (M.kind === 'revIn' || M.kind === 'fwdIn') {
      if (v.plan && v.plan.blk) this.dropBlk(v.plan.blk);
      v.plan = null; v.man = null;
      this.st.search.push(this.time - v.tGate);
      v.revPick = null;
      this.parkAt(v, s, M.kind === 'revIn' ? 'out' : 'in');
      v.tPark = this.time;
      v.searching = false;
      this.spawnPed(v, false);                // 운전자가 내려 계단실로 걸어간다
      return;
    }
    // 출차 끝 — 통로 위 주행으로 넘긴다
    const ed = s.ed;
    const sFront = M.kind === 'outFwd' ? s.s + R_OUT + v.wb + v.ohF : s.s - R_OUT + v.wb + v.ohF;
    this.dropBlk(v.outBlk); v.outBlk = null;
    s.state = s.next ? 'res' : 'free';
    s.car = s.next || null;
    if (s.next) { s.next.waitFor = false; s.next.waitT = 0; }
    s.next = null;
    this.dirty = true;
    v.stall = null; v.man = null;
    v.mode = 'drive'; v.edge = ed; v.s = sFront; v.v = 0.4; v.rev = false; v.blink = 0;
    v.route = [ed]; v.ri = 0; v.path = null; v.prev = null;
    ed.cars.push(v);
    this.planAhead(v);
    this.pose(v);
  }
  /** 출차 — 통로가 비었는지 보고 조작을 시작한다 */
  tryUnpark(v) {
    const s = v.stall, ed = s.ed;
    const out = v.nose === 'out';
    const s0 = out ? s.s - 3.0 : s.s - R_OUT - v.ohR - 2.6;
    const s1 = out ? s.s + R_OUT + v.wb + v.ohF + 1.0 : s.s + 3.4;
    if (!this.clearZone(v, ed, s0, s1)) return;
    const b = { s0, s1, own: v, ed };
    ed.blk.push(b); v.outBlk = b;
    v.tUnpark = this.time;
    this.startMan(v, out ? 'outFwd' : 'outRev');
  }
  clearZone(v, ed, s0, s1) {
    for (const q of ed.blk) if (q.own !== v && !(q.s1 < s0 - 1 || q.s0 > s1 + 1)) return false;
    for (const c of ed.cars) {
      if (c.s > s0 - 0.5 && c.s - c.len < s1 + 0.5) return false;
      if (c.s <= s0 && s0 - c.s < c.v * c.v / (2 * 1.5) + 3) return false;
    }
    for (const P of ed.from.ins) for (const c of P.cars) {
      const d = P.len - c.s + s0;
      if (d < c.v * c.v / (2 * 1.5) + 3) return false;
    }
    if (s1 > ed.len - 1) for (const N of ed.to.outs) for (const c of N.cars) if (c.s - c.len < s1 - ed.len + 1) return false;
    if (ed.to.res && ed.to.res !== v && s1 > ed.len - 2) return false;
    // 이웃에서 조작 중인 차
    for (const c of this.act) {
      if (c === v || c.mode !== 'man') continue;
      if (c.stall && c.stall.level === v.stall.level && Math.hypot(c.x - v.x, c.y - v.y) < 9) return false;
    }
    return true;
  }

  /* ---------- 자세 ---------- */
  /** 주행 중 차: 앞축 · 뒤축을 경로 위에서 잡아 방위 · 피치를 낸다 (회전 시 뒤축이 안쪽으로 붙는다) */
  pose(v) {
    const f = this.ptAt(v, v.s - v.ohF), r = this.ptAt(v, v.s - v.ohF - v.wb);
    const dx = f.x - r.x, dy = f.y - r.y;
    v.h = Math.atan2(dy, dx);
    v.x = (f.x + r.x) / 2; v.y = (f.y + r.y) / 2; v.z = (f.z + r.z) / 2;
    v.p = Math.atan2(f.z - r.z, Math.hypot(dx, dy));
  }
  ptAt(v, s) {
    const out = s >= 0 || !v.prev ? v.edge.at(s, {}) : v.prev.at(v.prev.len + s, {});
    return out;
  }

  unjam(v) {
    this.planAhead(v, 14);
    for (let i = v.ri + 1; i < v.route.length; i++) {
      const e = v.route[i];
      if (e.kind === 'street' || e.gate) break;
      // 이 간선에서 차 길이 + 3 m 이 비는 첫 틈
      const cs = e.cars.slice().sort((a, b) => a.s - b.s);
      let lo = 0.5;
      for (let k = 0; k <= cs.length; k++) {
        const hi = k < cs.length ? cs[k].s - cs[k].len : e.len - 0.5;
        const blocked = e.blk.some((b) => b.own !== v && !(b.s1 < lo || b.s0 > lo + v.len + 3));
        if (hi - lo >= v.len + 3 && !blocked) {
          const old = v.edge, j = old.cars.indexOf(v); if (j >= 0) old.cars.splice(j, 1);
          this.dropRes(v);
          v.prev = v.route[i - 1]; v.edge = e; v.ri = i; v.s = lo + v.len + 1; v.v = 0.5; v.stopT = 0; v.mWait = 0;
          e.cars.push(v);
          this.st.unjam = (this.st.unjam || 0) + 1;
          this.planAhead(v); this.pose(v);
          return true;
        }
        if (k < cs.length) lo = cs[k].s + 1.5;
      }
    }
    return false;
  }
  /* ---------- 사람 (운전자) ---------- */
  /** 출차 — 운전자를 계단실에서 차로 걸어오게 한다. 도착해야 차가 움직인다 */
  callDriver(v) {
    v.leaving = true; v.tReq = this.time; v.tryT = 0;
    if (v.stall) v.stall.state = 'leave';
    v.driverAway = true;
    if (!this.spawnPed(v, true)) { v.driverAway = false; v.tryT = this.rng.range(0, 3); }
    this.actDirty = true;
  }
  spawnPed(v, toCar) {
    const s = v.stall; if (!s) return null;
    const pts = this.walkPath(v, s);
    if (!pts) return null;
    if (toCar) pts.reverse();
    const rng = this.rng;
    const p = {
      pts, k: 0, u: 0, sp: rng.range(1.15, 1.5), z: s.z, car: v, toCar, level: s.level,
      delay: toCar ? 0 : rng.range(2.5, 6), x: pts[0][0], y: pts[0][1], h: 0, ph: rng.next() * 6,
      shirt: rng.pick(['#3b5b8c', '#8c3b3b', '#2f6b52', '#d0d0cc', '#2a2a2e', '#a07a3c', '#6b4f8c']),
      pants: rng.pick(['#26282d', '#3a4256', '#6b6455', '#1f2a3a']), hei: rng.range(1.6, 1.82), wait: 0,
    };
    this.peds.push(p);
    if (this.onPed) this.onPed(p);
    return p;
  }
  /** 차 문 -> 면 앞 통로 가장자리 -> 통로를 따라(양방향으로 걸을 수 있다) -> 계단실 문 */
  walkPath(v, s) {
    const G = this.G, L = s.level;
    const ch = Math.cos(v.h), sh = Math.sin(v.h);
    const door = [v.x - sh * (v.wid / 2 + 0.45), v.y + ch * (v.wid / 2 + 0.45)];     // 운전석(왼쪽)
    const ent = [s.ox + s.nx * 2.2, s.oy + s.ny * 2.2];
    if (!G.pedNet) G.pedNet = {};
    let net = G.pedNet[L];
    if (!net) {
      const eds = G.edges.filter((e) => e.level === L && (e.kind === 'loop' || e.kind === 'aisle'));
      const adj = new Map();
      const add = (n, o) => { if (!adj.has(n.id)) adj.set(n.id, []); adj.get(n.id).push(o); };
      for (const e of eds) { add(e.from, { e, fwd: true, to: e.to }); add(e.to, { e, fwd: false, to: e.from }); }
      // 계단실 문에 가장 가까운 순환로 점
      const cx = G.core.x - 2.5, cy = G.yt;
      let best = null, bd = 1e9;
      for (const e of eds) { const pr = e.project(cx, cy); if (pr.d < bd) { bd = pr.d; best = { e, s: pr.s }; } }
      net = G.pedNet[L] = { adj, T: best };
      if (!best) return null;
    }
    const T = net.T;
    if (!T) return null;
    // 다익스트라 (무향)
    const dist = new Map(), prev = new Map();
    const pq = [];
    const push = (node, d, via) => { if (d < (dist.get(node.id) ?? Infinity)) { dist.set(node.id, d); prev.set(node.id, via); pq.push(node); } };
    push(s.ed.from, s.s, { start: true, e: s.ed, a: s.s, b: 0 });
    push(s.ed.to, s.ed.len - s.s, { start: true, e: s.ed, a: s.s, b: s.ed.len });
    const done = new Set();
    while (pq.length) {
      let bi = 0; for (let i = 1; i < pq.length; i++) if (dist.get(pq[i].id) < dist.get(pq[bi].id)) bi = i;
      const u = pq[bi]; pq[bi] = pq[pq.length - 1]; pq.pop();
      if (done.has(u.id)) continue; done.add(u.id);
      for (const o of net.adj.get(u.id) || []) push(o.to, dist.get(u.id) + o.e.len, { from: u, e: o.e, a: o.fwd ? 0 : o.e.len, b: o.fwd ? o.e.len : 0 });
    }
    // 목표 간선으로 들어가는 두 길 중 짧은 쪽
    let pieces = null;
    if (T.e === s.ed) pieces = [{ e: s.ed, a: s.s, b: T.s }];
    else {
      const dA = (dist.get(T.e.from.id) ?? Infinity) + T.s, dB = (dist.get(T.e.to.id) ?? Infinity) + (T.e.len - T.s);
      if (!isFinite(Math.min(dA, dB))) return null;
      const endNode = dA <= dB ? T.e.from : T.e.to;
      pieces = [{ e: T.e, a: dA <= dB ? 0 : T.e.len, b: T.s }];
      let n = endNode;
      for (let g = 0; g < 200; g++) {
        const via = prev.get(n.id); if (!via) break;
        pieces.unshift({ e: via.e, a: via.a, b: via.b });
        if (via.start) break;
        n = via.from;
      }
    }
    const pts = [door, ent];
    for (const pc of pieces) {
      const L2 = Math.abs(pc.b - pc.a), k = Math.max(1, Math.ceil(L2 / 1.5)), dir = Math.sign(pc.b - pc.a) || 1;
      for (let i = 0; i <= k; i++) {
        const q = pc.e.at(pc.a + (pc.b - pc.a) * i / k);
        const off = 2.2 * dir;                     // 걷는 쪽의 오른편 가장자리
        pts.push([q.x + Math.sin(q.h) * off, q.y - Math.cos(q.h) * off]);
      }
    }
    pts.push([G.core.x, G.core.doorY - 1.5], [G.core.x, G.core.doorY]);
    return pts;
  }
  walk(dt) {
    let k = 0;
    for (const p of this.peds) {
      if (p.delay > 0) { p.delay -= dt; this.peds[k++] = p; continue; }
      // 다가오는 차가 바로 앞이면 기다린다 (차 옆을 지날 때는 그냥 간다)
      let hold = false;
      if (p.k > 1) for (const c of this.act) {
        if (c.mode !== 'drive' || c.v < 0.5 || Math.abs(c.z - p.z) > 1.3) continue;
        const ch = Math.cos(c.h), sh = Math.sin(c.h), dx = p.x - c.x, dy = p.y - c.y;
        const al = dx * ch + dy * sh, lt = -dx * sh + dy * ch;
        if (al > 0 && al < c.len / 2 + 3 + c.v * 1.2 && Math.abs(lt) < c.wid / 2 + 0.7) { hold = true; break; }
      }
      p.wait = hold ? p.wait + dt : 0;
      if (!hold || p.wait > 6) {
        let d = p.sp * dt;
        while (d > 0 && p.k < p.pts.length - 1) {
          const a = p.pts[p.k], b = p.pts[p.k + 1];
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (p.u + d < L) { p.u += d; d = 0; } else { d -= L - p.u; p.u = 0; p.k++; }
        }
        p.ph += dt * p.sp * 3.2;
      }
      if (p.k >= p.pts.length - 1) {
        if (p.toCar && p.car) { p.car.driverAway = false; p.car.tryT = this.rng.range(2.5, 5); }
        p.gone = true;
        if (this.onPedEnd) this.onPedEnd(p);
        continue;                                   // 문에 닿았다 / 차에 탔다
      }
      const a = p.pts[p.k], b = p.pts[p.k + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, t = p.u / L;
      p.x = a[0] + (b[0] - a[0]) * t; p.y = a[1] + (b[1] - a[1]) * t;
      const th = Math.atan2(b[1] - a[1], b[0] - a[0]);
      p.h = p.h + wrapPi(th - p.h) * Math.min(1, dt * 8);
      this.peds[k++] = p;
    }
    this.peds.length = k;
  }

  /* ---------- 통계 ---------- */
  record() {
    const S = this.summary();
    this.st.hist.push({ t: this.time, occ: S.occ, hunt: S.hunting, qIn: S.qIn, qOut: S.qOut });
    if (this.st.hist.length > 720) this.st.hist.shift();
  }
  summary() {
    const G = this.G;
    let occ = 0, res = 0;
    const per = G.levels.map(() => ({ n: 0, occ: 0 }));
    for (const s of G.stalls) {
      per[s.level].n++;
      if (s.state === 'occ' || s.state === 'leave') { occ++; per[s.level].occ++; }
      else if (s.state === 'res') res++;
    }
    let hunting = 0, man = 0, qIn = 0, qOut = 0, inside = 0, wantOut = 0;
    for (const v of this.cars) {
      if (v.mode === 'man') man++;
      if (v.inside && v.mode === 'drive') inside++;
      if (v.inside && v.searching) hunting++;
      if (v.mode === 'parked' && v.leaving) wantOut++;
      if (v.mode === 'drive' && v.role === 'park' && !v.inside && !v.done && (v.edge.kind === 'entry' || (v.edge === G.street[0] && v.v < 1.5 && v.edge.len - v.s < 60))) qIn++;
      if (v.mode === 'drive' && v.leaving && !v.done && (v.edge.kind === 'exit' || (v.edge === G.exit.from.ins[0] && v.v < 0.5))) qOut++;
    }
    const avg = (a, n) => { const b = a.slice(-n); return b.length ? b.reduce((p, q) => p + q, 0) / b.length : 0; };
    return {
      total: G.stalls.length, occ, res, free: G.stalls.length - occ - res, per,
      hunting, man, qIn, qOut, inside, wantOut, coming: (this.pending | 0) + (this.batch | 0),
      inN: this.st.inN, outN: this.st.outN, lost: this.st.lost, gaveUp: this.st.gaveUp, unjam: this.st.unjam | 0,
      searchAvg: avg(this.st.search, 40), exitAvg: avg(this.st.exitT, 40), queueAvg: avg(this.st.queueT, 40),
    };
  }
}

function sortByS(a) {
  for (let i = 1; i < a.length; i++) {
    const x = a[i]; let j = i - 1;
    while (j >= 0 && a[j].s > x.s) { a[j + 1] = a[j]; j--; }
    a[j + 1] = x;
  }
}
