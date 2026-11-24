/* =============================================================================
   pscene.js — 주차장 3D 렌더

   구조물(슬래브 · 기둥 · 벽 · 경사로 · 주차선)과 세워 둔 차는 거의 안 바뀌므로
   세계 좌표 정점을 GPU 에 한 번만 올려 두고 시점 행렬만 바꿔 그린다.
   ★ 매 프레임 JS 에서 정점을 카메라 좌표로 바꾸는 render.js 의 길로 수천 면의 구조물을
     그리면 프레임 대부분을 변환에 쓴다. 움직이는 차만 그 길(Render.fill)로 그린다.
   두 길은 같은 투영식 · 같은 깊이 버퍼를 써서 서로 정확히 가린다.
   층마다 정점 구간을 나눠 두어, 단면 보기(위층 숨김)는 그릴 구간 끝만 바꾼다.
   세워 둔 차는 면마다 정해진 칸(정점 구간)을 갖고, 차가 들고 날 때 그 칸만 고쳐 올린다.
   ========================================================================== */
'use strict';

const PCOL = {
  slab: '#a3a6a2', slabRoof: '#8f9290', slabUnder: '#979c98', ceil: '#6d716f', edge: '#7a7d7a',
  aisle: '#4e7a62', aisleRoof: '#6a6d70', aisleUnder: '#4b7560', ramp: '#868b8f', rampSide: '#9da19d',
  line: '#ecebe4', lineY: '#e2b93b', col: '#bdbdb5', colBand: '#d8b23a', wall: '#a9aaa4', wallUnder: '#8f918b',
  ground: '#6f8150', pave: '#a8a59c', asphalt: '#3f4144', curb: '#c9c6bd', lamp: '#fff7e0', plaza: '#b4ae9f',
};
const SUN = (() => { const v = [-0.45, -0.62, 0.64]; const l = Math.hypot(...v); return v.map((x) => x / l); })();

/** 면 밝기 — 열린 곳은 햇빛, 덮인 곳(지붕 아래)은 고르게 밝힌 실내 */
let PNIGHT = false;          // 야간 — 바깥면만 어둡다 (실내는 형광등)
/** 바깥 색을 밤 색으로 */
const NX = (c) => (PNIGHT ? shade(mixHex(c, '#1d2a44', 0.3), 0.36) : c);
function faceLit(nx, ny, nz, covered) {
  // covered: 0 열린 곳 · 1 지붕 아래 · 2 지하(바깥 빛 없이 형광등만 — 한 단계 어둡다)
  if (covered) return (0.70 + 0.22 * Math.max(0, nz) + 0.06 * Math.abs(nx)) * (covered === 2 ? 0.8 : 1);
  if (PNIGHT) return 0.30 + 0.06 * Math.max(0, nz);
  const d = nx * SUN[0] + ny * SUN[1] + nz * SUN[2];
  return 0.52 + 0.26 * Math.max(0, nz) + 0.42 * Math.max(0, d);
}

/* ---------- 차 메쉬 ---------- */
const PPROF = {
  mini: [[-1, 0.88, 0.34, 0.92], [-0.86, 0.97, 0.32, 1.46], [0.18, 1, 0.32, 1.52], [0.52, 0.97, 0.32, 1.02], [1, 0.88, 0.36, 0.9]],
  sedan: [[-1, 0.80, 0.30, 0.80], [-0.82, 0.96, 0.28, 0.98], [-0.48, 1, 0.27, 1.40], [0.06, 1, 0.27, 1.43], [0.36, 0.99, 0.27, 1.04], [0.76, 0.94, 0.28, 0.86], [1, 0.82, 0.32, 0.78]],
  suv: [[-1, 0.9, 0.38, 1.02], [-0.9, 0.98, 0.36, 1.62], [0.26, 1, 0.36, 1.70], [0.52, 0.98, 0.36, 1.18], [0.86, 0.95, 0.38, 1.02], [1, 0.88, 0.42, 0.96]],
  van: [[-1, 0.92, 0.36, 1.1], [-0.93, 0.98, 0.34, 1.82], [0.56, 1, 0.34, 1.86], [0.80, 0.97, 0.36, 1.26], [1, 0.9, 0.4, 1.02]],
};
const GLASS = '#232a33';
/**
 * 차 한 대를 emit.quad(a,b,c,d,col) 로 내보낸다. 모든 면을 낸다(깊이 버퍼가 가린다).
 * 반환: 쓴 사각형 수
 */
function carMesh(emit, v, x, y, z, h, p, covered, full) {
  const prof = PPROF[v.cls.key], L = v.len / 2, Wd = v.wid / 2, Hk = v.hei / (v.cls.key === 'sedan' ? 1.43 : v.cls.key === 'suv' ? 1.70 : v.cls.key === 'van' ? 1.86 : 1.52);
  const ch = Math.cos(h), sh = Math.sin(h), cp = Math.cos(p), sp = Math.sin(p);
  const fx = ch * cp, fy = sh * cp, fz = sp, lx = -sh, ly = ch, ux = -ch * sp, uy = -sh * sp, uz = cp;
  const P = (a, b, c) => [x + fx * a + lx * b + ux * c, y + fy * a + ly * b + uy * c, z + fz * a + uz * c];
  const col = v.color;
  const tone = (nx, ny, nz) => shade(col, faceLit(nx, ny, nz, covered));
  const n = prof.length - 1;
  let q = 0;
  const sideL = tone(lx, ly, 0), sideR = tone(-lx, -ly, 0);
  for (let i = 0; i < n; i++) {
    const A = prof[i], B = prof[i + 1];
    const ax = A[0] * L, bx = B[0] * L, aw = A[1] * Wd, bw = B[1] * Wd;
    const az0 = A[2] * Hk, az1 = A[3] * Hk, bz0 = B[2] * Hk, bz1 = B[3] * Hk;
    const s = (bz1 - az1) / Math.max(0.05, bx - ax), nl = 1 / Math.sqrt(1 + s * s);
    emit.quad(P(ax, -aw, az1), P(bx, -bw, bz1), P(bx, bw, bz1), P(ax, aw, az1), tone(-s * nl * fx, -s * nl * fy, nl));
    emit.quad(P(ax, aw, az0), P(bx, bw, bz0), P(bx, bw, bz1), P(ax, aw, az1), sideL);
    emit.quad(P(ax, -aw, az0), P(bx, -bw, bz0), P(bx, -bw, bz1), P(ax, -aw, az1), sideR);
    q += 3;
    if (az1 - az0 > 0.95 * Hk && bz1 - bz0 > 0.95 * Hk && full) {     // 옆유리 (캐빈)
      const gh = 0.42 * Hk;
      emit.quad(P(ax, aw + 0.012, az1 - gh), P(bx, bw + 0.012, bz1 - gh), P(bx, bw + 0.012, bz1 - 0.06), P(ax, aw + 0.012, az1 - 0.06), GLASS);
      emit.quad(P(ax, -aw - 0.012, az1 - gh), P(bx, -bw - 0.012, bz1 - gh), P(bx, -bw - 0.012, bz1 - 0.06), P(ax, -aw - 0.012, az1 - 0.06), GLASS);
      q += 2;
    }
  }
  const F = prof[n], R = prof[0];
  emit.quad(P(F[0] * L, -F[1] * Wd, F[2] * Hk), P(F[0] * L, F[1] * Wd, F[2] * Hk), P(F[0] * L, F[1] * Wd, F[3] * Hk), P(F[0] * L, -F[1] * Wd, F[3] * Hk), tone(fx, fy, 0));
  emit.quad(P(R[0] * L, -R[1] * Wd, R[2] * Hk), P(R[0] * L, R[1] * Wd, R[2] * Hk), P(R[0] * L, R[1] * Wd, R[3] * Hk), P(R[0] * L, -R[1] * Wd, R[3] * Hk), tone(-fx, -fy, 0));
  q += 2;
  if (full) {
    // 앞 · 뒷유리 — 지붕선이 가장 가파르게 오르내리는 구간
    let iB = -1, dB = 0.05, iW = -1, dW = 0.05;
    for (let i = 0; i < n; i++) {
      const d = (prof[i + 1][3] - prof[i][3]) * Hk;
      if (d > dB) { dB = d; iB = i; }
      if (-d > dW) { dW = -d; iW = i; }
    }
    for (const i of [iB, iW]) {
      if (i < 0) continue;
      const A = prof[i], B = prof[i + 1];
      emit.quad(P(A[0] * L, -A[1] * Wd * 0.86, A[3] * Hk + 0.012), P(B[0] * L, -B[1] * Wd * 0.86, B[3] * Hk + 0.012),
        P(B[0] * L, B[1] * Wd * 0.86, B[3] * Hk + 0.012), P(A[0] * L, A[1] * Wd * 0.86, A[3] * Hk + 0.012), GLASS);
      q++;
    }
    // 등화 — 뒤는 빨간 후미등, 앞은 흰 전조등 (마구리 면 바로 바깥)
    const lz0 = Math.max(R[2], F[2]) * Hk + 0.28, lz1 = lz0 + 0.14;
    for (const sd of [-1, 1]) {
      const yr = R[1] * Wd * 0.62 * sd, yf = F[1] * Wd * 0.6 * sd;
      emit.quad(P(R[0] * L - 0.012, yr - 0.2, lz0), P(R[0] * L - 0.012, yr + 0.2, lz0), P(R[0] * L - 0.012, yr + 0.2, lz1), P(R[0] * L - 0.012, yr - 0.2, lz1), '#a4241c');
      emit.quad(P(F[0] * L + 0.012, yf - 0.18, lz0), P(F[0] * L + 0.012, yf + 0.18, lz0), P(F[0] * L + 0.012, yf + 0.18, lz1), P(F[0] * L + 0.012, yf - 0.18, lz1), '#e9eef2');
      q += 2;
    }
    // 바퀴 — 바깥 면만 (차체가 위를 가린다)
    const wr = 0.33, ax2 = L * 0.62;
    for (const wx of [ax2, -ax2 * 0.98]) for (const sd of [1, -1]) {
      // 바퀴 면을 차체 옆면보다 조금 안쪽에 두면 문턱 아래로만 보여 바퀴집처럼 보인다
      const yy = (Wd - 0.13) * sd;
      emit.quad(P(wx - wr, yy, 0.03), P(wx + wr, yy, 0.03), P(wx + wr, yy, wr * 1.6), P(wx - wr, yy, wr * 1.6), '#1c1e21');
      q++;
    }
  }
  return q;
}

/* ---------- 정적 메쉬 ---------- */
class MeshB {
  constructor() { this.p = []; this.c = []; this.groups = []; this.cur = 0; }
  _v(a, col) { this.p.push(a[0], a[1], a[2]); this.c.push(col[0], col[1], col[2], col[3]); }
  quad(a, b, c, d, style) {
    const col = typeof style === 'string' ? Render.color(style) : style;
    this._v(a, col); this._v(b, col); this._v(c, col);
    this._v(a, col); this._v(c, col); this._v(d, col);
  }
  tri(a, b, c, style) { const col = typeof style === 'string' ? Render.color(style) : style; this._v(a, col); this._v(b, col); this._v(c, col); }
  /** 축 정렬 상자 (윗면 · 네 옆면 · 아랫면) */
  box(x0, y0, z0, x1, y1, z1, color, covered, noBottom) {
    const f = (nx, ny, nz) => shade(color, faceLit(nx, ny, nz, covered));
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], f(0, 0, 1));
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], f(0, -1, 0));
    this.quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], f(0, 1, 0));
    this.quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], f(-1, 0, 0));
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], f(1, 0, 0));
    if (!noBottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], shade(color, 0.55));
  }
  /** 회전된 납작한 사각형 (바닥 표시) */
  rect(cx, cy, z, h, hl, hw, style) {
    const c = Math.cos(h), s = Math.sin(h);
    const P = (a, b) => [cx + c * a - s * b, cy + s * a + c * b, z];
    this.quad(P(-hl, -hw), P(hl, -hw), P(hl, hw), P(-hl, hw), style);
  }
  mark(g) { this.groups.push({ g, start: this.p.length / 3 }); }
  done() {
    this.P = new Float32Array(this.p); this.C = new Uint8Array(this.c);
    this.n = this.P.length / 3;
    this.p = this.c = null;
  }
}

const PScene = {
  init(G, sim, night) {
    this.G = G; this.sim = sim; PNIGHT = !!night;
    this.buildStatic();
    this.buildSlots();
    this.uploaded = false;
  },

  /** 정점이 간선 위 높이로 어느 층에 속하나 */
  lvAt(z) { const G = this.G; return clamp(Math.floor((z + 0.4) / G.H + G.B), 0, G.NL - 1); },

  buildStatic() {
    const G = this.G, M = new MeshB(), H = G.H, W = G.W, D = G.D, RW = PK.RW, SL = PK.slab;
    // 묶음: -1(늘 보임) 다음 층 0..NL-1. 층마다 따로 쌓았다가 순서대로 잇는다
    const parts = [];
    for (let g = -1; g < G.NL; g++) parts.push(new MeshB());
    const part = (lv) => parts[lv + 1];
    /* --- 지면 · 도로 --- */
    const A = part(-1);
    const gz = -0.02, big = 260;
    const topUnder = G.U === 0;        // 지상 주차가 없으면 G 층 자체가 광장(지면)
    A.quad([-big, D, gz], [W + big, D, gz], [W + big, D + big, gz], [-big, D + big, gz], NX(PCOL.ground));
    A.quad([-big, -big, gz], [W + big, -big, gz], [W + big, 0, gz], [-big, 0, gz], NX(PCOL.ground));
    A.quad([-big, 0, gz], [0, 0, gz], [0, D, gz], [-big, D, gz], NX(PCOL.ground));
    A.quad([W, 0, gz], [W + big, 0, gz], [W + big, D, gz], [W, D, gz], NX(PCOL.ground));
    const ys = PK.ys;
    A.quad([-big, ys - 5.0, 0.0], [W + big, ys - 5.0, 0.0], [W + big, ys + 1.75, 0.0], [-big, ys + 1.75, 0.0], NX(PCOL.asphalt));
    A.quad([-big, ys + 1.75, 0.01], [W + big, ys + 1.75, 0.01], [W + big, -0.3, 0.01], [-big, -0.3, 0.01], NX(PCOL.pave));
    A.quad([-big, ys - 9.0, 0.01], [W + big, ys - 9.0, 0.01], [W + big, ys - 5.0, 0.01], [-big, ys - 5.0, 0.01], NX(PCOL.pave));
    for (let x = -big; x < W + big; x += 6) {    // 중앙선 (황색 실선 둘) · 차로 끝 백색
      A.quad([x, ys - 1.76, 0.02], [x + 6, ys - 1.76, 0.02], [x + 6, ys - 1.62, 0.02], [x, ys - 1.62, 0.02], NX(PCOL.lineY));
      A.quad([x, ys - 1.98, 0.02], [x + 6, ys - 1.98, 0.02], [x + 6, ys - 1.84, 0.02], [x, ys - 1.84, 0.02], NX(PCOL.lineY));
    }
    // 진입로 · 진출로 포장 + 차단기 기둥
    for (const ed of G.edges) if (ed.kind === 'entry' || ed.kind === 'exit') this.ribbon(A, ed, 0, ed.len, 1.75, 0.03, NX(PCOL.asphalt), false, () => 0.03);
    for (const ed of G.gated) {
      const q = ed.at(ed.gate.s);
      const nx = -Math.sin(q.h), ny = Math.cos(q.h);
      const bx = q.x - nx * 2.1, by = q.y - ny * 2.1;     // 진행방향 오른쪽 길가
      A.box(bx - 0.35, by - 0.35, 0, bx + 0.35, by + 0.35, 1.15, '#d7d2c4', false, true);
      A.box(bx - 0.18, by - 0.18, 1.15, bx + 0.18, by + 0.18, 1.3, '#e0a43a', false, true);
    }
    // 가로등 (도로 북쪽 보도) — 불빛은 밤에 draw() 에서
    this.lamps = [];
    for (let x = -100; x < W + 100; x += 28) {
      if (x > G.xx - 9 && x < G.xe + 9) continue;        // 진입로 앞은 비운다
      A.box(x - 0.09, ys + 2.6, 0, x + 0.09, ys + 2.78, 7.5, NX('#5b6066'), false, true);
      A.box(x - 0.09, ys + 1.0, 7.4, x + 0.09, ys + 2.78, 7.55, NX('#5b6066'), false, true);
      this.lamps.push([x, ys + 1.1, 7.35, 0]);
    }
    // 옥상 조명주 — 지상 맨 위층이 지붕 없는 주차장일 때
    const topL = G.levels[G.NL - 1];
    if (!G.mech && !topL.under && topL.park) {
      for (let x = PK.RW + 6; x < W - 2; x += 16) for (const y of [0.45, D - 0.45]) {
        part(G.NL - 1).box(x - 0.1, y - 0.1, topL.z, x + 0.1, y + 0.1, topL.z + 6, NX('#6b7076'), false, true);   // 옥상 층과 함께 숨는다
        this.lamps.push([x, y + (y < 1 ? 0.6 : -0.6), topL.z + 5.9, G.NL - 1]);
      }
    }
    // 지하 옹벽 — 숨긴 지하층 사이로 하늘이 비치지 않게 땅속 구덩이 벽은 늘 그린다
    if (G.B > 0) {
      const zb = G.levels[0].z - SL - 0.4, t = 0.4, wc = shade(PCOL.wallUnder, 0.8);
      A.box(-t, -t, zb, W + t, 0, -0.03, wc, true, true);
      A.box(-t, D, zb, W + t, D + t, -0.03, wc, true, true);
      A.box(-t, 0, zb, 0, D, -0.03, wc, true, true);
      A.box(W, 0, zb, W + t, D, -0.03, wc, true, true);
      A.quad([-t, -t, zb], [W + t, -t, zb], [W + t, D + t, zb], [-t, D + t, zb], '#3a3c3a');
    }
    // 계단 · 승강기 동 (전 층을 꿰는 탑) — 층마다 문은 그 층 묶음에
    if (G.core) {
      const c = G.core, zb = G.levels[0].z - SL, zt = G.levels[G.NL - 1].z + (G.levels[G.NL - 1].under ? 0 : 3.4);
      A.box(c.x0, c.y0 + 0.02, zb, c.x1, c.y1, zt, '#c9c3b4', false, false);
      if (PNIGHT) for (let i = 0; i < G.NL; i++) if (!G.levels[i].under) A.quad([c.x0 + 1.2, c.y1 + 0.02, G.levels[i].z + 1.0], [c.x1 - 1.2, c.y1 + 0.02, G.levels[i].z + 1.0], [c.x1 - 1.2, c.y1 + 0.02, G.levels[i].z + 2.4], [c.x0 + 1.2, c.y1 + 0.02, G.levels[i].z + 2.4], '#efe3b6');
      A.box(c.x0 - 0.1, c.y0 - 0.05, zt, c.x1 + 0.1, c.y1 + 0.1, zt + 0.25, '#a49e90', false, true);
    }
    // 길 건너 건물 몇 채 (원경)
    const rng = new RNG('bld:' + (G.cfg.seed | 0));
    for (let x = -120; x < W + 120; x += rng.range(22, 34)) {
      const w = rng.range(14, 24), d = rng.range(14, 22), h = rng.range(9, 38);
      const y0 = ys - 13 - d;
      A.box(x, y0, 0, x + w, y0 + d, h, rng.pick(['#b9b4a8', '#a7aab0', '#c4b9a6', '#9aa3a8']), false, true);
      // 길 쪽 면의 창 — 밤에는 군데군데 불이 켜진다
      for (let fz = 1.2; fz < h - 1.5; fz += 3.2) for (let fx = x + 1.2; fx < x + w - 1.6; fx += 2.6) {
        // ★ 건물 배치 난수(rng)를 여기서 뽑으면 주야를 바꿀 때 건물 모양이 달라진다 — 창은 자리 해시로
        const hh = ihash(Math.round(fx * 7.3 + fz * 131.7 + x * 17.1));
        const lit = PNIGHT && hh < 0.38;
        const wc = lit ? ['#f3d58c', '#e8e2c8', '#f6c070'][Math.floor(hh * 7.9) % 3] : NX('#5d6a78');
        A.quad([fx, y0 + d + 0.05, fz], [fx + 1.4, y0 + d + 0.05, fz], [fx + 1.4, y0 + d + 0.05, fz + 1.3], [fx, y0 + d + 0.05, fz + 1.3], wc);
        const lit2 = PNIGHT && ihash(Math.round(fx * 3.1 + fz * 57.3 + x * 5.7)) < 0.34;
        A.quad([fx, y0 - 0.05, fz], [fx + 1.4, y0 - 0.05, fz], [fx + 1.4, y0 - 0.05, fz + 1.3], [fx, y0 - 0.05, fz + 1.3], lit2 ? '#f0d28a' : NX('#5d6a78'));
      }
    }
    if (G.mech) this.mechFrame(A);          // 기계식 주차타워 — 강철 골조 (mech.js)
    else {
    /* --- 층 --- */
    for (let i = 0; i < G.NL; i++) {
      const L = G.levels[i], z = L.z, M = part(i);
      const covered = L.under ? 2 : i < G.NL - 1 ? 1 : 0;
      const plaza = topUnder && i === G.gIdx;
      const slabC = plaza ? PCOL.plaza : L.under ? PCOL.slabUnder : covered ? PCOL.slab : PCOL.slabRoof;
      const aisleC = plaza ? '#7b7a76' : L.under ? PCOL.aisleUnder : covered ? PCOL.aisle : PCOL.aisleRoof;
      const ft = faceLit(0, 0, 1, covered) / faceLit(0, 0, 1, true);
      const top = covered ? shade(slabC, covered === 2 ? 0.82 : 1) : NX(shade(slabC, plaza ? 1 : 1.05));
      // 슬래브 — 경사로 구멍을 빼고 세 판
      const rects = [[RW, 0, W, D], [0, 0, RW, G.y_rb], [0, G.y_rt, RW, D]];
      for (const [x0, y0, x1, y1] of rects) {
        M.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], top);
        if (i > 0) M.quad([x0, y0, z - SL], [x1, y0, z - SL], [x1, y1, z - SL], [x0, y1, z - SL], PCOL.ceil);
      }
      // 슬래브 옆면 (바깥 둘레)
      const sideC = shade(PCOL.edge, 0.95);
      M.quad([0, 0, z - SL], [W, 0, z - SL], [W, 0, z], [0, 0, z], sideC);
      M.quad([W, D, z - SL], [0, D, z - SL], [0, D, z], [W, D, z], sideC);
      M.quad([0, D, z - SL], [0, 0, z - SL], [0, 0, z], [0, D, z], sideC);
      M.quad([W, 0, z - SL], [W, D, z - SL], [W, D, z], [W, 0, z], sideC);
      // 통로 바닥 (에폭시) — 순환로 · 통로
      for (const ed of G.edges) {
        if (ed.level !== i || (ed.kind !== 'loop' && ed.kind !== 'aisle')) continue;
        if (ed.flatReturn) { this.ribbon(M, ed, 0, ed.len, PK.laneW / 2, 0.012, PCOL.ramp, covered); continue; }
        this.ribbon(M, ed, 0, ed.len, PK.aisle / 2, 0.012, aisleC, covered);
      }
      // 주차선 (면 양옆, 이웃과 겹치는 선은 한 번만)
      const seen = new Set();
      for (const s of G.stalls) {
        if (s.level !== i) continue;
        for (const sd of [-1, 1]) {
          const lx = s.cx + s.ax * 1.25 * sd, ly = s.cy + s.ay * 1.25 * sd;
          const key = Math.round(lx * 10) + ',' + Math.round(ly * 10);
          if (seen.has(key)) continue; seen.add(key);
          M.rect(lx, ly, z + 0.022, s.hdg, PK.stallL / 2, 0.06, PCOL.line);
        }
        // 면 앞 끝선 (통로 경계) — 짧은 끝 표시
        const fx = s.cx - s.nx * 2.45, fy = s.cy - s.ny * 2.45;
        M.rect(fx, fy, z + 0.022, s.hdg + Math.PI / 2, 1.25, 0.05, PCOL.line);
        // 전용 구획 — 바닥색과 충전기
        if (s.type === 'dis' || s.type === 'ev') {
          M.rect(s.cx, s.cy, z + 0.016, s.hdg, 2.4, 1.16, s.type === 'dis' ? '#2f5fa8' : '#2f8a55');
          // 바닥 표지 (흰 네모 안 기호 대신 단순한 흰 판)
          M.rect(s.cx - s.nx * 1.2, s.cy - s.ny * 1.2, z + 0.02, s.hdg, 0.45, 0.45, '#e8ecef');
          if (s.type === 'ev') {            // 면 안쪽 끝의 충전기
            const ex = s.cx + s.nx * 2.62, ey = s.cy + s.ny * 2.62, hw = 0.22, hd = 0.16;
            M.box(ex - (s.nx ? hd : hw), ey - (s.nx ? hw : hd), z, ex + (s.nx ? hd : hw), ey + (s.nx ? hw : hd), z + 1.45, '#e9eeea', covered, true);
            M.box(ex - (s.nx ? hd : hw) * 1.05, ey - (s.nx ? hw : hd) * 1.05, z + 1.1, ex + (s.nx ? hd : hw) * 1.05, ey + (s.nx ? hw : hd) * 1.05, z + 1.4, '#2fb36a', covered, true);
          }
        } else if (s.type === 'mini') {
          M.rect(s.cx + s.nx * 0.5, s.cy + s.ny * 0.5, z + 0.016, s.hdg, 1.9, 1.05, '#8a8452');
        }
        // 바퀴 멈춤턱
        const bx = s.cx + s.nx * 1.75, by = s.cy + s.ny * 1.75;
        M.rect(bx, by, z + 0.05, s.hdg + Math.PI / 2, 0.75, 0.09, shade('#c9c4b4', 0.9));
      }
      // 진행 화살표
      for (const a of G.arrows) if (a.level === i) this.arrow(M, a.x, a.y, z + 0.024, a.h);
      // 기둥
      for (const c of G.columns) {
        if (c.level !== i) continue;
        const h = PK.colW / 2, top = z + H - SL;
        if (i === G.NL - 1 && !L.under) continue;            // 옥상에는 기둥이 없다
        M.box(c.x - h, c.y - h, z, c.x + h, c.y + h, z + 1.0, PCOL.colBand, covered, true);
        M.box(c.x - h + 0.005, c.y - h + 0.005, z + 1.0, c.x + h - 0.005, c.y + h - 0.005, top, PCOL.col, covered, true);
      }
      // 바깥 벽 — 지하는 전고 옹벽, 지상은 난간벽
      const wallH = L.under ? H - SL : 1.1, wc = L.under ? PCOL.wallUnder : PCOL.wall, t = 0.22;
      const isG = i === G.gIdx;
      const southGaps = isG ? [[G.xx - 2.2 - (G.lanes === 2 ? 3.2 : 0), G.xe + 2.2 + (G.lanes === 2 ? 3.2 : 0)]] : [];
      if (!plaza) {
        this.wallX(M, 0, W, t / 2, z, wallH, wc, covered, southGaps);
        this.wallX(M, 0, W, D - t / 2, z, wallH, wc, covered, [[G.core.x - 0.75, G.core.x + 0.75]]);
        // 계단실 문 (북쪽 벽, 탑의 남쪽 면)
        M.quad([G.core.x - 0.7, D - 0.005, z], [G.core.x + 0.7, D - 0.005, z], [G.core.x + 0.7, D - 0.005, z + 2.15], [G.core.x - 0.7, D - 0.005, z + 2.15], '#3d5a52');
        M.quad([G.core.x - 0.35, D - 0.02, z + 2.25], [G.core.x + 0.35, D - 0.02, z + 2.25], [G.core.x + 0.35, D - 0.02, z + 2.5], [G.core.x - 0.35, D - 0.02, z + 2.5], '#2fbf62');
        M.box(0, 0, z, t, D, z + (L.under || covered ? H - SL : 1.1), wc, covered, true);
        M.box(W - t, 0, z, W, D, z + wallH, wc, covered, true);
        if (!L.under && covered) {            // 지상층 띠벽 (위층 슬래브 아래 차양)
          M.box(-0.05, -0.05, z + H - SL - 0.55, W + 0.05, 0.12, z + H - SL, shade(PCOL.wall, 0.96), covered, false);
          M.box(-0.05, D - 0.12, z + H - SL - 0.55, W + 0.05, D + 0.05, z + H - SL, shade(PCOL.wall, 0.96), covered, false);
          M.box(W - 0.12, 0, z + H - SL - 0.55, W + 0.05, D, z + H - SL, shade(PCOL.wall, 0.96), covered, false);
        }
      } else {
        // 광장 — 경사로 칸 덮개(지붕)와 낮은 화단
        M.box(0, G.y_rb - 0.2, z, RW + 0.3, G.y_rt + 0.2, z + 0.9, '#9c978b', false, true);
      }
      // 경사로 칸 벽 (주차 구역과 경계) · 두 경사로 분리벽
      if (i < G.NL - 1) {
        M.box(RW - 0.15, G.y_rb, z, RW + 0.15, G.y_rt, z + H - SL, shade(wc, 0.98), covered, true);
        M.box(3.62, G.y_rb, z - (i > 0 ? 0 : 0), 3.98, G.y_rt, z + H - SL, shade(wc, 0.92), covered, true);
      }
      // 천장 조명 (이 층 슬래브 아래 = 아래층의 천장) — 아래층이 덮여 있을 때
      if (i > 0) {
        for (const ed of G.edges) {
          if (ed.level !== i - 1 || (ed.kind !== 'loop' && ed.kind !== 'aisle')) continue;
          for (let s = 3; s < ed.len - 1; s += 7.5) {
            const q = ed.at(s);
            M.rect(q.x, q.y, z - SL - 0.04, q.h, 0.65, 0.09, PCOL.lamp);
          }
        }
      }
    }
    /* --- 경사로 --- */
    for (const ed of G.ramps) {
      // 오르내리는 구간만 따로 (평탄부는 슬래브가 덮는다)
      const z0 = ed.z[0], z1 = ed.z[ed.n - 1];
      const lvTop = this.lvAt(Math.max(z0, z1) - 0.1), lvBot = this.lvAt(Math.min(z0, z1));
      const covered = true;
      for (let k = 0; k < ed.n - 1; k++) {
        const za = ed.z[k], zb = ed.z[k + 1];
        if (Math.abs(za - zb) < 1e-4 && (Math.abs(za - z0) < 1e-3 || Math.abs(za - z1) < 1e-3)) continue;
        const g = this.lvAt(Math.min(za, zb) + 0.05);
        const M = part(g);
        const ha = ed.h[k], hb = ed.h[k + 1];
        const w = PK.laneW / 2;
        const ax = ed.x[k], ay = ed.y[k], bx = ed.x[k + 1], by = ed.y[k + 1];
        const nax = -Math.sin(ha), nay = Math.cos(ha), nbx = -Math.sin(hb), nby = Math.cos(hb);
        M.quad([ax - nax * w, ay - nay * w, za + 0.012], [bx - nbx * w, by - nby * w, zb + 0.012], [bx + nbx * w, by + nby * w, zb + 0.012], [ax + nax * w, ay + nay * w, za + 0.012], shade(PCOL.ramp, faceLit(0, -Math.sign(zb - za) * 0.15, 1, true) / faceLit(0, 0, 1, true)));
        M.quad([ax - nax * w, ay - nay * w, za - 0.3], [bx - nbx * w, by - nby * w, zb - 0.3], [bx + nbx * w, by + nby * w, zb - 0.3], [ax + nax * w, ay + nay * w, za - 0.3], PCOL.ceil);
        for (const sd of [-1, 1]) {      // 측벽 연석
          const pa = [ax + nax * w * sd, ay + nay * w * sd], pb = [bx + nbx * w * sd, by + nby * w * sd];
          M.quad([pa[0], pa[1], za - 0.3], [pb[0], pb[1], zb - 0.3], [pb[0], pb[1], zb + 0.25], [pa[0], pa[1], za + 0.25], shade(PCOL.rampSide, 0.85));
          M.quad([pa[0], pa[1], za + 0.25], [pb[0], pb[1], zb + 0.25], [pb[0] + nbx * 0.15 * sd, pb[1] + nby * 0.15 * sd, zb + 0.25], [pa[0] + nax * 0.15 * sd, pa[1] + nay * 0.15 * sd, za + 0.25], PCOL.rampSide);
        }
        if ((k % 4) === 0) {           // 미끄럼 방지 홈 (가로 줄)
          M.quad([ax - nax * w * 0.9, ay - nay * w * 0.9, za + 0.02], [ax - nax * w * 0.9 + Math.cos(ha) * 0.12, ay - nay * w * 0.9 + Math.sin(ha) * 0.12, za + 0.02],
            [ax + nax * w * 0.9 + Math.cos(ha) * 0.12, ay + nay * w * 0.9 + Math.sin(ha) * 0.12, za + 0.02], [ax + nax * w * 0.9, ay + nay * w * 0.9, za + 0.02], shade(PCOL.ramp, 0.86));
        }
      }
      // 경사로 칸 평탄부의 차로 표시 (방향 화살표)
      for (const s of [3, ed.len - 3]) {
        const q = ed.at(s);
        if (Math.abs(q.y - G.yt) < 3.5 || Math.abs(q.y - G.yb) < 3.5) continue;
        this.arrow(part(this.lvAt(q.z)), q.x, q.y, q.z + 0.03, q.h);
      }
    }
    }
    // 잇기
    const all = new MeshB();
    const starts = [];
    for (let g = 0; g < parts.length; g++) {
      starts.push(all.p.length / 3);
      for (let k = 0; k < parts[g].p.length; k++) all.p.push(parts[g].p[k]);
      for (let k = 0; k < parts[g].c.length; k++) all.c.push(parts[g].c[k]);
    }
    starts.push(all.p.length / 3);
    all.done();
    this.mesh = all; this.gStart = starts;      // 묶음 g(-1..) 은 [starts[g+1], starts[g+2])
  },
  /** 간선을 따라 폭 2w 의 띠 */
  ribbon(M, ed, s0, s1, w, dz, color, covered, zf) {
    const k0 = Math.max(0, Math.floor(s0 / ed.step)), k1 = Math.min(ed.n - 1, Math.ceil(s1 / ed.step));
    const c = shade(color, faceLit(0, 0, 1, covered) / faceLit(0, 0, 1, true) * (covered ? 1 : 0.92));
    for (let k = k0; k < k1; k++) {
      const ha = ed.h[k], hb = ed.h[k + 1];
      const za = (zf ? zf() : ed.z[k]) + dz, zb = (zf ? zf() : ed.z[k + 1]) + dz;
      const nax = -Math.sin(ha), nay = Math.cos(ha), nbx = -Math.sin(hb), nby = Math.cos(hb);
      M.quad([ed.x[k] - nax * w, ed.y[k] - nay * w, za], [ed.x[k + 1] - nbx * w, ed.y[k + 1] - nby * w, zb],
        [ed.x[k + 1] + nbx * w, ed.y[k + 1] + nby * w, zb], [ed.x[k] + nax * w, ed.y[k] + nay * w, za], c);
    }
  },
  arrow(M, x, y, z, h) {
    const c = Math.cos(h), s = Math.sin(h);
    const P = (a, b) => [x + c * a - s * b, y + s * a + c * b, z];
    M.quad(P(-1.4, -0.11), P(0.3, -0.11), P(0.3, 0.11), P(-1.4, 0.11), PCOL.line);
    M.tri(P(0.3, -0.42), P(1.25, 0), P(0.3, 0.42), PCOL.line);
  },
  wallX(M, x0, x1, y, z, h, col, covered, gaps) {
    let segs = [[x0, x1]];
    for (const [g0, g1] of gaps) {
      const out = [];
      for (const [a, b] of segs) { if (g1 <= a || g0 >= b) out.push([a, b]); else { if (g0 > a) out.push([a, g0]); if (g1 < b) out.push([g1, b]); } }
      segs = out;
    }
    for (const [a, b] of segs) M.box(a, y - 0.11, z, b, y + 0.11, z + h, col, covered, true);
  },

  /* ---------- 세워 둔 차 칸 ---------- */
  buildSlots() {
    const G = this.G;
    this.SLOT = 40 * 6;          // 차 한 대 최대 사각형 수 × 6 정점 (등화 · 바퀴 포함)
    // 층 순서대로 칸을 둔다 — 층 구간이 이어지게
    const order = G.stalls.slice().sort((a, b) => a.level - b.level || a.id - b.id);
    this.slotOf = new Map();
    this.lvSlotEnd = new Array(G.NL).fill(0);
    order.forEach((s, k) => { this.slotOf.set(s.id, k); this.lvSlotEnd[s.level] = (k + 1); });
    for (let i = 1; i < G.NL; i++) this.lvSlotEnd[i] = Math.max(this.lvSlotEnd[i], this.lvSlotEnd[i - 1]);
    const N = order.length * this.SLOT;
    this.sP = new Float32Array(Math.max(3, N * 3)); this.sC = new Uint8Array(Math.max(4, N * 4));
    this.slotCar = new Array(order.length).fill(null);
    this.slotDirty = new Set();
    this.allSlotsDirty = true;
  },
  writeSlot(k, v) {
    const S = this.SLOT, P = this.sP, C = this.sC;
    let i = k * S;
    const end = i + S;
    if (v) {
      const lv = this.G.levels[v.stall.level];
      const covered = lv.under ? 2 : v.stall.level < this.G.NL - 1 ? 1 : 0;
      const em = {
        quad: (a, b, c, d, style) => {
          if (i + 6 > end) return;
          const col = Render.color(style);
          for (const q of [a, b, c, a, c, d]) {
            P[i * 3] = q[0]; P[i * 3 + 1] = q[1]; P[i * 3 + 2] = q[2];
            C[i * 4] = col[0]; C[i * 4 + 1] = col[1]; C[i * 4 + 2] = col[2]; C[i * 4 + 3] = 255;
            i++;
          }
        },
      };
      carMesh(em, v, v.x, v.y, v.z, v.h, 0, covered, true);
      // 그림자 (차 밑 어두운 판)
    }
    for (; i < end; i++) { P[i * 3] = P[i * 3 + 1] = P[i * 3 + 2] = 0; C[i * 4 + 3] = 0; }
  },
  syncSlots() {
    const G = this.G;
    // 면 상태와 칸 내용을 맞춘다 (바뀐 칸만)
    for (const s of G.stalls) {
      const k = this.slotOf.get(s.id);
      const v = s.car && s.car.mode === 'parked' && s.car.stall === s ? s.car : null;
      if (this.slotCar[k] !== v) { this.slotCar[k] = v; this.writeSlot(k, v); this.slotDirty.add(k); }
    }
  },

  /* ---------- GL ---------- */
  initGL(gl) {
    const VS = 'attribute vec3 p;attribute vec4 c;uniform vec3 E;uniform vec3 R;uniform vec3 U;uniform vec3 F;uniform vec2 f;uniform vec2 d;uniform vec4 fog;varying vec4 v;' +
      'void main(){vec3 q=p-E;float x=dot(q,R),y=dot(q,U),z=dot(q,F);gl_Position=vec4(x*f.x,y*f.y,d.x*z+d.y,z);' +
      'float t=clamp((z-fog.w)/400.0,0.0,0.55);v=vec4(mix(c.rgb,fog.rgb,t),c.a);}';
    const FS = 'precision mediump float;varying vec4 v;void main(){if(v.a<0.01)discard;gl_FragColor=vec4(v.rgb*v.a,v.a);}';
    const sh = (t, src) => { const o = gl.createShader(t); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    this.prog = pr;
    this.loc = {};
    for (const u of ['E', 'R', 'U', 'F', 'f', 'd', 'fog']) this.loc[u] = gl.getUniformLocation(pr, u);
    this.loc.p = gl.getAttribLocation(pr, 'p'); this.loc.c = gl.getAttribLocation(pr, 'c');
    this.buf = { sp: gl.createBuffer(), sc: gl.createBuffer(), cp: gl.createBuffer(), cc: gl.createBuffer() };
    this.gl = gl;
    this.uploaded = false;
  },
  upload() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.sp); gl.bufferData(gl.ARRAY_BUFFER, this.mesh.P, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.sc); gl.bufferData(gl.ARRAY_BUFFER, this.mesh.C, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.cp); gl.bufferData(gl.ARRAY_BUFFER, this.sP, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.cc); gl.bufferData(gl.ARRAY_BUFFER, this.sC, gl.DYNAMIC_DRAW);
    this.uploaded = true; this.slotDirty.clear();
  },
  flushSlots() {
    const gl = this.gl;
    if (!this.slotDirty.size) return;
    if (this.slotDirty.size > 40) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.cp); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sP);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.cc); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sC);
    } else {
      const S = this.SLOT;
      for (const k of this.slotDirty) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.cp); gl.bufferSubData(gl.ARRAY_BUFFER, k * S * 12, this.sP.subarray(k * S * 3, (k + 1) * S * 3));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.cc); gl.bufferSubData(gl.ARRAY_BUFFER, k * S * 4, this.sC.subarray(k * S * 4, (k + 1) * S * 4));
      }
    }
    this.slotDirty.clear();
  },
  /** Render.glFlush 가 화면을 지운 직후 부른다 */
  drawStatic(gl, n, F) {
    if (!this.prog) return;
    if (!this.uploaded) this.upload();
    this.flushSlots();
    const L = this.loc, W = gl.canvas.width, H = gl.canvas.height;
    gl.useProgram(this.prog);
    gl.uniform3f(L.E, Render.cx, Render.cy, Render.cz);
    gl.uniform3f(L.R, Render.rx, Render.ry, Render.rz);
    gl.uniform3f(L.U, Render.ux, Render.uy, Render.uz);
    gl.uniform3f(L.F, Render.fx, Render.fy, Render.fz);
    gl.uniform2f(L.f, Render.focal / (W / 2), Render.focal / (H / 2));
    gl.uniform2f(L.d, (F + n) / (F - n), -2 * F * n / (F - n));
    const fg = this.fogCol || [0.72, 0.78, 0.84];
    gl.uniform4f(L.fog, fg[0], fg[1], fg[2], 140);
    const draw = (bp, bc, first, count) => {
      if (count <= 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, bp); gl.enableVertexAttribArray(L.p); gl.vertexAttribPointer(L.p, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bc); gl.enableVertexAttribArray(L.c); gl.vertexAttribPointer(L.c, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.drawArrays(gl.TRIANGLES, first, count);
    };
    const cut = this.cut;
    const end = this.gStart[cut + 2];
    draw(this.buf.sp, this.buf.sc, 0, end);
    const sEnd = this.lvSlotEnd[cut] * this.SLOT;
    draw(this.buf.cp, this.buf.cc, 0, sEnd);
    gl.disableVertexAttribArray(L.p); gl.disableVertexAttribArray(L.c);
  },

  /* ---------- 프레임 ---------- */
  draw(ctx, W, H, cam, opt) {
    const G = this.G, sim = this.sim;
    Render.pal = { amb: 1, haze: '#b8c4cf' };
    Render.drawDist = 5000;
    Render.setup(ctx, W, H, cam);
    this.cut = opt.cut;
    this.syncSlots();
    if (Render.gl) { ctx.clearRect(0, 0, W, H); Render.glBegin(); }
    this.sky(opt.skyCtx || ctx, W, H, cam);
    const zCut = G.levels[opt.cut].z + G.H * 0.98;
    const em = { quad: (a, b, c, d, style) => { Render.begin(); Render.add(a[0], a[1], a[2]); Render.add(b[0], b[1], b[2]); Render.add(c[0], c[1], c[2]); Render.add(d[0], d[1], d[2]); Render.fill(style); } };
    for (const v of sim.cars) {
      if (v.mode === 'parked' || v.mode === 'done' || v === opt.hide) continue;
      if (v.z > zCut - 0.6) continue;
      const dist = Render.depth(v.x, v.y, v.z);
      if (dist < -6 || dist > 900) continue;
      const lv = this.lvAt(v.z);
      const covered = G.levels[lv].under ? 2 : lv < G.NL - 1 ? 1 : 0;
      // 그림자
      Render.layer = 3; ctx.globalAlpha = 0.35;
      const ch = Math.cos(v.h), sh = Math.sin(v.h), hl = v.len * 0.5, hw = v.wid * 0.5;
      Render.begin();
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) Render.add(v.x + ch * hl * a - sh * hw * b, v.y + sh * hl * a + ch * hw * b, v.z + 0.03 + Math.tan(v.p) * hl * a);
      Render.fill('#000000');
      ctx.globalAlpha = 1; Render.layer = 0;
      carMesh(em, v, v.x, v.y, v.z, v.h, v.p, covered, dist < 260);
      this.lights(v, opt.time, dist);
      if (v === opt.sel && !opt.follow) this.selMark(v);
    }
    if (G.mech) this.mechLifts(em, opt.dt);
    // 선택한 차의 앞으로 갈 길 (80 m) — 바닥에 가는 하늘색 띠
    const sv = opt.sel;
    if (sv && sv.mode === 'drive' && sv.route && !opt.follow) {
      Render.layer = 2; ctx.globalAlpha = 0.8;
      let left = 80, first = true;
      for (let i = sv.ri; i < sv.route.length && left > 0; i++) {
        const e = sv.route[i], s0 = first ? sv.s : 0, s1 = Math.min(e.len, s0 + left);
        first = false;
        for (let s = s0; s < s1 - 0.2; s += 1.5) {
          const a = e.at(s), b = e.at(Math.min(s1, s + 1.5)), w = 0.16;
          const na = [-Math.sin(a.h) * w, Math.cos(a.h) * w], nb = [-Math.sin(b.h) * w, Math.cos(b.h) * w];
          Render.begin();
          Render.add(a.x - na[0], a.y - na[1], a.z + 0.06); Render.add(b.x - nb[0], b.y - nb[1], b.z + 0.06);
          Render.add(b.x + nb[0], b.y + nb[1], b.z + 0.06); Render.add(a.x + na[0], a.y + na[1], a.z + 0.06);
          Render.fill('#5fd0ff');
        }
        left -= s1 - s0;
      }
      if (sv.stall && sv.stall.cx != null) Render.mark(sv.stall.cx, sv.stall.cy, sv.stall.z + 0.5, 10, 10, '#5fd0ff');   // 고른 · 배정된 면
      ctx.globalAlpha = 1; Render.layer = 0;
    }
    // 사람 — 차에서 내려 계단실로, 출차할 때는 계단실에서 차로
    for (const p of sim.peds) {
      if (p.delay > 0 || p.z > zCut - 0.6) continue;
      const dist = Render.depth(p.x, p.y, p.z);
      if (dist < 0.5 || dist > 260) continue;
      this.person(em, p, dist);
    }
    // 세워 둔 차 중 나가려는 차 (깜빡이)
    for (const v of sim.cars) {
      if (v.mode !== 'parked' || !v.leaving || v.z > zCut) continue;
      this.lights(v, opt.time, Render.depth(v.x, v.y, v.z));
      if (v === opt.sel) this.selMark(v);
    }
    if (opt.sel && opt.sel.mode === 'parked' && !opt.sel.leaving) this.selMark(opt.sel);
    // 차단기 막대
    for (const ed of G.gated) {
      const g = ed.gate;
      g.lift = approach(g.lift || 0, g.open ? 1 : 0, 0.35, opt.dt || 0.016);
      const q = ed.at(g.s), nx = -Math.sin(q.h), ny = Math.cos(q.h);
      const bx = q.x - nx * 2.1, by = q.y - ny * 2.1, a = g.lift * 1.45;
      const L = 3.6, ex = bx + nx * L * Math.cos(a), ey = by + ny * L * Math.cos(a), ez = 1.05 + L * Math.sin(a);
      em.quad([bx, by, 1.0], [ex, ey, ez - 0.05], [ex, ey, ez + 0.07], [bx, by, 1.12], '#f2f2ee');
      for (let k = 1; k < 4; k += 2) {
        const t0 = k / 4, t1 = (k + 1) / 4;
        const P = (t, dz) => [bx + (ex - bx) * t, by + (ey - by) * t, 1.0 + (ez - 1.05) * t + dz];
        Render.layer = 1; em.quad(P(t0, -0.005), P(t1, -0.005), P(t1, 0.125), P(t0, 0.125), '#d8342c'); Render.layer = 0;
      }
      if (g.busy || g.full) Render.glow(bx, by, 1.32, 10, g.full ? '#ff3b30' : '#ffb340', '#ffb34055', 0.9);
    }
    // 탐색 열지도 — 빈 자리를 찾는 차가 머문 시간 (보이는 맨 위층, 층 안 최댓값 기준)
    if (opt.heat) {
      const eds = G.edges.filter((e) => e.level === opt.cut && (e.kind === 'loop' || e.kind === 'aisle'));
      let mx = 0; for (const e of eds) mx = Math.max(mx, (e.hunt || 0) / Math.max(10, e.len));
      if (mx > 0) {
        ctx.globalAlpha = 0.62; Render.layer = 2;
        for (const e of eds) {
          const f = (e.hunt || 0) / Math.max(10, e.len) / mx;
          if (f < 0.02) continue;
          const col = f < 0.5 ? mixHex('#2e9e5b', '#f9c825', f * 2) : mixHex('#f9c825', '#e2392c', (f - 0.5) * 2);
          const k = Math.max(1, Math.round(1.5 / e.step)), w = 2.4;
          for (let i = 0; i < e.n - 1; i += k) {
            const j = Math.min(e.n - 1, i + k);
            const na = [-Math.sin(e.h[i]) * w, Math.cos(e.h[i]) * w], nb = [-Math.sin(e.h[j]) * w, Math.cos(e.h[j]) * w];
            Render.begin();
            Render.add(e.x[i] - na[0], e.y[i] - na[1], e.z[i] + 0.04); Render.add(e.x[j] - nb[0], e.y[j] - nb[1], e.z[j] + 0.04);
            Render.add(e.x[j] + nb[0], e.y[j] + nb[1], e.z[j] + 0.04); Render.add(e.x[i] + na[0], e.y[i] + na[1], e.z[i] + 0.04);
            Render.fill(col);
          }
        }
        ctx.globalAlpha = 1; Render.layer = 0;
      }
    }
    // 빈 면 표시등 (유도 시스템) — 보이는 맨 위층만
    if (opt.guide) {
      for (const s of G.stalls) {
        if (s.level !== opt.cut) continue;
        const ok = s.state === 'free';
        Render.mark(s.cx - s.nx * 2.3, s.cy - s.ny * 2.3, s.z + G.H - 0.55, 5, 5, ok ? '#38e07a' : s.state === 'res' ? '#f0c040' : '#ff4433');
      }
    }
    if (PNIGHT) {
      for (const [x, y, z, lv] of this.lamps) {
        if (lv > opt.cut) continue;
        Render.mark(x, y, z, 6, 3, '#fff2cc');
        Render.glow(x, y, z - 0.1, 70 * Render.H / 900, '#ffe9b0', '#ffe9b044', 0.55);
      }
    }
    this.dark = PNIGHT;
    if (Render.gl) { Render.preFlush = (gl, n, F) => this.drawStatic(gl, n, F); Render.glFlush(); }
  },
  /** 회전한 상자 (윗면 + 네 옆면) */
  obox(em, cx, cy, z0, h, hl, hw, hh, col) {
    const c = Math.cos(h), s = Math.sin(h);
    const P = (a, b, z) => [cx + c * a - s * b, cy + s * a + c * b, z];
    const z1 = z0 + hh;
    const f = (nx, ny, nz) => shade(col, faceLit(nx, ny, nz, true));
    em.quad(P(-hl, -hw, z1), P(hl, -hw, z1), P(hl, hw, z1), P(-hl, hw, z1), f(0, 0, 1));
    em.quad(P(hl, -hw, z0), P(hl, hw, z0), P(hl, hw, z1), P(hl, -hw, z1), f(c, s, 0));
    em.quad(P(-hl, hw, z0), P(-hl, -hw, z0), P(-hl, -hw, z1), P(-hl, hw, z1), f(-c, -s, 0));
    em.quad(P(-hl, hw, z0), P(hl, hw, z0), P(hl, hw, z1), P(-hl, hw, z1), f(-s, c, 0));
    em.quad(P(hl, -hw, z0), P(-hl, -hw, z0), P(-hl, -hw, z1), P(hl, -hw, z1), f(s, -c, 0));
  },
  person(em, p, dist) {
    const k = p.hei / 1.72, sw = Math.sin(p.ph) * 0.17, c = Math.cos(p.h), s = Math.sin(p.h);
    const z = p.z + 0.01;
    if (dist < 120) {
      for (const sd of [-1, 1]) {      // 다리 — 걸음에 맞춰 앞뒤로
        const off = sw * sd;
        this.obox(em, p.x + c * off - s * 0.09 * sd, p.y + s * off + c * 0.09 * sd, z, p.h, 0.07, 0.065, 0.82 * k, p.pants);
      }
    } else this.obox(em, p.x, p.y, z, p.h, 0.08, 0.15, 0.82 * k, p.pants);
    this.obox(em, p.x, p.y, z + 0.82 * k, p.h, 0.11, 0.2, 0.6 * k, p.shirt);
    this.obox(em, p.x + c * 0.01, p.y + s * 0.01, z + 1.46 * k, p.h, 0.1, 0.09, 0.24 * k, '#d9b48f');
  },
  selMark(v) {
    const r = Math.max(v.len, 3) * 0.62;
    Render.layer = 2;
    const P = (a, rr) => [v.x + Math.cos(a) * rr, v.y + Math.sin(a) * rr, v.z + 0.04];
    const k = 28;
    for (let i = 0; i < k; i++) {
      const a0 = i / k * TAU, a1 = (i + 1) / k * TAU;
      const A = P(a0, r), B = P(a1, r), C = P(a1, r + 0.12), D = P(a0, r + 0.12);
      Render.begin(); Render.add(...A); Render.add(...B); Render.add(...C); Render.add(...D); Render.fill('#5fd0ff');
    }
    Render.layer = 0;
  },
  lights(v, t, dist) {
    if (dist > 400) return;
    const ch = Math.cos(v.h), sh = Math.sin(v.h), L = v.len / 2, w = v.wid * 0.38;
    const zT = 0.82 * v.hei / 1.45;
    const rx = v.x - ch * (L + 0.02), ry = v.y - sh * (L + 0.02);
    const px = Render.H / 720, sz = clamp(60 / Math.max(dist, 1), 1.2, 7) * px;
    for (const sd of [-1, 1]) {
      const lx = rx - sh * w * sd, ly = ry + ch * w * sd;
      Render.mark(lx, ly, v.z + zT, sz * 1.3, sz * 0.7, v.brake ? '#ff2a1e' : '#8e1a15');
      if (v.brake) Render.glow(lx, ly, v.z + zT, sz * 3.2, '#ff4a30', '#ff4a3055', 0.6);
      if (v.rev) { Render.mark(rx - sh * w * 0.5 * sd, ry + ch * w * 0.5 * sd, v.z + zT - 0.1, sz, sz * 0.6, '#f4f4ff'); Render.glow(rx - sh * w * 0.5 * sd, ry + ch * w * 0.5 * sd, v.z + zT - 0.1, sz * 3, '#ffffff', '#ffffff44', 0.5); }
      // 전조등 (지하 · 덮인 층에서는 늘 켠다)
      const fxp = v.x + ch * (L + 0.02) - sh * w * sd, fyp = v.y + sh * (L + 0.02) + ch * w * sd;
      Render.mark(fxp, fyp, v.z + zT * 0.82, sz * 1.2, sz * 0.6, '#fff8e0');
      if (this.dark) Render.glow(fxp, fyp, v.z + zT * 0.82, sz * 4, '#fff4d0', '#fff4d044', 0.55);
    }
    const bl = v.blink || (v.mode === 'drive' ? v.tblink : 0);
    if (bl && (Math.floor((t + v.blinkPhase) * 1.7) & 1)) {
      const sides = bl === 2 ? [1, -1] : [bl];       // 2 = 비상등 (양쪽)
      for (const bs of sides) for (const end of [1, -1]) {
        const bl = bs;
        const ex = v.x + ch * L * end * 0.98 - sh * v.wid * 0.5 * bl, ey = v.y + sh * L * end * 0.98 + ch * v.wid * 0.5 * bl;
        Render.mark(ex, ey, v.z + zT * 0.9, sz, sz * 0.7, '#ffa825');
        Render.glow(ex, ey, v.z + zT * 0.9, sz * 3, '#ffa825', '#ffa82544', 0.5);
      }
    }
  },
  sky(ctx, W, H, cam) {
    const G = this.G;
    // 카메라가 덮인 층 안(지하 · 위층 슬래브 아래)에 있으면 먼 곳은 어둑한 실내색으로 흐린다
    const inside = cam.x > 0 && cam.x < G.W && cam.y > 0 && cam.y < G.D && cam.z < G.levels[G.NL - 1].z + 0.2 &&
      (cam.z < -0.2 || this.lvAt(cam.z) < G.NL - 1);
    if (inside) {
      ctx.fillStyle = '#4a4f4c'; ctx.fillRect(0, 0, W, H);
      this.fogCol = cam.z < 0 ? [0.29, 0.31, 0.30] : [0.55, 0.58, 0.57];
      return;
    }
    const g = ctx.createLinearGradient(0, 0, 0, H);
    if (PNIGHT) { g.addColorStop(0, '#04070f'); g.addColorStop(0.6, '#0d1628'); g.addColorStop(1, '#1a2336'); this.fogCol = [0.07, 0.09, 0.14]; }
    else { g.addColorStop(0, '#6f9ccc'); g.addColorStop(0.55, '#c6d6e4'); g.addColorStop(1, '#d9e0e4'); this.fogCol = [0.78, 0.84, 0.89]; }
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  },
};
