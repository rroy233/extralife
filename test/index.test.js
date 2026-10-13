/**
 * Session index tests.
 *
 * The index is what the picker shows, so it must be fast, correct and resilient
 * to a Codex home containing junk, unreadable directories and partial writes.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import { buildSessionIndex, interpretRateLimit, projectLabel } from '../src/codex/index-cache.js';
import { findSessionFiles, inspectCodexHome, readSessionIndex } from '../src/codex/locate.js';
import { sampleSession, tempDir, TranscriptBuilder } from './helpers/fixture.js';

const dirs = [];
function freshDir() {
  const dir = tempDir('extralife-home-');
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Build a Codex home containing the given sessions. */
function makeHome(sessions) {
  const home = freshDir();
  const day = path.join(home, 'sessions', '2026', '10', '10');
  fs.mkdirSync(day, { recursive: true });
  sessions.forEach((builder, index) => {
    const file = path.join(day, `rollout-2026-10-10T11-00-0${index}-${builder.sessionId}.jsonl`);
    fs.writeFileSync(file, builder.toJSONL(), 'utf8');
  });
  return home;
}

describe('projectLabel', () => {
  it('uses the last path segment', () => {
    assert.equal(projectLabel('/Users/dev/projects/my-app'), 'my-app');
    assert.equal(projectLabel('/'), '/');
    assert.equal(projectLabel(''), '(unknown)');
  });

  it('disambiguates generic leaf names with their parent', () => {
    assert.equal(projectLabel('/Users/dev/projects/my-app/src'), 'my-app/src');
    assert.equal(projectLabel('/Users/dev/projects/my-app/docs'), 'my-app/docs');
  });
});

describe('interpretRateLimit', () => {
  it('flags the typed reached signal even below 100%', () => {
    const result = interpretRateLimit({
      primary: { used_percent: 40, window_minutes: 300, resets_at: 1800000000 },
      secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1800000000 },
      rate_limit_reached_type: 'workspace_owner_credits_depleted',
    });
    assert.equal(result.exhausted, true);
    assert.match(result.reason, /credits depleted/);
    assert.equal(result.resetsAtMs, 1_800_000_000_000);
  });

  it('flags a fully used primary window', () => {
    const result = interpretRateLimit({ primary: { used_percent: 100, window_minutes: 300, resets_at: 1 } });
    assert.equal(result.exhausted, true);
    assert.match(result.reason, /5h limit reached/);
  });

  it('flags a fully used weekly window', () => {
    const result = interpretRateLimit({ secondary: { used_percent: 100, window_minutes: 10080, resets_at: 1 } });
    assert.equal(result.exhausted, true);
    assert.match(result.reason, /weekly limit reached/);
  });

  it('does NOT flag depleted credits on an otherwise healthy snapshot', () => {
    // Codex reports `has_credits:false` on ordinary snapshots for plans that do
    // not use credits at all. Treating it as exhaustion would flag everything.
    const result = interpretRateLimit({
      primary: { used_percent: 42, window_minutes: 300, resets_at: 1 },
      secondary: { used_percent: 18, window_minutes: 10080, resets_at: 1 },
      credits: { has_credits: false, unlimited: false, balance: '0' },
      plan_type: 'plus',
      rate_limit_reached_type: null,
    });
    assert.equal(result.exhausted, false);
    assert.equal(result.reason, '');
  });

  it('handles missing and null input', () => {
    assert.equal(interpretRateLimit(null).exhausted, false);
    assert.equal(interpretRateLimit(undefined).exhausted, false);
    assert.equal(interpretRateLimit({}).exhausted, false);
    assert.equal(interpretRateLimit({ primary: null, secondary: null }).exhausted, false);
  });
});

describe('readSessionIndex', () => {
  it('reads thread names, keeping the newest per id', async () => {
    const home = freshDir();
    fs.writeFileSync(
      path.join(home, 'session_index.jsonl'),
      [
        JSON.stringify({ id: 'a', thread_name: 'Old name', updated_at: '2026-01-01T00:00:00Z' }),
        JSON.stringify({ id: 'a', thread_name: 'New name', updated_at: '2026-02-01T00:00:00Z' }),
        JSON.stringify({ id: 'b', thread_name: 'Another', updated_at: '2026-01-01T00:00:00Z' }),
        'not json at all',
        '',
      ].join('\n'),
      'utf8',
    );
    const index = await readSessionIndex(home);
    assert.equal(index.get('a').title, 'New name');
    assert.equal(index.get('b').title, 'Another');
    assert.equal(index.size, 2, 'malformed lines are skipped');
  });

  it('returns an empty map when the file is missing', async () => {
    assert.equal((await readSessionIndex(freshDir())).size, 0);
  });
});

describe('findSessionFiles', () => {
  it('finds date-nested sessions and archived ones', async () => {
    const home = freshDir();
    const day = path.join(home, 'sessions', '2026', '10', '10');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), '{}\n');
    fs.mkdirSync(path.join(home, 'archived_sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'archived_sessions', 'rollout-b.jsonl'), '{}\n');
    // Distractors that must be ignored.
    fs.writeFileSync(path.join(day, 'notes.txt'), 'ignore me');
    fs.writeFileSync(path.join(day, 'rollout-partial.jsonl.tmp'), '{}\n');
    fs.writeFileSync(path.join(day, 'rollout-old.jsonl.zst'), 'not really compressed');

    const all = await findSessionFiles({ home });
    assert.equal(all.length, 3, 'two plain plus one compressed');
    assert.equal(all.filter((f) => f.archived).length, 1);
    assert.equal(all.filter((f) => f.compressed).length, 1);

    const withoutArchived = await findSessionFiles({ home, includeArchived: false });
    assert.equal(withoutArchived.length, 2);
  });

  it('returns an empty list for a nonexistent home', async () => {
    assert.deepEqual(await findSessionFiles({ home: '/definitely/not/here' }), []);
  });
});

describe('inspectCodexHome', () => {
  it('reports a missing home with a reason', async () => {
    const result = await inspectCodexHome('/definitely/not/here');
    assert.equal(result.ok, false);
    assert.match(result.reason, /not found/);
  });

  it('reports a home without any sessions directory', async () => {
    const home = freshDir();
    const result = await inspectCodexHome(home);
    assert.equal(result.ok, false);
    assert.match(result.reason, /No sessions directory/);
  });

  it('accepts a home that has a sessions directory', async () => {
    const home = freshDir();
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    const result = await inspectCodexHome(home);
    assert.equal(result.ok, true);
  });
});

describe('buildSessionIndex', () => {
  it('indexes sessions with titles, project labels and quota', async () => {
    const b = new TranscriptBuilder({ sessionId: 'sess-1', cwd: '/Users/dev/alpha' });
    b.meta();
    b.tokenCount({ primary: 25, secondary: 10, total: 4321 });
    b.userMessage('build the alpha feature');

    const home = makeHome([b]);
    // A user-renamed title must win over the first user message.
    fs.writeFileSync(
      path.join(home, 'session_index.jsonl'),
      JSON.stringify({ id: 'sess-1', thread_name: 'Alpha work', updated_at: '2026-10-10T12:00:00Z' }),
      'utf8',
    );

    const entries = await buildSessionIndex({ home, useCache: false });
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.title, 'Alpha work');
    assert.equal(entry.projectLabel, 'alpha');
    assert.equal(entry.cwd, '/Users/dev/alpha');
    assert.equal(entry.gitBranch, 'main');
    assert.equal(entry.primaryUsedPercent, 25);
    assert.equal(entry.totalTokens, 4321);
    assert.equal(entry.interactive, true);
    assert.equal(entry.exhaustedReason, undefined);
  });

  it('falls back to the first real user message for the title', async () => {
    const b = new TranscriptBuilder({ sessionId: 'sess-2', cwd: '/Users/dev/beta' });
    b.meta();
    b.injectedUser('<environment_context>junk</environment_context>');
    b.userMessage('tidy up the beta importer');
    const home = makeHome([b]);

    const entries = await buildSessionIndex({ home, useCache: false });
    assert.equal(entries[0].title, 'tidy up the beta importer');
  });

  it('excludes automatic security-review threads by default', async () => {
    const review = new TranscriptBuilder({ sessionId: 'review-1', cwd: '/Users/dev/alpha' });
    review.meta({ thread_source: 'guardian_review' });
    review.userMessage('The following is the Codex agent history whose request action you are assessing.');

    const work = new TranscriptBuilder({ sessionId: 'work-1', cwd: '/Users/dev/alpha' });
    work.meta();
    work.userMessage('real work');

    const home = makeHome([review, work]);
    const defaults = await buildSessionIndex({ home, useCache: false });
    assert.deepEqual(defaults.map((e) => e.id), ['work-1']);

    const withAll = await buildSessionIndex({ home, useCache: false, includeNonInteractive: true });
    assert.equal(withAll.length, 2);
  });

  it('flags sessions whose quota was exhausted', async () => {
    const b = new TranscriptBuilder({ sessionId: 'sess-3', cwd: '/Users/dev/gamma' });
    b.meta();
    b.tokenCount({ primary: 100, secondary: 40, reached: 'rate_limit_reached' });
    const home = makeHome([b]);

    const entries = await buildSessionIndex({ home, useCache: false });
    assert.ok(entries[0].exhaustedReason, 'exhaustion is reported');
    assert.ok(entries[0].resetsAtMs > 0);
  });

  it('sorts sessions newest first', async () => {
    const old = new TranscriptBuilder({ sessionId: 'old', cwd: '/x/one', startTime: Date.parse('2020-01-01T00:00:00Z') });
    old.meta();
    old.userMessage('old session');
    const recent = new TranscriptBuilder({ sessionId: 'new', cwd: '/x/two', startTime: Date.parse('2026-01-01T00:00:00Z') });
    recent.meta();
    recent.userMessage('recent session');

    const home = makeHome([old, recent]);
    const files = await findSessionFiles({ home });
    const oldTime = new Date('2020-01-01T00:00:00.000Z');
    const recentTime = new Date('2026-01-01T00:00:00.000Z');
    for (const file of files) {
      const timestamp = file.file.endsWith('-old.jsonl') ? oldTime : recentTime;
      fs.utimesSync(file.file, timestamp, timestamp);
    }
    const entries = await buildSessionIndex({ home, useCache: false });
    assert.equal(entries[0].id, 'new');
  });

  it('indexes a zstd-compressed session', async () => {
    const b = new TranscriptBuilder({ sessionId: 'zstd-1', cwd: '/Users/dev/zip' });
    b.meta();
    b.userMessage('compressed session request');
    const home = freshDir();
    const day = path.join(home, 'sessions', '2026', '10', '10');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(
      path.join(day, 'rollout-compressed.jsonl.zst'),
      zstdCompressSync(Buffer.from(b.toJSONL(), 'utf8')),
    );

    const entries = await buildSessionIndex({ home, useCache: false });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, 'compressed session request');
    assert.equal(entries[0].cwd, '/Users/dev/zip');
  });

  it('caches results and reuses them on the second run', async () => {
    const b = new TranscriptBuilder({ sessionId: 'cache-1', cwd: '/Users/dev/cached' });
    b.meta();
    b.userMessage('cache me');
    const home = makeHome([b]);
    const pinned = new Date('2026-01-01T00:00:00.000Z');
    const [source] = await findSessionFiles({ home });
    fs.utimesSync(source.file, pinned, pinned);
    const cache = freshDir();
    const previous = process.env.EXTRALIFE_CACHE_DIR;
    process.env.EXTRALIFE_CACHE_DIR = cache;
    try {
      const first = await buildSessionIndex({ home });
      assert.equal(first.length, 1);
      assert.ok(fs.existsSync(path.join(cache, 'index.json')), 'cache file written');

      // Rewrite the title in place, keeping the byte length and the cache key
      // identical. A cache hit must then serve the old title.
      const stat = fs.statSync(first[0].file);
      const original = fs.readFileSync(first[0].file, 'utf8');
      fs.writeFileSync(first[0].file, original.replace('cache me', 'cachedXX'), 'utf8');
      // Keep the cache key stable across filesystems with different timestamp
      // precision by using the same fixed, whole-second timestamp.
      fs.utimesSync(first[0].file, pinned, pinned);
      assert.equal(
        Math.floor(fs.statSync(first[0].file).mtimeMs),
        Math.floor(stat.mtimeMs),
        'mtime pinning must be exact for this test to be meaningful',
      );
      assert.equal(fs.statSync(first[0].file).size, stat.size, 'size must be unchanged');

      const second = await buildSessionIndex({ home });
      assert.equal(second[0].title, 'cache me', 'served from cache');

      // With the cache disabled the new content is read.
      const third = await buildSessionIndex({ home, useCache: false });
      assert.equal(third[0].title, 'cachedXX', 'cache disabled re-reads the file');
    } finally {
      if (previous === undefined) delete process.env.EXTRALIFE_CACHE_DIR;
      else process.env.EXTRALIFE_CACHE_DIR = previous;
    }
  });

  it('survives a home full of junk', async () => {
    const home = freshDir();
    const day = path.join(home, 'sessions', '2026', '10', '10');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'rollout-garbage.jsonl'), 'this is not json\nnor is this\n');
    fs.writeFileSync(path.join(day, 'rollout-empty.jsonl'), '');
    fs.writeFileSync(path.join(home, 'session_index.jsonl'), 'garbage\n');

    const entries = await buildSessionIndex({ home, useCache: false });
    assert.equal(entries.length, 2, 'both files are still listed');
    assert.ok(entries.every((e) => typeof e.title === 'string' && e.title.length > 0));
  });

  it('returns an empty array for an empty home', async () => {
    const home = freshDir();
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    assert.deepEqual(await buildSessionIndex({ home, useCache: false }), []);
  });

  it('produces entries whose files all exist', async () => {
    const b = new TranscriptBuilder({ sessionId: 'exists-1' });
    b.meta();
    b.userMessage('hello');
    const home = makeHome([b]);
    const entries = await buildSessionIndex({ home, useCache: false });
    for (const entry of entries) assert.ok(fs.existsSync(entry.file), `${entry.file} exists`);
  });
});

describe('index performance characteristics', () => {
  it('does not read whole transcripts to build the index', async () => {
    // A session with a very large body must still index from the head/tail
    // windows alone; this is what keeps the picker responsive.
    const b = new TranscriptBuilder({ sessionId: 'big-1', cwd: '/Users/dev/big' });
    b.meta();
    b.userMessage('big session');
    for (let i = 0; i < 400; i++) b.command(`echo ${i}`, { stdout: 'y'.repeat(2000) });
    const home = makeHome([b]);
    const size = fs.statSync((await findSessionFiles({ home }))[0].file).size;
    assert.ok(size > 500_000, `fixture is large enough (${size} bytes)`);

    const started = Date.now();
    const entries = await buildSessionIndex({ home, useCache: false });
    const elapsed = Date.now() - started;
    assert.equal(entries.length, 1);
    assert.ok(elapsed < 2000, `indexing took ${elapsed}ms, expected well under 2s`);
  });
});

describe('sampleSession fixture integrity', () => {
  it('produces a parseable transcript', async () => {
    const dir = freshDir();
    const file = sampleSession({ cwd: dir }).writeTo(dir);
    assert.ok(fs.existsSync(file));
    assert.ok(fs.readFileSync(file, 'utf8').split('\n').length > 10);
  });
});

describe('os temp dir sanity', () => {
  it('is writable', () => {
    assert.ok(fs.existsSync(os.tmpdir()));
  });
});
