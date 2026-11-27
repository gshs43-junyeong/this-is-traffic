/* =============================================================================
   cscene.js — 도시 교통 3D 렌더 (자유 도로망: 곡선 도로 · 고가 · 지하차도 · 고속도로 · 건물 출입)

   주차장 렌더(pscene.js)와 같은 방식: 도로 · 노면표시 · 교차로 · 건물 · 다리 · 신호등 기둥처럼 안 바뀌는 것은
   세계 좌표 정점을 GPU 에 한 번 올려 두고, 달리는 차 · 켜진 신호 알은 프레임마다 세계 좌표 버퍼 하나로 그린다.
   반투명 덧칠(그림자 · 지하차도 덮개 · 소통 지도 · 고른 것)만 render.js 의 길(Render.fill)을 탄다.
   차 모양 · 면 밝기 · 정적 메쉬(carMesh · faceLit · MeshB · NX)는 pscene.js 의 것을 쓴다.

   ★ 지하차도 위 땅은 칸(8 m)으로 깔고 지하 구간이 지나는 칸만 비운다 — 큰 판 하나로 덮으면 땅이 지하차도를 가린다.
   ★ 교차로 바닥은 다리마다 물러선 자리의 가장자리 점을 잇고, 이웃한 두 다리 사이는 연석 곡선(두 가장자리 선의
     교점을 조절점으로 한 2 차 곡선)으로 둥글린다 — 가운데에서 부채꼴로 채운다.
   ========================================================================== */
'use strict';

const CCOL = {
  grass: '#6b7c4b', field: '#7d8a55', walk: '#b5b2a9', curb: '#c9c6bd', asphalt: '#3c3e42', asphaltH: '#46484c', yellow: '#e2b93b', white: '#e9e8e1',
  pole: '#5b6067', head: '#202328', lampOff: '#2c2f34', park: '#5d8848', tree: '#3d6a34', tree2: '#4b7a3a', trunk: '#5a4632',
  drive: '#5a5c60', roof: '#8e9194', deck: '#a7a7a0', pier: '#b3b2aa', wall: '#a9a69c', barrier: '#c7c6bf', pad: '#a9a69c',
};
const CBLD = ['#c9c2b3', '#a9b1b8', '#d6d0c4', '#8f99a3', '#b7a58f', '#9fa89a', '#c4b9a8', '#7f8b95', '#d9d4cb', '#a39a8c', '#b9b0a2', '#9aa6ae'];
const CGLASS = ['#6f8aa0', '#5f7890', '#7c94a6', '#58707f'];
const LOS_COL = { A: '#2fbf71', B: '#8fd14f', C: '#e8d33f', D: '#f0a03a', E: '#e8663a', F: '#d23a3a' };

/** 오른쪽으로 off 만큼 */
function offPt(o, off, dz) { return [o.x + Math.sin(o.h) * off, o.y - Math.cos(o.h) * off, o.z + (dz || 0)]; }
/** t0..t1 을 step 간격으로 (끝 포함) */
function tRange(t0, t1, step) { const out = []; const n = Math.max(1, Math.ceil((t1 - t0) / step)); for (let i = 0; i <= n; i++) out.push(t0 + (t1 - t0) * i / n); return out; }

const CScene = {
  init(net, sim, night, seed) {
    this.net = net; this.sim = sim; PNIGHT = !!night; this.seed = seed | 0;
    this.buildStatic();
    this.uploaded = false;
    if (!this.dP) { this.dP = new Float32Array(3 * 120000); this.dC = new Uint8Array(4 * 120000); }
    this.dn = 0;
  },
  initGL(gl) { PScene.initGL.call(this, gl); },

  /* ---------- 고정 메쉬 ---------- */
  buildStatic() {
    const net = this.net, M = new MeshB(), rng = new RNG('cityart:' + this.seed);
    this.lamps = []; this.heads = []; this.lids = []; this.signs = [];
    this.ground(M);
    for (const L of net.links) this.linkSurface(M, L, rng);
    for (const R of net.roads) this.roadStructure(M, R);
    for (const N of net.nodes) this.nodeSurface(M, N);
    for (const N of net.nodes) if (N.gores) for (const g of N.gores) this.gore(M, g);
    for (const L of net.links) this.markings(M, L);
    for (const N of net.nodes) if (N.ctl === 'signal') for (const L of N.inLinks) this.signalMast(M, L);
    for (const N of net.nodes) if (N.ctl === 'stop') for (const L of N.inLinks) if (N.conns.some((c) => c.from.link === L && c.minor)) this.stopSign(M, L);
    for (const B of net.blds) this.building(M, rng, B);
    M.done();
    this.mesh = M;
  },
  /** 지도 범위 */
  bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const N of this.net.nodes) { x0 = Math.min(x0, N.x); y0 = Math.min(y0, N.y); x1 = Math.max(x1, N.x); y1 = Math.max(y1, N.y); }
    for (const R of this.net.roads) for (const P of R.g.P) { x0 = Math.min(x0, P[0]); y0 = Math.min(y0, P[1]); x1 = Math.max(x1, P[0]); y1 = Math.max(y1, P[1]); }
    if (!isFinite(x0)) { x0 = y0 = -200; x1 = y1 = 200; }
    return { x0, y0, x1, y1 };
  },
  /** 땅 — 지도 둘레 칸 깔기 (지하 구간이 지나는 칸은 비운다) + 먼 들판 */
  ground(M) {
    const b = this.bounds(), m = 220, cs = 8;
    const gx0 = Math.floor((b.x0 - m) / cs) * cs, gy0 = Math.floor((b.y0 - m) / cs) * cs, gx1 = Math.ceil((b.x1 + m) / cs) * cs, gy1 = Math.ceil((b.y1 + m) / cs) * cs;
    const nx = (gx1 - gx0) / cs, ny = (gy1 - gy0) / cs, cut = new Uint8Array(nx * ny);
    const o = {};
    for (const L of this.net.links) {
      for (let t = 0; t <= L.len; t += 2) {
        L.center(t, o);
        if (o.z > -0.25) continue;
        const r = Math.max(Math.abs(L.base) + 3, L.outer(t) + 3), cx = Math.floor((o.x - gx0) / cs), cy = Math.floor((o.y - gy0) / cs), k = Math.ceil(r / cs);
        for (let i = cx - k; i <= cx + k; i++) for (let j = cy - k; j <= cy + k; j++) {
          if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
          const px = gx0 + (i + 0.5) * cs, py = gy0 + (j + 0.5) * cs;
          if (Math.hypot(px - o.x, py - o.y) < r + cs * 0.5) cut[j * nx + i] = 1;
        }
      }
    }
    const g = NX(CCOL.grass), z = -0.06;
    for (let j = 0; j < ny; j++) {
      let i = 0;
      while (i < nx) {
        if (cut[j * nx + i]) { i++; continue; }
        let k = i; while (k < nx && !cut[j * nx + k]) k++;
        const xa = gx0 + i * cs, xb = gx0 + k * cs, ya = gy0 + j * cs, yb = ya + cs;
        M.quad([xa, ya, z], [xb, ya, z], [xb, yb, z], [xa, yb, z], g);
        i = k;
      }
    }
    // 먼 들판 — 칸 깔기 둘레의 네 판
    const f = NX(CCOL.field), F = 4000, zf = -0.08;
    M.quad([gx0 - F, gy0 - F, zf], [gx1 + F, gy0 - F, zf], [gx1 + F, gy0, zf], [gx0 - F, gy0, zf], f);
    M.quad([gx0 - F, gy1, zf], [gx1 + F, gy1, zf], [gx1 + F, gy1 + F, zf], [gx0 - F, gy1 + F, zf], f);
    M.quad([gx0 - F, gy0, zf], [gx0, gy0, zf], [gx0, gy1, zf], [gx0 - F, gy1, zf], f);
    M.quad([gx1, gy0, zf], [gx1 + F, gy0, zf], [gx1 + F, gy1, zf], [gx1, gy1, zf], f);
  },
  /** 구간 하나의 노면 · 보도 (구간 방향 오른쪽 몫, 일방통행이면 양쪽) */
  linkSurface(M, L, rng) {
    const R = L.road, cl = R.cl, sh = cl.sh;
    const ext0 = L.from.gate ? -70 : 0, ext1 = L.to.gate ? L.len + 70 : L.len;
    const inner = R.twoWay ? () => 0 : () => L.base - sh;
    const outer = (t) => L.outer(clamp(t, 0, L.len)) + sh;
    const asph = NX(cl.fast ? CCOL.asphaltH : CCOL.asphalt);
    const ts = tRange(ext0, ext1, 2), A = {}, B = {};
    for (let i = 0; i + 1 < ts.length; i++) {
      L.center(ts[i], A); L.center(ts[i + 1], B);
      M.quad(offPt(A, inner(ts[i])), offPt(B, inner(ts[i + 1])), offPt(B, outer(ts[i + 1])), offPt(A, outer(ts[i])), asph);
    }
    // 보도 — 지상 · 고가 위 (지하 구간은 없다)
    if (!cl.sw) return;
    const walk = shade(CCOL.walk, faceLit(0, 0, 1, 0)), curb = shade(CCOL.curb, faceLit(0, 0, 1, 0) * 0.85);
    const sides = R.twoWay ? [1] : [1, -1];
    for (const sd of sides) {
      for (let i = 0; i + 1 < ts.length; i++) {
        L.center(ts[i], A); L.center(ts[i + 1], B);
        if (A.z < -0.25 || B.z < -0.25) continue;
        const a0 = sd > 0 ? outer(ts[i]) : inner(ts[i]), b0 = sd > 0 ? outer(ts[i + 1]) : inner(ts[i + 1]);
        const a1 = a0 + sd * cl.sw, b1 = b0 + sd * cl.sw;
        M.quad(offPt(A, a0, 0.15), offPt(B, b0, 0.15), offPt(B, b1, 0.15), offPt(A, a1, 0.15), walk);
        M.quad(offPt(A, a0, 0), offPt(B, b0, 0), offPt(B, b0, 0.15), offPt(A, a0, 0.15), curb);
        if (A.z < 0.25) M.quad(offPt(A, a1, -0.06), offPt(B, b1, -0.06), offPt(B, b1, 0.15), offPt(A, a1, 0.15), curb);
      }
      // 가로수 · 가로등 — 지상 길가 보도에 (건물 진입로 · 교차로 앞은 피한다)
      if (R.cls === 'local' && L.len < 60) continue;
      let k = rng.int(0, 1);
      for (let t = 12; t < L.len - 12; t += 17) {
        L.center(t, A);
        if (Math.abs(A.z) > 0.2) continue;
        if (this.net.blds.some((Bd) => Bd.link === L && Math.abs(Bd.lane.cAt(Bd.sIn) + 5 - t) < 9)) continue;
        const off = (sd > 0 ? outer(t) : inner(t)) + sd * cl.sw * 0.42, p = offPt(A, off, 0.15);
        if ((k++ & 1) === 0) this.tree(M, rng, p[0], p[1], 0.15, 0.85);
        else {
          M.box(p[0] - 0.1, p[1] - 0.1, 0.15, p[0] + 0.1, p[1] + 0.1, 8, CCOL.pole, 0, true);
          const q = offPt(A, off - sd * 1.6, 0);
          M.box(Math.min(p[0], q[0]) - 0.08, Math.min(p[1], q[1]) - 0.08, 7.85, Math.max(p[0], q[0]) + 0.08, Math.max(p[1], q[1]) + 0.08, 8.02, CCOL.pole, 0, false);
          this.lamps.push([q[0], q[1], 7.8]);
        }
      }
    }
  },
  /** 고가 상판 · 교각 · 난간 / 진입 둑 옹벽 / 지하 옹벽 · 덮개 · 고속도로 중앙 분리대 */
  roadStructure(M, R) {
    const cl = R.cl, g = R.g, wall = CCOL.wall;
    // 도로 단면의 왼쪽 · 오른쪽 끝 (도로 중심선 기준, A→B 방향 오른쪽이 +)
    const edge = (sc) => {
      const L0 = R.links[0], L1 = R.links[1], ex = cl.sh + cl.sw;
      const tA = clamp(sc - R.sa, 0, L0 ? L0.len : 0), tB = clamp(R.L - R.sb - sc, 0, L1 ? L1.len : 0);
      if (R.twoWay) return [-(L1.outer(tB) + ex), L0.outer(tA) + ex];
      const L = L0 || L1, t = L0 ? tA : tB, a = L.base - ex, b = L.outer(t) + ex;
      return L0 ? [a, b] : [-b, -a];
    };
    const step = 2, n = Math.ceil(R.L / step), o = {}, q = {};
    const pt = (s, off, z) => { shapeAt(g, s, o); return [o.x + Math.sin(o.h) * off, o.y - Math.cos(o.h) * off, z == null ? o.z : z]; };
    let lastPier = -1e9, lid = null;
    const noBar = (side, sc) => (R.noBar || []).some((q) => q.side === side && sc >= q.a && sc <= q.b);
    for (let i = 0; i < n; i++) {
      const sa = i * step, sb = Math.min(R.L, sa + step);
      shapeAt(g, sa, o); shapeAt(g, sb, q);
      const za = o.z, zb = q.z, [la, ra] = edge(sa), [lb, rb] = edge(sb);
      if (za > 0.3 || zb > 0.3) {
        if (Math.min(za, zb) < 2.6) {          // 진입 둑 — 옹벽 바깥면
          for (const [ea, eb] of [[la, lb], [ra, rb]]) M.quad(pt(sa, ea, 0), pt(sb, eb, 0), pt(sb, eb, zb), pt(sa, ea, za), shade(wall, faceLit(Math.sin(o.h) * Math.sign(ea), -Math.cos(o.h) * Math.sign(ea), 0, 0)));
        } else {                               // 상판 — 밑면 · 옆면(두께 1.2 m)
          const sd = shade(CCOL.deck, 0.62);
          M.quad(pt(sa, la, za - 1.2), pt(sb, lb, zb - 1.2), pt(sb, rb, zb - 1.2), pt(sa, ra, za - 1.2), sd);
          for (const [ea, eb] of [[la, lb], [ra, rb]]) M.quad(pt(sa, ea, za - 1.2), pt(sb, eb, zb - 1.2), pt(sb, eb, zb), pt(sa, ea, za), shade(CCOL.deck, faceLit(Math.sin(o.h) * Math.sign(ea), -Math.cos(o.h) * Math.sign(ea), 0, 0)));
          if (sa - lastPier > 32 && sa > 8 && sa < R.L - 8 && Math.min(za, zb) > 3) {
            lastPier = sa;
            const w = ra - la, cols = w > 22 ? [la + w * 0.25, la + w * 0.75] : [(la + ra) / 2];
            for (const c of cols) { const p = pt(sa, c, 0); M.box(p[0] - 0.75, p[1] - 0.75, -0.06, p[0] + 0.75, p[1] + 0.75, za - 1.2, CCOL.pier, 0, true); }
            // 기둥머리 보
            const p1 = pt(sa, la + 0.5, za - 1.2), p2 = pt(sa, ra - 0.5, za - 1.2);
            this.beam(M, p1, p2, 0.7, 1.0, CCOL.pier);
          }
        }
        // 난간 — 상판 · 둑 위 바깥 끝
        if (Math.min(za, zb) > 1.0) for (const [ea, eb, s] of [[la, lb, 1], [ra, rb, -1]]) {
          if (noBar(-s, sa)) continue;
          const ia = ea + s * 0.45, ib = eb + s * 0.45;
          M.quad(pt(sa, ea, za), pt(sb, eb, zb), pt(sb, eb, zb + 1.05), pt(sa, ea, za + 1.05), shade(CCOL.barrier, 0.9));
          M.quad(pt(sa, ia, za), pt(sb, ib, zb), pt(sb, ib, zb + 1.05), pt(sa, ia, za + 1.05), shade(CCOL.barrier, 1.0));
          M.quad(pt(sa, ea, za + 1.05), pt(sb, eb, zb + 1.05), pt(sb, ib, zb + 1.05), pt(sa, ia, za + 1.05), shade(CCOL.barrier, 1.08));
        }
      }
      if (za < -0.25 || zb < -0.25) {          // 지하 — 양쪽 옹벽(땅 위 0.6 m 까지)
        for (const [ea, eb, s] of [[la, lb, 1], [ra, rb, -1]]) {
          M.quad(pt(sa, ea, za), pt(sb, eb, zb), pt(sb, eb, 0.6), pt(sa, ea, 0.6), shade(wall, 0.8));
          M.quad(pt(sa, ea, 0.6), pt(sb, eb, 0.6), pt(sb, eb - s * 0.4, 0.6), pt(sa, ea - s * 0.4, 0.6), shade(wall, 1.05));
        }
        // 덮인 구간 — 반투명 덮개(그릴 때마다) · 입구 문틀
        const cov = za < -5.2 && zb < -5.2;
        // 땅 칸을 비운 둘레 — 옹벽 바깥으로 9 m 땅을 덧대어 칸의 들쭉날쭉한 틈(하늘이 비친다)을 메운다
        for (const [ea, eb, s] of [[la, lb, -1], [ra, rb, 1]]) M.quad(pt(sa, ea, -0.05), pt(sb, eb, -0.05), pt(sb, eb + s * 9, -0.05), pt(sa, ea + s * 9, -0.05), NX(CCOL.grass));
        if (cov) {
          if (!lid) { lid = []; this.lids.push(lid); const a = pt(sa, la, 0.6), b = pt(sa, ra, 0.6); this.beam(M, [a[0], a[1], -0.4], [b[0], b[1], -0.4], 1.0, 1.0, wall); }
          lid.push([pt(sa, la, 0.62), pt(sb, lb, 0.62), pt(sb, rb, 0.62), pt(sa, ra, 0.62)]);
        } else if (lid) { const a = pt(sa, la, 0.6), b = pt(sa, ra, 0.6); this.beam(M, [a[0], a[1], -0.4], [b[0], b[1], -0.4], 1.0, 1.0, wall); lid = null; }
      } else lid = null;
      // 고속도로 중앙 분리대 (콘크리트 방호벽)
      if (cl.fast && R.twoWay) {
        M.quad(pt(sa, -0.3, za), pt(sb, -0.3, zb), pt(sb, -0.3, zb + 0.85), pt(sa, -0.3, za + 0.85), shade(CCOL.barrier, 0.92));
        M.quad(pt(sa, 0.3, za), pt(sb, 0.3, zb), pt(sb, 0.3, zb + 0.85), pt(sa, 0.3, za + 0.85), shade(CCOL.barrier, 0.98));
        M.quad(pt(sa, -0.3, za + 0.85), pt(sb, -0.3, zb + 0.85), pt(sb, 0.3, zb + 0.85), pt(sa, 0.3, za + 0.85), shade(CCOL.barrier, 1.06));
        if (i % 30 === 15) { const p = pt(sa, 0, za + 0.85); M.box(p[0] - 0.1, p[1] - 0.1, p[2], p[0] + 0.1, p[1] + 0.1, p[2] + 9, CCOL.pole, 0, true); for (const s of [-1, 1]) { const c = pt(sa, s * 2.2, za + 9.6); this.lamps.push(c); this.beam(M, [p[0], p[1], p[2] + 9], [c[0], c[1], c[2] - 0.6], 0.16, 0.16, CCOL.pole); } }
      } else if (cl.fast && za > -0.25 && za < 0.3) {     // 지상 고속 · 램프 바깥 방호벽
        for (const [ea, eb, s] of [[la, lb, -1], [ra, rb, 1]]) if (!noBar(s, sa)) M.quad(pt(sa, ea, za), pt(sb, eb, zb), pt(sb, eb, zb + 0.8), pt(sa, ea, za + 0.8), shade(CCOL.barrier, 0.95));
      }
    }
  },
  /** 두 점 사이 네모난 보 (가로 w · 높이 h) */
  beam(M, a, b, w, h, col) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L * w / 2, ny = dx / L * w / 2;
    const P = (p, s, z) => [p[0] + nx * s, p[1] + ny * s, p[2] + z];
    const t = shade(col, 1.05), s1 = shade(col, 0.88), s2 = shade(col, 0.76);
    M.quad(P(a, -1, 0), P(b, -1, 0), P(b, 1, 0), P(a, 1, 0), shade(col, 0.6));
    M.quad(P(a, -1, h), P(b, -1, h), P(b, 1, h), P(a, 1, h), t);
    M.quad(P(a, -1, 0), P(b, -1, 0), P(b, -1, h), P(a, -1, h), s1);
    M.quad(P(a, 1, 0), P(b, 1, 0), P(b, 1, h), P(a, 1, h), s2);
    M.quad(P(a, -1, 0), P(a, 1, 0), P(a, 1, h), P(a, -1, h), s1);
    M.quad(P(b, -1, 0), P(b, 1, 0), P(b, 1, h), P(b, -1, h), s1);
  },
  /** 다리 끝의 가장자리 — 노드에서 바깥으로 본 오른쪽(나가는 차로) · 왼쪽(들어오는 차로) 점과 방향 */
  legEnds(l) {
    const R = l.road, sb = R.A === l.node && l.end === 'a' ? R.sa : R.sb;
    const sc = l.end === 'a' ? sb : R.L - sb, o = shapeAt(R.g, sc, {});
    const u = l.end === 'a' ? o.h : o.h + Math.PI, rx = Math.sin(u), ry = -Math.cos(u);
    const sh = R.cl.sh;
    let wR, wL;
    if (R.twoWay) { wR = l.outLink.outer(0) + sh; wL = l.inLink.outer(l.inLink.len) + sh; }
    else {
      const Lk = l.outLink || l.inLink, t = l.outLink ? 0 : Lk.len, a = -(Lk.base - sh), b = Lk.outer(t) + sh;
      if (l.outLink) { wR = b; wL = a; } else { wR = a; wL = b; }
    }
    return { o, u, rx, ry, R: [o.x + rx * wR, o.y + ry * wR], L: [o.x - rx * wL, o.y - ry * wL], wR, wL, z: o.z, sw: R.cl.sw };
  },
  /** 교차로 바닥 · 모퉁이 보도 */
  nodeSurface(M, N) {
    if (N.ctl === 'end') return this.culDeSac(M, N);
    if (N.legs.length < 2) return;
    let legs = N.legs;
    if (N.ctl === 'merge' && legs.some((l) => l.attach)) {
      // 램프는 본선 옆에 나란히 붙는다 — 노드 바닥은 본선끼리, 램프는 끝을 노드 쪽으로 조금 늘린 조각으로 잇는다
      for (const l of legs) if (l.attach) {
        const e = this.legEnds(l), bx = -Math.cos(e.u) * 4.6, by = -Math.sin(e.u) * 4.6, z = N.z + 0.004;
        M.quad([e.R[0], e.R[1], z], [e.L[0], e.L[1], z], [e.L[0] + bx, e.L[1] + by, z], [e.R[0] + bx, e.R[1] + by, z], NX(CCOL.asphaltH));
      }
      legs = legs.filter((l) => !l.attach);
      if (legs.length < 2) return;
    }
    const k = legs.length, E = legs.map((l) => this.legEnds(l)), z = N.z + 0.004;
    const poly = [];
    const lineX = (p, d, q, e) => { const den = d[0] * e[1] - d[1] * e[0]; if (Math.abs(den) < 1e-6) return null; const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den; return [p[0] + d[0] * t, p[1] + d[1] * t, t]; };
    const corner = [];
    for (let i = 0; i < k; i++) {
      const a = E[i], b = E[(i + 1) % k];
      let gap = legs[(i + 1) % k].ang - legs[i].ang; if (gap <= 0) gap += TAU;
      poly.push(a.R, a.L);
      // 연석 곡선 — 다리 i 의 왼쪽 가장자리와 다리 i+1 의 오른쪽 가장자리
      const X = gap < 2.75 ? lineX(a.L, [Math.cos(a.u), Math.sin(a.u)], b.R, [Math.cos(b.u), Math.sin(b.u)]) : null;
      const arc = [];
      if (X && X[2] < 0.5) { for (let j = 1; j < 10; j++) { const s = j / 10, w0 = (1 - s) * (1 - s), w1 = 2 * s * (1 - s), w2 = s * s; arc.push([w0 * a.L[0] + w1 * X[0] + w2 * b.R[0], w0 * a.L[1] + w1 * X[1] + w2 * b.R[1]]); } }
      poly.push(...arc);
      corner.push({ a, b, X: X && X[2] < 0.5 ? X : null });
    }
    const col = NX(CCOL.asphalt);
    for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; M.tri([N.x, N.y, z], [p[0], p[1], z], [q[0], q[1], z], col); }
    // 모퉁이 보도 — 지상 교차로에서 두 다리 다 보도가 있으면
    if (Math.abs(N.z) > 0.3) return;
    const walk = shade(CCOL.walk, faceLit(0, 0, 1, 0)), curb = shade(CCOL.curb, faceLit(0, 0, 1, 0) * 0.85);
    for (const c of corner) {
      const { a, b } = c;
      if (!a.sw || !b.sw) continue;
      const sw = Math.min(a.sw, b.sw);
      const ao = [a.L[0] - a.rx * sw, a.L[1] - a.ry * sw], bo = [b.R[0] + b.rx * sw, b.R[1] + b.ry * sw];
      const Xo = c.X ? lineX(ao, [Math.cos(a.u), Math.sin(a.u)], bo, [Math.cos(b.u), Math.sin(b.u)]) : null;
      const inn = [], out = [];
      for (let j = 0; j <= 10; j++) {
        const s = j / 10, w0 = (1 - s) * (1 - s), w1 = 2 * s * (1 - s), w2 = s * s;
        inn.push(c.X ? [w0 * a.L[0] + w1 * c.X[0] + w2 * b.R[0], w0 * a.L[1] + w1 * c.X[1] + w2 * b.R[1]] : [a.L[0] + (b.R[0] - a.L[0]) * s, a.L[1] + (b.R[1] - a.L[1]) * s]);
        out.push(Xo ? [w0 * ao[0] + w1 * Xo[0] + w2 * bo[0], w0 * ao[1] + w1 * Xo[1] + w2 * bo[1]] : [ao[0] + (bo[0] - ao[0]) * s, ao[1] + (bo[1] - ao[1]) * s]);
      }
      for (let j = 0; j < 10; j++) {
        M.quad([inn[j][0], inn[j][1], 0.15], [inn[j + 1][0], inn[j + 1][1], 0.15], [out[j + 1][0], out[j + 1][1], 0.15], [out[j][0], out[j][1], 0.15], walk);
        M.quad([inn[j][0], inn[j][1], 0], [inn[j + 1][0], inn[j + 1][1], 0], [inn[j + 1][0], inn[j + 1][1], 0.15], [inn[j][0], inn[j][1], 0.15], curb);
      }
    }
  },

  /** 고속 갈림목 — 본선 끝선과 램프 끝선 사이를 칠하고 흰 빗금(도류화), 코에는 충격 흡수대 */
  gore(M, g) {
    const pts = g.pts, z = 0.012, wht = NX(CCOL.white), asph = NX(CCOL.asphaltH);
    let k = pts.length - 1;
    while (k > 1 && pts[k].d > 7) k--;
    for (let i = 0; i < k; i++) {
      const a = pts[i], b = pts[i + 1];
      M.quad([a.H[0], a.H[1], a.H[2] + 0.004], [b.H[0], b.H[1], b.H[2] + 0.004], [b.P[0], b.P[1], b.P[2] + 0.004], [a.P[0], a.P[1], a.P[2] + 0.004], asph);
      // 빗금 — 4 m 마다, 본선 쪽에서 램프 쪽으로 진행 방향 비스듬히
      if (i % 2 === 0 && a.d > 0.6) {
        const ux = b.H[0] - a.H[0], uy = b.H[1] - a.H[1], L = Math.hypot(ux, uy) || 1, wx = ux / L * 0.45, wy = uy / L * 0.45;
        const c = pts[Math.min(k, i + 2)];
        M.quad([a.H[0], a.H[1], a.H[2] + z], [a.H[0] + wx, a.H[1] + wy, a.H[2] + z], [c.P[0] + wx, c.P[1] + wy, c.P[2] + z], [c.P[0], c.P[1], c.P[2] + z], wht);
      }
    }
    // 끝선 둘 (본선 바깥 · 램프 안쪽) — 코까지 실선
    for (const key of ['H', 'P']) for (let i = 0; i < k; i++) {
      const a = pts[i][key], b = pts[i + 1][key], ux = b[0] - a[0], uy = b[1] - a[1], L = Math.hypot(ux, uy) || 1, nx = -uy / L * 0.1, ny = ux / L * 0.1;
      M.quad([a[0] - nx, a[1] - ny, a[2] + z], [b[0] - nx, b[1] - ny, b[2] + z], [b[0] + nx, b[1] + ny, b[2] + z], [a[0] + nx, a[1] + ny, a[2] + z], wht);
    }
    // 코 — 충격 흡수대 (노랑 · 검정 띠) 와 그 뒤로 두 방호벽이 시작된다
    if (g.nose) {
      const n = g.nose, a = pts.find((p) => p.s >= n.s) || pts[k], ux = a.P[0] - a.H[0], uy = a.P[1] - a.H[1], L = Math.hypot(ux, uy) || 1;
      const hx = -uy / L, hy = ux / L, s = g.div ? 1 : -1;      // 진행 방향 (분류면 노드에서 멀어지는 쪽)
      for (let j = 0; j < 4; j++) {
        const cx = n.x - hx * s * (j * 0.9 + 0.5), cy = n.y - hy * s * (j * 0.9 + 0.5);
        M.box(cx - 0.45, cy - 0.45, n.z, cx + 0.45, cy + 0.45, n.z + 0.9, j % 2 ? '#1d1f22' : '#e8b820', 0, true);
      }
    }
  },
  /** 막다른 길 끝 — 돌림 원 (바닥 · 둘레 보도) */
  culDeSac(M, N) {
    const l = N.legs[0], r = Math.max(l.wR, l.wL) + 3.5, z = N.z + 0.004, col = NX(CCOL.asphalt), k = 32;
    for (let i = 0; i < k; i++) { const a = i / k * TAU, b = (i + 1) / k * TAU; M.tri([N.x, N.y, z], [N.x + Math.cos(a) * r, N.y + Math.sin(a) * r, z], [N.x + Math.cos(b) * r, N.y + Math.sin(b) * r, z], col); }
    if (!l.sw || Math.abs(N.z) > 0.3) return;
    const walk = shade(CCOL.walk, faceLit(0, 0, 1, 0)), curb = shade(CCOL.curb, faceLit(0, 0, 1, 0) * 0.85), w = l.sw;
    for (let i = 0; i < k; i++) {
      const a = i / k * TAU, b = (i + 1) / k * TAU;
      if (Math.abs(wrapPi((a + b) / 2 - l.ang)) < 0.75) continue;      // 길이 들어오는 쪽은 비운다
      const P = (t, rr, zz) => [N.x + Math.cos(t) * rr, N.y + Math.sin(t) * rr, zz];
      M.quad(P(a, r, 0.15), P(b, r, 0.15), P(b, r + w, 0.15), P(a, r + w, 0.15), walk);
      M.quad(P(a, r, 0), P(b, r, 0), P(b, r, 0.15), P(a, r, 0.15), curb);
    }
  },
  /** 노면표시 — 중앙선 · 차로 경계 · 가장자리선 · 정지선 · 횡단보도 · 화살표 */
  markings(M, L) {
    const R = L.road, cl = R.cl, N = L.to, z = 0.013;
    const wht = NX(CCOL.white), yel = NX(CCOL.yellow);
    const ext0 = L.from.gate ? -70 : 0, ext1 = L.to.gate ? L.len + 70 : L.len;
    const A = {}, B = {};
    const strip = (t0, t1, fa, fb, col, step) => {
      const ts = tRange(t0, t1, step || 2);
      for (let i = 0; i + 1 < ts.length; i++) {
        L.center(ts[i], A); L.center(ts[i + 1], B);
        M.quad(offPt(A, fa(ts[i]), z), offPt(B, fa(ts[i + 1]), z), offPt(B, fb(ts[i + 1]), z), offPt(A, fb(ts[i]), z), col);
      }
    };
    const K = (v) => () => v;
    // 중앙선 · 가장자리선
    if (R.twoWay && !cl.fast) strip(ext0, ext1, K(cl.med - 0.2), K(cl.med - 0.06), yel, 4);
    if (cl.fast) {
      if (R.twoWay) strip(ext0, ext1, K(L.base - 0.75), K(L.base - 0.6), yel, 4);
      else strip(ext0, ext1, (t) => L.base + 0.05, (t) => L.base + 0.2, wht, 4);
      strip(ext0, ext1, (t) => L.outer(clamp(t, 0, L.len)) - 0.2, (t) => L.outer(clamp(t, 0, L.len)) - 0.05, wht, 4);
    }
    // 차로 경계 — 점선 (도시 3 m · 5 m, 고속 8 m · 12 m), 교차로 앞 30 m 와 회전 · 가감속 차로 옆은 실선
    const ctl = N.ctl === 'signal' || N.ctl === 'stop';
    const dash = cl.fast ? [8, 12] : [3, 5];
    const byR = new Map(); for (const ln of L.lanes) { if (!byR.has(ln.r)) byR.set(ln.r, []); byR.get(ln.r).push(ln); }
    for (const [r, arr] of byR) {
      if (!byR.has(r - 1)) continue;
      for (const ln of arr) for (const pv of byR.get(r - 1)) {
        const t0 = Math.max(ln.t0, pv.t0), t1 = Math.min(ln.t1, pv.t1);
        if (t1 - t0 < 2) continue;
        const off = (t) => { let a = L.base; for (const o of L.slots) if (o.r < r) a += R.cl.LW * o.p(t); return a; };
        const fa = (t) => off(t) - 0.075, fb = (t) => off(t) + 0.075;
        const aux = ln.type === 'acc' || ln.type === 'dec' || pv.type === 'acc' || pv.type === 'dec';
        if (aux) {          // 가 · 감속 차로 경계 — 굵은 점선 (폭 30 cm, 3 m 칠 · 3 m 빔)
          const ga = (t) => off(t) - 0.15, gb = (t) => off(t) + 0.15;
          for (let t = t0; t < t1; t += 6) strip(t, Math.min(t + 3, t1), ga, gb, wht, 3);
          continue;
        }
        const solidFrom = ln.type !== 'thru' || pv.type !== 'thru' ? t0 : ctl ? Math.max(t0, t1 - 30) : t1;
        for (let t = t0; t < solidFrom; t += dash[0] + dash[1]) strip(t, Math.min(t + dash[0], solidFrom), fa, fb, wht, dash[0]);
        if (solidFrom < t1) strip(solidFrom, t1, fa, fb, wht, 3);
      }
    }
    // 연결로 · 고속 출입구 쪽 끝 — 정지선 · 횡단보도 · 화살표는 신호 · 일시정지 교차로에서만
    if (!ctl) return;
    const tS = L.len - CN.stopBack, left = R.twoWay ? 0 : L.base - 0.2, right = (t) => L.outer(t) + 0.1;
    if (cl.sw) {
      strip(tS, tS + 0.45, K(left || cl.med), (t) => right(t), wht, 1);
      // 횡단보도 — 들어오는 쪽 · 나가는 쪽 구간이 제 몫 반쪽씩 그린다
      const zebra = (Lk, t0, t1) => { const w = Lk.outer(t0) + 0.2, a0 = Lk.road.twoWay ? 0.3 : Lk.base - 0.1; for (let o = a0; o < w - 0.3; o += 1.0) { const oo = o; strip(t0, t1, K(oo), K(Math.min(oo + 0.5, w)), wht, 4); } };
      zebra(L, L.len - 4.6, L.len - 0.8);
      const leg = N.legs.find((g) => g.inLink === L);
      if (leg && leg.outLink && R.twoWay) zebra(leg.outLink, 0.8, 4.6);
    } else strip(L.len - 0.9, L.len - 0.45, K(left || cl.med), (t) => right(t), wht, 1);
    for (const ln of L.endLanes) {
      if (!ln.mv) continue;
      for (const t of [L.len - 14, L.len - 42]) if (t > ln.t0 + 3 && t > 6) this.arrow(M, ln, ln.sAtC(t), ln.mv, wht);
    }
  },
  /** 차로 위 화살표 — 길이 5 m (직진 줄기 · 좌 · 우 가지) */
  arrow(M, ln, s, mv, col) {
    const p = ln.at(s, {}), c = Math.cos(p.h), sn = Math.sin(p.h), z = p.z + 0.015;
    const P = (a, b) => [p.x + c * a - sn * b, p.y + sn * a + c * b, z];
    const S = mv.includes('S');
    M.quad(P(-2.5, -0.13), P(S ? 0.9 : -0.3, -0.13), P(S ? 0.9 : -0.3, 0.13), P(-2.5, 0.13), col);
    if (S) M.tri(P(0.9, -0.55), P(2.5, 0), P(0.9, 0.55), col);
    for (const [k, sg] of [['L', 1], ['R', -1]]) {
      if (!mv.includes(k)) continue;
      M.quad(P(-0.6, 0.13 * sg), P(-0.3, 0.13 * sg), P(-0.3, 1.05 * sg), P(-0.6, 1.05 * sg), col);
      M.tri(P(-1.1, 1.05 * sg), P(0.2, 1.05 * sg), P(-0.45, 1.85 * sg), col);
    }
  },
  /** 신호등 — 직진해 나갈 구간의 오른쪽 모퉁이(건너편)에 기둥, 팔을 뻗어 차로 위에 4 색 등. 직진이 없으면 정지선 오른쪽 */
  signalMast(M, L) {
    const N = L.to, cS = N.conns.find((c) => c.from.link === L && c.mv === 'S');
    const inEnd = L.center(L.len, {}), hIn = inEnd.h, fx = Math.cos(hIn), fy = Math.sin(hIn), rx = fy, ry = -fx;
    let pole, head;
    if (cS) {
      const Lo = cS.to.link, o = Lo.center(Math.min(3, Lo.len), {}), w = Lo.outer(0) + Lo.road.cl.sh + 1.0;
      pole = offPt(o, w); head = offPt(o, Lo.base + Lo.road.cl.LW * Lo.nThru / 2);
    } else {
      const o = L.center(L.len - CN.stopBack + 1, {}), w = L.outer(L.len) + L.road.cl.sh + 1.0;
      pole = offPt(o, w); head = offPt(o, L.base + L.road.cl.LW * L.nThru / 2);
    }
    const z0 = N.z + 0.15;
    M.box(pole[0] - 0.14, pole[1] - 0.14, z0, pole[0] + 0.14, pole[1] + 0.14, z0 + 6.4, CCOL.pole, 0, true);
    const arm = [head[0] + rx * 1.0, head[1] + ry * 1.0];
    this.beam(M, [pole[0], pole[1], z0 + 6.05], [arm[0], arm[1], z0 + 6.05], 0.16, 0.16, CCOL.pole);
    // 등 상자 — 운전자 기준 왼쪽 → 오른쪽: 적 · 황 · 좌회전 · 녹
    const hz = z0 + 5.55, a0 = [head[0] - rx * 0.98, head[1] - ry * 0.98, hz], a1 = [head[0] + rx * 0.98, head[1] + ry * 0.98, hz];
    this.beam(M, [a0[0] + fx * 0.15, a0[1] + fy * 0.15, hz], [a1[0] + fx * 0.15, a1[1] + fy * 0.15, hz], 0.32, 0.5, CCOL.head);
    const lamps = [];
    for (let q = 0; q < 4; q++) {
      const u = -0.69 + 0.46 * q, lx = head[0] + rx * u - fx * 0.02, ly = head[1] + ry * u - fy * 0.02;
      lamps.push([lx, ly, hz + 0.25]);
      const P = (a, b) => [lx + rx * a, ly + ry * a, hz + 0.25 + b];
      M.quad(P(-0.17, -0.17), P(0.17, -0.17), P(0.17, 0.17), P(-0.17, 0.17), CCOL.lampOff);
    }
    this.heads.push({ L, N, f: [fx, fy], r: [rx, ry], lamps });
  },
  /** 일시정지 표지 — 작은 길 정지선 오른쪽 */
  stopSign(M, L) {
    const o = L.center(L.len - CN.stopBack, {}), p = offPt(o, L.outer(L.len) + L.road.cl.sh + 0.8);
    M.box(p[0] - 0.05, p[1] - 0.05, 0.15, p[0] + 0.05, p[1] + 0.05, 2.4, CCOL.pole, 0, true);
    const fx = Math.cos(o.h), fy = Math.sin(o.h), rx = fy, ry = -fx;
    const P = (a, b) => [p[0] + rx * a - fx * 0.07, p[1] + ry * a - fy * 0.07, 2.4 + b];
    M.quad(P(-0.36, 0), P(0.36, 0), P(0.36, 0.72), P(-0.36, 0.72), '#c8231c');
    M.quad(P(-0.26, 0.3), P(0.26, 0.3), P(0.26, 0.42), P(-0.26, 0.42), '#f4f2ee');
  },
  tree(M, rng, x, y, z, k) {
    M.box(x - 0.13 * k, y - 0.13 * k, z, x + 0.13 * k, y + 0.13 * k, z + 2.2 * k, CCOL.trunk, 0, true);
    const c = rng.chance(0.5) ? CCOL.tree : CCOL.tree2, r = rng.range(1.1, 1.5) * k;
    M.box(x - r, y - r, z + 2.0 * k, x + r, y + r, z + 3.6 * k, c, 0, false);
    M.box(x - r * 0.62, y - r * 0.62, z + 3.6 * k, x + r * 0.62, y + r * 0.62, z + 4.7 * k, shade(c, 1.06), 0, true);
  },
  /** 돌린 상자 (네 옆면 · 윗면) — P 는 꼭짓점 넷 (반시계) */
  prism(M, P, z0, z1, col, top) {
    for (let i = 0; i < 4; i++) {
      const a = P[i], b = P[(i + 1) % 4], nx = b[1] - a[1], ny = -(b[0] - a[0]), L = Math.hypot(nx, ny) || 1;
      M.quad([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1], shade(col, faceLit(nx / L, ny / L, 0, 0)));
    }
    if (top !== false) M.quad([P[0][0], P[0][1], z1], [P[1][0], P[1][1], z1], [P[2][0], P[2][1], z1], [P[3][0], P[3][1], z1], shade(top || col, faceLit(0, 0, 1, 0)));
  },
  /** 건물 — 바닥 판 · 몸통 · 층마다 창 띠(밤엔 집집마다 불) · 옥상 · 주차 출입구 · 진입로 */
  building(M, rng, B) {
    const b = B.m, P = bldCorners(b), H0 = Math.max(4, b.h || 12);
    const ins = (k) => { const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0), hw = b.w / 2 + k, hd = b.d / 2 + k; return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => [b.x + c * u - s * v, b.y + s * u + c * v]); };
    this.prism(M, ins(1.2), -0.05, 0.12, CCOL.pad);
    if (b.kind === 'parking') return this.parkingBld(M, rng, B, P, H0);
    const tall = H0 > 34, col = tall && rng.chance(0.6) ? rng.pick(CGLASS) : rng.pick(CBLD);
    const fl = 3.4, n = Math.max(1, Math.floor((H0 - 1) / fl)), H = n * fl + 0.8;
    this.prism(M, P, 0.12, H, col);
    const win = tall ? '#3d4f60' : '#4a5560';
    for (let i = 0; i < 4; i++) {
      const a = P[i], c = P[(i + 1) % 4], len = Math.hypot(c[0] - a[0], c[1] - a[1]); if (len < 3) continue;
      const ux = (c[0] - a[0]) / len, uy = (c[1] - a[1]) / len, nx = uy, ny = -ux, o = 0.03;
      const lit = faceLit(nx, ny, 0, 0);
      const Q = (s, z) => [a[0] + ux * s + nx * o, a[1] + uy * s + ny * o, z];
      for (let f = 0; f < n; f++) {
        const zA = f * fl + 1.0, zB = zA + (tall ? 2.1 : 1.4);
        if (f === 0 && !tall && b.kind !== 'apart') { M.quad(Q(0.6, zA - 0.6), Q(len - 0.6, zA - 0.6), Q(len - 0.6, zB + 0.3), Q(0.6, zB + 0.3), PNIGHT ? '#f2dfa8' : shade('#5b6670', lit)); continue; }
        if (!PNIGHT) { M.quad(Q(0.7, zA), Q(len - 0.7, zA), Q(len - 0.7, zB), Q(0.7, zB), shade(win, lit * rng.range(0.92, 1.08))); continue; }
        const k = Math.max(1, Math.round((len - 1.4) / 3.6)), wq = (len - 1.4) / k;
        for (let q = 0; q < k; q++) {
          const cc = rng.chance(b.kind === 'apart' ? 0.45 : 0.28) ? (rng.chance(0.5) ? '#ffd98a' : '#f4e7c4') : '#1b2230';
          M.quad(Q(0.7 + q * wq + 0.15, zA), Q(0.7 + (q + 1) * wq - 0.15, zA), Q(0.7 + (q + 1) * wq - 0.15, zB), Q(0.7 + q * wq + 0.15, zB), cc);
        }
      }
    }
    this.prism(M, ins(-0.3), H, H + 0.5, shade(col, 0.9));
    if (b.w > 10 && b.d > 10) { const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0), u = rng.range(-b.w / 4, b.w / 4), v = rng.range(-b.d / 4, b.d / 4); const cx = b.x + c * u - s * v, cy = b.y + s * u + c * v; M.box(cx - 2, cy - 1.8, H, cx + 2, cy + 1.8, H + 2.6, CCOL.roof, 0, true); }
    this.garage(M, B);
  },
  /** 주차빌딩 — 층마다 슬래브 · 난간 · 기둥, 안에 세운 차 몇 대 */
  parkingBld(M, rng, B, P, H0) {
    const b = B.m, fl = 3.0, n = Math.max(2, Math.round(H0 / fl));
    const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0);
    const W = (u, v) => [b.x + c * u - s * v, b.y + s * u + c * v];
    for (let f = 0; f <= n; f++) {
      const z = f * fl + 0.12;
      this.prism(M, P, z, z + 0.3, CCOL.deck, f === n ? CCOL.deck : '#9a9c98');
      if (f > 0) this.prism(M, P.map((p, i) => p), z + 0.3, z + 1.1, shade(CCOL.wall, 1.05), false);
      if (f < n) {
        for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1]]) { const q = W(u * (b.w / 2 - 0.4), v * (b.d / 2 - 0.4)); M.box(q[0] - 0.3, q[1] - 0.3, z + 0.3, q[0] + 0.3, q[1] + 0.3, z + fl, CCOL.pier, 1, true); }
        for (let u = -b.w / 2 + 2.5; u < b.w / 2 - 2.5; u += 2.6) for (const v of [-b.d / 2 + 3, b.d / 2 - 3]) {
          if (!rng.chance(0.55)) continue;
          const cls = rng.weighted(CCLASS.map((k) => [k, k.share])), q = W(u, v);
          carMesh(M, { cls, len: cls.len, wid: cls.wid, hei: cls.hei, color: rng.weighted(CAR_COLORS) }, q[0], q[1], z + 0.31, (b.rot || 0) + Math.PI / 2 * (v > 0 ? 1 : -1), 0, 1, false);
        }
      }
    }
    this.garage(M, B);
  },
  /** 주차 출입구 — 문(어두운 구멍) · 진입로 포장 */
  garage(M, B) {
    if (!B.door) return;
    const d = B.door, tx = -d.ny, ty = d.nx;
    const P = (a, z, o) => [d.x + tx * a + d.nx * (o || 0.05), d.y + ty * a + d.ny * (o || 0.05), z];
    M.quad(P(-3.2, 0.12), P(3.2, 0.12), P(3.2, 2.9), P(-3.2, 2.9), '#16181b');
    M.quad(P(-3.6, 2.9), P(3.6, 2.9), P(3.6, 3.4), P(-3.6, 3.4), '#2c3e5a');
    // 진입로 — 들어가는 길 · 나오는 길을 따라 포장
    const drv = NX(CCOL.drive);
    for (const p of [B.din, B.dout]) {
      const A = {}, Bq = {};
      for (let s = 0; s < p.len - 0.5; s += 1.5) {
        p.at(s, A); p.at(Math.min(p.len, s + 1.5), Bq);
        M.quad(offPt(A, -1.7, 0.165), offPt(Bq, -1.7, 0.165), offPt(Bq, 1.7, 0.165), offPt(A, 1.7, 0.165), drv);
      }
    }
  },

  /* ---------- 움직이는 것 (세계 좌표 버퍼) ---------- */
  _need(k) {
    if (this.dn + k <= this.dP.length / 3) return;
    let cap = this.dP.length / 3; while (cap < this.dn + k) cap *= 2;
    const P = new Float32Array(cap * 3); P.set(this.dP); this.dP = P;
    const Cc = new Uint8Array(cap * 4); Cc.set(this.dC); this.dC = Cc;
  },
  dquad(a, b, c, d, style) {
    this._need(6);
    const col = Render.color(style), P = this.dP, Cc = this.dC;
    for (const q of [a, b, c, a, c, d]) {
      const i = this.dn++;
      P[i * 3] = q[0]; P[i * 3 + 1] = q[1]; P[i * 3 + 2] = q[2];
      Cc[i * 4] = col[0]; Cc[i * 4 + 1] = col[1]; Cc[i * 4 + 2] = col[2]; Cc[i * 4 + 3] = 255;
    }
  },

  /* ---------- GL ---------- */
  drawStatic(gl, n, F) {
    if (!this.prog) return;
    const Lc = this.loc, W = gl.canvas.width, H = gl.canvas.height;
    if (!this.uploaded) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.sp); gl.bufferData(gl.ARRAY_BUFFER, this.mesh.P, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.sc); gl.bufferData(gl.ARRAY_BUFFER, this.mesh.C, gl.STATIC_DRAW);
      this.uploaded = true;
    }
    gl.useProgram(this.prog);
    gl.uniform3f(Lc.E, Render.cx, Render.cy, Render.cz);
    gl.uniform3f(Lc.R, Render.rx, Render.ry, Render.rz);
    gl.uniform3f(Lc.U, Render.ux, Render.uy, Render.uz);
    gl.uniform3f(Lc.F, Render.fx, Render.fy, Render.fz);
    gl.uniform2f(Lc.f, Render.focal / (W / 2), Render.focal / (H / 2));
    gl.uniform2f(Lc.d, (F + n) / (F - n), -2 * F * n / (F - n));
    const fg = this.fogCol || [0.72, 0.78, 0.84];
    gl.uniform4f(Lc.fog, fg[0], fg[1], fg[2], 420);
    const draw = (bp, bc, count) => {
      if (count <= 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, bp); gl.enableVertexAttribArray(Lc.p); gl.vertexAttribPointer(Lc.p, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bc); gl.enableVertexAttribArray(Lc.c); gl.vertexAttribPointer(Lc.c, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, count);
    };
    draw(this.buf.sp, this.buf.sc, this.mesh.n);
    if (this.dn) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.cp); gl.bufferData(gl.ARRAY_BUFFER, this.dP.subarray(0, this.dn * 3), gl.STREAM_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.cc); gl.bufferData(gl.ARRAY_BUFFER, this.dC.subarray(0, this.dn * 4), gl.STREAM_DRAW);
      draw(this.buf.cp, this.buf.cc, this.dn);
    }
    gl.disableVertexAttribArray(Lc.p); gl.disableVertexAttribArray(Lc.c);
  },

  /* ---------- 프레임 ---------- */
  draw(ctx, W, H, cam, opt) {
    const sim = this.sim;
    Render.pal = { amb: 1, haze: '#b8c4cf' };
    Render.drawDist = 6000;
    Render.setup(ctx, W, H, cam);
    if (Render.gl) { ctx.clearRect(0, 0, W, H); Render.glBegin(); }
    this.sky(opt.skyCtx || ctx, W, H);
    this.dn = 0;
    const em = { quad: (a, b, c, d, s) => this.dquad(a, b, c, d, s) };
    const t = sim ? sim.time : 0;
    if (sim && !opt.noCars) for (const v of sim.cars) {
      if (v === opt.hide) continue;
      const dist = Render.depth(v.x, v.y, v.z + 1);
      if (dist < -8 || dist > 2600) continue;
      if (dist < 280) {
        Render.layer = 3; ctx.globalAlpha = 0.33;
        const ch = Math.cos(v.h), sh = Math.sin(v.h), hl = v.len * 0.5, hw = v.wid * 0.5;
        Render.begin();
        for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) Render.add(v.x + ch * hl * a - sh * hw * b, v.y + sh * hl * a + ch * hw * b, v.z + 0.03 + Math.tan(v.p) * hl * a);
        Render.fill('#000000');
        ctx.globalAlpha = 1; Render.layer = 0;
      }
      carMesh(em, v, v.x, v.y, v.z, v.h, v.p, v.z < -4 ? 2 : 0, dist < 240);
      if (dist < 420) this.lights(v, t, dist);
    }
    if (sim) for (const hd of this.heads) this.headLamps(em, hd);
    // 지하차도 덮개 — 반투명 (안의 차가 비친다)
    ctx.globalAlpha = opt.edit ? 0.35 : 0.62; Render.layer = 1;
    for (const lid of this.lids) for (const q of lid) { Render.begin(); for (const p of q) Render.add(p[0], p[1], p[2]); Render.fill(PNIGHT ? '#20252c' : '#7d8a62'); }
    ctx.globalAlpha = 1; Render.layer = 0;
    if (opt.flow && sim) this.flowMap(ctx);
    if (opt.selN) this.ring(ctx, opt.selN.x, opt.selN.y, opt.selN.z + 0.1, Math.max(8, ...opt.selN.legs.map((l) => l.sb)) + 2, '#5fd0ff');
    if (opt.selB) { const b = opt.selB.m || opt.selB; Render.layer = 2; const P = bldCorners(b); for (let i = 0; i < 4; i++) { const a = P[i], c = P[(i + 1) % 4]; this.band(a[0], a[1], c[0], c[1], 0.5, 0.3, '#5fd0ff'); } Render.layer = 0; }
    if (opt.selR) this.roadBand(ctx, opt.selR, '#5fd0ff', 0.55);
    const sv = opt.sel;
    if (sv && !sv.gone && !opt.follow) this.routeLine(ctx, sv);
    if (PNIGHT) for (const [x, y, z] of this.lamps) {
      const d = Render.depth(x, y, z); if (d < 1 || d > 900) continue;
      const k = Render.H / 900;
      Render.mark(x, y, z, clamp(300 / d, 1.5, 6) * k, clamp(180 / d, 1, 3.5) * k, '#fff2cc');
      Render.glow(x, y, z - 0.2, clamp(2600 / d, 6, 60) * k, '#ffe9b0', '#ffe9b044', 0.45);
    }
    if (Render.gl) { Render.preFlush = (gl, n, F) => this.drawStatic(gl, n, F); Render.glFlush(); }
  },
  headLamps(em, hd) {
    const [lx, ly, lz] = hd.lamps[1], dist = Render.depth(lx, ly, lz);
    if (dist < -2 || dist > 1800) return;
    const sim = this.sim, cs = hd.N.conns.filter((c) => c.from.link === hd.L);
    const st = (mv) => { let best = null; for (const c of cs) if (c.mv === mv) { const s = sim.sig(c); if (s === 'G') return 'G'; if (s === 'Y') best = 'Y'; else if (!best) best = 'R'; } return best; };
    const S = st('S') || st('R') || 'R', Lt = st('L');
    const on = [S === 'R' && Lt !== 'Y' && Lt !== 'G' || (S === 'R' && Lt === 'G'), S === 'Y' || Lt === 'Y', Lt === 'G', S === 'G'];
    const col = ['#ff3b2e', '#ffb81c', '#3df07a', '#3df07a'];
    const front = (Render.cx - lx) * -hd.f[0] + (Render.cy - ly) * -hd.f[1] > 0;
    for (let q = 0; q < 4; q++) {
      if (!on[q]) continue;
      const [x, y, z] = hd.lamps[q], rx = hd.r[0], ry = hd.r[1], o = -0.02;
      const P = (a, b) => [x + rx * a - hd.f[0] * o, y + ry * a - hd.f[1] * o, z + b];
      if (q === 2) { em.quad(P(-0.13, -0.04), P(0.12, -0.04), P(0.12, 0.04), P(-0.13, 0.04), col[q]); em.quad(P(-0.15, -0.1), P(-0.15, -0.1), P(-0.15, 0.1), P(-0.04, 0), col[q]); }
      else em.quad(P(-0.15, -0.15), P(0.15, -0.15), P(0.15, 0.15), P(-0.15, 0.15), col[q]);
      if (front && dist < 1000) Render.glow(x - hd.f[0] * 0.2, y - hd.f[1] * 0.2, z, clamp(900 / Math.max(dist, 1), 3, 26) * Render.H / 900, col[q], col[q] + '55', PNIGHT ? 0.9 : 0.55);
    }
  },
  band(x0, y0, x1, y1, w, z, col, z1) {
    const L = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / L * w, ny = (x1 - x0) / L * w;
    Render.begin();
    Render.add(x0 - nx, y0 - ny, z); Render.add(x1 - nx, y1 - ny, z1 == null ? z : z1); Render.add(x1 + nx, y1 + ny, z1 == null ? z : z1); Render.add(x0 + nx, y0 + ny, z);
    Render.fill(col);
  },
  ring(ctx, x, y, z, r, col) {
    Render.layer = 2;
    const k = 48;
    for (let i = 0; i < k; i++) {
      const a0 = i / k * TAU, a1 = (i + 1) / k * TAU;
      Render.begin();
      Render.add(x + Math.cos(a0) * r, y + Math.sin(a0) * r, z); Render.add(x + Math.cos(a1) * r, y + Math.sin(a1) * r, z);
      Render.add(x + Math.cos(a1) * (r + 0.6), y + Math.sin(a1) * (r + 0.6), z); Render.add(x + Math.cos(a0) * (r + 0.6), y + Math.sin(a0) * (r + 0.6), z);
      Render.fill(col);
    }
    Render.layer = 0;
  },
  /** 도로 전체를 덮는 띠 (고른 도로) */
  roadBand(ctx, R, col, alpha) {
    ctx.globalAlpha = alpha; Render.layer = 2;
    const g = R.g, w = Math.max(3, (R.n[0] + R.n[1]) * R.cl.LW / 2 + 1);
    for (let i = 0; i + 2 < g.n; i += 2) this.band(g.x[i], g.y[i], g.x[i + 2], g.y[i + 2], w, g.z[i] + 0.12, col, g.z[i + 2] + 0.12);
    ctx.globalAlpha = 1; Render.layer = 0;
  },
  flowMap(ctx) {
    ctx.globalAlpha = 0.72; Render.layer = 2;
    const A = {}, B = {};
    for (const L of this.net.links) {
      let n = 0, vs = 0;
      for (const ln of L.lanes) for (const c of ln.cars) { n++; vs += c.v; }
      const r = n ? vs / n / L.vLim : 1;
      const col = r > 0.55 ? '#2fbf71' : r > 0.3 ? '#e8c33f' : r > 0.12 ? '#f07a2e' : '#d0302c';
      const mid = L.base + L.road.cl.LW * L.nThru / 2, w = L.road.cl.LW * L.nThru * 0.42;
      const ts = tRange(0, L.len, 6);
      for (let i = 0; i + 1 < ts.length; i++) {
        L.center(ts[i], A); L.center(ts[i + 1], B);
        const a = offPt(A, mid), b = offPt(B, mid);
        this.band(a[0], a[1], b[0], b[1], w, A.z + 0.06, col, B.z + 0.06);
      }
    }
    for (const N of this.net.nodes) {
      if (N.ctl !== 'signal' && N.ctl !== 'stop') continue;
      const s = Math.max(6, ...N.legs.map((l) => l.sb)) * 0.7;
      ctx.globalAlpha = 0.45; Render.begin();
      for (let i = 0; i < 16; i++) { const a = i / 16 * TAU; Render.add(N.x + Math.cos(a) * s, N.y + Math.sin(a) * s, N.z + 0.05); }
      Render.fill(LOS_COL[N.los]); ctx.globalAlpha = 0.72;
    }
    ctx.globalAlpha = 1; Render.layer = 0;
  },
  /** 고른 차의 남은 길 (350 m) — 하늘색 띠 · 목적지 표시 */
  routeLine(ctx, v) {
    Render.layer = 2; ctx.globalAlpha = 0.85;
    let left = 350;
    const pts = [];
    const take = (path, s0) => {
      const s1 = Math.min(path.len, s0 + left);
      for (let s = s0; s < s1; s += 3) pts.push(path.at(s, {}));
      pts.push(path.at(s1, {}));
      left -= Math.max(0, s1 - s0);
    };
    const e = v.edge;
    take(e, v.s);
    let lane = e.kind === 'conn' ? e.to : null, ri = v.ri + 1;
    if (e.kind === 'lane' && v.conn && left > 0) { take(v.conn, 0); lane = v.conn.to; }
    for (let hop = 0; lane && left > 0 && hop < 8; hop++) {
      take(lane, 0);
      const nx = v.route[ri + 1];
      if (!nx) break;
      let cn = (lane.outTo.get(nx.id) || [])[0] || null;
      for (const ln of lane.link.lanes) { if (cn) break; cn = (ln.outTo.get(nx.id) || [])[0] || null; }
      if (!cn) break;
      take(cn, 0); lane = cn.to; ri++;
    }
    for (let i = 0; i + 1 < pts.length; i++) this.band(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, 0.22, pts[i].z + 0.08, '#5fd0ff', pts[i + 1].z + 0.08);
    ctx.globalAlpha = 1; Render.layer = 0;
    const d = v.dest;
    if (d) { const p = d.bld ? d.bld.door : d.gate.N; Render.mark(p.x, p.y, 3, 12, 12, '#5fd0ff'); }
  },
  lights(v, t, dist) {
    const ch = Math.cos(v.h), sh = Math.sin(v.h), L = v.len / 2, w = v.wid * 0.38, zT = v.z + 0.82 * v.hei / 1.45;
    const px = Render.H / 720, sz = clamp(60 / Math.max(dist, 1), 1.2, 7) * px;
    const rx = v.x - ch * (L + 0.02), ry = v.y - sh * (L + 0.02);
    const dark = PNIGHT || v.z < -4;
    for (const sd of [-1, 1]) {
      const lx = rx - sh * w * sd, ly = ry + ch * w * sd;
      if (v.brake) { Render.mark(lx, ly, zT, sz * 1.3, sz * 0.7, '#ff2a1e'); if (dist < 200) Render.glow(lx, ly, zT, sz * 3, '#ff4a30', '#ff4a3055', 0.55); }
      else if (dark) Render.mark(lx, ly, zT, sz * 1.1, sz * 0.6, '#9e1d16');
      if (dark) {
        const fxp = v.x + ch * (L + 0.02) - sh * w * sd, fyp = v.y + sh * (L + 0.02) + ch * w * sd;
        Render.mark(fxp, fyp, zT - 0.15, sz * 1.2, sz * 0.6, '#fff8e0');
        Render.glow(fxp, fyp, zT - 0.15, sz * 4, '#fff4d0', '#fff4d044', 0.5);
      }
    }
    let bl = 0;
    const e = v.edge;
    if (e.kind === 'conn' && e.mv !== 'S') bl = e.mv === 'L' ? 1 : -1;
    else if (e.kind === 'lane' && v.conn && v.conn.mv !== 'S' && e.len - v.s < 30) bl = v.conn.mv === 'L' ? 1 : -1;
    else if (e.kind === 'din' || (e.kind === 'lane' && v.dest.bld && v.dest.bld.lane === e && v.dest.bld.sIn - v.s < 30 && v.dest.bld.sIn > v.s)) bl = -1;
    else if (e.kind === 'dout') bl = 1;
    else if (v.lc) bl = v.lc > 0 ? 1 : -1;
    if (bl && (Math.floor((t + (v.id % 7) * 0.13) * 1.7) & 1)) {
      for (const end of [1, -1]) {
        const ex = v.x + ch * L * end * 0.98 - sh * v.wid * 0.5 * bl, ey = v.y + sh * L * end * 0.98 + ch * v.wid * 0.5 * bl;
        Render.mark(ex, ey, zT - 0.1, sz, sz * 0.7, '#ffa825');
        if (dist < 200) Render.glow(ex, ey, zT - 0.1, sz * 3, '#ffa825', '#ffa82544', 0.5);
      }
    }
  },
  sky(ctx, W, H) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    if (PNIGHT) { g.addColorStop(0, '#04070f'); g.addColorStop(0.6, '#0d1628'); g.addColorStop(1, '#1a2336'); this.fogCol = [0.07, 0.09, 0.14]; }
    else { g.addColorStop(0, '#6f9ccc'); g.addColorStop(0.55, '#c6d6e4'); g.addColorStop(1, '#d9e0e4'); this.fogCol = [0.78, 0.84, 0.89]; }
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  },
};
