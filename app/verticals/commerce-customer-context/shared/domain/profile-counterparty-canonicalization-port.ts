import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { Context, Effect, Schema } from 'effect';

import { ProfileBoundedKeySchema, ProfileInstantSchema, SellingLegalEntityRefSchema } from './profile-contracts.ts';
import { CounterpartyCanonicalizationOwnerUnavailable } from './profile-counterparty-canonicalization-error.ts';
import { ProfileReconciliationCaseRefSchema } from '../resources/profile-reconciliation-case.ts';

export { CounterpartyCanonicalizationOwnerUnavailable } from './profile-counterparty-canonicalization-error.ts';

const CounterpartyCanonicalizationEventVersionSchema = Schema.BigIntFromString.check(
  Schema.isGreaterThanOrEqualToBigInt(1n),
);

/**
 * Identity-only evidence supplied by the Party Registry owner. It says which Counterparty
 * references now share one canonical identity; it does not choose a Commerce profile survivor,
 * combine owner facts, or authorize any principal.
 */
export const CounterpartyCanonicalizationEvidenceSchema = Schema.Struct({
  aliasedCounterpartyRefs: Schema.Array(CounterpartyRefSchema).check(Schema.isMinLength(1)),
  canonicalCounterpartyRef: CounterpartyRefSchema,
  correlationRef: ProfileBoundedKeySchema,
  managedLegalEntityRef: SellingLegalEntityRefSchema,
  observedAt: ProfileInstantSchema,
  policyVersion: ProfileBoundedKeySchema,
  sourceDomainEventId: ProfileBoundedKeySchema,
  sourceEventVersion: CounterpartyCanonicalizationEventVersionSchema,
  sourceMessageId: ProfileBoundedKeySchema,
  trigger: Schema.Literals(['COUNTERPARTY_ALIAS', 'CREATE_COLLISION', 'IMPORT_CORRELATION']),
}).check(
  Schema.makeFilter(({ aliasedCounterpartyRefs, canonicalCounterpartyRef }) =>
    aliasedCounterpartyRefs.some((ref) => ref.resourceId === canonicalCounterpartyRef.resourceId)
      ? 'The canonical Counterparty reference cannot also be an alias'
      : undefined,
  ),
  Schema.makeFilter(({ aliasedCounterpartyRefs }) =>
    new Set(aliasedCounterpartyRefs.map(({ resourceId }) => resourceId)).size === aliasedCounterpartyRefs.length
      ? undefined
      : 'Aliased Counterparty references must be unique',
  ),
  Schema.makeFilter(({ aliasedCounterpartyRefs, canonicalCounterpartyRef, managedLegalEntityRef }) => {
    const { tenantId } = canonicalCounterpartyRef;
    return managedLegalEntityRef.tenantId === tenantId &&
      aliasedCounterpartyRefs.every((ref) => ref.tenantId === tenantId)
      ? undefined
      : 'Canonicalization evidence must stay inside one Tenant';
  }),
);
export type CounterpartyCanonicalizationEvidence = typeof CounterpartyCanonicalizationEvidenceSchema.Type;

export const CounterpartyCanonicalizationObservationResultSchema = Schema.Union([
  Schema.Struct({
    currentEventVersion: CounterpartyCanonicalizationEventVersionSchema,
    outcome: Schema.Literals(['NO_CONFLICTING_PROFILES', 'DUPLICATE', 'OUT_OF_ORDER', 'COMPLETED_NO_CHANGE']),
  }),
  Schema.Struct({
    caseRefs: Schema.Array(ProfileReconciliationCaseRefSchema).check(Schema.isMinLength(1)),
    currentEventVersion: CounterpartyCanonicalizationEventVersionSchema,
    outcome: Schema.Literals(['RECONCILIATIONS_OPENED', 'RECONCILIATIONS_UPDATED']),
  }),
]);
export type CounterpartyCanonicalizationObservationResult =
  typeof CounterpartyCanonicalizationObservationResultSchema.Type;

export interface CounterpartyCanonicalizationObservationPortService {
  readonly observe: (
    evidence: CounterpartyCanonicalizationEvidence,
  ) => Effect.Effect<CounterpartyCanonicalizationObservationResult, CounterpartyCanonicalizationOwnerUnavailable>;
}

export class CounterpartyCanonicalizationObservationPort extends Context.Service<
  CounterpartyCanonicalizationObservationPort,
  CounterpartyCanonicalizationObservationPortService
>()(
  '@app/commerce-customer-context/shared/domain/profile-counterparty-canonicalization-port/CounterpartyCanonicalizationObservationPort',
) {}

/**
 * Closed production default until Party Registry publishes a governed Counterparty
 * alias/canonicalization observation. Consumers must never infer this fact from Party merge data.
 */
export const unavailableCounterpartyCanonicalizationObservationPort =
  (): CounterpartyCanonicalizationObservationPortService => ({
    observe: () =>
      Effect.fail(
        new CounterpartyCanonicalizationOwnerUnavailable({
          ownerModuleId: 'party.registry',
          reason: 'Party Registry does not publish a Counterparty alias or canonicalization observation',
          retryable: true,
        }),
      ),
  });
