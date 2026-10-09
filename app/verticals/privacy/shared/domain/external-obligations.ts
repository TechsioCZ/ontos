import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { Schema } from 'effect';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Timestamp = PrivacyIsoTimestampSchema;

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
  holderRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  unknownReason: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
});
export type ExternalRoleHolder = typeof ExternalRoleHolderSchema.Type;

export const ExternalObligationSchema = Schema.Struct({
  measureId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacyMeasureId'))),
  obligationId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacyObligationId'))),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  roleHolder: ExternalRoleHolderSchema,
  sourceDecisionRef: Ref,
  sourceDecisionRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  subjectRef: Ref,
  tenantId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacyTenantId'))),
  /** Original processing/disclosure relation, retained across route changes. */
  affectedScopeRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  createdAt: Timestamp,
  evidenceRefs: Schema.Array(Ref).check(Schema.isMaxLength(128)),
  executionStatus: ExternalObligationStatusSchema,
  forwardingStatus: ExternalDeliveryStatusSchema,
  notificationStatus: ExternalDeliveryStatusSchema,
  processingRelationshipRef: Ref,
  provenanceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  reason: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
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
