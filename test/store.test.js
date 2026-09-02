const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const Domain = require('../shared/domain');
const {
  DatabaseLockedError,
  PersistenceError,
  Store,
  databaseLockPath,
} = require('../lib/store');

let sqlPromise;

function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
    });
  }
  return sqlPromise;
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function operation(suffix) {
  return {
    opId: `op_${suffix}`,
    clientId: 'client_test',
    type: 'report.create',
    payload: {
      report: {
        id: `report_${suffix}`,
        occurredAt: '2026-08-01',
        originalMessage: '消息',
      },
      items: [{
        id: `item_${suffix}`,
        productName: `商品${suffix}`,
        quantity: 1,
        actualPaymentCents: 100,
        expectedRefundCents: 20,
        expectedRebateCents: 5,
      }],
    },
    createdAt: Domain.isoNow(),
  };
}

function fixture(t, prefix = 'order-report-store-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stores = [];
  t.after(async () => {
    for (const store of stores.reverse()) await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    dbPath: path.join(directory, 'data.sqlite3'),
    track(store) {
      stores.push(store);
      return store;
    },
  };
}

async function readDatabaseRow(filePath, sql) {
  const SQL = await getSql();
  const database = new SQL.Database(fs.readFileSync(filePath));
  try {
    const result = database.exec(sql);
    if (!result.length || !result[0].values.length) return null;
    return Object.fromEntries(result[0].columns.map((column, index) => [
      column,
      result[0].values[0][index],
    ]));
  } finally {
    database.close();
  }
}

async function writeLegacyDatabase(filePath, state = Domain.emptyState()) {
  const SQL = await getSql();
  const database = new SQL.Database();
  try {
    database.run(`
      CREATE TABLE app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        state_json TEXT NOT NULL
      )
    `);
    database.run(
      'INSERT INTO app_state (id, version, updated_at, state_json) VALUES (1, 0, ?, ?)',
      [Domain.isoNow(), JSON.stringify(state)],
    );
    fs.writeFileSync(filePath, Buffer.from(database.export()), { mode: 0o600 });
  } finally {
    database.close();
  }
}

test('store applies sync operations idempotently and exposes a stable server id', async (t) => {
  const setup = fixture(t);
  const store = setup.track(new Store(setup.dbPath));
  await store.ready;
  const op = operation('same');

  const first = await store.applyOperations([op]);
  const second = await store.applyOperations([op]);
  assert.equal(first.accepted.length, 1);
  assert.equal(second.accepted.length, 1);
  assert.equal(second.accepted[0].opId, op.opId);
  assert.equal(Object.hasOwn(second.accepted[0], 'payload'), false);

  const snapshot = await store.snapshot();
  assert.match(snapshot.serverId, /^[0-9a-f-]{36}$/i);
  assert.equal(first.serverId, snapshot.serverId);
  assert.equal(second.serverId, snapshot.serverId);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.state.reports.length, 1);
});

test('store rejects reuse of an operation id with different content', async (t) => {
  const setup = fixture(t, 'order-report-operation-collision-');
  const store = setup.track(new Store(setup.dbPath));
  await store.ready;
  const original = operation('collision_original');
  const conflicting = {
    ...operation('collision_conflict'),
    opId: original.opId,
    createdAt: original.createdAt,
  };

  const first = await store.applyOperations([original]);
  const collision = await store.applyOperations([conflicting]);

  assert.equal(first.version, 1);
  assert.equal(collision.version, 1);
  assert.deepEqual(collision.accepted, []);
  assert.deepEqual(collision.rejected.map((row) => row.opId), [original.opId]);
  assert.match(collision.rejected[0].error, /不同内容/);
  const snapshot = await store.snapshot();
  assert.deepEqual(snapshot.state.reports.map((row) => row.id), ['report_collision_original']);
});

test('store migrates a legacy database once and preserves server id across reopen and backup', async (t) => {
  const setup = fixture(t, 'order-report-server-id-');
  await writeLegacyDatabase(setup.dbPath);

  const firstStore = setup.track(new Store(setup.dbPath));
  await firstStore.ready;
  const first = await firstStore.snapshot();
  assert.match(first.serverId, /^[0-9a-f-]{36}$/i);
  const backup = await firstStore.backupDaily('2026-08-19');
  await firstStore.close();

  const secondStore = setup.track(new Store(setup.dbPath));
  await secondStore.ready;
  const second = await secondStore.snapshot();
  assert.equal(second.serverId, first.serverId);

  const primaryRow = await readDatabaseRow(
    setup.dbPath,
    'SELECT server_id FROM app_state WHERE id = 1',
  );
  const backupRow = await readDatabaseRow(
    backup.path,
    'SELECT server_id FROM app_state WHERE id = 1',
  );
  assert.equal(primaryRow.server_id, first.serverId);
  assert.equal(backupRow.server_id, first.serverId);
});

test('store rejects an incompatible live state before rewriting the database', async (t) => {
  const setup = fixture(t, 'order-report-invalid-live-state-');
  await writeLegacyDatabase(setup.dbPath, { ...Domain.emptyState(), reports: [{}] });
  const before = fs.readFileSync(setup.dbPath);

  const store = setup.track(new Store(setup.dbPath));
  await assert.rejects(store.ready, /应用状态结构不兼容/);

  assert.deepEqual(fs.readFileSync(setup.dbPath), before);
  assert.equal(fs.existsSync(databaseLockPath(setup.dbPath)), false);
});

test('store rejects synchronization tables without their idempotency primary key', async (t) => {
  const setup = fixture(t, 'order-report-invalid-primary-key-');
  const SQL = await getSql();
  const database = new SQL.Database();
  try {
    database.run(`
      CREATE TABLE app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        state_json TEXT NOT NULL,
        server_id TEXT NOT NULL
      );
      CREATE TABLE sync_operations (
        op_id TEXT,
        client_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        ok INTEGER NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_id TEXT,
        type TEXT NOT NULL,
        result TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      )
    `);
    database.run(
      'INSERT INTO app_state (id, version, updated_at, state_json, server_id) VALUES (1, 0, ?, ?, ?)',
      [Domain.isoNow(), JSON.stringify(Domain.emptyState()), 'server-invalid-primary-key'],
    );
    fs.writeFileSync(setup.dbPath, Buffer.from(database.export()), { mode: 0o600 });
  } finally {
    database.close();
  }
  const before = fs.readFileSync(setup.dbPath);

  const store = setup.track(new Store(setup.dbPath));
  await assert.rejects(store.ready, /sync_operations 表主键无效/);

  assert.deepEqual(fs.readFileSync(setup.dbPath), before);
  assert.equal(fs.existsSync(databaseLockPath(setup.dbPath)), false);
});

test('store owns an exclusive database lock, rejects a second process, and cleans a stale lock', async (t) => {
  const setup = fixture(t, 'order-report-lock-');
  fs.chmodSync(setup.directory, 0o750);
  const first = setup.track(new Store(setup.dbPath));
  await first.ready;
  const lockPath = databaseLockPath(setup.dbPath);
  assert.equal(fs.statSync(setup.directory).mode & 0o777, 0o750);
  assert.equal(fs.statSync(lockPath).isDirectory(), true);
  assert.equal(fs.statSync(lockPath).mode & 0o777, 0o700);
  const firstOwnerPath = path.join(lockPath, fs.readdirSync(lockPath)[0]);
  assert.equal(fs.statSync(firstOwnerPath).mode & 0o777, 0o600);

  const competing = setup.track(new Store(setup.dbPath));
  await assert.rejects(
    competing.ready,
    (error) => error instanceof DatabaseLockedError && error.code === 'DATABASE_LOCKED',
  );

  await first.close();
  assert.equal(fs.existsSync(lockPath), false);
  fs.mkdirSync(lockPath, { mode: 0o700 });
  const staleOwnerPath = path.join(lockPath, `owner-${'0'.repeat(32)}.json`);
  fs.writeFileSync(staleOwnerPath, JSON.stringify({
    pid: 2_000_000_000,
    processStartToken: 'stale',
    purpose: 'crashed-test',
    token: 'stale-token',
  }), { mode: 0o600 });

  const recovered = setup.track(new Store(setup.dbPath));
  await recovered.ready;
  const recoveredOwnerPath = path.join(lockPath, fs.readdirSync(lockPath)[0]);
  const owner = JSON.parse(fs.readFileSync(recoveredOwnerPath, 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.token, 'stale-token');
  await recovered.close();
  assert.equal(fs.existsSync(lockPath), false);
});

test('lock acquisition detects replacement during owner initialization', { concurrency: false }, (t) => {
  const setup = fixture(t, 'order-report-lock-replacement-');
  const lockPath = databaseLockPath(setup.dbPath);
  const originalOpenSync = fs.openSync;
  let injected = false;
  let competingLock = null;
  const interceptedOpen = (filePath, ...args) => {
    if (!injected && path.dirname(path.resolve(filePath)) === lockPath
      && path.basename(filePath).startsWith('owner-')) {
      injected = true;
      fs.openSync = originalOpenSync;
      fs.rmdirSync(lockPath);
      competingLock = require('../lib/store').acquireDatabaseLock(setup.dbPath, 'replacement-test');
      fs.openSync = interceptedOpen;
    }
    return originalOpenSync(filePath, ...args);
  };
  fs.openSync = interceptedOpen;
  try {
    assert.throws(
      () => require('../lib/store').acquireDatabaseLock(setup.dbPath, 'replaced-test'),
      /初始化期间被替换/,
    );
  } finally {
    fs.openSync = originalOpenSync;
  }

  assert.ok(competingLock);
  assert.deepEqual(fs.readdirSync(lockPath), [path.basename(competingLock.ownerPath)]);
  const released = competingLock.release();
  assert.equal(released.released, true);
  assert.equal(released.durable, true);
});

test('a transient process-start lookup failure never reclaims a live owner lock', { concurrency: false }, async (t) => {
  const setup = fixture(t, 'order-report-lock-proc-read-');
  const first = setup.track(new Store(setup.dbPath));
  await first.ready;
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (filePath, ...args) => {
    if (String(filePath) === `/proc/${process.pid}/stat`) {
      const error = new Error('forced transient proc failure');
      error.code = 'EIO';
      throw error;
    }
    return originalReadFileSync(filePath, ...args);
  };
  try {
    const competing = setup.track(new Store(setup.dbPath));
    await assert.rejects(competing.ready, /数据库正被另一进程使用/);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test('store rolls the current-day backup forward after every successful write', async (t) => {
  const setup = fixture(t, 'order-report-backup-');
  const store = setup.track(new Store(setup.dbPath));
  await store.ready;
  const dateKey = localDateKey();
  const backupDirectory = path.join(setup.directory, 'backups');
  fs.mkdirSync(backupDirectory, { mode: 0o750 });

  const first = await store.backupDaily(dateKey);
  assert.equal(first.created, true);
  assert.equal(first.updated, false);
  assert.equal(first.path, path.join(setup.directory, 'backups', `order-report-${dateKey}.sqlite3`));
  assert.equal(fs.statSync(backupDirectory).mode & 0o777, 0o750);
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
  const initial = await readDatabaseRow(first.path, 'SELECT version, server_id FROM app_state');
  assert.equal(initial.version, 0);

  await store.applyOperations([operation('rolling_backup')]);
  const refreshed = await readDatabaseRow(first.path, 'SELECT version, server_id FROM app_state');
  assert.equal(refreshed.version, 1);
  assert.equal(refreshed.server_id, initial.server_id);

  const unchanged = await store.backupDaily(dateKey);
  assert.equal(unchanged.created, false);
  assert.equal(unchanged.updated, false);
});

test('store preserves a corrupt daily backup and reuses one valid same-day replacement', async (t) => {
  const setup = fixture(t, 'order-report-corrupt-backup-');
  const store = setup.track(new Store(setup.dbPath));
  await store.ready;
  const dateKey = '2026-08-20';
  const backup = await store.backupDaily(dateKey);
  const corruptBytes = Buffer.from('not a sqlite database');
  fs.writeFileSync(backup.path, corruptBytes);

  const symlinkPath = path.join(
    setup.directory,
    'backups',
    `order-report-${dateKey}.recovered-${'0'.repeat(16)}.sqlite3`,
  );
  fs.symlinkSync(setup.dbPath, symlinkPath);

  const recovered = await store.backupDaily(dateKey);
  assert.equal(recovered.created, true);
  assert.equal(recovered.updated, false);
  assert.notEqual(recovered.path, backup.path);
  assert.notEqual(recovered.path, symlinkPath);
  assert.match(
    path.basename(recovered.path),
    new RegExp(`^order-report-${dateKey}\\.recovered-[0-9a-f]{16}\\.sqlite3$`),
  );
  assert.deepEqual(fs.readFileSync(backup.path), corruptBytes);
  assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(recovered.path).isSymbolicLink(), false);
  assert.equal(fs.statSync(recovered.path).mode & 0o777, 0o600);
  assert.equal((await readDatabaseRow(recovered.path, 'SELECT version FROM app_state')).version, 0);

  const sameDayNames = () => fs.readdirSync(path.join(setup.directory, 'backups'))
    .filter((name) => name.startsWith(`order-report-${dateKey}`))
    .sort();
  const initialNames = sameDayNames();
  const unchanged = await store.backupDaily(dateKey);
  assert.equal(unchanged.created, false);
  assert.equal(unchanged.updated, false);
  assert.equal(unchanged.path, recovered.path);
  assert.deepEqual(sameDayNames(), initialNames);

  await store.applyOperations([operation('recovered_backup_roll')]);
  const rolled = await store.backupDaily(dateKey);
  assert.equal(rolled.created, false);
  assert.equal(rolled.updated, true);
  assert.equal(rolled.path, recovered.path);
  assert.equal((await readDatabaseRow(rolled.path, 'SELECT version FROM app_state')).version, 1);
  assert.deepEqual(fs.readFileSync(backup.path), corruptBytes);
  assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
  assert.deepEqual(sameDayNames(), initialNames);

  const finalUnchanged = await store.backupDaily(dateKey);
  assert.equal(finalUnchanged.created, false);
  assert.equal(finalUnchanged.updated, false);
  assert.equal(finalUnchanged.path, recovered.path);
  assert.deepEqual(sameDayNames(), initialNames);
});

test('store refuses to publish backups through a symbolic-link directory', async (t) => {
  const setup = fixture(t, 'order-report-backup-directory-link-');
  const store = setup.track(new Store(setup.dbPath));
  await store.ready;
  const outsideDirectory = path.join(setup.directory, 'outside-backups');
  fs.mkdirSync(outsideDirectory);
  fs.symlinkSync(outsideDirectory, path.join(setup.directory, 'backups'));

  await assert.rejects(store.backupDaily('2026-08-21'), /备份目录必须是常规目录/);
  assert.deepEqual(fs.readdirSync(outsideDirectory), []);
});

test('store stops a causal batch after the first rejection and leaves later operations unprocessed', async (t) => {
  const setup = fixture(t, 'order-report-causal-');
  const store = setup.track(new Store(setup.dbPath));
  await store.ready;
  const first = operation('causal_first');
  const rejected = {
    ...operation('causal_rejected'),
    type: 'unsupported.operation',
  };
  const later = operation('causal_later');

  const result = await store.applyOperations([first, rejected, later]);
  assert.deepEqual(result.accepted.map((row) => row.opId), [first.opId]);
  assert.deepEqual(result.rejected.map((row) => row.opId), [rejected.opId]);
  assert.deepEqual(result.unprocessed, [{ opId: later.opId }]);
  assert.equal(result.version, 1);

  const snapshot = await store.snapshot();
  assert.deepEqual(snapshot.state.reports.map((row) => row.id), ['report_causal_first']);
  const operationCount = await readDatabaseRow(
    setup.dbPath,
    'SELECT COUNT(*) AS count FROM sync_operations',
  );
  assert.equal(operationCount.count, 2);

  const retried = await store.applyOperations([later]);
  assert.deepEqual(retried.accepted.map((row) => row.opId), [later.opId]);
  assert.equal((await store.snapshot()).version, 2);
});

test('store rejects version overflow while preserving reads and operation replay', async (t) => {
  const setup = fixture(t, 'order-report-version-limit-');
  const acceptedOperation = operation('before_version_limit');
  const initialStore = setup.track(new Store(setup.dbPath));
  await initialStore.ready;
  await initialStore.applyOperations([acceptedOperation]);
  await initialStore.close();

  const SQL = await getSql();
  const database = new SQL.Database(fs.readFileSync(setup.dbPath));
  try {
    database.run('UPDATE app_state SET version = ? WHERE id = 1', [Number.MAX_SAFE_INTEGER]);
    fs.writeFileSync(setup.dbPath, Buffer.from(database.export()), { mode: 0o600 });
  } finally {
    database.close();
  }

  const cappedStore = setup.track(new Store(setup.dbPath));
  await cappedStore.ready;
  const newOperation = operation('at_version_limit');
  const result = await cappedStore.applyOperations([acceptedOperation, newOperation]);

  assert.deepEqual(result.accepted.map((row) => row.opId), [acceptedOperation.opId]);
  assert.deepEqual(result.rejected.map((row) => row.opId), [newOperation.opId]);
  assert.match(result.rejected[0].error, /安全整数上限/);
  assert.equal(result.version, Number.MAX_SAFE_INTEGER);
  assert.equal((await cappedStore.snapshot()).version, Number.MAX_SAFE_INTEGER);
  assert.equal(
    (await readDatabaseRow(setup.dbPath, 'SELECT version FROM app_state WHERE id = 1')).version,
    Number.MAX_SAFE_INTEGER,
  );

  const replay = await cappedStore.applyOperations([newOperation]);
  assert.deepEqual(replay.rejected.map((row) => row.opId), [newOperation.opId]);
  assert.match(replay.rejected[0].error, /安全整数上限/);
  assert.equal(replay.version, Number.MAX_SAFE_INTEGER);
});

test('store rolls back the whole sync batch when recording fails unexpectedly', async (t) => {
  const setup = fixture(t, 'order-report-rollback-');
  const store = setup.track(new Store(setup.dbPath));
  await store.ready;
  const valid = operation('transaction_valid');
  const circularPayload = {
    report: { id: 'report_transaction_bad', occurredAt: '2026-08-02', originalMessage: '' },
    items: [{
      id: 'item_transaction_bad',
      productName: '商品二',
      quantity: 1,
      actualPaymentCents: 100,
      expectedRefundCents: 20,
      expectedRebateCents: 0,
    }],
  };
  circularPayload.circular = circularPayload;
  const invalid = {
    opId: 'op_transaction_bad',
    clientId: 'client_test',
    type: 'report.create',
    payload: circularPayload,
    createdAt: Domain.isoNow(),
  };

  await assert.rejects(store.applyOperations([valid, invalid]), /circular/i);
  let snapshot = await store.snapshot();
  assert.equal(snapshot.version, 0);
  assert.equal(snapshot.state.reports.length, 0);

  const retried = await store.applyOperations([valid]);
  assert.equal(retried.accepted.length, 1);
  snapshot = await store.snapshot();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.state.reports.length, 1);
});

test('a pre-publish persistence failure leaves both memory and disk unchanged', { concurrency: false }, async (t) => {
  const setup = fixture(t, 'order-report-pre-publish-');
  const store = setup.track(new Store(setup.dbPath));
  await store.ready;
  const originalRenameSync = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, destination) => {
    if (!injected && path.resolve(destination) === setup.dbPath
      && source.startsWith(`${setup.dbPath}.tmp-`)) {
      injected = true;
      const error = new Error('forced rename failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRenameSync(source, destination);
  };

  let failure;
  try {
    await store.applyOperations([operation('pre_publish')]);
  } catch (error) {
    failure = error;
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.ok(failure instanceof PersistenceError);
  assert.equal(failure.published, false);
  assert.equal((await store.snapshot()).version, 0);
  assert.equal((await readDatabaseRow(setup.dbPath, 'SELECT version FROM app_state')).version, 0);

  const retry = await store.applyOperations([operation('pre_publish')]);
  assert.equal(retry.version, 1);
});

test('a post-publish directory fsync failure keeps memory aligned with the published database', { concurrency: false }, async (t) => {
  const setup = fixture(t, 'order-report-post-publish-');
  const store = setup.track(new Store(setup.dbPath));
  await store.ready;
  const postPublishOperation = operation('post_publish');
  const originalFsyncSync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (descriptor) => {
    if (!injected && fs.fstatSync(descriptor).isDirectory()) {
      injected = true;
      const error = new Error('forced directory fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalFsyncSync(descriptor);
  };

  let failure;
  try {
    await store.applyOperations([postPublishOperation]);
  } catch (error) {
    failure = error;
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }
  assert.ok(failure instanceof PersistenceError);
  assert.equal(failure.published, true);
  assert.equal((await store.snapshot()).version, 1);
  assert.equal((await readDatabaseRow(setup.dbPath, 'SELECT version FROM app_state')).version, 1);

  const retry = await store.applyOperations([postPublishOperation]);
  assert.equal(retry.version, 1);
  assert.deepEqual(retry.accepted.map((row) => row.opId), ['op_post_publish']);
});

test('Store.close can retry a transient lock release failure', { concurrency: false }, async (t) => {
  const setup = fixture(t, 'order-report-lock-release-');
  const store = setup.track(new Store(setup.dbPath));
  await store.ready;
  const ownerPath = store.lock.ownerPath;
  const lockPath = databaseLockPath(setup.dbPath);
  const originalUnlinkSync = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (filePath) => {
    if (!injected && path.resolve(filePath) === ownerPath) {
      injected = true;
      const error = new Error('forced lock unlink failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlinkSync(filePath);
  };

  let firstClose;
  try {
    firstClose = await store.close();
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
  assert.equal(firstClose.released, false);
  assert.match(firstClose.error.message, /forced lock unlink failure/);
  assert.equal(fs.existsSync(lockPath), true);

  const secondClose = await store.close();
  assert.equal(secondClose.released, true);
  assert.equal(secondClose.durable, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('overlapping Store.close calls wait for queued writes before releasing the lock', async (t) => {
  const setup = fixture(t, 'order-report-close-overlap-');
  const store = setup.track(new Store(setup.dbPath));
  await store.ready;
  let releaseWrite;
  let markWriteStarted;
  const writeStarted = new Promise((resolve) => { markWriteStarted = resolve; });
  const writeBlocker = new Promise((resolve) => { releaseWrite = resolve; });
  const writing = store.write(async () => {
    markWriteStarted();
    await writeBlocker;
  });
  await writeStarted;

  const firstClose = store.close();
  const secondClose = store.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(databaseLockPath(setup.dbPath)), true);
  const competing = setup.track(new Store(setup.dbPath));
  await assert.rejects(competing.ready, /数据库正被另一进程使用/);

  releaseWrite();
  await writing;
  await Promise.all([firstClose, secondClose]);
  assert.equal(fs.existsSync(databaseLockPath(setup.dbPath)), false);
});

test('Store.close can retry lock-directory durability after namespace release', { concurrency: false }, async (t) => {
  const setup = fixture(t, 'order-report-lock-release-fsync-');
  const store = setup.track(new Store(setup.dbPath));
  await store.ready;
  const lockPath = databaseLockPath(setup.dbPath);
  const directoryStat = fs.statSync(setup.directory);
  const originalFsyncSync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (descriptor) => {
    const descriptorStat = fs.fstatSync(descriptor);
    if (!injected && descriptorStat.isDirectory()
      && descriptorStat.dev === directoryStat.dev && descriptorStat.ino === directoryStat.ino) {
      injected = true;
      const error = new Error('forced lock directory fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalFsyncSync(descriptor);
  };

  let firstClose;
  try {
    firstClose = await store.close();
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }
  assert.equal(firstClose.released, true);
  assert.equal(firstClose.durable, false);
  assert.match(firstClose.error.message, /forced lock directory fsync failure/);
  assert.equal(fs.existsSync(lockPath), false);

  const secondClose = await store.close();
  assert.equal(secondClose.released, true);
  assert.equal(secondClose.durable, true);
  assert.equal(store.lock, null);
});

test('store does not hide directory fsync I/O failures during lock initialization', { concurrency: false }, async (t) => {
  const setup = fixture(t, 'order-report-fsync-');
  const originalFsyncSync = fs.fsyncSync;
  fs.fsyncSync = (descriptor) => {
    if (fs.fstatSync(descriptor).isDirectory()) {
      const error = new Error('forced directory fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalFsyncSync(descriptor);
  };
  try {
    const store = setup.track(new Store(setup.dbPath));
    await assert.rejects(store.ready, /forced directory fsync failure/);
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }
  assert.equal(fs.existsSync(databaseLockPath(setup.dbPath)), false);
});
