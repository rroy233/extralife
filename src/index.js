/**
 * ExtraLife — public programmatic API.
 *
 * The CLI is the primary interface, but the pieces are exported so the tool can
 * be embedded: index Codex sessions, parse one transcript, and render a handoff
 * without going through a terminal.
 *
 * @example
 * import { buildSessionIndex, parseSessionFile, renderHandoff } from 'extralife';
 *
 * const [newest] = await buildSessionIndex();
 * const session = await parseSessionFile(newest.file);
 * const { text, stats } = renderHandoff(session, { detail: 'standard' });
 * console.log(stats.tokens, text.length);
 */

export { buildSessionIndex, cacheDir, interpretRateLimit, projectLabel } from './codex/index-cache.js';
export { codexHome, findSessionFiles, inspectCodexHome, readSessionIndex, readHeadAndTail } from './codex/locate.js';
export { parseSessionFile, parseApplyPatch, parsePlanArguments, isInjectedUserText } from './codex/parse.js';
export { renderHandoff, DEFAULT_SECTIONS, DETAIL_LEVELS } from './render/handoff.js';
export { renderMarkdown } from './render/markdown.js';
export { renderJson, SCHEMA_VERSION } from './render/json.js';
export { redactSecrets, redactDocument, REDACTION_RULES } from './render/redact.js';
export { estimateTokens, formatBytes, formatTokens, relativeTime } from './util/format.js';
export { main, parseArgs, VERSION } from './cli.js';
