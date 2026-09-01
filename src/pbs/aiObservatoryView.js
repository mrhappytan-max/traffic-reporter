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
// V2.2.0 (order section 二②) — reused, never re-implemented: the SAME
// key-derivation debugPush.js's own transport idempotency layer uses, so
// this page's "Cloudflare 已收件 / PROCESSING / COMPLETED" status is read
// from the REAL record that layer itself writes, never guessed or
// re-derived from the Observatory index's own data.
import { computeIdempotencyKeyHash, buildIdempotencyKvKey, IDEMPOTENCY_STATUS } from './debugPush.js';

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
  // V2.2.0 (order section 九) — the record is still frozen at this outcome
  // because the final write never happened (still genuinely in flight, or
  // the background attempt was lost) — never silently absent from the
  // page.
  [AI_OUTCOME.PROCESSING_STARTED]: { emoji: '⚪', label: 'AI：未執行（處理中或未完成）', cls: 'unknown' },
  // V2.3.0 (order section 十) — the Queue Consumer gave up after
  // MAX_QUEUE_RETRIES genuinely-retried attempts; distinct from
  // AI_CALL_FAILED (a single attempt's call didn't complete) — this means
  // retries were exhausted and processing is now definitively terminal.
  [AI_OUTCOME.PROCESSING_FAILED]: { emoji: '❌', label: 'AI／背景處理最終失敗（已重試仍未完成）', cls: 'warn' },
  // V2.4.3 (order section 七/八/十) — cancelled before any further AI call
  // because PBS itself has since confirmed the event is over (a later,
  // separate CLEARED push) — distinct from every failure outcome above:
  // this was never a failure, it is a stale retry correctly stood down.
  [AI_OUTCOME.STALE_AFTER_CLEARED]: { emoji: '⏹️', label: '事件已解除，取消舊 AI 重試', cls: 'info' },
};
// V2.4.3 (order section 十) — timeout variants of the two outcomes that
// can carry `record.timedOut`. Kept as SEPARATE lookup entries rather
// than mutating OUTCOME_META in place, so the base table above stays the
// exact same shape/keys it always has (every other reader of OUTCOME_META,
// if one is ever added, still sees the plain outcome->meta mapping).
const TIMEOUT_OUTCOME_META = {
  [AI_OUTCOME.AI_CALL_FAILED]: { emoji: '⏱️', label: 'AI：逾時，安全不通報（會重試）', cls: 'warn' },
  [AI_OUTCOME.PROCESSING_FAILED]: { emoji: '⏱️', label: 'AI／背景處理最終失敗（連續逾時，已重試仍未完成）', cls: 'warn' },
};
function outcomeMeta(record) {
  const outcome = record && record.outcome;
  if (record && record.timedOut && TIMEOUT_OUTCOME_META[outcome]) return TIMEOUT_OUTCOME_META[outcome];
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
  [AI_OUTCOME.PROCESSING_STARTED, '處理中／未完成'],
  [AI_OUTCOME.PROCESSING_FAILED, '背景處理最終失敗'],
  // V2.4.3 (order section 七/八) — its own filter entry, never folded into
  // AI_FAILED: a stale-cancelled retry was never a failure at all.
  [AI_OUTCOME.STALE_AFTER_CLEARED, '事件已解除（取消重試）'],
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

// V2.2.0 (order section 二②) — reads the EXISTING transport idempotency
// record (src/pbs/debugPush.js's own IDEMPOTENCY_KV_PREFIX) live, at
// render time — never a second, duplicated copy of PROCESSING/COMPLETED
// status stored inside the Observatory index itself. A miss (record
// expired past its own 48h TTL, or genuinely never written) renders as
// UNKNOWN / NOT RECORDED, never guessed.
async function loadTransportIdempotencyDetail(kv, record) {
  if (!record.eventId || !record.lifecycle || !record.fingerprint) return null;
  try {
    const keyHash = await computeIdempotencyKeyHash({
      source: record.source || 'pbs',
      eventId: record.eventId,
      lifecycle: record.lifecycle,
      fingerprint: record.fingerprint,
    });
    const kvKey = buildIdempotencyKvKey(keyHash);
    const raw = await kv.get(kvKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed; // {firstAcceptedAt, requestId, status, attemptCount, completedAt?} — see debugPush.js's serializeIdempotencyRecord
  } catch {
    return null; // never let a corrupt/unreadable record break the page
  }
}

// V2.2.0 (order section 三) — derives what stage of the AI layer this
// event reached PURELY from the already-stored, closed outcome
// vocabulary — never a new stored boolean, per REUSE_EXISTING_DATA_FIRST
// (order section 四). `candidateCreated`/`aiCallStarted` are tri-state
// (true/false/null=UNKNOWN) — null only for a record still frozen at
// PROCESSING_STARTED, where this page genuinely cannot know how far
// processing got before it stalled.
function deriveAiStageFlags(outcome) {
  if (outcome === AI_OUTCOME.PROCESSING_STARTED) return { candidateCreated: null, aiCallStarted: null };
  if (outcome === AI_OUTCOME.SERVICE_AREA_EXCLUDED) return { candidateCreated: false, aiCallStarted: false };
  if (outcome === AI_OUTCOME.AI_NOT_INVOKED_LEGACY_PATH) return { candidateCreated: true, aiCallStarted: false };
  // V2.4.3 — cancelled BEFORE any candidate/AI work this attempt (see
  // processQueuedPbsEvent's own comment: the stale-cleared check runs
  // ahead of candidate building) — a PRIOR attempt may have reached AI,
  // but that is not what this record now represents.
  if (outcome === AI_OUTCOME.STALE_AFTER_CLEARED) return { candidateCreated: false, aiCallStarted: false };
  // PROCESSING_FAILED: retries were genuinely attempted, so a candidate
  // and at least one AI call attempt did happen — just never reliably
  // completed.
  return { candidateCreated: true, aiCallStarted: true }; // AI_CALL_FAILED / AI_DECISION_INVALID / AI_NOTIFY_TRUE / AI_NOTIFY_FALSE / PROCESSING_FAILED
}

function triStateLabel(value, trueLabel, falseLabel) {
  if (value === null || value === undefined) return 'UNKNOWN / NOT RECORDED';
  return value ? trueLabel : falseLabel;
}

// order section 十四's own required human-readable LINE-layer reason text
// for every case LINE was never attempted — derived, never guessed beyond
// what the outcome vocabulary already tells us.
function lineNotAttemptedReason(record) {
  switch (record.outcome) {
    case AI_OUTCOME.PROCESSING_STARTED:
      return 'AI 尚未完成';
    case AI_OUTCOME.SERVICE_AREA_EXCLUDED:
      return '服務區域外，未進入 AI 判讀';
    case AI_OUTCOME.AI_CALL_FAILED:
    case AI_OUTCOME.AI_DECISION_INVALID:
      return 'AI 判讀失敗，安全不通報';
    case AI_OUTCOME.AI_NOTIFY_FALSE:
      return 'AI notify=false';
    case AI_OUTCOME.AI_NOT_INVOKED_LEGACY_PATH:
      return '既有規則判定不符合播報資格';
    case AI_OUTCOME.PROCESSING_FAILED:
      return '背景處理已重試仍未能可靠完成，安全不通報';
    case AI_OUTCOME.STALE_AFTER_CLEARED:
      return '事件已解除，已取消後續 AI 重試';
    default:
      return 'UNKNOWN / NOT RECORDED';
  }
}

// V2.2.0 (order section 三) — the four-layer "which layer is this event
// stuck at" strip: one glance, before any of the detail sections below.
// Four states only (order's own vocabulary): 成功/未執行/失敗/未知.
const LAYER_STATUS_ICON = { ok: '✅', none: '⏭️', fail: '❌', unknown: '⚪', pending: '⏳' };

function layerStatusForPbsWindows(record) {
  return record.eventId ? 'ok' : 'unknown';
}
function layerStatusForCloudflare(idem) {
  if (!idem) return 'unknown';
  if (idem.status === IDEMPOTENCY_STATUS.COMPLETED) return 'ok';
  if (idem.status === IDEMPOTENCY_STATUS.PROCESSING) return 'pending';
  return 'unknown';
}
function layerStatusForAi(record) {
  switch (record.outcome) {
    case AI_OUTCOME.PROCESSING_STARTED:
      return 'pending';
    case AI_OUTCOME.SERVICE_AREA_EXCLUDED:
    case AI_OUTCOME.AI_NOT_INVOKED_LEGACY_PATH:
    case AI_OUTCOME.STALE_AFTER_CLEARED:
      return 'none';
    case AI_OUTCOME.AI_CALL_FAILED:
    case AI_OUTCOME.AI_DECISION_INVALID:
    case AI_OUTCOME.PROCESSING_FAILED:
      return 'fail';
    case AI_OUTCOME.AI_NOTIFY_TRUE:
    case AI_OUTCOME.AI_NOTIFY_FALSE:
      return 'ok';
    default:
      return 'unknown';
  }
}
function layerStatusForLine(record) {
  if (record.lineSent) return 'ok';
  if (record.lineAttempted) return 'fail';
  if (record.outcome === AI_OUTCOME.PROCESSING_STARTED) return 'pending';
  return 'none'; // includes PROCESSING_FAILED — LINE was never reached
}

function renderFlowStrip(record, idem) {
  const layers = [
    ['① PBS/Windows', layerStatusForPbsWindows(record)],
    ['② Cloudflare', layerStatusForCloudflare(idem)],
    ['③ AI', layerStatusForAi(record)],
    ['④ LINE', layerStatusForLine(record)],
  ];
  return `<div class="flow-strip">${layers
    .map(([label, status]) => `<div class="flow-chip flow-${status}"><span class="flow-icon">${LAYER_STATUS_ICON[status]}</span><span class="flow-label">${escapeHtml(label)}</span></div>`)
    .join('<span class="flow-sep">→</span>')}</div>`;
}

function renderRawTextBlock(label, text) {
  if (!text) return '';
  return `<div class="raw-text-block"><div class="raw-text-label">${escapeHtml(label)}</div><div class="raw-text-value">${escapeHtml(text)}</div></div>`;
}

// order section 二④ — the human-readable reason text a NOT-attempted LINE
// layer must show, per outcome; see lineNotAttemptedReason() above.
function renderDetail(record, decision, idem) {
  const cacheLabel = record.cacheStatus === 'HIT' ? 'HIT（沿用先前已驗證的判讀，本次 0 次 AI 呼叫）' : record.cacheStatus === 'MISS' ? 'MISS（本次呼叫了 Workers AI）' : null;
  const stage = deriveAiStageFlags(record.outcome);
  const cloudflareStatusLabel = !idem
    ? 'UNKNOWN / NOT RECORDED（冪等記錄已過期或未寫入）'
    : idem.status === IDEMPOTENCY_STATUS.COMPLETED
      ? '✅ Cloudflare 已收件，已交由背景流程處理完成'
      : idem.status === IDEMPOTENCY_STATUS.PROCESSING
        ? '⏳ Cloudflare 已收件，已交由背景流程處理（尚未完成）'
        : '⚠️ 收件後處理未完成（狀態未知）';

  return `
<div class="detail">
  ${renderFlowStrip(record, idem)}
  <div class="detail-section">
    <h4>① PBS / Windows</h4>
    ${renderField('EVENT_ID', record.eventId)}
    ${renderField('lifecycle', record.lifecycle)}
    ${renderField('道路 road（解析結果）', record.road)}
    ${renderField('方向 direction（解析結果）', record.direction)}
    ${renderField('areaNm（解析結果）', record.areaNm)}
    ${renderField('displayKM（解析結果）', record.displayKM)}
    ${renderField('事件類型（解析結果）', record.eventType)}
    ${renderField('longitude', record.longitude)}
    ${renderField('latitude', record.latitude)}
    ${renderRawTextBlock('【PBS 原始通報 comment（完整原文，未經摘要／截斷／改寫）】', record.rawComment) || renderField('【PBS 原始通報 comment】', null)}
    ${renderRawTextBlock('【PBS 原始通報 sourceDetail（完整原文）】', record.rawSourceDetail)}
    ${renderField('Windows 送件時間（generatedAt，Asia/Taipei）', formatTaipeiInstant(record.generatedAt))}
    ${renderField('PBS 發生時間 / 更新時間', 'NOT RECORDED')}
  </div>
  <div class="detail-section">
    <h4>② Cloudflare</h4>
    <div class="row"><div class="label">收件狀態</div><div class="value">${cloudflareStatusLabel}</div></div>
    ${renderField('Cloudflare 收到時間（Asia/Taipei）', formatTaipeiInstant(record.timestamp))}
    ${renderField('transport idempotency status', idem ? idem.status : null)}
    ${renderField('attemptCount', idem ? idem.attemptCount : null)}
    ${renderField('AI 完成時間（idempotency completedAt，Asia/Taipei）', idem && idem.completedAt ? formatTaipeiInstant(idem.completedAt) : null)}
    ${renderField('是否為 transport duplicate', 'NO（本紀錄本身即代表首次接受；重複到達不會另外建立紀錄，見本頁下方「重複事件」說明）')}
  </div>
  <div class="detail-section">
    <h4>③ AI</h4>
    ${renderField('AI candidate created', triStateLabel(stage.candidateCreated, 'YES', 'NO'))}
    ${renderField('AI call started', triStateLabel(stage.aiCallStarted, 'YES', 'NO'))}
    ${renderField('Model', PBS_AI_MODEL_ID)}
    ${renderField('Cache', cacheLabel)}
    ${renderField('notify', decision ? (decision.notify ? 'TRUE' : 'FALSE') : record.outcome === AI_OUTCOME.AI_CALL_FAILED || record.outcome === AI_OUTCOME.AI_DECISION_INVALID ? 'N/A（判讀失敗）' : 'UNKNOWN / NOT RECORDED')}
    ${renderField('impact', decision ? decision.impact : null)}
    ${renderField('confidence', decision ? decision.confidence : null)}
    ${renderField('reason', decision ? decision.reason : record.outcome === AI_OUTCOME.AI_CALL_FAILED || record.outcome === AI_OUTCOME.AI_DECISION_INVALID ? 'UNKNOWN / NOT RECORDED（判讀失敗，無有效 decision）' : 'UNKNOWN / NOT RECORDED')}
  </div>
  <div class="detail-section">
    <h4>④ LINE</h4>
    ${renderField('LINE attempted', record.lineAttempted ? 'YES' : 'NO')}
    ${renderField('LINE sent', record.lineSent ? 'YES' : 'NO')}
    ${!record.lineAttempted ? renderField('未執行原因', lineNotAttemptedReason(record)) : ''}
    ${record.lineAttempted && !record.lineSent ? renderField('失敗原因', 'UNKNOWN / NOT RECORDED（僅記錄嘗試/成功與否；詳細錯誤見 Workers Logs）') : ''}
    ${renderField('LINE 發送時間', 'NOT RECORDED')}
    ${renderField('Shared Feed', record.sharedFeedPersisted === null || record.sharedFeedPersisted === undefined ? 'UNKNOWN / NOT RECORDED' : record.sharedFeedPersisted ? 'YES' : 'NO')}
    ${renderField('CCTV', record.imageUrlPresent === null || record.imageUrlPresent === undefined ? 'UNKNOWN / NOT RECORDED' : record.imageUrlPresent ? 'YES' : 'NO')}
  </div>
</div>`;
}

// order section 十三 — the mobile-first summary card must always show
// LINE's status in plain language, not only when it succeeded ("LINE：
// 未發送" is just as important a fact as "LINE：已發送" — a card that
// stays silent about a non-send looks like an oversight, not a fact).
function lineSummaryBadge(record) {
  if (record.lineSent) return '<span class="badge badge-line-ok">✅ LINE 已發送</span>';
  if (record.lineAttempted) return '<span class="badge badge-line-fail">❌ LINE 發送失敗</span>';
  return '<span class="badge badge-line-none">⏭️ LINE 未發送</span>';
}

function renderRow(record, decision, idem, now) {
  const meta = outcomeMeta(record);
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
    ${lineSummaryBadge(record)}
  </summary>
  ${renderDetail(record, decision, idem)}
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
  .badge-line-ok { background: #12261a; color: #3fb950; }
  .badge-line-fail { background: #2b1414; color: #f85149; }
  .badge-line-none { background: #262b34; color: #9aa1ac; }
  .flow-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 8px 0 14px; }
  .flow-chip { display: flex; align-items: center; gap: 5px; background: #12151a; border: 1px solid #262b34; border-radius: 999px; padding: 4px 10px; font-size: 12px; }
  .flow-icon { font-size: 13px; }
  .flow-label { color: #c3c9d1; }
  .flow-ok .flow-label { color: #3fb950; }
  .flow-fail .flow-label { color: #f85149; }
  .flow-pending .flow-label { color: #e3b341; }
  .flow-sep { color: #4b5563; font-size: 13px; padding: 0 2px; }
  .raw-text-block { background: #12151a; border: 1px solid #262b34; border-radius: 8px; padding: 8px 10px; margin: 4px 0; }
  .raw-text-label { font-size: 12px; color: #9aa1ac; margin-bottom: 4px; }
  .raw-text-value { font-size: 14px; color: #e8e9ec; white-space: pre-wrap; word-break: break-word; }
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
    const idem = await loadTransportIdempotencyDetail(env.TRAFFIC_KV, record);
    rowsHtml.push(renderRow(record, decision, idem, now));
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
