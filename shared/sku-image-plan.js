(function initializeSkuImagePlan(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.DoudianSkuImagePlan = api;
  }
})(globalThis, function createSkuImagePlanApi() {
  "use strict";

  const IMAGE_EXTENSIONS = "jpg|jpeg|png|webp";
  const STANDARD_IMAGE_PATTERN = new RegExp(
    `^R([123])_W([1-9]\\d*)_H([1-9]\\d*)_BG([NWB])\\.(${IMAGE_EXTENSIONS})$`,
    "i"
  );
  const FLEXIBLE_IMAGE_PATTERN = new RegExp(
    `^([1-9]\\d*)\\s*-\\s*([1-9]\\d*)((?:\\s*-\\s*[^-]+)*)\\.(${IMAGE_EXTENSIONS})$`,
    "i"
  );
  const LEGACY_IMAGE_PATTERN = new RegExp(
    `^(?:(2|3)排)?([1-9]\\d*)-([1-9]\\d*)(?:-([1-9]\\d*))?(?:\\((白底|蓝底)\\))?\\.(${IMAGE_EXTENSIONS})$`,
    "i"
  );

  function normalize(value) {
    return String(value ?? "").normalize("NFKC").trim();
  }

  function semanticKey(
    rowCount,
    width,
    height,
    background,
    quantity,
    stacked = false,
    stackCount = null
  ) {
    const quantityPart = Number.isFinite(quantity) ? `_Q${quantity}` : "";
    const stackPart = stacked
      ? `_D${Number.isFinite(stackCount) ? stackCount : ""}`
      : "";
    return `R${rowCount}_W${width}_H${height}${quantityPart}_BG${background}${stackPart}`;
  }

  function parseSpecificationDetails(specification) {
    const normalized = normalize(specification);
    const dimensionMatch = /(?:^|[^\d])([1-9]\d*)\s*[*×xX]\s*([1-9]\d*)(?!\d)/.exec(
      normalized
    );
    if (!dimensionMatch) {
      return {
        ok: false,
        normalized,
        reason: "Specification does not contain an ordered positive width*height pair."
      };
    }

    const hasDoubleRow = normalized.includes("双排");
    const hasTripleRow = normalized.includes("三排");
    const stacked = normalized.includes("叠");
    const stackCountMatches = [
      ...normalized.matchAll(/([1-9]\d*)\s*叠/g)
    ];
    const stackCounts = new Set(
      stackCountMatches.map((match) => Number(match[1]))
    );
    const hasWhiteBackground = normalized.includes("白底");
    const hasBlueBackground = normalized.includes("蓝底");
    if (hasDoubleRow && hasTripleRow) {
      return {
        ok: false,
        normalized,
        reason: "Specification contains conflicting row-count markers."
      };
    }
    if (!stacked && hasWhiteBackground && hasBlueBackground) {
      return {
        ok: false,
        normalized,
        reason: "Specification contains conflicting background markers."
      };
    }
    if (stackCounts.size > 1) {
      return {
        ok: false,
        normalized,
        reason: "Specification contains conflicting stack-count markers."
      };
    }

    const quantityMatch = /([1-9]\d*)\s*[*×xX]\s*([1-9]\d*)\s*[*×xX]\s*([1-9]\d*)(?:\s*\u5f20|\s*[*×xX])/.exec(
      normalized
    );
    const quantity = quantityMatch ? Number(quantityMatch[3]) : null;
    const stackCount = stackCounts.size === 1 ? [...stackCounts][0] : null;
    const rowCount = hasTripleRow ? 3 : hasDoubleRow ? 2 : 1;
    const background = stacked
      ? "N"
      : hasWhiteBackground
        ? "W"
        : "B";
    const width = Number(dimensionMatch[1]);
    const height = Number(dimensionMatch[2]);
    return {
      ok: true,
      normalized,
      rowCount,
      width,
      height,
      quantity,
      background,
      stacked,
      stackCount,
      semanticKey: semanticKey(
        rowCount,
        width,
        height,
        background,
        quantity,
        stacked,
        stackCount
      )
    };
  }

  function parseSpecificationKey(specification) {
    const result = parseSpecificationDetails(specification);
    return result.ok ? result.semanticKey : null;
  }

  function imageName(image) {
    if (typeof image === "string") return image;
    return image?.name || "";
  }

  function parseImageDetails(image) {
    const originalName = imageName(image);
    const normalizedName = normalize(originalName);
    if (!normalizedName) {
      return {
        ok: false,
        originalName,
        normalizedName,
        reason: "SKU image record has no filename."
      };
    }
    const standardMatch = STANDARD_IMAGE_PATTERN.exec(normalizedName);
    if (standardMatch) {
      const rowCount = Number(standardMatch[1]);
      const width = Number(standardMatch[2]);
      const height = Number(standardMatch[3]);
      const backgroundCode = standardMatch[4].toUpperCase();
      const background = backgroundCode === "W" ? "W" : "B";
      return {
        ok: true,
        originalName,
        normalizedName,
        naming: "standard",
        rowCount,
        width,
        height,
        quantity: null,
        background,
        stacked: false,
        stackCount: null,
        semanticKey: semanticKey(rowCount, width, height, background, null, false)
      };
    }

    const flexibleMatch = FLEXIBLE_IMAGE_PATTERN.exec(normalizedName);
    if (flexibleMatch) {
      const width = Number(flexibleMatch[1]);
      const height = Number(flexibleMatch[2]);
      const tokens = flexibleMatch[3]
        ? flexibleMatch[3]
            .replace(/^\s*-\s*/, "")
            .split("-")
            .map((token) => token.trim())
        : [];
      let quantity = null;
      let rowCount = 1;
      let background = "B";
      let stacked = false;
      let stackCount = null;
      let numericCount = 0;
      let colorCount = 0;
      let hasRowCount = false;

      for (const [tokenIndex, token] of tokens.entries()) {
        const stackCountMatch = /^([1-9]\d*)d$/i.exec(token);
        if (stackCountMatch) {
          if (stacked || tokenIndex !== tokens.length - 1) {
            return {
              ok: false,
              originalName,
              normalizedName,
              reason: 'The "d" stack marker must appear once at the end of the filename.'
            };
          }
          stacked = true;
          stackCount = Number(stackCountMatch[1]);
          continue;
        }
        if (/^d$/i.test(token)) {
          if (stacked || tokenIndex !== tokens.length - 1) {
            return {
              ok: false,
              originalName,
              normalizedName,
              reason: 'The "d" stack marker must appear once at the end of the filename.'
            };
          }
          stacked = true;
          continue;
        }

        if (token === "白" || token === "白底" || token === "蓝" || token === "蓝底") {
          colorCount += 1;
          if (colorCount > 1) {
            return {
              ok: false,
              originalName,
              normalizedName,
              reason: "SKU image filename contains more than one color field."
            };
          }
          background = token.startsWith("白") ? "W" : "B";
          continue;
        }

        if (/^[1-9]\d*$/.test(token)) {
          numericCount += 1;
          const value = Number(token);
          if (numericCount === 1 && value > 100) {
            quantity = value;
            continue;
          }
          if (hasRowCount || value < 1 || value > 3) {
            return {
              ok: false,
              originalName,
              normalizedName,
              reason: "Row count in a SKU image filename must be 1, 2, or 3."
            };
          }
          rowCount = value;
          hasRowCount = true;
          continue;
        }

        return {
          ok: false,
          originalName,
          normalizedName,
          reason: `Unsupported SKU image filename field: ${token}.`
        };
      }

      if (stacked) background = "N";

      return {
        ok: true,
        originalName,
        normalizedName,
        naming: "flexible",
        rowCount,
        width,
        height,
        quantity,
        background,
        stacked,
        stackCount,
        semanticKey: semanticKey(
          rowCount,
          width,
          height,
          background,
          quantity,
          stacked,
          stackCount
        )
      };
    }

    const legacyMatch = LEGACY_IMAGE_PATTERN.exec(normalizedName);
    if (legacyMatch) {
      const rowCount = legacyMatch[1] ? Number(legacyMatch[1]) : 1;
      const width = Number(legacyMatch[2]);
      const height = Number(legacyMatch[3]);
      const background = legacyMatch[5] === "白底"
        ? "W"
        : legacyMatch[5] === "蓝底"
          ? "B"
          : "B";
      return {
        ok: true,
        originalName,
        normalizedName,
        naming: "legacy",
        legacySuffix: legacyMatch[4] || null,
        rowCount,
        width,
        height,
        quantity: null,
        background,
        stacked: false,
        stackCount: null,
        semanticKey: semanticKey(rowCount, width, height, background, null, false)
      };
    }

    return {
      ok: false,
      originalName,
      normalizedName,
      reason:
        "Filename must use width-height-[quantity]-[rowCount]-[color]-[d], the standard R/W/H/BG form, or a supported legacy form."
    };
  }

  function parseImageKey(image) {
    const result = parseImageDetails(image);
    return result.ok ? result.semanticKey : null;
  }

  function matchingKey(parsed, includeQuantity) {
    return semanticKey(
      parsed.rowCount,
      parsed.width,
      parsed.height,
      parsed.background,
      includeQuantity ? parsed.quantity : null,
      parsed.stacked,
      parsed.stackCount
    );
  }

  function rowMatchesImage(rowParsed, imageParsed, includeQuantity) {
    if (!rowParsed?.ok || !imageParsed?.ok) return false;
    if (rowParsed.rowCount !== imageParsed.rowCount) return false;
    if (rowParsed.width !== imageParsed.width) return false;
    if (rowParsed.height !== imageParsed.height) return false;
    if (rowParsed.background !== imageParsed.background) return false;
    if (rowParsed.stacked !== imageParsed.stacked) return false;
    if (rowParsed.stackCount !== imageParsed.stackCount) return false;
    if (
      includeQuantity &&
      (!Number.isFinite(rowParsed.quantity) ||
        !Number.isFinite(imageParsed.quantity) ||
        rowParsed.quantity !== imageParsed.quantity)
    ) {
      return false;
    }
    return true;
  }

  function matchingImages(rowParsed, imageEntries, includeQuantity) {
    if (includeQuantity === null) return [];
    return imageEntries.filter((entry) =>
      rowMatchesImage(rowParsed, entry.parsed, includeQuantity)
    );
  }

  function freezeArray(values) {
    return Object.freeze(values);
  }

  function freezeObject(value) {
    return Object.freeze(value);
  }

  function imageRecordsFromPreflight(preflight) {
    if (Array.isArray(preflight)) return preflight;
    if (Array.isArray(preflight?.images?.skuImages)) {
      return preflight.images.skuImages;
    }
    if (Array.isArray(preflight?.media?.skuImages)) {
      return preflight.media.skuImages;
    }
    if (Array.isArray(preflight?.skuImages)) return preflight.skuImages;
    return [];
  }

  function issue(code, severity, message, evidence) {
    return freezeObject({
      code,
      severity,
      message,
      evidence: freezeObject(evidence)
    });
  }

  function parsedImageSummary(parsed) {
    if (!parsed?.ok) return "无法解析";
    const details = [
      `尺寸 ${parsed.width}×${parsed.height}`,
      Number.isFinite(parsed.quantity) ? `数量 ${parsed.quantity}` : null,
      Number.isFinite(parsed.rowCount) ? `${parsed.rowCount}排` : null,
      parsed.background === "W" ? "白底" : parsed.background === "B" ? "蓝底" : "底色不区分"
    ].filter(Boolean);
    return details.join("、");
  }

  function ambiguousImageIssue(semanticKey, imageEntries, skuIndexes = [], specifications = []) {
    const affectedSpecifications = freezeArray([...new Set(Array.from(specifications, (value) => String(value)))]);
    const parsedImages = freezeArray(imageEntries.map((entry) => freezeObject({
      name: imageName(entry.image),
      width: entry.parsed?.width ?? null,
      height: entry.parsed?.height ?? null,
      quantity: Number.isFinite(entry.parsed?.quantity) ? entry.parsed.quantity : null,
      rowCount: entry.parsed?.rowCount ?? null,
      background: entry.parsed?.background ?? null
    })));
    const conflicts = imageEntries
      .map((entry) => `“${imageName(entry.image)}”（${parsedImageSummary(entry.parsed)}）`)
      .join("、");
    const affected = affectedSpecifications.length
      ? `受影响规格：${affectedSpecifications.map((value) => `“${value}”`).join("、")}。`
      : `受影响匹配键：${semanticKey}（尚未读取商品规格）。`;
    return issue(
      "SKU_IMAGE_AMBIGUOUS",
      "error",
      `SKU 图片匹配歧义：冲突文件 ${conflicts} 会匹配同一个 SKU。${affected}影响：预检不通过，不会继续打开或修改待处理商品页；已打开的当前商品页不会被修改。修复：删除或重命名冲突图片，确保每个 SKU 只唯一匹配一张后重试。`,
      {
        semanticKey,
        skuIndexes: freezeArray(Array.from(skuIndexes)),
        specifications: affectedSpecifications,
        imageNames: freezeArray(parsedImages.map((entry) => entry.name)),
        parsedImages
      }
    );
  }

  function blockingIssueMessage(issues) {
    return issues
      .filter((entry) => entry.severity === "error")
      .map((entry) => entry.message)
      .join("\n");
  }

  function preflightSkuImageBatch(skuImages) {
    const images = Array.from(skuImages || []);
    const issues = [];
    const entries = images.map((image, imageIndex) => freezeObject({
      image,
      imageIndex,
      parsed: freezeObject(parseImageDetails(image))
    }));
    if (entries.length === 0) {
      issues.push(issue("SKU_IMAGE_BATCH_REQUIRED", "error", "At least one SKU image is required.", { actualCount: 0 }));
    }
    const modeSource = entries[0] || null;
    const includeQuantity = modeSource
      ? modeSource.parsed.ok
        ? Number.isFinite(modeSource.parsed.quantity)
        : null
      : false;
    if (modeSource && !modeSource.parsed.ok) {
      issues.push(issue(
        "SKU_IMAGE_MODE_SOURCE_INVALID",
        "error",
        `The first SKU image cannot select a matching mode because its filename is invalid: ${modeSource.parsed.originalName || "(missing name)"}.`,
        { imageIndex: 0, name: modeSource.parsed.originalName, reason: modeSource.parsed.reason }
      ));
    }
    for (const entry of entries) {
      if (entry.parsed.ok || entry.imageIndex === 0) continue;
      issues.push(issue(
        "SKU_IMAGE_NAME_INVALID",
        "error",
        `Invalid SKU image filename: ${entry.parsed.originalName || "(missing name)"}.`,
        { imageIndex: entry.imageIndex, name: entry.parsed.originalName, reason: entry.parsed.reason }
      ));
    }
    if (includeQuantity !== null) {
      const byKey = new Map();
      for (const entry of entries.filter((item) => item.parsed.ok)) {
        const key = matchingKey(entry.parsed, includeQuantity);
        const group = byKey.get(key) || [];
        group.push(entry);
        byKey.set(key, group);
      }
      for (const [semanticKey, group] of byKey) {
        if (group.length < 2) continue;
        issues.push(ambiguousImageIssue(semanticKey, group));
      }
    }
    return freezeObject({
      images: freezeArray(images),
      entries: freezeArray(entries),
      issues: freezeArray(issues),
      errorMessage: blockingIssueMessage(issues),
      ok: !issues.some((entry) => entry.severity === "error"),
      matchMode: includeQuantity === null ? "invalid_first_image" : includeQuantity ? "quantity" : "spec_color",
      modeSourceName: modeSource ? imageName(modeSource.image) : null
    });
  }

  function buildSkuImagePlan(rows, skuImages, options) {
    const workbookRows = Array.isArray(rows)
      ? rows
      : Array.isArray(rows?.rows)
        ? rows.rows
        : [];
    const imageRecords = Array.isArray(skuImages)
      ? skuImages
      : imageRecordsFromPreflight(skuImages);
    const overrides = options?.overrides;
    const allowMissing = options?.allowMissing === true;
    const issues = [];
    const invalidImages = [];
    const unsupportedImages = [];
    const validImages = [];
    const parsedRows = workbookRows.map((row, position) => {
      const specification = row?.specification;
      const parsed = parseSpecificationDetails(specification);
      const index = Number.isInteger(row?.index) ? row.index : position;
      return {
        row,
        position,
        index,
        specification,
        normalizedSpecification: normalize(specification),
        parsed
      };
    });

    if (workbookRows.length < 1) {
      issues.push(
        issue(
          "SKU_IMAGE_PLAN_ROW_COUNT_MISMATCH",
          "error",
          `SKU image planning requires at least one workbook row; received ${workbookRows.length}.`,
          {
            minimumCount: 1,
            actualCount: workbookRows.length
          }
        )
      );
    }

    const imageEntries = imageRecords.map((record, imageIndex) => {
      const parsed = parseImageDetails(record);
      return {
        imageIndex,
        parsed,
        image: record
      };
    });
    // Preflight supplies SKU images in natural filename order.
    const modeSource = imageEntries[0] || null;
    const includeQuantity = modeSource
      ? modeSource.parsed.ok
        ? Number.isFinite(modeSource.parsed.quantity)
        : null
      : false;
    if (modeSource && !modeSource.parsed.ok) {
      issues.push(
        issue(
          "SKU_IMAGE_MODE_SOURCE_INVALID",
          "error",
          `The first SKU image cannot select a matching mode because its filename is invalid: ${modeSource.parsed.originalName || "(missing name)"}.`,
          {
            imageIndex: modeSource.imageIndex,
            name: modeSource.parsed.originalName,
            reason: modeSource.parsed.reason
          }
        )
      );
    }
    const imagesByNormalizedName = new Map();
    for (const entry of imageEntries) {
      const name = normalize(imageName(imageRecords[entry.imageIndex]));
      const matches = imagesByNormalizedName.get(name) || [];
      matches.push(entry);
      imagesByNormalizedName.set(name, matches);
    }

    const overrideBySpecification = new Map();
    const approvedOverrideImageIndexes = new Set();
    if (
      overrides !== undefined &&
      overrides !== null &&
      (typeof overrides !== "object" || Array.isArray(overrides))
    ) {
      issues.push(
        issue(
          "SKU_IMAGE_OVERRIDE_CONFIG_INVALID",
          "error",
          "SKU image overrides must be an object keyed by specification text.",
          { receivedType: Array.isArray(overrides) ? "array" : typeof overrides }
        )
      );
    } else {
      const groupedOverrides = new Map();
      for (const [rawSpecification, rawFilename] of Object.entries(
        overrides || {}
      )) {
        const normalizedSpecification = normalize(rawSpecification);
        const entries = groupedOverrides.get(normalizedSpecification) || [];
        entries.push({ rawSpecification, rawFilename });
        groupedOverrides.set(normalizedSpecification, entries);
      }

      for (const [normalizedSpecification, entries] of groupedOverrides) {
        if (!normalizedSpecification || entries.length !== 1) {
          const resolution = {
            ok: false,
            reason: !normalizedSpecification
              ? "Override specification key is empty after NFKC normalization and trim."
              : "Multiple override keys normalize to the same specification."
          };
          overrideBySpecification.set(normalizedSpecification, resolution);
          issues.push(
            issue(
              "SKU_IMAGE_OVERRIDE_SPECIFICATION_INVALID",
              "error",
              resolution.reason,
              {
                normalizedSpecification,
                rawSpecifications: freezeArray(
                  entries.map((entry) => entry.rawSpecification)
                )
              }
            )
          );
          continue;
        }

        const rawFilename = entries[0].rawFilename;
        const normalizedFilename =
          typeof rawFilename === "string" ? normalize(rawFilename) : "";
        const matchingRows = parsedRows.filter(
          (row) => row.normalizedSpecification === normalizedSpecification
        );
        if (matchingRows.length === 0) {
          issues.push(
            issue(
              "SKU_IMAGE_OVERRIDE_SPECIFICATION_NOT_FOUND",
              "error",
              `Override specification is not present in workbook rows: ${entries[0].rawSpecification}.`,
              {
                specification: entries[0].rawSpecification,
                normalizedSpecification,
                filename: rawFilename
              }
            )
          );
          continue;
        }
        if (!normalizedFilename) {
          const resolution = {
            ok: false,
            reason: "Override filename must be a nonempty string."
          };
          overrideBySpecification.set(normalizedSpecification, resolution);
          issues.push(
            issue(
              "SKU_IMAGE_OVERRIDE_FILENAME_INVALID",
              "error",
              resolution.reason,
              {
                specification: entries[0].rawSpecification,
                filename: rawFilename
              }
            )
          );
          continue;
        }

        const matchingImages =
          imagesByNormalizedName.get(normalizedFilename) || [];
        if (matchingImages.length !== 1) {
          const resolution = {
            ok: false,
            reason:
              matchingImages.length === 0
                ? "Override image filename is not present in skuImages."
                : "Override image filename occurs more than once in skuImages."
          };
          overrideBySpecification.set(normalizedSpecification, resolution);
          issues.push(
            issue(
              matchingImages.length === 0
                ? "SKU_IMAGE_OVERRIDE_FILE_NOT_FOUND"
                : "SKU_IMAGE_OVERRIDE_FILE_DUPLICATE",
              "error",
              resolution.reason,
              {
                specification: entries[0].rawSpecification,
                normalizedSpecification,
                filename: rawFilename,
                normalizedFilename,
                matchCount: matchingImages.length,
                imageIndexes: freezeArray(
                  matchingImages.map((entry) => entry.imageIndex)
                )
              }
            )
          );
          continue;
        }

        const resolution = {
          ok: true,
          imageEntry: matchingImages[0],
          normalizedFilename
        };
        overrideBySpecification.set(normalizedSpecification, resolution);
        approvedOverrideImageIndexes.add(matchingImages[0].imageIndex);
      }
    }

    for (const entry of imageEntries) {
      const { imageIndex, parsed } = entry;
      if (
        !parsed.ok &&
        parsed.unsupported &&
        !approvedOverrideImageIndexes.has(imageIndex)
      ) {
        const record = imageRecords[imageIndex];
        const unsupported = freezeObject({
          imageIndex,
          image: record,
          normalizedName: parsed.normalizedName,
          reason: parsed.reason
        });
        unsupportedImages.push(unsupported);
        issues.push(
          issue(
            "SKU_IMAGE_UNSUPPORTED_UNUSED",
            "warning",
            `Unsupported SKU image is ignored: ${parsed.originalName}.`,
            {
              imageIndex,
              name: parsed.originalName,
              reason: parsed.reason
            }
          )
        );
        continue;
      }
      if (!parsed.ok && !approvedOverrideImageIndexes.has(imageIndex)) {
        const record = imageRecords[imageIndex];
        const invalid = freezeObject({
          imageIndex,
          image: record,
          normalizedName: parsed.normalizedName,
          reason: parsed.reason
        });
        invalidImages.push(invalid);
        issues.push(
          issue(
            "SKU_IMAGE_NAME_INVALID",
            "error",
            `Invalid SKU image filename: ${parsed.originalName || "(missing name)"}.`,
            {
              imageIndex,
              name: parsed.originalName,
              normalizedName: parsed.normalizedName,
              reason: parsed.reason
            }
          )
        );
        continue;
      }
      if (!parsed.ok) continue;
      validImages.push(entry);
    }

    const skuCountByKey = new Map();
    for (const entry of parsedRows) {
      if (!entry.parsed.ok) continue;
      const key = matchingKey(entry.parsed, includeQuantity === true);
      skuCountByKey.set(
        key,
        (skuCountByKey.get(key) || 0) + 1
      );
    }

    const missingByKey = new Map();
    const ambiguousByKey = new Map();
    const rowDrafts = parsedRows.map((entry) => {
      const override = overrideBySpecification.get(
        entry.normalizedSpecification
      );
      if (override) {
        const key = entry.parsed.ok
          ? matchingKey(entry.parsed, includeQuantity === true)
          : null;
        if (!override.ok) {
          return {
            index: entry.index,
            skuIndex: entry.index,
            specification: entry.specification,
            semanticKey: key,
            image: null,
            imageIndex: null,
            semanticSharedCount: entry.parsed.ok
              ? skuCountByKey.get(key) || 1
              : 0,
            status: "OVERRIDE_ERROR",
            matchRule: "explicit_override"
          };
        }
        return {
          index: entry.index,
          skuIndex: entry.index,
          specification: entry.specification,
          semanticKey: key,
          image: override.imageEntry.image,
          imageIndex: override.imageEntry.imageIndex,
          semanticSharedCount: 0,
          status: "MATCHED_OVERRIDE",
          matchRule: "explicit_override"
        };
      }

      if (!entry.parsed.ok) {
        issues.push(
          issue(
            "SKU_SPECIFICATION_INVALID",
            "error",
            `Cannot derive a strict SKU image key for SKU index ${entry.index}.`,
            {
              skuIndex: entry.index,
              specification: entry.specification,
              normalizedSpecification: entry.parsed.normalized,
              reason: entry.parsed.reason
            }
          )
        );
        return {
          index: entry.index,
          skuIndex: entry.index,
          specification: entry.specification,
          semanticKey: null,
          image: null,
          imageIndex: null,
          semanticSharedCount: 0,
          status: "invalid-specification",
          matchRule: null
        };
      }

      const key = matchingKey(entry.parsed, includeQuantity === true);
      const candidates = matchingImages(entry.parsed, validImages, includeQuantity);
      const sharedCount = skuCountByKey.get(key) || 1;
      if (candidates.length === 0) {
        const missing = missingByKey.get(key) || {
          semanticKey: key,
          skuIndexes: [],
          specifications: []
        };
        missing.skuIndexes.push(entry.index);
        missing.specifications.push(entry.specification);
        missingByKey.set(key, missing);
        return {
          index: entry.index,
          skuIndex: entry.index,
          specification: entry.specification,
          semanticKey: key,
          image: null,
          imageIndex: null,
          semanticSharedCount: sharedCount,
          status: "missing",
          matchRule: "semantic_key"
        };
      }

      if (candidates.length > 1) {
        const ambiguous = ambiguousByKey.get(key) || {
          semanticKey: key,
          skuIndexes: [],
          specifications: [],
          images: candidates.map((candidate) => candidate.image),
          imageIndexes: candidates.map((candidate) => candidate.imageIndex)
        };
        ambiguous.skuIndexes.push(entry.index);
        ambiguous.specifications.push(entry.specification);
        ambiguousByKey.set(key, ambiguous);
        return {
          index: entry.index,
          skuIndex: entry.index,
          specification: entry.specification,
          semanticKey: key,
          image: null,
          imageIndex: null,
          semanticSharedCount: sharedCount,
          status: "ambiguous",
          matchRule: "semantic_key"
        };
      }

      return {
        index: entry.index,
        skuIndex: entry.index,
        specification: entry.specification,
        semanticKey: key,
        image: candidates[0].image,
        imageIndex: candidates[0].imageIndex,
        semanticSharedCount: sharedCount,
        status: "matched",
        matchRule: "semantic_key"
      };
    });
    const selectedImageCounts = new Map();
    for (const row of rowDrafts) {
      if (row.imageIndex === null) continue;
      selectedImageCounts.set(
        row.imageIndex,
        (selectedImageCounts.get(row.imageIndex) || 0) + 1
      );
    }
    const usedImageIndexes = new Set(selectedImageCounts.keys());
    const planRows = rowDrafts.map((row) =>
      freezeObject({
        index: row.index,
        skuIndex: row.skuIndex,
        specification: row.specification,
        semanticKey: row.semanticKey,
        image: row.image,
        sharedCount:
          row.imageIndex === null
            ? row.semanticSharedCount
            : selectedImageCounts.get(row.imageIndex),
        status: row.status,
        matchRule: row.matchRule
      })
    );

    const missing = Array.from(missingByKey.values(), (entry) =>
      freezeObject({
        semanticKey: entry.semanticKey,
        skuIndexes: freezeArray(entry.skuIndexes),
        specifications: freezeArray(entry.specifications)
      })
    );
    for (const entry of missing) {
      issues.push(
        issue(
          "SKU_IMAGE_MISSING",
          allowMissing ? "warning" : "error",
          `No SKU image exactly matches ${entry.semanticKey}.`,
          {
            semanticKey: entry.semanticKey,
            skuIndexes: entry.skuIndexes,
            specifications: entry.specifications
          }
        )
      );
    }

    const ambiguous = Array.from(ambiguousByKey.values(), (entry) =>
      freezeObject({
        semanticKey: entry.semanticKey,
        skuIndexes: freezeArray(entry.skuIndexes),
        specifications: freezeArray(entry.specifications),
        images: freezeArray(entry.images)
      })
    );
    for (const entry of ambiguous) {
      const imageEntriesForIssue = validImages.filter((imageEntry) =>
        entry.images.includes(imageEntry.image)
      );
      issues.push(ambiguousImageIssue(
        entry.semanticKey,
        imageEntriesForIssue,
        entry.skuIndexes,
        entry.specifications
      ));
    }

    const ambiguousImageIndexes = new Set();
    for (const entry of ambiguousByKey.values()) {
      for (const imageIndex of entry.imageIndexes || []) {
        ambiguousImageIndexes.add(imageIndex);
      }
    }
    const unmatchedImages = validImages
      .filter((entry) => !usedImageIndexes.has(entry.imageIndex))
      .map((entry) =>
        freezeObject({
          imageIndex: entry.imageIndex,
          image: entry.image,
          semanticKey: matchingKey(entry.parsed, includeQuantity === true),
          reason: ambiguousImageIndexes.has(entry.imageIndex)
            ? "ambiguous-candidate"
            : "no-matching-sku"
        })
      );
    for (const entry of unmatchedImages) {
      issues.push(
        issue(
          "SKU_IMAGE_UNUSED",
          "warning",
          `SKU image is not used by the plan: ${entry.image.name}.`,
          {
            imageIndex: entry.imageIndex,
            name: entry.image.name,
            semanticKey: entry.semanticKey,
            reason: entry.reason
          }
        )
      );
    }

    const frozenIssues = freezeArray(issues);
    const frozenWarnings = freezeArray(
      issues.filter((entry) => entry.severity === "warning")
    );
    const frozenRows = freezeArray(planRows);
    const frozenMissing = freezeArray(missing);
    const frozenAmbiguous = freezeArray(ambiguous);
    const frozenInvalidImages = freezeArray(invalidImages);
    const frozenUnsupportedImages = freezeArray(unsupportedImages);
    const frozenUnmatchedImages = freezeArray(unmatchedImages);
    return freezeObject({
      allowMissing,
      completion: missing.length > 0 ? "partial" : "complete",
      count: workbookRows.length,
      rows: frozenRows,
      matchedSkuCount: planRows.filter((row) => row.image !== null).length,
      overrideMatchedSkuCount: planRows.filter(
        (row) => row.status === "MATCHED_OVERRIDE"
      ).length,
      usedImageCount: usedImageIndexes.size,
      sharedGroupCount: Array.from(selectedImageCounts.values()).filter(
        (count) => count > 1
      ).length,
      missing: frozenMissing,
      deferred: allowMissing ? frozenMissing : freezeArray([]),
      deferredRowIndexes: allowMissing
        ? freezeArray(
          planRows
            .filter((row) => row.status === "missing")
            .map((row) => row.index)
        )
        : freezeArray([]),
      ambiguous: frozenAmbiguous,
      invalidImages: frozenInvalidImages,
      unsupportedImages: frozenUnsupportedImages,
      unmatchedImages: frozenUnmatchedImages,
      issues: frozenIssues,
      errorMessage: blockingIssueMessage(issues),
      warnings: frozenWarnings,
      matchMode:
        includeQuantity === null
          ? "invalid_first_image"
          : includeQuantity
            ? "quantity"
            : "spec_color",
      modeSourceName: modeSource ? imageName(modeSource.image) : null,
      ok: !issues.some((entry) => entry.severity === "error")
    });
  }

  return Object.freeze({
    buildSkuImagePlan,
    parseImageKey,
    parseSpecificationKey,
    preflightSkuImageBatch,
    semanticKey
  });
});
