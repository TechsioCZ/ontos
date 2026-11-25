import { Effect, Fiber, FileSystem, Option, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { cgroupMemoryPath, readCgroupMemory, startStorefrontObservability } from '../src/observability.ts';
import { CgroupMemorySchema, RuntimeTelemetryJson, unavailableCgroup } from '../src/telemetry.ts';

const mount = '27 22 0:23 / /sys/fs/cgroup rw - cgroup2 cgroup rw';
const readFixture = (files: ReadonlyMap<string, string>) => {
  const unavailable = FileSystem.makeNoop({});
  return readCgroupMemory.pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        readFileString: (filename) => {
          const text = files.get(filename);
          return text === undefined ? unavailable.readFileString(filename) : Effect.succeed(text);
        },
      }),
    ),
  );
};

it('resolves namespaced, nested v2 and v1 memory controllers, including hybrid hosts', () => {
  expect(Option.getOrNull(cgroupMemoryPath('0::/', mount))).toEqual({ path: '/sys/fs/cgroup', version: 'v2' });
  expect(Option.getOrNull(cgroupMemoryPath('0::/tenant/container', mount))).toEqual({
    path: '/sys/fs/cgroup/tenant/container',
    version: 'v2',
  });
  expect(Option.getOrNull(cgroupMemoryPath('0::/tenant/container', mount.replace(' / /sys', ' /tenant /sys')))).toEqual(
    { path: '/sys/fs/cgroup/container', version: 'v2' },
  );
  const legacy = '1 2 0:3 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory';
  expect(Option.getOrNull(cgroupMemoryPath('3:cpu:/x\n4:memory:/x', legacy))).toEqual({
    path: '/sys/fs/cgroup/memory/x',
    version: 'v1',
  });
  expect(Option.getOrNull(cgroupMemoryPath('0::/unified\n4:memory:/x', `${mount}\n${legacy}`))).toEqual({
    path: '/sys/fs/cgroup/memory/x',
    version: 'v1',
  });
  expect(Option.getOrNull(cgroupMemoryPath('0::/services/api:blue', mount))).toEqual({
    path: '/sys/fs/cgroup/services/api:blue',
    version: 'v2',
  });
  expect(Option.isNone(cgroupMemoryPath('0::/../escape', mount))).toBe(true);
  expect(Option.getOrNull(cgroupMemoryPath('0::/name \n', mount))).toEqual({
    path: '/sys/fs/cgroup/name ',
    version: 'v2',
  });
  expect(
    Option.getOrNull(cgroupMemoryPath('0::/x\n', mount.replace('/sys/fs/cgroup', String.raw`/sys/a\134b`))),
  ).toEqual({
    path: String.raw`/sys/a\b/x`,
    version: 'v2',
  });
});

it.effect('reads actual finite limits and OOM counters, not provider aggregates', () =>
  Effect.gen(function* finiteLimits() {
    const value = yield* readFixture(
      new Map([
        ['/proc/self/cgroup', '0::/'],
        ['/proc/self/mountinfo', mount],
        ['/sys/fs/cgroup/memory.current', '123456'],
        ['/sys/fs/cgroup/memory.events', 'oom 3\noom_kill 2\nhigh 0'],
        ['/sys/fs/cgroup/memory.max', '536870912'],
      ]),
    );
    expect(yield* Schema.encodeEffect(CgroupMemorySchema)(value)).toEqual({
      currentBytes: 123_456,
      limitBytes: 536_870_912,
      limitKind: 'finite',
      oom: 3,
      oomKill: 2,
      version: 'v2',
    });
  }),
);

it.effect('distinguishes missing files and unlimited limits from zero, and round trips null', () =>
  Effect.gen(function* missingMeasurements() {
    const value = yield* readFixture(
      new Map([
        ['/proc/self/cgroup', '0::/'],
        ['/proc/self/mountinfo', mount],
        ['/sys/fs/cgroup/memory.current', '0'],
        ['/sys/fs/cgroup/memory.max', 'max'],
      ]),
    );
    expect(Option.getOrNull(value.currentBytes)).toBe(0);
    expect(Option.isNone(value.limitBytes)).toBe(true);
    expect(value.limitKind).toBe('unlimited');
    expect(Option.isNone(value.oomKill)).toBe(true);
    expect(yield* readFixture(new Map())).toEqual(unavailableCgroup);
    const encoded = yield* Schema.encodeEffect(CgroupMemorySchema)(unavailableCgroup);
    expect(encoded.currentBytes).toBe(null);
    expect(yield* Schema.decodeUnknownEffect(CgroupMemorySchema)(encoded)).toEqual(unavailableCgroup);
  }),
);

it.effect('hybrid v1 sentinel is unlimited while unreadable usage and counters remain unavailable', () =>
  Effect.gen(function* hybridSentinel() {
    const value = yield* readFixture(
      new Map([
        ['/proc/self/cgroup', '0::/unified\n4:memory:/x'],
        ['/proc/self/mountinfo', `${mount}\n1 2 0:3 / /sys/memory rw - cgroup cgroup rw,memory`],
        ['/sys/memory/x/memory.limit_in_bytes', '9223372036854771712'],
        ['/sys/memory/x/memory.usage_in_bytes', '-1'],
      ]),
    );
    expect(value.version).toBe('v1');
    expect(value.limitKind).toBe('unlimited');
    expect(Option.isNone(value.currentBytes)).toBe(true);
    expect(Option.isNone(value.oomKill)).toBe(true);
  }),
);

it.effect('does not invent unlimited memory from a large finite v1 value', () =>
  Effect.gen(function* finiteBeyondWirePrecision() {
    const value = yield* readFixture(
      new Map([
        ['/proc/self/cgroup', '4:memory:/x\n'],
        ['/proc/self/mountinfo', '1 2 0:3 / /sys/memory rw - cgroup cgroup rw,memory'],
        ['/sys/memory/x/memory.limit_in_bytes', '1152921504606846976'],
      ]),
    );
    expect(value.limitKind).toBe('unavailable');
    expect(Option.isNone(value.limitBytes)).toBe(true);
  }),
);

it.live('owns one native process hook and releases it when its observer fiber is interrupted', () =>
  Effect.gen(function* singletonObserver() {
    const messages: string[] = [];
    const termListeners = process.listeners('SIGTERM');
    const intListeners = process.listeners('SIGINT');
    const idleListeners = process.listeners('beforeExit');
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        rs.spyOn(console, 'log').mockImplementation((...args: readonly unknown[]) => {
          messages.push(args.join(' '));
        }),
      ),
      (spy) =>
        Effect.sync(() => {
          spy.mockRestore();
        }),
    );
    const fs = FileSystem.makeNoop({});
    const observer = startStorefrontObservability('akros-storefront', 'a'.repeat(40)).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    const first = yield* observer.pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    expect(process.listeners('SIGTERM')).toEqual(termListeners);
    expect(process.listeners('SIGINT')).toEqual(intListeners);
    yield* startStorefrontObservability('n1-storefront', 'b'.repeat(40)).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    yield* Fiber.interrupt(first);
    expect(process.listeners('SIGTERM')).toEqual(termListeners);
    expect(process.listeners('SIGINT')).toEqual(intListeners);
    expect(process.listeners('beforeExit')).toEqual(idleListeners);
    expect(process.listenerCount('ontos:storefront-observer')).toBe(0);
    const events = yield* Effect.forEach(messages, (line) => Schema.decodeUnknownEffect(RuntimeTelemetryJson)(line), {
      concurrency: 1,
    });
    expect(events.filter((event) => event.event === 'storefront.runtime.boot')).toHaveLength(1);
    expect(events.every((event) => event.family === 'akros-storefront')).toBe(true);
    const restarted = yield* observer.pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(restarted);
    const allEvents = yield* Effect.forEach(
      messages,
      (line) => Schema.decodeUnknownEffect(RuntimeTelemetryJson)(line),
      { concurrency: 1 },
    );
    expect(allEvents.filter((event) => event.event === 'storefront.runtime.boot')).toHaveLength(2);
  }).pipe(Effect.scoped),
);
