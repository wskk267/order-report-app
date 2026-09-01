const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Domain = require('../shared/domain');

const APP_PATH = path.join(__dirname, '..', 'public', 'app.js');
const APP_SOURCE = fs.readFileSync(APP_PATH, 'utf8');
const STARTUP_MARKER = "  window.addEventListener('online', sync);\n})();";
const TESTABLE_APP_SOURCE = APP_SOURCE.replace(
  STARTUP_MARKER,
  `  window.addEventListener('online', sync);
  window.__appSyncTest = {
    apiRequest,
    app,
    dispatch,
    navigateView,
    performDownload,
    pushPendingBatch,
    pushPendingOperations,
    render,
    sync,
  };
})();`,
);

assert.notEqual(TESTABLE_APP_SOURCE, APP_SOURCE, 'app.js test instrumentation marker was not found');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function reportPayload(id) {
  return {
    report: {
      id: `report_${id}`,
      occurredAt: '2026-08-01T10:00',
      originalMessage: `report ${id}`,
    },
    items: [{
      id: `item_${id}`,
      productName: `product ${id}`,
      quantity: 1,
      actualPaymentCents: 100,
      expectedRefundCents: 120,
      expectedRebateCents: 5,
    }],
  };
}

function reportOperation(id) {
  return {
    opId: `op_${id}`,
    clientId: 'client_test',
    type: 'report.create',
    payload: reportPayload(id),
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

function applyOperations(operations) {
  return operations.reduce(
    (state, operation) => Domain.applyOperation(state, operation, {
      now: operation.createdAt,
      idFactory: (prefix) => `${prefix}_${operation.opId}`,
    }).state,
    Domain.emptyState(),
  );
}

function createHarness(fetchImplementation, options = {}) {
  const storage = new Map();
  const timers = [];
  const documentListeners = new Map();
  const windowListeners = new Map();

  class FakeElement {
    constructor() {
      this.children = [];
      this.className = '';
      this.dataset = {};
      this.disabled = false;
      this.innerHTML = '';
      this.style = {};
      this.textContent = '';
      this.classList = {
        contains: () => false,
        toggle: () => {},
      };
    }

    appendChild(child) { this.children.push(child); }
    remove() {}
    removeAttribute() {}
    setAttribute() {}
  }

  let settingsForm = null;
  const roots = new Map([
    ['#modal-root', new FakeElement()],
    ['#toast-root', new FakeElement()],
  ]);
  if (options.withMain) {
    const main = new FakeElement();
    let mainHtml = '';
    Object.defineProperty(main, 'innerHTML', {
      configurable: true,
      get() { return mainHtml; },
      set(value) {
        mainHtml = String(value);
        if (!mainHtml.includes('data-form="settings"')) {
          settingsForm = null;
          return;
        }
        settingsForm = new FakeElement();
        settingsForm.dataset.form = 'settings';
        settingsForm.elements = {
          apiBase: { value: '' },
          token: { value: '' },
        };
      },
    });
    roots.set('#main-content', main);
  }
  const document = {
    addEventListener(type, listener) { documentListeners.set(type, listener); },
    createElement() { return new FakeElement(); },
    querySelector(selector) {
      if (selector === 'form[data-form="settings"]') return settingsForm;
      return roots.get(selector) || null;
    },
    querySelectorAll() { return []; },
  };
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  const window = {
    OrderDomain: Domain,
    addEventListener(type, listener) { windowListeners.set(type, listener); },
  };
  window.window = window;

  let fetchImpl = fetchImplementation;
  const context = vm.createContext({
    console,
    document,
    Element: FakeElement,
    fetch(...args) { return fetchImpl(...args); },
    localStorage,
    location: { origin: 'null', protocol: 'file:' },
    navigator: {},
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
    window,
  });

  vm.runInContext(TESTABLE_APP_SOURCE, context, { filename: APP_PATH });
  const api = window.__appSyncTest;
  api.app.settings = { apiBase: 'https://sync.example.test', token: 'test-token' };

  return {
    ...api,
    document,
    setFetch(implementation) { fetchImpl = implementation; },
    stored() {
      const raw = storage.get('order-report-local-v1');
      return raw ? JSON.parse(raw) : null;
    },
    timers,
  };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test('a local operation created during push is not overwritten by the older server snapshot', async () => {
  const requests = [];
  const harness = createHarness((url, options = {}) => {
    const result = deferred();
    requests.push({
      body: JSON.parse(options.body),
      resolve(body) { result.resolve(jsonResponse(body)); },
      url,
    });
    return result.promise;
  });
  const firstOperation = reportOperation('first');
  harness.app.state = applyOperations([firstOperation]);
  harness.app.queue = [firstOperation];

  const syncing = harness.sync();
  await waitUntil(() => requests.length === 1, 'the first push request was not issued');
  harness.dispatch('report.create', reportPayload('during_push'));
  const secondOperation = harness.app.queue.find((operation) => operation.opId !== firstOperation.opId);
  assert.ok(secondOperation, 'the operation created during push should enter the queue');

  requests[0].resolve({
    accepted: [{ opId: firstOperation.opId }],
    rejected: [],
    version: 1,
    state: applyOperations([firstOperation]),
  });
  await waitUntil(() => requests.length === 2, 'the operation created during push was not sent next');

  assert.equal(harness.app.state.reports.some((report) => report.id === 'report_during_push'), true);
  assert.equal(harness.app.queue.some((operation) => operation.opId === secondOperation.opId), true);
  assert.equal(requests[1].body.operations.length, 1);
  assert.equal(requests[1].body.operations[0].opId, secondOperation.opId);

  requests[1].resolve({
    accepted: [{ opId: secondOperation.opId }],
    rejected: [],
    version: 2,
    state: applyOperations([firstOperation, secondOperation]),
  });
  await syncing;

  assert.equal(harness.app.queue.length, 0);
  assert.equal(harness.app.state.reports.some((report) => report.id === 'report_during_push'), true);
});

test('a local operation created during download cancels the destructive overwrite', async () => {
  const request = deferred();
  const harness = createHarness(() => request.promise);

  const downloading = harness.performDownload();
  await new Promise((resolve) => setImmediate(resolve));
  harness.dispatch('report.create', reportPayload('during_download'));
  request.resolve(jsonResponse({
    version: 10,
    state: applyOperations([reportOperation('server_only')]),
  }));
  await downloading;

  assert.equal(harness.app.state.reports.some((report) => report.id === 'report_during_download'), true);
  assert.equal(harness.app.state.reports.some((report) => report.id === 'report_server_only'), false);
  assert.equal(harness.app.queue.length, 1);
  assert.match(harness.app.syncError, /下载期间出现新的本机操作，已取消覆盖/);
  assert.equal(harness.stored().queue.length, 1);
});

test('a successful HTTP response without acknowledgements keeps the attempted queue entries', async () => {
  let requestCount = 0;
  const operation = reportOperation('missing_ack');
  const harness = createHarness(async () => {
    requestCount += 1;
    return jsonResponse({ version: 1, state: applyOperations([operation]) });
  });
  harness.app.state = applyOperations([operation]);
  harness.app.queue = [operation];

  await harness.sync();

  assert.equal(requestCount, 1, 'missing acknowledgements must not cause a tight retry loop');
  assert.equal(harness.app.queue.length, 1);
  assert.equal(harness.app.queue[0].opId, operation.opId);
  assert.match(harness.app.syncError, /服务器未确认 1 条操作/);
  assert.equal(harness.stored().queue[0].opId, operation.opId);
});

test('101 pending operations are uploaded in batches of 100 and 1', async () => {
  const operations = Array.from({ length: 101 }, (_, index) => ({
    opId: `op_batch_${index}`,
    clientId: 'client_test',
    type: 'report.create',
    payload: {},
    createdAt: '2026-08-01T10:00:00.000Z',
  }));
  const batches = [];
  const harness = createHarness(async (url, options = {}) => {
    const body = JSON.parse(options.body);
    batches.push(body.operations.map((operation) => operation.opId));
    return jsonResponse({
      accepted: body.operations.map((operation) => ({ opId: operation.opId })),
      rejected: [],
      version: batches.reduce((total, batch) => total + batch.length, 0),
      state: Domain.emptyState(),
    });
  });
  harness.app.queue = operations;

  await harness.sync();

  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 100);
  assert.equal(batches[1].length, 1);
  assert.equal(batches[0][0], 'op_batch_0');
  assert.equal(batches[0][99], 'op_batch_99');
  assert.equal(batches[1][0], 'op_batch_100');
  assert.equal(harness.app.queue.length, 0);
  assert.equal(harness.stored().queue.length, 0);
});

test('all upload batches keep using the server connection captured when sync started', async () => {
  const operations = Array.from({ length: 101 }, (_, index) => ({
    opId: `op_connection_${index}`,
    clientId: 'client_test',
    type: 'report.create',
    payload: {},
    createdAt: '2026-08-01T10:00:00.000Z',
  }));
  const firstResponse = deferred();
  const requests = [];
  const harness = createHarness((url, options = {}) => {
    const body = JSON.parse(options.body);
    requests.push({ body, headers: options.headers, url });
    const response = jsonResponse({
      accepted: body.operations.map((operation) => ({ opId: operation.opId })),
      rejected: [],
      version: requests.length === 1 ? 100 : 101,
      state: Domain.emptyState(),
    });
    return requests.length === 1 ? firstResponse.promise : Promise.resolve(response);
  });
  harness.app.queue = operations;

  const syncing = harness.sync();
  await waitUntil(() => requests.length === 1, 'the first upload batch was not issued');
  harness.app.settings = {
    apiBase: 'https://replacement.example.test',
    token: 'replacement-token',
  };
  firstResponse.resolve(jsonResponse({
    accepted: requests[0].body.operations.map((operation) => ({ opId: operation.opId })),
    rejected: [],
    version: 100,
    state: Domain.emptyState(),
  }));
  await syncing;

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://sync.example.test/api/sync/push');
  assert.equal(requests[1].url, 'https://sync.example.test/api/sync/push');
  assert.equal(requests[0].headers['X-Sync-Token'], 'test-token');
  assert.equal(requests[1].headers['X-Sync-Token'], 'test-token');
  assert.equal(requests[0].body.operations.length, 100);
  assert.equal(requests[1].body.operations.length, 1);
  assert.equal(harness.app.queue.length, 0);
});

test('an unresponsive server request times out and releases the caller', async () => {
  const response = deferred();
  const harness = createHarness(() => response.promise);

  const request = harness.apiRequest('/api/sync/pull');
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 20000);
  harness.timers[0].callback();

  await assert.rejects(request, /连接服务器超时（20 秒）/);
  response.resolve(jsonResponse({ version: 0, state: Domain.emptyState() }));
});

test('render can leave the settings page while an unsaved connection draft exists', () => {
  const harness = createHarness(
    async () => jsonResponse({ version: 0, state: Domain.emptyState() }),
    { withMain: true },
  );
  harness.navigateView('settings');
  let form = harness.document.querySelector('form[data-form="settings"]');
  assert.ok(form, 'the settings form should be mounted');
  form.elements.apiBase.value = 'https://draft.example.test/';
  form.elements.token.value = 'draft-token';

  harness.render();
  form = harness.document.querySelector('form[data-form="settings"]');
  assert.equal(form.elements.apiBase.value, 'https://draft.example.test');
  assert.equal(form.elements.token.value, 'draft-token');

  assert.doesNotThrow(() => harness.navigateView('dashboard'));
  assert.equal(harness.app.view, 'dashboard');
  assert.equal(harness.document.querySelector('form[data-form="settings"]'), null);
  assert.equal(harness.app.settings.apiBase, 'https://sync.example.test');
  assert.equal(harness.app.settings.token, 'test-token');
});
