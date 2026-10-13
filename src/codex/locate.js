/**
 * Locating Codex session data on disk.
 *
 * Codex (CLI and Desktop) writes one JSONL "rollout" file per thread:
 *
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl
 *   $CODEX_HOME/archived_sessions/rollout-<ISO8601>-<uuid>.jsonl
 *
 * and a small title index at `$CODEX_HOME/session_index.jsonl` whose records
 * look like `{"id": "...", "thread_name": "...", "updated_at": "..."}`.
 *
 * `$CODEX_HOME` defaults to `~/.codex`.
 *
 * Everything here is I/O-light on purpose: the picker must stay responsive even
 * with hundreds of multi-megabyte transcripts, so we only ever read a bounded
 * window from the head and tail of each file.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { isInjectedUserText } from './parse.js';

/** Resolve the Codex home directory, honouring `$CODEX_HOME`. */
export function codexHome() {
  const fromEnv = process.env.CODEX_HOME;
  if (fromEnv && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.codex');
}

/** Candidate directories that may hold rollout files. */
export function sessionRoots(home = codexHome()) {
  return [
    { dir: path.join(home, 'sessions'), archived: false },
    { dir: path.join(home, 'archived_sessions'), archived: true },
  ];
}

/**
 * Recursively collect rollout files under the Codex home.
 *
 * Walks `sessions/` (nested by date) and `archived_sessions/` (flat). Codex
 * compresses older transcripts to `rollout-*.jsonl.zst`, so both suffixes are
 * collected; the `.zst` form is decompressed on read.
 *
 * Uses an iterative stack to avoid deep recursion and tolerates unreadable
 * directories (they are simply skipped) so a permission problem never breaks
 * the tool.
 *
 * @param {{ home?: string, includeArchived?: boolean, maxFiles?: number }} [opts]
 * @returns {Promise<Array<{ file: string, archived: boolean, compressed: boolean, mtimeMs: number, sizeBytes: number }>>}
 */
export async function findSessionFiles(opts = {}) {
  const home = opts.home ?? codexHome();
  const includeArchived = opts.includeArchived !== false;
  const maxFiles = opts.maxFiles ?? 20000;
  /** @type {Array<{ file: string, archived: boolean, compressed: boolean, mtimeMs: number, sizeBytes: number }>} */
  const results = [];

  for (const root of sessionRoots(home)) {
    if (root.archived && !includeArchived) continue;
    /** @type {string[]} */
    const stack = [root.dir];
    while (stack.length > 0 && results.length < maxFiles) {
      const dir = /** @type {string} */ (stack.pop());
      /** @type {import('node:fs').Dirent[]} */
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.startsWith('rollout-')) continue;
        // Skip Codex's transient partial writes.
        if (entry.name.endsWith('.tmp') || entry.name.includes('.tmp-')) continue;
        const compressed = entry.name.endsWith('.jsonl.zst');
        if (!compressed && !entry.name.endsWith('.jsonl')) continue;
        try {
          const stat = await fsp.stat(full);
          results.push({ file: full, archived: root.archived, compressed, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
        } catch {
          /* vanished between readdir and stat — ignore */
        }
      }
    }
  }
  return results;
}

/**
 * Read the title index written by Codex.
 *
 * @param {string} [home]
 * @returns {Promise<Map<string, { title: string, updatedAt: number }>>}
 */
export async function readSessionIndex(home = codexHome()) {
  /** @type {Map<string, { title: string, updatedAt: number }>} */
  const index = new Map();
  const candidates = [
    path.join(home, 'session_index.jsonl'),
    path.join(home, 'sqlite', 'session_index.jsonl'),
  ];
  for (const file of candidates) {
    let raw;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const record = JSON.parse(trimmed);
        const id = record?.id;
        const title = record?.thread_name;
        if (typeof id !== 'string' || typeof title !== 'string' || title.trim() === '') continue;
        const updatedAt = Date.parse(record?.updated_at ?? '') || 0;
        const existing = index.get(id);
        if (!existing || updatedAt >= existing.updatedAt) {
          index.set(id, { title: title.trim(), updatedAt });
        }
      } catch {
        /* tolerate a partially-written last line */
      }
    }
  }
  return index;
}

/**
 * Read a bounded window from the head and/or tail of a transcript.
 *
 * Transcripts reach tens of megabytes; reading them whole just to build a
 * picker entry is wasteful. `session_meta` is always the very first line, and
 * the most recent token/rate-limit snapshot is near the end, so a few tens of
 * kilobytes at each end is enough for everything the picker displays.
 *
 * Codex compresses transcripts older than about a week to `.jsonl.zst`. Those
 * cannot be seeked, so they are inflated first; this is bounded by
 * `maxInflateBytes` so a pathological archive cannot exhaust memory.
 *
 * @param {string} file
 * @param {{ headBytes?: number, tailBytes?: number, maxInflateBytes?: number }} [opts]
 * @returns {Promise<{ head: string, tail: string, size: number, compressed: boolean }>}
 */
export async function readHeadAndTail(file, opts = {}) {
  const headBytes = opts.headBytes ?? 64 * 1024;
  const tailBytes = opts.tailBytes ?? 128 * 1024;
  const maxInflateBytes = opts.maxInflateBytes ?? 256 * 1024 * 1024;

  if (file.endsWith('.zst')) {
    const buffer = await inflateZstd(file, maxInflateBytes);
    if (!buffer) return { head: '', tail: '', size: 0, compressed: true };
    const head = buffer.subarray(0, headBytes).toString('utf8');
    return {
      head,
      tail: buffer.length <= headBytes ? head : tailSlice(buffer, tailBytes),
      size: buffer.length,
      compressed: true,
    };
  }

  let handle;
  try {
    handle = await fsp.open(file, 'r');
  } catch {
    return { head: '', tail: '', size: 0, compressed: false };
  }
  try {
    const stat = await handle.stat();
    const size = stat.size;

    const headLength = Math.min(headBytes, size);
    const headBuf = Buffer.allocUnsafe(headLength);
    if (headLength > 0) await handle.read(headBuf, 0, headLength, 0);
    const headText = headBuf.toString('utf8');

    const readTail = async (/** @type {number} */ window) => {
      const length = Math.min(window, Math.max(0, size - headLength));
      if (length <= 0) return null;
      const buf = Buffer.allocUnsafe(length);
      await handle.read(buf, 0, length, size - length);
      return buf.toString('utf8');
    };

    let tail = '';
    if (size <= headBytes) {
      // The whole file already fits in the head window. Reuse it as the tail,
      // otherwise short transcripts (< the head window) would report no quota
      // and no token usage at all.
      tail = headText;
    } else {
      let window = tailBytes;
      for (let attempt = 0; attempt < 4; attempt++) {
        const raw = await readTail(window);
        if (raw === null) break;
        const trimmed = trimPartialFirstLine(raw);
        // A single record larger than the window leaves no complete line. Grow
        // the window rather than silently reporting "no data".
        if (trimmed !== '' || raw.indexOf('\n') === -1) {
          tail = trimmed;
          if (trimmed !== '') break;
        } else {
          tail = trimmed;
          break;
        }
        window *= 4;
      }
    }
    return { head: headText, tail, size, compressed: false };
  } catch {
    return { head: '', tail: '', size: 0, compressed: false };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Tail window of an in-memory buffer, with the leading partial line removed. */
function tailSlice(buffer, tailBytes) {
  const slice = buffer.subarray(Math.max(0, buffer.length - tailBytes)).toString('utf8');
  return trimPartialFirstLine(slice);
}

/** Drop everything before the first newline (the window starts mid-line). */
function trimPartialFirstLine(text) {
  const firstNewline = text.indexOf('\n');
  return firstNewline === -1 ? '' : text.slice(firstNewline + 1);
}

/**
 * Inflate a zstd-compressed transcript into memory.
 * Returns null (rather than throwing) when the file is unreadable, so a single
 * corrupt archive never breaks the whole listing.
 *
 * @param {string} file @param {number} maxBytes
 * @returns {Promise<Buffer|null>}
 */
export async function inflateZstd(file, maxBytes = 256 * 1024 * 1024) {
  // zstd support landed in Node 22.15. Access it through the module object so
  // an older runtime degrades to "compressed transcripts are skipped" instead
  // of failing to load the module at all.
  const decompress = /** @type {any} */ (zlib).zstdDecompressSync;
  if (typeof decompress !== 'function') return null;
  try {
    const stat = await fsp.stat(file);
    // A generous ratio guard: zstd on JSONL typically lands near 5-10x.
    if (stat.size * 64 > maxBytes * 4) return null;
    const compressed = await fsp.readFile(file);
    const output = decompress(compressed);
    if (output.length > maxBytes) return null;
    return output;
  } catch {
    return null;
  }
}

/**
 * Parse the head window into `{ meta, firstUserMessage, firstLines }`.
 *
 * @param {string} head
 * @returns {{ meta: any|null, firstUserMessage: string|null }}
 */
export function parseHead(head) {
  let meta = null;
  let firstUserMessage = null;
  const lines = head.split('\n');
  // The final line of the head window is likely truncated; skip it.
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type === 'session_meta' && meta === null) {
      meta = record.payload ?? {};
    } else if (firstUserMessage === null && isRealUserMessage(record)) {
      const text = extractMessageText(record.payload);
      // Codex injects environment blocks, AGENTS.md and plugin manifests under
      // the `user` role. Those must never become a session title.
      if (text && !isInjectedUserText(text)) firstUserMessage = text;
    }
    if (meta !== null && firstUserMessage !== null) break;
  }
  return { meta, firstUserMessage };
}

/** @param {any} record */
function isRealUserMessage(record) {
  if (record?.type === 'event_msg' && record.payload?.type === 'item_completed') {
    const item = record.payload.item;
    return item?.type === 'UserMessage';
  }
  if (record?.type === 'response_item' && record.payload?.type === 'message') {
    return record.payload.role === 'user';
  }
  return false;
}

/** @param {any} payload */
function extractMessageText(payload) {
  if (!payload) return null;
  const item = payload.item;
  const content = item?.content ?? payload.content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const part of content) {
    const text = part?.text;
    if (typeof text === 'string' && text.trim() !== '') parts.push(text);
  }
  const joined = parts.join('\n').trim();
  return joined === '' ? null : joined;
}

/**
 * Parse the tail window for the newest token and rate-limit snapshots.
 *
 * `token_count` events are not uniform: newer ones can carry `rate_limits:
 * null` (for example on aborted turns), and very old ones carry no rate limits
 * at all. Taking only the final event would therefore lose the quota state for
 * a whole class of sessions, so the newest event *with* rate limits is tracked
 * separately and returned as `lastRateLimit`.
 *
 * @param {string} tail
 */
export function parseTail(tail) {
  const lines = tail.split('\n');
  /** @type {any|null} */
  let lastTokenCount = null;
  /** @type {any|null} */
  let lastRateLimit = null;
  /** @type {any|null} */
  let lastWindowRateLimit = null;
  /** @type {any|null} */
  let lastUsageRecord = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (record?.type === 'event_msg' && record.payload?.type === 'token_count') {
      lastTokenCount = record.payload;
      const limits = record.payload.rate_limits;
      if (limits) {
        lastRateLimit = limits;
        // Some snapshots describe only credits, leaving `primary`/`secondary`
        // null. Keep the newest snapshot that actually carries window data so
        // the picker can still show a percentage.
        if (limits.primary || limits.secondary) lastWindowRateLimit = limits;
      }
    } else if (record?.type === 'token_usage_record') {
      lastUsageRecord = record.payload;
    }
  }
  return { lastTokenCount, lastRateLimit, lastWindowRateLimit, lastUsageRecord };
}

/** True when the Codex home looks usable, with a human-readable reason if not. */
export async function inspectCodexHome(home = codexHome()) {
  /** @type {{ ok: boolean, home: string, reason?: string, sessionsDir?: string }} */
  const result = { ok: false, home };
  if (!fs.existsSync(home)) {
    result.reason = `Codex home directory not found: ${home}`;
    return result;
  }
  const roots = sessionRoots(home);
  const existing = roots.filter((r) => fs.existsSync(r.dir));
  if (existing.length === 0) {
    result.reason = `No sessions directory under ${home} (looked for sessions/ and archived_sessions/)`;
    return result;
  }
  result.ok = true;
  result.sessionsDir = existing[0].dir;
  return result;
}
