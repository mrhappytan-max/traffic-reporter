// V1.8.6.5 — scripts/updateRoadLocationData.mjs. This unit-tests the pure
// `parseCsv` helper in isolation (safe — touches no real file on disk).
// The importer's end-to-end behavior (fail-loud on a schema problem;
// atomic, non-destructive replacement on success; a genuine
// recordCount:0 output when raw/ is empty) was verified manually against
// this repo's real data/road-location/raw and generated/ directories
// (see PROJECT_HANDOFF.md's V1.8.6.5 section for the exact commands/
// output) rather than via node --test — the importer's own paths are not
// parameterized (by design: it's a fixed developer-run tool, not a
// library), so an automated test would need to either touch the real
// data/road-location/generated/*.js files (risking exactly the
// "TEST FIXTURE data leaks into Production" outcome this whole round is
// designed to prevent) or add path-injection complexity purely to make
// that possible. The resolver-side contract this importer's OUTPUT must
// satisfy is already covered by test/kmLocationResolver.test.js's own
// "against the REAL (currently empty) Production dataset" cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../scripts/updateRoadLocationData.mjs';

test('parseCsv: plain comma-separated rows, header + data', () => {
  const rows = parseCsv('公路編號,樁號KM\n台3,9.0\n台13甲,12.5\n');
  assert.deepEqual(rows, [
    ['公路編號', '樁號KM'],
    ['台3', '9.0'],
    ['台13甲', '12.5'],
  ]);
});

test('parseCsv: quoted fields, including an embedded comma and an escaped quote', () => {
  const rows = parseCsv('名稱,備註\n"測試服務區, A","說""明"\n');
  assert.deepEqual(rows, [
    ['名稱', '備註'],
    ['測試服務區, A', '說"明'],
  ]);
});

test('parseCsv: no trailing newline still yields the final row', () => {
  const rows = parseCsv('a,b\n1,2');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('parseCsv: blank trailing line is dropped, not returned as a spurious empty row', () => {
  const rows = parseCsv('a,b\n1,2\n\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});
