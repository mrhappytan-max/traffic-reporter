// LOCATION QUALITY GATE — "有事故，但不知道事故在哪裡" must never spend a
// LINE Push (2026-08-24).
//
// WHY THIS EXISTS
// ---------------
// A real Production push, in full:
//
//   🚨 交通事故
//   台68 西向
//   （南寮竹東）-台68線
//   事故影響通行 / 請提前避開
//   🕒 13:48 更新
//
// Line 3 is not a location. It is PBS's official ROUTE NAME for the whole
// of 台68 — this repo already documents that exact string as a real
// `areaNm` example in pbs/roadName.js — and the bundled official dataset
// puts 南寮 at KM 0.4 and 竹東 at the far end of a 22.9 KM route. The
// message therefore told a driver "there is an accident somewhere on this
// entire road", which is not something anyone can act on. The monthly
// proactive-Push allowance is 200; a notification a driver cannot act on
// is the worst possible way to spend one.
//
// THE RULE
// --------
// Passing the service-area gate and being a genuine accident is no longer
// sufficient to earn a proactive push. The event must ALSO be placeable:
// the message we are about to send has to name somewhere more specific
// than the road itself.
//
// THREE GATES, PERMANENTLY INDEPENDENT
// ------------------------------------
//   TDX_CORROBORATION_REQUIRED   -> false in PBS_ONLY (TDX is off)
//   SERVICE_AREA_REQUIRED        -> ALWAYS true (traffic/serviceArea.js)
//   LOCATION_QUALITY_REQUIRED    -> ALWAYS true (this module)
//
// They answer three different questions — "is it corroborated", "is it
// ours", "can a driver use it" — and must never be collapsed into one
// another.
//
// IT ASKS THE EXISTING RESOLVERS; IT DOES NOT INVENT A LOCATION ENGINE
// --------------------------------------------------------------------
// Every tier below is answered by machinery this product already ships
// and already trusts: kmLocationResolver.js (official 里程牌/交流道 open
// data, bundled, zero network) and roadSectionLabel.js's curated 國1/國3
// anchors. Nothing here parses a new KM out of free text, and nothing
// here ever GUESSES where an accident is. If the existing resolvers
// cannot place it, the honest answer is "we don't know", and the honest
// product behaviour is to not push.
//
// DELIBERATELY ALIGNED WITH WHAT THE MESSAGE WILL ACTUALLY SAY
// -------------------------------------------------------------
// The tiers are, in order, exactly the inputs messageFormat.js's
// buildRoadLines() uses to produce its location text. That is the whole
// point: "sufficient" means the rendered message will genuinely name a
// place, not that some internal field happened to be populated. A tier
// that could pass the gate without changing the message would be a lie.
//
// FAIL-OPEN IS NOT AN OPTION, AND NEITHER IS THROWING
// ----------------------------------------------------
// Like serviceArea.js this gate only ever SUBTRACTS, and like
// kmLocationResolver.js it never throws — an internal error degrades to
// `insufficient`, i.e. one un-pushed notification, never a failed Cron
// tick (per the order's "不得因位置不足而 throw pipeline").

import { resolveKmLocation, resolveCoordinateLocation } from './kmLocationResolver.js';
import { parseKM } from './roadSectionLabel.js';
import { extractDisplayKmMatch } from '../pbs/normalize.js';

// Measured from the bundled official 交流道/服務區 dataset
// (data/road-location/generated/freewayFacilities.js, 交通部高速公路局),
// NOT chosen by feel: across 國道一號 and 國道三號 the gap between two
// consecutive facilities has p50 4 km, p95 11 km and a maximum of 15 km
// (inside the Hsinchu service window the widest is 竹林－寶山, 8 km).
//
// So 15 km is the widest span that can still honestly be described as
// "between these two interchanges". A reported range wider than the
// widest real interchange-to-interchange gap in the country is, by
// definition, not a segment a driver can picture — it is the "國1 XX－XX
// 超長區段" shape the order names as unacceptable. Recalibrate this from
// the dataset if the dataset changes; never widen it to let a specific
// event through.
export const MAX_ACTIONABLE_SEGMENT_KM = 15;

export const INSUFFICIENT_REASON = 'insufficient-location-precision';

// Explicit, driver-recognisable position markers. Only ever applied to
// text the message actually renders (see Tier D), and only as a
// RECOGNISER — nothing here ever produces or alters a location, so it can
// never invent a position the source did not state.
const FACILITY_PATTERN = /(交流道|系統|匝道|出口|入口|收費站|服務區|休息站|路口|隧道|大橋|橋下|橋上|高架|地下道)/;
// "行政區 + 更細地點" per the order's own tier C: a district-level token
// AND something finer inside it. Either half alone ("新竹地區") is
// explicitly listed as NOT sufficient.
const DISTRICT_PATTERN = /(縣|市|區|鄉|鎮)/;
const FINER_THAN_DISTRICT_PATTERN = /(里|村|路|街|段|巷|號)/;

function markerInText(text) {
  const km = extractDisplayKmMatch(text);
  if (km) return { tier: 'text-km-marker', evidence: km.matchedText };

  const facility = text.match(FACILITY_PATTERN);
  if (facility) return { tier: 'named-facility', evidence: facility[0] };

  if (DISTRICT_PATTERN.test(text) && FINER_THAN_DISTRICT_PATTERN.test(text)) {
    return { tier: 'admin-detail', evidence: text };
  }

  return null;
}

function sufficient(tier, evidence) {
  return { sufficient: true, tier, reason: `location-${tier}`, evidence: evidence || null };
}

function insufficient(detail, evidence) {
  return { sufficient: false, tier: null, reason: INSUFFICIENT_REASON, detail, evidence: evidence || null };
}

/**
 * Is this event's location precise enough to be worth a proactive push?
 *
 * Pure and synchronous — no I/O, no env, no TDX, no network (see
 * kmLocationResolver.js's own module comment: the datasets are bundled at
 * deploy time). Safe to call from the broadcast gate, a dry run, or a
 * test.
 *
 * @param {object} event - a normalized unified event
 * @param {{datasetOverride?: object}} [options] TEST-ONLY, passed straight
 *   through to the resolvers exactly as they already document.
 * @returns {{sufficient:boolean, tier:string|null, reason:string,
 *   detail?:string, evidence:object|null}} `reason` is always set on both
 *   paths so broadcastPipeline.js can aggregate it into
 *   ineligibleByReason and the Pipeline Trace like every other gate.
 */
export function resolveLocationQuality(event, { datasetOverride } = {}) {
  try {
    if (!event || typeof event !== 'object') return insufficient('no-event');

    const startKm = parseKM(event.startKM);
    const endKm = parseKM(event.endKM);

    // Tier A — structured KM straight from the source (TDX). The most
    // precise thing an event can carry, with ONE guard: a range wider
    // than any real interchange gap is a whole-corridor announcement, not
    // an accident location, so it does not qualify on its own and falls
    // through to the tiers below.
    if (startKm !== null || endKm !== null) {
      const spanKm = startKm !== null && endKm !== null ? Math.abs(endKm - startKm) : 0;
      if (spanKm <= MAX_ACTIONABLE_SEGMENT_KM) {
        return sufficient('structured-km', { startKm, endKm, spanKm });
      }
      // Deliberately no early return — an over-long range may still carry
      // usable coordinates below.
    }

    // Tier B — the official kilometre marker PBS states in its own free
    // text (pbs/normalize.js's displayKM). Display-authority only
    // everywhere else in this codebase, and that is exactly the authority
    // needed here: it is what the driver will read.
    if (typeof event.displayKM === 'number' && Number.isFinite(event.displayKM)) {
      return sufficient('display-km', { displayKM: event.displayKM });
    }

    // Tier C — the event's own coordinates, but ONLY when the existing
    // resolver can turn them into a place a person understands (the
    // order's own wording: "足夠精確的座標，且現有 resolver 可以可靠轉成
    // 可理解位置"). A bare lat/lng that lands nowhere near this road is
    // not evidence of anything.
    const byCoordinate = resolveCoordinateLocation(
      {
        road: event.road,
        direction: event.direction,
        latitude: event.latitude,
        longitude: event.longitude,
      },
      { datasetOverride }
    );
    if (byCoordinate.resolved && byCoordinate.locationLabel) {
      return sufficient('coordinate', {
        resolvedKm: byCoordinate.resolvedKm,
        distanceKm: byCoordinate.distanceKm,
        locationLabel: byCoordinate.locationLabel,
      });
    }

    // Tier D — the location text the MESSAGE ITSELF will show, when that
    // text states a concrete position. Deliberately restricted to the two
    // fields messageFormat.js actually renders — `locationDescription`
    // (line 1's own tier) and `location` (line 2's fallback) — and never
    // `description`, which the formatter never prints: a gate that passed
    // on text the driver will not see would be exactly the false
    // precision this module exists to stop.
    //
    // "States a concrete position" is judged by markerInText below, which
    // reuses pbs/normalize.js's ALREADY-SHIPPED strict kilometre parser
    // rather than adding a second one. This is not guessing a KM — it is
    // recognising that a marker the driver will read is already there.
    for (const field of ['locationDescription', 'location']) {
      const text = typeof event[field] === 'string' ? event[field].trim() : '';
      if (!text || text === String(event.road || '')) continue;
      const marker = markerInText(text);
      if (marker) return sufficient(marker.tier, { field, text, marker: marker.evidence });
    }

    // NOTE — deliberately NO "curated 國1/國3 anchor label" tier here.
    // roadSectionLabel.js derives its label FROM the KM values, so the
    // only way to reach such a tier is the over-long range Tier A just
    // rejected — and a two-interchange name computed from a 55 KM range
    // would be precisely the false precision this gate exists to stop.
    // An over-long range can still be rescued by Tier C above (real
    // coordinates), which is the only evidence that actually narrows it.

    // Nothing placed it. Record WHY in a form a human can read straight
    // off the Pipeline Trace, then block.
    const viaKm = resolveKmLocation(
      {
        road: event.road,
        direction: event.direction,
        startKM: event.startKM,
        endKM: event.endKM,
        displayKM: event.displayKM,
      },
      { datasetOverride }
    );
    return insufficient('no-placeable-location', {
      road: event.road || null,
      location: event.location || null,
      hasCoordinates: Number.isFinite(event.latitude) && Number.isFinite(event.longitude),
      coordinateReason: byCoordinate.resolved ? null : byCoordinate.reason || null,
      kmReason: viaKm.resolved ? null : viaKm.reason || null,
      overLongRangeKm:
        startKm !== null && endKm !== null && Math.abs(endKm - startKm) > MAX_ACTIONABLE_SEGMENT_KM
          ? Math.abs(endKm - startKm)
          : null,
    });
  } catch {
    // Same isolation principle as kmLocationResolver.js — a bug in this
    // module costs at most one un-pushed notification, never a Cron tick.
    return insufficient('quality-resolver-error');
  }
}

/** Thin boolean wrapper for call sites that don't need the evidence. */
export function hasActionableLocation(event, options) {
  return resolveLocationQuality(event, options).sufficient;
}
