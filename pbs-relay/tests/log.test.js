import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRequestId,
  logRequestStart,
  logUpstreamAttemptStart,
  logCacheStatus,
} from '../src/log.js';

function captureConsoleLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (msg) => lines.push(String(msg));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('generateRequestId matches "pbs-<timestamp>-<random>"', () => {
  const id = generateRequestId(1_700_000_000_000);
  assert.match(id, /^pbs-1700000000000-[a-z0-9]+$/);
});

test('generateRequestId is different on each call', () => {
  const a = generateRequestId();
  const b = generateRequestId();
  assert.notEqual(a, b);
});

test('logRequestStart prints the expected key=value shape', () => {
  const lines = captureConsoleLog(() => logRequestStart({ requestId: 'pbs-1-abc', cacheStatus: 'MISS' }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[PBS\] request start requestId=pbs-1-abc cacheStatus=MISS$/);
});

test('logUpstreamAttemptStart includes the PBS URL for correlation', () => {
  const lines = captureConsoleLog(() =>
    logUpstreamAttemptStart({ requestId: 'pbs-1-abc', attempt: 1, url: 'https://rtr.pbs.gov.tw/NMP103_PbsWS/resources/roadData/opendata' })
  );
  assert.match(lines[0], /\[PBS\] upstream attempt start requestId=pbs-1-abc attempt=1 url=https:\/\/rtr\.pbs\.gov\.tw/);
});

test('logCacheStatus supports HIT/MISS/STALE', () => {
  for (const status of ['HIT', 'MISS', 'STALE']) {
    const lines = captureConsoleLog(() => logCacheStatus({ status, requestId: 'pbs-1-abc' }));
    assert.equal(lines[0], `[PBS] cache ${status} requestId=pbs-1-abc`);
  }
});

test('none of the logging helpers accept a generic "extra fields" bag — only the named parameters ever get printed', () => {
  // Regression guard for the "no accidental secret leak" design constraint:
  // passing an extra field that looks like a secret must never surface,
  // because these functions only interpolate the fields they explicitly
  // destructure.
  const lines = captureConsoleLog(() =>
    logRequestStart({ requestId: 'pbs-1-abc', cacheStatus: 'MISS', authorizationHeader: 'Bearer should-not-appear' })
  );
  assert.doesNotMatch(lines[0], /should-not-appear/);
  assert.doesNotMatch(lines[0], /authorizationHeader/);
});
