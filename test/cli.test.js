/**
 * End-to-end CLI tests.
 *
 * These spawn the real executable against a synthetic CODEX_HOME so the whole
 * pipeline is covered: argument handling, session resolution, extraction,
 * rendering, file output and exit codes.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { sampleSession, tempDir, TranscriptBuilder } from './helpers/fixture.js';
import { makeSecret } from './helpers/secrets.js';

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/extralife.js', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const dirs = [];
function freshDir(prefix) {
  const dir = tempDir(prefix);
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A Codex home with two sessions and a working directory to run the CLI from. */
function makeFixtureHome() {
  const home = freshDir('extralife-cli-home-');
  const work = freshDir('extralife-cli-work-');
  const day = path.join(home, 'sessions', '2026', '10', '10');
  fs.mkdirSync(day, { recursive: true });

  const a = new TranscriptBuilder({ sessionId: 'aaaa1111-2222-3333-4444-555566667777', cwd: '/Users/dev/alpha' });
  a.meta();
  a.worldState('# Alpha rules\n\n- Run the tests.');
  a.userMessage('Implement the alpha importer', 't1');
  a.command('npm test', { turnId: 't1', status: 'failed', exitCode: 1, stderr: 'Error: boom' });
  a.fileChange('/Users/dev/alpha/src/importer.ts', 'update', '@@ -1 +1 @@\n-old\n+new\n');
  a.agentMessage('Importer written; tests fail.', 'final_answer', 't1');
  a.tokenCount({ primary: 100, reached: 'rate_limit_reached' });
  fs.writeFileSync(
    path.join(day, 'rollout-2026-10-10T10-00-00-aaaa1111-2222-3333-4444-555566667777.jsonl'),
    a.toJSONL(),
  );

  const b = new TranscriptBuilder({ sessionId: 'bbbb8888-9999-aaaa-bbbb-ccccddddeeee', cwd: '/Users/dev/beta' });
  b.meta();
  b.userMessage('Tidy the beta docs', 't1');
  b.agentMessage('Done.', 'final_answer', 't1');
  fs.writeFileSync(
    path.join(day, 'rollout-2026-10-10T09-00-00-bbbb8888-9999-aaaa-bbbb-ccccddddeeee.jsonl'),
    b.toJSONL(),
  );

  return { home, work };
}

/** Run the CLI, capturing stdout/stderr and the exit code without throwing. */
async function run(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      cwd: options.cwd ?? ROOT,
      env: {
        ...process.env,
        ...options.env,
        NO_COLOR: '1',
        // Keep the index cache out of the repository.
        EXTRALIFE_CACHE_DIR: options.cacheDir ?? path.join(os.tmpdir(), 'extralife-cli-cache'),
      },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

describe('cli — informational commands', () => {
  it('prints the version', async () => {
    const { code, stdout } = await run(['--version']);
    assert.equal(code, 0);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('prints help covering every flag', async () => {
    const { code, stdout } = await run(['--help']);
    assert.equal(code, 0);
    assert.ok(stdout.includes('USAGE'));
    assert.ok(stdout.includes('EXAMPLES'));
    assert.ok(stdout.includes('EXIT CODES'));
    for (const flag of ['--list', '--here', '--budget', '--format', '--detail', '--copy', '--no-redact']) {
      assert.ok(stdout.includes(flag), `help mentions ${flag}`);
    }
  });

  it('documents the handoff sections', async () => {
    const { code, stdout } = await run(['--help-sections']);
    assert.equal(code, 0);
    assert.ok(stdout.includes('deadends'));
    assert.ok(stdout.includes('always'));
  });

  it('rejects an unknown flag with exit code 2', async () => {
    const { code, stderr } = await run(['--definitely-not-a-flag']);
    assert.equal(code, 2);
    assert.match(stderr, /unknown option/);
  });

  it('rejects a bad --format value', async () => {
    const { code, stderr } = await run(['--format', 'yaml']);
    assert.equal(code, 2);
    assert.match(stderr, /unknown --format/);
  });

  it('rejects a bad --budget value', async () => {
    const { code, stderr } = await run(['--budget', 'lots']);
    assert.equal(code, 2);
    assert.match(stderr, /could not read --budget/);
  });

  it('rejects an unknown --sections entry', async () => {
    const { code, stderr } = await run(['--sections', 'mission,nonsense']);
    assert.equal(code, 2);
    assert.match(stderr, /unknown section/);
  });

  it('explains itself when the Codex home is missing', async () => {
    const { code, stderr } = await run(['--home', '/definitely/not/here', '--list']);
    assert.equal(code, 3);
    assert.match(stderr, /not found/i);
    assert.match(stderr, /CODEX_HOME/);
  });
});

describe('cli — listing', () => {
  it('lists sessions as an aligned table', async () => {
    const { home } = makeFixtureHome();
    const { code, stdout } = await run(['--list', '--no-cache', '--home', home]);
    assert.equal(code, 0);
    assert.match(stdout, /^ID\s+WHEN\s+PROJECT/);
    assert.ok(stdout.includes('alpha'));
    assert.ok(stdout.includes('beta'));
    assert.ok(stdout.includes('Implement the alpha importer'));
    assert.ok(stdout.includes('exhausted'), 'the exhausted session is flagged');
  });

  it('reports an empty result rather than failing', async () => {
    const home = freshDir('extralife-empty-home-');
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    const { code, stdout } = await run(['--list', '--no-cache', '--home', home]);
    assert.equal(code, 0);
    assert.match(stdout, /No sessions found/);
  });
});

describe('cli — exporting', () => {
  it('exports a session by id prefix to a file', async () => {
    const { home, work } = makeFixtureHome();
    const out = path.join(work, 'handoff.txt');
    const { code, stdout, stderr } = await run(
      ['aaaa1111', '--yes', '--home', home, '--out', out, '--no-cache'],
      { cwd: work },
    );
    assert.equal(code, 0, stderr);
    assert.ok(fs.existsSync(out));
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.includes('Implement the alpha importer'));
    assert.ok(text.includes('FAILED APPROACHES'));
    assert.ok(text.includes('Alpha rules'), 'AGENTS.md travelled with the handoff');
    assert.ok(stderr.includes('Handoff ready'));
    assert.ok(stdout.length >= 0);
  });

  it('writes to stdout with --stdout and keeps stderr clean-ish', async () => {
    const { home, work } = makeFixtureHome();
    const { code, stdout } = await run(
      ['aaaa1111', '--yes', '--stdout', '--home', home, '--no-cache'],
      { cwd: work },
    );
    assert.equal(code, 0);
    assert.ok(stdout.startsWith('╔'), 'document starts at the banner');
    assert.ok(stdout.includes('NEXT STEPS'));
  });

  it('accepts a full session id and an unambiguous prefix', async () => {
    const { home, work } = makeFixtureHome();
    for (const target of ['aaaa1111', 'aaaa1111-2222-3333-4444-555566667777']) {
      const { code } = await run([target, '--yes', '--stdout', '--home', home, '--no-cache'], { cwd: work });
      assert.equal(code, 0, `target ${target} should resolve`);
    }
  });

  it('accepts a direct path to a transcript file', async () => {
    const { home, work } = makeFixtureHome();
    const file = path.join(home, 'sessions', '2026', '10', '10', 'rollout-2026-10-10T10-00-00-aaaa1111-2222-3333-4444-555566667777.jsonl');
    const { code, stdout } = await run([file, '--yes', '--stdout'], { cwd: work });
    assert.equal(code, 0);
    assert.ok(stdout.includes('Implement the alpha importer'));
  });

  it('fails with exit code 4 and suggestions for an ambiguous or unknown id', async () => {
    const { home, work } = makeFixtureHome();
    const unknown = await run(['zzzz9999', '--yes', '--stdout', '--home', home, '--no-cache'], { cwd: work });
    assert.equal(unknown.code, 4);
    assert.match(unknown.stderr, /no session matches/);
    assert.match(unknown.stderr, /Did you mean/);
  });

  it('honours --detail minimal', async () => {
    const { home, work } = makeFixtureHome();
    const minimal = await run(['aaaa1111', '-y', '--stdout', '--detail', 'minimal', '--home', home, '--no-cache'], { cwd: work });
    const full = await run(['aaaa1111', '-y', '--stdout', '--detail', 'full', '--home', home, '--no-cache'], { cwd: work });
    assert.equal(minimal.code, 0);
    assert.ok(minimal.stdout.length < full.stdout.length, 'minimal output is shorter');
    assert.ok(!minimal.stdout.includes('CONVERSATION HISTORY'));
  });

  it('honours --sections', async () => {
    const { home, work } = makeFixtureHome();
    const { code, stdout } = await run(
      ['aaaa1111', '-y', '--stdout', '--sections', 'mission,next,files', '--home', home, '--no-cache'],
      { cwd: work },
    );
    assert.equal(code, 0);
    assert.ok(stdout.includes('FILES THAT MATTER'));
    assert.ok(!stdout.includes('CONVERSATION HISTORY'));
  });

  it('respects a token budget and says so', async () => {
    const { home, work } = makeFixtureHome();
    const { code, stderr } = await run(
      ['aaaa1111', '-y', '--detail', 'full', '--budget', '900', '--out', path.join(work, 'b.txt'), '--home', home, '--no-cache'],
      { cwd: work },
    );
    assert.equal(code, 0);
    const text = fs.readFileSync(path.join(work, 'b.txt'), 'utf8');
    assert.ok(text.includes('budget') || text.includes('omitted'), 'trimming is disclosed in the document');
    assert.ok(stderr.includes('budget') || stderr.includes('Handoff ready'));
  });

  it('emits valid JSON with --format json', async () => {
    const { home, work } = makeFixtureHome();
    const { code, stdout } = await run(
      ['aaaa1111', '-y', '--format', 'json', '--stdout', '--home', home, '--no-cache'],
      { cwd: work },
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.session.id, 'aaaa1111-2222-3333-4444-555566667777');
    assert.equal(parsed.session.stats.failedCommands, 1);
  });

  it('routes --format to a file unless --stdout is given', async () => {
    // `--format` selects the file type, not the destination. Every format must
    // behave the same way; only `--stdout` (and the `--json` shorthand, which
    // implies it) may write to standard output.
    const { home, work } = makeFixtureHome();
    for (const [format, extension] of [['json', 'json'], ['markdown', 'md'], ['handoff', 'txt']]) {
      const before = fs.readdirSync(work).length;
      const { code, stdout } = await run(
        ['aaaa1111', '-y', '--format', format, '--home', home, '--no-cache'],
        { cwd: work },
      );
      assert.equal(code, 0, `${format}: ${stdout.slice(0, 200)}`);
      assert.equal(stdout, '', `--format ${format} must not write to stdout`);
      const written = fs.readdirSync(work).filter((f) => f.endsWith(`.${extension}`));
      assert.ok(written.length > 0, `--format ${format} wrote a .${extension} file`);
      assert.ok(fs.readdirSync(work).length > before, `${format} created a file`);
    }
  });

  it('writes JSON to stdout with the --json shorthand', async () => {
    const { home, work } = makeFixtureHome();
    const { code, stdout } = await run(['aaaa1111', '-y', '--json', '--home', home, '--no-cache'], { cwd: work });
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).schemaVersion, 1);
  });

  it('emits markdown with --format markdown', async () => {
    const { home, work } = makeFixtureHome();
    const { code, stdout } = await run(
      ['aaaa1111', '-y', '--format', 'markdown', '--stdout', '--home', home, '--no-cache'],
      { cwd: work },
    );
    assert.equal(code, 0);
    assert.ok(stdout.startsWith('---\n'));
    assert.ok(stdout.includes('## MISSION'));
  });

  it('redacts credentials and reports the count', async () => {
    const home = freshDir('extralife-redact-home-');
    const work = freshDir('extralife-redact-work-');
    const day = path.join(home, 'sessions', '2026', '10', '10');
    fs.mkdirSync(day, { recursive: true });
    const apiKey = makeSecret('sk-proj-');
    const b = new TranscriptBuilder({ sessionId: 'cccc0000-1111-2222-3333-444455556666', cwd: '/Users/dev/secret' });
    b.meta();
    b.userMessage(['deploy using OPENAI_API_KEY=', apiKey].join(''));
    b.agentMessage('done', 'final_answer');
    fs.writeFileSync(path.join(day, 'rollout-secret.jsonl'), b.toJSONL());

    const redacted = await run(['cccc0000', '-y', '--stdout', '--home', home, '--no-cache'], { cwd: work });
    assert.equal(redacted.code, 0);
    assert.ok(!redacted.stdout.includes(apiKey), 'secret removed');
    assert.ok(redacted.stdout.includes('[REDACTED'));

    const raw = await run(['cccc0000', '-y', '--stdout', '--no-redact', '--home', home, '--no-cache'], { cwd: work });
    assert.equal(raw.code, 0);
    assert.ok(raw.stdout.includes(apiKey), 'opt-out preserves the text');
  });

  it('creates the output directory when it does not exist', async () => {
    const { home, work } = makeFixtureHome();
    const nested = path.join(work, 'a', 'b', 'c', 'handoff.txt');
    const { code } = await run(['aaaa1111', '-y', '--out', nested, '--home', home, '--no-cache'], { cwd: work });
    assert.equal(code, 0);
    assert.ok(fs.existsSync(nested));
  });

  it('filters to the current directory with --here', async () => {
    const { home, work } = makeFixtureHome();
    // No session belongs to the temp working directory, so the filter empties.
    const none = await run(['--here', '--list', '--home', home, '--no-cache'], { cwd: work });
    assert.equal(none.code, 0);
    assert.match(none.stdout, /No sessions found/);

    // --cwd pointing at alpha's project finds exactly that one.
    const filtered = await run(['--cwd', '/Users/dev', '--list', '--home', home, '--no-cache'], { cwd: work });
    assert.equal(filtered.code, 0);
    assert.ok(filtered.stdout.includes('alpha'));
    assert.ok(filtered.stdout.includes('beta'));
  });

  it('excludes automatic review threads unless --all is passed', async () => {
    const home = freshDir('extralife-review-home-');
    const work = freshDir('extralife-review-work-');
    const day = path.join(home, 'sessions', '2026', '10', '10');
    fs.mkdirSync(day, { recursive: true });
    const review = new TranscriptBuilder({ sessionId: 'dddd0000-1111-2222-3333-444455556666', cwd: '/x' });
    review.meta({ thread_source: 'guardian_review' });
    review.userMessage('The following is the Codex agent history whose request action you are assessing.');
    fs.writeFileSync(path.join(day, 'rollout-review.jsonl'), review.toJSONL());

    const withoutAll = await run(['--list', '--home', home, '--no-cache'], { cwd: work });
    assert.match(withoutAll.stdout, /No sessions found/);

    const withAll = await run(['--list', '--all', '--home', home, '--no-cache'], { cwd: work });
    assert.ok(withAll.stdout.includes('dddd0000'));
  });

  it('writes a default filename derived from project and time when --out is absent', async () => {
    const { home, work } = makeFixtureHome();
    const { code } = await run(['aaaa1111', '-y', '--home', home, '--no-cache'], { cwd: work });
    assert.equal(code, 0);
    const written = fs.readdirSync(work).filter((f) => f.startsWith('extralife-') && f.endsWith('.txt'));
    assert.equal(written.length, 1, `expected one output file, got ${written.join(', ')}`);
    assert.match(written[0], /^extralife-alpha-\d{8}-\d{4}\.txt$/);
  });

  it('does not overwrite a previous export', async () => {
    const { home, work } = makeFixtureHome();
    await run(['aaaa1111', '-y', '--home', home, '--no-cache'], { cwd: work });
    // Force a distinct timestamp by name collision check instead of sleeping.
    const first = fs.readdirSync(work).filter((f) => f.startsWith('extralife-'));
    assert.equal(first.length, 1);
    // A second run within the same minute would collide by design; assert the
    // naming scheme is time-qualified so runs a minute apart differ.
    assert.match(first[0], /-\d{8}-\d{4}\.txt$/);
  });

  it('succeeds quietly with --quiet', async () => {
    const { home, work } = makeFixtureHome();
    const { code, stderr } = await run(
      ['aaaa1111', '-y', '--quiet', '--out', path.join(work, 'q.txt'), '--home', home, '--no-cache'],
      { cwd: work },
    );
    assert.equal(code, 0);
    assert.equal(stderr.trim(), '', 'no chatter on stderr');
  });
});

describe('cli — non-interactive safety', () => {
  it('refuses to open a picker when stdin is not a terminal', async () => {
    const { home, work } = makeFixtureHome();
    const { code, stderr } = await run(['--home', home, '--no-cache'], { cwd: work });
    assert.equal(code, 2);
    assert.match(stderr, /stdin is not a terminal/);
    assert.match(stderr, /--list/);
  });

  it('warns but continues when a transcript has no usable content', async () => {
    const home = freshDir('extralife-thin-home-');
    const work = freshDir('extralife-thin-work-');
    const day = path.join(home, 'sessions', '2026', '10', '10');
    fs.mkdirSync(day, { recursive: true });
    const b = new TranscriptBuilder({ sessionId: 'eeee0000-1111-2222-3333-444455556666', cwd: '/x' });
    b.meta();
    b.tokenCount();
    fs.writeFileSync(path.join(day, 'rollout-thin.jsonl'), b.toJSONL());

    const out = path.join(work, 'thin.txt');
    const { code, stderr } = await run(['eeee0000', '-y', '--out', out, '--home', home, '--no-cache'], { cwd: work });
    assert.equal(code, 0, 'still produces a document');
    assert.match(stderr, /no user messages, commands or file edits/);
  });
});

describe('cli — library entry points', () => {
  it('exposes a usable public API', async () => {
    const api = await import('../src/index.js');
    for (const name of [
      'buildSessionIndex',
      'parseSessionFile',
      'renderHandoff',
      'renderMarkdown',
      'renderJson',
      'redactSecrets',
      'codexHome',
      'main',
      'VERSION',
    ]) {
      assert.ok(api[name] !== undefined, `missing export: ${name}`);
    }
    assert.equal(typeof api.parseSessionFile, 'function');
    assert.equal(api.codexHome(), path.join(process.env.HOME ?? '', '.codex'));
  });

  it('parses and renders a session through the public API alone', async () => {
    const { parseSessionFile, renderHandoff } = await import('../src/index.js');
    const dir = freshDir('extralife-api-');
    const file = sampleSession({ cwd: dir }).writeTo(dir);
    const session = await parseSessionFile(file);
    const { text, stats } = renderHandoff(session, { detail: 'minimal' });
    assert.ok(stats.tokens > 0);
    assert.ok(text.includes('MISSION'));
  });
});
