/**
 * JSON renderer.
 *
 * Emits a stable, documented structure for programmatic consumers — editor
 * integrations, dashboards, or an agent that prefers structured input to prose.
 * The shape is versioned via `schemaVersion` so downstream code can detect
 * changes.
 *
 * Large payloads (stdout, diffs) are already truncated by the parser, so the
 * output stays bounded.
 */

import { redactDocument } from './redact.js';

export const SCHEMA_VERSION = 1;

/**
 * @param {any} session parsed session
 * @param {{
 *   sections?: string[],
 *   redact?: boolean,
 *   sourceLabel?: string,
 *   includeRawEvents?: boolean,
 * }} [options]
 * @returns {string}
 */
export function renderJson(session, options = {}) {
  const enabled = new Set(options.sections ?? []);
  const include = (/** @type {string} */ id) => enabled.size === 0 || enabled.has(id);

  /** @type {any} */
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: 'extralife', version: '1.0.0' },
    generatedAt: new Date().toISOString(),
    session: {
      id: session.id,
      title: options.sourceLabel ?? null,
      transcriptPath: session.file,
      cwd: session.cwd || null,
      threadSource: session.threadSource,
      originator: session.originator || null,
      cliVersion: session.cliVersion || null,
      parentThreadId: session.parentThreadId || null,
      git: {
        branch: session.git?.branch ?? null,
        commit: session.git?.commit ?? null,
        repositoryUrl: session.git?.repositoryUrl ?? null,
      },
      stats: {
        events: session.stats.lines,
        bytes: session.stats.bytes,
        messages: session.messages.length,
        turns: session.turns.length,
        commands: session.commands.length,
        failedCommands: session.commands.filter((/** @type {any} */ c) => c.status === 'failed').length,
        fileChanges: session.fileChanges.length,
        webSearches: session.webSearches.length,
        mcpCalls: session.mcpCalls.length,
      },
      usage: session.usage ?? null,
      contextWindow: session.contextWindow ?? null,
      rateLimit: session.rateLimit
        ? {
            primaryUsedPercent: session.rateLimit.primary?.used_percent ?? null,
            primaryWindowMinutes: session.rateLimit.primary?.window_minutes ?? null,
            primaryResetsAt: session.rateLimit.primary?.resets_at
              ? new Date(session.rateLimit.primary.resets_at * 1000).toISOString()
              : null,
            secondaryUsedPercent: session.rateLimit.secondary?.used_percent ?? null,
            secondaryWindowMinutes: session.rateLimit.secondary?.window_minutes ?? null,
            secondaryResetsAt: session.rateLimit.secondary?.resets_at
              ? new Date(session.rateLimit.secondary.resets_at * 1000).toISOString()
              : null,
            planType: session.rateLimit.plan_type ?? null,
            reachedType: session.rateLimit.rate_limit_reached_type ?? null,
          }
        : null,
    },
  };

  if (include('mission')) {
    payload.mission = {
      threadGoal: session.threadGoal || null,
      requests: session.turns
        .filter((/** @type {any} */ turn) => turn.userText)
        .map((/** @type {any} */ turn) => ({
          at: turn.startedMs ? new Date(turn.startedMs).toISOString() : null,
          text: turn.userText,
        })),
    };
  }

  if (include('state')) {
    payload.plan = session.plans.length
      ? session.plans.map((/** @type {any} */ plan) => ({
          at: plan.timestampMs ? new Date(plan.timestampMs).toISOString() : null,
          text: plan.text || null,
          steps: plan.steps ?? [],
        }))
      : null;
    payload.compactionSummary = session.compactionSummary || null;
    payload.agentInstructions = session.agentInstructions || null;
  }

  if (include('next')) {
    const plan = session.plans[session.plans.length - 1];
    const lastTurn = session.turns[session.turns.length - 1];
    payload.nextSteps = {
      interruptedRequest: lastTurn && lastTurn.userText && !lastTurn.finalText ? lastTurn.userText : null,
      openPlanSteps: (plan?.steps ?? []).filter((/** @type {any} */ step) => step.status !== 'completed'),
      failedCommands: session.commands.filter((/** @type {any} */ c) => c.status === 'failed').length,
      uncommittedFiles: [...new Set(session.fileChanges.map((/** @type {any} */ c) => c.path))].length,
    };
  }

  if (include('files')) {
    /** @type {Map<string, { path: string, kinds: string[], edits: number, lastAt: string|null }>} */
    const files = new Map();
    for (const change of session.fileChanges) {
      const existing = files.get(change.path) ?? { path: change.path, kinds: [], edits: 0, lastAt: null };
      if (!existing.kinds.includes(change.kind)) existing.kinds.push(change.kind);
      existing.edits++;
      existing.lastAt = change.timestampMs ? new Date(change.timestampMs).toISOString() : existing.lastAt;
      files.set(change.path, existing);
    }
    payload.files = [...files.values()].sort((a, b) => b.edits - a.edits);
  }

  if (include('diffs')) {
    payload.diffs = session.fileChanges
      .filter((/** @type {any} */ c) => c.diff)
      .map((/** @type {any} */ c) => ({ path: c.path, kind: c.kind, unifiedDiff: c.diff }));
  }

  if (include('commands')) {
    payload.commands = session.commands.map((/** @type {any} */ c) => ({
      command: c.command,
      cwd: c.cwd || null,
      status: c.status,
      exitCode: c.exitCode ?? null,
      at: c.timestampMs ? new Date(c.timestampMs).toISOString() : null,
      stdout: c.stdout || null,
      stderr: c.stderr || null,
      touched: c.touched,
    }));
  }

  if (include('research')) {
    payload.research = {
      webSearches: session.webSearches.map((/** @type {any} */ s) => ({
        query: s.query,
        queries: s.queries,
        at: s.timestampMs ? new Date(s.timestampMs).toISOString() : null,
      })),
      mcpCalls: session.mcpCalls.map((/** @type {any} */ c) => ({
        server: c.server,
        tool: c.tool,
        title: c.title || null,
        status: c.status,
      })),
    };
  }

  if (include('conversation')) {
    payload.conversation = session.turns.map((/** @type {any} */ turn) => ({
      id: turn.turnId || null,
      at: turn.startedMs ? new Date(turn.startedMs).toISOString() : null,
      user: turn.userText || null,
      assistant: turn.finalText || null,
    }));
  }

  let text = JSON.stringify(payload, null, 2) + '\n';
  if (options.redact !== false) {
    text = redactDocument(text, true).text;
  }
  return text;
}
