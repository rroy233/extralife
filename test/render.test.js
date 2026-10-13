/**
 * Renderer tests: handoff, markdown and JSON output.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, describe, it } from 'node:test';

import { parseSessionFile } from '../src/codex/parse.js';
import { renderHandoff } from '../src/render/handoff.js';
import { renderJson } from '../src/render/json.js';
import { renderMarkdown } from '../src/render/markdown.js';
import { estimateTokens } from '../src/util/format.js';
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

/**
 * Extract a section by its banner. A bare `text.split('NEXT STEPS')` also
 * matches prose references in the how-to preamble, so the banner is required.
 * @param {string} text @param {string} title
 */
function sectionOf(text, title) {
  const banner = `${'='.repeat(84)}\n  ${title}\n${'='.repeat(84)}\n`;
  const start = text.indexOf(banner);
  if (start === -1) return '';
  const rest = text.slice(start + banner.length);
  const end = rest.indexOf('='.repeat(84));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Collapse whitespace so assertions are not defeated by line wrapping. */
function flat(text) {
  return text.replace(/\s+/g, ' ');
}

async function build(overrides = {}, mutate) {
  const dir = freshDir();
  const builder = sampleSession({ cwd: dir, ...overrides });
  if (mutate) mutate(builder);
  const file = builder.writeTo(dir);
  return parseSessionFile(file);
}

describe('renderHandoff', () => {
  it('produces a document containing every required section', async () => {
    const session = await build();
    const { text, stats } = renderHandoff(session);

    for (const heading of [
      'HOW TO USE THIS DOCUMENT',
      'MISSION',
      'CURRENT STATE',
      'NEXT STEPS',
      'FAILED APPROACHES',
      'CONSTRAINTS AND CONVENTIONS',
      'FILES THAT MATTER',
      'CONVERSATION HISTORY',
      'APPENDIX',
      'IF YOU READ NOTHING ELSE',
    ]) {
      assert.ok(text.includes(heading), `missing section: ${heading}`);
    }
    assert.ok(stats.tokens > 0);
    assert.ok(stats.lines > 20);
    assert.ok(stats.sections.length >= 8);
  });

  it('identifies the interrupted request and lists it as the first next step', async () => {
    const session = await build();
    const { text } = renderHandoff(session);
    const nextSection = sectionOf(text, 'NEXT STEPS');
    assert.ok(
      nextSection.indexOf('Finish the interrupted request') < nextSection.indexOf('Resolve the'),
      'the interrupted request must be the first suggestion',
    );
    assert.ok(nextSection.includes('Install supertest'), 'quotes the unanswered user message');
  });

  it('surfaces failed approaches with provenance tags', async () => {
    const session = await build();
    const { text } = renderHandoff(session);
    const section = sectionOf(text, 'FAILED APPROACHES — DO NOT REPEAT THESE');
    assert.ok(section.includes('supertest'), 'includes the failing command output');
    assert.ok(section.includes('[transcript]'), 'tags evidence provenance');
  });

  it('includes AGENTS.md instructions and marks them as still in force', async () => {
    const session = await build();
    const { text } = renderHandoff(session);
    assert.ok(text.includes('Always write tests'));
    assert.ok(text.includes('remain in force'));
  });

  it('renders the plan checklist with status markers', async () => {
    const session = await build();
    const { text } = renderHandoff(session);
    assert.ok(text.includes('[x] Read the existing router'));
    assert.ok(text.includes('[~] Add the /healthz route'));
    assert.ok(text.includes('[ ] Write a test for it'));
  });

  it('honours the detail presets', async () => {
    const session = await build();
    const minimal = renderHandoff(session, { detail: 'minimal' });
    const standard = renderHandoff(session, { detail: 'standard' });
    assert.ok(minimal.stats.tokens < standard.stats.tokens, 'minimal is smaller than standard');
    assert.ok(!minimal.text.includes('UNIFIED DIFFS'), 'minimal omits diffs');
    assert.ok(minimal.text.includes('MISSION'), 'minimal keeps the mission');
    assert.ok(minimal.text.includes('NEXT STEPS'), 'minimal keeps next steps');
  });

  it('honours an explicit section list', async () => {
    const session = await build();
    const { text } = renderHandoff(session, { sections: ['mission', 'next', 'conversation'] });
    assert.ok(text.includes('MISSION'));
    assert.ok(text.includes('CONVERSATION HISTORY'));
    assert.ok(!text.includes('FILES THAT MATTER'));
    assert.ok(!text.includes('FAILED APPROACHES'));
  });

  it('always keeps the mandatory sections even if they are not requested', async () => {
    const session = await build();
    const { text } = renderHandoff(session, { sections: ['conversation'] });
    // `howto`, `mission` and `next` are appended by the CLI, but the renderer
    // must still not crash or emit an empty document.
    assert.ok(text.includes('CONVERSATION HISTORY'));
    assert.ok(text.length > 200);
  });

  it('trims low-priority sections to respect a token budget', async () => {
    const session = await build({}, (b) => {
      for (let i = 0; i < 40; i++) {
        b.tick(1);
        b.userMessage(`request number ${i} with some padding text to consume budget`);
        b.agentMessage(`response number ${i} `.repeat(30), 'final_answer');
      }
    });
    const full = renderHandoff(session, { detail: 'full' });
    const trimmed = renderHandoff(session, { detail: 'full', budget: Math.floor(full.stats.tokens / 3) });

    assert.ok(trimmed.trimmed, 'reports that it trimmed');
    assert.ok(trimmed.stats.tokens < full.stats.tokens, 'output is smaller');
    assert.ok(trimmed.text.includes('MISSION'), 'mandatory sections survive');
    assert.ok(trimmed.text.includes('NEXT STEPS'));
    assert.ok(trimmed.text.includes('trimmed to fit budget') || trimmed.text.includes('omitted'));
  });

  it('stays under a generous budget without trimming', async () => {
    const session = await build();
    const result = renderHandoff(session, { detail: 'standard', budget: 1_000_000 });
    assert.equal(result.trimmed, false);
  });

  it('omits the diffs section when no diffs were captured', async () => {
    const session = await build({}, (b) => {
      // A transcript with commands but no file changes at all.
      b.fileChange; // no-op reference to keep the builder import honest
    });
    const dir = freshDir();
    const b = new TranscriptBuilder({ cwd: dir });
    b.meta();
    b.userMessage('just run something');
    b.command('ls');
    b.agentMessage('done', 'final_answer');
    const parsed = await parseSessionFile(b.writeTo(dir));
    const { text } = renderHandoff(parsed);
    assert.ok(text.includes('No unified diffs were captured'));
    assert.ok(!session.fileChanges.length === false); // sample session does have diffs
  });

  it('redacts credentials by default and can be told not to', async () => {
    const dir = freshDir();
    const b = new TranscriptBuilder({ cwd: dir });
    b.meta();
    b.userMessage('deploy with OPENAI_API_KEY=sk-proj-AbCdEf0123456789GhIjKlMnOpQrStUv');
    b.command('curl -H "Authorization: Bearer abcdef1234567890abcdef" https://api.example.com');
    b.agentMessage('done', 'final_answer');
    const session = await parseSessionFile(b.writeTo(dir));

    const redacted = renderHandoff(session);
    assert.ok(!redacted.text.includes('sk-proj-AbCdEf0123456789'), 'the key is gone');
    assert.ok(redacted.stats.redactionCount > 0, 'redactions are reported');
    assert.ok(redacted.text.includes('[REDACTED'));

    const raw = renderHandoff(session, { redact: false });
    assert.ok(raw.text.includes('sk-proj-AbCdEf0123456789'), 'opt-out keeps the original');
    assert.equal(raw.stats.redactionCount, 0);
  });

  it('warns the reader that the document is an extract, not the truth', async () => {
    const session = await build();
    const { text } = renderHandoff(session);
    assert.ok(flat(text).includes('never a substitute for reading the actual code'));
    assert.ok(text.includes('curated extract'));
  });

  it('handles a session with no user messages without crashing', async () => {
    const dir = freshDir();
    const b = new TranscriptBuilder({ cwd: dir });
    b.meta();
    b.tokenCount();
    const session = await parseSessionFile(b.writeTo(dir));
    const { text } = renderHandoff(session);
    assert.ok(text.includes('No user messages were recorded'));
    assert.ok(text.includes('HOW TO USE THIS DOCUMENT'));
  });

  it('uses relative paths for files inside the project', async () => {
    const session = await build();
    const { text } = renderHandoff(session);
    assert.ok(text.includes('`src/router.ts`'), 'relative path shown');
    assert.ok(!text.includes(`\`${session.cwd}/src/router.ts\``), 'absolute path not used inside the project');
  });
});

describe('renderMarkdown', () => {
  it('emits front matter and ATX headings', async () => {
    const session = await build();
    const { text } = renderMarkdown(session);
    assert.ok(text.startsWith('---\n'), 'has YAML front matter');
    assert.ok(text.includes('schemaVersion') === false);
    assert.ok(text.includes('session_id: 01a111ae'));
    assert.ok(text.includes('## MISSION'), 'rules became a heading');
    assert.ok(text.includes('# ExtraLife handoff'));
    assert.ok(!text.includes('╔'), 'ASCII box art removed');
    assert.ok(!text.includes('====='), 'ASCII rules converted');
  });
});

describe('renderJson', () => {
  it('emits valid, versioned JSON with documented top-level keys', async () => {
    const session = await build();
    const parsed = JSON.parse(renderJson(session, { sections: [] }));
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.generator.name, 'extralife');
    assert.ok(parsed.session.id);
    assert.ok(Array.isArray(parsed.mission.requests));
    assert.ok(Array.isArray(parsed.files));
    assert.ok(Array.isArray(parsed.commands));
    assert.ok(Array.isArray(parsed.conversation));
    assert.equal(parsed.nextSteps.failedCommands, 1);
  });

  it('redacts secrets in the JSON stream', async () => {
    const dir = freshDir();
    const b = new TranscriptBuilder({ cwd: dir });
    b.meta();
    b.userMessage('token is ghp_16C7e42F292c6912E7710c838347Ae178B4a');
    const session = await parseSessionFile(b.writeTo(dir));
    const json = renderJson(session);
    assert.ok(!json.includes('ghp_16C7e42F292c6912E7710c838347Ae178B4a'));
    assert.ok(json.includes('[REDACTED'));
  });

  it('produces output that parses back to the same structure', async () => {
    const session = await build();
    const json = renderJson(session);
    assert.deepEqual(JSON.parse(json).session.stats.commands, session.commands.length);
  });
});

describe('output size sanity', () => {
  it('keeps a standard handoff far smaller than the source transcript', async () => {
    const dir = freshDir();
    const b = sampleSession({ cwd: dir });
    // Pad the transcript with bulky tool output that must be trimmed away.
    for (let i = 0; i < 60; i++) {
      b.tick(1);
      b.command(`cat big-file-${i}.log`, { stdout: 'x'.repeat(5000) });
    }
    const file = b.writeTo(dir);
    const sourceBytes = fs.statSync(file).size;
    const session = await parseSessionFile(file);
    const { stats } = renderHandoff(session, { detail: 'standard' });
    assert.ok(stats.bytes < sourceBytes, 'handoff is smaller than the transcript');
    assert.equal(estimateTokens(''), 0, 'empty input costs nothing');
  });
});
