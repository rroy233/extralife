/**
 * End-to-end tests of the *interactive* CLI path.
 *
 * The CLI tests drive the real executable, but a spawned process has no TTY, so
 * they only cover the non-interactive branch. These tests call `main()` in
 * process with injected fake TTY streams, which exercises the whole interactive
 * journey: picker → options screen → render → write, including cancellation at
 * each step.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { main } from '../src/cli.js';
import { tempDir, TranscriptBuilder } from './helpers/fixture.js';
import { displayWidth, stripAnsi } from '../src/util/ansi.js';

const dirs = [];
function freshDir(prefix) {
  const dir = tempDir(prefix);
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake TTY output stream that records everything written. */
class FakeOut extends EventEmitter {
  constructor(columns = 110, rows = 34) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = true;
    /** @type {string[]} */
    this.chunks = [];
  }
  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }
  get text() {
    return this.chunks.join('');
  }
  /** Everything written, with ANSI escapes removed. */
  get plain() {
    return stripAnsi(this.text);
  }
  /** The most recently drawn frame. */
  get frame() {
    const frames = this.text.split('\u001b[H').filter((f) => f.trim() !== '');
    return stripAnsi(frames[frames.length - 1] ?? '');
  }
}

/** A fake TTY input stream. */
class FakeIn extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.rawMode = false;
  }
  setRawMode(value) {
    this.rawMode = value;
    return this;
  }
  setEncoding() {
    return this;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  send(text) {
    this.emit('data', Buffer.from(text, 'utf8'));
  }
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Build a Codex home plus a working directory for the export. */
function fixture() {
  const home = freshDir('extralife-interactive-home-');
  const work = freshDir('extralife-interactive-work-');
  const day = path.join(home, 'sessions', '2026', '10', '10');
  fs.mkdirSync(day, { recursive: true });

  const a = new TranscriptBuilder({ sessionId: 'aaaa1111-2222-3333-4444-555566667777', cwd: '/Users/dev/alpha' });
  a.meta();
  a.worldState('# Alpha rules');
  a.userMessage('Implement the alpha importer', 't1');
  a.command('npm test', { turnId: 't1', status: 'failed', exitCode: 1, stderr: 'Error: boom' });
  a.agentMessage('Importer written; tests fail.', 'final_answer', 't1');
  a.tokenCount({ primary: 100, reached: 'rate_limit_reached' });
  fs.writeFileSync(path.join(day, 'rollout-alpha.jsonl'), a.toJSONL());

  const b = new TranscriptBuilder({ sessionId: 'bbbb8888-9999-aaaa-bbbb-ccccddddeeee', cwd: '/Users/dev/beta' });
  b.meta();
  b.userMessage('Tidy the beta docs', 't1');
  b.agentMessage('Done.', 'final_answer', 't1');
  fs.writeFileSync(path.join(day, 'rollout-beta.jsonl'), b.toJSONL());

  return { home, work };
}

/**
 * Run `main` with fake TTY streams and a scripted key sequence.
 * `keys` is a list of `[delayMs, text]` pairs.
 */
async function runInteractive(args, options = {}) {
  const { home } = options.fixture ?? fixture();
  const cwd = options.cwd ?? process.cwd();
  const stdout = new FakeOut(options.columns ?? 110, options.rows ?? 34);
  const stderr = new FakeOut(options.columns ?? 110, options.rows ?? 34);
  const stdin = new FakeIn();

  const previousCwd = process.cwd();
  const previousCache = process.env.EXTRALIFE_CACHE_DIR;
  process.env.EXTRALIFE_CACHE_DIR = freshDir('extralife-interactive-cache-');
  // Resolve relative --out paths against the fixture directory.
  process.chdir(cwd);

  const promise = main([...args, '--home', home, '--no-cache'], { stdin, stdout, stderr });

  for (const [delay, text] of options.keys ?? []) {
    await settle(delay);
    stdin.send(text);
  }

  let code;
  try {
    code = await Promise.race([
      promise,
      settle(options.timeout ?? 8000).then(() => 'TIMEOUT'),
    ]);
  } finally {
    process.chdir(previousCwd);
    if (previousCache === undefined) delete process.env.EXTRALIFE_CACHE_DIR;
    else process.env.EXTRALIFE_CACHE_DIR = previousCache;
  }
  return { code, stdout, stderr, stdin };
}

describe('interactive CLI — happy path', () => {
  it('walks picker → options → export and writes the file', async () => {
    const { home, work } = fixture();
    const out = path.join(work, 'handoff.txt');
    const result = await runInteractive(['--out', out], {
      fixture: { home, work },
      cwd: work,
      // enter (pick the first session) → enter (accept the defaults)
      keys: [[250, '\r'], [900, '\r']],
    });

    assert.equal(result.code, 0, `stderr:\n${result.stderr.plain}`);
    assert.ok(fs.existsSync(out), 'the handoff file was written');
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.includes('MISSION'));
    assert.ok(text.includes('NEXT STEPS'));
    assert.ok(result.stderr.plain.includes('Handoff ready'));
    // The picker must have been drawn.
    assert.ok(result.stdout.plain.includes('choose a session'), 'picker rendered');
    // …and the options screen too.
    assert.ok(result.stdout.plain.includes('export options'), 'options screen rendered');
  });

  it('restores the terminal after the interactive session', async () => {
    const { home, work } = fixture();
    const result = await runInteractive(['--out', path.join(work, 'h.txt')], {
      fixture: { home, work },
      cwd: work,
      keys: [[250, '\r'], [900, '\r']],
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdin.rawMode, false, 'raw mode released');
    assert.ok(result.stdout.text.includes('\u001b[?1049h'), 'entered the alternate screen');
    assert.ok(result.stdout.text.includes('\u001b[?1049l'), 'left the alternate screen');
    assert.ok(result.stdout.text.includes('\u001b[?25h'), 'cursor restored');
  });

  it('lets the search narrow the list before choosing', async () => {
    const { home, work } = fixture();
    const out = path.join(work, 'beta.txt');
    const result = await runInteractive(['--out', out], {
      fixture: { home, work },
      cwd: work,
      keys: [[250, 'beta'], [250, '\r'], [900, '\r']],
    });
    assert.equal(result.code, 0, result.stderr.plain);
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.includes('Tidy the beta docs'), 'the filtered session was exported');
    assert.ok(!text.includes('Implement the alpha importer'));
  });

  it('applies a minimal preset chosen on the options screen', async () => {
    const { home, work } = fixture();
    const out = path.join(work, 'minimal.txt');
    const result = await runInteractive(['--out', out], {
      fixture: { home, work },
      cwd: work,
      // pick, press '1' for minimal, then enter
      keys: [[250, '\r'], [900, '1'], [250, '\r']],
    });
    assert.equal(result.code, 0, result.stderr.plain);
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.includes('MISSION'));
    assert.ok(!text.includes('CONVERSATION HISTORY'), 'minimal preset omitted the conversation');
  });
});

describe('interactive CLI — cancellation', () => {
  it('exits 130 when the picker is cancelled', async () => {
    const { home, work } = fixture();
    const result = await runInteractive([], {
      fixture: { home, work },
      cwd: work,
      keys: [[300, '\u001b']],
    });
    assert.equal(result.code, 130);
    assert.ok(result.stderr.plain.includes('cancelled'));
    assert.equal(result.stdin.rawMode, false, 'terminal still restored');
  });

  it('exits 130 when the options screen is cancelled, writing nothing', async () => {
    const { home, work } = fixture();
    const out = path.join(work, 'never.txt');
    const result = await runInteractive(['--out', out], {
      fixture: { home, work },
      cwd: work,
      keys: [[250, '\r'], [900, '\u001b']],
    });
    assert.equal(result.code, 130);
    assert.equal(fs.existsSync(out), false, 'no file was written');
    assert.equal(result.stdin.rawMode, false, 'terminal still restored');
  });
});

describe('interactive CLI — robustness', () => {
  it('skips both screens with --yes and still respects the picker', async () => {
    const { home, work } = fixture();
    const out = path.join(work, 'yes.txt');
    const result = await runInteractive(['--yes', '--out', out], {
      fixture: { home, work },
      cwd: work,
      keys: [[250, '\r']],
    });
    assert.equal(result.code, 0, result.stderr.plain);
    assert.ok(fs.existsSync(out));
    assert.ok(!result.stdout.plain.includes('export options'), 'options screen was skipped');
  });

  it('survives the terminal being very narrow', async () => {
    const { home, work } = fixture();
    const out = path.join(work, 'narrow.txt');
    const result = await runInteractive(['--out', out], {
      fixture: { home, work },
      cwd: work,
      columns: 40,
      rows: 16,
      keys: [[250, '\r'], [900, '\r']],
    });
    assert.equal(result.code, 0, result.stderr.plain);
    assert.ok(fs.existsSync(out));

    // Check every frame independently. The raw stream also contains control
    // writes between frames (leaving the alternate screen, re-entering it) which
    // are not part of any rendered frame and would otherwise be concatenated
    // with the following frame's first line.
    const frames = result.stdout.text.split('\u001b[H').slice(1);
    assert.ok(frames.length > 0, 'at least one frame was drawn');
    for (const [frameIndex, frame] of frames.entries()) {
      for (const line of stripAnsi(frame).split(/\r?\n/)) {
        if (line.trim() === '') continue;
        assert.ok(
          displayWidth(line) <= 40,
          `frame ${frameIndex} overflowed at 40 cols: ${JSON.stringify(line.slice(0, 80))}`,
        );
      }
    }
  });

  it('reports no sessions when the filter matches nothing', async () => {
    const { home, work } = fixture();
    const result = await runInteractive(['--here'], {
      fixture: { home, work },
      cwd: work,
      keys: [],
      timeout: 4000,
    });
    assert.equal(result.code, 5);
    assert.ok(result.stderr.plain.includes('no sessions found'));
  });

  it('does not enter the alternate screen when it bails before the picker', async () => {
    const { home, work } = fixture();
    const result = await runInteractive(['--here'], {
      fixture: { home, work },
      cwd: work,
      keys: [],
      timeout: 4000,
    });
    assert.equal(result.code, 5);
    assert.ok(!result.stdout.text.includes('\u001b[?1049h'), 'never took over the screen');
  });
});
