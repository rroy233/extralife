/**
 * Demo data for the README screenshots and the sample handoff.
 *
 * Entirely invented. Every project, title and message here is fiction — using a
 * contributor's real transcripts in documentation would leak their source code,
 * and invented data lets the examples be chosen rather than merely found.
 *
 * The sessions are also deliberately playful: a Kubernetes operator that waters
 * houseplants, a cat feeder with a portion-control bug. Real enough to be
 * obviously plausible, funny enough to be obviously fake.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TranscriptBuilder } from '../test/helpers/fixture.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Rows for the picker screenshot, newest first.
 * @param {number} now
 */
export function demoPickerEntries(now = Date.now()) {
  /** @type {any[]} */
  const raw = [
    {
      id: '01a12926',
      title: 'Reconcile the soil-moisture CRD',
      project: 'plant-operator',
      branch: 'main',
      cwd: '/home/dev/src/plant-operator',
      age: 0.3 * HOUR,
      size: 8_912_384,
      primary: 100,
      secondary: 34,
      exhausted: '5h limit reached',
      resetsIn: 4 * HOUR,
      tokens: 181_003,
      preview: 'The controller reconciles on every probe flap. Add hysteresis so it only acts after 3 consecutive out-of-band samples.',
    },
    {
      id: '01a124ec',
      title: 'Stop the feeder double-dropping kibble',
      project: 'whisker-feeder',
      branch: 'feat/portion-control',
      cwd: '/home/dev/src/whisker-feeder',
      age: 2 * HOUR,
      size: 4_089_339,
      primary: 67,
      secondary: 29,
      tokens: 92_400,
      preview: 'The 06:00 schedule fires twice when the RTC drifts. Make the portion dispenser idempotent per schedule slot.',
    },
    {
      id: '01a12f7e',
      title: 'Add tail-call optimisation to the reader',
      project: 'zig-lisp',
      branch: 'main',
      cwd: '/home/dev/src/zig-lisp',
      age: 6 * HOUR,
      size: 11_534_336,
      primary: 30,
      secondary: 15,
      tokens: 240_100,
      preview: 'Deeply recursive lisp loops blow the stack. Implement TCO in the evaluator for self-recursive tail calls.',
    },
    {
      id: '01a12e76',
      title: 'Fix the starter rise-time regression',
      project: 'sourdough-tracker',
      branch: 'main',
      cwd: '/home/dev/src/sourdough-tracker',
      age: 11 * HOUR,
      size: 702_464,
      primary: 13,
      secondary: 10,
      tokens: 12_800,
      preview: 'Since the temperature-compensation commit, predicted rise times are 40% short below 20°C.',
    },
    {
      id: '01a125d3',
      title: 'Port the nvim config to Lua',
      project: 'dotfiles',
      branch: 'main',
      cwd: '/home/dev/dotfiles',
      age: 14 * HOUR,
      size: 4_613_734,
      primary: 61,
      secondary: 10,
      tokens: 76_400,
      preview: 'Migrate init.vim to init.lua without losing the LSP keymaps. Keep it loadable at every step.',
    },
    {
      id: '01a123c2',
      title: 'Parse the brokerage CSV export',
      project: 'taxes-2026',
      branch: 'main',
      cwd: '/home/dev/taxes-2026',
      age: 2 * DAY,
      size: 14_680_064,
      primary: 30,
      secondary: 99,
      tokens: 151_000,
      preview: 'The wash-sale detection misses lots held across a dividend reinvestment. Cross-check against the 1099.',
    },
    {
      id: '01a111ae',
      title: "Stop rhyming 'code' with 'road'",
      project: 'haiku-bot',
      branch: 'main',
      cwd: '/home/dev/haiku-bot',
      age: 3 * DAY,
      size: 1_310_720,
      primary: 76,
      secondary: 93,
      tokens: 48_200,
      preview: 'The phoneme table has no entry for coda /d/, so every rhyme falls back to spelling. Fix the CMUdict lookup.',
    },
  ];

  return raw.map((entry) => ({
    file: `/home/dev/.codex/sessions/${entry.id}.jsonl`,
    id: entry.id,
    title: entry.title,
    cwd: entry.cwd,
    projectLabel: entry.project,
    mtimeMs: now,
    sizeBytes: entry.size,
    lastActivityMs: now - entry.age,
    cliVersion: '0.162.0',
    originator: 'Codex CLI',
    threadSource: 'user',
    gitBranch: entry.branch,
    archived: false,
    interactive: true,
    exhaustedReason: entry.exhausted,
    primaryUsedPercent: entry.primary,
    secondaryUsedPercent: entry.secondary,
    resetsAtMs: entry.resetsIn ? now + entry.resetsIn : undefined,
    planType: 'plus',
    contextWindow: 258_400,
    totalTokens: entry.tokens,
    preview: entry.preview,
  }));
}

/** Section costs shown on the options screen, matching the sample session. */
export const DEMO_SECTION_TOKENS = {
  howto: 284,
  mission: 612,
  next: 268,
  state: 1_940,
  deadends: 2_380,
  constraints: 540,
  files: 1_120,
  conversation: 5_260,
  diffs: 6_480,
  commands: 3_110,
  research: 120,
  appendix: 337,
};

/**
 * The session used for the sample handoff excerpt: a Kubernetes operator that
 * waters houseplants, interrupted by the quota running out.
 *
 * @param {string} dir
 * @returns {string} path to the written transcript
 */
export function demoHandoffSession(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const project = '/home/dev/src/plant-operator';

  const b = new TranscriptBuilder({ sessionId: '01a12926-4f2c-7c11-9a3e-2b8d1f0e7c44', cwd: project });
  b.meta();
  b.worldState(
    '# plant-operator\n\n' +
      '- Every controller change needs an envtest.\n' +
      '- CRDs are generated: run `make manifests` after editing the API types.\n' +
      '- Never commit a regenerated CRD without the matching Go type change.',
  );
  b.tokenCount({ primary: 41, secondary: 22, total: 18_400 });

  // ── Turn 1 ────────────────────────────────────────────────────────────────
  b.userMessage(
    'The soil-moisture controller reconciles on every probe flap — the pump ' +
      'chatters whenever a reading sits near the threshold. Add hysteresis so it ' +
      'only acts after 3 consecutive out-of-band samples (~90s at our probe rate).',
    't1',
  );
  b.planSteps(
    [
      { step: 'Read the reconciler and the probe sampling path', status: 'completed' },
      { step: 'Add a consecutive-sample hysteresis window', status: 'completed' },
      { step: 'Persist the sample buffer across reconciles', status: 'in_progress' },
      { step: 'Cover the flap case with an envtest', status: 'pending' },
    ],
    't1',
  );
  b.command('rg -n "Reconcile|probe" internal/controller', {
    turnId: 't1',
    stdout:
      'internal/controller/reconciler.go:48:func (r *SoilMoistureReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {\n' +
      'internal/controller/probe.go:21:func (p *ProbeReader) Sample(ctx context.Context) (Reading, error) {',
    parsedCmd: [{ type: 'search', cmd: 'rg -n "Reconcile|probe" internal/controller', name: 'controller' }],
  });
  b.command('go test ./internal/controller/... -run TestHysteresis', {
    turnId: 't1',
    status: 'failed',
    exitCode: 1,
    stderr:
      '--- FAIL: TestHysteresis (0.42s)\n' +
      '    suite.go:73: failed to start control plane: no matches for kind "SoilMoisture" in version "garden.example.com/v1"\n' +
      '        ensure CRDs are installed first',
  });
  b.command('go test ./internal/controller/... -run TestHysteresis', {
    turnId: 't1',
    status: 'failed',
    exitCode: 1,
    stderr:
      '--- FAIL: TestHysteresis (0.39s)\n' +
      '    suite.go:73: failed to start control plane: no matches for kind "SoilMoisture" in version "garden.example.com/v1"\n' +
      '        ensure CRDs are installed first',
  });
  b.fileChange(
    `${project}/internal/controller/hysteresis.go`,
    'add',
    '@@ -0,0 +1,26 @@\n' +
      '+package controller\n' +
      '+\n' +
      '+// windowSize is the number of consecutive out-of-band samples required\n' +
      '+// before the pump is allowed to change state. At the 30s probe interval\n' +
      '+// this is the ~90s dwell the field reports asked for.\n' +
      '+const windowSize = 3\n' +
      '+\n' +
      '+// Hysteresis suppresses pump chatter when a reading oscillates around the\n' +
      '+// threshold. It is intentionally not persisted yet: a controller restart\n' +
      '+// resets the window, which is acceptable while the dwell is under 2 minutes.\n' +
      '+type Hysteresis struct {\n' +
      '+\tlow, high float64\n' +
      '+\tsamples   []float64\n' +
      '+}\n' +
      '+\n' +
      '+func (h *Hysteresis) Observe(v float64) bool {\n' +
      '+\th.samples = append(h.samples, v)\n' +
      '+\tif len(h.samples) > windowSize {\n' +
      '+\t\th.samples = h.samples[len(h.samples)-windowSize:]\n' +
      '+\t}\n' +
      '+\tif len(h.samples) < windowSize {\n' +
      '+\t\treturn false\n' +
      '+\t}\n' +
      '+\tfor _, s := range h.samples {\n' +
      '+\t\tif s >= h.low && s <= h.high {\n' +
      '+\t\t\treturn false\n' +
      '+\t\t}\n' +
      '+\t}\n' +
      '+\treturn true\n' +
      '+}\n',
  );
  b.fileChange(
    `${project}/internal/controller/reconciler.go`,
    'update',
    '@@ -45,8 +45,14 @@ func (r *SoilMoistureReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {\n' +
      ' \treading, err := r.Probe.Sample(ctx)\n' +
      ' \tif err != nil {\n' +
      ' \t\treturn ctrl.Result{}, err\n' +
      ' \t}\n' +
      '-\tif reading.Value < r.Threshold {\n' +
      '+\t// Hysteresis owns the decision now; the raw threshold comparison was\n' +
      '+\t// what made the pump chatter on a flapping probe.\n' +
      '+\tif !r.Hysteresis.Observe(reading.Value) {\n' +
      '+\t\treturn ctrl.Result{RequeueAfter: 30 * time.Second}, nil\n' +
      '+\t}\n' +
      '+\tif reading.Value < r.Hysteresis.low {\n' +
      ' \t\tr.Pump.Start(ctx)\n' +
      ' \t}\n',
  );
  b.agentMessage(
    'Hysteresis is in and wired into the reconciler: the pump now needs three ' +
      'consecutive out-of-band samples before it changes state.\n\n' +
      'The envtest suite cannot start. `make test` fails during control-plane ' +
      'bootstrap with:\n\n' +
      '    no matches for kind "SoilMoisture" in version "garden.example.com/v1"\n\n' +
      'The CRD manifests are generated, not committed, so the envtest binary has ' +
      'nothing to install. I have not worked around it yet.',
    'final_answer',
    't1',
  );
  b.push('event_msg', {
    type: 'task_complete',
    turn_id: 't1',
    last_agent_message: 'Hysteresis implemented; envtest blocked on missing CRDs.',
  });

  // ── Turn 2 — interrupted by the quota ─────────────────────────────────────
  b.tick(6);
  b.userMessage(
    'Run `make manifests` first and point envtest at config/crd/bases, then rerun the suite.',
    't2',
  );
  b.command('make manifests', { turnId: 't2', stdout: 'controller-gen v0.16.5\nwriting config/crd/bases/garden.example.com_soilmoistures.yaml' });
  b.agentMessage(
    'Manifests regenerated. I am wiring `config/crd/bases` into the envtest suite ' +
      'now and will rerun the hysteresis test next.',
    'commentary',
    't2',
  );
  b.tokenCount({ primary: 100, secondary: 34, total: 24_900, reached: 'rate_limit_reached' });

  const file = path.join(dir, 'rollout-demo.jsonl');
  fs.writeFileSync(file, b.toJSONL(), 'utf8');
  return file;
}

/** A scratch directory for the demo transcript. */
export function demoDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'extralife-demo-'));
}
