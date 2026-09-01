const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const Domain = require('../shared/domain');

const SQLITE_HEADER = 'SQLite format 3\u0000';
const COPY_BUFFER_SIZE = 64 * 1024;

function fail(message) {
  console.error(`恢复失败：${message}`);
  process.exitCode = 1;
}

function isOutsideDirectory(relativePath) {
  return !relativePath
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath);
}

function assertBackupPath(backupDir, backupPath) {
  const relative = path.relative(backupDir, backupPath);
  if (isOutsideDirectory(relative)) {
    throw new Error('只允许恢复 runtime/backups/ 下的备份');
  }

  let backupDirRealPath;
  try {
    const backupDirStat = fs.lstatSync(backupDir);
    if (backupDirStat.isSymbolicLink() || !backupDirStat.isDirectory()) {
      throw new Error('备份目录不能是符号链接且必须是目录');
    }
    backupDirRealPath = fs.realpathSync(backupDir);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('备份目录不存在');
    throw error;
  }

  let currentPath = backupDir;
  for (const component of relative.split(path.sep)) {
    currentPath = path.join(currentPath, component);
    let stat;
    try {
      stat = fs.lstatSync(currentPath);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('备份文件不存在');
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('备份路径不能包含符号链接');
  }

  const stat = fs.lstatSync(backupPath);
  if (!stat.isFile()) throw new Error('备份文件不存在或不是普通文件');

  const realPath = fs.realpathSync(backupPath);
  const realRelative = path.relative(backupDirRealPath, realPath);
  if (isOutsideDirectory(realRelative)) {
    throw new Error('只允许恢复 runtime/backups/ 下的备份');
  }
}

function openUniqueFile(prefix) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const filePath = `${prefix}-${suffix}`;
    try {
      const descriptor = fs.openSync(filePath, 'wx', 0o600);
      return { descriptor, filePath };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('无法创建唯一的恢复文件');
}

function closeQuietly(descriptor) {
  if (descriptor === null) return;
  try { fs.closeSync(descriptor); } catch {}
}

function unlinkQuietly(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch {}
}

function copyToUniqueFile(sourcePath, destinationPrefix, options = {}) {
  let sourceDescriptor = null;
  let destinationDescriptor = null;
  let destinationPath = null;
  try {
    const noFollow = options.noFollow && fs.constants.O_NOFOLLOW
      ? fs.constants.O_NOFOLLOW
      : 0;
    sourceDescriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow);
    if (!fs.fstatSync(sourceDescriptor).isFile()) throw new Error('源文件不是普通文件');

    const created = openUniqueFile(destinationPrefix);
    destinationDescriptor = created.descriptor;
    destinationPath = created.filePath;

    const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
    while (true) {
      const bytesRead = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        offset += fs.writeSync(destinationDescriptor, buffer, offset, bytesRead - offset);
      }
    }
    fs.fchmodSync(destinationDescriptor, 0o600);
    fs.fsyncSync(destinationDescriptor);
    fs.closeSync(destinationDescriptor);
    destinationDescriptor = null;
    return destinationPath;
  } catch (error) {
    closeQuietly(destinationDescriptor);
    unlinkQuietly(destinationPath);
    throw error;
  } finally {
    closeQuietly(sourceDescriptor);
  }
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

function rowsFromResult(result) {
  if (!result || result.length === 0) return [];
  const [{ columns, values }] = result;
  return values.map((row) => Object.fromEntries(
    columns.map((column, index) => [column, row[index]]),
  ));
}

async function validateDatabase(databasePath) {
  const header = Buffer.alloc(SQLITE_HEADER.length);
  let descriptor = null;
  try {
    descriptor = fs.openSync(databasePath, 'r');
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString() !== SQLITE_HEADER) {
      throw new Error('文件不是有效的 SQLite 数据库');
    }
  } finally {
    closeQuietly(descriptor);
  }

  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
  });
  let database = null;
  try {
    database = new SQL.Database(fs.readFileSync(databasePath));
    const integrityRows = rowsFromResult(database.exec('PRAGMA integrity_check'));
    if (integrityRows.length !== 1 || integrityRows[0].integrity_check !== 'ok') {
      const details = integrityRows.map((row) => row.integrity_check).filter(Boolean).join('; ');
      throw new Error(`SQLite 完整性检查未通过${details ? `：${details}` : ''}`);
    }

    const tableRows = rowsFromResult(database.exec(`
      SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'app_state'
    `));
    if (tableRows.length !== 1) throw new Error('备份缺少必需的 app_state 表');

    let stateRows;
    try {
      stateRows = rowsFromResult(database.exec(`
        SELECT id, version, updated_at, state_json FROM app_state
      `));
    } catch (error) {
      throw new Error(`app_state 表结构无效：${error.message}`);
    }
    if (stateRows.length !== 1 || Number(stateRows[0].id) !== 1) {
      throw new Error('app_state 必须且只能包含 id=1 的一行');
    }
    if (typeof stateRows[0].state_json !== 'string') {
      throw new Error('app_state.state_json 必须是 JSON 字符串');
    }
    let state;
    try {
      state = JSON.parse(stateRows[0].state_json);
    } catch {
      throw new Error('app_state.state_json 不是有效 JSON');
    }
    if (!Domain.isStateSnapshot(state)) throw new Error('app_state.state_json 不是兼容的报单管家数据');
    if (typeof stateRows[0].version !== 'number'
      || !Number.isInteger(stateRows[0].version)
      || stateRows[0].version < 0) {
      throw new Error('app_state.version 无效');
    }
    if (typeof stateRows[0].updated_at !== 'string' || !stateRows[0].updated_at) {
      throw new Error('app_state.updated_at 无效');
    }
  } catch (error) {
    throw new Error(`备份校验失败：${error.message}`);
  } finally {
    if (database) database.close();
  }
}

async function restoreBackup({ databasePath: configuredDatabasePath, inputPath }) {
  if (!inputPath) throw new Error('请指定 runtime/backups/ 下的 SQLite 备份文件');

  const databasePath = path.resolve(configuredDatabasePath);
  const databaseDir = path.dirname(databasePath);
  const backupDir = path.resolve(databaseDir, 'backups');
  const backupPath = path.resolve(inputPath);
  assertBackupPath(backupDir, backupPath);

  let temporaryPath = null;
  let beforeRestorePath = null;
  try {
    temporaryPath = copyToUniqueFile(
      backupPath,
      `${databasePath}.restore`,
      { noFollow: true },
    );
    await validateDatabase(temporaryPath);

    if (fs.existsSync(databasePath)) {
      const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      beforeRestorePath = copyToUniqueFile(
        databasePath,
        `${databasePath}.before-restore-${timestamp}`,
        { noFollow: true },
      );
      fsyncDirectory(databaseDir);
    }

    fs.renameSync(temporaryPath, databasePath);
    temporaryPath = null;
    fsyncDirectory(databaseDir);

    return { backupPath, beforeRestorePath };
  } finally {
    unlinkQuietly(temporaryPath);
  }
}

async function main() {
  const config = require('../lib/config');
  const result = await restoreBackup({
    databasePath: config.dbPath,
    inputPath: process.argv[2],
  });
  console.log(`已恢复：${result.backupPath}`);
  if (result.beforeRestorePath) {
    console.log(`恢复前数据库备份：${result.beforeRestorePath}`);
  }
}

if (require.main === module) main().catch((error) => fail(error.message));

module.exports = { restoreBackup };
