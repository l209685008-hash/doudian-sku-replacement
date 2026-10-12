"use strict";

(() => {
  const api = globalThis.DoudianUpdateContract;
  if (!api) return;
  const buildId = String(globalThis.DoudianBuildInfo?.id || "unknown");
  const installKey = "__doudianUpdateReceiver";
  const installVersion = buildId;
  const existingInstall = globalThis[installKey];
  if (existingInstall?.version === installVersion && typeof existingInstall.listener === "function") return;
  if (typeof existingInstall?.listener === "function") {
    chrome.runtime.onMessage.removeListener?.(existingInstall.listener);
  }

  const documentToken = "update-document-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  const completedMutations = new Map();
  const runningMutations = new Map();
  const unknownMutations = new Map();
  let activeRun = null;
  let abortedRun = null;

  const normalize = api.compareText;
  const visible = (node) => Boolean(node && node.isConnected && node.getClientRects().length);
  const text = (node) => normalize(node?.innerText || node?.textContent || "");
  const error = (code, message, evidence) => Object.assign(new Error(message), { code, evidence: evidence || null });
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const escapeRegExp = (value) => String(value).replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  const PUBLISH_CONFIRMATION_TIMEOUT_MS = 30000;
  const WASH_LINK_SCAN_PROGRESS_TYPE = "DOUDIAN_WASH_LINK_SCAN_PROGRESS";
  const WASH_LINK_TARGET_STABLE_PROGRESS_TYPE = "DOUDIAN_WASH_LINK_TARGET_STABLE_PROGRESS";
  const PUBLISH_SUCCESS_TITLE = "商品提交成功，继续发布商品视频，分享到抖音";
  const PUBLISH_FEEDBACK_SELECTOR = [
    '[role="alert"]',
    '[role="status"]',
    '.ecom-g-message',
    '.ecom-g-notification',
    '[class*="toast"]',
    '[class*="Toast"]',
    '[class*="message"]',
    '[class*="Message"]',
    '[class*="notification"]',
    '[class*="Notification"]'
  ].join(",");

  function assertPage() {
    if (location.origin !== "https://fxg.jinritemai.com") throw error("UPDATE_PAGE_ORIGIN_INVALID", "当前页面不是抖店页面。", { origin: location.origin });
  }

  function readOnlyPageFailure(code, object, reason, fix, evidence = {}) {
    const impact = "只读停止，不修改页面";
    throw error(code, object + reason + "；" + impact + "。" + fix, { object, reason, impact, fix, ...evidence });
  }

  function uniqueVisible(selector, code, label, root = document) {
    const matches = [...root.querySelectorAll(selector)].filter(visible);
    if (matches.length !== 1) throw error(code, label + "未能唯一定位。", { selector, count: matches.length });
    return matches[0];
  }

  function dispatchPointerClick(element, options = {}) {
    if (!visible(element) || element.disabled || element.getAttribute("aria-disabled") === "true") {
      readOnlyPageFailure(options.code || "UPDATE_ACTION_NOT_READY", options.object || "页面操作", "当前不可点击", options.fix || "请等待页面加载完成后重试。");
    }
    element.focus?.({ preventScroll: true });
    const rect = element.getBoundingClientRect();
    const eventInit = {
      bubbles: true, cancelable: true, composed: true,
      clientX: rect.left + Math.max(1, rect.width / 2),
      clientY: rect.top + Math.max(1, rect.height / 2),
      button: 0, buttons: 1, view: globalThis
    };
    for (const type of ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Constructor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      element.dispatchEvent(new Constructor(type, eventInit));
    }
  }

  function productTitle(node, productId) {
    const idPattern = new RegExp("(?:商品\\s*ID\\s*[:：]\\s*|\\b)" + escapeRegExp(productId) + "(?!\\d)");
    const cells = [...node.querySelectorAll("td,[role=cell]")].filter(visible).filter((cell) => idPattern.test(String(cell.innerText || cell.textContent || "")));
    if (cells.length !== 1) return "";
    return String(cells[0].innerText || cells[0].textContent || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).find((line) => !idPattern.test(line)) || "";
  }

  function editHrefAttributeCandidates(node, source) {
    if (!node) return [];
    const values = [
      ["href", node.getAttribute?.("href")],
      ["data-href", node.getAttribute?.("data-href")]
    ];
    if (node.getAttribute?.("data-href") === null && node.dataset?.href) values.push(["dataset.href", node.dataset.href]);
    return values.map(([attribute, rawValue]) => ({
      source, attribute, value: String(rawValue || "").trim()
    }));
  }

  function redactEditHrefCandidate(candidate, productId) {
    const evidence = { source: candidate.source, attribute: candidate.attribute, state: candidate.value ? "present" : "empty" };
    if (!candidate.value) return evidence;
    try {
      const url = new URL(candidate.value, location.href);
      return {
        ...evidence,
        syntax: "url",
        origin: url.origin === location.origin ? "same_origin" : "other_origin",
        path: url.pathname,
        productIdBinding: url.searchParams.get("product_id") === String(productId) ? "exact" : url.searchParams.has("product_id") ? "other" : "missing"
      };
    } catch (_) {
      return { ...evidence, syntax: "invalid" };
    }
  }

  function observeEditHref(action, productId, row) {
    if (!action) return Object.freeze({ href: null, candidates: Object.freeze([]) });
    const scoped = [];
    const seenNodes = new Set();
    const addNode = (node, source) => {
      if (!node || seenNodes.has(node)) return;
      seenNodes.add(node);
      scoped.push(...editHrefAttributeCandidates(node, source));
    };

    addNode(action, "action");
    for (let ancestor = action.parentElement; ancestor; ancestor = ancestor.parentElement) {
      addNode(ancestor, "ancestor");
      if (ancestor === row) break;
    }
    for (const descendant of action.querySelectorAll?.("a[href],[href],[data-href]") || []) addNode(descendant, "descendant");

    const evidence = scoped.map((candidate) => redactEditHrefCandidate(candidate, productId));
    const boundHrefs = new Set();
    for (const candidate of scoped.filter((candidate) => candidate.value)) {
      try {
        const url = new URL(candidate.value, location.href);
        if (url.searchParams.get("product_id") === String(productId)) boundHrefs.add(url.href);
      } catch (_) {}
    }
    if (boundHrefs.size > 1) {
      throw error("UPDATE_EDIT_HREF_AMBIGUOUS", "商品编辑入口暴露了多个不同链接，不能安全打开。", { candidates: evidence });
    }
    if (boundHrefs.size === 1) return Object.freeze({ href: [...boundHrefs][0], candidates: Object.freeze(evidence) });

    // Some list variants keep the edit URL beside, rather than inside, the text action.
    const rowCandidates = row
      ? [row, ...row.querySelectorAll?.("a[href],[href],[data-href]") || []]
        .flatMap((node) => editHrefAttributeCandidates(node, "row_product_match"))
      : [];
    const rowEvidence = rowCandidates.map((candidate) => redactEditHrefCandidate(candidate, productId));
    const rowBoundHrefs = new Set();
    for (const candidate of rowCandidates.filter((candidate) => candidate.value)) {
      try {
        const url = new URL(candidate.value, location.href);
        if (url.searchParams.get("product_id") === String(productId)) rowBoundHrefs.add(url.href);
      } catch (_) {}
    }
    if (rowBoundHrefs.size > 1) {
      throw error("UPDATE_EDIT_HREF_AMBIGUOUS", "该商品行暴露了多个精确绑定的编辑链接，不能安全打开。", { candidates: [...evidence, ...rowEvidence] });
    }
    return Object.freeze({ href: [...rowBoundHrefs][0] || null, candidates: Object.freeze([...evidence, ...rowEvidence]) });
  }

  function observedEditHref(action, productId, row) {
    return observeEditHref(action, productId, row).href;
  }

  function listRows() {
    return [...document.querySelectorAll("tr[data-row-key]")].filter(visible).map((node) => {
      const body = text(node);
      const productId = String(node.getAttribute("data-row-key") || "").trim();
      const observedId = api.extractProductId(body);
      if (!/^\d{8,}$/.test(productId) || observedId !== productId) {
        throw error("UPDATE_PRODUCT_ROW_ID_INVALID", "商品行 data-row-key 与行内 ID 不一致。", { dataRowKey: productId, observedId, body });
      }
      const rawActions = [...node.querySelectorAll("button,a,[role=button],[href],[data-href]")]
        .filter((action) => visible(action) && text(action) === "编辑");
      const actions = rawActions.filter((action) => !rawActions.some((other) => other !== action && action.contains(other)));
      const statusNode = node.querySelector('[class*="status"],[class*="state"]');
      const editObservation = actions.length === 1 ? observeEditHref(actions[0], productId, node) : null;
      return {
        node, productId, title: productTitle(node, productId), status: text(statusNode),
        editAction: actions[0] || null, editActionCount: actions.length,
        editHref: editObservation?.href || null,
        editHrefEvidence: editObservation?.candidates || Object.freeze([])
      };
    });
  }

  function paginationContainer() {
    return uniqueVisible(".ecom-g-pagination", "UPDATE_PAGINATION_UNREADABLE", "分页容器");
  }

  function listSummary() {
    const body = text(document.body);
    const pagination = paginationContainer();
    const summary = api.parseListPaginationSummary(`${text(pagination)} ${body}`);
    if (!summary) {
      throw error("UPDATE_FILTER_SUMMARY_INVALID", "无法读取当前筛选结果，请刷新商品管理页后重试。", {
        pagination: text(pagination).slice(0, 300), body: body.slice(0, 500)
      });
    }
    const active = [...pagination.querySelectorAll("li.ecom-g-pagination-item-active")].filter(visible);
    if (active.length !== 1 || !/^\d+$/.test(text(active[0]))) throw error("UPDATE_CURRENT_PAGE_UNREADABLE", "活动分页项无法唯一读取。", { count: active.length });
    return { ...summary, pageCount: Math.ceil(summary.total / summary.pageSize), currentPage: Number(text(active[0])) };
  }

  function scrollContainer(node) {
    for (let current = node; current && current !== document.body; current = current.parentElement) {
      const overflowY = globalThis.getComputedStyle?.(current)?.overflowY || "";
      if (api.isScrollableContainer({ overflowY, scrollHeight: current.scrollHeight, clientHeight: current.clientHeight })) return current;
    }
    const root = document.scrollingElement;
    return root && root.scrollHeight > root.clientHeight + 2 ? root : null;
  }

  async function collectPageRows(expectedCount) {
    const collected = new Map();
    const collect = () => listRows().forEach((row) => collected.set(row.productId, row));
    const initial = listRows();
    const container = scrollContainer(initial[0]?.node);
    if (!container) return { rows: initial, scanComplete: initial.length === expectedCount, scanEvidence: { expectedCount, collectedCount: initial.length, reason: "no_scroll_container" } };
    const origin = container.scrollTop;
    container.scrollTop = 0;
    try {
      await sleep(80);
      let steps = 0;
      for (; steps < 48; steps += 1) {
        collect();
        if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) break;
        const previous = container.scrollTop;
        container.scrollTop = Math.min(container.scrollHeight, previous + Math.max(80, container.clientHeight * 0.8));
        await sleep(80);
        if (container.scrollTop === previous) break;
      }
      collect();
      const reachedBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
      return { rows: [...collected.values()], scanComplete: reachedBottom && collected.size === expectedCount, scanEvidence: { expectedCount, collectedCount: collected.size, reachedBottom, steps } };
    } finally {
      container.scrollTop = origin;
    }
  }

  async function listEvidence() {
    const page = listSummary();
    const expectedCount = Math.min(page.pageSize, page.total - (page.currentPage - 1) * page.pageSize);
    const scanned = await collectPageRows(expectedCount);
    if (!scanned.scanComplete) {
      throw error("UPDATE_FILTER_PAGE_INCOMPLETE", "商品管理页虚拟列表未完成有界扫描，不能冻结不完整页面。", { page, ...scanned.scanEvidence, url: location.href });
    }
    const filter = new URL(location.href);
    ["page", "pageNo", "page_num"].forEach((key) => filter.searchParams.delete(key));
    return {
      filterUrl: filter.href, ...page, originalPage: page.currentPage,
      entries: scanned.rows.map((row) => ({ productId: row.productId, title: row.title, status: row.status, pageNo: page.currentPage })),
      scanEvidence: scanned.scanEvidence
    };
  }

  const PRODUCT_QUERY_PLACEHOLDER = /商品名称\s*\/\s*商品ID\s*\/\s*商家编码/;

  function listQueryInput() {
    const candidates = [...document.querySelectorAll("input")].filter((node) =>
      visible(node) && !node.disabled && PRODUCT_QUERY_PLACEHOLDER.test(String(node.placeholder || ""))
    );
    if (candidates.length !== 1) {
      throw error("UPDATE_LIST_QUERY_INPUT_UNREADABLE", "商品查询输入框未能唯一定位。", { count: candidates.length });
    }
    return candidates[0];
  }

  function listQueryButton(input) {
    const candidates = [...document.querySelectorAll("button,[role=button],a")].filter((node) =>
      visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true" && text(node) === "查询"
    );
    if (candidates.length === 1) return candidates[0];
    for (let container = input.parentElement; container && container !== document.body; container = container.parentElement) {
      const scoped = candidates.filter((node) => container.contains(node));
      if (scoped.length === 1) return scoped[0];
    }
    throw error("UPDATE_LIST_QUERY_BUTTON_UNREADABLE", "商品查询按钮未能唯一定位。", { count: candidates.length });
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (typeof setter !== "function") throw error("UPDATE_LIST_QUERY_INPUT_UNWRITABLE", "商品查询输入框无法写入。", {});
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function commitWashLinkSpecificationInput(input, specification, onDispatch = () => {}) {
    if (!input?.isConnected) {
      throw error("UPDATE_WASH_LINK_APPEND_INPUT_STALE", "新增规格输入框已失效，未提交型号。", { specification, dispatched: false });
    }
    input.focus?.({ preventScroll: true });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (typeof setter !== "function") throw error("UPDATE_WASH_LINK_APPEND_INPUT_UNWRITABLE", "新增规格输入框无法写入。", { specification, dispatched: false });
    setter.call(input, specification);
    for (const type of ["input", "change"]) input.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    if (String(input.value || "").trim() !== String(specification || "").trim()) {
      throw error("UPDATE_WASH_LINK_APPEND_INPUT_READBACK_FAILED", `新增规格“${specification}”写入型号框后回读不一致。`, {
        specification,
        actual: String(input.value || ""),
        dispatched: false
      });
    }
    onDispatch();
    await sleep(0);
    input.blur?.();
    await sleep(0);
    return { value: String(input.value || ""), events: ["focus", "input", "change", "blur"] };
  }

  function listStateSignature(state) {
    return JSON.stringify({
      filterUrl: state.filterUrl,
      total: state.total,
      pageSize: state.pageSize,
      pageCount: state.pageCount,
      currentPage: state.currentPage,
      entries: state.entries.map((entry) => entry.productId)
    });
  }

  async function waitForListSearch(query, input) {
    const deadline = Date.now() + 8000;
    // Give the merchant page time to start a new request even when its result matches the prior list.
    await sleep(350);
    let previous = null;
    let lastError = null;
    while (Date.now() < deadline) {
      if (String(input.value || "").trim() !== query) {
        throw error("UPDATE_LIST_QUERY_VALUE_DRIFT", "商品查询输入值在回读前发生变化。", { expected: query, actual: String(input.value || "") });
      }
      try {
        const state = await listEvidence();
        const signature = listStateSignature(state);
        if (previous?.signature === signature) return { ...state, query };
        previous = { signature, state };
      } catch (caught) {
        lastError = caught;
        if (/暂无数据|没有商品|未找到商品/.test(text(document.body))) {
          throw error("UPDATE_LIST_QUERY_NO_RESULTS", "该商品查询没有可替换的商品。", { query });
        }
      }
      await sleep(180);
    }
    throw error("UPDATE_LIST_QUERY_READBACK_TIMEOUT", "商品查询后列表未能稳定回读。", {
      query, lastError: lastError?.code || lastError?.message || null
    });
  }

  async function searchList(args) {
    const query = String(args?.query || "").trim();
    if (!query) throw error("UPDATE_LIST_QUERY_EMPTY", "请输入商品名称、商品 ID 或商家编码后再查询。", {});
    const input = listQueryInput();
    const button = listQueryButton(input);
    setInputValue(input, query);
    if (String(input.value || "").trim() !== query) {
      throw error("UPDATE_LIST_QUERY_VALUE_REJECTED", "商品管理页未接受输入的查询内容。", { query, actual: String(input.value || "") });
    }
    dispatchPointerClick(button, { code: "UPDATE_LIST_QUERY_BUTTON_UNAVAILABLE", object: "商品查询按钮", fix: "请等待商品管理页加载完成后重试。" });
    return waitForListSearch(query, input);
  }

  async function waitForListPage(expectedPage, code) {
    const deadline = Date.now() + 8000;
    let lastError = null;
    while (Date.now() < deadline) {
      await sleep(120);
      try {
        const state = await listEvidence();
        if (state.currentPage === expectedPage) return state;
      } catch (caught) {
        lastError = caught;
      }
    }
    throw error(code, "分页后商品列表未稳定。", { expectedPage, lastError: lastError?.code || lastError?.message || null });
  }

  async function nextPage() {
    const before = await listEvidence();
    const nextItems = [...paginationContainer().querySelectorAll("li.ecom-g-pagination-next")].filter(visible);
    const candidates = nextItems.flatMap((item) => [...item.querySelectorAll("button")]).filter((node) => visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true");
    if (candidates.length !== 1) throw error("UPDATE_PAGINATION_AMBIGUOUS", "无法唯一定位下一页控件。", { count: candidates.length });
    dispatchPointerClick(candidates[0], { object: "下一页" });
    return waitForListPage(before.currentPage + 1, "UPDATE_PAGINATION_READBACK_TIMEOUT");
  }

  async function goPage(args) {
    const target = Number(args?.pageNo);
    const before = await listEvidence();
    if (!Number.isInteger(target) || target < 1 || target > before.pageCount) throw error("UPDATE_PAGE_NUMBER_INVALID", "冻结商品的来源页码无效。", { target, pageCount: before.pageCount });
    if (before.currentPage === target) return before;
    const items = [...paginationContainer().querySelectorAll("li")].filter((node) => visible(node) && text(node) === String(target));
    if (items.length !== 1) throw error("UPDATE_SOURCE_PAGE_NOT_REACHABLE", "冻结来源页码没有唯一控件。", { target, count: items.length });
    const candidates = [...items[0].querySelectorAll("button,a,[role=button]")].filter((node) => visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true");
    if (candidates.length !== 1) throw error("UPDATE_SOURCE_PAGE_NOT_REACHABLE", "冻结来源页码没有唯一可点击控件。", { target, count: candidates.length });
    dispatchPointerClick(candidates[0], { object: "来源页 " + target });
    return waitForListPage(target, "UPDATE_SOURCE_PAGE_READBACK_TIMEOUT");
  }

  async function locateProductRow(productId) {
    const find = () => listRows().filter((row) => row.productId === productId);
    let matches = find();
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw error("UPDATE_PRODUCT_ROW_NOT_UNIQUE", "冻结商品 ID 在当前列表页匹配到多行。", { productId, count: matches.length });
    const container = scrollContainer(listRows()[0]?.node);
    if (!container) throw error("UPDATE_PRODUCT_ROW_NOT_UNIQUE", "冻结商品 ID 不在当前可完整读取的列表页。", { productId, count: 0 });
    const origin = container.scrollTop;
    container.scrollTop = 0;
    try {
      for (let step = 0; step < 48; step += 1) {
        await sleep(80);
        matches = find();
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) throw error("UPDATE_PRODUCT_ROW_NOT_UNIQUE", "冻结商品 ID 在虚拟列表中匹配到多行。", { productId, count: matches.length, step });
        const previous = container.scrollTop;
        container.scrollTop = Math.min(container.scrollHeight, previous + Math.max(80, container.clientHeight * 0.8));
        if (container.scrollTop === previous) break;
      }
    } finally {
      container.scrollTop = origin;
    }
    throw error("UPDATE_PRODUCT_ROW_NOT_UNIQUE", "冻结商品 ID 未能在来源页中重新绑定。", { productId, count: 0 });
  }

  async function openEdit(args) {
    const productId = String(args?.productId || "");
    const matching = await locateProductRow(productId);
    if (matching.editActionCount !== 1 || !matching.editAction) throw error("UPDATE_EDIT_ENTRY_NOT_UNIQUE", "该商品的编辑入口不唯一或不存在。", { productId, count: matching.editActionCount });
    if (matching.editHref) return { productId, clickDispatched: false, editHref: matching.editHref, editHrefSource: "observed", editHrefEvidence: matching.editHrefEvidence };
    const editUrl = new URL("/ffa/g/create", location.origin);
    editUrl.searchParams.set("product_id", productId);
    return {
      productId,
      clickDispatched: false,
      editHref: editUrl.href,
      editHrefSource: "canonical",
      editHrefEvidence: matching.editHrefEvidence
    };
  }

  const PRODUCT_FORM_TABS = Object.freeze(["基础信息", "图文信息", "价格库存", "服务与履约", "其他信息"]);

  function productFormTabList() {
    const candidates = [...document.querySelectorAll('[role="tablist"]')].filter(visible).filter((tabList) => {
      const tabs = [...tabList.querySelectorAll('[role="tab"]')].filter(visible);
      return tabs.length === PRODUCT_FORM_TABS.length && tabs.every((tab, index) => text(tab) === PRODUCT_FORM_TABS[index]);
    });
    if (candidates.length !== 1) {
      readOnlyPageFailure(candidates.length ? "UPDATE_PRODUCT_TABLIST_AMBIGUOUS" : "UPDATE_PRODUCT_TABLIST_MISSING", "商品编辑页五项导航", candidates.length ? "匹配到多个" : "不存在", "请确认页面已完整加载且仅打开一个商品编辑表单后重新读取。", { count: candidates.length });
    }
    return candidates[0];
  }

  function priceInventoryTab(tabList = productFormTabList()) {
    const candidates = [...tabList.querySelectorAll('[role="tab"]')].filter(visible).filter((tab) => text(tab) === "价格库存");
    if (candidates.length !== 1) readOnlyPageFailure(candidates.length ? "UPDATE_PRICE_TAB_AMBIGUOUS" : "UPDATE_PRICE_TAB_MISSING", "价格库存标签", candidates.length ? "匹配到多个" : "不存在", "请刷新商品编辑页后重试。", { count: candidates.length });
    return candidates[0];
  }

  function priceInventoryPanel() {
    const candidates = [...document.querySelectorAll("#goodsEditScrollContainer-价格库存")].filter(visible);
    if (candidates.length !== 1) readOnlyPageFailure(candidates.length ? "UPDATE_PRICE_PANEL_AMBIGUOUS" : "UPDATE_PRICE_PANEL_MISSING", "价格库存内容区", candidates.length ? "匹配到多个" : "不存在", "请刷新商品编辑页并重新展开价格库存后读取。", { count: candidates.length });
    return candidates[0];
  }

  async function activatePriceInventory() {
    let tab = priceInventoryTab();
    let clicked = false;
    if (tab.getAttribute("aria-selected") !== "true") {
      dispatchPointerClick(tab, { object: "价格库存标签" });
      clicked = true;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await sleep(80);
        tab = priceInventoryTab();
        if (tab.getAttribute("aria-selected") === "true") break;
      }
      if (tab.getAttribute("aria-selected") !== "true") readOnlyPageFailure("UPDATE_PRICE_TAB_READBACK_TIMEOUT", "价格库存标签", "点击后未稳定选中", "请刷新商品编辑页后重试。");
    }
    return { tab, panel: priceInventoryPanel(), clicked };
  }

  function readInputOrText(cell) {
    const input = cell?.querySelector("input,textarea");
    return input ? String(input.value || "") : text(cell);
  }

  function previewSource(cell) {
    const images = [...cell?.querySelectorAll("img") || []].filter(visible).map((image) => String(image.currentSrc || image.getAttribute("src") || "").trim()).filter((source) => source && !/transparent|placeholder|data:image\/(?:gif|png);base64/i.test(source));
    return images.length === 1 ? images[0] : null;
  }

  function editorSpecificationInputState(panel, specificationType = null) {
    const expectedType = specificationType === null ? null : api.assertSpecificationType(specificationType);
    const records = [...panel.querySelectorAll(api.SPECIFICATION_VALUE_INPUT_SELECTOR)]
      .filter(visible)
      .map((input) => ({
        input,
        specificationType: api.specificationTypeForPlaceholder(input.getAttribute("placeholder"))
      }));
    const observedTypes = [...new Set(records.map((record) => record.specificationType))];
    if (observedTypes.length > 1 || (expectedType && observedTypes.length === 1 && observedTypes[0] !== expectedType)) {
      throw error("UPDATE_SPEC_EDITOR_TYPE_MISMATCH", "规格编辑器输入框类型与权威 SKU 表不一致。", {
        expectedType, observedTypes, inputCount: records.length, dispatched: false
      });
    }
    const resolvedType = expectedType || observedTypes[0] || null;
    return Object.freeze({
      specificationType: resolvedType,
      inputs: Object.freeze(records
        .filter((record) => !resolvedType || record.specificationType === resolvedType)
        .map((record) => record.input))
    });
  }

  function editorSpecifications(panel, specificationType = null) {
    return editorSpecificationInputState(panel, specificationType).inputs.map((input) => {
      const specification = String(input.value || "");
      if (!normalize(specification)) return null;
      let source = null;
      for (let node = input.parentElement; node && node !== panel; node = node.parentElement) {
        if (!node.matches?.('[class*="specValueContent"],[class*="skuValue"]')) continue;
        source = previewSource(node);
        break;
      }
      return Object.freeze({ specification, source, hasImage: Boolean(source) });
    }).filter(Boolean);
  }

  function specValueBinding(panel, target, specificationType) {
    const inputs = editorSpecificationInputState(panel, specificationType).inputs
      .filter((input) => normalize(input.value));
    const decision = api.specValueDeletionDecision(target, inputs.map((input) => String(input.value || "")));
    if (decision.state === "absent") return Object.freeze({ state: "absent", specification: target });
    const input = inputs.find((candidate) => normalize(candidate.value) === normalize(decision.specification));
    let owner = input?.parentElement || null;
    while (owner && owner !== panel && !owner.matches?.('[class*="specValueContent"],[class*="skuValue"]')) owner = owner.parentElement;
    if (!owner || owner === panel) {
      throw error("UPDATE_SPEC_VALUE_OWNER_MISSING", `规格“${target}”无法绑定到唯一规格值容器，未点击删除。`, {
        specification: target, dispatched: false
      });
    }
    const iconActions = [...owner.querySelectorAll("use")]
      .filter((use) => /(?:^|#)icon-shanchu$/i.test(String(use.getAttribute("href") || use.getAttribute("xlink:href") || use.href?.baseVal || "").trim()))
      .map((use) => use.closest('button,[role="button"],[title],[aria-label]') || use.closest("svg")?.parentElement)
      .filter((node) => node && node !== owner && owner.contains(node));
    const deleteCandidates = [...new Set([...specActionCandidates(owner), ...iconActions])]
      .filter(visible)
      .filter((node) => {
        const signal = shallowSignal(node);
        return signal === "删除" || /删除(?:规格值|规格)?|delete|trash|remove/i.test(signal) || hasSpecGroupDeleteIcon(node);
      });
    if (deleteCandidates.length !== 1) {
      throw error("UPDATE_SPEC_VALUE_DELETE_ACTION_AMBIGUOUS", `规格“${target}”的删除按钮不唯一或不存在，未点击删除。`, {
        specification: target, count: deleteCandidates.length, dispatched: false
      });
    }
    return Object.freeze({ state: "unique", specification: decision.specification, input, owner, deleteButton: deleteCandidates[0] });
  }

  function shallowSignal(node) {
    return normalize([
      node.getAttribute?.("aria-label") || "", node.getAttribute?.("title") || "",
      node.getAttribute?.("data-testid") || "", node.getAttribute?.("class") || "",
      node.innerText || node.textContent || ""
    ].join(" "));
  }

  function isInsideSpecValue(node, boundary) {
    for (let current = node.parentElement; current && current !== boundary; current = current.parentElement) {
      if (current.matches?.('[class*="specValueContent"],[class*="skuValue"]')) return true;
    }
    return false;
  }

  function commonAncestor(left, right, boundary) {
    const leftAncestors = new Set();
    for (let node = left; node && node !== boundary; node = node.parentElement) leftAncestors.add(node);
    for (let node = right; node && node !== boundary; node = node.parentElement) if (leftAncestors.has(node)) return node;
    return null;
  }

  function directSpecOperationItems(root) {
    const toolbars = [
      ...(root.matches?.('div[class*="specOperations"]') ? [root] : []),
      ...root.querySelectorAll('div[class*="specOperations"]')
    ].filter(visible);
    return toolbars.flatMap((toolbar) => [...toolbar.children].filter(visible));
  }

  function hasSpecGroupDeleteIcon(node) {
    return [...node.querySelectorAll("use")].some((use) => {
      const href = use.getAttribute("href") || use.getAttribute("xlink:href") || use.href?.baseVal || "";
      return /(?:^|#)icon-shanchu$/i.test(String(href).trim());
    });
  }

  function specActionCandidates(root) {
    return [...new Set([
      ...root.querySelectorAll('button,[role="button"],[title],[aria-label]'),
      ...directSpecOperationItems(root)
    ])].filter(visible);
  }

  function specGroupObservations(panel) {
    const actions = specActionCandidates(panel);
    const down = actions.filter((node) => text(node) === "下移" || /下移/.test(shallowSignal(node)));
    const up = actions.filter((node) => text(node) === "上移" || /上移/.test(shallowSignal(node)));
    const observations = [];
    const owners = new Set();
    for (const downAction of down) {
      for (const upAction of up) {
        const owner = commonAncestor(downAction, upAction, panel);
        if (!owner || owners.has(owner)) continue;
        const deleteCandidates = specActionCandidates(owner)
          .filter((node) => node !== downAction && node !== upAction)
          .filter((node) => !isInsideSpecValue(node, owner))
          .filter((node) => {
            const signal = shallowSignal(node);
            return signal === "删除" || /删除(?:规格|规格组)?|delete|trash|remove/i.test(signal) || hasSpecGroupDeleteIcon(node);
          });
        owners.add(owner);
        observations.push(Object.freeze({ owner, deleteCandidates: Object.freeze(deleteCandidates), downAction, upAction }));
      }
    }
    return observations;
  }

  function specGroupBindings(panel) {
    return specGroupObservations(panel)
      .filter((observation) => observation.deleteCandidates.length === 1)
      .map((observation) => Object.freeze({
        owner: observation.owner,
        deleteButton: observation.deleteCandidates[0],
        downAction: observation.downAction,
        upAction: observation.upAction
      }));
  }

  function emptySpecificationEditorEvidence(panel) {
    const entryButtons = [...panel.querySelectorAll("button,[role=button]")]
      .filter(visible)
      .filter((node) => /^添加规格类型\s*\(0\/3\)$/.test(normalize(text(node))));
    if (entryButtons.length > 1) {
      throw error("UPDATE_EMPTY_SPEC_ENTRY_AMBIGUOUS", "空规格编辑器的添加规格类型入口不唯一。", { count: entryButtons.length });
    }
    return Object.freeze({ confirmed: entryButtons.length === 1, entryCount: entryButtons.length });
  }

  function pendingSpecificationTypeEvidence(panel) {
    const owners = [...panel.querySelectorAll('[attr-field-id="spec_detail_0_name"]')].filter(visible);
    const entryButtons = [...panel.querySelectorAll("button,[role=button]")]
      .filter(visible)
      .filter((node) => /^添加规格类型\s*\(1\/3\)$/.test(normalize(text(node))));
    const selectedTypes = owners.flatMap((owner) => [...owner.querySelectorAll('.ecom-g-select-selection-item')]
      .filter(visible)
      .map((node) => String(node.getAttribute("title") || normalize(text(node))))
      .filter(Boolean));
    return Object.freeze({
      confirmed: owners.length === 1 && entryButtons.length === 1 && selectedTypes.length === 0,
      ownerCount: owners.length,
      entryCount: entryButtons.length,
      selectedTypeCount: selectedTypes.length
    });
  }

  function skuHeaderRow(panel) {
    const matches = [...panel.querySelectorAll("tr,[role=row]")].filter(visible).filter((node) => /规格/.test(text(node)) && /SKUID/i.test(text(node)) && /商家编码/.test(text(node)));
    if (matches.length > 1) throw error("UPDATE_SKU_TABLE_AMBIGUOUS", "权威 SKU 表表头不唯一。", { count: matches.length });
    return matches[0] || null;
  }

  function skuColumns(headerRow) {
    const headers = [...headerRow.querySelectorAll("th,[role=columnheader],td")].map((node) => text(node).replace(/^\*\s*/, ""));
    const acceptedSpecificationHeaders = new Set(["规格", "商品规格"]);
    const specificationMatches = headers
      .map((name, index) => acceptedSpecificationHeaders.has(name) ? Object.freeze({ name, index }) : null)
      .filter(Boolean);
    const stockHeader = headers.includes("库存") ? "库存" : headers.includes("现货库存") ? "现货库存" : null;
    const requiredHeaders = ["价格", "SKUID", "商家编码", "预览图"];
    if (specificationMatches.length !== 1 || !stockHeader || requiredHeaders.some((name) => !headers.includes(name))) {
      throw error("UPDATE_SKU_HEADERS_INVALID", "SKU 表必须包含唯一的规格或商品规格列，以及价格、库存、SKUID、商家编码和预览图列。", { headers, specificationMatches });
    }
    const specification = specificationMatches[0].index;
    return {
      headers,
      specificationType: specificationMatches[0].name,
      indexes: Object.freeze({
        specification, price: headers.indexOf("价格"),
        stock: headers.indexOf(stockHeader), skuId: headers.indexOf("SKUID"),
        merchantCode: headers.indexOf("商家编码"), preview: headers.indexOf("预览图"),
        status: headers.findIndex((header) => ["SKU状态", "状态"].includes(header)),
        availableStock: headers.findIndex((header) => ["可售库存", "可用库存"].includes(header))
      })
    };
  }

  function dimensionCount(headerRow) {
    if (!headerRow) return 0;
    const indexes = [...headerRow.querySelectorAll("th,[role=columnheader],td")].flatMap((node) => [...node.classList].map((name) => /^attr-column-field_spec_(\d+)$/.exec(name)).filter(Boolean).map((match) => Number(match[1])));
    const unique = [...new Set(indexes)].sort((left, right) => left - right);
    if (!unique.length) return 1;
    if (unique.some((value, index) => value !== index)) throw error("UPDATE_DIMENSION_UNREADABLE", "权威 SKU 表规格列无法证明为连续维度。", { indexes: unique });
    return unique.length;
  }

  function structureGuardShape(shape) {
    const stableSort = (left, right) => {
      const leftKey = JSON.stringify(left);
      const rightKey = JSON.stringify(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    };
    const editorSpecifications = Array.from(shape?.editorSpecs || [], (row) => normalize(row?.specification))
      .sort(stableSort);
    const skuRows = Array.from(shape?.skuRows || [], (row) => ({
      skuId: normalize(row?.skuId),
      specification: normalize(row?.specification),
      price: normalize(row?.price),
      stock: normalize(row?.stock),
      merchantCode: normalize(row?.merchantCode)
    })).sort(stableSort);
    return Object.freeze({
      specificationType: normalize(shape?.specificationType),
      groupCount: Number(shape?.groupCount) || 0,
      dimensionCount: Number(shape?.dimensionCount) || 0,
      editorSpecifications: Object.freeze(editorSpecifications),
      skuRows: Object.freeze(skuRows.map((row) => Object.freeze(row)))
    });
  }

  function skuTableContainer(headerRow) {
    if (!headerRow) return null;
    const headerCount = headerRow.querySelectorAll("th,[role=columnheader],td").length;
    for (let node = headerRow.parentElement; node && node !== document.body; node = node.parentElement) {
      const rows = [...node.querySelectorAll("tr,[role=row]")].filter((row) => row !== headerRow && visible(row) && row.querySelectorAll("td,[role=cell]").length >= headerCount);
      if (rows.length) return node;
    }
    return headerRow.parentElement;
  }

  async function scanSkuRows(headerRow, columns) {
    if (!headerRow) return { skuRows: [], scanComplete: true, scanEvidence: { collectedCount: 0, steps: 0 } };
    const table = skuTableContainer(headerRow);
    const holders = [...table.querySelectorAll(".ecom-g-table-tbody-virtual-holder")].filter(visible);
    if (holders.length > 1) throw error("UPDATE_SKU_TABLE_UNREADABLE", "权威 SKU 表虚拟滚动容器不唯一。", { count: holders.length });
    const holder = holders[0] || table;
    const collected = new Map();
    const collect = () => {
      const occurrences = new Map();
      [...holder.querySelectorAll("tr,[role=row]")].filter((node) => node !== headerRow && visible(node)).forEach((node) => {
        const cells = [...node.querySelectorAll("td,[role=cell]")];
        if (cells.length <= Math.max(...Object.values(columns))) return;
        const imageSource = previewSource(cells[columns.preview]);
        const record = Object.freeze({
          specification: readInputOrText(cells[columns.specification]),
          price: readInputOrText(cells[columns.price]),
          stock: readInputOrText(cells[columns.stock]),
          skuId: text(cells[columns.skuId]),
          merchantCode: readInputOrText(cells[columns.merchantCode]),
          availableStock: columns.availableStock >= 0 ? readInputOrText(cells[columns.availableStock]) : "",
          status: columns.status >= 0 ? text(cells[columns.status]) : "",
          imageSource,
          hasImage: Boolean(imageSource)
        });
        const rowKey = String(node.getAttribute("data-row-key") || "").trim();
        const baseKey = record.skuId ? "sku:" + record.skuId : rowKey ? "row:" + rowKey : "spec:" + normalize(record.specification);
        const occurrence = (occurrences.get(baseKey) || 0) + 1;
        occurrences.set(baseKey, occurrence);
        collected.set(record.skuId || rowKey ? baseKey : baseKey + "#" + occurrence, record);
      });
    };
    const origin = Number(holder.scrollTop) || 0;
    let steps = 0;
    try {
      holder.scrollTop = 0;
      holder.dispatchEvent?.(new Event("scroll", { bubbles: true }));
      await sleep(80);
      collect();
      if (!holders.length || holder.scrollHeight <= holder.clientHeight + 2) {
        return { skuRows: [...collected.values()], scanComplete: true, scanEvidence: { collectedCount: collected.size, steps: 0, startedAtTop: true } };
      }
      for (; steps < 48; steps += 1) {
        collect();
        if (holder.scrollTop + holder.clientHeight >= holder.scrollHeight - 2) break;
        const previous = holder.scrollTop;
        holder.scrollTop = Math.min(holder.scrollHeight, previous + Math.max(80, holder.clientHeight * 0.8));
        holder.dispatchEvent?.(new Event("scroll", { bubbles: true }));
        await sleep(80);
        if (holder.scrollTop === previous) break;
      }
      collect();
      const scanComplete = holder.scrollTop + holder.clientHeight >= holder.scrollHeight - 2;
      return { skuRows: [...collected.values()], scanComplete, scanEvidence: { collectedCount: collected.size, steps, startedAtTop: true } };
    } finally {
      holder.scrollTop = origin;
      holder.dispatchEvent?.(new Event("scroll", { bubbles: true }));
      await sleep(80);
    }
  }

  function assertProductId(productId) {
    const actual = new URL(location.href).searchParams.get("product_id");
    if (!/^\d{8,}$/.test(productId) || actual !== productId) throw error("UPDATE_EDIT_PRODUCT_ID_MISMATCH", "商品编辑页 product_id 与冻结商品不一致。", { expected: productId, actual, url: location.href });
  }

  async function readStructure(args) {
    const productId = String(args?.productId || "");
    assertProductId(productId);
    const priceInventory = await activatePriceInventory();
    const groupBindings = specGroupBindings(priceInventory.panel);
    let editorSpecs = editorSpecifications(priceInventory.panel);
    if (groupBindings.length === 0 && editorSpecs.length === 0) {
      const emptyEvidence = emptySpecificationEditorEvidence(priceInventory.panel);
      const pendingEvidence = emptyEvidence.confirmed ? null : pendingSpecificationTypeEvidence(priceInventory.panel);
      if (!emptyEvidence.confirmed && !pendingEvidence.confirmed) {
        throw error("UPDATE_EMPTY_SPEC_STRUCTURE_UNPROVEN", "规格编辑器没有规格组，但也未观察到可恢复的空规格状态。", { emptyEvidence, pendingEvidence });
      }
      const shape = { specificationType: null, groupCount: 0, dimensionCount: 0, editorSpecs: [], skuRows: [] };
      const guardShape = structureGuardShape(shape);
      return Object.freeze({
        productId, liveEditUrl: location.href, documentToken, empty: true, ...shape,
        editorRuntimeReady: Boolean(globalThis.DoudianProductEditorRuntime?.execute),
        scanComplete: true, skuScanComplete: true, scanEvidence: Object.freeze({ collectedCount: 0, steps: 0, emptySpecificationEditor: true }),
        emptyEvidence: Object.freeze({ ...emptyEvidence, pendingSpecificationType: Boolean(pendingEvidence?.confirmed), pendingEvidence }),
        guardShape, structureDigest: api.stableDigest(guardShape)
      });
    }
    const headerRow = skuHeaderRow(priceInventory.panel);
    const columnPlan = headerRow ? skuColumns(headerRow) : null;
    editorSpecs = editorSpecifications(priceInventory.panel, columnPlan?.specificationType || null);
    const scanned = await scanSkuRows(headerRow, columnPlan?.indexes);
      const shape = {
      specificationType: columnPlan?.specificationType || null,
      groupCount: groupBindings.length,
      dimensionCount: dimensionCount(headerRow),
      editorSpecs: editorSpecs.map((row) => ({ specification: row.specification, hasImage: row.hasImage, source: row.source })),
      skuRows: scanned.skuRows
    };
    const guardShape = structureGuardShape(shape);
    const empty = shape.groupCount === 0 && shape.editorSpecs.length === 0 && shape.skuRows.length === 0;
    const expectedCount = shape.dimensionCount === 1 ? shape.editorSpecs.length : null;
    const collectedCount = shape.skuRows.length;
    const scanComplete = scanned.scanComplete && (expectedCount === null || collectedCount === expectedCount);
    const scanEvidence = Object.freeze({
      ...scanned.scanEvidence,
      expectedCount,
      collectedCount,
      countMatched: expectedCount === null ? null : collectedCount === expectedCount
    });
    return Object.freeze({
      productId, liveEditUrl: location.href, documentToken, empty, ...shape,
      editorRuntimeReady: Boolean(globalThis.DoudianProductEditorRuntime?.execute),
      scanComplete, skuScanComplete: scanned.scanComplete, scanEvidence,
      guardShape,
      structureDigest: api.stableDigest(guardShape)
    });
  }

  async function inspectReplaceGroup(args) {
    const productId = String(args?.productId || "");
    assertProductId(productId);
    const priceInventory = await activatePriceInventory();
    const observations = specGroupObservations(priceInventory.panel);
    if (observations.length !== 1) {
      throw error(observations.length ? "UPDATE_REPLACE_GROUP_AMBIGUOUS" : "UPDATE_REPLACE_GROUP_NOT_READY",
        observations.length ? "价格库存中存在多个规格组，不能执行整组重建。" : "价格库存中未找到唯一规格组，不能执行整组重建。", {
          productId, groupCount: observations.length, dispatched: false,
          fix: "确认价格库存仅保留一个需要整组重建的规格组后重新执行。"
        });
    }
    const deleteActionCount = observations[0].deleteCandidates.length;
    if (deleteActionCount !== 1) {
      throw error("UPDATE_SPEC_GROUP_DELETE_ACTION_AMBIGUOUS", "唯一规格组的组级删除动作不唯一。", {
        productId, groupCount: 1, deleteActionCount, dispatched: false,
        fix: "确认规格组工具栏仅有一个可用删除按钮后重新执行。"
      });
    }
    const editorState = editorSpecificationInputState(priceInventory.panel);
    if (!editorState.specificationType || editorState.inputs.length === 0) {
      throw error("UPDATE_REPLACE_SPECIFICATION_TYPE_UNPROVEN", "唯一规格组的类型或规格输入框尚未稳定显示。", {
        productId, groupCount: 1, specificationType: editorState.specificationType || null,
        editorInputCount: editorState.inputs.length, dispatched: false,
        fix: "等待“规格”或“商品规格”输入框显示后重新执行。"
      });
    }
    const specificationType = api.assertSpecificationType(editorState.specificationType);
    const guardShape = Object.freeze({
      productId,
      specificationType,
      groupCount: 1,
      dimensionCount: 1,
      deleteActionCount: 1
    });
    return Object.freeze({
      productId,
      specificationType,
      groupCount: 1,
      dimensionCount: 1,
      deleteActionCount: 1,
      editorInputCount: editorState.inputs.length,
      guardShape,
      structureDigest: api.stableDigest(guardShape),
      binding: observations[0]
    });
  }

  async function readReplaceGroup(args) {
    const inspected = await inspectReplaceGroup(args);
    const { binding, ...result } = inspected;
    return Object.freeze(result);
  }

  function mutationEnvelope(message) {
    const commandId = String(message?.commandId || "");
    const expectedArgsDigest = api.stableDigest(message?.args || {});
    if (!commandId) throw error("UPDATE_COMMAND_ID_MISSING", "写命令缺少 commandId。", { command: message?.command });
    if (message?.argsDigest !== expectedArgsDigest) throw error("UPDATE_ARGS_DIGEST_MISMATCH", "写命令参数摘要不一致。", { command: message?.command, expected: expectedArgsDigest, actual: message?.argsDigest || null });
    return { commandId, argsDigest: expectedArgsDigest };
  }

  async function runMutation(message, action) {
    const envelope = mutationEnvelope(message);
    const completed = completedMutations.get(envelope.commandId);
    if (completed) {
      if (completed.argsDigest !== envelope.argsDigest) throw error("UPDATE_RECEIPT_ARGS_MISMATCH", "已完成命令的参数摘要不一致。", { commandId: envelope.commandId });
      return completed.result;
    }
    const unknown = unknownMutations.get(envelope.commandId);
    if (unknown) throw error("UPDATE_MUTATION_OUTCOME_UNKNOWN", "该写命令曾返回未知结果，禁止自动重发。", unknown);
    if (runningMutations.has(envelope.commandId)) throw error("UPDATE_MUTATION_RUNNING", "相同写命令仍在执行。", { commandId: envelope.commandId });
    runningMutations.set(envelope.commandId, envelope.argsDigest);
    try {
      const result = await action(envelope);
      const frozen = Object.freeze({
        ...result,
        receipt: Object.freeze({ commandId: envelope.commandId, argsDigest: envelope.argsDigest, status: "completed" })
      });
      completedMutations.set(envelope.commandId, { command: message.command, argsDigest: envelope.argsDigest, result: frozen });
      return frozen;
    } catch (caught) {
      if (caught?.evidence?.dispatched === true || caught?.evidence?.outcomeUnknown === true) {
        unknownMutations.set(envelope.commandId, Object.freeze({ commandId: envelope.commandId, argsDigest: envelope.argsDigest, command: message.command, code: caught.code || "UPDATE_MUTATION_OUTCOME_UNKNOWN" }));
      }
      throw caught;
    } finally {
      runningMutations.delete(envelope.commandId);
    }
  }

  async function confirmSpecDelete(options) {
    options = options || {};
    const waitForDialog = options.waitForDialog !== false;
    const confirmCopy = normalize("确定删除该规格么？");
    const confirmCopyPattern = /确定删除.*规格.*(?:么|吗)[？?]?/;
    const confirmButtonCopies = new Set(["删除", "确定"]);
    const dialogText = (dialog) => text(dialog).slice(0, 240);
    const hasConfirmCopy = (dialog) => {
      const body = text(dialog);
      if (body.includes(confirmCopy) || confirmCopyPattern.test(body)) return true;
      return [
        dialog,
        ...dialog.querySelectorAll("h1,h2,h3,h4,p,div,span")
      ].some((node) => confirmCopyPattern.test(text(node)));
    };
    const dialogCandidates = () => {
      const roleDialogs = [...document.querySelectorAll('[role="dialog"]')]
        .filter(visible)
        .filter(hasConfirmCopy);
      if (roleDialogs.length) return roleDialogs;
      const modalCandidates = [...new Set([
        ...document.querySelectorAll('[class*="modal"]'),
        ...document.querySelectorAll('[class*="Modal"]')
      ])]
        .filter(visible)
        .filter(hasConfirmCopy)
        .filter((candidate) => [...candidate.querySelectorAll('button,[role="button"]')].some(visible));
      if (modalCandidates.length) {
        return modalCandidates.filter((candidate) => !modalCandidates.some((child) => child !== candidate && candidate.contains(child)));
      }
      const copyNodes = [...document.querySelectorAll("h1,h2,h3,h4,p,div,span")]
        .filter(visible)
        .filter((node) => confirmCopyPattern.test(text(node)));
      const inferred = copyNodes.map((node) => {
        let candidate = node;
        for (let depth = 0; candidate && depth < 8; depth += 1, candidate = candidate.parentElement) {
          const actions = [...candidate.querySelectorAll('button,[role="button"]')]
            .filter(visible)
            .map((button) => text(button));
          if (actions.includes("取消") && actions.some((copy) => confirmButtonCopies.has(copy))) return candidate;
        }
        return null;
      }).filter(Boolean);
      return [...new Set(inferred)].filter((candidate) => !inferred.some((child) => child !== candidate && candidate.contains(child)));
    };
    const inspectDialog = (dialog) => {
      const explicitButtonAreas = [...dialog.querySelectorAll('.ecom-g-modal-confirm-btns,[class*="modal-confirm-btns"],[class*="modal-confirm-footer"]')].filter(visible);
      const buttonAreas = explicitButtonAreas.length ? explicitButtonAreas : [dialog];
      const buttons = buttonAreas.flatMap((area) => [...new Set([
        ...area.querySelectorAll('button[type="button"]'),
        ...area.querySelectorAll('button'),
        ...area.querySelectorAll('[role="button"]')
      ])]
        .filter(visible)
        .filter((node) => confirmButtonCopies.has(text(node))));
      return { dialog, buttonAreas, buttons, dialogText: dialogText(dialog) };
    };
    const deadline = Date.now() + 5000;
    let lastEvidence = { dialogCount: 0, buttonAreaCount: 0, buttonCount: 0, dialogText: "", dispatched: false };
    while (Date.now() < deadline) {
      const dialogs = dialogCandidates();
      const inspections = dialogs.map(inspectDialog);
      lastEvidence = {
        dialogCount: dialogs.length,
        buttonAreaCount: inspections.reduce((count, item) => count + item.buttonAreas.length, 0),
        buttonCount: inspections.reduce((count, item) => count + item.buttons.length, 0),
        dialogText: inspections.map((item) => item.dialogText).join(" | ").slice(0, 240),
        dispatched: false
      };
      if (dialogs.length > 1) {
        throw error("UPDATE_SPEC_DELETE_CONFIRM_DIALOG_AMBIGUOUS", "规格组删除确认对话框不唯一。", lastEvidence);
      }
      if (dialogs.length === 1) {
        const inspection = inspections[0];
        if (inspection.buttonAreas.length > 1) {
          throw error("UPDATE_SPEC_DELETE_CONFIRM_AREA_AMBIGUOUS", "规格组删除确认按钮区不唯一。", lastEvidence);
        }
        if (inspection.buttonAreas.length === 1 && inspection.buttons.length > 1) {
          throw error("UPDATE_SPEC_DELETE_CONFIRM_AMBIGUOUS", "规格组删除确认主按钮不唯一。", lastEvidence);
        }
        if (inspection.buttonAreas.length === 1 && inspection.buttons.length === 1) {
          dispatchPointerClick(inspection.buttons[0], { object: "规格组删除确认" });
          const closeDeadline = Date.now() + 5000;
          while (Date.now() < closeDeadline) {
            const openConfirmDialogs = [...document.querySelectorAll('[role="dialog"]')]
              .filter(visible)
              .filter(hasConfirmCopy);
            if (openConfirmDialogs.length === 0) {
              openConfirmDialogs.push(...dialogCandidates());
            }
            if (openConfirmDialogs.length === 0) {
              return waitForDialog ? true : { state: "confirmed", evidence: lastEvidence };
            }
            await sleep(80);
          }
          throw error("UPDATE_SPEC_DELETE_CONFIRM_CLOSE_TIMEOUT", "规格组删除确认已派发，但确认对话框未关闭。", {
            ...lastEvidence,
            dispatched: true,
            outcomeUnknown: true
          });
        }
      }
      if (!waitForDialog) {
        return {
          state: dialogs.length === 0 ? "absent" : "pending",
          evidence: lastEvidence
        };
      }
      await sleep(80);
    }
    throw error("UPDATE_SPEC_DELETE_CONFIRM_NOT_READY", "未能唯一定位规格删除确认对话框及其主按钮。", {
      ...lastEvidence,
      candidateSelector: '[role="dialog"],[class*="modal"],[class*="Modal"],确认文案最近含取消及确认按钮祖先',
      expectedCopy: confirmCopy,
      expectedCopyPattern: String(confirmCopyPattern)
    });
  }

  async function settleSpecDeletion(options) {
    let confirmationMode = "direct_readback";
    let confirmationCompleted = false;
    let lastConfirmEvidence = null;
    if (options.requireConfirmationBeforeRead === true) {
      try {
        await confirmSpecDelete({ waitForDialog: true });
        confirmationMode = "confirmed";
        confirmationCompleted = true;
      } catch (caught) {
        throw error(caught?.code || "UPDATE_SPEC_DELETE_CONFIRM_FAILED", caught?.message || "规格删除确认失败。", {
          ...(caught?.evidence || {}),
          dispatched: true,
          outcomeUnknown: true
        });
      }
    }
    const deadline = Date.now() + 10000;
    let stableReads = 0;
    let stableDigest = "";
    let last = null;
    let lastError = null;
    while (Date.now() < deadline) {
      if (!confirmationCompleted) {
        try {
          const confirmation = await confirmSpecDelete({ waitForDialog: false });
          lastConfirmEvidence = confirmation?.evidence || lastConfirmEvidence;
          if (confirmation?.state === "confirmed") {
            confirmationMode = "confirmed";
            confirmationCompleted = true;
          } else if (confirmation?.state === "pending") {
            await sleep(80);
            continue;
          }
        } catch (caught) {
          if (caught?.code === "UPDATE_SPEC_DELETE_CONFIRM_NOT_READY") {
            lastConfirmEvidence = caught?.evidence || lastConfirmEvidence;
          } else {
            throw error(caught?.code || "UPDATE_SPEC_DELETE_CONFIRM_FAILED", caught?.message || "规格删除确认失败。", {
              ...(caught?.evidence || {}),
              dispatched: true,
              outcomeUnknown: true
            });
          }
        }
      }
      try {
        last = await options.readState();
        lastError = null;
        if (options.isDeleted(last)) {
          stableReads = stableDigest === last.structureDigest ? stableReads + 1 : 1;
          stableDigest = last.structureDigest;
          if (stableReads >= 2) return { confirmationMode, last };
        } else {
          stableReads = 0;
          stableDigest = "";
        }
      } catch (caught) {
        lastError = caught;
        stableReads = 0;
        stableDigest = "";
      }
      await sleep(120);
    }

    const evidence = {
      ...(lastConfirmEvidence || {}),
      lastDigest: last?.structureDigest || null,
      lastReadError: lastError?.code || lastError?.message || null,
      dispatched: true,
      outcomeUnknown: true,
      impact: "不保存、不发布、不自动重发，保留页面供人工检查。"
    };
    if (!confirmationCompleted) {
      throw error("UPDATE_SPEC_DELETE_CONFIRM_NOT_READY", "规格删除按钮已派发，但未观察到可确认弹窗，也未稳定回读到目标规格消失。", evidence);
    }
    throw error(options.timeoutCode, options.timeoutMessage, evidence);
  }

  async function deleteSpecGroup(message) {
    return runMutation(message, async () => {
      const args = message.args || {};
      const expectedSpecificationType = api.assertSpecificationType(args.expectedSpecificationType);
      const before = await inspectReplaceGroup({ productId: args.productId });
      if (before.specificationType !== expectedSpecificationType) {
        throw error("UPDATE_SPECIFICATION_TYPE_DRIFT", "删除前商品规格类型名称已变化，未点击删除。", {
          expectedSpecificationType,
          actualSpecificationType: before.specificationType || null,
          dispatched: false
        });
      }
      const expectedGuardDigest = api.stableDigest(args.expectedGroupGuardShape);
      const actualGuardDigest = api.stableDigest(before.guardShape);
      if (!args.targetDigest || !args.expectedGroupGuardShape || expectedGuardDigest !== actualGuardDigest) {
        throw error("UPDATE_SPEC_DELETE_STRUCTURE_DRIFT", "当前结构与冻结快照不一致，未点击删除。", {
          actualStructureDigest: before.structureDigest,
          expectedGuardDigest,
          actualGuardDigest,
          expectedGroupGuardShape: args.expectedGroupGuardShape || null,
          actualGuardShape: before.guardShape,
          editorInputCount: before.editorInputCount,
          targetDigest: args.targetDigest || null,
          dispatched: false
        });
      }
      dispatchPointerClick(before.binding.deleteCandidates[0], { code: "UPDATE_SPEC_GROUP_DELETE_NOT_READY", object: "规格组级删除按钮" });
      const settled = await settleSpecDeletion({
        requireConfirmationBeforeRead: true,
        readState: () => readStructure({ productId: args.productId }),
        isDeleted: (state) => state.empty === true && state.scanComplete === true,
        timeoutCode: "UPDATE_SPEC_DELETE_POSTCONDITION_TIMEOUT",
        timeoutMessage: "规格组删除后未稳定回读为空结构。"
      });
      return {
        state: "spec_structure_empty", productId: args.productId,
        specificationType: expectedSpecificationType,
        beforeDigest: before.structureDigest, afterDigest: settled.last.structureDigest,
        targetDigest: args.targetDigest, confirmationMode: settled.confirmationMode, dispatched: true
      };
    });
  }

  async function deleteSpecValue(message) {
    return runMutation(message, async () => {
      const args = message.args || {};
      const productId = String(args.productId || "");
      const specification = String(args.specification || "");
      const before = await readStructure({ productId });
      const decision = api.specValueDeletionDecision(specification, before.editorSpecs.map((item) => item.specification));
      if (decision.state === "absent") {
        return {
          state: "no_change", productId, specification,
          beforeDigest: before.structureDigest, afterDigest: before.structureDigest,
          dispatched: false
        };
      }
      const panel = (await activatePriceInventory()).panel;
      const binding = specValueBinding(panel, specification, before.specificationType);
      if (binding.state !== "unique") {
        throw error("UPDATE_SPEC_VALUE_STRUCTURE_DRIFT", `规格“${specification}”在删除前发生变化，未点击删除。`, {
          productId, specification, dispatched: false
        });
      }
      dispatchPointerClick(binding.deleteButton, {
        code: "UPDATE_SPEC_VALUE_DELETE_NOT_READY",
        object: `规格“${specification}”删除按钮`
      });
      const settled = await settleSpecDeletion({
        readState: () => readStructure({ productId }),
        isDeleted: (state) => state.scanComplete === true &&
          api.specValueDeletionDecision(specification, state.editorSpecs.map((item) => item.specification)).state === "absent",
        timeoutCode: "UPDATE_SPEC_VALUE_DELETE_POSTCONDITION_TIMEOUT",
        timeoutMessage: `规格“${specification}”点击删除后未稳定回读为已消失。`
      });
      return {
        state: "deleted", productId, specification,
        beforeDigest: before.structureDigest, afterDigest: settled.last.structureDigest,
        confirmationMode: settled.confirmationMode, dispatched: true
      };
    });
  }

  function washLinkBase(value) {
    return api.washLinkModelKey(value);
  }

  function washLinkExistingKey(value) {
    return api.washLinkExistingKey(value);
  }

  function washLinkBracketText(value) {
    return String(value ?? "").match(/【([^】]*)】/)?.[1] || "";
  }

  function washLinkUsableSkuId(value) {
    const skuId = normalize(value);
    return Boolean(skuId && !["-", "—", "–", "未知", "无"].includes(skuId));
  }

  function washLinkSpecificationWithExcelLabel(currentSpecification, excelSpecification) {
    const current = normalize(currentSpecification);
    const target = normalize(excelSpecification);
    const targetLabel = washLinkBracketText(target);
    if (!targetLabel) return current;
    return /【[^】]*】/.test(current)
      ? current.replace(/【[^】]*】/, `【${targetLabel}】`)
      : `【${targetLabel}】${current}`;
  }

  function washLinkRowContainer(panel, columns) {
    const header = skuHeaderRow(panel);
    const table = skuTableContainer(header);
    const holders = [...table.querySelectorAll(".ecom-g-table-tbody-virtual-holder")].filter(visible);
    if (holders.length > 1) throw error("UPDATE_WASH_LINK_TABLE_AMBIGUOUS", "洗链接 SKU 表虚拟容器不唯一。", { count: holders.length });
    return { header, table, holder: holders[0] || table };
  }

  function washLinkCells(row, columns) {
    const cells = [...row.querySelectorAll("td,[role=cell]")];
    if (cells.length <= Math.max(columns.specification, columns.price, columns.stock, columns.merchantCode)) return null;
    return cells;
  }

  function washLinkSpecificationKey(value) {
    return normalize(String(value || "")).replace(/[\s\u00a0\u200b]+/g, "");
  }

  function washLinkVisibleRows(holder, table) {
    return [...holder.querySelectorAll("tr,[role=row]")]
      .filter((row) => visible(row) && row !== table.querySelector("thead tr"));
  }

  function washLinkRowsFingerprint(rows, columns) {
    return rows.map((row) => {
      const cells = washLinkCells(row, columns);
      return cells ? `${normalize(readInputOrText(cells[columns.skuId]))}|${washLinkSpecificationKey(readInputOrText(cells[columns.specification]))}` : "";
    }).join("\n");
  }

  async function waitForWashLinkVisibleRows(holder, table, columns) {
    let previous = null;
    let rows = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      rows = washLinkVisibleRows(holder, table);
      const fingerprint = washLinkRowsFingerprint(rows, columns);
      if (rows.length && fingerprint === previous) return rows;
      previous = fingerprint;
      await sleep(100);
    }
    return rows;
  }

  function reportWashLinkScanProgress(skuId, pass, segment) {
    chrome.runtime.sendMessage({
      type: WASH_LINK_SCAN_PROGRESS_TYPE,
      runToken: activeRun,
      skuId: String(skuId),
      pass,
      totalPasses: 2,
      segment
    }).catch(() => {});
  }

  function reportWashLinkTargetStableProgress(previousSkuId, targetSpecification, stableCount, attempt) {
    chrome.runtime.sendMessage({
      type: WASH_LINK_TARGET_STABLE_PROGRESS_TYPE,
      runToken: activeRun,
      previousSkuId: String(previousSkuId),
      targetSpecification: String(targetSpecification),
      stableCount,
      requiredStableReads: 2,
      attempt
    }).catch(() => {});
  }

  async function findWashLinkRow(panel, columns, specification) {
    const target = washLinkSpecificationKey(specification);
    let originHolder = null;
    let originScrollTop = 0;
    try {
      for (let retry = 0; retry < 30; retry += 1) {
        let table;
        let holder;
        let liveColumns;
        try {
          ({ table, holder } = washLinkRowContainer(panel, columns));
          liveColumns = skuColumns(skuHeaderRow(panel)).indexes;
        } catch (caught) {
          const transient = /UPDATE_(SKU_TABLE|SKU_HEADERS|PRICE_PANEL|PRICE_TAB)/.test(String(caught?.code || ""));
          if (!transient || retry >= 29) throw caught;
          await sleep(250);
          continue;
        }
        if (!originHolder) {
          originHolder = holder;
          originScrollTop = Number(holder.scrollTop) || 0;
        }
        holder.scrollTop = 0;
        holder.dispatchEvent?.(new Event("scroll", { bubbles: true }));
        await sleep(80);
        for (let step = 0; step < 60; step += 1) {
        const rows = [...holder.querySelectorAll("tr,[role=row]")].filter((row) => visible(row) && row !== table.querySelector("thead tr"));
        for (const row of rows) {
          const cells = washLinkCells(row, liveColumns);
          if (cells && washLinkSpecificationKey(readInputOrText(cells[liveColumns.specification])) === target) {
            return { row, cells, holder, columns: liveColumns };
          }
        }
        if (holder.scrollHeight <= holder.clientHeight + 2 || holder.scrollTop + holder.clientHeight >= holder.scrollHeight - 2) break;
        const previous = holder.scrollTop;
        holder.scrollTop = Math.min(holder.scrollHeight, previous + Math.max(120, Math.floor(holder.clientHeight * 0.8)));
        holder.dispatchEvent?.(new Event("scroll", { bubbles: true }));
        await sleep(100);
        if (holder.scrollTop === previous) break;
        }
        await sleep(200);
      }
    } finally {
      let current = null;
      try {
        current = washLinkRowContainer(panel, columns).holder;
      } catch (_) {}
      if (current) {
        current.scrollTop = originScrollTop;
        current.dispatchEvent?.(new Event("scroll", { bubbles: true }));
      } else if (originHolder?.isConnected) {
        originHolder.scrollTop = originScrollTop;
        originHolder.dispatchEvent?.(new Event("scroll", { bubbles: true }));
      }
    }
    throw error("UPDATE_WASH_LINK_ROW_MISSING", `无法定位 SKU 规格“${specification}”对应的行。`, { specification: normalize(specification) });
  }

  async function findWashLinkRowBySkuId(panel, columns, skuId, skuLocator = null, options = {}) {
    const target = normalize(skuId);
    if (!target) throw error("UPDATE_WASH_LINK_SKU_ID_INVALID", "SKU ID 为空，不能稳定定位 SKU。", { skuId });
    let originHolder = null;
    let originScrollTop = 0;
    let scannedSegments = 0;
    try {
      for (let pass = 1; pass <= 2; pass += 1) {
        let table;
        let holder;
        let liveColumns;
        for (let retry = 0; retry < 30; retry += 1) {
          try {
            ({ table, holder } = washLinkRowContainer(panel, columns));
            liveColumns = skuColumns(skuHeaderRow(panel)).indexes;
            break;
          } catch (caught) {
            const transient = /UPDATE_(SKU_TABLE|SKU_HEADERS|PRICE_PANEL|PRICE_TAB)/.test(String(caught?.code || ""));
            if (!transient || retry >= 29) throw caught;
            await sleep(250);
          }
        }
        if (!originHolder) {
          originHolder = holder;
          originScrollTop = Number(holder.scrollTop) || 0;
        }
        holder.scrollTop = 0;
        holder.dispatchEvent?.(new Event("scroll", { bubbles: true }));
        await sleep(80);
        const hintedIndex = pass === 1 ? skuLocator?.positions?.get(target) : null;
        const directTargetScroll = Number.isInteger(hintedIndex) && skuLocator?.total > 0
          ? Math.max(0, Math.min(holder.scrollHeight - holder.clientHeight,
            Math.round((hintedIndex / Math.max(1, skuLocator.total - 1)) * Math.max(0, holder.scrollHeight - holder.clientHeight) - holder.clientHeight * 0.35)))
          : null;
        if (directTargetScroll !== null) {
          holder.scrollTop = directTargetScroll;
          holder.dispatchEvent?.(new Event("scroll", { bubbles: true }));
          await sleep(100);
          const directRows = await waitForWashLinkVisibleRows(holder, table, liveColumns);
          for (const row of directRows) {
            const cells = washLinkCells(row, liveColumns);
            if (cells && normalize(readInputOrText(cells[liveColumns.skuId])) === target) {
              return { row, cells, holder, columns: liveColumns, skuId: target, locator: "direct" };
            }
          }
        }
        const fullScanFallback = directTargetScroll === null || pass === 2;
        if (!fullScanFallback && directTargetScroll !== null) {
          holder.scrollTop = 0;
          holder.dispatchEvent?.(new Event("scroll", { bubbles: true }));
          await sleep(80);
        }
        const maxSegments = Math.max(2, Math.ceil((holder.scrollHeight || 0) / Math.max(1, holder.clientHeight || 1)) * 2 + 3);
        for (let segment = 1; segment <= maxSegments; segment += 1) {
          reportWashLinkScanProgress(skuId, pass, segment);
          scannedSegments += 1;
          const rows = await waitForWashLinkVisibleRows(holder, table, liveColumns);
          for (const row of rows) {
            const cells = washLinkCells(row, liveColumns);
            if (cells && normalize(readInputOrText(cells[liveColumns.skuId])) === target) {
              return { row, cells, holder, columns: liveColumns, skuId: target };
            }
          }
          if (holder.scrollHeight <= holder.clientHeight + 2 || holder.scrollTop + holder.clientHeight >= holder.scrollHeight - 2) break;
          const previous = holder.scrollTop;
          holder.scrollTop = Math.min(holder.scrollHeight, previous + Math.max(120, Math.floor(holder.clientHeight * 0.8)));
          holder.dispatchEvent?.(new Event("scroll", { bubbles: true }));
          await sleep(80);
          if (holder.scrollTop === previous) break;
        }
        await sleep(200);
      }
    } finally {
      let current = null;
      try { current = washLinkRowContainer(panel, columns).holder; } catch (_) {}
      if (current && options.keepVisible !== true) {
        current.scrollTop = originScrollTop;
        current.dispatchEvent?.(new Event("scroll", { bubbles: true }));
      } else if (options.keepVisible !== true && originHolder?.isConnected) {
        originHolder.scrollTop = originScrollTop;
        originHolder.dispatchEvent?.(new Event("scroll", { bubbles: true }));
      }
    }
    throw error("UPDATE_WASH_LINK_SKU_ROW_MISSING", `连续两轮扫描后仍未找到 SKUID“${skuId}”。`, {
      skuId: target, scanPasses: 2, scannedSegments, outcomeUnknown: false
    });
  }

  function highlightWashLinkNode(row) {
    const previous = globalThis.__doudianWashLinkHighlight;
    if (previous?.isConnected) {
      previous.style.removeProperty("outline");
      previous.style.removeProperty("outline-offset");
      previous.style.removeProperty("background-color");
    }
    if (!row?.isConnected) throw error("UPDATE_WASH_LINK_LOCATE_ROW_MISSING", "定位到的 SKU 行已重新渲染，请再次点击定位。", { dispatched: false });
    row.style.outline = "3px solid #d97706";
    row.style.outlineOffset = "2px";
    row.style.backgroundColor = "#fff7ed";
    row.scrollIntoView?.({ block: "center", behavior: "smooth" });
    globalThis.__doudianWashLinkHighlight = row;
    globalThis.setTimeout?.(() => {
      if (globalThis.__doudianWashLinkHighlight !== row) return;
      row.style.removeProperty("outline");
      row.style.removeProperty("outline-offset");
      row.style.removeProperty("background-color");
      globalThis.__doudianWashLinkHighlight = null;
    }, 10000);
  }

  function specificationInputOwner(input, panel) {
    let owner = input?.parentElement || null;
    while (owner && owner !== panel && !owner.matches?.('[class*="specValueContent"],[class*="skuValue"]')) owner = owner.parentElement;
    return owner && owner !== panel ? owner : input;
  }

  function highlightWashLinkRow(row) {
    highlightWashLinkNode(row);
  }

  async function locateWashLinkRow(args) {
    const productId = String(args?.productId || "");
    assertProductId(productId);
    let { panel } = await activatePriceInventory();
    const header = skuHeaderRow(panel);
    const columns = skuColumns(header).indexes;
    const skuId = normalize(args?.skuId);
    const specification = normalize(args?.specification);
    const inputIndex = Number.isInteger(Number(args?.inputIndex)) ? Number(args.inputIndex) : -1;
    const editorInputs = editorSpecificationInputState(panel).inputs;
    const input = inputIndex >= 0 ? editorInputs[inputIndex] : editorInputs.find((candidate) => normalize(candidate.value) === specification);
    if (input && (!specification || normalize(input.value) === specification)) {
      highlightWashLinkNode(specificationInputOwner(input, panel));
      return Object.freeze({ productId, skuId, specification: String(input.value || ""), located: true, target: "specification_input" });
    }
    const binding = skuId
      ? await findWashLinkRowBySkuId(panel, columns, skuId, null, { keepVisible: true })
      : await findWashLinkRow(panel, columns, specification);
    highlightWashLinkRow(binding.row);
    return Object.freeze({
      productId,
      skuId: skuId || normalize(readInputOrText(binding.cells[binding.columns.skuId])),
      specification: readInputOrText(binding.cells[binding.columns.specification]),
      located: true,
      target: "sku_table"
    });
  }

  function washLinkStableFingerprint(state) {
    return JSON.stringify((state?.skuRows || []).map((row) => ({
      skuId: normalize(row.skuId), specification: normalize(row.specification)
    })).sort((left, right) => left.skuId.localeCompare(right.skuId)));
  }

  function createWashLinkSkuLocator(skuRows) {
    const positions = new Map();
    const specificationKeys = new Map();
    const rows = Array.isArray(skuRows) ? skuRows : [];
    rows.forEach((row, index) => {
      const skuId = normalize(row?.skuId);
      if (!skuId) return;
      if (!positions.has(skuId)) positions.set(skuId, index);
      const key = washLinkBase(row?.specification);
      if (key) {
        const ids = specificationKeys.get(key) || [];
        ids.push(skuId);
        specificationKeys.set(key, ids);
      }
    });
    return Object.freeze({ positions, specificationKeys, total: rows.length });
  }

  async function waitForWashLinkStable(readState, label = "SKU 表", isReady = () => true) {
    let previous = null;
    let stableCount = 0;
    let last = null;
    for (let attempt = 0; attempt < 36; attempt += 1) {
      try {
        const state = await readState();
        if (state?.skuScanComplete !== true) {
          stableCount = 0;
          previous = null;
          last = state;
          await sleep(250);
          continue;
        }
        const fingerprint = washLinkStableFingerprint(state);
        if (fingerprint && fingerprint === previous) stableCount += 1;
        else stableCount = 1;
        previous = fingerprint;
        last = state;
        if (stableCount >= 3 && isReady(state)) return state;
      } catch (caught) {
        const transient = /UPDATE_(SKU_TABLE|SKU_HEADERS|PRICE_PANEL|PRICE_TAB|PRODUCT_TABLIST)/.test(String(caught?.code || ""));
        if (!transient) throw caught;
        stableCount = 0;
        previous = null;
      }
      await sleep(250);
    }
    throw error("UPDATE_WASH_LINK_STABILITY_TIMEOUT", `${label}未连续三次回读稳定，已停止修改。`, {
      lastFingerprint: last ? washLinkStableFingerprint(last) : null, outcomeUnknown: false
    });
  }

  async function waitForWashLinkTargetSpecification(readState, {
    previousSkuId,
    targetSpecification,
    beforeIds,
    label = "规格修改"
  }) {
    const normalizedPreviousSkuId = normalize(previousSkuId);
    const normalizedTarget = normalize(targetSpecification);
    const priorSkuIds = beforeIds instanceof Set ? beforeIds : new Set();
    const deadline = Date.now() + 60000;
    let previous = null;
    let stableCount = 0;
    let last = null;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt += 1;
      try {
        const state = await readState();
        last = state;
        if (state?.skuScanComplete !== true) {
          stableCount = 0;
          previous = null;
          reportWashLinkTargetStableProgress(previousSkuId, targetSpecification, stableCount, attempt);
          await sleep(300);
          continue;
        }
        const candidates = (state.skuRows || []).filter((row) => {
          const candidateSkuId = normalize(row.skuId);
          return candidateSkuId && normalize(row.specification) === normalizedTarget &&
            (candidateSkuId === normalizedPreviousSkuId || !priorSkuIds.has(candidateSkuId));
        });
        const fingerprint = JSON.stringify(candidates.map((row) => ({
          skuId: normalize(row.skuId), specification: normalize(row.specification)
        })).sort((left, right) => left.skuId.localeCompare(right.skuId)));
        if (candidates.length && fingerprint === previous) stableCount += 1;
        else stableCount = candidates.length ? 1 : 0;
        previous = candidates.length ? fingerprint : null;
        reportWashLinkTargetStableProgress(previousSkuId, targetSpecification, stableCount, attempt);
        if (stableCount >= 2) return state;
      } catch (caught) {
        const transient = /UPDATE_(SKU_TABLE|SKU_HEADERS|PRICE_PANEL|PRICE_TAB|PRODUCT_TABLIST)/.test(String(caught?.code || ""));
        if (!transient) throw caught;
        stableCount = 0;
        previous = null;
        reportWashLinkTargetStableProgress(previousSkuId, targetSpecification, stableCount, attempt);
      }
      await sleep(300);
    }
    const targetLabel = normalizedPreviousSkuId ? `SKU“${normalizedPreviousSkuId}”` : "新增 SKU";
    throw error("UPDATE_WASH_LINK_TARGET_SPEC_TIMEOUT", `${targetLabel}目标规格“${targetSpecification}”未出现或未连续两次稳定，已停止修改。`, {
      skuId: normalizedPreviousSkuId,
      target: targetSpecification,
      label,
      attempts: attempt,
      lastSkuRows: (last?.skuRows || []).map((row) => ({ skuId: normalize(row.skuId), specification: row.specification })),
      outcomeUnknown: true
    });
  }

  function washLinkStatusControl(cells, columns, specification) {
    if (columns.status < 0) throw error("UPDATE_WASH_LINK_STATUS_COLUMN_MISSING", "SKU 表没有可识别的 SKU 状态列，不能安全执行下架。", { specification });
    const cell = cells[columns.status];
    const controls = [...cell.querySelectorAll('[role="switch"],input[type="checkbox"],button,[role="button"]')].filter(visible);
    const control = controls.find((node) => node.getAttribute("role") === "switch" || node.matches('input[type="checkbox"]')) || controls[0];
    if (!control) throw error("UPDATE_WASH_LINK_STATUS_CONTROL_MISSING", `SKU“${specification}”没有可点击的上下架控件。`, { specification });
    return control;
  }

  function washLinkIsOnSale(control, cell) {
    const ariaChecked = control.getAttribute("aria-checked");
    if (ariaChecked === "true" || ariaChecked === "false") return ariaChecked === "true";
    if (control instanceof HTMLInputElement) return control.checked;
    return /已上架|上架/.test(normalize(text(cell))) && !/已下架|下架/.test(normalize(text(cell)));
  }

  function washLinkStockClassification(value) {
    const raw = String(value ?? "").replace(/,/g, "").trim();
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return "unknown_stock";
    if (numeric === 999 || numeric === 9999) return "baseline_999_or_9999";
    if (numeric < 999 || numeric < 9999) return "below_baseline";
    return "above_baseline";
  }

  function washLinkDisplayedStock(cell, specification) {
    const value = text(cell).replace(/,/g, "").match(/\d+/)?.[0] || "";
    if (!value) throw error("UPDATE_WASH_LINK_STOCK_READ_FAILED", `SKU“${specification}”未读取到现货库存。`, { specification });
    return value;
  }

  function washLinkNewDisplayedStock(cell, skuId) {
    const inputValue = String(cell?.querySelector("input,textarea")?.value || "").replace(/,/g, "").trim();
    if (/^\d+$/.test(inputValue)) return inputValue;
    return washLinkDisplayedStock(cell, skuId);
  }

  async function setWashLinkStock(panel, columns, currentSpecification, targetStock) {
    let binding = await findWashLinkRow(panel, columns, currentSpecification);
    columns = binding.columns || columns;
    const currentStock = washLinkDisplayedStock(binding.cells[columns.stock], currentSpecification);
    const adjustment = api.planStockAdjustment(currentStock, targetStock);
    if (adjustment.action === "none") return { current: currentStock, target: String(adjustment.target), action: "none", amount: 0 };
    const cell = binding.cells[columns.stock];
    const actionLabel = adjustment.action === "increase" ? "增" : "减";
    const actionButton = [...cell.querySelectorAll("button,[role=button]")].filter(visible).find((node) => text(node) === actionLabel);
    const amountInput = [...cell.querySelectorAll("input,textarea")].find((node) => /请输入库存|库存/.test(String(node.getAttribute("placeholder") || "")));
    if (!actionButton || !amountInput) throw error("UPDATE_WASH_LINK_STOCK_CONTROL_MISSING", `SKU“${currentSpecification}”缺少库存${actionLabel}控件。`, { specification: currentSpecification, action: adjustment.action });
    dispatchPointerClick(actionButton, { object: `SKU“${currentSpecification}”库存${actionLabel}` });
    await sleep(80);
    setInputValue(amountInput, String(adjustment.amount));
    amountInput.dispatchEvent(new Event("input", { bubbles: true }));
    amountInput.dispatchEvent(new Event("change", { bubbles: true }));
    amountInput.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(600);
    binding = await findWashLinkRow(panel, columns, currentSpecification);
    columns = binding.columns || columns;
    const actual = washLinkDisplayedStock(binding.cells[columns.stock], currentSpecification);
    if (Number(actual) !== adjustment.target) throw error("UPDATE_WASH_LINK_STOCK_READBACK_FAILED", `SKU“${currentSpecification}”库存调整后回读为 ${actual}，目标为 ${adjustment.target}。`, { specification: currentSpecification, target: adjustment.target, actual, outcomeUnknown: true });
    return { current: currentStock, target: String(adjustment.target), action: adjustment.action, amount: adjustment.amount };
  }

  async function setWashLinkStockBySkuId(panel, columns, skuId, targetStock, skuLocator = null) {
    let binding = await findWashLinkRowBySkuId(panel, columns, skuId, skuLocator);
    columns = binding.columns || columns;
    const currentStock = washLinkDisplayedStock(binding.cells[columns.stock], skuId);
    const adjustment = api.planStockAdjustment(currentStock, targetStock);
    if (adjustment.action === "none") return { current: currentStock, target: String(adjustment.target), action: "none", amount: 0 };
    let cell = binding.cells[columns.stock];
    const actionLabel = adjustment.action === "increase" ? "增" : "减";
    const actionButton = [...cell.querySelectorAll("button,[role=button]")].filter(visible).find((node) => text(node) === actionLabel);
    let amountInput = [...cell.querySelectorAll("input,textarea")].find((node) => /请输入库存|库存/.test(String(node.getAttribute("placeholder") || "")));
    if (!actionButton || !amountInput) throw error("UPDATE_WASH_LINK_STOCK_CONTROL_MISSING", `SKU“${skuId}”缺少库存${actionLabel}控件。`, { skuId, action: adjustment.action });
    dispatchPointerClick(actionButton, { object: `SKU“${skuId}”库存${actionLabel}` });
    await sleep(80);
    // The stock action can replace its editor. Rebind before committing the delta.
    binding = await findWashLinkRowBySkuId(panel, columns, skuId, skuLocator);
    columns = binding.columns || columns;
    cell = binding.cells[columns.stock];
    amountInput = [...cell.querySelectorAll("input,textarea")].find((node) => /请输入库存|库存/.test(String(node.getAttribute("placeholder") || "")));
    if (!amountInput) throw error("UPDATE_WASH_LINK_STOCK_CONTROL_MISSING", `SKU“${skuId}”库存${actionLabel}输入框未重新加载。`, { skuId, action: adjustment.action });
    setInputValue(amountInput, String(adjustment.amount));
    amountInput.dispatchEvent(new Event("input", { bubbles: true }));
    amountInput.dispatchEvent(new Event("change", { bubbles: true }));
    amountInput.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(600);
    binding = await findWashLinkRowBySkuId(panel, columns, skuId, skuLocator);
    columns = binding.columns || columns;
    const actual = washLinkDisplayedStock(binding.cells[columns.stock], skuId);
    if (Number(actual) !== adjustment.target) throw error("UPDATE_WASH_LINK_STOCK_READBACK_FAILED", `SKU“${skuId}”库存调整后回读为 ${actual}，目标为 ${adjustment.target}。`, { skuId, target: adjustment.target, actual, outcomeUnknown: true });
    return { current: currentStock, target: String(adjustment.target), action: adjustment.action, amount: adjustment.amount };
  }

  async function setWashLinkNewStock(panel, columns, specification, targetStock) {
    let binding = await findWashLinkRow(panel, columns, specification);
    columns = binding.columns || columns;
    const cell = binding.cells[columns.stock];
    const input = cell?.querySelector("input,textarea");
    if (!input) throw error("UPDATE_WASH_LINK_NEW_STOCK_INPUT_MISSING", `新增 SKU“${specification}”没有库存输入框。`, { specification });
    setInputValue(input, String(targetStock));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(600);
    binding = await findWashLinkRow(panel, columns, specification);
    columns = binding.columns || columns;
    const actual = washLinkDisplayedStock(binding.cells[columns.stock], specification);
    if (Number(actual) !== Number(targetStock)) throw error("UPDATE_WASH_LINK_STOCK_READBACK_FAILED", `新增 SKU“${specification}”库存回读为 ${actual}，目标为 ${targetStock}。`, { specification, target: targetStock, actual, outcomeUnknown: true });
    return { current: "", target: String(targetStock), action: "direct", amount: Number(targetStock) };
  }

  async function setWashLinkNewStockBySkuId(panel, columns, skuId, targetStock, skuLocator = null) {
    let binding = await findWashLinkRowBySkuId(panel, columns, skuId, skuLocator);
    columns = binding.columns || columns;
    const cell = binding.cells[columns.stock];
    const input = cell?.querySelector("input,textarea");
    if (!input) throw error("UPDATE_WASH_LINK_NEW_STOCK_INPUT_MISSING", `新增 SKU“${skuId}”没有库存输入框。`, { skuId });
    setInputValue(input, String(targetStock));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(600);
    binding = await findWashLinkRowBySkuId(panel, columns, skuId, skuLocator);
    columns = binding.columns || columns;
    const actual = washLinkNewDisplayedStock(binding.cells[columns.stock], skuId);
    if (Number(actual) !== Number(targetStock)) {
      throw error("UPDATE_WASH_LINK_STOCK_READBACK_FAILED", `新增 SKU“${skuId}”库存回读为 ${actual}，目标为 ${targetStock}。`, { skuId, target: targetStock, actual, outcomeUnknown: true });
    }
    return { current: "", target: String(targetStock), action: "direct", amount: Number(targetStock) };
  }

  function resolveRenamedWashLinkSkuId(before, settled, previousSkuId, targetSpecification, claimedSkuIds) {
    const targetRows = (settled?.skuRows || []).filter((row) =>
      normalize(row.skuId) && normalize(row.specification) === normalize(targetSpecification)
    );
    if (!targetRows.length) {
      throw error("UPDATE_WASH_LINK_SPEC_READBACK_FAILED", `SKU“${previousSkuId}”修改后未找到目标规格。`, {
        skuId: previousSkuId, target: targetSpecification, actual: "", structureDigest: settled?.structureDigest || null, outcomeUnknown: true
      });
    }
    const retained = targetRows.find((row) => normalize(row.skuId) === normalize(previousSkuId));
    if (retained) return normalize(retained.skuId);
    const beforeIds = new Set((before?.skuRows || []).map((row) => normalize(row.skuId)).filter(Boolean));
    const rebuilt = targetRows.filter((row) => !beforeIds.has(normalize(row.skuId)) && !claimedSkuIds.has(normalize(row.skuId)));
    if (rebuilt.length === 1) return normalize(rebuilt[0].skuId);
    throw error("UPDATE_WASH_LINK_SKU_ID_REBIND_AMBIGUOUS", `目标规格“${targetSpecification}”存在，但无法唯一确认重建后的 SKUID。`, {
      previousSkuId, target: targetSpecification, targetSkuIds: targetRows.map((row) => normalize(row.skuId)), rebuiltSkuIds: rebuilt.map((row) => normalize(row.skuId)), outcomeUnknown: true
    });
  }

  async function renameWashLinkSkuById(panel, columns, skuId, currentSpecification, targetSpecification, readState, claimedSkuIds = new Set(), skuLocator = null, inputIndex = null) {
    if (normalize(currentSpecification) === normalize(targetSpecification)) {
      const unchanged = await findWashLinkRowBySkuId(panel, columns, skuId);
      return { skuId, specification: readInputOrText(unchanged.cells[unchanged.columns.specification]), changed: false };
    }
    const before = await waitForWashLinkStable(readState, `SKU“${skuId}”规格修改前`, (state) =>
      (state?.skuRows || []).some((row) => normalize(row.skuId) === normalize(skuId) && normalize(row.specification) === normalize(currentSpecification))
    );
    const beforeIds = new Set((before.skuRows || []).map((row) => normalize(row.skuId)).filter(Boolean));
    const inputs = editorSpecificationInputState(panel).inputs;
    const input = Number.isInteger(inputIndex) ? inputs[inputIndex] : inputs.find((candidate) => normalize(candidate.value) === normalize(currentSpecification));
    if (!input) throw error("UPDATE_WASH_LINK_SPEC_INPUT_MISSING", `SKU“${skuId}”缺少规格输入框。`, { skuId, specification: currentSpecification });
    setInputValue(input, targetSpecification);
    await commitWashLinkSpecificationInput(input);
    const settled = await waitForWashLinkTargetSpecification(readState, {
      previousSkuId: skuId,
      targetSpecification,
      beforeIds,
      label: `SKU“${skuId}”规格重建`
    });
    const reboundSkuId = resolveRenamedWashLinkSkuId(before, settled, skuId, targetSpecification, claimedSkuIds);
    const rebound = await findWashLinkRowBySkuId(panel, columns, reboundSkuId, skuLocator);
    columns = rebound.columns || columns;
    const actual = readInputOrText(rebound.cells[columns.specification]);
    if (normalize(actual) !== normalize(targetSpecification)) {
      throw error("UPDATE_WASH_LINK_SPEC_READBACK_FAILED", `SKU“${reboundSkuId}”规格回读不一致。`, {
        previousSkuId: skuId, skuId: reboundSkuId, target: targetSpecification, actual, structureDigest: settled.structureDigest, outcomeUnknown: true
      });
    }
    return { previousSkuId: skuId, skuId: reboundSkuId, specification: actual, changed: true, skuIdRebound: reboundSkuId !== normalize(skuId) };
  }

  function reconcileWashLinkRenamedRows(state, matchedRows) {
    const rows = Array.isArray(state?.skuRows) ? state.skuRows : [];
    const bySpecification = new Map();
    for (const row of rows) {
      const specification = normalize(row.specification);
      const skuId = normalize(row.skuId);
      if (!specification || !skuId) continue;
      if (!bySpecification.has(specification)) bySpecification.set(specification, []);
      bySpecification.get(specification).push(row);
    }
    const claimed = new Set();
    return matchedRows.map(({ current, target }) => {
      const targetKey = normalize(target.specification);
      const candidates = bySpecification.get(targetKey) || [];
      const expectedId = normalize(current.skuId);
      const row = candidates.find((candidate) => normalize(candidate.skuId) === expectedId && !claimed.has(normalize(candidate.skuId))) ||
        candidates.find((candidate) => !claimed.has(normalize(candidate.skuId)));
      if (!row) {
        throw error("UPDATE_WASH_LINK_PHASE_READBACK_FAILED", `SKU“${current.skuId}”目标规格“${target.specification}”回读未找到。`, {
          skuId: current.skuId,
          target: target.specification,
          actual: "",
          availableSpecifications: rows.map((candidate) => candidate.specification),
          outcomeUnknown: false
        });
      }
      const reboundSkuId = normalize(row.skuId);
      claimed.add(reboundSkuId);
      return {
        current: { ...current, skuId: reboundSkuId },
        target,
        skuIdRebound: reboundSkuId !== expectedId
      };
    });
  }

  async function setWashLinkExistingFieldsBySkuId(panel, columns, skuId, target, skuLocator = null) {
    let binding = await findWashLinkRowBySkuId(panel, columns, skuId, skuLocator);
    columns = binding.columns || columns;
    const setCell = async (key, value, field) => {
      binding = await findWashLinkRowBySkuId(panel, columns, skuId, skuLocator);
      columns = binding.columns || columns;
      const input = binding.cells[columns[key]]?.querySelector("input,textarea");
      if (!input) throw error("UPDATE_WASH_LINK_INPUT_MISSING", `SKU“${skuId}”缺少${field}输入框。`, { skuId, field });
      setInputValue(input, String(value));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      await sleep(180);
    };
    const originalPrice = readInputOrText(binding.cells[columns.price]);
    if (Number(originalPrice) !== Number(target.price)) await setCell("price", target.price, "价格");
    binding = await findWashLinkRowBySkuId(panel, columns, skuId, skuLocator);
    columns = binding.columns || columns;
    if (columns.merchantCode >= 0 && readInputOrText(binding.cells[columns.merchantCode]) !== String(target.merchantCode)) {
      await setCell("merchantCode", target.merchantCode, "商家编码");
    }
    binding = await findWashLinkRowBySkuId(panel, columns, skuId, skuLocator);
    columns = binding.columns || columns;
    const readback = {
      skuId,
      specification: readInputOrText(binding.cells[columns.specification]),
      price: readInputOrText(binding.cells[columns.price]),
      merchantCode: readInputOrText(binding.cells[columns.merchantCode]),
      stock: "preserved"
    };
    if (washLinkExistingKey(readback.specification) !== washLinkExistingKey(target.specification) || Number(readback.price) !== Number(target.price) || String(readback.merchantCode) !== String(target.merchantCode)) {
      throw error("UPDATE_WASH_LINK_ROW_READBACK_FAILED", `SKU“${skuId}”规格、价格或商家编码回读不一致。`, { skuId, target, readback, outcomeUnknown: true });
    }
    return readback;
  }

  async function takeWashLinkOffSale(panel, columns, specification, availableStock = "") {
    const binding = await findWashLinkRow(panel, columns, specification);
    columns = binding.columns || columns;
    const control = washLinkStatusControl(binding.cells, columns, specification);
    if (!washLinkIsOnSale(control, binding.cells[columns.status])) return { specification, availableStock, stockClassification: washLinkStockClassification(availableStock), changed: false };
    dispatchPointerClick(control, { object: `SKU“${specification}”下架` });
    await sleep(120);
    const rebound = await findWashLinkRow(panel, columns, specification);
    columns = rebound.columns || columns;
    if (washLinkIsOnSale(washLinkStatusControl(rebound.cells, columns, specification), rebound.cells[columns.status])) {
      throw error("UPDATE_WASH_LINK_STATUS_READBACK_FAILED", `SKU“${specification}”下架后状态回读仍为上架。`, { specification, dispatched: true, outcomeUnknown: true });
    }
    return { specification, availableStock, stockClassification: washLinkStockClassification(availableStock), changed: true };
  }

  async function takeWashLinkOffSaleBySkuId(panel, columns, skuId, availableStock = "", skuLocator = null) {
    let binding = await findWashLinkRowBySkuId(panel, columns, skuId, skuLocator);
    columns = binding.columns || columns;
    const control = washLinkStatusControl(binding.cells, columns, skuId);
    if (!washLinkIsOnSale(control, binding.cells[columns.status])) {
      return { skuId, availableStock, stockClassification: washLinkStockClassification(availableStock), changed: false };
    }
    dispatchPointerClick(control, { object: `SKU“${skuId}”下架` });
    await sleep(120);
    binding = await findWashLinkRowBySkuId(panel, columns, skuId, skuLocator);
    columns = binding.columns || columns;
    if (washLinkIsOnSale(washLinkStatusControl(binding.cells, columns, skuId), binding.cells[columns.status])) {
      throw error("UPDATE_WASH_LINK_STATUS_READBACK_FAILED", `SKU“${skuId}”下架后状态回读仍为上架。`, { skuId, dispatched: true, outcomeUnknown: true });
    }
    return { skuId, availableStock, stockClassification: washLinkStockClassification(availableStock), changed: true };
  }

  async function setWashLinkRowFields(panel, columns, currentSpecification, target, { adjustStock = true } = {}) {
    let binding = await findWashLinkRow(panel, columns, currentSpecification);
    columns = binding.columns || columns;
    const setCell = async (key, value, field) => {
      binding = await findWashLinkRow(panel, columns, target.specification);
      columns = binding.columns || columns;
      const input = binding.cells[columns[key]]?.querySelector("input,textarea");
      if (!input) throw error("UPDATE_WASH_LINK_INPUT_MISSING", `SKU“${currentSpecification}”缺少${field}输入框。`, { field, specification: currentSpecification });
      setInputValue(input, String(value));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      await sleep(120);
    };
    if (normalize(currentSpecification) !== normalize(target.specification)) {
      const input = editorSpecificationInputState(panel).inputs.find((candidate) => normalize(candidate.value) === normalize(currentSpecification));
      if (!input) throw error("UPDATE_WASH_LINK_SPEC_INPUT_MISSING", `SKU“${currentSpecification}”缺少规格输入框。`, { specification: currentSpecification });
      await commitWashLinkSpecificationInput(input, target.specification);
      await sleep(1500);
      binding = await findWashLinkRow(panel, columns, target.specification);
      columns = binding.columns || columns;
    }
    await setCell("price", target.price, "价格");
    const stockChange = adjustStock
      ? await setWashLinkStock(panel, columns, target.specification, target.stock)
      : { current: "unchanged", target: null, action: "preserved", amount: 0 };
    await setCell("merchantCode", target.merchantCode, "商家编码");
    await sleep(150);
    binding = await findWashLinkRow(panel, columns, target.specification);
    columns = binding.columns || columns;
    const readback = {
      specification: readInputOrText(binding.cells[columns.specification]),
      price: readInputOrText(binding.cells[columns.price]),
      stock: washLinkDisplayedStock(binding.cells[columns.stock], target.specification),
      merchantCode: readInputOrText(binding.cells[columns.merchantCode])
    };
    if (normalize(readback.specification) !== normalize(target.specification) || Number(readback.price) !== Number(target.price) || (adjustStock && Number(readback.stock) !== Number(target.stock)) || String(readback.merchantCode) !== String(target.merchantCode)) {
      throw error("UPDATE_WASH_LINK_ROW_READBACK_FAILED", `SKU“${target.specification}”原地修改后回读不一致。`, { target, readback, outcomeUnknown: true });
    }
    return { ...readback, stockChange };
  }

  async function waitForWashLinkEmptySpecificationInput(panel, specificationType, beforeInputCount, specification, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableCount = 0;
    let last = null;
    while (Date.now() < deadline) {
      const livePanel = liveWashLinkSpecificationPanel();
      if (!livePanel) {
        last = { inputCount: 0, emptyCount: 0, panelMissing: true };
        await sleep(250);
        continue;
      }
      const inputs = editorSpecificationInputState(livePanel, specificationType).inputs;
      const emptyCount = inputs.filter((input) => !normalize(input.value)).length;
      const ready = inputs.length > beforeInputCount && emptyCount > 0;
      const signature = JSON.stringify({ count: inputs.length, emptyCount });
      last = { inputCount: inputs.length, emptyCount };
      stableCount = ready && signature === previous ? stableCount + 1 : ready ? 1 : 0;
      previous = signature;
      if (stableCount >= 2) return Object.freeze(last);
      await sleep(250);
    }
    throw error("UPDATE_WASH_LINK_APPEND_INPUT_TIMEOUT", `新增规格“${specification}”后，页面没有稳定生成下一个空白规格框。`, {
      specification, beforeInputCount, timeoutMs, ...last, dispatched: false
    });
  }

  function liveWashLinkSpecificationPanel() {
    try {
      return priceInventoryPanel();
    } catch (caught) {
      if (["UPDATE_PRICE_PANEL_MISSING", "UPDATE_PRICE_PANEL_AMBIGUOUS"].includes(caught?.code)) return null;
      throw caught;
    }
  }

  function washLinkAppendActionCandidates(panel) {
    const nodes = [...panel.querySelectorAll('button,[role="button"],[title],[aria-label]')].filter(visible);
    const actions = new Set(nodes.map((node) =>
      node.matches?.('button,[role="button"]') ? node : node.closest?.('button,[role="button"]') || node
    ).filter(visible));
    return [...actions].filter((node) => {
      const nestedLabels = [...node.querySelectorAll?.('[title],[aria-label]') || []].map(shallowSignal);
      const signal = normalize([shallowSignal(node), ...nestedLabels].join(" "));
      return /添加规格值|添加规格/.test(signal) && !/添加规格类型/.test(signal);
    });
  }

  async function waitForWashLinkAppendReady(panel, specificationType, beforeInputCount, specification, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let previousEmptySignature = "";
    let stableEmptyCount = 0;
    while (Date.now() < deadline) {
      const livePanel = liveWashLinkSpecificationPanel();
      if (!livePanel) {
        last = { inputCount: 0, emptyCount: 0, appendActionCount: 0, appendActionSignals: [], panelMissing: true };
        await sleep(200);
        continue;
      }
      const inputs = editorSpecificationInputState(livePanel, specificationType).inputs;
      const emptyInputs = inputs.filter((input) => !normalize(input.value));
      const empty = emptyInputs.at(-1) || null;
      const appendActions = washLinkAppendActionCandidates(livePanel);
      const emptySignature = JSON.stringify({ inputCount: inputs.length, emptyCount: emptyInputs.length });
      const hasNewEmpty = Boolean(empty) && (inputs.length > beforeInputCount || emptyInputs.length > 0);
      stableEmptyCount = hasNewEmpty && emptySignature === previousEmptySignature ? stableEmptyCount + 1 : hasNewEmpty ? 1 : 0;
      previousEmptySignature = emptySignature;
      last = {
        inputCount: inputs.length,
        emptyCount: emptyInputs.length,
        observedSpecifications: inputs.map((input) => normalize(input.value)).filter(Boolean),
        appendActionCount: appendActions.length,
        appendActionSignals: appendActions.slice(0, 3).map(shallowSignal),
        visibleControlSignals: [...livePanel.querySelectorAll('button,[role="button"],[title],[aria-label]')]
          .filter(visible)
          .slice(0, 12)
          .map((node) => shallowSignal(node).slice(0, 120))
      };
      if (stableEmptyCount >= 2) return Object.freeze({ kind: "input", input: empty, ...last });
      if (appendActions.length === 1) return Object.freeze({ kind: "action", action: appendActions[0], ...last });
      if (appendActions.length > 1) {
        throw error("UPDATE_WASH_LINK_APPEND_ACTION_AMBIGUOUS", "页面存在多个添加规格值入口，已停止以免添加到错误规格组。", {
          specification, ...last, dispatched: false
        });
      }
      await sleep(200);
    }
    throw error("UPDATE_WASH_LINK_APPEND_INPUT_MISSING", "页面未生成下一个空白规格框，也未找到可识别的添加规格值入口。", {
      specification, automaticWaitMs: timeoutMs, ...last, dispatched: false
    });
  }

  async function activateWashLinkAppendInput(specificationType, expectedSpecifications, specification, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableCount = 0;
    let last = null;
    while (Date.now() < deadline) {
      const livePanel = liveWashLinkSpecificationPanel();
      if (!livePanel) {
        last = { panelMissing: true, observedSpecifications: [], emptyCount: 0 };
        stableCount = 0;
        previous = "";
        await sleep(100);
        continue;
      }
      const inputs = editorSpecificationInputState(livePanel, specificationType).inputs;
      const observedSpecifications = inputs.map((input) => normalize(input.value)).filter(Boolean);
      if (JSON.stringify(observedSpecifications) !== JSON.stringify(expectedSpecifications)) {
        throw error("UPDATE_WASH_LINK_APPEND_ACTIVATION_DRIFT", "激活新增规格框后，页面已有规格与激活前不一致；已停止，未写入新规格。", {
          specification,
          expectedSpecifications,
          observedSpecifications,
          inputCount: inputs.length,
          dispatched: false
        });
      }
      const emptyInputs = inputs.filter((input) => !normalize(input.value));
      const empty = emptyInputs.at(-1) || null;
      const signature = JSON.stringify({
        observedSpecifications,
        inputCount: inputs.length,
        emptyCount: emptyInputs.length,
        targetConnected: Boolean(empty?.isConnected)
      });
      last = { observedSpecifications, inputCount: inputs.length, emptyCount: emptyInputs.length };
      stableCount = empty?.isConnected && signature === previous ? stableCount + 1 : empty?.isConnected ? 1 : 0;
      previous = signature;
      if (stableCount >= 2) return Object.freeze({ input: empty, ...last });
      await sleep(100);
    }
    throw error("UPDATE_WASH_LINK_APPEND_ACTIVATION_TIMEOUT", `新增规格“${specification}”的输入框激活后未能稳定重新绑定。`, {
      specification,
      expectedSpecifications,
      timeoutMs,
      ...last,
      dispatched: false
    });
  }

  async function waitForWashLinkSpecificationCommit(specificationType, expectedSpecifications, specification, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableCount = 0;
    let last = null;
    while (Date.now() < deadline) {
      const panel = liveWashLinkSpecificationPanel();
      if (!panel) {
        last = { observedSpecifications: [], panelMissing: true };
        stableCount = 0;
        previous = "";
        await sleep(200);
        continue;
      }
      const inputs = editorSpecificationInputState(panel, specificationType).inputs;
      const observedSpecifications = inputs.map((input) => normalize(input.value)).filter(Boolean);
      const check = api.washLinkFinalSpecificationState(expectedSpecifications, observedSpecifications);
      const signature = JSON.stringify({ observedSpecifications: [...observedSpecifications].sort(), inputCount: inputs.length });
      last = { observedSpecifications, expectedSpecifications, inputCount: inputs.length, ...check };
      if (check.committed && signature === previous) stableCount += 1;
      else stableCount = check.committed ? 1 : 0;
      previous = signature;
      if (stableCount >= 2) return Object.freeze(last);
      await sleep(200);
    }
    const observed = new Map((last?.observedSpecifications || []).map((value) => [value, (last?.observedSpecifications || []).filter((item) => item === value).length]));
    const expected = new Map((expectedSpecifications || []).map((value) => [value, (expectedSpecifications || []).filter((item) => item === value).length]));
    const missingSpecifications = [...expected].flatMap(([value, count]) =>
      Array.from({ length: Math.max(0, count - (observed.get(value) || 0)) }, () => value)
    );
    throw error("UPDATE_WASH_LINK_SPECIFICATION_READBACK_FAILED", `规格“${specification}”提交后未能在重绘后的页面稳定保留；已停止后续新增。`, {
      specification,
      missingSpecifications,
      ...last,
      outcomeUnknown: true
    });
  }

  async function appendWashLinkSpecification(panel, specificationType, target, onDispatch = () => {}) {
    const initialPanel = liveWashLinkSpecificationPanel();
    if (!initialPanel) throw error("UPDATE_WASH_LINK_APPEND_PANEL_MISSING", "规格编辑区正在重载，尚未开始新增。", { specification: target.specification, dispatched: false });
    let inputs = editorSpecificationInputState(initialPanel, specificationType).inputs;
    const expectedSpecifications = inputs.map((input) => normalize(input.value)).filter(Boolean);
    let empty = inputs.filter((input) => !normalize(input.value)).at(-1);
    if (!empty) {
      const beforeInputCount = inputs.length;
      const ready = await waitForWashLinkAppendReady(panel, specificationType, beforeInputCount, target.specification);
      if (ready.kind === "action") {
        dispatchPointerClick(ready.action, { object: "追加 SKU 规格值" });
        await waitForWashLinkEmptySpecificationInput(panel, specificationType, beforeInputCount, target.specification);
        const livePanel = liveWashLinkSpecificationPanel();
        inputs = livePanel ? editorSpecificationInputState(livePanel, specificationType).inputs : [];
        empty = inputs.filter((input) => !normalize(input.value)).at(-1);
      } else {
        const livePanel = liveWashLinkSpecificationPanel();
        inputs = livePanel ? editorSpecificationInputState(livePanel, specificationType).inputs : [];
        empty = inputs.filter((input) => !normalize(input.value)).at(-1);
      }
    }
    if (!empty) throw error("UPDATE_WASH_LINK_APPEND_INPUT_TIMEOUT", `新增规格“${target.specification}”后没有出现空输入框。`, { specification: target.specification, dispatched: false });
    dispatchPointerClick(empty, { object: "新增 SKU 规格输入框" });
    const activated = await activateWashLinkAppendInput(specificationType, expectedSpecifications, target.specification);
    empty = activated.input;
    const previousInputCount = inputs.length;
    const previousEmptyCount = inputs.filter((input) => !normalize(input.value)).length;
    const expectedAfterCommit = [...expectedSpecifications, target.specification];
    await commitWashLinkSpecificationInput(empty, target.specification, onDispatch);
    await waitForWashLinkSpecificationCommit(specificationType, expectedAfterCommit, target.specification);
    return { specification: target.specification, committed: true, previousInputCount, previousEmptyCount };
  }

  async function waitForWashLinkFinalSpecificationEditor(panel, specificationType, expectedSpecifications) {
    const deadline = Date.now() + 60000;
    let previous = "";
    let stableCount = 0;
    let last = null;
    while (Date.now() < deadline) {
      const inputs = editorSpecificationInputState(panel, specificationType).inputs;
      const values = inputs.map((input) => normalize(input.value)).filter(Boolean);
      const emptyCount = inputs.filter((input) => !normalize(input.value)).length;
      const check = api.washLinkFinalSpecificationState(expectedSpecifications, values);
      const signature = JSON.stringify({ values: [...values].sort(), inputCount: inputs.length, emptyCount, check });
      last = { values, expectedSpecifications, inputCount: inputs.length, emptyCount, ...check };
      if (check.committed && signature === previous) stableCount += 1;
      else stableCount = check.committed ? 1 : 0;
      previous = signature;
      if (stableCount >= 2) return Object.freeze(last);
      await sleep(250);
    }
    throw error("UPDATE_WASH_LINK_SPEC_EDITOR_COMMIT_TIMEOUT", "全部新增规格未能在商品规格区完成最终核验，已暂停价格和库存填写。", {
      ...last,
      outcomeUnknown: true
    });
  }

  async function waitForWashLinkSpecificationEditorState(panel, specificationType) {
    const deadline = Date.now() + 60000;
    let previous = "";
    let stableCount = 0;
    let last = null;
    while (Date.now() < deadline) {
      const inputs = editorSpecificationInputState(panel, specificationType).inputs;
      const values = inputs.map((input) => normalize(input.value)).filter(Boolean);
      const emptyCount = inputs.filter((input) => !normalize(input.value)).length;
      const signature = JSON.stringify({ values, inputCount: inputs.length, emptyCount });
      last = { values, inputCount: inputs.length, emptyCount };
      stableCount = signature === previous ? stableCount + 1 : 1;
      previous = signature;
      if (stableCount >= 3) return Object.freeze(values);
      await sleep(250);
    }
    throw error("UPDATE_WASH_LINK_SPEC_EDITOR_STABILITY_TIMEOUT", "商品规格编辑框尚未稳定，新增阶段已暂停，未重放规格输入。", {
      ...last,
      outcomeUnknown: true
    });
  }

  function customSortButton() {
    const candidates = [...document.querySelectorAll("button,[role=button],a,[tabindex]")]
      .filter(visible)
      .filter((node) => normalize(text(node)) === "自定义排序" || normalize(node.getAttribute("aria-label")) === "自定义排序");
    return candidates.length === 1 ? candidates[0] : null;
  }

  function washLinkCheckpointKey(productId, digest) {
    return `doudian-wash-link:${String(productId)}:${String(digest || "plan")}`;
  }

  function loadWashLinkCheckpoint(productId, argsDigest, targetDigest, legacyArgsDigest) {
    try {
      const canonicalKey = washLinkCheckpointKey(productId, targetDigest || argsDigest);
      const legacyKey = washLinkCheckpointKey(productId, argsDigest);
      const raw = globalThis.sessionStorage?.getItem(canonicalKey) ||
        globalThis.sessionStorage?.getItem(legacyKey) ||
        globalThis.sessionStorage?.getItem(washLinkCheckpointKey(productId, legacyArgsDigest));
      if (!raw) return { renamed: [], renamedSkuIds: {}, labelSynced: {}, existingFields: [], added: {}, retired: [], blocked: false, blockedPhase: "", addPhaseComplete: false, modifyPhaseComplete: false };
      const parsed = JSON.parse(raw);
      return {
        renamed: Array.isArray(parsed.renamed) ? parsed.renamed.map(String) : [],
        renamedSkuIds: parsed.renamedSkuIds && typeof parsed.renamedSkuIds === "object" ? parsed.renamedSkuIds : {},
        labelSynced: parsed.labelSynced && typeof parsed.labelSynced === "object" ? parsed.labelSynced : {},
        existingFields: Array.isArray(parsed.existingFields) ? parsed.existingFields.map(String) : [],
        added: parsed.added && typeof parsed.added === "object" ? parsed.added : {},
        plan: parsed.plan && typeof parsed.plan === "object" ? parsed.plan : null,
        retired: Array.isArray(parsed.retired) ? parsed.retired.map(String) : [],
        blocked: parsed.blocked === true,
        blockedCode: String(parsed.blockedCode || ""),
        blockedPhase: String(parsed.blockedPhase || ""),
        addPhaseComplete: parsed.addPhaseComplete === true,
        modifyPhaseComplete: parsed.modifyPhaseComplete === true
      };
    } catch (_) {
      return { renamed: [], renamedSkuIds: {}, labelSynced: {}, existingFields: [], added: {}, retired: [], blocked: false, blockedPhase: "", addPhaseComplete: false, modifyPhaseComplete: false };
    }
  }

  function saveWashLinkCheckpoint(productId, targetDigest, checkpoint) {
    try {
      globalThis.sessionStorage?.setItem(washLinkCheckpointKey(productId, targetDigest), JSON.stringify(checkpoint));
    } catch (_) {}
  }

  function validateWashLinkReviewStructure(snapshot, productId) {
    const valid = snapshot && typeof snapshot === "object" &&
      String(snapshot.productId || "") === String(productId) &&
      String(snapshot.documentToken || "") === documentToken &&
      snapshot.scanComplete === true && snapshot.skuScanComplete === true &&
      Array.isArray(snapshot.skuRows) &&
      api.stableDigest(structureGuardShape(snapshot)) === String(snapshot.structureDigest || "");
    if (!valid) {
      throw error("UPDATE_WASH_LINK_REVIEW_SNAPSHOT_INVALID", "清单扫描结果已失效或不完整；请重新核实当前商品后再执行，未写入商品。", {
        expectedProductId: String(productId),
        actualProductId: String(snapshot?.productId || ""),
        sameDocument: String(snapshot?.documentToken || "") === documentToken,
        scanComplete: snapshot?.scanComplete === true,
        skuScanComplete: snapshot?.skuScanComplete === true,
        dispatched: false
      });
    }
    return snapshot;
  }

  function clearWashLinkCheckpoint(productId, targetDigest, argsDigest, legacyArgsDigest) {
    try {
      globalThis.sessionStorage?.removeItem(washLinkCheckpointKey(productId, targetDigest));
      if (argsDigest !== targetDigest) globalThis.sessionStorage?.removeItem(washLinkCheckpointKey(productId, argsDigest));
      if (legacyArgsDigest !== targetDigest && legacyArgsDigest !== argsDigest) globalThis.sessionStorage?.removeItem(washLinkCheckpointKey(productId, legacyArgsDigest));
    } catch (_) {}
  }

  async function runWashLinkStep(checkpoint, save, operation, phase = "") {
    try {
      return await operation();
    } catch (caught) {
      if (caught?.evidence?.outcomeUnknown === true || caught?.evidence?.dispatched === true) {
        checkpoint.blocked = true;
        checkpoint.blockedCode = String(caught.code || "UPDATE_WASH_LINK_OUTCOME_UNKNOWN");
        checkpoint.blockedPhase = phase;
        save();
      }
      throw caught;
    }
  }

  async function washLink(message) {
    const args = message.args || {};
    const productId = String(args.productId || "");
    assertProductId(productId);
    const targetRows = Array.isArray(args.rows) ? args.rows.map((row) => ({
      specification: normalize(row.specification), price: String(row.price ?? ""), stock: String(row.stock ?? ""), merchantCode: String(row.merchantCode ?? "")
    })) : [];
    if (!targetRows.length || targetRows.some((row) => !row.specification || !row.price || !row.stock || !row.merchantCode)) throw error("UPDATE_WASH_LINK_PLAN_INVALID", "洗链接计划缺少规格、价格、库存或商家编码。", {});
    const phase = String(args.phase || "");
    if (!["add", "modify"].includes(phase)) throw error("UPDATE_WASH_LINK_PHASE_INVALID", "必须手动选择“新增”或“修改”阶段后才能执行。", { phase });
    const targetDigest = String(args.targetDigest || message.argsDigest || "plan");
    const suppliedReviewStructure = args.reviewStructure
      ? validateWashLinkReviewStructure(args.reviewStructure, productId)
      : null;
    const legacyArgsDigest = api.stableDigest({ productId, rows: args.rows, targetDigest: args.targetDigest });
    const { panel } = await activatePriceInventory();
    let columns = null;
    const ensureSkuColumns = () => {
      if (columns) return columns;
      const result = skuColumns(skuHeaderRow(panel));
      columns = result.indexes;
      if (columns.status < 0) throw error("UPDATE_WASH_LINK_STATUS_COLUMN_MISSING", "SKU 表没有可识别的 SKU 状态列。", { headers: result.headers });
      return columns;
    };
    let checkpoint = loadWashLinkCheckpoint(productId, message.argsDigest, targetDigest, legacyArgsDigest);
    const saveCheckpoint = () => saveWashLinkCheckpoint(productId, targetDigest, checkpoint);
    const targetsByKey = new Map(targetRows.map((target) => [api.stableDigest(target), target]));
    let checkpointReconciled = false;
    let current;
    const checkpointDisposition = api.washLinkCheckpointDisposition(checkpoint, phase);
    if (checkpointDisposition === "continue_other_phase" && !checkpoint.blockedPhase) {
      checkpoint.blockedPhase = "add";
      saveCheckpoint();
    }
    if (checkpointDisposition === "reset_unsent_add") {
      checkpoint.added = Object.fromEntries(Object.entries(checkpoint.added || {}).filter(([, value]) =>
        value && typeof value === "object" && value.fieldsComplete === true
      ));
      checkpoint.plan = null;
      checkpoint.blocked = false;
      checkpoint.blockedCode = "";
      checkpoint.blockedPhase = "";
      checkpoint.addPhaseComplete = false;
      saveCheckpoint();
    }
    if (checkpoint.blocked && ["reconcile", "reconcile_add"].includes(checkpointDisposition)) {
      if (checkpointDisposition === "reconcile_add") {
        current = suppliedReviewStructure || await readStructure({ productId });
        const liveEditorValues = await waitForWashLinkSpecificationEditorState(panel, current.specificationType);
        const recoveryAdditions = Object.entries(checkpoint.added || {}).map(([key, value]) => {
          const target = targetsByKey.get(key);
          const saved = value && typeof value === "object" ? value : { skuId: normalize(value) };
          return target ? {
            key,
            specification: target.specification,
            skuId: normalize(saved.skuId),
            fieldsComplete: saved.fieldsComplete === true
          } : { key, specification: "" };
        });
        const checkpointBaselineSpecs = checkpoint.plan && Array.isArray(checkpoint.plan.matched) && Array.isArray(checkpoint.plan.retired)
          ? [
            ...checkpoint.plan.matched.map((entry) => entry?.current?.specification),
            ...checkpoint.plan.retired.map((row) => row?.specification)
          ].filter(Boolean)
          : null;
        const recovery = api.reconcileWashLinkEditorAdditions(
          (checkpointBaselineSpecs || suppliedReviewStructure?.editorSpecs?.map((row) => row.specification) || current.editorSpecs?.map((row) => row.specification) || []).map(normalize),
          liveEditorValues,
          recoveryAdditions
        );
        if (!recovery.safeToContinue) {
          const canResetUnsentCheckpoint = api.canResetWashLinkPendingAddCheckpoint(
            checkpoint,
            liveEditorValues,
            current.skuRows || []
          );
          const canRebaseStaleCheckpoint = api.canRebaseWashLinkPendingAddCheckpoint(checkpoint, current);
          if (!canResetUnsentCheckpoint && !canRebaseStaleCheckpoint) {
            throw error("UPDATE_WASH_LINK_APPEND_RECONCILE_REQUIRED", "商品规格编辑框与原清单不能安全对应；已暂停新增，请先人工核对，避免重复或误加规格。", {
              recoveryReason: recovery.reason,
              editorSpecificationCount: liveEditorValues.length,
              baselineSpecificationCount: checkpointBaselineSpecs?.length || 0,
              skuRowCount: current.skuRows?.length || 0,
              outcomeUnknown: true
            });
          }
          checkpoint.added = {};
          checkpoint.plan = null;
          checkpoint.blocked = false;
          checkpoint.blockedCode = "";
          checkpoint.blockedPhase = "";
          checkpoint.addPhaseComplete = false;
          clearWashLinkCheckpoint(productId, targetDigest, message.argsDigest, legacyArgsDigest);
          saveCheckpoint();
          checkpointReconciled = true;
        } else {
          for (const item of recovery.additions) {
            const previous = checkpoint.added[item.key];
            const saved = previous && typeof previous === "object" ? previous : { skuId: normalize(previous) };
            checkpoint.added[item.key] = item.action === "editor_committed"
              ? { ...saved, editorCommitted: true, appendDispatched: true }
              : { ...saved, skuId: "", editorCommitted: false, appendDispatched: false };
          }
          checkpoint.blocked = false;
          checkpoint.blockedCode = "";
          checkpoint.blockedPhase = "";
          saveCheckpoint();
          checkpointReconciled = true;
        }
      } else {
        current = await waitForWashLinkStable(() => readStructure({ productId }), "断点核对 SKU 表", (state) => state.scanComplete === true);
        const reconciliation = api.reconcileWashLinkCheckpoint(checkpoint, current.skuRows || []);
        const legacyBaselineConfirmed = reconciliation.differences.length === 1 &&
          reconciliation.differences[0] === "断点缺少可核对的原始 SKU 清单" &&
          api.canReconcileLegacyWashLinkCheckpoint(checkpoint, args.reconcileLegacyCheckpoint === true);
        if (!reconciliation.safeToReset && !legacyBaselineConfirmed) {
          throw error("UPDATE_WASH_LINK_CHECKPOINT_RECONCILE_REQUIRED", "当前 SKU 表与上次写入前保存的清单不完全一致，已保留断点并停止；请人工检查差异。", {
            productId,
            differences: reconciliation.differences,
            outcomeUnknown: true
          });
        }
        clearWashLinkCheckpoint(productId, targetDigest, message.argsDigest, legacyArgsDigest);
        checkpoint = {
          renamed: [], renamedSkuIds: {}, labelSynced: {}, existingFields: [], added: {}, retired: [],
          blocked: false, blockedPhase: "", addPhaseComplete: false, modifyPhaseComplete: false
        };
        checkpointReconciled = true;
      }
    } else {
      current = suppliedReviewStructure || await readStructure({ productId });
    }
    let latestStructure = current;
    let skuLocator = createWashLinkSkuLocator(current.skuRows);
    const calculatedPlan = api.planWashLinkRows(current.skuRows || [], targetRows);
    let matched;
    let added;
    let retired;
    if (checkpoint.plan && typeof checkpoint.plan === "object") {
      matched = calculatedPlan.matched;
      const savedAdditionKeys = Array.isArray(checkpoint.plan.addedKeys) ? checkpoint.plan.addedKeys : [];
      const savedAdditions = savedAdditionKeys.map((key) => targetsByKey.get(key));
      const missingSavedAdditions = savedAdditionKeys.filter((key, index) => !savedAdditions[index]);
      if (phase === "add" && missingSavedAdditions.length) {
        throw error("UPDATE_WASH_LINK_CHECKPOINT_ADD_PLAN_MISMATCH", "新增断点对应的 Excel 行已变化；已有 SKU 修改不受影响。请重新核实新增清单后再继续。", {
          missingCount: missingSavedAdditions.length,
          dispatched: false
        });
      }
      const savedAdditionKeySet = new Set(savedAdditionKeys.map(String));
      const newlyPlannedAdditions = calculatedPlan.added.filter((target) => !savedAdditionKeySet.has(api.stableDigest(target)));
      added = [...savedAdditions.filter(Boolean), ...newlyPlannedAdditions];
      retired = calculatedPlan.retired;
    } else {
      ({ matched, added, retired } = calculatedPlan);
      checkpoint.plan = {
        matched: matched.map(({ current: existing, target }) => ({ current: existing, targetKey: api.stableDigest(target) })),
        addedKeys: added.map((target) => api.stableDigest(target)),
        retired
      };
      saveCheckpoint();
    }
    if (added.length === 0 && !(checkpoint.plan?.addedKeys || []).length) checkpoint.addPhaseComplete = true;
    if (matched.length === 0) checkpoint.modifyPhaseComplete = true;
    const liveSkuIds = new Set((current.skuRows || []).map((row) => normalize(row.skuId)).filter(washLinkUsableSkuId));
    const retainedExistingFields = checkpoint.existingFields.filter((skuId) => liveSkuIds.has(normalize(skuId)));
    if (retainedExistingFields.length !== checkpoint.existingFields.length) {
      checkpoint.existingFields = retainedExistingFields;
      saveCheckpoint();
    }
    const changes = [];

    const missingMatchedSkuIds = api.missingWashLinkMatchedSkuIds(matched, phase);
    if (missingMatchedSkuIds.length) {
      throw error("UPDATE_WASH_LINK_SKU_ID_MISSING", "已有 SKU 修改阶段需要有效的 SKUID；请检查清单中标出的旧规格，本阶段未写入。", {
        phase,
        missingSkuCount: missingMatchedSkuIds.length,
        missingSkus: missingMatchedSkuIds,
        dispatched: false
      });
    }

    if (phase === "add" && added.length) {
      const currentEditorSpecifications = (current.editorSpecs || []).map((row) => normalize(row.specification)).filter(Boolean);
      const currentEditorSet = new Set(currentEditorSpecifications);
      const workbookAdditions = added.filter((target) => !currentEditorSet.has(normalize(target.specification)));
      if (workbookAdditions.length) {
        for (const target of workbookAdditions) {
          const key = api.stableDigest(target);
          checkpoint.added[key] = { skuId: "", fieldsComplete: false, appendDispatched: false, editorCommitted: false };
        }
        saveCheckpoint();
        await runWashLinkStep(checkpoint, saveCheckpoint, async () => {
          const runtime = globalThis.DoudianProductEditorRuntime;
          if (!runtime?.execute) throw error("UPDATE_PRODUCT_EDITOR_RUNTIME_UNAVAILABLE", "旧版规格 Excel 导入能力未加载；未开始新增。", { dispatched: false });
          const importReceipt = await runtime.execute("append_specifications_using_workbook", {
            specificationType: current.specificationType,
            existingSpecifications: currentEditorSpecifications,
            additions: workbookAdditions.map((target) => target.specification)
          }, {
            runToken: message.runToken,
            onIdentifyDispatch: () => {
              for (const target of workbookAdditions) {
                checkpoint.added[api.stableDigest(target)] = {
                  skuId: "", fieldsComplete: false, appendDispatched: true, editorCommitted: false
                };
              }
              checkpoint.blockedPhase = "add";
              saveCheckpoint();
            }
          });
          const expectedEditorSpecifications = Array.isArray(importReceipt?.observedSpecifications)
            ? importReceipt.observedSpecifications.map(normalize).filter(Boolean)
            : [...currentEditorSpecifications, ...workbookAdditions.map((target) => normalize(target.specification))];
          panel = liveWashLinkSpecificationPanel() || panel;
          columns = null;
          latestStructure = await waitForWashLinkStable(() => readStructure({ productId }), "Excel 规格识别后读取 SKU 表", (state) => {
            const specs = (state.editorSpecs || []).map((row) => normalize(row.specification)).filter(Boolean);
            return state.scanComplete === true &&
              specs.length === expectedEditorSpecifications.length &&
              expectedEditorSpecifications
                .every((specification, index) => specs[index] === specification);
          });
          for (const oldRow of current.skuRows || []) {
            const retained = (latestStructure.skuRows || []).find((row) => normalize(row.skuId) === normalize(oldRow.skuId));
            if (!retained || normalize(retained.specification) !== normalize(oldRow.specification) ||
                normalize(retained.price) !== normalize(oldRow.price) ||
                normalize(retained.merchantCode) !== normalize(oldRow.merchantCode)) {
              throw error("UPDATE_WASH_LINK_WORKBOOK_OLD_SKU_CHANGED", `规格 Excel 识别后旧 SKU“${oldRow.skuId}”身份、价格或商家编码发生变化；已停止，不会继续填写新 SKU。`, {
                skuId: normalize(oldRow.skuId),
                expectedSpecification: oldRow.specification,
                observedSpecification: retained?.specification || "",
                expectedPrice: oldRow.price,
                observedPrice: retained?.price || "",
                expectedMerchantCode: oldRow.merchantCode,
                observedMerchantCode: retained?.merchantCode || "",
                outcomeUnknown: true
              });
            }
          }
          const baselineIds = new Set((current.skuRows || []).map((row) => normalize(row.skuId)).filter(Boolean));
          for (const target of workbookAdditions) {
            const candidates = (latestStructure.skuRows || []).filter((row) =>
              !baselineIds.has(normalize(row.skuId)) && normalize(row.specification) === normalize(target.specification)
            );
            if (candidates.length !== 1) {
              throw error("UPDATE_WASH_LINK_WORKBOOK_ADD_RECONCILE_REQUIRED", `Excel 规格识别后无法唯一定位新增 SKU“${target.specification}”。`, {
                specification: target.specification,
                candidateSkuIds: candidates.map((row) => normalize(row.skuId)),
                outcomeUnknown: true
              });
            }
            checkpoint.added[api.stableDigest(target)] = {
              skuId: normalize(candidates[0].skuId), fieldsComplete: false,
              appendDispatched: true, editorCommitted: true
            };
          }
          current = latestStructure;
          skuLocator = createWashLinkSkuLocator(current.skuRows);
          checkpoint.blocked = false;
          checkpoint.blockedCode = "";
          checkpoint.blockedPhase = "";
          saveCheckpoint();
        }, "add");
      }
    }

    // Existing SKU specification text, including its bracketed label, is
    // intentionally preserved. This flow only updates price and merchant code.
    // Each button runs only its own SKU phase; either phase can be selected first.
    if (phase !== "add") {
      for (const { current: existing, target } of matched) {
        const checkpointSkuIds = new Set([existing.previousSkuId, existing.skuId].map((value) => String(value || "")).filter(Boolean));
        const wasCheckpointed = checkpoint.existingFields.some((skuId) => checkpointSkuIds.has(String(skuId)));
        if (wasCheckpointed) {
          const scannedRow = (latestStructure.skuRows || []).find((row) => normalize(row.skuId) === normalize(existing.skuId));
          if (!scannedRow) {
            throw error("UPDATE_WASH_LINK_CHECKPOINT_SKU_MISSING", `本次清单中找不到 SKU“${existing.skuId}”；本阶段已在写入前停止。`, {
              skuId: String(existing.skuId),
              dispatched: false
            });
          }
          checkpoint.existingFields = checkpoint.existingFields.filter((skuId) => !checkpointSkuIds.has(String(skuId)));
          if (api.washLinkExistingFieldsMatch(scannedRow, target)) {
            checkpoint.existingFields.push(String(existing.skuId));
            saveCheckpoint();
            continue;
          }
          checkpoint.modifyPhaseComplete = false;
          saveCheckpoint();
        }
        const existingSkuId = normalize(existing.skuId);
        const result = await runWashLinkStep(checkpoint, saveCheckpoint, () => setWashLinkExistingFieldsBySkuId(panel, columns, existingSkuId, target, skuLocator), "modify");
        checkpoint.existingFields.push(String(existingSkuId));
        saveCheckpoint();
        changes.push({ phase: "existing_fields", ...result });
      }
      checkpoint.modifyPhaseComplete = true;
      saveCheckpoint();
    }

    // Commit every new model in the specification editor before reading the SKU table.
    let expectedEditorSpecifications = editorSpecificationInputState(panel, current.specificationType).inputs
      .map((input) => normalize(input.value)).filter(Boolean);
    if (phase !== "modify") for (const target of added) {
      const targetKey = api.stableDigest(target);
      let priorAdded = checkpoint.added[targetKey];
      if (priorAdded && typeof priorAdded === "object" && priorAdded.fieldsComplete === true) continue;
      let appendedSkuId = priorAdded && typeof priorAdded === "object" ? normalize(priorAdded.skuId) : normalize(priorAdded);
      if (!appendedSkuId && priorAdded && typeof priorAdded === "object" && priorAdded.appendDispatched === false) {
        delete checkpoint.added[targetKey];
        saveCheckpoint();
      }
      if (!appendedSkuId && priorAdded?.appendDispatched === true && priorAdded?.editorCommitted !== true) {
        const liveEditorValues = await waitForWashLinkSpecificationEditorState(panel, current.specificationType);
        const checkpointBaselineSpecs = checkpoint.plan && Array.isArray(checkpoint.plan.matched) && Array.isArray(checkpoint.plan.retired)
          ? [
            ...checkpoint.plan.matched.map((entry) => entry?.current?.specification),
            ...checkpoint.plan.retired.map((row) => row?.specification)
          ].filter(Boolean)
          : (suppliedReviewStructure?.editorSpecs || current.editorSpecs || []).map((row) => row.specification);
        const recovery = api.reconcileWashLinkEditorAdditions(
          checkpointBaselineSpecs.map(normalize),
          liveEditorValues,
          added.map((addition) => {
            const key = api.stableDigest(addition);
            const saved = checkpoint.added[key];
            return {
              key,
              specification: addition.specification,
              skuId: normalize(saved?.skuId),
              fieldsComplete: saved?.fieldsComplete === true
            };
          })
        );
        if (!recovery.safeToContinue) {
          checkpoint.blocked = true;
          checkpoint.blockedCode = "UPDATE_WASH_LINK_APPEND_RECONCILE_REQUIRED";
          checkpoint.blockedPhase = "add";
          saveCheckpoint();
          throw error("UPDATE_WASH_LINK_APPEND_RECONCILE_REQUIRED", "商品规格编辑框与原清单不能安全对应；已暂停新增，请先人工核对，避免重复或误加规格。", {
            recoveryReason: recovery.reason,
            outcomeUnknown: true
          });
        }
        for (const item of recovery.additions) {
          const saved = checkpoint.added[item.key] && typeof checkpoint.added[item.key] === "object" ? checkpoint.added[item.key] : {};
          checkpoint.added[item.key] = item.action === "editor_committed"
            ? { ...saved, editorCommitted: true, appendDispatched: true }
            : { ...saved, skuId: "", editorCommitted: false, appendDispatched: false };
        }
        saveCheckpoint();
        priorAdded = checkpoint.added[targetKey];
      }
      if (!appendedSkuId && priorAdded?.editorCommitted !== true && priorAdded?.appendDispatched !== true) {
        checkpoint.added[targetKey] = { skuId: "", fieldsComplete: false, appendDispatched: false };
        saveCheckpoint();
        await runWashLinkStep(checkpoint, saveCheckpoint, () => appendWashLinkSpecification(panel, current.specificationType, target, () => {
          checkpoint.added[targetKey] = { skuId: "", fieldsComplete: false, appendDispatched: true, editorCommitted: false };
          checkpoint.blockedPhase = "add";
          saveCheckpoint();
        }), "add");
        expectedEditorSpecifications = [...expectedEditorSpecifications, target.specification];
        checkpoint.added[targetKey] = { skuId: "", fieldsComplete: false, appendDispatched: true, editorCommitted: false };
        saveCheckpoint();
      }
    }

    if (phase !== "modify" && added.some((target) => checkpoint.added[api.stableDigest(target)]?.fieldsComplete !== true)) {
      await runWashLinkStep(checkpoint, saveCheckpoint, () =>
        waitForWashLinkFinalSpecificationEditor(panel, current.specificationType, expectedEditorSpecifications), "add");
      for (const target of added) {
        const targetKey = api.stableDigest(target);
        const prior = checkpoint.added[targetKey];
        if (prior?.fieldsComplete === true) continue;
        checkpoint.added[targetKey] = { ...prior, editorCommitted: true, appendDispatched: true };
      }
      saveCheckpoint();
      const baselineIds = new Set([
        ...(checkpoint.plan?.matched || []).map((entry) => normalize(entry?.current?.skuId)),
        ...(checkpoint.plan?.retired || []).map((row) => normalize(row?.skuId))
      ].filter(Boolean));
      const mapNewRows = (state) => {
        const rowsByTarget = new Map();
        const claimedIds = new Set();
        for (const target of added) {
          const targetKey = api.stableDigest(target);
          const prior = checkpoint.added[targetKey];
          if (prior?.fieldsComplete === true) continue;
          const existingSkuId = normalize(prior?.skuId);
          if (existingSkuId) {
            const row = (state.skuRows || []).find((candidate) => normalize(candidate.skuId) === existingSkuId && normalize(candidate.specification) === normalize(target.specification));
            if (!row || claimedIds.has(existingSkuId)) return null;
            rowsByTarget.set(targetKey, row);
            claimedIds.add(existingSkuId);
            continue;
          }
          const candidates = (state.skuRows || []).filter((row) => {
            const skuId = normalize(row.skuId);
            return skuId && !baselineIds.has(skuId) && !claimedIds.has(skuId) && normalize(row.specification) === normalize(target.specification);
          });
          if (candidates.length !== 1) return null;
          rowsByTarget.set(targetKey, candidates[0]);
          claimedIds.add(normalize(candidates[0].skuId));
        }
        return rowsByTarget;
      };
      let lastAdditionState = null;
      try {
        latestStructure = await waitForWashLinkStable(() => readStructure({ productId }), "全部新增规格提交后读取价格库存表", (state) => {
          lastAdditionState = state;
          return state.scanComplete === true && mapNewRows(state) !== null;
        });
      } catch (caught) {
        const ambiguous = added.some((target) => {
          const targetKey = api.stableDigest(target);
          const priorSkuId = normalize(checkpoint.added[targetKey]?.skuId);
          if (priorSkuId) return false;
          const candidates = (lastAdditionState?.skuRows || []).filter((row) => !baselineIds.has(normalize(row.skuId)) && normalize(row.specification) === normalize(target.specification));
          return candidates.length > 1;
        });
        if (ambiguous) {
          checkpoint.blocked = true;
          checkpoint.blockedCode = "UPDATE_WASH_LINK_APPEND_RECONCILE_REQUIRED";
          checkpoint.blockedPhase = "add";
          saveCheckpoint();
        }
        throw error(ambiguous ? "UPDATE_WASH_LINK_APPEND_RECONCILE_REQUIRED" : "UPDATE_WASH_LINK_APPEND_SKU_READBACK_TIMEOUT",
          ambiguous ? "全部规格已填写，但新 SKU 身份不唯一；请先人工核对页面，不会重复新增。" : "全部规格已填写，价格库存表仍未生成完整的新 SKU 行；可在页面稳定后重新点击新增，不会重复录入规格。",
          { outcomeUnknown: ambiguous, causeCode: String(caught?.code || "UPDATE_WASH_LINK_STABILITY_TIMEOUT") });
      }
      const newRowsByTarget = mapNewRows(latestStructure);
      if (!newRowsByTarget) throw error("UPDATE_WASH_LINK_APPEND_RECONCILE_REQUIRED", "全部新增规格已填写，但价格库存表中的新 SKUID 仍不能唯一对应；已暂停填写字段，不会重复新增。", { outcomeUnknown: true });
      ensureSkuColumns();
      skuLocator = createWashLinkSkuLocator(latestStructure.skuRows);
      for (const target of added) {
        const targetKey = api.stableDigest(target);
        const prior = checkpoint.added[targetKey];
        if (prior?.fieldsComplete === true) continue;
        checkpoint.added[targetKey] = { ...prior, skuId: normalize(newRowsByTarget.get(targetKey)?.skuId), fieldsComplete: false, appendDispatched: true, editorCommitted: true };
      }
      saveCheckpoint();
    }

    // Fill the newly generated SKU rows only after every requested model is committed.
    if (phase !== "modify") for (const target of added) {
      const targetKey = api.stableDigest(target);
      const priorAdded = checkpoint.added[targetKey];
      if (priorAdded && typeof priorAdded === "object" && priorAdded.fieldsComplete === true) continue;
      const appendedSkuId = priorAdded && typeof priorAdded === "object" ? normalize(priorAdded.skuId) : normalize(priorAdded);
      if (!appendedSkuId) {
        throw error("UPDATE_WASH_LINK_APPEND_SKU_ID_MISSING", `新增规格“${target.specification}”已提交型号，但未能取得新 SKU 身份；先核对当前页面，不会继续填写字段。`, {
          specification: target.specification,
          dispatched: false
        });
      }
      let binding = await findWashLinkRowBySkuId(panel, columns, appendedSkuId, skuLocator);
      columns = binding.columns || columns;
      const setNewCell = async (key, value, field) => {
        binding = await findWashLinkRowBySkuId(panel, columns, appendedSkuId, skuLocator);
        columns = binding.columns || columns;
        const input = binding.cells[columns[key]]?.querySelector("input,textarea");
        if (!input) throw error("UPDATE_WASH_LINK_INPUT_MISSING", `新增 SKU“${appendedSkuId}”缺少${field}输入框。`, { skuId: appendedSkuId, field });
        setInputValue(input, String(value));
        input.dispatchEvent(new Event("blur", { bubbles: true }));
        await sleep(180);
      };
      await runWashLinkStep(checkpoint, saveCheckpoint, async () => {
        await setNewCell("price", target.price, "价格");
        await setWashLinkNewStockBySkuId(panel, columns, appendedSkuId, "999", skuLocator);
        await setNewCell("merchantCode", target.merchantCode, "商家编码");
      }, "add");
      binding = await findWashLinkRowBySkuId(panel, columns, appendedSkuId, skuLocator);
      columns = binding.columns || columns;
      const readback = {
        phase: "append",
        skuId: appendedSkuId,
        specification: readInputOrText(binding.cells[columns.specification]),
        price: readInputOrText(binding.cells[columns.price]),
        stock: washLinkNewDisplayedStock(binding.cells[columns.stock], appendedSkuId),
        merchantCode: readInputOrText(binding.cells[columns.merchantCode]),
        stockChange: { action: "direct", current: "", target: "999", amount: 999 }
      };
      if (normalize(readback.specification) !== normalize(target.specification) || Number(readback.price) !== Number(target.price) || Number(readback.stock) !== 999 || String(readback.merchantCode) !== String(target.merchantCode)) {
        throw error("UPDATE_WASH_LINK_ROW_READBACK_FAILED", `新增 SKU“${appendedSkuId}”回读不一致。`, { skuId: appendedSkuId, target, readback, outcomeUnknown: true });
      }
        checkpoint.added[targetKey] = { skuId: appendedSkuId, fieldsComplete: true };
        checkpoint.blockedPhase = "";
      saveCheckpoint();
      changes.push(readback);
    }

    // Row-level readback verifies field writes. Keep the last complete structure
    // from the review snapshot or the target-SKU readback after an append.
    skuLocator = createWashLinkSkuLocator(latestStructure.skuRows);
    if (phase !== "modify") checkpoint.addPhaseComplete = true;
    saveCheckpoint();

    if (!checkpoint.addPhaseComplete || !checkpoint.modifyPhaseComplete) {
      return {
        productId,
        phase,
        matchedCount: matched.length,
        addedCount: added.length,
        retiredCount: retired.length,
        changes,
        checkpointReconciled,
        manualReconcileRequired: checkpoint.blocked === true,
        blockedPhase: checkpoint.blockedPhase || "",
        addPhaseComplete: checkpoint.addPhaseComplete,
        modifyPhaseComplete: checkpoint.modifyPhaseComplete,
        workflowComplete: false,
        manualSortRequired: false,
        manualSaveRequired: true
      };
    }

    // Phase 3: obsolete rows stay untouched. The review list keeps them in page
    // order so the operator can locate and delete them manually after checking.
    changes.push(...retired.map((row) => ({ phase: "retired_pending_manual", skuId: normalize(row.skuId), specification: row.specification })));
    const afterAllFields = await waitForWashLinkStable(() => readStructure({ productId }), "规格、价格和新增后的 SKU 表");
    skuLocator = createWashLinkSkuLocator(afterAllFields.skuRows);
    // Sorting is rendered in the editor's right-side panel. Leave it to the
    // operator after all SKU writes settle; never click a potentially stale control.
    const customSortActivated = false;
    if (!checkpoint.blocked) clearWashLinkCheckpoint(productId, targetDigest, message.argsDigest, legacyArgsDigest);
    return {
      productId,
      phase,
      checkpointReconciled,
      matchedCount: matched.length,
      addedCount: added.length,
      retiredCount: retired.length,
      changes,
      manualReconcileRequired: checkpoint.blocked === true,
      workflowComplete: true,
      customSortActivated,
      manualSortRequired: true,
      manualSaveRequired: true
    };
  }

  function publishButton() {
    const matches = [...document.querySelectorAll('button[type="button"]')]
      .filter(visible)
      .filter((node) => text(node) === "发布商品");
    if (matches.length !== 1) {
      throw error(matches.length ? "UPDATE_PUBLISH_BUTTON_AMBIGUOUS" : "UPDATE_PUBLISH_BUTTON_NOT_FOUND",
        "当前商品编辑页没有唯一可用的“发布商品”按钮。", {
          count: matches.length,
          dispatched: false,
          fix: "确认页面已完整加载且只显示一个商品编辑表单后重试。"
        });
    }
    const button = matches[0];
    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      throw error("UPDATE_PUBLISH_BUTTON_DISABLED", "“发布商品”按钮当前不可点击。", {
        dispatched: false,
        fix: "查看页面校验提示，补全必填内容后重新执行该商品。"
      });
    }
    return button;
  }

  function visiblePublishFeedback() {
    return [...new Set(
      [...document.querySelectorAll(PUBLISH_FEEDBACK_SELECTOR)]
        .filter(visible)
        .map((node) => text(node))
        .filter(Boolean)
        .map((value) => value.slice(0, 300))
    )];
  }

  function publishSuccessPageEvidence() {
    const expected = normalize(PUBLISH_SUCCESS_TITLE);
    const matches = [...document.querySelectorAll('h1,h2,h3,h4,p,span,[class*="title"],[class*="Title"]')]
      .filter(visible)
      .filter((node) => text(node) === expected);
    if (matches.length === 0) return null;
    return Object.freeze({
      source: "success_page_dom",
      successPage: true,
      title: PUBLISH_SUCCESS_TITLE,
      url: location.href
    });
  }

  function classifyPublishFeedback(before, current) {
    const baseline = new Set(Array.from(before || [], normalize));
    const added = Array.from(current || [], normalize)
      .filter(Boolean)
      .filter((value) => !baseline.has(value));
    const failure = added.find((value) => /(?:商品)?发布(?:商品)?失败|发布未成功|提交(?:审核)?失败|操作失败/.test(value));
    if (failure) return Object.freeze({ state: "confirmed_failure", feedback: failure, added: Object.freeze(added) });
    const success = added.find((value) => /(?:商品)?发布商品成功|(?:商品)?发布成功|成功发布|提交(?:审核)?成功|操作成功/.test(value));
    if (success) return Object.freeze({ state: "confirmed_success", feedback: success, added: Object.freeze(added) });
    return Object.freeze({ state: "pending", feedback: null, added: Object.freeze(added) });
  }

  async function waitForPublishConfirmation(before, dispatch) {
    const deadline = Date.now() + PUBLISH_CONFIRMATION_TIMEOUT_MS;
    let last = Object.freeze({ state: "pending", feedback: null, added: Object.freeze([]) });
    let wake = null;
    const observer = typeof MutationObserver === "function"
      ? new MutationObserver(() => wake?.())
      : null;
    const waitForMutationOrPoll = () => new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (wake === finish) wake = null;
        resolve();
      };
      wake = finish;
      timer = setTimeout(finish, 250);
    });
    try {
      observer?.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      dispatch();
      while (Date.now() < deadline) {
        const successPage = publishSuccessPageEvidence();
        if (successPage) {
          return Object.freeze({ state: "confirmed_success", feedback: successPage.title, ...successPage });
        }
        last = classifyPublishFeedback(before, visiblePublishFeedback());
        if (last.state === "confirmed_success") {
          return Object.freeze({ ...last, source: "page_feedback", successPage: false, url: location.href });
        }
        if (last.state === "confirmed_failure") {
          throw error("UPDATE_PUBLISH_CONFIRMED_FAILED", "平台明确提示商品发布失败，已保留编辑页。", {
            dispatched: true,
            outcomeUnknown: false,
            feedback: last.feedback,
            observedFeedback: last.added,
            fix: "根据页面发布失败提示修正商品后，再重新执行该商品。"
          });
        }
        await waitForMutationOrPoll();
      }
    } finally {
      observer?.disconnect();
      wake?.();
    }
    throw error("UPDATE_PUBLISH_CONFIRMATION_TIMEOUT", "点击发布后未在限定时间内观察到平台发布成功，已保留编辑页。", {
      dispatched: true,
      outcomeUnknown: true,
      timeoutMs: PUBLISH_CONFIRMATION_TIMEOUT_MS,
      observedFeedback: last.added,
      fix: "人工检查保留的商品编辑页和商品管理状态，确认前不要再次发布。"
    });
  }

  async function publishProduct(message) {
    return runMutation(message, async (envelope) => {
      const args = api.createProductPublishArgs(message.args);
      const actualProductId = new URL(location.href).searchParams.get("product_id");
      if (actualProductId !== args.productId) {
        throw error("UPDATE_PUBLISH_PRODUCT_ID_MISMATCH", "发布前编辑页商品 ID 与修改目标不一致。", {
          expectedProductId: args.productId,
          actualProductId,
          dispatched: false,
          fix: "切回正确商品编辑页后重新执行该商品。"
        });
      }
      try {
        productFormTabList();
      } catch (caught) {
        caught.evidence = {
          ...(caught.evidence || {}),
          dispatched: false,
          fix: caught?.evidence?.fix || "确认商品编辑页已完整加载后重新执行该商品。"
        };
        throw caught;
      }
      const missingReceipts = args.mutationReceipts.filter((receipt) => {
        const completed = completedMutations.get(receipt.commandId);
        return !completed || completed.argsDigest !== receipt.argsDigest ||
          [api.COMMANDS.PUBLISH_PRODUCT, api.COMMANDS.ABORT].includes(completed.command);
      });
      if (missingReceipts.length) {
        throw error("UPDATE_PUBLISH_MODIFICATION_RECEIPT_MISSING", "发布前无法证明当前商品的授权修改已全部完成。", {
          missingReceipts,
          dispatched: false,
          fix: "保留编辑页，检查修改日志后重新执行该商品。"
        });
      }
      if (document.visibilityState !== "visible") {
        throw error("UPDATE_PUBLISH_FOREGROUND_REQUIRED", "发布前商品编辑页必须保持在前台。", {
          visibilityState: document.visibilityState || null,
          dispatched: false,
          fix: "切回该商品编辑页并保持前台后重新执行。"
        });
      }
      const button = publishButton();
      const feedbackBeforeClick = visiblePublishFeedback();
      const confirmation = await waitForPublishConfirmation(feedbackBeforeClick, () => {
        dispatchPointerClick(button, { code: "UPDATE_PUBLISH_BUTTON_DISABLED", object: "发布商品按钮" });
      });
      return Object.freeze({
        state: "confirmed_success",
        productId: args.productId,
        mode: args.mode,
        actionCount: args.actionCount,
        modificationDigest: args.modificationDigest,
        commandId: envelope.commandId,
        argsDigest: envelope.argsDigest,
        dispatched: true,
        confirmed: true,
        confirmation: Object.freeze({
          source: confirmation.source || "page_feedback",
          feedback: confirmation.feedback,
          successPage: confirmation.successPage === true,
          url: confirmation.url || location.href
        }),
        reason: "已点击发布商品并观察到平台发布成功提示。"
      });
    });
  }

  function editorRuntime() {
    const runtime = globalThis.DoudianProductEditorRuntime;
    if (!runtime?.execute) throw error("UPDATE_PRODUCT_EDITOR_RUNTIME_UNAVAILABLE", "商品编辑页面共用能力未加载。", { impact: "不修改页面。", fix: "刷新商品编辑页后重试。" });
    return runtime;
  }

  async function executeEditorCommand(message) {
    const readOnly = [api.COMMANDS.VERIFY_SKU_STOCK].includes(message.command);
    const execute = () => {
      if (message.command === api.COMMANDS.REPLACE_SKU_IMAGE) assertProductId(String(message.args?.productId || ""));
      return editorRuntime().execute(message.command, message.args || {}, { runToken: message.runToken });
    };
    if (readOnly) return execute();
    return runMutation(message, async () => {
      try {
        const result = await execute();
        return { state: "completed", command: message.command, result };
      } catch (caught) {
        const imageSwap = message.command === api.COMMANDS.REPLACE_SKU_IMAGE;
        const outcomeUnknown = caught?.evidence?.dispatched === false
          ? false
          : imageSwap ? caught?.evidence?.dispatched === true : true;
        throw Object.assign(caught, { evidence: { ...(caught?.evidence || {}), outcomeUnknown, impact: "不发布、不自动重发，保留页面供人工检查。" } });
      }
    });
  }

  const EDITOR_COMMANDS = new Set([
    api.COMMANDS.WASH_LINK,
    api.COMMANDS.CREATE_SPECIFICATION_GROUP, api.COMMANDS.CREATE_SPECIFICATION_STEP, api.COMMANDS.FILL_SKU_ROW,
    api.COMMANDS.SET_BATCH_STOCK, api.COMMANDS.VERIFY_SKU_STOCK, api.COMMANDS.REPLACE_SKU_IMAGE,
  ]);

  async function handle(message) {
    assertPage();
    if (!api.COMMAND_ALLOWLIST.has(message?.command)) throw error("UPDATE_COMMAND_NOT_ALLOWED", "Update 页面命令不在允许列表。", { command: message?.command });
    if (typeof message?.runToken !== "string" || message.runToken.length < 8) throw error("UPDATE_RUN_TOKEN_INVALID", "Update 运行令牌无效或已失效。");
    if (message.command === api.COMMANDS.ABORT) {
      if (activeRun && activeRun !== message.runToken) throw error("UPDATE_RUN_TOKEN_INVALID", "其他运行正在使用当前页面，不能清理其运行令牌。", { activeRun, receivedRun: message.runToken });
      if (globalThis.DoudianProductEditorRuntime) {
        try { globalThis.DoudianProductEditorRuntime.abort(message.runToken); } catch (_) {}
      }
      activeRun = null;
      abortedRun = message.runToken;
      return { state: "aborted", documentToken };
    }
    if ((activeRun && activeRun !== message.runToken) || abortedRun === message.runToken) throw error("UPDATE_RUN_TOKEN_INVALID", "Update 运行令牌无效或已失效。");
    // Locating is read-only. It must remain available after a review read, whose
    // document token may have gone stale while the operator reviewed the list.
    const tokenOptional = [
      api.COMMANDS.OBSERVE_LIST,
      api.COMMANDS.READ_STRUCTURE,
      api.COMMANDS.READ_REPLACE_GROUP,
      api.COMMANDS.LOCATE_WASH_LINK_ROW
    ].includes(message.command);
    if (!tokenOptional && message.documentToken !== documentToken) throw error("UPDATE_DOCUMENT_STALE", "Update 页面文档已变化，请重新读取。", { expected: documentToken, received: message.documentToken });
    activeRun = message.runToken;
    if (message.command === api.COMMANDS.OBSERVE_LIST) return listEvidence();
    if (message.command === api.COMMANDS.SEARCH_LIST) return searchList(message.args);
    if (message.command === api.COMMANDS.NEXT_PAGE) return nextPage();
    if (message.command === api.COMMANDS.GO_PAGE) return goPage(message.args);
    if (message.command === api.COMMANDS.OPEN_EDIT) return openEdit(message.args);
    if (message.command === api.COMMANDS.READ_STRUCTURE) return readStructure(message.args);
    if (message.command === api.COMMANDS.LOCATE_WASH_LINK_ROW) return locateWashLinkRow(message.args);
    if (message.command === api.COMMANDS.READ_REPLACE_GROUP) return readReplaceGroup(message.args);
    if (message.command === api.COMMANDS.DELETE_SPEC_GROUP) return deleteSpecGroup(message);
    if (message.command === api.COMMANDS.DELETE_SPEC_VALUE) return deleteSpecValue(message);
    if (message.command === api.COMMANDS.WASH_LINK) return runMutation(message, async () => {
      const result = await washLink(message);
      return { state: "completed", command: message.command, result };
    });
    if (message.command === api.COMMANDS.PUBLISH_PRODUCT) return publishProduct(message);
    if (EDITOR_COMMANDS.has(message.command)) return executeEditorCommand(message);
    throw error("UPDATE_COMMAND_NOT_IMPLEMENTED", "Update 页面命令尚未实现。", { command: message.command });
  }

  if (globalThis.__DoudianUpdateTestApi) {
    Object.assign(globalThis.__DoudianUpdateTestApi, {
      activatePriceInventory, deleteSpecGroup, deleteSpecValue, editorSpecifications,
      executeEditorCommand, handle, listEvidence, listQueryButton, listQueryInput, observeEditHref, observedEditHref, openEdit, searchList,
      publishButton, publishProduct,
      classifyPublishFeedback, publishSuccessPageEvidence, visiblePublishFeedback, waitForPublishConfirmation,
      productFormTabList, productTitle, readReplaceGroup, readStructure, scanSkuRows,
      emptySpecificationEditorEvidence, inspectReplaceGroup, specGroupBindings, specGroupObservations, specValueBinding,
      setTestActiveRun(value) { activeRun = value; abortedRun = null; },
      testRunState() { return { activeRun, abortedRun }; }
    });
  }

  const listener = (message, _sender, sendResponse) => {
    if (message?.type !== api.MESSAGE_TYPE) return false;
    handle(message).then(
      (result) => sendResponse({ ok: true, evidence: { buildId, command: message.command, runToken: message.runToken, documentToken, result } }),
      (caught) => sendResponse({ ok: false, error: caught.message, errorCode: caught.code || "UPDATE_PAGE_COMMAND_FAILED", evidence: { buildId, ...(caught.evidence || {}) } })
    );
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  globalThis[installKey] = Object.freeze({ version: installVersion, listener });
})();
