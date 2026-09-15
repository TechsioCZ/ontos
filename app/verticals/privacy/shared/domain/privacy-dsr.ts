import { DateTime, Effect, Option, Schema } from 'effect';

import { isSuccessfulDelivery } from './dsr-delivery-access.ts';
import type { DsrDeliveryEvidence } from './dsr-delivery-access.ts';
import {
  arePrivacyInstantsEqual,
  comparePrivacyInstants,
  isPrivacyInstantAfter,
  isPrivacyInstantAtOrBefore,
  isPrivacyInstantBefore,
  PrivacyIsoTimestampSchema,
} from './privacy-subject.ts';

const Timestamp = PrivacyIsoTimestampSchema;
const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Refs = Schema.Array(Ref).check(Schema.isMaxLength(128));
const UniqueRefs = Refs.pipe(
  Schema.check(
    Schema.makeFilter((refs) => (new Set(refs).size === refs.length ? undefined : 'DSR references must be unique')),
  ),
);
const NonEmptyUniqueRefs = UniqueRefs.pipe(Schema.check(Schema.isMinLength(1)));
const ExactScopeRefs = Refs.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(
    Schema.makeFilter((refs) =>
      new Set(refs).size === refs.length ? undefined : 'DSR exact scope references must be unique',
    ),
  ),
);
const IdempotencyKey = Ref.pipe(Schema.brand('IdempotencyKey'));
const OwnerModuleId = Ref.pipe(Schema.brand('OwnerModuleId'));
const LegalEntityId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const TenantId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const DsrSubstantiveDecisionOutcomeSchema = Schema.Literals([
  'CONFLICT',
  'DENIED',
  'GRANTED',
  'PARTIALLY_GRANTED',
  'UNRESOLVED',
]);

export const DsrRightSchema = Schema.Literals([
  'ACCESS',
  'PORTABILITY',
  'RECTIFICATION',
  'ERASURE',
  'RESTRICTION',
  'OBJECTION',
]);
export type DsrRight = typeof DsrRightSchema.Type;

export const DsrRequesterSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('RESOLVED'), subjectRef: Ref }),
  Schema.Struct({ contactRef: Schema.optional(Ref), kind: Schema.Literal('UNRESOLVED') }),
]);
export type DsrRequester = typeof DsrRequesterSchema.Type;

export const DsrCaseStatusSchema = Schema.Literals([
  'RECEIVED',
  'IN_PROGRESS',
  'PARTIALLY_RESOLVED',
  'RESPONDED',
  'CLOSED',
]);
export type DsrCaseStatus = typeof DsrCaseStatusSchema.Type;

export const DsrVerificationScopeSchema = Schema.Literals(['INTAKE', 'SENSITIVE_LOOKUP', 'EXPORT', 'MUTATION']);
export type DsrVerificationScope = typeof DsrVerificationScopeSchema.Type;

export const DsrControllerObligationSchema = Schema.Struct({
  caseRef: Ref,
  controllerRef: Ref,
  /** The exact owner/content scope owed by this Controller for the Case. */
  exactScopeRefs: Schema.optionalKey(ExactScopeRefs),
  obligationRef: Ref,
  receiptBasisRef: Ref,
  receivedAt: Timestamp,
  requestedRights: Schema.Array(DsrRightSchema).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  status: Schema.Literals(['UNRESOLVED', 'OPEN', 'DECIDED', 'CLOSED']),
});
export type DsrControllerObligation = typeof DsrControllerObligationSchema.Type;

export const DsrCaseSchema = Schema.Struct({
  caseRef: Ref,
  controllerObligations: Schema.Array(DsrControllerObligationSchema).check(Schema.isMaxLength(64)),
  createdAt: Timestamp,
  originalReceivedAt: Timestamp,
  requestedRights: Schema.Array(DsrRightSchema).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  requester: DsrRequesterSchema,
  status: DsrCaseStatusSchema,
  subjectRefs: Refs,
  unresolvedParts: Refs,
});
export type DsrCase = typeof DsrCaseSchema.Type;

/** Public DSR updates may mutate lifecycle only; intake facts come from the stored Case. */
export const DsrCaseLifecycleMutationSchema = Schema.Struct({
  caseRef: Ref,
  status: DsrCaseStatusSchema,
});
export type DsrCaseLifecycleMutation = typeof DsrCaseLifecycleMutationSchema.Type;

export const DsrVerificationSchema = Schema.Struct({
  caseRef: Ref,
  evidenceRefs: Refs,
  expiresAt: Schema.OptionFromNullOr(Timestamp),
  method: Ref,
  outcome: Schema.Literals(['PENDING', 'VERIFIED', 'FAILED', 'EXPIRED']),
  scope: DsrVerificationScopeSchema,
  subjectRef: Ref,
  verificationRef: Ref,
  verifiedAt: Schema.OptionFromNullOr(Timestamp),
});
export type DsrVerification = typeof DsrVerificationSchema.Type;

/**
 * Versioned policy identity resolved for one Controller and receipt time. The
 * persistence port must resolve this from an authoritative catalog; there is no
 * process-wide fallback policy in the Launch deployment.
 */
export const DsrDeadlinePolicySchema = Schema.Struct({
  calendar: Schema.Literal('UTC_CALENDAR_MONTH'),
  months: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3)),
  policyRef: Ref,
  policyVersion: Ref,
});
export type DsrDeadlinePolicy = typeof DsrDeadlinePolicySchema.Type;

export const DsrResolverAssignmentSchema = Schema.Struct({
  assignedAt: Timestamp,
  assignmentRef: Ref,
  caseRef: Ref,
  controllerRef: Ref,
  outage: Schema.Boolean,
  resolverRef: Ref,
  supersedesAssignmentRef: Schema.OptionFromNullOr(Ref),
});
export type DsrResolverAssignment = typeof DsrResolverAssignmentSchema.Type;

export const DsrDeadlineSchema = Schema.Struct({
  calendar: Schema.Literal('UTC_CALENDAR_MONTH'),
  caseRef: Ref,
  controllerRef: Ref,
  deadlineAt: Timestamp,
  months: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3)),
  policyRef: Ref,
  policyVersion: Ref,
  receiptBasisRef: Ref,
  receivedAt: Timestamp,
});
export type DsrDeadline = typeof DsrDeadlineSchema.Type;

export const DsrSubstantiveDecisionSchema = Schema.Struct({
  /** Optional on legacy history; authoritative writes require all governance fields below. */
  authorityRef: Schema.optionalKey(Ref),
  caseRef: Ref,
  controllerRef: Ref,
  decidedAt: Timestamp,
  decisionEvidenceRefs: Refs,
  decisionRef: Ref,
  exactScopeRefs: Schema.optionalKey(ExactScopeRefs),
  outcome: DsrSubstantiveDecisionOutcomeSchema,
  ownerExecutionRequired: Schema.Boolean,
  policyRef: Schema.optionalKey(Ref),
  policyVersion: Schema.optionalKey(Ref),
  provenanceRef: Schema.optionalKey(Ref),
  reasonRef: Ref,
  right: DsrRightSchema,
});
export type DsrSubstantiveDecision = typeof DsrSubstantiveDecisionSchema.Type;

/** Public DSR input identifies the obligation and intent only. */
export const DsrSubstantiveDecisionRequestSchema = Schema.Struct({
  caseRef: Ref,
  controllerRef: Ref,
  decisionRef: Ref,
  exactScopeRefs: ExactScopeRefs,
  right: DsrRightSchema,
});
export type DsrSubstantiveDecisionRequest = typeof DsrSubstantiveDecisionRequestSchema.Type;

/** Complete decision emitted by a trusted policy/version/provenance authority. */
export const AuthoritativeDsrSubstantiveDecisionSchema = Schema.Struct({
  authorityRef: Ref,
  caseRef: Ref,
  controllerRef: Ref,
  decidedAt: Timestamp,
  decisionEvidenceRefs: Refs.pipe(Schema.check(Schema.isMinLength(1))),
  decisionRef: Ref,
  exactScopeRefs: ExactScopeRefs,
  outcome: DsrSubstantiveDecisionOutcomeSchema,
  ownerExecutionRequired: Schema.Boolean,
  policyRef: Ref,
  policyVersion: Ref,
  provenanceRef: Ref,
  reasonRef: Ref,
  right: DsrRightSchema,
});
export type AuthoritativeDsrSubstantiveDecision = typeof AuthoritativeDsrSubstantiveDecisionSchema.Type;

/** Private result proving the exact current decision identity and governance provenance. */
export const DsrSubstantiveDecisionAuthorityResultSchema = Schema.Struct({
  asOf: Timestamp,
  decision: AuthoritativeDsrSubstantiveDecisionSchema,
  legalEntityId: LegalEntityId,
  status: Schema.Literals(['CURRENT', 'STALE', 'CONFLICT', 'UNAVAILABLE']),
  tenantId: TenantId,
});
export type DsrSubstantiveDecisionAuthorityResult = typeof DsrSubstantiveDecisionAuthorityResultSchema.Type;

export const DsrOwnerTaskAuthorityProvenanceSchema = Schema.Struct({
  authorityRef: Ref,
  evidenceRefs: Refs.check(Schema.isMinLength(1)),
  receiptRef: Schema.OptionFromNullOr(Ref),
});
export type DsrOwnerTaskAuthorityProvenance = typeof DsrOwnerTaskAuthorityProvenanceSchema.Type;

export const DsrOwnerTaskSchema = Schema.Struct({
  authorityProvenance: Schema.optionalKey(DsrOwnerTaskAuthorityProvenanceSchema),
  caseRef: Ref,
  controllerRef: Ref,
  exactScopeRefs: ExactScopeRefs,
  idempotencyKey: IdempotencyKey,
  outcomeRef: Schema.OptionFromNullOr(Ref),
  ownerModuleId: OwnerModuleId,
  right: DsrRightSchema,
  status: Schema.Literals(['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'PARTIAL', 'INDETERMINATE', 'FAILED']),
  taskRef: Ref,
  /** Trusted repository currentness used to invalidate older final responses. */
  updatedAt: Schema.optionalKey(Timestamp),
});
export type DsrOwnerTask = typeof DsrOwnerTaskSchema.Type;

/** Public input identifies an owner task but cannot carry its execution state or receipt. */
export const DsrOwnerTaskRequestSchema = Schema.Struct({
  caseRef: Ref,
  controllerRef: Ref,
  exactScopeRefs: ExactScopeRefs,
  idempotencyKey: IdempotencyKey,
  ownerModuleId: OwnerModuleId,
  right: DsrRightSchema,
  taskRef: Ref,
});
export type DsrOwnerTaskRequest = typeof DsrOwnerTaskRequestSchema.Type;

/** Trusted owner evidence used to materialize the durable task state. */
export const DsrOwnerTaskAuthorityResultSchema = Schema.Struct({
  authorityRef: Ref,
  evidenceRefs: Refs.check(Schema.isMinLength(1)),
  legalEntityId: LegalEntityId,
  receiptRef: Schema.OptionFromNullOr(Ref),
  task: DsrOwnerTaskSchema,
  tenantId: TenantId,
});
export type DsrOwnerTaskAuthorityResult = typeof DsrOwnerTaskAuthorityResultSchema.Type;

/** One authoritative owner obligation. Each entry requires its own matching owner task. */
export const DsrOwnerInventoryEntrySchema = Schema.Struct({
  caseRef: Ref,
  controllerRef: Ref,
  exactScopeRefs: ExactScopeRefs,
  obligationRef: Ref,
  ownerModuleId: OwnerModuleId,
  right: DsrRightSchema,
});
export type DsrOwnerInventoryEntry = typeof DsrOwnerInventoryEntrySchema.Type;

/** Private Owner Inventory proof used for DSR closure; it is never caller-provided. */
export const DsrOwnerInventoryAuthorityResultSchema = Schema.Struct({
  authorityRef: Ref,
  caseRef: Ref,
  complete: Schema.Boolean,
  entries: Schema.Array(DsrOwnerInventoryEntrySchema).check(Schema.isMaxLength(128)),
  evidenceRefs: Refs.check(Schema.isMinLength(1)),
  legalEntityId: LegalEntityId,
  observedAt: Timestamp,
  revision: Ref,
  tenantId: TenantId,
});
export type DsrOwnerInventoryAuthorityResult = typeof DsrOwnerInventoryAuthorityResultSchema.Type;

export const DsrResponseSchema = Schema.Struct({
  caseRef: Ref,
  createdAt: Timestamp,
  decisionRefs: NonEmptyUniqueRefs,
  deliveryEvidenceRef: Schema.OptionFromNullOr(Ref),
  final: Schema.Boolean,
  responseRef: Ref,
  scopeRefs: ExactScopeRefs,
});
export type DsrResponse = typeof DsrResponseSchema.Type;

/** Public response input carries only references and intent; time is trusted materialization. */
export const DsrResponseRequestSchema = Schema.Struct({
  caseRef: Ref,
  decisionRefs: NonEmptyUniqueRefs,
  deliveryEvidenceRef: Schema.OptionFromNullOr(Ref),
  final: Schema.Boolean,
  responseRef: Ref,
  scopeRefs: ExactScopeRefs,
});
export type DsrResponseRequest = typeof DsrResponseRequestSchema.Type;

export const materializeDsrResponse = (
  request: DsrResponseRequest,
  createdAt: DsrResponse['createdAt'],
): DsrResponse => ({
  ...request,
  createdAt,
});

/** A later trusted delivery proof invalidates a final response unless it is the selected proof itself. */
export const isDsrDeliveryEvidenceNewerThanResponse = (
  response: DsrResponse,
  evidence: Pick<DsrDeliveryEvidence, 'caseRef' | 'evidenceId' | 'recordedAt'>,
): boolean =>
  evidence.caseRef === response.caseRef &&
  isPrivacyInstantAfter(evidence.recordedAt, response.createdAt) &&
  (Option.isNone(response.deliveryEvidenceRef) || evidence.evidenceId !== response.deliveryEvidenceRef.value);

export const DsrResolverResolutionSchema = Schema.Union([
  Schema.Struct({ assignment: DsrResolverAssignmentSchema, status: Schema.Literal('CURRENT') }),
  Schema.Struct({ status: Schema.Literals(['ABSENT', 'CONFLICT', 'UNAVAILABLE']) }),
]);
export type DsrResolverResolution = typeof DsrResolverResolutionSchema.Type;

export const DsrCaseSummarySchema = Schema.Struct({
  closeable: Schema.Boolean,
  completedOwnerTasks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  decidedObligations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  openObligations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  unresolvedParts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type DsrCaseSummary = typeof DsrCaseSummarySchema.Type;

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

export interface CreateDsrCaseInput {
  readonly caseRef: string;
  readonly controllerObligations?: readonly DsrControllerObligation[];
  readonly receivedAt: DsrCase['originalReceivedAt'];
  readonly requestedRights: readonly DsrRight[];
  readonly requester: DsrRequester;
  readonly subjectRefs?: readonly string[];
  readonly unresolvedParts?: readonly string[];
}

export const DsrControllerObligationRequestSchema = Schema.Struct({
  controllerRef: Ref,
  exactScopeRefs: ExactScopeRefs,
  obligationRef: Ref,
  requestedRights: Schema.Array(DsrRightSchema).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
});
export type DsrControllerObligationRequest = typeof DsrControllerObligationRequestSchema.Type;

export const DsrCaseRequestSchema = Schema.Struct({
  caseRef: Ref,
  controllerObligations: Schema.Array(DsrControllerObligationRequestSchema).check(Schema.isMaxLength(64)),
  intakeClaimRef: Ref,
  requestedRights: Schema.Array(DsrRightSchema).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  requester: DsrRequesterSchema,
  subjectRefs: Refs,
  unresolvedParts: Refs,
});
export type DsrCaseRequest = typeof DsrCaseRequestSchema.Type;

export const DsrControllerReceiptSchema = Schema.Struct({
  controllerRef: Ref,
  exactScopeRefs: ExactScopeRefs,
  obligationRef: Ref,
  receiptBasisRef: Ref,
  receivedAt: Timestamp,
  requestedRights: Schema.Array(DsrRightSchema).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
});
export type DsrControllerReceipt = typeof DsrControllerReceiptSchema.Type;

export const DsrIntakeReceiptSchema = Schema.Struct({
  caseRef: Ref,
  controllerReceipts: Schema.Array(DsrControllerReceiptSchema).check(Schema.isMaxLength(64)),
  intakeClaimRef: Ref,
  originalReceivedAt: Timestamp,
  requestedRights: Schema.Array(DsrRightSchema).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
});
export type DsrIntakeReceipt = typeof DsrIntakeReceiptSchema.Type;

export class DsrIntakeReceiptInvariantError extends Schema.TaggedError<DsrIntakeReceiptInvariantError>()(
  'DsrIntakeReceiptInvariantError',
  { reason: Schema.String },
) {}

const exactRefs = (left: readonly string[], right: readonly string[]): boolean => {
  const leftRefs = new Set(left);
  const rightRefs = new Set(right);
  return (
    leftRefs.size === left.length &&
    rightRefs.size === right.length &&
    leftRefs.size === rightRefs.size &&
    left.every((reference) => rightRefs.has(reference))
  );
};

export const sameDsrReferenceSet = exactRefs;

export const sameDsrExactScopeRefs = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean => left !== undefined && right !== undefined && exactRefs(left, right);

const validateDsrSubstantiveDecisionAuthorityStatus = (
  authority: DsrSubstantiveDecisionAuthorityResult,
): string | undefined =>
  authority.status === 'CURRENT'
    ? undefined
    : `DSR substantive decision authority is ${authority.status.toLowerCase()}`;

const validateDsrSubstantiveDecisionAuthorityContext = (
  authority: DsrSubstantiveDecisionAuthorityResult,
  tenantId: string,
  legalEntityId: string,
  asOf: string,
): string | undefined =>
  !arePrivacyInstantsEqual(authority.asOf, asOf) ||
  authority.tenantId !== tenantId ||
  authority.legalEntityId !== legalEntityId
    ? 'DSR substantive decision authority does not match the exact Tenant, Legal Entity, or as-of time'
    : undefined;

const validateDsrSubstantiveDecisionAuthorityDecisionIdentity = (
  request: DsrSubstantiveDecisionRequest,
  decision: AuthoritativeDsrSubstantiveDecision,
  asOf: string,
): string | undefined =>
  decision.caseRef !== request.caseRef ||
  decision.controllerRef !== request.controllerRef ||
  decision.decisionRef !== request.decisionRef ||
  decision.right !== request.right ||
  !sameDsrExactScopeRefs(decision.exactScopeRefs, request.exactScopeRefs) ||
  !arePrivacyInstantsEqual(decision.decidedAt, asOf)
    ? 'DSR substantive decision authority does not match the exact Case, Controller, right, scope, time, or provenance'
    : undefined;

const validateDsrSubstantiveDecisionAuthorityDecisionProvenance = (
  decision: AuthoritativeDsrSubstantiveDecision,
): string | undefined =>
  decision.authorityRef.length === 0 ||
  decision.policyRef.length === 0 ||
  decision.policyVersion.length === 0 ||
  decision.provenanceRef.length === 0 ||
  decision.reasonRef.length === 0 ||
  decision.decisionEvidenceRefs.length === 0 ||
  !sameDsrReferenceSet(decision.decisionEvidenceRefs, unique(decision.decisionEvidenceRefs))
    ? 'DSR substantive decision authority does not match the exact Case, Controller, right, scope, time, or provenance'
    : undefined;

/** Validates a policy decision returned by the private DSR governance seam. */
export const validateDsrSubstantiveDecisionAuthorityResult = (
  request: DsrSubstantiveDecisionRequest,
  authority: DsrSubstantiveDecisionAuthorityResult,
  tenantId: string,
  legalEntityId: string,
  asOf: string,
): string | undefined =>
  validateDsrSubstantiveDecisionAuthorityStatus(authority) ??
  validateDsrSubstantiveDecisionAuthorityContext(authority, tenantId, legalEntityId, asOf) ??
  validateDsrSubstantiveDecisionAuthorityDecisionIdentity(request, authority.decision, asOf) ??
  validateDsrSubstantiveDecisionAuthorityDecisionProvenance(authority.decision);

export const dsrCaseObligationRefs = (caseRecord: DsrCase): readonly string[] =>
  caseRecord.controllerObligations.map(({ obligationRef }) => obligationRef);

const sameDsrOwnerInventoryEntry = (left: DsrOwnerInventoryEntry, right: DsrOwnerInventoryEntry): boolean =>
  left.caseRef === right.caseRef &&
  left.controllerRef === right.controllerRef &&
  left.obligationRef === right.obligationRef &&
  left.ownerModuleId === right.ownerModuleId &&
  left.right === right.right &&
  sameDsrExactScopeRefs(left.exactScopeRefs, right.exactScopeRefs);

/** Checks the trusted inventory envelope before it can participate in closure. */
export const validateDsrOwnerInventoryAuthorityScope = (
  inventory: DsrOwnerInventoryAuthorityResult,
  caseRef: string,
  tenantId: string,
  legalEntityId: string,
  asOf?: string,
): string | undefined => {
  if (inventory.caseRef !== caseRef) {
    return 'DSR Owner Inventory does not match the exact Case';
  }
  if (inventory.tenantId !== tenantId || inventory.legalEntityId !== legalEntityId) {
    return 'DSR Owner Inventory does not match the trusted Tenant and Legal Entity';
  }
  if (!inventory.complete) {
    return 'DSR Owner Inventory is incomplete';
  }
  if (inventory.evidenceRefs.length === 0 || !exactRefs(inventory.evidenceRefs, unique(inventory.evidenceRefs))) {
    return 'DSR Owner Inventory evidence references must be non-empty and unique';
  }
  if (asOf !== undefined && !isPrivacyInstantAtOrBefore(inventory.observedAt, asOf)) {
    return 'DSR Owner Inventory was observed after the requested as-of time';
  }
  const hasDuplicateEntry = inventory.entries.some((entry, index) =>
    inventory.entries.slice(index + 1).some((candidate) => sameDsrOwnerInventoryEntry(entry, candidate)),
  );
  return hasDuplicateEntry ? 'DSR Owner Inventory entries must be unique' : undefined;
};

interface DsrObligationUnit {
  readonly caseRef: string;
  readonly controllerRef: string;
  readonly exactScopeRefs: readonly string[] | undefined;
  readonly obligationRef: string;
  readonly right: DsrRight;
}

const dsrObligationUnits = (caseRecord: DsrCase): readonly DsrObligationUnit[] =>
  caseRecord.controllerObligations.flatMap((obligation) =>
    obligation.requestedRights.map((right) => ({
      caseRef: obligation.caseRef,
      controllerRef: obligation.controllerRef,
      exactScopeRefs: obligation.exactScopeRefs,
      obligationRef: obligation.obligationRef,
      right,
    })),
  );

const ownerInventoryEntryMatchesObligation = (entry: DsrOwnerInventoryEntry, obligation: DsrObligationUnit): boolean =>
  entry.caseRef === obligation.caseRef &&
  entry.controllerRef === obligation.controllerRef &&
  entry.obligationRef === obligation.obligationRef &&
  entry.right === obligation.right &&
  sameDsrExactScopeRefs(entry.exactScopeRefs, obligation.exactScopeRefs);

interface ResolvedDsrObligation {
  readonly decisions: readonly DsrSubstantiveDecision[];
  readonly obligation: DsrObligationUnit;
}

const dsrObligationsAreComplete = (caseRecord: DsrCase, obligations: readonly DsrObligationUnit[]): boolean =>
  caseRecord.unresolvedParts.length === 0 &&
  obligations.length > 0 &&
  obligations.every(({ caseRef, exactScopeRefs }) => caseRef === caseRecord.caseRef && exactScopeRefs !== undefined);

export interface DsrSubstantiveDecisionIdentity {
  readonly caseRef: string;
  readonly controllerRef: string;
  readonly exactScopeRefs: readonly string[] | undefined;
  readonly right: DsrRight;
}

const decisionMatchesDsrObligation = (
  decision: DsrSubstantiveDecision,
  obligation: DsrSubstantiveDecisionIdentity,
): boolean =>
  decision.caseRef === obligation.caseRef &&
  decision.controllerRef === obligation.controllerRef &&
  decision.right === obligation.right &&
  sameDsrExactScopeRefs(decision.exactScopeRefs, obligation.exactScopeRefs);

export type DsrSubstantiveDecisionResolution =
  | { readonly decision: DsrSubstantiveDecision; readonly outcome: 'CURRENT' }
  | { readonly outcome: 'ABSENT' }
  | { readonly decisions: readonly DsrSubstantiveDecision[]; readonly outcome: 'CONFLICT' };

/**
 * Selects current substantive truth before inspecting its outcome. A later
 * UNRESOLVED or CONFLICT therefore blocks every older grant or denial.
 */
export const resolveCurrentDsrSubstantiveDecision = (
  decisions: readonly DsrSubstantiveDecision[],
  obligation: DsrSubstantiveDecisionIdentity,
  asOf?: string,
): DsrSubstantiveDecisionResolution => {
  const matching = decisions
    .filter(
      (decision) =>
        decisionMatchesDsrObligation(decision, obligation) &&
        (asOf === undefined || isPrivacyInstantAtOrBefore(decision.decidedAt, asOf)),
    )
    .toSorted((left, right) => comparePrivacyInstants(left.decidedAt, right.decidedAt) ?? 0);
  const latestAt = matching.at(-1)?.decidedAt;
  if (latestAt === undefined) {
    return { outcome: 'ABSENT' };
  }
  const latest = matching.filter(
    (decision) => latestAt !== undefined && arePrivacyInstantsEqual(decision.decidedAt, latestAt),
  );
  if (latest.length !== 1) {
    return { decisions: latest, outcome: 'CONFLICT' };
  }
  const [decision] = latest;
  return decision === undefined || decision.outcome === 'UNRESOLVED' || decision.outcome === 'CONFLICT'
    ? { decisions: latest, outcome: 'CONFLICT' }
    : { decision, outcome: 'CURRENT' };
};

const resolveDsrObligations = (
  obligations: readonly DsrObligationUnit[],
  decisions: readonly DsrSubstantiveDecision[],
  asOf?: string,
): readonly ResolvedDsrObligation[] =>
  obligations.map((obligation) => {
    const resolution = resolveCurrentDsrSubstantiveDecision(decisions, obligation, asOf);
    return {
      decisions: resolution.outcome === 'CURRENT' ? [resolution.decision] : [],
      obligation,
    };
  });

const substantiveCaseDecisionRefs = (
  decisions: readonly DsrSubstantiveDecision[],
  caseRef: string,
): readonly string[] => {
  const obligations: DsrSubstantiveDecisionIdentity[] = [];
  for (const decision of decisions.filter(({ caseRef: decisionCaseRef }) => decisionCaseRef === caseRef)) {
    if (
      !obligations.some(
        (obligation) =>
          obligation.controllerRef === decision.controllerRef &&
          obligation.right === decision.right &&
          sameDsrExactScopeRefs(obligation.exactScopeRefs, decision.exactScopeRefs),
      ) &&
      decision.exactScopeRefs !== undefined
    ) {
      obligations.push({
        caseRef: decision.caseRef,
        controllerRef: decision.controllerRef,
        exactScopeRefs: decision.exactScopeRefs,
        right: decision.right,
      });
    }
  }
  return obligations.flatMap((obligation) => {
    const resolution = resolveCurrentDsrSubstantiveDecision(decisions, obligation);
    return resolution.outcome === 'CURRENT' ? [resolution.decision.decisionRef] : [];
  });
};

const ownerExecutionObligations = (resolved: readonly ResolvedDsrObligation[]): readonly DsrObligationUnit[] => {
  const obligations: DsrObligationUnit[] = [];
  for (const { decisions, obligation } of resolved) {
    const [decision] = decisions;
    if (decision?.ownerExecutionRequired === true && ['GRANTED', 'PARTIALLY_GRANTED'].includes(decision.outcome)) {
      obligations.push(obligation);
    }
  }
  return obligations;
};

const ownerInventoryExactlyCovers = (
  inventory: DsrOwnerInventoryAuthorityResult,
  obligations: readonly DsrObligationUnit[],
): boolean =>
  inventory.entries.every((entry) =>
    obligations.some((obligation) => ownerInventoryEntryMatchesObligation(entry, obligation)),
  ) &&
  obligations.every((obligation) =>
    inventory.entries.some((entry) => ownerInventoryEntryMatchesObligation(entry, obligation)),
  );

/**
 * An authoritative inventory is a complete owner-to-obligation mapping. It
 * cannot add an obligation and it cannot omit the owner required by a granted
 * right. The owner identity is deliberately part of the mapping so one owner
 * cannot satisfy another owner's obligation.
 */
export const validateDsrOwnerInventoryForCase = (input: {
  readonly caseRecord: DsrCase;
  readonly decisions: readonly DsrSubstantiveDecision[];
  readonly inventory: DsrOwnerInventoryAuthorityResult;
}): string | undefined => {
  const inventoryError = validateDsrOwnerInventoryAuthorityScope(
    input.inventory,
    input.caseRecord.caseRef,
    input.inventory.tenantId,
    input.inventory.legalEntityId,
  );
  if (inventoryError !== undefined) {
    return inventoryError;
  }
  const obligations = dsrObligationUnits(input.caseRecord);
  if (!dsrObligationsAreComplete(input.caseRecord, obligations)) {
    return 'DSR Case does not contain complete exact Controller obligations';
  }
  const resolved = resolveDsrObligations(obligations, input.decisions);
  if (resolved.some(({ decisions }) => decisions.length !== 1)) {
    return 'DSR Case requires exactly one substantive decision per right and exact scope';
  }
  const resolvedDecisionRefs = resolved.flatMap(({ decisions }) => decisions.map(({ decisionRef }) => decisionRef));
  const caseDecisionRefs = substantiveCaseDecisionRefs(input.decisions, input.caseRecord.caseRef);
  if (!exactRefs(resolvedDecisionRefs, caseDecisionRefs)) {
    return 'DSR workflow contains a decision outside the exact Case obligations';
  }
  if (!ownerInventoryExactlyCovers(input.inventory, ownerExecutionObligations(resolved))) {
    return 'DSR Owner Inventory does not exactly cover every owner-execution obligation';
  }
  return undefined;
};

const sameOptionalRef = (left: Option.Option<string>, right: Option.Option<string>): boolean =>
  Option.match(left, {
    onNone: () => Option.isNone(right),
    onSome: (value) => Option.isSome(right) && right.value === value,
  });

export const materializeDsrOwnerTaskAuthorityProvenance = (
  authority: Pick<DsrOwnerTaskAuthorityResult, 'authorityRef' | 'evidenceRefs' | 'receiptRef'>,
): DsrOwnerTaskAuthorityProvenance => ({
  authorityRef: authority.authorityRef,
  evidenceRefs: [...authority.evidenceRefs],
  receiptRef: authority.receiptRef,
});

const sameAuthorityProvenance = (
  left: DsrOwnerTaskAuthorityProvenance,
  right: DsrOwnerTaskAuthorityProvenance,
): boolean =>
  left.authorityRef === right.authorityRef &&
  exactRefs(left.evidenceRefs, right.evidenceRefs) &&
  sameOptionalRef(left.receiptRef, right.receiptRef);

const dsrOwnerTaskAuthorityScopeMatches = (
  authority: DsrOwnerTaskAuthorityResult,
  tenantId: string,
  legalEntityId: string,
): boolean => authority.tenantId === tenantId && authority.legalEntityId === legalEntityId;

const dsrOwnerTaskIdentityMatches = (task: DsrOwnerTask, request: DsrOwnerTaskRequest): boolean =>
  task.caseRef === request.caseRef &&
  task.controllerRef === request.controllerRef &&
  exactRefs(task.exactScopeRefs, request.exactScopeRefs) &&
  task.idempotencyKey === request.idempotencyKey &&
  task.ownerModuleId === request.ownerModuleId &&
  task.right === request.right &&
  task.taskRef === request.taskRef;

const dsrOwnerTaskProvenanceMatches = (task: DsrOwnerTask, authority: DsrOwnerTaskAuthorityResult): boolean =>
  task.authorityProvenance === undefined ||
  sameAuthorityProvenance(task.authorityProvenance, materializeDsrOwnerTaskAuthorityProvenance(authority));

const dsrOwnerTaskReceiptMatches = (task: DsrOwnerTask, authority: DsrOwnerTaskAuthorityResult): boolean =>
  Option.match(task.outcomeRef, {
    onNone: () => Option.isNone(authority.receiptRef),
    onSome: (outcomeRef) => Option.isSome(authority.receiptRef) && authority.receiptRef.value === outcomeRef,
  });

const successfulDsrOwnerTaskHasReceipt = (task: DsrOwnerTask): boolean =>
  task.status !== 'SUCCEEDED' || Option.isSome(task.outcomeRef);

const successfulDsrOwnerTaskHasPersistedProvenance = (
  task: DsrOwnerTask,
  authority: DsrOwnerTaskAuthorityResult,
): boolean => task.status !== 'SUCCEEDED' || Option.isSome(authority.receiptRef);

const dsrOwnerTaskAuthorityEvidenceIsUnique = (authority: DsrOwnerTaskAuthorityResult): boolean =>
  exactRefs(authority.evidenceRefs, [...new Set(authority.evidenceRefs)]);

/** Closure may use only provenance that survived persistence with the task. */
export const hasValidDsrOwnerTaskAuthorityProvenance = (task: DsrOwnerTask): boolean => {
  const provenance = task.authorityProvenance;
  if (provenance === undefined || !exactRefs(provenance.evidenceRefs, [...new Set(provenance.evidenceRefs)])) {
    return false;
  }
  const outcomeMatchesReceipt = Option.match(task.outcomeRef, {
    onNone: () => Option.isNone(provenance.receiptRef),
    onSome: (outcomeRef) => Option.isSome(provenance.receiptRef) && provenance.receiptRef.value === outcomeRef,
  });
  return outcomeMatchesReceipt && (task.status !== 'SUCCEEDED' || Option.isSome(provenance.receiptRef));
};

/** Validates an owner task receipt before it can affect DSR closure. */
export const validateDsrOwnerTaskAuthorityResult = (
  request: DsrOwnerTaskRequest,
  authority: DsrOwnerTaskAuthorityResult,
  tenantId: string,
  legalEntityId: string,
): string | undefined => {
  const { task } = authority;
  if (!dsrOwnerTaskAuthorityScopeMatches(authority, tenantId, legalEntityId)) {
    return 'DSR owner task authority does not match the trusted Tenant and Legal Entity';
  }
  if (!dsrOwnerTaskIdentityMatches(task, request)) {
    return 'DSR owner task authority does not match the exact Case, owner, task, right, or scope';
  }
  if (!dsrOwnerTaskProvenanceMatches(task, authority)) {
    return 'DSR owner task authority provenance does not match the trusted owner result';
  }
  if (!dsrOwnerTaskReceiptMatches(task, authority)) {
    return 'DSR owner task outcome receipt is not the exact trusted owner receipt';
  }
  if (!successfulDsrOwnerTaskHasReceipt(task)) {
    return 'A successful DSR owner task requires a trusted owner receipt';
  }
  if (!successfulDsrOwnerTaskHasPersistedProvenance(task, authority)) {
    return 'A successful DSR owner task requires persisted owner receipt provenance';
  }
  if (!dsrOwnerTaskAuthorityEvidenceIsUnique(authority)) {
    return 'DSR owner task authority evidence references must be unique';
  }
  return undefined;
};

export const materializeDsrCaseFromReceipt = (
  request: DsrCaseRequest,
  receipt: DsrIntakeReceipt,
): Effect.Effect<DsrCase, DsrIntakeReceiptInvariantError> => {
  const requestedByObligation = new Map(
    request.controllerObligations.map((obligation) => [
      `${obligation.controllerRef}\u0000${obligation.obligationRef}`,
      obligation,
    ]),
  );
  const receivedKeys = receipt.controllerReceipts.map(
    (controllerReceipt) => `${controllerReceipt.controllerRef}\u0000${controllerReceipt.obligationRef}`,
  );
  const exactCorrelation =
    receipt.caseRef === request.caseRef &&
    receipt.intakeClaimRef === request.intakeClaimRef &&
    exactRefs(receipt.requestedRights, request.requestedRights) &&
    requestedByObligation.size === request.controllerObligations.length &&
    new Set(receivedKeys).size === receipt.controllerReceipts.length &&
    receivedKeys.length === requestedByObligation.size &&
    receipt.controllerReceipts.every((controllerReceipt) => {
      const requested = requestedByObligation.get(
        `${controllerReceipt.controllerRef}\u0000${controllerReceipt.obligationRef}`,
      );
      return (
        requested !== undefined &&
        sameDsrExactScopeRefs(controllerReceipt.exactScopeRefs, requested.exactScopeRefs) &&
        exactRefs(controllerReceipt.requestedRights, requested.requestedRights)
      );
    });
  if (!exactCorrelation) {
    return Effect.fail(
      new DsrIntakeReceiptInvariantError({
        reason: 'DSR intake receipt does not match the exact Case, Controller obligations, and requested rights',
      }),
    );
  }
  return Effect.succeed({
    caseRef: request.caseRef,
    controllerObligations: receipt.controllerReceipts.map((controllerReceipt) => ({
      caseRef: request.caseRef,
      controllerRef: controllerReceipt.controllerRef,
      exactScopeRefs: controllerReceipt.exactScopeRefs,
      obligationRef: controllerReceipt.obligationRef,
      receiptBasisRef: controllerReceipt.receiptBasisRef,
      receivedAt: controllerReceipt.receivedAt,
      requestedRights: controllerReceipt.requestedRights,
      status: 'OPEN',
    })),
    createdAt: receipt.originalReceivedAt,
    originalReceivedAt: receipt.originalReceivedAt,
    requestedRights: unique(request.requestedRights),
    requester: request.requester,
    status: 'RECEIVED',
    subjectRefs: unique(request.subjectRefs),
    unresolvedParts: unique(request.unresolvedParts),
  });
};

/** Intake preserves unresolved identity and never creates Party, account, binding, or Permission. */
export const createDsrCase = (input: CreateDsrCaseInput): DsrCase => ({
  caseRef: input.caseRef,
  controllerObligations: [...(input.controllerObligations ?? [])],
  createdAt: input.receivedAt,
  originalReceivedAt: input.receivedAt,
  requestedRights: unique(input.requestedRights),
  requester: input.requester,
  status: 'RECEIVED',
  subjectRefs: unique(input.subjectRefs ?? []),
  unresolvedParts: unique(input.unresolvedParts ?? []),
});

const addUtcCalendarMonths = (receivedAt: string, months: number): string =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(receivedAt), { months }));

/** Each Controller gets its own deadline; reassignment never changes the original receipt time. */
export const calculateDsrDeadline = (input: {
  readonly caseRef: string;
  readonly controllerRef: string;
  readonly originalReceivedAt: DsrCase['originalReceivedAt'];
  readonly policy: DsrDeadlinePolicy;
  readonly receiptBasisRef: string;
}): DsrDeadline => ({
  calendar: input.policy.calendar,
  caseRef: input.caseRef,
  controllerRef: input.controllerRef,
  deadlineAt: addUtcCalendarMonths(input.originalReceivedAt, input.policy.months),
  months: input.policy.months,
  policyRef: input.policy.policyRef,
  policyVersion: input.policy.policyVersion,
  receiptBasisRef: input.receiptBasisRef,
  receivedAt: input.originalReceivedAt,
});

export const canCloseDsrCase = (
  caseRecord: DsrCase,
  decisions: readonly DsrSubstantiveDecision[],
  tasks: readonly DsrOwnerTask[],
  ownerInventory?: DsrOwnerInventoryAuthorityResult,
): boolean => {
  if (ownerInventory === undefined) {
    return false;
  }
  if (validateDsrOwnerInventoryForCase({ caseRecord, decisions, inventory: ownerInventory }) !== undefined) {
    return false;
  }
  const ownerObligations = dsrObligationUnits(caseRecord).filter((obligation) =>
    ownerInventory.entries.some((entry) => ownerInventoryEntryMatchesObligation(entry, obligation)),
  );
  const usedTaskRefs = new Set<string>();
  return ownerObligations.every((obligation) =>
    ownerInventory.entries
      .filter((entry) => ownerInventoryEntryMatchesObligation(entry, obligation))
      .every((entry) => {
        const matchingTasks = tasks.filter(
          (task) =>
            task.caseRef === entry.caseRef &&
            task.controllerRef === entry.controllerRef &&
            task.ownerModuleId === entry.ownerModuleId &&
            task.right === entry.right &&
            sameDsrExactScopeRefs(task.exactScopeRefs, entry.exactScopeRefs),
        );
        const [task] = matchingTasks;
        if (
          matchingTasks.length !== 1 ||
          task === undefined ||
          usedTaskRefs.has(task.taskRef) ||
          task.status !== 'SUCCEEDED' ||
          Option.isNone(task.outcomeRef) ||
          !hasValidDsrOwnerTaskAuthorityProvenance(task)
        ) {
          return false;
        }
        usedTaskRefs.add(task.taskRef);
        return true;
      }),
  );
};

/**
 * A Case is append-only after closure. Reopen needs a separately governed
 * contract so an ordinary lifecycle update cannot erase a completed response.
 */
export const validateDsrCaseLifecycleTransition = (
  fromStatus: DsrCaseStatus,
  _toStatus: DsrCaseStatus,
): string | undefined =>
  fromStatus === 'CLOSED' ? 'CLOSED DSR Cases are terminal and cannot be reopened by a lifecycle update' : undefined;

export const applyDsrCaseLifecycleMutation = (caseRecord: DsrCase, mutation: DsrCaseLifecycleMutation): DsrCase => ({
  ...caseRecord,
  status: mutation.status,
});

/** Verification authorizes only the named Case operation; it never creates identity or Permission. */
export const canPerformSensitiveDsrOperation = (input: {
  readonly at: DsrCase['originalReceivedAt'];
  readonly caseRef: string;
  readonly requiredScope: DsrVerification['scope'];
  readonly subjectRef: string;
  readonly verification: DsrVerification;
}): boolean =>
  input.verification.caseRef === input.caseRef &&
  input.verification.subjectRef === input.subjectRef &&
  input.verification.scope === input.requiredScope &&
  input.verification.outcome === 'VERIFIED' &&
  Option.match(input.verification.expiresAt, {
    onNone: () => true,
    onSome: (expiresAt) => isPrivacyInstantBefore(input.at, expiresAt),
  });

export const isDsrDecisionForObligation = (
  decision: DsrSubstantiveDecision,
  obligation: DsrControllerObligation,
): boolean =>
  decision.caseRef === obligation.caseRef &&
  decision.controllerRef === obligation.controllerRef &&
  obligation.requestedRights.includes(decision.right) &&
  sameDsrExactScopeRefs(decision.exactScopeRefs, obligation.exactScopeRefs);

/** Technical owner work may follow only a substantive grant, never a transport success or intake. */
export const canDispatchDsrOwnerTask = (decision: DsrSubstantiveDecision): boolean =>
  decision.ownerExecutionRequired && ['GRANTED', 'PARTIALLY_GRANTED'].includes(decision.outcome);

const resolverAssignmentsByRef = (
  matching: readonly DsrResolverAssignment[],
): Map<string, DsrResolverAssignment> | undefined => {
  const byRef = new Map<string, DsrResolverAssignment>();
  for (const assignment of matching) {
    if (byRef.has(assignment.assignmentRef)) {
      return undefined;
    }
    byRef.set(assignment.assignmentRef, assignment);
  }
  return byRef;
};

const supersededResolverAssignments = (
  matching: readonly DsrResolverAssignment[],
  byRef: ReadonlyMap<string, DsrResolverAssignment>,
): Set<string> | undefined => {
  const superseded = new Set<string>();
  for (const assignment of matching) {
    if (Option.isNone(assignment.supersedesAssignmentRef)) {
      continue;
    }
    const supersededAssignment = byRef.get(assignment.supersedesAssignmentRef.value);
    if (
      supersededAssignment === undefined ||
      supersededAssignment.assignmentRef === assignment.assignmentRef ||
      (comparePrivacyInstants(supersededAssignment.assignedAt, assignment.assignedAt) ?? 1) >= 0
    ) {
      return undefined;
    }
    superseded.add(supersededAssignment.assignmentRef);
  }
  return superseded;
};

const resolveCurrentDsrResolverFromMatching = (matching: readonly DsrResolverAssignment[]): DsrResolverResolution => {
  const byRef = resolverAssignmentsByRef(matching);
  if (byRef === undefined) {
    return { status: 'CONFLICT' };
  }
  const superseded = supersededResolverAssignments(matching, byRef);
  if (superseded === undefined) {
    return { status: 'CONFLICT' };
  }

  const current = matching.filter((assignment) => !superseded.has(assignment.assignmentRef));
  if (current.length !== 1) {
    return { status: 'CONFLICT' };
  }
  const [assignment] = current;
  if (assignment === undefined) {
    return { status: 'CONFLICT' };
  }
  return assignment.outage ? { status: 'UNAVAILABLE' } : { assignment, status: 'CURRENT' };
};

export const resolveCurrentDsrResolver = (
  assignments: readonly DsrResolverAssignment[],
  caseRef: string,
  controllerRef: string,
  asOf: string,
): DsrResolverResolution => {
  const matching = assignments
    .filter(
      (assignment) =>
        assignment.caseRef === caseRef &&
        assignment.controllerRef === controllerRef &&
        isPrivacyInstantAtOrBefore(assignment.assignedAt, asOf),
    )
    .toSorted((left, right) => comparePrivacyInstants(left.assignedAt, right.assignedAt) ?? 0);
  return matching.length === 0 ? { status: 'ABSENT' } : resolveCurrentDsrResolverFromMatching(matching);
};

export const requiredDsrVerificationScope = (right: DsrRight): DsrVerification['scope'] =>
  ['ACCESS', 'PORTABILITY'].includes(right) ? 'EXPORT' : 'MUTATION';

export const findDsrOwnerTaskReplay = (
  tasks: readonly DsrOwnerTask[],
  idempotencyRef: string,
): DsrOwnerTask | undefined => tasks.find((task) => task.idempotencyKey === idempotencyRef);

const ownerExecutionIsRequiredForDsrDecision = (decision: DsrSubstantiveDecision): boolean =>
  decision.ownerExecutionRequired && ['GRANTED', 'PARTIALLY_GRANTED'].includes(decision.outcome);

export interface ValidateDsrResponseCoverageInput {
  readonly caseRecord: DsrCase;
  readonly decisions: readonly DsrSubstantiveDecision[];
  readonly deliveryEvidence?: DsrDeliveryEvidence;
  readonly ownerInventory?: DsrOwnerInventoryAuthorityResult;
  readonly response: DsrResponse;
  readonly tasks: readonly DsrOwnerTask[];
}

const validateDsrResponseScope = (caseRecord: DsrCase, response: DsrResponse): string | undefined => {
  const caseObligationRefs = dsrCaseObligationRefs(caseRecord);
  const responseScopeRefs = response.scopeRefs;
  const caseObligationRefSet = new Set(caseObligationRefs);
  if (
    caseObligationRefs.length === 0 ||
    !exactRefs(caseObligationRefs, unique(caseObligationRefs)) ||
    !exactRefs(responseScopeRefs, unique(responseScopeRefs)) ||
    responseScopeRefs.length === 0 ||
    !responseScopeRefs.every((scopeRef) => caseObligationRefSet.has(scopeRef))
  ) {
    return 'DSR Response scope must be a non-empty unique subset of exact Case obligations';
  }
  return undefined;
};

type DsrResponseDecisionCoverage =
  | { readonly error: string; readonly ok: false }
  | { readonly ok: true; readonly resolved: readonly ResolvedDsrObligation[] };

const validateDsrResponseOwnerInventoryEntries = (
  caseRecord: DsrCase,
  ownerInventory: DsrOwnerInventoryAuthorityResult,
): string | undefined =>
  ownerInventory.entries.some(
    (entry) =>
      !dsrObligationUnits(caseRecord).some((obligation) => ownerInventoryEntryMatchesObligation(entry, obligation)),
  )
    ? 'DSR Response Owner Inventory contains an entry outside the exact Case obligations'
    : undefined;

const validateDsrResponseOwnerExecutionObligation = (
  obligation: DsrObligationUnit,
  matchingDecisions: readonly DsrSubstantiveDecision[],
  ownerInventory: DsrOwnerInventoryAuthorityResult,
  tasks: readonly DsrOwnerTask[],
): string | undefined => {
  const [decision] = matchingDecisions;
  if (decision === undefined || !ownerExecutionIsRequiredForDsrDecision(decision)) {
    return undefined;
  }
  const matchingInventoryEntries = ownerInventory.entries.filter((entry) =>
    ownerInventoryEntryMatchesObligation(entry, obligation),
  );
  if (matchingInventoryEntries.length !== 1) {
    return 'DSR Response owner-execution obligation is not exactly covered by authoritative Owner Inventory';
  }
  const [inventoryEntry] = matchingInventoryEntries;
  if (inventoryEntry === undefined) {
    return 'DSR Response owner-execution obligation is not exactly covered by authoritative Owner Inventory';
  }
  const matchingTasks = tasks.filter(
    (task) =>
      task.caseRef === obligation.caseRef &&
      task.controllerRef === obligation.controllerRef &&
      task.ownerModuleId === inventoryEntry.ownerModuleId &&
      task.right === obligation.right &&
      sameDsrExactScopeRefs(task.exactScopeRefs, obligation.exactScopeRefs),
  );
  const [task] = matchingTasks;
  return matchingTasks.length !== 1 || task === undefined || !hasValidDsrOwnerTaskAuthorityProvenance(task)
    ? 'DSR Response owner-execution obligation is not exactly correlated to one trusted owner task'
    : undefined;
};

const resolveDsrResponseDecisionCoverage = (
  caseRecord: DsrCase,
  decisions: readonly DsrSubstantiveDecision[],
  response: DsrResponse,
): DsrResponseDecisionCoverage => {
  const caseDecisions = decisions.filter((decision) => decision.caseRef === caseRecord.caseRef);
  const caseDecisionRefs = caseDecisions.map(({ decisionRef }) => decisionRef);
  if (!exactRefs(caseDecisionRefs, unique(caseDecisionRefs))) {
    return { error: 'DSR Case workflow contains duplicate substantive decision references', ok: false };
  }
  const selectedScope = new Set(response.scopeRefs);
  const selectedObligations = dsrObligationUnits(caseRecord).filter(({ obligationRef }) =>
    selectedScope.has(obligationRef),
  );
  if (selectedObligations.length === 0) {
    return { error: 'DSR Response scope does not resolve to a Case obligation', ok: false };
  }
  const resolved = resolveDsrObligations(selectedObligations, caseDecisions, response.createdAt);
  if (resolved.some(({ decisions: matchingDecisions }) => matchingDecisions.length !== 1)) {
    return {
      error: 'DSR Response requires exactly one substantive decision per selected right and exact scope',
      ok: false,
    };
  }
  const expectedDecisionRefs = resolved.flatMap(({ decisions: matchingDecisions }) =>
    matchingDecisions.map(({ decisionRef }) => decisionRef),
  );
  return exactRefs(response.decisionRefs, expectedDecisionRefs)
    ? { ok: true, resolved }
    : { error: 'DSR Response decision references do not exactly cover its selected obligations', ok: false };
};

const validateDsrResponseOwnerTaskCoverage = (
  caseRecord: DsrCase,
  resolved: readonly ResolvedDsrObligation[],
  ownerInventory: DsrOwnerInventoryAuthorityResult | undefined,
  response: DsrResponse,
  tasks: readonly DsrOwnerTask[],
): string | undefined => {
  if (ownerInventory === undefined) {
    return 'Every DSR Response requires an authoritative Owner Inventory';
  }
  const inventoryError = validateDsrOwnerInventoryAuthorityScope(
    ownerInventory,
    caseRecord.caseRef,
    ownerInventory.tenantId,
    ownerInventory.legalEntityId,
    response.createdAt,
  );
  if (inventoryError !== undefined) {
    return inventoryError;
  }
  const inventoryEntriesError = validateDsrResponseOwnerInventoryEntries(caseRecord, ownerInventory);
  if (inventoryEntriesError !== undefined) {
    return inventoryEntriesError;
  }
  for (const { decisions: matchingDecisions, obligation } of resolved) {
    const obligationError = validateDsrResponseOwnerExecutionObligation(
      obligation,
      matchingDecisions,
      ownerInventory,
      tasks,
    );
    if (obligationError !== undefined) {
      return obligationError;
    }
  }
  return undefined;
};

const validateDsrResponseDeliveryEvidence = (
  response: DsrResponse,
  deliveryEvidence: DsrDeliveryEvidence | undefined,
): string | undefined => {
  const deliveryEvidenceMatches = Option.match(response.deliveryEvidenceRef, {
    onNone: () => deliveryEvidence === undefined,
    onSome: (deliveryEvidenceRef) =>
      deliveryEvidence !== undefined &&
      deliveryEvidenceRef === deliveryEvidence.evidenceId &&
      isSuccessfulDelivery(deliveryEvidence) &&
      sameDsrReferenceSet(response.scopeRefs, deliveryEvidence.deliveryScopeRefs),
  });
  return deliveryEvidenceMatches
    ? undefined
    : 'DSR Response delivery evidence must be absent or an exact successful proof for its scope';
};

const validateDsrFinalResponseCoverage = (caseRecord: DsrCase, response: DsrResponse): string | undefined => {
  if (!response.final) {
    return undefined;
  }
  const caseObligationRefs = dsrCaseObligationRefs(caseRecord);
  if (!dsrObligationsAreComplete(caseRecord, dsrObligationUnits(caseRecord))) {
    return 'A final DSR Response requires complete Case obligations';
  }
  if (!exactRefs(response.scopeRefs, caseObligationRefs)) {
    return 'A final DSR Response must cover every exact Case obligation';
  }
  return Option.isSome(response.deliveryEvidenceRef) ? undefined : 'A final DSR Response requires delivery evidence';
};

/**
 * Validates the exact obligation subset represented by a response. A response
 * scope is made of retained obligation refs, never caller-invented content
 * refs. Every selected obligation must have exactly one decision per requested
 * right; granted owner work must also have exactly one trusted task in that
 * same scope. Delivery evidence, when present, covers exactly the response.
 */
export const validateDsrResponseCoverage = (input: ValidateDsrResponseCoverageInput): string | undefined => {
  const { caseRecord, decisions, response, tasks } = input;
  if (response.caseRef !== caseRecord.caseRef) {
    return 'DSR Response does not match the exact Case';
  }
  if (
    response.final &&
    decisions.some(
      (decision) =>
        decision.caseRef === response.caseRef && isPrivacyInstantAfter(decision.decidedAt, response.createdAt),
    )
  ) {
    return 'DSR final response is stale after a later trusted substantive decision';
  }
  if (
    response.final &&
    tasks.some(
      (task) =>
        task.caseRef === response.caseRef &&
        task.updatedAt !== undefined &&
        isPrivacyInstantAfter(task.updatedAt, response.createdAt),
    )
  ) {
    return 'DSR final response is stale after a later trusted owner task';
  }
  return (
    validateDsrResponseScope(caseRecord, response) ??
    (() => {
      const decisionCoverage = resolveDsrResponseDecisionCoverage(caseRecord, decisions, response);
      return decisionCoverage.ok
        ? validateDsrResponseOwnerTaskCoverage(
            caseRecord,
            decisionCoverage.resolved,
            input.ownerInventory,
            response,
            tasks,
          )
        : decisionCoverage.error;
    })() ??
    validateDsrResponseDeliveryEvidence(response, input.deliveryEvidence) ??
    validateDsrFinalResponseCoverage(caseRecord, response)
  );
};

export const summarizeDsrCase = (
  caseRecord: DsrCase,
  decisions: readonly DsrSubstantiveDecision[],
  tasks: readonly DsrOwnerTask[],
  ownerInventory?: DsrOwnerInventoryAuthorityResult,
): DsrCaseSummary => {
  const obligations = dsrObligationUnits(caseRecord);
  const decidedObligations = obligations.filter(
    (obligation) => resolveCurrentDsrSubstantiveDecision(decisions, obligation).outcome === 'CURRENT',
  ).length;
  return {
    closeable: canCloseDsrCase(caseRecord, decisions, tasks, ownerInventory),
    completedOwnerTasks: tasks.filter(
      (task) =>
        task.status === 'SUCCEEDED' &&
        Option.isSome(task.outcomeRef) &&
        hasValidDsrOwnerTaskAuthorityProvenance(task) &&
        obligations.some(
          (obligation) =>
            task.caseRef === obligation.caseRef &&
            task.controllerRef === obligation.controllerRef &&
            task.right === obligation.right &&
            sameDsrExactScopeRefs(task.exactScopeRefs, obligation.exactScopeRefs),
        ),
    ).length,
    decidedObligations,
    openObligations: Math.max(0, obligations.length - decidedObligations),
    unresolvedParts: caseRecord.unresolvedParts.length,
  };
};

export const canFinalizeDsrResponse = (input: {
  readonly caseRecord: DsrCase;
  readonly decisions: readonly DsrSubstantiveDecision[];
  readonly deliveryEvidence: DsrDeliveryEvidence;
  readonly ownerInventory: DsrOwnerInventoryAuthorityResult | undefined;
  readonly response: DsrResponse;
  readonly tasks: readonly DsrOwnerTask[];
}): boolean => {
  const coverageError =
    input.ownerInventory === undefined
      ? validateDsrResponseCoverage({
          caseRecord: input.caseRecord,
          decisions: input.decisions,
          deliveryEvidence: input.deliveryEvidence,
          response: input.response,
          tasks: input.tasks,
        })
      : validateDsrResponseCoverage({
          caseRecord: input.caseRecord,
          decisions: input.decisions,
          deliveryEvidence: input.deliveryEvidence,
          ownerInventory: input.ownerInventory,
          response: input.response,
          tasks: input.tasks,
        });
  return (
    coverageError === undefined &&
    input.response.final &&
    canCloseDsrCase(input.caseRecord, input.decisions, input.tasks, input.ownerInventory)
  );
};
