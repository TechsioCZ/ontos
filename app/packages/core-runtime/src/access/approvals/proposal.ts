import { Predicate, Result } from 'effect';

import type {
  AccessScopeId,
  AssignmentIncarnationId,
  CapabilityKey,
  CommandDigest,
  GrantIncarnationId,
  PrincipalId,
  ProposalId,
  RecordKey,
  TenantId,
} from '../ids.ts';
import type { ActorContext, AuthorityWitness, Holder, Proposal, WitnessPurpose } from '../model.ts';
import { actorHolder, holderKey, sameHolder, witnessPurposeMode } from '../model.ts';
import { ProposalRefusedError } from './errors.ts';
import type { ProposalRefusalCode, ProposalIntegrityError } from './errors.ts';
import { producedProposal } from './invariants.ts';
import { addMilliseconds, isProposable, isProposableByAgent, proposalLifetimeMillis } from './policy.ts';
import type { GovernedCapability } from './policy.ts';

/** One exact path through a capability: the holder, the scope and the grant cell it uses. */
export interface BoundWitness {
  readonly assignmentIncarnationId: AssignmentIncarnationId;
  readonly capabilityKey: CapabilityKey;
  readonly grantIncarnationId: GrantIncarnationId;
  /** The holder of the bound assignment: the actor itself, never the person an agent acts for. */
  readonly holderId: Holder;
  /** The scope of the assignment and of the grant cell; always the proposal's own scope (O49). */
  readonly scopeId: AccessScopeId;
}

export const boundWitnessSlot = (witness: BoundWitness): string =>
  `${holderKey(witness.holderId)} ${witness.scopeId} ${witness.assignmentIncarnationId} ${witness.grantIncarnationId} ${witness.capabilityKey}`;

/** Two purposes of one cell stay distinct; a repeated identical witness collapses. */
export const uniqueBoundWitnesses = (witnesses: readonly BoundWitness[]): readonly BoundWitness[] => [
  ...new Map(witnesses.map((witness) => [boundWitnessSlot(witness), witness])).values(),
];

/** The purpose decides the mode the cell must be held in, so a caller cannot pick it (R2-H1). */
export const witnessOf = (purpose: WitnessPurpose, bound: BoundWitness): AuthorityWitness => ({
  assignmentIncarnationId: bound.assignmentIncarnationId,
  capabilityKey: bound.capabilityKey,
  grantIncarnationId: bound.grantIncarnationId,
  holderId: bound.holderId,
  mode: witnessPurposeMode(purpose),
  purpose,
  scopeId: bound.scopeId,
});

/**
 * The first witness that is not the expected holder's own cell in this capability and scope. A
 * caller may hand in anybody's live assignment and grant, so the holder, the scope and the
 * capability are all compared here instead of being taken on trust (R2-H1, guarantee 5).
 */
export const foreignWitness = (input: {
  readonly capabilityKey: CapabilityKey;
  readonly expectedHolder: Holder;
  readonly scopeId: AccessScopeId;
  readonly witnesses: readonly BoundWitness[];
}): BoundWitness | undefined =>
  input.witnesses.find(
    (witness) =>
      witness.capabilityKey !== input.capabilityKey ||
      witness.scopeId !== input.scopeId ||
      !sameHolder(witness.holderId, input.expectedHolder),
  );

/** The person on whose behalf the actor works; an agent never replaces them (guarantee 4). */
export const actorPrincipal = (actor: ActorContext): PrincipalId => actor.principalId;

const refusal = (code: ProposalRefusalCode, reason: string): Result.Result<never, ProposalRefusedError> =>
  Result.fail(new ProposalRefusedError({ code, reason }));

export interface PrepareProposalInput {
  /** The published declaration; risk, modes and ephemerality are read from it, never from a caller. */
  readonly capability: GovernedCapability;
  /** The canonical digest of the frozen command (O5, guarantee 5). */
  readonly commandDigest: CommandDigest;
  readonly now: Date;
  readonly proposalId: ProposalId;
  readonly requester: ActorContext;
  /** The live propose-mode authority of the requester, from the requester's own decision check. */
  readonly requesterAuthority: readonly BoundWitness[];
  readonly scopeId: AccessScopeId;
  /** The single record the command acts on, when the capability is record-scoped. */
  readonly target?: RecordKey;
  readonly tenantId: TenantId;
}

/**
 * Creates a pending proposal. A proposal is the frozen request of an agent or a person; it grants
 * nothing, and it can only reach execution through a person's mandate (S5, guarantee 2).
 */
export const propose = (
  input: PrepareProposalInput,
): Result.Result<Proposal, ProposalIntegrityError | ProposalRefusedError> => {
  const { capability } = input;
  if (capability.ephemeral === true) {
    return refusal(
      'ephemeral_not_proposable',
      'A command whose validity lasts seconds or minutes cannot wait for a person',
    );
  }
  if (!isProposable(capability)) {
    return refusal('capability_not_proposable', 'The declaration does not support the propose mode');
  }
  if (Predicate.isTagged(input.requester, 'Agent') && !isProposableByAgent(capability)) {
    return refusal('agent_cannot_propose', 'An agent never proposes an administrative command');
  }
  const foreign = foreignWitness({
    capabilityKey: capability.capabilityKey,
    expectedHolder: actorHolder(input.requester),
    scopeId: input.scopeId,
    witnesses: input.requesterAuthority,
  });
  if (foreign !== undefined) {
    return refusal(
      'authority_witness_mismatch',
      'Requester authority was checked for another holder, scope or capability',
    );
  }
  const [firstWitness, ...restWitnesses] = uniqueBoundWitnesses(input.requesterAuthority);
  if (firstWitness === undefined) {
    return refusal('requester_authority_missing', 'The requester holds no live propose authority for this command');
  }
  const witnesses: readonly [AuthorityWitness, ...AuthorityWitness[]] = [
    witnessOf('requester', firstWitness),
    ...restWitnesses.map((witness) => witnessOf('requester', witness)),
  ];
  const proposal: Proposal = {
    capabilityKey: capability.capabilityKey,
    commandDigest: input.commandDigest,
    createdAt: input.now,
    expiresAt: addMilliseconds(input.now, proposalLifetimeMillis()),
    id: input.proposalId,
    requester: input.requester,
    scopeId: input.scopeId,
    status: 'pending',
    tenantId: input.tenantId,
    witnesses,
  };
  return producedProposal({
    proposal: input.target === undefined ? proposal : { ...proposal, target: input.target },
  });
};

/**
 * Who the withdrawing person is, as Core resolved it from its own data, never as a caller's flag
 * (O64): the requester itself, an owner/administrator of the scope, or a person who currently holds
 * `approve` authority for the proposal's capability and scope (O61).
 */
export const WITHDRAWAL_ELIGIBILITY = ['administrator', 'approver', 'requester'] as const;
export type WithdrawalEligibility = (typeof WITHDRAWAL_ELIGIBILITY)[number];

export interface WithdrawProposalInput {
  readonly actor: ActorContext;
  /** Resolved by Core from the scope's administration and the person's own authority (O61, O64). */
  readonly eligibility: WithdrawalEligibility;
  readonly now: Date;
  readonly proposal: Proposal;
}

/**
 * Withdraws a proposal or a mandate that has not executed. Withdrawal is the one transition that is
 * always available to its own holder, so it needs no adoption and no approval (O35). Anybody else
 * needs the eligibility that rejection needs — approve authority in the proposal's scope, or the
 * scope's administration — and an agent never ends another holder's proposal (O61, O64).
 *
 * A pending proposal is rejected; an approved mandate lapses and keeps its approval record, because
 * the model and the SQL trigger both refuse `approved → rejected` (O57).
 */
export const withdraw = (
  input: WithdrawProposalInput,
): Result.Result<Proposal, ProposalIntegrityError | ProposalRefusedError> => {
  const { proposal } = input;
  if (proposal.status !== 'pending' && proposal.status !== 'approved') {
    return refusal('proposal_not_withdrawable', 'Only a proposal or an unexecuted mandate can be withdrawn');
  }
  const withdrawing = actorPrincipal(input.actor);
  if (input.eligibility === 'requester') {
    if (!sameHolder(actorHolder(input.actor), actorHolder(proposal.requester))) {
      return refusal('withdrawal_not_permitted', 'Only the requester withdraws the request it made itself');
    }
  } else if (Predicate.isTagged(input.actor, 'Agent')) {
    return refusal(
      'withdrawal_by_agent_forbidden',
      'An agent never ends another holder\u2019s proposal, even as an administrator or an approver',
    );
  }
  const withdrawn: Proposal =
    proposal.status === 'pending'
      ? { ...proposal, endedAt: input.now, rejectedBy: withdrawing, status: 'rejected' }
      : { ...proposal, endedAt: input.now, status: 'lapsed' };
  return producedProposal({ from: proposal.status, proposal: withdrawn });
};
