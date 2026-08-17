// V1.8 — TEST-ONLY Node-side JPEG codec. NEVER imported from anything
// under src/ — nothing here ships to Cloudflare Workers.
//
// Loads the real @jsquash/jpeg WASM binaries straight from node_modules
// via `fs.readFileSync` + `WebAssembly.compile()`. That combination is
// forbidden inside a deployed Worker (see
// src/cctv/jpegCodecWorker.js's module comment for why), but it is
// perfectly fine here: this file is test infrastructure that runs under
// plain Node, never under workerd, and Node has no built-in loader for
// static `.wasm` ESM imports (nor would Node's own
// `--experimental-wasm-modules` semantics be compatible with
// @jsquash/jpeg's `init(module)` API even if enabled — see
// jpegCodecWorker.js for the full explanation). Using
// `WebAssembly.compile()` here is the ordinary, unrestricted way any
// Node program loads WASM — no Workers-specific constraint applies to
// test code.
//
// Exposes the exact same `decodeJpeg`/`encodeJpeg` async function shape
// as jpegCodecWorker.js so tests can inject either interchangeably into
// src/cctv/collage.js (pure dependency injection — see that module) or
// into tdx/hsinchuCctvProbe.js's handleHsinchuCctvCollage's codec
// override parameter.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import decodeJpegFn, { init as initJpegDecode } from '@jsquash/jpeg/decode.js';
import encodeJpegFn, { init as initJpegEncode } from '@jsquash/jpeg/encode.js';

const require = createRequire(import.meta.url);

let readyPromise;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const decodeBytes = readFileSync(require.resolve('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'));
      const encodeBytes = readFileSync(require.resolve('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'));
      const [decodeModule, encodeModule] = await Promise.all([WebAssembly.compile(decodeBytes), WebAssembly.compile(encodeBytes)]);
      await Promise.all([initJpegDecode(decodeModule), initJpegEncode(encodeModule)]);
    })();
  }
  return readyPromise;
}

export async function decodeJpeg(bytes) {
  await ensureReady();
  return decodeJpegFn(bytes);
}

export async function encodeJpeg(imageData, options) {
  await ensureReady();
  return encodeJpegFn(imageData, options);
}
