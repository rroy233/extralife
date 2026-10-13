/**
 * Tests for the two ExtraLife-specific screens: the session picker and the
 * export-options form.
 *
 * These drive the real screens with synthetic keystrokes and assert on the
 * rendered frame, so navigation, live enrichment and the token estimate are all
 * verified without a human at a keyboard.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickSession, summarizeSession } from '../src/ui/picker.js';
import { BUDGET_STEPS, exportOptionsScreen, PRESET_SECTIONS, SECTION_CATALOGUE } from '../src/ui/options.js';
import { createTestTerminal, readScreen, settle } from './helpers/tui-harness.js';
import { confirmPrompt, listPrompt, textPrompt } from '../src/ui/prompts.js';
import { displayWidth, stripAnsi } from '../src/util/ansi.js';

/** @returns {any} a picker entry */
function entry(overrides = {}) {
  return {
    file: `/tmp/rollout-${overrides.id ?? 'a'}.jsonl`,
    id: overrides.id ?? 'aaaa1111-2222-3333-4444-555566667777',
    title: overrides.title ?? 'Implement the importer',
    cwd: overrides.cwd ?? '/Users/dev/alpha',
    projectLabel: overrides.projectLabel ?? 'alpha',
    mtimeMs: Date.now(),
    sizeBytes: overrides.sizeBytes ?? 2_500_000,
    lastActivityMs: overrides.lastActivityMs ?? Date.now() - 3_600_000,
    cliVersion: '0.162.0',
    originator: 'Codex CLI',
    threadSource: 'user',
    gitBranch: overrides.gitBranch ?? 'main',
    archived: false,
    interactive: true,
    exhaustedReason: overrides.exhaustedReason,
    primaryUsedPercent: overrides.primaryUsedPercent ?? 42,
    secondaryUsedPercent: overrides.secondaryUsedPercent ?? 18,
    resetsAtMs: overrides.resetsAtMs,
    planType: 'plus',
    contextWindow: 258_400,
    totalTokens: 9000,
    preview: overrides.preview ?? 'Implement the importer so that it handles CSV',
  };
}

const SAMPLE_ENTRIES = [
  entry({ id: 'aaaa1111', title: 'Implement the alpha importer', projectLabel: 'alpha' }),
  entry({ id: 'bbbb2222', title: 'Fix the beta parser bug', projectLabel: 'beta', gitBranch: 'fix/parser' }),
  entry({
    id: 'cccc3333',
    title: 'Ship the gamma feature',
    projectLabel: 'gamma',
    gitBranch: '',
    exhaustedReason: 'weekly limit reached',
    primaryUsedPercent: 100,
    resetsAtMs: Date.now() + 86_400_000 * 3,
  }),
];

describe('pickSession', () => {
  it('renders every session with its project and title', async () => {
    const { term, stdout } = createTestTerminal();
    const promise = pickSession(term, SAMPLE_ENTRIES);
    await settle();
    const screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('choose a session'));
    assert.ok(screen.contains('alpha'));
    assert.ok(screen.contains('Implement the alpha importer'));
    assert.ok(screen.contains('Ship the gamma feature'));
    // Clean up by cancelling.
    term._keyHandlers.forEach((h) => h({ name: 'ctrl-c', ctrl: true, alt: false, shift: false }));
    assert.equal(await promise, null);
  });

  it('marks an exhausted session distinctly', async () => {
    const { term, stdin, stdout } = createTestTerminal();
    const promise = pickSession(term, SAMPLE_ENTRIES);
    await settle();
    assert.ok(readScreen(stdout, 110, 34).contains('💀'), 'exhaustion badge shown in the list');

    // The exhausted entry is third, so move the highlight onto it to check the
    // detail pane.
    stdin.send('\u001b[B\u001b[B');
    await settle();
    const screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('weekly limit reached'), 'reason shown in the detail pane');
    assert.ok(screen.contains('exhausted'));
    term._keyHandlers.forEach((h) => h({ name: 'ctrl-c', ctrl: true, alt: false, shift: false }));
    await promise;
  });

  it('returns the highlighted session on enter', async () => {
    const { term, stdin } = createTestTerminal();
    const promise = pickSession(term, SAMPLE_ENTRIES);
    await settle();
    stdin.send('\u001b[B'); // down to the second entry
    await settle();
    stdin.send('\r');
    const chosen = await promise;
    assert.equal(chosen.id, 'bbbb2222');
  });

  it('filters by project name', async () => {
    const { term, stdin, stdout } = createTestTerminal();
    const promise = pickSession(term, SAMPLE_ENTRIES);
    await settle();
    stdin.send('gamma');
    await settle();
    const screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('Ship the gamma feature'));
    assert.ok(!screen.contains('Implement the alpha importer'));
    stdin.send('\r');
    assert.equal((await promise).id, 'cccc3333');
  });

  it('filters by title keyword', async () => {
    const { term, stdin, stdout } = createTestTerminal();
    const promise = pickSession(term, SAMPLE_ENTRIES);
    await settle();
    stdin.send('parser');
    await settle();
    assert.ok(readScreen(stdout, 110, 34).contains('Fix the beta parser bug'));
    stdin.send('\r');
    assert.equal((await promise).id, 'bbbb2222');
  });

  it('shows the detail pane with quota and activity', async () => {
    const { term, stdout } = createTestTerminal();
    const promise = pickSession(term, SAMPLE_ENTRIES);
    await settle();
    const screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('cwd'), 'detail pane present');
    assert.ok(screen.contains('/Users/dev/alpha'));
    assert.ok(screen.contains('quota'));
    assert.ok(screen.contains('first ask'));
    term._keyHandlers.forEach((h) => h({ name: 'ctrl-c', ctrl: true, alt: false, shift: false }));
    await promise;
  });

  it('enriches the highlighted session from a background parse', async () => {
    const { term, stdout } = createTestTerminal();
    const promise = pickSession(term, SAMPLE_ENTRIES, {
      enrich: async () => ({
        messages: 320,
        turns: 73,
        fileChanges: 450,
        commands: 665,
        failedCommands: 97,
        plans: 4,
        totalTokens: 167_000_000,
        topFiles: ['src/importer.ts', 'src/parser.ts'],
      }),
    });
    await settle(300); // allow the debounce + async work to complete
    const screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('320 messages'), 'message count shown');
    assert.ok(screen.contains('73 turns'));
    assert.ok(screen.contains('97 failed'), 'failed command count shown');
    assert.ok(screen.contains('src/importer.ts'), 'top files shown');
    term._keyHandlers.forEach((h) => h({ name: 'ctrl-c', ctrl: true, alt: false, shift: false }));
    await promise;
  });

  it('survives an enrichment failure and shows the reason', async () => {
    const { term, stdout } = createTestTerminal();
    const promise = pickSession(term, SAMPLE_ENTRIES, {
      enrich: async () => {
        throw new Error('transcript is corrupt');
      },
    });
    await settle(300);
    const screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('could not parse'), 'failure is reported, not swallowed');
    term._keyHandlers.forEach((h) => h({ name: 'ctrl-c', ctrl: true, alt: false, shift: false }));
    assert.equal(await promise, null);
  });

  it('returns null when cancelled', async () => {
    const { term, stdin } = createTestTerminal();
    const promise = pickSession(term, SAMPLE_ENTRIES);
    await settle();
    stdin.send('\u001b');
    await settle(80);
    stdin.send('\u001b');
    await settle(80);
    assert.equal(await promise, null);
  });

  it('copes with an empty list', async () => {
    const { term } = createTestTerminal();
    assert.equal(await pickSession(term, []), null);
  });

  it('stays inside a narrow terminal', async () => {
    const { term, stdout } = createTestTerminal({ columns: 60, rows: 20 });
    const promise = pickSession(term, SAMPLE_ENTRIES);
    await settle();
    const screen = readScreen(stdout, 60, 20);
    // Every rendered line must fit the terminal width, measured in columns so
    // that CJK text is accounted for correctly.
    for (const line of screen.lines()) {
      assert.ok(displayWidth(line) <= 60, `line overflows: ${JSON.stringify(line)}`);
    }
    term._keyHandlers.forEach((h) => h({ name: 'ctrl-c', ctrl: true, alt: false, shift: false }));
    await promise;
  });
});

describe('summarizeSession', () => {
  it('counts activity and relativises the top files', () => {
    const session = {
      cwd: '/Users/dev/alpha',
      messages: [{}, {}, {}],
      turns: [{}, {}],
      fileChanges: [
        { path: '/Users/dev/alpha/src/a.ts' },
        { path: '/Users/dev/alpha/src/a.ts' },
        { path: '/Users/dev/alpha/src/b.ts' },
        { path: '/elsewhere/c.ts' },
      ],
      commands: [{ status: 'completed' }, { status: 'failed' }],
      plans: [{}],
      usage: { total_tokens: 1234 },
    };
    const summary = summarizeSession(session, session.cwd);
    assert.equal(summary.messages, 3);
    assert.equal(summary.turns, 2);
    assert.equal(summary.fileChanges, 4);
    assert.equal(summary.failedCommands, 1);
    assert.equal(summary.totalTokens, 1234);
    assert.ok(summary.topFiles.includes('src/a.ts×2'), `got ${JSON.stringify(summary.topFiles)}`);
    assert.ok(summary.topFiles.some((f) => f.includes('b.ts')));
  });

  it('handles a session with no activity', () => {
    const summary = summarizeSession(
      { cwd: '', messages: [], turns: [], fileChanges: [], commands: [], plans: [] },
      '',
    );
    assert.equal(summary.messages, 0);
    assert.deepEqual(summary.topFiles, []);
  });
});

describe('exportOptionsScreen', () => {
  const sectionTokens = Object.fromEntries(
    SECTION_CATALOGUE.map((section, index) => [section.id, (index + 1) * 100]),
  );
  const session = { title: 'Implement the importer', projectLabel: 'alpha', cwd: '/Users/dev/alpha' };

  it('renders every section with its token cost and a live estimate', async () => {
    const { term, stdout } = createTestTerminal();
    const promise = exportOptionsScreen(term, { session, sectionTokens, documentTokens: 0, documentBytes: 0 });
    await settle();
    const screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('export options'));
    assert.ok(screen.contains('Mission & original request'));
    assert.ok(screen.contains('Failed approaches'));
    assert.ok(screen.contains('estimated'), 'live estimate shown');
    term._keyHandlers.forEach((h) => h({ name: 'ctrl-c', ctrl: true, alt: false, shift: false }));
    assert.equal(await promise, null);
  });

  it('marks mandatory sections as always included', async () => {
    const { term, stdout } = createTestTerminal();
    const promise = exportOptionsScreen(term, { session, sectionTokens, documentTokens: 0, documentBytes: 0 });
    await settle();
    const screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('(always)'), 'mandatory sections are labelled');
    term._keyHandlers.forEach((h) => h({ name: 'ctrl-c', ctrl: true, alt: false, shift: false }));
    await promise;
  });

  it('toggles a section off and back on with space', async () => {
    const { term, stdin, stdout } = createTestTerminal();
    const promise = exportOptionsScreen(term, { session, sectionTokens, documentTokens: 0, documentBytes: 0 });
    await settle();
    const before = readScreen(stdout, 110, 34).text();
    const beforeEstimate = /estimated\s+([\d.]+k?)/.exec(before)?.[1];

    // Move to a non-mandatory, enabled section and toggle it off.
    stdin.send('\u001b[B\u001b[B\u001b[B'); // down 3 -> 'state'
    await settle();
    stdin.send(' ');
    await settle();
    const afterOff = /estimated\s+([\d.]+k?)/.exec(readScreen(stdout, 110, 34).text())?.[1];
    assert.notEqual(afterOff, beforeEstimate, 'estimate changed after toggling');

    stdin.send(' '); // toggle back on
    await settle();
    const afterOn = /estimated\s+([\d.]+k?)/.exec(readScreen(stdout, 110, 34).text())?.[1];
    assert.equal(afterOn, beforeEstimate, 'estimate restored');

    term._keyHandlers.forEach((h) => h({ name: 'ctrl-c', ctrl: true, alt: false, shift: false }));
    await promise;
  });

  it('refuses to switch off a mandatory section', async () => {
    const { term, stdin, stdout } = createTestClient();
    function createTestClient() {
      return createTestTerminal();
    }
    const promise = exportOptionsScreen(term, { session, sectionTokens, documentTokens: 0, documentBytes: 0 });
    await settle();
    const before = /estimated\s+([\d.]+k?)/.exec(readScreen(stdout, 110, 34).text())?.[1];
    stdin.send(' '); // cursor starts on the first section, which is mandatory
    await settle();
    const after = /estimated\s+([\d.]+k?)/.exec(readScreen(stdout, 110, 34).text())?.[1];
    assert.equal(after, before, 'mandatory section cannot be removed');
    term._keyHandlers.forEach((h) => h({ name: 'ctrl-c', ctrl: true, alt: false, shift: false }));
    await promise;
  });

  it('applies the 1/2/3 detail presets', async () => {
    const { term, stdin } = createTestTerminal();
    const promise = exportOptionsScreen(term, { session, sectionTokens, documentTokens: 0, documentBytes: 0 });
    await settle();
    stdin.send('1');
    await settle();
    stdin.send('\r');
    const result = await promise;
    assert.deepEqual([...result.sections].sort(), [...PRESET_SECTIONS.minimal].sort());
  });

  it('cycles the token budget with b', async () => {
    const { term, stdin, stdout } = createTestTerminal();
    const promise = exportOptionsScreen(term, { session, sectionTokens, documentTokens: 0, documentBytes: 0 });
    await settle();
    assert.ok(readScreen(stdout, 110, 34).contains('no limit'), 'starts unlimited');
    stdin.send('b');
    await settle();
    assert.ok(readScreen(stdout, 110, 34).contains('8.0k') || readScreen(stdout, 110, 34).contains('8k'));
    stdin.send('b');
    await settle();
    stdin.send('\r');
    const result = await promise;
    assert.equal(result.budget, BUDGET_STEPS[2]);
  });

  it('warns when the selection exceeds the budget', async () => {
    // The default fixture totals well under the smallest budget step, so use a
    // large one to exercise the warning path.
    const bigTokens = Object.fromEntries(SECTION_CATALOGUE.map((section, index) => [section.id, (index + 1) * 5000]));
    const { term, stdin, stdout } = createTestTerminal();
    const promise = exportOptionsScreen(term, { session, sectionTokens: bigTokens, documentTokens: 0, documentBytes: 0 });
    await settle();
    assert.ok(!readScreen(stdout, 110, 34).contains('trimmed to fit'), 'no warning while unlimited');
    stdin.send('b'); // 8k budget, selection is far larger
    await settle();
    assert.ok(readScreen(stdout, 110, 34).contains('trimmed to fit'), 'trimming is announced');
    term._keyHandlers.forEach((h) => h({ name: 'ctrl-c', ctrl: true, alt: false, shift: false }));
    await promise;
  });

  it('returns the selected sections and budget on enter', async () => {
    const { term, stdin } = createTestTerminal();
    const promise = exportOptionsScreen(term, { session, sectionTokens, documentTokens: 0, documentBytes: 0 });
    await settle();
    stdin.send('\r');
    const result = await promise;
    assert.ok(Array.isArray(result.sections));
    assert.ok(result.sections.includes('mission'));
    assert.ok(result.sections.includes('deadends'));
    assert.equal(result.budget, null);
  });

  it('returns null on escape', async () => {
    const { term, stdin } = createTestTerminal();
    const promise = exportOptionsScreen(term, { session, sectionTokens, documentTokens: 0, documentBytes: 0 });
    await settle();
    stdin.send('\u001b');
    await settle(80);
    assert.equal(await promise, null);
  });

  it('never offers to remove a section the document needs', () => {
    for (const id of ['howto', 'mission', 'next']) {
      const section = SECTION_CATALOGUE.find((s) => s.id === id);
      assert.ok(section, `${id} is in the catalogue`);
      assert.equal(section.required, true, `${id} is mandatory`);
    }
    for (const preset of Object.values(PRESET_SECTIONS)) {
      for (const id of ['howto', 'mission', 'next']) {
        assert.ok(preset.includes(id), `preset keeps ${id}`);
      }
    }
  });
});

/**
 * Layout invariants.
 *
 * Every screen must fit the terminal at any realistic width. These caught real
 * off-by-one errors in box borders, unpadded table columns, and a `truncate`
 * that counted ANSI escape characters as visible columns.
 */
describe('layout invariants', () => {
  const WIDTHS = [120, 104, 90, 80, 72, 60, 48, 40];

  const PICKER_ENTRIES = [
    entry({ id: 'aaaa1111', title: '阅读实验文档 and a long English title as well', projectLabel: 'mobiscale-kubeedge' }),
    entry({ id: 'bbbb2222', title: 'Short', projectLabel: 'x', gitBranch: '' }),
  ];

  /** Re-render and return the visible lines of the final frame. */
  async function linesFor(run, columns) {
    const { term, stdout } = createTestTerminal({ columns, rows: 30 });
    const promise = run(term, columns);
    await settle(60);
    const frames = stdout.raw.split('\u001b[H').filter((f) => f.trim() !== '');
    const frame = frames[frames.length - 1] ?? stdout.raw;
    const lines = frame.split(/\r?\n/).map((line) => stripAnsi(line));
    term._keyHandlers.forEach((h) => h({ name: 'ctrl-c', ctrl: true, alt: false, shift: false }));
    await Promise.resolve(promise).catch(() => {});
    return lines;
  }

  const screens = {
    picker: (term) => pickSession(term, PICKER_ENTRIES, { home: '~/.codex' }),
    options: (term) =>
      exportOptionsScreen(term, {
        session: { title: '阅读实验设计与实现文档 with a tail', projectLabel: 'mobiscale-kubeedge', cwd: '/x' },
        sectionTokens: Object.fromEntries(SECTION_CATALOGUE.map((s, i) => [s.id, (i + 1) * 500])),
        documentTokens: 0,
        documentBytes: 0,
      }),
    list: (term) =>
      listPrompt(term, {
        title: 'A title',
        subtitle: 'a subtitle that is quite long and should be clipped safely',
        items: [{ id: 'a', label: 'Apple' }],
        keyOf: (x) => x.id,
        renderRow: (x) => x.label,
        footer: 'a footer that is also long enough to need clipping somewhere',
      }),
    text: (term) => textPrompt(term, { title: 'A title', message: 'a message', initial: 'value' }),
    confirm: (term) => confirmPrompt(term, { title: 'A title', message: 'a message' }),
  };

  for (const [name, run] of Object.entries(screens)) {
    for (const columns of WIDTHS) {
      it(`${name} fits ${columns} columns`, async () => {
        const lines = await linesFor(run, columns);
        assert.ok(lines.length > 0, 'rendered something');
        for (const [index, line] of lines.entries()) {
          assert.ok(
            displayWidth(line) <= columns,
            `${name}@${columns} line ${index} is ${displayWidth(line)} wide: ${JSON.stringify(line.slice(0, 100))}`,
          );
        }
      });
    }
  }

  it('keeps table columns aligned regardless of title length', async () => {
    const lines = await linesFor((term) => pickSession(term, PICKER_ENTRIES, { home: '~/.codex' }), 120);
    const rows = lines.filter((line) => line.startsWith('│'));
    assert.ok(rows.length >= 2, 'rows rendered');
    // Alignment is a *display column* property, not a character index: a row
    // containing CJK has fewer characters for the same rendered width. All rows
    // share the same box, so their rendered widths must be identical.
    const widths = new Set(rows.map((row) => displayWidth(row)));
    assert.equal(
      widths.size,
      1,
      `row widths differ: ${JSON.stringify([...widths])}\n${rows.slice(0, 4).join('\n')}`,
    );
  });
});
