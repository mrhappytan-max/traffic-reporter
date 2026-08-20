// Maps raw TDX records onto the unified event schema:
//
// {
//   source, type, title, description, road, direction, location,
//   startTime, endTime, updatedAt, rawId,
// }
//
// V1.8.6.4: `normalizeRoadEvent` also attaches an optional
// `locationDescription` — raw, human-oriented location/section text IF
// the raw record happens to carry any of a few candidate fields (see that
// function's own comment for exactly which, and each one's confidence
// level — none of them are confirmed to always be present, or even to
// exist at all on a real RoadEvent response), kept distinct from
// `location` so it's never lost just because structured KM is also
// present.
//
// V1.8.6.4 (provenance gap, follow-up round): `normalizeRoadEvent` also
// attaches a debug-only `provenance` object — `{classificationSource,
// locationSource?}` — recording WHICH raw field actually decided `type`
// and (when present) `locationDescription`. Captured from the SAME
// existing classification/extraction pass, never a second decision; never
// read by the formatter/fingerprint/eligibility/dedupe. Exists purely so
// broadcastProvenance.js's debug log can answer "上游到底是哪一個 raw
// field 提供這個資訊" without ever re-deriving it or storing the full raw
// payload.
//
// Freeway/Highway field mapping below was corrected against a real TDX
// response verified via the deployed /debug/tdx endpoint (see commit
// history / TDX_SOURCE_AUDIT.md for the earlier, unverified guesses).
// CMS and Bus Alert mappings still carry defensive fallbacks since only
// the "ignore" rules for those two were confirmed against real data, not
// every field name.
//
// V1.4.1: when `type` comes out as 'congestion', also attach a
// `congestionSeverity` ('moderate'|'congested'|null) derived from the
// SAME source text that decided the type — see congestionSeverity.js for
// why this exists (車多 vs 壅塞 must not both read as "嚴重壅塞") and for
// the only path allowed to ever set 'severe'.

import { firstDefined, get } from './extract.js';
import { classifyByKeyword, classifyAlertText } from './classify.js';
import { classifyCongestionSeverity } from '../traffic/congestionSeverity.js';
import { buildUpstreamSnapshot } from '../traffic/pipelineTrace.js';
import { detectNonCollisionAnomaly } from '../traffic/anomalyClassification.js';

const EVENT_TYPE_TEXT_MAP = {
  事故: 'accident',
  交通事故: 'accident',
  車禍: 'accident',
  施工: 'construction',
  道路施工: 'construction',
  封閉: 'closure',
  道路封閉: 'closure',
  管制: 'control',
  交通管制: 'control',
  壅塞: 'congestion',
  車多: 'congestion',
};

// V1.8.6.4 (provenance gap) — debug-only cap on any raw field value/
// summary kept in a provenance record. Never a security boundary, purely
// "don't let one oddly-huge raw field balloon a debug KV entry."
const PROVENANCE_VALUE_MAX_CHARS = 80;
function truncateForDebug(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.length > PROVENANCE_VALUE_MAX_CHARS ? `${text.slice(0, PROVENANCE_VALUE_MAX_CHARS)}…` : text;
}

// Checks EventType, then EventSubType, then Category independently (rather
// than stopping at whichever is present first) so a generic EventType
// doesn't shadow a more specific EventSubType.
//
// V1.8.6.4 (provenance gap) — this SAME single decision now also returns
// WHICH raw field actually won, as `classificationSource` — never a
// second classification pass, never a different result: every branch
// below returns the exact same `type` value this function always
// returned, just paired with the field/value that produced it. Debug-only
// (see broadcastProvenance.js) — never read by the formatter, eligibility,
// fingerprint, or dedupe.
function mapRoadEventType(raw, description) {
  const fieldCandidates = [
    ['EventType', get(raw, 'EventType')],
    ['EventSubType', get(raw, 'EventSubType')],
    ['Category', get(raw, 'Category')],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');

  let result = null;
  for (const [field, candidate] of fieldCandidates) {
    const key = String(candidate).trim();
    const classificationSource = { field, value: truncateForDebug(key), fallback: false };
    if (EVENT_TYPE_TEXT_MAP[key]) { result = { type: EVENT_TYPE_TEXT_MAP[key], classificationSource }; break; }
    const byKeyword = classifyByKeyword(key);
    if (byKeyword !== 'other') { result = { type: byKeyword, classificationSource }; break; }
  }

  if (!result) {
    // None of EventType/EventSubType/Category (if present at all) produced
    // a recognized type — falls back to keyword-matching the free-text
    // Description, same as always. `fallback: true` marks this branch
    // explicitly so a provenance reader can tell "a structured field
    // decided this" apart from "nothing structured matched, this is our
    // own description-keyword guess" — even when the result is still
    // 'other'.
    result = {
      type: classifyByKeyword(description),
      classificationSource: { field: 'Description', value: truncateForDebug(description), fallback: true },
    };
  }

  // V1.8.6.6 — root-cause fix (2026-08-20 Production incident, "行人誤闖"
  // broadcast as "🚨 交通事故"). See anomalyClassification.js's own module
  // comment for the full writeup. TDX's real schema uses a BROAD
  // `EventType` bucket (e.g. "事故") plus a more SPECIFIC `EventSubType` —
  // the loop above stops at the FIRST field that matches, so a broad
  // "事故" bucket on EventType alone can win before EventSubType/Category/
  // Description ever get consulted, discarding a more specific
  // non-collision-hazard signal (行人/動物 intrusion, etc.) they might
  // carry. Checked across EVERY candidate field (not just whichever one
  // "won" above) — catches the signal regardless of which field TDX
  // happened to put it in. Only ever fires when the result was 'accident'
  // — never touches any other type, never invents a NEW category, only
  // downgrades a specific, known false-positive pattern to 'other' (with
  // the matched hazard's own label/emoji, same shape
  // messageFormat.js's resolveOtherAnomalyDetail already returns).
  if (result.type === 'accident') {
    const allTexts = [get(raw, 'EventType'), get(raw, 'EventSubType'), get(raw, 'Category'), description]
      .filter((v) => v !== undefined && v !== null && v !== '')
      .map((v) => String(v));
    for (const text of allTexts) {
      const anomaly = detectNonCollisionAnomaly(text);
      if (anomaly) {
        return {
          type: 'other',
          classificationSource: { field: 'non-collision-anomaly-override', value: truncateForDebug(text), fallback: false },
          nonCollisionAnomaly: anomaly,
        };
      }
    }
  }

  return result;
}

// Same candidate fields mapRoadEventType() reads from, concatenated so
// classifyCongestionSeverity() sees whichever of them actually carried
// the 車多/壅塞-type keyword — deliberately NOT trying to track which
// single candidate "won" in mapRoadEventType above, since a plain
// substring search over all of them together is simpler and just as
// correct here (unlike type classification, severity has no "first
// specific match wins" ordering requirement).
function roadEventCongestionSeverityText(raw, description) {
  return [get(raw, 'EventType'), get(raw, 'EventSubType'), get(raw, 'Category'), description]
    .filter((v) => v !== undefined && v !== null && v !== '')
    .join(' ');
}

function composeLocation({ road, direction, startKM, endKM }) {
  const parts = [];
  if (road) parts.push(String(road));
  if (direction) parts.push(String(direction));
  if (startKM !== undefined || endKM !== undefined) {
    // StartKM/EndKM come back from TDX already formatted with a "K" unit
    // (e.g. "42K+000") — do not append another "K" here.
    const km = [startKM, endKM].filter((v) => v !== undefined && v !== '').join(' - ');
    if (km) parts.push(km);
  }
  return parts.join(' ');
}

/** Freeway / Highway live road events (v1 Traffic/RoadEvent/LiveEvent/*). */
export function normalizeRoadEvent(raw, source) {
  const description = firstDefined(
    raw,
    ['Description', 'EventDescription', 'Remark', 'EventName'],
    ''
  );

  const road = firstDefined(
    raw,
    ['Location.FreeExpressHighway.Road', 'RoadName', 'RoadID'],
    ''
  );
  const direction = firstDefined(
    raw,
    ['Location.FreeExpressHighway.Direction', 'Direction', 'RoadDirection'],
    ''
  );
  const startKM = firstDefined(
    raw,
    ['Location.FreeExpressHighway.StartKM', 'Location.StartLocationMile', 'StartLocationMile'],
    undefined
  );
  const endKM = firstDefined(
    raw,
    ['Location.FreeExpressHighway.EndKM', 'Location.EndLocationMile', 'EndLocationMile'],
    undefined
  );
  const blockedLanes = firstDefined(
    raw,
    ['Impact.BlockedLanes', 'ImpactLane.BlockedLanesNum', 'BlockedLanesNum'],
    undefined
  );

  const composedLocation = composeLocation({ road, direction, startKM, endKM });
  const location =
    composedLocation ||
    String(firstDefined(raw, ['LocationDescription', 'Location.Description', 'LocationMile'], ''));

  // V1.8.6.4 — CONFIRMED STRUCTURAL BUG (provable by reading the code
  // above, independent of any specific historical event): `location` is
  // composed from road+direction+KM the instant `road` is non-empty
  // (composeLocation() only ever returns '' if road/direction/KM are ALL
  // missing, which is rare) — so IF a raw record ever also carries a
  // genuinely human-readable location/section field, that text was being
  // silently discarded before it ever reached `location`, let alone the
  // LINE message. This mechanism is certain; whether it actually fired
  // for any specific past production event is NOT independently verified
  // (this repo has no persisted raw-payload history to check against —
  // see PROJECT_HANDOFF.md's "V1.8.6.4 — provenance audit" section).
  //
  // CONFIDENCE LEVELS for each candidate field below, precisely (do not
  // upgrade these without a real, independently-confirmed TDX response —
  // "不要假裝確認"):
  //   - `LocationDescription`/`Location.Description`: UNVERIFIED. These
  //     are the ORIGINAL V1.1 guessed field names (see commit 518d348),
  //     carried forward unchanged by ebff9ff's "corrected against a real
  //     TDX response" pass — that commit's own message lists exactly
  //     which fields it verified (title/road/direction/startKM/endKM/
  //     startTime/updatedAt/blockedLanes), and these two are NOT on that
  //     list. They may or may not exist on a real RoadEvent response —
  //     kept only as defensive, optional fallback candidates, same as
  //     they always were.
  //   - `RoadSection`/`Location.RoadSection`: also UNVERIFIED for
  //     RoadEvent. Confirmed to exist only on TDX's CCTV metadata dataset
  //     (`Road/Traffic/CCTV/Freeway` — see tdx/hsinchuCctvProbe.js's
  //     `isServiceAreaCctv`), a DIFFERENT TDX dataset than RoadEvent.
  //     Added here purely as a candidate on the (unconfirmed) assumption
  //     TDX's highway datasets share field-naming conventions — never
  //     assume it's actually populated on RoadEvent without checking a
  //     real response first.
  // Preserved UNCONDITIONALLY and RAW when present (no filtering/guessing
  // at this layer — see messageFormat.js's `pickHumanLocationText` for
  // the display-time "is this actually human text, not just another KM
  // string" check), as its own separate, fully OPTIONAL field so
  // `location`'s existing value/shape (and therefore notified.js's
  // fingerprint, which reads `location`) is completely untouched by this
  // change. Absent on the raw record -> simply absent here, never
  // fabricated, never assumed present.
  // V1.8.6.4 (provenance gap) — same candidate list as before, but now a
  // manual loop (instead of firstDefined) so the WINNING field name is
  // captured alongside the value, as `locationSource` — debug-only, never
  // changes `locationDescription`'s own value/presence, never a second
  // "which field is more trustworthy" decision (still strictly first-
  // match-wins, same order as always).
  const LOCATION_DESCRIPTION_CANDIDATE_FIELDS = ['LocationDescription', 'Location.Description', 'RoadSection', 'Location.RoadSection'];
  let locationDescription = '';
  let locationSource = null;
  for (const field of LOCATION_DESCRIPTION_CANDIDATE_FIELDS) {
    const value = get(raw, field);
    if (value !== undefined && value !== null && value !== '') {
      locationDescription = String(value).trim();
      locationSource = { field, value: truncateForDebug(locationDescription) };
      break;
    }
  }

  const { type, classificationSource, nonCollisionAnomaly } = mapRoadEventType(raw, description);

  return {
    source,
    type,
    title: firstDefined(
      raw,
      ['EventTitle', 'EventName', 'EventType', 'Description'],
      source === 'freeway' ? '國道路況事件' : '省道路況事件'
    ),
    description,
    road: String(road),
    direction: String(direction),
    location,
    startTime: firstDefined(raw, ['EffectiveTime', 'EventStartTime', 'StartTime'], null) || null,
    endTime: firstDefined(raw, ['EventEndTime', 'EndTime'], null) || null,
    updatedAt: firstDefined(raw, ['LastUpdateTime', 'UpdateTime', 'SrcUpdateTime'], null) || null,
    rawId: String(firstDefined(raw, ['EventID', 'ID', 'id'], '')),
    ...(type === 'congestion'
      ? { congestionSeverity: classifyCongestionSeverity(roadEventCongestionSeverityText(raw, description)) }
      : {}),
    ...(startKM !== undefined ? { startKM } : {}),
    ...(endKM !== undefined ? { endKM } : {}),
    ...(blockedLanes !== undefined ? { blockedLanes } : {}),
    ...(locationDescription ? { locationDescription } : {}),
    // V1.8.6.6 — set ONLY when mapRoadEventType's non-collision-anomaly
    // override fired (see that function's own comment). Not debug-only —
    // messageFormat.js's resolveOtherAnomalyDetail reads this directly so
    // display uses the EXACT SAME detection classification already made,
    // never a second independent text scan that could disagree with it
    // (the raw field that carried the anomaly text isn't necessarily part
    // of `title`/`description`, so a from-scratch re-scan of those two
    // alone could miss it).
    ...(nonCollisionAnomaly ? { nonCollisionAnomalyDetail: nonCollisionAnomaly } : {}),
    // V1.8.6.4 (provenance gap) — debug-only origin metadata, never read
    // by the formatter/fingerprint/eligibility/dedupe/CCTV-eligibility
    // (all of those destructure only their own named fields — see
    // notified.js's computeNotificationFingerprint / dedupe.js's
    // computeFingerprint / broadcastRules.js's getBroadcastEligibility for
    // confirmation none of them spread the whole event object). Answers
    // "which raw field actually produced this?" for
    // broadcastProvenance.js's debug record — see PROJECT_HANDOFF.md's
    // "V1.8.6.4 — provenance audit" section for the confidence-level
    // caveats on the location candidate field names themselves.
    provenance: { classificationSource, ...(locationSource ? { locationSource } : {}) },
    // V1.8.6.7 (Pipeline Trace) — same debug-only, never-read-by-the-real-
    // pipeline boundary as `provenance` above. Whitelisted raw-field
    // snapshot ONLY (see pipelineTrace.js's buildUpstreamSnapshot) — never
    // the full raw TDX record. `road`/`direction`/`startKM`/`endKM` here
    // are the SAME local variables already extracted above for the
    // normal fields (no second parse); EventType/EventSubType/Category
    // are read fresh via `get()` purely for trace display (0 extra I/O —
    // this is an in-memory object already fetched this run).
    pipelineTraceUpstream: buildUpstreamSnapshot({
      eventType: get(raw, 'EventType'),
      eventSubType: get(raw, 'EventSubType'),
      category: get(raw, 'Category'),
      rawDirection: direction,
      rawStartKM: startKM !== undefined ? startKM : null,
      rawEndKM: endKM !== undefined ? endKM : null,
      upstreamUpdatedAt: firstDefined(raw, ['LastUpdateTime', 'UpdateTime', 'SrcUpdateTime'], null) || null,
      description,
    }),
  };
}

function extractCmsText(raw) {
  const candidatePaths = [
    'Message',
    'CMSText',
    'DisplayText',
    'Content',
    'Message.MessageRow1',
    'Message.MessageRow2',
    'Message.MessageRow3',
    'MessageRow1',
    'MessageRow2',
    'MessageRow3',
  ];

  const parts = [];
  for (const path of candidatePaths) {
    const value = get(raw, path);
    if (typeof value === 'string' && value.trim()) {
      parts.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) {
          parts.push(item.trim());
        } else if (item && typeof item === 'object') {
          for (const nested of Object.values(item)) {
            if (typeof nested === 'string' && nested.trim()) parts.push(nested.trim());
          }
        }
      }
    }
  }

  return [...new Set(parts)].join(' ');
}

/** City CMS signboards (v2 Road/Traffic/Live/CMS/City/{City}). */
export function normalizeCmsEvent(raw) {
  const text = extractCmsText(raw);
  const type = classifyByKeyword(text);
  return {
    source: 'cms',
    type,
    title: text ? text.slice(0, 30) : 'CMS 看板訊息',
    description: text,
    road: String(firstDefined(raw, ['RoadName', 'RoadID'], '')),
    direction: String(firstDefined(raw, ['Direction', 'RoadDirection'], '')),
    location: String(firstDefined(raw, ['LocationMile', 'LocationDescription'], '')),
    startTime: null,
    endTime: null,
    updatedAt: firstDefined(raw, ['UpdateTime', 'DataCollectTime', 'SrcUpdateTime'], null) || null,
    rawId: String(firstDefined(raw, ['CMSID', 'ID', 'id'], '')),
    ...(type === 'congestion' ? { congestionSeverity: classifyCongestionSeverity(text) } : {}),
  };
}

/** City / InterCity bus operational alerts (v2 Bus/Alert/City/{City}). */
export function normalizeBusAlert(raw, source) {
  const description = firstDefined(
    raw,
    ['Description', 'AlertText', 'Content', 'ODescription', 'Title'],
    ''
  );
  const title = firstDefined(
    raw,
    ['Title', 'RouteName', 'AlertTitle'],
    description ? description.slice(0, 30) : '公車動態公告'
  );

  const type = description ? classifyAlertText(description) : 'alert';

  return {
    source,
    type,
    title,
    description,
    road: String(firstDefined(raw, ['RouteName', 'RouteID'], '')),
    direction: String(firstDefined(raw, ['Direction'], '')),
    location: String(firstDefined(raw, ['Location', 'AffectedSection'], '')),
    startTime: firstDefined(raw, ['EffectiveTime', 'StartTime', 'PublishTime'], null) || null,
    endTime: firstDefined(raw, ['ExpireTime', 'EndTime'], null) || null,
    updatedAt: firstDefined(raw, ['PublishTime', 'UpdateTime'], null) || null,
    rawId: String(firstDefined(raw, ['AlertID', 'ID', 'id', 'RouteID'], '')),
    ...(type === 'congestion' ? { congestionSeverity: classifyCongestionSeverity(description) } : {}),
  };
}
