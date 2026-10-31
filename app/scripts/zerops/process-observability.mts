/// <reference types="node" />
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import type { PerformanceEntry } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

import { Console, Effect, Result, Schema } from 'effect';

import type { RuntimeJobSample } from '../../packages/core-runtime/src/observability/runtime-jobs.ts';
import { isRuntimeStall, isSlowRuntimeJob, createRuntimeSummary, roundMillis } from './runtime-observability-model.mts';

const ProcessRoleSchema = Schema.Literals(['shell', 'owners', 'outbox', 'supervisor']);
export type ProcessRole = typeof ProcessRoleSchema.Type;
const RuntimeLog = Schema.fromJsonString(
  Schema.Struct({
    at: Schema.Number,
    event: Schema.String,
    fields: Schema.Record(Schema.String, Schema.Union([Schema.Number, Schema.String, Schema.Undefined])),
    pid: Schema.Number,
    role: ProcessRoleSchema,
  }),
);
const encodeLog = Schema.encodeResult(RuntimeLog);

/** Driver callbacks only. No request data, stacks, secrets or per-sample allocations on the normal loop path. */
export const startProcessObservability = (role: ProcessRole) =>
  Effect.acquireRelease(
    Effect.gen(function* acquireProcessMonitor() {
      const write = yield* Effect.service(Console.Console).pipe(
        Effect.map((console) => (line: string) => console.log(line)),
      );
      return yield* Effect.sync(() => {
        const summary = createRuntimeSummary();
        const emit = (
          event: (typeof RuntimeLog.Type)['event'],
          at: number,
          fields: (typeof RuntimeLog.Type)['fields'],
        ) => {
          const encoded = encodeLog({ at, event, fields, pid: process.pid, role });
          if (Result.isSuccess(encoded)) {
            write(encoded.success);
          }
        };
        const histogram = monitorEventLoopDelay({ resolution: 20 });
        const alerts = monitorEventLoopDelay({ resolution: 20 });
        histogram.enable();
        alerts.enable();
        let cpu = process.cpuUsage();
        let windowStartedAt = performance.now();
        let utilization = performance.eventLoopUtilization();
        const onJob = (sample: RuntimeJobSample) => {
          summary.job(sample);
          if (isSlowRuntimeJob(sample)) {
            emit('runtime.slow-job', sample.finishedAt, { ...sample });
          }
        };
        const onGc = (entry: PerformanceEntry) => {
          summary.gc(entry.duration);
          if (isRuntimeStall('gc', entry.duration)) {
            emit('runtime.stall', performance.timeOrigin + entry.startTime + entry.duration, {
              durationMs: roundMillis(entry.duration),
              kind: 'gc',
              startedAt: performance.timeOrigin + entry.startTime,
            });
          }
        };
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            onGc(entry);
          }
        });
        observer.observe({ entryTypes: ['gc'] });
        const alertTimer = setInterval(() => {
          const durationMs = alerts.count > 0 ? alerts.max / 1_000_000 : 0;
          alerts.reset();
          if (isRuntimeStall('event-loop', durationMs)) {
            const windowCpu = process.cpuUsage(cpu);
            emit('runtime.stall', performance.timeOrigin + performance.now(), {
              durationMs: roundMillis(durationMs),
              heapUsedBytes: process.memoryUsage().heapUsed,
              kind: 'event-loop',
              windowCpuMs: roundMillis((windowCpu.user + windowCpu.system) / 1000),
            });
          }
        }, 250);
        const summaryTimer = setInterval(() => {
          for (const entry of observer.takeRecords()) {
            onGc(entry);
          }
          const now = performance.now();
          const nextCpu = process.cpuUsage();
          const nextUtilization = performance.eventLoopUtilization();
          emit('runtime.summary', performance.timeOrigin + now, {
            ...summary.take(),
            cpuMs: roundMillis((nextCpu.user + nextCpu.system - cpu.user - cpu.system) / 1000),
            eventLoopMaxMs: histogram.count > 0 ? roundMillis(histogram.max / 1_000_000) : 0,
            eventLoopP50Ms: histogram.count > 0 ? roundMillis(histogram.percentile(50) / 1_000_000) : 0,
            eventLoopP99Ms: histogram.count > 0 ? roundMillis(histogram.percentile(99) / 1_000_000) : 0,
            eventLoopUtilization: performance.eventLoopUtilization(nextUtilization, utilization).utilization,
            heapLimitBytes: getHeapStatistics().heap_size_limit,
            heapUsedBytes: process.memoryUsage().heapUsed,
            windowMs: roundMillis(now - windowStartedAt),
          });
          histogram.reset();
          cpu = nextCpu;
          utilization = nextUtilization;
          windowStartedAt = now;
        }, 10_000);
        alertTimer.unref();
        summaryTimer.unref();
        globalThis.ontosRuntimeJobObserver = onJob;
        return () => {
          clearInterval(alertTimer);
          clearInterval(summaryTimer);
          observer.disconnect();
          histogram.disable();
          alerts.disable();
          if (globalThis.ontosRuntimeJobObserver === onJob) {
            Reflect.deleteProperty(globalThis, 'ontosRuntimeJobObserver');
          }
        };
      });
    }),
    (release) => Effect.sync(release),
  ).pipe(Effect.asVoid);
