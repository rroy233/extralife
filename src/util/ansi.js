/**
 * ANSI / terminal capability helpers.
 *
 * Everything in here degrades gracefully: when the output is not a TTY, or the
 * user asked for `--no-color`, or `NO_COLOR` is set, all styling helpers become
 * identity functions so that redirected output stays clean and greppable.
 */

/** @returns {boolean} whether stdout is an interactive terminal */
export function isTTY(stream = process.stdout) {
  return Boolean(stream && stream.isTTY);
}

/**
 * Decide whether colour should be used.
 *
 * Precedence follows the de-facto standard used by chalk / picocolors:
 * explicit flag > NO_COLOR env > FORCE_COLOR env > TTY detection.
 *
 * @param {{ color?: boolean|null, stream?: NodeJS.WriteStream }} [opts]
 * @returns {boolean}
 */
export function supportsColor(opts = {}) {
  const stream = opts.stream ?? process.stdout;
  if (opts.color === false) return false;
  if (opts.color === true) return true;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '') {
    return process.env.FORCE_COLOR !== '0';
  }
  if (process.env.TERM === 'dumb') return false;
  return isTTY(stream);
}

/**
 * Each attribute carries its own "off" code rather than a blanket reset.
 *
 * This is what makes styles *composable*: `style.inverse(style.red(x))` keeps
 * the inverse background, because turning red off (`ESC[39m`) does not clear
 * it. Emitting `ESC[0m` everywhere instead would silently cancel any attribute
 * applied by an enclosing style — which is exactly how a highlighted list row
 * loses its highlight as soon as one column inside it is coloured.
 */
const CODES = {
  bold: { on: 1, off: 22 },
  dim: { on: 2, off: 22 },
  italic: { on: 3, off: 23 },
  underline: { on: 4, off: 24 },
  inverse: { on: 7, off: 27 },
  black: { on: 30, off: 39 },
  red: { on: 31, off: 39 },
  green: { on: 32, off: 39 },
  yellow: { on: 33, off: 39 },
  blue: { on: 34, off: 39 },
  magenta: { on: 35, off: 39 },
  cyan: { on: 36, off: 39 },
  white: { on: 37, off: 39 },
  gray: { on: 90, off: 39 },
  brightRed: { on: 91, off: 39 },
  brightGreen: { on: 92, off: 39 },
  brightYellow: { on: 93, off: 39 },
  brightBlue: { on: 94, off: 39 },
  brightMagenta: { on: 95, off: 39 },
  brightCyan: { on: 96, off: 39 },
  brightWhite: { on: 97, off: 39 },
};

/**
 * Build a palette of styling functions bound to a colour decision.
 *
 * @param {boolean} enabled
 * @returns {Record<string, (s: string) => string> & { enabled: boolean, strip: (s:string)=>string }}
 */
export function createStyle(enabled) {
  /** @type {any} */
  const style = { enabled };
  for (const [name, code] of Object.entries(CODES)) {
    style[name] = enabled
      ? (s) => `\u001b[${code.on}m${s}\u001b[${code.off}m`
      : (s) => String(s);
  }
  style.strip = stripAnsi;
  return style;
}

/**
 * Remove ANSI escape sequences from a string.
 *
 * Covers the full CSI form, including private-parameter sequences such as
 * `ESC[?25h` (cursor show/hide) whose `?` is not a digit or semicolon. Missing
 * those makes width calculations drift on every frame.
 */
export function stripAnsi(s) {
  return String(s)
    // CSI: ESC [ params intermediates final-byte
    .replace(/\u001b\[[0-9;:?<>=]*[\x20-\x2f]*[@-~]/g, '')
    // OSC: ESC ] ... BEL or ST
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    // Other two-character escapes
    .replace(/\u001b[@-Z\\-_]/g, '');
}

/**
 * Visible width of a string, ignoring ANSI escapes and counting East-Asian
 * wide characters as two columns (essential: this tool's users write Chinese).
 *
 * @param {string} s
 * @returns {number}
 */
export function displayWidth(s) {
  const plain = stripAnsi(s);
  let width = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    width += isWide(cp) ? 2 : isZeroWidth(cp) ? 0 : 1;
  }
  return width;
}

/** @param {number} cp */
function isZeroWidth(cp) {
  // Control characters occupy no columns. Terminals interpret them (carriage
  // return, tab, …); counting them would overstate every line that contains one.
  if (cp < 0x20 || cp === 0x7f) return true;
  if (cp >= 0x80 && cp <= 0x9f) return true;
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) return true;
  return (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x20d0 && cp <= 0x20ff);
}

/** @param {number} cp */
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * Truncate to a visible width, appending an ellipsis when cut.
 *
 * @param {string} s
 * @param {number} max
 * @param {{ ellipsis?: string }} [opts]
 * @returns {string}
 */
export function truncate(s, max, opts = {}) {
  const ellipsis = opts.ellipsis ?? '…';
  const text = String(s).replace(/\r?\n/g, ' ');
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;
  const ellipsisWidth = displayWidth(ellipsis);
  const target = Math.max(0, max - ellipsisWidth);

  let out = '';
  let width = 0;
  let sawEscape = false;
  let i = 0;
  while (i < text.length) {
    // Copy ANSI escape sequences through verbatim. They occupy no columns, and
    // counting them (or cutting through one) would misalign every styled row.
    if (text.charCodeAt(i) === 0x1b) {
      const match = /^\u001b\[[0-9;?]*[A-Za-z]/.exec(text.slice(i));
      if (match) {
        out += match[0];
        sawEscape = true;
        i += match[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const w = isWide(cp) ? 2 : isZeroWidth(cp) ? 0 : 1;
    if (width + w > target) break;
    out += ch;
    width += w;
    i += ch.length;
  }
  // A cut can drop the trailing reset; re-close any styling we passed through.
  if (sawEscape) out += '\u001b[0m';
  return out + ellipsis;
}

/**
 * Pad a (possibly styled) string to a visible width.
 *
 * @param {string} s
 * @param {number} width
 * @param {'left'|'right'} [align]
 * @returns {string}
 */
export function pad(s, width, align = 'left') {
  const diff = width - displayWidth(s);
  if (diff <= 0) return s;
  return align === 'right' ? ' '.repeat(diff) + s : s + ' '.repeat(diff);
}

/**
 * Word-wrap to a visible width. Handles CJK text by wrapping at any character
 * boundary when there is no whitespace to break on, and preserves explicit
 * newlines and leading indentation.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrap(text, width) {
  /** @type {string[]} */
  const lines = [];
  if (width <= 0) return [String(text)];
  for (const rawLine of String(text).split('\n')) {
    if (rawLine === '') {
      lines.push('');
      continue;
    }
    const indent = (rawLine.match(/^\s*/) ?? [''])[0];
    let current = indent;
    let currentWidth = displayWidth(indent);
    const tokens = rawLine.slice(indent.length).split(/(\s+)/).filter((t) => t !== '');
    for (const token of tokens) {
      const tokenWidth = displayWidth(token);
      if (currentWidth + tokenWidth <= width) {
        current += token;
        currentWidth += tokenWidth;
        continue;
      }
      if (/^\s+$/.test(token)) {
        if (current.trim() !== '') {
          lines.push(current);
          current = indent;
          currentWidth = displayWidth(indent);
        }
        continue;
      }
      // Token itself is too long: hard-break it character by character.
      if (tokenWidth > width - displayWidth(indent)) {
        if (current.trim() !== '' && current !== indent) {
          lines.push(current);
          current = indent;
          currentWidth = displayWidth(indent);
        }
        for (const ch of token) {
          const w = displayWidth(ch);
          if (currentWidth + w > width) {
            lines.push(current);
            current = indent;
            currentWidth = displayWidth(indent);
          }
          current += ch;
          currentWidth += w;
        }
        continue;
      }
      lines.push(current.trimEnd());
      current = indent + token;
      currentWidth = displayWidth(indent) + tokenWidth;
    }
    lines.push(current.trimEnd());
  }
  return lines;
}

/** Terminal dimensions with sensible fallbacks. */
export function terminalSize(stream = process.stdout) {
  const columns = Number(stream?.columns) || Number(process.env.COLUMNS) || 100;
  const rows = Number(stream?.rows) || Number(process.env.LINES) || 30;
  return { columns: Math.max(40, columns), rows: Math.max(10, rows) };
}
