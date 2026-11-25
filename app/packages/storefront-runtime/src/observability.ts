/// <reference types="node" />
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

import { constVoid } from 'effect/Function';
import { Clock, Config, Console, Deferred, Duration, Effect, FileSystem, Option, Schedule, Schema } from 'effect';

import { RuntimeTelemetryJson, unavailableCgroup } from './telemetry.ts';
import type { CgroupMemory, RuntimeTelemetry } from './telemetry.ts';

export type { CgroupMemory } from './telemetry.ts';
const UnsignedText = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const unsigned = (text: Option.Option<string>) =>
  text.pipe(
    Option.filter((value) => /^\d+$/u.test(value.trim())),
    Option.flatMap((value) => Schema.decodeUnknownOption(UnsignedText)(value.trim())),
  );
const unescapeMount = (value: string) =>
  value.replaceAll(/\\(?<octal>040|011|012|134)/gu, (_, octal: string) =>
    String.fromCodePoint(Number.parseInt(octal, 8)),
  );
const relativeGroup = (group: string, root: string) => {
  if (group === '/' || group === root) {
    return Option.some('');
  }
  if (root === '/') {
    return Option.some(group);
  }
  return group.startsWith(`${root}/`) ? Option.some(group.slice(root.length)) : Option.none();
};
const memoryMount = (line: string, version: 'v1' | 'v2', group: string) => {
  const [before = '', after = ''] = line.split(' - ');
  const { 3: encodedRoot = '', 4: encodedMount = '' } = before.split(' ');
  const [kind, , controllers = ''] = after.split(' ');
  const matches =
    version === 'v2' ? kind === 'cgroup2' : kind === 'cgroup' && controllers.split(',').includes('memory');
  const root = unescapeMount(encodedRoot);
  const mount = unescapeMount(encodedMount);
  if (!matches || !mount.startsWith('/')) {
    return Option.none();
  }
  return relativeGroup(group, root).pipe(
    Option.filter((suffix) => !suffix.split('/').includes('..')),
    Option.map((suffix) => ({ path: `${mount}${suffix}`, version })),
  );
};

/** In hybrid mode memory belongs to v1 even when a unified hierarchy also exists. */
export const cgroupMemoryPath = (groups: string, mounts: string) => {
  const entries = groups.split('\n');
  const v1 = entries.find((line) => line.split(':')[1]?.split(',').includes('memory'));
  const v2 = entries.find((line) => {
    const [hierarchy, controllers] = line.split(':');
    return hierarchy === '0' && controllers === '';
  });
  const entry = v1 ?? v2;
  if (entry === undefined) {
    return Option.none();
  }
  const version = v1 === undefined ? 'v2' : 'v1';
  const group = entry.slice(entry.indexOf(':', entry.indexOf(':') + 1) + 1);
  return Option.firstSomeOf(mounts.split('\n').map((line) => memoryMount(line, version, group)));
};

/** Missing files are unavailable; zero remains a real measurement. */
export const readCgroupMemory = Effect.gen(function* readController() {
  const fs = yield* FileSystem.FileSystem;
  const read = (filename: string) => fs.readFileString(filename).pipe(Effect.option);
  const [groups, mounts] = yield* Effect.all([read('/proc/self/cgroup'), read('/proc/self/mountinfo')], {
    concurrency: 2,
  });
  const location = groups.pipe(
    Option.flatMap((text) => mounts.pipe(Option.flatMap((mount) => cgroupMemoryPath(text, mount)))),
  );
  if (Option.isNone(location)) {
    return unavailableCgroup;
  }
  const { path, version } = location.value;
  const names =
    version === 'v2'
      ? ['memory.current', 'memory.max', 'memory.events']
      : ['memory.usage_in_bytes', 'memory.limit_in_bytes', 'memory.oom_control'];
  const [current = Option.none(), limit = Option.none(), events = Option.none()] = yield* Effect.forEach(
    names,
    (name) => read(`${path}/${name}`),
    { concurrency: 3 },
  );
  const values = new Map(
    events
      .pipe(Option.getOrElse(() => ''))
      .trim()
      .split('\n')
      .map((line) => {
        const [key = '', value] = line.trim().split(/\s+/u);
        return [key, unsigned(Option.fromUndefinedOr(value))] as const;
      }),
  );
  const numericLimit = unsigned(limit);
  const unlimited = Option.exists(
    limit,
    (text) =>
      text.trim() === 'max' ||
      // Linux's 64-bit, 4 KiB PAGE_COUNTER_MAX sentinel. Other unrepresentable limits remain unavailable.
      (version === 'v1' && text.trim() === '9223372036854771712'),
  );
  const measured = {
    currentBytes: unsigned(current),
    oom: values.get('oom') ?? Option.none(),
    oomKill: values.get('oom_kill') ?? Option.none(),
    version,
  };
  if (unlimited) {
    return { ...measured, limitBytes: Option.none(), limitKind: 'unlimited' } satisfies CgroupMemory;
  }
  if (Option.isSome(numericLimit)) {
    return { ...measured, limitBytes: numericLimit, limitKind: 'finite' } satisfies CgroupMemory;
  }
  return { ...measured, limitBytes: Option.none(), limitKind: 'unavailable' } satisfies CgroupMemory;
});

const observerHook = 'ontos:storefront-observer';
const emit = (event: RuntimeTelemetry) =>
  Schema.encodeEffect(RuntimeTelemetryJson)(event).pipe(Effect.flatMap(Console.log));

// Node's timeout signal does not pin the event loop. This Clock bridge removes its
// abort listener on interruption; all sampling policy still uses Effect's Clock.
const backgroundSleep: Clock.Clock['sleep'] = (duration) => {
  const millis = Duration.toMillis(duration);
  if (millis <= 0) {
    return Effect.yieldNow;
  }
  if (!Number.isFinite(millis)) {
    return Effect.never;
  }
  return Effect.callback((resume) => {
    const elapsed = AbortSignal.timeout(Math.ceil(millis));
    const wake = () => resume(Effect.void);
    elapsed.addEventListener('abort', wake, { once: true });
    return Effect.sync(() => {
      elapsed.removeEventListener('abort', wake);
    });
  });
};

/** Run at the native Node instrumentation edge. The fiber owns its sampler and native hook. */
export const startStorefrontObservability = Effect.fn('Storefront.observeProcess')(
  function* startStorefrontObservability(family: 'akros-storefront' | 'n1-storefront', revision: string) {
    const installed = yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (process.listenerCount(observerHook) > 0) {
          return Option.none();
        }
        const hook = constVoid;
        process.on(observerHook, hook);
        return Option.some(hook);
      }),
      (hook) =>
        Effect.sync(() => {
          if (Option.isSome(hook)) {
            process.removeListener(observerHook, hook.value);
          }
        }),
    );
    if (Option.isNone(installed)) {
      return;
    }
    const service = yield* Config.String('ONTOS_STOREFRONT_APP_ID').pipe(Config.withDefault(family));
    const identity = { bootId: randomUUID(), family, hostname: hostname(), pid: process.pid, revision, service };
    const histogram = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const delay = monitorEventLoopDelay({ resolution: 20 });
        delay.enable();
        return delay;
      }),
      (delay) =>
        Effect.sync(() => {
          delay.disable();
        }),
    );
    yield* emit({
      ...identity,
      at: yield* Clock.currentTimeMillis,
      event: 'storefront.runtime.boot',
      node: process.versions.node,
    });
    let previousCpu = process.cpuUsage();
    let previousAt = yield* Clock.monotonicTimeNanos;
    const sample = Effect.gen(function* sampleProcess() {
      const cgroup = yield* readCgroupMemory;
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      const now = yield* Clock.monotonicTimeNanos;
      yield* emit({
        ...identity,
        arrayBuffersBytes: memory.arrayBuffers,
        at: yield* Clock.currentTimeMillis,
        cgroup,
        cpuMs: Duration.toMillis(
          Duration.micros(BigInt(cpu.user + cpu.system - previousCpu.user - previousCpu.system)),
        ),
        event: 'storefront.runtime.summary',
        eventLoopMaxMs:
          histogram.count === 0 ? Option.none() : Option.some(Duration.toMillis(Duration.nanos(BigInt(histogram.max)))),
        externalBytes: memory.external,
        heapLimitBytes: getHeapStatistics().heap_size_limit,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        rssBytes: memory.rss,
        windowMs: Duration.toMillis(Duration.nanos(now - previousAt)),
      });
      previousAt = now;
      previousCpu = cpu;
      histogram.reset();
    });
    const idle = yield* Deferred.make<boolean>();
    const stop = () => {
      Deferred.doneUnsafe(idle, Effect.succeed(true));
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.once('beforeExit', stop);
        return stop;
      }),
      (listener) =>
        Effect.sync(() => {
          process.removeListener('beforeExit', listener);
        }),
    );
    yield* sample.pipe(
      Effect.repeat(Schedule.spaced(Duration.seconds(10))),
      Effect.updateService(Clock.Clock, (clock) => ({
        currentTimeMillis: clock.currentTimeMillis,
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
        currentTimeNanos: clock.currentTimeNanos,
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        sleep: backgroundSleep,
      })),
      Effect.raceFirst(Deferred.await(idle)),
    );
  },
  Effect.scoped,
);
