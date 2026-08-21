// V1.8.6.9 — Deployment identity + drift detection. Pure, 0 I/O, 0
// TDX/PBS/CCTV/LINE/GitHub/Cloudflare API calls anywhere in this module
// — every field comes from either the build-time-generated
// src/generated/buildMetadata.js (see that file and
// scripts/generateBuildMetadata.mjs) or this project's own static
// config (wrangler.jsonc's declared bindings/cron, mirrored here as
// constants — see the module comment on EXPECTED_CRON for why this is a
// mirror, not a live read).
//
// THE ONE HARD RULE THIS MODULE FOLLOWS: never claim to have verified
// something it did not actually verify. `driftDetected` only ever fires
// from a genuine, provable disagreement between two values this module
// actually has (deployedBranch vs 'main', or deployedCommit vs
// expectedMainCommit when expectedMainCommitSource proves that
// comparison was actually made) — never from an assumed/unknown value.
// `dashboardOnlyChecks` names, honestly, everything this module CANNOT
// verify from inside the Worker (see that export's own comment).

import { BUILD_METADATA } from '../generated/buildMetadata.js';
import { APP_VERSION, SCHEMA_VERSION } from '../version.js';

export const EXPECTED_BRANCH = 'main';

// Mirrors wrangler.jsonc's triggers.crons — deliberately a CONSTANT, not
// a live read of that file (a Worker has no filesystem access to its own
// deploy-time config at runtime, and no API access to Cloudflare's own
// Dashboard Trigger setting either — see EXPECTED_CRON's own field in
// getDeploymentStatus for how this is labeled to the reader: this is
// what the CODE expects, never a claim about what Cloudflare's Dashboard
// is actually configured to do). Keep this in sync by hand whenever
// wrangler.jsonc's triggers.crons changes — both are small, human-edited
// constants for the same fact, not two competing sources of truth for
// anything the Worker computes.
export const EXPECTED_CRON = '*/10 * * * *';

// The bindings this Worker's OWN code actually requires to function —
// see wrangler.jsonc's kv_namespaces/r2_buckets/vpc_services for the
// declared source of truth this list mirrors. Existence-only check
// (`env.NAME !== undefined`), never a read/write/ping — see this
// module's own header comment ("只檢查存在性，不做外部 probe").
export const REQUIRED_BINDINGS = [
  { name: 'TRAFFIC_KV', kind: 'KV' },
  { name: 'CCTV_IMAGES', kind: 'R2' },
  { name: 'PBS_RELAY_WINDOWS', kind: 'Service (VPC)' },
];

// The routes section III asked this endpoint to surface, plus the two
// new ones this round adds (/admin/deployment-status(-view)) and the
// public /version this round also adds. "registered" here means
// literally present in src/index.js's own route table — a static,
// 0-I/O fact about THIS Worker's own code, not a live self-HTTP-probe
// (see scripts/verify-production-deploy.mjs for the one place that
// actually makes a real HTTP request to confirm a route responds).
export const IMPORTANT_ROUTES = [
  '/health',
  '/admin/pipeline-trace',
  '/admin/pipeline-trace-view',
  '/admin/broadcast-provenance',
  '/admin/deployment-status',
  '/admin/deployment-status-view',
  '/version',
];

// Cloudflare Secrets this Worker relies on — presence-only (boolean),
// never the value, and only ever surfaced on the Admin-gated endpoint
// (see deploymentStatusHandlers.js) — GET /version must never carry this
// at all, per section VI's explicit "不得回...binding detail" boundary.
export const EXPECTED_SECRETS = [
  'ADMIN_PASSWORD',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'TDX_CLIENT_ID',
  'TDX_CLIENT_SECRET',
  'TRAFFIC_FEED_SECRET',
];

/**
 * Things a repo-scoped script (this module, check-deployment-policy.mjs,
 * verify-production-deploy.mjs) can NEVER actually verify, no matter how
 * clever the check — they live entirely in Cloudflare's own Dashboard,
 * with no repo-visible or API-callable (without a Cloudflare API token
 * this project doesn't have) representation. Listed explicitly, per
 * section VIII's own instruction, rather than silently pretending they
 * were checked.
 */
export const DASHBOARD_ONLY_CHECKS = [
  'Cloudflare Workers "Production branch" setting actually pointed at main (this Worker can only tell you what commit/branch it itself was BUILT from — see deployedCommit/deployedBranch below — not what the Dashboard is currently configured to build from next time)',
  'Cloudflare Cron Trigger\'s actual configured schedule (this Worker can only show what the CODE expects — see expectedCron below)',
  'Real traffic percentage split (Gradual/staged rollouts, if any)',
  'Whether a Cloudflare Secret is set to the CORRECT value (only presence is checkable from inside the Worker, never correctness)',
  'Build/Deployment history, logs, or failure reasons in the Cloudflare Dashboard',
];

function bindingPresence(env) {
  return REQUIRED_BINDINGS.map((b) => ({ ...b, present: env != null && env[b.name] !== undefined }));
}

function secretPresence(env) {
  return EXPECTED_SECRETS.map((name) => ({ name, present: Boolean(env && env[name]) }));
}

/**
 * Pure. `env` may be undefined/partial (e.g. GET /version's caller may
 * pass only what it needs) — every field is read defensively.
 *
 * @returns {{
 *   appVersion: string, schemaVersion: number,
 *   deployedCommit: string, commitSource: string,
 *   deployedBranch: string, branchSource: string,
 *   expectedMainCommit: string, expectedMainCommitSource: string,
 *   buildTime: string|null,
 *   expectedBranch: string,
 *   driftDetected: boolean, driftReasons: string[],
 *   routes: {path:string, registered:true}[],
 *   bindings: {name:string, kind:string, present:boolean}[],
 *   secrets: {name:string, present:boolean}[],
 *   cron: {expected:string, note:string},
 *   dashboardOnlyChecks: string[],
 * }}
 */
/**
 * Pure — the actual drift RULE, factored out from getDeploymentStatus so
 * it can be exercised directly against a synthetic metadata object in
 * tests (see test/deploymentStatus.test.js's drift-scenario tests),
 * without depending on whatever src/generated/buildMetadata.js's
 * checked-in placeholder happens to contain at test time. Production
 * always calls this with the real BUILD_METADATA (see getDeploymentStatus
 * below) — this function itself never imports or reads that file.
 *
 * @param {typeof BUILD_METADATA} m
 * @returns {string[]} driftReasons — empty array means no drift
 */
export function computeDriftReasons(m) {
  const driftReasons = [];

  if (m.deployedBranch !== EXPECTED_BRANCH) {
    driftReasons.push(`deployedBranch="${m.deployedBranch}" (期望 "${EXPECTED_BRANCH}")`);
  }
  if (m.commitSource === 'unknown' || m.commitSource === 'not-yet-generated') {
    driftReasons.push(`build metadata 未產生（commitSource="${m.commitSource}"）— 這個 Worker 可能不是透過 npm run deploy 部署的`);
  }
  if (m.branchSource === 'unknown' || m.branchSource === 'not-yet-generated') {
    driftReasons.push(`build metadata 未產生（branchSource="${m.branchSource}"）`);
  }
  // Only a REAL, independently-resolved comparison can ever flag a
  // commit mismatch — an "assumed-same-as-deployed" expectedMainCommit
  // is definitionally equal to deployedCommit and must never fire here.
  if (m.expectedMainCommitSource && m.expectedMainCommitSource.startsWith('git:') && m.expectedMainCommit !== m.deployedCommit) {
    driftReasons.push(`deployedCommit="${m.deployedCommit}" != expectedMainCommit="${m.expectedMainCommit}"（build 當下 origin/main 與實際部署 SHA 不同）`);
  }

  return driftReasons;
}

export function getDeploymentStatus(env) {
  const m = BUILD_METADATA;
  const driftReasons = computeDriftReasons(m);

  return {
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    deployedCommit: m.deployedCommit,
    commitSource: m.commitSource,
    deployedBranch: m.deployedBranch,
    branchSource: m.branchSource,
    expectedMainCommit: m.expectedMainCommit,
    expectedMainCommitSource: m.expectedMainCommitSource,
    buildTime: m.buildTime,
    expectedBranch: EXPECTED_BRANCH,
    driftDetected: driftReasons.length > 0,
    driftReasons,
    routes: IMPORTANT_ROUTES.map((path) => ({ path, registered: true })),
    bindings: bindingPresence(env),
    secrets: secretPresence(env),
    cron: {
      expected: EXPECTED_CRON,
      note: 'Worker 無法讀取 Cloudflare Dashboard 實際 Cron Trigger 設定，此為程式碼期望值（見 wrangler.jsonc）',
    },
    dashboardOnlyChecks: DASHBOARD_ONLY_CHECKS,
  };
}

/**
 * The minimal public subset (GET /version) — see this module's header
 * and PRODUCT_DECISIONS.md's V1.8.6.9 section for why this exists
 * separately from the full Admin-gated status: an automated verifier
 * (scripts/verify-production-deploy.mjs) must be able to confirm
 * "Production SHA == main SHA" without an Admin password. Deliberately
 * excludes routes/bindings/secrets/driftReasons/dashboardOnlyChecks —
 * anything beyond the 5 fields below belongs only on
 * /admin/deployment-status.
 */
export function getPublicVersionInfo() {
  const m = BUILD_METADATA;
  return {
    service: 'traffic-reporter',
    appVersion: APP_VERSION,
    deployedCommit: m.deployedCommit,
    deployedBranch: m.deployedBranch,
    buildTime: m.buildTime,
  };
}

/**
 * GET /version — PUBLIC, deliberately UNAUTHENTICATED (see this module's
 * header and PRODUCT_DECISIONS.md's V1.8.6.9 section). 0 upstream calls,
 * 0 KV reads — every field is a build-time constant already in memory.
 * `Cache-Control: no-store` is set explicitly here (not inherited from
 * applyAdminSecurityHeaders, since this route is intentionally NOT
 * Admin-gated) so an intermediate cache can never serve a stale version
 * to the automated verifier this endpoint exists for.
 */
export function handleVersion() {
  return Response.json(getPublicVersionInfo(), { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * GET /admin/deployment-status (Admin-Basic-Auth-gated and method-
 * restricted at the route level — see index.js). Full detail — routes,
 * bindings, secrets presence, cron expectation, dashboard-only-checks
 * list — none of it sensitive beyond what an admin already sees on
 * every other admin page. 0 upstream calls, 0 KV reads.
 */
export function handleDeploymentStatus(env) {
  return Response.json(getDeploymentStatus(env), { headers: { 'Cache-Control': 'no-store' } });
}
