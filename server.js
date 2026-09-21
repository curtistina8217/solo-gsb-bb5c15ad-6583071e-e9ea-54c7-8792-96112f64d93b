'use strict';

const path = require('path');
const express = require('express');
const { computeSeamAvoidance, computeMultiSeamAvoidance } = require('./src/seamMath');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_ZONES = 200;
const MIN_CIRCUMFERENCES = 2;
const MAX_CIRCUMFERENCES = 8;

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));
// 前端直接复用 src 下的 UMD 算法
app.use('/src', express.static(path.join(__dirname, 'src')));

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function validateCommon(body) {
  if (!isFiniteNumber(body.seamWidth) || body.seamWidth < 0) {
    return 'seamWidth 必须为不小于 0 的数值 (mm)';
  }
  if (!Array.isArray(body.zones) || body.zones.length > MAX_ZONES) {
    return `zones 必须为数组，且不超过 ${MAX_ZONES} 个`;
  }
  for (const [i, z] of body.zones.entries()) {
    if (!z || !isFiniteNumber(z.start) || !isFiniteNumber(z.end)) {
      return `zones[${i}] 需要数值类型的 start 与 end (mm)`;
    }
  }
  return null;
}

app.post('/api/compute', (req, res) => {
  const body = req.body || {};
  const { circumference, seamWidth, zones } = body;

  if (!isFiniteNumber(circumference) || circumference <= 0) {
    return res.status(400).json({ error: 'circumference 必须为大于 0 的数值 (mm)' });
  }
  const commonError = validateCommon({ seamWidth, zones });
  if (commonError) return res.status(400).json({ error: commonError });

  const result = computeSeamAvoidance(circumference, seamWidth, zones);
  res.json(result);
});

app.post('/api/compute-multi', (req, res) => {
  const body = req.body || {};
  const { circumferences, seamWidth, zones } = body;

  if (
    !Array.isArray(circumferences) ||
    circumferences.length < MIN_CIRCUMFERENCES ||
    circumferences.length > MAX_CIRCUMFERENCES
  ) {
    return res.status(400).json({
      error: `circumferences 必须为 ${MIN_CIRCUMFERENCES}～${MAX_CIRCUMFERENCES} 个周长的数组 (mm)`,
    });
  }
  for (const [i, c] of circumferences.entries()) {
    if (!isFiniteNumber(c) || c <= 0) {
      return res.status(400).json({ error: `circumferences[${i}] 必须为大于 0 的数值 (mm)` });
    }
  }
  const commonError = validateCommon({ seamWidth, zones });
  if (commonError) return res.status(400).json({ error: commonError });

  const result = computeMultiSeamAvoidance(circumferences, seamWidth, zones);
  res.json(result);
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// 直接运行时监听端口；被测试代码 require 时不自动启动
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`seam-avoidance app listening on http://0.0.0.0:${PORT}`);
  });
}

module.exports = { app };
