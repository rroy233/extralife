/**
 * Test harness for interactive screens.
 *
 * Renders frames into an in-memory buffer instead of a real terminal and lets a
 * test drive synthetic keystrokes, so the UI can be verified deterministically
 * in CI without a TTY. The emitted byte stream is replayed into a tiny screen
 * model so assertions can be written against what the user would actually see.
 */

import { EventEmitter } from 'node:events';
import { Terminal } from '../../src/ui/terminal.js';

/** A fake WriteStream that records everything written to it. */
class FakeStdout extends EventEmitter {
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
  /** Everything written so far. */
  get raw() {
    return this.chunks.join('');
  }
  clear() {
    this.chunks = [];
  }
}

/** A fake ReadStream that can inject keystrokes. */
class FakeStdin extends EventEmitter {
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
  /** Send raw bytes as if typed. */
  send(text) {
    this.emit('data', Buffer.from(text, 'utf8'));
  }
}

/**
 * Minimal ANSI screen model: replays a byte stream and keeps the resulting grid
 * so tests can assert on visible text.
 */
export class Screen {
  constructor(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    /** @type {string[][]} */
    this.grid = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ' '));
    this.row = 0;
    this.col = 0;
  }

  /** @param {string} stream */
  replay(stream) {
    let i = 0;
    while (i < stream.length) {
      const ch = stream[i];
      if (ch === '\u001b') {
        const match = /^\u001b\[([0-9;?]*)([A-Za-z])/.exec(stream.slice(i));
        if (match) {
          this._csi(match[1], match[2]);
          i += match[0].length;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === '\r') {
        this.col = 0;
        i++;
        continue;
      }
      if (ch === '\n') {
        this.row = Math.min(this.rows - 1, this.row + 1);
        i++;
        continue;
      }
      this._put(ch);
      i++;
    }
    return this;
  }

  _put(ch) {
    if (this.row < this.rows && this.col < this.columns) {
      this.grid[this.row][this.col] = ch;
    }
    this.col++;
  }

  _csi(params, final) {
    const args = params.split(';').filter((p) => p !== '').map(Number);
    switch (final) {
      case 'H': {
        this.row = Math.max(0, (args[0] ?? 1) - 1);
        this.col = Math.max(0, (args[1] ?? 1) - 1);
        break;
      }
      case 'A':
        this.row = Math.max(0, this.row - (args[0] ?? 1));
        break;
      case 'B':
        this.row = Math.min(this.rows - 1, this.row + (args[0] ?? 1));
        break;
      case 'C':
        this.col += args[0] ?? 1;
        break;
      case 'D':
        this.col = Math.max(0, this.col - (args[0] ?? 1));
        break;
      case 'J': {
        if ((args[0] ?? 0) === 2) {
          this.grid = Array.from({ length: this.rows }, () =>
            Array.from({ length: this.columns }, () => ' '),
          );
          this.row = 0;
          this.col = 0;
        } else {
          for (let c = this.col; c < this.columns; c++) this.grid[this.row][c] = ' ';
        }
        break;
      }
      case 'K': {
        const mode = args[0] ?? 0;
        const from = mode === 0 ? this.col : 0;
        const to = mode === 0 ? this.columns : this.col;
        for (let c = from; c < to; c++) this.grid[this.row][c] = ' ';
        break;
      }
      default:
        break;
    }
  }

  /** Visible lines, right-trimmed. */
  lines() {
    return this.grid.map((row) => row.join('').replace(/\s+$/, ''));
  }

  /** The whole visible screen as text. */
  text() {
    return this.lines().join('\n');
  }

  /** True when the visible screen contains `needle`. */
  contains(needle) {
    return this.text().includes(needle);
  }

  /** The row index of the first visible line containing `needle`, or -1. */
  findRow(needle) {
    return this.lines().findIndex((line) => line.includes(needle));
  }
}

/**
 * Build a terminal wired to fake streams.
 * @param {{ columns?: number, rows?: number }} [opts]
 */
export function createTestTerminal(opts = {}) {
  const columns = opts.columns ?? 110;
  const rows = opts.rows ?? 34;
  const stdout = new FakeStdout(columns, rows);
  const stdin = new FakeStdin();
  const term = new Terminal({
    stdin: /** @type {any} */ (stdin),
    stdout: /** @type {any} */ (stdout),
    // Colour is preserved so the screenshot generator can render the real
    // styled output rather than a re-drawn imitation.
    color: opts.color ?? false,
  });
  // Skip alt-screen/raw-mode side effects; handlers are what we need.
  term.entered = true;
  stdin.setEncoding('utf8');
  stdin.on('data', (/** @type {any} */ chunk) => term._onData(chunk));
  return { term, stdin, stdout, columns, rows };
}

/**
 * Render the latest frame written to `stdout` into a Screen.
 * @param {FakeStdout} stdout
 * @param {number} columns
 * @param {number} rows
 */
export function readScreen(stdout, columns, rows) {
  const screen = new Screen(columns, rows);
  screen.replay(stdout.raw);
  return screen;
}

/** Wait for pending microtasks and timers so async UI work settles. */
export function settle(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
