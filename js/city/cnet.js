/* =============================================================================
   cnet.js — 도시 지도(사람이 고치는 모양) → 시뮬레이션 도로망(차가 달리는 차로 · 연결로)

   지도 (cmap.js 가 만들고 고친다, JSON 으로 저장된다)
     nodes  { id, x, y, level('ground'|'bridge'|'tunnel'), ctl?('auto'|'signal'|'stop'|'none'), phase?, cycle? }
     roads  { id, a, b, c1?, c2?(3차 베지어 조절점, 없으면 직선), cls, lanes:[A→B, B→A], level,
              ends: { a: 끝설정, b: 끝설정 } }      끝설정 = 그 노드로 들어가는 방향의 { bl 좌회전 전용 수, br 우회전 전용 수, len 회전 차로 길이, mv ['LS','S','SR'…] 차로별 방향 }
     blds   { id, x, y, w, d, rot, h, kind, cap?, acc?{ road, sc, side } }
   한 끝(차수 1)인 노드는 도시 밖과 잇는 출입구(게이트)다.

   높이 — 노드는 제 높이(지상 0 · 고가 7.5 · 지하 -8 m), 도로는 두 끝 사이를 잇되
     level 이 고가면 가운데를 7.5 m 로 들어 올리고(고가차도), 지하면 -8 m 로 내린다(지하차도) — 경사 6 %.
     같은 자리에서 겹친 두 도로는 높이가 4.5 m 넘게 다르면 서로 모른다(입체 교차). 지상끼리면 지도 편집이 교차로를 만든다.

   좌표 — x 동 · y 북 · z 위. 방향각 h = atan2(dy, dx), 진행 방향 오른쪽 = (sin h, -cos h). 우측통행.
   ========================================================================== */
'use strict';

const RCLS = {
  local: { name: '이면도로', v: 30, LW: 3.0, med: 0.2, sh: 0.3, sw: 2.5, cr: 5, lanes: [1, 1], score: 1 },
  street: { name: '일반도로', v: 50, LW: 3.25, med: 0.25, sh: 0.3, sw: 3.5, cr: 7, lanes: [2, 2], score: 2 },
  arterial: { name: '간선도로', v: 60, LW: 3.3, med: 0.35, sh: 0.3, sw: 4.5, cr: 10, lanes: [3, 3], score: 3 },
  highway: { name: '고속도로', v: 100, LW: 3.6, med: 2.0, sh: 2.5, sw: 0, cr: 0, lanes: [3, 3], score: 5, fast: true },
  ramp: { name: '램프(연결로)', v: 60, LW: 3.6, med: 0, sh: 1.5, sw: 0, cr: 0, lanes: [1, 0], score: 4, fast: true },
};
const LEVEL_Z = { ground: 0, bridge: 7.5, tunnel: -8 };
const LEVEL_KO = { ground: '지상', bridge: '고가', tunnel: '지하' };
const CN = {
  step: 1.0, grade: 0.06, flat: 10,
  Y: 3, AR: 2,
  stopBack: 6.0,          // 정지선 ~ 차로 끝 (횡단보도 몫)
  bayLen: 45, bayTaper: 15,
  accLen: 220, decLen: 160, fastTaper: 50,
  aLat: 2.0,              // 곡선에서 받아들이는 옆 가속도 (m/s²)
};

/* ---------- 경로 (x, y, z 표본 + 구간 역 c) ---------- */
class Path3 {
  constructor(X, Y, Z, C) {
    const n = X.length;
    this.n = n;
    this.x = Float64Array.from(X); this.y = Float64Array.from(Y); this.z = Float64Array.from(Z);
    this.c = C ? Float64Array.from(C) : null;
    const S = this.S = new Float64Array(n);
    for (let i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
    this.len = S[n - 1];
    const H = this.h = new Float64Array(n);
    for (let i = 0; i < n; i++) { const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1); H[i] = Math.atan2(Y[b] - Y[a], X[b] - X[a]); }
    // 곡선 속도 — 굽은 정도(방향 변화 / 거리)를 앞뒤 4 m 로 평균
    const K = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let a = i, b = i;
      while (a > 0 && S[i] - S[a] < 4) a--;
      while (b < n - 1 && S[b] - S[i] < 4) b++;
      const ds = S[b] - S[a];
      K[i] = ds > 0.5 ? Math.abs(wrapPi(H[b] - H[a])) / ds : 0;
    }
    this.vk = new Float32Array(n);
    for (let i = 0; i < n; i++) this.vk[i] = K[i] > 1e-4 ? Math.sqrt(CN.aLat / K[i]) : 99;
  }
  _i(s) {
    const n = this.n, S = this.S;
    let i = clamp(Math.floor(s / (this.len || 1) * (n - 1)), 0, n - 2);
    while (i > 0 && S[i] > s) i--;
    while (i < n - 2 && S[i + 1] < s) i++;
    return i;
  }
  at(s, o) {
    o = o || {};
    const n = this.n;
    if (s <= 0 || s >= this.len) {
      const e = s <= 0 ? 0 : n - 1, d = s <= 0 ? s : s - this.len;
      o.x = this.x[e] + Math.cos(this.h[e]) * d; o.y = this.y[e] + Math.sin(this.h[e]) * d; o.z = this.z[e]; o.h = this.h[e]; o.p = 0;
      return o;
    }
    const i = this._i(s), ds = this.S[i + 1] - this.S[i], t = ds > 1e-9 ? (s - this.S[i]) / ds : 0;
    o.x = this.x[i] + (this.x[i + 1] - this.x[i]) * t; o.y = this.y[i] + (this.y[i + 1] - this.y[i]) * t;
    o.z = this.z[i] + (this.z[i + 1] - this.z[i]) * t;
    o.h = this.h[i] + wrapPi(this.h[i + 1] - this.h[i]) * t;
    o.p = Math.atan2(this.z[i + 1] - this.z[i], ds || 1);
    return o;
  }
  /** 경로 위 s → 구간 역 */
  cAt(s) {
    if (!this.c) return s;
    if (s <= 0) return this.c[0] + s;
    if (s >= this.len) return this.c[this.n - 1] + (s - this.len);
    const i = this._i(s), ds = this.S[i + 1] - this.S[i], t = ds > 1e-9 ? (s - this.S[i]) / ds : 0;
    return this.c[i] + (this.c[i + 1] - this.c[i]) * t;
  }
  /** 구간 역 → 경로 위 s */
  sAtC(c) {
    const C = this.c; if (!C) return c;
    const n = this.n;
    if (c <= C[0]) return c - C[0];
    if (c >= C[n - 1]) return this.len + (c - C[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (C[m] <= c) lo = m; else hi = m; }
    const t = (c - C[lo]) / ((C[hi] - C[lo]) || 1);
    return this.S[lo] + (this.S[hi] - this.S[lo]) * t;
  }
  vmaxAt(s) { return this.vk[this._i(clamp(s, 0, this.len))]; }
}

/* ---------- 베지어 · 도로 중심선 ---------- */
function bezPt(P, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * P[0][0] + b * P[1][0] + c * P[2][0] + d * P[3][0], a * P[0][1] + b * P[1][1] + c * P[2][1] + d * P[3][1]];
}
/** 도로의 조절점 넷 (조절점이 없으면 직선의 1/3 · 2/3 점) */
function roadCtl(A, B, r) {
  const P0 = [A.x, A.y], P3 = [B.x, B.y];
  const P1 = r.c1 ? [r.c1[0], r.c1[1]] : [A.x + (B.x - A.x) / 3, A.y + (B.y - A.y) / 3];
  const P2 = r.c2 ? [r.c2[0], r.c2[1]] : [A.x + (B.x - A.x) * 2 / 3, A.y + (B.y - A.y) * 2 / 3];
  return [P0, P1, P2, P3];
}
/** 베지어를 같은 거리 간격(약 1 m)으로 — { x, y, h, t(베지어 매개변수), n, L, step } */
function sampleBez(P, step) {
  const N = 400, xs = [], ys = [], ts = [], S = [0];
  for (let i = 0; i <= N; i++) { const t = i / N, q = bezPt(P, t); xs.push(q[0]); ys.push(q[1]); ts.push(t); if (i) S.push(S[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])); }
  const L = S[N], n = Math.max(3, Math.round(L / (step || CN.step)) + 1), st = L / (n - 1);
  const x = new Float64Array(n), y = new Float64Array(n), tt = new Float64Array(n), h = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = i * st;
    while (j < N - 1 && S[j + 1] < s) j++;
    const u = clamp((s - S[j]) / ((S[j + 1] - S[j]) || 1), 0, 1);
    x[i] = xs[j] + (xs[j + 1] - xs[j]) * u; y[i] = ys[j] + (ys[j + 1] - ys[j]) * u; tt[i] = ts[j] + (ts[j + 1] - ts[j]) * u;
  }
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1); h[i] = Math.atan2(y[b] - y[a], x[b] - x[a]); }
  return { x, y, h, t: tt, n, L, step: st };
}
/** 높이 — 두 끝 노드 높이와 도로 level 로 (표본마다) */
function zProfile(g, za, zb, level) {
  const n = g.n, L = g.L, z = new Float64Array(n), Z = LEVEL_Z[level] || 0, G = CN.grade, F = CN.flat;
  for (let i = 0; i < n; i++) {
    const s = i * g.step;
    let v = za + (zb - za) * smoothstep(s / L);
    if (level === 'bridge' && Z > Math.min(za, zb) + 0.5) v = Math.max(v, Math.min(Z, za + G * Math.max(0, s - F), zb + G * Math.max(0, L - s - F)));
    if (level === 'tunnel' && Z < Math.max(za, zb) - 0.5) v = Math.min(v, Math.max(Z, za - G * Math.max(0, s - F), zb - G * Math.max(0, L - s - F)));
    z[i] = v;
  }
  if (level !== 'ground') {         // 꺾인 곳을 둥글게 (끝 평탄부 안에서는 그대로)
    const R = 9, out = new Float64Array(n);
    for (let i = 0; i < n; i++) { let a = 0, k = 0; for (let j = Math.max(0, i - R); j <= Math.min(n - 1, i + R); j++) { a += z[j]; k++; } out[i] = a / k; }
    out[0] = za; out[n - 1] = zb;
    return out;
  }
  return z;
}
/** 지도 도로 하나의 모양 (편집기 · 도로망 둘 다 쓴다) */
function roadShape(map, r, nodeOf) {
  const A = nodeOf(r.a), B = nodeOf(r.b);
  const P = roadCtl(A, B, r), g = sampleBez(P);
  g.P = P;
  g.z = zProfile(g, LEVEL_Z[A.level] || 0, LEVEL_Z[B.level] || 0, r.level || 'ground');
  return g;
}
function shapeAt(g, sc, o) {
  o = o || {};
  const f = clamp(sc / g.step, 0, g.n - 1), i = Math.min(g.n - 2, f | 0), t = f - i;
  o.x = g.x[i] + (g.x[i + 1] - g.x[i]) * t; o.y = g.y[i] + (g.y[i + 1] - g.y[i]) * t; o.z = g.z[i] + (g.z[i + 1] - g.z[i]) * t;
  o.h = g.h[i] + wrapPi(g.h[i + 1] - g.h[i]) * t;
  if (sc < 0) { o.x += Math.cos(g.h[0]) * sc; o.y += Math.sin(g.h[0]) * sc; }
  else if (sc > g.L) { const d = sc - g.L, e = g.n - 1; o.x += Math.cos(g.h[e]) * d; o.y += Math.sin(g.h[e]) * d; }
  return o;
}

/* ---------- 도로망 ---------- */
/**
 * 지도 → 도로망. 반환 net:
 *   nodes · roads · links(방향마다 한 줄) · lanes · conns(교차로 안 연결로) · gates · blds · warn(지도 문제 목록)
 */
function compileNet(map, opt) {
  opt = opt || {};
  const net = { map, nodes: [], roads: [], links: [], lanes: [], conns: [], drives: [], gates: [], blds: [], warn: [], nodeById: new Map(), roadById: new Map() };
  let eid = 0;
  // 노드
  for (const m of map.nodes) {
    const N = { id: m.id, m, x: m.x, y: m.y, z: LEVEL_Z[m.level] || 0, level: m.level || 'ground', legs: [], inLinks: [], outLinks: [], conns: [], ctl: 'none', dSum: 0, dN: 0, dEma: 0, los: 'A', gate: false };
    net.nodes.push(N); net.nodeById.set(m.id, N);
  }
  const nodeOf = (id) => net.nodeById.get(id);
  // 도로 모양 · 다리(노드에서 본 도로 끝)
  for (const m of map.roads) {
    const A = nodeOf(m.a), B = nodeOf(m.b);
    if (!A || !B || A === B) continue;
    const cl = RCLS[m.cls] || RCLS.street;
    const g = roadShape(map, m, (id) => nodeOf(id).m);
    const lanes = [clamp(m.lanes ? m.lanes[0] | 0 : cl.lanes[0], 0, 6), clamp(m.lanes ? m.lanes[1] | 0 : cl.lanes[1], 0, 6)];
    if (lanes[0] + lanes[1] === 0) lanes[0] = 1;
    const R = { id: m.id, m, A, B, cl, cls: m.cls in RCLS ? m.cls : 'street', g, L: g.L, n: lanes, level: m.level || 'ground', twoWay: lanes[0] > 0 && lanes[1] > 0, ends: m.ends || {}, links: [null, null] };
    net.roads.push(R); net.roadById.set(m.id, R);
    // 다리 — 노드에서 바깥으로 뻗는 방향
    const mk = (N, end) => {
      const h = end === 'a' ? g.h[0] : g.h[g.n - 1] + Math.PI;
      const leg = { road: R, node: N, end, ang: wrapPi(h), sb: 0, inN: end === 'a' ? lanes[1] : lanes[0], outN: end === 'a' ? lanes[0] : lanes[1] };
      N.legs.push(leg); return leg;
    };
    R.legA = mk(A, 'a'); R.legB = mk(B, 'b');
  }
  // 노드 제어 — 차수 · 도로 종류로 정하고, 지도에서 고른 값이 있으면 그것
  // 끝 노드(차수 1)는 도로망 바깥쪽에 있으면 도시 밖 출입구, 안쪽이면 막다른 길(돌아 나오는 원) — m.gate 로 바꿀 수 있다
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const N of net.nodes) if (N.legs.length >= 2) { bx0 = Math.min(bx0, N.x); by0 = Math.min(by0, N.y); bx1 = Math.max(bx1, N.x); by1 = Math.max(by1, N.y); }
  for (const N of net.nodes) {
    const deg = N.legs.length, fast = N.legs.every((l) => l.road.cl.fast);
    if (deg === 0) continue;
    if (deg === 1) {
      const out = !(N.x > bx0 + 10 && N.x < bx1 - 10 && N.y > by0 + 10 && N.y < by1 - 10);
      const gate = N.m.gate === true || (N.m.gate !== false && (out || fast));
      if (gate) { N.ctl = 'gate'; N.gate = true; } else N.ctl = 'end';
      continue;
    }
    const want = N.m.ctl && N.m.ctl !== 'auto' ? N.m.ctl : null;
    if (fast) N.ctl = 'merge';
    else if (want) N.ctl = want;
    else if (deg === 2) N.ctl = 'none';
    else if (N.legs.some((l) => l.road.cls === 'ramp' || l.road.cls === 'street' || l.road.cls === 'arterial' || l.road.cls === 'highway')) N.ctl = 'signal';
    else N.ctl = 'stop';
    if (deg === 2 && N.ctl === 'signal' && !want) N.ctl = 'none';
  }
  // 고속 합류 · 분류 — 램프가 고속도로 진행 방향 오른쪽에서 붙으면 가속 · 감속 차로를 덧붙인다
  for (const N of net.nodes) {
    if (N.ctl !== 'merge') continue;
    for (const lr of N.legs) {
      if (lr.road.cls !== 'ramp') continue;
      for (const lh of N.legs) {
        if (lh === lr || lh.road.cls !== 'highway') continue;
        // 합류: 램프가 들어오고(inN) 고속도로가 나간다(outN) — 램프 들어오는 방향과 고속 나가는 방향이 비슷하고, 램프가 오른쪽
        if (lr.inN > 0 && lh.outN > 0) {
          const hIn = lr.ang + Math.PI, hOut = lh.ang, d = Math.abs(wrapPi(hOut - hIn));
          const side = Math.sin(lr.ang - lh.ang);         // 램프 다리가 고속 다리의 오른쪽(시계 방향)이면 음수
          if (d < 1.2 && side < 0) { lh.acc = lr; lr.mergeTo = lh; }
        }
        // 분류: 고속도로가 들어오고(inN) 램프가 나간다(outN)
        if (lh.inN > 0 && lr.outN > 0) {
          const hIn = lh.ang + Math.PI, hOut = lr.ang, d = Math.abs(wrapPi(hOut - hIn));
          const side = Math.sin(lr.ang - (lh.ang + Math.PI));
          if (d < 1.2 && side < 0) { lh.dec = lr; lr.divFrom = lh; }
        }
      }
      if (lr.inN > 0 && !lr.mergeTo) net.warn.push({ kind: 'ramp', road: lr.road.id, msg: '램프가 고속도로 진행 방향 오른쪽에서 붙지 않아 합류할 수 없습니다' });
      if (lr.outN > 0 && !lr.divFrom) net.warn.push({ kind: 'ramp', road: lr.road.id, msg: '램프가 고속도로 진행 방향 오른쪽으로 갈라지지 않아 나갈 수 없습니다' });
    }
  }
  // 끝 설정 (회전 전용 차로) — 그 노드로 들어가는 방향 몫
  const endCfg = (R, end) => R.ends[end] || {};
  // 방향 하나의 차로 칸 — [{type, r}] 안쪽부터
  const slotsOf = (R, d) => {
    const n = R.n[d > 0 ? 0 : 1], end = d > 0 ? 'b' : 'a', st = d > 0 ? 'a' : 'b';
    const E = endCfg(R, end), N = d > 0 ? R.B : R.A, legEnd = d > 0 ? R.legB : R.legA, legSt = d > 0 ? R.legA : R.legB;
    const ctlEnd = N.ctl;
    const surf = ctlEnd === 'signal' || ctlEnd === 'stop' || ctlEnd === 'none';
    const roomy = R.L - (R.A.legs.length > 1 ? 30 : 0) - (R.B.legs.length > 1 ? 30 : 0) > clamp(+E.len || CN.bayLen, 15, 150) + 25;   // 회전 차로를 낼 만큼 긴가
    const bl = surf && roomy && N.legs.length > 2 ? clamp(E.bl | 0, 0, 2) : 0, br = surf && roomy && N.legs.length > 2 ? clamp(E.br | 0, 0, 1) : 0;
    const out = [];
    for (let k = 0; k < bl; k++) out.push({ type: 'bayL', r: k });
    for (let k = 0; k < n; k++) out.push({ type: 'thru', r: bl + k });
    if (br) out.push({ type: 'bayR', r: bl + n });
    if (legEnd.dec) out.push({ type: 'dec', r: bl + n, to: legEnd.dec });
    if (legSt.acc) out.push({ type: 'acc', r: bl + n, from: legSt.acc });
    return { slots: out, bl, br, bayLen: clamp(+E.len || CN.bayLen, 15, 150) };
  };
  // 물러섬 — 교차로 모서리에서 두 다리의 가장자리가 만나는 거리 + 연석 반경
  const halfW = (R, d, atEnd) => {
    const cl = R.cl, n = R.n[d > 0 ? 0 : 1];
    if (!n) return R.twoWay ? cl.med : 0;
    const E = endCfg(R, d > 0 ? 'b' : 'a');
    const extra = atEnd ? clamp(E.bl | 0, 0, 2) + clamp(E.br | 0, 0, 1) : 0;
    const w = cl.LW * (n + extra) + cl.sh;
    return R.twoWay ? cl.med + w : w / 2 + cl.LW * extra / 2;
  };
  for (const N of net.nodes) {
    const legs = N.legs;
    if (N.ctl === 'end') { const l = legs[0], R = l.road; l.gap = TAU; l.next = l.prev = l; l.wR = l.wL = (R.twoWay ? R.cl.med : 0) + R.cl.LW * Math.max(R.n[0], R.n[1]) + R.cl.sh; l.sw = R.cl.sw; l.sb = 1; continue; }
    if (legs.length < 2) continue;
    for (const l of legs) {
      const R = l.road;
      // 다리를 바깥으로 볼 때 오른쪽 = 노드에서 나가는 방향 차로, 왼쪽 = 들어오는 방향 (일방통행이면 반씩)
      const dOut = l.end === 'a' ? 1 : -1;
      l.wR = R.twoWay ? halfW(R, dOut, false) : (R.n[0] + R.n[1]) * R.cl.LW / 2 + R.cl.sh;
      l.wL = R.twoWay ? halfW(R, -dOut, true) : l.wR;
      l.sw = R.cl.sw;
    }
    legs.sort((p, q) => p.ang - q.ang);
    const k = legs.length;
    for (let i = 0; i < k; i++) {
      const li = legs[i], lj = legs[(i + 1) % k];
      let th = lj.ang - li.ang; if (k === 1) th = TAU; if (th <= 0) th += TAU;
      li.next = lj; lj.prev = li; li.gap = th;
      if (th > 2.75) continue;
      const t = Math.max(th, 0.2), s = Math.sin(t), c = Math.cos(t);
      const wi = li.wL + (li.sw || 0) * 0.3, wj = lj.wR + (lj.sw || 0) * 0.3;
      li.sb = Math.max(li.sb, (wj + wi * c) / s);
      lj.sb = Math.max(lj.sb, (wi + wj * c) / s);
    }
    const ctl = N.ctl;
    for (const l of legs) {
      const R = l.road, wmax = Math.max(l.wL, l.wR);
      let m;
      if (ctl === 'merge') m = 3;
      else if (ctl === 'none' && legs.length === 2) m = l.sb > 0.5 ? 2 : 0;
      else m = Math.max(R.cl.cr, 3);
      l.sb = l.sb + m;
      if (legs.length >= 3 && ctl !== 'merge') l.sb = Math.max(l.sb, wmax + 3 + (R.cl.sw ? CN.stopBack : 0));
      l.sb = Math.min(l.sb, ctl === 'merge' ? 75 : 45);
      if (legs.length === 2 && ctl === 'none' && l.next.gap > 2.75 && l.prev.gap > 2.75) l.sb = 0.5;
    }
  }
  // 구간 (방향마다)
  for (const R of net.roads) {
    let sa = R.A.gate ? 0 : R.legA.sb, sb = R.B.gate ? 0 : R.legB.sb;
    if (sa + sb > R.L - 4) { const f = (R.L - 4) / (sa + sb); sa *= f; sb *= f; net.warn.push({ kind: 'short', road: R.id, msg: '도로가 짧아 교차로가 겹칩니다' }); }
    R.sa = sa; R.sb = sb;
    for (const d of [1, -1]) {
      const n = R.n[d > 0 ? 0 : 1];
      if (!n) continue;
      const from = d > 0 ? R.A : R.B, to = d > 0 ? R.B : R.A;
      const len = R.L - sa - sb;
      const L = { id: net.links.length, road: R, d, from, to, len, cl: R.cl, vLim: R.cl.v * KMH, lanes: [], endLanes: [], startLanes: [], next: [], tt: 0, ttN: 0, nThru: n };
      const S = slotsOf(R, d);
      L.bl = S.bl; L.br = S.br;
      const bayLen = Math.min(S.bayLen, Math.max(12, len - CN.bayTaper - 12));
      // 차로 칸마다 있는 정도(0~1) — 덧붙는 차로는 끝으로 갈수록(회전) 또는 시작에서(가속) 점점
      for (const sl of S.slots) {
        const fast = sl.type === 'acc' || sl.type === 'dec';
        const tp = fast ? CN.fastTaper : CN.bayTaper;
        if (sl.type === 'thru') { sl.p = () => 1; sl.t0 = 0; sl.t1 = len; }
        else if (sl.type === 'acc') {
          const a = Math.min(CN.accLen, len * 0.7);
          sl.t0 = 0; sl.t1 = Math.max(10, a - tp); sl.p = (t) => 1 - smoothstep((t - sl.t1) / tp);
        } else {
          const bl = sl.type === 'dec' ? Math.min(CN.decLen, len * 0.7) : bayLen;
          sl.t0 = Math.max(0, len - bl); sl.t1 = len; sl.p = (t) => smoothstep((t - (sl.t0 - tp)) / tp);
        }
      }
      const base = R.twoWay ? R.cl.med : -(n * R.cl.LW) / 2;
      L.base = base; L.slots = S.slots;
      L.offOf = (sl, t) => { let a = base; for (const o of S.slots) if (o.r < sl.r) a += R.cl.LW * o.p(t); return a + R.cl.LW / 2; };
      L.outer = (t) => { let a = base; for (const o of S.slots) a += R.cl.LW * o.p(t); return a; };
      L.center = (t, o) => { const sc = d > 0 ? sa + t : R.L - sb - t; shapeAt(R.g, sc, o); if (d < 0) o.h = wrapPi(o.h + Math.PI); return o; };
      // 차로 경로
      for (const sl of S.slots) {
        const X = [], Y = [], Z = [], C = [], o = {};
        const st = Math.max(1, Math.min(2, (sl.t1 - sl.t0) / 6));
        for (let t = sl.t0; ; t = Math.min(sl.t1, t + st)) {
          L.center(t, o);
          const off = L.offOf(sl, t);
          X.push(o.x + Math.sin(o.h) * off); Y.push(o.y - Math.cos(o.h) * off); Z.push(o.z); C.push(t);
          if (t >= sl.t1) break;
        }
        const ln = new Path3(X, Y, Z, C);
        Object.assign(ln, { kind: 'lane', id: eid++, link: L, r: sl.r, type: sl.type, t0: sl.t0, t1: sl.t1, cars: [], inConns: [], outTo: new Map(), mv: '', req: [], slot: sl });
        L.lanes.push(ln); net.lanes.push(ln);
        if (sl.t1 >= len - 1e-6) L.endLanes.push(ln);
        if (sl.t0 <= 1e-6) L.startLanes.push(ln);
      }
      L.endLanes.sort((p, q) => p.r - q.r); L.startLanes.sort((p, q) => p.r - q.r);
      R.links[d > 0 ? 0 : 1] = L;
      from.outLinks.push(L); to.inLinks.push(L);
      net.links.push(L);
    }
  }
  for (const l of net.nodes.flatMap((N) => N.legs)) {
    const R = l.road;
    l.inLink = l.end === 'a' ? R.links[1] : R.links[0];
    l.outLink = l.end === 'a' ? R.links[0] : R.links[1];
  }
  // 교차로 연결로
  for (const N of net.nodes) {
    if (N.legs.length < 2 && N.ctl !== 'end') continue;
    buildConns(net, N, () => eid++);
  }
  for (const N of net.nodes) {
    if (N.ctl === 'signal') signalPlanNode(N, map.sig || {});
    if (N.ctl === 'stop' || N.ctl === 'none' || N.ctl === 'merge') rankConns(N);
    findConflicts(N);
  }
  // 정지선 · 다음 구간
  for (const L of net.links) {
    const N = L.to;
    for (const ln of L.endLanes) ln.stopS = ln.len - ((N.ctl === 'signal' || N.ctl === 'stop') && L.cl.sw ? CN.stopBack : 0.4);
    const seen = new Map();
    for (const ln of L.lanes) for (const [lid, cs] of ln.outTo) if (!seen.has(lid)) seen.set(lid, cs[0].mv);
    for (const [lid, mv] of seen) L.next.push({ L: net.links[lid], mv });
    L.tt = L.len / L.vLim + (N.ctl === 'signal' ? 12 : N.ctl === 'stop' ? 6 : 0);
    L.ff = L.len / L.vLim;
  }
  // 게이트
  for (const N of net.nodes) {
    if (!N.gate) continue;
    const l = N.legs[0], R = l.road;
    const gin = l.outLink, gout = l.inLink;      // 게이트에서 나가는 구간 = 도시로 들어오는 길
    const w = (R.cl.score >= 5 ? 5 : R.cl.score) * Math.max(1, R.n[0] + R.n[1]) / 2 * (+N.m.w || 1);
    net.gates.push({ N, inL: gin, outL: gout, w, road: R });
  }
  // 서로 오갈 수 있는 가장 큰 구간 묶음 — 건물은 여기에만 붙인다 (출입로에 매달린 길은 한 출입구로만 오간다)
  net.main = mainComponent(net.links);
  // 건물 출입
  for (const b of map.blds || []) {
    const B = { id: b.id, m: b, cap: Math.max(2, b.cap || bldCap(b)), occ: 0, inbound: 0, nIn: 0, nOut: 0, queue: 0 };
    attachBld(net, B);
    net.blds.push(B);
  }
  // 도달 가능성 점검 — 어느 출입구에서도 못 나가는 도로
  for (const g of net.gates) if (!g.inL || !g.outL) g.dead = true;
  return net;
}

/** 구간 그래프에서 가장 큰 강연결 묶음 (코사라주) */
function mainComponent(links) {
  const n = links.length, seen = new Uint8Array(n), order = [], comp = new Int32Array(n).fill(-1), rev = links.map(() => []);
  for (const L of links) for (const e of L.next) rev[e.L.id].push(L.id);
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    const st = [[s, 0]]; seen[s] = 1;
    while (st.length) {
      const top = st[st.length - 1], nx = links[top[0]].next;
      if (top[1] < nx.length) { const u = nx[top[1]++].L.id; if (!seen[u]) { seen[u] = 1; st.push([u, 0]); } }
      else { order.push(top[0]); st.pop(); }
    }
  }
  let c = 0; const size = [];
  for (let k = n - 1; k >= 0; k--) {
    const s = order[k]; if (comp[s] >= 0) continue;
    const st = [s]; comp[s] = c; let m = 0;
    while (st.length) { const u = st.pop(); m++; for (const w of rev[u]) if (comp[w] < 0) { comp[w] = c; st.push(w); } }
    size.push(m); c++;
  }
  let best = 0; for (let i = 1; i < size.length; i++) if (size[i] > size[best]) best = i;
  return new Set(links.filter((L) => comp[L.id] === best));
}
/** 건물 주차 대수 — 용도 · 바닥 넓이 · 층수 */
function bldCap(b) {
  const fl = Math.max(1, Math.round((b.h || 10) / 3.4)), a = b.w * b.d;
  if (b.kind === 'parking') return clamp(Math.round(a * fl / 30), 20, 600);
  const k = { office: 110, apart: 90, shop: 70, school: 300 }[b.kind] || 100;
  return clamp(Math.round(a * fl / k), 4, 400);
}

/** 연결로 — 들어오는 구간 차로 끝 → 나가는 구간 차로 시작 */
function buildConns(net, N, nextId) {
  const legs = N.legs;
  const mkConn = (a, b, mv) => {
    const P0 = a.at(a.len), P1 = b.at(0);
    const d0x = Math.cos(P0.h), d0y = Math.sin(P0.h), d1x = Math.cos(P1.h), d1y = Math.sin(P1.h);
    const ch = Math.hypot(P1.x - P0.x, P1.y - P0.y);
    let c1, c2;
    const den = d0x * d1y - d0y * d1x;
    let t0 = -1, t1 = -1;
    if (Math.abs(den) > 0.05) {         // 두 방향선이 만나는 점이 앞에 있으면 그 점을 향해 휜다
      t0 = ((P1.x - P0.x) * d1y - (P1.y - P0.y) * d1x) / den;
      t1 = ((P1.x - P0.x) * d0y - (P1.y - P0.y) * d0x) / den;
    }
    if (mv === 'U') {
      const k = Math.max(8, ch * 1.1);
      c1 = [P0.x + d0x * k, P0.y + d0y * k]; c2 = [P1.x - d1x * k, P1.y - d1y * k];
    } else if (t0 > 0.5 && t1 > 0.5 && t0 < ch * 2 && t1 < ch * 2) {
      const k0 = t0 * 0.6, k1 = t1 * 0.6;
      c1 = [P0.x + d0x * k0, P0.y + d0y * k0]; c2 = [P1.x - d1x * k1, P1.y - d1y * k1];
    } else {
      const k = Math.max(1, ch * 0.38);
      c1 = [P0.x + d0x * k, P0.y + d0y * k]; c2 = [P1.x - d1x * k, P1.y - d1y * k];
    }
    const P = [[P0.x, P0.y], c1, c2, [P1.x, P1.y]];
    const m = Math.max(4, Math.ceil(ch / 0.6));
    const X = [], Y = [], Z = [];
    for (let i = 0; i <= m; i++) { const u = i / m, q = bezPt(P, u); X.push(q[0]); Y.push(q[1]); Z.push(P0.z + (P1.z - P0.z) * smoothstep(u)); }
    const cn = new Path3(X, Y, Z);
    let vk = 99; for (let i = 0; i < cn.n; i++) vk = Math.min(vk, cn.vk[i]);
    Object.assign(cn, { kind: 'conn', id: nextId(), from: a, to: b, mv, node: N, cars: [], conf: [], greens: [], rank: 3, vmax: Math.min(vk, a.link.vLim, b.link.vLim, mv === 'S' ? 99 : mv === 'L' ? 8 : mv === 'U' ? 4.5 : 6) });
    cn.vmax = Math.max(cn.vmax, 3.5);
    b.inConns.push(cn); N.conns.push(cn); net.conns.push(cn);
    if (!a.outTo.has(b.link.id)) a.outTo.set(b.link.id, []);
    a.outTo.get(b.link.id).push(cn);
    return cn;
  };
  const map1 = (A, B, mv) => {
    if (!A.length || !B.length) return;
    if (mv === 'L') A.forEach((a, i) => mkConn(a, B[Math.min(i, B.length - 1)], mv));
    else if (mv === 'R') A.forEach((a, i) => { const j = A.length - 1 - i; mkConn(A[j], B[Math.max(0, B.length - 1 - i)], mv); });
    else if (A.length >= B.length) A.forEach((a, i) => mkConn(a, B[Math.min(B.length - 1, Math.floor(i * B.length / A.length))], mv));
    else { A.forEach((a, i) => mkConn(a, B[i], mv)); for (let j = A.length; j < B.length; j++) mkConn(A[A.length - 1], B[j], mv); }
  };
  const turnOf = (Lin, Lout) => {
    const hin = Lin.center(Lin.len, {}).h, hout = Lout.center(0, {}).h;
    const t = wrapPi(hout - hin);
    return Math.abs(t) < 0.6 ? 'S' : Math.abs(t) > 2.55 ? 'U' : t > 0 ? 'L' : 'R';
  };
  if (N.ctl === 'end') {           // 막다른 길 — 끝에서 돌아 나온다 (돌림 원)
    const l = legs[0];
    if (l.inLink && l.outLink) { const B = l.outLink.startLanes; l.inLink.endLanes.forEach((a, i) => { a.mv = 'U'; mkConn(a, B[Math.min(i, B.length - 1)], 'U'); }); }
    return;
  }
  if (N.ctl === 'merge') {
    for (const li of legs) {
      const Lin = li.inLink; if (!Lin) continue;
      for (const lo of legs) {
        if (lo === li) continue;
        const Lout = lo.outLink; if (!Lout) continue;
        const ri = li.road.cls === 'ramp', ro = lo.road.cls === 'ramp';
        const thruIn = Lin.endLanes.filter((l) => l.type !== 'dec'), outThru = Lout.startLanes.filter((l) => l.type !== 'acc');
        if (!ri && !ro) { if (turnOf(Lin, Lout) !== 'U') map1(thruIn, outThru, 'S'); }
        else if (!ri && ro) { if (li.dec === lo) map1(Lin.endLanes.filter((l) => l.type === 'dec'), Lout.startLanes, 'R'); }
        else if (ri && !ro) { if (lo.acc === li) map1(Lin.endLanes, Lout.startLanes.filter((l) => l.type === 'acc'), 'S'); }
        else if (turnOf(Lin, Lout) !== 'U') map1(Lin.endLanes, Lout.startLanes, 'S');
      }
    }
    for (const L of N.inLinks) for (const ln of L.endLanes) ln.mv = ln.type === 'dec' ? 'R' : 'S';
    return;
  }
  for (const li of legs) {
    const Lin = li.inLink; if (!Lin) continue;
    // 갈 수 있는 방향
    const outs = [];
    for (const lo of legs) {
      if (lo === li || !lo.outLink) continue;
      const mv = turnOf(Lin, lo.outLink);
      if (mv === 'U') continue;
      outs.push({ lo, mv });
    }
    const avail = new Set(outs.map((o) => o.mv));
    const E = (li.road.ends || {})[li.end] || {};
    const lanes = Lin.endLanes;
    let masks = null;
    if (Array.isArray(E.mv) && E.mv.length === lanes.length) masks = E.mv.map((s) => [...String(s)].filter((c) => avail.has(c)).join(''));
    if (!masks || masks.some((m) => !m)) masks = defaultMasks(lanes, avail);
    // ★ 짧은 구간(35 m 미만)에서는 차로를 바꿀 틈이 없다 — 어느 차로에서든 어디로든 가게 한다 (안 그러면 끝에서 갇힌다)
    if (Lin.len < 35 && !(Array.isArray(E.mv) && E.mv.length === lanes.length)) masks = lanes.map(() => [...avail].join(''));
    lanes.forEach((ln, i) => { ln.mv = masks[i]; });
    for (const { lo, mv } of outs) {
      const A = lanes.filter((ln) => ln.mv.includes(mv));
      map1(A, lo.outLink.startLanes.filter((l) => l.type !== 'acc'), mv);
    }
  }
}
/** 차로별 기본 방향 — 좌회전 전용 → L, 우회전 전용 → R, 직진 차로 안쪽 끝은 L 도, 바깥쪽 끝은 R 도 */
function defaultMasks(lanes, avail) {
  const thru = lanes.filter((l) => l.type === 'thru'), hasBL = lanes.some((l) => l.type === 'bayL'), hasBR = lanes.some((l) => l.type === 'bayR');
  const m = lanes.map((ln) => {
    if (ln.type === 'bayL') return 'L';
    if (ln.type === 'bayR' || ln.type === 'dec') return 'R';
    const i = thru.indexOf(ln), n = thru.length;
    let s = '';
    if (avail.has('S')) {
      s = 'S';
      if (i === 0 && !hasBL) s = 'L' + s;
      if (i === n - 1 && !hasBR) s += 'R';
    } else {                          // 직진할 곳이 없다 (T 자의 줄기) — 안쪽 반은 좌, 바깥쪽 반은 우
      if (n === 1) s = (hasBL ? '' : 'L') + (hasBR ? '' : 'R');
      else s = i < n / 2 ? 'L' : 'R';
      if (!s) s = 'L';
    }
    return s;
  });
  return m.map((s) => { const t = [...s].filter((c) => avail.has(c)).join(''); return t || [...avail][0] || 'S'; });
}

/** 신호 현시 — 마주 보는 다리끼리 짝을 지어 '직진 후 좌회전' 또는 진입로별로 */
function signalPlanNode(N, sig) {
  const phase = N.m.phase || sig.phase || 'lead';
  const C = clamp(+(N.m.cycle || sig.cycle) || (N.legs.length >= 5 ? 130 : N.legs.length === 4 ? 100 : 80), 40, 200);
  const legs = N.legs.filter((l) => l.inLink);
  const score = (l) => l.road.cl.score * 10 + l.road.n[0] + l.road.n[1];
  const pairs = [], used = new Set();
  const cand = [];
  for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) {
    const e = Math.abs(wrapPi(legs[i].ang - legs[j].ang - Math.PI));
    if (e < 0.6) cand.push([e, legs[i], legs[j]]);
  }
  cand.sort((p, q) => p[0] - q[0]);
  for (const [, a, b] of cand) if (!used.has(a) && !used.has(b)) { used.add(a); used.add(b); pairs.push([a, b]); }
  for (const l of legs) if (!used.has(l)) pairs.push([l]);
  pairs.sort((p, q) => q.reduce((s, l) => s + score(l), 0) - p.reduce((s, l) => s + score(l), 0));
  const ph = [];
  const connsOf = (grp, mvs) => N.conns.filter((c) => grp.some((l) => l.inLink === c.from.link) && mvs.includes(c.mv));
  if (phase === 'approach' || legs.length > 5) for (const l of legs) ph.push({ conns: connsOf([l], 'LSR'), legs: [l] });
  else for (const g of pairs) {
    if (g.length === 2) { ph.push({ conns: connsOf(g, 'SR'), legs: g, kind: 'S' }); ph.push({ conns: connsOf(g, 'L'), legs: g, kind: 'L' }); }
    else ph.push({ conns: connsOf(g, 'LSR'), legs: g });
  }
  const P = ph.filter((p) => p.conns.length);
  const lost = P.length * (CN.Y + CN.AR), av = Math.max(P.length * 7, C - lost);
  let wsum = 0;
  for (const p of P) { p.w = new Set(p.conns.map((c) => c.from)).size + 0.5; wsum += p.w; }
  for (const p of P) p.g = Math.max(7, av * p.w / wsum);
  P.forEach((p, i) => { for (const c of p.conns) c.greens.push(i); });
  N.plan = { ph: P, cyc: P.reduce((a, p) => a + p.g + CN.Y + CN.AR, 0), phase };
  if (!P.length) { N.ctl = 'none'; rankConns(N); }
}
/** 우선순위 — 일시정지 교차로는 큰 길(짝 지은 다리 중 가장 큰 쪽)이 먼저, 합류는 본선이 먼저 */
function rankConns(N) {
  if (N.ctl === 'merge' || N.ctl === 'none') { for (const c of N.conns) c.rank = c.from.link.road.cls === 'ramp' && c.to.link.road.cls !== 'ramp' ? 1 : c.mv === 'L' ? 2 : 3; return; }
  const legs = N.legs.filter((l) => l.inLink), score = (l) => l.road.cl.score * 10 + l.road.n[0] + l.road.n[1];
  let best = null, bs = -1;
  for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) {
    if (Math.abs(wrapPi(legs[i].ang - legs[j].ang - Math.PI)) > 0.6) continue;
    const s = score(legs[i]) + score(legs[j]); if (s > bs) { bs = s; best = [legs[i], legs[j]]; }
  }
  const major = new Set(best || []);
  N.major = major;
  for (const c of N.conns) { const l = legs.find((g) => g.inLink === c.from.link); c.rank = major.has(l) ? (c.mv === 'L' ? 2 : 3) : 1; c.minor = !major.has(l); }
}
/** 교차로 안에서 서로 지나는(또는 같은 차로로 모이는) 연결로 짝과 그 점 */
function findConflicts(N) {
  const cs = N.conns;
  for (const c of cs) { c.conf = []; c.box = bboxOf(c); }
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
    const a = cs[i], b = cs[j];
    if (a.from === b.from) continue;
    if (a.to === b.to) { a.conf.push({ k: b, sMe: a.len, sOt: b.len }); b.conf.push({ k: a, sMe: b.len, sOt: a.len }); continue; }
    if (a.from.link === b.from.link && a.mv === b.mv) continue;
    if (a.box[2] < b.box[0] || b.box[2] < a.box[0] || a.box[3] < b.box[1] || b.box[3] < a.box[1]) continue;
    if (Math.abs(a.z[0] - b.z[0]) > 4 && Math.abs(a.z[a.n - 1] - b.z[b.n - 1]) > 4) continue;
    const x = crossPolys(a, b);
    if (x) { a.conf.push({ k: b, sMe: x[0], sOt: x[1] }); b.conf.push({ k: a, sMe: x[1], sOt: x[0] }); }
  }
}
function bboxOf(p) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let i = 0; i < p.n; i++) { x0 = Math.min(x0, p.x[i]); x1 = Math.max(x1, p.x[i]); y0 = Math.min(y0, p.y[i]); y1 = Math.max(y1, p.y[i]); } return [x0 - 1, y0 - 1, x1 + 1, y1 + 1]; }
/** 두 경로가 처음 만나는 점의 각 경로 위 거리 (없으면 null) — 끝 1 m 는 빼고 (같은 차로 시작에서 갈라지는 것) */
function crossPolys(a, b) {
  for (let i = 0; i < a.n - 1; i++) {
    const ax = a.x[i], ay = a.y[i], bx = a.x[i + 1], by = a.y[i + 1];
    for (let j = 0; j < b.n - 1; j++) {
      const cx = b.x[j], cy = b.y[j], dx = b.x[j + 1], dy = b.y[j + 1];
      const r = segX(ax, ay, bx, by, cx, cy, dx, dy);
      if (!r) continue;
      const sa = a.S[i] + (a.S[i + 1] - a.S[i]) * r[0], sb = b.S[j] + (b.S[j + 1] - b.S[j]) * r[1];
      if (sa < 1 && sb < 1) continue;
      return [sa, sb];
    }
  }
  return null;
}
function segX(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy, den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den, u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
}

/* ---------- 건물 출입 ---------- */
/** 건물 네 꼭짓점 (반시계) — rot 은 정면(길 쪽 면)의 방향 */
function bldCorners(b) {
  const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0), hw = b.w / 2, hd = b.d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => [b.x + c * u - s * v, b.y + s * u + c * v]);
}
/** 건물 가장 가까운 도로(지상 · 보도 있는 길)를 찾아 출입구를 단다 */
function nearestAccess(net, b) {
  let best = null, bd = Infinity;
  for (const R of net.roads) {
    if (R.cl.fast || !R.cl.sw || R.A.gate || R.B.gate) continue;      // 도시 밖 출입로 위 건물은 그 출입구로만 오갈 수 있다
    if (!R.links.some((L) => L && net.main.has(L))) continue;
    const g = R.g;
    for (let i = 0; i < g.n; i += 2) {
      if (Math.abs(g.z[i]) > 0.3) continue;
      const sc = i * g.step;
      if (sc < R.sa + 14 || sc > R.L - R.sb - 16) continue;
      // 건물 테두리까지 거리 - 도로 반폭 — 길가에서 35 m 안의 길에만 (멀면 진입로가 블록을 가로지른다)
      const hw = R.twoWay ? R.cl.med + R.cl.LW * Math.max(R.n[0], R.n[1]) : (R.n[0] + R.n[1]) * R.cl.LW / 2;
      const d = distRect(g.x[i], g.y[i], b) - hw - R.cl.sw;
      if (d < bd) { bd = d; best = { road: R.id, sc, side: Math.sign(Math.sin(g.h[i]) * (b.x - g.x[i]) - Math.cos(g.h[i]) * (b.y - g.y[i])) || 1 }; }
    }
  }
  return bd < 35 ? best : null;
}
function attachBld(net, B) {
  const b = B.m;
  let acc = b.acc && net.roadById.get(b.acc.road) ? b.acc : null;
  if (acc) { const R = net.roadById.get(acc.road); if (R.cl.fast || R.A.gate || R.B.gate || acc.sc < R.sa + 10 || acc.sc > R.L - R.sb - 12) acc = null; }
  if (!acc) acc = nearestAccess(net, b);
  if (!acc) return;
  const R = net.roadById.get(acc.road);
  // 건물이 오른쪽(+)이면 A→B 구간의 길가 차로, 왼쪽이면 B→A — 일방통행이면 있는 쪽의 가까운 끝 차로
  let L = acc.side > 0 ? R.links[0] : R.links[1], outer = true;
  if (!L || !net.main.has(L)) { L = [R.links[0], R.links[1]].find((q) => q && q !== L && net.main.has(q)); if (!L) return; outer = (acc.side > 0) === (L.d > 0); }
  const t = clamp(L.d > 0 ? acc.sc - R.sa : R.L - R.sb - acc.sc, 10, L.len - 14);
  if (L.len < 30) return;
  const cands = L.lanes.filter((l) => l.type === 'thru' && l.t0 <= t - 1 && l.t1 >= t + 11);
  if (!cands.length) return;
  const lane = outer ? cands[cands.length - 1] : cands[0];
  const sIn = lane.sAtC(t), sOut = lane.sAtC(t + 10);
  const P = lane.at(sIn, {}), Q = lane.at(sOut, {});
  // 문 — 건물 테두리에서 출입 지점에 가장 가까운 점
  const door = doorPoint(b, (P.x + Q.x) / 2, (P.y + Q.y) / 2);
  const mk = (x0, y0, h0, z0, x1, y1, h1, z1, kind) => {
    const ch = Math.hypot(x1 - x0, y1 - y0), k = Math.max(2.5, ch * 0.42);
    const Pc = [[x0, y0], [x0 + Math.cos(h0) * k, y0 + Math.sin(h0) * k], [x1 - Math.cos(h1) * k, y1 - Math.sin(h1) * k], [x1, y1]];
    const m = Math.max(6, Math.ceil(ch / 0.7)), X = [], Y = [], Z = [];
    for (let i = 0; i <= m; i++) { const u = i / m, q = bezPt(Pc, u); X.push(q[0]); Y.push(q[1]); Z.push(z0 + (z1 - z0) * smoothstep(u)); }
    const p = new Path3(X, Y, Z);
    Object.assign(p, { kind, id: -1, bld: B, cars: [], vmax: 4.2 });
    net.drives.push(p);
    return p;
  };
  const zb = 0.15;
  B.din = mk(P.x, P.y, P.h, P.z, door.x, door.y, door.hIn, zb, 'din');
  B.dout = mk(door.x, door.y, door.hIn + Math.PI, zb, Q.x, Q.y, Q.h, Q.z, 'dout');
  B.lane = lane; B.link = L; B.sIn = sIn; B.sOut = sOut; B.door = door; B.acc = acc;
}
/** 직사각형 건물 테두리에서 (px, py) 에 가장 가까운 점과 그 면의 안쪽 방향 */
function doorPoint(b, px, py) {
  const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0), dx = px - b.x, dy = py - b.y;
  let u = c * dx + s * dy, v = -s * dx + c * dy;
  const hw = b.w / 2, hd = b.d / 2;
  let nu = 0, nv = 0;
  if (Math.abs(v) / hd > Math.abs(u) / hw) { nv = Math.sign(v) || 1; v = nv * hd; u = clamp(u, -hw + 3, hw - 3); }
  else { nu = Math.sign(u) || 1; u = nu * hw; v = clamp(v, -hd + 3, hd - 3); }
  const x = b.x + c * u - s * v, y = b.y + s * u + c * v;
  const ox = c * nu - s * nv, oy = s * nu + c * nv;       // 바깥 방향
  return { x, y, hIn: Math.atan2(-oy, -ox), nx: ox, ny: oy };
}
