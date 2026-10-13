/**
 * Handoff document renderer.
 *
 * Turns a parsed Codex session into a single portable text document that lets a
 * *different* agent pick the work up cold.
 *
 * Design rules, in order of importance:
 *
 *  1. **Density over completeness.** A transcript is mostly noise. What the next
 *     agent needs is: what is being built, what state it is in, what to do next,
 *     which rules apply, and which files matter.
 *  2. **Most decision-relevant material first.** The conversation transcript is
 *     the bulkiest and least dense section, so it goes last: if the document is
 *     truncated, the reader loses raw history rather than the mission.
 *  3. **Budget-aware.** Sections declare a priority and a `shrink` strategy. If a
 *     token budget is set, low-priority sections are halved repeatedly until the
 *     document fits, and never at the cost of the mission or next steps.
 *  4. **Plain text.** No ANSI codes, no smart quotes that break in shells. The
 *     output is meant to be pasted into another tool.
 */

import { displayWidth, pad, truncate } from '../util/ansi.js';
import { estimateTokens, formatBytes, formatDateTime, formatTokens, isoTimestamp, relativePath, uniqBy } from '../util/format.js';
import { redactDocument } from './redact.js';

const RULE_WIDTH = 84;
const HEAVY = '='.repeat(RULE_WIDTH);
const LIGHT = '-'.repeat(RULE_WIDTH);

/**
 * @typedef {Object} SectionId
 * @property {string} id
 */

/** Options controlling what goes into the document. */
export const DEFAULT_SECTIONS = [
  'howto',
  'mission',
  'state',
  'next',
  'deadends',
  'constraints',
  'files',
  'diffs',
  'commands',
  'research',
  'conversation',
  'appendix',
];

export const DETAIL_LEVELS = ['minimal', 'standard', 'full'];

/** Sections included at each detail level. */
const DETAIL_PRESETS = {
  minimal: ['howto', 'mission', 'state', 'next', 'deadends', 'constraints', 'files', 'appendix'],
  standard: ['howto', 'mission', 'state', 'next', 'deadends', 'constraints', 'files', 'diffs', 'commands', 'research', 'conversation', 'appendix'],
  full: DEFAULT_SECTIONS,
};

/**
 * Render the handoff document.
 *
 * @param {any} session parsed session
 * @param {{
 *   sections?: string[],
 *   detail?: 'minimal'|'standard'|'full',
 *   budget?: number|null,
 *   conversationTurns?: number,
 *   maxDiffFiles?: number,
 *   maxDiffsPerFileLines?: number,
 *   generatedAt?: number,
 *   sourceLabel?: string,
 *   includeRawPointers?: boolean,
 *   redact?: boolean,
 * }} [options]
 * @returns {{ text: string, stats: { tokens: number, bytes: number, lines: number, sections: Array<{id:string,title:string,tokens:number,trimmed:boolean}> }, trimmed: boolean }}
 */
export function renderHandoff(session, options = {}) {
  const detail = options.detail ?? 'standard';
  const enabled = new Set(options.sections ?? DETAIL_PRESETS[detail] ?? DETAIL_PRESETS.standard);
  const required = new Set(['howto', 'mission', 'next']);
  const generatedAt = options.generatedAt ?? Date.now();

  /** @type {Array<{id: string, title: string, priority: number, lines: string[], shrink?: () => boolean, trimmed?: boolean}>} */
  const sections = [];

  const push = (
    /** @type {string} */ id,
    /** @type {string} */ title,
    /** @type {number} */ priority,
    /** @type {string[]} */ lines,
    /** @type {(() => boolean)|undefined} */ shrink,
  ) => {
    if (!enabled.has(id)) return;
    if (lines.length === 0) return;
    sections.push({ id, title, priority, lines, shrink, trimmed: false });
  };

  const ctx = buildContext(session, options);
  ctx.enabled = enabled;

  push('howto', 'HOW TO USE THIS DOCUMENT', 0, renderHowTo(ctx), undefined);
  push('mission', 'MISSION — WHAT THE USER IS BUILDING', 0, renderMission(ctx), undefined);
  push('state', 'CURRENT STATE', 1, renderState(ctx), () => shrinkList(sections, 'state'));
  push('next', 'NEXT STEPS', 0, renderNextSteps(ctx), undefined);
  push('deadends', 'FAILED APPROACHES — DO NOT REPEAT THESE', 1, renderDeadEnds(ctx), () => shrinkList(sections, 'deadends', 10));
  push('constraints', 'CONSTRAINTS AND CONVENTIONS', 2, renderConstraints(ctx), () => shrinkText(sections, 'constraints'));
  push('files', 'FILES THAT MATTER', 2, renderFiles(ctx), () => shrinkList(sections, 'files'));
  push('diffs', 'CHANGES MADE IN THIS SESSION', 4, renderDiffs(ctx), () => shrinkList(sections, 'diffs', 4));
  push('commands', 'COMMANDS RUN', 4, renderCommands(ctx), () => shrinkList(sections, 'commands', 6));
  push('research', 'RESEARCH AND EXTERNAL LOOKUPS', 6, renderResearch(ctx), () => shrinkList(sections, 'research', 6));
  push('conversation', 'CONVERSATION HISTORY (oldest first)', 3, renderConversation(ctx), () => shrinkList(sections, 'conversation', 2));
  push('appendix', 'APPENDIX — SOURCE AND PROVENANCE', 5, renderAppendix(ctx), undefined);

  // ── Budget enforcement ────────────────────────────────────────────────────
  const budget = options.budget ?? null;
  let trimmed = false;
  if (budget && budget > 0) {
    const measure = () => sections.reduce((sum, s) => sum + measureLines(s.lines), 0);
    let guard = 0;
    while (measure() > budget && guard++ < 200) {
      // Shrink the lowest-priority section that still can shrink, skipping
      // sections the document cannot survive without.
      const candidates = sections
        .filter((s) => s.shrink && !required.has(s.id))
        .sort((a, b) => b.priority - a.priority);
      let progressed = false;
      for (const candidate of candidates) {
        if (candidate.shrink?.()) {
          candidate.trimmed = true;
          trimmed = true;
          progressed = true;
          if (measure() <= budget) break;
        }
      }
      if (!progressed) break;
    }
  }

  // ── Compose ───────────────────────────────────────────────────────────────
  /** @type {string[]} */
  const out = [];
  out.push(...renderBanner(ctx, generatedAt, options));

  const report = [];
  for (const section of sections) {
    out.push('');
    out.push(HEAVY);
    out.push(`  ${section.title}${section.trimmed ? '   [trimmed to fit budget]' : ''}`);
    out.push(HEAVY);
    out.push('');
    out.push(...section.lines);
    report.push({
      id: section.id,
      title: section.title,
      tokens: measureLines(section.lines),
      trimmed: Boolean(section.trimmed),
    });
  }

  // A compact recap sits at the very end on purpose: readers that truncate a
  // long document lose the middle, and several models attend most strongly to
  // the tail of their context.
  const recap = renderRecap(ctx);
  if (recap.length > 0) {
    out.push('');
    out.push(HEAVY);
    out.push('  IF YOU READ NOTHING ELSE');
    out.push(HEAVY);
    out.push('');
    out.push(...recap);
  }

  out.push('');
  out.push(LIGHT);
  out.push(`  End of handoff · generated by ExtraLife (续命) · ${isoTimestamp(generatedAt)}`);
  out.push(LIGHT);

  let text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '') + '\n';

  // Redaction runs on the assembled document rather than per field, so a secret
  // cannot survive by being split across a line or a section boundary.
  const redaction = redactDocument(text, options.redact !== false);
  text = redaction.text;

  return {
    text,
    stats: {
      tokens: estimateTokens(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: text.split('\n').length,
      sections: report,
      redactions: redaction.findings,
      redactionCount: redaction.total,
    },
    trimmed,
  };
}

/**
 * The closing summary: the few facts a reader must retain if they skim nothing
 * else.
 * @param {any} ctx
 */
function renderRecap(ctx) {
  const s = ctx.session;
  /** @type {string[]} */
  const lines = [];
  const bullet = (/** @type {string} */ text) => lines.push(`  • ${text}`);

  if (s.cwd) bullet(`Project: ${s.cwd}`);
  if (s.git?.branch) {
    bullet(`Git: ${s.git.branch}${s.git.commit ? ` @ ${s.git.commit.slice(0, 12)}` : ''} — run \`git status\` and \`git diff\` before editing`);
  }
  if (ctx.interrupted?.user) {
    bullet(`Interrupted mid-request: "${oneLine(ctx.interrupted.user, 110)}"`);
  }
  const openPlan = ctx.latestPlan?.steps?.filter((/** @type {any} */ step) => step.status !== 'completed') ?? [];
  if (openPlan.length) {
    bullet(`${openPlan.length} plan step(s) left open`);
  }
  if (ctx.editedFiles.length) {
    bullet(`${ctx.editedFiles.length} file(s) already edited — review before continuing`);
  }
  if (ctx.failedCommands.length) {
    bullet(
      `${ctx.failedCommands.length} command(s) failed` +
        (ctx.enabled?.has('deadends') ? ' — see FAILED APPROACHES before retrying' : ''),
    );
  }
  bullet('Verify the actual code; this document is a curated extract, not the truth.');

  return lines;
}

/** Measure the token cost of a list of lines. */
function measureLines(lines) {
  return estimateTokens(lines.join('\n'));
}

/**
 * Drop the tail of a section, keeping its heading lines and a truncation note.
 * @param {any[]} sections @param {string} id @param {number} [keepHead]
 */
function shrinkList(sections, id, keepHead = 8) {
  const section = sections.find((s) => s.id === id);
  if (!section) return false;
  if (section.lines.length <= keepHead) return false;
  const keep = Math.max(keepHead, Math.floor(section.lines.length * 0.6));
  if (keep >= section.lines.length) return false;
  const dropped = section.lines.length - keep;
  section.lines = [
    ...section.lines.slice(0, keep),
    '',
    `… ${dropped} more line(s) omitted to fit the token budget. Re-export with a larger --budget for the full detail.`,
  ];
  return true;
}

/** Halve a prose section, keeping the first half. */
function shrinkText(sections, id) {
  const section = sections.find((s) => s.id === id);
  if (!section || section.lines.length <= 6) return false;
  const keep = Math.max(6, Math.floor(section.lines.length / 2));
  section.lines = [
    ...section.lines.slice(0, keep),
    '',
    '… remainder omitted to fit the token budget. Re-export with a larger --budget for the full detail.',
  ];
  return true;
}

/**
 * Precompute everything the section builders need so they stay pure and cheap.
 * @param {any} session @param {any} options
 */
function buildContext(session, options) {
  const cwd = session.cwd || '';
  const rel = (/** @type {string} */ p) => relativePath(p, cwd);

  // Files touched, most-edited first.
  const editCounts = new Map();
  /** @type {Map<string, {path: string, kinds: Set<string>, edits: number, lastMs: number, diff: string}>} */
  const fileMap = new Map();
  for (const change of session.fileChanges) {
    const key = change.path;
    const existing = fileMap.get(key) ?? {
      path: change.path,
      kinds: new Set(),
      edits: 0,
      lastMs: 0,
      diff: '',
    };
    existing.kinds.add(change.kind);
    existing.edits += 1;
    existing.lastMs = Math.max(existing.lastMs, change.timestampMs);
    // Keep the largest diff we saw — usually the most informative one.
    if ((change.diff?.length ?? 0) > existing.diff.length) existing.diff = change.diff;
    fileMap.set(key, existing);
    editCounts.set(key, (editCounts.get(key) ?? 0) + 1);
  }
  const editedFiles = [...fileMap.values()].sort((a, b) => b.edits - a.edits || b.lastMs - a.lastMs);

  // Files read (and searched) but not modified — still useful orientation.
  // `parsed_cmd` paths are usually relative while `FileChange` paths are
  // absolute, so both sides are normalised before the comparison.
  /** @type {Map<string, number>} */
  const readCounts = new Map();
  for (const command of session.commands) {
    for (const touched of command.touched) {
      if (touched.type !== 'read' || !touched.path) continue;
      const abs = absolutise(touched.path, command.cwd || cwd);
      readCounts.set(abs, (readCounts.get(abs) ?? 0) + 1);
    }
  }
  const editedKeys = new Set(
    [...fileMap.keys()].flatMap((p) => [p, rel(p), absolutise(p, cwd)]),
  );
  const readOnlyFiles = [...readCounts.entries()]
    .filter(([p]) => !editedKeys.has(p))
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p);

  const failedCommands = session.commands.filter((c) => c.status === 'failed');

  // Conversation as request → outcome pairs. `turns` is the highest-signal
  // view; fall back to raw messages when a transcript has no turn metadata.
  const turns = buildTurnPairs(session);

  // The interrupted request: the most recent turn that never produced a final
  // answer. Continuation turns with no user text of their own are skipped,
  // because quoting the last *request* is what lets the next agent resume.
  const interrupted =
    [...turns].reverse().find((turn) => turn.user && !turn.completed) ??
    [...turns].reverse().find((turn) => turn.user && turn.truncated) ??
    null;
  const lastTurn = turns[turns.length - 1] ?? null;

  const latestPlan = pickLatestPlan(session);

  return {
    session,
    options,
    cwd,
    rel,
    editedFiles,
    readOnlyFiles,
    failedCommands,
    turns,
    interrupted,
    latestPlan,
    usage: session.usage ?? null,
    rateLimit: session.rateLimit ?? null,
  };
}

/** Pair user requests with the assistant's outcome for each turn. */
function buildTurnPairs(session) {
  /** @type {Array<{ user: string, assistant: string, timestampMs: number, commands: number, failed: number, files: number, completed: boolean, truncated: boolean }>} */
  const pairs = [];

  if (Array.isArray(session.turns) && session.turns.length > 0) {
    for (const turn of session.turns) {
      const commands = session.commands.filter((/** @type {any} */ c) => c.turnId === turn.turnId);
      const files = session.fileChanges.filter((/** @type {any} */ f) => f.turnId === turn.turnId);
      pairs.push({
        user: turn.userText ?? '',
        assistant: turn.finalText ?? '',
        timestampMs: turn.startedMs || 0,
        commands: commands.length,
        failed: commands.filter((/** @type {any} */ c) => c.status === 'failed').length,
        files: files.length,
        completed: turn.completed !== false,
        truncated: Boolean(turn.truncated),
      });
    }
  }

  const nonEmpty = pairs.filter((p) => p.user || p.assistant);
  if (nonEmpty.length > 0) return nonEmpty;

  // Fallback: walk raw messages, merging consecutive same-role entries.
  /** @type {Array<{ user: string, assistant: string, timestampMs: number, commands: number, failed: number, files: number }>} */
  const fallback = [];
  /** @type {any} */
  let current = null;
  for (const message of session.messages) {
    if (message.role === 'user') {
      if (current) fallback.push(current);
      current = { user: message.text, assistant: '', timestampMs: message.timestampMs, commands: 0, failed: 0, files: 0, completed: true, truncated: false };
    } else if (message.role === 'assistant') {
      if (!current) {
        current = { user: '', assistant: '', timestampMs: message.timestampMs, commands: 0, failed: 0, files: 0, completed: true, truncated: false };
      }
      // Prefer the final answer of a turn over commentary.
      if (message.phase === 'final_answer' || current.assistant === '') current.assistant = message.text;
    }
  }
  if (current) fallback.push(current);
  return fallback.filter((p) => p.user || p.assistant);
}

/**
 * Choose the plan that best represents the work in flight.
 *
 * A session can contain several plans: `Plan` items attached to turns and
 * `update_plan` tool calls. The most recent one describes the current
 * intention, so recency dominates — a short new plan beats a long stale one.
 * Structured step lists only act as a tie-break, because they render as an
 * actionable checklist.
 *
 * @param {any} session
 */
function pickLatestPlan(session) {
  if (!Array.isArray(session.plans) || session.plans.length === 0) return null;
  const ranked = [...session.plans].sort((a, b) => {
    const timeDiff = (b.timestampMs ?? 0) - (a.timestampMs ?? 0);
    if (timeDiff !== 0) return timeDiff;
    const aSteps = a.steps?.length ?? 0;
    const bSteps = b.steps?.length ?? 0;
    if (aSteps !== bSteps) return bSteps - aSteps;
    return String(b.text ?? '').length - String(a.text ?? '').length;
  });
  const latest = ranked[0];
  if (!latest.text && !(latest.steps?.length > 0)) {
    return ranked.find((plan) => plan.text || plan.steps?.length) ?? null;
  }
  return latest;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section renderers
// ─────────────────────────────────────────────────────────────────────────────

/** @param {any} ctx @param {number} generatedAt @param {any} options */
function renderBanner(ctx, generatedAt, options) {
  const s = ctx.session;
  const lines = [];
  lines.push('╔' + '═'.repeat(RULE_WIDTH - 2) + '╗');
  lines.push(boxLine('EXTRALIFE HANDOFF  ·  续命'));
  lines.push(boxLine('Codex session context exported for continuation in another agent'));
  lines.push('╚' + '═'.repeat(RULE_WIDTH - 2) + '╝');
  lines.push('');
  const row = (/** @type {string} */ k, /** @type {string} */ v) => lines.push(`  ${k.padEnd(15)}${v}`);
  row('Generated', `${formatDateTime(generatedAt)}  (${isoTimestamp(generatedAt)})`);
  row('Source', options.sourceLabel ?? `Codex session ${s.id}${s.cliVersion ? ` · cli ${s.cliVersion}` : ''}`);
  row('Project', s.cwd || '(unknown)');
  if (s.git?.branch || s.git?.commit) {
    row('Git', [s.git.branch, s.git.commit ? s.git.commit.slice(0, 12) : ''].filter(Boolean).join(' @ '));
  }
  if (s.threadGoal) row('Thread goal', s.threadGoal.replace(/\s+/g, ' ').slice(0, 200));
  const quota = ctx.rateLimit;
  if (quota) {
    const pct = quota.primary?.used_percent;
    const weekly = quota.secondary?.used_percent;
    const bits = [];
    if (typeof pct === 'number') bits.push(`primary window ${pct.toFixed(0)}%`);
    if (typeof weekly === 'number') bits.push(`weekly ${weekly.toFixed(0)}%`);
    if (quota.plan_type) bits.push(`plan ${quota.plan_type}`);
    row('Quota at end', bits.join('  ·  '));
  }
  if (ctx.usage?.total_tokens) row('Session size', `${formatTokens(ctx.usage.total_tokens)} tokens processed`);
  row('Transcript', `${formatBytes(s.stats.bytes)} · ${s.stats.lines} events`);
  return lines;
}

/** @param {string} text */
function boxLine(text) {
  const inner = RULE_WIDTH - 4;
  return `║ ${pad(truncate(text, inner), inner)} ║`;
}

/** @param {any} ctx */
function renderHowTo(ctx) {
  return [
    'You are an AI coding agent picking up work that was interrupted. The previous',
    'agent ran out of its Codex usage quota mid-task, so this document is the',
    'complete handoff. Read it before touching any files.',
    '',
    'Suggested sequence:',
    '',
    '  1. Read MISSION and CURRENT STATE in full. They define the goal and the',
    '     exact point of interruption.',
    '  2. `cd` into the project directory shown above and confirm the git branch',
    '     and commit. The working tree may contain uncommitted work — inspect',
    '     `git status` and `git diff` before editing anything.',
    '  3. Open the files listed under FILES THAT MATTER before writing code.',
    '  4. Resume from NEXT STEPS. Do not redo work already listed as complete.',
    '  5. Obey every rule under CONSTRAINTS AND CONVENTIONS — those are the',
    "     user's own instructions, not suggestions.",
    '',
    'Caveats:',
    '',
    '  · Sections marked "[trimmed to fit budget]" were shortened; re-run the',
    '    export with a larger budget if you need the omitted detail.',
    '  · The conversation section is a faithful extract, but it is never a',
    '    substitute for reading the actual code.',
    '  · Timestamps are local unless marked otherwise.',
  ];
}

/** @param {any} ctx */
function renderMission(ctx) {
  const lines = [];
  const asks = ctx.turns.filter((/** @type {any} */ t) => t.user && t.user.trim() !== '');
  if (asks.length === 0) {
    return ['No user messages were recorded in this session.'];
  }

  // The first request establishes the project intent; the last few define the
  // live objective. Both matter, and they are usually quite different.
  const first = asks[0];
  lines.push('### Original request');
  lines.push('');
  lines.push(...quote(first.user, 40));

  if (ctx.session.threadGoal) {
    lines.push('');
    lines.push('### Declared thread goal');
    lines.push('');
    lines.push(...quote(ctx.session.threadGoal, 20));
  }

  if (asks.length > 1) {
    lines.push('');
    lines.push(`### Most recent requests (${Math.min(4, asks.length - 1)} of ${asks.length - 1} later turns)`);
    lines.push('');
    for (const turn of asks.slice(-4)) {
      if (turn === first) continue;
      const when = turn.timestampMs ? formatDateTime(turn.timestampMs) : 'unknown time';
      lines.push(`**${when}**`);
      lines.push('');
      lines.push(...quote(turn.user, 24));
      lines.push('');
    }
  }
  return trimTrailingBlank(lines);
}

/** @param {any} ctx */
function renderState(ctx) {
  const lines = [];
  const s = ctx.session;

  lines.push('### Session activity');
  lines.push('');
  lines.push(`- Turns completed: ${s.turns.length}`);
  lines.push(`- Messages: ${s.messages.length} (${s.messages.filter((m) => m.role === 'user').length} from the user)`);
  lines.push(`- Files edited: ${ctx.editedFiles.length}`);
  lines.push(`- Commands run: ${s.commands.length}${ctx.failedCommands.length ? ` (${ctx.failedCommands.length} failed)` : ''}`);
  if (s.webSearches.length) lines.push(`- Web searches: ${s.webSearches.length}`);
  if (s.mcpCalls.length) lines.push(`- MCP tool calls: ${s.mcpCalls.length}`);
  lines.push('');

  if (ctx.latestPlan) {
    lines.push('### Plan the previous agent was working from');
    lines.push('');
    if (ctx.latestPlan.steps?.length) {
      for (const step of ctx.latestPlan.steps) {
        const mark = step.status === 'completed' ? '[x]' : step.status === 'in_progress' ? '[~]' : '[ ]';
        lines.push(`${mark} ${step.step}${step.status === 'in_progress' ? '   ← in progress' : ''}`);
      }
      lines.push('');
      lines.push('Legend: `[x]` done · `[~]` in progress · `[ ]` not started');
    }
    if (ctx.latestPlan.text) {
      lines.push(...quote(ctx.latestPlan.text, 120));
    }
    lines.push('');
  }

  // The last thing the previous agent reported before it ran out.
  const lastCompleted = [...ctx.turns].reverse().find((/** @type {any} */ t) => t.assistant);
  if (lastCompleted?.assistant) {
    lines.push('### Last report from the previous agent');
    lines.push('');
    lines.push(...quote(lastCompleted.assistant, 60));
    lines.push('');
  }
  return trimTrailingBlank(lines);
}

/** @param {any} ctx */
function renderNextSteps(ctx) {
  const lines = [];
  const s = ctx.session;

  lines.push('The previous session stopped because the account hit its usage limit,');
  lines.push('not because the work was finished. Treat everything below as a starting');
  lines.push('hypothesis and verify it against the code.');
  lines.push('');

  /** @type {string[]} */
  const steps = [];

  // Steps are written as plain prose with an em-dash lead rather than Markdown
  // emphasis. The document is a .txt: `**bold**` is invisible structure to a
  // human reader and to anything that renders it as plain text, while the
  // numbered list already carries the structure.
  if (ctx.interrupted?.user) {
    steps.push(
      `Finish the interrupted request — the user's last message was never answered:\n\n` +
        indent(quote(ctx.interrupted.user, 16).join('\n'), '    '),
    );
  }

  if (ctx.latestPlan?.steps?.length) {
    const open = ctx.latestPlan.steps.filter((step) => step.status !== 'completed');
    if (open.length) {
      const list = open
        .map(
          (step) =>
            `- ${step.step}${step.status === 'in_progress' ? '   ← in progress' : ''}`,
        )
        .join('\n');
      steps.push(`Continue the recorded plan — outstanding items:\n\n${indent(list, '    ')}`);
    }
  }

  const where = (/** @type {string} */ id, /** @type {string} */ title) =>
    ctx.enabled?.has(id) ? ` listed under ${title}` : '';

  if (ctx.failedCommands.length) {
    steps.push(
      `Resolve the ${ctx.failedCommands.length} failing command${ctx.failedCommands.length === 1 ? '' : 's'}` +
        `${where('commands', 'COMMANDS RUN')} — they may be expected failures ` +
        '(probes, negative tests), so check before "fixing" them.',
    );
  }

  if (ctx.editedFiles.length) {
    steps.push(
      `Review the uncommitted edits in ${ctx.editedFiles.length} file${ctx.editedFiles.length === 1 ? '' : 's'}` +
        `${where('files', 'FILES THAT MATTER')}, then decide whether to keep, ` +
        'complete or revert them.',
    );
  }

  steps.push(
    "Re-run the project's tests before making further changes, so you know the real baseline.",
  );

  steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step}`);
    lines.push('');
  });

  if (steps.length === 0) {
    lines.push('No concrete next step could be inferred. Start by reading the mission and');
    lines.push('the most recent user messages, then ask the user what to do next.');
  }

  lines.push('> If the user is available, confirm the plan before large changes. The intent');
  lines.push('> behind the original session may have moved on since this snapshot.');
  return trimTrailingBlank(lines);
}

/**
 * The section the prior agent never had time to write: what it already tried
 * and abandoned, so the next agent does not burn the same tokens rediscovering
 * it. This is assembled from evidence in the transcript, never invented, and
 * every item is tagged with its provenance so the reader can weigh it.
 *
 * @param {any} ctx
 */
function renderDeadEnds(ctx) {
  const s = ctx.session;
  /** @type {string[]} */
  const lines = [];

  lines.push('Work the previous agent already attempted and backed out of. Read this');
  lines.push('before choosing an approach — it is the cheapest section in the document.');
  lines.push('');
  lines.push('Provenance tags: `[transcript]` quoted directly from the session;');
  lines.push('`[inferred]` deduced by ExtraLife and worth confirming before you trust it.');
  lines.push('');

  let found = 0;

  // ── 1. Commands that failed, grouped by error signature ─────────────────
  if (ctx.failedCommands.length) {
    found++;
    lines.push(`### Commands that failed (${ctx.failedCommands.length})  \`[transcript]\``);
    lines.push('');
    lines.push('Grouped by error signature. A repeated failure usually means a wrong');
    lines.push('assumption rather than a typo.');
    lines.push('');
    const groups = groupFailures(ctx.failedCommands, ctx.cwd);
    for (const group of groups.slice(0, 12)) {
      lines.push(`**${group.count}×** — ${group.signature}`);
      lines.push('');
      lines.push('```shell');
      lines.push(`$ ${oneLine(group.example.command, 300)}`);
      if (group.example.cwd && group.example.cwd !== ctx.cwd) {
        lines.push(`# cwd: ${group.example.cwd}`);
      }
      const detail = group.example.stderr || group.example.stdout;
      if (detail) lines.push(`# ${oneLine(detail, 300)}`);
      lines.push('```');
      lines.push('');
    }
    if (groups.length > 12) {
      lines.push(`… ${groups.length - 12} further distinct failure(s) omitted.`);
      lines.push('');
    }
  }

  // ── 2. Files created and later deleted: abandoned attempts ──────────────
  const abandoned = findAbandonedFiles(ctx);
  if (abandoned.length) {
    found++;
    lines.push(`### Files created and later deleted (${abandoned.length})  \`[inferred]\``);
    lines.push('');
    lines.push('These were added during the session and removed again. If the current task');
    lines.push('needs what they were meant to do, the approach was already rejected once.');
    lines.push('');
    for (const file of abandoned.slice(0, 20)) {
      lines.push(`- \`${ctx.rel(file)}\``);
    }
    lines.push('');
  }

  // ── 3. Files rewritten many times: churn hotspots ───────────────────────
  const churn = ctx.editedFiles.filter((file) => file.edits >= 8).slice(0, 8);
  if (churn.length) {
    found++;
    lines.push('### Heavily reworked files  \`[inferred]\`');
    lines.push('');
    lines.push('Repeated edits often mean the design was still moving here. Expect these');
    lines.push('files to be the least stable part of the change set.');
    lines.push('');
    for (const file of churn) {
      lines.push(`- \`${ctx.rel(file.path)}\` — ${file.edits} edits`);
    }
    lines.push('');
  }

  // ── 4. The agent's own warnings about blockers ──────────────────────────
  const warnings = collectBlockers(ctx);
  if (warnings.length) {
    found++;
    lines.push('### Warnings the previous agent raised  \`[transcript]\`');
    lines.push('');
    lines.push('Statements where it flagged a problem, a blocker or a reason not to');
    lines.push('proceed. Quoted from later turns, where the picture was clearest.');
    lines.push('');
    for (const warning of warnings) {
      lines.push(...quote(warning.text, 10));
      lines.push('');
      lines.push(`— turn from ${formatDateTime(warning.timestampMs)}`);
      lines.push('');
    }
  }

  if (found === 0) {
    return [
      'No failed approaches were detected in this session. Either the work went',
      'smoothly, or the transcript did not record the detours.',
    ];
  }

  lines.push('> Absence of evidence is not evidence of success: the previous agent may have');
  lines.push('> abandoned an approach without ever running a failing command.');
  return trimTrailingBlank(lines);
}

/**
 * Group failed commands by a normalised error signature so that a repeated
 * wrong assumption shows up as one entry with a count.
 *
 * @param {any[]} commands @param {string} cwd
 */
function groupFailures(commands, cwd) {
  /** @type {Map<string, { signature: string, count: number, example: any }>} */
  const groups = new Map();
  for (const command of commands) {
    const raw = command.stderr || command.stdout || '';
    let signature = oneLine(raw, 140);
    if (signature === '') {
      signature = 'exited non-zero with no captured output';
    } else {
      // Strip volatile fragments so equivalent failures collapse together.
      signature = signature
        .replace(/\b[0-9a-f]{8,}\b/gi, '<hash>')
        .replace(/\b\d+\b/g, '<n>')
        .replace(/\/(?:Users|home|tmp)\/\S+/g, '<path>')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const existing = groups.get(signature);
    if (existing) {
      existing.count++;
    } else {
      groups.set(signature, { signature: oneLine(signature, 140), count: 1, example: command });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** Files that were added and later deleted within the session. */
function findAbandonedFiles(ctx) {
  /** @type {Set<string>} */
  const added = new Set();
  /** @type {Set<string>} */
  const deleted = new Set();
  /** @type {Set<string>} */
  const stillPresent = new Set();
  for (const change of ctx.session.fileChanges) {
    if (change.kind === 'add') added.add(change.path);
    if (change.kind === 'delete') deleted.add(change.path);
  }
  // A file that exists at the end was not abandoned even if an intermediate
  // revision deleted it.
  for (const change of ctx.session.fileChanges) {
    if (change.kind === 'add' || change.kind === 'update') stillPresent.add(change.path);
  }
  const lastChangeKind = new Map();
  for (const change of ctx.session.fileChanges) {
    lastChangeKind.set(change.path, change.kind);
  }
  return [...added].filter((file) => deleted.has(file) && lastChangeKind.get(file) === 'delete');
}

/**
 * Pull statements where the agent flagged a blocker. Restricted to substantive
 * assistant messages so ordinary prose does not produce noise.
 *
 * @param {any} ctx
 */
function collectBlockers(ctx) {
  const BLOCKER_PATTERNS = [
    /\b(?:cannot|can't|won't work|does not work|doesn't work|will not work)\b/i,
    /\b(?:blocked|blocker|showstopper|dealbreaker)\b/i,
    /\b(?:should not|must not|do not) (?:proceed|run|continue|merge)\b/i,
    /\b(?:failed|fails|failing) (?:because|since|due to)\b/i,
    /\b(?:root cause|underlying (?:issue|problem))\b/i,
    /(?:无法|不能|不应该|不要|阻塞|致命|关键问题|根本原因|失败的?原因)/,
  ];
  /** @type {Array<{ text: string, timestampMs: number }>} */
  const found = [];
  for (const turn of ctx.turns.slice(-14)) {
    const text = turn.assistant;
    if (!text || text.length < 40) continue;
    const matched = BLOCKER_PATTERNS.some((pattern) => pattern.test(text));
    if (!matched) continue;
    // Keep the sentences that actually carry the warning.
    const excerpt = extractWarningSentences(text);
    if (excerpt) found.push({ text: excerpt, timestampMs: turn.timestampMs });
  }
  return found.slice(-4);
}

/** Keep only the sentences containing blocker language, plus a little context. */
function extractWarningSentences(text) {
  const sentences = String(text)
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const keep = sentences.filter((sentence) =>
    /\b(?:cannot|can't|won't|does not|doesn't|will not|blocked|blocker|should not|must not|failed|fails|failing|root cause)\b/i.test(sentence) ||
    /(?:无法|不能|不应该|不要|阻塞|致命|关键问题|根本原因)/.test(sentence),
  );
  if (keep.length === 0) return '';
  return keep.slice(0, 4).join('\n');
}

/** @param {any} ctx */
function renderConstraints(ctx) {
  const s = ctx.session;
  /** @type {string[]} */
  const lines = [];

  const instructions = s.agentInstructions || extractInstructionsFromSession(s);

  if (instructions) {
    lines.push('### Project instructions (AGENTS.md)');
    lines.push('');
    if (s.agentInstructionsDir && s.agentInstructionsDir !== s.cwd) {
      lines.push(`Loaded from \`${s.agentInstructionsDir}\`.`);
      lines.push('');
    }
    lines.push('These were loaded by the previous agent and remain in force.');
    lines.push('');
    lines.push(...quote(instructions, 150));
    lines.push('');
  }

  /** @type {string[]} */
  const observed = [];
  if (s.git?.repositoryUrl) {
    observed.push(`Repository: ${s.git.repositoryUrl}`);
  }
  if (s.cwd) observed.push(`Work from: ${s.cwd}`);
  if (s.cliVersion) observed.push(`Original agent: Codex CLI ${s.cliVersion}${s.originator ? ` (${s.originator})` : ''}`);

  const cwdCounts = new Map();
  for (const command of s.commands) {
    if (command.cwd) cwdCounts.set(command.cwd, (cwdCounts.get(command.cwd) ?? 0) + 1);
  }
  const extraCwds = [...cwdCounts.entries()].filter(([c]) => c !== s.cwd).sort((a, b) => b[1] - a[1]);
  if (extraCwds.length) {
    observed.push(
      `Commands also ran from: ${extraCwds.slice(0, 3).map(([c]) => c).join(', ')}`,
    );
  }

  if (observed.length) {
    lines.push('### Environment facts');
    lines.push('');
    for (const fact of observed) lines.push(`- ${fact}`);
  }

  if (lines.length === 0) {
    return ['No AGENTS.md instructions or environment constraints were recorded for this session.'];
  }
  return trimTrailingBlank(lines);
}

/**
 * AGENTS.md is stored in a `world_state` record, but the parsed model keeps the
 * raw session_meta. Look in both, and fall back to any user message that
 * carried the AGENTS.md instructions block.
 *
 * @param {any} session
 */
function extractInstructionsFromSession(session) {
  const direct = session.meta?.agents_md?.text;
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  for (const message of session.messages) {
    const match = /# AGENTS\.md instructions[\s\S]*?<INSTRUCTIONS>\s*([\s\S]*?)\s*<\/INSTRUCTIONS>/.exec(message.text);
    if (match) return match[1].trim();
  }
  return '';
}

/** @param {any} text */
function extractInstructions(text) {
  if (typeof text !== 'string' || text.trim() === '') return '';
  return text.trim();
}

/** @param {any} ctx */
function renderFiles(ctx) {
  const lines = [];
  const s = ctx.session;

  if (ctx.editedFiles.length) {
    lines.push('### Edited in this session');
    lines.push('');
    lines.push('| File | Change | Edits | Last touched |');
    lines.push('| --- | --- | --- | --- |');
    for (const file of ctx.editedFiles.slice(0, 60)) {
      const kinds = [...file.kinds].join('/');
      const when = file.lastMs ? formatDateTime(file.lastMs) : '—';
      lines.push(`| \`${ctx.rel(file.path)}\` | ${kinds} | ${file.edits} | ${when} |`);
    }
    if (ctx.editedFiles.length > 60) {
      lines.push(`| … ${ctx.editedFiles.length - 60} more | | | |`);
    }
    lines.push('');
  }

  if (ctx.readOnlyFiles.length) {
    lines.push('### Read for context (not modified)');
    lines.push('');
    for (const file of ctx.readOnlyFiles.slice(0, 40)) {
      const count = s.commands.length ? '' : '';
      lines.push(`- \`${ctx.rel(file)}\`${count}`);
    }
    if (ctx.readOnlyFiles.length > 40) lines.push(`- … ${ctx.readOnlyFiles.length - 40} more`);
    lines.push('');
  }

  if (s.imagesViewed.length) {
    lines.push('### Images inspected');
    lines.push('');
    for (const image of uniqBy(s.imagesViewed).slice(0, 12)) lines.push(`- \`${ctx.rel(image)}\``);
    lines.push('');
  }

  if (lines.length === 0) {
    return ['No files were read or modified through recorded tool calls in this session.'];
  }
  return trimTrailingBlank(lines);
}

/** @param {any} ctx */
function renderDiffs(ctx) {
  const lines = [];
  const maxFiles = ctx.options.maxDiffFiles ?? 12;
  const maxLines = ctx.options.maxDiffsPerFileLines ?? 120;

  const withDiffs = ctx.editedFiles.filter((f) => f.diff && f.diff.trim() !== '');
  if (withDiffs.length === 0) {
    return ['No unified diffs were captured for this session (edits may predate diff recording).'];
  }

  lines.push('Unified diffs as captured by the previous agent. `+` lines are additions,');
  lines.push('`-` lines are removals. Apply these in context, not blindly.');
  lines.push('');

  for (const file of withDiffs.slice(0, maxFiles)) {
    const diffLines = file.diff.split('\n');
    lines.push(`#### \`${ctx.rel(file.path)}\``);
    lines.push('');
    lines.push('```diff');
    lines.push(...diffLines.slice(0, maxLines));
    if (diffLines.length > maxLines) {
      lines.push(`… ${diffLines.length - maxLines} more diff line(s) omitted`);
    }
    lines.push('```');
    lines.push('');
  }
  if (withDiffs.length > maxFiles) {
    lines.push(`… ${withDiffs.length - maxFiles} further edited file(s) omitted. See FILES THAT MATTER for the full list.`);
  }
  return trimTrailingBlank(lines);
}

/** @param {any} ctx */
function renderCommands(ctx) {
  const s = ctx.session;
  const lines = [];

  if (s.commands.length === 0) return ['No shell commands were recorded.'];

  if (ctx.failedCommands.length) {
    lines.push(`### Failed commands (${ctx.failedCommands.length})`);
    lines.push('');
    lines.push('These returned a non-zero exit status. Some are expected (negative tests,');
    lines.push('probes); others may be the reason the task stalled.');
    lines.push('');
    for (const command of ctx.failedCommands.slice(0, 25)) {
      lines.push('```shell');
      lines.push(`$ ${oneLine(command.command, 400)}`);
      if (command.cwd && command.cwd !== ctx.cwd) lines.push(`# cwd: ${command.cwd}`);
      if (command.stderr) lines.push(`# stderr: ${oneLine(command.stderr, 400)}`);
      else if (command.stdout) lines.push(`# output: ${oneLine(command.stdout, 400)}`);
      lines.push('```');
    }
    if (ctx.failedCommands.length > 25) lines.push(`… ${ctx.failedCommands.length - 25} more failing command(s) omitted.`);
    lines.push('');
  }

  // Successful commands are bulky; keep a deduplicated, ordered digest that
  // shows *how* the project is exercised rather than every invocation.
  const seen = new Set();
  /** @type {string[]} */
  const digest = [];
  for (const command of s.commands) {
    if (command.status === 'failed') continue;
    const head = oneLine(command.command, 220);
    const key = head.slice(0, 90);
    if (seen.has(key)) continue;
    seen.add(key);
    digest.push(head);
  }
  if (digest.length) {
    lines.push(`### Successful commands (${digest.length} distinct of ${s.commands.length - ctx.failedCommands.length})`);
    lines.push('');
    for (const command of digest.slice(0, 60)) lines.push(`- \`${command}\``);
    if (digest.length > 60) lines.push(`- … ${digest.length - 60} more`);
    lines.push('');
  }

  return trimTrailingBlank(lines);
}

/** @param {any} ctx */
function renderResearch(ctx) {
  const s = ctx.session;
  const lines = [];

  if (s.webSearches.length) {
    lines.push('### Web searches performed');
    lines.push('');
    const queries = uniqBy(
      s.webSearches.flatMap((/** @type {any} */ search) =>
        search.queries.length ? search.queries : [search.query],
      ),
    );
    for (const query of queries.slice(0, 40)) lines.push(`- ${query}`);
    if (queries.length > 40) lines.push(`- … ${queries.length - 40} more`);
    lines.push('');
  }

  if (s.mcpCalls.length) {
    lines.push('### MCP / plugin tools used');
    lines.push('');
    const grouped = new Map();
    for (const call of s.mcpCalls) {
      const key = `${call.server} · ${call.tool}`;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    for (const [key, count] of [...grouped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      lines.push(`- ${key} (${count}×)`);
    }
    lines.push('');
  }

  if (lines.length === 0) return ['No external research was recorded.'];
  return trimTrailingBlank(lines);
}

/** @param {any} ctx */
function renderConversation(ctx) {
  const limit = ctx.options.conversationTurns ?? (ctx.options.detail === 'minimal' ? 3 : 8);
  const turns = ctx.turns.slice(-limit);
  if (turns.length === 0) return ['No conversation was recorded.'];

  /** @type {string[]} */
  const lines = [];
  const omitted = ctx.turns.length - turns.length;
  if (omitted > 0) {
    lines.push(`(${omitted} earlier turn(s) omitted — showing the most recent ${turns.length}.)`);
    lines.push('');
  }

  turns.forEach((turn, index) => {
    const when = turn.timestampMs ? formatDateTime(turn.timestampMs) : 'unknown time';
    lines.push(LIGHT);
    lines.push(`Turn ${ctx.turns.length - turns.length + index + 1} of ${ctx.turns.length}  ·  ${when}`);
    if (turn.commands) {
      lines.push(`(${turn.commands} command(s), ${turn.files} file edit(s)${turn.failed ? `, ${turn.failed} failed` : ''})`);
    }
    lines.push(LIGHT);
    lines.push('');
    if (turn.user) {
      lines.push('**User:**');
      lines.push('');
      lines.push(...quote(turn.user, 80));
      lines.push('');
    }
    if (turn.assistant) {
      lines.push('**Assistant:**');
      lines.push('');
      lines.push(...quote(turn.assistant, 80));
      lines.push('');
    } else if (turn.user) {
      lines.push('**Assistant:** _(no reply recorded — the session ended here)_');
      lines.push('');
    }
    if (turn.completed === false && turn.assistant) {
      lines.push('_(This turn never produced a final answer — it was cut short.)_');
      lines.push('');
    }
  });

  return trimTrailingBlank(lines);
}

/** @param {any} ctx */
function renderAppendix(ctx) {
  const s = ctx.session;
  const lines = [];
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  const row = (/** @type {string} */ k, /** @type {any} */ v) => {
    if (v === undefined || v === null || v === '') return;
    lines.push(`| ${k} | ${String(v).replace(/\|/g, '\\|')} |`);
  };
  row('Session id', s.id);
  row('Parent thread', s.parentThreadId);
  row('Thread source', s.threadSource);
  row('Originator', s.originator);
  row('Codex CLI version', s.cliVersion);
  row('Working directory', s.cwd ? `\`${s.cwd}\`` : '');
  row('Git branch', s.git?.branch);
  row('Git commit', s.git?.commit);
  row('Git remote', s.git?.repositoryUrl);
  row('Transcript events', s.stats?.lines);
  row('Transcript bytes', s.stats?.bytes ? formatBytes(s.stats.bytes) : '');
  row('Last activity', s.meta?.timestamp);
  row('Context window', s.contextWindow ? `${formatTokens(s.contextWindow)} tokens` : '');
  if (s.usage) {
    row('Session input tokens', formatTokens(s.usage.input_tokens ?? 0));
    row('Session output tokens', formatTokens(s.usage.output_tokens ?? 0));
    row('Session total tokens', formatTokens(s.usage.total_tokens ?? 0));
  }
  if (s.rateLimit) {
    row('Quota window used', s.rateLimit.primary ? `${s.rateLimit.primary.used_percent}%` : '');
    row('Weekly quota used', s.rateLimit.secondary ? `${s.rateLimit.secondary.used_percent}%` : '');
    row('Plan type', s.rateLimit.plan_type);
  }
  if (ctx.options.includeRawPointers !== false) {
    row('Transcript path', `\`${s.file}\``);
    row(
      'Re-open in Codex',
      s.id ? `\`codex resume ${s.id}\` (or \`codex resume --last\`)` : '',
    );
  }
  lines.push('');
  lines.push('Generated by [ExtraLife](https://github.com/) — session context extraction for');
  lines.push('AI coding agents. The transcript itself is the authoritative record; this');
  lines.push('document is a curated extract of it.');
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render text as an indented, block-quoted excerpt with a line cap.
 * @param {string} text @param {number} maxLines
 */
function quote(text, maxLines) {
  const all = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  // Trim leading/trailing blank lines so quotes start tight.
  while (all.length && all[0].trim() === '') all.shift();
  while (all.length && all[all.length - 1].trim() === '') all.pop();
  const shown = all.slice(0, maxLines);
  const lines = shown.map((line) => (line.trim() === '' ? '>' : `> ${line}`));
  if (all.length > maxLines) {
    lines.push(`> … ${all.length - maxLines} more line(s) omitted`);
  }
  return lines;
}

/** @param {string} text @param {string} prefix */
function indent(text, prefix) {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : prefix + line))
    .join('\n');
}

/** @param {string} text @param {number} max */
function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Resolve a possibly-relative path against a base directory, without touching
 * the filesystem (the referenced paths may no longer exist).
 * @param {string} target @param {string} base
 */
function absolutise(target, base) {
  if (!target) return '';
  if (target.startsWith('/')) return target.replace(/\/+$/, '');
  if (!base) return target;
  return `${base.replace(/\/+$/, '')}/${target}`.replace(/\/+$/, '');
}

/** @param {string[]} lines */
function trimTrailingBlank(lines) {
  const out = [...lines];
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

export { extractInstructionsFromSession };
