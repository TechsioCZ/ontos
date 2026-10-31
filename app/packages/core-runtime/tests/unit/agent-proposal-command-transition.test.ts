import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AgentProposalCommandPayloadSchema } from '../../src/auth/agent-proposal-command-contract.ts';
import { AgentProposalCommandError } from '../../src/auth/agent-proposal-command-error.ts';
import { isProposableCommand } from '../../src/auth/agent-proposal-command-preparation.ts';
import { planProposalTransition, proposalReservationQuery } from '../../src/auth/agent-proposal-command-transition.ts';
import { mutateAgentProposalsAction } from '../../src/modules/actions/mutate-agent-proposals.action.ts';
import {
  batchId,
  humanId,
  laterTime,
  nextInvocationId,
  operationTime,
  otherHumanId,
  proposalId,
  proposalRow,
  reservationAudit,
  reservationId,
  transitionInput,
} from '../support/agent-proposal-command-fixture.ts';

it('requires native execution provisioning, company scope and native idempotency', () => {
  const { descriptor } = mutateAgentProposalsAction;
  expect(descriptor.actionKey).toBe('core.identity.mutate-agent-proposals');
  expect(descriptor.entrypoint.authorization).toEqual({ kind: 'action_execution', provisioning: 'explicit' });
  expect(descriptor.legalEntityScope).toBe('required');
  expect(descriptor.idempotency).toBe('required');
  expect(descriptor.auditProfile).toBe('sensitive');
});

it('rejects caller-selected authority, unbounded batches and agent-supplied undo', () => {
  const decode = Schema.decodeUnknownOption(AgentProposalCommandPayloadSchema, { onExcessProperty: 'error' });
  const proposal = {
    actionSlug: 'update',
    appId: 'tasks',
    command: { title: 'New' },
    diff: [],
    moduleKey: 'work.tasks',
    proposalId,
    reason: 'Requested',
    risk: 'low',
    summary: 'Update',
    targetLabel: 'Task',
  };
  const payload = { batchId, instruction: 'Update tasks', operation: 'insert', proposals: [proposal] };
  expect(Option.isSome(decode(payload))).toBe(true);
  expect(Option.isNone(decode({ ...payload, principalId: humanId }))).toBe(true);
  expect(Option.isNone(decode({ ...payload, proposals: Array.from({ length: 51 }, () => proposal) }))).toBe(true);
  expect(
    Option.isNone(decode({ ...payload, proposals: [{ ...proposal, revert: { kind: 'none', reason: 'No' } }] })),
  ).toBe(true);
  expect(Option.isNone(decode({ batchId, operation: 'execute-sql', sql: 'delete everything' }))).toBe(true);
});

it('allows exact named Actions or nonempty module commands, never nested human decision commands', () => {
  expect(isProposableCommand('update', { title: 'New' })).toBe(true);
  expect(isProposableCommand('update', { _tag: 'UpdateTask' })).toBe(false);
  expect(isProposableCommand('apply-command', { _tag: 'UpdateTask' })).toBe(true);
  expect(isProposableCommand('apply-command', { _tag: '' })).toBe(false);
  expect(isProposableCommand('apply-command', { _tag: 'AiDecideChanges' })).toBe(false);
  expect(isProposableCommand('apply-command', { _tag: 'AiRevertBatch' })).toBe(false);
});

it.effect('atomically claims one pending row under the native invocation identity', () =>
  Effect.gen(function* claim() {
    const row = proposalRow();
    const transition = yield* planProposalTransition(
      { batchId, operation: 'claim-approval', proposalId },
      transitionInput([row]),
    );
    expect(transition).toEqual({
      affected: [row],
      reservationId: nextInvocationId,
      values: { decidedAt: laterTime, decidedByPrincipalId: humanId },
    });
  }),
);

for (const [name, patch] of [
  ['a decided row', { status: 'applied' }],
  ['a reserved batch', { batchRevertedAt: operationTime }],
  ['an older unresolved approval', { decidedAt: operationTime, decidedByPrincipalId: otherHumanId }],
] as const) {
  it.effect(`cannot claim ${name}`, () =>
    Effect.gen(function* cannotClaim() {
      const result = yield* planProposalTransition(
        { batchId, operation: 'claim-approval', proposalId },
        transitionInput([proposalRow(patch)]),
      );
      expect(result.affected).toEqual([]);
      expect(result.reservationId).toBeUndefined();
    }),
  );
}

for (const operation of ['release-approval', 'mark-applied', 'mark-failed'] as const) {
  it.effect(`${operation} rejects a different principal and stale reservation`, () =>
    Effect.gen(function* exactClaim() {
      const payload = {
        applyResult: { id: 'updated' },
        batchId,
        failure: 'Failed',
        operation,
        proposalId,
        reservationId,
      };
      const stolen = proposalRow({ decidedAt: operationTime, decidedByPrincipalId: otherHumanId });
      const failure = yield* planProposalTransition(payload, transitionInput([stolen])).pipe(Effect.flip);
      expect(Schema.is(AgentProposalCommandError)(failure)).toBe(true);
      const own = proposalRow({ decidedAt: operationTime, decidedByPrincipalId: humanId });
      const stale = yield* planProposalTransition(
        { ...payload, reservationId: nextInvocationId },
        transitionInput([own]),
      ).pipe(Effect.flip);
      expect(stale.code).toBe('agent_proposal_conflict');
    }),
  );
}

it.effect('releases only the current owning claim and preserves undecided chronology', () =>
  Effect.gen(function* release() {
    const row = proposalRow({ decidedAt: operationTime, decidedByPrincipalId: humanId });
    const result = yield* planProposalTransition(
      { batchId, operation: 'release-approval', proposalId, reservationId },
      transitionInput([row]),
    );
    expect(result).toEqual({ affected: [row], values: { decidedAt: null, decidedByPrincipalId: null } });
  }),
);

it.effect('records approval completion time and keeps the reviewed diff unless replaced', () =>
  Effect.gen(function* applied() {
    const row = proposalRow({ decidedAt: operationTime, decidedByPrincipalId: humanId });
    const result = yield* planProposalTransition(
      { applyResult: { id: 'updated' }, batchId, operation: 'mark-applied', proposalId, reservationId },
      transitionInput([row]),
    );
    expect(result.values).toEqual({
      appliedAt: laterTime,
      applyResultJson: { id: 'updated' },
      decidedAt: laterTime,
      diffJson: row.diffJson,
      failure: null,
      revertJson: null,
      status: 'applied',
    });
  }),
);

it.effect('rejects only unclaimed pending proposals', () =>
  Effect.gen(function* rejected() {
    const payload = { batchId, note: 'Not accepted', operation: 'mark-rejected' as const, proposalId };
    const row = proposalRow();
    const result = yield* planProposalTransition(payload, transitionInput([row]));
    expect(result.values).toEqual({
      decidedAt: laterTime,
      decidedByPrincipalId: humanId,
      decisionNote: 'Not accepted',
      status: 'rejected',
    });
    const reserved = yield* planProposalTransition(
      payload,
      transitionInput([proposalRow({ decidedAt: operationTime })]),
    );
    expect(reserved.affected).toEqual([]);
  }),
);

it.effect('reserves every batch sibling together and refuses any live approval', () =>
  Effect.gen(function* batchClaim() {
    const applied = proposalRow({ appliedAt: operationTime, status: 'applied' });
    const pending = proposalRow({ position: 1, proposalId: '60000000-0000-4000-8000-000000000002' });
    const payload = { batchId, note: 'Undo', operation: 'claim-batch-revert' as const };
    const result = yield* planProposalTransition(payload, transitionInput([applied, pending]));
    expect(result.affected).toEqual([applied, pending]);
    expect(result.reservationId).toBe(nextInvocationId);
    expect(result.values).toEqual({
      batchRevertedAt: laterTime,
      batchRevertedByPrincipalId: humanId,
      batchRevertNote: 'Undo',
    });
    const blocked = yield* planProposalTransition(
      payload,
      transitionInput([applied, { ...pending, decidedAt: operationTime }]),
    );
    expect(blocked.affected).toEqual([]);
  }),
);

it.effect('requires the exact revert owner for both terminal outcomes and pending closure', () =>
  Effect.gen(function* revertOwner() {
    const row = proposalRow({
      batchRevertedAt: operationTime,
      batchRevertedByPrincipalId: otherHumanId,
      status: 'applied',
    });
    for (const operation of ['mark-reverted', 'mark-revert-failed', 'close-pending-in-batch'] as const) {
      const error = yield* planProposalTransition(
        { batchId, failure: 'Undo failed', note: 'Undo', operation, proposalId, reservationId },
        transitionInput([row], reservationAudit('claim-batch-revert')),
      ).pipe(Effect.flip);
      expect(error.code).toBe('agent_proposal_conflict');
    }
  }),
);

it.effect('keeps original approval chronology on revert and clears failure only on success', () =>
  Effect.gen(function* chronology() {
    const row = proposalRow({
      appliedAt: operationTime,
      batchRevertedAt: operationTime,
      batchRevertedByPrincipalId: humanId,
      decidedAt: operationTime,
      decidedByPrincipalId: otherHumanId,
      status: 'revert_failed',
    });
    const input = transitionInput([row], reservationAudit('claim-batch-revert'));
    const success = yield* planProposalTransition(
      { batchId, operation: 'mark-reverted', proposalId, reservationId },
      input,
    );
    expect(success.values).toEqual({
      failure: null,
      revertedAt: laterTime,
      revertedByPrincipalId: humanId,
      status: 'reverted',
    });
    const failure = yield* planProposalTransition(
      { batchId, failure: 'Module refused', operation: 'mark-revert-failed', proposalId, reservationId },
      input,
    );
    expect(failure.values).toEqual({ failure: 'Module refused', status: 'revert_failed' });
  }),
);

it.effect('closes only unclaimed pending rows during bounded withdrawal or reserved batch closure', () =>
  Effect.gen(function* closure() {
    const pending = proposalRow({ batchRevertedAt: operationTime, batchRevertedByPrincipalId: humanId });
    const applied = proposalRow({
      ...pending,
      position: 1,
      proposalId: '60000000-0000-4000-8000-000000000002',
      status: 'applied',
    });
    for (const operation of ['withdraw-pending-of-agent', 'close-pending-in-batch'] as const) {
      const result = yield* planProposalTransition(
        { batchId, note: 'Closed', operation, reservationId },
        transitionInput([pending, applied], reservationAudit('claim-batch-revert')),
      );
      expect(result.affected).toEqual([pending]);
      expect(result.values.status).toBe('rejected');
    }
  }),
);

it.effect('a second revert contender cannot steal the batch even after a long delay', () =>
  Effect.gen(function* revertContenders() {
    const row = proposalRow({ appliedAt: operationTime, status: 'applied' });
    const payload = { batchId, operation: 'claim-batch-revert' as const };
    const first = yield* planProposalTransition(payload, transitionInput([row]));
    expect(first.reservationId).toBe(nextInvocationId);
    const reserved = proposalRow({ ...row, batchRevertedAt: laterTime, batchRevertedByPrincipalId: humanId });
    expect(first.values.batchRevertedAt).toEqual(reserved.batchRevertedAt);
    expect(first.values.batchRevertedByPrincipalId).toEqual(reserved.batchRevertedByPrincipalId);
    const second = yield* planProposalTransition(payload, {
      ...transitionInput([reserved]),
      actorPrincipalId: otherHumanId,
      invocationId: reservationId,
    });
    expect(second.affected).toEqual([]);
    expect(second.reservationId).toBeUndefined();
    const stolen = yield* planProposalTransition(
      { batchId, operation: 'mark-reverted', proposalId, reservationId: nextInvocationId },
      {
        ...transitionInput([reserved], { ...reservationAudit('claim-batch-revert'), reservationId: nextInvocationId }),
        actorPrincipalId: otherHumanId,
      },
    ).pipe(Effect.flip);
    expect(stolen.code).toBe('agent_proposal_conflict');
  }),
);

it('looks up approval reservations by proposal and batch revert reservations by batch', () => {
  expect(
    proposalReservationQuery({ applyResult: null, batchId, operation: 'mark-applied', proposalId, reservationId }),
  ).toEqual(Option.some({ operation: 'claim-approval', proposalId }));
  expect(proposalReservationQuery({ batchId, operation: 'mark-reverted', proposalId, reservationId })).toEqual(
    Option.some({ operation: 'claim-batch-revert' }),
  );
  expect(proposalReservationQuery({ batchId, operation: 'claim-approval', proposalId })).toEqual(Option.none());
});
