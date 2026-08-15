// Builds the short LINE text for a driving audience. Never dumps the raw
// TDX Description onto the message — always a short, synthesized line set
// built from road/direction/location/type.

const TYPE_EMOJI = {
  accident: '🚨',
  construction: '🚧',
  closure: '🚧',
  control: '⚠️',
  congestion: '🐢',
  alert: 'ℹ️',
  other: 'ℹ️',
};

const TYPE_LABEL = {
  accident: '交通事故',
  construction: '道路施工',
  closure: '道路封閉',
  control: '交通管制',
  congestion: '嚴重壅塞',
  alert: '公車異動',
  other: '路況異常',
};

const TYPE_IMPACT_LINES = {
  accident: '事故影響通行\n請提前避開',
  construction: '施工影響通行\n請注意車道',
  closure: '道路封閉\n請改道行駛',
  control: '交通管制中\n請配合疏導',
  congestion: '車多回堵\n請預留時間',
  alert: '營運異動\n請留意公告',
  other: '請留意路況',
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

/**
 * @param {object} event - normalized unified event
 * @param {{ forecast?: boolean, minutesUntilStart?: number|null }} [options]
 *   forecast=true renders the "60分鐘路況預報" template for an event that
 *   hasn't started yet but falls inside the 60-minute window.
 */
export function formatEventMessage(event, { forecast = false, minutesUntilStart = null } = {}) {
  const roadLine = [event.road, event.direction].filter(Boolean).join(' ');
  const locationLine = event.location && event.location !== roadLine ? event.location : '';

  if (forecast) {
    const lines = [
      '⚠️ 60分鐘路況預報',
      roadLine,
      locationLine,
      minutesUntilStart != null ? `約${minutesUntilStart}分鐘後開始` : '即將開始',
      '建議提前改道',
    ].filter(Boolean);
    return lines.join('\n');
  }

  const emoji = TYPE_EMOJI[event.type] || 'ℹ️';
  const label = TYPE_LABEL[event.type] || '路況異常';
  const impactLines = TYPE_IMPACT_LINES[event.type] || '請留意路況';
  const updatedHHMM = toTaipeiHHMM(event.updatedAt);

  const lines = [
    `${emoji} ${label}`,
    roadLine,
    locationLine,
    impactLines,
    updatedHHMM ? `🕒 ${updatedHHMM}更新` : null,
  ].filter(Boolean);

  return lines.join('\n');
}
