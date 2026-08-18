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
  aggregateUsageForMonth,
  PRODUCTION_TDX_CALLS_PER_DAY,
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

// V1.8.6 — TDX usage reconciliation ("TDX 用量對帳"). Every number below
// comes from tdx:usage:summary:v1 (see ../tdx/usageLedger.js) via a
// single extra read-only KV read in handleHealth — zero TDX/PBS/LINE
// calls, same guarantee as the rest of this page. The "今日 Production
// 理論" figure is the ONLY exception to "everything here comes from KV":
// it's pure date math (theoreticalProductionCallsToday), not a network
// call, so it stays accurate even between Cron ticks if a human refreshes
// this page mid-tick.

const USAGE_CONTEXT_LABELS = {
  'production-cron': 'Production Cron',
  'debug-status': 'Debug Status',
  'debug-tdx': 'Debug TDX',
  'admin-cctv': 'Admin CCTV',
  other: '其他',
};

const USAGE_SOURCE_LABELS = {
  freeway: '國道',
  highway: '省道',
  cms: 'CMS',
  'bus-hsinchu': '公車(市)',
  'bus-hsinchu-county': '公車(縣)',
  cctv: 'CCTV',
  other: '其他',
};

function formatBytesEstimate(bytes) {
  const n = Number(bytes) || 0;
  const mb = n / (1024 * 1024);
  if (mb >= 0.1) return `${mb.toFixed(1)} MB`;
  const kb = n / 1024;
  return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
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

function renderTdxUsageBody(summary, now) {
  const days = (summary && summary.days) || {};
  const todayStr = taipeiDateString(now);
  const today = days[todayStr] || emptyDayTotals();

  const theoreticalToday = theoreticalProductionCallsToday(now);
  const diffToday = (today.totalDataCalls || 0) - theoreticalToday;
  const manualToday = today.manualDataCalls || 0;

  const todaySourceRows = Object.entries(USAGE_SOURCE_LABELS)
    .map(([key, label]) => `<li><span>${escapeHtml(label)}</span><span>${(today.bySource && today.bySource[key]) || 0}</span></li>`)
    .join('');

  const todayContextRows = Object.entries(USAGE_CONTEXT_LABELS)
    .filter(([key]) => key !== 'production-cron')
    .map(([key, label]) => `<li><span>${escapeHtml(label)}</span><span>${(today.byContext && today.byContext[key]) || 0}</span></li>`)
    .join('');

  // Monthly rollup — see usageLedger.js's aggregateUsageForMonth: sums
  // every day-row already present in `summary.days` (at most
  // USAGE_SUMMARY_RETENTION_DAYS=35 entries) that falls in the SAME
  // Asia/Taipei calendar month as `now`. No extra KV read, no full-
  // history scan — computed entirely from the summary object already read.
  const monthTotals = aggregateUsageForMonth(summary, now);

  const dailyRows = lastNDates(now, 30)
    .map((date) => {
      const row = days[date];
      if (!row) {
        return `<tr><td>${escapeHtml(displayDate(date))}</td><td colspan="6" style="text-align:center;color:#999;">尚無資料</td></tr>`;
      }
      const theoretical = date === todayStr ? theoreticalToday : PRODUCTION_TDX_CALLS_PER_DAY;
      const diff = (row.totalDataCalls || 0) - theoretical;
      return `<tr>
        <td>${escapeHtml(displayDate(date))}</td>
        <td>${row.productionDataCalls || 0}</td>
        <td>${row.manualDataCalls || 0}</td>
        <td>${row.totalDataCalls || 0}</td>
        <td>${formatBytesEstimate(row.payloadBytesEstimate)}</td>
        <td>${theoretical}</td>
        <td class="${diffClass(diff)}">${diffLabel(diff)}</td>
      </tr>`;
    })
    .join('');

  return `
  <div class="card">
    <h2>TDX 用量對帳</h2>
    <div class="row"><span class="label">今日呼叫</span><span class="value">${today.totalDataCalls || 0} 次</span></div>
    <div class="row"><span class="label">今日 Production 理論</span><span class="value">${theoreticalToday} 次</span></div>
    <div class="row"><span class="label">差額</span><span class="value ${diffClass(diffToday)}">${diffLabel(diffToday)} 次</span></div>
    <div class="row"><span class="label">今日估算流量</span><span class="value">${formatBytesEstimate(today.payloadBytesEstimate)}</span></div>
    <div class="row"><span class="label">人工額外呼叫</span><span class="value">${manualToday} 次</span></div>
    <p class="hint">理論值依目前時間與 08:00–22:00／每 20 分鐘排程動態計算；估算流量為「本地估算傳輸量」，可能與 TDX 官方傳輸量口徑不同（壓縮／計費方式可能不同），僅供長期校正參考。</p>
  </div>

  <div class="card">
    <h2>來源拆解（今日）</h2>
    <p class="hint" style="margin:0 0 8px;">Production</p>
    <ul class="source-list">${todaySourceRows}</ul>
    <p class="hint" style="margin:10px 0 8px;">人工 / Debug / Admin</p>
    <ul class="source-list">${todayContextRows}</ul>
  </div>

  <div class="card">
    <h2>本月總覽</h2>
    <div class="row"><span class="label">本月累積呼叫</span><span class="value">${monthTotals.totalDataCalls} 次</span></div>
    <div class="row"><span class="label">Production Cron</span><span class="value">${monthTotals.productionDataCalls} 次</span></div>
    <div class="row"><span class="label">Debug / Admin</span><span class="value">${monthTotals.manualDataCalls} 次</span></div>
    <div class="row"><span class="label">OAuth 真實刷新</span><span class="value">${monthTotals.oauthRequests} 次</span></div>
    <div class="row"><span class="label">估算資料量</span><span class="value">${formatBytesEstimate(monthTotals.payloadBytesEstimate)}</span></div>
  </div>

  <div class="card">
    <h2>每日對帳表（近 30 天）</h2>
    <div class="table-wrap">
      <table class="usage-table">
        <thead><tr><th>日期</th><th>Production</th><th>人工/Debug</th><th>總呼叫</th><th>估算流量</th><th>理論呼叫</th><th>差額</th></tr></thead>
        <tbody>${dailyRows}</tbody>
      </table>
    </div>
    <p class="hint">差額 0 為正常；正數代表有額外 TDX 呼叫（可能是人工 Debug/Admin，也可能是異常超量）；負數代表本機記錄少於理論值（可能是 Cron 漏跑或 API 未嘗試）。差額本身僅作為用量異常提示，不直接判定系統為 Critical。</p>
  </div>

  <div class="card reference-card">
    <h2>TDX 官方歷史參考（非本機統計）</h2>
    <p class="hint" style="margin:0 0 8px;">以下數字來自 TDX 官方後台畫面，人工輸入，僅供比對參考，並非路況播報員本機的 Usage Ledger 統計。本機 Usage Ledger 自 V1.8.6 上線起才開始正式累積，之前的日期一律顯示「尚無資料」，不回推猜測。</p>
    <div class="row"><span class="label">2026-08-16 官方呼叫</span><span class="value">1490 次</span></div>
    <div class="row"><span class="label">2026-08-16 官方傳輸</span><span class="value">17016 KB</span></div>
    <div class="row"><span class="label">2026-08-17 官方呼叫</span><span class="value">704 次</span></div>
    <div class="row"><span class="label">2026-08-17 官方傳輸</span><span class="value">10534 KB</span></div>
    <div class="row"><span class="label">當月官方累積（官方畫面顯示）</span><span class="value">2194 次 / 約 27 MB</span></div>
  </div>`;
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
