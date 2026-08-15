// parseBroadcastCommand(text) — a small, conservative intent parser for the
// LINE 播報開關 commands. Replaces the old fixed-string Set lookup
// (ENABLE_COMMANDS/DISABLE_COMMANDS/STATUS_COMMANDS) with pattern-based
// matching so common natural phrasings ("我要開啟播報", "幫我打開播報",
// "不要播報了"...) are recognized without hand-listing every sentence.
//
// Keyword/regex-based, not NLP — same style as the project's existing
// classify.js (PBS) CLEARED_COMMENT_PATTERNS. Every pattern below is
// fully anchored (^...$) against the whole normalized message, so a
// keyword appearing mid-sentence in an unrelated context (a question, a
// negation) can never accidentally flip the switch — see the negation
// guard and the anchoring notes inline.
//
// Returns { intent: 'enable' | 'disable' | 'status' | 'unknown' }.
// Callers must treat 'unknown' as a strict no-op: don't touch any state.

const ON_VERB = '(?:啟動|開啟|打開|開始)';
const OFF_VERB = '(?:關閉|關掉|停止|暫停)';
// Longest-first doesn't actually matter for correctness (the surrounding
// pattern is fully anchored with $, so JS regex backtracking finds a full
// match regardless of alternation order) — kept longest-first only for
// readability/performance.
const TARGET = '(?:路況播報|路況|播報)';

// Natural "someone asking on my behalf" prefixes people actually type.
// Deliberately a small, fixed list (not a wildcard) — a parser being
// "generalized" is not license to swallow arbitrary lead-in text; each
// prefix here still has to be a filler word that doesn't change intent.
const PREFIX = '(?:我要|幫我|幫忙|請幫我|請|麻煩幫我|麻煩)?';
// Trailing filler particles that don't change intent either way.
const SUFFIX = '(?:了|吧|喔|囉|呢)?';

// verb-then-target ("開啟播報") or target-then-verb ("播報開啟"), each
// optionally softened by a known prefix/suffix filler. Anchored to the
// *entire* normalized message on purpose (see module comment).
const ON_REGEX = new RegExp(`^${PREFIX}(?:${ON_VERB}${TARGET}|${TARGET}${ON_VERB})${SUFFIX}$`);
const OFF_REGEX = new RegExp(`^${PREFIX}(?:${OFF_VERB}${TARGET}|${TARGET}${OFF_VERB})${SUFFIX}$`);

// "不要播報了" / "不要再播了" — a direct request to stop, with no ON/OFF
// verb in the sentence at all (播/播報 is the object being negated, not a
// verb from the lists above) — this is unambiguously OFF, not caught by
// the negation guard below (which only fires when a negation word is
// immediately followed by an actual ON/OFF verb).
const DIRECT_STOP_REGEX = /^不要(?:再)?播(?:報)?了?$/;

// Status queries: "播報狀態" / "路況播報狀態" / "播報有開嗎" / "播報開著嗎"
// (target-first) and "現在有開播報嗎" (verb-ish phrase first). Anchored
// the same way, so a rhetorical "為什麼播報關閉了" can't accidentally
// match just because it contains "播報".
const STATUS_REGEX = /^(?:現在)?(?:路況)?播報(?:狀態|有開嗎|開著嗎)$|^(?:現在)?有開(?:路況)?播報嗎$/;

// Negation guard: a negation word immediately (optionally through 我/你/
// 再 filler) followed by an ON/OFF verb means the sentence is negating
// that specific verb — "不要關閉播報" is not a clear OFF (it reads like
// "don't turn it off"), and "我不要開啟播報" is not a clear ON either.
// Per the spec: when this reads ambiguous, don't guess — always unknown,
// never attempt to flip the negation into the opposite intent.
const NEGATION_GUARD = new RegExp(`(?:不要|不|別|勿)(?:我|你)?(?:再)?(?:${ON_VERB}|${OFF_VERB})`);

function normalize(text) {
  if (typeof text !== 'string') return '';
  // NFKC folds fullwidth Latin/punctuation (ＯＮ, full-width space...)
  // into their standard forms, so "ON"/"ｏｎ"/"Ｏｎ" and 全形/半形
  // variants of the Chinese phrases all normalize the same way.
  return text.normalize('NFKC').trim();
}

export function parseBroadcastCommand(text) {
  const normalized = normalize(text);
  if (!normalized) return { intent: 'unknown' };

  const lower = normalized.toLowerCase();
  if (lower === 'on') return { intent: 'enable' };
  if (lower === 'off') return { intent: 'disable' };

  if (STATUS_REGEX.test(normalized)) return { intent: 'status' };

  // Checked before the direct-stop/ON/OFF patterns: an ambiguous negated
  // verb must never fall through and get matched by something else.
  if (NEGATION_GUARD.test(normalized)) return { intent: 'unknown' };

  if (DIRECT_STOP_REGEX.test(normalized)) return { intent: 'disable' };
  if (ON_REGEX.test(normalized)) return { intent: 'enable' };
  if (OFF_REGEX.test(normalized)) return { intent: 'disable' };

  return { intent: 'unknown' };
}
