// Builds the short LINE text for a driving audience. Never dumps the raw
// TDX Description onto the message — always a short, synthesized line set
// built from road/direction/location/type.
//
// V1.2C: the first two lines used to repeat "road direction" twice (e.g.
// "國道一號 北向\n國道一號 北向 91K+000 - 82K+400" — the exact bug reported
// from production) and showed raw KM markers a driver can't place on a
// map. Now: line 1 is a short road name + direction + (when resolvable) a
// human section label ("國1 北向｜竹北－湖口路段"); line 2 is purely the KM
// range ("91K+000～82K+400") as a second layer of detail — never both the
// road name AND the KM crammed onto one repeated line. See
// roadSectionLabel.js for the KM→interchange mapping (國道一號/國道三號
// only this round — everything else falls back to the original
// location-based line, per "不要擴大 scope").
//
// V1.8.6.4 — reported symptom (台3線): a 省道 LINE message showed only
// bare KM, with no place-name context at all — because line 1 only ever
// considered `getRoadSectionLabel()`'s curated 國1/國3 anchor table, and
// any road outside that table (every 省道) has nothing else to fall back
// on. NOTE — provenance-audit correction: this repo has no persisted raw
// TDX payload for the specific historical event that was reported, so
// whether that ONE event actually carried a populated human location
// field TDX's own `composeLocation()` then shadowed is NOT independently
// confirmed (see PROJECT_HANDOFF.md's "V1.8.6.4 — provenance audit"
// section). What IS confirmed, by reading
// `tdx/normalize.js`'s old code directly (a structural fact, not
// dependent on any one event): whenever structured KM was present,
// `composeLocation()` UNCONDITIONALLY shadowed any human location text a
// raw record might carry, before it ever reached this file — a genuine
// bug regardless of whether it fired on that specific historical event.
// Fixed at the source (see that module's own comment, including the
// per-field confidence levels for `LocationDescription`/
// `Location.Description`/`RoadSection` — none of them are confirmed to
// exist on a real RoadEvent response) by preserving them as a NEW,
// separate, fully optional `event.locationDescription` field; this file
// now prefers that genuine source text (when present) over an
// anchor-table label whenever it looks like real place text (not just
// another KM string) — see `pickHumanLocationText` below. Priority, per
// the round's own principle
// ("來源本來有的人類位置資訊 > 經可靠對照的路段名稱 > KM > 不顯示"):
//   1. `event.locationDescription` (TDX-supplied human text, filtered)
//   2. `resolveKmLocation()`'s official-open-data label (V1.8.6.5 — any
//      road the imported government dataset actually covers; see
//      kmLocationResolver.js. Fails closed to nothing when the dataset
//      doesn't cover that road/KM — never a guess.)
//   3. `getRoadSectionLabel()`'s curated anchor label (國1/國3 only —
//      no fabricated anchor table was added for 台1/台3/etc since this
//      repo has no independently-confirmed KM-anchor data for them;
//      guessing interchange positions is exactly what this project's
//      "不要猜" rule forbids)
//   4. raw KM (unchanged, second line)
//   5. nothing (bare road+direction only — never an invented address)
// A Google Maps URL (📍 地圖 ...) is a SEPARATE, additional trailing line
// — shown whenever resolveKmLocation() or resolveCoordinateLocation()
// produced a coordinate, regardless of which tier above won the label
// line, OR (2026-08-30, DIRECT_COORDINATE_MAP_FALLBACK hotfix) when
// neither did but the event still carries a valid raw coordinate — see
// buildRoadLines()'s own comment and kmLocationResolver.js's
// buildDirectCoordinateMapUrl for why: those two resolvers both require
// a recognized 國道/省道 road name before they'll use a coordinate at
// all, which a county/township road (e.g. 竹60線) never satisfies. The
// map line is never affected by, and never affects, which tier above
// wins the label — it never duplicates label text by construction: only
// one tier's TEXT is ever shown as the label, and the map line is a
// link, not text repeated from elsewhere.
// Deliberately NEVER extended to PBS's own `event.location` (areaNm) —
// that field is already covered by V1.8.5.1's own explicit "KM must win
// over a route-name-shaped location string" regression test, which this
// round must not regress (see required regression test 10 below / this
// file's own test suite).

import { getRoadShortName, getRoadSectionLabel } from './roadSectionLabel.js';
import { resolveKmLocation, resolveCoordinateLocation, buildDirectCoordinateMapUrl } from './kmLocationResolver.js';
import { DEFAULT_CONGESTION_SEVERITY } from './congestionSeverity.js';
import { detectNonCollisionAnomaly } from './anomalyClassification.js';

const TYPE_EMOJI = {
  accident: '🚨',
  construction: '🚧',
  closure: '🚧',
  control: '⚠️',
  alert: 'ℹ️',
  other: 'ℹ️',
};

const TYPE_LABEL = {
  accident: '交通事故',
  construction: '道路施工',
  closure: '道路封閉',
  control: '交通管制',
  alert: '公車異動',
  other: '路況異常',
};

const TYPE_IMPACT_LINES = {
  accident: '事故影響通行\n請提前避開',
  construction: '施工影響通行\n請注意車道',
  closure: '道路封閉\n請改道行駛',
  control: '交通管制中\n請配合疏導',
  alert: '營運異動\n請留意公告',
  other: '請留意路況',
};

// V1.8.6.4 — direction-aware impact wording. `event.direction === '雙向'`
// is a real structured TDX/PBS field, not a guess — so when it's set,
// naming it in the impact line ("雙向施工管制" instead of a direction-
// silent "施工影響通行") gives the driver real information the source
// already supports. Deliberately does NOT invent extra severity: a
// construction event still reads "雙向施工管制" (management/control),
// never "雙向道路封閉" — only `type==='closure'` ever says 封閉. Only the
// 4 types that actually reach a driver's LINE message today
// (accident/construction/closure/control — congestion is never
// broadcast, per broadcastRules.js) have a variant; `other`/`alert` keep
// their existing direction-silent wording unchanged, since this project
// has no reliably structured signal for which direction(s) an 'other'
// anomaly actually impacts.
const BIDIRECTIONAL_IMPACT_LINES = {
  accident: '事故影響雙向通行\n請提前避開',
  construction: '雙向施工管制\n請注意車道',
  closure: '雙向道路封閉\n請改道行駛',
  control: '雙向交通管制\n請配合疏導',
};

// V1.8.6.4 — production repro: an 'other'-typed event that legitimately
// passed broadcastRules.js's OTHER_ANOMALY_PATTERNS eligibility gate
// (積水/落石/坍方/樹倒/電線掉落/掉落物/火災/橋梁異常/道路中斷/etc — see
// that module) still rendered as a generic "ℹ️ 路況異常" here, because
// this file never looked at WHICH keyword matched, only that `type`
// stayed 'other'. Fixed with a display-only re-classification (does NOT
// touch `event.type`, dedupe/fingerprint semantics, or broadcast
// eligibility itself — those all still key off the plain 'other' type,
// completely unchanged) that picks the single most specific label for
// the headline. `無法通行` is deliberately excluded from this table (it
// only says "impassable", not WHY — no specific icon/label to show
// without guessing a cause that isn't actually in the source text).
//
// V1.8.6.6 — the keyword table itself now lives in
// anomalyClassification.js, shared with tdx/normalize.js's/
// pbs/classify.js's own non-collision-anomaly classification override
// (see that module's own comment) — one table, never two independently-
// maintained copies that could drift apart.

// PBS already carries a finer-grained, STRUCTURED category
// (`pbsCategory` — see pbs/classify.js) for exactly this situation, more
// reliable than re-parsing free text — checked first, before falling
// back to the keyword table above (which still applies to a plain TDX
// 'other' event, which has no `pbsCategory` at all).
const PBS_CATEGORY_ANOMALY_DETAIL = {
  obstruction: { emoji: '⚠️', label: '掉落物' },
  breakdown: { emoji: '🚗', label: '故障車' },
  'dangerous-driving': { emoji: '⚠️', label: '危險駕駛' },
};

// V1.8.6.4 (broadcast provenance) — exported so broadcastProvenance.js can
// reuse this EXACT SAME classification (for its `classificationEvidence`
// debug field) instead of re-implementing a second, parallel keyword
// table. Reusing the live function guarantees the debug record always
// agrees with what the LINE message itself actually showed — see that
// module's own comment for why this matters ("不要重新 classify 一遍造成
// 第二套規則").
/** @returns {{emoji:string,label:string}|null} null -> keep the generic "ℹ️ 路況異常" (never guessed beyond what the source text/category actually says). */
export function resolveOtherAnomalyDetail(event) {
  // V1.8.6.6 — highest priority: the EXACT SAME non-collision-anomaly
  // detection tdx/normalize.js's mapRoadEventType already made (when its
  // override fired — see that function's own comment) — never a second,
  // independent scan that could disagree, and correctly finds the
  // anomaly even when it came from a raw field (EventSubType/Category)
  // that isn't part of `title`/`description` at all.
  if (event.nonCollisionAnomalyDetail) return event.nonCollisionAnomalyDetail;
  if (event.pbsCategory && PBS_CATEGORY_ANOMALY_DETAIL[event.pbsCategory]) {
    return PBS_CATEGORY_ANOMALY_DETAIL[event.pbsCategory];
  }
  const text = `${event.title || ''} ${event.description || ''}`;
  return detectNonCollisionAnomaly(text);
}

// V1.4.1: congestion is no longer a single flat label — see
// congestionSeverity.js. 'severe' is only ever reached when
// congestionValidation.js has confirmed a real-time low VD speed
// upstream; a bare keyword match (or an unrecognized subtype, which
// falls back to DEFAULT_CONGESTION_SEVERITY='congested') can never
// produce "嚴重壅塞" on its own — that's the exact bug this fixes.
const CONGESTION_SEVERITY_DISPLAY = {
  moderate: { emoji: '🚗', label: '車流偏多', impactLines: '車流略多\n請留意路況' },
  congested: { emoji: '🐢', label: '壅塞', impactLines: '車多回堵\n請預留時間' },
  severe: { emoji: '🐢', label: '嚴重壅塞', impactLines: '嚴重回堵\n請提前改道' },
};

// V1.8.7.0 — Dynamic Shoulder (機動開放路肩) has direct value for
// professional/taxi drivers (an extra lane of legal capacity, or its
// removal) and gets its own dedicated headline/impact wording — never the
// generic "⚠️ 交通管制/交通管制中\n請配合疏導" TYPE_LABEL/TYPE_IMPACT_LINES
// this event's underlying `type` ('control') would otherwise produce.
//
// V1.8.7.2 — SHORTENED per this round's own product principle: a
// dynamic-shoulder push is a real-time status flip, not an incident
// narrative — a driver needs road/direction/section/KM/state, nothing
// else (see formatEventMessage's own dedicated short-circuit below,
// which returns exactly 4 lines: headline, road+section, KM range, this
// ONE state line — no map link, no safety-reminder sentence, no updated-
// time line). `stateLine` (was `impactLines`, a two-line safety-reminder
// pair) is now a single short line naming the state itself
// ("路肩開放通行"/"路肩停止開放") — deliberately NOT the removed
// "請依現場標誌及號誌行駛"/"請回主線車道" reminder sentences; the task's
// own instruction was explicit those are no longer necessary TEXT for
// this event type, not that the underlying legal/safety reality changed.
const DYNAMIC_SHOULDER_DISPLAY = {
  OPEN: { emoji: '🛣️', label: '機動開放路肩', stateLine: '路肩開放通行' },
  STOPPED: { emoji: '⛔', label: '路肩停止開放', stateLine: '路肩停止開放' },
};

function toTaipeiHHMM(isoString) {
  if (!isoString) return null;
  const ms = new Date(isoString).getTime();
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + 8 * 60 * 60 * 1000);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// event.startKM/endKM is a raw TDX-formatted string ("91K+000") for a
// normal single event, but a plain number (91, 82.4) on a
// congestionCluster.js merged candidate — accept and format both the
// same way.
function formatKM(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value; // already TDX-formatted
  if (typeof value === 'number' && Number.isFinite(value)) {
    const whole = Math.floor(value);
    const meters = Math.round((value - whole) * 1000);
    return `${whole}K+${String(meters).padStart(3, '0')}`;
  }
  return String(value);
}

function formatKmRange(startKM, endKM) {
  const start = formatKM(startKM);
  const end = formatKM(endKM);
  if (start && end && start !== end) return `${start}～${end}`;
  return start || end || '';
}

// True for text that is ITSELF just a KM point/range in disguise (e.g. a
// raw `LocationDescription` that happens to hold "92K+000", exactly as
// observed on TDX's sibling CCTV dataset — see normalize.js's comment).
// Showing that as if it were a place name would be redundant with the KM
// line below it, not genuinely new information — so it's treated the
// same as "no human text available", never displayed as a section label.
const KM_ONLY_TEXT_PATTERN = /^-?\d+(?:\.\d+)?\s*K(?:\s*\+\s*\d+)?(?:\s*[-~～]\s*-?\d+(?:\.\d+)?\s*K(?:\s*\+\s*\d+)?)?$/i;

/**
 * V1.8.6.4 — the source-text half of "來源本來有的人類位置資訊 > 經可靠
 * 對照的路段名稱 > KM > 不顯示". Only ever returns text the source
 * ITSELF supplied (`event.locationDescription`, see normalize.js) —
 * never synthesizes or guesses a place name. Rejects it only when it
 * carries no information beyond what's already shown elsewhere: empty,
 * purely a KM string (see above), or identical to the road/direction
 * line it would sit next to.
 */
function pickHumanLocationText(event, roadDirection) {
  const candidate = (event.locationDescription || '').trim();
  if (!candidate) return null;
  if (KM_ONLY_TEXT_PATTERN.test(candidate)) return null;
  if (candidate === roadDirection) return null;
  if (event.road && candidate === String(event.road)) return null;
  return candidate;
}

/**
 * Builds the first two message lines for an event: a short
 * "road direction｜section" (or just "road direction", when no section
 * label resolves) line, plus a second line dedicated purely to the
 * kilometer marker. Never repeats road+direction across both lines
 * either way.
 *
 * V1.8.5.1 — production repro (2026-08-18): a real accident had genuine
 * structured `startKM`/`endKM` (or, for a PBS event, a genuine free-text
 * `displayKM` — see pbs/normalize.js), but `getRoadSectionLabel` couldn't
 * resolve a named-interchange label for it (out of the curated anchor
 * table, or the road wasn't recognized by roadSectionLabel.js at all) —
 * so the OLD code fell all the way through to `event.location`, which
 * for a PBS event is a raw route-name string like "中山高速公路-國道1號",
 * not a kilometer at all. The event's own official KM was silently
 * dropped even though it was right there on the event. Fixed: KM display
 * priority is now independent of whether a section label resolved —
 * "不要因為無法產生 section label 就把明確 KM 丟掉":
 *   1. structured `startKM`/`endKM` (works whether or not a section
 *      label was resolvable)
 *   2. `event.displayKM` (PBS-only, free-text-derived, display-only —
 *      never treated as reliable enough for CCTV/fingerprint/suppression,
 *      see pbs/normalize.js's module comment)
 *   3. nothing recognizable as KM at all -> the original location-text
 *      fallback, unchanged from before this round.
 */
function buildRoadLines(event) {
  const shortRoad = getRoadShortName(event.road) || event.road || '';
  const roadDirection = [shortRoad, event.direction].filter(Boolean).join(' ');

  // V1.8.6.5 — official-open-data resolution. Pure/0-I/O (reads only the
  // bundled generated datasets, never a network call — see
  // kmLocationResolver.js's own module comment), so calling it once per
  // message build is cheap; broadcastProvenance.js calls it again
  // independently for its own evidence capture, same "call the pure
  // function twice, once per consumer" pattern already established by
  // resolveOtherAnomalyDetail.
  const kmResolution = resolveKmLocation({
    road: event.road,
    direction: event.direction,
    startKM: event.startKM,
    endKM: event.endKM,
    displayKM: event.displayKM,
  });
  // 2026-08-24 — when no KM is available at all, fall back to the event's
  // OWN coordinates. A PBS record carries x1/y1 and pbs/normalize.js has
  // always kept them as latitude/longitude, but until now nothing on the
  // display side ever read them: this function started from a KM value,
  // and PBS has no structured KM — so a PBS accident WITH exact
  // coordinates rendered byte-identically to one with none, i.e. the
  // route name alone ("（南寮竹東）-台68線"). Same bundled official
  // dataset, same labels, same 0-I/O guarantee — see
  // kmLocationResolver.js's resolveCoordinateLocation. Only consulted
  // when the KM path produced nothing, so no existing message changes.
  const coordinateResolution = kmResolution.resolved
    ? null
    : resolveCoordinateLocation({
        road: event.road,
        direction: event.direction,
        latitude: event.latitude,
        longitude: event.longitude,
      });
  const resolution =
    (kmResolution.resolved && kmResolution) ||
    (coordinateResolution && coordinateResolution.resolved && coordinateResolution) ||
    null;
  const resolverLabel = resolution ? resolution.locationLabel : null;
  let mapUrl = resolution ? resolution.mapUrl || null : null;

  // 2026-08-30 — DIRECT_COORDINATE_MAP_FALLBACK hotfix (order:
  // PBS_COORDINATE_DIRECT_MAP_FALLBACK). Real incident: EVENT_ID=
  // 11508260158-0 — a 竹60線 (county road) event carried valid PBS
  // x1/y1 coordinates the whole way through, but got NO map link at
  // all, because both resolution paths above require `event.road` to
  // canonicalize to a recognized 國道/省道 name before either will even
  // look at the coordinate — a county/township road never can (see
  // kmLocationResolver.js's own header comment on buildDirectCoordinateMapUrl
  // for the full root cause). This is the LAST resort, reached only when
  // neither existing path produced a mapUrl: it never touches
  // resolverLabel/sectionLabel/firstLine (computed below, independent of
  // mapUrl) — an unrecognized road still shows no location text, exactly
  // as before this round. Only whether the trailing "📍 地圖" line gets a
  // pin can change.
  if (!mapUrl) {
    mapUrl = buildDirectCoordinateMapUrl(event.latitude, event.longitude);
  }

  // Tier 1 (source's own human text) beats tier 2 (official KM Location
  // Resolver) beats tier 3 (curated 國1/國3 anchor table) — only fall
  // back to getRoadSectionLabel()'s resolution when neither of the first
  // two produced usable location text. See the V1.8.6.4/V1.8.6.5 module
  // comment above for the full priority rationale.
  const humanLocationText = pickHumanLocationText(event, roadDirection);
  const section =
    humanLocationText || resolverLabel ? null : getRoadSectionLabel({ road: event.road, startKM: event.startKM, endKM: event.endKM });
  const sectionLabel = humanLocationText || resolverLabel || (section && section.label);
  const firstLine = sectionLabel ? (roadDirection ? `${roadDirection}｜${sectionLabel}` : sectionLabel) : roadDirection;

  const structuredKmLine =
    event.startKM !== undefined || event.endKM !== undefined ? formatKmRange(event.startKM, event.endKM) : '';
  if (structuredKmLine) {
    return { firstLine, secondLine: structuredKmLine, mapUrl, roadDirection, sectionLabel };
  }

  if (typeof event.displayKM === 'number' && Number.isFinite(event.displayKM)) {
    return { firstLine, secondLine: formatKM(event.displayKM), mapUrl, roadDirection, sectionLabel };
  }

  // Fallback (no KM recognizable at all, structured or displayKM): keep
  // the original road+direction line, then only add a location line if
  // it carries information beyond that. Also strips the exact
  // reported-bug shape where `location` already starts with
  // "road direction " (composeLocation's own format), so the duplicate
  // can't resurface here either.
  let secondLine = event.location && event.location !== roadDirection ? event.location : '';
  if (secondLine && event.road && event.direction) {
    const prefix = `${event.road} ${event.direction} `;
    if (secondLine.startsWith(prefix)) secondLine = secondLine.slice(prefix.length);
  }
  // V1.8.6.4: don't repeat the same text on both lines if `event.location`
  // happens to duplicate the human location text already shown in
  // `sectionLabel` on line 1.
  if (secondLine && secondLine === sectionLabel) secondLine = '';
  return { firstLine, secondLine, mapUrl, roadDirection, sectionLabel };
}

// V2.4.2 — V2_4_2_PBS_AI_LINE_INFORMATION_FIDELITY_AND_POLICY_FIX.
//
// Production repro (2026-09-01): a 竹60鄉道坍方 event's PBS `comment` and
// the AI's own `reason` both correctly captured "道路完全阻斷、多車受困",
// but the LINE message that actually reached drivers still fell all the
// way down to a generic "請留意路況" — because, structurally, NOTHING in
// this file has ever read `event.description`'s own text into the
// message body (only `TYPE_IMPACT_LINES`'s fixed per-type sentence), and
// `event.sourceDetail` (PBS's own "誰通報的" field, e.g. "熱心聽眾"/
// "新竹市警察局勤務中心") was never read by this file AT ALL. Root cause
// confirmed by direct code reading, not a single-event guess — see this
// round's own final report for the full PBS raw -> normalize -> Queue ->
// AI -> LINE trace (`INFORMATION_LOSS_FILE`/`_FUNCTION`/`_REASON`).
//
// THREE-LAYER ARCHITECTURE this round establishes explicitly:
//   SOURCE FACTS (PBS/TDX normalized fields — road/direction/KM/
//     description/sourceDetail/blockedLanes) -> AI DECISION (notify/
//     impact/reason — a JUDGMENT, never re-shown as if it were a fact,
//     per order section 十五) -> LINE PRESENTATION (this file).
// This file only ever renders SOURCE FACTS — `event.description`/
// `event.sourceDetail`/`event.blockedLanes` — never an AI decision
// object's own `reason` text (that never reaches this file's arguments
// at all; see aiApprovedPbsBroadcast.js's own call site, which passes
// only the plain normalized `event`).
//
// `buildSourceFactLine` is deliberately PBS-only (`event.source==='pbs'`)
// — this file's OWN pre-existing header comment already establishes why
// TDX's raw `Description` field must never be dumped onto a message (the
// V1.2C-era production bug this file was built to prevent): TDX's
// free-text description was observed to be long/noisy, structurally
// unlike PBS's own typically-short human-typed `comment`. TDX's own
// STRUCTURED facts (`blockedLanes`, a real TDX Impact.BlockedLanes
// count) get their own dedicated, source-agnostic line below instead —
// order section 十六's own "若 TDX 欄位目前不足，列 NON_BLOCKER" for
// anything beyond that (TDX normalizer itself is NOT touched this round).
const SOURCE_FACT_MAX_CHARS = 60;
const SOURCE_DETAIL_MAX_CHARS = 40;

// Same three digit-before-unit shapes pbs/normalize.js's own
// DISPLAY_KM_*_PATTERN constants already parse (duplicated locally, same
// "each module stays independently readable" convention already used
// throughout this project — see e.g. this file's own truncateForDebug-
// style helpers) — here used only to strip a KM mention that's already
// shown on its own line (`secondLine`) from the fact line, so the two
// lines don't visibly repeat the same kilometre marker. An optional
// trailing "處" is also consumed ("23.5公里處" -> stripped whole), never
// required.
const FACT_KM_STRIP_PATTERNS = [
  /\d+(?:\.\d+)?\s*K\s*\+\s*\d{1,3}處?/i,
  /\d+(?:\.\d+)?\s*K(?!\s*\+)處?\b/i,
  /\d+(?:\.\d+)?\s*公里處?/,
];

function stripKmMention(text) {
  let out = text;
  for (const pattern of FACT_KM_STRIP_PATTERNS) {
    out = out.replace(pattern, '');
  }
  return out;
}

/**
 * SOURCE FACTS layer — carries PBS's own free-text `comment` (already on
 * `event.description`, see pbs/normalize.js) through to the driver,
 * capped so a long comment can never dominate the message ("不要全文照貼
 * 垃圾資訊" — order section 八). Never a second classification/decision:
 * this is the SAME text the AI decision engine itself already saw (see
 * pbs/aiCandidate.js#buildAiCandidate's own `comment` field) and the SAME
 * text messageFormat.js already reads for anomaly-detail/displayKM
 * extraction elsewhere in this file/pbs/normalize.js — just, for the
 * first time, also shown to the driver.
 *
 * @returns {string|null}
 */
function buildSourceFactLine(event, { roadDirection, sectionLabel } = {}) {
  if (!event || event.source !== 'pbs') return null;
  const raw = (event.description || '').trim();
  if (!raw) return null;
  // Never repeat text already shown verbatim on the road/section line.
  if (raw === roadDirection || raw === sectionLabel) return null;
  const cleaned = stripKmMention(raw).replace(/\s{2,}/g, ' ').trim();
  const text = cleaned || raw;
  return text.length > SOURCE_FACT_MAX_CHARS ? `${text.slice(0, SOURCE_FACT_MAX_CHARS)}…` : text;
}

/**
 * TDX's own structured Impact.BlockedLanes count (see tdx/normalize.js's
 * `blockedLanes` field) — a real number, never free text, so this is
 * safe for EVERY source (not gated to TDX specifically, though PBS never
 * sets this field today) and adds no new keyword/regex judgment. Mirrors
 * broadcastPolicy.js's own `hasStructuredLaneBlockage` reasoning: only a
 * genuine positive numeric count counts.
 *
 * @returns {string|null}
 */
function buildBlockedLanesLine(event) {
  const raw = event && event.blockedLanes;
  if (raw === undefined || raw === null || raw === '') return null;
  const count = Number(raw);
  if (!Number.isFinite(count) || count <= 0) return null;
  return `⚠️ 封閉${count}車道`;
}

/**
 * "通報：XXX" — PBS's own `sourceDetail` field (raw.srcdetail, e.g.
 * "熱心聽眾"/"新竹市警察局勤務中心"/"高速公路局交控中心"), shown VERBATIM,
 * never guessed or inferred when absent (order section 九: "只顯示原始
 * 提供的來源。AI 不得猜通報單位。"). Source-agnostic (checks the field,
 * not `event.source`) — safe for any future source that populates it.
 *
 * @returns {string|null}
 */
function buildSourceDetailLine(event) {
  const detail = (event && event.sourceDetail ? String(event.sourceDetail) : '').trim();
  if (!detail) return null;
  const truncated = detail.length > SOURCE_DETAIL_MAX_CHARS ? `${detail.slice(0, SOURCE_DETAIL_MAX_CHARS)}…` : detail;
  return `通報：${truncated}`;
}

/**
 * @param {object} event - normalized unified event
 * @param {{ forecast?: boolean, minutesUntilStart?: number|null }} [options]
 *   forecast=true renders the "60分鐘路況預報" template for an event that
 *   hasn't started yet but falls inside the 60-minute window.
 */
export function formatEventMessage(event, { forecast = false, minutesUntilStart = null } = {}) {
  const { firstLine, secondLine, mapUrl, roadDirection, sectionLabel } = buildRoadLines(event);
  // V1.8.6.5: 📍 地圖 line — see the module comment above for why this is
  // independent of which location-label tier won firstLine.
  const mapLine = mapUrl ? `📍 地圖 ${mapUrl}` : null;

  if (forecast) {
    const lines = [
      '⚠️ 60分鐘路況預報',
      firstLine,
      secondLine,
      minutesUntilStart != null ? `約${minutesUntilStart}分鐘後開始` : '即將開始',
      '建議提前改道',
      mapLine,
    ].filter(Boolean);
    return lines.join('\n');
  }

  // V1.8.7.0 / V1.8.7.2 — checked FIRST and returned IMMEDIATELY, ahead
  // of congestion/anomaly-detail/generic-type wording, the map line, and
  // the updated-time line every other event type still gets below. A
  // dynamic-shoulder event's `type` is still 'control' (see
  // dynamicShoulderClassification.js's own comment on why that's
  // deliberately never changed), so without this branch it would render
  // as the generic "⚠️ 交通管制" — technically not wrong, but not this
  // round's dedicated, deliberately SHORT wording. `firstLine`/
  // `secondLine` (road＋official section label, KM range) are the exact
  // same values buildRoadLines() already produces for every other event
  // type — including its own KM-only fallback when no section resolves
  // (see that function's own tier comment) — only the surrounding lines
  // (headline, state line) differ, and `mapLine`/an updated-time line
  // are deliberately NEVER appended for this event type (see
  // DYNAMIC_SHOULDER_DISPLAY's own comment for why). Exactly 4 lines,
  // never more.
  const dynamicShoulderDisplay = event.dynamicShoulder && DYNAMIC_SHOULDER_DISPLAY[event.dynamicShoulder.state];
  if (dynamicShoulderDisplay) {
    return [`${dynamicShoulderDisplay.emoji} ${dynamicShoulderDisplay.label}`, firstLine, secondLine, dynamicShoulderDisplay.stateLine]
      .filter(Boolean)
      .join('\n');
  }

  const congestionDisplay =
    event.type === 'congestion'
      ? CONGESTION_SEVERITY_DISPLAY[event.congestionSeverity] || CONGESTION_SEVERITY_DISPLAY[DEFAULT_CONGESTION_SEVERITY]
      : null;

  // V1.8.6.4: a genuinely-classifiable 'other' anomaly (積水/落石/坍方/...)
  // gets its own specific headline instead of always falling through to
  // the generic "路況異常" — see resolveOtherAnomalyDetail's own comment.
  const anomalyDetail = !congestionDisplay && event.type === 'other' ? resolveOtherAnomalyDetail(event) : null;

  const emoji = congestionDisplay ? congestionDisplay.emoji : anomalyDetail ? anomalyDetail.emoji : TYPE_EMOJI[event.type] || 'ℹ️';
  const label = congestionDisplay ? congestionDisplay.label : anomalyDetail ? anomalyDetail.label : TYPE_LABEL[event.type] || '路況異常';

  // V1.8.6.4: a real, structured direction==='雙向' gets direction-aware
  // impact wording (see BIDIRECTIONAL_IMPACT_LINES's own comment) —
  // congestion keeps its own severity-driven impact text unchanged.
  const impactLines = congestionDisplay
    ? congestionDisplay.impactLines
    : (event.direction === '雙向' && BIDIRECTIONAL_IMPACT_LINES[event.type]) || TYPE_IMPACT_LINES[event.type] || '請留意路況';
  const updatedHHMM = toTaipeiHHMM(event.updatedAt);

  // V2.4.2 — SOURCE FACTS layer (see this file's own architecture note
  // above buildSourceFactLine). Computed AFTER firstLine/secondLine so
  // the de-dup check against roadDirection/sectionLabel is accurate.
  const factLine = buildSourceFactLine(event, { roadDirection, sectionLabel });
  const blockedLanesLine = buildBlockedLanesLine(event);
  const sourceDetailLine = buildSourceDetailLine(event);

  const lines = [
    `${emoji} ${label}`,
    firstLine,
    secondLine,
    factLine,
    blockedLanesLine,
    impactLines,
    sourceDetailLine,
    mapLine,
    updatedHHMM ? `🕒 ${updatedHHMM}更新` : null,
  ].filter(Boolean);

  return lines.join('\n');
}
