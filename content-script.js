"use strict";

const PAGE_COMMAND_MESSAGE = "DOUDIAN_PAGE_COMMAND";
const PAGE_COMMAND_MESSAGE_ALIASES = new Set([
  PAGE_COMMAND_MESSAGE,
  "DOUDIAN_EXECUTE_PAGE_COMMAND",
  "DOUDIAN_VALIDATE_MAIN_UPLOAD"
]);
const EXECUTOR_BUILD_ID = DoudianBuildInfo.id;
console.info(`[Doudian Listing Assistant] build ${EXECUTOR_BUILD_ID}`);
const EXPECTED_ORIGIN = "https://fxg.jinritemai.com";
const EXPECTED_ROUTE = "/ffa/g/create";
const LOGGED_OUT_SHOP_HINTS = new Set(
  [
    [30331, 24405],
    [35831, 24405],
    [30331, 24405, 47, 27880, 20837]
  ].map((characters) => normalizeText(String.fromCharCode(...characters)))
);
const MAIN_TITLE = "三防热敏不干胶标签";
const STOCK_VALUE = "999";
const MAX_PURCHASE = "200";
const STOCK_DEDUCTION_TEXT = "付款减库存";
const AFTER_SALE_TEXT =
  "7天无理由退货(一次性包装未破损)";
const MAIN_UPLOAD_TEXT = "上传主图";
const AUXILIARY_UPLOAD_TEXT = "上传辅助图";
const INITIAL_TITLE_PLACEHOLDER =
  "请输入5-60个字符（1-30个汉字）";
const SHORT_TITLE_PLACEHOLDER =
  "建议填写简明准确的标题内容，避免重复表达";
const BRAND_EMPTY_HINT = "请输入需要关联的品牌";
const IMAGE_INPUT_SELECTOR = 'input[type="file"][accept="image/*"]';
const DETAIL_IMAGE_CAPACITY = 50;

function requestedMainTitle(args) {
  const title = args?.title === undefined
    ? MAIN_TITLE
    : String(args.title ?? "").trim();
  if (!title) {
    throw new PageCommandError("TITLE_REQUIRED", "商品标题不能为空。");
  }
  return title;
}

function requestedBrand(args) {
  const brand = String(args?.brand ?? "").normalize("NFKC").trim();
  if (!brand) {
    throw new PageCommandError(
      "BRAND_REQUIRED",
      "品牌不能为空",
      { actual: args?.brand }
    );
  }
  return brand;
}

function requestedShortTitle(args) {
  const shortTitle = String(args?.shortTitle ?? "").normalize("NFKC").trim();
  if (!shortTitle) {
    throw new PageCommandError(
      "SHORT_TITLE_REQUIRED",
      "导购短标题不能为空",
      { actual: args?.shortTitle }
    );
  }
  return shortTitle;
}
const MAIN_PREVIEW_SELECTOR =
  "#material-button-guider.material-button.material-preview-button";
const AUXILIARY_CONTROL_SELECTOR =
  ".material-button.material-upload-button";
const PREVIEW_SELECTOR = ".material-preview-button";
const OPTIONAL_MEDIA_KIND_CONFIG = Object.freeze({
  ratio34: Object.freeze({
    kind: "ratio34",
    fieldId: "主图3:4",
    label: "主图3:4",
    mediaType: "image",
    capacity: 5
  }),
  video: Object.freeze({
    kind: "video",
    fieldId: "主图视频",
    label: "主图视频",
    mediaType: "video",
    capacity: 1
  }),
  whiteBackground: Object.freeze({
    kind: "whiteBackground",
    fieldId: "白底图",
    label: "白底图",
    mediaType: "image",
    capacity: 1
  })
});
const POLL_INTERVAL_MS = 150;
const ACTION_TIMEOUT_MS = 15000;
const CURRENT_PAGE_SPECIFICATION_SETTLEMENT_TIMEOUT_MS = 120000;
const CLICK_NEXT_RETRY_WINDOW_MS = 5000;
const FULL_FORM_TRANSITION_TIMEOUT_MS = 120000;
const CATEGORY_TIMEOUT_MS = 45000;
const UPLOAD_TIMEOUT_MS = 120000;
const SKU_SCAN_TIMEOUT_MS = 120000;
const SPECIFICATION_IMAGE_INPUT_READY_TIMEOUT_MS = 60000;
const SKU_ROW_MAX_ATTEMPTS = 3;
const RETRYABLE_SKU_ERROR_CODES = new Set([
  "SKU_TABLE_AMBIGUOUS",
  "SKU_GRID_SCAN_INCOMPLETE",
  "SKU_ROW_NOT_FOUND",
  "SKU_CELL_INPUT_AMBIGUOUS",
  "SKU_ROW_SHAPE_MISMATCH",
  "SKU_CELL_READBACK_MISMATCH",
  "SPECIFICATION_IMAGE_INPUT_AMBIGUOUS",
  "SPECIFICATION_IMAGE_PREVIEW_TIMEOUT"
]);
const EXPECTED_CATEGORY_PATH =
  "办公设备及耗材 > 办公用纸 > 热敏/收银纸";
const MANUAL_CATEGORY_SEARCH_TEXT = "热敏/收银纸";
const MANUAL_CATEGORY_SEARCH_PLACEHOLDER =
  "请输入商品名/类目关键词搜索";
const MANUAL_CATEGORY_DIALOG_TITLE = "选择类目";
const MANUAL_CATEGORY_FIELD_LABEL = "商品类目";
const MANUAL_CATEGORY_BUTTON_NAME = "手动选择类目";
const MANUAL_CATEGORY_BUTTON_COMPATIBILITY_NAME = "手动选择";
const FULL_FORM_TAB_NAMES = Object.freeze([
  "基础信息",
  "图文信息",
  "价格库存",
  "服务与履约",
  "其他信息"
]);
const DOCUMENT_TOKEN = createToken("document");
const COMMAND_ALLOWLIST = new Set([
  "observe",
  "upload_main",
  "upload_auxiliary",
  "set_title_and_infer_category",
  "click_next",
  "assert_full_form",
  "set_short_title_and_brand",
  "remove_default_detail",
  "upload_detail",
  "upload_optional_media",
  "set_fulfillment",
  "import_specification",
  "fill_sku_row",
  "set_batch_stock",
  "verify_sku_stock",
  "set_inventory_deduction",
  "test_after_sale",
  "set_service_terms",
  "run_filling_check",
  "assert_review_ready",
  "abort"
]);

let activeRunToken = null;
let abortedRunToken = null;
let fillingCheckEvidence = null;
let activeExpectedSpecs = null;
let activeOptionalMediaPlan = Object.create(null);
let commandSequence = 0;
const commandReceiptJournal =
  DoudianUploadState.createCommandReceiptJournal(100);

class PageCommandError extends Error {
  constructor(code, message, evidence = null) {
    super(message);
    this.name = "PageCommandError";
    this.code = code;
    this.evidence = evidence;
  }
}

function createToken(prefix) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .trim();
}

function displayText(element) {
  return String(element?.innerText || element?.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isElement(value) {
  return value instanceof Element;
}

function isVisible(element) {
  if (!isElement(element) || !element.isConnected) return false;
  const style = getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    Number(style.opacity) === 0
  ) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function allVisible(selector, scope = document) {
  return Array.from(scope.querySelectorAll(selector)).filter(isVisible);
}

function visibleShopIdentity() {
  const nodes = allVisible(".headerShopName");
  const names = nodes.map(displayText).filter((name) => normalizeText(name));
  const uniqueNames = Array.from(
    new Map(names.map((name) => [normalizeText(name), name])).values()
  );
  return { nodes, names, uniqueNames };
}

function visibleExactText(text, scope = document) {
  const expected = normalizeText(text);
  return allVisible("button, a, label, span, div, p, li", scope).filter(
    (element) => normalizeText(displayText(element)) === expected
  );
}

function uniqueElement(elements, code, label, evidence = {}) {
  const unique = Array.from(new Set(elements.filter(Boolean)));
  if (unique.length !== 1) {
    throw new PageCommandError(code, `${label}必须唯一`, {
      ...evidence,
      count: unique.length,
      samples: unique.slice(0, 8).map(describeElement)
    });
  }
  return unique[0];
}

function describeElement(element) {
  if (!isElement(element)) return null;
  return {
    tag: element.tagName,
    id: element.id || null,
    className:
      typeof element.className === "string" ? element.className : null,
    role: element.getAttribute("role"),
    name: element.getAttribute("name"),
    placeholder: element.getAttribute("placeholder"),
    text: displayText(element).slice(0, 160)
  };
}

function calibrationEvidence(labels = []) {
  return {
    labels,
    visibleInputs: allVisible("input, textarea, [role=combobox]")
      .slice(0, 40)
      .map(describeElement),
    visibleButtons: allVisible("button")
      .slice(0, 40)
      .map(describeElement),
    visibleFileInputs: Array.from(
      document.querySelectorAll('input[type="file"]')
    )
      .slice(0, 30)
      .map(describeElement)
  };
}

function nearestAncestor(element, predicate, limit = 10) {
  let current = element?.parentElement || null;
  let depth = 0;
  while (current && depth < limit) {
    if (predicate(current)) return current;
    current = current.parentElement;
    depth += 1;
  }
  return null;
}

function nearestCommonAncestor(elements) {
  let candidate = elements[0]?.parentElement || null;
  while (
    candidate &&
    !elements.every((element) => candidate.contains(element))
  ) {
    candidate = candidate.parentElement;
  }
  return candidate;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check, options = {}) {
  const timeout = options.timeout ?? ACTION_TIMEOUT_MS;
  const interval = options.interval ?? POLL_INTERVAL_MS;
  const startedAt = performance.now();
  let lastValue = null;
  let lastError = null;
  while (performance.now() - startedAt < timeout) {
    assertPageIdentity();
    assertRunStillActive(options.runToken);
    try {
      lastValue = await check();
      if (lastValue) {
        return {
          value: lastValue,
          elapsedMs: Math.round(performance.now() - startedAt)
        };
      }
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new PageCommandError(
    options.code || "POSTCONDITION_TIMEOUT",
    options.label || "等待页面后置条件超时",
    {
      timeout,
      lastValue,
      lastError: lastError
        ? {
            code: lastError.code || null,
            message: lastError.message,
            evidence: lastError.evidence || null
          }
        : null,
      ...(options.evidence || {})
    }
  );
}

function assertPageIdentity() {
  if (location.origin !== EXPECTED_ORIGIN) {
    throw new PageCommandError("ORIGIN_MISMATCH", "页面主机不匹配", {
      expected: EXPECTED_ORIGIN,
      actual: location.origin
    });
  }
  if (location.pathname !== EXPECTED_ROUTE) {
    throw new PageCommandError("ROUTE_MISMATCH", "页面路由不匹配", {
      expected: EXPECTED_ROUTE,
      actual: location.pathname
    });
  }
  const identity = visibleShopIdentity();
  if (identity.nodes.length > 0 && identity.names.length === 0) {
    throw new PageCommandError(
      "SHOP_IDENTITY_EMPTY",
      "当前登录店铺身份为空",
      { shopNodeCount: identity.nodes.length }
    );
  }
  if (identity.uniqueNames.length !== 1) {
    throw new PageCommandError(
      "SHOP_IDENTITY_AMBIGUOUS",
      "店铺身份必须稳定为一个唯一名称",
      {
        shopNodeCount: identity.nodes.length,
        shopNames: identity.names,
        uniqueShopNames: identity.uniqueNames
      }
    );
  }
  const actualShop = identity.uniqueNames[0];
  const normalizedShop = normalizeText(actualShop);
  if (LOGGED_OUT_SHOP_HINTS.has(normalizedShop)) {
    throw new PageCommandError(
      "SHOP_IDENTITY_LOGGED_OUT",
      "当前页面未登录店铺",
      { shopNodeCount: identity.nodes.length, actual: actualShop }
    );
  }
  return actualShop;
}

function readMessageToken(message, names) {
  for (const name of names) {
    const value = message?.[name];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function commandName(message) {
  if (message?.type === "DOUDIAN_VALIDATE_MAIN_UPLOAD") {
    return "upload_main";
  }
  return message?.command || message?.pageCommand || null;
}

function commandArguments(message) {
  if (message?.type === "DOUDIAN_VALIDATE_MAIN_UPLOAD") {
    return { file: message.payload };
  }
  return message?.args ?? message?.payload ?? {};
}

function assertCommandEnvelope(message, command) {
  if (!COMMAND_ALLOWLIST.has(command)) {
    throw new PageCommandError("COMMAND_NOT_ALLOWED", "页面命令不在允许列表", {
      command,
      allowed: Array.from(COMMAND_ALLOWLIST)
    });
  }
  const runToken = readMessageToken(message, [
    "runToken",
    "runId",
    "executionToken"
  ]);
  const documentToken = readMessageToken(message, [
    "documentToken",
    "documentId",
    "pageToken"
  ]);
  if (
    typeof runToken !== "string" ||
    runToken.length < 8 ||
    runToken.length > 256
  ) {
    throw new PageCommandError("RUN_TOKEN_INVALID", "运行令牌无效");
  }
  if (command === "observe") {
    if (documentToken && documentToken !== DOCUMENT_TOKEN) {
      throw new PageCommandError(
        "STALE_DOCUMENT_TOKEN",
        "页面文档令牌已失效",
        {
          expectedDocumentToken: DOCUMENT_TOKEN,
          receivedDocumentToken: documentToken
        }
      );
    }
    if (activeRunToken && activeRunToken !== runToken) {
      throw new PageCommandError("STALE_RUN_TOKEN", "运行令牌已失效", {
        activeRunToken,
        receivedRunToken: runToken
      });
    }
    if (abortedRunToken === runToken) {
      throw new PageCommandError("RUN_ABORTED", "该运行已终止", {
        runToken
      });
    }
    if (!activeRunToken) {
      fillingCheckEvidence = null;
      activeExpectedSpecs = null;
      activeOptionalMediaPlan = Object.create(null);
    }
    activeRunToken = runToken;
    return { runToken, documentToken: DOCUMENT_TOKEN };
  }
  const bound = DoudianUploadState.assertRunDocumentBinding(
    activeRunToken,
    DOCUMENT_TOKEN,
    runToken,
    documentToken
  );
  if (abortedRunToken === runToken) {
    throw new PageCommandError("RUN_ABORTED", "该运行已终止", {
      runToken
    });
  }
  activeRunToken = bound;
  return { runToken, documentToken };
}

function assertRunStillActive(runToken) {
  if (!runToken) return;
  if (activeRunToken !== runToken || abortedRunToken === runToken) {
    throw new PageCommandError(
      "RUN_BECAME_STALE",
      "等待期间运行令牌失效",
      {
        activeRunToken,
        receivedRunToken: runToken,
        aborted: abortedRunToken === runToken
      }
    );
  }
}

function initialTitleInputs() {
  const exactPlaceholder = allVisible(
    `input[placeholder="${CSS.escape(INITIAL_TITLE_PLACEHOLDER)}"]`
  );
  if (exactPlaceholder.length) return exactPlaceholder;
  return allVisible('input[placeholder*="60"]').filter((input) =>
    /字符|汉字/.test(input.getAttribute("placeholder") || "")
  );
}

function fullFormTabLists() {
  return allVisible('[role="tablist"]').filter(
    (tabList) => {
      const tabs = allVisible('[role="tab"]', tabList);
      return (
        tabs.length === FULL_FORM_TAB_NAMES.length &&
        tabs.every(
          (tab, index) =>
            normalizeText(displayText(tab)) ===
            normalizeText(FULL_FORM_TAB_NAMES[index])
        )
      );
    }
  );
}

function fullFormSignals() {
  const semanticTabLists = fullFormTabLists();
  const detailCounters = findDetailCounters();
  const skuTables = findSkuTables(false);
  const fullFormSignature =
    semanticTabLists.length === 1 && detailCounters.length === 1;
  return {
    visibleSections:
      semanticTabLists.length === 1 ? [...FULL_FORM_TAB_NAMES] : [],
    semanticTabListCount: semanticTabLists.length,
    detailCounterCount: detailCounters.length,
    skuTableCount: skuTables.length,
    fullFormSignature
  };
}

function detectPageState() {
  const initialTitles = initialTitleInputs();
  const signals = fullFormSignals();
  if (
    signals.fullFormSignature
  ) {
    return fillingCheckEvidence ? "review_ready" : "full_form";
  }
  if (initialTitles.length === 1) {
    const nextButtons = exactActionCandidates(["下一步", "开始创建"]);
    const category = categoryResolutionEvidence(false);
    if (normalizeText(initialTitles[0].value)) {
      return category.resolved && nextButtons.some(isEnabled)
        ? "category_ready"
        : "initial_titled";
    }
    return "initial_create";
  }
  return "unknown";
}

function expectedStatesFor(command) {
  return {
    observe: [
      "initial_create",
      "initial_titled",
      "category_ready",
      "full_form",
      "review_ready",
      "unknown"
    ],
    upload_main: ["initial_create", "initial_titled", "category_ready"],
    upload_auxiliary: ["initial_create", "initial_titled", "category_ready"],
    set_title_and_infer_category: [
      "initial_create",
      "initial_titled",
      "category_ready"
    ],
    click_next: ["initial_titled", "category_ready"],
    assert_full_form: ["full_form", "review_ready"],
    set_short_title_and_brand: ["full_form"],
    remove_default_detail: ["full_form"],
    upload_detail: ["full_form"],
    upload_optional_media: ["full_form"],
    set_fulfillment: ["full_form"],
    import_specification: ["full_form"],
    create_specification_group: ["full_form"],
    create_specification_step: ["full_form"],
    fill_sku_row: ["full_form"],
    set_batch_stock: ["full_form"],
    verify_sku_stock: ["full_form"],
    set_inventory_deduction: ["full_form"],
    test_after_sale: ["full_form"],
    set_service_terms: ["full_form"],
    run_filling_check: ["full_form"],
    assert_review_ready: ["review_ready"],
    abort: [
      "initial_create",
      "initial_titled",
      "category_ready",
      "full_form",
      "review_ready",
      "unknown"
    ]
  }[command];
}

function assertExpectedPageState(command, message) {
  const actual = detectPageState();
  const requested =
    message?.expectedPageState ?? message?.expectedState ?? null;
  if (requested && requested !== actual) {
    throw new PageCommandError(
      "EXPECTED_PAGE_STATE_MISMATCH",
      "页面状态与调用方预期不一致",
      { command, expected: requested, actual }
    );
  }
  const allowed = expectedStatesFor(command);
  if (!allowed.includes(actual)) {
    throw new PageCommandError(
      "COMMAND_PAGE_STATE_MISMATCH",
      "当前页面状态不允许执行该命令",
      { command, allowed, actual }
    );
  }
  return actual;
}

function pageEvidence() {
  const state = detectPageState();
  const signals = fullFormSignals();
  const shopIdentity = visibleShopIdentity();
  const initialTitle = initialTitleInputs()[0]?.value || null;
  return {
    buildId: EXECUTOR_BUILD_ID,
    documentToken: DOCUMENT_TOKEN,
    origin: location.origin,
    route: location.pathname,
    shopCount: shopIdentity.uniqueNames.length,
    shopNodeCount: shopIdentity.nodes.length,
    shop: shopIdentity.uniqueNames[0] || null,
    pageState: state,
    initialTitleInputCount: initialTitleInputs().length,
    initialTitle,
    category: categoryResolutionEvidence(false),
    main: inspectPostUploadMainState(0),
    fullFormSignals: signals,
    auxiliary: inspectAuxiliaryState(false),
    detail: inspectDetailState(false)
  };
}

function nativeSetValue(control, value) {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (!descriptor?.set) {
    throw new PageCommandError(
      "NATIVE_VALUE_SETTER_UNAVAILABLE",
      "浏览器原生值写入器不可用",
      describeElement(control)
    );
  }
  descriptor.set.call(control, String(value));
  for (const type of ["input", "change", "blur"]) {
    control.dispatchEvent(
      new Event(type, { bubbles: true, composed: true })
    );
  }
  if (String(control.value) !== String(value)) {
    throw new PageCommandError(
      "CONTROLLED_INPUT_READBACK_MISMATCH",
      "受控输入框回读不一致",
      {
        expected: String(value),
        actual: String(control.value),
        control: describeElement(control)
      }
    );
  }
  return {
    value: control.value,
    events: ["input", "change", "blur"]
  };
}

async function commitSpecificationValue(control, value, runToken, options = {}) {
  if (!control?.isConnected) {
    throw new PageCommandError(
      "UPDATE_SPEC_INPUT_DISCONNECTED",
      "规格输入框在提交前已失效",
      { control: describeElement(control) }
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  );
  if (!descriptor?.set) {
    throw new PageCommandError(
      "NATIVE_VALUE_SETTER_UNAVAILABLE",
      "浏览器原生值写入器不可用",
      describeElement(control)
    );
  }
  control.focus();
  descriptor.set.call(control, String(value));
  for (const type of ["input", "change"]) {
    control.dispatchEvent(
      new Event(type, { bubbles: true, composed: true })
    );
  }
  if (String(control.value) !== String(value)) {
    throw new PageCommandError(
      "CONTROLLED_INPUT_READBACK_MISMATCH",
      "规格输入框回读不一致",
      {
        expected: String(value),
        actual: String(control.value),
        control: describeElement(control)
      }
    );
  }
  if (options.confirmWithEnter === true) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      control.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true, composed: true
      }));
    }
  }
  await sleep(0);
  assertPageIdentity();
  assertRunStillActive(runToken);
  if (control.isConnected) control.blur();
  return {
    value: control.value,
    events: options.confirmWithEnter === true
      ? ["focus", "input", "change", "keydown:Enter", "keypress:Enter", "keyup:Enter", "blur"]
      : ["focus", "input", "change", "blur"]
  };
}

async function recoverCurrentPageSpecificationCommit(specificationType, expectedSpecs, index, runToken) {
  const groups = specificationEditorGroups(specificationType);
  const expectedPrefix = expectedSpecs.slice(0, index + 1);
  const filled = groups.filter((group) => normalizeText(group.specification));
  const values = filled.map((group) => normalizeText(group.specification));
  const nextEmpty = groups.filter((group) => !normalizeText(group.specification) && !normalizeText(group.remark));
  const prefixMatches = values.length === expectedPrefix.length &&
    values.every((value, position) => value === expectedPrefix[position]);
  if (!prefixMatches) {
    throw new PageCommandError(
      "UPDATE_SPEC_RECOVERY_PREFIX_DRIFT",
      "当前页规格补提交前已填写规格与冻结计划不一致，未继续派发事件",
      { expectedPrefix, values, groupCount: groups.length, nextEmptyCount: nextEmpty.length }
    );
  }
  if (nextEmpty.length >= 1 && groups.length >= index + 2 && nextEmpty.at(-1)?.specificationInput?.isConnected) {
    return {
      alreadyRebound: true,
      values,
      nextEmptyCount: nextEmpty.length,
      target: describeElement(nextEmpty.at(-1).specificationInput)
    };
  }
  const control = filled[index]?.specificationInput;
  const value = expectedPrefix[index];
  if (!control?.isConnected || normalizeText(control.value) !== value) {
    throw new PageCommandError(
      "UPDATE_SPEC_RECOVERY_LIVE_INPUT_MISSING",
      "当前页规格补提交前无法重新绑定到实时规格输入框",
      { index, expected: value, values, control: describeElement(control) }
    );
  }
  control.focus();
  control.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  for (const type of ["keydown", "keypress", "keyup"]) {
    control.dispatchEvent(new KeyboardEvent(type, {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true
    }));
  }
  await sleep(0);
  assertPageIdentity();
  assertRunStillActive(runToken);
  const focusTarget = allVisible('[role="tab"],button')
    .find((node) => ["价格库存", "价格与库存"].includes(normalizeText(displayText(node))) && !node.contains(control));
  if (focusTarget?.focus) focusTarget.focus({ preventScroll: true });
  else if (control.isConnected) control.blur();
  return {
    value: control.value,
    values,
    liveIndex: index,
    events: ["focus", "change", "keydown:Enter", "keypress:Enter", "keyup:Enter", focusTarget ? "focus_transfer" : "blur"],
    focusTarget: focusTarget ? describeElement(focusTarget) : null
  };
}

async function activateCurrentPageSpecificationInput(specificationType, expectedSpecs, index, control, runToken) {
  const activation = dispatchPointerClick(control);
  await sleep(80);
  assertPageIdentity();
  assertRunStillActive(runToken);
  const groups = specificationEditorGroups(specificationType);
  const filled = groups.filter((group) => normalizeText(group.specification));
  const empty = groups.filter((group) => !normalizeText(group.specification) && !normalizeText(group.remark));
  try {
    globalThis.DoudianUpdateContract.planSpecificationStep({
      expectedSpecs,
      index,
      observedFilled: filled.map((group) => group.specification),
      emptyCount: empty.length,
      allowMultipleEmpty: true
    });
  } catch (caught) {
    throw new PageCommandError(
      caught.code || "UPDATE_CURRENT_SPEC_INPUT_ACTIVATION_DRIFT",
      "当前页后续规格输入框点击激活后与冻结计划不一致，未写入页面",
      caught.evidence
    );
  }
  const liveInput = empty.at(-1)?.specificationInput;
  if (!liveInput?.isConnected) {
    throw new PageCommandError(
      "UPDATE_CURRENT_SPEC_INPUT_ACTIVATION_LOST",
      "当前页后续规格输入框点击激活后无法重新绑定",
      { index, expectedPrefix: expectedSpecs.slice(0, index), activation }
    );
  }
  let reboundActivation = null;
  if (liveInput !== control) reboundActivation = dispatchPointerClick(liveInput);
  else liveInput.focus({ preventScroll: true });
  if (document.activeElement !== liveInput) {
    throw new PageCommandError(
      "UPDATE_CURRENT_SPEC_INPUT_FOCUS_MISMATCH",
      "当前页后续规格输入框未获得焦点，未写入页面",
      {
        index,
        target: describeElement(liveInput),
        activeElement: describeElement(document.activeElement),
        activation,
        reboundActivation
      }
    );
  }
  return { input: liveInput, activation, reboundActivation };
}

function nativeSetSearchValue(control, value, options = {}) {
  if (
    !(control instanceof HTMLInputElement) &&
    !(control instanceof HTMLTextAreaElement)
  ) {
    return null;
  }
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (!descriptor?.set) {
    throw new PageCommandError(
      "NATIVE_SEARCH_VALUE_SETTER_UNAVAILABLE",
      "浏览器原生搜索值写入器不可用",
      describeElement(control)
    );
  }
  control.focus();
  descriptor.set.call(control, String(value));
  for (const type of ["input", "change", "keyup"]) {
    const event =
      type === "keyup"
        ? new KeyboardEvent(type, { bubbles: true, composed: true })
        : new Event(type, { bubbles: true, composed: true });
    control.dispatchEvent(event);
  }
  if (options.readback !== false && String(control.value) !== String(value)) {
    throw new PageCommandError(
      "SEARCH_INPUT_READBACK_MISMATCH",
      "搜索输入框回读不一致",
      {
        expected: String(value),
        actual: String(control.value),
        control: describeElement(control)
      }
    );
  }
  return {
    value: control.value,
    events: ["focus", "input", "change", "keyup"]
  };
}

function nativeSetManualCategorySearchValue(
  control,
  value,
  strategy = "insertText"
) {
  if (
    !(control instanceof HTMLInputElement) &&
    !(control instanceof HTMLTextAreaElement)
  ) {
    return null;
  }
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  const text = String(value);
  control.focus();
  if (typeof control.select === "function") control.select();
  if (typeof control.setSelectionRange === "function") {
    control.setSelectionRange(0, String(control.value).length);
  }

  let method = strategy;
  let insertTextAccepted = false;
  let insertTextError = null;
  if (
    strategy === "insertText" &&
    typeof document.execCommand === "function"
  ) {
    try {
      insertTextAccepted = document.execCommand("insertText", false, text);
    } catch (error) {
      insertTextError = error?.message || String(error);
    }
  }

  if (
    strategy === "native_setter_input_event" ||
    !insertTextAccepted ||
    String(control.value) !== text
  ) {
    method = "native_setter_input_event";
    if (!descriptor?.set) {
      throw new PageCommandError(
        "NATIVE_MANUAL_CATEGORY_VALUE_SETTER_UNAVAILABLE",
        "浏览器原生类目搜索值写入器不可用",
        {
          control: describeElement(control),
          insertTextAccepted,
          insertTextError
        }
      );
    }
    descriptor.set.call(control, text);
    const inputEvent =
      typeof InputEvent === "function"
        ? new InputEvent("input", {
            bubbles: true,
            composed: true,
            data: text,
            inputType: "insertText"
          })
        : new Event("input", { bubbles: true, composed: true });
    control.dispatchEvent(inputEvent);
  }

  if (String(control.value) !== text) {
    throw new PageCommandError(
      "MANUAL_CATEGORY_SEARCH_INPUT_READBACK_MISMATCH",
      "手动类目搜索输入框回读不一致",
      {
        expected: text,
        actual: String(control.value),
        control: describeElement(control)
      }
    );
  }
  return {
    value: control.value,
    method,
    insertTextAccepted,
    insertTextError,
    events:
      method === "insertText"
        ? ["focus", "select", "insertText"]
        : ["focus", "select", "input"],
    inputType: "insertText"
  };
}

async function typeManualCategorySearchIncrementally(
  dialog,
  value,
  runToken
) {
  const text = String(value);
  let expected = "";
  let control = manualCategorySearchInput(dialog);
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (!descriptor?.set) {
    throw new PageCommandError(
      "NATIVE_MANUAL_CATEGORY_VALUE_SETTER_UNAVAILABLE",
      "浏览器原生类目搜索值写入器不可用",
      describeElement(control)
    );
  }
  control.focus();
  descriptor.set.call(control, "");

  const characters = Array.from(text);
  for (let index = 0; index < characters.length; index += 1) {
    assertRunStillActive(runToken);
    control = manualCategorySearchInput(dialog);
    if (!control?.isConnected) {
      return {
        value: null,
        method: "incremental_insert_text",
        stable: false,
        failedCharacterIndex: index,
        inputReplaced: true
      };
    }
    const character = characters[index];
    expected += character;
    control.focus();
    if (typeof control.setSelectionRange === "function") {
      const end = String(control.value).length;
      control.setSelectionRange(end, end);
    }
    let accepted = false;
    if (typeof document.execCommand === "function") {
      try {
        accepted = document.execCommand("insertText", false, character);
      } catch {
        accepted = false;
      }
    }
    if (!accepted || String(control.value) !== expected) {
      nativeSetManualCategorySearchValue(
        control,
        expected,
        "native_setter_input_event"
      );
    }
    await sleep(40);
    const liveInput = manualCategorySearchInput(dialog);
    if (
      !liveInput?.isConnected ||
      String(liveInput.value) !== expected
    ) {
      return {
        value: liveInput?.isConnected ? String(liveInput.value) : null,
        method: "incremental_insert_text",
        stable: false,
        failedCharacterIndex: index,
        expectedPrefix: expected,
        inputReplaced: liveInput !== control
      };
    }
  }
  return {
    value: expected,
    method: "incremental_insert_text",
    stable: true,
    characterCount: characters.length
  };
}

function recordManualCategoryDiagnostic(event, details = {}) {
  try {
    chrome.storage.local.set({
      doudianManualCategoryDiagnostic: {
        event,
        buildId: EXECUTOR_BUILD_ID,
        recordedAt: new Date().toISOString(),
        ...details
      }
    });
  } catch {
    // Diagnostics must never alter the listing workflow.
  }
}

function associatedLabels(control) {
  const labels = [];
  if (control.labels) labels.push(...control.labels);
  const id = control.id;
  if (id) {
    labels.push(
      ...Array.from(
        document.querySelectorAll(`label[for="${CSS.escape(id)}"]`)
      )
    );
  }
  const wrapping = control.closest("label");
  if (wrapping) labels.push(wrapping);
  return Array.from(new Set(labels));
}

function controlLabelTexts(control) {
  const texts = associatedLabels(control).map(displayText);
  const group = nearestAncestor(
    control,
    (candidate) =>
      candidate.matches(
        "label, fieldset, [role=group], [class*=form], [class*=Form]"
      ) && candidate.querySelectorAll("input, textarea, [role=combobox]").length <= 4
  );
  if (group) {
    texts.push(
      ...Array.from(group.querySelectorAll("label")).map(displayText)
    );
    const firstText = displayText(group).split(/\n/)[0];
    if (firstText) texts.push(firstText);
  }
  return Array.from(new Set(texts.map(normalizeText).filter(Boolean)));
}

function controlByExactLabel(
  labels,
  selector = "input, textarea",
  scope = document
) {
  const expected = labels.map(normalizeText);
  const candidates = allVisible(selector, scope).filter((control) => {
    const labelTexts = controlLabelTexts(control);
    return expected.some((label) => labelTexts.includes(label));
  });
  return uniqueElement(
    candidates,
    "FORM_CONTROL_AMBIGUOUS",
    `字段 ${labels.join("/")}`,
    calibrationEvidence(labels)
  );
}

function classifyShortTitleCandidates(candidates) {
  const eligible = candidates.filter((candidate) => !candidate.isMainTitle);
  const strategies = [
    [
      "exact_placeholder",
      eligible.filter((candidate) => candidate.exactPlaceholder)
    ],
    [
      "first_ecom_input_after_main_title",
      eligible.filter((candidate) => candidate.firstEcomAfterMainTitle)
    ],
    [
      "exact_label_excluding_main_title",
      eligible.filter((candidate) => candidate.exactLabel)
    ]
  ];
  const selected =
    strategies.find(([, strategyCandidates]) => strategyCandidates.length) ||
    ["no_match", []];
  return {
    strategy: selected[0],
    candidates: selected[1],
    strategyCounts: Object.fromEntries(
      strategies.map(([strategy, strategyCandidates]) => [
        strategy,
        strategyCandidates.length
      ])
    )
  };
}

function findShortTitleControl() {
  const labels = ["导购短标题", "短标题"];
  const expectedLabels = labels.map(normalizeText);
  const controls = allVisible("input, textarea");
  const mainTitle = document.querySelector("#pg-title-input");
  const ecomInputsAfterMainTitle = mainTitle
    ? controls.filter(
        (control) =>
          control.classList.contains("ecom-g-input") &&
          Boolean(
            mainTitle.compareDocumentPosition(control) &
              Node.DOCUMENT_POSITION_FOLLOWING
          )
      )
    : [];
  const firstEcomAfterMainTitle = ecomInputsAfterMainTitle[0] || null;
  const records = controls.map((control) => {
    const labelTexts = controlLabelTexts(control);
    return {
      element: control,
      isMainTitle: control.id === "pg-title-input" || control === mainTitle,
      exactPlaceholder:
        normalizeText(control.getAttribute("placeholder")) ===
        normalizeText(SHORT_TITLE_PLACEHOLDER),
      firstEcomAfterMainTitle: control === firstEcomAfterMainTitle,
      exactLabel: expectedLabels.some((label) => labelTexts.includes(label))
    };
  });
  const resolution = classifyShortTitleCandidates(records);
  return uniqueElement(
    resolution.candidates.map((candidate) => candidate.element),
    "SHORT_TITLE_CONTROL_AMBIGUOUS",
    "导购短标题",
    {
      locatorStrategy: resolution.strategy,
      strategyCounts: resolution.strategyCounts,
      mainTitle: describeElement(mainTitle),
      candidates: records.slice(0, 40).map((record) => ({
        ...describeElement(record.element),
        isMainTitle: record.isMainTitle,
        exactPlaceholder: record.exactPlaceholder,
        firstEcomAfterMainTitle: record.firstEcomAfterMainTitle,
        exactLabel: record.exactLabel
      }))
    }
  );
}

function classifyBrandCandidates(candidates) {
  const strategies = [
    [
      "exact_selected_value",
      candidates.filter((candidate) => candidate.exactSelectedValue)
    ],
    [
      "explicit_brand_field",
      candidates.filter((candidate) => candidate.inExplicitBrandField)
    ],
    [
      "empty_hint_container",
      candidates.filter((candidate) => candidate.inEmptyHintContainer)
    ],
    [
      "exact_label",
      candidates.filter((candidate) => candidate.exactLabel)
    ]
  ];
  const selected =
    strategies.find(([, strategyCandidates]) => strategyCandidates.length) ||
    ["no_match", []];
  return {
    strategy: selected[0],
    candidates: selected[1],
    strategyCounts: Object.fromEntries(
      strategies.map(([strategy, strategyCandidates]) => [
        strategy,
        strategyCandidates.length
      ])
    )
  };
}

function controlsInExplicitBrandFields() {
  const controls = [];
  for (const field of allVisible('[attr-field-id="品牌"]')) {
    const fieldControls = allVisible(
      '[role="combobox"], input, select',
      field
    );
    if (fieldControls.length === 1) controls.push(fieldControls[0]);
  }
  return Array.from(new Set(controls));
}

function controlsInBrandHintContainers() {
  const controls = [];
  for (const hint of visibleExactText(BRAND_EMPTY_HINT)) {
    const container = nearestAncestor(
      hint,
      (candidate) =>
        allVisible('[role="combobox"], input, select', candidate).length === 1,
      8
    );
    if (!container) continue;
    controls.push(
      ...allVisible('[role="combobox"], input, select', container)
    );
  }
  return Array.from(new Set(controls));
}

function findBrandControl(expectedBrand) {
  const expectedLabel = normalizeText("品牌");
  const explicitFieldControls = new Set(controlsInExplicitBrandFields());
  const hintControls = new Set(controlsInBrandHintContainers());
  const controls = allVisible('[role="combobox"], input, select');
  const records = controls.map((control) => {
    const labelTexts = controlLabelTexts(control);
    return {
      element: control,
      exactSelectedValue:
        normalizeText(readSelectionControlValue(control, expectedBrand)) ===
        normalizeText(expectedBrand),
      inExplicitBrandField: explicitFieldControls.has(control),
      inEmptyHintContainer: hintControls.has(control),
      exactLabel: labelTexts.includes(expectedLabel)
    };
  });
  const resolution = classifyBrandCandidates(records);
  return uniqueElement(
    resolution.candidates.map((candidate) => candidate.element),
    "BRAND_CONTROL_AMBIGUOUS",
    "字段 品牌",
    {
      locatorStrategy: resolution.strategy,
      strategyCounts: resolution.strategyCounts,
      emptyHint: BRAND_EMPTY_HINT,
      candidates: records.slice(0, 40).map((record) => ({
        ...describeElement(record.element),
        exactSelectedValue: record.exactSelectedValue,
        inExplicitBrandField: record.inExplicitBrandField,
        inEmptyHintContainer: record.inEmptyHintContainer,
        exactLabel: record.exactLabel
      }))
    }
  );
}

function readAuthoritativeControl(control) {
  if ("value" in control && String(control.value).trim()) {
    return String(control.value);
  }
  for (const attribute of ["aria-valuetext", "data-value"]) {
    const value = control.getAttribute(attribute);
    if (value) return value;
  }
  const selected = control.querySelectorAll(
    'option:checked, [aria-selected="true"], [data-state="selected"]'
  );
  if (selected.length === 1) return displayText(selected[0]);
  return displayText(control);
}

function elementTextValues(element) {
  if (!isElement(element)) return [];
  return [
    displayText(element),
    element.getAttribute("title"),
    element.getAttribute("aria-label"),
    element.getAttribute("aria-valuetext"),
    element.getAttribute("value_name"),
    element.getAttribute("brand_cn_name"),
    element.getAttribute("data-value"),
    element.getAttribute("value")
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function resolveSelectionText(elements, expectedText = null) {
  const values = elements.flatMap(elementTextValues);
  const expected = normalizeText(expectedText);
  if (expected) {
    return (
      values.find((value) => normalizeText(value) === expected) || ""
    );
  }
  const unique = Array.from(
    new Set(values.map(normalizeText).filter(Boolean))
  );
  return unique.length === 1 ? values.find(Boolean) || "" : "";
}

function selectControlScope(control) {
  let current = control;
  let depth = 0;
  while (current && depth <= 8) {
    const isSelectLike =
      current !== control &&
      (
        current.classList?.contains("ecom-g-select") ||
        current.tagName === "SELECT"
      );
    if (
      isSelectLike &&
      current.querySelectorAll('[role="combobox"], input, select').length <= 3
    ) {
      return current;
    }
    current = current.parentElement;
    depth += 1;
  }
  return control.parentElement || control;
}

function readSelectionControlValue(control, expectedText = null) {
  const direct = readAuthoritativeControl(control);
  const expected = normalizeText(expectedText);
  if (direct && (!expected || normalizeText(direct) === expected)) {
    return direct;
  }

  const context = controlledSelectContext(control);
  const controlledSelected = context.lists.flatMap((list) =>
    Array.from(
      list.querySelectorAll(
        'option:checked, [aria-selected="true"], [data-state="selected"]'
      )
    )
  );
  const controlledValue = resolveSelectionText(
    controlledSelected,
    expectedText
  );
  if (controlledValue) return controlledValue;

  const visibleSelected = allVisible(
    '[aria-selected="true"], option:checked, [data-state="selected"]'
  );
  const visibleSelectedValue = resolveSelectionText(
    visibleSelected,
    expectedText
  );
  if (visibleSelectedValue) return visibleSelectedValue;

  const scope = selectControlScope(control);
  const displayCandidates = allVisible(
    [
      ".ecom-g-select-selection-item",
      ".ecom-g-select-selection-overflow-item",
      "[class*=selection-item]",
      "[class*=SelectionItem]",
      "[title]"
    ].join(","),
    scope
  ).filter((element) => normalizeText(displayText(element)) !== normalizeText(BRAND_EMPTY_HINT));
  const scopedValue = resolveSelectionText(displayCandidates, expectedText);
  if (scopedValue) return scopedValue;

  if (expected) {
    const scopeTexts = elementTextValues(scope);
    const exact = scopeTexts.find((value) => normalizeText(value) === expected);
    if (exact) return exact;
  }
  return "";
}

function readExplicitBrandFieldValue(expectedBrand) {
  const fields = allVisible('[attr-field-id="品牌"]');
  if (fields.length !== 1) return "";
  const selectedDisplays = allVisible(
    [
      ".ecom-g-select-selection-item",
      ".ecom-g-select-selection-overflow-item",
      "[class*=selection-item]",
      "[class*=SelectionItem]"
    ].join(","),
    fields[0]
  );
  return resolveSelectionText(selectedDisplays, expectedBrand);
}

function readBrandFieldValue(expectedBrand) {
  const explicitValue = readExplicitBrandFieldValue(expectedBrand);
  if (explicitValue) return explicitValue;
  const control = findBrandControl(expectedBrand);
  return readSelectionControlValue(control, expectedBrand);
}

const TERMINAL_ACTION_DENYLIST = Object.freeze(
  [
    [112, 117, 98, 108, 105, 115, 104],
    [115, 117, 98, 109, 105, 116],
    [115, 97, 118, 101],
    [21457, 24067],
    [25552, 20132],
    [20445, 23384]
  ].map((characters) =>
    String.fromCharCode(...characters).toLocaleLowerCase()
  )
);

function assertNonTerminalAction(element) {
  const labels = [
    displayText(element),
    element?.value,
    element?.getAttribute?.("aria-label"),
    element?.getAttribute?.("title")
  ]
    .map((value) => normalizeText(value).toLocaleLowerCase())
    .filter(Boolean);
  const denied = TERMINAL_ACTION_DENYLIST.find((term) =>
    labels.some((label) => label.includes(term))
  );
  if (denied) {
    throw new PageCommandError(
      "TERMINAL_ACTION_DENIED",
      "通用点击器拒绝执行终态操作",
      { target: describeElement(element), matchedLabel: denied }
    );
  }
}

function clickElement(element) {
  if (!isEnabled(element)) {
    throw new PageCommandError(
      "CONTROL_DISABLED",
      "目标控件当前不可用",
      describeElement(element)
    );
  }
  assertNonTerminalAction(element);
  element.click();
}

function dispatchPointerClick(element) {
  if (!isEnabled(element)) {
    throw new PageCommandError(
      "CONTROL_DISABLED",
      "目标控件当前不可用",
      describeElement(element)
    );
  }
  assertNonTerminalAction(element);
  element.focus?.({ preventScroll: true });
  const rect = element.getBoundingClientRect();
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + Math.max(1, rect.width / 2),
    clientY: rect.top + Math.max(1, rect.height / 2),
    button: 0,
    buttons: 1,
    view: window
  };
  const events = [];
  for (const type of [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click"
  ]) {
    const EventConstructor =
      type.startsWith("pointer") && typeof PointerEvent === "function"
        ? PointerEvent
        : MouseEvent;
    element.dispatchEvent(new EventConstructor(type, eventInit));
    events.push(type);
  }
  return {
    target: describeElement(element),
    events
  };
}

function dispatchSelectOptionClick(element) {
  if (!isEnabled(element)) {
    throw new PageCommandError(
      "CONTROL_DISABLED",
      "下拉选项当前不可用",
      describeElement(element)
    );
  }
  assertNonTerminalAction(element);
  element.focus?.({ preventScroll: true });
  const rect = element.getBoundingClientRect();
  const common = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + Math.max(1, rect.width / 2),
    clientY: rect.top + Math.max(1, rect.height / 2),
    button: 0,
    view: window
  };
  const sequence = [
    ["pointerdown", 1],
    ["mousedown", 1],
    ["pointerup", 0],
    ["mouseup", 0],
    ["click", 0]
  ];
  const events = [];
  for (const [type, buttons] of sequence) {
    const EventConstructor =
      type.startsWith("pointer") && typeof PointerEvent === "function"
        ? PointerEvent
        : MouseEvent;
    element.dispatchEvent(
      new EventConstructor(type, { ...common, buttons })
    );
    events.push(type);
  }
  return {
    target: describeElement(element),
    events
  };
}

function isEnabled(element) {
  return (
    isVisible(element) &&
    !element.disabled &&
    element.getAttribute("aria-disabled") !== "true"
  );
}

function exactActionCandidates(names, scope = document) {
  const normalized = names.map(normalizeText);
  return allVisible(
    'button, a, [role="button"], input[type="button"]',
    scope
  ).filter((element) => {
    const value =
      element instanceof HTMLInputElement
        ? element.value
        : displayText(element);
    return normalized.includes(normalizeText(value));
  });
}

function uniqueAction(names, scope = document, code = "ACTION_AMBIGUOUS") {
  return uniqueElement(
    exactActionCandidates(names, scope),
    code,
    `操作 ${names.join("/")}`,
    calibrationEvidence(names)
  );
}

function deduplicateNestedActionCandidates(candidates) {
  const unique = Array.from(new Set(candidates.filter(Boolean)));
  // A role wrapper and its nested native button represent one user action.
  return unique.filter(
    (candidate) =>
      !unique.some(
        (other) => other !== candidate && candidate.contains(other)
      )
  );
}

function exactActionControlCandidates(names, scope = document) {
  return deduplicateNestedActionCandidates(
    exactActionCandidates(names, scope)
  );
}

function exactEnabledNativeButtonCandidates(names, scope = document) {
  const normalized = names.map(normalizeText);
  return allVisible("button", scope).filter(
    (button) =>
      isEnabled(button) &&
      normalized.includes(normalizeText(displayText(button)))
  );
}

function selectedState(control) {
  if (control instanceof HTMLInputElement) {
    if (control.type === "radio" || control.type === "checkbox") {
      return control.checked;
    }
  }
  for (const attribute of ["aria-checked", "aria-selected"]) {
    const value = control.getAttribute(attribute);
    if (value === "true") return true;
    if (value === "false") return false;
  }
  const state = control.getAttribute("data-state");
  if (state === "checked" || state === "selected") return true;
  if (state === "unchecked" || state === "unselected") return false;
  return null;
}

function stateBearingChoice(text, scope = document) {
  const exact = normalizeText(text);
  const candidates = allVisible(
    'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], label, [role="option"]',
    scope
  ).filter((element) => {
    const ownText = normalizeText(displayText(element));
    const labels =
      element instanceof HTMLInputElement
        ? controlLabelTexts(element)
        : [ownText];
    return ownText === exact || labels.includes(exact);
  });
  const qualified = candidates
    .map((candidate) => {
      if (selectedState(candidate) !== null) return candidate;
      const nested = candidate.querySelectorAll(
        'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'
      );
      if (nested.length === 1 && selectedState(nested[0]) !== null) {
        return nested[0];
      }
      const wrapper = candidate.closest(
        'label, [role="radio"], [role="checkbox"], [role="option"]'
      );
      return wrapper && selectedState(wrapper) !== null ? wrapper : null;
    })
    .filter(Boolean);
  const target = uniqueElement(
    qualified,
    "CHOICE_AMBIGUOUS",
    `选择项 ${text}`,
    calibrationEvidence([text])
  );
  const clickTarget =
    associatedLabels(target)[0] ||
    target.closest("label") ||
    visibleExactText(text, scope).find((element) => element.contains(target)) ||
    target;
  return { target, clickTarget };
}

function ensureExactChoice(text, scope = document) {
  const { target, clickTarget } = stateBearingChoice(text, scope);
  const before = selectedState(target);
  if (before !== true) clickElement(clickTarget);
  const after = selectedState(target);
  if (after !== true) {
    throw new PageCommandError(
      "CHOICE_READBACK_MISMATCH",
      `选择项 ${text} 未生效`,
      { before, after, target: describeElement(target) }
    );
  }
  return { text, before, after };
}

function canonicalizeOptionRecords(records) {
  const canonical = [];
  const seen = new Set();
  for (const record of records) {
    const key = record.canonical || record.element;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    canonical.push({ ...record, element: key });
  }
  return canonical;
}

function optionIdentityKey(element) {
  if (!isElement(element)) return null;
  const stableValues = [
    element.getAttribute("value_id"),
    element.id,
    element.getAttribute("data-value"),
    element.getAttribute("value")
  ]
    .map(normalizeText)
    .filter(Boolean);
  if (stableValues.length) {
    return `stable:${Array.from(new Set(stableValues)).join("|")}`;
  }
  return null;
}

function collapseEquivalentOptionCandidates(candidates) {
  if (candidates.length < 2) return candidates;
  const records = candidates.map((candidate) => ({
    candidate,
    identity: optionIdentityKey(candidate.canonical || candidate.element)
  }));
  const identities = new Set(records.map((record) => record.identity));
  let equivalentIdentity = null;
  if (
    records.every((record) => record.identity) &&
    identities.size === 1
  ) {
    equivalentIdentity = records[0].identity;
  } else if (records.every((record) => !record.identity)) {
    const popups = new Set(
      records.map((record) => record.candidate.popup)
    );
    const optionTexts = new Set(
      records.map((record) => record.candidate.optionText)
    );
    const controlledSamePopup =
      popups.size === 1 &&
      !popups.has(null) &&
      records.every(
        (record) =>
          record.candidate.inControlledPopup === true ||
          record.candidate.inUniqueVisiblePopup === true
      );
    if (
      controlledSamePopup &&
      optionTexts.size === 1 &&
      !optionTexts.has("")
    ) {
      equivalentIdentity =
        `controlled-text:${records[0].candidate.optionText}`;
    }
  }
  if (!equivalentIdentity) return candidates;
  const preferred =
    records.find(
      (record) =>
        record.candidate.inControlledPopup && record.candidate.active
    ) ||
    records.find((record) => record.candidate.active) ||
    records[0];
  return [
    {
      ...preferred.candidate,
      optionIdentity: equivalentIdentity,
      equivalentCandidateCount: records.length
    }
  ];
}

function classifyExactOptionCandidates(candidates) {
  const strategies = [
    [
      "controlled_popup_active",
      candidates.filter(
        (candidate) => candidate.inControlledPopup && candidate.active
      )
    ],
    [
      "controlled_popup",
      candidates.filter((candidate) => candidate.inControlledPopup)
    ],
    [
      "controlled_option_link",
      candidates.filter((candidate) => candidate.linkedToControlledOption)
    ],
    [
      "active_expanded_popup",
      candidates.filter(
        (candidate) => candidate.inExpandedPopup && candidate.active
      )
    ],
    [
      "expanded_popup",
      candidates.filter((candidate) => candidate.inExpandedPopup)
    ],
    [
      "unique_visible_popup",
      candidates.filter((candidate) => candidate.inUniqueVisiblePopup)
    ],
    ["canonical_exact_text", candidates]
  ];
  const selected =
    strategies.find(([, strategyCandidates]) => strategyCandidates.length) ||
    ["no_match", []];
  return {
    strategy: selected[0],
    candidates: selected[1],
    strategyCounts: Object.fromEntries(
      strategies.map(([strategy, strategyCandidates]) => [
        strategy,
        strategyCandidates.length
      ])
    )
  };
}

function optionContainer(element) {
  const selector =
    ".ecom-g-select-item-option, [role=option], option, li[role=option]";
  let current = element.closest(selector);
  if (!current) return element;
  let outermost = current;
  while (current.parentElement) {
    const parentOption = current.parentElement.closest(selector);
    if (!parentOption || parentOption === current) break;
    outermost = parentOption;
    current = parentOption;
  }
  return outermost;
}

function selectPopupFor(element) {
  return element.closest(
    [
      ".ecom-g-select-dropdown",
      "[class*=select-dropdown]",
      "[class*=SelectDropdown]",
      "[class*=selectPopup]",
      "[class*=SelectPopup]"
    ].join(",")
  );
}

function controlledSelectContext(control) {
  const ids = ["aria-controls", "aria-owns"]
    .flatMap((attribute) =>
      String(control.getAttribute(attribute) || "")
        .split(/\s+/)
        .filter(Boolean)
    );
  const lists = ids
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  const popup =
    lists
      .map((list) => selectPopupFor(list))
      .find((candidate) => candidate && isVisible(candidate)) || null;
  const optionKeys = new Set();
  for (const list of lists) {
    for (const option of list.querySelectorAll("[role=option], option")) {
      for (const value of [
        option.id,
        option.getAttribute("data-value"),
        option.getAttribute("value"),
        option.getAttribute("value_id"),
        option.getAttribute("value_name"),
        option.getAttribute("brand_cn_name"),
        option.getAttribute("title"),
        option.getAttribute("aria-label"),
        displayText(option)
      ]) {
        const key = normalizeText(value);
        if (key) optionKeys.add(key);
      }
    }
  }
  return { ids, lists, popup, optionKeys };
}

function exactOptionSelectionState(control, optionText, options = {}) {
  const expected = normalizeText(optionText);
  const context = controlledSelectContext(control);
  const optionMatches =
    typeof options.optionMatches === "function"
      ? options.optionMatches
      : (element) => normalizeText(displayText(element)) === expected;
  const rawCandidates = allVisible(
    ".ecom-g-select-item-option, [role=option], option, li[role=option]"
  ).filter((element) => optionMatches(element));
  const optionCandidates = canonicalizeOptionRecords(
    rawCandidates.map((element) => {
      const canonical = optionContainer(element);
      const popup = selectPopupFor(canonical);
      const matchedValues = elementTextValues(canonical).filter((value) =>
        optionMatches(canonical, value)
      );
      const optionKeys = [
        canonical.id,
        canonical.getAttribute("data-value"),
        canonical.getAttribute("value"),
        canonical.getAttribute("value_id"),
        canonical.getAttribute("value_name"),
        canonical.getAttribute("brand_cn_name"),
        canonical.getAttribute("title"),
        canonical.getAttribute("aria-label")
      ]
        .map(normalizeText)
        .filter(Boolean);
      return {
        element,
        canonical,
        popup,
        optionText: normalizeText(displayText(canonical)),
        matchedValues,
        optionIdentity: optionIdentityKey(canonical),
        inControlledPopup: Boolean(
          context.popup && context.popup.contains(canonical)
        ),
        linkedToControlledOption: optionKeys.some((key) =>
          context.optionKeys.has(key)
        ),
        inExpandedPopup: Boolean(
          control.getAttribute("aria-expanded") === "true" &&
            popup &&
            isVisible(popup)
        ),
        active:
          canonical.getAttribute("aria-selected") === "true" ||
          canonical.getAttribute("data-state") === "selected" ||
          canonical.classList.contains("ecom-g-select-item-option-active")
      };
    })
  );
  const visiblePopups = Array.from(
    new Set(
      optionCandidates
        .map((candidate) => candidate.popup)
        .filter((popup) => popup && isVisible(popup))
    )
  );
  for (const candidate of optionCandidates) {
    candidate.inUniqueVisiblePopup =
      visiblePopups.length === 1 &&
      candidate.popup === visiblePopups[0];
  }
  const resolution = classifyExactOptionCandidates(optionCandidates);
  const resolvedCandidates = collapseEquivalentOptionCandidates(
    resolution.candidates
  );
  const evidence = {
    ...calibrationEvidence([optionText]),
    locatorStrategy: resolution.strategy,
    strategyCounts: resolution.strategyCounts,
    control: describeElement(control),
    controlledIds: context.ids,
    controlledListCount: context.lists.length,
    controlledPopup: describeElement(context.popup),
    visiblePopupCount: visiblePopups.length,
    rawCandidateCount: rawCandidates.length,
    resolvedCandidateCount: resolvedCandidates.length,
    candidates: optionCandidates.slice(0, 20).map((candidate) => ({
      ...describeElement(candidate.element),
      optionIdentity: candidate.optionIdentity,
      optionText: candidate.optionText,
      matchedValues: candidate.matchedValues,
      popup: describeElement(candidate.popup),
      inControlledPopup: candidate.inControlledPopup,
      linkedToControlledOption: candidate.linkedToControlledOption,
      inExpandedPopup: candidate.inExpandedPopup,
      inUniqueVisiblePopup: candidate.inUniqueVisiblePopup,
      active: candidate.active,
      equivalentCandidateCount:
        candidate.equivalentCandidateCount || null
    }))
  };
  return {
    expected,
    context,
    rawCandidates,
    optionCandidates,
    resolution,
    resolvedCandidates,
    evidence
  };
}

async function selectExactOptionOnControl(control, optionText, options = {}) {
  const clickTarget = isVisible(control)
    ? control
    : uniqueElement(
        allVisible(
          ".ecom-g-select-selector, [class*=select-selector], [class*=SelectSelector]",
          selectControlScope(control)
        ),
        "SELECTION_CONTROL_TARGET_AMBIGUOUS",
        `下拉控件 ${optionText}`,
        { control: describeElement(control) }
      );
  const openInteraction = dispatchPointerClick(clickTarget);
  await waitFor(
    () => {
      const current = exactOptionSelectionState(control, optionText);
      return control.getAttribute("aria-expanded") === "true" ||
        current.resolvedCandidates.length > 0
        ? current
        : null;
    },
    {
      timeout: options.openTimeoutMs ?? ACTION_TIMEOUT_MS,
      interval: options.openIntervalMs ?? POLL_INTERVAL_MS,
      code: "OPTION_DROPDOWN_OPEN_TIMEOUT",
      label: `选项 ${optionText} 下拉框未打开`,
      runToken: options.runToken
    }
  );
  const searchWrite = options.searchText
    ? nativeSetSearchValue(control, options.searchText)
    : null;
  let state;
  if (searchWrite) {
    state = (
      await waitFor(
        () => {
          const current = exactOptionSelectionState(control, optionText);
          if (current.resolvedCandidates.length === 1) return current;
          throw new PageCommandError(
            "OPTION_SEARCH_NOT_CONVERGED",
            `选项 ${optionText} 搜索结果未收敛`,
            {
              searchWrite,
              ...current.evidence
            }
          );
        },
        {
          timeout: options.searchTimeoutMs ?? ACTION_TIMEOUT_MS,
          interval: options.searchIntervalMs ?? POLL_INTERVAL_MS,
          code: "OPTION_SEARCH_TIMEOUT",
          label: `选项 ${optionText} 搜索结果未收敛`,
          runToken: options.runToken
        }
      )
    ).value;
  } else {
    try {
      state = (
        await waitFor(
          () => {
            const current = exactOptionSelectionState(control, optionText);
            return current.resolvedCandidates.length === 1 ? current : null;
          },
          {
            timeout: options.optionTimeoutMs ?? ACTION_TIMEOUT_MS,
            interval: options.optionIntervalMs ?? POLL_INTERVAL_MS,
            code: "OPTION_RESOLUTION_TIMEOUT",
            label: `选项 ${optionText} 未出现`,
            runToken: options.runToken
          }
        )
      ).value;
    } catch (error) {
      if (!(error instanceof PageCommandError) || error.code !== "OPTION_RESOLUTION_TIMEOUT") {
        throw error;
      }
      // Preserve the established missing/ambiguous error contract after render settles.
      state = exactOptionSelectionState(control, optionText);
    }
  }
  const selectionControl = typeof options.resolveControl === "function"
    ? options.resolveControl()
    : control;
  state = exactOptionSelectionState(selectionControl, optionText);
  const option = uniqueElement(
    state.resolvedCandidates.map((candidate) => candidate.element),
    "OPTION_AMBIGUOUS",
    `选项 ${optionText}`,
    {
      searchWrite,
      ...state.evidence
    }
  );
  const selectionInteraction = dispatchSelectOptionClick(option);
  const readback = await waitFor(
    () => {
      let currentControl = control;
      let actual;
      if (typeof options.readSelection === "function") {
        actual = options.readSelection();
      } else {
        currentControl = typeof options.resolveControl === "function"
          ? options.resolveControl()
          : control;
        actual = readSelectionControlValue(currentControl, optionText);
      }
      const selected = allVisible(
        '[aria-selected="true"], option:checked, [data-state="selected"]'
      ).filter(
        (element) => normalizeText(displayText(element)) === state.expected
      );
      return normalizeText(actual) === state.expected
        ? {
            actual,
            selectedCount: selected.length,
            control: currentControl
          }
        : null;
    },
    {
      timeout: options.readbackTimeoutMs ?? ACTION_TIMEOUT_MS,
      interval: options.readbackIntervalMs ?? POLL_INTERVAL_MS,
      code: "OPTION_READBACK_TIMEOUT",
      label: `选项 ${optionText} 选中后回读未稳定`,
      runToken: options.runToken,
      evidence: {
        expected: optionText,
        originalControl: describeElement(control),
        selectionInteraction
      }
    }
  );
  const { actual, selectedCount } = readback.value;
  return {
    expected: optionText,
    actual,
    selectedCount,
    readbackElapsedMs: readback.elapsedMs,
    openInteraction,
    searchWrite,
    selectionInteraction,
    selectedText: actual,
    locatorStrategy: state.resolution.strategy
  };
}

async function selectExactOption(labels, optionText) {
  const control = controlByExactLabel(
    labels,
    '[role="combobox"], input, select'
  );
  return selectExactOptionOnControl(control, optionText);
}

function verifyReconstructedFile(file, payload) {
  const actual = {
    name: file.name,
    type: file.type,
    size: file.size,
    lastModified: file.lastModified
  };
  const expected = {
    name: payload.name,
    type: payload.type,
    size: payload.size,
    lastModified: payload.lastModified
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new PageCommandError(
      "FILE_RECONSTRUCTION_MISMATCH",
      "重建文件元数据不一致",
      { expected, actual }
    );
  }
  return actual;
}

function assignSingleFile(input, payload, options = {}) {
  if (!(input instanceof HTMLInputElement) || input.type !== "file") {
    throw new PageCommandError(
      "FILE_INPUT_INVALID",
      "目标不是文件输入框",
      describeElement(input)
    );
  }
  if (input.disabled) {
    throw new PageCommandError(
      "FILE_INPUT_DISABLED",
      "文件输入框不可用",
      describeElement(input)
    );
  }
  const file = DoudianBinary.payloadToFile(payload);
  const fileEvidence = verifyReconstructedFile(file, payload);
  const transfer = new DataTransfer();
  transfer.items.add(file);
  if (transfer.files.length !== 1) {
    throw new PageCommandError(
      "DATA_TRANSFER_REJECTED",
      "DataTransfer未保留唯一文件"
    );
  }
  input.files = transfer.files;
  const selected = input.files?.[0];
  if (
    input.files.length !== 1 ||
    selected.name !== file.name ||
    selected.size !== file.size ||
    selected.type !== file.type
  ) {
    throw new PageCommandError(
      "FILE_INPUT_READBACK_MISMATCH",
      "文件输入框回读不一致",
      {
        expected: fileEvidence,
        actual: selected
          ? { name: selected.name, size: selected.size, type: selected.type }
          : null
      }
    );
  }
  const events = options.events || ["input", "change"];
  for (const type of events) {
    input.dispatchEvent(
      new Event(type, { bubbles: true, composed: true })
    );
  }
  return {
    file: fileEvidence,
    dataTransferFileCount: transfer.files.length,
    events: [...events]
  };
}

function describeUploadContainer(container) {
  const labels = allVisible("label", container);
  return {
    imageInputCount: container.querySelectorAll(IMAGE_INPUT_SELECTOR).length,
    mainLabelCount: labels.filter((label) =>
      normalizeText(displayText(label)).includes(normalizeText(MAIN_UPLOAD_TEXT))
    ).length,
    auxiliaryLabelCount: labels.filter((label) =>
      normalizeText(displayText(label)).includes(
        normalizeText(AUXILIARY_UPLOAD_TEXT)
      )
    ).length,
    previewCount: container.querySelectorAll(PREVIEW_SELECTOR).length
  };
}

function primaryContainerCandidates() {
  return Array.from(document.querySelectorAll("ul")).filter(
    (container) => describeUploadContainer(container).imageInputCount === 5
  );
}

function visibleLabelsContaining(text) {
  const expected = normalizeText(text);
  return allVisible("label").filter((label) =>
    normalizeText(displayText(label)).includes(expected)
  );
}

function remoteImageResourceUrls(container) {
  const rawUrls = [];
  const appendSrcset = (srcset) => {
    if (!srcset) return;
    rawUrls.push(
      ...srcset
        .split(",")
        .map((candidate) => candidate.trim().split(/\s+/)[0])
    );
  };
  for (const image of container.querySelectorAll("img")) {
    rawUrls.push(image.currentSrc, image.getAttribute("src"));
    appendSrcset(image.getAttribute("srcset"));
  }
  for (const source of container.querySelectorAll("source")) {
    rawUrls.push(source.getAttribute("src"));
    appendSrcset(source.getAttribute("srcset"));
  }
  return Array.from(
    new Set(
      rawUrls.filter((rawUrl) =>
        DoudianUploadState.isDoudianMainImageResource(
          rawUrl,
          location.href
        )
      )
    )
  );
}

function inspectPostUploadMainState(expectedMainInputIndex) {
  const globalImageInputs = Array.from(
    document.querySelectorAll(IMAGE_INPUT_SELECTOR)
  );
  const nonMultipleInputs = globalImageInputs.filter(
    (candidate) => !candidate.multiple
  );
  const multipleInputs = globalImageInputs.filter(
    (candidate) => candidate.multiple
  );
  const mainPreviews = allVisible(MAIN_PREVIEW_SELECTOR);
  const mainPreview = mainPreviews.length === 1 ? mainPreviews[0] : null;
  const mainInput =
    nonMultipleInputs.length === 1 ? nonMultipleInputs[0] : null;
  const auxiliaryControls = multipleInputs.map((candidate) =>
    candidate.closest(AUXILIARY_CONTROL_SELECTOR)
  );
  const uniqueAuxiliaryControls = Array.from(
    new Set(auxiliaryControls.filter(Boolean))
  );
  const validAuxiliaryControls = uniqueAuxiliaryControls.filter(
    (control) =>
      isVisible(control) &&
      normalizeText(displayText(control)).includes(
        normalizeText(AUXILIARY_UPLOAD_TEXT)
      ) &&
      control.querySelectorAll(IMAGE_INPUT_SELECTOR).length === 1 &&
      control.querySelector(IMAGE_INPUT_SELECTOR)?.multiple === true
  );
  const slotElements =
    mainPreview && uniqueAuxiliaryControls.length === 4
      ? [mainPreview, ...uniqueAuxiliaryControls]
      : [];
  const scope =
    slotElements.length === 5 ? nearestCommonAncestor(slotElements) : null;
  const scopeIsLocal =
    isElement(scope) &&
    scope !== document.body &&
    scope !== document.documentElement;
  const scopedImageInputs = scopeIsLocal
    ? Array.from(scope.querySelectorAll(IMAGE_INPUT_SELECTOR))
    : [];
  const scopedLabels = scopeIsLocal ? allVisible("label", scope) : [];
  const mainInputIndex = mainInput
    ? globalImageInputs.indexOf(mainInput)
    : -1;
  const remoteResources = mainPreview
    ? remoteImageResourceUrls(mainPreview)
    : [];
  return {
    legacyInitialContainerCount: primaryContainerCandidates().length,
    globalImageInputCount: globalImageInputs.length,
    imageInputCount: scopedImageInputs.length,
    nonMultipleImageInputCount: nonMultipleInputs.length,
    multipleImageInputCount: multipleInputs.length,
    mainLabelCount: visibleLabelsContaining(MAIN_UPLOAD_TEXT).length,
    auxiliaryLabelCount:
      visibleLabelsContaining(AUXILIARY_UPLOAD_TEXT).length,
    scopedMainLabelCount: scopedLabels.filter((label) =>
      normalizeText(displayText(label)).includes(normalizeText(MAIN_UPLOAD_TEXT))
    ).length,
    scopedAuxiliaryLabelCount: scopedLabels.filter((label) =>
      normalizeText(displayText(label)).includes(
        normalizeText(AUXILIARY_UPLOAD_TEXT)
      )
    ).length,
    auxiliaryControlCount: uniqueAuxiliaryControls.length,
    validAuxiliaryControlCount: validAuxiliaryControls.length,
    previewCount: scopeIsLocal
      ? scope.querySelectorAll(PREVIEW_SELECTOR).length
      : 0,
    mainPreviewCount: mainPreviews.length,
    mainPreviewContainsUniqueInput:
      Boolean(mainPreview) &&
      Boolean(mainInput) &&
      mainPreview.contains(mainInput),
    mainPreviewMediaCount: mainPreview
      ? mainPreview.querySelectorAll("picture, source, img").length
      : 0,
    mainRemoteResourceCount: remoteResources.length,
    mainRemoteResources: remoteResources,
    mainInputIndex,
    expectedMainInputIndex,
    stronglyScoped:
      scopeIsLocal &&
      scopedImageInputs.length === 5 &&
      scopedLabels.filter((label) =>
        normalizeText(displayText(label)).includes(
          normalizeText(MAIN_UPLOAD_TEXT)
        )
      ).length === 0 &&
      scopedLabels.filter((label) =>
        normalizeText(displayText(label)).includes(
          normalizeText(AUXILIARY_UPLOAD_TEXT)
        )
      ).length === 4 &&
      mainInputIndex === expectedMainInputIndex &&
      slotElements.every((element) => scope.contains(element))
  };
}

function findUniqueInitialMainInput() {
  const containers = primaryContainerCandidates();
  const initialContainers = containers.filter((container) =>
    DoudianUploadState.isInitialMainContainer(
      describeUploadContainer(container)
    )
  );
  const container = uniqueElement(
    initialContainers,
    "MAIN_IMAGE_CONTAINER_AMBIGUOUS",
    "初始主图上传容器",
    {
      candidateCount: containers.length,
      states: containers.map(describeUploadContainer)
    }
  );
  const labels = visibleLabelsContaining(MAIN_UPLOAD_TEXT).filter(
    (label) => label.closest("ul") === container
  );
  const label = uniqueElement(
    labels,
    "MAIN_IMAGE_LABEL_AMBIGUOUS",
    MAIN_UPLOAD_TEXT
  );
  const inputs = Array.from(label.querySelectorAll(IMAGE_INPUT_SELECTOR));
  const input = uniqueElement(
    inputs,
    "MAIN_IMAGE_INPUT_AMBIGUOUS",
    "主图文件输入框"
  );
  if (input.disabled) {
    throw new PageCommandError(
      "MAIN_IMAGE_INPUT_DISABLED",
      "主图文件输入框不可用"
    );
  }
  return {
    container,
    label,
    input,
    beforeState: {
      ...describeUploadContainer(container),
      mainInputIndex: Array.from(
        container.querySelectorAll(IMAGE_INPUT_SELECTOR)
      ).indexOf(input)
    }
  };
}

function labelWasReplaced(label, input) {
  return (
    !label.isConnected ||
    !input.isConnected ||
    !isVisible(label) ||
    !normalizeText(displayText(label)).includes(normalizeText(MAIN_UPLOAD_TEXT)) ||
    label.querySelector('input[type="file"]') !== input
  );
}

async function uploadMain(args, context) {
  const { label, input, beforeState } = findUniqueInitialMainInput();
  const selected = assignSingleFile(input, args.file || args.payload || args);
  const transition = await waitFor(
    () => {
      const afterState = inspectPostUploadMainState(
        beforeState.mainInputIndex
      );
      const replaced = labelWasReplaced(label, input);
      return DoudianUploadState.isVerifiedMainPreviewTransition(
        beforeState,
        afterState,
        replaced
      )
        ? { afterState, originalControlReplaced: replaced }
        : null;
    },
    {
      timeout: UPLOAD_TIMEOUT_MS,
      code: "MAIN_IMAGE_POSTCONDITION_TIMEOUT",
      label: "主图预览未通过严格校验",
      runToken: context.runToken,
      evidence: { beforeState }
    }
  );
  return {
    selected,
    preview: {
      beforeState,
      ...transition.value,
      elapsedMs: transition.elapsedMs
    }
  };
}

function inspectAuxiliaryState(strict = true) {
  const globalPreviewCount = allVisible(
    ".material-button.material-preview-button"
  ).length;
  const candidates = Array.from(document.querySelectorAll("ul")).filter(
    (container) =>
      container.querySelectorAll(IMAGE_INPUT_SELECTOR).length === 5 &&
      container.querySelectorAll(".material-button").length === 5
  );
  const candidateDescriptions = candidates.map((container) => {
    const imageInputs = Array.from(
      container.querySelectorAll(IMAGE_INPUT_SELECTOR)
    );
    const controls = Array.from(
      container.querySelectorAll(".material-button")
    );
    const uniqueControls = Array.from(new Set(controls));
    const mappedControls = Array.from(
      new Set(
        imageInputs
          .map((input) => input.closest(".material-button"))
          .filter((control) => control && container.contains(control))
      )
    );
    const controlStates = uniqueControls.map((control) => {
      const inputs = Array.from(
        control.querySelectorAll(IMAGE_INPUT_SELECTOR)
      );
      const preview = control.matches(
        ".material-button.material-preview-button"
      );
      const upload = control.matches(AUXILIARY_CONTROL_SELECTOR);
      return {
        kind: preview === upload ? "invalid" : preview ? "preview" : "upload",
        imageInputCount: inputs.length,
        multiple: inputs.length === 1 ? inputs[0].multiple : null,
        exactAuxiliaryText:
          normalizeText(displayText(control)) ===
          normalizeText(AUXILIARY_UPLOAD_TEXT),
        remoteResourceCount: remoteImageResourceUrls(control).length,
        element: describeElement(control)
      };
    });
    return {
      candidateUlCount: candidates.length,
      imageInputCount: imageInputs.length,
      controlCount: controls.length,
      uniqueControlCount: uniqueControls.length,
      visibleControlCount: uniqueControls.filter(isVisible).length,
      mappedInputControlCount: mappedControls.length,
      previewCount: controlStates.filter(
        (control) => control.kind === "preview"
      ).length,
      emptySlotCount: controlStates.filter(
        (control) => control.kind === "upload"
      ).length,
      globalPreviewCount,
      controls: controlStates
    };
  });
  const scope = candidates.length === 1 ? candidates[0] : null;
  const state =
    candidateDescriptions.length === 1
      ? candidateDescriptions[0]
      : {
          candidateUlCount: candidates.length,
          globalPreviewCount,
          candidateDescriptions
        };

  try {
    const contract =
      globalThis.DoudianMediaContract?.assertAuxiliarySlotState(state);
    if (!contract) {
      throw new PageCommandError(
        "AUXILIARY_MEDIA_CONTRACT_UNAVAILABLE",
        "辅助图媒体合约加载失败",
        state
      );
    }
    const controls = Array.from(
      scope.querySelectorAll(".material-button")
    );
    return {
      ...state,
      ...contract,
      local: true,
      controls: controls.slice(contract.targetControlIndex),
      scope
    };
  } catch (error) {
    if (strict) {
      throw new PageCommandError(
        error?.code || "AUXILIARY_MEDIA_SCOPE_UNRECOGNIZED",
        "辅助图区域无法严格识别",
        error?.evidence || state
      );
    }
    return {
      ...state,
      local: false,
      controls: [],
      scope
    };
  }
}

function assertAuxiliaryTransition(before, after, fileIndex) {
  if (globalThis.DoudianMediaContract) {
    return DoudianMediaContract.assertAuxiliaryTransition(
      before,
      after,
      fileIndex
    );
  }
  const expectedBefore = 4 - fileIndex;
  if (
    !Number.isInteger(fileIndex) ||
    fileIndex < 0 ||
    fileIndex > 3 ||
    before !== expectedBefore ||
    after !== expectedBefore - 1
  ) {
    throw new PageCommandError(
      "AUXILIARY_SLOT_TRANSITION_MISMATCH",
      "辅助图空位未按计划减少一个",
      { fileIndex, before, after, expectedBefore, expectedAfter: expectedBefore - 1 }
    );
  }
  return { fileIndex, before, after };
}

async function uploadAuxiliary(args, context) {
  const fileIndex = Number(args.index ?? args.fileIndex);
  if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex > 3) {
    throw new PageCommandError(
      "AUXILIARY_INDEX_INVALID",
      "辅助图序号必须为0到3",
      { fileIndex }
    );
  }
  const expectedBefore = 4 - fileIndex;
  const beforeReadiness = await waitFor(
    () => {
      const state = inspectAuxiliaryState();
      if (state.emptySlotCount === expectedBefore) return state;
      throw new PageCommandError(
        "AUXILIARY_PRECONDITION_NOT_READY",
        "辅助图上传槽仍在重绘或素材状态不匹配",
        {
          fileIndex,
          expectedEmptySlots: expectedBefore,
          actualEmptySlots: state.emptySlotCount,
          globalPreviewCount: state.globalPreviewCount
        }
      );
    },
    {
      timeout: ACTION_TIMEOUT_MS,
      code: "AUXILIARY_PRECONDITION_TIMEOUT",
      label: "辅助图上传前空位状态未稳定",
      runToken: context.runToken,
      evidence: { fileIndex, expectedEmptySlots: expectedBefore }
    }
  );
  const beforeState = beforeReadiness.value;
  const control = beforeState.controls[0];
  const input = uniqueElement(
    Array.from(control.querySelectorAll(IMAGE_INPUT_SELECTOR)),
    "AUXILIARY_INPUT_AMBIGUOUS",
    "辅助图文件输入框"
  );
  const selected = assignSingleFile(input, args.file || args.payload);
  const transition = await waitFor(
    () => {
      const afterState = inspectAuxiliaryState();
      if (afterState.emptySlotCount === expectedBefore - 1) {
        assertAuxiliaryTransition(
          beforeState.emptySlotCount,
          afterState.emptySlotCount,
          fileIndex
        );
        return afterState;
      }
      return null;
    },
    {
      timeout: UPLOAD_TIMEOUT_MS,
      code: "AUXILIARY_UPLOAD_POSTCONDITION_TIMEOUT",
      label: "辅助图上传后空位数量未减少一个",
      runToken: context.runToken,
      evidence: { fileIndex, before: beforeState.emptySlotCount }
    }
  );
  return {
    fileIndex,
    selected,
    beforeEmptySlots: beforeState.emptySlotCount,
    afterEmptySlots: transition.value.emptySlotCount,
    elapsedMs: transition.elapsedMs
  };
}

function classifyCategoryCandidates(candidates, expectedPath) {
  const normalize = (value) =>
    String(value ?? "")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .trim();
  const expected = normalize(expectedPath);
  const selected = candidates.filter(
    (candidate) =>
      candidate.selected === true &&
      normalize(candidate.text) === expected
  );
  return {
    candidateCount: candidates.length,
    selectedCount: selected.length,
    selectedTexts: selected.slice(0, 8).map((candidate) => candidate.text),
    resolved: selected.length === 1
  };
}

function classifyManualCategorySearchResults(candidates, expectedPath) {
  const normalize = (value) =>
    String(value ?? "")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .trim();
  const expected = normalize(expectedPath);
  const matches = candidates.filter(
    (candidate) => normalize(candidate.text) === expected
  );
  return {
    candidateCount: candidates.length,
    matchingCount: matches.length,
    matchingTexts: matches.slice(0, 8).map((candidate) => candidate.text),
    resolved: matches.length === 1,
    match: matches[0] || null
  };
}

function categorySelectedState(element) {
  const className =
    typeof element.className === "string" ? element.className : "";
  return (
    /(?:^|\s)styles_itemSelected__[A-Za-z0-9_-]+(?:\s|$)/.test(
      className
    ) ||
    element.getAttribute("aria-selected") === "true" ||
    element.getAttribute("data-state") === "selected"
  );
}

function categoryPathText(element) {
  const chunks = [];
  const visit = (node) => {
    if (node?.nodeType === 3) {
      chunks.push(node.textContent || "");
      return;
    }
    if (!isElement(node)) return;
    if (node.classList.contains("sp-icon-parcel")) {
      chunks.push(" > ");
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(element);
  return chunks
    .join("")
    .replace(/\s*>\s*/g, " > ")
    .replace(/\s+/g, " ")
    .trim();
}

function categoryResolutionEvidence(strict = true) {
  const selectedWrappers = allVisible(
    '[class*="itemSelected"], [aria-selected="true"], [data-state="selected"]'
  );
  const candidates = selectedWrappers.map((element) => ({
    selected: categorySelectedState(element),
    text: categoryPathText(element),
    element
  }));
  const classification = classifyCategoryCandidates(
    candidates,
    EXPECTED_CATEGORY_PATH
  );
  const evidence = {
    expectedPath: EXPECTED_CATEGORY_PATH,
    selectedWrapperCount: classification.selectedCount,
    selectedTexts: classification.selectedTexts,
    resolved: classification.resolved,
    selectedWrappers: candidates.slice(0, 8).map((candidate) => ({
      selected: candidate.selected,
      text: candidate.text,
      element: describeElement(candidate.element)
    }))
  };
  if (strict && !evidence.resolved) {
    throw new PageCommandError(
      "MANUAL_CATEGORY_READBACK_UNRESOLVED",
      "手动选择类目后的回读未唯一且可见地完成",
      {
        ...evidence,
        calibration: calibrationEvidence([
          EXPECTED_CATEGORY_PATH
        ])
      }
    );
  }
  return evidence;
}

function safeTitleBlurTarget(title) {
  const headingCandidates = allVisible(
    "h1, h2, h3, h4, h5, h6, div, span, p"
  ).filter((element) => {
    if (normalizeText(displayText(element)) !== normalizeText("主图上传")) {
      return false;
    }
    return (
      !element.matches(
        'button, a, label, input, textarea, select, [role="button"], [role="option"], [contenteditable="true"]'
      ) &&
      !element.closest(
        'button, a, label, [role="button"], [role="option"]'
      ) &&
      !element.querySelector(
        'button, a, input, textarea, select, [role="button"], [role="option"], [contenteditable="true"]'
      )
    );
  });
  if (headingCandidates.length === 1) {
    return {
      element: headingCandidates[0],
      kind: "main_image_heading"
    };
  }

  const imageLists = primaryContainerCandidates();
  const imageList = uniqueElement(
    imageLists,
    "TITLE_BLUR_TARGET_AMBIGUOUS",
    "商品标题外部安全点击区域",
    {
      headingCandidateCount: headingCandidates.length,
      imageListCount: imageLists.length
    }
  );
  if (
    imageList.contains(title) ||
    imageList.matches(
      'button, a, label, input, textarea, select, [role="button"], [role="option"], [contenteditable="true"]'
    )
  ) {
    throw new PageCommandError(
      "TITLE_BLUR_TARGET_UNSAFE",
      "商品标题外部点击区域不安全",
      describeElement(imageList)
    );
  }
  return { element: imageList, kind: "five_slot_image_list" };
}

async function waitForCategoryReadiness(runToken, title) {
  const waitEvidence = {
    title,
    category: null,
    nextButtonCount: 0,
    enabledNextButtonCount: 0
  };
  return waitFor(
    () => {
      const category = categoryResolutionEvidence(false);
      const nextButtons = exactActionCandidates(["下一步"]);
      const enabledNextButtons = nextButtons.filter(isEnabled);
      waitEvidence.category = category;
      waitEvidence.nextButtonCount = nextButtons.length;
      waitEvidence.enabledNextButtonCount = enabledNextButtons.length;
      return category.resolved && enabledNextButtons.length === 1
        ? {
            category,
            next: enabledNextButtons[0],
            nextButtonCount: nextButtons.length
          }
        : null;
    },
    {
      timeout: CATEGORY_TIMEOUT_MS,
      code: "MANUAL_CATEGORY_READBACK_TIMEOUT",
      label: "已选手动类目或下一步可用状态等待超时",
      runToken,
      evidence: waitEvidence
    }
  );
}

function exactManualCategorySearchInputs(scope = document) {
  return allVisible('input:not([type="hidden"])', scope).filter(
    (input) =>
      normalizeText(input.getAttribute("placeholder")) ===
      normalizeText(MANUAL_CATEGORY_SEARCH_PLACEHOLDER)
  );
}

function hasManualCategoryDialogContract(scope, input) {
  if (!scope?.contains(input) || !isVisible(scope)) return false;
  const confirmButtons = exactActionCandidates(["确认"], scope);
  if (confirmButtons.length !== 1) return false;
  return allVisible(
    "h1, h2, h3, h4, h5, h6, div, span, p",
    scope
  ).some(
    (element) =>
      normalizeText(displayText(element)) ===
      normalizeText(MANUAL_CATEGORY_DIALOG_TITLE)
  );
}

function manualCategoryDialogFromSearchInput(input) {
  const semanticSelector =
    '[role="dialog"], [class*=modal], [class*=Modal], [class*=dialog], [class*=Dialog]';
  let semanticScope = input.parentElement;
  while (semanticScope && semanticScope !== document.body) {
    if (
      semanticScope.matches(semanticSelector) &&
      hasManualCategoryDialogContract(semanticScope, input)
    ) {
      return semanticScope;
    }
    semanticScope = semanticScope.parentElement;
  }

  const confirmButtons = exactActionCandidates(["确认"]);
  if (confirmButtons.length !== 1) return null;
  let scope = nearestCommonAncestor([input, confirmButtons[0]]);
  while (scope && scope !== document.body) {
    if (hasManualCategoryDialogContract(scope, input)) return scope;
    scope = scope.parentElement;
  }
  return null;
}

function manualCategoryDialogCandidates() {
  const searchInputs = exactManualCategorySearchInputs();
  if (searchInputs.length === 1) {
    const inputOwnedDialog = manualCategoryDialogFromSearchInput(
      searchInputs[0]
    );
    if (inputOwnedDialog) return [inputOwnedDialog];
  }

  return dialogCandidates().filter((dialog) =>
    allVisible("h1, h2, h3, h4, h5, h6, div, span, p", dialog).some(
      (element) =>
        normalizeText(displayText(element)) ===
        normalizeText(MANUAL_CATEGORY_DIALOG_TITLE)
    )
  );
}

function manualCategorySearchInput(dialog) {
  const inputs = exactManualCategorySearchInputs(dialog);
  return uniqueElement(
    inputs,
    "MANUAL_CATEGORY_SEARCH_INPUT_AMBIGUOUS",
    "手动类目搜索输入框",
    { dialog: describeElement(dialog) }
  );
}

function manualCategorySearchResultPath(element) {
  return categoryPathText(element);
}

function manualCategorySearchResultCandidates(dialog) {
  return allVisible(
    '[role="option"], li, div',
    dialog
  ).filter(
    (element) => normalizeText(manualCategorySearchResultPath(element)) ===
      normalizeText(EXPECTED_CATEGORY_PATH)
  );
}

async function searchExpectedManualCategory(dialog, context) {
  const attempts = [];
  const strategies = [
    "insertText",
    "native_setter_input_event",
    "incremental_insert_text"
  ];
  recordManualCategoryDiagnostic("search_started", {
    strategyCount: strategies.length
  });
  for (let attempt = 1; attempt <= strategies.length; attempt += 1) {
    const searchInputReady = await waitFor(
      () => manualCategorySearchInput(dialog),
      {
        timeout: ACTION_TIMEOUT_MS,
        code: "MANUAL_CATEGORY_SEARCH_INPUT_NOT_READY",
        label: "手动类目搜索输入框未唯一就绪",
        runToken: context.runToken,
        evidence: { placeholder: MANUAL_CATEGORY_SEARCH_PLACEHOLDER }
      }
    );
    const searchInput = searchInputReady.value;
    const strategy = strategies[attempt - 1];
    const searchWrite =
      strategy === "incremental_insert_text"
        ? await typeManualCategorySearchIncrementally(
            dialog,
            MANUAL_CATEGORY_SEARCH_TEXT,
            context.runToken
          )
        : nativeSetManualCategorySearchValue(
            searchInput,
            MANUAL_CATEGORY_SEARCH_TEXT,
            strategy
          );
    recordManualCategoryDiagnostic("search_write", {
      attempt,
      strategy,
      method: searchWrite.method,
      immediateValue: searchWrite.value,
      stable: searchWrite.stable ?? null
    });
    console.info(
      `[Doudian Listing Assistant] manual category search write ${attempt}`,
      {
        buildId: EXECUTOR_BUILD_ID,
        method: searchWrite.method,
        insertTextAccepted: searchWrite.insertTextAccepted,
        immediateValue: searchWrite.value
      }
    );
    const outcomeReady = await waitFor(
      () => {
        const liveSearchInput = manualCategorySearchInput(dialog);
        const actual = liveSearchInput?.isConnected
          ? String(liveSearchInput.value)
          : null;
        if (
          !liveSearchInput?.isConnected ||
          normalizeText(actual) !== normalizeText(MANUAL_CATEGORY_SEARCH_TEXT)
        ) {
          return {
            status: "reset",
            actual,
            inputReplaced: liveSearchInput !== searchInput
          };
        }
        const candidates = manualCategorySearchResultCandidates(dialog).map(
          (element) => ({
            text: manualCategorySearchResultPath(element),
            element
          })
        );
        const classification = classifyManualCategorySearchResults(
          candidates,
          EXPECTED_CATEGORY_PATH
        );
        return classification.resolved
          ? {
              status: "resolved",
              classification,
              searchInput: liveSearchInput
            }
          : null;
      },
      {
        timeout: CATEGORY_TIMEOUT_MS,
        code: "MANUAL_CATEGORY_SEARCH_RESULT_TIMEOUT",
        label: "手动类目搜索结果未唯一匹配目标层级",
        runToken: context.runToken,
        evidence: {
          attempt,
          searchText: MANUAL_CATEGORY_SEARCH_TEXT,
          expectedPath: EXPECTED_CATEGORY_PATH
        }
      }
    );
    const outcome = outcomeReady.value;
    attempts.push({
      attempt,
      strategy,
      actual: outcome.actual ?? MANUAL_CATEGORY_SEARCH_TEXT,
      inputReplaced: outcome.inputReplaced === true,
      inputReadyElapsedMs: searchInputReady.elapsedMs,
      elapsedMs: outcomeReady.elapsedMs,
      searchWrite
    });
    recordManualCategoryDiagnostic("search_outcome", {
      attempt,
      strategy,
      status: outcome.status,
      actual: outcome.actual ?? MANUAL_CATEGORY_SEARCH_TEXT,
      inputReplaced: outcome.inputReplaced === true,
      elapsedMs: outcomeReady.elapsedMs
    });
    console.info(
      `[Doudian Listing Assistant] manual category search outcome ${attempt}`,
      {
        buildId: EXECUTOR_BUILD_ID,
        status: outcome.status,
        actual: outcome.actual ?? MANUAL_CATEGORY_SEARCH_TEXT,
        inputReplaced: outcome.inputReplaced === true,
        elapsedMs: outcomeReady.elapsedMs
      }
    );
    if (outcome.status === "resolved") {
      recordManualCategoryDiagnostic("search_resolved", {
        attempt,
        strategy,
        expectedPath: EXPECTED_CATEGORY_PATH
      });
      return {
        ...outcome.classification,
        searchInput: outcome.searchInput,
        searchWrite,
        attempts,
        elapsedMs: attempts.reduce(
          (total, item) =>
            total + item.inputReadyElapsedMs + item.elapsedMs,
          0
        )
      };
    }
  }

  recordManualCategoryDiagnostic("search_value_reset", {
    expected: MANUAL_CATEGORY_SEARCH_TEXT,
    attempts
  });
  throw new PageCommandError(
    "MANUAL_CATEGORY_SEARCH_VALUE_RESET",
    "手动类目搜索词被页面重置",
    {
      expected: MANUAL_CATEGORY_SEARCH_TEXT,
      attempts
    }
  );
}

function shallowVisibleExactText(text, scope = document) {
  const candidates = visibleExactText(text, scope);
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) => other !== candidate && candidate.contains(other)
      )
  );
}

function ancestorDistance(element, ancestor, limit = 16) {
  let current = element;
  let distance = 0;
  while (current && distance <= limit) {
    if (current === ancestor) return distance;
    current = current.parentElement;
    distance += 1;
  }
  return null;
}

function manualCategoryFieldRecords(buttonNames) {
  const labels = shallowVisibleExactText(MANUAL_CATEGORY_FIELD_LABEL);
  const buttons = exactActionControlCandidates(buttonNames);
  const records = [];
  for (const label of labels) {
    for (const button of buttons) {
      const field = nearestCommonAncestor([label, button]);
      const local =
        field &&
        field !== document.body &&
        field !== document.documentElement;
      const labelDistance = local ? ancestorDistance(label, field) : null;
      const buttonDistance = local ? ancestorDistance(button, field) : null;
      const fieldButtonCount = local
        ? exactActionControlCandidates(buttonNames, field).length
        : 0;
      records.push({
        label,
        button,
        field,
        local,
        fieldButtonCount,
        distance:
          labelDistance === null || buttonDistance === null
            ? null
            : labelDistance + buttonDistance
      });
    }
  }
  return records;
}

function classifyManualCategoryButtonCandidates(records) {
  const local = records.filter(
    (record) =>
      record.local === true &&
      Number.isInteger(record.distance)
  );
  const nearestDistance = local.length
    ? Math.min(...local.map((record) => record.distance))
    : null;
  const nearest = local.filter(
    (record) => record.distance === nearestDistance
  );
  const candidates = nearest.every((record) => record.fieldButtonCount === 1)
    ? Array.from(new Set(nearest.map((record) => record.button)))
    : [];
  return { candidates, nearestDistance, records };
}

function locateManualCategoryButton() {
  // The live create form exposes this action as one enabled native button.
  // Prefer that exact control so a missing/repeated field label cannot block it.
  const nativeFullNameButtons = exactEnabledNativeButtonCandidates([
    MANUAL_CATEGORY_BUTTON_NAME
  ]);
  if (nativeFullNameButtons.length === 1) {
    return nativeFullNameButtons[0];
  }

  const primaryRecords = manualCategoryFieldRecords([
    MANUAL_CATEGORY_BUTTON_NAME
  ]);
  const primaryResolution = classifyManualCategoryButtonCandidates(
    primaryRecords
  );
  // The live form uses the full action name. Only support the older short
  // label when that current control is completely absent.
  const usingCompatibilityFallback = primaryRecords.length === 0;
  const actionNames = usingCompatibilityFallback
    ? [MANUAL_CATEGORY_BUTTON_COMPATIBILITY_NAME]
    : [MANUAL_CATEGORY_BUTTON_NAME];
  const resolution = usingCompatibilityFallback
    ? classifyManualCategoryButtonCandidates(
        manualCategoryFieldRecords(actionNames)
      )
    : primaryResolution;
  return uniqueElement(
    resolution.candidates,
    "MANUAL_CATEGORY_BUTTON_AMBIGUOUS",
    "商品类目字段的操作 手动选择类目",
    {
      fieldLabel: MANUAL_CATEGORY_FIELD_LABEL,
      actionNames,
      usingCompatibilityFallback,
      locatorStrategy:
        "unique_enabled_native_full_action_then_scoped_legacy_fallback",
      nativeFullNameButtonCount: nativeFullNameButtons.length,
      nativeFullNameButtons: nativeFullNameButtons.slice(0, 20).map(
        describeElement
      ),
      nearestDistance: resolution.nearestDistance,
      records: resolution.records.slice(0, 20).map((record) => ({
        local: record.local,
        fieldButtonCount: record.fieldButtonCount,
        distance: record.distance,
        label: describeElement(record.label),
        button: describeElement(record.button),
        field: describeElement(record.field)
      }))
    }
  );
}

async function selectExpectedManualCategory(context) {
  const manualButtonReady = await waitFor(
    () => locateManualCategoryButton(),
    {
      timeout: CATEGORY_TIMEOUT_MS,
      code: "MANUAL_CATEGORY_BUTTON_NOT_READY",
      label: "手动选择类目按钮未唯一就绪",
      runToken: context.runToken,
      evidence: {
        fieldLabel: MANUAL_CATEGORY_FIELD_LABEL,
        actionName: MANUAL_CATEGORY_BUTTON_NAME
      }
    }
  );
  const manualButton = manualButtonReady.value;
  const openInteraction = dispatchPointerClick(manualButton);
  const dialogReady = await waitFor(
    () => {
      const dialogs = manualCategoryDialogCandidates();
      return dialogs.length === 1 ? dialogs[0] : null;
    },
    {
      timeout: CATEGORY_TIMEOUT_MS,
      code: "MANUAL_CATEGORY_DIALOG_OPEN_TIMEOUT",
      label: "手动选择类目弹窗未出现",
      runToken: context.runToken
    }
  );
  const dialog = dialogReady.value;
  const categorySearch = await searchExpectedManualCategory(dialog, context);
  const searchWrite = categorySearch.searchWrite;
  const resultInteraction = dispatchPointerClick(categorySearch.match.element);
  const confirmReady = await waitFor(
    () => {
      const confirmButtons = exactActionCandidates(["确认"], dialog).filter(isEnabled);
      return confirmButtons.length === 1 ? confirmButtons[0] : null;
    },
    {
      timeout: ACTION_TIMEOUT_MS,
      code: "MANUAL_CATEGORY_CONFIRM_NOT_READY",
      label: "手动类目选择后确认按钮未就绪",
      runToken: context.runToken,
      evidence: { expectedPath: EXPECTED_CATEGORY_PATH }
    }
  );
  const confirmInteraction = dispatchPointerClick(confirmReady.value);
  const closed = await waitFor(
    () => manualCategoryDialogCandidates().length === 0,
    {
      timeout: CATEGORY_TIMEOUT_MS,
      code: "MANUAL_CATEGORY_DIALOG_CLOSE_TIMEOUT",
      label: "确认手动类目后弹窗未关闭",
      runToken: context.runToken
    }
  );
  const readback = await waitFor(
    () => {
      const category = categoryResolutionEvidence(false);
      return category.resolved ? category : null;
    },
    {
      timeout: CATEGORY_TIMEOUT_MS,
      code: "MANUAL_CATEGORY_READBACK_TIMEOUT",
      label: "确认手动类目后页面类目回读未就绪",
      runToken: context.runToken,
      evidence: { expectedPath: EXPECTED_CATEGORY_PATH }
    }
  );
  return {
    searchText: MANUAL_CATEGORY_SEARCH_TEXT,
    expectedPath: EXPECTED_CATEGORY_PATH,
    readback: readback.value,
    interactions: [openInteraction, resultInteraction, confirmInteraction],
    elapsedMs: manualButtonReady.elapsedMs + dialogReady.elapsedMs +
      categorySearch.elapsedMs +
      confirmReady.elapsedMs + closed.elapsedMs + readback.elapsedMs,
    searchWrite
  };
}

async function setTitleAndSelectManualCategory(args, context) {
  const expectedTitle = requestedMainTitle(args);
  const title = uniqueElement(
    initialTitleInputs(),
    "INITIAL_TITLE_AMBIGUOUS",
    "初始商品标题"
  );
  const blurTarget = safeTitleBlurTarget(title);
  title.focus();
  const write = nativeSetValue(title, expectedTitle);
  title.blur();
  blurTarget.element.click();
  if (normalizeText(title.value) !== normalizeText(expectedTitle)) {
    throw new PageCommandError(
      "TITLE_POSTCONDITION_MISMATCH",
      "商品标题回读不一致",
      { expected: expectedTitle, actual: title.value }
    );
  }
  const activeElement = document.activeElement;
  if (activeElement === title || title.contains(activeElement)) {
    throw new PageCommandError(
      "TITLE_BLUR_POSTCONDITION_MISMATCH",
      "商品标题失焦后焦点仍停留在标题输入框",
      {
        title: describeElement(title),
        activeElement: describeElement(activeElement),
        blurTarget: describeElement(blurTarget.element)
      }
    );
  }
  const manualCategory = await selectExpectedManualCategory(context);
  return {
    title: write,
    blur: {
      targetKind: blurTarget.kind,
      target: describeElement(blurTarget.element),
      activeElement: describeElement(activeElement)
    },
    manualCategory
  };
}

async function clickNext(args, context) {
  const expectedTitle = requestedMainTitle(args);
  const title = uniqueElement(
    initialTitleInputs(),
    "INITIAL_TITLE_AMBIGUOUS",
    "初始商品标题"
  );
  if (normalizeText(title.value) !== normalizeText(expectedTitle)) {
    throw new PageCommandError(
      "TITLE_PRECONDITION_MISMATCH",
      "进入完整表单前商品标题不匹配",
      { expected: expectedTitle, actual: title.value }
    );
  }
  const readiness = await waitForCategoryReadiness(context.runToken, expectedTitle);
  categoryResolutionEvidence();
  const next = readiness.value.next;
  const interactions = [dispatchPointerClick(next)];
  let result;
  try {
    result = await waitFor(
      () => {
        const signals = fullFormSignals();
        return signals.fullFormSignature ? signals : null;
      },
      {
        timeout: CLICK_NEXT_RETRY_WINDOW_MS,
        code: "CLICK_NEXT_FIRST_ATTEMPT_TIMEOUT",
        label: "首次下一步操作未触发完整表单",
        runToken: context.runToken
      }
    );
  } catch (error) {
    if (error?.code !== "CLICK_NEXT_FIRST_ATTEMPT_TIMEOUT") throw error;
    const retryState = await waitFor(
      () => {
        const signals = fullFormSignals();
        if (signals.fullFormSignature) return { fullForm: signals, next: null };
        const category = categoryResolutionEvidence(false);
        const enabledNextButtons = exactActionCandidates(["下一步"]).filter(isEnabled);
        return category.resolved && enabledNextButtons.length === 1
          ? { fullForm: null, next: enabledNextButtons[0] }
          : null;
      },
      {
        timeout: CATEGORY_TIMEOUT_MS,
        code: "CLICK_NEXT_RETRY_NOT_READY",
        label: "下一步重试条件未就绪",
        runToken: context.runToken
      }
    );
    if (retryState.value.fullForm) {
      result = { value: retryState.value.fullForm };
    } else {
      interactions.push(dispatchPointerClick(retryState.value.next));
      result = await waitFor(
        () => {
          const signals = fullFormSignals();
          return signals.fullFormSignature ? signals : null;
        },
        {
          timeout: FULL_FORM_TRANSITION_TIMEOUT_MS,
          code: "FULL_FORM_TRANSITION_TIMEOUT",
          label: "完整商品表单未出现",
          runToken: context.runToken
        }
      );
    }
  }
  return {
    category: readiness.value.category,
    categoryElapsedMs: readiness.elapsedMs,
    interactions,
    fullForm: result.value
  };
}

function assertFullForm() {
  const signals = fullFormSignals();
  if (
    !signals.fullFormSignature
  ) {
    throw new PageCommandError(
      "FULL_FORM_NOT_RECOGNIZED",
      "完整商品表单信号不足",
      {
        ...signals,
        calibration: calibrationEvidence([
          "基础信息",
          "图文信息",
          "价格库存",
          "服务与履约",
          "其他信息"
        ])
      }
    );
  }
  return signals;
}

async function setShortTitleAndBrand(args, context) {
  assertFullForm();
  const shortTitle = requestedShortTitle(args);
  const brand = requestedBrand(args);
  const shortControl = findShortTitleControl();
  const shortWrite = nativeSetValue(shortControl, shortTitle);
  const blockingShortErrors = () =>
    visibleErrorTexts().filter((text) => /短标题|至少输入4个汉字/.test(text));
  await waitFor(
    () => (blockingShortErrors().length === 0 ? true : null),
    {
      timeout: ACTION_TIMEOUT_MS,
      code: "SHORT_TITLE_VALIDATION_TIMEOUT",
      label: "导购短标题校验未消失",
      runToken: context.runToken
    }
  );
  const brandControl = findBrandControl(brand);
  const brandEvidence = await selectExactOptionOnControl(brandControl, brand, {
    searchText: brand,
    readSelection: () => readBrandFieldValue(brand),
    runToken: context.runToken
  });
  const brandReadback = readBrandFieldValue(brand);
  if (normalizeText(brandReadback) !== normalizeText(brand)) {
    throw new PageCommandError(
      "BRAND_POSTCONDITION_MISMATCH",
      "品牌回读不一致",
      { expected: brand, actual: brandReadback }
    );
  }
  const nextSection = activateSection("图文信息");
  return {
    shortTitle: shortWrite,
    brand: brandEvidence,
    brandReadback,
    nextSection
  };
}

function findDetailCounters() {
  const exactPattern =
    /^(?:商详图片\(\d+\/50\)|商品详情[^()]{0,30}\(\d+\/50\))$/;
  const titleOwners = allVisible(
    '[class*="decorateImgEditTitle__"]'
  ).filter((element) => {
    const className =
      typeof element.className === "string" ? element.className : "";
    return (
      !className.includes("Wrapper") &&
      exactPattern.test(normalizeText(displayText(element)))
    );
  });
  return titleOwners.filter((title) => {
    try {
      const scope = detailScope(title);
      const fileInputs = scope.querySelectorAll('input[type="file"]');
      return (
        fileInputs.length === 1 &&
        normalizeText(displayText(scope)).includes("上传图片")
      );
    } catch {
      return false;
    }
  });
}

function parseDetailCount(counter) {
  const text = displayText(counter).normalize("NFKC");
  const match = text.match(/\(\s*(\d+)\s*\/\s*50\s*\)/);
  if (!match) {
    throw new PageCommandError(
      "DETAIL_COUNTER_NOT_PARSED",
      "商品详情图片计数无法解析",
      { text }
    );
  }
  return Number(match[1]);
}

function isDetailEditorScopeCandidate(candidate) {
  const className =
    typeof candidate.className === "string" ? candidate.className : "";
  const text = normalizeText(displayText(candidate));
  const isEditorBoundary = className.includes(
    "decorateImgManageWrapper__"
  );
  return (
    isEditorBoundary &&
    candidate.querySelectorAll('input[type="file"]').length === 1 &&
    text.includes("上传图片") &&
    (text.includes("商品详情") || text.includes("商详图片"))
  );
}

function detailScope(counter) {
  const scope = nearestAncestor(
    counter,
    isDetailEditorScopeCandidate,
    12
  );
  if (
    !scope ||
    scope === document.body ||
    scope === document.documentElement
  ) {
    throw new PageCommandError(
      "DETAIL_SCOPE_UNRECOGNIZED",
      "商品详情上传区域无法严格识别",
      {
        counter: describeElement(counter),
        calibration: calibrationEvidence(["商详图片", "商品详情", "上传图片"])
      }
    );
  }
  return scope;
}

function inspectDetailState(strict = true) {
  const counters = findDetailCounters();
  if (!strict && counters.length !== 1) {
    return { counterCount: counters.length, count: null, scoped: false };
  }
  const counter = uniqueElement(
    counters,
    "DETAIL_COUNTER_AMBIGUOUS",
    "商品详情图片计数器"
  );
  const count = parseDetailCount(counter);
  let scope = null;
  try {
    scope = detailScope(counter);
  } catch (error) {
    if (strict) throw error;
  }
  return {
    counterCount: counters.length,
    count,
    scoped: Boolean(scope),
    counterText: displayText(counter),
    counter,
    scope
  };
}

function initialDetailAction(count, maxInitialCount = 1) {
  if (globalThis.DoudianMediaContract) {
    if (count <= 1) return DoudianMediaContract.initialDetailAction(count);
  }
  if (count === 0) return "ready";
  if (
    Number.isInteger(count) &&
    count > 0 &&
    count <= maxInitialCount
  ) {
    return "remove_default";
  }
  throw new PageCommandError(
    "DETAIL_INITIAL_COUNT_AMBIGUOUS",
    "商品详情初始图片数量不安全",
    { count, allowed: [0, maxInitialCount] }
  );
}

function detailDeleteCandidates(scope) {
  return allVisible(
    [
      'button',
      '[role="button"]',
      '[title]',
      '[aria-label]',
      '[class*="iconDelete__"]'
    ].join(","),
    scope
  ).filter((element) => {
    const className =
      typeof element.className === "string" ? element.className : "";
    const signal = normalizeText(
      `${displayText(element)} ${element.getAttribute("title") || ""} ${
        element.getAttribute("aria-label") || ""
      } ${className}`
    );
    return (
      signal === "删除" ||
      signal.includes("删除图片") ||
      className.includes("iconDelete__")
    );
  });
}

function detailDeleteOwner(button, scope) {
  for (
    let node = button.parentElement;
    node && node !== scope;
    node = node.parentElement
  ) {
    const images = allVisible("img", node).filter((image) =>
      Boolean(
        String(
          image.currentSrc || image.getAttribute("src") || ""
        ).trim()
      )
    );
    const deletes = detailDeleteCandidates(node);
    if (
      images.length === 1 &&
      deletes.length === 1 &&
      deletes[0] === button
    ) {
      return node;
    }
  }
  return null;
}

function detailDeleteBinding(before) {
  const deleteCandidates = detailDeleteCandidates(before.scope);
  if (before.count === 1) {
    return {
      button: uniqueElement(
        deleteCandidates,
        "DETAIL_DELETE_AMBIGUOUS",
        "默认商品详情图片删除按钮",
        {
          count: before.count,
          scope: describeElement(before.scope),
          candidates: deleteCandidates.map(describeElement)
        }
      ),
      owner: null
    };
  }
  const bindings = deleteCandidates.map((button) => ({
    button,
    owner: detailDeleteOwner(button, before.scope)
  }));
  const owners = new Set(bindings.map((binding) => binding.owner));
  if (
    bindings.length !== before.count ||
    bindings.some((binding) => !binding.owner) ||
    owners.size !== bindings.length
  ) {
    throw new PageCommandError(
      "DETAIL_DELETE_OWNER_MAPPING_INVALID",
      "商品详情图片与删除动作无法一对一绑定",
      {
        count: before.count,
        deleteCount: deleteCandidates.length,
        boundOwnerCount: [...owners].filter(Boolean).length,
        scope: describeElement(before.scope)
      }
    );
  }
  return bindings[0];
}

async function deleteSingleDetailImage(before, context) {
  const binding = detailDeleteBinding(before);
  const deleteButton = uniqueElement(
    [binding.button],
    "DETAIL_DELETE_AMBIGUOUS",
    "商品详情图片删除按钮",
    {
      count: before.count,
      scope: describeElement(before.scope),
      owner: binding.owner ? describeElement(binding.owner) : null
    }
  );
  clickElement(deleteButton);
  const confirmCandidates = exactActionCandidates(["确定", "删除"]).filter(
    (element) => {
      const dialog = element.closest(
        '[role="dialog"], [class*=modal], [class*=Modal], [class*=dialog], [class*=Dialog]'
      );
      return dialog && isVisible(dialog);
    }
  );
  if (confirmCandidates.length === 1) clickElement(confirmCandidates[0]);
  if (confirmCandidates.length > 1) {
    throw new PageCommandError(
      "DETAIL_DELETE_CONFIRM_AMBIGUOUS",
      "商品详情删除确认按钮不唯一",
      { candidates: confirmCandidates.map(describeElement) }
    );
  }
  const transition = await waitFor(
    () => {
      const current = inspectDetailState();
      return current.count === before.count - 1 ? current : null;
    },
    {
      timeout: ACTION_TIMEOUT_MS,
      code: "DETAIL_DELETE_POSTCONDITION_TIMEOUT",
      label: "商品详情图片删除后计数未减少一个",
      runToken: context.runToken,
      evidence: { before: before.count }
    }
  );
  if (globalThis.DoudianMediaContract && before.count === 1) {
    DoudianMediaContract.assertDefaultDetailRemoved(
      before.count,
      transition.value.count
    );
  }
  return {
    before: before.count,
    after: transition.value.count,
    elapsedMs: transition.elapsedMs
  };
}

async function ensureDetailEmptyStable(context, options = {}) {
  const maxInitialCount = options.maxInitialCount ?? 1;
  const timeout = maxInitialCount > 1 ? 600000 : 8000;
  const stableDuration = 1000;
  const startedAt = performance.now();
  let stableSince = null;
  const removals = [];
  let lastState = null;

  while (performance.now() - startedAt < timeout) {
    assertPageIdentity();
    assertRunStillActive(context.runToken);
    const current = inspectDetailState();
    lastState = {
      count: current.count,
      counterText: current.counterText
    };
    const action = initialDetailAction(current.count, maxInitialCount);
    if (action === "remove_default") {
      stableSince = null;
      removals.push(
        await deleteSingleDetailImage(current, context)
      );
      continue;
    }
    if (stableSince === null) {
      stableSince = performance.now();
    }
    if (performance.now() - stableSince >= stableDuration) {
      return {
        action: removals.length ? "remove_default" : "ready",
        before: removals[0]?.before || 0,
        after: 0,
        removals,
        stableDuration,
        elapsedMs: Math.round(performance.now() - startedAt)
      };
    }
    await sleep(100);
  }

  throw new PageCommandError(
    "DETAIL_EMPTY_STABILITY_TIMEOUT",
    "商品详情默认图片未能稳定归零",
    {
      timeout,
      stableDuration,
      removals,
      lastState
    }
  );
}

async function removeDefaultDetail(args, context) {
  return ensureDetailEmptyStable(context, {
    maxInitialCount: args?.allowExistingMany === true
      ? DETAIL_IMAGE_CAPACITY
      : 1
  });
}

function detailUploadInput(state) {
  return uniqueElement(
    Array.from(
      state.scope.querySelectorAll(
        'input[type="file"][accept*="image"]'
      )
    ),
    "DETAIL_UPLOAD_INPUT_AMBIGUOUS",
    "商品详情文件输入框",
    {
      scope: describeElement(state.scope),
      inputCount: state.scope.querySelectorAll('input[type="file"]').length
    }
  );
}

function assignDetailFile(input, payload) {
  // The detail editor's uploader consumes the native file-change path only.
  return assignSingleFile(input, payload, { events: ["change"] });
}

async function uploadDetail(args, context) {
  const fileIndex = Number(args.index ?? args.fileIndex);
  if (
    !Number.isInteger(fileIndex) ||
    fileIndex < 0 ||
    fileIndex >= DETAIL_IMAGE_CAPACITY
  ) {
    throw new PageCommandError(
      "DETAIL_INDEX_INVALID",
      `商品详情图片序号必须为0到${DETAIL_IMAGE_CAPACITY - 1}`,
      { fileIndex, capacity: DETAIL_IMAGE_CAPACITY }
    );
  }
  if (fileIndex === 0) {
    await ensureDetailEmptyStable(context, {
      maxInitialCount: args?.allowExistingMany === true
        ? DETAIL_IMAGE_CAPACITY
        : 1
    });
  }
  const before = inspectDetailState();
  if (before.count !== fileIndex) {
    throw new PageCommandError(
      "DETAIL_PLAN_ORDER_MISMATCH",
      "商品详情图片必须按素材计划顺序串行上传",
      { fileIndex, expectedCount: fileIndex, actualCount: before.count }
    );
  }
  const input = detailUploadInput(before);
  const selected = assignDetailFile(input, args.file || args.payload);
  const transition = await waitFor(
    () => {
      const current = inspectDetailState();
      return current.count === before.count + 1 ? current : null;
    },
    {
      timeout: UPLOAD_TIMEOUT_MS,
      code: "DETAIL_UPLOAD_POSTCONDITION_TIMEOUT",
      label: "商品详情图片上传后计数未增加一个",
      runToken: context.runToken,
      evidence: { fileIndex, before: before.count }
    }
  );
  if (globalThis.DoudianMediaContract) {
    DoudianMediaContract.assertDetailUploadTransition(
      before.count,
      transition.value.count,
      fileIndex
    );
  }
  return {
    fileIndex,
    selected,
    before: before.count,
    after: transition.value.count,
    elapsedMs: transition.elapsedMs
  };
}

function optionalMediaPayloadDescriptor(payload) {
  const mime = String(payload?.type || "").trim().toLowerCase();
  const name = String(payload?.name || "").trim().toLowerCase();
  const extensionMatch = name.match(/(\.[a-z0-9]+)$/i);
  const extension = extensionMatch ? extensionMatch[1] : "";
  const imageExtensions = new Set([
    ".jpeg",
    ".jpg",
    ".png",
    ".webp"
  ]);
  const videoExtensions = new Set([
    ".m4v",
    ".mov",
    ".mp4",
    ".webm"
  ]);
  const mimeType = mime.startsWith("image/")
    ? "image"
    : mime.startsWith("video/")
      ? "video"
      : null;
  const extensionType = imageExtensions.has(extension)
    ? "image"
    : videoExtensions.has(extension)
      ? "video"
      : null;
  return {
    mime,
    name,
    extension,
    mimeType,
    extensionType,
    mediaType:
      mimeType && extensionType && mimeType !== extensionType
        ? null
        : mimeType || extensionType,
    conflictingType:
      Boolean(mimeType && extensionType) && mimeType !== extensionType
  };
}

function assertOptionalMediaRequest(kind, index, payload) {
  const config = OPTIONAL_MEDIA_KIND_CONFIG[kind];
  if (!config) {
    throw new PageCommandError(
      "OPTIONAL_MEDIA_KIND_INVALID",
      "可选媒体类型不在允许列表",
      { kind, allowed: Object.keys(OPTIONAL_MEDIA_KIND_CONFIG) }
    );
  }
  if (!Number.isInteger(index) || index < 0 || index >= config.capacity) {
    throw new PageCommandError(
      "OPTIONAL_MEDIA_INDEX_INVALID",
      "可选媒体序号超出字段容量",
      { kind, index, capacity: config.capacity }
    );
  }
  const descriptor = optionalMediaPayloadDescriptor(payload);
  if (
    descriptor.conflictingType ||
    descriptor.extensionType !== config.mediaType ||
    descriptor.mediaType !== config.mediaType
  ) {
    throw new PageCommandError(
      "OPTIONAL_MEDIA_FILE_TYPE_MISMATCH",
      "可选媒体文件类型与字段不匹配",
      {
        kind,
        expectedMediaType: config.mediaType,
        payload: descriptor
      }
    );
  }
  return { config, descriptor, index, payload };
}

function optionalMediaInputAccepts(input, request) {
  const accept = String(input?.getAttribute?.("accept") || "")
    .trim()
    .toLowerCase();
  if (!accept) return true;
  const tokens = accept
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  const { descriptor, config } = request;
  return tokens.some((token) => {
    if (token === "*/*") return true;
    if (token === `${config.mediaType}/*`) return true;
    if (descriptor.mime && token === descriptor.mime) return true;
    if (descriptor.extension && token === descriptor.extension) return true;
    return false;
  });
}

function optionalMediaCompatibleInputs(field, request) {
  return Array.from(field.querySelectorAll('input[type="file"]')).filter(
    (input) => !input.disabled && optionalMediaInputAccepts(input, request)
  );
}

function classifyOptionalMediaFieldCandidates(
  attributeRecords,
  fallbackRecords
) {
  const source = attributeRecords.length ? attributeRecords : fallbackRecords;
  const strategy = attributeRecords.length
    ? "attr_field_id"
    : "exact_label_local_ancestor";
  const identityCandidates = Array.from(
    new Set(
      source
        .filter(
          (record) =>
            record.exactIdentity === true &&
            record.local === true &&
            (attributeRecords.length || record.compatibleInputCount > 0)
        )
        .map((record) => record.element)
    )
  );
  const candidates = attributeRecords.length
    ? identityCandidates
    : identityCandidates.filter(
        (candidate) =>
          !identityCandidates.some(
            (other) =>
              other !== candidate &&
              typeof other?.contains === "function" &&
              other.contains(candidate)
          )
      );
  return { strategy, candidates, records: source };
}

function optionalMediaFallbackScope(label, request) {
  return nearestAncestor(
    label,
    (candidate) => {
      if (
        candidate === document.body ||
        candidate === document.documentElement
      ) {
        return false;
      }
      const compatibleInputCount = optionalMediaCompatibleInputs(
        candidate,
        request
      ).length;
      if (
        compatibleInputCount < 1 ||
        compatibleInputCount > request.config.capacity
      ) {
        return false;
      }
      return !Object.values(OPTIONAL_MEDIA_KIND_CONFIG).some(
        (other) =>
          other.kind !== request.config.kind &&
          visibleExactText(other.label, candidate).length > 0
      );
    },
    10
  );
}

function locateOptionalMediaField(request) {
  const selector = `[attr-field-id="${CSS.escape(
    request.config.fieldId
  )}"]`;
  const attributeElements = allVisible(selector);
  const attributeRecords = attributeElements.map((element) => ({
    element,
    exactIdentity:
      element.getAttribute("attr-field-id") === request.config.fieldId,
    local:
      element !== document.body && element !== document.documentElement,
    compatibleInputCount: optionalMediaCompatibleInputs(element, request).length
  }));
  let fallbackRecords = [];
  if (attributeElements.length === 0) {
    fallbackRecords = visibleExactText(request.config.label).map((label) => {
      const element = optionalMediaFallbackScope(label, request);
      return {
        element,
        exactIdentity:
          normalizeText(displayText(label)) ===
          normalizeText(request.config.label),
        local: Boolean(element),
        compatibleInputCount: element
          ? optionalMediaCompatibleInputs(element, request).length
          : 0
      };
    });
  }
  const resolution = classifyOptionalMediaFieldCandidates(
    attributeRecords,
    fallbackRecords
  );
  const field = uniqueElement(
    resolution.candidates,
    "OPTIONAL_MEDIA_FIELD_AMBIGUOUS",
    `可选媒体字段 ${request.config.label}`,
    {
      kind: request.config.kind,
      fieldId: request.config.fieldId,
      locatorStrategy: resolution.strategy,
      attributeCandidateCount: attributeRecords.length,
      fallbackCandidateCount: fallbackRecords.length,
      records: resolution.records.map((record) => ({
        exactIdentity: record.exactIdentity,
        local: record.local,
        compatibleInputCount: record.compatibleInputCount,
        element: describeElement(record.element)
      }))
    }
  );
  return { field, locatorStrategy: resolution.strategy };
}

function optionalMediaSlotOwner(element, field) {
  const owner = element.closest(
    `${PREVIEW_SELECTOR}, .material-button, [class*="material-upload"], [class*="upload-item"], li`
  );
  if (owner && owner !== field && field.contains(owner)) return owner;
  return element.parentElement && element.parentElement !== field
    ? element.parentElement
    : null;
}

function optionalMediaResourceState(field) {
  const records = [];
  const add = (rawValue, element) => {
    const value = String(rawValue || "").trim();
    if (!value) return;
    const owner = optionalMediaSlotOwner(element, field);
    if (owner) records.push({ value, owner });
  };
  const addSrcset = (srcset, element) => {
    for (const candidate of String(srcset || "").split(",")) {
      add(candidate.trim().split(/\s+/)[0], element);
    }
  };
  const isPreviewResource = (element) => {
    const owner = optionalMediaSlotOwner(element, field);
    if (!owner) return false;
    const className =
      typeof owner.className === "string" ? owner.className : "";
    return (
      owner.matches?.(PREVIEW_SELECTOR) ||
      Boolean(owner.closest?.(PREVIEW_SELECTOR)) ||
      /preview/i.test(className)
    );
  };
  for (const image of field.querySelectorAll("img")) {
    if (!isPreviewResource(image)) continue;
    add(image.currentSrc, image);
    add(image.getAttribute("src"), image);
    addSrcset(image.getAttribute("srcset"), image);
  }
  for (const video of field.querySelectorAll("video")) {
    add(video.currentSrc, video);
    add(video.getAttribute("src"), video);
    add(video.getAttribute("poster"), video);
  }
  for (const source of field.querySelectorAll("source")) {
    if (!source.closest("video") && !isPreviewResource(source)) continue;
    add(source.getAttribute("src"), source);
    addSrcset(source.getAttribute("srcset"), source);
  }
  for (const element of [field, ...field.querySelectorAll("*")]) {
    const className =
      typeof element.className === "string" ? element.className : "";
    if (
      !element.closest(PREVIEW_SELECTOR) &&
      !/preview/i.test(className)
    ) {
      continue;
    }
    const background = getComputedStyle(element).backgroundImage;
    for (const match of String(background || "").matchAll(
      /url\((?:"|')?([^"')]+)(?:"|')?\)/g
    )) {
      add(match[1], element);
    }
  }
  const resources = Array.from(new Set(records.map((record) => record.value)));
  const owners = Array.from(new Set(records.map((record) => record.owner)));
  return { resources, owners };
}

function inspectOptionalMediaState(field, request) {
  const previewControls = allVisible(PREVIEW_SELECTOR, field);
  const resourceState = optionalMediaResourceState(field);
  const occupiedOwners = [...previewControls];
  for (const owner of resourceState.owners) {
    if (
      !occupiedOwners.some(
        (occupied) => occupied.contains(owner) || owner.contains(occupied)
      )
    ) {
      occupiedOwners.push(owner);
    }
  }
  const compatibleInputs = optionalMediaCompatibleInputs(field, request);
  const inputRecords = compatibleInputs.map((input) => {
    const owner = optionalMediaSlotOwner(input, field);
    const occupied = Boolean(
      owner &&
        occupiedOwners.some(
          (candidate) =>
            candidate === owner ||
            candidate.contains(owner) ||
            owner.contains(candidate)
        )
    );
    return { input, owner, occupied };
  });
  const remainingOwners = Array.from(
    new Set(
      inputRecords
        .filter((record) => record.owner && !record.occupied)
        .map((record) => record.owner)
    )
  );
  const loadingSignalCount = allVisible(
    '[aria-busy="true"], [role="progressbar"], [class*="loading"], [class*="Loading"], [class*="progress"], [class*="Progress"]',
    field
  ).length;
  const errorTexts = allVisible("span, div, p", field)
    .map(displayText)
    .filter((text) => /上传失败|格式不支持|尺寸不符|文件过大/.test(text));
  const derivedOccupiedCount = Math.max(
    0,
    request.config.capacity - remainingOwners.length
  );
  return {
    kind: request.config.kind,
    capacity: request.config.capacity,
    occupiedCount: Math.max(occupiedOwners.length, derivedOccupiedCount),
    previewControlCount: previewControls.length,
    resourceOwnerCount: resourceState.owners.length,
    resourceCount: resourceState.resources.length,
    resources: resourceState.resources,
    compatibleInputCount: compatibleInputs.length,
    inputSlotCount: new Set(
      inputRecords.map((record) => record.owner).filter(Boolean)
    ).size,
    remainingSlotCount: remainingOwners.length,
    loadingSignalCount,
    errorTexts,
    inputRecords,
    remainingOwners
  };
}

function optionalMediaStateEvidence(state) {
  return {
    kind: state.kind,
    capacity: state.capacity,
    occupiedCount: state.occupiedCount,
    previewControlCount: state.previewControlCount,
    resourceOwnerCount: state.resourceOwnerCount,
    resourceCount: state.resourceCount,
    resources: state.resources,
    compatibleInputCount: state.compatibleInputCount,
    inputSlotCount: state.inputSlotCount,
    remainingSlotCount: state.remainingSlotCount,
    loadingSignalCount: state.loadingSignalCount ?? 0,
    errorTexts: Array.isArray(state.errorTexts) ? state.errorTexts : []
  };
}

function optionalMediaUploadInput(state, request) {
  const expectedRemaining = request.config.capacity - request.index;
  const before = optionalMediaStateEvidence(state);
  if (
    state.occupiedCount !== request.index ||
    state.previewControlCount > request.index ||
    state.resourceOwnerCount > request.index ||
    state.remainingSlotCount !== expectedRemaining
  ) {
    throw new PageCommandError(
      "OPTIONAL_MEDIA_PLAN_ORDER_MISMATCH",
      "可选媒体必须按字段内素材顺序串行上传",
      { index: request.index, expectedRemaining, before }
    );
  }
  const targetOwner = state.remainingOwners[0];
  const targetInputs = state.inputRecords.filter(
    (record) => record.owner === targetOwner && !record.occupied
  );
  if (!targetOwner || targetInputs.length !== 1) {
    throw new PageCommandError(
      "OPTIONAL_MEDIA_INPUT_AMBIGUOUS",
      "可选媒体的首个剩余字段内上传槽输入框必须唯一",
      {
        index: request.index,
        targetInputCount: targetInputs.length,
        before
      }
    );
  }
  return targetInputs[0].input;
}

function assertOptionalMediaTransition(kind, index, before, after) {
  const config = OPTIONAL_MEDIA_KIND_CONFIG[kind];
  const beforeResources = new Set(before.resources || []);
  const addedResources = (after.resources || []).filter(
    (resource) => !beforeResources.has(resource)
  );
  const localTransition = {
    previewControlCount:
      after.previewControlCount - before.previewControlCount,
    resourceOwnerCount:
      after.resourceOwnerCount - before.resourceOwnerCount,
    compatibleInputCount:
      after.compatibleInputCount - before.compatibleInputCount,
    inputSlotCount: after.inputSlotCount - before.inputSlotCount,
    remainingSlotCount:
      after.remainingSlotCount - before.remainingSlotCount,
    loadingSignalCount:
      (after.loadingSignalCount ?? 0) - (before.loadingSignalCount ?? 0)
  };
  const localEvidenceIncrease =
    localTransition.previewControlCount > 0 ||
    localTransition.resourceOwnerCount > 0 ||
    addedResources.length > 0 ||
    localTransition.remainingSlotCount < 0 ||
    localTransition.inputSlotCount < 0;
  const valid =
    Boolean(config) &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < config.capacity &&
    before.occupiedCount === index &&
    after.occupiedCount === index + 1 &&
    localTransition.loadingSignalCount <= 0 &&
    (after.errorTexts || []).length === 0 &&
    localEvidenceIncrease;
  if (!valid) {
    throw new PageCommandError(
      "OPTIONAL_MEDIA_TRANSITION_MISMATCH",
      "可选媒体字段内预览或资源计数未增加一个",
      {
        kind,
        index,
        before,
        after,
        addedResources,
        localEvidenceIncrease
      }
    );
  }
  const validator =
    globalThis.DoudianMediaContract?.assertOptionalMediaTransition;
  const contractBefore = config
    ? {
        kind,
        capacity: config.capacity,
        previewCount: before.occupiedCount
      }
    : null;
  const contractAfter = config
    ? {
        kind,
        capacity: config.capacity,
        previewCount: after.occupiedCount
      }
    : null;
  const contract =
    typeof validator === "function"
      ? validator.call(
          globalThis.DoudianMediaContract,
          contractBefore,
          contractAfter,
          index
        )
      : null;
  return { kind, index, addedResources, localTransition, contract };
}

function optionalMediaUploadTimeout(kind) {
  return kind === "video" ? UPLOAD_TIMEOUT_MS : 45000;
}

async function uploadOptionalMedia(args, context) {
  const payload = args.file || args.payload;
  const request = assertOptionalMediaRequest(args.kind, args.index, payload);
  assertFullForm();
  const activatedSection = activateSection("图文信息");
  const located = locateOptionalMediaField(request);
  const beforeState = inspectOptionalMediaState(located.field, request);
  const input = optionalMediaUploadInput(beforeState, request);
  const selected = assignSingleFile(input, payload);
  if (request.config.kind === "video") {
    activeOptionalMediaPlan.video = {
      count: request.index + 1,
      completionMode: "input_assigned",
      descriptor: {
        mime: request.descriptor.mime,
        extension: request.descriptor.extension,
        mediaType: request.descriptor.mediaType
      }
    };
    return {
      kind: request.config.kind,
      fileIndex: request.index,
      capacity: request.config.capacity,
      selected,
      activatedSection,
      locatorStrategy: located.locatorStrategy,
      before: optionalMediaStateEvidence(beforeState),
      after: null,
      transition: null,
      completionMode: "input_assigned",
      elapsedMs: 0
    };
  }
  let replacementOnlyStablePasses = 0;
  const transition = await waitFor(
    () => {
      const currentField = locateOptionalMediaField(request);
      const current = inspectOptionalMediaState(currentField.field, request);
      const before = optionalMediaStateEvidence(beforeState);
      const after = optionalMediaStateEvidence(current);
      if (current.occupiedCount !== request.index + 1) {
        replacementOnlyStablePasses = 0;
        throw new PageCommandError(
          "OPTIONAL_MEDIA_NOT_CONVERGED",
          "可选媒体字段仍未形成已占用槽位",
          {
            kind: request.config.kind,
            index: request.index,
            locatorStrategy: currentField.locatorStrategy,
            after
          }
        );
      }
      const assertion = assertOptionalMediaTransition(
        request.config.kind,
        request.index,
        before,
        after
      );
      const hasRenderedPreview =
        current.previewControlCount > beforeState.previewControlCount ||
        current.resourceOwnerCount > beforeState.resourceOwnerCount ||
        assertion.addedResources.length > 0;
      if (hasRenderedPreview) {
        replacementOnlyStablePasses = 0;
      } else {
        replacementOnlyStablePasses += 1;
        if (replacementOnlyStablePasses < 5) {
          throw new PageCommandError(
            "OPTIONAL_MEDIA_CONTROL_REPLACEMENT_STABILIZING",
            "可选媒体上传槽替换状态尚未稳定",
            {
              kind: request.config.kind,
              index: request.index,
              stablePasses: replacementOnlyStablePasses,
              current: after
            }
          );
        }
      }
      return {
        after,
        assertion,
        locatorStrategy: currentField.locatorStrategy
      };
    },
    {
      timeout: optionalMediaUploadTimeout(request.config.kind),
      code: "OPTIONAL_MEDIA_UPLOAD_POSTCONDITION_TIMEOUT",
      label: "可选媒体字段内预览或资源转换等待超时",
      runToken: context.runToken,
      evidence: {
        kind: request.config.kind,
        index: request.index,
        before: optionalMediaStateEvidence(beforeState)
      }
    }
  );
  activeOptionalMediaPlan[request.config.kind] = {
    count: request.index + 1,
    descriptor: {
      mime: request.descriptor.mime,
      extension: request.descriptor.extension,
      mediaType: request.descriptor.mediaType
    }
  };
  return {
    kind: request.config.kind,
    fileIndex: request.index,
    capacity: request.config.capacity,
    selected,
    activatedSection,
    locatorStrategy: transition.value.locatorStrategy,
    before: optionalMediaStateEvidence(beforeState),
    after: transition.value.after,
    transition: transition.value.assertion,
    elapsedMs: transition.elapsedMs
  };
}

function reviewOptionalMediaPlan() {
  const entries = Object.entries(activeOptionalMediaPlan);
  if (!entries.length) return {};
  activateSection("图文信息");
  const evidence = {};
  for (const [kind, plan] of entries) {
    const config = OPTIONAL_MEDIA_KIND_CONFIG[kind];
    if (kind === "video" && plan.completionMode === "input_assigned") {
      evidence.video = {
        expectedCount: plan.count,
        actualCount: null,
        completionMode: plan.completionMode,
        pendingUploadAccepted: true
      };
      continue;
    }
    const request = {
      config,
      descriptor: plan.descriptor,
      index: plan.count - 1
    };
    const located = locateOptionalMediaField(request);
    const state = inspectOptionalMediaState(located.field, request);
    evidence[kind] = {
      expectedCount: plan.count,
      actualCount: state.occupiedCount,
      completionMode: plan.completionMode || "preview_verified",
      locatorStrategy: located.locatorStrategy,
      state: optionalMediaStateEvidence(state)
    };
    if (state.occupiedCount !== plan.count) {
      throw new PageCommandError(
        "OPTIONAL_MEDIA_REVIEW_MISMATCH",
        "最终复核时可选媒体数量与本轮计划不一致",
        { kind, ...evidence[kind] }
      );
    }
  }
  return evidence;
}

function activateSection(name) {
  const tabList = uniqueElement(
    fullFormTabLists(),
    "SECTION_TABLIST_AMBIGUOUS",
    "商品编辑栏目导航",
    calibrationEvidence(FULL_FORM_TAB_NAMES)
  );
  const candidates = allVisible('[role="tab"]', tabList).filter(
    (element) => normalizeText(displayText(element)) === normalizeText(name)
  );
  const target = uniqueElement(
    candidates,
    "SECTION_AMBIGUOUS",
    `栏目 ${name}`,
    calibrationEvidence([name])
  );
  clickElement(target);
  return describeElement(target);
}

function fieldContainer(fieldId, scope = document) {
  return uniqueElement(
    allVisible(`[attr-field-id="${CSS.escape(fieldId)}"]`, scope),
    "FIELD_CONTAINER_AMBIGUOUS",
    `字段容器 ${fieldId}`,
    calibrationEvidence([fieldId])
  );
}

function fieldControl(fieldId, selector, scope = document) {
  const container = fieldContainer(fieldId, scope);
  return uniqueElement(
    Array.from(container.querySelectorAll(selector)),
    "FIELD_CONTROL_AMBIGUOUS",
    `字段 ${fieldId}`,
    {
      container: describeElement(container),
      selector
    }
  );
}

async function ensureFieldSelection(fieldId, expectedText, options = {}) {
  const controlSelector =
    '[role="combobox"], input[type="search"], select';
  const resolveControl = () => fieldControl(
    fieldId,
    controlSelector
  );
  const control = resolveControl();
  const before = readSelectionControlValue(control, expectedText);
  let selection = null;
  if (normalizeText(before) !== normalizeText(expectedText)) {
    selection = await selectExactOptionOnControl(control, expectedText, {
      ...options,
      resolveControl
    });
  }
  const finalReadback = await waitFor(
    () => {
      const after = readSelectionControlValue(resolveControl(), expectedText);
      return normalizeText(after) === normalizeText(expectedText)
        ? after
        : null;
    },
    {
      timeout: options.readbackTimeoutMs ?? ACTION_TIMEOUT_MS,
      interval: options.readbackIntervalMs ?? POLL_INTERVAL_MS,
      code: "FIELD_SELECTION_READBACK_TIMEOUT",
      label: `字段 ${fieldId} 回读未稳定`,
      runToken: options.runToken,
      evidence: { fieldId, expected: expectedText, before }
    }
  );
  const after = finalReadback.value;
  return { fieldId, expected: expectedText, before, after, selection };
}

function assertExactContractValue(actual, expected, code, label) {
  if (normalizeText(actual) !== normalizeText(expected)) {
    throw new PageCommandError(code, `${label}不符合冻结内容`, {
      expected,
      actual
    });
  }
}

function setFulfillment(args) {
  assertFullForm();
  assertExactContractValue(
    args.mode ?? "现货",
    "现货",
    "FULFILLMENT_MODE_CONTRACT_MISMATCH",
    "发货模式"
  );
  assertExactContractValue(
    args.dispatchTime ?? "48小时",
    "48小时",
    "DISPATCH_TIME_CONTRACT_MISMATCH",
    "发货时效"
  );
  const section = activateSection("价格库存");
  const priceSection = uniqueElement(
    allVisible("#goodsEditScrollContainer-价格库存"),
    "PRICE_SECTION_AMBIGUOUS",
    "价格库存内容区"
  );
  const mode = ensureExactChoice("现货", priceSection);
  const dispatch = ensureExactChoice(
    "48小时",
    fieldContainer("现货发货时间", priceSection)
  );
  return { section, mode, dispatch };
}

function findSpecificationUploadControl() {
  const candidates = Array.from(
    document.querySelectorAll('input[type="file"]')
  ).filter((input) => {
    const accept = normalizeText(
      String(input.getAttribute("accept") || "").toLowerCase()
    );
    const assistant = input.closest(
      '[data-testid="sku-info-smart-assistant"]'
    );
    return (
      Boolean(assistant) &&
      accept.includes(".xls") &&
      accept.includes(".xlsx") &&
      accept.includes(".csv")
    );
  });
  return uniqueElement(
    candidates,
    "SPECIFICATION_UPLOAD_AMBIGUOUS",
    "规格导入文件输入框",
    calibrationEvidence(["立即上传", "规格", "导入"])
  );
}

function skuContract() {
  return globalThis.DoudianSkuContract || {
    normalizeExact: normalizeText,
    buildColumns(headers) {
      const required = {
        spec: ["规格", "商品规格"],
        price: ["价格"],
        stock: ["库存"],
        merchantCode: ["商家编码"],
        preview: ["预览图"]
      };
      const normalized = headers.map(normalizeText);
      const columns = {};
      for (const [field, accepted] of Object.entries(required)) {
        const matches = normalized
          .map((header, index) =>
            accepted.map(normalizeText).includes(header) ? index : -1
          )
          .filter((index) => index >= 0);
        if (matches.length !== 1) {
          throw new PageCommandError(
            "SKU_HEADER_NOT_EXACT",
            `${accepted[0]}列无法唯一识别`,
            {
              field,
              headers,
              matches,
              rejectedPartialMatches: normalized
                .map((header, index) => ({ header, index }))
                .filter(({ header }) =>
                  accepted.some(
                    (name) =>
                      header !== normalizeText(name) &&
                      header.includes(normalizeText(name))
                  )
                )
            }
          );
        }
        columns[field] = matches[0];
      }
      return columns;
    },
    normalizeExpectedSpecs(specs) {
      if (!Array.isArray(specs) || specs.length < 1) {
        throw new PageCommandError(
          "SKU_PLAN_ROW_COUNT_MISMATCH",
          "规格计划至少需要包含一行",
          { minimumCount: 1, actualCount: Array.isArray(specs) ? specs.length : null }
        );
      }
      const normalized = specs.map(normalizeText);
      if (
        normalized.some((value) => !value) ||
        new Set(normalized).size !== normalized.length
      ) {
        throw new PageCommandError(
          "SKU_PLAN_IDENTITY_INVALID",
          "规格计划包含空值或重复值"
        );
      }
      return normalized;
    },
    compareObservedSpecs(expectedSpecs, observedSpecs) {
      const expected = this.normalizeExpectedSpecs(expectedSpecs);
      const observed = observedSpecs.map(normalizeText);
      const observedSet = new Set(observed);
      return {
        exact:
          observedSet.size === expected.length &&
          expected.every((spec) => observedSet.has(spec)),
        expectedCount: expected.length,
        observedCount: observedSet.size,
        missing: expected.filter((spec) => !observedSet.has(spec)),
        unexpected: Array.from(observedSet).filter(
          (spec) => !expected.includes(spec)
        ),
        duplicates: observed.filter(
          (spec, index) => spec && observed.indexOf(spec) !== index
        )
      };
    },
    assertCellReadback(field, expected, actual) {
      if (String(expected) !== String(actual)) {
        throw new PageCommandError(
          "SKU_CELL_READBACK_MISMATCH",
          `SKU ${field}回读不一致`,
          { field, expected: String(expected), actual: String(actual) }
        );
      }
    }
  };
}

function tableHeaders(table) {
  return Array.from(table.querySelectorAll("thead th")).map((header) =>
    displayText(header).replace(/^\s*\*\s*/, "")
  );
}

function findSkuTables(strict = true) {
  const tables = allVisible(".ecom-g-table").filter((table) => {
    const headers = tableHeaders(table).map(normalizeText);
    const specificationHeaders = headers.filter((header) =>
      ["规格", "商品规格"].includes(header)
    );
    return (
      specificationHeaders.length === 1 &&
      headers.some((header) => header === "价格") &&
      headers.some(
        (header) => header === "库存" || header === "现货库存"
      ) &&
      headers.some((header) => header === "商家编码")
    );
  });
  if (strict && tables.length !== 1) {
    throw new PageCommandError(
      "SKU_TABLE_AMBIGUOUS",
      "SKU表格无法唯一识别",
      {
        matches: tables.length,
        tableHeaders: allVisible(".ecom-g-table").map(tableHeaders)
      }
    );
  }
  return tables;
}

function uniqueSkuTable() {
  return uniqueElement(
    findSkuTables(false),
    "SKU_TABLE_AMBIGUOUS",
    "SKU表格",
    { tableHeaders: allVisible(".ecom-g-table").map(tableHeaders) }
  );
}

function rowCells(row) {
  return Array.from(row.children).filter(
    (child) => child.tagName === "TD"
  );
}

function rowInputAt(row, columnIndex, field) {
  const cell = rowCellAt(row, columnIndex, field);
  return uniqueElement(
    allVisible("input", cell),
    "SKU_CELL_INPUT_AMBIGUOUS",
    `SKU ${field}输入框`,
    { columnIndex, cell: describeElement(cell) }
  );
}

function rowCellAt(row, columnIndex, field) {
  const cells = rowCells(row);
  if (columnIndex >= cells.length) {
    throw new PageCommandError(
      "SKU_ROW_SHAPE_MISMATCH",
      "SKU行单元格数量不足",
      { field, columnIndex, cellCount: cells.length }
    );
  }
  return cells[columnIndex];
}

function imageFileInputs(scope) {
  return Array.from(
    scope.querySelectorAll('input[type="file"]')
  ).filter((input) =>
    normalizeText(
      String(input.getAttribute("accept") || "").toLowerCase()
    ).includes("image")
  );
}

function specificationImageMode(expectedSpecs) {
  const priceSection = uniqueElement(
    allVisible("#goodsEditScrollContainer-价格库存"),
    "SPECIFICATION_PRICE_SECTION_AMBIGUOUS",
    "价格库存内容区",
    calibrationEvidence(["商品规格", "添加规格图"])
  );
  const labels = visibleExactText("添加规格图");
  const records = labels.flatMap((label) => {
    let current = label;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const controls = Array.from(
        current.querySelectorAll(
          'button[role="switch"], [role="switch"], input[type="checkbox"]'
        )
      ).filter((control) => selectedState(control) !== null);
      if (controls.length === 1) {
        return [{ control: controls[0], owner: current }];
      }
      current = current.parentElement;
    }
    return [];
  });
  const controls = Array.from(
    new Map(records.map((record) => [record.control, record])).values()
  );
  const record = uniqueElement(
    controls.map((candidate) => candidate.control),
    "SPECIFICATION_IMAGE_SWITCH_AMBIGUOUS",
    "添加规格图开关",
    calibrationEvidence(["添加规格图"])
  );
  const owner = controls.find(
    (candidate) => candidate.control === record
  ).owner;
  if (!priceSection.contains(record)) {
    throw new PageCommandError(
      "SPECIFICATION_IMAGE_SCOPE_UNRECOGNIZED",
      "添加规格图开关不在价格库存内容区",
      {
        expectedSample: expectedSpecs.slice(0, 5),
        control: describeElement(record),
        owner: describeElement(owner),
        priceSection: describeElement(priceSection)
      }
    );
  }
  return {
    control: record,
    scope: priceSection,
    state: selectedState(record)
  };
}

async function ensureSpecificationImageMode(expectedSpecs, runToken) {
  const before = specificationImageMode(expectedSpecs);
  const beforeMapping = specificationImageInputMapping(expectedSpecs, before);
  const readinessEvidence = specificationImageMappingEvidence(beforeMapping);
  if (before.state !== true) {
    clickElement(before.control);
  }
  const enabled = await waitFor(
    () => {
      const current = specificationImageMode(expectedSpecs);
      return current.state === true ? current : null;
    },
    {
      code: "SPECIFICATION_IMAGE_SWITCH_TIMEOUT",
      label: "添加规格图开关未启用",
      runToken,
      evidence: readinessEvidence
    }
  );
  const ready = await waitFor(
    () => {
      const current = specificationImageMode(expectedSpecs);
      const mapping = specificationImageInputMapping(expectedSpecs, current);
      Object.assign(
        readinessEvidence,
        specificationImageMappingEvidence(mapping)
      );
      return current.state === true && mapping.ok
        ? { mode: current, mapping }
        : null;
    },
    {
      timeout: SPECIFICATION_IMAGE_INPUT_READY_TIMEOUT_MS,
      code: "SPECIFICATION_IMAGE_INPUTS_TIMEOUT",
      label: "规格图输入框未按规格计划完成渲染",
      runToken,
      evidence: readinessEvidence
    }
  );
  return {
    before: before.state,
    after: enabled.value.state,
    expectedInputCount: expectedSpecs.length,
    actualInputCount: ready.value.mapping.mappedCount,
    totalImageInputCount: ready.value.mapping.totalImageInputCount,
    unownedInputCount: ready.value.mapping.unownedInputs.length
  };
}

function specificationIdentityElements(spec, scope) {
  const expected = normalizeText(spec);
  const textMatches = visibleExactText(spec, scope);
  const attributeMatches = Array.from(
    scope.querySelectorAll(
      'input[value], textarea, [title], [data-value], [value_name]'
    )
  ).filter((element) => {
    if (element.closest(".ecom-g-table")) return false;
    const values = [
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
        ? element.value
        : null,
      element.getAttribute("title"),
      element.getAttribute("data-value"),
      element.getAttribute("value_name")
    ].filter((value) => value !== null);
    return values.some((value) => normalizeText(value) === expected);
  });
  return Array.from(
    new Set([...textMatches, ...attributeMatches])
  ).filter((element) => !element.closest(".ecom-g-table"));
}

function specificationImageOwner(editorGroup, editorGroups, scope) {
  if (!scope.contains(editorGroup.group)) {
    return { container: null, inputs: [] };
  }
  const groupElements = editorGroups.map((group) => group.group);
  let current = editorGroup.group;
  while (current && scope.contains(current)) {
    const containedGroups = groupElements.filter((group) =>
      current.contains(group)
    );
    if (
      containedGroups.length !== 1 ||
      containedGroups[0] !== editorGroup.group
    ) {
      break;
    }
    const inputs = imageFileInputs(current);
    if (inputs.length > 0) {
      return { container: current, inputs };
    }
    if (current === scope) break;
    current = current.parentElement;
  }
  return { container: editorGroup.group, inputs: [] };
}

function buildSpecificationImageInputMapping(
  expectedSpecs,
  editorMapping,
  mode
) {
  const records = editorMapping.bindings.map((editorGroup, expectedIndex) => {
    const owner = specificationImageOwner(
      editorGroup,
      editorMapping.editorGroups,
      mode.scope
    );
    return {
      expectedIndex,
      specification: normalizeText(expectedSpecs[expectedIndex]),
      editorGroup,
      container: owner.container,
      inputs: owner.inputs
    };
  });
  const expectedIndexesByInput = new Map();
  for (const record of records) {
    for (const input of record.inputs) {
      const expectedIndexes = expectedIndexesByInput.get(input) || [];
      expectedIndexes.push(record.expectedIndex);
      expectedIndexesByInput.set(input, expectedIndexes);
    }
  }
  const missing = records.filter((record) => record.inputs.length === 0);
  const ambiguous = records
    .map((record) => {
      const sharedWith = Array.from(
        new Set(
          record.inputs.flatMap(
            (input) => expectedIndexesByInput.get(input) || []
          )
        )
      ).filter((expectedIndex) => expectedIndex !== record.expectedIndex);
      return record.inputs.length > 1 || sharedWith.length > 0
        ? { ...record, sharedWith }
        : null;
    })
    .filter(Boolean);
  const ambiguousIndexes = new Set(
    ambiguous.map((record) => record.expectedIndex)
  );
  const bindings = records.map((record) =>
    record.inputs.length === 1 && !ambiguousIndexes.has(record.expectedIndex)
      ? {
          expectedIndex: record.expectedIndex,
          specification: record.specification,
          input: record.inputs[0],
          container: record.container,
          editorGroup: record.editorGroup
        }
      : null
  );
  const mappedCount = bindings.filter(Boolean).length;
  const allInputs = imageFileInputs(mode.scope);
  const ownedInputs = new Set(records.flatMap((record) => record.inputs));
  const unownedInputs = allInputs.filter((input) => !ownedInputs.has(input));
  return {
    ok:
      mappedCount === expectedSpecs.length &&
      missing.length === 0 &&
      ambiguous.length === 0,
    mode,
    expectedSpecs,
    editorMapping,
    records,
    bindings,
    mappedCount,
    missing,
    ambiguous,
    totalImageInputCount: allInputs.length,
    unownedInputs
  };
}

function specificationImageInputMapping(
  expectedSpecs,
  mode = specificationImageMode(expectedSpecs)
) {
  return buildSpecificationImageInputMapping(
    expectedSpecs,
    requireSpecificationEditorMapping(expectedSpecs),
    mode
  );
}

function specificationImageMappingEvidence(mapping) {
  return {
    expectedInputCount: mapping.expectedSpecs.length,
    mappedInputCount: mapping.mappedCount,
    actualInputCount: mapping.mappedCount,
    totalImageInputCount: mapping.totalImageInputCount,
    missingSpecifications: mapping.missing.map((record) => ({
      expectedIndex: record.expectedIndex,
      specification: record.specification,
      editorGroupIndex: record.editorGroup.groupIndex
    })),
    ambiguousSpecifications: mapping.ambiguous.map((record) => ({
      expectedIndex: record.expectedIndex,
      specification: record.specification,
      editorGroupIndex: record.editorGroup.groupIndex,
      candidateCount: record.inputs.length,
      sharedWith: record.sharedWith,
      owner: describeElement(record.container),
      candidates: record.inputs.slice(0, 8).map(describeElement)
    })),
    unownedInputCount: mapping.unownedInputs.length
  };
}

function specificationImageBinding(expectedSpecs, spec) {
  const normalizedSpec = normalizeText(spec);
  const mapping = specificationImageInputMapping(expectedSpecs);
  const expectedIndexes = expectedSpecs
    .map((expectedSpec, expectedIndex) =>
      normalizeText(expectedSpec) === normalizedSpec ? expectedIndex : -1
    )
    .filter((expectedIndex) => expectedIndex >= 0);
  const binding =
    expectedIndexes.length === 1
      ? mapping.bindings[expectedIndexes[0]]
      : null;
  if (!mapping.ok || !binding) {
    throw new PageCommandError(
      "SPECIFICATION_IMAGE_INPUT_AMBIGUOUS",
      "规格计划无法与页面规格图输入框建立唯一映射",
      {
        spec: normalizedSpec,
        expectedMatchCount: expectedIndexes.length,
        ...specificationImageMappingEvidence(mapping)
      }
    );
  }
  return {
    ...binding,
    mode: mapping.mode
  };
}

function skuPreviewResources(cell) {
  const resources = [];
  const add = (value) => {
    const normalized = String(value || "").trim();
    if (normalized && !resources.includes(normalized)) {
      resources.push(normalized);
    }
  };
  for (const image of cell.querySelectorAll("img")) {
    add(image.currentSrc || image.getAttribute("src"));
  }
  for (const element of [cell, ...cell.querySelectorAll("*")].slice(0, 80)) {
    const background = getComputedStyle(element).backgroundImage;
    for (const match of String(background || "").matchAll(
      /url\((?:"|')?([^"')]+)(?:"|')?\)/g
    )) {
      add(match[1]);
    }
  }
  return resources;
}

function skuPreviewState(cell) {
  const resources = skuPreviewResources(cell);
  return {
    fileInputCount: cell.querySelectorAll('input[type="file"]').length,
    imageCount: cell.querySelectorAll("img").length,
    resources,
    remoteResourceCount: resources.filter((resource) =>
      /^https?:\/\//i.test(resource)
    ).length,
    text: displayText(cell).slice(0, 160)
  };
}

function skuPreviewTransition(before, after) {
  const beforeResources = new Set(before.resources || []);
  const addedResources = (after.resources || []).filter(
    (resource) => !beforeResources.has(resource)
  );
  return {
    verified:
      addedResources.length > 0 &&
      after.remoteResourceCount > 0,
    addedResources,
    before,
    after
  };
}

function skuScrollContainer(table) {
  const virtualHolder = table.querySelector(
    ".ecom-g-table-tbody-virtual-holder"
  );
  if (
    virtualHolder &&
    virtualHolder.scrollHeight > virtualHolder.clientHeight + 2
  ) {
    return virtualHolder;
  }
  let current = table.parentElement;
  while (current && current !== document.body) {
    const style = getComputedStyle(current);
    const scrollable =
      /(auto|scroll)/.test(style.overflowY) &&
      current.scrollHeight > current.clientHeight + 2;
    if (scrollable) return current;
    current = current.parentElement;
  }
  return null;
}

function visibleBusinessRows(table, columns) {
  const rows = allVisible(
    "tr.ecom-g-table-row, tbody tr",
    table
  );
  return rows.flatMap((row) => {
    if (!row.querySelector("input")) return [];
    const cells = rowCells(row);
    const spec = normalizeText(cells[columns.spec]?.innerText);
    if (!spec) return [];
    return [{ spec, row, cellCount: cells.length }];
  });
}

async function scanSkuGrid(expectedSpecs, runToken, targetSpec = null) {
  const contract = skuContract();
  const expected = contract.normalizeExpectedSpecs(expectedSpecs);
  const expectedSet = new Set(expected);
  const table = uniqueSkuTable();
  const headers = tableHeaders(table);
  const columns = contract.buildColumns(headers);
  const scroll = skuScrollContainer(table);
  const observed = new Set();
  const unexpected = new Set();
  const duplicates = new Set();
  let targetRow = null;
  let direction = 1;
  const startedAt = performance.now();

  if (scroll && !targetSpec) scroll.scrollTop = 0;
  table.scrollIntoView({ block: "center" });

  while (performance.now() - startedAt < SKU_SCAN_TIMEOUT_MS) {
    assertPageIdentity();
    assertRunStillActive(runToken);
    const rows = visibleBusinessRows(table, columns);
    const passSeen = new Set();
    for (const item of rows) {
      if (passSeen.has(item.spec)) duplicates.add(item.spec);
      passSeen.add(item.spec);
      observed.add(item.spec);
      if (!expectedSet.has(item.spec)) unexpected.add(item.spec);
      if (targetSpec && item.spec === targetSpec) targetRow = item.row;
    }
    if (unexpected.size || duplicates.size) {
      throw new PageCommandError(
        "SKU_GRID_IDENTITY_AMBIGUOUS",
        "SKU表格出现未知或重复规格",
        {
          unexpected: Array.from(unexpected),
          duplicates: Array.from(duplicates),
          headers
        }
      );
    }
    if (targetSpec && targetRow) {
      return {
        table,
        columns,
        row: targetRow,
        observed: Array.from(observed),
        headers,
        scrollable: Boolean(scroll)
      };
    }
    if (observed.size === expected.length) {
      const comparison = contract.compareObservedSpecs(
        expectedSpecs,
        Array.from(observed)
      );
      if (!comparison.exact) {
        throw new PageCommandError(
          "SKU_GRID_SET_MISMATCH",
          "SKU表格规格集合不一致",
          comparison
        );
      }
      return {
        table,
        columns,
        row: null,
        observed: Array.from(observed),
        headers,
        scrollable: Boolean(scroll)
      };
    }
    if (!scroll) break;
    const atBottom =
      scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2;
    const atTop = scroll.scrollTop <= 2;
    if (direction > 0 && atBottom) direction = -1;
    else if (direction < 0 && atTop) direction = 1;
    const step = Math.max(120, Math.floor(scroll.clientHeight * 0.75));
    scroll.scrollTop += direction * step;
    scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(120);
  }
  throw new PageCommandError(
    targetSpec ? "SKU_ROW_NOT_FOUND" : "SKU_GRID_SCAN_INCOMPLETE",
    targetSpec
      ? "SKU行无法通过精确规格重新绑定"
      : "虚拟SKU表格未观察到全部计划规格",
    {
      targetSpec,
      expectedCount: expected.length,
      observedCount: observed.size,
      missing: expected.filter((spec) => !observed.has(spec)).slice(0, 30),
      headers,
      scrollable: Boolean(scroll),
      elapsedMs: Math.round(performance.now() - startedAt)
    }
  );
}

function plannedSpecsFromArgs(args) {
  return (
    args.expectedSpecs ||
    args.specs ||
    args.plan?.map(
      (row) => row.spec ?? row.specification ?? row.uiSpec?.规格
    ) ||
    activeExpectedSpecs
  );
}

function rawExpectedSpecsFromArgs(args) {
  const specs = plannedSpecsFromArgs(args);
  skuContract().normalizeExpectedSpecs(specs);
  return specs.map((specification) => String(specification));
}

function expectedSpecsFromArgs(args) {
  return skuContract().normalizeExpectedSpecs(plannedSpecsFromArgs(args));
}

function specificationExpectedIdentity(specification) {
  const raw = String(specification);
  const trailing = /^(.*?)(?:\(([^()]*)\)|（([^（）]*)）)\s*$/.exec(raw);
  return {
    raw,
    normalized: normalizeText(raw),
    splitSpecification: trailing ? normalizeText(trailing[1]) : null,
    splitRemark: trailing
      ? normalizeText(trailing[2] ?? trailing[3] ?? "")
      : null
  };
}

function specificationEditorMatchesExpected(
  expectedIdentity,
  observedSpecification,
  observedRemark
) {
  const specification = normalizeText(observedSpecification);
  if (specification === expectedIdentity.normalized) return true;
  return (
    expectedIdentity.splitSpecification !== null &&
    specification === expectedIdentity.splitSpecification &&
    normalizeText(observedRemark) === expectedIdentity.splitRemark
  );
}

function specificationEditorInputState(specificationType = null) {
  const contract = globalThis.DoudianUpdateContract;
  const expectedType = specificationType === null
    ? null
    : contract.assertSpecificationType(specificationType);
  const records = allVisible(contract.SPECIFICATION_VALUE_INPUT_SELECTOR).map((input) => ({
    input,
    specificationType: contract.specificationTypeForPlaceholder(input.getAttribute("placeholder"))
  }));
  const observedTypes = [...new Set(records.map((record) => record.specificationType))];
  if (observedTypes.length > 1 || (expectedType && observedTypes.length === 1 && observedTypes[0] !== expectedType)) {
    throw new PageCommandError(
      "SPECIFICATION_EDITOR_TYPE_MISMATCH",
      "规格编辑器输入框类型与冻结规格类型不一致",
      { expectedType, observedTypes, inputCount: records.length }
    );
  }
  const resolvedType = expectedType || observedTypes[0] || null;
  return {
    specificationType: resolvedType,
    inputs: records
      .filter((record) => !resolvedType || record.specificationType === resolvedType)
      .map((record) => record.input)
  };
}

function specificationEditorGroups(specificationType = null) {
  const specificationInputs = specificationEditorInputState(specificationType).inputs;
  const groups = [];
  const seenGroups = new Set();
  for (const specificationInput of specificationInputs) {
    const group = specificationInput.closest("span.ecom-g-input-group");
    if (!group) {
      throw new PageCommandError(
        "SPECIFICATION_EDITOR_GROUP_OWNER_MISSING",
        "规格输入框不在可识别的编辑组中",
        { specificationInput: describeElement(specificationInput) }
      );
    }
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    groups.push(group);
  }
  return groups.map((group, groupIndex) => {
    const groupSpecificationInputs = specificationInputs.filter(
      (input) => input.closest("span.ecom-g-input-group") === group
    );
    const remarkInputs = Array.from(
      group.querySelectorAll('input[placeholder="备注"]')
    );
    if (groupSpecificationInputs.length !== 1 || remarkInputs.length > 1) {
      throw new PageCommandError(
        "SPECIFICATION_EDITOR_GROUP_INVALID",
        "规格编辑组必须包含一个规格输入框，且至多包含一个备注输入框",
        {
          groupIndex,
          specificationInputCount: groupSpecificationInputs.length,
          remarkInputCount: remarkInputs.length,
          group: describeElement(group)
        }
      );
    }
    const specificationInput = groupSpecificationInputs[0];
    const remarkInput = remarkInputs[0] || null;
    return {
      groupIndex,
      group,
      specificationInput,
      remarkInput,
      specification: String(specificationInput.value ?? ""),
      remark: String(remarkInput?.value ?? "")
    };
  });
}

function buildSpecificationEditorMapping(expectedSpecs, editorGroups) {
  const expected = expectedSpecs.map(specificationExpectedIdentity);
  const nonemptyGroups = editorGroups.filter((group) =>
    normalizeText(group.specification)
  );
  const invalidEmptyGroups = editorGroups.filter(
    (group) =>
      !normalizeText(group.specification) && normalizeText(group.remark)
  );
  const candidatesByExpected = expected.map((identity) =>
    nonemptyGroups.filter((group) =>
      specificationEditorMatchesExpected(
        identity,
        group.specification,
        group.remark
      )
    )
  );
  const expectedIndexesByGroup = nonemptyGroups.map((group) =>
    expected
      .map((identity, expectedIndex) =>
        specificationEditorMatchesExpected(
          identity,
          group.specification,
          group.remark
        )
          ? expectedIndex
          : -1
      )
      .filter((expectedIndex) => expectedIndex >= 0)
  );
  const missing = candidatesByExpected
    .map((candidates, expectedIndex) =>
      candidates.length === 0 ? expectedIndex : -1
    )
    .filter((expectedIndex) => expectedIndex >= 0);
  const ambiguous = candidatesByExpected
    .map((candidates, expectedIndex) =>
      candidates.length > 1
        ? {
            expectedIndex,
            groupIndexes: candidates.map((group) => group.groupIndex)
          }
        : null
    )
    .filter(Boolean);
  const unexpected = nonemptyGroups
    .filter((_group, groupIndex) => expectedIndexesByGroup[groupIndex].length === 0)
    .map((group) => group.groupIndex);
  const collisions = nonemptyGroups
    .map((group, groupIndex) =>
      expectedIndexesByGroup[groupIndex].length > 1
        ? {
            groupIndex: group.groupIndex,
            expectedIndexes: expectedIndexesByGroup[groupIndex]
          }
        : null
    )
    .filter(Boolean);
  const ok =
    nonemptyGroups.length === expected.length &&
    invalidEmptyGroups.length === 0 &&
    missing.length === 0 &&
    ambiguous.length === 0 &&
    unexpected.length === 0 &&
    collisions.length === 0;
  return {
    ok,
    expected,
    editorGroups,
    nonemptyGroups,
    invalidEmptyGroups,
    missing,
    ambiguous,
    unexpected,
    collisions,
    bindings: ok ? candidatesByExpected.map((candidates) => candidates[0]) : []
  };
}

function specificationEditorMappingEvidence(mapping) {
  return {
    expectedCount: mapping.expected.length,
    editorGroupCount: mapping.editorGroups.length,
    nonemptyGroupCount: mapping.nonemptyGroups.length,
    emptyGroupIndexes: mapping.editorGroups
      .filter((group) => !normalizeText(group.specification))
      .map((group) => group.groupIndex),
    invalidEmptyGroups: mapping.invalidEmptyGroups.map((group) => ({
      groupIndex: group.groupIndex,
      remark: group.remark
    })),
    missing: mapping.missing.map((expectedIndex) => ({
      expectedIndex,
      specification: mapping.expected[expectedIndex].raw
    })),
    ambiguous: mapping.ambiguous,
    unexpected: mapping.unexpected,
    collisions: mapping.collisions,
    observed: mapping.nonemptyGroups.map((group) => ({
      groupIndex: group.groupIndex,
      specification: group.specification,
      remark: group.remark
    }))
  };
}

function requireSpecificationEditorMapping(expectedSpecs) {
  const mapping = buildSpecificationEditorMapping(
    expectedSpecs,
    specificationEditorGroups()
  );
  if (!mapping.ok) {
    throw new PageCommandError(
      "SPECIFICATION_EDITOR_MAPPING_INVALID",
      "规格计划无法与页面规格编辑组建立唯一映射",
      specificationEditorMappingEvidence(mapping)
    );
  }
  return mapping;
}

async function repairImportedSpecifications(expectedSpecs, runToken) {
  await waitFor(
    () => {
      const groups = specificationEditorGroups();
      const nonemptyCount = groups.filter((group) =>
        normalizeText(group.specification)
      ).length;
      if (nonemptyCount >= expectedSpecs.length) return groups;
      const incomplete = buildSpecificationEditorMapping(expectedSpecs, groups);
      throw new PageCommandError(
        "SPECIFICATION_EDITOR_MAPPING_INCOMPLETE",
        "页面中的非空规格编辑组少于规格计划",
        specificationEditorMappingEvidence(incomplete)
      );
    },
    {
      timeout: SKU_SCAN_TIMEOUT_MS,
      code: "SPECIFICATION_EDITOR_DISCOVERY_TIMEOUT",
      label: "规格智能识别后未观察到全部规格编辑组",
      runToken,
      evidence: { expectedCount: expectedSpecs.length }
    }
  );

  let mapping = requireSpecificationEditorMapping(expectedSpecs);
  let repairedCount = 0;
  let unchangedCount = 0;
  for (let expectedIndex = 0; expectedIndex < expectedSpecs.length; expectedIndex += 1) {
    const expectedSpecification = expectedSpecs[expectedIndex];
    let binding = mapping.bindings[expectedIndex];

    if (
      binding.specification === expectedSpecification &&
      binding.remark === ""
    ) {
      unchangedCount += 1;
      continue;
    }
    repairedCount += 1;

    if (binding.specification !== expectedSpecification) {
      nativeSetValue(binding.specificationInput, expectedSpecification);
      const rebound = (
        await waitFor(
          () => {
            const rebound = buildSpecificationEditorMapping(
              expectedSpecs,
              specificationEditorGroups()
            );
            if (!rebound.ok) {
              throw new PageCommandError(
                "SPECIFICATION_EDITOR_REBIND_INVALID",
                "规格写回后页面映射暂时无效",
                specificationEditorMappingEvidence(rebound)
              );
            }
            return rebound;
          },
          {
            timeout: ACTION_TIMEOUT_MS,
            code: "SPECIFICATION_EDITOR_REBIND_TIMEOUT",
            label: "规格写回后无法重新绑定编辑组",
            runToken,
            evidence: { expectedIndex, expectedSpecification }
          }
        )
      ).value;
      mapping = rebound;
      binding = mapping.bindings[expectedIndex];
    }

    if (binding.remarkInput && binding.remark !== "") {
      nativeSetValue(binding.remarkInput, "");
    }

    mapping = (
      await waitFor(
        () => {
          const rebound = buildSpecificationEditorMapping(
            expectedSpecs,
            specificationEditorGroups()
          );
          if (!rebound.ok) {
            throw new PageCommandError(
              "SPECIFICATION_EDITOR_READBACK_MAPPING_INVALID",
              "规格回读时页面映射暂时无效",
              specificationEditorMappingEvidence(rebound)
            );
          }
          const current = rebound.bindings[expectedIndex];
          if (
            current.specification !== expectedSpecification ||
            current.remark !== ""
          ) {
            throw new PageCommandError(
              "SPECIFICATION_EDITOR_READBACK_MISMATCH",
              "规格或备注尚未达到严格回读值",
              {
                expectedIndex,
                groupIndex: current.groupIndex,
                expectedSpecification,
                actualSpecification: current.specification,
                actualRemark: current.remark
              }
            );
          }
          return rebound;
        },
        {
          timeout: ACTION_TIMEOUT_MS,
          code: "SPECIFICATION_EDITOR_READBACK_TIMEOUT",
          label: "规格或备注写回后回读不一致",
          runToken,
          evidence: { expectedIndex, expectedSpecification }
        }
      )
    ).value;
  }

  const finalMapping = requireSpecificationEditorMapping(expectedSpecs);
  const mismatches = finalMapping.bindings
    .map((binding, expectedIndex) =>
      binding.specification !== expectedSpecs[expectedIndex] || binding.remark !== ""
        ? {
            expectedIndex,
            groupIndex: binding.groupIndex,
            expectedSpecification: expectedSpecs[expectedIndex],
            actualSpecification: binding.specification,
            actualRemark: binding.remark
          }
        : null
    )
    .filter(Boolean);
  if (mismatches.length) {
    throw new PageCommandError(
      "SPECIFICATION_EDITOR_FINAL_READBACK_FAILED",
      "规格编辑组最终回读不一致",
      { mismatches }
    );
  }
  return {
    expectedCount: expectedSpecs.length,
    repairedCount,
    unchangedCount,
    emptyGroupCount:
      finalMapping.editorGroups.length - finalMapping.nonemptyGroups.length
  };
}

async function importSpecification(args, context) {
  const rawExpectedSpecs = rawExpectedSpecsFromArgs(args);
  const expectedSpecs = skuContract().normalizeExpectedSpecs(rawExpectedSpecs);
  const input = findSpecificationUploadControl();
  const assistant = uniqueElement(
    [input.closest('[data-testid="sku-info-smart-assistant"]')],
    "SPECIFICATION_ASSISTANT_AMBIGUOUS",
    "规格智能填写助手"
  );
  const selected = assignSingleFile(
    input,
    args.file || args.workbook || args.payload
  );
  const identifyButton = uniqueAction(["智能识别"], assistant);
  await waitFor(() => (isEnabled(identifyButton) ? true : null), {
    timeout: UPLOAD_TIMEOUT_MS,
    code: "SPECIFICATION_IDENTIFY_NOT_READY",
    label: "规格文件上传后智能识别按钮未启用",
    runToken: context.runToken
  });
  context.onIdentifyDispatch?.();
  clickElement(identifyButton);
  await waitFor(
    () => (findSkuTables(false).length === 1 ? true : null),
    {
      timeout: SKU_SCAN_TIMEOUT_MS,
      code: "SPECIFICATION_GRID_GENERATION_TIMEOUT",
      label: "规格智能识别后SKU表格未生成",
      runToken: context.runToken
    }
  );
  const specificationRepair = await repairImportedSpecifications(
    rawExpectedSpecs,
    context.runToken
  );
  const imageMode = await ensureSpecificationImageMode(
    expectedSpecs,
    context.runToken
  );
  const scan = await scanSkuGrid(expectedSpecs, context.runToken);
  activeExpectedSpecs = Object.freeze([...expectedSpecs]);
  return {
    selected,
    headers: scan.headers,
    imageMode,
    specificationRepair,
    observedCount: scan.observed.length,
    scrollable: scan.scrollable
  };
}

async function appendSpecificationsUsingWorkbook(args, context) {
  const specificationType = globalThis.DoudianUpdateContract.assertSpecificationType(args.specificationType);
  const expectedExisting = Array.isArray(args.existingSpecifications) ? args.existingSpecifications.map(normalizeText) : [];
  const additions = Array.isArray(args.additions) ? args.additions.map(normalizeText) : [];
  const observedExisting = specificationEditorGroups(specificationType)
    .map((group) => normalizeText(group.specification))
    .filter(Boolean);
  const plan = globalThis.DoudianSpecificationXlsx?.createAppendSpecificationPlan(
    expectedExisting,
    observedExisting,
    additions
  );
  if (!plan?.ok) {
    const validation = plan?.validation || {};
    const reasons = [];
    if (validation.emptyAdditionCount) reasons.push(`空规格 ${validation.emptyAdditionCount} 条`);
    if (validation.additionMatchesExistingCount) reasons.push(`与已有规格重复 ${validation.additionMatchesExistingCount} 条`);
    if (validation.duplicateAdditionCount) reasons.push(`新增清单内部重复 ${validation.duplicateAdditionCount} 条`);
    if (validation.duplicateExistingCount) reasons.push(`已有规格自身重复 ${validation.duplicateExistingCount} 条`);
    const samples = [
      ...(validation.additionMatchesExistingSamples || []),
      ...(validation.duplicateAdditionSamples || []),
      ...(validation.duplicateExistingSamples || [])
    ].filter(Boolean).slice(0, 5);
    const detail = reasons.length ? reasons.join("；") : "规格清单为空或缺少旧规格基线";
    const example = samples.length ? `；示例：${samples.join("、")}` : "";
    throw new PageCommandError("UPDATE_SPEC_IMPORT_APPEND_PLAN_INVALID", `新增规格预检未通过：${detail}${example}。未开始上传。`, {
      expectedExistingCount: expectedExisting.length,
      observedExistingCount: observedExisting.length,
      additionCount: additions.length,
      validation,
      invalidAdditions: plan?.invalidAdditions || additions,
      missingSpecifications: plan?.missingSpecifications || [],
      unexpectedSpecifications: plan?.unexpectedSpecifications || [],
      dispatched: false
    });
  }
  const expectedSpecs = [...plan.expectedSpecifications];
  const bytes = globalThis.DoudianSpecificationXlsx?.createSpecificationWorkbook(expectedSpecs);
  if (!(bytes instanceof Uint8Array)) {
    throw new PageCommandError("UPDATE_SPEC_IMPORT_WORKBOOK_BUILDER_UNAVAILABLE", "新增规格 Excel 生成组件未加载；未开始上传。", { dispatched: false });
  }
  const workbookFile = new File([bytes], "新增规格.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    lastModified: Date.now()
  });
  const payload = await globalThis.DoudianBinary.fileToPayload(workbookFile);
  const imported = await importSpecification({ file: payload, expectedSpecs }, {
    ...context,
    onIdentifyDispatch: context.onIdentifyDispatch
  });
  const observedAfter = specificationEditorGroups(specificationType)
    .map((group) => normalizeText(group.specification))
    .filter(Boolean);
  if (JSON.stringify(observedAfter) !== JSON.stringify(expectedSpecs)) {
    throw new PageCommandError("UPDATE_SPEC_IMPORT_APPEND_READBACK_FAILED", "Excel 智能识别后规格顺序或数量与“已有规格 + 新增规格”不一致；已停止后续字段写入。", {
      expectedSpecs, observedAfter, dispatched: true, outcomeUnknown: true
    });
  }
  return {
    ...imported,
    existingCount: plan.existingSpecifications.length,
    baselineDrift: {
      missingCount: plan.missingSpecifications.length,
      unexpectedCount: plan.unexpectedSpecifications.length,
      missingSpecifications: plan.missingSpecifications.slice(0, 10),
      unexpectedSpecifications: plan.unexpectedSpecifications.slice(0, 10)
    },
    appendedSpecifications: additions,
    observedSpecifications: observedAfter,
    uploadMode: "legacy_specification_workbook"
  };
}

async function createSpecificationGroup(args, context) {
  const specificationType = globalThis.DoudianUpdateContract.assertSpecificationType(args.specificationType);
  const owners = allVisible('[attr-field-id="spec_detail_0_name"]');
  if (owners.length === 0) {
    const addEntries = allVisible('button, [role="button"]')
      .filter((node) => /^添加规格类型\s*\(0\/3\)$/.test(normalizeText(displayText(node))));
    if (addEntries.length !== 1) {
      throw new PageCommandError("UPDATE_SPEC_GROUP_ADD_ENTRY_INVALID", "空规格编辑器的添加规格类型入口无法唯一定位", { count: addEntries.length });
    }
    dispatchPointerClick(addEntries[0]);
    const added = await waitFor(() => {
      const currentOwners = allVisible('[attr-field-id="spec_detail_0_name"]');
      return currentOwners.length === 1 ? currentOwners[0] : null;
    }, { timeout: ACTION_TIMEOUT_MS, code: "UPDATE_SPEC_GROUP_ADD_ENTRY_TIMEOUT", label: "点击添加规格类型后规格类型控件未出现", runToken: context.runToken });
  }
  const controls = await waitFor(() => {
    const currentOwner = uniqueElement(
      allVisible('[attr-field-id="spec_detail_0_name"]'),
      "UPDATE_SPEC_GROUP_CONTROL_MISSING",
      "规格类型控件"
    );
    const select = uniqueElement(allVisible(".ecom-g-select", currentOwner), "UPDATE_SPEC_GROUP_SELECT_MISSING", "规格类型下拉框");
    const comboboxes = Array.from(select.querySelectorAll('input[role="combobox"]'))
      .filter((node) => node.isConnected && node.getClientRects().length > 0);
    if (comboboxes.length !== 1) {
      throw new PageCommandError("UPDATE_SPEC_GROUP_COMBOBOX_MISSING", "规格类型输入框未唯一挂载", { count: comboboxes.length });
    }
    const selectors = allVisible(".ecom-g-select-selector", select);
    const selector = uniqueElement(selectors, "UPDATE_SPEC_GROUP_SELECTOR_MISSING", "规格类型可点击下拉区域");
    return { owner: currentOwner, select, combobox: comboboxes[0], selector };
  }, {
    timeout: ACTION_TIMEOUT_MS,
    code: "UPDATE_SPEC_GROUP_COMBOBOX_TIMEOUT",
    label: "规格类型下拉框输入控件未稳定加载",
    runToken: context.runToken
  });
  const { select, combobox, selector } = controls.value;
  if (specificationEditorInputState().inputs.length) {
    throw new PageCommandError("UPDATE_SPEC_GROUP_ALREADY_EXISTS", "规格类型创建前已存在规格值输入框", {});
  }
  dispatchPointerClick(selector);
  const popup = await waitFor(() => {
    const candidates = allVisible('[role="listbox"], [class*="select-dropdown"], [class*="SelectDropdown"]')
      .filter((node) => node.querySelector('input, [role="option"], button'));
    return candidates.length === 1 ? candidates[0] : null;
  }, { timeout: ACTION_TIMEOUT_MS, code: "UPDATE_SPEC_GROUP_POPUP_TIMEOUT", label: "规格类型下拉弹层未打开", runToken: context.runToken });
  const searchCandidates = Array.from(popup.value.querySelectorAll('input[role="combobox"], input'))
    .filter((node) => node.isConnected);
  const search = searchCandidates.find((node) => node !== combobox) || combobox;
  nativeSetSearchValue(search, specificationType, { readback: false });
  const selection = await waitFor(() => {
    const exactExistingOptions = allVisible('.ecom-g-select-item-option, [role="option"]', popup.value)
      .filter((node) => normalizeText(displayText(node)) === specificationType);
    const createActions = allVisible('button, [role="button"], [role="option"]', popup.value)
      .filter((node) => normalizeText(displayText(node)).includes("创建类型"));
    if (exactExistingOptions.length > 1 || createActions.length > 1) {
      throw new PageCommandError("UPDATE_SPEC_GROUP_OPTION_AMBIGUOUS", "规格类型弹层存在多个同名选项或创建入口", {
        specificationType,
        existingOptionCount: exactExistingOptions.length,
        createActionCount: createActions.length
      });
    }
    const action = exactExistingOptions[0] || createActions[0];
    if (!action) return null;
    return { action, selectionMode: exactExistingOptions[0] ? "existing" : "created" };
  }, { timeout: ACTION_TIMEOUT_MS, code: "UPDATE_SPEC_GROUP_OPTION_MISSING", label: "规格类型弹层没有唯一的已有规格或创建入口", runToken: context.runToken });
  dispatchPointerClick(selection.value.action);
  const readback = await waitFor(() => {
    const currentOwner = uniqueElement(allVisible('[attr-field-id="spec_detail_0_name"]'), "UPDATE_SPEC_GROUP_CONTROL_MISSING", "规格类型控件");
    const selected = allVisible('.ecom-g-select-selection-item', currentOwner)
      .filter((node) => normalizeText(node.getAttribute("title")) === specificationType);
    const empty = specificationEditorGroups(specificationType).filter((group) => !normalizeText(group.specification) && !normalizeText(group.remark));
    return selected.length === 1 && empty.length === 1 ? { selectedTitle: selected[0].getAttribute("title"), emptyCount: empty.length } : null;
  }, { timeout: ACTION_TIMEOUT_MS, code: "UPDATE_SPEC_GROUP_READBACK_TIMEOUT", label: "规格类型创建后未回读到唯一规格输入框", runToken: context.runToken });
  return { selectedType: readback.value.selectedTitle, specificationType, selectionMode: selection.value.selectionMode, emptyInputCount: readback.value.emptyCount };
}

// Update V1 deliberately does not use the workbook "智能识别" import. The page creates
// the next empty input only after the previous value commits, so every step re-queries DOM.
async function createSpecificationStep(args, context) {
  const specificationType = globalThis.DoudianUpdateContract.assertSpecificationType(args.specificationType);
  const expectedSpecs = skuContract().normalizeExpectedSpecs(rawExpectedSpecsFromArgs(args));
  const index = Number(args.index);
  const expected = expectedSpecs[index];
  const currentPageProfile = args.interactionProfile === "current_reused_page";
  const finalStep = index === expectedSpecs.length - 1;
  if (!Number.isInteger(index) || !expected || normalizeText(args.specification) !== expected) {
    throw new PageCommandError("UPDATE_SPEC_STEP_INVALID", "顺序创建规格的序号或规格值与冻结计划不一致", { index, specification: args.specification, expectedSpecs });
  }
  const before = specificationEditorGroups(specificationType);
  const filled = before.filter((group) => normalizeText(group.specification));
  const empty = before.filter((group) => !normalizeText(group.specification) && !normalizeText(group.remark));
  try {
    globalThis.DoudianUpdateContract.planSpecificationStep({
      expectedSpecs,
      index,
      observedFilled: filled.map((group) => group.specification),
      emptyCount: empty.length,
      allowMultipleEmpty: currentPageProfile
    });
  } catch (caught) {
    throw new PageCommandError(caught.code || "UPDATE_SPEC_STEP_BINDING_INVALID", "未找到当前唯一空的规格输入框，未写入页面", caught.evidence);
  }
  let firstInput = currentPageProfile ? empty.at(-1).specificationInput : empty[0].specificationInput;
  if (currentPageProfile && index > 0) {
    await sleep(600);
    const reboundGroups = specificationEditorGroups(specificationType);
    const reboundFilled = reboundGroups.filter((group) => normalizeText(group.specification));
    const reboundEmpty = reboundGroups.filter((group) => !normalizeText(group.specification) && !normalizeText(group.remark));
    try {
      globalThis.DoudianUpdateContract.planSpecificationStep({
        expectedSpecs,
        index,
        observedFilled: reboundFilled.map((group) => group.specification),
        emptyCount: reboundEmpty.length,
        allowMultipleEmpty: true
      });
    } catch (caught) {
      throw new PageCommandError(
        caught.code || "UPDATE_CURRENT_SPEC_INPUT_REBIND_INVALID",
        "当前页后续规格输入框挂载完成后与冻结计划不一致，未写入页面",
        caught.evidence
      );
    }
    firstInput = reboundEmpty.at(-1).specificationInput;
    const activated = await activateCurrentPageSpecificationInput(
      specificationType,
      expectedSpecs,
      index,
      firstInput,
      context.runToken
    );
    firstInput = activated.input;
  }
  if (index === 0) {
    const firstReady = await waitFor(() => {
      const groups = specificationEditorGroups(specificationType);
      const currentEmpty = groups.filter((group) => !normalizeText(group.specification) && !normalizeText(group.remark));
      if (currentEmpty.length !== 1 || !currentEmpty[0].specificationInput?.isConnected) return null;
      return currentEmpty[0].specificationInput;
    }, {
      timeout: ACTION_TIMEOUT_MS,
      code: "UPDATE_SPEC_FIRST_INPUT_NOT_READY",
      label: "首个规格输入框未出现",
      runToken: context.runToken
    });
    await sleep(1000);
    const rebound = await waitFor(() => {
      const groups = specificationEditorGroups(specificationType);
      const currentEmpty = groups.filter((group) => !normalizeText(group.specification) && !normalizeText(group.remark));
      return currentEmpty.length === 1 && currentEmpty[0].specificationInput?.isConnected
        ? currentEmpty[0].specificationInput
        : null;
    }, {
      timeout: ACTION_TIMEOUT_MS,
      code: "UPDATE_SPEC_FIRST_INPUT_REBIND_TIMEOUT",
      label: "首个规格输入框等待后无法重新定位",
      runToken: context.runToken
    });
    firstInput = rebound.value || firstReady.value;
  }
  const inputUsedForWrite = firstInput;
  // The page accepts the first and later specification values through the same blur commit.
  // Synthetic Enter events are not trusted by this editor and leave later inputs empty.
  await commitSpecificationValue(inputUsedForWrite, expected, context.runToken);
  const validationScope =
    inputUsedForWrite.closest("span.ecom-g-input-group")?.parentElement ||
    inputUsedForWrite.parentElement ||
    document;
  let stableSignature = "";
  let stableSince = 0;
  let lastObservation = null;
  const inspectSettlement = () => {
    const groups = specificationEditorGroups(specificationType);
    const values = groups.filter((group) => normalizeText(group.specification)).map((group) => normalizeText(group.specification));
    const nextEmpty = groups.filter((group) => !normalizeText(group.specification) && !normalizeText(group.remark));
    const committed = values.length === index + 1 && values.every((value, position) => value === expectedSpecs[position]);
    const nextInput = currentPageProfile ? nextEmpty.at(-1)?.specificationInput : nextEmpty[0]?.specificationInput;
    const finalWithoutNextAccepted = currentPageProfile && finalStep && committed;
    const nextInputReady = (currentPageProfile ? nextEmpty.length >= 1 : nextEmpty.length === 1) && groups.length >= index + 2 &&
      Boolean(nextInput?.isConnected) && nextInput !== inputUsedForWrite;
    lastObservation = {
      expectedSpecCount: expectedSpecs.length,
      index,
      expected,
      values,
      groupCount: groups.length,
      nextEmptyCount: nextEmpty.length,
      committed,
      finalStep,
      finalWithoutNextAccepted,
      nextInputConnected: Boolean(nextInput?.isConnected),
      inputReused: nextInput === inputUsedForWrite,
      writeTargetGroupIndex: specificationEditorGroups(specificationType)
        .find((group) => group.specificationInput === inputUsedForWrite)?.groupIndex ?? null,
      validationFeedback: visibleErrorTexts(validationScope).slice(0, 10)
    };
    if (!committed || (!finalWithoutNextAccepted && !nextInputReady)) return null;
    const signature = JSON.stringify({
      values,
      groupCount: groups.length,
      nextEmptyCount: nextEmpty.length,
      input: nextInput ? describeElement(nextInput) : null,
      finalWithoutNextAccepted
    });
    const now = Date.now();
    if (signature !== stableSignature) {
      stableSignature = signature;
      stableSince = now;
      return null;
    }
    if (now - stableSince < 180) return null;
    return { values, nextEmptyCount: nextEmpty.length, finalWithoutNextAccepted };
  };
  const waitForSettlement = (timeout, recovery = null) => waitFor(inspectSettlement, {
    timeout,
    code: "UPDATE_SPEC_STEP_REBIND_TIMEOUT",
    label: currentPageProfile
      ? "当前页规格写入后未观察到稳定提交结果或后续空输入框"
      : "规格写入后未观察到稳定提交结果和下一个唯一空输入框",
    runToken: context.runToken,
    evidence: {
      index,
      expected,
      expectedSpecCount: expectedSpecs.length,
      interactionProfile: currentPageProfile ? "current_reused_page" : "standard",
      inputUsedForWrite: describeElement(inputUsedForWrite),
      requiredGroupCount: finalStep && currentPageProfile ? index + 1 : index + 2,
      recovery
    }
  });
  let settled;
  let recovery = null;
  try {
    settled = await waitForSettlement(
      currentPageProfile
        ? CURRENT_PAGE_SPECIFICATION_SETTLEMENT_TIMEOUT_MS
        : ACTION_TIMEOUT_MS
    );
  } catch (caught) {
    const canRecover = currentPageProfile && !finalStep && lastObservation?.committed === true &&
      lastObservation.nextEmptyCount >= 0 && lastObservation.validationFeedback.length === 0;
    if (!canRecover) {
      throw new PageCommandError(
        caught.code || "UPDATE_SPEC_STEP_REBIND_TIMEOUT",
        caught.message || "当前页规格提交后无法继续创建下一个输入框",
        { ...(caught.evidence || {}), observation: lastObservation, recoveryAttempted: false }
      );
    }
    recovery = await recoverCurrentPageSpecificationCommit(specificationType, expectedSpecs, index, context.runToken);
    stableSignature = "";
    stableSince = 0;
    try {
      settled = await waitForSettlement(
        currentPageProfile
          ? CURRENT_PAGE_SPECIFICATION_SETTLEMENT_TIMEOUT_MS
          : 5000,
        recovery
      );
    } catch (retryError) {
      throw new PageCommandError(
        retryError.code || "UPDATE_SPEC_STEP_REBIND_TIMEOUT",
        "当前页规格已补提交一次，但后续空输入框仍未出现",
        { ...(retryError.evidence || {}), observation: lastObservation, recoveryAttempted: true, recovery }
      );
    }
  }
  if (index === expectedSpecs.length - 1) {
    await ensureSpecificationImageMode(expectedSpecs, context.runToken);
    await scanSkuGrid(expectedSpecs, context.runToken);
    activeExpectedSpecs = Object.freeze([...expectedSpecs]);
  }
  return {
    index,
    specification: expected,
    committed: settled.value.values,
    rebind: settled.value.finalWithoutNextAccepted ? "final_value_complete" : "visible_unique_empty_input",
    interactionProfile: currentPageProfile ? "current_reused_page" : "standard",
    recoveryAttempted: Boolean(recovery)
  };
}

async function rebindSkuRow(expectedSpecs, spec, runToken) {
  const normalizedSpec = normalizeText(spec);
  if (!expectedSpecs.includes(normalizedSpec)) {
    throw new PageCommandError(
      "SKU_SPEC_NOT_IN_PLAN",
      "目标规格不在当前规格价格表计划中",
      { spec, normalizedSpec, expectedSkuCount: expectedSpecs.length }
    );
  }
  return scanSkuGrid(expectedSpecs, runToken, normalizedSpec);
}

async function uploadSpecificationImage(
  expectedSpecs,
  spec,
  payload,
  runToken
) {
  let binding = specificationImageBinding(expectedSpecs, spec);
  let currentContainer = binding.container;
  const before = skuPreviewState(currentContainer);
  if (before.remoteResourceCount > 0) {
    return {
      selected: null,
      transition: {
        verified: true,
        reused: true,
        addedResources: [],
        before,
        after: before
      }
    };
  }
  const selected = assignSingleFile(
    binding.input,
    payload
  );
  let transition;
  try {
    transition = await waitFor(
      () => {
        if (!currentContainer.isConnected) {
          binding = specificationImageBinding(expectedSpecs, spec);
          currentContainer = binding.container;
        }
        const result = skuPreviewTransition(
          before,
          skuPreviewState(currentContainer)
        );
        return result.verified ? result : null;
      },
      {
        timeout: UPLOAD_TIMEOUT_MS,
        interval: 300,
        code: "SPECIFICATION_IMAGE_PREVIEW_TIMEOUT",
        label: "规格值图片上传后预览未确认",
        runToken,
        evidence: {
          spec: normalizeText(spec),
          selected: selected.file,
          before,
          dispatched: true
        }
      }
    );
  } catch (caught) {
    throw Object.assign(caught, { evidence: { ...(caught?.evidence || {}), dispatched: true, outcomeUnknown: true } });
  }
  return {
    selected,
    transition: transition.value
  };
}

function hoverElement(element) {
  const rect = element.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + Math.max(1, rect.width / 2),
    clientY: rect.top + Math.max(1, rect.height / 2),
    view: window
  };
  for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) {
    const Constructor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
    element.dispatchEvent(new Constructor(type, init));
  }
}

async function localSkuImageReplaceAction(container, runToken) {
  const previews = allVisible(".material-preview-button", container);
  if (previews.length !== 1) {
    throw new PageCommandError(
      "UPDATE_SKU_IMAGE_PREVIEW_AMBIGUOUS",
      "目标规格已有图片，但缩略图入口不唯一",
      { count: previews.length, dispatched: false }
    );
  }
  hoverElement(previews[0]);
  const action = await waitFor(() => {
    const candidates = allVisible(".ecom-g-popover")
      .flatMap((popover) => allVisible('label[role="button"][aria-disabled="false"], button, [role="button"]', popover))
      .filter((node) => normalizeText(displayText(node)) === "本地替换");
    if (candidates.length > 1) {
      throw new PageCommandError(
        "UPDATE_SKU_IMAGE_REPLACE_ACTION_AMBIGUOUS",
        "目标规格缩略图菜单中的“本地替换”不唯一",
        { count: candidates.length, dispatched: false }
      );
    }
    return candidates[0] || null;
  }, {
    timeout: ACTION_TIMEOUT_MS,
    code: "UPDATE_SKU_IMAGE_REPLACE_ACTION_MISSING",
    label: "目标规格缩略图菜单未出现唯一的本地替换入口",
    runToken
  });
  dispatchPointerClick(action.value);
}

function skuPreviewMatchesImageIdentity(state, imageIdentity) {
  const md5 = String(imageIdentity || "").split(":")[0].toLocaleLowerCase();
  return /^[a-f0-9]{32}$/.test(md5) && (state?.resources || []).some((source) =>
    new RegExp(`(?:^|[_/])${md5}(?:[_~.?]|$)`, "i").test(String(source))
  );
}

async function replaceSkuImage(args, context) {
  const productId = String(args.productId || "");
  const specification = String(args.specification || "");
  const image = args.image;
  const imageIdentity = String(args.imageIdentity || "");
  const expectedSpecs = expectedSpecsFromArgs(args);
  if (!/^\d{8,}$/.test(productId) || !specification || !image || !/^[a-f0-9]{32}:\d+$/.test(imageIdentity)) {
    throw new PageCommandError(
      "UPDATE_SKU_IMAGE_ARGS_INVALID",
      "换SKU图命令缺少商品ID、规格、图片或图片内容身份",
      { productId, specification, imageName: image?.name || null, imageIdentity, dispatched: false }
    );
  }
  await ensureSpecificationImageMode(expectedSpecs, context.runToken);
  let binding = specificationImageBinding(expectedSpecs, specification);
  const before = skuPreviewState(binding.container);
  const hasImage = before.remoteResourceCount > 0;
  if (hasImage && skuPreviewMatchesImageIdentity(before, imageIdentity)) {
    await sleep(120);
    binding = specificationImageBinding(expectedSpecs, specification);
    const stable = skuPreviewState(binding.container);
    if (skuPreviewMatchesImageIdentity(stable, imageIdentity)) {
      return {
        productId,
        specification: normalizeText(specification),
        action: "already_target",
        imageIdentity,
        verified: true,
        before,
        after: stable
      };
    }
  }
  if (!hasImage) {
    const uploaded = await uploadSpecificationImage(expectedSpecs, specification, image, context.runToken);
    if (!skuPreviewMatchesImageIdentity(uploaded.transition.after, imageIdentity)) {
      throw new PageCommandError(
        "UPDATE_SKU_IMAGE_UPLOAD_TARGET_MISMATCH",
        "SKU图片已上传，但规格 owner 的平台图片身份未匹配目标内容",
        { productId, specification, imageIdentity, dispatched: true, outcomeUnknown: true, after: uploaded.transition.after }
      );
    }
    return {
      productId,
      specification: normalizeText(specification),
      action: "upload",
      imageIdentity,
      verified: uploaded.transition.verified === true,
      before,
      after: uploaded.transition.after
    };
  }

  await localSkuImageReplaceAction(binding.container, context.runToken);
  binding = specificationImageBinding(expectedSpecs, specification);
  const assignedInput = binding.input;
  assignSingleFile(assignedInput, image);
  let stableReads = 0;
  let previousSignature = "";
  try {
    const settled = await waitFor(() => {
      const rebound = specificationImageBinding(expectedSpecs, specification);
      const after = skuPreviewState(rebound.container);
      const transition = skuPreviewTransition(before, after);
      const consumed = !assignedInput.isConnected || assignedInput.files?.length === 0 || rebound.input !== assignedInput;
      const previewReady = after.resources.length > 0 || after.imageCount > 0;
      const targetMatched = skuPreviewMatchesImageIdentity(after, imageIdentity);
      if (!previewReady || !targetMatched) {
        stableReads = 0;
        previousSignature = "";
        return null;
      }
      const signature = JSON.stringify({ resources: after.resources, imageCount: after.imageCount, consumed, targetMatched });
      stableReads = signature === previousSignature ? stableReads + 1 : 1;
      previousSignature = signature;
      return stableReads >= 2 ? { after, transition, consumed, stableReads } : null;
    }, {
      timeout: UPLOAD_TIMEOUT_MS,
      interval: 300,
      code: "UPDATE_SKU_IMAGE_REPLACE_READBACK_TIMEOUT",
      label: "SKU图片本地替换后未观察到稳定的规格 owner 回读",
      runToken: context.runToken,
      evidence: { productId, specification, imageIdentity, dispatched: true, before }
    });
    return {
      productId,
      specification: normalizeText(specification),
      action: "replace",
      imageIdentity,
      verified: true,
      before,
      after: settled.value.after,
      settlement: { consumed: settled.value.consumed, sourceChanged: settled.value.transition.addedResources.length > 0, stableReads: settled.value.stableReads }
    };
  } catch (caught) {
    throw Object.assign(caught, { evidence: { ...(caught?.evidence || {}), productId, specification, imageIdentity, dispatched: true, outcomeUnknown: true } });
  }
}

async function fillSkuRowOnce(args, context) {
  const expectedSpecs = expectedSpecsFromArgs(args);
  const spec = args.spec ?? args.specification ?? args.row?.spec;
  const price = String(args.price ?? args.row?.price ?? "");
  const stock = String(args.stock ?? args.row?.stock ?? "");
  const merchantCode = String(
    args.merchantCode ?? args.code ?? args.row?.merchantCode ?? ""
  );
  const imageMode = args.imageMode ?? "upload";
  const image = args.image ?? args.previewImage ?? args.row?.image;
  const hasWorkbookStock = stock !== "";
  if (!["upload", "deferred_missing"].includes(imageMode)) {
    throw new PageCommandError(
      "SKU_ROW_IMAGE_MODE_INVALID",
      "SKU图片处理模式无效",
      { imageMode }
    );
  }
  if (!spec || !price || !merchantCode || (imageMode === "upload" && !image)) {
    throw new PageCommandError(
      "SKU_ROW_PAYLOAD_INVALID",
      "SKU填写命令缺少规格、价格、商家编码或必需的预览图",
      {
        spec: spec || null,
        price: price || null,
        stock: stock || null,
        merchantCode: merchantCode || null,
        image: image?.name || null
      }
    );
  }
  let binding = await rebindSkuRow(
    expectedSpecs,
    spec,
    context.runToken
  );
  const specificationImageUpload = imageMode === "upload"
    ? await uploadSpecificationImage(
      expectedSpecs,
      spec,
      image,
      context.runToken
    )
    : null;

  binding = await rebindSkuRow(expectedSpecs, spec, context.runToken);
  const priceInput = rowInputAt(
    binding.row,
    binding.columns.price,
    "价格"
  );
  nativeSetValue(priceInput, price);

  binding = await rebindSkuRow(expectedSpecs, spec, context.runToken);
  const priceReadback = rowInputAt(
    binding.row,
    binding.columns.price,
    "价格"
  ).value;
  skuContract().assertCellReadback("price", price, priceReadback);
  if (hasWorkbookStock) {
    const stockInput = rowInputAt(
      binding.row,
      binding.columns.stock,
      "库存"
    );
    nativeSetValue(stockInput, stock);
    binding = await rebindSkuRow(expectedSpecs, spec, context.runToken);
  }
  const codeInput = rowInputAt(
    binding.row,
    binding.columns.merchantCode,
    "商家编码"
  );
  nativeSetValue(codeInput, merchantCode);

  binding = await rebindSkuRow(expectedSpecs, spec, context.runToken);
  const finalPrice = rowInputAt(
    binding.row,
    binding.columns.price,
    "价格"
  ).value;
  const finalStock = hasWorkbookStock
    ? rowInputAt(binding.row, binding.columns.stock, "库存").value
    : null;
  const finalCode = rowInputAt(
    binding.row,
    binding.columns.merchantCode,
    "商家编码"
  ).value;
  skuContract().assertCellReadback("price", price, finalPrice);
  if (hasWorkbookStock) {
    skuContract().assertCellReadback("stock", stock, finalStock);
  }
  skuContract().assertCellReadback(
    "merchantCode",
    merchantCode,
    finalCode
  );
  return {
    spec: normalizeText(spec),
    price: finalPrice,
    stock: finalStock,
    merchantCode: finalCode,
    image: {
      mode: imageMode,
      state: imageMode === "deferred_missing"
        ? "deferred_missing"
        : specificationImageUpload?.transition?.reused
          ? "reused"
          : "uploaded",
      specificationImageUpload
    },
    reboundAfterImage: imageMode === "upload",
    reboundBeforePrice: true,
    reboundBeforeCode: true,
    reboundAfterWrites: true
  };
}

async function fillSkuRow(args, context) {
  let lastError;
  for (let attempt = 1; attempt <= SKU_ROW_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fillSkuRowOnce(args, context);
    } catch (error) {
      lastError = error;
      if (
        attempt >= SKU_ROW_MAX_ATTEMPTS ||
        !RETRYABLE_SKU_ERROR_CODES.has(error?.code)
      ) {
        throw error;
      }
      assertRunStillActive(context.runToken);
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw lastError;
}

function dialogCandidates() {
  return allVisible(
    '[role="dialog"], [class*=modal], [class*=Modal], [class*=dialog], [class*=Dialog]'
  );
}

async function setBatchStock(args, context) {
  if (Array.isArray(args.expectedStocks)) {
    if (!args.expectedStocks.length) {
      throw new PageCommandError(
        "STOCK_PLAN_INVALID",
        "规格库存计划不能为空"
      );
    }
    return {
      stockMode: "per_row_workbook",
      appliedBy: "fill_sku_row",
      expectedCount: args.expectedStocks.length,
      skippedBatchWrite: true
    };
  }
  const requested = String(args.stock ?? STOCK_VALUE);
  if (requested !== STOCK_VALUE) {
    throw new PageCommandError(
      "STOCK_CONTRACT_MISMATCH",
      "批量库存不符合冻结内容",
      { expected: STOCK_VALUE, actual: requested }
    );
  }
  const button = uniqueAction(["批量设置"]);
  const batchScope = nearestAncestor(
    button,
    (candidate) =>
      candidate.querySelectorAll('input[placeholder="现货库存"]').length === 1 &&
      candidate.querySelectorAll("button").length >= 1,
    8
  );
  if (!batchScope) {
    throw new PageCommandError(
      "BATCH_STOCK_SCOPE_UNRECOGNIZED",
      "批量库存区域无法识别"
    );
  }
  const stockInput = uniqueElement(
    Array.from(
      batchScope.querySelectorAll('input[placeholder="现货库存"]')
    ),
    "BATCH_STOCK_INPUT_AMBIGUOUS",
    "批量现货库存输入框"
  );
  nativeSetValue(stockInput, STOCK_VALUE);
  const enabledButton = await waitFor(
    () => {
      const currentButtons = exactActionCandidates(
        ["批量设置"],
        batchScope
      );
      return currentButtons.length === 1 &&
        isEnabled(currentButtons[0])
        ? currentButtons[0]
        : null;
    },
    {
      code: "BATCH_STOCK_BUTTON_NOT_READY",
      label: "填写批量库存后批量设置按钮未启用",
      runToken: context.runToken
    }
  );
  clickElement(enabledButton.value);
  const table = uniqueSkuTable();
  const transition = await waitFor(
    () => {
      const visibleStocks = allVisible(
        'tr.ecom-g-table-row input[placeholder="请输入库存"]',
        table
      );
      return (
        visibleStocks.length > 0 &&
        visibleStocks.every((input) => input.value === STOCK_VALUE)
      );
    },
    {
      code: "BATCH_STOCK_VISIBLE_ROWS_TIMEOUT",
      label: "批量库存设置后可见SKU未全部回读999",
      runToken: context.runToken
    }
  );
  return {
    stock: STOCK_VALUE,
    scope: describeElement(batchScope),
    visibleRowsUpdated: true,
    elapsedMs: transition.elapsedMs
  };
}

async function verifySkuStock(args, context) {
  const expectedSpecs = expectedSpecsFromArgs(args);
  const expectedStocks = Array.isArray(args.expectedStocks)
    ? new Map(
        args.expectedStocks.map((row) => [
          normalizeText(row.specification ?? row.spec),
          String(row.stock ?? "")
        ])
      )
    : null;
  if (expectedStocks) {
    const missing = expectedSpecs.filter(
      (spec) => !expectedStocks.has(spec) || expectedStocks.get(spec) === ""
    );
    if (missing.length || expectedStocks.size !== expectedSpecs.length) {
      throw new PageCommandError(
        "STOCK_PLAN_INVALID",
        "规格库存计划与规格计划不一致",
        { expectedCount: expectedSpecs.length, stockCount: expectedStocks.size, missing }
      );
    }
  }
  const stock = String(args.stock ?? STOCK_VALUE);
  if (!expectedStocks && stock !== STOCK_VALUE) {
    throw new PageCommandError(
      "STOCK_CONTRACT_MISMATCH",
      "库存核验值不符合冻结内容",
      { expected: STOCK_VALUE, actual: stock }
    );
  }
  const expectedSet = new Set(expectedSpecs);
  const table = uniqueSkuTable();
  const columns = skuContract().buildColumns(tableHeaders(table));
  const rows = visibleBusinessRows(table, columns);
  if (!rows.length) {
    throw new PageCommandError(
      "SKU_STOCK_VISIBLE_ROWS_MISSING",
      "官方批量库存设置后没有可见SKU行"
    );
  }
  const mismatches = [];
  for (const item of rows) {
    if (!expectedSet.has(item.spec)) {
      mismatches.push({
        spec: item.spec,
        expected: "计划内规格",
        actual: "未知规格"
      });
      continue;
    }
    const actual = rowInputAt(
      item.row,
      columns.stock,
      "库存"
    ).value;
    const expectedStock = expectedStocks ? expectedStocks.get(item.spec) : STOCK_VALUE;
    if (actual !== expectedStock) {
      mismatches.push({
        spec: item.spec,
        expected: expectedStock,
        actual
      });
    }
  }
  if (mismatches.length) {
    throw new PageCommandError(
      "SKU_STOCK_VERIFICATION_FAILED",
      "部分SKU库存回读不一致",
      {
        mismatches,
        verificationMode: expectedStocks
          ? "per_row_workbook_stock"
          : "official_batch_visible_rows",
        expectedCount: expectedSpecs.length,
        visibleCount: rows.length
      }
    );
  }
  return {
    verificationMode: expectedStocks
      ? "per_row_workbook_stock"
      : "official_batch_visible_rows",
    verifiedVisibleCount: rows.length,
    expectedTotalCount: expectedSpecs.length,
    stock: expectedStocks ? null : STOCK_VALUE
  };
}

function setInventoryDeduction(args) {
  assertExactContractValue(
    args.value ?? args.mode ?? STOCK_DEDUCTION_TEXT,
    STOCK_DEDUCTION_TEXT,
    "INVENTORY_DEDUCTION_CONTRACT_MISMATCH",
    "库存扣减方式"
  );
  return ensureExactChoice(
    STOCK_DEDUCTION_TEXT,
    fieldContainer("订单库存计数")
  );
}

function matchesAfterSalePolicy(value, expectedText = AFTER_SALE_TEXT) {
  const normalized = normalizeText(value);
  const expected = normalizeText(expectedText);
  if (normalized === expected) return true;
  return /^7天无理由退货\(一次性包装未(?:破(?:损)?)?(?:\.\.\.|…)$/.test(
    normalized
  );
}

function afterSaleDisplayCandidates(root, expectedText = AFTER_SALE_TEXT) {
  const selectorScope =
    root.querySelector(
      ".ecom-g-select-selector, [class*=select-selector], [class*=SelectSelector]"
    ) || root;
  const knownCandidates = allVisible(
    [
      ".ecom-g-select-selection-item",
      ".ecom-g-select-selection-overflow-item",
      "[class*=selection-item]",
      "[class*=SelectionItem]",
      '[aria-selected="true"]',
      '[data-state="selected"]',
      "option:checked"
    ].join(","),
    selectorScope
  );
  const semanticCandidates = allVisible(
    "span, div, p, [title], [aria-label], [aria-valuetext], [value_name], [data-value]",
    selectorScope
  ).filter((element) =>
    elementTextValues(element).some((value) =>
      matchesAfterSalePolicy(value, expectedText)
    )
  );
  const directScopeCandidate = elementTextValues(selectorScope).some(
    (value) => matchesAfterSalePolicy(value, expectedText)
  )
    ? [selectorScope]
    : [];
  return Array.from(
    new Set([
      ...knownCandidates,
      ...semanticCandidates,
      ...directScopeCandidate
    ])
  );
}

function visibleSelectPopups() {
  return allVisible(
    [
      ".ecom-g-select-dropdown",
      "[class*=select-dropdown]",
      "[class*=SelectDropdown]",
      "[class*=selectPopup]",
      "[class*=SelectPopup]",
      '[role="listbox"]'
    ].join(",")
  ).filter(
    (popup, index, popups) =>
      !popups.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index && candidate.contains(popup)
      )
  );
}

function afterSaleOptionSelectionState(
  control,
  expectedText = AFTER_SALE_TEXT,
  popupsBeforeOpen = new Set()
) {
  const context = controlledSelectContext(control);
  const visiblePopups = visibleSelectPopups();
  const targetRecords = visiblePopups.flatMap((popup) => {
    const raw = allVisible(
      ".ecom-g-select-item-option, [role=option], option, li[role=option]",
      popup
    ).filter((element) =>
      elementTextValues(optionContainer(element)).some((value) =>
        matchesAfterSalePolicy(value, expectedText)
      )
    );
    return canonicalizeOptionRecords(
      raw.map((element) => ({
        element,
        canonical: optionContainer(element),
        popup
      }))
    ).map((record) => {
      const values = elementTextValues(record.element);
      return {
        ...record,
        values,
        matchedValue:
          values.find((value) =>
            matchesAfterSalePolicy(value, expectedText)
          ) || null,
        active:
          record.element.getAttribute("aria-selected") === "true" ||
          record.element.getAttribute("data-state") === "selected" ||
          record.element.classList.contains(
            "ecom-g-select-item-option-active"
          )
      };
    });
  });
  const popupsWithTargets = visiblePopups.filter((popup) =>
    targetRecords.some((record) => record.popup === popup)
  );
  const controlledPopup =
    context.popup &&
    isVisible(context.popup) &&
    popupsWithTargets.includes(context.popup)
      ? context.popup
      : null;
  const newlyOpenedPopups = popupsWithTargets.filter(
    (popup) => !popupsBeforeOpen.has(popup)
  );
  let selectedPopup = null;
  let locatorStrategy = "no_target_popup";
  if (controlledPopup) {
    selectedPopup = controlledPopup;
    locatorStrategy = "controlled_popup";
  } else if (newlyOpenedPopups.length === 1) {
    selectedPopup = newlyOpenedPopups[0];
    locatorStrategy = "newly_opened_popup";
  } else if (popupsWithTargets.length === 1) {
    selectedPopup = popupsWithTargets[0];
    locatorStrategy = "single_target_popup";
  }
  const popupRecords = selectedPopup
    ? targetRecords.filter((record) => record.popup === selectedPopup)
    : [];
  const preferredRecord =
    popupRecords.find((record) => record.active) || popupRecords[0] || null;
  const resolvedCandidates = preferredRecord
    ? [
        {
          ...preferredRecord,
          optionIdentity: `after-sale:${normalizeText(expectedText)}`,
          equivalentCandidateCount: popupRecords.length
        }
      ]
    : [];
  const semanticKey =
    selectedPopup && resolvedCandidates.length === 1
      ? normalizeText(expectedText)
      : null;
  return {
    resolvedCandidates,
    semanticKey,
    selectedPopup,
    evidence: {
      rawCandidateCount: targetRecords.length,
      resolvedCandidateCount: resolvedCandidates.length,
      visiblePopupCount: visiblePopups.length,
      targetPopupCount: popupsWithTargets.length,
      newlyOpenedTargetPopupCount: newlyOpenedPopups.length,
      locatorStrategy,
      controlledIds: context.ids,
      candidates: targetRecords.slice(0, 12).map((record) => ({
        ...describeElement(record.element),
        values: record.values,
        matchedValue: record.matchedValue,
        active: record.active,
        inSelectedPopup: record.popup === selectedPopup
      }))
    }
  };
}

function afterSaleFieldState(expectedText = AFTER_SALE_TEXT) {
  const container = fieldContainer("售后政策");
  const control = uniqueElement(
    Array.from(
      container.querySelectorAll(
        '[role="combobox"], input[type="search"], select'
      )
    ),
    "AFTER_SALE_CONTROL_AMBIGUOUS",
    "售后政策下拉控件",
    {
      container: describeElement(container)
    }
  );
  const root = selectControlScope(control);
  if (!container.contains(root)) {
    throw new PageCommandError(
      "AFTER_SALE_ROOT_OUTSIDE_FIELD",
      "售后政策下拉根节点不在字段容器内",
      {
        container: describeElement(container),
        control: describeElement(control),
        root: describeElement(root)
      }
    );
  }
  const displayCandidates = afterSaleDisplayCandidates(
    root,
    expectedText
  );
  const candidateEvidence = displayCandidates.map((element) => {
    const values = elementTextValues(element);
    return {
      ...describeElement(element),
      values,
      matchedValue:
        values.find((value) =>
          matchesAfterSalePolicy(value, expectedText)
        ) || null
    };
  });
  const displayMatch = candidateEvidence.find(
    (candidate) => candidate.matchedValue
  );
  const authoritativeValues = Array.from(
    new Set(
      [
        readAuthoritativeControl(control),
        ...elementTextValues(control),
        ...elementTextValues(root)
      ].filter(Boolean)
    )
  );
  const authoritativeMatch = authoritativeValues.find((value) =>
    matchesAfterSalePolicy(value, expectedText)
  );
  const displayValue =
    displayMatch || authoritativeMatch
      ? expectedText
      : resolveSelectionText(displayCandidates, expectedText) ||
        "";
  return {
    container,
    control,
    root,
    displayCandidates,
    displayValue,
    containerText: displayText(container),
    matchedSource: displayMatch
      ? "selected_display"
      : authoritativeMatch
        ? "authoritative_control"
        : null,
    matchedValue:
      displayMatch?.matchedValue || authoritativeMatch || null,
    authoritativeValues,
    candidateEvidence
  };
}

async function ensureAfterSalePolicy(
  expectedText = AFTER_SALE_TEXT,
  runToken = null
) {
  const expected = normalizeText(expectedText);
  const before = afterSaleFieldState(expectedText);
  if (normalizeText(before.displayValue) === expected) {
    return {
      action: "already_selected",
      before: before.displayValue,
      after: before.displayValue,
      displayCandidateCount: before.displayCandidates.length
    };
  }

  const clickTarget = uniqueElement(
    allVisible(
      ".ecom-g-select-selector, [class*=select-selector], [class*=SelectSelector]",
      before.root
    ),
    "AFTER_SALE_CLICK_TARGET_AMBIGUOUS",
    "售后政策下拉点击区域",
    {
      control: describeElement(before.control),
      root: describeElement(before.root)
    }
  );
  const popupsBeforeOpen = new Set(visibleSelectPopups());
  const openInteraction = dispatchPointerClick(clickTarget);
  const popupOpen = await waitFor(
    () => {
      const popups = visibleSelectPopups();
      const newPopups = popups.filter(
        (popup) => !popupsBeforeOpen.has(popup)
      );
      const expanded =
        before.control.getAttribute("aria-expanded") === "true" ||
        before.root.getAttribute("aria-expanded") === "true";
      return newPopups.length > 0 || expanded
        ? {
            visiblePopupCount: popups.length,
            newPopupCount: newPopups.length,
            expanded
          }
        : null;
    },
    {
      timeout: 3000,
      interval: 100,
      code: "AFTER_SALE_POPUP_OPEN_TIMEOUT",
      label: "售后政策下拉浮层未打开",
      runToken,
      evidence: {
        clickTarget: describeElement(clickTarget),
        openInteraction,
        control: describeElement(before.control),
        root: describeElement(before.root),
        beforeAuthoritativeValues: before.authoritativeValues
      }
    }
  );
  const searchWrite = null;

  let stableSemanticKey = null;
  let stablePasses = 0;
  const optionState = await waitFor(
    () => {
      const current = afterSaleOptionSelectionState(
        before.control,
        expectedText,
        popupsBeforeOpen
      );
      if (current.resolvedCandidates.length !== 1) {
        stableSemanticKey = null;
        stablePasses = 0;
        throw new PageCommandError(
          "AFTER_SALE_OPTION_NOT_CONVERGED",
          "售后政策目标选项尚未收敛",
          current.evidence
        );
      }
      if (current.semanticKey === stableSemanticKey) {
        stablePasses += 1;
      } else {
        stableSemanticKey = current.semanticKey;
        stablePasses = 1;
      }
      return stablePasses >= 3 ? current : null;
    },
    {
      timeout: ACTION_TIMEOUT_MS,
      interval: 150,
      code: "AFTER_SALE_OPTION_TIMEOUT",
      label: "售后政策目标选项未稳定为唯一候选",
      runToken,
      evidence: {
        expected: expectedText,
        before: before.displayValue,
        beforeContainerText: before.containerText,
        beforeMatchedSource: before.matchedSource,
        beforeMatchedValue: before.matchedValue,
        beforeAuthoritativeValues: before.authoritativeValues,
        beforeCandidates: before.candidateEvidence,
        popupOpen: popupOpen.value,
        openInteraction,
        searchWrite
      }
    }
  );
  const reboundOptionState = afterSaleOptionSelectionState(
    before.control,
    expectedText,
    popupsBeforeOpen
  );
  if (reboundOptionState.resolvedCandidates.length !== 1) {
    throw new PageCommandError(
      "AFTER_SALE_OPTION_REBIND_FAILED",
      "点击前无法重新绑定售后政策目标选项",
      reboundOptionState.evidence
    );
  }
  clickElement(reboundOptionState.resolvedCandidates[0].element);

  const readback = await waitFor(
    () => {
      const current = afterSaleFieldState(expectedText);
      return normalizeText(current.displayValue) === expected
        ? current
        : null;
    },
    {
      code: "AFTER_SALE_READBACK_TIMEOUT",
      label: "售后政策选择后字段显示值未更新",
      runToken,
      evidence: {
        expected: expectedText,
        before: before.displayValue,
        beforeContainerText: before.containerText,
        beforeMatchedSource: before.matchedSource,
        beforeMatchedValue: before.matchedValue,
        beforeAuthoritativeValues: before.authoritativeValues,
        beforeCandidates: before.candidateEvidence,
        popupOpen: popupOpen.value,
        openInteraction,
        searchWrite
      }
    }
  );
  return {
    action: "selected",
    before: before.displayValue,
    after: readback.value.displayValue,
    locatorStrategy: optionState.value.evidence.locatorStrategy,
    searchWrite,
    displayCandidateCount:
      readback.value.displayCandidates.length
  };
}

async function testAfterSale(args, context) {
  assertFullForm();
  assertExactContractValue(
    args.afterSale ?? AFTER_SALE_TEXT,
    AFTER_SALE_TEXT,
    "AFTER_SALE_CONTRACT_MISMATCH",
    "售后政策"
  );
  const serviceSection = activateSection("服务与履约");
  const afterSale = await ensureAfterSalePolicy(
    AFTER_SALE_TEXT,
    context.runToken
  );
  return {
    test: "after_sale",
    serviceSection,
    afterSale
  };
}

async function setServiceTerms(args, context) {
  assertFullForm();
  const freight = String(args.freightTemplate ?? "").trim();
  if (!freight) {
    throw new PageCommandError(
      "FREIGHT_TEMPLATE_REQUIRED",
      "运费模板不能为空"
    );
  }
  assertExactContractValue(
    args.afterSale ?? AFTER_SALE_TEXT,
    AFTER_SALE_TEXT,
    "AFTER_SALE_CONTRACT_MISMATCH",
    "售后政策"
  );
  assertExactContractValue(
    args.productStatus ?? "上架",
    "上架",
    "PRODUCT_STATUS_CONTRACT_MISMATCH",
    "商品状态"
  );
  if (String(args.maxPurchase ?? MAX_PURCHASE) !== MAX_PURCHASE) {
    throw new PageCommandError(
      "MAX_PURCHASE_CONTRACT_MISMATCH",
      "每单限购不符合冻结内容",
      { expected: MAX_PURCHASE, actual: args.maxPurchase }
    );
  }
  const serviceSection = activateSection("服务与履约");
  let freightEvidence;
  try {
    freightEvidence = await ensureFieldSelection("运费模板", freight, {
      runToken: context.runToken
    });
  } catch (error) {
    if (
      error instanceof PageCommandError &&
      error.code === "OPTION_AMBIGUOUS" &&
      error.evidence?.count === 0
    ) {
      throw new PageCommandError(
        "FREIGHT_TEMPLATE_UNAVAILABLE",
        `运费模板不可用：当前店铺没有“${freight}”`,
        { freightTemplate: freight, cause: error.evidence }
      );
    }
    throw error;
  }
  const afterSale = await ensureAfterSalePolicy(
    AFTER_SALE_TEXT,
    context.runToken
  );
  const status = ensureExactChoice(
    "上架",
    fieldContainer("商品状态")
  );
  const maxControl = fieldControl(
    "每个订单最多购买",
    "input"
  );
  const maxWrite = nativeSetValue(maxControl, MAX_PURCHASE);
  return {
    serviceSection,
    freight: freightEvidence,
    afterSale,
    status,
    maxPurchase: maxWrite
  };
}

function visibleErrorTexts(scope = document) {
  const selectors = [
    '[role="alert"]',
    '[aria-invalid="true"]',
    '[class*="error-message"]',
    '[class*="errorMessage"]',
    '[class*="form-item-error"]',
    '[class*="form-item"][class*="error"]',
    '[class*="FormItem"][class*="Error"]',
    '[class*="explain-error"]',
    '[class*="ExplainError"]',
    '[data-status="error"]'
  ].join(",");
  return Array.from(
    new Set(
      allVisible(selectors, scope)
        .map((element) => {
          const text = displayText(element);
          if (text) return text;
          if (element.getAttribute("aria-invalid") !== "true") return "";
          return (
            normalizeText(element.getAttribute("aria-label")) ||
            normalizeText(element.getAttribute("placeholder")) ||
            "存在未通过校验的字段"
          );
        })
        .filter(Boolean)
    )
  );
}

function fillingResultNodes() {
  const pattern =
    /填写检查通过|检查通过|暂无待完善项|信息填写完整|暂无问题/;
  return allVisible("body *").filter((element) => {
    if (element.children.length > 8) return false;
    return pattern.test(displayText(element));
  });
}

function buttonLoadingState(button) {
  const text = displayText(button);
  return (
    button.disabled ||
    button.getAttribute("aria-busy") === "true" ||
    button.getAttribute("data-loading") === "true" ||
    /检查中|加载中|处理中/.test(text) ||
    Boolean(button.querySelector('[class*=loading], [class*=Loading]'))
  );
}

function fillingCheckResultEvidence(
  current,
  baselineNodes,
  stableIdlePasses,
  errors = []
) {
  if (errors.length) {
    return {
      completionMode: "validation_failed",
      resultText: null,
      currentResultCount: current.length,
      errors: errors.slice(0, 50)
    };
  }
  const fresh = current.find(
    (node) =>
      !baselineNodes.includes(node) ||
      !baselineNodes.every(
        (oldNode) => oldNode.isConnected && isVisible(oldNode)
      )
  );
  if (fresh) {
    return {
      completionMode: "fresh_result_text",
      resultText: displayText(fresh),
      currentResultCount: current.length
    };
  }
  if (stableIdlePasses < 5) return null;
  return {
    completionMode: "loading_cycle_completed",
    resultText: null,
    currentResultCount: current.length
  };
}

async function runFillingCheck(args, context) {
  assertFullForm();
  const button = uniqueAction(["填写检查"]);
  const baselineNodes = fillingResultNodes();
  const baselineErrors = visibleErrorTexts();
  clickElement(button);
  const loading = await waitFor(
    () => (buttonLoadingState(button) ? true : null),
    {
      timeout: ACTION_TIMEOUT_MS,
      code: "FILLING_CHECK_LOADING_NOT_OBSERVED",
      label: "本次填写检查未进入可见加载周期",
      runToken: context.runToken,
      evidence: {
        baselineResultCount: baselineNodes.length,
        baselineErrors
      }
    }
  );
  let stableIdlePasses = 0;
  let buttonRebound = false;
  const result = await waitFor(
    () => {
      const currentButton = uniqueAction(["填写检查"]);
      buttonRebound ||= currentButton !== button;
      if (buttonLoadingState(currentButton)) {
        stableIdlePasses = 0;
        return null;
      }
      const errors = visibleErrorTexts();
      const current = fillingResultNodes();
      stableIdlePasses += 1;
      const completion = fillingCheckResultEvidence(
        current,
        baselineNodes,
        stableIdlePasses,
        errors
      );
      return completion
        ? { ...completion, stableIdlePasses, buttonRebound, errors }
        : null;
    },
    {
      timeout: ACTION_TIMEOUT_MS,
      code: "FILLING_CHECK_RESULT_NOT_FRESH",
      label: "未观察到本次填写检查产生的新结果",
      runToken: context.runToken,
      evidence: {
        baselineResultTexts: baselineNodes.map(displayText),
        loadingObserved: true
      }
    }
  );
  if (result.value.completionMode === "validation_failed") {
    throw new PageCommandError(
      "FORM_VALIDATION_FAILED",
      "填写检查仍有可见错误",
      { errors: result.value.errors }
    );
  }
  fillingCheckEvidence = {
    runToken: context.runToken,
    checkedAt: new Date().toISOString(),
    loadingElapsedMs: loading.elapsedMs,
    resultElapsedMs: result.elapsedMs,
    ...result.value
  };
  return fillingCheckEvidence;
}

function assertReviewReady(args) {
  const expectedTitle = requestedMainTitle(args);
  const expectedShortTitle = requestedShortTitle(args);
  const brand = requestedBrand(args);
  const expectedFreight = String(args?.freightTemplate ?? "").trim();
  if (!expectedFreight) {
    throw new PageCommandError(
      "FREIGHT_TEMPLATE_REQUIRED",
      "运费模板不能为空"
    );
  }
  assertFullForm();
  if (!fillingCheckEvidence) {
    throw new PageCommandError(
      "REVIEW_READY_NOT_CONFIRMED",
      "尚未完成本页面文档的新鲜填写检查"
    );
  }
  const errors = visibleErrorTexts();
  if (errors.length) {
    throw new PageCommandError(
      "REVIEW_READY_HAS_ERRORS",
      "复核状态仍存在可见错误",
      { errors: errors.slice(0, 50) }
    );
  }
  const titleControls = allVisible("input, textarea").filter(
    (control) =>
      normalizeText(control.value) === normalizeText(expectedTitle)
  );
  const shortControls = allVisible("input, textarea").filter(
    (control) =>
      normalizeText(control.value) === normalizeText(expectedShortTitle)
  );
  const detail = inspectDetailState();
  const optionalMedia = reviewOptionalMediaPlan();
  const brandControl = findBrandControl(brand);
  const brandReadback = readSelectionControlValue(brandControl, brand);
  const mode = stateBearingChoice("现货").target;
  const dispatch = stateBearingChoice("48小时").target;
  const deduction = stateBearingChoice(
    STOCK_DEDUCTION_TEXT,
    fieldContainer("订单库存计数")
  ).target;
  const afterSaleReadback =
    afterSaleFieldState(AFTER_SALE_TEXT).displayValue;
  const productStatus = stateBearingChoice("上架").target;
  const freightControl = fieldControl(
    "运费模板",
    '[role="combobox"], input[type="search"], select'
  );
  const freightReadback = readSelectionControlValue(
    freightControl,
    expectedFreight
  );
  const maxControl = fieldControl(
    "每个订单最多购买",
    "input"
  );
  if (
    titleControls.length !== 1 ||
    shortControls.length !== 1 ||
    detail.count < 1 ||
    detail.count > 50 ||
    normalizeText(brandReadback) !== normalizeText(brand) ||
    selectedState(mode) !== true ||
    selectedState(dispatch) !== true ||
    selectedState(deduction) !== true ||
    normalizeText(afterSaleReadback) !== normalizeText(AFTER_SALE_TEXT) ||
    selectedState(productStatus) !== true ||
    normalizeText(freightReadback) !== normalizeText(expectedFreight) ||
    String(maxControl.value) !== MAX_PURCHASE
  ) {
    throw new PageCommandError(
      "REVIEW_READY_POSTCONDITION_MISMATCH",
      "最终复核状态关键回读不一致",
      {
        titleControlCount: titleControls.length,
        shortTitleControlCount: shortControls.length,
        detailCount: detail.count,
        brandReadback,
        fulfillment: {
          mode: selectedState(mode),
          dispatch: selectedState(dispatch),
          deduction: selectedState(deduction)
        },
        service: {
          expectedFreight,
          freightReadback,
          afterSaleReadback,
          productStatus: selectedState(productStatus),
          maxPurchase: maxControl.value
        }
      }
    );
  }
  return {
    state: "review_ready",
    title: expectedTitle,
    shortTitle: expectedShortTitle,
    brand,
    detailCount: detail.count,
    optionalMedia,
    fillingCheck: fillingCheckEvidence,
    errors
  };
}

function abortRun(context) {
  abortedRunToken = context.runToken;
  activeRunToken = null;
  fillingCheckEvidence = null;
  activeExpectedSpecs = null;
  activeOptionalMediaPlan = Object.create(null);
  return {
    state: "aborted",
    runToken: context.runToken,
    documentToken: DOCUMENT_TOKEN
  };
}

function detailImageIdentities(state) {
  const identities = [];
  const add = (value) => {
    const identity = String(value || "").trim();
    if (/^https?:\/\//i.test(identity) && !identities.includes(identity)) identities.push(identity);
  };
  for (const image of allVisible("img", state.scope)) {
    add(image.currentSrc || image.getAttribute("src"));
  }
  return {
    identities,
    identityComplete: identities.length === state.count
  };
}

function readDetailState() {
  const state = inspectDetailState();
  const images = detailImageIdentities(state);
  return {
    count: state.count,
    counterText: state.counterText,
    scoped: state.scoped,
    ...images
  };
}

const PRODUCT_EDITOR_RUNTIME_HANDLERS = Object.freeze({
  read_detail_state: async () => readDetailState(),
  clear_detail: removeDefaultDetail,
  upload_detail: uploadDetail,
  import_specification: importSpecification,
  append_specifications_using_workbook: appendSpecificationsUsingWorkbook,
  create_specification_group: createSpecificationGroup,
  create_specification_step: createSpecificationStep,
  fill_sku_row: fillSkuRow,
  replace_sku_image: replaceSkuImage,
  set_batch_stock: setBatchStock,
  verify_sku_stock: verifySkuStock
});

globalThis.DoudianProductEditorRuntime = Object.freeze({
  commands: Object.freeze(Object.keys(PRODUCT_EDITOR_RUNTIME_HANDLERS)),
  documentToken: DOCUMENT_TOKEN,
  async execute(command, args, callerContext = {}) {
    const handler = PRODUCT_EDITOR_RUNTIME_HANDLERS[command];
    if (!handler) {
      throw new PageCommandError(
        "PRODUCT_EDITOR_RUNTIME_COMMAND_NOT_ALLOWED",
        "商品编辑页面能力不在共享白名单",
        { command }
      );
    }
    const runToken = String(callerContext.runToken || "");
    if (runToken.length < 8 || runToken.length > 256) {
      throw new PageCommandError(
        "PRODUCT_EDITOR_RUNTIME_RUN_TOKEN_INVALID",
        "商品编辑页面能力缺少有效运行令牌"
      );
    }
    if (abortedRunToken === runToken) {
      throw new PageCommandError("RUN_ABORTED", "该运行已终止", {
        runToken
      });
    }
    if (activeRunToken && activeRunToken !== runToken) {
      throw new PageCommandError(
        "PRODUCT_EDITOR_RUNTIME_BUSY",
        "当前商品编辑页正由其他运行使用",
        { activeRunToken, receivedRunToken: runToken }
      );
    }
    if (!activeRunToken) {
      fillingCheckEvidence = null;
      activeExpectedSpecs = null;
      activeOptionalMediaPlan = Object.create(null);
    }
    activeRunToken = runToken;
    return handler(args || {}, {
      runToken,
      documentToken: DOCUMENT_TOKEN,
      onIdentifyDispatch: typeof callerContext.onIdentifyDispatch === "function"
        ? callerContext.onIdentifyDispatch
        : null
    });
  },
  abort(runToken) {
    if (activeRunToken && activeRunToken !== runToken) {
      throw new PageCommandError(
        "PRODUCT_EDITOR_RUNTIME_BUSY",
        "不能终止其他运行占用的商品编辑页",
        { activeRunToken, receivedRunToken: runToken }
      );
    }
    abortedRunToken = runToken;
    activeRunToken = null;
    fillingCheckEvidence = null;
    activeExpectedSpecs = null;
    activeOptionalMediaPlan = Object.create(null);
    return { state: "aborted", runToken, documentToken: DOCUMENT_TOKEN };
  }
});

const COMMAND_HANDLERS = Object.freeze({
  observe: async () => pageEvidence(),
  upload_main: uploadMain,
  upload_auxiliary: uploadAuxiliary,
  set_title_and_infer_category: setTitleAndSelectManualCategory,
  click_next: clickNext,
  assert_full_form: async () => assertFullForm(),
  set_short_title_and_brand: setShortTitleAndBrand,
  remove_default_detail: removeDefaultDetail,
  upload_detail: uploadDetail,
  upload_optional_media: uploadOptionalMedia,
  set_fulfillment: async (args) => setFulfillment(args),
  import_specification: importSpecification,
  create_specification_group: createSpecificationGroup,
  create_specification_step: createSpecificationStep,
  fill_sku_row: fillSkuRow,
  set_batch_stock: setBatchStock,
  verify_sku_stock: verifySkuStock,
  set_inventory_deduction: async (args) => setInventoryDeduction(args),
  test_after_sale: testAfterSale,
  set_service_terms: setServiceTerms,
  run_filling_check: runFillingCheck,
  assert_review_ready: async (args) => assertReviewReady(args),
  abort: async (args, context) => abortRun(context)
});

async function executePageCommand(message) {
  commandSequence += 1;
  const command = commandName(message);
  const startedAt = performance.now();
  const shop = assertPageIdentity();
  const context = assertCommandEnvelope(message, command);
  const stateBefore = assertExpectedPageState(command, message);
  const args = commandArguments(message);
  const result = await COMMAND_HANDLERS[command](args, context, message);
  const shopAfter = assertPageIdentity();
  if (normalizeText(shopAfter) !== normalizeText(shop)) {
    throw new PageCommandError(
      "SHOP_IDENTITY_CHANGED",
      "命令执行期间店铺身份发生变化",
      { before: shop, after: shopAfter }
    );
  }
  assertRunStillActive(command === "abort" ? null : context.runToken);
  const stateAfter = detectPageState();
  return {
    command,
    buildId: EXECUTOR_BUILD_ID,
    commandSequence,
    runToken: context.runToken,
    documentToken: DOCUMENT_TOKEN,
    shop: shopAfter,
    stateBefore,
    stateAfter,
    elapsedMs: Math.round(performance.now() - startedAt),
    result
  };
}

function commandReceiptEnvelope(message, command) {
  return {
    commandId: message?.commandId,
    argsDigest: message?.argsDigest,
    command,
    runToken: readMessageToken(message, [
      "runToken",
      "runId",
      "executionToken"
    ]),
    documentToken:
      readMessageToken(message, ["documentToken", "documentId", "pageToken"]) ||
      DOCUMENT_TOKEN
  };
}

function commandFailureResponse(message, error, receipt = null) {
  let page;
  try {
    page = pageEvidence();
  } catch (pageError) {
    page = {
      origin: location.origin,
      route: location.pathname,
      inspectionError: pageError.message,
      inspectionErrorCode: pageError.code || null
    };
  }
  return {
    ok: false,
    error: error.message,
    errorCode: error.code || "PAGE_COMMAND_FAILED",
    evidence: {
      command: commandName(message),
      buildId: EXECUTOR_BUILD_ID,
      documentToken: DOCUMENT_TOKEN,
      shop: page.shop ?? null,
      ...(error.evidence || {}),
      ...(receipt ? { receipt } : {}),
      page
    }
  };
}

async function dispatchPageCommand(message) {
  const command = commandName(message);
  let claim;
  try {
    claim = commandReceiptJournal.begin(
      commandReceiptEnvelope(message, command)
    );
  } catch (error) {
    return commandFailureResponse(message, error);
  }
  if (claim.kind === "replay") return claim.response;
  if (claim.kind === "running") {
    return commandFailureResponse(
      message,
      new PageCommandError(
        "COMMAND_IN_FLIGHT",
        "该命令仍在当前页面执行中",
        { receipt: claim.receipt }
      )
    );
  }

  try {
    const evidence = await executePageCommand(message);
    return commandReceiptJournal.finish(
      claim,
      "succeeded",
      (receipt) => ({
        ok: true,
        evidence: {
          ...evidence,
          ...(receipt ? { receipt } : {})
        }
      })
    );
  } catch (error) {
    return commandReceiptJournal.finish(
      claim,
      "failed",
      (receipt) => commandFailureResponse(message, error, receipt)
    );
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!PAGE_COMMAND_MESSAGE_ALIASES.has(message?.type)) return false;
  const command = commandName(message);
  dispatchPageCommand(message)
    .then((response) => {
      sendResponse(response);
      if (response.ok && command === "assert_review_ready") {
        activeRunToken = null;
      }
    })
    .catch((error) => {
      sendResponse(commandFailureResponse(message, error));
    });
  return true;
});
