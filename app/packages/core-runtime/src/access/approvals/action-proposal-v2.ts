import { DateTime, Effect } from 'effect';

import { computeCanonicalValueHash } from '../../actions/repository.ts';
import type { AccessScopeId, ProposalId, TenantId } from '../ids.ts';
import { CapabilityKeySchema } from '../ids.ts';
import type { Proposal } from '../model.ts';
import { actorPrincipal } from './proposal.ts';
import { actionAuthorityQuestionsV2 } from './action-authority-v2.ts';
import type { ActionAuthorityProofV2 } from './action-authority-v2.ts';
import type { ActionCommandV2 } from './action-command-v2.ts';
import { ApprovalRefusedError, MandateRefusedError, ProposalRefusedError } from './errors.ts';
import type { ActionInvocationRef } from './execution.ts';
import { producedProposal } from './invariants.ts';
import {
  addMilliseconds,
  approvalLifetimeMillis,
  earliest,
  isApprovable,
  isIdentityBound,
  isProposable,
  proposalLifetimeMillis,
  raisesAuthority,
} from './policy.ts';
import type { GovernedCapability } from './policy.ts';
import type { ApprovalPolicy } from './approval.ts';
import type { VerifiedHumanPrincipal } from './principals.ts';

const boundedDeadline = (deadline: Date, proof: ActionAuthorityProofV2): Date =>
  proof.admissionDeadline === undefined
    ? deadline
    : earliest(deadline, DateTime.toDateUtc(DateTime.makeUnsafe(proof.admissionDeadline)));

const matchesPublishedCapability = (command: ActionCommandV2, capability: GovernedCapability): boolean => {
  const { declaration } = command;
  return (
    capability.capabilityKey === CapabilityKeySchema.make(declaration.key) &&
    capability.kind === declaration.kind &&
    capability.risk === declaration.risk &&
    (capability.ephemeral === true) === (declaration.ephemeral === true) &&
    computeCanonicalValueHash(capability.modes.toSorted()) ===
      computeCanonicalValueHash(declaration.modes.toSorted()) &&
    computeCanonicalValueHash(capability.selectors.toSorted()) ===
      computeCanonicalValueHash(declaration.selectors.toSorted())
  );
};

const sameBoundProof = (saved: ActionAuthorityProofV2, current: ActionAuthorityProofV2): boolean => {
  const { admissionDeadline: savedDeadline, ...savedBinding } = saved;
  const { admissionDeadline: currentDeadline, ...currentBinding } = current;
  return (
    computeCanonicalValueHash(savedBinding) === computeCanonicalValueHash(currentBinding) &&
    (savedDeadline === undefined || (currentDeadline !== undefined && currentDeadline <= savedDeadline))
  );
};

/**
 * Lifecycle rules over proofs already checked by the canonical gate. These functions do not acquire
 * authority, inspect intent, open a transaction, or convert historical RUN witnesses into APPROVE.
 * The service must perform prepared bound-proof rechecks before committing any resulting record.
 */
export const proposeActionV2 = Effect.fn('ActionProposal.proposeV2')(function* proposeActionV2(input: {
  readonly capability: GovernedCapability;
  readonly command: ActionCommandV2;
  readonly now: Date;
  readonly proposalId: ProposalId;
  readonly requester: VerifiedHumanPrincipal;
  readonly requesterAuthority: ActionAuthorityProofV2;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}) {
  const { capability, command, now, requesterAuthority } = input;
  if (!isProposable(capability) || !matchesPublishedCapability(command, capability)) {
    return yield* new ProposalRefusedError({
      code: capability.ephemeral === true ? 'ephemeral_not_proposable' : 'capability_not_proposable',
      reason: 'Only the published proposable Action capability can create this forward request',
    });
  }
  yield* actionAuthorityQuestionsV2(command, requesterAuthority, {
    phase: 'requester',
    principalId: input.requester.principalId,
    scopeId: input.scopeId,
  });
  const expiresAt = boundedDeadline(addMilliseconds(now, proposalLifetimeMillis()), requesterAuthority);
  if (now >= expiresAt || command.scope.tenantId !== input.tenantId) {
    return yield* new ProposalRefusedError({
      code: 'authority_witness_mismatch',
      reason: 'The complete request authority must be live in the command tenant',
    });
  }
  return yield* Effect.fromResult(
    producedProposal({
      proposal: {
        actionAuthority: requesterAuthority,
        capabilityKey: capability.capabilityKey,
        commandDigest: requesterAuthority.commandDigest,
        createdAt: now,
        expiresAt,
        id: input.proposalId,
        requester: { _tag: 'Principal', principalId: input.requester.principalId },
        scopeId: input.scopeId,
        status: 'pending',
        tenantId: input.tenantId,
        witnesses: [],
      },
    }),
  );
});

export const approveActionV2 = Effect.fn('ActionProposal.approveV2')(function* approveActionV2(input: {
  readonly approver: VerifiedHumanPrincipal;
  readonly approverAuthority: ActionAuthorityProofV2;
  readonly capability: GovernedCapability;
  readonly command: ActionCommandV2;
  readonly currentRequesterAuthority: ActionAuthorityProofV2;
  readonly now: Date;
  readonly policy: ApprovalPolicy;
  readonly proposal: Proposal;
}) {
  const { approver, capability, command, now, proposal } = input;
  if (proposal.status !== 'pending') {
    return yield* new ApprovalRefusedError({
      code: 'proposal_not_pending',
      reason: 'Only a pending request can be approved',
    });
  }
  if (now >= proposal.expiresAt) {
    return yield* new ApprovalRefusedError({ code: 'proposal_expired', reason: 'The request expired before approval' });
  }
  if (
    isIdentityBound(capability) ||
    !isApprovable(capability) ||
    capability.capabilityKey !== proposal.capabilityKey ||
    !matchesPublishedCapability(command, capability)
  ) {
    return yield* new ApprovalRefusedError({
      code: isIdentityBound(capability) ? 'identity_bound_action' : 'capability_not_approvable',
      reason: 'This published Action does not permit this approval',
    });
  }
  if (
    actorPrincipal(proposal.requester) === approver.principalId &&
    (raisesAuthority(capability) || input.policy.selfApproval === 'forbidden')
  ) {
    return yield* new ApprovalRefusedError({
      code: raisesAuthority(capability) ? 'independent_approver_required' : 'self_approval_forbidden',
      reason: 'This command requires an independent approver',
    });
  }
  if (
    proposal.actionAuthority === undefined ||
    !sameBoundProof(proposal.actionAuthority, input.currentRequesterAuthority)
  ) {
    return yield* new ApprovalRefusedError({
      code: 'requester_authority_lost',
      reason: 'Every original requester authority must still be bound and current',
    });
  }
  yield* actionAuthorityQuestionsV2(command, input.currentRequesterAuthority, {
    phase: 'requester',
    principalId: actorPrincipal(proposal.requester),
    scopeId: proposal.scopeId,
  });
  yield* actionAuthorityQuestionsV2(command, input.approverAuthority, {
    phase: 'approver',
    principalId: approver.principalId,
    scopeId: proposal.scopeId,
  });
  const expiresAt = boundedDeadline(
    boundedDeadline(
      earliest(addMilliseconds(now, approvalLifetimeMillis(capability.risk)), proposal.expiresAt),
      input.currentRequesterAuthority,
    ),
    input.approverAuthority,
  );
  if (now >= expiresAt || command.scope.tenantId !== proposal.tenantId) {
    return yield* new ApprovalRefusedError({
      code: 'proposal_expired',
      reason: 'A required authority deadline has passed',
    });
  }
  return yield* Effect.fromResult(
    producedProposal({
      from: proposal.status,
      proposal: {
        ...proposal,
        approval: {
          actionAuthority: input.approverAuthority,
          approvedAt: now,
          approverId: approver.principalId,
          expiresAt,
        },
        status: 'approved',
      },
    }),
  );
});

export const executeActionV2 = Effect.fn('ActionProposal.executeV2')(function* executeActionV2(input: {
  readonly actionInvocationId: ActionInvocationRef;
  readonly actor: VerifiedHumanPrincipal;
  readonly command: ActionCommandV2;
  readonly currentApproverAuthority: ActionAuthorityProofV2;
  readonly currentRequesterAuthority: ActionAuthorityProofV2;
  readonly now: Date;
  readonly proposal: Proposal;
}) {
  const { command, now, proposal } = input;
  const { actionAuthority, approval } = proposal;
  if (
    proposal.status !== 'approved' ||
    approval === undefined ||
    !('actionAuthority' in approval) ||
    actionAuthority === undefined
  ) {
    return yield* new MandateRefusedError({
      code: proposal.status === 'executed' ? 'proposal_already_executed' : 'proposal_not_approved',
      reason: 'Only an approved forward Action mandate executes once',
    });
  }
  if (input.actor.principalId !== approval.approverId || command.scope.tenantId !== proposal.tenantId) {
    return yield* new MandateRefusedError({
      code: 'execution_not_permitted',
      reason: 'Only the approving human can execute this mandate in its tenant',
    });
  }
  if (now >= approval.expiresAt || now >= proposal.expiresAt) {
    return yield* new MandateRefusedError({ code: 'proposal_expired', reason: 'The approved command has expired' });
  }
  if (
    !sameBoundProof(actionAuthority, input.currentRequesterAuthority) ||
    !sameBoundProof(approval.actionAuthority, input.currentApproverAuthority)
  ) {
    return yield* new MandateRefusedError({
      code: 'authority_lost',
      reason: 'Every original request and approval authority must remain current',
    });
  }
  yield* Effect.forEach(
    [
      [input.currentRequesterAuthority, 'requester', actorPrincipal(proposal.requester)],
      [input.currentApproverAuthority, 'approver', approval.approverId],
    ] as const,
    Effect.fn('ActionProposal.checkExecutionProofV2')(function* checkExecutionProof([proof, phase, principalId]) {
      yield* actionAuthorityQuestionsV2(command, proof, { phase, principalId, scopeId: proposal.scopeId });
      if (proof.admissionDeadline !== undefined && now.getTime() >= proof.admissionDeadline) {
        return yield* new MandateRefusedError({
          code: 'proposal_expired',
          reason: 'A bound authority deadline has passed',
        });
      }
      return yield* Effect.void;
    }),
    { concurrency: 1 },
  );
  return yield* Effect.fromResult(
    producedProposal({
      from: proposal.status,
      proposal: {
        ...proposal,
        execution: { actionInvocationId: input.actionInvocationId, executedAt: now },
        status: 'executed',
      },
    }),
  );
});
