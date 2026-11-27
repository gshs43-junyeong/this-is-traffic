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
      const [u0, u1, ha] = t === 'rest' ? [o.u - 6, o.u + 84, 250] : [o.u - 18, o.u + 18, 45];
      const c = this.P(corr, o.s, (u0 + u1) / 2, o.dz), f = this.P(corr, o.s + 1, (u0 + u1) / 2, o.dz);
      const fx = f[0] - c[0], fy = f[1] - c[1], L = Math.hypot(fx, fy) || 1;
      pads.push({ x: c[0], y: c[1], z: c[2] - 0.7, fx: fx / L, fy: fy / L, ha, hc: (u1 - u0) / 2 });
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
    this.ctx = ctx; this.sc = sc;
    for (const site of this.sites) {
      const corr = site.corr;
      const sr = corr.roadS(site.s), d0 = Math.abs(sr - sc.sCam);
      if (d0 > 3200) continue;
      const t = site.inf.type;
      this.signs(site, t);
      if (d0 < 2200) {
        if (t === 'rest') this.restArea(site);
        else if (t === 'jct') this.jctFlyover(site);
        else this.tollPlaza(site);
      }
    }
  },
  /** 그 자리가 지금 그릴 만큼 가깝고 앞에 있나 */
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
  /** 나들목 영업소 — 바깥 접속점 지붕 · 부스 · 바깥으로 나가는 지방도 */
  tollPlaza(site) {
    const corr = site.corr, o = this.outer(corr, site.s), d = this.near(corr, o.s, 2200); if (d < 0) return;
    const ctx = this.ctx;
    // 지방도 — 바깥 접속점에서 바깥으로 곧게 (지형을 따라)
    const p0 = this.P(corr, o.s, o.u + 3, o.dz), p1 = this.P(corr, o.s, o.u + 4, o.dz);
    const ox = p1[0] - p0[0], oy = p1[1] - p0[1], ol = Math.hypot(ox, oy) || 1, nx = ox / ol, ny = oy / ol, tx = -ny, ty = nx;
    const rd = this.road, ground = (x, y) => Math.max(rd.terrain(x, y), rd.waterZ) + 0.12;
    const asph = Scene.haze('#55575b', d), line = Scene.haze('#e2b93b', d);
    let prev = null;
    for (let k = 0; k <= 16; k++) {
      const x = p0[0] + nx * (k * 25), y = p0[1] + ny * (k * 25), z = k < 2 ? p0[2] + (ground(x, y) - p0[2]) * k / 2 : ground(x, y);
      const cur = [x, y, z];
      if (prev) {
        Scene.quad([prev[0] - tx * 4, prev[1] - ty * 4, prev[2]], [cur[0] - tx * 4, cur[1] - ty * 4, cur[2]], [cur[0] + tx * 4, cur[1] + ty * 4, cur[2]], [prev[0] + tx * 4, prev[1] + ty * 4, prev[2]], asph);
        Scene.quad([prev[0] - tx * 0.12, prev[1] - ty * 0.12, prev[2] + 0.02], [cur[0] - tx * 0.12, cur[1] - ty * 0.12, cur[2] + 0.02], [cur[0] + tx * 0.12, cur[1] + ty * 0.12, cur[2] + 0.02], [prev[0] + tx * 0.12, prev[1] + ty * 0.12, prev[2] + 0.02], line);
      }
      prev = cur;
    }
    // 영업소 — 램프 위를 건너는 지붕 (기둥 넷) · 부스 셋
    const s0 = o.s - 30, w = 12, g = rd.at(corr.roadS(s0));
    for (const du of [-w, -w / 3, w / 3, w]) { const a = this.P(corr, s0, o.u + du, o.dz); Scene.box(ctx, a[0], a[1], a[2], g.hdg, 0.6, 0.6, 5.6, 0, '#c9ccc8', 1, d, false); }
    const c1 = this.P(corr, s0, o.u, o.dz + 5.6);
    Scene.box(ctx, c1[0], c1[1], c1[2], g.hdg, 9, w * 2 + 2, 1.0, 0, '#eceee9', 1, d, false);
    for (const du of [-w * 2 / 3, 0, w * 2 / 3]) { const a = this.P(corr, s0, o.u + du, o.dz); Scene.box(ctx, a[0], a[1], a[2], g.hdg, 5, 1.6, 2.6, 0, '#d8dad6', 1, d, false); Scene.box(ctx, a[0], a[1], a[2] + 2.6, g.hdg, 5.4, 2.0, 0.25, 0, '#2b6fb3', 1, d, false); }
    // 지붕 앞 이름 띠 (오는 차 쪽)
    this.panel(corr, s0 - 4.6, o.u, o.dz + 5.65, w * 2 + 1.6, 0.95, `toll:${site.name}`, () => this.texToll(site), d);
  },
  /** 분기점 연결로 — 바깥 접속점에서 다른 고속도로 쪽으로 휘며 올라가는 고가 (2 차로 · 난간 · 교각) */
  jctFlyover(site) {
    const corr = site.corr, o = this.outer(corr, site.s), d = this.near(corr, o.s, 2400); if (d < 0) return;
    const ctx = this.ctx, rd = this.road;
    const p0 = this.P(corr, o.s, o.u, o.dz), pf = this.P(corr, o.s + 1, o.u, o.dz), po = this.P(corr, o.s, o.u + 1, o.dz);
    let fx = pf[0] - p0[0], fy = pf[1] - p0[1]; const fl = Math.hypot(fx, fy); fx /= fl; fy /= fl;
    let rx = po[0] - p0[0], ry = po[1] - p0[1]; const rl = Math.hypot(rx, ry); rx /= rl; ry /= rl;
    const R = 220, ang = Math.PI * 0.55, n = 40, pts = [];
    for (let i = 0; i <= n; i++) {        // 바깥 쪽으로 도는 원호 다음 곧은 길
      const a = ang * Math.min(1, i / (n * 0.6)), straight = Math.max(0, i / n - 0.6) * 900;
      const cx = p0[0] + rx * R, cy = p0[1] + ry * R;
      const x0 = cx - rx * R * Math.cos(a) + fx * R * Math.sin(a), y0 = cy - ry * R * Math.cos(a) + fy * R * Math.sin(a);
      const dx = rx * Math.sin(a) + fx * Math.cos(a), dy = ry * Math.sin(a) + fy * Math.cos(a);
      const x = x0 + dx * straight, y = y0 + dy * straight, z = p0[2] + 11 * smoothstep(i / (n * 0.55));
      pts.push({ x, y, z, dx, dy });
    }
    const asph = Scene.haze(shade(this.sc.timeOfDay === 'night' ? '#2c2c30' : '#4a4a4d', 1), d), deck = Scene.haze('#b7b4ac', d), bar = Scene.haze('#d2d0c8', d), wh = Scene.haze('#eceee6', d);
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[i + 1], w = 5.2;
      const L = (p, s) => [p.x - p.dy * w * s, p.y + p.dx * w * s, p.z];
      Scene.quad(L(a, -1), L(b, -1), L(b, 1), L(a, 1), asph);
      for (const s of [-1, 1]) {
        const e0 = L(a, s), e1 = L(b, s);
        Scene.quad(e0, e1, [e1[0], e1[1], e1[2] + 1.0], [e0[0], e0[1], e0[2] + 1.0], bar);
        Scene.quad([e0[0], e0[1], e0[2] - 1.4], [e1[0], e1[1], e1[2] - 1.4], e1, e0, deck);
        const m0 = L(a, s * 0.82), m1 = L(b, s * 0.82);
        Scene.quad([m0[0], m0[1], m0[2] + 0.02], [m1[0], m1[1], m1[2] + 0.02], [m1[0] - a.dy * 0.15 * s, m1[1] + a.dx * 0.15 * s, m1[2] + 0.02], [m0[0] - a.dy * 0.15 * s, m0[1] + a.dx * 0.15 * s, m0[2] + 0.02], wh);
      }
      if (i % 4 === 2 && a.z - p0[2] > 3) {
        const gz = Math.max(rd.terrain(a.x, a.y), rd.waterZ);
        Scene.box(ctx, a.x, a.y, gz, Math.atan2(a.dy, a.dx), 1.6, 1.6, a.z - 1.4 - gz, 0, '#bdbab2', 1, d, true);
      }
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
  texToll(site) {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 64;
    const g = cv.getContext('2d'); g.fillStyle = SIGN.green; g.fillRect(0, 0, 1024, 64);
    g.fillStyle = SIGN.white; this.text(g, site.inf.base + ' 영업소   ' + this.roman(site.inf.base) + ' Tollgate', 512, 46, 40, 800, 'center');
    return cv;
  },
};
