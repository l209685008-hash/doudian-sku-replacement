(function initializeSpecificationXlsx(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DoudianSpecificationXlsx = api;
})(globalThis, function createSpecificationXlsxApi() {
  "use strict";

  const encoder = new TextEncoder();
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let value = 0; value < 256; value += 1) {
      let crc = value;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
      table[value] = crc >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function xmlText(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
    })[character]);
  }

  function specificationKey(value) {
    return String(value ?? "").normalize("NFKC").replace(/\s+/g, "").trim();
  }

  function createAppendSpecificationPlan(expectedExisting, observedExisting, additions) {
    const expected = Array.isArray(expectedExisting) ? expectedExisting.map((value) => String(value ?? "").trim()).filter(Boolean) : [];
    const observed = Array.isArray(observedExisting) ? observedExisting.map((value) => String(value ?? "").trim()).filter(Boolean) : [];
    const added = Array.isArray(additions) ? additions.map((value) => String(value ?? "").trim()) : [];
    const counts = (values) => {
      const result = new Map();
      for (const value of values) {
        const key = specificationKey(value);
        result.set(key, (result.get(key) || 0) + 1);
      }
      return result;
    };
    const expectedCounts = counts(expected);
    const observedCounts = counts(observed);
    const additionCounts = counts(added);
    const missingSpecifications = [];
    const unexpectedSpecifications = [];
    for (const [key, count] of expectedCounts) {
      const difference = count - (observedCounts.get(key) || 0);
      if (difference > 0) missingSpecifications.push(...Array(difference).fill(expected.find((value) => specificationKey(value) === key) || key));
    }
    for (const [key, count] of observedCounts) {
      const difference = count - (expectedCounts.get(key) || 0);
      if (difference > 0) unexpectedSpecifications.push(...Array(difference).fill(observed.find((value) => specificationKey(value) === key) || key));
    }
    const emptyAdditions = added.filter((value) => !specificationKey(value));
    const additionsMatchingExisting = added.filter((value) => expectedCounts.has(specificationKey(value)));
    const duplicateAdditions = added.filter((value) => (additionCounts.get(specificationKey(value)) || 0) > 1 && Boolean(specificationKey(value)));
    const duplicateExisting = expected.filter((value) => (expectedCounts.get(specificationKey(value)) || 0) > 1);
    const invalidAdditions = [...new Set([...emptyAdditions, ...additionsMatchingExisting, ...duplicateAdditions])];
    const validation = Object.freeze({
      emptyAdditionCount: emptyAdditions.length,
      additionMatchesExistingCount: additionsMatchingExisting.length,
      duplicateAdditionCount: duplicateAdditions.length,
      duplicateExistingCount: duplicateExisting.length,
      additionMatchesExistingSamples: Object.freeze([...new Set(additionsMatchingExisting)].slice(0, 5)),
      duplicateAdditionSamples: Object.freeze([...new Set(duplicateAdditions)].slice(0, 5)),
      duplicateExistingSamples: Object.freeze([...new Set(duplicateExisting)].slice(0, 5))
    });
    const ok = expected.length > 0 && expected.every(Boolean) && added.length > 0 &&
      emptyAdditions.length === 0 && additionsMatchingExisting.length === 0 &&
      duplicateAdditions.length === 0 && duplicateExisting.length === 0;
    return Object.freeze({
      ok,
      existingSpecifications: Object.freeze(expected),
      expectedSpecifications: Object.freeze([...expected, ...added]),
      missingSpecifications: Object.freeze(missingSpecifications),
      unexpectedSpecifications: Object.freeze(unexpectedSpecifications),
      invalidAdditions: Object.freeze(invalidAdditions),
      validation
    });
  }

  function zipStored(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const [name, content] of entries) {
      const nameBytes = encoder.encode(name);
      const data = encoder.encode(content);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length + data.length);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);
      local.set(data, 30 + nameBytes.length);
      localParts.push(local);

      const central = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);
      offset += local.length;
    }
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);
    const parts = [...localParts, ...centralParts, end];
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let cursor = 0;
    for (const part of parts) {
      output.set(part, cursor);
      cursor += part.length;
    }
    return output;
  }

  function createSpecificationWorkbook(specifications) {
    if (!Array.isArray(specifications) || specifications.length === 0) throw new TypeError("At least one specification is required.");
    const values = specifications.map((value) => String(value ?? "").trim());
    if (values.some((value) => !value) || new Set(values).size !== values.length) throw new TypeError("Specifications must be nonempty and unique.");
    const rows = ["规格", ...values].map((value, index) => {
      const row = index + 1;
      return `<row r="${row}"><c r="A${row}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c></row>`;
    }).join("");
    const entries = [
      ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
      ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ["xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="规格" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
      ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`]
    ];
    return zipStored(entries);
  }

  return Object.freeze({ createAppendSpecificationPlan, createSpecificationWorkbook });
});
