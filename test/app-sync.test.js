const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Domain = require('../shared/domain');

const APP_PATH = path.join(__dirname, '..', 'public', 'app.js');
const APP_SOURCE = fs.readFileSync(APP_PATH, 'utf8');
const END_MARKER = '\n})();';
const END_INDEX = APP_SOURCE.lastIndexOf(END_MARKER);
assert.notEqual(END_INDEX, -1, 'app.js test instrumentation marker was not found');
const TESTABLE_APP_SOURCE = `${APP_SOURCE.slice(0, END_INDEX)}
  window.__appSyncTest = {
    apiRequest,
    app,
    bindCurrentServerAndUpload,
    dateOnlyValue,
    discardFailedOperation,
    dispatch,
    downloadData,
    localStorageRead,
    navigateView,
    performDownload,
    performBindAndUpload,
    pullServerState,
    pushPendingBatch,
    pushPendingOperations,
    recoveryExport,
    refreshFromStorage,
    render,
    retryFailedOperation,
    saveSettings,
    sync,
  };
})();${APP_SOURCE.slice(END_INDEX + END_MARKER.length)}`;

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

function serverSnapshot(overrides = {}) {
  return {
    serverId: 'server_test',
    version: 0,
    state: Domain.emptyState(),
    ...overrides,
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
  const storage = options.storageMap || new Map(Object.entries(options.storage || {}));
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
  let storageWrite = (key, value) => storage.set(key, String(value));
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { return storageWrite(key, value); },
  };
  const window = {
    OrderDomain: Domain,
    addEventListener(type, listener) { windowListeners.set(type, listener); },
  };
  window.window = window;

  let fetchImpl = fetchImplementation;
  const context = vm.createContext({
    console,
    Date: options.Date || Date,
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
  if (!options.keepLoadedSettings) {
    api.app.settings = { apiBase: 'https://sync.example.test', token: 'test-token' };
  }

  return {
    ...api,
    document,
    emitOnline() { return windowListeners.get('online')?.(); },
    emitStorage(key = 'order-report-local-v1') { return windowListeners.get('storage')?.({ key }); },
    setFetch(implementation) { fetchImpl = implementation; },
    setStorageWrite(implementation) { storageWrite = implementation; },
    stored() {
      const raw = storage.get('order-report-local-v1');
      return raw ? JSON.parse(raw) : null;
    },
    storedRaw() { return storage.get('order-report-local-v1') || null; },
    storage,
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

  requests[0].resolve(serverSnapshot({
    accepted: [{ opId: firstOperation.opId }],
    rejected: [],
    version: 1,
    state: applyOperations([firstOperation]),
  }));
  await waitUntil(() => requests.length === 2, 'the operation created during push was not sent next');

  assert.equal(harness.app.state.reports.some((report) => report.id === 'report_during_push'), true);
  assert.equal(harness.app.queue.some((operation) => operation.opId === secondOperation.opId), true);
  assert.equal(requests[1].body.operations.length, 1);
  assert.equal(requests[1].body.operations[0].opId, secondOperation.opId);

  requests[1].resolve(serverSnapshot({
    accepted: [{ opId: secondOperation.opId }],
    rejected: [],
    version: 2,
    state: applyOperations([firstOperation, secondOperation]),
  }));
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
  request.resolve(jsonResponse(serverSnapshot({
    version: 10,
    state: applyOperations([reportOperation('server_only')]),
  })));
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
    return jsonResponse(serverSnapshot({ version: 1, state: applyOperations([operation]) }));
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
    return jsonResponse(serverSnapshot({
      accepted: body.operations.map((operation) => ({ opId: operation.opId })),
      rejected: [],
      version: batches.reduce((total, batch) => total + batch.length, 0),
      state: Domain.emptyState(),
    }));
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
    const response = jsonResponse(serverSnapshot({
      accepted: body.operations.map((operation) => ({ opId: operation.opId })),
      rejected: [],
      version: requests.length === 1 ? 100 : 101,
      state: Domain.emptyState(),
    }));
    return requests.length === 1 ? firstResponse.promise : Promise.resolve(response);
  });
  harness.app.queue = operations;

  const syncing = harness.sync();
  await waitUntil(() => requests.length === 1, 'the first upload batch was not issued');
  harness.app.settings = {
    apiBase: 'https://replacement.example.test',
    token: 'replacement-token',
  };
  firstResponse.resolve(jsonResponse(serverSnapshot({
    accepted: requests[0].body.operations.map((operation) => ({ opId: operation.opId })),
    rejected: [],
    version: 100,
    state: Domain.emptyState(),
  })));
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
  response.resolve(jsonResponse(serverSnapshot()));
});

test('render can leave the settings page while an unsaved connection draft exists', () => {
  const harness = createHarness(
    async () => jsonResponse(serverSnapshot()),
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

test('a storage adoption closes an open editor so its stale form cannot overwrite the newer revision', () => {
  const newer = reportOperation('other_tab_editor_update');
  const harness = createHarness(async () => jsonResponse(serverSnapshot()), { withMain: true });
  const modalRoot = harness.document.querySelector('#modal-root');
  harness.app.modal = true;
  modalRoot.innerHTML = '<form data-form="report">stale unsaved editor</form>';
  const externalRaw = JSON.stringify({
    state: applyOperations([newer]),
    queue: [newer],
    settings: { apiBase: '', token: '' },
    clientId: 'client_other_tab_editor',
    hasSynced: false,
    lastServerId: '',
    lastServerVersion: null,
    lastServerApiBase: '',
    requiresExplicitDownload: false,
    localRevision: 1,
    storageRevision: 1,
  });
  harness.storage.set('order-report-local-v1', externalRaw);

  harness.emitStorage();

  assert.equal(harness.app.modal, null);
  assert.equal(modalRoot.innerHTML, '');
  assert.equal(harness.app.storageRevision, 1);
  assert.equal(harness.app.state.reports.some((row) => row.id === newer.payload.report.id), true);
});

test('a storage adoption does not restore a stale unsaved settings draft over the adopted connection', () => {
  const harness = createHarness(async () => jsonResponse(serverSnapshot()), { withMain: true });
  harness.navigateView('settings');
  const staleForm = harness.document.querySelector('form[data-form="settings"]');
  staleForm.elements.apiBase.value = 'https://stale-draft.example.test';
  staleForm.elements.token.value = 'stale-draft-token';
  const externalRaw = JSON.stringify({
    state: Domain.emptyState(),
    queue: [],
    settings: { apiBase: 'https://newer-tab.example.test', token: 'newer-tab-token' },
    clientId: 'client_other_tab_settings',
    hasSynced: false,
    lastServerId: '',
    lastServerVersion: null,
    lastServerApiBase: '',
    requiresExplicitDownload: false,
    localRevision: 1,
    storageRevision: 1,
  });
  harness.storage.set('order-report-local-v1', externalRaw);

  harness.emitStorage();

  const renderedForm = harness.document.querySelector('form[data-form="settings"]');
  assert.notEqual(renderedForm.elements.apiBase.value, 'https://stale-draft.example.test');
  assert.notEqual(renderedForm.elements.token.value, 'stale-draft-token');
  assert.equal(harness.app.settings.apiBase, 'https://newer-tab.example.test');
  assert.equal(harness.app.settings.token, 'newer-tab-token');
});

test('a normal pull refuses a version regression from the bound server without changing local data', async () => {
  const localOperation = reportOperation('local_version_10');
  const localState = applyOperations([localOperation]);
  let requestCount = 0;
  const harness = createHarness(async () => {
    requestCount += 1;
    return jsonResponse(serverSnapshot({
      version: 9,
      state: applyOperations([reportOperation('older_server')]),
    }));
  });
  harness.app.state = localState;
  harness.app.lastServerId = 'server_test';
  harness.app.lastServerVersion = 10;
  harness.app.lastServerApiBase = 'https://sync.example.test';
  harness.app.hasSynced = true;

  await harness.sync();

  assert.equal(requestCount, 1);
  assert.equal(harness.app.lastServerVersion, 10);
  assert.equal(harness.app.state.reports.some((row) => row.id === 'report_local_version_10'), true);
  assert.equal(harness.app.state.reports.some((row) => row.id === 'report_older_server'), false);
  assert.match(harness.app.syncError, /版本从 10 回退到 9/);
  assert.equal(harness.storedRaw(), null);
});

test('push preflight refuses a different server identity before sending any operation', async () => {
  const operation = reportOperation('wrong_server');
  const requests = [];
  const harness = createHarness(async (url, options = {}) => {
    requests.push({ method: options.method || 'GET', url });
    return jsonResponse(serverSnapshot({ serverId: 'server_replacement', version: 1 }));
  });
  harness.app.state = applyOperations([operation]);
  harness.app.queue = [operation];
  harness.app.lastServerId = 'server_original';
  harness.app.lastServerVersion = 5;
  harness.app.lastServerApiBase = 'https://sync.example.test';
  harness.app.hasSynced = true;

  await harness.sync();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.match(requests[0].url, /\/api\/sync\/pull$/);
  assert.equal(harness.app.queue.length, 1);
  assert.equal(harness.app.queue[0].opId, operation.opId);
  assert.equal(harness.app.lastServerId, 'server_original');
  assert.match(harness.app.syncError, /服务器身份.*不一致/);
});

test('a successful pull persists the server identity and version', async () => {
  const harness = createHarness(async () => jsonResponse(serverSnapshot({ version: 7 })));

  await harness.sync();

  assert.equal(harness.app.lastServerId, 'server_test');
  assert.equal(harness.app.lastServerVersion, 7);
  assert.equal(harness.app.lastServerApiBase, 'https://sync.example.test');
  assert.equal(harness.stored().lastServerId, 'server_test');
  assert.equal(harness.stored().lastServerVersion, 7);
});

test('a queued server switch requires confirmation and preserves every operation when allowed', () => {
  const operation = { ...reportOperation('queued_connection'), syncError: 'server rejected it' };
  const harness = createHarness(async () => jsonResponse(serverSnapshot()));
  harness.app.queue = [operation];
  harness.app.lastServerId = 'server_test';
  harness.app.lastServerVersion = 3;
  harness.app.lastServerApiBase = 'https://sync.example.test';
  harness.app.hasSynced = true;

  assert.throws(
    () => harness.saveSettings({ apiBase: 'https://replacement.example.test', token: 'new-token' }),
    /仍有待处理或失败操作，不能切换连接/,
  );
  assert.equal(harness.app.settings.apiBase, 'https://sync.example.test');
  assert.equal(harness.storedRaw(), null);

  harness.saveSettings(
    { apiBase: 'https://replacement.example.test', token: 'new-token' },
    { allowQueuedServerChange: true },
  );
  assert.equal(harness.app.settings.apiBase, 'https://replacement.example.test');
  assert.equal(harness.app.queue.length, 1);
  assert.equal(harness.app.queue[0].opId, operation.opId);
  assert.equal(harness.app.requiresExplicitDownload, true);
  assert.match(harness.app.syncError, /下载并覆盖/);

  harness.saveSettings(
    { apiBase: 'https://sync.example.test', token: 'restored-token' },
    { allowQueuedServerChange: true },
  );
  assert.equal(harness.app.queue[0].opId, operation.opId);
  assert.equal(harness.app.requiresExplicitDownload, false);
  assert.equal(harness.app.hasSynced, true);
  assert.equal(harness.app.syncError, '');
});

test('an inferred same-origin address can receive its first token while offline work is queued', () => {
  const operation = reportOperation('first_binding');
  const harness = createHarness(async () => jsonResponse(serverSnapshot()));
  harness.app.state = applyOperations([operation]);
  harness.app.queue = [operation];

  assert.doesNotThrow(() => harness.saveSettings({
    apiBase: 'https://sync.example.test',
    token: 'first-real-token',
  }));
  assert.equal(harness.app.settings.token, 'first-real-token');
  assert.equal(harness.app.queue.length, 1);
  assert.equal(harness.stored().queue[0].opId, operation.opId);
});

test('an offline queue can be attached when saving its first server connection', () => {
  const operation = reportOperation('first_connection');
  const harness = createHarness(async () => jsonResponse(serverSnapshot()));
  harness.app.state = applyOperations([operation]);
  harness.app.queue = [operation];

  harness.saveSettings({ apiBase: 'https://first.example.test/', token: 'first-token' });

  assert.equal(harness.app.settings.apiBase, 'https://first.example.test');
  assert.equal(harness.app.settings.token, 'first-token');
  assert.equal(harness.app.queue[0].opId, operation.opId);
  assert.equal(harness.app.requiresExplicitDownload, false);
});

test('changing a bound server address requires explicit download before ordinary sync', async () => {
  let fetchCount = 0;
  const harness = createHarness(async () => {
    fetchCount += 1;
    return jsonResponse(serverSnapshot({ serverId: 'server_new', version: 1 }));
  });
  harness.app.lastServerId = 'server_old';
  harness.app.lastServerVersion = 12;
  harness.app.lastServerApiBase = 'https://sync.example.test';
  harness.app.hasSynced = true;

  harness.saveSettings({ apiBase: 'https://replacement.example.test/', token: 'new-token' });
  assert.equal(harness.app.requiresExplicitDownload, true);
  await harness.sync();
  assert.equal(fetchCount, 0, 'ordinary sync must stop before making a request');
  assert.match(harness.app.syncError, /下载并覆盖/);

  await harness.performDownload();
  assert.equal(fetchCount, 1);
  assert.equal(harness.app.lastServerId, 'server_new');
  assert.equal(harness.app.lastServerVersion, 1);
  assert.equal(harness.app.requiresExplicitDownload, false);
});

test('rotating only the token keeps a queued connection bound and verifies identity before upload', async () => {
  const operation = reportOperation('rotated_token');
  const requests = [];
  const harness = createHarness(async (url, options = {}) => {
    requests.push({ body: options.body, method: options.method || 'GET', url });
    if (!options.body) return jsonResponse(serverSnapshot({ version: 4 }));
    return jsonResponse(serverSnapshot({
      accepted: [{ opId: operation.opId }],
      rejected: [],
      version: 5,
      state: applyOperations([operation]),
    }));
  });
  harness.app.state = applyOperations([operation]);
  harness.app.queue = [operation];
  harness.app.lastServerId = 'server_test';
  harness.app.lastServerVersion = 4;
  harness.app.lastServerApiBase = 'https://sync.example.test';
  harness.app.hasSynced = true;

  harness.saveSettings({ apiBase: 'https://sync.example.test', token: 'rotated-token' });
  assert.equal(harness.app.requiresExplicitDownload, false);
  assert.equal(harness.app.hasSynced, true);
  assert.equal(harness.app.queue.length, 1);
  await harness.sync();
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'POST']);
  const posted = JSON.parse(requests[1].body);
  assert.equal(posted.serverId, 'server_test');
  assert.equal(posted.minimumVersion, 4);
  assert.equal(harness.app.lastServerVersion, 5);
  assert.equal(harness.app.queue.length, 0);
});

test('download always asks for confirmation even when the queue is empty', async () => {
  let fetchCount = 0;
  const harness = createHarness(async () => {
    fetchCount += 1;
    return jsonResponse(serverSnapshot({ version: 1 }));
  });

  harness.downloadData();
  assert.equal(fetchCount, 0);
  assert.equal(typeof harness.app.confirmation, 'function');
  const confirmDownload = harness.app.confirmation;
  await confirmDownload();
  assert.equal(fetchCount, 1);
});

test('dispatch keeps memory unchanged when local persistence fails', () => {
  const harness = createHarness(async () => jsonResponse(serverSnapshot()));
  const beforeState = JSON.stringify(harness.app.state);
  harness.setStorageWrite(() => { throw new Error('quota exceeded'); });

  harness.dispatch('report.create', reportPayload('write_failure'));

  assert.equal(JSON.stringify(harness.app.state), beforeState);
  assert.equal(harness.app.queue.length, 0);
  assert.equal(harness.app.localRevision, 0);
  assert.equal(harness.storedRaw(), null);
});

test('push acknowledgement keeps memory queue intact when reconciliation cannot be persisted', async () => {
  const operation = reportOperation('push_write_failure');
  const harness = createHarness(async () => jsonResponse(serverSnapshot({
    accepted: [{ opId: operation.opId }],
    rejected: [],
    version: 1,
    state: applyOperations([operation]),
  })));
  harness.app.state = applyOperations([operation]);
  harness.app.queue = [operation];
  harness.setStorageWrite(() => { throw new Error('quota exceeded'); });

  await harness.sync();

  assert.equal(harness.app.queue.length, 1);
  assert.equal(harness.app.queue[0].opId, operation.opId);
  assert.match(harness.app.syncError, /quota exceeded/);
  assert.equal(harness.storedRaw(), null);
});

test('pull keeps memory state intact when the downloaded candidate cannot be persisted', async () => {
  const localOperation = reportOperation('pull_write_local');
  const harness = createHarness(async () => jsonResponse(serverSnapshot({
    version: 3,
    state: applyOperations([reportOperation('pull_write_server')]),
  })));
  harness.app.state = applyOperations([localOperation]);
  harness.setStorageWrite(() => { throw new Error('quota exceeded'); });

  await harness.sync();

  assert.equal(harness.app.state.reports.some((row) => row.id === 'report_pull_write_local'), true);
  assert.equal(harness.app.state.reports.some((row) => row.id === 'report_pull_write_server'), false);
  assert.equal(harness.app.lastServerId, '');
  assert.match(harness.app.syncError, /quota exceeded/);
});

test('settings remain unchanged when their candidate cannot be persisted', () => {
  const harness = createHarness(async () => jsonResponse(serverSnapshot()));
  harness.setStorageWrite(() => { throw new Error('quota exceeded'); });

  assert.throws(
    () => harness.saveSettings({ apiBase: 'https://new.example.test', token: 'new-token' }),
    /quota exceeded/,
  );
  assert.equal(harness.app.settings.apiBase, 'https://sync.example.test');
  assert.equal(harness.app.settings.token, 'test-token');
  assert.equal(harness.storedRaw(), null);
});

test('an online request during a queue-free pull schedules one follow-up pull', async () => {
  const firstResponse = deferred();
  let requestCount = 0;
  const harness = createHarness(() => {
    requestCount += 1;
    if (requestCount === 1) return firstResponse.promise;
    return Promise.resolve(jsonResponse(serverSnapshot({ version: 2 })));
  });

  const firstSync = harness.sync();
  await waitUntil(() => requestCount === 1, 'the initial pull was not issued');
  harness.emitOnline();
  harness.emitOnline();
  firstResponse.resolve(jsonResponse(serverSnapshot({ version: 1 })));
  await firstSync;

  const followUpTimer = harness.timers.find((timer) => timer.delay === 0);
  assert.ok(followUpTimer, 'a follow-up sync should be scheduled');
  followUpTimer.callback();
  await waitUntil(() => requestCount === 2, 'the follow-up pull was not issued');
  await harness.app.syncPromise;
  assert.equal(requestCount, 2);
  assert.equal(harness.app.lastServerVersion, 2);
});

test('discarding one failed operation rebuilds local state from the bound server before retaining later work', async () => {
  const serverBase = reportOperation('server_base');
  const failed = { ...reportOperation('failed_head'), syncError: 'invalid data' };
  const later = reportOperation('later_valid');
  const requests = [];
  const harness = createHarness((url, options = {}) => {
    requests.push({ method: options.method || 'GET', url });
    return Promise.resolve(jsonResponse(serverSnapshot({
      version: 4,
      state: applyOperations([serverBase]),
    })));
  });
  harness.app.state = applyOperations([serverBase, failed, later]);
  harness.app.queue = [failed, later];
  harness.app.hasSynced = true;
  harness.app.lastServerId = 'server_test';
  harness.app.lastServerVersion = 3;
  harness.app.lastServerApiBase = 'https://sync.example.test';

  assert.equal(await harness.discardFailedOperation(failed.opId), true);
  assert.deepEqual(requests, [{ method: 'GET', url: 'https://sync.example.test/api/sync/pull' }]);
  assert.equal(harness.app.queue.length, 1);
  assert.equal(harness.app.queue[0].opId, later.opId);
  assert.equal(harness.app.state.reports.some((row) => row.id === 'report_failed_head'), false);
  assert.equal(harness.app.state.reports.some((row) => row.id === 'report_later_valid'), true);
  assert.equal(harness.app.state.reports.some((row) => row.id === 'report_server_base'), true);
  assert.equal(harness.app.lastServerVersion, 4);
  assert.equal(harness.stored().queue[0].opId, later.opId);
  assert.equal(harness.stored().state.reports.some((row) => row.id === 'report_failed_head'), false);
  assert.ok(harness.timers.some((timer) => timer.delay === 0), 'retained pending work should schedule a follow-up sync');
});

test('discarding a failed operation while offline leaves its local state and queue untouched', async () => {
  const failed = { ...reportOperation('offline_failed'), syncError: 'server rejected it' };
  let requestCount = 0;
  const harness = createHarness(async () => {
    requestCount += 1;
    throw new Error('offline');
  });
  const startingState = applyOperations([failed]);
  const startingQueue = [failed];
  harness.app.state = startingState;
  harness.app.queue = startingQueue;
  harness.app.hasSynced = true;
  harness.app.lastServerId = 'server_test';
  harness.app.lastServerVersion = 3;
  harness.app.lastServerApiBase = 'https://sync.example.test';

  assert.equal(await harness.discardFailedOperation(failed.opId), false);
  assert.equal(requestCount, 1);
  assert.strictEqual(harness.app.state, startingState);
  assert.strictEqual(harness.app.queue, startingQueue);
  assert.equal(harness.storedRaw(), null);
  assert.match(harness.app.syncError, /\u672a\u80fd\u5b89\u5168\u4e22\u5f03.*offline/);
});

for (const [label, snapshot, message] of [
  ['a different server identity', serverSnapshot({ serverId: 'server_other', version: 4 }), /\u670d\u52a1\u5668\u8eab\u4efd.*\u4e0d\u4e00\u81f4/],
  ['a regressed server version', serverSnapshot({ version: 2 }), /\u670d\u52a1\u5668\u7248\u672c.*\u56de\u9000/],
]) {
  test(`discarding a failed operation rejects ${label} without changing local data`, async () => {
    const failed = { ...reportOperation(`discard_${label.replaceAll(' ', '_')}`), syncError: 'server rejected it' };
    const harness = createHarness(async () => jsonResponse(snapshot));
    const startingState = applyOperations([failed]);
    const startingQueue = [failed];
    harness.app.state = startingState;
    harness.app.queue = startingQueue;
    harness.app.hasSynced = true;
    harness.app.lastServerId = 'server_test';
    harness.app.lastServerVersion = 3;
    harness.app.lastServerApiBase = 'https://sync.example.test';

    assert.equal(await harness.discardFailedOperation(failed.opId), false);
    assert.strictEqual(harness.app.state, startingState);
    assert.strictEqual(harness.app.queue, startingQueue);
    assert.equal(harness.storedRaw(), null);
    assert.match(harness.app.syncError, message);
  });
}

test('discarding a failed prerequisite is cancelled when a retained operation cannot be replayed', async () => {
  const failed = { ...reportOperation('failed_dependency'), syncError: 'server rejected it' };
  const dependent = {
    opId: 'op_dependent_shipment',
    clientId: 'client_test',
    type: 'shipment.create',
    payload: {
      shipment: {
        id: 'shipment_dependent',
        trackingNumber: 'TRACK-DEPENDENT',
        shippingCostCents: 0,
        shippedAt: '2026-08-02T10:00',
      },
      items: [{ productName: 'product failed_dependency', quantity: 1 }],
    },
    createdAt: '2026-08-02T10:00:00.000Z',
  };
  const harness = createHarness(async () => jsonResponse(serverSnapshot({ version: 4 })));
  const startingState = applyOperations([failed, dependent]);
  const startingQueue = [failed, dependent];
  harness.app.state = startingState;
  harness.app.queue = startingQueue;
  harness.app.hasSynced = true;
  harness.app.lastServerId = 'server_test';
  harness.app.lastServerVersion = 3;
  harness.app.lastServerApiBase = 'https://sync.example.test';

  assert.equal(await harness.discardFailedOperation(failed.opId), false);
  assert.strictEqual(harness.app.state, startingState);
  assert.strictEqual(harness.app.queue, startingQueue);
  assert.equal(harness.storedRaw(), null);
  assert.match(harness.app.syncError, /\u91cd\u653e\u4fdd\u7559\u64cd\u4f5c.*\u5269\u4f59\u5e93\u5b58\u4e0d\u8db3/);
});

test('discarding a failed operation rolls back the rebuilt candidate when persistence fails', async () => {
  const failed = { ...reportOperation('discard_quota'), syncError: 'server rejected it' };
  const serverBase = reportOperation('discard_quota_server');
  const harness = createHarness(async () => jsonResponse(serverSnapshot({
    version: 4,
    state: applyOperations([serverBase]),
  })));
  const startingState = applyOperations([failed]);
  const startingQueue = [failed];
  harness.app.state = startingState;
  harness.app.queue = startingQueue;
  harness.app.hasSynced = true;
  harness.app.lastServerId = 'server_test';
  harness.app.lastServerVersion = 3;
  harness.app.lastServerApiBase = 'https://sync.example.test';
  harness.setStorageWrite(() => { throw new Error('quota exceeded'); });

  assert.equal(await harness.discardFailedOperation(failed.opId), false);
  assert.strictEqual(harness.app.state, startingState);
  assert.strictEqual(harness.app.queue, startingQueue);
  assert.equal(harness.storedRaw(), null);
  assert.match(harness.app.syncError, /quota exceeded/);
});

test('failed operations without a recorded server identity cannot be discarded by guessing', async () => {
  const failed = { ...reportOperation('legacy_discard'), syncError: 'server rejected it' };
  let requestCount = 0;
  const harness = createHarness(async () => {
    requestCount += 1;
    return jsonResponse(serverSnapshot());
  });
  const startingState = applyOperations([failed]);
  const startingQueue = [failed];
  harness.app.state = startingState;
  harness.app.queue = startingQueue;
  harness.app.hasSynced = true;

  assert.equal(await harness.discardFailedOperation(failed.opId), false);
  assert.equal(requestCount, 0);
  assert.strictEqual(harness.app.state, startingState);
  assert.strictEqual(harness.app.queue, startingQueue);
  assert.match(harness.app.syncError, /\u5c1a\u672a\u7ed1\u5b9a\u670d\u52a1\u5668\u8eab\u4efd/);
});

test('retrying a failed operation assigns a fresh operation id', async () => {
  const failed = { ...reportOperation('retry_me'), syncError: 'temporary rejection' };
  const response = deferred();
  let postedOperation = null;
  const harness = createHarness((url, options = {}) => {
    [postedOperation] = JSON.parse(options.body).operations;
    return response.promise;
  });
  harness.app.state = applyOperations([failed]);
  harness.app.queue = [failed];

  assert.equal(harness.retryFailedOperation(failed.opId), true);
  await waitUntil(() => postedOperation !== null, 'the retried operation was not uploaded');
  assert.notEqual(postedOperation.opId, failed.opId);
  assert.equal(harness.app.queue[0].opId, postedOperation.opId);
  assert.equal(harness.app.queue[0].syncError, undefined);
  response.resolve(jsonResponse(serverSnapshot({
    accepted: [{ opId: postedOperation.opId }],
    rejected: [],
    version: 1,
    state: harness.app.state,
  })));
  await harness.app.syncPromise;
  assert.equal(harness.app.queue.length, 0);
});

test('semantically invalid local data remains available as its exact raw recovery payload', async () => {
  const raw = JSON.stringify({
    state: { schemaVersion: 1, reports: 'not-an-array' },
    queue: [],
    settings: { apiBase: '', token: '' },
    clientId: 'client_invalid',
  });
  let fetchCount = 0;
  const harness = createHarness(async () => {
    fetchCount += 1;
    return jsonResponse(serverSnapshot());
  }, { storage: { 'order-report-local-v1': raw } });

  assert.equal(harness.app.recoveryRaw, raw);
  assert.equal(harness.storedRaw(), raw);
  assert.equal(harness.app.state.reports.length, 0);
  await harness.sync();
  assert.equal(fetchCount, 0);
  assert.match(harness.app.syncError, /恢复数据/);
  harness.recoveryExport();
  assert.equal(harness.app.exportText, raw, 'a single-copy export must remain the exact legacy raw payload');
  assert.doesNotMatch(harness.app.exportFilename, /bundle/);
});

test('an invalid persisted recovery collection is quarantined as one exact outer recovery payload', () => {
  const raw = JSON.stringify({
    state: Domain.emptyState(),
    queue: [],
    settings: { apiBase: '', token: '' },
    clientId: 'client_invalid_recovery_collection',
    hasSynced: false,
    lastServerId: '',
    lastServerVersion: null,
    lastServerApiBase: '',
    requiresExplicitDownload: false,
    localRevision: 1,
    storageRevision: 1,
    recoveryRaw: '{"old":true}',
    recoveryRaws: ['{"old":true}', 42],
  });
  const harness = createHarness(async () => jsonResponse(serverSnapshot()), {
    storage: { 'order-report-local-v1': raw },
    keepLoadedSettings: true,
  });

  assert.equal(harness.app.recoveryRaw, raw);
  assert.deepEqual(Array.from(harness.app.recoveryRaws), [raw]);
  assert.equal(harness.storedRaw(), raw);
  assert.match(harness.app.syncError, /恢复副本集合无效/);
});

test('invalid synchronization metadata is quarantined with the original local payload', () => {
  const raw = JSON.stringify({
    state: Domain.emptyState(),
    queue: [],
    settings: { apiBase: 'https://unsafe.example.test', token: 'unsafe-token' },
    clientId: 'client_invalid_metadata',
    hasSynced: 'true',
  });
  const harness = createHarness(async () => jsonResponse(serverSnapshot()), {
    storage: { 'order-report-local-v1': raw },
    keepLoadedSettings: true,
  });

  assert.equal(harness.app.recoveryRaw, raw);
  assert.equal(harness.app.settings.apiBase, '');
  assert.equal(harness.app.settings.token, '');
  assert.match(harness.app.syncError, /同步状态无效/);
});

test('repairable legacy refund amounts are normalized instead of quarantining local data', () => {
  const report = reportOperation('legacy_refund');
  const refund = {
    opId: 'op_legacy_refund_entry',
    clientId: 'client_test',
    type: 'refund.create',
    payload: {
      refund: {
        id: 'refund_legacy_refund',
        reportItemId: 'item_legacy_refund',
        quantity: 1,
        refundedAt: '2026-08-02T10:00',
        note: '',
      },
    },
    createdAt: '2026-08-02T10:00:00.000Z',
  };
  const legacyState = applyOperations([report, refund]);
  legacyState.refunds[0].amountCents = 0;
  const raw = JSON.stringify({
    state: legacyState,
    queue: [],
    settings: { apiBase: '', token: '' },
    clientId: 'client_legacy_refund',
    hasSynced: false,
  });

  const harness = createHarness(async () => jsonResponse(serverSnapshot()), {
    storage: { 'order-report-local-v1': raw },
  });

  assert.equal(harness.app.recoveryRaw, '');
  assert.equal(harness.app.state.refunds[0].amountCents, 100);
});

test('inventory renders the exact remaining cents after a rounded refund', () => {
  const report = reportOperation('inventory_cent');
  report.payload.items[0] = {
    ...report.payload.items[0],
    quantity: 2,
    actualPaymentCents: 1,
    expectedRefundCents: 1,
    expectedRebateCents: 1,
  };
  const refund = {
    opId: 'op_inventory_cent_refund',
    clientId: 'client_test',
    type: 'refund.create',
    payload: {
      refund: {
        id: 'refund_inventory_cent',
        reportItemId: 'item_inventory_cent',
        quantity: 1,
        refundedAt: '2026-08-02T10:00',
        note: '',
      },
    },
    createdAt: '2026-08-02T10:00:00.000Z',
  };
  const harness = createHarness(async () => jsonResponse(serverSnapshot()), { withMain: true });
  harness.app.state = applyOperations([report, refund]);

  harness.navigateView('inventory');
  const html = harness.document.querySelector('#main-content').innerHTML;

  assert.match(html, /可用商品成本[\s\S]{0,120}¥0\.00/);
  assert.match(html, /剩余成本/);
  assert.match(html, /剩余预计收益/);
});

test('legacy synced data without a server identity requires one explicit download before pull', async () => {
  const localOperation = reportOperation('legacy_bound');
  const raw = JSON.stringify({
    state: applyOperations([localOperation]),
    queue: [],
    settings: { apiBase: '', token: '' },
    clientId: 'client_legacy',
    hasSynced: true,
  });
  let fetchCount = 0;
  const harness = createHarness(async () => {
    fetchCount += 1;
    return jsonResponse(serverSnapshot());
  }, { storage: { 'order-report-local-v1': raw } });

  assert.equal(harness.app.requiresExplicitDownload, true);
  assert.equal(harness.app.state.reports.some((row) => row.id === 'report_legacy_bound'), true);
  await harness.sync();
  assert.equal(fetchCount, 0);
  assert.match(harness.app.syncError, /下载并覆盖/);
});

test('legacy synced data with pending work can be explicitly bound before its queue is uploaded', async () => {
  const operation = reportOperation('legacy_pending');
  const raw = JSON.stringify({
    state: applyOperations([operation]),
    queue: [operation],
    settings: { apiBase: '', token: '' },
    clientId: 'client_legacy',
    hasSynced: true,
  });
  const requests = [];
  const harness = createHarness(async (url, options = {}) => {
    requests.push({ method: options.method || 'GET', url });
    if (!options.body) {
      return jsonResponse(serverSnapshot({
        serverId: 'server_legacy_confirmed',
        version: 10,
      }));
    }
    const body = JSON.parse(options.body);
    return jsonResponse(serverSnapshot({
      serverId: 'server_legacy_confirmed',
      accepted: body.operations.map((item) => ({ opId: item.opId })),
      rejected: [],
      version: 11,
      state: applyOperations([operation]),
    }));
  }, { storage: { 'order-report-local-v1': raw } });

  assert.equal(harness.app.queue.length, 1, 'migration must retain the legacy pending queue');
  assert.equal(harness.app.requiresExplicitDownload, true);
  await harness.sync();
  assert.equal(requests.length, 0, 'ordinary sync must not send a legacy queue to an unidentified server');

  harness.bindCurrentServerAndUpload();
  assert.equal(typeof harness.app.confirmation, 'function');
  const confirmBinding = harness.app.confirmation;
  await confirmBinding();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[1].method, 'POST');
  assert.equal(harness.app.lastServerId, 'server_legacy_confirmed');
  assert.equal(harness.app.lastServerVersion, 11);
  assert.equal(harness.app.requiresExplicitDownload, false);
  assert.equal(harness.app.queue.length, 0);
  assert.equal(harness.stored().queue.length, 0);
});

test('legacy binding never uploads when the observed server identity cannot be persisted first', async () => {
  const operation = reportOperation('legacy_persist_failure');
  const requests = [];
  const harness = createHarness(async (url, options = {}) => {
    requests.push({ method: options.method || 'GET', url });
    return jsonResponse(serverSnapshot({ serverId: 'server_uncommitted', version: 4 }));
  });
  harness.app.state = applyOperations([operation]);
  harness.app.queue = [operation];
  harness.app.hasSynced = true;
  harness.app.requiresExplicitDownload = true;
  harness.setStorageWrite(() => { throw new Error('quota exceeded'); });

  await harness.performBindAndUpload();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(harness.app.lastServerId, '');
  assert.equal(harness.app.queue.length, 1);
  assert.equal(harness.app.queue[0].opId, operation.opId);
  assert.match(harness.app.syncError, /quota exceeded/);
});

test('compare-and-swap persistence refuses to overwrite another tab update', () => {
  const harness = createHarness(async () => jsonResponse(serverSnapshot()));
  harness.saveSettings({ apiBase: 'https://sync.example.test', token: 'first-token' });
  const external = JSON.stringify({ ...harness.stored(), storageRevision: 99, clientId: 'client_other_tab' });
  harness.storage.set('order-report-local-v1', external);

  assert.throws(
    () => harness.saveSettings({ apiBase: 'https://sync.example.test', token: 'second-token' }),
    /另一页面更新.*拒绝覆盖/,
  );
  assert.equal(harness.app.settings.token, 'first-token');
  assert.equal(harness.storedRaw(), external);
});

test('a storage event adopts another tab state while this page is idle', () => {
  const operation = reportOperation('other_tab');
  const harness = createHarness(async () => jsonResponse(serverSnapshot()));
  const external = JSON.stringify({
    state: applyOperations([operation]),
    queue: [],
    settings: { apiBase: 'https://other-tab.example.test', token: 'other-token' },
    clientId: 'client_other_tab',
    hasSynced: false,
    lastServerId: '',
    lastServerVersion: null,
    lastServerApiBase: '',
    requiresExplicitDownload: false,
    localRevision: 3,
    storageRevision: 8,
  });
  harness.storage.set('order-report-local-v1', external);

  harness.emitStorage();

  assert.equal(harness.app.state.reports.some((row) => row.id === 'report_other_tab'), true);
  assert.equal(harness.app.settings.apiBase, 'https://other-tab.example.test');
  assert.equal(harness.app.storageRevision, 8);
});

test('simultaneous tab writes preserve one queue and quarantine the other exact payload', () => {
  const sharedStorage = new Map();
  const first = createHarness(async () => jsonResponse(serverSnapshot()), { storageMap: sharedStorage });
  const second = createHarness(async () => jsonResponse(serverSnapshot()), { storageMap: sharedStorage });
  first.app.settings = { apiBase: '', token: '' };
  second.app.settings = { apiBase: '', token: '' };
  let interleaved = false;
  first.setStorageWrite((key, value) => {
    if (!interleaved) {
      interleaved = true;
      second.dispatch('report.create', reportPayload('tab_second'));
    }
    sharedStorage.set(key, String(value));
  });

  first.dispatch('report.create', reportPayload('tab_first'));
  assert.equal(first.app.queue.length, 1);
  assert.equal(second.app.queue.length, 1);
  second.emitStorage();

  assert.equal(second.app.state.reports.some((row) => row.id === 'report_tab_second'), true);
  assert.match(second.app.syncError, /两份数据均已保留/);
  const recovered = JSON.parse(second.app.recoveryRaw);
  assert.equal(recovered.state.reports.some((row) => row.id === 'report_tab_first'), true);
  const stored = second.stored();
  assert.equal(stored.state.reports.some((row) => row.id === 'report_tab_second'), true);
  assert.equal(stored.recoveryRaw, second.app.recoveryRaw);
  assert.equal(stored.storageRevision, 2);
});

test('three independent tab conflicts retain and export every distinct recovery payload without duplicates', () => {
  const current = reportOperation('recovery_primary');
  const initialRaw = JSON.stringify({
    state: applyOperations([current]),
    queue: [current],
    settings: { apiBase: '', token: '' },
    clientId: 'client_recovery_primary',
    hasSynced: false,
    lastServerId: '',
    lastServerVersion: null,
    lastServerApiBase: '',
    requiresExplicitDownload: false,
    localRevision: 8,
    storageRevision: 8,
  });
  const branchRaw = (name) => {
    const operation = reportOperation(name);
    return JSON.stringify({
      state: applyOperations([operation]),
      queue: [operation],
      settings: { apiBase: '', token: '' },
      clientId: `client_${name}`,
      hasSynced: false,
      lastServerId: '',
      lastServerVersion: null,
      lastServerApiBase: '',
      requiresExplicitDownload: false,
      localRevision: 0,
      storageRevision: 0,
    });
  };
  const firstConflict = branchRaw('recovery_branch_b');
  const secondConflict = branchRaw('recovery_branch_c');
  const harness = createHarness(async () => jsonResponse(serverSnapshot()), {
    storage: { 'order-report-local-v1': initialRaw },
    keepLoadedSettings: true,
  });

  for (const raw of [firstConflict, secondConflict, firstConflict]) {
    harness.storage.set('order-report-local-v1', raw);
    harness.emitStorage();
  }

  assert.deepEqual(Array.from(harness.app.recoveryRaws), [firstConflict, secondConflict]);
  assert.equal(harness.app.recoveryRaw, firstConflict, 'the legacy scalar must remain a stable compatible copy');
  const stored = harness.stored();
  assert.deepEqual(stored.recoveryRaws, [firstConflict, secondConflict]);
  assert.equal(stored.recoveryRaw, firstConflict);
  assert.equal(stored.storageRevision, 11);

  harness.recoveryExport();
  const bundle = JSON.parse(harness.app.exportText);
  assert.equal(bundle.format, 'order-report-recovery-bundle-v1');
  assert.equal(bundle.copyCount, 2);
  assert.deepEqual(bundle.copies.map((copy) => copy.raw), [firstConflict, secondConflict]);
  assert.match(harness.app.exportFilename, /recovery-bundle/);
});

test('a higher valid storage revision merges and durably preserves an older scalar recovery copy', () => {
  const current = reportOperation('recovery_scalar_primary');
  const incoming = reportOperation('recovery_higher_adopted');
  const legacyRecoveryRaw = JSON.stringify({ branch: 'legacy scalar recovery' });
  const initialRaw = JSON.stringify({
    state: applyOperations([current]),
    queue: [current],
    settings: { apiBase: '', token: '' },
    clientId: 'client_recovery_scalar_primary',
    hasSynced: false,
    lastServerId: '',
    lastServerVersion: null,
    lastServerApiBase: '',
    requiresExplicitDownload: false,
    localRevision: 8,
    storageRevision: 8,
    recoveryRaw: legacyRecoveryRaw,
  });
  const higherRaw = JSON.stringify({
    state: applyOperations([incoming]),
    queue: [incoming],
    settings: { apiBase: '', token: '' },
    clientId: 'client_recovery_higher_adopted',
    hasSynced: false,
    lastServerId: '',
    lastServerVersion: null,
    lastServerApiBase: '',
    requiresExplicitDownload: false,
    localRevision: 20,
    storageRevision: 20,
  });
  const harness = createHarness(async () => jsonResponse(serverSnapshot()), {
    storage: { 'order-report-local-v1': initialRaw },
    keepLoadedSettings: true,
  });
  assert.deepEqual(Array.from(harness.app.recoveryRaws), [legacyRecoveryRaw]);
  harness.storage.set('order-report-local-v1', higherRaw);

  harness.emitStorage();

  assert.equal(harness.app.state.reports.some((row) => row.id === incoming.payload.report.id), true);
  assert.deepEqual(Array.from(harness.app.recoveryRaws), [legacyRecoveryRaw]);
  assert.equal(harness.app.recoveryRaw, legacyRecoveryRaw);
  const stored = harness.stored();
  assert.deepEqual(stored.recoveryRaws, [legacyRecoveryRaw]);
  assert.equal(stored.recoveryRaw, legacyRecoveryRaw);
  assert.equal(stored.storageRevision, 21);

  harness.recoveryExport();
  assert.equal(harness.app.exportText, legacyRecoveryRaw);
  assert.doesNotMatch(harness.app.exportFilename, /bundle/);
});

test('a quota failure keeps all distinct recovery payloads in memory and reports reload risk', () => {
  const current = reportOperation('recovery_quota_primary');
  const firstConflict = JSON.stringify({ branch: 'first exact recovery' });
  const initialRaw = JSON.stringify({
    state: applyOperations([current]),
    queue: [current],
    settings: { apiBase: '', token: '' },
    clientId: 'client_recovery_quota_primary',
    hasSynced: false,
    lastServerId: '',
    lastServerVersion: null,
    lastServerApiBase: '',
    requiresExplicitDownload: false,
    localRevision: 8,
    storageRevision: 8,
    recoveryRaw: firstConflict,
    recoveryRaws: [firstConflict],
  });
  const secondConflict = JSON.stringify({ branch: 'second exact recovery', storageRevision: 0 });
  const harness = createHarness(async () => jsonResponse(serverSnapshot()), {
    storage: { 'order-report-local-v1': initialRaw },
    keepLoadedSettings: true,
  });
  harness.storage.set('order-report-local-v1', secondConflict);
  harness.setStorageWrite(() => { throw new Error('quota exceeded'); });

  harness.emitStorage();

  assert.deepEqual(Array.from(harness.app.recoveryRaws), [firstConflict, secondConflict]);
  assert.equal(harness.app.recoveryRaw, firstConflict);
  assert.equal(harness.storedRaw(), secondConflict, 'the failed write must not claim durable preservation');
  assert.match(harness.app.syncError, /2 份恢复副本.*仅保留在本页内存.*不要刷新.*quota exceeded/);

  harness.recoveryExport();
  const bundle = JSON.parse(harness.app.exportText);
  assert.deepEqual(bundle.copies.map((copy) => copy.raw), [firstConflict, secondConflict]);

  const higherOperation = reportOperation('recovery_after_quota_higher');
  const higherRecovery = JSON.stringify({ branch: 'higher revision recovery' });
  const higherRaw = JSON.stringify({
    state: applyOperations([higherOperation]),
    queue: [higherOperation],
    settings: { apiBase: '', token: '' },
    clientId: 'client_recovery_after_quota_higher',
    hasSynced: false,
    lastServerId: '',
    lastServerVersion: null,
    lastServerApiBase: '',
    requiresExplicitDownload: false,
    localRevision: 50,
    storageRevision: 50,
    recoveryRaw: higherRecovery,
    recoveryRaws: [higherRecovery],
  });
  harness.storage.set('order-report-local-v1', higherRaw);
  harness.emitStorage();

  assert.equal(harness.app.state.reports.some((row) => row.id === higherOperation.payload.report.id), true);
  assert.deepEqual(
    Array.from(harness.app.recoveryRaws),
    [firstConflict, secondConflict, higherRecovery],
  );
  assert.equal(harness.storedRaw(), higherRaw);
  assert.match(harness.app.syncError, /3 份合并恢复副本.*仅保留在本页内存.*不要刷新.*quota exceeded/);

  harness.recoveryExport();
  const mergedBundle = JSON.parse(harness.app.exportText);
  assert.deepEqual(
    mergedBundle.copies.map((copy) => copy.raw),
    [firstConflict, secondConflict, higherRecovery],
  );
});

for (const [label, incomingRevision] of [['zero', 0], ['missing', undefined]]) {
  test(`a storage event with ${label} revision cannot replace revision 8 and is preserved byte-for-byte`, () => {
    const current = reportOperation(`revision_8_${label}`);
    const stale = reportOperation(`stale_${label}`);
    const initialRaw = JSON.stringify({
      state: applyOperations([current]),
      queue: [current],
      settings: { apiBase: '', token: '' },
      clientId: 'client_current',
      hasSynced: false,
      lastServerId: '',
      lastServerVersion: null,
      lastServerApiBase: '',
      requiresExplicitDownload: false,
      localRevision: 8,
      storageRevision: 8,
    });
    const incoming = {
      state: applyOperations([stale]),
      queue: [stale],
      settings: { apiBase: '', token: '' },
      clientId: 'client_stale',
      hasSynced: false,
      lastServerId: '',
      lastServerVersion: null,
      lastServerApiBase: '',
      requiresExplicitDownload: false,
      localRevision: 0,
    };
    if (incomingRevision !== undefined) incoming.storageRevision = incomingRevision;
    const incomingRaw = JSON.stringify(incoming);
    const harness = createHarness(async () => jsonResponse(serverSnapshot()), {
      storage: { 'order-report-local-v1': initialRaw },
      keepLoadedSettings: true,
    });
    harness.storage.set('order-report-local-v1', incomingRaw);

    harness.emitStorage();

    assert.equal(harness.app.state.reports.some((row) => row.id === current.payload.report.id), true);
    assert.equal(harness.app.state.reports.some((row) => row.id === stale.payload.report.id), false);
    assert.equal(harness.app.queue[0].opId, current.opId);
    assert.equal(harness.app.recoveryRaw, incomingRaw);
    assert.match(harness.app.syncError, /\u5e76\u53d1\u6216\u65e7\u7248\u6570\u636e\u5199\u5165/);
    const stored = harness.stored();
    assert.equal(stored.state.reports.some((row) => row.id === current.payload.report.id), true);
    assert.equal(stored.queue[0].opId, current.opId);
    assert.equal(stored.recoveryRaw, incomingRaw);
    assert.equal(stored.storageRevision, 9);
  });
}

test('quarantining an invalid revision 99 payload advances the retained state to revision 100', () => {
  const current = reportOperation('revision_8_current');
  const initialRaw = JSON.stringify({
    state: applyOperations([current]),
    queue: [current],
    settings: { apiBase: '', token: '' },
    clientId: 'client_current',
    hasSynced: false,
    lastServerId: '',
    lastServerVersion: null,
    lastServerApiBase: '',
    requiresExplicitDownload: false,
    localRevision: 8,
    storageRevision: 8,
  });
  const invalidRaw = JSON.stringify({
    state: { schemaVersion: Domain.SCHEMA_VERSION, reports: 'invalid' },
    queue: [],
    settings: { apiBase: '', token: '' },
    clientId: 'client_invalid_high_revision',
    hasSynced: false,
    lastServerId: '',
    lastServerVersion: null,
    lastServerApiBase: '',
    requiresExplicitDownload: false,
    localRevision: 99,
    storageRevision: 99,
  });
  const harness = createHarness(async () => jsonResponse(serverSnapshot()), {
    storage: { 'order-report-local-v1': initialRaw },
    keepLoadedSettings: true,
  });
  harness.storage.set('order-report-local-v1', invalidRaw);

  harness.emitStorage();

  assert.equal(harness.app.state.reports.some((row) => row.id === current.payload.report.id), true);
  assert.equal(harness.app.queue[0].opId, current.opId);
  assert.equal(harness.app.recoveryRaw, invalidRaw);
  const stored = harness.stored();
  assert.equal(stored.state.reports.some((row) => row.id === current.payload.report.id), true);
  assert.equal(stored.queue[0].opId, current.opId);
  assert.equal(stored.recoveryRaw, invalidRaw);
  assert.equal(stored.storageRevision, 100);
});

test('date-only defaults use the local calendar date around an east-Asia midnight boundary', () => {
  class ShanghaiEarlyDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [ShanghaiEarlyDate.now()]));
    }

    static now() { return Date.parse('2026-09-01T16:30:00.000Z'); }

    getTimezoneOffset() { return -480; }
  }

  const harness = createHarness(async () => jsonResponse(serverSnapshot()), { Date: ShanghaiEarlyDate });

  assert.equal(harness.dateOnlyValue('', true), '2026-09-02');
  assert.equal(harness.dateOnlyValue('', false), '');
  assert.equal(harness.dateOnlyValue('2026-08-31T23:59:00.000Z'), '2026-08-31');
});
