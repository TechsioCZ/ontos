import type { ScopedRoutineInvocationError, ScopedRoutineInvoker } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import { PriceGroupAuthorizationTopologyMutationIdSchema } from '../../shared/actions/create-price-group.ts';
import { PriceGroupDefinitionRevisionSchema, PriceGroupInstantSchema } from '../../shared/domain/price-group.ts';
import { PriceGroupCatalogRootRefSchema } from '../../shared/resources/price-group-catalog-root.ts';
import { PriceGroupRefSchema } from '../../shared/resources/price-group.ts';
import {
  completePriceGroupContainmentProjectionRoutine,
  readPriceGroupContainmentProjectionIntentRoutine,
} from './containment-projection-routines.ts';
import {
  PriceGroupContainmentProjectionConflict,
  PriceGroupContainmentProjectionPersistenceUnavailable,
} from './containment-projection-errors.ts';

const SourceActionInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PriceGroupContainmentProjectionSourceActionInvocationId'),
  Schema.decodeTo(Schema.String),
);

const PriceGroupContainmentProjectionIntentSchema = Schema.Struct({
  catalogVersion: Schema.Literal('1'),
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- null is the durable PENDING sentinel; expires: 2027-03-31.
  completedAt: Schema.NullOr(PriceGroupInstantSchema),
  definition: PriceGroupDefinitionRevisionSchema,
  mutationId: PriceGroupAuthorizationTopologyMutationIdSchema,
  operation: Schema.Literal('touch_containment'),
  priceGroupRef: PriceGroupRefSchema,
  pricingCatalogRef: PriceGroupCatalogRootRefSchema,
  requestedAt: PriceGroupInstantSchema,
  schemaVersion: Schema.Literal('1'),
  sourceActionInvocationId: SourceActionInvocationIdSchema,
  state: Schema.Literals(['PENDING', 'APPLIED']),
}).check(
  Schema.makeFilter((intent) =>
    intent.priceGroupRef.tenantId === intent.pricingCatalogRef.tenantId &&
    intent.definition.priceGroupRef.resourceId === intent.priceGroupRef.resourceId &&
    intent.definition.priceGroupRef.tenantId === intent.priceGroupRef.tenantId &&
    ((intent.state === 'PENDING' && intent.completedAt === null) ||
      (intent.state === 'APPLIED' && intent.completedAt !== null))
      ? undefined
      : 'The Price Group containment projection intent is internally inconsistent',
  ),
);
type PriceGroupContainmentProjectionIntent = typeof PriceGroupContainmentProjectionIntentSchema.Type;

const FoundOutcomeSchema = Schema.TaggedStruct('found', { intent: PriceGroupContainmentProjectionIntentSchema });
const CompletedOutcomeSchema = Schema.TaggedStruct('completed', {
  completion: PriceGroupContainmentProjectionIntentSchema,
});
const NotFoundOutcomeSchema = Schema.TaggedStruct('not_found', {});
const ReadOutcomeSchema = Schema.Union([FoundOutcomeSchema, NotFoundOutcomeSchema]);
const CompleteOutcomeSchema = Schema.Union([CompletedOutcomeSchema, NotFoundOutcomeSchema]);

const unavailable = (cause?: unknown) => {
  const failure = new PriceGroupContainmentProjectionPersistenceUnavailable({
    reason: 'Price Group containment projection persistence is temporarily unavailable',
    retryable: true,
  });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', {
        configurable: false,
        enumerable: false,
        value: cause,
      });
};

const conflict = () =>
  new PriceGroupContainmentProjectionConflict({
    reason: 'The durable Price Group containment projection intent is missing or inconsistent',
    retryable: false,
  });

const decode = <Value>(
  schema: Schema.ConstraintDecoder<Value>,
  rows: readonly { readonly payload: unknown }[],
): Effect.Effect<Value, PriceGroupContainmentProjectionPersistenceUnavailable> => {
  const [row] = rows;
  return row === undefined || rows.length !== 1
    ? Effect.fail(unavailable())
    : Schema.decodeUnknownEffect(schema)(row.payload).pipe(Effect.mapError(unavailable));
};

const invocationFailure = (failure: ScopedRoutineInvocationError) => unavailable(failure);

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- This lifetime-scoped repository is built from the tenant worker routine invoker, never installed as ambient Context; expires: 2027-03-31.
export interface PriceGroupContainmentProjectionRepository {
  readonly complete: (
    mutationId: string,
    completedAt: Date,
  ) => Effect.Effect<
    PriceGroupContainmentProjectionIntent,
    PriceGroupContainmentProjectionConflict | PriceGroupContainmentProjectionPersistenceUnavailable
  >;
  readonly load: (
    mutationId: string,
  ) => Effect.Effect<
    PriceGroupContainmentProjectionIntent,
    PriceGroupContainmentProjectionConflict | PriceGroupContainmentProjectionPersistenceUnavailable
  >;
}

export const priceGroupContainmentProjectionRepositoryFromRoutineInvoker = (
  routineInvoker: ScopedRoutineInvoker,
): PriceGroupContainmentProjectionRepository => ({
  complete: (mutationId, completedAt) =>
    routineInvoker.invoke(completePriceGroupContainmentProjectionRoutine, [mutationId, completedAt]).pipe(
      Effect.mapError(invocationFailure),
      Effect.flatMap((rows) => decode(CompleteOutcomeSchema, rows)),
      Effect.flatMap((outcome) =>
        Schema.is(CompletedOutcomeSchema)(outcome) ? Effect.succeed(outcome.completion) : Effect.fail(conflict()),
      ),
    ),
  load: (mutationId) =>
    routineInvoker.invoke(readPriceGroupContainmentProjectionIntentRoutine, [mutationId]).pipe(
      Effect.mapError(invocationFailure),
      Effect.flatMap((rows) => decode(ReadOutcomeSchema, rows)),
      Effect.flatMap((outcome) =>
        Schema.is(FoundOutcomeSchema)(outcome) ? Effect.succeed(outcome.intent) : Effect.fail(conflict()),
      ),
    ),
});
