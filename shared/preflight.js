(function initializePreflight(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.DoudianPreflight = api;
  }
})(globalThis, function createPreflightApi() {
  "use strict";

  const VALID_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  const VALID_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v"]);
  const EXPECTED_WORKBOOKS = Object.freeze([
    "规格.xlsx",
    "规格价格表.xlsx"
  ]);
  const REQUIRED_WORKBOOK_ROLES = Object.freeze([
    "specification",
    "price"
  ]);
  const MATERIAL_WORKBOOK_KEYS = Object.freeze({
    specification: "specification",
    price: "price",
    titleLibrary: "titleLibrary"
  });
  const TITLE_LIBRARY_FILENAME = "标题库.xlsx";
  const DIRECTORY_KIND = Object.freeze({
    主图: "main",
    辅助图: "auxiliary",
    商品详情: "detail",
    主图34: "ratio34",
    辅助34: "ratio34Auxiliary",
    辅助图34: "ratio34Auxiliary",
    主图视频: "video",
    白底图: "whiteBackground",
    sku: "skuImages",
    SKU: "skuImages"
  });
  const MEDIA_KINDS = Object.freeze([
    "main",
    "auxiliary",
    "detail",
    "ratio34",
    "ratio34Auxiliary",
    "video",
    "whiteBackground",
    "skuImages"
  ]);
  const LIMITS = Object.freeze({
    main: 1,
    auxiliary: 4,
    detail: 50,
    ratio34: 5,
    ratio34Auxiliary: 4,
    video: 1,
    whiteBackground: 1
  });
  const FULL_FLOW_COUNTS = Object.freeze({
    workbooks: 2
  });
  const BATCH_MAIN_LIMIT = 50;

  function normalizeRelativePath(value) {
    return String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .replace(/\/+/g, "/");
  }

  function basename(relativePath) {
    const parts = normalizeRelativePath(relativePath).split("/");
    return parts[parts.length - 1] || "";
  }

  function extensionOf(filename) {
    const dotIndex = filename.lastIndexOf(".");
    return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
  }

  function isIgnoredPath(relativePath) {
    const parts = normalizeRelativePath(relativePath).split("/");
    const filename = parts[parts.length - 1] || "";
    return (
      parts.some((part) => part.startsWith(".")) ||
      filename.startsWith("~$") ||
      /^(thumbs\.db|desktop\.ini)$/i.test(filename)
    );
  }

  function tokenizeNatural(value) {
    return String(value)
      .normalize("NFKC")
      .toLocaleLowerCase("zh-CN")
      .match(/\d+|\D+/g) || [];
  }

  function naturalCompare(left, right) {
    const leftTokens = tokenizeNatural(left);
    const rightTokens = tokenizeNatural(right);
    const length = Math.max(leftTokens.length, rightTokens.length);

    for (let index = 0; index < length; index += 1) {
      const leftToken = leftTokens[index];
      const rightToken = rightTokens[index];
      if (leftToken === undefined) return -1;
      if (rightToken === undefined) return 1;

      const leftIsNumber = /^\d+$/.test(leftToken);
      const rightIsNumber = /^\d+$/.test(rightToken);
      if (leftIsNumber && rightIsNumber) {
        const leftTrimmed = leftToken.replace(/^0+(?=\d)/, "");
        const rightTrimmed = rightToken.replace(/^0+(?=\d)/, "");
        if (leftTrimmed.length !== rightTrimmed.length) {
          return leftTrimmed.length - rightTrimmed.length;
        }
        if (leftTrimmed !== rightTrimmed) {
          return leftTrimmed < rightTrimmed ? -1 : 1;
        }
        if (leftToken.length !== rightToken.length) {
          return leftToken.length - rightToken.length;
        }
        continue;
      }

      const comparison = leftToken.localeCompare(rightToken, "zh-CN", {
        sensitivity: "base",
        usage: "sort"
      });
      if (comparison !== 0) return comparison;
    }

    return String(left).localeCompare(String(right), "zh-CN", {
      sensitivity: "variant",
      usage: "sort"
    });
  }

  function normalizeMainName(value) {
    return String(value || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLocaleLowerCase("zh-CN");
  }

  function duplicateNormalizedNames(records) {
    const seen = new Set();
    const duplicates = new Set();
    for (const record of records) {
      const normalized = normalizeMainName(record.name);
      if (seen.has(normalized)) duplicates.add(normalized);
      seen.add(normalized);
    }
    return [...duplicates];
  }

  function materialWorkbookRole(filename) {
    const normalized = normalizeMainName(filename);
    if (normalized.endsWith(normalizeMainName(TITLE_LIBRARY_FILENAME))) {
      return MATERIAL_WORKBOOK_KEYS.titleLibrary;
    }
    if (normalized.endsWith(normalizeMainName("规格价格表.xlsx"))) {
      return MATERIAL_WORKBOOK_KEYS.price;
    }
    if (normalized.endsWith(normalizeMainName("规格.xlsx"))) {
      return MATERIAL_WORKBOOK_KEYS.specification;
    }
    return null;
  }

  function resolveMaterialWorkbooks(workbookFiles) {
    const workbooks = Object.fromEntries(
      Object.values(MATERIAL_WORKBOOK_KEYS).map((key) => [key, []])
    );
    for (const record of workbookFiles) {
      const role = materialWorkbookRole(record.name);
      if (role) workbooks[role].push(record);
    }
    return workbooks;
  }

  function classifyRelativePath(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const parts = normalized.split("/");
    if (parts.length < 2 || isIgnoredPath(normalized)) {
      return { kind: "ignored", relativePath: normalized };
    }

    const filename = parts[parts.length - 1];
    const directoryName = parts[parts.length - 2];
    const extension = extensionOf(filename);
    const mediaKind = DIRECTORY_KIND[directoryName];
    const isCurrentMaterialPath =
      parts.length === 4 &&
      parts[1] === "图文信息" &&
      Boolean(mediaKind);
    const isLegacyMaterialPath =
      parts.length === 5 &&
      parts[1] === "图文信息" &&
      parts[2] === "德轩优品主图" &&
      Boolean(mediaKind);
    const validExtensions =
      mediaKind === "video"
        ? VALID_VIDEO_EXTENSIONS
        : VALID_IMAGE_EXTENSIONS;

    if (
      (isCurrentMaterialPath || isLegacyMaterialPath) &&
      validExtensions.has(extension)
    ) {
      return {
        kind: mediaKind,
        relativePath: normalized,
        filename
      };
    }

    if (parts.length === 2 && extension === ".xlsx") {
      const role = materialWorkbookRole(filename);
      return {
        kind: "workbook",
        relativePath: normalized,
        filename,
        expected: role === MATERIAL_WORKBOOK_KEYS.specification ||
          role === MATERIAL_WORKBOOK_KEYS.price,
        role
      };
    }

    return {
      kind: "other",
      relativePath: normalized,
      filename
    };
  }

  function fileRelativePath(file) {
    return normalizeRelativePath(file.webkitRelativePath || file.relativePath || file.name);
  }

  function toFileRecord(file, classification) {
    return {
      file,
      name: file.name || classification.filename || basename(classification.relativePath),
      relativePath: classification.relativePath,
      type: file.type || "",
      size: Number(file.size) || 0,
      lastModified: Number(file.lastModified) || 0
    };
  }

  function preflightDirectory(fileList, options = {}) {
    const batchMode = options.mode === "batch" || options.batch === true;
    const materialDirectory = options.materialDirectory === true;
    const mainLimit = batchMode ? BATCH_MAIN_LIMIT : LIMITS.main;
    const files = Array.from(fileList || []);
    const groups = Object.fromEntries(
      MEDIA_KINDS.map((kind) => [kind, []])
    );
    let workbooks = Object.fromEntries(
      Object.values(MATERIAL_WORKBOOK_KEYS).map((key) => [key, []])
    );
    const workbookFiles = [];

    for (const file of files) {
      const classification = classifyRelativePath(fileRelativePath(file));
      if (classification.kind in groups) {
        groups[classification.kind].push(toFileRecord(file, classification));
      } else if (classification.kind === "workbook") {
        const record = toFileRecord(file, classification);
        workbookFiles.push(record);
        if (classification.role) {
          workbooks[classification.role].push(record);
        }
      }
    }

    for (const records of Object.values(groups)) {
      records.sort((left, right) => naturalCompare(left.name, right.name));
    }

    const issues = [];
    if (!batchMode && groups.main.length !== LIMITS.main) {
      issues.push(`主图目录必须恰好包含 1 张有效图片，当前 ${groups.main.length} 张。`);
    }
    if (
      batchMode &&
      (groups.main.length < 1 || groups.main.length > mainLimit)
    ) {
      issues.push(
        `Batch main image count must be between 1 and ${mainLimit}; received ${groups.main.length}.`
      );
    }
    const duplicateMainNames = batchMode
      ? duplicateNormalizedNames(groups.main)
      : [];
    if (duplicateMainNames.length > 0) {
      issues.push(
        `Batch main image names must be unique after normalization: ${duplicateMainNames.join(", ")}.`
      );
    }

    if (groups.auxiliary.length > LIMITS.auxiliary) {
      issues.push(
        `辅助图超过上限 ${LIMITS.auxiliary} 张，当前 ${groups.auxiliary.length} 张；未截断。`
      );
    }
    if (groups.detail.length > LIMITS.detail) {
      issues.push(
        `详情图超过上限 ${LIMITS.detail} 张，当前 ${groups.detail.length} 张；未截断。`
      );
    }
    for (const kind of ["ratio34", "ratio34Auxiliary", "video", "whiteBackground"]) {
      if (groups[kind].length > LIMITS[kind]) {
        issues.push(
          `${kind} 超过上限 ${LIMITS[kind]} 个，当前 ${groups[kind].length} 个；未截断。`
        );
      }
    }

    let expectedWorkbooks = [...REQUIRED_WORKBOOK_ROLES];
    let expectedWorkbookCount = FULL_FLOW_COUNTS.workbooks;
    if (materialDirectory) {
      workbooks = resolveMaterialWorkbooks(workbookFiles);
      for (const key of expectedWorkbooks) {
        if (workbooks[key].length !== 1) {
          issues.push(`素材目录必须唯一识别 ${key} 工作簿，当前 ${workbooks[key].length} 个。`);
        }
      }
      if (workbooks[MATERIAL_WORKBOOK_KEYS.titleLibrary].length > 1) {
        issues.push(`素材目录最多包含 1 个 ${TITLE_LIBRARY_FILENAME}，当前 ${workbooks[MATERIAL_WORKBOOK_KEYS.titleLibrary].length} 个。`);
      }
      expectedWorkbookCount += workbooks[MATERIAL_WORKBOOK_KEYS.titleLibrary].length;
    } else {
      for (const workbookName of expectedWorkbooks) {
        const count = workbooks[workbookName].length;
        if (count !== 1) {
          issues.push(`必须唯一识别后缀为 ${workbookName === MATERIAL_WORKBOOK_KEYS.price ? "规格价格表.xlsx" : "规格.xlsx"} 的工作簿，当前 ${count} 个。`);
        }
      }
    }

    return {
      ok: issues.length === 0,
      mode: batchMode ? "batch" : "single",
      issues,
      counts: {
        main: groups.main.length,
        auxiliary: groups.auxiliary.length,
        detail: groups.detail.length,
        ratio34: groups.ratio34.length,
        ratio34Auxiliary: groups.ratio34Auxiliary.length,
        video: groups.video.length,
        whiteBackground: groups.whiteBackground.length,
        skuImages: groups.skuImages.length
      },
      images: groups,
      media: groups,
      workbooks,
      workbookFiles,
      expectedWorkbooks,
      expectedWorkbookCount,
      titleWorkbook: materialDirectory
        ? workbooks[MATERIAL_WORKBOOK_KEYS.titleLibrary][0] || null
        : null,
      limits: { ...LIMITS, main: mainLimit },
      duplicateMainNames
    };
  }

  function preflightBatchDirectory(fileList) {
    return preflightDirectory(fileList, { mode: "batch" });
  }

  function preflightMaterialDirectory(fileList) {
    return preflightDirectory(fileList, {
      mode: "batch",
      materialDirectory: true
    });
  }

  function rebaseFile(file, relativePath) {
    const source = file?.file || file;
    return {
      originalFile: source,
      name: source?.name || basename(relativePath),
      type: source?.type || "",
      size: Number(source?.size) || 0,
      lastModified: Number(source?.lastModified) || 0,
      webkitRelativePath: relativePath,
      arrayBuffer: typeof source?.arrayBuffer === "function"
        ? source.arrayBuffer.bind(source)
        : undefined
    };
  }

  function materialRootFiles(fileList) {
    const files = Array.from(fileList || []);
    const paths = files.map((file) => ({ file, parts: fileRelativePath(file).split("/") }));
    const isDirectProduct = paths.some(({ parts }) =>
      parts[1] === "图文信息" ||
      (parts.length === 2 && extensionOf(parts[1]) === ".xlsx")
    );
    const grouped = new Map();
    for (const { file, parts } of paths) {
      if (isDirectProduct) {
        const productName = parts[0] || "上架材料";
        if (!grouped.has(productName)) grouped.set(productName, []);
        grouped.get(productName).push(rebaseFile(file, parts.join("/")));
        continue;
      }
      if (parts.length < 3) continue;
      const productName = parts[1];
      if (!productName) continue;
      if (!grouped.has(productName)) grouped.set(productName, []);
      grouped.get(productName).push(
        rebaseFile(file, [productName, ...parts.slice(2)].join("/"))
      );
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => naturalCompare(left, right))
      .map(([name, filesForProduct]) => ({
        name,
        files: filesForProduct,
        report: preflightMaterialDirectory(filesForProduct)
      }));
  }

  function preflightMaterialRoot(fileList) {
    const products = materialRootFiles(fileList);
    const issues = products.length === 0
      ? ["所选目录中未识别到包含图文信息的商品素材目录。"]
      : [];
    return {
      ok: issues.length === 0 && products.some((product) => product.report.ok),
      mode: "material_root",
      issues,
      products
    };
  }

  function titleLibraryPlan(workbook, options = {}) {
    const sheets = Array.isArray(workbook) ? workbook : [];
    const sheet = sheets.find(
      (item) => normalizeMainName(item?.sheet || item?.name) === "taobao-titles"
    );
    if (!sheet || !Array.isArray(sheet.data) || sheet.data.length === 0) {
      return { ok: false, issues: ["标题库缺少 taobao-titles 工作表。"], titles: [] };
    }
    const headers = sheet.data[0] || [];
    const sequenceIndex = headers.findIndex((value) => normalizeMainName(value) === "序号");
    const titleIndex = headers.findIndex((value) => normalizeMainName(value) === "商品标题");
    const shortTitleIndex = headers.findIndex((value) => normalizeMainName(value) === "短标题");
    if (sequenceIndex < 0 || titleIndex < 0 || shortTitleIndex < 0) {
      return {
        ok: false,
        issues: ["标题库必须包含 序号、商品标题 和 短标题 列。"],
        titles: []
      };
    }
    const titles = sheet.data.slice(1)
      .map((row, index) => ({
        index,
        sequence: Number(row?.[sequenceIndex]),
        title: String(row?.[titleIndex] ?? "").normalize("NFKC").trim(),
        shortTitle: String(row?.[shortTitleIndex] ?? "").normalize("NFKC").trim()
      }))
      .filter((row) => Number.isFinite(row.sequence) && row.sequence > 0)
      .sort((left, right) => left.sequence - right.sequence || left.index - right.index)
      .map((row) => Object.freeze({
        sequence: row.sequence,
        title: row.title || "666",
        shortTitle: row.shortTitle,
        source: row.title ? "title_library" : "title_library_fallback"
      }));
    const requiredCount = Number(options.requiredCount);
    const issues = [];
    if (Number.isInteger(requiredCount) && requiredCount > 0) {
      for (let index = 0; index < requiredCount; index += 1) {
        const row = titles[index];
        if (!row) {
          issues.push(`标题库缺少与第 ${index + 1} 张主图匹配的数据行，无法读取短标题。`);
        } else if (!row.shortTitle) {
          issues.push(`标题库中与第 ${index + 1} 张主图匹配的 短标题 单元格为空（序号 ${row.sequence}）。`);
        }
      }
    }
    return Object.freeze({
      ok: issues.length === 0,
      issues: Object.freeze(issues),
      titles: Object.freeze(titles)
    });
  }

  function titleForTask(plan, index, fallbackTitle) {
    if (!plan) {
      return Object.freeze({
        title: fallbackTitle,
        shortTitle: "",
        source: "listing_default",
        sequence: null
      });
    }
    const title = plan.titles[index];
    return title || Object.freeze({
      title: "666",
      shortTitle: "",
      source: "title_library_fallback",
      sequence: null
    });
  }

  function fullExecutionGate(report, options = {}) {
    const issues = [...(report?.issues || [])];
    const warnings = [];
    const allowMissingMedia = options.allowMissingMedia === true;
    const counts = report?.counts || {};
    const mainLimit = report?.mode === "batch" ? BATCH_MAIN_LIMIT : LIMITS.main;
    if (counts.main < 1 || counts.main > mainLimit) {
      issues.push(
        `完整执行要求 main 为 1..${mainLimit} 个，当前 ${counts.main || 0} 个。`
      );
    }
    if (counts.auxiliary > LIMITS.auxiliary) {
      issues.push(
        `完整执行要求 auxiliary 最多 ${LIMITS.auxiliary} 个，当前 ${counts.auxiliary || 0} 个。`
      );
    }
    if (counts.detail > LIMITS.detail) {
      issues.push(
        `完整执行要求 detail 最多 ${LIMITS.detail} 个，当前 ${counts.detail || 0} 个。`
      );
    } else if (counts.detail < 1) {
      const message = "商品详情未检测到有效图片（目录缺失或为空），将跳过详情图上传。";
      if (allowMissingMedia) warnings.push(message);
      else issues.push(`完整执行要求 detail 为 1..${LIMITS.detail} 个，当前 ${counts.detail || 0} 个。`);
    }
    if (
      !Array.isArray(report?.workbookFiles) ||
      report.workbookFiles.length !== (report?.expectedWorkbookCount || FULL_FLOW_COUNTS.workbooks)
    ) {
      issues.push(
        `完整执行要求根目录恰好 ${report?.expectedWorkbookCount || FULL_FLOW_COUNTS.workbooks} 个工作簿，当前 ${report?.workbookFiles?.length || 0} 个。`
      );
    }

    return {
      ok: issues.length === 0,
      issues,
      warnings,
      expectedCounts: {
        ...FULL_FLOW_COUNTS,
        main: `1..${mainLimit}`,
        auxiliary: `0..${LIMITS.auxiliary}`,
        detail: `1..${LIMITS.detail}`
      }
    };
  }

  function metadataFromRecord(record) {
    if (!record) return null;
    return {
      name: record.name,
      relativePath: record.relativePath,
      type: record.type,
      size: record.size,
      lastModified: record.lastModified
    };
  }

  function toCheckpoint(report) {
    return {
      state: report.ok ? "ready" : "blocked",
      checkedAt: new Date().toISOString(),
      counts: { ...report.counts },
      main: metadataFromRecord(report.images.main[0]),
      workbookCount: report.workbookFiles.length,
      workbooks: Object.fromEntries(
        report.expectedWorkbooks.map((name) => [
          name,
          report.workbooks[name].map(metadataFromRecord)
        ])
      ),
      issues: [...report.issues]
    };
  }

  return Object.freeze({
    BATCH_MAIN_LIMIT,
    EXPECTED_WORKBOOKS,
    FULL_FLOW_COUNTS,
    LIMITS,
    MATERIAL_WORKBOOK_KEYS,
    TITLE_LIBRARY_FILENAME,
    VALID_IMAGE_EXTENSIONS,
    VALID_VIDEO_EXTENSIONS,
    classifyRelativePath,
    fullExecutionGate,
    naturalCompare,
    normalizeMainName,
    normalizeRelativePath,
    preflightBatchDirectory,
    preflightDirectory,
    preflightMaterialDirectory,
    preflightMaterialRoot,
    materialRootFiles,
    titleForTask,
    titleLibraryPlan,
    toCheckpoint
  });
});
