/* =============================================================================
   ui.js — HUD / 설정 패널 / 분석 도표

   분석 도표는 교통공학에서 쓰는 세 가지를 그대로 낸다.
   1) 기본도표(fundamental diagram)  : 밀도-교통량 산점. 자유류 가지와 혼잡류 가지,
                                       그리고 용량저하(capacity drop)가 보인다.
   2) 시공간 속도장 (x-t diagram)     : 정체파가 상류로 번지는 모습. 실측에서
                                       -15 ~ -20 km/h 로 알려진 전파속도를 눈으로 확인한다.
   3) 구간별 속도/밀도 띠             : 지금 어디가 막혀 있는지.
   ========================================================================== */
'use strict';

const UI = {
  el: {},
  init(app) {
    this.app = app;
    const ids = ['hud', 'spd', 'spdUnit', 'gaugeArc', 'limitSign', 'stn', 'nextIC', 'gradeV', 'curveV',
      'structV', 'laneV', 'losV', 'kV', 'qV', 'vV', 'delayV', 'ttiV', 'nvehV', 'clockV', 'msg',
      'panel', 'stats', 'fdCv', 'stCv', 'mapCv', 'btnMenu', 'btnClose', 'toast', 'incList'];
    for (const id of ids) this.el[id] = document.getElementById(id);
    this.bindControls();
    this.toastT = 0;
  },

  /* ---------- 설정 ---------- */
  bindControls() {
    const app = this.app;
    // 슬라이더/셀렉트를 cfg 에 연결한다. data-cfg 속성으로 대상 키를 지정.
    for (const inp of $$('[data-cfg]')) {
      const key = inp.dataset.cfg;
      const live = inp.dataset.live === '1';        // 재생성 없이 즉시 반영되는 항목
      const set = () => {
        const v = inp.type === 'checkbox' ? inp.checked
          : (inp.dataset.num === '1' ? parseFloat(inp.value) : inp.value);
        app.cfg[key] = v;
        const out = inp.parentElement.querySelector('.val');
        if (out) out.textContent = this.fmtCfg(key, v);
        if (live) app.applyLive(key);
        else app.markDirty();
      };
      inp.addEventListener('input', set);
      // 초기 표시
      const cur = app.cfg[key];
      if (inp.type === 'checkbox') inp.checked = !!cur; else inp.value = cur;
      const out = inp.parentElement.querySelector('.val');
      if (out) out.textContent = this.fmtCfg(key, cur);
    }
    this.el.btnMenu.addEventListener('click', () => this.togglePanel(true));
    this.el.btnClose.addEventListener('click', () => this.togglePanel(false));
    $('#btnRegen').addEventListener('click', () => { app.rebuild(); this.togglePanel(false); });
    for (const b of $$('[data-preset]')) b.addEventListener('click', () => app.preset(b.dataset.preset));
    for (const b of $$('[data-act]')) b.addEventListener('click', () => app.action(b.dataset.act));
    for (const t of $$('.tab')) t.addEventListener('click', () => {
      for (const x of $$('.tab')) x.classList.toggle('on', x === t);
      for (const x of $$('.tabpage')) x.classList.toggle('on', x.dataset.page === t.dataset.tab);
    });
  },
  fmtCfg(key, v) {
    switch (key) {
      case 'demand': return fmt0(v) + ' 대/시/차로';
      case 'lanes': return v + '차로';
      case 'truckPct': case 'busPct': case 'rampPct': case 'exitPct': return fmt1(v) + '%';
      case 'limit': return v + ' km/h';
      case 'incidentRate': return fmt1(v) + ' 건/시';
      case 'reactionTime': return fmt2(v) + ' s';
      case 'noise': return fmt2(v) + '배';
      case 'length': return fmt1(v / 1000) + ' km';
      case 'seed': return '#' + v;
      case 'relief': case 'density': case 'ruggedness': return fmt0(v);
      case 'tunnelSep': return fmt0(v) + ' m';
      default: return '' + v;
    }
  },
  togglePanel(on) {
    this.el.panel.classList.toggle('on', on);
    this.app.paused = on;
    if (on) this.drawCharts();
  },
  toast(text, sec) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('on');
    this.toastT = sec || 3;
  },

  /* ---------- 매 프레임 HUD ---------- */
  update(dt) {
    const app = this.app, p = app.player, c = app.corrA;
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) this.el.toast.classList.remove('on'); }

    const v = p.v * MS2K;
    this.el.spd.textContent = Math.round(v);
    // 속도계 원호
    const frac = clamp(v / 200, 0, 1);
    this.el.gaugeArc.style.strokeDashoffset = (1 - frac) * 314;
    this.el.gaugeArc.style.stroke = v > app.cfg.limit + 22 ? '#e2574c' : v > app.cfg.limit + 2 ? '#e0a63a' : '#5fc48f';
    this.el.limitSign.textContent = app.cfg.limit;

    const g = c.geo(p.s);
    const grade = c.gradeAt(p.s) * 100;
    const R = Math.abs(g.kap) > 1e-6 ? 1 / Math.abs(g.kap) : Infinity;
    this.el.stn.textContent = fmt1(p.s / 1000) + ' km';
    this.el.gradeV.textContent = (grade >= 0 ? '+' : '') + fmt1(grade) + '%';
    this.el.gradeV.style.color = Math.abs(grade) > 2.5 ? '#e0a63a' : '';
    this.el.curveV.textContent = isFinite(R) ? 'R ' + fmt0(R) + 'm' : '직선';
    const si = app.road.structInfo(c.roadS(p.s));
    this.el.structV.textContent = si ? si.name : (c.auxAt(p.s) ? '부가차로' : '토공');
    this.el.structV.className = 'v ' + (si ? (si.type === 'tunnel' ? 'tun' : 'brg') : '');
    const ic = c.nextIC(p.s);
    this.el.nextIC.textContent = ic ? ic.name + '  ' + distStr(ic.s - p.s) : '—';
    this.el.laneV.textContent = (p.lane === c.nLane ? '부가' : (p.lane + 1) + '차로') +
      (p.offRoad ? ' · 갓길!' : '');
    this.el.laneV.style.color = p.offRoad ? '#e2574c' : '';

    // 주변 교통 상태
    const st = c.localState(p.s, 600);
    this.el.kV.textContent = isFinite(st.k) ? fmt1(st.k) : '—';
    this.el.vV.textContent = isFinite(st.v) ? fmt0(st.v) : '—';
    const los = losOf(st.kp);
    this.el.losV.textContent = los;
    this.el.losV.className = 'los los' + los;
    // 가장 가까운 검지기 유량
    let near = null, bd = 1e9;
    for (const d of c.dets) { const dd = Math.abs(d.s - p.s); if (dd < bd) { bd = dd; near = d; } }
    const h = near && near.hist.length ? near.hist[near.hist.length - 1] : null;
    this.el.qV.textContent = h ? fmt0(h.q / c.nLane) : '—';

    // 지체
    const s = c.stat;
    const mean = s.exited ? s.delaySec / s.exited : 0;
    this.el.delayV.textContent = mmss(mean);
    const tti = s.exited && s.vehSec ? s.vehSec / Math.max(s.vehSec - s.delaySec, 1) : 1;
    this.el.ttiV.textContent = fmt2(tti);
    this.el.nvehV.textContent = fmt0(app.corrA.count() + (app.corrB ? app.corrB.count() : 0));
    this.el.clockV.textContent = mmss(app.simTime);

    // 사고 목록
    if (app.frame % 20 === 0) {
      const rows = [];
      for (const inc of c.incidents) {
        const d = inc.s - p.s;
        rows.push('<li class="' + (inc.lane < 0 ? 'sh' : 'bk') + '">' + inc.kind +
          ' · ' + (inc.lane < 0 ? '갓길' : (inc.lane + 1) + '차로') +
          ' · ' + (d > 0 ? '전방 ' + distStr(d) : '후방 ' + distStr(-d)) +
          ' · 해제까지 ' + mmss(inc.t) + '</li>');
      }
      this.el.incList.innerHTML = rows.length ? rows.join('') : '<li class="none">진행 중인 돌발상황 없음</li>';
    }
  },

  /* ---------- 소형 지도 (전 구간 정체 상황) ---------- */
  drawMap(cv, app) {
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    const c = app.corrA, L = c.L;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#12151c'; ctx.fillRect(0, 0, W, H);
    const laneH = Math.max(2, Math.floor((H - 16) / (c.nLane + 1)));
    const x = (s) => s / L * (W - 8) + 4;
    // 구조물 띠
    for (const st of app.road.structs) {
      const a = c.dir > 0 ? st.s0 : L - st.s1, b = c.dir > 0 ? st.s1 : L - st.s0;
      ctx.fillStyle = st.type === 'tunnel' ? '#3a3550' : '#2f4550';
      ctx.fillRect(x(a), 2, Math.max(1, x(b) - x(a)), H - 4);
    }
    // 차량
    const vfree = app.cfg.limit * KMH;
    for (let li = 0; li < c.lanes.length; li++) {
      const y = 10 + li * laneH;
      for (const v of c.lanes[li]) {
        if (v.obstacle) { ctx.fillStyle = '#ff5a3c'; ctx.fillRect(x(v.s) - 1, y - 1, 3, laneH); continue; }
        ctx.fillStyle = v.isPlayer ? '#ffffff' : speedColor(v.v, vfree);
        ctx.fillRect(x(v.s), y, v.isPlayer ? 3 : 2, laneH - 1);
      }
    }
    // 인터체인지
    ctx.fillStyle = '#8fa6c8'; ctx.font = '9px system-ui';
    for (const ic of c.icLocal) {
      ctx.fillRect(x(ic.s), 0, 1, H);
      ctx.fillText(ic.name, Math.min(x(ic.s) + 2, W - 46), 9);
    }
    // 플레이어 위치 표시
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(app.player.s), 0); ctx.lineTo(x(app.player.s), H); ctx.stroke();
  },

  /* ---------- 분석 도표 ---------- */
  drawCharts() {
    this.drawFD(this.el.fdCv);
    this.drawST(this.el.stCv);
    this.fillStats();
  },

  /** 기본도표 — 밀도 대 교통량 */
  drawFD(cv) {
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    const c = this.app.corrA;
    ctx.fillStyle = '#0f1218'; ctx.fillRect(0, 0, W, H);
    const kMax = 90, qMax = 2600, pad = 42;
    const px = (k) => pad + k / kMax * (W - pad - 10);
    const py = (q) => H - pad - q / qMax * (H - pad - 12);
    // 격자
    ctx.strokeStyle = '#232833'; ctx.lineWidth = 1; ctx.fillStyle = '#6b7383'; ctx.font = '10px system-ui';
    for (let k = 0; k <= kMax; k += 15) {
      ctx.beginPath(); ctx.moveTo(px(k), py(0)); ctx.lineTo(px(k), py(qMax)); ctx.stroke();
      ctx.fillText(k, px(k) - 6, H - pad + 13);
    }
    for (let q = 0; q <= qMax; q += 500) {
      ctx.beginPath(); ctx.moveTo(px(0), py(q)); ctx.lineTo(px(kMax), py(q)); ctx.stroke();
      ctx.fillText(q, 3, py(q) + 3);
    }
    // 서비스수준 경계 (HCM 밀도 기준)
    const LOSK = [7, 11, 16, 22, 28];
    ctx.setLineDash([3, 3]); ctx.strokeStyle = '#3b4454';
    for (let i = 0; i < LOSK.length; i++) {
      ctx.beginPath(); ctx.moveTo(px(LOSK[i]), py(0)); ctx.lineTo(px(LOSK[i]), py(qMax)); ctx.stroke();
      ctx.fillStyle = '#5c6678';
      ctx.fillText('ABCDE'[i], px(LOSK[i]) - 3, py(qMax) + 10);
    }
    ctx.setLineDash([]);
    // 산점
    const pts = c.fd;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.k > kMax || p.q > qMax) continue;
      const age = 1 - i / pts.length;
      ctx.fillStyle = speedColor(p.v * KMH, this.app.cfg.limit * KMH);
      ctx.globalAlpha = 0.28 + 0.62 * (1 - age);
      ctx.fillRect(px(p.k) - 1.4, py(p.q) - 1.4, 2.8, 2.8);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#8b93a3';
    ctx.fillText('밀도 k (pc/km/차로)', W - 118, H - 6);
    ctx.save(); ctx.translate(11, H - pad - 6); ctx.rotate(-Math.PI / 2);
    ctx.fillText('교통량 q (pc/h/차로)', 0, 0); ctx.restore();
  },

  /** 시공간 속도장 */
  drawST(cv) {
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    const c = this.app.corrA;
    ctx.fillStyle = '#0f1218'; ctx.fillRect(0, 0, W, H);
    const rows = c.stRows;
    if (!rows.length) return;
    const pad = 34, gw = W - pad - 8, gh = H - pad - 14;
    const img = ctx.createImageData(gw, gh);
    const vfree = this.app.cfg.limit * KMH;
    for (let y = 0; y < gh; y++) {
      // 위가 과거, 아래가 현재
      const r = rows[Math.min(rows.length - 1, Math.floor(y / (gh - 1) * (rows.length - 1)))];
      if (!r) continue;
      for (let x = 0; x < gw; x++) {
        const ci = Math.floor(x / gw * c.nCell);
        const v = r[ci];
        const o = (y * gw + x) * 4;
        if (v < 0) { img.data[o] = 22; img.data[o + 1] = 25; img.data[o + 2] = 32; img.data[o + 3] = 255; continue; }
        const col = speedColor(v, vfree);
        const n = parseInt(col.slice(1), 16);
        img.data[o] = (n >> 16) & 255; img.data[o + 1] = (n >> 8) & 255; img.data[o + 2] = n & 255; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, pad, 8);
    ctx.strokeStyle = '#2a3040'; ctx.strokeRect(pad, 8, gw, gh);
    ctx.fillStyle = '#6b7383'; ctx.font = '10px system-ui';
    for (let s = 0; s <= c.L; s += 5000) ctx.fillText((s / 1000) + 'km', pad + s / c.L * gw - 8, H - 6);
    const span = rows.length * c.stPeriod;
    ctx.fillText('현재', 4, 8 + gh);
    ctx.fillText('-' + Math.round(span / 60) + '분', 4, 16);
    // 인터체인지 위치
    ctx.strokeStyle = '#ffffff33';
    for (const ic of c.icLocal) {
      const x = pad + ic.s / c.L * gw;
      ctx.beginPath(); ctx.moveTo(x, 8); ctx.lineTo(x, 8 + gh); ctx.stroke();
    }
  },

  /** 통계 표 */
  fillStats() {
    const app = this.app, c = app.corrA, s = c.stat;
    const rows = [];
    const add = (k, v) => rows.push('<tr><th>' + k + '</th><td>' + v + '</td></tr>');
    add('모의 경과시간', mmss(app.simTime));
    add('구간 연장', fmt1(c.L / 1000) + ' km · ' + c.nLane + '차로');
    add('상류 유입 수요', fmt0(c.demandNow()) + ' 대/시 (' + fmt0(c.demandNow() / c.nLane) + ' 대/시/차로)');
    add('구간 내 차량', fmt0(c.count()) + ' 대  (상류 대기 ' + fmt0(c.upstreamQueue()) + ' 대)');
    add('통과 완료', fmt0(s.exited) + ' 대');
    const meanTT = s.exited ? s.vehSec / s.exited : 0;
    const meanFF = s.exited ? (s.vehSec - s.delaySec) / s.exited : 0;
    add('평균 통행시간', mmss(meanTT) + '  (자유주행 기준 ' + mmss(meanFF) + ')');
    add('평균 지체', mmss(s.exited ? s.delaySec / s.exited : 0));
    add('통행시간지수 TTI', fmt2(meanFF > 0 ? meanTT / meanFF : 1));
    add('총 지체', fmt1(s.delaySec / 3600) + ' 대·시');
    const cls = s.byCls;
    for (const k in cls) {
      if (!cls[k].n) continue;
      add(VCLASS[k].name + ' 평균 통행시간', mmss(cls[k].tt / cls[k].n) +
        '  (지체 ' + mmss((cls[k].tt - cls[k].ff) / cls[k].n) + ')');
    }
    // 검지기 요약
    let q = 0, v = 0, n = 0;
    for (const d of c.dets) {
      const h = d.hist.slice(-10);
      for (const r of h) { if (!r.q) continue; q += r.q; v += r.v * 3.6; n++; }
    }
    if (n) {
      add('최근 10분 평균 교통량', fmt0(q / n / c.nLane) + ' 대/시/차로');
      add('최근 10분 평균 속도', fmt1(v / n) + ' km/h');
    }
    let ramp = 0, took = 0;
    for (const r of c.onRamps) ramp += r.served;
    for (const r of c.offRamps) took += r.taken;
    add('램프 진입 / 유출', fmt0(ramp) + ' 대 / ' + fmt0(took) + ' 대');
    add('돌발상황', fmt0(c.incidents.length) + ' 건 진행 중');
    this.el.stats.innerHTML = '<table>' + rows.join('') + '</table>';
  },
};
