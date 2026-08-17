// V1.8 — mozjpeg WASM codec wiring for the CCTV collage engine
// (src/cctv/collage.js). Pure JS glue: decode/encode a JPEG buffer to/
// from raw RGBA pixel data via @jsquash/jpeg's mozjpeg-based WASM codecs.
//
// Why base64-embedded WASM bytes instead of a Cloudflare-Workers-style
// `import mod from './x.wasm'`:
//   - This project's test suite runs under plain `node --test` (no
//     `--experimental-wasm-modules`, and even with that flag Node's
//     ESM-WASM semantics differ from Cloudflare's — Node auto-
//     instantiates and exposes the WASM's own exports, whereas jSquash's
//     `init(module)` expects a raw, un-instantiated `WebAssembly.Module`
//     to hand to its own `instantiateWasm` hook). A top-level
//     `import mod from '*.wasm'` in ANY file reachable from
//     src/index.js would break Node's module loader immediately for the
//     ENTIRE test suite, since every test file imports src/index.js.
//   - This sandbox also has no way to live-verify wrangler's own
//     `.wasm` import bundling against a real Cloudflare deploy (no
//     credentials, network egress to Cloudflare is blocked here).
//   - `WebAssembly.compile()`/`instantiate()` on raw bytes, by contrast,
//     is standard, Workers-supported, and something that can be (and
//     was) fully exercised locally under plain `node --test` — the
//     EXACT same code path runs in tests and in production, with no
//     environment-specific branching anywhere in this file.
//
// See src/cctv/generated/jpegWasmAssets.js for the embedded binaries
// (base64 of the exact @jsquash/jpeg version pinned in package.json).
//
// This module never imports anything TDX-related — see
// tdx/hsinchuCctvProbe.js's module comment for why that matters (0 TDX
// calls, enforced by the import graph itself).

import decodeJpegFn, { init as initJpegDecode } from '@jsquash/jpeg/decode.js';
import encodeJpegFn, { init as initJpegEncode } from '@jsquash/jpeg/encode.js';
import { MOZJPEG_DEC_WASM_BASE64, MOZJPEG_ENC_WASM_BASE64 } from './generated/jpegWasmAssets.js';

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Memoized per isolate/process — compiling ~400KB of WASM on every call
// would be wasteful; both mozjpeg modules are compiled and handed to
// jSquash's own module-level init() exactly once.
let readyPromise;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const [decodeModule, encodeModule] = await Promise.all([
        WebAssembly.compile(base64ToBytes(MOZJPEG_DEC_WASM_BASE64)),
        WebAssembly.compile(base64ToBytes(MOZJPEG_ENC_WASM_BASE64)),
      ]);
      await Promise.all([initJpegDecode(decodeModule), initJpegEncode(encodeModule)]);
    })();
  }
  return readyPromise;
}

/** @returns {Promise<{data: Uint8ClampedArray, width: number, height: number}>} */
export async function decodeJpeg(bytes) {
  await ensureReady();
  return decodeJpegFn(bytes);
}

/** @param {{data: Uint8ClampedArray, width: number, height: number}} imageData
 *  @returns {Promise<ArrayBuffer>} */
export async function encodeJpeg(imageData, options) {
  await ensureReady();
  return encodeJpegFn(imageData, options);
}
