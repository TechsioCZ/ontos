import type { RuntimeJobSample } from '../../packages/core-runtime/src/observability/runtime-jobs.ts';

export const EVENT_LOOP_STALL_MS = 500;
export const GC_STALL_MS = 200;
export const isRuntimeStall = (kind: 'event-loop' | 'gc', durationMs: number) =>
  Number.isFinite(durationMs) && durationMs > (kind === 'gc' ? GC_STALL_MS : EVENT_LOOP_STALL_MS);
export const isSlowRuntimeJob = (sample: RuntimeJobSample) =>
  Number.isFinite(sample.durationMs) && sample.durationMs > sample.thresholdMs;
export const roundMillis = (value: number) => Math.round(value * 100) / 100;

/** Constant space. Job keys and owners are not retained between runs. */
export const createRuntimeSummary = () => {
  let gcCount = 0;
  let gcTotalMs = 0;
  let gcMaxMs = 0;
  let cleanupTicks = 0;
  let jobRuns = 0;
  let slowJobs = 0;
  return {
    gc: (durationMs: number) => {
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        return;
      }
      gcCount += 1;
      gcTotalMs += durationMs;
      gcMaxMs = Math.max(gcMaxMs, durationMs);
    },
    job: (sample: RuntimeJobSample) => {
      jobRuns += 1;
      if (sample.job === 'gateway-assertion-cleanup') {
        cleanupTicks += 1;
      }
      if (isSlowRuntimeJob(sample)) {
        slowJobs += 1;
      }
    },
    take: () => {
      const snapshot = {
        cleanupTicks,
        gcCount,
        gcMaxMs: roundMillis(gcMaxMs),
        gcTotalMs: roundMillis(gcTotalMs),
        jobRuns,
        slowJobs,
      };
      gcCount = 0;
      gcTotalMs = 0;
      gcMaxMs = 0;
      cleanupTicks = 0;
      jobRuns = 0;
      slowJobs = 0;
      return snapshot;
    },
  };
};
