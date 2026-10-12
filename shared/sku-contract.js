(function initializeSkuContract(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.DoudianSkuContract = api;
  }
})(globalThis, function createSkuContractApi() {
  "use strict";

  const SPEC_HEADER = "规格";
  const SPEC_HEADERS = Object.freeze(["规格", "商品规格"]);
  const PRICE_HEADER = "价格";
  const STOCK_HEADER = "库存";
  const STOCK_HEADERS = Object.freeze(["库存", "现货库存"]);
  const MERCHANT_CODE_HEADER = "商家编码";
  const PREVIEW_HEADER = "预览图";

  function normalizeExact(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .trim();
  }

  function exactHeaderIndex(headers, acceptedNames, label) {
    const names = (Array.isArray(acceptedNames) ? acceptedNames : [acceptedNames])
      .map(normalizeExact);
    const normalizedHeaders = headers.map(normalizeExact);
    const matches = [];
    for (let index = 0; index < normalizedHeaders.length; index += 1) {
      if (names.includes(normalizedHeaders[index])) matches.push(index);
    }
    if (matches.length !== 1) {
      const error = new Error(`${label}列无法唯一识别`);
      error.code = "SKU_HEADER_NOT_EXACT";
      error.evidence = {
        label,
        acceptedNames,
        headers,
        matches,
        rejectedPartialMatches: normalizedHeaders
          .map((header, index) => ({ header, index }))
          .filter(({ header }) =>
            names.some(
              (name) =>
                header !== name &&
                (header.includes(name) || name.includes(header))
            )
          )
      };
      throw error;
    }
    return matches[0];
  }

  function buildColumns(headers) {
    const columns = {
      spec: exactHeaderIndex(headers, SPEC_HEADERS, SPEC_HEADER),
      price: exactHeaderIndex(headers, PRICE_HEADER, PRICE_HEADER),
      stock: exactHeaderIndex(headers, STOCK_HEADERS, STOCK_HEADER),
      merchantCode: exactHeaderIndex(
        headers,
        MERCHANT_CODE_HEADER,
        MERCHANT_CODE_HEADER
      ),
      preview: exactHeaderIndex(headers, PREVIEW_HEADER, PREVIEW_HEADER)
    };
    if (new Set(Object.values(columns)).size !== Object.keys(columns).length) {
      const error = new Error("SKU列映射发生重叠");
      error.code = "SKU_HEADER_AMBIGUOUS";
      error.evidence = { headers, columns };
      throw error;
    }
    return columns;
  }

  function normalizeExpectedSpecs(specs) {
    if (!Array.isArray(specs) || specs.length < 1) {
      const error = new Error("规格计划至少需要包含一行");
      error.code = "SKU_PLAN_ROW_COUNT_MISMATCH";
      error.evidence = {
        minimumCount: 1,
        actualCount: Array.isArray(specs) ? specs.length : null
      };
      throw error;
    }
    const normalized = specs.map(normalizeExact);
    const emptyIndexes = normalized
      .map((value, index) => (value ? -1 : index))
      .filter((index) => index >= 0);
    const duplicates = normalized.filter(
      (value, index) => normalized.indexOf(value) !== index
    );
    if (emptyIndexes.length || duplicates.length) {
      const error = new Error("规格计划包含空值或重复值");
      error.code = "SKU_PLAN_IDENTITY_INVALID";
      error.evidence = {
        emptyIndexes,
        duplicates: Array.from(new Set(duplicates))
      };
      throw error;
    }
    return normalized;
  }

  function compareObservedSpecs(expectedSpecs, observedSpecs) {
    const expected = normalizeExpectedSpecs(expectedSpecs);
    const observed = observedSpecs.map(normalizeExact);
    const duplicateObserved = observed.filter(
      (value, index) => value && observed.indexOf(value) !== index
    );
    const expectedSet = new Set(expected);
    const observedSet = new Set(observed);
    return {
      exact:
        duplicateObserved.length === 0 &&
        observedSet.size === expected.length &&
        expected.every((spec) => observedSet.has(spec)),
      expectedCount: expected.length,
      observedCount: observedSet.size,
      missing: expected.filter((spec) => !observedSet.has(spec)),
      unexpected: Array.from(observedSet).filter(
        (spec) => !expectedSet.has(spec)
      ),
      duplicates: Array.from(new Set(duplicateObserved))
    };
  }

  function assertCellReadback(field, expected, actual) {
    const expectedText = String(expected);
    const actualText = String(actual);
    if (expectedText !== actualText) {
      const error = new Error(`SKU ${field}回读不一致`);
      error.code = "SKU_CELL_READBACK_MISMATCH";
      error.evidence = { field, expected: expectedText, actual: actualText };
      throw error;
    }
    return actualText;
  }

  return Object.freeze({
    MERCHANT_CODE_HEADER,
    PRICE_HEADER,
    PREVIEW_HEADER,
    SPEC_HEADER,
    SPEC_HEADERS,
    STOCK_HEADER,
    STOCK_HEADERS,
    assertCellReadback,
    buildColumns,
    compareObservedSpecs,
    exactHeaderIndex,
    normalizeExact,
    normalizeExpectedSpecs
  });
});
