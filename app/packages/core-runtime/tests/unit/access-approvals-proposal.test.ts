import { Match, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { lapseProposal } from '../../src/access/approvals/lapse.ts';
import {
  approvalLifetimeMillis,
  isApprovable,
  isIdentityBound,
  isProposable,
  proposalLifetimeMillis,
  raisesAuthority,
} from '../../src/access/approvals/policy.ts';
import { propose, withdraw } from '../../src/access/approvals/proposal.ts';
import type { ActorContext } from '../../src/access/model.ts';
import { ACCESS_MODEL_PARSE_OPTIONS, ProposalSchema, actorHolder, holderKey } from '../../src/access/model.ts';
import {
  APPROVER_HOLDER,
  AT,
  BYSTANDER,
  DAY_MS,
  HOUR_MS,
  OTHER_SCOPE,
  REQUESTER,
  REQUESTER_HOLDER,
  SCOPE,
  TENANT,
  agentOf,
  at,
  boundWitness,
  capabilityKey,
  commandDigest,
  criticalCapability,
  mandateOf,
  person,
  proposalId,
  proposalOf,
  proposeResult,
  requesterWitness,
  sensitiveCapability,
} from './access-approvals-fixtures.ts';

const refusalOf = (result: Result.Result<unknown, { readonly code: string }>): string =>
  Result.isFailure(result) ? result.failure.code : expect.unreachable('expected a refusal');

/** The actor kind, read through the tagged vocabulary instead of comparing tags by hand. */
const requesterTagOf = (actor: ActorContext): string =>
  Match.value(actor).pipe(
    Match.tag('Agent', () => 'agent'),
    Match.tag('Principal', () => 'person'),
    Match.exhaustive,
  );

const accepted = <Value>(result: Result.Result<Value, { readonly code: string }>): Value =>
  Result.isFailure(result) ? expect.unreachable(`unexpected refusal: ${result.failure.code}`) : result.success;

it('proposes a pending command bound to the requester authority and the catalog tier', () => {
  const sensitive = proposalOf();
  expect(sensitive.status).toBe('pending');
  expect(sensitive.approval).toBeUndefined();
  expect(sensitive.commandDigest).toBe(commandDigest('1'.repeat(64)));
  // An unapproved proposal waits for a person on its own deadline, not the approval lifetime (R2-L7).
  expect(sensitive.expiresAt.getTime() - AT.getTime()).toBe(proposalLifetimeMillis());
  expect(proposalLifetimeMillis()).toBe(7 * DAY_MS);
  expect(sensitive.witnesses.map(({ purpose }) => purpose)).toStrictEqual(['requester', 'requester']);
  expect(sensitive.witnesses.map(({ holderId }) => holderKey(holderId))).toStrictEqual([
    holderKey(REQUESTER_HOLDER),
    holderKey(REQUESTER_HOLDER),
  ]);
  expect(approvalLifetimeMillis('routine')).toBe(24 * HOUR_MS);
  expect(approvalLifetimeMillis('critical')).toBe(HOUR_MS);
  const decoded = Schema.decodeUnknownResult(ProposalSchema, ACCESS_MODEL_PARSE_OPTIONS)(sensitive);
  expect(Result.isFailure(decoded) ? decoded.failure.message : 'accepted').toBe('accepted');

  // A critical proposal is not approved yet, so the one-hour approval clock has not started (R2-L7).
  const critical = proposalOf({ capability: criticalCapability() });
  expect(critical.expiresAt.getTime() - AT.getTime()).toBe(proposalLifetimeMillis());
});

it('refuses an ephemeral command and accepts the same command when it is not ephemeral', () => {
  const ephemeral = sensitiveCapability({ ephemeral: true });
  expect(isProposable(ephemeral)).toBe(false);
  expect(refusalOf(proposeResult({ capability: ephemeral }))).toBe('ephemeral_not_proposable');
  expect(proposalOf({ capability: sensitiveCapability() }).status).toBe('pending');
});

it('refuses a declaration without the propose mode and accepts one that declares it', () => {
  const runOnly = sensitiveCapability({ modes: ['run'] });
  expect(isProposable(runOnly)).toBe(false);
  expect(refusalOf(proposeResult({ capability: runOnly }))).toBe('capability_not_proposable');
  expect(proposalOf({ capability: sensitiveCapability({ modes: ['run', 'propose', 'approve'] }) }).status).toBe(
    'pending',
  );
});

it('refuses an agent proposing an administrative command and accepts it from a person', () => {
  const administrative = sensitiveCapability({
    capabilityKey: capabilityKey('core.role.grant'),
    kind: 'admin',
  });
  expect(raisesAuthority(administrative)).toBe(true);
  expect(refusalOf(proposeResult({ capability: administrative, requester: agentOf(1, 4, 5) }))).toBe(
    'agent_cannot_propose',
  );
  expect(Result.isSuccess(proposeResult({ capability: administrative, requester: REQUESTER }))).toBe(true);
  const agentProposal = proposalOf({ capability: sensitiveCapability(), requester: agentOf(1, 4, 5) });
  expect(requesterTagOf(agentProposal.requester)).toBe('agent');
  expect(agentProposal.status).toBe('pending');
  // The agent's witness is the agent's own holder, never the person it works for (guarantee 4).
  const agentHolder = holderKey(actorHolder(agentOf(1, 4, 5)));
  expect(agentProposal.witnesses.map(({ holderId }) => holderKey(holderId))).toStrictEqual([agentHolder, agentHolder]);
});

it('refuses authority checked for another capability and collapses repeated witnesses', () => {
  const capability = sensitiveCapability();
  const offer = (requesterAuthority: readonly ReturnType<typeof requesterWitness>[]) =>
    propose({
      capability,
      commandDigest: commandDigest('1'.repeat(64)),
      now: AT,
      proposalId: proposalId(102),
      requester: REQUESTER,
      requesterAuthority,
      scopeId: SCOPE,
      tenantId: TENANT,
    });
  expect(refusalOf(offer([requesterWitness(11, 21, capabilityKey('finance.invoice.issue'))]))).toBe(
    'authority_witness_mismatch',
  );
  expect(refusalOf(offer([]))).toBe('requester_authority_missing');
  const collapsed = accepted(offer([requesterWitness(11, 21), requesterWitness(11, 21)]));
  expect(collapsed.witnesses).toHaveLength(1);
});

it('refuses a witness that belongs to somebody else or to another scope (R2-H1)', () => {
  const capability = sensitiveCapability();
  const offer = (requesterAuthority: readonly ReturnType<typeof requesterWitness>[]) =>
    propose({
      capability,
      commandDigest: commandDigest('1'.repeat(64)),
      now: AT,
      proposalId: proposalId(103),
      requester: REQUESTER,
      requesterAuthority,
      scopeId: SCOPE,
      tenantId: TENANT,
    });
  // (a) Another person's live assignment and grant is never the requester's authority.
  expect(refusalOf(offer([boundWitness({ assignment: 11, grant: 21, holderId: APPROVER_HOLDER })]))).toBe(
    'authority_witness_mismatch',
  );
  // (c) The same role revision held in another legal entity is not authority here (O49).
  expect(refusalOf(offer([boundWitness({ assignment: 11, grant: 21, scopeId: OTHER_SCOPE })]))).toBe(
    'authority_witness_mismatch',
  );
  expect(Result.isSuccess(offer([requesterWitness(11, 21)]))).toBe(true);
});

it('withdraws a pending proposal as rejected and an approved mandate as lapsed, keeping the approval', () => {
  const pending = proposalOf();
  const withdrawn = accepted(withdraw({ actor: REQUESTER, eligibility: 'requester', now: at(10), proposal: pending }));
  expect(withdrawn.status).toBe('rejected');
  expect(withdrawn.rejectedBy).toBe(person(1).principalId);
  expect(withdrawn.endedAt?.getTime()).toBe(at(10).getTime());
  expect(withdrawn.approval).toBeUndefined();

  const mandate = mandateOf();
  const withdrawnMandate = accepted(
    withdraw({ actor: REQUESTER, eligibility: 'requester', now: at(10, 30), proposal: mandate }),
  );
  // The model and the SQL trigger both refuse `approved → rejected`, so withdrawal lapses instead (O57).
  expect(withdrawnMandate.status).toBe('lapsed');
  expect(withdrawnMandate.approval).toStrictEqual(mandate.approval);
  expect(withdrawnMandate.endedAt?.getTime()).toBe(at(10, 30).getTime());
  const decoded = Schema.decodeUnknownResult(ProposalSchema, ACCESS_MODEL_PARSE_OPTIONS)(withdrawnMandate);
  expect(Result.isFailure(decoded) ? decoded.failure.message : 'accepted').toBe('accepted');

  // Only the holder withdraws as the requester; Core resolves the other grounds, never the caller.
  expect(refusalOf(withdraw({ actor: BYSTANDER, eligibility: 'requester', now: at(10), proposal: pending }))).toBe(
    'withdrawal_not_permitted',
  );
  expect(
    Result.isSuccess(withdraw({ actor: BYSTANDER, eligibility: 'administrator', now: at(10), proposal: pending })),
  ).toBe(true);
  // An agent never ends another holder's proposal, whatever ground it is offered.
  expect(
    refusalOf(withdraw({ actor: agentOf(1, 4, 5), eligibility: 'approver', now: at(10), proposal: pending })),
  ).toBe('withdrawal_by_agent_forbidden');
  expect(
    refusalOf(withdraw({ actor: agentOf(1, 4, 5), eligibility: 'administrator', now: at(10), proposal: pending })),
  ).toBe('withdrawal_by_agent_forbidden');
  // The requester's own agent withdraws the request it made itself (O35).
  const agentRequest = proposalOf({ requester: agentOf(1, 4, 5) });
  expect(
    accepted(withdraw({ actor: agentOf(1, 4, 5), eligibility: 'requester', now: at(10), proposal: agentRequest }))
      .status,
  ).toBe('rejected');

  const lapsed = lapseProposal({ now: at(11), proposal: mandate });
  expect(refusalOf(withdraw({ actor: REQUESTER, eligibility: 'administrator', now: at(12), proposal: lapsed }))).toBe(
    'proposal_not_withdrawable',
  );
});

it('exposes the declaration rules the approve step depends on', () => {
  expect(isApprovable(sensitiveCapability())).toBe(true);
  expect(isIdentityBound(sensitiveCapability())).toBe(false);
  expect(isIdentityBound(sensitiveCapability({ modes: ['run', 'propose'] }))).toBe(true);
  expect(isApprovable(sensitiveCapability({ modes: ['run', 'propose'] }))).toBe(false);
  expect(isApprovable(sensitiveCapability({ ephemeral: true }))).toBe(false);
  expect(raisesAuthority(sensitiveCapability())).toBe(false);
  expect(raisesAuthority(sensitiveCapability({ raisesAuthority: true }))).toBe(true);
  expect(raisesAuthority(sensitiveCapability({ capabilityKey: capabilityKey('core.role.revoke') }))).toBe(true);
});
