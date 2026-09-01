const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const Domain = require('../shared/domain');
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
          id INTEGER,
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
      database.run(`
        CREATE TABLE app_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          state_json TEXT NOT NULL
        )
      `);
      database.run(
        'INSERT INTO app_state (id, version, updated_at, state_json) VALUES (1, ?, ?, ?)',
        [
          options.version || 1,
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
        ],
      );
    }
    fs.writeFileSync(filePath, Buffer.from(database.export()), { mode: 0o600 });
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
  assert.equal(sha256(fixture.databasePath), backupHash);
  assert.equal(fs.statSync(fixture.databasePath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(reservedSnapshot, 'utf8'), 'do-not-overwrite');
  assert.equal(restoreTemporaryFiles(fixture).length, 0);

  const snapshots = beforeRestoreFiles(fixture)
    .filter((name) => name !== path.basename(reservedSnapshot));
  assert.equal(snapshots.length, 1);
  const snapshotPath = path.join(fixture.runtimeDir, snapshots[0]);
  assert.equal((await readState(snapshotPath)).marker, 'current');
  assert.equal(fs.statSync(snapshotPath).mode & 0o777, 0o600);
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

  const cases = [
    [corruptPath, /备份校验失败/],
    [missingTablePath, /缺少必需的 app_state 表/],
    [multipleRowsPath, /必须且只能包含 id=1 的一行/],
    [invalidJsonPath, /state_json 不是有效 JSON/],
    [incompatibleStatePath, /不是兼容的报单管家数据/],
    [incompatibleRowsPath, /不是兼容的报单管家数据/],
  ];
  for (const [backupPath, errorPattern] of cases) {
    await assert.rejects(
      () => restoreBackup({ databasePath: fixture.databasePath, inputPath: backupPath }),
      errorPattern,
    );
    assert.equal(sha256(fixture.databasePath), currentHash);
    assert.equal(beforeRestoreFiles(fixture).length, 0);
    assert.equal(restoreTemporaryFiles(fixture).length, 0);
  }
});

test('does not hide directory fsync I/O failures before replacement', { concurrency: false }, async (t) => {
  const fixture = makeFixture(t);
  const backupPath = path.join(fixture.backupDir, 'order-report-2026-08-21.sqlite3');
  await writeDatabase(fixture.databasePath, { marker: 'current' });
  await writeDatabase(backupPath, { marker: 'backup' });
  const currentHash = sha256(fixture.databasePath);
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
});
