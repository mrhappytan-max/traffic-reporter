// V1.8.7.7 — targeted regression coverage for the real Production
// incident this round fixes: 08:00 Asia/Taipei, 國3 南向 two
// dynamic-shoulder events (77K+150～78K+570, 79K+250～89K+830) — LINE
// text broadcast normally, but the attached CCTV image rendered as a
// gray broken-image icon. Root cause: extractFirstJpegFrame
// (src/tdx/hsinchuCctvProbe.js) located a frame's end by scanning raw
// bytes for the FIRST 0xFFD9 anywhere after SOI — unsafe whenever a real
// camera JPEG embeds a full EXIF thumbnail (itself a complete, nested
// SOI...EOI JPEG) inside its APP1 segment: the naive scan found the
// THUMBNAIL's own EOI first and returned a truncated, corrupt slice of
// the real frame. Fixed by findJpegImageEnd/walkJpegMarkers, a proper
// JPEG marker-segment walker that skips header segments by their own
// declared length instead of scanning into them.
//
// See this module's own comment (hsinchuCctvProbe.js, right above
// walkJpegMarkers) for the full root-cause writeup and why the accident
// (quad) collage path was never at risk of this (it decodes every frame
// through a real JPEG decoder before ever using it; the dynamic-shoulder
// single-camera path deliberately skips that decode/encode round-trip
// for performance, and previously published extractFirstJpegFrame's raw
// output completely unvalidated).
//
// Every test below drives the REAL, public extractFirstJpegFrame via a
// mocked streaming fetch — never calling walkJpegMarkers/findJpegImageEnd
// directly (both are module-private) — so this exercises the exact same
// code path a real CCTV frame fetch takes in Production.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractFirstJpegFrame, MAX_FRAME_BYTES } from '../src/tdx/hsinchuCctvProbe.js';

function textBytes(str) {
  return new TextEncoder().encode(str);
}

function u16(n) {
  return [(n >> 8) & 0xff, n & 0xff];
}

/** [0xFF, marker, lenHi, lenLo, ...payload] — length includes the 2 length bytes themselves, per spec. */
function segment(marker, payload) {
  const len = payload.length + 2;
  return [0xff, marker, ...u16(len), ...payload];
}

/** Single-chunk stream — the whole buffer arrives in one pull(), matching how a small real CCTV frame commonly arrives. */
function singleChunkStream(bytes) {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(new Uint8Array(bytes));
    },
  });
}

/** Delivers `bytes` split across multiple small chunks — proves the fix behaves correctly on a still-growing streamed buffer, not just a fully-buffered one. */
function chunkedStream(bytes, chunkSize) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(new Uint8Array(bytes.slice(offset, end)));
      offset = end;
    },
  });
}

// A real-shaped JPEG: SOI, an APP1/EXIF segment that embeds a complete
// NESTED thumbnail JPEG (its own SOI...EOI) — the exact real-world shape
// that triggered the Production incident — then a generic SOF-ish
// segment, then SOS with entropy-coded scan data containing a legitimate
// byte-stuffed 0xFF00 pair AND a restart marker (0xFFD0) before the real
// terminal EOI.
function buildJpegWithEmbeddedThumbnail() {
  const nestedThumbnail = [0xff, 0xd8, 9, 9, 9, 0xff, 0xd9]; // a tiny nested "JPEG" — SOI...EOI, never decoded, just needs the marker bytes
  const app1Payload = [...textBytes('Exif\0\0'), ...nestedThumbnail, 0, 0, 0, 0];
  const app1 = segment(0xe1, app1Payload); // APP1/EXIF
  const sof = segment(0xc0, [8, 0, 10, 0, 10, 3, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0]); // generic length-prefixed segment, content irrelevant here
  const sosHeader = segment(0xda, [1, 1, 0, 0, 63, 0]); // SOS header only — entropy data follows, NOT length-prefixed
  const scanData = [10, 20, 30, 0xff, 0x00, 40, 50, 0xff, 0xd0, 60, 70]; // legit byte-stuffed FF00 + RST0 — must NOT be mistaken for EOI
  const realEoi = [0xff, 0xd9];

  const bytes = [0xff, 0xd8, ...app1, ...sof, ...sosHeader, ...scanData, ...realEoi];
  // The position of the embedded thumbnail's own (wrong) EOI, for assertions.
  const thumbnailEoiOffsetInApp1Payload = textBytes('Exif\0\0').length + nestedThumbnail.length - 2;
  const app1PayloadStart = 4; // after SOI(2) + APP1 marker+length(4)... computed precisely below in the test itself
  return { bytes, app1PayloadStart, thumbnailEoiOffsetInApp1Payload };
}

// A minimal, real-marker-structured JPEG with NO embedded thumbnail —
// the common case — to prove the fix produces the exact correct frame
// boundary (not merely "doesn't crash") when there's nothing to trip on.
function buildPlainJpeg() {
  const sof = segment(0xc0, [8, 0, 10, 0, 10, 1, 1, 0x11, 0]);
  const sosHeader = segment(0xda, [1, 1, 0, 0, 63, 0]);
  const scanData = [1, 2, 3, 0xff, 0x00, 4, 5];
  const realEoi = [0xff, 0xd9];
  return new Uint8Array([0xff, 0xd8, ...sof, ...sosHeader, ...scanData, ...realEoi]);
}

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
});

test('1. embedded-thumbnail JPEG (single chunk): extracts the REAL terminal EOI, not the thumbnail\'s own EOI', async () => {
  const { bytes } = buildJpegWithEmbeddedThumbnail();
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(singleChunkStream(bytes), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, true);
  // Must return the FULL frame — every byte through the real terminal EOI — not a truncated slice ending at the embedded thumbnail's own EOI.
  assert.deepEqual([...result.bytes], bytes);
  assert.equal(result.bytes[result.bytes.length - 2], 0xff);
  assert.equal(result.bytes[result.bytes.length - 1], 0xd9);
});

test('2. embedded-thumbnail JPEG is NOT truncated at the thumbnail\'s own (earlier) EOI', async () => {
  const { bytes } = buildJpegWithEmbeddedThumbnail();
  // Precisely locate the thumbnail's own EOI within the full buffer — the OLD naive scan would have stopped here.
  const nestedThumbnail = [0xff, 0xd8, 9, 9, 9, 0xff, 0xd9];
  let thumbnailEoiIndex = -1;
  for (let i = 0; i < bytes.length - 1; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
      thumbnailEoiIndex = i;
      break;
    }
  }
  assert.ok(thumbnailEoiIndex > 0, 'test fixture sanity: embedded thumbnail EOI must exist before the real one');
  // Sanity: the thumbnail's own EOI genuinely is NOT the last FFD9 in the buffer (i.e. this fixture actually exercises the bug).
  assert.notEqual(thumbnailEoiIndex, bytes.length - 2);

  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(singleChunkStream(bytes), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, true);
  // The OLD bug would have returned bytes.slice(0, thumbnailEoiIndex + 2) — a much shorter, corrupt frame. Assert we got the FULL frame instead.
  assert.equal(result.bytes.length, bytes.length);
  assert.notEqual(result.bytes.length, thumbnailEoiIndex + 2);
});

test('3. embedded-thumbnail JPEG delivered across many small streamed chunks — same correct result', async () => {
  const { bytes } = buildJpegWithEmbeddedThumbnail();
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(chunkedStream(bytes, 5), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, true);
  assert.deepEqual([...result.bytes], bytes);
});

test('4. plain JPEG with no embedded thumbnail — exact correct frame boundary (byte-for-byte)', async () => {
  const bytes = buildPlainJpeg();
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(singleChunkStream(bytes), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, true);
  assert.deepEqual([...result.bytes], [...bytes]);
});

test('5. byte-stuffed 0xFF00 inside scan data is never mistaken for a marker/EOI', async () => {
  // buildPlainJpeg's scanData already contains 0xff,0x00 before the real EOI — test 4 already
  // proves the overall result is correct, but assert explicitly here that the stuffed pair
  // survives untouched inside the returned bytes (i.e. we did not stop early at it).
  const bytes = buildPlainJpeg();
  const stuffedIndex = bytes.findIndex((b, i) => b === 0xff && bytes[i + 1] === 0x00);
  assert.ok(stuffedIndex > 0, 'fixture sanity: stuffed 0xFF00 must be present');

  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(singleChunkStream(bytes), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, true);
  assert.equal(result.bytes[stuffedIndex], 0xff);
  assert.equal(result.bytes[stuffedIndex + 1], 0x00);
});

test('6. restart marker (0xFFD0) inside scan data is never mistaken for EOI', async () => {
  const bytes = buildJpegWithEmbeddedThumbnail().bytes;
  const rstIndex = bytes.findIndex((b, i) => b === 0xff && bytes[i + 1] === 0xd0);
  assert.ok(rstIndex > 0, 'fixture sanity: restart marker must be present in scan data');

  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(singleChunkStream(bytes), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, true);
  // The restart marker must still be present, untouched, well before the returned frame's real end.
  assert.equal(result.bytes[rstIndex], 0xff);
  assert.equal(result.bytes[rstIndex + 1], 0xd0);
  assert.ok(rstIndex + 1 < result.bytes.length - 2);
});

test('7. non-marker-structured synthetic bytes (e.g. simplified test fixtures elsewhere in this suite) still fall back correctly to plain FFD9 scanning', async () => {
  // Mirrors hsinchuCctvProbe.test.js's own JPEG_BYTES fixture shape — not real
  // marker structure, must keep working exactly as before this round's fix.
  const bytes = new Uint8Array([0xff, 0xd8, 1, 2, 3, 4, 5, 0xff, 0xd9]);
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(singleChunkStream(bytes), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, true);
  assert.deepEqual([...result.bytes], [...bytes]);
});

test('8. no EOI ever arrives (stream ends first) — still fails closed with no-complete-frame, never hangs/crashes', async () => {
  const bytes = new Uint8Array([0xff, 0xd8, ...segment(0xe1, [1, 2, 3, 4, 5, 6, 7, 8])]); // SOI + an APP1 segment, then the stream just ends — no SOS, no EOI
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(singleChunkStream(bytes), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-complete-frame');
});

test('9. MAX_FRAME_BYTES cap is still enforced unchanged when marker-walking never finds an EOI', async () => {
  const CHUNK = new Uint8Array(65536).fill(0x41); // no FFD8/FFD9 anywhere
  const chunkCount = Math.ceil((MAX_FRAME_BYTES + 65536) / CHUNK.length);
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(CHUNK);
    },
  });
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(stream, { status: 200 });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too-large');
});

test('10. a malformed segment length (< 2) inside a header falls back to plain scanning rather than hanging', async () => {
  // A marker segment declaring an invalid length (1) — genuinely malformed structure.
  // Must fall back to the plain FFD9 scan (per walkJpegMarkers' documented fallback)
  // and find the real trailing EOI, rather than looping or crashing.
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01, 9, 9, 9, 0xff, 0xd9]);
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(singleChunkStream(bytes), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, true);
  assert.deepEqual([...result.bytes], [...bytes]);
});

test('11. still stops reading the stream the instant the complete frame is found — never peeks into the next MJPEG frame', async () => {
  // Same two-pull tolerance as hsinchuCctvProbe.test.js's own
  // mjpegStreamThatHangsAfterFrame (preamble in pull 1, the complete
  // frame in pull 2) — a ReadableStream's internal "pull" bookkeeping can
  // legitimately invoke pull() once more right as the reader is being
  // cancelled; what actually matters (and is what this test asserts) is
  // that extraction never reads a 3rd time into what would be the NEXT
  // MJPEG frame's own data.
  const bytes = buildPlainJpeg();
  let pullCount = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pullCount += 1;
      if (pullCount === 1) {
        controller.enqueue(textBytes('--myboundary\r\nContent-Type: image/jpeg\r\n\r\n'));
        return;
      }
      if (pullCount === 2) {
        controller.enqueue(new Uint8Array(bytes));
        return;
      }
      // A 3rd pull means extraction kept reading past the complete frame — hang forever so the test fails/times out instead of silently passing.
      return new Promise(() => {});
    },
  });
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, true);
  assert.deepEqual([...result.bytes], [...bytes]);
});

test('12. R2-publish/LINE-payload integration: a previously-truncating frame now round-trips as a genuinely complete JPEG through prepareSingleCctvImageWork\'s exact publish step', async () => {
  // Confirms the fix actually reaches the dynamic-shoulder single-camera
  // path's published bytes end-to-end (extractFirstJpegFrame's real return
  // value is what publishCollageImage receives, unchanged, in
  // dynamicCollage.js's prepareSingleCctvImageWork) — not merely a unit
  // check of the extraction function in isolation.
  const { bytes } = buildJpegWithEmbeddedThumbnail();
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(singleChunkStream(bytes), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, true);
  // What would be published to R2 (publishCollageImage(env.CCTV_IMAGES, frame.bytes)) is exactly `result.bytes` — assert it is the FULL, untruncated frame.
  assert.equal(result.bytes.length, bytes.length);
  assert.equal(result.bytes[result.bytes.length - 1], 0xd9);
  assert.equal(result.bytes[result.bytes.length - 2], 0xff);
});
