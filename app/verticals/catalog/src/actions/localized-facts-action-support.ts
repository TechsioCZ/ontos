import type { ActionHandlerContext } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import type { ProductRef } from '../../shared/resources/product.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import {
  localizedProductFactsPersistenceForScope,
  LocalizedFactsPersistenceUnavailable,
} from '../persistence/localized-product-facts-persistence.ts';
import type { LocalizedFactOutcome } from '../persistence/localized-product-facts-persistence.ts';
import { LocalizedFactsNotFound } from './localized-facts-not-found.ts';

export { ProductAuditEvidenceSchema } from '../../shared/domain/product.ts';
export const localizedFactsActionServiceFactory = (
  ...args: Parameters<typeof localizedProductFactsPersistenceForScope>
) => Effect.succeed(localizedProductFactsPersistenceForScope(...args));

export class LocalizedFactsConflict extends Schema.TaggedError<LocalizedFactsConflict>()('LocalizedFactsConflict', {
  actualRevision: Schema.optionalKey(Schema.Int),
  code: Schema.Literal('localized_facts_conflict'),
  reason: Schema.String,
}) {}
export const LocalizedFactsActionErrorSchema = Schema.Union([
  LocalizedFactsNotFound,
  LocalizedFactsConflict,
  LocalizedFactsPersistenceUnavailable,
]);

export const checkLocalizedRefs = (tenantId: string, productRef: ProductRef, variantRef?: VariantRef) =>
  productRef.tenantId !== tenantId || (variantRef !== undefined && variantRef.tenantId !== tenantId)
    ? Effect.fail(
        new LocalizedFactsNotFound({
          code: 'localized_facts_not_found',
          reason: 'Catalog target was not found in the trusted Tenant',
        }),
      )
    : Effect.void;

export const localizedOutcome = (
  outcome: LocalizedFactOutcome,
): Effect.Effect<
  { readonly changed: boolean; readonly revision: number },
  LocalizedFactsConflict | LocalizedFactsNotFound
> => {
  if (outcome.kind === 'CHANGED' || outcome.kind === 'REPLAYED') {
    return Effect.succeed({ changed: outcome.kind === 'CHANGED', revision: outcome.revision });
  }
  if (outcome.kind === 'NOT_FOUND') {
    return Effect.fail(
      new LocalizedFactsNotFound({ code: 'localized_facts_not_found', reason: 'Catalog target was not found' }),
    );
  }
  if (outcome.kind === 'STALE') {
    return Effect.fail(
      new LocalizedFactsConflict({
        actualRevision: outcome.actualRevision,
        code: 'localized_facts_conflict',
        reason: 'Localized Catalog facts changed before this Action committed',
      }),
    );
  }
  return Effect.fail(
    new LocalizedFactsConflict({
      code: 'localized_facts_conflict',
      reason:
        outcome.kind === 'TEXT_MINIMUM_CONFLICT'
          ? 'An active Product needs at least one usable Catalog name'
          : 'Localized Catalog facts cannot be changed from their current state',
    }),
  );
};

type Services = ReturnType<typeof localizedProductFactsPersistenceForScope>;
export const recordLocalizedAccess = Effect.fn('LocalizedFactsAction.recordAccess')(function* recordLocalizedAccess(
  context: ActionHandlerContext<Readonly<Record<string, never>>, Services>,
  resourceId: string,
  resourceType: 'commerce.catalog.product' | 'commerce.catalog.variant',
) {
  yield* context.recordDataAccess({
    accessKind: 'read',
    queryHash: `catalog-localized-facts:${resourceType}:${resourceId}`,
    resultCount: 1,
    servingModuleKey: 'commerce.catalog',
    targetModuleKey: 'commerce.catalog',
    targetResourceId: resourceId,
    targetResourceType: resourceType,
  });
});
