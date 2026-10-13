/**
 * The session picker screen.
 *
 * Shows every Codex thread as a single aligned row and, for the highlighted
 * row, a detail pane. The pane is filled in two stages: cheap facts that came
 * from the index are shown immediately, then the transcript is parsed in the
 * background (debounced, cancellable) to add real counts. That keeps the list
 * instant while still letting the user judge a session before choosing it.
 */

import { createStyle, displayWidth, pad, truncate } from '../util/ansi.js';
import { formatBytes, formatDateTime, formatTokens, relativeTime } from '../util/format.js';
import { listPrompt } from './prompts.js';

/**
 * @typedef {import('../codex/index-cache.js').SessionListEntry} SessionListEntry
 */

/**
 * Identity style used for the highlighted row. The list wraps that row in an
 * inverse-video block, so the row must carry no styling of its own: inner
 * colours would both fight the inverted background and, historically, cancel
 * the highlight entirely.
 */
const PLAIN = createStyle(false);

/**
 * @param {import('./terminal.js').Terminal} term
 * @param {SessionListEntry[]} entries
 * @param {{
 *   home?: string,
 *   includeArchived?: boolean,
 *   enrich?: (entry: SessionListEntry) => Promise<any>,
 * }} [opts]
 * @returns {Promise<SessionListEntry|null>}
 */
export async function pickSession(term, entries, opts = {}) {
  const s = term.style;

  if (entries.length === 0) return null;

  /** @type {Map<string, { loading: boolean, error?: string, stats?: any }>} */
  const enrichCache = new Map();
  /** @type {NodeJS.Timeout|null} */
  let debounce = null;
  let redraw = () => {};

  const scheduleEnrich = (entry) => {
    const key = keyOfEntry(entry);
    if (enrichCache.has(key) || !opts.enrich) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      debounce = null;
      enrichCache.set(key, { loading: true });
      redraw();
      try {
        const stats = await opts.enrich?.(entry);
        // Cache regardless of whether the user has moved on — they may return.
        enrichCache.set(key, { loading: false, stats });
      } catch (error) {
        enrichCache.set(key, { loading: false, error: String(error?.message ?? error) });
      }
      redraw();
    }, 120);
    debounce.unref?.();
  };

  const result = await listPrompt(term, {
    title: 'ExtraLife · 续命 — choose a session',
    subtitle: opts.home ? `reading ${opts.home}` : undefined,
    items: entries,
    keyOf: keyOfEntry,
    searchText: (entry) =>
      [entry.title, entry.projectLabel, entry.cwd, entry.gitBranch, entry.preview, entry.id].join(' '),
    renderRow: (entry, ctx) => renderRow(entry, ctx.width, s, ctx.active),
    renderDetail: (entry, width) => {
      scheduleEnrich(entry);
      return renderDetail(entry, width, s, enrichCache.get(keyOfEntry(entry)));
    },
    emptyMessage: 'no session matches — try a shorter search, or press esc to clear',
    footer: 'Sessions live in ~/.codex/sessions · set CODEX_HOME to point elsewhere',
    onReady: (api) => {
      redraw = api.redraw;
    },
  });

  if (debounce) clearTimeout(debounce);
  return /** @type {SessionListEntry|null} */ (result);
}

/** @param {SessionListEntry} entry */
function keyOfEntry(entry) {
  return entry.file;
}

/**
 * Render one list row with adaptive columns.
 *
 * @param {SessionListEntry} entry
 * @param {number} width
 * @param {any} s
 * @param {boolean} active
 */
function renderRow(entry, width, s, active) {
  // On the active row every column is rendered unstyled so the inverse-video
  // highlight covers the whole row cleanly.
  const st = active ? PLAIN : s;
  const status = entry.exhaustedReason ? st.red('💀') : entry.archived ? st.dim('▤ ') : '  ';
  const age = relativeTime(entry.lastActivityMs)
    .replace(' ago', '')
    .replace('just now', 'now');

  // Column widths shrink on narrow terminals so the title never disappears.
  const projectWidth = width >= 100 ? 24 : width >= 80 ? 18 : 12;
  const branchWidth = width >= 100 ? 12 : width >= 80 ? 9 : 0;
  const ageWidth = 7;
  const sizeWidth = width >= 90 ? 8 : 0;

  // Every column is padded to a fixed display width. Concatenating
  // variable-width pieces would let a short title shift the age and size
  // columns left, which reads as a broken table.
  const project = st.bold(pad(truncate(entry.projectLabel, projectWidth), projectWidth));
  const branch =
    branchWidth > 0
      ? st.magenta(pad(truncate(entry.gitBranch || '—', branchWidth), branchWidth))
      : '';
  const ageText = pad(age, ageWidth, 'right');
  const ageColoured =
    entry.lastActivityMs > Date.now() - 86_400_000 ? st.green(ageText) : st.dim(ageText);
  const titleWidth = Math.max(
    10,
    width - projectWidth - (branchWidth > 0 ? branchWidth + 1 : 0) - ageWidth - (sizeWidth > 0 ? sizeWidth + 1 : 0) - 3,
  );
  const titleText = pad(truncate(entry.title, titleWidth), titleWidth);
  const title = active ? st.bold(titleText) : titleText;
  const size = sizeWidth > 0 ? st.dim(pad(formatBytes(entry.sizeBytes), sizeWidth, 'right')) : '';

  const columns = [project];
  if (branchWidth > 0) columns.push(branch);
  columns.push(title, ageColoured);
  if (size) columns.push(size);
  return `${status} ${columns.join(' ')}`;
}

/**
 * Render the detail pane for the highlighted session.
 *
 * @param {SessionListEntry} entry
 * @param {number} width
 * @param {any} s
 * @param {{ loading: boolean, error?: string, stats?: any }|undefined} extra
 */
function renderDetail(entry, width, s, extra) {
  /** @type {string[]} */
  const lines = [];
  const label = (/** @type {string} */ text) => s.dim(pad(text, 10));

  lines.push(label('cwd') + truncate(entry.cwd || '(unknown)', width - 10));
  lines.push(
    label('session') +
      truncate(
        [
          entry.id || '(no id)',
          entry.cliVersion ? `cli ${entry.cliVersion}` : '',
          entry.originator || '',
          entry.archived ? 'archived' : '',
        ]
          .filter(Boolean)
          .join('  ·  '),
        width - 10,
      ),
  );
  lines.push(
    label('last used') +
      `${formatDateTime(entry.lastActivityMs)} (${relativeTime(entry.lastActivityMs)})  ·  ${formatBytes(entry.sizeBytes)} on disk`,
  );

  // Quota line — the reason this tool exists, so it gets the strongest styling.
  if (entry.exhaustedReason) {
    const resetText = entry.resetsAtMs ? ` — resets ${relativeTime(entry.resetsAtMs)}` : '';
    lines.push(label('quota') + s.red(`💀 exhausted: ${entry.exhaustedReason}${resetText}`));
  } else if (entry.primaryUsedPercent !== undefined) {
    const primary = `${entry.primaryUsedPercent.toFixed(0)}%`;
    const secondary =
      entry.secondaryUsedPercent !== undefined ? ` / weekly ${entry.secondaryUsedPercent.toFixed(0)}%` : '';
    const resetText = entry.resetsAtMs ? `  ·  resets ${relativeTime(entry.resetsAtMs)}` : '';
    lines.push(label('quota') + `${s.yellow(primary)}${secondary}${s.dim(resetText)}`);
  } else {
    lines.push(label('quota') + s.dim('no usage recorded for this session'));
  }

  if (extra?.loading) {
    lines.push(label('contents') + s.dim('reading transcript…'));
  } else if (extra?.error) {
    lines.push(label('contents') + s.red(`could not parse: ${extra.error}`));
  } else if (extra?.stats) {
    const st = extra.stats;
    lines.push(
      label('contents') +
        [
          `${st.messages} messages`,
          `${st.turns} turns`,
          `${st.fileChanges} file edits`,
          `${st.commands} commands${st.failedCommands ? ` (${st.failedCommands} failed)` : ''}`,
          st.plans ? `${st.plans} plan${st.plans === 1 ? '' : 's'}` : '',
          st.totalTokens ? `${formatTokens(st.totalTokens)} tokens` : '',
        ]
          .filter(Boolean)
          .join('  ·  '),
    );
    if (st.topFiles?.length) {
      lines.push(label('files') + truncate(st.topFiles.join('  '), width - 10));
    }
  }

  if (entry.preview) {
    lines.push(label('first ask') + s.italic(truncate(entry.preview, width - 10)));
  }

  return lines;
}

/**
 * Compute the summary statistics shown in the detail pane from a parsed
 * session. Kept here (rather than in the parser) because it is a presentation
 * concern.
 *
 * @param {any} session
 * @param {string} [cwd]
 */
export function summarizeSession(session, cwd) {
  const relative = (/** @type {string} */ p) =>
    cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p;
  const counts = new Map();
  for (const change of session.fileChanges) {
    const path = relative(change.path);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  const topFiles = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([path, n]) => (n > 1 ? `${path}×${n}` : path));

  return {
    messages: session.messages.length,
    turns: session.turns.length,
    fileChanges: session.fileChanges.length,
    commands: session.commands.length,
    failedCommands: session.commands.filter((/** @type {any} */ c) => c.status === 'failed').length,
    plans: session.plans.length,
    totalTokens: session.usage?.total_tokens ?? 0,
    topFiles,
  };
}

export { displayWidth };
