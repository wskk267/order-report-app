const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_PATH = path.join(__dirname, '..', 'public', 'sw.js');
const SW_SOURCE = fs.readFileSync(SW_PATH, 'utf8');

function createHarness() {
  const listeners = new Map();
  const cacheWrites = [];
  const fetches = [];
  const cache = {
    async addAll() {},
    async match() { return null; },
    async put(request) { cacheWrites.push(request.url); },
  };
  const self = {
    location: new URL('https://app.example.test/app/sw.js'),
    clients: { async claim() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
    skipWaiting() {},
  };
  const context = vm.createContext({
    caches: {
      async delete() {},
      async keys() { return []; },
      async open() { return cache; },
    },
    fetch: async (request) => {
      fetches.push(request.url);
      return {
        ok: true,
        clone() { return this; },
      };
    },
    Response: { error() { return { ok: false }; } },
    self,
    Set,
    URL,
  });
  vm.runInContext(SW_SOURCE, context, { filename: SW_PATH });
  return { cacheWrites, fetches, listeners };
}

function request(url, headers = []) {
  const names = new Set(headers.map((name) => name.toLowerCase()));
  return {
    url,
    method: 'GET',
    mode: 'cors',
    headers: { has(name) { return names.has(String(name).toLowerCase()); } },
  };
}

async function dispatchFetch(harness, targetRequest) {
  let responsePromise = null;
  const background = [];
  harness.listeners.get('fetch')({
    request: targetRequest,
    respondWith(promise) { responsePromise = Promise.resolve(promise); },
    waitUntil(promise) { background.push(Promise.resolve(promise)); },
  });
  if (responsePromise) await responsePromise;
  await Promise.all(background);
  return responsePromise;
}

test('the service worker never handles or caches a sync API under a same-origin apiBase subpath', async () => {
  const harness = createHarness();
  const handled = await dispatchFetch(harness, request(
    'https://app.example.test/app/backend/api/sync/pull',
    ['X-Sync-Token'],
  ));

  assert.equal(handled, null);
  assert.deepEqual(harness.fetches, []);
  assert.deepEqual(harness.cacheWrites, []);
});

test('the service worker ignores every non-shell same-origin GET even without an auth header', async () => {
  const harness = createHarness();
  const handled = await dispatchFetch(
    harness,
    request('https://app.example.test/app/backend/api/sync/pull'),
  );

  assert.equal(handled, null);
  assert.deepEqual(harness.fetches, []);
  assert.deepEqual(harness.cacheWrites, []);
});

test('the service worker still refreshes and caches an explicit shell asset', async () => {
  const harness = createHarness();
  const handled = await dispatchFetch(harness, request('https://app.example.test/app/app.js'));

  assert.notEqual(handled, null);
  assert.deepEqual(harness.fetches, ['https://app.example.test/app/app.js']);
  assert.deepEqual(harness.cacheWrites, ['https://app.example.test/app/app.js']);
});
