import type { ActionHandlerContext, DomainEventContractMap } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import type { VariantRef } from '../../shared/resources/variant.ts';
import { CatalogPersistenceUnavailable } from '../persistence/errors.ts';
import { VariantCombinationConflict } from './variant-combination-conflict.ts';
import {
  VariantCurrentBasisUnavailable,
  variantPersistenceForScope as makeVariantPersistence,
} from '../persistence/variant-persistence.ts';
import type { VariantPersistence } from '../persistence/variant-persistence.ts';
import { VariantActionNotFound } from './variant-action-not-found.ts';

export { ProductAuditEvidenceSchema } from '../../shared/domain/product.ts';
export const variantPersistenceForScope = (...args: Parameters<typeof makeVariantPersistence>) =>
  Effect.succeed(makeVariantPersistence(...args));

export class VariantActionConflict extends Schema.TaggedError<VariantActionConflict>()('VariantActionConflict', {
  code: Schema.Literal('variant_action_conflict'),
  conflict: Schema.Literals(['REVISION', 'LIFECYCLE', 'IDENTITY', 'INVALID_CHANGE', 'SELECTION_REVALIDATION']),
  reason: Schema.String,
}) {}

export const VariantActionErrorSchema = Schema.Union([
  VariantActionConflict,
  VariantActionNotFound,
  VariantCurrentBasisUnavailable,
  CatalogPersistenceUnavailable,
]);

export const VariantCombinationActionErrorSchema = Schema.Union([
  VariantCombinationConflict,
  VariantActionNotFound,
  VariantCurrentBasisUnavailable,
  CatalogPersistenceUnavailable,
]);

export const checkVariantTenant = (tenantId: string, variantRef: VariantRef) =>
  tenantId === variantRef.tenantId
    ? Effect.void
    : Effect.fail(
        new VariantActionNotFound({ code: 'variant_action_not_found', reason: 'Variant is not in the trusted Tenant' }),
      );

export const conflictForOutcome = (
  tag:
    | 'revision_conflict'
    | 'lifecycle_conflict'
    | 'identity_conflict'
    | 'invalid_change'
    | 'selection_revalidation_required',
) => {
  const stateReason = 'Variant cannot be changed from its current state';
  const codes = {
    identity_conflict: 'IDENTITY',
    invalid_change: 'INVALID_CHANGE',
    lifecycle_conflict: 'LIFECYCLE',
    revision_conflict: 'REVISION',
    selection_revalidation_required: 'SELECTION_REVALIDATION',
  } as const;
  const reasons = {
    identity_conflict: stateReason,
    invalid_change: stateReason,
    lifecycle_conflict: stateReason,
    revision_conflict: stateReason,
    selection_revalidation_required: 'Open Cart selections must be reselected before reactivation',
  } as const;
  return new VariantActionConflict({
    code: 'variant_action_conflict',
    conflict: codes[tag],
    reason: reasons[tag],
  });
};

export const variantNotFound = () =>
  new VariantActionNotFound({
    code: 'variant_action_not_found',
    reason: 'Variant was not found in the trusted Tenant',
  });

export const recordVariantAccess = Effect.fn('VariantAction.recordAccess')(function* recordVariantAccess<
  Events extends DomainEventContractMap,
>(context: ActionHandlerContext<Events, VariantPersistence>, variantId: string) {
  yield* context.recordDataAccess({
    accessKind: 'read',
    queryHash: `catalog-variant:${variantId}`,
    resultCount: 1,
    servingModuleKey: 'commerce.catalog',
    targetModuleKey: 'commerce.catalog',
    targetResourceId: variantId,
    targetResourceType: 'commerce.catalog.variant',
  });
});
