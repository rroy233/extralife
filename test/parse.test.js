/**
 * Parser tests.
 *
 * These use synthetic transcripts so they are deterministic and do not read the
 * machine's private `~/.codex` data. The cases mirror the real-world variants
 * the parser must survive: duplicated channels, injected user text, legacy
 * transcripts, malformed lines, compressed files and unknown future events.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import {
  fileUrlToPath,
  isInjectedUserText,
  parseApplyPatch,
  parsePlanArguments,
  parseSessionFile,
} from '../src/codex/parse.js';
import { parseHead, parseTail } from '../src/codex/locate.js';
import { sampleSession, tempDir, TranscriptBuilder } from './helpers/fixture.js';

const dirs = [];
function freshDir() {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseSessionFile — core extraction', () => {
  it('extracts messages, commands, file changes, plans and quota', async () => {
    const dir = freshDir();
    const file = sampleSession({ cwd: dir }).writeTo(dir);
    const session = await parseSessionFile(file);

    assert.equal(session.cwd, dir);
    assert.equal(session.git.branch, 'main');
    assert.equal(session.messages.filter((m) => m.role === 'user').length, 2);
    assert.equal(session.commands.length, 3);
    assert.equal(session.fileChanges.length, 1);
    assert.equal(session.fileChanges[0].kind, 'update');
    assert.equal(session.fileChanges[0].path, `${dir}/src/router.ts`);
    assert.ok(session.fileChanges[0].diff.includes('/healthz'));
    assert.equal(session.plans.length, 1);
    assert.equal(session.plans[0].steps.length, 3);
    assert.equal(session.usage.total_tokens, 9000);
    assert.equal(session.contextWindow, 258400);
  });

  it('de-duplicates messages present in both event_msg and response_item', async () => {
    const dir = freshDir();
    const b = new TranscriptBuilder({ cwd: dir });
    b.meta();
    b.userMessage('hello');
    b.agentMessage('hi there');
    const file = b.writeTo(dir);
    const session = await parseSessionFile(file);

    assert.equal(session.messages.length, 2, 'exactly one user and one assistant message');
    assert.equal(session.messages.filter((m) => m.role === 'assistant').length, 1);
  });

  it('drops injected user text instead of treating it as a request', async () => {
    const dir = freshDir();
    const b = new TranscriptBuilder({ cwd: dir });
    b.meta();
    b.injectedUser('<environment_context>\n  <current_date>2026-10-10</current_date>\n</environment_context>');
    b.injectedUser('# AGENTS.md instructions for /Users/dev/project\n\n<INSTRUCTIONS>\nBe nice.\n</INSTRUCTIONS>');
    b.injectedUser('<codex_internal_context source="goal">\n<objective>\nShip the feature.\n</objective>\n</codex_internal_context>');
    b.userMessage('the real request');
    const file = b.writeTo(dir);
    const session = await parseSessionFile(file);

    assert.equal(session.messages.filter((m) => m.role === 'user').length, 1);
    assert.equal(session.messages.find((m) => m.role === 'user').text, 'the real request');
    assert.equal(session.threadGoal, 'Ship the feature.');
  });

  it('records failed commands with their error output', async () => {
    const dir = freshDir();
    const file = sampleSession({ cwd: dir }).writeTo(dir);
    const session = await parseSessionFile(file);
    const failed = session.commands.filter((c) => c.status === 'failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].exitCode, 1);
    assert.ok(failed[0].stderr.includes('supertest'));
  });

  it('reads the working directory from a file:// URI, including percent-encoding', async () => {
    const dir = freshDir();
    const b = new TranscriptBuilder({ cwd: dir });
    b.meta();
    b.command('ls', { cwd: 'file:///Users/dev/my%20project' });
    const file = b.writeTo(dir);
    const session = await parseSessionFile(file);
    assert.equal(session.commands[0].cwd, '/Users/dev/my project');
  });

  it('survives malformed lines, blank lines and unknown event types', async () => {
    const dir = freshDir();
    const b = new TranscriptBuilder({ cwd: dir });
    b.meta();
    b.unknownEvent();
    b.userMessage('still works');
    const raw = b.toJSONL();
    const file = path.join(dir, 'broken.jsonl');
    // Interleave junk that a real file can contain after a partial write.
    fs.writeFileSync(file, `${raw}{"truncated": \n\nnot json at all\n${raw}`, 'utf8');

    const session = await parseSessionFile(file);
    assert.ok(session.messages.some((m) => m.text === 'still works'));
    assert.ok(session.stats.skippedLines >= 2, 'junk lines are counted, not fatal');
  });

  it('parses a zstd-compressed transcript identically to the plain one', async () => {
    const dir = freshDir();
    const plain = sampleSession({ cwd: dir }).writeTo(dir, 'rollout-plain.jsonl');
    const compressed = path.join(dir, 'rollout-plain.jsonl.zst');
    fs.writeFileSync(compressed, zstdCompressSync(fs.readFileSync(plain)));

    const [a, b] = await Promise.all([parseSessionFile(plain), parseSessionFile(compressed)]);
    assert.deepEqual(a.messages, b.messages);
    assert.deepEqual(a.commands, b.commands);
    assert.deepEqual(a.fileChanges, b.fileChanges);
  });

  it('tolerates an empty file', async () => {
    const dir = freshDir();
    const file = path.join(dir, 'rollout-empty.jsonl');
    fs.writeFileSync(file, '');
    const session = await parseSessionFile(file);
    assert.equal(session.messages.length, 0);
    assert.equal(session.commands.length, 0);
  });
});

describe('parseSessionFile — legacy transcripts', () => {
  it('falls back to response_item messages when item_completed is absent', async () => {
    const dir = freshDir();
    const b = new TranscriptBuilder({ cwd: dir });
    b.meta();
    b.injectedUser('<user_instructions>ignore me</user_instructions>');
    b.push('response_item', {
      type: 'message',
      id: 'u1',
      role: 'user',
      content: [{ type: 'input_text', text: 'legacy user request' }],
    });
    b.legacyAssistant('legacy assistant reply');
    const file = b.writeTo(dir);
    const session = await parseSessionFile(file);

    assert.equal(session.messages.filter((m) => m.role === 'user').length, 1);
    assert.equal(session.messages.find((m) => m.role === 'user').text, 'legacy user request');
    assert.ok(session.messages.some((m) => m.role === 'assistant' && m.text === 'legacy assistant reply'));
    assert.equal(session.turns.length, 1, 'a turn is synthesised from raw messages');
  });

  it('recovers user messages preserved inside a compaction record', async () => {
    const dir = freshDir();
    const b = new TranscriptBuilder({ cwd: dir });
    b.meta();
    b.compacted('', [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a request from before the trim' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'an old reply' }] },
    ]);
    b.userMessage('a request after the trim');
    const file = b.writeTo(dir);
    const session = await parseSessionFile(file);

    const userTexts = session.messages.filter((m) => m.role === 'user').map((m) => m.text);
    assert.ok(userTexts.includes('a request from before the trim'));
    assert.ok(userTexts.includes('a request after the trim'));
    assert.ok(!userTexts.includes('an old reply'), 'assistant text is not smuggled in as a user message');
  });

  it('captures a readable compaction summary when one exists', async () => {
    const dir = freshDir();
    const b = new TranscriptBuilder({ cwd: dir });
    b.meta();
    b.compacted('We refactored the config loader and fixed the retry loop.');
    const file = b.writeTo(dir);
    const session = await parseSessionFile(file);
    assert.match(session.compactionSummary, /refactored the config loader/);
  });

  it('recovers file edits from an apply_patch tool call', async () => {
    const dir = freshDir();
    const b = new TranscriptBuilder({ cwd: dir });
    b.meta();
    b.applyPatch(
      '*** Begin Patch\n' +
        `*** Update File: ${dir}/src/app.ts\n` +
        '@@\n-old line\n+new line\n' +
        '*** Add File: /tmp/brand-new.txt\n' +
        '+hello\n' +
        '*** End Patch\n',
    );
    const file = b.writeTo(dir);
    const session = await parseSessionFile(file);

    assert.equal(session.fileChanges.length, 2);
    assert.equal(session.fileChanges[0].path, `${dir}/src/app.ts`);
    assert.equal(session.fileChanges[0].kind, 'update');
    assert.equal(session.fileChanges[1].kind, 'add');
  });

  it('takes plan steps from update_plan arguments', async () => {
    const dir = freshDir();
    const b = new TranscriptBuilder({ cwd: dir });
    b.meta();
    b.planSteps([
      { step: 'first', status: 'completed' },
      { step: 'second', status: 'pending' },
    ]);
    const file = b.writeTo(dir);
    const session = await parseSessionFile(file);
    assert.equal(session.plans.length, 1);
    assert.deepEqual(session.plans[0].steps, [
      { step: 'first', status: 'completed' },
      { step: 'second', status: 'pending' },
    ]);
  });
});

describe('parseSessionFile — turn pairing', () => {
  it('pairs each user request with the agent outcome', async () => {
    const dir = freshDir();
    const b = new TranscriptBuilder({ cwd: dir });
    b.meta();
    b.userMessage('do the first thing', 't1');
    b.push('event_msg', { type: 'task_started', turn_id: 't1', started_at: 1_700_000_000 });
    b.agentMessage('did the first thing', 'final_answer', 't1');
    b.push('event_msg', { type: 'task_complete', turn_id: 't1', completed_at: 1_700_000_060, last_agent_message: 'did the first thing' });
    b.userMessage('do the second thing', 't2');
    b.push('event_msg', { type: 'task_started', turn_id: 't2', started_at: 1_700_000_100 });
    const file = b.writeTo(dir);
    const session = await parseSessionFile(file);

    assert.equal(session.turns.length, 2);
    assert.equal(session.turns[0].userText, 'do the first thing');
    assert.equal(session.turns[0].finalText, 'did the first thing');
    assert.equal(session.turns[1].userText, 'do the second thing');
    assert.equal(session.turns[1].finalText, '', 'the interrupted turn has no answer');
  });
});

describe('parseApplyPatch', () => {
  it('splits a multi-file patch into typed changes', () => {
    const changes = parseApplyPatch(
      '*** Begin Patch\n' +
        '*** Update File: /a/one.ts\n@@\n-x\n+y\n' +
        '*** Add File: /a/two.ts\n+content\n' +
        '*** Delete File: /a/three.ts\n' +
        '*** End Patch\n',
    );
    assert.deepEqual(changes.map((c) => [c.kind, c.path]), [
      ['update', '/a/one.ts'],
      ['add', '/a/two.ts'],
      ['delete', '/a/three.ts'],
    ]);
    assert.ok(changes[0].diff.includes('-x'));
  });

  it('returns nothing for non-patch input', () => {
    assert.deepEqual(parseApplyPatch('just some text'), []);
    assert.deepEqual(parseApplyPatch(''), []);
    assert.deepEqual(parseApplyPatch(null), []);
  });

  it('handles a patch that is missing its End marker', () => {
    const changes = parseApplyPatch('*** Begin Patch\n*** Add File: /a/x.ts\n+body\n');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, '/a/x.ts');
  });
});

describe('parsePlanArguments', () => {
  it('accepts the documented shape', () => {
    const steps = parsePlanArguments('{"plan":[{"step":"a","status":"pending"}]}');
    assert.deepEqual(steps, [{ step: 'a', status: 'pending' }]);
  });

  it('accepts a bare array and defaults a missing status', () => {
    assert.deepEqual(parsePlanArguments('["a","b"]'), [
      { step: 'a', status: 'pending' },
      { step: 'b', status: 'pending' },
    ]);
  });

  it('returns nothing for malformed JSON', () => {
    assert.deepEqual(parsePlanArguments('{not json'), []);
    assert.deepEqual(parsePlanArguments(undefined), []);
  });
});

describe('isInjectedUserText', () => {
  it('recognises every wrapper observed in real transcripts', () => {
    const injected = [
      '<environment_context>',
      '<codex_internal_context source="goal">',
      '<external_codex_apps_open_page>',
      '<recommended_plugins>',
      '<realtime_delegation>',
      '<subagent_notification>',
      '<turn_aborted>',
      '<user_instructions>',
      '# AGENTS.md instructions for /x',
      '# Files mentioned by the user:',
      'The following is the Codex agent history',
    ];
    for (const text of injected) {
      assert.equal(isInjectedUserText(text), true, `should be injected: ${text.slice(0, 40)}`);
    }
  });

  it('does not flag genuine user text', () => {
    const real = [
      'Fix the failing test',
      'why does this break?',
      'AGENTS.md should document the build',
      'please add <div> handling',
    ];
    for (const text of real) {
      assert.equal(isInjectedUserText(text), false, `should be real: ${text}`);
    }
  });

  it('treats empty and whitespace-only text as not a user message', () => {
    assert.equal(isInjectedUserText(''), true);
    assert.equal(isInjectedUserText('   \n  '), true);
    assert.equal(isInjectedUserText(null), true);
  });
});

describe('fileUrlToPath', () => {
  it('decodes file URLs and passes plain paths through', () => {
    assert.equal(fileUrlToPath('file:///Users/a/b'), '/Users/a/b');
    assert.equal(fileUrlToPath('file:///Users/my%20dir/b'), '/Users/my dir/b');
    assert.equal(fileUrlToPath('/already/a/path'), '/already/a/path');
    assert.equal(fileUrlToPath(undefined), '');
  });
});

describe('parseHead / parseTail (index windows)', () => {
  it('reads meta and the first genuine user message from the head window', () => {
    const b = new TranscriptBuilder({ cwd: '/tmp/proj' });
    b.meta();
    b.injectedUser('<environment_context>x</environment_context>');
    b.userMessage('the first real request');
    const { meta, firstUserMessage } = parseHead(b.toJSONL());
    assert.equal(meta.cwd, '/tmp/proj');
    assert.equal(firstUserMessage, 'the first real request');
  });

  it('reads the newest rate limit from the tail window', () => {
    const b = new TranscriptBuilder({ cwd: '/tmp/proj' });
    b.meta();
    b.tokenCount({ primary: 10 });
    b.tokenCount({ primary: 99, secondary: 55, reached: 'rate_limit_reached' });
    const { lastTokenCount } = parseTail(b.toJSONL());
    assert.equal(lastTokenCount.rate_limits.primary.used_percent, 99);
    assert.equal(lastTokenCount.rate_limits.rate_limit_reached_type, 'rate_limit_reached');
  });

  it('ignores a truncated final line in the head window', () => {
    const b = new TranscriptBuilder({ cwd: '/tmp/proj' });
    b.meta();
    const truncated = b.toJSONL() + '{"timestamp":"2026-01-01","ordinal":9,"type":"resp';
    const { meta } = parseHead(truncated);
    assert.equal(meta.cwd, '/tmp/proj', 'the good line still parses');
  });
});
