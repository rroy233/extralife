import { randomBytes } from 'node:crypto';

/** Build a synthetic credential at runtime for redaction tests. */
export function makeSecret(prefix = '', bytes = 24) {
  return [prefix, randomBytes(bytes).toString('hex')].join('');
}
