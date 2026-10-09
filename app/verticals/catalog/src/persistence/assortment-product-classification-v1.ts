import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import { AssortmentProductClassificationFactsV1Schema } from '../../shared/apis/assortment-product-classification-v1.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import type {
  AssortmentProductClassificationObservationV1,
  AssortmentProductClassificationV1OperationRequest,
  AssortmentProductClassificationV1ResponseSchema,
} from '../../shared/apis/assortment-product-classification-v1.ts';
import { productCategoryHierarchyRevisions } from '../database/schema.ts';
import { CategoryPersistenceUnavailable } from './category-persistence.ts';
import { categoryClassificationPersistenceForScope } from './category-classification-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type Facts = typeof AssortmentProductClassificationFactsV1Schema.Type;
type Response = typeof AssortmentProductClassificationV1ResponseSchema.Type;

const categoryPersistenceUnavailable = (reason: string, cause?: unknown): CategoryPersistenceUnavailable => {
  const error = new CategoryPersistenceUnavailable({ code: 'category_persistence_unavailable', reason });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

export interface AssortmentProductClassificationV1Source {
  readonly read: (productId: string) => Effect.Effect<Option.Option<Facts>, CategoryPersistenceUnavailable>;
}

const sameFacts = Schema.toEquivalence(AssortmentProductClassificationFactsV1Schema);
const sameProductRef = Schema.toEquivalence(ProductRefSchema);

const categoryRef = (ref: { readonly resourceId: string; readonly tenantId: string }) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId: ref.resourceId,
  resourceType: 'commerce.catalog.product-category' as const,
  tenantId: ref.tenantId,
});

const observationFor = (
  productId: string,
  tenantId: string,
  facts: Facts,
  observedAt: DateTime.Utc,
  effectiveAt: DateTime.Utc,
) => {
  const directCategories = facts.directCategories.toSorted((left, right) =>
    left.resourceId.localeCompare(right.resourceId),
  );
  const ancestors = facts.ancestors
    .map(({ ancestorRef, viaDirectCategories }) => ({
      ancestorRef: categoryRef(ancestorRef),
      viaDirectCategories: viaDirectCategories
        .map(categoryRef)
        .toSorted((left, right) => left.resourceId.localeCompare(right.resourceId)),
    }))
    .toSorted((left, right) => left.ancestorRef.resourceId.localeCompare(right.ancestorRef.resourceId));
  const normalized: Facts = {
    ancestors,
    directCategories: directCategories.map(categoryRef),
    revision: facts.revision,
  };
  const predicateRef = `product-classification:${tenantId}:${productId}:effective-at:${DateTime.formatIso(effectiveAt)}`;
  return {
    completeness: {
      observedAt: DateTime.formatIso(observedAt),
      ownerRevision: `assignments:${facts.revision.assignments};hierarchy:${facts.revision.hierarchy}`,
      scope: {
        declaredScopeRef: `tenant-category-classification:${tenantId}`,
        kind: 'SAFELY_BROADER_SCOPE' as const,
        predicateRef,
      },
    },
    effectiveAt,
    facts: normalized,
    observedAt,
    productRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: productId,
      resourceType: 'commerce.catalog.product' as const,
      tenantId,
    },
  } satisfies AssortmentProductClassificationObservationV1;
};

const sameObservation = (
  observed: AssortmentProductClassificationObservationV1,
  current: AssortmentProductClassificationObservationV1,
) =>
  sameProductRef(observed.productRef, current.productRef) &&
  DateTime.toEpochMillis(observed.effectiveAt) === DateTime.toEpochMillis(current.effectiveAt) &&
  observed.completeness.ownerRevision === current.completeness.ownerRevision &&
  observed.completeness.scope.kind === current.completeness.scope.kind &&
  'declaredScopeRef' in observed.completeness.scope === 'declaredScopeRef' in current.completeness.scope &&
  (!('declaredScopeRef' in observed.completeness.scope) ||
    !('declaredScopeRef' in current.completeness.scope) ||
    observed.completeness.scope.declaredScopeRef === current.completeness.scope.declaredScopeRef) &&
  observed.completeness.scope.predicateRef === current.completeness.scope.predicateRef &&
  sameFacts(observed.facts, current.facts);

export const observeOrVerifyAssortmentProductClassificationV1: (
  request: AssortmentProductClassificationV1OperationRequest,
  tenantId: string,
  source: AssortmentProductClassificationV1Source,
) => Effect.Effect<Response, CategoryPersistenceUnavailable> = Effect.fn(
  'observeOrVerifyAssortmentProductClassificationV1',
)(function* observeOrVerify(
  request: AssortmentProductClassificationV1OperationRequest,
  tenantId: string,
  source: AssortmentProductClassificationV1Source,
) {
  if (request.operation === 'OBSERVE') {
    if (request.productRef.tenantId !== tenantId) {
      return yield* categoryPersistenceUnavailable('Classification could not be established for the trusted Tenant');
    }
    const result = yield* source.read(request.productRef.resourceId);
    if (Option.isNone(result)) {
      return yield* categoryPersistenceUnavailable('Product classification is unavailable');
    }
    return {
      observation: observationFor(
        request.productRef.resourceId,
        tenantId,
        result.value,
        yield* DateTime.now,
        request.effectiveAt,
      ),
      operation: 'OBSERVE',
    } as const;
  }
  if (request.observation.productRef.tenantId !== tenantId) {
    return {
      operation: 'VERIFY_CURRENT',
      reason: 'Classification could not be verified for the trusted Tenant',
      status: 'UNAVAILABLE',
    } as const;
  }
  if (DateTime.toEpochMillis(request.effectiveAt) !== DateTime.toEpochMillis(request.observation.effectiveAt)) {
    return {
      operation: 'VERIFY_CURRENT',
      reason: 'The trusted effective time differs from the observed classification time',
      status: 'STALE',
    } as const;
  }
  const current = yield* source
    .read(request.observation.productRef.resourceId)
    .pipe(Effect.catchTag('CategoryPersistenceUnavailable', () => Effect.succeedNone));
  if (Option.isNone(current)) {
    return {
      operation: 'VERIFY_CURRENT',
      reason: 'Catalog cannot establish a complete Current classification set',
      status: 'UNAVAILABLE',
    } as const;
  }
  const observation = observationFor(
    request.observation.productRef.resourceId,
    tenantId,
    current.value,
    yield* DateTime.now,
    request.observation.effectiveAt,
  );
  return sameObservation(request.observation, observation)
    ? { observation, operation: 'VERIFY_CURRENT', status: 'CURRENT' }
    : {
        operation: 'VERIFY_CURRENT',
        reason: 'The Product classification facts or completeness fence changed',
        status: 'STALE',
      };
});

export const assortmentProductClassificationV1SourceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): AssortmentProductClassificationV1Source => ({
  read: Effect.fn('AssortmentProductClassificationV1Source.read')(function* read(productId) {
    // The global Tenant fence covers additions to an empty Product set as well as category moves.
    // A missing legacy fence is unresolved state, never a synthetic empty revision zero.
    const [fence] = yield* transaction
      .select()
      .from(productCategoryHierarchyRevisions)
      .where(eq(productCategoryHierarchyRevisions.tenantId, scope.tenantId))
      .for('share')
      .limit(1)
      .pipe(Effect.mapError((cause) => categoryPersistenceUnavailable('Classification fence read failed', cause)));
    if (fence === undefined) {
      return yield* categoryPersistenceUnavailable('Classification completeness fence is missing');
    }
    const persistence = yield* categoryClassificationPersistenceForScope(transaction, scope);
    const result = yield* persistence.getClassification(productId);
    if (Option.isNone(result)) {
      return Option.none<Facts>();
    }
    if (result.value.status !== 'AVAILABLE') {
      return yield* categoryPersistenceUnavailable('Classification snapshot is incomplete');
    }
    if (
      result.value.revision.assignments !== fence.assignmentRevision ||
      result.value.revision.hierarchy !== fence.hierarchyRevision
    ) {
      return yield* categoryPersistenceUnavailable('Classification facts do not match their completeness fence');
    }
    return Option.some({
      ancestors: result.value.ancestors.map(({ ancestorRef, viaDirectCategories }) => ({
        ancestorRef: categoryRef(ancestorRef),
        viaDirectCategories: viaDirectCategories.map(categoryRef),
      })),
      directCategories: result.value.directCategories.map(categoryRef),
      revision: result.value.revision,
    });
  }),
});
