#!/usr/bin/env node
/* 주차장 시뮬레이터 회귀 검사 — 브라우저 없이 계산만 돌린다.
     node tools/parking-check.js          (빠르게: 설정 8 가지 × 시드 2)
     node tools/parking-check.js --long   (시드 3, 더 길게)
   설정마다 수요를 걸어 돌린 뒤 수요를 끊고, 안의 차가 모두 빠지는지(교착이 없는지) 본다.
   진입로에서 만차를 기다리는 차는 정상이므로 세지 않는다. 하나라도 남으면 종료 코드 1. */
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', 'js');
global.PScene = {};
for (const f of ['util.js', 'traffic.js', 'parking/garage.js', 'parking/park.js', 'parking/mech.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(R, f), 'utf8'), { filename: f });
}
const long = process.argv.includes('--long');
const base = { W: 64, D: 52, U: 3, B: 2, inRate: 240, outRate: 200, thruRate: 200, initOcc: 0.6, revShare: 0.7, gate: 'lpr', guide: false, balk: 7, lanes: 1 };
const confs = {
  '주차빌딩 6층': { U: 6, B: 0, W: 52, D: 46 },
  '복합': {},
  '지하 3층': { U: 0, B: 3, W: 72, D: 56 },
  '출근 몰림': { inRate: 520, outRate: 60, initOcc: 0.7 },
  '퇴근 몰림': { inRate: 40, outRate: 600, initOcc: 0.95 },
  '유도 시스템': { guide: true },
  '정산 · 2차로': { gate: 'ticket', lanes: 2 },
  '기계식 4기': { kind: 'mech', W: 40, U: 12, B: 1, inRate: 160, outRate: 140 },
};
const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
let bad = 0;
const t0 = Date.now();
for (const [name, c] of Object.entries(confs)) {
  for (const seed of long ? [1, 2, 3] : [1, 2]) {
    const cfg = Object.assign({}, base, c, { seed });
    const mech = cfg.kind === 'mech';
    const G = mech ? buildMech(cfg) : buildGarage(cfg);
    const sim = mech ? new MechSim(G, cfg) : new ParkSim(G, cfg);
    const T = long ? 2400 : 1500;
    for (let t = 0; t < T; t++) sim.step(1);
    const S = sim.summary();
    sim.tIn = sim.tOut = sim.tThru = sim.tThruE = Infinity; sim.pending = 0; sim.batch = 0;
    for (let t = 0; t < 3600; t++) sim.step(1);
    let left = 0;
    for (const v of sim.cars) if ((v.mode === 'drive' || v.mode === 'man' || v.mode === 'mech') && v.stopT > 90 && !(v.edge && v.edge.kind === 'entry')) left++;
    if (left) bad++;
    console.log(`${name.padEnd(10)} 시드${seed}  면 ${String(S.total).padStart(4)}  입차 ${String(S.inN).padStart(4)}  출차 ${String(S.outN).padStart(4)}  ` +
      `주차 소요 중앙 ${String(Math.round(med(sim.st.search))).padStart(3)} s  출차 소요 중앙 ${String(Math.round(med(sim.st.exitT))).padStart(3)} s  ` +
      `교착 풀기 ${sim.st.unjam | 0}  ${left ? '안 빠진 차 ' + left + ' ✗' : '다 빠짐 ✓'}`);
  }
}
console.log(`\n${bad ? '실패 ' + bad + '건' : '모두 통과'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(bad ? 1 : 0);
