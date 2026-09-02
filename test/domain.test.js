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
  const shipment = Domain.shipmentView(state, state.shipments[0]);
  assert.equal(shipment.actualPaymentCents, 2200);
  assert.equal(shipment.expectedRefundCents, 400);
  assert.equal(shipment.expectedRebateCents, 110);
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

test('shipment closed state cannot be injected through create or update payloads', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r_lifecycle', '商品生命周期', 2, 100, 100, 0)), { idFactory }).state;
  assert.throws(() => Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's_injected', trackingNumber: 'TRACK-INJECTED', shippingCostCents: 0, shippedAt: '2026-08-02', closedAt: '2026-08-03' },
    items: [{ productName: '商品生命周期', quantity: 1 }],
  }), { idFactory }), /结单状态只能通过结单操作修改/);

  state = Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's_open_lifecycle', trackingNumber: 'TRACK-OPEN-LIFECYCLE', shippingCostCents: 0, shippedAt: '2026-08-02' },
    items: [{ productName: '商品生命周期', quantity: 1 }],
  }), { idFactory }).state;
  assert.throws(() => Domain.applyOperation(state, operation('shipment.update', {
    shipment: { id: 's_open_lifecycle', trackingNumber: 'TRACK-OPEN-LIFECYCLE', shippingCostCents: 0, shippedAt: '2026-08-02', closedAt: '2026-08-03' },
    items: [{ productName: '商品生命周期', quantity: 1 }],
  }), { idFactory }), /结单状态只能通过结单操作修改/);
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

test('no-op shipment updates keep deterministic cent ownership and statistics', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r_stable_cent', '商品稳定', 3, 100, 100, 100)), { idFactory }).state;
  for (const [id, date] of [['s_stable_1', '2026-08-02'], ['s_stable_2', '2026-08-03']]) {
    state = Domain.applyOperation(state, operation('shipment.create', {
      shipment: { id, trackingNumber: id, shippingCostCents: 0, shippedAt: date },
      items: [{ productName: '商品稳定', quantity: 1 }],
    }), { idFactory, now: `${date}T10:00:00.000Z` }).state;
  }
  state = Domain.applyOperation(state, operation('settlement.create', {
    settlement: { id: 'settle_stable', shipmentId: 's_stable_2', amountCents: 34, settledAt: '2026-08-04' },
  }), { idFactory, now: '2026-08-04T10:00:00.000Z' }).state;
  state = Domain.applyOperation(state, operation('shipment.close', { id: 's_stable_2' }), {
    idFactory,
    now: '2026-08-05T10:00:00.000Z',
  }).state;

  const valuesBefore = state.shipments.map((shipment) => Domain.shipmentView(state, shipment).actualPaymentCents);
  const statsBefore = Domain.stats(state);
  const previewAllocations = Domain.allocateFifo(state, [{ productName: '商品稳定', quantity: 1 }], { excludeShipmentId: 's_stable_1' });
  assert.equal(Domain.previewShipmentAllocations(state, previewAllocations, { excludeShipmentId: 's_stable_1' })[0].actualPaymentCents, 33);

  state = Domain.applyOperation(state, operation('shipment.update', {
    shipment: { id: 's_stable_1', trackingNumber: 's_stable_1', shippingCostCents: 0, shippedAt: '2026-08-02' },
    items: [{ productName: '商品稳定', quantity: 1 }],
  }), { idFactory, now: '2026-08-06T10:00:00.000Z' }).state;
  assert.deepEqual(valuesBefore, [33, 34]);
  assert.deepEqual(state.shipments.map((shipment) => Domain.shipmentView(state, shipment).actualPaymentCents), valuesBefore);
  assert.deepEqual(Domain.stats(state), statsBefore);
});

test('void shipment and refund history keeps referenced report items as tombstones', () => {
  const originalItems = [
    { id: 'i_history', productName: '历史商品', quantity: 1, actualPaymentCents: 100, expectedRefundCents: 50, expectedRebateCents: 10 },
    { id: 'i_keep', productName: '保留商品', quantity: 1, actualPaymentCents: 200, expectedRefundCents: 100, expectedRebateCents: 20 },
  ];
  const updatePayload = {
    report: { id: 'r_history', occurredAt: '2026-08-01', originalMessage: '' },
    items: [originalItems[1]],
  };

  let shipmentState = Domain.emptyState();
  const shipmentIds = ids();
  shipmentState = Domain.applyOperation(shipmentState, operation('report.create', {
    report: { id: 'r_history', occurredAt: '2026-08-01', originalMessage: '' },
    items: originalItems,
  }), { idFactory: shipmentIds, now: '2026-08-01T10:00:00.000Z' }).state;
  shipmentState = Domain.applyOperation(shipmentState, operation('shipment.create', {
    shipment: { id: 's_history', trackingNumber: 'TRACK-HISTORY', shippingCostCents: 0, shippedAt: '2026-08-02' },
    items: [{ productName: '历史商品', quantity: 1 }],
  }), { idFactory: shipmentIds, now: '2026-08-02T10:00:00.000Z' }).state;
  shipmentState = Domain.applyOperation(shipmentState, operation('shipment.void', { id: 's_history' }), {
    idFactory: shipmentIds,
    now: '2026-08-03T10:00:00.000Z',
  }).state;
  assert.throws(() => Domain.applyOperation(shipmentState, operation('report.update', {
    ...updatePayload,
    items: [{ ...originalItems[0], actualPaymentCents: 101 }, originalItems[1]],
  }), { idFactory: shipmentIds }), /不能修改名称、数量或金额/);
  shipmentState = Domain.applyOperation(shipmentState, operation('report.update', updatePayload), { idFactory: shipmentIds }).state;
  assert.equal(shipmentState.reportItems.find((item) => item.id === 'i_history').status, 'void');
  assert.equal(Domain.isStateSnapshot(shipmentState), true);

  let refundState = Domain.emptyState();
  const refundIds = ids();
  refundState = Domain.applyOperation(refundState, operation('report.create', {
    report: { id: 'r_history', occurredAt: '2026-08-01', originalMessage: '' },
    items: originalItems,
  }), { idFactory: refundIds, now: '2026-08-01T10:00:00.000Z' }).state;
  refundState = Domain.applyOperation(refundState, operation('refund.create', {
    refund: { id: 'f_history', reportItemId: 'i_history', quantity: 1, refundedAt: '2026-08-02' },
  }), { idFactory: refundIds, now: '2026-08-02T10:00:00.000Z' }).state;
  refundState = Domain.applyOperation(refundState, operation('refund.void', { id: 'f_history' }), {
    idFactory: refundIds,
    now: '2026-08-03T10:00:00.000Z',
  }).state;
  refundState = Domain.applyOperation(refundState, operation('report.update', updatePayload), { idFactory: refundIds }).state;
  assert.equal(refundState.reportItems.find((item) => item.id === 'i_history').status, 'void');
  assert.equal(Domain.isStateSnapshot(refundState), true);
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

test('refund updates can move a record to another inventory batch and preserve exact cents', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', {
    report: { id: 'r_rounding', occurredAt: '2026-08-01' },
    items: [{ id: 'i_rounding', productName: '商品K', quantity: 3, actualPaymentCents: 100, expectedRefundCents: 0, expectedRebateCents: 0 }],
  }), { idFactory, now: '2026-08-01T10:00:00.000Z' }).state;
  state = Domain.applyOperation(state, operation('report.create', {
    report: { id: 'r_target', occurredAt: '2026-08-02' },
    items: [{ id: 'i_target', productName: '商品L', quantity: 1, actualPaymentCents: 200, expectedRefundCents: 0, expectedRebateCents: 0 }],
  }), { idFactory, now: '2026-08-02T10:00:00.000Z' }).state;

  for (const [id, refundedAt] of [['f1', '2026-08-03'], ['f2', '2026-08-04'], ['f3', '2026-08-05']]) {
    state = Domain.applyOperation(state, operation('refund.create', {
      refund: { id, reportItemId: 'i_rounding', quantity: 1, refundedAt },
    }), { idFactory, now: `${refundedAt}T10:00:00.000Z` }).state;
  }
  assert.deepEqual(state.refunds.map((refund) => refund.amountCents), [33, 34, 33]);
  assert.equal(state.refunds.reduce((sum, refund) => sum + refund.amountCents, 0), 100);

  state = Domain.applyOperation(state, operation('refund.update', {
    refund: { id: 'f1', reportItemId: 'i_target', quantity: 1, refundedAt: '2026-08-06' },
  }), { idFactory, now: '2026-08-06T10:00:00.000Z' }).state;
  assert.equal(state.refunds.find((refund) => refund.id === 'f1').reportItemId, 'i_target');
  assert.equal(state.refunds.find((refund) => refund.id === 'f1').amountCents, 200);
  assert.equal(state.refunds.filter((refund) => refund.reportItemId === 'i_rounding').reduce((sum, refund) => sum + refund.amountCents, 0), 67);
});

test('zero actual return can be recorded before closing a shipment', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r_zero', '商品M', 1, 100, 100, 0)), { idFactory }).state;
  state = Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's_zero', trackingNumber: 'TRACK-ZERO', shippingCostCents: 0, shippedAt: '2026-08-02' },
    items: [{ productName: '商品M', quantity: 1 }],
  }), { idFactory }).state;
  state = Domain.applyOperation(state, operation('settlement.create', {
    settlement: { id: 'settle_zero', shipmentId: 's_zero', amountCents: 0, settledAt: '2026-08-03' },
  }), { idFactory }).state;
  state = Domain.applyOperation(state, operation('shipment.close', { id: 's_zero' }), { idFactory, now: '2026-08-04' }).state;
  const view = Domain.shipmentView(state, state.shipments[0]);
  assert.equal(view.closed, true);
  assert.equal(view.settlementRecorded, true);
  assert.equal(view.returnedCents, 0);
});

test('voiding an open shipment also voids its actual returns', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r_void_settle', '商品N', 1, 100, 100, 0)), { idFactory }).state;
  state = Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's_void_settle', trackingNumber: 'TRACK-VOID', shippingCostCents: 0, shippedAt: '2026-08-02' },
    items: [{ productName: '商品N', quantity: 1 }],
  }), { idFactory }).state;
  state = Domain.applyOperation(state, operation('settlement.create', {
    settlement: { id: 'settle_void', shipmentId: 's_void_settle', amountCents: 100, settledAt: '2026-08-03' },
  }), { idFactory }).state;
  state = Domain.applyOperation(state, operation('shipment.void', { id: 's_void_settle' }), { idFactory, now: '2026-08-04' }).state;
  assert.equal(state.settlements[0].status, 'void');
  assert.equal(Domain.stats(state).returnedCents, 0);
});

test('numeric negative money is rejected', () => {
  assert.throws(() => Domain.parseMoney(-1, '金额'), /非负金额/);
});

test('unsafe integer inputs are rejected and large proportional allocations stay exact', () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  assert.equal(Domain.parseMoney('90071992547409.91', '金额'), maximum);
  assert.throws(() => Domain.parseMoney(maximum + 1, '金额'), /安全整数范围/);
  assert.throws(() => Domain.parseMoney('90071992547409.92', '金额'), /安全整数范围/);
  assert.throws(() => Domain.applyOperation(
    Domain.emptyState(),
    operation('report.create', reportPayload('r_unsafe', '商品超限', maximum + 1, 1, 1, 1)),
    { idFactory: ids() },
  ), /安全整数范围/);

  const totalCents = 6912341670100991;
  const totalQuantity = 5804638223728639;
  const refundedQuantity = 2292638615373818;
  assert.equal(Domain.amountForQuantity(totalCents, totalQuantity, refundedQuantity), 2730144554185731);

  const idFactory = ids();
  let state = Domain.applyOperation(Domain.emptyState(), operation('report.create', reportPayload(
    'r_large', '商品大数', totalQuantity, totalCents, 0, 0,
  )), { idFactory, now: '2026-08-01T10:00:00.000Z' }).state;
  state = Domain.applyOperation(state, operation('refund.create', {
    refund: { id: 'refund_large', reportItemId: 'r_large_item', quantity: refundedQuantity, refundedAt: '2026-08-02' },
  }), { idFactory, now: '2026-08-02T10:00:00.000Z' }).state;
  const remainingQuantity = totalQuantity - refundedQuantity;
  const [remaining] = Domain.previewShipmentAllocations(state, [{
    reportItemId: 'r_large_item',
    quantity: remainingQuantity,
  }]);
  assert.equal(state.refunds[0].amountCents, 2730144554185731);
  assert.equal(state.refunds[0].amountCents + remaining.actualPaymentCents, totalCents);
});

test('normalization releases allocations and returns attached to a void shipment', () => {
  const state = Domain.normalizeState({
    reports: [{ id: 'r_orphan', occurredAt: '2026-08-01', status: 'active' }],
    reportItems: [{ id: 'i_orphan', reportId: 'r_orphan', productName: '商品O', quantity: 1, actualPaymentCents: 100, expectedRefundCents: 100, expectedRebateCents: 0, status: 'active' }],
    shipments: [{ id: 's_orphan', trackingNumber: 'TRACK-ORPHAN', shippingCostCents: 0, shippedAt: '2026-08-02', status: 'void' }],
    shipmentItems: [{ id: 'si_orphan', shipmentId: 's_orphan', reportItemId: 'i_orphan', quantity: 1, status: 'active' }],
    settlements: [{ id: 'set_orphan', shipmentId: 's_orphan', amountCents: 100, settledAt: '2026-08-03', status: 'active' }],
    refunds: [],
  });
  assert.equal(state.shipmentItems[0].status, 'void');
  assert.equal(state.settlements[0].status, 'void');
  assert.equal(Domain.inventoryLots(state)[0].availableQuantity, 1);
});

test('sync queue removes only explicitly accepted operations and preserves later local work', () => {
  const queue = [
    { opId: 'op_a', type: 'report.create' },
    { opId: 'op_b', type: 'report.update' },
    { opId: 'op_c', type: 'report.void' },
    { opId: 'op_new', type: 'shipment.create' },
  ];
  const result = Domain.reconcilePushResult(queue, queue.slice(0, 3), {
    accepted: [{ opId: 'op_a' }],
    rejected: [{ opId: 'op_b', error: '服务器拒绝' }],
  });
  assert.deepEqual(result.accepted, ['op_a']);
  assert.deepEqual(result.rejected, [{ opId: 'op_b', error: '服务器拒绝' }]);
  assert.deepEqual(result.unconfirmed, ['op_c']);
  assert.deepEqual(result.queue.map((operation) => operation.opId), ['op_b', 'op_c', 'op_new']);
  assert.equal(result.queue[0].syncError, '服务器拒绝');
  assert.equal(result.queue[1].syncError, undefined);
});

test('sync batching is capped and stops behind a failed or malformed operation', () => {
  const queue = Array.from({ length: 201 }, (_, index) => ({ opId: `op_${index}`, type: 'report.create' }));
  assert.equal(Domain.pendingOperationBatch(queue).length, 100);
  assert.deepEqual(Domain.pendingOperationBatch([
    { opId: 'op_ok', type: 'report.create' },
    { opId: 'op_failed', type: 'report.update', syncError: '冲突' },
    { opId: 'op_later', type: 'report.void' },
  ]).map((operation) => operation.opId), ['op_ok']);
  assert.deepEqual(Domain.pendingOperationBatch([{ type: 'report.create' }, { opId: 'op_later', type: 'report.void' }]), []);
});

test('server state snapshots must contain every state collection', () => {
  assert.equal(Domain.isStateSnapshot(Domain.emptyState()), true);
  assert.equal(Domain.isStateSnapshot({}), false);
  assert.equal(Domain.isStateSnapshot({ ...Domain.emptyState(), schemaVersion: '1' }), false);
  assert.equal(Domain.isStateSnapshot({ ...Domain.emptyState(), settlements: null }), false);
  assert.equal(Domain.isStateSnapshot({ ...Domain.emptyState(), reportItems: [null] }), false);
  assert.equal(Domain.isStateSnapshot({ ...Domain.emptyState(), reportItems: [{}] }), false);

  const idFactory = ids();
  let state = Domain.applyOperation(
    Domain.emptyState(),
    operation('report.create', reportPayload('r_valid', '商品P', 2, 100, 50, 10)),
    { idFactory, now: '2026-08-01T11:00:00.000Z' },
  ).state;
  assert.equal(Domain.isStateSnapshot(state), true);

  const duplicate = Domain.clone(state);
  duplicate.reportItems.push(Domain.clone(duplicate.reportItems[0]));
  assert.equal(Domain.isStateSnapshot(duplicate), false);

  const dangling = Domain.clone(state);
  dangling.reportItems[0].reportId = 'missing_report';
  assert.equal(Domain.isStateSnapshot(dangling), false);

  const invalidMoney = Domain.clone(state);
  invalidMoney.reportItems[0].actualPaymentCents = -1;
  assert.equal(Domain.isStateSnapshot(invalidMoney), false);

  const activeItemUnderVoidReport = Domain.clone(state);
  activeItemUnderVoidReport.reports[0].status = 'void';
  assert.equal(Domain.isStateSnapshot(activeItemUnderVoidReport), false);

  const activeStatusWithDeletedAt = Domain.clone(state);
  activeStatusWithDeletedAt.reports[0].deletedAt = '2026-08-02T11:00:00.000Z';
  assert.equal(Domain.isStateSnapshot(activeStatusWithDeletedAt), false);

  const reportWithoutActiveItems = Domain.clone(state);
  reportWithoutActiveItems.reportItems[0].status = 'void';
  assert.equal(Domain.isStateSnapshot(reportWithoutActiveItems), false);

  const validRefundState = Domain.applyOperation(state, operation('refund.create', {
    refund: { id: 'refund_valid', reportItemId: 'r_valid_item', quantity: 1, refundedAt: '2026-08-02' },
  }), { idFactory, now: '2026-08-02T10:00:00.000Z' }).state;
  assert.equal(Domain.isStateSnapshot(validRefundState), true);
  const wrongRefundAmount = Domain.clone(validRefundState);
  wrongRefundAmount.refunds[0].amountCents += 1;
  assert.equal(Domain.isStateSnapshot(wrongRefundAmount), false);
  const activeRefundUnderVoidItem = Domain.clone(validRefundState);
  activeRefundUnderVoidItem.reportItems[0].status = 'void';
  assert.equal(Domain.isStateSnapshot(activeRefundUnderVoidItem), false);

  state = Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's_valid', trackingNumber: 'TRACK-VALID', shippingCostCents: 0, shippedAt: '2026-08-02' },
    items: [{ productName: '商品P', quantity: 2 }],
  }), { idFactory, now: '2026-08-02T11:00:00.000Z' }).state;
  const overAllocated = Domain.clone(state);
  overAllocated.refunds.push({
    id: 'refund_over',
    reportItemId: 'r_valid_item',
    quantity: 1,
    amountCents: 50,
    refundedAt: '2026-08-03',
    note: '',
    createdAt: '2026-08-03T11:00:00.000Z',
    updatedAt: '2026-08-03T11:00:00.000Z',
    status: 'active',
  });
  assert.equal(Domain.isStateSnapshot(overAllocated), false);

  const activeAllocationUnderVoidShipment = Domain.clone(state);
  activeAllocationUnderVoidShipment.shipments[0].status = 'void';
  assert.equal(Domain.isStateSnapshot(activeAllocationUnderVoidShipment), false);

  const shipmentWithoutActiveItems = Domain.clone(state);
  shipmentWithoutActiveItems.shipmentItems[0].status = 'void';
  assert.equal(Domain.isStateSnapshot(shipmentWithoutActiveItems), false);

  const closedWithoutSettlement = Domain.clone(state);
  closedWithoutSettlement.shipments[0].closedAt = '2026-08-03T11:00:00.000Z';
  assert.equal(Domain.isStateSnapshot(closedWithoutSettlement), false);

  let closedState = Domain.applyOperation(state, operation('settlement.create', {
    settlement: { id: 'settlement_valid', shipmentId: 's_valid', amountCents: 0, settledAt: '2026-08-03' },
  }), { idFactory, now: '2026-08-03T11:00:00.000Z' }).state;
  closedState = Domain.applyOperation(closedState, operation('shipment.close', { id: 's_valid' }), {
    idFactory,
    now: '2026-08-04T11:00:00.000Z',
  }).state;
  assert.equal(Domain.isStateSnapshot(closedState), true);

  const activeSettlementUnderVoidShipment = Domain.clone(closedState);
  activeSettlementUnderVoidShipment.shipments[0].status = 'void';
  activeSettlementUnderVoidShipment.shipments[0].closedAt = null;
  activeSettlementUnderVoidShipment.shipmentItems[0].status = 'void';
  assert.equal(Domain.isStateSnapshot(activeSettlementUnderVoidShipment), false);

  const closedVoidShipment = Domain.clone(closedState);
  closedVoidShipment.shipments[0].status = 'void';
  closedVoidShipment.shipmentItems[0].status = 'void';
  closedVoidShipment.settlements[0].status = 'void';
  assert.equal(Domain.isStateSnapshot(closedVoidShipment), false);
});

test('shipment, inventory and refund allocations conserve every cent', () => {
  let state = Domain.emptyState();
  const idFactory = ids();
  state = Domain.applyOperation(state, operation('report.create', reportPayload('r_cent', '商品Q', 2, 1, 1, 1)), {
    idFactory,
    now: '2026-08-01T11:00:00.000Z',
  }).state;

  const firstAllocations = Domain.allocateFifo(state, [{ productName: '商品Q', quantity: 1 }]);
  const firstPreview = Domain.previewShipmentAllocations(state, firstAllocations);
  assert.deepEqual(firstPreview.map((row) => [row.actualPaymentCents, row.expectedRefundCents, row.expectedRebateCents]), [[0, 0, 0]]);

  state = Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's_cent_1', trackingNumber: 'TRACK-CENT-1', shippingCostCents: 0, shippedAt: '2026-08-02' },
    items: [{ productName: '商品Q', quantity: 1 }],
  }), { idFactory, now: '2026-08-02T11:00:00.000Z' }).state;
  let summary = Domain.stats(state);
  assert.equal(Domain.shipmentView(state, state.shipments[0]).actualPaymentCents, 0);
  assert.equal(summary.totalPurchaseCents, 1);
  assert.equal(summary.pendingShipmentPurchaseCents, 1);

  state = Domain.applyOperation(state, operation('shipment.create', {
    shipment: { id: 's_cent_2', trackingNumber: 'TRACK-CENT-2', shippingCostCents: 0, shippedAt: '2026-08-03' },
    items: [{ productName: '商品Q', quantity: 1 }],
  }), { idFactory, now: '2026-08-03T11:00:00.000Z' }).state;
  const views = state.shipments.map((shipment) => Domain.shipmentView(state, shipment));
  assert.deepEqual(views.map((view) => view.actualPaymentCents), [0, 1]);
  assert.equal(views.reduce((sum, view) => sum + view.actualPaymentCents, 0), 1);
  assert.equal(views.reduce((sum, view) => sum + view.expectedRefundCents, 0), 1);
  assert.equal(views.reduce((sum, view) => sum + view.expectedRebateCents, 0), 1);
  summary = Domain.stats(state);
  assert.equal(summary.pendingShipmentPurchaseCents, 0);

  let refundState = Domain.emptyState();
  refundState = Domain.applyOperation(refundState, operation('report.create', reportPayload('r_refund_cent', '商品R', 2, 1, 1, 1)), {
    idFactory,
    now: '2026-08-01T11:00:00.000Z',
  }).state;
  const inventoryState = Domain.applyOperation(refundState, operation('refund.create', {
    refund: { id: 'refund_inventory_cent', reportItemId: 'r_refund_cent_item', quantity: 1, refundedAt: '2026-08-02' },
  }), { idFactory, now: '2026-08-02T10:00:00.000Z' }).state;
  const [remainingLot] = Domain.inventoryLots(inventoryState);
  assert.equal(remainingLot.availableActualPaymentCents, 0);
  assert.equal(remainingLot.availableExpectedRefundCents, 0);
  assert.equal(remainingLot.availableExpectedRebateCents, 0);
  refundState = Domain.applyOperation(refundState, operation('shipment.create', {
    shipment: { id: 's_refund_cent', trackingNumber: 'TRACK-REFUND-CENT', shippingCostCents: 0, shippedAt: '2026-08-02' },
    items: [{ productName: '商品R', quantity: 1 }],
  }), { idFactory, now: '2026-08-02T11:00:00.000Z' }).state;
  refundState = Domain.applyOperation(refundState, operation('refund.create', {
    refund: { id: 'refund_cent', reportItemId: 'r_refund_cent_item', quantity: 1, refundedAt: '2026-08-03' },
  }), { idFactory, now: '2026-08-03T11:00:00.000Z' }).state;
  const refundView = Domain.shipmentView(refundState, refundState.shipments[0]);
  const refundSummary = Domain.stats(refundState);
  assert.equal(refundState.refunds[0].amountCents, 1);
  assert.equal(refundView.actualPaymentCents, 0);
  assert.equal(refundSummary.totalPurchaseCents, 0);
  assert.equal(refundSummary.expectedRefundCents, 0);
  assert.equal(refundSummary.expectedRebateCents, 0);
});

test('operations cannot inject identifiers or timestamps that corrupt a snapshot', () => {
  const base = Domain.emptyState();
  const invalidId = operation('report.create', reportPayload('invalid_shape', '商品S', 1, 100, 120, 5));
  invalidId.payload.report.id = 123;
  assert.throws(
    () => Domain.applyOperation(base, invalidId, {
      idFactory: ids(),
      now: '2026-08-01T11:00:00.000Z',
    }),
    /操作产生了无效数据/,
  );
  assert.deepEqual(base, Domain.emptyState());

  const invalidTime = operation('report.create', reportPayload('invalid_time', '商品T', 1, 100, 120, 5));
  invalidTime.payload.report.createdAt = { injected: true };
  assert.throws(
    () => Domain.applyOperation(base, invalidTime, {
      idFactory: ids(),
      now: '2026-08-01T11:00:00.000Z',
    }),
    /操作产生了无效数据/,
  );
  assert.deepEqual(base, Domain.emptyState());
});
