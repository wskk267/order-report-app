const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Domain = require('../shared/domain');
const { Store } = require('../lib/store');

test('store applies sync operations idempotently', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-report-'));
  const store = new Store(path.join(directory, 'data.sqlite3'));
  await store.ready;
  const op = {
    opId: 'op_same',
    clientId: 'client_test',
    type: 'report.create',
    payload: {
      report: { id: 'report_store', occurredAt: '2026-08-01', originalMessage: '消息' },
      items: [{ id: 'item_store', productName: '商品', quantity: 1, actualPaymentCents: 100, expectedRefundCents: 20, expectedRebateCents: 5 }],
    },
    createdAt: Domain.isoNow(),
  };
  const first = await store.applyOperations([op]);
  const second = await store.applyOperations([op]);
  assert.equal(first.accepted.length, 1);
  assert.equal(second.accepted.length, 1);
  assert.equal(second.accepted[0].opId, op.opId);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.state.reports.length, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('store creates one protected sqlite backup per day without overwriting it', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-report-backup-'));
  const store = new Store(path.join(directory, 'data.sqlite3'));
  await store.ready;

  const first = await store.backupDaily('2026-08-19');
  assert.equal(first.created, true);
  assert.equal(first.path, path.join(directory, 'backups', 'order-report-2026-08-19.sqlite3'));
  assert.equal(fs.statSync(path.join(directory, 'backups')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
  const original = fs.readFileSync(first.path);

  const second = await store.backupDaily('2026-08-19');
  assert.equal(second.created, false);
  assert.deepEqual(fs.readFileSync(second.path), original);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('store refuses to trust a corrupt existing daily backup', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-report-corrupt-backup-'));
  const store = new Store(path.join(directory, 'data.sqlite3'));
  await store.ready;
  const backup = await store.backupDaily('2026-08-20');
  fs.writeFileSync(backup.path, Buffer.from('not a sqlite database'));
  await assert.rejects(store.backupDaily('2026-08-20'), /数据库备份无效/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('store rolls back the whole sync batch when recording fails unexpectedly', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-report-rollback-'));
  const store = new Store(path.join(directory, 'data.sqlite3'));
  await store.ready;
  const valid = {
    opId: 'op_transaction_valid',
    clientId: 'client_test',
    type: 'report.create',
    payload: {
      report: { id: 'report_transaction_valid', occurredAt: '2026-08-01', originalMessage: '' },
      items: [{ id: 'item_transaction_valid', productName: '商品', quantity: 1, actualPaymentCents: 100, expectedRefundCents: 20, expectedRebateCents: 0 }],
    },
    createdAt: Domain.isoNow(),
  };
  const circularPayload = {
    report: { id: 'report_transaction_bad', occurredAt: '2026-08-02', originalMessage: '' },
    items: [{ id: 'item_transaction_bad', productName: '商品二', quantity: 1, actualPaymentCents: 100, expectedRefundCents: 20, expectedRebateCents: 0 }],
  };
  circularPayload.circular = circularPayload;
  const invalid = { opId: 'op_transaction_bad', clientId: 'client_test', type: 'report.create', payload: circularPayload, createdAt: Domain.isoNow() };

  await assert.rejects(store.applyOperations([valid, invalid]), /circular/i);
  let snapshot = await store.snapshot();
  assert.equal(snapshot.version, 0);
  assert.equal(snapshot.state.reports.length, 0);

  const retried = await store.applyOperations([valid]);
  assert.equal(retried.accepted.length, 1);
  snapshot = await store.snapshot();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.state.reports.length, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('store does not hide directory fsync I/O failures', { concurrency: false }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-report-fsync-'));
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
    const store = new Store(path.join(directory, 'data.sqlite3'));
    await assert.rejects(store.ready, /forced directory fsync failure/);
  } finally {
    fs.fsyncSync = originalFsyncSync;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
