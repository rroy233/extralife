/**
 * Markdown renderer.
 *
 * The plain-text handoff is already Markdown-flavoured, so rather than
 * maintaining a second section implementation (and risking the two drifting
 * apart) this converts the canonical rendering: the ASCII rules become ATX
 * headings and a YAML front-matter block is prepended with machine-readable
 * provenance.
 */

import { renderHandoff } from './handoff.js';

/**
 * @param {any} session
 * @param {Parameters<typeof renderHandoff>[1]} [options]
 * @returns {{ text: string, stats: any, trimmed: boolean }}
 */
export function renderMarkdown(session, options = {}) {
  const rendered = renderHandoff(session, options);
  const lines = rendered.text.split('\n');
  /** @type {string[]} */
  const out = [];

  out.push('---');
  out.push(`extralife_version: 1`);
  out.push(`session_id: ${session.id}`);
  out.push(`generated: ${new Date().toISOString()}`);
  if (session.cwd) out.push(`project: ${quoteYaml(session.cwd)}`);
  if (session.git?.branch) out.push(`git_branch: ${quoteYaml(session.git.branch)}`);
  if (session.git?.commit) out.push(`git_commit: ${session.git.commit}`);
  out.push(`turns: ${session.turns.length}`);
  out.push(`files_edited: ${new Set(session.fileChanges.map((/** @type {any} */ c) => c.path)).size}`);
  out.push(`commands_run: ${session.commands.length}`);
  out.push('---');
  out.push('');
  out.push('# ExtraLife handoff');
  out.push('');

  // Rewrite the ASCII banner and rules into headings.
  const HEAVY = /^={20,}$/;
  const LIGHT = /^-{20,}$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (HEAVY.test(line) && lines[i + 1]?.startsWith('  ') && HEAVY.test(lines[i + 2] ?? '')) {
      const title = lines[i + 1].trim();
      // The document title banner is already represented by the H1 above.
      if (!title.startsWith('EXTRALIFE HANDOFF')) {
        out.push(`## ${title}`);
      }
      i += 2;
      continue;
    }
    if (LIGHT.test(line) && (lines[i + 1]?.startsWith('  End of handoff') ?? false)) {
      out.push('---');
      i += 2;
      continue;
    }
    if (line.startsWith('╔') || line.startsWith('╚') || line.startsWith('║')) continue;
    // The plain-text document indents header fields by two spaces; keep them.
    out.push(line);
  }

  const text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  return {
    text: text.endsWith('\n') ? text : text + '\n',
    stats: {
      ...rendered.stats,
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: text.split('\n').length,
    },
    trimmed: rendered.trimmed,
  };
}

/** Quote a YAML scalar when it contains characters that need it. */
function quoteYaml(value) {
  const text = String(value);
  return /[:#\-{}[\],&*?|>'"%@`]/.test(text) || text.trim() !== text
    ? JSON.stringify(text)
    : text;
}
