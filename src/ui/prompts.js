/**
 * Interactive prompt components: searchable list (single/multi select),
 * text input and confirmation.
 *
 * All of them draw a full frame through `Terminal.draw` on every state change.
 * Full-frame redraws are the right trade-off here: the frames are small (a few
 * dozen rows), and it removes an entire class of incremental-update bugs.
 */

import { displayWidth, pad, truncate, wrap } from '../util/ansi.js';
import { fuzzyFilter } from '../util/fuzzy.js';

const BOX = {
  tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│',
  ltee: '├', rtee: '┤',
};

const POINTER = '❯';
const CHECK_ON = '◉';
const CHECK_OFF = '◯';

/**
 * @typedef {Object} ListPromptOptions<T>
 * @property {string} title
 * @property {string} [subtitle]
 * @property {T[]} items
 * @property {(item: T, ctx: { active: boolean, selected: boolean, width: number, index: number }) => string} renderRow
 * @property {(item: T, width: number) => string[]} [renderDetail]
 * @property {(item: T) => string} [searchText]
 * @property {boolean} [multi]
 * @property {boolean} [searchable]
 * @property {string} [initialQuery]
 * @property {T[]} [initialSelected]
 * @property {string} [footer]
 * @property {string} [emptyMessage]
 * @property {(item: T) => string} [keyOf]
 * @property {(key: import('./terminal.js').KeyEvent, state: any) => boolean|void} [onKey]
 * @property {(api: { redraw: () => void }) => void} [onReady]
 * @property {number} [minRows]
 */

/**
 * Run a searchable selection list.
 *
 * @template T
 * @param {import('./terminal.js').Terminal} term
 * @param {ListPromptOptions<T>} options
 * @returns {Promise<T | T[] | null>} the chosen item(s), or null when cancelled
 */
export async function listPrompt(term, options) {
  const s = term.style;
  const keyOf = options.keyOf ?? ((item) => String(item));
  const searchText = options.searchText ?? keyOf;
  const multi = Boolean(options.multi);

  /** @type {any} */
  const state = {
    query: options.initialQuery ?? '',
    active: 0,
    selected: new Set((options.initialSelected ?? []).map(keyOf)),
    help: false,
    message: '',
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (/** @type {T | T[] | null} */ value) => {
      if (settled) return;
      settled = true;
      offKey();
      offResize();
      term.cursor(true);
      resolve(value);
    };

    const computeFiltered = () => {
      const ranked = fuzzyFilter(options.items, state.query, searchText);
      return ranked.map((entry) => entry.item);
    };

    let filtered = computeFiltered();

    const clampActive = () => {
      if (filtered.length === 0) {
        state.active = 0;
        return;
      }
      state.active = Math.max(0, Math.min(state.active, filtered.length - 1));
    };

    const draw = () => {
      const { columns, rows } = term.size();
      const width = Math.min(columns, 140);
      /** @type {string[]} */
      const lines = [];

      // ── Header ────────────────────────────────────────────────────────────
      // A long title must be clipped to the box, not allowed to push the
      // right border off the edge of a narrow terminal.
      const titleText = truncate(` ${options.title} `, Math.max(0, width - 3));
      const headerFill = Math.max(0, width - 3 - displayWidth(titleText));
      lines.push(s.cyan(BOX.tl + BOX.h) + s.bold(s.cyan(titleText)) + s.cyan(BOX.h.repeat(headerFill) + BOX.tr));

      if (options.subtitle) {
        for (const line of wrap(options.subtitle, width - 4).slice(0, 2)) {
          lines.push(s.cyan(BOX.v) + ' ' + s.dim(pad(truncate(line, width - 3), width - 3)) + s.cyan(BOX.v));
        }
      }

      // ── Search field ──────────────────────────────────────────────────────
      if (options.searchable !== false) {
        const label = s.dim('search ');
        const cursor = s.inverse(' ');
        const queryDisplay = truncate(state.query, width - 12, { ellipsis: '…' });
        const counter = s.dim(`${filtered.length}/${options.items.length}`);
        const inner = label + queryDisplay + cursor;
        // Row layout is [│][space][inner][padding][counter][space][│], i.e.
        // 4 fixed columns around the two variable parts.
        const padding = Math.max(0, width - 4 - displayWidth(inner) - displayWidth(counter));
        lines.push(
          s.cyan(BOX.v) + ' ' + inner + ' '.repeat(padding) + counter + ' ' + s.cyan(BOX.v),
        );
      }

      lines.push(s.cyan(BOX.ltee + BOX.h.repeat(width - 2) + BOX.rtee));

      // ── Help overlay replaces the list when toggled ───────────────────────
      const detailLines = [];
      if (options.renderDetail && filtered[state.active]) {
        detailLines.push(...options.renderDetail(filtered[state.active], width - 4));
      }
      const detailHeight = Math.min(detailLines.length, Math.max(0, Math.floor(rows * 0.35)));
      const bodyRows = Math.max(
        options.minRows ?? 5,
        rows - lines.length - detailHeight - (detailHeight > 0 ? 2 : 0) - 3,
      );

      if (state.help) {
        const help = [
          ['↑ / ↓  or  k / j', 'move selection'],
          ['PgUp / PgDn', 'jump a page'],
          ['type anything', 'fuzzy-filter the list'],
          ["'word", 'exact-substring match'],
          ['backspace', 'delete a character'],
          ['ctrl-u', 'clear the search'],
          ...(multi ? [['space', 'toggle the highlighted item']] : []),
          ...(multi ? [['a', 'select all filtered / none']] : []),
          ['enter', 'continue'],
          ['esc / ctrl-c', 'go back'],
        ];
        for (const [key, description] of help) {
          const body = s.bold(pad(key, 20)) + s.dim(truncate(description, width - 26));
          lines.push(
            s.cyan(BOX.v) + ' ' + pad(body, width - 3) + ' ' + s.cyan(BOX.v),
          );
        }
        while (lines.length < rows - 2) {
          lines.push(s.cyan(BOX.v) + ' '.repeat(width - 2) + s.cyan(BOX.v));
        }
        lines.push(s.cyan(BOX.bl + BOX.h.repeat(width - 2) + BOX.br));
        lines.push(s.dim(truncate('  ? close help', width - 2)));
        term.draw(lines);
        return;
      }

      // ── List body ─────────────────────────────────────────────────────────
      let offset = 0;
      if (state.active >= bodyRows) offset = state.active - bodyRows + 1;
      const visible = filtered.slice(offset, offset + bodyRows);

      if (visible.length === 0) {
        const message = options.emptyMessage ?? 'nothing matches that search';
        lines.push(s.cyan(BOX.v) + ' ' + s.dim(pad(truncate(message, width - 3), width - 3)) + s.cyan(BOX.v));
        for (let i = 1; i < bodyRows; i++) {
          lines.push(s.cyan(BOX.v) + ' '.repeat(width - 2) + s.cyan(BOX.v));
        }
      } else {
        visible.forEach((item, i) => {
          const index = offset + i;
          const active = index === state.active;
          const selected = state.selected.has(keyOf(item));
          const pointer = active ? s.cyan(POINTER) : ' ';
          const mark = multi ? (selected ? s.green(CHECK_ON) : s.dim(CHECK_OFF)) + ' ' : '';
          const rowText = options.renderRow(item, { active, selected, width: width - 8, index });
          const available = width - 6;
          const truncated = truncate(rowText, available, { ellipsis: '…' });
          const filler = ' '.repeat(Math.max(0, available - displayWidth(truncated)));
          const body = active ? s.inverse(truncated + filler) : truncated + filler;
          lines.push(s.cyan(BOX.v) + ' ' + pointer + ' ' + mark + body + ' ' + s.cyan(BOX.v));
        });
        for (let i = visible.length; i < bodyRows; i++) {
          lines.push(s.cyan(BOX.v) + ' '.repeat(width - 2) + s.cyan(BOX.v));
        }
      }

      // ── Detail pane ───────────────────────────────────────────────────────
      if (detailHeight > 0) {
        lines.push(s.cyan(BOX.ltee + BOX.h.repeat(width - 2) + BOX.rtee));
        const shown = detailLines.slice(0, detailHeight);
        for (const line of shown) {
          const truncated = truncate(line, width - 4, { ellipsis: '…' });
          lines.push(
            s.cyan(BOX.v) + ' ' + pad(' ' + truncated, width - 3) + s.cyan(BOX.v),
          );
        }
        for (let i = shown.length; i < detailHeight; i++) {
          lines.push(s.cyan(BOX.v) + ' '.repeat(width - 2) + s.cyan(BOX.v));
        }
      }

      // ── Footer ────────────────────────────────────────────────────────────
      lines.push(s.cyan(BOX.bl + BOX.h.repeat(width - 2) + BOX.br));
      const selectedCount = state.selected.size;
      const hints = multi
        ? `${s.bold('space')} toggle · ${s.bold('a')} all · ${s.bold('enter')} continue (${selectedCount} selected) · ${s.bold('esc')} back`
        : `${s.bold('↑↓')} move · ${s.bold('type')} to filter · ${s.bold('enter')} select · ${s.bold('?')} help · ${s.bold('esc')} quit`;
      lines.push('  ' + truncate(hints, width - 2));
      if (state.message) lines.push('  ' + s.yellow(truncate(state.message, width - 2)));
      if (options.footer) lines.push('  ' + s.dim(truncate(options.footer, width - 2)));

      term.draw(lines);
      term.cursor(options.searchable !== false);
    };

    const offKey = term.onKey((key) => {
      if (options.onKey && options.onKey(key, state) === true) {
        draw();
        return;
      }
      switch (key.name) {
        case 'ctrl-c':
          finish(null);
          return;
        case 'escape':
          if (state.help) {
            state.help = false;
          } else if (state.query !== '') {
            state.query = '';
            filtered = computeFiltered();
            state.active = 0;
          } else {
            finish(null);
            return;
          }
          break;
        case 'up':
        case 'ctrl-p':
          state.active = state.active > 0 ? state.active - 1 : Math.max(0, filtered.length - 1);
          break;
        case 'down':
        case 'ctrl-n':
          state.active = filtered.length === 0 ? 0 : (state.active + 1) % filtered.length;
          break;
        case 'pageup':
          state.active = Math.max(0, state.active - 10);
          break;
        case 'pagedown':
          state.active = Math.min(Math.max(0, filtered.length - 1), state.active + 10);
          break;
        case 'home':
          state.active = 0;
          break;
        case 'end':
          state.active = Math.max(0, filtered.length - 1);
          break;
        case 'backspace':
          if (state.query !== '') {
            state.query = [...state.query].slice(0, -1).join('');
            filtered = computeFiltered();
            state.active = 0;
          }
          break;
        case 'ctrl-u':
          state.query = '';
          filtered = computeFiltered();
          state.active = 0;
          break;
        case 'space':
          if (multi) {
            const item = filtered[state.active];
            if (item !== undefined) {
              const key = keyOf(item);
              if (state.selected.has(key)) state.selected.delete(key);
              else state.selected.add(key);
              if (state.active < filtered.length - 1) state.active++;
            }
          } else if (state.query !== '') {
            state.query += ' ';
            filtered = computeFiltered();
            state.active = 0;
          }
          break;
        case 'enter':
          if (multi) {
            const chosen = options.items.filter((item) => state.selected.has(keyOf(item)));
            if (chosen.length === 0) {
              state.message = 'select at least one item with space';
              break;
            }
            finish(chosen);
            return;
          } else {
            const item = filtered[state.active];
            if (item === undefined) {
              state.message = 'nothing to select';
              break;
            }
            finish(item);
            return;
          }
        case '?':
          state.help = !state.help;
          break;
        default: {
          if (key.name === 'a' && multi && key.ctrl === false && state.query === '') {
            // Only intercept bare `a` when there is no active search, so typing
            // a query that contains "a" still works.
            const allSelected = filtered.length > 0 && filtered.every((i) => state.selected.has(keyOf(i)));
            for (const item of filtered) {
              if (allSelected) state.selected.delete(keyOf(item));
              else state.selected.add(keyOf(item));
            }
            break;
          }
          if (key.char && !key.ctrl && !key.alt) {
            state.query += key.char;
            filtered = computeFiltered();
            state.active = 0;
            state.message = '';
          }
          break;
        }
      }
      clampActive();
      draw();
    });
    const offResize = term.onResize(draw);

    // Hand the caller a way to repaint after asynchronous work (the session
    // picker parses transcripts in the background and must refresh its pane).
    options.onReady?.({ redraw: draw });

    draw();
  });
}

/**
 * Single-line text input.
 *
 * @param {import('./terminal.js').Terminal} term
 * @param {{
 *   title: string,
 *   message?: string,
 *   initial?: string,
 *   placeholder?: string,
 *   validate?: (value: string) => string | null,
 * }} options
 * @returns {Promise<string|null>}
 */
export async function textPrompt(term, options) {
  const s = term.style;
  let value = options.initial ?? '';
  let error = '';

  return new Promise((resolve) => {
    let settled = false;
    const finish = (/** @type {string|null} */ result) => {
      if (settled) return;
      settled = true;
      offKey();
      offResize();
      term.cursor(true);
      resolve(result);
    };

    const draw = () => {
      const { columns, rows } = term.size();
      const width = Math.min(columns, 140);
      const lines = [];
      // A long title must be clipped to the box, not allowed to push the
      // right border off the edge of a narrow terminal.
      const titleText = truncate(` ${options.title} `, Math.max(0, width - 3));
      lines.push(
        s.cyan(BOX.tl + BOX.h) + s.bold(s.cyan(titleText)) +
          s.cyan(BOX.h.repeat(Math.max(0, width - 3 - displayWidth(titleText))) + BOX.tr),
      );
      if (options.message) {
        for (const line of wrap(options.message, width - 4)) {
          lines.push(s.cyan(BOX.v) + ' ' + pad(truncate(line, width - 3), width - 3) + s.cyan(BOX.v));
        }
      }
      lines.push(s.cyan(BOX.v) + ' '.repeat(width - 2) + s.cyan(BOX.v));
      const shown = value === '' && options.placeholder ? s.dim(options.placeholder) : value;
      const body = '  ' + truncate(shown, width - 6) + (value === '' && options.placeholder ? '' : s.inverse(' '));
      lines.push(s.cyan(BOX.v) + pad(body, width - 2) + s.cyan(BOX.v));
      // (row is [│][width-2 content][│])
      lines.push(s.cyan(BOX.v) + ' '.repeat(width - 2) + s.cyan(BOX.v));
      if (error) {
        lines.push(s.cyan(BOX.v) + ' ' + s.red(pad(truncate(error, width - 3), width - 3)) + s.cyan(BOX.v));
      }
      lines.push(s.cyan(BOX.bl + BOX.h.repeat(width - 2) + BOX.br));
      lines.push('  ' + truncate(`${s.bold('enter')} confirm · ${s.bold('esc')} cancel`, width - 2));
      term.draw(lines);
      term.cursor(true);
    };

    const offKey = term.onKey((key) => {
      if (key.name === 'enter') {
        const problem = options.validate ? options.validate(value) : null;
        if (problem) {
          error = problem;
          draw();
          return;
        }
        finish(value);
        return;
      }
      if (key.name === 'escape' || key.name === 'ctrl-c') {
        finish(null);
        return;
      }
      if (key.name === 'backspace') {
        value = [...value].slice(0, -1).join('');
        error = '';
        draw();
        return;
      }
      if (key.name === 'ctrl-u') {
        value = '';
        error = '';
        draw();
        return;
      }
      if (key.char && !key.ctrl && !key.alt) {
        value += key.char;
        error = '';
        draw();
      }
    });
    const offResize = draw;
    term.onResize(offResize);
    draw();
  });
}

/**
 * Yes/no confirmation.
 *
 * @param {import('./terminal.js').Terminal} term
 * @param {{ title: string, message: string, defaultValue?: boolean }} options
 * @returns {Promise<boolean|null>}
 */
export async function confirmPrompt(term, options) {
  const s = term.style;
  const defaultValue = options.defaultValue ?? true;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (/** @type {boolean|null} */ result) => {
      if (settled) return;
      settled = true;
      offKey();
      term.cursor(true);
      resolve(result);
    };

    const draw = () => {
      const { columns } = term.size();
      const width = Math.min(columns, 140);
      const lines = [];
      // A long title must be clipped to the box, not allowed to push the
      // right border off the edge of a narrow terminal.
      const titleText = truncate(` ${options.title} `, Math.max(0, width - 3));
      lines.push(
        s.cyan(BOX.tl + BOX.h) + s.bold(s.cyan(titleText)) +
          s.cyan(BOX.h.repeat(Math.max(0, width - 3 - displayWidth(titleText))) + BOX.tr),
      );
      for (const line of wrap(options.message, width - 4)) {
        lines.push(s.cyan(BOX.v) + ' ' + pad(truncate(line, width - 3), width - 3) + s.cyan(BOX.v));
      }
      lines.push(s.cyan(BOX.v) + ' '.repeat(width - 2) + s.cyan(BOX.v));
      const yes = defaultValue ? s.green(s.bold('[ Yes ]')) : s.dim('[ yes ]');
      const no = defaultValue ? s.dim('[ no ]') : s.red(s.bold('[ No ]'));
      const choices = '  ' + yes + '   ' + no;
      lines.push(s.cyan(BOX.v) + pad(choices, width - 2) + s.cyan(BOX.v));
      lines.push(s.cyan(BOX.bl + BOX.h.repeat(width - 2) + BOX.br));
      lines.push(
        '  ' + truncate(`${s.bold('y/n')} or ${s.bold('←/→')} then ${s.bold('enter')} · ${s.bold('esc')} cancel`, width - 2),
      );
      term.draw(lines);
      term.cursor(false);
    };

    let current = defaultValue;
    const offKey = term.onKey((key) => {
      if (key.name === 'ctrl-c' || key.name === 'escape') return finish(null);
      if (key.name === 'enter') return finish(current);
      if (key.name === 'left' || key.name === 'right' || key.name === 'tab') {
        current = !current;
        return draw();
      }
      if (key.name === 'y') return finish(true);
      if (key.name === 'n') return finish(false);
    });
    draw();
  });
}

export { BOX, POINTER, CHECK_ON, CHECK_OFF };
