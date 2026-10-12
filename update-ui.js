"use strict";

(() => {
  const contract = globalThis.DoudianUpdateContract;
  const workbookPlanner = globalThis.DoudianWorkbookPlan;
  const skuPlanner = globalThis.DoudianSkuImagePlan;
  const preflight = globalThis.DoudianPreflight;
  const binary = globalThis.DoudianBinary;
  const loadedBuildId = String(globalThis.DoudianBuildInfo?.id || "unknown");
  const PUBLISH_SUCCESS_TITLE = "商品提交成功，继续发布商品视频，分享到抖音";
  const PUBLISH_NAVIGATION_CONFIRMATION_TIMEOUT_MS = 5000;
  const PUBLISH_NAVIGATION_POLL_MS = 100;
  const input = document.getElementById("updatePriceInventoryInput");
  const skuImagesInput = document.getElementById("updateSkuImagesInput");
  const priceInventoryDrop = document.getElementById("updatePriceInventoryDrop");
  const skuImagesDrop = document.getElementById("updateSkuImagesDrop");
  const priceInventoryDropText = document.getElementById("updatePriceInventoryDropText");
  const skuImagesDropText = document.getElementById("updateSkuImagesDropText");
  const priceInventoryClear = document.getElementById("updatePriceInventoryClear");
  const skuImagesClear = document.getElementById("updateSkuImagesClear");
  const runButton = document.getElementById("updateDryRunButton");
  const continueCurrentButton = document.getElementById("updateContinueCurrentButton");
  const resumeButton = document.getElementById("updateResumeButton");
  const failureDialog = document.getElementById("updateFailureDialog");
  const failureTitle = document.getElementById("updateFailureTitle");
  const failureMessage = document.getElementById("updateFailureMessage");
  const failureAdvice = document.getElementById("updateFailureAdvice");
  const failureStopButton = document.getElementById("updateFailureStop");
  const failureSkipButton = document.getElementById("updateFailureSkip");
  const priceInventoryEnabled = document.getElementById("updatePriceInventoryEnabled");
  const skuImagesEnabled = document.getElementById("updateSkuImagesEnabled");
  const productQueryInput = document.getElementById("updateProductQuery");
  const productQueryField = document.getElementById("updateProductQueryField");
  const scopeLink = document.getElementById("updateScopeLink");
  const pauseButton = document.getElementById("updatePauseButton");
  const updateHeading = document.getElementById("updateHeading");
  const updateSubmodeButtons = [...document.querySelectorAll("[data-update-submode]")];
  const washSortReminder = document.getElementById("washSortReminder");
  const washReviewSection = document.getElementById("washReview");
  const washReviewHeading = document.getElementById("washReviewHeading");
  const washReviewHelp = document.getElementById("washReviewHelp");
  const washReviewSummary = document.getElementById("washReviewSummary");
  const washReviewFilters = document.getElementById("washReviewFilters");
  const washReviewList = document.getElementById("washReviewList");
  const washReviewActions = document.getElementById("washReviewActions");
  const washAddButton = document.getElementById("washAddButton");
  const washModifyButton = document.getElementById("washModifyButton");
  const updateSubmodePanels = Object.freeze({
    replace: document.getElementById("updateReplacePanel"),
    wash: document.getElementById("updateReplacePanel"),
    offsale: document.getElementById("updateOffsalePanel"),
    "image-swap": document.getElementById("updateImageSwapPanel")
  });
  const offsaleSpecifications = document.getElementById("updateOffsaleSpecifications");
  const imageSwapInput = document.getElementById("updateImageSwapInput");
  const status = document.getElementById("updateStatus");
  const report = document.getElementById("updateReport");
  const logsSection = document.getElementById("updateLogsSection");
  const stats = document.getElementById("updateStats");
  const results = document.getElementById("updateResults");
  const updateSection = document.querySelector(".update-section");
  const createContent = document.querySelector(".create-mode-content");
  const createStatus = document.getElementById("statusBadge");
  const imageTextSection = document.querySelector(".image-text-section");
  const imageTextStatus = document.getElementById("imageTextStatus");
  const modeButtons = [...document.querySelectorAll("[data-panel-mode]")];
  const modePanels = Object.freeze({
    create: createContent,
    update: updateSection,
    "image-text": imageTextSection
  });

  let materialPlan = null;
  let imageSwapPlan = null;
  let updateSubmode = "replace";
  let running = false;
  let paused = false;
  let runToken = null;
  let activeRunPlan = null;
  let activeBatchCheckpoint = null;
  let recoverySnapshot = null;
  let productSummaries = new Map();
  let auditLines = [];
  let auditContext = Object.freeze({});
  let scopeLinkRevision = 0;
  let priceInventoryFiles = [];
  let replaceSkuImageFiles = [];
  let pendingWashReview = null;
  let displayedWashReview = null;
  let washReviewFilter = null;

  function updateStatus(message, state = "idle") {
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
    status.hidden = !message;
  }

  function render(value) {
    if (report) report.textContent = value;
  }

  function clearMaterialFailureState() {
    if (!logsSection) return;
    logsSection.open = false;
    logsSection.removeAttribute("data-state");
  }

  function audit(stage, details = {}) {
    const safeValue = (value) => {
      if (value === null || value === undefined || typeof value !== "object") return String(value ?? "");
      const compact = JSON.stringify(value, (key, item) => /payload|base64|dataUrl|bytes/i.test(key) ? "[omitted]" : item);
      return compact.length > 600 ? `${compact.slice(0, 600)}...` : compact;
    };
    const line = `${new Date().toISOString()} stage=${stage} ${Object.entries({ build: loadedBuildId, ...auditContext, ...details }).map(([key, value]) => `${key}=${safeValue(value)}`).join(" ")}`.trim();
    auditLines.push(line);
    if (report && typeof report.append === "function" && typeof document.createTextNode === "function") {
      report.append(document.createTextNode(`${report.textContent ? "\n" : ""}${line}`));
    } else {
      render([planSummary(activeRunPlan || materialPlan), "", ...auditLines].join("\n"));
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!running || message?.runToken !== runToken) return;
    if (message.type === "DOUDIAN_WASH_LINK_SCAN_PROGRESS") {
      updateStatus(`正在扫描第 ${message.segment} 段 SKU（第 ${message.pass}/${message.totalPasses} 轮），请勿手动滚动、切换标签或点击发布`, "running");
      return;
    }
    if (message.type === "DOUDIAN_WASH_LINK_TARGET_STABLE_PROGRESS") {
      updateStatus(`正在等待目标规格稳定：${message.targetSpecification}（第 ${message.stableCount}/${message.requiredStableReads} 次），请勿手动滚动、切换标签或点击发布`, "running");
    }
  });

  function fail(code, message, evidence) {
    const error = new Error(message);
    error.code = code;
    error.evidence = evidence || null;
    throw error;
  }

  function assertReady() {
    if (paused) fail("UPDATE_PAUSED", "已暂停，当前安全操作完成后不会继续。", {});
  }

  function modeBusy(mode) {
    if (mode === "create") {
      return ["running", "paused", "parsing"].includes(createStatus?.dataset?.state);
    }
    if (mode === "update") return running || paused;
    if (mode === "image-text") {
      return ["running", "paused", "parsing", "validating"].includes(imageTextStatus?.dataset?.state) ||
        /执行中|解析中|校验中/.test(String(imageTextStatus?.textContent || ""));
    }
    return false;
  }

  function setMode(mode) {
    if (!Object.hasOwn(modePanels, mode)) return false;
    const currentMode = document.body.dataset.panelMode || "create";
    if (mode !== currentMode && modeBusy(currentMode)) return false;
    document.body.dataset.panelMode = mode;
    for (const [name, panel] of Object.entries(modePanels)) {
      if (!panel) continue;
      const selected = name === mode;
      panel.hidden = !selected;
      panel.setAttribute("aria-hidden", selected ? "false" : "true");
    }
    for (const button of modeButtons) {
      const selected = button.dataset.panelMode === mode;
      button.setAttribute("aria-selected", selected ? "true" : "false");
      button.classList.toggle("is-selected", selected);
      button.tabIndex = selected ? 0 : -1;
    }
    return true;
  }

  function moveModeFocus(button, event) {
    const key = event.key;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
    const index = modeButtons.indexOf(button);
    if (index < 0 || modeButtons.length === 0) return;
    event.preventDefault();
    const nextIndex = key === "Home"
      ? 0
      : key === "End"
        ? modeButtons.length - 1
        : (index + (key === "ArrowRight" ? 1 : -1) + modeButtons.length) % modeButtons.length;
    const target = modeButtons[nextIndex];
    if (setMode(target.dataset.panelMode)) target.focus();
  }

  function selectedOffsaleScope() {
    return document.querySelector('input[name="updateOffsaleScope"]:checked')?.value || "batch";
  }

  function selectedReplaceScope() {
    return document.querySelector('input[name="updateReplaceScope"]:checked')?.value || "batch";
  }

  function selectedReplaceModules() {
    return Object.freeze({
      priceInventory: priceInventoryEnabled?.checked === true,
      skuImages: skuImagesEnabled?.checked === true
    });
  }

  function replaceScopeLabel(scope = selectedReplaceScope()) {
    if (scope === "query") return "商品查询结果";
    if (scope === "current") return "当前商品编辑页";
    return "当前商品分组与筛选结果";
  }

  function readableListHref(value) {
    try {
      const url = new URL(value);
      return `${url.pathname}${url.search ? "（已保留页面筛选参数）" : ""}`;
    } catch (_) {
      return "当前商品管理页";
    }
  }

  function setScopeLink(scope = selectedReplaceScope(), snapshot = null, query = "") {
    if (!scopeLink) return;
    if (scope === "current") {
      scopeLink.textContent = "执行目标：当前商品编辑页";
      scopeLink.removeAttribute("href");
      scopeLink.removeAttribute("title");
      return;
    }
    const href = snapshot?.result?.filterUrl || snapshot?.filterUrl;
    if (href) {
      scopeLink.href = href;
      scopeLink.title = href;
      scopeLink.textContent = scope === "query"
        ? `已锁定查询结果链接：${readableListHref(href)}（查询：${query}）`
        : `已锁定商品分组与筛选链接：${readableListHref(href)}`;
      return;
    }
    scopeLink.removeAttribute("title");
    scopeLink.textContent = scope === "query"
      ? "将在当前商品管理页查询并锁定结果链接"
      : "将保留当前商品分组与筛选链接";
  }

  async function showCurrentListScopeLink(scope = selectedReplaceScope()) {
    if (scope === "current" || running || !globalThis.chrome?.tabs?.query) return;
    const revision = ++scopeLinkRevision;
    try {
      const [tab] = await globalThis.chrome.tabs.query({ active: true, currentWindow: true });
      const url = new URL(tab?.url || "https://invalid.invalid");
      if (revision !== scopeLinkRevision || !contract?.isProductManagementListUrl?.(url.href)) return;
      setScopeLink(scope, { filterUrl: url.href }, scope === "query" ? String(productQueryInput?.value || "").trim() : "");
    } catch (_) {}
  }

  function refreshReplaceScopeUi() {
    const washMode = updateSubmode === "wash";
    const replaceScopeControls = [...document.querySelectorAll('input[name="updateReplaceScope"]')];
    for (const control of replaceScopeControls) {
      const isCurrent = control.value === "current";
      control.disabled = washMode ? !isCurrent || running : running;
      if (washMode && isCurrent) control.checked = true;
    }
    const queryScope = selectedReplaceScope() === "query";
    if (productQueryField) productQueryField.hidden = !queryScope;
    if (productQueryInput) productQueryInput.disabled = !queryScope || running;
    setScopeLink();
    void showCurrentListScopeLink();
  }

  function refreshCurrentContinuationUi() {
    if (!continueCurrentButton) return;
    const modules = selectedReplaceModules();
    const currentScope = updateSubmode === "replace" && selectedReplaceScope() === "current";
    continueCurrentButton.hidden = !currentScope;
    continueCurrentButton.disabled = !currentScope || running || !materialPlan ||
      !modules.priceInventory || materialPlan.priceInventory?.intent !== "replace_group";
  }

  function selectedImageSwapScope() {
    return document.querySelector('input[name="updateImageSwapScope"]:checked')?.value || "batch";
  }

  function offsalePlan() {
    const specifications = contract.parseOffsaleSpecifications(offsaleSpecifications?.value || "");
    return Object.freeze({
      intent: "delete_spec_values",
      specifications,
      planDigest: contract.stableDigest({ intent: "delete_spec_values", specifications })
    });
  }

  function refreshUpdateRunButton() {
    refreshCurrentContinuationUi();
    if (!runButton) return;
    if (running) {
      runButton.disabled = true;
      return;
    }
    if (["replace", "wash"].includes(updateSubmode)) {
      const scope = selectedReplaceScope();
      runButton.textContent = updateSubmode === "wash"
        ? (pendingWashReview && scope === "current" ? "已生成清单，请使用下方分步按钮" : (scope === "current" ? "核实当前商品规格" : "洗链接当前分组与筛选商品"))
        : scope === "current"
          ? "替换当前商品的价格库存"
        : scope === "query"
          ? "查询并替换匹配商品"
          : "确认并替换当前分组与筛选商品";
      const modules = selectedReplaceModules();
      runButton.disabled = (updateSubmode === "wash" && !!pendingWashReview) || !materialPlan || (!modules.priceInventory && !modules.skuImages) ||
        (scope === "query" && !String(productQueryInput?.value || "").trim());
      return;
    }
    if (updateSubmode === "image-swap") {
      runButton.textContent = selectedImageSwapScope() === "current" ? "更换当前商品的匹配 SKU 图" : "更换全部筛选商品的匹配 SKU 图";
      runButton.disabled = !imageSwapPlan;
      return;
    }
    runButton.textContent = selectedOffsaleScope() === "current" ? "删除当前商品的匹配规格" : "下架全部筛选商品的匹配规格";
    try {
      offsalePlan();
      runButton.disabled = false;
    } catch (_) {
      runButton.disabled = true;
    }
  }

  function setUpdateSubmode(mode) {
    if (!Object.hasOwn(updateSubmodePanels, mode) || running) return false;
    updateSubmode = mode;
    if (mode !== "wash") {
      pendingWashReview = null;
      clearWashReview();
    }
    if (washSortReminder) washSortReminder.hidden = mode !== "wash";
    for (const [name, panel] of Object.entries(updateSubmodePanels)) {
      if (!panel) continue;
      if (panel === updateSubmodePanels[mode] && name !== mode) continue;
      const selected = name === mode;
      panel.hidden = !selected;
      panel.setAttribute("aria-hidden", selected ? "false" : "true");
    }
    for (const button of updateSubmodeButtons) {
      const selected = button.dataset.updateSubmode === mode;
      button.setAttribute("aria-selected", selected ? "true" : "false");
      button.classList.toggle("is-selected", selected);
      button.tabIndex = selected ? 0 : -1;
    }
    if (updateHeading) updateHeading.textContent = ["replace", "wash"].includes(mode)
      ? (mode === "wash" ? "洗链接" : "批量替换已有商品")
      : mode === "offsale"
        ? "批量下架商品规格"
        : "批量更换 SKU 图";
    refreshRecoveryUi();
    refreshReplaceScopeUi();
    refreshCurrentContinuationUi();
    refreshUpdateRunButton();
    updateStatus(["replace", "wash"].includes(mode)
      ? (materialPlan ? "材料已冻结，可以执行" : "等待材料")
      : mode === "offsale"
        ? "输入要下架的规格"
        : (imageSwapPlan ? "图片已冻结，可以执行" : "选择新 SKU 图"), "idle");
    return true;
  }

  function planSummary(plan = materialPlan) {
    if (plan?.intent === "delete_spec_values") {
      return [
        `规格下架：${plan.specifications.length} 个目标规格`,
        ...plan.specifications.map((specification) => `- ${specification}`),
        "精确匹配；不存在则跳过，歧义立即阻断。",
      "实际删除并确认平台发布成功后自动关闭编辑页；无匹配直接关闭，故障时保留编辑页待检查。",
        `计划摘要：${plan.planDigest}`
      ].join("\n");
    }
    if (plan?.intent === "replace_sku_images") {
      return [
        `换SKU图：已冻结 ${plan.images.length} 张`,
        `匹配模式：${plan.matchMode === "quantity" ? "含数量" : "规格尺寸与颜色"}`,
        "每个商品按当前规格重新匹配；无匹配图跳过。",
      "有图本地替换，无图本地上传；实际换图并确认平台发布成功后自动关闭编辑页，无匹配直接关闭，故障时保留。",
        `计划摘要：${plan.planDigest}`
      ].join("\n");
    }
    const price = plan?.priceInventory;
    const images = plan?.skuImages;
    const skuImages = images?.intent === "replace_sku_images"
      ? `已冻结 ${images.images.length} 张，匹配模式：${images.matchMode === "quantity" ? "含数量" : "规格尺寸与颜色"}`
      : "未启用";
    if (updateSubmode === "wash") {
      return [
        `洗链接：已冻结 ${price?.rows?.length || 0} 行 SKU`,
        "旧 SKU 匹配键：尺寸、张数、卷数/箱规；重复型号按页面与 Excel 顺序一对一对应。",
        "清单核实后，“新增规格”和“修改已有 SKU”可任意顺序分别点击。新增 SKU 按 Excel 填写价格、商家编码，库存固定为 999；旧 SKU 只改价格和商家编码，不读取或修改库存。",
        "旧 SKU 的规格文字与【】标签保持页面原样。Excel 中不存在的旧 SKU 只列入待删除清单，由你最后手动点击页面删除图标。",
        "完成后不发布，保留编辑页并提醒你到右侧手动自定义排序。",
        `计划摘要：${plan?.planDigest || "-"}`
      ].join("\n");
    }
    return [
      `价格库存：${price?.intent === "replace_group" ? (updateSubmode === "wash" ? `洗链接原地处理 ${price.rows.length} 行` : `整组重建 ${price.rows.length} 行`) : "未启用"}`,
      `SKU 图：${skuImages}`,
      "SKU 图片按原文件名规则匹配：已有图本地替换，无图本地上传；无匹配图跳过。",
      "成功后不发布并保留编辑页；故障编辑页保留待检查。",
      `计划摘要：${plan?.planDigest || "-"}`
    ].join("\n");
  }

  function washReviewText(value) {
    return String(value ?? "").trim() || "未填写";
  }

  function washReviewPlan(initial, plan) {
    return contract.planWashLinkReview(initial?.result?.skuRows || [], plan.priceInventory.rows || []);
  }

  function clearWashReview() {
    displayedWashReview = null;
    washReviewFilter = null;
    if (washReviewSection) washReviewSection.hidden = true;
    if (washReviewFilters) washReviewFilters.replaceChildren();
    if (washReviewList) washReviewList.replaceChildren();
    if (washReviewActions) washReviewActions.hidden = true;
  }

  function washReviewDetail(row, manualDeletion) {
    if (row.status === "待删除") {
      return manualDeletion
        ? "Excel 中没有该型号，请在页面确认后手动点击删除图标。"
        : "Excel 中没有该型号，修改与新增完成后由你手动删除。";
    }
    if (row.status === "新增") {
      return `Excel：价格 ${washReviewText(row.target?.price)}；库存 999；商家编码 ${washReviewText(row.target?.merchantCode)}。`;
    }
    if (row.status === "未修改") return "规格、价格和商家编码均与 Excel 一致。";
    const changes = [];
    if (!row.priceSame) changes.push(`价格 ${washReviewText(row.current?.price)} → ${washReviewText(row.target?.price)}`);
    if (!row.merchantCodeSame) changes.push("商家编码需同步");
    return changes.join("；") || "规格文字保持页面原样。";
  }

  function renderWashReview(review, productId, { phase = "review", addComplete = false, modifyComplete = false } = {}) {
    if (!washReviewSection || !washReviewList) return;
    displayedWashReview = Object.freeze({ review, productId, phase, addComplete, modifyComplete });
    washReviewSection.hidden = false;
    washReviewSection.dataset.phase = phase;
    const manualDeletion = phase === "manual_deletion";
    if (washReviewActions) washReviewActions.hidden = manualDeletion;
    if (washReviewHeading) washReviewHeading.textContent = manualDeletion ? "最后一步：待手动删除规格" : "规格核实清单";
    if (washReviewHelp) {
      washReviewHelp.textContent = manualDeletion
        ? "修改与新增已经完成。请按页面顺序核对后，在页面手动点击删除图标。"
        : "新增与修改可任意顺序，分别手动点击。旧 SKU 的规格文字与【】标签不会修改；待删除规格仍由你最后手动处理。";
    }
    const counts = review.rows.reduce((result, row) => {
      result[row.status] = (result[row.status] || 0) + 1;
      return result;
    }, {});
    const statuses = manualDeletion ? ["待删除"] : ["未修改", "修改", "新增", "待删除"];
    if (!statuses.includes(washReviewFilter)) washReviewFilter = null;
    if (washReviewFilters) {
      washReviewFilters.replaceChildren();
      for (const statusName of statuses) {
        const filter = document.createElement("button");
        filter.type = "button";
        filter.className = "wash-review-filter";
        filter.dataset.washReviewFilter = statusName;
        filter.dataset.state = statusName;
        filter.setAttribute("aria-pressed", String(washReviewFilter === statusName));
        filter.textContent = `${statusName} ${counts[statusName] || 0}`;
        washReviewFilters.append(filter);
      }
    }
    const visibleRows = washReviewFilter
      ? review.rows.filter((row) => row.status === washReviewFilter)
      : review.rows;
    if (washReviewSummary) {
      washReviewSummary.textContent = washReviewFilter
        ? `正在显示“${washReviewFilter}” ${visibleRows.length} 条，再次点击该按钮可显示全部。`
        : `显示全部 ${visibleRows.length} 条。`;
    }
    const matchedCount = (counts["修改"] || 0) + (counts["未修改"] || 0);
    if (washAddButton) {
      washAddButton.textContent = addComplete ? "新增已完成" : `新增规格 ${counts["新增"] || 0}`;
      washAddButton.disabled = running || addComplete;
    }
    if (washModifyButton) {
      washModifyButton.textContent = modifyComplete ? "已有 SKU 已修改" : `修改已有 SKU ${matchedCount}`;
      washModifyButton.disabled = running || modifyComplete || matchedCount === 0;
    }
    washReviewList.replaceChildren();
    for (const row of visibleRows) {
      const item = document.createElement("article");
      item.className = "wash-review-row";
      item.dataset.reviewIndex = String(row.order);
      const copy = document.createElement("div");
      copy.className = "wash-review-copy";
      const status = document.createElement("span");
      status.className = "wash-review-status";
      status.dataset.state = row.status;
      status.textContent = row.status;
      const title = document.createElement("strong");
      title.textContent = `${row.order + 1}. ${washReviewText(row.current?.specification || row.target?.specification)}`;
      const detail = document.createElement("small");
      detail.textContent = washReviewDetail(row, manualDeletion);
      copy.append(status, title, detail);
      item.append(copy);
      washReviewList.append(item);
    }
  }

  function summaryView(summary) {
    if (summary.state === "running") return { label: "处理中", badgeState: "running" };
    if (summary.state === "phase_pending") return { label: "待继续", badgeState: "idle" };
    if (summary.state === "replace_completed") return { label: "替换完成", badgeState: "ready" };
    if (summary.state === "publish_confirmed") return { label: "发布成功", badgeState: "ready" };
    if (summary.state === "publish_unknown") return { label: "结果未知待检查", badgeState: "blocked" };
    if (summary.state === "blocked") return { label: "修改失败待检查", badgeState: "blocked" };
    if (summary.state === "skipped") return { label: "无匹配修改已跳过", badgeState: "idle" };
    if (summary.state === "paused") return { label: "已暂停", badgeState: "idle" };
    return { label: "等待处理", badgeState: "idle" };
  }

  function renderProductSummaries() {
    if (!results) return;
    results.replaceChildren();
    for (const summary of [...productSummaries.values()].sort((left, right) => left.index - right.index)) {
      const view = summaryView(summary);
      const row = document.createElement("article");
      row.className = "update-result-row";
      row.dataset.state = summary.state;
      const copy = document.createElement("span");
      copy.className = "update-result-copy";
      const id = document.createElement("strong");
      id.textContent = `${String(summary.index + 1).padStart(2, "0")} · 商品ID：${summary.productId}`;
      const title = document.createElement("small");
      title.textContent = summary.title || "未读取商品标题";
      const detail = document.createElement("small");
      detail.className = "update-result-meta";
      detail.textContent = summary.detail;
      copy.append(id, title, detail);
      const badge = document.createElement("span");
      badge.className = "status-badge";
      badge.dataset.state = view.badgeState;
      badge.textContent = view.label;
      row.append(copy, badge);
      results.append(row);
    }
    if (stats) {
      const values = [...productSummaries.values()];
      const counts = {
        total: values.length,
        replaced: values.filter((item) => item.state === "replace_completed").length,
        done: values.filter((item) => item.state === "publish_confirmed").length,
        running: values.filter((item) => item.state === "running").length,
        pending: values.filter((item) => item.state === "phase_pending").length,
        blocked: values.filter((item) => ["blocked", "publish_unknown"].includes(item.state)).length,
        skipped: values.filter((item) => item.state === "skipped").length
      };
      stats.hidden = counts.total === 0;
      stats.innerHTML = [["总数", counts.total], ["处理中", counts.running], ["待继续", counts.pending], ["替换完成", counts.replaced], ["发布成功", counts.done], ["待检查", counts.blocked], ["跳过", counts.skipped]]
        .map(([label, count]) => `<span>${label}<strong>${count}</strong></span>`).join("");
    }
  }

  function resetProductSummaries(products) {
    productSummaries = new Map(products.map((product, index) => [product.productId, {
      productId: product.productId,
      title: product.title,
      index,
      state: "waiting",
      detail: "等待处理，尚未写入页面"
    }]));
    renderProductSummaries();
  }

  function updateProductSummary(product, patch) {
    productSummaries.set(product.productId, { ...productSummaries.get(product.productId), ...patch });
    renderProductSummaries();
  }

  function productFailureView(caught, stage = "修改") {
    const code = caught?.code || "UPDATE_PRODUCT_FAILED";
    const outcomeUnknown = caught?.evidence?.outcomeUnknown === true || code === "UPDATE_PUBLISH_OUTCOME_UNKNOWN";
    const publishFailure = /^UPDATE_PUBLISH_/.test(code);
    const baseReason = String(caught?.message || caught || "未知错误");
    const checkpointDifferences = Array.isArray(caught?.evidence?.differences) && caught.evidence.differences.length
      ? ` 核对差异：${caught.evidence.differences.join("；")}`
      : "";
    const reason = `${baseReason}${checkpointDifferences}`;
    const advice = caught?.evidence?.fix || (outcomeUnknown
      ? "人工查看该商品当前状态，确认前不要再次发布。"
      : publishFailure
        ? "查看编辑页中的平台提示，修正后重新执行该商品。"
        : "检查保留的编辑页与材料，修正后重新执行该商品。");
    return Object.freeze({
      state: outcomeUnknown ? "publish_unknown" : "blocked",
      detail: `${stage}失败：${reason} 建议：${advice}`,
      code,
      outcomeUnknown,
      advice
    });
  }

  function updateProductFailureSummary(product, caught, stage) {
    const view = productFailureView(caught, stage);
    updateProductSummary(product, { state: view.state, detail: view.detail });
    return view;
  }

  async function askProductFailureDecision(product, caught, stage, { canSkip = false } = {}) {
    const view = productFailureView(caught, stage);
    const readbackMismatch = caught?.code === "UPDATE_WASH_LINK_ROW_READBACK_FAILED";
    const message = readbackMismatch
      ? `商品 ${product.productId} 的 SKU 已尝试修改，但页面回读与 Excel 不一致。请先查看编辑页中的规格、价格、库存和商家编码。`
      : `商品 ${product.productId} 在${stage}时出现问题，编辑页已保留。`;
    const advice = readbackMismatch
      ? "系统要问你：页面当前值是否已经符合 Excel？在你确认前，插件不会重试、保存或发布。"
      : `系统要问你：是否停止并检查当前商品？${canSkip ? "也可以明确跳过当前商品，继续后续商品。" : ""}`;
    if (!failureDialog?.showModal || !failureTitle || !failureMessage || !failureAdvice || !failureStopButton || !failureSkipButton) {
      return canSkip && globalThis.confirm?.(`${message}\n\n${advice}\n\n点击“确定”跳过当前商品并继续后续商品；点击“取消”停止。`) ? "skip" : "stop";
    }
    failureTitle.textContent = view.outcomeUnknown ? "结果待你确认" : "需要你决定如何处理";
    failureMessage.textContent = message;
    failureAdvice.textContent = advice;
    failureStopButton.textContent = canSkip ? "停止并检查当前商品" : "关闭并检查当前商品";
    failureSkipButton.hidden = !canSkip;
    failureSkipButton.disabled = !canSkip;
    if (failureDialog.open) failureDialog.close("stop");
    return new Promise((resolve) => {
      failureDialog.addEventListener("close", () => {
        resolve(canSkip && failureDialog.returnValue === "skip" ? "skip" : "stop");
      }, { once: true });
      failureDialog.showModal();
    });
  }

  function completedMutationReceipt(evidence) {
    if (!evidence?.commandId || !evidence?.argsDigest) return null;
    return Object.freeze({ commandId: evidence.commandId, argsDigest: evidence.argsDigest });
  }

  async function readPublishLedger() {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage?.get) fail("UPDATE_PUBLISH_LEDGER_UNAVAILABLE", "发布防重记录不可用，未点击发布。", {
      dispatched: false,
      fix: "重新加载插件后刷新商品编辑页，再重新执行该商品。"
    });
    const stored = await storage.get(contract.PUBLISH_STORAGE_KEY);
    return Array.isArray(stored?.[contract.PUBLISH_STORAGE_KEY]) ? stored[contract.PUBLISH_STORAGE_KEY] : [];
  }

  async function priorPublishReceipt(intentDigest, modificationDigest) {
    const blockedStatuses = new Set(["dispatching", "unknown", "dispatched_unverified", "confirmed_success"]);
    return (await readPublishLedger()).find((entry) =>
      entry?.intentDigest === intentDigest &&
      entry?.modificationDigest === modificationDigest &&
      blockedStatuses.has(entry?.status)) || null;
  }

  async function savePublishReceipt(entry) {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage?.set) fail("UPDATE_PUBLISH_LEDGER_UNAVAILABLE", "发布防重记录不可用，未点击发布。", {
      dispatched: false,
      fix: "重新加载插件后刷新商品编辑页，再重新执行该商品。"
    });
    const ledger = await readPublishLedger();
    const next = [...ledger.filter((item) => item?.intentDigest !== entry.intentDigest), Object.freeze({ ...entry })].slice(-500);
    await storage.set({ [contract.PUBLISH_STORAGE_KEY]: next });
    const saved = (await readPublishLedger()).find((item) =>
      item?.intentDigest === entry.intentDigest &&
      item?.modificationDigest === entry.modificationDigest &&
      item?.status === entry.status);
    if (!saved) fail("UPDATE_PUBLISH_LEDGER_PERSIST_FAILED", "发布防重记录保存后未通过精确回读。", {
      dispatched: false,
      intentDigest: entry.intentDigest,
      modificationDigest: entry.modificationDigest,
      expectedStatus: entry.status,
      fix: "重新加载插件后检查浏览器存储权限，再重新执行该商品。"
    });
    return saved;
  }

  async function closePublishedEditTab(tab, product, publication) {
    const tabId = Number(tab?.id);
    const productId = String(product?.productId || "");
    const confirmedSuccess = publication?.state === "confirmed_success" && publication?.confirmed === true;
    const confirmedNoMatch = publication?.state === "skipped" && publication?.noMatch === true && publication?.actionCount === 0;
    if (!confirmedSuccess && !confirmedNoMatch) {
      audit("published_edit_tab_close_blocked", {
        productId,
        tabId: Number.isInteger(tabId) ? tabId : null,
        publicationState: publication?.state || null,
        confirmed: publication?.confirmed === true
      });
      return Object.freeze({
        state: "retained",
        tabId: Number.isInteger(tabId) ? tabId : null,
        code: "UPDATE_PUBLISH_CONFIRMATION_REQUIRED",
        message: "未确认平台发布成功，编辑页已保留"
      });
    }
    try {
      if (!Number.isInteger(tabId) || !/^\d{8,}$/.test(productId)) {
        throw Object.assign(new Error("待关闭编辑页缺少有效的标签或商品身份。"), { code: "UPDATE_PUBLISHED_TAB_IDENTITY_INVALID" });
      }
      const current = await chrome.tabs.get(tabId);
      const url = new URL(String(current?.url || ""));
      const editRoute = /^\/ffa\/g\/(?:create|edit)(?:\/|$)/.test(url.pathname);
      const originalEditIdentity = editRoute && url.searchParams.get("product_id") === productId;
      let successPageIdentity = confirmedSuccess && publication?.confirmation?.successPage === true &&
        String(publication.confirmation.url || "") === String(current?.url || "");
      if (!originalEditIdentity && !successPageIdentity && publication?.confirmation &&
        url.origin === "https://fxg.jinritemai.com") {
        const liveSuccessPage = await inspectPublishSuccessPage(tabId).catch(() => null);
        successPageIdentity = liveSuccessPage?.successPage === true &&
          String(liveSuccessPage.url || "") === String(current?.url || "");
      }
      if (current?.id !== tabId || url.origin !== "https://fxg.jinritemai.com" || (!originalEditIdentity && !successPageIdentity)) {
        throw Object.assign(new Error("发布后的标签页身份已变化，未自动关闭。"), { code: "UPDATE_PUBLISHED_TAB_IDENTITY_MISMATCH" });
      }
      await chrome.tabs.remove(tabId);
      audit(confirmedNoMatch ? "unmatched_edit_tab_closed" : "published_edit_tab_closed", { productId, tabId });
      return Object.freeze({
        state: "closed",
        tabId,
        message: confirmedNoMatch ? "未匹配到目标 SKU，编辑页已关闭" : "平台已确认发布成功，编辑页已关闭"
      });
    } catch (caught) {
      const code = caught?.code || "UPDATE_PUBLISHED_TAB_CLOSE_FAILED";
      audit("published_edit_tab_close_failed", {
        productId,
        tabId: Number.isInteger(tabId) ? tabId : null,
        code,
        message: caught?.message || String(caught),
        remediation: confirmedNoMatch ? "未匹配到目标 SKU，请手动关闭对应商品编辑页" : "平台已确认发布成功，请手动关闭对应商品编辑页"
      });
      return Object.freeze({
        state: "failed",
        tabId: Number.isInteger(tabId) ? tabId : null,
        code,
        message: confirmedNoMatch ? "未匹配到目标 SKU，标签关闭失败，请手动关闭" : "平台已确认发布成功，标签关闭失败，请手动关闭"
      });
    }
  }

  async function inspectPublishSuccessPage(tabId) {
    const current = await chrome.tabs.get(tabId);
    const currentUrl = new URL(String(current?.url || ""));
    if (current?.id !== tabId || currentUrl.origin !== "https://fxg.jinritemai.com") return null;
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: (expectedTitle) => {
        const normalize = (value) => String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
        const visible = (node) => {
          const style = getComputedStyle(node);
          return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 &&
            (node.getClientRects().length > 0 || style.position === "fixed");
        };
        const expected = normalize(expectedTitle);
        const match = [...document.querySelectorAll('h1,h2,h3,h4,p,span,[class*="title"],[class*="Title"]')]
          .find((node) => visible(node) && normalize(node.textContent) === expected);
        return match ? { successPage: true, title: expectedTitle, url: location.href } : null;
      },
      args: [PUBLISH_SUCCESS_TITLE]
    });
    const evidence = injected?.[0]?.result;
    if (evidence?.successPage !== true || evidence.title !== PUBLISH_SUCCESS_TITLE ||
      String(evidence.url || "") !== String(current?.url || "")) return null;
    return Object.freeze({
      source: "navigation_success_page",
      feedback: PUBLISH_SUCCESS_TITLE,
      successPage: true,
      title: PUBLISH_SUCCESS_TITLE,
      url: String(evidence.url)
    });
  }

  async function confirmPublishSuccessAfterNavigation(tabId, beforeUrl) {
    let before;
    try {
      before = new URL(String(beforeUrl || ""));
    } catch (_) {
      return null;
    }
    if (before.origin !== "https://fxg.jinritemai.com" ||
      !/^\/ffa\/g\/(?:create|edit)(?:\/|$)/.test(before.pathname) ||
      !/^\d{8,}$/.test(before.searchParams.get("product_id") || "")) return null;
    const deadline = Date.now() + PUBLISH_NAVIGATION_CONFIRMATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const current = await chrome.tabs.get(tabId);
        if (current?.id !== tabId) return null;
        if (String(current?.url || "") !== before.href) {
          const successPage = await inspectPublishSuccessPage(tabId);
          if (successPage) return successPage;
        }
      } catch (_) {
        // Navigation can temporarily make the document unavailable; retry within the short confirmation window.
      }
      await new Promise((resolve) => setTimeout(resolve, PUBLISH_NAVIGATION_POLL_MS));
    }
    return null;
  }

  async function publishModifiedProduct(tab, documentToken, product, plan, mode, receipt) {
    const actionCount = Number(receipt?.actionCount || 0);
    const mutationReceipts = Array.from(receipt?.mutationReceipts || []).filter(Boolean);
    if (actionCount < 1) {
      const skipped = Object.freeze({
        state: "skipped",
        productId: product.productId,
        actionCount: 0,
        noMatch: receipt?.noMatch === true
      });
      const tabClose = await closePublishedEditTab(tab, product, skipped);
      audit("product_no_change_skipped", {
        productId: product.productId,
        mode,
        actionCount: 0,
        noMatch: skipped.noMatch,
        tabClose
      });
      return Object.freeze({ ...skipped, tabClose });
    }
    const activePublishTab = await activateTaskTab(tab, "UPDATE_PUBLISH_FOREGROUND_TIMEOUT", `商品 ${product.productId} 发布前编辑页`);
    const args = contract.createProductPublishArgs({
      productId: product.productId,
      planDigest: plan.planDigest,
      mode,
      actionCount,
      mutationReceipts
    });
    const publishMessage = contract.createMessage(runToken, contract.COMMANDS.PUBLISH_PRODUCT, args, documentToken);
    const beforePublishUrl = String(activePublishTab?.url || tab?.url || "");
    const prior = await priorPublishReceipt(args.intentDigest, args.modificationDigest);
    if (prior) {
      audit("product_publish_replay_blocked", {
        productId: product.productId,
        mode,
        intentDigest: args.intentDigest,
        modificationDigest: args.modificationDigest,
        priorModificationDigest: prior.modificationDigest,
        priorStatus: prior.status,
        reason: "same_modification"
      });
      fail("UPDATE_PUBLISH_ALREADY_ATTEMPTED", `商品 ${product.productId} 的同一次修改已有发布记录，禁止自动重复发布。`, {
        dispatched: prior.status !== "dispatching" ? true : null,
        outcomeUnknown: true,
        priorStatus: prior.status,
        intentDigest: args.intentDigest,
        modificationDigest: args.modificationDigest,
        priorModificationDigest: prior.modificationDigest,
        sameModification: true,
        fix: "人工确认本次修改的发布状态；不要重复发布同一次修改。重新完成修改后，新修改回执可再次进入发布。"
      });
    }
    const baseReceipt = Object.freeze({
      productId: product.productId,
      planDigest: plan.planDigest,
      mode,
      intentDigest: args.intentDigest,
      modificationDigest: args.modificationDigest,
      updatedAt: Date.now()
    });
    await savePublishReceipt({ ...baseReceipt, status: "dispatching" });
    let evidence;
    try {
      evidence = await send(tab.id, contract.COMMANDS.PUBLISH_PRODUCT, args, documentToken);
    } catch (caught) {
      const beforeDispatch = caught?.evidence?.dispatched === false;
      const confirmedFailure = caught?.evidence?.dispatched === true && caught?.evidence?.outcomeUnknown === false;
      const navigationConfirmation = !beforeDispatch && !confirmedFailure && caught?.evidence?.outcomeUnknown === true
        ? await confirmPublishSuccessAfterNavigation(tab.id, beforePublishUrl)
        : null;
      if (navigationConfirmation) {
        evidence = Object.freeze({
          commandId: publishMessage.commandId,
          argsDigest: publishMessage.argsDigest,
          result: Object.freeze({
            state: "confirmed_success",
            productId: product.productId,
            mode,
            actionCount,
            modificationDigest: args.modificationDigest,
            commandId: publishMessage.commandId,
            argsDigest: publishMessage.argsDigest,
            dispatched: true,
            confirmed: true,
            confirmation: navigationConfirmation,
            reason: "发布消息因成功页跳转断连，但已在同一标签页精确确认平台成功页。"
          })
        });
        audit("product_publish_navigation_confirmed", {
          productId: product.productId,
          tabId: tab.id,
          beforeUrl: beforePublishUrl,
          successUrl: navigationConfirmation.url,
          commandId: publishMessage.commandId
        });
      }
      if (!navigationConfirmation) {
        await savePublishReceipt({
          ...baseReceipt,
          status: beforeDispatch ? "failed_before_dispatch" : confirmedFailure ? "confirmed_failed" : "unknown",
          errorCode: caught?.code || "UPDATE_PUBLISH_OUTCOME_UNKNOWN",
          updatedAt: Date.now()
        }).catch(() => {});
        if (!beforeDispatch && !confirmedFailure) {
          caught.code = "UPDATE_PUBLISH_OUTCOME_UNKNOWN";
          caught.evidence = {
            ...(caught.evidence || {}),
            dispatched: caught?.evidence?.dispatched ?? null,
            outcomeUnknown: true,
            fix: "人工查看该商品当前状态，确认前不要再次发布。"
          };
        }
        throw caught;
      }
    }
    const result = evidence.result || {};
    if (result.state !== "confirmed_success" || result.confirmed !== true || result.productId !== product.productId ||
      result.commandId !== evidence.commandId || result.argsDigest !== evidence.argsDigest) {
      await savePublishReceipt({
        ...baseReceipt,
        status: "unknown",
        commandId: evidence.commandId || null,
        argsDigest: evidence.argsDigest || null,
        errorCode: "UPDATE_PUBLISH_RECEIPT_INVALID",
        updatedAt: Date.now()
      }).catch(() => {});
      fail("UPDATE_PUBLISH_RECEIPT_INVALID", `商品 ${product.productId} 的发布派发回执不完整。`, {
        dispatched: true,
        outcomeUnknown: true,
        receipt: result,
        fix: "人工查看该商品当前状态，确认前不要再次发布。"
      });
    }
    try {
      await savePublishReceipt({
        ...baseReceipt,
        status: "confirmed_success",
        commandId: evidence.commandId,
        argsDigest: evidence.argsDigest,
        confirmation: result.confirmation || null,
        updatedAt: Date.now()
      });
    } catch (caught) {
      fail("UPDATE_PUBLISH_OUTCOME_UNKNOWN", `商品 ${product.productId} 已派发发布，但防重回执保存失败。`, {
        dispatched: true,
        outcomeUnknown: true,
        causeCode: caught?.code || "UPDATE_PUBLISH_LEDGER_PERSIST_FAILED",
        fix: "人工查看该商品当前状态，确认前不要再次发布。"
      });
    }
    const tabClose = await closePublishedEditTab(tab, product, result);
    audit("product_publish_confirmed", {
      productId: product.productId,
      mode,
      actionCount,
      commandId: evidence.commandId,
      argsDigest: evidence.argsDigest,
      verification: "platform_success_feedback",
      tabClose
    });
    return Object.freeze({
      ...result,
      publishStatus: "confirmed_success",
      intentDigest: args.intentDigest,
      modificationDigest: args.modificationDigest,
      tabClose
    });
  }

  function createBatchCheckpoint(frozen, plan) {
    return Object.freeze({
      schemaVersion: contract.RECOVERY_SCHEMA_VERSION,
      buildId: loadedBuildId,
      planDigest: plan.planDigest,
      filterUrl: frozen.filterUrl,
      total: frozen.total,
      pageCount: frozen.pageCount,
      products: Object.freeze(frozen.entries.map((product) => Object.freeze({
        productId: String(product.productId),
        title: product.title || "",
        status: product.status || "",
        pageNo: Number(product.pageNo)
      }))),
      completedProductIds: Object.freeze([]),
      completedSessions: Object.freeze([]),
      nextIndex: 0,
      currentProductId: null,
      mutationStarted: false,
      outcomeUnknown: false,
      retrySafety: "safe_retry"
    });
  }

  function updateBatchCheckpoint(patch) {
    if (!activeBatchCheckpoint) return null;
    activeBatchCheckpoint = Object.freeze({ ...activeBatchCheckpoint, ...patch, updatedAt: Date.now() });
    return activeBatchCheckpoint;
  }

  function recoveryButtonLabel(decision) {
    if (decision.code === "UPDATE_RECOVERY_READY") return `恢复剩余 ${decision.remainingCount} 条`;
    if (decision.code === "UPDATE_RECOVERY_MATERIAL_REQUIRED") return "选择原材料后恢复";
    if (decision.code === "UPDATE_RECOVERY_PLAN_MISMATCH") return "材料不一致，不能恢复";
    if (decision.code === "UPDATE_RECOVERY_BUILD_MISMATCH") return "版本已变化，不能恢复";
    if (decision.code === "UPDATE_RECOVERY_MANUAL_RECONCILE_REQUIRED") return "需人工确认，不能自动恢复";
    return "恢复记录不可用";
  }

  function refreshRecoveryUi() {
    if (!contract?.recoveryDecision) return null;
    if (!resumeButton) return contract.recoveryDecision(recoverySnapshot, materialPlan?.planDigest, loadedBuildId);
    const decision = contract.recoveryDecision(recoverySnapshot, materialPlan?.planDigest, loadedBuildId);
    const batchReplace = updateSubmode === "replace" && selectedReplaceScope() === "batch";
    resumeButton.hidden = !batchReplace || !decision.exists;
    resumeButton.disabled = running || !batchReplace || !decision.allowed;
    resumeButton.textContent = recoveryButtonLabel(decision);
    resumeButton.title = decision.code === "UPDATE_RECOVERY_MANUAL_RECONCILE_REQUIRED"
      ? "该商品已进入写入阶段或存在未知写入结果，禁止自动重发。"
      : decision.code === "UPDATE_RECOVERY_PLAN_MISMATCH"
        ? "重新选择中断批次使用的同一份材料后再恢复。"
        : "";
    return decision;
  }

  async function loadRecoverySnapshot() {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage?.get) return null;
    try {
      const stored = await storage.get(contract.STORAGE_KEY);
      recoverySnapshot = stored?.[contract.STORAGE_KEY] || null;
    } catch (_) {
      recoverySnapshot = null;
    }
    refreshRecoveryUi();
    return recoverySnapshot;
  }

  async function payloadWithIdentity(file, cache) {
    if (cache.has(file)) return cache.get(file);
    const payload = Object.freeze(await binary.fileToPayload(file));
    const identity = `${binary.md5Hex(binary.payloadToBytes(payload))}:${payload.size}`;
    const value = Object.freeze({ payload, identity });
    cache.set(file, value);
    return value;
  }

  function materialDropLabel(files, emptyLabel) {
    const count = files.length;
    if (!count) return emptyLabel;
    const root = String(files[0]?.webkitRelativePath || files[0]?.relativePath || files[0]?.name || "").split(/[\\/]/).filter(Boolean)[0];
    return `${root || "已选择目录"}（${count} 个文件）`;
  }

  function isIgnoredMaterialFile(file) {
    return contract?.filterUpdateMaterialFiles
      ? contract.filterUpdateMaterialFiles([file]).length === 0
      : /^(?:Thumbs\.db|desktop\.ini|\.DS_Store)$/i.test(String(file?.name || ""));
  }

  function usableMaterialFiles(files) {
    return [...(files || [])].filter((file) => !isIgnoredMaterialFile(file));
  }

  function refreshMaterialDropLabels() {
    if (priceInventoryDropText) priceInventoryDropText.textContent = materialDropLabel(priceInventoryFiles, "拖入价格库存文件夹或两份 Excel 文件");
    if (skuImagesDropText) skuImagesDropText.textContent = materialDropLabel(replaceSkuImageFiles, "拖入 SKU 图片文件夹或点击选择");
    if (priceInventoryClear) {
      priceInventoryClear.hidden = priceInventoryFiles.length === 0;
      priceInventoryClear.disabled = running;
    }
    if (skuImagesClear) {
      skuImagesClear.hidden = replaceSkuImageFiles.length === 0;
      skuImagesClear.disabled = running;
    }
  }

  function setReplaceMaterialInputsDisabled(disabled) {
    if (input) input.disabled = disabled;
    if (skuImagesInput) skuImagesInput.disabled = disabled;
    for (const drop of [priceInventoryDrop, skuImagesDrop]) {
      if (!drop) continue;
      drop.setAttribute("aria-disabled", disabled ? "true" : "false");
      drop.tabIndex = disabled ? -1 : 0;
    }
    refreshMaterialDropLabels();
  }

  function materialFileRecord(file, relativePath) {
    return Object.freeze({
      file,
      originalFile: file,
      name: file.name,
      webkitRelativePath: String(relativePath || `手动投放材料/${file.name}`).replace(/^[/\\]+/, ""),
      relativePath: String(relativePath || `手动投放材料/${file.name}`).replace(/^[/\\]+/, "")
    });
  }

  function priceMaterialFileRecords(records) {
    const files = Array.from(records || []);
    const areDirectFiles = files.length > 0 && files.every((record) =>
      !String(record?.relativePath || "").replace(/\\/g, "/").includes("/")
    );
    return usableMaterialFiles(files.map((record) => materialFileRecord(
      record.file,
      areDirectFiles ? `直接投放的 Excel 文件/${record.file.name}` : record.relativePath
    )));
  }

  async function droppedFileRecords(dataTransfer) {
    const files = [];
    const appendEntry = async (entry, parentPath = "") => {
      if (!entry) return;
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        files.push(Object.freeze({ file, relativePath: `${parentPath}${file.name}` }));
        return;
      }
      if (!entry.isDirectory) return;
      const reader = entry.createReader();
      const children = [];
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        children.push(...batch);
      }
      const directoryPath = `${parentPath}${entry.name}/`;
      for (const child of children) await appendEntry(child, directoryPath);
    };
    const items = [...(dataTransfer?.items || [])];
    const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) {
      for (const entry of entries) await appendEntry(entry);
      return files;
    }
    return [...(dataTransfer?.files || [])].map((file) => Object.freeze({
      file,
      relativePath: String(file.webkitRelativePath || `手动投放材料/${file.name}`)
    }));
  }

  async function acceptMaterialDrop(kind, dataTransfer) {
    if (running) return;
    const records = await droppedFileRecords(dataTransfer);
    if (!records.length) fail("UPDATE_MATERIAL_DROP_EMPTY", "未从拖入内容读取到文件，请拖入一个文件夹或两份 Excel 文件后重试。", {});
    if (kind === "price") {
      priceInventoryFiles = priceMaterialFileRecords(records);
      if (priceInventoryEnabled) priceInventoryEnabled.checked = true;
    } else {
      replaceSkuImageFiles = usableMaterialFiles(records.map((record) => record.file));
      if (skuImagesEnabled) skuImagesEnabled.checked = true;
    }
    refreshMaterialDropLabels();
    await replanReplaceMaterials();
  }

  function clearReplaceMaterial(kind) {
    if (running) return;
    if (kind === "price") {
      priceInventoryFiles = [];
      if (input) input.value = "";
    } else {
      replaceSkuImageFiles = [];
      if (skuImagesInput) skuImagesInput.value = "";
    }
    materialPlan = null;
    clearMaterialFailureState();
    refreshMaterialDropLabels();
    refreshRecoveryUi();
    refreshUpdateRunButton();
    updateStatus("材料已清空，请重新投放后执行", "idle");
    render("");
  }

  function showMaterialFailure(caught) {
    materialPlan = null;
    refreshUpdateRunButton();
    updateStatus("", "blocked");
    const failure = contract?.describeMaterialFailure?.(caught) || {
      category: "材料检查",
      message: caught?.message || String(caught || "材料读取失败，请重新投放后重试。")
    };
    if (logsSection) {
      logsSection.dataset.state = "error";
      logsSection.open = true;
    }
    render(`材料检查失败\n检查项：${failure.category}\n${failure.message}`);
  }

  async function parseImageSwapFiles() {
    imageSwapPlan = null;
    auditLines = [];
    clearMaterialFailureState();
    render("");
    refreshUpdateRunButton();
    updateStatus("正在校验并冻结 SKU 图片", "running");
    if (!skuPlanner?.preflightSkuImageBatch || !binary?.fileToPayload) {
      fail("UPDATE_DEPENDENCY_UNAVAILABLE", "换SKU图计划组件未完整加载。", {});
    }
    const files = [...(imageSwapInput?.files || [])]
      .sort((left, right) => String(left.name).localeCompare(String(right.name), undefined, { numeric: true, sensitivity: "base" }));
    imageSwapPlan = await freezeSkuImagePlan(files);
    productSummaries = new Map();
    if (results) results.replaceChildren();
    if (stats) stats.hidden = true;
    refreshUpdateRunButton();
    updateStatus("SKU 图片已冻结，可以执行", "ready");
    render(planSummary(imageSwapPlan));
    audit("image_swap_material_frozen", {
      imageCount: imageSwapPlan.images.length,
      matchMode: imageSwapPlan.matchMode,
      modeSourceName: imageSwapPlan.modeSourceName,
      planDigest: imageSwapPlan.planDigest
    });
    return imageSwapPlan;
  }

  async function freezeSkuImagePlan(files) {
    const sortedFiles = usableMaterialFiles(files)
      .sort((left, right) => String(left.name).localeCompare(String(right.name), undefined, { numeric: true, sensitivity: "base" }));
    const preflightResult = skuPlanner.preflightSkuImageBatch(sortedFiles);
    if (!preflightResult.ok) {
      fail("UPDATE_SKU_IMAGE_BATCH_INVALID", preflightResult.errorMessage || "SKU 图片包含非法名称、无效首图或歧义匹配；本次未读取或修改商品页面。", {
        issues: preflightResult.issues
      });
    }
    const payloadCache = new Map();
    const images = [];
    for (const file of sortedFiles) {
      const frozen = await payloadWithIdentity(file, payloadCache);
      images.push(Object.freeze({ name: file.name, payload: frozen.payload, identity: frozen.identity }));
    }
    const planDigest = contract.stableDigest(images.map((image) => ({ name: image.name, identity: image.identity })));
    return Object.freeze({
      intent: "replace_sku_images",
      images: Object.freeze(images),
      matchMode: preflightResult.matchMode,
      modeSourceName: preflightResult.modeSourceName,
      planDigest
    });
  }

  async function readWorkbook(file) {
    if (typeof globalThis.readXlsxFile !== "function") {
      fail("UPDATE_XLSX_READER_UNAVAILABLE", "工作簿读取组件未加载。", {});
    }
    return globalThis.readXlsxFile(file);
  }

  async function parseMaterial() {
    materialPlan = null;
    pendingWashReview = null;
    clearWashReview();
    auditLines = [];
    clearMaterialFailureState();
    render("");
    runButton.disabled = true;
    updateStatus("正在预读并冻结全部材料", "running");
    if (!contract || !preflight?.materialRootFiles || !workbookPlanner?.buildWorkbookPlan || !skuPlanner?.buildSkuImagePlan || !binary?.fileToPayload) {
      fail("UPDATE_DEPENDENCY_UNAVAILABLE", "Update 材料计划组件未完整加载。", {});
    }
    const modules = selectedReplaceModules();
    let priceInventory = Object.freeze({ intent: "skip", rows: Object.freeze([]) });
    let skuImages = Object.freeze({ intent: "skip", images: Object.freeze([]) });
    let classified = null;

    if (modules.skuImages) {
      skuImages = await freezeSkuImagePlan(replaceSkuImageFiles);
    }

    if (modules.priceInventory) {
      const productPlans = preflight.materialRootFiles(priceInventoryFiles);
      if (productPlans.length !== 1) {
        fail(productPlans.length ? "UPDATE_MULTIPLE_PRODUCT_MATERIAL_PLANS" : "UPDATE_NO_TARGET_MATERIAL", productPlans.length ? "BLOCK：价格库存只能拖入一个明确的材料目录。" : "BLOCK：请在价格库存旁拖入包含规格.xlsx 和规格价格表.xlsx 的文件夹，或直接拖入这两份 Excel 文件。", { productNames: productPlans.map((plan) => plan.name) });
      }
      classified = contract.classifyUpdateMaterials(productPlans[0].files);
      if (classified.priceInventory.intent !== "replace_group") {
        fail("UPDATE_PRICE_INVENTORY_MATERIALS_REQUIRED", "价格库存模块需要一份规格工作簿和一份规格价格工作簿。", {});
      }
      const [specWorkbook, priceWorkbook] = await Promise.all([
        readWorkbook(classified.priceInventory.specificationWorkbook),
        readWorkbook(classified.priceInventory.priceWorkbook)
      ]);
      const workbookPlan = workbookPlanner.buildWorkbookPlan(specWorkbook, priceWorkbook, {
        requireStock: true,
        requireProductFields: false
      });
      const skuImagePlan = skuPlanner.buildSkuImagePlan(
        workbookPlan.rows,
        skuImages.intent === "replace_sku_images" ? skuImages.images : [],
        { allowMissing: true }
      );
      if (!skuImagePlan.ok || skuImagePlan.rows.length !== workbookPlan.rows.length) {
        fail("UPDATE_SKU_IMAGE_PLAN_INVALID", skuImagePlan.errorMessage || "SKU 图片存在无效名称或歧义匹配；缺少图片本身不会阻断，只跳过对应规格的图片上传。", { issues: skuImagePlan.issues || [] });
      }
      const rows = [];
      for (let index = 0; index < workbookPlan.rows.length; index += 1) {
        const workbookRow = workbookPlan.rows[index];
        const image = skuImagePlan.rows[index].image || null;
        rows.push(Object.freeze({
          specification: workbookRow.specification,
          price: workbookRow.price,
          stock: workbookRow.stock,
          merchantCode: workbookRow.merchantCode,
          imageMode: image ? "upload" : "deferred_missing",
          image: image?.payload || null,
          imageIdentity: image?.identity || ""
        }));
      }
      const targetDigest = contract.stableDigest(rows.map((row) => ({
        specification: row.specification,
        price: row.price,
        stock: row.stock,
        merchantCode: row.merchantCode,
        imageMode: row.imageMode,
        imageIdentity: row.imageIdentity
      })));
      priceInventory = Object.freeze({
        intent: "replace_group",
        rows: Object.freeze(rows),
        matchedSkuCount: skuImagePlan.matchedSkuCount,
        deferredSkuCount: skuImagePlan.deferredRowIndexes.length,
        unusedSkuImageCount: skuImagePlan.unmatchedImages.length,
        targetDigest
      });
    }

    const planDigest = contract.stableDigest({
      priceInventory: priceInventory.intent === "replace_group" ? priceInventory.targetDigest : "skip",
      skuImages: skuImages.intent === "replace_sku_images" ? skuImages.planDigest : "skip"
    });
    materialPlan = Object.freeze({ priceInventory, skuImages, planDigest, materialRoot: classified?.materialRoot || "SKU 图片目录" });
    productSummaries = new Map();
    if (results) results.replaceChildren();
    if (stats) stats.hidden = true;
    refreshUpdateRunButton();
    refreshRecoveryUi();
    updateStatus(modules.priceInventory || modules.skuImages ? "材料已完整冻结，可以执行" : "请选择至少一个可修改模块", "ready");
    render(planSummary());
    audit("material_frozen", { root: materialPlan.materialRoot, priceRows: priceInventory.rows.length, skuImageCount: skuImages.images.length, modules, planDigest });
  }

  async function executeRecoveryBundle(tabId, files, command, recoveryStage) {
    if (!chrome.scripting?.executeScript) {
      fail("UPDATE_RECEIVER_RECOVERY_UNAVAILABLE", "当前浏览器不支持自动恢复页面接收端；本次未修改页面。请刷新目标页面后重试。", { tabId, command, recoveryStage });
    }
    audit("receiver_recovery_started", { tabId, command, recoveryStage, files });
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files });
    } catch (caught) {
      fail("UPDATE_RECEIVER_RECOVERY_FAILED", "自动恢复页面接收端失败；本次未修改页面。请刷新目标页面后重新开始。", {
        tabId, command, recoveryStage, cause: caught?.message || String(caught), files
      });
    }
  }

  async function sendWithReceiverRecovery(tabId, message) {
    let response;
    let recoveryUsed = false;
    try {
      response = await chrome.tabs.sendMessage(tabId, message);
    } catch (caught) {
      const files = contract.receiverBootstrapFiles?.(message.command, caught);
      if (!files) throw caught;
      await executeRecoveryBundle(tabId, files, message.command, "missing_receiver");
      recoveryUsed = true;
      try {
        response = await chrome.tabs.sendMessage(tabId, message);
      } catch (retryError) {
        fail("UPDATE_RECEIVER_RECOVERY_FAILED", "页面接收端恢复后仍无法连接；本次未修改页面。请刷新目标页面后重新开始。", {
          tabId, command: message.command, recoveryStage: "missing_receiver", cause: retryError?.message || String(retryError)
        });
      }
      audit("receiver_recovery_completed", { tabId, command: message.command, recoveryStage: "missing_receiver" });
    }
    if (response?.evidence?.buildId !== loadedBuildId) {
      const previousBuildId = response?.evidence?.buildId || null;
      const readOnlyBuildRecoveryCommands = new Set([
        contract.COMMANDS.OBSERVE_LIST,
        contract.COMMANDS.SEARCH_LIST,
        contract.COMMANDS.READ_STRUCTURE,
        contract.COMMANDS.READ_REPLACE_GROUP,
        contract.COMMANDS.LOCATE_WASH_LINK_ROW
      ]);
      const files = contract.buildMismatchRecoveryFiles(message.command);
      if (files && readOnlyBuildRecoveryCommands.has(message.command) && !recoveryUsed) {
        await executeRecoveryBundle(tabId, files, message.command, "build_mismatch");
        recoveryUsed = true;
        try {
          response = await chrome.tabs.sendMessage(tabId, message);
        } catch (retryError) {
          fail("UPDATE_RUNTIME_BUILD_MISMATCH", "页面接收端自动同步失败；本次未修改页面。请刷新商品编辑页后重新开始。", {
            tabId, command: message.command, expectedBuildId: loadedBuildId,
            actualBuildId: response?.evidence?.buildId || null,
            recoveryStage: "build_mismatch", cause: retryError?.message || String(retryError)
          });
        }
        audit("receiver_recovery_completed", {
          tabId, command: message.command, recoveryStage: "build_mismatch",
          expectedBuildId: loadedBuildId, previousBuildId
        });
        if (response?.evidence?.buildId === loadedBuildId) return response;
      }
      fail("UPDATE_RUNTIME_BUILD_MISMATCH", "目标页面运行的插件版本与侧栏不一致；本次未修改页面。请刷新目标页面后重新开始。", {
        tabId, command: message.command, expectedBuildId: loadedBuildId, actualBuildId: previousBuildId
      });
    }
    if (message.command === contract.COMMANDS.READ_STRUCTURE && response?.ok && response.evidence?.result?.editorRuntimeReady !== true) {
      if (recoveryUsed) {
        fail("UPDATE_EDITOR_RUNTIME_RECOVERY_FAILED", "商品编辑器接收端恢复后运行时仍未就绪；本次未发送任何修改命令。请刷新该编辑页后重新开始。", {
          tabId, command: message.command, recoveryStage: "missing_editor_runtime_after_receiver_recovery"
        });
      }
      await executeRecoveryBundle(tabId, contract.EDITOR_RUNTIME_FILES, message.command, "missing_editor_runtime");
      try {
        response = await chrome.tabs.sendMessage(tabId, message);
      } catch (retryError) {
        fail("UPDATE_EDITOR_RUNTIME_RECOVERY_FAILED", "商品编辑器运行时恢复后无法重新读取；未发送任何修改命令。请刷新该编辑页后重新开始。", {
          tabId, command: message.command, cause: retryError?.message || String(retryError)
        });
      }
      if (response?.evidence?.buildId !== loadedBuildId || response?.ok !== true || response.evidence?.result?.editorRuntimeReady !== true) {
        fail("UPDATE_EDITOR_RUNTIME_RECOVERY_FAILED", "商品编辑器运行时恢复后仍未就绪；未发送任何修改命令。请刷新该编辑页后重新开始。", {
          tabId, command: message.command, expectedBuildId: loadedBuildId,
          actualBuildId: response?.evidence?.buildId || null, pageErrorCode: response?.errorCode || null
        });
      }
      audit("receiver_recovery_completed", { tabId, command: message.command, recoveryStage: "missing_editor_runtime" });
    }
    return response;
  }

  async function send(tabId, command, args, documentToken) {
    const startedAt = Date.now();
    const token = command === contract.COMMANDS.ABORT
      ? (documentToken || `abort-${runToken}-${tabId}`)
      : documentToken;
    const message = contract.createMessage(runToken, command, args, token);
    let response;
    try {
      response = await sendWithReceiverRecovery(tabId, message);
    } catch (caught) {
      const classified = contract.classifyTransportError(caught);
      const outcomeUnknown = Boolean(message.commandId);
      const error = classified ? Object.assign(new Error(classified.message), { code: classified.code, evidence: { command, outcomeUnknown } }) : Object.assign(caught, { evidence: { ...(caught?.evidence || {}), command, outcomeUnknown } });
      audit("command_failed", { command, elapsedMs: Date.now() - startedAt, commandId: message.commandId || "read", argsDigest: message.argsDigest || "", errorCode: error.code || "UPDATE_TRANSPORT_FAILED", outcomeUnknown, remediation: error.evidence?.fix || "保留页面，检查网络和页面状态后重新开始新的批次" });
      throw error;
    }
    if (!response?.ok) {
      const error = Object.assign(new Error(response?.error || "页面命令失败。"), {
        code: response?.errorCode || "UPDATE_PAGE_COMMAND_FAILED",
        evidence: response?.evidence || null
      });
      const observedHeaders = Array.isArray(error.evidence?.headers) ? error.evidence.headers.map(String) : undefined;
      const observedFeedback = Array.isArray(error.evidence?.observedFeedback)
        ? error.evidence.observedFeedback.map((value) => String(value).slice(0, 300)).slice(0, 20)
        : undefined;
      const specificationObservation = error.evidence?.observation;
      const reconciliationDifferences = Array.isArray(error.evidence?.differences)
        ? error.evidence.differences.slice(0, 8).map((value) => String(value).slice(0, 180))
        : undefined;
      audit("command_failed", {
        command, elapsedMs: Date.now() - startedAt, commandId: message.commandId || "read",
        argsDigest: message.argsDigest || "", errorCode: error.code,
        operationPhase: message.args?.phase,
        missingSkuCount: error.evidence?.missingSkuCount,
        missingSkus: Array.isArray(error.evidence?.missingSkus)
          ? error.evidence.missingSkus.slice(0, 8).map((row) => ({ specification: String(row?.specification || "").slice(0, 160), skuId: String(row?.skuId || "") }))
          : undefined,
        appendTargetSpecification: error.evidence?.specification,
        appendValidation: error.evidence?.validation,
        appendInvalidAdditionSamples: Array.isArray(error.evidence?.invalidAdditions)
          ? error.evidence.invalidAdditions.slice(0, 8).map((value) => String(value).slice(0, 160))
          : undefined,
        appendMissingSpecifications: Array.isArray(error.evidence?.missingSpecifications)
          ? error.evidence.missingSpecifications.slice(0, 8).map((value) => String(value).slice(0, 160))
          : undefined,
        appendUnexpectedSpecifications: Array.isArray(error.evidence?.unexpectedSpecifications)
          ? error.evidence.unexpectedSpecifications.slice(0, 8).map((value) => String(value).slice(0, 160))
          : undefined,
        appendInputCount: error.evidence?.inputCount,
        appendEmptyCount: error.evidence?.emptyCount,
        appendObservedSpecifications: error.evidence?.observedSpecifications,
        appendExpectedSpecifications: error.evidence?.expectedSpecifications,
        appendActionCount: error.evidence?.appendActionCount,
        appendActionSignals: error.evidence?.appendActionSignals,
        appendVisibleControls: error.evidence?.visibleControlSignals,
        appendPanelMissing: error.evidence?.panelMissing,
        outcomeUnknown: Boolean(error.evidence?.outcomeUnknown), observedHeaders, observedFeedback,
        observedSpecValues: specificationObservation?.values,
        observedSpecGroupCount: specificationObservation?.groupCount,
        observedSpecEmptyCount: specificationObservation?.nextEmptyCount,
        writeTargetGroupIndex: specificationObservation?.writeTargetGroupIndex,
        recoveryReason: error.evidence?.recoveryReason,
        editorSpecificationCount: error.evidence?.editorSpecificationCount,
        baselineSpecificationCount: error.evidence?.baselineSpecificationCount,
        skuRowCount: error.evidence?.skuRowCount,
        reconciliationDifferences,
        reconciliationDifferenceCount: Array.isArray(error.evidence?.differences) ? error.evidence.differences.length : undefined,
        remediation: error.evidence?.fix || "保留页面并依据回读结果人工检查"
      });
      throw error;
    }
    const evidence = Object.freeze({ ...response.evidence, commandId: message.commandId || null, argsDigest: message.argsDigest || null });
    audit("command_receipt", { command, elapsedMs: Date.now() - startedAt, commandId: evidence.commandId || "read", documentToken: evidence.documentToken || documentToken || "none" });
    return evidence;
  }

  async function persistProgress(stage, details = {}) {
    const snapshot = Object.freeze({
      runToken,
      stage,
      planDigest: (activeRunPlan || materialPlan)?.planDigest || null,
      checkpoint: activeBatchCheckpoint,
      ...details,
      updatedAt: Date.now()
    });
    try {
      await chrome.storage.local.set({ [contract.STORAGE_KEY]: snapshot });
    } catch (caught) {
      fail("UPDATE_PROGRESS_PERSIST_FAILED", "Update 进度保存失败，已停止后续商品。", { stage, cause: caught?.message || String(caught) });
    }
    recoverySnapshot = snapshot;
    refreshRecoveryUi();
    return snapshot;
  }

  async function activeMerchantTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/fxg\.jinritemai\.com\//.test(tab.url || "")) {
      fail("UPDATE_LIST_PAGE_REQUIRED", "请先打开当前筛选后的抖店商品管理页。", {});
    }
    return tab;
  }

  function listPageIdentity(tab) {
    const url = new URL(tab?.url || "https://invalid.invalid");
    if (!contract?.isProductManagementListUrl?.(url.href)) {
      fail("UPDATE_LIST_PAGE_REQUIRED", "当前标签页不是商品管理页。", { url: tab?.url || null });
    }
    return Object.freeze({ origin: url.origin, pathname: url.pathname });
  }

  async function activateTaskTab(tab, code, label) {
    if (!Number.isInteger(tab?.id)) fail(code, `${label}缺少有效标签页。`, {});
    await chrome.tabs.update(tab.id, { active: true });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (active?.id === tab.id) return active;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    fail(code, `${label}未能切换到前台。`, {});
  }

  async function observeBoundListTab(listTab, identity) {
    await activateTaskTab(listTab, "UPDATE_LIST_FOREGROUND_TIMEOUT", "商品管理页");
    const current = (await chrome.tabs.query({ windowId: listTab.windowId })).find((tab) => tab.id === listTab.id);
    const url = new URL(current?.url || "https://invalid.invalid");
    if (url.origin !== identity.origin || url.pathname !== identity.pathname || !contract?.isProductManagementListUrl?.(url.href)) {
      fail("UPDATE_LIST_TAB_NAVIGATED", "原商品管理页已导航到其他页面。", { expected: identity, actual: current?.url || null });
    }
    return send(listTab.id, contract.COMMANDS.OBSERVE_LIST);
  }

  async function moveToFrozenProductPage(listTab, identity, product) {
    const current = await observeBoundListTab(listTab, identity);
    if (current.result.currentPage === product.pageNo) return current;
    if (current.result.currentPage + 1 === product.pageNo) {
      audit("serial_page_advance_started", { fromPage: current.result.currentPage, toPage: product.pageNo, nextProductId: product.productId });
      const next = await send(listTab.id, contract.COMMANDS.NEXT_PAGE, {}, current.documentToken);
      if (next.result.currentPage === product.pageNo) {
        audit("serial_page_advance_completed", { currentPage: next.result.currentPage, nextProductId: product.productId });
        return next;
      }
    }
    fail("UPDATE_SERIAL_PAGE_SEQUENCE_INVALID", `商品 ${product.productId} 的冻结来源页无法按顺序到达。`, {
      productId: product.productId,
      currentPage: current.result.currentPage,
      targetPage: product.pageNo
    });
  }

  async function positionListAtPage(listTab, identity, targetPage) {
    let current = await observeBoundListTab(listTab, identity);
    if (current.result.currentPage !== 1) {
      current = await send(listTab.id, contract.COMMANDS.GO_PAGE, { pageNo: 1 }, current.documentToken);
    }
    for (let page = 1; page < targetPage; page += 1) {
      current = await send(listTab.id, contract.COMMANDS.NEXT_PAGE, {}, current.documentToken);
    }
    if (current.result.currentPage !== targetPage) {
      fail("UPDATE_RECOVERY_START_PAGE_UNREACHABLE", `恢复起始页 ${targetPage} 未完成权威回读。`, {
        targetPage, actualPage: current.result.currentPage
      });
    }
    return current;
  }

  async function collectFiltered(tab, initial, options = {}) {
    const persist = options.persist !== false;
    const originalPage = initial.result.currentPage;
    let current = originalPage === 1
      ? initial
      : await send(tab.id, contract.COMMANDS.GO_PAGE, { pageNo: 1 }, initial.documentToken);
    const first = current;
    const entries = [...first.result.entries];
    if (persist) await persistProgress("batch_collecting", { collectedCount: entries.length, total: first.result.total });
    for (let page = 1; page < first.result.pageCount; page += 1) {
      assertReady();
      current = await send(tab.id, contract.COMMANDS.NEXT_PAGE, {}, current.documentToken);
      if (current.result.filterUrl !== first.result.filterUrl || current.result.total !== first.result.total || current.result.pageCount !== first.result.pageCount) {
        fail("UPDATE_FILTER_SNAPSHOT_DRIFT", "筛选条件或分页摘要发生变化。", {});
      }
      entries.push(...current.result.entries);
      updateStatus(`正在冻结筛选范围：${entries.length}/${first.result.total}`, "running");
      if (persist) await persistProgress("batch_collecting", { collectedCount: entries.length, total: first.result.total });
    }
    return Object.freeze({
      frozen: contract.freezeFilteredProducts({ ...first.result, entries }),
      originalPage,
      documentToken: current.documentToken
    });
  }

  function editTabsForProduct(tabs, listTab, productId) {
    return tabs.filter((tab) => {
      if (tab.id === listTab.id || tab.windowId !== listTab.windowId) return false;
      try {
        const url = new URL(tab.url || "https://invalid.invalid");
        return url.origin === "https://fxg.jinritemai.com" && url.searchParams.get("product_id") === productId;
      } catch (_) {
        return false;
      }
    });
  }

  function trustedObservedEditHref(rawHref, listTab, productId) {
    let url;
    try {
      url = new URL(String(rawHref || ""), listTab?.url || "https://fxg.jinritemai.com/");
    } catch (_) {
      fail("UPDATE_EDIT_HREF_INVALID", `商品 ${productId} 的编辑链接无法解析，未打开页面。`, { rawHref: rawHref || null });
    }
    const listUrl = new URL(listTab?.url || "https://invalid.invalid");
    const actualProductId = url.searchParams.get("product_id");
    if (url.protocol !== "https:" || url.origin !== "https://fxg.jinritemai.com") {
      fail("UPDATE_EDIT_HREF_UNTRUSTED", `商品 ${productId} 的编辑链接不是抖店 HTTPS 页面，未打开页面。`, { rawHref, resolvedHref: url.href });
    }
    if (url.pathname === listUrl.pathname || /\/ffa\/g\/list\/?$/i.test(url.pathname)) {
      fail("UPDATE_EDIT_HREF_LIST_PAGE", `商品 ${productId} 的编辑链接仍指向商品管理页，未打开页面。`, { resolvedHref: url.href });
    }
    if (!/^\d{8,}$/.test(actualProductId || "")) {
      fail("UPDATE_EDIT_HREF_PRODUCT_ID_MISSING", `商品 ${productId} 的编辑链接缺少 product_id，未打开页面。`, { resolvedHref: url.href });
    }
    if (actualProductId !== String(productId)) {
      fail("UPDATE_EDIT_HREF_PRODUCT_ID_MISMATCH", `商品 ${productId} 的编辑链接 product_id 不一致，未打开页面。`, { expectedProductId: String(productId), actualProductId, resolvedHref: url.href });
    }
    return url.href;
  }

  function redactedEditHrefEvidence(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 32).map((candidate) => ({
      source: String(candidate?.source || "unknown"),
      attribute: String(candidate?.attribute || "unknown"),
      state: String(candidate?.state || "unknown"),
      syntax: String(candidate?.syntax || "unknown"),
      origin: String(candidate?.origin || "unknown"),
      path: String(candidate?.path || ""),
      productIdBinding: String(candidate?.productIdBinding || "unknown")
    }));
  }

  async function waitForNewEditTab(listTab, productId, beforeIds, preferredTabId = null, options = {}) {
    const deadline = Date.now() + (Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000);
    while (Date.now() < deadline) {
      const candidates = editTabsForProduct(await chrome.tabs.query({ windowId: listTab.windowId }), listTab, productId)
        .filter((tab) => !beforeIds.has(tab.id));
      if (candidates.length > 1) fail("UPDATE_EDIT_TAB_AMBIGUOUS", `商品 ${productId} 打开了多个新编辑页。`, { productId, tabIds: candidates.map((tab) => tab.id) });
      if (candidates.length === 1) {
        if (preferredTabId !== null && candidates[0].id !== preferredTabId) {
          fail("UPDATE_EDIT_TAB_CREATE_MISMATCH", `商品 ${productId} 观察到的编辑页不是扩展创建的标签页。`, { productId, expectedTabId: preferredTabId, actualTabId: candidates[0].id });
        }
        return candidates[0];
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const clickDispatched = options.clickDispatched === true;
    fail("UPDATE_EDIT_TAB_NOT_OPENED", clickDispatched
      ? `商品 ${productId} 的编辑入口点击已派发但未产生新标签。`
      : `未观察到商品 ${productId} 的编辑页。`, { productId, preferredTabId, clickDispatched });
  }

  async function validateCompletedSessions(listTab, checkpoint) {
    const tabs = await chrome.tabs.query({ windowId: listTab.windowId });
    let publishLedger = null;
    for (const session of checkpoint.completedSessions || []) {
      if (session.tabClosed === true) {
        publishLedger ||= await readPublishLedger();
        const proven = publishLedger.some((entry) =>
          String(entry?.productId || "") === String(session.productId) &&
          entry?.intentDigest === session.intentDigest &&
          entry?.modificationDigest === session.modificationDigest &&
          entry?.status === "confirmed_success");
        if (!proven) {
          fail("UPDATE_RECOVERY_CLOSED_PUBLISH_UNPROVEN", `已关闭商品 ${session.productId} 的发布记录无法通过持久账本验证，不能安全跳过。`, {
            productId: session.productId,
            tabId: session.tabId,
            intentDigest: session.intentDigest,
            modificationDigest: session.modificationDigest,
            fix: "人工核对该商品发布状态后重新开始批次，不要直接恢复。"
          });
        }
        audit("recovery_closed_publish_verified", {
          productId: session.productId,
          tabId: session.tabId,
          intentDigest: session.intentDigest,
          modificationDigest: session.modificationDigest
        });
        continue;
      }
      const tab = tabs.find((candidate) => candidate.id === session.tabId);
      if (!tab || !editTabsForProduct([tab], listTab, session.productId).length) {
        fail("UPDATE_RECOVERY_COMPLETED_TAB_MISSING", `已完成商品 ${session.productId} 的保留编辑页不存在或已导航，不能安全跳过。`, {
          productId: session.productId, tabId: session.tabId
        });
      }
      const evidence = await send(tab.id, contract.COMMANDS.READ_STRUCTURE, { productId: session.productId });
      if (evidence.documentToken !== session.documentToken || evidence.result?.productId !== session.productId) {
        fail("UPDATE_RECOVERY_COMPLETED_DOCUMENT_CHANGED", `已完成商品 ${session.productId} 的编辑页文档已变化，不能安全跳过。`, {
          productId: session.productId,
          expectedDocumentToken: session.documentToken,
          actualDocumentToken: evidence.documentToken || null
        });
      }
      await abortTab(tab, evidence.documentToken);
    }
    return true;
  }

  async function openedEditTab(listTab, product, documentToken) {
    const beforeTabs = await chrome.tabs.query({ windowId: listTab.windowId });
    const existing = editTabsForProduct(beforeTabs, listTab, product.productId);
    if (existing.length > 1) fail("UPDATE_EDIT_TAB_AMBIGUOUS", `商品 ${product.productId} 存在多个编辑页。`, {});
    if (existing.length === 1) return existing[0];
    const beforeIds = new Set(beforeTabs.map((tab) => tab.id));
    const opened = await send(listTab.id, contract.COMMANDS.OPEN_EDIT, { productId: product.productId }, documentToken);
    const result = opened.result || {};
    if (String(result.productId || "") !== String(product.productId)) {
      fail("UPDATE_EDIT_ENTRY_PRODUCT_ID_MISMATCH", `商品 ${product.productId} 的编辑入口回执与目标商品不一致。`, {
        expectedProductId: String(product.productId), actualProductId: result.productId || null
      });
    }
    const editHrefEvidence = redactedEditHrefEvidence(result.editHrefEvidence);
    audit("edit_href_observed", {
      productId: product.productId,
      hasEditHref: Boolean(result.editHref),
      source: String(result.editHrefSource || "legacy"),
      candidates: editHrefEvidence
    });
    if (result.editHref) {
      const editHref = trustedObservedEditHref(result.editHref, listTab, product.productId);
      audit("edit_href_open_started", { productId: product.productId, editHref, method: "extension_tabs_create" });
      let created;
      try {
        created = await chrome.tabs.create({ windowId: listTab.windowId, url: editHref, active: true });
      } catch (caught) {
        fail("UPDATE_EDIT_TAB_CREATE_FAILED", `商品 ${product.productId} 的编辑页无法由扩展打开。`, { productId: product.productId, editHref, cause: caught?.message || String(caught) });
      }
      if (!Number.isInteger(created?.id)) {
        fail("UPDATE_EDIT_TAB_CREATE_FAILED", `商品 ${product.productId} 的编辑页未返回有效标签页。`, { productId: product.productId, editHref, createdTabId: created?.id || null });
      }
      const tab = await waitForNewEditTab(listTab, product.productId, beforeIds, created.id);
      audit("edit_href_open_completed", { productId: product.productId, tabId: tab.id, method: "extension_tabs_create" });
      return tab;
    }
    const clickDispatched = result.clickDispatched === true || result.clicked === true;
    if (!clickDispatched) {
      fail("UPDATE_EDIT_ENTRY_NO_HREF_OR_CLICK", `商品 ${product.productId} 的编辑入口既未提供真实链接，也未确认点击已派发。`, { productId: product.productId, result });
    }
    audit("edit_href_missing_legacy_click", { productId: product.productId, method: "page_click_fallback", clickDispatched: true, candidates: editHrefEvidence });
    return waitForNewEditTab(listTab, product.productId, beforeIds, null, { clickDispatched: true });
  }

  const READ_RETRY_CODES = new Set([
    "UPDATE_CONTENT_SCRIPT_NOT_READY", "UPDATE_PRODUCT_TABLIST_MISSING", "UPDATE_PRICE_TAB_MISSING",
    "UPDATE_PRICE_PANEL_MISSING", "UPDATE_PRICE_TAB_NOT_READY", "UPDATE_PRICE_TAB_READBACK_TIMEOUT",
    "UPDATE_SPEC_EDITOR_INCOMPLETE", "UPDATE_SKU_TABLE_UNREADABLE", "UPDATE_SKU_HEADERS_INVALID"
  ]);

  function initialStructureReadState(result) {
    const guard = result?.guardShape || {};
    const specificationType = String(guard.specificationType || result?.specificationType || "");
    const groupCount = Number(guard.groupCount ?? result?.groupCount) || 0;
    const dimensionCount = Number(guard.dimensionCount ?? result?.dimensionCount) || 0;
    const editorCount = Array.isArray(guard.editorSpecifications)
      ? guard.editorSpecifications.length
      : Array.isArray(result?.editorSpecs) ? result.editorSpecs.length : 0;
    const skuCount = Array.isArray(guard.skuRows)
      ? guard.skuRows.length
      : Array.isArray(result?.skuRows) ? result.skuRows.length : 0;
    const rawExpectedCount = result?.scanEvidence?.expectedCount;
    const rawCollectedCount = result?.scanEvidence?.collectedCount;
    const expectedCount = rawExpectedCount === null || rawExpectedCount === undefined ? null : Number(rawExpectedCount);
    const collectedCount = rawCollectedCount === null || rawCollectedCount === undefined ? null : Number(rawCollectedCount);
    const countMatched = Number.isInteger(expectedCount) && expectedCount >= 0
      ? expectedCount > 0 && collectedCount === expectedCount
      : editorCount > 0 && skuCount > 0;
    const usable = result?.scanComplete === true && result?.empty === false &&
      contract.SPECIFICATION_TYPES.includes(specificationType) && groupCount > 0 && dimensionCount > 0 &&
      editorCount > 0 && skuCount > 0 && countMatched;
    return Object.freeze({
      usable,
      kind: usable ? "nonempty_complete" : result?.empty === true ? "transient_empty" : "partial",
      specificationType: specificationType || null,
      groupCount,
      dimensionCount,
      editorCount,
      skuCount,
      expectedCount: Number.isInteger(expectedCount) ? expectedCount : null,
      collectedCount: Number.isInteger(collectedCount) ? collectedCount : null,
      scanComplete: result?.scanComplete === true
    });
  }

  async function readStructureWhenReady(tab, productId) {
    const startedAt = Date.now();
    const hardDeadline = startedAt + 60000;
    let deadline = startedAt + 30000;
    let lastError = null;
    let previous = null;
    let lastCompared = null;
    let lastUsable = null;
    let lastReadable = null;
    let lastReadState = null;
    let lastRejectedState = null;
    let lastRejectedScanEvidence = null;
    let totalAttempts = 0;
    let readableAttempts = 0;
    let completeReads = 0;
    let usableCompleteReads = 0;
    let transientEmptyReads = 0;
    let partialReads = 0;
    let firstUsableAtMs = null;
    while (totalAttempts < 120 && readableAttempts < 8 && Date.now() < deadline) {
      assertReady();
      try {
        totalAttempts += 1;
        const current = await send(tab.id, contract.COMMANDS.READ_STRUCTURE, { productId });
        readableAttempts += 1;
        lastReadable = current;
        if (String(current.result?.productId || "") !== String(productId)) {
          fail("UPDATE_EDIT_STRUCTURE_PRODUCT_ID_MISMATCH", `商品 ${productId} 的结构回执属于其他商品，未发送删除命令。`, {
            expectedProductId: String(productId), actualProductId: current.result?.productId || null,
            totalAttempts, readableAttempts, elapsedMs: Date.now() - startedAt,
            fix: "保留编辑页，确认地址栏商品ID与任务商品一致后重新执行。"
          });
        }
        const readState = initialStructureReadState(current.result);
        lastReadState = readState;
        if (readState.scanComplete) completeReads += 1;
        if (readState.kind === "transient_empty") transientEmptyReads += 1;
        if (readState.kind === "partial") partialReads += 1;
        if (!readState.usable) {
          lastRejectedState = readState;
          lastRejectedScanEvidence = current.result?.scanEvidence || null;
        }
        if (readState.usable) {
          usableCompleteReads += 1;
          if (firstUsableAtMs === null) {
            firstUsableAtMs = Date.now() - startedAt;
            deadline = Math.min(hardDeadline, Math.max(deadline, Date.now() + 30000));
          }
        }
        const guardDigest = readState.usable ? contract.stableDigest(current.result?.guardShape) : null;
        const previousGuardDigest = previous ? contract.stableDigest(previous.result?.guardShape) : null;
        const stable = readState.usable && previous &&
          previous.documentToken === current.documentToken &&
          previousGuardDigest === guardDigest;
        if (stable) {
          audit("product_structure_stable", {
            productId, totalAttempts, readableAttempts, completeReads, usableCompleteReads, transientEmptyReads, partialReads,
            firstUsableAtMs, elapsedMs: Date.now() - startedAt,
            scanComplete: true, scanEvidence: current.result?.scanEvidence || null,
            guardDigest, previousStructureDigest: previous.result?.structureDigest || null,
            actualStructureDigest: current.result?.structureDigest || null
          });
          return current;
        }
        if (readState.usable) {
          lastCompared = previous || lastUsable;
          lastUsable = current;
          previous = current;
        } else {
          previous = null;
        }
      } catch (caught) {
        if (!READ_RETRY_CODES.has(caught?.code)) throw caught;
        lastError = caught;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const commonEvidence = {
      productId,
      totalAttempts,
      readableAttempts,
      maxTotalAttempts: 120,
      maxReadableAttempts: 8,
      completeReads,
      usableCompleteReads,
      transientEmptyReads,
      partialReads,
      firstUsableAtMs,
      elapsedMs: Date.now() - startedAt,
      hardTimeoutMs: 60000,
      lastReadState,
      lastRejectedState,
      lastRejectedScanEvidence,
      scanEvidence: lastReadable?.result?.scanEvidence || null
    };
    if (usableCompleteReads === 0 && lastReadable) {
      fail("UPDATE_EDIT_HYDRATION_TIMEOUT", `商品 ${productId} 的价格库存只读到空白或不完整过渡态，未发送删除命令。`, {
        ...commonEvidence,
        fix: "保留编辑页，等待价格库存中的规格输入和 SKU 表完整显示后重新执行。"
      });
    }
    if (lastReadable) {
      const previousGuardShape = lastCompared?.result?.guardShape || null;
      const actualGuardShape = lastReadable.result?.guardShape || null;
      const guardDifferenceKeys = [...new Set([
        ...Object.keys(previousGuardShape || {}), ...Object.keys(actualGuardShape || {})
      ])].filter((key) => contract.stableDigest(previousGuardShape?.[key]) !== contract.stableDigest(actualGuardShape?.[key]));
      fail("UPDATE_EDIT_STRUCTURE_UNSTABLE", `商品 ${productId} 的规格结构可以读取但未连续稳定，未发送删除命令。`, {
        ...commonEvidence,
        previousStructureDigest: lastCompared?.result?.structureDigest || null,
        actualStructureDigest: lastReadable.result?.structureDigest || null,
        previousGuardDigest: previousGuardShape ? contract.stableDigest(previousGuardShape) : null,
        actualGuardDigest: actualGuardShape ? contract.stableDigest(actualGuardShape) : null,
        guardDifferenceKeys,
        scanComplete: lastReadable.result?.scanComplete === true,
        previousScanEvidence: lastCompared?.result?.scanEvidence || null,
        fix: guardDifferenceKeys.length
          ? `结构保护字段仍在变化（${guardDifferenceKeys.join("、")}），请检查保留的编辑页后重试。`
          : "完整扫描未能在限定时间内形成两次一致回读，请等待页面稳定后重试。"
      });
    }
    if (lastError?.code === "UPDATE_SKU_HEADERS_INVALID") {
      lastError.evidence = { ...(lastError.evidence || {}), ...commonEvidence };
      throw lastError;
    }
    fail("UPDATE_EDIT_HYDRATION_TIMEOUT", `商品 ${productId} 编辑页未完成加载。`, {
      ...commonEvidence,
      lastErrorCode: lastError?.code || null,
      fix: "页面持续未就绪；请保留编辑页，等待五项导航与价格库存加载完成后重新执行。"
    });
  }

  const REPLACE_GROUP_RETRY_CODES = new Set([
    "UPDATE_CONTENT_SCRIPT_NOT_READY", "UPDATE_PRODUCT_TABLIST_MISSING", "UPDATE_PRICE_TAB_MISSING",
    "UPDATE_PRICE_PANEL_MISSING", "UPDATE_PRICE_TAB_NOT_READY", "UPDATE_PRICE_TAB_READBACK_TIMEOUT",
    "UPDATE_REPLACE_GROUP_NOT_READY", "UPDATE_REPLACE_SPECIFICATION_TYPE_UNPROVEN"
  ]);

  async function readReplaceGroupWhenReady(tab, productId) {
    const startedAt = Date.now();
    const deadline = startedAt + 30000;
    let totalAttempts = 0;
    let readableAttempts = 0;
    let previous = null;
    let lastReadable = null;
    let lastError = null;
    while (totalAttempts < 120 && readableAttempts < 8 && Date.now() < deadline) {
      assertReady();
      try {
        totalAttempts += 1;
        const current = await send(tab.id, contract.COMMANDS.READ_REPLACE_GROUP, { productId });
        readableAttempts += 1;
        lastReadable = current;
        if (String(current.result?.productId || "") !== String(productId)) {
          fail("UPDATE_REPLACE_GROUP_PRODUCT_ID_MISMATCH", `商品 ${productId} 的轻量规格组回执属于其他商品。`, {
            expectedProductId: String(productId), actualProductId: current.result?.productId || null,
            totalAttempts, readableAttempts, dispatched: false
          });
        }
        const guardDigest = contract.stableDigest(current.result?.guardShape);
        if (previous && previous.documentToken === current.documentToken &&
          contract.stableDigest(previous.result?.guardShape) === guardDigest) {
          audit("replace_group_structure_stable", {
            productId, totalAttempts, readableAttempts, elapsedMs: Date.now() - startedAt,
            guardDigest, specificationType: current.result?.specificationType || null,
            groupCount: current.result?.groupCount ?? null,
            deleteActionCount: current.result?.deleteActionCount ?? null,
            editorInputCount: current.result?.editorInputCount ?? null
          });
          return current;
        }
        previous = current;
      } catch (caught) {
        if (!REPLACE_GROUP_RETRY_CODES.has(caught?.code)) throw caught;
        previous = null;
        lastError = caught;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    fail(lastReadable ? "UPDATE_REPLACE_GROUP_UNSTABLE" : "UPDATE_REPLACE_GROUP_HYDRATION_TIMEOUT",
      lastReadable
        ? `商品 ${productId} 的轻量规格组结构未形成两次稳定回读，未发送删除命令。`
        : `商品 ${productId} 的唯一规格组尚未完成加载，未发送删除命令。`, {
        productId, totalAttempts, readableAttempts, elapsedMs: Date.now() - startedAt,
        previousGuardDigest: previous ? contract.stableDigest(previous.result?.guardShape) : null,
        actualGuardDigest: lastReadable ? contract.stableDigest(lastReadable.result?.guardShape) : null,
        lastErrorCode: lastError?.code || null,
        lastResult: lastReadable?.result || null,
        dispatched: false,
        fix: "确认价格库存仅有一个规格组、规格类型和组级删除按钮已显示后重新执行。"
      });
  }

  async function executeOffsaleSpecifications(tab, documentToken, productId, specifications) {
    const records = [];
    const mutationReceipts = [];
    for (const specification of specifications) {
      assertReady();
      const evidence = await send(tab.id, contract.COMMANDS.DELETE_SPEC_VALUE, { productId, specification }, documentToken);
      const result = evidence.result || {};
      records.push(Object.freeze({ specification, state: result.state || "unknown" }));
      if (result.state === "deleted") mutationReceipts.push(completedMutationReceipt(evidence));
      audit(result.state === "no_change" ? "offsale_spec_absent" : "offsale_spec_deleted", {
        productId, specification, resultState: result.state || "unknown",
        commandId: evidence.commandId || null
      });
    }
    return Object.freeze({
      productId,
      requestedCount: specifications.length,
      deletedCount: records.filter((item) => item.state === "deleted").length,
      absentCount: records.filter((item) => item.state === "no_change").length,
      actionCount: records.filter((item) => item.state === "deleted").length,
      noMatch: records.length === specifications.length && records.every((item) => item.state === "no_change"),
      mutationReceipts: Object.freeze(mutationReceipts.filter(Boolean)),
      records: Object.freeze(records)
    });
  }

  async function processOffsaleProduct(listTab, listIdentity, product, index, total, plan) {
    assertReady();
    auditContext = Object.freeze({ productId: product.productId, productIndex: index + 1, productTotal: total });
    updateProductSummary(product, { state: "running", detail: "正在打开编辑页" });
    updateStatus(`下架 ${index + 1}/${total}：${product.productId}`, "running");
    let editTab = null;
    let documentToken = null;
    let stage = "打开编辑页";
    try {
      const listEvidence = await moveToFrozenProductPage(listTab, listIdentity, product);
      editTab = await openedEditTab(listTab, product, listEvidence.documentToken);
      await activateTaskTab(editTab, "UPDATE_EDIT_FOREGROUND_TIMEOUT", `商品 ${product.productId} 编辑页`);
      stage = "读取商品规格";
      const initial = await readStructureWhenReady(editTab, product.productId);
      documentToken = initial.documentToken;
      stage = "删除匹配规格";
      const receipt = await executeOffsaleSpecifications(editTab, documentToken, product.productId, plan.specifications);
      assertReady();
      stage = "自动发布";
      const publication = await publishModifiedProduct(editTab, documentToken, product, plan, "offsale", receipt);
      updateProductSummary(product, publication.state === "skipped"
        ? { state: "skipped", detail: `未找到 ${receipt.absentCount} 个目标规格，未修改也未发布；${publication.tabClose.message}` }
        : { state: "publish_confirmed", detail: `已删除 ${receipt.deletedCount} 个规格；${publication.tabClose.message}` });
      audit(publication.state === "skipped" ? "offsale_product_skipped" : "offsale_product_published", { ...receipt, publication });
      return Object.freeze({ ...receipt, publication });
    } catch (caught) {
      if (caught?.code === "UPDATE_PAUSED") updateProductSummary(product, { state: "paused", detail: "已暂停，当前商品未继续执行" });
      else updateProductFailureSummary(product, caught, stage);
      audit("offsale_product_blocked", {
        productId: product.productId,
        code: caught?.code || "UPDATE_OFFSALE_PRODUCT_BLOCKED",
        outcomeUnknown: caught?.evidence?.outcomeUnknown === true,
        stage,
        remediation: caught?.evidence?.fix || "保留编辑页，人工核对后重新执行该商品"
      });
      throw caught;
    } finally {
      if (editTab) await abortTab(editTab, documentToken).catch(() => {});
    }
  }

  function editProductIdentity(tab) {
    const url = new URL(tab?.url || "https://invalid.invalid");
    const productId = url.origin === "https://fxg.jinritemai.com" ? url.searchParams.get("product_id") : null;
    if (!/^\d{8,}$/.test(productId || "")) {
      fail("UPDATE_EDIT_PAGE_REQUIRED", "当前标签页不是可识别的商品编辑页，请打开目标商品编辑页后重试。", { url: tab?.url || null });
    }
    return Object.freeze({ productId, title: String(tab?.title || "") });
  }

  async function runOffsale() {
    if (running) return;
    let plan;
    try {
      plan = offsalePlan();
    } catch (caught) {
      updateStatus("下架规格输入无效", "blocked");
      render(`${caught?.code || "UPDATE_OFFSALE_INPUT_INVALID"}：${caught?.message || caught}`);
      return;
    }
    const scope = selectedOffsaleScope();
    running = true;
    paused = false;
    activeRunPlan = plan;
    activeBatchCheckpoint = null;
    auditContext = Object.freeze({});
    auditLines = [];
    render("");
    runToken = `update-offsale-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    refreshUpdateRunButton();
    pauseButton.disabled = false;
    setReplaceMaterialInputsDisabled(true);
    if (imageSwapInput) imageSwapInput.disabled = true;
    priceInventoryEnabled.disabled = true;
    if (skuImagesEnabled) skuImagesEnabled.disabled = true;
    offsaleSpecifications.disabled = true;
    for (const control of document.querySelectorAll('input[name="updateOffsaleScope"], input[name="updateImageSwapScope"], [data-update-submode]')) control.disabled = true;
    let listTab = null;
    let listDocumentToken = null;
    let originalPage = null;
    let currentEditTab = null;
    let currentEditDocumentToken = null;
    let currentProduct = null;
    let currentStage = "打开编辑页";
    try {
      if (scope === "current") {
        currentEditTab = await activeMerchantTab();
        const product = currentProduct = editProductIdentity(currentEditTab);
        const accepted = globalThis.confirm?.(`将仅在当前商品 ${product.productId} 中删除以下 ${plan.specifications.length} 个精确匹配规格：\n\n${plan.specifications.join("\n")}\n\n实际删除并完成发布记录后自动关闭编辑页；无匹配直接关闭，故障时保留编辑页。`);
        if (accepted !== true) fail("UPDATE_CONFIRMATION_DECLINED", "已取消，本次没有修改商品。", {});
        resetProductSummaries([product]);
        auditContext = Object.freeze({ productId: product.productId, productIndex: 1, productTotal: 1 });
        updateProductSummary(product, { state: "running", detail: "正在读取当前编辑页" });
        updateStatus(`下架 1/1：${product.productId}`, "running");
        await activateTaskTab(currentEditTab, "UPDATE_EDIT_FOREGROUND_TIMEOUT", `商品 ${product.productId} 编辑页`);
        currentStage = "读取商品规格";
        const initial = await readStructureWhenReady(currentEditTab, product.productId);
        currentEditDocumentToken = initial.documentToken;
        currentStage = "删除匹配规格";
        const receipt = await executeOffsaleSpecifications(currentEditTab, currentEditDocumentToken, product.productId, plan.specifications);
        currentStage = "自动发布";
        const publication = await publishModifiedProduct(currentEditTab, currentEditDocumentToken, product, plan, "offsale", receipt);
        updateProductSummary(product, publication.state === "skipped"
          ? { state: "skipped", detail: `目标规格均未找到，未修改也未发布；${publication.tabClose.message}` }
          : { state: "publish_confirmed", detail: `已删除 ${receipt.deletedCount} 个规格；${publication.tabClose.message}` });
        updateStatus(publication.tabClose.message, "ready");
        audit("offsale_current_complete", { ...receipt, publication });
      } else {
        listTab = await activeMerchantTab();
        const listIdentity = listPageIdentity(listTab);
        const initial = await send(listTab.id, contract.COMMANDS.OBSERVE_LIST);
        listDocumentToken = initial.documentToken;
        const collected = await collectFiltered(listTab, initial, { persist: false });
        listDocumentToken = collected.documentToken;
        originalPage = collected.originalPage;
        const products = collected.frozen.entries;
        const accepted = globalThis.confirm?.(`将按当前筛选顺序处理 ${products.length} 个商品，并在每个商品中删除以下 ${plan.specifications.length} 个精确匹配规格：\n\n${plan.specifications.join("\n")}\n\n实际删除并完成发布记录后自动关闭编辑页；无匹配商品直接关闭，故障商品保留，并继续下一商品。`);
        if (accepted !== true) fail("UPDATE_CONFIRMATION_DECLINED", "已取消，本次没有修改商品。", {});
        resetProductSummaries(products);
        const positioned = await positionListAtPage(listTab, listIdentity, products[0]?.pageNo || 1);
        listDocumentToken = positioned.documentToken;
        const outcomes = await processFrozenProducts(listTab, listIdentity, products, plan, processOffsaleProduct, 0);
        auditContext = Object.freeze({});
        const failedCount = outcomes.filter((item) => !item.ok).length;
        updateStatus(failedCount ? `批次已处理完成，${failedCount} 个商品待人工检查` : "全部筛选商品已处理并派发发布", failedCount ? "blocked" : "ready");
        audit("offsale_batch_complete", { productCount: products.length, failedCount, outcome: "serial_auto_publish" });
      }
    } catch (caught) {
      const state = caught?.code === "UPDATE_PAUSED" ? "paused" : "blocked";
      if (currentProduct && caught?.code !== "UPDATE_PAUSED") updateProductFailureSummary(currentProduct, caught, currentStage);
      updateStatus(state === "paused" ? "已暂停，后续商品未执行" : "当前商品失败，编辑页已保留待检查", state);
      audit("offsale_batch_stopped", {
        scope, code: caught?.code || "UPDATE_OFFSALE_RUN_FAILED",
        outcomeUnknown: caught?.evidence?.outcomeUnknown === true,
        remediation: "检查日志和保留的编辑页后重新开始新的下架任务"
      });
    } finally {
      if (listTab && Number.isInteger(originalPage)) {
        try {
          const observed = await send(listTab.id, contract.COMMANDS.OBSERVE_LIST);
          if (observed.result.currentPage !== originalPage) {
            const restored = await send(listTab.id, contract.COMMANDS.GO_PAGE, { pageNo: originalPage }, observed.documentToken);
            listDocumentToken = restored.documentToken;
          }
        } catch (_) {}
      }
      if (listTab) await abortTab(listTab, listDocumentToken).catch(() => {});
      if (currentEditTab) await abortTab(currentEditTab, currentEditDocumentToken).catch(() => {});
      running = false;
      activeRunPlan = null;
      auditContext = Object.freeze({});
      setReplaceMaterialInputsDisabled(false);
      if (imageSwapInput) imageSwapInput.disabled = false;
      priceInventoryEnabled.disabled = false;
      if (skuImagesEnabled) skuImagesEnabled.disabled = false;
      offsaleSpecifications.disabled = false;
      for (const control of document.querySelectorAll('input[name="updateOffsaleScope"], input[name="updateImageSwapScope"], [data-update-submode]')) control.disabled = false;
      pauseButton.disabled = true;
      refreshRecoveryUi();
      refreshUpdateRunButton();
    }
  }

  function pageImageSwapPlan(initialStructure, frozenPlan) {
    const expectedSpecs = (initialStructure.result?.editorSpecs || []).map((row) => row.specification);
    const eligibleRows = expectedSpecs
      .map((specification, index) => ({ index, specification }))
      .filter((row) => skuPlanner.parseSpecificationKey(row.specification));
    const unparseableCount = expectedSpecs.length - eligibleRows.length;
    if (eligibleRows.length === 0) {
      return Object.freeze({
        expectedSpecs: Object.freeze(expectedSpecs),
        rows: Object.freeze([]),
        unparseableCount,
        unmatchedSpecCount: 0,
        skippedCount: expectedSpecs.length,
        unusedImageCount: frozenPlan.images.length
      });
    }
    const matched = skuPlanner.buildSkuImagePlan(eligibleRows, frozenPlan.images, { allowMissing: true });
    if (!matched.ok) {
      fail("UPDATE_SKU_IMAGE_PAGE_PLAN_INVALID", matched.errorMessage || "当前商品规格与冻结图片无法形成确定匹配，未上传任何图片。", {
        productId: initialStructure.result?.productId || null,
        issues: matched.issues
      });
    }
    const rows = matched.rows.filter((row) => row.image).map((row) => Object.freeze({
      specification: row.specification,
      image: row.image.payload,
      imageIdentity: row.image.identity,
      imageName: row.image.name
    }));
    return Object.freeze({
      expectedSpecs: Object.freeze(expectedSpecs),
      rows: Object.freeze(rows),
      unparseableCount,
      unmatchedSpecCount: matched.rows.filter((row) => !row.image).length,
      skippedCount: expectedSpecs.length - rows.length,
      unusedImageCount: matched.unmatchedImages.length
    });
  }

  async function executeImageSwapRows(tab, documentToken, productId, pagePlan) {
    const records = [];
    const mutationReceipts = [];
    for (const row of pagePlan.rows) {
      assertReady();
      const evidence = await send(tab.id, contract.COMMANDS.REPLACE_SKU_IMAGE, {
        productId,
        expectedSpecs: pagePlan.expectedSpecs,
        specification: row.specification,
        image: row.image,
        imageIdentity: row.imageIdentity
      }, documentToken);
      const result = evidence.result?.result || {};
      records.push(Object.freeze({ specification: row.specification, imageName: row.imageName, action: result.action || "unknown" }));
      if (["replace", "upload"].includes(result.action)) mutationReceipts.push(completedMutationReceipt(evidence));
      audit("image_swap_row_verified", {
        productId,
        specification: row.specification,
        imageName: row.imageName,
        action: result.action || "unknown",
        commandId: evidence.commandId || null
      });
    }
    return Object.freeze({
      productId,
      matchedCount: records.length,
      replacedCount: records.filter((item) => item.action === "replace").length,
      uploadedCount: records.filter((item) => item.action === "upload").length,
      unchangedCount: records.filter((item) => item.action === "already_target").length,
      actionCount: records.filter((item) => ["replace", "upload"].includes(item.action)).length,
      mutationReceipts: Object.freeze(mutationReceipts.filter(Boolean)),
      unparseableCount: pagePlan.unparseableCount,
      unmatchedSpecCount: pagePlan.unmatchedSpecCount,
      skippedCount: pagePlan.skippedCount,
      unusedImageCount: pagePlan.unusedImageCount,
      noMatch: pagePlan.rows.length === 0,
      records: Object.freeze(records)
    });
  }

  function imageSwapReceiptSummary(receipt) {
    return `替换 ${receipt.replacedCount}，上传 ${receipt.uploadedCount}，目标已存在 ${receipt.unchangedCount}，未匹配规格 ${receipt.unmatchedSpecCount}，不可解析规格 ${receipt.unparseableCount}，未使用图片 ${receipt.unusedImageCount}`;
  }

  function priceInventoryReceiptSummary(receipt, plan) {
    const imageDetail = plan.skuImages?.intent === "replace_sku_images"
      ? `SKU 图上传 ${receipt.imageUploadCount}，缺图跳过 ${receipt.imageDeferredCount}`
      : "SKU 图未启用";
    const skuCount = receipt?.skuCount ?? receipt?.matchedCount ?? 0;
    const retiredWarning = receipt?.retiredCount
      ? `；待手动删除 ${receipt.retiredCount} 个旧 SKU`
      : "";
    return `价格库存 ${skuCount} 个 SKU 已填写；${imageDetail}${retiredWarning}`;
  }

  async function processImageSwapProduct(listTab, listIdentity, product, index, total, plan) {
    assertReady();
    auditContext = Object.freeze({ productId: product.productId, productIndex: index + 1, productTotal: total });
    updateProductSummary(product, { state: "running", detail: "正在打开编辑页" });
    updateStatus(`换图 ${index + 1}/${total}：${product.productId}`, "running");
    let editTab = null;
    let documentToken = null;
    let stage = "打开编辑页";
    try {
      const listEvidence = await moveToFrozenProductPage(listTab, listIdentity, product);
      editTab = await openedEditTab(listTab, product, listEvidence.documentToken);
      await activateTaskTab(editTab, "UPDATE_EDIT_FOREGROUND_TIMEOUT", `商品 ${product.productId} 编辑页`);
      stage = "读取商品规格";
      const initial = await readStructureWhenReady(editTab, product.productId);
      documentToken = initial.documentToken;
      stage = "匹配并更换 SKU 图";
      const pagePlan = pageImageSwapPlan(initial, plan);
      audit("image_swap_page_planned", {
        productId: product.productId,
        matchedCount: pagePlan.rows.length,
        unparseableCount: pagePlan.unparseableCount,
        unmatchedSpecCount: pagePlan.unmatchedSpecCount,
        unusedImageCount: pagePlan.unusedImageCount
      });
      const receipt = await executeImageSwapRows(editTab, documentToken, product.productId, pagePlan);
      stage = "自动发布";
      const publication = await publishModifiedProduct(editTab, documentToken, product, plan, "image-swap", receipt);
      updateProductSummary(product, publication.state === "skipped"
        ? { state: "skipped", detail: `${imageSwapReceiptSummary(receipt)}；无实际换图，未发布；${publication.tabClose.message}` }
        : { state: "publish_confirmed", detail: `替换 ${receipt.replacedCount}，上传 ${receipt.uploadedCount}；${publication.tabClose.message}` });
      audit(publication.state === "skipped" ? "image_swap_product_skipped" : "image_swap_product_published", { ...receipt, publication });
      return Object.freeze({ ...receipt, publication });
    } catch (caught) {
      if (caught?.code === "UPDATE_PAUSED") updateProductSummary(product, { state: "paused", detail: "已暂停，当前商品未继续执行" });
      else updateProductFailureSummary(product, caught, stage);
      audit("image_swap_product_blocked", {
        code: caught?.code || "UPDATE_SKU_IMAGE_PRODUCT_BLOCKED",
        outcomeUnknown: caught?.evidence?.outcomeUnknown === true,
        stage,
        remediation: caught?.evidence?.fix || "保留编辑页，依据日志与页面回读人工核对后重新执行该商品"
      });
      throw caught;
    } finally {
      if (editTab) await abortTab(editTab, documentToken).catch(() => {});
    }
  }

  async function runImageSwap() {
    if (running || !imageSwapPlan) return;
    const plan = imageSwapPlan;
    const scope = selectedImageSwapScope();
    running = true;
    paused = false;
    activeRunPlan = plan;
    activeBatchCheckpoint = null;
    auditContext = Object.freeze({});
    auditLines = [];
    render("");
    runToken = `update-image-swap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    refreshUpdateRunButton();
    pauseButton.disabled = false;
    setReplaceMaterialInputsDisabled(true);
    if (imageSwapInput) imageSwapInput.disabled = true;
    priceInventoryEnabled.disabled = true;
    if (skuImagesEnabled) skuImagesEnabled.disabled = true;
    offsaleSpecifications.disabled = true;
    for (const control of document.querySelectorAll('input[name="updateOffsaleScope"], input[name="updateImageSwapScope"], [data-update-submode]')) control.disabled = true;
    let listTab = null;
    let listDocumentToken = null;
    let originalPage = null;
    let currentEditTab = null;
    let currentEditDocumentToken = null;
    let currentProduct = null;
    let currentStage = "打开编辑页";
    try {
      if (scope === "current") {
        currentEditTab = await activeMerchantTab();
        const product = currentProduct = editProductIdentity(currentEditTab);
        const accepted = globalThis.confirm?.(`将仅在当前商品 ${product.productId} 中按命名规则匹配 ${plan.images.length} 张新 SKU 图。\n\n有图本地替换，无图本地上传；实际换图并完成发布记录后自动关闭编辑页，无匹配直接关闭，故障时保留编辑页。`);
        if (accepted !== true) fail("UPDATE_CONFIRMATION_DECLINED", "已取消，本次没有修改商品。", {});
        resetProductSummaries([product]);
        auditContext = Object.freeze({ productId: product.productId, productIndex: 1, productTotal: 1 });
        updateProductSummary(product, { state: "running", detail: "正在读取当前编辑页" });
        await activateTaskTab(currentEditTab, "UPDATE_EDIT_FOREGROUND_TIMEOUT", `商品 ${product.productId} 编辑页`);
        currentStage = "读取商品规格";
        const initial = await readStructureWhenReady(currentEditTab, product.productId);
        currentEditDocumentToken = initial.documentToken;
        const pagePlan = pageImageSwapPlan(initial, plan);
        audit("image_swap_page_planned", {
          productId: product.productId,
          matchedCount: pagePlan.rows.length,
          unparseableCount: pagePlan.unparseableCount,
          unmatchedSpecCount: pagePlan.unmatchedSpecCount,
          unusedImageCount: pagePlan.unusedImageCount
        });
        currentStage = "匹配并更换 SKU 图";
        const receipt = await executeImageSwapRows(currentEditTab, currentEditDocumentToken, product.productId, pagePlan);
        currentStage = "自动发布";
        const publication = await publishModifiedProduct(currentEditTab, currentEditDocumentToken, product, plan, "image-swap", receipt);
        updateProductSummary(product, publication.state === "skipped"
          ? { state: "skipped", detail: `${imageSwapReceiptSummary(receipt)}；无实际换图，未发布；${publication.tabClose.message}` }
          : { state: "publish_confirmed", detail: `替换 ${receipt.replacedCount}，上传 ${receipt.uploadedCount}；${publication.tabClose.message}` });
        updateStatus(publication.tabClose.message, "ready");
        audit("image_swap_current_complete", { ...receipt, publication });
      } else {
        listTab = await activeMerchantTab();
        const listIdentity = listPageIdentity(listTab);
        const initial = await send(listTab.id, contract.COMMANDS.OBSERVE_LIST);
        listDocumentToken = initial.documentToken;
        const collected = await collectFiltered(listTab, initial, { persist: false });
        listDocumentToken = collected.documentToken;
        originalPage = collected.originalPage;
        const products = collected.frozen.entries;
        const accepted = globalThis.confirm?.(`将按当前筛选顺序处理 ${products.length} 个商品，并按命名规则匹配 ${plan.images.length} 张新 SKU 图。\n\n有图本地替换，无图本地上传；实际换图并完成发布记录后自动关闭编辑页，无匹配商品直接关闭，故障商品保留，并继续下一商品。`);
        if (accepted !== true) fail("UPDATE_CONFIRMATION_DECLINED", "已取消，本次没有修改商品。", {});
        resetProductSummaries(products);
        const positioned = await positionListAtPage(listTab, listIdentity, products[0]?.pageNo || 1);
        listDocumentToken = positioned.documentToken;
        const outcomes = await processFrozenProducts(listTab, listIdentity, products, plan, processImageSwapProduct, 0);
        auditContext = Object.freeze({});
        const failedCount = outcomes.filter((item) => !item.ok).length;
        updateStatus(failedCount ? `批次已处理完成，${failedCount} 个商品待人工检查` : "全部筛选商品已换图并派发发布", failedCount ? "blocked" : "ready");
        audit("image_swap_batch_complete", { productCount: products.length, failedCount, outcome: "serial_auto_publish" });
      }
    } catch (caught) {
      const state = caught?.code === "UPDATE_PAUSED" ? "paused" : "blocked";
      if (currentProduct && caught?.code !== "UPDATE_PAUSED") updateProductFailureSummary(currentProduct, caught, currentStage);
      updateStatus(state === "paused" ? "已暂停，后续商品未执行" : "当前商品失败，编辑页已保留待检查", state);
      audit("image_swap_batch_stopped", {
        scope,
        code: caught?.code || "UPDATE_SKU_IMAGE_RUN_FAILED",
        outcomeUnknown: caught?.evidence?.outcomeUnknown === true,
        remediation: "检查日志和保留的编辑页后重新开始新的换图任务"
      });
    } finally {
      if (listTab && Number.isInteger(originalPage)) {
        try {
          const observed = await send(listTab.id, contract.COMMANDS.OBSERVE_LIST);
          if (observed.result.currentPage !== originalPage) {
            const restored = await send(listTab.id, contract.COMMANDS.GO_PAGE, { pageNo: originalPage }, observed.documentToken);
            listDocumentToken = restored.documentToken;
          }
        } catch (_) {}
      }
      if (listTab) await abortTab(listTab, listDocumentToken).catch(() => {});
      if (currentEditTab) await abortTab(currentEditTab, currentEditDocumentToken).catch(() => {});
      running = false;
      activeRunPlan = null;
      auditContext = Object.freeze({});
      setReplaceMaterialInputsDisabled(false);
      if (imageSwapInput) imageSwapInput.disabled = false;
      priceInventoryEnabled.disabled = false;
      if (skuImagesEnabled) skuImagesEnabled.disabled = false;
      offsaleSpecifications.disabled = false;
      for (const control of document.querySelectorAll('input[name="updateOffsaleScope"], input[name="updateImageSwapScope"], [data-update-submode]')) control.disabled = false;
      pauseButton.disabled = true;
      refreshRecoveryUi();
      refreshUpdateRunButton();
    }
  }

  async function executePriceInventory(tab, documentToken, productId, initialStructure, plan = materialPlan, options = {}) {
    const target = plan.priceInventory;
    if (target.intent !== "replace_group") return initialStructure;
    if (options.washLink === true) {
      const washArgs = {
        productId,
        rows: target.rows,
        targetDigest: target.targetDigest,
        phase: options.washPhase
      };
      if (options.reviewStructure) washArgs.reviewStructure = options.reviewStructure;
      let evidence;
      try {
        evidence = await send(tab.id, contract.COMMANDS.WASH_LINK, washArgs, documentToken);
      } catch (caught) {
        const missingLegacyBaseline = caught?.code === "UPDATE_WASH_LINK_CHECKPOINT_RECONCILE_REQUIRED" &&
          Array.isArray(caught?.evidence?.differences) &&
          caught.evidence.differences.length === 1 &&
          caught.evidence.differences[0] === "断点缺少可核对的原始 SKU 清单";
        if (!missingLegacyBaseline) throw caught;
        const confirmed = globalThis.confirm?.("检测到旧版本断点没有原始 SKU 清单，本次尚未写入商品。请确认当前页面确实没有出现待新增规格，且已有 SKU 的价格和商家编码没有变化。确认后，插件将以当前稳定读取的 SKU 表重新生成清单，并只执行你刚刚选择的阶段；不确定时请取消。") === true;
        if (!confirmed) throw caught;
        evidence = await send(tab.id, contract.COMMANDS.WASH_LINK, {
          ...washArgs,
          reconcileLegacyCheckpoint: true
        }, documentToken);
      }
      return evidence.result?.result || evidence.result || {};
    }
    const resumeExistingSpecs = options.resumeExistingSpecs === true;
    if (initialStructure.result.empty === true || !initialStructure.result.specificationType) {
      fail("UPDATE_SPECIFICATION_TYPE_NAME_UNPROVEN", `商品 ${productId} 当前规格结构为空，无法证明删除前应选择“规格”还是“商品规格”；本次未创建规格类型。`, {
        productId,
        empty: initialStructure.result.empty === true,
        dispatched: false
      });
    }
    const specificationType = contract.assertSpecificationType(initialStructure.result.specificationType);
    assertReady();
    const mutationReceipts = [];
    const expectedSpecs = target.rows.map((row) => row.specification);
    let nextSpecificationIndex = 0;
    let resumedSpecificationCount = 0;
    if (resumeExistingSpecs) {
      if (initialStructure.result.groupCount !== 1 || initialStructure.result.dimensionCount !== 1) {
        fail("UPDATE_CURRENT_RESUME_STRUCTURE_INVALID", "当前编辑页不是唯一的一维规格组，不能安全续跑。", {
          productId,
          groupCount: initialStructure.result.groupCount,
          dimensionCount: initialStructure.result.dimensionCount,
          dispatched: false
        });
      }
      const decision = contract.resumeSpecificationDecision({
        expectedSpecs,
        observedFilled: Array.from(initialStructure.result.editorSpecs || []).map((row) => row.specification)
      });
      nextSpecificationIndex = decision.nextIndex;
      resumedSpecificationCount = decision.completedCount;
      audit("current_editor_resume_validated", {
        productId,
        resumedSpecificationCount,
        remainingSpecificationCount: expectedSpecs.length - resumedSpecificationCount,
        targetDigest: target.targetDigest
      });
    } else {
      const deletion = await send(tab.id, contract.COMMANDS.DELETE_SPEC_GROUP, {
        productId,
        expectedSpecificationType: specificationType,
        expectedGroupGuardShape: initialStructure.result.guardShape,
        targetDigest: target.targetDigest
      }, documentToken);
      mutationReceipts.push(completedMutationReceipt(deletion));
      if (deletion.result?.specificationType !== specificationType) {
        fail("UPDATE_SPECIFICATION_TYPE_RECEIPT_MISMATCH", `商品 ${productId} 删除回执中的规格类型名称不一致，未创建新规格。`, {
          productId,
          expectedSpecificationType: specificationType,
          actualSpecificationType: deletion.result?.specificationType || null
        });
      }
      assertReady();
      mutationReceipts.push(completedMutationReceipt(await send(tab.id, contract.COMMANDS.CREATE_SPECIFICATION_GROUP, { expectedSpecs, specificationType }, documentToken)));
    }
    for (let index = nextSpecificationIndex; index < target.rows.length; index += 1) {
      assertReady();
      const stepArgs = {
        expectedSpecs,
        specificationType,
        specification: target.rows[index].specification,
        index
      };
      if (options.interactionProfile) stepArgs.interactionProfile = options.interactionProfile;
      mutationReceipts.push(completedMutationReceipt(await send(tab.id, contract.COMMANDS.CREATE_SPECIFICATION_STEP, stepArgs, documentToken)));
    }
    for (const row of target.rows) {
      assertReady();
      const args = {
        expectedSpecs,
        specification: row.specification,
        price: row.price,
        stock: row.stock,
        merchantCode: row.merchantCode,
        imageMode: row.imageMode
      };
      if (row.imageMode === "upload") args.image = row.image;
      mutationReceipts.push(completedMutationReceipt(await send(tab.id, contract.COMMANDS.FILL_SKU_ROW, args, documentToken)));
    }
    const expectedStocks = target.rows.map((row) => ({ specification: row.specification, stock: row.stock }));
    assertReady();
    mutationReceipts.push(completedMutationReceipt(await send(tab.id, contract.COMMANDS.SET_BATCH_STOCK, { expectedStocks }, documentToken)));
    assertReady();
    const stockVerification = await send(tab.id, contract.COMMANDS.VERIFY_SKU_STOCK, { expectedSpecs, expectedStocks }, documentToken);
    assertReady();
    return Object.freeze({
      productId,
      targetDigest: target.targetDigest,
      skuCount: target.rows.length,
      resumedSpecificationCount,
      imageUploadCount: target.rows.filter((row) => row.imageMode === "upload").length,
      imageDeferredCount: target.rows.filter((row) => row.imageMode === "deferred_missing").length,
      actionCount: target.rows.length,
      mutationReceipts: Object.freeze(mutationReceipts.filter(Boolean)),
      verificationMode: "command_receipts",
      verifiedVisibleStockRows: stockVerification.result?.verifiedVisibleCount ?? null
    });
  }


  async function abortTab(tab, documentToken) {
    if (!tab?.id) return;
    await send(tab.id, contract.COMMANDS.ABORT, {}, documentToken);
  }

  async function processProduct(listTab, listIdentity, product, index, total, plan) {
    assertReady();
    auditContext = Object.freeze({ productId: product.productId, productIndex: index + 1, productTotal: total });
    const priorOutcomeUnknown = activeBatchCheckpoint?.outcomeUnknown === true;
    updateBatchCheckpoint({
      nextIndex: index,
      currentIndex: index,
      currentProductId: product.productId,
      mutationStarted: false,
      outcomeUnknown: priorOutcomeUnknown,
      retrySafety: priorOutcomeUnknown ? "manual_reconcile" : "safe_retry"
    });
    await persistProgress("product_opening", { productId: product.productId, index });
    updateProductSummary(product, { state: "running", detail: "正在打开编辑页" });
    updateStatus(`处理 ${index + 1}/${total}：${product.productId}`, "running");
    let editTab = null;
    let documentToken = null;
    let stage = "打开编辑页";
    try {
      const listEvidence = await moveToFrozenProductPage(listTab, listIdentity, product);
      editTab = await openedEditTab(listTab, product, listEvidence.documentToken);
      await activateTaskTab(editTab, "UPDATE_EDIT_FOREGROUND_TIMEOUT", `商品 ${product.productId} 编辑页`);
      const replacingPriceInventory = plan.priceInventory.intent === "replace_group";
      stage = replacingPriceInventory ? "读取 SKU 表" : "读取商品规格";
      const initial = replacingPriceInventory
        ? await readReplaceGroupWhenReady(editTab, product.productId)
        : await readStructureWhenReady(editTab, product.productId);
      documentToken = initial.documentToken;
      await persistProgress("product_ready", { productId: product.productId, index });
      audit("product_structure_ready", { index: index + 1, total, productId: product.productId, structureDigest: initial.result.structureDigest, readMode: replacingPriceInventory ? "replace_group_light" : "editor_structure" });
      updateBatchCheckpoint({ mutationStarted: true, retrySafety: "manual_reconcile" });
      await persistProgress("product_mutating", { productId: product.productId, index });
      stage = replacingPriceInventory ? (updateSubmode === "wash" ? "洗链接" : "重建价格库存") : "匹配并更换 SKU 图";
      const receipt = replacingPriceInventory
        ? await executePriceInventory(editTab, documentToken, product.productId, initial, plan, { washLink: updateSubmode === "wash" })
        : await executeImageSwapRows(editTab, documentToken, product.productId, pageImageSwapPlan(initial, plan.skuImages));
      assertReady();
      audit("product_replace_completed", {
        index: index + 1,
        total,
        productId: product.productId,
        targetDigest: receipt.targetDigest || plan.skuImages.planDigest,
        skuCount: receipt.skuCount || receipt.matchedCount,
        verificationMode: receipt.verificationMode || "sku_image_readback",
        published: false
      });
      updateProductSummary(product, {
        state: "replace_completed",
        detail: replacingPriceInventory
          ? `${priceInventoryReceiptSummary(receipt, plan)}；未发布，编辑页已保留`
          : `SKU 图 ${imageSwapReceiptSummary(receipt)}；未发布，编辑页已保留`
      });
      const completedSession = Object.freeze({ productId: product.productId, tabId: editTab.id, documentToken });
      updateBatchCheckpoint({
        completedProductIds: Object.freeze([...activeBatchCheckpoint.completedProductIds, product.productId]),
        completedSessions: Object.freeze([...activeBatchCheckpoint.completedSessions, completedSession]),
        nextIndex: index + 1,
        currentIndex: null,
        currentProductId: null,
        mutationStarted: false,
        outcomeUnknown: priorOutcomeUnknown || receipt.manualReconcileRequired === true,
        retrySafety: priorOutcomeUnknown || receipt.manualReconcileRequired === true ? "manual_reconcile" : "safe_retry"
      });
      await persistProgress("replace_completed", {
        productId: product.productId,
        index,
        receipt,
        published: false
      });
    } catch (caught) {
      const outcomeUnknown = caught?.evidence?.outcomeUnknown === true;
      const mutationStarted = activeBatchCheckpoint?.mutationStarted === true;
      updateBatchCheckpoint({
        nextIndex: index,
        currentIndex: index,
        currentProductId: product.productId,
        outcomeUnknown: priorOutcomeUnknown || outcomeUnknown,
        retrySafety: !mutationStarted && !priorOutcomeUnknown && !outcomeUnknown ? "safe_retry" : "manual_reconcile"
      });
      const view = caught?.code === "UPDATE_PAUSED"
        ? (updateProductSummary(product, { state: "paused", detail: "已暂停，当前商品未继续执行" }), null)
        : updateProductFailureSummary(product, caught, stage);
      audit("product_blocked", { index: index + 1, total, productId: product.productId, stage, code: caught?.code || "UPDATE_PRODUCT_BLOCKED", remediation: view?.advice || "保留编辑页，人工核对后重新执行该商品" });
      await persistProgress("product_blocked", {
        productId: product.productId,
        index,
        errorCode: caught?.code || "UPDATE_PRODUCT_BLOCKED",
        errorMessage: caught?.message || String(caught),
        outcomeUnknown
      }).catch(() => {});
      throw caught;
    } finally {
      if (editTab) await abortTab(editTab, documentToken).catch(() => {});
    }
  }

  async function processFrozenProducts(listTab, listIdentity, products, plan, handler = processProduct, startIndex = 0) {
    const outcomes = [];
    for (let index = startIndex; index < products.length; index += 1) {
      if (index > startIndex) {
        audit("serial_product_handoff", {
          fromProductId: products[index - 1].productId,
          toProductId: products[index].productId,
          nextIndex: index + 1,
          total: products.length,
          sourcePage: products[index].pageNo
        });
      }
      try {
        const result = await handler(listTab, listIdentity, products[index], index, products.length, plan);
        outcomes.push(Object.freeze({
          productId: products[index].productId,
          ok: true,
          outcomeUnknown: result?.manualReconcileRequired === true,
          result
        }));
      } catch (caught) {
        if (caught?.code === "UPDATE_PAUSED") throw caught;
        const view = updateProductFailureSummary(products[index], caught, /^UPDATE_PUBLISH_/.test(String(caught?.code || "")) ? "自动发布" : "修改");
        const decision = await askProductFailureDecision(products[index], caught, "修改", { canSkip: true });
        if (decision !== "skip") {
          const stopped = Object.assign(new Error("已按你的选择停止任务，当前商品编辑页已保留。"), {
            code: "UPDATE_USER_STOPPED_AFTER_FAILURE",
            evidence: { outcomeUnknown: view.outcomeUnknown === true, fix: "检查当前商品编辑页后，再新建任务或继续后续商品。" }
          });
          throw stopped;
        }
        outcomes.push(Object.freeze({ productId: products[index].productId, ok: false, code: view.code, outcomeUnknown: view.outcomeUnknown }));
        audit("serial_product_skipped_after_failure", {
          productId: products[index].productId,
          code: view.code,
          outcomeUnknown: view.outcomeUnknown,
          remediation: view.advice,
          nextProductId: products[index + 1]?.productId || null
        });
        if (activeBatchCheckpoint) updateBatchCheckpoint({
          nextIndex: index + 1,
          currentIndex: null,
          currentProductId: null,
          outcomeUnknown: activeBatchCheckpoint.outcomeUnknown === true || view.outcomeUnknown,
          retrySafety: "manual_reconcile"
        });
      }
    }
    return Object.freeze(outcomes);
  }

  async function handleWashAddClick() {
    if (running) {
      updateStatus("当前有任务正在运行，请等待完成后再点击新增规格", "running");
      return;
    }
    if (updateSubmode !== "wash") {
      updateStatus("请先切换到洗链接模式，再点击新增规格", "blocked");
      return;
    }
    if (!materialPlan) {
      updateStatus("新增规格没有反应：请先重新载入规格 Excel 和价格表材料", "blocked");
      return;
    }
    if (!selectedReplaceModules().priceInventory || materialPlan.priceInventory?.intent !== "replace_group") {
      updateStatus("新增规格需要已冻结的规格 Excel 和价格表材料", "blocked");
      return;
    }
    updateStatus(`新增按钮已触发：正在准备当前商品的 ${displayedWashReview?.review?.added?.length || 0} 条新增规格`, "running");
    await runCurrentReplace({ washPhase: "add" });
  }

  async function runCurrentReplace(options = {}) {
    const resumeExistingSpecs = options.resumeExistingSpecs === true;
    const washPhase = options.washPhase || "";
    const modules = selectedReplaceModules();
    if (running) {
      updateStatus("当前有任务正在运行，请等待完成后再试", "running");
      return;
    }
    if (!materialPlan || (!modules.priceInventory && !modules.skuImages) ||
      (resumeExistingSpecs && !modules.priceInventory)) {
      updateStatus("材料计划尚未就绪，请检查材料后重新解析", "blocked");
      return;
    }
    if (washPhase && (!['add', 'modify'].includes(washPhase) || updateSubmode !== "wash" ||
      (washPhase === "modify" && !pendingWashReview))) {
      updateStatus("请切换到洗链接模式并先核实当前商品规格", "blocked");
      return;
    }
    if (washPhase === "add" && (!modules.priceInventory || materialPlan.priceInventory?.intent !== "replace_group")) {
      updateStatus("新增规格需要已冻结的规格 Excel 和价格表材料", "blocked");
      return;
    }
    const plan = materialPlan;
    running = true;
    paused = false;
    activeRunPlan = plan;
    activeBatchCheckpoint = null;
    auditContext = Object.freeze({});
    auditLines = [];
    render("");
    runToken = `update-current-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    runButton.disabled = true;
    if (washAddButton) washAddButton.disabled = true;
    if (washModifyButton) washModifyButton.disabled = true;
    if (continueCurrentButton) continueCurrentButton.disabled = true;
    refreshRecoveryUi();
    pauseButton.disabled = false;
    setReplaceMaterialInputsDisabled(true);
    if (imageSwapInput) imageSwapInput.disabled = true;
    priceInventoryEnabled.disabled = true;
    if (skuImagesEnabled) skuImagesEnabled.disabled = true;
    for (const control of document.querySelectorAll('input[name="updateReplaceScope"], [data-update-submode]')) control.disabled = true;
    if (productQueryInput) productQueryInput.disabled = true;
    let editTab = null;
    let documentToken = null;
    let product = null;
    let stage = "打开编辑页";
    try {
      editTab = await activeMerchantTab();
      product = editProductIdentity(editTab);
      const replacingPriceInventory = plan.priceInventory.intent === "replace_group";
      const washingLink = updateSubmode === "wash";
      if (washingLink && pendingWashReview && (pendingWashReview.productId !== product.productId || pendingWashReview.planDigest !== plan.planDigest)) pendingWashReview = null;
      const reviewOnly = washingLink && !pendingWashReview;
      const actionSummary = washPhase === "add"
        ? "仅新增清单中的新 SKU"
        : washPhase === "modify"
          ? "仅修改清单中已有 SKU"
          : resumeExistingSpecs
            ? "继续当前编辑页的未完成规格、价格和库存"
            : (reviewOnly ? "核实当前商品规格（只读）" : (washingLink ? "洗链接阶段" : replacingPriceInventory ? "整组重建价格库存" : "替换匹配 SKU 图片"));
      const safetySummary = washPhase === "add"
        ? "只新增缺失 SKU，价格和商家编码按 Excel，库存固定为 999；不会修改已有 SKU。"
        : washPhase === "modify"
          ? "只修改已有 SKU 的价格和商家编码，不读取或调整旧 SKU 库存；新增与修改可任意顺序分别执行。"
          : resumeExistingSpecs
            ? "确认后先比对页面已填规格与 Excel；一致时从首条未完成规格继续，不删除现有规格。"
            : (reviewOnly ? "本次只读取 SKU 表并显示核实清单，不会修改价格、库存、商家编码或规格。" : (washingLink ? "新增与修改没有固定先后顺序。请在清单中手动选择并点击对应按钮；旧 SKU 库存不读取或调整，新 SKU 库存固定为 999。" : replacingPriceInventory ? "确认后会删除当前唯一规格组并按冻结材料重建。" : "只会按冻结图片匹配当前 SKU，不改价格库存。"));
      const confirmationTail = reviewOnly ? "读取完成后保留编辑页，不会写入。" : "替换完成后不发布，编辑页保留。";
      const accepted = washPhase
        ? true
        : globalThis.confirm?.(`将仅对当前商品 ${product.productId}${actionSummary}。\n\n${planSummary(plan)}\n\n${safetySummary}${confirmationTail}`);
      if (accepted !== true) fail("UPDATE_CONFIRMATION_DECLINED", "已取消，本次没有修改商品。", {});
      resetProductSummaries([product]);
      auditContext = Object.freeze({ productId: product.productId, productIndex: 1, productTotal: 1 });
      updateProductSummary(product, { state: "running", detail: "正在读取当前编辑页" });
      updateStatus(`替换 1/1：${product.productId}`, "running");
      await activateTaskTab(editTab, "UPDATE_EDIT_FOREGROUND_TIMEOUT", `商品 ${product.productId} 编辑页`);
      stage = resumeExistingSpecs ? "核对已填写规格" : (replacingPriceInventory ? "读取规格组" : "读取商品规格");
      const cachedWashReview = washPhase && pendingWashReview?.productId === product.productId &&
        pendingWashReview?.planDigest === plan.planDigest && pendingWashReview?.initialStructure?.documentToken
        ? pendingWashReview
        : null;
      const initial = cachedWashReview?.initialStructure || (replacingPriceInventory
        ? (resumeExistingSpecs
          ? await readStructureWhenReady(editTab, product.productId)
          : (washingLink ? await readStructureWhenReady(editTab, product.productId) : await readReplaceGroupWhenReady(editTab, product.productId)))
        : await readStructureWhenReady(editTab, product.productId));
      documentToken = initial.documentToken;
      audit("product_structure_ready", {
        index: 1,
        total: 1,
        productId: product.productId,
        structureDigest: initial.result.structureDigest,
        readMode: resumeExistingSpecs ? "current_resume_structure" : (washingLink ? "wash_link_review_structure" : (replacingPriceInventory ? "replace_group_light" : "editor_structure")),
        scope: "current"
      });
      if (reviewOnly) {
        const review = washReviewPlan(initial, plan);
        washReviewFilter = null;
        pendingWashReview = Object.freeze({ productId: product.productId, planDigest: plan.planDigest, review, initialStructure: initial });
        renderWashReview(review, product.productId);
        updateProductSummary(product, { state: "waiting", detail: `规格核实完成：修改 ${review.rows.filter((row) => row.status === "修改").length}，新增 ${review.rows.filter((row) => row.status === "新增").length}，待删除 ${review.rows.filter((row) => row.status === "待删除").length}` });
        updateStatus("规格清单已就绪：新增和修改可任意顺序手动选择", "ready");
        audit("wash_link_review_ready", { productId: product.productId, rowCount: review.rows.length, matchedCount: review.matched.length, addedCount: review.added.length, retiredCount: review.retired.length });
        refreshUpdateRunButton();
        if (washPhase !== "add") return;
      }
      if (washingLink && !washPhase) {
        updateStatus("请在规格清单中手动选择“新增”或“修改”后执行", "ready");
        return;
      }
      stage = resumeExistingSpecs ? "续跑价格库存" : (replacingPriceInventory ? (updateSubmode === "wash" ? "洗链接" : "重建价格库存") : "匹配并更换 SKU 图");
      const receipt = replacingPriceInventory
        ? await executePriceInventory(editTab, documentToken, product.productId, initial, plan, {
          interactionProfile: "current_reused_page",
          resumeExistingSpecs,
          washLink: updateSubmode === "wash",
          washPhase,
          reviewStructure: washPhase ? initial.result : null
        })
        : await executeImageSwapRows(editTab, documentToken, product.productId, pageImageSwapPlan(initial, plan.skuImages));
      assertReady();
      updateProductSummary(product, {
        state: washingLink && receipt.workflowComplete === false ? "phase_pending" : "replace_completed",
        detail: washingLink && receipt.workflowComplete === false
          ? `${receipt.checkpointReconciled ? "旧断点已核对；" : ""}${washPhase === "add" ? "新增阶段" : "已有 SKU 修改阶段"}完成；${receipt.manualReconcileRequired && receipt.blockedPhase === "add" ? "新增结果仍待核对，请勿重复新增；" : ""}新增与修改可任意顺序选择，另一阶段待手动执行；未发布，编辑页已保留`
          : replacingPriceInventory
          ? `${resumeExistingSpecs ? `已续跑 ${receipt.resumedSpecificationCount} 条既有规格；` : ""}${priceInventoryReceiptSummary(receipt, plan)}；未发布，编辑页已保留`
          : `SKU 图 ${imageSwapReceiptSummary(receipt)}；未发布，编辑页已保留`
      });
      updateStatus(washingLink && receipt.workflowComplete === false ? `${receipt.checkpointReconciled ? "旧断点已安全核对并恢复；" : ""}${washPhase === "add" ? "新增阶段" : "已有 SKU 修改阶段"}已完成；${receipt.manualReconcileRequired && receipt.blockedPhase === "add" ? "新增结果仍待核对，请勿重复新增；" : ""}新增和修改可任意顺序，选择另一按钮继续` : replacingPriceInventory ? (resumeExistingSpecs ? "当前商品续跑完成，未发布" : (washingLink ? "新增和修改完成，未发布" : "当前商品替换完成，未发布")) : "当前商品 SKU 图替换完成，未发布", "ready");
      audit("replace_current_complete", {
        productId: product.productId,
        targetDigest: receipt.targetDigest || plan.skuImages.planDigest,
        skuCount: receipt.skuCount || receipt.matchedCount,
        verificationMode: receipt.verificationMode || "sku_image_readback",
        checkpointReconciled: receipt.checkpointReconciled === true,
        published: false
      });
      if (washingLink && receipt.workflowComplete === false) {
        const review = pendingWashReview?.productId === product.productId ? pendingWashReview.review : null;
        if (pendingWashReview) pendingWashReview = Object.freeze({
          ...pendingWashReview,
          addComplete: receipt.addPhaseComplete === true,
          modifyComplete: receipt.modifyPhaseComplete === true
        });
        if (review) renderWashReview(review, product.productId, {
          addComplete: receipt.addPhaseComplete === true,
          modifyComplete: receipt.modifyPhaseComplete === true
        });
      } else if (updateSubmode === "wash") {
        const labelWarning = receipt.retiredCount
          ? `新增和已有链接修改已完成；待删除旧 SKU ${receipt.retiredCount} 个，请按清单手动处理。\n\n`
          : "";
        const completedReview = pendingWashReview?.productId === product.productId ? pendingWashReview.review : null;
        pendingWashReview = null;
        const retiredRows = completedReview?.rows?.filter((row) => row.status === "待删除") || [];
        if (retiredRows.length) {
          renderWashReview({ rows: retiredRows }, product.productId, { phase: "manual_deletion" });
          updateProductSummary(product, {
            state: "replace_completed",
            detail: `修改与新增已完成；待手动删除 ${retiredRows.length} 条旧规格；未发布，编辑页已保留`
          });
          updateStatus(`修改完成，请最后手动删除 ${retiredRows.length} 条旧规格`, "ready");
          audit("wash_link_manual_deletion_ready", { productId: product.productId, retiredCount: retiredRows.length });
          globalThis.alert?.(`${labelWarning}洗链接修改已完成。请先按“待手动删除规格”清单删除旧规格，再到右侧手动点击自定义排序并保存。`);
        } else {
          globalThis.alert?.(`${labelWarning}洗链接已完成，请到右侧手动点击自定义排序，调整 SKU 顺序后手动保存`);
        }
        refreshUpdateRunButton();
      }
    } catch (caught) {
      const state = caught?.code === "UPDATE_PAUSED" ? "paused" : "blocked";
      const failureView = product && caught?.code !== "UPDATE_PAUSED"
        ? updateProductFailureSummary(product, caught, stage)
        : null;
      if (product && caught?.code !== "UPDATE_PAUSED") await askProductFailureDecision(product, caught, stage);
      const visibleFailure = washPhase === "add" && failureView?.detail
        ? failureView.detail
        : "当前商品失败，编辑页已保留待检查";
      updateStatus(state === "paused" ? "已暂停，当前商品未继续执行" : visibleFailure, state);
      audit("replace_current_blocked", {
        productId: product?.productId || null,
        stage,
        code: caught?.code || "UPDATE_CURRENT_REPLACE_FAILED",
        outcomeUnknown: caught?.evidence?.outcomeUnknown === true,
        reconciliationDifferences: Array.isArray(caught?.evidence?.differences) ? caught.evidence.differences.slice(0, 8) : undefined,
        remediation: caught?.evidence?.fix || "检查日志和保留的当前编辑页后重新执行"
      });
    } finally {
      if (editTab) await abortTab(editTab, documentToken).catch(() => {});
      running = false;
      activeRunPlan = null;
      auditContext = Object.freeze({});
      setReplaceMaterialInputsDisabled(false);
      if (imageSwapInput) imageSwapInput.disabled = false;
      priceInventoryEnabled.disabled = false;
      if (skuImagesEnabled) skuImagesEnabled.disabled = false;
      for (const control of document.querySelectorAll('input[name="updateReplaceScope"], [data-update-submode]')) control.disabled = false;
      pauseButton.disabled = true;
      refreshRecoveryUi();
      refreshReplaceScopeUi();
      refreshUpdateRunButton();
      if (displayedWashReview && displayedWashReview.phase === "review") {
        renderWashReview(displayedWashReview.review, displayedWashReview.productId, {
          addComplete: pendingWashReview?.addComplete === true,
          modifyComplete: pendingWashReview?.modifyComplete === true
        });
      }
    }
  }

  async function runUpdate(options = {}) {
    const resume = options.resume === true;
    const scope = resume ? "batch" : selectedReplaceScope();
    if (!resume && scope === "current") return runCurrentReplace();
    const recovery = resume
      ? contract.recoveryDecision(recoverySnapshot, materialPlan?.planDigest, loadedBuildId)
      : null;
    const modules = selectedReplaceModules();
    if (running || !materialPlan || (!modules.priceInventory && !modules.skuImages)) {
      if (materialPlan && !modules.priceInventory && !modules.skuImages) updateStatus("请至少勾选价格库存或 SKU 图片", "blocked");
      return;
    }
    const query = scope === "query" ? String(productQueryInput?.value || "").trim() : "";
    if (scope === "query" && !query) {
      updateStatus("请输入商品名称、商品 ID 或商家编码后再查询", "blocked");
      refreshUpdateRunButton();
      return;
    }
    if (resume && !recovery?.allowed) {
      updateStatus("当前中断记录不满足自动恢复条件", "blocked");
      refreshRecoveryUi();
      return;
    }
    const runPlan = materialPlan;
    const recoverySource = resume ? recoverySnapshot : null;
    running = true;
    paused = false;
    activeRunPlan = runPlan;
    activeBatchCheckpoint = resume ? Object.freeze({ ...recoverySource.checkpoint }) : null;
    auditContext = Object.freeze({});
    runToken = `update-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    runButton.disabled = true;
    refreshRecoveryUi();
    pauseButton.disabled = false;
    setReplaceMaterialInputsDisabled(true);
    if (imageSwapInput) imageSwapInput.disabled = true;
    priceInventoryEnabled.disabled = true;
    if (skuImagesEnabled) skuImagesEnabled.disabled = true;
    for (const control of document.querySelectorAll('input[name="updateReplaceScope"]')) control.disabled = true;
    if (productQueryInput) productQueryInput.disabled = true;
    for (const button of updateSubmodeButtons) button.disabled = true;
    let listTab = null;
    let listDocumentToken = null;
    let originalPage = null;
    try {
      listTab = await activeMerchantTab();
      const listIdentity = listPageIdentity(listTab);
      let initial = await send(listTab.id, contract.COMMANDS.OBSERVE_LIST);
      if (scope === "query") {
        updateStatus("正在查询商品并等待列表稳定", "running");
        initial = await send(listTab.id, contract.COMMANDS.SEARCH_LIST, { query }, initial.documentToken);
      }
      listDocumentToken = initial.documentToken;
      setScopeLink(scope, initial, query);
      const collected = await collectFiltered(listTab, initial);
      listDocumentToken = collected.documentToken;
      originalPage = collected.originalPage;
      const products = collected.frozen.entries;
      resetProductSummaries(products);
      let startIndex = 0;
      if (resume) {
        contract.assertRecoveryFrozenMatch(activeBatchCheckpoint, collected.frozen);
        await validateCompletedSessions(listTab, activeBatchCheckpoint);
        startIndex = recovery.nextIndex;
        for (let index = 0; index < startIndex; index += 1) {
          updateProductSummary(products[index], { state: "replace_completed", detail: "上次批次已完成替换且未发布，本次恢复跳过" });
        }
        audit("batch_resume_validated", { startIndex: startIndex + 1, completedCount: startIndex, remainingCount: products.length - startIndex });
      }
      const accepted = globalThis.confirm?.(resume
        ? `将恢复上次中断批次：跳过已完成的 ${startIndex} 个商品，从第 ${startIndex + 1} 个商品继续，共剩余 ${products.length - startIndex} 个。\n\n${planSummary(runPlan)}\n\n恢复使用新的运行令牌，不重放旧写命令；替换完成后不发布。`
        : `将按${replaceScopeLabel(scope)}顺序${updateSubmode === "wash" ? "洗链接更新" : runPlan.priceInventory.intent === "replace_group" ? "整组重建" : "替换匹配"} ${products.length} 个商品的${runPlan.priceInventory.intent === "replace_group" ? "价格库存" : " SKU 图片"}。${scope === "query" ? `\n查询内容：${query}` : ""}\n\n${planSummary(runPlan)}\n\n${updateSubmode === "wash" ? "已有 SKU 只改价格和商家编码，规格文字及【】标签保持页面原样；新型号追加后填写价格、库存和商家编码；Excel 不存在的 SKU 最后由人工删除。" : runPlan.priceInventory.intent === "replace_group" ? "确认后会删除每个商品当前唯一规格组；" : "只会按冻结图片匹配当前 SKU，不改价格库存；"}替换完成后不发布并保留编辑页，直接继续下一商品。`
      );
      if (accepted !== true) fail("UPDATE_CONFIRMATION_DECLINED", "已取消，本次没有修改商品。", {});
      if (!resume) {
        activeBatchCheckpoint = createBatchCheckpoint(collected.frozen, runPlan);
      } else {
        updateBatchCheckpoint({
          products: Object.freeze(products.map((product) => Object.freeze({
            productId: String(product.productId), title: product.title || "", status: product.status || "", pageNo: Number(product.pageNo)
          }))),
          currentIndex: null,
          currentProductId: null,
          mutationStarted: false,
          outcomeUnknown: false,
          retrySafety: "safe_retry"
        });
      }
      await persistProgress(resume ? "batch_resumed" : "batch_frozen", {
        productCount: products.length,
        completedCount: startIndex,
        filterUrl: collected.frozen.filterUrl
      });
      const startPage = products[startIndex]?.pageNo || 1;
      const positioned = await positionListAtPage(listTab, listIdentity, startPage);
      listDocumentToken = positioned.documentToken;
      const outcomes = await processFrozenProducts(listTab, listIdentity, products, runPlan, processProduct, startIndex);
      auditContext = Object.freeze({});
      const failedCount = outcomes.filter((item) => !item.ok).length;
      const hasUnknown = outcomes.some((item) => item.outcomeUnknown === true);
      updateBatchCheckpoint({
        nextIndex: products.length,
        currentIndex: null,
        currentProductId: null,
        mutationStarted: false,
        outcomeUnknown: hasUnknown,
        retrySafety: failedCount ? "manual_reconcile" : "complete"
      });
      await persistProgress(failedCount ? "complete_with_failures" : "complete", { productCount: products.length, failedCount });
      updateStatus(
        failedCount
          ? `批次已处理完成，${failedCount} 个商品待人工检查`
          : "全部筛选商品已替换完成，均未发布",
        failedCount ? "blocked" : "ready"
      );
      audit("batch_complete", { productCount: products.length, failedCount, hasUnknown, outcome: "serial_replace_without_publish" });
      if (updateSubmode === "wash" && failedCount === 0) {
        const labelWarning = outcomes.some((item) => item.result?.retiredCount)
          ? "价格和新增已完成；待删除旧 SKU 请按清单手动处理。\n\n"
          : "";
        globalThis.alert?.(`${labelWarning}洗链接已完成，请到右侧手动点击自定义排序，调整 SKU 顺序后手动保存`);
      }
    } catch (caught) {
      const state = caught?.code === "UPDATE_PAUSED" ? "paused" : "blocked";
      if (activeBatchCheckpoint && (caught?.evidence?.outcomeUnknown === true || /^UPDATE_RECOVERY_COMPLETED_/.test(String(caught?.code || "")))) {
        updateBatchCheckpoint({ outcomeUnknown: caught?.evidence?.outcomeUnknown === true, retrySafety: "manual_reconcile" });
      }
      updateStatus(state === "paused" ? "已暂停，后续商品未执行" : "已阻断，后续商品未执行", state);
      audit("batch_stopped", { code: caught?.code || "UPDATE_RUN_FAILED", remediation: "后续商品未执行；检查日志、页面回读和材料后再新建批次" });
      await persistProgress(state, { errorCode: caught?.code || "UPDATE_RUN_FAILED", errorMessage: caught?.message || String(caught) }).catch(() => {});
    } finally {
      if (listTab && Number.isInteger(originalPage)) {
        try {
          const observed = await send(listTab.id, contract.COMMANDS.OBSERVE_LIST);
          if (observed.result.currentPage !== originalPage) {
            const restored = await send(listTab.id, contract.COMMANDS.GO_PAGE, { pageNo: originalPage }, observed.documentToken);
            listDocumentToken = restored.documentToken;
          }
        } catch (_) {}
      }
      if (listTab) await abortTab(listTab, listDocumentToken).catch(() => {});
      running = false;
      activeRunPlan = null;
      auditContext = Object.freeze({});
      setReplaceMaterialInputsDisabled(false);
      if (imageSwapInput) imageSwapInput.disabled = false;
      priceInventoryEnabled.disabled = false;
      if (skuImagesEnabled) skuImagesEnabled.disabled = false;
      for (const control of document.querySelectorAll('input[name="updateReplaceScope"]')) control.disabled = false;
      for (const button of updateSubmodeButtons) button.disabled = false;
      pauseButton.disabled = true;
      refreshRecoveryUi();
      refreshReplaceScopeUi();
      refreshUpdateRunButton();
    }
  }

  if (globalThis.__DoudianUpdateUiTestApi) {
    Object.assign(globalThis.__DoudianUpdateUiTestApi, {
      collectFiltered,
      editTabsForProduct,
      editProductIdentity,
      executeOffsaleSpecifications,
      executeImageSwapRows,
      executePriceInventory,
      listPageIdentity,
      moveToFrozenProductPage,
      openedEditTab,
      parseMaterial,
      pageImageSwapPlan,
      parseImageSwapFiles,
      positionListAtPage,
      processFrozenProducts,
      processOffsaleProduct,
      processImageSwapProduct,
      runCurrentReplace,
      readReplaceGroupWhenReady,
      readStructureWhenReady,
      refreshRecoveryUi,
      validateCompletedSessions,
      modeBusy,
      send,
      sendWithReceiverRecovery,
      setMode,
      setUpdateSubmode,
      setTestActiveBatchCheckpoint(value) { activeBatchCheckpoint = value; },
      setTestMaterialPlan(value) { materialPlan = value; },
      setTestImageSwapPlan(value) { imageSwapPlan = value; },
      setTestPaused(value) { paused = Boolean(value); },
      setTestRecoverySnapshot(value) { recoverySnapshot = value; },
      setTestRunToken(value) { runToken = value; },
      trustedObservedEditHref,
      waitForNewEditTab
    });
  }

  const replanReplaceMaterials = async () => {
    if (running) return;
    refreshUpdateRunButton();
    refreshRecoveryUi();
    if (!priceInventoryFiles.length && !replaceSkuImageFiles.length) return;
    try {
      await parseMaterial();
    } catch (caught) {
      showMaterialFailure(caught);
    }
  };
  const bindMaterialDrop = (drop, kind, associatedInput) => {
    if (!drop) return;
    for (const type of ["dragenter", "dragover"]) {
      drop.addEventListener(type, (event) => {
        if (drop.getAttribute("aria-disabled") === "true") return;
        event.preventDefault();
        drop.classList.add("is-dragover");
      });
    }
    for (const type of ["dragleave", "dragend"]) drop.addEventListener(type, () => drop.classList.remove("is-dragover"));
    drop.addEventListener("drop", (event) => {
      event.preventDefault();
      drop.classList.remove("is-dragover");
      acceptMaterialDrop(kind, event.dataTransfer).catch(showMaterialFailure);
    });
    drop.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      associatedInput?.click();
    });
  };
  input?.addEventListener("change", () => {
    if (running) return;
    priceInventoryFiles = priceMaterialFileRecords([...input.files].map((file) => ({ file, relativePath: file.webkitRelativePath || file.name })));
    if (priceInventoryFiles.length && priceInventoryEnabled) priceInventoryEnabled.checked = true;
    refreshMaterialDropLabels();
    void replanReplaceMaterials();
  });
  skuImagesInput?.addEventListener("change", () => {
    if (running) return;
    replaceSkuImageFiles = usableMaterialFiles(skuImagesInput.files || []);
    if (replaceSkuImageFiles.length && skuImagesEnabled) skuImagesEnabled.checked = true;
    refreshMaterialDropLabels();
    void replanReplaceMaterials();
  });
  bindMaterialDrop(priceInventoryDrop, "price", input);
  bindMaterialDrop(skuImagesDrop, "sku", skuImagesInput);
  priceInventoryClear?.addEventListener("click", () => clearReplaceMaterial("price"));
  skuImagesClear?.addEventListener("click", () => clearReplaceMaterial("sku"));
  washReviewFilters?.addEventListener("click", (event) => {
    const button = event.target.closest?.("button[data-wash-review-filter]");
    const statusName = String(button?.dataset?.washReviewFilter || "");
    if (!statusName || !displayedWashReview) return;
    washReviewFilter = washReviewFilter === statusName ? null : statusName;
    renderWashReview(displayedWashReview.review, displayedWashReview.productId, {
      phase: displayedWashReview.phase,
      addComplete: displayedWashReview.addComplete,
      modifyComplete: displayedWashReview.modifyComplete
    });
  });
  washAddButton?.addEventListener("click", () => void handleWashAddClick());
  washModifyButton?.addEventListener("click", () => runCurrentReplace({ washPhase: "modify" }));
  priceInventoryEnabled?.addEventListener("change", () => void replanReplaceMaterials());
  skuImagesEnabled?.addEventListener("change", () => void replanReplaceMaterials());
  offsaleSpecifications?.addEventListener("input", refreshUpdateRunButton);
  for (const control of document.querySelectorAll('input[name="updateReplaceScope"]')) control.addEventListener("change", () => {
    refreshRecoveryUi();
    refreshReplaceScopeUi();
    refreshUpdateRunButton();
  });
  productQueryInput?.addEventListener("input", refreshUpdateRunButton);
  for (const control of document.querySelectorAll('input[name="updateOffsaleScope"]')) control.addEventListener("change", refreshUpdateRunButton);
  imageSwapInput?.addEventListener("change", () => {
    if (running) return;
    parseImageSwapFiles().catch((caught) => {
      imageSwapPlan = null;
      refreshUpdateRunButton();
      updateStatus("SKU 图片已阻断", "blocked");
      render(`${caught?.code || "UPDATE_SKU_IMAGE_BATCH_INVALID"}：${caught?.message || caught}`);
    });
  });
  for (const control of document.querySelectorAll('input[name="updateImageSwapScope"]')) control.addEventListener("change", refreshUpdateRunButton);
  for (const button of updateSubmodeButtons) button.addEventListener("click", () => setUpdateSubmode(button.dataset.updateSubmode));
  runButton?.addEventListener("click", () => ["replace", "wash"].includes(updateSubmode) ? runUpdate() : updateSubmode === "offsale" ? runOffsale() : runImageSwap());
  continueCurrentButton?.addEventListener("click", () => runCurrentReplace({ resumeExistingSpecs: true }));
  resumeButton?.addEventListener("click", () => runUpdate({ resume: true }));
  pauseButton?.addEventListener("click", () => {
    paused = true;
    updateStatus("暂停请求已记录，当前安全操作完成后停止", "paused");
  });
  setReplaceMaterialInputsDisabled(false);
  refreshMaterialDropLabels();
  setUpdateSubmode("wash");
  refreshReplaceScopeUi();
  setMode("update");
  for (const button of modeButtons) {
    button.addEventListener("click", () => setMode(button.dataset.panelMode));
    button.addEventListener("keydown", (event) => moveModeFocus(button, event));
  }
  loadRecoverySnapshot();
})();
