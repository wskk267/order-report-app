const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const config = require('./lib/config');
const { DatabaseLockedError, PersistenceError, Store } = require('./lib/store');

const store = new Store(config.dbPath);
const publicRoot = path.join(config.root, 'public');
const sharedRoot = path.join(config.root, 'shared');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
};

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

function authorized(request) {
  const provided = String(request.headers['x-sync-token'] || '').trim();
  if (!provided) return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(config.syncToken);
  return providedBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(providedBytes, expectedBytes);
}

function readBody(request, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        fail(new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      try {
        settled = true;
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        settled = true;
        reject(new HttpError(400, 'INVALID_JSON', '请求体不是有效 JSON'));
      }
    });
    request.on('aborted', () => fail(new HttpError(400, 'REQUEST_ABORTED', '请求体传输中断')));
    request.on('error', fail);
  });
}

function sendError(response, error, headers = {}) {
  if (response.headersSent || response.destroyed) return;
  if (error instanceof HttpError) {
    sendJson(response, error.statusCode, { error: error.message, code: error.code }, headers);
    return;
  }
  if (error instanceof PersistenceError) {
    console.error(`database persistence failed: ${error.message}`);
    sendJson(response, 503, {
      error: error.published
        ? '数据库提交结果暂时无法确认，请保留本地操作并使用相同 opId 重试'
        : '数据库暂时无法保存，请稍后重试',
      code: error.published ? 'PERSISTENCE_OUTCOME_UNKNOWN' : 'PERSISTENCE_UNAVAILABLE',
    }, headers);
    return;
  }
  if (error instanceof DatabaseLockedError) {
    sendJson(response, 503, { error: '数据库正被其他进程使用', code: error.code }, headers);
    return;
  }
  console.error(error);
  sendJson(response, 500, { error: '服务器处理请求失败', code: 'INTERNAL_ERROR' }, headers);
}

function safeStaticPath(root, requestPath) {
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(`${path.resolve(root)}${path.sep}`) ? resolved : null;
}

async function serveStatic(request, response, pathname) {
  let root = publicRoot;
  let relativePath = pathname;
  if (pathname === '/shared/domain.js') {
    root = sharedRoot;
    relativePath = '/domain.js';
  }
  const filePath = safeStaticPath(root, relativePath);
  if (!filePath) return sendJson(response, 404, { error: 'Not found' });
  try {
    const body = await fs.promises.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const headers = corsHeaders();
  if (request.method === 'OPTIONS') {
    response.writeHead(204, headers);
    response.end();
    return;
  }
  if (url.pathname === '/api/health' && request.method === 'GET') {
    sendJson(response, 200, { ok: true, service: 'order-report-app', now: new Date().toISOString() }, headers);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (!authorized(request)) {
      sendJson(response, 401, { error: '未授权，请在 APP 设置同步令牌' }, headers);
      return;
    }
    try {
      if (url.pathname === '/api/sync/pull' && request.method === 'GET') {
        const snapshot = await store.snapshot();
        sendJson(response, 200, snapshot, headers);
        return;
      }
      if (url.pathname === '/api/sync/push' && request.method === 'POST') {
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || !Array.isArray(body.operations)) {
          throw new HttpError(400, 'INVALID_OPERATIONS', 'operations 必须是数组');
        }
        if (body.operations.length > 100) {
          throw new HttpError(400, 'TOO_MANY_OPERATIONS', '单次同步最多处理 100 个操作');
        }
        const hasServerGuard = body.serverId !== undefined || body.minimumVersion !== undefined;
        if (hasServerGuard && (!isNonEmptyString(body.serverId)
          || !Number.isSafeInteger(body.minimumVersion) || body.minimumVersion < 0)) {
          throw new HttpError(400, 'INVALID_SERVER_GUARD', '服务器身份保护参数无效');
        }
        if (hasServerGuard) {
          const current = await store.snapshot();
          if (current.serverId !== body.serverId) {
            throw new HttpError(409, 'SERVER_ID_MISMATCH', '服务器身份已改变，已拒绝上传以保护本机数据');
          }
          if (current.version < body.minimumVersion) {
            throw new HttpError(409, 'SERVER_VERSION_REGRESSION', '服务器版本已回退，已拒绝上传以保护本机数据');
          }
        }
        const result = await store.applyOperations(body.operations);
        sendJson(response, 200, result, headers);
        return;
      }
      if (url.pathname === '/api/export' && request.method === 'GET') {
        const snapshot = await store.snapshot();
        sendJson(response, 200, snapshot, { ...headers, 'Content-Disposition': 'attachment; filename="order-report-backup.json"' });
        return;
      }
      sendJson(response, 404, { error: 'API not found' }, headers);
    } catch (error) {
      sendError(response, error, headers);
    }
    return;
  }
  await serveStatic(request, response, url.pathname);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    sendError(response, error, corsHeaders());
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
let backupTimer = null;
let stopPromise = null;
let shutdownRequested = false;

async function runDailyBackup() {
  try {
    const result = await store.backupDaily();
    if (result.created) console.log(`daily database backup created: ${result.path}`);
  } catch (error) {
    // A backup problem should be visible, but must not keep the service offline.
    console.error(`daily database backup failed: ${error.message}`);
  }
}

async function start() {
  try {
    config.ensureSyncToken();
    await store.ready;
    if (shutdownRequested) return;
    await runDailyBackup();
    if (shutdownRequested) return;
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen(config.port, config.host, () => {
        server.off('error', onError);
        resolve();
      });
    });
  } catch (error) {
    try {
      await closeStore();
    } catch (closeError) {
      error.lockReleaseError = closeError;
    }
    throw error;
  }
  backupTimer = setInterval(runDailyBackup, DAY_MS);
  backupTimer.unref();
  const address = server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : config.port;
  console.log(`order-report-app listening on http://${config.host}:${listeningPort}`);
  console.log(`sync token file: ${config.tokenPath}`);
  console.log('The sync token is intentionally not printed. Read the 0600 token file locally when configuring the Android app.');
}

async function closeStore() {
  let result = await store.close();
  if ((!result.released || !result.durable) && !result.ownershipLost) {
    result = await store.close();
  }
  if ((!result.released || !result.durable) && !result.ownershipLost) {
    throw new Error(`数据库锁释放失败：${result.error?.message || '未知错误'}`, {
      cause: result.error,
    });
  }
}

function stop() {
  shutdownRequested = true;
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    if (backupTimer) {
      clearInterval(backupTimer);
      backupTimer = null;
    }
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      });
    }
    await closeStore();
  })();
  return stopPromise;
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      stop().catch((error) => {
        console.error(`graceful shutdown failed: ${error.message}`);
        process.exitCode = 1;
      });
    });
  }
}

if (require.main === module) {
  installSignalHandlers();
  start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  HttpError,
  handle,
  readBody,
  sendError,
  server,
  start,
  stop,
  store,
};
