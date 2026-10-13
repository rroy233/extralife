/**
 * Fast session indexing for the interactive picker.
 *
 * Building the picker requires a title, working directory, recency and quota
 * state for every transcript on disk. Reading them in full would mean parsing
 * hundreds of megabytes on every launch, so each entry is derived from a small
 * head/tail window instead, and the result is memoised in a cache file keyed by
 * `(path, size, mtime)`. A warm run over ~600 transcripts costs a few
 * milliseconds; a cold run costs one bounded read per file.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { findSessionFiles, parseHead, parseTail, readHeadAndTail, readSessionIndex } from './locate.js';
import { isInjectedUserText } from './parse.js';

const CACHE_VERSION = 3;

/**
 * @typedef {Object} SessionListEntry
 * @property {string} file
 * @property {string} id
 * @property {string} title
 * @property {string} cwd
 * @property {string} projectLabel
 * @property {number} mtimeMs
 * @property {number} sizeBytes
 * @property {number} lastActivityMs
 * @property {string} cliVersion
 * @property {string} originator
 * @property {string} threadSource
 * @property {string} gitBranch
 * @property {boolean} archived
 * @property {boolean} interactive   true when the thread is a human work session
 * @property {string} [exhaustedReason]
 * @property {number} [primaryUsedPercent]
 * @property {number} [secondaryUsedPercent]
 * @property {number} [resetsAtMs]
 * @property {string} [planType]
 * @property {number} [contextWindow]
 * @property {number} [totalTokens]
 * @property {string} preview
 */

/** Where to keep the memoised index. */
export function cacheDir() {
  if (process.env.EXTRALIFE_CACHE_DIR) return process.env.EXTRALIFE_CACHE_DIR;
  const base =
    process.env.XDG_CACHE_HOME ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches')
      : path.join(os.homedir(), '.cache'));
  return path.join(base, 'extralife');
}

/** Read the cache file, tolerating any form of corruption. */
async function readCache() {
  try {
    const raw = await fsp.readFile(path.join(cacheDir(), 'index.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== CACHE_VERSION || typeof parsed.entries !== 'object') return new Map();
    return new Map(Object.entries(parsed.entries));
  } catch {
    return new Map();
  }
}

/** Persist the cache. Failures are non-fatal (read-only homes, etc.). */
async function writeCache(entries) {
  try {
    const dir = cacheDir();
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `index.json.${process.pid}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(entries) }), 'utf8');
    await fsp.rename(tmp, path.join(dir, 'index.json'));
  } catch {
    /* caching is best-effort */
  }
}

/** Derive a short project label from a working directory. */
export function projectLabel(cwd) {
  if (!cwd) return '(unknown)';
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  const last = parts[parts.length - 1] ?? '';
  // Disambiguate common generic leaf names with their parent.
  if (['src', 'code', 'app', 'main', 'docs', 'test', 'tests'].includes(last) && parts.length > 1) {
    return `${parts[parts.length - 2]}/${last}`;
  }
  return last;
}

/**
 * Interpret the newest rate-limit snapshot for quota-exhaustion signalling.
 *
 * Codex reports three independent signals and any one of them means the account
 * cannot continue:
 *   - `rate_limit_reached_type`, the authoritative typed reason (may be set
 *     even when `used_percent` has not reached 100, e.g. depleted workspace
 *     credits);
 *   - `primary.used_percent >= 100` for the rolling window;
 *   - `secondary.used_percent >= 100` for the weekly window.
 *
 * @param {any} rateLimit
 * @returns {{ exhausted: boolean, reason: string, resetsAtMs: number|null }}
 */
export function interpretRateLimit(rateLimit) {
  if (!rateLimit) return { exhausted: false, reason: '', resetsAtMs: null };
  const primary = rateLimit.primary ?? null;
  const secondary = rateLimit.secondary ?? null;
  const reached = rateLimit.rate_limit_reached_type;
  const primaryPct = Number(primary?.used_percent ?? NaN);
  const secondaryPct = Number(secondary?.used_percent ?? NaN);

  /** @type {string[]} */
  const reasons = [];
  let resetsAtSec = 0;

  if (reached) {
    reasons.push(describeReachedType(String(reached)));
    resetsAtSec = Math.max(resetsAtSec, Number(primary?.resets_at ?? 0), Number(secondary?.resets_at ?? 0));
  }
  if (Number.isFinite(primaryPct) && primaryPct >= 100) {
    reasons.push(
      `${primary?.window_minutes ? formatWindow(primary.window_minutes) : 'primary'} limit reached`,
    );
    resetsAtSec = Math.max(resetsAtSec, Number(primary?.resets_at ?? 0));
  }
  if (Number.isFinite(secondaryPct) && secondaryPct >= 100) {
    reasons.push(
      `${secondary?.window_minutes ? formatWindow(secondary.window_minutes) : 'weekly'} limit reached`,
    );
    resetsAtSec = Math.max(resetsAtSec, Number(secondary?.resets_at ?? 0));
  }
  // Note: `credits.has_credits === false` is NOT an exhaustion signal. Codex
  // reports it on ordinary, healthy snapshots for plans that do not use
  // credits at all. Only the typed `rate_limit_reached_type` and a 100%
  // window are trustworthy, and both are checked above.

  return {
    exhausted: reasons.length > 0,
    reason: [...new Set(reasons)].join(', '),
    resetsAtMs: resetsAtSec > 0 ? resetsAtSec * 1000 : null,
  };
}

/**
 * Map Codex's `rate_limit_reached_type` enum to a sentence a human understands.
 * @param {string} value
 */
function describeReachedType(value) {
  switch (value) {
    case 'rate_limit_reached':
      return 'rate limit reached';
    case 'workspace_owner_credits_depleted':
      return 'workspace owner credits depleted';
    case 'workspace_member_credits_depleted':
      return 'workspace member credits depleted';
    case 'workspace_owner_usage_limit_reached':
      return 'workspace owner usage limit reached';
    case 'workspace_member_usage_limit_reached':
      return 'workspace member usage limit reached';
    default:
      return value.replace(/_/g, ' ');
  }
}

/** @param {number} minutes */
function formatWindow(minutes) {
  if (minutes >= 10080) return 'weekly';
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

/**
 * Build (or refresh) the session index.
 *
 * @param {{
 *   home?: string,
 *   includeArchived?: boolean,
 *   includeNonInteractive?: boolean,
 *   useCache?: boolean,
 *   maxAgeDays?: number,
 *   onProgress?: (done: number, total: number) => void,
 * }} [opts]
 * @returns {Promise<SessionListEntry[]>}
 */
export async function buildSessionIndex(opts = {}) {
  const useCache = opts.useCache !== false;
  const previous = useCache ? await readCache() : new Map();
  const next = new Map();

  const [files, titleIndex] = await Promise.all([
    findSessionFiles({ home: opts.home, includeArchived: opts.includeArchived }),
    readSessionIndex(opts.home),
  ]);

  /** @type {SessionListEntry[]} */
  const entries = [];
  let done = 0;
  const total = files.length;

  // Bounded concurrency: enough to saturate the page cache without exhausting
  // file descriptors on machines with thousands of transcripts.
  const CONCURRENCY = 16;
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const info = files[cursor++];
      const key = `${info.file}:${info.sizeBytes}:${Math.floor(info.mtimeMs)}`;
      const cached = previous.get(key);
      let entry;
      if (cached) {
        entry = cached;
      } else {
        entry = await buildEntry(info, titleIndex);
      }
      next.set(key, entry);
      entries.push(entry);
      done++;
      if (opts.onProgress && done % 50 === 0) opts.onProgress(done, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, files.length)) }, worker));

  if (useCache) await writeCache(next);

  const cutoff = opts.maxAgeDays ? Date.now() - opts.maxAgeDays * 86_400_000 : 0;
  const filtered = entries.filter((entry) => {
    if (!opts.includeNonInteractive && !entry.interactive) return false;
    if (entry.lastActivityMs > 0 && entry.lastActivityMs < cutoff) return false;
    return true;
  });
  filtered.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return filtered;
}

/**
 * Derive a single picker entry from one transcript using bounded reads.
 *
 * @param {{ file: string, archived: boolean, mtimeMs: number, sizeBytes: number }} info
 * @param {Map<string, { title: string, updatedAt: number }>} titleIndex
 * @returns {Promise<SessionListEntry>}
 */
async function buildEntry(info, titleIndex) {
  const { head, tail } = await readHeadAndTail(info.file);
  const { meta, firstUserMessage: headUserMessage } = parseHead(head);
  let firstUserMessage = headUserMessage;
  const { lastTokenCount, lastRateLimit, lastWindowRateLimit, lastUsageRecord } = parseTail(tail);

  const id = String(meta?.id ?? '');
  const cwd = String(meta?.cwd ?? '');
  const threadSource = String(meta?.thread_source ?? 'user');
  const rateLimit = lastWindowRateLimit ?? lastRateLimit ?? null;
  const { exhausted, reason, resetsAtMs } = interpretRateLimit(rateLimit);

  const indexed = id ? titleIndex.get(id) : undefined;

  // A large injected preamble (AGENTS.md, plugin manifests) can push the first
  // real user message past the head window. Retry once with a much wider window
  // only when we still have nothing to show — rare, and it keeps the common
  // path cheap.
  if (!indexed?.title && !firstUserMessage) {
    const wide = await readHeadAndTail(info.file, { headBytes: 1024 * 1024, tailBytes: 0 });
    firstUserMessage = parseHead(wide.head).firstUserMessage;
  }

  const fallbackTitle = firstUserMessage ? firstLine(firstUserMessage) : '';
  // A compressed transcript whose contents could not be inflated (an older Node
  // without zstd) must say so rather than masquerading as an untitled session.
  const unreadableCompressed = !meta && info.compressed === true;
  const title = unreadableCompressed
    ? '(compressed transcript — needs Node 22.15+ to read)'
    : indexed?.title || fallbackTitle || '(untitled session)';

  const lastActivityMs =
    info.mtimeMs ||
    (indexed?.updatedAt ?? 0) ||
    Date.parse(meta?.timestamp ?? '') ||
    0;

  return {
    file: info.file,
    id,
    title,
    cwd,
    projectLabel: projectLabel(cwd),
    mtimeMs: info.mtimeMs,
    sizeBytes: info.sizeBytes,
    lastActivityMs,
    cliVersion: String(meta?.cli_version ?? ''),
    originator: String(meta?.originator ?? ''),
    threadSource,
    gitBranch: String(meta?.git?.branch ?? ''),
    archived: Boolean(info.archived),
    interactive: threadSource !== 'guardian_review',
    exhaustedReason: exhausted ? reason : undefined,
    primaryUsedPercent: numOrUndef(rateLimit?.primary?.used_percent),
    secondaryUsedPercent: numOrUndef(rateLimit?.secondary?.used_percent),
    resetsAtMs: resetsAtMs ?? undefined,
    planType: rateLimit?.plan_type ? String(rateLimit.plan_type) : undefined,
    contextWindow: numOrUndef(lastTokenCount?.info?.model_context_window),
    totalTokens: numOrUndef((lastUsageRecord?.usage ?? lastTokenCount?.info?.total_token_usage)?.total_tokens),
    preview: firstUserMessage ? firstUserMessage.replace(/\s+/g, ' ').slice(0, 400) : '',
  };
}

/** @param {any} value */
function numOrUndef(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** @param {string} text */
function firstLine(text) {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.trim().slice(0, 120);
}

export { isInjectedUserText };
