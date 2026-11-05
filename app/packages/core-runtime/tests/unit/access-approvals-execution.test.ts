import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { approve } from '../../src/access/approvals/approval.ts';
import {
  ActionInvocationRefSchema,
  execute,
  mergeWitnessAuthority,
  witnessAuthorityMap,
  witnessAuthorityOf,
} from '../../src/access/approvals/execution.ts';
import type { ExecuteInput, WitnessExpectation, WitnessFacts } from '../../src/access/approvals/execution.ts';
import { lapseProposal } from '../../src/access/approvals/lapse.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import { ACCESS_MODEL_PARSE_OPTIONS, MandateSchema, ProposalSchema, actorHolder } from '../../src/access/model.ts';
import type { AccessMode, AuthorityWitness, CellSelector, Holder, Proposal } from '../../src/access/model.ts';
import {
  APPROVER,
  APPROVER_HOLDER,
  APPROVER_PROOF,
  AT,
  BYSTANDER,
  HOUR_MS,
  OTHER_ROLE_REVISION,
  OTHER_SCOPE,
  REQUESTER,
  REQUESTER_HOLDER,
  REQUESTER_PROOF,
  ROLE_REVISION,
  SCOPE,
  agentOf,
  boundWitness,
  capabilityKey,
  commandDigest,
  mandateOf,
  person,
  plus,
  proposalOf,
  proposeResult,
  recordKey,
  requesterWitness,
  sensitiveCapability,
  uuid,
} from './access-approvals-fixtures.ts';

const INVOCATION = Schema.decodeSync(ActionInvocationRefSchema)(uuid(500));

const REQUESTER_EXPECTATION: WitnessExpectation = { expectedHolder: REQUESTER_HOLDER, scopeId: SCOPE };
/** The facts a healthy projection reports for one bound witness. */
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

/** A record-scoped command binds its witnesses to the record it changes (P5, N6). */
const expectationFor = (expectedHolder: Holder, proposal: Proposal): WitnessExpectation =>
  withOptional({ expectedHolder, scopeId: SCOPE }, 'target', proposal.target);

/** The approver group of one proposal is held by the approver the record names (O63). */
const approverExpectationOf = (proposal: Proposal): WitnessExpectation =>
  expectationFor({ _tag: 'Principal', principalId: proposal.approval?.approverId ?? person(2).principalId }, proposal);

/** Both purpose groups of one proposal, each judged with its own expected holder (R2-H1, O63). */
const factsMap = (proposal: Proposal, overrides: (witness: AuthorityWitness) => Partial<WitnessFacts> = () => ({})) => {
  const factsFor = (purpose: 'requester' | 'other') =>
    proposal.witnesses
      .filter((witness) => (witness.purpose === 'requester') === (purpose === 'requester'))
      .map((witness) => factsOf(witness, overrides(witness)));
  return mergeWitnessAuthority(
    witnessAuthorityMap(factsFor('requester'), expectationFor(REQUESTER_HOLDER, proposal)),
    witnessAuthorityMap(factsFor('other'), approverExpectationOf(proposal)),
  );
};

const liveMap = (proposal: Proposal) => factsMap(proposal);

const failureOf = (result: Result.Result<unknown, { readonly _tag: string; readonly code?: string }>): string =>
  Result.isFailure(result) ? (result.failure.code ?? result.failure._tag) : expect.unreachable('expected a failure');

const accepted = <Value>(result: Result.Result<Value, { readonly code: string }>): Value =>
  Result.isFailure(result) ? expect.unreachable(`unexpected refusal: ${result.failure.code}`) : result.success;

const executionOf = (overrides: Partial<ExecuteInput> = {}) => {
  const proposal = overrides.proposal ?? mandateOf();
  return execute({
    actionInvocationId: INVOCATION,
    actor: APPROVER,
    commandDigest: commandDigest('1'.repeat(64)),
    now: plus(AT, HOUR_MS),
    proposal,
    witnessAuthority: liveMap(proposal),
    ...overrides,
  });
};

it('executes an approved mandate once and records the receipt', () => {
  const executed = accepted(executionOf());
  expect(executed.status).toBe('executed');
  expect(executed.execution?.actionInvocationId).toBe(INVOCATION);
  expect(executed.execution?.executedAt.getTime()).toBe(plus(AT, HOUR_MS).getTime());
  expect(executed.approval?.approverId).toBe(APPROVER_PROOF.principalId);
  const decoded = Schema.decodeUnknownResult(MandateSchema, ACCESS_MODEL_PARSE_OPTIONS)(executed);
  expect(Result.isFailure(decoded) ? decoded.failure.message : 'accepted').toBe('accepted');
  const proposalDecoded = Schema.decodeUnknownResult(ProposalSchema, ACCESS_MODEL_PARSE_OPTIONS)(executed);
  expect(Result.isFailure(proposalDecoded) ? proposalDecoded.failure.message : 'accepted').toBe('accepted');
});

it('refuses a second execution and keeps the first receipt', () => {
  const executed = accepted(executionOf());
  expect(failureOf(executionOf({ proposal: executed }))).toBe('proposal_already_executed');
  expect(executed.execution?.actionInvocationId).toBe(INVOCATION);
});

it('refuses a command that changed after the approval', () => {
  expect(failureOf(executionOf({ commandDigest: commandDigest('2'.repeat(64)) }))).toBe('command_changed');
  expect(accepted(executionOf({ commandDigest: commandDigest('1'.repeat(64)) })).status).toBe('executed');
});

it('refuses lost authority and a lapsed mandate never executes', () => {
  const mandate = mandateOf();
  const broken = new Map(liveMap(mandate));
  const [first] = [...broken.keys()];
  if (first === undefined) {
    expect.unreachable('a mandate binds witnesses');
  }
  broken.set(first, 'lost');
  expect(failureOf(executionOf({ proposal: mandate, witnessAuthority: broken }))).toBe('authority_lost');
  const lapsed = lapseProposal({ now: plus(AT, HOUR_MS), proposal: mandate });
  expect(failureOf(executionOf({ proposal: lapsed }))).toBe('proposal_lapsed');
});

it('reports an unanswered witness as unavailable instead of a denial', () => {
  const mandate = mandateOf();
  const unanswered = new Map(liveMap(mandate));
  const [first] = [...unanswered.keys()];
  if (first === undefined) {
    expect.unreachable('a mandate binds witnesses');
  }
  unanswered.set(first, 'unavailable');
  expect(failureOf(executionOf({ proposal: mandate, witnessAuthority: unanswered }))).toBe(
    'approval_authority_unavailable',
  );
  expect(failureOf(executionOf({ proposal: mandate, witnessAuthority: new Map() }))).toBe(
    'approval_authority_unavailable',
  );
  expect(mandate.status).toBe('approved');
});

it('refuses execution after the approval expired and accepts it one millisecond earlier', () => {
  const mandate = mandateOf();
  expect(failureOf(executionOf({ now: plus(AT, 24 * HOUR_MS), proposal: mandate }))).toBe('proposal_expired');
  expect(accepted(executionOf({ now: plus(AT, 24 * HOUR_MS - 1), proposal: mandate })).status).toBe('executed');
});

it('refuses a proposal that nobody approved yet', () => {
  expect(failureOf(executionOf({ proposal: proposalOf() }))).toBe('proposal_not_approved');
});

it('lets only the approving person execute, never an agent, the requester or a bystander (O63)', () => {
  expect(failureOf(executionOf({ actor: REQUESTER }))).toBe('execution_not_permitted');
  expect(failureOf(executionOf({ actor: agentOf(1, 4, 5) }))).toBe('agent_cannot_execute');
  expect(failureOf(executionOf({ actor: BYSTANDER }))).toBe('execution_not_permitted');
  // The approver's own agent is still an agent: a mandate exists only for work agents never run.
  expect(failureOf(executionOf({ actor: agentOf(2, 6, 7) }))).toBe('agent_cannot_execute');
  expect(accepted(executionOf({ actor: APPROVER })).status).toBe('executed');
});

it('refuses the requester agent under self-approval even though its person approved (O63, P6)', () => {
  const requesterAgent = agentOf(1, 4, 5);
  const agentHolder = actorHolder(requesterAgent);
  const agentProposal = accepted(proposeResult({ requester: requesterAgent }));
  expect(agentProposal.witnesses[0]?.holderId).toStrictEqual(agentHolder);
  // The person the agent works for approves the agent's proposal, so the mandate belongs to them.
  const mandate = accepted(
    approve({
      approver: REQUESTER_PROOF,
      authority: {
        approval: boundWitness({ assignment: 31, grant: 41, holderId: REQUESTER_HOLDER }),
        execution: boundWitness({ assignment: 32, grant: 42, holderId: REQUESTER_HOLDER }),
        parentRecordRead: [],
      },
      capability: sensitiveCapability(),
      now: AT,
      policy: { selfApproval: 'permitted' },
      proposal: agentProposal,
    }),
  );
  const facts = mergeWitnessAuthority(
    witnessAuthorityMap(
      mandate.witnesses.filter(({ purpose }) => purpose === 'requester').map((witness) => factsOf(witness)),
      { expectedHolder: agentHolder, scopeId: SCOPE },
    ),
    witnessAuthorityMap(
      mandate.witnesses.filter(({ purpose }) => purpose !== 'requester').map((witness) => factsOf(witness)),
      approverExpectationOf(mandate),
    ),
  );
  expect(failureOf(executionOf({ actor: requesterAgent, proposal: mandate, witnessAuthority: facts }))).toBe(
    'agent_cannot_execute',
  );
  // The approving person still executes the mandate their agent prepared.
  expect(failureOf(executionOf({ actor: APPROVER, proposal: mandate, witnessAuthority: facts }))).toBe(
    'execution_not_permitted',
  );
  expect(accepted(executionOf({ actor: REQUESTER, proposal: mandate, witnessAuthority: facts })).status).toBe(
    'executed',
  );
});

it('lets a self-approving requester execute their own mandate (P6)', () => {
  const proposal = proposalOf();
  const mandate = accepted(
    approve({
      approver: REQUESTER_PROOF,
      authority: {
        approval: requesterWitness(31, 41),
        execution: requesterWitness(32, 42),
        parentRecordRead: [],
      },
      capability: sensitiveCapability(),
      now: AT,
      policy: { selfApproval: 'permitted' },
      proposal,
    }),
  );
  expect(accepted(executionOf({ actor: REQUESTER, proposal: mandate })).status).toBe('executed');
});

it('derives a witness verdict from facts and refuses a broken role binding (O49)', () => {
  const mandate = mandateOf();
  const [firstWitness] = mandate.witnesses;
  if (firstWitness === undefined) {
    expect.unreachable('a mandate carries witnesses');
  }
  expect(witnessAuthorityOf(factsOf(firstWitness), REQUESTER_EXPECTATION)).toBe('live');
  expect(
    witnessAuthorityOf(factsOf(firstWitness, { grantRoleRevisionId: OTHER_ROLE_REVISION }), REQUESTER_EXPECTATION),
  ).toBe('lost');
  expect(witnessAuthorityOf(factsOf(firstWitness, { assignmentRoleRevisionId: null }), REQUESTER_EXPECTATION)).toBe(
    'unavailable',
  );
  expect(witnessAuthorityOf(factsOf(firstWitness, { grantState: 'unavailable' }), REQUESTER_EXPECTATION)).toBe(
    'unavailable',
  );
  expect(witnessAuthorityOf(factsOf(firstWitness, { assignmentState: 'lost' }), REQUESTER_EXPECTATION)).toBe('lost');
});

it('refuses a witness of another holder, mode, capability or scope (R2-H1)', () => {
  const approvalWitness = mandateOf().witnesses.find(({ purpose }) => purpose === 'approval');
  if (approvalWitness === undefined) {
    expect.unreachable('a mandate binds an approval witness');
  }
  const approverExpectation = { expectedHolder: APPROVER_HOLDER, scopeId: SCOPE };
  // (a) A projection that reports somebody else's assignment never justifies the approver's mandate.
  expect(witnessAuthorityOf(factsOf(approvalWitness, { holderId: REQUESTER_HOLDER }), approverExpectation)).toBe(
    'lost',
  );
  // (b) A propose-mode grant can never serve as the approve witness.
  expect(
    witnessAuthorityOf(
      factsOf(approvalWitness, {
        grantCell: { capabilityKey: approvalWitness.capabilityKey, mode: 'propose', selector: { _tag: 'all' } },
      }),
      approverExpectation,
    ),
  ).toBe('lost');
  // (d) The witness's capability must be the grant cell's real capability.
  expect(
    witnessAuthorityOf(
      factsOf(approvalWitness, {
        grantCell: {
          capabilityKey: capabilityKey('finance.invoice.issue'),
          mode: 'approve',
          selector: { _tag: 'all' },
        },
      }),
      approverExpectation,
    ),
  ).toBe('lost');
  // (c) The same role revision held in another legal entity is not authority here (O49).
  expect(witnessAuthorityOf(factsOf(approvalWitness, { grantScopeId: OTHER_SCOPE }), approverExpectation)).toBe('lost');
  expect(witnessAuthorityOf(factsOf(approvalWitness, { assignmentScopeId: OTHER_SCOPE }), approverExpectation)).toBe(
    'lost',
  );
  // The same facts are live for the holder and the scope the purpose expects.
  expect(witnessAuthorityOf(factsOf(approvalWitness), approverExpectation)).toBe('live');
});

it('refuses execution when the approver assignment left the approval binding (O49)', () => {
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
      approverExpectationOf(mandate),
    ),
  );
  expect(failureOf(executionOf({ proposal: mandate, witnessAuthority: rebound }))).toBe('authority_lost');
  expect(accepted(executionOf({ proposal: mandate })).status).toBe('executed');
});

it('keeps the approver grant witnesses bound to the exact incarnations they were approved with', () => {
  const mandate = mandateOf();
  const executed = accepted(executionOf({ proposal: mandate }));
  const executionWitness = executed.witnesses.find(({ purpose }) => purpose === 'execution');
  expect(executionWitness?.grantIncarnationId).toBe(
    mandate.witnesses.find(({ purpose }) => purpose === 'execution')?.grantIncarnationId,
  );
  expect(executionWitness?.holderId).toStrictEqual(APPROVER_HOLDER);
  expect(executed.witnesses).toStrictEqual(mandate.witnesses);
});

it('refuses a mandate whose witness no longer reaches the record the command changes (P5, N6)', () => {
  const mandate = mandateOf({ target: recordKey('invoice-1') });
  // Every witness still reaches the record it changes, so the mandate executes once.
  expect(accepted(executionOf({ proposal: mandate })).status).toBe('executed');

  // An `assigned` cell of a record-scoped command is only as good as the projection's answer.
  const withReach = (reachesTarget: boolean | null) =>
    factsMap(mandate, (witness) =>
      witness.purpose === 'execution'
        ? {
            grantCell: { capabilityKey: witness.capabilityKey, mode: 'run', selector: { _tag: 'assigned' } },
            reachesTarget,
          }
        : {},
    );
  // The record was reassigned out of the approver's cell: the incarnation is live, the reach is not.
  expect(failureOf(executionOf({ proposal: mandate, witnessAuthority: withReach(false) }))).toBe('authority_lost');
  // An unanswered reach is a retryable failure, never an assumption that the record is reached.
  expect(failureOf(executionOf({ proposal: mandate, witnessAuthority: withReach(null) }))).toBe(
    'approval_authority_unavailable',
  );
  expect(accepted(executionOf({ proposal: mandate, witnessAuthority: withReach(true) })).status).toBe('executed');
});

it('reads the reach of an explicit-target cell from the cell itself (N6)', () => {
  const mandate = mandateOf({ target: recordKey('invoice-1') });
  const approvalWitness = mandate.witnesses.find(({ purpose }) => purpose === 'approval');
  const requesterBound = mandate.witnesses.find(({ purpose }) => purpose === 'requester');
  if (approvalWitness === undefined || requesterBound === undefined) {
    expect.unreachable('a record-scoped mandate binds an approval and a requester witness');
  }
  const approvalExpectation = approverExpectationOf(mandate);
  const cell = (selector: CellSelector, mode: AccessMode = 'approve') => ({
    capabilityKey: approvalWitness.capabilityKey,
    mode,
    selector,
  });
  // A `targets` cell that names another record cannot reach this one, whatever the projection says.
  expect(
    witnessAuthorityOf(
      factsOf(approvalWitness, {
        grantCell: cell({ _tag: 'targets', recordKeys: [recordKey('invoice-2')] }),
        reachesTarget: true,
      }),
      approvalExpectation,
    ),
  ).toBe('lost');
  // The same cell naming the record does reach it without asking the projection.
  expect(
    witnessAuthorityOf(
      factsOf(approvalWitness, {
        grantCell: cell({ _tag: 'targets', recordKeys: [recordKey('invoice-1')] }),
        reachesTarget: null,
      }),
      approvalExpectation,
    ),
  ).toBe('live');
  // An `assigned` cell is only as good as the projection's answer about the record itself.
  expect(
    witnessAuthorityOf(
      factsOf(approvalWitness, { grantCell: cell({ _tag: 'assigned' }), reachesTarget: false }),
      approvalExpectation,
    ),
  ).toBe('lost');
  expect(
    witnessAuthorityOf(
      factsOf(approvalWitness, { grantCell: cell({ _tag: 'assigned' }), reachesTarget: null }),
      approvalExpectation,
    ),
  ).toBe('unavailable');
  expect(
    witnessAuthorityOf(
      factsOf(approvalWitness, { grantCell: cell({ _tag: 'assigned' }), reachesTarget: true }),
      approvalExpectation,
    ),
  ).toBe('live');
  // A command that changes no record is not decided by a record's reach.
  expect(
    witnessAuthorityOf(
      factsOf(requesterBound, { grantCell: cell({ _tag: 'assigned' }, 'propose'), reachesTarget: false }),
      REQUESTER_EXPECTATION,
    ),
  ).toBe('live');
});
