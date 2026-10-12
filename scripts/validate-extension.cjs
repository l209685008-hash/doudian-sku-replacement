"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");

assert.equal(manifest.name, "抖店批量替换SKU");
assert.deepEqual(manifest.host_permissions, ["https://fxg.jinritemai.com/*"]);
assert.equal(html.includes("上架新商品"), false);
assert.equal(html.includes("listingFrame"), false);
assert.match(html, /id="washAddButton"[^>]*>按 Excel 上架 SKU/);
assert.equal(html.includes("图文发布"), false);
assert.match(html, /data-update-submode="replace"/);
assert.match(html, /data-update-submode="offsale"/);
assert.match(html, /data-update-submode="image-swap"/);
assert.match(html, /id="updatePriceInventoryEnabled"/);
assert.match(html, /id="updateSkuImagesEnabled"/);
assert.equal(/chrome\.runtime\.onConnect\.addListener/.test(fs.readFileSync(path.join(root, "background.js"), "utf8")), false);
assert.match(html, /id="updatePriceInventoryInput"/);
assert.match(html, /id="updateSkuImagesInput"/);
assert.match(html, /id="updatePriceInventoryClear"/);
assert.match(html, /id="updateSkuImagesClear"/);
assert.equal(html.includes("updateDirectoryInput"), false);
assert.match(html, /name="updateReplaceScope" value="batch"/);
assert.match(html, /name="updateReplaceScope" value="query"/);
assert.match(html, /name="updateReplaceScope" value="current"/);
assert.match(html, /请输入商品名称\/商品ID\/商家编码，多条可用逗号隔开/);
assert.match(html, /id="updateScopeLink"/);
for (const file of ["update-ui.js", "update-content-script.js", "content-script.js", "vendor/read-excel-file.min.js"]) {
  assert.equal(fs.existsSync(path.join(root, file)), true, `missing ${file}`);
}
console.log("Standalone replacement extension validation passed.");
