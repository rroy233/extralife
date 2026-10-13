/**
 * The export-options screen.
 *
 * Shown after a session is chosen. It lets the user decide what goes into the
 * handoff and see the cost of each decision before committing.
 *
 * The live size estimate is exact rather than approximate: at entry the session
 * is rendered once with every section enabled, and the per-section token counts
 * are then summed for whatever combination is selected. That is cheap (one
 * render) and instant on every keystroke, whereas re-rendering per toggle would
 * cost hundreds of milliseconds on a large transcript.
 */

import { displayWidth, pad, truncate } from '../util/ansi.js';
import { formatTokens } from '../util/format.js';
import { BOX, CHECK_OFF, CHECK_ON } from './prompts.js';

/**
 * Section catalogue, in the order they appear in the document.
 * `required` sections cannot be switched off — a handoff without a mission or a
 * next step is not a handoff.
 */
export const SECTION_CATALOGUE = [
  { id: 'howto', label: 'Instructions for the next agent', hint: 'how to use this document', required: true },
  { id: 'mission', label: 'Mission & original request', hint: "the user's own words", required: true },
  { id: 'next', label: 'Next steps', hint: 'where to resume, and what was interrupted', required: true },
  { id: 'state', label: 'Current state & plan', hint: 'progress, plan checklist, last report' },
  { id: 'deadends', label: 'Failed approaches (do not repeat)', hint: 'what was tried and abandoned' },
  { id: 'constraints', label: 'Constraints & conventions', hint: 'AGENTS.md rules, environment facts' },
  { id: 'files', label: 'Files that matter', hint: 'edited files and files read for context' },
  { id: 'conversation', label: 'Conversation history', hint: 'recent request → outcome pairs' },
  { id: 'diffs', label: 'Unified diffs', hint: 'the exact code changes made' },
  { id: 'commands', label: 'Commands run', hint: 'failures in full, successes digested' },
  { id: 'research', label: 'Research & tool calls', hint: 'web searches and MCP tools used' },
  { id: 'appendix', label: 'Provenance appendix', hint: 'session ids, quota, how to resume in Codex' },
];

/** Keyboard accelerators that set the toggle set wholesale. */
export const PRESETS = {
  1: 'minimal',
  2: 'standard',
  3: 'full',
};

const PRESET_SECTIONS = {
  minimal: ['howto', 'mission', 'state', 'next', 'deadends', 'constraints', 'files', 'appendix'],
  standard: [
    'howto', 'mission', 'state', 'next', 'deadends', 'constraints', 'files',
    'diffs', 'commands', 'research', 'conversation', 'appendix',
  ],
  full: SECTION_CATALOGUE.map((s) => s.id),
};

/** Token budgets cycled with `b`. `null` means "no trimming". */
export const BUDGET_STEPS = [null, 8000, 32000, 128000];

/**
 * @typedef {Object} ExportOptions
 * @property {string[]} sections
 * @property {number|null} budget
 * @property {number} conversationTurns
 */

/**
 * @param {import('./terminal.js').Terminal} term
 * @param {{
 *   session: any,
 *   sectionTokens: Record<string, number>,
 *   initial?: ExportOptions,
 *   documentTokens: number,
 *   documentBytes: number,
 * }} options
 * @returns {Promise<ExportOptions|null>}
 */
export async function exportOptionsScreen(term, options) {
  const s = term.style;
  const { sectionTokens } = options;

  const enabled = new Set(options.initial?.sections ?? PRESET_SECTIONS.standard);
  let budget = options.initial?.budget ?? null;
  let active = 0;

  const togglable = SECTION_CATALOGUE;

  const estimate = () => {
    let total = 0;
    for (const section of togglable) {
      if (enabled.has(section.id)) total += sectionTokens[section.id] ?? 0;
    }
    // The banner and separators add a small, roughly constant overhead.
    return total + 120;
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (/** @type {ExportOptions|null} */ value) => {
      if (settled) return;
      settled = true;
      offKey();
      offResize();
      term.cursor(false);
      resolve(value);
    };

    const draw = () => {
      const { columns, rows } = term.size();
      const width = Math.min(columns, 120);
      /** @type {string[]} */
      const lines = [];

      const titleText = truncate(' ExtraLife · export options ', Math.max(0, width - 3));
      lines.push(
        s.cyan(BOX.tl + BOX.h) + s.bold(s.cyan(titleText)) +
          s.cyan(BOX.h.repeat(Math.max(0, width - 3 - displayWidth(titleText))) + BOX.tr),
      );

      const header = ` ${truncate(options.session.title, width - 4)}`;
      lines.push(s.cyan(BOX.v) + pad(truncate(header, width - 2), width - 2) + s.cyan(BOX.v));
      const sub = `  ${truncate(options.session.projectLabel ?? options.session.cwd ?? '', Math.max(4, width - 24))}  ·  ${formatTokens(estimate())} tokens`;
      lines.push(s.cyan(BOX.v) + s.dim(pad(truncate(sub, width - 2), width - 2)) + s.cyan(BOX.v));
      lines.push(s.cyan(BOX.ltee + BOX.h.repeat(width - 2) + BOX.rtee));

      togglable.forEach((section, index) => {
        const on = enabled.has(section.id);
        const isActive = index === active;
        const mark = on ? s.green(CHECK_ON) : s.dim(CHECK_OFF);
        const lock = section.required ? s.dim(' (always)') : '';
        const cost = on ? s.dim(`${formatTokens(sectionTokens[section.id] ?? 0)} tok`) : s.dim('     ');
        const labelWidth = Math.max(20, width - 30);
        const label = truncate(section.label, labelWidth);
        const rowText =
          `${mark} ${pad(label, labelWidth)} ${pad(cost, 9, 'right')}${lock}`;
        const padded = pad(truncate(rowText, width - 4), width - 4);
        lines.push(
          s.cyan(BOX.v) + ' ' + (isActive ? s.inverse(padded) : padded) + ' ' + s.cyan(BOX.v),
        );
      });

      lines.push(s.cyan(BOX.ltee + BOX.h.repeat(width - 2) + BOX.rtee));

      const budgetLabel = budget === null ? 'no limit (full detail)' : `${formatTokens(budget)} tokens`;
      const overshoot = budget !== null && estimate() > budget;
      const sizeLine =
        ` budget      ${budgetLabel}` +
        (overshoot ? s.yellow('  → will be trimmed to fit') : '');
      lines.push(s.cyan(BOX.v) + pad(truncate(' ' + sizeLine, width - 2), width - 2) + s.cyan(BOX.v));

      const finalLine = ` estimated   ${formatTokens(estimate())} tokens  ·  ~${formatBytes(estimate() * 4)}`;
      lines.push(s.cyan(BOX.v) + pad(truncate(' ' + s.bold(finalLine), width - 2), width - 2) + s.cyan(BOX.v));

      lines.push(s.cyan(BOX.bl + BOX.h.repeat(width - 2) + BOX.br));
      const hints = [
        s.bold('↑↓'), 'move', s.bold('space'), 'toggle', s.bold('1/2/3'),
        'presets', s.bold('b'), 'budget', s.bold('enter'), 'export', s.bold('esc'), 'back',
      ].join(' · ');
      lines.push('  ' + truncate(hints, width - 2));
      term.draw(lines);
      term.cursor(false);
    };

    const offKey = term.onKey((key) => {
      switch (key.name) {
        case 'ctrl-c':
          finish(null);
          return;
        case 'escape':
          finish(null);
          return;
        case 'up':
        case 'ctrl-p':
          active = (active - 1 + togglable.length) % togglable.length;
          break;
        case 'down':
        case 'ctrl-n':
          active = (active + 1) % togglable.length;
          break;
        case 'home':
          active = 0;
          break;
        case 'end':
          active = togglable.length - 1;
          break;
        case 'space':
        case 'enter': {
          const section = togglable[active];
          if (key.name === 'enter' && !key.shift) {
            // Enter on the list means "accept and export", matching the footer.
            finish({ sections: [...enabled], budget, conversationTurns: 8 });
            return;
          }
          if (!section.required) {
            if (enabled.has(section.id)) enabled.delete(section.id);
            else enabled.add(section.id);
          }
          break;
        }
        case 'b': {
          const index = BUDGET_STEPS.indexOf(budget);
          budget = BUDGET_STEPS[(index + 1) % BUDGET_STEPS.length];
          break;
        }
        case 'tab':
          active = (active + 1) % togglable.length;
          break;
        default: {
          if (PRESETS[key.name]) {
            const preset = PRESET_SECTIONS[PRESETS[key.name]];
            if (preset) {
              enabled.clear();
              for (const id of preset) enabled.add(id);
            }
          }
          break;
        }
      }
      draw();
    });
    const offResize = draw;
    term.onResize(offResize);

    draw();
  });
}

/** Rough byte estimate from a token count, used for the preview line. */
function formatBytes(tokens) {
  const bytes = tokens * 3.6;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export { PRESET_SECTIONS };
