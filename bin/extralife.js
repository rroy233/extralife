#!/usr/bin/env node
/**
 * ExtraLife (续命) — executable entry point.
 *
 * Keeps `main` free of process-level concerns: this shim owns exit codes,
 * broken-pipe handling and the top-level error boundary, so an unexpected
 * failure prints one readable line instead of a stack trace.
 */

import { main } from '../src/cli.js';

// A closed stdout (`extralife --stdout | head`) is a normal way for a pipeline
// to end, not an error worth a stack trace.
process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') process.exit(0);
  throw error;
});
process.stderr.on('error', () => {});

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
} catch (error) {
  const message = error?.stack ?? String(error);
  process.stderr.write(`\nExtraLife hit an unexpected error.\n\n${message}\n`);
  process.stderr.write(
    `\nThis is a bug. Please report it with the output above at\n` +
      `https://github.com/rroy233/extralife/issues\n`,
  );
  process.exitCode = 1;
}
