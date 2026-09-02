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

  function isStateSnapshot(value) {
    if (!value || typeof value !== 'object' || value.schemaVersion !== SCHEMA_VERSION) return false;
    const collections = ['reports', 'reportItems', 'shipments', 'shipmentItems', 'settlements', 'refunds'];
    if (!collections.every((key) => Array.isArray(value[key])
      && value[key].every((row) => row && typeof row === 'object' && !Array.isArray(row)))) return false;

    const string = (input, allowEmpty = false) => typeof input === 'string' && (allowEmpty || Boolean(input.trim()));
    const optionalString = (input) => input === undefined || input === null || string(input, true);
    const integer = (input, positive = false) => Number.isSafeInteger(input) && input >= (positive ? 1 : 0);
    const status = (input) => input === 'active' || input === 'void';
    const timestamps = (row, updated = true) => string(row.createdAt)
      && (!updated || string(row.updatedAt));

    if (!value.reports.every((row) => string(row.id)
      && string(row.occurredAt)
      && string(row.originalMessage, true)
      && timestamps(row)
      && status(row.status))) return false;
    if (!value.reportItems.every((row) => string(row.id)
      && string(row.reportId)
      && string(row.productName)
      && optionalString(row.note)
      && integer(row.quantity, true)
      && integer(row.actualPaymentCents)
      && integer(row.expectedRefundCents)
      && integer(row.expectedRebateCents)
      && timestamps(row)
      && status(row.status))) return false;
    if (!value.shipments.every((row) => string(row.id)
      && string(row.trackingNumber)
      && integer(row.shippingCostCents)
      && string(row.shippedAt)
      && optionalString(row.note)
      && optionalString(row.closedAt)
      && timestamps(row)
      && status(row.status))) return false;
    if (!value.shipmentItems.every((row) => string(row.id)
      && string(row.shipmentId)
      && string(row.reportItemId)
      && integer(row.quantity, true)
      && timestamps(row, false)
      && status(row.status))) return false;
    if (!value.settlements.every((row) => string(row.id)
      && string(row.shipmentId)
      && integer(row.amountCents)
      && string(row.settledAt)
      && optionalString(row.note)
      && timestamps(row)
      && status(row.status))) return false;
    if (!value.refunds.every((row) => string(row.id)
      && string(row.reportItemId)
      && integer(row.quantity, true)
      && integer(row.amountCents)
      && string(row.refundedAt)
      && optionalString(row.note)
      && timestamps(row)
      && status(row.status))) return false;
    if (collections.some((key) => value[key].some((row) => row.status === 'active' && row.deletedAt))) return false;

    const idsByCollection = new Map();
    for (const key of collections) {
      const ids = new Set(value[key].map((row) => row.id));
      if (ids.size !== value[key].length) return false;
      idsByCollection.set(key, ids);
    }
    const reportIds = idsByCollection.get('reports');
    const reportItemIds = idsByCollection.get('reportItems');
    const shipmentIds = idsByCollection.get('shipments');
    if (!value.reportItems.every((row) => reportIds.has(row.reportId))) return false;
    if (!value.shipmentItems.every((row) => shipmentIds.has(row.shipmentId) && reportItemIds.has(row.reportItemId))) return false;
    if (!value.settlements.every((row) => shipmentIds.has(row.shipmentId))) return false;
    if (!value.refunds.every((row) => reportItemIds.has(row.reportItemId))) return false;

    const activeReportIds = new Set(value.reports.filter(isActive).map((row) => row.id));
    const activeReportItemIds = new Set(value.reportItems
      .filter((row) => isActive(row) && activeReportIds.has(row.reportId))
      .map((row) => row.id));
    const activeShipmentIds = new Set(value.shipments.filter(isActive).map((row) => row.id));
    if (!value.reportItems.every((row) => !isActive(row) || activeReportIds.has(row.reportId))) return false;
    if (!value.shipmentItems.every((row) => !isActive(row)
      || (activeShipmentIds.has(row.shipmentId) && activeReportItemIds.has(row.reportItemId)))) return false;
    if (!value.settlements.every((row) => !isActive(row) || activeShipmentIds.has(row.shipmentId))) return false;
    if (!value.refunds.every((row) => !isActive(row) || activeReportItemIds.has(row.reportItemId))) return false;

    const reportsWithActiveItems = new Set(value.reportItems.filter(isActive).map((row) => row.reportId));
    if (![...activeReportIds].every((id) => reportsWithActiveItems.has(id))) return false;
    const shipmentsWithActiveItems = new Set(value.shipmentItems.filter(isActive).map((row) => row.shipmentId));
    if (![...activeShipmentIds].every((id) => shipmentsWithActiveItems.has(id))) return false;
    const shipmentsWithActiveSettlements = new Set(value.settlements.filter(isActive).map((row) => row.shipmentId));
    if (!value.shipments.every((row) => !isActive(row) || !row.closedAt
      || shipmentsWithActiveSettlements.has(row.id))) return false;
    if (value.shipments.some((row) => !isActive(row) && row.closedAt)) return false;

    const usedQuantity = new Map();
    for (const allocation of value.shipmentItems.filter((row) => isActive(row) && activeShipmentIds.has(row.shipmentId))) {
      usedQuantity.set(allocation.reportItemId, (usedQuantity.get(allocation.reportItemId) || 0) + allocation.quantity);
    }
    for (const refund of value.refunds.filter(isActive)) {
      usedQuantity.set(refund.reportItemId, (usedQuantity.get(refund.reportItemId) || 0) + refund.quantity);
    }
    if (!value.reportItems.every((item) => (usedQuantity.get(item.id) || 0) <= item.quantity)) return false;

    for (const item of value.reportItems.filter((row) => activeReportItemIds.has(row.id))) {
      const refunds = value.refunds
        .filter((row) => isActive(row) && row.reportItemId === item.id)
        .sort((a, b) => refundSortKey(a).localeCompare(refundSortKey(b)));
      let cumulativeQuantity = 0;
      let cumulativeAmount = 0;
      for (const refund of refunds) {
        cumulativeQuantity += refund.quantity;
        const targetAmount = amountForQuantity(item.actualPaymentCents, item.quantity, cumulativeQuantity);
        if (refund.amountCents !== targetAmount - cumulativeAmount) return false;
        cumulativeAmount = targetAmount;
      }
    }
    return true;
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
    for (const item of state.reportItems) {
      if (typeof item.note !== 'string') item.note = '';
    }
    for (const shipment of state.shipments) {
      if (typeof shipment.closedAt !== 'string' || !shipment.closedAt) shipment.closedAt = null;
    }
    const activeShipmentIds = new Set(state.shipments.filter(isActive).map((shipment) => shipment.id));
    for (const item of state.shipmentItems) {
      if (isActive(item) && !activeShipmentIds.has(item.shipmentId)) item.status = 'void';
    }
    for (const settlement of state.settlements) {
      if (isActive(settlement) && !activeShipmentIds.has(settlement.shipmentId)) settlement.status = 'void';
    }
    for (const item of state.reportItems) refreshRefundAmounts(state, item.id);
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
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error(`${field} 必须是非负整数且不能超过安全整数范围`);
    }
    return number;
  }

  function asPositiveInt(value, field) {
    const number = asNonNegativeInt(value, field);
    if (number < 1) throw new Error(`${field} 必须大于 0`);
    return number;
  }

  function parseMoney(value, field) {
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      if (value < 0) throw new Error(`${field} 必须是非负金额，最多两位小数且不能超过安全整数范围`);
      return value;
    }
    const text = String(value ?? '').trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
      throw new Error(`${field} 必须是非负金额，最多两位小数且不能超过安全整数范围`);
    }
    const [yuan, fraction = ''] = text.split('.');
    const cents = Number(`${yuan}${(fraction + '00').slice(0, 2)}`);
    if (!Number.isSafeInteger(cents)) {
      throw new Error(`${field} 必须是非负金额，最多两位小数且不能超过安全整数范围`);
    }
    return cents;
  }

  function formatMoney(cents) {
    const number = Number(cents || 0);
    return (number / 100).toFixed(2);
  }

  function amountForQuantity(totalCents, totalQuantity, quantity) {
    const cents = asNonNegativeInt(totalCents ?? 0, '分摊总金额');
    const total = asNonNegativeInt(totalQuantity ?? 0, '分摊总数量');
    const count = asNonNegativeInt(quantity ?? 0, '分摊数量');
    if (count > total) throw new Error('分摊数量不能超过总数量');
    if (!total || !count || !cents) return 0;
    const denominator = BigInt(total);
    const rounded = (BigInt(cents) * BigInt(count) + denominator / BigInt(2)) / denominator;
    return Number(rounded);
  }

  function amountForTailQuantity(totalCents, totalQuantity, quantityBefore, quantity) {
    // Refunds consume the rounded prefix of a lot. Shipments consume its suffix,
    // leaving inventory in the middle so all three parts always conserve cents.
    const total = Number(totalQuantity || 0);
    const before = Number(quantityBefore || 0);
    const count = Number(quantity || 0);
    if (!total || !count) return 0;
    const upper = Math.max(total - before, 0);
    const lower = Math.max(upper - count, 0);
    return amountForQuantity(totalCents, total, upper) - amountForQuantity(totalCents, total, lower);
  }

  function text(value, field, required = true) {
    const result = String(value ?? '').trim();
    if (required && !result) throw new Error(`${field} 不能为空`);
    return result;
  }

  function ensureNewIds(state, collection, rows, label) {
    const seen = new Set();
    for (const row of rows) {
      if (!row.id || seen.has(row.id) || state[collection].some((existing) => existing.id === row.id)) {
        throw new Error(`${label}编号已存在`);
      }
      seen.add(row.id);
    }
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

  function ensureShipmentOpen(shipment) {
    if (shipment?.closedAt) throw new Error('快递已结单，请先撤销结单');
  }

  function reportItems(state, reportId) {
    return state.reportItems.filter((row) => row.reportId === reportId && isActive(row));
  }

  function itemHasReferences(state, reportItemId) {
    return state.shipmentItems.some((row) => row.reportItemId === reportItemId)
      || state.refunds.some((row) => row.reportItemId === reportItemId);
  }

  function shipmentItemQuantity(state, reportItemId, excludeShipmentId) {
    return state.shipmentItems
      .filter((row) => row.reportItemId === reportItemId && isActive(row) && isActive(shipmentById(state, row.shipmentId)) && row.shipmentId !== excludeShipmentId)
      .reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  }

  function refundSortKey(refund) {
    return [refund.createdAt || '', refund.refundedAt || ''].join('\u0000');
  }

  function refreshRefundAmounts(state, reportItemId) {
    const item = itemById(state, reportItemId);
    if (!item) return;
    const refunds = state.refunds
      .filter((row) => row.reportItemId === reportItemId && isActive(row))
      .sort((a, b) => refundSortKey(a).localeCompare(refundSortKey(b)));
    let cumulativeQuantity = 0;
    let cumulativeAmount = 0;
    for (const refund of refunds) {
      cumulativeQuantity += Number(refund.quantity || 0);
      const targetAmount = amountForQuantity(item.actualPaymentCents, item.quantity, Math.min(cumulativeQuantity, item.quantity));
      refund.amountCents = Math.max(targetAmount - cumulativeAmount, 0);
      cumulativeAmount += refund.amountCents;
    }
  }

  function refundQuantity(state, reportItemId) {
    return state.refunds
      .filter((row) => row.reportItemId === reportItemId && isActive(row))
      .reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  }

  function allocationFinancialValues(source, quantityBefore, quantity) {
    if (!source) {
      return { actualPaymentCents: 0, expectedRefundCents: 0, expectedRebateCents: 0 };
    }
    return {
      actualPaymentCents: amountForTailQuantity(source.actualPaymentCents, source.quantity, quantityBefore, quantity),
      expectedRefundCents: amountForTailQuantity(source.expectedRefundCents, source.quantity, quantityBefore, quantity),
      expectedRebateCents: amountForTailQuantity(source.expectedRebateCents, source.quantity, quantityBefore, quantity),
    };
  }

  function activeShipmentAllocations(state, excludeShipmentId = '') {
    // Shipment updates replace allocation rows, so use the stable parent order
    // instead of allocation insertion order when assigning rounding remainders.
    const shipmentOrder = new Map(state.shipments.map((shipment, index) => [shipment.id, index]));
    const allocationOrder = new Map(state.shipmentItems.map((allocation, index) => [allocation.id, index]));
    const activeShipmentIds = new Set(state.shipments.filter(isActive).map((shipment) => shipment.id));
    return state.shipmentItems.filter((allocation) => isActive(allocation)
      && activeShipmentIds.has(allocation.shipmentId)
      && allocation.shipmentId !== excludeShipmentId)
      .sort((left, right) => (shipmentOrder.get(left.shipmentId) - shipmentOrder.get(right.shipmentId))
        || (allocationOrder.get(left.id) - allocationOrder.get(right.id)));
  }

  function shipmentAllocationFinancialMap(state) {
    const shippedByItem = new Map();
    const valuesByAllocation = new Map();
    for (const allocation of activeShipmentAllocations(state)) {
      const source = itemById(state, allocation.reportItemId);
      const quantityBefore = shippedByItem.get(allocation.reportItemId) || 0;
      valuesByAllocation.set(allocation.id, allocationFinancialValues(source, quantityBefore, allocation.quantity));
      shippedByItem.set(allocation.reportItemId, quantityBefore + Number(allocation.quantity || 0));
    }
    return valuesByAllocation;
  }

  function previewShipmentAllocations(state, allocations, options = {}) {
    const excludeShipmentId = options.excludeShipmentId || '';
    const shipmentOrder = new Map(state.shipments.map((shipment, index) => [shipment.id, index]));
    const targetOrder = shipmentOrder.has(excludeShipmentId)
      ? shipmentOrder.get(excludeShipmentId)
      : state.shipments.length;
    const shippedByItem = new Map();
    const reservedByItem = new Map();
    for (const allocation of activeShipmentAllocations(state, excludeShipmentId)) {
      const quantity = Number(allocation.quantity || 0);
      reservedByItem.set(allocation.reportItemId, (reservedByItem.get(allocation.reportItemId) || 0) + quantity);
      if (shipmentOrder.get(allocation.shipmentId) < targetOrder) {
        shippedByItem.set(allocation.reportItemId, (shippedByItem.get(allocation.reportItemId) || 0) + quantity);
      }
    }
    const requestedByItem = new Map();
    return (Array.isArray(allocations) ? allocations : []).map((allocation) => {
      const source = itemById(state, allocation.reportItemId);
      if (!source) throw new Error('快递商品关联的库存批次不存在');
      const quantity = asPositiveInt(allocation.quantity, '快递商品数量');
      const requestedBefore = requestedByItem.get(allocation.reportItemId) || 0;
      if ((reservedByItem.get(allocation.reportItemId) || 0) + requestedBefore + quantity
        + refundQuantity(state, allocation.reportItemId) > source.quantity) {
        throw new Error(`${source.productName} 剩余库存不足`);
      }
      const quantityBefore = (shippedByItem.get(allocation.reportItemId) || 0) + requestedBefore;
      requestedByItem.set(allocation.reportItemId, requestedBefore + quantity);
      return { ...allocation, ...allocationFinancialValues(source, quantityBefore, quantity) };
    });
  }

  function inventoryLots(state, options = {}) {
    const excludeShipmentId = options.excludeShipmentId || null;
    const allocationValues = shipmentAllocationFinancialMap(state);
    const shippedValuesByItem = new Map();
    for (const allocation of activeShipmentAllocations(state)) {
      if (allocation.shipmentId === excludeShipmentId) continue;
      const values = allocationValues.get(allocation.id);
      const current = shippedValuesByItem.get(allocation.reportItemId)
        || { actualPaymentCents: 0, expectedRefundCents: 0, expectedRebateCents: 0 };
      current.actualPaymentCents += Number(values?.actualPaymentCents || 0);
      current.expectedRefundCents += Number(values?.expectedRefundCents || 0);
      current.expectedRebateCents += Number(values?.expectedRebateCents || 0);
      shippedValuesByItem.set(allocation.reportItemId, current);
    }
    return state.reportItems
      .filter((item) => isActive(item) && isActive(reportById(state, item.reportId)))
      .map((item) => {
        const shipped = shipmentItemQuantity(state, item.id, excludeShipmentId);
        const refunded = refundQuantity(state, item.id);
        const shippedValues = shippedValuesByItem.get(item.id)
          || { actualPaymentCents: 0, expectedRefundCents: 0, expectedRebateCents: 0 };
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
          availableActualPaymentCents: Math.max(Number(item.actualPaymentCents || 0)
            - amountForQuantity(item.actualPaymentCents, item.quantity, refunded)
            - shippedValues.actualPaymentCents, 0),
          availableExpectedRefundCents: Math.max(Number(item.expectedRefundCents || 0)
            - amountForQuantity(item.expectedRefundCents, item.quantity, refunded)
            - shippedValues.expectedRefundCents, 0),
          availableExpectedRebateCents: Math.max(Number(item.expectedRebateCents || 0)
            - amountForQuantity(item.expectedRebateCents, item.quantity, refunded)
            - shippedValues.expectedRebateCents, 0),
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
      note: text(item.note, '物品备注', false),
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
    ensureNewIds(state, 'reportItems', items, '商品');
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
    const allExistingItems = state.reportItems.filter((item) => item.reportId === report.id);
    const incomingIds = new Set(incomingItems.map((item) => item.id));
    if (incomingIds.size !== incomingItems.length) throw new Error('商品编号不能重复');
    for (const item of incomingItems) {
      const existing = state.reportItems.find((row) => row.id === item.id);
      if (existing && existing.reportId !== report.id) throw new Error('商品编号已属于其他报单');
      if (!existing && state.reportItems.some((row) => row.id === item.id)) throw new Error('商品编号已存在');
    }
    const occurredAt = text(input.occurredAt, '报单时间');
    const reportHasReferencedItems = allExistingItems.some((item) => itemHasReferences(state, item.id));
    if (reportHasReferencedItems && occurredAt !== report.occurredAt) {
      throw new Error('报单已有出库或退款记录，不能修改报单时间');
    }
    for (const oldItem of allExistingItems) {
      const used = shipmentItemQuantity(state, oldItem.id) + refundQuantity(state, oldItem.id);
      const incoming = incomingItems.find((item) => item.id === oldItem.id);
      const referenced = itemHasReferences(state, oldItem.id);
      if (isActive(oldItem) && !incomingIds.has(oldItem.id) && used) {
        throw new Error(`商品“${oldItem.productName}”已出库或退款，不能删除`);
      }
      if (incoming && referenced && ['productName', 'quantity', 'actualPaymentCents', 'expectedRefundCents', 'expectedRebateCents']
        .some((field) => incoming[field] !== oldItem[field])) {
        throw new Error(`商品“${oldItem.productName}”已有出库或退款记录，不能修改名称、数量或金额`);
      }
    }
    Object.assign(report, {
      occurredAt,
      originalMessage: text(input.originalMessage, '原消息文本', false),
      updatedAt: now,
    });
    state.reportItems = state.reportItems.filter((item) => {
      if (item.reportId !== report.id || incomingIds.has(item.id)) return true;
      if (!itemHasReferences(state, item.id)) return false;
      item.status = 'void';
      item.updatedAt = now;
      return true;
    });
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
      refreshRefundAmounts(state, item.id);
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
    if (input.closedAt) throw new Error('快递结单状态只能通过结单操作修改');
    return {
      id: input.id || idFactory('shipment'),
      trackingNumber: text(input.trackingNumber, '快递单号'),
      shippingCostCents: parseMoney(input.shippingCostCents ?? 0, '快递价格'),
      shippedAt: text(input.shippedAt, '发出时间'),
      note: text(input.note, '备注', false),
      closedAt: null,
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
    ensureShipmentOpen(shipment);
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
    ensureShipmentOpen(shipment);
    shipment.status = 'void';
    shipment.updatedAt = now;
    for (const item of state.shipmentItems.filter((row) => row.shipmentId === shipment.id)) item.status = 'void';
    for (const settlement of state.settlements.filter((row) => row.shipmentId === shipment.id && isActive(row))) {
      settlement.status = 'void';
      settlement.updatedAt = now;
    }
    return { state, result: { id: shipment.id } };
  }

  function closeShipment(state, payload, now) {
    const shipment = shipmentById(state, payload.id);
    if (!shipment) throw new Error('快递不存在');
    ensureShipmentOpen(shipment);
    if (!state.settlements.some((row) => row.shipmentId === shipment.id && isActive(row))) {
      throw new Error('结单前请先登记实际返款金额');
    }
    shipment.closedAt = now;
    shipment.updatedAt = now;
    return { state, result: { id: shipment.id, closedAt: shipment.closedAt } };
  }

  function reopenShipment(state, payload, now) {
    const shipment = shipmentById(state, payload.id);
    if (!shipment) throw new Error('快递不存在');
    shipment.closedAt = null;
    shipment.updatedAt = now;
    return { state, result: { id: shipment.id, closedAt: null } };
  }

  function addSettlement(state, payload, now, idFactory) {
    const input = payload.settlement || payload;
    const shipment = shipmentById(state, input.shipmentId);
    if (!shipment) throw new Error('快递不存在');
    ensureShipmentOpen(shipment);
    const amountCents = parseMoney(input.amountCents ?? 0, '实际返款金额');
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
    ensureNewIds(state, 'settlements', [settlement], '返款');
    state.settlements.push(settlement);
    return { state, result: { id: settlement.id } };
  }

  function updateSettlement(state, payload, now) {
    const input = payload.settlement || payload;
    const settlement = state.settlements.find((row) => row.id === input.id && isActive(row));
    if (!settlement) throw new Error('返款记录不存在');
    const shipment = shipmentById(state, settlement.shipmentId);
    if (!shipment) throw new Error('关联快递不存在');
    ensureShipmentOpen(shipment);
    Object.assign(settlement, {
      amountCents: parseMoney(input.amountCents ?? settlement.amountCents, '实际返款金额'),
      settledAt: text(input.settledAt, '返款时间'),
      note: text(input.note, '备注', false),
      updatedAt: now,
    });
    return { state, result: { id: settlement.id } };
  }

  function voidSettlement(state, payload, now) {
    const settlement = state.settlements.find((row) => row.id === payload.id && isActive(row));
    if (!settlement) throw new Error('返款记录不存在');
    const shipment = shipmentById(state, settlement.shipmentId);
    if (!shipment) throw new Error('关联快递不存在');
    ensureShipmentOpen(shipment);
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
      amountCents: amountForQuantity(item.actualPaymentCents, item.quantity, quantity),
      refundedAt: text(input.refundedAt, '退款时间'),
      note: text(input.note, '备注', false),
      createdAt: input.createdAt || now,
      updatedAt: now,
      status: 'active',
    };
    ensureNewIds(state, 'refunds', [refund], '退款');
    state.refunds.push(refund);
    refreshRefundAmounts(state, item.id);
    return { state, result: { id: refund.id } };
  }

  function updateRefund(state, payload, now) {
    const input = payload.refund || payload;
    const refund = state.refunds.find((row) => row.id === input.id && isActive(row));
    if (!refund) throw new Error('退款记录不存在');
    const item = itemById(state, refund.reportItemId);
    if (!item) throw new Error('库存批次不存在');
    const targetItemId = input.reportItemId || refund.reportItemId;
    const targetItem = itemById(state, targetItemId);
    if (!targetItem) throw new Error('库存批次不存在');
    const nextQuantity = asPositiveInt(input.quantity, '退款数量');
    if (targetItemId === item.id) {
      const otherRefunded = refundQuantity(state, item.id) - refund.quantity;
      const shipped = shipmentItemQuantity(state, item.id);
      if (nextQuantity + otherRefunded + shipped > item.quantity) throw new Error('退款数量超过可用库存');
    } else {
      const available = inventoryLots(state).find((lot) => lot.reportItemId === targetItemId);
      if (!available || available.availableQuantity < nextQuantity) throw new Error('退款数量超过目标批次可用库存');
    }
    Object.assign(refund, {
      reportItemId: targetItemId,
      quantity: nextQuantity,
      amountCents: 0,
      refundedAt: text(input.refundedAt, '退款时间'),
      note: text(input.note, '备注', false),
      updatedAt: now,
    });
    refreshRefundAmounts(state, item.id);
    if (targetItemId !== item.id) refreshRefundAmounts(state, targetItemId);
    return { state, result: { id: refund.id } };
  }

  function voidRefund(state, payload, now) {
    const refund = state.refunds.find((row) => row.id === payload.id && isActive(row));
    if (!refund) throw new Error('退款记录不存在');
    const reportItemId = refund.reportItemId;
    refund.status = 'void';
    refund.updatedAt = now;
    refreshRefundAmounts(state, reportItemId);
    return { state, result: { id: refund.id } };
  }

  function applyOperation(inputState, operation, options = {}) {
    const state = normalizeState(inputState);
    const now = options.now || isoNow();
    const idFactory = options.idFactory || makeId;
    if (!operation || !operation.type) throw new Error('同步操作缺少类型');
    let applied;
    switch (operation.type) {
      case 'report.create': applied = addReport(state, operation.payload || {}, now, idFactory); break;
      case 'report.update': applied = updateReport(state, operation.payload || {}, now, idFactory); break;
      case 'report.void': applied = voidReport(state, operation.payload || {}, now); break;
      case 'shipment.create': applied = addShipment(state, operation.payload || {}, now, idFactory); break;
      case 'shipment.update': applied = updateShipment(state, operation.payload || {}, now, idFactory); break;
      case 'shipment.void': applied = voidShipment(state, operation.payload || {}, now); break;
      case 'shipment.close': applied = closeShipment(state, operation.payload || {}, now); break;
      case 'shipment.reopen': applied = reopenShipment(state, operation.payload || {}, now); break;
      case 'settlement.create': applied = addSettlement(state, operation.payload || {}, now, idFactory); break;
      case 'settlement.update': applied = updateSettlement(state, operation.payload || {}, now); break;
      case 'settlement.void': applied = voidSettlement(state, operation.payload || {}, now); break;
      case 'refund.create': applied = addRefund(state, operation.payload || {}, now, idFactory); break;
      case 'refund.update': applied = updateRefund(state, operation.payload || {}, now); break;
      case 'refund.void': applied = voidRefund(state, operation.payload || {}, now); break;
      default: throw new Error(`不支持的操作类型: ${operation.type}`);
    }
    if (!isStateSnapshot(applied.state)) throw new Error('操作产生了无效数据，已拒绝保存');
    return applied;
  }

  function pendingOperationBatch(queue, limit = 100) {
    const maximum = Number(limit);
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error('同步批次上限必须是正整数');
    const batch = [];
    for (const operation of Array.isArray(queue) ? queue : []) {
      if (!operation?.opId || !operation?.type || operation.syncError) break;
      batch.push(operation);
      if (batch.length === maximum) break;
    }
    return batch;
  }

  function reconcilePushResult(queue, attemptedOperations, response) {
    const attemptedIds = new Set((Array.isArray(attemptedOperations) ? attemptedOperations : [])
      .map((operation) => operation?.opId)
      .filter(Boolean));
    const acceptedIds = new Set((Array.isArray(response?.accepted) ? response.accepted : [])
      .map((result) => result?.opId)
      .filter((opId) => attemptedIds.has(opId)));
    const rejectedById = new Map();
    for (const result of Array.isArray(response?.rejected) ? response.rejected : []) {
      if (!attemptedIds.has(result?.opId)) continue;
      rejectedById.set(result.opId, String(result.error || '服务器拒绝了此操作'));
    }

    const nextQueue = [];
    const rejected = [];
    const unconfirmed = [];
    for (const operation of Array.isArray(queue) ? queue : []) {
      if (!attemptedIds.has(operation?.opId)) {
        nextQueue.push(operation);
      } else if (rejectedById.has(operation.opId)) {
        const error = rejectedById.get(operation.opId);
        nextQueue.push({ ...operation, syncError: error });
        rejected.push({ opId: operation.opId, error });
      } else if (acceptedIds.has(operation.opId)) {
        // Only an explicit acknowledgement is allowed to remove a local operation.
      } else {
        nextQueue.push(operation);
        unconfirmed.push(operation.opId);
      }
    }
    return {
      queue: nextQueue,
      accepted: [...acceptedIds].filter((opId) => !rejectedById.has(opId)),
      rejected,
      unconfirmed,
    };
  }

  function stats(state) {
    const activeReports = new Set(state.reports.filter(isActive).map((row) => row.id));
    const activeShipments = new Map(state.shipments.filter(isActive).map((shipment) => [shipment.id, shipment]));
    const activeAllocations = activeShipmentAllocations(state);
    const allocationValues = shipmentAllocationFinancialMap(state);
    const totalShippingCents = state.shipments
      .filter(isActive)
      .reduce((sum, shipment) => sum + Number(shipment.shippingCostCents || 0), 0);
    let totalPurchaseCents = 0;
    let pendingShipmentPurchaseCents = 0;
    let expectedRefundCents = 0;
    let pendingExpectedRefundCents = 0;
    let expectedRebateCents = 0;
    for (const item of state.reportItems.filter((row) => isActive(row) && activeReports.has(row.reportId))) {
      const refunded = refundQuantity(state, item.id);
      const retainedActual = Number(item.actualPaymentCents || 0)
        - amountForQuantity(item.actualPaymentCents, item.quantity, refunded);
      const retainedExpectedRefund = Number(item.expectedRefundCents || 0)
        - amountForQuantity(item.expectedRefundCents, item.quantity, refunded);
      const retainedExpectedRebate = Number(item.expectedRebateCents || 0)
        - amountForQuantity(item.expectedRebateCents, item.quantity, refunded);
      let shippedActual = 0;
      let closedExpectedRefund = 0;
      for (const allocation of activeAllocations.filter((row) => row.reportItemId === item.id)) {
        const values = allocationValues.get(allocation.id);
        shippedActual += Number(values?.actualPaymentCents || 0);
        if (activeShipments.get(allocation.shipmentId)?.closedAt) {
          closedExpectedRefund += Number(values?.expectedRefundCents || 0);
        }
      }
      totalPurchaseCents += retainedActual;
      pendingShipmentPurchaseCents += Math.max(retainedActual - shippedActual, 0);
      expectedRefundCents += retainedExpectedRefund;
      pendingExpectedRefundCents += Math.max(retainedExpectedRefund - closedExpectedRefund, 0);
      expectedRebateCents += retainedExpectedRebate;
    }
    const expectedIncomeCents = expectedRefundCents + expectedRebateCents;
    let returnedCents = 0;
    let pendingReturnedCents = 0;
    let closedActualRefundCents = 0;
    for (const settlement of state.settlements.filter(isActive)) {
      const shipment = activeShipments.get(settlement.shipmentId);
      if (!shipment) continue;
      const amount = Number(settlement.amountCents || 0);
      returnedCents += amount;
      if (shipment.closedAt) closedActualRefundCents += amount;
      else pendingReturnedCents += amount;
    }
    const outstandingCents = Math.max(pendingExpectedRefundCents - pendingReturnedCents, 0);
    const recognizedRefundCents = closedActualRefundCents + pendingExpectedRefundCents;
    const profitCents = recognizedRefundCents - totalPurchaseCents + expectedRebateCents;
    const pureProfitCents = profitCents - totalShippingCents;
    return {
      totalPurchaseCents,
      pendingShipmentPurchaseCents,
      totalShippingCents,
      expectedIncomeCents,
      expectedRefundCents,
      pendingExpectedRefundCents,
      expectedRebateCents,
      outstandingCents,
      returnedCents,
      pendingReturnedCents,
      closedActualRefundCents,
      recognizedRefundCents,
      profitCents,
      pureProfitCents,
      rate: totalPurchaseCents ? pureProfitCents / totalPurchaseCents : 0,
    };
  }

  function shipmentView(state, shipment) {
    const allocationValues = shipmentAllocationFinancialMap(state);
    const items = state.shipmentItems
      .filter((item) => item.shipmentId === shipment.id && isActive(item))
      .map((allocation) => {
        const source = itemById(state, allocation.reportItemId);
        const values = allocationValues.get(allocation.id)
          || { actualPaymentCents: 0, expectedRefundCents: 0, expectedRebateCents: 0 };
        return {
          ...allocation,
          productName: source?.productName || '已删除商品',
          productNote: source?.note || '',
          ...values,
        };
      });
    const settlements = state.settlements.filter((row) => row.shipmentId === shipment.id && isActive(row));
    const returnedCents = settlements.reduce((sum, row) => sum + Number(row.amountCents || 0), 0);
    return {
      shipment,
      closed: Boolean(shipment.closedAt),
      closedAt: shipment.closedAt || null,
      items,
      settlements,
      actualPaymentCents: items.reduce((sum, item) => sum + item.actualPaymentCents, 0),
      expectedRefundCents: items.reduce((sum, item) => sum + item.expectedRefundCents, 0),
      expectedRebateCents: items.reduce((sum, item) => sum + item.expectedRebateCents, 0),
      returnedCents,
      settlementRecorded: settlements.length > 0,
      refundVarianceCents: returnedCents - items.reduce((sum, item) => sum + item.expectedRefundCents, 0),
    };
  }

  return {
    SCHEMA_VERSION,
    emptyState,
    isStateSnapshot,
    normalizeState,
    clone,
    makeId,
    isoNow,
    isActive,
    parseMoney,
    formatMoney,
    amountForQuantity,
    previewShipmentAllocations,
    inventoryLots,
    aggregateInventory,
    allocateFifo,
    applyOperation,
    pendingOperationBatch,
    reconcilePushResult,
    stats,
    shipmentView,
    reportById,
    itemById,
    refundQuantity,
    shipmentItemQuantity,
  };
});
