"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createAppendSpecificationPlan, createSpecificationWorkbook } = require("../shared/specification-xlsx.js");

function unzipStored(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    files.set(name, new TextDecoder().decode(bytes.subarray(start, start + size)));
    offset = start + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50);
  return files;
}

test("temporary specification workbook contains the existing specifications followed by additions", () => {
  const workbook = createSpecificationWorkbook(["已有规格 A", "已有&规格 B", "新增规格 C"]);
  assert.equal(new DataView(workbook.buffer).getUint32(0, true), 0x04034b50);
  const files = unzipStored(workbook);
  const sheet = files.get("xl/worksheets/sheet1.xml");
  assert.match(sheet, /<t xml:space="preserve">规格<\/t>/);
  assert.ok(sheet.indexOf("已有规格 A") < sheet.indexOf("已有&amp;规格 B"));
  assert.ok(sheet.indexOf("已有&amp;规格 B") < sheet.indexOf("新增规格 C"));
});

test("temporary specification workbook rejects empty or duplicate values", () => {
  assert.throws(() => createSpecificationWorkbook([]), /at least one/i);
  assert.throws(() => createSpecificationWorkbook(["规格 A", ""]), /nonempty/i);
  assert.throws(() => createSpecificationWorkbook(["规格 A", "规格 A"]), /unique/i);
});

test("append workbook plan keeps frozen existing specifications despite live reordering", () => {
  const plan = createAppendSpecificationPlan(
    ["旧规格 A", "旧规格 B"],
    ["旧规格 B", "旧规格 A"],
    ["新增规格 C"]
  );
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.existingSpecifications, ["旧规格 A", "旧规格 B"]);
  assert.deepEqual(plan.expectedSpecifications, ["旧规格 A", "旧规格 B", "新增规格 C"]);
});

test("append workbook plan still triggers when live specifications differ from the frozen review", () => {
  const plan = createAppendSpecificationPlan(
    ["旧规格 A", "旧规格 B"],
    ["旧规格 A", "意外规格"],
    ["新增规格 C"]
  );
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.expectedSpecifications, ["旧规格 A", "旧规格 B", "新增规格 C"]);
  assert.deepEqual(plan.missingSpecifications, ["旧规格 B"]);
  assert.deepEqual(plan.unexpectedSpecifications, ["意外规格"]);
});

test("append workbook plan classifies invalid additions with specific samples", () => {
  const plan = createAppendSpecificationPlan(
    ["已有规格 A", "已有规格 B"],
    ["已有规格 A", "已有规格 B"],
    ["", "已有规格 A", "新增规格 C", " 新增规格C ", "新增规格 D"]
  );
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.validation, {
    emptyAdditionCount: 1,
    additionMatchesExistingCount: 1,
    duplicateAdditionCount: 2,
    duplicateExistingCount: 0,
    additionMatchesExistingSamples: ["已有规格 A"],
    duplicateAdditionSamples: ["新增规格 C", "新增规格C"],
    duplicateExistingSamples: []
  });
});
