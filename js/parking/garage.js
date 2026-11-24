/* =============================================================================
   garage.js — 주차장(주차타워 · 지하주차장) 배치와 주행망

   치수 근거 (주차장법 시행규칙 제3조 · 제6조)
     일반형 주차구획 2.5 × 5.0 m, 직각주차 차로 너비 6.0 m,
     직선 경사로 일방통행 너비 3.3 m 이상 · 종단경사 17 % 이하,
     경사로 시작과 끝에는 완화구간을 둔다.

   배치 (평면, x = 가로 · y = 세로)
     서쪽 띠 [0, RW] 는 경사로 칸 — 오르는 경사로 A 와 내려가는 경사로 B 가 나란히 있다.
     층마다 일방통행 순환로: 아래 횡단통로(동쪽으로) → 동쪽 끝 통로(북쪽으로) →
     위 횡단통로(서쪽으로) → 경사로 칸. 경사로 칸 바로 옆 첫 통로는 북쪽으로 흘러
     아래 횡단통로에서 위 횡단통로로 바로 잇는 지름길이고(경사로를 갈아타는 차가 층을 한 바퀴
     돌지 않게), 나머지 통로들은 위에서 아래로(남쪽으로) 흐른다.
     두 경사로 모두 위 횡단통로 끝에서 남쪽으로 들어가, A 는 한 층 위의 · B 는 한 층 아래의
     아래 횡단통로로 나온다. 그래서 한 층을 지나려면 그 층을 한 바퀴 돌아야 한다
     (실제 분리형 경사로 주차장의 동선).
     지상 1층(G) 남동쪽에 입구 · 출구가 나란히 있다. 앞 도로는 서쪽으로 흐르는 차로에서
     우회전으로 들어와 동쪽 끝 통로로 합류하고, 출구는 아래 횡단통로 끝에서 갈라져
     입구보다 하류(서쪽)에서 도로에 합류한다.
     ★ 출구 합류점을 입구 분기점보다 상류에 두면, 도로 위 입차 대기열이 출구를 막고
       출차 대기열이 순환로를 막아 입구가 막히는 고리 정체가 생긴다(실측: 30 분 안에 전부 멈춤).
   ========================================================================== */
'use strict';

const PK = {
  H: 3.2,          // 층고 (바닥~바닥)
  slab: 0.28,      // 슬래브 두께
  stallW: 2.5, stallL: 5.0,
  aisle: 6.0,      // 직각주차 차로 너비
  laneW: 3.3,      // 경사로 일방 차로 너비
  RW: 7.6,         // 경사로 칸 너비 (0.3 벽 + 3.3 + 0.4 분리대 + 3.3 + 0.3 벽)
  xa: 1.95, xb: 5.65,
  r: 4.0,          // 통로 모서리 회전반경 (차로 중심선)
  ys: -16,         // 앞 도로 서행 차로 중심 (건물선 y = 0)
  colW: 0.6,       // 기둥 폭 — 3 면마다 하나
};

/* ---------- 폴리라인 ---------- */
/** 모서리마다 반경 r 의 원호를 넣은 경로를 촘촘히 샘플링한다 */
function filletPath(corners, r, step) {
  step = step || 0.25;
  const X = [], Y = [];
  const push = (x, y) => {
    const n = X.length;
    if (n && Math.hypot(x - X[n - 1], y - Y[n - 1]) < 1e-6) return;
    X.push(x); Y.push(y);
  };
  const line = (x0, y0, x1, y1) => {
    const L = Math.hypot(x1 - x0, y1 - y0), k = Math.max(1, Math.ceil(L / step));
    for (let i = 1; i <= k; i++) push(x0 + (x1 - x0) * i / k, y0 + (y1 - y0) * i / k);
  };
  push(corners[0][0], corners[0][1]);
  let cx = corners[0][0], cy = corners[0][1];
  for (let i = 1; i < corners.length - 1; i++) {
    const [px, py] = corners[i];
    const [nx, ny] = corners[i + 1];
    let d1x = px - cx, d1y = py - cy; const l1 = Math.hypot(d1x, d1y); d1x /= l1; d1y /= l1;
    let d2x = nx - px, d2y = ny - py; const l2 = Math.hypot(d2x, d2y); d2x /= l2; d2y /= l2;
    const cross = d1x * d2y - d1y * d2x, dot = d1x * d2x + d1y * d2y;
    const th = Math.atan2(cross, dot);                   // 회전각 (+ 좌회전)
    if (Math.abs(th) < 1e-4) { line(cx, cy, px, py); cx = px; cy = py; continue; }
    const t = Math.min(r * Math.tan(Math.abs(th) / 2), l1, l2 * 0.999);
    const rr = t / Math.tan(Math.abs(th) / 2);
    const ax = px - d1x * t, ay = py - d1y * t;
    line(cx, cy, ax, ay);
    const sg = th > 0 ? 1 : -1;
    const ox = ax - d1y * rr * sg, oy = ay + d1x * rr * sg;   // 원호 중심 (진행 방향 왼쪽/오른쪽)
    const a0 = Math.atan2(ay - oy, ax - ox);
    const k = Math.max(2, Math.ceil(Math.abs(th) * rr / step));
    for (let j = 1; j <= k; j++) {
      const a = a0 + th * j / k;
      push(ox + rr * Math.cos(a), oy + rr * Math.sin(a));
    }
    cx = px + d2x * t; cy = py + d2y * t;
  }
  const last = corners[corners.length - 1];
  line(cx, cy, last[0], last[1]);
  return { X, Y };
}

/** 촘촘한 점열을 일정 간격으로 다시 뽑고 누적거리 · 방위 · 곡률반경을 붙인다 */
function resample(X, Y, s0, s1, step) {
  const n = X.length, S = new Float64Array(n);
  for (let i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
  if (s0 == null) s0 = 0;
  if (s1 == null) s1 = S[n - 1];
  const L = s1 - s0, m = Math.max(2, Math.round(L / (step || 0.5)) + 1);
  const ox = new Float32Array(m), oy = new Float32Array(m);
  let j = 0;
  for (let i = 0; i < m; i++) {
    const s = s0 + L * i / (m - 1);
    while (j < n - 2 && S[j + 1] < s) j++;
    const t = clamp((s - S[j]) / ((S[j + 1] - S[j]) || 1), 0, 1);
    ox[i] = X[j] + (X[j + 1] - X[j]) * t; oy[i] = Y[j] + (Y[j + 1] - Y[j]) * t;
  }
  return { x: ox, y: oy, len: L };
}
function polyLen(X, Y) { let L = 0; for (let i = 1; i < X.length; i++) L += Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]); return L; }

/** 경사로 종단 — 시작과 끝은 기울기가 선형으로 늘고 주는 완화구간 (u: 0~1 -> 0~1) */
function rampProfile(u, tau) {
  u = clamp(u, 0, 1);
  const m = 1 / (1 - tau);
  if (u < tau) return m * u * u / (2 * tau);
  if (u > 1 - tau) return 1 - m * (1 - u) * (1 - u) / (2 * tau);
  return m * (tau / 2 + (u - tau));
}

/* ---------- 주행망 ---------- */
class PNode {
  constructor(id, x, y, z, level) { this.id = id; this.x = x; this.y = y; this.z = z; this.level = level; this.ins = []; this.outs = []; this.res = null; }
  get merge() { return this.ins.length > 1; }
}

class PEdge {
  constructor(id, kind, level, x, y, zf) {
    this.id = id; this.kind = kind; this.level = level;
    const m = x.length;
    this.n = m; this.x = x; this.y = y;
    this.z = new Float32Array(m); this.h = new Float32Array(m); this.vc = new Float32Array(m);
    let L = 0; for (let i = 1; i < m; i++) L += Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
    this.len = L; this.step = L / (m - 1);
    for (let i = 0; i < m; i++) {
      const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1);
      this.h[i] = Math.atan2(y[b] - y[a], x[b] - x[a]);
      this.z[i] = zf ? zf(x[i], y[i], i / (m - 1)) : 0;
    }
    // 곡률 제한속도 — 1.0 m/s² 남짓의 횡가속도 (주차장 서행)
    for (let i = 0; i < m; i++) {
      const a = Math.max(0, i - 3), b = Math.min(m - 1, i + 3);
      const dh = Math.abs(wrapPi(this.h[b] - this.h[a])), ds = (b - a) * this.step;
      const R = dh > 1e-3 ? ds / dh : 1e9;
      this.vc[i] = Math.min(30, Math.sqrt(1.1 * R));
    }
    this.from = null; this.to = null;
    this.cars = [];          // 이 간선 위를 달리는 차 (앞범퍼 기준)
    this.blk = [];           // 막힌 구간 [{s0, s1, own}] — 주차 · 출차 조작, 차단기
    this.stalls = [];
    this.vmax = 3.0;
    this.gate = null;
  }
  /** s 에서의 점 (보간). 범위를 벗어나면 끝 접선으로 연장한다 */
  at(s, out) {
    out = out || {};
    const m = this.n;
    if (s <= 0 || s >= this.len) {
      const e = s <= 0 ? 0 : m - 1, d = s <= 0 ? s : s - this.len;
      const h = this.h[e];
      out.x = this.x[e] + Math.cos(h) * d; out.y = this.y[e] + Math.sin(h) * d; out.z = this.z[e]; out.h = h;
      return out;
    }
    const f = s / this.step, i = Math.min(m - 2, f | 0), t = f - i;
    out.x = this.x[i] + (this.x[i + 1] - this.x[i]) * t;
    out.y = this.y[i] + (this.y[i + 1] - this.y[i]) * t;
    out.z = this.z[i] + (this.z[i + 1] - this.z[i]) * t;
    out.h = this.h[i] + wrapPi(this.h[i + 1] - this.h[i]) * t;
    return out;
  }
  vcAt(s) { return this.vc[clamp(Math.round(s / this.step), 0, this.n - 1)]; }
  /** 점을 이 간선에 투영 -> {s, d} */
  project(px, py) {
    let best = 1e9, bi = 0;
    for (let i = 0; i < this.n; i++) {
      const d = (this.x[i] - px) ** 2 + (this.y[i] - py) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    return { s: bi * this.step, d: Math.sqrt(best) };
  }
}

/* ---------- 주차장 ---------- */
/**
 * @param cfg {W, D, U(지상 층수), B(지하 층수), seed}
 */
function buildGarage(cfg) {
  const G = { cfg, nodes: [], edges: [], stalls: [], levels: [], columns: [], arrows: [] };
  const H = PK.H, RW = PK.RW, r = PK.r;
  const U = cfg.U | 0, B = cfg.B | 0;
  const NL = Math.max(1, (U > 0 ? U : 1) + B);       // 지상 주차가 없어도 G(지면 광장)는 있다
  const W = Math.max(36, cfg.W), D = Math.max(34, cfg.D);
  G.W = W; G.D = D; G.U = U; G.B = B; G.NL = NL; G.H = H;
  const e = D >= 45 ? PK.stallL : 0;                 // 남 · 북 가장자리 주차열
  const yb = e + 3, yt = D - e - 3;
  const y_rt = yt - r, y_rb = yb + r, Lr = y_rt - y_rb;
  const tau = Math.min(0.18, 3 / Lr);
  G.e = e; G.yb = yb; G.yt = yt; G.y_rt = y_rt; G.y_rb = y_rb; G.Lr = Lr;
  G.grade = H / Lr / (1 - tau);                      // 최대 종단경사
  G.gIdx = B;                                        // 지면층 번호
  for (let i = 0; i < NL; i++) {
    const rel = i - B;
    const name = rel < 0 ? 'B' + (-rel) : (rel + 1) + 'F';
    G.levels.push({ i, z: rel * H, name, park: !(rel === 0 && U === 0), under: rel < 0, roof: i === NL - 1 && rel >= 0 });
  }
  // 통로 배치 (y 방향 통로)
  const A = W - RW;
  const n = Math.max(2, Math.floor((A - 11) / 16) + 1);
  const xi = []; for (let j = 0; j < n; j++) xi.push(RW + 8 + 16 * j);
  const xf = xi[n - 1];
  const rem = A - (16 * (n - 1) + 11);
  const eastRow = rem >= 5.2;
  G.xi = xi; G.xf = xf; G.eastRow = eastRow;
  // 진입로 · 진출로 (G 층 남쪽)
  const xe = xf, xx = xf - 4;
  G.xe = xe; G.xx = xx;
  const gateY = Math.min(-2, yb - r - 1.2);
  G.gateY = gateY;

  let nid = 0, eid = 0;
  const node = (x, y, z, lv) => { const o = new PNode(nid++, x, y, z, lv); G.nodes.push(o); return o; };
  const link = (ed, a, b) => { ed.from = a; ed.to = b; a.outs.push(ed); b.ins.push(ed); };
  const addEdge = (kind, level, X, Y, s0, s1, zf, vmax) => {
    const rs = resample(X, Y, s0, s1, 0.5);
    const ed = new PEdge(eid++, kind, level, rs.x, rs.y, zf);
    ed.vmax = vmax; G.edges.push(ed); return ed;
  };
  const zLv = (i) => G.levels[i].z;

  const hasA = (i) => i < NL - 1;   // 이 층에서 올라가는 경사로
  const hasB = (i) => i > 0;        // 이 층에서 내려가는 경사로
  G.loops = [];
  // 층마다 순환로 노드
  const lvN = [];
  for (let i = 0; i < NL; i++) {
    const L = G.levels[i], z = L.z, isG = i === B;
    /* 아래 횡단통로의 합류점 — 아래층에서 올라온 A (i>0), 위층에서 내려온 B (i<NL-1).
       층이 하나뿐이면 경사로 칸의 평탄 회차로가 A 자리를 쓴다 */
    const merges = [];
    if (i > 0 || NL === 1) merges.push({ x: PK.xa + r, k: 'A' });
    if (i < NL - 1) merges.push({ x: PK.xb + r, k: 'B' });
    if (L.park) for (let j = 1; j < n - 1; j++) merges.push({ x: xi[j] + r, k: 'a' + j });
    merges.sort((p, q) => p.x - q.x);
    const diverges = [];   // 위 횡단통로 (서쪽으로 가며 만나는 순)
    if (L.park) for (let j = n - 2; j >= 1; j--) diverges.push({ x: xi[j] + r, k: 'a' + j });
    if (hasB(i)) diverges.push({ x: PK.xb + r, k: 'B' });
    if (hasA(i) || NL === 1) diverges.push({ x: PK.xa + r, k: 'A' });
    const xs = merges[0].x, xend = diverges[diverges.length - 1].x;
    const path = filletPath([[xs, yb], [xf, yb], [xf, yt], [xend, yt]], r);
    const Ltot = polyLen(path.X, path.Y);
    // 분기 · 합류 위치 (경로 위 거리)
    const marks = [];
    for (const m of merges) if (m.x > xs + 0.01) marks.push({ s: m.x - xs, kind: 'm', k: m.k });
    if (L.park) {            // 북쪽 지름길 통로 (첫 통로)
      marks.push({ s: (xi[0] - r) - xs, kind: 'd', k: 'a0' });
      marks.push({ s: Ltot - ((xi[0] - r) - xend), kind: 'm', k: 'a0' });
    }
    if (isG) {
      marks.push({ s: (xx - r) - xs, kind: 'd', k: 'X' });
      marks.push({ s: (xf - r - xs) + Math.PI / 2 * r, kind: 'm', k: 'E' });
    }
    for (const d of diverges) if (d.x > xend + 0.01) marks.push({ s: Ltot - (d.x - xend), kind: 'd', k: d.k });
    marks.sort((p, q) => p.s - q.s);
    const nStart = node(xs, yb, z, i);
    const nEnd = node(xend, yt, z, i);
    const byKey = { ['m' + merges[0].k]: nStart, ['d' + diverges[diverges.length - 1].k]: nEnd };
    let prevN = nStart, prevS = 0;
    const segs = [];
    for (const mk of marks) {
      const p = resample(path.X, path.Y, mk.s, mk.s, 0.5);
      const nd = node(p.x[0], p.y[0], z, i);
      byKey[mk.kind + mk.k] = nd;
      const ed = addEdge('loop', i, path.X, path.Y, prevS, mk.s, () => z, 3.3);
      link(ed, prevN, nd); segs.push(ed);
      prevN = nd; prevS = mk.s;
    }
    const edLast = addEdge('loop', i, path.X, path.Y, prevS, Ltot, () => z, 3.3);
    link(edLast, prevN, nEnd); segs.push(edLast);
    lvN.push(byKey);
    G.loops.push({ path, segs, xs, xend, Ltot });
  }
  // 통로 (위 -> 아래)
  G.aisles = [];
  for (let i = 0; i < NL; i++) {
    if (!G.levels[i].park) continue;
    const z = zLv(i);
    for (let j = 0; j < n - 1; j++) {
      const p = j === 0
        ? filletPath([[xi[j] - r, yb], [xi[j], yb], [xi[j], yt], [xi[j] - r, yt]], r)
        : filletPath([[xi[j] + r, yt], [xi[j], yt], [xi[j], yb], [xi[j] + r, yb]], r);
      const ed = addEdge('aisle', i, p.X, p.Y, 0, null, () => z, 2.8);
      link(ed, lvN[i]['da' + j], lvN[i]['ma' + j]);
      if (j === 0) ed.north = true;
      G.aisles.push(ed);
    }
  }
  // 경사로
  G.ramps = [];
  for (let i = 0; i < NL; i++) {
    const z0 = zLv(i);
    if (hasA(i)) {
      const p = filletPath([[PK.xa + r, yt], [PK.xa, yt], [PK.xa, yb], [PK.xa + r, yb]], r);
      const ed = addEdge('rampA', i, p.X, p.Y, 0, null, (x, y) => z0 + H * rampProfile((y_rt - y) / Lr, tau), 3.0);
      link(ed, lvN[i].dA, lvN[i + 1].mA);
      ed.up = true; G.ramps.push(ed);
    }
    if (hasB(i)) {
      const p = filletPath([[PK.xb + r, yt], [PK.xb, yt], [PK.xb, yb], [PK.xb + r, yb]], r);
      const ed = addEdge('rampB', i, p.X, p.Y, 0, null, (x, y) => z0 - H * rampProfile((y_rt - y) / Lr, tau), 3.0);
      link(ed, lvN[i].dB, lvN[i - 1].mB);
      ed.up = false; G.ramps.push(ed);
    }
  }
  if (NL === 1) {      // 단층 — 경사로 칸을 평탄한 회차로로 쓴다
    const p = filletPath([[PK.xa + r, yt], [PK.xa, yt], [PK.xa, yb], [PK.xa + r, yb]], r);
    const ed = addEdge('loop', 0, p.X, p.Y, 0, null, () => 0, 3.0);
    link(ed, lvN[0].dA, lvN[0].mA);
    ed.flatReturn = true;
  }
  // 도로 (서행 차로) · 진입로 · 진출로
  const ys = PK.ys, gi = B;
  const xR = W + 140, xL = -140;
  const nS0 = node(xR, ys, 0, -1), nSe = node(xe + r, ys, 0, -1), nSx = node(xx - r, ys, 0, -1), nS1 = node(xL, ys, 0, -1);
  const st = (xa_, xb_) => { const p = filletPath([[xa_, ys], [xb_, ys]], r, 1); return p; };
  let p = st(xR, xe + r);
  const sA = addEdge('street', -1, p.X, p.Y, 0, null, () => 0, 12.5); link(sA, nS0, nSe);
  p = st(xe + r, xx - r);
  const sB = addEdge('street', -1, p.X, p.Y, 0, null, () => 0, 11); link(sB, nSe, nSx);
  p = st(xx - r, xL);
  const sC = addEdge('street', -1, p.X, p.Y, 0, null, () => 0, 12.5); link(sC, nSx, nS1);
  G.street = [sA, sB, sC];
  G.streetIn = sA; G.streetOut = sC;
  p = filletPath([[xe + r, ys], [xe, ys], [xe, yb + r]], r);
  const ent = addEdge('entry', gi, p.X, p.Y, 0, null, () => 0, 3.0); link(ent, nSe, lvN[gi].mE);
  p = filletPath([[xx - r, yb], [xx, yb], [xx, ys], [xx - r, ys]], r);
  const ext = addEdge('exit', gi, p.X, p.Y, 0, null, () => 0, 3.0); link(ext, lvN[gi].dX, nSx);
  ent.gate = { s: ent.project(xe, gateY).s, kind: 'in', busy: null, t: 0, open: null, lift: 0 };
  ext.gate = { s: ext.project(xx, gateY).s, kind: 'out', busy: null, t: 0, open: null, lift: 0 };
  G.entry = ent; G.exit = ext;
  // 반대 차로 (통과 교통만, 주차장과 무관)
  p = filletPath([[xL, ys - 3.3], [xR, ys - 3.3]], r, 1);
  const eb = addEdge('street', -1, p.X, p.Y, 0, null, () => 0, 12.5);
  const nE0 = node(xL, ys - 3.3, 0, -1), nE1 = node(xR, ys - 3.3, 0, -1); link(eb, nE0, nE1);
  G.streetEB = eb;
  G.sinks = new Set([nS1.id, nE1.id]);

  placeStalls(G);
  for (const ed of G.edges) ed.stalls.sort((a, b) => a.s - b.s);
  G.parkEdges = G.edges.filter((ed) => ed.stalls.length);
  // 통로 진행방향 화살표
  for (const ed of G.edges) {
    if (ed.kind !== 'aisle' && ed.kind !== 'loop') continue;
    for (let s = 6; s < ed.len - 4; s += 14) {
      const q = ed.at(s);
      const k = clamp(Math.round(s / ed.step), 0, ed.n - 1);
      if (ed.vc[k] < 2.5) continue;              // 모서리 원호에는 그리지 않는다
      G.arrows.push({ x: q.x, y: q.y, z: q.z, h: q.h, level: ed.level });
    }
  }
  return G;
}

/** 주차면 · 기둥 */
function placeStalls(G) {
  const { W, D, NL, xi, xf, e, yb, yt } = G;
  const r = PK.r, sw = PK.stallW;
  let sid = 0;
  /** [a, b] 구간에 3 면마다 기둥을 끼워 넣은 면 중심 목록과 기둥 위치 */
  const run = (a, b) => {
    const cs = [], cols = [a];
    let x = a, k = 0;
    while (x + sw <= b + 1e-6) {
      cs.push(x + sw / 2); x += sw; k++;
      if (k % 3 === 0 && x + PK.colW + sw <= b) { cols.push(x + PK.colW / 2); x += PK.colW; }
    }
    cols.push(Math.min(b, x));
    return { cs, cols };
  };
  const mk = (level, cx, cy, nx, ny) => {
    const z = G.levels[level].z;
    const ox = cx - nx * (PK.stallL / 2 + PK.aisle / 2), oy = cy - ny * (PK.stallL / 2 + PK.aisle / 2);
    // 접하는 통로 간선 찾기
    let best = null, bd = 0.45;
    for (const ed of G.edges) {
      if (ed.level !== level || (ed.kind !== 'loop' && ed.kind !== 'aisle') || ed.flatReturn) continue;
      const pr = ed.project(ox, oy);
      if (pr.d < bd) { bd = pr.d; best = { ed, s: pr.s }; }
    }
    if (!best) return;
    const ed = best.ed;
    // 원호 위의 면은 버린다 (돌면서 들어갈 수 없다)
    const k0 = clamp(Math.round((best.s - 4) / ed.step), 0, ed.n - 1), k1 = clamp(Math.round((best.s + 4) / ed.step), 0, ed.n - 1);
    if (Math.abs(wrapPi(ed.h[k1] - ed.h[k0])) > 0.05) return;
    if (best.s < 3.5 || best.s > ed.len - 3.5) {
      // 간선 끝에 걸치면 조작 구간이 노드를 넘는다 — 노드에서 3.5 m 안은 두지 않는다
      return;
    }
    const h = ed.at(best.s).h;
    const ax = Math.cos(h), ay = Math.sin(h);
    const side = ax * ny - ay * nx > 0 ? 1 : -1;   // +1: 진행방향 왼쪽
    const st = { id: sid++, level, cx, cy, z, nx, ny, ox, oy, ax, ay, side, ed, s: best.s, state: 'free', car: null, hdg: Math.atan2(ny, nx) };
    ed.stalls.push(st); G.stalls.push(st);
  };
  const y0s = yb + 3 + 1.0, y1s = yt - 3 - 1.0;
  for (let i = 0; i < NL; i++) {
    const L = G.levels[i];
    if (!L.park) continue;
    const isG = i === G.gIdx;
    const z = L.z;
    // y 방향 통로 양옆
    const ry = run(y0s, y1s);
    for (let j = 0; j < xi.length; j++) {
      const x = xi[j];
      for (const cy of ry.cs) {
        mk(i, x - 5.5, cy, -1, 0);                                  // 서쪽 열 (통로에서 서쪽으로 들어간다)
        if (j < xi.length - 1 || G.eastRow) mk(i, x + 5.5, cy, 1, 0);
      }
      // 기둥 — 등을 맞댄 두 열 사이 · 서쪽 벽
      const bx = x - 8;
      for (const cy of ry.cols) G.columns.push({ x: bx, y: cy, level: i });
    }
    for (const cy of ry.cols) G.columns.push({ x: G.eastRow ? xf + 8 : Math.min(W - 0.3, xf + 3.3), y: cy, level: i });
    // 남 · 북 가장자리 열
    if (e > 0) {
      const loop = G.loops[i];
      const rx = run(PK.RW + 0.3, xf + 3);
      for (const cx of rx.cs) {
        if (cx > xf - r - 1.3) continue;
        if (cx >= loop.xs + 1.6) {
          let ok = true;
          if (isG && cx > G.xx - r - 1.4) ok = false;
          if (ok) mk(i, cx, e / 2, 0, -1);
        }
        if (cx >= loop.xend + 1.6) mk(i, cx, D - e / 2, 0, 1);
      }
      for (const cx of rx.cols) {
        if (!(isG && (Math.abs(cx - G.xe) < 3 || Math.abs(cx - G.xx) < 3))) G.columns.push({ x: cx, y: 0.3, level: i });
        G.columns.push({ x: cx, y: D - 0.3, level: i });
      }
    }
  }
}

/** 최단경로 (간선 길이 + 경사로 가중) — from 노드에서 목표 간선까지 간선 목록 */
function routeTo(G, fromNode, goalEdge, forbidExit) {
  const N = G.nodes.length;
  const dist = new Float64Array(N).fill(Infinity), prev = new Array(N).fill(null);
  dist[fromNode.id] = 0;
  const open = [fromNode];
  const done = new Uint8Array(N);
  while (open.length) {
    let bi = 0; for (let i = 1; i < open.length; i++) if (dist[open[i].id] < dist[open[bi].id]) bi = i;
    const u = open[bi]; open[bi] = open[open.length - 1]; open.pop();
    if (done[u.id]) continue; done[u.id] = 1;
    for (const ed of u.outs) {
      if (ed === goalEdge) {
        const path = [ed]; let k = u;
        while (prev[k.id]) { path.push(prev[k.id]); k = prev[k.id].from; }
        return path.reverse();
      }
      if (forbidExit && (ed.kind === 'exit')) continue;
      if (ed.kind === 'street') continue;
      const w = ed.len + (ed.kind === 'rampA' || ed.kind === 'rampB' ? 8 : 0);
      const v = ed.to;
      if (dist[u.id] + w < dist[v.id]) { dist[v.id] = dist[u.id] + w; prev[v.id] = ed; open.push(v); }
    }
  }
  return null;
}
