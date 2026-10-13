/**
 * Tests for the small pure utilities: token estimation, human formatting,
 * ANSI/width handling, fuzzy matching and argument parsing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { displayWidth, pad, truncate, wrap, createStyle, stripAnsi, supportsColor } from '../src/util/ansi.js';
import {
  estimateTokens,
  formatBytes,
  formatDateTime,
  formatTokens,
  indentBlock,
  relativePath,
  relativeTime,
  slugify,
  tidy,
  uniqBy,
} from '../src/util/format.js';
import { fuzzyFilter, fuzzyMatch } from '../src/util/fuzzy.js';
import { parseArgs, parseTokenCount } from '../src/cli.js';

describe('estimateTokens', () => {
  it('returns zero for empty input', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
  });

  it('approximates latin text at roughly four characters per token', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
    const tokens = estimateTokens(text);
    assert.ok(tokens > 80 && tokens < 200, `unexpected estimate: ${tokens}`);
  });

  it('charges CJK characters more than latin ones', () => {
    const cjk = estimateTokens('这是一个中文测试句子用于估算词元数量');
    const latin = estimateTokens('a'.repeat(18));
    assert.ok(cjk > latin, `CJK ${cjk} should exceed latin ${latin}`);
  });

  it('grows monotonically with input length', () => {
    let previous = 0;
    for (const size of [10, 100, 1000, 10000]) {
      const value = estimateTokens('word '.repeat(size));
      assert.ok(value > previous, 'estimate grows with input');
      previous = value;
    }
  });
});

describe('formatting helpers', () => {
  it('formats byte counts', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(formatBytes(-1), '?');
  });

  it('formats token counts compactly', () => {
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1500), '1.5k');
    assert.equal(formatTokens(45000), '45k');
    assert.equal(formatTokens(2_500_000), '2.5M');
  });

  it('formats relative time in both directions', () => {
    const now = Date.now();
    assert.equal(relativeTime(now - 5_000, now), 'just now');
    assert.equal(relativeTime(now - 5 * 60_000, now), '5m ago');
    assert.equal(relativeTime(now - 3 * 3_600_000, now), '3h ago');
    assert.equal(relativeTime(now - 2 * 86_400_000, now), '2d ago');
    assert.ok(relativeTime(now + 3_600_000, now).startsWith('in '));
    assert.equal(relativeTime(NaN, now), 'unknown');
  });

  it('slugifies paths and international text', () => {
    assert.equal(slugify('My Project!'), 'my-project');
    assert.equal(slugify('  spaces  and---dashes '), 'spaces-and-dashes');
    assert.ok(slugify('中文项目').length > 0, 'CJK survives slugification');
    assert.equal(slugify('!!!'), 'session');
    assert.ok(slugify('x'.repeat(100)).length <= 48);
  });

  it('relativises paths against a base', () => {
    assert.equal(relativePath('/a/b/c.ts', '/a/b'), 'c.ts');
    assert.equal(relativePath('/a/b', '/a/b'), '.');
    assert.equal(relativePath('/other/x.ts', '/a/b'), '/other/x.ts');
    assert.equal(relativePath('/a/b/c.ts', undefined), '/a/b/c.ts');
  });

  it('indents non-empty lines only', () => {
    assert.equal(indentBlock('a\n\nb', '> '), '> a\n\n> b');
  });

  it('deduplicates preserving order', () => {
    assert.deepEqual(uniqBy([3, 1, 3, 2, 1]), [3, 1, 2]);
  });

  it('tidies messy whitespace', () => {
    const messy = 'a  \n\n\n\n b\n';
    assert.equal(tidy(messy), 'a\n\n b\n');
  });

  it('formats dates without locale surprises', () => {
    assert.match(formatDateTime(Date.parse('2026-10-10T11:00:00Z')), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(formatDateTime(NaN), 'unknown');
  });
});

describe('ansi and width', () => {
  it('counts CJK characters as two columns', () => {
    assert.equal(displayWidth('abc'), 3);
    assert.equal(displayWidth('中文'), 4);
    assert.equal(displayWidth('a中b'), 4);
    assert.equal(displayWidth(''), 0);
  });

  it('composes styles so an outer attribute survives an inner one', () => {
    // Regression: styling helpers used to end with a blanket ESC[0m, so
    // `inverse(red(x))` lost the inverse as soon as the red turned off — which
    // silently broke the selected-row highlight in the picker.
    const style = createStyle(true);
    const composed = style.inverse(`a${style.red('b')}c`);
    assert.ok(composed.startsWith('\u001b[7m'), 'inverse opens first');
    assert.ok(composed.endsWith('\u001b[27m'), 'inverse closes last');
    assert.ok(!composed.includes('\u001b[0m'), 'no blanket reset cancels the outer style');
    assert.ok(composed.includes('\u001b[31m') && composed.includes('\u001b[39m'), 'inner colour still scoped');
    // Every style must turn off exactly the attribute it turned on.
    assert.equal(style.bold('x').endsWith('\u001b[22m'), true);
    assert.equal(style.dim('x').endsWith('\u001b[22m'), true);
    assert.equal(style.italic('x').endsWith('\u001b[23m'), true);
    assert.equal(style.cyan('x').endsWith('\u001b[39m'), true);
  });

  it('leaves no escape codes when colour is disabled', () => {
    const plain = createStyle(false);
    for (const name of ['bold', 'red', 'inverse', 'dim']) {
      assert.equal(plain[name]('x'), 'x');
    }
  });

  it('ignores ANSI escapes when measuring', () => {
    const style = createStyle(true);
    assert.equal(displayWidth(style.red('abc')), 3);
    assert.equal(stripAnsi(style.red('abc')), 'abc');
  });

  it('truncates to a visible width, accounting for CJK', () => {
    assert.equal(displayWidth(truncate('中文中文中文', 5)), 5);
    assert.equal(truncate('abcdef', 3), 'ab…');
    assert.equal(truncate('abc', 10), 'abc');
    // Two CJK columns plus an ellipsis would need 5, so it must settle for 3.
    assert.ok(displayWidth(truncate('中文中文', 4)) <= 4);
    assert.equal(displayWidth(truncate('中文中文', 5)), 5);
  });

  it('pads to a visible width', () => {
    assert.equal(displayWidth(pad('中文', 8)), 8);
    assert.equal(pad('a', 3), 'a  ');
    assert.equal(pad('a', 3, 'right'), '  a');
    assert.equal(pad('abcdef', 2), 'abcdef', 'never truncates');
  });

  it('wraps latin and CJK text without exceeding the width', () => {
    const latin = wrap('the quick brown fox jumps over the lazy dog', 12);
    assert.ok(latin.every((line) => displayWidth(line) <= 12));
    assert.ok(latin.length > 1);

    const cjk = wrap('这是一个很长的中文句子需要被正确换行处理', 10);
    assert.ok(cjk.every((line) => displayWidth(line) <= 10), `CJK wrap overflow: ${JSON.stringify(cjk)}`);
    assert.ok(cjk.length > 1);
  });

  it('preserves explicit newlines and blank lines when wrapping', () => {
    const lines = wrap('one\n\ntwo', 20);
    assert.deepEqual(lines, ['one', '', 'two']);
  });

  it('disables colour when NO_COLOR is set', () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      assert.equal(supportsColor({ stream: { isTTY: true } }), false);
      assert.equal(supportsColor({ color: true, stream: { isTTY: false } }), true, 'explicit flag wins');
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });
});

describe('fuzzy matching', () => {
  it('matches subsequences and rejects non-matches', () => {
    assert.ok(fuzzyMatch('ap', 'Apple'));
    assert.ok(fuzzyMatch('aple', 'Apple'));
    assert.equal(fuzzyMatch('xyz', 'Apple'), null);
  });

  it('prefers exact substrings and earlier positions', () => {
    const exact = fuzzyMatch('apple', 'apple pie');
    const scattered = fuzzyMatch('apple', 'a-p-p-l-e scattered far apart');
    assert.ok(exact.score > scattered.score);
  });

  it('supports the exact-match modifier', () => {
    assert.ok(fuzzyMatch("'apple", 'an apple pie'), 'bare prefix form');
    assert.ok(fuzzyMatch("'apple'", 'an apple pie'), 'quoted form');
    assert.equal(fuzzyMatch("'pineapple", 'an apple pie'), null);
    assert.equal(fuzzyMatch("'zzz", 'an apple pie'), null);
  });

  it('requires every whitespace-separated term to match', () => {
    assert.ok(fuzzyMatch('app pie', 'apple pie'));
    assert.equal(fuzzyMatch('app zzz', 'apple pie'), null);
  });

  it('matches on a query that is empty or whitespace', () => {
    assert.deepEqual(fuzzyMatch('', 'anything'), { score: 0, positions: [] });
    assert.deepEqual(fuzzyMatch('   ', 'anything'), { score: 0, positions: [] });
  });

  it('ranks better matches first and filters out the rest', () => {
    const items = ['banana', 'apple', 'application', 'grape'];
    const ranked = fuzzyFilter(items, 'app', (x) => x);
    assert.deepEqual(ranked.map((r) => r.item), ['apple', 'application']);
  });

  it('returns every item for an empty query, preserving order', () => {
    const items = ['a', 'b', 'c'];
    assert.deepEqual(fuzzyFilter(items, '', (x) => x).map((r) => r.item), items);
  });
});

describe('parseArgs', () => {
  it('parses long flags with and without values', () => {
    const { flags, positionals, errors } = parseArgs(['--list', '--budget', '32k', '--out=file.txt', 'abc123']);
    assert.equal(flags.list, true);
    assert.equal(flags.budget, '32k');
    assert.equal(flags.out, 'file.txt');
    assert.deepEqual(positionals, ['abc123']);
    assert.deepEqual(errors, []);
  });

  it('parses short flags, including bundles', () => {
    assert.equal(parseArgs(['-l']).flags.list, true);
    assert.equal(parseArgs(['-y']).flags.yes, true);
    const bundled = parseArgs(['-ly']);
    assert.equal(bundled.flags.list, true);
    assert.equal(bundled.flags.yes, true);
  });

  it('takes a value attached to a short flag', () => {
    const { flags } = parseArgs(['-o', 'out.txt']);
    assert.equal(flags.out, 'out.txt');
  });

  it('supports --no- negation for booleans', () => {
    assert.equal(parseArgs(['--no-color']).flags['no-color'], true);
    assert.equal(parseArgs(['--no-redact']).flags['no-redact'], true);
  });

  it('collects everything after -- as positionals', () => {
    const { positionals } = parseArgs(['--', '--not-a-flag', 'x']);
    assert.deepEqual(positionals, ['--not-a-flag', 'x']);
  });

  it('reports unknown flags and missing values instead of throwing', () => {
    assert.match(parseArgs(['--nope']).errors[0], /unknown option/);
    assert.match(parseArgs(['--budget']).errors[0], /needs a value/);
    assert.match(parseArgs(['-z']).errors[0], /unknown option/);
  });

  it('accepts an empty argv', () => {
    const { flags, positionals, errors } = parseArgs([]);
    assert.deepEqual(flags, {});
    assert.deepEqual(positionals, []);
    assert.deepEqual(errors, []);
  });
});

describe('parseTokenCount', () => {
  it('accepts plain numbers, k and M suffixes and separators', () => {
    assert.equal(parseTokenCount('32000'), 32000);
    assert.equal(parseTokenCount('32k'), 32000);
    assert.equal(parseTokenCount('1.5M'), 1_500_000);
    assert.equal(parseTokenCount('32_000'), 32000);
    assert.equal(parseTokenCount('32K'), 32000);
  });

  it('rejects nonsense', () => {
    assert.equal(parseTokenCount('abc'), null);
    assert.equal(parseTokenCount(''), null);
    assert.equal(parseTokenCount('0'), null);
    assert.equal(parseTokenCount(undefined), null);
    assert.equal(parseTokenCount('-5'), null);
  });
});
