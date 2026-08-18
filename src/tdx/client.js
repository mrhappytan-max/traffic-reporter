// Thin fetch wrapper for TDX API calls. Never includes the access token
// (or anything derived from the client secret) in error messages.
//
// V1.8.6: optionally records this call into a usage ledger batch (see
// ../tdx/usageLedger.js) — `usageSink` is a plain in-memory array the
// caller threads down from fetchAllSources/fetchSource, or passes
// directly for a single-call admin probe. Recording is a pure, local
// `.push()` — never a second network call, never blocks/throws on its
// own (recordTdxDataCall itself is a no-op if usageSink isn't an array),
// so passing no usageSink at all (every pre-V1.8.6 caller, and every
// existing test) is byte-for-byte unchanged behavior.

import { recordTdxDataCall } from './usageLedger.js';

export class TdxApiError extends Error {
  constructor(message, { status = null, source = null } = {}) {
    super(message);
    this.name = 'TdxApiError';
    this.status = status;
    this.source = source;
  }
}

export async function fetchTdxJson(url, accessToken, { source, usageSink, now } = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
      },
    });
  } catch (err) {
    // A network-level failure never even reached an HTTP response — still
    // a real, attempted call (fetch() genuinely went out), so it's still
    // recorded: attempted=true, success=false, httpStatus=null, 0 bytes.
    recordTdxDataCall(usageSink, { source, success: false, httpStatus: null, payloadBytesEstimate: 0, now });
    throw new TdxApiError(`Network error calling ${source}: ${err.message}`, { source });
  }

  if (!response.ok) {
    // V1.8.6: this read (once, via arrayBuffer — see the success path
    // below for why arrayBuffer over text()) doubles as the "local
    // estimated transfer" measurement for a FAILED call too — no extra
    // request, we already have to read the body once to surface a useful
    // error snippet.
    let bodySnippet = '';
    let payloadBytesEstimate = 0;
    try {
      const buf = await response.arrayBuffer();
      payloadBytesEstimate = buf.byteLength;
      bodySnippet = new TextDecoder('utf-8').decode(buf).slice(0, 300);
    } catch {
      // ignore — body isn't required for the error to be useful
    }
    recordTdxDataCall(usageSink, { source, success: false, httpStatus: response.status, payloadBytesEstimate, now });
    const suffix = bodySnippet ? `: ${bodySnippet}` : '';
    throw new TdxApiError(
      `TDX API "${source}" responded with HTTP ${response.status} ${response.statusText}${suffix}`,
      { status: response.status, source }
    );
  }

  // V1.8.6: read the body ONCE as raw bytes (byteLength is an exact local
  // count of what fetch() handed back — no second HTTP request), then
  // decode+parse that SAME buffer — never response.json() directly,
  // which would give no way to also measure size without a duplicate
  // read. Explicitly labeled "local estimate" wherever this is displayed
  // (see health.js) — this measures bytes AFTER the Workers runtime's own
  // gzip decompression (Accept-Encoding: gzip above), so it will not
  // exactly match TDX's own official transfer/billing figure, which may
  // use a different compression or metering convention. Good enough to
  // long-term-calibrate against, not claimed to be identical.
  let buf;
  try {
    buf = await response.arrayBuffer();
  } catch (err) {
    recordTdxDataCall(usageSink, { source, success: false, httpStatus: response.status, payloadBytesEstimate: 0, now });
    throw new TdxApiError(`Failed to read response body from "${source}": ${err.message}`, { source });
  }

  const payloadBytesEstimate = buf.byteLength;
  try {
    const json = JSON.parse(new TextDecoder('utf-8').decode(buf));
    recordTdxDataCall(usageSink, { source, success: true, httpStatus: response.status, payloadBytesEstimate, now });
    return json;
  } catch (err) {
    recordTdxDataCall(usageSink, { source, success: false, httpStatus: response.status, payloadBytesEstimate, now });
    throw new TdxApiError(`Failed to parse JSON from "${source}": ${err.message}`, { source });
  }
}
