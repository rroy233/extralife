/**
 * Command-line interface for ExtraLife.
 *
 * Zero-dependency argument parsing, a small set of orthogonal flags, and a
 * single interactive path that degrades to non-interactive when stdin is not a
 * TTY (so the tool composes in scripts and CI).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { buildSessionIndex, cacheDir } from './codex/index-cache.js';
import { codexHome, inspectCodexHome } from './codex/locate.js';
import { parseSessionFile } from './codex/parse.js';
import { renderHandoff } from './render/handoff.js';
import { renderJson } from './render/json.js';
import { renderMarkdown } from './render/markdown.js';
import { displayWidth, pad, truncate } from './util/ansi.js';
import {
  formatBytes,
  formatDateTime,
  formatTokens,
  relativeTime,
  slugify,
} from './util/format.js';
import { exportOptionsScreen, PRESET_SECTIONS } from './ui/options.js';
import { pickSession, summarizeSession } from './ui/picker.js';
import { Terminal } from './ui/terminal.js';
import { createStyle } from './util/ansi.js';

const VERSION = '1.0.0';

/** Flag specification — drives both parsing and `--help`. */
const FLAGS = {
  help: { type: 'boolean', alias: 'h', describe: 'Show this help and exit' },
  version: { type: 'boolean', alias: 'v', describe: 'Print the version and exit' },
  list: { type: 'boolean', alias: 'l', describe: 'List sessions as a table instead of opening the picker' },
  yes: { type: 'boolean', alias: 'y', describe: 'Skip the options screen and export with defaults' },
  here: { type: 'boolean', describe: 'Only consider sessions whose project is the current directory' },
  cwd: { type: 'string', describe: 'Only consider sessions whose project is under <dir>' },
  all: { type: 'boolean', describe: 'Include non-interactive threads (auto security reviews)' },
  archived: { type: 'boolean', describe: 'Include archived sessions' },
  out: { type: 'string', alias: 'o', describe: 'Output path (default: ./extralife-<project>-<time>.txt)' },
  stdout: { type: 'boolean', describe: 'Write the handoff to stdout instead of a file' },
  copy: { type: 'boolean', describe: 'Copy the handoff to the system clipboard' },
  format: { type: 'string', describe: 'Output format: handoff (default) | markdown | json' },
  detail: { type: 'string', describe: 'Detail presets: minimal | standard (default) | full' },
  budget: { type: 'string', describe: 'Soft token budget, e.g. 32000 or 32k' },
  sections: { type: 'string', describe: 'Comma-separated section ids (see --help-sections)' },
  turns: { type: 'string', describe: 'Number of conversation turns to include (default: 8)' },
  home: { type: 'string', describe: 'Codex home directory (default: $CODEX_HOME or ~/.codex)' },
  'no-color': { type: 'boolean', describe: 'Disable ANSI colour' },
  'no-cache': { type: 'boolean', describe: 'Ignore the on-disk session index cache' },
  'no-redact': { type: 'boolean', describe: 'Do NOT scrub credentials from the output (redaction is on by default)' },
  'help-sections': { type: 'boolean', describe: 'List the available handoff sections and exit' },
  json: { type: 'boolean', describe: 'Shorthand for --format json --stdout' },
  quiet: { type: 'boolean', alias: 'q', describe: 'Suppress progress and summary output' },
};

const POSITIONAL_USAGE = '[session-id | transcript-path]';

/**
 * Parse argv into `{ flags, positionals, errors }`.
 * Supports `--flag`, `--flag=value`, `--flag value`, `-a`, and `--no-<flag>`
 * negation for booleans.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const flags = {};
  /** @type {string[]} */
  const positionals = [];
  /** @type {string[]} */
  const errors = [];

  const byAlias = new Map();
  for (const [name, spec] of Object.entries(FLAGS)) {
    if (spec.alias) byAlias.set(spec.alias, name);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      const rawName = eq === -1 ? body : body.slice(0, eq);
      let value = eq === -1 ? undefined : body.slice(eq + 1);

      // `--no-x` negation for booleans.
      let name = rawName;
      let negated = false;
      if (!FLAGS[name] && rawName.startsWith('no-') && FLAGS[rawName.slice(3)]?.type === 'boolean') {
        name = rawName.slice(3);
        negated = true;
      }
      const spec = FLAGS[name];
      if (!spec) {
        errors.push(`unknown option \`--${rawName}\``);
        continue;
      }
      if (spec.type === 'boolean') {
        if (negated) {
          flags[name] = false;
        } else if (value === undefined) {
          flags[name] = true;
        } else {
          flags[name] = value !== 'false' && value !== '0';
        }
        continue;
      }
      // String flag: take the next argv entry when no `=` was used.
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('-') && next !== '-')) {
          errors.push(`option \`--${name}\` needs a value`);
          continue;
        }
        value = next;
        i++;
      }
      flags[name] = value;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const short = arg.slice(1);
      // Support bundled short booleans like `-ly`.
      let consumed = false;
      for (let c = 0; c < short.length; c++) {
        const name = byAlias.get(short[c]);
        if (!name) {
          errors.push(`unknown option \`-${short[c]}\``);
          consumed = true;
          break;
        }
        const spec = FLAGS[name];
        if (spec.type === 'boolean') {
          flags[name] = true;
          continue;
        }
        // A string flag must be last in the bundle.
        const rest = short.slice(c + 1);
        const next = rest !== '' ? rest : argv[i + 1];
        if (next === undefined) {
          errors.push(`option \`-${short[c]}\` needs a value`);
        } else {
          flags[name] = next;
          if (rest === '') i++;
        }
        consumed = true;
        break;
      }
      if (consumed) continue;
      continue;
    }
    positionals.push(arg);
  }

  return { flags, positionals, errors };
}

/** Parse a human token count such as `32000`, `32k`, `1.5M`. */
export function parseTokenCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim().toLowerCase().replace(/[_,]/g, '');
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(text);
  if (!match) return null;
  const number = Number.parseFloat(match[1]);
  const scale = match[2] === 'k' ? 1000 : match[2] === 'm' ? 1_000_000 : 1;
  const result = Math.round(number * scale);
  return Number.isFinite(result) && result > 0 ? result : null;
}

/**
 * Entry point. Returns the process exit code.
 *
 * `io` exists so the interactive path can be driven from tests with fake TTY
 * streams; production callers never pass it.
 *
 * @param {string[]} [argv]
 * @param {{ stdin?: any, stdout?: any, stderr?: any }} [io]
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const { flags, positionals, errors } = parseArgs(argv);
  const colorFlag = flags['no-color'] ? false : null;
  const style = createStyle(colorFlag === null ? Boolean(stdout.isTTY) : colorFlag);

  if (errors.length > 0) {
    for (const error of errors) stderr.write(`${style.red('error')} ${error}\n`);
    stderr.write(`\nRun \`extralife --help\` for usage.\n`);
    return 2;
  }
  if (flags.help) {
    stdout.write(helpText());
    return 0;
  }
  if (flags.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flags['help-sections']) {
    stdout.write(sectionsHelpText());
    return 0;
  }

  const home = flags.home ? path.resolve(String(flags.home)) : codexHome();

  // ── Resolve the Codex home ────────────────────────────────────────────────
  const inspection = await inspectCodexHome(home);
  if (!inspection.ok) {
    stderr.write(
      `${style.red('error')} ${inspection.reason}\n\n` +
        `ExtraLife reads Codex session transcripts. If Codex is installed elsewhere,\n` +
        `point at it explicitly:\n\n  extralife --home /path/to/.codex\n\n` +
        `or set the CODEX_HOME environment variable.\n`,
    );
    return 3;
  }

  // Shorthands.
  if (flags.json) {
    // `--json` is an explicit request for a machine-readable stdout stream.
    flags.format = 'json';
    flags.stdout = true;
  }
  const format = String(flags.format ?? 'handoff').toLowerCase();
  if (!['handoff', 'markdown', 'md', 'json'].includes(format)) {
    stderr.write(`${style.red('error')} unknown --format \`${format}\` (expected handoff, markdown or json)\n`);
    return 2;
  }
  const detail = String(flags.detail ?? 'standard').toLowerCase();
  if (!['minimal', 'standard', 'full'].includes(detail)) {
    stderr.write(`${style.red('error')} unknown --detail \`${detail}\` (expected minimal, standard or full)\n`);
    return 2;
  }
  const budget = flags.budget === undefined ? null : parseTokenCount(flags.budget);
  if (flags.budget !== undefined && budget === null) {
    stderr.write(`${style.red('error')} could not read --budget \`${flags.budget}\` (try 32000 or 32k)\n`);
    return 2;
  }
  const conversationTurns = flags.turns === undefined ? 8 : Number.parseInt(String(flags.turns), 10);
  if (!Number.isFinite(conversationTurns) || conversationTurns < 0) {
    stderr.write(`${style.red('error')} --turns must be a non-negative integer\n`);
    return 2;
  }

  // Validate --sections before touching the filesystem: a typo should fail
  // fast and identically whether or not a session was named.
  /** @type {string[]|null} */
  let requestedSections = null;
  if (flags.sections !== undefined) {
    const requested = String(flags.sections)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const unknown = requested.filter((entry) => !(entry in SECTION_TOKEN_KEYS));
    if (unknown.length > 0) {
      stderr.write(
        `${style.red('error')} unknown section(s): ${unknown.join(', ')}\n` +
          `Run \`extralife --help-sections\` to see the list.\n`,
      );
      return 2;
    }
    // The three mandatory sections are always present.
    requestedSections = [...new Set([...PRESET_SECTIONS.minimal.slice(0, 3), ...requested])];
  }

  const quiet = Boolean(flags.quiet) || Boolean(flags.stdout) || format !== 'handoff';

  // ── Build the index ───────────────────────────────────────────────────────
  const explicitTarget = positionals[0];
  const needsPicker = !explicitTarget;

  /** @type {import('./codex/index-cache.js').SessionListEntry[]} */
  let entries = [];
  if (needsPicker || flags.list) {
    const started = Date.now();
    entries = await buildSessionIndex({
      home,
      includeArchived: Boolean(flags.archived),
      includeNonInteractive: Boolean(flags.all),
      useCache: !flags['no-cache'],
      onProgress: quiet
        ? undefined
        : (done, total) => {
            if (stderr.isTTY && total > 40) {
              stderr.write(`\r${style.dim(`indexing sessions… ${done}/${total}`)}`);
            }
          },
    });
    if (!quiet && stderr.isTTY) stderr.write('\r\u001b[K');
    if (!quiet && !stderr.isTTY && Date.now() - started > 1500) {
      stderr.write(`indexed ${entries.length} sessions in ${Date.now() - started}ms\n`);
    }
  }

  if (flags.list) {
    printList(filterEntries(entries, flags), style, stdout);
    return 0;
  }

  // ── Choose a session ──────────────────────────────────────────────────────
  const interactive = Boolean(stdin.isTTY && stdout.isTTY);
  const terminal = new Terminal({ color: colorFlag, stdin, stdout });

  /** @type {import('./codex/index-cache.js').SessionListEntry|null} */
  let chosen = null;

  if (explicitTarget) {
    const resolved = await resolveTarget(explicitTarget, entries, home);
    if (!resolved.ok) {
      stderr.write(`${style.red('error')} ${resolved.reason}\n`);
      if (resolved.suggestions?.length) {
        stderr.write(`\nDid you mean one of these?\n`);
        for (const suggestion of resolved.suggestions) {
          stderr.write(`  ${suggestion.id.slice(0, 12)}  ${truncate(suggestion.title, 60)}\n`);
        }
      }
      return 4;
    }
    chosen = resolved.entry;
  } else {
    if (!interactive) {
      stderr.write(
        `${style.red('error')} no session given and stdin is not a terminal.\n\n` +
          `Pass a session id, or list what is available:\n\n` +
          `  extralife --list\n  extralife <session-id> --stdout > handoff.txt\n`,
      );
      return 2;
    }
    const filtered = filterEntries(entries, flags);
    if (filtered.length === 0) {
      stderr.write(
        `${style.yellow('no sessions found')}${describeFilter(flags, home)}\n`,
      );
      return 5;
    }
    terminal.enter();
    try {
      chosen = await pickSession(terminal, filtered, {
        home,
        enrich: async (entry) => {
          const session = await parseSessionFile(entry.file);
          return summarizeSession(session, session.cwd);
        },
      });
    } finally {
      terminal.restore();
    }
    if (!chosen) {
      stderr.write(`${style.dim('cancelled')}\n`);
      return 130;
    }
  }

  // ── Parse the full session ────────────────────────────────────────────────
  if (!quiet && stderr.isTTY) {
    stderr.write(`${style.dim(`reading ${truncate(chosen.title, 50)}…`)}\r\u001b[K`);
  }
  let session;
  try {
    session = await parseSessionFile(chosen.file);
  } catch (error) {
    stderr.write(`${style.red('error')} could not read the transcript: ${error?.message ?? error}\n`);
    return 6;
  }

  if (session.messages.length === 0 && session.commands.length === 0 && session.fileChanges.length === 0) {
    stderr.write(
      `${style.yellow('warning')} this transcript contains no user messages, commands or file edits.\n` +
        `It may be an automatic review thread. Re-run with ${style.bold('--all')} to see those, or pick another session.\n`,
    );
    if (interactive && !flags.yes) return 7;
  }

  // ── Options screen ────────────────────────────────────────────────────────
  /** @type {{sections: string[], budget: number|null, conversationTurns: number}} */
  let options = {
    sections: PRESET_SECTIONS[detail] ?? PRESET_SECTIONS.standard,
    budget,
    conversationTurns,
  };

  if (requestedSections) options.sections = requestedSections;

  if (interactive && !flags.yes && explicitTarget === undefined) {
    // Only offer the options screen when the user is driving interactively.
    if (!quiet) stderr.write('\u001b[K');
    const preview = renderHandoff(session, { detail: 'full', conversationTurns });
    const sectionTokens = Object.fromEntries(preview.stats.sections.map((s) => [s.id, s.tokens]));
    for (const key of Object.keys(SECTION_TOKEN_KEYS)) {
      if (sectionTokens[key] === undefined) sectionTokens[key] = 0;
    }
    terminal.enter();
    let picked;
    try {
      picked = await exportOptionsScreen(terminal, {
        session: {
          title: chosen.title,
          projectLabel: chosen.projectLabel,
          cwd: chosen.cwd,
        },
        sectionTokens,
        initial: options,
        documentTokens: preview.stats.tokens,
        documentBytes: preview.stats.bytes,
      });
    } finally {
      terminal.restore();
    }
    if (!picked) {
      stderr.write(`${style.dim('cancelled')}\n`);
      return 130;
    }
    options = picked;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  let output;
  let stats;
  let trimmed = false;
  try {
    if (format === 'json') {
      output = renderJson(session, { ...options, sourceLabel: chosen.title, redact: !flags['no-redact'] });
      stats = { tokens: 0, bytes: Buffer.byteLength(output, 'utf8'), lines: output.split('\n').length, sections: [] };
    } else if (format === 'markdown' || format === 'md') {
      const result = renderMarkdown(session, { ...options, sourceLabel: chosen.title, redact: !flags['no-redact'] });
      output = result.text;
      stats = result.stats;
      trimmed = result.trimmed;
    } else {
      const result = renderHandoff(session, { ...options, sourceLabel: chosen.title, redact: !flags['no-redact'] });
      output = result.text;
      stats = result.stats;
      trimmed = result.trimmed;
    }
  } catch (error) {
    stderr.write(`${style.red('error')} failed to render the handoff: ${error?.stack ?? error}\n`);
    return 8;
  }

  // ── Emit ──────────────────────────────────────────────────────────────────
  // stdout is used only when asked for. `--format` selects the file type, not
  // the destination, so `--format json` behaves like `--format markdown`.
  if (flags.stdout) stdout.write(output);

  /** @type {string|null} */
  let writtenPath = null;
  if (!flags.stdout) {
    const target = flags.out ? path.resolve(String(flags.out)) : defaultOutputPath(chosen, format);
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, output, 'utf8');
      writtenPath = target;
    } catch (error) {
      stderr.write(`${style.red('error')} could not write ${target}: ${error?.message ?? error}\n`);
      return 9;
    }
  }

  let copied = false;
  if (flags.copy) copied = await copyToClipboard(output);

  const redactionFindings = stats.redactions ?? [];

  if (!quiet) {
    printSummary({
      style,
      session,
      chosen,
      writtenPath,
      stats,
      trimmed,
      budget: options.budget,
      copied,
      format,
      sections: options.sections,
      redactionFindings,
      stdout,
      stderr,
    });
  }
  return 0;
}

/** Section ids known to the renderer, used for `--sections` validation. */
const SECTION_TOKEN_KEYS = {
  howto: 1, mission: 1, state: 1, next: 1, deadends: 1, constraints: 1, files: 1,
  diffs: 1, commands: 1, research: 1, conversation: 1, appendix: 1,
};

/** Narrow the entry list according to `--here` / `--cwd`. */
function filterEntries(entries, flags) {
  if (!flags.here && !flags.cwd) return entries;
  const base = path.resolve(String(flags.cwd ?? process.cwd()));
  return entries.filter((entry) => entry.cwd === base || entry.cwd.startsWith(base + '/'));
}

/** @param {any} flags @param {string} home */
function describeFilter(flags, home) {
  const bits = [];
  if (flags.here) bits.push(`in ${process.cwd()}`);
  if (flags.cwd) bits.push(`under ${path.resolve(String(flags.cwd))}`);
  if (!flags.all) bits.push('excluding automatic review threads');
  if (!flags.archived) bits.push('excluding archived sessions');
  const suffix = bits.length ? ` (${bits.join(', ')})` : '';
  return ` ${suffix}\n\nLooked in ${home}. Try ${bits.length ? '--all or ' : ''}--list to see everything.`;
}

/**
 * Resolve a positional argument into a session entry.
 * Accepts an absolute/relative transcript path, a full session id, or an
 * unambiguous id prefix (like a short git hash).
 *
 * @param {string} target @param {any[]} entries @param {string} home
 */
async function resolveTarget(target, entries, home) {
  // Path?
  const asPath = path.resolve(target);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) {
    const parsed = await parseSessionFile(asPath);
    return {
      ok: true,
      entry: {
        file: asPath,
        id: parsed.id,
        title: parsed.messages.find((/** @type {any} */ m) => m.role === 'user')?.text.slice(0, 80) ?? path.basename(asPath),
        cwd: parsed.cwd,
        projectLabel: path.basename(parsed.cwd || path.dirname(asPath)),
        lastActivityMs: Date.now(),
        sizeBytes: parsed.stats.bytes,
        gitBranch: parsed.git.branch ?? '',
        archived: false,
        interactive: true,
      },
    };
  }

  /** @type {any[]} */
  let pool = entries;
  if (pool.length === 0) {
    pool = await buildSessionIndex({
      home,
      includeArchived: true,
      includeNonInteractive: true,
      useCache: true,
    });
  }

  const needle = target.toLowerCase();
  const exact = pool.filter((entry) => entry.id.toLowerCase() === needle || path.basename(entry.file).toLowerCase() === needle);
  if (exact.length === 1) return { ok: true, entry: exact[0] };

  const prefixed = pool.filter((entry) => entry.id.toLowerCase().startsWith(needle));
  if (prefixed.length === 1) return { ok: true, entry: prefixed[0] };
  if (prefixed.length > 1) {
    return {
      ok: false,
      reason: `\`${target}\` matches ${prefixed.length} sessions — use more characters.`,
      suggestions: prefixed.slice(0, 6),
    };
  }

  // Fall back to a fuzzy title match so a remembered name still works.
  const byTitle = pool.filter((entry) => entry.title.toLowerCase().includes(needle));
  if (byTitle.length === 1) return { ok: true, entry: byTitle[0] };
  if (byTitle.length > 1) {
    return {
      ok: false,
      reason: `\`${target}\` matches ${byTitle.length} session titles.`,
      suggestions: byTitle.slice(0, 6),
    };
  }

  return { ok: false, reason: `no session matches \`${target}\`.`, suggestions: pool.slice(0, 5) };
}

/** Default output filename, derived from the project and the moment of export. */
function defaultOutputPath(entry, format) {
  const stamp = new Date()
    .toISOString()
    .slice(0, 16)
    .replace(/[-:T]/g, '')
    .replace(/(\d{8})(\d{4})/, '$1-$2');
  const extension = format === 'json' ? 'json' : format === 'md' || format === 'markdown' ? 'md' : 'txt';
  const base = slugify(entry.projectLabel && entry.projectLabel !== '(unknown)' ? entry.projectLabel : entry.id.slice(0, 12), 32);
  return path.join(process.cwd(), `extralife-${base}-${stamp}.${extension}`);
}

/** Copy text to the platform clipboard. Returns false when unavailable. */
async function copyToClipboard(text) {
  const candidates =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];
  for (const [command, args] of candidates) {
    const ok = await new Promise((resolve) => {
      try {
        const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
        child.stdin.on('error', () => resolve(false));
        child.stdin.end(text);
      } catch {
        resolve(false);
      }
    });
    if (ok) return true;
  }
  return false;
}

/** Print an aligned table of sessions. */
function printList(entries, style, stdout) {
  if (entries.length === 0) {
    stdout.write('No sessions found.\n');
    return;
  }
  // A session id can appear more than once: Codex starts a new rollout file
  // every time a thread is resumed into a fresh context window. The exact
  // timestamp is what tells those apart, so `WHEN` is precise rather than
  // relative.
  const stamp = (/** @type {number} */ ms) => {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const rows = entries.map((entry) => ({
    id: entry.id.slice(0, 8),
    when: stamp(entry.lastActivityMs),
    project: truncate(entry.projectLabel, 22),
    branch: truncate(entry.gitBranch || '—', 12),
    quota: entry.exhaustedReason
      ? 'exhausted'
      : entry.primaryUsedPercent !== undefined
        ? `${entry.primaryUsedPercent.toFixed(0)}%`
        : '—',
    size: formatBytes(entry.sizeBytes),
    title: truncate(entry.title, 46),
  }));
  const widths = {
    id: Math.max(8, ...rows.map((r) => displayWidth(r.id))),
    when: Math.max(4, ...rows.map((r) => displayWidth(r.when))),
    project: Math.max(7, ...rows.map((r) => displayWidth(r.project))),
    branch: Math.max(6, ...rows.map((r) => displayWidth(r.branch))),
    quota: Math.max(5, ...rows.map((r) => displayWidth(r.quota))),
    size: Math.max(4, ...rows.map((r) => displayWidth(r.size))),
  };
  stdout.write(
    style.bold(
      `${pad('ID', widths.id)}  ${pad('WHEN', widths.when)}  ${pad('PROJECT', widths.project)}  ${pad('BRANCH', widths.branch)}  ${pad('QUOTA', widths.quota, 'right')}  ${pad('SIZE', widths.size, 'right')}  TITLE\n`,
    ),
  );
  for (const row of rows) {
    const quotaCell =
      row.quota === 'exhausted' ? style.red(pad(row.quota, widths.quota, 'right')) : pad(row.quota, widths.quota, 'right');
    stdout.write(
      `${style.dim(pad(row.id, widths.id))}  ${pad(row.when, widths.when)}  ${pad(row.project, widths.project)}  ${style.magenta(pad(row.branch, widths.branch))}  ${quotaCell}  ${style.dim(pad(row.size, widths.size, 'right'))}  ${row.title}\n`,
    );
  }
  stdout.write(style.dim(`\n${entries.length} session(s). Run \`extralife <ID>\` to export one, or \`extralife\` to pick interactively.\n`));
}

/** Print the post-export summary with actionable next steps. */
function printSummary({ style, session, chosen, writtenPath, stats, trimmed, budget, copied, format, sections, redactionFindings, stdout, stderr }) {
  const out = stderr;
  out.write('\n');
  out.write(`${style.green('✓')} ${style.bold('Handoff ready')}\n\n`);
  out.write(`  session    ${truncate(chosen.title, 60)}\n`);
  out.write(`  project    ${session.cwd || '(unknown)'}\n`);
  out.write(`  contents   ${session.messages.length} messages · ${session.turns.length} turns · ${session.fileChanges.length} file edits · ${session.commands.length} commands\n`);
  out.write(`  sections   ${sections.length}${sections.length ? ` (${sections.join(', ')})` : ''}\n`);
  out.write(`  size       ${formatTokens(stats.tokens)} tokens · ${formatBytes(stats.bytes)} · ${stats.lines} lines\n`);
  if (budget !== null && trimmed) {
    out.write(`  ${style.yellow('note')}       trimmed to fit the ${formatTokens(budget)}-token budget; raise --budget for more detail\n`);
  }
  const redactionCount = (redactionFindings ?? []).reduce((sum, f) => sum + f.count, 0);
  if (redactionCount > 0) {
    out.write(
      `  ${style.green('redacted')}   ${redactionCount} credential(s) scrubbed: ` +
        `${redactionFindings.map((f) => `${f.describe} ×${f.count}`).join(', ')}\n`,
    );
  }
  out.write('\n');
  if (writtenPath) {
    const relative = path.relative(process.cwd(), writtenPath);
    // A path that climbs out of the working directory is harder to read than
    // the absolute one, so only shorten when it stays inside.
    const display = relative && !relative.startsWith('..') ? relative : writtenPath;
    out.write(`  ${style.bold('written to')} ${style.cyan(display)}\n`);
  }
  if (copied) out.write(`  ${style.green('copied to your clipboard')}\n`);
  out.write('\n');
  out.write(style.bold('  Continue the work in another agent:\n\n'));
  if (session.cwd) out.write(`    cd ${session.cwd}\n`);
  const file = writtenPath ? path.basename(writtenPath) : 'handoff.txt';
  out.write(`    claude   ${style.dim('# or: cursor, gemini, codex, aider …')}\n`);
  out.write(`    ${style.dim(`then ask: "Read ${file} and continue the work it describes."`)}\n`);
  if (format === 'handoff' && !writtenPath) {
    out.write(`\n  ${style.dim('(output was written to stdout)')}\n`);
  }
  out.write('\n');
  if (session.id) {
    out.write(style.dim(`  Reopen the original session instead:  codex resume ${session.id}\n`));
  }
}

/** `--help` text. */
function helpText() {
  const lines = [];
  lines.push('ExtraLife (续命) — keep coding when your Codex quota runs out.');
  lines.push('');
  lines.push('Extracts the full development context and progress of a Codex session into a');
  lines.push('single portable text file that any other agent can pick up from.');
  lines.push('');
  lines.push('USAGE');
  lines.push(`  extralife ${POSITIONAL_USAGE} [options]`);
  lines.push('');
  lines.push('  Run with no arguments for the interactive picker.');
  lines.push('');
  lines.push('EXAMPLES');
  lines.push('  extralife                          # pick a session, choose what to include');
  lines.push('  extralife --here                   # only sessions from the current project');
  lines.push('  extralife --list                   # non-interactive table of sessions');
  lines.push('  extralife 01a12926 --yes           # export a session by id with defaults');
  lines.push('  extralife --here -y --copy         # export and copy straight to the clipboard');
  lines.push('  extralife --budget 32k --stdout > handoff.txt');
  lines.push('  extralife --detail minimal --out ctx.txt');
  lines.push('');
  lines.push('OPTIONS');
  const entries = Object.entries(FLAGS);
  const rendered = entries.map(([name, spec]) => {
    const flag = `${spec.alias ? `-${spec.alias}, ` : '    '}--${name}${spec.type === 'string' ? ' <value>' : ''}`;
    return [flag, spec.describe];
  });
  const width = Math.max(...rendered.map(([flag]) => flag.length));
  for (const [flag, description] of rendered) {
    lines.push(`  ${flag.padEnd(width + 2)}${description}`);
  }
  lines.push('');
  lines.push('OUTPUT');
  lines.push('  By default a single .txt handoff is written into the current directory.');
  lines.push('  Its filename records the project and the export time, so repeated exports');
  lines.push('  never overwrite each other.');
  lines.push('');
  lines.push('EXIT CODES');
  lines.push('  0  success');
  lines.push('  2  bad usage');
  lines.push('  3  Codex home not found');
  lines.push('  4  no such session');
  lines.push('  5  no sessions matched the filter');
  lines.push('  6  transcript could not be read');
  lines.push('  7  transcript had no usable content');
  lines.push('  8  rendering failed');
  lines.push('  9  could not write the output file');
  lines.push('  130  cancelled by the user');
  lines.push('');
  lines.push('ENVIRONMENT');
  lines.push('  CODEX_HOME            Codex home directory (default: ~/.codex)');
  lines.push('  EXTRALIFE_CACHE_DIR   Where the session index cache is kept');
  lines.push('  NO_COLOR              Disable ANSI colour');
  lines.push('');
  lines.push('LEARN MORE');
  lines.push('  extralife --help-sections    describe the handoff sections');
  return lines.join('\n') + '\n';
}

/** `--help-sections` text. */
function sectionsHelpText() {
  const lines = [];
  lines.push('Handoff sections');
  lines.push('');
  lines.push('Pass a comma-separated subset to --sections. Three sections are always');
  lines.push('included because a handoff without them is not a handoff: howto, mission, next.');
  lines.push('');
  const catalogue = [
    ['howto', 'Instructions telling the next agent how to use the document', 'always'],
    ['mission', "The user's own requests: the original goal and the latest ones", 'always'],
    ['next', 'The interrupted request, outstanding plan items, risky leftovers', 'always'],
    ['state', 'Progress counters, the plan checklist, the last status report', ''],
    ['constraints', 'AGENTS.md rules and environment facts that remain in force', ''],
    ['files', 'Files edited and files read for context, most-touched first', ''],
    ['diffs', 'Unified diffs of the edits made in the session', ''],
    ['commands', 'Failed commands in full, successful ones as a digest', ''],
    ['research', 'Web searches and MCP/plugin tools the agent used', ''],
    ['conversation', 'Recent request → outcome pairs, verbatim', ''],
    ['appendix', 'Session ids, quota, token usage, how to reopen in Codex', ''],
  ];
  const width = Math.max(...catalogue.map(([id]) => id.length));
  for (const [id, description, note] of catalogue) {
    lines.push(`  ${id.padEnd(width + 2)}${description}${note ? `  (${note})` : ''}`);
  }
  lines.push('');
  lines.push('Detail presets (also settable with --detail):');
  lines.push(`  minimal    ${PRESET_SECTIONS.minimal.join(', ')}`);
  lines.push(`  standard   ${PRESET_SECTIONS.standard.join(', ')}`);
  lines.push(`  full       all sections`);
  return lines.join('\n') + '\n';
}

export { VERSION, cacheDir };
