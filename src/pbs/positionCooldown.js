// V2.9.0 (路況-070, executing 路況-069's own read-only規劃) — "一小時內
// 同位置不重複推播" 硬性規則. A THIRD, independent storage/comparison
// mechanism — deliberately NOT a reuse or extension of either existing
// module (路況-069's own二/三節查證已確立為何兩者都不適合):
//
//   - incidentMemory.js's own family grouping is driven by the AI's OWN
//     sameIncident verdict (`matchedIncidentKey = decision.sameIncident &&
//     memoryCandidates[0] ? ... : null`, see debugPush.js) — two events at
//     the SAME position where the AI judges sameIncident:false end up as
//     TWO separate records there. This rule must catch exactly that case
//     (真人的原話："不論AI怎麼判斷"), so it cannot share that grouping.
//   - incidentSuppression.js's own comparison IS purely positional (no AI
//     involvement) — the right SHAPE to copy — but its own constants
//     (INCIDENT_MAX_KM_DIFF=1.5) and window (10 minutes / legacy 60-minute
//     isMaterialEscalation) belong to ITS OWN existing behavior and must
//     never be repointed at a different product rule; it is also scoped to
//     `event.type==='accident'` only, while this rule is type-agnostic.
//
// PRODUCT DIRECTION — a deliberate reversal, not a correction (2026-09-10,
// 路況-070, following 路況-069's own planning round). V2.7.0's own design
// (src/pbs/debugPush.js#runAiDecisionPath's `suppressForNoChange` block,
// UNTOUCHED by this round) made the AI's sameIncident/materialChange
// verdict the SOLE semantic authority for a re-notification — and two
// consecutive real Production incidents (2026-09-09 追撞, 2026-09-10 砂石
// 車追撞) confirmed that machinery works CORRECTLY: the AI judged a real
// materialChange both times. The human decided, having watched both real
// cases, that even a correct "yes, something changed" verdict from the AI
// is not always what a driver wants to hear twice inside one hour — so
// this module adds a HARD, non-AI limit ON TOP of V2.7.0's judgment,
// never replacing it. See debugPush.js's own 路況-070 comment at this
// module's one call site for exactly where this sits in the pipeline
// relative to suppressForNoChange.
//
// KM-only proximity (路況-069 三節) — 真人定案文字只提到「公里數相差在1
// 公里內」，未提及座標比對，故本模組刻意只比對公里數，不比對經緯度（與
// incidentMemory.js#proximityMatch()的座標優先設計不同）。{road, direction,
// km} 描述本身沿用（唯讀取用，非修改、非重用其比對邏輯）incidentMemory.js
// 既有匯出的 deriveEventLocationForMemory() ——該函式已經統一處理PBS
// （displayKM）與TDX（startKM/endKM 中點）兩種來源的公里數萃取，是純粹的
// 資料取用，不是這裡要保持獨立的「比對」本身。km 為 null（無法從結構化
// 欄位取得公里數）時本模組永遠不攔截——與 incidentSuppression.js／
// incidentMemory.js 既有「無法確認位置就不猜、寧可讓內容被看到」的一貫
// 哲學一致。
//
// TWO-VALUE impact (路況-069 四節查證) — aiDecisionEngine.js 的
// VALID_IMPACT_VALUES 只有 HIGH/LOW 兩個合法值，沒有 MEDIUM。因此「嚴重
// 度升高」只有一種可能：LOW -> HIGH。maxImpactNotified 一旦被設為 HIGH，
// 依真人定案原文「若本次為HIGH則覆蓋，否則維持既有值不降級」永遠不再降回
// LOW，直到記錄本身因 POSITION_COOLDOWN_RECORD_TTL_MS 逾期而被整筆剪除。
//
// RECORD RETENTION（本輪自訂假設，路況-069/070原文皆未指定，已於施工回報
// 中揭露）——maxImpactNotified的「不降級」規則連「已超過60分鐘」的分支都
// 適用（見真人定案原文），代表記錄不能在60分鐘視窗一到就整筆消失，否則
// 「不降級」規則無從比較。沿用 incidentMemory.js 同一資料領域（road+
// direction+km）已經在用的 8 小時 TTL 量級作為預設保留期限——超過此期限
// 才整筆剪除（prune-on-touch，同 incidentSuppression.js/incidentMemory.js
// 既有慣例，never a separate sweep job）。
//
// Shared Feed（路況-070六）——本規則攔下的事件，呼叫端（debugPush.js）
// 直接不呼叫 runAiApprovedPbsBroadcast()，completedProducts 從未建立，
// 比照 V2.7.0 suppressForNoChange 的既有行為，0 Shared Feed 寫入。
//
// KV COST — 與 incidentSuppression.js/incidentMemory.js 同一數量級：每個
// 事件至多 1 次 get（本模組自己的 readPositionCooldownState），至多 1 次
// put（僅在「真正成功推播」之後才寫入，被本規則攔下或AI/其他機制攔下的
// 事件皆 0 次 put）。

import { contentEqual } from '../util/contentEqual.js';

export const POSITION_COOLDOWN_KV_KEY = 'line:position-cooldown-state';

// 真人定案（路況-069/070）：60 分鐘。
export const POSITION_COOLDOWN_WINDOW_MS = 60 * 60 * 1000;

// 真人定案：1 公里。刻意獨立於 incidentSuppression.js(1.5km) /
// incidentMemory.js(1.5km KM 後備／1000m 座標優先) 之外的全新常數——改這裡
// 絕不會牽動那兩個既有機制的既有行為，也絕不共用它們的門檻。
export const POSITION_COOLDOWN_MAX_KM_DIFF = 1;

// 記錄保留期限——見本檔案 header comment「RECORD RETENTION」一節，本輪
// 自訂假設，尚待會議室視現場觀察結果確認是否合適。
export const POSITION_COOLDOWN_RECORD_TTL_MS = 8 * 60 * 60 * 1000;

const VALID_IMPACT = new Set(['LOW', 'HIGH']);

function safeErrorMessage(err) {
  return err && typeof err.message === 'string' ? err.message : 'Unknown KV error';
}

function groupKeyOf(road, direction) {
  return `${road || ''}|${direction || ''}`;
}

/**
 * Read-only. Mirrors incidentSuppression.js#readIncidentSuppressionState /
 * incidentMemory.js#readIncidentMemory's exact shape/fail-open discipline:
 * a KV outage or corrupt blob degrades to {} (this rule never blocks
 * anything this event — fail toward delivering content, never toward
 * silence), not a thrown error.
 */
export async function readPositionCooldownState(kv) {
  if (!kv) {
    return { kvAvailable: false, kvError: 'TRAFFIC_KV binding not configured', groups: {}, existed: false };
  }
  try {
    const raw = await kv.get(POSITION_COOLDOWN_KV_KEY);
    let groups = {};
    let existed = false;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.groups && typeof parsed.groups === 'object') {
          groups = parsed.groups;
          existed = true;
        }
      } catch {
        groups = {};
      }
    }
    return { kvAvailable: true, kvError: null, groups, existed };
  } catch (err) {
    return { kvAvailable: false, kvError: safeErrorMessage(err), groups: {}, existed: false };
  }
}

/**
 * Pure, zero I/O. Independent KM-only proximity match — deliberately its
 * OWN comparison (never incidentMemory.js#proximityMatch, never
 * incidentSuppression.js's own private KM comparison), using
 * POSITION_COOLDOWN_MAX_KM_DIFF only. `km === null` (either side) never
 * matches — same "no reliable position, never guess" discipline every
 * other position-comparing module in this codebase already follows.
 */
export function findPositionCooldownMatch(records, km) {
  if (typeof km !== 'number' || !Number.isFinite(km)) return null;
  return (records || []).find((r) => r && typeof r.km === 'number' && Math.abs(r.km - km) <= POSITION_COOLDOWN_MAX_KM_DIFF) || null;
}

/**
 * Pure, zero I/O. The rule itself: given the (possibly null) matched
 * record for this position and this event's own AI-judged impact, decide
 * whether this event must be blocked.
 *
 * @param {{lastNotifiedAt:string, maxImpactNotified:'LOW'|'HIGH'}|null} match
 * @param {Date} now
 * @param {'LOW'|'HIGH'|undefined|null} impact - this event's own decision.impact
 * @returns {{blocked:boolean, exception:boolean, withinWindow:boolean}}
 *   `exception` is the ONLY thing that can unlock a second push inside an
 *   active window — a LOW->HIGH escalation (impact is a two-value enum,
 *   see this module's own header comment). No match, or a match whose
 *   window has already lapsed, is never itself "blocked" — this rule
 *   never re-decides anything V2.7.0 already handles; it only adds a
 *   position+time hard limit on top.
 */
export function evaluatePositionCooldown(match, now, impact) {
  if (!match || !match.lastNotifiedAt) return { blocked: false, exception: false, withinWindow: false };
  const elapsedMs = now.getTime() - new Date(match.lastNotifiedAt).getTime();
  // Inclusive boundary at exactly 60:00 (elapsedMs === POSITION_COOLDOWN_WINDOW_MS
  // still counts as "within"; the window only truly expires at 60:00:01+) —
  // same closed-interval convention this codebase already established for
  // broadcastHours.js's own 07:00~22:30 window (V2.8.0/路況-064: "22:30仍
  // 推播，22:31起停止"), the most directly comparable precedent for a
  // human-facing minute-boundary rule in this repo. Not independently
  // re-derived — this round's own assumption where the order text left the
  // exact edge (「60分00秒 vs 60分01秒」) to be decided, disclosed in this
  // round's own report.
  const withinWindow = elapsedMs <= POSITION_COOLDOWN_WINDOW_MS;
  if (!withinWindow) return { blocked: false, exception: false, withinWindow: false };
  const exception = impact === 'HIGH' && match.maxImpactNotified === 'LOW';
  return { blocked: !exception, exception, withinWindow: true };
}

/**
 * Pure, zero I/O. Builds the NEXT `groups` state after ONE successful
 * push at this location — the caller (debugPush.js) invokes this ONLY
 * when a real push actually succeeded (order 二 — 「成功推播後更新」,
 * never on a blocked or merely-attempted-but-failed event). Prunes every
 * record past POSITION_COOLDOWN_RECORD_TTL_MS across all groups first
 * (same prune-on-touch idiom incidentSuppression.js/incidentMemory.js
 * already use — no separate sweep job), then upserts this position's own
 * record: matched record updated in place (never downgrading
 * maxImpactNotified away from HIGH, per 真人定案原文), or a brand-new
 * record appended.
 */
export function buildPositionCooldownUpdate(groups, { road, direction, km }, impact, now) {
  const nextGroups = {};
  for (const [key, records] of Object.entries(groups || {})) {
    const alive = (records || []).filter((r) => r && r.lastNotifiedAt && now.getTime() - new Date(r.lastNotifiedAt).getTime() < POSITION_COOLDOWN_RECORD_TTL_MS);
    if (alive.length > 0) nextGroups[key] = alive;
  }

  const key = groupKeyOf(road, direction);
  const records = nextGroups[key] ? [...nextGroups[key]] : [];
  const match = findPositionCooldownMatch(records, km);
  const nowIso = now.toISOString();
  const safeImpact = VALID_IMPACT.has(impact) ? impact : null;
  const nextMaxImpact = safeImpact === 'HIGH' ? 'HIGH' : match ? match.maxImpactNotified || safeImpact : safeImpact;

  if (match) {
    const idx = records.indexOf(match);
    records[idx] = { ...match, km: typeof km === 'number' ? km : match.km, lastNotifiedAt: nowIso, maxImpactNotified: nextMaxImpact };
  } else {
    records.push({ road: road || '', direction: direction || '', km: typeof km === 'number' ? km : null, lastNotifiedAt: nowIso, maxImpactNotified: nextMaxImpact });
  }

  nextGroups[key] = records;
  return nextGroups;
}

/**
 * WRITE_ON_CHANGE, same shape as incidentSuppression.js#persistIncidentSuppressionState
 * / incidentMemory.js#persistIncidentMemory. Exactly one KV put at most,
 * never a list, never a delete.
 */
export async function persistPositionCooldownState(kv, nextGroups, now, options = {}) {
  const { previousGroups, previousStateExisted = false } = options;
  try {
    if (previousStateExisted && contentEqual(previousGroups, nextGroups)) {
      return { committed: true, written: false };
    }
    await kv.put(POSITION_COOLDOWN_KV_KEY, JSON.stringify({ groups: nextGroups, updatedAt: now.toISOString() }));
    return { committed: true, written: true };
  } catch (err) {
    return { committed: false, error: safeErrorMessage(err) };
  }
}
