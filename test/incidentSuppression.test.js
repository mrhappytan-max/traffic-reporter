import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveIncidentNotifications,
  readIncidentSuppressionState,
  persistIncidentSuppressionState,
  INCIDENT_MAX_KM_DIFF,
  INCIDENT_SUPPRESSION_WINDOW_MS,
} from '../src/traffic/incidentSuppression.js';

function accident(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-1',
    type: 'accident',
    road: '國道一號',
    direction: '南向',
    startKM: '97K+700',
    endKM: '97K+700',
    description: '事故影響通行',
    title: '國道一號南向97K事故',
    ...overrides,
  };
}

function kv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

const T0 = new Date('2026-08-16T17:15:00+08:00');

test('first sighting of an accident is always a new-incident, never suppressed', () => {
  const { results } = resolveIncidentNotifications([accident()], {}, T0);
  assert.equal(results.length, 1);
  assert.equal(results[0].suppressed, false);
  assert.equal(results[0].reason, 'new-incident');
  assert.equal(results[0].notificationKey, 'freeway:FRW-1');
});

test('same event, same rawId, only description/title changed 10 min later -> suppressed', () => {
  const { nextIncidentsByGroup } = resolveIncidentNotifications([accident()], {}, T0);
  const t10 = new Date(T0.getTime() + 10 * 60 * 1000);
  const second = accident({ description: '事故影響通行，警方正在處理中', title: '國道一號南向97K事故處理中' });
  const { results } = resolveIncidentNotifications([second], nextIncidentsByGroup, t10);

  assert.equal(results.length, 1);
  assert.equal(results[0].suppressed, true);
  assert.equal(results[0].reason, 'same-incident-no-escalation');
  assert.equal(results[0].notificationKey, 'freeway:FRW-1');
});

test('same physical accident under a DIFFERENT rawId (TDX/PBS reissue), same road/direction/KM, within window -> suppressed, reuses the ORIGINAL notificationKey', () => {
  const { nextIncidentsByGroup } = resolveIncidentNotifications([accident({ rawId: 'FRW-1' })], {}, T0);
  const t8 = new Date(T0.getTime() + 8 * 60 * 1000);
  const reissued = accident({ rawId: 'FRW-2-REISSUED', startKM: '97K+800', endKM: '97K+600' }); // tiny KM wobble, well within tolerance
  const { results } = resolveIncidentNotifications([reissued], nextIncidentsByGroup, t8);

  assert.equal(results[0].suppressed, true);
  assert.equal(results[0].notificationKey, 'freeway:FRW-1'); // NOT freeway:FRW-2-REISSUED
});

test('KM more than INCIDENT_MAX_KM_DIFF away, same road/direction -> treated as a genuinely different incident', () => {
  const { nextIncidentsByGroup } = resolveIncidentNotifications([accident({ startKM: '97K+700', endKM: '97K+700' })], {}, T0);
  const farAway = accident({ rawId: 'FRW-FAR', startKM: `${97.7 + INCIDENT_MAX_KM_DIFF + 1}K+000`, endKM: `${97.7 + INCIDENT_MAX_KM_DIFF + 1}K+000` });
  const { results } = resolveIncidentNotifications([farAway], nextIncidentsByGroup, new Date(T0.getTime() + 5 * 60 * 1000));

  assert.equal(results[0].suppressed, false);
  assert.equal(results[0].reason, 'new-incident');
});

test('same road, OPPOSITE direction -> never suppressed (different incident family)', () => {
  const { nextIncidentsByGroup } = resolveIncidentNotifications([accident({ direction: '南向' })], {}, T0);
  const opposite = accident({ rawId: 'FRW-OPPOSITE', direction: '北向' });
  const { results } = resolveIncidentNotifications([opposite], nextIncidentsByGroup, new Date(T0.getTime() + 5 * 60 * 1000));

  assert.equal(results[0].suppressed, false);
});

test('type escalates from accident to closure -> material escalation, allowed through', () => {
  const { nextIncidentsByGroup } = resolveIncidentNotifications([accident()], {}, T0);
  const escalated = accident({ rawId: 'FRW-1', type: 'closure', description: '事故車輛移除中，道路全線封閉' });
  const { results } = resolveIncidentNotifications([escalated], nextIncidentsByGroup, new Date(T0.getTime() + 10 * 60 * 1000));

  assert.equal(results[0].suppressed, false);
  assert.equal(results[0].reason, 'material-escalation');
  assert.equal(results[0].notificationKey, 'freeway:FRW-1');
});

test('blockedLanes materially increases -> material escalation, allowed through', () => {
  const { nextIncidentsByGroup } = resolveIncidentNotifications([accident({ blockedLanes: 1 })], {}, T0);
  const worse = accident({ rawId: 'FRW-1', blockedLanes: 3 });
  const { results } = resolveIncidentNotifications([worse], nextIncidentsByGroup, new Date(T0.getTime() + 10 * 60 * 1000));

  assert.equal(results[0].suppressed, false);
  assert.equal(results[0].reason, 'material-escalation');
});

test('blockedLanes UNCHANGED (or decreasing) never escalates', () => {
  const { nextIncidentsByGroup } = resolveIncidentNotifications([accident({ blockedLanes: 2 })], {}, T0);
  const same = accident({ rawId: 'FRW-1', blockedLanes: 2 });
  const fewer = accident({ rawId: 'FRW-1', blockedLanes: 1 });

  const t10 = new Date(T0.getTime() + 10 * 60 * 1000);
  assert.equal(resolveIncidentNotifications([same], nextIncidentsByGroup, t10).results[0].suppressed, true);
  assert.equal(resolveIncidentNotifications([fewer], nextIncidentsByGroup, t10).results[0].suppressed, true);
});

test('a newly-gained closure/impassable text signal on an accident that stays type=accident -> material escalation', () => {
  const { nextIncidentsByGroup } = resolveIncidentNotifications([accident({ description: '事故影響通行' })], {}, T0);
  const worse = accident({ rawId: 'FRW-1', description: '事故嚴重，目前無法通行' });
  const { results } = resolveIncidentNotifications([worse], nextIncidentsByGroup, new Date(T0.getTime() + 10 * 60 * 1000));

  assert.equal(results[0].suppressed, false);
  assert.equal(results[0].reason, 'material-escalation');
});

test('same accident, still unchanged, 30 minutes later -> still suppressed', () => {
  const { nextIncidentsByGroup } = resolveIncidentNotifications([accident()], {}, T0);
  const t30 = new Date(T0.getTime() + 30 * 60 * 1000);
  const { results } = resolveIncidentNotifications([accident({ rawId: 'FRW-1', description: '事故影響通行，仍在處理' })], nextIncidentsByGroup, t30);

  assert.equal(results[0].suppressed, true);
});

test('an incident record with no new sighting for INCIDENT_SUPPRESSION_WINDOW_MS is forgotten (garbage collected)', () => {
  const { nextIncidentsByGroup } = resolveIncidentNotifications([accident()], {}, T0);
  const wayLater = new Date(T0.getTime() + INCIDENT_SUPPRESSION_WINDOW_MS + 1000);
  const { results } = resolveIncidentNotifications([accident({ rawId: 'FRW-NEW', description: '事故影響通行' })], nextIncidentsByGroup, wayLater);

  // The old record is gone (stale) -> this reads as a genuinely new incident.
  assert.equal(results[0].suppressed, false);
  assert.equal(results[0].reason, 'new-incident');
});

test('unparseable/missing KM on the new report -> never suppressed (fail toward delivering, not silence)', () => {
  const { nextIncidentsByGroup } = resolveIncidentNotifications([accident()], {}, T0);
  const noKm = accident({ rawId: 'FRW-1', startKM: undefined, endKM: undefined });
  const { results } = resolveIncidentNotifications([noKm], nextIncidentsByGroup, new Date(T0.getTime() + 5 * 60 * 1000));

  assert.equal(results[0].suppressed, false);
});

test('two genuinely distinct accidents on the same road/direction reported in the same run never merge into one', () => {
  const first = accident({ rawId: 'FRW-A', startKM: '50K+000', endKM: '50K+000' });
  const second = accident({ rawId: 'FRW-B', startKM: '97K+700', endKM: '97K+700' });
  const { results } = resolveIncidentNotifications([first, second], {}, T0);

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.suppressed === false && r.reason === 'new-incident'));
  assert.notEqual(results[0].notificationKey, results[1].notificationKey);
});

test('readIncidentSuppressionState: no TRAFFIC_KV -> kvAvailable false, empty map, no throw', async () => {
  const state = await readIncidentSuppressionState(null);
  assert.equal(state.kvAvailable, false);
  assert.deepEqual(state.incidentsByGroup, {});
});

test('readIncidentSuppressionState: KV.get throws -> kvAvailable false, empty map, no throw', async () => {
  const brokenKv = { async get() { throw new Error('KV read outage'); } };
  const state = await readIncidentSuppressionState(brokenKv);
  assert.equal(state.kvAvailable, false);
  assert.deepEqual(state.incidentsByGroup, {});
});

test('persistIncidentSuppressionState round-trips through readIncidentSuppressionState', async () => {
  const TRAFFIC_KV = kv();
  const { nextIncidentsByGroup } = resolveIncidentNotifications([accident()], {}, T0);
  const commit = await persistIncidentSuppressionState(TRAFFIC_KV, nextIncidentsByGroup, T0);
  assert.equal(commit.committed, true);

  const state = await readIncidentSuppressionState(TRAFFIC_KV);
  assert.equal(state.kvAvailable, true);
  assert.deepEqual(state.incidentsByGroup, nextIncidentsByGroup);
});

test('persistIncidentSuppressionState: KV.put throws -> reports failure, does not throw', async () => {
  const brokenKv = { async put() { throw new Error('KV write outage'); } };
  const commit = await persistIncidentSuppressionState(brokenKv, {}, T0);
  assert.equal(commit.committed, false);
  assert.equal(typeof commit.error, 'string');
});

// V1.8.5.1 — required regression test 11: pbs/normalize.js's new
// `displayKM` field must have zero effect on incident-family grouping.
// This module already has its own, separate, pre-existing free-text KM
// parser (parseKmFromDescription, used by midKm() only when startKM/endKM
// are both absent — exactly the PBS case). It reads `event.description`
// directly and never looks at `event.displayKM` at all, so grouping must
// come out identical whether displayKM is absent, present, or even
// (deliberately, in this test) set to a value that disagrees with what
// the description text says.
test('11. displayKM has zero effect on incident-suppression grouping — its own independent free-text parser is unaffected', () => {
  const base = accident({
    source: 'pbs',
    rawId: 'PBS-1',
    startKM: undefined,
    endKM: undefined,
    description: '西行在93.3公里處內側車道發生交通事故',
  });
  const withoutDisplayKm = base;
  const withDisplayKm = { ...base, displayKM: 93.3 };
  const withDisagreeingDisplayKm = { ...base, displayKM: 12.7 }; // deliberately different from the description

  const a = resolveIncidentNotifications([withoutDisplayKm], {}, T0);
  const b = resolveIncidentNotifications([withDisplayKm], {}, T0);
  const c = resolveIncidentNotifications([withDisagreeingDisplayKm], {}, T0);

  assert.equal(a.nextIncidentsByGroup['國道一號|南向'][0].km, 93.3);
  assert.equal(b.nextIncidentsByGroup['國道一號|南向'][0].km, 93.3);
  assert.equal(c.nextIncidentsByGroup['國道一號|南向'][0].km, 93.3); // NOT 12.7 — displayKM was never consulted
});
