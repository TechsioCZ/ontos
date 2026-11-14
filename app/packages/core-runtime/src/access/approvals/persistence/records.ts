import { DateTime, Result, Schema } from 'effect';

import { accessMandateGrants, accessMandates, accessProposals } from '../../../db/schema.ts';
import type {
  AccessMode,
  ActorContext,
  Approval,
  AuthorityWitness,
  ExecutionReceipt,
  Holder,
  Proposal,
  WitnessPurpose,
} from '../../model.ts';
import { ACCESS_MODEL_PARSE_OPTIONS, ApprovalSchema, ExecutionReceiptSchema, ProposalSchema } from '../../model.ts';
import type { ApprovalDecisionEvidence } from '../service.ts';
import type { ActionAuthorityProofV2 } from '../action-authority-v2-schema.ts';

/*
 * The rows of one proposal, its approval record and the witnesses that record binds. The model owns
 * the rules; this module owns the translation, so a stored row always decodes through the same
 * `ProposalSchema` a produced one does, and a row the model refuses never enters Core.
 *
 * Which table owns what (O52): `access_proposals` owns the whole lifecycle and freezes the requester
 * authority; `access_mandates` is the append-only approval record; `access_mandate_grants` holds one
 * row per bound witness, so SQL itself proves that the witness was held in the proposal's scope, in
 * the mode its purpose requires, on the grant cell it claims.
 */

/** The requester's own witnesses; the proposal row freezes them, so they are never re-pointed. */
export const requesterWitnesses = (proposal: Proposal): readonly AuthorityWitness[] =>
  proposal.witnesses.filter(({ purpose }) => purpose === 'requester');

/**
 * The witnesses an approval binds: everything the approving person holds, and nothing of the
 * requester's. The requester's authority is frozen on the proposal row when the request is made, so
 * writing it again as an approval witness would let an approval replace the authority the request
 * was made with (R4-L2).
 */
export const approverWitnesses = (proposal: Proposal): readonly AuthorityWitness[] =>
  proposal.witnesses.filter(({ purpose }) => purpose !== 'requester');

export const proposalColumns = {
  capabilityKey: accessProposals.capabilityKey,
  commandDigest: accessProposals.commandDigest,
  createdAt: accessProposals.createdAt,
  endedAt: accessProposals.endedAt,
  executedAt: accessProposals.executedAt,
  executionOperationId: accessProposals.executionOperationId,
  expiresAt: accessProposals.expiresAt,
  proposalId: accessProposals.proposalId,
  rejectedBy: accessProposals.rejectedBy,
  requesterActionAuthorityJson: accessProposals.requesterActionAuthorityJson,
  requesterAuthorityJson: accessProposals.requesterAuthorityJson,
  requesterJson: accessProposals.requesterJson,
  scopeId: accessProposals.scopeId,
  status: accessProposals.status,
  target: accessProposals.target,
  tenantId: accessProposals.tenantId,
} as const;

export const mandateColumns = {
  actionAuthorityJson: accessMandates.actionAuthorityJson,
  approvalExpiresAt: accessMandates.approvalExpiresAt,
  approvedAt: accessMandates.approvedAt,
  approverAssignmentIncarnationId: accessMandates.approverAssignmentIncarnationId,
  approverId: accessMandates.approverId,
  executionAssignmentIncarnationId: accessMandates.executionAssignmentIncarnationId,
  mandateId: accessMandates.mandateId,
  proposalId: accessMandates.proposalId,
  tenantId: accessMandates.tenantId,
} as const;

export const mandateGrantColumns = {
  assignmentIncarnationId: accessMandateGrants.assignmentIncarnationId,
  capabilityKey: accessMandateGrants.capabilityKey,
  grantIncarnationId: accessMandateGrants.grantIncarnationId,
  mandateId: accessMandateGrants.mandateId,
  mode: accessMandateGrants.mode,
  purpose: accessMandateGrants.purpose,
  scopeId: accessMandateGrants.scopeId,
  tenantId: accessMandateGrants.tenantId,
} as const;

/** A timestamp as the driver may hand it back: a `Date`, or the text of one. */
type StoredInstant = Date | string;

/** The driver may hand a timestamp back as text; the model takes a `Date`, so both land as one. */
const asDate = (value: StoredInstant): Date => DateTime.toDateUtc(DateTime.makeUnsafe(value));

export interface ProposalRow {
  readonly capabilityKey: string;
  readonly commandDigest: string;
  readonly createdAt: StoredInstant;
  readonly endedAt: StoredInstant | null;
  readonly executedAt: StoredInstant | null;
  readonly executionOperationId: string | null;
  readonly expiresAt: StoredInstant;
  readonly proposalId: string;
  readonly rejectedBy: string | null;
  readonly requesterActionAuthorityJson: ActionAuthorityProofV2 | null;
  readonly requesterAuthorityJson: readonly AuthorityWitness[];
  readonly requesterJson: ActorContext;
  readonly scopeId: string;
  readonly status: Proposal['status'];
  readonly target: string | null;
  readonly tenantId: string;
}

/**
 * One approval record. It names its proposal, the frozen command it approves, the person who gave it
 * and the two assignments that person used; the proposal row owns the lifecycle and this row owns
 * nothing that could diverge from it (O52).
 */
export interface MandateRow {
  readonly actionAuthorityJson: ActionAuthorityProofV2 | null;
  readonly approvalExpiresAt: StoredInstant;
  readonly approvedAt: StoredInstant;
  readonly approverAssignmentIncarnationId: string | null;
  readonly approverId: string;
  readonly executionAssignmentIncarnationId: string | null;
  readonly mandateId: string;
  readonly proposalId: string;
  readonly tenantId: string;
}

export interface MandateGrantRow {
  readonly assignmentIncarnationId: string;
  readonly capabilityKey: string;
  readonly grantIncarnationId: string;
  readonly mandateId: string;
  readonly mode: AccessMode;
  readonly purpose: WitnessPurpose;
  readonly scopeId: string;
  readonly tenantId: string;
}

/**
 * A witness as the rows spell it: the three identifiers still plain strings, because they are on
 * their way into the model that brands them, and the holder the assignment really belongs to.
 */
export interface EncodedWitness {
  readonly assignmentIncarnationId: string;
  readonly capabilityKey: string;
  readonly grantIncarnationId: string;
  readonly holderId: Holder;
  readonly mode: AccessMode;
  readonly purpose: WitnessPurpose;
  readonly scopeId: string;
}

/** Everything a proposal row carries: the frozen command, the request and its single execution. */
export const proposalInsertValues = (proposal: Proposal) => ({
  capabilityKey: proposal.capabilityKey,
  commandDigest: proposal.commandDigest,
  createdAt: proposal.createdAt,
  endedAt: proposal.endedAt ?? null,
  executedAt: proposal.execution?.executedAt ?? null,
  executionOperationId: proposal.execution?.actionInvocationId ?? null,
  expiresAt: proposal.expiresAt,
  proposalId: proposal.id,
  rejectedBy: proposal.rejectedBy ?? null,
  requesterActionAuthorityJson: proposal.actionAuthority ?? null,
  requesterAuthorityJson: requesterWitnesses(proposal),
  requesterJson: proposal.requester,
  requesterPrincipalId: proposal.requester.principalId,
  scopeId: proposal.scopeId,
  status: proposal.status,
  target: proposal.target ?? null,
  tenantId: proposal.tenantId,
});

/**
 * The mutable columns of a proposal: how it ended and its one execution receipt. The frozen command,
 * the requester and its authority are never part of an update, and the approval is stored on its own
 * record, so the row's trigger and this statement agree exactly on what a transition may change (O52,
 * R4-L1).
 */
export const proposalTransitionValues = (proposal: Proposal) => ({
  endedAt: proposal.endedAt ?? null,
  executedAt: proposal.execution?.executedAt ?? null,
  executionOperationId: proposal.execution?.actionInvocationId ?? null,
  rejectedBy: proposal.rejectedBy ?? null,
  status: proposal.status,
});

/**
 * The approval record: who approved, when, and until when it may run. It is written once per proposal
 * (the table is append-only and unique per proposal) and it never carries a status, so no second
 * lifecycle can diverge from the proposal row (O52). The scope, the capability and the digest are
 * repeated from the proposal only because SQL requires them to prove they are the proposal's own.
 */
export const mandateInsertValues = (proposal: Proposal, approval: Approval, mandateId: string) => ({
  actionAuthorityJson: 'actionAuthority' in approval ? approval.actionAuthority : null,
  approvalExpiresAt: approval.expiresAt,
  approvedAt: approval.approvedAt,
  approverAssignmentIncarnationId: 'actionAuthority' in approval ? null : approval.approvalAssignmentIncarnationId,
  approverId: approval.approverId,
  capabilityKey: proposal.capabilityKey,
  commandDigest: proposal.commandDigest,
  executionAssignmentIncarnationId: 'actionAuthority' in approval ? null : approval.executionAssignmentIncarnationId,
  mandateId,
  proposalId: proposal.id,
  scopeId: proposal.scopeId,
  tenantId: proposal.tenantId,
});

/** One row per bound approver witness, so SQL proves the scope, the mode and the cell it claims. */
export const mandateGrantValues = (proposal: Proposal, mandateId: string) =>
  approverWitnesses(proposal).map((witness) => ({
    assignmentIncarnationId: witness.assignmentIncarnationId,
    capabilityKey: witness.capabilityKey,
    grantIncarnationId: witness.grantIncarnationId,
    mandateId,
    mode: witness.mode,
    purpose: witness.purpose,
    scopeId: proposal.scopeId,
    tenantId: proposal.tenantId,
  }));

/**
 * The order the purposes are declared in. A stored proposal always reads its witnesses back in this
 * order, whatever order the rows of its approval record come back in, so one record has one shape.
 */
const PURPOSE_ORDER = {
  approval: 1,
  execution: 2,
  parent_record_read: 3,
  requester: 0,
} as const satisfies Record<WitnessPurpose, number>;

const orderedWitnesses = (witnesses: readonly EncodedWitness[]): readonly EncodedWitness[] =>
  witnesses.toSorted(
    (left, right) =>
      PURPOSE_ORDER[left.purpose] - PURPOSE_ORDER[right.purpose] ||
      left.grantIncarnationId.localeCompare(right.grantIncarnationId),
  );

const decodeProposal = Schema.decodeUnknownResult(ProposalSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeApproval = Schema.decodeUnknownResult(ApprovalSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeExecution = Schema.decodeUnknownResult(ExecutionReceiptSchema, ACCESS_MODEL_PARSE_OPTIONS);

/** One proposal as the model reads it back, before the schema brands and validates it. */
interface StoredProposalCandidate {
  actionAuthority?: ActionAuthorityProofV2;
  approval?: Approval;
  capabilityKey: string;
  commandDigest: string;
  createdAt: Date;
  endedAt?: Date;
  execution?: ExecutionReceipt;
  expiresAt: Date;
  id: string;
  rejectedBy?: string;
  requester: ActorContext;
  scopeId: string;
  status: Proposal['status'];
  target?: string;
  tenantId: string;
  witnesses: readonly EncodedWitness[];
}

const approvalOfRow = (mandate: MandateRow) => {
  const base = {
    approvedAt: asDate(mandate.approvedAt),
    approverId: mandate.approverId,
    expiresAt: asDate(mandate.approvalExpiresAt),
  };
  if (mandate.actionAuthorityJson === null) {
    return {
      ...base,
      approvalAssignmentIncarnationId: mandate.approverAssignmentIncarnationId,
      executionAssignmentIncarnationId: mandate.executionAssignmentIncarnationId,
    };
  }
  return { ...base, actionAuthority: mandate.actionAuthorityJson };
};

/**
 * One stored proposal, decoded through the model. The requester's authority is always the frozen
 * column of the proposal row, and an approval adds only the approver witnesses SQL proved against its
 * own record — so reading a decided proposal back can never report a requester authority other than
 * the one the request was made with (R4-L2). A row that does not add up is a refusal, never a lenient
 * read.
 */
export const proposalFrom = (
  row: ProposalRow,
  mandate: MandateRow | undefined,
  mandateWitnesses: readonly EncodedWitness[] | undefined,
): Result.Result<Proposal, string> => {
  const approval = mandate === undefined ? undefined : approvalOfRow(mandate);
  if (
    mandate !== undefined &&
    mandate.actionAuthorityJson !== null &&
    (mandate.approverAssignmentIncarnationId !== null || mandate.executionAssignmentIncarnationId !== null)
  ) {
    return Result.fail('A forward Action approval cannot carry historical execution assignments');
  }
  const execution =
    row.executedAt === null || row.executionOperationId === null
      ? undefined
      : { actionInvocationId: row.executionOperationId, executedAt: asDate(row.executedAt) };
  const candidate: StoredProposalCandidate = {
    capabilityKey: row.capabilityKey,
    commandDigest: row.commandDigest,
    createdAt: asDate(row.createdAt),
    expiresAt: asDate(row.expiresAt),
    id: row.proposalId,
    requester: row.requesterJson,
    scopeId: row.scopeId,
    status: row.status,
    tenantId: row.tenantId,
    witnesses: orderedWitnesses([...row.requesterAuthorityJson, ...(mandateWitnesses ?? [])]),
  };
  if (row.requesterActionAuthorityJson !== null) {
    candidate.actionAuthority = row.requesterActionAuthorityJson;
  }
  // The model omits an absent value; the columns store null. Only a present value joins the record,
  // and each part is decoded on its own so a malformed approval names itself in the refusal.
  if (approval !== undefined) {
    const decoded = decodeApproval(approval);
    if (Result.isFailure(decoded)) {
      return Result.fail(`the approval of proposal ${row.proposalId} is invalid: ${decoded.failure.message}`);
    }
    candidate.approval = decoded.success;
  }
  if (execution !== undefined) {
    const decoded = decodeExecution(execution);
    if (Result.isFailure(decoded)) {
      return Result.fail(`the execution of proposal ${row.proposalId} is invalid: ${decoded.failure.message}`);
    }
    candidate.execution = decoded.success;
  }
  if (row.endedAt !== null) {
    candidate.endedAt = asDate(row.endedAt);
  }
  if (row.rejectedBy !== null) {
    candidate.rejectedBy = row.rejectedBy;
  }
  if (row.target !== null) {
    candidate.target = row.target;
  }
  return decodeProposal(candidate).pipe(Result.mapError((failure) => failure.message));
};

/** The model's own witness, built from the row SQL proved and the assignment's real holder. */
export const witnessOfRow = (witness: MandateGrantRow, holderId: EncodedWitness['holderId']): EncodedWitness => ({
  assignmentIncarnationId: witness.assignmentIncarnationId,
  capabilityKey: witness.capabilityKey,
  grantIncarnationId: witness.grantIncarnationId,
  holderId,
  mode: witness.mode,
  purpose: witness.purpose,
  scopeId: witness.scopeId,
});

export interface DecisionRecordInput {
  readonly decidedAt: Date;
  readonly decisionLogId: string;
  readonly evidence: ApprovalDecisionEvidence | undefined;
  readonly proposal: Proposal;
  readonly reason: string | undefined;
}

/** The mode a transition was decided in: a person's rejection, or the requester's own request. */
export const decisionRecordActor = (
  proposal: Proposal,
  evidence: ApprovalDecisionEvidence | undefined,
): { readonly actor: ActorContext; readonly mode: AccessMode } =>
  evidence === undefined
    ? { actor: proposal.requester, mode: 'propose' }
    : { actor: { _tag: 'Principal', principalId: evidence.decidedBy }, mode: 'approve' };

/**
 * The "Proč?" record of one transition (O61). A rejection names the person who decided and the live
 * approve-mode witnesses the decision relied on; a lapse or an expiry names the cause and the person
 * whose command ended. The decision log is append-only, and the actor is always a person: an agent's
 * proposal is recorded against the person the agent acts for.
 */
export const decisionRecordInsert = ({ decidedAt, decisionLogId, evidence, proposal, reason }: DecisionRecordInput) => {
  const { actor, mode } = decisionRecordActor(proposal, evidence);
  return {
    actorJson: actor,
    actorPrincipalId: actor.principalId,
    capabilityKey: proposal.capabilityKey,
    // A stable correlation key, so the decision log answers "why" for exactly this proposal step.
    correlationId: `access-approvals:${proposal.id}:${proposal.status}`,
    decidedAt,
    decisionLogId,
    mode,
    // A rejection, a lapse and an expiry all end a command that will not run: the outcome is DENIED.
    outcome: 'DENIED' as const,
    reasonsJson: [
      // The ground that made the decider eligible: the scope's administration or her own authority.
      ...(evidence === undefined ? [] : [{ code: `decider.${evidence.basis}` }]),
      { code: reason ?? `proposal.${proposal.status}` },
      ...(evidence?.witnesses ?? []).map((witness) => ({
        assignmentIncarnationId: witness.assignmentIncarnationId,
        capabilityKey: witness.capabilityKey,
        code: 'rejection.witness',
        grantIncarnationId: witness.grantIncarnationId,
      })),
    ],
    scopeId: proposal.scopeId,
    // The record a record-scoped command names, when it names one; the log keeps it verbatim.
    scopeTarget: proposal.target ?? null,
    tenantId: proposal.tenantId,
  };
};
