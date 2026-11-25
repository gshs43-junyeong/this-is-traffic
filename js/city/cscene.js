/* =============================================================================
   cscene.js — 도시 교통 3D 렌더

   주차장 렌더(pscene.js)와 같은 방식: 도로 · 노면표시 · 건물 · 신호등 기둥처럼 안 바뀌는 것은
   세계 좌표 정점을 GPU 에 한 번 올려 두고, 달리는 차 · 켜진 신호등 알은 프레임마다 세계 좌표로
   새로 채운 버퍼 하나로 그린다(카메라 변환은 GPU 몫). 그림자 · 소통 지도 같은 반투명 덧칠만
   render.js 의 길(Render.fill)을 탄다. 셋 다 같은 투영식 · 같은 깊이 버퍼를 쓴다.
   차 모양 · 면 밝기 · 정적 메쉬(carMesh · faceLit · MeshB · NX)는 pscene.js 의 것을 그대로 쓴다.
   ========================================================================== */
'use strict';

const CCOL = {
  grass: '#6b7c4b', field: '#7d8a55', walk: '#b5b2a9', walkTop: '#bdbab1', asphalt: '#3c3e42', yellow: '#e2b93b', white: '#e9e8e1',
  pole: '#5b6067', head: '#202328', lampOff: '#2c2f34', park: '#5d8848', tree: '#3d6a34', tree2: '#4b7a3a', trunk: '#5a4632',
  drive: '#8f8c85', lot: '#4a4c50', roof: '#8e9194',
};
const CBLD = ['#c9c2b3', '#a9b1b8', '#d6d0c4', '#8f99a3', '#b7a58f', '#9fa89a', '#c4b9a8', '#7f8b95', '#d9d4cb', '#a39a8c', '#b9b0a2', '#9aa6ae'];
const CGLASS = ['#6f8aa0', '#5f7890', '#7c94a6', '#58707f'];
const LOS_COL = { A: '#2fbf71', B: '#8fd14f', C: '#e8d33f', D: '#f0a03a', E: '#e8663a', F: '#d23a3a' };

const CScene = {
  init(C, sim, night) {
    this.C = C; this.sim = sim; PNIGHT = !!night;
    this.buildStatic();
    this.uploaded = false;
    this.dP = new Float32Array(3 * 120000); this.dC = new Uint8Array(4 * 120000); this.dn = 0;
  },
  /** GL 프로그램 · 버퍼는 주차장 렌더와 같은 것을 만든다 */
  initGL(gl) { PScene.initGL.call(this, gl); },

  /* ---------- 고정 메쉬 ---------- */
  buildStatic() {
    const C = this.C, M = new MeshB(), rng = new RNG('cityart:' + (C.cfg.seed | 0)), h = C.half, B = C.B, W = C.W, D = C.D;
    const ext = CITY.stub + C.box, ring = Math.min(B * 0.62, ext - 50), big = ext + 900;
    this.lamps = []; this.heads = [];
    // 땅 — 시가지 둘레는 들판
    M.quad([-big, -big, -0.08], [W + big, -big, -0.08], [W + big, D + big, -0.08], [-big, D + big, -0.08], NX(CCOL.field));
    M.quad([-ring - 40, -ring - 40, -0.06], [W + ring + 40, -ring - 40, -0.06], [W + ring + 40, D + ring + 40, -0.06], [-ring - 40, D + ring + 40, -0.06], NX(CCOL.grass));
    // 도로 바탕 — 교차로 사이 · 도시 밖으로 (게이트 너머 80 m 까지 이어 그린다)
    const xs = [], ys = [];
    for (let i = 0; i < C.NX; i++) xs.push(i * B);
    for (let j = 0; j < C.NY; j++) ys.push(j * B);
    const asph = NX(CCOL.asphalt);
    for (const y of ys) M.quad([-ext - 80, y - h, 0], [W + ext + 80, y - h, 0], [W + ext + 80, y + h, 0], [-ext - 80, y + h, 0], asph);
    for (const x of xs) M.quad([x - h, -ext - 80, 0], [x + h, -ext - 80, 0], [x + h, D + ext + 80, 0], [x - h, D + ext + 80, 0], asph);
    // 블록 — 격자선 사이 칸마다 (바깥 고리 칸 포함)
    const cx = [-ring, ...xs, W + ring], cy = [-ring, ...ys, D + ring];
    const road = (v, arr) => arr.includes(v);
    for (let a = 0; a < cx.length - 1; a++) for (let b = 0; b < cy.length - 1; b++) {
      const x0 = cx[a] + (road(cx[a], xs) ? h : 0), x1 = cx[a + 1] - (road(cx[a + 1], xs) ? h : 0);
      const y0 = cy[b] + (road(cy[b], ys) ? h : 0), y1 = cy[b + 1] - (road(cy[b + 1], ys) ? h : 0);
      const outer = a === 0 || b === 0 || a === cx.length - 2 || b === cy.length - 2;
      this.block(M, rng, x0, y0, x1, y1, outer, { L: road(cx[a], xs), R: road(cx[a + 1], xs), S: road(cy[b], ys), N: road(cy[b + 1], ys) });
    }
    // 노면표시 · 정지선 · 횡단보도 · 화살표 — 구간마다 제 방향 몫
    for (const L of C.links) this.markings(M, L);
    // 건물 출입구 — 길가 보도를 낮춘 진입로
    for (const z of C.zones) {
      const ln = z.link.lanes[z.link.lanes.length - 1], p = ln.at(z.s), r = [Math.sin(p.h), -Math.cos(p.h)];
      const c0 = [p.x + r[0] * (CITY.LW / 2), p.y + r[1] * (CITY.LW / 2)];
      const f = [Math.cos(p.h), Math.sin(p.h)];
      const P = (a, b) => [c0[0] + f[0] * a + r[0] * b, c0[1] + f[1] * a + r[1] * b, 0.158];
      M.quad(P(-4, 0), P(4, 0), P(3, 3.4), P(-3, 3.4), NX(CCOL.drive));
    }
    // 신호등 — 진입로마다 건너편 오른쪽 모퉁이 기둥에서 팔을 뻗어 차로 위에 등을 단다
    for (const I of C.ints) for (const sd of SIDES) this.signalMast(M, I, sd);
    M.done();
    this.mesh = M;
  },

  /** 한 블록 — 보도 판 · 가로수 · 가로등 · 필지(건물 · 공원 · 주차장) */
  block(M, rng, x0, y0, x1, y1, outer, rd) {
    const C = this.C, w = x1 - x0, d = y1 - y0;
    if (w < 8 || d < 8) return;
    const SW = 3.6, zt = 0.15;
    M.box(x0, y0, -0.05, x1, y1, zt, CCOL.walk, 0, true);
    // 가로수 · 가로등 — 도로 쪽 보도에
    const edgeRow = (ax, ay, bx, by, nx, ny) => {
      const len = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / len, uy = (by - ay) / len;
      for (let s = 9; s < len - 9; s += 17) {
        const px = ax + ux * s + nx * 1.1, py = ay + uy * s + ny * 1.1;
        if (Math.round(s / 17) % 2) this.tree(M, rng, px, py, zt, 0.8);
        else {
          M.box(px - 0.1, py - 0.1, zt, px + 0.1, py + 0.1, zt + 7.6, CCOL.pole, 0, true);
          const hx = px - nx * 1.3, hy = py - ny * 1.3;
          M.box(Math.min(px, hx) - 0.08, Math.min(py, hy) - 0.08, zt + 7.45, Math.max(px, hx) + 0.08, Math.max(py, hy) + 0.08, zt + 7.62, CCOL.pole, 0, false);
          this.lamps.push([hx, hy, zt + 7.4]);
        }
      }
    };
    if (rd.L) edgeRow(x0, y0, x0, y1, 1, 0);
    if (rd.R) edgeRow(x1, y0, x1, y1, -1, 0);
    if (rd.S) edgeRow(x0, y0, x1, y0, 0, 1);
    if (rd.N) edgeRow(x0, y1, x1, y1, 0, -1);
    // 필지
    const lx0 = x0 + (rd.L ? SW : 1), lx1 = x1 - (rd.R ? SW : 1), ly0 = y0 + (rd.S ? SW : 1), ly1 = y1 - (rd.N ? SW : 1);
    const lw = lx1 - lx0, ld = ly1 - ly0;
    if (lw < 6 || ld < 6) return;
    const nx = Math.max(1, Math.round(lw / rng.range(24, 40))), ny = Math.max(1, Math.round(ld / rng.range(24, 40)));
    const cxm = C.W / 2, cym = C.D / 2, rmax = Math.hypot(C.W / 2 + C.B, C.D / 2 + C.B);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      // 블록 가운데 필지는 안뜰(건물 사이 빈 땅)로 둘 때가 있다
      if (nx > 2 && ny > 2 && i > 0 && j > 0 && i < nx - 1 && j < ny - 1 && rng.chance(0.6)) continue;
      const a0 = lx0 + lw * i / nx, a1 = lx0 + lw * (i + 1) / nx, b0 = ly0 + ld * j / ny, b1 = ly0 + ld * (j + 1) / ny;
      const k = rng.next();
      const mx = (a0 + a1) / 2, my = (b0 + b1) / 2;
      if (k < 0.1) { this.parkLot(M, rng, a0 + 0.8, b0 + 0.8, a1 - 0.8, b1 - 0.8, zt); continue; }
      if (k < 0.2) {                                // 작은 공원
        M.quad([a0 + 0.5, b0 + 0.5, zt + 0.01], [a1 - 0.5, b0 + 0.5, zt + 0.01], [a1 - 0.5, b1 - 0.5, zt + 0.01], [a0 + 0.5, b1 - 0.5, zt + 0.01], NX(CCOL.park));
        const nt = Math.max(2, Math.round((a1 - a0) * (b1 - b0) / 60));
        for (let t = 0; t < nt; t++) this.tree(M, rng, rng.range(a0 + 2, a1 - 2), rng.range(b0 + 2, b1 - 2), zt, rng.range(0.9, 1.4));
        continue;
      }
      const cen = clamp(1 - Math.hypot(mx - cxm, my - cym) / rmax, 0, 1);
      let H = outer ? rng.range(6, 16) : rng.range(9, 20) + cen * cen * rng.range(8, 75);
      if (rng.chance(0.06) && !outer) H += 40 * cen;
      const ins = rng.range(1.0, 2.6);
      this.building(M, rng, a0 + ins, b0 + ins, a1 - ins, b1 - ins, zt, H);
    }
  },
  building(M, rng, x0, y0, x1, y1, z0, H) {
    if (x1 - x0 < 4 || y1 - y0 < 4) return;
    const tall = H > 34, col = tall && rng.chance(0.6) ? rng.pick(CGLASS) : rng.pick(CBLD);
    const fl = 3.4, n = Math.max(1, Math.floor((H - 1) / fl));
    H = n * fl + 0.8;
    M.box(x0, y0, z0, x1, y1, z0 + H, col, 0, true);
    // 창 띠 — 층마다 네 면에 (밤이면 몇 집은 불이 켜져 있다)
    const win = tall ? '#3d4f60' : '#4a5560';
    const faces = [[x0, y0, x1, y0, 0, -1], [x1, y0, x1, y1, 1, 0], [x1, y1, x0, y1, 0, 1], [x0, y1, x0, y0, -1, 0]];
    for (const [ax, ay, bx, by, nx, ny] of faces) {
      const len = Math.hypot(bx - ax, by - ay); if (len < 3) continue;
      const ux = (bx - ax) / len, uy = (by - ay) / len, o = 0.03;
      const lit = faceLit(nx, ny, 0, 0);
      for (let f = 0; f < n; f++) {
        const zA = z0 + f * fl + 1.0, zB = zA + (tall ? 2.1 : 1.4);
        const P = (s, z) => [ax + ux * s + nx * o, ay + uy * s + ny * o, z];
        if (f === 0 && !tall) { M.quad(P(0.6, zA - 0.6), P(len - 0.6, zA - 0.6), P(len - 0.6, zB + 0.3), P(0.6, zB + 0.3), PNIGHT ? '#f2dfa8' : shade('#5b6670', lit)); continue; }   // 1층 상가 유리
        if (!PNIGHT) { M.quad(P(0.7, zA), P(len - 0.7, zA), P(len - 0.7, zB), P(0.7, zB), shade(win, lit * rng.range(0.92, 1.08))); continue; }
        // 밤 — 띠를 창 몇 칸(약 3.6 m)으로 나눠 집집마다 따로 켠다
        const k = Math.max(1, Math.round((len - 1.4) / 3.6)), wq = (len - 1.4) / k;
        for (let q = 0; q < k; q++) {
          const c = rng.chance(0.3) ? (rng.chance(0.5) ? '#ffd98a' : '#f4e7c4') : '#1b2230';
          M.quad(P(0.7 + q * wq + 0.15, zA), P(0.7 + (q + 1) * wq - 0.15, zA), P(0.7 + (q + 1) * wq - 0.15, zB), P(0.7 + q * wq + 0.15, zB), c);
        }
      }
    }
    // 옥상 — 난간 띠 · 기계실
    M.box(x0, y0, z0 + H, x1, y1, z0 + H + 0.5, shade(col, 0.9), 0, true);
    if (x1 - x0 > 9 && y1 - y0 > 9) {
      const mx = rng.range(x0 + 2, x1 - 6), my = rng.range(y0 + 2, y1 - 6);
      M.box(mx, my, z0 + H, mx + 4, my + 3.5, z0 + H + 2.6, CCOL.roof, 0, true);
    }
  },
  tree(M, rng, x, y, z, k) {
    M.box(x - 0.13 * k, y - 0.13 * k, z, x + 0.13 * k, y + 0.13 * k, z + 2.2 * k, CCOL.trunk, 0, true);
    const c = rng.chance(0.5) ? CCOL.tree : CCOL.tree2, r = rng.range(1.1, 1.5) * k;
    M.box(x - r, y - r, z + 2.0 * k, x + r, y + r, z + 3.6 * k, c, 0, false);
    M.box(x - r * 0.62, y - r * 0.62, z + 3.6 * k, x + r * 0.62, y + r * 0.62, z + 4.7 * k, shade(c, 1.06), 0, true);
  },
  /** 노상 · 노외 주차장 — 줄 맞춰 선 차 몇 대 */
  parkLot(M, rng, x0, y0, x1, y1, z) {
    M.quad([x0, y0, z + 0.01], [x1, y0, z + 0.01], [x1, y1, z + 0.01], [x0, y1, z + 0.01], NX(CCOL.lot));
    const along = x1 - x0 > y1 - y0, L = along ? x1 - x0 : y1 - y0, Wd = along ? y1 - y0 : x1 - x0;
    const rows = Wd > 15 ? [3, Wd - 3] : [Wd / 2];
    for (const r of rows) for (let s = 1.5; s < L - 2.5; s += 2.5) {
      const ax = along ? x0 + s : x0 + r, ay = along ? y0 + r : y0 + s;
      const P = (a, b) => (along ? [ax + a, ay + b, z + 0.02] : [ax + b, ay + a, z + 0.02]);
      M.quad(P(-0.06, -2.5), P(0.06, -2.5), P(0.06, 2.5), P(-0.06, 2.5), CCOL.white);
      if (rng.chance(0.55) && s + 2.5 < L - 2.5) {
        const cls = rng.weighted(CCLASS.map((c) => [c, c.share]));
        const v = { cls, len: cls.len, wid: cls.wid, hei: cls.hei, color: rng.weighted(CAR_COLORS) };
        const cx = along ? ax + 1.25 : ax, cy = along ? ay : ay + 1.25, hd = (along ? Math.PI / 2 : 0) + (rng.chance(0.5) ? Math.PI : 0);
        carMesh(M, v, cx, cy, z + 0.02, hd, 0, 0, false);
      }
    }
  },

  /** 한 방향 구간의 노면표시 — 중앙선(제 몫 한 줄) · 차로 경계 · 정지선 · 횡단보도 · 회전 화살표 */
  markings(M, L) {
    const n = L.lanes.length, ln0 = L.lanes[0], len = L.len, LW = CITY.LW;
    const fx = L.dx, fy = L.dy, rx = fy, ry = -fx;
    const p0 = ln0.at(0), ox = p0.x - rx * ln0.off, oy = p0.y - ry * ln0.off;   // 중앙선 위 구간 시작점
    const z = 0.012;
    const strip = (s0, s1, o0, o1, col) => M.quad(
      [ox + fx * s0 + rx * o0, oy + fy * s0 + ry * o0, z], [ox + fx * s1 + rx * o0, oy + fy * s1 + ry * o0, z],
      [ox + fx * s1 + rx * o1, oy + fy * s1 + ry * o1, z], [ox + fx * s0 + rx * o1, oy + fy * s0 + ry * o1, z], col);
    const yel = NX(CCOL.yellow), wht = NX(CCOL.white);
    // 중앙선 — 복선 황색의 제 쪽 한 줄 (도시 밖 구간은 게이트 너머까지)
    strip(L.from ? 0 : -80, L.to ? len : len + 80, 0.07, 0.22, yel);
    // 차로 경계 — 흰 점선 3 m · 빈칸 5 m, 정지선 앞 30 m 는 실선(차로 바꾸기 금지)
    for (let k = 1; k < n; k++) {
      const o = CITY.MED + LW * k;
      const sEnd = L.to ? len - 30 : len + 80;
      for (let s = L.from ? 4 : -80; s < sEnd; s += 8) strip(s, Math.min(s + 3, sEnd), o - 0.075, o + 0.075, wht);
      if (L.to) strip(len - 30, len, o - 0.075, o + 0.075, wht);
    }
    if (!L.to) return;
    // 정지선 · 횡단보도 (도로 전폭)
    strip(len + 0.05, len + 0.5, CITY.MED, C_half(L), wht);
    const hh = C_half(L);
    for (let o = -hh + 0.5; o < hh - 0.4; o += 1.0) strip(len + 1.2, len + 4.2, o, o + 0.5, wht);
    // 회전 화살표 — 정지선 앞 12 m · 40 m
    for (const ln of L.lanes) {
      const mv = n === 1 ? 'LSR' : ln.k === 0 ? 'LS' : ln.k === n - 1 ? 'SR' : 'S';
      for (const s of [len - 12, len - 40]) if (s > 8) this.arrow(M, ln, s, mv, wht);
    }
  },
  /** 차로 위 화살표 — 길이 5 m (직진 줄기 · 좌 · 우 가지) */
  arrow(M, ln, s, mv, col) {
    const p = ln.at(s), c = Math.cos(p.h), sn = Math.sin(p.h), z = 0.014;
    const P = (a, b) => [p.x + c * a - sn * b, p.y + sn * a + c * b, z];   // a 앞 · b 왼쪽
    M.quad(P(-2.5, -0.13), P(mv.includes('S') ? 0.9 : -0.3, -0.13), P(mv.includes('S') ? 0.9 : -0.3, 0.13), P(-2.5, 0.13), col);
    if (mv.includes('S')) M.tri(P(0.9, -0.55), P(2.5, 0), P(0.9, 0.55), col);
    for (const [k, sg] of [['L', 1], ['R', -1]]) {
      if (!mv.includes(k)) continue;
      M.quad(P(-0.6, 0.13 * sg), P(-0.3, 0.13 * sg), P(-0.3, 1.05 * sg), P(-0.6, 1.05 * sg), col);
      M.tri(P(-1.1, 1.05 * sg), P(0.2, 1.05 * sg), P(-0.45, 1.85 * sg), col);
    }
  },
  /** 진입로 sd 의 신호등 — 건너편 오른쪽 모퉁이 */
  signalMast(M, I, sd) {
    const L = I.inL[sd], C = this.C, h = C.half, n = C.n;
    const fx = L.dx, fy = L.dy, rx = fy, ry = -fx;
    const base = (a, b) => [I.x + fx * a + rx * b, I.y + fy * a + ry * b];
    const [px, py] = base(h + 2.2, h + 1.0);
    M.box(px - 0.14, py - 0.14, 0.15, px + 0.14, py + 0.14, 6.4, CCOL.pole, 0, true);
    const off = CITY.MED + CITY.LW * n / 2, [hx, hy] = base(h + 2.2, off);
    // 팔 (기둥 → 등 바깥 끝)
    const [ex, ey] = base(h + 2.2, off - 1.1);
    M.box(Math.min(px, ex) - 0.07, Math.min(py, ey) - 0.07, 6.05, Math.max(px, ex) + 0.07, Math.max(py, ey) + 0.07, 6.2, CCOL.pole, 0, false);
    // 등 상자 — 가로로 네 알 (적 · 황 · 좌회전 · 녹), 차가 오는 쪽(-f)을 본다
    const ax = Math.abs(rx) * 0.98 + Math.abs(fx) * 0.17, ay = Math.abs(ry) * 0.98 + Math.abs(fy) * 0.17;
    M.box(hx - ax, hy - ay, 5.55, hx + ax, hy + ay, 6.05, CCOL.head, 0, false);
    const lampsAt = [];
    for (let q = 0; q < 4; q++) {
      const u = -0.69 + 0.46 * q;                   // 운전자 기준 왼쪽 → 오른쪽
      const lx = hx + rx * u - fx * 0.18, ly = hy + ry * u - fy * 0.18;
      lampsAt.push([lx, ly, 5.8]);
      const P = (a, b) => [lx + rx * a, ly + ry * a, 5.8 + b];
      M.quad(P(-0.17, -0.17), P(0.17, -0.17), P(0.17, 0.17), P(-0.17, 0.17), CCOL.lampOff);
    }
    this.heads.push({ I, sd, f: [fx, fy], r: [rx, ry], lamps: lampsAt });
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
    gl.uniform4f(Lc.fog, fg[0], fg[1], fg[2], 380);
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
    const C = this.C, sim = this.sim;
    Render.pal = { amb: 1, haze: '#b8c4cf' };
    Render.drawDist = 5000;
    Render.setup(ctx, W, H, cam);
    if (Render.gl) { ctx.clearRect(0, 0, W, H); Render.glBegin(); }
    this.sky(opt.skyCtx || ctx, W, H);
    this.dn = 0;
    const em = { quad: (a, b, c, d, s) => this.dquad(a, b, c, d, s) };
    const t = sim.time;
    // 차
    for (const v of sim.cars) {
      if (v === opt.hide) continue;
      const dist = Render.depth(v.x, v.y, 1);
      if (dist < -8 || dist > 2200) continue;
      if (dist < 260) {                               // 그림자
        Render.layer = 3; ctx.globalAlpha = 0.33;
        const ch = Math.cos(v.h), sh = Math.sin(v.h), hl = v.len * 0.5, hw = v.wid * 0.5;
        Render.begin();
        for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) Render.add(v.x + ch * hl * a - sh * hw * b, v.y + sh * hl * a + ch * hw * b, 0.03);
        Render.fill('#000000');
        ctx.globalAlpha = 1; Render.layer = 0;
      }
      carMesh(em, v, v.x, v.y, 0, v.h, 0, 0, dist < 240);
      if (dist < 420) this.lights(v, t, dist);
    }
    // 신호등 알
    for (const hd of this.heads) {
      const [lx, ly, lz] = hd.lamps[1];
      const dist = Render.depth(lx, ly, lz);
      if (dist < -2 || dist > 1600) continue;
      const S = sim.sig(hd.I, hd.sd, 'S'), Lt = sim.sig(hd.I, hd.sd, 'L');
      const on = [S === 'R' && Lt !== 'Y', S === 'Y' || Lt === 'Y', Lt === 'G', S === 'G'];
      const col = ['#ff3b2e', '#ffb81c', '#3df07a', '#3df07a'];
      const front = (Render.cx - lx) * -hd.f[0] + (Render.cy - ly) * -hd.f[1] > 0;
      for (let q = 0; q < 4; q++) {
        if (!on[q]) continue;
        const [x, y, z] = hd.lamps[q], rx = hd.r[0], ry = hd.r[1], o = -0.02;
        const P = (a, b) => [x + rx * a - hd.f[0] * o, y + ry * a - hd.f[1] * o, z + b];
        if (q === 2) {          // 좌회전 화살표
          em.quad(P(-0.13, -0.04), P(0.12, -0.04), P(0.12, 0.04), P(-0.13, 0.04), col[q]);
          em.quad(P(-0.15, -0.1), P(-0.15, -0.1), P(-0.15, 0.1), P(-0.04, 0), col[q]);
        } else em.quad(P(-0.15, -0.15), P(0.15, -0.15), P(0.15, 0.15), P(-0.15, 0.15), col[q]);
        if (front && dist < 900) Render.glow(x - hd.f[0] * 0.2, y - hd.f[1] * 0.2, z, clamp(900 / Math.max(dist, 1), 3, 26) * Render.H / 900, col[q], col[q] + '55', PNIGHT ? 0.9 : 0.55);
      }
    }
    // 소통 지도 — 구간마다 지금 차들의 평균 속도로 (내비 지도처럼 방향마다 제 쪽에)
    if (opt.flow) this.flowMap(ctx);
    // 고른 교차로 · 고른 차의 갈 길
    if (opt.selI) this.selInt(ctx, opt.selI);
    const sv = opt.sel;
    if (sv && !sv.gone && !opt.follow) this.routeLine(ctx, sv);
    if (PNIGHT) {
      for (const [x, y, z] of this.lamps) {
        const d = Render.depth(x, y, z); if (d < 1 || d > 900) continue;
        const k = Render.H / 900;
        Render.mark(x, y, z, clamp(300 / d, 1.5, 6) * k, clamp(180 / d, 1, 3.5) * k, '#fff2cc');
        Render.glow(x, y, z - 0.2, clamp(2600 / d, 6, 60) * k, '#ffe9b0', '#ffe9b044', 0.45);
      }
    }
    if (Render.gl) { Render.preFlush = (gl, n, F) => this.drawStatic(gl, n, F); Render.glFlush(); }
  },
  /** 바닥에 붙은 띠 (반투명 덧칠) */
  band(x0, y0, x1, y1, w, z, col) {
    const L = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / L * w, ny = (x1 - x0) / L * w;
    Render.begin();
    Render.add(x0 - nx, y0 - ny, z); Render.add(x1 - nx, y1 - ny, z); Render.add(x1 + nx, y1 + ny, z); Render.add(x0 + nx, y0 + ny, z);
    Render.fill(col);
  },
  flowMap(ctx) {
    const C = this.C;
    ctx.globalAlpha = 0.72; Render.layer = 2;
    for (const L of C.links) {
      let n = 0, vs = 0;
      for (const ln of L.lanes) for (const c of ln.cars) { n++; vs += c.v; }
      const r = n ? vs / n / CITY.vLim : 1;
      const col = r > 0.55 ? '#2fbf71' : r > 0.3 ? '#e8c33f' : r > 0.12 ? '#f07a2e' : '#d0302c';
      const a = L.lanes[0], b = L.lanes[L.lanes.length - 1], p0 = a.at(0), p1 = a.at(a.len), q0 = b.at(0), q1 = b.at(b.len);
      const s0 = L.from ? 0 : Math.max(0, L.len - 160);
      const k0 = s0 / L.len;
      this.band((p0.x + q0.x) / 2 + (p1.x - p0.x) * k0, (p0.y + q0.y) / 2 + (p1.y - p0.y) * k0, (p1.x + q1.x) / 2, (p1.y + q1.y) / 2, CITY.LW * L.lanes.length * 0.42, 0.05, col);
    }
    for (const I of C.ints) {
      const s = C.half * 0.9;
      Render.begin(); Render.add(I.x - s, I.y - s, 0.05); Render.add(I.x + s, I.y - s, 0.05); Render.add(I.x + s, I.y + s, 0.05); Render.add(I.x - s, I.y + s, 0.05);
      ctx.globalAlpha = 0.45; Render.fill(LOS_COL[I.los]); ctx.globalAlpha = 0.72;
    }
    ctx.globalAlpha = 1; Render.layer = 0;
  },
  selInt(ctx, I) {
    const s = this.C.box + 1, k = 48;
    Render.layer = 2;
    for (let i = 0; i < k; i++) {
      const a0 = i / k * TAU, a1 = (i + 1) / k * TAU;
      Render.begin();
      Render.add(I.x + Math.cos(a0) * s, I.y + Math.sin(a0) * s, 0.06); Render.add(I.x + Math.cos(a1) * s, I.y + Math.sin(a1) * s, 0.06);
      Render.add(I.x + Math.cos(a1) * (s + 0.5), I.y + Math.sin(a1) * (s + 0.5), 0.06); Render.add(I.x + Math.cos(a0) * (s + 0.5), I.y + Math.sin(a0) * (s + 0.5), 0.06);
      Render.fill('#5fd0ff');
    }
    Render.layer = 0;
  },
  /** 고른 차의 남은 길 (300 m) — 하늘색 띠 · 목적지 표시 */
  routeLine(ctx, v) {
    Render.layer = 2; ctx.globalAlpha = 0.85;
    let left = 300;
    const pts = [];
    const take = (path, s0) => {
      const s1 = Math.min(path.len, s0 + left);
      for (let s = s0; s < s1; s += 3) pts.push(path.at(s, {}));
      pts.push(path.at(s1, {}));
      left -= s1 - s0;
    };
    // 지금 간선 → (연결로 → 다음 구간)… — 연결로 끝의 차로가 경로의 ri+1 번째 구간
    take(v.edge, v.s);
    let lane = v.edge.kind === 'conn' ? v.edge.to : null, ri = v.ri + 1;
    if (v.edge.kind === 'lane' && v.conn && left > 0) { take(v.conn, 0); lane = v.conn.to; }
    for (let hop = 0; lane && left > 0 && hop < 6; hop++) {
      take(lane, 0);
      const nx = v.route[ri + 1], I = lane.link.to;
      if (!nx || !I) break;
      let cn = I.cmap.get(lane.id + '>' + nx.id) || null;
      for (const ln of lane.link.lanes) { if (cn) break; cn = I.cmap.get(ln.id + '>' + nx.id) || null; }
      if (!cn) break;
      take(cn, 0); lane = cn.to; ri++;
    }
    for (let i = 0; i + 1 < pts.length; i++) this.band(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, 0.22, 0.07, '#5fd0ff');
    ctx.globalAlpha = 1; Render.layer = 0;
    const d = v.dest;
    if (d) {
      const p = d.zone ? d.zone.link.lanes[d.zone.link.lanes.length - 1].at(d.zone.s) : d.gate.gate;
      Render.mark(p.x, p.y, 2.5, 12, 12, '#5fd0ff');
    }
  },
  lights(v, t, dist) {
    const ch = Math.cos(v.h), sh = Math.sin(v.h), L = v.len / 2, w = v.wid * 0.38, zT = 0.82 * v.hei / 1.45;
    const px = Render.H / 720, sz = clamp(60 / Math.max(dist, 1), 1.2, 7) * px;
    const rx = v.x - ch * (L + 0.02), ry = v.y - sh * (L + 0.02);
    for (const sd of [-1, 1]) {
      const lx = rx - sh * w * sd, ly = ry + ch * w * sd;
      if (v.brake) { Render.mark(lx, ly, zT, sz * 1.3, sz * 0.7, '#ff2a1e'); if (dist < 200) Render.glow(lx, ly, zT, sz * 3, '#ff4a30', '#ff4a3055', 0.55); }
      else if (PNIGHT) Render.mark(lx, ly, zT, sz * 1.1, sz * 0.6, '#9e1d16');
      if (PNIGHT) {
        const fxp = v.x + ch * (L + 0.02) - sh * w * sd, fyp = v.y + sh * (L + 0.02) + ch * w * sd;
        Render.mark(fxp, fyp, zT * 0.82, sz * 1.2, sz * 0.6, '#fff8e0');
        Render.glow(fxp, fyp, zT * 0.82, sz * 4, '#fff4d0', '#fff4d044', 0.5);
      }
    }
    // 방향지시등 — 회전 30 m 전부터 · 차로 바꾸는 동안
    let bl = 0;
    const e = v.edge;
    if (e.kind === 'conn' && e.mv !== 'S') bl = e.mv === 'L' ? 1 : -1;
    else if (e.kind === 'lane' && v.conn && v.conn.mv !== 'S' && e.len - v.s < 30) bl = v.conn.mv === 'L' ? 1 : -1;
    else if (v.lc) bl = v.lc > 0 ? 1 : -1;
    if (bl && (Math.floor((t + (v.id % 7) * 0.13) * 1.7) & 1)) {
      for (const end of [1, -1]) {
        const ex = v.x + ch * L * end * 0.98 - sh * v.wid * 0.5 * bl, ey = v.y + sh * L * end * 0.98 + ch * v.wid * 0.5 * bl;
        Render.mark(ex, ey, zT * 0.9, sz, sz * 0.7, '#ffa825');
        if (dist < 200) Render.glow(ex, ey, zT * 0.9, sz * 3, '#ffa825', '#ffa82544', 0.5);
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
/** 구간의 도로 반폭 (중앙선 ~ 길가) */
function C_half(L) { return CITY.MED + CITY.LW * L.lanes.length; }
