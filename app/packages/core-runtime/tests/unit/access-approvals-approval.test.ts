import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { approve, reject } from '../../src/access/approvals/approval.ts';
import type { ApproveInput } from '../../src/access/approvals/approval.ts';
import { lapseProposal } from '../../src/access/approvals/lapse.ts';
import { proposalLifetimeMillis } from '../../src/access/approvals/policy.ts';
import { verifyHumanPrincipal } from '../../src/access/approvals/principals.ts';
import type { Proposal } from '../../src/access/model.ts';
import { ACCESS_MODEL_PARSE_OPTIONS, MandateSchema, ProposalSchema, holderKey } from '../../src/access/model.ts';
import {
  APPROVER_HOLDER,
  APPROVER_PROOF,
  AT,
  HOUR_MS,
  INVOICE_READ,
  OTHER_SCOPE,
  REQUESTER_PROOF,
  agentOf,
  at,
  assignmentIncarnationId,
  boundWitness,
  capabilityKey,
  criticalCapability,
  grantIncarnationId,
  mandateOf,
  person,
  plus,
  proposalOf,
  recordKey,
  recordScopedCapability,
  requesterWitness,
  sensitiveCapability,
} from './access-approvals-fixtures.ts';

const refusalOf = (result: Result.Result<unknown, { readonly code: string }>): string =>
  Result.isFailure(result) ? result.failure.code : expect.unreachable('expected a refusal');

const accepted = <Value>(result: Result.Result<Value, { readonly code: string }>): Value =>
  Result.isFailure(result) ? expect.unreachable(`unexpected refusal: ${result.failure.code}`) : result.success;

const approvalOf = (overrides: Partial<ApproveInput> = {}) => {
  const proposal = overrides.proposal ?? proposalOf();
  return approve({
    approver: APPROVER_PROOF,
    authority: {
      approval: boundWitness({
        assignment: 31,
        capabilityKey: proposal.capabilityKey,
        grant: 41,
        holderId: APPROVER_HOLDER,
      }),
      execution: boundWitness({
        assignment: 32,
        capabilityKey: proposal.capabilityKey,
        grant: 42,
        holderId: APPROVER_HOLDER,
      }),
      parentRecordRead: [],
    },
    capability: sensitiveCapability(),
    now: AT,
    policy: { selfApproval: 'permitted' },
    proposal,
    ...overrides,
  });
};

const approvalExpiry = (proposal: Proposal): number =>
  proposal.approval === undefined
    ? expect.unreachable('a mandate carries an approval')
    : proposal.approval.expiresAt.getTime();

const mandateIssue = (value: Proposal): string => {
  const decoded = Schema.decodeUnknownResult(MandateSchema, ACCESS_MODEL_PARSE_OPTIONS)(value);
  return Result.isFailure(decoded) ? decoded.failure.message : 'accepted';
};

const proposalIssue = (value: Proposal): string => {
  const decoded = Schema.decodeUnknownResult(ProposalSchema, ACCESS_MODEL_PARSE_OPTIONS)(value);
  return Result.isFailure(decoded) ? decoded.failure.message : 'accepted';
};

it('approves into a mandate bound to the approver incarnations and every required grant', () => {
  const proposal = proposalOf({ requester: agentOf(1, 4, 5) });
  const mandate = accepted(approvalOf({ proposal }));
  expect(mandate.status).toBe('approved');
  expect(mandate.approval?.approverId).toBe(person(2).principalId);
  expect(mandate.approval?.approvalAssignmentIncarnationId).toBe(assignmentIncarnationId(31));
  expect(mandate.approval?.executionAssignmentIncarnationId).toBe(assignmentIncarnationId(32));
  expect(mandate.approval?.approvedAt.getTime()).toBe(AT.getTime());
  expect(mandate.approval?.expiresAt.getTime()).toBe(AT.getTime() + 24 * HOUR_MS);
  const grants = mandate.witnesses.map(({ grantIncarnationId: grant, purpose }) => `${purpose}:${grant}`);
  expect(grants).toContain(`approval:${grantIncarnationId(41)}`);
  expect(grants).toContain(`execution:${grantIncarnationId(42)}`);
  expect(mandate.witnesses.filter(({ purpose }) => purpose === 'requester')).toHaveLength(2);
  expect(mandate.witnesses.filter(({ purpose }) => purpose === 'parent_record_read')).toHaveLength(0);
  expect(mandateIssue(mandate)).toBe('accepted');
  expect(proposalIssue(mandate)).toBe('accepted');
});

it('caps a critical approval at one hour and never past the proposal deadline', () => {
  const critical = criticalCapability();
  const criticalMandate = accepted(
    approvalOf({ capability: critical, proposal: proposalOf({ capability: critical }) }),
  );
  expect(approvalExpiry(criticalMandate) - AT.getTime()).toBe(HOUR_MS);

  // Approved on the last day, so the proposal deadline wins over the 24-hour approval lifetime.
  const late = accepted(approvalOf({ now: plus(AT, proposalLifetimeMillis() - HOUR_MS) }));
  expect(approvalExpiry(late)).toBe(late.expiresAt.getTime());
});

it('mints the approval proof for a verified person only (O46)', () => {
  for (const kind of ['agent', 'integration', 'service', 'system'] as const) {
    expect(refusalOf(verifyHumanPrincipal({ principalId: person(4).principalId, principalKind: kind }))).toBe(
      'approver_not_human',
    );
  }
  expect(Result.isSuccess(verifyHumanPrincipal({ principalId: person(4).principalId, principalKind: 'human' }))).toBe(
    true,
  );
  expect(accepted(approvalOf({ proposal: proposalOf() })).status).toBe('approved');
});

it('refuses an identity-bound command and accepts a declaration that supports approval', () => {
  const identityBound = sensitiveCapability({ modes: ['run', 'propose'] });
  expect(
    refusalOf(approvalOf({ capability: identityBound, proposal: proposalOf({ capability: identityBound }) })),
  ).toBe('identity_bound_action');
  expect(accepted(approvalOf({ proposal: proposalOf() })).status).toBe('approved');
});

it('needs an independent approver for raised authority, including an agent working for them', () => {
  const grant = sensitiveCapability({ capabilityKey: capabilityKey('core.role.grant'), kind: 'admin' });
  const personProposal = proposalOf({ capability: grant });
  expect(refusalOf(approvalOf({ approver: REQUESTER_PROOF, capability: grant, proposal: personProposal }))).toBe(
    'independent_approver_required',
  );
  expect(accepted(approvalOf({ capability: grant, proposal: personProposal })).status).toBe('approved');

  const agentProposal = proposalOf({
    capability: sensitiveCapability({ capabilityKey: capabilityKey('core.role-binding.revoke') }),
    requester: agentOf(2, 6, 7),
  });
  expect(
    refusalOf(
      approvalOf({
        approver: APPROVER_PROOF,
        capability: sensitiveCapability({ capabilityKey: capabilityKey('core.role-binding.revoke') }),
        proposal: agentProposal,
      }),
    ),
  ).toBe('independent_approver_required');
});

it('allows confirming an own command only where the business policy permits it', () => {
  const proposal = proposalOf();
  const ownAuthority = {
    approval: requesterWitness(31, 41),
    execution: requesterWitness(32, 42),
    parentRecordRead: [],
  };
  expect(
    accepted(
      approvalOf({
        approver: REQUESTER_PROOF,
        authority: ownAuthority,
        policy: { selfApproval: 'permitted' },
        proposal,
      }),
    ).status,
  ).toBe('approved');
  expect(
    refusalOf(
      approvalOf({
        approver: REQUESTER_PROOF,
        authority: ownAuthority,
        policy: { selfApproval: 'forbidden' },
        proposal,
      }),
    ),
  ).toBe('self_approval_forbidden');
  expect(accepted(approvalOf({ policy: { selfApproval: 'forbidden' }, proposal })).status).toBe('approved');
});

it('requires the approver read of the parent record for a record-scoped command', () => {
  const capability = recordScopedCapability();
  const proposal = proposalOf({ capability, target: recordKey('invoice-1') });
  const parentWitness = boundWitness({
    assignment: 33,
    capabilityKey: capabilityKey(INVOICE_READ),
    grant: 43,
    holderId: APPROVER_HOLDER,
  });
  const authority = (parentRecordRead: readonly ReturnType<typeof boundWitness>[]) => ({
    approval: boundWitness({
      assignment: 31,
      capabilityKey: proposal.capabilityKey,
      grant: 41,
      holderId: APPROVER_HOLDER,
    }),
    execution: boundWitness({
      assignment: 32,
      capabilityKey: proposal.capabilityKey,
      grant: 42,
      holderId: APPROVER_HOLDER,
    }),
    parentRecordRead,
  });
  expect(
    refusalOf(
      approvalOf({
        authority: authority([]),
        capability,
        parentRecordReadCapabilityKey: capabilityKey(INVOICE_READ),
        proposal,
      }),
    ),
  ).toBe('parent_record_read_missing');
  expect(
    refusalOf(
      approvalOf({
        authority: authority([
          boundWitness({
            assignment: 33,
            capabilityKey: capabilityKey('finance.invoice.list'),
            grant: 43,
            holderId: APPROVER_HOLDER,
          }),
        ]),
        capability,
        parentRecordReadCapabilityKey: capabilityKey(INVOICE_READ),
        proposal,
      }),
    ),
  ).toBe('parent_record_read_missing');
  expect(refusalOf(approvalOf({ authority: authority([parentWitness]), capability, proposal }))).toBe(
    'parent_record_read_missing',
  );
  const mandate = accepted(
    approvalOf({
      authority: authority([parentWitness]),
      capability,
      parentRecordReadCapabilityKey: capabilityKey(INVOICE_READ),
      proposal,
    }),
  );
  const parentReads = mandate.witnesses.filter(({ purpose }) => purpose === 'parent_record_read');
  expect(parentReads).toHaveLength(1);
  expect(parentReads[0]?.grantIncarnationId).toBe(grantIncarnationId(43));
  expect(
    refusalOf(
      approvalOf({
        authority: {
          approval: boundWitness({ assignment: 31, grant: 41, holderId: APPROVER_HOLDER }),
          execution: boundWitness({ assignment: 32, grant: 42, holderId: APPROVER_HOLDER }),
          parentRecordRead: [parentWitness],
        },
      }),
    ),
  ).toBe('parent_record_read_unexpected');
});

it('refuses a proposal that is no longer pending and one that expired before approval', () => {
  const mandate = mandateOf();
  expect(refusalOf(approvalOf({ proposal: mandate }))).toBe('proposal_not_pending');
  const lapsed = lapseProposal({ now: at(10), proposal: mandate });
  expect(refusalOf(approvalOf({ proposal: lapsed }))).toBe('proposal_not_pending');
  expect(refusalOf(approvalOf({ now: plus(AT, proposalLifetimeMillis()) }))).toBe('proposal_expired');
  expect(accepted(approvalOf({ now: plus(AT, 23 * HOUR_MS) })).status).toBe('approved');
});

it('refuses approver authority checked for another capability', () => {
  const other = capabilityKey('finance.invoice.issue');
  expect(
    refusalOf(
      approvalOf({
        authority: {
          approval: boundWitness({ assignment: 31, capabilityKey: other, grant: 41, holderId: APPROVER_HOLDER }),
          execution: boundWitness({ assignment: 32, grant: 42, holderId: APPROVER_HOLDER }),
          parentRecordRead: [],
        },
      }),
    ),
  ).toBe('authority_witness_mismatch');
  expect(
    refusalOf(
      approvalOf({
        authority: {
          approval: boundWitness({ assignment: 31, grant: 41, holderId: APPROVER_HOLDER }),
          execution: boundWitness({ assignment: 32, capabilityKey: other, grant: 42, holderId: APPROVER_HOLDER }),
          parentRecordRead: [],
        },
      }),
    ),
  ).toBe('authority_witness_mismatch');
});

it('refuses approver authority held by somebody else or in another scope (R2-H1)', () => {
  // (a) Somebody else's live assignment and grant is never the approver's authority.
  expect(
    refusalOf(
      approvalOf({
        authority: {
          approval: requesterWitness(31, 41),
          execution: boundWitness({ assignment: 32, grant: 42, holderId: APPROVER_HOLDER }),
          parentRecordRead: [],
        },
      }),
    ),
  ).toBe('authority_witness_mismatch');
  // (c) The same role revision held in another legal entity is not authority here (O49).
  expect(
    refusalOf(
      approvalOf({
        authority: {
          approval: boundWitness({ assignment: 31, grant: 41, holderId: APPROVER_HOLDER, scopeId: OTHER_SCOPE }),
          execution: boundWitness({ assignment: 32, grant: 42, holderId: APPROVER_HOLDER }),
          parentRecordRead: [],
        },
      }),
    ),
  ).toBe('authority_witness_mismatch');
  expect(accepted(approvalOf()).status).toBe('approved');
});

it('keeps one witness slot per purpose when the approver is the requester', () => {
  const proposal = proposalOf();
  const mandate = accepted(
    approvalOf({
      approver: REQUESTER_PROOF,
      authority: {
        approval: requesterWitness(11, 21),
        execution: requesterWitness(11, 21),
        parentRecordRead: [],
      },
      proposal,
    }),
  );
  const slots = mandate.witnesses.map(
    ({ assignmentIncarnationId: assignment, capabilityKey: key, purpose }) => `${purpose} ${assignment} ${key}`,
  );
  expect(new Set(slots).size).toBe(slots.length);
  expect(mandate.witnesses.filter(({ purpose }) => purpose === 'approval')).toHaveLength(1);
  expect(mandate.witnesses.filter(({ purpose }) => purpose === 'execution')).toHaveLength(1);
  expect(holderKey(mandate.witnesses[0]?.holderId ?? APPROVER_HOLDER)).toBe(
    holderKey({ _tag: 'Principal', principalId: person(1).principalId }),
  );
  expect(mandateIssue(mandate)).toBe('accepted');
});

it('rejects a pending proposal and refuses to reject an approved mandate (O57)', () => {
  const pending = proposalOf();
  const rejected = accepted(reject({ approver: APPROVER_PROOF, now: at(10), proposal: pending }));
  expect(rejected.status).toBe('rejected');
  expect(rejected.rejectedBy).toBe(person(2).principalId);
  expect(rejected.endedAt?.getTime()).toBe(at(10).getTime());
  expect(rejected.approval).toBeUndefined();
  expect(proposalIssue(rejected)).toBe('accepted');

  const mandate = mandateOf();
  expect(refusalOf(reject({ approver: APPROVER_PROOF, now: at(10), proposal: mandate }))).toBe('proposal_not_pending');
  const lapsed = lapseProposal({ now: at(10), proposal: mandate });
  expect(refusalOf(reject({ approver: APPROVER_PROOF, now: at(11), proposal: lapsed }))).toBe('proposal_not_pending');
  // The requester is never an eligible decider; they withdraw their own proposal instead (P6, O61).
  expect(refusalOf(reject({ approver: REQUESTER_PROOF, now: at(10), proposal: proposalOf() }))).toBe(
    'requester_cannot_reject',
  );
});
