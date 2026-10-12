(function initializeBinaryPayload(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.DoudianBinary = api;
  }
})(globalThis, function createBinaryPayloadApi() {
  "use strict";

  function encodeBytesToBase64(bytes) {
    const chunkSize = 8192;
    const binaryChunks = [];

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, bytes.length);
      let binaryChunk = "";
      for (let index = offset; index < end; index += 1) {
        binaryChunk += String.fromCharCode(bytes[index]);
      }
      binaryChunks.push(binaryChunk);
    }

    return btoa(binaryChunks.join(""));
  }

  function decodeBase64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function md5Hex(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected Uint8Array bytes.");
    const sourceLength = bytes.byteLength;
    const bitLength = sourceLength * 8;
    if (!Number.isSafeInteger(bitLength)) throw new RangeError("Payload is too large to hash safely.");
    const paddingLength = (56 - ((sourceLength + 1) % 64) + 64) % 64;
    const padded = new Uint8Array(sourceLength + 1 + paddingLength + 8);
    padded.set(bytes);
    padded[sourceLength] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.byteLength - 8, bitLength >>> 0, true);
    view.setUint32(padded.byteLength - 4, Math.floor(bitLength / 0x100000000), true);
    const shifts = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const constants = [0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391];
    const rotateLeft = (value, amount) => (value << amount) | (value >>> (32 - amount));
    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    for (let offset = 0; offset < padded.byteLength; offset += 64) {
      const words = Array.from({ length: 16 }, (_, index) => view.getInt32(offset + index * 4, true));
      let a = a0;
      let b = b0;
      let c = c0;
      let d = d0;
      for (let index = 0; index < 64; index += 1) {
        let f;
        let g;
        if (index < 16) { f = (b & c) | (~b & d); g = index; }
        else if (index < 32) { f = (d & b) | (~d & c); g = (5 * index + 1) % 16; }
        else if (index < 48) { f = b ^ c ^ d; g = (3 * index + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * index) % 16; }
        const next = (b + rotateLeft((a + f + constants[index] + words[g]) | 0, shifts[index])) | 0;
        a = d;
        d = c;
        c = b;
        b = next;
      }
      a0 = (a0 + a) | 0;
      b0 = (b0 + b) | 0;
      c0 = (c0 + c) | 0;
      d0 = (d0 + d) | 0;
    }
    return [a0, b0, c0, d0].map((word) => Array.from({ length: 4 }, (_, index) => ((word >>> (index * 8)) & 0xff).toString(16).padStart(2, "0")).join("")).join("");
  }

  async function fileToPayload(file) {
    if (!file || typeof file.arrayBuffer !== "function") {
      throw new TypeError("Expected a File-like object with arrayBuffer().");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== Number(file.size)) {
      throw new Error("Read byte length does not match the selected file size.");
    }

    return {
      name: String(file.name),
      type: String(file.type || ""),
      size: Number(file.size),
      lastModified: Number(file.lastModified),
      base64: encodeBytesToBase64(bytes)
    };
  }

  function payloadToBytes(payload) {
    if (
      !payload ||
      typeof payload.name !== "string" ||
      typeof payload.type !== "string" ||
      !Number.isSafeInteger(payload.size) ||
      payload.size < 0 ||
      !Number.isSafeInteger(payload.lastModified) ||
      payload.lastModified < 0 ||
      typeof payload.base64 !== "string"
    ) {
      throw new TypeError("Invalid JSON-safe file payload.");
    }

    const bytes = decodeBase64ToBytes(payload.base64);
    if (bytes.byteLength !== payload.size) {
      throw new Error("Decoded byte length does not match payload metadata.");
    }
    return bytes;
  }

  function payloadToFile(payload) {
    const bytes = payloadToBytes(payload);
    return new File([bytes], payload.name, {
      type: payload.type,
      lastModified: payload.lastModified
    });
  }

  return Object.freeze({
    decodeBase64ToBytes,
    encodeBytesToBase64,
    fileToPayload,
    md5Hex,
    payloadToBytes,
    payloadToFile
  });
});
