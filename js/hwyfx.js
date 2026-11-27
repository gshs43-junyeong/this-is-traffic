/* =============================================================================
   hwyfx.js — 고속도로 시설의 생김새: 도로 표지판 · 휴게소 · 영업소(요금소) · 분기점 연결로

   표지판 (한국 고속도로 안내표지와 비슷하게 — 녹색 바탕에 흰 글씨, 휴게소는 청색 바탕)
     놓는 자리   출구(감속차로 시작)까지 2 km · 1 km 는 차로 위 문형 표지, 500 m · 0 m 는 갓길 기둥에서 팔을 뻗은 외팔식 표지,
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
    this.jctBuildAll();
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
    const jx = this.jx || [];
    rd.terrain = (x, y) => {
      let z = rd._terr0(x, y);
      for (const p of rd.pads) {
        const dx = x - p.x, dy = y - p.y, a = Math.abs(dx * p.fx + dy * p.fy) - p.ha, b = Math.abs(-dx * p.fy + dy * p.fx) - p.hc;
        if (a > 35 || b > 35) continue;
        const d = Math.hypot(Math.max(0, a), Math.max(0, b)), w = 1 - smoothstep(d / 35);
        z = z + (p.z - z) * w;
      }
      // 분기점의 건너는 고속도로 — 노면보다 높은 땅은 깎는다(1 : 1.5 비탈). 본선 둘레(|t| < 90)는 본선 비탈 그대로
      for (const G of jx) {
        const dx = x - G.cx, dy = y - G.cy, t = dx * G.nx + dy * G.ny;
        if (Math.abs(t) < 90 || Math.abs(t) > this.JX.LEN + 20) continue;
        const w = Math.abs(dx * G.fx + dy * G.fy); if (w > 120) continue;
        const k = smoothstep((Math.abs(t) - 90) / 40), cap = this.zX(G, t) - 0.35 + Math.max(0, w - 16.5) / 1.5;
        if (z > cap) z = z + (cap - z) * k;
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
  /** 외팔식 표지 (500 m · 0 m) — 갓길 밖 기둥에서 팔을 뻗어 바깥 차로 위에 본판 (판 아래 5.6 m).
      ★ 기둥 · 팔은 판 뒤(s + 0.4)에 둔다 — 판과 같은 자리면 판 앞으로 튀어나와 글씨 위에 철봉이 보인다 */
  roadside(site, s, dist) {
    const corr = site.corr, d = this.near(corr, s); if (d < 0) return;
    const t = site.inf.type, W = 6.0, H = W / MAIN_AR, tabH = t === 'rest' ? 0 : H * 0.3, hb = 5.6;
    const eu = this.edgeU(corr, s), pu = eu + 1.4, uc = RoadStd.shL + RoadStd.laneW * (corr.nLane - 0.5) + 1.0, sb = s + 0.4;
    this.posts(corr, sb, [pu], hb + H + tabH + 0.2, 0.34, d);
    this.beam(corr, sb, uc - W / 2 + 0.3, pu, hb + H * 0.75, 0.24, d);
    this.beam(corr, sb, uc - W / 2 + 0.3, pu, hb + H * 0.25, 0.2, d);
    if (tabH) this.beam(corr, sb, uc + W / 2 - tabH * TAB_AR + 0.3, pu, hb + H + tabH * 0.5, 0.16, d);
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
      for (let mk = 0; mk < (o.marks || []).length; mk++) {
        const [off, w, col, dash] = o.marks[mk];
        if (dash && (Math.floor(run / dash) % 2)) continue;
        if (o.markSkip && o.markSkip(i, mk)) continue;
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
        // 난간 — 교량 · 높은 성토에만 (낮은 곳까지 세우면 기본 램프와 만나는 자리에서 벽이 뚝 끊겼다)
        if ((o.par || [])[k] && !(o.parSkip && o.parSkip(i, k)) && (h > 1.5 || forced)) {
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
    const sC = o.s, uO = o.u, L = this.tollLanes(), V = (v) => uO + v, hwR = 7.5;
    const W = (k) => this.P(corr, k[0], k[1], 0).slice(0, 2).concat([z0 + (k[2] || 0)]);
    const Q = (a, b, c, e, col) => Scene.quad(W(a), W(b), W(c), W(e), Scene.haze(col, d));
    const asphC = night ? '#2f3034' : '#4e4f53', concC = night ? '#55554f' : '#9d9b93';
    /* 접속로 — 한쪽 2 차로(중앙 0.5 · 차로 3.5 × 2 · 길어깨 0.5 = 반폭 8 m). 요금소 앞뒤 60 m 에 걸쳐 넓어진다.
       ★ 노면 표시는 모두 이 넓어짐(fan)과 같은 비율로 움직인다 — 따로 그으면 선이 요금 섬과 어긋났다 */
    const fan = (v) => smoothstep((v - (T.v0 - 90)) / 60) * (1 - smoothstep((v - (T.v0 + 30)) / 60));
    const half = (v, side) => { const wide = side < 0 ? L.wOut + 0.6 : L.wIn + 0.6; return 8 + (wide - 8) * fan(v); };
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
    // 노면 표시 — 선은 모두 접속로 자리(q)에서 요금 섬 자리(p)로 fan(v) 비율만큼 옮겨 간다
    const line = (s0, v0, s1, v1, w, col) => {
      const dx = s1 - s0, dv = v1 - v0, l = Math.hypot(dx, dv) || 1, nx = -dv / l * w / 2, nv = dx / l * w / 2;
      Q([s0 + nx, V(v0) + nv, 0.03], [s1 + nx, V(v1) + nv, 0.03], [s1 - nx, V(v1) - nv, 0.03], [s0 - nx, V(v0) - nv, 0.03], col);
    };
    const WH = '#eceee6', YE = '#e2b93b', BL = '#1f6fe0', vE = T.vRoad - hwR - 1.6, nose = 15.6;
    const path = (fq, v0, v1, w, col, dash, step) => {      // fq(v) → 가운데에서의 거리 (부호 포함)
      step = step || 2;
      for (let v = v0; v < v1 - 0.01; v += step) {
        const vb = Math.min(v1, v + step);
        if (dash && ((v - v0) % (dash * 2)) >= dash) continue;
        line(sC + fq(v), v, sC + fq(vb), vb, w, col);
      }
    };
    // 가운데 노란 겹선 — 접속로 끝에서 요금소 가운데 섬 코까지
    for (const sd of [-1, 1]) {
      path(() => sd * 0.25, 6, T.v0 - nose, 0.15, YE);
      path(() => sd * 0.25, T.v0 + nose, vE, 0.15, YE);
    }
    let D2 = null;
    for (const sd of [-1, 1]) {
      const isl = sd < 0 ? L.out.map((c, i) => -(Math.abs(c) + T.lane / 2 + T.isl / 2)) : L.inn.map((c) => c + T.lane / 2 + T.isl / 2);
      const n = isl.length, wide = (sd < 0 ? L.wOut : L.wIn);
      // 바깥 가장자리 실선
      path((v) => sd * (half(v, sd) - 0.9), 6, vE, 0.15, WH, 0, 3);
      /* 차로 경계 — 그 자리의 폭을 n 으로 고르게 나눈 자리에서 요금소 섬 가운데로 옮겨 간다.
         차로가 3 m 넘게 나올 만큼 넓어진 곳부터 긋고, 그때까지는 접속로의 가운데 점선이 이어진다 */
      const wOf = (v) => half(v, sd) - 0.9 - 0.5;
      const bnd = (k) => (v) => { const f = fan(v), ev = 0.5 + wOf(v) * k / n; return sd * (ev + (Math.abs(isl[k - 1]) - ev) * f * f); };
      const ok = (v) => wOf(v) / n >= 2.9;
      let vIn = T.v0 - 95; while (vIn < T.v0 && !ok(vIn)) vIn += 1;
      let vOut = T.v0 + 95; while (vOut > T.v0 && !ok(vOut)) vOut -= 1;
      D2 = { vIn, vOut };
      for (let k = 1; k < n; k++) {
        const fq = bnd(k);
        // 다가오는 쪽(나가는 차는 -v 쪽, 들어오는 차는 +v 쪽)은 섬 앞 24 m 를 실선(진로변경 제한), 그 앞은 점선
        if (sd < 0) { path(fq, vIn, T.v0 - nose - 24, 0.15, WH, 3); path(fq, T.v0 - nose - 24, T.v0 - nose, 0.15, WH); path(fq, T.v0 + nose, vOut, 0.15, WH, 3); }
        else { path(fq, T.v0 + nose, T.v0 + nose + 24, 0.15, WH); path(fq, T.v0 + nose + 24, vOut, 0.15, WH, 3); path(fq, vIn, T.v0 - nose, 0.15, WH, 3); }
      }
      // 접속로의 차로 점선 (2 차로) — 갈래 선이 시작될 때까지, 넓어지는 폭의 가운데를 따라
      path((v) => sd * (0.5 + wOf(v) / 2), 6, D2.vIn, 0.15, WH, 4.5);
      path((v) => sd * (0.5 + wOf(v) / 2), D2.vOut, vE, 0.15, WH, 4.5);
      // 하이패스 유도선 — 하이패스 차로 가운데를 따라 접속로 1 차로에서 부스까지 (파랑)
      const nHp = sd < 0 ? T.hp[0] : T.hp[1];
      for (let i = 0; i < nHp; i++) {
        const fL = i === 0 ? (v) => sd * (0.5 + (T.med - 0.5) * fan(v)) : bnd(i), fR = bnd(i + 1);
        const fq = (v) => (fL(v) + fR(v)) / 2;
        if (sd < 0) path(fq, Math.max(14, T.v0 - 130), T.v0 - nose, 0.4, BL, 0, 3);
        else path(fq, T.v0 + nose, Math.min(vE - 10, T.v0 + 130), 0.4, BL, 0, 3);
      }
    }
    // 부스 앞 정지선 대신 '서행' 띠 — 차로마다 섬 사이
    for (const [arr, sd] of [[L.out, -1], [L.inn, 1]]) for (const c of arr) {
      const v = sd < 0 ? T.v0 - nose - 4 : T.v0 + nose + 4;
      line(sC + c - 1.4, v, sC + c + 1.4, v, 0.4, WH);
    }
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
     다른 고속도로(왕복 4 차로 — 한쪽 2 차로)가 노즈 자리에서 본선을 거더 교량으로 직각으로 건넌다. 방향마다(이 차도 국소 좌표):
       고리     진출로가 노즈에서 JCT_LOOP_T 만큼 간 뒤 오른쪽으로 270° 돌아, 건너는 길(본선 쪽으로 오는 차도)에 붙어
                '차로 늘어남'으로 합류한다 — 늘어난 3 차로는 끝까지 이어진다.
       바깥     건너는 길 같은 차도의 '진출 전용' 3 차로가 끝나는 곳에서 갈라져 큰 반지름으로 오른쪽으로 돌아
                바깥 접속점 O 에서 본선 진입로로 이어진다(고리를 둘러 간다).
     모의의 분기점 진출 · 진입 차(traffic.js JCT_*)는 rampT 를 이 길 위의 거리로 읽어 그대로 달린다(rampPose).
     건너는 길의 1 · 2 차로에는 배경 차가 차로마다 같은 속도로 다닌다 — 앞지르지 않으니 겹칠 일이 없다.
     좌표: 교차점(노즈의 본선 중심) 기준 t = 본선 오른쪽(n) 거리, w = 본선 진행(f) 거리. 국소(tl, wl) = 방향 부호 × (t, w). */
  JX: { LEN: 1350, LW: 3.6, L1: 1.6, SHO: 2.8, C: 14.0, R2: 400, BR: 64 },
  /** w (한쪽 차도의 바깥쪽 거리) → 선 · 끝 */
  jxEdge(a) { return this.JX.L1 + this.JX.LW * (2 + a) + this.JX.SHO; },
  jctBuildAll() {
    this.jx = []; this.jdirs = [];
    const done = new Map();
    for (const site of this.sites) {
      if (site.inf.type !== 'jct') continue;
      const key = Math.round(site.corr.roadS(site.s));
      let G = done.get(key);
      if (!G) { G = this.jctGroup(key); done.set(key, G); this.jx.push(G); }
      const D = this.jctDir(G, site); G.dirs.push(D); this.jdirs.push(D);
    }
    for (const G of this.jx) G.cars = this.crossCars(G);
  },
  jctGroup(key) {
    const rd = this.road, g = rd.at(key), X = this.JX, T0 = rd._terr0 || rd.terrain.bind(rd);
    const G = { key, cx: g.x, cy: g.y, fx: Math.cos(g.hdg), fy: Math.sin(g.hdg), nx: Math.sin(g.hdg), ny: -Math.cos(g.hdg), z0: g.z, dirs: [] };
    /* 종단 — 본선 위 8.5 m 교량에서 시작해 지형을 따르되 경사 4 % 를 넘지 않는다.
       ★ 지형을 그대로 따르게 두면 먼 언덕을 수십 도로 오르내렸다(롤러코스터) — 깎기는 지형을 파서 맞춘다(levelPads) */
    const ds = 10, n = Math.round(2 * (X.LEN + 60) / ds) + 1, ts = [], gr = [];
    for (let i = 0; i < n; i++) {
      const t = -(X.LEN + 60) + i * ds; ts.push(t);
      let m = -1e9;
      for (const w of [-15, 0, 15]) { const p = this.W(G, t, w); m = Math.max(m, T0(p[0], p[1]), rd.waterZ); }
      gr.push(m);
    }
    const tgt = gr.map((_, i) => { let s = 0, k = 0; for (let j = -8; j <= 8; j++) { s += gr[clamp(i + j, 0, n - 1)]; k++; } return s / k + 1.2; });
    /* ★ 교량 높이는 본선 위 8.5 m 와, 본선 깎기 비탈 위 땅(|t| 40~110 m) + 0.8 m 중 높은 쪽 —
       깎기 구간에서 본선 기준으로만 잡으면 건너는 길이 본선 비탈 속에 묻혀 끊겨 보였다 */
    let zTop = -1e9;
    for (let i = 0; i < n; i++) if (Math.abs(ts[i]) > 40 && Math.abs(ts[i]) < 110) zTop = Math.max(zTop, gr[i]);
    const zc = Math.max(g.z + 8.5, zTop + 0.8), z = new Float32Array(n), ic = Math.round((0 - ts[0]) / ds), lim = 0.04 * ds;
    const bridge = (t) => Math.abs(t) <= X.BR - 4;
    for (let i = 0; i < n; i++) if (bridge(ts[i])) z[i] = zc;
    for (let i = ic + 1; i < n; i++) if (!bridge(ts[i])) z[i] = clamp(tgt[i], z[i - 1] - lim, z[i - 1] + lim);
    for (let i = ic - 1; i >= 0; i--) if (!bridge(ts[i])) z[i] = clamp(tgt[i], z[i + 1] - lim, z[i + 1] + lim);
    // 종단 곡선 — 꺾임을 둥글게 (교량 구간은 그대로)
    for (let pass = 0; pass < 3; pass++) {
      const z2 = z.slice();
      for (let i = 2; i < n - 2; i++) if (!bridge(ts[i])) z2[i] = (z[i - 2] + z[i - 1] + z[i] + z[i + 1] + z[i + 2]) / 5;
      z.set(z2);
    }
    G.ts = ts; G.zs = z; G.ds = ds; G.gr = gr;
    return G;
  },
  /** (t, w) → 세계 [x, y] */
  W(G, t, w) { return [G.cx + G.nx * t + G.fx * w, G.cy + G.ny * t + G.fy * w]; },
  TW(G, x, y) { const dx = x - G.cx, dy = y - G.cy; return [dx * G.nx + dy * G.ny, dx * G.fx + dy * G.fy]; },
  zX(G, t) {
    const f = clamp((t - G.ts[0]) / G.ds, 0, G.ts.length - 1.001), i = Math.floor(f);
    return G.zs[i] + (G.zs[i + 1] - G.zs[i]) * (f - i);
  },
  /** 한 방향의 고리 · 바깥 연결로 */
  jctDir(G, site) {
    const corr = site.corr, sg = corr.dir, X = this.JX, S = site.s, TB = JCT_LOOP_T;
    /* ★ 국소 좌표(tl 옆 · wl 앞)는 건너는 길 곁(wl < C + 6)에서는 곧은 교차 좌표, 멀어지면(C + 46 넘어) 본선을 따라
       휘는 좌표(본선 s = S + wl, 중심선에서 tl). 곧은 좌표만 쓰면 휘어 가는 본선이 고리 · 연결로 밑으로 파고들어
       난간만 본선 차로 위에 떠 보였다 */
    const rd = this.road, medAt = (s) => rd.at(corr.roadS(clamp(s, 0, corr.L))).med;
    const Wl = (tl, wl) => {
      const g0 = this.W(G, sg * tl, sg * wl), k = smoothstep((wl - X.C - 6) / 40);
      if (k <= 0) return g0;
      const p = this.P(corr, S + wl, tl - medAt(S + wl), 0);
      return [g0[0] + (p[0] - g0[0]) * k, g0[1] + (p[1] - g0[1]) * k];
    };
    const zAtL = (tl) => this.zX(G, sg * tl);
    const D = { corr, S, name: site.name, sg, G };
    const mk = (pts) => {           // [tl, wl, z] → { x, y, z, dx, dy } + 누적 길이
      const out = pts.map(([tl, wl, z]) => { const p = Wl(tl, wl); return { x: p[0], y: p[1], z, tl, wl, dx: 0, dy: 0 }; });
      const len = [0];
      for (let i = 0; i < out.length; i++) {
        const a = out[Math.max(0, i - 1)], b = out[Math.min(out.length - 1, i + 1)];
        const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; out[i].dx = dx / l; out[i].dy = dy / l;
        if (i) len.push(len[i - 1] + Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y));
      }
      return { pts: out, len, L: len[len.length - 1] };
    };
    const lane3 = X.L1 + X.LW * 2.5;                 // 3 차로 가운데 (10.6)
    // 고리 — 진출로 TB 지점에서
    const b0 = this.P(corr, S + TB, corr.rampLat(TB), corr.rampDz(TB));
    const t0 = corr.rampLat(TB) + medAt(S + TB), w0 = TB;
    const ph0 = Math.atan2(corr.rampLat(TB + 2) - corr.rampLat(TB), 2), RL = (w0 - X.C) / (1 + Math.sin(ph0));
    const loop = [], nArc = 64;
    let zM = zAtL(t0 + RL);
    for (let k = 0; k <= nArc; k++) {
      const ph = ph0 + (1.5 * Math.PI - ph0) * k / nArc;
      loop.push([t0 + RL * (-Math.cos(ph) + Math.cos(ph0)), w0 + RL * (Math.sin(ph) - Math.sin(ph0)), b0[2] + (zM - b0[2]) * smoothstep(k / nArc)]);
    }
    const tA = loop[loop.length - 1][0];
    D.mS = tA - 15; D.mE = tA - 85;                   // 합류 — 붙어 달리다(15 m) 70 m 에 걸쳐 3 차로로
    for (let tl = tA - 5; tl > -X.LEN; tl -= (tl > D.mE - 40 ? 5 : 20)) {
      const k = smoothstep((D.mS - tl) / (D.mS - D.mE));
      loop.push([tl, X.C + (lane3 - X.C) * k, zAtL(tl) - (tl > D.mE ? 0.03 : 0)]);
    }
    // ★ 땅 위로 — 사이를 직선으로 이으면 언덕에 묻힌다. 땅 + 0.5 m 아래로 내려가지 않게 하고 경사 6 % 로 다듬는다
    /* ★ 땅 위로 — 양 끝을 직선(종단)으로 이으면 사이의 언덕에 묻힌다. 땅 + 0.5 m 까지 올리되, 양 끝에서 6 % 로
       닿을 수 있는 높이까지만 — 그 이상 올리면 본선 깎기 구간의 시작점에서 계단이 졌다 */
    const lift = (arr, from, to) => {
      const d = [0];
      for (let i = from + 1; i <= to; i++) { const q0 = Wl(arr[i - 1][0], arr[i - 1][1]), q1 = Wl(arr[i][0], arr[i][1]); d.push(d[d.length - 1] + Math.hypot(q1[0] - q0[0], q1[1] - q0[1])); }
      const z0 = arr[from][2], z1 = arr[to][2], Lt = d[d.length - 1];
      for (let i = from + 1; i < to; i++) {
        const q = Wl(arr[i][0], arr[i][1]), k = i - from;
        const cap = Math.min(this.ground(q[0], q[1]) + 0.5, z0 + 0.06 * d[k], z1 + 0.06 * (Lt - d[k]));
        arr[i][2] = Math.max(arr[i][2], cap);
      }
    };
    /* ★ 고리는 본선 노면 높이 아래로 내려가지 않는다 — 본선이 오르막인 쪽(반대 방향)에서는 고리가 갈라진 자리의
       노면 · 풀밭 밑으로 묻혀 난간만 본선 곁에 떠 보였다 */
    for (let i = 0; i <= nArc; i++) {
      const [tl, wl] = loop[i], fl = this.P(corr, S + wl, tl - medAt(S + wl), 0)[2] + 0.04;
      loop[i][2] = Math.max(loop[i][2], fl);
    }
    lift(loop, 0, nArc);
    D.loop = mk(loop); D.nArc = nArc;
    D.loopEnd = D.loop.pts.findIndex((p) => p.tl <= D.mE);
    // 바깥 연결로 — 먼 곳의 진출 전용 3 차로 → 갈라짐 → 큰 원호 → O
    const o0 = this.P(corr, S + RAMP_LEN, corr.rampLat(RAMP_LEN), corr.rampDz(RAMP_LEN));
    const tO = corr.rampLat(RAMP_LEN) + medAt(S + RAMP_LEN), wO = RAMP_LEN;
    const R2 = Math.min(X.R2, wO - X.C - 25), tD = tO + R2;
    D.xS = tD + 90; D.xE = tD + 20;                   // 갈라짐 — 3 차로에서 70 m 에 걸쳐 빠져나와 50 m 붙어 달린다(tD+20 → tD)
    const out = [];
    for (let tl = X.LEN; tl > tD; tl -= (tl > D.xS + 40 ? 20 : 5)) {
      const k = smoothstep((D.xS - tl) / (D.xS - D.xE));
      out.push([tl, lane3 + (X.C - lane3) * k, zAtL(tl) - (tl < D.xS ? 0.03 : 0)]);
    }
    const zD = zAtL(tD), nA = 70, arcL = R2 * Math.PI / 2, strL = Math.max(0, wO - (X.C + R2));
    for (let k = 0; k <= nA; k++) {
      const ph = 1.5 * Math.PI + 0.5 * Math.PI * k / nA, f = (arcL * k / nA) / (arcL + strL);
      out.push([tD + R2 * (-Math.cos(ph)), X.C + R2 * (Math.sin(ph) + 1), zD + (o0[2] - zD) * smoothstep(f)]);
    }
    for (let w = X.C + R2 + 6; w < wO; w += 6) out.push([tO, w, zD + (o0[2] - zD) * smoothstep((arcL + w - X.C - R2) / (arcL + strL))]);
    out.push([tO, wO, o0[2]]);
    lift(out, out.findIndex((q) => q[0] <= tD), out.length - 1);
    D.onP = mk(out);
    D.onStart = D.onP.pts.findIndex((p) => p.tl < D.xS);
    return D;
  },
  /** 3 차로가 있나 (0 · 1) — 이 차도 국소 tl */
  jxLane3(D, tl) { return tl <= D.mE || tl >= D.xS ? 1 : 0; },
  /** 경로 위 거리 d 의 자리 */
  pathAt(P, d) {
    let lo = 0, hi = P.len.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P.len[m] <= d) lo = m; else hi = m; }
    const a = P.pts[lo], b = P.pts[hi], f = clamp((d - P.len[lo]) / Math.max(1e-6, P.len[hi] - P.len[lo]), 0, 1);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f + 0.03, hdg: Math.atan2(b.y - a.y, b.x - a.x) };
  },
  /** 모의 램프 차의 자리 — 분기점이 아니면 null (기본 램프 그대로) */
  rampPose(v, corr) {
    if (!this.jdirs || !this.jdirs.length) return null;
    if (v.onRamp) {
      if (!v.onRamp.jct || v.rampT <= RAMP_LEN) return null;
      const D = this.jdirs.find((x) => x.corr === corr && x.name === v.onRamp.name); if (!D) return null;
      const d = D.onP.L - (v.rampT - RAMP_LEN);
      return d < 0 ? { hide: true } : this.pathAt(D.onP, d);
    }
    if (v.rampT <= JCT_LOOP_T) return null;
    const S = v.s - v.rampT, D = this.jdirs.find((x) => x.corr === corr && Math.abs(x.S - S) < 1); if (!D) return null;
    const d = v.rampT - JCT_LOOP_T;
    return d > D.loop.L ? { hide: true } : this.pathAt(D.loop, d);
  },
  /** 건너는 길의 배경 차 — 차로마다 같은 속도 · 고정 간격 */
  crossCars(G) {
    const rng = new RNG(G.key * 31 + 7), cars = [], X = this.JX;
    const cfg = { limit: 100 };
    for (const side of [1, -1]) for (let lane = 0; lane < 2; lane++) {
      const v0 = lane === 0 ? 27.5 : 24.0, span = 2 * X.LEN;
      let ph = rng.range(0, 60);
      while (ph < span) {
        const r = rng.next(), cls = r < 0.78 ? 'car' : r < 0.93 ? 'truck' : 'bus';
        const v = new Vehicle().init(cls, rng, cfg);
        v.jx = { side, w: side * (X.L1 + X.LW * (lane + 0.5)), v0, ph };
        cars.push(v);
        ph += v.len + rng.range(lane === 0 ? 70 : 45, lane === 0 ? 260 : 190);
      }
    }
    return cars;
  },
  jct(site) {
    const G = this.jx && this.jx.find((g) => g.key === Math.round(site.corr.roadS(site.s))); if (!G) return;
    if (this._crossDone.has(G.key)) return;
    this._crossDone.add(G.key);
    const d0 = Math.hypot(G.cx - Render.cx, G.cy - Render.cy); if (d0 > 3200) return;
    this.crossRoad(G);
    for (const D of G.dirs) this.jctRamps(D);
    // 배경 차
    const T = this.sc.time || performance.now() / 1000, X = this.JX, span = 2 * X.LEN;
    for (const v of G.cars) {
      const q = v.jx, s = ((q.ph + q.v0 * T) % span + span) % span, t = q.side > 0 ? X.LEN - s : -X.LEN + s;
      const p = this.W(G, t, q.w), z = this.zX(G, t) + 0.03;
      const dep = Render.depth(p[0], p[1], z); if (dep < 1 || dep > Render.drawDist) continue;
      const h = Math.atan2(G.ny, G.nx) + (q.side > 0 ? Math.PI : 0);
      v.pose = { x: p[0], y: p[1], z, hdg: h }; v.v = q.v0; v.a = 0;
      Scene.vehicle(this.ctx, v, this.sc.corrA, this.sc);
    }
  },
  /** 건너는 고속도로 — 노면 · 노면 표시 · 중앙분리대 · 방호 · 교량(거더 · 교각) · 성토 */
  crossRoad(G) {
    const X = this.JX, night = this.sc.timeOfDay === 'night', ctx = this.ctx;
    const A = G.dirs.find((D) => D.sg > 0), B = G.dirs.find((D) => D.sg < 0);
    const a3 = (side, t) => { const D = side > 0 ? A : B; return D ? this.jxLane3(D, side * t) : 0; };
    // 붙어 달리는 연결로가 있는 곳 — 그쪽 방호를 비운다
    const attached = (side, t) => { const D = side > 0 ? A : B; if (!D) return false; const tl = side * t; return (tl < D.loop.pts[D.nArc].tl + 4 && tl > D.mE - 2) || (tl > D.xE - 60 && tl < D.xS + 2); };
    const P3 = (t, w, dz) => { const p = this.W(G, t, w); return [p[0], p[1], this.zX(G, t) + (dz || 0)]; };
    const stations = [];
    for (let t = -X.LEN; t < X.LEN; t += Math.abs(t) < 260 ? 5 : 20) stations.push(t);
    stations.push(X.LEN);
    let run = 0;
    for (let i = 0; i + 1 < stations.length; i++) {
      const ta = stations[i], tb = stations[i + 1], tm = (ta + tb) / 2;
      const pm = P3(tm, 0), d = Math.max(1, Math.hypot(pm[0] - Render.cx, pm[1] - Render.cy, pm[2] - Render.cz));
      run += tb - ta;
      const dep = Render.depth(pm[0], pm[1], pm[2]); if (dep < -40 || dep > Render.drawDist + 200) continue;
      const asph = Scene.haze(night ? '#2c2c30' : '#4b4c50', d), shoulder = Scene.haze(night ? '#323236' : '#55565a', d);
      const white = Scene.haze('#eceee6', d), yellow = Scene.haze('#e2b93b', d), conc = Scene.haze('#cfcdc4', d), deck = Scene.haze('#a9a69d', d), fillC = Scene.haze('#6d7f4b', d);
      const Q = (t0, t1, w0, w1, dz, col) => Scene.quad(P3(t0, w0, dz), P3(t1, w0, dz), P3(t1, w1, dz), P3(t0, w1, dz), col);
      const ga = Math.max(this.ground(...this.W(G, tm, -14)), this.ground(...this.W(G, tm, 14)));
      const zr = this.zX(G, tm), isBr = Math.abs(tm) < X.BR || zr - ga > 7;
      for (const side of [1, -1]) {
        const a = a3(side, tm), E = this.jxEdge(a), eL = X.L1 + X.LW * (2 + a);
        Q(ta, tb, side * 0.6, side * eL, 0, asph);
        Q(ta, tb, side * eL, side * E, 0, shoulder);
        if (d < 900) {
          Q(ta, tb, side * (X.L1 - 0.22), side * (X.L1 - 0.08), 0.03, yellow);                        // 안쪽 가장자리 — 황색
          const dash = (w, wid, on, per) => { if ((((side > 0 ? -run : run) % per) + per) % per < on) Q(ta, tb, side * (w - wid / 2), side * (w + wid / 2), 0.03, white); };
          dash(X.L1 + X.LW, 0.15, 8, 20);
          if (a) { const D = side > 0 ? A : B, tl = side * tm, nearX = D && (Math.abs(tl - D.mE) < 220 || Math.abs(tl - D.xS) < 300); dash(X.L1 + 2 * X.LW, nearX ? 0.3 : 0.15, nearX ? 3 : 8, nearX ? 6 : 20); }
          else Q(ta, tb, side * (eL + 0.08), side * (eL + 0.23), 0.03, white);
          if (a) Q(ta, tb, side * (eL + 0.08), side * (eL + 0.23), 0.03, white);
        }
        // 바깥 — 교량이면 콘크리트 난간 · 거더, 아니면 성토 비탈과 높은 곳만 가드레일
        const e0 = P3(ta, side * E), e1 = P3(tb, side * E);
        if (isBr) {
          Scene.quad([e0[0], e0[1], e0[2] - 1.8], [e1[0], e1[1], e1[2] - 1.8], e1, e0, deck);
          if (!attached(side, tm)) { Scene.quad(e0, e1, [e1[0], e1[1], e1[2] + 1.0], [e0[0], e0[1], e0[2] + 1.0], conc); Scene.quad([e0[0], e0[1], e0[2] + 1.0], [e1[0], e1[1], e1[2] + 1.0], P3(tb, side * (E - 0.4), 1.0), P3(ta, side * (E - 0.4), 1.0), conc); }
        } else {
          const g0 = this.ground(e0[0], e0[1]), g1 = this.ground(e1[0], e1[1]);
          if (e0[2] > g0 + 0.05 || e1[2] > g1 + 0.05) {
            const w0 = Math.max(0, e0[2] - g0) * 1.5 + 0.6, w1 = Math.max(0, e1[2] - g1) * 1.5 + 0.6;
            const f0 = P3(ta, side * (E + w0)), f1 = P3(tb, side * (E + w1));
            f0[2] = this.ground(f0[0], f0[1]) - 0.2; f1[2] = this.ground(f1[0], f1[1]) - 0.2;
            Scene.quad(e0, e1, f1, f0, fillC);
          }
          if (!attached(side, tm) && zr - Math.min(g0, g1) > 2.0) {
            const r0 = P3(ta, side * (E - 0.5)), r1 = P3(tb, side * (E - 0.5)), beam = Scene.haze('#b9b9b4', d);
            Scene.quad([r0[0], r0[1], r0[2] + 0.55], [r1[0], r1[1], r1[2] + 0.55], [r1[0], r1[1], r1[2] + 0.8], [r0[0], r0[1], r0[2] + 0.8], beam);
          }
        }
      }
      // 중앙분리대 — 콘크리트 방호벽
      Q(ta, tb, -0.3, -0.3, 0, conc);
      Scene.quad(P3(ta, -0.3), P3(tb, -0.3), P3(tb, -0.3, 0.9), P3(ta, -0.3, 0.9), conc);
      Scene.quad(P3(ta, 0.3), P3(tb, 0.3), P3(tb, 0.3, 0.9), P3(ta, 0.3, 0.9), conc);
      Q(ta, tb, -0.3, 0.3, 0.9, conc);
      if (isBr) {
        // 바닥판 아랫면 · 교각 (본선 차로 위에는 세우지 않는다)
        const Ea = this.jxEdge(a3(1, tm)), Eb = this.jxEdge(a3(-1, tm));
        Q(ta, tb, -Eb, Ea, -1.8, deck);
        const pier = (tp) => Math.abs(tp) > 30 && Math.floor(ta / 32) !== Math.floor(tb / 32);
        if (pier(tm)) {
          const gz = this.ground(...this.W(G, ta, 0)), hd = Math.atan2(G.fy, G.fx);
          for (const w of [-(Eb - 4), 0, Ea - 4]) { const q = P3(ta, w); Scene.box(ctx, q[0], q[1], Math.min(gz, q[2] - 2), hd, 1.8, 1.8, q[2] - 1.8 - Math.min(gz, q[2] - 2), 0, '#b9b6ad', 1, d, true); }
          const c = P3(ta, (Ea - Eb) / 2); Scene.box(ctx, c[0], c[1], c[2] - 3.0, hd, Ea + Eb - 2, 1.8, 1.2, 0, '#b9b6ad', 1, d, false);
        }
      }
    }
  },
  /** 한 방향의 고리 · 바깥 연결로와 합류 · 분류부 노면 표시 */
  jctRamps(D) {
    const X = this.JX, G = D.G, sg = D.sg, lane3 = X.L1 + X.LW * 2.5;
    const loopPts = D.loop.pts.slice(0, D.loopEnd + 1), onPts = D.onP.pts.slice(Math.max(0, D.onStart - 1));
    // 건너는 길에 붙어 달리는 구간 — 고리는 원호 다음, 바깥 연결로는 원호 앞
    const tD = D.xE - 20;
    for (let i = 0; i < D.loop.pts.length; i++) D.loop.pts[i].z3 = i >= D.nArc && D.loop.pts[i].tl > D.mE - 2;
    for (const p of D.onP.pts) p.z3 = p.tl >= tD - 0.5 && p.tl < D.xS + 2 && Math.abs(p.wl - X.C) < 6;
    const zone = (p) => p.z3;
    const under = (p) => Math.abs(p.tl) < X.BR && Math.abs(p.wl) < 22;      // 건너는 길 곁에서 본선 · 진출로 위를 지나는 곳
    const opt = (pts) => ({
      marks: [[-1.8, 0.15, '#e2b93b'], [1.85, 0.15, '#eceee6']], markSkip: (i, k) => k === 0 && zone(pts[i]),
      par: [1, 1], parSkip: (i, k) => k === 0 && zone(pts[i]), noFill: (i) => zone(pts[i]), bridge: (i) => under(pts[i]),
      piers: [1.1], pierEvery: 2,
    });
    this.strip(loopPts, 2.4, 4.6, opt(loopPts), 0);
    this.strip(onPts, 2.4, 4.6, opt(onPts), 0);
    // 합류 · 분류부 — 연결로 왼쪽 가장자리(흰 실선)와 그 사이 빗금
    const gore = (pts) => {
      let prev = null;
      for (const p of pts) {
        if (!zone(p)) { prev = null; continue; }
        const tl = p.tl, wr = p.wl - 1.8, w0 = X.L1 + 2 * X.LW + 0.08;
        if (prev && Math.abs(prev.tl - tl) > 0.5) {
          const dist = Math.max(1, Math.hypot(p.x - Render.cx, p.y - Render.cy, p.z - Render.cz));
          if (dist < 700) {
            const white = Scene.haze('#eceee6', dist);
            const L = (tt, ww) => { const q = this.W(G, sg * tt, sg * ww); return [q[0], q[1], this.zX(G, sg * tt) + 0.04]; };
            const pw = prev.wl - 1.8;
            if (pw - w0 > 0.15 || wr - w0 > 0.15) {
              Scene.quad(L(prev.tl, pw - 0.15), L(tl, wr - 0.15), L(tl, wr), L(prev.tl, pw), white);
              // 빗금 — 4 m 마다 비스듬히
              if (Math.floor(prev.tl / 4) !== Math.floor(tl / 4) && wr - w0 > 0.6) {
                const tm = Math.round(tl / 4) * 4;
                Scene.quad(L(tm, w0 + 0.1), L(tm + 0.35, w0 + 0.1), L(tm + 0.35 + (wr - w0) * 0.8, wr - 0.2), L(tm + (wr - w0) * 0.8, wr - 0.2), white);
              }
            }
          }
        }
        prev = p;
      }
    };
    gore(D.loop.pts.slice(0, D.loopEnd + 2)); gore(onPts);
    void lane3;
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
