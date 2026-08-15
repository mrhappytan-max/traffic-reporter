// Keyword-based classification for free-text sources (CMS signboard text,
// bus alert descriptions, and as a fallback when a structured EventType
// field can't be mapped).
//
// Note: the unified schema's example in the task only lists
// accident|construction|closure|congestion|alert|other, but the CMS
// classification requirement explicitly asks for six buckets including
// 管制 (traffic control). "control" is added as an extra `type` value to
// cover that — see README / TDX_SOURCE_AUDIT.md for context.

const KEYWORD_RULES = [
  { type: 'accident', patterns: [/事故/, /車禍/, /追撞/, /翻覆/, /自撞/] },
  { type: 'construction', patterns: [/施工/, /道路工程/, /維修工程/, /修補/] },
  { type: 'closure', patterns: [/封閉/, /封路/, /禁止通行/, /封道/] },
  { type: 'control', patterns: [/管制/, /分流/, /限制通行/, /交通疏導/] },
  { type: 'congestion', patterns: [/壅塞/, /車多/, /回堵/, /塞車/, /擁擠/, /車潮/] },
];

/** Classify free text into accident|construction|closure|control|congestion|other. */
export function classifyByKeyword(text) {
  if (!text || typeof text !== 'string') return 'other';
  for (const { type, patterns } of KEYWORD_RULES) {
    if (patterns.some((pattern) => pattern.test(text))) return type;
  }
  return 'other';
}

/** Same as classifyByKeyword, but defaults to "alert" instead of "other". */
export function classifyAlertText(text) {
  const type = classifyByKeyword(text);
  return type === 'other' ? 'alert' : type;
}
