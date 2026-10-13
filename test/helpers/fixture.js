/**
 * Synthetic Codex transcripts for tests.
 *
 * Tests must not depend on the machine's own `~/.codex` directory: that data is
 * private, changes constantly, and would make the suite non-reproducible. This
 * builder emits transcripts in the exact envelope the parser consumes, covering
 * the variants observed in real rollouts (both the `item_completed` channel and
 * the legacy `response_item` channel, injected user text, plan items, patches,
 * rate limits and compactions).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let counter = 0;

/** Build a rollout transcript as an array of JSONL-ready records. */
export class TranscriptBuilder {
  constructor(options = {}) {
    this.ordinal = 0;
    /** @type {any[]} */
    this.records = [];
    this.sessionId = options.sessionId ?? '01a111ae-9891-7b30-95de-79cd6f0a7279';
    this.cwd = options.cwd ?? '/Users/dev/project';
    this.startTime = options.startTime ?? Date.parse('2026-10-10T11:00:00Z');
    this.minute = 0;
  }

  /** Advance the simulated clock. */
  tick(minutes = 1) {
    this.minute += minutes;
    return this;
  }

  get timestamp() {
    return new Date(this.startTime + this.minute * 60_000).toISOString();
  }

  push(type, payload) {
    this.records.push({ timestamp: this.timestamp, ordinal: this.ordinal++, type, payload });
    return this;
  }

  meta(overrides = {}) {
    return this.push('session_meta', {
      id: this.sessionId,
      session_id: this.sessionId,
      timestamp: this.timestamp,
      cwd: this.cwd,
      originator: 'Codex CLI',
      cli_version: '0.162.0',
      thread_source: 'user',
      git: { branch: 'main', commit_hash: 'abc123def4567890abc123def4567890abc12345' },
      ...overrides,
    });
  }

  /** A real, human-typed user message (the only source of truth for intent). */
  userMessage(text, turnId = `turn-${this.ordinal}`) {
    this.push('event_msg', {
      type: 'item_completed',
      turn_id: turnId,
      item: { type: 'UserMessage', id: `01a11${this.ordinal}`, content: [{ type: 'text', text }] },
    });
    return this;
  }

  /** A message and its mirrored `response_item`, as Codex actually writes them. */
  agentMessage(text, phase = 'final_answer', turnId = `turn-${this.ordinal}`) {
    const id = `msg_${this.ordinal}`;
    this.push('event_msg', {
      type: 'item_completed',
      turn_id: turnId,
      item: { type: 'AgentMessage', id, content: [{ type: 'Text', text }], phase },
    });
    this.push('response_item', {
      type: 'message',
      id,
      role: 'assistant',
      content: [{ type: 'output_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    });
    return this;
  }

  /** A legacy assistant message with no `item_completed` counterpart. */
  legacyAssistant(text, turnId = `turn-${this.ordinal}`) {
    this.push('response_item', {
      type: 'message',
      id: `legacy_${this.ordinal}`,
      role: 'assistant',
      content: [{ type: 'output_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    });
    return this;
  }

  /** A `user`-role response_item that no human typed (injection). */
  injectedUser(text) {
    this.push('response_item', {
      type: 'message',
      id: `inj_${this.ordinal}`,
      role: 'user',
      content: [{ type: 'input_text', text }],
    });
    return this;
  }

  command(command, options = {}) {
    this.push('event_msg', {
      type: 'item_completed',
      turn_id: options.turnId ?? `turn-${this.ordinal}`,
      item: {
        type: 'CommandExecution',
        id: `exec-${this.ordinal}`,
        command: ['/bin/zsh', '-lc', command],
        cwd: options.cwd ?? `file://${this.cwd}`,
        status: options.status ?? 'completed',
        exit_code: options.exitCode ?? 0,
        stdout: options.stdout ?? '',
        stderr: options.stderr ?? '',
        parsed_cmd: options.parsedCmd ?? [],
      },
    });
    return this;
  }

  fileChange(filePath, kind, diff, turnId = `turn-${this.ordinal}`) {
    this.push('event_msg', {
      type: 'item_completed',
      turn_id: turnId,
      item: {
        type: 'FileChange',
        id: `fc-${this.ordinal}`,
        status: 'completed',
        changes: {
          [filePath.startsWith('/') ? filePath : `${this.cwd}/${filePath}`]: {
            type: kind,
            unified_diff: diff,
          },
        },
      },
    });
    return this;
  }

  plan(text) {
    this.push('event_msg', {
      type: 'item_completed',
      turn_id: `turn-${this.ordinal}`,
      item: { type: 'Plan', id: `${this.ordinal}-plan`, text },
    });
    return this;
  }

  planSteps(steps, turnId = `turn-${this.ordinal}`) {
    this.push('response_item', {
      type: 'function_call',
      id: `fc_${this.ordinal}`,
      name: 'update_plan',
      arguments: JSON.stringify({ plan: steps }),
      call_id: `call_${this.ordinal}`,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    });
    return this;
  }

  applyPatch(patchText) {
    this.push('response_item', {
      type: 'custom_tool_call',
      id: `ctc_${this.ordinal}`,
      status: 'completed',
      call_id: `call_patch_${this.ordinal}`,
      name: 'apply_patch',
      input: patchText,
    });
    return this;
  }

  tokenCount({ primary = 30, secondary = 20, plan = 'plus', reached = null, total = 1000, contextWindow = 258400 } = {}) {
    this.push('event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: total - 100, output_tokens: 100, total_tokens: total },
        last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        model_context_window: contextWindow,
      },
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: primary, window_minutes: 300, resets_at: 1791827666 },
        secondary: { used_percent: secondary, window_minutes: 10080, resets_at: 1792296531 },
        credits: { has_credits: false, unlimited: false, balance: '0' },
        plan_type: plan,
        rate_limit_reached_type: reached,
      },
    });
    return this;
  }

  worldState(agentsMd) {
    this.push('world_state', {
      full: true,
      state: { agents_md: { directory: this.cwd, text: agentsMd } },
    });
    return this;
  }

  compacted(summary, replacementHistory = []) {
    this.push('compacted', { message: summary, replacement_history: replacementHistory });
    return this;
  }

  webSearch(query) {
    this.push('event_msg', {
      type: 'item_completed',
      turn_id: `turn-${this.ordinal}`,
      item: { type: 'WebSearch', id: `ws_${this.ordinal}`, query, action: { type: 'search', query, queries: [query] } },
    });
    return this;
  }

  /** An event type the parser does not know; must be ignored without error. */
  unknownEvent() {
    this.push('event_msg', { type: 'some_future_event_type', detail: { nested: true } });
    this.push('response_item', { type: 'brand_new_item', blob: 'x' });
    return this;
  }

  /** Serialise to JSONL. */
  toJSONL() {
    return this.records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  }

  /** Write to a temp file and return its path. */
  writeTo(dir, name = `rollout-test-${counter++}.jsonl`) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, this.toJSONL(), 'utf8');
    return file;
  }
}

/** Create a unique temp directory for a test, cleaned up by the caller. */
export function tempDir(prefix = 'extralife-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A realistic small session used by several tests: two turns, a failed command,
 * an edited file, a plan, an AGENTS.md rule and an exhausted quota.
 */
export function sampleSession(overrides = {}) {
  const b = new TranscriptBuilder(overrides);
  b.meta();
  b.worldState('# Project rules\n\n- Always write tests.\n- Never use `--force`.');
  b.tokenCount({ primary: 42, secondary: 18, total: 5000 });
  b.userMessage('Add a health-check endpoint to the API', 'turn-1');
  b.planSteps([
    { step: 'Read the existing router', status: 'completed' },
    { step: 'Add the /healthz route', status: 'in_progress' },
    { step: 'Write a test for it', status: 'pending' },
  ], 'turn-1');
  b.command('rg -n "router" src/', {
    turnId: 'turn-1',
    stdout: 'src/router.ts:12:const router = express.Router();',
    parsedCmd: [{ type: 'search', cmd: 'rg -n "router" src/', name: 'router' }],
  });
  b.command('npm test', {
    turnId: 'turn-1',
    status: 'failed',
    exitCode: 1,
    stderr: 'Error: Cannot find module "supertest"\n    at Module._resolveFilename',
  });
  b.fileChange('src/router.ts', 'update', '@@ -10,3 +10,7 @@\n const router = express.Router();\n+\n+router.get("/healthz", (_req, res) => {\n+  res.json({ ok: true });\n+});\n');
  b.agentMessage('Added the route. The test suite fails because `supertest` is not installed.', 'final_answer', 'turn-1');
  b.push('event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'Added the route but tests cannot run.' });

  b.tick(3);
  b.userMessage('Install supertest and make the tests pass', 'turn-2');
  b.command('npm install --save-dev supertest', { turnId: 'turn-2', stdout: 'added 12 packages' });
  b.agentMessage('Installing now; I will rerun the suite next.', 'commentary', 'turn-2');
  b.tokenCount({ primary: 100, secondary: 34, total: 9000, reached: 'rate_limit_reached' });
  return b;
}

export { TranscriptBuilder as Builder };
