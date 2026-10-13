/**
 * Interactive-UI tests.
 *
 * These drive the real prompt components with synthetic keystrokes and assert
 * on the rendered screen, so regressions in navigation, filtering, selection
 * and terminal restoration are caught without a human at a keyboard.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { Terminal } from '../src/ui/terminal.js';
import { confirmPrompt, listPrompt, textPrompt } from '../src/ui/prompts.js';
import { createTestTerminal, readScreen, settle } from './helpers/tui-harness.js';

const FRUITS = [
  { id: 'apple', label: 'Apple', group: 'fruit' },
  { id: 'apricot', label: 'Apricot', group: 'fruit' },
  { id: 'banana', label: 'Banana', group: 'fruit' },
  { id: 'cherry', label: 'Cherry', group: 'fruit' },
];

const baseOptions = {
  title: 'Pick one',
  items: FRUITS,
  keyOf: (/** @type {any} */ item) => item.id,
  searchText: (/** @type {any} */ item) => item.label,
  renderRow: (/** @type {any} */ item) => item.label,
};

describe('key decoding', () => {
  it('decodes navigation, control and multi-byte keys', () => {
    const term = new Terminal({ color: false });
    /** @type {string[]} */
    const seen = [];
    term.onKey((key) => seen.push(key.name));
    term._onData(Buffer.from('\u001b[A\u001b[B\u001b[H\u001b[F\u001b[5~\u001b[6~\r\u007f\u0003', 'utf8'));
    assert.deepEqual(seen, ['up', 'down', 'home', 'end', 'pageup', 'pagedown', 'enter', 'backspace', 'ctrl-c']);
  });

  it('reassembles escape sequences split across reads', () => {
    const term = new Terminal({ color: false });
    /** @type {string[]} */
    const seen = [];
    term.onKey((key) => seen.push(key.name));
    term._onData(Buffer.from('\u001b'));
    term._onData(Buffer.from('['));
    term._onData(Buffer.from('A'));
    assert.deepEqual(seen, ['up']);
  });

  it('reassembles multi-byte characters split across reads', () => {
    const term = new Terminal({ color: false });
    /** @type {string[]} */
    const seen = [];
    term.onKey((key) => seen.push(key.name));
    const bytes = Buffer.from('中', 'utf8');
    term._onData(bytes.subarray(0, 1));
    term._onData(bytes.subarray(1, 2));
    term._onData(bytes.subarray(2));
    assert.deepEqual(seen, ['中']);
  });

  it('emits a bare escape after the grace period', async () => {
    const term = new Terminal({ color: false });
    /** @type {string[]} */
    const seen = [];
    term.onKey((key) => seen.push(key.name));
    term._onData(Buffer.from('\u001b'));
    assert.deepEqual(seen, [], 'must not fire immediately');
    await settle(80);
    assert.deepEqual(seen, ['escape']);
  });
});

describe('terminal restoration', () => {
  it('restores raw mode, cursor and screen exactly once', () => {
    const { term, stdin, stdout } = createTestTerminal();
    term.entered = false;
    term.restore(); // make restore() runnable
    term.restored = false;
    term.enter();
    assert.equal(stdin.rawMode, true, 'raw mode enabled');
    term.restore();
    term.restore(); // idempotent
    assert.equal(stdin.rawMode, false, 'raw mode disabled');
    assert.ok(stdout.raw.includes('\u001b[?25h'), 'cursor shown again');
    assert.ok(stdout.raw.includes('\u001b[?1049l'), 'left alternate screen');
  });
});

describe('terminal reuse across screens', () => {
  it('re-arms after restore so a second screen still receives keys', async () => {
    // Regression: the CLI runs the picker and then the options screen on the
    // same Terminal. If `enter()` refused to re-arm after `restore()`, the
    // second screen would render but ignore every keystroke — it would hang.
    const { term, stdin, stdout } = createTestTerminal();
    term.entered = false;
    term.restored = false;

    term.enter();
    const first = listPrompt(term, { ...baseOptions });
    await settle();
    stdin.send('\r');
    assert.equal(/** @type {any} */ (await first).id, 'apple');
    term.restore();
    assert.equal(term.entered, false, 'restore releases the terminal');
    assert.equal(stdin.rawMode, false, 'raw mode off');

    // Second screen on the same Terminal.
    term.enter();
    assert.equal(stdin.rawMode, true, 'raw mode re-enabled');
    let got = null;
    const off = term.onKey((key) => {
      got = key.name;
    });
    stdin.send('\r');
    await settle();
    assert.equal(got, 'enter', 'the re-armed terminal receives keys');
    off();

    const second = textPrompt(term, { title: 'Second', initial: 'ok' });
    await settle();
    stdin.send('!\r');
    assert.equal(await second, 'ok!');
    term.restore();
    assert.equal(stdin.rawMode, false);

    // The alternate screen must have been entered twice and left twice.
    const enters = stdout.raw.split('\u001b[?1049h').length - 1;
    const leaves = stdout.raw.split('\u001b[?1049l').length - 1;
    assert.equal(enters, 2, 'entered the alternate screen twice');
    assert.equal(leaves, 2, 'left the alternate screen twice');
  });

  it('is idempotent while already active', () => {
    const { term, stdin, stdout } = createTestTerminal();
    term.entered = false;
    term.restored = false;
    term.enter();
    term.enter();
    term.enter();
    assert.equal(stdout.raw.split('\u001b[?1049h').length - 1, 1, 'only one alt-screen entry');
    term.restore();
    term.restore();
    assert.equal(stdin.rawMode, false, 'restore is idempotent');
  });
});

describe('listPrompt — single select', () => {
  it('renders the list and returns the highlighted item', async () => {
    const { term, stdin, stdout } = createTestTerminal();
    const promise = listPrompt(term, { ...baseOptions });
    await settle();
    let screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('Pick one'), 'title rendered');
    assert.ok(screen.contains('Apple'), 'items rendered');

    stdin.send('\u001b[B'); // down
    await settle();
    stdin.send('\r');
    const result = await promise;
    assert.equal(/** @type {any} */ (result).id, 'apricot');
  });

  it('filters with a fuzzy query and confirms the filtered item', async () => {
    const { term, stdin, stdout } = createTestTerminal();
    const promise = listPrompt(term, { ...baseOptions });
    await settle();
    stdin.send('bn');
    await settle();
    const screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('Banana'), 'match shown');
    assert.ok(!screen.contains('Cherry'), 'non-match hidden');
    stdin.send('\r');
    const result = await promise;
    assert.equal(/** @type {any} */ (result).id, 'banana');
  });

  it('clears the query on escape before cancelling', async () => {
    const { term, stdin, stdout } = createTestTerminal();
    const promise = listPrompt(term, { ...baseOptions });
    await settle();
    stdin.send('ban');
    await settle();
    stdin.send('\u001b');
    await settle(80);
    let screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('Apple'), 'full list is back');

    stdin.send('\u001b');
    await settle(80);
    assert.equal(await promise, null, 'second escape cancels');
  });

  it('reports when nothing matches instead of crashing', async () => {
    const { term, stdin, stdout } = createTestTerminal();
    const promise = listPrompt(term, { ...baseOptions });
    await settle();
    stdin.send('zzzz');
    await settle();
    const screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('no session matches') || screen.contains('nothing matches'));
    stdin.send('\u001b');
    await settle(80);
    stdin.send('\u001b');
    await settle(80);
    assert.equal(await promise, null);
  });

  it('toggles the help overlay with ?', async () => {
    const { term, stdin, stdout } = createTestTerminal();
    const promise = listPrompt(term, { ...baseOptions });
    await settle();
    stdin.send('?');
    await settle();
    const screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('fuzzy-filter'), 'help text shown');
    stdin.send('\u001b');
    await settle(80);
    stdin.send('\u001b');
    await settle(80);
    await promise;
  });

  it('wraps around with arrow-up from the first row', async () => {
    const { term, stdin, stdout } = createTestTerminal();
    const promise = listPrompt(term, { ...baseOptions });
    await settle();
    stdin.send('\u001b[A'); // up from first -> last
    await settle();
    stdin.send('\r');
    const result = await promise;
    assert.equal(/** @type {any} */ (result).id, 'cherry');
  });
});

describe('listPrompt — multi select', () => {
  it('accumulates toggles and returns them in source order', async () => {
    const { term, stdin } = createTestTerminal();
    const promise = listPrompt(term, { ...baseOptions, multi: true });
    await settle();
    stdin.send(' '); // toggle Apple, cursor advances
    await settle();
    stdin.send(' '); // toggle Apricot
    await settle();
    stdin.send('\r');
    const result = /** @type {any[]} */ (await promise);
    assert.deepEqual(result.map((r) => r.id), ['apple', 'apricot']);
  });

  it('refuses to continue with an empty selection', async () => {
    const { term, stdin, stdout } = createTestTerminal();
    const promise = listPrompt(term, { ...baseOptions, multi: true });
    await settle();
    stdin.send('\r');
    await settle();
    const screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('select at least one'), 'shows a hint');
    stdin.send(' ');
    await settle();
    stdin.send('\r');
    const result = /** @type {any[]} */ (await promise);
    assert.equal(result.length, 1);
  });

  it('selects all filtered items with "a" when no search is active', async () => {
    const { term, stdin } = createTestTerminal();
    const promise = listPrompt(term, { ...baseOptions, multi: true });
    await settle();
    stdin.send('a');
    await settle();
    stdin.send('\r');
    const result = /** @type {any[]} */ (await promise);
    assert.equal(result.length, 4);
  });

  it('does not hijack "a" while a search query is active', async () => {
    const { term, stdin, stdout } = createTestTerminal();
    const promise = listPrompt(term, { ...baseOptions, multi: true });
    await settle();
    stdin.send('ban');
    await settle();
    const screen = readScreen(stdout, 110, 34);
    assert.ok(screen.contains('Banana'));
    stdin.send(' ');
    await settle();
    stdin.send('\r');
    const result = /** @type {any[]} */ (await promise);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'banana');
  });
});

describe('textPrompt', () => {
  it('accepts text and returns it', async () => {
    const { term, stdin } = createTestTerminal();
    const promise = textPrompt(term, { title: 'Name', initial: 'ab' });
    await settle();
    stdin.send('c');
    await settle();
    stdin.send('\r');
    assert.equal(await promise, 'abc');
  });

  it('handles backspace and ctrl-u', async () => {
    const { term, stdin } = createTestTerminal();
    const promise = textPrompt(term, { title: 'Name', initial: 'abcd' });
    await settle();
    stdin.send('\u007f');
    await settle();
    stdin.send('\u0015');
    await settle();
    stdin.send('xy\r');
    assert.equal(await promise, 'xy');
  });

  it('blocks submission while validation fails, then accepts', async () => {
    const { term, stdin } = createTestTerminal();
    const promise = textPrompt(term, {
      title: 'Name',
      validate: (value) => (value.length < 2 ? 'too short' : null),
    });
    await settle();
    stdin.send('a\r');
    await settle();
    stdin.send('b\r');
    assert.equal(await promise, 'ab');
  });

  it('returns null on escape', async () => {
    const { term, stdin } = createTestTerminal();
    const promise = textPrompt(term, { title: 'Name' });
    await settle();
    stdin.send('\u001b');
    await settle(80);
    assert.equal(await promise, null);
  });
});

describe('confirmPrompt', () => {
  it('returns the default on enter', async () => {
    const { term, stdin } = createTestTerminal();
    const promise = confirmPrompt(term, { title: 'Sure?', message: 'go on', defaultValue: true });
    await settle();
    stdin.send('\r');
    assert.equal(await promise, true);
  });

  it('toggles with arrow keys', async () => {
    const { term, stdin } = createTestTerminal();
    const promise = confirmPrompt(term, { title: 'Sure?', message: 'go on', defaultValue: true });
    await settle();
    stdin.send('\u001b[C'); // right
    await settle();
    stdin.send('\r');
    assert.equal(await promise, false);
  });

  it('answers with y and n directly', async () => {
    const { term, stdin } = createTestTerminal();
    const p1 = confirmPrompt(term, { title: 'A', message: 'm' });
    await settle();
    stdin.send('n');
    assert.equal(await p1, false);

    const p2 = confirmPrompt(term, { title: 'B', message: 'm', defaultValue: false });
    await settle();
    stdin.send('y');
    assert.equal(await p2, true);
  });

  it('returns null on escape', async () => {
    const { term, stdin } = createTestTerminal();
    const promise = confirmPrompt(term, { title: 'A', message: 'm' });
    await settle();
    stdin.send('\u001b');
    await settle(80);
    assert.equal(await promise, null);
  });
});

after(() => {
  // Nothing global to tear down; keeps the test file self-documenting.
});
