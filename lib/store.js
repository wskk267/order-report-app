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

class Store {
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    this.queue = Promise.resolve();
    this.ready = this.initialize();
  }

  async initialize() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
    });
    const bytes = fs.existsSync(this.dbPath) ? fs.readFileSync(this.dbPath) : null;
    this.database = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.database.run(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        state_json TEXT NOT NULL
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
    const stateRows = rowsFromResult(this.database.exec('SELECT state_json FROM app_state WHERE id = 1 LIMIT 1'));
    if (!stateRows.length) {
      const now = Domain.isoNow();
      const statement = this.database.prepare(`
        INSERT INTO app_state (id, version, updated_at, state_json) VALUES (1, 0, ?, ?)
      `);
      statement.run([now, json(Domain.emptyState())]);
      statement.free();
    }
    await this.persist();
  }

  async persist() {
    const bytes = this.database.export();
    const temporaryPath = `${this.dbPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, Buffer.from(bytes), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.dbPath);
    try { fs.chmodSync(this.dbPath, 0o600); } catch {}
  }

  async read(callback) {
    await this.ready;
    await this.queue;
    return callback(this.database);
  }

  async write(callback) {
    await this.ready;
    const run = this.queue.then(async () => {
      const result = await callback(this.database);
      await this.persist();
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  getState(database) {
    const rows = rowsFromResult(database.exec('SELECT version, updated_at, state_json FROM app_state WHERE id = 1'));
    const row = rows[0];
    return {
      version: Number(row?.version || 0),
      updatedAt: row?.updated_at || null,
      state: Domain.normalizeState(row?.state_json ? JSON.parse(row.state_json) : null),
    };
  }

  async snapshot() {
    return this.read((database) => this.getState(database));
  }

  existingOperation(database, opId) {
    const statement = database.prepare(`
      SELECT op_id, ok, result_json, error FROM sync_operations WHERE op_id = ? LIMIT 1
    `);
    statement.bind([opId]);
    const row = statement.step() ? statement.getAsObject() : null;
    statement.free();
    if (!row) return null;
    return {
      opId: row.op_id,
      ok: Boolean(row.ok),
      result: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error || null,
    };
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
    const list = Array.isArray(operations) ? operations : [];
    if (list.length > 100) throw new Error('单次同步最多处理 100 个操作');
    return this.write((database) => {
      let current = this.getState(database);
      const accepted = [];
      const rejected = [];
      for (const operation of list) {
        if (!operation?.opId || !operation?.type) {
          rejected.push({ opId: operation?.opId || null, error: '操作缺少 opId 或 type' });
          continue;
        }
        const previous = this.existingOperation(database, operation.opId);
        if (previous) {
          (previous.ok ? accepted : rejected).push(previous);
          continue;
        }
        let result;
        try {
          const applied = Domain.applyOperation(current.state, operation);
          current = {
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
      }
      if (current.version !== this.getState(database).version) {
        const statement = database.prepare(`
          UPDATE app_state SET version = ?, updated_at = ?, state_json = ? WHERE id = 1
        `);
        statement.run([current.version, current.updatedAt, json(current.state)]);
        statement.free();
      }
      return { accepted, rejected, ...current };
    });
  }
}

module.exports = { Store };
