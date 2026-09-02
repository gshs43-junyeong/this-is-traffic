/* =============================================================================
   util.js — 단위 / 수학 / 난수 / 노이즈 / 배열 필터
   고속도로 주행 시뮬레이터의 모든 모듈이 공유하는 기반 도구.
   외부 라이브러리 없이 순수 JS 로만 돌아간다.
   ========================================================================== */
'use strict';

/* ---------- 단위 상수 ---------- */
const KMH   = 1 / 3.6;        // km/h -> m/s
const MS2K  = 3.6;            // m/s  -> km/h
const GRAV  = 9.81;           // 중력가속도 m/s^2
const RHO   = 1.225;          // 공기밀도 kg/m^3 (해면, 15°C)
const TAU   = Math.PI * 2;

/* ---------- 기본 수학 ---------- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp  = (a, b, t) => a + (b - a) * t;
const invl  = (a, b, v) => (v - a) / ((b - a) || 1);
const sgn   = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
function wrapPi(a) { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; }
/** 지수 감쇠 기반 프레임률 독립 보간 — 시간상수 tau 로 목표에 붙는다 */
const approach = (cur, tgt, tau, dt) => tgt + (cur - tgt) * Math.exp(-dt / Math.max(tau, 1e-6));

/* ---------- 난수 ---------- */
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** 결정론적 난수기 (mulberry32). 같은 시드 = 같은 도로 = 같은 실험 조건 */
class RNG {
  constructor(seed) {
    this.s = (typeof seed === 'string' ? hashStr(seed) : (seed >>> 0)) || 1;
    this._g = null;
  }
  next() {
    this.s = (this.s + 0x6D2B79F5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + this.next() * (b - a); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  /** 가중치 배열 [[값, 가중치], ...] */
  weighted(pairs) {
    let total = 0; for (const p of pairs) total += p[1];
    let r = this.next() * total;
    for (const p of pairs) { r -= p[1]; if (r <= 0) return p[0]; }
    return pairs[pairs.length - 1][0];
  }
  /** 표준정규 (Box-Muller, 한 쌍을 캐시해 두 번에 한 번만 계산) */
  normal(mu = 0, sd = 1) {
    if (this._g !== null) { const g = this._g; this._g = null; return mu + sd * g; }
    let u = 0, v = 0;
    while (u <= 1e-12) u = this.next();
    v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this._g = r * Math.sin(TAU * v);
    return mu + sd * r * Math.cos(TAU * v);
  }
  /** 지수분포 — 포아송 도착의 차두시간(headway) 생성에 쓴다 */
  exp(mean) { let u = this.next(); if (u <= 1e-12) u = 1e-12; return -mean * Math.log(u); }
  /** 값싼 근사 정규난수 (Irwin-Hall). 유색잡음처럼 대량으로 뽑는 곳에 쓴다 */
  normalFast() { return (this.next() + this.next() + this.next() - 1.5) * 2; }
}

/* ---------- 값 노이즈 (지형) ---------- */
function makeNoise2D(rng) {
  const P = new Uint8Array(512), perm = new Uint8Array(256);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for (let i = 0; i < 512; i++) P[i] = perm[i & 255];
  const grad = (h, x, y) => {
    switch (h & 3) { case 0: return x + y; case 1: return -x + y; case 2: return x - y; default: return -x - y; }
  };
  const raw = (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const aa = P[P[X] + Y], ab = P[P[X] + Y + 1], ba = P[P[X + 1] + Y], bb = P[P[X + 1] + Y + 1];
    const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
    const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);        // 대략 -1..1
  };
  /** fBm — oct 옥타브를 겹쳐 -1..1 근처 값을 낸다 */
  return function (x, y, freq, oct = 3, persist = 0.5) {
    let sum = 0, amp = 1, max = 0, f = freq;
    for (let o = 0; o < oct; o++) { sum += raw(x * f, y * f) * amp; max += amp; amp *= persist; f *= 2; }
    return sum / max;
  };
}

/* ---------- 배열 필터 ---------- */
/** 박스블러 3회 = 가우시안 근사. 종단선형의 안내선을 만들 때 쓴다 */
function smoothArray(src, radius) {
  if (radius < 1) return Float32Array.from(src);
  const n = src.length;
  let a = Float32Array.from(src), b = new Float32Array(n);
  for (let pass = 0; pass < 3; pass++) {
    // 누적합으로 O(n) 박스블러
    const acc = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) acc[i + 1] = acc[i] + a[i];
    for (let i = 0; i < n; i++) {
      const lo = clamp(i - radius, 0, n - 1), hi = clamp(i + radius, 0, n - 1);
      b[i] = (acc[hi + 1] - acc[lo]) / (hi - lo + 1);
    }
    const t = a; a = b; b = t;
  }
  return a;
}

/** Douglas-Peucker — 안내선을 종단변화점(PVI) 몇 개로 줄인다 */
function simplifyDP(xs, ys, tol) {
  const n = xs.length, keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 - i0 < 2) continue;
    const x0 = xs[i0], y0 = ys[i0], x1 = xs[i1], y1 = ys[i1];
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
    let bi = -1, bd = tol;
    for (let i = i0 + 1; i < i1; i++) {
      const d = Math.abs((xs[i] - x0) * dy - (ys[i] - y0) * dx) / len;
      if (d > bd) { bd = d; bi = i; }
    }
    if (bi >= 0) { keep[bi] = 1; stack.push([i0, bi], [bi, i1]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** 정수 해시 (0..1). 스테이션마다 결정론적인 얼룩을 낼 때 쓴다 */
function ihash(n) {
  let h = (n | 0) * 374761393;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h >>> 8) / 16777216;
}

/* ---------- 서식 ---------- */
const fmt0 = (n) => Math.round(n).toLocaleString('ko-KR');
const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmt2 = (n) => (Math.round(n * 100) / 100).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
/** 초 -> m:ss */
function mmss(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + pad2(sec % 60); }
/** 미터 -> "12.4km" / "830m" */
function distStr(m) { return m >= 1000 ? fmt1(m / 1000) + 'km' : Math.round(m / 10) * 10 + 'm'; }

/* ---------- 색 ---------- */
function mixHex(h1, h2, t) {
  const a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16);
  const r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, t));
  const g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, t));
  const bl = Math.round(lerp(a & 255, b & 255, t));
  return '#' + ((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0');
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(Math.round(((n >> 16) & 255) * amt), 0, 255);
  const g = clamp(Math.round(((n >> 8) & 255) * amt), 0, 255);
  const b = clamp(Math.round((n & 255) * amt), 0, 255);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
/** 속도 -> 색 (정체 시각화: 빨강 정지 ~ 초록 자유류) */
function speedColor(vms, vfree) {
  const t = clamp(vms / Math.max(vfree, 1), 0, 1);
  if (t < 0.5) return mixHex('#c62828', '#f9a825', t / 0.5);
  return mixHex('#f9a825', '#2e9e5b', (t - 0.5) / 0.5);
}

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
