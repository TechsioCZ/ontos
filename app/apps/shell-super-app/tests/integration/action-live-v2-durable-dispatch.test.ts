/**
 * Durable propose/execute dispatch of a forward (v2) Action over the native fixture: real sessions, the
 * real access gate and fences, the shipped approval stores and the registered owner Action (O75, O90).
 * The proposal, its append-only frozen command and the invocation's terminal `proposed` receipt commit
 * together or not at all; a replay answers the same receipt, never a second proposal; a mandate runs only
 * for its approver and its frozen command.
 */
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { NativeHumanSessionsFactory, makeNativeActionV2Fixture } from '@app/core-runtime/testing/native-action-v2';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { Effect, Layer, Option, Result, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { makeNativeHumanSessionProvider } from '../support/native-human-sessions.ts';

type Fixture = Effect.Success<typeof makeNativeActionV2Fixture>;

const services = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  Reactivity.layer,
  Layer.succeed(NativeHumanSessionsFactory, {
    make: (options) => makeNativeHumanSessionProvider(options, new URL('../../drizzle-auth/', import.meta.url)),
  }),
);

const ProposalAccepted = Schema.is(ActionProposalAcceptedSchema);

const proposeRequest = Effect.fn('DurableV2.proposeRequest')(function* proposeRequest(
  fixture: Fixture,
  key: string,
  payload: typeof fixture.payload = fixture.payload,
) {
  return {
    payload,
    principal: yield* fixture.principalFor(fixture.requesterId),
    registration: fixture.action,
    successContract: 'result-or-proposal' as const,
    transport: { correlationId: key, idempotencyKey: key, intent: 'propose' as const },
  };
});

const propose = Effect.fn('DurableV2.propose')(function* propose(fixture: Fixture, key: string) {
  const accepted = yield* fixture.runtime.runAction(yield* proposeRequest(fixture, key));
  if (!ProposalAccepted(accepted)) {
    return yield* Effect.die('A forward proposal must answer its own 202, never a handler result');
  }
  return accepted;
});

const counts = Effect.fn('DurableV2.counts')(function* counts(fixture: Fixture) {
  const [row] = yield* fixture.admin.unsafe<{ readonly frozen: number; readonly proposals: number }>(
    `select (select count(*)::integer from core.access_proposals where tenant_id = $1) as proposals,
            (select count(*)::integer from core.access_frozen_commands where tenant_id = $1) as frozen`,
    [fixture.tenantId],
  );
  return row;
});

const invocationOf = Effect.fn('DurableV2.invocation')(function* invocation(fixture: Fixture, key: string) {
  const rows = yield* fixture.admin.unsafe<{
    readonly action_invocation_id: string;
    readonly completed_at: Date | null;
    readonly status: string;
  }>(
    `select action_invocation_id, status, completed_at from core.action_invocations
      where tenant_id = $1 and idempotency_key = $2`,
    [fixture.tenantId, key],
  );
  expect(rows).toHaveLength(1);
  const [row] = rows;
  return row ?? (yield* Effect.die('The invocation must exist'));
});

const receiptOf = Effect.fn('DurableV2.receipt')(function* receipt(fixture: Fixture, proposalId: string) {
  const [row] = yield* fixture.admin.unsafe<{
    readonly action_invocation_id: string | null;
    readonly execution_operation_id: string | null;
    readonly status: string;
  }>('select status, action_invocation_id, execution_operation_id from core.access_proposals where proposal_id = $1', [
    proposalId,
  ]);
  return row;
});

const approve = Effect.fn('DurableV2.approve')(function* approve(fixture: Fixture, proposalId: string) {
  return yield* fixture.approvalsFor(fixture.approverScope).approve({
    approver: { _tag: 'Principal', principalId: fixture.approverId },
    approverKind: 'human',
    policy: { selfApproval: 'forbidden' },
    proposalId: Schema.decodeSync(ActionProposalAcceptedSchema.fields.proposalId)(proposalId),
    scopeId: fixture.companyScope,
    tenantId: fixture.tenantId,
  });
});

const mandateOf = Effect.fn('DurableV2.mandate')(function* mandate(fixture: Fixture, proposalId: string) {
  const [row] = yield* fixture.admin.unsafe<{ readonly mandate_id: string }>(
    'select mandate_id from core.access_mandates where tenant_id = $1 and proposal_id = $2',
    [fixture.tenantId, proposalId],
  );
  return row === undefined ? yield* Effect.die('The approval must have created the mandate') : row.mandate_id;
});

it.layer(services, { excludeTestServices: true, timeout: '180 seconds' })(
  'durable forward Action dispatch',
  (suite) => {
    suite.effect('commits the proposal, its frozen command and the proposed receipt together (O90.3)', () =>
      Effect.gen(function* parkedTogether() {
        const fixture = yield* makeNativeActionV2Fixture;
        const accepted = yield* propose(fixture, 'durable-park');
        const invocation = yield* invocationOf(fixture, 'durable-park');
        expect(invocation.status).toBe('proposed');
        expect(invocation.completed_at).toBeInstanceOf(Date);
        expect(yield* receiptOf(fixture, accepted.proposalId)).toEqual({
          action_invocation_id: invocation.action_invocation_id,
          execution_operation_id: null,
          status: 'pending',
        });
        expect(yield* counts(fixture)).toEqual({ frozen: 1, proposals: 1 });
        expect(fixture.executions.value).toBe(0);
        // The frozen command is append-only: neither changed nor removed, whatever the connection's grants.
        for (const statement of [
          "update core.access_frozen_commands set action_key = 'another.action' where tenant_id = $1",
          'delete from core.access_frozen_commands where tenant_id = $1',
        ]) {
          expect(Result.isFailure(yield* Effect.result(fixture.admin.unsafe(statement, [fixture.tenantId])))).toBe(
            true,
          );
        }
        expect(yield* counts(fixture)).toEqual({ frozen: 1, proposals: 1 });
      }),
    );

    suite.effect('rolls the proposal, its frozen command and the receipt back together, then retries (O90.5)', () =>
      Effect.gen(function* rolledBack() {
        const fixture = yield* makeNativeActionV2Fixture;
        // A commit-time failure after every park write: the deferred check fires when the receipt turns terminal.
        yield* fixture.admin.unsafe(`create function public.refuse_proposed_receipt() returns trigger language plpgsql
        as $$ begin raise exception 'owner transaction failed at commit'; end $$`);
        yield* fixture.admin.unsafe(`create constraint trigger refuse_proposed_receipt
        after update on core.action_invocations deferrable initially deferred for each row
        when (new.status = 'proposed') execute function public.refuse_proposed_receipt()`);
        const failed = yield* Effect.result(
          fixture.runtime.runAction(yield* proposeRequest(fixture, 'durable-rollback')),
        );
        expect(Result.isFailure(failed)).toBe(true);
        expect(yield* counts(fixture)).toEqual({ frozen: 0, proposals: 0 });
        expect((yield* invocationOf(fixture, 'durable-rollback')).status).not.toBe('proposed');

        // The same idempotency key may retry once the owner transaction can commit.
        yield* fixture.admin.unsafe('drop trigger refuse_proposed_receipt on core.action_invocations');
        const accepted = yield* propose(fixture, 'durable-rollback');
        expect((yield* invocationOf(fixture, 'durable-rollback')).status).toBe('proposed');
        expect((yield* receiptOf(fixture, accepted.proposalId))?.status).toBe('pending');
        expect(yield* counts(fixture)).toEqual({ frozen: 1, proposals: 1 });
      }),
    );

    suite.effect('answers a committed propose with its own receipt, never a second proposal (O90.4)', () =>
      Effect.gen(function* replayCommitted() {
        const fixture = yield* makeNativeActionV2Fixture;
        const first = yield* propose(fixture, 'durable-replay');
        const replay = yield* propose(fixture, 'durable-replay');
        expect(replay.proposalId).toBe(first.proposalId);
        expect(yield* counts(fixture)).toEqual({ frozen: 1, proposals: 1 });

        const invocation = yield* invocationOf(fixture, 'durable-replay');
        const parked = yield* fixture.dispatch.loadParkedProposal({
          actionInvocationId: invocation.action_invocation_id,
          scope: fixture.requesterScope,
        });
        expect(Option.getOrThrow(parked).proposalId).toBe(first.proposalId);
        // Another person never receives the requester's stored 202.
        expect(
          Option.isNone(
            yield* fixture.dispatch.loadParkedProposal({
              actionInvocationId: invocation.action_invocation_id,
              scope: fixture.approverScope,
            }),
          ),
        ).toBe(true);
      }),
    );

    suite.effect('refuses the same idempotency key for a different command (O90.4)', () =>
      Effect.gen(function* bindingMismatch() {
        const fixture = yield* makeNativeActionV2Fixture;
        yield* propose(fixture, 'durable-binding');
        const changed = yield* Effect.result(
          fixture.runtime.runAction(
            yield* proposeRequest(fixture, 'durable-binding', {
              ...fixture.payload,
              salary: fixture.payload.salary + 1,
            }),
          ),
        );
        expect(Result.isFailure(changed)).toBe(true);
        expect(yield* counts(fixture)).toEqual({ frozen: 1, proposals: 1 });
      }),
    );

    suite.effect('answers concurrent duplicate proposes with one proposal (O90.4)', () =>
      Effect.gen(function* racingProposes() {
        const fixture = yield* makeNativeActionV2Fixture;
        const outcomes = yield* Effect.all(
          [
            Effect.result(fixture.runtime.runAction(yield* proposeRequest(fixture, 'durable-race'))),
            Effect.result(fixture.runtime.runAction(yield* proposeRequest(fixture, 'durable-race'))),
          ],
          { concurrency: 2 },
        );
        const accepted = outcomes.flatMap((outcome) =>
          Result.isSuccess(outcome) && ProposalAccepted(outcome.success) ? [outcome.success.proposalId] : [],
        );
        expect(accepted.length).toBeGreaterThan(0);
        expect(new Set(accepted).size).toBe(1);
        expect(yield* counts(fixture)).toEqual({ frozen: 1, proposals: 1 });
        expect((yield* invocationOf(fixture, 'durable-race')).status).toBe('proposed');
        // A loser that was refused while the winner held the invocation replays the same receipt afterwards.
        expect((yield* propose(fixture, 'durable-race')).proposalId).toBe(accepted[0]);
      }),
    );

    suite.effect('never answers a stored 202 without the terminal receipt and its frozen command', () =>
      Effect.gen(function* incompleteReceipt() {
        const fixture = yield* makeNativeActionV2Fixture;
        yield* propose(fixture, 'durable-receipt');
        const invocation = yield* invocationOf(fixture, 'durable-receipt');
        const load = fixture.dispatch.loadParkedProposal({
          actionInvocationId: invocation.action_invocation_id,
          scope: fixture.requesterScope,
        });
        // A proposal bound to an invocation that never became terminal (the crash window) is no receipt.
        yield* fixture.admin.unsafe(
          "update core.action_invocations set status = 'received', completed_at = null where action_invocation_id = $1",
          [invocation.action_invocation_id],
        );
        expect(Option.isNone(yield* load)).toBe(true);
        // A terminal invocation whose frozen command is gone cannot certify a 202 either.
        yield* fixture.admin.unsafe(
          "update core.action_invocations set status = 'proposed', completed_at = now() where action_invocation_id = $1",
          [invocation.action_invocation_id],
        );
        expect(Option.isSome(yield* load)).toBe(true);
        // Recovery state only an operator could leave: the append-only guard is lifted to remove the command.
        yield* fixture.admin.unsafe('alter table core.access_frozen_commands disable trigger user');
        yield* fixture.admin.unsafe('delete from core.access_frozen_commands where tenant_id = $1', [fixture.tenantId]);
        yield* fixture.admin.unsafe('alter table core.access_frozen_commands enable trigger user');
        const orphaned = yield* Effect.result(load);
        expect(Result.isSuccess(orphaned) && Option.isSome(orphaned.success)).toBe(false);
      }),
    );

    suite.effect('runs a mandate only for its approver, without a request command, exactly once (O75)', () =>
      Effect.gen(function* mandateBindings() {
        const fixture = yield* makeNativeActionV2Fixture;
        const accepted = yield* propose(fixture, 'durable-mandate');
        yield* approve(fixture, accepted.proposalId);
        const mandateId = yield* mandateOf(fixture, accepted.proposalId);
        const execute = (principalId: string, key: string, payload: typeof fixture.payload | null = null) =>
          fixture.principalFor(principalId).pipe(
            Effect.flatMap((principal) =>
              fixture.runtime.runAction({
                payload,
                principal,
                registration: fixture.action,
                transport: { correlationId: key, idempotencyKey: key, mandateId },
              }),
            ),
          );
        // The requester is not the approver: the mandate is not theirs to run.
        expect(Result.isFailure(yield* Effect.result(execute(fixture.requesterId, 'durable-mandate-requester')))).toBe(
          true,
        );
        // A request-supplied command never replaces the frozen one.
        expect(
          Result.isFailure(
            yield* Effect.result(execute(fixture.approverId, 'durable-mandate-payload', fixture.payload)),
          ),
        ).toBe(true);
        expect(fixture.executions.value).toBe(0);
        expect((yield* receiptOf(fixture, accepted.proposalId))?.status).toBe('approved');

        expect(yield* execute(fixture.approverId, 'durable-mandate-run')).toBe(2);
        const executed = yield* receiptOf(fixture, accepted.proposalId);
        expect(executed?.status).toBe('executed');
        // The proposal keeps the invocation it was PROPOSED by; execution has its own receipt (O90).
        const proposedBy = (yield* invocationOf(fixture, 'durable-mandate')).action_invocation_id;
        expect(executed?.action_invocation_id).toBe(proposedBy);
        expect(executed?.execution_operation_id).toBeTruthy();
        expect(executed?.execution_operation_id).not.toBe(proposedBy);
        expect(Result.isFailure(yield* Effect.result(execute(fixture.approverId, 'durable-mandate-again')))).toBe(true);
        expect(fixture.executions.value).toBe(1);
      }),
    );
  },
);
