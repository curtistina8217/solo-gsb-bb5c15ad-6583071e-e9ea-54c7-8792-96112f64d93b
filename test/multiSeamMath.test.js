'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeDegIntervals,
  forbiddenDegOf,
  feasibleDegOf,
  intersectDegSets,
  overlapPairs,
  computeSeamAvoidance,
  computeMultiSeamAvoidance,
} = require('../src/seamMath');

function approxPair(actual, expected, eps = 1e-6) {
  assert.ok(Array.isArray(actual), `期望数组，实际 ${JSON.stringify(actual)}`);
  assert.equal(actual.length, expected.length);
  actual.forEach((p, i) => {
    assert.ok(Math.abs(p[0] - expected[i][0]) <= eps, `第 ${i} 段起点 ${p[0]} ≈ ${expected[i][0]}`);
    assert.ok(Math.abs(p[1] - expected[i][1]) <= eps, `第 ${i} 段终点 ${p[1]} ≈ ${expected[i][1]}`);
  });
}

test('mergeDegIntervals: 合并重叠并裁剪到 [0,360]', () => {
  approxPair(
    mergeDegIntervals([
      [10, 50],
      [40, 80],
      [350, 370],
    ]),
    [
      [10, 80],
      [350, 360],
    ]
  );
});

test('forbiddenDegOf / feasibleDegOf: 普通、整圈与无解', () => {
  const r = computeSeamAvoidance(360, 0, [
    { start: 90, end: 180 },
    { start: 270, end: 360 },
  ]);
  approxPair(forbiddenDegOf(r), [
    [90, 180],
    [270, 360],
  ]);
  approxPair(feasibleDegOf(r), [
    [0, 90],
    [180, 270],
  ]);

  // W=200、保护区半圈 → 禁用恰好覆盖整圈，单规格无解
  const full = computeSeamAvoidance(360, 200, [{ start: 0, end: 180 }]);
  assert.equal(full.noSolution, true);
  approxPair(forbiddenDegOf(full), [[0, 360]]);
  assert.deepEqual(feasibleDegOf(full), []);

  const free = computeSeamAvoidance(400, 10, []);
  approxPair(feasibleDegOf(free), [[0, 360]]);
});

test('feasibleDegOf: 跨零点可行段拆到 [0,360]，边界两侧不粘连', () => {
  // C=400, W=20，保护区 [60,120]、[200,260] → 跨零可行段 [260,440]mm = 234°→396°
  const r = computeSeamAvoidance(400, 20, [
    { start: 60, end: 120 },
    { start: 200, end: 260 },
  ]);
  approxPair(feasibleDegOf(r), [
    [0, 36],
    [108, 162],
    [234, 360],
  ]);
});

test('intersectDegSets: 普通区间圆周交集', () => {
  const A = [
    [0, 100],
    [200, 360],
  ];
  const B = [
    [50, 250],
    [300, 360],
  ];
  approxPair(intersectDegSets(A, B), [
    [50, 100],
    [200, 250],
    [300, 360],
  ]);
});

test('intersectDegSets: 整圈集合为恒等元', () => {
  const A = [
    [10, 20],
    [100, 200],
  ];
  approxPair(intersectDegSets(A, [[0, 360]]), A);
  approxPair(intersectDegSets([[0, 360]], A), A);
  assert.deepEqual(intersectDegSets(A, [[0, 5]]), []);
});

test('overlapPairs: 给出可行段与禁用段的逐对重叠', () => {
  const feasible = [
    [120, 130],
    [240, 250],
  ];
  const forbidden = [
    [0, 118],
    [117, 216],
    [225, 324],
  ];
  const pairs = overlapPairs(feasible, forbidden);
  assert.equal(pairs.length, 2);
  approxPair([pairs[0].overlap], [[120, 130]]);
  approxPair([pairs[1].overlap], [[240, 250]]);
});

test('computeMultiSeamAvoidance: 不同周长下的圆周交集与共用段', () => {
  // C=400 禁用 [36,120]∪[162,260]；C=360 禁用 [40,120]∪[180,260]
  const r = computeMultiSeamAvoidance(
    [400, 360],
    20,
    [
      { start: 60, end: 120 },
      { start: 200, end: 260 },
    ]
  );
  assert.equal(r.noCommonSolution, false);
  assert.equal(r.culprit, null);
  approxPair(r.unionForbiddenDeg, [
    [36, 120],
    [162, 260],
  ]);
  // 共用段：[120,162] 与跨零 [260,36]
  assert.equal(r.commonSegments.length, 2);
  const [s1, s2] = r.commonSegments;
  assert.ok(Math.abs(s1.startDeg - 120) <= 1e-6 && Math.abs(s1.endDeg - 162) <= 1e-6);
  assert.equal(s1.wraps, false);
  assert.ok(Math.abs(s2.startDeg - 260) <= 1e-6 && Math.abs(s2.endDeg - 36) <= 1e-6);
  assert.equal(s2.wraps, true);
  assert.ok(Math.abs(s2.widthDeg - 136) <= 1e-6);
});

test('computeMultiSeamAvoidance: 默认角度最大化各规格最小间隙，平局取较小角度', () => {
  const r = computeMultiSeamAvoidance(
    [400, 360],
    20,
    [
      { start: 60, end: 120 },
      { start: 200, end: 260 },
    ]
  );
  // 最宽共用段 [260,36]（跨零，宽 136°），中点 328°
  assert.ok(Math.abs(r.best.deg - 328) <= 1e-6);
  // 该点到最近禁用边界（260 或 36）均为 68°
  assert.ok(Math.abs(r.best.minClearanceDeg - 68) <= 1e-6);
  assert.equal(r.best.perSpec.length, 2);
  // 各规格毫米位置 = 角度/360 × 周长
  assert.ok(Math.abs(r.best.perSpec[0].mm - (328 / 360) * 400) <= 1e-6);
  assert.ok(Math.abs(r.best.perSpec[1].mm - 328) <= 1e-6);
  assert.ok(Math.abs(r.best.perSpec[1].minClearanceMm - 68) <= 1e-6);
  assert.ok(Math.abs(r.best.perSpec[0].minClearanceMm - (68 / 360) * 400) <= 1e-6);
});

test('computeMultiSeamAvoidance: 等宽共用段并列取较小角度（与单规格同规则）', () => {
  // C=360 两个相同规格：禁用 [90,180]∪[270,360] → 等宽可行 [0,90]、[180,270]
  // 与单规格一致：非跨零段中点 45 小于跨零段中点 225(→45°模长 225)
  const single = computeSeamAvoidance(360, 0, [
    { start: 90, end: 180 },
    { start: 270, end: 360 },
  ]);
  const r = computeMultiSeamAvoidance(
    [360, 360],
    0,
    [
      { start: 90, end: 180 },
      { start: 270, end: 360 },
    ]
  );
  assert.equal(r.commonSegments.length, 2);
  assert.ok(Math.abs(r.best.deg - single.best.deg) <= 1e-6);
  assert.ok(Math.abs(r.best.deg - 45) <= 1e-6);
});

test('computeMultiSeamAvoidance: 跨零段参与平局时取较小模角度', () => {
  // C=400 两个相同规格，禁用 mm [0,100]∪[200,300] → 可行段中点 150mm=135° 与 350mm=315°，取 135°
  const single = computeSeamAvoidance(400, 0, [
    { start: 0, end: 100 },
    { start: 200, end: 300 },
  ]);
  const r = computeMultiSeamAvoidance(
    [400, 400],
    0,
    [
      { start: 0, end: 100 },
      { start: 200, end: 300 },
    ]
  );
  assert.ok(Math.abs(r.best.deg - single.best.deg) <= 1e-6);
  assert.ok(Math.abs(r.best.deg - 135) <= 1e-6);
});

test('computeMultiSeamAvoidance: 无保护区时整圈共用，默认 0°', () => {
  const r = computeMultiSeamAvoidance([400, 360, 440], 20, []);
  assert.equal(r.noCommonSolution, false);
  assert.equal(r.commonSegments.length, 1);
  assert.equal(r.commonSegments[0].full, true);
  assert.equal(r.best.deg, 0);
});

test('computeMultiSeamAvoidance: 非整圈禁用时交集首次归零，给出规格与冲突区间', () => {
  // spec1(C=360) 可行 [120,130]∪[240,250]；spec2(C=400) 可行 [108,117]∪[216,225]，互不相交
  const r = computeMultiSeamAvoidance(
    [360, 400],
    0,
    [
      { start: 0, end: 120 },
      { start: 130, end: 240 },
      { start: 250, end: 360 },
    ]
  );
  assert.equal(r.noCommonSolution, true);
  assert.equal(r.best, null);
  assert.equal(r.culprit.index, 1);
  assert.equal(r.culprit.circumference, 400);
  assert.equal(r.culprit.conflictPairs.length, 2);
  approxPair([r.culprit.conflictPairs[0].feasible], [[120, 130]]);
  approxPair([r.culprit.conflictPairs[0].forbidden], [[117, 216]]);
  approxPair([r.culprit.conflictPairs[0].overlap], [[120, 130]]);
  approxPair([r.culprit.conflictPairs[1].overlap], [[240, 250]]);
  // 归零步骤的剩余角度宽度为 0；前一步为 20°
  assert.ok(Math.abs(r.steps[0].remainingWidthDeg - 20) <= 1e-6);
  assert.equal(r.steps[1].remainingWidthDeg, 0);
});

test('computeMultiSeamAvoidance: 单规格自身无解（禁用整圈）时成为归零规格', () => {
  // C=400 留有 10mm 可行（[340,350]mm）；C=360 禁用恰好覆盖整圈
  const r = computeMultiSeamAvoidance(
    [400, 360],
    50,
    [
      { start: 0, end: 140 },
      { start: 170, end: 340 },
    ]
  );
  assert.equal(r.noCommonSolution, true);
  assert.equal(r.culprit.index, 1);
  assert.equal(r.culprit.circumference, 360);
  assert.equal(r.culprit.conflictPairs.length, 1);
  approxPair([r.culprit.conflictPairs[0].feasible], [[306, 315]]);
  approxPair([r.culprit.conflictPairs[0].overlap], [[306, 315]]);
  approxPair([r.culprit.conflictPairs[0].forbidden], [[0, 360]]);
});

test('computeMultiSeamAvoidance: 首个规格即无解时记录规格 1', () => {
  // C=360、W=200、保护区 [0,180] → 禁用 [−200,180] 覆盖整圈；
  // C=400 下仅禁用 [0,342°]，尚余 18° 可行
  const r = computeMultiSeamAvoidance(
    [360, 400],
    200,
    [{ start: 0, end: 180 }]
  );
  assert.equal(r.specs[0].noSolution, true);
  assert.equal(r.specs[1].noSolution, false);
  assert.equal(r.noCommonSolution, true);
  assert.equal(r.culprit.index, 0);
  assert.equal(r.commonSegments.length, 0);
});

test('computeMultiSeamAvoidance: 三规格交集逐次收窄', () => {
  const r = computeMultiSeamAvoidance(
    [400, 360, 440],
    20,
    [
      { start: 60, end: 120 },
      { start: 200, end: 260 },
    ]
  );
  assert.equal(r.noCommonSolution, false);
  assert.equal(r.specs.length, 3);
  assert.ok(r.steps.every((s) => s.remainingWidthDeg > 0));
  // C=440 禁用 [32.7°,108] 与 [147.3°,212.7°]，使 [120,162] 收窄为 [120,147.3°]
  const narrow = r.commonSegments.find((s) => !s.wraps);
  assert.ok(Math.abs(narrow.startDeg - 120) <= 1e-6);
  assert.ok(Math.abs(narrow.endDeg - 1620 / 11) <= 1e-6);
  assert.ok(Math.abs(r.best.deg - 326.36363636) <= 1e-5);
});
