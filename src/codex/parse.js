/**
 * Full parser for a single Codex rollout transcript.
 *
 * The transcript is JSONL where every line has the envelope
 * `{ timestamp, ordinal, type, payload }`. We consume it as a stream so that
 * multi-megabyte sessions never have to be held in memory twice, and we
 * aggressively truncate large payloads (stdout, diffs) at parse time because a
 * handoff document only ever needs a representative excerpt.
 *
 * Sources of truth, in priority order:
 *   1. `event_msg` / `item_completed` — the richest, most structured source.
 *      Carries UserMessage, AgentMessage, CommandExecution (with `parsed_cmd`),
 *      FileChange (with `unified_diff`), Plan, WebSearch, McpToolCall, ImageView.
 *   2. `response_item` / `message` — always present; used for assistant text and
 *      as a fallback for user text when a transcript predates `item_completed`.
 *   3. `response_item` / `function_call` | `custom_tool_call` — fallbacks for
 *      `update_plan` (structured steps) and `apply_patch` (file edits).
 *   4. `event_msg` / `token_count` — rate-limit / quota snapshots.
 *
 * The same logical event can appear in more than one of these channels, so all
 * collection happens through de-duplicating helpers.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

/** Truncation limits — tuned so a handoff stays useful without exploding. */
export const LIMITS = {
  stdout: 2000,
  stderr: 1000,
  diff: 3000,
  message: 24000,
  commandString: 2000,
  maxMessages: 4000,
  maxCommands: 4000,
  maxFileChanges: 3000,
  maxPlans: 200,
};

/**
 * Text that Codex injects *as* the user role but which the human never typed.
 * These are recognised by their opening marker and dropped, otherwise the
 * handoff fills up with environment dumps and plugin manifests.
 */
const INJECTION_PREFIXES = [
  '<environment_context>',
  '<codex_internal_context',
  '<external_codex_apps_open_page>',
  '<in-app-browser-context',
  '<recommended_plugins>',
  '<realtime_delegation>',
  '<subagent_notification>',
  '<turn_aborted>',
  '<user_instructions>',
  '<skill>',
  '<send_user_message_question_reply>',
  '<permissions instructions>',
  '<system_notification>',
  '# AGENTS.md instructions',
  '# Response annotations:',
  '# Files mentioned by the user:',
  '# Files pasted by the user:',
  '## Codex CLI',
  // Codex's automatic security-reviewer threads replay the parent transcript as
  // a "user" message. Those threads are not human work sessions and are hidden
  // by default, but the text is filtered here too so nothing leaks through when
  // a user explicitly opts to include them.
  'The following is the Codex agent history',
];

/**
 * @param {string} text
 * @returns {boolean} true when this "user" text is really a system injection
 */
export function isInjectedUserText(text) {
  const trimmed = String(text ?? '').trimStart();
  if (trimmed === '') return true;
  return INJECTION_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Decode a `file://` URL (or pass a plain path through). */
export function fileUrlToPath(value) {
  if (typeof value !== 'string') return '';
  if (!value.startsWith('file://')) return value;
  try {
    return decodeURIComponent(new URL(value).pathname);
  } catch {
    return value.replace(/^file:\/\//, '');
  }
}

/** @param {string} s @param {number} max */
function clip(s, max) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

/** @returns {string} */
function emptyToNull(s) {
  return typeof s === 'string' && s.trim() !== '' ? s : '';
}

/**
 * Parse the OpenAI `apply_patch` envelope into per-file changes.
 *
 * Format:
 *   *** Begin Patch
 *   *** Update File: <path>
 *   <body>
 *   *** Add File: <path>
 *   +<body>
 *   *** Delete File: <path>
 *   *** End Patch
 *
 * @param {string} input
 * @returns {Array<{ path: string, kind: 'update'|'add'|'delete', diff: string }>}
 */
export function parseApplyPatch(input) {
  if (typeof input !== 'string' || !input.includes('*** ')) return [];
  /** @type {Array<{ path: string, kind: 'update'|'add'|'delete', diff: string }>} */
  const changes = [];
  /** @type {{ path: string, kind: 'update'|'add'|'delete', lines: string[] } | null} */
  let current = null;
  for (const line of input.split('\n')) {
    const directive = /^\*\*\* (Update|Add|Delete) File: (.+?)\s*$/.exec(line);
    if (directive) {
      if (current) changes.push({ path: current.path, kind: current.kind, diff: current.lines.join('\n') });
      current = {
        path: directive[2].trim(),
        kind: /** @type {any} */ (directive[1].toLowerCase()),
        lines: [],
      };
      continue;
    }
    if (/^\*\*\* (Begin Patch|End Patch|Move to:)/.test(line)) continue;
    if (current) current.lines.push(line);
  }
  if (current) changes.push({ path: current.path, kind: current.kind, diff: current.lines.join('\n') });
  return changes;
}

/**
 * Turn an `update_plan` argument blob into normalized steps.
 * @param {string} rawJson
 * @returns {Array<{ step: string, status: string }>}
 */
export function parsePlanArguments(rawJson) {
  if (typeof rawJson !== 'string' || rawJson.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  const plan = Array.isArray(parsed) ? parsed : parsed?.plan;
  if (!Array.isArray(plan)) return [];
  /** @type {Array<{ step: string, status: string }>} */
  const steps = [];
  for (const entry of plan) {
    if (typeof entry === 'string') {
      steps.push({ step: entry, status: 'pending' });
    } else if (entry && typeof entry === 'object' && typeof entry.step === 'string') {
      steps.push({ step: entry.step, status: String(entry.status ?? 'pending') });
    }
  }
  return steps;
}

/** Extract the `cmd` from an `exec` / `exec_command` tool call input blob. */
export function extractCommandFromToolInput(input) {
  if (typeof input !== 'string' || input === '') return '';
  // `exec` custom tools wrap a JS snippet: `const r = await tools.exec_command({...});`
  const jsonStart = input.indexOf('{');
  if (jsonStart !== -1) {
    const candidate = input.slice(jsonStart);
    // The snippet ends with `});` — trim balanced-ish and try progressively.
    for (const slice of [candidate.replace(/\);?\s*$/, ''), candidate]) {
      try {
        const parsed = JSON.parse(slice);
        if (parsed && typeof parsed.cmd === 'string') return parsed.cmd;
      } catch {
        /* keep trying */
      }
    }
  }
  const direct = /\{"cmd":"((?:[^"\\]|\\.)*)"/.exec(input);
  if (direct) {
    try {
      return JSON.parse(`"${direct[1]}"`);
    } catch {
      return direct[1];
    }
  }
  return '';
}

/**
 * @typedef {Object} ParsedMessage
 * @property {'user'|'assistant'} role
 * @property {string} text
 * @property {number} timestampMs
 * @property {string} turnId
 * @property {string} [phase]
 */

/**
 * @typedef {Object} ParsedCommand
 * @property {string} command
 * @property {string} cwd
 * @property {'completed'|'failed'|'unknown'} status
 * @property {number|null} exitCode
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} timestampMs
 * @property {string} turnId
 * @property {Array<{ type: string, name?: string, path?: string }>} touched
 */

/**
 * @typedef {Object} ParsedFileChange
 * @property {string} path
 * @property {'add'|'update'|'delete'} kind
 * @property {string} diff
 * @property {number} timestampMs
 * @property {string} turnId
 */

/**
 * @typedef {Object} ParsedSession
 * @property {any} meta
 * @property {string} id
 * @property {string} file
 * @property {string} cwd
 * @property {string} threadSource
 * @property {string} originator
 * @property {string} cliVersion
 * @property {string} parentThreadId
 * @property {ParsedMessage[]} messages
 * @property {ParsedCommand[]} commands
 * @property {ParsedFileChange[]} fileChanges
 * @property {Array<{ text: string, steps: Array<{step:string,status:string}>, timestampMs: number, turnId: string }>} plans
 * @property {Array<{ query: string, queries: string[], timestampMs: number }>} webSearches
 * @property {Array<{ server: string, tool: string, title: string, status: string, timestampMs: number }>} mcpCalls
 * @property {string[]} imagesViewed
 * @property {any|null} rateLimit
 * @property {any|null} usage
 * @property {number|null} contextWindow
 * @property {{ branch?: string, commit?: string, repositoryUrl?: string }} git
 * @property {string} threadGoal
 * @property {string} agentInstructions
 * @property {string} agentInstructionsDir
 * @property {string} compactionSummary
 * @property {Array<{ id: string, turnId: string, startedMs: number, completedMs: number, userText: string, finalText: string, completed: boolean, truncated: boolean }>} turns
 * @property {{ lines: number, bytes: number, skippedLines: number, elapsedMs: number }} stats
 */

/**
 * Parse a rollout file into a normalized session model.
 *
 * @param {string} file
 * @param {{ onProgress?: (linesRead: number) => void }} [opts]
 * @returns {Promise<ParsedSession>}
 */
export async function parseSessionFile(file, opts = {}) {
  const startedAt = Date.now();
  const stat = await fs.promises.stat(file);

  /** @type {any} */
  let meta = null;
  /** @type {ParsedMessage[]} */
  const messages = [];
  /** @type {ParsedCommand[]} */
  const commands = [];
  /** @type {ParsedFileChange[]} */
  const fileChanges = [];
  /** @type {ParsedSession['plans']} */
  const plans = [];
  /** @type {ParsedSession['webSearches']} */
  const webSearches = [];
  /** @type {ParsedSession['mcpCalls']} */
  const mcpCalls = [];
  /** @type {string[]} */
  const imagesViewed = [];
  /** @type {any|null} */
  let rateLimit = null;
  /** @type {any|null} */
  let usage = null;
  /** @type {number|null} */
  let contextWindow = null;
  /** @type {Map<string, string>} assistant message id -> phase */
  const agentPhases = new Map();
  /** @type {Set<string>} normalised dedup keys for user messages */
  const seenUserText = new Set();
  /** @type {Set<string>} assistant message ids already collected */
  const seenAssistantIds = new Set();
  /** @type {Map<string, { text: string, steps: any[], timestampMs: number, turnId: string }>} */
  const latestPlanByTurn = new Map();
  /** @type {Map<string, { startedMs: number, completedMs: number, userText: string, finalText: string }>} */
  const turnMap = new Map();
  /** @type {Set<string>} */
  const seenApplyPatchCallIds = new Set();
  let threadGoal = '';
  let agentInstructions = '';
  let agentInstructionsDir = '';
  let compactionSummary = '';
  let lineCount = 0;
  let skippedLines = 0;

  const rl = readline.createInterface({
    input: openTranscriptStream(file),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    lineCount++;
    if (opts.onProgress && lineCount % 5000 === 0) opts.onProgress(lineCount);
    const line = rawLine.trim();
    if (line === '' || line.charCodeAt(0) !== 0x7b) {
      if (line !== '') skippedLines++;
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      skippedLines++;
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    const timestampMs = Date.parse(record.timestamp ?? '') || 0;
    const payload = record.payload;
    if (!payload || typeof payload !== 'object') continue;

    switch (record.type) {
      case 'session_meta':
        meta = payload;
        break;
      case 'event_msg':
        handleEventMsg(payload, timestampMs);
        break;
      case 'response_item':
        handleResponseItem(payload, timestampMs);
        break;
      case 'compacted':
        handleCompacted(payload, timestampMs);
        break;
      case 'world_state':
        handleWorldState(payload);
        break;
      default:
        break;
    }
  }

  /**
   * `world_state` snapshots carry the AGENTS.md text that Codex loaded for the
   * project. That is the user's own rulebook, so it travels into the handoff.
   * @param {any} payload
   */
  function handleWorldState(payload) {
    const state = payload?.state;
    if (!state || typeof state !== 'object') return;
    const text = state.agents_md?.text;
    if (typeof text === 'string' && text.trim() !== '') {
      agentInstructions = text.trim();
      agentInstructionsDir = String(state.agents_md?.directory ?? '');
    }
  }

  function noteTurn(turnId, patch) {
    if (!turnId) return;
    const existing = turnMap.get(turnId) ?? { startedMs: 0, completedMs: 0, userText: '', finalText: '' };
    turnMap.set(turnId, { ...existing, ...patch });
  }

  /** @param {any} payload @param {number} timestampMs */
  function handleEventMsg(payload, timestampMs) {
    switch (payload.type) {
      case 'item_completed':
        handleItem(payload.item ?? {}, payload.turn_id ?? '', timestampMs);
        break;
      case 'task_started':
        noteTurn(payload.turn_id ?? '', { startedMs: (payload.started_at ?? 0) * 1000 || timestampMs });
        break;
      case 'task_complete':
        noteTurn(payload.turn_id ?? '', {
          completedMs: (payload.completed_at ?? 0) * 1000 || timestampMs,
          finalText: emptyToNull(payload.last_agent_message ?? ''),
        });
        break;
      case 'turn_aborted':
        noteTurn(payload.turn_id ?? '', { completedMs: timestampMs });
        break;
      case 'token_count':
        if (payload.rate_limits) rateLimit = { ...payload.rate_limits, timestampMs };
        if (payload.info?.total_token_usage) usage = payload.info.total_token_usage;
        if (typeof payload.info?.model_context_window === 'number') contextWindow = payload.info.model_context_window;
        break;
      default:
        break;
    }
  }

  /** @param {any} payload @param {number} timestampMs */
  function handleResponseItem(payload, timestampMs) {
    switch (payload.type) {
      case 'message':
        handleMessage(payload, timestampMs);
        break;
      case 'function_call':
      case 'custom_tool_call':
        handleToolCall(payload, timestampMs);
        break;
      case 'agent_message': {
        // Inter-agent traffic; only the plaintext part is meaningful.
        const text = collectContentText(payload.content);
        if (text) noteTurn(String(payload.turn_id ?? ''), {});
        break;
      }
      default:
        break;
    }
  }

  /** @param {any} payload @param {number} timestampMs */
  function handleMessage(payload, timestampMs) {
    const role = payload.role;
    const text = collectContentText(payload.content);
    if (!text) return;
    if (role === 'assistant') {
      const id = String(payload.id ?? '');
      if (id && seenAssistantIds.has(id)) return;
      if (id) seenAssistantIds.add(id);
      if (messages.length < LIMITS.maxMessages) {
        messages.push({
          role: 'assistant',
          text: clip(text, LIMITS.message),
          timestampMs,
          turnId: String(payload.turn_id ?? payload.internal_chat_message_metadata_passthrough?.turn_id ?? ''),
          phase: agentPhases.get(id),
        });
      }
      return;
    }
    if (role === 'user') {
      if (isInjectedUserText(text)) {
        const goal = extractThreadGoal(text);
        if (goal) threadGoal = goal;
        return;
      }
      pushUserMessage(text, timestampMs, String(payload.internal_chat_message_metadata_passthrough?.turn_id ?? ''));
    }
  }

  /** @param {string} text @param {number} timestampMs @param {string} turnId */
  function pushUserMessage(text, timestampMs, turnId) {
    const key = normalizeForDedup(text);
    if (key === '' || seenUserText.has(key)) return;
    seenUserText.add(key);
    if (messages.length >= LIMITS.maxMessages) return;
    messages.push({ role: 'user', text: clip(text, LIMITS.message), timestampMs, turnId });
    noteTurn(turnId, { userText: clip(text, 4000), startedMs: timestampMs });
  }

  /** @param {any} item @param {string} turnId @param {number} timestampMs */
  function handleItem(item, turnId, timestampMs) {
    switch (item.type) {
      case 'UserMessage': {
        const text = collectContentText(item.content);
        if (text && !isInjectedUserText(text)) pushUserMessage(text, timestampMs, turnId);
        break;
      }
      case 'AgentMessage': {
        const id = String(item.id ?? '');
        if (item.phase) agentPhases.set(id, String(item.phase));
        const text = collectContentText(item.content);
        if (text && id && !seenAssistantIds.has(id) && messages.length < LIMITS.maxMessages) {
          seenAssistantIds.add(id);
          messages.push({
            role: 'assistant',
            text: clip(text, LIMITS.message),
            timestampMs,
            turnId,
            phase: item.phase ? String(item.phase) : undefined,
          });
        }
        break;
      }
      case 'CommandExecution':
        if (commands.length < LIMITS.maxCommands) {
          commands.push({
            command: clip(String(item.command?.join(' ') ?? ''), LIMITS.commandString),
            cwd: fileUrlToPath(item.cwd),
            status: item.status === 'failed' ? 'failed' : item.status === 'completed' ? 'completed' : 'unknown',
            exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
            stdout: clip(String(item.stdout ?? ''), LIMITS.stdout),
            stderr: clip(String(item.stderr ?? ''), LIMITS.stderr),
            timestampMs,
            turnId,
            touched: (Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [])
              .filter((c) => c && typeof c === 'object')
              .map((c) => ({
                type: String(c.type ?? 'unknown'),
                name: c.name ? String(c.name) : undefined,
                path: c.path ? String(c.path) : undefined,
              }))
              .slice(0, 40),
          });
        }
        break;
      case 'FileChange':
        for (const [path, change] of Object.entries(item.changes ?? {})) {
          if (fileChanges.length >= LIMITS.maxFileChanges) break;
          const c = /** @type {any} */ (change);
          fileChanges.push({
            path: fileUrlToPath(path),
            kind: c?.type === 'add' ? 'add' : c?.type === 'delete' ? 'delete' : 'update',
            diff: clip(String(c?.unified_diff ?? ''), LIMITS.diff),
            timestampMs,
            turnId,
          });
        }
        break;
      case 'Plan':
        if (typeof item.text === 'string' && item.text.trim() !== '') {
          latestPlanByTurn.set(turnId || `plan-${plans.length}`, {
            text: clip(item.text, 12000),
            steps: [],
            timestampMs,
            turnId,
          });
        }
        break;
      case 'WebSearch': {
        const query = String(item.query ?? (Array.isArray(item.action?.queries) ? item.action.queries[0] : '') ?? '');
        if (query) {
          webSearches.push({
            query: clip(query, 300),
            queries: (Array.isArray(item.action?.queries) ? item.action.queries : []).map((q) => String(q)).slice(0, 8),
            timestampMs,
          });
        }
        break;
      }
      case 'McpToolCall':
        mcpCalls.push({
          server: String(item.server ?? ''),
          tool: String(item.tool ?? ''),
          title: clip(String(item.arguments?.title ?? ''), 160),
          status: String(item.status ?? ''),
          timestampMs,
        });
        break;
      case 'ImageView':
        imagesViewed.push(fileUrlToPath(String(item.path ?? '')));
        break;
      default:
        break;
    }
  }

  /** @param {any} payload @param {number} timestampMs */
  function handleToolCall(payload, timestampMs) {
    const name = String(payload.name ?? '');
    const turnId = String(payload.internal_chat_message_metadata_passthrough?.turn_id ?? '');
    if (name === 'apply_patch') {
      const callId = String(payload.call_id ?? payload.id ?? '');
      if (callId && seenApplyPatchCallIds.has(callId)) return;
      if (callId) seenApplyPatchCallIds.add(callId);
      const input = String(payload.input ?? payload.arguments ?? '');
      for (const change of parseApplyPatch(input)) {
        if (fileChanges.length >= LIMITS.maxFileChanges) break;
        fileChanges.push({
          path: fileUrlToPath(change.path),
          kind: change.kind,
          diff: clip(change.diff, LIMITS.diff),
          timestampMs,
          turnId,
        });
      }
      return;
    }
    if (name === 'update_plan') {
      const steps = parsePlanArguments(String(payload.arguments ?? payload.input ?? ''));
      if (steps.length > 0) {
        latestPlanByTurn.set(turnId || `plan-${plans.length}`, { text: '', steps, timestampMs, turnId });
      }
      return;
    }
  }

  /**
   * `compacted` records hold the replacement history Codex keeps after trimming
   * context. The user/assistant turns inside are real and otherwise lost, so we
   * fold any not-yet-seen user messages back in.
   *
   * @param {any} payload
   * @param {number} timestampMs
   */
  function handleCompacted(payload, timestampMs) {
    // `compacted.message` occasionally carries a readable plaintext summary of
    // what was trimmed. It is empty in most transcripts (the model-facing
    // summary is an opaque encrypted blob), but when present it is the single
    // best description of everything that happened earlier in the session.
    const summary = payload?.message;
    if (typeof summary === 'string' && summary.trim() !== '' && summary.length > compactionSummary.length) {
      compactionSummary = summary.trim();
    }

    const history = payload?.replacement_history;
    if (!Array.isArray(history)) return;
    for (const entry of history) {
      if (!entry || entry.type !== 'message') continue;
      const text = collectContentText(entry.content);
      if (!text) continue;
      if (entry.role === 'user' && !isInjectedUserText(text)) {
        pushUserMessage(text, Date.parse(entry.timestamp ?? '') || timestampMs, '');
      }
    }
  }

  // Preserve original chronological order (the file is append-only, but the
  // compaction fold-in above can insert out of order).
  messages.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));

  // Turns are derived from the *message sequence* rather than from turn ids.
  // Turn metadata is absent in older transcripts and in sessions resumed into a
  // new context window, so pairing each user message with the assistant replies
  // that follow it is the only approach that works everywhere. Where turn ids
  // and task_complete records do exist, they enrich the result with authoritative
  // timings and the agent's own final message.
  const turns = buildTurns(messages, turnMap);

  for (const plan of latestPlanByTurn.values()) plans.push(plan);

  const sessionId = String(meta?.id ?? path.basename(file).replace(/^rollout-/, '').replace(/\.jsonl$/, ''));

  return {
    meta: meta ?? {},
    id: sessionId,
    file,
    cwd: String(meta?.cwd ?? ''),
    threadSource: String(meta?.thread_source ?? 'user'),
    originator: String(meta?.originator ?? ''),
    cliVersion: String(meta?.cli_version ?? ''),
    parentThreadId: meta?.parent_thread_id ? String(meta.parent_thread_id) : '',
    messages,
    commands,
    fileChanges,
    plans,
    webSearches,
    mcpCalls,
    imagesViewed,
    rateLimit,
    usage,
    contextWindow,
    git: {
      branch: meta?.git?.branch,
      commit: meta?.git?.commit_hash,
      repositoryUrl: meta?.git?.repository_url,
    },
    threadGoal,
    agentInstructions,
    agentInstructionsDir,
    compactionSummary,
    turns,
    stats: {
      lines: lineCount,
      bytes: stat.size,
      skippedLines,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

/**
 * Open a transcript as a readable text stream.
 *
 * Codex compresses transcripts older than roughly a week to `.jsonl.zst`, so
 * the decompressor is inserted transparently when the suffix is present.
 *
 * @param {string} file
 * @returns {NodeJS.ReadableStream}
 */
function openTranscriptStream(file) {
  if (file.endsWith('.zst')) {
    const create = /** @type {any} */ (zlib).createZstdDecompress;
    if (typeof create === 'function') {
      return fs.createReadStream(file).pipe(create());
    }
    // Without zstd support there is nothing to read. Yield an empty stream so
    // the caller produces an empty (rather than crashing) session. `Readable`
    // is used instead of `/dev/null` so this also works on Windows.
    return Readable.from([]);
  }
  return fs.createReadStream(file, { encoding: 'utf8' });
}

/**
 * Pair user requests with the assistant work that followed them.
 *
 * @param {ParsedMessage[]} messages chronologically sorted, de-duplicated
 * @param {Map<string, { startedMs: number, completedMs: number, userText: string, finalText: string }>} turnMap
 * @returns {ParsedSession['turns']}
 */
function buildTurns(messages, turnMap) {
  /** @type {ParsedSession['turns']} */
  const turns = [];
  /** @type {any} */
  let current = null;

  // Whether the transcript records an explicit `final_answer` phase at all.
  // Older transcripts do not, and for those we cannot distinguish a finished
  // turn from an abandoned one, so we fall back to "has any reply".
  const sawPhaseData = messages.some((m) => m.role === 'assistant' && m.phase);

  const close = () => {
    if (!current) return;
    const meta = current.turnId ? turnMap.get(current.turnId) : undefined;
    if (meta?.userText && !current.userText) current.userText = meta.userText;
    const finalText = meta?.finalText || current.finalAnswerText || current.lastAssistantText || '';
    turns.push({
      id: current.turnId,
      turnId: current.turnId,
      startedMs: meta?.startedMs || current.startedMs || 0,
      completedMs: meta?.completedMs || 0,
      userText: current.userText,
      finalText,
      // A turn that never produced a `final_answer` was cut off. `task_complete`
      // does NOT indicate success — it also fires for aborted turns — so the
      // message phase is the only dependable signal.
      completed: sawPhaseData ? Boolean(current.finalAnswerText) : Boolean(finalText),
      truncated: false,
    });
    current = null;
  };

  for (const message of messages) {
    if (message.role === 'user') {
      close();
      current = {
        turnId: message.turnId,
        startedMs: message.timestampMs,
        userText: message.text,
        finalText: '',
      };
      continue;
    }
    if (!current) {
      // An assistant message with no preceding user message (a resumed or
      // forked transcript). Keep it as its own turn rather than dropping it.
      current = { turnId: message.turnId, startedMs: message.timestampMs, userText: '', finalText: '' };
    }
    if (message.phase === 'final_answer') {
      current.finalAnswerText = message.text;
    }
    // Commentary and interim replies are kept only as a display fallback.
    current.lastAssistantText = message.text;
  }
  close();

  // A turn may exist only in the event stream (for example a user message whose
  // text arrived inside a compaction record). Add any that were missed.
  const seen = new Set(turns.map((turn) => turn.turnId).filter(Boolean));
  for (const [turnId, value] of turnMap) {
    if (!turnId || seen.has(turnId)) continue;
    if (!value.userText && !value.finalText) continue;
    turns.push({
      id: turnId,
      turnId,
      startedMs: value.startedMs,
      completedMs: value.completedMs,
      userText: value.userText,
      finalText: value.finalText,
    });
  }

  turns.sort((a, b) => (a.startedMs || 0) - (b.startedMs || 0));
  // The session ended here, so the final turn was necessarily cut short even if
  // it happens to look complete.
  const last = turns[turns.length - 1];
  if (last) last.truncated = true;
  return turns;
}

/** Join the `text` parts of a Codex content array. */
function collectContentText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    // Encrypted reasoning blobs carry no readable text — skip them.
    if (typeof part.text === 'string' && part.text !== '') parts.push(part.text);
  }
  return parts.join('\n').trim();
}

/** Normalise text so cosmetic differences don't defeat de-duplication. */
function normalizeForDedup(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 4000);
}

/**
 * Pull the `<objective>` out of a `codex_internal_context source="goal"` block.
 * @param {string} text
 * @returns {string}
 */
function extractThreadGoal(text) {
  if (!text.includes('<objective>')) return '';
  const match = /<objective>\s*([\s\S]*?)\s*<\/objective>/.exec(text);
  return match ? match[1].trim().slice(0, 4000) : '';
}
