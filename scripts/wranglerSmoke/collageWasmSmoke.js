// V1.8 — minimal standalone Worker entry, NOT part of the deployed
// traffic-reporter Worker (src/index.js is the real entry point; this
// file is never referenced by it and is never bundled into Production).
// Deliberately lives under scripts/, not test/ — `node --test`'s
// default file discovery auto-runs anything under a directory literally
// named `test`, which would otherwise import this Worker-only file (no
// Response/Workers globals in Node) and spawn a real wrangler process
// as a side effect of every plain `npm test` run.
//
// Exists solely to prove, in a REAL Cloudflare Workers runtime
// (workerd, via `wrangler dev`), that src/cctv/jpegCodecWorker.js's
// static `.wasm` import + init() actually works end to end — encode a
// synthetic image, decode it back, verify the round-trip. Plain
// `node --test` cannot exercise this file's WASM-loading mechanism at
// all (Node has no ESM loader for `.wasm` files, and even with
// `--experimental-wasm-modules` the semantics are incompatible with
// @jsquash/jpeg's `init(module)` API — see jpegCodecWorker.js's module
// comment for the full explanation). This is the "genuine
// workerd/wrangler-compatible" check for that specific gap: it proves
// the ACTUAL Workers WASM-module-import mechanism (a precompiled
// `WebAssembly.Module` handed to `new WebAssembly.Instance(module,
// imports)` — never `WebAssembly.compile()`/`instantiate(bufferSource)`,
// both of which Workers' runtime disallows) works for real, not just in
// theory.
//
// Manual run (see also npm run smoke:wasm, which automates exactly this):
//   npx wrangler dev scripts/wranglerSmoke/collageWasmSmoke.js --local --port 18787
//   curl http://localhost:18787/
// Expect: {"ok":true, "isJpeg":true, "dimsMatch":true, "colorClose":true, ...}

import { decodeJpeg, encodeJpeg } from '../../src/cctv/jpegCodecWorker.js';

export default {
  async fetch() {
    try {
      const width = 8;
      const height = 8;
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i += 1) {
        data[i * 4] = 200;
        data[i * 4 + 1] = 50;
        data[i * 4 + 2] = 50;
        data[i * 4 + 3] = 255;
      }

      const encoded = await encodeJpeg({ data, width, height }, { quality: 80 });
      const encodedBytes = new Uint8Array(encoded);
      const isJpeg = encodedBytes[0] === 0xff && encodedBytes[1] === 0xd8;

      const decoded = await decodeJpeg(encodedBytes);
      const dimsMatch = decoded.width === width && decoded.height === height;
      const pixel = [decoded.data[0], decoded.data[1], decoded.data[2]];
      const colorClose = Math.abs(pixel[0] - 200) < 20 && Math.abs(pixel[1] - 50) < 20 && Math.abs(pixel[2] - 50) < 20;

      const ok = isJpeg && dimsMatch && colorClose;
      return Response.json({
        ok,
        isJpeg,
        dimsMatch,
        colorClose,
        encodedByteLength: encodedBytes.length,
        decodedDims: [decoded.width, decoded.height],
        pixel,
      });
    } catch (err) {
      return Response.json({ ok: false, error: String((err && err.stack) || err) }, { status: 500 });
    }
  },
};
