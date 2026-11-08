import { Result } from 'effect';

import type { CapabilityKey } from '../ids.ts';
import type { Approval, AuthorityWitness, Holder, Proposal } from '../model.ts';
import { ApprovalRefusedError } from './errors.ts';
import type { ApprovalRefusalCode, ProposalIntegrityError } from './errors.ts';
import { producedProposal } from './invariants.ts';
import {
  addMilliseconds,
  approvalLifetimeMillis,
  earliest,
  isApprovable,
  isIdentityBound,
  raisesAuthority,
} from './policy.ts';
import type { GovernedCapability } from './policy.ts';
import type { VerifiedHumanPrincipal } from './principals.ts';
import { actorPrincipal, foreignWitness, uniqueBoundWitnesses, witnessOf } from './proposal.ts';
import type { BoundWitness } from './proposal.ts';

/** Whether a person may confirm a command they proposed themselves (P6). */
export interface ApprovalPolicy {
  readonly selfApproval: 'permitted' | 'forbidden';
}

/**
 * Every grant the command needs at execution, bound to the approver's exact assignment incarnations
 * (D30). Amount ceilings and record selectors live on the bound grant cell, so the same witnesses
 * are re-evaluated at execution and cap the command again.
 */
export interface MandateAuthority {
  readonly approval: BoundWitness;
  readonly execution: BoundWitness;
  /** The read of the parent record the command changes; required when the command names a record. */
  readonly parentRecordRead: readonly BoundWitness[];
}

export interface ApproveInput {
  /** A verified person; an agent or a workload cannot hold this proof, so it can never approve (O46). */
  readonly approver: VerifiedHumanPrincipal;
  readonly authority: MandateAuthority;
  readonly capability: GovernedCapability;
  readonly now: Date;
  /**
   * The read that governs the parent record of a record-scoped command, taken from the published
   * catalog entry so no caller can choose it (D30, O64).
   */
  readonly parentRecordReadCapabilityKey?: CapabilityKey;
  readonly policy: ApprovalPolicy;
  readonly proposal: Proposal;
}

const authorityWitnessSlot = (witness: AuthorityWitness): string =>
  `${witness.purpose} ${witness.assignmentIncarnationId} ${witness.grantIncarnationId} ${witness.capabilityKey}`;

const uniqueWitnesses = (witnesses: readonly AuthorityWitness[]): readonly AuthorityWitness[] => [
  ...new Map(witnesses.map((witness) => [authorityWitnessSlot(witness), witness])).values(),
];

const refusal = (code: ApprovalRefusalCode, reason: string): Result.Result<never, ApprovalRefusedError> =>
  Result.fail(new ApprovalRefusedError({ code, reason }));

const approverAuthorityIssue = (input: {
  readonly approverId: Holder;
  readonly capabilityKey: CapabilityKey;
  readonly proposal: Proposal;
  readonly witnesses: readonly BoundWitness[];
}): string | undefined =>
  foreignWitness({
    capabilityKey: input.capabilityKey,
    expectedHolder: input.approverId,
    scopeId: input.proposal.scopeId,
    witnesses: input.witnesses,
  }) === undefined
    ? undefined
    : 'Approver authority was checked for another holder, scope or capability';

/**
 * "Approve and execute using my access": a person turns a frozen proposal into a single-use mandate
 * that binds their own exact assignment incarnations and grant cells. It never elevates the
 * requester or the agent; execution re-checks the same witnesses (P5, D8, D30).
 */
export const approve = (
  input: ApproveInput,
): Result.Result<Proposal, ApprovalRefusedError | ProposalIntegrityError> => {
  const { capability, proposal } = input;
  if (proposal.actionAuthority !== undefined) {
    return refusal('authority_witness_mismatch', 'A forward Action requires its complete approve-mode authority proof');
  }
  if (proposal.status !== 'pending') {
    return refusal('proposal_not_pending', 'Only a pending proposal can be approved');
  }
  if (input.now >= proposal.expiresAt) {
    return refusal('proposal_expired', 'The proposal expired before anyone approved it');
  }
  if (isIdentityBound(capability)) {
    return refusal('identity_bound_action', 'An identity-bound command runs only as the person who requested it');
  }
  if (!isApprovable(capability)) {
    return refusal('capability_not_approvable', 'The declaration does not support the approve mode');
  }
  const approverId = input.approver.principalId;
  const requesterId = actorPrincipal(proposal.requester);
  if (approverId === requesterId) {
    if (raisesAuthority(capability)) {
      return refusal(
        'independent_approver_required',
        'A command that raises authority needs an approver other than its requester',
      );
    }
    if (input.policy.selfApproval === 'forbidden') {
      return refusal('self_approval_forbidden', 'Business policy forbids confirming your own command');
    }
  }
  // The approver's own holder, in the proposal's scope, for the proposal's capability (R2-H1).
  const approverHolder: Holder = { _tag: 'Principal', principalId: approverId };
  const approverIssue = approverAuthorityIssue({
    approverId: approverHolder,
    capabilityKey: proposal.capabilityKey,
    proposal,
    witnesses: [input.authority.approval, input.authority.execution],
  });
  if (approverIssue !== undefined) {
    return refusal('authority_witness_mismatch', approverIssue);
  }
  const parentRecordRead = uniqueBoundWitnesses(input.authority.parentRecordRead);
  const parentReadCapabilityKey = input.parentRecordReadCapabilityKey;
  if (proposal.target === undefined) {
    if (parentRecordRead.length > 0) {
      return refusal('parent_record_read_unexpected', 'A command without a record reads no parent record');
    }
  } else if (parentReadCapabilityKey === undefined) {
    return refusal(
      'parent_record_read_missing',
      'The published declaration names no read that governs the record this command changes',
    );
  } else if (parentRecordRead.length === 0) {
    return refusal(
      'parent_record_read_missing',
      'The approver must hold the read of the parent record the command changes',
    );
  }
  const parentReadIssue =
    parentReadCapabilityKey === undefined
      ? undefined
      : approverAuthorityIssue({
          approverId: approverHolder,
          capabilityKey: parentReadCapabilityKey,
          proposal,
          witnesses: parentRecordRead,
        });
  if (parentReadIssue !== undefined) {
    return refusal('parent_record_read_missing', parentReadIssue);
  }
  const approval: Approval = {
    approvalAssignmentIncarnationId: input.authority.approval.assignmentIncarnationId,
    approvedAt: input.now,
    approverId,
    executionAssignmentIncarnationId: input.authority.execution.assignmentIncarnationId,
    expiresAt: earliest(addMilliseconds(input.now, approvalLifetimeMillis(capability.risk)), proposal.expiresAt),
  };
  const witnesses = uniqueWitnesses([
    ...proposal.witnesses,
    witnessOf('approval', input.authority.approval),
    witnessOf('execution', input.authority.execution),
    ...parentRecordRead.map((witness) => witnessOf('parent_record_read', witness)),
  ]);
  const [firstWitness, ...restWitnesses] = witnesses;
  if (firstWitness === undefined) {
    return refusal('approval_authority_missing', 'The approver holds no live authority for this command');
  }
  const mandate: Proposal = {
    approval,
    capabilityKey: proposal.capabilityKey,
    commandDigest: proposal.commandDigest,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    id: proposal.id,
    requester: proposal.requester,
    scopeId: proposal.scopeId,
    status: 'approved',
    tenantId: proposal.tenantId,
    witnesses: [firstWitness, ...restWitnesses],
  };
  return producedProposal({
    from: proposal.status,
    proposal: proposal.target === undefined ? mandate : { ...mandate, target: proposal.target },
  });
};

export interface RejectInput {
  /** A verified person; rejecting is a decision about somebody's authority, so an agent never takes it. */
  readonly approver: VerifiedHumanPrincipal;
  readonly now: Date;
  readonly proposal: Proposal;
}

/**
 * "Zamítnout": an eligible decider declines a pending proposal. Rejection removes authority rather
 * than granting it, so it needs no adoption and no new grant (O35, O57). The requester is never an
 * eligible decider — they withdraw instead (P6, O61) — and an approval is never discarded, so the
 * same call on an approved mandate is refused.
 */
export const reject = (input: RejectInput): Result.Result<Proposal, ApprovalRefusedError | ProposalIntegrityError> => {
  const { proposal } = input;
  if (proposal.status !== 'pending') {
    return refusal('proposal_not_pending', 'Only a pending proposal can be rejected');
  }
  if (input.approver.principalId === actorPrincipal(proposal.requester)) {
    return refusal('requester_cannot_reject', 'The requester withdraws their own proposal instead of rejecting it');
  }
  const rejected: Proposal = {
    ...proposal,
    endedAt: input.now,
    rejectedBy: input.approver.principalId,
    status: 'rejected',
  };
  return producedProposal({ from: proposal.status, proposal: rejected });
};
