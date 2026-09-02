const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const {
  createConfig,
  readOrCreateSyncToken,
} = require('../lib/config');
const configModule = require('../lib/config');

function temporaryDirectory(t, prefix = 'order-report-config-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function workerToken(modulePath, tokenPath) {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    const config = require(workerData.modulePath);
    try {
      parentPort.postMessage({
        token: config.readOrCreateSyncToken({ tokenPath: workerData.tokenPath }, {}),
      });
    } catch (error) {
      parentPort.postMessage({ error: error.stack || error.message });
    }
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { modulePath, tokenPath },
    });
    worker.once('message', (message) => {
      if (message.error) reject(new Error(message.error));
      else resolve(message.token);
    });
    worker.once('error', reject);
  });
}

test('runtimeDir is the actual fallback base for the database and token paths', (t) => {
  const root = temporaryDirectory(t);
  const config = createConfig({ ORDER_REPORT_RUNTIME_DIR: 'var/private' }, root);
  const runtimeDir = path.join(root, 'var', 'private');

  assert.equal(config.root, root);
  assert.equal(config.runtimeDir, runtimeDir);
  assert.equal(config.dbPath, path.join(runtimeDir, 'order-report.sqlite3'));
  assert.equal(config.tokenPath, path.join(runtimeDir, 'sync-token'));
  assert.equal(fs.existsSync(runtimeDir), false);
});

test('explicit database and token paths still override runtimeDir', (t) => {
  const root = temporaryDirectory(t);
  const config = createConfig({
    ORDER_REPORT_RUNTIME_DIR: 'var/private',
    ORDER_REPORT_DB_PATH: 'custom/database.sqlite3',
    ORDER_REPORT_TOKEN_FILE: 'custom/token',
  }, root);

  assert.equal(config.dbPath, path.join(root, 'custom', 'database.sqlite3'));
  assert.equal(config.tokenPath, path.join(root, 'custom', 'token'));
});

test('.env.example leaves database and token paths unset so runtimeDir remains effective', (t) => {
  const root = temporaryDirectory(t);
  const examplePath = path.resolve(__dirname, '..', '.env.example');
  const environment = {};
  for (const line of fs.readFileSync(examplePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) environment[match[1]] = match[2];
  }

  assert.equal(Object.hasOwn(environment, 'ORDER_REPORT_DB_PATH'), false);
  assert.equal(Object.hasOwn(environment, 'ORDER_REPORT_TOKEN_FILE'), false);

  environment.ORDER_REPORT_RUNTIME_DIR = 'var/private';
  const config = createConfig(environment, root);
  assert.equal(config.dbPath, path.join(root, 'var', 'private', 'order-report.sqlite3'));
  assert.equal(config.tokenPath, path.join(root, 'var', 'private', 'sync-token'));
});

test('sync token creation is durable, private, stable, and repairs file permissions', (t) => {
  const directory = temporaryDirectory(t, 'order-report-token-');
  const tokenPath = path.join(directory, 'runtime', 'sync-token');
  const settings = { tokenPath };

  const first = readOrCreateSyncToken(settings, {});
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(fs.readFileSync(tokenPath, 'utf8'), `${first}\n`);
  assert.equal(fs.statSync(path.dirname(tokenPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);

  fs.chmodSync(path.dirname(tokenPath), 0o755);
  fs.chmodSync(tokenPath, 0o644);
  const second = readOrCreateSyncToken(settings, {});
  assert.equal(second, first);
  assert.equal(fs.statSync(path.dirname(tokenPath)).mode & 0o777, 0o755);
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
});

test('sync token setup preserves permissions on an existing parent directory', (t) => {
  const directory = temporaryDirectory(t, 'order-report-token-parent-mode-');
  const runtimeDir = path.join(directory, 'shared-runtime');
  const tokenPath = path.join(runtimeDir, 'sync-token');
  fs.mkdirSync(runtimeDir, { mode: 0o750 });

  readOrCreateSyncToken({ tokenPath }, {});

  assert.equal(fs.statSync(runtimeDir).mode & 0o777, 0o750);
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
});

test('sync token generation is process-safe under concurrent first start', async (t) => {
  const directory = temporaryDirectory(t, 'order-report-token-race-');
  const tokenPath = path.join(directory, 'runtime', 'sync-token');
  const modulePath = require.resolve('../lib/config');
  const tokens = await Promise.all(
    Array.from({ length: 8 }, () => workerToken(modulePath, tokenPath)),
  );

  assert.equal(new Set(tokens).size, 1);
  assert.equal(fs.readFileSync(tokenPath, 'utf8').trim(), tokens[0]);
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(path.dirname(tokenPath)).filter((name) => name.startsWith('sync-token.tmp-')),
    [],
  );
});

test('sync token rejects symlinks and empty credential files', (t) => {
  const directory = temporaryDirectory(t, 'order-report-token-invalid-');
  const targetPath = path.join(directory, 'target-token');
  const symlinkPath = path.join(directory, 'symlink-token');
  const emptyPath = path.join(directory, 'empty-token');
  fs.writeFileSync(targetPath, 'secret\n', { mode: 0o600 });
  fs.symlinkSync(targetPath, symlinkPath);
  fs.writeFileSync(emptyPath, '', { mode: 0o600 });

  assert.throws(
    () => readOrCreateSyncToken({ tokenPath: symlinkPath }, {}),
    /普通文件且不能是符号链接/,
  );
  assert.throws(
    () => readOrCreateSyncToken({ tokenPath: emptyPath }, {}),
    /同步令牌文件为空/,
  );
});

test('sync token opens credential paths non-blocking before validating their type', { concurrency: false }, (t) => {
  const directory = temporaryDirectory(t, 'order-report-token-open-flags-');
  const tokenPath = path.join(directory, 'directory-token');
  fs.mkdirSync(tokenPath);
  const originalOpenSync = fs.openSync;
  let observedFlags = null;
  fs.openSync = (filePath, flags, ...args) => {
    if (path.resolve(filePath) === tokenPath) observedFlags = flags;
    return originalOpenSync(filePath, flags, ...args);
  };
  try {
    assert.throws(
      () => readOrCreateSyncToken({ tokenPath }, {}),
      /普通文件且不能是符号链接/,
    );
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.ok(observedFlags !== null);
  if (fs.constants.O_NONBLOCK) {
    assert.equal(observedFlags & fs.constants.O_NONBLOCK, fs.constants.O_NONBLOCK);
  }
});

test('sync token rejects a FIFO without blocking startup', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows does not expose POSIX filesystem FIFOs');
    return;
  }
  const directory = temporaryDirectory(t, 'order-report-token-fifo-');
  const fifoPath = path.join(directory, 'fifo-token');
  const fifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
  if (fifo.error) {
    t.skip(`mkfifo is unavailable: ${fifo.error.code || fifo.error.message}`);
    return;
  }
  assert.equal(fifo.status, 0, fifo.stderr);

  const modulePath = require.resolve('../lib/config');
  const source = `
    const config = require(${JSON.stringify(modulePath)});
    try {
      config.readOrCreateSyncToken({ tokenPath: ${JSON.stringify(fifoPath)} }, {});
      console.log('accepted');
    } catch (error) {
      console.log(error.message);
    }
  `;
  const result = spawnSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    timeout: 2_000,
  });

  assert.notEqual(result.error?.code, 'ETIMEDOUT', 'token reader blocked while opening a FIFO');
  if (result.error) {
    t.skip(`child process is unavailable: ${result.error.code || result.error.message}`);
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /普通文件且不能是符号链接/);
});

test('an environment token does not create or read a token file', (t) => {
  const directory = temporaryDirectory(t, 'order-report-env-token-');
  const tokenPath = path.join(directory, 'missing', 'sync-token');
  const token = readOrCreateSyncToken(
    { tokenPath },
    { ORDER_REPORT_SYNC_TOKEN: '  configured-token  ' },
  );

  assert.equal(token, 'configured-token');
  assert.equal(fs.existsSync(path.dirname(tokenPath)), false);
});

test('restore CLI can load configuration without generating a sync token', (t) => {
  const directory = temporaryDirectory(t, 'order-report-restore-config-');
  const runtimeDir = path.join(directory, 'runtime');
  const tokenPath = path.join(runtimeDir, 'sync-token');
  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'restore-sqlite-backup.js');
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ORDER_REPORT_RUNTIME_DIR: runtimeDir,
      ORDER_REPORT_TOKEN_FILE: tokenPath,
      ORDER_REPORT_SYNC_TOKEN: '',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(tokenPath), false);
});

test('sync token getter is not enumerable into logs or serialized configuration', () => {
  assert.equal(Object.prototype.propertyIsEnumerable.call(configModule, 'syncToken'), false);
  assert.equal(Object.keys(configModule).includes('syncToken'), false);
});
