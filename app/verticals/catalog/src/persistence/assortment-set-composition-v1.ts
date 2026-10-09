import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import type {
  AssortmentSetCompositionObservationV1,
  AssortmentSetCompositionV1OperationRequest,
  AssortmentSetCompositionV1ResponseSchema,
} from '../../shared/apis/assortment-set-composition-v1.ts';
import { SetCompositionRevisionSchema } from '../../shared/domain/set-composition.ts';
import { setCompositions } from '../database/schema.ts';
import {
  SetCompositionPersistenceUnavailable,
  setCompositionPersistenceForScope,
} from './set-composition-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type Response = typeof AssortmentSetCompositionV1ResponseSchema.Type;

export class AssortmentSetCompositionV1NotFound extends Schema.TaggedError<AssortmentSetCompositionV1NotFound>()(
  'AssortmentSetCompositionV1NotFound',
  { code: Schema.Literal('assortment_set_composition_not_found') },
) {}

interface CurrentComposition {
  readonly currentRevision: number;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date;
  readonly revision: AssortmentSetCompositionObservationV1['composition'];
}

export interface AssortmentSetCompositionV1Source {
  readonly observe: (input: {
    readonly at: Date;
    readonly compositionId: string;
    readonly productId: string;
    readonly requestedRevision?: number;
    readonly tenantId: string;
    readonly variantId: string;
  }) => Effect.Effect<Option.Option<CurrentComposition>, SetCompositionPersistenceUnavailable>;
}

const sameComposition = Schema.toEquivalence(SetCompositionRevisionSchema);
const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: typeof left,
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const observationFor = (
  current: CurrentComposition,
  observedAt: DateTime.Utc,
  effectiveAt: DateTime.Utc,
): AssortmentSetCompositionObservationV1 => {
  const composition = {
    ...current.revision,
    components: current.revision.components.toSorted((left, right) =>
      left.componentId.localeCompare(right.componentId),
    ),
  };
  const compositionId = composition.reference.resourceRef.resourceId;
  const observation = {
    completeness: {
      observedAt: DateTime.formatIso(observedAt),
      ownerRevision: `current:${current.currentRevision};composition:${composition.reference.revision}`,
      scope: {
        kind: 'EXACT_PREDICATE',
        predicateRef: `set-composition:${compositionId}:product:${composition.productRef.resourceId}:variant:${composition.variantRef.resourceId}:effective-at:${DateTime.formatIso(effectiveAt)}`,
      },
    },
    composition,
    effectiveAt,
    effectiveFrom: DateTime.fromDateUnsafe(current.effectiveFrom),
    lifecycleState: 'ACTIVE',
    observedAt,
    productRef: composition.productRef,
    requestedRevision: composition.reference.revision,
    variantRef: composition.variantRef,
  } satisfies Omit<AssortmentSetCompositionObservationV1, 'effectiveTo'>;
  if (current.effectiveTo === undefined) {
    return observation;
  }
  return { ...observation, effectiveTo: DateTime.fromDateUnsafe(current.effectiveTo) };
};

const sameObservation = (
  observed: AssortmentSetCompositionObservationV1,
  current: AssortmentSetCompositionObservationV1,
): boolean =>
  sameComposition(observed.composition, current.composition) &&
  observed.requestedRevision === current.requestedRevision &&
  sameRef(observed.productRef, current.productRef) &&
  sameRef(observed.variantRef, current.variantRef) &&
  DateTime.toEpochMillis(observed.effectiveAt) === DateTime.toEpochMillis(current.effectiveAt) &&
  DateTime.toEpochMillis(observed.effectiveFrom) === DateTime.toEpochMillis(current.effectiveFrom) &&
  (observed.effectiveTo === undefined
    ? current.effectiveTo === undefined
    : current.effectiveTo !== undefined &&
      DateTime.toEpochMillis(observed.effectiveTo) === DateTime.toEpochMillis(current.effectiveTo)) &&
  observed.completeness.ownerRevision === current.completeness.ownerRevision &&
  observed.completeness.scope.kind === current.completeness.scope.kind &&
  observed.completeness.scope.predicateRef === current.completeness.scope.predicateRef &&
  'declaredScopeRef' in observed.completeness.scope === 'declaredScopeRef' in current.completeness.scope &&
  (!('declaredScopeRef' in observed.completeness.scope) ||
    !('declaredScopeRef' in current.completeness.scope) ||
    observed.completeness.scope.declaredScopeRef === current.completeness.scope.declaredScopeRef);

export const observeOrVerifyAssortmentSetCompositionV1: (
  request: AssortmentSetCompositionV1OperationRequest,
  tenantId: string,
  source: AssortmentSetCompositionV1Source,
) => Effect.Effect<Response, SetCompositionPersistenceUnavailable | AssortmentSetCompositionV1NotFound> = Effect.fn(
  'observeOrVerifyAssortmentSetCompositionV1',
)(function* observeOrVerify(
  request: AssortmentSetCompositionV1OperationRequest,
  tenantId: string,
  source: AssortmentSetCompositionV1Source,
) {
  if (request.operation === 'OBSERVE') {
    if (
      request.productRef.tenantId !== tenantId ||
      request.variantRef.tenantId !== tenantId ||
      request.compositionRef.tenantId !== tenantId
    ) {
      return yield* new AssortmentSetCompositionV1NotFound({ code: 'assortment_set_composition_not_found' });
    }
    const observationInput = {
      at: DateTime.toDateUtc(request.effectiveAt),
      compositionId: request.compositionRef.resourceId,
      productId: request.productRef.resourceId,
      tenantId,
      variantId: request.variantRef.resourceId,
    };
    const current = yield* request.requestedRevision === undefined
      ? source.observe(observationInput)
      : source.observe({ ...observationInput, requestedRevision: request.requestedRevision });
    if (Option.isNone(current)) {
      return yield* new AssortmentSetCompositionV1NotFound({ code: 'assortment_set_composition_not_found' });
    }
    return {
      observation: observationFor(current.value, yield* DateTime.now, request.effectiveAt),
      operation: 'OBSERVE',
    } as const;
  }

  if (
    request.observation.productRef.tenantId !== tenantId ||
    request.observation.variantRef.tenantId !== tenantId ||
    request.observation.composition.reference.resourceRef.tenantId !== tenantId
  ) {
    return {
      operation: 'VERIFY_CURRENT',
      reason: 'Catalog could not verify the Set Composition for the trusted Tenant',
      status: 'UNAVAILABLE',
    } as const;
  }
  if (DateTime.toEpochMillis(request.effectiveAt) !== DateTime.toEpochMillis(request.observation.effectiveAt)) {
    return {
      operation: 'VERIFY_CURRENT',
      reason: 'The trusted effective time differs from the observed Set Composition time',
      status: 'STALE',
    } as const;
  }
  const latest = yield* source
    .observe({
      at: DateTime.toDateUtc(request.observation.effectiveAt),
      compositionId: request.observation.composition.reference.resourceRef.resourceId,
      productId: request.observation.productRef.resourceId,
      requestedRevision: request.observation.requestedRevision,
      tenantId,
      variantId: request.observation.variantRef.resourceId,
    })
    .pipe(
      Effect.map((current) => ({ current }) as const),
      Effect.catchTag('SetCompositionPersistenceUnavailable', () => Effect.succeed({ unavailable: true as const })),
    );
  if ('unavailable' in latest) {
    return {
      operation: 'VERIFY_CURRENT',
      reason: 'Catalog cannot re-establish the Set Composition completeness fence',
      status: 'UNAVAILABLE',
    } as const;
  }
  if (Option.isNone(latest.current)) {
    return {
      operation: 'VERIFY_CURRENT',
      reason: 'The observed Set Composition is no longer Current or cannot be found',
      status: 'STALE',
    } as const;
  }
  const latestObservation = observationFor(latest.current.value, yield* DateTime.now, request.observation.effectiveAt);
  return sameObservation(request.observation, latestObservation)
    ? { observation: latestObservation, operation: 'VERIFY_CURRENT', status: 'CURRENT' }
    : {
        operation: 'VERIFY_CURRENT',
        reason: 'The Current Set Composition or its complete component set changed',
        status: 'STALE',
      };
});

export const assortmentSetCompositionV1SourceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): AssortmentSetCompositionV1Source => ({
  observe: Effect.fn('AssortmentSetCompositionV1Source.observe')(function* observe(input) {
    const [owner] = yield* transaction
      .select()
      .from(setCompositions)
      .where(and(eq(setCompositions.tenantId, scope.tenantId), eq(setCompositions.compositionId, input.compositionId)))
      .for('share')
      .limit(1)
      .pipe(
        Effect.mapError((cause) => {
          const error = new SetCompositionPersistenceUnavailable({
            code: 'set_composition_persistence_unavailable',
            reason: 'Set Composition completeness fence could not be read',
          });
          Object.defineProperty(error, 'cause', { configurable: true, value: cause });
          return error;
        }),
      );
    if (
      owner === undefined ||
      owner.productId !== input.productId ||
      owner.variantId !== input.variantId ||
      scope.tenantId !== input.tenantId
    ) {
      return Option.none<CurrentComposition>();
    }
    const current = yield* setCompositionPersistenceForScope(transaction, scope).readCurrent({
      at: input.at,
      compositionId: input.compositionId,
    });
    if (
      Option.isNone(current) ||
      (input.requestedRevision !== undefined && current.value.revision.reference.revision !== input.requestedRevision)
    ) {
      return Option.none<CurrentComposition>();
    }
    const row: CurrentComposition = {
      currentRevision: owner.currentRevision,
      effectiveFrom: current.value.effectiveFrom,
      revision: current.value.revision,
    };
    return Option.some(
      current.value.effectiveTo === undefined ? row : { ...row, effectiveTo: current.value.effectiveTo },
    );
  }),
});
