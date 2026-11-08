import { Context, Effect, Option, Predicate, Result } from 'effect';
import type { CoreTransaction } from '../../db/types.ts';
import type { FrozenCommand } from './command.ts';
import { freezeCommand } from './command.ts';
import type { ActionKey, FrozenCommandRecord } from './frozen-command.ts';
import { proposalIdForInvocation } from './proposal-invocation-id.ts';

import type {
  AccessScopeId,
  CapabilityKey,
  CommandDigest,
  PrincipalId,
  ProposalId,
  RecordKey,
  TenantId,
} from '../ids.ts';
import type { ActorContext, AuthorityWitness, Holder, Proposal, ProposalStatus } from '../model.ts';
import { actorHolder, sameHolder } from '../model.ts';
import { withOptional } from '../decision/optional.ts';
import { approve, reject } from './approval.ts';
import type { ApprovalPolicy, MandateAuthority } from './approval.ts';
import {
  ApprovalAuthorityUnavailableError,
  ApprovalRefusedError,
  ApprovalStorageConflictError,
  CommandNotCanonicalError,
  MandateRefusedError,
  ProposalRefusedError,
} from './errors.ts';
import type { ApprovalsError, ApprovalStorageUnavailableError, ProposalIntegrityError } from './errors.ts';
import { authorityFailure, execute, liveWitnesses, mergeWitnessAuthority, witnessAuthorityMap } from './execution.ts';
import type { ActionInvocationRef, WitnessAuthorityMap, WitnessExpectation, WitnessFacts } from './execution.ts';
import { producedProposal } from './invariants.ts';
import { assessAuthorityLoss, assessWitnessAuthority, expireProposal, lapseCauseOf, lapseProposal } from './lapse.ts';
import type { AuthorityLoss, AuthorityLossCause } from './lapse.ts';
import { subjectActorTag, verifyHumanPrincipal } from './principals.ts';
import type { ResolvedPrincipalKind } from './principals.ts';
import type { GovernedCapability } from './policy.ts';
import { actorPrincipal, foreignWitness, propose, uniqueBoundWitnesses, witnessOf, withdraw } from './proposal.ts';
import type { BoundWitness } from './proposal.ts';
import type { LiveApprovalServices } from './live-composition.ts';
import { liveApprovalsPorts } from './live-composition.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { preparedActionExecutionV2, preparedActionProposalV2 } from './action-lifecycle-v2.ts';
import type {
  ActionApprovalLifecycleV2,
  PreparedActionExecutionV2,
  PreparedActionProposalV2,
} from './action-lifecycle-v2.ts';

/** Core-private prepared continuations, carried only by the existing transaction-joining API. */
export interface ApprovalExecutionContext {
  readonly [preparedActionExecutionV2]?: PreparedActionExecutionV2;
  readonly [preparedActionProposalV2]?: PreparedActionProposalV2;
  readonly transaction: CoreTransaction;
}

/** Every approval operation runs inside one trusted tenant and one exact access scope (O7). */
export interface ProposalScope {
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

/**
 * The reach of an authority loss: one exact scope, or every scope of the tenant when the loss is
 * reported at tenant context (R2-H7).
 */
export interface TenantScope {
  readonly scopeId?: AccessScopeId;
  readonly tenantId: TenantId;
}

/**
 * The evidence one decision leaves behind when the record alone does not carry it. A rejection or
 * another person's withdrawal names the deciding person, the ground it rests on and the live
 * approve-mode authority it relied on, so the decision log can answer "Proč?" without re-deriving it
 * and can tell an administrator's decision from a missing witness (O61, R3b-N10).
 */
export interface ApprovalDecisionEvidence {
  /** The ground that admitted the decision: the scope's administration or the person's own authority. */
  readonly basis: DeciderBasis;
  /** The person who took the decision; the proposal row carries the same id in `rejectedBy`. */
  readonly decidedBy: PrincipalId;
  /** The live approve witnesses behind an eligible-approver decision; empty for an administrator. */
  readonly witnesses: readonly AuthorityWitness[];
}

/** Which fact made somebody an eligible decider of a proposal they do not own (O61). */
export const DECIDER_BASES = ['administrator', 'approver'] as const;
export type DeciderBasis = (typeof DECIDER_BASES)[number];

/**
 * The proposal and mandate records. `save` is a compare-and-set on the status, so a second execution
 * cannot overwrite the first receipt and a lapse cannot be undone by a stale writer. The person's path
 * (`save`) proves the acting person of the status it writes; the workload's own ends (a deadline, a
 * lost authority) have their own method so no scope can write them on somebody's behalf (R4-H1).
 */
export interface ApprovalProposalRecords {
  readonly create: (
    proposal: Proposal,
  ) => Effect.Effect<void, ApprovalStorageConflictError | ApprovalStorageUnavailableError>;
  /**
   * Inserts proposal and immutable owner command in one scoped transaction (O75). The stored proposal
   * comes back, so a retried Action invocation answers its own receipt instead of parking a second
   * proposal, and a different binding under the same invocation is a storage conflict (O90.4).
   */
  readonly createWithFrozenCommand?: (input: {
    readonly actionInvocationId?: ActionInvocationRef | undefined;
    readonly frozen: FrozenCommandRecord;
    readonly proposal: Proposal;
    readonly transaction?: CoreTransaction | undefined;
  }) => Effect.Effect<Proposal, ApprovalStorageConflictError | ApprovalStorageUnavailableError>;
  /** The runner's transaction owns the mandate receipt and the owner Action commit together (O75). */
  readonly executeInTransaction?: (
    input: { readonly expectedStatus: 'approved'; readonly proposal: Proposal },
    transaction: CoreTransaction,
  ) => Effect.Effect<void, ApprovalStorageConflictError | ApprovalStorageUnavailableError>;
  readonly listOpen: (input: TenantScope) => Effect.Effect<readonly Proposal[], ApprovalStorageUnavailableError>;
  readonly load: (
    input: ProposalScope & { readonly proposalId: ProposalId },
  ) => Effect.Effect<Option.Option<Proposal>, ApprovalStorageUnavailableError>;
  /**
   * The workload's own end of a proposal: the deadline passed or the authority it rests on was lost.
   * It names no acting person, and it is the only path to `expired` and to the `lapsed` proposal
   * nobody withdrew (R4-H1).
   */
  readonly recordEnd: (input: {
    readonly expectedStatus: ProposalStatus;
    readonly proposal: Proposal;
    readonly reason: string;
  }) => Effect.Effect<void, ApprovalStorageConflictError | ApprovalStorageUnavailableError>;
  /**
   * Records the transition, why it ended and, for a rejection, the evidence behind it. It is the
   * person's own path: the store refuses a status the acting person cannot be proved to be (R4-H1).
   */
  readonly save: (input: {
    readonly evidence?: ApprovalDecisionEvidence;
    readonly expectedStatus: ProposalStatus;
    readonly proposal: Proposal;
    readonly reason?: string;
  }) => Effect.Effect<void, ApprovalStorageConflictError | ApprovalStorageUnavailableError>;
}

/** The published declaration of the capability a proposal is bound to; never a caller's claim. */
export interface ApprovalCapabilityCatalog {
  readonly lookup: (
    capabilityKey: CapabilityKey,
  ) => Effect.Effect<Option.Option<GovernedCapability>, ApprovalStorageUnavailableError>;
}

/**
 * Reports what Core's access projection knows about one purpose group of bound witnesses. Core
 * derives the mandate verdict itself, including the holder, the cell mode, the scope and the
 * role-binding membership, so the engine answer alone is never enough (O49, R2-H1). A projection
 * that cannot answer is a retryable failure, never a denial.
 */
export interface ApprovalAuthorityInspector {
  readonly inspect: (
    input: ProposalScope & {
      /** The holder every witness in this group must belong to; never a caller's claim (O63). */
      readonly expectedHolder: Holder;
      /** The record the command changes, when it names one (P5, N6). */
      readonly target?: RecordKey;
      readonly witnesses: readonly AuthorityWitness[];
    },
  ) => Effect.Effect<readonly WitnessFacts[], ApprovalAuthorityUnavailableError>;
}

/**
 * Whether a person is an owner or administrator of one exact scope (O61). Core resolves it from its
 * own membership and role data; it is never a caller's claim and never a hard-coded `true`. A
 * projection that cannot answer is a retryable failure, never a denial.
 */
export interface ApprovalScopeAdministration {
  readonly isAdministrator: (
    input: ProposalScope & { readonly principalId: PrincipalId },
  ) => Effect.Effect<boolean, ApprovalAuthorityUnavailableError>;
}

export interface ApprovalClock {
  readonly now: Effect.Effect<Date>;
}

export interface ApprovalIdentifiers {
  readonly nextProposalId: Effect.Effect<ProposalId, ApprovalStorageUnavailableError>;
}

export interface ApprovalsPorts {
  readonly actionCommands?: {
    readonly lifecycle: ActionApprovalLifecycleV2;
    readonly scope: OperationalScope;
  };
  readonly administrators: ApprovalScopeAdministration;
  readonly authority: ApprovalAuthorityInspector;
  readonly catalog: ApprovalCapabilityCatalog;
  readonly clock: ApprovalClock;
  readonly identifiers: ApprovalIdentifiers;
  /**
   * The same ports with every read bound to a transaction the caller already owns (O75). A mandate
   * claim decides inside the owner Action's transaction, holding that transaction's proposal lock, so
   * a witness, a membership, a role binding or a record read through a second connection would be
   * proof about another instant — and one connection cannot open that transaction at all. The mandate
   * paths therefore REFUSE rather than claim: a composition that cannot answer this has no
   * transaction-bound authority and offers no `inTransaction` at all, so `execute` (and a proposal
   * parked into an owner transaction) stays unavailable. It is the same capability proof
   * `executeInTransaction` is for the records, and the joined ports read at the CALLER's isolation:
   * they open nothing, so they never claim a snapshot the caller did not open.
   */
  readonly inTransaction?: (transaction: CoreTransaction) => ApprovalsPorts;
  readonly store: ApprovalProposalRecords;
}

export interface ProposeCommand extends ProposalScope {
  /** Bound to the owner Action's terminal proposal receipt when initiated from its runner (O90). */
  readonly actionInvocationId?: ActionInvocationRef;
  readonly actionKey: ActionKey;
  readonly actor: ActorContext;
  readonly capabilityKey: CapabilityKey;
  /** The exact owner Action command to store atomically with this proposal. */
  readonly command: FrozenCommand;
  /** The canonical digest of the frozen command, from `freezeCommand`. */
  readonly commandDigest: CommandDigest;
  readonly requesterAuthority: readonly BoundWitness[];
  /** The resolved principal kind; only a human or an agent is a v2 subject (O46). */
  readonly requesterKind: ResolvedPrincipalKind;
  readonly target?: RecordKey;
}

export interface ApproveCommand extends ProposalScope {
  readonly approver: ActorContext;
  readonly approverKind: ResolvedPrincipalKind;
  /** Historical scalar callers require this. Forward Actions acquire their full canonical proof. */
  readonly authority?: MandateAuthority;
  readonly policy: ApprovalPolicy;
  readonly proposalId: ProposalId;
}

export interface RejectCommand extends ProposalScope {
  /**
   * The rejecter's live approve-mode authority for the proposal's capability, from their own
   * decision check; judged by the same inspector and witness rules as an approval (O61). A scope
   * administrator may reject without any, so this is empty for that path.
   */
  readonly approveAuthority: readonly BoundWitness[];
  readonly approver: ActorContext;
  readonly approverKind: ResolvedPrincipalKind;
  readonly proposalId: ProposalId;
}

export interface ExecuteCommand extends ProposalScope {
  readonly actionInvocationId: ActionInvocationRef;
  readonly actor: ActorContext;
  /** Recomputed from the command handed to execution; a different command is never executed. */
  readonly commandDigest: CommandDigest;
  readonly proposalId: ProposalId;
}

export interface WithdrawCommand extends ProposalScope {
  readonly actor: ActorContext;
  readonly proposalId: ProposalId;
  /**
   * The withdrawing person's own live `approve` authority for the proposal's capability, from their
   * own decision check — needed only when they are not the requester (O61, O64).
   */
  readonly withdrawAuthority: readonly BoundWitness[];
}

export interface ApprovalsService {
  readonly approve: (command: ApproveCommand) => Effect.Effect<Proposal, ApprovalsError>;
  readonly execute: (
    command: ExecuteCommand,
    execution?: ApprovalExecutionContext,
  ) => Effect.Effect<Proposal, ApprovalsError>;
  /** Ends every proposal and mandate of the scope whose deadline passed. */
  readonly expireDue: (input: ProposalScope) => Effect.Effect<readonly Proposal[], ApprovalsError>;
  readonly propose: (
    command: ProposeCommand,
    execution?: ApprovalExecutionContext,
  ) => Effect.Effect<Proposal, ApprovalsError>;
  /** Re-reads bound witnesses after a role edit; an equal-or-broader edit keeps the mandate (D1). */
  readonly recheckAuthority: (
    input: ProposalScope & { readonly proposalId: ProposalId },
  ) => Effect.Effect<Proposal, ApprovalsError>;
  /** Ends every proposal that depends on the authority this loss removed (D1, D26, D28). */
  readonly recordAuthorityLoss: (loss: AuthorityLoss) => Effect.Effect<readonly Proposal[], ApprovalsError>;
  /** "Zamítnout": an eligible approver or a scope administrator declines a pending proposal (O61). */
  readonly reject: (command: RejectCommand) => Effect.Effect<Proposal, ApprovalsError>;
  readonly withdraw: (command: WithdrawCommand) => Effect.Effect<Proposal, ApprovalsError>;
}

export class Approvals extends Context.Service<Approvals, ApprovalsService>()(
  '@app/core-runtime/access/approvals/service/Approvals',
) {}

const purposeWitnesses = (
  purpose: AuthorityWitness['purpose'],
  witnesses: readonly BoundWitness[],
): readonly AuthorityWitness[] => uniqueBoundWitnesses(witnesses).map((witness) => witnessOf(purpose, witness));

const authorityUnavailable = (reason: string): ApprovalAuthorityUnavailableError =>
  new ApprovalAuthorityUnavailableError({ code: 'approval_authority_unavailable', reason });

const notFound = (): ApprovalRefusedError =>
  new ApprovalRefusedError({ code: 'proposal_not_found', reason: 'No proposal exists in this scope' });

/**
 * The ports one step reads through: the scope's own for a request, or the same ports with every read
 * bound to the transaction the caller handed over (O75). `None` is a composition that cannot answer
 * that, which is unavailability — never a read of another connection's snapshot.
 */
const stepPorts = (
  ports: ApprovalsPorts,
  execution?: { readonly transaction: CoreTransaction },
): Option.Option<ApprovalsPorts> =>
  execution === undefined ? Option.some(ports) : Option.fromUndefinedOr(ports.inTransaction?.(execution.transaction));

/** The actor tag and the resolved principal kind must agree before anything is proposed (O46). */
const isConsistentSubject = (actor: ActorContext, kind: ResolvedPrincipalKind): boolean => {
  const expected = subjectActorTag(kind);
  return expected !== undefined && Predicate.isTagged(actor, expected);
};

const requesterWitnessesOf = (witnesses: readonly AuthorityWitness[]): readonly AuthorityWitness[] =>
  witnesses.filter(({ purpose }) => purpose === 'requester');

const approverWitnessesOf = (witnesses: readonly AuthorityWitness[]): readonly AuthorityWitness[] =>
  witnesses.filter(({ purpose }) => purpose !== 'requester');

/** A person's holder; an agent's holder is only ever taken from the actor itself (guarantee 4). */
const principalHolder = (principalId: PrincipalId): Holder => ({ _tag: 'Principal', principalId });

/**
 * O90.4: the proposal the store answered must be the one this command names. A store that handed back
 * anything else proposed somebody else's command, so the caller is refused instead of being answered.
 */
const storedProposalMatches = (input: {
  readonly capabilityKey: CapabilityKey;
  readonly commandDigest: CommandDigest;
  readonly proposalId: ProposalId;
  readonly scopeId: AccessScopeId;
  readonly stored: Proposal;
  readonly tenantId: TenantId;
}): boolean =>
  input.stored.id === input.proposalId &&
  input.stored.tenantId === input.tenantId &&
  input.stored.scopeId === input.scopeId &&
  input.stored.capabilityKey === input.capabilityKey &&
  input.stored.commandDigest === input.commandDigest;

const canonicalProposedCommand = (command: ProposeCommand): boolean => {
  const digest = freezeCommand(command.command);
  return (
    Result.isSuccess(digest) &&
    digest.success === command.commandDigest &&
    command.command.capabilityKey === command.capabilityKey &&
    command.command.target === command.target &&
    command.actionKey.length > 0
  );
};

/** Every record leaves this service through the model's own integrity gate (R2-M5). */
const produced = (
  from: ProposalStatus | undefined,
  proposal: Proposal,
): Effect.Effect<Proposal, ProposalIntegrityError> =>
  from === undefined
    ? Effect.fromResult(producedProposal({ proposal }))
    : Effect.fromResult(producedProposal({ from, proposal }));

/**
 * Proposals and mandates. Everything a caller can influence is a command; risk, modes, deadlines and
 * authority are re-read from the catalog, the repository and the decision engine on every step.
 */
export const makeApprovalsService = (ports: ApprovalsPorts): ApprovalsService => {
  /**
   * The published capability this command is bound to, read from the catalog the caller's step is
   * bound to: the scope's own catalog for a request, or the one joined to the owner transaction when a
   * proposal is parked inside it (O75).
   */
  const lookupCapability = Effect.fn('Approvals.lookupCapability')(function* lookupCapabilityEffect(
    capabilityKey: CapabilityKey,
    catalog: ApprovalCapabilityCatalog,
  ) {
    const found = yield* catalog.lookup(capabilityKey);
    return Option.isNone(found) ? undefined : found.value;
  });

  const inspectAuthority = Effect.fn('Approvals.inspectAuthority')(function* inspectAuthorityEffect(
    input: {
      readonly expectedHolder: Holder;
      readonly scopeId: AccessScopeId;
      readonly target?: RecordKey;
      readonly tenantId: TenantId;
      readonly witnesses: readonly AuthorityWitness[];
    },
    authority: ApprovalAuthorityInspector,
  ): Effect.fn.Return<WitnessAuthorityMap, ApprovalAuthorityUnavailableError> {
    const expectation: WitnessExpectation = withOptional(
      { expectedHolder: input.expectedHolder, scopeId: input.scopeId },
      'target',
      input.target,
    );
    if (input.witnesses.length === 0) {
      return witnessAuthorityMap([], expectation);
    }
    const facts = yield* authority.inspect(input);
    return witnessAuthorityMap(facts, expectation);
  });

  /**
   * Reads both purpose groups of one proposal with the holder each group belongs to (R2-H1). The
   * requester group is the requester's own holder; the approver group is the approver's own person,
   * never the requester (O63).
   */
  const inspectProposalAuthority = Effect.fn('Approvals.inspectProposalAuthority')(
    function* inspectProposalAuthorityEffect(
      input: {
        readonly proposal: Proposal;
        readonly scopeId: AccessScopeId;
        readonly tenantId: TenantId;
      },
      authority: ApprovalAuthorityInspector,
    ): Effect.fn.Return<WitnessAuthorityMap, ApprovalAuthorityUnavailableError> {
      const { proposal } = input;
      if (proposal.actionAuthority !== undefined) {
        return yield* authorityUnavailable('A forward Action requires complete per-question authority currentness');
      }
      const group = { scopeId: input.scopeId, tenantId: input.tenantId };
      const requesterAuthority = yield* inspectAuthority(
        withOptional(
          {
            ...group,
            expectedHolder: actorHolder(proposal.requester),
            witnesses: requesterWitnessesOf(proposal.witnesses),
          },
          'target',
          proposal.target,
        ),
        authority,
      );
      const approverId = proposal.approval?.approverId;
      const approverWitnesses = approverWitnessesOf(proposal.witnesses);
      if (approverId === undefined || approverWitnesses.length === 0) {
        return requesterAuthority;
      }
      const approverAuthority = yield* inspectAuthority(
        withOptional(
          {
            ...group,
            expectedHolder: principalHolder(approverId),
            witnesses: approverWitnesses,
          },
          'target',
          proposal.target,
        ),
        authority,
      );
      return mergeWitnessAuthority(requesterAuthority, approverAuthority);
    },
  );

  /**
   * Why a person other than the requester may end this proposal (O61, O64): they administer the scope,
   * which Core answers from its own data, or they currently hold live `approve` authority for the
   * proposal's own capability in its scope. `None` means they are not an eligible decider at all, and
   * an unanswered authority check is a retryable failure, never a refusal.
   */
  const eligibleDecider = Effect.fn('Approvals.eligibleDecider')(function* eligibleDeciderEffect(input: {
    readonly actor: PrincipalId;
    readonly capabilityKey: CapabilityKey;
    readonly offered: readonly BoundWitness[];
    readonly scopeId: AccessScopeId;
    readonly tenantId: TenantId;
  }): Effect.fn.Return<
    Option.Option<{ readonly basis: DeciderBasis; readonly witnesses: readonly AuthorityWitness[] }>,
    ApprovalAuthorityUnavailableError | ApprovalRefusedError
  > {
    const expectedHolder = principalHolder(input.actor);
    const foreign = foreignWitness({
      capabilityKey: input.capabilityKey,
      expectedHolder,
      scopeId: input.scopeId,
      witnesses: input.offered,
    });
    if (foreign !== undefined) {
      return yield* new ApprovalRefusedError({
        code: 'authority_witness_mismatch',
        reason: 'Deciding authority was checked for another holder, scope or capability',
      });
    }
    const offered = purposeWitnesses('approval', input.offered);
    const [administrator, authority] = yield* Effect.all(
      [
        ports.administrators.isAdministrator({
          principalId: input.actor,
          scopeId: input.scopeId,
          tenantId: input.tenantId,
        }),
        inspectAuthority(
          {
            expectedHolder,
            scopeId: input.scopeId,
            tenantId: input.tenantId,
            witnesses: offered,
          },
          ports.authority,
        ),
      ],
      { concurrency: 1 },
    );
    const failure = authorityFailure(authority, offered);
    if (!administrator && failure === 'unavailable') {
      return yield* authorityUnavailable('The authority to decide this proposal could not be checked');
    }
    const witnesses = administrator && failure !== undefined ? [] : liveWitnesses(authority, offered);
    if (!administrator && witnesses.length === 0) {
      return Option.none();
    }
    return Option.some({ basis: witnesses.length === 0 ? 'administrator' : 'approver', witnesses });
  });

  const persistLapse = Effect.fn('Approvals.persistLapse')(function* persistLapseEffect(input: {
    readonly authorityLoss: AuthorityLossCause;
    readonly now: Date;
    readonly proposal: Proposal;
  }) {
    const lapsed = lapseProposal(input);
    if (lapsed === input.proposal) {
      return input.proposal;
    }
    const checked = yield* produced(input.proposal.status, lapsed);
    // A lapse is nobody's decision: it goes through the workload's own end of the record, so the
    // person's path never carries a status it cannot attribute (R4-H1).
    yield* ports.store.recordEnd({
      expectedStatus: input.proposal.status,
      proposal: checked,
      reason: input.authorityLoss,
    });
    return checked;
  });

  const proposeCommand = Effect.fn('Approvals.propose')(function* proposeEffect(
    command: ProposeCommand,
    execution?: ApprovalExecutionContext,
  ) {
    /*
     * A proposal parked inside an owner Action is recorded in that Action's transaction (O90), so the
     * authority it is bound to is read there too: the requester's live witnesses and the published
     * capability come from what the parking transaction sees, and a composition that cannot answer
     * that stays unavailable instead of parking a proposal on a second connection's word (O75).
     */
    const active = yield* Effect.fromOption(stepPorts(ports, execution), () =>
      authorityUnavailable('The authority behind this proposal cannot be read inside its own owner transaction'),
    );
    const preparedCommand = execution?.[preparedActionProposalV2];
    if (preparedCommand !== undefined) {
      if (execution === undefined || active.actionCommands === undefined) {
        return yield* authorityUnavailable('The forward registered Action proposal lifecycle is unavailable');
      }
      return yield* active.actionCommands.lifecycle.propose({
        command,
        preparation: preparedCommand,
        scope: active.actionCommands.scope,
        transaction: execution.transaction,
      });
    }
    if (!isConsistentSubject(command.actor, command.requesterKind)) {
      return yield* new ProposalRefusedError({
        code: 'requester_not_v2_subject',
        reason: 'Only a verified person or an agent proposes; a workload never does',
      });
    }
    const capability = yield* lookupCapability(command.capabilityKey, active.catalog);
    if (capability === undefined) {
      return yield* new ProposalRefusedError({
        code: 'capability_not_proposable',
        reason: 'The capability is not published in the catalog',
      });
    }
    const requesterAuthority = purposeWitnesses('requester', command.requesterAuthority);
    if (requesterAuthority.length === 0) {
      return yield* new ProposalRefusedError({
        code: 'requester_authority_missing',
        reason: 'The requester holds no live propose authority for this command',
      });
    }
    const authority = yield* inspectAuthority(
      {
        expectedHolder: actorHolder(command.actor),
        scopeId: command.scopeId,
        tenantId: command.tenantId,
        witnesses: requesterAuthority,
      },
      active.authority,
    );
    const failure = authorityFailure(authority, requesterAuthority);
    if (failure === 'unavailable') {
      return yield* authorityUnavailable('The requester authority could not be checked');
    }
    if (failure === 'lost') {
      return yield* new ProposalRefusedError({
        code: 'requester_authority_missing',
        reason: 'The requester no longer holds the authority this proposal needs',
      });
    }
    if (!canonicalProposedCommand(command)) {
      return yield* new CommandNotCanonicalError({
        code: 'command_not_canonical',
        reason: 'The stored owner command must match the proposed capability, target and digest',
      });
    }
    if (active.store.createWithFrozenCommand === undefined) {
      return yield* authorityUnavailable('The durable frozen-command writer is unavailable');
    }
    if (command.actionInvocationId !== undefined && execution === undefined) {
      return yield* authorityUnavailable('An Action proposal must join its owner invocation transaction');
    }
    const proposalId =
      command.actionInvocationId === undefined
        ? yield* ports.identifiers.nextProposalId
        : proposalIdForInvocation(command.tenantId, command.actionInvocationId);
    const now = yield* ports.clock.now;
    const proposalInput = {
      capability,
      commandDigest: command.commandDigest,
      now,
      proposalId,
      requester: command.actor,
      requesterAuthority: liveWitnesses(authority, requesterAuthority).map((witness) => ({
        assignmentIncarnationId: witness.assignmentIncarnationId,
        capabilityKey: witness.capabilityKey,
        grantIncarnationId: witness.grantIncarnationId,
        holderId: witness.holderId,
        scopeId: witness.scopeId,
      })),
      scopeId: command.scopeId,
      tenantId: command.tenantId,
    };
    const prepared =
      command.target === undefined ? propose(proposalInput) : propose({ ...proposalInput, target: command.target });
    if (Result.isFailure(prepared)) {
      return yield* prepared.failure;
    }
    const stored = yield* active.store.createWithFrozenCommand({
      actionInvocationId: command.actionInvocationId,
      frozen: {
        actionKey: command.actionKey,
        command: command.command,
        commandDigest: command.commandDigest,
        proposalId,
        scopeId: command.scopeId,
        tenantId: command.tenantId,
      },
      proposal: prepared.success,
      transaction: execution?.transaction,
    });
    if (
      !storedProposalMatches({
        capabilityKey: command.capabilityKey,
        commandDigest: command.commandDigest,
        proposalId,
        scopeId: command.scopeId,
        stored,
        tenantId: command.tenantId,
      })
    ) {
      return yield* new ApprovalStorageConflictError({
        code: 'approval_storage_conflict',
        reason: 'The stored proposal is not the one this Action invocation proposed',
      });
    }
    return stored;
  });

  const approveCommand = Effect.fn('Approvals.approve')(function* approveEffect(command: ApproveCommand) {
    if (Predicate.isTagged(command.approver, 'Agent')) {
      return yield* new ApprovalRefusedError({
        code: 'approver_not_human',
        reason: 'Only a person approves; an agent never does',
      });
    }
    const verified = verifyHumanPrincipal({
      principalId: command.approver.principalId,
      principalKind: command.approverKind,
    });
    if (Result.isFailure(verified)) {
      return yield* verified.failure;
    }
    const approver = verified.success;
    const stored = yield* ports.store.load(command);
    if (Option.isNone(stored)) {
      return yield* notFound();
    }
    const proposal = stored.value;
    if (proposal.actionAuthority !== undefined) {
      if (ports.actionCommands === undefined) {
        return yield* authorityUnavailable('The original full-target Action approval lifecycle is unavailable');
      }
      return yield* ports.actionCommands.lifecycle.approve({
        command,
        proposal,
        scope: ports.actionCommands.scope,
      });
    }
    if (command.authority === undefined) {
      return yield* new ApprovalRefusedError({
        code: 'approval_authority_missing',
        reason: 'A historical scalar approval requires its original explicit authority contract',
      });
    }
    const capability = yield* lookupCapability(proposal.capabilityKey, ports.catalog);
    if (capability === undefined) {
      return yield* new ApprovalRefusedError({
        code: 'capability_not_approvable',
        reason: 'The capability is not published in the catalog',
      });
    }
    const now = yield* ports.clock.now;
    const requesterWitnesses = requesterWitnessesOf(proposal.witnesses);
    // Approving is a check of the authority the approver has now, on the record the command changes.
    const group = { scopeId: command.scopeId, tenantId: command.tenantId };
    const requesterAuthority = yield* inspectAuthority(
      withOptional(
        {
          ...group,
          expectedHolder: actorHolder(proposal.requester),
          witnesses: requesterWitnesses,
        },
        'target',
        proposal.target,
      ),
      ports.authority,
    );
    const requesterFailure = authorityFailure(requesterAuthority, requesterWitnesses);
    if (requesterFailure === 'unavailable') {
      return yield* authorityUnavailable('The requester authority could not be re-checked');
    }
    if (requesterFailure === 'lost') {
      yield* persistLapse({ authorityLoss: 'role_lost', now, proposal });
      return yield* new ApprovalRefusedError({
        code: 'requester_authority_lost',
        reason: 'The requester lost the authority the proposal was made with',
      });
    }
    const approvalWitness = witnessOf('approval', command.authority.approval);
    const executionWitness = witnessOf('execution', command.authority.execution);
    const parentReadWitnesses = purposeWitnesses('parent_record_read', command.authority.parentRecordRead);
    const approverWitnesses = [approvalWitness, executionWitness, ...parentReadWitnesses];
    const approverAuthority = yield* inspectAuthority(
      withOptional(
        {
          ...group,
          expectedHolder: principalHolder(approver.principalId),
          witnesses: approverWitnesses,
        },
        'target',
        proposal.target,
      ),
      ports.authority,
    );
    const approvalFailure = authorityFailure(approverAuthority, [approvalWitness]);
    if (approvalFailure === 'unavailable') {
      return yield* authorityUnavailable('The approval authority could not be checked');
    }
    if (approvalFailure === 'lost') {
      return yield* new ApprovalRefusedError({
        code: 'approval_authority_missing',
        reason: 'The approver no longer holds the approve authority this command needs',
      });
    }
    const executionFailure = authorityFailure(approverAuthority, [executionWitness]);
    if (executionFailure === 'unavailable') {
      return yield* authorityUnavailable('The execution authority could not be checked');
    }
    if (executionFailure === 'lost') {
      return yield* new ApprovalRefusedError({
        code: 'execution_authority_missing',
        reason: 'The approver no longer holds the run authority this command needs',
      });
    }
    const parentReadFailure = authorityFailure(approverAuthority, parentReadWitnesses);
    if (parentReadFailure === 'unavailable') {
      return yield* authorityUnavailable('The parent record read could not be checked');
    }
    if (parentReadFailure === 'lost') {
      return yield* new ApprovalRefusedError({
        code: 'parent_record_read_missing',
        reason: 'The approver lost the read of the parent record the command changes',
      });
    }
    const approvalInput = {
      approver,
      authority: command.authority,
      capability,
      now,
      policy: command.policy,
      proposal,
    };
    // The parent read is the catalog's own entry for this command's record, never the caller's claim.
    const parentRecordReadCapabilityKey =
      proposal.target === undefined ? undefined : capability.parentRecordReadCapabilityKey;
    const approved = approve(
      withOptional(approvalInput, 'parentRecordReadCapabilityKey', parentRecordReadCapabilityKey),
    );
    if (Result.isFailure(approved)) {
      return yield* approved.failure;
    }
    yield* ports.store.save({ expectedStatus: 'pending', proposal: approved.success }).pipe(
      Effect.catchTag('ApprovalStorageConflictError', () =>
        Effect.fail(
          new ApprovalRefusedError({
            code: 'proposal_not_pending',
            reason: 'The proposal changed before this approval was stored',
          }),
        ),
      ),
    );
    return approved.success;
  });

  /**
   * "Zamítnout". Only an eligible decider rejects a pending proposal (O61): a person who currently
   * holds `approve` authority for the proposal's capability in its scope — judged by the same
   * inspector and witness rules as an approval — or an owner/administrator of that scope, which is a
   * resolved fact and never a caller's claim. The requester withdraws instead, and any other member
   * of the tenant is refused.
   */
  const rejectCommand = Effect.fn('Approvals.reject')(function* rejectEffect(command: RejectCommand) {
    if (Predicate.isTagged(command.approver, 'Agent')) {
      return yield* new ApprovalRefusedError({
        code: 'approver_not_human',
        reason: 'Only a person rejects a proposal; an agent never does',
      });
    }
    const verified = verifyHumanPrincipal({
      principalId: command.approver.principalId,
      principalKind: command.approverKind,
    });
    if (Result.isFailure(verified)) {
      return yield* verified.failure;
    }
    const approver = verified.success;
    const stored = yield* ports.store.load(command);
    if (Option.isNone(stored)) {
      return yield* notFound();
    }
    const proposal = stored.value;
    if (proposal.status !== 'pending') {
      return yield* new ApprovalRefusedError({
        code: 'proposal_not_pending',
        reason: 'Only a pending proposal can be rejected',
      });
    }
    if (approver.principalId === actorPrincipal(proposal.requester)) {
      return yield* new ApprovalRefusedError({
        code: 'requester_cannot_reject',
        reason: 'The requester withdraws their own proposal instead of rejecting it',
      });
    }
    const decider = yield* eligibleDecider({
      actor: approver.principalId,
      capabilityKey: proposal.capabilityKey,
      offered: command.approveAuthority,
      scopeId: command.scopeId,
      tenantId: command.tenantId,
    });
    if (Option.isNone(decider)) {
      return yield* new ApprovalRefusedError({
        code: 'rejection_not_permitted',
        reason: 'Only an eligible approver or a scope administrator rejects this proposal',
      });
    }
    const now = yield* ports.clock.now;
    const rejected = reject({ approver, now, proposal });
    if (Result.isFailure(rejected)) {
      return yield* rejected.failure;
    }
    yield* ports.store
      .save({
        evidence: {
          basis: decider.value.basis,
          decidedBy: approver.principalId,
          witnesses: decider.value.witnesses,
        },
        expectedStatus: 'pending',
        proposal: rejected.success,
      })
      .pipe(
        Effect.catchTag('ApprovalStorageConflictError', () =>
          Effect.fail(
            new ApprovalRefusedError({
              code: 'proposal_not_pending',
              reason: 'The proposal changed before this rejection was stored',
            }),
          ),
        ),
      );
    return rejected.success;
  });

  const executeCommand = Effect.fn('Approvals.execute')(function* executeEffect(
    command: ExecuteCommand,
    execution?: ApprovalExecutionContext,
  ) {
    /*
     * A mandate is consumed in the owner Action's transaction, under the proposal lock that transaction
     * holds. Every fact this decision rests on — the stored proposal, the requester's and the approver's
     * bound witnesses, the membership path, the role bindings — is therefore read in that SAME
     * transaction: `inTransaction` is the proof that the composition can do it, and a composition that
     * cannot is unavailable rather than proved by a second connection (O75).
     */
    if (execution === undefined) {
      return yield* authorityUnavailable('A mandate requires a transaction-joining owner Action and approvals store');
    }
    const active = yield* Effect.fromOption(stepPorts(ports, execution), () =>
      authorityUnavailable('The authority behind this mandate cannot be read inside the transaction that executes it'),
    );
    const preparation = execution[preparedActionExecutionV2];
    if (preparation !== undefined) {
      if (active.actionCommands === undefined) {
        return yield* authorityUnavailable('The prepared full-target Action execution lifecycle is unavailable');
      }
      return yield* active.actionCommands.lifecycle.execute({
        command,
        preparation,
        scope: active.actionCommands.scope,
        transaction: execution.transaction,
      });
    }
    if (active.store.executeInTransaction === undefined) {
      return yield* authorityUnavailable(
        'The approvals store of this mandate cannot write its receipt inside the owner transaction',
      );
    }
    const stored = yield* active.store.load(command);
    if (Option.isNone(stored)) {
      return yield* new MandateRefusedError({
        code: 'proposal_not_found',
        reason: 'No proposal exists in this scope',
      });
    }
    const proposal = stored.value;
    const now = yield* active.clock.now;
    const authority =
      proposal.status === 'approved'
        ? yield* inspectProposalAuthority(
            {
              proposal,
              scopeId: command.scopeId,
              tenantId: command.tenantId,
            },
            active.authority,
          )
        : witnessAuthorityMap([], { expectedHolder: actorHolder(command.actor), scopeId: command.scopeId });
    /*
     * A lost witness is refused here and nothing more: the proposal row may already be locked by the
     * runner, so a separate lapse transaction from this path could deadlock it. The regular
     * authority-loss/expiry sweep records the terminal lapse instead.
     */
    const executed = execute({
      actionInvocationId: command.actionInvocationId,
      actor: command.actor,
      commandDigest: command.commandDigest,
      now,
      proposal,
      witnessAuthority: authority,
    });
    if (Result.isFailure(executed)) {
      return yield* executed.failure;
    }
    const checked = yield* produced(proposal.status, executed.success);
    yield* active.store.executeInTransaction({ expectedStatus: 'approved', proposal: checked }, execution.transaction);
    return checked;
  });

  /**
   * Withdrawing is the holder's own way out of a proposal (O35). The requester ends its own request
   * with no further check; anybody else needs the eligibility that rejecting needs — the scope's
   * administration as a resolved fact or live `approve` authority — and an agent never ends another
   * holder's proposal (O61, O64).
   */
  const withdrawCommand = Effect.fn('Approvals.withdraw')(function* withdrawEffect(command: WithdrawCommand) {
    const stored = yield* ports.store.load(command);
    if (Option.isNone(stored)) {
      return yield* notFound();
    }
    const proposal = stored.value;
    const now = yield* ports.clock.now;
    const own = sameHolder(actorHolder(command.actor), actorHolder(proposal.requester));
    if (own) {
      const withdrawn = withdraw({ actor: command.actor, eligibility: 'requester', now, proposal });
      if (Result.isFailure(withdrawn)) {
        return yield* withdrawn.failure;
      }
      yield* ports.store.save({ expectedStatus: proposal.status, proposal: withdrawn.success });
      return withdrawn.success;
    }
    if (Predicate.isTagged(command.actor, 'Agent')) {
      return yield* new ProposalRefusedError({
        code: 'withdrawal_by_agent_forbidden',
        reason: 'An agent never ends another holder\u2019s proposal, even the one it works for',
      });
    }
    const decider = yield* eligibleDecider({
      actor: command.actor.principalId,
      capabilityKey: proposal.capabilityKey,
      offered: command.withdrawAuthority,
      scopeId: command.scopeId,
      tenantId: command.tenantId,
    });
    if (Option.isNone(decider)) {
      return yield* new ProposalRefusedError({
        code: 'withdrawal_not_permitted',
        reason: 'Only the requester, an eligible approver or a scope administrator withdraws this proposal',
      });
    }
    const withdrawn = withdraw({ actor: command.actor, eligibility: decider.value.basis, now, proposal });
    if (Result.isFailure(withdrawn)) {
      return yield* withdrawn.failure;
    }
    yield* ports.store.save({
      evidence: {
        basis: decider.value.basis,
        decidedBy: command.actor.principalId,
        witnesses: decider.value.witnesses,
      },
      expectedStatus: proposal.status,
      proposal: withdrawn.success,
    });
    return withdrawn.success;
  });

  /** Ends one due proposal; a proposal that already moved on is not reported as expired. */
  const expireOne = Effect.fn('Approvals.expireOne')(function* expireOneEffect(input: {
    readonly now: Date;
    readonly proposal: Proposal;
  }) {
    const due = expireProposal(input);
    if (due === input.proposal) {
      return Option.none<Proposal>();
    }
    const checked = yield* produced(input.proposal.status, due);
    const saved = yield* ports.store
      .recordEnd({ expectedStatus: input.proposal.status, proposal: checked, reason: 'proposal_expired' })
      .pipe(
        Effect.as(true),
        Effect.catchTag('ApprovalStorageConflictError', () => Effect.succeed(false)),
      );
    return saved ? Option.some(checked) : Option.none<Proposal>();
  });

  const expireDue = Effect.fn('Approvals.expireDue')(function* expireDueEffect(input: ProposalScope) {
    const open = yield* ports.store.listOpen(input);
    const now = yield* ports.clock.now;
    const expired = yield* Effect.forEach(open, (proposal) => expireOne({ now, proposal }), { concurrency: 1 });
    return expired.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));
  });

  const recordAuthorityLoss = Effect.fn('Approvals.recordAuthorityLoss')(function* recordAuthorityLossEffect(
    loss: AuthorityLoss,
  ) {
    const reach: TenantScope =
      loss.scopeId === undefined ? { tenantId: loss.tenantId } : { scopeId: loss.scopeId, tenantId: loss.tenantId };
    const open = yield* ports.store.listOpen(reach);
    const now = yield* ports.clock.now;
    const lapsed = yield* Effect.forEach(
      open,
      (proposal) => {
        const cause = lapseCauseOf(assessAuthorityLoss(proposal, loss));
        if (Option.isNone(cause)) {
          return Effect.succeed(Option.none<Proposal>());
        }
        const authorityLoss = cause.value;
        return persistLapse({ authorityLoss, now, proposal }).pipe(
          Effect.catchTag('ApprovalStorageConflictError', () => Effect.succeed(proposal)),
          Effect.map((ended) => (ended === proposal ? Option.none<Proposal>() : Option.some(ended))),
        );
      },
      { concurrency: 1 },
    );
    return lapsed.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));
  });

  const recheckAuthority = Effect.fn('Approvals.recheckAuthority')(function* recheckAuthorityEffect(
    input: ProposalScope & { readonly proposalId: ProposalId },
  ) {
    const stored = yield* ports.store.load(input);
    if (Option.isNone(stored)) {
      return yield* notFound();
    }
    const proposal = stored.value;
    if (proposal.actionAuthority !== undefined) {
      if (ports.actionCommands === undefined) {
        return yield* authorityUnavailable('The full-target Action authority recheck lifecycle is unavailable');
      }
      const state = yield* ports.actionCommands.lifecycle.recheckAuthority({
        proposal,
        scope: ports.actionCommands.scope,
      });
      return state === 'live'
        ? proposal
        : yield* persistLapse({ authorityLoss: 'role_lost', now: yield* ports.clock.now, proposal });
    }
    const authority = yield* inspectProposalAuthority(
      {
        proposal,
        scopeId: input.scopeId,
        tenantId: input.tenantId,
      },
      ports.authority,
    );
    const cause = lapseCauseOf(assessWitnessAuthority(proposal, authority));
    if (Option.isNone(cause)) {
      return proposal;
    }
    const now = yield* ports.clock.now;
    return yield* persistLapse({ authorityLoss: cause.value, now, proposal });
  });

  return {
    approve: approveCommand,
    execute: executeCommand,
    expireDue,
    propose: proposeCommand,
    recheckAuthority,
    recordAuthorityLoss,
    reject: rejectCommand,
    withdraw: withdrawCommand,
  };
};

/**
 * The live approvals service of one request scope (O66): the shipped Core ports of that scope, with
 * `inTransaction` offered whenever the composition can join the owner's transaction, so a mandate
 * claim or a parked Action proposal re-reads its authority in the transaction it is executed in
 * instead of a second connection (O75).
 *
 * This module owns the constructor and Core's lint policy keeps a service constructor inside its
 * owning module, so the last line of the live composition is written here and the owner runner binds
 * it: `approvalsFor: (scope) => liveApprovalsService(liveServices, scope)`, where `liveServices` are
 * the live services it built with a `join` that reads over `callerTransactions(transaction)` (see
 * `live-composition.ts`). Nothing here decides a witness, a membership or a catalog fact: it is a
 * scope and a port list.
 */
export const liveApprovalsService = (services: LiveApprovalServices, scope: OperationalScope): ApprovalsService =>
  makeApprovalsService(liveApprovalsPorts(services, scope));
