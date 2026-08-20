// V1.8.6.7 — GET /admin/pipeline-trace-view. Server-rendered HTML, no
// client-side JavaScript at all (the existing Admin CSP —
// security/adminAuth.js's applyAdminSecurityHeaders — is `default-src
// 'none'` with no script-src exception, and this page has no reason to
// ask for one). Expand/collapse uses native <details>/<summary>; the
// filter controls are a plain GET <form> that reloads the page with new
// query params — both work with zero script, keeping this Worker simple,
// fast, and low-resource exactly as instructed ("不要做花俏 Dashboard
// framework").
//
// Reads via listPipelineTrace/buildTraceAnomalies (pipelineTrace.js) —
// this module renders ONLY; it holds no KV logic and computes no
// classification/eligibility/anomaly decisions of its own.

import { listPipelineTrace, buildTraceAnomalies, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './pipelineTrace.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SOURCE_LABELS = { freeway: 'TDX 國道', highway: 'TDX 省道', pbs: 'PBS', cms: 'CMS', 'bus-hsinchu': '公車', 'bus-hsinchu-county': '公車' };
function sourceLabel(source) {
  return SOURCE_LABELS[source] || source || '未知';
}

const TYPE_LABELS = { accident: '事故', construction: '施工', closure: '封閉', control: '管制', congestion: '壅塞', alert: '公車異動', other: '其他' };
function typeLabel(type) {
  return TYPE_LABELS[type] || type || '未知';
}

// Section G's own fixed marker set — deliberately not extended per row,
// so every trace-view page a human ever looks at uses the SAME small
// vocabulary throughout (see the task's own list: ✅⚠️❌📷🚫🗺️).
const STATUS_META = {
  'line-sent': { emoji: '✅', label: '已播報', cls: 'ok' },
  duplicate: { emoji: '✅', label: '重複（內容未變更）', cls: 'ok' },
  merged: { emoji: '✅', label: '已與 TDX 合併', cls: 'ok' },
  'eligible-no-target': { emoji: '⚠️', label: '符合但無需推播', cls: 'warn' },
  suppressed: { emoji: '⚠️', label: '已抑制（同一事故）', cls: 'warn' },
  'not-relevant': { emoji: '⚠️', label: '尚未到播報時間', cls: 'warn' },
  ineligible: { emoji: '⚠️', label: '不符合播報資格', cls: 'warn' },
  gated: { emoji: '⚠️', label: '國道閘門（無 TDX 對應）', cls: 'warn' },
  'line-failed': { emoji: '❌', label: 'LINE 推播失敗', cls: 'bad' },
};
function statusMeta(status) {
  return STATUS_META[status] || { emoji: 'ℹ️', label: status || '未知', cls: 'unknown' };
}

function cctvBadge(entry) {
  const e = entry.enrichment || {};
  if (e.cctvEligible === true && e.imageUrlPresent === true) return { emoji: '📷', label: '有圖' };
  if (e.cctvEligible === true && e.imagePrepared === false) return { emoji: '🚫', label: `無圖（${escapeHtml(e.cctvSkippedByReason || '未知原因')}）` };
  if (e.cctvEligible === false) return null; // not applicable — no badge, not a failure
  return null;
}

function mapBadge(entry) {
  const resolution = entry.enrichment && entry.enrichment.kmLocationResolution;
  if (resolution && resolution.resolved) return { emoji: '🗺️', label: '地圖已解析' };
  return null;
}

function anomalySeverityClass(anomalies) {
  if (anomalies.some((a) => a.severity === 'error')) return 'bad';
  if (anomalies.length > 0) return 'warn';
  return null;
}

function renderAnomalies(anomalies) {
  if (anomalies.length === 0) return '';
  return `<div class="anomalies">${anomalies
    .map((a) => `<div class="anomaly anomaly-${a.severity}">${a.severity === 'error' ? '❌' : '⚠️'} ${escapeHtml(a.message)}</div>`)
    .join('')}</div>`;
}

function renderField(label, value) {
  return `<div class="row"><div class="label">${escapeHtml(label)}</div><div class="value">${value === null || value === undefined || value === '' ? '<span class="dim">—</span>' : escapeHtml(value)}</div></div>`;
}

function renderDetail(entry) {
  const { identity, upstream, normalized, decision, enrichment, delivery } = entry;
  return `
<div class="detail">
  <div class="detail-section">
    <h4>A. 上游資料</h4>
    ${renderField('來源', sourceLabel(identity.source))}
    ${renderField('rawId', identity.rawId)}
    ${renderField('EventType', upstream.EventType)}
    ${renderField('EventSubType', upstream.EventSubType)}
    ${renderField('Category', upstream.Category)}
    ${renderField('Description 摘要', upstream.descriptionSummary)}
    ${renderField('方向', upstream.rawDirection)}
    ${renderField('StartKM', upstream.rawStartKM)}
    ${renderField('EndKM', upstream.rawEndKM)}
    ${renderField('UpdatedAt', upstream.upstreamUpdatedAt)}
  </div>
  <div class="detail-section">
    <h4>B. 系統處理</h4>
    ${renderField('分類', typeLabel(normalized.type))}
    ${renderField('方向', normalized.direction)}
    ${renderField('StartKM', normalized.startKM)}
    ${renderField('EndKM', normalized.endKM)}
    ${renderField('DisplayKM', normalized.displayKM)}
    ${renderField('classificationSource', normalized.classificationSource ? `${normalized.classificationSource.field}=${normalized.classificationSource.value}` : null)}
    ${renderField('classificationEvidence', (normalized.classificationEvidence || []).join(', '))}
    ${renderField('eligibility', decision.eligibility === null ? null : decision.eligibility ? '符合' : '不符合')}
    ${renderField('eligibilityReason', decision.eligibilityReason)}
    ${renderField('dedupe', decision.dedupeResult)}
    ${renderField('suppression', decision.suppressionResult)}
    ${renderField('gating', decision.gatingResult)}
    ${renderField('kmLocationResolution', enrichment.kmLocationResolution ? (enrichment.kmLocationResolution.resolved ? `${enrichment.kmLocationResolution.locationLabel || ''}（${enrichment.kmLocationResolution.dataset}）` : `未解析（${enrichment.kmLocationResolution.reason || '無資料'}）`) : null)}
    ${renderField('cctvEligible', enrichment.cctvEligible === null ? null : enrichment.cctvEligible ? '是' : '否')}
    ${renderField('cctvSkippedByReason', enrichment.cctvSkippedByReason)}
  </div>
  <div class="detail-section">
    <h4>C. 最終結果</h4>
    <div class="formatted-output">${entry.delivery.formattedOutput ? escapeHtml(entry.delivery.formattedOutput) : '<span class="dim">（未產生播報文字）</span>'}</div>
    ${renderField('lineAttempted', delivery.lineAttempted)}
    ${renderField('lineSucceeded', delivery.lineSucceeded)}
    ${renderField('imagePrepared', enrichment.imagePrepared === null ? null : enrichment.imagePrepared ? '是' : '否')}
    ${renderField('imageUrlPresent', enrichment.imageUrlPresent === null ? null : enrichment.imageUrlPresent ? '是' : '否')}
    ${renderField('imageExpiresAt', enrichment.imageExpiresAt)}
    ${renderField('sharedFeedPersisted', delivery.sharedFeedPersisted === null ? null : delivery.sharedFeedPersisted ? '是' : '否')}
    ${renderField('sharedFeedWithImage', delivery.sharedFeedWithImage === null ? null : delivery.sharedFeedWithImage ? '是' : '否')}
  </div>
</div>`;
}

function renderRow(entry) {
  const anomalies = buildTraceAnomalies(entry);
  const meta = statusMeta(entry.status);
  const cctv = cctvBadge(entry);
  const map = mapBadge(entry);
  const anomalyCls = anomalySeverityClass(anomalies);
  const timeLabel = entry.identity.timestamp ? new Date(entry.identity.timestamp).toISOString().slice(11, 16) : '--:--';

  return `
<details class="trace-row ${anomalyCls ? `row-${anomalyCls}` : ''}">
  <summary>
    <span class="col-time">${escapeHtml(timeLabel)}</span>
    <span class="col-source">${escapeHtml(sourceLabel(entry.identity.source))}</span>
    <span class="col-road">${escapeHtml(entry.identity.road)} ${escapeHtml(entry.normalized.direction || '')}</span>
    <span class="col-km">${escapeHtml(entry.normalized.startKM ?? '')}</span>
    <span class="col-type">${escapeHtml(typeLabel(entry.upstream.EventType))} → ${escapeHtml(typeLabel(entry.normalized.type))}</span>
    <span class="pill pill-${meta.cls}">${meta.emoji} ${escapeHtml(meta.label)}</span>
    ${cctv ? `<span class="badge">${cctv.emoji} ${cctv.label}</span>` : ''}
    ${map ? `<span class="badge">${map.emoji} ${map.label}</span>` : ''}
    ${anomalies.length > 0 ? `<span class="badge badge-${anomalyCls}">${anomalies.length} 項異常</span>` : ''}
  </summary>
  ${renderAnomalies(anomalies)}
  ${renderDetail(entry)}
</details>`;
}

function renderFilterForm(filters) {
  return `
<form class="filters" method="get">
  <input type="text" name="source" placeholder="來源 (freeway/highway/pbs)" value="${escapeHtml(filters.source || '')}">
  <input type="text" name="road" placeholder="道路" value="${escapeHtml(filters.road || '')}">
  <input type="text" name="rawId" placeholder="rawId" value="${escapeHtml(filters.rawId || '')}">
  <input type="text" name="status" placeholder="狀態" value="${escapeHtml(filters.status || '')}">
  <input type="number" name="limit" min="1" max="${MAX_LIST_LIMIT}" placeholder="筆數（預設 ${DEFAULT_LIST_LIMIT}）" value="${escapeHtml(filters.limit || '')}">
  <button type="submit">篩選</button>
  <a class="clear" href="/admin/pipeline-trace-view">清除</a>
</form>`;
}

const PAGE_STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px; max-width: 960px; margin-left: auto; margin-right: auto;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
    font-size: 16px; line-height: 1.5; background: #f4f5f7; color: #1a1a1a;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { font-size: 14px; color: #555; margin: 0 0 16px; }
  .filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; background: #fff; padding: 12px; border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  .filters input { flex: 1 1 120px; min-width: 90px; padding: 6px 8px; border: 1px solid #ccc; border-radius: 8px; font-size: 14px; }
  .filters button { padding: 6px 14px; border: none; border-radius: 8px; background: #1a5fb4; color: #fff; font-size: 14px; }
  .filters .clear { align-self: center; font-size: 13px; color: #666; text-decoration: none; padding: 0 6px; }
  .trace-row { background: #fff; border-radius: 10px; margin-bottom: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); overflow: hidden; }
  .trace-row.row-warn { border-left: 4px solid #b8860b; }
  .trace-row.row-bad { border-left: 4px solid #c31c1c; }
  .trace-row summary {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    padding: 10px 12px; cursor: pointer; font-size: 14px; list-style: none;
  }
  .trace-row summary::-webkit-details-marker { display: none; }
  .trace-row summary::before { content: '▸'; color: #888; margin-right: 2px; }
  .trace-row[open] summary::before { content: '▾'; }
  .col-time { font-variant-numeric: tabular-nums; color: #555; font-size: 13px; min-width: 42px; }
  .col-source { font-size: 12px; background: #eef0f3; border-radius: 6px; padding: 1px 6px; }
  .col-road { font-weight: 600; }
  .col-km { color: #555; font-size: 13px; }
  .col-type { color: #555; font-size: 13px; }
  .pill { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 13px; font-weight: 600; }
  .pill-ok { background: #e6f6ea; color: #1a7f37; }
  .pill-warn { background: #fff6dc; color: #8a6100; }
  .pill-bad { background: #fdecec; color: #c31c1c; }
  .pill-unknown { background: #eef0f3; color: #555; }
  .badge { font-size: 12px; background: #eef0f3; border-radius: 6px; padding: 2px 6px; }
  .badge-warn { background: #fff6dc; color: #8a6100; }
  .badge-bad { background: #fdecec; color: #c31c1c; }
  .anomalies { padding: 0 12px 8px; }
  .anomaly { font-size: 13px; padding: 4px 0; }
  .anomaly-error { color: #c31c1c; }
  .anomaly-warning { color: #8a6100; }
  .detail { display: flex; flex-direction: column; gap: 10px; padding: 4px 12px 14px; border-top: 1px solid #eee; }
  .detail-section h4 { font-size: 13px; margin: 8px 0 4px; color: #333; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; border-bottom: 1px solid #f2f2f2; font-size: 13px; }
  .row .label { color: #666; }
  .row .value { font-weight: 500; text-align: right; word-break: break-word; }
  .dim { color: #aaa; }
  .formatted-output { white-space: pre-wrap; background: #f8f8f8; border-radius: 8px; padding: 8px; font-size: 13px; margin: 4px 0; }
  .empty { text-align: center; color: #777; padding: 40px 0; }
  .footer { text-align: center; font-size: 13px; color: #666; margin-top: 20px; }
  .footer a { color: #1a5fb4; text-decoration: none; display: block; padding: 4px 0; }
`;

function renderPage({ rows, filters, count, kvAvailable }) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>路況播報員 Pipeline Trace 查修頁</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>🔍 Pipeline Trace 查修頁</h1>
<p class="subtitle">最近 24 小時事件，最新在上。點一列展開查看上游資料／系統處理／最終結果。</p>
${renderFilterForm(filters)}
${!kvAvailable ? '<div class="empty">⚠️ 無法讀取 KV，暫無資料</div>' : count === 0 ? '<div class="empty">這個篩選條件下沒有資料</div>' : rows}
<div class="footer">
  <a href="/admin/pipeline-trace">查看原始 JSON</a>
  <a href="/admin/broadcast-provenance">Broadcast Provenance（僅成功推播）</a>
  <a href="/health">系統健康頁</a>
</div>
</body>
</html>`;
}

/**
 * GET /admin/pipeline-trace-view (Admin-Basic-Auth-gated at the route
 * level — see index.js). Zero TDX/PBS/CCTV/LINE calls — pure KV read via
 * listPipelineTrace, same bounded scan as the JSON endpoint. Cache-
 * Control: no-store applied by applyAdminSecurityHeaders (index.js),
 * same as every other admin page.
 */
export async function handlePipelineTraceView(env, request) {
  const url = new URL(request.url);
  const filters = {
    source: url.searchParams.get('source') || '',
    road: url.searchParams.get('road') || '',
    rawId: url.searchParams.get('rawId') || '',
    status: url.searchParams.get('status') || '',
    limit: url.searchParams.get('limit') || '',
  };

  const { records, kvAvailable } = await listPipelineTrace(env.TRAFFIC_KV, {
    limit: filters.limit || undefined,
    source: filters.source || undefined,
    road: filters.road || undefined,
    rawId: filters.rawId || undefined,
    status: filters.status || undefined,
  });

  const rows = records.map(renderRow).join('\n');
  const html = renderPage({ rows, filters, count: records.length, kvAvailable });

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
