import type { ActionHandlerContext } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { SkuPersistenceUnavailable, skuPersistenceForScope } from '../persistence/sku-persistence.ts';
import type { SkuChangeOutcome } from '../persistence/sku-persistence.ts';
import { SkuActionConflict } from './sku-action-conflict.ts';
import { SkuActionInvalid } from './sku-action-invalid.ts';
import { SkuActionNotFound } from './sku-action-not-found.ts';
import { SkuActionStale } from './sku-action-stale.ts';

export { ProductAuditEvidenceSchema } from '../../shared/domain/product.ts';
export { SkuActionConflict } from './sku-action-conflict.ts';
export { SkuActionStale } from './sku-action-stale.ts';
export const skuServicesForScope = (...args: Parameters<typeof skuPersistenceForScope>) =>
  Effect.succeed(skuPersistenceForScope(...args));
export type SkuServices = ReturnType<typeof skuPersistenceForScope>;

export const SkuActionErrorSchema = Schema.Union([
  SkuActionConflict,
  SkuActionStale,
  SkuActionInvalid,
  SkuActionNotFound,
  SkuPersistenceUnavailable,
]);

export const completeSkuChange = Effect.fn('SkuAction.completeChange')(function* completeSkuChange(
  outcome: SkuChangeOutcome,
  payload: {
    readonly code: string;
    readonly evidenceRefs: readonly string[];
    readonly reason: string;
    readonly target:
      | { readonly kind: 'VARIANT'; readonly tenantId: string; readonly variantId: string }
      | { readonly kind: 'PACKAGE_OPTION'; readonly packageDefinitionId: string; readonly tenantId: string };
  },
  context: ActionHandlerContext<Readonly<Record<string, never>>, SkuServices>,
) {
  const result = yield* Match.value(outcome).pipe(
    Match.tag('applied', ({ revision }) => Effect.succeed({ revision })),
    Match.tag('conflict', () =>
      Effect.fail(
        new SkuActionConflict({ code: 'sku_action_conflict', reason: 'SKU conflicts with retained assignment' }),
      ),
    ),
    Match.tag('stale', ({ actualRevision }) =>
      Effect.fail(new SkuActionStale({ actualRevision, code: 'sku_action_stale' })),
    ),
    Match.tag('invalid', ({ reason }) => Effect.fail(new SkuActionInvalid({ code: 'sku_action_invalid', reason }))),
    Match.tag('not_found', () =>
      Effect.fail(new SkuActionNotFound({ code: 'sku_action_not_found', reason: 'Exact SKU target was not found' })),
    ),
    Match.exhaustive,
  );
  yield* context.recordAuditEvidence({ evidenceRefs: [...payload.evidenceRefs], reason: payload.reason });
  yield* context.recordDataAccess({
    accessKind: 'read',
    queryHash: `catalog-sku-target:${payload.target.kind}:${payload.target.kind === 'VARIANT' ? payload.target.variantId : payload.target.packageDefinitionId}`,
    resultCount: 1,
    servingModuleKey: 'commerce.catalog',
    targetModuleKey: 'commerce.catalog',
    targetResourceId: payload.target.kind === 'VARIANT' ? payload.target.variantId : payload.target.packageDefinitionId,
    targetResourceType:
      payload.target.kind === 'VARIANT' ? 'commerce.catalog.variant' : 'commerce.catalog.package-definition',
  });
  return result;
});
