#!/usr/bin/env node
/**
 * Generate the README screenshots.
 *
 * Pipeline: drive the real UI components with invented demo data → capture the
 * bytes they write to the terminal → convert ANSI to HTML → screenshot with
 * headless Chrome at 2x → trim to the window.
 *
 *   npm run screenshots
 *
 * Re-run after any layout change. The images cannot drift from the code because
 * they are generated from it.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderTerminalHtml } from './ansi-to-html.mjs';
import { wrap } from '../src/util/ansi.js';
import { demoDir, demoHandoffSession, demoPickerEntries, DEMO_SECTION_TOKENS } from './demo-sessions.mjs';
import { createTestTerminal, settle } from '../test/helpers/tui-harness.js';
import { pickSession } from '../src/ui/picker.js';
import { exportOptionsScreen } from '../src/ui/options.js';
import { parseSessionFile } from '../src/codex/parse.js';
import { renderHandoff } from '../src/render/handoff.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.join(ROOT, 'docs', 'images');
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const COLUMNS = 104;
const ROWS = 24;
/** Screenshots are captured at 2x for retina displays. */
const SCALE = 2;

/** Capture the final frame a screen draws, ANSI intact. */
function lastFrame(raw) {
  const frames = raw.split('\u001b[H').filter((frame) => frame.trim() !== '');
  const frame = frames[frames.length - 1] ?? raw;
  const lines = frame
    .replace(/\u001b\[\?25[hl]/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\u001b\[[0-9]+;[0-9]+H/g, ''));
  // Drop trailing blank rows so the image has no dead space.
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(0, end);
}

/** Render one screen and return its frame. */
async function capture(run) {
  const { term, stdout } = createTestTerminal({ columns: COLUMNS, rows: ROWS, color: true });
  const promise = run(term);
  await settle(400);
  const frame = lastFrame(stdout.raw);
  for (const handler of [...term._keyHandlers]) {
    handler({ name: 'ctrl-c', ctrl: true, alt: false, shift: false });
  }
  await Promise.resolve(promise).catch(() => {});
  return frame;
}

/**
 * Render a frame to a PNG via headless Chrome.
 *
 * Chrome is asked for a deliberately oversized window, then the bitmap is
 * trimmed to the window's own bounds. Computing the size up front would depend
 * on exact font metrics, which vary per machine.
 */
function emit(name, lines, title, options = {}) {
  const html = renderTerminalHtml({
    lines,
    title,
    fontSize: options.fontSize ?? 12,
    padding: options.padding ?? 16,
    chrome: options.chrome !== false,
  });

  const tmpHtml = path.join(ROOT, `.screenshot-${name}.html`);
  const tmpPng = path.join(ROOT, `.screenshot-${name}.png`);
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const chromeArgs = [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--user-data-dir=${path.join(ROOT, '.chrome-profile')}`,
  ];

  // Pass 1 — measure the window element exactly.
  const dom = execFileSync(
    CHROME,
    [...chromeArgs, '--virtual-time-budget=2000', '--dump-dom', `file://${tmpHtml}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const measured = /data-size="(\d+)x(\d+)"/.exec(dom);
  if (!measured) throw new Error(`could not measure the frame for ${name}`);
  const cssWidth = Number(measured[1]);
  const cssHeight = Number(measured[2]);

  // Pass 2 — screenshot at exactly that size. `--window-size` is in CSS pixels;
  // the device scale factor produces the 2x bitmap.
  execFileSync(
    CHROME,
    [
      ...chromeArgs,
      `--force-device-scale-factor=${SCALE}`,
      // A couple of pixels of slack: the measured height can be fractional and
      // a viewport rounded down clips the bottom border. The page background is
      // transparent, so the slack is invisible.
      `--window-size=${cssWidth + 4},${cssHeight + 4}`,
      `--screenshot=${tmpPng}`,
      `file://${tmpHtml}`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  const pngPath = path.join(OUT_DIR, `${name}.png`);
  fs.copyFileSync(tmpPng, pngPath);
  fs.rmSync(tmpHtml, { force: true });
  fs.rmSync(tmpPng, { force: true });

  const size = fs.statSync(pngPath).size;
  console.log(
    `  ${path.relative(ROOT, pngPath).padEnd(28)} ${cssWidth}×${cssHeight}  (${(size / 1024).toFixed(0)} KB)`,
  );
}

/** Trim a rendered document down to the sections worth showing. */
function excerpt(text, headings) {
  const lines = text.split('\n');
  const RULE = /^[=-]{20,}$/;
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const isBanner =
      RULE.test(lines[i]) && RULE.test(lines[i + 2] ?? '') && (lines[i + 1] ?? '').startsWith('  ');
    if (!isBanner) continue;
    if (!headings.some((heading) => lines[i + 1].trim().startsWith(heading))) continue;
    out.push(lines[i], lines[i + 1], lines[i + 2], '');
    for (let j = i + 3; j < lines.length; j++) {
      const nextIsBanner =
        RULE.test(lines[j]) && RULE.test(lines[j + 2] ?? '') && (lines[j + 1] ?? '').startsWith('  ');
      if (nextIsBanner) break;
      out.push(lines[j]);
    }
    out.push('');
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`Chrome not found at ${CHROME}. Set CHROME_PATH to override.`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('Generating README screenshots from the real UI…');

  // ── 1. Session picker ─────────────────────────────────────────────────────
  const entries = demoPickerEntries();
  const pickerFrame = await capture((term) =>
    pickSession(term, entries, {
      home: '~/.codex',
      enrich: async () => ({
        messages: 184,
        turns: 41,
        fileChanges: 23,
        commands: 96,
        failedCommands: 3,
        plans: 1,
        totalTokens: 181_003,
        topFiles: [
          'internal/controller/hysteresis.go×4',
          'internal/controller/reconciler.go×3',
        ],
      }),
    }),
  );
  emit('picker', pickerFrame, 'extralife — choose a session', { fontSize: 12 });

  // ── 2. Export options ─────────────────────────────────────────────────────
  const optionsFrame = await capture((term) =>
    exportOptionsScreen(term, {
      session: {
        title: 'Reconcile the soil-moisture CRD',
        projectLabel: 'plant-operator',
        cwd: '/home/dev/src/plant-operator',
      },
      sectionTokens: DEMO_SECTION_TOKENS,
      documentTokens: 0,
      documentBytes: 0,
    }),
  );
  emit('options', optionsFrame, 'extralife — export options', { fontSize: 12 });

  // ── 3. The generated handoff excerpt ──────────────────────────────────────
  const dir = demoDir();
  const session = await parseSessionFile(demoHandoffSession(dir));
  const rendered = renderHandoff(session, {
    detail: 'standard',
    sourceLabel: 'Reconcile the soil-moisture CRD',
    generatedAt: Date.parse('2026-10-13T09:12:00Z'),
  });
  // The document is emitted as continuous prose; wrap it to a terminal width
  // so the screenshot shows what a reader actually sees. Only the NEXT STEPS
  // section is shown — it is the part that earns the tool its keep, and a
  // README image has to stay short enough to actually be read.
  const DOC_COLUMNS = 88;
  const MAX_LINES = 27;
  const docLines = excerpt(rendered.text, ['NEXT STEPS'])
    .flatMap((line) => (line.trim() === '' ? [''] : wrap(line, DOC_COLUMNS)))
    .slice(0, MAX_LINES);
  emit('handoff', docLines, 'extralife-plant-operator-20261013-1712.txt', {
    fontSize: 11,
    padding: 14,
    columns: DOC_COLUMNS,
  });
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('Done.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
