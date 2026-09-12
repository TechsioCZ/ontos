import { Schema } from 'effect';
import {
  CommerceCustomerProfileStateSchema,
  ProfileInstantSchema,
  RECONCILIATION_REQUIRED_OWNERS,
  ReconciliationOwnerSchema,
  ReconciliationOwnerOutcomeSchema,
} from '../domain/profile-contracts.ts';
import { CommerceCustomerProfileRefSchema } from '../domain/profile-decisions.ts';
import { ProfileReconciliationCaseRefSchema } from '../resources/profile-reconciliation-case.ts';

const RevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const EventVersionSchema = Schema.BigIntFromString.check(Schema.isGreaterThanOrEqualToBigInt(0n));
const BoundedEvidenceSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const BoundedReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const ReconciliationIncompleteStateSchema = Schema.Literals(['OPEN', 'BLOCKED', 'READY_TO_COMPLETE']);
const TerminalReconciliationOwnerStatusSchema = Schema.Literals(['RESOLVED', 'NOT_APPLICABLE']);

const DesiredReconciliationOwnerOutcomeSchema = Schema.Struct({
  owner: ReconciliationOwnerSchema,
  status: TerminalReconciliationOwnerStatusSchema,
});

const ExactDesiredOwnerOutcomesSchema = Schema.Array(DesiredReconciliationOwnerOutcomeSchema).check(
  Schema.isMinLength(RECONCILIATION_REQUIRED_OWNERS.length),
  Schema.isMaxLength(RECONCILIATION_REQUIRED_OWNERS.length),
  Schema.makeFilter((outcomes) => {
    const owners = outcomes.map(({ owner }) => owner);
    return new Set(owners).size === RECONCILIATION_REQUIRED_OWNERS.length &&
      RECONCILIATION_REQUIRED_OWNERS.every((owner) => owners.includes(owner))
      ? undefined
      : 'Every reconciliation owner must have exactly one desired terminal outcome';
  }),
);

export const ResolveProfileReconciliationPayloadSchema = Schema.Struct({
  caseRef: ProfileReconciliationCaseRefSchema,
  effectiveAt: ProfileInstantSchema,
  expectedEventVersion: EventVersionSchema,
  expectedRevision: RevisionSchema,
  ownerOutcomes: ExactDesiredOwnerOutcomesSchema,
  reason: BoundedReasonSchema,
  resultingState: CommerceCustomerProfileStateSchema,
  survivorProfileRef: CommerceCustomerProfileRefSchema,
});
export type ResolveProfileReconciliationPayload = typeof ResolveProfileReconciliationPayloadSchema.Type;

export const ProfileReconciliationOwnerVerificationRequestSchema = Schema.Struct({
  caseRef: ProfileReconciliationCaseRefSchema,
  desiredOutcome: DesiredReconciliationOwnerOutcomeSchema,
  effectiveAt: ProfileInstantSchema,
  expectedCaseRevision: RevisionSchema,
  expectedEventVersion: EventVersionSchema,
  reason: BoundedReasonSchema,
  resultingState: CommerceCustomerProfileStateSchema,
  survivorProfileRef: CommerceCustomerProfileRefSchema,
});
export type ProfileReconciliationOwnerVerificationRequest =
  typeof ProfileReconciliationOwnerVerificationRequestSchema.Type;

const VerifiedReconciliationOwnerOutcomeSchema = Schema.Struct({
  evidenceRef: BoundedEvidenceSchema,
  owner: ReconciliationOwnerSchema,
  status: TerminalReconciliationOwnerStatusSchema,
});

export const ProfileReconciliationOwnerVerifiedSchema = Schema.TaggedStruct('VERIFIED', {
  correlationRef: BoundedEvidenceSchema,
  durableOutcome: VerifiedReconciliationOwnerOutcomeSchema,
});
export const ProfileReconciliationOwnerUnavailableSchema = Schema.TaggedStruct('UNAVAILABLE', {
  owner: ReconciliationOwnerSchema,
  reason: BoundedReasonSchema,
});
export const ProfileReconciliationOwnerConflictSchema = Schema.TaggedStruct('CONFLICT', {
  owner: ReconciliationOwnerSchema,
  reason: BoundedReasonSchema,
});
export const ProfileReconciliationOwnerVerificationSchema = Schema.Union([
  ProfileReconciliationOwnerVerifiedSchema,
  ProfileReconciliationOwnerUnavailableSchema,
  ProfileReconciliationOwnerConflictSchema,
]);
export type ProfileReconciliationOwnerVerification = typeof ProfileReconciliationOwnerVerificationSchema.Type;

const ExactDurableOwnerOutcomesSchema = Schema.Array(ReconciliationOwnerOutcomeSchema).check(
  Schema.isMinLength(RECONCILIATION_REQUIRED_OWNERS.length),
  Schema.isMaxLength(RECONCILIATION_REQUIRED_OWNERS.length),
  Schema.makeFilter((outcomes) => {
    const owners = outcomes.map(({ owner }) => owner);
    return new Set(owners).size === RECONCILIATION_REQUIRED_OWNERS.length &&
      RECONCILIATION_REQUIRED_OWNERS.every((owner) => owners.includes(owner))
      ? undefined
      : 'Durable reconciliation progress must contain every owner exactly once';
  }),
);

export const ProfileReconciliationDurableProgressSchema = Schema.Struct({
  caseRef: ProfileReconciliationCaseRefSchema,
  lastProcessedEventVersion: EventVersionSchema,
  ownerOutcomes: ExactDurableOwnerOutcomesSchema,
  revision: RevisionSchema,
  state: ReconciliationIncompleteStateSchema,
});
export type ProfileReconciliationDurableProgress = typeof ProfileReconciliationDurableProgressSchema.Type;

const ProfileReconciliationOwnerOutcomeRecordRequestSchema = Schema.Struct({
  caseRef: ProfileReconciliationCaseRefSchema,
  correlationRef: BoundedEvidenceSchema,
  durableOutcome: VerifiedReconciliationOwnerOutcomeSchema,
  effectiveAt: ProfileInstantSchema,
  expectedCaseRevision: RevisionSchema,
  expectedEventVersion: EventVersionSchema,
  reason: BoundedReasonSchema,
  resultingState: CommerceCustomerProfileStateSchema,
  survivorProfileRef: CommerceCustomerProfileRefSchema,
});
export type ProfileReconciliationOwnerOutcomeRecordRequest =
  typeof ProfileReconciliationOwnerOutcomeRecordRequestSchema.Type;

export const ReconciliationResolvedSchema = Schema.Struct({
  caseRef: ProfileReconciliationCaseRefSchema,
  outcome: Schema.Literal('RECONCILIATION_RESOLVED'),
  revision: RevisionSchema,
  state: Schema.Literal('COMPLETED'),
  survivorProfileRef: CommerceCustomerProfileRefSchema,
});
export type ReconciliationResolved = typeof ReconciliationResolvedSchema.Type;
const ReconciliationProgressRecordedSchema = Schema.Struct({
  caseRef: ProfileReconciliationCaseRefSchema,
  conflictingOwners: Schema.Array(ReconciliationOwnerSchema),
  lastProcessedEventVersion: EventVersionSchema,
  outcome: Schema.Literal('RECONCILIATION_PROGRESS_RECORDED'),
  ownerOutcomes: ExactDurableOwnerOutcomesSchema,
  revision: RevisionSchema,
  state: ReconciliationIncompleteStateSchema,
  unavailableOwners: Schema.Array(ReconciliationOwnerSchema),
});
export const ResolveProfileReconciliationResultSchema = Schema.Union([
  ReconciliationResolvedSchema,
  ReconciliationProgressRecordedSchema,
]);
export type ResolveProfileReconciliationResult = typeof ResolveProfileReconciliationResultSchema.Type;
