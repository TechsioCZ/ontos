import { Match, Predicate, Result, Schema } from 'effect';

import type { AccessScopeId, CommandDigest, RecordKey, RoleRevisionId } from '../ids.ts';
import type {
  ActorContext,
  AuthorityWitness,
  Cell,
  CellSelector,
  ExecutionReceipt,
  Holder,
  Proposal,
  ProposalStatus,
} from '../model.ts';
import { sameHolder, witnessPurposeMode } from '../model.ts';
import { ApprovalAuthorityUnavailableError, MandateRefusedError } from './errors.ts';
import type { MandateRefusalCode } from './errors.ts';
import { actorPrincipal } from './proposal.ts';

/** Mirrors the model's execution identity so Core binds the invocation it actually runs. */
export const ActionInvocationRefSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ActionInvocationId'));
export type ActionInvocationRef = typeof ActionInvocationRefSchema.Type;

export const WITNESS_AUTHORITY_STATES = ['live', 'lost', 'unavailable'] as const;
export type WitnessAuthorityState = (typeof WITNESS_AUTHORITY_STATES)[number];

/**
 * What Core's authority projection reports about one bound witness: the state of the assignment
 * incarnation, the holder it belongs to, the real grant cell behind the bound grant incarnation, and
 * the role revisions and scopes of both. The projection reports facts; the verdict below is Core's
 * own rule, so a mandate is never live on a graph the engine alone believes in (O48, O49).
 *
 * A fact the projection cannot answer is `null`, which is never assumed to match (R2-H1).
 */
export interface WitnessFacts {
  /** The role revision the bound assignment incarnation belongs to; null when unknown. */
  readonly assignmentRoleRevisionId: RoleRevisionId | null;
  /** The scope the bound assignment incarnation lives in; null when unknown. */
  readonly assignmentScopeId: AccessScopeId | null;
  readonly assignmentState: WitnessAuthorityState;
  /** The real cell of the bound grant incarnation: its capability, mode and selector. */
  readonly grantCell: Cell | null;
  /** The role revision whose role binding owns the bound grant cell; null when unknown. */
  readonly grantRoleRevisionId: RoleRevisionId | null;
  /** The scope the bound grant incarnation lives in; null when unknown. */
  readonly grantScopeId: AccessScopeId | null;
  readonly grantState: WitnessAuthorityState;
  /** The holder the projection reports for the bound assignment; null when unknown. */
  readonly holderId: Holder | null;
  /**
   * Whether the bound grant cell reaches the record the command changes, now. Only the projection
   * knows a record's owner and team, so `assigned`, `entrusted` and `team` are answered here; null is
   * an unanswered fact, which is never assumed to reach (P5, N6).
   */
  readonly reachesTarget: boolean | null;
  readonly witness: AuthorityWitness;
}

/** The facts a verdict needs; every field is known, so a null fact is never assumed to match. */
interface KnownWitnessFacts {
  readonly assignmentRoleRevisionId: RoleRevisionId;
  readonly assignmentScopeId: AccessScopeId;
  readonly grantCell: Cell;
  readonly grantRoleRevisionId: RoleRevisionId;
  readonly grantScopeId: AccessScopeId;
  readonly holderId: Holder;
}

/**
 * What one purpose group of witnesses must satisfy (R2-H1): the holder that group belongs to — the
 * requester itself for `requester`, the approving person for every other purpose (O63) — the one
 * scope that the assignment, the grant cell and the witness must all share (O49), and the record the
 * command changes, when it names one (P5, N6).
 */
export interface WitnessExpectation {
  readonly expectedHolder: Holder;
  readonly scopeId: AccessScopeId;
  readonly target?: RecordKey;
}

export const authorityWitnessSlot = (witness: AuthorityWitness): string =>
  `${witness.purpose} ${witness.assignmentIncarnationId} ${witness.grantIncarnationId} ${witness.capabilityKey}`;

export type WitnessAuthorityMap = ReadonlyMap<string, WitnessAuthorityState>;

/**
 * A mandate is live only while both incarnations are live, the assignment belongs to the holder the
 * purpose expects, the grant cell really carries the witness's capability in the purpose's mode,
 * every scope is the proposal's own, and the approver's assignment is still a member of the
 * approval grant's role binding (O49, O52, guarantee 5).
 *
 * A different holder's assignment, a `propose`-mode cell used as an approval, a cell of the same
 * role revision in another legal entity and a cell whose capability is not the claimed one are all
 * a lost authority, and an unknown structure is never assumed live (R2-H1).
 */
const knownFacts = (facts: WitnessFacts): KnownWitnessFacts | undefined => {
  const { assignmentRoleRevisionId, assignmentScopeId, grantCell, grantRoleRevisionId, grantScopeId, holderId } = facts;
  if (
    assignmentRoleRevisionId === null ||
    assignmentScopeId === null ||
    grantCell === null ||
    grantRoleRevisionId === null ||
    grantScopeId === null ||
    holderId === null
  ) {
    return undefined;
  }
  return { assignmentRoleRevisionId, assignmentScopeId, grantCell, grantRoleRevisionId, grantScopeId, holderId };
};

/** The grant cell really carries the witness's capability, in the mode the purpose requires. */
const sameCell = (witness: AuthorityWitness, grantCell: Cell): boolean => {
  const purposeMode = witnessPurposeMode(witness.purpose);
  return (
    grantCell.capabilityKey === witness.capabilityKey && grantCell.mode === purposeMode && witness.mode === purposeMode
  );
};

/** The assignment, the grant cell and the witness all belong to the expected holder in one scope. */
const samePlace = (witness: AuthorityWitness, expectation: WitnessExpectation, known: KnownWitnessFacts): boolean =>
  sameHolder(known.holderId, expectation.expectedHolder) &&
  sameHolder(witness.holderId, expectation.expectedHolder) &&
  sameHolder(witness.holderId, known.holderId) &&
  known.assignmentScopeId === expectation.scopeId &&
  known.grantScopeId === expectation.scopeId &&
  witness.scopeId === expectation.scopeId;

/** What a selector proves on its own: `all` and explicit targets are local, the rest need the record. */
const selectorReaches = (selector: CellSelector, target: RecordKey): boolean | null =>
  Match.value(selector).pipe(
    Match.tag('all', () => true),
    Match.tag('targets', ({ recordKeys }) => recordKeys.includes(target)),
    Match.orElse(() => null),
  );

/**
 * A record-scoped command needs its witnesses to reach the record it changes now. Reassigning the
 * record leaves the approver's `assigned` incarnation live but out of reach, so the mandate stops
 * executing on it; an unanswered reach is a retryable failure, never an assumption (P5, N6).
 */
const targetIssue = (
  grantCell: Cell,
  reachesTarget: boolean | null,
  target: RecordKey | undefined,
): WitnessAuthorityState | undefined => {
  if (target === undefined) {
    return undefined;
  }
  const local = selectorReaches(grantCell.selector, target);
  if (local === false || reachesTarget === false) {
    return 'lost';
  }
  if (local === true) {
    return undefined;
  }
  return reachesTarget === true ? undefined : 'unavailable';
};

export const witnessAuthorityOf = (facts: WitnessFacts, expectation: WitnessExpectation): WitnessAuthorityState => {
  if (facts.assignmentState === 'lost' || facts.grantState === 'lost') {
    return 'lost';
  }
  if (facts.assignmentState === 'unavailable' || facts.grantState === 'unavailable') {
    return 'unavailable';
  }
  const known = knownFacts(facts);
  if (known === undefined) {
    return 'unavailable';
  }
  if (!sameCell(facts.witness, known.grantCell) || !samePlace(facts.witness, expectation, known)) {
    return 'lost';
  }
  if (known.assignmentRoleRevisionId !== known.grantRoleRevisionId) {
    return 'lost';
  }
  return targetIssue(known.grantCell, facts.reachesTarget, expectation.target) ?? 'live';
};

/** One verdict per witness slot, derived with the expectation of the group the witness belongs to. */
export const witnessAuthorityMap = (
  facts: readonly WitnessFacts[],
  expectation: WitnessExpectation,
): WitnessAuthorityMap =>
  new Map(facts.map((entry) => [authorityWitnessSlot(entry.witness), witnessAuthorityOf(entry, expectation)]));

/** Two groups — the requester's and the approver's — share one verdict map at execution. */
export const mergeWitnessAuthority = (...maps: readonly WitnessAuthorityMap[]): WitnessAuthorityMap =>
  new Map(maps.flatMap((map) => [...map]));

/**
 * Reads one group of witnesses. A definite loss wins over an unanswered witness, and a missing
 * verdict is unavailable, so no witness is ever assumed live.
 */
export const authorityFailure = (
  authority: WitnessAuthorityMap,
  witnesses: readonly AuthorityWitness[],
): WitnessAuthorityState | undefined => {
  const states = witnesses.map((witness) => authority.get(authorityWitnessSlot(witness)) ?? 'unavailable');
  if (states.some((state) => state === 'lost')) {
    return 'lost';
  }
  return states.some((state) => state === 'unavailable') ? 'unavailable' : undefined;
};

export const liveWitnesses = (
  authority: WitnessAuthorityMap,
  witnesses: readonly AuthorityWitness[],
): readonly AuthorityWitness[] =>
  witnesses.filter((witness) => authority.get(authorityWitnessSlot(witness)) === 'live');

const refusal = (code: MandateRefusalCode, reason: string): Result.Result<never, MandateRefusedError> =>
  Result.fail(new MandateRefusedError({ code, reason }));

const unavailable = (reason: string): Result.Result<never, ApprovalAuthorityUnavailableError> =>
  Result.fail(new ApprovalAuthorityUnavailableError({ code: 'approval_authority_unavailable', reason }));

/** Every status but `approved` refuses execution with its own stable code, and `approved` proceeds. */
const STATUS_REFUSALS = {
  approved: null,
  executed: () => refusal('proposal_already_executed', 'A mandate executes at most once'),
  expired: () => refusal('proposal_expired', 'The approval is no longer valid'),
  lapsed: () => refusal('proposal_lapsed', 'The mandate lapsed and can never come back'),
  pending: () => refusal('proposal_not_approved', 'A person must approve the proposal before it executes'),
  rejected: () => refusal('proposal_rejected', 'The proposal was withdrawn or rejected'),
} as const satisfies Record<ProposalStatus, (() => Result.Result<never, MandateRefusedError>) | null>;

export interface ExecuteInput {
  readonly actionInvocationId: ActionInvocationRef;
  readonly actor: ActorContext;
  /** Recomputed from the command handed to execution; it must equal the frozen digest. */
  readonly commandDigest: CommandDigest;
  readonly now: Date;
  readonly proposal: Proposal;
  readonly witnessAuthority: WitnessAuthorityMap;
}

/**
 * Re-checks the frozen command and every bound witness at the moment of execution, then records the
 * single execution receipt. A lost witness or a broken binding is a refusal, an unanswered
 * projection is a retryable failure, and a changed command is never executed (P5, P10, O49).
 *
 * Only the approving person executes a mandate (O63). The requester, the approver's agent and any
 * bystander are refused: a mandate exists only for sensitive or critical work, which no agent may
 * run, and running an approved command under somebody else's witnesses is the elevation P5 forbids.
 */
export const execute = (
  input: ExecuteInput,
): Result.Result<Proposal, MandateRefusedError | ApprovalAuthorityUnavailableError> => {
  const { proposal } = input;
  const refused = STATUS_REFUSALS[proposal.status];
  if (refused !== null) {
    return refused();
  }
  const { approval } = proposal;
  if (approval === undefined) {
    return refusal('proposal_not_approved', 'A person must approve the proposal before it executes');
  }
  if (input.now >= approval.expiresAt) {
    return refusal('proposal_expired', 'The approval expired before the command executed');
  }
  if (input.commandDigest !== proposal.commandDigest) {
    return refusal('command_changed', 'The command no longer matches the one the person approved');
  }
  if (Predicate.isTagged(input.actor, 'Agent')) {
    return refusal('agent_cannot_execute', 'Only the approving person executes a mandate; an agent never does');
  }
  if (actorPrincipal(input.actor) !== approval.approverId) {
    return refusal('execution_not_permitted', 'Only the approver executes an approved command');
  }
  const failure = authorityFailure(input.witnessAuthority, proposal.witnesses);
  if (failure === 'lost') {
    return refusal('authority_lost', 'A bound assignment, grant or role binding is no longer live');
  }
  if (failure === 'unavailable') {
    return unavailable('The authority of a bound witness could not be re-checked');
  }
  const receipt: ExecutionReceipt = {
    actionInvocationId: input.actionInvocationId,
    executedAt: input.now,
  };
  return Result.succeed({ ...proposal, execution: receipt, status: 'executed' });
};
