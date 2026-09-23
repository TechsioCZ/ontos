import { Schema } from 'effect'; // oxlint-disable-line eslint/max-classes-per-file -- These tagged failures form one cohesive owner vocabulary; expires: 2027-03-31.

import {
  PriceGroupActionInvocationIdSchema,
  PriceGroupDefinitionRevisionIdSchema,
  PriceGroupInstantSchema,
  PriceGroupMeaningFingerprintSchema,
  PriceGroupReasonSchema,
  StablePriceGroupRefSchema,
} from './price-group.ts';
import { PriceGroupTenantIdSchema } from '../resources/price-group.ts';

export class PriceGroupNotFound extends Schema.TaggedError<PriceGroupNotFound>()('PriceGroupNotFound', {
  code: Schema.Literal('price_group_not_found'),
  reason: PriceGroupReasonSchema,
}) {}

export class PriceGroupCodeConflict extends Schema.TaggedError<PriceGroupCodeConflict>()('PriceGroupCodeConflict', {
  code: Schema.Literal('price_group_code_conflict'),
  conflictingCode: Schema.String,
  reason: PriceGroupReasonSchema,
}) {}

export class PriceGroupLifecycleConflict extends Schema.TaggedError<PriceGroupLifecycleConflict>()(
  'PriceGroupLifecycleConflict',
  {
    code: Schema.Literal('price_group_lifecycle_conflict'),
    priceGroupRef: StablePriceGroupRefSchema,
    reason: PriceGroupReasonSchema,
  },
) {}

export class PriceGroupEffectivePeriodConflict extends Schema.TaggedError<PriceGroupEffectivePeriodConflict>()(
  'PriceGroupEffectivePeriodConflict',
  {
    code: Schema.Literal('price_group_effective_period_conflict'),
    effectiveFrom: PriceGroupInstantSchema,
    priceGroupRef: StablePriceGroupRefSchema,
    reason: PriceGroupReasonSchema,
    trustedEffectiveAt: PriceGroupInstantSchema,
  },
) {}

export class PriceGroupRetirementEffectiveTimeConflict extends Schema.TaggedError<PriceGroupRetirementEffectiveTimeConflict>()(
  'PriceGroupRetirementEffectiveTimeConflict',
  {
    code: Schema.Literal('price_group_retirement_effective_time_conflict'),
    effectiveAt: PriceGroupInstantSchema,
    priceGroupRef: StablePriceGroupRefSchema,
    reason: PriceGroupReasonSchema,
    trustedEffectiveAt: PriceGroupInstantSchema,
  },
) {}

export class PriceGroupMeaningChangeRequired extends Schema.TaggedError<PriceGroupMeaningChangeRequired>()(
  'PriceGroupMeaningChangeRequired',
  {
    code: Schema.Literal('price_group_meaning_change_requires_new_identity'),
    priceGroupRef: StablePriceGroupRefSchema,
    reason: PriceGroupReasonSchema,
  },
) {}

export class PriceGroupCurrentnessFailure extends Schema.TaggedError<PriceGroupCurrentnessFailure>()(
  'PriceGroupCurrentnessFailure',
  {
    candidateDefinitionRevisionIds: Schema.Array(PriceGroupDefinitionRevisionIdSchema),
    code: Schema.Literal('price_group_currentness_failure'),
    priceGroupRef: StablePriceGroupRefSchema,
    reason: Schema.Literals(['ZERO_CURRENT_DEFINITIONS', 'MULTIPLE_CURRENT_DEFINITIONS', 'UNVERIFIABLE_CURRENTNESS']),
  },
) {}

export class PriceGroupExpectedCurrentConflict extends Schema.TaggedError<PriceGroupExpectedCurrentConflict>()(
  'PriceGroupExpectedCurrentConflict',
  {
    code: Schema.Literal('price_group_expected_current_conflict'),
    priceGroupRef: StablePriceGroupRefSchema,
    reason: PriceGroupReasonSchema,
  },
) {}

export class PriceGroupIdempotencyReuseConflict extends Schema.TaggedError<PriceGroupIdempotencyReuseConflict>()(
  'PriceGroupIdempotencyReuseConflict',
  {
    actionInvocationId: PriceGroupActionInvocationIdSchema,
    code: Schema.Literal('price_group_idempotency_reuse_conflict'),
    reason: PriceGroupReasonSchema,
  },
) {}

export class PriceGroupSemanticIdentityConflict extends Schema.TaggedError<PriceGroupSemanticIdentityConflict>()(
  'PriceGroupSemanticIdentityConflict',
  {
    code: Schema.Literal('price_group_semantic_identity_conflict'),
    existingMeaningFingerprint: PriceGroupMeaningFingerprintSchema,
    priceGroupRef: StablePriceGroupRefSchema,
    reason: PriceGroupReasonSchema,
    requestedMeaningFingerprint: PriceGroupMeaningFingerprintSchema,
  },
) {}

export class PriceGroupTenantScopeFailure extends Schema.TaggedError<PriceGroupTenantScopeFailure>()(
  'PriceGroupTenantScopeFailure',
  {
    code: Schema.Literal('price_group_tenant_scope_failure'),
    expectedTenantId: PriceGroupTenantIdSchema,
    reason: PriceGroupReasonSchema,
    receivedTenantId: PriceGroupTenantIdSchema,
  },
) {}

export class PriceGroupPersistenceUnavailable extends Schema.TaggedError<PriceGroupPersistenceUnavailable>()(
  'PriceGroupPersistenceUnavailable',
  {
    code: Schema.Literal('price_group_persistence_unavailable'),
    reason: PriceGroupReasonSchema,
    retryable: Schema.Literal(true),
  },
) {}

export const PriceGroupOwnerFailureSchema = Schema.Union([
  PriceGroupNotFound,
  PriceGroupCodeConflict,
  PriceGroupLifecycleConflict,
  PriceGroupEffectivePeriodConflict,
  PriceGroupRetirementEffectiveTimeConflict,
  PriceGroupMeaningChangeRequired,
  PriceGroupCurrentnessFailure,
  PriceGroupExpectedCurrentConflict,
  PriceGroupIdempotencyReuseConflict,
  PriceGroupSemanticIdentityConflict,
  PriceGroupTenantScopeFailure,
  PriceGroupPersistenceUnavailable,
]);
export type PriceGroupOwnerFailure = typeof PriceGroupOwnerFailureSchema.Type;
