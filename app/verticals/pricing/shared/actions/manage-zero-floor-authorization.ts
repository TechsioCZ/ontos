import { PricingZeroFloorAuthorizationSchema } from '@app/pricing-contracts/domain/line-composition';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Schema } from 'effect';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const positiveRevision = Schema.Int.check(Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }));
const sha256Fingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const ZeroFloorAuthorizationAcknowledgementPrincipalIdSchema = stableReference.pipe(
  Schema.brand('ZeroFloorAuthorizationAcknowledgementPrincipalId'),
  Schema.decodeTo(stableReference),
);

export const ManageZeroFloorAuthorizationReasonSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);

export const ManageableZeroFloorAuthorizationSchema = PricingZeroFloorAuthorizationSchema.check(
  Schema.makeFilter(({ effectivePeriod }) =>
    effectivePeriod.endsAt === undefined || effectivePeriod.startsAt < effectivePeriod.endsAt
      ? undefined
      : 'ZERO_FLOOR Authorization must use a non-empty half-open Effective Period',
  ),
);
export type ManageableZeroFloorAuthorization = typeof ManageableZeroFloorAuthorizationSchema.Type;

export const ZeroFloorAuthorizationGovernanceApprovalEvidenceSchema = Schema.Struct({
  approvalEvidenceRef: stableReference,
  approvalRevision: stableReference,
  approvedAt: PricingInstantSchema,
  approvedByPrincipalRef: stableReference,
  approvedEffectivePeriod: ManageableZeroFloorAuthorizationSchema.fields.effectivePeriod,
  authorityRef: stableReference,
  authorization: ManageableZeroFloorAuthorizationSchema,
  authorizationFingerprint: sha256Fingerprint,
  sellingLegalEntityId:
    ManageableZeroFloorAuthorizationSchema.fields.businessScope.fields.commercialScope.fields.sellingLegalEntityId,
  tenantId: ManageableZeroFloorAuthorizationSchema.fields.businessScope.fields.tenantId,
  validityPeriod: Schema.Struct({
    endsAt: PricingInstantSchema,
    startsAt: PricingInstantSchema,
  }),
}).check(
  Schema.makeFilter(
    ({
      approvalEvidenceRef,
      approvedByPrincipalRef,
      approvedEffectivePeriod,
      authorization,
      sellingLegalEntityId,
      tenantId,
      validityPeriod,
    }) => {
      if (
        approvalEvidenceRef !== authorization.governanceEvidence.approvalEvidenceRef ||
        approvedByPrincipalRef !== authorization.governanceEvidence.approvedByPrincipalRef ||
        tenantId !== authorization.businessScope.tenantId ||
        sellingLegalEntityId !== authorization.businessScope.commercialScope.sellingLegalEntityId ||
        approvedEffectivePeriod.startsAt !== authorization.effectivePeriod.startsAt ||
        approvedEffectivePeriod.endsAt !== authorization.effectivePeriod.endsAt
      ) {
        return 'ZERO_FLOOR governance approval evidence must bind the exact Authorization and owner scope';
      }
      return validityPeriod.startsAt < validityPeriod.endsAt
        ? undefined
        : 'ZERO_FLOOR governance approval validity must be a non-empty half-open period';
    },
  ),
);
export const ExpectedZeroFloorAuthorizationCurrentSchema = Schema.Struct({
  authorizationRef: stableReference,
  authorizationRevision: stableReference,
  effectivePeriod: ManageableZeroFloorAuthorizationSchema.fields.effectivePeriod,
  scheduleRevision: positiveRevision,
});
export type ExpectedZeroFloorAuthorizationCurrent = typeof ExpectedZeroFloorAuthorizationCurrentSchema.Type;

export const ManagedZeroFloorAuthorizationRevisionSchema = Schema.Struct({
  authorization: ManageableZeroFloorAuthorizationSchema,
  lineage: Schema.Struct({
    correctedRevision: Schema.optionalKey(stableReference),
    predecessorRevision: Schema.optionalKey(stableReference),
    rootAuthorizationRef: stableReference,
    transition: Schema.Literals(['CREATED', 'SUCCESSOR', 'CORRECTED']),
  }),
  recordedAt: PricingInstantSchema,
  revisionNumber: positiveRevision,
  scheduleRevision: positiveRevision,
  scheduleState: Schema.optionalKey(Schema.Literals(['SCHEDULED', 'SUPERSEDED'])),
});
export type ManagedZeroFloorAuthorizationRevision = typeof ManagedZeroFloorAuthorizationRevisionSchema.Type;

export const ZeroFloorAuthorizationScheduleSnapshotSchema = Schema.Struct({
  authorizationRef: stableReference,
  revisions: Schema.Array(ManagedZeroFloorAuthorizationRevisionSchema).check(Schema.isMinLength(1)),
  scheduleRevision: positiveRevision,
  tenantId: ManageableZeroFloorAuthorizationSchema.fields.businessScope.fields.tenantId,
});
export type ZeroFloorAuthorizationScheduleSnapshot = typeof ZeroFloorAuthorizationScheduleSnapshotSchema.Type;

const acknowledgementCommonFields = {
  actingPrincipalId: ZeroFloorAuthorizationAcknowledgementPrincipalIdSchema,
  authorizationRef: stableReference,
  expectedSetGeneration: positiveRevision,
  fingerprint: sha256Fingerprint,
  issuedAt: PricingInstantSchema,
  presentedSchedule: ZeroFloorAuthorizationScheduleSnapshotSchema,
  presentedScheduleFingerprint: sha256Fingerprint,
  proposedPayloadFingerprint: sha256Fingerprint,
  tenantId: ManageableZeroFloorAuthorizationSchema.fields.businessScope.fields.tenantId,
  validUntil: PricingInstantSchema,
};

const acknowledgementIsCoherent = ({
  authorizationRef,
  issuedAt,
  presentedSchedule,
  tenantId,
  validUntil,
}: {
  readonly authorizationRef: string;
  readonly issuedAt: string;
  readonly presentedSchedule: ZeroFloorAuthorizationScheduleSnapshot;
  readonly tenantId: string;
  readonly validUntil: string;
}) => {
  if (presentedSchedule.authorizationRef !== authorizationRef || presentedSchedule.tenantId !== tenantId) {
    return 'ZERO_FLOOR schedule acknowledgement must bind the exact Tenant and Authorization schedule';
  }
  return issuedAt < validUntil
    ? undefined
    : 'ZERO_FLOOR schedule acknowledgement must have a non-empty trusted validity period';
};

const SuccessorZeroFloorAuthorizationScheduleAcknowledgementSchema = Schema.Struct({
  ...acknowledgementCommonFields,
  expectedCurrent: ExpectedZeroFloorAuthorizationCurrentSchema,
  intent: Schema.Literal('SUCCESSOR'),
  proposedAuthorization: ManageableZeroFloorAuthorizationSchema,
}).check(
  Schema.makeFilter(
    (acknowledgement) =>
      acknowledgementIsCoherent(acknowledgement) ??
      (acknowledgement.authorizationRef === acknowledgement.expectedCurrent.authorizationRef &&
      acknowledgement.authorizationRef === acknowledgement.proposedAuthorization.authorizationRef
        ? undefined
        : 'ZERO_FLOOR successor acknowledgement must bind the exact Current and proposed Authorization'),
  ),
);

const EndCurrentZeroFloorAuthorizationScheduleAcknowledgementSchema = Schema.Struct({
  ...acknowledgementCommonFields,
  effectiveTo: PricingInstantSchema,
  expectedCurrent: ExpectedZeroFloorAuthorizationCurrentSchema,
  intent: Schema.Literal('END_CURRENT'),
  proposedAuthorization: ManageableZeroFloorAuthorizationSchema,
}).check(
  Schema.makeFilter(
    (acknowledgement) =>
      acknowledgementIsCoherent(acknowledgement) ??
      (acknowledgement.authorizationRef === acknowledgement.expectedCurrent.authorizationRef &&
      acknowledgement.authorizationRef === acknowledgement.proposedAuthorization.authorizationRef
        ? undefined
        : 'ZERO_FLOOR retirement acknowledgement must bind the exact Current and proposed Authorization'),
  ),
);

const CorrectZeroFloorAuthorizationScheduleAcknowledgementSchema = Schema.Struct({
  ...acknowledgementCommonFields,
  expectedScheduleRevision: positiveRevision,
  intent: Schema.Literal('CORRECT_REVISION'),
  proposedAuthorization: ManageableZeroFloorAuthorizationSchema,
  targetRevision: stableReference,
}).check(
  Schema.makeFilter(
    (acknowledgement) =>
      acknowledgementIsCoherent(acknowledgement) ??
      (acknowledgement.authorizationRef === acknowledgement.proposedAuthorization.authorizationRef
        ? undefined
        : 'ZERO_FLOOR correction acknowledgement must bind the exact proposed Authorization'),
  ),
);

export const ZeroFloorAuthorizationScheduleAcknowledgementSchema = Schema.Union([
  CorrectZeroFloorAuthorizationScheduleAcknowledgementSchema,
  EndCurrentZeroFloorAuthorizationScheduleAcknowledgementSchema,
  SuccessorZeroFloorAuthorizationScheduleAcknowledgementSchema,
]);
export type ZeroFloorAuthorizationScheduleAcknowledgement =
  typeof ZeroFloorAuthorizationScheduleAcknowledgementSchema.Type;

const baseFields = {
  expectedSetGeneration: positiveRevision,
  reason: ManageZeroFloorAuthorizationReasonSchema,
};

const ApproveZeroFloorAuthorizationPayloadSchema = Schema.Struct({
  ...baseFields,
  approvalRevision: stableReference,
  authorization: ManageableZeroFloorAuthorizationSchema,
  intent: Schema.Literal('APPROVE'),
  validityPeriod: ZeroFloorAuthorizationGovernanceApprovalEvidenceSchema.fields.validityPeriod,
});

const CreateZeroFloorAuthorizationPayloadSchema = Schema.Struct({
  ...baseFields,
  authorization: ManageableZeroFloorAuthorizationSchema,
  intent: Schema.Literal('CREATE'),
});

const SuccessorZeroFloorAuthorizationPayloadSchema = Schema.Struct({
  ...baseFields,
  acknowledgement: Schema.optionalKey(ZeroFloorAuthorizationScheduleAcknowledgementSchema),
  authorization: ManageableZeroFloorAuthorizationSchema,
  expectedCurrent: ExpectedZeroFloorAuthorizationCurrentSchema,
  intent: Schema.Literal('SUCCESSOR'),
}).check(
  Schema.makeFilter(({ acknowledgement, authorization, expectedCurrent }) => {
    if (acknowledgement !== undefined && acknowledgement.intent !== 'SUCCESSOR') {
      return 'A ZERO_FLOOR successor acknowledgement must bind the SUCCESSOR intent';
    }
    if (authorization.authorizationRef !== expectedCurrent.authorizationRef) {
      return 'A ZERO_FLOOR successor must preserve the stable Authorization reference';
    }
    return authorization.effectivePeriod.startsAt >= expectedCurrent.effectivePeriod.startsAt
      ? undefined
      : 'A ZERO_FLOOR successor cannot begin before its expected Current predecessor';
  }),
);

const EndCurrentZeroFloorAuthorizationPayloadSchema = Schema.Struct({
  ...baseFields,
  acknowledgement: Schema.optionalKey(ZeroFloorAuthorizationScheduleAcknowledgementSchema),
  authorization: ManageableZeroFloorAuthorizationSchema,
  authorizationRef: stableReference,
  effectiveTo: PricingInstantSchema,
  expectedCurrent: ExpectedZeroFloorAuthorizationCurrentSchema,
  intent: Schema.Literal('END_CURRENT'),
}).check(
  Schema.makeFilter(({ acknowledgement, authorization, authorizationRef, effectiveTo, expectedCurrent }) => {
    if (acknowledgement !== undefined && acknowledgement.intent !== 'END_CURRENT') {
      return 'A ZERO_FLOOR retirement acknowledgement must bind the END_CURRENT intent';
    }
    if (
      authorizationRef !== expectedCurrent.authorizationRef ||
      authorization.authorizationRef !== expectedCurrent.authorizationRef ||
      authorization.authorizationRevision !== expectedCurrent.authorizationRevision ||
      authorization.effectivePeriod.startsAt !== expectedCurrent.effectivePeriod.startsAt ||
      authorization.effectivePeriod.endsAt !== expectedCurrent.effectivePeriod.endsAt
    ) {
      return 'ZERO_FLOOR retirement must bind the exact expected Current Authorization';
    }
    return effectiveTo > expectedCurrent.effectivePeriod.startsAt
      ? undefined
      : 'ZERO_FLOOR retirement must preserve a non-empty half-open Effective Period';
  }),
);

const CorrectZeroFloorAuthorizationPayloadSchema = Schema.Struct({
  ...baseFields,
  acknowledgement: Schema.optionalKey(ZeroFloorAuthorizationScheduleAcknowledgementSchema),
  authorization: ManageableZeroFloorAuthorizationSchema,
  expectedScheduleRevision: positiveRevision,
  intent: Schema.Literal('CORRECT_REVISION'),
  targetRevision: stableReference,
}).check(
  Schema.makeFilter(({ acknowledgement, authorization, targetRevision }) => {
    if (acknowledgement !== undefined && acknowledgement.intent !== 'CORRECT_REVISION') {
      return 'A ZERO_FLOOR correction acknowledgement must bind the CORRECT_REVISION intent';
    }
    return authorization.authorizationRevision === targetRevision
      ? 'A ZERO_FLOOR correction must create a new immutable Authorization Revision'
      : undefined;
  }),
);

export const ManageZeroFloorAuthorizationPayloadSchema = Schema.Union([
  ApproveZeroFloorAuthorizationPayloadSchema,
  CorrectZeroFloorAuthorizationPayloadSchema,
  CreateZeroFloorAuthorizationPayloadSchema,
  EndCurrentZeroFloorAuthorizationPayloadSchema,
  SuccessorZeroFloorAuthorizationPayloadSchema,
]);
export type ManageZeroFloorAuthorizationPayload = typeof ManageZeroFloorAuthorizationPayloadSchema.Type;

export const ManageZeroFloorAuthorizationResultSchema = Schema.Union([
  Schema.Struct({
    approvalEvidence: ZeroFloorAuthorizationGovernanceApprovalEvidenceSchema,
    outcome: Schema.Literals(['ZERO_FLOOR_GOVERNANCE_APPROVAL_RECORDED', 'ZERO_FLOOR_GOVERNANCE_APPROVAL_REUSED']),
    setGeneration: positiveRevision,
  }),
  Schema.Struct({
    outcome: Schema.Literals(['ZERO_FLOOR_AUTHORIZATION_CREATED', 'ZERO_FLOOR_AUTHORIZATION_REUSED']),
    revision: ManagedZeroFloorAuthorizationRevisionSchema,
    setGeneration: positiveRevision,
  }),
  Schema.Struct({
    outcome: Schema.Literals([
      'ZERO_FLOOR_AUTHORIZATION_SUCCEEDED',
      'ZERO_FLOOR_AUTHORIZATION_ENDED',
      'ZERO_FLOOR_AUTHORIZATION_CORRECTED',
      'ZERO_FLOOR_AUTHORIZATION_UNCHANGED',
    ]),
    schedule: ZeroFloorAuthorizationScheduleSnapshotSchema,
    setGeneration: positiveRevision,
  }),
]);
export type ManageZeroFloorAuthorizationResult = typeof ManageZeroFloorAuthorizationResultSchema.Type;
