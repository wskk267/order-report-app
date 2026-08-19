(function () {
  'use strict';

  const Domain = window.OrderDomain;
  const STORAGE_KEY = 'order-report-local-v1';
  const DEFAULT_SETTINGS = { apiBase: '', token: '' };
  const app = {
    state: Domain.emptyState(),
    queue: [],
    settings: { ...DEFAULT_SETTINGS },
    clientId: '',
    view: 'dashboard',
    search: '',
    syncError: '',
    syncPromise: null,
    modal: null,
    confirmation: null,
    printText: '',
    exportText: '',
    exportFilename: '',
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function money(cents) { return `¥${Domain.formatMoney(cents)}`; }
  function percent(value) { return `${(Number(value || 0) * 100).toFixed(2)}%`; }
  function dateText(value) {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value).replace('T', ' ') : date.toLocaleString('zh-CN', { hour12: false });
  }
  function dateInputValue(value, fallbackNow = true) {
    if (value) return String(value).slice(0, 16);
    if (!fallbackNow) return '';
    const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    return date.toISOString().slice(0, 16);
  }
  function dateOnlyValue(value, fallbackNow = true) {
    if (value) return String(value).slice(0, 10);
    return fallbackNow ? new Date().toISOString().slice(0, 10) : '';
  }
  function valueMoney(cents) { return Domain.formatMoney(cents); }
  function parseMoneyInput(value, label) { return Domain.parseMoney(value || '0', label); }

  function localStorageRead() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      app.state = Domain.normalizeState(saved.state);
      app.queue = Array.isArray(saved.queue) ? saved.queue : [];
      app.settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
      app.clientId = saved.clientId || '';
    } catch (error) {
      app.syncError = `本地数据读取失败: ${error.message}`;
    }
    if (!app.clientId) app.clientId = Domain.makeId('client');
    if (!app.settings.apiBase && /^https?:$/.test(location.protocol)) app.settings.apiBase = location.origin;
  }

  function localStorageWrite() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      state: app.state,
      queue: app.queue,
      settings: app.settings,
      clientId: app.clientId,
    }));
  }

  function setSyncStatus(kind, label) {
    const element = $('#sync-state');
    if (!element) return;
    element.className = `status-pill ${kind}`;
    element.textContent = label;
  }

  function queueCounts() {
    return app.queue.reduce((counts, operation) => {
      if (operation.syncError) counts.failed += 1;
      else counts.pending += 1;
      return counts;
    }, { pending: 0, failed: 0 });
  }

  function pendingOperations() {
    return app.queue.filter((operation) => !operation.syncError);
  }

  function queueSummary() {
    const { pending, failed } = queueCounts();
    if (pending && failed) return `待上传 ${pending} 条 · 失败 ${failed} 条`;
    if (pending) return `待上传 ${pending} 条`;
    if (failed) return `失败 ${failed} 条`;
    return '无待上传操作';
  }

  function refreshSyncStatus() {
    const { pending, failed } = queueCounts();
    if (!app.settings.apiBase) {
      setSyncStatus('local', pending ? `仅本地 · ${pending}` : failed ? `本地失败 · ${failed}` : '仅本地');
    } else if (app.syncError) {
      setSyncStatus('error', pending ? `离线 · ${pending}` : failed ? `失败 · ${failed}` : '离线');
    } else if (failed) {
      setSyncStatus('error', `失败 · ${failed}`);
    } else if (pending) {
      setSyncStatus('syncing', `待上传 · ${pending}`);
    } else {
      setSyncStatus('online', '已同步');
    }
  }

  function connectionStatus() {
    const { failed } = queueCounts();
    if (!app.settings.apiBase) return { kind: 'local', label: '仅本地' };
    if (app.syncError || failed) return { kind: 'error', label: '需处理' };
    return { kind: 'online', label: '已配置' };
  }

  function toast(message, isError = false) {
    const root = $('#toast-root');
    const element = document.createElement('div');
    element.className = 'toast';
    element.style.background = isError ? 'var(--red)' : 'var(--ink)';
    element.textContent = message;
    root.appendChild(element);
    setTimeout(() => element.remove(), 3600);
  }

  function activeReports() { return app.state.reports.filter(Domain.isActive); }
  function reportItems(reportId) { return app.state.reportItems.filter((item) => item.reportId === reportId && Domain.isActive(item)); }
  function reportTotals(reportId) {
    return reportItems(reportId).reduce((sum, item) => ({
      quantity: sum.quantity + item.quantity,
      actualPaymentCents: sum.actualPaymentCents + Number(item.actualPaymentCents || 0),
      expectedRefundCents: sum.expectedRefundCents + Number(item.expectedRefundCents || 0),
      expectedRebateCents: sum.expectedRebateCents + Number(item.expectedRebateCents || 0),
    }), { quantity: 0, actualPaymentCents: 0, expectedRefundCents: 0, expectedRebateCents: 0 });
  }
  function reportSearchText(report) {
    return [report.occurredAt, report.originalMessage, ...reportItems(report.id).flatMap((item) => [item.productName, item.note])].join(' ').toLowerCase();
  }
  function shipmentViews() {
    return app.state.shipments.filter(Domain.isActive).map((shipment) => Domain.shipmentView(app.state, shipment));
  }
  function shipmentSearchText(view) {
    return [view.shipment.trackingNumber, view.shipment.shippedAt, view.shipment.note, ...view.items.flatMap((item) => [item.productName, item.productNote])].join(' ').toLowerCase();
  }

  function productLabel(item) {
    return `${item.productName}${item.note ? `（${item.note}）` : ''}`;
  }

  function shipmentItemLabel(item) {
    return `${item.productName}${item.productNote ? `（${item.productNote}）` : ''} ×${item.quantity}`;
  }

  function dispatch(type, payload) {
    const operation = {
      opId: Domain.makeId('op'),
      clientId: app.clientId,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    try {
      const applied = Domain.applyOperation(app.state, operation);
      app.state = applied.state;
      app.queue.push(operation);
      app.syncError = '';
      localStorageWrite();
      closeModal();
      render();
      toast('已保存到本机，等待同步');
      sync();
    } catch (error) {
      toast(error.message, true);
    }
  }

  function settingsFromForm() {
    const form = $('form[data-form="settings"]');
    if (!form) return { ...app.settings };
    return {
      apiBase: form.elements.apiBase.value.trim().replace(/\/$/, ''),
      token: form.elements.token.value.trim(),
    };
  }

  async function apiRequest(path, options = {}, connection = app.settings) {
    const base = String(connection.apiBase || '').trim().replace(/\/$/, '');
    if (!base) throw new Error('尚未设置服务器地址');
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    if (connection.token) headers['X-Sync-Token'] = connection.token;
    const response = await fetch(`${base}${path}`, { ...options, headers });
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok) throw new Error(body?.error || `服务器返回 ${response.status}`);
    return body;
  }

  async function pushPendingOperations(allowEmpty = false) {
    const pending = pendingOperations();
    if (!pending.length && !allowEmpty) return { pending: 0, rejected: new Map() };
    const pushed = await apiRequest('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({ clientId: app.clientId, operations: pending }),
    });
    const rejected = new Map((pushed.rejected || []).map((item) => [item.opId, item.error]));
    for (const operation of app.queue) {
      if (rejected.has(operation.opId)) operation.syncError = rejected.get(operation.opId);
    }
    const acceptedIds = new Set(pending.filter((operation) => !rejected.has(operation.opId)).map((operation) => operation.opId));
    app.queue = app.queue.filter((operation) => !acceptedIds.has(operation.opId));
    app.syncError = rejected.size ? [...rejected.values()][0] : '';
    const { failed } = queueCounts();
    if (!rejected.size && !failed && pending.length) app.state = Domain.normalizeState(pushed.state);
    localStorageWrite();
    return { pending: pending.length, rejected };
  }

  async function pullServerState(replaceLocal = false) {
    const pulled = await apiRequest('/api/sync/pull');
    if (replaceLocal) {
      app.state = Domain.normalizeState(pulled.state);
      app.queue = [];
      app.syncError = '';
    } else if (!app.queue.length) {
      app.state = Domain.normalizeState(pulled.state);
      app.syncError = '';
    }
    localStorageWrite();
    return pulled;
  }

  async function sync() {
    if (app.syncPromise) return app.syncPromise;
    if (!app.settings.apiBase) {
      refreshSyncStatus();
      return;
    }
    app.syncPromise = (async () => {
      setSyncStatus('syncing', '同步中');
      try {
        const { pending, failed } = queueCounts();
        if (pending) await pushPendingOperations();
        else if (!failed) await pullServerState();
        refreshSyncStatus();
        render();
      } catch (error) {
        app.syncError = error.message;
        setSyncStatus('error', '离线保存');
        render();
      } finally {
        app.syncPromise = null;
      }
    })();
    return app.syncPromise;
  }

  async function testConnection() {
    const connection = settingsFromForm();
    try {
      if (!connection.apiBase) throw new Error('请先填写服务器地址');
      setSyncStatus('syncing', '测试中');
      await apiRequest('/api/health', {}, connection);
      await apiRequest('/api/sync/pull', {}, connection);
      app.syncError = '';
      setSyncStatus('online', '测试成功');
      toast('连接和同步令牌测试成功');
    } catch (error) {
      app.syncError = error.message;
      setSyncStatus('error', '测试失败');
      toast(`连接测试失败：${error.message}`, true);
    }
  }

  async function uploadData() {
    try {
      if (!app.settings.apiBase) throw new Error('请先保存服务器地址和同步令牌');
      setSyncStatus('syncing', '上传中');
      const result = await pushPendingOperations(true);
      if (result.rejected.size) throw new Error([...result.rejected.values()][0]);
      refreshSyncStatus();
      toast(result.pending ? `已上传 ${result.pending} 条操作` : '没有待上传操作');
    } catch (error) {
      app.syncError = error.message;
      refreshSyncStatus();
      toast(`上传失败：${error.message}`, true);
    }
    render();
  }

  async function performDownload() {
    try {
      if (!app.settings.apiBase) throw new Error('请先保存服务器地址和同步令牌');
      setSyncStatus('syncing', '下载中');
      await pullServerState(true);
      refreshSyncStatus();
      toast('服务器数据已下载到本机');
    } catch (error) {
      app.syncError = error.message;
      refreshSyncStatus();
      toast(`下载失败：${error.message}`, true);
    }
    render();
  }

  function downloadData() {
    const { pending, failed } = queueCounts();
    if (pending || failed) {
      confirmAction('覆盖本机数据', `当前有 ${pending} 条待上传、${failed} 条失败操作。下载会覆盖本机数据并清空这些操作，是否继续？`, performDownload);
    } else {
      performDownload();
    }
  }

  function openModal(title, body, wide = false) {
    app.modal = true;
    app.confirmation = null;
    $('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-heading"><h2>${esc(title)}</h2><button class="close-button" type="button" data-action="close-modal" aria-label="关闭">×</button></div><div class="modal-body">${body}</div></section></div>`;
  }

  function confirmAction(title, message, callback) {
    openModal(title, `<div class="confirm-dialog"><div class="confirm-icon">!</div><p>${esc(message)}</p><div class="form-actions"><button class="button button-quiet" type="button" data-action="close-modal">取消</button><button class="button button-danger" type="button" data-action="confirm-action">确认</button></div></div>`);
    app.confirmation = callback;
  }

  function closeModal() {
    app.modal = null;
    app.confirmation = null;
    app.printText = '';
    app.exportText = '';
    app.exportFilename = '';
    $('#modal-root').innerHTML = '';
  }

  function emptyState(title, detail, action = '') {
    return `<div class="empty-state"><strong>${esc(title)}</strong><span>${esc(detail)}</span>${action ? `<div style="margin-top:16px">${action}</div>` : ''}</div>`;
  }

  function pageHeading(eyebrow, title, subtitle, action) {
    return `<div class="page-heading"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1>${subtitle ? `<p class="page-subtitle">${esc(subtitle)}</p>` : ''}</div>${action || ''}</div>`;
  }

  function renderDashboard() {
    const summary = Domain.stats(app.state);
    const reports = activeReports().sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt))).slice(0, 5);
    const shipments = shipmentViews().sort((a, b) => String(b.shipment.shippedAt).localeCompare(String(a.shipment.shippedAt))).slice(0, 5);
    return `${pageHeading('Workspace', '总览', '收入、库存和返款状态', '<button class="button" data-action="new-report">新增报单</button>')}
      <section class="card-grid">
        <article class="stat-card accent-green"><div class="stat-label">累计商品付款</div><div class="stat-value money">${money(summary.totalPurchaseCents)}</div><div class="stat-foot">已扣除退款商品</div></article>
        <article class="stat-card accent-orange"><div class="stat-label">累计快递费用</div><div class="stat-value money">${money(summary.totalShippingCents)}</div><div class="stat-foot">全部有效快递</div></article>
        <article class="stat-card accent-blue"><div class="stat-label">预计未返款</div><div class="stat-value money">${money(summary.outstandingCents)}</div><div class="stat-foot">预计收益 ${money(summary.expectedIncomeCents)}</div></article>
        <article class="stat-card accent-green"><div class="stat-label">已返款</div><div class="stat-value money">${money(summary.returnedCents)}</div><div class="stat-foot">利润 ${money(summary.profitCents)}</div></article>
        <article class="stat-card accent-orange"><div class="stat-label">纯利润</div><div class="stat-value money">${money(summary.pureProfitCents)}</div><div class="stat-foot">利润减快递费用</div></article>
        <article class="stat-card accent-blue"><div class="stat-label">利率</div><div class="stat-value">${percent(summary.rate)}</div><div class="stat-foot">纯利润 / 累计商品付款</div></article>
      </section>
      <section class="two-column">
        <article class="panel"><div class="panel-heading"><h2>最近报单</h2><button class="link-button" data-view="reports">查看全部</button></div><div class="record-list">${reports.length ? reports.map((report) => { const total = reportTotals(report.id); return `<div class="record-row"><div class="record-main"><div class="record-title">${esc(reportItems(report.id).map((item) => item.productName).join('、'))}</div><div class="record-meta">${esc(dateText(report.occurredAt))} · ${total.quantity} 件</div></div><div class="record-side"><div class="money">${money(total.actualPaymentCents)}</div><div class="muted">预计 ${money(total.expectedRefundCents + total.expectedRebateCents)}</div></div></div>`; }).join('') : emptyState('还没有报单', '先录入一笔商品报单', '<button class="button button-small" data-action="new-report">新增报单</button>')}</div></article>
        <article class="panel"><div class="panel-heading"><h2>最近快递</h2><button class="link-button" data-view="shipments">查看全部</button></div><div class="record-list">${shipments.length ? shipments.map((view) => `<div class="record-row"><div class="record-main"><div class="record-title">${esc(view.shipment.trackingNumber)}</div><div class="record-meta">${esc(view.items.map((item) => item.productName).join('、'))} · ${view.items.reduce((sum, item) => sum + item.quantity, 0)} 件</div></div><div class="record-side"><div class="money">${money(view.returnedCents)}</div><div class="muted">预计 ${money(view.expectedRefundCents + view.expectedRebateCents)}</div></div></div>`).join('') : emptyState('还没有快递', '库存有商品后可以创建快递', '<button class="button button-small" data-action="new-shipment">新增快递</button>')}</div></article>
      </section>`;
  }

  function reportRows() {
    const query = app.search.trim().toLowerCase();
    const rows = activeReports().filter((report) => !query || reportSearchText(report).includes(query)).sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
    if (!rows.length) return `<tr><td colspan="7">${emptyState('没有匹配的报单', '调整搜索条件或新增一笔报单')}</td></tr>`;
    return rows.map((report) => {
      const items = reportItems(report.id);
      const total = reportTotals(report.id);
      return `<tr><td class="number">${esc(dateText(report.occurredAt))}</td><td><strong>${esc(items.map(productLabel).join('、'))}</strong><div class="muted small">${items.length} 个商品行 · ${total.quantity} 件</div></td><td class="money">${money(total.actualPaymentCents)}</td><td class="money">${money(total.expectedRefundCents)}</td><td class="money">${money(total.expectedRebateCents)}</td><td>${esc(report.originalMessage || '-')}</td><td><div class="inline-actions"><button class="link-button" data-action="edit-report" data-id="${esc(report.id)}">编辑</button><button class="link-button danger" data-action="void-report" data-id="${esc(report.id)}">作废</button></div></td></tr>`;
    }).join('');
  }

  function renderReports() {
    return `${pageHeading('Records', '报单', '商品付款、预计返款和预计返利', '<button class="button" data-action="new-report">新增报单</button>')}
      <div class="toolbar"><div class="toolbar-group"><input class="input search-input" data-search="reports" value="${esc(app.search)}" placeholder="搜索商品、原消息、时间"></div><div class="toolbar-group"><span class="muted small">${activeReports().length} 笔有效报单</span></div></div>
      <section class="panel"><div class="table-wrap"><table class="mobile-table report-table"><thead><tr><th>时间</th><th>商品</th><th>实际付款</th><th>预计返款</th><th>预计返利</th><th>原消息</th><th>操作</th></tr></thead><tbody>${reportRows()}</tbody></table></div></section>`;
  }

  function shipmentRows() {
    const query = app.search.trim().toLowerCase();
    const rows = shipmentViews().filter((view) => !query || shipmentSearchText(view).includes(query)).sort((a, b) => String(b.shipment.shippedAt).localeCompare(String(a.shipment.shippedAt)));
    if (!rows.length) return `<tr><td colspan="8">${emptyState('没有匹配的快递', '创建一笔快递后会从剩余仓库自动扣减')}</td></tr>`;
    return rows.map((view) => {
      const shipment = view.shipment;
      const quantity = view.items.reduce((sum, item) => sum + item.quantity, 0);
      const settlementDetails = view.settlements.length ? `<div class="settlement-list">${view.settlements.map((settlement) => `<div class="settlement-entry"><span>${esc(dateText(settlement.settledAt))} · ${money(settlement.amountCents)}</span><span><button class="link-button button-small" data-action="edit-settlement" data-shipment-id="${esc(shipment.id)}" data-id="${esc(settlement.id)}">编辑</button><button class="link-button danger button-small" data-action="void-settlement" data-id="${esc(settlement.id)}">撤销</button></span></div>`).join('')}</div>` : '<span class="tag tag-orange">待返款</span>';
      return `<tr><td class="number">${esc(dateText(shipment.shippedAt))}</td><td><strong>${esc(shipment.trackingNumber)}</strong><div class="muted small">${quantity} 件</div></td><td>${esc(view.items.map(shipmentItemLabel).join('、'))}</td><td class="money">${money(shipment.shippingCostCents)}</td><td class="money">${money(view.expectedRefundCents + view.expectedRebateCents)}</td><td class="money">${money(view.returnedCents)}</td><td>${settlementDetails}</td><td><div class="inline-actions"><button class="link-button" data-action="print-shipment" data-id="${esc(shipment.id)}">打印单子</button><button class="link-button" data-action="add-settlement" data-id="${esc(shipment.id)}">记返款</button><button class="link-button" data-action="edit-shipment" data-id="${esc(shipment.id)}">编辑</button><button class="link-button danger" data-action="void-shipment" data-id="${esc(shipment.id)}">作废</button></div></td></tr>`;
    }).join('');
  }

  function renderShipments() {
    return `${pageHeading('Fulfillment', '快递', '从剩余仓库按先进先出分配商品', '<button class="button" data-action="new-shipment">新增快递</button>')}
      <div class="toolbar"><div class="toolbar-group"><input class="input search-input" data-search="shipments" value="${esc(app.search)}" placeholder="搜索单号、商品、备注"></div><div class="toolbar-group"><span class="muted small">${shipmentViews().length} 笔有效快递</span></div></div>
      <section class="panel"><div class="table-wrap"><table class="mobile-table shipment-table"><thead><tr><th>发出时间</th><th>单号</th><th>快递内容</th><th>快递价格</th><th>预计返款+返利</th><th>已返款</th><th>状态</th><th>操作</th></tr></thead><tbody>${shipmentRows()}</tbody></table></div></section>`;
  }

  function renderInventory() {
    const lots = Domain.inventoryLots(app.state);
    const aggregate = Domain.aggregateInventory(app.state);
    const availableQuantity = lots.reduce((sum, lot) => sum + lot.availableQuantity, 0);
    const availableValue = lots.reduce((sum, lot) => sum + Domain.amountForQuantity(lot.actualPaymentCents, lot.quantity, lot.availableQuantity), 0);
    return `${pageHeading('Inventory', '仓库', '当前未发快递、未退款的商品批次', '<button class="button" data-action="new-refund">登记退款</button>')}
      <section class="stock-summary"><div class="panel"><div class="muted small">可用商品种类</div><div class="summary-value">${aggregate.length}</div></div><div class="panel"><div class="muted small">可用商品数量</div><div class="summary-value number">${availableQuantity}</div></div><div class="panel"><div class="muted small">可用商品成本</div><div class="summary-value money">${money(availableValue)}</div></div></section>
      <section class="panel"><div class="panel-heading"><h2>库存批次</h2><span class="muted small">按报单时间排序</span></div><div class="table-wrap"><table class="mobile-table inventory-table"><thead><tr><th>商品</th><th>报单时间</th><th>批次数量</th><th>剩余</th><th>单位成本</th><th>单位预计收益</th><th>操作</th></tr></thead><tbody>${lots.length ? lots.map((lot) => `<tr><td><strong>${esc(lot.productName)}</strong></td><td>${esc(dateText(lot.sourceDate))}</td><td class="number">${lot.quantity}</td><td class="number"><span class="tag tag-green">${lot.availableQuantity}</span></td><td class="money">${money(Domain.amountForQuantity(lot.actualPaymentCents, lot.quantity, 1))}</td><td class="money">${money(Domain.amountForQuantity(lot.expectedRefundCents + lot.expectedRebateCents, lot.quantity, 1))}</td><td><button class="link-button" data-action="new-refund" data-id="${esc(lot.reportItemId)}">退款</button></td></tr>`).join('') : `<tr><td colspan="7">${emptyState('仓库为空', '新增报单后会在这里形成可用库存')}</td></tr>`}</tbody></table></div></section>`;
  }

  function refundRows() {
    const rows = app.state.refunds.filter(Domain.isActive).sort((a, b) => String(b.refundedAt).localeCompare(String(a.refundedAt)));
    if (!rows.length) return `<tr><td colspan="7">${emptyState('还没有退款记录', '从仓库选择商品登记退款')}</td></tr>`;
    return rows.map((refund) => {
      const item = app.state.reportItems.find((row) => row.id === refund.reportItemId);
      const report = item && app.state.reports.find((row) => row.id === item.reportId);
      return `<tr><td>${esc(dateText(refund.refundedAt))}</td><td><strong>${esc(item?.productName || '已删除商品')}</strong><div class="muted small">来源 ${esc(dateText(report?.occurredAt))}</div></td><td class="number">${refund.quantity}</td><td class="money">${money(refund.amountCents)}</td><td>${esc(refund.note || '-')}</td><td><span class="tag tag-red">已退出仓库</span></td><td><div class="inline-actions"><button class="link-button" data-action="edit-refund" data-id="${esc(refund.id)}">编辑</button><button class="link-button danger" data-action="void-refund" data-id="${esc(refund.id)}">撤销</button></div></td></tr>`;
    }).join('');
  }

  function renderRefunds() {
    return `${pageHeading('Returns', '退款', '从可用库存退出商品并保留流水', '<button class="button" data-action="new-refund">登记退款</button>')}
      <section class="panel"><div class="table-wrap"><table class="mobile-table refund-table"><thead><tr><th>退款时间</th><th>商品批次</th><th>数量</th><th>退款金额</th><th>备注</th><th>状态</th><th>操作</th></tr></thead><tbody>${refundRows()}</tbody></table></div></section>`;
  }

  function renderSettings() {
    const { pending, failed } = queueCounts();
    const connection = connectionStatus();
    return `${pageHeading('Configuration', '设置', '服务器同步和本机数据', '')}
      <section class="settings-stack">
        <article class="panel"><div class="panel-heading"><h2>同步连接</h2><span class="status-pill ${connection.kind}">${connection.label}</span></div><div class="panel-body padded"><form data-form="settings"><div class="form-grid"><div class="field full"><label for="api-base">服务器地址</label><input class="input" id="api-base" name="apiBase" value="${esc(app.settings.apiBase)}" placeholder="https://order.example.com"><div class="field-help">填写 HTTPS 反向代理地址，例如 https://order.galaxy-kw.me。</div></div><div class="field full"><label for="sync-token">同步令牌</label><input class="input" id="sync-token" name="token" type="password" value="${esc(app.settings.token)}" autocomplete="off" placeholder="从服务器 runtime/sync-token 读取"><div class="field-help">令牌只保存于本机 WebView，不会写入业务 Git 仓库。</div></div></div><div class="sync-actions"><button class="button" type="submit">保存</button><button class="button button-quiet" type="button" data-action="sync-test">测试</button><button class="button button-quiet" type="button" data-action="sync-upload">上传</button><button class="button button-quiet" type="button" data-action="sync-download">下载</button></div></form></div></article>
        <article class="panel"><div class="panel-heading"><h2>同步状态</h2><span class="muted small">${queueSummary()}</span></div><div class="panel-body padded"><div class="sync-counts"><div><span>待上传操作</span><strong>${pending}</strong></div><div><span>失败待处理</span><strong>${failed}</strong></div></div>${app.syncError ? `<div class="danger-box">${esc(app.syncError)}</div>` : '<div class="info-box">待上传数量只代表尚未送到服务器的本地操作，不代表本机业务数据条数。成功同步后为 0 是正常状态。</div>'}${failed ? `<div class="warning-box" style="margin-top:12px">失败操作不会自动重复提交。请修正数据后重新编辑保存，或使用“下载”放弃这些本机改动。</div>` : ''}</div></article>
        <article class="panel"><div class="panel-heading"><h2>数据备份</h2></div><div class="panel-body padded"><div class="backup-actions"><button class="button button-quiet" data-action="export-local">导出本机数据</button><button class="button button-quiet" data-action="export-server">导出服务器数据</button></div><p class="field-help" style="margin-top:12px">导出内容可能包含完整业务数据。手机端会打开系统保存位置，也可以复制 JSON 内容。</p></div></article>
      </section>`;
  }

  function render() {
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === app.view));
    const main = $('#main-content');
    if (!main) return;
    if (app.view === 'dashboard') main.innerHTML = renderDashboard();
    if (app.view === 'reports') main.innerHTML = renderReports();
    if (app.view === 'shipments') main.innerHTML = renderShipments();
    if (app.view === 'inventory') main.innerHTML = renderInventory();
    if (app.view === 'refunds') main.innerHTML = renderRefunds();
    if (app.view === 'settings') main.innerHTML = renderSettings();
    refreshSyncStatus();
  }

  function reportEditor(reportId) {
    const report = reportId ? app.state.reports.find((row) => row.id === reportId) : null;
    const items = report ? reportItems(report.id) : [{ id: '', productName: '', note: '', quantity: 1, actualPaymentCents: 0, expectedRefundCents: 0, expectedRebateCents: 0 }];
    openModal(report ? '编辑报单' : '新增报单', `<form data-form="report"><div class="form-grid"><div class="field"><label>报单时间</label><input class="input" name="occurredAt" type="datetime-local" required value="${esc(dateInputValue(report?.occurredAt))}"></div><div class="field"><label>商品总行数</label><input class="input" value="${items.length}" disabled></div><div class="field full"><label>原消息文本</label><textarea class="textarea" name="originalMessage" placeholder="粘贴原始报单消息">${esc(report?.originalMessage || '')}</textarea></div></div><div class="modal-section"><div class="modal-section-heading"><h3>商品明细</h3><button class="button button-small button-quiet" type="button" data-action="add-report-item">添加商品行</button></div><div class="table-wrap"><table class="editor-table"><thead><tr><th>物品名称</th><th>备注</th><th>数量</th><th>实际付款</th><th>预计返款</th><th>预计返利</th><th></th></tr></thead><tbody id="report-items-editor">${items.map(reportItemEditorRow).join('')}</tbody></table></div></div><div class="form-actions"><button class="button button-quiet" type="button" data-action="close-modal">取消</button><button class="button" type="submit">保存报单</button></div><input type="hidden" name="id" value="${esc(report?.id || '')}"></form>`, true);
  }

  function reportItemEditorRow(item) {
    return `<tr class="report-item-editor" data-item-id="${esc(item.id || '')}"><td data-label="物品名称"><input class="input product-input" data-field="productName" value="${esc(item.productName)}" placeholder="商品名称" required></td><td data-label="备注"><input class="input" data-field="note" value="${esc(item.note || '')}" placeholder="可选"></td><td data-label="数量"><input class="input" data-field="quantity" type="number" min="1" step="1" value="${esc(item.quantity)}" required></td><td data-label="实际付款"><input class="input" data-field="actualPaymentCents" inputmode="decimal" value="${esc(valueMoney(item.actualPaymentCents))}" required></td><td data-label="预计返款"><input class="input" data-field="expectedRefundCents" inputmode="decimal" value="${esc(valueMoney(item.expectedRefundCents))}" required></td><td data-label="预计返利"><input class="input" data-field="expectedRebateCents" inputmode="decimal" value="${esc(valueMoney(item.expectedRebateCents))}" required></td><td data-label="操作"><button class="link-button danger" type="button" data-action="remove-report-item">移除</button></td></tr>`;
  }

  function collectReportForm(form) {
    const id = form.elements.id.value || Domain.makeId('report');
    const items = $$('.report-item-editor', form).map((row) => ({
      id: row.dataset.itemId || Domain.makeId('item'),
      productName: $('[data-field="productName"]', row).value.trim(),
      note: $('[data-field="note"]', row).value.trim(),
      quantity: Number($('[data-field="quantity"]', row).value),
      actualPaymentCents: parseMoneyInput($('[data-field="actualPaymentCents"]', row).value, '实际付款'),
      expectedRefundCents: parseMoneyInput($('[data-field="expectedRefundCents"]', row).value, '预计返款'),
      expectedRebateCents: parseMoneyInput($('[data-field="expectedRebateCents"]', row).value, '预计返利'),
    }));
    return { report: { id, occurredAt: form.elements.occurredAt.value, originalMessage: form.elements.originalMessage.value }, items };
  }

  function productOptions(excludeShipmentId = '') {
    return Domain.aggregateInventory(app.state, { excludeShipmentId }).map((product) => `<option value="${esc(product.productName)}">${esc(product.productName)}（余 ${product.availableQuantity}）</option>`).join('');
  }

  function shipmentEditor(shipmentId) {
    const existing = shipmentId ? shipmentViews().find((view) => view.shipment.id === shipmentId) : null;
    const lines = existing ? Object.values(existing.items.reduce((map, item) => { const key = item.productName; map[key] = map[key] || { productName: key, quantity: 0 }; map[key].quantity += item.quantity; return map; }, {})) : [{ productName: '', quantity: 1 }];
    const options = productOptions(shipmentId || '');
    openModal(existing ? '编辑快递' : '新增快递', `<form data-form="shipment"><div class="form-grid"><div class="field"><label>快递单号</label><input class="input" name="trackingNumber" value="${esc(existing?.shipment.trackingNumber || '')}" required placeholder="单号"></div><div class="field"><label>快递价格</label><input class="input" name="shippingCost" inputmode="decimal" value="${esc(valueMoney(existing?.shipment.shippingCostCents || 0))}" required></div><div class="field"><label>发出时间</label><input class="input" name="shippedAt" type="datetime-local" value="${esc(dateInputValue(existing?.shipment.shippedAt))}" required></div><div class="field"><label>备注</label><input class="input" name="note" value="${esc(existing?.shipment.note || '')}" placeholder="可选"></div></div><div class="modal-section"><div class="modal-section-heading"><h3>快递内容</h3><button class="button button-small button-quiet" type="button" data-action="add-shipment-item">添加商品行</button></div><div class="field-help" style="margin-bottom:10px">保存时会按报单时间从早到晚自动扣除库存批次。</div><div class="table-wrap"><table class="editor-table"><thead><tr><th>商品</th><th>数量</th><th></th></tr></thead><tbody id="shipment-items-editor">${lines.map((line) => shipmentItemEditorRow(line, options)).join('')}</tbody></table></div></div><div class="form-actions"><button class="button button-quiet" type="button" data-action="close-modal">取消</button><button class="button" type="submit">保存快递</button></div><input type="hidden" name="id" value="${esc(existing?.shipment.id || '')}"></form>`, true);
  }

  function shipmentItemEditorRow(item, options) {
    return `<tr class="shipment-item-editor"><td data-label="商品"><select class="select" data-field="productName" required><option value="">选择商品</option>${options}</select></td><td data-label="数量"><input class="input" data-field="quantity" type="number" min="1" step="1" value="${esc(item.quantity || 1)}" required></td><td data-label="操作"><button class="link-button danger" type="button" data-action="remove-shipment-item">移除</button></td></tr>`.replace(`<option value="${esc(item.productName)}">`, `<option value="${esc(item.productName)}" selected>`);
  }

  function collectShipmentForm(form) {
    const items = $$('.shipment-item-editor', form).map((row) => ({
      productName: $('[data-field="productName"]', row).value,
      quantity: Number($('[data-field="quantity"]', row).value),
    }));
    return {
      shipment: {
        id: form.elements.id.value || Domain.makeId('shipment'),
        trackingNumber: form.elements.trackingNumber.value.trim(),
        shippingCostCents: parseMoneyInput(form.elements.shippingCost.value, '快递价格'),
        shippedAt: form.elements.shippedAt.value,
        note: form.elements.note.value.trim(),
      },
      items,
    };
  }

  function settlementEditor(shipmentId, settlementId = '') {
    const view = shipmentViews().find((item) => item.shipment.id === shipmentId);
    const settlement = view?.settlements.find((item) => item.id === settlementId);
    openModal(settlement ? '编辑返款' : '落实快递返款', `<form data-form="settlement"><div class="info-box" style="margin-bottom:16px">${esc(view?.shipment.trackingNumber || '')} · 预计返款+返利 ${money((view?.expectedRefundCents || 0) + (view?.expectedRebateCents || 0))} · 已登记 ${money(view?.returnedCents || 0)}</div><div class="form-grid"><div class="field"><label>实际返款金额</label><input class="input" name="amount" inputmode="decimal" value="${esc(valueMoney(settlement?.amountCents || 0))}" required></div><div class="field"><label>返款时间</label><input class="input" name="settledAt" type="datetime-local" value="${esc(dateInputValue(settlement?.settledAt))}" required></div><div class="field full"><label>备注</label><input class="input" name="note" value="${esc(settlement?.note || '')}" placeholder="可选"></div></div><div class="form-actions"><button class="button button-quiet" type="button" data-action="close-modal">取消</button><button class="button" type="submit">保存返款</button></div><input type="hidden" name="shipmentId" value="${esc(shipmentId)}"><input type="hidden" name="id" value="${esc(settlement?.id || '')}"></form>`);
  }

  function refundEditor(refundId = '', itemId = '') {
    const refund = refundId ? app.state.refunds.find((row) => row.id === refundId) : null;
    const lots = Domain.inventoryLots(app.state);
    const currentLot = refund ? app.state.reportItems.find((item) => item.id === refund.reportItemId) : null;
    const selectable = refund && currentLot ? [{ ...lots.find((lot) => lot.reportItemId === refund.reportItemId), availableQuantity: (lots.find((lot) => lot.reportItemId === refund.reportItemId)?.availableQuantity || 0) + refund.quantity }] : lots;
    const options = selectable.filter(Boolean).map((lot) => `<option value="${esc(lot.reportItemId)}" ${lot.reportItemId === (itemId || refund?.reportItemId) ? 'selected' : ''}>${esc(lot.productName)} · ${esc(dateText(lot.sourceDate))} · 可退 ${lot.availableQuantity}</option>`).join('');
    const selectedItem = app.state.reportItems.find((item) => item.id === (itemId || refund?.reportItemId));
    const calculatedAmount = selectedItem ? Domain.amountForQuantity(selectedItem.actualPaymentCents, selectedItem.quantity, refund?.quantity || 1) : 0;
    openModal(refund ? '编辑退款' : '登记退款', `<form data-form="refund"><div class="form-grid"><div class="field full"><label>商品批次</label><select class="select" name="reportItemId" required><option value="">选择库存批次</option>${options}</select></div><div class="field"><label>退款数量</label><input class="input" name="quantity" type="number" min="1" step="1" value="${esc(refund?.quantity || 1)}" required></div><div class="field"><label>退款金额（自动计算）</label><input class="input" name="amount" value="${esc(valueMoney(calculatedAmount))}" readonly aria-readonly="true"></div><div class="field"><label>退款时间</label><input class="input" name="refundedAt" type="datetime-local" value="${esc(dateInputValue(refund?.refundedAt))}" required></div><div class="field"><label>备注</label><input class="input" name="note" value="${esc(refund?.note || '')}" placeholder="可选"></div></div><div class="info-box" style="margin-top:16px">退款金额 = 商品实际付款总额 × 退款数量 ÷ 商品报单数量。金额由系统生成，不需要手填。</div><div class="warning-box" style="margin-top:12px">退款会使商品退出仓库，并从累计商品付款、预计收益和利率统计中扣除。</div><div class="form-actions"><button class="button button-quiet" type="button" data-action="close-modal">取消</button><button class="button" type="submit">保存退款</button></div><input type="hidden" name="id" value="${esc(refund?.id || '')}"></form>`);
    updateRefundAmount($('form[data-form="refund"]'));
  }

  function updateRefundAmount(form) {
    if (!form?.elements?.amount) return;
    const item = app.state.reportItems.find((row) => row.id === form.elements.reportItemId.value);
    const quantity = Number(form.elements.quantity.value || 0);
    form.elements.amount.value = item && quantity > 0
      ? valueMoney(Domain.amountForQuantity(item.actualPaymentCents, item.quantity, quantity))
      : valueMoney(0);
  }

  function shipmentSlipText(view) {
    const grouped = new Map();
    for (const item of view.items) {
      const key = `${item.productName}\u0000${item.productNote || ''}`;
      const current = grouped.get(key) || { productName: item.productName, productNote: item.productNote || '', quantity: 0 };
      current.quantity += Number(item.quantity || 0);
      grouped.set(key, current);
    }
    return [`快递单号：${view.shipment.trackingNumber}`, ...[...grouped.values()].map((item) => `${item.productName} *${item.quantity}${item.productNote ? `（${item.productNote}）` : ''}`)].join('\n');
  }

  function printShipment(shipmentId) {
    const view = shipmentViews().find((item) => item.shipment.id === shipmentId);
    if (!view) {
      toast('快递不存在', true);
      return;
    }
    app.printText = shipmentSlipText(view);
    openModal('打印单子', `<pre class="print-preview">${esc(app.printText)}</pre><div class="print-actions"><button class="button button-quiet" type="button" data-action="copy-slip">复制内容</button><button class="button" type="button" data-action="print-slip">打印</button></div>`);
  }

  function copySlip() {
    const text = app.printText;
    if (!text) return;
    copyText(text, '单子内容已复制');
  }

  function printSlip() {
    if (window.AndroidPrint && typeof window.AndroidPrint.print === 'function') {
      try {
        window.AndroidPrint.print();
        return;
      } catch {}
    }
    if (typeof window.print === 'function') window.print();
    else toast('当前环境不支持打印，请先复制单子内容', true);
  }

  function copyText(text, successMessage) {
    const fallback = () => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(textarea);
      textarea.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch {}
      textarea.remove();
      toast(copied ? successMessage : '复制失败，请长按选择文字', !copied);
    };
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => toast(successMessage)).catch(fallback);
    } else fallback();
  }

  function saveExportFile() {
    if (!app.exportText || !app.exportFilename) return;
    if (window.AndroidBridge && typeof window.AndroidBridge.saveText === 'function') {
      try {
        window.AndroidBridge.saveText(app.exportFilename, app.exportText);
        toast('已打开系统保存位置');
        return;
      } catch {}
    }
    const blob = new Blob([app.exportText], { type: 'application/json;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = app.exportFilename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast('导出文件已生成');
  }

  function openExportPreview(title, filename, data) {
    app.exportText = JSON.stringify(data, null, 2);
    app.exportFilename = filename;
    openModal(title, `<textarea class="export-preview" readonly aria-label="导出数据">${esc(app.exportText)}</textarea><div class="export-actions"><button class="button button-quiet" type="button" data-action="copy-export">复制 JSON</button><button class="button" type="button" data-action="save-export">保存 JSON</button></div>`);
  }

  function localExport() {
    openExportPreview('导出本机数据', `order-report-local-${new Date().toISOString().slice(0, 10)}.json`, {
      exportedAt: new Date().toISOString(),
      source: 'local',
      state: app.state,
      queue: app.queue,
    });
  }

  async function serverExport() {
    try {
      const data = await apiRequest('/api/export');
      openExportPreview('导出服务器数据', `order-report-server-${new Date().toISOString().slice(0, 10)}.json`, data);
    } catch (error) { toast(error.message, true); }
  }

  document.addEventListener('click', (event) => {
    const start = event.target instanceof Element ? event.target : event.target.parentElement;
    const target = start?.closest('[data-action], [data-view]');
    // The backdrop owns the close action, but must not intercept clicks inside the modal.
    if (!target || (target.classList.contains('modal-backdrop') && event.target !== target)) return;
    event.preventDefault();
    if (target.dataset.view) {
      app.view = target.dataset.view;
      app.search = '';
      render();
      return;
    }
    const action = target.dataset.action;
    if (action === 'close-modal') {
      closeModal();
    } else if (action === 'confirm-action') {
      const callback = app.confirmation;
      closeModal();
      if (callback) callback();
    } else if (action === 'sync') {
      sync();
    } else if (action === 'sync-test') {
      testConnection();
    } else if (action === 'sync-upload') {
      uploadData();
    } else if (action === 'sync-download') {
      downloadData();
    } else if (action === 'open-settings') {
      app.view = 'settings';
      app.search = '';
      render();
    } else if (action === 'new-report') reportEditor();
    else if (action === 'edit-report') reportEditor(target.dataset.id);
    else if (action === 'void-report') {
      confirmAction('作废报单', '确定作废这笔报单吗？未使用的库存会一并退出。', () => dispatch('report.void', { id: target.dataset.id }));
    } else if (action === 'new-shipment') shipmentEditor();
    else if (action === 'edit-shipment') shipmentEditor(target.dataset.id);
    else if (action === 'print-shipment') printShipment(target.dataset.id);
    else if (action === 'void-shipment') {
      confirmAction('作废快递', '确定作废这笔快递吗？商品会退回可用仓库，已登记返款也不再计入统计。', () => dispatch('shipment.void', { id: target.dataset.id }));
    } else if (action === 'add-settlement') settlementEditor(target.dataset.id);
    else if (action === 'edit-settlement') settlementEditor(target.dataset.shipmentId, target.dataset.id);
    else if (action === 'void-settlement') {
      confirmAction('撤销实际返款', '确定撤销这笔实际返款吗？', () => dispatch('settlement.void', { id: target.dataset.id }));
    } else if (action === 'new-refund') refundEditor('', target.dataset.id || '');
    else if (action === 'edit-refund') refundEditor(target.dataset.id);
    else if (action === 'void-refund') {
      confirmAction('撤销退款', '确定撤销这笔退款吗？商品会回到可用仓库。', () => dispatch('refund.void', { id: target.dataset.id }));
    } else if (action === 'copy-slip') copySlip();
    else if (action === 'print-slip') printSlip();
    else if (action === 'add-report-item') {
      $('#report-items-editor').insertAdjacentHTML('beforeend', reportItemEditorRow({ id: '', productName: '', note: '', quantity: 1, actualPaymentCents: 0, expectedRefundCents: 0, expectedRebateCents: 0 }));
    } else if (action === 'remove-report-item') {
      const rows = $$('.report-item-editor');
      if (rows.length > 1) target.closest('tr').remove(); else toast('至少保留一个商品行', true);
    } else if (action === 'add-shipment-item') {
      $('#shipment-items-editor').insertAdjacentHTML('beforeend', shipmentItemEditorRow({ productName: '', quantity: 1 }, productOptions($('input[name="id"]')?.value || '')));
    } else if (action === 'remove-shipment-item') {
      const rows = $$('.shipment-item-editor');
      if (rows.length > 1) target.closest('tr').remove(); else toast('至少保留一个商品行', true);
    } else if (action === 'export-local') localExport();
    else if (action === 'export-server') serverExport();
    else if (action === 'copy-export') copyText(app.exportText, '导出数据已复制');
    else if (action === 'save-export') saveExportFile();
  });

  document.addEventListener('input', (event) => {
    const refundForm = event.target.closest?.('form[data-form="refund"]');
    if (refundForm) updateRefundAmount(refundForm);
    if (event.target.dataset.search) {
      app.search = event.target.value;
      render();
      const input = $(`[data-search="${event.target.dataset.search}"]`);
      if (input) { input.focus(); input.setSelectionRange(app.search.length, app.search.length); }
    }
  });

  document.addEventListener('change', (event) => {
    const refundForm = event.target.closest?.('form[data-form="refund"]');
    if (refundForm) updateRefundAmount(refundForm);
  });

  document.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      if (form.dataset.form === 'report') {
        const payload = collectReportForm(form);
        dispatch(form.elements.id.value ? 'report.update' : 'report.create', payload);
      } else if (form.dataset.form === 'shipment') {
        const payload = collectShipmentForm(form);
        dispatch(form.elements.id.value ? 'shipment.update' : 'shipment.create', payload);
      } else if (form.dataset.form === 'settlement') {
        const payload = { settlement: { id: form.elements.id.value || Domain.makeId('settlement'), shipmentId: form.elements.shipmentId.value, amountCents: parseMoneyInput(form.elements.amount.value, '实际返款金额'), settledAt: form.elements.settledAt.value, note: form.elements.note.value.trim() } };
        dispatch(form.elements.id.value ? 'settlement.update' : 'settlement.create', payload);
      } else if (form.dataset.form === 'refund') {
        const payload = { refund: { id: form.elements.id.value || Domain.makeId('refund'), reportItemId: form.elements.reportItemId.value, quantity: Number(form.elements.quantity.value), refundedAt: form.elements.refundedAt.value, note: form.elements.note.value.trim() } };
        dispatch(form.elements.id.value ? 'refund.update' : 'refund.create', payload);
      } else if (form.dataset.form === 'settings') {
        app.settings = settingsFromForm();
        app.syncError = '';
        localStorageWrite();
        render();
        toast('连接设置已保存');
      }
    } catch (error) { toast(error.message, true); }
  });

  window.onNativeExportResult = (success, message) => toast(message || (success ? '文件已保存' : '文件保存失败'), !success);
  localStorageRead();
  render();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
  sync();
  window.addEventListener('online', sync);
})();
