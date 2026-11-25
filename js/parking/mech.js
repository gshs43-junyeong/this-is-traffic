/* =============================================================================
   mech.js — 기계식 주차타워 (엘리베이터식)

   길가에 탑 여러 기가 선다. 탑마다 가운데 승강기, 층마다 좌우 한 칸씩.
   지상 1층은 입 · 출고실(승강기 바닥이 곧 입고실 바닥이다), 그 위가 지상 칸, 아래가 피트(지하) 칸.

   입고: 진입로에 줄을 섰다가 입고실이 비면 들어가 서고 → 운전자가 내려 나가면 →
         승강기가 빈 칸 높이로 올라가 → 팔레트를 옆으로 밀어 넣고 → 빈 승강기가 내려온다.
   출고: 운전자가 부르면 → 승강기가 그 칸으로 가서 → 차를 꺼내 내려오고 →
         턴테이블이 180° 돌려 머리를 문 쪽으로 → 운전자가 타고 나간다.
   승강기 하나가 두 일을 차례로 한다(먼저 기다린 쪽 먼저). 그래서 입고 대기열과 출고 대기가
   서로를 기다리게 되고, 몰리는 시간에는 출고에 몇 분씩 걸린다 — 실제 기계식의 가장 큰 불만.

   속도 · 시간 (엘리베이터식 주차장치 대표값)
     승강 60~120 m/min (여기서 96 m/min = 1.6 m/s) + 출발 · 정지 3 s
     팔레트 옆 이동 6 s, 턴테이블 180° 8 s, 운전자 내림 8~14 s · 탐 6~10 s
   ========================================================================== */
'use strict';

const MK = {
  bayW: 2.4,       // 한 열(칸 · 승강기 · 칸)의 너비
  depth: 6.2,      // 탑 깊이 (남북)
  pitch: 2.05,     // 칸 층고
  ground: 2.6,     // 입고실 높이 (첫 지상 칸 바닥)
  space: 9.4,      // 탑 간격 (사이 2.2 m 는 보행로)
  vLift: 1.6, tStart: 3, tXfer: 6, tTurn: 8,
};

/** 기계식 배치 — buildGarage 와 같은 모양의 G 를 돌려준다 (렌더 · HUD 가 그대로 읽는다) */
function buildMech(cfg) {
  const U = clamp(cfg.U | 0, 1, 40), B = clamp(cfg.B | 0, 0, 10);
  const nT = Math.max(1, Math.floor((Math.max(12, cfg.W) - 7.2) / MK.space) + 1);
  const W = (nT - 1) * MK.space + 7.2 + 1.0, D = MK.depth;
  const G = { cfg, mech: true, nodes: [], edges: [], stalls: [], levels: [], columns: [], arrows: [], towers: [] };
  G.W = W; G.D = D; G.U = U; G.B = B; G.NL = U + B; G.H = MK.pitch; G.gIdx = B;
  // 층 — 피트(깊은 쪽부터) 다음 지상 칸. 1층(입고실)에는 칸이 없다
  for (let j = B - 1; j >= 0; j--) G.levels.push({ i: G.levels.length, z: -MK.pitch * (j + 1), name: 'B' + (j + 1), park: true, under: true });
  for (let k = 0; k < U; k++) G.levels.push({ i: G.levels.length, z: MK.ground + MK.pitch * k, name: (k + 2) + 'F', park: true, under: false });
  G.xx = 0.5; G.xe = W - 0.5; G.grade = 0; G.Lr = 0; G.gated = [];
  let nid = 0, eid = 0;
  const node = (x, y) => { const o = new PNode(nid++, x, y, 0, -1); G.nodes.push(o); return o; };
  const link = (ed, a, b) => { ed.from = a; ed.to = b; a.outs.push(ed); b.ins.push(ed); };
  const edge = (kind, P, vmax) => { const rs = resample(P.X, P.Y, 0, null, 0.5); const e = new PEdge(eid++, kind, kind === 'street' ? -1 : 0, rs.x, rs.y, () => 0); e.vmax = vmax; G.edges.push(e); return e; };
  const ys = PK.ys, r = 3, xR = W + 140, xL = -140;
  // 탑 (동쪽부터 — 서쪽으로 흐르는 차로에서 만나는 순서)
  const towers = [];
  for (let t = nT - 1; t >= 0; t--) towers.push({ idx: t, x: 0.5 + 3.6 + t * MK.space });
  // 도로를 노드로 잘라 간선을 만든다
  const marks = [];
  for (const T of towers) { marks.push({ x: T.x + 1.4 + r, T, k: 'in' }); marks.push({ x: T.x - 1.4 - r, T, k: 'out' }); }
  marks.sort((a, b) => b.x - a.x);
  let prevN = node(xR, ys), prevX = xR;
  const nS0 = prevN;
  G.street = [];
  for (const m of marks) {
    const nd = node(m.x, ys);
    const e = edge('street', filletPath([[prevX, ys], [m.x, ys]], r, 1), G.street.length ? 11 : 12.5); link(e, prevN, nd);
    G.street.push(e);
    m.node = nd; prevN = nd; prevX = m.x;
  }
  const nS1 = node(xL, ys);
  const eEnd = edge('street', filletPath([[prevX, ys], [xL, ys]], r, 1), 12.5); link(eEnd, prevN, nS1); G.street.push(eEnd);
  G.streetIn = G.street[0]; G.streetOut = eEnd;
  // 탑마다 진입로(동쪽 반) · 진출로(서쪽 반)
  for (const T of towers) {
    const mi = marks.find((m) => m.T === T && m.k === 'in'), mo = marks.find((m) => m.T === T && m.k === 'out');
    const bayIn = node(T.x + 1.4, -0.6), bayOut = node(T.x - 1.4, -0.6);
    const lin = edge('entry', filletPath([[T.x + 1.4 + r, ys], [T.x + 1.4, ys], [T.x + 1.4, -0.6]], r), 3.0); link(lin, mi.node, bayIn);
    const lout = edge('exit', filletPath([[T.x - 1.4, -0.6], [T.x - 1.4, ys], [T.x - 1.4 - r, ys]], r), 3.0); link(lout, bayOut, mo.node);
    lin.tower = T; lout.tower = T;
    T.lin = lin; T.lout = lout; T.bayIn = bayIn;
    T.cy = D / 2;
    G.towers.push(T);
  }
  G.towers.sort((a, b) => a.idx - b.idx);
  // 통과 차로 (같은 방향 안쪽 · 반대 방향) — garage.js roadLanes
  roadLanes(G, cfg, ys, xL, xR, nS1, (xa, ya, xb, yb, vmax) => {
    const e = edge('street', filletPath([[xa, ya], [xb, yb]], r, 1), vmax);
    const n1 = node(xb, yb); link(e, node(xa, ya), n1);
    return { e, end: n1 };
  });
  // 칸
  let sid = 0;
  for (const T of G.towers) for (const L of G.levels) for (const sd of [-1, 1]) {
    const st = { id: sid++, level: L.i, cx: T.x + sd * MK.bayW, cy: T.cy, z: L.z + 0.18, nx: 0, ny: 1, ox: T.x, oy: T.cy, ax: 1, ay: 0,
      side: sd, ed: null, s: 0, state: 'free', car: null, hdg: Math.PI / 2, type: 'gen', tower: T };
    G.stalls.push(st);
  }
  G.parkEdges = [];
  G.entry = G.towers[0].lin; G.exit = G.towers[0].lout; G.entryEnd = G.towers[0].bayIn;
  G.yt = D; G.yb = 0; G.y_rt = D; G.y_rb = 0;
  return G;
}

class MechSim extends ParkSim {
  constructor(G, cfg) {
    super(G, cfg);
    for (const T of G.towers) Object.assign(T, { state: 'idle', job: null, q: [], liftZ: 0, carOn: null, t: 0, dur: 0 });
  }
  /** 칸에 세운 차 — 머리는 늘 북쪽(안쪽) */
  parkAt(v, s) {
    v.mode = 'parked'; v.stall = s; v.nose = 'in'; v.v = 0; v.edge = null;
    s.state = 'occ'; s.car = v;
    v.x = s.cx; v.y = s.cy; v.z = s.z; v.h = Math.PI / 2; v.p = 0;
    v.blink = 0; v.brake = false; v.rev = false; v.inside = true;
    this.dirty = true; this.actDirty = true;
  }
  choose(v, nd) {
    const outs = nd.outs;
    if (outs.length === 1) return outs[0];
    const st = outs.find((e) => e.kind === 'street');
    if (v.role === 'thru' || v.done || v.balk || v.inside) return st;
    // 아직 들어갈 탑을 안 정했으면: 줄이 가장 짧은 탑 (지나칠 탑은 셈하지 않는다)
    if (!v.towerPick) {
      let best = null, bc = Infinity;
      for (const T of this.G.towers) {
        const free = this.G.stalls.some((s) => s.tower === T && s.state === 'free');
        if (!free) continue;
        const c = T.lin.cars.length * 1.0 + T.q.length * 0.8 + (T.state !== 'idle' ? 0.5 : 0) + this.rng.next() * 0.3;
        if (c < bc) { bc = c; best = T; }
      }
      v.towerPick = best || 'none';
      if (!best) { v.balk = true; this.st.lost++; }       // 빈 칸이 있는 탑이 없다 — 지나간다
    }
    const ent = outs.find((e) => e.kind === 'entry');
    if (ent && v.towerPick === ent.tower) return ent;
    return st;
  }
  callDriver(v) {
    if (!v.stall) return;
    v.leaving = true; v.tReq = this.time; v.driverAway = true;
    v.stall.state = 'leave';
    const T = v.stall.tower;
    T.q.push(v);
    this.actDirty = true;
    // 운전자가 보도에서 로비로 와서 기다린다 — 차가 내려와 돌면 걸어가 탄다
    const n = T.q.length - 1, spot = [T.x + 2.0 + (n % 3) * 0.55, 1.6 + Math.floor(n / 3) * 0.7 % 3.2];
    const pts = [[T.x + 9, PK.ys + 4.4], [T.x + 4.2, PK.ys + 4.4], [T.x + 1.75, -2.5], [T.x + 1.75, 0.7], spot]       // 유리벽 서쪽 끝의 문으로;
    const p = { pts, k: 0, u: 0, sp: this.rng.range(1.15, 1.5), z: 0, car: null, toCar: false, level: 0, delay: 0, x: pts[0][0], y: pts[0][1], h: 0, ph: 0,
      shirt: this.rng.pick(['#3b5b8c', '#8c3b3b', '#2f6b52', '#d0d0cc', '#2a2a2e', '#a07a3c']), pants: '#3a4256', hei: this.rng.range(1.6, 1.82), wait: 0, hold: true };
    this.peds.push(p);
    v.mechPed = p;
  }
  admit() { return this.G.stalls.some((s) => s.state === 'free'); }
  sub(dt) {
    super.sub(dt);
    for (const T of this.G.towers) this.towerStep(T, dt);
  }
  /** 승강기 하나의 일 — 상태 기계 */
  towerStep(T, dt) {
    const v = T.carOn;
    T.t += dt;
    const f = T.dur > 0 ? clamp(T.t / T.dur, 0, 1) : 1;
    const ease = smoothstep(f);
    const liftDur = (dz) => MK.tStart + Math.abs(dz) / MK.vLift;
    const go = (state, dur) => { T.state = state; T.t = 0; T.dur = dur; };
    switch (T.state) {
      case 'idle': {
        // 입고 후보: 진입로 맨 앞 차가 문 앞에 섰고 빈 칸이 있다
        const lane = T.lin.cars;
        let head = null; for (const c of lane) if (!head || c.s > head.s) head = c;
        const ready = head && head.s > T.lin.len - 2.6 && head.v < 0.25;     // 길 끝 앞 정지 간격(s0)만큼 서 있다
        if (ready && !head.atDoor) head.atDoor = this.time;
        const slot = ready ? this.freeSlot(T) : null;
        const rq = T.q[0];
        if (slot && (!rq || head.atDoor <= rq.tReq)) {
          const i = lane.indexOf(head); lane.splice(i, 1);
          this.dropRes(head);
          head.mode = 'mech'; head.inside = true; head.tGate = this.time; head.stall = slot; slot.state = 'res'; slot.car = head;
          this.st.inN++; this.st.queueT.push(head.qW || 0);
          T.carOn = head; T.slot = slot;
          T.p0 = { x: head.x, y: head.y, h: head.h };
          this.actDirty = true;
          go('in', 3.5);
        } else if (rq) {
          T.q.shift(); T.carOn = rq; T.slot = rq.stall;
          go('fetch', liftDur(rq.stall.z));
        }
        break;
      }
      // ---- 입고 ----
      case 'in':
        v.x = lerp(T.p0.x, T.x, ease); v.y = lerp(T.p0.y, T.cy, ease); v.h = T.p0.h + wrapPi(Math.PI / 2 - T.p0.h) * ease; v.z = 0;
        v.v = 1.2 * (1 - f); v.brake = f > 0.8;
        if (f >= 1) { go('alight', this.rng.range(8, 14)); this.walkOut(T, v); }
        break;
      case 'alight': if (f >= 1) go('up', liftDur(T.slot.z)); break;
      case 'up':
        T.liftZ = lerp(0, T.slot.z - 0.18, ease); v.z = T.liftZ + 0.18;
        if (f >= 1) go('push', MK.tXfer);
        break;
      case 'push':
        v.x = lerp(T.x, T.slot.cx, ease);
        if (f >= 1) {
          this.parkAt(v, T.slot); v.tPark = this.time; v.searching = false;
          this.st.search.push(this.time - v.tGate); this.logEvt('입고', v, this.time - v.tGate, T.slot);
          T.carOn = null;
          go('down', liftDur(T.slot.z));
        }
        break;
      case 'down':
        T.liftZ = lerp(T.slot.z - 0.18, 0, ease);
        if (f >= 1) { T.liftZ = 0; go('idle', 0); }
        break;
      // ---- 출고 ----
      case 'fetch':
        T.liftZ = lerp(0, T.slot.z - 0.18, ease);
        if (f >= 1) { v.mode = 'mech'; this.actDirty = true; go('pull', MK.tXfer); }
        break;
      case 'pull':
        v.x = lerp(T.slot.cx, T.x, ease); v.z = T.slot.z;
        if (f >= 1) { T.slot.state = 'free'; T.slot.car = null; this.dirty = true; go('lower', liftDur(T.slot.z)); }
        break;
      case 'lower':
        T.liftZ = lerp(T.slot.z - 0.18, 0, ease); v.z = T.liftZ + 0.18;
        if (f >= 1) { T.liftZ = 0; go('turn', MK.tTurn); }
        break;
      case 'turn':
        v.h = Math.PI / 2 + Math.PI * ease;
        if (f >= 1) {
          let walkT = 0;
          const p = v.mechPed;
          if (p && this.peds.includes(p)) {          // 로비에서 기다리던 운전자가 차로 간다
            const tgt = [T.x + 1.15, T.cy + 0.4];
            p.hold = false; p.toCar = true; p.car = v; p.pts = [[p.x, p.y], [T.x + 1.3, 1.0], tgt]; p.k = 0; p.u = 0; p.delay = 0;
            walkT = (Math.hypot(T.x + 1.3 - p.x, 1.0 - p.y) + Math.hypot(tgt[0] - T.x - 1.3, tgt[1] - 1.0)) / p.sp;
          }
          v.mechPed = null;
          go('board', walkT + this.rng.range(4, 7));
        }
        break;
      case 'board':
        if (f >= 1) { T.p1 = { x: T.x - 1.4, y: -0.6 - v.len / 2 }; go('out', 3.5); v.driverAway = false; }
        break;
      case 'out':
        v.x = lerp(T.x, T.p1.x, ease); v.y = lerp(T.cy, T.p1.y, ease); v.z = 0;
        v.h = -Math.PI / 2 + 0.35 * Math.sin(Math.PI * f) * Math.sign(T.p1.x - T.x) * -1;
        v.v = 1.2 * f;
        if (f >= 1) {
          const e = T.lout;
          v.mode = 'drive'; v.edge = e; v.s = v.len * 0.5 + 0.2; v.v = 1.0; v.route = [e]; v.ri = 0; v.path = null; v.prev = null;
          v.done = true; v.inside = false; v.stall = null; v.leaving = true;
          e.cars.push(v);
          this.st.outN++; this.st.exitT.push(this.time - v.tReq); this.logEvt('출고', v, this.time - v.tReq);
          this.planAhead(v); this.pose(v);
          this.actDirty = true;
          go('clear', 0);
        }
        break;
      case 'clear':      // 나간 차의 꽁무니가 문을 벗어날 때까지 다음 차를 들이지 않는다
        if (!v || v.edge !== T.lout || v.s - v.len > 2.5) { T.carOn = null; go('idle', 0); }
        break;
    }
  }
  freeSlot(T) {
    // 낮은 칸부터 (승강 시간이 짧다) — 지상 첫 칸에서 가까운 높이 순
    let best = null, bd = Infinity;
    for (const s of this.G.stalls) {
      if (s.tower !== T || s.state !== 'free') continue;
      const d = Math.abs(s.z) + this.rng.next() * 0.5;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
  /** 운전자 — 입고실에서 내려 로비 문으로 나가 보도로 (출고 때는 callDriver 가 로비로 불러 세운다) */
  walkOut(T, v) {
    const pts = [[T.x + 1.15, T.cy - 0.6], [T.x + 1.75, 0.7], [T.x + 1.75, -2.5], [T.x + 4.2, PK.ys + 4.4], [T.x + 9, PK.ys + 4.4]];   // 로비 유리벽 서쪽 끝의 문으로
    this.peds.push({ pts, k: 0, u: 0, sp: this.rng.range(1.15, 1.5), z: 0, car: v, toCar: false, level: 0, delay: this.rng.range(2, 4), x: pts[0][0], y: pts[0][1], h: 0, ph: 0,
      shirt: this.rng.pick(['#3b5b8c', '#8c3b3b', '#2f6b52', '#d0d0cc', '#2a2a2e']), pants: '#26282d', hei: this.rng.range(1.6, 1.82), wait: 0 });
  }
  summary() {
    const S = super.summary();
    let qIn = 0, qOut = 0, man = 0;
    for (const T of this.G.towers) { qIn += T.lin.cars.length; qOut += T.q.length; }
    for (const v of this.cars) if (v.mode === 'mech') man++;
    for (const v of this.G.streetIn.cars) if (v.role === 'park' && !v.inside && v.v < 1.5 && v.edge.len - v.s < 60) qIn++;
    S.qIn = qIn; S.qOut = qOut; S.man = man; S.hunting = 0; S.wantOut = 0;
    return S;
  }
}

/* ---------- 강철 골조 (PScene 에 붙인다) ---------- */
PScene.mechFrame = function (A) {
  const G = this.G, top = G.levels[G.NL - 1].z + MK.pitch + 0.4, bot = G.B ? G.levels[0].z - 0.3 : 0;
  const steel = '#8b939c', clad = '#c3c7c2', pal = '#5d646b';
  for (const T of G.towers) {
    const x0 = T.x - MK.bayW * 1.5, x1 = T.x + MK.bayW * 1.5, y0 = 0.2, y1 = MK.depth;
    // 기둥 (네 귀 + 승강기 양옆)
    for (const cx of [x0, T.x - MK.bayW / 2, T.x + MK.bayW / 2, x1]) for (const cy of [y0, y1]) A.box(cx - 0.12, cy - 0.12, bot, cx + 0.12, cy + 0.12, top, steel, false, true);
    // 옆면 · 뒷면 외장판 (앞면은 열어 두어 안의 차가 보인다)
    A.box(x0 - 0.06, y0, 0, x0 + 0.02, y1, top, NX(clad), false, true);
    A.box(x1 - 0.02, y0, 0, x1 + 0.06, y1, top, NX(clad), false, true);
    A.box(x0, y1 - 0.02, 0, x1, y1 + 0.06, top, NX(clad), false, true);
    // 밤 — 로비 천장등과 몇 단마다 칸 안의 작업등
    this.lamps.push([T.x + MK.bayW, y0 + 1.6, MK.ground - 0.45, 0]);
    for (let i = 2; i < G.levels.length; i += 4) this.lamps.push([T.x, y0 + 0.4, G.levels[i].z + MK.pitch - 0.25, 0]);
    // 층마다 앞쪽 보 · 칸 팔레트
    for (const L of G.levels) {
      if (L.z < 0) continue;
      A.box(x0, y0 - 0.1, L.z - 0.1, x1, y0 + 0.1, L.z + 0.06, steel, false, false);
      for (const sd of [-1, 1]) {
        const cx = T.x + sd * MK.bayW;
        A.box(cx - 1.05, T.cy - 2.75, L.z + 0.02, cx + 1.05, T.cy + 2.75, L.z + 0.16, pal, true, false);
      }
    }
    // 입고실 — 바닥 · 문틀 · 위 간판
    A.quad([x0, y0, 0.02], [x1, y0, 0.02], [x1, y1, 0.02], [x0, y1, 0.02], '#6b7078');
    A.box(x0, y0 - 0.15, MK.ground - 0.35, x1, y0 + 0.05, MK.ground, NX('#2f4f6f'), false, false);
    A.quad([T.x - 0.9, y0 - 0.17, MK.ground - 0.3], [T.x + 0.9, y0 - 0.17, MK.ground - 0.3], [T.x + 0.9, y0 - 0.17, MK.ground - 0.05], [T.x - 0.9, y0 - 0.17, MK.ground - 0.05], '#3ec46d');
    // 1층 동쪽 칸은 대기 로비 (유리 앞벽 · 의자), 서쪽 칸은 기계실
    const lx0 = T.x + MK.bayW / 2 + 0.15, lx1 = x1 - 0.1, mz = MK.ground - 0.4;
    A.quad([lx0, y0 + 0.1, 0.03], [lx1, y0 + 0.1, 0.03], [lx1, y1 - 0.1, 0.03], [lx0, y1 - 0.1, 0.03], '#cdc7b6');
    A.box(lx0, y0 + 0.05, 0, lx1, y0 + 0.12, 0.35, NX('#8b939c'), false, true);
    A.box(lx0 + 0.75, y0 + 0.06, 0.35, lx1, y0 + 0.1, mz, PNIGHT ? '#e8d9a6' : '#7fa4b8', false, true);     // 유리 (문 자리 비움)
    A.box(lx0 + 0.15, y1 - 0.7, 0, lx1 - 0.15, y1 - 0.3, 0.45, '#6b5a48', true, false);                    // 의자
    A.box(lx1 - 0.5, y0 + 2.0, 0, lx1 - 0.1, y0 + 2.5, 1.3, '#3b4654', true, false);                       // 정산기
    A.box(lx1 - 0.48, y0 + 2.05, 0.9, lx1 - 0.44, y0 + 2.45, 1.2, '#7fd1ff', true, true);
    const mx0 = x0 + 0.1, mx1 = T.x - MK.bayW / 2 - 0.15;
    A.box(mx0, y0 + 0.05, 0, mx1, y1 - 0.1, mz, NX('#a7aca8'), false, false);                             // 기계실
    A.quad([mx0 + 0.6, y0 + 0.03, 0], [mx0 + 1.5, y0 + 0.03, 0], [mx0 + 1.5, y0 + 0.03, 2.0], [mx0 + 0.6, y0 + 0.03, 2.0], '#5c6670');
    // 지붕
    A.box(x0 - 0.15, y0 - 0.15, top, x1 + 0.15, y1 + 0.15, top + 0.3, NX('#9aa0a6'), false, false);
    // 승강기 레일 (가운데 열 앞쪽)
    A.box(T.x - 0.05, y0 + 0.05, 0, T.x + 0.05, y0 + 0.2, top, '#d4b13a', false, true);
  }
};

/** 승강기 바닥 — 매 프레임 (PScene.draw 에서) */
PScene.mechLifts = function (em, dt) {
  for (const T of this.sim.G.towers) {
    const z = T.liftZ || 0;
    this.obox(em, T.x, T.cy, z, Math.PI / 2, 2.85, 1.08, 0.16, '#d4b13a');
    // 입고실 셔터 — 차가 드나들 때만 열린다 (올라가 접힌다)
    const head = T.lin.cars.reduce((a, c) => (!a || c.s > a.s ? c : a), null);
    const want = T.state === 'in' || T.state === 'out' || T.state === 'clear' || (T.state === 'idle' && head && T.lin.len - head.s < 3) ? 1 : 0;
    T.door = approach(T.door || 0, want, 0.5, dt || 0.016);
    const h = (MK.ground - 0.4) * (1 - T.door), x0 = T.x - 1.15, x1 = T.x + 1.15, y = 0.12;
    if (h > 0.05) {
      em.quad([x0, y, MK.ground - 0.4 - h], [x1, y, MK.ground - 0.4 - h], [x1, y, MK.ground - 0.4], [x0, y, MK.ground - 0.4], NX('#9aa3ab'));
      for (let k = 0.25; k < h; k += 0.25) em.quad([x0, y - 0.01, MK.ground - 0.4 - k], [x1, y - 0.01, MK.ground - 0.4 - k], [x1, y - 0.01, MK.ground - 0.38 - k], [x0, y - 0.01, MK.ground - 0.38 - k], NX('#7d868e'));
    }
  }
};
