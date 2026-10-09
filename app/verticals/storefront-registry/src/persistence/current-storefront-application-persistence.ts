/* oxlint-disable effect-native/no-string-timestamp-schema -- The owner routine returns already encoded canonical UTC instants; expires: 2027-03-31. */
import type { ReadServiceFactory, ScopedRoutineInvocationError, ScopedRoutineInvoker } from '@app/core-runtime';
import { PersistenceFailure, defineScopedRoutine } from '@app/core-runtime';
import type { CurrentStorefrontApplicationRequest } from '@app/storefront-registry-contracts';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

const instant = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed());
const positiveRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const StoredCurrentSchema = Schema.Struct({
  allowedChannels: Schema.Array(Schema.Literals(['B2C', 'B2B'])).check(Schema.isMinLength(1)),
  effectiveFrom: instant,
  effectiveTo: Schema.OptionFromNullOr(instant),
  generation,
  lifecycle: Schema.Literals(['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED']),
  observedAt: instant,
  revision: positiveRevision,
});
const SnapshotPayloadSchema = Schema.Union([
  Schema.TaggedStruct('found', { current: StoredCurrentSchema }),
  Schema.TaggedStruct('not_found', { generation, observedAt: instant }),
]);
const SnapshotRowSchema = Schema.Struct({ payload: SnapshotPayloadSchema });

const readCurrentStorefrontApplicationRoutine = defineScopedRoutine({
  name: 'read_current_storefront_application',
  ownerModuleKey: 'commerce.storefront-registry',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: SnapshotRowSchema,
  routineKey: 'storefront-application.read-current',
  schema: 'storefront_registry',
});

export interface CurrentStorefrontApplicationSnapshot {
  readonly allowedChannels: readonly ('B2B' | 'B2C')[];
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly generation: number;
  readonly lifecycle: 'ACTIVE' | 'DRAFT' | 'RETIRED' | 'SUSPENDED';
  readonly observedAt: string;
  readonly revision: number;
}

export interface CurrentStorefrontApplicationPersistenceResult {
  readonly generation: number;
  readonly observedAt: string;
  readonly snapshot: Option.Option<CurrentStorefrontApplicationSnapshot>;
}

export interface CurrentStorefrontApplicationPersistence {
  readonly load: (
    input: CurrentStorefrontApplicationRequest,
  ) => Effect.Effect<CurrentStorefrontApplicationPersistenceResult, PersistenceFailure>;
}

const unavailable = (cause: unknown): PersistenceFailure =>
  new PersistenceFailure({ cause, reason: 'Current Storefront application authority is temporarily unavailable' });

const canonicalInstant = (value: string) =>
  Schema.decodeEffect(Schema.DateTimeUtcFromString)(value).pipe(
    Effect.map(DateTime.formatIso),
    Effect.mapError(unavailable),
  );

type FoundSnapshotPayload = Extract<typeof SnapshotPayloadSchema.Type, { readonly _tag: 'found' }>;

const decodeCurrentSnapshot = Effect.fn('CurrentStorefrontApplicationPersistence.decodeRow.found')(
  function* decodeCurrentSnapshot({
    current,
  }: FoundSnapshotPayload): Effect.fn.Return<CurrentStorefrontApplicationPersistenceResult, PersistenceFailure> {
    const snapshotBase = {
      allowedChannels: current.allowedChannels,
      effectiveFrom: yield* canonicalInstant(current.effectiveFrom),
      generation: current.generation,
      lifecycle: current.lifecycle,
      observedAt: yield* canonicalInstant(current.observedAt),
      revision: current.revision,
    };
    const snapshot: CurrentStorefrontApplicationSnapshot = yield* Option.match(current.effectiveTo, {
      onNone: () => Effect.succeed(snapshotBase),
      onSome: (value) => canonicalInstant(value).pipe(Effect.map((effectiveTo) => ({ ...snapshotBase, effectiveTo }))),
    });
    return {
      generation: current.generation,
      observedAt: snapshot.observedAt,
      snapshot: Option.some(snapshot),
    };
  },
);

const decodeRow = Effect.fn('CurrentStorefrontApplicationPersistence.decodeRow')(function* decodeSnapshot(
  row: typeof SnapshotRowSchema.Type,
): Effect.fn.Return<CurrentStorefrontApplicationPersistenceResult, PersistenceFailure> {
  return yield* Match.value(row.payload).pipe(
    Match.tag('not_found', ({ generation: currentGeneration, observedAt }) =>
      canonicalInstant(observedAt).pipe(
        Effect.map((canonicalObservedAt) => ({
          generation: currentGeneration,
          observedAt: canonicalObservedAt,
          snapshot: Option.none<CurrentStorefrontApplicationSnapshot>(),
        })),
      ),
    ),
    Match.tag('found', decodeCurrentSnapshot),
    Match.exhaustive,
  );
});

export const currentStorefrontApplicationPersistence = (
  transaction: ScopedRoutineInvoker,
  tenantId: string,
): CurrentStorefrontApplicationPersistence => ({
  load: (input) =>
    transaction
      .invoke(readCurrentStorefrontApplicationRoutine, [
        { effectiveAt: input.effectiveAt, storefrontAppId: input.storefrontAppId },
      ])
      .pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap(([row]) => {
          if (row === undefined) {
            return Effect.fail(unavailable('The Storefront Registry owner routine returned no snapshot'));
          }
          if (input.tenantId === tenantId) {
            return decodeRow(row);
          }
          return Effect.fail(unavailable('The Storefront Registry request Tenant does not match the trusted scope'));
        }),
      ),
});

export const currentStorefrontApplicationPersistenceForScope: ReadServiceFactory<
  CurrentStorefrontApplicationPersistence
> = (transaction, scope) => Effect.succeed(currentStorefrontApplicationPersistence(transaction, scope.tenantId));
