// V1.8 — Cloudflare Workers PRODUCTION WASM codec wiring for the CCTV
// collage engine (src/cctv/collage.js). This is the ONLY WASM-loading
// mechanism Cloudflare Workers actually supports at request time:
// importing a .wasm file directly as an ES module, which the Workers
// platform bundler (wrangler) precompiles at deploy time and hands back
// as an already-compiled `WebAssembly.Module` — the Worker isolate never
// compiles WASM itself.
//
// CORRECTION (post-review, V1.8): an earlier version of this file used
// base64-embedded WASM bytes decoded via `WebAssembly.compile()` at
// runtime. That does NOT work in Production — Cloudflare Workers'
// runtime explicitly disallows WebAssembly.compile(),
// WebAssembly.compileStreaming(), WebAssembly.instantiate(bufferSource),
// and WebAssembly.instantiateStreaming() (all of which involve
// COMPILING WASM inside the isolate at request time). It was a mistake
// made in a sandbox with no way to verify wrangler's `.wasm`-import
// bundling against a real Cloudflare deploy — see PROJECT_HANDOFF.md's
// V1.8 section for the full history. This file replaces it with the
// real, supported mechanism: no `WebAssembly.compile*`/
// `WebAssembly.instantiate(bufferSource)` anywhere below — only
// `new WebAssembly.Instance(alreadyCompiledModule, imports)`, performed
// internally by @jsquash/jpeg's own `init()` (see
// node_modules/@jsquash/jpeg/utils.js's `initEmscriptenModule`), which
// is the standard, platform-supported way to instantiate an
// already-compiled module — no compilation happens here at all.
//
// This file is Workers-production-only and must NEVER be imported at
// the top level of anything reachable from a plain `node --test` run
// (src/index.js, src/tdx/hsinchuCctvProbe.js) — Node has no built-in
// ESM loader for `.wasm` files, and even with
// `--experimental-wasm-modules` enabled, Node's WASM-ESM integration
// auto-instantiates the module and exposes ITS OWN exports directly,
// which is a fundamentally different shape than the raw
// `WebAssembly.Module` @jsquash/jpeg's `init()` expects to instantiate
// itself — the two runtimes are genuinely incompatible here, not just a
// missing flag. See tdx/hsinchuCctvProbe.js's module comment for how
// this file is loaded lazily (via dynamic `import()`, only when the
// collage endpoint's handler actually runs) so importing/parsing
// index.js or hsinchuCctvProbe.js in Node never touches this file, and
// see test/testJpegCodec.js for the Node-side TEST-ONLY equivalent
// (which legitimately uses WebAssembly.compile() — that file never
// ships to Production, so the Workers restriction doesn't apply to it).

import decodeJpegFn, { init as initJpegDecode } from '@jsquash/jpeg/decode.js';
import encodeJpegFn, { init as initJpegEncode } from '@jsquash/jpeg/encode.js';
import jpegDecodeModule from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';
import jpegEncodeModule from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm';

// Memoized per isolate — @jsquash/jpeg's init() is cheap here (no
// compilation, just handing the pre-compiled Module to its own
// instantiateWasm hook), but there's no reason to redo it per request.
let readyPromise;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = Promise.all([initJpegDecode(jpegDecodeModule), initJpegEncode(jpegEncodeModule)]);
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
