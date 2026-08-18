const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { URL } = require('node:url');
const config = require('./lib/config');
const { Store } = require('./lib/store');

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
  return Boolean(provided) && provided === config.syncToken;
}

function readBody(request, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('请求体不是有效 JSON'));
      }
    });
    request.on('error', reject);
  });
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
        const result = await store.applyOperations(body.operations || []);
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
      sendJson(response, 400, { error: error.message || '请求失败' }, headers);
    }
    return;
  }
  await serveStatic(request, response, url.pathname);
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    sendJson(response, 500, { error: error.message || '服务器错误' }, corsHeaders());
  });
});

async function start() {
  await store.ready;
  server.listen(config.port, config.host, () => {
    console.log(`order-report-app listening on http://${config.host}:${config.port}`);
    console.log(`sync token file: ${config.tokenPath}`);
    console.log('The sync token is intentionally not printed. Read the 0600 token file locally when configuring the Android app.');
  });
}

if (require.main === module) start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { server, handle, store };
