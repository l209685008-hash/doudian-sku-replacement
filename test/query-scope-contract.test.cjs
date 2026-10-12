"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const contract = require(path.join(root, "shared", "update-contract.js"));
const skuPlanner = require(path.join(root, "shared", "sku-image-plan.js"));
const preflight = require(path.join(root, "shared", "preflight.js"));
const ui = fs.readFileSync(path.join(root, "update-ui.js"), "utf8");
const receiver = fs.readFileSync(path.join(root, "update-content-script.js"), "utf8");
const editor = fs.readFileSync(path.join(root, "content-script.js"), "utf8");
const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");

test("query command is allowlisted, document-bound, and not mutation-receipted", () => {
  assert.equal(contract.COMMANDS.SEARCH_LIST, "search_list");
  assert.equal(contract.COMMAND_ALLOWLIST.has(contract.COMMANDS.SEARCH_LIST), true);
  assert.throws(
    () => contract.createMessage("update-test-token", contract.COMMANDS.SEARCH_LIST, { query: "123" }),
    /documentToken is required/
  );
  const message = contract.createMessage("update-test-token", contract.COMMANDS.SEARCH_LIST, { query: "123" }, "document-token");
  assert.equal(message.commandId, undefined);
  assert.equal(message.argsDigest, undefined);
});

test("build-mismatch recovery never reinjects the editor content script into a live document", () => {
  assert.equal(typeof contract.buildMismatchRecoveryFiles, "function");
  assert.equal(contract.buildMismatchRecoveryFiles(contract.COMMANDS.READ_STRUCTURE), null);
  assert.deepEqual(
    contract.buildMismatchRecoveryFiles(contract.COMMANDS.OBSERVE_LIST),
    contract.LIST_RECEIVER_FILES
  );
  assert.match(ui, /contract\.buildMismatchRecoveryFiles\(message\.command\)/);
});

test("query scope reads the current list before searching and then freezes the result", () => {
  assert.match(ui, /let initial = await send\(listTab\.id, contract\.COMMANDS\.OBSERVE_LIST\);\s*if \(scope === "query"\) \{[\s\S]*?contract\.COMMANDS\.SEARCH_LIST[\s\S]*?\}\s*listDocumentToken = initial\.documentToken;[\s\S]*?collectFiltered\(listTab, initial\)/);
  assert.match(ui, /const scope = resume \? "batch" : selectedReplaceScope\(\);/);
});

test("page query uses the merchant input and an exact visible query button", () => {
  assert.match(receiver, /PRODUCT_QUERY_PLACEHOLDER/);
  assert.match(receiver, /text\(node\) === "查询"/);
  assert.match(receiver, /waitForListSearch\(query, input\)/);
});

test("replace modules expose SKU images and retain the existing image replacement path", () => {
  assert.match(html, /id="updateSkuImagesEnabled"/);
  assert.match(ui, /function selectedReplaceModules\(\)/);
  assert.match(ui, /skuImages = await freezeSkuImagePlan\(replaceSkuImageFiles\)/);
  assert.match(ui, /executeImageSwapRows\(editTab, documentToken, product\.productId, pageImageSwapPlan\(initial, plan\.skuImages\)\)/);
});

test("wash-link mode uses an in-place command and keeps retired SKU rows for manual review", () => {
  assert.equal(contract.COMMANDS.WASH_LINK, "wash_link");
  assert.equal(contract.COMMAND_ALLOWLIST.has(contract.COMMANDS.WASH_LINK), true);
  const message = contract.createMessage(
    "update-test-token",
    contract.COMMANDS.WASH_LINK,
    { productId: "123456789", rows: [] },
    "document-token"
  );
  assert.match(message.commandId, /^update-/);
  assert.match(message.argsDigest, /^update-/);
  assert.match(receiver, /message\.command === api\.COMMANDS\.WASH_LINK/);
  assert.match(receiver, /retired_pending_manual|UPDATE_WASH_LINK/);
  assert.match(receiver, /washLinkBase\(value\)/);
  assert.match(contract.washLinkModelKey.toString(), /双排/);
  assert.match(contract.washLinkModelKey.toString(), /三排/);
  assert.match(contract.washLinkModelKey.toString(), /蓝底/);
  assert.match(receiver, /customSortButton\(\)/);
  assert.match(ui, /washLink: updateSubmode === "wash"/);
  assert.match(ui, /phase: options\.washPhase/);
  assert.match(receiver, /必须手动选择“新增”或“修改”阶段后才能执行/);
  assert.match(ui, /新增与修改没有固定先后顺序/);
  assert.match(ui, /state: washingLink && receipt\.workflowComplete === false \? "phase_pending" : "replace_completed"/);
  assert.match(html, /id="washAddButton"/);
  assert.match(html, /id="washModifyButton"/);
  assert.match(ui, /洗链接已完成，请到右侧手动点击自定义排序，调整 SKU 顺序后手动保存/);
  assert.doesNotMatch(ui, /updateSubmode === "wash"[\s\S]{0,500}DELETE_SPEC_GROUP/);
});

test("wash-link pairs repeated model keys one-to-one in page order", () => {
  const plan = contract.planWashLinkRows(
    [
      { specification: "【旧款 A】60*40*800张*45卷/箱", skuId: "sku-a" },
      { specification: "【旧款 B】60*40*800张*45卷/箱", skuId: "sku-b" },
      { specification: "【保留】80*50*800张*45卷/箱", skuId: "sku-c" }
    ],
    [
      { specification: "【新款 A】60*40*800张*45卷/箱" },
      { specification: "【新款 B】60*40*800张*45卷/箱" },
      { specification: "【保留】80*50*800张*45卷/箱" }
    ]
  );
  assert.deepEqual(
    plan.matched.map(({ current, target, mode }) => [current.skuId, target.specification, mode]),
    [
      ["sku-a", "【新款 A】60*40*800张*45卷/箱", "base"],
      ["sku-b", "【新款 B】60*40*800张*45卷/箱", "base"],
      ["sku-c", "【保留】80*50*800张*45卷/箱", "exact"]
    ]
  );
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.retired, []);
});

test("wash-link repeated models always follow page order even when labels exactly match later rows", () => {
  const plan = contract.planWashLinkRows(
    [
      { specification: "【旧 A】40*30*800张*40卷/箱", skuId: "sku-a" },
      { specification: "【旧 B】40*30*800张*40卷/箱", skuId: "sku-b" }
    ],
    [
      { specification: "【旧 B】40*30*800张*40卷/箱" },
      { specification: "【新 A】40*30*800张*40卷/箱" }
    ]
  );
  assert.deepEqual(plan.matched.map(({ current, target, currentIndex, targetIndex }) => [current.skuId, target.specification, currentIndex, targetIndex]), [
    ["sku-a", "【旧 B】40*30*800张*40卷/箱", 0, 0],
    ["sku-b", "【新 A】40*30*800张*40卷/箱", 1, 1]
  ]);
});

test("wash-link model key keeps size, row count, sheet count, base color, and rolls distinct", () => {
  assert.equal(contract.washLinkModelKey("【高清三防横版】40*30*800张*45卷/箱"), "40*30|单排|800张|未标注底|45卷/箱");
  assert.equal(contract.washLinkModelKey("【标签】40*30*800张*45卷/箱 双排 蓝底"), "40*30|双排|800张|蓝底|45卷/箱");
  assert.equal(contract.washLinkModelKey("【白底】40*30*800张*45卷/箱"), contract.washLinkModelKey("【蓝底】40*30*800张*45卷/箱"));
  assert.notEqual(contract.washLinkModelKey("【标签】40*30*2500张*45卷/箱 三排"), contract.washLinkModelKey("40*30*800张*45卷/箱"));
  assert.notEqual(contract.washLinkModelKey("40*30*800张*12卷/箱"), contract.washLinkModelKey("40*30*800张*45卷/箱"));
  assert.notEqual(contract.washLinkExistingKey("【标签】40*30*800张*45卷/箱 单排 白底"), contract.washLinkExistingKey("【标签】40*30*800张*45卷/箱 三排 蓝底"));
});

test("wash-link existing matching keeps row count and base color distinct", () => {
  const plan = contract.planWashLinkRows(
    [{ specification: "【旧标签】40*30*800张*45卷/箱 双排 蓝底", skuId: "old-sku" }],
    [{ specification: "【新标签】40*30*800张*45卷/箱 三排 白底", price: "10", stock: "999", merchantCode: "new" }]
  );
  assert.equal(plan.matched.length, 0);
  assert.equal(plan.added.length, 1);
  assert.equal(plan.retired.length, 1);
});

test("wash-link add phase does not require IDs for matched old rows, but modify phase does", () => {
  const matched = [
    { current: { skuId: "", specification: "【旧】40*30*800张*45卷/箱" } },
    { current: { skuId: "sku-valid", specification: "【旧】50*40*800张*45卷/箱" } }
  ];
  assert.deepEqual(contract.missingWashLinkMatchedSkuIds(matched, "add"), []);
  assert.deepEqual(contract.missingWashLinkMatchedSkuIds(matched, "modify"), [
    { specification: "【旧】40*30*800张*45卷/箱", skuId: "" }
  ]);
  const washLinkSource = receiver.slice(receiver.indexOf("async function washLink(message)"), receiver.indexOf("\n  function publishButton()"));
  assert.match(washLinkSource, /api\.missingWashLinkMatchedSkuIds\(matched, phase\)/);
  assert.match(ui, /operationPhase: message\.args\?\.phase/);
  assert.match(ui, /missingSkus: Array\.isArray\(error\.evidence\?\.missingSkus\)/);
  assert.match(ui, /appendObservedSpecifications: error\.evidence\?\.observedSpecifications/);
  assert.match(ui, /appendVisibleControls: error\.evidence\?\.visibleControlSignals/);
});

test("wash-link keeps existing SKU specifications unchanged", () => {
  const washLinkSource = receiver.slice(receiver.indexOf("async function washLink(message)"), receiver.indexOf("\n  function publishButton()"));
  assert.match(washLinkSource, /const calculatedPlan = api\.planWashLinkRows/);
  assert.match(washLinkSource, /for \(const \{ current: existing, target \} of matched\)/);
  assert.match(washLinkSource, /setWashLinkExistingFieldsBySkuId/);
  assert.doesNotMatch(washLinkSource, /commitWashLinkSpecificationInput\(input\)/);
});

test("wash-link never synchronizes an existing SKU specification or bracket label", () => {
  const washLinkSource = receiver.slice(receiver.indexOf("async function washLink(message)"), receiver.indexOf("\n  function publishButton()"));
  assert.match(washLinkSource, /setWashLinkExistingFieldsBySkuId\(panel, columns, existingSkuId, target, skuLocator\)/);
  assert.doesNotMatch(washLinkSource, /washLinkSpecificationWithExcelLabel\(/);
  assert.doesNotMatch(washLinkSource, /renameWashLinkSkuById\(/);
  assert.doesNotMatch(washLinkSource, /labelSyncPending/);
  assert.doesNotMatch(washLinkSource, /setWashLinkStockBySkuId\(panel, columns, existingSkuId/);
});

test("wash-link planner indexes exact and base specification keys before pairing", () => {
  assert.match(contract.planWashLinkRows.toString(), /currentByBase/);
  assert.match(contract.planWashLinkRows.toString(), /takeCurrent/);
});

test("wash-link retires malformed existing SKU rows instead of blocking valid Excel models", () => {
  const plan = contract.planWashLinkRows(
    [{ specification: "旧 SKU 未填写完整", skuId: "bad-sku" }],
    [{ specification: "【新款】40*30*800张*45卷/箱", price: "10", stock: "999", merchantCode: "A" }]
  );
  assert.equal(plan.matched.length, 0);
  assert.equal(plan.added.length, 1);
  assert.deepEqual(plan.retired.map((row) => row.skuId), ["bad-sku"]);
});

test("wash-link changes present stock by delta instead of overwriting the adjustment input", () => {
  assert.deepEqual(contract.planStockAdjustment(998, 999), { action: "increase", amount: 1, current: 998, target: 999 });
  assert.deepEqual(contract.planStockAdjustment(999, 4), { action: "decrease", amount: 995, current: 999, target: 4 });
  assert.deepEqual(contract.planStockAdjustment(4, 4), { action: "none", amount: 0, current: 4, target: 4 });
  assert.throws(() => contract.planStockAdjustment("", 4), /库存必须是/);
  assert.match(receiver, /washLinkDisplayedStock\(cell, specification\)/);
  assert.match(receiver, /actionLabel = adjustment\.action === "increase" \? "增" : "减"/);
  assert.match(receiver, /setInputValue\(amountInput, String\(adjustment\.amount\)\)/);
  assert.match(receiver, /UPDATE_WASH_LINK_STOCK_READBACK_FAILED/);
  assert.match(receiver, /function washLinkNewDisplayedStock\(cell, skuId\)/);
});

test("wash-link commits stock input events before readback only for new SKUs", () => {
  const newStockSource = receiver.slice(receiver.indexOf("async function setWashLinkNewStockBySkuId"), receiver.indexOf("\n  function resolveRenamedWashLinkSkuId("));
  for (const source of [newStockSource]) {
    assert.match(source, /dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/);
    assert.match(source, /dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/);
    assert.match(source, /dispatchEvent\(new Event\("blur", \{ bubbles: true \}\)\)/);
    assert.match(source, /await sleep\(600\)/);
  }
});

test("wash-link updates price and merchant code on old rows, with fixed stock on appended rows", () => {
  assert.match(receiver, /setWashLinkExistingFieldsBySkuId\(panel, columns, existingSkuId, target, skuLocator\)/);
  assert.match(receiver, /setWashLinkNewStockBySkuId\(panel, columns, appendedSkuId, "999", skuLocator\)/);
  const existingFieldsSource = receiver.slice(receiver.indexOf("async function setWashLinkExistingFieldsBySkuId"), receiver.indexOf("\n  async function takeWashLinkOffSale("));
  assert.doesNotMatch(existingFieldsSource, /setWashLinkStockBySkuId/);
  assert.doesNotMatch(existingFieldsSource, /washLinkDisplayedStock/);
  assert.match(existingFieldsSource, /setCell\("merchantCode", target\.merchantCode, "商家编码"\)/);
  assert.match(receiver, /action: "direct"/);
});

test("wash-link exposes independent add and modify phases and keeps manual deletion review", () => {
  assert.match(receiver, /function findWashLinkRowBySkuId\(panel, columns, skuId, skuLocator/);
  assert.match(receiver, /async function setWashLinkExistingFieldsBySkuId\(/);
  assert.match(receiver, /appendWashLinkSpecification[\s\S]*?setWashLinkExistingFieldsBySkuId/);
  assert.match(receiver, /if \(phase !== "add"\) \{/);
  assert.match(receiver, /if \(phase !== "modify"\) for \(const target of added\)/);
  assert.match(receiver, /workflowComplete: false/);
  assert.match(receiver, /phase,\s*matchedCount: matched\.length/);
  assert.match(receiver, /setWashLinkExistingFieldsBySkuId[\s\S]*?retired_pending_manual/);
  assert.doesNotMatch(receiver, /for \(const \{ current: existing, target \} of matched\) changes\.push\(await setWashLinkRowFields/);
});

test("wash-link adds all requested SKU models before filling new SKU fields", () => {
  const washLinkSource = receiver.slice(receiver.indexOf("async function washLink(message)"), receiver.indexOf("\n  function publishButton()"));
  const firstAddLoop = washLinkSource.indexOf('if (phase !== "modify") for (const target of added)');
  const fieldsLoop = washLinkSource.indexOf('if (phase !== "modify") for (const target of added)', firstAddLoop + 1);
  assert.ok(firstAddLoop >= 0 && fieldsLoop > firstAddLoop);
  const modelPhase = washLinkSource.slice(firstAddLoop, fieldsLoop);
  const fieldsPhase = washLinkSource.slice(fieldsLoop, washLinkSource.indexOf("if (phase !== \"modify\") checkpoint.addPhaseComplete", fieldsLoop));
  assert.match(modelPhase, /appendWashLinkSpecification/);
  assert.doesNotMatch(modelPhase, /setNewCell|setWashLinkNewStockBySkuId/);
  assert.match(fieldsPhase, /setNewCell\("price"/);
  assert.match(fieldsPhase, /setWashLinkNewStockBySkuId\(panel, columns, appendedSkuId, "999", skuLocator\)/);
  assert.match(fieldsPhase, /setNewCell\("merchantCode"/);
});

test("wash-link verifies the settled editor once before scanning the price table", () => {
  const washLinkSource = receiver.slice(receiver.indexOf("async function washLink(message)"), receiver.indexOf("\n  function publishButton()"));
  const firstAddLoop = washLinkSource.indexOf('if (phase !== "modify") for (const target of added)');
  const fieldsLoop = washLinkSource.indexOf('if (phase !== "modify") for (const target of added)', firstAddLoop + 1);
  const finalEditorCheck = washLinkSource.indexOf("waitForWashLinkFinalSpecificationEditor(panel, current.specificationType, expectedEditorSpecifications)");
  const tableRead = washLinkSource.indexOf('latestStructure = await waitForWashLinkStable(() => readStructure({ productId }), "全部新增规格提交后读取价格库存表"');
  const modelPhase = washLinkSource.slice(firstAddLoop, finalEditorCheck);
  assert.match(receiver, /async function waitForWashLinkFinalSpecificationEditor\(/);
  assert.doesNotMatch(modelPhase, /waitForWashLinkFinalSpecificationEditor/);
  assert.doesNotMatch(modelPhase, /readStructure\(|waitForWashLinkTargetSpecification\(/);
  assert.ok(finalEditorCheck > firstAddLoop && tableRead > finalEditorCheck && tableRead < fieldsLoop);
  assert.match(washLinkSource, /state\.scanComplete === true && mapNewRows\(state\) !== null/);
  assert.match(washLinkSource, /checkpoint\.added\[targetKey\] = \{ \.\.\.prior, skuId: normalize\(newRowsByTarget\.get\(targetKey\)/);
});

test("wash-link leaves right-side SKU sorting to the operator", () => {
  const washLinkSource = receiver.slice(receiver.indexOf("async function washLink(message)"), receiver.indexOf("\n  function publishButton()"));
  assert.match(washLinkSource, /const customSortActivated = false/);
  assert.match(washLinkSource, /manualSortRequired: true/);
  assert.doesNotMatch(washLinkSource, /dispatchPointerClick\(sort/);
  assert.match(ui, /洗链接已完成，请到右侧手动点击自定义排序，调整 SKU 顺序后手动保存/);
});

test("wash-link shows a panel reminder for right-side manual sorting", () => {
  assert.match(html, /id="washSortReminder"/);
  assert.match(html, /插件不会自动查找或点击排序/);
  assert.match(ui, /const washSortReminder = document\.getElementById\("washSortReminder"\)/);
  assert.match(ui, /washSortReminder\.hidden = mode !== "wash"/);
});

test("wash-link lets either manual phase run first and finalizes only after both", () => {
  const washLinkSource = receiver.slice(receiver.indexOf("async function washLink(message)"), receiver.indexOf("\n  function publishButton()"));
  assert.match(washLinkSource, /let latestStructure = current/);
  assert.doesNotMatch(washLinkSource, /已有 SKU 修改后的价格库存表/);
  assert.doesNotMatch(washLinkSource, /新增 SKU 后的价格库存表/);
  assert.match(washLinkSource, /for \(const target of added\)/);
  assert.match(washLinkSource, /const afterAllFields = await waitForWashLinkStable\(\(\) => readStructure\(\{ productId \}\), "规格、价格和新增后的 SKU 表"\)/);
  assert.match(washLinkSource, /if \(!checkpoint\.addPhaseComplete \|\| !checkpoint\.modifyPhaseComplete\)/);
  assert.match(washLinkSource, /retired_pending_manual/);
  assert.doesNotMatch(washLinkSource, /takeWashLinkOffSaleBySkuId\(panel, columns, row\.skuId/);
  assert.match(ui, /“新增规格”和“修改已有 SKU”可任意顺序分别点击/);
});

test("wash-link keeps the manual-delete review visible without automatic deletion", () => {
  assert.match(receiver, /api\.COMMANDS\.LOCATE_WASH_LINK_ROW/);
  assert.match(receiver, /const tokenOptional = \[[\s\S]*?api\.COMMANDS\.LOCATE_WASH_LINK_ROW[\s\S]*?\]\.includes\(message\.command\)/);
  assert.match(ui, /phase === "manual_deletion"/);
  assert.match(ui, /renderWashReview\(\{ rows: retiredRows \}, product\.productId, \{ phase: "manual_deletion" \}\)/);
  assert.match(ui, /在页面确认后手动点击删除图标/);
  assert.match(ui, /修改完成，请最后手动删除/);
});

test("wash-link identities use SKU IDs for existing rows and new IDs for additions", () => {
  const washLinkSource = receiver.slice(receiver.indexOf("async function washLink(message)"), receiver.indexOf("\n  function publishButton()"));
  assert.match(washLinkSource, /existing\.skuId/);
  assert.match(washLinkSource, /const baselineIds = new Set/);
  assert.match(washLinkSource, /const mapNewRows = \(state\)/);
  assert.match(washLinkSource, /checkpoint\.added\[targetKey\] = \{ \.\.\.prior, skuId: normalize\(newRowsByTarget\.get\(targetKey\)/);
  assert.match(washLinkSource, /findWashLinkRowBySkuId\(panel, columns, appendedSkuId, skuLocator\)/);
});

test("wash-link commits every missing specification before reading the generated SKU table", () => {
  const washLinkSource = receiver.slice(receiver.indexOf("async function washLink(message)"), receiver.indexOf("\n  function publishButton()"));
  const appendStart = washLinkSource.indexOf("// Commit every new model in the specification editor");
  const appendEnd = washLinkSource.indexOf("if (phase !== \"modify\" && added.some");
  const appendPhase = washLinkSource.slice(appendStart, appendEnd);
  assert.ok(appendStart >= 0 && appendEnd > appendStart);
  assert.match(appendPhase, /appendWashLinkSpecification\(panel, current\.specificationType, target/);
  assert.match(appendPhase, /expectedEditorSpecifications = editorSpecificationInputState\(panel, current\.specificationType\)/);
  assert.doesNotMatch(appendPhase, /waitForWashLinkFinalSpecificationEditor/);
  assert.doesNotMatch(appendPhase, /readStructure\(/);
  assert.match(washLinkSource, /runWashLinkStep\(checkpoint, saveCheckpoint, \(\) =>\s*waitForWashLinkFinalSpecificationEditor\(panel, current\.specificationType, expectedEditorSpecifications\), "add"\)/);
  assert.match(washLinkSource, /全部新增规格提交后读取价格库存表/);
  assert.ok(washLinkSource.indexOf("全部新增规格提交后读取价格库存表") < washLinkSource.indexOf("// Fill the newly generated SKU rows"));
  assert.match(washLinkSource, /const mapNewRows = \(state\)/);
  assert.match(washLinkSource, /normalize\(row\.specification\) === normalize\(target\.specification\)/);
  assert.match(washLinkSource, /checkpoint\.blockedCode = "UPDATE_WASH_LINK_APPEND_RECONCILE_REQUIRED";[\s\S]*?outcomeUnknown: true/);
  assert.match(washLinkSource, /商品规格编辑框与原清单不能安全对应/);
  assert.doesNotMatch(washLinkSource, /waitForWashLinkStable\(\(\) => readStructure\(\{ productId \}\), "新增 SKU 表"/);
  assert.match(washLinkSource, /checkpointDisposition === "reconcile_add"[\s\S]*?reconcileWashLinkEditorAdditions\(/);
  assert.match(washLinkSource, /checkpointBaselineSpecs = checkpoint\.plan[\s\S]*?checkpoint\.plan\.matched\.map\(\(entry\) => entry\?\.current\?\.specification\)/);
  assert.match(washLinkSource, /const baselineIds = new Set\(\[[\s\S]*?checkpoint\.plan\?\.matched[\s\S]*?checkpoint\.plan\?\.retired/);
});

test("wash-link verifies all appended specifications only after the editor settles", () => {
  const expected = ["旧规格 A", "旧规格 B", "新增规格 C"];
  assert.deepEqual(
    contract.washLinkFinalSpecificationState(expected, ["旧规格 B", "新增规格 C", "旧规格 A"]),
    { committed: true, reason: "stable_set" }
  );
  assert.deepEqual(
    contract.washLinkFinalSpecificationState(expected, ["旧规格 A", "新增规格 C"]),
    { committed: false, reason: "specification_set_mismatch" }
  );
  assert.deepEqual(
    contract.washLinkFinalSpecificationState(expected, [...expected, "额外规格 D"]),
    { committed: false, reason: "specification_set_mismatch" }
  );
});

test("wash-link resets an unmappable pending-add checkpoint only when the page is unchanged", () => {
  const original = { skuId: "old-1", specification: "【旧】40*30*800张*45卷/箱", price: "10", merchantCode: "A" };
  const checkpoint = {
    blocked: true,
    blockedPhase: "add",
    plan: { matched: [{ current: original }], retired: [] },
    added: { stale: { skuId: "", fieldsComplete: false, appendDispatched: true } }
  };
  assert.equal(contract.canResetWashLinkPendingAddCheckpoint(checkpoint, [original.specification], [original]), true);
  assert.equal(contract.canResetWashLinkPendingAddCheckpoint(checkpoint, [original.specification, "50*40*800张*45卷/箱"], [original]), false);
  assert.equal(contract.canResetWashLinkPendingAddCheckpoint(checkpoint, [original.specification], [original, { skuId: "new-1", specification: "50*40*800张*45卷/箱" }]), false);
  assert.equal(contract.canResetWashLinkPendingAddCheckpoint({ ...checkpoint, added: { stale: { skuId: "new-1", fieldsComplete: false } } }, [original.specification], [original]), false);
  assert.equal(contract.canResetWashLinkPendingAddCheckpoint({ ...checkpoint, added: { stale: { skuId: "", fieldsComplete: true } } }, [original.specification], [original]), false);
  assert.match(receiver, /canResetWashLinkPendingAddCheckpoint\(\s*checkpoint,\s*liveEditorValues,\s*current\.skuRows/);
  assert.match(receiver, /checkpoint\.added = \{\};[\s\S]*?checkpoint\.plan = null;[\s\S]*?checkpoint\.blocked = false/);
  assert.match(ui, /recoveryReason: error\.evidence\?\.recoveryReason/);
});

test("wash-link rebases a stale pending-add checkpoint on a coherent current snapshot", () => {
  const baselineRows = Array.from({ length: 98 }, (_, index) => ({
    skuId: `old-${index}`,
    specification: `${index + 1}0*30*800张*45卷/箱`,
    price: "10",
    merchantCode: `OLD-${index}`
  }));
  const checkpoint = {
    blocked: true,
    blockedPhase: "add",
    plan: { matched: baselineRows.map((current) => ({ current })), retired: [] },
    added: { pending: { skuId: "", fieldsComplete: false, appendDispatched: true } }
  };
  const currentRows = baselineRows.slice(1);
  const coherentSnapshot = {
    scanComplete: true,
    skuScanComplete: true,
    dimensionCount: 1,
    skuRows: currentRows,
    editorSpecs: currentRows.map(({ specification }) => ({ specification }))
  };
  assert.equal(contract.canRebaseWashLinkPendingAddCheckpoint(checkpoint, coherentSnapshot), true);
  assert.equal(contract.canRebaseWashLinkPendingAddCheckpoint(checkpoint, {
    ...coherentSnapshot,
    editorSpecs: coherentSnapshot.editorSpecs.slice(1)
  }), false);
  assert.equal(contract.canRebaseWashLinkPendingAddCheckpoint({
    ...checkpoint,
    added: { pending: { skuId: "new-1", fieldsComplete: false, appendDispatched: true } }
  }, coherentSnapshot), false);
  assert.equal(contract.canRebaseWashLinkPendingAddCheckpoint(checkpoint, {
    ...coherentSnapshot,
    scanComplete: false
  }), false);
  assert.match(receiver, /canRebaseWashLinkPendingAddCheckpoint\(checkpoint, current\)/);
  assert.match(receiver, /if \(!canResetUnsentCheckpoint && !canRebaseStaleCheckpoint\)/);
});

test("wash-link specification commits use the same composed blur events as the working editor flow", () => {
  const commitSource = receiver.slice(receiver.indexOf("async function commitWashLinkSpecificationInput"), receiver.indexOf("\n  function listStateSignature"));
  assert.match(commitSource, /new Event\(type, \{ bubbles: true, composed: true \}\)/);
  assert.match(commitSource, /await sleep\(0\)/);
  assert.match(commitSource, /input\.blur\?\.\(\)/);
  assert.doesNotMatch(commitSource, /KeyboardEvent|key:\s*["']Enter/);
});

test("wash-link waits for the target specification twice without requiring regenerated editor inputs", () => {
  assert.match(receiver, /async function waitForWashLinkTargetSpecification\(/);
  assert.match(receiver, /state\?\.skuScanComplete !== true/);
  assert.match(receiver, /stableCount >= 2/);
  assert.match(receiver, /UPDATE_WASH_LINK_TARGET_SPEC_TIMEOUT/);
  assert.match(receiver, /目标规格“\$\{targetSpecification\}”未出现或未连续两次稳定/);
  assert.match(receiver, /const targetLabel = normalizedPreviousSkuId \? `SKU“\$\{normalizedPreviousSkuId\}”` : "新增 SKU"/);
  assert.match(receiver, /waitForWashLinkTargetSpecification\(readState, \{/);
  assert.match(receiver, /skuScanComplete: scanned\.scanComplete/);
  assert.match(ui, /DOUDIAN_WASH_LINK_TARGET_STABLE_PROGRESS/);
  assert.match(ui, /正在等待目标规格稳定：\$\{message\.targetSpecification\}/);
});

test("wash-link finalization has no pending label-sync state", () => {
  const washLinkSource = receiver.slice(receiver.indexOf("async function washLink(message)"), receiver.indexOf("\n  function publishButton()"));
  assert.match(receiver, /UPDATE_WASH_LINK_TARGET_SPEC_TIMEOUT/);
  assert.match(washLinkSource, /manualReconcileRequired/);
  assert.match(washLinkSource, /if \(!checkpoint\.blocked\) clearWashLinkCheckpoint/);
  assert.doesNotMatch(washLinkSource, /labelSyncPending/);
  assert.doesNotMatch(washLinkSource, /labelSyncOutcomeUnknown/);
});

test("wash-link UI does not expose label-sync warnings", () => {
  assert.doesNotMatch(ui, /labelSyncPending/);
  assert.doesNotMatch(ui, /标签同步/);
  assert.doesNotMatch(ui, /规格需同步/);
  assert.doesNotMatch(ui, /同步【】/);
  assert.match(ui, /outcomeUnknown: priorOutcomeUnknown \|\| receipt\.manualReconcileRequired === true/);
  assert.match(ui, /outcomeUnknown: result\?\.manualReconcileRequired === true/);
  assert.match(ui, /结果未知待检查/);
  assert.match(ui, /核对差异：\$\{caught\.evidence\.differences\.join\("；"\)\}/);
  assert.match(ui, /reconciliationDifferences,/);
  assert.match(ui, /reconciliationDifferenceCount:/);
  assert.match(ui, /旧版本断点没有原始 SKU 清单/);
  assert.match(ui, /reconcileLegacyCheckpoint: true/);
  assert.doesNotMatch(ui, /发布结果未知待检查/);
});

test("wash-link review classifies page-order rows and appends new rows", () => {
  const review = contract.planWashLinkReview([
    { skuId: "old-1", specification: "【旧标签】40*30*800张*45卷/箱", price: "10", merchantCode: "A" },
    { skuId: "old-2", specification: "【旧标签】50*40*800张*45卷/箱", price: "10", merchantCode: "B" },
    { skuId: "old-3", specification: "【旧标签】60*40*800张*45卷/箱", price: "10", merchantCode: "C" }
  ], [
    { specification: "【新标签】40*30*800张*45卷/箱", price: "10", merchantCode: "A" },
    { specification: "【新标签】50*40*800张*45卷/箱", price: "11", merchantCode: "B" },
    { specification: "【新增】70*50*800张*45卷/箱", price: "12", merchantCode: "D" }
  ]);
  assert.deepEqual(review.rows.map((row) => row.status), ["未修改", "修改", "待删除", "新增"]);
  assert.deepEqual(review.rows.map((row) => row.order), [0, 1, 2, 3]);
  assert.equal(review.rows[2].current.specification, "【旧标签】60*40*800张*45卷/箱");
});

test("wash-link review is read-only first and filters rows by status", () => {
  assert.match(ui, /const reviewOnly = washingLink && !pendingWashReview/);
  assert.match(ui, /washReviewPlan\(initial, plan\)/);
  assert.match(ui, /规格清单已就绪：新增和修改可任意顺序手动选择/);
  assert.match(ui, /“新增规格”和“修改已有 SKU”可任意顺序分别点击/);
  assert.match(html, /id="washReview"/);
  assert.match(html, /id="washReviewFilters"/);
  assert.match(ui, /filter\.dataset\.washReviewFilter = statusName/);
  assert.match(ui, /review\.rows\.filter\(\(row\) => row\.status === washReviewFilter\)/);
  assert.match(ui, /再次点击该按钮可显示全部/);
  assert.doesNotMatch(ui, /data-wash-locate/);
});

test("wash-link add button remains clickable and reports unmet prerequisites", () => {
  assert.match(ui, /washAddButton\.disabled = running \|\| addComplete/);
  assert.match(ui, /async function handleWashAddClick\(/);
  assert.match(ui, /新增按钮已触发：正在准备当前商品的/);
  assert.match(ui, /新增规格没有反应：请先重新载入规格 Excel 和价格表材料/);
  assert.match(ui, /if \(washPhase !== "add"\) return/);
  assert.match(ui, /washPhase === "add" && failureView\?\.detail/);
  assert.match(ui, /washAddButton\?\.addEventListener\("click", \(\) => void handleWashAddClick\(\)\)/);
});

test("SKU addition retains only the existing product spec import and price-stock flow", () => {
  assert.equal(html.includes("listingFrame"), false);
  assert.equal(html.includes("上架新商品"), false);
  assert.match(html, /id="washAddButton"[^>]*>按 Excel 上架 SKU/);
  assert.match(ui, /async function handleWashAddClick\([\s\S]*?runCurrentReplace\(\{ washPhase: "add" \}\)/);
  assert.match(receiver, /runtime\.execute\("append_specifications_using_workbook"/);
  assert.match(receiver, /setNewCell\("price", target\.price, "价格"\)/);
  assert.match(receiver, /setWashLinkNewStockBySkuId\(|washLinkNewDisplayedStock\(/);
  assert.doesNotMatch(manifest.content_scripts[0].js.join("\n"), /shared\/run-contract\.js/);
  assert.doesNotMatch(background, /chrome\.runtime\.onConnect\.addListener/);
});

test("wash-link execution reuses the review snapshot and does not rescan before existing edits or additions", () => {
  assert.match(ui, /pendingWashReview = Object\.freeze\(\{ productId: product\.productId, planDigest: plan\.planDigest, review, initialStructure: initial \}\)/);
  assert.match(ui, /const cachedWashReview = washPhase && pendingWashReview\?\.productId === product\.productId[\s\S]*?pendingWashReview\?\.planDigest === plan\.planDigest/);
  assert.match(ui, /const initial = cachedWashReview\?\.initialStructure \|\| \(replacingPriceInventory/);
  assert.match(ui, /reviewStructure: washPhase \? initial\.result : null/);
  assert.match(ui, /if \(options\.reviewStructure\) washArgs\.reviewStructure = options\.reviewStructure/);
  assert.match(receiver, /const suppliedReviewStructure = args\.reviewStructure[\s\S]*?validateWashLinkReviewStructure\(args\.reviewStructure, productId\)/);
  assert.match(receiver, /UPDATE_WASH_LINK_REVIEW_SNAPSHOT_INVALID/);
  assert.match(receiver, /current = suppliedReviewStructure \|\| await readStructure\(\{ productId \}\)/);
  assert.match(receiver, /const suppliedReviewStructure = args\.reviewStructure[\s\S]*?validateWashLinkReviewStructure\(args\.reviewStructure, productId\)/);
  assert.doesNotMatch(receiver, /const beforeAppend = latestStructure/);
  assert.match(receiver, /全部新增规格提交后读取价格库存表/);
});

test("wash-link builds a frozen SKU position map and tries the target segment before full-scan fallback", () => {
  assert.match(receiver, /function createWashLinkSkuLocator\(skuRows\)/);
  assert.match(receiver, /const specificationKeys = new Map\(\)/);
  assert.match(receiver, /skuLocator = createWashLinkSkuLocator\(current\.skuRows\)/);
  assert.match(receiver, /findWashLinkRowBySkuId\(panel, columns, skuId, skuLocator\)/);
  assert.match(receiver, /skuLocator\?\.positions\?\.get\(target\)/);
  assert.match(receiver, /directTargetScroll/);
  assert.match(receiver, /fullScanFallback/);
});

test("wash-link skips old SKU stock and synchronizes merchant code", () => {
  const existingFieldsSource = receiver.slice(receiver.indexOf("async function setWashLinkExistingFieldsBySkuId"), receiver.indexOf("\n  async function takeWashLinkOffSale("));
  assert.doesNotMatch(existingFieldsSource, /setWashLinkStockBySkuId/);
  assert.doesNotMatch(existingFieldsSource, /washLinkDisplayedStock/);
  assert.match(existingFieldsSource, /String\(readback\.merchantCode\) !== String\(target\.merchantCode\)/);
  assert.match(existingFieldsSource, /setCell\("merchantCode", target\.merchantCode/);
  assert.match(receiver, /appendWashLinkSpecification[\s\S]*?setWashLinkNewStockBySkuId\(panel, columns, appendedSkuId, "999", skuLocator\)/);
  assert.doesNotMatch(receiver.slice(receiver.indexOf("async function washLink(message)"), receiver.indexOf("\n  function publishButton()")), /takeWashLinkOffSaleBySkuId/);
});

test("wash-link persists per-SKU checkpoints and blocks replay after unknown outcomes", () => {
  assert.match(receiver, /function loadWashLinkCheckpoint\(productId, argsDigest, targetDigest, legacyArgsDigest\)/);
  assert.match(receiver, /function saveWashLinkCheckpoint\(productId, targetDigest, checkpoint\)/);
  assert.match(receiver, /UPDATE_WASH_LINK_CHECKPOINT_RECONCILE_REQUIRED/);
  assert.match(receiver, /waitForWashLinkStable\(\(\) => readStructure\(\{ productId \}\), "断点核对 SKU 表",/);
  assert.match(receiver, /api\.reconcileWashLinkCheckpoint\(checkpoint, current\.skuRows \|\| \[\]\)/);
  assert.match(receiver, /api\.canReconcileLegacyWashLinkCheckpoint\(checkpoint, args\.reconcileLegacyCheckpoint === true\)/);
  assert.match(receiver, /if \(!reconciliation\.safeToReset && !legacyBaselineConfirmed\)[\s\S]*?clearWashLinkCheckpoint\(productId, targetDigest/);
  assert.match(receiver, /checkpoint\.existingFields\.push\(String\(existingSkuId\)\)/);
  assert.match(receiver, /fieldsComplete: true/);
  assert.match(receiver, /phase: "retired_pending_manual"/);
});

test("wash-link checkpoint disposition isolates add uncertainty from existing-SKU modification", () => {
  const dispatchedAdd = {
    blocked: true,
    blockedCode: "UPDATE_WASH_LINK_APPEND_RECONCILE_REQUIRED",
    blockedPhase: "add",
    added: { target: { skuId: "", fieldsComplete: false, appendDispatched: true } }
  };
  assert.equal(contract.washLinkCheckpointDisposition(dispatchedAdd, "modify"), "continue_other_phase");
  assert.equal(contract.washLinkCheckpointDisposition(dispatchedAdd, "add"), "reconcile_add");

  const unsentAdd = {
    blocked: true,
    blockedCode: "UPDATE_WASH_LINK_APPEND_RECONCILE_REQUIRED",
    blockedPhase: "add",
    added: { target: { skuId: "", fieldsComplete: false, appendDispatched: false } }
  };
  assert.equal(contract.washLinkCheckpointDisposition(unsentAdd, "modify"), "continue_other_phase");
  assert.equal(contract.washLinkCheckpointDisposition(unsentAdd, "add"), "reset_unsent_add");
  assert.equal(contract.washLinkCheckpointDisposition({ blocked: false, added: unsentAdd.added }, "add"), "reset_unsent_add");

  const dispatchedAddFields = {
    blocked: true,
    blockedCode: "UPDATE_WASH_LINK_ROW_READBACK_FAILED",
    blockedPhase: "add",
    added: { target: { skuId: "new-1", fieldsComplete: false, appendDispatched: true } }
  };
  assert.equal(contract.washLinkCheckpointDisposition(dispatchedAddFields, "modify"), "continue_other_phase");
  assert.equal(contract.washLinkCheckpointDisposition(dispatchedAddFields, "add"), "reconcile_add");

  const unknownModify = { blocked: true, blockedCode: "UPDATE_WASH_LINK_ROW_READBACK_FAILED", blockedPhase: "modify" };
  assert.equal(contract.washLinkCheckpointDisposition(unknownModify, "modify"), "reconcile");
  assert.equal(contract.washLinkCheckpointDisposition(unknownModify, "add"), "reconcile");

  assert.match(receiver, /const checkpointDisposition = api\.washLinkCheckpointDisposition\(checkpoint, phase\)/);
  assert.match(receiver, /checkpointDisposition === "reset_unsent_add"[\s\S]*?checkpoint\.plan = null/);
  assert.match(receiver, /checkpoint\.added\[targetKey\] = \{ skuId: "", fieldsComplete: false, appendDispatched: false \}/);
  assert.match(receiver, /checkpoint\.blockedPhase = phase/);
  assert.match(receiver, /appendWashLinkSpecification\(panel, current\.specificationType, target, \(\) => \{[\s\S]*?appendDispatched: true/);
});

test("wash-link checkpoint recovery distinguishes editor-committed, reconciled, and safe-to-retry additions", () => {
  const baseline = { skuId: "old-1", specification: "【旧】40*30*800张*45卷/箱", price: "10", merchantCode: "OLD" };
  const target = { specification: "【新】50*40*800张*45卷/箱", price: "12", stock: "999", merchantCode: "NEW" };
  const checkpoint = {
    blocked: true,
    blockedCode: "UPDATE_WASH_LINK_APPEND_RECONCILE_REQUIRED",
    blockedPhase: "add",
    plan: { matched: [{ current: baseline, targetKey: "old-target" }], retired: [] },
    added: { pending: { skuId: "", fieldsComplete: false, appendDispatched: true } }
  };
  const editor = [{ specification: baseline.specification }];
  const unchanged = { scanComplete: true, skuScanComplete: true, dimensionCount: 1, editorSpecs: editor, skuRows: [baseline] };
  assert.deepEqual(contract.washLinkPendingAdditionRecovery(checkpoint, "pending", target, unchanged), { action: "safe_to_retry" });
  assert.deepEqual(contract.washLinkPendingAdditionRecovery(checkpoint, "pending", target, {
    ...unchanged,
    editorSpecs: [...editor, { specification: target.specification }]
  }), { action: "editor_committed" });
  assert.deepEqual(contract.washLinkPendingAdditionRecovery(checkpoint, "pending", target, {
    ...unchanged,
    editorSpecs: [...editor, { specification: target.specification }],
    skuRows: [...unchanged.skuRows, { skuId: "new-1", specification: target.specification }]
  }), { action: "reconciled", skuId: "new-1" });
  assert.equal(contract.washLinkPendingAdditionRecovery(checkpoint, "pending", target, {
    ...unchanged,
    scanComplete: false
  }).action, "manual_check");
});

test("wash-link resumes a dispatched addition when stable editor state proves the target is absent", () => {
  const recovery = contract.reconcileWashLinkEditorAdditions(
    ["【旧】40*30*800张*45卷/箱"],
    ["【旧】40*30*800张*45卷/箱"],
    [{ key: "pending", specification: "【新】50*40*800张*45卷/箱", appendDispatched: true }]
  );
  assert.deepEqual(recovery, {
    safeToContinue: true,
    additions: [{ key: "pending", action: "safe_to_retry" }]
  });

  assert.equal(contract.reconcileWashLinkEditorAdditions(
    ["【旧】40*30*800张*45卷/箱"],
    ["【旧】40*30*800张*45卷/箱", "【新】50*40*800张*45卷/箱"],
    [{ key: "pending", specification: "【新】50*40*800张*45卷/箱", appendDispatched: true }]
  ).additions[0].action, "editor_committed");
  assert.equal(contract.reconcileWashLinkEditorAdditions(
    ["【旧】40*30*800张*45卷/箱"],
    ["【旧】40*30*800张*45卷/箱", "【误操作】60*40*800张*45卷/箱"],
    [{ key: "pending", specification: "【新】50*40*800张*45卷/箱", appendDispatched: true }]
  ).safeToContinue, false);
});

test("wash-link revalidates checkpointed existing SKU fields from the frozen scan before skipping", () => {
  const target = { price: "116", merchantCode: "SKU-95" };
  assert.equal(contract.washLinkExistingFieldsMatch({ price: "116.00", merchantCode: "SKU-95", stock: "7" }, target), true);
  assert.equal(contract.washLinkExistingFieldsMatch({ price: "101.4", merchantCode: "SKU-95", stock: "7" }, target), false);
  assert.equal(contract.washLinkExistingFieldsMatch({ price: "116", merchantCode: "OLD", stock: "7" }, target), false);
  assert.match(receiver, /const wasCheckpointed = checkpoint\.existingFields\.some/);
  assert.match(receiver, /latestStructure\.skuRows \|\| \[\][\s\S]*?washLinkExistingFieldsMatch/);
  assert.match(receiver, /checkpoint\.existingFields = checkpoint\.existingFields\.filter/);
});

test("wash-link always replans existing rows from the current frozen scan while preserving add checkpoints", () => {
  const targets = [
    { specification: "【A】40*30*800张*45卷/箱", price: "10", stock: "999", merchantCode: "A" },
    { specification: "【B】50*40*800张*45卷/箱", price: "11", stock: "999", merchantCode: "B" }
  ];
  const freshPlan = contract.planWashLinkRows([
    { skuId: "fresh-1", specification: targets[0].specification, price: "8", merchantCode: "old-A" }
  ], targets);
  assert.equal(freshPlan.matched[0].current.skuId, "fresh-1");
  assert.deepEqual(freshPlan.added, [targets[1]]);
  assert.match(receiver, /matched = calculatedPlan\.matched/);
  assert.match(receiver, /savedAdditionKeys[\s\S]*?savedAdditions[\s\S]*?newlyPlannedAdditions/);
  assert.match(receiver, /if \(phase === "add" && missingSavedAdditions\.length\)/);
  assert.doesNotMatch(receiver, /UPDATE_WASH_LINK_CHECKPOINT_PLAN_REBIND_FAILED/);
});

test("wash-link only releases an unknown checkpoint when the current SKU rows exactly match its saved baseline", () => {
  const checkpoint = {
    plan: {
      matched: [{ current: { skuId: "old-1", specification: "【旧】40*30*800张*45卷/箱", price: "10.00", merchantCode: "A" } }],
      retired: [{ skuId: "old-2", specification: "【废弃】50*40*800张*45卷/箱", price: "12", merchantCode: "B" }]
    }
  };
  const unchanged = contract.reconcileWashLinkCheckpoint(checkpoint, [
    { skuId: "old-1", specification: "【旧】40*30*800张*45卷/箱", price: "10", merchantCode: "A" },
    { skuId: "old-2", specification: "【废弃】50*40*800张*45卷/箱", price: "12.00", merchantCode: "B" }
  ]);
  assert.deepEqual(unchanged, { safeToReset: true, differences: [] });
  const changedLabelOnly = contract.reconcileWashLinkCheckpoint(checkpoint, [
    { skuId: "old-1", specification: "【新标签】40*30*800张*45卷/箱", price: "10", merchantCode: "A" },
    { skuId: "old-2", specification: "【废弃】50*40*800张*45卷/箱", price: "12", merchantCode: "B" }
  ]);
  assert.deepEqual(changedLabelOnly, { safeToReset: true, differences: [] });
  const modifiedPrice = contract.reconcileWashLinkCheckpoint(checkpoint, [
    { skuId: "old-1", specification: "【旧】40*30*800张*45卷/箱", price: "11", merchantCode: "A" },
    { skuId: "old-2", specification: "【废弃】50*40*800张*45卷/箱", price: "12", merchantCode: "B" }
  ]);
  assert.equal(modifiedPrice.safeToReset, false);
  assert.match(modifiedPrice.differences.join(" "), /价格/);
  const modifiedSpecification = contract.reconcileWashLinkCheckpoint(checkpoint, [
    { skuId: "old-1", specification: "【新】41*30*800张*45卷/箱", price: "10", merchantCode: "A" },
    { skuId: "old-2", specification: "【废弃】50*40*800张*45卷/箱", price: "12", merchantCode: "B" }
  ]);
  assert.equal(modifiedSpecification.safeToReset, false);
  assert.match(modifiedSpecification.differences.join(" "), /规格型号维度/);
  const modifiedMerchantCode = contract.reconcileWashLinkCheckpoint(checkpoint, [
    { skuId: "old-1", specification: "【旧】40*30*800张*45卷/箱", price: "10", merchantCode: "changed" },
    { skuId: "old-2", specification: "【废弃】50*40*800张*45卷/箱", price: "12", merchantCode: "B" }
  ]);
  assert.equal(modifiedMerchantCode.safeToReset, false);
  assert.match(modifiedMerchantCode.differences.join(" "), /商家编码/);
  const unexpectedNewSku = contract.reconcileWashLinkCheckpoint(checkpoint, [
    { skuId: "old-1", specification: "【旧】40*30*800张*45卷/箱", price: "10", merchantCode: "A" },
    { skuId: "old-2", specification: "【废弃】50*40*800张*45卷/箱", price: "12", merchantCode: "B" },
    { skuId: "new-1", specification: "【新】60*40*800张*45卷/箱", price: "15", merchantCode: "C" }
  ]);
  assert.equal(unexpectedNewSku.safeToReset, false);
  assert.match(unexpectedNewSku.differences.join(" "), /数量/);
  assert.equal(contract.reconcileWashLinkCheckpoint({ blocked: true }, []).safeToReset, false);
});

test("legacy wash-link checkpoints without a baseline require explicit confirmation before reset", () => {
  const legacyCheckpoint = { blocked: true, plan: null };
  assert.equal(contract.canReconcileLegacyWashLinkCheckpoint(legacyCheckpoint, false), false);
  assert.equal(contract.canReconcileLegacyWashLinkCheckpoint(legacyCheckpoint, true), true);
  assert.equal(contract.canReconcileLegacyWashLinkCheckpoint({ blocked: true, plan: { matched: [], retired: [] } }, true), false);
  assert.equal(contract.canReconcileLegacyWashLinkCheckpoint({ blocked: false, plan: null }, true), false);
});

test("wash-link waits for the re-rendered SKU row and ignores display whitespace", () => {
  assert.match(receiver, /function washLinkSpecificationKey\(value\)/);
  assert.equal(receiver.includes('.replace(/[\\s\\u00a0\\u200b]+/g, "")'), true);
  assert.match(receiver, /for \(let retry = 0; retry < 30; retry \+= 1\)/);
});

test("wash-link reacquires the SKU table after React replaces the table node", () => {
  assert.match(receiver, /for \(let retry = 0; retry < 30; retry \+= 1\) \{[\s\S]*?washLinkRowContainer\(panel, columns\)/);
  assert.match(receiver, /current = washLinkRowContainer\(panel, columns\)\.holder/);
});

test("wash-link waits for virtual rows to refill after every reset to the top", () => {
  assert.match(receiver, /async function findWashLinkRowBySkuId[\s\S]*?holder\.scrollTop = 0;[\s\S]*?dispatchEvent\?\.\(new Event\("scroll", \{ bubbles: true \}\)\);[\s\S]*?await sleep\(80\);[\s\S]*?for \(let segment = 1/);
  assert.match(receiver, /async function findWashLinkRow\(panel, columns, specification\)[\s\S]*?holder\.scrollTop = 0;[\s\S]*?await sleep\(80\);/);
});

test("wash-link scans virtual SKU rows in two stable passes and reports each segment", () => {
  assert.match(receiver, /function reportWashLinkScanProgress\(skuId, pass, segment\)/);
  assert.match(receiver, /for \(let pass = 1; pass <= 2; pass \+= 1\)/);
  assert.match(receiver, /reportWashLinkScanProgress\(skuId, pass, segment\)/);
  assert.match(receiver, /await waitForWashLinkVisibleRows\(holder, table, liveColumns\)/);
  assert.match(receiver, /连续两轮扫描后仍未找到 SKUID/);
  assert.match(receiver, /scanPasses: 2/);
  assert.match(ui, /DOUDIAN_WASH_LINK_SCAN_PROGRESS/);
  assert.match(ui, /正在扫描第 \$\{message\.segment\} 段 SKU/);
  assert.match(ui, /请勿手动滚动、切换标签或点击发布/);
});

test("wash-link waits through the transient missing-table state during SKU regeneration", () => {
  assert.equal(receiver.includes("const transient = /UPDATE_(SKU_TABLE|SKU_HEADERS|PRICE_PANEL|PRICE_TAB)/"), true);
  assert.equal(receiver.includes("if (!transient || retry >= 29) throw caught"), true);
  assert.match(receiver, /if \(state\?\.skuScanComplete !== true\)/);
});

test("wash-link appends specifications with the same blur commit used by new-link uploads", () => {
  assert.match(receiver, /async function commitWashLinkSpecificationInput\(input, specification, onDispatch = \(\) => \{\}\)[\s\S]*?input\.focus\?\.\(\{ preventScroll: true \}\)[\s\S]*?new Event\(type, \{ bubbles: true, composed: true \}\)[\s\S]*?await sleep\(0\)[\s\S]*?input\.blur\?\.\(\)/);
  assert.doesNotMatch(receiver, /async function commitWashLinkSpecificationInput\(input[\s\S]*?new KeyboardEvent\(/);
  assert.match(receiver, /await commitWashLinkSpecificationInput\(input, target\.specification\);[\s\S]*?await sleep\(1500\)/);
  assert.match(receiver, /await commitWashLinkSpecificationInput\(empty, target\.specification, onDispatch\);[\s\S]*?return \{ specification: target\.specification, committed: true, previousInputCount/);
  assert.match(receiver, /async function waitForWashLinkFinalSpecificationEditor\(/);
  assert.match(receiver, /function liveWashLinkSpecificationPanel\(\)/);
  assert.match(receiver, /async function waitForWashLinkSpecificationCommit\(/);
  assert.match(receiver, /UPDATE_WASH_LINK_SPECIFICATION_READBACK_FAILED/);
  assert.match(receiver, /washLinkFinalSpecificationState\(expectedSpecifications, values\)/);
  assert.match(receiver, /waitForWashLinkFinalSpecificationEditor\(panel, current\.specificationType, expectedEditorSpecifications\)/);
  assert.doesNotMatch(receiver, /await commitWashLinkSpecificationInput\(empty, target\.specification, onDispatch\);[\s\S]*?await sleep\(1800\)/);
});

test("wash-link add phase uses the original Excel smart-recognition flow with existing specs retained", () => {
  assert.match(editor, /async function appendSpecificationsUsingWorkbook[\s\S]*?createAppendSpecificationPlan\([\s\S]*?const expectedSpecs = \[\.\.\.plan\.expectedSpecifications\][\s\S]*?importSpecification\(\{ file: payload, expectedSpecs \},/);
  const appendImport = editor.slice(editor.indexOf("async function appendSpecificationsUsingWorkbook"), editor.indexOf("async function createSpecificationGroup"));
  assert.doesNotMatch(appendImport, /UPDATE_SPEC_IMPORT_BASELINE_DRIFT/);
  assert.match(appendImport, /baselineDrift:/);
  assert.match(appendImport, /新增规格预检未通过：\$\{detail\}/);
  assert.match(appendImport, /validation,/);
  assert.match(editor, /onIdentifyDispatch\?\.\(\);[\s\S]*?clickElement\(identifyButton\)/);
  assert.match(ui, /appendValidation: error\.evidence\?\.validation/);
  assert.match(receiver, /runtime\.execute\("append_specifications_using_workbook"/);
  assert.match(receiver, /appendDispatched: false/);
  assert.match(receiver, /onIdentifyDispatch: \(\) => \{[\s\S]*?appendDispatched: true/);
  assert.match(receiver, /importReceipt\?\.observedSpecifications/);
  assert.match(receiver, /for \(const oldRow of current\.skuRows \|\| \[\]\)[\s\S]*?UPDATE_WASH_LINK_WORKBOOK_OLD_SKU_CHANGED/);
  assert.match(receiver, /UPDATE_WASH_LINK_WORKBOOK_ADD_RECONCILE_REQUIRED/);
});

test("wash-link recognizes accessible value-add controls and excludes specification-type controls", () => {
  const appendSource = receiver.slice(receiver.indexOf("async function appendWashLinkSpecification"), receiver.indexOf("\n  async function waitForWashLinkFinalSpecificationEditor"));
  assert.match(appendSource, /waitForWashLinkAppendReady\(panel, specificationType, beforeInputCount, target\.specification\)/);
  assert.match(receiver, /function washLinkAppendActionCandidates\(panel\)[\s\S]*?querySelectorAll\('button,\[role="button"\],\[title\],\[aria-label\]'\)/);
  assert.match(receiver, /添加规格值\|添加规格/);
  assert.match(receiver, /!\/添加规格类型\//);
  assert.match(receiver, /appendActionSignals/);
  assert.match(receiver, /async function waitForWashLinkEmptySpecificationInput\(panel, specificationType, beforeInputCount, specification, timeoutMs = 60000\)/);
});

test("execution failures ask the operator before a batch skips the affected product", () => {
  assert.match(html, /id="updateFailureDialog"/);
  assert.match(html, /id="updateFailureStop"/);
  assert.match(html, /id="updateFailureSkip"/);
  assert.match(ui, /async function askProductFailureDecision/);
  assert.match(ui, /await askProductFailureDecision\(products\[index\], caught, .*\{ canSkip: true \}\)/);
  assert.match(ui, /UPDATE_USER_STOPPED_AFTER_FAILURE/);
  assert.match(ui, /UPDATE_WASH_LINK_ROW_READBACK_FAILED/);
});

test("wash-link mode is current-product only and cannot resume the same operation", () => {
  assert.match(ui, /const washMode = updateSubmode === "wash"/);
  assert.match(ui, /control\.disabled = washMode \? !isCurrent \|\| running : running/);
  assert.match(ui, /const currentScope = updateSubmode === "replace" && selectedReplaceScope\(\) === "current"/);
});

test("SKU-only material directories are accepted while partial workbook pairs remain blocked", () => {
  const image = { name: "红色-10cm.jpg", webkitRelativePath: "商品A/图文信息/SKU/红色-10cm.jpg" };
  const imageOnly = contract.classifyUpdateMaterials([image]);
  assert.equal(imageOnly.priceInventory.intent, "skip");
  assert.equal(imageOnly.priceInventory.skuImages.length, 1);
  assert.throws(
    () => contract.classifyUpdateMaterials([
      image,
      { name: "规格.xlsx", webkitRelativePath: "商品A/规格.xlsx" }
    ]),
    (caught) => caught.code === "UPDATE_PRICE_INVENTORY_MATERIALS_PARTIAL"
  );
});

test("price inventory can defer missing SKU images when the image module is not selected", () => {
  const plan = skuPlanner.buildSkuImagePlan([{ specification: "红色 10*20cm" }], [], { allowMissing: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.matchedSkuCount, 0);
  assert.deepEqual(plan.deferredRowIndexes, [0]);
});

test("replace modules use independent folder inputs and support folder drops", () => {
  assert.match(html, /id="updatePriceInventoryInput"/);
  assert.match(html, /id="updateSkuImagesInput"/);
  assert.equal(html.includes("updateDirectoryInput"), false);
  assert.match(ui, /async function droppedFileRecords\(dataTransfer\)/);
  assert.match(ui, /bindMaterialDrop\(priceInventoryDrop, "price", input\)/);
  assert.match(ui, /bindMaterialDrop\(skuImagesDrop, "sku", skuImagesInput\)/);
});

test("selecting replacement materials enables their module and never audits a null material root", () => {
  assert.match(ui, /priceInventoryEnabled\.checked = true/);
  assert.match(ui, /skuImagesEnabled\.checked = true/);
  assert.match(ui, /root: materialPlan\.materialRoot/);
  assert.doesNotMatch(ui, /audit\("material_frozen", \{ root: classified\.materialRoot/);
});

test("dropped price materials retain their original files for workbook reading", () => {
  const workbook = { name: "规格.xlsx", size: 1, arrayBuffer: async () => new ArrayBuffer(0) };
  const priceWorkbook = { name: "规格价格表.xlsx", size: 1, arrayBuffer: async () => new ArrayBuffer(0) };
  const records = [
    { file: workbook, name: workbook.name, webkitRelativePath: "材料/规格.xlsx", relativePath: "材料/规格.xlsx" },
    { file: priceWorkbook, name: priceWorkbook.name, webkitRelativePath: "材料/规格价格表.xlsx", relativePath: "材料/规格价格表.xlsx" }
  ];
  const plans = preflight.materialRootFiles(records);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].files[0].originalFile, workbook);
  assert.equal(plans[0].files[1].originalFile, priceWorkbook);
});

test("two directly dropped Excel files are normalized into one price material directory", () => {
  const specificationWorkbook = { name: "单卷规格.xlsx", size: 1, arrayBuffer: async () => new ArrayBuffer(0) };
  const priceWorkbook = { name: "单卷规格价格表.xlsx", size: 1, arrayBuffer: async () => new ArrayBuffer(0) };
  const direct = [specificationWorkbook, priceWorkbook].map((file) => ({
    file,
    originalFile: file,
    name: file.name,
    webkitRelativePath: `直接投放的 Excel 文件/${file.name}`,
    relativePath: `直接投放的 Excel 文件/${file.name}`
  }));
  const plans = preflight.materialRootFiles(direct);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].name, "直接投放的 Excel 文件");
  assert.equal(contract.classifyUpdateMaterials(plans[0].files).priceInventory.intent, "replace_group");
  assert.match(ui, /function priceMaterialFileRecords\(records\)/);
  assert.match(ui, /直接投放的 Excel 文件\/\$\{record\.file\.name\}/);
});

test("click-selected price workbooks use the same direct-file normalization as dropped workbooks", () => {
  assert.match(
    ui,
    /priceInventoryFiles = priceMaterialFileRecords\(\[\.\.\.input\.files\].map\(\(file\) => \(\{ file, relativePath: file\.webkitRelativePath \|\| file\.name \}\)\)\)/
  );
});

test("system cache files are ignored before SKU image validation", () => {
  const files = [
    { name: "Thumbs.db" },
    { name: "desktop.ini" },
    { name: ".DS_Store" },
    { name: "红色 10*20cm.jpg" }
  ];
  assert.deepEqual(contract.filterUpdateMaterialFiles(files).map((file) => file.name), ["红色 10*20cm.jpg"]);
});

test("each replace material drop has a clear action", () => {
  assert.match(html, /id="updatePriceInventoryClear"/);
  assert.match(html, /id="updateSkuImagesClear"/);
  assert.match(ui, /function clearReplaceMaterial\(kind\)/);
});

test("temporary drag-and-drop file access errors have a concise recovery message", () => {
  const error = new Error("A requested file or directory could not be found at the time an operation was processed.");
  assert.equal(
    contract.describeMaterialReadFailure(error),
    "无法读取拖入的文件，请重新拖入两份 Excel 文件后重试。"
  );
  assert.match(ui, /updateStatus\("", "blocked"\)/);
  assert.match(ui, /logsSection\.dataset\.state = "error"/);
});

test("material failures identify the source the user needs to check", () => {
  assert.deepEqual(
    contract.describeMaterialFailure(Object.assign(new Error("规格价格表的表头必须且只能有一列“库存”。"), { code: "UPDATE_WORKBOOK_INVALID" })),
    { category: "表格内容", message: "请检查两个 Excel 的工作表、表头和行数据。\n具体原因：规格价格表的表头必须且只能有一列“库存”。" }
  );
  assert.deepEqual(
    contract.describeMaterialFailure(Object.assign(new Error("SKU 图片包含非法名称。"), { code: "UPDATE_SKU_IMAGE_BATCH_INVALID" })),
    { category: "SKU 图片命名或匹配", message: "请检查 SKU 图片名称、重复图片和规格匹配。" }
  );
  assert.deepEqual(
    contract.describeMaterialFailure(Object.assign(new Error("未发现可用材料。"), { code: "UPDATE_NO_TARGET_MATERIAL" })),
    { category: "文件夹或文件", message: "请检查文件夹层级，以及两份 Excel 是否齐全。" }
  );
});

test("list pagination summary accepts current Doudian count and page-size formats", () => {
  assert.deepEqual(contract.parseListPaginationSummary("共 60 条 20 条/页"), { total: 60, pageSize: 20 });
  assert.deepEqual(contract.parseListPaginationSummary("总计 60 个商品 20/页"), { total: 60, pageSize: 20 });
  assert.deepEqual(contract.parseListPaginationSummary("共 60 个商品 每页 20"), { total: 60, pageSize: 20 });
  assert.equal(contract.parseListPaginationSummary("当前第 1 页"), null);
});

test("product-ID query parameters do not make the product management page look like an editor", () => {
  assert.equal(
    contract.isProductManagementListUrl("https://fxg.jinritemai.com/ffa/g/list?product_id=3825343475356925995"),
    true
  );
  assert.equal(
    contract.isProductManagementListUrl("https://fxg.jinritemai.com/ffa/g/create?product_id=3825343475356925995"),
    false
  );
  assert.match(ui, /isProductManagementListUrl/);
});

test("current edit pages can retain multiple blank specification inputs without losing the planned order", () => {
  const step = {
    expectedSpecs: ["规格 A", "规格 B"],
    index: 1,
    observedFilled: ["规格 A"],
    emptyCount: 2,
    allowMultipleEmpty: true
  };
  assert.equal(contract.planSpecificationStep(step).specification, "规格 B");
  assert.throws(
    () => contract.planSpecificationStep({ ...step, allowMultipleEmpty: false }),
    (caught) => caught.code === "UPDATE_SPEC_STEP_EMPTY_INPUT_AMBIGUOUS"
  );
  assert.match(editor, /nextEmpty\.length >= 1/);
  assert.match(editor, /nextEmpty\.at\(-1\)/);
});

test("later specifications on the current edit page retain the established activation waits and blur commit", () => {
  assert.doesNotMatch(editor, /confirmWithEnter: currentPageProfile && index > 0/);
  assert.match(editor, /commitSpecificationValue\(inputUsedForWrite, expected, context\.runToken\);/);
  assert.match(editor, /async function activateCurrentPageSpecificationInput[\s\S]*?await sleep\(80\);/);
  assert.match(editor, /if \(currentPageProfile && index > 0\) \{[\s\S]*?await sleep\(600\);[\s\S]*?const reboundGroups = specificationEditorGroups\(specificationType\);/);
  assert.match(editor, /const firstReady = await waitFor\([\s\S]*?await sleep\(1000\);/);
  assert.doesNotMatch(editor, /waitForCurrentPageSpecificationInput/);
});

test("current edit pages wait for the SKU specification editor to reload before failing", () => {
  assert.match(editor, /CURRENT_PAGE_SPECIFICATION_SETTLEMENT_TIMEOUT_MS = 120000/);
  assert.match(
    editor,
    /waitForSettlement\(\s*currentPageProfile\s*\? CURRENT_PAGE_SPECIFICATION_SETTLEMENT_TIMEOUT_MS\s*:\s*ACTION_TIMEOUT_MS\s*\)/
  );
  assert.match(
    editor,
    /waitForSettlement\(\s*currentPageProfile\s*\? CURRENT_PAGE_SPECIFICATION_SETTLEMENT_TIMEOUT_MS\s*:\s*5000,\s*recovery\s*\)/
  );
});

test("current edit page continuation resumes only after the existing specification prefix matches Excel", () => {
  const decision = contract.resumeSpecificationDecision({
    expectedSpecs: ["规格 A", "规格 B", "规格 C"],
    observedFilled: ["规格 A"]
  });
  assert.deepEqual(decision, { completedCount: 1, nextIndex: 1 });
  assert.throws(
    () => contract.resumeSpecificationDecision({
      expectedSpecs: ["规格 A", "规格 B", "规格 C"],
      observedFilled: ["规格 B"]
    }),
    (caught) => caught.code === "UPDATE_CURRENT_RESUME_PREFIX_MISMATCH"
  );
  assert.match(ui, /resumeExistingSpecs/);
  assert.match(html, /继续当前商品编辑页/);
});
