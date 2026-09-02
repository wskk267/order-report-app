const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const Domain = require('../shared/domain');
const { Store, databaseLockPath } = require('../lib/store');
const { restoreBackup } = require('../scripts/restore-sqlite-backup');

let sqlPromise;

function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
    });
  }
  return sqlPromise;
}

async function writeDatabase(filePath, options = {}) {
  const SQL = await getSql();
  const database = new SQL.Database();
  try {
    if (options.missingAppState) {
      database.run('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
    } else if (options.multipleStateRows) {
      database.run(`
        CREATE TABLE app_state (
          id INTEGER PRIMARY KEY,
          version INTEGER,
          updated_at TEXT,
          state_json TEXT
        )
      `);
      database.run(
        'INSERT INTO app_state (id, version, updated_at, state_json) VALUES (?, ?, ?, ?)',
        [1, 1, '2026-08-20T00:00:00.000Z', JSON.stringify({ marker: 'first' })],
      );
      database.run(
        'INSERT INTO app_state (id, version, updated_at, state_json) VALUES (?, ?, ?, ?)',
        [2, 1, '2026-08-20T00:00:00.000Z', JSON.stringify({ marker: 'second' })],
      );
    } else {
      const hasServerId = !options.legacy;
      database.run(`
        CREATE TABLE app_state (
          id INTEGER${options.invalidAppStatePrimaryKey ? '' : ' PRIMARY KEY CHECK (id = 1)'},
          version INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          state_json TEXT NOT NULL${hasServerId ? ',\n          server_id TEXT NOT NULL' : ''}
        )
      `);
      database.run(
        `INSERT INTO app_state (id, version, updated_at, state_json${hasServerId ? ', server_id' : ''}) VALUES (1, ?, ?, ?${hasServerId ? ', ?' : ''})`,
        [
          options.version ?? 1,
          '2026-08-20T00:00:00.000Z',
          options.invalidJson
            ? '{'
            : JSON.stringify(options.incompatibleState
              ? { marker: options.marker || 'default' }
              : {
                ...Domain.emptyState(),
                ...(options.incompatibleRows ? { reportItems: [null] } : {}),
                marker: options.marker || 'default',
              }),
          ...(hasServerId
            ? [options.blankServerId ? '' : (options.serverId || `server-${options.marker || 'default'}`)]
            : []),
        ],
      );
      if (hasServerId && options.syncView) {
        database.run(`
          CREATE VIEW sync_operations AS SELECT
            '' AS op_id, '' AS client_id, '' AS type, '' AS payload_json,
            0 AS ok, NULL AS result_json, NULL AS error,
            '' AS created_at, '' AS applied_at
          WHERE 0
        `);
      } else if (hasServerId && options.malformedSyncTable) {
        database.run('CREATE TABLE sync_operations (op_id TEXT PRIMARY KEY)');
      } else if (hasServerId && !options.missingSyncTable) {
        database.run(`
          CREATE TABLE sync_operations (
            op_id TEXT${options.invalidSyncPrimaryKey ? '' : ' PRIMARY KEY'},
            client_id TEXT NOT NULL,
            type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            ok INTEGER NOT NULL,
            result_json TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            applied_at TEXT NOT NULL
          )
        `);
      }
      if (hasServerId && !options.missingAuditTable) {
        database.run(`
          CREATE TABLE audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            op_id TEXT,
            type TEXT NOT NULL,
            result TEXT NOT NULL,
            details_json TEXT,
            created_at TEXT NOT NULL
          )
        `);
      }
    }
    fs.writeFileSync(filePath, Buffer.from(database.export()), { mode: 0o600 });
  } finally {
    database.close();
  }
}

async function readServerId(filePath) {
  const SQL = await getSql();
  const database = new SQL.Database(fs.readFileSync(filePath));
  try {
    const result = database.exec('SELECT server_id FROM app_state WHERE id = 1');
    return result[0].values[0][0];
  } finally {
    database.close();
  }
}

async function readState(filePath) {
  const SQL = await getSql();
  const database = new SQL.Database(fs.readFileSync(filePath));
  try {
    const result = database.exec('SELECT state_json FROM app_state WHERE id = 1');
    return JSON.parse(result[0].values[0][0]);
  } finally {
    database.close();
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function descriptorIsPath(descriptor, filePath) {
  const descriptorStat = fs.fstatSync(descriptor);
  const pathStat = fs.statSync(filePath);
  return descriptorStat.dev === pathStat.dev && descriptorStat.ino === pathStat.ino;
}

function makeFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-report-restore-'));
  const runtimeDir = path.join(directory, 'runtime');
  const backupDir = path.join(runtimeDir, 'backups');
  const databasePath = path.join(runtimeDir, 'order-report.sqlite3');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, runtimeDir, backupDir, databasePath };
}

function restoreTemporaryFiles(fixture) {
  return fs.readdirSync(fixture.runtimeDir)
    .filter((name) => name.startsWith('order-report.sqlite3.restore-'));
}

function beforeRestoreFiles(fixture) {
  return fs.readdirSync(fixture.runtimeDir)
    .filter((name) => name.startsWith('order-report.sqlite3.before-restore-'));
}

test('restores a validated database atomically and preserves the current database', async (t) => {
  const fixture = makeFixture(t);
  const backupPath = path.join(fixture.backupDir, 'order-report-2026-08-20.sqlite3');
  await writeDatabase(fixture.databasePath, { marker: 'current', version: 3 });
  await writeDatabase(backupPath, { marker: 'backup', version: 4 });
  const backupHash = sha256(backupPath);

  const reservedSnapshot = path.join(
    fixture.runtimeDir,
    'order-report.sqlite3.before-restore-reserved',
  );
  fs.writeFileSync(reservedSnapshot, 'do-not-overwrite', { mode: 0o600 });

  const result = await restoreBackup({
    databasePath: fixture.databasePath,
    inputPath: backupPath,
  });

  assert.equal(result.backupPath, backupPath);
  assert.ok(result.beforeRestorePath);
  assert.equal((await readState(fixture.databasePath)).marker, 'backup');
  assert.equal(await readServerId(fixture.databasePath), 'server-backup');
  assert.equal(sha256(fixture.databasePath), backupHash);
  assert.equal(fs.statSync(fixture.databasePath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(reservedSnapshot, 'utf8'), 'do-not-overwrite');
  assert.equal(restoreTemporaryFiles(fixture).length, 0);

  const snapshots = beforeRestoreFiles(fixture)
    .filter((name) => name !== path.basename(reservedSnapshot));
  assert.equal(snapshots.length, 1);
  const snapshotPath = path.join(fixture.runtimeDir, snapshots[0]);
  assert.equal((await readState(snapshotPath)).marker, 'current');
  assert.equal(await readServerId(snapshotPath), 'server-current');
  assert.equal(fs.statSync(snapshotPath).mode & 0o777, 0o600);
});

test('accepts a legacy state-only backup so Store can migrate it after restore', async (t) => {
  const fixture = makeFixture(t);
  const backupPath = path.join(fixture.backupDir, 'order-report-legacy.sqlite3');
  await writeDatabase(fixture.databasePath, { marker: 'current' });
  await writeDatabase(backupPath, { legacy: true, marker: 'legacy' });

  await restoreBackup({ databasePath: fixture.databasePath, inputPath: backupPath });
  const store = new Store(fixture.databasePath);
  t.after(() => store.close());
  const snapshot = await store.snapshot();

  assert.equal(snapshot.version, 1);
  assert.match(snapshot.serverId, /^[0-9a-f-]{36}$/i);
  assert.equal(snapshot.state.marker, 'legacy');
});

test('rejects a backup path outside the configured backups directory', async (t) => {
  const fixture = makeFixture(t);
  const outsidePath = path.join(fixture.runtimeDir, 'outside.sqlite3');
  await writeDatabase(fixture.databasePath, { marker: 'current' });
  await writeDatabase(outsidePath, { marker: 'outside' });
  const currentHash = sha256(fixture.databasePath);

  await assert.rejects(
    () => restoreBackup({ databasePath: fixture.databasePath, inputPath: outsidePath }),
    /只允许恢复/,
  );
  assert.equal(sha256(fixture.databasePath), currentHash);
  assert.equal(beforeRestoreFiles(fixture).length, 0);
  assert.equal(restoreTemporaryFiles(fixture).length, 0);
});

test('rejects a symbolic-link backup without replacing the current database', async (t) => {
  const fixture = makeFixture(t);
  const outsidePath = path.join(fixture.runtimeDir, 'outside.sqlite3');
  const linkPath = path.join(fixture.backupDir, 'order-report-link.sqlite3');
  await writeDatabase(fixture.databasePath, { marker: 'current' });
  await writeDatabase(outsidePath, { marker: 'outside' });
  fs.symlinkSync(outsidePath, linkPath);
  const currentHash = sha256(fixture.databasePath);

  await assert.rejects(
    () => restoreBackup({ databasePath: fixture.databasePath, inputPath: linkPath }),
    /符号链接/,
  );
  assert.equal(sha256(fixture.databasePath), currentHash);
  assert.equal(beforeRestoreFiles(fixture).length, 0);
  assert.equal(restoreTemporaryFiles(fixture).length, 0);
});

test('rejects a backup directory swapped to a symlink between path check and open', { concurrency: false }, async (t) => {
  const fixture = makeFixture(t);
  const nestedDir = path.join(fixture.backupDir, 'nested');
  const movedDir = path.join(fixture.backupDir, 'nested-original');
  const outsideDir = path.join(fixture.runtimeDir, 'outside-dir');
  const backupPath = path.join(nestedDir, 'candidate.sqlite3');
  fs.mkdirSync(nestedDir, { mode: 0o700 });
  fs.mkdirSync(outsideDir, { mode: 0o700 });
  await writeDatabase(fixture.databasePath, { marker: 'current' });
  await writeDatabase(backupPath, { marker: 'inside' });
  await writeDatabase(path.join(outsideDir, 'candidate.sqlite3'), { marker: 'outside' });
  const currentHash = sha256(fixture.databasePath);
  const originalOpenSync = fs.openSync;
  let swapped = false;
  fs.openSync = (filePath, ...args) => {
    if (!swapped && path.resolve(filePath) === backupPath) {
      swapped = true;
      fs.renameSync(nestedDir, movedDir);
      fs.symlinkSync(outsideDir, nestedDir);
    }
    return originalOpenSync(filePath, ...args);
  };

  try {
    await assert.rejects(
      () => restoreBackup({ databasePath: fixture.databasePath, inputPath: backupPath }),
      /只允许恢复|检查期间发生了变化/,
    );
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(sha256(fixture.databasePath), currentHash);
  assert.equal(beforeRestoreFiles(fixture).length, 0);
  assert.equal(restoreTemporaryFiles(fixture).length, 0);
  assert.equal(fs.existsSync(databaseLockPath(fixture.databasePath)), false);
});

test('rejects corrupt or incompatible SQLite backups before preserving or replacing', async (t) => {
  const fixture = makeFixture(t);
  await writeDatabase(fixture.databasePath, { marker: 'current' });
  const currentHash = sha256(fixture.databasePath);

  const corruptPath = path.join(fixture.backupDir, 'corrupt.sqlite3');
  fs.writeFileSync(
    corruptPath,
    Buffer.concat([Buffer.from('SQLite format 3\u0000'), Buffer.alloc(128)]),
    { mode: 0o600 },
  );
  const missingTablePath = path.join(fixture.backupDir, 'missing-table.sqlite3');
  await writeDatabase(missingTablePath, { missingAppState: true });
  const multipleRowsPath = path.join(fixture.backupDir, 'multiple-rows.sqlite3');
  await writeDatabase(multipleRowsPath, { multipleStateRows: true });
  const invalidJsonPath = path.join(fixture.backupDir, 'invalid-json.sqlite3');
  await writeDatabase(invalidJsonPath, { invalidJson: true });
  const incompatibleStatePath = path.join(fixture.backupDir, 'incompatible-state.sqlite3');
  await writeDatabase(incompatibleStatePath, { incompatibleState: true });
  const incompatibleRowsPath = path.join(fixture.backupDir, 'incompatible-rows.sqlite3');
  await writeDatabase(incompatibleRowsPath, { incompatibleRows: true });
  const blankServerIdPath = path.join(fixture.backupDir, 'blank-server-id.sqlite3');
  await writeDatabase(blankServerIdPath, { blankServerId: true });
  const malformedSyncTablePath = path.join(fixture.backupDir, 'malformed-sync-table.sqlite3');
  await writeDatabase(malformedSyncTablePath, { malformedSyncTable: true });
  const missingSyncTablePath = path.join(fixture.backupDir, 'missing-sync-table.sqlite3');
  await writeDatabase(missingSyncTablePath, { missingSyncTable: true });
  const missingAuditTablePath = path.join(fixture.backupDir, 'missing-audit-table.sqlite3');
  await writeDatabase(missingAuditTablePath, { missingAuditTable: true });
  const unsafeVersionPath = path.join(fixture.backupDir, 'unsafe-version.sqlite3');
  await writeDatabase(unsafeVersionPath, { version: Number.MAX_SAFE_INTEGER + 1 });
  const syncViewPath = path.join(fixture.backupDir, 'sync-view.sqlite3');
  await writeDatabase(syncViewPath, { syncView: true });
  const invalidAppStatePrimaryKeyPath = path.join(fixture.backupDir, 'invalid-app-state-primary-key.sqlite3');
  await writeDatabase(invalidAppStatePrimaryKeyPath, { invalidAppStatePrimaryKey: true });
  const invalidSyncPrimaryKeyPath = path.join(fixture.backupDir, 'invalid-sync-primary-key.sqlite3');
  await writeDatabase(invalidSyncPrimaryKeyPath, { invalidSyncPrimaryKey: true });

  const cases = [
    [corruptPath, /备份校验失败/],
    [missingTablePath, /缺少必需的 app_state 表/],
    [multipleRowsPath, /必须且只能包含 id=1 的一行/],
    [invalidJsonPath, /state_json 不是有效 JSON/],
    [incompatibleStatePath, /不是兼容的报单管家数据/],
    [incompatibleRowsPath, /不是兼容的报单管家数据/],
    [blankServerIdPath, /server_id 无效/],
    [malformedSyncTablePath, /sync_operations 表缺少字段/],
    [missingSyncTablePath, /缺少必需的 sync_operations 表/],
    [missingAuditTablePath, /缺少必需的 audit_log 表/],
    [unsafeVersionPath, /version 无效/],
    [syncViewPath, /sync_operations 必须是数据表/],
    [invalidAppStatePrimaryKeyPath, /app_state 表主键无效/],
    [invalidSyncPrimaryKeyPath, /sync_operations 表主键无效/],
  ];
  for (const [backupPath, errorPattern] of cases) {
    await assert.rejects(
      () => restoreBackup({ databasePath: fixture.databasePath, inputPath: backupPath }),
      errorPattern,
    );
    assert.equal(sha256(fixture.databasePath), currentHash);
    assert.equal(beforeRestoreFiles(fixture).length, 0);
    assert.equal(restoreTemporaryFiles(fixture).length, 0);
    assert.equal(fs.existsSync(databaseLockPath(fixture.databasePath)), false);
  }
});

test('refuses online restore while the service owns the database lock', async (t) => {
  const fixture = makeFixture(t);
  const backupPath = path.join(fixture.backupDir, 'order-report-2026-08-22.sqlite3');
  await writeDatabase(fixture.databasePath, { marker: 'current' });
  await writeDatabase(backupPath, { marker: 'backup' });
  const store = new Store(fixture.databasePath);
  t.after(() => store.close());
  await store.ready;

  await assert.rejects(
    () => restoreBackup({ databasePath: fixture.databasePath, inputPath: backupPath }),
    /数据库正被另一进程使用/,
  );
  assert.equal((await readState(fixture.databasePath)).marker, 'current');

  await store.close();
  const result = await restoreBackup({ databasePath: fixture.databasePath, inputPath: backupPath });
  assert.ok(result.beforeRestorePath);
  assert.equal((await readState(fixture.databasePath)).marker, 'backup');
  assert.equal(fs.existsSync(databaseLockPath(fixture.databasePath)), false);
});

test('retries a transient database lock release failure after restore', { concurrency: false }, async (t) => {
  const fixture = makeFixture(t);
  const backupPath = path.join(fixture.backupDir, 'order-report-2026-08-24.sqlite3');
  await writeDatabase(fixture.databasePath, { marker: 'current' });
  await writeDatabase(backupPath, { marker: 'backup' });
  const lockPath = databaseLockPath(fixture.databasePath);
  const originalUnlinkSync = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (filePath) => {
    if (!injected && path.dirname(path.resolve(filePath)) === lockPath) {
      injected = true;
      const error = new Error('forced transient lock release failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlinkSync(filePath);
  };

  try {
    await restoreBackup({ databasePath: fixture.databasePath, inputPath: backupPath });
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
  assert.equal(injected, true);
  assert.equal((await readState(fixture.databasePath)).marker, 'backup');
  assert.equal(fs.existsSync(lockPath), false);
});

test('reports a persistent post-restore lock failure as an already-published result', { concurrency: false }, async (t) => {
  const fixture = makeFixture(t);
  const backupPath = path.join(fixture.backupDir, 'order-report-2026-08-24-published.sqlite3');
  await writeDatabase(fixture.databasePath, { marker: 'current' });
  await writeDatabase(backupPath, { marker: 'backup' });
  const lockPath = databaseLockPath(fixture.databasePath);
  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = (filePath, ...args) => {
    if (path.dirname(path.resolve(filePath)) === lockPath) {
      const error = new Error('forced persistent lock release failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlinkSync(filePath, ...args);
  };

  try {
    await assert.rejects(
      () => restoreBackup({ databasePath: fixture.databasePath, inputPath: backupPath }),
      (error) => error.code === 'DATABASE_LOCK_RELEASE_FAILED'
        && error.published === true
        && /数据库已恢复/.test(error.message),
    );
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
  assert.equal((await readState(fixture.databasePath)).marker, 'backup');
  assert.equal(fs.existsSync(lockPath), true);
  for (const entry of fs.readdirSync(lockPath)) fs.unlinkSync(path.join(lockPath, entry));
  fs.rmdirSync(lockPath);
});

test('does not hide directory fsync I/O failures before replacement', { concurrency: false }, async (t) => {
  const fixture = makeFixture(t);
  const backupPath = path.join(fixture.backupDir, 'order-report-2026-08-21.sqlite3');
  await writeDatabase(fixture.databasePath, { marker: 'current' });
  await writeDatabase(backupPath, { marker: 'backup' });
  const currentHash = sha256(fixture.databasePath);
  const originalFsyncSync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (descriptor) => {
    if (!injected
      && fs.fstatSync(descriptor).isDirectory()
      && descriptorIsPath(descriptor, fixture.runtimeDir)
      && beforeRestoreFiles(fixture).length === 1
      && sha256(fixture.databasePath) === currentHash) {
      injected = true;
      const error = new Error('forced directory fsync failure before replacement');
      error.code = 'EIO';
      throw error;
    }
    return originalFsyncSync(descriptor);
  };
  try {
    await assert.rejects(
      () => restoreBackup({ databasePath: fixture.databasePath, inputPath: backupPath }),
      /forced directory fsync failure/,
    );
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }

  assert.equal(sha256(fixture.databasePath), currentHash);
  assert.equal(restoreTemporaryFiles(fixture).length, 0);
  assert.equal(beforeRestoreFiles(fixture).length, 1);
  assert.equal(fs.existsSync(databaseLockPath(fixture.databasePath)), false);
});

test('reports post-publish directory fsync failure without rolling back the restored database', { concurrency: false }, async (t) => {
  const fixture = makeFixture(t);
  const backupPath = path.join(fixture.backupDir, 'order-report-2026-08-23.sqlite3');
  await writeDatabase(fixture.databasePath, { marker: 'current', version: 3 });
  await writeDatabase(backupPath, { marker: 'backup', version: 4 });
  const backupHash = sha256(backupPath);
  const originalFsyncSync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (descriptor) => {
    if (!injected
      && fs.fstatSync(descriptor).isDirectory()
      && descriptorIsPath(descriptor, fixture.runtimeDir)
      && sha256(fixture.databasePath) === backupHash) {
      injected = true;
      const error = new Error('forced directory fsync failure after replacement');
      error.code = 'EIO';
      throw error;
    }
    return originalFsyncSync(descriptor);
  };

  let failure;
  try {
    await restoreBackup({ databasePath: fixture.databasePath, inputPath: backupPath });
  } catch (error) {
    failure = error;
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }

  assert.equal(failure?.code, 'RESTORE_PUBLISHED_FSYNC_FAILED');
  assert.equal(failure?.published, true);
  assert.equal(sha256(fixture.databasePath), backupHash);
  assert.equal((await readState(fixture.databasePath)).marker, 'backup');
  assert.equal(beforeRestoreFiles(fixture).length, 1);
  assert.equal(restoreTemporaryFiles(fixture).length, 0);
  assert.equal(fs.existsSync(databaseLockPath(fixture.databasePath)), false);
});
