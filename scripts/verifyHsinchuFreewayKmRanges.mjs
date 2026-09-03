#!/usr/bin/env node
// V2.4.10 — reproduces the derivation documented in
// src/tdx/hsinchuFreewayKmRanges.js's own header comment: cross-
// references the official 國道百公尺里程樁 dataset (data.gov.tw 95016)
// against the official 直轄市、縣市界線 polygon (data.gov.tw 7442),
// using the SAME isPointInRings() function src/tdx/hsinchuGeoResolver.js
// already uses for its Tier 1 coordinate check, to recompute the raw
// (pre-safety-margin) KM spans where 國道一號/國道三號 run through 新竹
// 市/新竹縣. Read-only, no writes — run this to re-verify
// hsinchuFreewayKmRanges.js's own hardcoded table any time either source
// dataset is refreshed (npm run update:road-location-data /
// update:hsinchu-boundary-data), never to auto-generate production code.
//
// Usage: node scripts/verifyHsinchuFreewayKmRanges.mjs

import { isPointInRings } from '../src/tdx/hsinchuGeoResolver.js';
import { HSINCHU_CITY, HSINCHU_COUNTY } from '../data/hsinchu-boundary/generated/hsinchuBoundary.js';
import freewayData from '../data/road-location/generated/freeway.js';
import freewayFacilities from '../data/road-location/generated/freewayFacilities.js';
import { HSINCHU_VERIFIED_FREEWAY_KM_RANGES, VERIFIED_HSINCHU_FREEWAY_KM_SAFETY_MARGIN_KM } from '../src/tdx/hsinchuFreewayKmRanges.js';

function isInHsinchu(lon, lat) {
  return isPointInRings(lon, lat, HSINCHU_CITY.rings) || isPointInRings(lon, lat, HSINCHU_COUNTY.rings);
}

function computeRawSpans(road) {
  const points = freewayData.points.filter((p) => p.road === road).sort((a, b) => a.km - b.km);
  const spans = [];
  let current = null;
  let prevKm = null;
  for (const p of points) {
    const inside = isInHsinchu(p.lng, p.lat);
    const contiguous = prevKm !== null && Math.abs(p.km - prevKm) <= 0.15;
    if (inside) {
      if (current && contiguous) {
        current.maxKm = p.km;
      } else {
        if (current) spans.push(current);
        current = { minKm: p.km, maxKm: p.km };
      }
    } else if (current) {
      spans.push(current);
      current = null;
    }
    prevKm = p.km;
  }
  if (current) spans.push(current);
  return spans;
}

let allOk = true;
for (const road of Object.keys(HSINCHU_VERIFIED_FREEWAY_KM_RANGES)) {
  const rawSpans = computeRawSpans(road);
  console.log(`\n=== ${road} ===`);
  console.log('Raw computed span(s) from live re-derivation:');
  for (const s of rawSpans) console.log(`  ${s.minKm.toFixed(1)}K – ${s.maxKm.toFixed(1)}K`);

  const shipped = HSINCHU_VERIFIED_FREEWAY_KM_RANGES[road].ranges;
  console.log('Shipped (safety-margined) range(s) in hsinchuFreewayKmRanges.js:');
  for (const r of shipped) console.log(`  ${r.minKm.toFixed(1)}K – ${r.maxKm.toFixed(1)}K`);

  // Re-derive the expected shipped range from the raw span + margin, and
  // confirm it matches what's actually hardcoded (catches drift if either
  // source dataset changes without the table being regenerated).
  if (rawSpans.length !== shipped.length) {
    console.error(`  MISMATCH: raw span count (${rawSpans.length}) != shipped range count (${shipped.length})`);
    allOk = false;
    continue;
  }
  for (let i = 0; i < rawSpans.length; i++) {
    const expectedMin = rawSpans[i].minKm + VERIFIED_HSINCHU_FREEWAY_KM_SAFETY_MARGIN_KM;
    const expectedMax = rawSpans[i].maxKm - VERIFIED_HSINCHU_FREEWAY_KM_SAFETY_MARGIN_KM;
    const shippedRange = shipped[i];
    const okMin = Math.abs(expectedMin - shippedRange.minKm) < 0.05;
    const okMax = Math.abs(expectedMax - shippedRange.maxKm) < 0.05;
    if (!okMin || !okMax) {
      console.error(
        `  MISMATCH range[${i}]: expected ${expectedMin.toFixed(1)}-${expectedMax.toFixed(1)} after margin, shipped ${shippedRange.minKm}-${shippedRange.maxKm}`
      );
      allOk = false;
    } else {
      console.log(`  OK: range[${i}] matches raw span + ${VERIFIED_HSINCHU_FREEWAY_KM_SAFETY_MARGIN_KM}km margin`);
    }
  }

  // Sanity cross-check against the official interchange dataset.
  const facilities = freewayFacilities.facilities.filter((f) => f.road === road && f.type.startsWith('交流道'));
  console.log('Interchange sanity check (official facilities dataset):');
  for (const f of facilities) {
    const inRawSpan = rawSpans.some((s) => f.km >= s.minKm && f.km <= s.maxKm);
    const inShipped = shipped.some((r) => f.km >= r.minKm && f.km <= r.maxKm);
    if (inRawSpan || inShipped) {
      console.log(`  ${f.name} (${f.km}K): raw=${inRawSpan} shipped=${inShipped}`);
    }
  }
}

console.log(allOk ? '\nALL RANGES MATCH LIVE RE-DERIVATION' : '\nDRIFT DETECTED — see MISMATCH lines above');
process.exit(allOk ? 0 : 1);
