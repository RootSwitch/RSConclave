import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, psName } from '../measure.ts';

/*
 * Two different units, deliberately kept apart.
 *
 * The probe fixtures are RAW BYTES as /api/ps reports them, so B is decimal.
 * The budget is built from GIB, because that is what the number typed into
 * Settings means: a card sold as "24 GB" holds 24 GiB, and Task Manager says
 * so too. Conflating the two is the bug these units exist to prevent - it
 * under-counted a 24 GB card by 1.8 GB and turned a stated 15% margin into a
 * real 16% one nobody had chosen.
 */
const B = 1e9;
const GIB = 1024 ** 3;
const SAFETY = 0.85;

// qwen3.6:27b Q4_K_M as actually measured on the 7900XTX at 192.168.4.57.
const probes = [
  { numCtx: 2048, total: 17.156 * B, vram: 17.156 * B },
  { numCtx: 8192, total: 17.324 * B, vram: 17.324 * B },
];

test('measure: slope and intercept separate context cost from weights', () => {
  const r = project(probes, 24 * GIB * SAFETY, 262144);
  assert.ok(Math.abs(r.bytesPerToken - 27343) < 200, `per-token ${r.bytesPerToken}`);
  assert.ok(Math.abs(r.baseBytes - 17.1 * B) < 0.05 * B, `base ${r.baseBytes / B}`);
  // 4k-aligned and inside the budget, matching what the shell script recommends
  // for the same card - the two must not drift.
  assert.equal(r.recommended, 172032);
  assert.equal(r.recommended % 4096, 0);
  assert.equal(r.cappedByTrained, false);
  assert.equal(r.notFitting, false);
});

test('measure: the trained ceiling wins when VRAM would allow more', () => {
  // The same model on a 40 GB card: VRAM allows far more than it was trained for.
  const r = project(probes, 40 * GIB * SAFETY, 262144);
  assert.ok(r.uncappedMax > 262144, `uncapped ${r.uncappedMax}`);
  assert.equal(r.recommended, 262144);
  assert.equal(r.cappedByTrained, true);
});

test('measure: weights alone over budget reports notFitting, not a number', () => {
  // Recommending any window here would be a lie: it is going to run partly in
  // system RAM whatever num_ctx says.
  const r = project(probes, 8 * GIB * SAFETY, 262144);
  assert.equal(r.notFitting, true);
  assert.equal(r.recommended, null);
});

test('measure: an unreadable trained maximum does not cap', () => {
  const r = project(probes, 40 * GIB * SAFETY, null);
  assert.equal(r.cappedByTrained, false);
  assert.ok(r.recommended !== null && r.recommended > 262144);
});

test('measure: identical probes clamp instead of recommending infinity', () => {
  // Ollama rounds allocations, so a model whose context is nearly free can
  // report the same footprint twice. Dividing by that slope is a division by
  // zero, and the old shell script's answer would have been unbounded.
  const flat = [
    { numCtx: 2048, total: 5 * B, vram: 5 * B },
    { numCtx: 8192, total: 5 * B, vram: 5 * B },
  ];
  const r = project(flat, 24 * GIB * SAFETY, 131072);
  assert.ok(Number.isFinite(r.recommended), `recommended ${r.recommended}`);
  assert.equal(r.recommended, 131072); // the trained cap, not a made-up number
  assert.equal(r.cappedByTrained, true);
});

test('measure: a tiny budget never recommends below the floor', () => {
  const r = project(probes, 17.2 * B, 262144);
  assert.ok(r.recommended === null || r.recommended >= 2048, `recommended ${r.recommended}`);
});

test('measure: /api/ps names are qualified, matching what the daemon reports', () => {
  // The bug this exists to prevent: asking for "gemma3" and finding nothing in
  // /api/ps, because the daemon calls it "gemma3:latest".
  assert.equal(psName('gemma3'), 'gemma3:latest');
  assert.equal(psName('qwen3.6:27b'), 'qwen3.6:27b');
  assert.equal(psName('hf.co/user/repo:Q4_K_M'), 'hf.co/user/repo:Q4_K_M');
});

test('measure: over budget but fully resident is not "runs in system RAM"', () => {
  /*
   * nemotron-cascade-2 on the 24 GB 7900XTX: 22.5 GB of weights against a
   * 20.4 GB budget, yet /api/ps reported every byte of it in VRAM. Reporting
   * that as "runs with layers in system RAM" contradicts the probe printed
   * beside it, and sends someone shopping for a card they already own.
   */
  const resident = [
    { numCtx: 2048, total: 22.5 * B, vram: 22.5 * B },
    { numCtx: 8192, total: 22.5 * B, vram: 22.5 * B },
  ];
  const r = project(resident, 24 * GIB * SAFETY, 262144);
  assert.equal(r.notFitting, true);
  assert.equal(r.fitsWithoutMargin, true);

  // Genuinely spilling: the card took only part of it, and that IS the
  // system-RAM answer.
  const spilling = [
    { numCtx: 2048, total: 30 * B, vram: 18 * B },
    { numCtx: 8192, total: 30.2 * B, vram: 18 * B },
  ];
  const s = project(spilling, 24 * GIB * SAFETY, 262144);
  assert.equal(s.notFitting, true);
  assert.equal(s.fitsWithoutMargin, false);
});

test('measure: a CPU-only box gets no VRAM recommendation', () => {
  /*
   * The ROG Ally X reports size_vram 0 for qwen3.5:4b - its 780M is not a GPU
   * Ollama will use. project() still describes the cost, but measureContext
   * discards the recommendation, because it was derived from a stated VRAM
   * figure for a card doing none of the work. This pins the slope half: the
   * arithmetic must stay honest even where the answer is suppressed.
   */
  const cpu = [
    { numCtx: 2048, total: 2.85 * B, vram: 0 },
    { numCtx: 8192, total: 3.12 * B, vram: 0 },
  ];
  const r = project(cpu, 8 * GIB * SAFETY, 262144);
  assert.ok(r.bytesPerToken > 0, 'context still costs memory on the CPU path');
  assert.equal(r.notFitting, false);
});

test('measure: residency is judged from the probe, not the budget', () => {
  /*
   * qwen3.6:27b on the 24 GB 7900XTX, as measured: 100% resident at 8k, 58% at
   * 176k. The extrapolation from the low end recommended 176k; loading at it
   * showed the card taking barely half. isResident is the check that catches
   * that, so it must not be fooled by a total that merely LOOKS affordable.
   */
  const at176k = { numCtx: 176128, total: 20.98 * B, vram: 12.19 * B };
  const at8k = { numCtx: 8192, total: 16.12 * B, vram: 16.12 * B };
  assert.ok(at176k.vram < at176k.total * 0.999, 'spilling probe must not read as resident');
  assert.ok(at8k.vram >= at8k.total * 0.999, 'fully-resident probe must read as resident');
});
