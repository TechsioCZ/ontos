import { Effect, Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { runtimeObservabilityCapabilities, startProcessObservability } from '../zerops/process-observability.mts';
import { createRuntimeSummary, isRuntimeStall, isSlowRuntimeJob } from '../zerops/runtime-observability-model.mts';

const job = (durationMs: number, thresholdMs = 200) => ({
  durationMs,
  finishedAt: 1000 + durationMs,
  job: 'gateway-assertion-cleanup',
  owner: 'fixture-owner',
  startedAt: 1000,
  thresholdMs,
});

it('does not report Bun performance stubs or missing GC events as real measurements', () => {
  expect(runtimeObservabilityCapabilities('bun', ['mark', 'measure'])).toEqual({
    eventLoopUtilization: false,
    gc: false,
    heapLimit: false,
  });
  expect(runtimeObservabilityCapabilities('node', ['gc', 'mark', 'measure'])).toEqual({
    eventLoopUtilization: true,
    gc: true,
    heapLimit: true,
  });
  expect(runtimeObservabilityCapabilities('node', ['mark'])).toEqual({
    eventLoopUtilization: true,
    gc: false,
    heapLimit: true,
  });
});

it('uses strict stall and job thresholds and ignores invalid measurements', () => {
  expect(isRuntimeStall('event-loop', 500)).toBe(false);
  expect(isRuntimeStall('event-loop', 500.01)).toBe(true);
  expect(isRuntimeStall('gc', 200)).toBe(false);
  expect(isRuntimeStall('gc', 200.01)).toBe(true);
  expect(isRuntimeStall('gc', Number.NaN)).toBe(false);
  expect(isSlowRuntimeJob(job(200))).toBe(false);
  expect(isSlowRuntimeJob(job(201))).toBe(true);
  expect(isSlowRuntimeJob(job(50, 50))).toBe(false);
  expect(isSlowRuntimeJob(job(50.01, 50))).toBe(true);
});

it('summarizes GC and cleanup ticks in constant space and resets each window', () => {
  const summary = createRuntimeSummary();
  summary.gc(10.125);
  summary.gc(201.25);
  summary.gc(-1);
  summary.gc(Number.NaN);
  summary.job(job(50, 50));
  summary.job(job(51, 50));
  expect(summary.take()).toEqual({
    cleanupTicks: 2,
    gcCount: 2,
    gcMaxMs: 201.25,
    gcTotalMs: 211.38,
    jobRuns: 2,
    slowJobs: 1,
  });
  expect(summary.take()).toEqual({ cleanupTicks: 0, gcCount: 0, gcMaxMs: 0, gcTotalMs: 0, jobRuns: 0, slowJobs: 0 });
});

it.effect('registers one process hook and releases it with the host scope', () =>
  Effect.gen(function* monitorLifecycle() {
    const scope = yield* Scope.make();
    yield* startProcessObservability('owners').pipe(Scope.provide(scope));
    expect(globalThis.ontosRuntimeJobObserver).toBeDefined();
    yield* Scope.close(scope, yield* Effect.exit(Effect.void));
    expect(globalThis.ontosRuntimeJobObserver).toBeUndefined();
  }),
);
