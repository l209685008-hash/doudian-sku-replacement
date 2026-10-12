"use strict";

(function exposeDoudianBuildInfo(root, buildId) {
  root.DoudianBuildInfo = Object.freeze({
    id: buildId,
    managementScanMessage: `DOUDIAN_IMAGE_TEXT_MANAGEMENT_SCAN_V5:${buildId}`
  });
})(globalThis, "2026-10-08-wash-link-add-click-feedback-1.0.87");
