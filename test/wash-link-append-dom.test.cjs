"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const contract = require(path.join(root, "shared", "update-contract.js"));
const receiverPath = path.join(root, "update-content-script.js");

function createReceiverHarness({ buttonLabel = "添加规格值", clockStep = 1, immediateTimeout = false, rerenderOnCommit = false, dropCommittedValueOnRerender = false, dropSpecificationOnActivation = "" } = {}) {
  let addValueClicks = 0;
  let activePanel = null;

  class FakeEvent extends Event {}
  class FakeMouseEvent extends Event {}
  class FakeInput {
    constructor(value = "") {
      this.value = value;
      this.placeholder = contract.SPECIFICATION_TYPE_PLACEHOLDERS["商品规格"];
      this.eventTarget = new EventTarget();
    }
    getAttribute(name) { return name === "placeholder" ? this.placeholder : null; }
    dispatchEvent(event) {
      if (event.type === "click" && dropSpecificationOnActivation) {
        const affected = this.ownerPanel?.inputs.find((input) => input.value === dropSpecificationOnActivation);
        if (affected) affected.value = "";
      }
      return this.eventTarget.dispatchEvent(event);
    }
    blur() { this.onBlur?.(); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 120, height: 24 }; }
  }
  Object.defineProperty(FakeInput.prototype, "value", {
    get() { return this._value || ""; },
    set(value) { this._value = String(value); },
    configurable: true
  });
  Object.defineProperty(FakeInput.prototype, "isConnected", { get() { return this.ownerPanel?.isConnected === true; }, configurable: true });
  Object.defineProperty(FakeInput.prototype, "getClientRects", { value() { return this.isConnected ? [{}] : []; }, configurable: true });
  Object.defineProperty(FakeInput.prototype, "focus", { value() {}, configurable: true });

  function createPanel(values) {
    const panel = {
      isConnected: true,
      inputs: values.map((value) => new FakeInput(value)),
      buttons: [],
      getClientRects() { return this.isConnected ? [{}] : []; },
      querySelectorAll(selector) {
        if (selector === contract.SPECIFICATION_VALUE_INPUT_SELECTOR) return this.inputs;
        if (selector.includes("button") || selector.includes("role=button")) return this.buttons;
        return [];
      }
    };
    const bindInput = (input) => {
      input.ownerPanel = panel;
      input.onBlur = () => {
        if (!rerenderOnCommit || !panel.isConnected) return;
        const valuesAfterCommit = panel.inputs.map((item) => item.value).filter(Boolean);
        panel.isConnected = false;
        activePanel = createPanel([...(dropCommittedValueOnRerender ? valuesAfterCommit.slice(0, -1) : valuesAfterCommit), ""]);
      };
    };
    panel.inputs.forEach(bindInput);
    const addValueButton = {
      disabled: false,
      innerText: "",
      textContent: "",
      get isConnected() { return panel.isConnected; },
      getClientRects: () => panel.isConnected ? [{}] : [],
      getAttribute(name) { return name === "aria-label" ? buttonLabel : null; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 20 }),
      focus() {},
      dispatchEvent(event) {
        if (event.type === "click") {
          addValueClicks += 1;
          const input = new FakeInput();
          bindInput(input);
          panel.inputs.push(input);
        }
        return true;
      }
    };
    panel.buttons.push(addValueButton);
    return panel;
  }
  activePanel = createPanel(["规格 A", "规格 B"]);
  const originalPanel = activePanel;

  const testApi = {};
  let source = fs.readFileSync(receiverPath, "utf8");
  source = source.replace(
    "Object.assign(globalThis.__DoudianUpdateTestApi, {",
    "Object.assign(globalThis.__DoudianUpdateTestApi, { appendWashLinkSpecification,"
  );
  let fakeNow = 0;
  class FakeDate extends Date {
    static now() {
      fakeNow += clockStep;
      return fakeNow;
    }
  }
  vm.runInNewContext(source, {
    DoudianUpdateContract: contract,
    DoudianBuildInfo: { id: "test" },
    __DoudianUpdateTestApi: testApi,
    HTMLInputElement: FakeInput,
    Event: FakeEvent,
    MouseEvent: FakeMouseEvent,
    PointerEvent: undefined,
    Date: FakeDate,
    setTimeout: immediateTimeout ? (callback) => { callback(); return 0; } : setTimeout,
    clearTimeout,
    document: { querySelectorAll(selector) { return selector === "#goodsEditScrollContainer-价格库存" && activePanel?.isConnected ? [activePanel] : []; } },
    chrome: { runtime: { onMessage: { addListener() {}, removeListener() {} } } }
  });

  return {
    testApi,
    panel: originalPanel,
    addValueClicks,
    getAddValueClicks: () => addValueClicks,
    liveSpecifications: () => activePanel.inputs.map((input) => input.value).filter(Boolean)
  };
}

test("wash-link adds a value using an accessible icon button after the initial inputs are full", async () => {
  const harness = createReceiverHarness();
  const result = await harness.testApi.appendWashLinkSpecification(
    harness.panel,
    "商品规格",
    { specification: "规格 C" }
  );
  assert.equal(result.committed, true);
  assert.equal(harness.getAddValueClicks(), 1);
  assert.equal(harness.panel.querySelectorAll(contract.SPECIFICATION_VALUE_INPUT_SELECTOR).at(-1).value, "规格 C");
});

test("wash-link activates and rebinds the live empty input before committing like the original uploader", async () => {
  const harness = createReceiverHarness();
  const result = await harness.testApi.appendWashLinkSpecification(
    harness.panel,
    "商品规格",
    { specification: "规格 C" }
  );
  assert.equal(result.committed, true);
  assert.deepEqual(harness.liveSpecifications(), ["规格 A", "规格 B", "规格 C"]);
});

test("wash-link stops before writing when input activation changes an existing specification", async () => {
  const harness = createReceiverHarness({ dropSpecificationOnActivation: "规格 B" });
  let dispatched = false;
  await assert.rejects(
    harness.testApi.appendWashLinkSpecification(
      harness.panel,
      "商品规格",
      { specification: "规格 C" },
      () => { dispatched = true; }
    ),
    (caught) => caught.code === "UPDATE_WASH_LINK_APPEND_ACTIVATION_DRIFT" &&
      caught.evidence.expectedSpecifications.includes("规格 B") &&
      !caught.evidence.observedSpecifications.includes("规格 B")
  );
  assert.equal(dispatched, false);
  assert.equal(harness.liveSpecifications().includes("规格 C"), false);
});

test("wash-link never treats the add-specification-type button as a value-add control", async () => {
  const harness = createReceiverHarness({ buttonLabel: "添加规格类型 (1/3)", clockStep: 10000, immediateTimeout: true });
  await assert.rejects(
    harness.testApi.appendWashLinkSpecification(harness.panel, "商品规格", { specification: "规格 C" }),
    (caught) => caught.code === "UPDATE_WASH_LINK_APPEND_INPUT_MISSING"
  );
  assert.equal(harness.getAddValueClicks(), 0);
});

test("wash-link rebinds after the SKU editor panel is replaced and preserves committed specifications", async () => {
  const harness = createReceiverHarness({ rerenderOnCommit: true, immediateTimeout: true, clockStep: 2000 });
  await harness.testApi.appendWashLinkSpecification(harness.panel, "商品规格", { specification: "规格 C" });
  await harness.testApi.appendWashLinkSpecification(harness.panel, "商品规格", { specification: "规格 D" });
  assert.deepEqual(harness.liveSpecifications(), ["规格 A", "规格 B", "规格 C", "规格 D"]);
});

test("wash-link stops before the next SKU when a committed specification disappears during rerender", async () => {
  const harness = createReceiverHarness({ rerenderOnCommit: true, dropCommittedValueOnRerender: true, immediateTimeout: true, clockStep: 2000 });
  await assert.rejects(
    harness.testApi.appendWashLinkSpecification(harness.panel, "商品规格", { specification: "规格 C" }),
    (caught) => caught.code === "UPDATE_WASH_LINK_SPECIFICATION_READBACK_FAILED" &&
      caught.evidence.missingSpecifications.includes("规格 C") && caught.evidence.outcomeUnknown === true
  );
  assert.deepEqual(harness.liveSpecifications(), ["规格 A", "规格 B"]);
});
