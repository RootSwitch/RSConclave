import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, psName } from '../measure.ts';

const GB = 1e9;
// The real shape of qwen3.6:27b Q4_K_M, measured on a 7900XTX: 17.1 GB of
// weights and about 28 MB of context per 1k tokens.
const probes = [
  { numCtx: 2048, total: 17.156 * GB, vram: 17.156 * GB },
  { numCtx: 8192, total: 17.324 * GB, vram: 17.324 * GB },
];

test('measure: slope and intercept separate context cost from weights', () => {
  const r = project(probes, 22 * GB * 0.9, 262144);
  assert.ok(Math.abs(r.bytesPerToken - 27343) < 200, `per-token ${r.bytesPerToken}`);
  assert.ok(Math.abs(r.baseBytes - 17.1 * GB) < 0.05 * GB, `base ${r.baseBytes / GB}`);
  // 4k-aligned and inside the budget, matching what the shell script recommends
  // for the same card - the two must not drift.
  assert.equal(r.recommended, 98304);
  assert.equal(r.recommended % 4096, 0);
  assert.equal(r.cappedByTrained, false);
  assert.equal(r.notFitting, false);
});

test('measure: the trained ceiling wins when VRAM would allow more', () => {
  // The same model on a 32 GB card: VRAM allows ~417k, the model does not.
  const r = project(probes, 32 * GB * 0.9, 262144);
  assert.ok(r.uncappedMax > 262144, `uncapped ${r.uncappedMax}`);
  assert.equal(r.recommended, 262144);
  assert.equal(r.cappedByTrained, true);
});

test('measure: weights alone over budget reports notFitting, not a number', () => {
  // Recommending any window here would be a lie: it is going to run partly in
  // system RAM whatever num_ctx says.
  const r = project(probes, 8 * GB * 0.9, 262144);
  assert.equal(r.notFitting, true);
  assert.equal(r.recommended, null);
});

test('measure: an unreadable trained maximum does not cap', () => {
  const r = project(probes, 32 * GB * 0.9, null);
  assert.equal(r.cappedByTrained, false);
  assert.ok(r.recommended !== null && r.recommended > 262144);
});

test('measure: identical probes clamp instead of recommending infinity', () => {
  // Ollama rounds allocations, so a model whose context is nearly free can
  // report the same footprint twice. Dividing by that slope is a division by
  // zero, and the old shell script's answer would have been unbounded.
  const flat = [
    { numCtx: 2048, total: 5 * GB, vram: 5 * GB },
    { numCtx: 8192, total: 5 * GB, vram: 5 * GB },
  ];
  const r = project(flat, 24 * GB * 0.9, 131072);
  assert.ok(Number.isFinite(r.recommended), `recommended ${r.recommended}`);
  assert.equal(r.recommended, 131072); // the trained cap, not a made-up number
  assert.equal(r.cappedByTrained, true);
});

test('measure: a tiny budget never recommends below the floor', () => {
  const r = project(probes, 17.2 * GB, 262144);
  assert.ok(r.recommended === null || r.recommended >= 2048, `recommended ${r.recommended}`);
});

test('measure: /api/ps names are qualified, matching what the daemon reports', () => {
  // The bug this exists to prevent: asking for "gemma3" and finding nothing in
  // /api/ps, because the daemon calls it "gemma3:latest".
  assert.equal(psName('gemma3'), 'gemma3:latest');
  assert.equal(psName('qwen3.6:27b'), 'qwen3.6:27b');
  assert.equal(psName('hf.co/user/repo:Q4_K_M'), 'hf.co/user/repo:Q4_K_M');
});
