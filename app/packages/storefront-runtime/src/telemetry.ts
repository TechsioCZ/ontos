import { Option, Schema } from 'effect';

export const Counter = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const PositiveCounter = Counter.check(Schema.isGreaterThan(0));
const Measurement = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
export const SourceRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const BootId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u),
);
export const CgroupMemorySchema = Schema.Struct({
  currentBytes: Schema.OptionFromNullOr(Counter),
  limitBytes: Schema.OptionFromNullOr(Counter),
  limitKind: Schema.Literals(['finite', 'unlimited', 'unavailable']),
  oom: Schema.OptionFromNullOr(Counter),
  oomKill: Schema.OptionFromNullOr(Counter),
  version: Schema.Literals(['v1', 'v2', 'unavailable']),
}).check(
  Schema.makeFilter((group) => {
    if ((group.limitKind === 'finite') !== Option.isSome(group.limitBytes)) {
      return false;
    }
    return (
      group.version !== 'unavailable' ||
      (group.limitKind === 'unavailable' && [group.currentBytes, group.oom, group.oomKill].every(Option.isNone))
    );
  }),
);
export type CgroupMemory = typeof CgroupMemorySchema.Type;
export const unavailableCgroup: CgroupMemory = {
  currentBytes: Option.none(),
  limitBytes: Option.none(),
  limitKind: 'unavailable',
  oom: Option.none(),
  oomKill: Option.none(),
  version: 'unavailable',
};

// Ordering is decoded before measurements: a broken newer event cannot resurrect an older release.
export const RuntimeHeaderSchema = Schema.Struct({
  at: PositiveCounter,
  event: Schema.Literals(['storefront.runtime.boot', 'storefront.runtime.summary']),
});
const identity = {
  at: PositiveCounter,
  bootId: BootId,
  family: Schema.Literals(['akros-storefront', 'n1-storefront']),
  hostname: Schema.NonEmptyString,
  pid: PositiveCounter,
  revision: SourceRevision,
  service: Schema.NonEmptyString,
};
export const RuntimeBootSchema = Schema.Struct({
  ...identity,
  event: Schema.Literal('storefront.runtime.boot'),
  node: Schema.NonEmptyString,
});
export const RuntimeSummarySchema = Schema.Struct({
  ...identity,
  arrayBuffersBytes: Counter,
  cgroup: CgroupMemorySchema,
  cpuMs: Measurement,
  event: Schema.Literal('storefront.runtime.summary'),
  eventLoopMaxMs: Schema.OptionFromNullOr(Measurement),
  externalBytes: Counter,
  // Where a long event-loop delay went (absent in older records): the window's longest and summed garbage-collection
  // pauses, and the time the host did not run this machine's CPUs (stealMs, absent where /proc/stat is unreadable).
  gcMaxMs: Schema.optionalKey(Measurement),
  gcTotalMs: Schema.optionalKey(Measurement),
  heapLimitBytes: PositiveCounter,
  heapTotalBytes: Counter,
  heapUsedBytes: Counter,
  rssBytes: PositiveCounter,
  stealMs: Schema.optionalKey(Schema.OptionFromNullOr(Measurement)),
  windowMs: Measurement.check(Schema.isGreaterThan(0)),
});
export const RuntimeTelemetrySchema = Schema.Union([RuntimeBootSchema, RuntimeSummarySchema]);
export const RuntimeTelemetryJson = Schema.fromJsonString(RuntimeTelemetrySchema);
export type RuntimeTelemetry = typeof RuntimeTelemetrySchema.Type;
export type RuntimeSummary = typeof RuntimeSummarySchema.Type;
export type RuntimeBoot = typeof RuntimeBootSchema.Type;
