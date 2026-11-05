import { Match, Option, Predicate, Schema } from 'effect';

import type { AccessScopeId, AgentId, ModuleKey, PrincipalId, TenantId } from '../ids.ts';
import { canTransitionProposalStatus } from '../model.ts';
import type { Proposal, ProposalStatus } from '../model.ts';
import { authorityWitnessSlot } from './execution.ts';
import type { WitnessAuthorityMap } from './execution.ts';
import { earliest } from './policy.ts';
import { actorPrincipal } from './proposal.ts';

/**
 * Why a bound authority stopped being live. Every cause lapses permanently: a role, membership,
 * suspension, uninstall, parent read, connection or delegation loss is never repaired by recovery,
 * reassignment or rejoining (D1, D26, D28, guarantee 5).
 */
export const AuthorityLossCauseSchema = Schema.Literals([
  'connection_lost',
  'delegation_ended',
  'membership_lost',
  'module_uninstalled',
  'parent_record_read_lost',
  'role_lost',
  'scope_unavailable',
  'suspension',
]);
export type AuthorityLossCause = typeof AuthorityLossCauseSchema.Type;

export interface AuthorityLoss {
  /** The agent whose connection ended, when the loss is connection-scoped (`connection_lost`). */
  readonly agentId?: AgentId;
  readonly authorityLoss: AuthorityLossCause;
  /** The module whose use stopped at once, for `module_uninstalled` (guarantee 8). */
  readonly moduleKey?: ModuleKey;
  /** The person whose authority changed; a loss only reaches proposals that depend on them. */
  readonly principalId: PrincipalId;
  /**
   * The scope the loss happened in. Absent means it reaches every scope of the tenant: a tenant
   * membership departure or a suspension is reported once, at tenant context, and must still reach
   * the proposals of every legal entity the person was a member of (R2-H7).
   */
  readonly scopeId?: AccessScopeId;
  readonly tenantId: TenantId;
}

export const LapseAssessmentSchema = Schema.Union([
  Schema.TaggedStruct('lapse', {
    authorityLoss: AuthorityLossCauseSchema,
    reason: Schema.String,
  }),
  Schema.TaggedStruct('retain', { reason: Schema.String }),
]);
export type LapseAssessment = typeof LapseAssessmentSchema.Type;

const PROPOSAL_STATUSES = [
  'approved',
  'executed',
  'expired',
  'lapsed',
  'pending',
  'rejected',
] as const satisfies readonly ProposalStatus[];

/**
 * A status is terminal exactly when the model allows no move out of it (R2-M5). Deriving it from
 * `canTransitionProposalStatus` keeps one transition table instead of a second copy that could drift.
 */
export const isProposalTerminal = (status: ProposalStatus): boolean =>
  !PROPOSAL_STATUSES.some((next: ProposalStatus) => canTransitionProposalStatus(status, next));

const retain = (reason: string): LapseAssessment => ({ _tag: 'retain', reason });
const lapse = (authorityLoss: AuthorityLossCause, reason: string): LapseAssessment => ({
  _tag: 'lapse',
  authorityLoss,
  reason,
});

/** The authority loss that ends a proposal, or none when the assessment keeps it alive. */
export const lapseCauseOf = (assessment: LapseAssessment): Option.Option<AuthorityLossCause> =>
  Match.value(assessment).pipe(
    Match.tag('lapse', ({ authorityLoss }) => Option.some(authorityLoss)),
    Match.tag('retain', () => Option.none()),
    Match.exhaustive,
  );

/** Whether an authority loss reaches this proposal's scope at all. */
const reachesScope = (proposal: Proposal, loss: AuthorityLoss): boolean =>
  loss.scopeId === undefined || proposal.scopeId === loss.scopeId;

/**
 * Decides whether one authority change reaches one proposal. An unrelated person, another scope or
 * another module only ever keeps the proposal alive; a loss that cannot say what it removes never
 * keeps a proposal alive by accident (R2-H7).
 */
export const assessAuthorityLoss = (proposal: Proposal, loss: AuthorityLoss): LapseAssessment => {
  if (isProposalTerminal(proposal.status)) {
    return retain('The proposal already ended and never comes back');
  }
  if (proposal.tenantId !== loss.tenantId || !reachesScope(proposal, loss)) {
    return retain('The loss happened in another scope');
  }
  if (loss.authorityLoss === 'module_uninstalled') {
    const { moduleKey } = loss;
    // A missing module key would otherwise retain every proposal, so it is a refusal, not a retain.
    if (moduleKey === undefined) {
      return lapse(
        'module_uninstalled',
        'An uninstall that does not name its module cannot prove which proposals it leaves alone',
      );
    }
    return proposal.capabilityKey.startsWith(`${moduleKey}.`)
      ? lapse('module_uninstalled', 'The module that owns the command is uninstalled')
      : retain('Another module was uninstalled');
  }
  if (loss.authorityLoss === 'parent_record_read_lost') {
    return proposal.witnesses.some((witness) => witness.purpose === 'parent_record_read')
      ? lapse('parent_record_read_lost', 'The approver lost the read of the parent record')
      : retain('The command reads no parent record');
  }
  if (loss.authorityLoss === 'connection_lost' && loss.agentId !== undefined) {
    const { requester } = proposal;
    return Predicate.isTagged(requester, 'Agent') && requester.agentId === loss.agentId
      ? lapse('connection_lost', 'The agent connection that proposed the command ended')
      : retain('Another connection ended');
  }
  const dependsOnHolder =
    loss.principalId === actorPrincipal(proposal.requester) || loss.principalId === proposal.approval?.approverId;
  return dependsOnHolder
    ? lapse(loss.authorityLoss, 'The mandate depends on authority this person lost')
    : retain('The proposal does not depend on this person');
};

export interface LapseProposalInput {
  readonly now: Date;
  readonly proposal: Proposal;
}

/** Applies a lapse. An already-ended proposal is returned unchanged; nothing is ever reopened. */
export const lapseProposal = ({ now, proposal }: LapseProposalInput): Proposal =>
  isProposalTerminal(proposal.status) ? proposal : { ...proposal, endedAt: now, status: 'lapsed' };

export interface ExpireProposalInput {
  readonly now: Date;
  readonly proposal: Proposal;
}

/** Ends a proposal or mandate whose deadline passed; a live one is returned unchanged. */
export const expireProposal = ({ now, proposal }: ExpireProposalInput): Proposal => {
  // The earliest relevant end date wins: an approval's own deadline ends the mandate too (guarantee 6).
  const deadline =
    proposal.approval === undefined ? proposal.expiresAt : earliest(proposal.expiresAt, proposal.approval.expiresAt);
  return isProposalTerminal(proposal.status) || now < deadline
    ? proposal
    : { ...proposal, endedAt: now, status: 'expired' };
};

/**
 * Re-reads the bound witnesses only. A role edit that keeps the approver's authority keeps the
 * mandate, and an unsure projection keeps it too: uncertainty never ends an approval (D1).
 */
export const assessWitnessAuthority = (proposal: Proposal, authority: WitnessAuthorityMap): LapseAssessment => {
  if (isProposalTerminal(proposal.status)) {
    return retain('The proposal already ended and never comes back');
  }
  for (const witness of proposal.witnesses) {
    const state = authority.get(authorityWitnessSlot(witness));
    if (state === undefined || state === 'unavailable') {
      return retain('The authority of a bound witness could not be re-checked');
    }
    if (state === 'lost') {
      return lapse('role_lost', 'A bound assignment, grant or role binding is no longer live');
    }
  }
  return retain('Every bound assignment and grant is still live');
};
