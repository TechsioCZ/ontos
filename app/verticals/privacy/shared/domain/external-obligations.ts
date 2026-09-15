/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-string-timestamp-schema, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Schema } from 'effect';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u));

export const ExternalPrivacyRoleSchema = Schema.Literals(['CONTROLLER', 'PROCESSOR', 'RECIPIENT']);
export type ExternalPrivacyRole = typeof ExternalPrivacyRoleSchema.Type;

export const ExternalObligationStatusSchema = Schema.Literals([
  'PENDING',
  'ACHIEVED',
  'PARTIAL',
  'BUSINESS_REJECTED',
  'NOT_APPLICABLE',
  'FAILED',
  'BLOCKED',
  'INDETERMINATE',
]);
export type ExternalObligationStatus = typeof ExternalObligationStatusSchema.Type;

export const ExternalDeliveryStatusSchema = Schema.Literals([
  'NOT_REQUIRED',
  'PENDING',
  'SENT',
  'ACKNOWLEDGED',
  'FAILED',
  'INDETERMINATE',
]);
export type ExternalDeliveryStatus = typeof ExternalDeliveryStatusSchema.Type;

export const ExternalRoleHolderSchema = Schema.Struct({
  role: ExternalPrivacyRoleSchema,
  /** A real role holder reference, never an External Business System or route. */
  holderKnown: Schema.Boolean,
  holderRef: Schema.NullOr(Ref),
  unknownReason: Schema.NullOr(Ref),
});
export type ExternalRoleHolder = typeof ExternalRoleHolderSchema.Type;

export const ExternalObligationSchema = Schema.Struct({
  measureId: Ref,
  obligationId: Ref,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  roleHolder: ExternalRoleHolderSchema,
  sourceDecisionRef: Ref,
  sourceDecisionRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  subjectRef: Ref,
  tenantId: Ref,
  /** Original processing/disclosure relation, retained across route changes. */
  affectedScopeRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  createdAt: Timestamp,
  evidenceRefs: Schema.Array(Ref).check(Schema.isMaxLength(128)),
  executionStatus: ExternalObligationStatusSchema,
  forwardingStatus: ExternalDeliveryStatusSchema,
  notificationStatus: ExternalDeliveryStatusSchema,
  processingRelationshipRef: Ref,
  provenanceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  reason: Schema.NullOr(Ref),
  requiredResult: Ref,
  updatedAt: Timestamp,
});
export type ExternalObligation = typeof ExternalObligationSchema.Type;

export interface ExternalObligationSet {
  readonly complete: boolean;
  readonly obligations: readonly ExternalObligation[];
  readonly unresolvedObligationIds: readonly string[];
}

const terminalExecution = new Set<ExternalObligationStatus>(['ACHIEVED', 'BUSINESS_REJECTED', 'NOT_APPLICABLE']);
const deliveryComplete = (status: ExternalDeliveryStatus): boolean =>
  status === 'NOT_REQUIRED' || status === 'ACKNOWLEDGED';

class ExternalObligationInvariantError extends Schema.TaggedError<ExternalObligationInvariantError>()(
  'ExternalObligationInvariantError',
  { reason: Schema.String },
) {}

/**
 * Builds the external obligation ledger from already proven processing
 * relationships. Provider transport and mapping stay with the owning adapter.
 */
export const createExternalObligation = (input: ExternalObligation): ExternalObligation => {
  if (input.affectedScopeRefs.length === 0) {
    throw new ExternalObligationInvariantError({ reason: 'External obligation requires an affected scope' });
  }
  if (input.provenanceRefs.length === 0) {
    throw new ExternalObligationInvariantError({ reason: 'External obligation requires provenance' });
  }
  if (input.roleHolder.holderKnown !== (input.roleHolder.holderRef !== null)) {
    throw new ExternalObligationInvariantError({ reason: 'Role-holder identity must be explicit' });
  }
  if (!input.roleHolder.holderKnown && input.roleHolder.unknownReason === null) {
    throw new ExternalObligationInvariantError({ reason: 'Unknown role holder requires a reason' });
  }
  if (input.roleHolder.holderKnown && input.roleHolder.unknownReason !== null) {
    throw new ExternalObligationInvariantError({ reason: 'Known role holder cannot carry unknown reason' });
  }
  return {
    ...input,
    affectedScopeRefs: [...new Set(input.affectedScopeRefs)],
    evidenceRefs: [...new Set(input.evidenceRefs)],
    provenanceRefs: [...new Set(input.provenanceRefs)],
  };
};

/** Notification/forwarding receipts never promote execution to a completed outcome. */
export const assessExternalObligations = (obligations: readonly ExternalObligation[]): ExternalObligationSet => {
  const unresolved: string[] = [];
  for (const obligation of obligations) {
    if (
      !obligation.roleHolder.holderKnown ||
      !terminalExecution.has(obligation.executionStatus) ||
      !deliveryComplete(obligation.notificationStatus) ||
      !deliveryComplete(obligation.forwardingStatus)
    ) {
      unresolved.push(obligation.obligationId);
    }
  }
  return {
    complete: obligations.length > 0 && unresolved.length === 0,
    obligations: [...obligations],
    unresolvedObligationIds: unresolved,
  };
};

/** A route/provider change updates transport provenance, not business identity. */
export const updateExternalObligationDelivery = (
  obligation: ExternalObligation,
  update: Pick<ExternalObligation, 'notificationStatus' | 'forwardingStatus' | 'evidenceRefs' | 'reason' | 'updatedAt'>,
): ExternalObligation => ({
  ...obligation,
  ...update,
  evidenceRefs: [...new Set(update.evidenceRefs)],
  revision: obligation.revision + 1,
});
