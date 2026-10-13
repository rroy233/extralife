/**
 * Secret redaction for exported handoffs.
 *
 * Coding-agent transcripts routinely contain credentials: an agent echoes a
 * `.env`, prints a token while debugging, or pastes a connection string into a
 * shell command. A handoff document is designed to be handed to a *different*
 * agent, often a different vendor — so redaction is on by default.
 *
 * The rules are deliberately high-precision. A false positive silently destroys
 * context, which is the whole point of the document, so each pattern requires a
 * recognisable credential shape (a known prefix, a long high-entropy body, or an
 * explicit `key = value` assignment) rather than guessing at anything that
 * merely looks random.
 *
 * Set `--no-redact` to disable, or `--redact-list` to see what was removed.
 */

/**
 * @typedef {Object} RedactionRule
 * @property {string} id
 * @property {RegExp} pattern
 * @property {string} [replacement]
 * @property {string} describe
 */

/**
 * Ordered rules. Order matters: specific vendor prefixes run before the generic
 * assignment rule so that the more informative label wins.
 *
 * @type {RedactionRule[]}
 */
export const REDACTION_RULES = [
  {
    id: 'private-key',
    // Whole PEM blocks, so a pasted key does not leak its body either.
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    replacement: '[REDACTED PRIVATE KEY BLOCK]',
    describe: 'PEM private key block',
  },
  {
    id: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
    describe: 'Anthropic API key',
  },
  {
    id: 'openai-key',
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}\b/g,
    describe: 'OpenAI-style secret key',
  },
  {
    id: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    describe: 'GitHub token',
  },
  {
    id: 'github-pat',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    describe: 'GitHub fine-grained PAT',
  },
  {
    id: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    describe: 'AWS access key id',
  },
  {
    id: 'aws-secret',
    pattern: /(?<=(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}(?=["']?)/g,
    describe: 'AWS secret access key',
  },
  {
    id: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    describe: 'Slack token',
  },
  {
    id: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    describe: 'Google API key',
  },
  {
    id: 'jwt',
    // header.payload.signature, each base64url — distinctive enough to be safe.
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    describe: 'JSON Web Token',
  },
  {
    id: 'bearer-header',
    pattern: /\b(Authorization\s*:\s*Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: '$1 [REDACTED]',
    describe: 'Authorization: Bearer header',
  },
  {
    id: 'url-credentials',
    // scheme://user:password@host — the password half is the secret.
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):([^\s/@]{6,})@/gi,
    replacement: '$1:[REDACTED]@',
    describe: 'password embedded in a URL',
  },
  {
    id: 'cli-flag-secret',
    // --password=…, --token=…, -p … appear verbatim in shell commands.
    pattern: /(\s--?(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|auth[-_]?token|client[-_]?secret)[= ])(?!\[REDACTED)(["']?)([^\s"']{6,})\2/gi,
    replacement: '$1$2[REDACTED]$2',
    describe: 'secret passed as a command-line flag',
  },
  {
    id: 'env-assignment',
    // KEY=value where the key name signals a credential and the value is long
    // enough to be a real secret rather than a placeholder.
    pattern: /\b((?:[A-Z][A-Z0-9_]*_)?(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH))\s*[=:]\s*(["']?)(?!\[REDACTED|REDACTED|\$\{?[A-Z_])([^\s"']{8,})\2/g,
    replacement: '$1=$2[REDACTED]$2',
    describe: 'credential-looking environment assignment',
  },
  {
    id: 'json-secret-field',
    // "password": "…" / "apiKey": "…" inside pasted JSON.
    pattern: /(["'](?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)["']\s*:\s*["'])(?!\[REDACTED)([^"']{6,})(["'])/gi,
    replacement: '$1[REDACTED]$3',
    describe: 'credential field in JSON',
  },
  {
    id: 'yaml-secret-field',
    pattern: /^(\s*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\s*:\s*)(?!\[REDACTED|>|\||null|~)(\S{6,})\s*$/gim,
    replacement: '$1[REDACTED]',
    describe: 'credential field in YAML',
  },
  {
    id: 'basic-auth-base64',
    pattern: /\b(Authorization\s*:\s*Basic)\s+[A-Za-z0-9+/=]{12,}/gi,
    replacement: '$1 [REDACTED]',
    describe: 'Authorization: Basic header',
  },
];

/**
 * @typedef {Object} RedactionResult
 * @property {string} text
 * @property {Array<{ id: string, describe: string, count: number }>} findings
 * @property {number} total
 */

/**
 * Redact secrets from a block of text.
 *
 * @param {string} text
 * @param {{ rules?: RedactionRule[] }} [opts]
 * @returns {RedactionResult}
 */
export function redactSecrets(text, opts = {}) {
  const rules = opts.rules ?? REDACTION_RULES;
  let output = String(text ?? '');
  /** @type {Array<{ id: string, describe: string, count: number }>} */
  const findings = [];
  let total = 0;

  for (const rule of rules) {
    // Rules are applied with a fresh lastIndex because the regexes are global
    // and shared across calls.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let count = 0;
    output = output.replace(pattern, (...args) => {
      count++;
      if (rule.replacement !== undefined) {
        // Support `$1`-style backreferences in the replacement.
        return rule.replacement.replace(/\$(\d)/g, (_match, index) => String(args[Number(index)] ?? ''));
      }
      return `[REDACTED:${rule.id}]`;
    });
    if (count > 0) {
      findings.push({ id: rule.id, describe: rule.describe, count });
      total += count;
    }
  }

  return { text: output, findings, total };
}

/**
 * Redact an entire rendered document.
 *
 * Redaction runs on the finished text rather than on each field, so a secret
 * cannot slip through by being split across a section boundary or embedded in a
 * diff hunk.
 *
 * @param {string} text
 * @param {boolean} enabled
 * @returns {{ text: string, findings: RedactionResult['findings'], total: number }}
 */
export function redactDocument(text, enabled = true) {
  if (!enabled) return { text, findings: [], total: 0 };
  const result = redactSecrets(text);
  return { text: result.text, findings: result.findings, total: result.total };
}
