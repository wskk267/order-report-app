const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile(filePath) {
  try {
    const contents = fs.readFileSync(filePath, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1].startsWith('#') || process.env[match[1]] !== undefined) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch {}
}

loadEnvFile(path.join(ROOT, '.env'));

function resolveFromRoot(value, fallback, root = ROOT) {
  const selected = value || fallback;
  return path.isAbsolute(selected) ? path.resolve(selected) : path.resolve(root, selected);
}

function createConfig(environment = process.env, root = ROOT) {
  const runtimeDir = resolveFromRoot(
    environment.ORDER_REPORT_RUNTIME_DIR,
    path.join(root, 'runtime'),
    root,
  );
  return {
    root,
    runtimeDir,
    host: environment.ORDER_REPORT_HOST || '127.0.0.1',
    port: Number(environment.ORDER_REPORT_PORT || 3011),
    dbPath: resolveFromRoot(
      environment.ORDER_REPORT_DB_PATH,
      path.join(runtimeDir, 'order-report.sqlite3'),
      root,
    ),
    tokenPath: resolveFromRoot(
      environment.ORDER_REPORT_TOKEN_FILE,
      path.join(runtimeDir, 'sync-token'),
      root,
    ),
  };
}

function closeQuietly(descriptor) {
  if (descriptor === null) return;
  try { fs.closeSync(descriptor); } catch {}
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
    closeQuietly(descriptor);
  }
}

function ensurePrivateDirectory(directoryPath) {
  const createdPath = fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  if (createdPath !== undefined) fs.chmodSync(directoryPath, 0o700);
}

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function readExistingToken(tokenPath) {
  let descriptor = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const nonBlocking = fs.constants.O_NONBLOCK || 0;
    try {
      descriptor = fs.openSync(tokenPath, fs.constants.O_RDONLY | noFollow | nonBlocking);
    } catch (error) {
      if (error.code === 'ELOOP') throw new Error('同步令牌路径必须是普通文件且不能是符号链接');
      throw error;
    }
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(tokenPath);
    if (!opened.isFile() || current.isSymbolicLink() || !current.isFile() || !sameFile(opened, current)) {
      throw new Error('同步令牌路径必须是普通文件且不能是符号链接');
    }
    fs.fchmodSync(descriptor, 0o600);
    const token = fs.readFileSync(descriptor, 'utf8').trim();
    if (!token) throw new Error('同步令牌文件为空，请删除后重新启动以安全生成');
    return token;
  } finally {
    closeQuietly(descriptor);
  }
}

function readOrCreateSyncToken(settings, environment = process.env) {
  if (environment.ORDER_REPORT_SYNC_TOKEN?.trim()) {
    return environment.ORDER_REPORT_SYNC_TOKEN.trim();
  }

  const tokenPath = path.resolve(settings.tokenPath);
  const tokenDirectory = path.dirname(tokenPath);
  ensurePrivateDirectory(tokenDirectory);
  try {
    return readExistingToken(tokenPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const temporaryPath = `${tokenPath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${token}\n`);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(temporaryPath, tokenPath);
      fsyncDirectory(tokenDirectory);
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return readExistingToken(tokenPath);
    }
  } finally {
    closeQuietly(descriptor);
    try { fs.unlinkSync(temporaryPath); } catch {}
  }
}

const config = createConfig();
let cachedSyncToken = null;

function ensureSyncToken() {
  if (cachedSyncToken === null) cachedSyncToken = readOrCreateSyncToken(config);
  return cachedSyncToken;
}

Object.defineProperty(config, 'syncToken', {
  enumerable: false,
  get: ensureSyncToken,
});
config.ensureSyncToken = ensureSyncToken;
config.createConfig = createConfig;
config.readOrCreateSyncToken = readOrCreateSyncToken;

module.exports = config;
