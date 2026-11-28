/* =============================================================================
   cmap.js — 도시 지도: 만들기 · 고치기 · 견본(격자 · 유기형 · 고속도로 도시) · 건물 채우기

   지도는 사람이 고치는 원본이다 (모양은 cnet.js 머리말). 고칠 때마다 compileNet 으로 도로망을 새로 짓는다.
   ★ 지상끼리 겹치는 두 도로는 반드시 교차로(노드)로 잇는다 — 안 그러면 차가 서로를 뚫고 지나간다.
     addRoad 가 새 도로와 기존 도로의 교차점을 찾아, 높이 차가 4.5 m 안이면 둘 다 그 점에서 자른다.
   ========================================================================== */
'use strict';

const CMAP_VER = 1;
const BLD_KIND = { office: '업무', apart: '주거', shop: '상가', parking: '주차빌딩', school: '학교' };

function newMap() { return { v: CMAP_VER, nodes: [], roads: [], blds: [], nid: 1, sig: { phase: 'lead', cycle: 100, coord: false } }; }
function mapNode(map, id) { return map.nodes.find((n) => n.id === id); }
function mapRoad(map, id) { return map.roads.find((r) => r.id === id); }
function addNode(map, x, y, level) { const n = { id: map.nid++, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, level: level || 'ground' }; map.nodes.push(n); return n; }
/** 도로 하나 — opts { cls, lanes, level, c1, c2, ends } */
function addRoadRaw(map, a, b, opts) {
  opts = opts || {};
  const cl = RCLS[opts.cls || 'street'];
  const r = { id: map.nid++, a, b, cls: opts.cls || 'street', lanes: (opts.lanes || cl.lanes).slice(), level: opts.level || 'ground', ends: opts.ends ? JSON.parse(JSON.stringify(opts.ends)) : {} };
  if (opts.c1) r.c1 = opts.c1.slice();
  if (opts.c2) r.c2 = opts.c2.slice();
  map.roads.push(r);
  return r;
}
/** 도로를 놓고, 같은 높이로 겹친 기존 도로와는 교차로를 만든다 */
function addRoad(map, a, b, opts) {
  const r = addRoadRaw(map, a, b, opts);
  autoSplit(map, r.id);
  return r;
}
function shapeOf(map, r) { return roadShape(map, r, (id) => mapNode(map, id)); }

/** 호 길이 sc 에서 베지어 매개변수 */
function tAtSc(g, sc) { const f = clamp(sc / g.step, 0, g.n - 1), i = Math.min(g.n - 2, f | 0); return g.t[i] + (g.t[i + 1] - g.t[i]) * (f - i); }
/** 3 차 베지어를 t 에서 둘로 (드 카스텔조) */
function splitBez(P, t) {
  const L = (p, q) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const a = L(P[0], P[1]), b = L(P[1], P[2]), c = L(P[2], P[3]), d = L(a, b), e = L(b, c), f = L(d, e);
  return [[P[0], a, d, f], [f, e, c, P[3]]];
}
/** 도로를 호 길이 sc 에서 자른다 — 자른 점의 노드 (useNode 가 있으면 그 노드로 잇는다) */
function splitRoad(map, rid, sc, useNode) {
  const r = mapRoad(map, rid); if (!r) return null;
  const g = shapeOf(map, r);
  const t = tAtSc(g, sc), [P1, P2] = splitBez(g.P, t);
  const z = shapeAt(g, sc).z;
  const lv = Math.abs(z - LEVEL_Z.bridge) < 2.5 ? 'bridge' : Math.abs(z - LEVEL_Z.tunnel) < 2.5 ? 'tunnel' : 'ground';
  const N = useNode || addNode(map, P1[3][0], P1[3][1], lv);
  const straight = !r.c1 && !r.c2;
  const base = { cls: r.cls, lanes: r.lanes, level: r.level };
  const r1 = addRoadRaw(map, r.a, N.id, Object.assign({}, base, straight ? {} : { c1: P1[1], c2: P1[2] }));
  const r2 = addRoadRaw(map, N.id, r.b, Object.assign({}, base, straight ? {} : { c1: P2[1], c2: P2[2] }));
  if (r.ends && r.ends.a) r1.ends.a = JSON.parse(JSON.stringify(r.ends.a));
  if (r.ends && r.ends.b) r2.ends.b = JSON.parse(JSON.stringify(r.ends.b));
  map.roads.splice(map.roads.indexOf(r), 1);
  for (const b of map.blds) if (b.acc && b.acc.road === r.id) delete b.acc;
  return N;
}
/** 두 도로 모양이 만나는 점들 — [{ sa, sb, x, y, za, zb }] (끝 노드 6 m 안은 뺀다) */
function shapeCrossings(ga, gb) {
  const out = [], k = 2;
  for (let i = 0; i + k < ga.n; i += k) {
    const ax = ga.x[i], ay = ga.y[i], bx = ga.x[i + k], by = ga.y[i + k];
    for (let j = 0; j + k < gb.n; j += k) {
      const r = segX(ax, ay, bx, by, gb.x[j], gb.y[j], gb.x[j + k], gb.y[j + k]);
      if (!r) continue;
      const sa = (i + r[0] * k) * ga.step, sb = (j + r[1] * k) * gb.step;
      if (sa < 6 || sa > ga.L - 6 || sb < 6 || sb > gb.L - 6) continue;
      out.push({ sa, sb, x: ax + (bx - ax) * r[0], y: ay + (by - ay) * r[0], za: shapeAt(ga, sa).z, zb: shapeAt(gb, sb).z });
    }
  }
  return out;
}
/** 새 도로가 같은 높이로 지나는 기존 도로와 만나는 곳마다 교차로를 만든다 */
function autoSplit(map, rid) {
  for (let guard = 0; guard < 40; guard++) {
    const r = mapRoad(map, rid); if (!r) return;
    const g = shapeOf(map, r);
    let hit = null;
    for (const o of map.roads) {
      if (o === r || o.a === r.a || o.a === r.b || o.b === r.a || o.b === r.b) continue;
      const go = shapeOf(map, o);
      for (const x of shapeCrossings(g, go)) if (Math.abs(x.za - x.zb) < 4.5 && (!hit || x.sa < hit.sa)) hit = Object.assign(x, { o });
    }
    if (!hit) return;
    const N = splitRoad(map, hit.o.id, hit.sb);
    N.x = Math.round(hit.x * 10) / 10; N.y = Math.round(hit.y * 10) / 10;
    // 새 도로도 같은 노드에서 자른다 — 앞 조각은 끝났고, 뒤 조각을 계속 본다
    splitRoad(map, rid, hit.sa, N);
    rid = map.roads[map.roads.length - 1].id;       // 자른 뒤쪽 조각 (splitRoad 가 앞 · 뒤 순서로 붙인다)
  }
}
function deleteRoad(map, rid) {
  const r = mapRoad(map, rid); if (!r) return;
  map.roads.splice(map.roads.indexOf(r), 1);
  for (const id of [r.a, r.b]) if (!map.roads.some((o) => o.a === id || o.b === id)) map.nodes.splice(map.nodes.findIndex((n) => n.id === id), 1);
  for (const b of map.blds) if (b.acc && b.acc.road === rid) delete b.acc;
}
function deleteNode(map, nid) {
  for (const r of map.roads.filter((o) => o.a === nid || o.b === nid)) deleteRoad(map, r.id);
  const i = map.nodes.findIndex((n) => n.id === nid); if (i >= 0) map.nodes.splice(i, 1);
}
/** 노드를 옮기면 붙은 도로의 조절점도 같은 만큼 (끝 가까운 쪽만) 옮겨 모양을 지킨다 */
function moveNode(map, nid, x, y) {
  const n = mapNode(map, nid); if (!n) return;
  const dx = x - n.x, dy = y - n.y;
  n.x = Math.round(x * 10) / 10; n.y = Math.round(y * 10) / 10;
  for (const r of map.roads) {
    if (r.a === nid && r.c1) { r.c1[0] += dx; r.c1[1] += dy; }
    if (r.b === nid && r.c2) { r.c2[0] += dx; r.c2[1] += dy; }
  }
  for (const b of map.blds) if (b.acc) { const r = mapRoad(map, b.acc.road); if (r && (r.a === nid || r.b === nid)) delete b.acc; }
}
function straighten(r) { delete r.c1; delete r.c2; }
/** 곡선으로 — 가운데를 (bx, by) 쪽으로 미는 조절점 둘 */
function bendRoad(map, r, bx, by) {
  const A = mapNode(map, r.a), B = mapNode(map, r.b);
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2, k = 4 / 3;
  const ox = (bx - mx) * k, oy = (by - my) * k;
  r.c1 = [A.x + (B.x - A.x) / 3 + ox, A.y + (B.y - A.y) / 3 + oy];
  r.c2 = [A.x + (B.x - A.x) * 2 / 3 + ox, A.y + (B.y - A.y) * 2 / 3 + oy];
}

/* ---------- 견본 ---------- */
/** 격자 — 교차로 NX × NY, 블록 B, 바깥으로 170 m 출입로 */
function tplGrid(o) {
  const map = newMap(), NX = clamp(o.NX | 0 || 4, 2, 8), NY = clamp(o.NY | 0 || 4, 2, 8), B = clamp(+o.B || 140, 70, 300), n = clamp(o.lanes | 0 || 2, 1, 3);
  const id = [];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) id.push(addNode(map, i * B, j * B).id);
  const at = (i, j) => id[j * NX + i];
  const cls = n === 3 ? 'arterial' : 'street';
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    if (i + 1 < NX) addRoadRaw(map, at(i, j), at(i + 1, j), { cls, lanes: [n, n] });
    if (j + 1 < NY) addRoadRaw(map, at(i, j), at(i, j + 1), { cls, lanes: [n, n] });
  }
  const st = 170;
  for (let i = 0; i < NX; i++) { addRoadRaw(map, addNode(map, i * B, -st).id, at(i, 0), { cls, lanes: [n, n] }); addRoadRaw(map, at(i, NY - 1), addNode(map, i * B, (NY - 1) * B + st).id, { cls, lanes: [n, n] }); }
  for (let j = 0; j < NY; j++) { addRoadRaw(map, addNode(map, -st, j * B).id, at(0, j), { cls, lanes: [n, n] }); addRoadRaw(map, at(NX - 1, j), addNode(map, (NX - 1) * B + st, j * B).id, { cls, lanes: [n, n] }); }
  map.name = `격자 ${NX}×${NY}`;
  return map;
}
/** 유기형 — 고리 두 겹 · 휘어진 방사로 · 갈래가 셋 · 다섯인 교차로 */
function tplOrganic(o) {
  const map = newMap(), rng = new RNG('org:' + (o.seed | 0));
  const ring = (r, k, a0, jit) => Array.from({ length: k }, (_, i) => { const a = a0 + i * TAU / k + rng.range(-jit, jit); return { a, n: addNode(map, Math.cos(a) * r * rng.range(0.94, 1.06), Math.sin(a) * r * rng.range(0.94, 1.06)) }; });
  const arcRoad = (p, q, r, opts) => {       // 고리 위 두 점을 원호처럼 잇는다
    let da = q.a - p.a; if (da < 0) da += TAU;
    const k = 4 / 3 * Math.tan(da / 4) * r;
    const c1 = [p.n.x - Math.sin(p.a) * k, p.n.y + Math.cos(p.a) * k], c2 = [q.n.x + Math.sin(q.a) * k, q.n.y - Math.cos(q.a) * k];
    return addRoadRaw(map, p.n.id, q.n.id, Object.assign({ c1, c2 }, opts));
  };
  const wig = (a, b, amt, opts) => {        // 살짝 S 자로 휜 길
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L, w1 = rng.range(-amt, amt), w2 = rng.range(-amt, amt);
    return addRoadRaw(map, a.id, b.id, Object.assign({ c1: [a.x + dx / 3 + nx * w1, a.y + dy / 3 + ny * w1], c2: [a.x + dx * 2 / 3 + nx * w2, a.y + dy * 2 / 3 + ny * w2] }, opts));
  };
  const C = addNode(map, rng.range(-10, 10), rng.range(-10, 10));
  const R1 = 190, R2 = 460;
  const r1 = ring(R1, 6, rng.range(0, 1), 0.12), r2 = ring(R2, 9, rng.range(0, 1), 0.08);
  for (let i = 0; i < r1.length; i++) arcRoad(r1[i], r1[(i + 1) % r1.length], R1, { cls: 'street', lanes: [2, 2] });
  for (let i = 0; i < r2.length; i++) arcRoad(r2[i], r2[(i + 1) % r2.length], R2, { cls: 'arterial', lanes: [2, 2] });
  for (let i = 0; i < r1.length; i += 2) wig(C, r1[i].n, 14, { cls: 'street', lanes: [2, 2] });
  // 안 고리 → 바깥 고리: 각이 가장 가까운 점으로 (겹치지 않게 한 번씩)
  const usedOut = new Set();
  for (const p of r1) {
    let best = null, bd = Infinity;
    for (const q of r2) { if (usedOut.has(q)) continue; const d = Math.abs(wrapPi(q.a - p.a)); if (d < bd) { bd = d; best = q; } }
    usedOut.add(best);
    wig(p.n, best.n, 28, { cls: 'arterial', lanes: [2, 2] });
  }
  // 바깥 고리 → 도시 밖 (여섯 곳)
  const outs = r2.slice().sort((p, q) => p.a - q.a).filter((_, i) => i % 3 !== 2);
  for (const q of outs) {
    const a = q.a + rng.range(-0.15, 0.15), g = addNode(map, Math.cos(a) * 820, Math.sin(a) * 820);
    wig(q.n, g, 30, { cls: 'arterial', lanes: [2, 2] });
  }
  // 고리 사이 이면도로 — 바깥 고리 남은 점에서 안쪽으로
  for (const q of r2) {
    if (usedOut.has(q)) continue;
    const a = q.a, m = addNode(map, Math.cos(a) * (R1 + R2) / 2, Math.sin(a) * (R1 + R2) / 2);
    wig(q.n, m, 10, { cls: 'local', lanes: [1, 1] });
    // 가까운 방사로 쪽으로 이어 막다른 길을 없앤다
    let best = null, bd = Infinity;
    for (const p of r1) { const d = Math.abs(wrapPi(p.a - a)); if (d < bd) { bd = d; best = p; } }
    wig(m, best.n, 10, { cls: 'local', lanes: [1, 1] });
  }
  map.name = '유기형 도시';
  // 겹친 곳 정리 — 견본이 만든 도로끼리도 같은 높이로 만나면 교차로로
  for (const r of map.roads.slice()) if (mapRoad(map, r.id)) autoSplit(map, r.id);
  return map;
}
/** 고속도로 도시 — 격자 위를 지나는 고가 고속도로 · 다이아몬드 나들목 · 지하차도 · 고가차도 */
function tplHighway(o) {
  const map = newMap();
  const xs = [0, 170, 340, 510, 680], ys = [0, 170, 520], yH = 345;
  const id = {};
  for (const x of xs) for (const y of ys) id[x + ',' + y] = addNode(map, x, y).id;
  const N = (x, y) => id[x + ',' + y];
  // 동서 — 가운데 줄 왼쪽은 지하차도(170 의 남북 도로 밑으로), 위 줄 오른쪽은 고가차도(510 위로)
  const E = (x0, x1, y, opts) => addRoadRaw(map, N(x0, y), N(x1, y), Object.assign({ cls: 'street', lanes: [2, 2] }, opts));
  for (let i = 0; i < xs.length - 1; i++) E(xs[i], xs[i + 1], 0);
  E(0, 340, 170, { level: 'tunnel' }); E(340, 510, 170); E(510, 680, 170);
  E(0, 170, 520); E(170, 340, 520); E(340, 680, 520, { level: 'bridge' });
  // 남북 — 340 은 간선(왕복 6차로), 나들목 연결로 끝 교차로를 지난다
  const tS = addNode(map, 340, yH - 80), tN = addNode(map, 340, yH + 80);
  for (const x of xs) {
    const cls = x === 340 ? 'arterial' : 'street', ln = x === 340 ? [3, 3] : [2, 2];
    if (x === 170) { addRoadRaw(map, N(x, 0), N(x, 520), { cls, lanes: ln }); continue; }   // 지하차도 위를 지난다
    if (x === 510) { addRoadRaw(map, N(x, 0), N(x, 170), { cls, lanes: ln }); addRoadRaw(map, N(x, 170), N(x, 520), { cls, lanes: ln }); continue; }
    if (x === 340) {
      addRoadRaw(map, N(x, 0), N(x, 170), { cls, lanes: ln }); addRoadRaw(map, N(x, 170), tS.id, { cls, lanes: ln });
      addRoadRaw(map, tS.id, tN.id, { cls, lanes: ln }); addRoadRaw(map, tN.id, N(x, 520), { cls, lanes: ln });
      continue;
    }
    addRoadRaw(map, N(x, 0), N(x, 170), { cls, lanes: ln }); addRoadRaw(map, N(x, 170), N(x, 520), { cls, lanes: ln });
  }
  // 도시 밖 출입로
  const st = 170;
  for (const x of xs) { addRoadRaw(map, addNode(map, x, -st).id, N(x, 0), { cls: x === 340 ? 'arterial' : 'street', lanes: x === 340 ? [3, 3] : [2, 2] }); addRoadRaw(map, N(x, 520), addNode(map, x, 520 + st).id, { cls: x === 340 ? 'arterial' : 'street', lanes: x === 340 ? [3, 3] : [2, 2] }); }
  for (const y of ys) { addRoadRaw(map, addNode(map, -st, y).id, N(0, y), { cls: 'street', lanes: [2, 2] }); addRoadRaw(map, N(680, y), addNode(map, 680 + st, y).id, { cls: 'street', lanes: [2, 2] }); }
  // 고속도로 — 양 끝은 지상에서 올라와 도시 위를 고가로 지난다
  const gW = addNode(map, -950, yH), gE = addNode(map, 1630, yH);
  const n1 = addNode(map, 40, yH, 'bridge'), n2 = addNode(map, 640, yH, 'bridge');
  const hw = { cls: 'highway', lanes: [3, 3] };
  addRoadRaw(map, gW.id, n1.id, hw); addRoadRaw(map, n1.id, n2.id, Object.assign({ level: 'bridge' }, hw)); addRoadRaw(map, n2.id, gE.id, hw);
  // 나들목 — 동쪽 방향(남쪽 램프), 서쪽 방향(북쪽 램프)
  const rp = { cls: 'ramp', lanes: [1, 0], level: 'bridge' };      // 고가 높이를 지키다 끝에서 내려온다 (남북 도로 위를 지난다)
  addRoadRaw(map, n1.id, tS.id, Object.assign({ c1: [n1.x + 150, yH - 14], c2: [tS.x - 110, tS.y + 8] }, rp));     // 동 → 나가는 길
  addRoadRaw(map, tS.id, n2.id, Object.assign({ c1: [tS.x + 110, tS.y + 8], c2: [n2.x - 150, yH - 14] }, rp));     // 동 ← 들어가는 길
  addRoadRaw(map, n2.id, tN.id, Object.assign({ c1: [n2.x - 150, yH + 14], c2: [tN.x + 110, tN.y - 8] }, rp));     // 서 → 나가는 길
  addRoadRaw(map, tN.id, n1.id, Object.assign({ c1: [tN.x - 110, tN.y - 8], c2: [n1.x + 150, yH + 14] }, rp));     // 서 ← 들어가는 길
  // 간선 340 은 나들목 교차로에 좌회전 전용 차로
  for (const r of map.roads) if (r.cls === 'arterial') { r.ends.a = { bl: 1 }; r.ends.b = { bl: 1 }; }
  // 지하차도 · 고가차도가 건너뛴 노드는 지운다
  map.nodes = map.nodes.filter((n) => map.roads.some((r) => r.a === n.id || r.b === n.id));
  map.name = '고속도로가 지나는 도시';
  return map;
}

/** 대도시 — 4.8 km 네모: 간선(800 m) · 일반도로(400 m) · 이면도로(200 m) 격자, 도심을 가로지르는 고가 고속도로(동서)와
    지하 고속도로(남북) · 다이아몬드 나들목 여섯.
    ★ 고속도로 밑 한 줄(동서 y = 400 · 남북 x = 400)은 길을 내지 않는다 — 나들목 연결로가 그 사이 빈 땅을 쓴다.
    ★ 고속도로가 땅으로 내려오는 곳(올라가는 곳)은 도시 밖(경계 ± 200 m 넘어)에 둔다 — 안에서 내려오면 길과 같은 높이로 엇갈린다. */
function tplMetro(o) {
  const map = newMap(), H = 2400, S = 200, yH = 400, xV = 400, X0 = 2650, XG = 4200;
  const cs = []; for (let v = -H; v <= H; v += S) cs.push(v);
  const clsOf = (v) => (v % 800 === 0 ? 'arterial' : v % 400 === 0 ? 'street' : 'local');
  const lnOf = (c) => (c === 'arterial' ? [3, 3] : c === 'street' ? [2, 2] : [1, 1]);
  const id = new Map(), at = (x, y) => id.get(x + ',' + y);
  const ensure = (x, y, lv) => { const k = x + ',' + y; if (!id.has(k)) id.set(k, addNode(map, x, y, lv).id); return id.get(k); };
  // 나들목 연결로 끝 — 간선 위에 미리 박아 둔다
  const icX = [-1600, 0, 1600], icY = [-1600, 0, 1600];
  const extraV = new Map(), extraH = new Map();         // 남북 길(x) 위 · 동서 길(y) 위의 덧 노드
  for (const X of icX) extraV.set(X, [yH - 100, yH + 100]);
  for (const Y of icY) extraH.set(Y, [xV - 100, xV + 100]);
  // 동서 길 — y 마다 (고속도로 줄은 뺀다)
  for (const y of cs) {
    if (y === yH) continue;
    const c = clsOf(y), xsRow = cs.filter((x) => x !== xV || c === 'arterial' || true).concat(extraH.get(y) || []).sort((a, b) => a - b);
    for (let i = 0; i + 1 < xsRow.length; i++) {
      const a = xsRow[i], b = xsRow[i + 1];
      addRoadRaw(map, ensure(a, y), ensure(b, y), { cls: c, lanes: lnOf(c) });
    }
  }
  // 남북 길 — x 마다 (지하 고속도로 줄은 뺀다)
  for (const x of cs) {
    if (x === xV) continue;
    const c = clsOf(x), ysCol = cs.filter((y) => y !== yH).concat(extraV.get(x) || []).sort((a, b) => a - b);
    for (let i = 0; i + 1 < ysCol.length; i++) addRoadRaw(map, ensure(x, ysCol[i]), ensure(x, ysCol[i + 1]), { cls: c, lanes: lnOf(c) });
  }
  // x = 400 줄의 동서 길 노드는 남북 길이 없어 두 갈래 — 그냥 지나가는 점이므로 지운다 (도로를 합친다)
  const merge = (nid) => {
    const rs = map.roads.filter((r) => r.a === nid || r.b === nid);
    if (rs.length !== 2) return;
    const [r1, r2] = rs, a = r1.a === nid ? r1.b : r1.a, b = r2.a === nid ? r2.b : r2.a;
    map.roads.splice(map.roads.indexOf(r1), 1); map.roads.splice(map.roads.indexOf(r2), 1);
    addRoadRaw(map, a, b, { cls: r1.cls, lanes: r1.lanes });
  };
  for (const y of cs) if (y !== yH && !(extraH.get(y))) { const n = at(xV, y); if (n) merge(n); }
  // 도시 밖 출입로 — 간선 끝마다
  const st = 250;
  for (const v of cs) {
    if (clsOf(v) !== 'arterial') continue;
    const ln = lnOf('arterial');
    addRoadRaw(map, addNode(map, v, -H - st).id, at(v, -H), { cls: 'arterial', lanes: ln });
    addRoadRaw(map, at(v, H), addNode(map, v, H + st).id, { cls: 'arterial', lanes: ln });
    addRoadRaw(map, addNode(map, -H - st, v).id, at(-H, v), { cls: 'arterial', lanes: ln });
    addRoadRaw(map, at(H, v), addNode(map, H + st, v).id, { cls: 'arterial', lanes: ln });
  }
  const hw = { cls: 'highway', lanes: [3, 3] };
  // 동서 고가 고속도로 — 서 → 동이 A → B (동쪽으로 가는 차는 남쪽 차도)
  const ew = [addNode(map, -XG, yH).id, addNode(map, -X0, yH, 'bridge').id];
  const rpB = { cls: 'ramp', lanes: [1, 0], level: 'bridge' };
  for (const X of icX) {
    const n1 = addNode(map, X - 180, yH, 'bridge'), n2 = addNode(map, X + 180, yH, 'bridge');
    const tS = mapNode(map, at(X, yH - 100)), tN = mapNode(map, at(X, yH + 100));
    addRoadRaw(map, n1.id, tS.id, Object.assign({ c1: [n1.x + 90, yH - 8], c2: [X - 40, tS.y + 6] }, rpB));
    addRoadRaw(map, tS.id, n2.id, Object.assign({ c1: [X + 40, tS.y + 6], c2: [n2.x - 90, yH - 8] }, rpB));
    addRoadRaw(map, n2.id, tN.id, Object.assign({ c1: [n2.x - 90, yH + 8], c2: [X + 40, tN.y - 6] }, rpB));
    addRoadRaw(map, tN.id, n1.id, Object.assign({ c1: [X - 40, tN.y - 6], c2: [n1.x + 90, yH + 8] }, rpB));
    ew.push(n1.id, n2.id);
  }
  ew.push(addNode(map, X0, yH, 'bridge').id, addNode(map, XG, yH).id);
  for (let i = 0; i + 1 < ew.length; i++) addRoadRaw(map, ew[i], ew[i + 1], Object.assign({ level: i === 0 || i === ew.length - 2 ? 'ground' : 'bridge' }, hw));
  // 남북 지하 고속도로 — 남 → 북이 A → B (북쪽으로 가는 차는 동쪽 차도)
  const ns = [addNode(map, xV, -XG).id, addNode(map, xV, -X0, 'tunnel').id];
  const rpT = { cls: 'ramp', lanes: [1, 0], level: 'tunnel' };
  for (const Y of icY) {
    const n1 = addNode(map, xV, Y - 180, 'tunnel'), n2 = addNode(map, xV, Y + 180, 'tunnel');
    const tE = mapNode(map, at(xV + 100, Y)), tW = mapNode(map, at(xV - 100, Y));
    addRoadRaw(map, n1.id, tE.id, Object.assign({ c1: [xV + 8, n1.y + 90], c2: [tE.x + 6, Y - 40] }, rpT));
    addRoadRaw(map, tE.id, n2.id, Object.assign({ c1: [tE.x + 6, Y + 40], c2: [xV + 8, n2.y - 90] }, rpT));
    addRoadRaw(map, n2.id, tW.id, Object.assign({ c1: [xV - 8, n2.y - 90], c2: [tW.x - 6, Y + 40] }, rpT));
    addRoadRaw(map, tW.id, n1.id, Object.assign({ c1: [tW.x - 6, Y - 40], c2: [xV - 8, n1.y + 90] }, rpT));
    ns.push(n1.id, n2.id);
  }
  ns.push(addNode(map, xV, X0, 'tunnel').id, addNode(map, xV, XG).id);
  for (let i = 0; i + 1 < ns.length; i++) addRoadRaw(map, ns[i], ns[i + 1], Object.assign({ level: i === 0 || i === ns.length - 2 ? 'ground' : 'tunnel' }, hw));
  // 간선끼리 만나는 곳 · 나들목 끝 교차로는 좌회전 전용 차로
  for (const r of map.roads) if (r.cls === 'arterial') { r.ends.a = { bl: 1 }; r.ends.b = { bl: 1 }; }
  map.nodes = map.nodes.filter((n) => map.roads.some((r) => r.a === n.id || r.b === n.id));
  map.name = '대도시';
  return map;
}

/* ---------- 건물 채우기 ---------- */
/** 길가를 따라 빈 땅에 건물을 놓는다 (도로 · 다른 건물과 겹치지 않게) — 놓은 수 */
function autofill(map, seed, density) {
  const rng = new RNG('fill:' + (seed | 0)), dens = density == null ? 1 : density;
  const net = compileNet(map);
  // 도로 표본 — 반폭 + 보도로 막는 땅
  const cell = 40, grid = new Map(), key = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
  const add = (o, x, y) => { const k = key(x, y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(o); };
  for (const R of net.roads) {
    const hw = roadHalf(R) + R.cl.sw + (R.cl.fast ? 6 : 0.8);
    for (let i = 0; i < R.g.n; i += 3) if (R.g.z[i] > -5 || i % 9 === 0) add({ x: R.g.x[i], y: R.g.y[i], r: R.g.z[i] < -5 ? 4 : hw }, R.g.x[i], R.g.y[i]);
  }
  for (const N of net.nodes) add({ x: N.x, y: N.y, r: Math.max(0, ...N.legs.map((l) => l.sb)) + 4 }, N.x, N.y);
  // 건물도 칸으로 — 하나씩 견주면 대도시(건물 8 천)에서 n² 였다
  const bgrid = new Map(), bput = (q) => { const k = key(q.b.x, q.b.y); if (!bgrid.has(k)) bgrid.set(k, []); bgrid.get(k).push(q); };
  const blds = map.blds.map((b) => ({ b, P: bldCorners(b) }));
  for (const q of blds) bput(q);
  const near = (x, y, rad) => {
    const out = [];
    for (let i = Math.floor((x - rad) / cell); i <= Math.floor((x + rad) / cell); i++) for (let j = Math.floor((y - rad) / cell); j <= Math.floor((y + rad) / cell); j++) { const a = grid.get(i + ',' + j); if (a) out.push(...a); }
    return out;
  };
  const fits = (b) => {
    const P = bldCorners(b), rad = Math.hypot(b.w, b.d) / 2;
    for (const o of near(b.x, b.y, rad + 40)) if (distRect(o.x, o.y, b) < o.r) return false;
    for (let i = Math.floor((b.x - 80) / cell); i <= Math.floor((b.x + 80) / cell); i++) for (let j = Math.floor((b.y - 80) / cell); j <= Math.floor((b.y + 80) / cell); j++) {
      const a = bgrid.get(i + ',' + j); if (!a) continue;
      for (const q of a) if (Math.hypot(q.b.x - b.x, q.b.y - b.y) < rad + Math.hypot(q.b.w, q.b.d) / 2 + 2 && rectsHit(P, q.P, 2)) return false;
    }
    return true;
  };
  // 도시 가운데 · 크기 (건물 높이)
  let cx = 0, cy = 0, k = 0;
  for (const N of net.nodes) if (!N.gate) { cx += N.x; cy += N.y; k++; }
  cx /= k || 1; cy /= k || 1;
  let rmax = 1; for (const N of net.nodes) if (!N.gate) rmax = Math.max(rmax, Math.hypot(N.x - cx, N.y - cy));
  let placed = 0;
  for (const R of net.roads) {
    if (R.cl.fast || !R.cl.sw || R.A.gate || R.B.gate || !R.links.some((L) => L && net.main.has(L))) continue;
    for (const side of [1, -1]) {
      const hw = roadHalf(R) + R.cl.sw;
      let sc = R.sa + rng.range(8, 16);
      while (sc < R.L - R.sb - 12) {
        const q = shapeAt(R.g, sc);
        if (Math.abs(q.z) > 0.3) { sc += 8; continue; }
        const front = rng.range(20, 36), dep = rng.range(16, 32);
        const qq = shapeAt(R.g, Math.min(R.L, sc + front / 2));
        if (Math.abs(qq.z) > 0.3) { sc += 8; continue; }
        const off = hw + rng.range(2, 5) + dep / 2;
        const nx = Math.sin(qq.h) * side, ny = -Math.cos(qq.h) * side;
        const b = { x: qq.x + nx * off, y: qq.y + ny * off, w: front - rng.range(2, 5), d: dep, rot: qq.h };
        if (rng.next() < dens && fits(b)) {
          const cen = clamp(1 - Math.hypot(b.x - cx, b.y - cy) / (rmax * 1.25), 0, 1);
          const u = rng.next();
          b.kind = u < 0.05 ? 'parking' : u < 0.12 ? 'shop' : cen > 0.55 ? (u < 0.75 ? 'office' : 'apart') : (u < 0.35 ? 'office' : u < 0.8 ? 'apart' : 'shop');
          b.h = b.kind === 'shop' ? rng.range(4, 11) : b.kind === 'parking' ? rng.range(10, 18) : rng.range(10, 22) + cen * cen * rng.range(10, 80);
          b.id = map.nid++;
          b.acc = { road: R.id, sc: Math.round((sc + front / 2) * 10) / 10, side };
          b.x = Math.round(b.x * 10) / 10; b.y = Math.round(b.y * 10) / 10; b.w = Math.round(b.w * 10) / 10; b.d = Math.round(b.d * 10) / 10; b.h = Math.round(b.h);
          map.blds.push(b); { const q = { b, P: bldCorners(b) }; blds.push(q); bput(q); } placed++;
          sc += front + rng.range(1, 6);
        } else sc += 6;
      }
    }
  }
  return placed;
}
/** 도로 반폭 (넓은 쪽, 가장자리 여유까지) */
function roadHalf(R) { return R.twoWay ? R.cl.med + R.cl.LW * Math.max(R.n[0], R.n[1]) + R.cl.sh : (R.n[0] + R.n[1]) * R.cl.LW / 2 + R.cl.sh; }
/** 점에서 회전한 직사각형까지 거리 (안이면 0) */
function distRect(px, py, b) {
  const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0), dx = px - b.x, dy = py - b.y;
  const u = Math.abs(c * dx + s * dy) - b.w / 2, v = Math.abs(-s * dx + c * dy) - b.d / 2;
  return Math.hypot(Math.max(0, u), Math.max(0, v));
}
/** 두 볼록 사각형이 (여유 m 포함) 겹치나 — 분리축 */
function rectsHit(P, Q, m) {
  for (const poly of [P, Q]) for (let i = 0; i < 4; i++) {
    const a = poly[i], b = poly[(i + 1) % 4], nx = -(b[1] - a[1]), ny = b[0] - a[0], L = Math.hypot(nx, ny) || 1;
    let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
    for (const v of P) { const d = (v[0] * nx + v[1] * ny) / L; p0 = Math.min(p0, d); p1 = Math.max(p1, d); }
    for (const v of Q) { const d = (v[0] * nx + v[1] * ny) / L; q0 = Math.min(q0, d); q1 = Math.max(q1, d); }
    if (p1 + m < q0 || q1 + m < p0) return false;
  }
  return true;
}
/** 견본 이름 → 지도 (건물까지) */
function makeTemplate(kind, o) {
  o = o || {};
  const map = kind === 'organic' ? tplOrganic(o) : kind === 'highway' ? tplHighway(o) : kind === 'metro' ? tplMetro(o) : tplGrid(o);
  autofill(map, o.seed | 0, kind === 'metro' ? 0.55 : 1);
  return map;
}
