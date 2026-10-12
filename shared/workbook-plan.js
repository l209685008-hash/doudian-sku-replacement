(function initializeWorkbookPlan(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.DoudianWorkbookPlan = api;
  }
})(globalThis, function createWorkbookPlanApi() {
  "use strict";

  const PRICE_FALLBACK_SHEET = "上架表";
  const SPEC_HEADER = "规格";
  const COLOR_HEADER = "颜色分类";
  const PRICE_HEADER = "德轩优品抖音标价";
  const PRICE_HEADER_SUFFIX = "抖音标价";
  const STOCK_HEADER = "库存";
  const STOCK_HEADERS = Object.freeze(["库存", "现货库存"]);
  const BRAND_HEADER = "品牌";
  const BRAND_HEADERS = Object.freeze([BRAND_HEADER]);
  const CODE_HEADER = "商家编码";
  const FREIGHT_TEMPLATE_HEADER = "运费模版";
  const IGNORED_PRICE_HEADER = "成交价";

  function normalizedKey(value) {
    return String(value).normalize("NFKC").trim();
  }

  function isBlank(value) {
    return (
      value === null ||
      value === undefined ||
      (typeof value === "string" && value.trim() === "")
    );
  }

  function requiredText(value, label, rowNumber) {
    if (isBlank(value)) {
      throw new Error(`${label}第${rowNumber}行为空，请填写后重试。`);
    }
    return String(value);
  }

  function workbookDisplayName(workbookLabel) {
    return workbookLabel === "spec workbook" ? "规格表" : "规格价格表";
  }

  function hasReadableTabularData(sheet) {
    return (
      Array.isArray(sheet?.data) &&
      sheet.data.length >= 2 &&
      Array.isArray(sheet.data[0]) &&
      sheet.data[0].length > 0 &&
      Array.isArray(sheet.data[1])
    );
  }

  function selectSpecificationSheet(workbook) {
    const sheets = Array.from(workbook || []);
    const matches = sheets.filter((sheet) => {
      if (!hasReadableTabularData(sheet)) return false;
      const header = sheet.data[0];
      return header.filter((value) => value === SPEC_HEADER).length === 1;
    });
    if (matches.length === 0) {
      throw new Error(
        `规格表中找不到可用的规格工作表。请确认至少有一个工作表包含唯一的“${SPEC_HEADER}”列，并且表头下方至少有一行数据；工作表名称可以任意。`
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `规格表中发现多个包含“${SPEC_HEADER}”列的工作表（${matches.map((sheet) => sheet.sheet).join("、")}）。请只保留一个规格工作表后重试。`
      );
    }
    return matches[0];
  }

  function selectPriceSheet(workbook) {
    const sheets = Array.from(workbook || []);
    const firstSheet = sheets[0];
    if (hasReadableTabularData(firstSheet)) {
      return firstSheet;
    }

    const fallbackSheets = sheets.filter(
      (sheet) =>
        sheet?.sheet === PRICE_FALLBACK_SHEET &&
        hasReadableTabularData(sheet)
    );
    if (fallbackSheets.length !== 1) {
      throw new Error(
        `规格价格表的最左侧工作表不可读取，并且没有唯一可读取的“${PRICE_FALLBACK_SHEET}”工作表作为备用。请把上架数据放到最左侧工作表，或只保留一个有效的“${PRICE_FALLBACK_SHEET}”工作表。`
      );
    }
    return fallbackSheets[0];
  }

  function uniqueHeaderIndex(header, name, workbookLabel) {
    const acceptedNames = Array.isArray(name) ? name : [name];
    const matches = [];
    header.forEach((value, index) => {
      if (acceptedNames.includes(value)) matches.push(index);
    });
    if (matches.length !== 1) {
      throw new Error(
        `${workbookDisplayName(workbookLabel)}的表头必须且只能有一列“${acceptedNames.join("”或“")}”。当前找到${matches.length}列，请检查表头名称和重复列。`
      );
    }
    return matches[0];
  }

  function optionalHeaderIndex(header, names) {
    const acceptedNames = Array.isArray(names) ? names : [names];
    const matches = [];
    header.forEach((value, index) => {
      if (acceptedNames.includes(value)) matches.push(index);
    });
    if (matches.length > 1) {
      throw new Error(
        `规格价格表中“${acceptedNames.join("”或“")}”库存列重复。库存列最多只能保留一列。`
      );
    }
    return matches.length ? matches[0] : null;
  }

  function listingPriceHeaderIndex(header, workbookLabel) {
    const suffix = normalizedKey(PRICE_HEADER_SUFFIX);
    const matches = header
      .map((value, index) => ({ value: normalizedKey(value), index }))
      .filter(({ value }) => value.endsWith(suffix));
    if (matches.length !== 1) {
      throw new Error(
        `${workbookDisplayName(workbookLabel)}必须且只能有一列以“${PRICE_HEADER_SUFFIX}”结尾的价格列。当前找到${matches.length}列${matches.length ? `（${matches.map(({ value }) => value).join("、")}）` : ""}，请检查表头。`
      );
    }
    return matches[0].index;
  }

  function assertNonemptyDataRows(rows, workbookLabel) {
    const dataCount = rows.length - 1;
    if (dataCount < 1) {
      throw new Error(
        `${workbookDisplayName(workbookLabel)}只有表头，没有商品数据。请至少填写一行数据。`
      );
    }
  }

  function addUnique(map, key, value, label) {
    if (map.has(key)) {
      throw new Error(`${label}存在重复内容“${key}”，请删除或修改重复行。`);
    }
    map.set(key, value);
  }

  function roundListingPrice(value, rowNumber) {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value)
    ) {
      throw new Error(`抖音标价第${rowNumber}行不是有效数字，请填写数值后重试。`);
    }
    return Math.round(value);
  }

  function normalizeStock(value, rowNumber) {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value < 0
    ) {
      throw new Error(`库存第${rowNumber}行必须填写大于或等于0的整数。`);
    }
    return value;
  }

  function buildWorkbookPlan(specWorkbook, priceWorkbook, options = {}) {
    const requireStock = options.requireStock === true;
    const requireProductFields = options.requireProductFields !== false;
    const specSheet = selectSpecificationSheet(specWorkbook);
    const specRows = specSheet.data;
    const priceSheet = selectPriceSheet(priceWorkbook);
    const priceRows = priceSheet.data;
    if (!Array.isArray(specRows[0]) || !Array.isArray(priceRows[0])) {
      throw new Error("规格表或规格价格表缺少表头，请检查工作表第一行。");
    }

    assertNonemptyDataRows(specRows, "spec workbook");
    assertNonemptyDataRows(priceRows, "price workbook");

    const specIndex = uniqueHeaderIndex(
      specRows[0],
      SPEC_HEADER,
      "spec workbook"
    );
    const colorIndex = uniqueHeaderIndex(
      priceRows[0],
      COLOR_HEADER,
      "price workbook"
    );
    const priceIndex = listingPriceHeaderIndex(priceRows[0], "price workbook");
    const stockIndex = requireStock
      ? uniqueHeaderIndex(priceRows[0], STOCK_HEADER, "price workbook")
      : optionalHeaderIndex(priceRows[0], STOCK_HEADERS);
    const brandIndex = requireProductFields
      ? optionalHeaderIndex(priceRows[0], BRAND_HEADERS)
      : null;
    const codeIndex = uniqueHeaderIndex(
      priceRows[0],
      CODE_HEADER,
      "price workbook"
    );
    const freightTemplateIndex = requireProductFields
      ? uniqueHeaderIndex(
        priceRows[0],
        FREIGHT_TEMPLATE_HEADER,
        "price workbook"
      )
      : null;
    const freightTemplate = freightTemplateIndex === null
      ? null
      : requiredText(
        priceRows[1]?.[freightTemplateIndex],
        FREIGHT_TEMPLATE_HEADER,
        2
      );
    const specs = [];
    const rawSpecs = new Map();
    const normalizedSpecs = new Map();
    for (let index = 1; index < specRows.length; index += 1) {
      const rowNumber = index + 1;
      const value = requiredText(
        specRows[index]?.[specIndex],
        SPEC_HEADER,
        rowNumber
      );
      addUnique(rawSpecs, value, rowNumber, SPEC_HEADER);
      addUnique(
        normalizedSpecs,
        normalizedKey(value),
        rowNumber,
        `normalized ${SPEC_HEADER}`
      );
      specs.push({ value, rowNumber });
    }

    const rawPrices = new Map();
    const normalizedPrices = new Map();
    let brandIssue = null;
    const firstBrandValue = brandIndex === null
      ? null
      : priceRows[1]?.[brandIndex];
    const normalizedFirstBrand = firstBrandValue === null || firstBrandValue === undefined
      ? ""
      : normalizedKey(firstBrandValue);
    const brand = brandIndex === null ? null : normalizedFirstBrand || null;
    if (brandIndex !== null && !brand) {
      brandIssue = `${BRAND_HEADER}第2行为空，请填写本商品使用的品牌。`;
    }
    for (let index = 1; index < priceRows.length; index += 1) {
      const rowNumber = index + 1;
      const row = priceRows[index] || [];
      const color = requiredText(
        row[colorIndex],
        COLOR_HEADER,
        rowNumber
      );
      const merchantCode = requiredText(
        row[codeIndex],
        CODE_HEADER,
        rowNumber
      );
      const record = {
        color,
        merchantCode,
        price: roundListingPrice(row[priceIndex], rowNumber),
        stock: stockIndex === null ? null : normalizeStock(row[stockIndex], rowNumber),
        rowNumber
      };
      addUnique(rawPrices, color, record, COLOR_HEADER);
      addUnique(
        normalizedPrices,
        normalizedKey(color),
        record,
        `normalized ${COLOR_HEADER}`
      );
    }

    const matchedPriceRows = new Set();
    const rows = specs.map((spec, index) => {
      const priceRecord =
        rawPrices.get(spec.value) ||
        normalizedPrices.get(normalizedKey(spec.value));
      if (!priceRecord) {
        throw new Error(
          `规格表第${spec.rowNumber}行“${spec.value}”在规格价格表的“${COLOR_HEADER}”列中没有对应行，请补充完全一致的规格。`
        );
      }
      matchedPriceRows.add(priceRecord.rowNumber);
      return Object.freeze({
        index,
        specification: spec.value,
        colorCategory: priceRecord.color,
        price: priceRecord.price,
        stock: priceRecord.stock,
        merchantCode: priceRecord.merchantCode
      });
    });

    if (matchedPriceRows.size !== rawPrices.size) {
      const extraRows = [];
      for (const record of rawPrices.values()) {
        if (!matchedPriceRows.has(record.rowNumber)) {
          extraRows.push(record.rowNumber);
        }
      }
      throw new Error(
        `规格价格表第${extraRows.join("、")}行在规格表中找不到对应规格，请删除多余行或修正规格名称。`
      );
    }

    return Object.freeze({
      count: rows.length,
      specSheet: specSheet.sheet,
      priceSheet: priceSheet.sheet,
      brand,
      brandIssue,
      freightTemplate,
      rows: Object.freeze(rows)
    });
  }

  return Object.freeze({
    CODE_HEADER,
    FREIGHT_TEMPLATE_HEADER,
    COLOR_HEADER,
    IGNORED_PRICE_HEADER,
    PRICE_HEADER,
    PRICE_HEADER_SUFFIX,
    PRICE_FALLBACK_SHEET,
    SPEC_HEADER,
    STOCK_HEADER,
    STOCK_HEADERS,
    BRAND_HEADER,
    BRAND_HEADERS,
    buildWorkbookPlan,
    normalizedKey,
    normalizeStock,
    roundListingPrice
  });
});
