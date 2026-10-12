(function initializeUploadState(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.DoudianUploadState = api;
  }
})(globalThis, function createUploadStateApi() {
  "use strict";

  const DOUDIAN_IMAGE_HOST_SUFFIX = ".ecombdimg.com";
  const DOUDIAN_IMAGE_PATH_PREFIX = "/ecom-shop-material/";

  function protocolError(code, message, evidence) {
    const error = new Error(message);
    error.code = code;
    error.evidence = evidence;
    return error;
  }

  function createCommandReceiptJournal(maxEntries = 100) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("maxEntries must be a positive integer.");
    }
    const records = new Map();
    let active = null;

    const receipt = (record) =>
      record.commandId
        ? Object.freeze({
            commandId: record.commandId,
            argsDigest: record.argsDigest,
            command: record.command,
            runToken: record.runToken,
            documentToken: record.documentToken,
            status: record.status
          })
        : null;

    function trim() {
      while (records.size > maxEntries) {
        const oldest = records.entries().next().value;
        if (!oldest || oldest[1] === active) break;
        records.delete(oldest[0]);
      }
    }

    function begin(envelope) {
      const hasCommandId =
        envelope.commandId !== undefined && envelope.commandId !== null;
      const hasArgsDigest =
        envelope.argsDigest !== undefined && envelope.argsDigest !== null;
      if (hasCommandId !== hasArgsDigest) {
        throw protocolError(
          "COMMAND_RECEIPT_ENVELOPE_INVALID",
          "commandId and argsDigest must be supplied together.",
          { commandId: envelope.commandId ?? null }
        );
      }
      if (!hasCommandId) {
        if (active) {
          throw protocolError(
            "COMMAND_IN_FLIGHT",
            "Another command is already running in this document.",
            { activeReceipt: receipt(active), activeCommand: active.command }
          );
        }
        active = { ...envelope, commandId: null, argsDigest: null };
        return { kind: "started", record: active };
      }
      if (
        typeof envelope.commandId !== "string" ||
        envelope.commandId.length < 1 ||
        envelope.commandId.length > 256 ||
        typeof envelope.argsDigest !== "string" ||
        envelope.argsDigest.length < 1 ||
        envelope.argsDigest.length > 256
      ) {
        throw protocolError(
          "COMMAND_RECEIPT_ENVELOPE_INVALID",
          "commandId or argsDigest is invalid.",
          {
            commandId: envelope.commandId,
            argsDigest: envelope.argsDigest
          }
        );
      }

      const existing = records.get(envelope.commandId);
      if (existing) {
        if (
          existing.argsDigest !== envelope.argsDigest ||
          existing.command !== envelope.command
        ) {
          throw protocolError(
            "COMMAND_ID_CONFLICT",
            "commandId was reused with a conflicting command envelope.",
            {
              existing: receipt(existing),
              received: {
                commandId: envelope.commandId,
                argsDigest: envelope.argsDigest,
                command: envelope.command,
                runToken: envelope.runToken
              }
            }
          );
        }
        return existing.status === "running"
          ? { kind: "running", receipt: receipt(existing) }
          : {
              kind: "replay",
              receipt: receipt(existing),
              response: existing.response
            };
      }
      if (active) {
        throw protocolError(
          "COMMAND_IN_FLIGHT",
          "Another command is already running in this document.",
          { activeReceipt: receipt(active), activeCommand: active.command }
        );
      }

      const record = { ...envelope, status: "running", response: null };
      records.set(record.commandId, record);
      active = record;
      trim();
      return { kind: "started", record };
    }

    function finish(claim, status, createResponse) {
      if (claim?.kind !== "started" || claim.record !== active) {
        throw new Error("Command receipt claim is not active.");
      }
      if (status !== "succeeded" && status !== "failed") {
        throw new TypeError("Receipt status must be succeeded or failed.");
      }
      claim.record.status = status;
      const response = createResponse(receipt(claim.record));
      claim.record.response = response;
      active = null;
      trim();
      return response;
    }

    return Object.freeze({
      begin,
      finish,
      size: () => records.size
    });
  }

  function isDoudianMainImageResource(rawUrl, baseUrl) {
    if (!rawUrl) return false;
    try {
      const url = new URL(rawUrl, baseUrl);
      return (
        url.protocol === "https:" &&
        (url.hostname === DOUDIAN_IMAGE_HOST_SUFFIX.slice(1) ||
          url.hostname.endsWith(DOUDIAN_IMAGE_HOST_SUFFIX)) &&
        url.pathname.startsWith(DOUDIAN_IMAGE_PATH_PREFIX)
      );
    } catch {
      return false;
    }
  }

  function isInitialMainContainer(state) {
    return (
      state?.imageInputCount === 5 &&
      state?.mainLabelCount === 1 &&
      state?.auxiliaryLabelCount === 4 &&
      state?.previewCount === 0
    );
  }

  function isVerifiedMainPreviewTransition(
    before,
    after,
    originalControlReplaced
  ) {
    return (
      isInitialMainContainer(before) &&
      after?.globalImageInputCount === 5 &&
      after?.imageInputCount === 5 &&
      after?.nonMultipleImageInputCount === 1 &&
      after?.multipleImageInputCount === 4 &&
      after?.mainLabelCount === 0 &&
      after?.auxiliaryLabelCount === 4 &&
      after?.auxiliaryControlCount === 4 &&
      after?.validAuxiliaryControlCount === 4 &&
      after?.previewCount === 1 &&
      after?.mainPreviewCount === 1 &&
      after?.mainPreviewContainsUniqueInput === true &&
      after?.mainPreviewMediaCount > 0 &&
      after?.mainRemoteResourceCount > 0 &&
      after?.mainInputIndex === before.mainInputIndex &&
      after?.stronglyScoped === true &&
      originalControlReplaced === true
    );
  }

  function assertRunDocumentBinding(
    activeRunToken,
    expectedDocumentToken,
    runToken,
    documentToken
  ) {
    if (
      typeof runToken !== "string" ||
      runToken.length < 8 ||
      runToken.length > 256
    ) {
      const error = new Error("运行令牌无效");
      error.code = "RUN_TOKEN_INVALID";
      throw error;
    }
    if (documentToken !== expectedDocumentToken) {
      const error = new Error("页面文档令牌已失效");
      error.code = "STALE_DOCUMENT_TOKEN";
      error.evidence = {
        expectedDocumentToken,
        receivedDocumentToken: documentToken ?? null
      };
      throw error;
    }
    if (activeRunToken && activeRunToken !== runToken) {
      const error = new Error("运行令牌与当前页面执行不一致");
      error.code = "STALE_RUN_TOKEN";
      error.evidence = {
        activeRunToken,
        receivedRunToken: runToken
      };
      throw error;
    }
    return activeRunToken || runToken;
  }

  return Object.freeze({
    assertRunDocumentBinding,
    createCommandReceiptJournal,
    isDoudianMainImageResource,
    isInitialMainContainer,
    isVerifiedMainPreviewTransition
  });
});
