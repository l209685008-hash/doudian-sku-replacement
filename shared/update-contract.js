(function initializeUpdateContract(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DoudianUpdateContract = api;
})(globalThis, function createUpdateContract() {
  "use strict";

  const MESSAGE_TYPE = "DOUDIAN_UPDATE_PAGE_COMMAND";
  const STORAGE_KEY = "doudianUpdateDryRunLedger";
  const PUBLISH_STORAGE_KEY = "doudianUpdatePublishLedger";
  const RECOVERY_SCHEMA_VERSION = 1;
  const LIST_RECEIVER_FILES = Object.freeze([
    "shared/build-info.js",
    "shared/update-contract.js",
    "update-content-script.js"
  ]);
  const EDITOR_RUNTIME_FILES = Object.freeze([
    "shared/build-info.js",
    "shared/binary-payload.js",
    "shared/upload-state.js",
    "shared/media-contract.js",
    "shared/sku-contract.js",
    "content-script.js"
  ]);
  const EDITOR_RECEIVER_FILES = Object.freeze([
    ...EDITOR_RUNTIME_FILES,
    "shared/update-contract.js",
    "update-content-script.js"
  ]);
  const COMMANDS = Object.freeze({
    OBSERVE_LIST: "observe_list",
    SEARCH_LIST: "search_list",
    NEXT_PAGE: "next_page",
    GO_PAGE: "go_page",
    OPEN_EDIT: "open_edit",
    READ_STRUCTURE: "read_structure",
    LOCATE_WASH_LINK_ROW: "locate_wash_link_row",
    READ_REPLACE_GROUP: "read_replace_group",
    DELETE_SPEC_GROUP: "delete_spec_group",
    DELETE_SPEC_VALUE: "delete_spec_value",
    WASH_LINK: "wash_link",
    REPLACE_SKU_IMAGE: "replace_sku_image",
    CREATE_SPECIFICATION_GROUP: "create_specification_group",
    CREATE_SPECIFICATION_STEP: "create_specification_step",
    FILL_SKU_ROW: "fill_sku_row",
    SET_BATCH_STOCK: "set_batch_stock",
    VERIFY_SKU_STOCK: "verify_sku_stock",
    PUBLISH_PRODUCT: "publish_product",
    ABORT: "abort"
  });
  const COMMAND_ALLOWLIST = new Set(Object.values(COMMANDS));
  const STAGES = Object.freeze([
    "idle", "material_ready", "collecting_filtered_products", "batch_frozen",
    "resolving_edit_entry", "structure_ready", "executing", "paused", "failed"
  ]);
  const IMAGE_EXTENSION = /\.(?:jpe?g|png|webp)$/i;
  const SPECIFICATION_TYPES = Object.freeze(["规格", "商品规格"]);
  const SPECIFICATION_TYPE_PLACEHOLDERS = Object.freeze({
    "规格": "请输入规格",
    "商品规格": "请输入商品规格"
  });
  const SPECIFICATION_VALUE_INPUT_SELECTOR = SPECIFICATION_TYPES
    .map((type) => `input[placeholder="${SPECIFICATION_TYPE_PLACEHOLDERS[type]}"]`)
    .join(",");
  const MUTATIONS = new Set([
    COMMANDS.DELETE_SPEC_GROUP,
    COMMANDS.DELETE_SPEC_VALUE,
    COMMANDS.WASH_LINK,
    COMMANDS.REPLACE_SKU_IMAGE,
    COMMANDS.CREATE_SPECIFICATION_GROUP,
    COMMANDS.CREATE_SPECIFICATION_STEP,
    COMMANDS.FILL_SKU_ROW,
    COMMANDS.SET_BATCH_STOCK,
    COMMANDS.PUBLISH_PRODUCT,
    COMMANDS.ABORT
  ]);

  function fail(code, message, evidence) {
    const error = new Error(message);
    error.code = code;
    error.evidence = evidence || null;
    throw error;
  }

  function compareText(value) {
    return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
  }

  function washLinkModelKey(value) {
    // Bracketed text is a display label and is synchronized separately. It
    // must never change the model identity used for matching.
    const source = compareText(value).replace(/【[^】]*】/g, "").replace(/[×xX]/g, "*");
    const size = source.match(/(\d+(?:\.\d+)?)\s*\*\s*(\d+(?:\.\d+)?)/);
    const sheets = source.match(/(\d+)\s*张/);
    const rolls = source.match(/(\d+)\s*卷(?:\s*\/\s*箱)?/);
    if (!size || !sheets || !rolls) {
      const missing = [
        !size ? "尺寸（如 40*30）" : "",
        !sheets ? "张数（如 800张）" : "",
        !rolls ? "卷数/箱规（如 45卷/箱）" : ""
      ].filter(Boolean);
      fail("UPDATE_WASH_LINK_MODEL_KEY_INVALID", `SKU 型号“${compareText(value)}”缺少${missing.join("、")}，不能安全匹配。`, {
        specification: value,
        normalizedSpecification: source,
        missing
      });
    }
    const rowCount = /三排/.test(source) ? "三排" : /双排/.test(source) ? "双排" : "单排";
    const baseColor = /蓝底/.test(source) ? "蓝底" : /白底/.test(source) ? "白底" : "未标注底";
    return `${size[1]}*${size[2]}|${rowCount}|${sheets[1]}张|${baseColor}|${rolls[1]}卷/箱`;
  }

  function washLinkBase(value) {
    return washLinkModelKey(value);
  }

  function washLinkExistingKey(value) {
    // Every model dimension is part of SKU identity. Bracketed labels are
    // synchronized separately, but row count and base color must not collapse
    // distinct SKUs into the same replacement pair.
    return washLinkModelKey(value);
  }

  function washLinkExistingFieldsMatch(current, target) {
    const currentPriceText = compareText(current?.price);
    const targetPriceText = compareText(target?.price);
    const currentPrice = Number(currentPriceText);
    const targetPrice = Number(targetPriceText);
    const samePrice = currentPriceText && targetPriceText && Number.isFinite(currentPrice) && Number.isFinite(targetPrice)
      ? currentPrice === targetPrice
      : currentPriceText === targetPriceText;
    return samePrice && compareText(current?.merchantCode) === compareText(target?.merchantCode);
  }

  function planWashLinkRows(currentRows, targetRows) {
    const prepare = (rows, source, { allowInvalid = false } = {}) => Array.from(rows || []).map((row, index) => {
      const specification = compareText(row?.specification);
      let base = "";
      let modelKeyError = null;
      try {
        if (specification) base = washLinkExistingKey(specification);
      } catch (caught) {
        modelKeyError = caught;
      }
      if ((!specification || !base) && !allowInvalid) {
        if (modelKeyError) throw modelKeyError;
        fail("UPDATE_WASH_LINK_BASE_KEY_EMPTY", `${source}第 ${index + 1} 行缺少可匹配的规格尺寸。`, { source, index, specification });
      }
      return Object.freeze({ row, index, specification, base, modelKeyError });
    });
    // A malformed existing row cannot match any Excel model safely; classify it
    // as retired so the final off-sale phase handles it without blocking all work.
    const current = prepare(currentRows, "现有 SKU", { allowInvalid: true });
    const target = prepare(targetRows, "新材料");
    const usedCurrent = new Set();
    const matchedTarget = new Set();
    const matched = [];

    const indexBy = (entries, key) => {
      const index = new Map();
      for (const entry of entries) {
        const value = entry[key];
        const queue = index.get(value) || [];
        queue.push(entry);
        index.set(value, queue);
      }
      return index;
    };
    const currentByBase = indexBy(current.filter((entry) => entry.base), "base");
    const takeCurrent = (index, key) => {
      const queue = index.get(key) || [];
      while (queue.length && usedCurrent.has(queue[0].index)) queue.shift();
      return queue[0] || null;
    };

    // Pair every repeated model by page order. Text inside 【】 is a label,
    // not identity; exact-text preference would incorrectly reorder duplicates.
    for (const targetEntry of target) {
      if (matchedTarget.has(targetEntry.index)) continue;
      const currentEntry = takeCurrent(currentByBase, targetEntry.base);
      if (!currentEntry) continue;
      usedCurrent.add(currentEntry.index);
      matchedTarget.add(targetEntry.index);
      matched.push(Object.freeze({
        current: currentEntry.row,
        target: targetEntry.row,
        currentIndex: currentEntry.index,
        targetIndex: targetEntry.index,
        mode: currentEntry.specification === targetEntry.specification ? "exact" : "base"
      }));
    }
    return Object.freeze({
      matched: Object.freeze(matched),
      added: Object.freeze(target.filter((entry) => !matchedTarget.has(entry.index)).map((entry) => entry.row)),
      retired: Object.freeze(current.filter((entry) => !usedCurrent.has(entry.index)).map((entry) => entry.row))
    });
  }

  function missingWashLinkMatchedSkuIds(matchedRows, phase) {
    if (phase === "add") return Object.freeze([]);
    const invalidIds = new Set(["", "-", "—", "–", "未知", "无"]);
    return Object.freeze(Array.from(matchedRows || [])
      .map((entry) => Object.freeze({
        specification: compareText(entry?.current?.specification),
        skuId: compareText(entry?.current?.skuId)
      }))
      .filter((entry) => invalidIds.has(entry.skuId)));
  }

  function reconcileWashLinkCheckpoint(checkpoint, currentRows) {
    const plan = checkpoint?.plan;
    if (!plan || !Array.isArray(plan.matched) || !Array.isArray(plan.retired)) {
      return Object.freeze({ safeToReset: false, differences: Object.freeze(["断点缺少可核对的原始 SKU 清单"]) });
    }
    const plannedRows = [
      ...plan.matched.map((entry) => entry?.current),
      ...plan.retired
    ];
    const baseline = plannedRows.filter(Boolean);
    const observed = Array.from(currentRows || []);
    const baselineIds = baseline.map((row) => compareText(row?.skuId));
    const observedIds = observed.map((row) => compareText(row?.skuId));
    const differences = [];
    if (baseline.length !== plannedRows.length) differences.push("断点中的原始 SKU 行不完整");
    if (baselineIds.some((id) => !id) || new Set(baselineIds).size !== baselineIds.length) {
      differences.push("断点中的 SKU ID 缺失或重复");
    }
    if (observedIds.some((id) => !id) || new Set(observedIds).size !== observedIds.length) {
      differences.push("当前 SKU ID 缺失或重复");
    }
    if (baseline.length !== observed.length) differences.push(`SKU 数量不同（原 ${baseline.length}，现 ${observed.length}）`);
    const observedById = new Map(observedIds.map((id, index) => [id, observed[index]]));
    for (const original of baseline) {
      const skuId = compareText(original?.skuId);
      const row = observedById.get(skuId);
      if (!row) {
        differences.push(`SKU ${skuId || "未知"} 不存在或身份变化`);
        continue;
      }
      let sameModel = false;
      try {
        sameModel = washLinkExistingKey(row.specification) === washLinkExistingKey(original.specification);
      } catch (_) {}
      if (!sameModel) differences.push(`SKU ${skuId} 规格型号维度已变化`);
      const originalPriceText = compareText(original.price).replace(/,/g, "");
      const observedPriceText = compareText(row.price).replace(/,/g, "");
      const originalPrice = Number(originalPriceText);
      const observedPrice = Number(observedPriceText);
      const samePrice = originalPriceText && observedPriceText && Number.isFinite(originalPrice) && Number.isFinite(observedPrice)
        ? originalPrice === observedPrice
        : originalPriceText === observedPriceText;
      if (!samePrice) differences.push(`SKU ${skuId} 价格已变化`);
      if (compareText(row.merchantCode) !== compareText(original.merchantCode)) differences.push(`SKU ${skuId} 商家编码已变化`);
    }
    const baselineIdSet = new Set(baselineIds);
    for (const skuId of observedIds) {
      if (skuId && !baselineIdSet.has(skuId)) differences.push(`发现原清单外 SKU ${skuId}`);
    }
    return Object.freeze({ safeToReset: differences.length === 0, differences: Object.freeze(differences) });
  }

  function washLinkPendingAdditionRecovery(checkpoint, targetKey, target, state, targetsByKey) {
    const plan = checkpoint?.plan;
    const rows = Array.isArray(state?.skuRows) ? state.skuRows : [];
    const editorSpecs = Array.from(state?.editorSpecs || []).map((row) => compareText(row?.specification));
    const targetSpec = compareText(target?.specification);
    const manual = () => Object.freeze({ action: "manual_check" });
    if (!targetSpec || !plan || !Array.isArray(plan.matched) || !Array.isArray(plan.retired) ||
        state?.scanComplete !== true || state?.skuScanComplete !== true || Number(state?.dimensionCount) !== 1) return manual();

    const baselineRows = [
      ...plan.matched.map((entry) => entry?.current),
      ...plan.retired
    ].filter(Boolean);
    const baselineIds = new Set(baselineRows.map((row) => compareText(row?.skuId)).filter(Boolean));
    if (baselineIds.size !== baselineRows.length) return manual();
    const claimed = new Map();
    for (const [key, value] of Object.entries(checkpoint.added || {})) {
      if (key === targetKey || !value || typeof value !== "object") continue;
      const skuId = compareText(value.skuId);
      if (!skuId) {
        if (value.appendDispatched === true) return manual();
        continue;
      }
      const expected = targetsByKey?.get?.(key);
      if (!expected) return manual();
      claimed.set(skuId, compareText(expected.specification));
    }

    const matchingRows = rows.filter((row) => compareText(row?.specification) === targetSpec);
    const reconciled = matchingRows.filter((row) => {
      const skuId = compareText(row?.skuId);
      return skuId && !baselineIds.has(skuId) && !claimed.has(skuId);
    });
    if (reconciled.length === 1 && matchingRows.length === 1) {
      return Object.freeze({ action: "reconciled", skuId: compareText(reconciled[0].skuId) });
    }
    if (matchingRows.length > 0) return manual();
    if (editorSpecs.includes(targetSpec)) return Object.freeze({ action: "editor_committed" });

    const rowsById = new Map();
    for (const row of rows) {
      const skuId = compareText(row?.skuId);
      if (!skuId || rowsById.has(skuId)) return manual();
      rowsById.set(skuId, row);
    }
    const expectedIds = new Set([...baselineIds, ...claimed.keys()]);
    if (rowsById.size !== expectedIds.size || [...rowsById.keys()].some((skuId) => !expectedIds.has(skuId))) return manual();
    for (const original of baselineRows) {
      const live = rowsById.get(compareText(original.skuId));
      if (!live || washLinkExistingKey(live.specification) !== washLinkExistingKey(original.specification)) return manual();
    }
    for (const [skuId, specification] of claimed) {
      const live = rowsById.get(skuId);
      if (!live || compareText(live.specification) !== specification) return manual();
    }
    return Object.freeze({ action: "safe_to_retry" });
  }

  function reconcileWashLinkEditorAdditions(baselineSpecifications, liveSpecifications, additions) {
    const countValues = (values) => {
      const counts = new Map();
      for (const value of values || []) {
        const normalized = compareText(value);
        if (normalized) counts.set(normalized, (counts.get(normalized) || 0) + 1);
      }
      return counts;
    };
    const baseline = countValues(baselineSpecifications);
    const live = countValues(liveSpecifications);
    const expected = new Map(baseline);
    const seenKeys = new Set();
    const seenSpecifications = new Set();
    const actions = [];
    const fail = (reason) => Object.freeze({ safeToContinue: false, reason, additions: Object.freeze([]) });

    for (const addition of additions || []) {
      const key = compareText(addition?.key);
      const specification = compareText(addition?.specification);
      if (!key || !specification || seenKeys.has(key) || seenSpecifications.has(specification)) return fail("addition_identity_invalid");
      seenKeys.add(key);
      seenSpecifications.add(specification);
      if ((baseline.get(specification) || 0) > 0) return fail("addition_already_in_baseline");
      const liveCount = live.get(specification) || 0;
      if (liveCount > 1 || (addition.fieldsComplete === true && liveCount !== 1) || (addition.skuId && liveCount === 0)) {
        return fail("addition_presence_ambiguous");
      }
      if (liveCount === 1) expected.set(specification, 1);
      actions.push(Object.freeze({ key, action: liveCount === 1 ? "editor_committed" : "safe_to_retry" }));
    }

    const allSpecifications = new Set([...expected.keys(), ...live.keys()]);
    for (const specification of allSpecifications) {
      if ((expected.get(specification) || 0) !== (live.get(specification) || 0)) return fail("editor_specifications_drifted");
    }
    return Object.freeze({ safeToContinue: true, additions: Object.freeze(actions) });
  }

  function canResetWashLinkPendingAddCheckpoint(checkpoint, liveSpecifications, liveSkuRows) {
    const plan = checkpoint?.plan;
    const additions = Object.values(checkpoint?.added || {});
    if (checkpoint?.blocked !== true || checkpoint.blockedPhase !== "add" || !plan ||
        !Array.isArray(plan.matched) || !Array.isArray(plan.retired) ||
        additions.some((entry) => !entry || entry.fieldsComplete === true || compareText(entry.skuId))) return false;

    const baselineRows = [...plan.matched.map((entry) => entry?.current), ...plan.retired].filter(Boolean);
    const baselineIds = baselineRows.map((row) => compareText(row?.skuId)).filter(Boolean);
    const liveRows = Array.from(liveSkuRows || []);
    const liveIds = liveRows.map((row) => compareText(row?.skuId)).filter(Boolean);
    if (!baselineRows.length || baselineIds.length !== baselineRows.length || new Set(baselineIds).size !== baselineIds.length ||
        liveIds.length !== liveRows.length || new Set(liveIds).size !== liveIds.length ||
        liveRows.length !== baselineRows.length || baselineIds.some((skuId) => !liveIds.includes(skuId))) return false;

    const baselineById = new Map(baselineRows.map((row) => [compareText(row.skuId), row]));
    const liveById = new Map(liveRows.map((row) => [compareText(row.skuId), row]));
    for (const [skuId, original] of baselineById) {
      const live = liveById.get(skuId);
      let sameModel = false;
      try {
        sameModel = Boolean(live) && washLinkExistingKey(live.specification) === washLinkExistingKey(original.specification);
      } catch (_) {
        sameModel = Boolean(live) && compareText(live.specification) === compareText(original.specification);
      }
      if (!sameModel) return false;
    }

    const countModels = (values) => {
      const counts = new Map();
      for (const value of values || []) {
        let key;
        try {
          key = `model:${washLinkExistingKey(value)}`;
        } catch (_) {
          key = `raw:${compareText(value)}`;
        }
        if (key === "raw:") return null;
        try {
          counts.set(key, (counts.get(key) || 0) + 1);
        } catch (_) { return null; }
      }
      return counts;
    };
    const baselineModels = countModels(baselineRows.map((row) => row.specification));
    const liveModels = countModels(liveSpecifications);
    if (!baselineModels || !liveModels || baselineModels.size !== liveModels.size) return false;
    return [...baselineModels].every(([key, count]) => liveModels.get(key) === count);
  }

  function canRebaseWashLinkPendingAddCheckpoint(checkpoint, currentState) {
    if (checkpoint?.blocked !== true || checkpoint.blockedPhase !== "add" ||
        currentState?.scanComplete !== true || currentState?.skuScanComplete !== true || Number(currentState.dimensionCount) !== 1 ||
        !Array.isArray(currentState.skuRows) || !Array.isArray(currentState.editorSpecs)) return false;
    const additions = Object.values(checkpoint.added || {});
    if (additions.some((entry) => {
      const saved = entry && typeof entry === "object" ? entry : { skuId: entry };
      return saved.fieldsComplete === true || Boolean(compareText(saved.skuId));
    })) return false;

    const rows = currentState.skuRows;
    const rowIds = rows.map((row) => compareText(row?.skuId));
    if (rowIds.some((skuId) => !skuId) || new Set(rowIds).size !== rowIds.length) return false;
    const countSpecifications = (values) => {
      const counts = new Map();
      for (const value of values) {
        const specification = compareText(value);
        if (!specification) return null;
        counts.set(specification, (counts.get(specification) || 0) + 1);
      }
      return counts;
    };
    const rowSpecifications = countSpecifications(rows.map((row) => row?.specification));
    const editorSpecifications = countSpecifications(currentState.editorSpecs.map((row) => row?.specification));
    if (!rowSpecifications || !editorSpecifications || rowSpecifications.size !== editorSpecifications.size) return false;
    return [...rowSpecifications].every(([specification, count]) => editorSpecifications.get(specification) === count);
  }

  function washLinkFinalSpecificationState(expectedSpecifications, observedSpecifications) {
    const countValues = (values) => {
      const counts = new Map();
      for (const value of values || []) {
        const normalized = compareText(value);
        if (normalized) counts.set(normalized, (counts.get(normalized) || 0) + 1);
      }
      return counts;
    };
    const expected = countValues(expectedSpecifications);
    const observed = countValues(observedSpecifications);
    const same = expected.size === observed.size && [...expected].every(([specification, count]) => observed.get(specification) === count);
    return Object.freeze({
      committed: same,
      reason: same ? "stable_set" : "specification_set_mismatch"
    });
  }

  function canReconcileLegacyWashLinkCheckpoint(checkpoint, explicitlyConfirmed) {
    return checkpoint?.blocked === true && explicitlyConfirmed === true && checkpoint.plan == null;
  }

  function washLinkCheckpointDisposition(checkpoint, phase) {
    const addedEntries = Object.values(checkpoint.added || {});
    const hasUnsentAddition = addedEntries.some((entry) =>
      entry && typeof entry === "object" && entry.fieldsComplete !== true &&
      entry.appendDispatched === false && !compareText(entry.skuId)
    );
    if (checkpoint?.blocked !== true) {
      return phase === "add" && hasUnsentAddition ? "reset_unsent_add" : "continue";
    }
    const hasPendingDispatchedAddition = addedEntries.some((entry) => {
      if (!entry || typeof entry !== "object" || entry.fieldsComplete === true) return false;
      return entry.appendDispatched === true || Boolean(compareText(entry.skuId));
    });
    const explicitPhase = compareText(checkpoint.blockedPhase);
    const addSpecific = explicitPhase
      ? explicitPhase === "add"
      : checkpoint.blockedCode === "UPDATE_WASH_LINK_APPEND_RECONCILE_REQUIRED" || hasPendingDispatchedAddition;
    if (!addSpecific) return "reconcile";
    if (phase === "modify") return "continue_other_phase";
    return hasPendingDispatchedAddition ? "reconcile_add" : "reset_unsent_add";
  }

  function washLinkDisplayKey(value) {
    return compareText(value)
      .replace(/【[^】]*】/g, "")
      .replace(/[×xX]/g, "*")
      .replace(/\s+/g, "");
  }

  function planWashLinkReview(currentRows, targetRows) {
    const current = Array.from(currentRows || []);
    const target = Array.from(targetRows || []);
    const planned = planWashLinkRows(current, target);
    const matchedByIndex = new Map(planned.matched.map((entry) => [entry.currentIndex, entry]));
    const reviewRows = current.map((row, index) => {
      const match = matchedByIndex.get(index);
      if (!match) {
        return Object.freeze({
          order: index,
          status: "待删除",
          skuId: compareText(row?.skuId),
          current: row,
          target: null,
          specificationSame: false,
          priceSame: false,
          merchantCodeSame: false
        });
      }
      const targetRow = match.target;
      const specificationSame = washLinkDisplayKey(row?.specification) === washLinkDisplayKey(targetRow?.specification);
      const priceSame = Number(row?.price) === Number(targetRow?.price);
      const merchantCodeSame = compareText(row?.merchantCode) === compareText(targetRow?.merchantCode);
      return Object.freeze({
        order: index,
        // Bracketed labels and specification text stay exactly as they are on
        // the page. Only price and merchant code participate in wash-link
        // changes for an existing SKU.
        status: priceSame && merchantCodeSame ? "未修改" : "修改",
        skuId: compareText(row?.skuId),
        current: row,
        target: targetRow,
        specificationSame,
        priceSame,
        merchantCodeSame
      });
    });
    const additions = planned.added.map((row, index) => Object.freeze({
      order: reviewRows.length + index,
      status: "新增",
      skuId: "",
      current: null,
      target: row,
      specificationSame: false,
      priceSame: false,
      merchantCodeSame: false
    }));
    return Object.freeze({
      rows: Object.freeze([...reviewRows, ...additions]),
      matched: planned.matched,
      added: planned.added,
      retired: planned.retired
    });
  }

  function planStockAdjustment(currentValue, targetValue) {
    const currentText = String(currentValue ?? "").replace(/,/g, "").trim();
    const targetText = String(targetValue ?? "").replace(/,/g, "").trim();
    const current = Number(currentText);
    const target = Number(targetText);
    if (!currentText || !targetText || !/^\d+$/.test(currentText) || !/^\d+$/.test(targetText) || !Number.isInteger(current) || current < 0 || !Number.isInteger(target) || target < 0) {
      fail("UPDATE_STOCK_VALUE_INVALID", "库存必须是大于或等于 0 的整数。", { currentValue, targetValue });
    }
    if (current === target) return Object.freeze({ action: "none", amount: 0, current, target });
    return Object.freeze({ action: target > current ? "increase" : "decrease", amount: Math.abs(target - current), current, target });
  }

  function parseListPaginationSummary(value) {
    const source = compareText(value).replace(/,/g, "");
    const total = Number((source.match(/(?:共|总计)\s*(\d+)\s*(?:条|个|件|商品)?/) || [])[1]);
    const pageSize = Number((
      source.match(/每页\s*(\d+)/) ||
      source.match(/(\d+)\s*(?:条|个|件)?\s*\/\s*页/) ||
      source.match(/(\d+)\s*(?:条|个|件)?\s*每页/)
    )?.[1]);
    return Number.isInteger(total) && total > 0 && Number.isInteger(pageSize) && pageSize > 0
      ? Object.freeze({ total, pageSize })
      : null;
  }

  function isProductManagementListUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.origin === "https://fxg.jinritemai.com" && /^\/ffa\/g\/list\/?$/i.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function describeMaterialReadFailure(caught) {
    const message = String(caught?.message || caught || "");
    if (caught?.name === "NotFoundError" || /requested file or directory could not be found/i.test(message)) {
      return "无法读取拖入的文件，请重新拖入两份 Excel 文件后重试。";
    }
    return message || "材料读取失败，请重新投放后重试。";
  }

  function describeMaterialFailure(caught) {
    const code = String(caught?.code || "");
    const issueCode = String(caught?.evidence?.issues?.find((issue) => issue?.severity === "error")?.code || "");
    const message = describeMaterialReadFailure(caught);
    if (caught?.name === "NotFoundError" || Number(caught?.code) === 8) {
      return Object.freeze({ category: "文件读取", message });
    }
    if (/^UPDATE_SKU_IMAGE|^SKU_IMAGE_|^SKU_SPECIFICATION_/.test(code) || /^SKU_IMAGE_|^SKU_SPECIFICATION_/.test(issueCode)) {
      return Object.freeze({ category: "SKU 图片命名或匹配", message: "请检查 SKU 图片名称、重复图片和规格匹配。" });
    }
    if (/^UPDATE_(?:NO_TARGET_MATERIAL|MULTIPLE_PRODUCT_MATERIAL_PLANS|WORKBOOK_AMBIGUOUS|PRICE_INVENTORY_MATERIALS_PARTIAL|MATERIAL_NESTING_INVALID|MATERIAL_FILE_TYPE_INVALID)/.test(code)) {
      return Object.freeze({ category: "文件夹或文件", message: "请检查文件夹层级，以及两份 Excel 是否齐全。" });
    }
    if (/^UPDATE_WORKBOOK|工作表|表头|第\d+行|抖音标价|库存列|规格表|规格价格表/.test(`${code} ${message}`)) {
      return Object.freeze({
        category: "表格内容",
        message: `请检查两个 Excel 的工作表、表头和行数据。\n具体原因：${message}`
      });
    }
    return Object.freeze({ category: "材料检查", message });
  }

  function assertSpecificationType(value) {
    const normalized = compareText(value);
    if (!SPECIFICATION_TYPES.includes(normalized)) {
      fail("UPDATE_SPECIFICATION_TYPE_INVALID", "商品规格类型名称必须精确为“规格”或“商品规格”。", {
        actual: value ?? null,
        accepted: SPECIFICATION_TYPES,
        dispatched: false
      });
    }
    return normalized;
  }

  function specificationValuePlaceholder(value) {
    return SPECIFICATION_TYPE_PLACEHOLDERS[assertSpecificationType(value)];
  }

  function specificationTypeForPlaceholder(value) {
    const match = SPECIFICATION_TYPES.find((type) => SPECIFICATION_TYPE_PLACEHOLDERS[type] === value);
    if (!match) {
      fail("UPDATE_SPECIFICATION_PLACEHOLDER_INVALID", "规格输入框 placeholder 不属于受控的规格类型。", {
        actual: value ?? null,
        accepted: Object.values(SPECIFICATION_TYPE_PLACEHOLDERS),
        dispatched: false
      });
    }
    return match;
  }

  function stableDigest(value) {
    const canonical = (input) => {
      if (Array.isArray(input)) return input.map(canonical);
      if (input && typeof input === "object") {
        return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]));
      }
      return input === undefined ? null : input;
    };
    const source = JSON.stringify(canonical(value));
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
    }
    return `update-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function createProductPublishArgs(details) {
    const productId = String(details?.productId || "");
    const planDigest = String(details?.planDigest || "");
    const mode = String(details?.mode || "");
    const actionCount = Number(details?.actionCount);
    const acceptedModes = ["replace", "offsale", "image-swap"];
    const mutationReceipts = Array.from(details?.mutationReceipts || [], (receipt) => Object.freeze({
      commandId: String(receipt?.commandId || ""),
      argsDigest: String(receipt?.argsDigest || "")
    }));
    if (!/^\d{8,}$/.test(productId) || !planDigest || !acceptedModes.includes(mode) ||
      !Number.isSafeInteger(actionCount) || actionCount < 1 || mutationReceipts.length < 1 ||
      mutationReceipts.some((receipt) => !receipt.commandId || !receipt.argsDigest) ||
      new Set(mutationReceipts.map((receipt) => receipt.commandId)).size !== mutationReceipts.length) {
      fail("UPDATE_PUBLISH_ARGS_INVALID", "发布参数必须绑定商品、计划以及至少一个已完成修改回执。", {
        productId, planDigest, mode, actionCount, receiptCount: mutationReceipts.length, dispatched: false
      });
    }
    const base = Object.freeze({
      productId,
      planDigest,
      mode,
      actionCount,
      mutationReceipts: Object.freeze(mutationReceipts)
    });
    return Object.freeze({
      ...base,
      intentDigest: stableDigest({ productId, planDigest, mode }),
      modificationDigest: stableDigest(base)
    });
  }

  function planSpecificationStep({ expectedSpecs, index, observedFilled, emptyCount, allowMultipleEmpty = false }) {
    const expected = Array.from(expectedSpecs || []).map(compareText);
    const filled = Array.from(observedFilled || []).map(compareText);
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0 || position >= expected.length || expected.some((value) => !value) || new Set(expected).size !== expected.length) {
      fail("UPDATE_SPEC_STEP_PLAN_INVALID", "规格步骤计划无效。", { expectedSpecs, index });
    }
    if (filled.length !== position || filled.some((value, itemIndex) => value !== expected[itemIndex])) {
      fail("UPDATE_SPEC_STEP_PREFIX_MISMATCH", "已填写规格不是冻结计划的连续前缀。", { expected, index: position, observedFilled: filled });
    }
    if (allowMultipleEmpty ? Number(emptyCount) < 1 : Number(emptyCount) !== 1) {
      fail("UPDATE_SPEC_STEP_EMPTY_INPUT_AMBIGUOUS", allowMultipleEmpty ? "当前未找到可继续填写的空规格输入框。" : "当前必须恰好有一个空的规格输入框。", {
        emptyCount,
        allowMultipleEmpty
      });
    }
    return Object.freeze({ index: position, specification: expected[position] });
  }

  function resumeSpecificationDecision({ expectedSpecs, observedFilled }) {
    const expected = Array.from(expectedSpecs || []).map(compareText);
    const filled = Array.from(observedFilled || []).map(compareText);
    if (expected.length === 0 || expected.some((value) => !value) || new Set(expected).size !== expected.length) {
      fail("UPDATE_CURRENT_RESUME_PLAN_INVALID", "续跑所用的 Excel 规格计划无效。", { expectedSpecs });
    }
    const prefixMatches = filled.length <= expected.length &&
      filled.every((value, index) => value === expected[index]);
    if (!prefixMatches) {
      fail("UPDATE_CURRENT_RESUME_PREFIX_MISMATCH", "当前编辑页已填写规格与 Excel 的连续开头不一致，未继续填写。", {
        expected,
        observedFilled: filled
      });
    }
    return Object.freeze({ completedCount: filled.length, nextIndex: filled.length });
  }

  function parseOffsaleSpecifications(value) {
    const specifications = String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (specifications.length === 0) {
      fail("UPDATE_OFFSALE_SPEC_REQUIRED", "请至少输入一个要下架的规格，每行一个。", {});
    }
    const normalized = specifications.map(compareText);
    const duplicates = normalized.filter((item, index) => normalized.indexOf(item) !== index);
    if (duplicates.length) {
      fail("UPDATE_OFFSALE_SPEC_DUPLICATE", "下架规格存在重复项，请删除重复行后重试。", { duplicates: [...new Set(duplicates)] });
    }
    return Object.freeze(specifications);
  }

  function specValueDeletionDecision(target, observedSpecifications) {
    const normalizedTarget = compareText(target);
    if (!normalizedTarget) fail("UPDATE_OFFSALE_SPEC_REQUIRED", "下架规格不能为空。", {});
    const matches = Array.from(observedSpecifications || []).filter((item) => compareText(item) === normalizedTarget);
    if (matches.length > 1) {
      fail("UPDATE_SPEC_VALUE_MATCH_AMBIGUOUS", `规格“${target}”在编辑器中匹配到多个值，未点击删除。`, {
        specification: target,
        matchCount: matches.length
      });
    }
    return Object.freeze(matches.length === 0
      ? { state: "absent", specification: target }
      : { state: "unique", specification: matches[0] });
  }

  function naturalCompare(left, right) {
    return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
  }

  function relativeParts(file) {
    const raw = String(file?.webkitRelativePath || file?.relativePath || file?.name || "")
      .normalize("NFKC")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
    const parts = raw.split("/").filter(Boolean);
    if (parts.length > 1 && parts[0] !== "图文信息") parts.shift();
    return parts;
  }

  function isIgnoredFile(name) {
    return /^~\$/i.test(name) || /^(?:\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(name);
  }

  function filterUpdateMaterialFiles(files) {
    return Object.freeze(Array.from(files || []).filter((file) => !isIgnoredFile(String(file?.name || ""))));
  }

  function updateMaterialParts(file) {
    return String(file?.webkitRelativePath || file?.relativePath || file?.name || "")
      .normalize("NFKC").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  }

  function sourceFile(file) {
    return file?.originalFile || file;
  }

  function classifyUpdateMaterials(fileList) {
    const plans = new Map();
    for (const file of Array.from(fileList || [])) {
      const parts = updateMaterialParts(file);
      const name = parts.at(-1) || "";
      if (!name || isIgnoredFile(name)) continue;
      const skuIndex = parts.findIndex((part, index) => part === "图文信息" && String(parts[index + 1] || "").toLocaleLowerCase() === "sku");
      const workbook = /规格价格表\.xlsx$/i.test(name) ? "price" : /规格\.xlsx$/i.test(name) ? "specification" : null;
      if (!workbook && skuIndex < 0) continue; // Main images, details, titles and other Create materials never authorize Update.
      const rootParts = workbook ? parts.slice(0, -1) : parts.slice(0, skuIndex);
      const root = rootParts.join("/") || ".";
      const plan = plans.get(root) || { root, specificationWorkbooks: [], priceWorkbooks: [], skuImages: [] };
      plans.set(root, plan);
      if (workbook) {
        plan[workbook === "price" ? "priceWorkbooks" : "specificationWorkbooks"].push(file);
        continue;
      }
      if (parts.length !== skuIndex + 3) {
        fail("UPDATE_MATERIAL_NESTING_INVALID", "SKU 目录只允许直接放置图片，不能包含子目录。", { path: parts.join("/") });
      }
      if (!IMAGE_EXTENSION.test(name)) {
        fail("UPDATE_MATERIAL_FILE_TYPE_INVALID", `SKU 目录包含不支持的文件“${name}”。`, { path: parts.join("/") });
      }
      plan.skuImages.push(file);
    }
    if (plans.size === 0) fail("UPDATE_NO_TARGET_MATERIAL", "未发现可用的价格库存或 SKU 图片材料。", {});
    if (plans.size !== 1) {
      fail("UPDATE_MULTIPLE_PRODUCT_MATERIAL_PLANS", "BLOCK：一次只能选择一个明确的商品材料目录，当前检测到多个商品材料计划。", { roots: [...plans.keys()] });
    }
    const plan = plans.values().next().value;
    const hasPriceMaterials = plan.specificationWorkbooks.length > 0 || plan.priceWorkbooks.length > 0;
    if (hasPriceMaterials && (plan.specificationWorkbooks.length !== 1 || plan.priceWorkbooks.length !== 1)) {
      const duplicate = plan.specificationWorkbooks.length > 1 || plan.priceWorkbooks.length > 1;
      fail(duplicate ? "UPDATE_WORKBOOK_AMBIGUOUS" : "UPDATE_PRICE_INVENTORY_MATERIALS_PARTIAL", "BLOCK：价格库存必须恰好包含一份规格工作簿和一份规格价格工作簿。", {
        root: plan.root, specificationCount: plan.specificationWorkbooks.length, priceCount: plan.priceWorkbooks.length, skuImageCount: plan.skuImages.length
      });
    }
    plan.skuImages.sort((left, right) => naturalCompare(left.name, right.name));
    return Object.freeze({
      materialRoot: plan.root,
      priceInventory: hasPriceMaterials
        ? Object.freeze({
          intent: "replace_group",
          specificationWorkbook: sourceFile(plan.specificationWorkbooks[0]),
          priceWorkbook: sourceFile(plan.priceWorkbooks[0]),
          skuImages: Object.freeze(plan.skuImages.map(sourceFile))
        })
        : Object.freeze({ intent: "skip", skuImages: Object.freeze(plan.skuImages.map(sourceFile)) })
    });
  }

  function extractProductId(value) {
    const match = compareText(value).match(/\bID\s*:\s*(\d{8,})/i);
    return match ? match[1] : null;
  }

  function isScrollableContainer(metrics) {
    const overflowY = String(metrics?.overflowY || "").toLocaleLowerCase();
    const scrollHeight = Number(metrics?.scrollHeight);
    const clientHeight = Number(metrics?.clientHeight);
    return ["auto", "scroll", "overlay", "hidden"].includes(overflowY) &&
      Number.isFinite(scrollHeight) && Number.isFinite(clientHeight) &&
      scrollHeight > clientHeight + 2;
  }

  function classifyTransportError(caught) {
    const message = String(caught?.message || caught || "");
    if (/Could not establish connection|Receiving end does not exist/i.test(message)) {
      return Object.freeze({
        code: "UPDATE_CONTENT_SCRIPT_NOT_READY",
        message: "当前抖店页面尚未加载新版插件接收端；不会读取或修改商品，请刷新页面后重试。"
      });
    }
    return null;
  }

  function receiverBootstrapFiles(command, caught) {
    if (classifyTransportError(caught)?.code !== "UPDATE_CONTENT_SCRIPT_NOT_READY") return null;
    if ([COMMANDS.OBSERVE_LIST, COMMANDS.SEARCH_LIST].includes(command)) return LIST_RECEIVER_FILES;
    if ([COMMANDS.READ_STRUCTURE, COMMANDS.LOCATE_WASH_LINK_ROW, COMMANDS.READ_REPLACE_GROUP, COMMANDS.WASH_LINK].includes(command)) return EDITOR_RECEIVER_FILES;
    return null;
  }

  function buildMismatchRecoveryFiles(command) {
    if ([COMMANDS.OBSERVE_LIST, COMMANDS.SEARCH_LIST].includes(command)) return LIST_RECEIVER_FILES;
    return null;
  }

  function recoveryDecision(snapshot, planDigest, buildId) {
    const checkpoint = snapshot?.checkpoint;
    if (!checkpoint) return Object.freeze({ exists: false, allowed: false, code: "UPDATE_RECOVERY_NOT_FOUND" });
    const products = Array.from(checkpoint.products || []);
    const nextIndex = Number(checkpoint.nextIndex);
    const ids = products.map((product) => String(product?.productId || ""));
    const completed = Array.from(checkpoint.completedProductIds || []).map(String);
    const completedSessions = Array.from(checkpoint.completedSessions || []);
    const expectedCompleted = products.slice(0, nextIndex).map((product) => String(product.productId));
    const valid = checkpoint.schemaVersion === RECOVERY_SCHEMA_VERSION &&
      products.length > 0 && ids.every(Boolean) && new Set(ids).size === ids.length &&
      Number.isInteger(nextIndex) && nextIndex >= 0 && nextIndex <= products.length &&
      completed.length === expectedCompleted.length && completed.every((id, index) => id === expectedCompleted[index]) &&
      completedSessions.length === expectedCompleted.length && completedSessions.every((session, index) => {
        if (String(session?.productId || "") !== expectedCompleted[index] || !Number.isInteger(session?.tabId)) return false;
        if (session?.tabClosed === true) {
          return session?.publishStatus === "confirmed_success" &&
            Boolean(session?.intentDigest) && Boolean(session?.modificationDigest);
        }
        return Boolean(session?.documentToken);
      });
    if (!valid) return Object.freeze({ exists: true, allowed: false, code: "UPDATE_RECOVERY_CHECKPOINT_INVALID" });
    if (nextIndex >= products.length || snapshot.stage === "complete") {
      return Object.freeze({ exists: false, allowed: false, code: "UPDATE_RECOVERY_ALREADY_COMPLETE" });
    }
    if (buildId && String(checkpoint.buildId || "") !== String(buildId)) {
      return Object.freeze({ exists: true, allowed: false, code: "UPDATE_RECOVERY_BUILD_MISMATCH", nextIndex, remainingCount: products.length - nextIndex });
    }
    if (checkpoint.retrySafety !== "safe_retry" || checkpoint.mutationStarted === true || checkpoint.outcomeUnknown === true) {
      return Object.freeze({ exists: true, allowed: false, code: "UPDATE_RECOVERY_MANUAL_RECONCILE_REQUIRED", nextIndex, remainingCount: products.length - nextIndex });
    }
    if (!planDigest) {
      return Object.freeze({ exists: true, allowed: false, code: "UPDATE_RECOVERY_MATERIAL_REQUIRED", nextIndex, remainingCount: products.length - nextIndex });
    }
    if (String(checkpoint.planDigest || "") !== String(planDigest)) {
      return Object.freeze({ exists: true, allowed: false, code: "UPDATE_RECOVERY_PLAN_MISMATCH", nextIndex, remainingCount: products.length - nextIndex });
    }
    return Object.freeze({ exists: true, allowed: true, code: "UPDATE_RECOVERY_READY", nextIndex, remainingCount: products.length - nextIndex });
  }

  function assertRecoveryFrozenMatch(checkpoint, actual) {
    const expectedProducts = Array.from(checkpoint?.products || []).map((product) => ({
      productId: String(product?.productId || ""), pageNo: Number(product?.pageNo)
    }));
    const actualProducts = Array.from(actual?.entries || []).map((product) => ({
      productId: String(product?.productId || ""), pageNo: Number(product?.pageNo)
    }));
    const same = String(checkpoint?.filterUrl || "") === String(actual?.filterUrl || "") &&
      Number(checkpoint?.total) === Number(actual?.total) && Number(checkpoint?.pageCount) === Number(actual?.pageCount) &&
      stableDigest(expectedProducts) === stableDigest(actualProducts);
    if (!same) {
      fail("UPDATE_RECOVERY_FILTER_DRIFT", "当前筛选结果与中断批次不一致，不能自动恢复。请恢复原筛选条件后重试。", {
        expectedFilterUrl: checkpoint?.filterUrl || null,
        actualFilterUrl: actual?.filterUrl || null,
        expectedCount: expectedProducts.length,
        actualCount: actualProducts.length
      });
    }
    return true;
  }

  function freezeFilteredProducts(snapshot, previous) {
    const entries = snapshot?.entries || [];
    const ids = entries.map((entry) => String(entry.productId || ""));
    if (!snapshot?.filterUrl || !Number.isInteger(snapshot?.total) || snapshot.total < 0 || !Number.isInteger(snapshot?.pageCount) || snapshot.pageCount < 1) {
      fail("UPDATE_FILTER_SNAPSHOT_INVALID", "无法稳定读取当前商品筛选范围。", snapshot);
    }
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length || entries.length !== snapshot.total) {
      fail("UPDATE_FILTER_SNAPSHOT_DRIFT", "筛选结果的商品数量或商品 ID 已漂移，请重新读取。", { total: snapshot.total, ids });
    }
    if (previous && (previous.filterUrl !== snapshot.filterUrl || previous.total !== snapshot.total || previous.pageCount !== snapshot.pageCount)) {
      fail("UPDATE_FILTER_SNAPSHOT_DRIFT", "筛选条件或分页摘要发生变化，请重新读取。", { before: previous, after: snapshot });
    }
    return Object.freeze({
      ...snapshot,
      entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry, productId: String(entry.productId) })))
    });
  }

  function createMessage(runToken, command, args, documentToken, receipt) {
    if (!COMMAND_ALLOWLIST.has(command)) throw new Error(`Update command is not allowlisted: ${command}`);
    if (!runToken) throw new TypeError("runToken is required.");
    if (![COMMANDS.OBSERVE_LIST, COMMANDS.READ_STRUCTURE, COMMANDS.LOCATE_WASH_LINK_ROW, COMMANDS.READ_REPLACE_GROUP].includes(command) && !documentToken) {
      throw new TypeError("documentToken is required.");
    }
    const identity = {};
    if (MUTATIONS.has(command)) {
      identity.argsDigest = String(receipt?.argsDigest || stableDigest(args || {}));
      identity.commandId = String(receipt?.commandId || stableDigest({ runToken: String(runToken), command, argsDigest: identity.argsDigest }));
    }
    return Object.freeze({
      type: MESSAGE_TYPE,
      runToken: String(runToken),
      command,
      args,
      ...(documentToken ? { documentToken } : {}),
      ...identity
    });
  }

  return Object.freeze({
    COMMANDS,
    COMMAND_ALLOWLIST,
    EDITOR_RECEIVER_FILES,
    EDITOR_RUNTIME_FILES,
    LIST_RECEIVER_FILES,
    buildMismatchRecoveryFiles,
    MESSAGE_TYPE,
    PUBLISH_STORAGE_KEY,
    RECOVERY_SCHEMA_VERSION,
    STAGES,
    STORAGE_KEY,
    SPECIFICATION_TYPES,
    SPECIFICATION_TYPE_PLACEHOLDERS,
    SPECIFICATION_VALUE_INPUT_SELECTOR,
    assertSpecificationType,
    classifyTransportError,
    classifyUpdateMaterials,
    compareText,
    createProductPublishArgs,
    createMessage,
    describeMaterialFailure,
    describeMaterialReadFailure,
    assertRecoveryFrozenMatch,
    extractProductId,
    filterUpdateMaterialFiles,
    freezeFilteredProducts,
    isProductManagementListUrl,
    isScrollableContainer,
    parseOffsaleSpecifications,
    parseListPaginationSummary,
    planWashLinkRows,
    missingWashLinkMatchedSkuIds,
    reconcileWashLinkCheckpoint,
    washLinkPendingAdditionRecovery,
    reconcileWashLinkEditorAdditions,
    canResetWashLinkPendingAddCheckpoint,
    canRebaseWashLinkPendingAddCheckpoint,
    washLinkFinalSpecificationState,
    canReconcileLegacyWashLinkCheckpoint,
    washLinkCheckpointDisposition,
    planWashLinkReview,
    planStockAdjustment,
    washLinkModelKey,
    washLinkExistingKey,
    washLinkExistingFieldsMatch,
    washLinkDisplayKey,
    planSpecificationStep,
    recoveryDecision,
    receiverBootstrapFiles,
    resumeSpecificationDecision,
    specValueDeletionDecision,
    specificationTypeForPlaceholder,
    specificationValuePlaceholder,
    stableDigest
  });
});
