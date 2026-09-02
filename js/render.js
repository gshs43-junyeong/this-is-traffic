/* =============================================================================
   render.js — 원근 투영 기반 도로 렌더러

   도로 중심선은 실제 3차원 좌표(X, Y, 계획고 Z)로 만들어져 있으므로,
   흔한 의사 3D(가짜 곡률 누적) 대신 진짜 카메라 변환으로 그린다.
   덕분에 평면곡선·종단곡선·편경사가 화면에서 서로 어긋나지 않는다.

   그리는 순서는 화가 알고리즘 — 먼 스트립부터 그리고, 각 스트립에 속한
   차량을 그 자리에서 함께 그린다. 그래야 언덕 너머의 차가 언덕에 가려진다.
   ========================================================================== */
'use strict';

const SKY = {
  day: { top: '#5b93cc', bot: '#c9dced', haze: '#b7cbdc', amb: 1.00, sun: 0.95, road: '#4a4a4d', grass: '#5f7a44', rock: '#7d766a', water: '#3f6b86' },
  dusk: { top: '#22345f', bot: '#e0895a', haze: '#8d7b78', amb: 0.66, sun: 0.55, road: '#3a3a3f', grass: '#4a5c39', rock: '#645d55', water: '#385668' },
  night: { top: '#050912', bot: '#101a2c', haze: '#141d31', amb: 0.30, sun: 0.10, road: '#26262b', grass: '#26301f', rock: '#33302c', water: '#1b2a38' },
};

const Render = {
  ctx: null, W: 0, H: 0,
  fov: 58 * Math.PI / 180,
  drawDist: 1100,
  quality: 1,

  /* ---------- 카메라 ---------- */
  setup(ctx, W, H, cam) {
    this.ctx = ctx; this.W = W; this.H = H;
    this.cx = cam.x; this.cy = cam.y; this.cz = cam.z;
    const yaw = cam.yaw, pit = cam.pitch, rol = cam.roll || 0;
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pit), sp = Math.sin(pit);
    this.fx = cyw * cp; this.fy = syw * cp; this.fz = sp;          // 시선
    let rx = syw, ry = -cyw, rz = 0;                                // 오른쪽
    let ux = -cyw * sp, uy = -syw * sp, uz = cp;                    // 위
    if (rol) {                                                       // 편경사에 따른 롤
      const cr = Math.cos(rol), sr = Math.sin(rol);
      const nrx = rx * cr + ux * sr, nry = ry * cr + uy * sr, nrz = rz * cr + uz * sr;
      ux = ux * cr - rx * sr; uy = uy * cr - ry * sr; uz = uz * cr - rz * sr;
      rx = nrx; ry = nry; rz = nrz;
    }
    this.rx = rx; this.ry = ry; this.rz = rz;
    this.ux = ux; this.uy = uy; this.uz = uz;
    this.focal = (H / 2) / Math.tan(this.fov / 2);
    this.horizon = H / 2 + this.focal * Math.tan(pit);
    // 폴리곤 작업용 스크래치
    if (!this._ax) {
      this._ax = new Float64Array(64); this._ay = new Float64Array(64); this._az = new Float64Array(64);
      this._bx = new Float64Array(72); this._by = new Float64Array(72); this._bz = new Float64Array(72);
    }
    this._n = 0;
  },

  /* ---------- 폴리곤 ---------- */
  begin() { this._n = 0; },
  /** 월드 좌표 한 점을 카메라 좌표로 바꿔 쌓는다 */
  add(x, y, z) {
    const dx = x - this.cx, dy = y - this.cy, dz = z - this.cz;
    const n = this._n;
    if (n >= 64) return;
    this._ax[n] = dx * this.rx + dy * this.ry + dz * this.rz;
    this._ay[n] = dx * this.ux + dy * this.uy + dz * this.uz;
    this._az[n] = dx * this.fx + dy * this.fy + dz * this.fz;
    this._n = n + 1;
  },
  /** 근평면 클리핑 후 화면 경로를 만든다. 그릴 것이 없으면 false */
  path() {
    const NEAR = 0.55, n = this._n;
    if (n < 3) return false;
    const ax = this._ax, ay = this._ay, az = this._az;
    const bx = this._bx, by = this._by, bz = this._bz;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const zi = az[i], zj = az[j];
      const ini = zi >= NEAR, inj = zj >= NEAR;
      if (ini) { bx[m] = ax[i]; by[m] = ay[i]; bz[m] = zi; m++; }
      if (ini !== inj) {
        const t = (NEAR - zi) / (zj - zi);
        bx[m] = ax[i] + (ax[j] - ax[i]) * t;
        by[m] = ay[i] + (ay[j] - ay[i]) * t;
        bz[m] = NEAR; m++;
      }
      if (m >= 70) break;
    }
    if (m < 3) return false;
    const ctx = this.ctx, W2 = this.W / 2, H2 = this.H / 2, f = this.focal;
    ctx.beginPath();
    for (let i = 0; i < m; i++) {
      const iz = f / bz[i];
      const px = W2 + bx[i] * iz, py = H2 - by[i] * iz;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    return true;
  },
  fill(style) { if (this.path()) { this.ctx.fillStyle = style; this.ctx.fill(); } this._n = 0; },
  /** 한 점의 화면 좌표 (뒤쪽이면 null) */
  point(x, y, z) {
    const dx = x - this.cx, dy = y - this.cy, dz = z - this.cz;
    const cz = dx * this.fx + dy * this.fy + dz * this.fz;
    if (cz < 0.6) return null;
    const cxx = dx * this.rx + dy * this.ry + dz * this.rz;
    const cyy = dx * this.ux + dy * this.uy + dz * this.uz;
    const iz = this.focal / cz;
    return { x: this.W / 2 + cxx * iz, y: this.H / 2 - cyy * iz, z: cz, s: iz };
  },
  depth(x, y, z) {
    return (x - this.cx) * this.fx + (y - this.cy) * this.fy + (z - this.cz) * this.fz;
  },

  /* ---------- 안개(거리 감쇠) ---------- */
  haze(color, d) {
    const t = clamp((d - 120) / (this.drawDist * 0.95), 0, 0.88);
    return t < 0.02 ? color : mixHex(color, this.pal.haze, t);
  },
};

/* =============================================================================
   장면
   ========================================================================== */
const Scene = {
  /**
   * @param sc {road, corrA, corrB, cam, sCam, timeOfDay, weather, headlights}
   */
  draw(ctx, W, H, sc) {
    const pal = SKY[sc.timeOfDay] || SKY.day;
    Render.pal = pal;
    Render.drawDist = sc.inTunnel ? 420 : (sc.weather === 'rain' ? 780 : 1100) * Render.quality;
    Render.setup(ctx, W, H, sc.cam);
    this.sc = sc;
    this.pal = pal;
    this.road = sc.road;

    this.sky(ctx, W, H, pal, sc);
    if (!sc.inTunnel) this.hills(ctx, W, H, pal, sc);
    this.corridor(ctx, sc);
    this.overlay(ctx, W, H, sc);
  },

  /* ---------- 하늘 ---------- */
  sky(ctx, W, H, pal, sc) {
    const hy = clamp(Render.horizon, -H, H * 2);
    const g = ctx.createLinearGradient(0, Math.min(0, hy - H), 0, hy);
    g.addColorStop(0, pal.top); g.addColorStop(1, pal.bot);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, Math.max(0, hy));
    ctx.fillStyle = pal.haze; ctx.fillRect(0, Math.max(0, hy), W, H);
    if (sc.timeOfDay === 'night') {                       // 별
      const rng = new RNG(7);
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 110; i++) {
        const a = rng.next() * TAU, e = rng.next();
        const sx = ((a - sc.cam.yaw + 9 * Math.PI) % TAU) / TAU * W * 2.2 - W * 0.6;
        const sy = hy - e * hy * 0.95;
        if (sx < 0 || sx > W || sy < 0) continue;
        ctx.globalAlpha = 0.25 + rng.next() * 0.6;
        ctx.fillRect(sx, sy, 1.4, 1.4);
      }
      ctx.globalAlpha = 1;
    } else {
      // 태양
      const sun = Render.point(sc.cam.x + Math.cos(sc.sunAz) * 9000, sc.cam.y + Math.sin(sc.sunAz) * 9000, sc.cam.z + 2600);
      if (sun) {
        const gr = ctx.createRadialGradient(sun.x, sun.y, 0, sun.x, sun.y, H * 0.22);
        gr.addColorStop(0, sc.timeOfDay === 'dusk' ? '#ffd9a0' : '#ffffff');
        gr.addColorStop(0.25, sc.timeOfDay === 'dusk' ? '#ffb06a55' : '#ffffff55');
        gr.addColorStop(1, '#ffffff00');
        ctx.fillStyle = gr; ctx.fillRect(sun.x - H * 0.25, sun.y - H * 0.25, H * 0.5, H * 0.5);
      }
    }
  },

  /* ---------- 원경 산 ---------- */
  hills(ctx, W, H, pal, sc) {
    const T = this.road.terrain, cam = sc.cam;
    const layers = [[5200, 0.80], [2900, 0.62], [1500, 0.44]];
    const half = Render.fov * 0.72;
    const N = 34;
    for (let li = 0; li < layers.length; li++) {
      const D = layers[li][0], mix = layers[li][1];
      Render.begin();
      let any = false;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const a = cam.yaw - half + (2 * half) * (i / N);
        const x = cam.x + Math.cos(a) * D, y = cam.y + Math.sin(a) * D;
        const z = Math.max(T(x, y), this.road.waterZ);
        const p = Render.point(x, y, z);
        if (p) { pts.push(p); any = true; }
      }
      if (!any || pts.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, H + 10);
      for (const p of pts) ctx.lineTo(p.x, p.y);
      ctx.lineTo(pts[pts.length - 1].x, H + 10);
      ctx.closePath();
      ctx.fillStyle = mixHex(mixHex(pal.rock, pal.grass, li === 2 ? 0.55 : li === 1 ? 0.30 : 0.10), pal.haze, mix);
      ctx.fill();
    }
  },

  /* ---------- 단면 ---------- */
  /** 도로 station 에서의 횡단면 좌표 (중심선 기준 u, 오른쪽 +) */
  section(sRoad) {
    const rd = this.road, sc = this.sc;
    const g = rd.at(sRoad);
    const st = g.struct;
    const shW = st ? RoadStd.shRnarrow : RoadStd.shR;
    const A = sc.corrA, B = sc.corrB;
    const auxA = A ? A.auxWidth(A.dir > 0 ? sRoad : rd.len - sRoad) : 0;
    const auxB = B ? B.auxWidth(B.dir > 0 ? sRoad : rd.len - sRoad) : 0;
    const nA = A ? A.nLane : 3, nB = B ? B.nLane : 3;
    const m = g.med, sl = RoadStd.shL, lw = RoadStd.laneW;   // m 은 구간마다 달라진다(쌍굴 이격)
    const s = {
      g, st, sRoad,
      med: m,
      aIn: m, aLane0: m + sl,
      aOut: m + sl + lw * nA,
      aAux: m + sl + lw * (nA + auxA),
      aSh: m + sl + lw * (nA + auxA) + shW,
      bIn: -m, bLane0: -(m + sl),
      bOut: -(m + sl + lw * nB),
      bAux: -(m + sl + lw * (nB + auxB)),
      bSh: -(m + sl + lw * (nB + auxB) + shW),
      nA, nB, auxA, auxB,
    };
    const i = rd.idxOf(sRoad);
    s.dayR = Math.max(rd.dayR[i], s.aSh + 2); s.dayRz = rd.dayRz[i];
    s.dayL = -Math.max(rd.dayL[i], -s.bSh + 2); s.dayLz = rd.dayLz[i];
    s.hw = Math.max(s.aSh, -s.bSh) + 1.2;      // 산체·갱구 계산용 반폭
    // 이 단면에 램프가 걸쳐 있으면 그 경계를 적어 둔다.
    // 본선 비탈면을 여기서 끊지 않으면 비탈면이 램프를 덮어 버린다.
    s.rampR = null; s.rampL = null; s.nearIC = false;
    const AR = this.activeRamps;
    if (AR) {
      for (let i = 0; i < AR.length; i++) {
        const e = AR[i], corr = e.corr;
        const sl = corr.dir > 0 ? sRoad : corr.L - sRoad;
        const t = e.on ? (e.s - sl) : (sl - e.s);
        if (t < -260 || t > corr.rampLen + 260) continue;
        s.nearIC = true;
        // 노즈 앞뒤 여유 구간에서도 경계를 기록해 둔다. 여기서 끊지 않으면
        // 가까운 스트립의 넓은 비탈면이 저 앞의 램프를 덮어 버린다.
        const tc = clamp(t, 2, corr.rampLen);
        const inU = Math.max(corr.rampLat(tc) - 3.3, corr.outerEdge() + 0.15);
        const outU = corr.rampLat(tc) + 3.3 + 1.6;
        if (corr.dir > 0) s.rampR = { in: m + inU, out: m + outU };
        else s.rampL = { in: -(m + inU), out: -(m + outU) };
      }
    }
    return s;
  },
  /** 단면상의 월드 좌표 */
  pt(s, u, dz) {
    const g = s.g;
    const nx = Math.sin(g.hdg), ny = -Math.cos(g.hdg);
    return [g.x + nx * u, g.y + ny * u, g.z + this.road.crossZ(g, u) + (dz || 0)];
  },
  /** 노면 밖 지면 점 (고도 지정) */
  ptZ(s, u, z) {
    const g = s.g;
    const nx = Math.sin(g.hdg), ny = -Math.cos(g.hdg);
    return [g.x + nx * u, g.y + ny * u, z];
  },
  terrAt(s, u) {
    const g = s.g;
    const nx = Math.sin(g.hdg), ny = -Math.cos(g.hdg);
    return Math.max(this.road.terrain(g.x + nx * u, g.y + ny * u), this.road.waterZ);
  },

  quad(a, b, c, d, style) {
    Render.begin();
    Render.add(a[0], a[1], a[2]); Render.add(b[0], b[1], b[2]);
    Render.add(c[0], c[1], c[2]); Render.add(d[0], d[1], d[2]);
    Render.fill(style);
  },

  /* ---------- 본체 ---------- */
  corridor(ctx, sc) {
    const rd = this.road, pal = this.pal;
    const s0 = sc.sCam - 55, s1 = Math.min(rd.len, sc.sCam + Render.drawDist);
    // 스트립 station 목록 (가까울수록 촘촘)
    const stations = [];
    let s = Math.max(0, s0);
    while (s < s1) {
      stations.push(s);
      const d = Math.abs(s - sc.sCam);
      s += d < 60 ? 4 : d < 170 ? 7 : d < 380 ? 13 : d < 700 ? 26 : 42;
    }
    stations.push(Math.min(s1, rd.len - 0.01));

    // 차량을 스트립 구간별로 담는다
    const buckets = new Array(stations.length);
    const addVeh = (corr) => {
      if (!corr) return;
      for (let li = 0; li < corr.lanes.length; li++) {
        const arr = corr.lanes[li];
        for (let j = 0; j < arr.length; j++) this.bucket(buckets, stations, corr, arr[j], sc);
      }
      for (const r of corr.onRamps) for (const v of r.queue) this.bucket(buckets, stations, corr, v, sc);
      for (const o of corr.offRamps) for (const v of o.out) this.bucket(buckets, stations, corr, v, sc);
      for (const inc of corr.incidents) if (inc.veh && inc.lane < 0) this.bucket(buckets, stations, corr, inc.veh, sc);
    };
    addVeh(sc.corrA); addVeh(sc.corrB);

    // 이 프레임에 보일 램프만 미리 추린다 (스트립마다 전수 검사하면 프레임을 깎아먹는다)
    const near = [];
    for (const corr of [sc.corrA, sc.corrB]) {
      if (!corr) continue;
      const sCamL = corr.dir > 0 ? sc.sCam : corr.L - sc.sCam;
      const lo = sCamL - 420, hi = sCamL + Render.drawDist + 420;
      for (const r of corr.onRamps) if (r.s > lo && r.s - corr.rampLen < hi) near.push({ corr, s: r.s, on: 1 });
      for (const o of corr.offRamps) if (o.s + corr.rampLen > lo && o.s < hi) near.push({ corr, s: o.s, on: 0 });
    }
    this.activeRamps = near;

    // 단면 미리 계산
    const secs = new Array(stations.length);
    for (let i = 0; i < stations.length; i++) secs[i] = this.section(stations[i]);

    // 먼 곳부터
    for (let i = stations.length - 2; i >= 0; i--) {
      const a = secs[i], b = secs[i + 1];
      const d = Math.abs(stations[i] - sc.sCam);
      this.strip(ctx, a, b, d, sc);
      const bk = buckets[i];
      if (bk) {
        bk.sort((p, q) => q.d - p.d);
        for (const e of bk) this.vehicle(ctx, e.v, e.corr, sc);
      }
    }
  },

  bucket(buckets, stations, corr, v, sc) {
    const rd = this.road;
    const sRoad = corr.roadS(v.s);
    if (sRoad < stations[0] || sRoad > stations[stations.length - 1]) return;
    // 이진탐색
    let lo = 0, hi = stations.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (stations[m] <= sRoad) lo = m; else hi = m - 1; }
    const g = rd.at(sRoad);
    const u = corr.dir > 0 ? (g.med + v.u) : -(g.med + v.u);
    const nx = Math.sin(g.hdg), ny = -Math.cos(g.hdg);
    const d = Render.depth(g.x + nx * u, g.y + ny * u, g.z + 1 + (v.dz || 0));
    if (d < 0.5) return;
    (buckets[lo] || (buckets[lo] = [])).push({ v, corr, d, g, u });
  },

  /* ---------- 한 스트립 ---------- */
  strip(ctx, a, b, dist, sc) {
    const pal = this.pal, rd = this.road;
    const lod = dist < 260 ? 2 : dist < 620 ? 1 : 0;
    const tun = a.st === 2 && b.st === 2;
    const brg = a.st === 1 || b.st === 1;

    if (tun) {
      // ---- 산체 — 터널은 이 산을 뚫고 지나간다 ----
      this.mountain(ctx, a, b, dist);
    }
    if (!tun) {
      // ---- 지면 ----
      const gc = this.haze(pal.grass, dist);
      const rc = this.haze(pal.rock, dist);
      if (brg) {
        // 교량: 노면과 지면을 잇지 않고 골짜기 바닥을 그린다
        const aI = this.ptZ(a, a.aSh, this.terrAt(a, a.aSh)), bI = this.ptZ(b, b.aSh, this.terrAt(b, b.aSh));
        const aO = this.ptZ(a, a.aSh + 120, this.terrAt(a, a.aSh + 120)), bO = this.ptZ(b, b.aSh + 120, this.terrAt(b, b.aSh + 120));
        this.quad(aI, bI, bO, aO, gc);
        const aI2 = this.ptZ(a, a.bSh, this.terrAt(a, a.bSh)), bI2 = this.ptZ(b, b.bSh, this.terrAt(b, b.bSh));
        const aO2 = this.ptZ(a, a.bSh - 120, this.terrAt(a, a.bSh - 120)), bO2 = this.ptZ(b, b.bSh - 120, this.terrAt(b, b.bSh - 120));
        this.quad(aI2, bI2, bO2, aO2, gc);
      } else {
        // 비탈면 + 그 바깥 지형
        // 비탈면은 6 m 넘게 깎아낸 자리만 암반색으로 두고, 나머지는 초지로 덮는다
        const slopeCol = (dz) => this.haze(dz > 6 ? mixHex(pal.grass, pal.rock, clamp((dz - 6) / 12, 0, 0.85)) : pal.grass, dist);
        // 오른쪽 — 램프가 있으면 램프 안쪽 경계에서 멈춘다
        const rIn = (a.rampR || b.rampR) ? Math.min((a.rampR || b.rampR).in, (b.rampR || a.rampR).in) - 0.2 : null;
        const dRa = rIn != null ? Math.min(a.dayR, rIn) : a.dayR;
        const dRb = rIn != null ? Math.min(b.dayR, rIn) : b.dayR;
        const zRa = rIn != null && dRa < a.dayR ? a.g.z : a.dayRz;
        const zRb = rIn != null && dRb < b.dayR ? b.g.z : b.dayRz;
        this.quad(this.pt(a, a.aSh, 0), this.pt(b, b.aSh, 0),
          this.ptZ(b, dRb, zRb), this.ptZ(a, dRa, zRa), slopeCol(a.dayRz - a.g.z));
        if (rIn == null) {
          this.quad(this.ptZ(a, a.dayR, a.dayRz), this.ptZ(b, b.dayR, b.dayRz),
            this.ptZ(b, b.dayR + 90, this.terrAt(b, b.dayR + 90)),
            this.ptZ(a, a.dayR + 90, this.terrAt(a, a.dayR + 90)), gc);
        } else {
          // 램프 바깥쪽 지면 — 램프 노면 끝에서 다시 이어 붙인다
          const oA = (a.rampR || b.rampR).out, oB = (b.rampR || a.rampR).out;
          for (const [w0, w1] of [[2, 40], [40, 150]]) {
            this.quad(this.ptZ(a, oA + w0, this.terrAt(a, oA + w0)), this.ptZ(b, oB + w0, this.terrAt(b, oB + w0)),
              this.ptZ(b, oB + w1, this.terrAt(b, oB + w1)), this.ptZ(a, oA + w1, this.terrAt(a, oA + w1)), gc);
          }
        }

        // 왼쪽 — 반대편 차도의 램프도 같은 방식으로
        const lIn = (a.rampL || b.rampL) ? Math.max((a.rampL || b.rampL).in, (b.rampL || a.rampL).in) + 0.2 : null;
        const dLa = lIn != null ? Math.max(a.dayL, lIn) : a.dayL;
        const dLb = lIn != null ? Math.max(b.dayL, lIn) : b.dayL;
        const zLa = lIn != null && dLa > a.dayL ? a.g.z : a.dayLz;
        const zLb = lIn != null && dLb > b.dayL ? b.g.z : b.dayLz;
        this.quad(this.pt(a, a.bSh, 0), this.pt(b, b.bSh, 0),
          this.ptZ(b, dLb, zLb), this.ptZ(a, dLa, zLa), slopeCol(a.dayLz - a.g.z));
        if (lIn == null) {
          this.quad(this.ptZ(a, a.dayL, a.dayLz), this.ptZ(b, b.dayL, b.dayLz),
            this.ptZ(b, b.dayL - 90, this.terrAt(b, b.dayL - 90)),
            this.ptZ(a, a.dayL - 90, this.terrAt(a, a.dayL - 90)), gc);
        } else {
          const oA = (a.rampL || b.rampL).out, oB = (b.rampL || a.rampL).out;
          for (const [w0, w1] of [[2, 40], [40, 150]]) {
            this.quad(this.ptZ(a, oA - w0, this.terrAt(a, oA - w0)), this.ptZ(b, oB - w0, this.terrAt(b, oB - w0)),
              this.ptZ(b, oB - w1, this.terrAt(b, oB - w1)), this.ptZ(a, oA - w1, this.terrAt(a, oA - w1)), gc);
          }
        }
      }
    }

    // ---- 포장 ----
    /* 스테이션 3 m 마다 아스팔트 명도를 아주 조금 흔든다. 폴리곤을 더 쓰지 않고도
       노면이 흘러가 보여, 속도가 눈에 읽힌다 — 주행감에 가장 크게 기여하는 부분이다. */
    const cell = Math.floor(a.sRoad / 3);
    const mot = dist < 260 ? 0.94 + ihash(cell) * 0.12 : 1;
    const road = this.haze(shade(pal.road, mot), dist);
    const shoulder = this.haze(shade(pal.road, 0.86), dist);
    const median = this.haze(shade(pal.road, 0.78), dist);
    this.quad(this.pt(a, a.bIn, 0), this.pt(b, b.bIn, 0), this.pt(b, b.aIn, 0), this.pt(a, a.aIn, 0), median);
    // A 방향
    this.quad(this.pt(a, a.aIn, 0), this.pt(b, b.aIn, 0), this.pt(b, b.aAux, 0), this.pt(a, a.aAux, 0), road);
    this.quad(this.pt(a, a.aAux, 0), this.pt(b, b.aAux, 0), this.pt(b, b.aSh, 0), this.pt(a, a.aSh, 0), shoulder);
    // B 방향
    this.quad(this.pt(a, a.bIn, 0), this.pt(b, b.bIn, 0), this.pt(b, b.bAux, 0), this.pt(a, a.bAux, 0), road);
    this.quad(this.pt(a, a.bAux, 0), this.pt(b, b.bAux, 0), this.pt(b, b.bSh, 0), this.pt(a, a.bSh, 0), shoulder);

    this.rampSurf(ctx, a, b, dist, sc);
    if (lod >= 1) this.markings(ctx, a, b, dist, sc);
    this.barriers(ctx, a, b, dist, lod, brg, tun, sc);
    if (brg) this.bridge(ctx, a, b, dist);
    if (tun || a.st === 2 || b.st === 2) this.tunnel(ctx, a, b, dist, sc);
  },

  /* ---------- 램프 노면 ----------
     본선에서 갈라져 나가는 진입·진출로를 실제로 그린다.
     이게 없으면 차가 허공에서 나타나 합류하는 것처럼 보인다. */
  rampSurf(ctx, a, b, dist, sc) {
    const list = this.activeRamps;
    if (!list || !list.length) return;
    for (let i = 0; i < list.length; i++) {
      const e = list[i], corr = e.corr, L = corr.L;
      const sa = corr.dir > 0 ? a.sRoad : L - a.sRoad;
      const sb = corr.dir > 0 ? b.sRoad : L - b.sRoad;
      if (e.on) this.rampSeg(ctx, a, b, dist, corr, e.s - sa, e.s - sb, sc);
      else this.rampSeg(ctx, a, b, dist, corr, sa - e.s, sb - e.s, sc);
    }
  },
  /** 노즈로부터의 거리 ta, tb 사이의 램프 한 토막.
      노즈 부근에서는 램프가 아직 본선 갓길과 겹쳐 있으므로, 안쪽 경계를
      갓길 바깥선에 물려 두고 폭이 생기는 곳부터만 그린다. */
  rampSeg(ctx, a, b, dist, corr, ta, tb, sc) {
    const LEN = corr.rampLen;
    if ((ta < 2 && tb < 2) || (ta > LEN && tb > LEN)) return;
    const t0 = clamp(ta, 2, LEN), t1 = clamp(tb, 2, LEN);
    if (Math.abs(t0 - t1) < 0.01) return;
    const hw = 3.3, sh = 1.6, edge = corr.outerEdge() + 0.15;
    const inA = Math.max(corr.rampLat(t0) - hw, edge), outA = corr.rampLat(t0) + hw;
    const inB = Math.max(corr.rampLat(t1) - hw, edge), outB = corr.rampLat(t1) + hw;
    if (outA - inA < 0.4 && outB - inB < 0.4) return;
    const pal = this.pal;
    const road = this.haze(pal.road, dist);
    const shoulder = this.haze(shade(pal.road, 0.86), dist);
    const white = this.haze(sc.timeOfDay === 'night' ? '#e9e9e0' : '#f0f0ea', dist);
    const P = (sec, u, t) => {
      const uw = corr.dir > 0 ? (sec.g.med + u) : -(sec.g.med + u);
      const g = sec.g, nx = Math.sin(g.hdg), ny = -Math.cos(g.hdg);
      return [g.x + nx * uw, g.y + ny * uw, g.z + this.road.crossZ(g, uw) + corr.rampDz(t)];
    };
    // 포장 + 바깥 갓길
    this.quad(P(a, inA, t0), P(b, inB, t1), P(b, outB, t1), P(a, outA, t0), road);
    this.quad(P(a, outA, t0), P(b, outB, t1), P(b, outB + sh, t1), P(a, outA + sh, t0), shoulder);
    if (dist < 520) {
      for (const off of [0.22, -0.22]) {
        const iA = off > 0 ? inA + off : outA + off, iB = off > 0 ? inB + off : outB + off;
        this.quad(P(a, iA - 0.09, t0), P(b, iB - 0.09, t1), P(b, iB + 0.09, t1), P(a, iA + 0.09, t0), white);
      }
    }
    // 램프 바깥 비탈면 — 주변 지형 높이까지 자연스럽게 내린다
    const gc = this.haze(pal.grass, dist);
    const oa = corr.dir > 0 ? (a.g.med + outA + sh) : -(a.g.med + outA + sh);
    const ob = corr.dir > 0 ? (b.g.med + outB + sh) : -(b.g.med + outB + sh);
    const fa = oa + (corr.dir > 0 ? 14 : -14), fb = ob + (corr.dir > 0 ? 14 : -14);
    this.quad(P(a, outA + sh, t0), P(b, outB + sh, t1),
      this.ptZ(b, fb, this.terrAt(b, fb)), this.ptZ(a, fa, this.terrAt(a, fa)), gc);
  },

  /* ---------- 노면표시 ----------
     점선을 스트립 경계가 아니라 '실제 스테이션'에서 끊는다. 예전처럼 스트립 하나를
     통째로 칠하면 멀리서는 긴 흰 띠가 되어 속도가 전혀 읽히지 않았다. */
  markings(ctx, a, b, dist, sc) {
    const lw = RoadStd.laneW;
    const night = sc.timeOfDay === 'night';
    const white = this.haze(night ? '#eceade' : '#f2f2ec', dist);
    const dz = 0.012;
    const span = b.sRoad - a.sRoad;
    const L3 = (A, B, t) => [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)];

    /** 실선 */
    const solid = (uA, uB, w) => {
      this.quad(this.pt(a, uA - w / 2, dz), this.pt(b, uB - w / 2, dz),
        this.pt(b, uB + w / 2, dz), this.pt(a, uA + w / 2, dz), white);
    };
    /** 점선 — 칠 PAINT m + 빈 (PERIOD-PAINT) m 를 스테이션 기준으로 끊어 그린다 */
    const PERIOD = 20, PAINT = 10;
    const dash = (uA, uB, w) => {
      if (span <= 0) return;
      const iL = this.pt(a, uA - w / 2, dz), iR = this.pt(a, uA + w / 2, dz);
      const jL = this.pt(b, uB - w / 2, dz), jR = this.pt(b, uB + w / 2, dz);
      let k = Math.floor(a.sRoad / PERIOD);
      while (k * PERIOD < b.sRoad) {
        const p0 = Math.max(a.sRoad, k * PERIOD), p1 = Math.min(b.sRoad, k * PERIOD + PAINT);
        k++;
        if (p1 <= p0) continue;
        const t0 = (p0 - a.sRoad) / span, t1 = (p1 - a.sRoad) / span;
        Render.begin();
        const q0 = L3(iL, jL, t0), q1 = L3(iL, jL, t1), q2 = L3(iR, jR, t1), q3 = L3(iR, jR, t0);
        Render.add(q0[0], q0[1], q0[2]); Render.add(q1[0], q1[1], q1[2]);
        Render.add(q2[0], q2[1], q2[2]); Render.add(q3[0], q3[1], q3[2]);
        Render.fill(white);
      }
    };

    // 차도 외측선(갓길 경계)과 중앙분리대 쪽 외측선 — 실선
    solid(a.aAux, b.aAux, 0.20);
    solid(a.bAux, b.bAux, 0.20);
    solid(a.aIn + RoadStd.shL, b.aIn + RoadStd.shL, 0.18);
    solid(a.bIn - RoadStd.shL, b.bIn - RoadStd.shL, 0.18);

    // 차로 경계 — 점선
    for (let i = 1; i < a.nA + (a.auxA > 0.5 ? 1 : 0); i++) {
      const ua = a.aLane0 + lw * i, ub = b.aLane0 + lw * i;
      if (ua > a.aAux - 0.4) continue;
      dash(ua, ub, 0.15);
    }
    for (let i = 1; i < a.nB + (a.auxB > 0.5 ? 1 : 0); i++) {
      const ua = a.bLane0 - lw * i, ub = b.bLane0 - lw * i;
      if (ua < a.bAux + 0.4) continue;
      dash(ua, ub, 0.15);
    }

    if (dist > 80) return;

    // ---- 가까운 곳만: 노면 이음매 · 캣츠아이 · 갓길 요철 ----
    const seamZ = 0.006;
    // 포장 이음매 — 12 m 마다 옅은 가로줄. 값싼 광학 흐름이다
    const seamC = this.haze(shade(this.pal.road, 0.86), dist);
    let k = Math.floor(a.sRoad / 12);
    while (k * 12 < b.sRoad) {
      const ss = k * 12; k++;
      if (ss < a.sRoad || span <= 0) continue;
      const t = (ss - a.sRoad) / span;
      const wA = this.pt(a, a.aIn, seamZ), wB = this.pt(b, b.aIn, seamZ);
      const eA = this.pt(a, a.aSh, seamZ), eB = this.pt(b, b.aSh, seamZ);
      const p0 = L3(wA, wB, t), p1 = L3(eA, eB, t);
      const t2 = Math.min(1, t + 0.36 / Math.max(span, 0.5));
      const p2 = L3(eA, eB, t2), p3 = L3(wA, wB, t2);
      this.quad(p0, p1, p2, p3, seamC);
    }
    // 캣츠아이 — 차로 경계 위 16 m 간격. 야간·터널에서 특히 잘 읽힌다
    const eye = night ? '#ffe9a8' : '#dfe0d8';
    if (!night && dist > 55) return;
    let e = Math.floor(a.sRoad / 16);
    while (e * 16 < b.sRoad) {
      const ss = e * 16; e++;
      if (ss < a.sRoad || span <= 0) continue;
      const t = (ss - a.sRoad) / span;
      for (let i = 1; i < a.nA; i++) {
        const u = a.aLane0 + lw * i;
        if (u > a.aAux - 0.4) continue;
        const A = this.pt(a, u - 0.09, 0.03), B = this.pt(b, u - 0.09, 0.03);
        const C = this.pt(a, u + 0.09, 0.03), D = this.pt(b, u + 0.09, 0.03);
        const t2 = Math.min(1, t + 0.5 / Math.max(span, 0.5));
        this.quad(L3(A, B, t), L3(C, D, t), L3(C, D, t2), L3(A, B, t2), eye);
      }
    }
    // 갓길 요철 포장 — 차로를 벗어나면 이 줄무늬가 빠르게 스친다
    if (dist < 46) {
      const rum = this.haze(shade(this.pal.road, 0.72), dist);
      let r = Math.floor(a.sRoad / 2.4);
      while (r * 2.4 < b.sRoad) {
        const ss = r * 2.4; r++;
        if (ss < a.sRoad || span <= 0) continue;
        const t = (ss - a.sRoad) / span, t2 = Math.min(1, t + 0.4 / Math.max(span, 0.5));
        for (const [uA, uB] of [[a.aAux + 0.35, b.aAux + 0.35]]) {
          const A = this.pt(a, uA - 0.3, 0.008), B = this.pt(b, uB - 0.3, 0.008);
          const C = this.pt(a, uA + 0.3, 0.008), D = this.pt(b, uB + 0.3, 0.008);
          this.quad(L3(A, B, t), L3(C, D, t), L3(C, D, t2), L3(A, B, t2), rum);
        }
      }
    }
  },

  /* ---------- 방호벽·가드레일 ---------- */
  barriers(ctx, a, b, dist, lod, brg, tun, sc) {
    const h = RoadStd.barrierH, pal = this.pal;
    const top = this.haze('#c9c6bd', dist), side = this.haze('#a9a69e', dist), dark = this.haze('#8b8880', dist);
    // 중앙분리대 콘크리트 방호벽 (양면 + 윗면)
    const w = 0.28;
    this.quad(this.pt(a, -w, 0), this.pt(b, -w, 0), this.pt(b, -w, h), this.pt(a, -w, h), side);
    this.quad(this.pt(a, w, 0), this.pt(b, w, 0), this.pt(b, w, h), this.pt(a, w, h), dark);
    this.quad(this.pt(a, -w, h), this.pt(b, -w, h), this.pt(b, w, h), this.pt(a, w, h), top);

    // 바깥쪽 가드레일 — 성토가 높거나 구조물일 때
    const needR = brg || a.g.z - a.dayRz > 3.0;
    const needL = brg || a.g.z - a.dayLz > 3.0;
    const beam = this.haze('#b9b9b4', dist);
    const rail = (u) => {
      // 레일 두 줄
      this.quad(this.pt(a, u, 0.50), this.pt(b, u, 0.50), this.pt(b, u, 0.62), this.pt(a, u, 0.62), beam);
      this.quad(this.pt(a, u, 0.68), this.pt(b, u, 0.68), this.pt(b, u, 0.80), this.pt(a, u, 0.80), top);
      // 지주 — 가까운 곳에서만 4 m 간격. 스치는 기둥이 속도를 읽게 한다
      if (dist < 70 && Math.floor(a.sRoad / 4) !== Math.floor(b.sRoad / 4)) {
        const w = 0.07;
        this.quad(this.pt(a, u - w, 0), this.pt(a, u + w, 0), this.pt(a, u + w, 0.80), this.pt(a, u - w, 0.80), dark);
      }
    };
    if (needR) rail(a.aSh + 0.5);
    if (needL) rail(a.bSh - 0.5);
    // 시선유도표 (야간에 특히 눈에 띈다)
    if (lod >= 2 && dist < 220 && (Math.floor(a.sRoad / 44) !== Math.floor(b.sRoad / 44))) {
      const col = sc.timeOfDay === 'night' ? '#ffe680' : '#e8e2c8';
      const post = (u) => {
        this.quad(this.pt(a, u, 0.55), this.pt(a, u, 0.55), this.pt(a, u, 1.0), this.pt(a, u, 1.0), col);
      };
      const p1 = Render.point(...this.pt(a, a.aSh + 0.35, 0.95));
      if (p1 && p1.z < 300) { ctx.fillStyle = col; ctx.fillRect(p1.x - 1, p1.y - 2, 2.1, 3.8); }
      const p2 = Render.point(...this.pt(a, a.bSh - 0.35, 0.95));
      if (p2 && p2.z < 300) { ctx.fillStyle = col; ctx.fillRect(p2.x - 1, p2.y - 2, 2.1, 3.8); }
    }
  },

  /* ---------- 교량 ---------- */
  bridge(ctx, a, b, dist) {
    const fascia = this.haze('#b0aca4', dist), pier = this.haze('#9a968e', dist);
    // 상부 슬래브 측면
    this.quad(this.pt(a, a.aSh + 0.6, 0), this.pt(b, b.aSh + 0.6, 0), this.pt(b, b.aSh + 0.6, -2.2), this.pt(a, a.aSh + 0.6, -2.2), fascia);
    this.quad(this.pt(a, a.bSh - 0.6, 0), this.pt(b, b.bSh - 0.6, 0), this.pt(b, b.bSh - 0.6, -2.2), this.pt(a, a.bSh - 0.6, -2.2), fascia);
    // 교각 — 40 m 간격
    if (Math.floor(a.sRoad / 40) !== Math.floor(b.sRoad / 40)) {
      const gz = this.terrAt(a, 0);
      const half = 1.9;
      for (const u of [-3.2, 3.2]) {
        const p0 = this.pt(a, u - half, -2.2), p1 = this.pt(a, u + half, -2.2);
        const q0 = this.ptZ(a, u - half, gz), q1 = this.ptZ(a, u + half, gz);
        this.quad(p0, p1, q1, q0, pier);
      }
    }
  },

  /* ---------- 터널 ----------
     방향별로 떨어져 있는 두 차도를 각각 독립된 굴로 뚫는다(쌍굴).
     사이에 남는 암반이 중앙 필러다. 굴 위로는 실제 지형면을 덮어
     "산을 뚫고 지나간다"는 것이 화면에서 그대로 보이게 한다. */
  bores(sec) {
    return [[sec.aIn - 1.1, sec.aSh + 1.1], [sec.bSh - 1.1, sec.bIn + 1.1]];
  },

  /** 굴 단면의 타원 제원.
      u0~u1 은 노면 높이에서 확보해야 하는 폭. 타원은 그보다 조금 넓게 잡아
      노면 위 tunnelCz 높이에서 가장 넓어지고 정점으로 좁아지게 한다.
      갱구의 구멍도 같은 타원을 쓰므로 입구와 굴 단면이 정확히 맞물린다. */
  boreGeom(u0, u1) {
    const c = (u0 + u1) / 2, wNeed = (u1 - u0) / 2;
    const zc = RoadStd.tunnelCz, B = RoadStd.tunnelH - zc;
    const k = Math.sqrt(Math.max(1e-6, 1 - (zc / B) * (zc / B)));
    return { c, A: wNeed / k, B, zc, t0: -Math.asin(zc / B) };
  },
  /** 타원 윤곽 위의 점 (t: t0 ~ pi-t0) */
  borePt(g, t) { return [g.c - g.A * Math.cos(t), g.zc + g.B * Math.sin(t)]; },
  /** 가로 위치 u 에서 굴이 뚫려 있는 높이 구간 [아래, 위]. 굴 밖이면 null */
  boreSpan(g, u) {
    const dx = (u - g.c) / g.A;
    if (dx <= -1 || dx >= 1) return null;
    const h = g.B * Math.sqrt(1 - dx * dx);
    return [Math.max(0, g.zc - h), g.zc + h];
  },

  /** 터널 구간 위를 덮는 산 — 지형면 + 양쪽 옆구리 */
  mountain(ctx, a, b, dist) {
    const pal = this.pal;
    const hw = a.hw + 0.6, ext = 190, N = 9;
    const uL = -(hw + ext), uR = hw + ext;
    // 산등성이 표면
    for (let i = 0; i < N; i++) {
      const u0 = lerp(uL, uR, i / N), u1 = lerp(uL, uR, (i + 1) / N);
      const za0 = this.terrAt(a, u0), za1 = this.terrAt(a, u1);
      const zb0 = this.terrAt(b, u0), zb1 = this.terrAt(b, u1);
      const rise = ((za0 + za1) / 2) - a.g.z;
      const col = this.haze(rise > 24 ? mixHex(pal.grass, pal.rock, clamp((rise - 24) / 40, 0, 0.7)) : pal.grass, dist);
      this.quad(this.ptZ(a, u0, za0), this.ptZ(b, u0, zb0), this.ptZ(b, u1, zb1), this.ptZ(a, u1, za1), col);
    }
    // 옆구리 — 노면 높이에서 산등성이까지 세운 면. 굴 바깥을 막아 준다
    const flank = this.haze(mixHex(pal.rock, pal.grass, 0.35), dist);
    for (const side of [-1, 1]) {
      const u = hw * side;
      const za = Math.max(this.terrAt(a, u), a.g.z + 2), zb = Math.max(this.terrAt(b, u), b.g.z + 2);
      this.quad(this.ptZ(a, u, a.g.z - 14), this.ptZ(b, u, b.g.z - 14),
        this.ptZ(b, u, zb), this.ptZ(a, u, za), flank);
    }
  },

  tunnel(ctx, a, b, dist, sc) {
    const wall = this.haze('#5e5c56', dist * 0.3), ceil = this.haze('#403f3b', dist * 0.3);
    const bs = this.bores(a), bsB = this.bores(b);
    const N = 11;
    for (let bi = 0; bi < bs.length; bi++) {
      const ga = this.boreGeom(bs[bi][0], bs[bi][1]);
      const gb = this.boreGeom(bsB[bi][0], bsB[bi][1]);
      const ta1 = Math.PI - ga.t0, tb1 = Math.PI - gb.t0;
      let pa = this.borePt(ga, ga.t0), pb = this.borePt(gb, gb.t0);
      for (let k = 1; k <= N; k++) {
        const na = this.borePt(ga, lerp(ga.t0, ta1, k / N));
        const nb = this.borePt(gb, lerp(gb.t0, tb1, k / N));
        const mid = Math.abs(k / N - 0.5);
        this.quad(this.pt(a, pa[0], pa[1]), this.pt(b, pb[0], pb[1]),
          this.pt(b, nb[0], nb[1]), this.pt(a, na[0], na[1]), mid < 0.20 ? ceil : wall);
        pa = na; pb = nb;
      }
      if (Math.floor(a.sRoad / 25) !== Math.floor(b.sRoad / 25)) {
        const p = Render.point(...this.pt(a, ga.c, RoadStd.tunnelH - 0.35));
        if (p) {
          const rr = clamp(220 / Math.max(p.z, 2), 2, 42);
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
          g.addColorStop(0, '#fff6d0'); g.addColorStop(0.35, '#ffeaa066'); g.addColorStop(1, '#ffeaa000');
          ctx.fillStyle = g; ctx.fillRect(p.x - rr, p.y - rr, rr * 2, rr * 2);
        }
      }
    }
    if (a.st !== 2 && b.st === 2) this.portal(ctx, b, dist);
    if (a.st === 2 && b.st !== 2) this.portal(ctx, a, dist);
  },

  /** 갱구 벽면: 산 사면을 세우고 굴과 똑같은 타원 두 개만 뚫어 둔다 */
  portal(ctx, sec, dist) {
    const geos = this.bores(sec).map(b => this.boreGeom(b[0], b[1]));
    const ext = 150, base = sec.g.z - 30;
    const uL = sec.bSh - 1.1 - ext, uR = sec.aSh + 1.1 + ext;
    const N = 56;
    const face = this.haze(mixHex(this.pal.rock, this.pal.grass, 0.40), dist);
    const rim = this.haze('#b8b2a6', dist);
    for (let i = 0; i < N; i++) {
      const u0 = lerp(uL, uR, i / N), u1 = lerp(uL, uR, (i + 1) / N);
      const um = (u0 + u1) / 2;
      const t0 = Math.max(this.terrAt(sec, u0), sec.g.z + 4);
      const t1 = Math.max(this.terrAt(sec, u1), sec.g.z + 4);
      let span = null;
      for (const g of geos) { const sp = this.boreSpan(g, um); if (sp) { span = sp; break; } }
      if (!span) {
        this.quad(this.ptZ(sec, u0, base), this.ptZ(sec, u1, base),
          this.ptZ(sec, u1, t1), this.ptZ(sec, u0, t0), face);
        continue;
      }
      const lo = sec.g.z + span[0], hi = sec.g.z + span[1];
      if (span[0] > 0.02) {
        this.quad(this.ptZ(sec, u0, base), this.ptZ(sec, u1, base),
          this.ptZ(sec, u1, lo), this.ptZ(sec, u0, lo), face);
      }
      if (t0 > hi || t1 > hi) {
        this.quad(this.ptZ(sec, u0, hi), this.ptZ(sec, u1, hi),
          this.ptZ(sec, u1, Math.max(t1, hi)), this.ptZ(sec, u0, Math.max(t0, hi)), face);
      }
    }
    // 갱문 테두리 — 굴과 같은 타원을 조금 키워 두른다
    for (const g of geos) {
      const N2 = 14, t1 = Math.PI - g.t0;
      const gOut = { c: g.c, A: g.A + 1.15, B: g.B + 1.0, zc: g.zc, t0: g.t0 };
      let pa = this.borePt(g, g.t0), pb = this.borePt(gOut, g.t0);
      for (let k = 1; k <= N2; k++) {
        const t = lerp(g.t0, t1, k / N2);
        const na = this.borePt(g, t), nb = this.borePt(gOut, t);
        this.quad(this.pt(sec, pa[0], pa[1]), this.pt(sec, na[0], na[1]),
          this.pt(sec, nb[0], nb[1]), this.pt(sec, pb[0], pb[1]), rim);
        pa = na; pb = nb;
      }
    }
  },

  /* ---------- 차량 ----------
     상자 하나로는 차처럼 보이지 않는다. 길이 방향으로 몇 개의 단면을 두고
     그 사이를 이어 붙여, 보닛이 낮아지고 앞유리가 눕고 지붕이 좁아지는
     실루엣을 만든다. 거리가 멀면 단면 수를 줄인다. */

  /** 차종별 종단 실루엣 — [길이방향 x, 반폭, 바닥높이, 지붕높이] */
  profileOf(cls, p) {
    const L = p.len / 2, W = p.wid / 2;
    if (cls === 'car') {
      return [
        [-L, W * 0.80, 0.46, 0.88],
        [-L * 0.82, W * 0.96, 0.42, 1.08],
        [-L * 0.52, W * 1.00, 0.40, 1.45],
        [L * 0.02, W * 1.00, 0.40, 1.48],
        [L * 0.34, W * 0.99, 0.40, 1.26],
        [L * 0.72, W * 0.94, 0.42, 1.00],
        [L, W * 0.82, 0.48, 0.92],
      ];
    }
    if (cls === 'bus') {
      return [
        [-L, W * 0.90, 0.68, 3.24],
        [-L * 0.94, W * 1.00, 0.64, 3.38],
        [L * 0.90, W * 1.00, 0.64, 3.38],
        [L * 0.98, W * 0.94, 0.66, 3.14],
        [L, W * 0.86, 0.70, 2.84],
      ];
    }
    return null;   // 화물차는 트랙터 + 트레일러로 따로 만든다
  },

  /** 종단 실루엣을 이어 붙여 차체를 그린다.
      볼록한 형상이므로 면을 정렬할 필요 없이 "먼 쪽부터" 순서만 지키면 된다:
      길이방향은 카메라 반대쪽 끝에서부터, 좌우는 먼 쪽 옆면 -> 지붕 -> 가까운 쪽 옆면. */
  hull(ctx, cx, cy, cz, hdg, prof, color, dist, glassBand) {
    const ch = Math.cos(hdg), sh = Math.sin(hdg);
    const amb = this.pal.amb;
    const P = (x, y, z) => [cx + ch * x - sh * y, cy + sh * x + ch * y, cz + z];
    const tone = (f) => this.haze(shade(color, f * amb + (1 - amb) * 0.42), dist);
    const dx = Render.cx - cx, dy = Render.cy - cy;
    const camAhead = ch * dx + sh * dy > 0;          // 카메라가 차 앞쪽에 있는가
    const camLeft = -sh * dx + ch * dy > 0;          // 카메라가 차 왼쪽에 있는가
    const nearSign = camLeft ? 1 : -1;               // 가까운 옆면의 부호
    const farSign = -nearSign;
    const gc = glassBand ? this.haze(shade('#262b34', 0.75 * amb + 0.25), dist) : null;

    const sideQuads = (A, B, sgn) => {
      const col = tone(sgn === nearSign ? 0.78 : 0.66);
      this.quadPts(P(A[0], A[1] * sgn, A[2]), P(B[0], B[1] * sgn, B[2]),
        P(B[0], B[1] * sgn, B[3]), P(A[0], A[1] * sgn, A[3]), col);
      if (!gc) return;
      const ha = A[3] - glassBand.h, hb = B[3] - glassBand.h;
      if (A[3] - A[2] < glassBand.min || B[3] - B[2] < glassBand.min) return;
      if (ha <= A[2] + 0.06 || hb <= B[2] + 0.06) return;
      // 캐빈(지붕이 높은 구간)에만 유리를 두른다. 이 조건이 없으면 트렁크·보닛 옆면까지
      // 검게 덮여 차가 속이 빈 상자처럼 보인다.
      const top = glassBand.top || 0;
      if (A[3] < top || B[3] < top) return;
      const ea = (A[1] + 0.012) * sgn, eb = (B[1] + 0.012) * sgn;
      this.quadPts(P(A[0], ea, ha), P(B[0], eb, hb), P(B[0], eb, B[3] - 0.07), P(A[0], ea, A[3] - 0.07), gc);
    };

    // 바닥면 — 가장 먼저 깔아 차 밑으로 노면이 비치지 않게 한다
    const floor = this.haze(shade(color, 0.30 * amb + 0.12), dist);
    for (let i = 0; i < prof.length - 1; i++) {
      const A = prof[i], B = prof[i + 1];
      this.quadPts(P(A[0], -A[1], A[2]), P(B[0], -B[1], B[2]), P(B[0], B[1], B[2]), P(A[0], A[1], A[2]), floor);
    }

    // 카메라 반대쪽 마구리 (거의 안 보이지만 실루엣의 빈틈을 막는다)
    const F = prof[prof.length - 1], Rr = prof[0];
    const cap = (S, f) => this.quadPts(P(S[0], -S[1], S[2]), P(S[0], S[1], S[2]),
      P(S[0], S[1], S[3]), P(S[0], -S[1], S[3]), tone(f));
    if (camAhead) cap(Rr, 0.58); else cap(F, 0.86);

    const n = prof.length - 1;
    for (let k = 0; k < n; k++) {
      const i = camAhead ? k : (n - 1 - k);          // 먼 쪽 끝에서부터
      const A = prof[i], B = prof[i + 1];
      sideQuads(A, B, farSign);
      this.quadPts(P(A[0], -A[1], A[3]), P(B[0], -B[1], B[3]), P(B[0], B[1], B[3]), P(A[0], A[1], A[3]), tone(1.0));
      sideQuads(A, B, nearSign);
    }

    // 카메라 쪽 마구리
    if (camAhead) cap(F, 0.88); else cap(Rr, 0.60);

    // 앞유리와 뒷유리 — 지붕선이 가장 가파르게 오르내리는 구간이 곧 유리면이다.
    // 지붕보다 아주 살짝 위에 얹어 그 자리를 덮게 한다.
    if (gc) {
      let iBack = -1, dBack = 0.06, iWind = -1, dWind = 0.06;
      for (let i = 0; i < prof.length - 1; i++) {
        const d = prof[i + 1][3] - prof[i][3];
        if (d > dBack) { dBack = d; iBack = i; }
        if (-d > dWind) { dWind = -d; iWind = i; }
      }
      const pane = (i) => {
        if (i < 0) return;
        const A = prof[i], B = prof[i + 1];
        this.quadPts(P(A[0], -A[1] * 0.84, A[3] + 0.012), P(B[0], -B[1] * 0.84, B[3] + 0.012),
          P(B[0], B[1] * 0.84, B[3] + 0.012), P(A[0], A[1] * 0.84, A[3] + 0.012), gc);
      };
      // 먼 쪽 유리를 먼저
      if (camAhead) { pane(iBack); pane(iWind); } else { pane(iWind); pane(iBack); }
    }
  },

  quadPts(a, b, c, d, style) {
    Render.begin();
    Render.add(a[0], a[1], a[2]); Render.add(b[0], b[1], b[2]);
    Render.add(c[0], c[1], c[2]); Render.add(d[0], d[1], d[2]);
    Render.fill(style);
  },

  vehicle(ctx, v, corr, sc) {
    if (v.isPlayer && sc.hidePlayer) return;   // 운전석 시점 — 카메라가 차 안에 있다
    const rd = this.road;
    const sRoad = corr.roadS(v.s);
    const g = rd.at(sRoad);
    const u = corr.dir > 0 ? (g.med + v.u) : -(g.med + v.u);
    /* 차도가 벌어지는 구간(쌍굴 이격)과 램프에서는 진행방향이 중심선과 어긋난다.
       차도 국소 좌표에서의 횡거 변화율 하나로 두 경우가 모두 정리된다:
       진행각 보정 = -atan(du_local/ds_local).  (양방향 모두 같은 식) */
    let gLocal = (corr.dir > 0 ? (g.medGrad || 0) : -(g.medGrad || 0));
    if (v.rampT > 0) {
      const dl = (corr.rampLat(v.rampT + 2) - corr.rampLat(v.rampT - 2)) / 4;
      gLocal += v.onRamp ? -dl : dl;      // 진입로는 t 가 줄고, 진출로는 t 가 는다
    }
    const hdg = g.hdg + (corr.dir > 0 ? 0 : Math.PI) + v.yawRel * corr.dir - Math.atan(gLocal);
    const nx = Math.sin(g.hdg), ny = -Math.cos(g.hdg);
    const bx = g.x + nx * u, by = g.y + ny * u, bz = g.z + rd.crossZ(g, u) + (v.dz || 0);
    const dist = Render.depth(bx, by, bz);
    if (dist < 0.4 || dist > Render.drawDist + 60) return;

    const p = v.p;
    const ch = Math.cos(hdg), sh = Math.sin(hdg);
    // 차체 중심은 앞범퍼에서 뒤로 len/2
    const cxx = bx - ch * p.len * 0.5, cyy = by - sh * p.len * 0.5;

    // 그림자
    if (dist < 260) {
      const hl = p.len * 0.47, hw = p.wid * 0.45;
      ctx.globalAlpha = 0.42;
      Render.begin();
      for (const [ix, iy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        Render.add(cxx + ch * hl * ix - sh * hw * iy, cyy + sh * hl * ix + ch * hw * iy, bz + 0.015);
      }
      Render.fill('#000000');
      ctx.globalAlpha = 1;
    }

    const near = dist < 190;
    const wheelCol = '#141619';
    /* 바퀴는 차체보다 '나중에' 그려야 한다. 먼저 그리면 차체 옆면이 통째로 덮어 버려
       바퀴가 사라진다. 차체 바깥면에 살짝 걸치도록 붙인다. */
    /* 앞바퀴는 조향각만큼 돌려 그린다. 바퀴가 안 돌면 조향이 숫자만 바뀌는 느낌이 난다.
       pairs 의 첫 항목을 앞축으로 본다. */
    const steerAng = v.isPlayer ? -(v.steer || 0) * 0.42 : clamp((v.yawRel || 0) * 1.8, -0.35, 0.35);
    const putWheels = (ox, halfW, r, pairs) => {
      if (!near) return;
      for (let pi = 0; pi < pairs.length; pi++) {
        const px = pairs[pi];
        const wh = hdg + (pi === 0 ? steerAng : 0);
        const cw = Math.cos(wh), sw = Math.sin(wh);
        for (const side of [-1, 1]) {
          const wx = ox.x + ch * px - sh * halfW * side, wy = ox.y + sh * px + ch * halfW * side;
          this.box(ctx, wx, wy, bz, hdg, r * 2.05, 0.24, r * 2, 0, wheelCol, 1, dist, false, wh);
        }
      }
    };

    if (v.cls === 'truck') {
      // 트랙터 + 트레일러 — 캡오버 형태
      const cabL = 5.8, gap = 1.0, trlL = p.len - cabL - gap;
      const c1 = { x: bx - ch * (cabL * 0.5), y: by - sh * (cabL * 0.5) };
      const c2 = { x: bx - ch * (cabL + gap + trlL * 0.5), y: by - sh * (cabL + gap + trlL * 0.5) };
      const boxCol = mixHex(v.color, '#eef1f4', 0.45);
      const drawTrailer = () => {
        this.box(ctx, c2.x, c2.y, bz, hdg, trlL, p.wid, 3.05, 1.12, boxCol, 1, dist);
        if (near) this.box(ctx, c2.x, c2.y, bz, hdg, trlL * 0.98, p.wid * 0.92, 0.55, 0.55, shade(boxCol, 0.55), 1, dist);
      };
      const cabProf = [
        [-cabL / 2, p.wid * 0.44, 0.95, 2.60],
        [cabL * 0.28, p.wid * 0.50, 0.90, 3.30],
        [cabL * 0.44, p.wid * 0.50, 0.88, 3.18],
        [cabL * 0.50, p.wid * 0.43, 0.92, 2.60],
      ];
      const drawCab = () => this.hull(ctx, c1.x, c1.y, bz, hdg, cabProf, v.color, dist, near ? { h: 1.00, min: 1.4, top: 2.9 } : null);
      // 먼 쪽부터 그린다 — 순서를 뒤집으면 뒤에 있어야 할 캡이 적재함을 덮어 버린다
      const camAheadT = ch * (Render.cx - bx) + sh * (Render.cy - by) > 0;
      if (camAheadT) { drawTrailer(); drawCab(); } else { drawCab(); drawTrailer(); }
      putWheels(c2, p.wid * 0.47, 0.53, [-trlL * 0.34, -trlL * 0.34 + 1.4]);
      putWheels(c1, p.wid * 0.47, 0.53, [cabL * 0.31, -cabL * 0.26]);
    } else if (v.cls === 'bus') {
      this.hull(ctx, cxx, cyy, bz, hdg, this.profileOf('bus', p), v.color, dist, near ? { h: 1.30, min: 1.6, top: 3.0 } : null);
      putWheels({ x: cxx, y: cyy }, p.wid * 0.47, 0.53, [p.len * 0.34, -p.len * 0.29]);
    } else {
      this.hull(ctx, cxx, cyy, bz, hdg, this.profileOf('car', p), v.color, dist, near ? { h: 0.34, min: 0.55, top: 1.18 } : null);
      putWheels({ x: cxx, y: cyy }, p.wid * 0.435, 0.33, [p.len * 0.31, -p.len * 0.30]);
    }

    if (dist < 340) this.lights(ctx, v, corr, bx, by, bz, hdg, dist, sc);
  },

  /** 직육면체 — 뒷면을 제거하고 깊이순으로 칠한다. 바퀴·적재함처럼 각진 부분에 쓴다 */
  box(ctx, cx, cy, cz, hdg, len, wid, hei, zBase, color, alpha, dist, skipTop, ownHdg) {
    if (ownHdg != null) hdg = ownHdg;
    const ch = Math.cos(hdg), sh = Math.sin(hdg);
    const hl = len / 2, hw = wid / 2;
    const c = [];
    for (let iz = 0; iz < 2; iz++) {
      const z = cz + zBase + (iz ? hei : 0);
      for (let ix = -1; ix <= 1; ix += 2) {
        for (let iy = -1; iy <= 1; iy += 2) {
          c.push([cx + ch * hl * ix - sh * hw * iy, cy + sh * hl * ix + ch * hw * iy, z]);
        }
      }
    }
    // 인덱스: 0(-x,-y) 1(-x,+y) 2(+x,-y) 3(+x,+y) 하단, +4 상단
    const faces = [
      { idx: [4, 5, 7, 6], n: [0, 0, 1], sh: 1.00 },              // 윗면
      { idx: [2, 3, 7, 6], n: [ch, sh, 0], sh: 0.86 },            // 앞면
      { idx: [0, 1, 5, 4], n: [-ch, -sh, 0], sh: 0.62 },          // 뒷면
      { idx: [0, 2, 6, 4], n: [sh, -ch, 0], sh: 0.74 },           // 우측면
      { idx: [1, 3, 7, 5], n: [-sh, ch, 0], sh: 0.74 },           // 좌측면
      { idx: [0, 1, 3, 2], n: [0, 0, -1], sh: 0.30 },             // 바닥면
    ];
    const amb = this.pal.amb;
    ctx.globalAlpha = alpha;
    const vis = [];
    for (const f of faces) {
      if (skipTop && f.n[2] === 1) continue;
      const q = c[f.idx[0]];
      const dx = q[0] - Render.cx, dy = q[1] - Render.cy, dz = q[2] - Render.cz;
      if (dx * f.n[0] + dy * f.n[1] + dz * f.n[2] > 0) continue;   // 뒷면
      const cen = f.idx.reduce((t, i) => t + Render.depth(c[i][0], c[i][1], c[i][2]), 0) / 4;
      vis.push({ f, cen });
    }
    vis.sort((p, q) => q.cen - p.cen);
    for (const { f } of vis) {
      const col = this.haze(shade(color, f.sh * amb + (1 - amb) * 0.42), dist);
      Render.begin();
      for (const i of f.idx) Render.add(c[i][0], c[i][1], c[i][2]);
      Render.fill(col);
    }
    ctx.globalAlpha = 1;
    return c;
  },

  /** 전조등·제동등 */
  lights(ctx, v, corr, bx, by, bz, hdg, dist, sc) {
    const p = v.p, ch = Math.cos(hdg), sh = Math.sin(hdg);
    const night = sc.timeOfDay !== 'day';
    // 카메라가 차의 앞쪽에 있으면 전조등이, 뒤쪽에 있으면 미등이 보인다
    const facing = ch * (Render.cx - bx) + sh * (Render.cy - by);
    const rearX = bx - ch * p.len, rearY = by - sh * p.len;
    const hw = p.wid * 0.40, zT = v.cls === 'car' ? 0.78 : 1.15;
    const tail = v.brake ? '#ff2a1e' : (night ? '#d1241c' : '#8e1a15');
    const size = clamp(70 / dist, 0.8, 9);
    for (const side of (facing < 0 ? [-1, 1] : [])) {
      const lx = rearX - sh * hw * side, ly = rearY + ch * hw * side;
      if (dist < 90) {
        // 가까이에서는 실제 면적을 가진 등화로 그린다 — 점으로 찍으면 제동이 안 읽힌다
        const hwl = 0.26, hh = 0.10;
        const nx = -sh, ny = ch;
        const P = (dy, dz) => [lx + nx * dy - ch * 0.02, ly + ny * dy - sh * 0.02, bz + zT + dz];
        this.quadPts(P(-hwl, -hh), P(hwl, -hh), P(hwl, hh), P(-hwl, hh), tail);
      } else {
        const q = Render.point(lx, ly, bz + zT);
        if (!q) continue;
        ctx.fillStyle = tail;
        ctx.fillRect(q.x - size * 0.55, q.y - size * 0.32, size * 1.1, size * 0.64);
      }
      if (v.brake && dist < 180) {
        const q2 = Render.point(lx, ly, bz + zT);
        if (!q2) continue;
        const r = Math.max(size, 3) * 2.8;
        const gr = ctx.createRadialGradient(q2.x, q2.y, 0, q2.x, q2.y, r);
        gr.addColorStop(0, '#ff4a30aa'); gr.addColorStop(1, '#ff4a3000');
        ctx.fillStyle = gr; ctx.fillRect(q2.x - r, q2.y - r, r * 2, r * 2);
      }
    }
    // 방향지시등
    if (v.blink && facing < 0 && (Math.floor(sc.time * 1.6) & 1)) {
      const side = v.blink * (corr.dir > 0 ? 1 : -1);
      const lx = rearX - sh * p.wid * 0.5 * side, ly = rearY + ch * p.wid * 0.5 * side;
      const q = Render.point(lx, ly, bz + zT);
      if (q) { ctx.fillStyle = '#ffa825'; ctx.fillRect(q.x - size * 0.5, q.y - size * 0.3, size, size * 0.6); }
    }
    // 전조등 — 우리를 향한 차만
    if (night && facing > 0) {
      const fx = bx, fy = by;
      for (const side of [-1, 1]) {
        const lx = fx - sh * hw * side, ly = fy + ch * hw * side;
        const q = Render.point(lx, ly, bz + zT * 0.9);
        if (!q) continue;
        const r = clamp(200 / dist, 1.5, 26);
        const gr = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, r);
        gr.addColorStop(0, '#fffbe8'); gr.addColorStop(0.3, '#ffeeb055'); gr.addColorStop(1, '#ffeeb000');
        ctx.fillStyle = gr; ctx.fillRect(q.x - r, q.y - r, r * 2, r * 2);
      }
    }
  },

  /* ---------- 화면 위 효과 ---------- */
  overlay(ctx, W, H, sc) {
    if (sc.weather === 'rain') {
      const rng = new RNG(Math.floor(sc.time * 30));
      ctx.strokeStyle = '#cfe3f288'; ctx.lineWidth = 1.1;
      ctx.beginPath();
      for (let i = 0; i < 70; i++) {
        const x = rng.next() * W, y = rng.next() * H, l = 12 + rng.next() * 26;
        ctx.moveTo(x, y); ctx.lineTo(x + 3, y + l);
      }
      ctx.stroke();
    }
    if (sc.inTunnel) {                       // 터널 내부는 어둡다
      ctx.fillStyle = 'rgba(4,6,10,0.30)'; ctx.fillRect(0, 0, W, H);
    }
    // 비네트
    const vg = ctx.createRadialGradient(W / 2, H * 0.52, H * 0.45, W / 2, H * 0.52, H * 1.05);
    vg.addColorStop(0, '#00000000'); vg.addColorStop(1, '#00000033');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  },

  haze(c, d) { return Render.haze(c, d); },
};
