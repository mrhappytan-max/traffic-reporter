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
// V1.8.6.9a — mobile UX pass, three real-device findings fixed:
//   1. Every timestamp on this page is now Asia/Taipei (see
//      formatTaipeiHHMM/formatTaipeiInstant below) — the per-row summary
//      time column used to show the RAW UTC hour via toISOString(),
//      which is exactly why a page full of ~12:00 Taipei events read as
//      a wall of "04:00"/"04:10". A fixed banner at the top states this
//      explicitly so a reader never has to guess which timezone they're
//      looking at.
//   2. source/status are fixed, closed vocabularies (see SOURCE_LABELS/
//      STATUS_META below, both already the single source of truth for
//      those labels) — the filter form now offers them as <select>
//      dropdowns built FROM those same objects, never a second,
//      hand-typed option list that could drift from the labels actually
//      shown on each row. road/rawId stay free-text `<input>` — they are
//      genuinely open-ended values, a dropdown would be wrong for them.
//   3. Dark theme throughout (see PAGE_STYLE) — this project's existing
//      admin pages (health.js/pipelineTraceView's own prior version) are
//      light-only; this is the first to go dark, on this page
//      specifically per real mobile-at-night usage.
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
  // V1.8.6.8 — replaces the old single "尚未到播報時間" catch-all with the
  // three actually-distinct reasons section 4 of that round's task asked
  // for (see pipelineTrace.js's computeStatus). `not-relevant` is kept
  // only as a fallback for a trace entry that predates this round or
  // otherwise never got eventTimeStatus populated.
  'not-started': { emoji: '⚠️', label: '事件尚未開始', cls: 'warn' },
  'event-ended': { emoji: '⚠️', label: '事件已結束', cls: 'warn' },
  'outside-broadcast-window': { emoji: '⚠️', label: '非播報時段（08:00～22:00）', cls: 'warn' },
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

// V1.8.6.8 — Asia/Taipei is a fixed UTC+8 offset (no DST), same hard-code
// already used throughout this project (broadcastHours.js/
// parseChineseDate.js) — never `Date`'s own locale-dependent
// toLocaleString, which would silently follow the SERVER's timezone.
function taipeiParts(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    year: shifted.getUTCFullYear(),
    month: pad(shifted.getUTCMonth() + 1),
    day: pad(shifted.getUTCDate()),
    hour: pad(shifted.getUTCHours()),
    minute: pad(shifted.getUTCMinutes()),
  };
}

function formatTaipeiInstant(iso) {
  const p = taipeiParts(iso);
  if (!p) return null;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// V1.8.6.9a — the per-row summary column ONLY ever showed a bare HH:MM
// (kept intentionally compact for the collapsed row), but the PRE-fix
// version built it from `new Date(...).toISOString().slice(11, 16)` —
// raw UTC, never Taipei. That is the exact real-device bug this round
// fixes: a page full of ~noon-Taipei events (04:00 UTC) reads as a wall
// of identical "04:00"/"04:10" rows with no way to tell they're actually
// 8 hours off. Reuses the SAME taipeiParts() as formatTaipeiInstant, one
// definition of "what time is it in Taipei" for this whole page.
function formatTaipeiHHMM(iso) {
  const p = taipeiParts(iso);
  return p ? `${p.hour}:${p.minute}` : '--:--';
}

function formatEventWindow(eventWindow) {
  if (!eventWindow || !eventWindow.effectiveStart) return null;
  const start = formatTaipeiInstant(eventWindow.effectiveStart);
  const end = eventWindow.effectiveEnd ? formatTaipeiInstant(eventWindow.effectiveEnd) : '持續中';
  return `${start} ～ ${end}`;
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
    ${renderField('事件有效時間（Asia/Taipei）', formatEventWindow(decision.eventWindow))}
    ${renderField('eventActive', decision.eventActive === null ? null : decision.eventActive ? '是（事件正在發生）' : decision.eventTimeStatus === 'not-started' ? '否（尚未開始）' : decision.eventTimeStatus === 'ended' ? '否（已結束）' : '否')}
    ${renderField('broadcastWindowActive（08:00～22:00）', decision.broadcastWindowActive === null ? null : decision.broadcastWindowActive ? '是' : '否')}
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
  const timeLabel = formatTaipeiHHMM(entry.identity.timestamp);

  return `
<details class="trace-row ${anomalyCls ? `row-${anomalyCls}` : ''}">
  <summary>
    <span class="col-time">${escapeHtml(timeLabel)}</span>
    <span class="col-source">${escapeHtml(sourceLabel(entry.identity.source))}</span>
    <span class="col-road">${escapeHtml(entry.identity.road)} ${escapeHtml(entry.normalized.direction || '')}</span>
    <span class="col-km">${escapeHtml(entry.normalized.startKM ?? '')}</span>
    <span class="col-type">${escapeHtml(typeLabel(entry.upstream.EventType))} → ${escapeHtml(typeLabel(entry.normalized.type))}</span>
    <span class="pill pill-${meta.cls}">${meta.emoji} ${escapeHtml(meta.label)}</span>
    ${cctv ? `<span class="badge badge-cctv">${cctv.emoji} ${cctv.label}</span>` : ''}
    ${map ? `<span class="badge badge-map">${map.emoji} ${map.label}</span>` : ''}
    ${anomalies.length > 0 ? `<span class="badge badge-${anomalyCls}">${anomalies.length} 項異常</span>` : ''}
  </summary>
  ${renderAnomalies(anomalies)}
  ${renderDetail(entry)}
</details>`;
}

// V1.8.6.9a — source/status are closed vocabularies (every value a row
// can ever show is one of these two objects' own keys — see
// sourceLabel/statusMeta above) — the filter <select> options are built
// FROM those same objects so the dropdown can never list a value that
// doesn't actually match anything, and never drifts out of sync with
// what a row actually displays.
function renderSelect({ name, value, options, placeholder }) {
  const optionsHtml = options
    .map(([optValue, label]) => `<option value="${escapeHtml(optValue)}" ${value === optValue ? 'selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');
  return `<select name="${name}" aria-label="${escapeHtml(placeholder)}">
    <option value="" ${value ? '' : 'selected'}>${escapeHtml(placeholder)}</option>
    ${optionsHtml}
  </select>`;
}

function renderFilterForm(filters) {
  const sourceSelect = renderSelect({
    name: 'source',
    value: filters.source || '',
    placeholder: '來源（全部）',
    options: Object.entries(SOURCE_LABELS).map(([value, label]) => [value, `${label}（${value}）`]),
  });
  const statusSelect = renderSelect({
    name: 'status',
    value: filters.status || '',
    placeholder: '狀態（全部）',
    options: Object.entries(STATUS_META).map(([value, meta]) => [value, `${meta.emoji} ${meta.label}`]),
  });

  return `
<form class="filters" method="get">
  ${sourceSelect}
  <input type="text" name="road" placeholder="道路（例：國道一號）" value="${escapeHtml(filters.road || '')}">
  <input type="text" name="rawId" placeholder="rawId" value="${escapeHtml(filters.rawId || '')}">
  ${statusSelect}
  <input type="number" name="limit" min="1" max="${MAX_LIST_LIMIT}" placeholder="筆數（預設 ${DEFAULT_LIST_LIMIT}）" value="${escapeHtml(filters.limit || '')}">
  <button type="submit">篩選</button>
  <a class="clear" href="/admin/pipeline-trace-view">清除</a>
</form>`;
}

// V1.8.6.9a — dark theme throughout, per real mobile-at-night usage.
// Palette anchored to the task's own hex bases (#0f1115 page /
// #1b1f26 card), state colors picked for solid contrast against those
// darks (verified readable — near-white text, never pure #fff, muted
// gray for secondary text, distinct green/amber/red/teal/blue tiers).
// `color-scheme: dark` on :root also nudges the BROWSER's own native
// form-control chrome (scrollbars, autofill, date pickers) toward dark
// by default in Safari/Chrome, on top of the explicit input/select/
// button overrides below — belt and suspenders, since native control
// theming varies by engine.
const PAGE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px; max-width: 960px; margin-left: auto; margin-right: auto;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
    font-size: 16px; line-height: 1.5; background: #0f1115; color: #e8e9ec;
  }
  h1 { font-size: 20px; margin: 0 0 4px; color: #f2f3f5; }
  .subtitle { font-size: 14px; color: #9aa1ac; margin: 0 0 8px; }
  .tz-banner {
    font-size: 13px; color: #9aa1ac; background: #171b21; border: 1px solid #2a2f3a;
    border-radius: 8px; padding: 8px 12px; margin: 0 0 16px;
  }
  .tz-banner strong { color: #e8e9ec; }
  .filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; background: #1b1f26; padding: 12px; border-radius: 12px; border: 1px solid #262b34; }
  .filters input, .filters select {
    flex: 1 1 120px; min-width: 90px; padding: 8px 10px; border: 1px solid #333a46; border-radius: 8px;
    font-size: 14px; background: #20242c; color: #e8e9ec;
  }
  .filters input::placeholder { color: #6b7280; opacity: 1; }
  .filters select { color-scheme: dark; }
  .filters button { padding: 8px 16px; border: none; border-radius: 8px; background: #2f6fdb; color: #fff; font-size: 14px; font-weight: 600; }
  .filters button:active { background: #2557b0; }
  .filters .clear { align-self: center; font-size: 13px; color: #9aa1ac; text-decoration: none; padding: 0 6px; }
  .filters .clear:active { color: #e8e9ec; }
  .trace-row { background: #1b1f26; border: 1px solid #262b34; border-radius: 10px; margin-bottom: 8px; overflow: hidden; }
  .trace-row.row-warn { border-left: 4px solid #d29922; }
  .trace-row.row-bad { border-left: 4px solid #f85149; }
  .trace-row summary {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    padding: 10px 12px; cursor: pointer; font-size: 14px; list-style: none;
  }
  .trace-row summary::-webkit-details-marker { display: none; }
  .trace-row summary::before { content: '▸'; color: #6b7280; margin-right: 2px; }
  .trace-row[open] summary::before { content: '▾'; }
  .trace-row[open] { background: #20242c; }
  .col-time { font-variant-numeric: tabular-nums; color: #9aa1ac; font-size: 13px; min-width: 42px; }
  .col-source { font-size: 12px; background: #262b34; color: #c3c9d1; border-radius: 6px; padding: 1px 6px; }
  .col-road { font-weight: 600; color: #f2f3f5; }
  .col-km { color: #9aa1ac; font-size: 13px; }
  .col-type { color: #9aa1ac; font-size: 13px; }
  .pill { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 13px; font-weight: 600; }
  .pill-ok { background: #12261a; color: #3fb950; }
  .pill-warn { background: #2b2111; color: #e3b341; }
  .pill-bad { background: #2d1214; color: #f85149; }
  .pill-unknown { background: #262b34; color: #9aa1ac; }
  .badge { font-size: 12px; background: #262b34; color: #c3c9d1; border-radius: 6px; padding: 2px 6px; }
  .badge-warn { background: #2b2111; color: #e3b341; }
  .badge-bad { background: #2d1214; color: #f85149; }
  .badge-cctv { background: #102b2a; color: #2dd4bf; }
  .badge-map { background: #0f2038; color: #58a6ff; }
  .anomalies { padding: 0 12px 8px; }
  .anomaly { font-size: 13px; padding: 4px 0; }
  .anomaly-error { color: #f85149; }
  .anomaly-warning { color: #e3b341; }
  .detail { display: flex; flex-direction: column; gap: 10px; padding: 4px 12px 14px; border-top: 1px solid #262b34; }
  .detail-section h4 { font-size: 13px; margin: 8px 0 4px; color: #c3c9d1; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; border-bottom: 1px solid #21252c; font-size: 13px; }
  .row .label { color: #9aa1ac; }
  .row .value { font-weight: 500; text-align: right; word-break: break-word; color: #e8e9ec; }
  .dim { color: #6b7280; }
  .formatted-output { white-space: pre-wrap; background: #12151a; border: 1px solid #262b34; border-radius: 8px; padding: 8px; font-size: 13px; margin: 4px 0; color: #e8e9ec; }
  .empty { text-align: center; color: #9aa1ac; padding: 40px 0; }
  .footer { text-align: center; font-size: 13px; color: #9aa1ac; margin-top: 20px; }
  .footer a { color: #58a6ff; text-decoration: none; display: block; padding: 4px 0; }
`;

function renderPage({ rows, filters, count, kvAvailable }) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>路況播報員 Pipeline Trace 查修頁</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>🔍 Pipeline Trace 查修頁</h1>
<p class="subtitle">最近 24 小時事件，最新在上。點一列展開查看上游資料／系統處理／最終結果。</p>
<p class="tz-banner">🕒 以下時間皆為 <strong>Asia/Taipei（台灣時間，UTC+8）</strong>，不是 UTC。</p>
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
