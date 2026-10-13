/**
 * ANSI → HTML renderer for the README screenshots.
 *
 * Screenshots are rendered from the *actual* terminal output of the real UI
 * components, never hand-drawn, so the images cannot drift away from what the
 * tool prints. Re-running `npm run screenshots` after a layout change updates
 * them.
 *
 * HTML (rather than SVG) is used because it is rasterised by a real browser,
 * which brings correct font fallback for bold/italic, box-drawing glyphs and
 * colour emoji — none of which a bare SVG rasteriser handles well.
 *
 * The ANSI subset emitted by `src/util/ansi.js` is small (SGR codes only), so
 * the decoder below is a focused state machine, not a terminal emulator.
 */

/** Catppuccin-adjacent dark palette, tuned for legibility on GitHub. */
export const THEME = {
  background: '#0f1117',
  titleBar: '#171a21',
  border: '#2a3040',
  foreground: '#c9d1d9',
  bold: '#f2f5f8',
  dim: '#6b7280',
  red: '#ff7b72',
  green: '#7ee787',
  yellow: '#e3b341',
  blue: '#79c0ff',
  magenta: '#d2a8ff',
  cyan: '#56d4dd',
  white: '#ffffff',
  inverseBackground: '#c9d1d9',
  inverseForeground: '#0f1117',
};

/**
 * SGR "off" codes, emitted by `src/util/ansi.js` so that styles compose. The
 * renderer has to understand them or an attribute never turns off again.
 */
const SGR_OFF = {
  22: ['bold', 'dim'],
  23: ['italic'],
  24: ['underline'],
  27: ['inverse'],
  39: ['color'],
};

/** SGR code → palette slot. */
const SGR = {
  1: 'bold',
  2: 'dim',
  3: 'italic',
  7: 'inverse',
  31: 'red',
  32: 'green',
  33: 'yellow',
  34: 'blue',
  35: 'magenta',
  36: 'cyan',
  37: 'foreground',
  90: 'dim',
  91: 'red',
  92: 'green',
  93: 'yellow',
  94: 'blue',
  95: 'magenta',
  96: 'cyan',
  97: 'white',
};

/**
 * @typedef {Object} Run
 * @property {string} text
 * @property {string} color
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {boolean} inverse
 */

/**
 * Split a line containing SGR escapes into styled runs.
 * @param {string} line
 * @returns {Run[]}
 */
export function parseAnsiLine(line) {
  /** @type {Run[]} */
  const runs = [];
  let color = THEME.foreground;
  let bold = false;
  let italic = false;
  let inverse = false;
  let buffer = '';

  const flush = () => {
    if (buffer === '') return;
    runs.push({ text: buffer, color, bold, italic, inverse });
    buffer = '';
  };

  let i = 0;
  while (i < line.length) {
    if (line.charCodeAt(i) === 0x1b) {
      const sgr = /^\u001b\[([0-9;]*)m/.exec(line.slice(i));
      if (sgr) {
        flush();
        const codes = sgr[1] === '' ? [0] : sgr[1].split(';').map(Number);
        for (const code of codes) {
          if (code === 0) {
            color = THEME.foreground;
            bold = false;
            italic = false;
            inverse = false;
            continue;
          }
          const off = SGR_OFF[code];
          if (off) {
            for (const attribute of off) {
              if (attribute === 'color') color = THEME.foreground;
              else if (attribute === 'bold') bold = false;
              else if (attribute === 'dim') bold = false;
              else if (attribute === 'italic') italic = false;
              else if (attribute === 'inverse') inverse = false;
            }
            continue;
          }
          const slot = SGR[code];
          if (slot === 'bold') bold = true;
          else if (slot === 'italic') italic = true;
          else if (slot === 'inverse') inverse = true;
          else if (slot) color = THEME[slot];
        }
        i += sgr[0].length;
        continue;
      }
      const other = /^\u001b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i));
      i += other ? other[0].length : 1;
      continue;
    }
    buffer += line[i];
    i += 1;
  }
  flush();
  return runs;
}

/** Escape text for inclusion in HTML. */
export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render one ANSI line as HTML spans.
 * @param {string} line
 */
function lineToHtml(line) {
  const runs = parseAnsiLine(line);
  if (runs.length === 0) return '&nbsp;';
  return runs
    .map((run) => {
      const styles = [];
      if (run.inverse) {
        styles.push(`background:${THEME.inverseBackground}`, `color:${THEME.inverseForeground}`);
      } else {
        styles.push(`color:${run.color}`);
      }
      if (run.bold) styles.push('font-weight:700');
      if (run.italic) styles.push('font-style:italic');
      // Trailing spaces would collapse; `pre` preserves them, but a span that is
      // *only* spaces still needs to survive.
      const text = escapeHtml(run.text).replace(/ /g, '&nbsp;');
      return `<span style="${styles.join(';')}">${text}</span>`;
    })
    .join('');
}

/**
 * Build a self-contained HTML page showing a terminal window.
 *
 * @param {{
 *   lines: string[],
 *   title?: string,
 *   fontSize?: number,
 *   padding?: number,
 *   chrome?: boolean,
 * }} options
 * @returns {string}
 */
export function renderTerminalHtml(options) {
  const fontSize = options.fontSize ?? 13;
  const padding = options.padding ?? 18;
  const chrome = options.chrome !== false;
  const lineHeight = Math.round(fontSize * 1.4 * 100) / 100;
  // Joined with no separator on purpose: `.l` is a block element, and any
  // whitespace between the divs would be preserved (and rendered as a blank
  // line) by `white-space: pre`.
  const body = options.lines.map((line) => `<div class="l">${lineToHtml(line)}</div>`).join('');

  const bar = chrome
    ? `<div class="bar">
      <span class="dot" style="background:#ff5f57"></span>
      <span class="dot" style="background:#febc2e"></span>
      <span class="dot" style="background:#28c840"></span>
      <span class="title">${escapeHtml(options.title ?? '')}</span>
    </div>`
    : '';

  return `<!doctype html>
<meta charset="utf-8">
<title>extralife screenshot</title>
<style>
  html, body {
    margin: 0; padding: 0;
    background: transparent;
    width: max-content;
  }
  .window {
    display: inline-block;
    min-width: max-content;
    background: ${THEME.background};
    border: 1px solid ${THEME.border};
    border-radius: 11px;
    overflow: hidden;
    font-family: Menlo, "SF Mono", "DejaVu Sans Mono", monospace;
    font-size: ${fontSize}px;
    line-height: ${lineHeight}px;
    -webkit-font-smoothing: antialiased;
  }
  .bar {
    position: relative;
    height: ${Math.round(fontSize * 2.2)}px;
    background: ${THEME.titleBar};
    border-bottom: 1px solid ${THEME.border};
  }
  .dot {
    position: absolute; top: 50%; margin-top: -5px;
    width: 10px; height: 10px; border-radius: 50%;
  }
  .dot:nth-of-type(1) { left: 16px; }
  .dot:nth-of-type(2) { left: 34px; }
  .dot:nth-of-type(3) { left: 52px; }
  .title {
    position: absolute; left: 0; right: 0; top: 50%;
    transform: translateY(-50%);
    text-align: center;
    color: ${THEME.dim};
    font-size: ${fontSize - 1}px;
  }
  .body {
    padding: ${padding}px ${padding + 4}px;
    color: ${THEME.foreground};
  }
  .l {
    height: ${lineHeight}px;
    line-height: ${lineHeight}px;
    white-space: pre;
  }
</style>
<div class="window" id="window">
  ${bar}
  <div class="body">
${body}
  </div>
</div>
<script>
  // Report the window's exact pixel size so the caller can size the browser
  // viewport to it precisely, instead of guessing at font metrics or trying to
  // trim a screenshot by pixel inspection.
  const box = document.getElementById('window').getBoundingClientRect();
  document.documentElement.setAttribute(
    'data-size',
    Math.ceil(box.width) + 'x' + Math.ceil(box.height),
  );
</script>
`;
}
