import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { RuntimeSummarySchema } from '../../packages/storefront-runtime/src/telemetry.ts';
import { runtimeEvidence } from './prove-storefront-runtime.mts';

const revision = 'a'.repeat(40);
const bootEvent = 'storefront.runtime.boot';
const summaryEvent = 'storefront.runtime.summary';
const privateValue = 'must not escape';
const akrosFamily = 'akros-storefront';
const n1Family = 'n1-storefront';
const sample = {
  arrayBuffersBytes: 5,
  at: 20_000,
  bootId: '00000000-0000-4000-8000-000000000001',
  cgroup: { currentBytes: 200, limitBytes: 500, limitKind: 'finite', oom: 0, oomKill: 0, version: 'v2' },
  cpuMs: 1,
  event: summaryEvent,
  eventLoopMaxMs: null,
  externalBytes: 10,
  family: akrosFamily,
  heapLimitBytes: 500,
  heapTotalBytes: 120,
  heapUsedBytes: 100,
  hostname: 'fixture',
  pid: 1,
  query: privateValue,
  revision,
  rssBytes: 123,
  secret: privateValue,
  service: 'fixture',
  windowMs: 10_000,
};
const records = (...samples: readonly unknown[]) => samples.map((entry) => ({ message: JSON.stringify(entry) }));
const prove = (...samples: readonly unknown[]) =>
  runtimeEvidence(records(...samples), revision, { family: akrosFamily, now: 30_000 });

it.effect('requires measured telemetry for the current release and emits only contract fields', () =>
  Effect.gen(function* safeOutput() {
    const evidence = yield* Effect.fromOption(yield* prove(sample));
    const encoded = yield* Schema.encodeEffect(RuntimeSummarySchema)(evidence);
    expect(evidence.revision).toBe(revision);
    expect(encoded.eventLoopMaxMs).toBe(null);
    expect(encoded.windowMs).toBe(sample.windowMs);
    expect(encoded.heapLimitBytes).toBe(sample.heapLimitBytes);
    expect(JSON.stringify(encoded)).not.toContain(privateValue);
    expect(Option.isNone(yield* prove({ ...sample, revision: 'b'.repeat(40) }))).toBe(true);
  }),
);

it.effect('rejects stale, replaced and dead-boot evidence before filtering by requested SHA', () =>
  Effect.gen(function* newestFirst() {
    expect(
      Option.isNone(yield* runtimeEvidence(records(sample), revision, { family: akrosFamily, now: 100_000 })),
    ).toBe(true);
    expect(Option.isNone(yield* prove(sample, { ...sample, at: 21_000, revision: 'b'.repeat(40) }))).toBe(true);
    const boot = {
      ...sample,
      at: 21_000,
      bootId: '00000000-0000-4000-8000-000000000002',
      event: bootEvent,
      node: '24',
    };
    expect(Option.isNone(yield* prove(sample, boot))).toBe(true);
    expect(Option.isNone(yield* prove(sample, { ...boot, pid: -1 }))).toBe(true);
    expect(Option.isNone(yield* prove(sample, { ...sample, at: 21_000, rssBytes: null }))).toBe(true);
  }),
);

it.effect('rejects conflicting newest ties independently of platform log order', () =>
  Effect.gen(function* tiedOrdering() {
    for (const conflict of [
      { ...sample, rssBytes: null },
      { ...sample, rssBytes: sample.rssBytes + 1 },
      { ...sample, revision: 'b'.repeat(40) },
    ]) {
      expect(Option.isNone(yield* prove(sample, conflict))).toBe(true);
      expect(Option.isNone(yield* prove(conflict, sample))).toBe(true);
    }
    const boot = { ...sample, at: 19_000, event: bootEvent, node: '24' };
    const conflict = { ...boot, pid: 2 };
    expect(Option.isNone(yield* prove(boot, conflict, sample))).toBe(true);
    expect(Option.isNone(yield* prove(conflict, boot, sample))).toBe(true);
    expect(Option.isSome(yield* prove(boot, boot, sample, sample))).toBe(true);
  }),
);

it.effect('binds measured telemetry to the expected deployment family', () =>
  Effect.gen(function* targetFamily() {
    expect(Option.isNone(yield* prove({ ...sample, family: n1Family }))).toBe(true);
    expect(
      Option.isSome(
        yield* runtimeEvidence(records({ ...sample, family: n1Family }), revision, {
          family: n1Family,
          now: 30_000,
        }),
      ),
    ).toBe(true);
  }),
);

it.effect('correlates boot process, host and service identity and chronology', () =>
  Effect.gen(function* bootCorrelation() {
    const boot = { ...sample, at: 19_000, event: bootEvent, node: '24' };
    expect(Option.isSome(yield* prove(boot, sample))).toBe(true);
    for (const patch of [
      { pid: 2 },
      { hostname: 'other-host' },
      { service: 'other-service' },
      { at: 21_000 },
      { node: null },
    ]) {
      expect(Option.isNone(yield* prove({ ...boot, ...patch }, sample))).toBe(true);
    }
  }),
);

it.effect('rejects malformed counters, missing values and inconsistent controller declarations', () =>
  Effect.gen(function* strictScalars() {
    for (const patch of [
      { pid: -1 },
      { heapUsedBytes: null },
      { externalBytes: { secret: privateValue } },
      { cgroup: null },
      { cgroup: { ...sample.cgroup, currentBytes: privateValue } },
      { cgroup: { ...sample.cgroup, limitBytes: null } },
      { at: 100_000 },
      { cpuMs: null },
      { rssBytes: Number.MAX_SAFE_INTEGER + 1 },
      { windowMs: 0 },
      { cpuMs: -1 },
      { cgroup: { ...sample.cgroup, version: 'unavailable' } },
    ]) {
      expect(Option.isNone(yield* prove({ ...sample, ...patch }))).toBe(true);
    }
    const { cpuMs, ...missingCpu } = sample;
    expect(cpuMs).toBe(1);
    expect(Option.isNone(yield* prove(missingCpu))).toBe(true);
  }),
);

it.effect('fails closed when a recognized telemetry event cannot be ordered', () =>
  Effect.gen(function* malformedOrdering() {
    for (const event of [bootEvent, summaryEvent]) {
      for (const at of ['21000', null, -1]) {
        expect(Option.isNone(yield* prove(sample, { at, event }))).toBe(true);
      }
      expect(Option.isNone(yield* prove(sample, { event }))).toBe(true);
    }
    expect(Option.isSome(yield* prove(sample, { at: 'not telemetry', event: 'other.log' }))).toBe(true);
    expect(Option.isNone(yield* prove({ ...sample, bootId: 'deadbeef-dead-0000-0000-deadbeefdead' }))).toBe(true);
  }),
);
