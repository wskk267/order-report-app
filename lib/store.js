const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const Domain = require('../shared/domain');

function rowsFromResult(result) {
  if (!result || result.length === 0) return [];
  const [{ columns, values }] = result;
  return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

function json(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function canonicalJson(value) {
  const ancestors = new Set();
  const normalize = (input) => {
    if (!input || typeof input !== 'object') return input;
    if (ancestors.has(input)) throw new TypeError('Converting circular structure to JSON');
    ancestors.add(input);
    let normalized;
    if (Array.isArray(input)) {
      normalized = input.map((item) => normalize(item));
    } else {
      normalized = {};
      for (const key of Object.keys(input).sort()) {
        if (input[key] !== undefined) normalized[key] = normalize(input[key]);
      }
    }
    ancestors.delete(input);
    return normalized;
  };
  return JSON.stringify(normalize(value));
}

function isRestorableStateSnapshot(value) {
  if (Domain.isStateSnapshot(value)) return true;
  const requiredCollections = Object.keys(Domain.emptyState())
    .filter((key) => Array.isArray(Domain.emptyState()[key]));
  if (!value || typeof value !== 'object' || value.schemaVersion !== Domain.SCHEMA_VERSION
    || !requiredCollections.every((key) => Array.isArray(value[key]))) return false;
  try {
    return Domain.isStateSnapshot(Domain.normalizeState(value));
  } catch {
    return false;
  }
}

const TABLE_COLUMNS = {
  app_state: ['id', 'version', 'updated_at', 'state_json', 'server_id'],
  sync_operations: ['op_id', 'client_id', 'type', 'payload_json', 'ok', 'result_json', 'error', 'created_at', 'applied_at'],
  audit_log: ['id', 'op_id', 'type', 'result', 'details_json', 'created_at'],
};

const TABLE_PRIMARY_KEYS = {
  app_state: ['id'],
  sync_operations: ['op_id'],
  audit_log: ['id'],
};

function assertTableColumns(database, tableName, requiredColumns, required = true) {
  if (!/^[a-z_]+$/.test(tableName)) throw new Error('数据库表名无效');
  const objects = rowsFromResult(database.exec(
    `SELECT type FROM sqlite_schema WHERE name = '${tableName}'`,
  ));
  if (objects.length && (objects.length !== 1 || objects[0].type !== 'table')) {
    throw new Error(`${tableName} 必须是数据表`);
  }
  const columns = rowsFromResult(database.exec(`PRAGMA table_info(${tableName})`));
  if (!columns.length) {
    if (required) throw new Error(`数据库缺少必需的 ${tableName} 表`);
    return;
  }
  const names = new Set(columns.map((column) => column.name));
  const missing = requiredColumns.filter((column) => !names.has(column));
  if (missing.length) throw new Error(`${tableName} 表缺少字段：${missing.join(', ')}`);
  const primaryKey = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);
  if (JSON.stringify(primaryKey) !== JSON.stringify(TABLE_PRIMARY_KEYS[tableName])) {
    throw new Error(`${tableName} 表主键无效`);
  }
}

function operationShapeError(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return '操作记录必须是对象';
  if (typeof operation.opId !== 'string' || !operation.opId.trim()) return '操作缺少有效 opId';
  if (typeof operation.type !== 'string' || !operation.type.trim()) return '操作缺少有效 type';
  if (typeof operation.clientId !== 'string' || !operation.clientId.trim()) return '操作缺少有效 clientId';
  if (!operation.payload || typeof operation.payload !== 'object' || Array.isArray(operation.payload)) return '操作 payload 必须是对象';
  if (typeof operation.createdAt !== 'string' || !operation.createdAt.trim()) return '操作缺少有效 createdAt';
  return '';
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function fsyncDirectory(directoryPath) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    const unsupported = ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR'].includes(error.code)
      || (process.platform === 'win32' && error.code === 'EPERM');
    if (!unsupported) throw error;
  } finally {
    if (descriptor !== null) try { fs.closeSync(descriptor); } catch {}
  }
}

function ensurePrivateDirectory(directoryPath) {
  const createdPath = fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  if (createdPath !== undefined) fs.chmodSync(directoryPath, 0o700);
}

const LOCK_INITIALIZATION_GRACE_MS = 30_000;

class PersistenceError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'PersistenceError';
    this.code = 'PERSISTENCE_FAILED';
    this.published = Boolean(options.published);
  }
}

class DatabaseLockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatabaseLockedError';
    this.code = 'DATABASE_LOCKED';
  }
}

function databaseLockPath(dbPath) {
  return `${path.resolve(dbPath)}.lock`;
}

function processStartToken(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    return fields[19] || null;
  } catch {
    return null;
  }
}

function processIsAlive(owner) {
  const pid = Number(owner?.pid);
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    return true;
  }
  if (owner.processStartToken && process.platform === 'linux') {
    const currentStartToken = processStartToken(pid);
    // A transient /proc read failure must not make a live process look stale.
    return currentStartToken === null || currentStartToken === owner.processStartToken;
  }
  return true;
}

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function readLockFile(lockPath) {
  const metadata = fs.lstatSync(lockPath);
  if (metadata.isSymbolicLink()) return { metadata, owner: null, kind: 'invalid' };
  if (metadata.isFile()) {
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch {}
    return { metadata, owner, kind: 'legacy-file' };
  }

  if (!metadata.isDirectory()) return { metadata, owner: null, kind: 'invalid' };
  let entries;
  try { entries = fs.readdirSync(lockPath); } catch { entries = []; }
  if (entries.length !== 1 || !/^owner-[0-9a-f]{32}\.json$/.test(entries[0])) {
    return { metadata, owner: null, kind: 'directory' };
  }
  const ownerPath = path.join(lockPath, entries[0]);
  let ownerMetadata;
  let owner = null;
  try {
    ownerMetadata = fs.lstatSync(ownerPath);
    if (!ownerMetadata.isSymbolicLink() && ownerMetadata.isFile()) {
      owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    }
  } catch {}
  return {
    metadata,
    owner,
    ownerMetadata,
    ownerPath,
    kind: 'directory',
  };
}

function staleLockCanBeRemoved(lock) {
  if (lock.owner) return !processIsAlive(lock.owner);
  return Date.now() - lock.metadata.mtimeMs >= LOCK_INITIALIZATION_GRACE_MS;
}

function removeObservedStaleLock(lockPath, observed) {
  let current;
  try {
    current = fs.lstatSync(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  if (!sameFile(current, observed.metadata)) return false;

  if (observed.kind === 'directory') {
    if (observed.ownerPath && observed.ownerMetadata) {
      try {
        const currentOwner = fs.lstatSync(observed.ownerPath);
        if (!sameFile(currentOwner, observed.ownerMetadata)) return false;
        fs.unlinkSync(observed.ownerPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    try {
      fs.rmdirSync(lockPath);
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') return false;
      throw error;
    }
  } else {
    // Compatibility cleanup for the earlier single-file lock format.
    fs.unlinkSync(lockPath);
  }
  fsyncDirectory(path.dirname(lockPath));
  return true;
}

function cleanupIncompleteLock(lockPath, ownerPath, descriptor, expectedLockMetadata) {
  let openedOwnerMetadata = null;
  if (descriptor !== null) {
    try { openedOwnerMetadata = fs.fstatSync(descriptor); } catch {}
    try { fs.closeSync(descriptor); } catch {}
  }
  if (ownerPath && openedOwnerMetadata) {
    try {
      const currentOwnerMetadata = fs.lstatSync(ownerPath);
      if (sameFile(currentOwnerMetadata, openedOwnerMetadata)) fs.unlinkSync(ownerPath);
    } catch {}
  }
  if (expectedLockMetadata) {
    try {
      const currentLockMetadata = fs.lstatSync(lockPath);
      if (sameFile(currentLockMetadata, expectedLockMetadata)) fs.rmdirSync(lockPath);
    } catch {}
  }
  try { fsyncDirectory(path.dirname(lockPath)); } catch {}
}

function acquireDatabaseLock(dbPath, purpose = 'service') {
  const lockPath = databaseLockPath(dbPath);
  const lockDirectory = path.dirname(lockPath);
  ensurePrivateDirectory(lockDirectory);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = crypto.randomBytes(16).toString('hex');
    const ownerPath = path.join(lockPath, `owner-${token}.json`);
    let descriptor = null;
    let createdLockDirectory = false;
    let createdLockMetadata = null;
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      createdLockDirectory = true;
      createdLockMetadata = fs.lstatSync(lockPath);
      fs.chmodSync(lockPath, 0o700);
      descriptor = fs.openSync(ownerPath, 'wx', 0o600);
      const owner = {
        pid: process.pid,
        processStartToken: processStartToken(process.pid),
        purpose,
        token,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
      fsyncDirectory(lockPath);
      fsyncDirectory(lockDirectory);
      const currentLockMetadata = fs.lstatSync(lockPath);
      const currentOwnerMetadata = fs.lstatSync(ownerPath);
      const openedOwnerMetadata = fs.fstatSync(descriptor);
      const entries = fs.readdirSync(lockPath);
      if (!sameFile(currentLockMetadata, createdLockMetadata)
        || !sameFile(currentOwnerMetadata, openedOwnerMetadata)
        || entries.length !== 1 || entries[0] !== path.basename(ownerPath)) {
        throw new DatabaseLockedError('数据库锁在初始化期间被替换，请重试');
      }

      let released = false;
      let durable = false;
      let ownershipLost = false;
      let ownerMarkerRemoved = false;
      return {
        path: lockPath,
        ownerPath,
        owner,
        release() {
          if (ownershipLost) {
            return { released: false, durable: true, ownershipLost: true };
          }
          if (released && durable) return { released: true, durable: true };
          if (released) {
            try {
              fsyncDirectory(lockDirectory);
              durable = true;
              return { released: true, durable: true };
            } catch (error) {
              return { released: true, durable: false, error };
            }
          }
          try {
            if (!ownerMarkerRemoved) {
              let currentOwner = null;
              try { currentOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')); } catch (error) {
                if (error.code !== 'ENOENT') throw error;
              }
              if (currentOwner && currentOwner.token !== token) {
                ownershipLost = true;
                return { released: false, durable: true, ownershipLost: true };
              }
              if (currentOwner) fs.unlinkSync(ownerPath);
              ownerMarkerRemoved = true;
            }
            try {
              fs.rmdirSync(lockPath);
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
            released = true;
            try {
              fsyncDirectory(lockDirectory);
              durable = true;
              return { released: true, durable: true };
            } catch (error) {
              return { released: true, durable: false, error };
            }
          } catch (error) {
            return { released: false, durable: false, error };
          } finally {
            if ((released || ownershipLost) && descriptor !== null) {
              try { fs.closeSync(descriptor); } catch {}
              descriptor = null;
            }
          }
        },
      };
    } catch (error) {
      if (createdLockDirectory) {
        cleanupIncompleteLock(lockPath, ownerPath, descriptor, createdLockMetadata);
        throw error;
      }
      if (error.code !== 'EEXIST') throw error;

      let existing;
      try {
        existing = readLockFile(lockPath);
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        throw readError;
      }
      if (!staleLockCanBeRemoved(existing)) {
        const ownerText = existing.owner?.pid ? `（PID ${existing.owner.pid}）` : '';
        throw new DatabaseLockedError(`数据库正被另一进程使用${ownerText}`);
      }
      if (!removeObservedStaleLock(lockPath, existing)) continue;
    }
  }
  throw new DatabaseLockedError('数据库锁竞争过于频繁，请稍后重试');
}

class Store {
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    this.backupDir = path.join(path.dirname(this.dbPath), 'backups');
    this.queue = Promise.resolve();
    this.lock = null;
    this.closed = false;
    this.closePreparation = null;
    this.lastBackupError = null;
    this.ready = this.initialize();
  }

  async initialize() {
    const databaseDirectory = path.dirname(this.dbPath);
    ensurePrivateDirectory(databaseDirectory);
    this.lock = acquireDatabaseLock(this.dbPath, 'service');
    try {
      const SQL = await initSqlJs({
        locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
      });
      this.SQL = SQL;
      const bytes = fs.existsSync(this.dbPath) ? fs.readFileSync(this.dbPath) : null;
      this.database = bytes ? new SQL.Database(bytes) : new SQL.Database();
      this.database.run(`
        CREATE TABLE IF NOT EXISTS app_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          state_json TEXT NOT NULL,
          server_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_operations (
          op_id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          ok INTEGER NOT NULL,
          result_json TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_operations_applied_at
          ON sync_operations(applied_at DESC);
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          op_id TEXT,
          type TEXT NOT NULL,
          result TEXT NOT NULL,
          details_json TEXT,
          created_at TEXT NOT NULL
        );
      `);
      const stateColumns = rowsFromResult(this.database.exec('PRAGMA table_info(app_state)'));
      if (!stateColumns.some((column) => column.name === 'server_id')) {
        this.database.run('ALTER TABLE app_state ADD COLUMN server_id TEXT');
      }
      const stateRows = rowsFromResult(this.database.exec(
        'SELECT id, server_id FROM app_state WHERE id = 1 LIMIT 1',
      ));
      if (!stateRows.length) {
        const now = Domain.isoNow();
        const statement = this.database.prepare(`
          INSERT INTO app_state (id, version, updated_at, state_json, server_id)
          VALUES (1, 0, ?, ?, ?)
        `);
        statement.run([now, json(Domain.emptyState()), crypto.randomUUID()]);
        statement.free();
      } else if (typeof stateRows[0].server_id !== 'string' || !stateRows[0].server_id.trim()) {
        const statement = this.database.prepare('UPDATE app_state SET server_id = ? WHERE id = 1');
        statement.run([crypto.randomUUID()]);
        statement.free();
      }
      assertTableColumns(this.database, 'app_state', TABLE_COLUMNS.app_state);
      assertTableColumns(this.database, 'sync_operations', TABLE_COLUMNS.sync_operations);
      assertTableColumns(this.database, 'audit_log', TABLE_COLUMNS.audit_log);
      this.getState(this.database);
      await this.persist(this.database);
    } catch (error) {
      try { this.database?.close(); } catch {}
      this.database = null;
      const releaseResult = this.lock?.release();
      if ((releaseResult?.released && releaseResult.durable) || releaseResult?.ownershipLost) {
        this.lock = null;
      }
      throw error;
    }
  }

  async persist(database = this.database) {
    const bytes = database.export();
    const temporaryPath = `${this.dbPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let descriptor = null;
    let published = false;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, Buffer.from(bytes));
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporaryPath, this.dbPath);
      published = true;
      fsyncDirectory(path.dirname(this.dbPath));
    } catch (error) {
      if (descriptor !== null) try { fs.closeSync(descriptor); } catch {}
      try { fs.unlinkSync(temporaryPath); } catch {}
      throw new PersistenceError(
        published
          ? `数据库已发布，但目录同步失败，提交结果需要按 opId 重试确认：${error.message}`
          : `数据库写入在发布前失败：${error.message}`,
        { cause: error, published },
      );
    }
  }

  async read(callback) {
    await this.ready;
    if (this.closed) throw new Error('数据库已关闭');
    await this.queue;
    return callback(this.database);
  }

  async write(callback) {
    await this.ready;
    if (this.closed) throw new Error('数据库已关闭');
    const run = this.queue.then(async () => {
      let candidate = new this.SQL.Database(this.database.export());
      try {
        const result = await callback(candidate);
        try {
          await this.persist(candidate);
        } catch (error) {
          if (error instanceof PersistenceError && error.published) {
            const previous = this.database;
            this.database = candidate;
            candidate = null;
            try { previous.close(); } catch {}
          }
          throw error;
        }

        const previous = this.database;
        this.database = candidate;
        candidate = null;
        try { previous.close(); } catch {}
        this.refreshDailyBackupAfterWrite();
        return result;
      } finally {
        try { candidate?.close(); } catch {}
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  getState(database) {
    const rows = rowsFromResult(database.exec(
      'SELECT id, version, updated_at, state_json, server_id FROM app_state',
    ));
    if (rows.length !== 1 || Number(rows[0].id) !== 1) {
      throw new Error('app_state 必须且只能包含 id=1 的一行');
    }
    const row = rows[0];
    if (!Number.isSafeInteger(row.version) || row.version < 0) throw new Error('应用状态版本无效');
    if (typeof row.updated_at !== 'string' || !row.updated_at) throw new Error('应用状态时间无效');
    if (typeof row.server_id !== 'string' || !row.server_id.trim()) throw new Error('服务端编号无效');
    if (typeof row.state_json !== 'string') throw new Error('应用状态必须是 JSON 字符串');
    let parsed;
    try {
      parsed = JSON.parse(row.state_json);
    } catch {
      throw new Error('应用状态不是有效 JSON');
    }
    if (!isRestorableStateSnapshot(parsed)) throw new Error('应用状态结构不兼容');
    return {
      serverId: row.server_id,
      version: row.version,
      updatedAt: row.updated_at,
      state: Domain.normalizeState(parsed),
    };
  }

  async snapshot() {
    return this.read((database) => this.getState(database));
  }

  async backupDaily(dateKey = localDateKey()) {
    await this.ready;
    if (this.closed) throw new Error('数据库已关闭');
    await this.queue;
    return this.writeDailyBackup(dateKey, this.database);
  }

  refreshDailyBackupAfterWrite() {
    try {
      this.writeDailyBackup(localDateKey(), this.database);
      this.lastBackupError = null;
    } catch (error) {
      this.lastBackupError = error;
      console.error(`daily database backup refresh failed: ${error.message}`);
    }
  }

  writeDailyBackup(dateKey, database) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('备份日期格式无效');

    ensurePrivateDirectory(this.backupDir);
    const backupDirectoryMetadata = fs.lstatSync(this.backupDir);
    if (!backupDirectoryMetadata.isDirectory() || backupDirectoryMetadata.isSymbolicLink()) {
      throw new Error('备份目录必须是常规目录');
    }
    const backupPath = path.join(this.backupDir, `order-report-${dateKey}.sqlite3`);
    const temporaryPath = `${backupPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let descriptor = null;
    let published = false;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      const bytes = Buffer.from(database.export());
      fs.writeFileSync(descriptor, bytes);
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      this.assertValidBackup(temporaryPath);

      const existing = this.findValidDailyBackup(dateKey, backupPath);
      if (existing) {
        const beforeRead = fs.lstatSync(existing.path);
        if (!beforeRead.isFile() || beforeRead.isSymbolicLink()
          || !sameFile(beforeRead, existing.metadata)) {
          throw new Error('当日备份在验证后发生变化');
        }
        const existingBytes = fs.readFileSync(existing.path);
        const afterRead = fs.lstatSync(existing.path);
        if (!afterRead.isFile() || afterRead.isSymbolicLink()
          || !sameFile(beforeRead, afterRead)) {
          throw new Error('当日备份在读取时发生变化');
        }
        if (existingBytes.equals(bytes)) {
          return { created: false, updated: false, path: existing.path };
        }

        // Revalidate immediately before the atomic replacement. Invalid files,
        // including symlinks, are evidence and must never become replacement targets.
        this.assertValidBackup(existing.path);
        const beforeReplace = fs.lstatSync(existing.path);
        if (!beforeReplace.isFile() || beforeReplace.isSymbolicLink()
          || !sameFile(afterRead, beforeReplace)) {
          throw new Error('当日备份在替换前发生变化');
        }
        fs.renameSync(temporaryPath, existing.path);
        published = true;
        fsyncDirectory(this.backupDir);
        return { created: false, updated: true, path: existing.path };
      }

      let canonicalOccupied = true;
      try {
        fs.lstatSync(backupPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        canonicalOccupied = false;
      }
      if (!canonicalOccupied) {
        try {
          // A hard link publishes the already-fsynced candidate atomically and,
          // unlike rename, cannot overwrite a file created by a concurrent actor.
          fs.linkSync(temporaryPath, backupPath);
          published = true;
          fsyncDirectory(this.backupDir);
          return { created: true, updated: false, path: backupPath };
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }

      // Keep an invalid canonical backup untouched for forensics. The random hex
      // suffix is path-safe, and linkSync provides atomic no-clobber publication.
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const suffix = crypto.randomBytes(8).toString('hex');
        const recoveredPath = path.join(
          this.backupDir,
          `order-report-${dateKey}.recovered-${suffix}.sqlite3`,
        );
        try {
          fs.linkSync(temporaryPath, recoveredPath);
          published = true;
          fsyncDirectory(this.backupDir);
          return { created: true, updated: false, path: recoveredPath };
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
      throw new Error('无法生成唯一的当日备份文件名');
    } catch (error) {
      if (published) {
        const wrapped = new Error(`当日备份已发布，但目录同步失败：${error.message}`, { cause: error });
        wrapped.code = 'BACKUP_PUBLISHED_FSYNC_FAILED';
        wrapped.published = true;
        throw wrapped;
      }
      throw error;
    } finally {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.unlinkSync(temporaryPath); } catch {}
    }
  }

  findValidDailyBackup(dateKey, canonicalPath) {
    const recoveredPattern = new RegExp(
      `^order-report-${dateKey}\\.recovered-[0-9a-f]{16}\\.sqlite3$`,
    );
    const recoveredPaths = fs.readdirSync(this.backupDir)
      .filter((name) => recoveredPattern.test(name))
      .sort()
      .map((name) => path.join(this.backupDir, name));

    for (const candidatePath of [canonicalPath, ...recoveredPaths]) {
      try {
        const beforeValidation = fs.lstatSync(candidatePath);
        if (!beforeValidation.isFile() || beforeValidation.isSymbolicLink()) continue;
        this.assertValidBackup(candidatePath);
        const afterValidation = fs.lstatSync(candidatePath);
        if (afterValidation.isFile() && !afterValidation.isSymbolicLink()
          && sameFile(beforeValidation, afterValidation)) {
          return { path: candidatePath, metadata: afterValidation };
        }
      } catch {
        // Invalid same-day entries are retained as evidence and are never reused.
      }
    }
    return null;
  }

  assertValidBackup(filePath) {
    const metadata = fs.lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('数据库备份不是常规文件');
    let backup = null;
    try {
      backup = new this.SQL.Database(fs.readFileSync(filePath));
      const integrity = rowsFromResult(backup.exec('PRAGMA integrity_check'));
      const integrityValue = integrity[0] && Object.values(integrity[0])[0];
      if (integrity.length !== 1 || integrityValue !== 'ok') throw new Error('SQLite 完整性检查失败');
      const stateColumns = rowsFromResult(backup.exec('PRAGMA table_info(app_state)'));
      const hasServerId = stateColumns.some((column) => column.name === 'server_id');
      const stateRows = rowsFromResult(backup.exec(`
        SELECT id, version, updated_at, state_json${hasServerId ? ', server_id' : ''} FROM app_state
      `));
      if (stateRows.length !== 1 || Number(stateRows[0].id) !== 1) throw new Error('应用状态行无效');
      if (typeof stateRows[0].version !== 'number'
        || !Number.isSafeInteger(stateRows[0].version)
        || stateRows[0].version < 0) throw new Error('应用状态版本无效');
      if (typeof stateRows[0].updated_at !== 'string' || !stateRows[0].updated_at) throw new Error('应用状态时间无效');
      const state = JSON.parse(stateRows[0].state_json);
      if (!isRestorableStateSnapshot(state)) throw new Error('应用状态结构不兼容');
      if (hasServerId && (typeof stateRows[0].server_id !== 'string' || !stateRows[0].server_id.trim())) {
        throw new Error('服务端编号无效');
      }
      assertTableColumns(backup, 'sync_operations', TABLE_COLUMNS.sync_operations, hasServerId);
      assertTableColumns(backup, 'audit_log', TABLE_COLUMNS.audit_log, hasServerId);
    } catch (error) {
      throw new Error(`数据库备份无效：${error.message}`);
    } finally {
      try { backup?.close(); } catch {}
    }
  }

  async close() {
    if (!this.closePreparation) {
      this.closed = true;
      this.closePreparation = (async () => {
        try { await this.ready; } catch {}
        try { await this.queue; } catch {}
        try { this.database?.close(); } catch {}
        this.database = null;
      })();
    }
    await this.closePreparation;
    if (!this.lock) return { released: true, durable: true };
    const releaseResult = this.lock.release();
    if ((releaseResult.released && releaseResult.durable) || releaseResult.ownershipLost) {
      this.lock = null;
    }
    return releaseResult;
  }

  existingOperation(database, opId) {
    const statement = database.prepare(`
      SELECT op_id, client_id, type, payload_json, ok, result_json, error, created_at
      FROM sync_operations WHERE op_id = ? LIMIT 1
    `);
    statement.bind([opId]);
    const row = statement.step() ? statement.getAsObject() : null;
    statement.free();
    if (!row) return null;
    return {
      opId: row.op_id,
      clientId: row.client_id,
      type: row.type,
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at,
      ok: Boolean(row.ok),
      result: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error || null,
    };
  }

  sameOperation(previous, operation) {
    return previous.clientId === operation.clientId
      && previous.type === operation.type
      && previous.createdAt === operation.createdAt
      && canonicalJson(previous.payload) === canonicalJson(operation.payload);
  }

  recordOperation(database, operation, result) {
    const now = Domain.isoNow();
    const statement = database.prepare(`
      INSERT INTO sync_operations
        (op_id, client_id, type, payload_json, ok, result_json, error, created_at, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    statement.run([
      operation.opId,
      operation.clientId || 'unknown',
      operation.type,
      json(operation.payload || {}),
      result.ok ? 1 : 0,
      result.result === undefined ? null : json(result.result),
      result.error || null,
      operation.createdAt || now,
      now,
    ]);
    statement.free();
    const audit = database.prepare(`
      INSERT INTO audit_log (op_id, type, result, details_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    audit.run([operation.opId, operation.type, result.ok ? 'ok' : 'error', json(result), now]);
    audit.free();
  }

  async applyOperations(operations) {
    if (!Array.isArray(operations)) throw new Error('operations 必须是数组');
    const list = operations;
    if (list.length > 100) throw new Error('单次同步最多处理 100 个操作');
    if (!list.length) {
      const current = await this.snapshot();
      return { accepted: [], rejected: [], unprocessed: [], ...current };
    }
    return this.write((database) => {
      database.run('BEGIN');
      try {
        let current = this.getState(database);
        const accepted = [];
        const rejected = [];
        const unprocessed = [];
        for (let index = 0; index < list.length; index += 1) {
          const operation = list[index];
          const shapeError = operationShapeError(operation);
          if (shapeError) {
            rejected.push({ opId: typeof operation?.opId === 'string' ? operation.opId : null, error: shapeError });
            unprocessed.push(...list.slice(index + 1).map((row) => ({ opId: row?.opId || null })));
            break;
          }
          const previous = this.existingOperation(database, operation.opId);
          if (previous) {
            if (!this.sameOperation(previous, operation)) {
              rejected.push({
                opId: operation.opId,
                error: '操作编号已被不同内容使用，已拒绝覆盖原操作',
              });
              unprocessed.push(...list.slice(index + 1).map((row) => ({ opId: row?.opId || null })));
              break;
            }
            const replayResult = {
              opId: previous.opId,
              ok: previous.ok,
              result: previous.result,
              error: previous.error,
            };
            (previous.ok ? accepted : rejected).push(replayResult);
            if (!previous.ok) {
              unprocessed.push(...list.slice(index + 1).map((row) => ({ opId: row?.opId || null })));
              break;
            }
            continue;
          }
          if (current.version === Number.MAX_SAFE_INTEGER) {
            const result = {
              ok: false,
              opId: operation.opId,
              error: '应用状态版本已达到安全整数上限，无法接受新操作',
            };
            rejected.push(result);
            this.recordOperation(database, operation, result);
            unprocessed.push(...list.slice(index + 1).map((row) => ({ opId: row?.opId || null })));
            break;
          }
          let result;
          try {
            const applied = Domain.applyOperation(current.state, operation);
            current = {
              ...current,
              version: current.version + 1,
              updatedAt: Domain.isoNow(),
              state: applied.state,
            };
            result = { ok: true, opId: operation.opId, result: applied.result };
            accepted.push(result);
          } catch (error) {
            result = { ok: false, opId: operation.opId, error: error.message };
            rejected.push(result);
          }
          this.recordOperation(database, operation, result);
          if (!result.ok) {
            unprocessed.push(...list.slice(index + 1).map((row) => ({ opId: row?.opId || null })));
            break;
          }
        }
        if (current.version !== this.getState(database).version) {
          const statement = database.prepare(`
            UPDATE app_state SET version = ?, updated_at = ?, state_json = ? WHERE id = 1
          `);
          statement.run([current.version, current.updatedAt, json(current.state)]);
          statement.free();
        }
        const response = { accepted, rejected, unprocessed, ...current };
        database.run('COMMIT');
        return response;
      } catch (error) {
        try { database.run('ROLLBACK'); } catch {}
        throw error;
      }
    });
  }
}

module.exports = {
  DatabaseLockedError,
  PersistenceError,
  Store,
  acquireDatabaseLock,
  databaseLockPath,
};
