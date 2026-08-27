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
  // 2026-08-24 — "不要全部只顯示「不符合播報資格」". The two gates a human
  // most often needs to tell apart get their own row label, so which gate
  // stopped an event is readable at a glance instead of only by expanding
  // the row. Same closed vocabulary as everything else here — these are
  // pipelineTrace.js's computeStatus values, never invented locally.
  'outside-service-area': { emoji: '🚫', label: '不在服務區域', cls: 'warn' },
  'insufficient-location': { emoji: '📍', label: '位置不夠精確（不推播）', cls: 'warn' },
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

// V1.8.6.9a correction — the per-row summary column's original fix only
// went as far as a bare HH:MM in Taipei time; the actual acceptance
// requirement (section 1 of the correction round) is a human-readable
// RELATIVE date, same idiom as every chat app: 今天 12:10 / 昨天 23:50 /
// 8/20 20:13 for anything older. Bare HH:MM alone is ambiguous the moment
// the 24h trace window straddles midnight — "12:10" could be today or
// yesterday with no way to tell at a glance, which is a real instance of
// the same underlying problem (a management page silently forcing the
// reader to do date arithmetic in their head) as the original bug.
//
// Reuses the SAME taipeiParts() as formatTaipeiInstant, so this stays a
// single definition of "what time is it in Taipei" for the whole page.
// `now` is threaded in as an explicit parameter (never `new Date()` read
// directly inside this function) specifically so a test can pin it —
// "今天"/"昨天" are meaningless without a fixed reference point, and this
// project's standing rule is no wall-clock-dependent test.
export function formatTaipeiListTime(iso, now = new Date()) {
  const p = taipeiParts(iso);
  if (!p) return '--:--';
  const nowP = taipeiParts(now);
  const hhmm = `${p.hour}:${p.minute}`;
  if (!nowP) return hhmm;
  // Compare Taipei CALENDAR days, not a raw 24h subtraction (which would
  // wrongly call 23:50-yesterday-to-00:10-today "not even a day apart").
  // Date.UTC on the already-Taipei-shifted y/m/d gives a clean day-count
  // difference with no timezone involved in the subtraction itself.
  const eventDayMs = Date.UTC(p.year, Number(p.month) - 1, Number(p.day));
  const nowDayMs = Date.UTC(nowP.year, Number(nowP.month) - 1, Number(nowP.day));
  const diffDays = Math.round((nowDayMs - eventDayMs) / 86400000);
  if (diffDays === 0) return `今天 ${hhmm}`;
  if (diffDays === 1) return `昨天 ${hhmm}`;
  return `${Number(p.month)}/${Number(p.day)} ${hhmm}`;
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

// V1.8.6.9a correction — pipelineTrace.js's own schema (see that file's
// buildTraceEntry doc comment / delivery block) has NO independent "when
// did LINE actually push" field: `delivery.lineAttempted`/
// `lineSucceeded` are COUNTS for this run, never a timestamp, and
// `identity.timestamp` is when THIS TRACE ENTRY was recorded (i.e. when
// this run's pipeline processed the event), not necessarily the same
// instant a LINE push actually completed. Presenting identity.timestamp
// AS the LINE push time would be exactly the kind of fabricated-precision
// this project's "不要猜" rule forbids — so this checks a handful of
// plausible future field names first (a real schema addition is then
// picked up automatically, no second UI change needed) and otherwise
// says so honestly rather than inventing a value. No schema change was
// made this round to add one — see PRODUCT_DECISIONS.md for why.
function linePushTimestamp(delivery) {
  return (delivery && (delivery.linePushedAt || delivery.lineSucceededAt || delivery.notifiedAt)) || null;
}

function renderLineTimelineField(entry) {
  const { delivery, status } = entry;
  if (typeof delivery.lineSucceeded === 'number' && delivery.lineSucceeded > 0) {
    const ts = linePushTimestamp(delivery);
    if (ts) return renderField('LINE 播報', formatTaipeiInstant(ts));
    return renderField('LINE 播報', '已播報（未保存獨立時間）');
  }
  const meta = statusMeta(status);
  return renderField('LINE 播報', `未播報（${meta.emoji} ${meta.label}）`);
}

// 2026-08-24 — turns locationQuality.js's verdict into one line a
// non-programmer can act on: which tier placed the event, or exactly what
// was missing. Reads only what the trace already stored; never re-runs
// the gate (same discipline as every other field on this page).
const LOCATION_TIER_LABELS = {
  'structured-km': '來源提供明確 KM',
  'display-km': '通報文字內的公里標記',
  coordinate: '座標可解析為明確地點',
  'text-km-marker': '地點文字含明確 KM',
  'named-facility': '明確交流道／匝道／路口／隧道',
  'admin-detail': '行政區＋更細地點',
};

function describeLocationQuality(quality) {
  if (!quality) return null;
  if (quality.sufficient) {
    return `足夠（${LOCATION_TIER_LABELS[quality.tier] || quality.tier || '已定位'}）`;
  }
  const evidence = quality.evidence || {};
  if (evidence.overLongRangeKm) return `不足：區段過長（${evidence.overLongRangeKm} 公里），無法指出事故點`;
  if (evidence.location) return `不足：只有路線／區域級描述「${evidence.location}」，無 KM、無可解析座標`;
  return '不足：無 KM、無可解析座標、無明確地點文字';
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
    ${renderField('UpdatedAt（Asia/Taipei）', formatTaipeiInstant(upstream.upstreamUpdatedAt))}
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
    ${renderField('服務區域', decision.serviceAreaEligible === null ? null : decision.serviceAreaEligible ? '在服務區內' : '不在服務區內')}
    ${renderField('位置精確度', describeLocationQuality(decision.locationQuality))}
    ${renderField('dedupe', decision.dedupeResult)}
    ${renderField('suppression', decision.suppressionResult)}
    ${renderField('gating', decision.gatingResult)}
    ${renderField('kmLocationResolution', enrichment.kmLocationResolution ? (enrichment.kmLocationResolution.resolved ? `${enrichment.kmLocationResolution.locationLabel || ''}（${enrichment.kmLocationResolution.dataset}）` : `未解析（${enrichment.kmLocationResolution.reason || '無資料'}）`) : null)}
    ${renderField('cctvEligible', enrichment.cctvEligible === null ? null : enrichment.cctvEligible ? '是' : '否')}
    ${renderField('cctvSkippedByReason', enrichment.cctvSkippedByReason)}
    ${renderField('cctvTargetKm（攝影機對準的公里數）', enrichment.cctvTargetKm)}
    ${renderField('imageStrategy', enrichment.imageStrategy)}
    ${renderField('selectedCamera', enrichment.selectedCamera)}
    ${renderField('cctvBudgetClass', enrichment.cctvBudgetClass)}
    ${renderField('processingDurationMs', enrichment.processingDurationMs)}
    ${renderField('singleSlot', enrichment.singleSlotIndex !== null && enrichment.singleSlotLimit !== null ? `${enrichment.singleSlotIndex} / ${enrichment.singleSlotLimit}` : null)}
    ${renderField('frameFetchDurationMs', enrichment.frameFetchDurationMs)}
    ${renderField('r2PublishDurationMs', enrichment.r2PublishDurationMs)}
    ${renderField('timeoutStage', enrichment.timeoutStage)}
  </div>
  <div class="detail-section">
    <h4>C. 最終結果</h4>
    <div class="formatted-output">${entry.delivery.formattedOutput ? escapeHtml(entry.delivery.formattedOutput) : '<span class="dim">（未產生播報文字）</span>'}</div>
    ${renderField('lineAttempted', delivery.lineAttempted)}
    ${renderField('lineSucceeded', delivery.lineSucceeded)}
    ${renderField('imagePrepared', enrichment.imagePrepared === null ? null : enrichment.imagePrepared ? '是' : '否')}
    ${renderField('imageUrlPresent', enrichment.imageUrlPresent === null ? null : enrichment.imageUrlPresent ? '是' : '否')}
    ${renderField('imageExpiresAt（Asia/Taipei）', formatTaipeiInstant(enrichment.imageExpiresAt))}
    ${renderField('sharedFeedPersisted', delivery.sharedFeedPersisted === null ? null : delivery.sharedFeedPersisted ? '是' : '否')}
    ${renderField('sharedFeedWithImage', delivery.sharedFeedWithImage === null ? null : delivery.sharedFeedWithImage ? '是' : '否')}
  </div>
  <div class="detail-section">
    <h4>D. 事件時間軸（Asia/Taipei）</h4>
    ${renderField('上游更新', formatTaipeiInstant(upstream.upstreamUpdatedAt))}
    ${renderField('系統抓取', formatTaipeiInstant(identity.timestamp))}
    ${renderLineTimelineField(entry)}
  </div>
</div>`;
}

function renderRow(entry, now) {
  const anomalies = buildTraceAnomalies(entry);
  const meta = statusMeta(entry.status);
  const cctv = cctvBadge(entry);
  const map = mapBadge(entry);
  const anomalyCls = anomalySeverityClass(anomalies);
  const timeLabel = formatTaipeiListTime(entry.identity.timestamp, now);

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
  <input type="text" name="q" placeholder="關鍵字（道路／地點／訊息內容）" value="${escapeHtml(filters.q || '')}">
  <input type="text" name="road" placeholder="道路（例：國道一號／台68線）" value="${escapeHtml(filters.road || '')}">
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
  .filter-banner {
    font-size: 13px; color: #3fb950; background: #12261a; border: 1px solid #1f4a2d;
    border-radius: 8px; padding: 8px 12px; margin: -8px 0 16px;
  }
  .filter-banner-none { color: #9aa1ac; background: #171b21; border-color: #2a2f3a; }
  .diagnostics-footer {
    font-size: 12px; color: #6b7280; background: #14171d; border: 1px solid #262b34;
    border-radius: 8px; padding: 6px 12px; margin: 16px 0 0;
  }
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

// V1.8.7.6 — real Production mobile testing reported filtering appearing
// to have no effect (results still included non-matching source/status
// rows after submitting 來源=TDX國道 + 狀態=已播報). Exhaustive
// investigation this round — full HTML-form→query-string→handler→
// listPipelineTrace→predicate→render trace, plus a real headless-Chromium
// reproduction that drives the ACTUAL <select> elements and submit
// button (not a hand-built query string) — found every layer already
// correct: the resulting query string, the filter predicates (AND
// semantics, confirmed correct in V1.8.7.3 and unchanged here), and the
// rendered output all matched exactly what a correct filter should
// produce, at both small and realistic (2000+ key, paginated) scale. See
// PROJECT_HANDOFF.md's own V1.8.7.6 section for the full writeup,
// including why the leading hypothesis is a stale CLIENT-side view (the
// admin's phone showing a response that never actually reflected the
// just-submitted query) rather than a server defect — something this
// module cannot fully rule out or fix on its own (no client JS is
// permitted on this page — see the module's own top comment — so there
// is no way to add an unload-based bfcache opt-out here).
//
// Two concrete, in-scope improvements made instead of guessing at a
// server-side "fix" for a defect no reproduction could find:
//   1. renderActiveFiltersBanner below — prints EXACTLY which filter
//      values the server actually received and applied for THIS
//      response, in the response body itself. The next time this is
//      reported, comparing "what I selected" against this banner's own
//      text immediately tells whether the server ever saw the intended
//      query at all — turning "the filter doesn't work" into either
//      "the banner shows the wrong values" (a genuine, now-diagnosable
//      server/query bug) or "the banner shows the right values but rows
//      don't match" (an actual predicate bug, also now diagnosable) or
//      "the banner matches what was picked and the rows are correct"
//      (client-side staleness — reload/clear-cache, not a code fix).
//   2. Strengthened cache-prevention headers (see handlePipelineTraceView's
//      Cache-Control override below) — belt-and-suspenders on top of the
//      existing applyAdminSecurityHeaders no-store, since this round's
//      leading hypothesis is exactly the kind of stale-response symptom
//      overly-aggressive HTTP/bfcache caching produces.
function renderActiveFiltersBanner(filters) {
  const parts = [];
  if (filters.source) parts.push(`來源=${sourceLabel(filters.source)}（${escapeHtml(filters.source)}）`);
  if (filters.q) parts.push(`關鍵字=${escapeHtml(filters.q)}`);
  if (filters.road) parts.push(`道路=${escapeHtml(filters.road)}`);
  if (filters.rawId) parts.push(`rawId=${escapeHtml(filters.rawId)}`);
  if (filters.status) parts.push(`狀態=${escapeHtml(statusMeta(filters.status).label)}（${escapeHtml(filters.status)}）`);
  if (filters.limit) parts.push(`筆數=${escapeHtml(filters.limit)}`);
  if (parts.length === 0) return '<p class="filter-banner filter-banner-none">目前未套用任何篩選（顯示全部）</p>';
  return `<p class="filter-banner">✅ 目前套用篩選：${parts.join('　')}</p>`;
}

// V1.9.4 (order section 八) — small, plain-numbers-only diagnostic strip
// so a human can see WHY a page took however long it took without having
// to reverse-engineer it via external measurement (exactly the gap this
// round's own root-cause investigation had to fill by hand). Deliberately
// only counts/ms already computed by listPipelineTrace — no secrets,
// tokens, raw CCTV URLs, or any payload field.
function renderDiagnosticsFooter({ scannedKeyCount, kvGetCalls, kvListCalls, totalKeyCount, scanTruncated, readDurationMs }) {
  const parts = [
    `掃描鍵數 scannedKeyCount=${escapeHtml(String(scannedKeyCount ?? '?'))}`,
    `KV get 次數=${escapeHtml(String(kvGetCalls ?? '?'))}`,
    `KV list 次數=${escapeHtml(String(kvListCalls ?? '?'))}`,
    `總鍵數 totalKeyCount=${escapeHtml(String(totalKeyCount ?? '?'))}`,
    `耗時=${escapeHtml(String(readDurationMs ?? '?'))}ms`,
    `是否截斷 scanTruncated=${scanTruncated ? '是' : '否'}`,
  ];
  return `<p class="diagnostics-footer">🔧 ${parts.join('　')}</p>`;
}

function renderPage({ rows, filters, count, kvAvailable, scanTruncated, diagnostics }) {
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
${renderActiveFiltersBanner(filters)}
${
    scanTruncated && count === 0
      ? '<p class="filter-banner">ℹ️ 只掃描了最新的一批紀錄，較舊的事件可能還在但沒被掃到——「查不到」不等於「沒有發生」。請縮小關鍵字，或加上道路／狀態條件再查一次。</p>'
      : ''
  }
${!kvAvailable ? '<div class="empty">⚠️ 無法讀取 KV，暫無資料</div>' : count === 0 ? '<div class="empty">這個篩選條件下沒有資料</div>' : rows}
${kvAvailable && diagnostics ? renderDiagnosticsFooter(diagnostics) : ''}
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
 *
 * `now` is an explicit, optional third parameter (defaulting to the real
 * clock) purely so a test can pin "今天"/"昨天" without being
 * wall-clock-dependent — index.js's route table never passes it, so
 * normal traffic always gets the real current time.
 */
export async function handlePipelineTraceView(env, request, now = new Date()) {
  const url = new URL(request.url);
  const filters = {
    source: url.searchParams.get('source') || '',
    q: url.searchParams.get('q') || '',
    road: url.searchParams.get('road') || '',
    rawId: url.searchParams.get('rawId') || '',
    status: url.searchParams.get('status') || '',
    limit: url.searchParams.get('limit') || '',
  };

  const { records, kvAvailable, scanTruncated, scannedKeyCount, kvGetCalls, kvListCalls, totalKeyCount, readDurationMs } =
    await listPipelineTrace(env.TRAFFIC_KV, {
      limit: filters.limit || undefined,
      source: filters.source || undefined,
      q: filters.q || undefined,
      road: filters.road || undefined,
      rawId: filters.rawId || undefined,
      status: filters.status || undefined,
    });

  const rows = records.map((entry) => renderRow(entry, now)).join('\n');
  const html = renderPage({
    rows,
    filters,
    count: records.length,
    kvAvailable,
    scanTruncated,
    // V1.9.4 (order section 八) — page-bottom diagnostics, see
    // renderDiagnosticsFooter's own comment.
    diagnostics: { scannedKeyCount, kvGetCalls, kvListCalls, totalKeyCount, scanTruncated, readDurationMs },
  });

  // V1.8.7.6 — belt-and-suspenders on top of applyAdminSecurityHeaders'
  // own Cache-Control:no-store (index.js wraps every ADMIN_PATHS response
  // in that already) — set directly on THIS response too so it holds
  // even if this handler is ever exercised outside that wrapper (e.g. a
  // future direct call/test), and add Expires:0 as a second, older-cache
  // signal some intermediaries/older mobile browser cache implementations
  // still honor independently of Cache-Control. See this file's own
  // renderActiveFiltersBanner comment for why this round added this: a
  // stale CLIENT-visible response is the leading hypothesis for the
  // reported "filter has no effect" symptom, after exhaustive
  // investigation found every server-side layer already correct.
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Expires: '0',
    },
  });
}
