/* =============================================================================
   hwyfx.js — 고속도로 시설의 생김새: 도로 표지판 · 휴게소 · 영업소(요금소) · 분기점 연결로

   표지판 (한국 고속도로 안내표지와 비슷하게 — 녹색 바탕에 흰 글씨, 휴게소는 청색 바탕)
     놓는 자리   출구(감속차로 시작)까지 2 km · 1 km 는 차로 위 문형 표지, 500 m · 0 m 는 갓길 밖 높은 기둥 표지,
                 갈림목 코에 작은 분류 표지.
     나들목(IC)   본판 — 왼쪽 일반국도 번호(파란 타원), 갈 곳 둘(한글 크게 · 로마자 옆), 오른쪽 ↗ (예고는 ↗ 와 거리).
                 본판 위 오른쪽에 붙은 출구 꼬리표 — 검은 칸의 출구 번호 · IC 이름 · 나가는 차로 그림.
     분기점(JCT)  본판의 번호가 고속국도 방패(위 빨강 · 아래 파랑), 꼬리표 이름은 '○○JC'.
                 2 km · 1 km 문형 표지는 판 둘 — 왼쪽 본선(방패 · 갈 곳 · 차로마다 ↓), 오른쪽 갈라지는 노선.
     휴게소       청색 바탕, 시설 그림(주유 · 식당 · 화장실 · 주차), 출구 번호 없음, 2 km 표지 밑에 '다음 휴게소 ○○ km'.
   시설 (나들목 고리 — 감속차로에서 나간 램프와 다시 들어오는 램프가 바깥 접속점에서 만난다)
     나들목  바깥 접속점에 영업소(지붕 · 부스) 와 바깥으로 나가는 지방도.
     분기점  바깥 접속점에서 고가 연결로가 다른 고속도로로 휘어 올라간다.
     휴게소  고리 바깥에 주차장 · 휴게소 건물 · 주유소 · 기둥 간판.

   글씨는 캔버스에 그려 render.js 의 그림 붙인 사각형(texQuad)으로 올린다 — 깊이 판정을 받아
   앞을 지나는 화물차나 교량에 제대로 가린다.
   ========================================================================== */
'use strict';

const ROMAN = {
  금호: 'Geumho', 청계: 'Cheonggye', 대덕: 'Daedeok', 운암: 'Unam', 서하: 'Seoha', 북평: 'Bukpyeong', 신흥: 'Sinheung',
  용마: 'Yongma', 백현: 'Baekhyeon', 수산: 'Susan', 태봉: 'Taebong', 옥천: 'Okcheon', 가평: 'Gapyeong', 문경: 'Mungyeong',
  상주: 'Sangju', 해평: 'Haepyeong', 월성: 'Wolseong', 남원: 'Namwon', 동곡: 'Donggok', 오현: 'Ohyeon', 삼포: 'Sampo',
  연화: 'Yeonhwa', 무흘: 'Muheul', 장현: 'Janghyeon', 초계: 'Chogye',
};
const MAIN_AR = 1024 / 440, TAB_AR = 1024 / 280, PLATE_AR = 1024 / 156;   // 본판 · 꼬리표 · 보조판 가로세로비
const SIGN = {
  green: '#0f6a3e', blue: '#1150a8', white: '#f4f6f2', steel: '#8b9298', back: '#7c8287',
  // 로마자 · 숫자는 SignLatin, 그 글꼴에 없는 한글은 SignHangul 로 넘어간다 (index.html @font-face)
  font: 'SignLatin,SignHangul,"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif',
  routes: [10, 12, 15, 16, 25, 27, 30, 35, 40, 45, 50, 55, 60, 65],
};

const HwyFx = {
  /* ---------- 자리 계산 ---------- */
  prepare(road, corrA, corrB) {
    this.road = road; this.cA = corrA; this.cB = corrB;
    this.loadFonts();
    const h = (str) => { let x = 2166136261; for (const c of String(str)) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return x >>> 0; };
    this.mainRoute = SIGN.routes[h('main' + road.seed) % SIGN.routes.length];
    // 출구 번호 — 노선 시작부터 나들목 · 분기점에만 차례로 (휴게소는 번호가 없다)
    const sorted = road.ics.slice().sort((a, b) => a.s - b.s);
    let k = 0;
    this.info = new Map();
    for (const ic of sorted) {
      const type = ic.rest ? 'rest' : /분기점$/.test(ic.name) ? 'jct' : 'ic';
      const base = ic.name.replace(/(제\d+)?(IC|분기점|휴게소)$/, '');
      const pick = (salt) => { const c = PLACE.filter((p) => p !== base); return c[h(ic.name + salt) % c.length]; };
      let route = SIGN.routes[h(ic.name) % SIGN.routes.length]; if (route === this.mainRoute) route = SIGN.routes[(SIGN.routes.indexOf(route) + 3) % SIGN.routes.length];
      this.info.set(ic.name, { type, base, no: type === 'rest' ? null : ++k, dest: [pick('a'), pick('b')], route, nat: 1 + h(ic.name + 'n') % 79, otherDest: [pick('c'), pick('d')] });
    }
    // 방향마다 본선 끝 갈 곳
    this.dirDest = { 1: PLACE[h('end1' + road.seed) % PLACE.length], [-1]: PLACE[h('end2' + road.seed) % PLACE.length] };
    this.sites = [];
    for (const corr of [corrA, corrB]) {
      if (!corr) continue;
      const list = corr.icLocal;
      list.forEach((ic, i) => {
        const inf = this.info.get(ic.name);
        if (!inf) return;
        // 다음 휴게소까지 (이 방향으로)
        let nextRest = null;
        for (let j = i + 1; j < list.length; j++) if (list[j].rest) { nextRest = list[j]; break; }
        const prevEnd = i > 0 ? list[i - 1].s + ON_GORE + 200 : 0;
        this.sites.push({ corr, s: ic.s, name: ic.name, inf, nextRest: nextRest ? Math.round((nextRest.s - ic.s) / 1000) : null, prevEnd });
      });
    }
    this.levelPads();
  },
  /* ★ 캔버스는 아직 안 읽힌 웹 글꼴을 기다려 주지 않고 대체 글꼴로 그린다 — 그 그림이 텍스처로 굳으므로
     글꼴이 다 읽히면 그림을 버려 다시 그리게 한다 */
  loadFonts() {
    if (this._fontP || typeof document === 'undefined' || !document.fonts) return;
    this._fontP = Promise.all([document.fonts.load('800 40px SignHangul', '가나'), document.fonts.load('800 40px SignLatin', 'Ab1')])
      .then(() => Render.texDrop()).catch(() => {});
  },
  /** 그리기 전에 — 도로 · 방향이 바뀌었으면 다시 잰다 (지형 고르기는 본선 띠를 그리기 전에 있어야 한다) */
  sync(sc) { if (this.road !== sc.road || this.cA !== sc.corrA || this.cB !== sc.corrB) this.prepare(sc.road, sc.corrA, sc.corrB); },
  /* ★ 휴게소 주차장 · 영업소 자리의 땅을 고른다 — 지형을 그대로 두면 깎기 구간에서 휴게소가 산에 묻혀 안 보였다.
     자리마다 돌린 직사각형(본선 방향)을 두고, 바닥판보다 0.7 m 낮게(더 붙이면 먼 거리에서 깊이가 겹쳐 잔디가 바닥을 뚫는다), 안에서는 그 높이, 밖으로 35 m 에 걸쳐 원래 지형으로 돌아간다 */
  levelPads() {
    const rd = this.road;
    if (!rd._terr0) rd._terr0 = rd.terrain.bind(rd);
    const pads = [];
    for (const site of this.sites) {
      const t = site.inf.type; if (t === 'jct') continue;
      const corr = site.corr, o = this.outer(corr, site.s);
      // 휴게소: 주차장 · 건물 / 영업소: 접속로 · 요금소 광장 · 사무실, 그리고 일반국도 띠
      const z = this.P(corr, o.s, o.u, o.dz)[2] - 0.7;
      const boxes = t === 'rest' ? [[o.u - 6, o.u + 84, 250]] : [[o.u - 6, o.u + this.TOLL.vRoad - 4, 70], [o.u + this.TOLL.vRoad - 14, o.u + this.TOLL.vRoad + 14, 540]];
      for (const [u0, u1, ha] of boxes) {
        const c = this.P(corr, o.s, (u0 + u1) / 2, 0), f = this.P(corr, o.s + 1, (u0 + u1) / 2, 0);
        const fx = f[0] - c[0], fy = f[1] - c[1], L = Math.hypot(fx, fy) || 1;
        pads.push({ x: c[0], y: c[1], z, fx: fx / L, fy: fy / L, ha, hc: (u1 - u0) / 2 });
      }
    }
    rd.pads = pads;
    rd.terrain = (x, y) => {
      let z = rd._terr0(x, y);
      for (const p of rd.pads) {
        const dx = x - p.x, dy = y - p.y, a = Math.abs(dx * p.fx + dy * p.fy) - p.ha, b = Math.abs(-dx * p.fy + dy * p.fx) - p.hc;
        if (a > 35 || b > 35) continue;
        const d = Math.hypot(Math.max(0, a), Math.max(0, b)), w = 1 - smoothstep(d / 35);
        z = z + (p.z - z) * w;
      }
      return z;
    };
  },
  /** 차로 바깥 가장자리 (국소 횡거, 갓길 끝) */
  edgeU(corr, s) { return RoadStd.shL + RoadStd.laneW * (corr.nLane + corr.auxWidth(s)) + RoadStd.shR; },
  /** 방향 국소 좌표 (s, u, 노면 위 dz) → 세계 */
  P(corr, s, u, dz) {
    const rd = this.road, g = rd.at(corr.roadS(clamp(s, 0, corr.L)));
    const uu = corr.toRoadU(s, u), nx = Math.sin(g.hdg), ny = -Math.cos(g.hdg);
    return [g.x + nx * uu, g.y + ny * uu, g.z + rd.crossZ(g, clamp(uu, -20, 20)) + (dz || 0)];
  },
  inTunnel(corr, s) { return this.road.structAt(corr.roadS(clamp(s, 0, corr.L))) === 2; },

  /* ---------- 그리기 ---------- */
  draw(ctx, sc) {
    this.sync(sc);
    const night = sc.timeOfDay === 'night', dusk = sc.timeOfDay === 'dusk';
    this.bright = night ? 0.62 : dusk ? 0.8 : 1;       // 반사지 — 밤에도 전조등에 꽤 밝다
    this.ctx = ctx; this.sc = sc; this._crossDone = new Set();
    for (const site of this.sites) {
      const corr = site.corr;
      const sr = corr.roadS(site.s), d0 = Math.abs(sr - sc.sCam);
      if (d0 > 3200) continue;
      const t = site.inf.type;
      this.signs(site, t);
      if (d0 < 2200) {
        if (t === 'rest') this.restArea(site);
        else if (t === 'jct') this.jct(site);
        else this.tollPlaza(site);
      }
    }
  },
  /** 그 자리가 지금 그릴 만큼 가깝고 앞에 있나 */
  /** 카메라에서 그 자리까지 거리 (앞뒤 상관없이) — 넓게 퍼진 시설은 조각마다 따로 가린다 */
  dist(corr, s, u, lim) {
    const p = this.P(corr, s, u, 3), d = Math.hypot(p[0] - Render.cx, p[1] - Render.cy, p[2] - Render.cz);
    return d < lim ? Math.max(1, Render.depth(p[0], p[1], p[2])) : -1;
  },
  near(corr, s, lim) {
    const p = this.P(corr, s, 6, 3), d = Render.depth(p[0], p[1], p[2]);
    return d > -30 && d < (lim || Render.drawDist + 200) ? d : -1;
  },

  /* ----- 표지판 ----- */
  signs(site, t) {
    const corr = site.corr, S = site.s, inf = site.inf, ex = S - 320;     // 감속차로 시작 = 출구
    for (const D of [2000, 1000, 500, 0]) {
      const s = ex - D;
      if (s < site.prevEnd || s < 60 || this.inTunnel(corr, s)) continue;
      const dist = D >= 1000 ? D / 1000 + 'km' : D ? D + 'm' : null;
      if (D < 1000) this.roadside(site, s, dist);
      else if (t === 'jct') this.gantry(site, s, dist);
      else this.overhead(site, s, dist, t === 'rest' && D === 2000 ? site.nextRest : null);
    }
    // 갈림목 코 — 램프가 본선에서 4.5 m 넘게 벌어진 곳
    let tg = 60;
    for (; tg < 300; tg += 5) if (corr.rampLat(tg) - corr.rampHalf(tg) - (RoadStd.shL + RoadStd.laneW * corr.nLane + RoadStd.shR * 0.5) > 4.5) break;
    const ug = (corr.rampLat(tg) - corr.rampHalf(tg) + RoadStd.shL + RoadStd.laneW * corr.nLane) / 2 + 1.2;
    const d = this.near(corr, S + tg, 1400);
    if (d >= 0) {
      const key = `${t}g:${t === 'jct' ? inf.route : ''}`;
      const make = () => (t === 'rest' ? this.texGore('휴게소', SIGN.blue) : t === 'jct' ? this.texGoreJct(inf) : this.texGore('출구', SIGN.green));
      this.posts(corr, S + tg + 0.3, [ug - 0.8, ug + 0.8], 1.0 + 2.0, 0.12, d);
      this.panel(corr, S + tg, ug, 1.0, 3.0, 2.0, key, make, d);
    }
  },
  /** 본판 열쇠 · 그림 */
  mainKey(site, dist) { return `${site.inf.type}m:${site.name}:${dist || '0'}`; },
  /** 출구 꼬리표 — 본판 위, 오른쪽 끝(uR)에 맞춰 붙인다 */
  tab(site, s, uR, zb, h, d) {
    const W = h * TAB_AR;
    this.panel(site.corr, s, uR - W / 2, zb, W, h, `tab:${site.name}`, () => this.texTab(site), d);
  },
  /** 차로 위 문형 표지 (나들목 · 휴게소) — 본선 가운데에 본판, 위에 꼬리표, 밑에 보조판 */
  overhead(site, s, dist, nextKm) {
    const corr = site.corr, d = this.near(corr, s); if (d < 0) return;
    const t = site.inf.type, n = corr.nLane, lw = RoadStd.laneW, sl = RoadStd.shL;
    const pr = this.edgeU(corr, s) + 1.6, pl = -0.25, hb = 5.6;
    const W = Math.min(lw * n - 0.6, 9.4), H = W / MAIN_AR, uc = sl + lw * n / 2;
    const plate = nextKm != null ? W / PLATE_AR : 0, tabH = t === 'rest' ? 0 : H * 0.3;
    const zb = hb + plate;
    this.posts(corr, s + 0.5, [pl, pr], zb + H + tabH + 0.2, 0.34, d);
    this.beam(corr, s + 0.5, pl, pr, zb + H * 0.75, 0.32, d);
    this.beam(corr, s + 0.5, pl, pr, zb + H * 0.2, 0.26, d);
    if (plate) this.panel(corr, s, uc, hb, W, plate, `restnext:${nextKm}`, () => this.texNextRest(nextKm), d);
    this.panel(corr, s, uc, zb, W, H, this.mainKey(site, dist), () => this.texMain(site, dist), d);
    if (tabH) this.tab(site, s, uc + W / 2, zb + H + 0.06, tabH, d);
  },
  /** 갓길 밖 높은 기둥 표지 (500 m · 0 m) — 기둥은 판 뒤에 선다 */
  roadside(site, s, dist) {
    const corr = site.corr, d = this.near(corr, s); if (d < 0) return;
    const t = site.inf.type, W = 6.0, H = W / MAIN_AR, tabH = t === 'rest' ? 0 : H * 0.3;
    const uc = this.edgeU(corr, s) + 3.6, hb = 5.2;          // 높은 봉 — 판 아래가 차 지붕보다 한참 위
    // ★ 기둥을 판과 같은 자리(s)에 세우면 판 앞으로 반쯤 튀어나와 글씨 위에 철봉이 보인다 — 뒤로 물린다
    this.posts(corr, s + 0.38, [uc - W * 0.3], hb + H - 0.1, 0.26, d);
    this.posts(corr, s + 0.38, [uc + W * 0.3], hb + H + tabH - 0.1, 0.26, d);
    this.beam(corr, s + 0.38, uc - W * 0.3, uc + W * 0.3, hb + H * 0.25, 0.16, d);
    this.beam(corr, s + 0.38, uc - W * 0.3, uc + W * 0.3, hb + H * 0.75, 0.16, d);
    this.panel(corr, s, uc, hb, W, H, this.mainKey(site, dist), () => this.texMain(site, dist), d);
    if (tabH) this.tab(site, s, uc + W / 2, hb + H + 0.05, tabH, d);
  },
  /** 분기점 문형 표지 — 중앙분리대 쪽과 갓길 밖 기둥 · 가로보 · 판 둘 (본선 · 갈라지는 길) */
  gantry(site, s, dist) {
    const corr = site.corr, d = this.near(corr, s); if (d < 0) return;
    const pr = this.edgeU(corr, s) + 1.6, pl = -0.25, hb = 5.6, H = 3.4, tabH = H * 0.3;
    const n = corr.nLane, lw = RoadStd.laneW, sl = RoadStd.shL;
    this.posts(corr, s + 0.5, [pl, pr], hb + H + tabH + 0.2, 0.34, d);
    this.beam(corr, s + 0.5, pl, pr, hb + H * 0.75, 0.32, d);
    this.beam(corr, s + 0.5, pl, pr, hb + H * 0.2, 0.26, d);
    // 왼쪽 판 — 본선 차로들 위 (바깥 한 차로를 뺀 폭)
    const wL = lw * (n - 1) + 0.6, cL = sl + lw * (n - 1) / 2;
    const tag = dist || 'x';
    this.panel(corr, s, cL, hb, wL, H, `jctm:${site.name}:${tag}:${corr.dir}:${n}`, () => this.texJctMain(site, n - 1, dist, wL / H), d);
    // 오른쪽 판 — 바깥 차로(나가는 쪽) 위, 그 위에 출구 꼬리표
    const wR = lw + 1.6, cR = sl + lw * (n - 0.5) + 0.8;
    this.panel(corr, s, cR, hb, wR, H, `jcto:${site.name}:${tag}`, () => this.texJctOut(site, dist, wR / H), d);
    this.tab(site, s, cR + wR / 2, hb + H + 0.06, tabH, d);
  },
  panel(corr, s, uc, hb, W, H, key, make, dist) {
    const P = [this.P(corr, s, uc - W / 2, hb), this.P(corr, s, uc + W / 2, hb), this.P(corr, s, uc + W / 2, hb + H), this.P(corr, s, uc - W / 2, hb + H)];
    Render.texQuad(key, make, P, this.bright);
    // 뒷면 · 테두리 두께
    const Q = [this.P(corr, s + 0.12, uc - W / 2, hb), this.P(corr, s + 0.12, uc + W / 2, hb), this.P(corr, s + 0.12, uc + W / 2, hb + H), this.P(corr, s + 0.12, uc - W / 2, hb + H)];
    const back = Scene.haze(SIGN.back, dist);
    Scene.quad(Q[0], Q[1], Q[2], Q[3], back);
    Scene.quad(P[0], P[1], Q[1], Q[0], back); Scene.quad(P[3], P[2], Q[2], Q[3], back);
  },
  posts(corr, s, us, top, w, dist) {
    for (const u of us) {
      const a = this.P(corr, s, u, 0), g = this.road.at(corr.roadS(s));
      Scene.box(this.ctx, a[0], a[1], a[2] - 0.6, g.hdg, w, w, top + 0.6, 0, SIGN.steel, 1, dist, false);
    }
  },
  beam(corr, s, u0, u1, z, w, dist) {
    const a = this.P(corr, s, u0, z), b = this.P(corr, s, u1, z);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), h = Math.atan2(b[1] - a[1], b[0] - a[0]);
    Scene.box(this.ctx, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, h, L, w, w, -w / 2, SIGN.steel, 1, dist, false);
  },

  /* ----- 시설 ----- */
  /** 고리 바깥 접속점 (국소 s, u) — 나가는 램프와 들어오는 램프가 만나는 곳 */
  outer(corr, S) { return { s: S + RAMP_LEN, u: corr.rampLat(RAMP_LEN), dz: corr.rampDz(RAMP_LEN) }; },
  /** 국소 (s, u) 점들 → 진행 방향을 단 세계 점들 { x, y, z, dx, dy } (z 는 zf(i, 점) 로) */
  path(corr, su, zf) {
    const P = su.map(([s, u]) => this.P(corr, s, u, 0));
    return P.map((p, i) => {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      return { x: p[0], y: p[1], z: zf(i, p), dx: dx / L, dy: dy / L };
    });
  },
  /** 점 p 에서 진행 방향 오른쪽으로 off 만큼 */
  side(p, off, dz) { return [p.x + p.dy * off, p.y - p.dx * off, p.z + (dz || 0)]; },
  ground(x, y) { return Math.max(this.road.terrain(x, y), this.road.waterZ); },
  /**
   * 길 한 줄 — 노면(왼쪽 wl · 오른쪽 wr), 노면 표시, 난간, 그리고 땅과의 사이(성토 비탈 또는 교량 거더 · 교각).
   * o: { marks: [[off, w, color, dash]], par: [왼쪽, 오른쪽], parSkip(i, side), surf(i) 노면색, pierEvery }
   */
  strip(pts, wl, wr, o, d) {
    const ctx = this.ctx, night = this.sc.timeOfDay === 'night', pierC = '#b9b6ad';
    let run = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const seg = Math.hypot(b.x - a.x, b.y - a.y); run += seg;
      const depth = Render.depth(a.x, a.y, a.z);
      if (depth < -60 || depth > Render.drawDist + 300) continue;
      d = Math.max(1, Math.hypot(a.x - Render.cx, a.y - Render.cy, a.z - Render.cz));   // 안개는 이 조각까지의 거리로
      const asph = Scene.haze(night ? '#2c2c30' : '#4b4c50', d), bar = Scene.haze('#cfcdc4', d), deck = Scene.haze('#a9a69d', d), fillC = Scene.haze('#6d7f4b', d);
      const surf = o.surf ? Scene.haze(o.surf(i), d) : asph;
      Scene.quad(this.side(a, -wl), this.side(b, -wl), this.side(b, wr), this.side(a, wr), surf);
      for (const [off, w, col, dash] of o.marks || []) {
        if (dash && (Math.floor(run / dash) % 2)) continue;
        const c = Scene.haze(col, d);
        Scene.quad(this.side(a, off - w / 2, 0.03), this.side(b, off - w / 2, 0.03), this.side(b, off + w / 2, 0.03), this.side(a, off + w / 2, 0.03), c);
      }
      const forced = o.bridge && o.bridge(i);
      if (forced) Scene.quad(this.side(a, -wl, -1.8), this.side(b, -wl, -1.8), this.side(b, wr, -1.8), this.side(a, wr, -1.8), Scene.haze('#8f8c84', d));
      for (const [k, off] of [[0, -wl], [1, wr]]) {
        const e0 = this.side(a, off), e1 = this.side(b, off);
        const g0 = this.ground(e0[0], e0[1]), g1 = this.ground(e1[0], e1[1]);
        const h = Math.min(a.z - g0, b.z - g1);
        if (h > 2.6 || forced) {      // 교량 — 거더 옆면 (두께 1.8 m)
          Scene.quad([e0[0], e0[1], e0[2] - 1.8], [e1[0], e1[1], e1[2] - 1.8], e1, e0, deck);
        } else if ((a.z > g0 + 0.05 || b.z > g1 + 0.05) && !(o.noFill && o.noFill(i))) {   // 성토 — 1 : 1.5 비탈로 땅까지
          const s = off < 0 ? -1 : 1, w0 = Math.max(0, a.z - g0) * 1.5 + 0.5, w1 = Math.max(0, b.z - g1) * 1.5 + 0.5;
          const f0 = this.side(a, off + s * w0), f1 = this.side(b, off + s * w1);
          f0[2] = this.ground(f0[0], f0[1]) - 0.2; f1[2] = this.ground(f1[0], f1[1]) - 0.2;
          Scene.quad(e0, e1, f1, f0, fillC);
        }
        if ((o.par || [])[k] && !(o.parSkip && o.parSkip(i, k))) {
          Scene.quad(e0, e1, [e1[0], e1[1], e1[2] + 1.0], [e0[0], e0[1], e0[2] + 1.0], bar);
        }
      }
      // 교각 — 땅에서 높이 뜬 곳에만
      const pe = o.pierEvery || 3;
      if (i % pe === 1) {
        const gz = this.ground(a.x, a.y);
        if (a.z - gz > 3 && !(o.noPier && o.noPier(i))) {
          const hd = Math.atan2(a.dy, a.dx);
          for (const off of o.piers || [0]) {
            const q = this.side(a, off);
            Scene.box(ctx, q[0], q[1], gz, hd, 1.8, 1.8, a.z - 1.5 - gz, 0, pierC, 1, d, true);
          }
          const c = this.side(a, (wr - wl) / 2);
          Scene.box(ctx, c[0], c[1], a.z - 2.6, hd + Math.PI / 2, wl + wr - 1, 1.6, 1.1, 0, pierC, 1, d, false);
        }
      }
    }
  },

  /* ----- 나들목 영업소 -----
     바깥 접속점(O)에서 지방도 쪽으로 곧게 나가는 접속로 — 나가는 차는 우회전으로 들어가고, 들어오는 차는
     우회전으로 램프에 붙는다(T 자 + 곡선 둘). 접속로는 요금소 앞뒤로 넓어져 섬 · 부스 · 지붕이 서고,
     끝에서 일반국도와 신호 교차로로 만난다. 모두 국소 (s, u) 로 놓는다 — 본선과 직각인 방향이 +u. */
  TOLL: { nOut: 4, nIn: 3, hp: [2, 1], lane: 3.5, isl: 2.0, med: 1.0, v0: 125, vRoad: 300 },
  tollLanes() {
    const T = this.TOLL, out = [], inn = [];
    let e = T.med;                                  // 나가는 쪽(-s): 가운데 섬에서 바깥으로
    for (let i = 0; i < T.nOut; i++) { out.push(-(e + T.lane / 2)); e += T.lane + T.isl; }
    const wOut = e;
    e = T.med;
    for (let i = 0; i < T.nIn; i++) { inn.push(e + T.lane / 2); e += T.lane + T.isl; }
    return { out, inn, wOut, wIn: e };
  },
  tollPlaza(site) {
    const corr = site.corr, o = this.outer(corr, site.s), d = this.dist(corr, o.s, o.u + 150, 2400); if (d < 0) return;
    const ctx = this.ctx, rd = this.road, T = this.TOLL, z0 = this.P(corr, o.s, o.u, o.dz)[2] + 0.03;
    const night = this.sc.timeOfDay === 'night', g = rd.at(corr.roadS(o.s)), hdg = g.hdg + (corr.dir < 0 ? Math.PI : 0);
    const sC = o.s, uO = o.u, L = this.tollLanes(), V = (v) => uO + v;
    const W = (k) => this.P(corr, k[0], k[1], 0).slice(0, 2).concat([z0 + (k[2] || 0)]);
    const Q = (a, b, c, e, col) => Scene.quad(W(a), W(b), W(c), W(e), Scene.haze(col, d));
    const asphC = night ? '#2f3034' : '#4e4f53', concC = night ? '#55554f' : '#9d9b93';
    // 접속로 반폭 — 접속로 8 m, 요금소 앞뒤로 넓어진다
    const half = (v, side) => {
      const wide = side < 0 ? L.wOut + 0.6 : L.wIn + 0.6;
      const k = smoothstep((v - (T.v0 - 75)) / 50) * (1 - smoothstep((v - (T.v0 + 25)) / 50));
      return 8 + (wide - 8) * k;
    };
    const vs = []; for (let v = 3; v <= T.vRoad - 6; v += 5) vs.push(v);
    for (let i = 0; i + 1 < vs.length; i++) {
      const a = vs[i], b = vs[i + 1], plaza = a >= T.v0 - 28 && b <= T.v0 + 28;
      const col = plaza ? concC : asphC;
      Q([sC - half(a, -1), V(a)], [sC - half(b, -1), V(b)], [sC + half(b, 1), V(b)], [sC + half(a, 1), V(a)], col);
      for (const sd of [-1, 1]) {      // 가장자리 — 땅으로 내려가는 얕은 옆면
        const ea = sC + sd * half(a, sd), eb = sC + sd * half(b, sd);
        Q([ea, V(a)], [eb, V(b)], [eb, V(b), -1.2], [ea, V(a), -1.2], '#6d7f4b');
      }
    }
    // 램프에 붙는 곡선 둘 (나가는 차 · 들어오는 차 모두 우회전) — 모서리를 부채꼴로 채운다
    const R = 22;
    for (const sd of [-1, 1]) {
      const cs = sC + sd * (8 + R), cu = uO + 3.3 + R;
      for (let k = 0; k < 8; k++) {
        const a0 = Math.PI / 2 * k / 8, a1 = Math.PI / 2 * (k + 1) / 8;
        const p0 = [cs - sd * R * Math.cos(a0), cu - R * Math.sin(a0)], p1 = [cs - sd * R * Math.cos(a1), cu - R * Math.sin(a1)];
        Q([sC + sd * 8, uO + 3.3], p0, p1, [sC + sd * 8, uO + 3.3], asphC);
        Q(p0, p1, [p1[0], uO + 3.3], [p0[0], uO + 3.3], asphC);
      }
    }
    // 노면 표시 — 가운데 노란 겹선, 차로 점선, 하이패스 파란 유도선
    const line = (s0, v0, s1, v1, w, col) => {
      const dx = s1 - s0, dv = v1 - v0, l = Math.hypot(dx, dv) || 1, nx = -dv / l * w / 2, nv = dx / l * w / 2;
      Q([s0 + nx, V(v0) + nv, 0.03], [s1 + nx, V(v1) + nv, 0.03], [s1 - nx, V(v1) - nv, 0.03], [s0 - nx, V(v0) - nv, 0.03], col);
    };
    for (const [v0, v1] of [[6, T.v0 - 50], [T.v0 + 50, T.vRoad - 8]]) {
      line(sC - 0.2, v0, sC - 0.2, v1, 0.15, '#e2b93b'); line(sC + 0.2, v0, sC + 0.2, v1, 0.15, '#e2b93b');
      for (const sd of [-1, 1]) for (let v = v0; v < v1 - 3; v += 9) line(sC + sd * 4, v, sC + sd * 4, v + 4.5, 0.15, '#eceee6');
    }
    for (let i = 0; i < T.hp[0]; i++) line(sC + L.out[i], T.v0 - 70, sC + L.out[i], T.v0 + 14, 0.35, '#1f6fe0');
    for (let i = 0; i < T.hp[1]; i++) line(sC + L.inn[i], T.v0 + 70, sC + L.inn[i], T.v0 - 14, 0.35, '#1f6fe0');
    // 섬 · 부스 · 충격흡수대
    const islands = [0];
    let e = T.med; for (let i = 0; i < T.nOut; i++) { e += T.lane; islands.push(-(e + T.isl / 2)); e += T.isl; }
    e = T.med; for (let i = 0; i < T.nIn; i++) { e += T.lane; islands.push(e + T.isl / 2); e += T.isl; }
    const P3 = (s, v, dz) => { const p = this.P(corr, s, V(v), 0); return [p[0], p[1], z0 + (dz || 0)]; };
    for (const c of islands) {
      const w = c === 0 ? T.med * 2 : T.isl, m = P3(sC + c, T.v0);
      Scene.box(ctx, m[0], m[1], m[2], hdg + Math.PI / 2, 30, w, 0.28, 0, '#c9c6bd', 1, d, false);
      for (const v of [T.v0 - 15.5, T.v0 + 15.5]) {
        const q = P3(sC + c, v);
        Scene.box(ctx, q[0], q[1], q[2], hdg + Math.PI / 2, 1.4, w * 0.8, 1.0, 0, '#e8b90c', 1, d, false);
        Scene.box(ctx, q[0], q[1], q[2] + 0.35, hdg + Math.PI / 2, 1.42, w * 0.82, 0.25, 0, '#1d1d1d', 1, d, false);
      }
      if (c !== 0) {
        const b = P3(sC + c, T.v0 - 2);
        Scene.box(ctx, b[0], b[1], b[2] + 0.28, hdg + Math.PI / 2, 3.0, 1.5, 2.5, 0, '#eeeeea', 1, d, false);
        Scene.box(ctx, b[0], b[1], b[2] + 1.35, hdg + Math.PI / 2, 3.04, 1.54, 0.8, 0, '#3a4a5a', 1, d, false);
      }
    }
    // 지붕 — 기둥은 섬 위, 앞뒤 면에 이름 띠와 차로 표지
    const sL = sC - L.wOut - 1.2, sR = sC + L.wIn + 1.2, zr = 6.4, hr = 1.7, dep = 13;
    for (const c of islands) for (const v of [T.v0 - dep / 2 + 1.2, T.v0 + dep / 2 - 1.2]) {
      const q = P3(sC + c, v); Scene.box(ctx, q[0], q[1], q[2], hdg, 0.7, 0.7, zr, 0, '#d9dad6', 1, d, false);
    }
    const mid = P3((sL + sR) / 2, T.v0);
    Scene.box(ctx, mid[0], mid[1], mid[2] + zr, hdg, sR - sL, dep, hr, 0, '#eef0ec', 1, d, false);
    const face = (v, back) => {
      const a = back ? P3(sL, v, zr) : P3(sR, v, zr), b = back ? P3(sR, v, zr) : P3(sL, v, zr);
      this.panelFree(a, b, hr, `tollf:${site.name}:${back ? 1 : 0}`, () => this.texTollFace(site, back), d);
    };
    face(T.v0 - dep / 2 - 0.06, false);     // 나가는 차(+u 로 오는 차)가 보는 면
    face(T.v0 + dep / 2 + 0.06, true);      // 들어오는 차가 보는 면
    // 영업소 사무실 — 나가는 쪽 바깥
    const bo = P3(sL - 18, T.v0 + 10);
    Scene.box(ctx, bo[0], bo[1], bo[2], hdg, 20, 13, 7.2, 0, '#d8d4c8', 1, d, false);
    Scene.box(ctx, bo[0], bo[1], bo[2] + 2.2, hdg, 20.1, 13.1, 1.1, 0, '#4a5b6c', 1, d, false);
    Scene.box(ctx, bo[0], bo[1], bo[2] + 7.2, hdg, 21, 14, 0.5, 0, '#5d6066', 1, d, false);
    Q([sL - 30, V(T.v0 - 22)], [sL - 30, V(T.v0 - 2)], [sL - 6, V(T.v0 - 2)], [sL - 6, V(T.v0 - 22)], asphC);
    for (let k = 0; k < 4; k++) { const q = P3(sL - 26 + k * 6, T.v0 - 12); Scene.box(ctx, q[0], q[1], q[2], hdg + Math.PI / 2, 4.4, 1.8, 1.45, 0, ['#e6e8ea', '#202226', '#8b9198', '#9c2b2b'][k], 1, d, false); }
    // 일반국도 — 본선과 나란히, 접속로와 T 자 신호 교차로
    const vr = T.vRoad, hw = 7.5;
    for (let s = sC - 520; s < sC + 520; s += 20) {
      Q([s, V(vr - hw)], [s + 20, V(vr - hw)], [s + 20, V(vr + hw)], [s, V(vr + hw)], asphC);
      Q([s, V(vr + hw)], [s + 20, V(vr + hw)], [s + 20, V(vr + hw), -1.2], [s, V(vr + hw), -1.2], '#6d7f4b');
      if (Math.abs(s + 10 - sC) > 12) Q([s, V(vr - hw)], [s + 20, V(vr - hw)], [s + 20, V(vr - hw), -1.2], [s, V(vr - hw), -1.2], '#6d7f4b');
      line(s, vr - 0.2, s + 20, vr - 0.2, 0.15, '#e2b93b'); line(s, vr + 0.2, s + 20, vr + 0.2, 0.15, '#e2b93b');
      if (Math.abs(s + 10 - sC) > 14) for (const sd of [-1, 1]) { line(s, vr + sd * 3.7, s + 10, vr + sd * 3.7, 0.15, '#eceee6'); line(s, vr + sd * (hw - 0.4), s + 20, vr + sd * (hw - 0.4), 0.15, '#eceee6'); }
    }
    line(sC - 8, vr - hw - 1.5, sC, vr - hw - 1.5, 0.45, '#eceee6');     // 정지선
    // 신호등 — 교차로 모서리 기둥 · 팔 · 등
    const sp = P3(sC - 9.5, vr - hw - 2), sa = P3(sC - 4, vr - hw - 2, 6.2);
    Scene.box(ctx, sp[0], sp[1], sp[2], hdg, 0.32, 0.32, 6.4, 0, '#7d848a', 1, d, false);
    Scene.box(ctx, (sp[0] + sa[0]) / 2, (sp[1] + sa[1]) / 2, sa[2], hdg, 5.6, 0.2, 0.2, 0, '#7d848a', 1, d, false);
    Scene.box(ctx, sa[0], sa[1], sa[2] - 0.5, hdg, 1.4, 0.4, 0.5, 0, '#1b1d20', 1, d, false);
    // 지방도 방향 표지 — 교차로 앞, 파란 국도 번호와 좌우 갈 곳
    const sg = P3(sC + 9.5, vr - hw - 6);
    Scene.box(ctx, sg[0], sg[1], sg[2], hdg, 0.2, 0.2, 4.2, 0, SIGN.steel, 1, d, false);
    const ga = P3(sC + 11.6, vr - hw - 6, 2.4), gb = P3(sC + 7.4, vr - hw - 6, 2.4);
    this.panelFree(ga, gb, 2.0, `tolljn:${site.name}`, () => this.texJunction(site), d);
  },
  /** 영업소 지붕 앞면 — 위 띠에 이름, 아래에 차로마다 하이패스 · 일반 표지와 ↓ / ✕ */
  texTollFace(site, back) {
    const T = this.TOLL, L = this.tollLanes(), W = 4096, H = 160;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#eef0ec'; g.fillRect(0, 0, W, H);
    g.fillStyle = SIGN.green; g.fillRect(0, 0, W, H * 0.42);
    g.fillStyle = SIGN.white;
    this.text(g, `${site.inf.base} 영업소   ${this.roman(site.inf.base)} Tollgate`, W / 2, H * 0.33, H * 0.3, 800, 'center');
    // 차로 자리 → 그림 x (보는 사람의 왼쪽이 0)
    const sL = -L.wOut - 1.2, sR = L.wIn + 1.2, X = (c) => back ? (c - sL) / (sR - sL) * W : (sR - c) / (sR - sL) * W;
    const mine = back ? L.inn : L.out, theirs = back ? L.out : L.inn, nHp = back ? T.hp[1] : T.hp[0];
    const pw = T.lane / (sR - sL) * W * 0.9;
    mine.forEach((c, i) => {
      const x = X(c), hp = i < nHp;
      g.fillStyle = hp ? '#1450c8' : SIGN.green; g.fillRect(x - pw / 2, H * 0.5, pw * 0.72, H * 0.44);
      g.fillStyle = SIGN.white; this.fit(g, hp ? '하이패스' : '일반', x - pw / 2 + pw * 0.36, H * 0.86, H * 0.28, pw * 0.66, 800, 'center');
      g.fillStyle = '#0c0c0c'; g.fillRect(x + pw * 0.24, H * 0.5, pw * 0.26, H * 0.44);
      g.save(); g.translate(0, 0); this.arrowCol(g, x + pw * 0.37, H * 0.72, H * 0.3, '#39e36a'); g.restore();
    });
    theirs.forEach((c) => {
      const x = X(c);
      g.fillStyle = '#0c0c0c'; g.fillRect(x - H * 0.2, H * 0.5, H * 0.4, H * 0.44);
      g.strokeStyle = '#ff3b30'; g.lineWidth = H * 0.06;
      g.beginPath(); g.moveTo(x - H * 0.12, H * 0.6); g.lineTo(x + H * 0.12, H * 0.84); g.moveTo(x + H * 0.12, H * 0.6); g.lineTo(x - H * 0.12, H * 0.84); g.stroke();
    });
    return cv;
  },
  arrowCol(g, x, y, L, col) {
    g.fillStyle = col; g.fillRect(x - L * 0.08, y - L / 2, L * 0.16, L * 0.6);
    g.beginPath(); g.moveTo(x, y + L / 2); g.lineTo(x - L * 0.3, y + L * 0.08); g.lineTo(x + L * 0.3, y + L * 0.08); g.closePath(); g.fill();
  },
  /** 교차로 앞 일반국도 방향 표지 — 왼쪽 · 오른쪽 갈 곳과 국도 번호 */
  texJunction(site) {
    const { cv, g } = this.canvas(512, 256, SIGN.blue), inf = site.inf;
    this.natShield(g, 256, 70, 46, 34, inf.nat);
    g.fillStyle = SIGN.white;
    this.fit(g, '← ' + inf.dest[0], 30, 170, 64, 220, 800);
    this.fit(g, inf.dest[1] + ' →', 482, 170, 64, 220, 800, 'right');
    this.fit(g, this.roman(inf.dest[0]), 34, 222, 30, 200, 700);
    this.fit(g, this.roman(inf.dest[1]), 478, 222, 30, 200, 700, 'right');
    return cv;
  },

  /* ----- 분기점 -----
     램프 가운데(양방향 감속차로가 갈라지는 지점)에서 다른 고속도로가 본선을 직각으로 건너간다(교량).
     각 방향의 바깥 접속점에서 연결로가 바깥으로 크게 돌아(오른쪽 270°) 그 고속도로의 본선 쪽으로 가는
     차도에 오른쪽에서 합류한다 — 클로버형 고리와 같은 꼴. 두 방향의 고리는 서로 반대 사분면에 있다. */
  X: { W: 11.6, med: 1.0, R1: 110, R3: 110, cJ: 15.4 },
  jctPrep(site) {
    if (site.jx) return site.jx;
    const rd = this.road, corr = site.corr, X = this.X;
    const p = corr.roadS(site.s), g = rd.at(p);
    const nx = Math.sin(g.hdg), ny = -Math.cos(g.hdg), fx = Math.cos(g.hdg), fy = Math.sin(g.hdg);
    // 건너는 고속도로 — 횡거 t 마다 높이: 본선 위 8.5 m 교량에서 3.5 % 로 내려 땅(양옆 최고점) 위 0.8 m 까지
    const zc = g.z + 8.5, n = 241, pts = [], gr = [];
    for (let i = 0; i < n; i++) {
      const t = -2400 + i * 20, x = g.x + nx * t, y = g.y + ny * t;
      gr.push(Math.max(this.ground(x, y), this.ground(x + fx * X.W, y + fy * X.W), this.ground(x - fx * X.W, y - fy * X.W)));
    }
    for (let i = 0; i < n; i++) {
      let m = -1e9, k = 0, s = 0;
      for (let j = -2; j <= 2; j++) m = Math.max(m, gr[clamp(i + j, 0, n - 1)]);
      for (let j = -3; j <= 3; j++) { s += Math.max(m, gr[clamp(i + j, 0, n - 1)]); k++; }
      const t = -2400 + i * 20, bridge = zc - Math.max(0, Math.abs(t) - 60) * 0.035;
      pts.push({ x: g.x + nx * t, y: g.y + ny * t, z: Math.max(bridge, s / k + 0.8), dx: nx, dy: ny, t });
    }
    const zAt = (t) => { const f = clamp((t + 2400) / 20, 0, n - 1.001), i = Math.floor(f); return pts[i].z + (pts[i + 1].z - pts[i].z) * (f - i); };
    const tOf = (x, y) => (x - g.x) * nx + (y - g.y) * ny;
    /* 연결로 둘 (국소 s, u — 이 방향의 오른쪽 사분면, 모서리는 (S, 0)):
       고리   진출 램프 초입에서 갈라져 오른쪽으로 270° 돌아 건너는 길의 '본선 쪽으로 오는' 차도에 오른쪽에서 합류 (좌회전 이동)
       바깥   건너는 길의 같은 차도에서 멀리서 갈라져 큰 반지름으로 오른쪽으로 돌아 바깥 접속점 O 에서 진입 램프로 (우회전 이동)
       ★ 바깥 연결로는 고리를 둘러 가야 한다 — 고리를 모서리 가까이 작게(R 60), 바깥 연결로를 크게(O 까지) 두면 겹치지 않는다 */
    const o = this.outer(corr, site.s), S = site.s, RL = 60, sB = S + X.cJ + RL;
    const zOf = (s, u, dz) => this.P(corr, s, u, dz)[2];
    const mkRamp = (su, zf) => {
      const W0 = su.map(([s, u]) => this.P(corr, s, u, 0)), len = []; let acc = 0;
      for (let i = 0; i < W0.length; i++) { if (i) acc += Math.hypot(W0[i][0] - W0[i - 1][0], W0[i][1] - W0[i - 1][1]); len.push(acc); }
      return { pts: this.path(corr, su, (i, q) => zf(i, q, len[i] / acc, tOf(q[0], q[1]))), W0 };
    };
    // 고리
    const uB = corr.rampLat(sB - S), su1 = [];
    for (let k = 0; k <= 36; k++) { const a = Math.PI * 1.5 * k / 36; su1.push([sB + RL * Math.sin(a), uB + RL - RL * Math.cos(a)]); }
    const nL = su1.length;
    for (let u = uB + RL - 12; u >= 52; u -= 12) su1.push([S + X.cJ, u]);
    const zB = zOf(sB, uB, corr.rampDz(sB - S));
    const loop = mkRamp(su1, (i, q, f, t) => i >= nL - 1 ? zAt(t) + 0.02 : zB + (zAt(tOf(...this.P(corr, S + X.cJ, uB + RL, 0).slice(0, 2))) - zB) * smoothstep(i / (nL - 1)));
    // 바깥 연결로 — 건너는 길 (S+cJ, uD) 에서 갈라져 반지름 R2 로 O 까지
    const R2 = o.s - (S + X.cJ), uD = o.u + R2, su2 = [];
    for (let u = uD + 110; u > uD; u -= 12) su2.push([S + X.cJ, u]);
    const nD = su2.length;
    for (let k = 0; k <= 30; k++) { const a = Math.PI / 2 * k / 30; su2.push([S + X.cJ + R2 - R2 * Math.cos(a), uD - R2 * Math.sin(a)]); }
    const zO = zOf(o.s, o.u, o.dz);
    const outerR = mkRamp(su2, (i, q, f, t) => {
      if (i <= nD) return zAt(t) + 0.02;
      const z = zAt(tOf(...this.P(corr, S + X.cJ, uD, 0).slice(0, 2))) + (zO - zAt(tOf(...this.P(corr, S + X.cJ, uD, 0).slice(0, 2)))) * smoothstep((i - nD) / 30);
      return i > su2.length - 3 ? z : Math.max(z, this.ground(q[0], q[1]) + 0.5);
    });
    const tr = (W0, a, b) => { const t0 = tOf(W0[a][0], W0[a][1]), t1 = tOf(W0[b][0], W0[b][1]); return [Math.min(t0, t1) - 8, Math.max(t0, t1) + 8]; };
    const mergeSide = (loop.W0[nL][0] - g.x) * fx + (loop.W0[nL][1] - g.y) * fy > 0 ? 1 : 0;
    const gaps = [tr(loop.W0, nL - 1, loop.W0.length - 1), tr(outerR.W0, 0, nD)];
    const under = (i, isLoop) => { const q = (isLoop ? loop.pts : outerR.pts)[i]; return Math.abs(tOf(q.x, q.y)) < 70; };
    site.jx = { pts, loop: loop.pts, nL, outer: outerR.pts, nD, gaps, mergeSide, key: Math.round(p), under };
    return site.jx;
  },
  jct(site) {
    const d = this.dist(site.corr, site.s + 200, 120, 2800); if (d < 0) return;
    const J = this.jctPrep(site), X = this.X;
    // 건너는 고속도로 — 두 방향이 같은 것을 쓰므로 한 번만
    if (!this._crossDone.has(J.key)) {
      this._crossDone.add(J.key);
      const ln = X.med + 0.6, lw = 3.6;
      // 진행 방향(+n) 오른쪽이 -f — 건너는 길에서 본 오른쪽이 strip 의 + 쪽
      const skip = (i, k) => { const t = J.pts[i].t; return k === J.mergeSide && J.gaps.some(([a, b]) => t > a && t < b); };
      this.strip(J.pts, X.W, X.W, {
        marks: [[-ln, 0.18, '#e2b93b'], [ln, 0.18, '#e2b93b'], [-(ln + lw), 0.16, '#eceee6', 10], [ln + lw, 0.16, '#eceee6', 10],
          [-(ln + 2 * lw), 0.18, '#eceee6'], [ln + 2 * lw, 0.18, '#eceee6']],
        par: [1, 1], parSkip: skip, piers: [-6, 6], pierEvery: 2,
        noPier: (i) => Math.abs(J.pts[i].t) < 34 && Math.abs(J.pts[i].t) > 4,
        // ★ 본선 구간은 교량 — 땅(자연 지형)은 본선 깎기 비탈보다 높을 수 있어 성토면을 그리면 본선 위에 초록 판이 뜬다
        bridge: (i) => Math.abs(J.pts[i].t) < 70,
      }, d);
      // 가운데 분리대
      for (let i = 0; i + 1 < J.pts.length; i++) {
        const a = J.pts[i], b = J.pts[i + 1], dep = Render.depth(a.x, a.y, a.z);
        if (dep < -60 || dep > Render.drawDist + 300) continue;
        const c = Scene.haze('#cfcdc4', d);
        for (const off of [-0.3, 0.3]) Scene.quad(this.side(a, off), this.side(b, off), this.side(b, off, 0.9), this.side(a, off, 0.9), c);
        Scene.quad(this.side(a, -0.3, 0.9), this.side(b, -0.3, 0.9), this.side(b, 0.3, 0.9), this.side(a, 0.3, 0.9), c);
      }
      this.crossTraffic(J, d);
    }
    // 연결로 — 차로 하나 + 갓길, 건너는 길과 붙는 구간은 그쪽 난간을 비운다
    const opt = (nJoin, joinAtEnd) => ({
      marks: [[-1.8, 0.16, '#e2b93b'], [3.6, 0.16, '#eceee6']], par: [1, 1], piers: [1.1], pierEvery: 2,
      parSkip: (i, k) => k === 0 && (joinAtEnd ? i >= nJoin - 1 : i < nJoin),
      noFill: (i) => (joinAtEnd ? i >= nJoin - 1 : i < nJoin),          // 건너는 길에 붙은 구간 — 그 길의 비탈이 덮는다
      bridge: (i) => (joinAtEnd ? i >= nJoin - 1 : i < nJoin) && J.under(i, joinAtEnd),
    });
    this.strip(J.loop, 2.4, 4.6, opt(J.nL, true), d);
    this.strip(J.outer, 2.4, 4.6, opt(J.nD, false), d);
  },
  /** 건너는 고속도로의 차 — 시각만으로 정한 자리 (모의와 무관한 배경) */
  crossTraffic(J, d) {
    const T = performance.now() / 1000, cols = ['#e6e8ea', '#202226', '#8b9198', '#9c2b2b', '#2a4a86', '#d9d6cf', '#c9a227'];
    const n = J.pts.length, t0 = J.pts[0].t, span = J.pts[n - 1].t - t0;
    for (let k = 0; k < 28; k++) {
      const dir = k % 2 ? 1 : -1, lane = (k >> 1) % 2, v = 27 + (k % 5) * 2.5;
      let t = ((k * 523.7 + dir * T * v) % span + span) % span + t0;
      const f = (t - t0) / 20, i = Math.min(n - 2, Math.floor(f)), a = J.pts[i], b = J.pts[i + 1], r = f - i;
      const p = { x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r, z: a.z + (b.z - a.z) * r, dx: a.dx, dy: a.dy };
      const dep = Render.depth(p.x, p.y, p.z); if (dep < 2 || dep > 1400) continue;
      const off = -dir * (this.X.med + 0.6 + 1.8 + lane * 3.6);     // +n 으로 가는 차는 그 오른쪽(-f)
      const q = this.side(p, off), truck = k % 7 === 3;
      Scene.box(this.ctx, q[0], q[1], q[2], Math.atan2(p.dy, p.dx) + (dir < 0 ? Math.PI : 0), truck ? 10 : 4.5, truck ? 2.4 : 1.8, truck ? 3.2 : 1.45, 0, cols[k % cols.length], 1, dep, false);
    }
  },
  /** 휴게소 — 고리 바깥의 주차장 · 건물 · 주유소 · 기둥 간판 */
  restArea(site) {
    const corr = site.corr, o = this.outer(corr, site.s), d = this.near(corr, o.s, 2200); if (d < 0) return;
    const ctx = this.ctx, rd = this.road, z0 = o.dz + 0.05;
    const u0 = (a) => corr.rampLat(RAMP_LEN - Math.abs(a)) + corr.rampHalf(RAMP_LEN - Math.abs(a)) + 2;   // 램프 바깥 끝
    const U1 = o.u + 78, A = 230;
    const lot = Scene.haze(this.sc.timeOfDay === 'night' ? '#2f3034' : '#5a5b5f', d), wh = Scene.haze('#e8e8e2', d);
    // 바닥 판 · 옆면(둑) — 지형 위로 평평하게
    for (let a = -A; a < A; a += 20) {
      const b = a + 20;
      Scene.quad(this.P(corr, o.s + a, u0(a), z0), this.P(corr, o.s + b, u0(b), z0), this.P(corr, o.s + b, U1, z0), this.P(corr, o.s + a, U1, z0), lot);
      const e0 = this.P(corr, o.s + a, U1, z0), e1 = this.P(corr, o.s + b, U1, z0);
      Scene.quad(e0, e1, [e1[0], e1[1], e1[2] - 8], [e0[0], e0[1], e0[2] - 8], Scene.haze('#6f8150', d));
    }
    for (const a of [-A, A]) {   // 양끝 옆면
      const e0 = this.P(corr, o.s + a, u0(a), z0), e1 = this.P(corr, o.s + a, U1, z0);
      Scene.quad(e0, e1, [e1[0], e1[1], e1[2] - 8], [e0[0], e0[1], e0[2] - 8], Scene.haze('#6f8150', d));
    }
    // 주차면 줄 — 건물 앞 두 줄
    if (d < 900) for (const ub of [o.u + 14, o.u + 30]) for (let a = -150; a <= 110; a += 3) {
      const p = this.P(corr, o.s + a, ub, z0 + 0.02), q = this.P(corr, o.s + a + 0.15, ub + 5, z0 + 0.02), r = this.P(corr, o.s + a + 0.15, ub, z0 + 0.02), t = this.P(corr, o.s + a, ub + 5, z0 + 0.02);
      Scene.quad(p, r, q, t, wh);
    }
    // 세워 둔 차
    if (d < 700) {
      const g = rd.at(corr.roadS(o.s));
      const cols = ['#e6e8ea', '#202226', '#8b9198', '#9c2b2b', '#2a4a86', '#d9d6cf'];
      for (let a = -148, k = 0; a <= 108; a += 3, k++) for (const [ub, j] of [[o.u + 16.5, 0], [o.u + 32.5, 1]]) {
        if (((k * 7 + j * 3 + site.s) % 10) < 4) continue;
        const p = this.P(corr, o.s + a + 1.5, ub, z0);
        Scene.box(ctx, p[0], p[1], p[2], g.hdg + Math.PI / 2, 4.5, 1.8, 1.45, 0, cols[(k + j) % cols.length], 1, d, false);
      }
    }
    // 휴게소 건물 — 낮고 긴 몸통 · 처마 · 청색 이름 띠
    const g = rd.at(corr.roadS(o.s));
    const B = this.P(corr, o.s - 20, o.u + 58, z0);
    Scene.box(ctx, B[0], B[1], B[2], g.hdg, 90, 22, 7.5, 0, '#d9d3c4', 1, d, false);
    Scene.box(ctx, B[0], B[1], B[2] + 7.5, g.hdg, 96, 28, 0.8, 0, '#8d4a32', 1, d, false);
    // ★ 본선 쪽(−u)에서 +u 를 바라보면 진행 방향(+s)이 왼쪽 — 왼쪽 아래 점이 s+35 여야 글자가 안 뒤집힌다
    this.panelFree(this.P(corr, o.s - 20 + 35, o.u + 46.2, z0 + 4.6), this.P(corr, o.s - 20 - 35, o.u + 46.2, z0 + 4.6), 2.2, `restbld:${site.name}`, () => this.texRestBand(site), d);
    // 주유소 — 지붕 · 기둥 · 주유기
    const G = this.P(corr, o.s + 160, o.u + 22, z0);
    for (const [da, du] of [[-10, -6], [10, -6], [-10, 6], [10, 6]]) { const p = this.P(corr, o.s + 160 + da, o.u + 22 + du, z0); Scene.box(ctx, p[0], p[1], p[2], g.hdg, 0.6, 0.6, 5.2, 0, '#e6e6e0', 1, d, false); }
    Scene.box(ctx, G[0], G[1], G[2] + 5.2, g.hdg, 30, 20, 0.9, 0, '#eeeeea', 1, d, false);
    Scene.box(ctx, G[0], G[1], G[2] + 5.2, g.hdg, 30.4, 20.4, 0.35, 0.55, '#c8231c', 1, d, false);
    for (const da of [-8, 0, 8]) for (const du of [-3, 3]) { const p = this.P(corr, o.s + 160 + da, o.u + 22 + du, z0); Scene.box(ctx, p[0], p[1], p[2], g.hdg, 1.0, 0.6, 1.7, 0, '#dcdcd6', 1, d, false); }
    // 기둥 간판 — 본선에서 보이는 높은 청색 판
    const pu = o.u - 4, ps = o.s - 260;
    const pp = this.P(corr, ps, pu, z0);
    Scene.box(ctx, pp[0], pp[1], pp[2], g.hdg, 0.5, 0.5, 11, 0, SIGN.steel, 1, d, false);
    this.panel(corr, ps, pu, z0 + 11, 4.6, 4.6, `restpylon:${site.name}`, () => this.texRestPylon(site), d);
    // 나무 몇 그루 — 둘레
    for (let a = -200; a <= 200; a += 50) { const p = this.P(corr, o.s + a, U1 - 4, z0); Scene.box(ctx, p[0], p[1], p[2], 0, 0.4, 0.4, 2.4, 0, '#5a4632', 1, d, true); Scene.box(ctx, p[0], p[1], p[2] + 2.2, 0.4, 3.4, 3.4, 3.2, 0, '#3f6b35', 1, d, false); }
  },
  /** 두 점(아래 가장자리 왼쪽 · 오른쪽)과 높이로 세운 판 */
  panelFree(a, b, H, key, make, dist) {
    Render.texQuad(key, make, [a, b, [b[0], b[1], b[2] + H], [a[0], a[1], a[2] + H]], this.bright);
  },

  /* ---------- 표지 그림 (캔버스) ---------- */
  canvas(w, h, bg) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    // 흰 테 (둥근 모서리)
    g.strokeStyle = SIGN.white; g.lineWidth = Math.max(4, h * 0.022);
    const r = h * 0.06, m = g.lineWidth * 1.4;
    g.beginPath(); g.roundRect ? g.roundRect(m, m, w - m * 2, h - m * 2, r) : g.rect(m, m, w - m * 2, h - m * 2); g.stroke();
    g.fillStyle = SIGN.white; g.textBaseline = 'alphabetic';
    return { cv, g };
  },
  text(g, s, x, y, px, weight, align) { g.font = `${weight || 800} ${px}px ${SIGN.font}`; g.textAlign = align || 'left'; g.fillText(s, x, y); return g.measureText(s).width; },
  roman(base) { return ROMAN[base] || ''; },
  /** 화살표 — 굵은 막대 + 머리, ang 은 화면 기준(0 = 위, 시계방향 +) */
  arrow(g, x, y, L, ang, w) {
    g.save(); g.translate(x, y); g.rotate(ang); g.fillStyle = SIGN.white;
    const hw = w || L * 0.14, hh = L * 0.36;
    g.fillRect(-hw / 2, -L / 2 + hh * 0.9, hw, L - hh * 0.9);
    g.beginPath(); g.moveTo(0, -L / 2); g.lineTo(hh * 0.8, -L / 2 + hh); g.lineTo(-hh * 0.8, -L / 2 + hh); g.closePath(); g.fill();
    g.restore();
  },
  /** 고속국도 노선 방패 — 위 빨강 · 아래 파랑 · 흰 숫자 */
  shield(g, x, y, s, no) {
    g.save(); g.translate(x, y);
    const w = s, h = s * 1.08;
    const path = () => { g.beginPath(); g.moveTo(-w / 2, -h / 2); g.quadraticCurveTo(0, -h / 2 + h * 0.1, w / 2, -h / 2); g.lineTo(w / 2, h * 0.05); g.quadraticCurveTo(w / 2, h * 0.42, 0, h / 2); g.quadraticCurveTo(-w / 2, h * 0.42, -w / 2, h * 0.05); g.closePath(); };
    path(); g.fillStyle = '#ffffff'; g.fill();
    g.save(); path(); g.clip();
    g.fillStyle = '#1b4fa0'; g.fillRect(-w, -h, w * 2, h * 2);
    g.fillStyle = '#d42a26'; g.fillRect(-w, -h, w * 2, h * 0.78);      // 위 28 % 빨강
    g.restore();
    path(); g.lineWidth = s * 0.06; g.strokeStyle = '#ffffff'; g.stroke();
    g.fillStyle = '#ffffff'; g.font = `900 ${s * (no >= 100 ? 0.4 : 0.5)}px ${SIGN.font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(no), 0, h * 0.12);
    g.restore(); g.textBaseline = 'alphabetic';
  },
  /** 글씨를 maxW 안에 맞춘다 (넘치면 줄인다) — 그린 폭을 돌려준다 */
  fit(g, str, x, y, px, maxW, weight, align) {
    g.font = `${weight || 800} ${px}px ${SIGN.font}`;
    const w = g.measureText(str).width;
    if (w > maxW) { px *= maxW / w; }
    return this.text(g, str, x, y, px, weight, align);
  },
  /** 일반국도 번호 — 파란 타원 · 흰 테 · 흰 숫자 */
  natShield(g, x, y, rx, ry, no) {
    g.save();
    g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, TAU); g.fillStyle = SIGN.white; g.fill();
    g.beginPath(); g.ellipse(x, y, rx * 0.9, ry * 0.86, 0, 0, TAU); g.fillStyle = '#1d3ccf'; g.fill();
    g.fillStyle = SIGN.white; g.font = `800 ${ry * (no >= 10 ? 1.2 : 1.35)}px ${SIGN.font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(no), x, y + ry * 0.06);
    g.restore(); g.textBaseline = 'alphabetic';
  },
  /** 나가는 차로 그림 — 좁아지는 차로 둘과 오른쪽으로 갈라지는 화살표 */
  exitPicto(g, x, y, w, h) {
    g.save(); g.fillStyle = SIGN.white; g.strokeStyle = SIGN.white;
    g.beginPath(); g.moveTo(x, y + h); g.lineTo(x + w * 0.24, y + h); g.lineTo(x + w * 0.34, y); g.lineTo(x + w * 0.22, y); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(x + w * 0.42, y + h); g.lineTo(x + w * 0.58, y + h); g.lineTo(x + w * 0.56, y + h * 0.5); g.lineTo(x + w * 0.47, y + h * 0.5); g.closePath(); g.fill();
    g.lineWidth = w * 0.13; g.lineCap = 'butt';
    g.beginPath(); g.moveTo(x + w * 0.515, y + h * 0.56); g.quadraticCurveTo(x + w * 0.56, y + h * 0.22, x + w * 0.8, y + h * 0.2); g.stroke();
    g.beginPath(); g.moveTo(x + w, y + h * 0.18); g.lineTo(x + w * 0.74, y - h * 0.04); g.lineTo(x + w * 0.76, y + h * 0.44); g.closePath(); g.fill();
    g.restore();
  },
  /** 출구 꼬리표 — 검은 칸의 출구 번호 · 이름 · 나가는 차로 그림 */
  texTab(site) {
    const W = 1024, H = 280, inf = site.inf, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d'), m = 10, r = 26;
    const rr = (x, y, w, h, rad) => { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, rad) : g.rect(x, y, w, h); };
    g.fillStyle = SIGN.green; g.fillRect(0, 0, W, H);
    g.font = `800 172px ${SIGN.font}`;
    const wN = Math.max(250, g.measureText(String(inf.no)).width + 80);
    g.fillStyle = '#000'; rr(m + 12, m + 12, wN, H - 2 * (m + 12), r * 0.6); g.fill();
    g.fillStyle = SIGN.white; this.text(g, String(inf.no), m + 12 + wN / 2, H * 0.73, 172, 800, 'center');
    g.strokeStyle = SIGN.white; g.lineWidth = 12; rr(m, m, W - 2 * m, H - 2 * m, r); g.stroke();
    g.fillStyle = SIGN.white;
    this.fit(g, inf.base + (inf.type === 'jct' ? 'JC' : ''), m + wN + 60, H * 0.72, 160, W - wN - 330, 800);
    this.exitPicto(g, W - 230, 52, 180, 176);
    return cv;
  },
  /** 본판 — 나들목 · 분기점 (휴게소는 texRest). dist 가 없으면 출구 자리 표지(↗ 만) */
  texMain(site, dist) {
    const inf = site.inf, t = inf.type;
    if (t === 'rest') return this.texRest(site, dist);
    const { cv, g } = this.canvas(1024, 440, SIGN.green);
    if (t === 'jct') this.shield(g, 128, 220, 160, inf.route);
    else this.natShield(g, 128, 220, 88, 66, inf.nat);
    const dests = t === 'jct' ? inf.otherDest : [inf.base, inf.dest[0]];
    const x0 = 238, xR = 815;
    dests.forEach((p, i) => {
      const y = i ? 375 : 195;
      const w = this.fit(g, p, x0, y, 118, 280, 800);
      this.fit(g, this.roman(p), x0 + w + 20, y - 6, 56, xR - (x0 + w + 20), 700);
    });
    if (dist) { this.arrow(g, 912, 150, 180, Math.PI / 4, 48); this.fit(g, dist, 912, 392, 84, 160, 800, 'center'); }
    else this.arrow(g, 895, 225, 270, Math.PI / 4, 66);
    return cv;
  },
  /** 분기점 문형 표지 왼쪽 판 — 본선 (방패 · 갈 곳 · 차로마다 ↓) */
  texJctMain(site, nLanes, dist, aspect) {
    const W = 1024, H = Math.round(W / aspect / 2) * 2, { cv, g } = this.canvas(W, Math.min(1024, H), SIGN.green);
    const h = cv.height, dest = this.dirDest[site.corr.dir];
    this.shield(g, 120, h * 0.27, h * 0.34, this.mainRoute);
    const w = this.fit(g, dest, 230, h * 0.36, h * 0.245, W * 0.45, 800);
    this.fit(g, this.roman(dest), 250 + w, h * 0.35, h * 0.1, W * 0.3, 700);
    if (dist) this.text(g, dist, W - 50, h * 0.35, h * 0.18, 800, 'right');
    for (let i = 0; i < nLanes; i++) this.arrow(g, W * (i + 0.5) / nLanes, h * 0.75, h * 0.32, Math.PI, h * 0.05);
    return cv;
  },
  /** 분기점 문형 표지 오른쪽 판 — 갈라지는 노선 (방패 · 갈 곳 · ↘) */
  texJctOut(site, dist, aspect) {
    const W = 512, { cv, g } = this.canvas(W, Math.min(1024, Math.round(W / aspect)), SIGN.green), inf = site.inf, h = cv.height;
    this.shield(g, W / 2, h * 0.19, h * 0.26, inf.route);
    this.fit(g, inf.otherDest[0], W / 2, h * 0.5, h * 0.145, W * 0.86, 800, 'center');
    this.fit(g, inf.otherDest[1], W / 2, h * 0.67, h * 0.145, W * 0.86, 800, 'center');
    if (dist) this.text(g, dist, W / 2, h * 0.93, h * 0.14, 800, 'center');
    else this.arrow(g, W / 2, h * 0.84, h * 0.22, Math.PI / 4, h * 0.05);
    return cv;
  },
  texGore(word, bg) {
    const { cv, g } = this.canvas(512, 340, bg);
    this.fit(g, word, 256, 160, 136, 440, 900, 'center');
    this.arrow(g, 256, 262, 130, Math.PI / 4, 32);
    return cv;
  },
  texGoreJct(inf) {
    const { cv, g } = this.canvas(512, 340, SIGN.green);
    this.shield(g, 130, 150, 150, inf.route);
    this.fit(g, inf.otherDest[0], 360, 182, 100, 230, 900, 'center');
    this.arrow(g, 256, 280, 100, Math.PI / 4, 26);
    return cv;
  },
  /** 휴게소 시설 그림 — 흰 칸 안에 청색 그림 */
  pictos(g, x, y, s) {
    const items = ['fuel', 'food', 'wc', 'park'];
    items.forEach((it, i) => {
      const X = x + i * (s * 1.18);
      g.fillStyle = SIGN.white; g.beginPath(); g.roundRect ? g.roundRect(X, y, s, s, s * 0.1) : g.rect(X, y, s, s); g.fill();
      g.fillStyle = SIGN.blue; g.strokeStyle = SIGN.blue;
      const c = (a) => X + s * a, r = (a) => y + s * a;
      if (it === 'fuel') { g.fillRect(c(0.25), r(0.2), s * 0.34, s * 0.62); g.fillStyle = SIGN.white; g.fillRect(c(0.31), r(0.28), s * 0.22, s * 0.16); g.fillStyle = SIGN.blue; g.lineWidth = s * 0.06; g.beginPath(); g.moveTo(c(0.59), r(0.4)); g.lineTo(c(0.74), r(0.48)); g.lineTo(c(0.74), r(0.72)); g.stroke(); }
      if (it === 'food') { g.lineWidth = s * 0.06; for (const fx of [0.3, 0.38, 0.46]) { g.beginPath(); g.moveTo(c(fx), r(0.2)); g.lineTo(c(fx), r(0.42)); g.stroke(); } g.fillRect(c(0.35), r(0.4), s * 0.07, s * 0.42); g.beginPath(); g.moveTo(c(0.64), r(0.2)); g.quadraticCurveTo(c(0.78), r(0.35), c(0.66), r(0.5)); g.lineTo(c(0.66), r(0.82)); g.lineTo(c(0.6), r(0.82)); g.lineTo(c(0.6), r(0.2)); g.fill(); }
      if (it === 'wc') { for (const [hx, f] of [[0.32, 0], [0.68, 1]]) { g.beginPath(); g.arc(c(hx), r(0.24), s * 0.07, 0, TAU); g.fill(); if (f) { g.beginPath(); g.moveTo(c(hx), r(0.33)); g.lineTo(c(hx + 0.13), r(0.66)); g.lineTo(c(hx - 0.13), r(0.66)); g.fill(); g.fillRect(c(hx - 0.06), r(0.62), s * 0.04, s * 0.2); g.fillRect(c(hx + 0.02), r(0.62), s * 0.04, s * 0.2); } else { g.fillRect(c(hx - 0.08), r(0.33), s * 0.16, s * 0.28); g.fillRect(c(hx - 0.07), r(0.6), s * 0.05, s * 0.22); g.fillRect(c(hx + 0.02), r(0.6), s * 0.05, s * 0.22); } } g.fillRect(c(0.49), r(0.18), s * 0.02, s * 0.64); }
      if (it === 'park') { g.font = `900 ${s * 0.72}px ${SIGN.font}`; g.textAlign = 'center'; g.fillText('P', c(0.5), r(0.78)); }
    });
    g.fillStyle = SIGN.white;
  },
  /** 휴게소 본판 — dist 가 없으면 출구 자리 표지(↗ 만) */
  texRest(site, dist) {
    const { cv, g } = this.canvas(1024, 440, SIGN.blue), inf = site.inf;
    this.fit(g, inf.base + '휴게소', 60, 160, 136, 720, 800);
    this.fit(g, this.roman(inf.base) + ' Service Area', 64, 228, 52, 720, 700);
    this.pictos(g, 60, 262, 140);
    if (dist) { this.arrow(g, 912, 150, 180, Math.PI / 4, 48); this.fit(g, dist, 912, 392, 84, 160, 800, 'center'); }
    else this.arrow(g, 895, 225, 270, Math.PI / 4, 66);
    return cv;
  },
  texNextRest(km) {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 156;
    const g = cv.getContext('2d'); g.fillStyle = SIGN.blue; g.fillRect(0, 0, 1024, 156);
    g.strokeStyle = SIGN.white; g.lineWidth = 8; g.strokeRect(10, 10, 1004, 136);
    g.fillStyle = SIGN.white; this.text(g, '다음 휴게소', 50, 104, 70); this.text(g, km + 'km', 974, 108, 80, 900, 'right');
    return cv;
  },
  texRestBand(site) {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 64;
    const g = cv.getContext('2d'); g.fillStyle = SIGN.blue; g.fillRect(0, 0, 1024, 64);
    g.fillStyle = SIGN.white; this.text(g, site.inf.base + '휴게소   ' + this.roman(site.inf.base) + ' Service Area', 512, 46, 40, 800, 'center');
    return cv;
  },
  texRestPylon(site) {
    const { cv, g } = this.canvas(512, 512, SIGN.blue);
    this.text(g, site.inf.base, 256, 150, 110, 900, 'center');
    this.text(g, '휴게소', 256, 260, 96, 900, 'center');
    const k = 0.62, wP = (3 * 1.18 + 1) * 150 * k;
    g.save(); g.translate((512 - wP) / 2, 318); g.scale(k, k); this.pictos(g, 0, 0, 150); g.restore();
    return cv;
  },
};
