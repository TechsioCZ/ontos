import { Option, Schema } from 'effect';

import { isSuccessfulDelivery } from './dsr-delivery-access.ts';
import type { DsrDeliveryEvidence } from './dsr-delivery-access.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const Timestamp = PrivacyIsoTimestampSchema;
const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Refs = Schema.Array(Ref).check(Schema.isMaxLength(128));
const IdempotencyKey = Ref.pipe(Schema.brand('IdempotencyKey'));
const OwnerModuleId = Ref.pipe(Schema.brand('OwnerModuleId'));

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

export const DsrControllerObligationSchema = Schema.Struct({
  caseRef: Ref,
  controllerRef: Ref,
  obligationRef: Ref,
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
  status: Schema.Literals(['RECEIVED', 'IN_PROGRESS', 'PARTIALLY_RESOLVED', 'RESPONDED', 'CLOSED']),
  subjectRefs: Refs,
  unresolvedParts: Refs,
});
export type DsrCase = typeof DsrCaseSchema.Type;

export const DsrVerificationSchema = Schema.Struct({
  caseRef: Ref,
  evidenceRefs: Refs,
  expiresAt: Schema.OptionFromNullOr(Timestamp),
  method: Ref,
  outcome: Schema.Literals(['PENDING', 'VERIFIED', 'FAILED', 'EXPIRED']),
  scope: Schema.Literals(['INTAKE', 'SENSITIVE_LOOKUP', 'EXPORT', 'MUTATION']),
  subjectRef: Ref,
  verificationRef: Ref,
  verifiedAt: Schema.OptionFromNullOr(Timestamp),
});
export type DsrVerification = typeof DsrVerificationSchema.Type;

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
  caseRef: Ref,
  controllerRef: Ref,
  deadlineAt: Timestamp,
  escalationRequired: Schema.Boolean,
  extended: Schema.Boolean,
  receiptBasisRef: Ref,
  receivedAt: Timestamp,
});
export type DsrDeadline = typeof DsrDeadlineSchema.Type;

export const DsrSubstantiveDecisionSchema = Schema.Struct({
  caseRef: Ref,
  controllerRef: Ref,
  decidedAt: Timestamp,
  decisionEvidenceRefs: Refs,
  decisionRef: Ref,
  outcome: Schema.Literals(['GRANTED', 'PARTIALLY_GRANTED', 'DENIED', 'UNRESOLVED']),
  ownerExecutionRequired: Schema.Boolean,
  reasonRef: Ref,
  right: DsrRightSchema,
});
export type DsrSubstantiveDecision = typeof DsrSubstantiveDecisionSchema.Type;

export const DsrOwnerTaskSchema = Schema.Struct({
  caseRef: Ref,
  controllerRef: Ref,
  exactScopeRefs: Refs,
  idempotencyKey: IdempotencyKey,
  outcomeRef: Schema.OptionFromNullOr(Ref),
  ownerModuleId: OwnerModuleId,
  right: DsrRightSchema,
  status: Schema.Literals(['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'PARTIAL', 'INDETERMINATE', 'FAILED']),
  taskRef: Ref,
});
export type DsrOwnerTask = typeof DsrOwnerTaskSchema.Type;

export const DsrResponseSchema = Schema.Struct({
  caseRef: Ref,
  createdAt: Timestamp,
  decisionRefs: Refs,
  deliveryEvidenceRef: Schema.OptionFromNullOr(Ref),
  final: Schema.Boolean,
  responseRef: Ref,
  scopeRefs: Refs,
});
export type DsrResponse = typeof DsrResponseSchema.Type;

export const DsrResolverResolutionSchema = Schema.Union([
  Schema.Struct({ assignment: DsrResolverAssignmentSchema, status: Schema.Literal('CURRENT') }),
  Schema.Struct({ status: Schema.Literals(['ABSENT', 'UNAVAILABLE']) }),
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
const dsrScopeKey = (caseRef: string, controllerRef: string, right: DsrRight): string =>
  [caseRef, controllerRef, right].map((part) => `${part.length}:${part}`).join('|');

export interface CreateDsrCaseInput {
  readonly caseRef: string;
  readonly controllerObligations?: readonly DsrControllerObligation[];
  readonly receivedAt: DsrCase['originalReceivedAt'];
  readonly requestedRights: readonly DsrRight[];
  readonly requester: DsrRequester;
  readonly subjectRefs?: readonly string[];
  readonly unresolvedParts?: readonly string[];
}

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

/** Each Controller gets its own deadline; reassignment never changes the original receipt time. */
export const calculateDsrDeadline = (input: {
  readonly caseRef: string;
  readonly controllerRef: string;
  readonly deadlineAt: DsrDeadline['deadlineAt'];
  readonly escalationRequired?: boolean;
  readonly extended?: boolean;
  readonly originalReceivedAt: DsrCase['originalReceivedAt'];
  readonly receiptBasisRef: string;
}): DsrDeadline => ({
  caseRef: input.caseRef,
  controllerRef: input.controllerRef,
  deadlineAt: input.deadlineAt,
  escalationRequired: input.escalationRequired ?? false,
  extended: input.extended ?? false,
  receiptBasisRef: input.receiptBasisRef,
  receivedAt: input.originalReceivedAt,
});

export const canCloseDsrCase = (
  caseRecord: DsrCase,
  decisions: readonly DsrSubstantiveDecision[],
  tasks: readonly DsrOwnerTask[],
): boolean => {
  const obligations = caseRecord.controllerObligations.flatMap((obligation) =>
    obligation.requestedRights.map((right) => ({
      caseRef: obligation.caseRef,
      controllerRef: obligation.controllerRef,
      right,
    })),
  );
  if (
    caseRecord.unresolvedParts.length > 0 ||
    obligations.length === 0 ||
    obligations.some(({ caseRef }) => caseRef !== caseRecord.caseRef)
  ) {
    return false;
  }

  const resolvedDecisions = obligations.map((obligation) =>
    decisions.filter(
      (decision) =>
        decision.caseRef === obligation.caseRef &&
        decision.controllerRef === obligation.controllerRef &&
        decision.right === obligation.right &&
        decision.outcome !== 'UNRESOLVED',
    ),
  );
  if (resolvedDecisions.some((matching) => matching.length === 0)) {
    return false;
  }

  const decisionsRequiringOwnerExecution = resolvedDecisions
    .flat()
    .filter(
      (decision) => decision.ownerExecutionRequired && ['GRANTED', 'PARTIALLY_GRANTED'].includes(decision.outcome),
    );
  return decisionsRequiringOwnerExecution.every((decision) => {
    const matchingTasks = tasks.filter(
      (task) =>
        task.caseRef === decision.caseRef &&
        task.controllerRef === decision.controllerRef &&
        task.right === decision.right,
    );
    return (
      matchingTasks.length > 0 &&
      matchingTasks.every((task) => task.status === 'SUCCEEDED' && Option.isSome(task.outcomeRef))
    );
  });
};

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
    onSome: (expiresAt) => input.at < expiresAt,
  });

export const isDsrDecisionForObligation = (
  decision: DsrSubstantiveDecision,
  obligation: DsrControllerObligation,
): boolean =>
  decision.caseRef === obligation.caseRef &&
  decision.controllerRef === obligation.controllerRef &&
  obligation.requestedRights.includes(decision.right);

/** Technical owner work may follow only a substantive grant, never a transport success or intake. */
export const canDispatchDsrOwnerTask = (decision: DsrSubstantiveDecision): boolean =>
  decision.ownerExecutionRequired && ['GRANTED', 'PARTIALLY_GRANTED'].includes(decision.outcome);

export const resolveCurrentDsrResolver = (
  assignments: readonly DsrResolverAssignment[],
  caseRef: string,
  controllerRef: string,
): DsrResolverResolution => {
  const matching = assignments
    .filter((assignment) => assignment.caseRef === caseRef && assignment.controllerRef === controllerRef)
    .toSorted((left, right) => right.assignedAt.localeCompare(left.assignedAt));
  const [latest] = matching;
  if (latest === undefined) {
    return { status: 'ABSENT' };
  }
  return latest.outage ? { status: 'UNAVAILABLE' } : { assignment: latest, status: 'CURRENT' };
};

export const requiredDsrVerificationScope = (right: DsrRight): DsrVerification['scope'] =>
  ['ACCESS', 'PORTABILITY'].includes(right) ? 'EXPORT' : 'MUTATION';

export const findDsrOwnerTaskReplay = (
  tasks: readonly DsrOwnerTask[],
  idempotencyRef: string,
): DsrOwnerTask | undefined => tasks.find((task) => task.idempotencyKey === idempotencyRef);

export const summarizeDsrCase = (
  caseRecord: DsrCase,
  decisions: readonly DsrSubstantiveDecision[],
  tasks: readonly DsrOwnerTask[],
): DsrCaseSummary => {
  const obligations = caseRecord.controllerObligations.flatMap((obligation) =>
    obligation.requestedRights.map((right) => ({ obligation, right })),
  );
  const decidedObligations = obligations.filter(({ obligation, right }) =>
    decisions.some(
      (decision) =>
        decision.outcome !== 'UNRESOLVED' &&
        decision.caseRef === obligation.caseRef &&
        decision.controllerRef === obligation.controllerRef &&
        decision.right === right,
    ),
  ).length;
  const obligationKeys = new Set(
    obligations.map(({ obligation, right }) => dsrScopeKey(obligation.caseRef, obligation.controllerRef, right)),
  );
  return {
    closeable: canCloseDsrCase(caseRecord, decisions, tasks),
    completedOwnerTasks: tasks.filter(
      (task) =>
        task.status === 'SUCCEEDED' &&
        Option.isSome(task.outcomeRef) &&
        obligationKeys.has(dsrScopeKey(task.caseRef, task.controllerRef, task.right)),
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
  readonly response: DsrResponse;
  readonly tasks: readonly DsrOwnerTask[];
}): boolean => {
  const responseDecisionRefs = new Set(input.response.decisionRefs);
  const caseDecisions = input.decisions.filter(
    (decision) => decision.caseRef === input.caseRecord.caseRef && decision.outcome !== 'UNRESOLVED',
  );
  const caseDecisionRefs = new Set(caseDecisions.map(({ decisionRef }) => decisionRef));
  const deliveredScopeRefs = new Set(input.deliveryEvidence.deliveryScopeRefs);
  const deliveryEvidenceMatches = Option.match(input.response.deliveryEvidenceRef, {
    onNone: () => false,
    onSome: (deliveryEvidenceRef) =>
      deliveryEvidenceRef === input.deliveryEvidence.evidenceId &&
      isSuccessfulDelivery(input.deliveryEvidence) &&
      input.response.scopeRefs.every((scopeRef) => deliveredScopeRefs.has(scopeRef)),
  });
  return (
    input.response.caseRef === input.caseRecord.caseRef &&
    input.response.final &&
    deliveryEvidenceMatches &&
    caseDecisions.every(({ decisionRef }) => responseDecisionRefs.has(decisionRef)) &&
    input.response.decisionRefs.every((decisionRef) => caseDecisionRefs.has(decisionRef)) &&
    canCloseDsrCase(input.caseRecord, input.decisions, input.tasks)
  );
};
