// Parser for the 交通部高速公路局 (NFB) official static CCTV inventory XML
// (CCTV_v2.0, schema http://traffic.transportdata.tw/standard/traffic/schema/).
//
// WHY THIS EXISTS
// ---------------
// The broadcast path's camera inventory lived ONLY in a KV cache whose only
// writer was the TDX-dependent admin probe, under a 7-day TTL. With
// TRAFFIC_SOURCE_MODE=PBS_ONLY the writer can never run, so seven days later
// the key expired and every accident silently lost its CCTV image with
// `metadata-cache-unavailable` — a deadlock no amount of retrying could
// escape. This parser turns the official open-data file into the SAME record
// shape the cache already stores, so the inventory has a legitimate source
// that costs zero TDX calls.
//
// DELIBERATELY NOT A GENERAL XML PARSER. It handles exactly the flat,
// tag-per-line shape this feed emits, and it is strict: a record missing the
// fields the selector needs is dropped rather than guessed at. It lives in
// scripts/ because it runs at BUILD time only — the Worker bundles the
// generated result, never this code.
//
// FIELD NAMES ARE PRESERVED VERBATIM. tdx/hsinchuCctvProbe.js reads records
// by their original names (CCTVID, VideoStreamURL, LocationMile,
// RoadDirection, RoadID, RoadName, PositionLon/Lat, LocationType), so the
// safest possible conversion is the one that renames nothing. In particular
// LocationType is kept as the literal string it is: isServiceAreaCctv()
// matches it as TEXT and never as a guessed enum, so passing "1" through
// unchanged preserves that discipline exactly.

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function decodeXmlText(value) {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/** First value of <tag>…</tag> inside `block`, decoded; null when absent or empty. */
function tagValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!match) return null;
  const text = decodeXmlText(match[1]).trim();
  return text === '' ? null : text;
}

/** Fields the four-quadrant / single-camera selectors actually require. */
const REQUIRED_FIELDS = ['CCTVID', 'VideoStreamURL', 'LocationMile', 'RoadDirection'];

/**
 * @param {string} xml raw contents of the official CCTV_v2.0 file
 * @returns {{metadata: object, records: object[], skipped: number}}
 *   `records` are in the cache's own shape; `skipped` counts records dropped
 *   for missing required fields, so the build step can report a real number
 *   instead of silently shrinking the inventory.
 */
export function parseNfbCctvXml(xml) {
  if (typeof xml !== 'string' || xml.length === 0) throw new Error('nfb-cctv-xml: empty input');

  const metadata = {
    updateTime: tagValue(xml, 'UpdateTime'),
    updateInterval: tagValue(xml, 'UpdateInterval'),
    authorityCode: tagValue(xml, 'AuthorityCode'),
    linkVersion: tagValue(xml, 'LinkVersion'),
  };
  if (metadata.authorityCode !== 'NFB') {
    throw new Error(`nfb-cctv-xml: unexpected AuthorityCode ${metadata.authorityCode} (expected NFB)`);
  }

  const records = [];
  let skipped = 0;
  const blocks = xml.match(/<CCTV>[\s\S]*?<\/CCTV>/g) || [];
  for (const block of blocks) {
    const record = {};
    for (const tag of [
      'CCTVID',
      'SubAuthorityCode',
      'LinkID',
      'VideoStreamURL',
      'LocationType',
      'PositionLon',
      'PositionLat',
      'RoadID',
      'RoadName',
      'RoadClass',
      'RoadDirection',
      'LocationMile',
    ]) {
      const value = tagValue(block, tag);
      if (value !== null) record[tag] = value;
    }

    // RoadSection is nested {Start,End}. Preserved because it is genuinely
    // part of the record shape — and deliberately NOT used for the
    // service-area exclusion, which reads the device's own identity only
    // (see isServiceAreaCctv's comment: a mainline camera's RoadSection may
    // legitimately name a service area as one endpoint).
    const sectionBlock = block.match(/<RoadSection>([\s\S]*?)<\/RoadSection>/);
    if (sectionBlock) {
      const start = tagValue(sectionBlock[1], 'Start');
      const end = tagValue(sectionBlock[1], 'End');
      if (start !== null || end !== null) {
        record.RoadSection = { ...(start !== null ? { Start: start } : {}), ...(end !== null ? { End: end } : {}) };
      }
    }

    if (REQUIRED_FIELDS.some((f) => record[f] === undefined)) {
      skipped += 1;
      continue;
    }
    records.push(record);
  }

  if (records.length === 0) throw new Error('nfb-cctv-xml: parsed 0 usable records');
  return { metadata, records, skipped };
}
