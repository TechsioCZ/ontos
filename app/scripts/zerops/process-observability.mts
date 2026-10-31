/// <reference types="node" />
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import type { PerformanceEntry } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

import { Console, Effect, Ref, Result, Schema } from 'effect';

import type { RuntimeJobSample } from '../../packages/core-runtime/src/observability/runtime-jobs.ts';
import { isRuntimeStall, isSlowRuntimeJob, createRuntimeSummary, roundMillis } from './runtime-observability-model.mts';
import { ownerWarmState, OwnerWarmStateSchema } from './owner-warm-state.mts';
import type { SpiceDbClientSample } from '../../packages/core-runtime/src/permissions/spicedb-client-observability.ts';

const ProcessRoleSchema = Schema.Literals(['shell', 'owners', 'outbox', 'supervisor']);
export type ProcessRole = typeof ProcessRoleSchema.Type;
const RuntimeLog = Schema.fromJsonString(
  Schema.Struct({
    at: Schema.Number,
    event: Schema.String,
    fields: Schema.Record(
      Schema.String,
      Schema.Union([Schema.Number, Schema.String, Schema.Undefined, OwnerWarmStateSchema]),
    ),
    pid: Schema.Number,
    role: ProcessRoleSchema,
  }),
);
const encodeLog = Schema.encodeResult(RuntimeLog);

/** Bun 1.4.4 exposes ELU and V8 heap-limit stubs, and does not publish GC performance entries. */
export const runtimeObservabilityCapabilities = (runtime: 'node' | 'bun', entryTypes: readonly string[]) => ({
  eventLoopUtilization: runtime === 'node',
  gc: entryTypes.includes('gc'),
  heapLimit: runtime === 'node',
});
const createRequestObserver = () => (directory: string, pathname: string) => {
  const owner = /\/(?:verticals|apps)\/(?<owner>[^/]+)\/dist$/u.exec(directory)?.groups?.owner;
  const finish =
    owner === undefined
      ? undefined
      : ownerWarmState.request(owner, pathname, performance.timeOrigin + performance.now());
  const start = performance.now();
  return finish === undefined ? undefined : () => finish(performance.now() - start);
};

/** Driver callbacks only. No request data, stacks, secrets or per-sample allocations on the normal loop path. */
export const startProcessObservability = (role: ProcessRole) =>
  Effect.acquireRelease(
    Effect.gen(function* acquireProcessMonitor() {
      const write = yield* Effect.service(Console.Console).pipe(
        Effect.map((console) => (line: string) => console.log(line)),
      );
      return yield* Effect.sync(() => {
        const summary = createRuntimeSummary();
        const runtime = process.versions.bun === undefined ? 'node' : 'bun';
        const capabilities = runtimeObservabilityCapabilities(runtime, PerformanceObserver.supportedEntryTypes);
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
        emit('runtime.capabilities', performance.timeOrigin + performance.now(), {
          eventLoopUtilization: capabilities.eventLoopUtilization ? 'available' : 'unavailable',
          gc: capabilities.gc ? 'available' : 'unavailable',
          heapLimit: capabilities.heapLimit ? 'available' : 'unavailable',
          runtime,
          version: process.versions.bun ?? process.versions.node,
        });
        const histogram = monitorEventLoopDelay({ resolution: 20 });
        const alerts = monitorEventLoopDelay({ resolution: 20 });
        histogram.enable();
        alerts.enable();
        let cpu = process.cpuUsage();
        let windowStartedAt = performance.now();
        let utilization = capabilities.eventLoopUtilization ? performance.eventLoopUtilization() : undefined;
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
        if (capabilities.gc) {
          observer.observe({ entryTypes: ['gc'] });
        }
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
          const nextUtilization = capabilities.eventLoopUtilization ? performance.eventLoopUtilization() : undefined;
          const windowSummary = summary.take();
          emit('runtime.summary', performance.timeOrigin + now, {
            ...windowSummary,
            cpuMs: roundMillis((nextCpu.user + nextCpu.system - cpu.user - cpu.system) / 1000),
            eventLoopMaxMs: histogram.count > 0 ? roundMillis(histogram.max / 1_000_000) : 0,
            eventLoopP50Ms: histogram.count > 0 ? roundMillis(histogram.percentile(50) / 1_000_000) : 0,
            eventLoopP99Ms: histogram.count > 0 ? roundMillis(histogram.percentile(99) / 1_000_000) : 0,
            eventLoopUtilization:
              nextUtilization === undefined || utilization === undefined
                ? undefined
                : performance.eventLoopUtilization(nextUtilization, utilization).utilization,
            gcCount: capabilities.gc ? windowSummary.gcCount : undefined,
            gcMaxMs: capabilities.gc ? windowSummary.gcMaxMs : undefined,
            gcTotalMs: capabilities.gc ? windowSummary.gcTotalMs : undefined,
            heapLimitBytes: capabilities.heapLimit ? getHeapStatistics().heap_size_limit : undefined,
            heapUsedBytes: process.memoryUsage().heapUsed,
            ownerWarmState: ownerWarmState.snapshot(),
            rssBytes: process.memoryUsage().rss,
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
        const onBundle: NonNullable<typeof globalThis.ontosRenderBundleObserver> = (sample) => {
          const owner = /\/(?:verticals|apps)\/(?<owner>[^/]+)\/dist\//u.exec(sample.filepath)?.groups?.owner;
          if (owner === undefined) {
            return;
          }
          ownerWarmState.bundle(owner, sample);
          emit('owner.ssr-bundle-load', performance.timeOrigin + performance.now(), {
            durationMs: roundMillis(sample.durationMs),
            outcome: sample.outcome,
            owner,
            triggerPath: sample.triggerPath.split('?')[0],
          });
        };
        globalThis.ontosRenderBundleObserver = onBundle;
        const onRequest = createRequestObserver();
        globalThis.ontosOwnerRequestObserver = onRequest;
        const onSpiceDb = (sample: SpiceDbClientSample) => {
          emit(sample.event, performance.timeOrigin + performance.now(), {
            durationMs: roundMillis(sample.durationMs),
            method: sample.method,
            outcome: sample.outcome,
          });
        };
        globalThis.ontosSpiceDbClientObserver = onSpiceDb;
        globalThis.ontosSpiceDbFirstRpcStarted = Ref.makeUnsafe(false);
        return () => {
          clearInterval(alertTimer);
          clearInterval(summaryTimer);
          observer.disconnect();
          histogram.disable();
          alerts.disable();
          if (globalThis.ontosRuntimeJobObserver === onJob) {
            Reflect.deleteProperty(globalThis, 'ontosRuntimeJobObserver');
          }
          if (globalThis.ontosRenderBundleObserver === onBundle) {
            Reflect.deleteProperty(globalThis, 'ontosRenderBundleObserver');
          }
          if (globalThis.ontosOwnerRequestObserver === onRequest) {
            Reflect.deleteProperty(globalThis, 'ontosOwnerRequestObserver');
          }
          if (globalThis.ontosSpiceDbClientObserver === onSpiceDb) {
            Reflect.deleteProperty(globalThis, 'ontosSpiceDbClientObserver');
            Reflect.deleteProperty(globalThis, 'ontosSpiceDbFirstRpcStarted');
          }
        };
      });
    }),
    (release) => Effect.sync(release),
  ).pipe(Effect.asVoid);
