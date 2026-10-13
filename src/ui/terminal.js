/**
 * Low-level terminal control: raw mode, alternate screen, key decoding.
 *
 * Written from scratch rather than pulled from a prompt library so the tool can
 * stay dependency-free (this matters: ExtraLife reads private source code, and a
 * zero-dependency install removes the entire supply-chain question). It also
 * lets us handle wide CJK characters correctly, which most prompt libraries get
 * wrong and which this tool's audience needs.
 *
 * Robustness rules observed here:
 *   - `setRawMode` is only touched when stdin is a real TTY.
 *   - The terminal is restored exactly once, from an idempotent `restore()`,
 *     wired to `exit`, `SIGINT`, `SIGTERM` and uncaught exceptions, so a crash
 *     never leaves the user with an invisible cursor or a stuck alt-screen.
 *   - Decoding is incremental: escape sequences split across `data` events are
 *     reassembled instead of being mis-read as stray keystrokes.
 */

import { createStyle, terminalSize } from '../util/ansi.js';

const ESC = '\u001b';

/**
 * How long to wait for the rest of an escape sequence before deciding that a
 * lone ESC byte was the user pressing the Escape key.
 */
const ESC_GRACE_MS = 40;

/**
 * @typedef {Object} KeyEvent
 * @property {string} name    canonical key name, e.g. 'up', 'enter', 'a', 'space'
 * @property {string} [char]  printable character when the key produced one
 * @property {boolean} ctrl
 * @property {boolean} alt
 * @property {boolean} shift
 */

/** Canonical names for CSI/SS3 final bytes we care about. */
const CSI_KEYS = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'tab',
};

/** Decode an xterm `~`-terminated CSI sequence number into a key name. */
const TILDE_KEYS = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
};

export class Terminal {
  /**
   * @param {{
   *   stdin?: NodeJS.ReadStream,
   *   stdout?: NodeJS.WriteStream,
   *   color?: boolean|null,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.stdin = opts.stdin ?? process.stdin;
    this.stdout = opts.stdout ?? process.stdout;
    this.style = createStyle(
      opts.color === null || opts.color === undefined
        ? Boolean(this.stdout.isTTY) && !process.env.NO_COLOR
        : opts.color,
    );
    this.entered = false;
    this.restored = false;
    /** @type {Array<() => void>} */
    this._cleanups = [];
    /** @type {Buffer} */
    this._buffer = Buffer.alloc(0);
    /** @type {NodeJS.Timeout|null} */
    this._escTimer = null;
    /** @type {Set<(key: KeyEvent) => void>} */
    this._keyHandlers = new Set();
    this._onData = this._onData.bind(this);
    this._onResize = this._onResize.bind(this);
    /** @type {Set<() => void>} */
    this._resizeHandlers = new Set();
  }

  get isTTY() {
    return Boolean(this.stdin.isTTY && this.stdout.isTTY);
  }

  /**
   * Enter the alternate screen with raw input.
   *
   * Idempotent while active, and safe to call again after `restore()`: the CLI
   * runs two interactive screens in sequence (picker, then options), and a
   * terminal that refused to re-arm would leave the second screen drawing but
   * deaf to every keystroke.
   */
  enter() {
    if (this.entered) return;
    this.entered = true;
    this.restored = false;
    this.stdout.write(
      // alt screen + clear, then hide cursor
      `${ESC}[?1049h${ESC}[2J${ESC}[H${ESC}[?25l`,
    );
    if (this.stdin.isTTY && typeof this.stdin.setRawMode === 'function') {
      this.stdin.setRawMode(true);
    }
    this.stdin.resume();
    this.stdin.setEncoding?.('utf8');
    this.stdin.on('data', this._onData);
    this.stdout.on('resize', this._onResize);

    const restore = () => this.restore();
    process.once('exit', restore);
    this._cleanups.push(() => process.removeListener('exit', restore));
    for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
      const handler = () => {
        this.restore();
        // Mirror default signal behaviour so shells see the right exit status.
        process.exit(signal === 'SIGINT' ? 130 : 143);
      };
      process.once(signal, handler);
      this._cleanups.push(() => process.removeListener(signal, handler));
    }
  }

  /** Leave the alternate screen and restore every terminal mode we changed. */
  restore() {
    if (this.restored) return;
    this.restored = true;
    if (this._escTimer) {
      clearTimeout(this._escTimer);
      this._escTimer = null;
    }
    this._buffer = Buffer.alloc(0);
    try {
      this.stdin.off('data', this._onData);
      this.stdout.off('resize', this._onResize);
      if (this.stdin.isTTY && typeof this.stdin.setRawMode === 'function') {
        this.stdin.setRawMode(false);
      }
      this.stdin.pause();
    } catch {
      /* stdin may already be torn down */
    }
    try {
      // show cursor, leave alt screen
      this.stdout.write(`${ESC}[?25h${ESC}[?1049l`);
    } catch {
      /* stdout may be closed (EPIPE) */
    }
    for (const cleanup of this._cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* best effort */
      }
    }
    // Mark the terminal as available for a subsequent `enter()`.
    this.entered = false;
  }

  /** Register a key handler. Returns an unsubscribe function. */
  onKey(handler) {
    this._keyHandlers.add(handler);
    return () => this._keyHandlers.delete(handler);
  }

  /** Register a resize handler. Returns an unsubscribe function. */
  onResize(handler) {
    this._resizeHandlers.add(handler);
    return () => this._resizeHandlers.delete(handler);
  }

  _onResize() {
    for (const handler of this._resizeHandlers) handler();
  }

  /** @param {Buffer|string} chunk */
  _onData(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this._buffer = Buffer.concat([this._buffer, buf]);
    // Guard against pathological input.
    if (this._buffer.length > 64 * 1024) this._buffer = this._buffer.subarray(-1024);
    this._drain();
    this._scheduleEscapeFlush();
  }

  /**
   * A lone ESC is ambiguous: it is both the "cancel" key and the first byte of
   * every arrow-key sequence. Terminals give us no length prefix, so we wait a
   * short grace period for continuation bytes and, if none arrive, deliver a
   * real `escape` key. Without this, pressing ESC to go back does nothing —
   * the byte just sits in the buffer forever.
   */
  _scheduleEscapeFlush() {
    const isLoneEscape = this._buffer.length === 1 && this._buffer[0] === 0x1b;
    if (!isLoneEscape) {
      if (this._escTimer) {
        clearTimeout(this._escTimer);
        this._escTimer = null;
      }
      return;
    }
    if (this._escTimer) return;
    this._escTimer = setTimeout(() => {
      this._escTimer = null;
      if (this._buffer.length === 1 && this._buffer[0] === 0x1b) {
        this._buffer = Buffer.alloc(0);
        this._emit({ name: 'escape' }, 0);
      }
    }, ESC_GRACE_MS);
    // Never keep the event loop alive just for this timer.
    this._escTimer.unref?.();
  }

  _drain() {
    while (this._buffer.length > 0) {
      const consumed = this._decodeOne(this._buffer);
      if (consumed === 0) return; // need more bytes
      this._buffer = this._buffer.subarray(consumed);
    }
  }

  /**
   * Decode one key from the head of `buf`.
   * @param {Buffer} buf
   * @returns {number} bytes consumed, or 0 when more input is required
   */
  _decodeOne(buf) {
    const first = buf[0];

    // Escape sequences must be handled before the generic control-character
    // branch below, because ESC (0x1b) is itself a control character — getting
    // this order wrong turns every arrow key into "ctrl-{ [ A".
    if (first === 0x1b) {
      if (buf.length === 1) return 0; // could be a bare ESC, or the start of a sequence
      const second = buf[1];
      if (second === 0x5b /* [ */) return this._decodeCsi(buf);
      if (second === 0x4f /* O */) {
        // SS3 (application cursor keys).
        if (buf.length < 3) return 0;
        const name = CSI_KEYS[String.fromCharCode(buf[2])] ?? 'unknown';
        return this._emit({ name }, 3);
      }
      if (second === 0x1b) return this._emit({ name: 'escape' }, 1); // ESC ESC
      // Alt + printable character.
      const length = utf8Length(second);
      if (length > 0) {
        if (buf.length < 1 + length) return 0;
        const char = buf.subarray(1, 1 + length).toString('utf8');
        return this._emit({ name: char, char, alt: true }, 1 + length);
      }
      // Alt + control character (e.g. alt+enter): report a plain escape so the
      // behaviour stays predictable rather than inventing a key name.
      return this._emit({ name: 'escape', alt: true }, 1);
    }

    // Control characters.
    if (first === 0x0d || first === 0x0a) return this._emit({ name: 'enter' }, 1);
    if (first === 0x09) return this._emit({ name: 'tab' }, 1);
    if (first === 0x7f || first === 0x08) return this._emit({ name: 'backspace' }, 1);
    if (first === 0x20) return this._emit({ name: 'space', char: ' ' }, 1);
    if (first === 0x03) return this._emit({ name: 'ctrl-c', ctrl: true }, 1);
    if (first === 0x04) return this._emit({ name: 'ctrl-d', ctrl: true }, 1);
    if (first < 0x20) {
      const letter = String.fromCharCode(first + 96);
      return this._emit({ name: `ctrl-${letter}`, ctrl: true }, 1);
    }

    // Printable UTF-8 (possibly multi-byte).
    const length = utf8Length(first);
    if (length === 0) return this._emit({ name: 'unknown' }, 1); // invalid lead byte
    if (buf.length < length) return 0;
    const char = buf.subarray(0, length).toString('utf8');
    return this._emit({ name: char, char }, length);
  }

  /**
   * @param {Buffer} buf starts with ESC [
   * @returns {number}
   */
  _decodeCsi(buf) {
    // Scan for the final byte (0x40-0x7e) after the parameters.
    let i = 2;
    while (i < buf.length && buf[i] >= 0x20 && buf[i] <= 0x3f) i++;
    if (i >= buf.length) return 0; // incomplete
    const finalByte = buf[i];
    const params = buf.subarray(2, i).toString('ascii');
    const consumed = i + 1;

    const finalChar = String.fromCharCode(finalByte);
    if (CSI_KEYS[finalChar]) {
      const base = CSI_KEYS[finalChar];
      // Shift+Tab arrives as CSI Z.
      return this._emit({ name: base, shift: finalChar === 'Z' }, consumed);
    }
    if (finalChar === '~') {
      const code = Number.parseInt(params.split(';')[0] ?? '', 10);
      const name = TILDE_KEYS[code] ?? 'unknown';
      return this._emit({ name }, consumed);
    }
    return this._emit({ name: 'unknown' }, consumed);
  }

  /**
   * @param {Partial<KeyEvent>} key
   * @param {number} consumed
   * @returns {number}
   */
  _emit(key, consumed) {
    const event = /** @type {KeyEvent} */ ({
      name: key.name ?? 'unknown',
      char: key.char,
      ctrl: key.ctrl ?? false,
      alt: key.alt ?? false,
      shift: key.shift ?? false,
    });
    for (const handler of this._keyHandlers) handler(event);
    return consumed;
  }

  /** Draw a full frame. `lines` should already be styled and sized to width. */
  draw(lines) {
    const { columns, rows } = this.size();
    const visible = lines.slice(0, rows);
    // Home + clear-to-end avoids flicker compared with a full clear.
    let out = `${ESC}[H`;
    for (let i = 0; i < visible.length; i++) {
      out += `${ESC}[2K${visible[i]}`;
      if (i < visible.length - 1) out += '\r\n';
    }
    out += `${ESC}[J`;
    this.stdout.write(out);
    return { columns, rows };
  }

  /** Move the cursor back to the top of the frame. */
  home() {
    this.stdout.write(`${ESC}[H`);
  }

  /** Show or hide the text cursor (needed for the search field). */
  cursor(visible) {
    this.stdout.write(visible ? `${ESC}[?25h` : `${ESC}[?25l`);
  }

  /** @returns {{ columns: number, rows: number }} */
  size() {
    return terminalSize(this.stdout);
  }
}

/** Expected UTF-8 sequence length from a lead byte. */
function utf8Length(byte) {
  if (byte < 0x80) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 0;
}

export { ESC };
