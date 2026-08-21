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

test('FIFO allocation separates expected refund and rebate in stats', () => {
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
  assert.equal(summary.expectedIncomeCents, 640);
  assert.equal(summary.expectedRefundCents, 500);
  assert.equal(summary.pendingExpectedRefundCents, 500);
  assert.equal(summary.expectedRebateCents, 140);
  assert.equal(summary.outstandingCents, 500);
  assert.equal(summary.pendingReturnedCents, 0);
  assert.equal(summary.closedActualRefundCents, 0);
  assert.equal(summary.recognizedRefundCents, 500);
  assert.equal(summary.profitCents, -2160);
  assert.equal(summary.pureProfitCents, -2280);
  assert.equal(summary.pendingShipmentPurchaseCents, 600);
  assert.equal(summary.rate, -2280 / 2800);
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
    settlement: { id: 'settle1', shipmentId: 's1', amountCents: 300, settledAt: '2026-08-03' },
  }), { idFactory, now: '2026-08-03T11:00' }).state;
  state = Domain.applyOperation(state, operation('refund.create', {
    refund: { id: 'refund1', reportItemId: 'r1_item', quantity: 1, amountCents: 1, refundedAt: '2026-08-04' },
  }), { idFactory, now: '2026-08-04T11:00' }).state;
  const summary = Domain.stats(state);
  assert.equal(summary.totalPurchaseCents, 3000);
  assert.equal(summary.expectedIncomeCents, 900);
  assert.equal(summary.expectedRefundCents, 600);
  assert.equal(summary.pendingExpectedRefundCents, 600);
  assert.equal(summary.expectedRebateCents, 300);
  assert.equal(summary.returnedCents, 300);
  assert.equal(summary.pendingReturnedCents, 300);
  assert.equal(summary.closedActualRefundCents, 0);
  assert.equal(summary.recognizedRefundCents, 600);
  assert.equal(summary.outstandingCents, 300);
  assert.equal(summary.profitCents, -2100);
  assert.equal(summary.pureProfitCents, -2400);
  assert.equal(summary.pendingShipmentPurchaseCents, 1000);
  assert.equal(Domain.inventoryLots(state)[0].availableQuantity, 1);
  assert.equal(state.refunds[0].amountCents, 1000);
});

test('closed shipments keep their settlements and reopen before changes', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r_close', '商品E', 1, 1000, 120, 30)), { idFactory }).state;
  state = Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's_close', trackingNumber: 'TRACK-CLOSE', shippingCostCents: 100, shippedAt: '2026-08-02' },
    items: [{ productName: '商品E', quantity: 1 }],
  }), { idFactory }).state;
  state = Domain.applyOperation(state, operation('settlement.create', {
    settlement: { id: 'settle_close', shipmentId: 's_close', amountCents: 120, settledAt: '2026-08-03' },
  }), { idFactory }).state;
  state = Domain.applyOperation(state, operation('shipment.close', { id: 's_close' }), { idFactory, now: '2026-08-04T11:00' }).state;
  const closedView = Domain.shipmentView(state, state.shipments[0]);
  assert.equal(closedView.closed, true);
  assert.equal(closedView.returnedCents, 120);
  assert.equal(closedView.refundVarianceCents, 0);
  assert.throws(() => Domain.applyOperation(state, operation('settlement.update', {
    settlement: { id: 'settle_close', amountCents: 130, settledAt: '2026-08-05' },
  }), { idFactory }), /已结单/);

  state = Domain.applyOperation(state, operation('shipment.reopen', { id: 's_close' }), { idFactory, now: '2026-08-05T11:00' }).state;
  state = Domain.applyOperation(state, operation('settlement.update', {
    settlement: { id: 'settle_close', amountCents: 130, settledAt: '2026-08-05' },
  }), { idFactory }).state;
  const reopenedView = Domain.shipmentView(state, state.shipments[0]);
  assert.equal(reopenedView.closed, false);
  assert.equal(reopenedView.returnedCents, 130);
});

test('closed actual return replaces its forecast in profit, while inventory stays forecast', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r_final', '商品F', 1, 1000, 120, 30)), { idFactory }).state;
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r_stock', '商品G', 1, 1000, 300, 0, '2026-08-02')), { idFactory }).state;
  state = Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's_final', trackingNumber: 'TRACK-FINAL', shippingCostCents: 100, shippedAt: '2026-08-03' },
    items: [{ productName: '商品F', quantity: 1 }],
  }), { idFactory }).state;
  state = Domain.applyOperation(state, operation('settlement.create', {
    settlement: { id: 'settle_final', shipmentId: 's_final', amountCents: 100, settledAt: '2026-08-04' },
  }), { idFactory }).state;
  state = Domain.applyOperation(state, operation('shipment.close', { id: 's_final' }), { idFactory, now: '2026-08-05' }).state;

  const summary = Domain.stats(state);
  assert.equal(summary.expectedRefundCents, 420);
  assert.equal(summary.pendingExpectedRefundCents, 300);
  assert.equal(summary.closedActualRefundCents, 100);
  assert.equal(summary.recognizedRefundCents, 400);
  assert.equal(summary.outstandingCents, 300);
  assert.equal(summary.profitCents, -1570);
  assert.equal(summary.pureProfitCents, -1670);
});

test('open shipment settlements do not replace the forecast before closing', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r_open', '商品H', 1, 1000, 100, 0)), { idFactory }).state;
  state = Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's_open', trackingNumber: 'TRACK-OPEN', shippingCostCents: 0, shippedAt: '2026-08-02' },
    items: [{ productName: '商品H', quantity: 1 }],
  }), { idFactory }).state;
  state = Domain.applyOperation(state, operation('settlement.create', {
    settlement: { id: 'settle_open', shipmentId: 's_open', amountCents: 120, settledAt: '2026-08-03' },
  }), { idFactory }).state;

  let summary = Domain.stats(state);
  assert.equal(summary.returnedCents, 120);
  assert.equal(summary.pendingReturnedCents, 120);
  assert.equal(summary.outstandingCents, 0);
  assert.equal(summary.recognizedRefundCents, 100);
  assert.equal(summary.profitCents, -900);

  state = Domain.applyOperation(state, operation('shipment.close', { id: 's_open' }), { idFactory, now: '2026-08-04' }).state;
  summary = Domain.stats(state);
  assert.equal(summary.closedActualRefundCents, 120);
  assert.equal(summary.pendingExpectedRefundCents, 0);
  assert.equal(summary.recognizedRefundCents, 120);
  assert.equal(summary.profitCents, -880);
});

test('a shipment cannot be closed without an actual settlement', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r_no_settle', '商品I', 1, 1000, 100, 0)), { idFactory }).state;
  state = Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's_no_settle', trackingNumber: 'TRACK-NO-SETTLE', shippingCostCents: 0, shippedAt: '2026-08-02' },
    items: [{ productName: '商品I', quantity: 1 }],
  }), { idFactory }).state;
  assert.throws(() => Domain.applyOperation(state, operation('shipment.close', { id: 's_no_settle' }), { idFactory }), /先登记实际返款/);
});

test('used report item financial fields cannot be changed after allocation', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r_locked', '商品J', 1, 1000, 100, 20)), { idFactory }).state;
  state = Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's_locked', trackingNumber: 'TRACK-LOCKED', shippingCostCents: 0, shippedAt: '2026-08-02' },
    items: [{ productName: '商品J', quantity: 1 }],
  }), { idFactory }).state;
  assert.throws(() => Domain.applyOperation(state, operation('report.update', reportPayload('r_locked', '商品J', 1, 1100, 100, 20)), { idFactory }), /不能修改名称、数量或金额/);
  assert.throws(() => Domain.applyOperation(state, operation('report.update', reportPayload('r_locked', '商品J', 1, 1000, 110, 20)), { idFactory }), /不能修改名称、数量或金额/);
  state = Domain.applyOperation(state, operation('report.update', {
    report: { id: 'r_locked', occurredAt: '2026-08-01T10:00', originalMessage: '更新备注' },
    items: [{ id: 'r_locked_item', productName: '商品J', note: '新备注', quantity: 1, actualPaymentCents: 1000, expectedRefundCents: 100, expectedRebateCents: 20 }],
  }), { idFactory }).state;
  assert.equal(state.reportItems[0].note, '新备注');
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
