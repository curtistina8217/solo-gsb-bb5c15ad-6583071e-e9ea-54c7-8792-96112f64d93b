'use strict';

/* 圆筒包装接缝避让前端：参数表单、结果列表、Canvas 预览与拖动吸附 */

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const state = {
  mode: 'single',      // 'single' | 'multi'
  result: null,        // 单规格：服务端计算结果
  multiResult: null,   // 多规格：服务端计算结果
  lastInput: null,     // 最近一次成功计算的单规格输入（供快照保存/载入）
  thetaMm: 0,          // 单规格：当前接缝位置 (mm, [0, C))
  thetaDeg: 0,         // 多规格：当前共用角度 (°, [0, 360))
  dragging: false,
  rawDeg: null,        // 拖动时未吸附的原始角度（角度域）
  selected: [],        // 选中的快照 id（按选择顺序，最多 2 个）
  currentDiff: null,   // 当前展示的差异结果
};

const TAU = Math.PI * 2;
const mod = (n, m) => ((n % m) + m) % m;
const fmtMm = (x) => String(Math.round(x * 100) / 100);
const fmtDeg = (x) => (Math.round(x * 10) / 10).toFixed(1);

const MAX_CIRC = 8;
const SPEC_COLORS = [
  '#d43a3a', '#e8912d', '#7c3aed', '#0ea5e9',
  '#db2777', '#65a30d', '#0891b2', '#b45309',
];
const specColor = (i) => SPEC_COLORS[i % SPEC_COLORS.length];

/* ---------------- 模式切换 ---------------- */

function setMode(mode) {
  if (mode !== 'single' && mode !== 'multi') return;
  state.mode = mode;
  document.querySelectorAll('#modeSwitch button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  $('circumferenceField').hidden = mode !== 'single';
  $('multiCirc').hidden = mode !== 'multi';
  $('singleResults').hidden = mode !== 'single';
  $('multiResults').hidden = mode !== 'multi';
  $('saveSnapshot').disabled = mode === 'multi';
  $('saveSnapshot').title = mode === 'multi' ? '多规格模式下快照仅保存单规格结果' : '';
  $('previewTitle').innerHTML =
    mode === 'multi'
      ? '预览 <span class="hint">各规格禁用环叠加，外环为共用可行段；拖动吸附到共用段</span>'
      : '预览 <span class="hint">拖动圆盘旋转，自动吸附到最近可行位置</span>';
  exitDiffMode();
  scheduleCompute();
}

document.querySelectorAll('#modeSwitch button').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

/* ---------------- 输入表单 ---------------- */

function addCircRow(value = '') {
  const row = document.createElement('div');
  row.className = 'circ-row';
  row.innerHTML = `
    <label>规格 <span class="circ-index"></span> 周长 (mm)
      <input type="number" min="0.01" step="any" class="circ-value" value="${value}">
    </label>
    <button type="button" class="remove" title="删除">✕</button>`;
  row.querySelector('.remove').addEventListener('click', () => {
    row.remove();
    refreshCircIndex();
    scheduleCompute();
  });
  row.querySelector('input').addEventListener('input', scheduleCompute);
  $('circRows').appendChild(row);
  refreshCircIndex();
}

function refreshCircIndex() {
  [...document.querySelectorAll('.circ-row')].forEach((row, i) => {
    row.querySelector('.circ-index').textContent = i + 1;
  });
}

function addZoneRow(start = '', end = '') {
  const row = document.createElement('div');
  row.className = 'zone-row';
  row.innerHTML = `
    <label>起点 (mm)<input type="number" step="any" class="z-start" value="${start}"></label>
    <label>终点 (mm)<input type="number" step="any" class="z-end" value="${end}"></label>
    <button type="button" class="remove" title="删除">✕</button>`;
  row.querySelector('.remove').addEventListener('click', () => {
    row.remove();
    scheduleCompute();
  });
  row.querySelectorAll('input').forEach((i) => i.addEventListener('input', scheduleCompute));
  $('zones').appendChild(row);
}

function readInputs() {
  const seamWidth = parseFloat($('seamWidth').value);
  const zones = [...document.querySelectorAll('.zone-row')].map((row) => ({
    start: parseFloat(row.querySelector('.z-start').value),
    end: parseFloat(row.querySelector('.z-end').value),
  }));
  const circumference = parseFloat($('circumference').value);
  const circumferences = [...document.querySelectorAll('.circ-row .circ-value')].map((el) =>
    parseFloat(el.value)
  );
  return { circumference, circumferences, seamWidth, zones };
}

/* ---------------- 计算 ---------------- */

let computeTimer = null;
function scheduleCompute() {
  clearTimeout(computeTimer);
  computeTimer = setTimeout(compute, 250);
}

async function compute() {
  const body = readInputs();
  $('error').hidden = true;

  if (!Number.isFinite(body.seamWidth) || body.seamWidth < 0) {
    return showError('接缝安全宽度必须为不小于 0 的数值');
  }
  if (body.zones.some((z) => !Number.isFinite(z.start) || !Number.isFinite(z.end))) {
    return showError('保护区的起点与终点必须为数值 (mm)');
  }

  if (state.mode === 'multi') {
    if (body.circumferences.some((c) => !Number.isFinite(c) || c <= 0)) {
      return showError('每个规格的周长必须为大于 0 的数值');
    }
    if (body.circumferences.length < 2 || body.circumferences.length > MAX_CIRC) {
      return showError(`请输入 2～${MAX_CIRC} 个规格周长`);
    }
    return computeMulti(body);
  }

  if (!Number.isFinite(body.circumference) || body.circumference <= 0) {
    return showError('筒体周长必须为大于 0 的数值');
  }

  let result;
  try {
    const res = await fetch('/api/compute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        circumference: body.circumference,
        seamWidth: body.seamWidth,
        zones: body.zones,
      }),
    });
    result = await res.json();
    if (!res.ok) return showError(result.error || '计算失败');
  } catch (e) {
    return showError('无法连接服务器：' + e.message);
  }

  state.result = result;
  state.lastInput = body;
  // 默认选择：距禁用边界最远、角度最小的旋转量
  if (result.best) state.thetaMm = result.best.mm;
  exitDiffMode();
  renderResults();
  draw();
}

async function computeMulti(body) {
  const payload = {
    circumferences: body.circumferences,
    seamWidth: body.seamWidth,
    zones: body.zones,
  };
  let result;
  try {
    const res = await fetch('/api/compute-multi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    result = await res.json();
    if (!res.ok) return showError(result.error || '计算失败');
  } catch (e) {
    return showError('无法连接服务器：' + e.message);
  }

  state.multiResult = result;
  if (result.best) state.thetaDeg = result.best.deg;
  exitDiffMode();
  renderMultiResults();
  draw();
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = false;
}

/* ---------------- 结果渲染 ---------------- */

function segText(s) {
  if (s.widthDeg !== undefined && s.widthDeg >= 360 - 1e-6) {
    return `0.0° → 360.0°（整圈）`;
  }
  const range = `${fmtDeg(s.startDeg)}° → ${fmtDeg(s.endDeg)}°`;
  const mm = `${fmtMm(s.startMm)} → ${fmtMm(s.endMm)} mm`;
  const wrap = s.wraps ? '（跨零点）' : '';
  return `${range} ｜ ${mm}${wrap}`;
}

function renderResults() {
  const r = state.result;

  const bestBox = $('bestBox');
  if (r.best) {
    bestBox.hidden = false;
    bestBox.innerHTML =
      `默认旋转量（距禁用边界最远、角度最小）：<br>` +
      `<span class="num">${fmtDeg(r.best.deg)}°</span> ＝ ${fmtMm(r.best.mm)} mm`;
  } else {
    bestBox.hidden = true;
  }

  $('noSolutionBox').hidden = !r.noSolution;
  if (r.noSolution) {
    $('chainList').innerHTML = r.forbiddenChain
      .map(
        (c, i) =>
          `<div class="chain-item">链节 ${i + 1}：${fmtDeg(c.startDeg)}° → ${fmtDeg(c.endDeg)}°` +
          `（${fmtMm(c.startMm)} → ${fmtMm(c.endMm)} mm）</div>`
      )
      .join('');
  }

  $('feasibleCount').textContent = r.noSolution ? '（无）' : `（共 ${r.feasible.length} 段）`;
  const fl = $('feasibleList');
  fl.innerHTML = '';
  r.feasible.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'feasible';
    li.innerHTML = `<span>段 ${i + 1}：${segText(s)}</span><span class="tag">宽 ${fmtDeg(s.widthDeg)}°</span>`;
    li.title = '点击将该段中点设为接缝位置';
    li.addEventListener('click', () => {
      const C = r.circumference;
      const sMm = s.startMm;
      const eMm = s.wraps ? s.endMm + C : s.endMm;
      state.thetaMm = mod((sMm + eMm) / 2, C);
      renderResults();
      draw();
    });
    fl.appendChild(li);
  });
  markActiveSegment();

  const dl = $('forbiddenList');
  dl.innerHTML = '';
  if (r.forbiddenMerged.length === 0) {
    dl.innerHTML = '<li class="forbidden">无禁用区间，整圈可行</li>';
  } else {
    r.forbiddenMerged.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'forbidden';
      li.innerHTML = `<span>禁用 ${i + 1}：${segText(s)}</span>`;
      dl.appendChild(li);
    });
  }
}

function markActiveSegment() {
  const r = state.result;
  if (!r || r.noSolution) return;
  const C = r.circumference;
  [...$('feasibleList').children].forEach((li, i) => {
    const s = r.feasible[i];
    const eMm = s.wraps ? s.endMm + C : s.endMm;
    const t = state.thetaMm;
    li.classList.toggle('active', (t >= s.startMm && t <= eMm) || (t + C >= s.startMm && t + C <= eMm));
  });
}

/* ---------------- 多规格结果渲染 ---------------- */

function commonSegText(s) {
  if (s.full) return '0.0° → 360.0°（整圈）';
  if (s.wraps) {
    return `${fmtDeg(s.startDeg)}° → 360.0° ｜ 0.0° → ${fmtDeg(s.endDeg)}°（跨零点，宽 ${fmtDeg(s.widthDeg)}°）`;
  }
  return `${fmtDeg(s.startDeg)}° → ${fmtDeg(s.endDeg)}°`;
}

/** 角度段在某规格周长下的毫米范围（处理跨零点展示）。 */
function commonSegMmText(s, C) {
  if (s.full) return `0 → ${fmtMm(C)} mm`;
  const a = (s.startDeg / 360) * C;
  const b = (s.endDeg / 360) * C;
  return s.wraps ? `${fmtMm(a)} → ${fmtMm(C)} ｜ 0 → ${fmtMm(b)} mm` : `${fmtMm(a)} → ${fmtMm(b)} mm`;
}

/** 角度 deg 是否落在（可能跨零、由 startDeg+widthDeg 给出的）共用段内。 */
function degInCommon(seg, deg) {
  if (seg.full) return true;
  const start = mod(seg.startDeg, 360);
  const end = start + seg.widthDeg;
  if (end <= 360 + 1e-9) return deg >= start - 1e-9 && deg <= end + 1e-9;
  return deg >= start - 1e-9 || deg <= end - 360 + 1e-9;
}

function renderMultiResults() {
  const r = state.multiResult;

  const bestBox = $('multiBestBox');
  if (r.best) {
    bestBox.hidden = false;
    const perSpec = r.best.perSpec
      .map(
        (p) =>
          `规格 ${p.index + 1}（C=${fmtMm(p.circumference)}）：${fmtMm(p.mm)} mm` +
          `，最小间隙 ${fmtDeg(p.minClearanceDeg)}° ＝ ${fmtMm(p.minClearanceMm)} mm`
      )
      .join('<br>');
    bestBox.innerHTML =
      `默认共用角度（各规格下最小间隙最大、并列取较小角度）：<br>` +
      `<span class="num">${fmtDeg(r.best.deg)}°</span>` +
      `（最小间隙 ${fmtDeg(r.best.minClearanceDeg)}° ＝ ${fmtMm(r.best.minClearanceMm)} mm）<br>` +
      `<span class="per-spec">${perSpec}</span>`;
  } else {
    bestBox.hidden = true;
  }

  $('multiConflictBox').hidden = !r.noCommonSolution;
  if (r.noCommonSolution && r.culprit) {
    const cu = r.culprit;
    let html =
      `<div class="conflict-head">交集在规格 ${cu.index + 1}（周长 ${fmtMm(cu.circumference)} mm）` +
      `首次归零。冲突区间（归零前共同可行段 ∩ 该规格禁用段）：</div>`;
    html += cu.conflictPairs
      .map(
        (p, i) =>
          `<div class="chain-item">冲突 ${i + 1}：${fmtDeg(p.overlap[0])}° → ${fmtDeg(p.overlap[1])}°` +
          `（共同段 ${fmtDeg(p.feasible[0])}° → ${fmtDeg(p.feasible[1])}°` +
          ` 被禁用段 ${fmtDeg(p.forbidden[0])}° → ${fmtDeg(p.forbidden[1])}° 覆盖）</div>`
      )
      .join('');
    $('conflictList').innerHTML = html;
  }

  $('commonCount').textContent = r.noCommonSolution
    ? '（无）'
    : `（共 ${r.commonSegments.length} 段）`;
  const cl = $('commonList');
  cl.innerHTML = '';
  r.commonSegments.forEach((s) => {
    const li = document.createElement('li');
    li.className = 'feasible common';
    const mmRef = r.specs.map(
      (sp) => `规格${sp.index + 1}：${commonSegMmText(s, sp.circumference)}`
    );
    li.innerHTML =
      `<div><div>${commonSegText(s)}</div>` +
      `<div class="tag mm-ref">${mmRef.join('<br>')}</div></div>` +
      `<span class="tag">宽 ${fmtDeg(s.widthDeg)}°</span>`;
    li.title = '点击将该段中点设为共用角度';
    li.addEventListener('click', () => {
      const mid = s.full ? 0 : mod(s.startDeg + s.widthDeg / 2, 360);
      state.thetaDeg = mid;
      markActiveCommon();
      draw();
    });
    cl.appendChild(li);
  });
  markActiveCommon();

  const sl = $('specList');
  sl.innerHTML = '';
  r.specs.forEach((sp) => {
    const div = document.createElement('div');
    div.className = 'spec-block' + (r.culprit && r.culprit.index === sp.index ? ' culprit' : '');
    const full = sp.forbiddenDeg.length === 1 && sp.forbiddenDeg[0][0] <= 1e-6 &&
      sp.forbiddenDeg[0][1] >= 360 - 1e-6;
    const ranges = sp.forbiddenDeg
      .map(([a, b]) => (a <= 1e-6 && b >= 360 - 1e-6 ? '整圈禁用' : `${fmtDeg(a)}°→${fmtDeg(b)}°`))
      .join('，');
    div.innerHTML =
      `<div class="spec-head"><span class="spec-dot" style="background:${specColor(sp.index)}"></span>` +
      `规格 ${sp.index + 1}：C=${fmtMm(sp.circumference)} mm，接缝 ${fmtDeg(sp.seamWidthDeg)}°` +
      (sp.noSolution ? '<span class="spec-nosol">单规格无解</span>' : '') +
      (r.culprit && r.culprit.index === sp.index ? '<span class="spec-culprit">交集归零</span>' : '') +
      `</div><div class="spec-ranges">${full ? '禁用：整圈' : '禁用：' + (ranges || '无')}</div>`;
    sl.appendChild(div);
  });
}

function markActiveCommon() {
  const r = state.multiResult;
  if (!r || r.noCommonSolution) return;
  [...$('commonList').children].forEach((li, i) => {
    li.classList.toggle('active', degInCommon(r.commonSegments[i], state.thetaDeg));
  });
}

/* ---------------- 吸附 ---------------- */

/** 将角度 m (mm) 吸附到最近可行位置；无解时返回 null */
function snapToFeasible(m) {
  const r = state.result;
  if (!r || r.noSolution) return null;
  const C = r.circumference;
  if (r.feasible.length === 0) return null;

  const inGap = (x) =>
    r.feasible.some((s) => {
      const e = s.wraps ? s.endMm + C : s.endMm;
      return (x >= s.startMm && x <= e) || (x + C >= s.startMm && x + C <= e);
    });

  if (inGap(m)) return m;

  let best = null;
  for (const s of r.feasible) {
    const e = s.wraps ? s.endMm + C : s.endMm;
    for (const cand of [mod(s.startMm, C), mod(e, C)]) {
      const d = Math.min(Math.abs(cand - m), C - Math.abs(cand - m));
      if (!best || d < best.d) best = { d, v: cand };
    }
  }
  return best ? best.v : null;
}

/** 多规格：将角度 deg 吸附到最近的共用可行位置；无共同解时返回 null。 */
function snapToCommonFeasible(deg) {
  const r = state.multiResult;
  if (!r || r.noCommonSolution) return null;
  const segs = r.commonSegments;
  if (segs.length === 0) return null;

  if (segs.some((s) => degInCommon(s, deg))) return deg;

  let best = null;
  for (const s of segs) {
    if (s.full) return deg;
    for (const cand of [mod(s.startDeg, 360), mod(s.startDeg + s.widthDeg, 360)]) {
      const d = Math.min(Math.abs(cand - deg), 360 - Math.abs(cand - deg));
      if (!best || d < best.d) best = { d, v: cand };
    }
  }
  return best ? best.v : null;
}

/* ---------------- Canvas ---------------- */

function geom() {
  const dpr = window.devicePixelRatio || 1;
  const size = 520;
  if (canvas.width !== size * dpr) {
    canvas.width = size * dpr;
    canvas.height = size * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { cx: size / 2, cy: size / 2, R: 170, size };
}

/** 我们的角度约定：0° 在正上方，顺时针为正；转为 canvas 弧度 */
function rad(mmAngle, C) {
  return (mmAngle / C) * TAU - Math.PI / 2;
}

function arc(cx, cy, r, a0, a1) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1, false);
  ctx.stroke();
}

function drawRingSegments(cx, cy, r, segments, C, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  for (const s of segments) {
    const span =
      s.widthMm !== undefined ? s.widthMm : (s.wraps ? s.endMm + C : s.endMm) - s.startMm;
    if (span >= C - 1e-9) {
      arc(cx, cy, r, 0, TAU); // 整圈
      continue;
    }
    const a0 = rad(s.startMm, C);
    const a1 = s.wraps ? rad(s.endMm + C, C) : rad(s.endMm, C);
    arc(cx, cy, r, a0, a1);
  }
}

function radDeg(deg) {
  return (deg / 360) * TAU - Math.PI / 2;
}

function drawDegRing(cx, cy, r, segs, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  for (const [a, b] of segs) {
    if (b - a <= 1e-7) continue;
    ctx.beginPath();
    if (a <= 1e-7 && b >= 360 - 1e-7) {
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
    } else if (b <= 360 + 1e-7) {
      ctx.arc(cx, cy, r, radDeg(a), radDeg(b), false);
      ctx.stroke();
    } else {
      // 跨零点线性弧：a→360 与 0→(b-360) 两段
      ctx.arc(cx, cy, r, radDeg(a), radDeg(0) - 0.0001, false);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r, radDeg(0), radDeg(b - 360), false);
      ctx.stroke();
    }
  }
}

function drawTicks(cx, cy, R) {
  ctx.strokeStyle = '#d1d5db';
  ctx.fillStyle = '#9ca3af';
  ctx.lineWidth = 1;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let d = 0; d < 360; d += 30) {
    const a = radDeg(d);
    const x1 = cx + (R + 14) * Math.cos(a);
    const y1 = cy + (R + 14) * Math.sin(a);
    const x2 = cx + (R + 22) * Math.cos(a);
    const y2 = cy + (R + 22) * Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.fillText(`${d}°`, cx + (R + 36) * Math.cos(a), cy + (R + 36) * Math.sin(a));
  }
}

/** 圆周上的指向箭头（与单规格 best 标记同款）。 */
function drawAngleMarker(cx, cy, r, angleDeg, color) {
  const ab = radDeg(angleDeg);
  const bx = cx + r * Math.cos(ab);
  const by = cy + r * Math.sin(ab);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - 6 * Math.cos(ab - 0.35), by - 6 * Math.sin(ab - 0.35));
  ctx.lineTo(bx - 6 * Math.cos(ab + 0.35), by - 6 * Math.sin(ab + 0.35));
  ctx.closePath();
  ctx.fill();
}

function draw() {
  if (state.mode === 'multi') return drawMulti();
  const r = state.result;
  const { cx, cy, R, size } = geom();
  ctx.clearRect(0, 0, size, size);
  if (!r) return;
  const C = r.circumference;

  drawTicks(cx, cy, R);

  // 外环底色
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 20;
  arc(cx, cy, R, 0, TAU);

  if (r.noSolution) {
    // 无解：整圈禁用区间链
    drawRingSegments(cx, cy, R, r.forbiddenChain, C, '#d43a3a', 20);
  } else {
    drawRingSegments(cx, cy, R, r.feasible, C, '#1e9e50', 20);
    drawRingSegments(cx, cy, R, r.forbiddenMerged, C, '#d43a3a', 20);
  }

  // 印刷保护区（内环）
  const zoneSegs = [];
  for (const pieces of r.zonePieces) {
    for (const p of pieces) zoneSegs.push({ startMm: p.startMm, endMm: p.endMm, wraps: false });
  }
  ctx.globalAlpha = 0.9;
  drawRingSegments(cx, cy, R - 34, zoneSegs, C, '#e8912d', 12);
  ctx.globalAlpha = 1;

  // 接缝扇形（宽度 = 接缝安全宽度）
  const theta = state.thetaMm;
  const a0 = rad(theta, C);
  const a1 = rad(theta + r.seamWidth, C);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R - 46, a0, a1, false);
  ctx.closePath();
  ctx.fillStyle = r.noSolution ? 'rgba(212,58,58,0.18)' : 'rgba(37,99,235,0.18)';
  ctx.fill();

  // 接缝位置线
  ctx.strokeStyle = r.noSolution ? '#d43a3a' : '#2563eb';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx + (R - 46) * Math.cos(a0), cy + (R - 46) * Math.sin(a0));
  ctx.lineTo(cx + (R + 26) * Math.cos(a0), cy + (R + 26) * Math.sin(a0));
  ctx.stroke();

  // 拖动时未吸附的原始位置（虚线）
  if (state.dragging && state.rawMm !== null && Math.abs(mod(state.rawMm - theta + C / 2, C) - C / 2) > C / 720) {
    const ar = rad(state.rawMm, C);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + (R - 46) * Math.cos(ar), cy + (R - 46) * Math.sin(ar));
    ctx.lineTo(cx + (R + 26) * Math.cos(ar), cy + (R + 26) * Math.sin(ar));
    ctx.stroke();
    ctx.restore();
  }

  // 最优位置标记
  if (r.best) {
    const ab = rad(r.best.mm, C);
    const bx = cx + (R + 10) * Math.cos(ab);
    const by = cy + (R + 10) * Math.sin(ab);
    ctx.fillStyle = '#065f46';
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - 6 * Math.cos(ab - 0.35), by - 6 * Math.sin(ab - 0.35));
    ctx.lineTo(bx - 6 * Math.cos(ab + 0.35), by - 6 * Math.sin(ab + 0.35));
    ctx.closePath();
    ctx.fill();
  }

  // 中心文字
  ctx.fillStyle = '#1f2937';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (r.noSolution) {
    ctx.fillStyle = '#d43a3a';
    ctx.fillText('无解', cx, cy - 12);
    ctx.font = '13px sans-serif';
    ctx.fillText('禁用区间覆盖整圈', cx, cy + 14);
  } else {
    ctx.fillText(`${fmtDeg((theta / C) * 360)}°`, cx, cy - 10);
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#6b7280';
    ctx.fillText(`${fmtMm(theta)} mm`, cx, cy + 14);
  }

  // 图例
  const legend = r.noSolution
    ? [['#d43a3a', '禁用（覆盖整圈）'], ['#e8912d', '印刷保护区']]
    : [['#1e9e50', '可行'], ['#d43a3a', '禁用'], ['#e8912d', '印刷保护区'], ['#2563eb', '接缝']];
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  let lx = 16;
  for (const [color, label] of legend) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, size - 22, 12, 12);
    ctx.fillStyle = '#374151';
    ctx.fillText(label, lx + 16, size - 15);
    lx += 16 + ctx.measureText(label).width + 18;
  }

  // 当前位置文字
  const deg = fmtDeg((theta / C) * 360);
  $('currentPos').textContent = r.noSolution
    ? '当前无可行位置：请缩小接缝宽度或调整保护区'
    : `当前接缝位置：${deg}°（${fmtMm(theta)} mm）`;
  markActiveSegment();
}

/* ---------------- 多规格 Canvas ---------------- */

function drawMulti() {
  const r = state.multiResult;
  const { cx, cy, R, size } = geom();
  ctx.clearRect(0, 0, size, size);
  if (!r) return;

  drawTicks(cx, cy, R);

  const n = r.specs.length;
  const ringW = Math.max(5, Math.min(10, (R - 70) / Math.max(1, n) - 3));
  const commonR = R;
  const firstInnerR = R - 30;
  const ringRadius = (i) => firstInnerR - i * (ringW + 3);

  // 各规格禁用环（由外向内叠加）
  r.specs.forEach((sp) => {
    const rr = ringRadius(sp.index);
    drawDegRing(cx, cy, rr, [[0, 360]], '#eef0f2', ringW);
    drawDegRing(cx, cy, rr, sp.forbiddenDeg, specColor(sp.index), ringW);
  });

  // 外环底色 + 共用可行段
  drawDegRing(cx, cy, commonR, [[0, 360]], '#e5e7eb', 18);
  if (!r.noCommonSolution) {
    // 共用段在角度域可能跨零点，拆成 [0,360] 内不跨零弧段
    const pairs = [];
    for (const s of r.commonSegments) {
      if (s.full) {
        pairs.push([0, 360]);
      } else if (s.wraps) {
        pairs.push([s.startDeg, 360]);
        pairs.push([0, s.endDeg]);
      } else {
        pairs.push([s.startDeg, s.endDeg]);
      }
    }
    drawDegRing(cx, cy, commonR, pairs, '#1e9e50', 18);
  } else if (r.culprit) {
    // 冲突重叠段在外环高亮
    const overlaps = r.culprit.conflictPairs.map((p) => p.overlap);
    drawDegRing(cx, cy, commonR, overlaps, '#b45309', 18);
  }

  // 各规格在当前角度的接缝位置径向线
  const theta = state.thetaDeg;
  r.specs.forEach((sp) => {
    const rr = ringRadius(sp.index);
    const a = radDeg(theta);
    ctx.strokeStyle = specColor(sp.index);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + (rr - ringW / 2 - 2) * Math.cos(a), cy + (rr - ringW / 2 - 2) * Math.sin(a));
    ctx.lineTo(cx + (rr + ringW / 2 + 2) * Math.cos(a), cy + (rr + ringW / 2 + 2) * Math.sin(a));
    ctx.stroke();
  });

  // 共用角度接缝位置线（贯穿）
  const a0 = radDeg(theta);
  ctx.strokeStyle = r.noCommonSolution ? '#b45309' : '#2563eb';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(
    cx + (ringRadius(n - 1) - ringW / 2 - 8) * Math.cos(a0),
    cy + (ringRadius(n - 1) - ringW / 2 - 8) * Math.sin(a0)
  );
  ctx.lineTo(cx + (R + 26) * Math.cos(a0), cy + (R + 26) * Math.sin(a0));
  ctx.stroke();

  // 拖动时未吸附的原始位置（虚线）
  if (
    state.dragging &&
    state.rawDeg !== null &&
    Math.abs(mod(state.rawDeg - theta + 180, 360) - 180) > 0.5
  ) {
    const ar = radDeg(state.rawDeg);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + (R - 60) * Math.cos(ar), cy + (R - 60) * Math.sin(ar));
    ctx.lineTo(cx + (R + 26) * Math.cos(ar), cy + (R + 26) * Math.sin(ar));
    ctx.stroke();
    ctx.restore();
  }

  // 默认共用角度标记
  if (r.best) drawAngleMarker(cx, cy, R + 10, r.best.deg, '#065f46');

  // 中心文字
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (r.noCommonSolution) {
    ctx.fillStyle = '#b45309';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('无共同解', cx, cy - 12);
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#6b7280';
    ctx.fillText(
      r.culprit ? `交集在规格 ${r.culprit.index + 1} 首次归零` : '可行角度交集为空',
      cx,
      cy + 14
    );
  } else {
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(`${fmtDeg(theta)}°`, cx, cy - (n - 1) * 6.5 - 12);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#6b7280';
    const lines = r.specs.map(
      (sp) => `规格${sp.index + 1}：${fmtMm((theta / 360) * sp.circumference)} mm`
    );
    lines.forEach((line, i) => {
      ctx.fillText(line, cx, cy + 12 + i * 13);
    });
  }

  // 图例：共用可行 / 冲突 + 各规格禁用
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const legend = [];
  if (r.noCommonSolution) legend.push(['#b45309', '冲突区间']);
  else legend.push(['#1e9e50', '共用可行段']);
  r.specs.forEach((sp) => {
    legend.push([
      specColor(sp.index),
      `规格${sp.index + 1}禁用${
        r.culprit && r.culprit.index === sp.index ? '（交集归零）' : ''
      }`,
    ]);
  });
  let lx = 12;
  let ly = size - 16;
  for (const [color, label] of legend) {
    const w = 12 + ctx.measureText(label).width + 14;
    if (lx + w > size - 8) {
      lx = 12;
      ly -= 16;
    }
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly - 6, 10, 10);
    ctx.fillStyle = '#374151';
    ctx.fillText(label, lx + 14, ly);
    lx += w;
  }

  $('currentPos').textContent = r.noCommonSolution
    ? '当前无所有规格共用的安全角度'
    : `当前共用角度：${fmtDeg(theta)}°（各规格对应毫米值见图内）`;
  markActiveCommon();
}

/* ---------------- 拖动 ---------------- */

function pointerDeg(ev) {
  const rect = canvas.getBoundingClientRect();
  const { cx, cy, size } = geom();
  const scale = size / rect.width;
  const x = (ev.clientX - rect.left) * scale - cx;
  const y = (ev.clientY - rect.top) * scale - cy;
  // 0° 在正上方，顺时针为正
  return mod((Math.atan2(x, -y) / TAU) * 360, 360);
}

function pointerMm(ev) {
  const C = state.result.circumference;
  return (pointerDeg(ev) / 360) * C;
}

canvas.addEventListener('pointerdown', (ev) => {
  if (state.mode === 'multi') {
    if (!state.multiResult) return;
    state.dragging = true;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(ev.pointerId);
    state.rawDeg = pointerDeg(ev);
    const snapped = snapToCommonFeasible(state.rawDeg);
    if (snapped !== null) state.thetaDeg = snapped;
    draw();
    return;
  }
  if (!state.result) return;
  state.dragging = true;
  canvas.classList.add('dragging');
  canvas.setPointerCapture(ev.pointerId);
  state.rawMm = pointerMm(ev);
  const snapped = snapToFeasible(state.rawMm);
  if (snapped !== null) state.thetaMm = snapped;
  draw();
});
canvas.addEventListener('pointermove', (ev) => {
  if (!state.dragging) return;
  if (state.mode === 'multi') {
    state.rawDeg = pointerDeg(ev);
    const snapped = snapToCommonFeasible(state.rawDeg);
    if (snapped !== null) state.thetaDeg = snapped;
    draw();
    return;
  }
  state.rawMm = pointerMm(ev);
  const snapped = snapToFeasible(state.rawMm);
  if (snapped !== null) state.thetaMm = snapped;
  draw();
});
function endDrag() {
  state.dragging = false;
  state.rawMm = null;
  canvas.classList.remove('dragging');
  draw();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

/* ---------------- 方案快照 ---------------- */

const fmtTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  );
}

function snapshotMsg(text, type) {
  const el = $('snapshotMsg');
  el.textContent = text;
  el.className = 'snapshot-msg ' + (type || 'err');
  el.hidden = !text;
  if (text && type === 'ok') {
    clearTimeout(snapshotMsg._t);
    snapshotMsg._t = setTimeout(() => {
      el.hidden = true;
    }, 2500);
  }
}

function snapshotMetaText(s) {
  const i = s.input;
  const zones = `${i.zones.length} 个保护区`;
  const noSol = s.result && s.result.noSolution ? ' · 无解' : '';
  return `${fmtTime(s.createdAt)} ｜ C=${fmtMm(i.circumference)} W=${fmtMm(i.seamWidth)} mm ｜ ${zones}${noSol}`;
}

function renderSnapshotList() {
  const ul = $('snapshotList');
  const list = SnapshotStore.loadAll().sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
  ul.innerHTML = '';
  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '尚无快照：计算后输入名称并保存';
    ul.appendChild(li);
    updateCompareBtn();
    return;
  }

  for (const s of list) {
    const li = document.createElement('li');
    li.className = 'snapshot-item';
    const idx = state.selected.indexOf(s.id);
    if (idx === 0) li.classList.add('selected', 'sel-a');
    if (idx === 1) li.classList.add('selected', 'sel-b');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = idx >= 0;
    cb.title = '选中用于比较（最多两个）';
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!state.selected.includes(s.id)) {
          if (state.selected.length >= 2) state.selected.shift();
          state.selected.push(s.id);
        }
      } else {
        state.selected = state.selected.filter((x) => x !== s.id);
      }
      renderSnapshotList();
    });

    const badge = document.createElement('span');
    badge.className = 'badge' + (idx === 1 ? ' b' : '');
    badge.textContent = idx === 1 ? 'B' : 'A';

    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = `<div class="name">${escapeHtml(s.name)}</div><div class="meta">${escapeHtml(snapshotMetaText(s))}</div>`;

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'icon-btn';
    loadBtn.title = '载入该快照参数到表单';
    loadBtn.textContent = '载入';
    loadBtn.addEventListener('click', () => loadSnapshot(s.id));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn del';
    delBtn.title = '删除快照';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => deleteSnapshot(s.id));

    li.append(cb, badge, info, loadBtn, delBtn);
    ul.appendChild(li);
  }
  updateCompareBtn();
}

function updateCompareBtn() {
  $('compareSnapshots').disabled = state.selected.length !== 2;
}

function saveSnapshot() {
  if (!state.result || !state.lastInput) {
    return snapshotMsg('请先完成一次计算再保存');
  }
  const { ok, error } = SnapshotStore.createSnapshot(
    $('snapshotName').value,
    state.lastInput,
    state.result
  );
  if (!ok) return snapshotMsg(error);
  $('snapshotName').value = '';
  snapshotMsg('快照已保存到本地', 'ok');
  renderSnapshotList();
}

function loadSnapshot(id) {
  const s = SnapshotStore.getById(id);
  if (!s) return;
  setMode('single');
  $('circumference').value = s.input.circumference;
  $('seamWidth').value = s.input.seamWidth;
  $('zones').innerHTML = '';
  for (const z of s.input.zones) addZoneRow(z.start, z.end);
  compute();
}

function deleteSnapshot(id) {
  const s = SnapshotStore.getById(id);
  if (!s) return;
  if (!window.confirm(`确定删除快照「${s.name}」？`)) return;
  SnapshotStore.remove(id);
  state.selected = state.selected.filter((x) => x !== id);
  if (
    state.currentDiff &&
    (state.currentDiff.a.id === id || state.currentDiff.b.id === id)
  ) {
    exitDiffMode();
  }
  renderSnapshotList();
}

/* ---------------- 快照差异 ---------------- */

function compareSelected() {
  if (state.selected.length !== 2) return;
  const a = SnapshotStore.getById(state.selected[0]);
  const b = SnapshotStore.getById(state.selected[1]);
  if (!a || !b) return snapshotMsg('快照不存在，可能已被删除');
  state.currentDiff = SnapshotDiff.diffSnapshots(a, b);
  $('livePreviewWrap').hidden = true;
  $('diffView').hidden = false;
  $('diffListPanel').hidden = false;
  renderDiffMeta();
  drawDiff();
  renderDiffSummary();
  renderDiffLists();
}

function exitDiffMode() {
  state.currentDiff = null;
  const dv = $('diffView');
  if (dv) dv.hidden = true;
  const lp = $('diffListPanel');
  if (lp) lp.hidden = true;
  const live = $('livePreviewWrap');
  if (live) live.hidden = false;
}

function renderDiffMeta() {
  const d = state.currentDiff;
  const line = (m, cls) =>
    `<span class="${cls}">${m.tag}</span> ${escapeHtml(m.name)}` +
    ` ｜ ${fmtTime(m.createdAt)} ｜ C=${fmtMm(m.circumference)} W=${fmtMm(m.seamWidth)} mm` +
    ` ｜ ${m.zoneCount} 个保护区${m.noSolution ? ' ｜ 无解' : ''}`;
  $('diffMeta').innerHTML = `${line(d.a, 'tag-a')}<br>${line(d.b, 'tag-b')}`;
}

function countDiff(set) {
  return { added: set.added.length, removed: set.removed.length, moves: set.moves.length };
}

function renderDiffSummary() {
  const keys = ['zones', 'forbidden', 'feasible'];
  const totals = { added: 0, removed: 0, moves: 0 };
  for (const k of keys) {
    const cnt = countDiff(state.currentDiff[k]);
    totals.added += cnt.added;
    totals.removed += cnt.removed;
    totals.moves += cnt.moves;
  }
  $('diffSummary').innerHTML =
    `<span class="pill add">新增 ${totals.added}</span>` +
    `<span class="pill remove">移除 ${totals.removed}</span>` +
    `<span class="pill move">边界移动 ${totals.moves}</span>`;
}

function fullCircle([a, b]) {
  return a <= 1e-6 && b >= 360 - 1e-6;
}
function intervalText(seg) {
  if (fullCircle(seg)) return '0.0° → 360.0°（整圈）';
  return `${fmtDeg(seg[0])}° → ${fmtDeg(seg[1])}°（宽 ${fmtDeg(seg[1] - seg[0])}°）`;
}
function mmText(seg, meta) {
  const a = (seg[0] / 360) * meta.circumference;
  const b = (seg[1] / 360) * meta.circumference;
  return `≈ ${fmtMm(a)} → ${fmtMm(b)} mm（${meta.tag}：C=${fmtMm(meta.circumference)}）`;
}
function signedText(delta) {
  if (delta === null) return '不变';
  const dir = delta > 0 ? '顺时针' : '逆时针';
  return `${delta > 0 ? '+' : ''}${fmtDeg(delta)}°（${dir}）`;
}

function renderDiffLists() {
  const d = state.currentDiff;
  const layers = [
    { key: 'zones', title: '保护区' },
    { key: 'forbidden', title: '合并禁用段' },
    { key: 'feasible', title: '可行段' },
  ];
  const host = $('diffLists');
  host.innerHTML = '';

  let anyDiff = false;
  for (const layer of layers) {
    const set = d[layer.key];
    const block = document.createElement('div');
    block.className = 'diff-block';
    let html = `<h3>${layer.title}</h3><ul>`;
    if (set.added.length === 0 && set.removed.length === 0 && set.moves.length === 0) {
      html += '</ul><div class="none">无差异</div>';
    } else {
      anyDiff = true;
      for (const seg of set.added) {
        html += `<li class="add">新增：${intervalText(seg)}<div class="sub">${mmText(seg, d.b)}</div></li>`;
      }
      for (const seg of set.removed) {
        html += `<li class="remove">移除：${intervalText(seg)}<div class="sub">${mmText(seg, d.a)}</div></li>`;
      }
      for (const m of set.moves) {
        html +=
          `<li class="move">边界移动：${fmtDeg(m.aSeg[0])}°→${fmtDeg(m.aSeg[1])}°` +
          ` 变为 ${fmtDeg(m.bSeg[0])}°→${fmtDeg(m.bSeg[1])}°` +
          `<div class="sub">起点 ${signedText(m.startDelta)} ｜ 终点 ${signedText(m.endDelta)}</div></li>`;
      }
      html += '</ul>';
    }
    block.innerHTML = html;
    host.appendChild(block);
  }
  if (!anyDiff) {
    const note = document.createElement('p');
    note.className = 'none';
    note.textContent = '两个快照的保护区、禁用段与可行段完全一致。';
    host.prepend(note);
  }
}

/* ---------------- 差异 Canvas ---------------- */

const diffCanvas = $('diffCanvas');
const diffCtx = diffCanvas.getContext('2d');

function diffGeom() {
  const dpr = window.devicePixelRatio || 1;
  const size = 520;
  if (diffCanvas.width !== size * dpr) {
    diffCanvas.width = size * dpr;
    diffCanvas.height = size * dpr;
  }
  diffCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { cx: size / 2, cy: size / 2, size };
}
function drawDegArc(c, cy2, r, a0, a1) {
  diffCtx.beginPath();
  diffCtx.arc(c, cy2, r, radDeg(a0), radDeg(a1), false);
  diffCtx.stroke();
}
function drawDiffDegRing(cx, cy, r, segs, color, width) {
  diffCtx.strokeStyle = color;
  diffCtx.lineWidth = width;
  diffCtx.lineCap = 'butt';
  for (const [a, b] of segs) {
    if (fullCircle([a, b])) {
      diffCtx.beginPath();
      diffCtx.arc(cx, cy, r, 0, TAU);
      diffCtx.stroke();
    } else if (b - a > 1e-6) {
      drawDegArc(cx, cy, r, a, b);
    }
  }
}

/** 在环上绘制边界移动弧线与箭头：fromDeg → toDeg（带符号最短圆弧）。 */
function drawMoveArc(cx, cy, r, fromDeg, toDeg, width) {
  let delta = ((toDeg - fromDeg) % 360 + 360) % 360;
  if (delta > 180) delta -= 360;
  if (Math.abs(delta) < 1e-6) return;
  const ccw = delta < 0;
  diffCtx.save();
  diffCtx.globalAlpha = 0.9;
  diffCtx.strokeStyle = '#7c3aed';
  diffCtx.lineWidth = width;
  diffCtx.lineCap = 'round';
  diffCtx.beginPath();
  diffCtx.arc(cx, cy, r, radDeg(fromDeg), radDeg(toDeg), ccw);
  diffCtx.stroke();
  diffCtx.restore();

  // A 端空心点
  const ar = r + width / 2 + 9;
  const aa = radDeg(fromDeg);
  diffCtx.beginPath();
  diffCtx.arc(cx + ar * Math.cos(aa), cy + ar * Math.sin(aa), 3, 0, TAU);
  diffCtx.fillStyle = '#fff';
  diffCtx.fill();
  diffCtx.strokeStyle = '#7c3aed';
  diffCtx.lineWidth = 1.5;
  diffCtx.stroke();

  // B 端箭头（沿圆周切向）
  const ab = radDeg(toDeg);
  const sign = delta > 0 ? 1 : -1;
  const ux = Math.cos(ab);
  const uy = Math.sin(ab);
  const tx = -Math.sin(ab) * sign;
  const ty = Math.cos(ab) * sign;
  const bx = cx + ar * ux;
  const by = cy + ar * uy;
  diffCtx.beginPath();
  diffCtx.moveTo(bx + tx * 7, by + ty * 7);
  diffCtx.lineTo(bx - tx * 5 + ux * 4.5, by - ty * 5 + uy * 4.5);
  diffCtx.lineTo(bx - tx * 5 - ux * 4.5, by - ty * 5 - uy * 4.5);
  diffCtx.closePath();
  diffCtx.fillStyle = '#7c3aed';
  diffCtx.fill();
}

function drawDiffMoves(cx, cy, r, moves, width) {
  for (const m of moves) {
    if (m.startDelta !== null) drawMoveArc(cx, cy, r, m.aSeg[0], m.bSeg[0], width);
    if (m.endDelta !== null) drawMoveArc(cx, cy, r, m.aSeg[1], m.bSeg[1], width);
  }
}

function drawDiff() {
  const d = state.currentDiff;
  if (!d) return;
  const { cx, cy, size } = diffGeom();
  const c = diffCtx;
  c.clearRect(0, 0, size, size);

  // 刻度（每 30°）
  c.strokeStyle = '#d1d5db';
  c.fillStyle = '#9ca3af';
  c.lineWidth = 1;
  c.font = '11px sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (let deg = 0; deg < 360; deg += 30) {
    const a = radDeg(deg);
    c.beginPath();
    c.moveTo(cx + 184 * Math.cos(a), cy + 184 * Math.sin(a));
    c.lineTo(cx + 192 * Math.cos(a), cy + 192 * Math.sin(a));
    c.stroke();
    c.fillText(`${deg}°`, cx + 206 * Math.cos(a), cy + 206 * Math.sin(a));
  }

  const rings = [
    { key: 'feasible', r: 170, w: 16 },
    { key: 'forbidden', r: 140, w: 12 },
    { key: 'zones', r: 110, w: 12 },
  ];
  for (const ring of rings) {
    const set = d[ring.key];
    drawDiffDegRing(cx, cy, ring.r, [[0, 360]], '#e5e7eb', ring.w);
    drawDiffDegRing(cx, cy, ring.r, set.common, '#9ca3af', ring.w);
    drawDiffDegRing(cx, cy, ring.r, set.removed, '#dc2626', ring.w);
    drawDiffDegRing(cx, cy, ring.r, set.added, '#16a34a', ring.w);
    drawDiffMoves(cx, cy, ring.r, set.moves, ring.w);
  }

  // 环位说明（左上）
  c.font = '12px sans-serif';
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  const layerLabels = [
    ['#6b7280', '外圈：可行段'],
    ['#6b7280', '中圈：合并禁用段'],
    ['#6b7280', '内圈：保护区'],
  ];
  layerLabels.forEach(([color, label], i) => {
    const y = 18 + i * 18;
    c.fillStyle = color;
    c.fillRect(16, y - 6, 10, 10);
    c.fillStyle = '#374151';
    c.fillText(label, 32, y);
  });

  // 中心文字
  c.fillStyle = '#1f2937';
  c.font = 'bold 18px sans-serif';
  c.textAlign = 'center';
  c.fillText('快照差异', cx, cy - 22);
  c.font = '12px sans-serif';
  c.fillStyle = '#2563eb';
  c.fillText(`A：${truncate(d.a.name, 14)}`, cx, cy);
  c.fillStyle = '#7c3aed';
  c.fillText(`B：${truncate(d.b.name, 14)}`, cx, cy + 18);
  c.fillStyle = '#6b7280';
  c.fillText('按圆周角度比较', cx, cy + 38);

  // 图例（底部）
  const legend = [
    ['#16a34a', '新增（B 有 A 无）'],
    ['#dc2626', '移除（A 有 B 无）'],
    ['#7c3aed', '边界移动'],
    ['#9ca3af', '共有'],
  ];
  c.font = '11px sans-serif';
  c.textAlign = 'left';
  let lx = 12;
  const ly = size - 14;
  for (const [color, label] of legend) {
    c.fillStyle = color;
    c.fillRect(lx, ly - 6, 10, 10);
    c.fillStyle = '#374151';
    c.fillText(label, lx + 14, ly);
    lx += 14 + c.measureText(label).width + 12;
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ---------------- 初始化 ---------------- */

$('addZone').addEventListener('click', () => {
  addZoneRow();
  scheduleCompute();
});
$('addCirc').addEventListener('click', () => {
  if (document.querySelectorAll('.circ-row').length >= MAX_CIRC) return;
  addCircRow();
  scheduleCompute();
});
$('compute').addEventListener('click', compute);
$('circumference').addEventListener('input', scheduleCompute);
$('seamWidth').addEventListener('input', scheduleCompute);

function loadSingleExample() {
  setMode('single');
  $('circumference').value = 400;
  $('seamWidth').value = 20;
  $('zones').innerHTML = '';
  addZoneRow(60, 120);
  addZoneRow(200, 260);
  addZoneRow(350, 30); // 跨零点保护区
  compute();
}

function loadMultiExample() {
  setMode('multi');
  $('seamWidth').value = 20;
  $('zones').innerHTML = '';
  addZoneRow(60, 120);
  addZoneRow(200, 260);
  addZoneRow(350, 30); // 跨零点保护区（毫米坐标对各规格一致）
  $('circRows').innerHTML = '';
  addCircRow(400);
  addCircRow(360);
  addCircRow(440);
  compute();
}

$('loadExample').addEventListener('click', () => {
  if (state.mode === 'multi') loadMultiExample();
  else loadSingleExample();
});
window.addEventListener('resize', () => {
  draw();
  drawDiff();
});

// 快照相关
$('saveSnapshot').addEventListener('click', saveSnapshot);
$('snapshotName').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') saveSnapshot();
});
$('compareSnapshots').addEventListener('click', compareSelected);
$('exitDiff').addEventListener('click', () => {
  exitDiffMode();
  draw();
});
renderSnapshotList();

// 多规格模式预置 2 个周长（切过去即可直接计算，不影响单规格输入）
addCircRow(400);
addCircRow(360);

// 默认载入单规格示例并计算
loadSingleExample();
