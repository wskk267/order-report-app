const test = require('node:test');
const assert = require('node:assert/strict');
const Domain = require('../shared/domain');

function ids() {
  let counter = 0;
  return (prefix) => `${prefix}_${++counter}`;
}

function operation(type, payload) {
  return { opId: Domain.makeId('op'), clientId: 'test', type, payload, createdAt: Domain.isoNow() };
}

function reportPayload(id, productName, quantity, actual, expectedRefund, expectedRebate, occurredAt = '2026-08-01T10:00') {
  return {
    report: { id, occurredAt, originalMessage: `原消息 ${productName}` },
    items: [{
      id: `${id}_item`,
      productName,
      quantity,
      actualPaymentCents: actual,
      expectedRefundCents: expectedRefund,
      expectedRebateCents: expectedRebate,
    }],
  };
}

test('express allocation follows FIFO and includes expected rebate in income', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r_old', '商品A', 2, 1000, 200, 50, '2026-08-01T10:00')), { idFactory, now: '2026-08-01T11:00' }).state;
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r_new', '商品A', 3, 1800, 300, 90, '2026-08-02T10:00')), { idFactory, now: '2026-08-02T11:00' }).state;
  const shipmentPayload = {
    shipment: { id: 's1', trackingNumber: 'TRACK-1', shippingCostCents: 120, shippedAt: '2026-08-03' },
    items: [{ productName: '商品A', quantity: 4 }],
  };
  const applied = Domain.applyOperation(state, operation('shipment.create', shipmentPayload), { idFactory, now: '2026-08-03T11:00' });
  state = applied.state;
  assert.deepEqual(applied.result.allocations, [
    { reportItemId: 'r_old_item', quantity: 2 },
    { reportItemId: 'r_new_item', quantity: 2 },
  ]);
  assert.equal(Domain.inventoryLots(state).find((row) => row.reportItemId === 'r_old_item'), undefined);
  assert.equal(Domain.inventoryLots(state).find((row) => row.reportItemId === 'r_new_item').availableQuantity, 1);
  const summary = Domain.stats(state);
  assert.equal(summary.totalPurchaseCents, 2800);
  assert.equal(summary.expectedIncomeCents, 510);
  assert.equal(summary.outstandingCents, 510);
  assert.equal(summary.profitCents, 510);
  assert.equal(summary.pureProfitCents, 390);
  assert.equal(summary.rate, 390 / 2800);
});

test('partial settlements and refunds update derived values', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r1', '商品B', 4, 4000, 800, 400)), { idFactory, now: '2026-08-01T11:00' }).state;
  state = Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's1', trackingNumber: 'TRACK-2', shippingCostCents: 300, shippedAt: '2026-08-02' },
    items: [{ productName: '商品B', quantity: 2 }],
  }), { idFactory, now: '2026-08-02T11:00' }).state;
  state = Domain.applyOperation(state, operation('settlement.create', {
    settlement: { id: 'settle1', shipmentId: 's1', amountCents: 500, settledAt: '2026-08-03' },
  }), { idFactory, now: '2026-08-03T11:00' }).state;
  state = Domain.applyOperation(state, operation('refund.create', {
    refund: { id: 'refund1', reportItemId: 'r1_item', quantity: 1, amountCents: 1, refundedAt: '2026-08-04' },
  }), { idFactory, now: '2026-08-04T11:00' }).state;
  const summary = Domain.stats(state);
  assert.equal(summary.totalPurchaseCents, 3000);
  assert.equal(summary.expectedIncomeCents, 600);
  assert.equal(summary.returnedCents, 500);
  assert.equal(summary.outstandingCents, 100);
  assert.equal(summary.profitCents, 600);
  assert.equal(summary.pureProfitCents, 300);
  assert.equal(Domain.inventoryLots(state)[0].availableQuantity, 1);
  assert.equal(state.refunds[0].amountCents, 1000);
});

test('shipment update releases its old FIFO allocation before reassigning', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r1', '商品C', 2, 2000, 200, 0, '2026-08-01')), { idFactory }).state;
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r2', '商品C', 2, 2200, 220, 0, '2026-08-02')), { idFactory }).state;
  state = Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's1', trackingNumber: 'TRACK-3', shippingCostCents: 100, shippedAt: '2026-08-03' },
    items: [{ productName: '商品C', quantity: 2 }],
  }), { idFactory }).state;
  state = Domain.applyOperation(state, operation('shipment.update', {
    shipment: { id: 's1', trackingNumber: 'TRACK-3-EDIT', shippingCostCents: 100, shippedAt: '2026-08-03' },
    items: [{ productName: '商品C', quantity: 3 }],
  }), { idFactory }).state;
  assert.equal(state.shipmentItems.filter((item) => item.shipmentId === 's1').reduce((sum, item) => sum + item.quantity, 0), 3);
  assert.equal(Domain.inventoryLots(state).find((row) => row.reportItemId === 'r1_item'), undefined);
  assert.equal(Domain.inventoryLots(state).find((row) => row.reportItemId === 'r2_item').availableQuantity, 1);
});

test('shipment view carries item notes for printed slips', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', {
    report: { id: 'r_note', occurredAt: '2026-08-01', originalMessage: '' },
    items: [{ id: 'r_note_item', productName: '商品D', note: '红色', quantity: 2, actualPaymentCents: 1000, expectedRefundCents: 100, expectedRebateCents: 0 }],
  }), { idFactory }).state;
  state = Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's_note', trackingNumber: 'TRACK-NOTE', shippingCostCents: 0, shippedAt: '2026-08-02' },
    items: [{ productName: '商品D', quantity: 1 }],
  }), { idFactory }).state;
  const view = Domain.shipmentView(state, state.shipments[0]);
  assert.equal(view.items[0].productName, '商品D');
  assert.equal(view.items[0].productNote, '红色');
});
