import type { DateTime } from 'effect';

import type { DeliveryAttemptIdSchema, MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import { ObservationTenantIdSchema } from '../../src/domain/history/provider-observation.ts';
import type { ProviderObservationInput } from '../../src/domain/history/provider-observation.ts';
import {
  ProviderKeySchema,
  ProviderObservationKeySchema,
  ProviderRefSchema,
} from '../../src/domain/history/vocabulary.ts';
import type { FailureClass } from '../../src/domain/history/vocabulary.ts';

/**
 * TEST DOUBLE of the evidence step 22 will hand to Communications (#1402). It builds the SHAPE of a provider observation and
 * nothing more: no provider, no webhook, no signature and no reconciliation transport exists in this lane. Every DELIVERED
 * path that uses `delivered` is CONDITIONAL on step 22 proving that its provider can evidence delivery at all; without that
 * capability the correct history has no delivery claim, which the tests also prove.
 */
export const FIXTURE_PROVIDER = 'fixture-provider';

/** The exact (Tenant, intent, attempt) an observation claims to be about. */
export interface ObservationTarget {
  readonly attemptId: typeof DeliveryAttemptIdSchema.Type;
  readonly intentId: typeof MessageIntentIdSchema.Type;
  readonly tenantId: string;
}

export interface ObservationDetails {
  /** The provider's own identity of the event. */
  readonly key: string;
  readonly observedAt: DateTime.Utc;
  readonly providerKey?: string | undefined;
  readonly providerRef?: string | undefined;
}

const common = (target: ObservationTarget, details: ObservationDetails) => ({
  attemptId: target.attemptId,
  intentId: target.intentId,
  observationKey: ProviderObservationKeySchema.make(details.key),
  observedAt: details.observedAt,
  providerKey: ProviderKeySchema.make(details.providerKey ?? FIXTURE_PROVIDER),
  tenantId: ObservationTenantIdSchema.make(target.tenantId),
});

const withEvidence = (
  target: ObservationTarget,
  details: ObservationDetails,
  evidence: ProviderObservationInput['evidence'],
): ProviderObservationInput => {
  const base = { ...common(target, details), evidence };
  return details.providerRef === undefined
    ? base
    : { ...base, providerRef: ProviderRefSchema.make(details.providerRef) };
};

export const step22Double = {
  /** An acceptance the provider (or a reconciliation) proves for an attempt whose own answer was unknown. */
  acceptanceProven: (
    target: ObservationTarget,
    details: ObservationDetails,
    basis: 'PROVIDER_EVENT' | 'RECONCILIATION' = 'RECONCILIATION',
  ) => withEvidence(target, details, { basis, kind: 'ACCEPTANCE_PROVEN' }),
  /** A bounce or a drop after the provider accepted the submission. */
  bounced: (target: ObservationTarget, details: ObservationDetails, failureClass: FailureClass = 'BOUNCED_PERMANENT') =>
    withEvidence(target, details, { basis: 'PROVIDER_EVENT', failureClass, kind: 'DELIVERY_FAILED' }),
  /** CONDITIONAL on a real step 22 delivery proof capability: delivery of THIS message, evidenced by a provider event. */
  delivered: (target: ObservationTarget, details: ObservationDetails) =>
    withEvidence(target, details, { basis: 'PROVIDER_EVENT', kind: 'DELIVERY_PROVEN' }),
  /** A reconciliation that proved the provider did NOT accept the submission. */
  nonAcceptanceProven: (target: ObservationTarget, details: ObservationDetails) =>
    withEvidence(target, details, { basis: 'RECONCILIATION', kind: 'NON_ACCEPTANCE_PROVEN' }),
};
