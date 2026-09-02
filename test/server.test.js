const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-report-server-'));
process.env.ORDER_REPORT_HOST = '127.0.0.1';
process.env.ORDER_REPORT_PORT = '0';
process.env.ORDER_REPORT_RUNTIME_DIR = runtimeDir;
process.env.ORDER_REPORT_SYNC_TOKEN = 'integration-test-token-not-a-secret';

const { handle, stop, store } = require('../server');

function request(method, url, options = {}) {
  const incoming = new PassThrough();
  incoming.method = method;
  incoming.url = url;
  incoming.headers = {
    host: 'localhost',
    ...(options.headers || {}),
  };

  return new Promise((resolve, reject) => {
    const response = {
      destroyed: false,
      headersSent: false,
      statusCode: null,
      headers: null,
      chunks: [],
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
        this.headersSent = true;
      },
      end(chunk) {
        if (chunk) this.chunks.push(Buffer.from(chunk));
        const rawBody = Buffer.concat(this.chunks).toString('utf8');
        let body = rawBody;
        try { body = JSON.parse(rawBody); } catch {}
        resolve({ status: this.statusCode, headers: this.headers, body });
      },
    };
    handle(incoming, response).catch(reject);
    incoming.end(options.body || '');
  });
}

test('HTTP API validates input, keeps idempotent operations, and removes its lock on shutdown', async (t) => {
  t.after(async () => {
    await stop();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  await store.ready;
  const token = process.env.ORDER_REPORT_SYNC_TOKEN;
  const authHeaders = {
    'content-type': 'application/json',
    'x-sync-token': token,
  };

  const health = await request('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const unauthorized = await request('GET', '/api/sync/pull');
  assert.equal(unauthorized.status, 401);

  const invalidJson = await request('POST', '/api/sync/push', {
    headers: authHeaders,
    body: '{',
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.body.code, 'INVALID_JSON');

  const missingOperations = await request('POST', '/api/sync/push', {
    headers: authHeaders,
    body: '{}',
  });
  assert.equal(missingOperations.status, 400);
  assert.equal(missingOperations.body.code, 'INVALID_OPERATIONS');

  const tooManyOperations = await request('POST', '/api/sync/push', {
    headers: authHeaders,
    body: JSON.stringify({ operations: Array.from({ length: 101 }, () => ({})) }),
  });
  assert.equal(tooManyOperations.status, 400);
  assert.equal(tooManyOperations.body.code, 'TOO_MANY_OPERATIONS');

  const malformedOperation = await request('POST', '/api/sync/push', {
    headers: authHeaders,
    body: JSON.stringify({
      operations: [{
        opId: 'op_malformed',
        type: 'report.create',
        payload: {},
        createdAt: '2026-09-02T00:00:00.000Z',
      }],
    }),
  });
  assert.equal(malformedOperation.status, 200);
  assert.equal(malformedOperation.body.version, 0);
  assert.deepEqual(malformedOperation.body.rejected.map((row) => row.opId), ['op_malformed']);
  assert.match(malformedOperation.body.rejected[0].error, /clientId/);

  const initialSnapshot = await request('GET', '/api/sync/pull', { headers: authHeaders });
  const mismatchedServer = await request('POST', '/api/sync/push', {
    headers: authHeaders,
    body: JSON.stringify({
      serverId: 'different-server',
      minimumVersion: 0,
      operations: [],
    }),
  });
  assert.equal(mismatchedServer.status, 409);
  assert.equal(mismatchedServer.body.code, 'SERVER_ID_MISMATCH');

  const regressedServer = await request('POST', '/api/sync/push', {
    headers: authHeaders,
    body: JSON.stringify({
      serverId: initialSnapshot.body.serverId,
      minimumVersion: 1,
      operations: [],
    }),
  });
  assert.equal(regressedServer.status, 409);
  assert.equal(regressedServer.body.code, 'SERVER_VERSION_REGRESSION');

  const operation = {
    opId: 'op_server_integration',
    clientId: 'client_server_integration',
    type: 'report.create',
    createdAt: '2026-09-02T00:00:00.000Z',
    payload: {
      report: {
        id: 'report_server_integration',
        occurredAt: '2026-09-02',
        originalMessage: '测试数据',
      },
      items: [{
        id: 'item_server_integration',
        productName: '测试商品',
        note: '',
        quantity: 1,
        actualPaymentCents: 100,
        expectedRefundCents: 120,
        expectedRebateCents: 5,
      }],
    },
  };
  const push = () => request('POST', '/api/sync/push', {
    headers: authHeaders,
    body: JSON.stringify({
      serverId: initialSnapshot.body.serverId,
      minimumVersion: 0,
      operations: [operation],
    }),
  });
  const first = await push();
  const duplicate = await push();
  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 200);
  assert.equal(first.body.version, 1);
  assert.equal(duplicate.body.version, 1);
  assert.equal(first.body.serverId, duplicate.body.serverId);
  assert.deepEqual(duplicate.body.accepted.map((row) => row.opId), [operation.opId]);

  const oversized = await request('POST', '/api/sync/push', {
    headers: authHeaders,
    body: JSON.stringify({ operations: [], padding: 'x'.repeat(2 * 1024 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, 'PAYLOAD_TOO_LARGE');

  const lockPath = path.join(runtimeDir, 'order-report.sqlite3.lock');
  assert.equal(fs.existsSync(lockPath), true);
  await stop();
  assert.equal(fs.existsSync(lockPath), false);
});
