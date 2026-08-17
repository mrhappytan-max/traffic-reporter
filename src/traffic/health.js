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
    body: `<div class="card"><p>尚未有健康快照，等待下一次 Cron 執行（每 5 分鐘一次）。</p></div>`,
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
  .source-list { margin: 0; padding: 0; list-style: none; }
  .source-list li {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    font-size: 15px;
  }
  .footer { text-align: center; font-size: 14px; color: #666; margin-top: 20px; }
  .footer a { color: #1a5fb4; text-decoration: none; display: block; padding: 6px 0; }
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

function renderSnapshotBody(snapshot) {
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
    <h2>TDX</h2>
    <div class="row"><span class="label">狀態</span><span class="pill ${tdx.tokenOk ? 'pill-ok' : 'pill-bad'}">${yesNo(tdx.tokenOk)}</span></div>
    <div class="row"><span class="label">成功資料源</span><span class="value">${tdx.successfulSourceCount} / ${tdx.totalSourceCount}</span></div>
    <ul class="source-list">${tdxSourcesHtml}</ul>
  </div>

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

  const html = renderPage({
    statusMeta,
    statusLabel: statusMeta.label,
    generatedAtLabel: formatTaipeiTime(new Date(snapshot.generatedAt)),
    staleNotice,
    body: renderSnapshotBody(snapshot),
    now,
  });

  return new Response(html, {
    status: status === 'critical' ? 503 : 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
