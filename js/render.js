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

// 본선 형상과 램프의 실제 접속 범위만 그린다.
const RAMP_VISUAL_EXTENSION = 0;

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
    const NEAR = 0.12, n = this._n;
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
  fill(style) {
    if (this.gl) { this.glPoly(style); this._n = 0; return; }
    if (this.path()) { this.ctx.fillStyle = style; this.ctx.fill(); }
    this._n = 0;
  },

  /* =====================================================================
     WebGL 백엔드 — 깊이 버퍼로 가림을 픽셀 단위로 판정한다.
     ★ 캔버스 2D 의 화가 알고리즘(먼 것부터 덧칠)은 면 순서가 조금만 어긋나도 앞차가
     깨지고, 근거리 면을 직접 잘라야 했다. 장면 코드는 그대로 두고 칠하는 곳만 바꾼다:
     fill() 이 다각형을 삼각형 버퍼에 쌓고, flush() 가 한 번에 GPU 로 그린다.
     WebGL 이 없거나 문맥을 잃으면 예전 캔버스 2D 경로로 그대로 돈다.
     ===================================================================== */
  layer: 0,            // 노면 위 표시(차선·그림자 등) 층 — 같은 면 위에서 깜빡이지 않게 카메라 쪽으로 당긴다
  initGL(canvas) {
    let gl = null;
    try { gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true, depth: true }); } catch (e) { gl = null; }
    if (!gl) return false;
    const sh = (type, src) => {
      const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
      return o;
    };
    const prog = (vs, fs) => {
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    };
    try {
      // 정점은 이미 카메라 좌표(오른쪽 x · 위 y · 앞 z)라 투영만 한다
      const VS = 'attribute vec3 p;attribute vec4 c;attribute vec2 q;uniform vec2 f;uniform vec2 d;varying vec4 v;varying vec2 w;' +
        'void main(){v=c;w=q;gl_Position=vec4(p.x*f.x,p.y*f.y,d.x*p.z+d.y,p.z);}';
      this.pSolid = prog(VS, 'precision mediump float;varying vec4 v;void main(){gl_FragColor=vec4(v.rgb*v.a,v.a);}');
      // 빛 번짐 — 사각형 안에서 가운데가 밝고 가장자리로 사라진다 (더하기 합성)
      this.pGlow = prog(VS, 'precision mediump float;varying vec4 v;varying vec2 w;void main(){float r=length(w);float k=clamp(1.0-r,0.0,1.0);k=k*k*(0.35+0.65*k);gl_FragColor=vec4(v.rgb*v.a*k,v.a*k);}');
    } catch (e) { console.warn('WebGL 셰이더 실패 — 캔버스 2D 로 그린다', e); return false; }
    this.gl = gl;
    this.vb = { p: gl.createBuffer(), c: gl.createBuffer(), q: gl.createBuffer() };
    const mk = () => ({ p: new Float32Array(3 * 65536), c: new Uint8Array(4 * 65536), q: null, n: 0 });
    this.bOp = mk(); this.bTr = mk(); this.bMk = mk();
    this.bGl = mk(); this.bGl.q = new Float32Array(2 * 65536);
    this.colCache = new Map();
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.gl = null; if (this.onLost) this.onLost(); });
    return true;
  },
  /** '#rgb' · '#rrggbb' · '#rrggbbaa' · 'rgb()' · 'rgba()' -> [r,g,b,a] (0~255). 같은 문자열은 다시 풀지 않는다 */
  color(str) {
    let c = this.colCache.get(str);
    if (c) return c;
    if (str[0] === '#') {
      let h = str.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      c = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255];
    } else {
      const m = str.match(/[\d.]+/g) || [0, 0, 0];
      c = [+m[0], +m[1], +m[2], m.length > 3 ? Math.round(+m[3] * 255) : 255];
    }
    if (this.colCache.size > 30000) this.colCache.clear();
    this.colCache.set(str, c);
    return c;
  },
  _grow(b, need) {
    if (b.n + need <= b.p.length / 3) return;
    let cap = b.p.length / 3; while (cap < b.n + need) cap *= 2;
    const p = new Float32Array(cap * 3); p.set(b.p); b.p = p;
    const c = new Uint8Array(cap * 4); c.set(b.c); b.c = c;
    if (b.q) { const q = new Float32Array(cap * 2); q.set(b.q); b.q = q; }
  },
  _vert(b, x, y, z, col, a) {
    const i = b.n++;
    b.p[i * 3] = x; b.p[i * 3 + 1] = y; b.p[i * 3 + 2] = z;
    b.c[i * 4] = col[0]; b.c[i * 4 + 1] = col[1]; b.c[i * 4 + 2] = col[2]; b.c[i * 4 + 3] = a;
  },
  glPoly(style) {
    const n = this._n;
    if (n < 3) return;
    const ax = this._ax, ay = this._ay, az = this._az;
    let front = false;
    for (let i = 0; i < n; i++) if (az[i] > 0.25) { front = true; break; }
    if (!front) return;                              // 통째로 카메라 뒤 — GPU 까지 보낼 필요 없다
    const col = this.color(style);
    const a = Math.round(col[3] * this.ctx.globalAlpha);
    if (a <= 0) return;
    const b = a < 250 ? this.bTr : this.bOp;
    this._grow(b, (n - 2) * 3);
    const k = 1 - this.layer * 0.0025;              // 층마다 시선 방향으로 0.25 % 당긴다 (화면 위치는 그대로)
    for (let i = 1; i < n - 1; i++) {
      this._vert(b, ax[0] * k, ay[0] * k, az[0] * k, col, a);
      this._vert(b, ax[i] * k, ay[i] * k, az[i] * k, col, a);
      this._vert(b, ax[i + 1] * k, ay[i + 1] * k, az[i + 1] * k, col, a);
    }
  },
  /** 카메라 좌표의 점 하나 */
  camPt(x, y, z) {
    const dx = x - this.cx, dy = y - this.cy, dz = z - this.cz;
    return [dx * this.rx + dy * this.ry + dz * this.rz, dx * this.ux + dy * this.uy + dz * this.uz, dx * this.fx + dy * this.fy + dz * this.fz];
  },
  /** 화면 크기가 고정된 표시(시선유도표 반사지·먼 미등·방향지시등). GL 에서는 깊이 판정을 받는다 */
  mark(x, y, z, wPx, hPx, style) {
    if (!this.gl) {
      const q = this.point(x, y, z); if (!q) return;
      this.ctx.fillStyle = style; this.ctx.fillRect(q.x - wPx / 2, q.y - hPx / 2, wPx, hPx);
      return;
    }
    const c = this.camPt(x, y, z);
    if (c[2] < 0.3) return;
    const k = 0.985, z0 = c[2] * k, sx = wPx / 2 * z0 / this.focal, sy = hPx / 2 * z0 / this.focal;
    const X = c[0] * k, Y = c[1] * k, col = this.color(style), b = this.bMk;
    this._grow(b, 6);
    this._vert(b, X - sx, Y - sy, z0, col, col[3]); this._vert(b, X + sx, Y - sy, z0, col, col[3]); this._vert(b, X + sx, Y + sy, z0, col, col[3]);
    this._vert(b, X - sx, Y - sy, z0, col, col[3]); this._vert(b, X + sx, Y + sy, z0, col, col[3]); this._vert(b, X - sx, Y + sy, z0, col, col[3]);
  },
  /** 빛 번짐 (반지름 rPx). GL 에서는 가려진 등불의 번짐이 앞차를 뚫고 보이지 않는다 */
  glow(x, y, z, rPx, inner, mid, alpha) {
    if (!this.gl) {
      const q = this.point(x, y, z); if (!q) return;
      const ctx = this.ctx, g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, rPx);
      g.addColorStop(0, inner); g.addColorStop(0.35, mid); g.addColorStop(1, inner.slice(0, 7) + '00');
      ctx.fillStyle = g; ctx.fillRect(q.x - rPx, q.y - rPx, rPx * 2, rPx * 2);
      return;
    }
    const c = this.camPt(x, y, z);
    if (c[2] < 0.3) return;
    const k = 0.97, z0 = c[2] * k, r = rPx * z0 / this.focal, X = c[0] * k, Y = c[1] * k;
    const col = this.color(inner.slice(0, 7)), a = Math.round(255 * (alpha == null ? 1 : alpha)), b = this.bGl;
    this._grow(b, 6);
    const V = (dx, dy) => { const i = b.n; this._vert(b, X + dx * r, Y + dy * r, z0, col, a); b.q[i * 2] = dx; b.q[i * 2 + 1] = dy; };
    V(-1, -1); V(1, -1); V(1, 1); V(-1, -1); V(1, 1); V(-1, 1);
  },
  glBegin() { this.bOp.n = this.bTr.n = this.bMk.n = this.bGl.n = 0; },
  glFlush() {
    const gl = this.gl; if (!gl) return;
    const W = gl.canvas.width, H = gl.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    const n = 0.25, F = 9000;
    const draw = (prog, b, withQ) => {
      if (!b.n) return;
      gl.useProgram(prog);
      const L = prog._loc || (prog._loc = {          // 위치는 프로그램마다 한 번만 찾는다
        f: gl.getUniformLocation(prog, 'f'), d: gl.getUniformLocation(prog, 'd'),
        p: gl.getAttribLocation(prog, 'p'), c: gl.getAttribLocation(prog, 'c'), q: gl.getAttribLocation(prog, 'q'),
      });
      gl.uniform2f(L.f, this.focal / (W / 2), this.focal / (H / 2));
      gl.uniform2f(L.d, (F + n) / (F - n), -2 * F * n / (F - n));
      const lp = L.p, lc = L.c, lq = L.q;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vb.p); gl.bufferData(gl.ARRAY_BUFFER, b.p.subarray(0, b.n * 3), gl.STREAM_DRAW);
      gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vb.c); gl.bufferData(gl.ARRAY_BUFFER, b.c.subarray(0, b.n * 4), gl.STREAM_DRAW);
      gl.enableVertexAttribArray(lc); gl.vertexAttribPointer(lc, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      if (lq >= 0) {
        if (withQ) {
          gl.bindBuffer(gl.ARRAY_BUFFER, this.vb.q); gl.bufferData(gl.ARRAY_BUFFER, b.q.subarray(0, b.n * 2), gl.STREAM_DRAW);
          gl.enableVertexAttribArray(lq); gl.vertexAttribPointer(lq, 2, gl.FLOAT, false, 0, 0);
        } else { gl.disableVertexAttribArray(lq); gl.vertexAttrib2f(lq, 0, 0); }
      }
      gl.drawArrays(gl.TRIANGLES, 0, b.n);
    };
    gl.disable(gl.BLEND);
    draw(this.pSolid, this.bOp, false);
    draw(this.pSolid, this.bMk, false);
    // 반투명(그림자) — 불투명 위에 순서대로, 깊이는 쓰지 않는다
    gl.enable(gl.BLEND); gl.depthMask(false);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    draw(this.pSolid, this.bTr, false);
    // 빛 번짐 — 더하기
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
    draw(this.pGlow, this.bGl, true);
    gl.depthMask(true); gl.disable(gl.BLEND);
  },
  /** 한 점의 화면 좌표 (뒤쪽이면 null) */
  point(x, y, z) {
    const dx = x - this.cx, dy = y - this.cy, dz = z - this.cz;
    const cz = dx * this.fx + dy * this.fy + dz * this.fz;
    if (cz < 0.12) return null;
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
    // 해 방향 단위벡터 — sky() 의 태양과 같은 방위·고도라 그림자 쪽이 하늘과 맞는다
    const sx = Math.cos(sc.sunAz) * 9000, sy = Math.sin(sc.sunAz) * 9000, sz = 2600;
    const sl = Math.hypot(sx, sy, sz);
    this.L = [sx / sl, sy / sl, sz / sl];

    // GL 이면 하늘·원경은 맨 아래 2D 캔버스에, 3D 는 GL 에, 효과는 맨 위 2D 캔버스에 그린다
    const skyCtx = Render.gl && sc.skyCtx ? sc.skyCtx : ctx;
    if (Render.gl) { ctx.clearRect(0, 0, W, H); Render.glBegin(); }
    this.sky(skyCtx, W, H, pal, sc);
    if (!sc.inTunnel) this.hills(skyCtx, W, H, pal, sc);
    this.corridor(ctx, sc);
    if (Render.gl) Render.glFlush();
    this.overlay(ctx, W, H, sc);
  },

  /* ---------- 빛 ----------
     면의 밝기 = 하늘빛(위를 볼수록 밝다) + 햇빛(해를 볼수록 밝다).
     고정 계수로 칠하던 때는 모든 차·비탈이 해와 무관하게 같은 쪽이 밝았다.
     색 계산만 바뀌므로 칠하는 다각형 수는 늘지 않는다. */
  lit(nx, ny, nz) {
    const L = this.L, d = nx * L[0] + ny * L[1] + nz * L[2];
    return 0.50 + 0.30 * (nz > 0 ? nz : 0) + 0.45 * (d > 0 ? d : 0);
  },
  /** 세 점이 만드는 면의 위쪽 법선으로 밝기 계수를 낸다 (지면·비탈용) */
  litPts(a, b, c) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    return this.lit(nx / l, ny / l, nz / l);
  },
  /** 지면 사각형 — 면 방향으로 음영을 넣고, 띠마다 아주 조금 색을 흔들어 단조로움을 깬다 */
  groundQuad(a, b, c, d, base, dist, seed) {
    const f = this.litPts(a, b, d) / 0.88;           // 평지(위를 보는 면)가 원래 색이 되게
    const j = seed != null ? 0.96 + ihash(seed) * 0.08 : 1;
    this.quad(a, b, c, d, this.haze(shade(base, f * j * this.pal.amb + (1 - this.pal.amb) * 0.5), dist));
  },
  /** 본선과 램프가 같은 아스팔트 색을 쓰게 한다 (3 m 칸마다 아주 조금 다른 명도) */
  roadTone(sRoad, dist) {
    const mot = dist < 260 ? 0.94 + ihash(Math.floor(sRoad / 3)) * 0.12 : 1;
    return this.haze(shade(this.pal.road, mot), dist);
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
      this.clouds(ctx, H, pal, sc);
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

  /** 구름 — 아주 먼 하늘의 고정된 점을 실제 카메라로 투영해 그린다. 고개·롤에 따라 하늘과
      함께 움직이고, 구름 하나가 타원 몇 개라 프레임 비용은 무시할 만하다. */
  clouds(ctx, H, pal, sc) {
    const cam = sc.cam, rng = new RNG(11);
    const col = sc.timeOfDay === 'dusk' ? '255,214,180' : '255,255,255';
    for (let i = 0; i < 9; i++) {
      const az = rng.next() * TAU, el = 0.10 + rng.next() * 0.22, D = 30000;
      const big = 0.6 + rng.next() * 0.9, puffs = 3 + (rng.next() * 3 | 0);
      const q = Render.point(cam.x + Math.cos(az) * D, cam.y + Math.sin(az) * D, cam.z + Math.tan(el) * D);
      const r0 = rng.next(), r1 = rng.next();
      if (!q) continue;
      const w = H * 0.16 * big;
      if (q.x < -w * 2 || q.x > Render.W + w * 2 || q.y < -w || q.y > Render.horizon) continue;
      ctx.fillStyle = `rgba(${col},${(0.38 + r0 * 0.22).toFixed(2)})`;
      ctx.beginPath();
      for (let k = 0; k < puffs; k++) {
        const ox = (k - (puffs - 1) / 2) * w * 0.42, oy = -Math.sin((k + 0.5) / puffs * Math.PI) * w * 0.10 * (0.6 + r1);
        ctx.ellipse(q.x + ox, q.y + oy, w * (0.30 + 0.12 * Math.sin(k * 2.3 + r1 * 5)), w * 0.10, 0, 0, TAU);
      }
      ctx.fill();
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
        if (t < 0 || t > corr.rampLen + RAMP_VISUAL_EXTENSION) continue;
        s.nearIC = true;
        // 램프가 실제로 놓인 구간에서만 비탈면을 잘라 노면을 보존한다.
        const tc = clamp(t, 0, corr.rampLen + RAMP_VISUAL_EXTENSION);
        const inU = corr.rampLat(tc) - corr.rampHalf(tc);
        const outU = corr.rampLat(tc) + corr.rampHalf(tc) + 1.6;
        // 지면 띠는 본선 갓길 바깥에서 시작해 램프 안쪽 경계에서 끝난다.
        // 노즈 부근에서는 램프가 본선에 붙으므로 그 사이가 0 이 되고, 지면은 안 그려진다.
        const side = corr.dir > 0 ? 1 : -1;
        const edge = side * (m + outU);
        const [foot, footZ] = this.rampFoot(s, edge, g.z + rd.crossZ(g, edge) + corr.rampDz(tc), side);
        if (corr.dir > 0) s.rampR = { in: Math.max(m + inU, s.aSh + 0.8), out: edge, foot, footZ };
        else s.rampL = { in: Math.min(-(m + inU), s.bSh - 0.8), out: edge, foot, footZ };
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

  /** 램프 갓길 끝(u, z)에서 본선과 같은 경사(성토 1:1.8 · 절토 1:1.2)로 내려·올라가
      지형과 만나는 비탈 끝. ★ 14 m 고정 폭으로 그리면 높은 성토 옆에서 48 m 짜리
      벽이 서고, 그 벽이 늦은 램프 패스에서 가까운 갓길·가드레일을 덮었다. */
  rampFoot(sec, u, z, side) {
    const t0 = this.terrAt(sec, u);
    const fill = z >= t0, k = fill ? -1 / 1.8 : 1 / 1.2;
    let w = 0, zz = z;
    for (let i = 0; i < 40; i++) {
      const nw = w + 3, zs = z + k * nw, zt = this.terrAt(sec, u + side * nw);
      if (fill ? zs <= zt : zs >= zt) { w = nw; zz = zt; break; }
      w = nw; zz = zs;
    }
    return [u + side * Math.max(w, 2), zz];
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
    /* ★ 단면은 세계 좌표 격자(4·8·16·32·64 m 의 배수)에 고정한다. 카메라 위치에서 세면
       매 프레임 단면이 미끄러져 같은 산이 조금씩 다른 모양으로 다시 샘플링되고, 지형이
       꿈틀거리며 불연속적으로 움직였다. 굵은 격자점은 고운 격자점의 부분집합이라
       거리 띠가 바뀌어도 이미 있던 꼭짓점만 빠진다. */
    let s = Math.floor(Math.max(0, s0) / 4) * 4;
    while (s < s1) {
      stations.push(s);
      const d = Math.abs(s - sc.sCam);
      let step = d < 60 ? 4 : d < 170 ? 8 : d < 380 ? 16 : d < 700 ? 32 : 64;
      if (rd.struct[rd.idxOf(s)] === 2 && step > 8) step = 8;
      s = (Math.floor(s / step + 1e-6) + 1) * step;
    }
    stations.push(Math.min(s1, rd.len - 0.01));
    // 터널·교량 경계는 스트립 간격과 무관하게 정확한 지점에서 끊어 포털 틈을 막는다.
    for (const st of rd.structs) {
      if (st.s0 > s0 && st.s0 < s1) stations.push(st.s0);
      if (st.s1 > s0 && st.s1 < s1) stations.push(st.s1);
    }
    // 이 프레임에 보일 램프만 미리 추린다 (스트립마다 전수 검사하면 프레임을 깎아먹는다)
    const near = [];
    for (const corr of [sc.corrA, sc.corrB]) {
      if (!corr) continue;
      const sCamL = corr.dir > 0 ? sc.sCam : corr.L - sc.sCam;
      const lo = sCamL - 420, hi = sCamL + Render.drawDist + 420;
      const rampDrawLen = corr.rampLen + RAMP_VISUAL_EXTENSION;
      for (const r of corr.onRamps) if (r.s > lo && r.s - rampDrawLen < hi) near.push({ corr, s: r.s, on: 1 });
      for (const o of corr.offRamps) if (o.s + rampDrawLen > lo && o.s < hi) near.push({ corr, s: o.s, on: 0 });
    }
    this.activeRamps = near;
    // 램프의 실제 시작·끝을 단면 경계와 맞춰 지형 절단과 접속부 틈을 막는다.
    for (const e of near) {
      const len = e.corr.rampLen + RAMP_VISUAL_EXTENSION;
      const ends = e.on ? [e.s - len, e.s] : [e.s, e.s + len];
      for (const localS of ends) {
        const roadS = e.corr.dir > 0 ? localS : e.corr.L - localS;
        if (roadS > s0 && roadS < s1) stations.push(roadS);
      }
    }
    stations.sort((a, b) => a - b);
    for (let i = stations.length - 1; i > 0; i--) {
      if (stations[i] - stations[i - 1] < 0.01) stations.splice(i, 1);
    }

    // 차량을 스트립 구간별로 담는다. 램프와 카메라 가까이 있는 차는 지면에
    // 다시 덮이지 않도록 월드 표면을 다 그린 뒤 마지막에 그린다.
    const buckets = new Array(stations.length);
    this.lateVeh = [];
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

    /* 램프는 본선을 다 그린 뒤에 따로 얹는다.
       본선 비탈면은 폭이 150 m 나 되는 평면이라 깊이가 24~150 m 에 걸친다.
       화가 알고리즘으로는 그 한 장과 저 앞의 램프 사이 순서를 맞출 수 없어서,
       가까운 비탈면이 앞쪽 램프를 통째로 덮어 버린다.
       인터체인지는 평탄하고 구조물이 없는 자리에만 놓이므로, 나중에 얹어도
       지형에 가려야 할 것을 잘못 덮을 일이 없다. */
    if (this.activeRamps && this.activeRamps.length) {
      for (let i = stations.length - 2; i >= 0; i--) {
        const d = Math.abs(stations[i] - sc.sCam);
        this.rampSurf(ctx, secs[i], secs[i + 1], d, sc);
      }
    }
    if (this.lateVeh.length) {
      this.lateVeh.sort((p, q) => q.d - p.d);
      for (const e of this.lateVeh) this.vehicle(ctx, e.v, e.corr, sc);
    }
  },

  /* ★ 차는 '카메라 쪽 끝'이 속한 스트립 뒤에 그린다. 앞범퍼 기준으로 묶으면 뒤에서 본
     차의 뒷부분이 더 가까운 스트립에 걸쳐, 그 스트립의 노면이 나중에 칠해지며 차 아랫부분을
     잘라 먹었다. 또 앞범퍼가 카메라 뒤로 넘어간 차(옆을 스치는 차)는 뒷부분이 보이는데도
     통째로 사라졌다 — 양 끝 중 하나라도 앞에 있으면 그린다. */
  bucket(buckets, stations, corr, v, sc) {
    const rd = this.road;
    const sF = corr.roadS(v.s), sR = corr.roadS(v.s - v.len);
    const dAt = (sr) => {
      const g = rd.at(sr);
      const u = corr.dir > 0 ? (g.med + v.u) : -(g.med + v.u);
      return Render.depth(g.x + Math.sin(g.hdg) * u, g.y - Math.cos(g.hdg) * u, g.z + 1 + (v.dz || 0));
    };
    const dF = dAt(sF), dR = dAt(sR);
    if (dF < 0.12 && dR < 0.12) return;
    const d = 0.5 * (dF + dR);
    if (v.onRamp || v.lane === -1 || Math.min(dF, dR) < 24) { this.lateVeh.push({ v, corr, d }); return; }
    const sNear = Math.abs(sF - sc.sCam) < Math.abs(sR - sc.sCam) ? sF : sR;
    if (sNear < stations[0] || sNear > stations[stations.length - 1]) return;
    let lo = 0, hi = stations.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (stations[m] <= sNear) lo = m; else hi = m - 1; }
    (buckets[lo] || (buckets[lo] = [])).push({ v, corr, d });
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
      const G = pal.grass, sd = Math.floor(a.sRoad / 37) * 8;   // 띠마다 색을 조금씩 흔드는 씨앗
      if (brg) {
        // 교량: 노면과 지면을 잇지 않고 골짜기 바닥을 그린다
        const aI = this.ptZ(a, a.aSh, this.terrAt(a, a.aSh)), bI = this.ptZ(b, b.aSh, this.terrAt(b, b.aSh));
        const aO = this.ptZ(a, a.aSh + 120, this.terrAt(a, a.aSh + 120)), bO = this.ptZ(b, b.aSh + 120, this.terrAt(b, b.aSh + 120));
        this.groundQuad(aI, bI, bO, aO, G, dist, sd + 1);
        const aI2 = this.ptZ(a, a.bSh, this.terrAt(a, a.bSh)), bI2 = this.ptZ(b, b.bSh, this.terrAt(b, b.bSh));
        const aO2 = this.ptZ(a, a.bSh - 120, this.terrAt(a, a.bSh - 120)), bO2 = this.ptZ(b, b.bSh - 120, this.terrAt(b, b.bSh - 120));
        this.groundQuad(aI2, bI2, bO2, aO2, G, dist, sd + 2);
      } else {
        // 비탈면 + 그 바깥 지형
        // 비탈면은 6 m 넘게 깎아낸 자리만 암반색으로 두고, 나머지는 초지로 덮는다
        const slopeCol = (dz) => dz > 6 ? mixHex(pal.grass, pal.rock, clamp((dz - 6) / 12, 0, 0.85)) : pal.grass;
        // 오른쪽 — 램프가 있으면 램프 안쪽 경계에서 멈춘다
        const rInA = a.rampR ? a.rampR.in : null, rInB = b.rampR ? b.rampR.in : null;
        const dRa = rInA != null ? Math.min(a.dayR, rInA) - 0.2 : a.dayR;
        const dRb = rInB != null ? Math.min(b.dayR, rInB) - 0.2 : b.dayR;
        const zRa = rInA != null && dRa < a.dayR ? a.g.z : a.dayRz;
        const zRb = rInB != null && dRb < b.dayR ? b.g.z : b.dayRz;
        if (dRa > a.aSh + 0.2 || dRb > b.aSh + 0.2) {
          this.groundQuad(this.pt(a, a.aSh, 0), this.pt(b, b.aSh, 0),
            this.ptZ(b, dRb, zRb), this.ptZ(a, dRa, zRa), slopeCol(a.dayRz - a.g.z), dist, sd + 3);
        }
        if (rInA == null && rInB == null) {
          this.groundQuad(this.ptZ(a, a.dayR, a.dayRz), this.ptZ(b, b.dayR, b.dayRz),
            this.ptZ(b, b.dayR + 90, this.terrAt(b, b.dayR + 90)),
            this.ptZ(a, a.dayR + 90, this.terrAt(a, a.dayR + 90)), G, dist, sd + 5);
        } else {
          // 경계가 없는 쪽은 본선 비탈끝을 써서 램프 시작·끝의 지형을 삼각형으로 잇는다.
          const oA = a.rampR ? a.rampR.foot : a.dayR, oB = b.rampR ? b.rampR.foot : b.dayR;
          for (const [w0, w1] of [[0, 40], [40, 150]]) {
            this.groundQuad(this.ptZ(a, oA + w0, this.terrAt(a, oA + w0)), this.ptZ(b, oB + w0, this.terrAt(b, oB + w0)),
              this.ptZ(b, oB + w1, this.terrAt(b, oB + w1)), this.ptZ(a, oA + w1, this.terrAt(a, oA + w1)), G, dist, sd + 5 + w0);
          }
        }

        // 왼쪽 — 반대편 차도의 램프도 같은 방식으로
        const lInA = a.rampL ? a.rampL.in : null, lInB = b.rampL ? b.rampL.in : null;
        const dLa = lInA != null ? Math.max(a.dayL, lInA) + 0.2 : a.dayL;
        const dLb = lInB != null ? Math.max(b.dayL, lInB) + 0.2 : b.dayL;
        const zLa = lInA != null && dLa > a.dayL ? a.g.z : a.dayLz;
        const zLb = lInB != null && dLb > b.dayL ? b.g.z : b.dayLz;
        if (dLa < a.bSh - 0.2 || dLb < b.bSh - 0.2) {
          this.groundQuad(this.pt(a, a.bSh, 0), this.pt(b, b.bSh, 0),
            this.ptZ(b, dLb, zLb), this.ptZ(a, dLa, zLa), slopeCol(a.dayLz - a.g.z), dist, sd + 4);
        }
        if (lInA == null && lInB == null) {
          this.groundQuad(this.ptZ(a, a.dayL, a.dayLz), this.ptZ(b, b.dayL, b.dayLz),
            this.ptZ(b, b.dayL - 90, this.terrAt(b, b.dayL - 90)),
            this.ptZ(a, a.dayL - 90, this.terrAt(a, a.dayL - 90)), G, dist, sd + 6);
        } else {
          const oA = a.rampL ? a.rampL.foot : a.dayL, oB = b.rampL ? b.rampL.foot : b.dayL;
          for (const [w0, w1] of [[0, 40], [40, 150]]) {
            this.groundQuad(this.ptZ(a, oA - w0, this.terrAt(a, oA - w0)), this.ptZ(b, oB - w0, this.terrAt(b, oB - w0)),
              this.ptZ(b, oB - w1, this.terrAt(b, oB - w1)), this.ptZ(a, oA - w1, this.terrAt(a, oA - w1)), G, dist, sd + 6 + w0);
          }
        }
        // 램프 바깥 비탈면은 지면이므로 본선 지면과 같은 원근 순서로 그린다
        if (a.nearIC || b.nearIC) this.rampSurf(ctx, a, b, dist, sc, true);
      }
    }

    // ---- 포장 ----
    /* 스테이션 3 m 마다 아스팔트 명도를 아주 조금 흔든다. 폴리곤을 더 쓰지 않고도
       노면이 흘러가 보여, 속도가 눈에 읽힌다 — 주행감에 가장 크게 기여하는 부분이다. */
    const road = this.roadTone(a.sRoad, dist);
    const shoulder = this.haze(shade(pal.road, 0.86), dist);
    const median = this.haze(shade(pal.road, 0.78), dist);
    this.quad(this.pt(a, a.bIn, 0), this.pt(b, b.bIn, 0), this.pt(b, b.aIn, 0), this.pt(a, a.aIn, 0), median);
    // A 방향
    this.quad(this.pt(a, a.aIn, 0), this.pt(b, b.aIn, 0), this.pt(b, b.aAux, 0), this.pt(a, a.aAux, 0), road);
    this.quad(this.pt(a, a.aAux, 0), this.pt(b, b.aAux, 0), this.pt(b, b.aSh, 0), this.pt(a, a.aSh, 0), shoulder);
    // B 방향
    this.quad(this.pt(a, a.bIn, 0), this.pt(b, b.bIn, 0), this.pt(b, b.bAux, 0), this.pt(a, a.bAux, 0), road);
    this.quad(this.pt(a, a.bAux, 0), this.pt(b, b.bAux, 0), this.pt(b, b.bSh, 0), this.pt(a, a.bSh, 0), shoulder);
    /* 차로 가운데의 기름때 띠 — 실제 고속도로에서 차로가 가장 또렷이 읽히는 무늬다.
       가까운 곳만 (차로당 사각형 하나) 그려 비용이 작다. */
    if (dist < 170) {
      const oil = this.haze(shade(pal.road, 0.90), dist), lw = RoadStd.laneW, dzo = 0.004;
      Render.layer = 1;
      for (let i = 0; i < a.nA; i++) {
        const ua = a.aLane0 + lw * (i + 0.5), ub = b.aLane0 + lw * (i + 0.5);
        this.quad(this.pt(a, ua - 0.55, dzo), this.pt(b, ub - 0.55, dzo), this.pt(b, ub + 0.55, dzo), this.pt(a, ua + 0.55, dzo), oil);
      }
      for (let i = 0; i < a.nB; i++) {
        const ua = a.bLane0 - lw * (i + 0.5), ub = b.bLane0 - lw * (i + 0.5);
        this.quad(this.pt(a, ua - 0.55, dzo), this.pt(b, ub - 0.55, dzo), this.pt(b, ub + 0.55, dzo), this.pt(a, ua + 0.55, dzo), oil);
      }
      Render.layer = 0;
    }

    if (lod >= 1) this.markings(ctx, a, b, dist, sc);
    this.barriers(ctx, a, b, dist, lod, brg, tun, sc);
    if (brg) this.bridge(ctx, a, b, dist);
    if (tun || a.st === 2 || b.st === 2) this.tunnel(ctx, a, b, dist, sc);
  },

  /* ---------- 램프 노면 ----------
     본선에서 갈라져 나가는 진입·진출로를 실제로 그린다.
     이게 없으면 차가 허공에서 나타나 합류하는 것처럼 보인다. */
  rampSurf(ctx, a, b, dist, sc, slope) {
    const list = this.activeRamps;
    if (!list || !list.length) return;
    for (let i = 0; i < list.length; i++) {
      const e = list[i], corr = e.corr, L = corr.L;
      const sa = corr.dir > 0 ? a.sRoad : L - a.sRoad;
      const sb = corr.dir > 0 ? b.sRoad : L - b.sRoad;
      if (e.on) this.rampSeg(ctx, a, b, dist, corr, e.s - sa, e.s - sb, sc, slope);
      else this.rampSeg(ctx, a, b, dist, corr, sa - e.s, sb - e.s, sc, slope);
    }
  },
  /** 노즈로부터의 거리 ta, tb 사이의 램프 한 토막.
      노즈 쪽에서는 램프가 차로 하나 폭으로 좁아져 가감속차로와 그대로 이어진다.
      예전처럼 안쪽 경계를 갓길 바깥선에 고정하면, 노즈 앞 60 m 가 실 한 가닥으로
      줄었다 사라져 도로가 끊긴 것처럼 보였다. */
  rampSeg(ctx, a, b, dist, corr, ta, tb, sc, slope) {
    const LEN = corr.rampLen + RAMP_VISUAL_EXTENSION;
    if ((ta < 0 && tb < 0) || (ta > LEN && tb > LEN)) return;
    const t0 = clamp(ta, 0, LEN), t1 = clamp(tb, 0, LEN);
    if (Math.abs(t0 - t1) < 0.01) return;
    const h0 = corr.rampHalf(t0), h1 = corr.rampHalf(t1);
    if (h0 <= 0.05 && h1 <= 0.05) return;
    const outA = corr.rampLat(t0) + h0, outB = corr.rampLat(t1) + h1;
    /* ★ 램프 안쪽 가장자리는 본선 바깥 차선(가장자리 실선 포함) 밖으로만 둔다.
       노즈 뒤 100 m 남짓은 폭이 옆으로 빠지는 속도보다 빨리 벌어져, 그대로 두면 램프
       노면이 본선 끝 차로를 1 m 넘게 덮어 차선과 가장자리선이 끊겨 보였다. */
    const edgeOf = (sec) => (corr.dir > 0 ? sec.aAux - sec.g.med : -sec.bAux - sec.g.med) + 0.12;
    const eA = edgeOf(a), eB = edgeOf(b);
    const rawInA = corr.rampLat(t0) - h0, rawInB = corr.rampLat(t1) - h1;
    const inA = Math.max(rawInA, eA), inB = Math.max(rawInB, eB);
    const sh = 1.6;
    const pal = this.pal;
    // 본선과 같은 아스팔트 색 — 접속부에서 색이 갈라지지 않게
    const road = this.roadTone(a.sRoad, dist);
    const shoulder = this.haze(shade(pal.road, 0.86), dist);
    const white = this.haze(sc.timeOfDay === 'night' ? '#eceade' : '#f2f2ec', dist);
    const P = (sec, u, t) => {
      const uw = corr.dir > 0 ? (sec.g.med + u) : -(sec.g.med + u);
      const g = sec.g, nx = Math.sin(g.hdg), ny = -Math.cos(g.hdg);
      return [g.x + nx * uw, g.y + ny * uw, g.z + this.road.crossZ(g, uw) + corr.rampDz(t)];
    };
    if (slope) {
      // 램프 바깥 비탈면 — 본선과 같은 경사로 주변 지형까지 내리거나 올린다
      const side = corr.dir > 0 ? 1 : -1;
      const ea = P(a, outA + sh, t0), eb = P(b, outB + sh, t1);
      const fa = this.rampFoot(a, side * (a.g.med + outA + sh), ea[2], side);
      const fb = this.rampFoot(b, side * (b.g.med + outB + sh), eb[2], side);
      this.groundQuad(ea, eb, this.ptZ(b, fb[0], fb[1]), this.ptZ(a, fa[0], fa[1]), pal.grass, dist, 91 + Math.floor(a.sRoad / 37));
      return;
    }
    // 포장 + 바깥 갓길
    Render.layer = 1;                                  // 본선 갓길과 겹치는 노면
    if (outA - inA > 0.05 || outB - inB > 0.05) {
      this.quad(P(a, Math.min(inA, outA), t0), P(b, Math.min(inB, outB), t1), P(b, outB, t1), P(a, outA, t0), road);
    }
    this.quad(P(a, outA, t0), P(b, outB, t1), P(b, outB + sh, t1), P(a, outA + sh, t0), shoulder);
    Render.layer = 2;
    if (dist < 520) {
      // 바깥 가장자리선
      this.quad(P(a, outA - 0.31, t0), P(b, outB - 0.31, t1), P(b, outB - 0.13, t1), P(a, outA - 0.13, t0), white);
      /* 안쪽(왼쪽) 가장자리선 — 램프 노면이 있는 구간 전체에 긋는다. 노즈 부근에서는 본선
         가장자리선과 V 자로 모여 실제 분류·합류부(gore) 모양이 된다.
         ★ '본선에서 떨어진 뒤부터'만 그으면 나가고 들어오는 구간의 왼쪽 선이 비었다. */
      if (outA - inA > 0.9 && outB - inB > 0.9) {
        this.quad(P(a, inA + 0.13, t0), P(b, inB + 0.13, t1), P(b, inB + 0.31, t1), P(a, inA + 0.31, t0), white);
      }
    }
    Render.layer = 0;
  },

  /* ---------- 노면표시 ----------
     점선을 스트립 경계가 아니라 '실제 스테이션'에서 끊는다. 예전처럼 스트립 하나를
     통째로 칠하면 멀리서는 긴 흰 띠가 되어 속도가 전혀 읽히지 않았다. */
  /** 차선·노면 표시 — 노면과 같은 면이라 GL 에서는 한 층 위로 당겨 그린다 */
  markings(ctx, a, b, dist, sc) {
    Render.layer = 2;
    try { this.markingsBody(ctx, a, b, dist, sc); } finally { Render.layer = 0; }
  },
  markingsBody(ctx, a, b, dist, sc) {
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
    const dash = (uA, uB, w, PERIOD, PAINT) => {
      PERIOD = PERIOD || 20; PAINT = PAINT || 10;
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

    // 차로 경계 — 점선. 부가차로(가감속차로) 경계는 촘촘한 점선으로 따로 구분한다
    for (let i = 1; i < a.nA + (a.auxA > 0.5 ? 1 : 0); i++) {
      const ua = a.aLane0 + lw * i, ub = b.aLane0 + lw * i;
      if (ua > a.aAux - 0.4) continue;
      if (i === a.nA) dash(ua, ub, 0.20, 6, 3);      // 부가차로 경계
      else dash(ua, ub, 0.15);
    }
    for (let i = 1; i < a.nB + (a.auxB > 0.5 ? 1 : 0); i++) {
      const ua = a.bLane0 - lw * i, ub = b.bLane0 - lw * i;
      if (ua < a.bAux + 0.4) continue;
      if (i === a.nB) dash(ua, ub, 0.20, 6, 3);
      else dash(ua, ub, 0.15);
    }

    // ---- 감속차로 유도 화살표 ----
    // 어느 차로가 빠지는 차로인지 한눈에 보이게 한다
    if (dist < 340 && span > 0) {
      for (const corr of [sc.corrA, sc.corrB]) {
        if (!corr) continue;
        const sl0 = corr.dir > 0 ? a.sRoad : corr.L - a.sRoad;
        const sl1 = corr.dir > 0 ? b.sRoad : corr.L - b.sRoad;
        const lo = Math.min(sl0, sl1), hi = Math.max(sl0, sl1);
        const ax = corr.auxAt((lo + hi) / 2);
        if (!ax || ax.type !== 'decel') continue;
        let k = Math.floor(lo / 70);
        while (k * 70 < hi) {
          const ss = k * 70; k++;
          if (ss < ax.s0 + 40 || ss > ax.s1 - 30 || ss < lo) continue;
          this.exitArrow(corr, ss, white);
        }
      }
    }

    if (dist > 80) return;

    // ---- 가까운 곳만: 노면 이음매 · 캣츠아이 · 갓길 요철 ----
    const seamZ = 0.006;
    /* 포장 이음매 — 12 m 마다 옅은 가로줄. 값싼 광학 흐름이다.
       ★ 진하고 두꺼우면(0.86 · 0.36 m) 위에서 볼 때 차 없이 떠 있는 검은 막대로 보였다. */
    const seamC = this.haze(shade(this.pal.road, 0.95), dist);
    let k = Math.floor(a.sRoad / 12);
    while (k * 12 < b.sRoad) {
      const ss = k * 12; k++;
      if (ss < a.sRoad || span <= 0) continue;
      const t = (ss - a.sRoad) / span;
      const wA = this.pt(a, a.aIn, seamZ), wB = this.pt(b, b.aIn, seamZ);
      const eA = this.pt(a, a.aSh, seamZ), eB = this.pt(b, b.aSh, seamZ);
      const p0 = L3(wA, wB, t), p1 = L3(eA, eB, t);
      const t2 = Math.min(1, t + 0.18 / Math.max(span, 0.5));
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
      const rum = this.haze(shade(this.pal.road, 0.84), dist);   // 진하면(0.72) 위에서 끊긴 막대로 보였다
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

  /** 감속차로 위의 유도 화살표 — 앞으로 뻗다가 오른쪽으로 꺾인다 */
  exitArrow(corr, s0, white) {
    const rd = this.road;
    const uc = corr.laneU(corr.nLane);
    const P = (ds, du) => {
      const sr = corr.dir > 0 ? s0 + ds : corr.L - (s0 + ds);
      const g = rd.at(sr);
      const u = corr.dir > 0 ? (g.med + uc + du) : -(g.med + uc + du);
      const nx = Math.sin(g.hdg), ny = -Math.cos(g.hdg);
      return [g.x + nx * u, g.y + ny * u, g.z + rd.crossZ(g, u) + 0.014];
    };
    // 몸통
    this.quadPts(P(0, -0.22), P(4.6, -0.22), P(4.6, 0.22), P(0, 0.22), white);
    // 오른쪽으로 꺾이는 목
    this.quadPts(P(4.6, -0.22), P(7.4, 0.62), P(7.4, 1.06), P(4.6, 0.22), white);
    // 촉
    this.tri(P(7.0, 0.10), P(9.6, 1.30), P(6.6, 1.60), white);
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
      const sz = Render.H / 720;
      const q1 = this.pt(a, a.aSh + 0.35, 0.95), q2 = this.pt(a, a.bSh - 0.35, 0.95);
      if (Render.depth(q1[0], q1[1], q1[2]) < 300) Render.mark(q1[0], q1[1], q1[2], 2.1 * sz, 3.8 * sz, col);
      if (Render.depth(q2[0], q2[1], q2[2]) < 300) Render.mark(q2[0], q2[1], q2[2], 2.1 * sz, 3.8 * sz, col);
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
    const hw = a.hw + 0.6, ext = 190, N = 19;
    const boresA = this.bores(a).map(([u0, u1]) => this.boreGeom(u0, u1));
    const boresB = this.bores(b).map(([u0, u1]) => this.boreGeom(u0, u1));
    const coveredTerrain = (sec, geos, u) => {
      let z = this.terrAt(sec, u);
      // 절토면이 굴 안쪽 아치보다 낮아지는 횡단 골을 메워 지형이 통행 공간에 솟지 않게 한다.
      for (const g of geos) {
        const span = this.boreSpan(g, u);
        if (span) z = Math.max(z, sec.g.z + this.road.crossZ(sec.g, u) + span[1] + 0.8);
      }
      return z;
    };
    /* ★ 굴 위는 촘촘히 나눈다. 22 m 폭 사각형의 꼭짓점에서만 굴 높이를 지키면
       꼭짓점 사이 면이 산이 얇은 갱구 쪽에서 굴 천장을 뚫고 내려왔다. */
    const uL = -(hw + ext), uR = hw + ext;
    const us = [];
    for (let i = 0; i <= N; i++) us.push(lerp(uL, uR, i / N));
    for (const g of boresA.concat(boresB)) {
      for (let k = 0; k <= 12; k++) us.push(g.c - g.A - 1 + (2 * g.A + 2) * k / 12);
    }
    us.sort((p, q) => p - q);
    // 산등성이 표면
    for (let i = 0; i < us.length - 1; i++) {
      const u0 = us[i], u1 = us[i + 1];
      if (u1 - u0 < 0.05) continue;
      const za0 = coveredTerrain(a, boresA, u0), za1 = coveredTerrain(a, boresA, u1);
      const zb0 = coveredTerrain(b, boresB, u0), zb1 = coveredTerrain(b, boresB, u1);
      const rise = ((za0 + za1) / 2) - a.g.z;
      const base = rise > 24 ? mixHex(pal.grass, pal.rock, clamp((rise - 24) / 40, 0, 0.7)) : pal.grass;
      this.groundQuad(this.ptZ(a, u0, za0), this.ptZ(b, u0, zb0), this.ptZ(b, u1, zb1), this.ptZ(a, u1, za1), base, dist, i * 13 + Math.floor(a.sRoad / 37));
    }
    /* 옆구리 — 노면 높이에서 산등성이까지 세운 면. 굴 바깥을 막아 준다.
       ★ 타원 굴은 노면 위 tunnelCz 에서 가장 넓어 hw 보다 바깥으로 나간다.
       옆구리를 hw 에 세우면 그 면이 굴 안에 서서 벽에 톱니 조각이 보였다. */
    const flank = this.haze(mixHex(pal.rock, pal.grass, 0.35), dist);
    const ext2 = (geos, side) => geos.reduce((m, g) => side > 0 ? Math.max(m, g.c + g.A) : Math.min(m, g.c - g.A), 0) + side * 0.6;
    for (const side of [-1, 1]) {
      const ua = side * Math.max(hw, Math.abs(ext2(boresA, side))), ub = side * Math.max(hw, Math.abs(ext2(boresB, side)));
      const za = Math.max(this.terrAt(a, ua), a.g.z + RoadStd.tunnelH + 1), zb = Math.max(this.terrAt(b, ub), b.g.z + RoadStd.tunnelH + 1);
      this.quad(this.ptZ(a, ua, a.g.z - 14), this.ptZ(b, ub, b.g.z - 14),
        this.ptZ(b, ub, zb), this.ptZ(a, ua, za), flank);
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
        const lp = this.pt(a, ga.c, RoadStd.tunnelH - 0.35);
        const dz = Render.depth(lp[0], lp[1], lp[2]);
        if (dz > 0.3) Render.glow(lp[0], lp[1], lp[2], clamp(220 / Math.max(dz, 2), 2, 42) * Render.H / 720, '#fff6d0', '#ffeaa066', 0.9);
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
  /** 차종별 종단 실루엣 — 차종마다 한 번만 만들어 둔다 (매 프레임 차마다 배열을 새로 만들지 않게) */
  profileOf(cls, p) {
    if (p._prof !== undefined) return p._prof;
    return (p._prof = this.makeProfile(cls, p));
  },
  makeProfile(cls, p) {
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
    /* ★ 바깥에서 본 볼록한 차체에서는 바닥면, 먼 쪽 옆면·유리, 먼 쪽 마구리가 절대 보이지
       않는다. 예전에는 이것까지 모두 칠해 차 한 대가 40면을 넘었다(프레임 칠하기의 절반).
       보이는 면 — 지붕, 가까운 옆면, 카메라 쪽 마구리 — 만 그린다. 카메라가 차 안에 있는
       운전석 시점의 내 차는 vehicle() 에서 아예 건너뛴다. */
    const ch = Math.cos(hdg), sh = Math.sin(hdg);
    const amb = this.pal.amb;
    const P = (x, y, z) => [cx + ch * x - sh * y, cy + sh * x + ch * y, cz + z];
    const tone = (f) => this.haze(shade(color, f * amb + (1 - amb) * 0.42), dist);
    const dx = Render.cx - cx, dy = Render.cy - cy;
    const camAhead = ch * dx + sh * dy > 0;          // 카메라가 차 앞쪽에 있는가
    const camLeft = -sh * dx + ch * dy > 0;          // 카메라가 차 왼쪽에 있는가
    const nearSign = camLeft ? 1 : -1;               // 가까운 옆면의 부호
    const gc = glassBand ? this.haze(shade('#262b34', 0.75 * amb + 0.25), dist) : null;
    // 면 밝기 — 해 방향 (옆면 법선은 차체 좌우축, 마구리는 진행축)
    const fSide = this.lit(-sh * nearSign, ch * nearSign, 0) * 0.92;
    const fFront = this.lit(ch, sh, 0) * 0.95, fRear = this.lit(-ch, -sh, 0) * 0.95;
    const sideCol = tone(fSide);

    const n = prof.length - 1;
    for (let k = 0; k < n; k++) {
      const i = camAhead ? k : (n - 1 - k);          // 먼 쪽 끝에서부터
      const A = prof[i], B = prof[i + 1];
      // 지붕 — 기울기(앞유리·뒷유리 쪽)에 따라 법선이 앞뒤로 눕는다
      const s = (B[3] - A[3]) / Math.max(0.05, B[0] - A[0]);
      const nl = 1 / Math.sqrt(1 + s * s);
      const roof = tone(this.lit(-s * nl * ch, -s * nl * sh, nl));
      this.quadPts(P(A[0], -A[1], A[3]), P(B[0], -B[1], B[3]), P(B[0], B[1], B[3]), P(A[0], A[1], A[3]), roof);
      const sg = nearSign;
      this.quadPts(P(A[0], A[1] * sg, A[2]), P(B[0], B[1] * sg, B[2]),
        P(B[0], B[1] * sg, B[3]), P(A[0], A[1] * sg, A[3]), sideCol);
      if (gc && A[3] - A[2] >= glassBand.min && B[3] - B[2] >= glassBand.min) {
        const ha = A[3] - glassBand.h, hb = B[3] - glassBand.h, top = glassBand.top || 0;
        // 캐빈(지붕이 높은 구간)에만 유리를 두른다 — 트렁크·보닛까지 덮으면 속 빈 상자처럼 보인다
        if (ha > A[2] + 0.06 && hb > B[2] + 0.06 && A[3] >= top && B[3] >= top) {
          const ea = (A[1] + 0.012) * sg, eb = (B[1] + 0.012) * sg;
          Render.layer = 1;
          this.quadPts(P(A[0], ea, ha), P(B[0], eb, hb), P(B[0], eb, B[3] - 0.07), P(A[0], ea, A[3] - 0.07), gc);
          Render.layer = 0;
        }
      }
    }

    // 카메라 쪽 마구리
    const F = prof[n], Rr = prof[0];
    const cap = (S, f) => this.quadPts(P(S[0], -S[1], S[2]), P(S[0], S[1], S[2]),
      P(S[0], S[1], S[3]), P(S[0], -S[1], S[3]), tone(f));
    if (camAhead) cap(F, fFront); else cap(Rr, fRear);

    // 앞유리와 뒷유리 — 지붕선이 가장 가파르게 오르내리는 구간이 곧 유리면이다
    if (gc) {
      let iBack = -1, dBack = 0.06, iWind = -1, dWind = 0.06;
      for (let i = 0; i < n; i++) {
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
      // 카메라 쪽 유리만 — 반대쪽 유리는 지붕 너머라 보이지 않는다
      Render.layer = 1;
      pane(camAhead ? iWind : iBack);
      Render.layer = 0;
    }
  },
  /** 거리별 단순화 — 멀수록 단면을 덜어 낸다 (실루엣은 화면에서 몇 픽셀이라 차이가 안 보인다) */
  lodProf(prof, dist) {
    if (dist < 200 || prof.length <= 3) return prof;
    if (dist < 480) return prof._l1 || (prof._l1 = prof.filter((_, i) => i === 0 || i === prof.length - 1 || i % 2 === 0));
    return prof._l2 || (prof._l2 = [prof[0], prof[prof.length >> 1], prof[prof.length - 1]]);
  },

  tri(a, b, c, style) {
    Render.begin();
    Render.add(a[0], a[1], a[2]); Render.add(b[0], b[1], b[2]); Render.add(c[0], c[1], c[2]);
    Render.fill(style);
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
    if (dist < 0.08 || dist > Render.drawDist + 60) return;

    const p = v.p;
    const ch = Math.cos(hdg), sh = Math.sin(hdg);
    // 차체 중심은 앞범퍼에서 뒤로 len/2
    const cxx = bx - ch * p.len * 0.5, cyy = by - sh * p.len * 0.5;

    // 그림자
    if (dist < 260) {
      const hl = p.len * 0.47, hw = p.wid * 0.45;
      ctx.globalAlpha = 0.42;
      Render.layer = 3;
      Render.begin();
      for (const [ix, iy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        Render.add(cxx + ch * hl * ix - sh * hw * iy, cyy + sh * hl * ix + ch * hw * iy, bz + 0.015);
      }
      Render.fill('#000000');
      Render.layer = 0;
      ctx.globalAlpha = 1;
    }

    const near = dist < 190;
    const wheelCol = '#141619';
    /* ★ 바퀴는 차체보다 '먼저' 그린다. 나중에 그리면 뒤·위에서 볼 때 앞바퀴가 차체를
       뚫고 뒷유리 자리에 검은 판으로 떠 보였다. 먼저 그리면 차체가 윗부분을 가리고
       문턱 아래만 남아 바퀴집처럼 보인다(옆면은 바닥 0.4 m 에서 시작한다). */
    /* 앞바퀴는 조향각만큼 돌려 그린다. 바퀴가 안 돌면 조향이 숫자만 바뀌는 느낌이 난다.
       pairs 의 첫 항목을 앞축으로 본다. */
    const steerAng = v.isPlayer ? -(v.steer || 0) * 0.42 : clamp((v.yawRel || 0) * 1.8, -0.35, 0.35);
    const putWheels = (ox, halfW, r, pairs) => {
      if (!near) return;
      // 먼 바퀴부터 — 카메라에서 먼 축, 먼 쪽 바퀴를 먼저 칠한다
      const camF = ch * (Render.cx - ox.x) + sh * (Render.cy - ox.y);
      const order = pairs.map((_, i) => i).sort((i, j) => camF > 0 ? pairs[i] - pairs[j] : pairs[j] - pairs[i]);
      const sides = -sh * (Render.cx - ox.x) + ch * (Render.cy - ox.y) > 0 ? [-1, 1] : [1, -1];
      for (const pi of order) {
        const px = pairs[pi];
        const wh = hdg + (pi === 0 ? steerAng : 0);
        for (const side of sides) {
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
      const cabProf = p._cab || (p._cab = [
        [-cabL / 2, p.wid * 0.44, 0.95, 2.60],
        [cabL * 0.28, p.wid * 0.50, 0.90, 3.30],
        [cabL * 0.44, p.wid * 0.50, 0.88, 3.18],
        [cabL * 0.50, p.wid * 0.43, 0.92, 2.60],
      ]);
      const drawCab = () => this.hull(ctx, c1.x, c1.y, bz, hdg, this.lodProf(cabProf, dist), v.color, dist, near ? { h: 1.00, min: 1.4, top: 2.9 } : null);
      // 먼 쪽부터 그린다 — 순서를 뒤집으면 뒤에 있어야 할 캡이 적재함을 덮어 버린다
      const camAheadT = ch * (Render.cx - bx) + sh * (Render.cy - by) > 0;
      putWheels(c2, p.wid * 0.47, 0.53, [-trlL * 0.34, -trlL * 0.34 + 1.4]);
      putWheels(c1, p.wid * 0.47, 0.53, [cabL * 0.31, -cabL * 0.26]);
      if (camAheadT) { drawTrailer(); drawCab(); } else { drawCab(); drawTrailer(); }
    } else if (v.cls === 'bus') {
      putWheels({ x: cxx, y: cyy }, p.wid * 0.47, 0.53, [p.len * 0.34, -p.len * 0.29]);
      this.hull(ctx, cxx, cyy, bz, hdg, this.lodProf(this.profileOf('bus', p), dist), v.color, dist, near ? { h: 1.30, min: 1.6, top: 3.0 } : null);
    } else {
      putWheels({ x: cxx, y: cyy }, p.wid * 0.415, 0.33, [p.len * 0.31, -p.len * 0.30]);
      this.hull(ctx, cxx, cyy, bz, hdg, this.lodProf(this.profileOf('car', p), dist), v.color, dist, near ? { h: 0.34, min: 0.55, top: 1.18 } : null);
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
      const fl = f.n[2] < 0 ? 0.30 : this.lit(f.n[0], f.n[1], f.n[2]) * (f.n[2] > 0 ? 1 : 0.92);
      const col = this.haze(shade(color, fl * amb + (1 - amb) * 0.42), dist);
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
    const px = Render.H / 720;                         // 화면 해상도와 무관한 크기
    const size = clamp(70 / dist, 0.8, 9) * px;
    Render.layer = 1;
    for (const side of (facing < 0 ? [-1, 1] : [])) {
      const lx = rearX - sh * hw * side, ly = rearY + ch * hw * side;
      if (dist < 90) {
        // 가까이에서는 실제 면적을 가진 등화로 그린다 — 점으로 찍으면 제동이 안 읽힌다
        const hwl = 0.17, hh = 0.072;
        const nx = -sh, ny = ch;
        const P = (dy, dz) => [lx + nx * dy - ch * 0.02, ly + ny * dy - sh * 0.02, bz + zT + dz];
        this.quadPts(P(-hwl, -hh), P(hwl, -hh), P(hwl, hh), P(-hwl, hh), tail);
      } else {
        Render.mark(lx - ch * 0.03, ly - sh * 0.03, bz + zT, size * 1.1, size * 0.64, tail);
      }
      if (v.brake && dist < 180) Render.glow(lx - ch * 0.05, ly - sh * 0.05, bz + zT, Math.max(size, 3 * px) * 2.8, '#ff4a30', '#ff4a3055', 0.66);
    }
    // 방향지시등
    if (v.blink && facing < 0 && (Math.floor((sc.time + v.blinkPhase) * 1.6) & 1)) {
      const side = v.blink * (corr.dir > 0 ? 1 : -1);
      const lx = rearX - sh * p.wid * 0.5 * side, ly = rearY + ch * p.wid * 0.5 * side;
      Render.mark(lx - ch * 0.03, ly - sh * 0.03, bz + zT, size, size * 0.6, '#ffa825');
    }
    // 전조등 — 우리를 향한 차만
    if (night && facing > 0) {
      for (const side of [-1, 1]) {
        const lx = bx - sh * hw * side + ch * 0.05, ly = by + ch * hw * side + sh * 0.05;
        Render.glow(lx, ly, bz + zT * 0.9, clamp(200 / dist, 1.5, 26) * px, '#fffbe8', '#ffeeb055', 1);
      }
    }
    Render.layer = 0;
  },

  /* ---------- 화면 위 효과 ---------- */
  overlay(ctx, W, H, sc) {
    if (sc.weather === 'rain' && !sc.inTunnel) {   // 굴 안에는 비가 들이치지 않는다
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
