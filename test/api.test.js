'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.PORT = '0';
const { app } = require('../server');

function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: addr.port,
        path,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null });
          } catch (e) {
            resolve({ status: res.statusCode, text: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test.before(async () => {
  await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', resolve);
    globalThis.__testServer = server;
  });
});

test.after(() => {
  globalThis.__testServer.close();
});

test('GET /api/health', async () => {
  const res = await request(globalThis.__testServer, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
});

test('POST /api/compute 保持原有单规格行为', async () => {
  const res = await request(globalThis.__testServer, 'POST', '/api/compute', {
    circumference: 400,
    seamWidth: 20,
    zones: [
      { start: 60, end: 120 },
      { start: 200, end: 260 },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.best.mm, 350);
  assert.equal(res.json.noSolution, false);
});

test('POST /api/compute-multi 返回共用角度结果', async () => {
  const res = await request(globalThis.__testServer, 'POST', '/api/compute-multi', {
    circumferences: [400, 360],
    seamWidth: 20,
    zones: [
      { start: 60, end: 120 },
      { start: 200, end: 260 },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.mode, 'multi');
  assert.equal(res.json.specs.length, 2);
  assert.equal(res.json.noCommonSolution, false);
  assert.ok(Math.abs(res.json.best.deg - 328) <= 1e-6);
  assert.ok(res.json.commonSegments.length >= 1);
});

test('POST /api/compute-multi 无共同解时给出 culprit 与冲突区间', async () => {
  const res = await request(globalThis.__testServer, 'POST', '/api/compute-multi', {
    circumferences: [360, 400],
    seamWidth: 0,
    zones: [
      { start: 0, end: 120 },
      { start: 130, end: 240 },
      { start: 250, end: 360 },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.noCommonSolution, true);
  assert.equal(res.json.culprit.index, 1);
  assert.equal(res.json.culprit.circumference, 400);
  assert.ok(res.json.culprit.conflictPairs.length >= 1);
  assert.equal(res.json.best, null);
});

test('POST /api/compute-multi 参数校验', async () => {
  const server = globalThis.__testServer;

  let res = await request(server, 'POST', '/api/compute-multi', {
    circumferences: [400],
    seamWidth: 20,
    zones: [],
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /2～8/);

  res = await request(server, 'POST', '/api/compute-multi', {
    circumferences: new Array(9).fill(400),
    seamWidth: 20,
    zones: [],
  });
  assert.equal(res.status, 400);

  res = await request(server, 'POST', '/api/compute-multi', {
    circumferences: [400, -1],
    seamWidth: 20,
    zones: [],
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /circumferences\[1\]/);

  res = await request(server, 'POST', '/api/compute-multi', {
    circumferences: [400, 360],
    seamWidth: -5,
    zones: [],
  });
  assert.equal(res.status, 400);

  res = await request(server, 'POST', '/api/compute-multi', {
    circumferences: [400, 360],
    seamWidth: 20,
    zones: [{ start: 'x', end: 10 }],
  });
  assert.equal(res.status, 400);
});

test('POST /api/compute 原有校验不受影响', async () => {
  const res = await request(globalThis.__testServer, 'POST', '/api/compute', {
    circumference: 0,
    seamWidth: 20,
    zones: [],
  });
  assert.equal(res.status, 400);
});
