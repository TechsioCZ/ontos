import { Match, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { mergeWitnessAuthority, witnessAuthorityMap } from '../../src/access/approvals/execution.ts';
import type { WitnessExpectation, WitnessFacts } from '../../src/access/approvals/execution.ts';
import {
  assessAuthorityLoss,
  assessWitnessAuthority,
  expireProposal,
  lapseProposal,
} from '../../src/access/approvals/lapse.ts';
import type { AuthorityLoss, LapseAssessment } from '../../src/access/approvals/lapse.ts';
import { proposalLifetimeMillis } from '../../src/access/approvals/policy.ts';
import { withdraw } from '../../src/access/approvals/proposal.ts';
import type { AuthorityWitness, Proposal } from '../../src/access/model.ts';
import {
  APPROVER_HOLDER,
  AT,
  HOUR_MS,
  OTHER_ROLE_REVISION,
  OTHER_SCOPE,
  OTHER_TENANT,
  REQUESTER,
  REQUESTER_HOLDER,
  ROLE_REVISION,
  SCOPE,
  TENANT,
  agentId,
  agentOf,
  at,
  mandateOf,
  moduleKey,
  person,
  plus,
  principalId,
  proposalOf,
  recordKey,
  recordScopedCapability,
  requesterWitness,
} from './access-approvals-fixtures.ts';

const REQUESTER_EXPECTATION: WitnessExpectation = { expectedHolder: REQUESTER_HOLDER, scopeId: SCOPE };

const factsOf = (witness: AuthorityWitness, overrides: Partial<WitnessFacts> = {}): WitnessFacts => ({
  assignmentRoleRevisionId: ROLE_REVISION,
  assignmentScopeId: SCOPE,
  assignmentState: 'live',
  grantCell: { capabilityKey: witness.capabilityKey, mode: witness.mode, selector: { _tag: 'all' } },
  grantRoleRevisionId: ROLE_REVISION,
  grantScopeId: SCOPE,
  grantState: 'live',
  holderId: witness.holderId,
  reachesTarget: true,
  witness,
  ...overrides,
});

/** A verdict map for every bound witness of one proposal. */
const liveMap = (proposal: Proposal) =>
  mergeWitnessAuthority(
    witnessAuthorityMap(
      proposal.witnesses.filter(({ purpose }) => purpose === 'requester').map((witness) => factsOf(witness)),
      REQUESTER_EXPECTATION,
    ),
    witnessAuthorityMap(
      proposal.witnesses.filter(({ purpose }) => purpose !== 'requester').map((witness) => factsOf(witness)),
      { expectedHolder: APPROVER_HOLDER, scopeId: SCOPE },
    ),
  );

const loss = (overrides: Partial<AuthorityLoss> = {}): AuthorityLoss => ({
  authorityLoss: 'role_lost',
  principalId: principalId(2),
  scopeId: SCOPE,
  tenantId: TENANT,
  ...overrides,
});

/** The decision, read through the tagged vocabulary instead of comparing tags by hand. */
const verdictOf = (assessment: LapseAssessment): string =>
  Match.value(assessment).pipe(
    Match.tag('lapse', ({ authorityLoss }) => `lapse:${authorityLoss}`),
    Match.tag('retain', () => 'retain'),
    Match.exhaustive,
  );

it('lapses an approved mandate when the approver loses the role and keeps the reason', () => {
  const mandate = mandateOf();
  expect(verdictOf(assessAuthorityLoss(mandate, loss()))).toBe('lapse:role_lost');
  const lapsed = lapseProposal({ now: plus(AT, HOUR_MS), proposal: mandate });
  expect(lapsed.status).toBe('lapsed');
  expect(lapsed.endedAt?.getTime()).toBe(plus(AT, HOUR_MS).getTime());
  expect(lapsed.approval?.approverId).toBe(mandate.approval?.approverId);
  expect(lapsed.execution).toBeUndefined();
});

it('keeps a proposal that does not depend on the authority that changed', () => {
  const mandate = mandateOf();
  expect(verdictOf(assessAuthorityLoss(mandate, loss({ principalId: principalId(3) })))).toBe('retain');
  expect(verdictOf(assessAuthorityLoss(mandate, loss({ scopeId: OTHER_SCOPE })))).toBe('retain');
  expect(verdictOf(assessAuthorityLoss(mandate, loss({ tenantId: OTHER_TENANT })))).toBe('retain');
});

it('reaches every scope of the tenant when the loss is reported at tenant context (R2-H7)', () => {
  const mandate = mandateOf();
  // The mandate lives in a legal-entity scope; a departure reported once for the tenant must reach it.
  const tenantWide: AuthorityLoss = { authorityLoss: 'membership_lost', principalId: principalId(2), tenantId: TENANT };
  expect(verdictOf(assessAuthorityLoss(mandate, tenantWide))).toBe('lapse:membership_lost');
  // Another tenant is still untouched, and a different person in this tenant is too.
  expect(verdictOf(assessAuthorityLoss(mandate, { ...tenantWide, tenantId: OTHER_TENANT }))).toBe('retain');
  expect(verdictOf(assessAuthorityLoss(mandate, { ...tenantWide, principalId: principalId(3) }))).toBe('retain');
  // An explicitly scoped loss still only reaches its own scope.
  expect(verdictOf(assessAuthorityLoss(mandate, loss({ scopeId: OTHER_SCOPE })))).toBe('retain');
});

it('lapses a pending proposal whose requester left or was suspended', () => {
  const pending = proposalOf();
  for (const authorityLoss of ['membership_lost', 'suspension', 'scope_unavailable'] as const) {
    expect(verdictOf(assessAuthorityLoss(pending, loss({ authorityLoss, principalId: principalId(1) })))).toBe(
      `lapse:${authorityLoss}`,
    );
  }
  expect(
    verdictOf(assessAuthorityLoss(pending, loss({ authorityLoss: 'delegation_ended', principalId: principalId(1) }))),
  ).toBe('lapse:delegation_ended');
  // A pending proposal depends only on its requester; the approver is bound later.
  expect(verdictOf(assessAuthorityLoss(pending, loss()))).toBe('retain');
});

it('lapses on uninstall of the owning module and keeps an unrelated module', () => {
  const mandate = mandateOf();
  expect(
    verdictOf(
      assessAuthorityLoss(mandate, loss({ authorityLoss: 'module_uninstalled', moduleKey: moduleKey('finance') })),
    ),
  ).toBe('lapse:module_uninstalled');
  expect(
    verdictOf(
      assessAuthorityLoss(mandate, loss({ authorityLoss: 'module_uninstalled', moduleKey: moduleKey('projects') })),
    ),
  ).toBe('retain');
});

it('never fails open on an uninstall that does not name its module (R2-H7)', () => {
  const mandate = mandateOf();
  const anonymous: AuthorityLoss = {
    authorityLoss: 'module_uninstalled',
    principalId: principalId(2),
    tenantId: TENANT,
  };
  // The old behaviour retained every proposal here, which let an uninstalled module keep running.
  expect(verdictOf(assessAuthorityLoss(mandate, anonymous))).toBe('lapse:module_uninstalled');
  expect(verdictOf(assessAuthorityLoss(proposalOf(), anonymous))).toBe('lapse:module_uninstalled');
});

it('lapses on parent record read loss only when the command read a parent record', () => {
  const capability = recordScopedCapability();
  const recordMandate = mandateOf({ capability, target: recordKey('invoice-1') });
  expect(recordMandate.witnesses.some(({ purpose }) => purpose === 'parent_record_read')).toBe(true);
  expect(verdictOf(assessAuthorityLoss(recordMandate, loss({ authorityLoss: 'parent_record_read_lost' })))).toBe(
    'lapse:parent_record_read_lost',
  );
  expect(verdictOf(assessAuthorityLoss(mandateOf(), loss({ authorityLoss: 'parent_record_read_lost' })))).toBe(
    'retain',
  );
  // Somebody else losing that read leaves the mandate alone: it is bound to its own approver's read.
  expect(
    verdictOf(
      assessAuthorityLoss(
        recordMandate,
        loss({ authorityLoss: 'parent_record_read_lost', principalId: principalId(99) }),
      ),
    ),
  ).toBe('retain');
});

it('lapses the mandate whose agent connection ended and keeps another connection', () => {
  const agentMandate = mandateOf({ requester: agentOf(1, 4, 5) });
  expect(
    verdictOf(
      assessAuthorityLoss(
        agentMandate,
        loss({ agentId: agentId(4), authorityLoss: 'connection_lost', principalId: principalId(1) }),
      ),
    ),
  ).toBe('lapse:connection_lost');
  expect(
    verdictOf(
      assessAuthorityLoss(
        agentMandate,
        loss({ agentId: agentId(9), authorityLoss: 'connection_lost', principalId: principalId(1) }),
      ),
    ),
  ).toBe('retain');
});

it('never revives an ended proposal and never extends an expired one', () => {
  const mandate = mandateOf();
  const lapsed = lapseProposal({ now: at(10), proposal: mandate });
  expect(lapseProposal({ now: at(11), proposal: lapsed })).toBe(lapsed);
  const rejected = Result.getOrThrow(
    withdraw({ actor: REQUESTER, eligibility: 'requester', now: at(10), proposal: proposalOf() }),
  );
  expect(lapseProposal({ now: at(11), proposal: rejected })).toBe(rejected);
  const expired = expireProposal({ now: plus(AT, 24 * HOUR_MS), proposal: mandate });
  expect(expireProposal({ now: plus(AT, 48 * HOUR_MS), proposal: expired })).toBe(expired);
});

it('expires a proposal at its own deadline and a mandate at its approval deadline', () => {
  const pending = proposalOf();
  expect(expireProposal({ now: plus(AT, proposalLifetimeMillis() - 1), proposal: pending })).toBe(pending);
  const expired = expireProposal({ now: plus(AT, proposalLifetimeMillis()), proposal: pending });
  expect(expired.status).toBe('expired');
  expect(expired.endedAt?.getTime()).toBe(plus(AT, proposalLifetimeMillis()).getTime());

  // A mandate ends at the earliest relevant date, which is the approval's own deadline (guarantee 6).
  const mandate = mandateOf();
  expect(expireProposal({ now: plus(AT, 24 * HOUR_MS - 1), proposal: mandate })).toBe(mandate);
  const expiredMandate = expireProposal({ now: plus(AT, 24 * HOUR_MS), proposal: mandate });
  expect(expiredMandate.status).toBe('expired');
  expect(expiredMandate.approval).toStrictEqual(mandate.approval);
});

it('keeps the mandate on a role edit that keeps every bound witness and lapses it otherwise', () => {
  const mandate = mandateOf();
  expect(verdictOf(assessWitnessAuthority(mandate, liveMap(mandate)))).toBe('retain');
  const [first] = [...liveMap(mandate).keys()];
  if (first === undefined) {
    expect.unreachable('a mandate binds witnesses');
  }
  const unsure = new Map([...liveMap(mandate), [first, 'unavailable'] as const]);
  expect(verdictOf(assessWitnessAuthority(mandate, unsure))).toBe('retain');
  const lost = new Map([...liveMap(mandate), [first, 'lost'] as const]);
  expect(verdictOf(assessWitnessAuthority(mandate, lost))).toBe('lapse:role_lost');
  expect(verdictOf(assessWitnessAuthority(mandate, witnessAuthorityMap([], REQUESTER_EXPECTATION)))).toBe('retain');
});

it('lapses a mandate whose approver assignment moved to another role revision (O49)', () => {
  const mandate = mandateOf();
  const rebound = mergeWitnessAuthority(
    witnessAuthorityMap(
      mandate.witnesses.filter(({ purpose }) => purpose === 'requester').map((witness) => factsOf(witness)),
      REQUESTER_EXPECTATION,
    ),
    witnessAuthorityMap(
      mandate.witnesses
        .filter(({ purpose }) => purpose !== 'requester')
        .map((witness) =>
          factsOf(witness, witness.purpose === 'approval' ? { assignmentRoleRevisionId: OTHER_ROLE_REVISION } : {}),
        ),
      { expectedHolder: APPROVER_HOLDER, scopeId: SCOPE },
    ),
  );
  expect(verdictOf(assessWitnessAuthority(mandate, rebound))).toBe('lapse:role_lost');
});

it('keeps an ended proposal on every authority re-check', () => {
  const expired = expireProposal({ now: plus(AT, 24 * HOUR_MS), proposal: mandateOf() });
  expect(verdictOf(assessWitnessAuthority(expired, witnessAuthorityMap([], REQUESTER_EXPECTATION)))).toBe('retain');
  expect(verdictOf(assessAuthorityLoss(expired, loss()))).toBe('retain');
});

it('reads the requester grant witnesses as a distinct purpose from the approver ones', () => {
  const mandate = mandateOf();
  expect(mandate.witnesses.filter(({ purpose }) => purpose === 'requester')).toHaveLength(2);
  const requesterAssignments = mandate.witnesses
    .filter(({ purpose }) => purpose === 'requester')
    .map(({ assignmentIncarnationId }) => assignmentIncarnationId);
  expect(requesterAssignments).toStrictEqual([
    requesterWitness(11, 21).assignmentIncarnationId,
    requesterWitness(12, 22).assignmentIncarnationId,
  ]);
  expect(person(2).principalId).toBe(mandate.approval?.approverId);
});
