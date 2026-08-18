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
const runtimeDir = path.resolve(process.env.ORDER_REPORT_RUNTIME_DIR || path.join(ROOT, 'runtime'));

function resolveFromRoot(value, fallback) {
  const selected = value || fallback;
  return path.isAbsolute(selected) ? selected : path.resolve(ROOT, selected);
}

function getToken() {
  if (process.env.ORDER_REPORT_SYNC_TOKEN?.trim()) return process.env.ORDER_REPORT_SYNC_TOKEN.trim();
  const tokenPath = resolveFromRoot(process.env.ORDER_REPORT_TOKEN_FILE, path.join('runtime', 'sync-token'));
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  try {
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    if (token) return token;
  } catch {}
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  try { fs.chmodSync(tokenPath, 0o600); } catch {}
  return token;
}

module.exports = {
  root: ROOT,
  runtimeDir,
  host: process.env.ORDER_REPORT_HOST || '127.0.0.1',
  port: Number(process.env.ORDER_REPORT_PORT || 3011),
  dbPath: resolveFromRoot(process.env.ORDER_REPORT_DB_PATH, path.join('runtime', 'order-report.sqlite3')),
  tokenPath: resolveFromRoot(process.env.ORDER_REPORT_TOKEN_FILE, path.join('runtime', 'sync-token')),
  syncToken: getToken(),
};
