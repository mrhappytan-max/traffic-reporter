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
import {
  readTdxUsageSummary,
  taipeiDateString,
  theoreticalProductionCallsToday,
  theoreticalProductionCallsForDay,
  isPartialTrackingDay,
  estimatePoints,
  estimateMonthUsage,
  hasPendingBaselineCalibrationGap,
  remainingPoints,
  usagePercent,
  projectEndOfMonthPoints,
  TDX_MONTHLY_POINT_BUDGET,
  TDX_CALLS_PER_POINT,
  TDX_TRAFFIC_MB_PER_POINT,
} from '../tdx/usageLedger.js';

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

// V1.8.6.1 — quota-first mobile dashboard: "3 秒看懂今天/本月用了多少、
// 還剩多少、月底會不會爆" comes first; engineering-grade detail (official
// historical reference, full byContext breakdown, OAuth counts) moves
// into a collapsible "進階資訊" <details> at the bottom — no JS needed,
// a native disclosure element. Every number still comes from
// tdx:usage:summary:v1 (see ../tdx/usageLedger.js) via the single
// extra read-only KV read in handleHealth — zero TDX/PBS/LINE calls.
// Point-quota math (estimatePoints/remainingPoints/usagePercent/
// projectEndOfMonthPoints) and "今日 Production 理論" are pure date/
// arithmetic computed from that same already-read summary — no extra KV
// read, no network call of any kind.

const USAGE_CONTEXT_LABELS = {
  'debug-status': 'Debug Status',
  'debug-tdx': 'Debug TDX',
  'admin-cctv': 'CCTV', // every admin-cctv call IS a CCTV metadata probe in practice (cctv-probe/cctv-hsinchu-probe) — shown here, under "人工/管理", never under Production
  other: '其他',
};

// V1.8.6.2 — "TDX 來源（今日）" shows TDX API SOURCE usage (what actually
// consumes TDX quota), not call CONTEXT — 國道/省道/CCTV metadata are the
// three TDX sources this project ever fetches, confirmed against TDX's own
// backend accounting. Reads `today.bySource` (the marginal total across
// EVERY context — Production, Debug, Admin alike), deliberately NOT the
// `byContextSource['production-cron']` slice used before V1.8.6.2 — a
// person checking "how much TDX quota did today actually use" needs the
// real total regardless of which code path made the call. Always renders
// all three rows, even at 0 — see the task's own "三列固定顯示" requirement.
// CCTV here is ONLY TDX CCTV metadata (cctv-probe/cctv-hsinchu-probe, via
// fetchTdxJson -> bySource.cctv, see usageLedger.js) — the actual LINE
// CCTV image fetch is a *.freeway.gov.tw MJPEG frame grab (see
// hsinchuCctvProbe.js's handleHsinchuCctvFrame — "0 TDX calls"), not a TDX
// API call, and must never be folded in here — untouched by this round.
const TDX_SOURCE_LABELS = { freeway: '國道', highway: '省道', cctv: 'CCTV' };

const RETIRED_SOURCE_LABELS = { cms: 'CMS', 'bus-hsinchu': '公車市', 'bus-hsinchu-county': '公車縣' };

function formatBytesEstimate(bytes) {
  const n = Number(bytes) || 0;
  const mb = n / (1024 * 1024);
  if (mb >= 0.1) return `${mb.toFixed(1)} MB`;
  const kb = n / 1024;
  return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
}

/** 3 decimals throughout, matching the required "X.XXX 點" display — this is a LOCAL ESTIMATE, never claimed identical to TDX's own official point accounting (see usageLedger.js's estimatePoints). */
function formatPoints(points) {
  return (Number(points) || 0).toFixed(3);
}

function formatPercent(fraction) {
  return `${Math.round((Number(fraction) || 0) * 100)}%`;
}

function displayDate(dateStr) {
  const parts = String(dateStr).split('-');
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : dateStr;
}

function diffClass(diff) {
  if (diff === 0) return 'diff-zero';
  return diff > 0 ? 'diff-pos' : 'diff-neg';
}

function diffLabel(diff) {
  if (diff === 0) return '0';
  return diff > 0 ? `+${diff}` : `${diff}`;
}

function emptyDayTotals() {
  return {
    totalDataCalls: 0,
    productionDataCalls: 0,
    manualDataCalls: 0,
    oauthRequests: 0,
    payloadBytesEstimate: 0,
    bySource: {},
    byContext: {},
    byContextSource: {},
  };
}

/**
 * Last N calendar days (Asia/Taipei), newest first. A day with no ledger
 * entry at all (before V1.8.6 went live, or a genuinely missed write)
 * renders as "尚無資料" in the table below — NEVER a fabricated 0, per
 * the explicit instruction not to pretend this app can retroactively
 * know its own historical call volume.
 */
function lastNDates(now, n) {
  const dates = [];
  for (let i = 0; i < n; i += 1) {
    dates.push(taipeiDateString(new Date(now.getTime() - i * 24 * 60 * 60 * 1000)));
  }
  return dates;
}

/**
 * <70% -> 額度充足, 70–90% -> 注意用量, >=90% -> 接近上限. A quota WARNING
 * only — deliberately never promoted into this page's own critical/
 * degraded/normal `status` (see applyStaleness/STATUS_META above); a
 * near-exhausted TDX point budget is a usage anomaly to watch, not a
 * pipeline failure.
 */
function quotaStatus(percent) {
  if (percent < 0.7) return { emoji: '✅', label: '額度充足', className: 'quota-ok' };
  if (percent < 0.9) return { emoji: '⚠️', label: '注意用量', className: 'quota-warn' };
  return { emoji: '🔴', label: '接近上限', className: 'quota-bad' };
}

function renderTdxUsageBody(summary, now) {
  const days = (summary && summary.days) || {};
  const todayStr = taipeiDateString(now);
  const today = days[todayStr] || emptyDayTotals();
  const trackingStartedAt = summary && summary.trackingStartedAt;

  const theoreticalToday = theoreticalProductionCallsToday(now, trackingStartedAt);
  const todayIsPartialTracking = isPartialTrackingDay(todayStr, trackingStartedAt);
  const todayPoints = estimatePoints(today);

  // Monthly rollup — see usageLedger.js's estimateMonthUsage: Local-
  // Ledger totals (aggregateUsageForMonth, at most USAGE_SUMMARY_
  // RETENTION_DAYS=35 day-rows, all in the SAME Asia/Taipei calendar
  // month as `now`) PLUS a hand-confirmed official pre-Ledger baseline
  // when this exact month has one (2026-08 only, as of this writing —
  // the Local Usage Ledger only started 2026-08-18; every later month is
  // fully Ledger-covered and gets baseline=null automatically). No extra
  // KV read, no full-history scan — computed entirely from the summary
  // object already read.
  const monthUsage = estimateMonthUsage(summary, now);
  const monthTotals = monthUsage.localTotals; // still used below for the "OAuth（本月）" advanced-info row — baseline carries no OAuth figure
  const remaining = remainingPoints(monthUsage.estimatedPoints);
  const percent = usagePercent(monthUsage.estimatedPoints);
  const quota = quotaStatus(percent);
  const projection = projectEndOfMonthPoints(summary, now);
  const baselineNoteHtml = monthUsage.baseline
    ? `<p class="hint">含 ${escapeHtml(displayDate(monthUsage.baseline.fromDate))}–${escapeHtml(displayDate(monthUsage.baseline.throughDate))} TDX 官方既有用量 ${formatPoints(monthUsage.baseline.officialPoints)} 點（Local Usage Ledger 啟用前，使用者從 TDX 官方後台人工確認，非本機回推）。</p>`
    : '';

  // CORRECTION (post-review) — a genuine, currently-unresolved coverage
  // gap: the official baseline covers real usage up through
  // baseline.throughDate, but the Local Ledger only started tracking
  // mid-day on a LATER date — the stretch in between is covered by
  // NEITHER source (see usageLedger.js's hasPendingBaselineCalibrationGap
  // for the exact condition and TDX_OFFICIAL_USAGE_BASELINES' own
  // comment for how to resolve it once TDX's next official figure is
  // available). Never estimated/guessed — only flagged, with the
  // affected numbers explicitly marked "暫估" rather than presented as
  // fully reconciled.
  const pendingCalibrationGap = hasPendingBaselineCalibrationGap(summary, now);
  const pendingGapDateLabel = pendingCalibrationGap ? displayDate(taipeiDateString(new Date(trackingStartedAt))) : '';
  const pendingGapWarningHtml = pendingCalibrationGap
    ? `<p class="hint">⚠️ ${escapeHtml(pendingGapDateLabel)} Ledger 啟用前用量尚待 TDX 官方日結校正（目前為暫估，非已完整校正的剩餘額度）。</p>`
    : '';
  const provisionalBadge = pendingCalibrationGap ? '（暫估）' : '';

  // --- TDX 來源（今日） ---
  // V1.8.6.2: this is a SOURCE breakdown (what TDX API resource was hit),
  // not a CONTEXT breakdown (which call path hit it) — reads `bySource`
  // directly, mixing every context on purpose. Always all 3 rows, even at
  // 0 — see the top-of-file V1.8.6.2 comment above TDX_SOURCE_LABELS.
  const todaySourceRows = Object.entries(TDX_SOURCE_LABELS)
    .map(([key, label]) => `<li><span>${escapeHtml(label)}</span><span>${(today.bySource && today.bySource[key]) || 0}</span></li>`)
    .join('');

  // --- 呼叫情境（今日，進階） ---
  // CONTEXT breakdown (Production Cron / Debug Status / Debug TDX / Admin
  // CCTV) — a separate axis from the source breakdown above, moved into
  // 進階資訊 per V1.8.6.2 so it never sits in the same visual layer as TDX
  // 來源. The 今日 card's own "Production XX 次 / 人工額外 XX 次" rows
  // already cover the common case at a glance.
  const manualNonZero = Object.entries(USAGE_CONTEXT_LABELS).filter(([key]) => ((today.byContext && today.byContext[key]) || 0) > 0);
  const manualRowsHtml =
    manualNonZero.length > 0
      ? `<ul class="source-list">${manualNonZero.map(([key, label]) => `<li><span>${escapeHtml(label)}</span><span>${today.byContext[key]}</span></li>`).join('')}</ul>`
      : `<p class="hint" style="margin:0;">今日無人工額外呼叫</p>`;

  const retiredNonZero = Object.entries(RETIRED_SOURCE_LABELS).filter(([key]) => ((today.bySource && today.bySource[key]) || 0) > 0);
  const retiredWarningHtml =
    retiredNonZero.length > 0
      ? `<div class="card" style="border:1px solid #f0c36d;background:#fff8e8;">
          <h2>⚠️ 發現已停用 TDX 來源</h2>
          <ul class="source-list">${retiredNonZero.map(([key, label]) => `<li><span>${escapeHtml(label)}</span><span>${today.bySource[key]}</span></li>`).join('')}</ul>
          <p class="hint">CMS／公車動態已於 V1.6.1 退出正式 Production，正常情況下這裡永遠是 0（/debug/tdx、/debug/status 本身也已限制只抓 freeway+highway，正常開 Debug 不會抓到這些來源）；若非 0，代表有未預期程式路徑呼叫到已停用來源。</p>
        </div>`
      : '';

  // --- 每日對帳（近 7 天，手機優先；完整 30 天資料仍在 summary 裡） ---
  const dailyRows = lastNDates(now, 7)
    .map((date) => {
      const row = days[date];
      if (!row) {
        return `<tr><td>${escapeHtml(displayDate(date))}</td><td colspan="4" style="text-align:center;color:#999;">尚無資料</td></tr>`;
      }
      const theoretical = date === todayStr ? theoreticalToday : theoreticalProductionCallsForDay(date, trackingStartedAt);
      const diff = (row.totalDataCalls || 0) - theoretical;
      const partial = isPartialTrackingDay(date, trackingStartedAt);
      const dateCell = partial ? `${escapeHtml(displayDate(date))}<br><span class="hint" style="margin:0;">部分日</span>` : escapeHtml(displayDate(date));
      return `<tr>
        <td>${dateCell}</td>
        <td>${row.totalDataCalls || 0}</td>
        <td>${formatBytesEstimate(row.payloadBytesEstimate)}</td>
        <td>${formatPoints(estimatePoints(row))}</td>
        <td class="${diffClass(diff)}">${diffLabel(diff)}</td>
      </tr>`;
    })
    .join('');

  const partialTrackingNotice = todayIsPartialTracking
    ? `<p class="hint">⚠️ 部分日（自 ${escapeHtml(formatTaipeiTime(new Date(trackingStartedAt)))} 開始追蹤），今日理論值只計算開始追蹤後應發生的排程次數。</p>`
    : '';

  const projectionBody = projection.ready
    ? `<p class="big-number" style="font-size:28px;">${formatPoints(projection.projected)} <span class="big-unit">/ ${TDX_MONTHLY_POINT_BUDGET.toFixed(2)} 點</span></p>
       <p class="hint">${projection.projected <= TDX_MONTHLY_POINT_BUDGET ? '✅ 預估額度足夠' : '🔴 依目前速度可能超額'}（依 ${projection.completeDayCount} 個完整追蹤日平均 ${formatPoints(projection.avgPointsPerDay)} 點/日，本月還剩 ${projection.remainingDaysAfterToday} 天）</p>`
    : `<p class="hint">資料累積中（需要至少 2 個完整追蹤日才能預估月底用量，目前 ${projection.completeDayCount} 天）</p>`;

  return `
  <div class="card">
    <h2>TDX 今日</h2>
    <p class="big-number">${today.totalDataCalls || 0} <span class="big-unit">次</span></p>
    <div class="row"><span class="label">流量</span><span class="value">${formatBytesEstimate(today.payloadBytesEstimate)}</span></div>
    <div class="row"><span class="label">估算點數</span><span class="value">${formatPoints(todayPoints)} 點</span></div>
    <div class="row"><span class="label">Production</span><span class="value">${today.productionDataCalls || 0} 次</span></div>
    <div class="row"><span class="label">人工額外</span><span class="value">${today.manualDataCalls || 0} 次</span></div>
    ${partialTrackingNotice}
  </div>

  <div class="card">
    <h2>TDX 本月${provisionalBadge}</h2>
    <p class="big-number">${monthUsage.estimatedCalls} <span class="big-unit">次</span></p>
    <div class="row"><span class="label">流量</span><span class="value">${formatBytesEstimate(monthUsage.estimatedBytes)}</span></div>
    <div class="row"><span class="label">估算點數</span><span class="value">${formatPoints(monthUsage.estimatedPoints)} 點</span></div>
    ${baselineNoteHtml}
  </div>

  <div class="card">
    <h2>剩餘額度${provisionalBadge}</h2>
    <p class="big-number">${formatPoints(remaining)} <span class="big-unit">/ ${TDX_MONTHLY_POINT_BUDGET.toFixed(3)} 點</span></p>
    <div class="quota-bar"><div class="quota-bar-fill ${quota.className}" style="width:${Math.min(100, percent * 100)}%;"></div></div>
    <div class="row"><span class="label">已使用</span><span class="value">${formatPercent(percent)}</span></div>
    <div class="row"><span class="label">剩餘</span><span class="value">${formatPercent(Math.max(0, 1 - percent))}</span></div>
    <p class="hint">${quota.emoji} ${quota.label}</p>
    ${pendingGapWarningHtml}
  </div>

  <div class="card">
    <h2>月底預估</h2>
    ${projectionBody}
  </div>

  <div class="card">
    <h2>TDX 來源（今日）</h2>
    <ul class="source-list">${todaySourceRows}</ul>
    <p class="hint">國道／省道即時道路事件與 CCTV metadata 皆為實際消耗 TDX 額度的資料來源（依 TDX 官方後台確認）；不分呼叫情境，Production／Debug／Admin 呼叫同一來源皆計入同一列。</p>
  </div>

  ${retiredWarningHtml}

  <div class="card">
    <h2>每日對帳（近 7 天）</h2>
    <div class="table-wrap">
      <table class="usage-table">
        <thead><tr><th>日期</th><th>呼叫</th><th>流量</th><th>估算點數</th><th>差額</th></tr></thead>
        <tbody>${dailyRows}</tbody>
      </table>
    </div>
    <p class="hint">完整 30 天資料仍保留在系統內，這裡只顯示近 7 天。差額 0 為正常；正數代表有額外 TDX 呼叫（人工 Debug/Admin 或異常超量）；負數代表可能漏跑 Cron。僅供用量異常提示，不直接判定系統為 Critical。</p>
  </div>

  <details class="card">
    <summary>進階資訊</summary>
    <div style="margin-top:12px;">
      <div class="row"><span class="label">今日 Production 理論</span><span class="value">${theoreticalToday} 次</span></div>
      <div class="row"><span class="label">OAuth 真實刷新（今日）</span><span class="value">${today.oauthRequests || 0} 次</span></div>
      <div class="row"><span class="label">OAuth 真實刷新（本月）</span><span class="value">${monthTotals.oauthRequests} 次</span></div>
      <p class="hint">估算流量為「本地估算傳輸量」，可能與 TDX 官方傳輸量口徑不同（壓縮／計費方式可能不同），僅供長期校正參考。點數換算：${TDX_CALLS_PER_POINT} 次呼叫 = 1 點，${TDX_TRAFFIC_MB_PER_POINT}MB 傳輸 = 1 點，皆為「本地估算點數」，非官方帳務。</p>
    </div>
    <div style="margin-top:12px;">
      <h3>呼叫情境（今日）</h3>
      <p class="hint" style="margin:0 0 8px;">Production Cron／Debug Status／Debug TDX／Admin CCTV 是「呼叫情境」，與上方「TDX 來源」是不同的分類軸，僅供除錯參考。</p>
      ${manualRowsHtml}
    </div>
    <div style="margin-top:12px;">
      <h3>TDX 官方歷史參考（非本機統計）</h3>
      <p class="hint" style="margin:0 0 8px;">以下數字來自 TDX 官方後台畫面，人工輸入，僅供比對參考，並非路況播報員本機的 Usage Ledger 統計。本機 Usage Ledger 自 V1.8.6 上線起才開始正式累積，之前的日期一律顯示「尚無資料」，不回推猜測。</p>
      <div class="row"><span class="label">2026-08-16 官方呼叫</span><span class="value">1490 次</span></div>
      <div class="row"><span class="label">2026-08-16 官方傳輸</span><span class="value">17016 KB</span></div>
      <div class="row"><span class="label">2026-08-17 官方呼叫</span><span class="value">704 次</span></div>
      <div class="row"><span class="label">2026-08-17 官方傳輸</span><span class="value">10534 KB</span></div>
      <div class="row"><span class="label">當月官方累積（官方畫面顯示）</span><span class="value">2194 次 / 約 27 MB</span></div>
    </div>
  </details>`;
}

function renderSnapshotBody(snapshot, usageSummary, now) {
  const { tdx, pbs, line, kv, broadcast } = snapshot;

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

  ${renderTdxUsageBody(usageSummary, now)}

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
  </div>`;
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

  // V1.8.6: ONE extra read-only KV read of the pre-compacted usage
  // summary (see ../tdx/usageLedger.js) — never a scan of raw entries,
  // never a TDX/PBS/LINE call. A missing/unavailable summary (e.g. right
  // after this round's first deploy, before the first Cron compaction)
  // degrades to every count in the usage card reading 0/"尚無資料" —
  // never an error, never affects this page's own status/staleness.
  const { summary: usageSummary } = await readTdxUsageSummary(env.TRAFFIC_KV);

  const html = renderPage({
    statusMeta,
    statusLabel: statusMeta.label,
    generatedAtLabel: formatTaipeiTime(new Date(snapshot.generatedAt)),
    staleNotice,
    body: renderSnapshotBody(snapshot, usageSummary, now),
    now,
  });

  return new Response(html, {
    status: status === 'critical' ? 503 : 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
