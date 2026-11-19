import { Schema } from 'effect';

import { DeliveryAttemptIdSchema, MessageIntentIdSchema } from '../../../shared/communication-intake.ts';
import { deterministicUuid } from '../intake/identity.ts';
import {
  ObservationEvidenceSchema,
  ProviderKeySchema,
  ProviderObservationKeySchema,
  ProviderRefSchema,
} from './vocabulary.ts';

/** The Tenant an observation CLAIMS to belong to: a claim to be checked against the verified scope, never a scope. */
export const ObservationTenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ProviderObservationTenantId'),
);

/**
 * A provider observation as step 22 hands it to Communications (#1402): the INPUT contract of the evidence, defined here so
 * the adapter has one exact shape to meet and Communications stays the only interpreter into the business vocabulary.
 *
 * It is keyed to exactly one (Tenant, intent, attempt) and to the provider's own identity of the event, and it carries the
 * minimal evidence only: what it proves and how it is known. It has no field for a provider payload, an address, markup or
 * a secret, so none can be passed. Step 22 owns how it obtains the evidence (callbacks, signatures, reconciliation transport);
 * nothing here requires open or read tracking, and without a real proof capability the correct history simply has no
 * delivery claim.
 */
export const ProviderObservationInputSchema = Schema.Struct({
  attemptId: DeliveryAttemptIdSchema,
  evidence: ObservationEvidenceSchema,
  intentId: MessageIntentIdSchema,
  /**
   * The provider's own identity of THIS event: the same event delivered again carries the same key. Together with the evidence
   * kind it is the identity of the observation: the same key and kind with another content is a CONFLICT, the same key with
   * another kind is a NEW observation.
   */
  observationKey: ProviderObservationKeySchema,
  /** When the provider says it happened. Informational only: it is part of the content, never the order of the timeline. */
  observedAt: Schema.DateTimeUtcFromString,
  providerKey: ProviderKeySchema,
  /** The provider's opaque reference of the submission, when the event names it. */
  providerRef: Schema.optionalKey(ProviderRefSchema),
  /** The Tenant the observation CLAIMS; it is checked against the verified scope and never used to choose where it is stored. */
  tenantId: ObservationTenantIdSchema,
});
export type ProviderObservationInput = typeof ProviderObservationInputSchema.Type;

/**
 * The one row an observation identity can ever be: a repeated callback derives the same id. The evidence kind is part of the
 * identity, so one provider message id may carry an acceptance and, later, a bounce as two observations.
 */
export const observationIdOf = (input: ProviderObservationInput) =>
  deterministicUuid(
    'communications.provider-observation',
    [input.tenantId, input.attemptId, input.providerKey, input.observationKey, input.evidence.kind].join('|'),
  );
