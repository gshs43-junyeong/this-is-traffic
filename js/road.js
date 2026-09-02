/* =============================================================================
   road.js — 지형 / 평면선형 / 종단선형 / 구조물(교량·터널) / 인터체인지

   설계 근거
   - 평면선형: 직선 - 완화곡선(클로소이드) - 원곡선 - 완화곡선 - 직선.
     클로소이드는 곡률 k 가 거리 s 에 대해 선형으로 변하는 곡선이므로,
     곡률 프로파일 k(s) 를 구간별 선형으로 두는 것만으로 정확히 재현된다.
   - 최소곡선반경  R_min = V^2 / (127 (e + f))            (AASHTO Green Book / 도로구조규칙)
   - 편경사        e(R)  = e_max (2(R_min/R) - (R_min/R)^2)  (AASHTO Method 5 근사)
   - 완화곡선장    L_s   = 0.0214 V^3 / (R C),  C = 1.2 m/s^3 (횡가속 변화율 한계)
   - 종단선형: 안내선 평활 -> PVI 추출 -> 경사 4.2% 제한 -> 포물선 종단곡선 L = K·A
   - 구조물: 계획고와 원지반의 차(성토고/절토고)로 교량·터널을 자동 판정한다.
     실제 노선 설계에서 교량·터널이 놓이는 자리와 같은 논리다.
   ========================================================================== */
'use strict';

/* 설계속도 100 km/h 고속도로 표준 단면 */
const RoadStd = {
  Vd: 100,           // 설계속도 km/h
  laneW: 3.60,       // 차로폭 m
  shR: 3.00,         // 우측 길어깨(갓길) m
  shRnarrow: 1.25,   // 교량·터널의 축소 갓길 m
  shL: 1.00,         // 좌측 길어깨 m
  medHalf: 1.60,     // 중앙분리대 반폭 m
  barrierH: 0.85,    // 콘크리트 방호벽 높이 m
  maxGrade: 0.042,   // 최대 종단경사
  eMax: 0.06,        // 최대 편경사
  fMax: 0.12,        // 횡방향 미끄럼마찰계수 (V=100)
  fCom: 0.11,        // 곡선부에서 운전자가 감수하는 횡마찰 (주행 쾌적 한계)
  crown: 0.02,       // 직선부 횡단경사(배수구배)
  Kcrest: 60,        // 볼록 종단곡선 변화비 m/%
  Ksag: 45,          // 오목 종단곡선 변화비 m/%
  /* 터널 내공 — 타원 단면.
     노면 아래에서 잘린 타원이라, 노면 높이에서 필요한 폭을 확보하면서도
     중간 높이에서 가장 넓어지고 정점으로 좁아지는 실제 도로터널의 형태가 된다. */
  tunnelH: 7.9,      // 아치 정점 높이 m
  tunnelCz: 2.5,     // 타원 중심 높이 m (노면 기준) — 가장 넓어지는 높이
};
RoadStd.Rmin = RoadStd.Vd * RoadStd.Vd / (127 * (RoadStd.eMax + RoadStd.fMax)); // ≈ 437 m

/* 인터체인지·휴게소 이름 재료 */
const PLACE = ['금호', '청계', '대덕', '운암', '서하', '북평', '신흥', '용마', '백현', '수산',
  '태봉', '옥천', '가평', '문경', '상주', '해평', '월성', '남원', '동곡', '오현',
  '삼포', '연화', '무흘', '장현', '초계'];

/** 지형 설정 — 사용자가 직접 정하는 세 축
    relief    : 산의 높이(기복)      0~100
    density   : 산이 들어찬 정도     0~100
    ruggedness: 사면이 날선 정도     0~100
    이 셋이 정해지면 노선 설계가 감당해야 할 지형 난이도가 정해지고,
    그에 맞춰 곡선반경·종단경사·구조물 판정 문턱이 자동으로 따라간다. */
const TerrainDefault = { relief: 55, density: 50, ruggedness: 50 };

/** 세 축을 하나의 지형 난이도 0~1 로 접는다.
    높이가 지배적이고(0.45), 밀도(0.32)·날카로움(0.23)이 뒤를 받친다. */
function terrainRoughness(t) {
  const r = clamp(t.relief / 100, 0, 1);
  const d = clamp(t.density / 100, 0, 1);
  const g = clamp(t.ruggedness / 100, 0, 1);
  return clamp(0.45 * r + 0.32 * d + 0.23 * g, 0, 1);
}

/** 지형 난이도로부터 노선 설계 상수를 유도한다.
    평지에서는 길게 뻗은 완만한 선형이, 산지에서는 최소반경에 가까운
    굽이진 선형이 나온다 — 실제 노선이 지형을 따라가는 방식 그대로다. */
function roadParamsFor(t) {
  const w = terrainRoughness(t);
  const w2 = w * w;
  return {
    rough: w,
    // 산지일수록 최소반경에 가까운 곡선을 쓴다 (설계기준 하한 437 m 는 넘지 않는다)
    minR: Math.max(RoadStd.Rmin * 1.06, 2600 - 2140 * w),
    maxR: 6000 - 4200 * w,
    // 곡선을 쓰는 데 드는 비용 — 산지에서는 곡선이 오히려 싸다
    curvPen: 11.5 - 9.6 * w,
    // 전체 진행방향을 지키려는 힘 — 산지에서는 크게 우회해도 된다
    headPen: 165 - 118 * w,
    // 토공량 가중 — 산지에서는 땅을 덜 건드리는 쪽이 훨씬 유리하다
    earthW: 0.75 + 1.85 * w,
    // 직선 구간 길이
    tanMin: 320 - 230 * w, tanMax: 900 - 640 * w,
    // 종단경사 한계 3.0% ~ 4.2%. 산지라고 경사를 키우지 않는다 —
    // 실제 설계도 중차량 등판을 위해 경사를 묶어 두고, 대신 산을 뚫고 골을 건넌다.
    // 이 제약이 곧 터널과 교량을 불러오는 힘이다.
    maxGrade: 0.030 + 0.012 * w,
    // 계획고 안내선 평활 폭 — 산지일수록 길게 잡아 능선과 계곡을 가로지른다
    guideSmooth: 380 + 250 * w,
    // 구조물 판정 문턱. 터널 쪽 문턱을 낮게 두어 능선은 뚫고 지나가게 한다
    brgFill: 13 + 7 * w, brgRun: 95 + 45 * w,
    tunCut: 13 + 4 * w, tunRun: 105 + 25 * w,
    // 최대 절·성토 (이보다 깊어지면 구조물 단가로 대체된다)
    earthCap: 13 + 9 * w2,
  };
}

/** 지형 고도장 (m)
    산줄기(저주파) + 능선(마루) + 잔주름 위에 하천 계곡을 파낸다.
    능선은 터널을, 계곡은 교량을 자연스럽게 불러온다 — 실제 노선에서 구조물이
    놓이는 자리가 바로 이 두 곳이다.
    relief 는 진폭을, density 는 마루가 차지하는 면적을, ruggedness 는
    사면의 날카로움(마루 폭이 좁아지고 계곡이 깊어지는 정도)을 정한다. */
function makeTerrain(seed, t) {
  t = t || TerrainDefault;
  const nA = makeNoise2D(new RNG(seed ^ 0x9e3779b9));
  const nB = makeNoise2D(new RNG((seed * 7 + 13) >>> 0));
  const nC = makeNoise2D(new RNG((seed * 31 + 101) >>> 0));
  const nD = makeNoise2D(new RNG((seed * 131 + 57) >>> 0));
  const nE = makeNoise2D(new RNG((seed * 977 + 401) >>> 0));

  const rel = clamp(t.relief / 100, 0, 1);
  const den = clamp(t.density / 100, 0, 1);
  const rug = clamp(t.ruggedness / 100, 0, 1);

  const ampBase = 14 + 178 * rel;                // 산줄기 진폭 14 ~ 192 m
  const ampRidge = 10 + 168 * rel;               // 마루 높이 10 ~ 178 m
  // 밀도가 높을수록 마루로 판정되는 문턱이 내려가 산이 촘촘해진다
  const ridgeThr = 0.40 - 0.34 * den;
  // 험준할수록 문턱에서 정상까지의 폭이 좁아 사면이 급해진다
  const ridgeSpan = 0.30 - 0.20 * rug;
  // 산이 촘촘할수록 산줄기 파장이 짧아진다
  const fMain = 1 / (4200 - 2000 * den);
  const fRidge = 1 / (2000 - 1050 * den);
  const valleyW = 0.070 - 0.045 * rug;           // 계곡 폭
  const valleyD = 14 + 78 * rel * (0.4 + 0.6 * rug);

  return function (x, y) {
    let z = nA(x, y, fMain, 4, 0.5) * ampBase;                       // 산줄기
    const rg = clamp((nB(x, y, fRidge, 3, 0.5) - ridgeThr) / ridgeSpan, 0, 1);
    z += rg * rg * (3 - 2 * rg) * ampRidge;                          // 마루
    // 이차 능선 — 큰 산의 어깨에서 갈라져 나온 줄기. 지형을 덜 단조롭게 한다
    const rg2 = clamp((nE(x, y, fRidge * 2.4, 2, 0.5) - 0.16) / 0.24, 0, 1);
    z += rg2 * rg2 * (3 - 2 * rg2) * ampRidge * 0.34 * (0.35 + 0.65 * rug);
    z += nC(x, y, 1 / 240, 2, 0.5) * (2.0 + 9.0 * rug);              // 잔주름
    z += nC(y * 0.7 - 400, x * 0.7 + 900, 1 / 90, 2, 0.5) * (0.8 + 3.4 * rug);  // 미세 요철
    // 하천 계곡: 저주파 노이즈의 영점선을 따라 좁고 깊은 골을 판다
    const v = nD(x, y, 1 / 1700, 2, 0.5);
    const ch = clamp(1 - Math.abs(v) / valleyW, 0, 1);
    z -= ch * ch * (3 - 2 * ch) * valleyD;
    return z;
  };
}

class Road {
  /**
   * @param {{seed:number, length:number}} opt
   */
  constructor(opt) {
    this.seed = opt.seed | 0;
    this.L = opt.length;
    this.ds = 2;                     // 중심선 표본 간격 m
    this.rng = new RNG(this.seed * 2654435761 + 17);
    this.tcfg = Object.assign({}, TerrainDefault, opt.terrain || {});
    this.P = roadParamsFor(this.tcfg);          // 지형에서 유도한 설계 상수
    this.tunnelSep = opt.tunnelSep != null ? opt.tunnelSep : 26;  // 쌍굴 이격 (m)
    this.icSpacing = opt.icSpacing != null ? opt.icSpacing : 6000; // 인터체인지 평균 간격 (m)
    this.terrain = makeTerrain(this.seed, this.tcfg);

    this._horizontal();
    this._vertical();
    this._superelevation();
    this._structures();
    this._separation();
    this._daylight();
    this._interchanges();
    this._water();
  }

  /* ======================= 평면선형 ======================= */
  /** 완화곡선장 — 횡가속 변화율 C=1.2 m/s^3 기준, 최소 2초 주행거리 */
  _spiralLen(R) {
    const V = RoadStd.Vd;
    const Ls = Math.max(0.0214 * V * V * V / (R * 1.2), V / 1.8);
    return Math.round(Ls / this.ds) * this.ds;
  }

  /** 후보 곡선을 미리 그려 보고 지형 적합도를 점수화한다 (낮을수록 좋음) */
  _curveCost(x0, y0, h0, R, tgt) {
    const T = this.terrain;
    const Ls = R ? this._spiralLen(Math.abs(R)) : 0;
    let La = 0;
    if (R) {
      const need = wrapPi(tgt - h0);
      const same = sgn(need) === sgn(R) || need === 0;
      const theta = same ? clamp(Math.abs(need) + 0.10, 0.10, 0.95) : 0.16;
      La = clamp(theta * Math.abs(R) - Ls, 70, 1200);
    }
    // 후보 경로를 25 m 간격으로 미리 적분
    const step = 25;
    const total = R ? (2 * Ls + La + 420) : 620;
    const N = Math.max(4, Math.round(total / step));
    const px = new Float64Array(N), py = new Float64Array(N), zt = new Float64Array(N);
    let x = x0, y = y0, h = h0, s = 0;
    for (let i = 0; i < N; i++) {
      // 현재 s 에서의 곡률
      let k = 0;
      if (R) {
        const k0 = 1 / R;
        if (s < Ls) k = k0 * (s / Ls);
        else if (s < Ls + La) k = k0;
        else if (s < 2 * Ls + La) k = k0 * (1 - (s - Ls - La) / Ls);
      }
      const hm = h + k * step * 0.5;
      x += Math.cos(hm) * step; y += Math.sin(hm) * step; h += k * step; s += step;
      px[i] = x; py[i] = y; zt[i] = T(x, y);
    }
    // 토공량 대용 지표: 등경사 최적선(경사 제한)과 원지반의 평균 절대차
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < N; i++) { sx += i; sy += zt[i]; sxx += i * i; sxy += i * zt[i]; }
    const den = N * sxx - sx * sx || 1;
    let slope = (N * sxy - sx * sy) / den;                       // m per step
    const maxSlopeStep = this.P.maxGrade * step;
    slope = clamp(slope, -maxSlopeStep, maxSlopeStep);
    const icept = (sy - slope * sx) / N;
    // 절·성토가 일정 높이를 넘으면 터널·교량으로 처리되므로 비용이 더 이상 급증하지 않는다.
    // 이 상한이 없으면 노선이 능선을 무조건 피해 돌아가 터널이 생기지 않는다.
    let earth = 0;
    const cap = this.P.earthCap;
    for (let i = 0; i < N; i++) {
      const d = Math.abs(zt[i] - (icept + slope * i));
      earth += d > cap ? cap + (d - cap) * 0.15 : d;
    }
    earth /= N;
    // 횡단 경사: 도로 좌우 15 m 지점의 고도차 -> 편절편성(비탈면) 부담
    let cross = 0;
    for (let i = 1; i < N; i++) {
      const dx = px[i] - px[i - 1], dy = py[i] - py[i - 1], d = Math.hypot(dx, dy) || 1;
      const nx = dy / d, ny = -dx / d;                            // 진행방향 오른쪽 법선
      cross += Math.abs(T(px[i] + nx * 15, py[i] + ny * 15) - T(px[i] - nx * 15, py[i] - ny * 15)) / 30;
    }
    cross /= Math.max(1, N - 1);
    const P = this.P;
    const curvPen = R ? 900 / Math.abs(R) * P.curvPen : 0;        // 곡선을 쓰는 값
    const headPen = Math.abs(wrapPi(h - tgt)) * P.headPen;        // 전체 진행방향 유지
    const cost = earth * P.earthW + cross * 130 + curvPen + headPen;
    return { cost, R, La, Ls };
  }

  _horizontal() {
    const rng = this.rng, ds = this.ds;
    const X = [0], Y = [0], H = [0], K = [0];
    let hdg = 0, tgt = 0;

    const emit = (len, k0, k1) => {
      const n = Math.max(1, Math.round(len / ds));
      for (let i = 0; i < n; i++) {
        const k = lerp(k0, k1, (i + 0.5) / n);
        const hm = hdg + k * ds * 0.5;
        const li = X.length - 1;
        X.push(X[li] + Math.cos(hm) * ds);
        Y.push(Y[li] + Math.sin(hm) * ds);
        hdg += k * ds; H.push(hdg); K.push(k);
      }
    };

    // 후보 반경 — 지형이 험할수록 최소반경 쪽으로 촘촘히 내려간다
    const P = this.P;
    const CAND = [0];
    for (let k = 0; k < 7; k++) CAND.push(Math.round(P.minR * Math.pow(P.maxR / P.minR, k / 6)));
    let guard = 0;
    while ((X.length - 1) * ds < this.L && guard++ < 800) {
      emit(rng.range(P.tanMin, P.tanMax), 0, 0);                  // 직선부
      if ((X.length - 1) * ds >= this.L) break;
      const wob = 0.24 + 0.55 * P.rough;
      tgt = clamp(tgt + rng.range(-wob, wob), -1.5, 1.5);
      const li = X.length - 1;
      let best = null;
      for (const R of CAND) {
        const signs = R === 0 ? [1] : [1, -1];
        for (const sg of signs) {
          const c = this._curveCost(X[li], Y[li], hdg, R * sg, tgt);
          if (!best || c.cost < best.cost) best = c;
        }
      }
      if (!best.R) { emit(rng.range(P.tanMin, P.tanMax * 0.8), 0, 0); continue; }
      const k = 1 / best.R;
      emit(best.Ls, 0, k); emit(best.La, k, k); emit(best.Ls, k, 0);
    }

    const n = Math.min(X.length, Math.floor(this.L / ds) + 1);
    this.n = n;
    this.len = (n - 1) * ds;
    this.X = Float64Array.from(X.slice(0, n));
    this.Y = Float64Array.from(Y.slice(0, n));
    this.H = Float64Array.from(H.slice(0, n));
    this.K = Float32Array.from(K.slice(0, n));
  }

  /* ======================= 종단선형 ======================= */
  _vertical() {
    const n = this.n, ds = this.ds;
    const zt = new Float32Array(n);
    for (let i = 0; i < n; i++) zt[i] = this.terrain(this.X[i], this.Y[i]);
    this.zt = zt;

    // 1) 원지반을 크게 평활해 계획고 안내선을 만든다
    const guide = smoothArray(zt, Math.round(this.P.guideSmooth / ds));

    // 2) 안내선을 종단변화점(PVI) 몇 개로 단순화
    const stepPVI = Math.max(1, Math.round(120 / ds));
    const gx = [], gy = [];
    for (let i = 0; i < n; i += stepPVI) { gx.push(i * ds); gy.push(guide[i]); }
    if (gx[gx.length - 1] !== this.len) { gx.push(this.len); gy.push(guide[n - 1]); }
    const idx = simplifyDP(gx, gy, 3.0);
    let ps = idx.map(i => gx[i]);
    let pz = idx.map(i => gy[i]);

    // PVI 간 최소 간격 350 m — 종단곡선이 겹치지 않게
    for (let i = 1; i < ps.length - 1;) {
      if (ps[i] - ps[i - 1] < 420) { ps.splice(i, 1); pz.splice(i, 1); } else i++;
    }

    // 3) 종단경사 제한 (전진/후진 스윕을 번갈아 수렴시킨다)
    const mg = this.P.maxGrade;
    for (let it = 0; it < 30; it++) {
      let worst = 0;
      for (let i = 1; i < ps.length; i++) {
        const d = ps[i] - ps[i - 1];
        const g = (pz[i] - pz[i - 1]) / d;
        if (Math.abs(g) > mg) {
          worst = Math.max(worst, Math.abs(g) - mg);
          const over = (Math.abs(g) - mg) * d * sgn(g);
          pz[i] -= over * 0.5; pz[i - 1] += over * 0.5;     // 양쪽으로 나눠 완화
        }
      }
      if (worst < 1e-5) break;
    }

    // 4) 접선 경사 + 포물선 종단곡선으로 계획고를 계산
    const m = ps.length;
    const grades = new Float64Array(m - 1);
    for (let i = 0; i < m - 1; i++) grades[i] = (pz[i + 1] - pz[i]) / (ps[i + 1] - ps[i]);

    const vc = [];   // 각 PVI 의 종단곡선 {s, L, g1, g2, zPVI}
    for (let i = 1; i < m - 1; i++) {
      const g1 = grades[i - 1], g2 = grades[i];
      const A = Math.abs(g2 - g1) * 100;                    // 대수차 (%)
      const K = (g2 < g1) ? RoadStd.Kcrest : RoadStd.Ksag;  // 볼록/오목
      let L = Math.max(A * K, 80);
      const room = Math.min(ps[i] - ps[i - 1], ps[i + 1] - ps[i]) * 1.8;
      L = Math.min(L, room);
      vc.push({ s: ps[i], L, g1, g2, z: pz[i] });
    }

    const z = new Float32Array(n);
    let seg = 0;
    for (let i = 0; i < n; i++) {
      const s = i * ds;
      while (seg < m - 2 && s > ps[seg + 1]) seg++;
      // 접선 고도
      let zz = pz[seg] + grades[seg] * (s - ps[seg]);
      // 인접 종단곡선의 보정량을 더한다
      for (let c = Math.max(0, seg - 1); c <= Math.min(vc.length - 1, seg); c++) {
        const v = vc[c]; if (!v) continue;
        const half = v.L / 2, d = s - (v.s - half);
        if (d > 0 && d < v.L) {
          const A = v.g2 - v.g1;
          // 접선(진입경사 연장) 기준 포물선: y = A/(2L) x^2
          const zTanIn = v.z + v.g1 * (s - v.s);
          zz = zTanIn + A / (2 * v.L) * d * d;
        }
      }
      z[i] = zz;
    }
    this.z = z;
    this.pvi = { ps, pz, vc };

    // 종단경사 (진행방향 +s 기준)
    const grade = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      grade[i] = (z[b] - z[a]) / ((b - a) * ds);
    }
    this.grade = grade;
  }

  /* ======================= 편경사 ======================= */
  _superelevation() {
    const n = this.n;
    const e = new Float32Array(n);
    const Rmin = RoadStd.Rmin;
    for (let i = 0; i < n; i++) {
      const k = this.K[i];
      const R = Math.abs(k) > 1e-9 ? 1 / Math.abs(k) : Infinity;
      if (!isFinite(R)) { e[i] = 0; continue; }
      const r = clamp(Rmin / R, 0, 1);
      e[i] = clamp(RoadStd.eMax * (2 * r - r * r), 0, RoadStd.eMax) * sgn(k);
    }
    // 편경사 접속설치(runoff) — 완화곡선을 따라 부드럽게
    this.e = smoothArray(e, Math.round(40 / this.ds));
    // 곡선부 주행 한계속도 (m/s)
    const vc = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = Math.abs(this.K[i]);
      if (k < 1e-7) { vc[i] = 999; continue; }
      const R = 1 / k;
      vc[i] = Math.sqrt(127 * R * (Math.abs(this.e[i]) + RoadStd.fCom)) * KMH;
    }
    this.vCurve = smoothArray(vc, Math.round(60 / this.ds));
  }

  /* ======================= 구조물 판정 ======================= */
  _structures() {
    const n = this.n, ds = this.ds;
    const fill = new Float32Array(n);
    for (let i = 0; i < n; i++) fill[i] = this.z[i] - this.zt[i];
    this.fill = fill;

    const flag = new Uint8Array(n);   // 0 토공 / 1 교량 / 2 터널
    const runs = [];

    const scan = (test, expand, minLen, code) => {
      let i = 0;
      while (i < n) {
        if (!test(fill[i])) { i++; continue; }
        let a = i, b = i;
        while (b + 1 < n && test(fill[b + 1])) b++;
        if ((b - a) * ds >= minLen) {
          while (a > 0 && expand(fill[a - 1])) a--;
          while (b < n - 1 && expand(fill[b + 1])) b++;
          runs.push({ code, a, b });
        }
        i = b + 1;
      }
    };
    const P = this.P;
    // 교량: 성토고가 문턱을 넘는 구간이 충분히 길 때 / 터널: 절토고 기준
    scan(f => f > P.brgFill, f => f > P.brgFill * 0.42, P.brgRun, 1);
    scan(f => f < -P.tunCut, f => f < -P.tunCut * 0.44, P.tunRun, 2);

    runs.sort((p, q) => p.a - q.a);
    const kept = [];
    for (const r of runs) {
      const last = kept[kept.length - 1];
      if (last && r.a <= last.b + Math.round(260 / ds)) {         // 너무 가까우면 병합/흡수
        if (r.code === last.code) { last.b = Math.max(last.b, r.b); continue; }
        if ((r.b - r.a) < (last.b - last.a)) continue;
        kept.pop();
      }
      kept.push({ ...r });
    }
    this.structs = [];
    for (const r of kept) {
      if ((r.b - r.a) * ds < 90) continue;              // 90 m 미만은 토공으로 처리
      for (let i = r.a; i <= r.b; i++) flag[i] = r.code;
      this.structs.push({
        type: r.code === 1 ? 'bridge' : 'tunnel',
        s0: r.a * ds, s1: r.b * ds, len: (r.b - r.a) * ds,
        name: null,
      });
    }
    this.struct = flag;
    // 이름 붙이기
    const rng = new RNG(this.seed * 7919 + 3);
    for (const st of this.structs) {
      const p = rng.pick(PLACE);
      st.name = p + (st.type === 'bridge' ? '대교' : '터널');
    }
  }

  /* ======================= 쌍굴 이격 =======================
     터널에서는 두 방향 차도를 일정 거리만큼 벌려 각각 독립된 굴로 뚫는다.
     사이에 남는 암반이 중앙 필러가 되며, 실제 고속도로 터널이 이 방식이다.
     본선에서는 이격 0, 터널에서는 tunnelSep 으로 일정하게 유지하고,
     그 사이는 완화구간에서 부드럽게 벌렸다 좁힌다. */
  _separation() {
    const n = this.n, ds = this.ds;
    const half = this.tunnelSep / 2;
    const sep = new Float32Array(n);
    // 완화구간 길이. smoothstep 의 최대 기울기는 1.5·half/T 이므로
    // 1:40 보다 완만해지도록 T 를 잡는다.
    const T = clamp(half * 60, 260, 1100);
    for (const st of this.structs) {
      if (st.type !== 'tunnel') continue;
      const a = st.s0, b = st.s1;
      const j0 = clamp(Math.floor((a - T) / ds), 0, n - 1);
      const j1 = clamp(Math.ceil((b + T) / ds), 0, n - 1);
      for (let j = j0; j <= j1; j++) {
        const x = j * ds;
        let f;
        if (x < a) f = smoothstep((x - (a - T)) / T);
        else if (x <= b) f = 1;
        else f = smoothstep(((b + T) - x) / T);
        const v = half * clamp(f, 0, 1);
        if (v > sep[j]) sep[j] = v;          // 터널이 가까이 붙어 있으면 큰 쪽을 쓴다
      }
    }
    this.sep = sep;
    // 이격의 변화율 — 각 차도의 진행방향이 중심선과 어긋나는 각을 여기서 얻는다.
    // 이 각을 반영하지 않으면 차가 옆으로 게걸음을 친다.
    const grad = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      grad[i] = (sep[b] - sep[a]) / ((b - a) * ds);
    }
    this.sepGrad = grad;
  }

  /** 이 지점에서 중심선부터 각 차도 안쪽 가장자리까지의 거리 */
  medHalfAt(s) {
    const i = this.idxOf(s);
    return RoadStd.medHalf + (this.sep ? this.sep[i] : 0);
  }
  medHalfIdx(i) { return RoadStd.medHalf + (this.sep ? this.sep[i] : 0); }

  /** 노면 바깥 비탈면이 원지반과 만나는 지점(비탈끝)을 미리 계산한다 */
  _daylight() {
    const n = this.n, ds = this.ds, T = this.terrain;
    const step = Math.max(1, Math.round(8 / ds));           // 8 m 마다 계산 후 보간
    const dR = new Float32Array(n), dRz = new Float32Array(n);
    const dL = new Float32Array(n), dLz = new Float32Array(n);
    const halfWBase = RoadStd.shL + RoadStd.laneW * 5 + RoadStd.shR;   // 차도 한쪽 폭(최대)

    const solve = (i, side) => {
      const halfW = this.medHalfIdx(i) + halfWBase;
      const h = this.H[i], nx = Math.sin(h) * side, ny = -Math.cos(h) * side;
      const x0 = this.X[i], y0 = this.Y[i], z0 = this.z[i];
      const f = z0 - T(x0 + nx * halfW, y0 + ny * halfW);
      const slope = f >= 0 ? -1 / 1.8 : 1 / 1.2;            // 성토 1:1.8 / 절토 1:1.2
      let d = halfW, zz = z0;
      for (let k = 0; k < 26; k++) {
        const nd = d + 4;
        const zr = z0 + slope * (nd - halfW);
        const zg = T(x0 + nx * nd, y0 + ny * nd);
        if ((f >= 0 && zr <= zg) || (f < 0 && zr >= zg)) { d = nd; zz = zg; break; }
        d = nd; zz = zr;
      }
      return [d, zz];
    };

    for (let i = 0; i < n; i += step) {
      const [a, az] = solve(i, 1); dR[i] = a; dRz[i] = az;
      const [b, bz] = solve(i, -1); dL[i] = b; dLz[i] = bz;
    }
    for (let i = 0; i < n; i++) {
      if (i % step === 0) continue;
      const a = i - (i % step), b = Math.min(n - 1, a + step);
      const t = (i - a) / (b - a || 1);
      dR[i] = lerp(dR[a], dR[b], t); dRz[i] = lerp(dRz[a], dRz[b], t);
      dL[i] = lerp(dL[a], dL[b], t); dLz[i] = lerp(dLz[a], dLz[b], t);
    }
    this.dayR = dR; this.dayRz = dRz; this.dayL = dL; this.dayLz = dLz;
  }

  /* ======================= 인터체인지 ======================= */
  _interchanges() {
    const rng = new RNG(this.seed * 104729 + 11);
    const ds = this.ds;
    this.ics = [];
    let s = rng.range(1800, this.icSpacing * 0.7);
    while (s < this.len - 2600) {
      // 구조물 밖, 경사·곡률이 완만한 자리를 근처에서 찾는다
      let bi = -1, bScore = Infinity;
      const j0 = Math.round(520 / ds), j1 = Math.round(880 / ds);
      for (let d = -1700; d <= 1700; d += 40) {
        const ss = s + d;
        if (ss < 1400 || ss > this.len - 1800) continue;
        const i = Math.round(ss / ds);
        let bad = 0, blocked = false;
        for (let j = i - j0; j <= i + j1; j++) {
          const jj = clamp(j, 0, this.n - 1);
          if (this.struct[jj]) { blocked = true; break; }
          bad += Math.abs(this.grade[jj]) * 40 + Math.abs(this.K[jj]) * 900;
        }
        if (blocked) continue;
        const score = bad / (j0 + j1) + Math.abs(d) / 5000;
        if (score < bScore) { bScore = score; bi = i; }
      }
      if (bi > 0) {
        const rest = rng.chance(0.28);
        this.ics.push({
          s: bi * ds,
          name: rng.pick(PLACE) + (rest ? '휴게소' : (rng.chance(0.22) ? '분기점' : 'IC')),
          rest,
        });
      }
      s += this.icSpacing * rng.range(0.62, 1.42);   // 간격은 매번 임의로
    }
    // 이름 중복 제거
    const seen = new Set();
    for (const ic of this.ics) {
      let nm = ic.name, k = 2;
      while (seen.has(nm)) nm = ic.name.replace(/(IC|분기점|휴게소)$/, m => '제' + (k++) + m);
      ic.name = nm; seen.add(nm);
    }
  }

  _water() {
    // 물길: 주변 지형 고도 분포의 하위 8% 를 수면으로 본다
    const rng = new RNG(this.seed + 991);
    const samp = [];
    for (let k = 0; k < 900; k++) {
      const i = Math.floor(rng.next() * this.n);
      const off = rng.range(-260, 260);
      const h = this.H[i], nx = Math.sin(h), ny = -Math.cos(h);
      samp.push(this.terrain(this.X[i] + nx * off, this.Y[i] + ny * off));
    }
    samp.sort((a, b) => a - b);
    this.waterZ = samp[Math.floor(samp.length * 0.08)];
  }

  /* ======================= 조회 ======================= */
  /** 도로 station(=중심선 거리)에서의 기하 상태 */
  at(s) {
    const t = clamp(s, 0, this.len - 1e-6) / this.ds;
    const i = t | 0, f = t - i, j = Math.min(i + 1, this.n - 1);
    return {
      i,
      x: lerp(this.X[i], this.X[j], f),
      y: lerp(this.Y[i], this.Y[j], f),
      z: lerp(this.z[i], this.z[j], f),
      zt: lerp(this.zt[i], this.zt[j], f),
      hdg: lerp(this.H[i], this.H[j], f),
      kap: lerp(this.K[i], this.K[j], f),
      e: lerp(this.e[i], this.e[j], f),
      grade: lerp(this.grade[i], this.grade[j], f),
      vCurve: lerp(this.vCurve[i], this.vCurve[j], f),
      struct: this.struct[i],
      // 차도 안쪽 가장자리까지의 거리 (터널에서는 쌍굴 이격만큼 벌어진다)
      med: RoadStd.medHalf + (this.sep ? lerp(this.sep[i], this.sep[j], f) : 0),
      medGrad: this.sepGrad ? lerp(this.sepGrad[i], this.sepGrad[j], f) : 0,
    };
  }
  idxOf(s) { return clamp(Math.round(s / this.ds), 0, this.n - 1); }
  structAt(s) { return this.struct[this.idxOf(s)]; }
  /** 구조물 정보(이름 포함) */
  structInfo(s) {
    for (const st of this.structs) if (s >= st.s0 && s <= st.s1) return st;
    return null;
  }

  /** 중심선 기준 횡거 u(오른쪽 +), 노면 위 높이 dz 의 3차원 좌표 */
  world(g, u, dz) {
    const nx = Math.sin(g.hdg), ny = -Math.cos(g.hdg);
    const cs = Math.abs(g.e) >= RoadStd.crown ? g.e : (-RoadStd.crown * sgn(u || 1)); // 편경사 or 배수구배
    return [g.x + nx * u, g.y + ny * u, g.z + u * cs + (dz || 0)];
  }
  /** 노면 횡단경사 (u 위치의 고도 보정량) */
  crossZ(g, u) {
    const cs = Math.abs(g.e) >= RoadStd.crown ? g.e : (-RoadStd.crown * sgn(u || 1));
    return u * cs;
  }
}
