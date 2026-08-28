// V2.0.1 — GET /admin/pbs-ai-observatory-view. AI Decision Observatory:
// answers, for a Windows PBS event, "what did PBS actually say → what
// did the AI decide → why → what finally happened" from data already
// produced at decision time — never by calling Workers AI again.
//
// READ-ONLY OBSERVABILITY (order section 一, the round's own highest
// priority rule): opening this page, refreshing it, or searching/
// filtering it makes ZERO calls to Workers AI and ZERO writes to any KV
// key. This module only ever READS: aiObservatoryIndex.js's own thin
// index (PBS original fields + final outcome, written once by
// pbs/debugPush.js when an event's processing completes) joined, at
// render time, against the EXISTING pbs/aiDecisionCache.js record for
// notify/impact/reason/confidence — never a second copy of that payload,
// never regenerated, never guessed. See aiObservatoryIndex.js's own
// header comment for the full "why a new index, not zero new writes"
// reasoning.
//
// Server-rendered HTML, zero client-side JavaScript — same Admin CSP
// discipline as pipelineTraceView.js (default-src 'none', no script-src
// exception). Expand/collapse via native <details>/<summary>; filters via
// a plain GET <form>.

import { listAiObservatoryEntries, AI_OUTCOME, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './aiObservatoryIndex.js';
import { computeAiDecisionCacheKeyHash, buildAiDecisionCacheKvKey } from './aiCandidate.js';
import { readAiDecisionCache } from './aiDecisionCache.js';
import { PBS_AI_MODEL_ID } from './aiDecisionEngine.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// V2.0.1 (order section 五) — the exact human-readable vocabulary the
// order itself specifies, never the legacy TDX-oriented "不符合播報資格"
// wording (see pipelineTraceView.js's STATUS_META — that page's
// vocabulary answers a DIFFERENT question, "did this pass the OLD hard-
// rule gates", which is no longer the semantic authority for a Windows
// PBS AI-path event — see PRODUCT_DECISIONS.md's V2.0.0 section).
const OUTCOME_META = {
  [AI_OUTCOME.AI_NOTIFY_TRUE]: { emoji: '📣', label: 'AI：建議通報', cls: 'ok' },
  [AI_OUTCOME.AI_NOTIFY_FALSE]: { emoji: '🤫', label: 'AI：不需主動通報', cls: 'info' },
  [AI_OUTCOME.AI_CALL_FAILED]: { emoji: '⚠️', label: 'AI：判讀失敗，安全不通報', cls: 'warn' },
  [AI_OUTCOME.AI_DECISION_INVALID]: { emoji: '⚠️', label: 'AI：判讀失敗，安全不通報', cls: 'warn' },
  [AI_OUTCOME.SERVICE_AREA_EXCLUDED]: { emoji: '🚫', label: '服務區域外', cls: 'warn' },
  [AI_OUTCOME.AI_NOT_INVOKED_LEGACY_PATH]: { emoji: '⏸️', label: 'AI 未判讀（走既有規則路徑）', cls: 'unknown' },
};
function outcomeMeta(outcome) {
  return OUTCOME_META[outcome] || { emoji: 'ℹ️', label: outcome || '未知', cls: 'unknown' };
}

// order section 九's own status filter vocabulary. 'AI_FAILED' is a
// combined filter over both AI_CALL_FAILED and AI_DECISION_INVALID (the
// order's own "AI判讀失敗" is one bucket, not two) — matched in
// matchesStatusFilter() below, never a third outcome value invented in
// storage.
const STATUS_FILTER_OPTIONS = [
  ['AI_NOTIFY_TRUE', 'AI 建議通報'],
  ['AI_NOTIFY_FALSE', 'AI 不需通報'],
  ['AI_FAILED', 'AI 判讀失敗'],
  ['AI_NOT_INVOKED_LEGACY_PATH', '尚未判讀'],
  ['DUPLICATE', '重複事件'],
];
function matchesStatusFilter(record, statusFilter) {
  if (!statusFilter) return true;
  if (statusFilter === 'AI_FAILED') return record.outcome === AI_OUTCOME.AI_CALL_FAILED || record.outcome === AI_OUTCOME.AI_DECISION_INVALID;
  if (statusFilter === 'DUPLICATE') return false; // see renderDuplicateNote() — never persisted, see this module's own header comment
  return record.outcome === statusFilter;
}

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
function formatTaipeiListTime(iso, now = new Date()) {
  const p = taipeiParts(iso);
  if (!p) return '--:--';
  const nowP = taipeiParts(now);
  const hhmm = `${p.hour}:${p.minute}`;
  if (!nowP) return hhmm;
  const eventDayMs = Date.UTC(p.year, Number(p.month) - 1, Number(p.day));
  const nowDayMs = Date.UTC(nowP.year, Number(nowP.month) - 1, Number(nowP.day));
  const diffDays = Math.round((nowDayMs - eventDayMs) / 86400000);
  if (diffDays === 0) return `今天 ${hhmm}`;
  if (diffDays === 1) return `昨天 ${hhmm}`;
  return `${Number(p.month)}/${Number(p.day)} ${hhmm}`;
}

function renderField(label, value) {
  return `<div class="row"><div class="label">${escapeHtml(label)}</div><div class="value">${value === null || value === undefined || value === '' ? '<span class="dim">—</span>' : escapeHtml(value)}</div></div>`;
}

// order section 七-D — reads the EXISTING AI decision cache record for
// this event; never regenerates, never re-runs the model, never guesses.
// A cache miss (record expired, or this outcome never reached a valid AI
// decision) renders every field as UNKNOWN / NOT RECORDED, per order
// section 七-E's own explicit instruction — never a fabricated value.
async function loadAiDecisionDetail(kv, record) {
  if (!record.eventId || !record.fingerprint) return null;
  if (record.outcome !== AI_OUTCOME.AI_NOTIFY_TRUE && record.outcome !== AI_OUTCOME.AI_NOTIFY_FALSE) return null;
  try {
    const keyHash = await computeAiDecisionCacheKeyHash({ eventId: record.eventId, fingerprint: record.fingerprint });
    const kvKey = buildAiDecisionCacheKvKey(keyHash);
    const cached = await readAiDecisionCache(kv, kvKey);
    if (!cached.hit) return null;
    return cached.decision; // {notify, impact, reason, confidence} — the EXACT record persisted at decision time
  } catch {
    return null; // never let a lookup failure break the page — falls through to UNKNOWN
  }
}

function renderComparisonBlock(record, decision) {
  // order section 八 — the single most important screen: PBS 原文 → AI
  // 判斷 → AI 理由 → 最終結果, stacked vertically, front and center.
  const pbsText = [record.road, record.direction, record.areaNm, record.commentSummary].filter(Boolean).join(' ') || '（無可顯示的 PBS 內容）';
  const aiVerdict = decision ? (decision.notify ? 'AI：建議通報' : 'AI：不需主動通報') : record.outcome === AI_OUTCOME.SERVICE_AREA_EXCLUDED ? '（未進入 AI 判讀：服務區域外）' : record.outcome === AI_OUTCOME.AI_NOT_INVOKED_LEGACY_PATH ? '（未進入 AI 判讀：走既有規則路徑）' : record.outcome === AI_OUTCOME.AI_CALL_FAILED || record.outcome === AI_OUTCOME.AI_DECISION_INVALID ? 'AI：判讀失敗，安全不通報' : 'UNKNOWN';
  const finalResult = record.lineSent ? 'LINE 已送出' : record.lineAttempted ? 'LINE 已嘗試（未成功）' : 'LINE 未嘗試';

  return `
<div class="comparison">
  <div class="comparison-step">
    <div class="comparison-label">PBS 原文</div>
    <div class="comparison-value">${escapeHtml(pbsText)}</div>
  </div>
  <div class="comparison-arrow">↓</div>
  <div class="comparison-step">
    <div class="comparison-label">AI 判斷</div>
    <div class="comparison-value">${escapeHtml(aiVerdict)}${decision ? ` <span class="dim">（impact ${escapeHtml(decision.impact)}，confidence ${escapeHtml(decision.confidence)}）</span>` : ''}</div>
  </div>
  <div class="comparison-arrow">↓</div>
  <div class="comparison-step">
    <div class="comparison-label">AI 理由</div>
    <div class="comparison-value">${decision ? escapeHtml(decision.reason) : '<span class="dim">UNKNOWN / NOT RECORDED</span>'}</div>
  </div>
  <div class="comparison-arrow">↓</div>
  <div class="comparison-step">
    <div class="comparison-label">最終結果</div>
    <div class="comparison-value">${escapeHtml(finalResult)}</div>
  </div>
</div>`;
}

function renderDetail(record, decision) {
  const cacheLabel = record.cacheStatus === 'HIT' ? 'HIT（沿用先前已驗證的判讀，本次 0 次 AI 呼叫）' : record.cacheStatus === 'MISS' ? 'MISS（本次呼叫了 Workers AI）' : null;
  return `
<div class="detail">
  ${renderComparisonBlock(record, decision)}
  <div class="detail-section">
    <h4>A. PBS 原始資料</h4>
    ${renderField('eventId', record.eventId)}
    ${renderField('lifecycle', record.lifecycle)}
    ${renderField('道路', record.road)}
    ${renderField('方向', record.direction)}
    ${renderField('areaNm', record.areaNm)}
    ${renderField('displayKM', record.displayKM)}
    ${renderField('事件類型', record.eventType)}
    ${renderField('comment / sourceDetail', record.commentSummary)}
    ${renderField('事件時間（Windows generatedAt，Asia/Taipei）', formatTaipeiInstant(record.generatedAt))}
  </div>
  <div class="detail-section">
    <h4>B. 服務區域</h4>
    ${renderField('新竹縣市', record.outcome === AI_OUTCOME.SERVICE_AREA_EXCLUDED ? '不在服務區域內' : 'PASS')}
  </div>
  <div class="detail-section">
    <h4>C. 重複防護</h4>
    ${renderField('TRANSPORT DUPLICATE', 'PASS（本紀錄只在首次接受、非重複時才建立——見本頁下方「重複事件」說明）')}
  </div>
  <div class="detail-section">
    <h4>D. AI 判讀</h4>
    ${renderField('Model', PBS_AI_MODEL_ID)}
    ${renderField('Cache', cacheLabel)}
    ${renderField('notify', decision ? (decision.notify ? 'TRUE' : 'FALSE') : record.outcome === AI_OUTCOME.AI_CALL_FAILED || record.outcome === AI_OUTCOME.AI_DECISION_INVALID ? 'N/A（判讀失敗）' : 'N/A')}
    ${renderField('impact', decision ? decision.impact : null)}
    ${renderField('confidence', decision ? decision.confidence : null)}
    ${renderField('reason', decision ? decision.reason : record.outcome === AI_OUTCOME.AI_CALL_FAILED || record.outcome === AI_OUTCOME.AI_DECISION_INVALID ? 'UNKNOWN / NOT RECORDED（判讀失敗，無有效 decision）' : null)}
  </div>
  <div class="detail-section">
    <h4>E. 最終執行結果</h4>
    ${renderField('LINE attempted', record.lineAttempted ? 'YES' : 'NO')}
    ${renderField('LINE sent', record.lineSent ? 'YES' : 'NO')}
    ${renderField('Shared Feed', record.sharedFeedPersisted === null || record.sharedFeedPersisted === undefined ? 'UNKNOWN / NOT RECORDED' : record.sharedFeedPersisted ? 'YES' : 'NO')}
    ${renderField('CCTV', record.imageUrlPresent === null || record.imageUrlPresent === undefined ? 'UNKNOWN / NOT RECORDED' : record.imageUrlPresent ? 'YES' : 'NO')}
  </div>
</div>`;
}

function renderRow(record, decision, now) {
  const meta = outcomeMeta(record.outcome);
  const timeLabel = formatTaipeiListTime(record.timestamp, now);
  const impactBadge = decision ? `<span class="badge badge-impact">${escapeHtml(decision.impact)}</span>` : '';
  return `
<details class="obs-row">
  <summary>
    <span class="col-time">${escapeHtml(timeLabel)}</span>
    <span class="col-source">PBS</span>
    <span class="col-road">${escapeHtml(record.road || '')} ${escapeHtml(record.direction || '')}</span>
    <span class="col-type">${escapeHtml(record.eventType || '')}</span>
    <span class="pill pill-${meta.cls}">${meta.emoji} ${escapeHtml(meta.label)}</span>
    ${impactBadge}
    ${record.lineSent ? '<span class="badge badge-line">✅ LINE 已送出</span>' : ''}
  </summary>
  ${renderDetail(record, decision)}
</details>`;
}

function renderSelect({ name, value, options, placeholder }) {
  const optionsHtml = options.map(([optValue, label]) => `<option value="${escapeHtml(optValue)}" ${value === optValue ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
  return `<select name="${name}" aria-label="${escapeHtml(placeholder)}">
    <option value="" ${value ? '' : 'selected'}>${escapeHtml(placeholder)}</option>
    ${optionsHtml}
  </select>`;
}

function renderFilterForm(filters) {
  const statusSelect = renderSelect({ name: 'status', value: filters.status || '', placeholder: '狀態（全部）', options: STATUS_FILTER_OPTIONS });
  return `
<form class="filters" method="get">
  <input type="text" name="q" placeholder="關鍵字（道路／地點／內容／eventId）" value="${escapeHtml(filters.q || '')}">
  <input type="text" name="road" placeholder="道路（例：台61線）" value="${escapeHtml(filters.road || '')}">
  <input type="text" name="eventId" placeholder="eventId" value="${escapeHtml(filters.eventId || '')}">
  ${statusSelect}
  <input type="number" name="limit" min="1" max="${MAX_LIST_LIMIT}" placeholder="筆數（預設 ${DEFAULT_LIST_LIMIT}）" value="${escapeHtml(filters.limit || '')}">
  <button type="submit">篩選</button>
  <a class="clear" href="/admin/pbs-ai-observatory-view">清除</a>
</form>`;
}

function renderDuplicateNote(statusFilter) {
  if (statusFilter !== 'DUPLICATE') return '';
  return `<p class="filter-banner filter-banner-none">ℹ️ 重複到達的 Windows PBS 事件在進入 AI 判讀之前就已被 transport idempotency 攔截（見 03_ARCHITECTURE.md「Cloudflare 端持久冪等」），刻意不為每次重複到達另外寫入 KV（避免額外成本）。原始事件本身的紀錄已經反映最終判讀結果；如需查看重複到達次數，請查 Cloudflare Workers Logs 的 <code>duplicate=true</code> 記錄。</p>`;
}

// Same dark-theme palette as pipelineTraceView.js's own PAGE_STYLE
// (visual consistency across this project's admin pages), plus a
// comparison-block style specific to this page's own section 八
// requirement. Zero client-side JavaScript — same CSP as every other
// admin page (security/adminAuth.js's applyAdminSecurityHeaders).
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
  .filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; background: #1b1f26; padding: 12px; border-radius: 12px; border: 1px solid #262b34; }
  .filters input, .filters select {
    flex: 1 1 120px; min-width: 90px; padding: 8px 10px; border: 1px solid #333a46; border-radius: 8px;
    font-size: 14px; background: #20242c; color: #e8e9ec;
  }
  .filters input::placeholder { color: #6b7280; opacity: 1; }
  .filters select { color-scheme: dark; }
  .filters button { padding: 8px 16px; border: none; border-radius: 8px; background: #2f6fdb; color: #fff; font-size: 14px; font-weight: 600; }
  .filters .clear { align-self: center; font-size: 13px; color: #9aa1ac; text-decoration: none; padding: 0 6px; }
  .obs-row { background: #1b1f26; border: 1px solid #262b34; border-radius: 10px; margin-bottom: 8px; overflow: hidden; }
  .obs-row summary {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    padding: 10px 12px; cursor: pointer; font-size: 14px; list-style: none;
  }
  .obs-row summary::-webkit-details-marker { display: none; }
  .obs-row summary::before { content: '▸'; color: #6b7280; margin-right: 2px; }
  .obs-row[open] summary::before { content: '▾'; }
  .obs-row[open] { background: #20242c; }
  .col-time { font-variant-numeric: tabular-nums; color: #9aa1ac; font-size: 13px; min-width: 42px; }
  .col-source { font-size: 12px; background: #262b34; color: #c3c9d1; border-radius: 6px; padding: 1px 6px; }
  .col-road { font-weight: 600; color: #f2f3f5; }
  .col-type { color: #9aa1ac; font-size: 13px; }
  .pill { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 13px; font-weight: 600; }
  .pill-ok { background: #12261a; color: #3fb950; }
  .pill-info { background: #0f2038; color: #58a6ff; }
  .pill-warn { background: #2b2111; color: #e3b341; }
  .pill-unknown { background: #262b34; color: #9aa1ac; }
  .badge { font-size: 12px; background: #262b34; color: #c3c9d1; border-radius: 6px; padding: 2px 6px; }
  .badge-impact { background: #2b2111; color: #e3b341; }
  .badge-line { background: #12261a; color: #3fb950; }
  .comparison { display: flex; flex-direction: column; align-items: stretch; gap: 4px; padding: 8px 0 14px; }
  .comparison-step { background: #12151a; border: 1px solid #262b34; border-radius: 8px; padding: 8px 10px; }
  .comparison-label { font-size: 12px; color: #9aa1ac; margin-bottom: 2px; }
  .comparison-value { font-size: 14px; color: #e8e9ec; }
  .comparison-arrow { text-align: center; color: #6b7280; font-size: 13px; }
  .detail { display: flex; flex-direction: column; gap: 10px; padding: 4px 12px 14px; border-top: 1px solid #262b34; }
  .detail-section h4 { font-size: 13px; margin: 8px 0 4px; color: #c3c9d1; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; border-bottom: 1px solid #21252c; font-size: 13px; }
  .row .label { color: #9aa1ac; }
  .row .value { font-weight: 500; text-align: right; word-break: break-word; color: #e8e9ec; }
  .dim { color: #6b7280; }
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
<title>路況播報員 AI 判讀查修頁</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>🤖 AI Decision Observatory</h1>
<p class="subtitle">Windows PBS 事件的 AI 判讀查修頁——唯讀，開啟／重新整理／搜尋本頁絕不會呼叫 Workers AI。最新在上，點一列展開查看 PBS 原文／AI 判斷／AI 理由／最終結果。</p>
<p class="tz-banner">🕒 以下時間皆為 <strong>Asia/Taipei（台灣時間，UTC+8）</strong>，不是 UTC。</p>
${renderFilterForm(filters)}
${renderDuplicateNote(filters.status)}
${!kvAvailable ? '<div class="empty">⚠️ 無法讀取 KV，暫無資料</div>' : count === 0 ? '<div class="empty">這個篩選條件下沒有資料</div>' : rows}
<div class="footer">
  <a href="/admin/pipeline-trace-view">Pipeline Trace 查修頁（TDX／legacy PBS）</a>
  <a href="/debug/pbs">PBS Relay 除錯頁</a>
  <a href="/health">系統健康頁</a>
</div>
</body>
</html>`;
}

/**
 * GET /admin/pbs-ai-observatory-view (Admin-Basic-Auth-gated at the route
 * level — see index.js). ZERO calls to Workers AI, ZERO KV writes — pure
 * KV reads via listAiObservatoryEntries + a per-row readAiDecisionCache
 * lookup. `now` is an explicit optional parameter purely so a test can
 * pin "今天"/"昨天", same convention as pipelineTraceView.js.
 */
export async function handleAiObservatoryView(env, request, now = new Date()) {
  const url = new URL(request.url);
  const filters = {
    q: url.searchParams.get('q') || '',
    road: url.searchParams.get('road') || '',
    eventId: url.searchParams.get('eventId') || '',
    status: url.searchParams.get('status') || '',
    limit: url.searchParams.get('limit') || '',
  };

  const { records, kvAvailable } = await listAiObservatoryEntries(env.TRAFFIC_KV, {
    limit: filters.limit || undefined,
    road: filters.road || undefined,
    eventId: filters.eventId || undefined,
    q: filters.q || undefined,
  });

  const filtered = records.filter((record) => matchesStatusFilter(record, filters.status));

  const rowsHtml = [];
  for (const record of filtered) {
    const decision = await loadAiDecisionDetail(env.TRAFFIC_KV, record);
    rowsHtml.push(renderRow(record, decision, now));
  }

  const html = renderPage({ rows: rowsHtml.join('\n'), filters, count: filtered.length, kvAvailable });

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Expires: '0',
    },
  });
}
