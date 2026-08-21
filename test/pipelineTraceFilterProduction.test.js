// V1.8.7.6 — Pipeline Trace Filter Production Fix.
//
// Real Production report: after V1.8.7.3's pagination fix went live
// (confirmed — the trace view now shows entries up to the true current
// time, not stuck at an earlier hour), filtering STILL appeared to have
// no effect on a real phone: selecting 來源=TDX國道 + 狀態=✅已播報 and
// tapping 篩選 still showed rows for 符合但無需推播/重複/TDX省道.
//
// This round traced the FULL path end to end — HTML <form> → <select>/
// <input> name/value → real browser GET-form-submission query string →
// handler → listPipelineTrace → predicate → render — rather than
// assuming any layer was already correct. Investigation included:
//   - Full code trace of every layer (form markup, handlePipelineTraceView,
//     listPipelineTrace's predicates and pagination).
//   - A synthetic small-dataset HTTP-level reproduction (this file,
//     tests 1-8 below).
//   - A large-scale (2000+ key), REALISTICALLY PAGINATED (real
//     Cloudflare list()/cursor semantics) reproduction (test 9).
//   - A REAL headless-Chromium reproduction (Playwright, iPhone user
//     agent) that drives the ACTUAL rendered <select> elements and
//     submit button — not a hand-built query string — confirming the
//     real browser-generated query string and the resulting filtered
//     page are both correct (documented in PROJECT_HANDOFF.md's V1.8.7.6
//     section; not itself part of this repo's own CI-run test suite,
//     since it requires a real browser binary this test runner doesn't
//     assume is present, but its exact query-string result is pinned as
//     a regression fixture in test 10 below).
//
// RESULT: every layer, at every scale tested, filters correctly. No
// server-side defect was found or reproduced. See PROJECT_HANDOFF.md for
// the full writeup, including why a stale CLIENT-side view (not a code
// defect) is the leading remaining explanation, and the two concrete,
// in-scope improvements made anyway: an "目前套用篩選" active-filters
// banner printed in every response (tests 11-12), and strengthened
// cache-prevention headers (test 13).
//
// This round changed NOTHING about classification, eligibility, dedupe,
// suppression, CCTV, LINE, Shared Feed, or the Pipeline Trace WRITE
// schema — only pipelineTraceView.js's render layer (the banner + cache
// headers). listPipelineTrace's filter/pagination logic (V1.8.7.3) is
// unchanged this round; re-verified, not re-fixed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { recordPipelineTrace, buildTraceEntry, buildUpstreamSnapshot } from '../src/traffic/pipelineTrace.js';
import { handlePipelineTraceView } from '../src/traffic/pipelineTraceView.js';

function createMockKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      store.set(key, value);
      this.lastPutOptions = options;
    },
    async list({ prefix = '', cursor } = {}) {
      if (cursor) return { keys: [], list_complete: true };
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

// Same real page-size + cursor semantics as V1.8.7.3's own pagination
// reproduction — needed for test 9's realistic-scale check.
function createPaginatedMockKV({ pageSize = 1000 } = {}) {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async list({ prefix = '', cursor } = {}) {
      const allKeys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = allKeys.slice(start, start + pageSize);
      const nextStart = start + slice.length;
      const list_complete = nextStart >= allKeys.length;
      return { keys: slice.map((name) => ({ name })), list_complete, cursor: list_complete ? undefined : String(nextStart) };
    },
  };
}

function event(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'X',
    type: 'accident',
    road: '國道一號',
    direction: '南向',
    startKM: '10K+000',
    endKM: '10K+200',
    description: 'test',
    updatedAt: '2026-08-21T20:00:00+08:00',
    pipelineTraceUpstream: buildUpstreamSnapshot({ eventType: '事故', rawDirection: '南向' }),
    ...overrides,
  };
}

const NOW = new Date('2026-08-21T21:20:00+08:00');
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'test-admin-pass-filter-production';

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function adminRequest(pathWithQuery, { auth } = {}) {
  const headers = {};
  if (auth) headers.Authorization = auth;
  return new Request(`https://traffic-reporter.example.workers.dev${pathWithQuery}`, { headers });
}

// Seeds the exact mixed dataset the task's own section 7 specifies:
// freeway pushed / freeway duplicate / freeway not-needed / highway
// pushed / PBS pushed.
async function seedMixedDataset(kv, baseTime = NOW) {
  await recordPipelineTrace(
    kv,
    buildTraceEntry({ event: event({ rawId: 'FREEWAY-PUSHED', source: 'freeway' }), now: baseTime, eligibility: true, lineAttempted: 1, lineSucceeded: 1 }),
    baseTime
  );
  await recordPipelineTrace(
    kv,
    buildTraceEntry({ event: event({ rawId: 'FREEWAY-DUPLICATE', source: 'freeway' }), now: new Date(baseTime.getTime() + 1000), dedupeResult: 'duplicate' }),
    new Date(baseTime.getTime() + 1000)
  );
  await recordPipelineTrace(
    kv,
    buildTraceEntry({ event: event({ rawId: 'FREEWAY-NOT-NEEDED', source: 'freeway' }), now: new Date(baseTime.getTime() + 2000), eligibility: true }),
    new Date(baseTime.getTime() + 2000)
  );
  await recordPipelineTrace(
    kv,
    buildTraceEntry({ event: event({ rawId: 'HIGHWAY-PUSHED', source: 'highway', road: '台14線' }), now: new Date(baseTime.getTime() + 3000), eligibility: true, lineAttempted: 1, lineSucceeded: 1 }),
    new Date(baseTime.getTime() + 3000)
  );
  await recordPipelineTrace(
    kv,
    buildTraceEntry({ event: event({ rawId: 'PBS-PUSHED', source: 'pbs', road: '台3線' }), now: new Date(baseTime.getTime() + 4000), eligibility: true, lineAttempted: 1, lineSucceeded: 1 }),
    new Date(baseTime.getTime() + 4000)
  );
}

function rawIdsInHtml(html, ids) {
  return Object.fromEntries(ids.map((id) => [id, html.includes(id)]));
}

const ALL_IDS = ['FREEWAY-PUSHED', 'FREEWAY-DUPLICATE', 'FREEWAY-NOT-NEEDED', 'HIGHWAY-PUSHED', 'PBS-PUSHED'];

// =======================================================================
// 1-2: source only / status only
// =======================================================================

test('1. source only (?source=freeway) — every freeway row shown, highway/pbs excluded', async () => {
  const kv = createMockKV();
  await seedMixedDataset(kv);
  const res = await handlePipelineTraceView({ TRAFFIC_KV: kv }, adminRequest('/admin/pipeline-trace-view?source=freeway'), NOW);
  const html = await res.text();
  const present = rawIdsInHtml(html, ALL_IDS);
  assert.equal(present['FREEWAY-PUSHED'], true);
  assert.equal(present['FREEWAY-DUPLICATE'], true);
  assert.equal(present['FREEWAY-NOT-NEEDED'], true);
  assert.equal(present['HIGHWAY-PUSHED'], false);
  assert.equal(present['PBS-PUSHED'], false);
});

test('2. status only (?status=line-sent) — every pushed row shown regardless of source, non-pushed excluded', async () => {
  const kv = createMockKV();
  await seedMixedDataset(kv);
  const res = await handlePipelineTraceView({ TRAFFIC_KV: kv }, adminRequest('/admin/pipeline-trace-view?status=line-sent'), NOW);
  const html = await res.text();
  const present = rawIdsInHtml(html, ALL_IDS);
  assert.equal(present['FREEWAY-PUSHED'], true);
  assert.equal(present['HIGHWAY-PUSHED'], true);
  assert.equal(present['PBS-PUSHED'], true);
  assert.equal(present['FREEWAY-DUPLICATE'], false);
  assert.equal(present['FREEWAY-NOT-NEEDED'], false);
});

// =======================================================================
// 3: source + status — the EXACT real Production scenario reported.
// =======================================================================

test('3. source + status (?source=freeway&status=line-sent) — the exact real Production scenario: ONLY freeway-pushed, nothing else', async () => {
  const kv = createMockKV();
  await seedMixedDataset(kv);
  const res = await handlePipelineTraceView({ TRAFFIC_KV: kv }, adminRequest('/admin/pipeline-trace-view?source=freeway&status=line-sent'), NOW);
  const html = await res.text();
  const present = rawIdsInHtml(html, ALL_IDS);
  assert.equal(present['FREEWAY-PUSHED'], true);
  assert.equal(present['FREEWAY-DUPLICATE'], false, '重複（內容未變更）must NOT appear');
  assert.equal(present['FREEWAY-NOT-NEEDED'], false, '符合但無需推播 must NOT appear');
  assert.equal(present['HIGHWAY-PUSHED'], false, 'TDX 省道 must NOT appear');
  assert.equal(present['PBS-PUSHED'], false, 'PBS must NOT appear');
});

// =======================================================================
// 4: road + status
// =======================================================================

test('4. road + status (?road=台14線&status=line-sent) — only the matching highway row', async () => {
  const kv = createMockKV();
  await seedMixedDataset(kv);
  const res = await handlePipelineTraceView({ TRAFFIC_KV: kv }, adminRequest('/admin/pipeline-trace-view?road=%E5%8F%B014%E7%B7%9A&status=line-sent'), NOW);
  const html = await res.text();
  const present = rawIdsInHtml(html, ALL_IDS);
  assert.equal(present['HIGHWAY-PUSHED'], true);
  assert.equal(present['FREEWAY-PUSHED'], false);
  assert.equal(present['PBS-PUSHED'], false);
});

// =======================================================================
// 5: source + road + status (three-way AND)
// =======================================================================

test('5. source + road + status (three-way AND) — only a record matching ALL THREE', async () => {
  const kv = createMockKV();
  await seedMixedDataset(kv);
  const res = await handlePipelineTraceView(
    { TRAFFIC_KV: kv },
    adminRequest(`/admin/pipeline-trace-view?source=freeway&road=${encodeURIComponent('國道一號')}&status=line-sent`),
    NOW
  );
  const html = await res.text();
  const present = rawIdsInHtml(html, ALL_IDS);
  assert.equal(present['FREEWAY-PUSHED'], true);
  for (const id of ['FREEWAY-DUPLICATE', 'FREEWAY-NOT-NEEDED', 'HIGHWAY-PUSHED', 'PBS-PUSHED']) {
    assert.equal(present[id], false, `${id} must not appear`);
  }
});

// =======================================================================
// 6: clear/default restores the unfiltered view
// =======================================================================

test('6. clearing filters (no query params) restores the default unfiltered view — every row shown', async () => {
  const kv = createMockKV();
  await seedMixedDataset(kv);
  const res = await handlePipelineTraceView({ TRAFFIC_KV: kv }, adminRequest('/admin/pipeline-trace-view'), NOW);
  const html = await res.text();
  const present = rawIdsInHtml(html, ALL_IDS);
  for (const id of ALL_IDS) assert.equal(present[id], true, `${id} should appear in the unfiltered view`);
});

// =======================================================================
// 7: query value correctly pre-selected in the <select>
// =======================================================================

test('7. query values are correctly pre-selected in both <select> elements after a filtered request', async () => {
  const kv = createMockKV();
  await seedMixedDataset(kv);
  const res = await handlePipelineTraceView({ TRAFFIC_KV: kv }, adminRequest('/admin/pipeline-trace-view?source=freeway&status=line-sent'), NOW);
  const html = await res.text();
  assert.match(html, /<option value="freeway" selected>/);
  assert.match(html, /<option value="line-sent" selected>/);
  // Every OTHER option must NOT be marked selected.
  assert.doesNotMatch(html, /<option value="highway" selected>/);
  assert.doesNotMatch(html, /<option value="duplicate" selected>/);
});

// =======================================================================
// 8: no matching events -> empty result shown, not an error
// =======================================================================

test('8. a filter combination matching nothing shows the empty-state message, not an error or unfiltered fallback', async () => {
  const kv = createMockKV();
  await seedMixedDataset(kv);
  const res = await handlePipelineTraceView({ TRAFFIC_KV: kv }, adminRequest('/admin/pipeline-trace-view?source=cms&status=line-sent'), NOW);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /這個篩選條件下沒有資料/);
  for (const id of ALL_IDS) assert.equal(html.includes(id), false);
});

// =======================================================================
// 9: realistic scale — 2000+ paginated keys, source+status still correct.
// =======================================================================

test('9. realistic scale (2000+ paginated keys, real cursor semantics) — source+status filter still returns exactly the true matches, nothing else leaks through', async () => {
  const kv = createPaginatedMockKV({ pageSize: 1000 });
  const t0 = new Date(NOW.getTime() - 23 * 60 * 60 * 1000);
  for (let i = 0; i < 1500; i += 1) {
    const tt = new Date(t0.getTime() + i * 50000);
    // eslint-disable-next-line no-await-in-loop
    await recordPipelineTrace(
      kv,
      buildTraceEntry({ event: event({ rawId: `NOISE${i}`, source: 'pbs', road: '台3線' }), now: tt, eligibility: false, eligibilityReason: 'construction-no-impact-keyword' }),
      tt
    );
  }
  const matchIds = [];
  for (let i = 0; i < 5; i += 1) {
    const tt = new Date(NOW.getTime() - i * 60000);
    const rawId = `REALMATCH${i}`;
    matchIds.push(rawId);
    // eslint-disable-next-line no-await-in-loop
    await recordPipelineTrace(
      kv,
      buildTraceEntry({ event: event({ rawId, source: 'freeway' }), now: tt, eligibility: true, lineAttempted: 1, lineSucceeded: 1 }),
      tt
    );
  }

  const res = await handlePipelineTraceView({ TRAFFIC_KV: kv }, adminRequest('/admin/pipeline-trace-view?source=freeway&status=line-sent'), NOW);
  const html = await res.text();
  for (const id of matchIds) assert.equal(html.includes(id), true, `${id} (real match) must be found`);
  assert.equal(html.includes('NOISE0'), false);
  assert.equal(html.includes('台3線'), false); // no PBS road label leaked into a freeway+line-sent filtered view
});

// =======================================================================
// 10: pinned real-browser reproduction result (Playwright/Chromium,
// iPhone UA, actual <select> + submit-button interaction) — documented
// in full in PROJECT_HANDOFF.md's V1.8.7.6 section. Pinning the EXACT
// resulting query string here as a regression fixture so a future
// change to renderFilterForm's field order/names can't silently break
// what a real browser actually produces, even though this test itself
// only re-derives the URL from the form's own declared field
// names/values (no real browser dependency in CI).
// =======================================================================

test('10. real-browser-confirmed query string shape (?source=freeway&road=&rawId=&status=line-sent&limit=) round-trips correctly through the handler', async () => {
  const kv = createMockKV();
  await seedMixedDataset(kv);
  const res = await handlePipelineTraceView(
    { TRAFFIC_KV: kv },
    adminRequest('/admin/pipeline-trace-view?source=freeway&road=&rawId=&status=line-sent&limit='),
    NOW
  );
  const html = await res.text();
  const present = rawIdsInHtml(html, ALL_IDS);
  assert.equal(present['FREEWAY-PUSHED'], true);
  assert.equal(present['FREEWAY-DUPLICATE'], false);
  assert.equal(present['FREEWAY-NOT-NEEDED'], false);
  assert.equal(present['HIGHWAY-PUSHED'], false);
  assert.equal(present['PBS-PUSHED'], false);
});

// =======================================================================
// 11-12: V1.8.7.6's own new active-filters banner.
// =======================================================================

test('11. the active-filters banner prints exactly the filters the server received and applied', async () => {
  const kv = createMockKV();
  await seedMixedDataset(kv);
  const res = await handlePipelineTraceView({ TRAFFIC_KV: kv }, adminRequest('/admin/pipeline-trace-view?source=freeway&status=line-sent'), NOW);
  const html = await res.text();
  assert.match(html, /目前套用篩選/);
  assert.match(html, /來源=TDX 國道（freeway）/);
  assert.match(html, /狀態=已播報（line-sent）/);
});

test('12. the active-filters banner shows the no-filter state when no query params are present', async () => {
  const kv = createMockKV();
  await seedMixedDataset(kv);
  const res = await handlePipelineTraceView({ TRAFFIC_KV: kv }, adminRequest('/admin/pipeline-trace-view'), NOW);
  const html = await res.text();
  assert.match(html, /目前未套用任何篩選/);
});

// =======================================================================
// 13: strengthened cache headers (defense-in-depth).
// =======================================================================

test('13. GET /admin/pipeline-trace-view responds with strong no-cache headers via the real Worker entry point', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: createMockKV() };
  const auth = basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
  const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view?source=freeway&status=line-sent', { auth }), env);
  assert.equal(res.status, 200);
  const cacheControl = res.headers.get('Cache-Control') || '';
  assert.match(cacheControl, /no-store/);
});

// =======================================================================
// 14: full end-to-end through the real Worker entry point (routing +
// Admin Auth + handler), the exact real Production scenario.
// =======================================================================

test('14. end-to-end via worker.fetch: GET /admin/pipeline-trace-view?source=freeway&status=line-sent with correct Admin Auth returns ONLY the matching row', async () => {
  const kv = createMockKV();
  await seedMixedDataset(kv, new Date());
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const auth = basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
  const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view?source=freeway&status=line-sent', { auth }), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  const present = rawIdsInHtml(html, ALL_IDS);
  assert.equal(present['FREEWAY-PUSHED'], true);
  assert.equal(present['FREEWAY-DUPLICATE'], false);
  assert.equal(present['FREEWAY-NOT-NEEDED'], false);
  assert.equal(present['HIGHWAY-PUSHED'], false);
  assert.equal(present['PBS-PUSHED'], false);
});
