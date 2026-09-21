'use strict';

/**
 * 圆筒包装接缝避让核心算法。
 *
 * 模型：筒体周长 C (mm) 对应 360°。接缝（含安全余量）占宽度 W (mm)。
 * 印刷保护区以 [start, end] (mm) 给出，沿周向正向延伸，允许跨零点。
 * 旋转量为 θ (mm, 0 <= θ < C)，表示接缝起点落在周向 θ 处，
 * 接缝占据 [θ, θ+W] (mod C)。接缝与任一保护区相交的 θ 即禁用。
 * 因此对保护区段 [a, b]，禁用区间为 [a-W, b] (mod C)。
 */

const EPS = 1e-9;
const FULL_DEG = 360;
const EPS_DEG = 1e-7; // 角度域比较容差

function mod(n, m) {
  return ((n % m) + m) % m;
}

function mmToDeg(mm, C) {
  return (mm / C) * 360;
}

/**
 * 将保护区 [startMm, endMm] 归一化到 [0, C] 上的若干不跨零区间。
 * 语义：从 start 沿正向走到 end（模 C）。start === end 视为零长度（忽略）；
 * 正向长度恰好为 C 的整数倍且端点不同视为整圈。
 * @returns {Array<[number, number]>} 满足 0 <= a <= b <= C 的区间列表
 */
function normalizeZone(startMm, endMm, C) {
  const len = mod(endMm - startMm, C);
  if (len === 0) {
    // 端点不同但正向距离为整圈 → 覆盖整圈；否则零长度，忽略
    return endMm !== startMm ? [[0, C]] : [];
  }
  const a = mod(startMm, C);
  const b = mod(endMm, C);
  if (a <= b) return [[a, b]];
  const pieces = [];
  if (C - a > EPS) pieces.push([a, C]);
  if (b > EPS) pieces.push([0, b]);
  return pieces;
}

/**
 * 由保护区段 [a, b]（已归一化到 [0, C]）生成接缝起点的禁用区间，
 * 即 [a-W, b] (mod C)，结果拆分为 [0, C] 内的不跨零片段。
 */
function forbiddenPieces(a, b, W, C) {
  const s = a - W;
  const e = b;
  if (e - s >= C - EPS) return [[0, C]];
  if (s < 0) {
    const pieces = [[s + C, C]];
    if (e > EPS) pieces.push([0, e]);
    return pieces;
  }
  return [[s, e]];
}

/** 合并 [0, C] 内的线性区间（不跨零合并，跨零由环形空隙处理）。 */
function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(([a, b]) => b - a > EPS)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + EPS) {
      last[1] = Math.max(last[1], b);
    } else {
      merged.push([a, b]);
    }
  }
  return merged;
}

/**
 * 求合并后禁用区间在圆周上的空隙，即可行段。
 * 返回线性化区间，跨零空隙的 end 可能大于 C（如 [370, 410) 表示 370..C 与 0..10）。
 */
function computeGaps(merged, C) {
  if (merged.length === 0) return [[0, C]];
  const gaps = [];
  for (let i = 0; i < merged.length - 1; i++) {
    const s = merged[i][1];
    const e = merged[i + 1][0];
    if (e - s > EPS) gaps.push([s, e]);
  }
  const s = merged[merged.length - 1][1];
  const e = merged[0][0] + C;
  if (e - s > EPS) gaps.push([s, e]);
  return gaps;
}

/**
 * 主入口。
 * @param {number} C 周长 (mm)，> 0
 * @param {number} W 接缝安全宽度 (mm)，>= 0
 * @param {Array<{start: number, end: number}>} zones 印刷保护区 (mm)
 */
function computeSeamAvoidance(C, W, zones) {
  const zonePieces = [];
  const rawForbidden = [];
  for (const z of zones) {
    const pieces = normalizeZone(z.start, z.end, C);
    zonePieces.push(pieces);
    for (const [a, b] of pieces) {
      for (const p of forbiddenPieces(a, b, W, C)) rawForbidden.push(p);
    }
  }

  const merged = mergeIntervals(rawForbidden);
  const gaps = computeGaps(merged, C);
  const noSolution = gaps.length === 0;

  const feasible = gaps.map(([s, e]) => {
    const startMm = mod(s, C);
    const endMm = mod(e, C);
    return {
      startMm,
      endMm,
      startDeg: mmToDeg(startMm, C),
      endDeg: mmToDeg(endMm, C),
      widthMm: e - s,
      widthDeg: mmToDeg(e - s, C),
      wraps: e > C + EPS,
    };
  });

  // 默认选择：段宽最大者的中点；并列取模 C 后角度最小者
  let best = null;
  if (!noSolution) {
    if (merged.length === 0) {
      // 无禁用区间：整圈等距，按“角度最小”取 0
      best = { mm: 0, deg: 0 };
    } else {
      let bestGap = null;
      for (const [s, e] of gaps) {
        const width = e - s;
        const mid = mod((s + e) / 2, C);
        if (
          !bestGap ||
          width > bestGap.width + EPS ||
          (Math.abs(width - bestGap.width) <= EPS && mid < bestGap.mid - EPS)
        ) {
          bestGap = { width, mid };
        }
      }
      best = { mm: bestGap.mid, deg: mmToDeg(bestGap.mid, C) };
    }
  }

  const coveredMm = merged.reduce((acc, [a, b]) => acc + (b - a), 0);

  const toView = ([a, b]) => ({
    startMm: a,
    endMm: b,
    startDeg: mmToDeg(a, C),
    endDeg: mmToDeg(b, C),
  });

  return {
    circumference: C,
    seamWidth: W,
    seamWidthDeg: mmToDeg(W, C),
    zonePieces: zonePieces.map((pieces) => pieces.map(toView)),
    // 每个保护区扩展后的禁用片段（按起点排序、未合并），无解时用于展示覆盖整圈的区间链
    forbiddenChain: rawForbidden
      .slice()
      .sort((x, y) => x[0] - y[0] || x[1] - y[1])
      .map(toView),
    forbiddenMerged: merged.map(toView),
    feasible,
    best,
    noSolution,
    coveragePct: Math.min(100, (coveredMm / C) * 100),
  };
}

/**
 * ============================================================================
 * 多规格共用角度模式
 *
 * 输入 2～8 个周长（沿用同一接缝宽度 W 与同一组毫米制保护区），分别按
 * computeSeamAvoidance 求解，再把各规格的禁用/可行段统一到角度域 [0°,360°]：
 *  - 共同可行段 = 所有规格禁用并集在圆周上的补集（即可行段集合的圆周交集）；
 *  - 默认角度 = 最宽共同可行段的中点：该点即“在各规格下距禁用边界的最小间隙”
 *    的最大化解（间隙以角度计，各规格再换算为毫米），并列取较小角度；
 *  - 无共同解时记录令交集首次归零的规格（culprit）及冲突区间
 *    （归零前共同可行段与该规格禁用段的逐对重叠）。
 * ============================================================================
 */

/** 合并 [0,360] 内的线性角度区间；覆盖整圈时返回 [[0,360]]。 */
function mergeDegIntervals(intervals) {
  const sorted = intervals
    .filter(([a, b]) => b - a > EPS_DEG)
    .map(([a, b]) => [Math.max(0, Math.min(FULL_DEG, a)), Math.max(0, Math.min(FULL_DEG, b))])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + EPS_DEG) {
      last[1] = Math.max(last[1], b);
    } else {
      merged.push([a, b]);
    }
  }
  if (merged.length === 1 && merged[0][0] <= EPS_DEG && merged[0][1] >= FULL_DEG - EPS_DEG) {
    return [[0, FULL_DEG]];
  }
  return merged;
}

/** 判定合并后的角度段集是否覆盖整圈。 */
function isFullCircleDeg(segs) {
  return segs.length === 1 && segs[0][0] <= EPS_DEG && segs[0][1] >= FULL_DEG - EPS_DEG;
}

/**
 * 单规格计算结果 → 角度域禁用段（[0,360] 内不跨零、已合并；整圈为 [[0,360]]）。
 */
function forbiddenDegOf(result) {
  if (result.noSolution) return [[0, FULL_DEG]];
  const segs = result.forbiddenMerged.map((s) => [s.startDeg, s.endDeg]);
  const merged = mergeDegIntervals(segs);
  return isFullCircleDeg(merged) ? [[0, FULL_DEG]] : merged;
}

/**
 * 单规格计算结果 → 角度域可行段（[0,360] 内不跨零片段）。整圈可行返回 [[0,360]]。
 * 跨零可行段以 [0,a]、[b,360] 两个片段表示，不在边界处粘连，
 * 以保留与单规格一致的“段宽/中点/平局”语义。
 */
function feasibleDegOf(result) {
  if (result.noSolution) return [];
  const pieces = [];
  for (const f of result.feasible) {
    if (f.widthDeg >= FULL_DEG - EPS_DEG) return [[0, FULL_DEG]];
    // 以 startDeg + widthDeg 重建线性弧：startDeg 可能为 0（跨零段 mod 后落在起点），
    // 不能用 wraps ? endDeg+360 : endDeg，否则会误判为覆盖到 360。
    const start = mod(f.startDeg, FULL_DEG);
    const end = start + f.widthDeg;
    if (start <= EPS_DEG && end >= FULL_DEG - EPS_DEG) return [[0, FULL_DEG]];
    if (end <= FULL_DEG + EPS_DEG) {
      if (end - start > EPS_DEG) pieces.push([start, Math.min(FULL_DEG, end)]);
    } else {
      pieces.push([start, FULL_DEG]);
      if (end - FULL_DEG > EPS_DEG) pieces.push([0, end - FULL_DEG]);
    }
  }
  // 严格重叠合并（恰相接的片段保持独立），不做跨零粘连
  pieces.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  for (const [a, b] of pieces) {
    const last = merged[merged.length - 1];
    if (last && a < last[1] - EPS_DEG) {
      last[1] = Math.max(last[1], b);
    } else {
      merged.push([a, b]);
    }
  }
  return merged;
}

/**
 * 圆周交集：两族已合并、位于 [0,360] 的线性段集的逐段重叠。
 * 注意：不在 0°/360° 处做“跨零合并”，跨零段由 [0,a] 与 [b,360] 两个片段表示，
 * 以保持与单规格可行段一致的中点/平局语义。
 * @returns {Array<[number, number]>} 不跨零片段；整圈交集为 [[0,360]]，空集为 []
 */
function intersectDegSets(segsA, segsB) {
  if (isFullCircleDeg(segsA)) return segsB.map(([a, b]) => [a, b]);
  if (isFullCircleDeg(segsB)) return segsA.map(([a, b]) => [a, b]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < segsA.length && j < segsB.length) {
    const a = segsA[i];
    const b = segsB[j];
    const lo = Math.max(a[0], b[0]);
    const hi = Math.min(a[1], b[1]);
    if (hi - lo > EPS_DEG) out.push([lo, hi]);
    if (a[1] < b[1] - EPS_DEG) i++;
    else if (b[1] < a[1] - EPS_DEG) j++;
    else {
      i++;
      j++;
    }
  }
  // 仅做严格重叠合并；恰相接（a === last[1]）的片段保持独立，
  // 与 mm 域 mergeIntervals 同语义，避免跨零段被粘成一段
  out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  for (const [a, b] of out) {
    const last = merged[merged.length - 1];
    if (last && a < last[1] - EPS_DEG) {
      last[1] = Math.max(last[1], b);
    } else {
      merged.push([a, b]);
    }
  }
  return merged;
}

/**
 * 冲突逐对明细：可行段集 feasible 与禁用段集 forbidden 的每个非空重叠。
 * @returns {Array<{feasible:[number,number], forbidden:[number,number], overlap:[number,number]}>}
 */
function overlapPairs(feasible, forbidden) {
  const pairs = [];
  for (const f of feasible) {
    for (const g of forbidden) {
      const lo = Math.max(f[0], g[0]);
      const hi = Math.min(f[1], g[1]);
      if (hi - lo > EPS_DEG) {
        pairs.push({ feasible: [f[0], f[1]], forbidden: [g[0], g[1]], overlap: [lo, hi] });
      }
    }
  }
  return pairs;
}

/**
 * 把角度域线性空隙（end 可超过 360 表示跨零）转成 [0,360] 内的展示段。
 */
function gapsToCommonSegments(gaps) {
  const segs = [];
  for (const [s, e] of gaps) {
    const width = e - s;
    const start = mod(s, FULL_DEG);
    if (width >= FULL_DEG - EPS_DEG) {
      segs.push({ startDeg: 0, endDeg: 360, widthDeg: FULL_DEG, wraps: false, full: true });
      continue;
    }
    const end = mod(e, FULL_DEG);
    const wraps = e > FULL_DEG + EPS_DEG;
    segs.push({ startDeg: start, endDeg: end, widthDeg: width, wraps, full: false });
  }
  return segs;
}

/**
 * 多规格共用角度主入口。
 * @param {Array<number>} circumferences 2～8 个周长 (mm)
 * @param {number} W 接缝安全宽度 (mm)，各规格共用
 * @param {Array<{start:number,end:number}>} zones 毫米制印刷保护区，各规格共用
 */
function computeMultiSeamAvoidance(circumferences, W, zones) {
  const specs = circumferences.map((C, index) => {
    const result = computeSeamAvoidance(C, W, zones);
    return {
      index,
      circumference: C,
      seamWidthDeg: mmToDeg(W, C),
      result,
      forbiddenDeg: forbiddenDegOf(result),
      feasibleDeg: feasibleDegOf(result),
    };
  });

  // 按顺序累计交集，定位令交集首次归零的规格
  const steps = [];
  let common = [[0, FULL_DEG]];
  let culprit = null;
  for (const spec of specs) {
    const before = common;
    const after = intersectDegSets(before, spec.feasibleDeg);
    steps.push({
      index: spec.index,
      circumference: spec.circumference,
      remainingWidthDeg: after.reduce((acc, [a, b]) => acc + (b - a), 0),
    });
    common = after;
    if (culprit === null && after.length === 0) {
      culprit = {
        index: spec.index,
        circumference: spec.circumference,
        conflictPairs: overlapPairs(before, spec.forbiddenDeg),
      };
    }
  }

  // 共同可行段 = 全部禁用并集在圆周上的补集；交集为空时并集必覆盖整圈
  const unionForbidden = mergeDegIntervals(specs.flatMap((s) => s.forbiddenDeg));
  const forbiddenCoversAll = isFullCircleDeg(unionForbidden);
  const gaps = forbiddenCoversAll ? [] : computeGaps(unionForbidden, FULL_DEG);
  const commonSegments = gapsToCommonSegments(gaps);
  const noCommonSolution = commonSegments.length === 0;

  // 默认角度：最宽共同可行段中点，并列取较小角度（与单规格同规则）；
  // 该中点到任一边界的角度距离 = 段宽/2，即各规格下最小间隙（角度）的最大化解
  let best = null;
  if (!noCommonSolution) {
    if (unionForbidden.length === 0) {
      best = { deg: 0 };
    } else {
      let bestGap = null;
      for (const [s, e] of gaps) {
        const width = e - s;
        const mid = mod((s + e) / 2, FULL_DEG);
        if (
          !bestGap ||
          width > bestGap.width + EPS_DEG ||
          (Math.abs(width - bestGap.width) <= EPS_DEG && mid < bestGap.mid - EPS_DEG)
        ) {
          bestGap = { width, mid };
        }
      }
      best = { deg: bestGap.mid };
    }
    // 各规格下该角度对应的毫米位置与到禁用边界的最小间隙
    best.perSpec = specs.map((spec) => {
      const C = spec.circumference;
      const mm = (best.deg / FULL_DEG) * C;
      const clearances = spec.forbiddenDeg.map(([a, b]) => {
        const d1 = mod(a - best.deg, FULL_DEG); // 到禁用段起点的正向角距
        const d2 = mod(best.deg - b, FULL_DEG); // 到禁用段终点的反向角距
        return Math.min(d1, d2);
      });
      const minClearDeg = clearances.length ? Math.min(...clearances) : FULL_DEG / 2;
      return {
        index: spec.index,
        circumference: C,
        mm,
        minClearanceDeg: minClearDeg,
        minClearanceMm: (minClearDeg / FULL_DEG) * C,
      };
    });
    best.minClearanceDeg = Math.min(...best.perSpec.map((p) => p.minClearanceDeg));
    best.minClearanceMm = Math.min(...best.perSpec.map((p) => p.minClearanceMm));
  }

  return {
    mode: 'multi',
    seamWidth: W,
    circumferences: circumferences.slice(),
    specs: specs.map((spec) => ({
      index: spec.index,
      circumference: spec.circumference,
      seamWidthDeg: spec.seamWidthDeg,
      noSolution: spec.result.noSolution,
      forbiddenDeg: spec.forbiddenDeg,
      feasibleDeg: spec.feasibleDeg,
      result: spec.result,
    })),
    steps,
    unionForbiddenDeg: unionForbidden,
    commonSegments,
    best,
    noCommonSolution,
    culprit,
  };
}

module.exports = {
  EPS,
  EPS_DEG,
  mod,
  mmToDeg,
  normalizeZone,
  forbiddenPieces,
  mergeIntervals,
  computeGaps,
  computeSeamAvoidance,
  mergeDegIntervals,
  isFullCircleDeg,
  forbiddenDegOf,
  feasibleDegOf,
  intersectDegSets,
  overlapPairs,
  computeMultiSeamAvoidance,
};
