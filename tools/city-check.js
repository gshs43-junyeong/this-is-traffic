#!/usr/bin/env node
/* 도시 교통 시뮬레이터 회귀 검사 — 브라우저 없이 계산만 돌린다.
     node tools/city-check.js          (설정 9 가지 × 시드 2, 수요 20 분)
     node tools/city-check.js --long   (시드 3, 수요 40 분)
   견본 도시(격자 · 유기형 · 고속도로) 와 편집기로만 만들 수 있는 것(일시정지 · 막다른 길 · 일방통행 · 여섯 갈래 ·
   사용자 지정 차로 방향 · 좌회전 둘)을 모은 지도를 돌린 뒤 수요를 끊고, 도로 위 차가 모두 빠지는지 본다.
   남은 차가 있거나 교착 해소(도로망에서 뺀 차)가 도착의 2 % 를 넘거나, 지도 경고가 있으면 종료 코드 1. */
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', 'js');
for (const f of ['util.js', 'traffic.js', 'city/cnet.js', 'city/cmap.js', 'city/csim.js']) vm.runInThisContext(fs.readFileSync(path.join(R, f), 'utf8'), { filename: f });
const long = process.argv.includes('--long');

/** 편집기로 만든 것 같은 지도 — 일시정지 · 막다른 길 · 일방통행 · 여섯 갈래 · 좌회전 둘 · 곡선 */
function customMap() {
  const m = newMap(), N = (x, y) => addNode(m, x, y).id;
  const a = N(0, 0), b = N(200, 0), c = N(400, 0), d = N(200, 180), e = N(0, 180), f = N(400, 180), g = N(320, 90);
  const gw = N(-200, 0), ge = N(600, 0), gn = N(200, 420), gs = N(200, -200);
  addRoad(m, gw, a, { cls: 'arterial', lanes: [2, 2] }); addRoad(m, a, b, { cls: 'arterial', lanes: [2, 2] }); addRoad(m, b, c, { cls: 'arterial', lanes: [2, 2] }); addRoad(m, c, ge, { cls: 'arterial', lanes: [2, 2] });
  addRoad(m, gs, b, { cls: 'street', lanes: [2, 2] }); addRoad(m, b, d, { cls: 'street', lanes: [2, 2], c1: [260, 60], c2: [160, 120] });
  addRoad(m, d, gn, { cls: 'street', lanes: [2, 2] });
  addRoad(m, e, d, { cls: 'local', lanes: [1, 1] }); addRoad(m, a, e, { cls: 'local', lanes: [1, 0] });
  addRoad(m, d, f, { cls: 'local', lanes: [1, 1] }); addRoad(m, f, c, { cls: 'local', lanes: [1, 1] });
  addRoad(m, d, g, { cls: 'local', lanes: [1, 1] });
  addRoad(m, e, N(-60, 260), { cls: 'street', lanes: [2, 2] });
  addRoad(m, d, N(120, 300), { cls: 'street', lanes: [2, 2] });
  m.nodes.find((n) => n.id === e).ctl = 'stop';
  m.roads.find((r) => r.a === a && r.b === b).ends.b = { bl: 2, mv: ['L', 'L', 'S', 'SR'] };
  autofill(m, 3, 1);
  m.name = '편집 기능 모음';
  return m;
}
const confs = [
  ['격자 4×4', () => makeTemplate('grid', { NX: 4, NY: 4, B: 150, lanes: 2, seed: 1 }), { demand: 2000 }],
  ['격자 방향별 신호', () => { const m = makeTemplate('grid', { NX: 4, NY: 4, B: 150, lanes: 2, seed: 1 }); m.sig.phase = 'approach'; return m; }, { demand: 1800 }],
  ['격자 연동', () => makeTemplate('grid', { NX: 5, NY: 3, B: 150, lanes: 2, seed: 1 }), { demand: 2000, coord: true }],
  ['격자 왕복 2차로', () => makeTemplate('grid', { NX: 4, NY: 4, B: 140, lanes: 1, seed: 1 }), { demand: 900 }],
  ['유기형', () => makeTemplate('organic', { seed: 1 }), { demand: 2000 }],
  ['유기형 혼잡', () => makeTemplate('organic', { seed: 1 }), { demand: 3200 }],
  ['고속도로 도시', () => makeTemplate('highway', { seed: 1 }), { demand: 2000 }],
  ['고속도로 혼잡', () => makeTemplate('highway', { seed: 1 }), { demand: 2800 }],
  ['편집 기능 모음', customMap, { demand: 600 }],
];
let bad = 0;
const t0 = Date.now();
for (const [name, mk, c] of confs) {
  for (const seed of long ? [1, 2, 3] : [1, 2]) {
    const map = mk(), net = compileNet(map);
    const cfg = Object.assign({ inner: 0.5, coord: false }, c, { seed });
    const sim = new CitySim(net, cfg);
    const T = long ? 2400 : 1200;
    for (let t = 0; t < T; t += 5) sim.step(5);
    const S = sim.summary();
    sim.tTrip = Infinity;
    let t = 0;
    while ((sim.cars.length || sim.pendGate.length || sim.pendBld.length) && t < 1500) { sim.step(5); t += 5; }
    const left = sim.cars.length, uj = sim.st.unjam, done = sim.st.done;
    const ok = left === 0 && uj <= Math.max(3, done * 0.02) && !net.warn.length;
    if (!ok) bad++;
    const los = {}; for (const N of net.nodes) if (N.ctl === 'signal' || N.ctl === 'stop') los[N.los] = (los[N.los] || 0) + 1;
    console.log(`${ok ? 'OK ' : 'BAD'} ${name.padEnd(9)} s${seed}  도착 ${String(done).padStart(5)} · 시간당 ${String(S.perH).padStart(5)} · 평균 ${(S.vAvg * 3.6).toFixed(1).padStart(5)} km/h · 지체 ${S.delay.toFixed(0).padStart(4)} s · 정지 ${S.stops.toFixed(1)} · 건물 ${S.bIn}/${S.bOut} · 서비스 ${Object.keys(los).sort().map((k) => k + los[k]).join(' ')} · 교착 해소 ${uj} · 우회 ${sim.st.detour} · 비우기 ${t} s${left ? ' · 남은 차 ' + left : ''}${net.warn.length ? ' · 경고 ' + net.warn.map((w) => w.msg).join(', ') : ''}`);
  }
}
console.log(`${bad ? '실패 ' + bad : '모두 통과'} — ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(bad ? 1 : 0);
