(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OrderDomain = factory();
  }
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;

  function emptyState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      reports: [],
      reportItems: [],
      shipments: [],
      shipmentItems: [],
      settlements: [],
      refunds: [],
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeState(input) {
    const state = input && typeof input === 'object' ? clone(input) : emptyState();
    const base = emptyState();
    for (const key of Object.keys(base)) {
      if (!Array.isArray(base[key])) state[key] = base[key];
      else if (!Array.isArray(state[key])) state[key] = [];
    }
    state.schemaVersion = SCHEMA_VERSION;
    return state;
  }

  function makeId(prefix) {
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix || 'id'}_${Date.now().toString(36)}_${random}`;
  }

  function isoNow() {
    return new Date().toISOString();
  }

  function isActive(row) {
    return Boolean(row) && row.status !== 'void' && !row.deletedAt;
  }

  function asNonNegativeInt(value, field) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
      throw new Error(`${field} 必须是非负整数`);
    }
    return number;
  }

  function asPositiveInt(value, field) {
    const number = asNonNegativeInt(value, field);
    if (number < 1) throw new Error(`${field} 必须大于 0`);
    return number;
  }

  function parseMoney(value, field) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    const text = String(value ?? '').trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
      throw new Error(`${field} 必须是非负金额，最多两位小数`);
    }
    const [yuan, fraction = ''] = text.split('.');
    return Number(yuan) * 100 + Number((fraction + '00').slice(0, 2));
  }

  function formatMoney(cents) {
    const number = Number(cents || 0);
    return (number / 100).toFixed(2);
  }

  function amountForQuantity(totalCents, totalQuantity, quantity) {
    if (!totalQuantity || !quantity) return 0;
    return Math.round(Number(totalCents || 0) * Number(quantity) / Number(totalQuantity));
  }

  function text(value, field, required = true) {
    const result = String(value ?? '').trim();
    if (required && !result) throw new Error(`${field} 不能为空`);
    return result;
  }

  function reportById(state, id) {
    return state.reports.find((row) => row.id === id && isActive(row));
  }

  function itemById(state, id) {
    return state.reportItems.find((row) => row.id === id && isActive(row));
  }

  function shipmentById(state, id) {
    return state.shipments.find((row) => row.id === id && isActive(row));
  }

  function reportItems(state, reportId) {
    return state.reportItems.filter((row) => row.reportId === reportId && isActive(row));
  }

  function shipmentItemQuantity(state, reportItemId, excludeShipmentId) {
    return state.shipmentItems
      .filter((row) => row.reportItemId === reportItemId && isActive(row) && row.shipmentId !== excludeShipmentId)
      .reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  }

  function refundQuantity(state, reportItemId) {
    return state.refunds
      .filter((row) => row.reportItemId === reportItemId && isActive(row))
      .reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  }

  function inventoryLots(state, options = {}) {
    const excludeShipmentId = options.excludeShipmentId || null;
    return state.reportItems
      .filter((item) => isActive(item) && isActive(reportById(state, item.reportId)))
      .map((item) => {
        const shipped = shipmentItemQuantity(state, item.id, excludeShipmentId);
        const refunded = refundQuantity(state, item.id);
        return {
          reportItemId: item.id,
          reportId: item.reportId,
          productName: item.productName,
          sourceDate: reportById(state, item.reportId)?.occurredAt || '',
          sourceMessage: reportById(state, item.reportId)?.originalMessage || '',
          quantity: Number(item.quantity || 0),
          shippedQuantity: shipped,
          refundedQuantity: refunded,
          availableQuantity: Number(item.quantity || 0) - shipped - refunded,
          actualPaymentCents: Number(item.actualPaymentCents || 0),
          expectedRefundCents: Number(item.expectedRefundCents || 0),
          expectedRebateCents: Number(item.expectedRebateCents || 0),
        };
      })
      .filter((row) => row.availableQuantity > 0)
      .sort((a, b) => {
        const date = String(a.sourceDate).localeCompare(String(b.sourceDate));
        return date || a.reportItemId.localeCompare(b.reportItemId);
      });
  }

  function aggregateInventory(state, options = {}) {
    const byProduct = new Map();
    for (const lot of inventoryLots(state, options)) {
      const current = byProduct.get(lot.productName) || {
        productName: lot.productName,
        availableQuantity: 0,
        lots: [],
      };
      current.availableQuantity += lot.availableQuantity;
      current.lots.push(lot);
      byProduct.set(lot.productName, current);
    }
    return [...byProduct.values()].sort((a, b) => a.productName.localeCompare(b.productName));
  }

  function allocateFifo(state, requestedLines, options = {}) {
    const requested = Array.isArray(requestedLines) ? requestedLines : [];
    if (!requested.length) throw new Error('至少添加一项快递商品');
    const available = inventoryLots(state, options);
    const allocations = [];
    const remainingByItem = new Map(available.map((lot) => [lot.reportItemId, lot.availableQuantity]));

    for (const line of requested) {
      const productName = text(line.productName, '商品名称');
      let remaining = asPositiveInt(line.quantity, `${productName} 数量`);
      const lots = available.filter((lot) => lot.productName === productName);
      for (const lot of lots) {
        const lotRemaining = remainingByItem.get(lot.reportItemId) || 0;
        if (!lotRemaining) continue;
        const take = Math.min(lotRemaining, remaining);
        allocations.push({ reportItemId: lot.reportItemId, quantity: take });
        remainingByItem.set(lot.reportItemId, lotRemaining - take);
        remaining -= take;
        if (!remaining) break;
      }
      if (remaining) throw new Error(`${productName} 剩余库存不足，还缺 ${remaining} 件`);
    }
    return allocations;
  }

  function validateItemPayload(raw, idFactory) {
    const item = raw || {};
    const productName = text(item.productName, '物品名称');
    const quantity = asPositiveInt(item.quantity, `${productName} 数量`);
    return {
      id: item.id || idFactory('item'),
      productName,
      quantity,
      actualPaymentCents: parseMoney(item.actualPaymentCents ?? 0, `${productName} 实际付款`),
      expectedRefundCents: parseMoney(item.expectedRefundCents ?? 0, `${productName} 预计返款`),
      expectedRebateCents: parseMoney(item.expectedRebateCents ?? 0, `${productName} 预计返利`),
    };
  }

  function addReport(state, payload, now, idFactory) {
    const input = payload.report || payload;
    const id = input.id || idFactory('report');
    if (state.reports.some((row) => row.id === id)) throw new Error('报单编号已存在');
    const report = {
      id,
      occurredAt: text(input.occurredAt, '报单时间'),
      originalMessage: text(input.originalMessage, '原消息文本', false),
      createdAt: input.createdAt || now,
      updatedAt: now,
      status: 'active',
    };
    const items = (payload.items || []).map((item) => ({ ...validateItemPayload(item, idFactory), reportId: id, createdAt: now, updatedAt: now, status: 'active' }));
    if (!items.length) throw new Error('报单至少需要一个商品');
    state.reports.push(report);
    state.reportItems.push(...items);
    return { state, result: { id, itemIds: items.map((item) => item.id) } };
  }

  function updateReport(state, payload, now, idFactory) {
    const input = payload.report || payload;
    const report = reportById(state, input.id);
    if (!report) throw new Error('报单不存在');
    const incomingItems = (payload.items || []).map((item) => validateItemPayload(item, idFactory));
    if (!incomingItems.length) throw new Error('报单至少需要一个商品');
    const existingItems = reportItems(state, report.id);
    const incomingIds = new Set(incomingItems.map((item) => item.id));
    for (const oldItem of existingItems) {
      if (!incomingIds.has(oldItem.id) && (shipmentItemQuantity(state, oldItem.id) || refundQuantity(state, oldItem.id))) {
        throw new Error(`商品“${oldItem.productName}”已出库或退款，不能删除`);
      }
    }
    Object.assign(report, {
      occurredAt: text(input.occurredAt, '报单时间'),
      originalMessage: text(input.originalMessage, '原消息文本', false),
      updatedAt: now,
    });
    state.reportItems = state.reportItems.filter((item) => item.reportId !== report.id || incomingIds.has(item.id));
    for (const item of incomingItems) {
      const old = state.reportItems.find((row) => row.id === item.id);
      const used = shipmentItemQuantity(state, item.id) + refundQuantity(state, item.id);
      if (old && item.quantity < used) throw new Error(`商品“${item.productName}”数量不能低于已出库/退款数量 ${used}`);
      const next = {
        ...item,
        reportId: report.id,
        createdAt: old?.createdAt || now,
        updatedAt: now,
        status: 'active',
      };
      if (old) Object.assign(old, next);
      else state.reportItems.push(next);
    }
    return { state, result: { id: report.id } };
  }

  function voidReport(state, payload, now) {
    const report = reportById(state, payload.id);
    if (!report) throw new Error('报单不存在');
    const used = reportItems(state, report.id).some((item) => shipmentItemQuantity(state, item.id) || refundQuantity(state, item.id));
    if (used) throw new Error('已有出库或退款记录的报单不能作废');
    report.status = 'void';
    report.updatedAt = now;
    for (const item of state.reportItems.filter((row) => row.reportId === report.id)) item.status = 'void';
    return { state, result: { id: report.id } };
  }

  function normalizeShipment(raw, idFactory, now) {
    const input = raw || {};
    return {
      id: input.id || idFactory('shipment'),
      trackingNumber: text(input.trackingNumber, '快递单号'),
      shippingCostCents: parseMoney(input.shippingCostCents ?? 0, '快递价格'),
      shippedAt: text(input.shippedAt, '发出时间'),
      note: text(input.note, '备注', false),
      createdAt: input.createdAt || now,
      updatedAt: now,
      status: 'active',
    };
  }

  function addShipment(state, payload, now, idFactory) {
    const shipment = normalizeShipment(payload.shipment || payload, idFactory, now);
    if (state.shipments.some((row) => row.id === shipment.id)) throw new Error('快递编号已存在');
    const allocations = allocateFifo(state, payload.items, {});
    state.shipments.push(shipment);
    state.shipmentItems.push(...allocations.map((allocation) => ({
      id: idFactory('shipment_item'),
      shipmentId: shipment.id,
      reportItemId: allocation.reportItemId,
      quantity: allocation.quantity,
      createdAt: now,
      status: 'active',
    })));
    return { state, result: { id: shipment.id, allocations } };
  }

  function updateShipment(state, payload, now, idFactory) {
    const input = payload.shipment || payload;
    const shipment = shipmentById(state, input.id);
    if (!shipment) throw new Error('快递不存在');
    const next = normalizeShipment({ ...shipment, ...input, id: shipment.id, createdAt: shipment.createdAt }, idFactory, now);
    const allocations = allocateFifo(state, payload.items, { excludeShipmentId: shipment.id });
    Object.assign(shipment, next, { updatedAt: now });
    state.shipmentItems = state.shipmentItems.filter((item) => item.shipmentId !== shipment.id);
    state.shipmentItems.push(...allocations.map((allocation) => ({
      id: idFactory('shipment_item'),
      shipmentId: shipment.id,
      reportItemId: allocation.reportItemId,
      quantity: allocation.quantity,
      createdAt: now,
      status: 'active',
    })));
    return { state, result: { id: shipment.id, allocations } };
  }

  function voidShipment(state, payload, now) {
    const shipment = shipmentById(state, payload.id);
    if (!shipment) throw new Error('快递不存在');
    shipment.status = 'void';
    shipment.updatedAt = now;
    for (const item of state.shipmentItems.filter((row) => row.shipmentId === shipment.id)) item.status = 'void';
    return { state, result: { id: shipment.id } };
  }

  function addSettlement(state, payload, now, idFactory) {
    const input = payload.settlement || payload;
    if (!shipmentById(state, input.shipmentId)) throw new Error('快递不存在');
    const amountCents = parseMoney(input.amountCents ?? 0, '实际返款金额');
    if (amountCents < 1) throw new Error('实际返款金额必须大于 0');
    const settlement = {
      id: input.id || idFactory('settlement'),
      shipmentId: input.shipmentId,
      amountCents,
      settledAt: text(input.settledAt, '返款时间'),
      note: text(input.note, '备注', false),
      createdAt: input.createdAt || now,
      updatedAt: now,
      status: 'active',
    };
    state.settlements.push(settlement);
    return { state, result: { id: settlement.id } };
  }

  function updateSettlement(state, payload, now) {
    const input = payload.settlement || payload;
    const settlement = state.settlements.find((row) => row.id === input.id && isActive(row));
    if (!settlement) throw new Error('返款记录不存在');
    if (!shipmentById(state, settlement.shipmentId)) throw new Error('关联快递不存在');
    Object.assign(settlement, {
      amountCents: parseMoney(input.amountCents ?? settlement.amountCents, '实际返款金额'),
      settledAt: text(input.settledAt, '返款时间'),
      note: text(input.note, '备注', false),
      updatedAt: now,
    });
    if (settlement.amountCents < 1) throw new Error('实际返款金额必须大于 0');
    return { state, result: { id: settlement.id } };
  }

  function voidSettlement(state, payload, now) {
    const settlement = state.settlements.find((row) => row.id === payload.id && isActive(row));
    if (!settlement) throw new Error('返款记录不存在');
    settlement.status = 'void';
    settlement.updatedAt = now;
    return { state, result: { id: settlement.id } };
  }

  function addRefund(state, payload, now, idFactory) {
    const input = payload.refund || payload;
    const item = itemById(state, input.reportItemId);
    if (!item) throw new Error('库存批次不存在');
    const quantity = asPositiveInt(input.quantity, '退款数量');
    const available = inventoryLots(state).find((lot) => lot.reportItemId === item.id);
    if (!available || available.availableQuantity < quantity) {
      throw new Error(`可退款库存不足，当前剩余 ${available?.availableQuantity || 0} 件`);
    }
    const refund = {
      id: input.id || idFactory('refund'),
      reportItemId: item.id,
      quantity,
      amountCents: parseMoney(input.amountCents ?? 0, '退款金额'),
      refundedAt: text(input.refundedAt, '退款时间'),
      note: text(input.note, '备注', false),
      createdAt: input.createdAt || now,
      updatedAt: now,
      status: 'active',
    };
    state.refunds.push(refund);
    return { state, result: { id: refund.id } };
  }

  function updateRefund(state, payload, now) {
    const input = payload.refund || payload;
    const refund = state.refunds.find((row) => row.id === input.id && isActive(row));
    if (!refund) throw new Error('退款记录不存在');
    const item = itemById(state, refund.reportItemId);
    if (!item) throw new Error('库存批次不存在');
    const nextQuantity = asPositiveInt(input.quantity, '退款数量');
    const otherRefunded = refundQuantity(state, item.id) - refund.quantity;
    const shipped = shipmentItemQuantity(state, item.id);
    if (nextQuantity + otherRefunded + shipped > item.quantity) throw new Error('退款数量超过可用库存');
    Object.assign(refund, {
      quantity: nextQuantity,
      amountCents: parseMoney(input.amountCents ?? refund.amountCents, '退款金额'),
      refundedAt: text(input.refundedAt, '退款时间'),
      note: text(input.note, '备注', false),
      updatedAt: now,
    });
    return { state, result: { id: refund.id } };
  }

  function voidRefund(state, payload, now) {
    const refund = state.refunds.find((row) => row.id === payload.id && isActive(row));
    if (!refund) throw new Error('退款记录不存在');
    refund.status = 'void';
    refund.updatedAt = now;
    return { state, result: { id: refund.id } };
  }

  function applyOperation(inputState, operation, options = {}) {
    const state = normalizeState(inputState);
    const now = options.now || isoNow();
    const idFactory = options.idFactory || makeId;
    if (!operation || !operation.type) throw new Error('同步操作缺少类型');
    switch (operation.type) {
      case 'report.create': return addReport(state, operation.payload || {}, now, idFactory);
      case 'report.update': return updateReport(state, operation.payload || {}, now, idFactory);
      case 'report.void': return voidReport(state, operation.payload || {}, now);
      case 'shipment.create': return addShipment(state, operation.payload || {}, now, idFactory);
      case 'shipment.update': return updateShipment(state, operation.payload || {}, now, idFactory);
      case 'shipment.void': return voidShipment(state, operation.payload || {}, now);
      case 'settlement.create': return addSettlement(state, operation.payload || {}, now, idFactory);
      case 'settlement.update': return updateSettlement(state, operation.payload || {}, now);
      case 'settlement.void': return voidSettlement(state, operation.payload || {}, now);
      case 'refund.create': return addRefund(state, operation.payload || {}, now, idFactory);
      case 'refund.update': return updateRefund(state, operation.payload || {}, now);
      case 'refund.void': return voidRefund(state, operation.payload || {}, now);
      default: throw new Error(`不支持的操作类型: ${operation.type}`);
    }
  }

  function stats(state) {
    const activeReports = new Set(state.reports.filter(isActive).map((row) => row.id));
    const totalPurchaseCents = state.reportItems
      .filter((item) => isActive(item) && activeReports.has(item.reportId))
      .reduce((sum, item) => {
        const refunded = refundQuantity(state, item.id);
        return sum + amountForQuantity(item.actualPaymentCents, item.quantity, item.quantity - refunded);
      }, 0);
    const totalShippingCents = state.shipments
      .filter(isActive)
      .reduce((sum, shipment) => sum + Number(shipment.shippingCostCents || 0), 0);
    let expectedIncomeCents = 0;
    for (const allocation of state.shipmentItems.filter(isActive)) {
      const shipment = shipmentById(state, allocation.shipmentId);
      const item = itemById(state, allocation.reportItemId);
      if (!shipment || !item) continue;
      expectedIncomeCents += amountForQuantity(item.expectedRefundCents, item.quantity, allocation.quantity);
      expectedIncomeCents += amountForQuantity(item.expectedRebateCents, item.quantity, allocation.quantity);
    }
    const returnedCents = state.settlements
      .filter((settlement) => isActive(settlement) && shipmentById(state, settlement.shipmentId))
      .reduce((sum, settlement) => sum + Number(settlement.amountCents || 0), 0);
    const outstandingCents = Math.max(expectedIncomeCents - returnedCents, 0);
    const profitCents = outstandingCents + returnedCents;
    const pureProfitCents = profitCents - totalShippingCents;
    return {
      totalPurchaseCents,
      totalShippingCents,
      expectedIncomeCents,
      outstandingCents,
      returnedCents,
      profitCents,
      pureProfitCents,
      rate: totalPurchaseCents ? pureProfitCents / totalPurchaseCents : 0,
    };
  }

  function shipmentView(state, shipment) {
    const items = state.shipmentItems
      .filter((item) => item.shipmentId === shipment.id && isActive(item))
      .map((allocation) => {
        const source = itemById(state, allocation.reportItemId);
        return {
          ...allocation,
          productName: source?.productName || '已删除商品',
          expectedRefundCents: source ? amountForQuantity(source.expectedRefundCents, source.quantity, allocation.quantity) : 0,
          expectedRebateCents: source ? amountForQuantity(source.expectedRebateCents, source.quantity, allocation.quantity) : 0,
          actualPaymentCents: source ? amountForQuantity(source.actualPaymentCents, source.quantity, allocation.quantity) : 0,
        };
      });
    const settlements = state.settlements.filter((row) => row.shipmentId === shipment.id && isActive(row));
    return {
      shipment,
      items,
      settlements,
      expectedRefundCents: items.reduce((sum, item) => sum + item.expectedRefundCents, 0),
      expectedRebateCents: items.reduce((sum, item) => sum + item.expectedRebateCents, 0),
      returnedCents: settlements.reduce((sum, row) => sum + Number(row.amountCents || 0), 0),
    };
  }

  return {
    SCHEMA_VERSION,
    emptyState,
    normalizeState,
    clone,
    makeId,
    isoNow,
    isActive,
    parseMoney,
    formatMoney,
    amountForQuantity,
    inventoryLots,
    aggregateInventory,
    allocateFifo,
    applyOperation,
    stats,
    shipmentView,
    reportById,
    itemById,
    refundQuantity,
    shipmentItemQuantity,
  };
});
