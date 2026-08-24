const fs = require('node:fs');
const path = require('node:path');
const config = require('../lib/config');

function fail(message) {
  console.error(`恢复失败：${message}`);
  process.exitCode = 1;
}

const backupDir = path.resolve(path.dirname(config.dbPath), 'backups');
const inputPath = process.argv[2];

if (!inputPath) {
  fail('请指定 runtime/backups/ 下的 SQLite 备份文件');
} else {
  const backupPath = path.resolve(inputPath);
  const relative = path.relative(backupDir, backupPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('只允许恢复 runtime/backups/ 下的备份');
  } else if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) {
    fail('备份文件不存在');
  } else if (fs.readFileSync(backupPath).subarray(0, 16).toString() !== 'SQLite format 3\u0000') {
    fail('文件不是有效的 SQLite 数据库');
  } else {
    const databasePath = path.resolve(config.dbPath);
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const beforeRestorePath = `${databasePath}.before-restore-${timestamp}`;
    const temporaryPath = `${databasePath}.restore-${process.pid}`;
    try {
      if (fs.existsSync(databasePath)) {
        fs.copyFileSync(databasePath, beforeRestorePath);
        fs.chmodSync(beforeRestorePath, 0o600);
      }
      fs.copyFileSync(backupPath, temporaryPath);
      fs.chmodSync(temporaryPath, 0o600);
      fs.renameSync(temporaryPath, databasePath);
      fs.chmodSync(databasePath, 0o600);
      console.log(`已恢复：${backupPath}`);
      if (fs.existsSync(beforeRestorePath)) console.log(`恢复前数据库备份：${beforeRestorePath}`);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch {}
      fail(error.message);
    }
  }
}
