/* =============================================================================
   csim.js — 도시 교통 시뮬레이터: 도로망(cnet.js) 위에서 차가 출발지 → 목적지로 달린다

   출발 · 도착 — 도시 밖 출입구(게이트) 또는 건물. 건물은 주차 대수가 있어, 도착한 차는 길가 차로에서
     진입로로 꺾어 건물 문으로 들어가 주차하고(occ +1), 떠나는 차는 문에서 나와 길가 차로 틈을 보고 끼어든다.
     건물 출발은 세워 둔 차가 있는 건물에서, 도착은 빈 자리가 있는 건물로만 고른다.
   차 — IDM(고속도로와 같은 식). 구간 제한속도(도로 종류) · 차로 곡률 · 연결로 곡률에 맞춰 달린다.
     다음 회전에 맞는 차로로 미리 옮기고(옆 차로 뒷차는 틈을 내준다), 놓치면 그 차로에서 갈 수 있는 길로 돌아간다.
   교차로 — 신호(현시 · 황색 · 전적색 · 적신호 우회전 · 꼬리 물기 금지), 일시정지(작은 길은 서고 큰 길을 본다),
     합류(램프는 가속차로에서 본선 틈을 본다). 어느 제어든 교차로 안에서 내 길과 엇갈리는 길에 차가 있으면
     그 차가 지나갈 때까지 들어가지 않는다.
   경로 — 구간마다 최근 통행 시간으로 가장 빠른 길(다익스트라 · 회전 벌점), 교차로를 지날 때 35 % 확률로 다시.
   ========================================================================== */
'use strict';

const CSIM = { dt: 0.1, turnPen: { L: 14, S: 0, R: 5, U: 30 }, reroute: 0.35, unjamT: 240 };
const CCLASS = [
  { key: 'mini', name: '경차', share: 0.10, len: 3.60, wid: 1.60, hei: 1.52 },
  { key: 'sedan', name: '승용', share: 0.48, len: 4.75, wid: 1.84, hei: 1.45 },
  { key: 'suv', name: 'SUV', share: 0.32, len: 4.70, wid: 1.90, hei: 1.72 },
  { key: 'van', name: '승합', share: 0.10, len: 5.15, wid: 1.99, hei: 1.86 },
];

let cityCarSeq = 0;
class CCar {
  constructor(sim) {
    const rng = sim.rng, c = rng.weighted(CCLASS.map((k) => [k, k.share]));
    this.id = ++cityCarSeq; this.cls = c;
    this.len = c.len * rng.range(0.97, 1.03); this.wid = c.wid; this.hei = c.hei;
    this.color = rng.weighted(CAR_COLORS);
    this.vMul = rng.range(0.9, 1.1);
    this.T = rng.range(1.0, 1.5); this.s0 = rng.range(1.6, 2.4);
    this.a = rng.range(1.3, 1.9); this.b = 2.3; this.sqrtAB = Math.sqrt(this.a * this.b);
    this.edge = null; this.s = 0; this.v = 0; this.acc = 0;
    this.route = []; this.ri = 0; this.conn = null;
    this.lcT = 0; this.lc = 0;
    this.x = 0; this.y = 0; this.z = 0; this.h = 0; this.p = 0;
    this.stopT = 0; this.stops = 0; this.moving = false; this.dAp = 0;
    this.brake = false;
  }
}

class CitySim {
  constructor(net, cfg) {
    this.net = net; this.cfg = cfg; this.rng = new RNG('city:' + (cfg.seed | 0));
    this.time = 0; this.cars = [];
    this.pendGate = []; this.pendBld = [];
    this.st = { done: 0, trips: [], spawned: 0, hist: [], lost: 0, unjam: 0, detour: 0, bIn: 0, bOut: 0 };
    for (const B of net.blds) B.occ = B.din ? Math.round(B.cap * 0.5) : 0;
    this.gates = net.gates.filter((g) => g.inL && g.outL);
    this.bldOK = net.blds.filter((B) => B.din);
    this.tTrip = this.nextExp(cfg.demand);
    this.histT = 0;
    this.retime();
  }
  nextExp(rate) { return rate > 0 ? this.rng.exp(3600 / rate) : Infinity; }
  /** 신호 시작 어긋남 — 연동이면 동쪽으로 가는 직진 녹색이 45 km/h 로 번지게 */
  retime() {
    const coord = !!(this.cfg.coord), vp = 45 * KMH;
    for (const N of this.net.nodes) {
      if (!N.plan) continue;
      const P = N.plan;
      let k = -1;
      if (coord) P.ph.forEach((p, i) => { if (k < 0 && p.conns.some((c) => c.mv === 'S' && Math.abs(wrapPi(c.from.link.center(c.from.link.len, {}).h)) < 0.5)) k = i; });
      if (k >= 0) { let t0 = 0; for (let q = 0; q < k; q++) t0 += P.ph[q].g + CN.Y + CN.AR; N.offset = ((N.x / vp - t0) % P.cyc + P.cyc) % P.cyc; }
      else N.offset = this.rng.range(0, P.cyc);
    }
  }
  /** 연결로의 신호 — 'G' · 'Y' · 'R' (신호 교차로가 아니면 'G') */
  sig(cn) {
    const N = cn.node, P = N.plan;
    if (!P || N.ctl !== 'signal') return 'G';
    let t = (this.time - N.offset) % P.cyc; if (t < 0) t += P.cyc;
    const k = P.ph.length;
    for (let i = 0; i < k; i++) {
      const p = P.ph[i], on = cn.greens.includes(i), nx = cn.greens.includes((i + 1) % k);
      if (t < p.g) return on ? 'G' : 'R';
      t -= p.g;
      if (t < CN.Y) return on ? (nx ? 'G' : 'Y') : 'R';
      t -= CN.Y;
      if (t < CN.AR) return on && nx ? 'G' : 'R';
      t -= CN.AR;
    }
    return 'R';
  }
  phaseNow(N) {
    const P = N.plan; if (!P) return null;
    let t = (this.time - N.offset) % P.cyc; if (t < 0) t += P.cyc;
    for (let q = 0; q < P.ph.length; q++) { const p = P.ph[q], d = p.g + CN.Y + CN.AR; if (t < d) return { q, t, left: d - t, g: p.g }; t -= d; }
    return { q: 0, t: 0, left: 0, g: 0 };
  }

  /* ----- 경로 ----- */
  route(L, goal) {
    const links = this.net.links, N = links.length;
    if (L === goal) return [L];
    const dist = this._rd && this._rd.length === N ? this._rd : (this._rd = new Float64Array(N)), prev = this._rp && this._rp.length === N ? this._rp : (this._rp = new Int32Array(N));
    dist.fill(Infinity); prev.fill(-1); dist[L.id] = 0;
    const heap = [[0, L.id]];
    while (heap.length) {
      const [d, u] = heapPop(heap);
      if (d > dist[u]) continue;
      if (u === goal.id) break;
      for (const e of links[u].next) {
        const nd = d + e.L.tt + CSIM.turnPen[e.mv];
        if (nd < dist[e.L.id]) { dist[e.L.id] = nd; prev[e.L.id] = u; heapPush(heap, [nd, e.L.id]); }
      }
    }
    if (dist[goal.id] === Infinity) return null;
    const out = []; for (let k = goal.id; k !== -1; k = prev[k]) out.push(links[k]);
    return out.reverse();
  }
  /** L 을 떠났다가 다시 L 로 돌아오는 가장 빠른 길 (L 로 시작해 L 로 끝난다) */
  loopRoute(L) {
    let best = null, bc = Infinity;
    for (const e of L.next) { const r = this.route(e.L, L); if (!r) continue; let c = 0; for (const q of r) c += q.tt; if (c < bc) { bc = c; best = r; } }
    return best ? [L].concat(best) : null;
  }
  goalOf(d) { return d.bld ? d.bld.link : d.gate.outL; }

  /* ----- 통행 ----- */
  newTrip() {
    const rng = this.rng, pIn = clamp(+this.cfg.inner || 0, 0, 1);
    let o = null, d = null;
    if (this.bldOK.length && rng.chance(pIn)) {
      const B = pickW(rng, this.bldOK, (b) => Math.max(0, b.occ - b.queue));
      if (B) o = { bld: B };
    }
    if (!o && this.gates.length) o = { gate: pickW(rng, this.gates, (g) => g.w) };
    if (!o) return;
    for (let k = 0; k < 8 && !d; k++) {
      if (this.bldOK.length && rng.chance(pIn)) { const B = pickW(rng, this.bldOK, (b) => Math.max(0, b.cap - b.occ - b.inbound)); if (B) d = { bld: B }; }
      if (!d && this.gates.length) d = { gate: pickW(rng, this.gates, (g) => g.w) };
      if (d && ((o.bld && o.bld === d.bld) || (o.gate && o.gate === d.gate))) d = null;
    }
    if (!d) return;
    const t = { o, d, t0: this.time };
    if (d.bld) d.bld.inbound++;
    if (o.bld) { o.bld.queue++; this.pendBld.push(t); } else this.pendGate.push(t);
  }
  launch() {
    for (const list of [this.pendGate, this.pendBld]) for (let k = 0; k < list.length; k++) if (this.tryLaunch(list[k])) { list.splice(k, 1); k--; }
    for (const list of [this.pendGate, this.pendBld]) while (list.length && this.time - list[0].t0 > 600) { this.dropTrip(list.shift()); this.st.lost++; }
  }
  dropTrip(t) { if (t.d.bld) t.d.bld.inbound--; if (t.o.bld) t.o.bld.queue--; }
  tryLaunch(t) {
    const L = t.o.bld ? t.o.bld.link : t.o.gate.inL, goal = this.goalOf(t.d);
    if (t.r === undefined) {
      t.r = this.route(L, goal);
      // 같은 구간 안 — 목적지가 뒤쪽이면 한 바퀴 돌아온다
      if (t.r && L === goal && t.o.bld && t.d.bld && t.d.bld.lane.cAt(t.d.bld.sIn) < t.o.bld.lane.cAt(t.o.bld.sOut) + 5) t.r = this.loopRoute(L);
    }
    if (!t.r) { this.dropTrip(t); this.st.lost++; return true; }
    const v = new CCar(this);
    v.route = t.r; v.ri = 0; v.trip = t; v.dest = t.d; v.ff = 0;
    for (const q of t.r) v.ff += q.ff;
    if (t.o.bld) {                                  // 건물 문 → 진출로
      const B = t.o.bld, p = B.dout;
      if (p.cars.length && p.cars[p.cars.length - 1].s < v.len + 4) return false;
      v.edge = p; v.s = 0; v.v = 0; p.cars.push(v);
      B.queue--; B.occ--; B.nOut++; this.st.bOut++;
    } else {
      const want = this.wantLanes(v, L).filter((ln) => ln.t0 <= 0.01);
      let best = null, bs = -1;
      for (const ln of want.length ? want : L.startLanes) { const r0 = ln.cars[0], sp = r0 ? r0.s - r0.len : 1e9; if (sp > bs) { bs = sp; best = ln; } }
      if (!best || bs < v.len + 8) return false;
      v.edge = best; v.s = 0; v.v = Math.min(L.vLim * 0.75, best.cars[0] ? best.cars[0].v + 2 : L.vLim);
      this.insertSorted(best, v);
      this.pickConn(v);
    }
    v.tLink = this.time;
    this.cars.push(v); this.st.spawned++;
    this.pose(v);
    return true;
  }

  /* ----- 차로 ----- */
  insertSorted(edge, v) { const a = edge.cars; let i = a.length; while (i > 0 && a[i - 1].s > v.s) i--; a.splice(i, 0, v); }
  remove(edge, v) { const a = edge.cars, i = a.indexOf(v); if (i >= 0) a.splice(i, 1); }
  around(lane, s) { let lead = null, fol = null; for (const c of lane.cars) { if (c.s > s) { lead = c; break; } fol = c; } return { lead, fol }; }
  /** 이 구간에서 다음 구간으로 갈 수 있는 차로 (목적지 건물이 이 구간이면 그 길가 차로) */
  wantLanes(v, L) {
    const nx = v.route[v.ri + 1];
    if (!nx || v.route[v.ri] !== L) {
      if (v.dest && v.dest.bld && v.dest.bld.link === L) return [v.dest.bld.lane];
      return L.endLanes;
    }
    const out = L.endLanes.filter((ln) => ln.outTo.has(nx.id));
    return out.length ? out : L.endLanes;
  }
  pickConn(v) {
    const e = v.edge, nx = v.route[v.ri + 1];
    v.conn = null;
    if (e.kind !== 'lane' || !nx) return;
    const cs = e.outTo.get(nx.id);
    if (cs) v.conn = cs[v.id % cs.length];
  }
  /** 옆 차로 (dir ±1) 가운데 구간 역 c 에서 앞으로 6 m 넘게 이어지는 것 */
  side(e, dir, c) {
    for (const ln of e.link.lanes) if (ln.r === e.r + dir && ln.t0 <= c - 0.5 && ln.t1 >= c + 6) return ln;
    return null;
  }

  /* ----- 한 걸음 ----- */
  step(dt) { let t = dt; while (t > 1e-9) { const h = Math.min(CSIM.dt, t); this.sub(h); t -= h; } }
  sub(dt) {
    this.time += dt;
    while (this.time >= this.tTrip) { this.newTrip(); this.tTrip += this.nextExp(this.cfg.demand); }
    this.launch();
    for (const ln of this.net.lanes) if (ln.req.length) ln.req.length = 0;
    for (const v of this.cars) this.decide(v);
    this.unjam();
    for (const v of this.cars) v.acc = this.accel(v);
    const fin = [];
    for (const v of this.cars) {
      const nv = Math.max(0, v.v + v.acc * dt);
      v.s += (v.v + nv) * 0.5 * dt; v.v = nv;
      v.brake = v.acc < -0.8 || (v.v < 0.1 && v.acc < 0.05);
      if (v.v < 0.3) { v.stopT += dt; if (v.moving) { v.stops++; v.moving = false; } } else { v.stopT = 0; if (v.v > 2) v.moving = true; }
      const e = v.edge;
      if (e.kind === 'lane' && (e.link.to.ctl === 'signal' || e.link.to.ctl === 'stop')) v.dAp += dt * (1 - Math.min(1, v.v / e.link.vLim));
      if (v.lc) v.lc = Math.sign(v.lc) * Math.max(0, Math.abs(v.lc) - dt * 1.3);
      v.lcT -= dt;
      if (v.teleport || this.advance(v)) fin.push(v);
    }
    for (const v of fin) this.finish(v);
    for (const v of this.cars) this.pose(v);
    this.histT += dt;
    if (this.histT >= 10) { this.histT = 0; this.record(); }
  }

  decide(v) {
    const e = v.edge;
    if (e.kind !== 'lane') return;
    const L = e.link, want = this.wantLanes(v, L), dEnd = e.len - v.s, ok = want.includes(e);
    const c = e.cAt(v.s);
    // ★ 끝내 차로를 못 바꿔 서 있으면 이 차로에서 갈 수 있는 길로 바꾼다 (안 그러면 그 차로가 영영 막힌다)
    if (!ok && dEnd < 4 && v.v < 0.5 && v.stopT > 8 && e.outTo.size) { this.detour(v); return; }
    let dir = 0;
    if (!ok) { let best = want[0]; for (const w of want) if (Math.abs(w.r - e.r) < Math.abs(best.r - e.r)) best = w; dir = best.r > e.r ? 1 : -1; }
    if (!ok && dEnd < Math.max(80, v.v * 5)) { const t = this.side(e, dir, c); if (t) t.req.push(v); }
    if (v.lcT > 0) return;
    let target = null, must = false;
    if (!ok) { target = this.side(e, dir, c); must = true; }
    else if (want.length > 1 && dEnd > 30 && v.v < L.vLim * 0.7) {
      const me = this.gapAhead(e, v);
      for (const dk of [-1, 1]) {
        const ln = this.side(e, dk, c);
        if (!ln || !want.includes(ln)) continue;
        const s2 = ln.sAtC(c), { lead } = this.around(ln, s2);
        const g = lead ? lead.s - lead.len - s2 : ln.len - s2;
        if (g > me + 25 && (!lead || lead.v > 1 || g > 40)) { target = ln; break; }
      }
    }
    if (!target) return;
    const s2 = target.sAtC(c);
    const { lead, fol } = this.around(target, s2);
    const gL = lead ? lead.s - lead.len - s2 : 1e9, gF = fol ? s2 - v.len - fol.s : 1e9;
    const need = must && dEnd < 40 ? 0.6 : 1;
    if (gL < (2 + v.v * 0.5) * need || gF < (2.5 + (fol ? fol.v * 0.9 : 0)) * need) return;
    this.remove(e, v); v.edge = target; v.s = s2; this.insertSorted(target, v);
    v.lc = L.offOf(e.slot, c) - L.offOf(target.slot, c);
    v.lcT = must ? 1.5 : 4;
    this.pickConn(v);
  }
  detour(v) {
    const e = v.edge, goal = this.goalOf(v.dest);
    let best = null, bc = Infinity;
    for (const [lid] of e.outTo) {
      const r = this.route(this.net.links[lid], goal);
      if (!r) continue;
      let c = 0; for (const q of r) c += q.tt;
      if (c < bc) { bc = c; best = r; }
    }
    if (best) { v.route = v.route.slice(0, v.ri + 1).concat(best); this.pickConn(v); this.st.detour++; return; }
    // 이 차로로 갈 수 있는 길이 도시 밖뿐이면 그리로 나간다 (목적지를 그 출입구로)
    for (const [lid] of e.outTo) {
      const g = this.gates.find((q) => q.outL === this.net.links[lid]);
      if (!g) continue;
      if (v.dest.bld) v.dest.bld.inbound--;
      v.dest = { gate: g }; v.route = v.route.slice(0, v.ri + 1).concat([g.outL]); this.pickConn(v); this.st.detour++;
      return;
    }
  }
  /** 마지막 장치 — 정지선 맨 앞에서 4 분 넘게 못 움직인 차는 도로망에서 뺀다 (교차로끼리 서로 막은 교착) */
  unjam() {
    if ((this._uj = (this._uj || 0) + 1) % 20) return;
    for (const v of this.cars) {
      if (v.stopT < CSIM.unjamT) continue;
      const e = v.edge;
      if (e.kind === 'dout') { if (v.stopT > CSIM.unjamT * 2) v.teleport = true; continue; }
      if (e.kind !== 'lane' || e.cars[e.cars.length - 1] !== v || e.len - v.s > 8) continue;
      v.teleport = true;
    }
  }
  gapAhead(e, v) { const i = e.cars.indexOf(v), l = e.cars[i + 1]; return l ? l.s - l.len - v.s : e.len - v.s; }

  /** 들어갈 차로에 내 차가 설 자리가 있나 (교차로 막기 금지) */
  spaceOK(cn, v) {
    const out = cn.to, r = out.cars[0];
    let room = r ? r.s - r.len : out.len;
    if (r && r.v > 4) room += 10;
    for (const k of out.inConns) for (const c of k.cars) room -= c.len + 2;
    return room > v.len + 2.5;
  }
  /** 교차로 안이 비었나 — 엇갈리는 길 위에 아직 엇갈림 점을 못 지난 차가 있으면 아니다.
      ahead 면 나보다 먼저인 길(높은 순위, onlyGreen 이면 녹색인 길)로 곧 들어올 차도 본다 */
  clear(cn, ahead, onlyGreen) {
    for (const c of cn.conf) {
      const k = c.k;
      for (const o of k.cars) if (o.s - o.len < c.sOt + 1.5) return false;
      if (!ahead) continue;
      if (onlyGreen ? this.sig(k) === 'R' : k.rank <= cn.rank) continue;
      const a = k.from;
      for (let q = a.cars.length - 1; q >= 0; q--) {
        const o = a.cars[q], d = a.len - o.s;
        if (d > 60) break;
        if (o.conn === k && d < Math.max(6, o.v * 4.5)) return false;
      }
    }
    return true;
  }

  accel(v) {
    const e = v.edge;
    const L = e.link, vLim = L ? L.vLim : 5;
    let vDes = e.kind === 'conn' ? Math.min(vLim * v.vMul, e.vmax) : e.kind === 'lane' ? vLim * v.vMul : e.vmax;
    let acc = Infinity;
    const lim = (gap, dv) => { const a = idmAccel(v.v, vDes, gap, dv, v.a, v.T, v.s0, v.sqrtAB); if (a < acc) acc = a; };
    // 앞차 — 이 간선, 없으면 갈 연결로 · 그 다음 차로
    const i = e.cars.indexOf(v);
    let lead = e.cars[i + 1], gap = lead ? lead.s - lead.len - v.s : 0;
    const dist = e.len - v.s;
    if (!lead && (e.kind === 'lane' || e.kind === 'conn')) {
      let nx = e.kind === 'lane' ? v.conn : e.to, base = dist;
      for (let hop = 0; nx && hop < 2 && base < 90; hop++) {
        if (nx.cars.length) { lead = nx.cars[0]; gap = base + lead.s - lead.len; break; }
        base += nx.len; nx = nx.kind === 'conn' ? nx.to : null;
      }
    }
    if (lead) lim(gap, v.v - lead.v);
    // 굽은 길 — 앞 45 m 안의 곡률 속도까지 줄일 수 있게
    if (e.vk) {
      for (const d of [0, 12, 25, 45]) {
        const s = v.s + d;
        let vk = s <= e.len ? e.vmaxAt(s) : (e.kind === 'lane' && v.conn ? v.conn.vmax : 99);
        const va = Math.sqrt(vk * vk + 2 * 1.6 * d);
        if (va < vDes) vDes = va;
      }
    }
    if (e.kind === 'lane') {
      // 끼어들려는 옆 차에게 틈을 (살짝만 줄인다)
      if (e.req.length) for (const r of e.req) {
        if (r === v) continue;
        const rs = e.sAtC(r.edge.cAt(r.s)), g = rs - r.len - v.s;
        if (g > -1 && g < 10 + v.v * 1.2) { const a = idmAccel(v.v, vDes, Math.max(0.3, g), v.v - r.v, v.a, v.T, v.s0, v.sqrtAB); acc = Math.min(acc, Math.max(a, -2.5)); }
      }
      const last = v.ri === v.route.length - 1 || v.route[v.ri] !== L;
      // 목적지 건물 — 진입로 앞에서 걷듯이
      if (v.dest.bld && v.dest.bld.lane === e && last) {
        const ds = v.dest.bld.sIn - v.s;
        if (ds > -0.5) { const va = Math.sqrt(2 * 1.8 * Math.max(0, ds)) + 3.5; if (va < vDes) vDes = va; lim(1e4, 0); }
      }
      const N = L.to;
      if (N.ctl !== 'gate') {
        if (!v.conn) {
          if (!(v.dest.bld && v.dest.bld.link === L && last)) lim(Math.max(0.05, dist - 0.4), v.v);
        } else if (!v.go) {
          // ★ '정지선에 닿았다'는 IDM 정지 간격(s0, 1.6~2.4 m) 만큼 여유를 둔다 — 2 m 로 재면 영영 닿지 않아 일시정지에서 섰다
          const cn = v.conn, sd = e.stopS - v.s, near = v.s0 + 1.4;
          let stop = false;
          if (cn.mv !== 'S' || cn.vmax < vDes) {      // 회전 속도에 맞춰 미리
            const va = Math.sqrt(cn.vmax * cn.vmax + 2 * 1.6 * Math.max(0, dist));
            if (va < vDes) { vDes = va; lim(1e4, 0); }
          }
          if (N.ctl === 'signal') {
            const s = this.sig(cn);
            if (s === 'G') stop = sd < 25 && (!this.spaceOK(cn, v) || !this.clear(cn, false));
            else if (s === 'Y') { if (v.yDec == null) v.yDec = sd < v.v * v.v / (2 * 3.2) + 1.0; stop = !v.yDec; }
            else {
              stop = true;
              if (cn.mv === 'R' && v.stopT > 1.5 && sd < near && this.spaceOK(cn, v) && this.clear(cn, true, true)) { stop = false; v.go = true; }
            }
            if (s !== 'Y') v.yDec = null;
          } else if (N.ctl === 'stop') {
            if (cn.minor && !v.halted) { stop = true; if (v.v < 0.4 && sd < near) v.halted = true; }
            else if (sd < 20) { stop = !this.spaceOK(cn, v) || !this.clear(cn, true); if (!stop && sd < near) v.go = true; }
          } else if (cn.conf.length && dist < 25) {
            stop = !this.clear(cn, true);
            if (!stop && dist < near) v.go = true;
          }
          if (stop) lim(Math.max(0.05, (N.ctl === 'signal' || N.ctl === 'stop' ? sd : dist - 0.4) - 0.2), v.v);
        }
      }
    } else if (e.kind === 'dout') {
      // 길가 차로로 끼어들 틈이 날 때까지 진출로 끝에서 기다린다
      if (dist < 12 && !this.joinOK(v)) lim(Math.max(0.05, dist - 0.3), v.v);
    }
    if (acc === Infinity) acc = idmAccel(v.v, vDes, 1e4, 0, v.a, v.T, v.s0, v.sqrtAB);
    return clamp(acc, -8, v.a);
  }
  joinOK(v) {
    const B = v.edge.bld, ln = B.lane, s = B.sOut;
    const { lead, fol } = this.around(ln, s);
    if (lead && lead.s - lead.len - s < 7) return false;
    if (fol && s - v.len - fol.s < 5 + fol.v * 1.7) return false;
    return true;
  }

  advance(v) {
    const e = v.edge;
    // 목적지 건물 — 길가 차로에서 진입로로
    if (e.kind === 'lane' && v.dest.bld && v.dest.bld.link === e.link && (v.ri === v.route.length - 1 || v.route[v.ri] !== e.link)) {
      const B = v.dest.bld;
      if (e === B.lane && v.s >= B.sIn - 0.3) {
        this.remove(e, v); v.edge = B.din; v.s = 0; v.v = Math.min(v.v, 5); B.din.cars.push(v);
        return false;
      }
      if (e.cAt(v.s) > B.lane.cAt(B.sIn) + 3 && !v.looped) {     // 지나쳤다 — 한 바퀴 돌아 다시 온다
        const r = this.loopRoute(e.link);
        if (r) { v.route = v.route.slice(0, v.ri).concat(r); this.pickConn(v); v.looped = true; }
      }
    }
    while (v.s >= v.edge.len) {
      const cur = v.edge;
      if (cur.kind === 'lane') {
        if (cur.link.to.gate) return true;
        if (!v.conn) { v.s = cur.len; v.v = 0; return false; }
        this.remove(cur, v); v.s -= cur.len; v.edge = v.conn; v.conn.cars.push(v);
        const N = cur.link.to;
        if (N.ctl === 'signal' || N.ctl === 'stop') { N.dSum += v.dAp; N.dN++; }
        v.dAp = 0; v.go = false; v.halted = false; v.yDec = null;
      } else if (cur.kind === 'conn') {
        const out = cur.to;
        this.remove(cur, v); v.s -= cur.len; v.edge = out; this.insertSorted(out, v);
        const L0 = v.route[v.ri]; if (L0) { const tt = this.time - v.tLink; L0.tt = L0.tt * 0.8 + tt * 0.2; }
        v.tLink = this.time; v.looped = false;
        v.ri++;
        if (v.route[v.ri] !== out.link) v.route = v.route.slice(0, v.ri).concat([out.link]);
        if (this.rng.chance(CSIM.reroute) && v.ri < v.route.length - 1) {
          const r = this.route(out.link, this.goalOf(v.dest));
          if (r && !(v.dest.bld && out.link === v.dest.bld.link)) v.route = v.route.slice(0, v.ri).concat(r);
        }
        this.pickConn(v);
      } else if (cur.kind === 'din') {
        return true;
      } else if (cur.kind === 'dout') {
        if (!this.joinOK(v)) { v.s = cur.len; v.v = Math.min(v.v, 0.5); return false; }
        const B = cur.bld;
        this.remove(cur, v); v.edge = B.lane; v.s = B.sOut + (v.s - cur.len); this.insertSorted(B.lane, v);
        v.tLink = this.time; v.ri = 0;
        this.pickConn(v);
        return false;
      }
    }
    return false;
  }
  finish(v) {
    this.remove(v.edge, v);
    const i = this.cars.indexOf(v); if (i >= 0) this.cars.splice(i, 1);
    v.gone = true;
    if (v.teleport) { this.st.unjam++; if (v.dest.bld) v.dest.bld.inbound--; return; }
    if (v.dest.bld) { const B = v.dest.bld; B.inbound--; B.occ++; B.nIn++; this.st.bIn++; }
    const tt = this.time - v.trip.t0;
    this.st.done++;
    this.st.trips.push({ t: this.time, tt, delay: Math.max(0, tt - v.ff), stops: v.stops, ff: v.ff });
    if (this.st.trips.length > 5000) this.st.trips.shift();
  }

  pose(v) {
    const p = v.edge.at(v.s, this._pp || (this._pp = {}));
    let x = p.x, y = p.y;
    if (v.lc) { x += Math.sin(p.h) * v.lc; y -= Math.cos(p.h) * v.lc; }
    v.h = p.h; v.p = p.p || 0;
    v.x = x - Math.cos(p.h) * v.len / 2; v.y = y - Math.sin(p.h) * v.len / 2; v.z = p.z - Math.sin(v.p) * v.len / 2;
  }

  /* ----- 기록 ----- */
  record() {
    const S = this.summary();
    this.st.hist.push({ t: this.time, n: S.n, vAvg: S.vAvg, done: this.st.done, queued: S.queued });
    if (this.st.hist.length > 720) this.st.hist.shift();
    for (const N of this.net.nodes) {
      if (N.dN) { const d = N.dSum / N.dN; N.dEma = N.dEma ? N.dEma * 0.7 + d * 0.3 : d; N.dSum = 0; N.dN = 0; }
      N.los = losCity(N.dEma);
    }
  }
  summary() {
    let n = 0, vs = 0, queued = 0;
    for (const v of this.cars) { n++; vs += v.v; if (v.v < 1) queued++; }
    const rec = this.st.trips.filter((t) => this.time - t.t < 600);
    const avg = (f) => (rec.length ? rec.reduce((a, t) => a + f(t), 0) / rec.length : 0);
    let occ = 0, cap = 0; for (const B of this.bldOK) { occ += B.occ; cap += B.cap; }
    return {
      n, vAvg: n ? vs / n : 0, queued, done: this.st.done, perH: Math.round(rec.length * 3600 / Math.max(60, Math.min(600, this.time))),
      tt: avg((t) => t.tt), delay: avg((t) => t.delay), stops: avg((t) => t.stops), waiting: this.pendGate.length + this.pendBld.length, lost: this.st.lost,
      unjam: this.st.unjam, detour: this.st.detour, occ, cap, bIn: this.st.bIn, bOut: this.st.bOut,
    };
  }
}
/** 가중치로 하나 고르기 (모두 0 이면 null) */
function pickW(rng, arr, w) {
  let s = 0; for (const a of arr) s += Math.max(0, w(a));
  if (s <= 0) return null;
  let u = rng.next() * s;
  for (const a of arr) { u -= Math.max(0, w(a)); if (u <= 0) return a; }
  return arr[arr.length - 1];
}
/** HCM 신호교차로 서비스 수준 — 차당 제어지체 (s) */
function losCity(d) { return d <= 10 ? 'A' : d <= 20 ? 'B' : d <= 35 ? 'C' : d <= 55 ? 'D' : d <= 80 ? 'E' : 'F'; }
function heapPush(h, x) { h.push(x); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; } }
function heapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && h[l][0] < h[m][0]) m = l; if (r < h.length && h[r][0] < h[m][0]) m = r; if (m === i) break; [h[m], h[i]] = [h[i], h[m]]; i = m; } }
  return top;
}
