/**
 * Small text / number / time formatting helpers shared by the CLI and renderers.
 */

/**
 * Rough token estimate for mixed English + CJK text.
 *
 * We deliberately avoid pulling in a real BPE tokenizer: this tool must stay
 * zero-dependency and start instantly. The heuristic below tracks cl100k/o200k
 * closely enough for budgeting (observed within ~10% on real Codex transcripts):
 *   - CJK / Hangul / Kana codepoints are ~1 token each (sometimes 2 chars/token)
 *   - runs of latin letters/digits average ~4 characters per token
 *   - every non-alphanumeric symbol tends to be its own token
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let latin = 0;
  let symbols = 0;
  let whitespaceRuns = 0;
  let inWhitespace = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const isSpace = cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d;
    if (isSpace) {
      if (!inWhitespace) whitespaceRuns++;
      inWhitespace = true;
      continue;
    }
    inWhitespace = false;
    if (
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff)
    ) {
      cjk++;
    } else if (/[A-Za-z0-9]/.test(ch)) {
      latin++;
    } else {
      symbols++;
    }
  }
  return Math.ceil(cjk * 0.85 + latin / 4 + symbols * 0.6 + whitespaceRuns * 0.25) + 1;
}

/**
 * Format a byte count for humans.
 * @param {number} bytes
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/**
 * Compact token count, e.g. 12345 -> "12.3k".
 * @param {number} n
 */
export function formatTokens(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Human-friendly relative time, e.g. "3m ago", "2d ago".
 * @param {number} timestampMs
 * @param {number} [now]
 */
export function relativeTime(timestampMs, now = Date.now()) {
  if (!Number.isFinite(timestampMs)) return 'unknown';
  const diff = now - timestampMs;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 60_000) return 'in a moment';
    if (ahead < 3_600_000) return `in ${Math.round(ahead / 60_000)}m`;
    if (ahead < 86_400_000) return `in ${Math.round(ahead / 3_600_000)}h`;
    return `in ${Math.round(ahead / 86_400_000)}d`;
  }
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 2_592_000_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return `${Math.round(diff / 2_592_000_000)}mo ago`;
}

/**
 * Absolute local timestamp, stable and sortable-ish: "2026-10-13 00:12".
 * @param {number} timestampMs
 */
export function formatDateTime(timestampMs) {
  if (!Number.isFinite(timestampMs)) return 'unknown';
  const d = new Date(timestampMs);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * ISO-8601 UTC timestamp, used inside generated documents.
 * @param {number} timestampMs
 */
export function isoTimestamp(timestampMs) {
  if (!Number.isFinite(timestampMs)) return 'unknown';
  return new Date(timestampMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Turn an arbitrary string into a filesystem-safe slug.
 * @param {string} s
 * @param {number} [maxLength]
 */
export function slugify(s, maxLength = 48) {
  const slug = String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const sliced = [...slug].slice(0, maxLength).join('');
  return sliced.replace(/-+$/g, '') || 'session';
}

/**
 * Collapse a path relative to a base directory when possible.
 * @param {string} target
 * @param {string} [base]
 */
export function relativePath(target, base) {
  if (!base) return target;
  const norm = (/** @type {string} */ p) => p.replace(/\/+$/, '');
  const t = norm(target);
  const b = norm(base);
  if (t === b) return '.';
  if (t.startsWith(b + '/')) return t.slice(b.length + 1);
  return target;
}

/**
 * Indent every non-empty line of a block.
 * @param {string} text
 * @param {string} prefix
 */
export function indentBlock(text, prefix) {
  return String(text)
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : prefix + line))
    .join('\n');
}

/**
 * Deduplicate while preserving first-seen order.
 * @template T
 * @param {Iterable<T>} items
 * @param {(item: T) => string} [keyOf]
 * @returns {T[]}
 */
export function uniqBy(items, keyOf = (x) => String(x)) {
  const seen = new Set();
  /** @type {T[]} */
  const out = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Collapse runs of blank lines and trim trailing whitespace on each line.
 * Used before writing the handoff so the artefact stays tidy regardless of how
 * messy the source transcript was.
 * @param {string} text
 */
export function tidy(text) {
  return String(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '') + '\n';
}
