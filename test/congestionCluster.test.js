import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterCongestionEvents, CONGESTION_CLUSTER_MAX_GAP_KM } from '../src/traffic/congestionCluster.js';
import { getRoadSectionLabel } from '../src/traffic/roadSectionLabel.js';

function congestionEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'X',
    type: 'congestion',
    road: '國道一號',
    direction: '北向',
    startKM: '91K+000',
    endKM: '89K+000',
    description: '車多回堵',
    updatedAt: '2026-08-16T10:50:00+08:00',
    ...overrides,
  };
}

function accidentEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'A1',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    startKM: '90K+000',
    endKM: '90K+000',
    description: '事故',
    updatedAt: '2026-08-16T10:50:00+08:00',
    ...overrides,
  };
}

test('8. 4 overlapping 國1 北向 congestion rows merge into exactly 1 cluster', () => {
  const events = [
    congestionEvent({ rawId: 'N1', startKM: '91K+000', endKM: '82K+400' }),
    congestionEvent({ rawId: 'N2', startKM: '89K+020', endKM: '82K+400' }),
    congestionEvent({ rawId: 'N3', startKM: '86K+500', endKM: '87K+400' }),
    congestionEvent({ rawId: 'N4', startKM: '85K+355', endKM: '84K+570' }),
  ];
  const { congestionClusters } = clusterCongestionEvents(events);
  assert.equal(congestionClusters.length, 1);
  assert.equal(congestionClusters[0].members.length, 4);
});

test('9. same road but different direction never merges', () => {
  const events = [
    congestionEvent({ rawId: 'N1', direction: '北向', startKM: '91K+000', endKM: '82K+400' }),
    congestionEvent({ rawId: 'S1', direction: '南向', startKM: '83K+000', endKM: '91K+000' }),
  ];
  const { congestionClusters } = clusterCongestionEvents(events);
  assert.equal(congestionClusters.length, 2);
  const directions = congestionClusters.map((c) => c.candidate.direction).sort();
  assert.deepEqual(directions, ['北向', '南向']);
});

test('10. two congestion segments far apart on the same road+direction stay 2 separate clusters', () => {
  const events = [
    congestionEvent({ rawId: 'N1', startKM: '91K+000', endKM: '89K+000' }),
    congestionEvent({ rawId: 'N2', startKM: '40K+000', endKM: '38K+000' }), // far away, same direction
  ];
  const { congestionClusters } = clusterCongestionEvents(events);
  assert.equal(congestionClusters.length, 2);
});

test('11. two segments exactly at (and within) the 1km gap threshold merge into one cluster', () => {
  // 89.0 ends the first; the second starts at 89.0 + CONGESTION_CLUSTER_MAX_GAP_KM
  // exactly — spec says "<= 1km" so this must still merge.
  const events = [
    congestionEvent({ rawId: 'N1', startKM: '91K+000', endKM: '89K+000' }),
    congestionEvent({ rawId: 'N2', startKM: `${89 - CONGESTION_CLUSTER_MAX_GAP_KM}K+000`, endKM: '85K+000' }),
  ];
  const { congestionClusters } = clusterCongestionEvents(events);
  assert.equal(congestionClusters.length, 1);
});

test('a gap just over the threshold does NOT merge', () => {
  const events = [
    congestionEvent({ rawId: 'N1', startKM: '91K+000', endKM: '89K+000' }),
    congestionEvent({ rawId: 'N2', startKM: `${89 - CONGESTION_CLUSTER_MAX_GAP_KM - 0.1}K+000`, endKM: '85K+000' }),
  ];
  const { congestionClusters } = clusterCongestionEvents(events);
  assert.equal(congestionClusters.length, 2);
});

test('non-congestion events (accident/construction/...) pass through untouched, never clustered', () => {
  const events = [congestionEvent({ rawId: 'N1' }), accidentEvent({ rawId: 'A1' })];
  const { nonCongestionEvents, congestionClusters } = clusterCongestionEvents(events);
  assert.equal(congestionClusters.length, 1);
  assert.equal(nonCongestionEvents.length, 1);
  assert.equal(nonCongestionEvents[0].rawId, 'A1');
  assert.equal(nonCongestionEvents[0].type, 'accident');
});

test('never mutates or drops the original member event objects', () => {
  const n1 = congestionEvent({ rawId: 'N1', startKM: '91K+000', endKM: '89K+000' });
  const n1Snapshot = JSON.stringify(n1);
  const { congestionClusters } = clusterCongestionEvents([n1]);
  assert.equal(JSON.stringify(n1), n1Snapshot); // untouched
  assert.equal(congestionClusters[0].members[0], n1); // same reference, not a copy-with-changes
});

test('a congestion event with unparseable KM is never silently dropped — kept as a passthrough singleton', () => {
  const noKm = congestionEvent({ rawId: 'N-nokm', startKM: undefined, endKM: undefined });
  const { nonCongestionEvents, congestionClusters } = clusterCongestionEvents([noKm]);
  assert.equal(congestionClusters.length, 0);
  assert.equal(nonCongestionEvents.length, 1);
  assert.equal(nonCongestionEvents[0].rawId, 'N-nokm');
});

test('cluster candidate unions the KM range and uses the latest updatedAt among members', () => {
  const events = [
    congestionEvent({ rawId: 'N1', startKM: '91K+000', endKM: '89K+000', updatedAt: '2026-08-16T10:45:00+08:00' }),
    congestionEvent({ rawId: 'N2', startKM: '89K+000', endKM: '82K+400', updatedAt: '2026-08-16T10:50:00+08:00' }),
  ];
  const { congestionClusters } = clusterCongestionEvents(events);
  const { candidate } = congestionClusters[0];
  assert.equal(candidate.startKM, 91);
  assert.equal(candidate.endKM, 82.4);
  assert.equal(candidate.updatedAt, '2026-08-16T10:50:00+08:00');
});

test('cluster candidate preserves direction-of-travel KM ordering (descending for 北向, ascending for 南向)', () => {
  const northbound = clusterCongestionEvents([
    congestionEvent({ direction: '北向', startKM: '91K+000', endKM: '82K+400' }),
  ]).congestionClusters[0].candidate;
  assert.ok(northbound.startKM > northbound.endKM);

  const southbound = clusterCongestionEvents([
    congestionEvent({ direction: '南向', startKM: '83K+000', endKM: '91K+000' }),
  ]).congestionClusters[0].candidate;
  assert.ok(southbound.startKM < southbound.endKM);
});

test('notificationKey is congestion:<road>:<direction>:<corridor> and does not repeat the road name twice', () => {
  const { congestionClusters } = clusterCongestionEvents([
    congestionEvent({ startKM: '91K+000', endKM: '82K+400' }),
  ]);
  const key = congestionClusters[0].notificationKey;
  assert.match(key, /^congestion:國道一號:北向:/);
  const occurrences = key.split('國道一號').length - 1;
  assert.equal(occurrences, 1);
});

test('a road without anchor data still clusters and gets a fallback corridor id (never crashes, never unkeyed)', () => {
  const events = [
    congestionEvent({ road: '台1線', rawId: 'T1', startKM: '90K+000', endKM: '89K+000' }),
    congestionEvent({ road: '台1線', rawId: 'T2', startKM: '89K+500', endKM: '88K+000' }),
  ];
  const { congestionClusters } = clusterCongestionEvents(events);
  assert.equal(congestionClusters.length, 1);
  assert.match(congestionClusters[0].notificationKey, /^congestion:台1線:北向:/);
  assert.ok(congestionClusters[0].notificationKey.length > 'congestion:台1線:北向:'.length);
});

test('十二. real fixture — 國1北向 5 overlapping rows from the report -> 1 cluster covering 湖口-竹北', () => {
  const events = [
    congestionEvent({ rawId: 'N1', startKM: '83K+800', endKM: '82K+400' }),
    congestionEvent({ rawId: 'N2', startKM: '91K+000', endKM: '82K+400' }),
    congestionEvent({ rawId: 'N3', startKM: '89K+020', endKM: '82K+400' }),
    congestionEvent({ rawId: 'N4', startKM: '90K+415', endKM: '86K+500' }),
    congestionEvent({ rawId: 'N5', startKM: '91K+000', endKM: '90K+415' }),
  ];
  const { congestionClusters } = clusterCongestionEvents(events);
  assert.equal(congestionClusters.length, 1);
  assert.equal(congestionClusters[0].members.length, 5);
  const { candidate } = congestionClusters[0];
  assert.equal(candidate.startKM, 91);
  assert.equal(candidate.endKM, 82.4);
});

test('十二. real fixture — 國1南向 4 overlapping rows -> 1 cluster in the 湖口 direction', () => {
  const events = [
    congestionEvent({ rawId: 'S1', direction: '南向', startKM: '83K+800', endKM: '84K+570' }),
    congestionEvent({ rawId: 'S2', direction: '南向', startKM: '84K+570', endKM: '87K+285' }),
    congestionEvent({ rawId: 'S3', direction: '南向', startKM: '85K+355', endKM: '87K+285' }),
    congestionEvent({ rawId: 'S4', direction: '南向', startKM: '86K+500', endKM: '87K+285' }),
  ];
  const { congestionClusters } = clusterCongestionEvents(events);
  assert.equal(congestionClusters.length, 1);
  assert.equal(congestionClusters[0].members.length, 4);
  const { candidate } = congestionClusters[0];
  // The candidate itself only carries raw startKM/endKM — the driver-
  // readable label is computed at message-format time (messageFormat.js)
  // by feeding those same fields through getRoadSectionLabel, same as
  // any other event.
  const { label } = getRoadSectionLabel({ road: candidate.road, startKM: candidate.startKM, endKM: candidate.endKM });
  assert.match(label, /湖口/);
});
