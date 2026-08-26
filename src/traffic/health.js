// GET /health — "路況播報員人工健康頁". Mobile-first, human-readable status
// page for a person to glance at on their phone. Deliberately NOT a
// preview/debug endpoint: unlike /debug/status (which re-runs the whole
// TDX/PBS/LINE pipeline live on every request), this ONLY reads the
// compact snapshot the last Cron run already wrote — see
// healthSnapshot.js. Opening this URL any number of times, including
// repeated manual refreshes on a phone, can NEVER trigger a new TDX or
// PBS request, and never touches dedupe/subscription/notified state.
//
// Never includes: TDX Client ID/Secret, LINE token/secret, PBS relay
// token, or any LINE userId/groupId. Only counts and derived,
// pre-approved human-readable text ever reach the HTML.

import { readHealthSnapshot } from './healthSnapshot.js';
import { formatTaipeiTime } from './broadcastHours.js';
import { getDeploymentStatus } from './deploymentStatus.js';

const STALE_WARNING_MS = 10 * 60 * 1000; // 10 min — "資料更新延遲"
const STALE_CRITICAL_MS = 15 * 60 * 1000; // 15 min — force critical

const STATUS_META = {
  normal: { label: '正常', emoji: '🟢', color: '#1a7f37', bg: '#e6f6ea' },
  degraded: { label: '降級運作', emoji: '🟡', color: '#8a6100', bg: '#fff6dc' },
  critical: { label: '嚴重異常', emoji: '🔴', color: '#c31c1c', bg: '#fdecec' },
};

// Human-readable reason for a TDX/PBS HTTP status — derived at render
// time on purpose, see healthSnapshot.js's module comment (a copy tweak
// never needs a new Cron write).
function describeHttpStatus(httpStatus) {
  if (httpStatus === null || httpStatus === undefined) return '連線逾時或網路異常';
  if (httpStatus === 429) return 'API 流量限制';
  if (httpStatus === 401) return '驗證失敗';
  if (httpStatus === 403) return '存取被拒';
  if (httpStatus >= 500) return '上游服務異常';
  return `HTTP ${httpStatus} 異常`;
}

// See the task's own worked examples — kept as a lookup, not scattered
// string literals, matching this project's usual "不要散落 hard-code"
// convention (e.g. pbsConfig.js).
const INELIGIBLE_REASON_LABELS = {
  'congestion-excluded': '壅塞事件',
  'alert-excluded': '公車一般通阻資訊',
  'construction-no-impact-keyword': '施工無重大影響',
  'other-no-anomaly-keyword': '一般其他事件',
  'unrecognized-type': '無法辨識的事件類型',
};

function describeIneligibleReason(reason) {
  return INELIGIBLE_REASON_LABELS[reason] || reason;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function yesNo(bool) {
  return bool ? '正常' : '異常';
}

// V1.6.1: tdx.tokenOk is tri-state now — null means "no real TDX fetch
// has happened yet at all" (e.g. moments after a fresh deploy, before the
// first scheduled tick), which is "unknown", not "異常" — see
// healthSnapshot.js's module comment on why this must never look like a
// failure.
function tdxTokenLabel(tokenOk) {
  if (tokenOk === null || tokenOk === undefined) return '尚無資料';
  return yesNo(tokenOk);
}
function tdxTokenPillClass(tokenOk) {
  if (tokenOk === null || tokenOk === undefined) return 'pill-unknown';
  return tokenOk ? 'pill-ok' : 'pill-bad';
}

// V1.6.1: TDX (國道+省道) is fetched at most every 20 minutes, only
// 08:00–22:00 Asia/Taipei (see tdxSchedule.js) — this describes what THIS
// tick actually did, purely informational, never affects page color/tier
// (see healthSnapshot.js — a skip/sleep tick never changes `status`).
function describeTdxRunState({ scheduledThisRun, sleeping }) {
  if (sleeping) return '🌙 夜間休眠中（22:00–08:00 不擷取）';
  if (scheduledThisRun) return '✅ 本輪已擷取';
  return '⏭️ 本輪略過（PBS 專用時段，每 20 分鐘才擷取一次 TDX）';
}

/**
 * Layers snapshot AGE on top of the snapshot's own `status` — this can
 * only be known at read time (see healthSnapshot.js). Also what quietly
 * takes over if a later Cron's persistHealthSnapshot() write itself
 * failed: the snapshot just keeps aging in KV, and this eventually (and
 * correctly) surfaces that as critical with no separate "write failed"
 * flag needed anywhere.
 */
function applyStaleness(snapshot, now) {
  const ageMs = now.getTime() - new Date(snapshot.generatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return { status: snapshot.status, staleNotice: null };
  }
  if (ageMs > STALE_CRITICAL_MS) {
    return { status: 'critical', staleNotice: '健康快照超過 15 分鐘沒有更新' };
  }
  if (ageMs >= STALE_WARNING_MS) {
    // A snapshot this old isn't reliably fresh even if nothing else
    // looked wrong at write time — nudge the displayed tier up one
    // level (never past critical) so a person notices, without
    // inventing a 4th tier.
    const upgraded = snapshot.status === 'normal' ? 'degraded' : snapshot.status;
    return { status: upgraded, staleNotice: '資料更新延遲（10～15 分鐘）' };
  }
  return { status: snapshot.status, staleNotice: null };
}

function renderMissingSnapshotPage(now) {
  const meta = STATUS_META.critical;
  return renderPage({
    statusMeta: meta,
    statusLabel: meta.label,
    generatedAtLabel: '（無資料）',
    staleNotice: null,
    body: `<div class="card"><p>尚未有健康快照，等待下一次 Cron 執行（每 10 分鐘一次）。</p></div>`,
    now,
  });
}

function renderPage({ statusMeta, statusLabel, generatedAtLabel, staleNotice, body, now }) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>路況播報員 系統健康</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    max-width: 700px;
    margin-left: auto;
    margin-right: auto;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
    font-size: 18px;
    line-height: 1.5;
    background: #f4f5f7;
    color: #1a1a1a;
  }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .subtitle { font-size: 15px; color: #555; margin: 0 0 16px; }
  .status-banner {
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
    background: ${statusMeta.bg};
    color: ${statusMeta.color};
  }
  .status-banner .big { font-size: 28px; font-weight: 700; margin: 0 0 6px; }
  .status-banner .meta { font-size: 15px; margin: 2px 0; }
  .card {
    background: #fff;
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 14px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
  }
  .card h2 { font-size: 17px; margin: 0 0 10px; }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 0;
    border-bottom: 1px solid #eee;
    font-size: 16px;
  }
  .row:last-child { border-bottom: none; }
  .row .label { color: #444; }
  .row .value { font-weight: 600; text-align: right; }
  .pill {
    display: inline-block;
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 14px;
    font-weight: 600;
  }
  .pill-ok { background: #e6f6ea; color: #1a7f37; }
  .pill-bad { background: #fdecec; color: #c31c1c; }
  /* 2026-08-25 — added with the CCTV inventory card: "too old" is a real
     third state, distinct from both fine and broken, and needs its own
     colour rather than borrowing one of the other two. */
  .pill-warn { background: #fff6dc; color: #8a6100; }
  .pill-unknown { background: #eef0f3; color: #555; }
  .source-list { margin: 0; padding: 0; list-style: none; }
  .source-list li {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    font-size: 15px;
  }
  .footer { text-align: center; font-size: 14px; color: #666; margin-top: 20px; }
  .footer a { color: #1a5fb4; text-decoration: none; display: block; padding: 6px 0; }
  .hint { font-size: 13px; color: #777; margin: 8px 0 0; }
  .table-wrap { overflow-x: auto; }
  table.usage-table { width: 100%; border-collapse: collapse; font-size: 14px; white-space: nowrap; }
  table.usage-table th, table.usage-table td { padding: 6px 8px; text-align: right; border-bottom: 1px solid #eee; }
  table.usage-table th:first-child, table.usage-table td:first-child { text-align: left; }
  table.usage-table th { color: #555; font-weight: 600; font-size: 12px; }
  .diff-zero { color: #1a7f37; }
  .diff-pos { color: #8a6100; }
  .diff-neg { color: #c31c1c; }
  .reference-card { background: #f8f7f2; border: 1px dashed #cbb; }
  .big-number { font-size: 40px; font-weight: 800; margin: 4px 0 12px; line-height: 1; }
  .big-unit { font-size: 16px; font-weight: 600; color: #666; }
  .quota-bar { height: 10px; border-radius: 999px; background: #eee; overflow: hidden; margin: 10px 0; }
  .quota-bar-fill { height: 100%; border-radius: 999px; }
  .quota-ok { background: #1a7f37; }
  .quota-warn { background: #b5850a; }
  .quota-bad { background: #c31c1c; }
  details.card summary { cursor: pointer; font-size: 17px; font-weight: 600; list-style: revert; }
  details.card summary::-webkit-details-marker { }
  details.card h3 { font-size: 15px; margin: 0 0 8px; }
</style>
</head>
<body>
  <h1>路況播報員</h1>
  <p class="subtitle">系統健康</p>

  <div class="status-banner">
    <p class="big">${statusMeta.emoji} ${escapeHtml(statusLabel)}</p>
    <p class="meta">最後更新（Asia/Taipei）：${escapeHtml(generatedAtLabel)}</p>
    ${staleNotice ? `<p class="meta">⚠️ ${escapeHtml(staleNotice)}</p>` : ''}
  </div>

  ${body}

  <div class="footer">
    <a href="/debug/status">查看原始 Debug JSON → /debug/status</a>
    <a href="/debug/pbs">查看 PBS 詳細資料 → /debug/pbs</a>
  </div>
</body>
</html>`;
}

// V1.9.2 — TDX Usage Summary RETIRED (formal decision, not a WRITE_ON_
// CHANGE optimization). This page used to render a full "TDX 用量對帳"
// quota dashboard (今日/本月/剩餘額度/月底預估/來源拆解/每日對帳) here,
// entirely sourced from tdx:usage:summary:v1 (see ../tdx/usageLedger.js).
// A real person now checks TDX quota/usage directly on TDX's own
// official back-office dashboard instead — this Worker no longer
// maintains its own duplicate summary, and scheduled.js no longer writes
// that key at all (see that file's own V1.9.2 comment). Deliberately a
// small, honest static note rather than leaving behind blank fields, a
// KV-miss exception, or stale/frozen numbers from before retirement —
// there is nothing left to read, so nothing here pretends otherwise.
// usageLedger.js's underlying functions are UNCHANGED and still directly
// unit-tested (test/tdxUsageLedger.test.js) — only this page's dependency
// on them, and the periodic KV writes that fed them, are gone.
function renderTdxUsageRetiredCard() {
  return `
  <div class="card">
    <h2>TDX 用量</h2>
    <p class="hint" style="margin:0;">TDX API 額度／用量請直接查看 TDX 官方後台，本頁不再重複維護用量摘要。</p>
  </div>`;
}

// V1.8.6.9 — deployment identity, DISPLAY-ONLY. Deliberately does NOT
// participate in `status`/statusMeta/the page's HTTP status code —
// checking this project's existing health severity contract (see
// computeStatus in healthSnapshot.js and applyStaleness above) found it
// tightly coupled to many existing tests that assert an exact "normal"
// tier for TDX-schedule-state scenarios (skipped-by-schedule, sleeping)
// using a bare `handleHealth(env)` call with no way to inject a "known
// good" deployment state. Folding deployment drift into that same
// severity computation would have meant updating every one of those
// tests just to keep asserting the SAME thing they already correctly
// assert about TDX/PBS/staleness — a needless, wide-blast-radius change
// for a fact that is better shown as its own clearly-separated card
// anyway (a version mismatch and "is the Cron pipeline healthy right
// now" are two different questions a person glancing at this page would
// ask separately). See PRODUCT_DECISIONS.md's V1.8.6.9 section for the
// full reasoning. 0 I/O — getDeploymentStatus(env) is pure.
function renderDeploymentCard(deploymentStatus) {
  const pill = (ok, yes = '是', no = '否') => `<span class="pill ${ok ? 'pill-ok' : 'pill-bad'}">${ok ? yes : no}</span>`;
  const shortSha = (sha) => (sha && sha !== 'unknown' ? sha.slice(0, 12) : sha || '（未知）');
  return `
  <div class="card">
    <h2>部署</h2>
    <div class="row"><span class="label">appVersion</span><span class="value">${escapeHtml(deploymentStatus.appVersion)}</span></div>
    <div class="row"><span class="label">Commit</span><span class="value">${escapeHtml(shortSha(deploymentStatus.deployedCommit))}</span></div>
    <div class="row"><span class="label">Branch</span><span class="value">${escapeHtml(deploymentStatus.deployedBranch)}</span></div>
    <div class="row"><span class="label">版本漂移</span>${pill(!deploymentStatus.driftDetected, '否', '⚠️ 是')}</div>
    <p class="hint"><a href="/admin/deployment-status-view">查看完整部署狀態 →</a></p>
  </div>`;
}

// 2026-08-25 (CCTV_METADATA_RECOVERY_V1) — the camera inventory's own health.
// A real 國1 93K accident on 2026-08-25 19:01 was pushed with correct text
// and no picture, because the inventory had quietly expired out of KV and,
// with TDX off, nothing was allowed to refill it. Nobody discovered that
// until an accident happened. This card exists so the next such gap is
// visible on a normal day.
//
// Ages are measured against the inventory's OWN publication time, not
// against a fetch time, because that is what actually matters: the file is
// republished daily, and a copy a month old is a copy that may not know
// about a camera built since.
const CCTV_METADATA_STALE_DAYS = 30;

// Exported under a deliberately awkward name purely so the three states
// (normal / missing / too old) can be pinned by a test — the page itself
// always calls the local function.
export { renderCctvMetadataCard as __renderCctvMetadataCardForTest };

function renderCctvMetadataCard(cctvMetadata, now) {
  if (!cctvMetadata) {
    return `
  <div class="card">
    <h2>攝影機基礎資料</h2>
    <div class="row"><span class="label">狀態</span><span class="pill pill-warn">尚未回報</span></div>
    <div class="row"><span class="label">說明</span><span class="value">這一輪 Cron 沒有記錄攝影機資料狀態（可能是舊版快照）。事故文字播報不受影響。</span></div>
  </div>`;
  }

  const count = cctvMetadata.recordCount || 0;
  const publishedAt = cctvMetadata.sourceUpdatedAt ? new Date(cctvMetadata.sourceUpdatedAt) : null;
  const ageDays =
    publishedAt && Number.isFinite(publishedAt.getTime())
      ? Math.floor((now.getTime() - publishedAt.getTime()) / (24 * 60 * 60 * 1000))
      : null;

  let pill = 'pill-ok';
  let label = '正常';
  let note = '';
  if (count === 0) {
    pill = 'pill-bad';
    label = '遺失';
    note = '攝影機基礎資料遺失，事故文字仍可播報，但 CCTV 圖片無法產生。';
  } else if (ageDays !== null && ageDays > CCTV_METADATA_STALE_DAYS) {
    pill = 'pill-warn';
    label = '過舊';
    note = `名冊已 ${ageDays} 天未更新。仍可產生 CCTV 圖片，但新設立的攝影機可能不在名冊內。`;
  }

  const sourceLabel =
    cctvMetadata.source === 'kv'
      ? `KV 快取${cctvMetadata.sourceName ? `（${cctvMetadata.sourceName}）` : ''}`
      : cctvMetadata.source === 'bundled'
        ? '內建官方名冊（交通部高速公路局）'
        : '無';

  return `
  <div class="card">
    <h2>攝影機基礎資料</h2>
    <div class="row"><span class="label">狀態</span><span class="pill ${pill}">${escapeHtml(label)}</span></div>
    <div class="row"><span class="label">資料筆數</span><span class="value">${count}</span></div>
    <div class="row"><span class="label">資料來源</span><span class="value">${escapeHtml(sourceLabel)}</span></div>
    <div class="row"><span class="label">名冊發布時間</span><span class="value">${
      publishedAt && Number.isFinite(publishedAt.getTime()) ? escapeHtml(formatTaipeiTime(publishedAt)) : '不明'
    }</span></div>
    <div class="row"><span class="label">最後寫入快取</span><span class="value">${
      cctvMetadata.fetchedAt ? escapeHtml(formatTaipeiTime(new Date(cctvMetadata.fetchedAt))) : '未寫入（使用內建名冊）'
    }</span></div>
    ${note ? `<div class="row"><span class="label">說明</span><span class="value">${escapeHtml(note)}</span></div>` : ''}
  </div>`;
}

function renderSnapshotBody(snapshot, now, deploymentStatus) {
  const { tdx, pbs, line, kv, broadcast } = snapshot;
  const cctvMetadataHtml = renderCctvMetadataCard(snapshot.cctvMetadata, now);

  const tdxSourcesHtml = tdx.sources
    .map(
      (s) => `<li><span>${escapeHtml(s.label)}</span><span class="pill ${s.ok ? 'pill-ok' : 'pill-bad'}">${
        s.ok ? '正常' : describeHttpStatus(s.httpStatus)
      }</span></li>`
    )
    .join('');

  const ineligibleRows = Object.entries(broadcast.ineligibleByReason || {})
    .map(
      ([reason, count]) =>
        `<div class="row"><span class="label">${escapeHtml(describeIneligibleReason(reason))}</span><span class="value">${count}</span></div>`
    )
    .join('');

  const lastPushLabel = line.lastLinePushAt ? formatTaipeiTime(new Date(line.lastLinePushAt)) : '尚無推送紀錄';
  const pushFailedCount = Math.max(0, (line.pushAttempted || 0) - (line.pushSucceeded || 0));

  return `
  <div class="card">
    <h2>TDX（國道／省道）</h2>
    <div class="row"><span class="label">狀態</span><span class="pill ${tdxTokenPillClass(tdx.tokenOk)}">${tdxTokenLabel(tdx.tokenOk)}</span></div>
    <div class="row"><span class="label">成功資料源</span><span class="value">${tdx.successfulSourceCount} / ${tdx.totalSourceCount}</span></div>
    <div class="row"><span class="label">本輪執行狀態</span><span class="value">${escapeHtml(describeTdxRunState(tdx))}</span></div>
    <div class="row"><span class="label">最近一次擷取時間</span><span class="value">${tdx.lastFetchedAt ? escapeHtml(formatTaipeiTime(new Date(tdx.lastFetchedAt))) : '尚無資料'}</span></div>
    <ul class="source-list">${tdxSourcesHtml}</ul>
  </div>

  ${renderTdxUsageRetiredCard()}

  <div class="card">
    <h2>PBS 警廣</h2>
    <div class="row"><span class="label">狀態</span><span class="pill ${pbs.ok ? 'pill-ok' : 'pill-bad'}">${pbs.ok ? '正常' : describeHttpStatus(pbs.relayStatus)}</span></div>
    <div class="row"><span class="label">全台原始資料</span><span class="value">${pbs.rawCount}</span></div>
    <div class="row"><span class="label">新竹相關</span><span class="value">${pbs.hsinchuCount}</span></div>
    <div class="row"><span class="label">目前有效</span><span class="value">${pbs.activeCount}</span></div>
    <div class="row"><span class="label">已排除</span><span class="value">${pbs.clearedCount}</span></div>
    <div class="row"><span class="label">過期</span><span class="value">${pbs.staleCount}</span></div>
  </div>

  <div class="card">
    <h2>LINE</h2>
    <div class="row"><span class="label">狀態</span><span class="pill ${line.ready ? 'pill-ok' : 'pill-bad'}">${line.ready ? '就緒' : '未就緒'}</span></div>
    <div class="row"><span class="label">個人訂閱</span><span class="value">${line.enabledUsersCount}</span></div>
    <div class="row"><span class="label">群組訂閱</span><span class="value">${line.enabledGroupsCount}</span></div>
    <div class="row"><span class="label">推送失敗</span><span class="value">${pushFailedCount}</span></div>
    <div class="row"><span class="label">上次推送</span><span class="value">${escapeHtml(lastPushLabel)}</span></div>
  </div>

  ${cctvMetadataHtml}

  <div class="card">
    <h2>KV</h2>
    <div class="row"><span class="label">狀態</span><span class="pill ${kv.available ? 'pill-ok' : 'pill-bad'}">${yesNo(kv.available)}</span></div>
  </div>

  <div class="card">
    <h2>目前播報</h2>
    <div class="row"><span class="label">符合播報事件</span><span class="value">${broadcast.broadcastRelevantCount}</span></div>
    <div class="row"><span class="label">等待推送</span><span class="value">${broadcast.pendingTargetCount}</span></div>
    <div class="row"><span class="label">排除事件</span><span class="value">${broadcast.typeIneligibleCount}</span></div>
    ${ineligibleRows}
  </div>
  ${renderDeploymentCard(deploymentStatus)}`;
}

export async function handleHealth(env) {
  const now = new Date();
  const { snapshot } = await readHealthSnapshot(env.TRAFFIC_KV);

  if (!snapshot) {
    return new Response(renderMissingSnapshotPage(now), {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const { status, staleNotice } = applyStaleness(snapshot, now);
  const statusMeta = STATUS_META[status] || STATUS_META.critical;

  // V1.9.2 — this used to be an extra read-only KV read of the pre-
  // compacted TDX usage summary here. Removed along with the "TDX 用量"
  // dashboard card itself — see renderTdxUsageRetiredCard's own comment.

  // V1.8.6.9 — 0 I/O, 0 extra TDX/PBS/LINE/GitHub/Cloudflare calls (see
  // deploymentStatus.js). Display-only — see renderDeploymentCard's own
  // comment for why this deliberately does not participate in
  // `status`/statusMeta/the HTTP status code below.
  const deploymentStatus = getDeploymentStatus(env);

  const html = renderPage({
    statusMeta,
    statusLabel: statusMeta.label,
    generatedAtLabel: formatTaipeiTime(new Date(snapshot.generatedAt)),
    staleNotice,
    body: renderSnapshotBody(snapshot, now, deploymentStatus),
    now,
  });

  return new Response(html, {
    status: status === 'critical' ? 503 : 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
