/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-string-timestamp-schema, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Schema } from 'effect';

const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u));

const Text = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const Ref = Text;
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const DeliveryAccessStateSchema = Schema.Literals(['CURRENT', 'REVOKED', 'EXPIRED', 'NOT_YET_ACTIVE']);
export type DeliveryAccessState = typeof DeliveryAccessStateSchema.Type;

/** A capability for one approved output and one verified recipient scope only. */
export const DsrDeliveryAccessSchema = Schema.Struct({
  accessId: Ref,
  authorityRef: Schema.optionalKey(Ref),
  caseRef: Ref,
  channel: Text,
  controllerRef: Ref,
  deliveryOutputRef: Ref,
  deliveryOutputRevision: Revision,
  deliveryScopeRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  effectiveFrom: Timestamp,
  evidenceRefs: Schema.optionalKey(Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32))),
  expiresAt: Timestamp,
  idempotencyKey: Ref,
  issuedAt: Timestamp,
  policyRef: Ref,
  receiptRef: Schema.optionalKey(Ref),
  recipientRef: Ref,
  representationRef: Ref,
  revocationReason: Schema.NullOr(Text),
  revokedAt: Schema.NullOr(Timestamp),
  supersedesAccessRef: Schema.NullOr(Ref),
});
export type DsrDeliveryAccess = typeof DsrDeliveryAccessSchema.Type;

export const DsrDeliveryAccessAuthorityResultSchema = Schema.Struct({
  access: DsrDeliveryAccessSchema,
  actionInvocationId: Ref,
  authorityRef: Ref,
  caseRef: Ref,
  controllerRef: Ref,
  evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  issuedAt: Timestamp,
  legalEntityId: Ref,
  receiptRef: Ref,
  tenantId: Ref,
});
export type DsrDeliveryAccessAuthorityResult = typeof DsrDeliveryAccessAuthorityResultSchema.Type;

export const DeliveryEvidenceOutcomeSchema = Schema.Literals([
  'SUCCESSFUL_DELIVERY',
  'KNOWN_FAILURE',
  'UNAUTHORIZED_ACCESS',
  'INDETERMINATE_HANDOFF',
]);
export type DeliveryEvidenceOutcome = typeof DeliveryEvidenceOutcomeSchema.Type;

export const DsrDeliveryEvidenceSchema = Schema.Struct({
  accessId: Ref,
  /** Legacy evidence may omit the Case; new writes require an exact open Case. */
  caseRef: Schema.optionalKey(Ref),
  channel: Text,
  deliveryOutputRef: Ref,
  deliveryOutputRevision: Revision,
  deliveryScopeRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  evidenceId: Ref,
  occurredAt: Timestamp,
  outcome: DeliveryEvidenceOutcomeSchema,
  policyRef: Ref,
  providerReference: Schema.NullOr(Ref),
  reason: Text,
  recipientRef: Ref,
  recordedAt: Timestamp,
  representationRef: Ref,
});
export type DsrDeliveryEvidence = typeof DsrDeliveryEvidenceSchema.Type;

/** Retention of temporary export bytes is intentionally separate from access lifetime. */
export const TemporaryDsrExportSchema = Schema.Struct({
  createdAt: Timestamp,
  deliveryOutputRef: Ref,
  deliveryOutputRevision: Revision,
  disposedAt: Schema.NullOr(Timestamp),
  dispositionEvidenceRef: Schema.NullOr(Ref),
  exportRef: Ref,
  retainUntil: Timestamp,
  storageRef: Ref,
});
export type TemporaryDsrExport = typeof TemporaryDsrExportSchema.Type;

export const getDeliveryAccessState = (access: DsrDeliveryAccess, at: string): DeliveryAccessState => {
  if (access.revokedAt !== null) {
    return 'REVOKED';
  }
  if (at < access.effectiveFrom) {
    return 'NOT_YET_ACTIVE';
  }
  if (at >= access.expiresAt) {
    return 'EXPIRED';
  }
  return 'CURRENT';
};

export interface DeliveryAccessRequest {
  readonly accessId: string;
  readonly caseRef: string;
  readonly channel: string;
  readonly controllerRef: string;
  readonly deliveryOutputRef: string;
  readonly deliveryOutputRevision: number;
  readonly deliveryScopeRefs: readonly string[];
  readonly effectiveFrom: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly issuedAt: string;
  readonly policyRef: string;
  readonly recipientRef: string;
  readonly representationRef: string;
  readonly supersedesAccessRef?: string;
}

export interface IssuedDeliveryAccess {
  readonly access: DsrDeliveryAccess;
  readonly revokedAccessRefs: readonly string[];
}

export const issueDeliveryAccess = (
  request: DeliveryAccessRequest,
  existing: readonly DsrDeliveryAccess[],
): IssuedDeliveryAccess => {
  const access: DsrDeliveryAccess = {
    ...request,
    deliveryScopeRefs: [...request.deliveryScopeRefs],
    revocationReason: null,
    revokedAt: null,
    supersedesAccessRef: request.supersedesAccessRef ?? null,
  };
  const revokedAccessRefs: string[] = [];
  for (const candidate of existing) {
    if (
      candidate.deliveryOutputRef === access.deliveryOutputRef &&
      candidate.revokedAt === null &&
      candidate.accessId !== access.accessId
    ) {
      revokedAccessRefs.push(candidate.accessId);
    }
  }
  return { access, revokedAccessRefs };
};

export const canUseDeliveryAccess = (input: {
  readonly access: DsrDeliveryAccess;
  readonly at: string;
  readonly caseRef: string;
  readonly channel: string;
  readonly controllerRef: string;
  readonly deliveryOutputRef: string;
  readonly deliveryOutputRevision: number;
  readonly deliveryScopeRefs: readonly string[];
  readonly policyRef: string;
  readonly recipientRef: string;
  readonly representationRef: string;
}): boolean => {
  if (getDeliveryAccessState(input.access, input.at) !== 'CURRENT') {
    return false;
  }
  if (
    input.access.caseRef !== input.caseRef ||
    input.access.controllerRef !== input.controllerRef ||
    input.access.channel !== input.channel ||
    input.access.policyRef !== input.policyRef ||
    input.access.deliveryOutputRef !== input.deliveryOutputRef ||
    input.access.deliveryOutputRevision !== input.deliveryOutputRevision
  ) {
    return false;
  }
  if (input.access.recipientRef !== input.recipientRef || input.access.representationRef !== input.representationRef) {
    return false;
  }
  const authorizedScopes = new Set(input.access.deliveryScopeRefs);
  return input.deliveryScopeRefs.every((scope) => authorizedScopes.has(scope));
};

export const isSuccessfulDelivery = (evidence: DsrDeliveryEvidence): boolean =>
  evidence.outcome === 'SUCCESSFUL_DELIVERY';
