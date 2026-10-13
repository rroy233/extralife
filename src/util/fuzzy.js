/**
 * Dependency-free fuzzy subsequence matcher.
 *
 * The scoring model is the one popularised by fzf / Sublime Text and used by
 * most modern pickers: greedy subsequence match with bonuses for consecutive
 * runs, word boundaries and camelCase humps, plus a penalty for gaps. It is
 * fast enough to re-rank thousands of sessions on every keystroke.
 *
 * Also supports the `'` "exact" modifier and space-separated AND terms, which
 * is what users coming from fzf expect.
 */

const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = 8;
const BONUS_CAMEL = 7;
const BONUS_CONSECUTIVE = 6;
const BONUS_FIRST_CHAR = 4;
const PENALTY_LEADING = -2;

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isBoundaryChar(ch) {
  return /[\s/\\._\-:@,]/.test(ch);
}

/**
 * Score a single query term against a candidate string.
 *
 * @param {string} query lower-cased needle
 * @param {string} target original-case haystack
 * @returns {{ score: number, positions: number[] } | null} null when no match
 */
function scoreTerm(query, target) {
  if (query === '') return { score: 0, positions: [] };
  const lowerTarget = target.toLowerCase();

  // Fast path: exact substring.
  const direct = lowerTarget.indexOf(query);
  if (direct !== -1) {
    const positions = [];
    for (let i = 0; i < query.length; i++) positions.push(direct + i);
    let score = SCORE_MATCH * query.length + BONUS_CONSECUTIVE * query.length;
    if (direct === 0) score += BONUS_FIRST_CHAR * 2;
    else if (isBoundaryChar(target[direct - 1] ?? '')) score += BONUS_BOUNDARY;
    // Prefer earlier and shorter targets.
    score += Math.max(0, 12 - direct) - Math.floor(target.length / 24);
    return { score, positions };
  }

  // Subsequence walk with a small look-ahead so we prefer tighter alignments.
  let qi = 0;
  let score = 0;
  let previousIndex = -1;
  let inGap = false;
  const positions = [];
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    const ch = target[ti];
    if (ch.toLowerCase() !== query[qi]) {
      if (positions.length > 0) inGap = true;
      continue;
    }
    let bonus = 0;
    const prev = target[ti - 1] ?? '';
    if (ti === 0 || isBoundaryChar(prev)) bonus += BONUS_BOUNDARY;
    else if (/[a-z]/.test(prev) && /[A-Z]/.test(ch)) bonus += BONUS_CAMEL;
    if (previousIndex === ti - 1) bonus += BONUS_CONSECUTIVE;
    if (ti === 0) bonus += BONUS_FIRST_CHAR;

    if (inGap) {
      score += previousIndex === -1 ? SCORE_GAP_START : SCORE_GAP_EXTENSION * (ti - previousIndex - 1);
    }
    score += SCORE_MATCH + bonus;
    positions.push(ti);
    previousIndex = ti;
    inGap = false;
    qi++;
  }
  if (qi < query.length) return null;

  // Penalise leading unmatched characters and very long targets.
  score += PENALTY_LEADING * Math.min(positions[0] ?? 0, 10);
  score -= Math.floor(target.length / 24);
  return { score, positions };
}

/**
 * Fuzzy-match `target` against a whitespace-separated query.
 *
 * Every term must match (AND semantics). A term prefixed with `'` must appear
 * as an exact substring — the same escape hatch fzf offers.
 *
 * @param {string} query
 * @param {string} target
 * @param {{ positions?: boolean }} [opts]
 * @returns {{ score: number, positions: number[] } | null}
 */
export function fuzzyMatch(query, target, opts = {}) {
  const trimmed = String(query).trim();
  if (trimmed === '') return { score: 0, positions: [] };

  const terms = trimmed.split(/\s+/).filter(Boolean);
  let total = 0;
  /** @type {number[]} */
  const allPositions = [];

  for (const rawTerm of terms) {
    const exact = rawTerm.startsWith("'") || rawTerm.startsWith('!');
    let term = exact ? rawTerm.slice(1) : rawTerm;
    // fzf's modifier is a bare prefix (`'foo`). Accepting a matching closing
    // quote too (`'foo'`) costs nothing and matches what people actually type.
    if (exact && term.length > 1 && (term.endsWith("'") || term.endsWith('!'))) {
      term = term.slice(0, -1);
    }
    term = term.toLowerCase();
    if (term === '') continue;

    if (exact) {
      const idx = target.toLowerCase().indexOf(term);
      if (idx === -1) return null;
      total += SCORE_MATCH * term.length + 40;
      for (let i = 0; i < term.length; i++) allPositions.push(idx + i);
      continue;
    }

    const result = scoreTerm(term, target);
    if (!result) return null;
    total += result.score;
    allPositions.push(...result.positions);
  }

  return {
    score: total,
    positions: opts.positions === false ? [] : [...new Set(allPositions)].sort((a, b) => a - b),
  };
}

/**
 * Rank a list of items by fuzzy score against `query`.
 *
 * @template T
 * @param {T[]} items
 * @param {string} query
 * @param {(item: T) => string} keyOf
 * @returns {Array<{ item: T, score: number, positions: number[] }>}
 */
export function fuzzyFilter(items, query, keyOf) {
  const trimmed = String(query).trim();
  if (trimmed === '') return items.map((item) => ({ item, score: 0, positions: [] }));
  /** @type {Array<{ item: T, score: number, positions: number[] }>} */
  const out = [];
  for (const item of items) {
    const result = fuzzyMatch(trimmed, keyOf(item));
    if (result) out.push({ item, score: result.score, positions: result.positions });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
