#!/usr/bin/env node
/* 도시 교통 시뮬레이터 회귀 검사 — 브라우저 없이 계산만 돌린다.
     node tools/city-check.js          (설정 9 가지 × 시드 2, 수요 20 분)
     node tools/city-check.js --long   (시드 3, 수요 40 분)
   수요를 걸어 돌린 뒤 끊고, 도로 위 차가 모두 빠지는지 본다. 남은 차가 있거나
   교착 해소(도로망에서 뺀 차)가 도착의 2 % 를 넘으면 종료 코드 1. */
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', 'js');
for (const f of ['util.js', 'traffic.js', 'city/csim.js']) vm.runInThisContext(fs.readFileSync(path.join(R, f), 'utf8'), { filename: f });
const long = process.argv.includes('--long');
const base = { NX: 4, NY: 4, B: 140, lanes: 2, cycle: 100, phase: 'lead', coord: false, demand: 2000, inner: 0.4 };
const confs = {
  '기본 도심': {},
  '방향별 동시': { phase: 'approach' },
  '녹색 물결': { coord: true, demand: 2200 },
  '출퇴근 혼잡': { demand: 3200, inner: 0.25 },
  '좁은 길': { lanes: 1, demand: 900, cycle: 80 },
  '대로': { lanes: 3, B: 220, NX: 4, NY: 3, cycle: 120, demand: 2200 },
  '넓은 도시': { NX: 7, NY: 7, B: 130, demand: 4200 },
  '작은 격자': { NX: 2, NY: 2, B: 100, demand: 600 },
  '도심 안만': { inner: 1, demand: 1500 },
};
let bad = 0;
const t0 = Date.now();
for (const [name, c] of Object.entries(confs)) {
  for (const seed of long ? [1, 2, 3] : [1, 2]) {
    const cfg = Object.assign({}, base, c, { seed });
    const C = buildCity(cfg), sim = new CitySim(C, cfg);
    const T = long ? 2400 : 1200;
    for (let t = 0; t < T; t += 5) sim.step(5);
    const S = sim.summary();
    // 수요를 끊고 비운다
    sim.tTrip = Infinity;
    let t = 0;
    while ((sim.cars.length || sim.pendGate.length || sim.pendZone.length) && t < 1500) { sim.step(5); t += 5; }
    const left = sim.cars.length, uj = sim.st.unjam | 0, done = sim.st.done;
    const ok = left === 0 && uj <= Math.max(2, done * 0.02);
    if (!ok) bad++;
    const los = {}; for (const I of C.ints) los[I.los] = (los[I.los] || 0) + 1;
    console.log(`${ok ? 'OK ' : 'BAD'} ${name.padEnd(8)} s${seed}  도착 ${String(done).padStart(5)} · 시간당 ${String(S.perH).padStart(5)} · 평균 ${(S.vAvg * 3.6).toFixed(1).padStart(5)} km/h · 지체 ${S.delay.toFixed(0).padStart(4)} s · 정지 ${S.stops.toFixed(1)} · 서비스 ${Object.keys(los).sort().map((k) => k + los[k]).join(' ')} · 교착 해소 ${uj} · 우회 ${sim.st.detour | 0} · 비우기 ${t} s${left ? ' · 남은 차 ' + left : ''}`);
  }
}
console.log(`${bad ? '실패 ' + bad : '모두 통과'} — ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(bad ? 1 : 0);
