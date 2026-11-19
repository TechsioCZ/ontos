import { ManageAgentEntityRequestSchema } from '@app/shared-contracts/agent-access';
import type { ManageAgentEntityRequest } from '@app/shared-contracts/agent-access';
import { AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { proposalSubcommandKey } from '../../api/agent-platform/proposal-store.ts';
import { ConnectionsUnavailable } from '../../api/oauth-connections-admin/connections-unavailable.ts';
import { ConnectionsForbidden } from '../../api/oauth-connections-admin/connections-forbidden.ts';
import { ConnectionsGone } from '../../api/oauth-connections-admin/connections-gone.ts';
import { ConnectionsInvalid } from '../../api/oauth-connections-admin/connections-invalid.ts';
import { accessAdminTemplateLayer, withAccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';
import { firstBatchId, makeAgentReplay, readTransport, transport } from '../support/agent-entities-replay.ts';

type Replay = Effect.Success<ReturnType<typeof makeAgentReplay>>;
const replayCase = <A, E>(options: Parameters<typeof makeAgentReplay>[1], run: (test: Replay) => Effect.Effect<A, E>) =>
  withAccessAdminCase((accessCase) =>
    Effect.scoped(
      Effect.gen(function* runReplayCase() {
        return yield* run(yield* makeAgentReplay(accessCase, options));
      }),
    ),
  );
const wireAgentId = '00000000-0000-4000-8000-000000000004';
const disableTemplate: ManageAgentEntityRequest = {
  expectedStatus: 'active',
  newStatus: 'disabled',
  operation: 'change-status',
  principalId: AgentPrincipalIdSchema.make(wireAgentId),
  reason: 'Ukončení provozu',
};
const archiveTemplate: ManageAgentEntityRequest = {
  expectedStatus: 'active',
  operation: 'delete',
  principalId: AgentPrincipalIdSchema.make(wireAgentId),
  reason: 'Ukončení provozu',
};
it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'agent cleanup replay on owned PostgreSQL and the real gate',
  (suite) => {
    suite.effect(
      'resumes a committed status change after projection interruption despite the changed current status',
      () =>
        replayCase({}, (test) =>
          Effect.gen(function* committedStatusRetry() {
            const { agentId, principal } = test;
            const external = test.cleanup;
            const disable = { ...disableTemplate, principalId: agentId };

            external.failStep = 'projection';
            const failure = yield* test.run(disable).pipe(Effect.flip);
            expect(failure).toBeInstanceOf(ConnectionsUnavailable);
            expect((yield* test.snapshot).status).toBe('disabled');
            const committedStatus = (yield* test.snapshot).committed;
            expect(committedStatus).toHaveLength(1);
            expect(committedStatus[0]).toMatchObject({
              correlationId: transport.correlationId,
              idempotencyKey: transport.idempotencyKey,
              principalId: principal.principalId,
            });
            expect(committedStatus[0]?.requestHash).toMatch(/^[a-f0-9]{64}$/u);
            expect(external.connections).toHaveLength(2);
            external.events = [];
            const result = yield* test.run(disable);
            expect(result.status).toBe('disabled');
            expect(result.revokedConnections).toBe(2);
            expect(external.events).toEqual([
              'administrator',
              'action',
              'projection',
              'connections',
              'connection-1',
              'connection-2',
              'proposals',
              'withdraw-action',
            ]);
            expect((yield* test.snapshot).proposals).toBe(0);
            expect(test.actions[0]?.principal).toBe(principal);
            expect(test.actions[1]?.principal).toBe(principal);
            expect(test.actions[1]?.transport).toBe(transport);
            expect(test.actions[0]?.payload).toEqual(test.actions[1]?.payload);
            expect((yield* test.snapshot).committed.map(({ actionKey }) => actionKey)).toEqual([
              'core.identity.manage-agent-status',
              'core.identity.mutate-agent-proposals',
            ]);
            expect(
              (yield* test.snapshot).committed.filter(
                ({ actionKey }) => actionKey === 'core.identity.manage-agent-status',
              ),
            ).toEqual(committedStatus);
            expect((yield* test.snapshot).statusWrites).toBe(1);
            expect((yield* test.snapshot).committed.length).toBe(2);
            for (const read of test.readInputs) {
              expect(read.principal).toBe(principal);
              expect(read.transport).toBe(readTransport);
            }
            expect(test.readInputs.map(({ input }) => input)).toEqual([
              { agentPrincipalId: agentId, mode: 'withdrawal-batches' },
              {
                idempotencyKey: proposalSubcommandKey(
                  transport.idempotencyKey,
                  'withdraw-pending-of-agent',
                  firstBatchId,
                ),
                mode: 'command-recovery',
                payload: {
                  batchId: firstBatchId,
                  note: `Agent byl deaktivován: ${disable.reason}`,
                  operation: 'withdraw-pending-of-agent',
                },
              },
            ]);
            expect(test.proposalActions[0]?.principal).toBe(principal);
            expect(test.proposalActions[0]?.payload).toEqual({
              batchId: firstBatchId,
              note: `Agent byl deaktivován: ${disable.reason}`,
              operation: 'withdraw-pending-of-agent',
            });
            expect(test.proposalActions[0]?.transport).toEqual({
              correlationId: transport.correlationId,
              idempotencyKey: proposalSubcommandKey(
                transport.idempotencyKey,
                'withdraw-pending-of-agent',
                firstBatchId,
              ),
            });
            expect((yield* test.snapshot).readEvidence).toBe(2);
          }),
        ),
      300_000,
    );

    suite.effect(
      'resumes archive cleanup after the target disappears without reading hidden archived profiles',
      () =>
        replayCase({}, (test) =>
          Effect.gen(function* committedArchiveRetry() {
            const { agentId } = test;
            const external = test.cleanup;

            const archive = { ...archiveTemplate, principalId: agentId };
            external.failStep = 'confirm-archived';
            expect(yield* test.run(archive).pipe(Effect.flip)).toBeInstanceOf(ConnectionsUnavailable);
            expect((yield* test.snapshot).status).toBe('archived');
            expect(external.events).toEqual([
              'administrator',
              'action',
              'projection',
              'connections',
              'connection-1',
              'connection-2',
              'proposals',
              'withdraw-action',
              'confirm-archived',
            ]);
            external.events = [];
            const result = yield* test.run(archive);
            expect(result.status).toBe('archived');
            expect(result.revokedConnections).toBe(0);
            expect(result.grantsRevoked).toBe(0);
            expect(external.events).toEqual([
              'administrator',
              'action',
              'projection',
              'connections',
              'proposals',
              'confirm-archived',
            ]);
            expect(test.actions[0]?.payload).toEqual(test.actions[1]?.payload);
            expect((yield* test.snapshot).committed).toHaveLength(2);
            expect(test.proposalActions).toHaveLength(1);
          }),
        ),
      300_000,
    );

    for (const requestTemplate of [disableTemplate, archiveTemplate]) {
      suite.effect(
        `rejects a changed ${requestTemplate.operation} payload under the committed original key before cleanup`,
        () =>
          replayCase({}, (test) =>
            Effect.gen(function* changedPayload() {
              const { agentId } = test;
              const external = test.cleanup;

              const request = { ...requestTemplate, principalId: agentId };
              external.failStep = 'projection';
              yield* test.run(request).pipe(Effect.flip);
              external.events = [];
              const changed: ManageAgentEntityRequest =
                request.operation === 'change-status'
                  ? { ...request, expectedStatus: 'disabled', newStatus: 'active' }
                  : { ...request, expectedStatus: 'disabled' };
              expect(yield* test.run(changed).pipe(Effect.flip)).toBeInstanceOf(ConnectionsGone);
              expect(yield* test.run({ ...request, reason: 'Jiný důvod' }).pipe(Effect.flip)).toBeInstanceOf(
                ConnectionsGone,
              );
              expect(external.events).toEqual(['administrator', 'action', 'administrator', 'action']);
              expect((yield* test.snapshot).committed).toHaveLength(1);
            }),
          ),
        300_000,
      );
    }

    suite.effect(
      'rechecks company administration before replaying a committed archive',
      () =>
        replayCase({}, (test) =>
          Effect.gen(function* deniedRetry() {
            const { agentId } = test;
            const external = test.cleanup;

            const archive = { ...archiveTemplate, principalId: agentId };
            external.failStep = 'projection';
            yield* test.run(archive).pipe(Effect.flip);
            yield* test.denyAdministration;
            external.events = [];
            expect(yield* test.run(archive).pipe(Effect.flip)).toBeInstanceOf(ConnectionsForbidden);
            expect(external.events).toEqual(['administrator', 'denied-audit']);
            expect(test.actions).toHaveLength(1);
          }),
        ),
      300_000,
    );

    suite.effect(
      'fails closed when denied-attempt auditing fails and performs no Action or cleanup',
      () =>
        replayCase({}, (test) =>
          Effect.gen(function* deniedAuditFailure() {
            const { agentId } = test;
            const external = test.cleanup;

            const archive = { ...archiveTemplate, principalId: agentId };
            yield* test.denyAdministration;
            external.failStep = 'denied-audit';
            expect(yield* test.run(archive).pipe(Effect.flip)).toBeInstanceOf(ConnectionsUnavailable);
            expect(external.events).toEqual(['administrator', 'denied-audit']);
            expect(test.actions).toHaveLength(0);
            expect((yield* test.snapshot).committed).toHaveLength(0);
            expect(external.connections).toEqual(['connection-1', 'connection-2']);
            expect((yield* test.snapshot).proposals).toBe(1);
            expect((yield* test.snapshot).status).toBe('active');
          }),
        ),
      300_000,
    );

    suite.effect(
      'does not turn native permission denial into successful cleanup',
      () =>
        replayCase({ actionPermission: 'denied' }, (test) =>
          Effect.gen(function* nativeDenial() {
            const { agentId } = test;
            const external = test.cleanup;

            const archive = { ...archiveTemplate, principalId: agentId };
            expect(yield* test.run(archive).pipe(Effect.flip)).toBeInstanceOf(ConnectionsForbidden);
            expect(external.events).toEqual(['administrator', 'action']);
            expect((yield* test.snapshot).committed).toHaveLength(0);
          }),
        ),
      300_000,
    );

    for (const options of [{ member: false }, { exists: false }]) {
      suite.effect(
        `leaves foreign/missing target validation to the real native handler (${Object.keys(options)[0]})`,
        () =>
          replayCase(options, (test) =>
            Effect.gen(function* invalidTarget() {
              const { agentId } = test;
              const external = test.cleanup;

              const archive = { ...archiveTemplate, principalId: agentId };
              expect(yield* test.run(archive).pipe(Effect.flip)).toBeInstanceOf(ConnectionsInvalid);
              expect(external.events).not.toContain('snapshot');
              expect(external.events).not.toContain('projection');
              expect(external.events).not.toContain('connections');
              expect((yield* test.snapshot).status).toBe('active');
              expect((yield* test.snapshot).committed).toHaveLength(0);
            }),
          ),
        300_000,
      );
    }

    suite.effect(
      'keeps native optimistic status conflict enforcement for a fresh request',
      () =>
        replayCase({}, (test) =>
          Effect.gen(function* optimisticConflict() {
            const { agentId } = test;
            const external = test.cleanup;
            const disable = { ...disableTemplate, principalId: agentId };

            yield* test.setStatus('disabled');
            expect(yield* test.run(disable).pipe(Effect.flip)).toBeInstanceOf(ConnectionsGone);
            expect(external.events).toEqual(['administrator', 'action']);
          }),
        ),
      300_000,
    );

    suite.effect(
      'finishes interrupted revocations before withdrawing proposals or confirming the archive',
      () =>
        replayCase({}, (test) =>
          Effect.gen(function* interruptedRevocation() {
            const { agentId } = test;
            const external = test.cleanup;

            const archive = { ...archiveTemplate, principalId: agentId };
            external.failStep = 'connection-2';
            yield* test.run(archive).pipe(Effect.flip);
            expect(external.connections).toEqual(['connection-2']);
            expect((yield* test.snapshot).proposals).toBe(1);
            external.events = [];
            yield* test.run(archive);
            expect(external.events).toEqual([
              'administrator',
              'action',
              'projection',
              'connections',
              'connection-2',
              'proposals',
              'withdraw-action',
              'confirm-archived',
            ]);
            expect((yield* test.snapshot).committed).toHaveLength(2);
          }),
        ),
      300_000,
    );

    for (const requestTemplate of [disableTemplate, archiveTemplate]) {
      suite.effect(
        `propagates native withdrawal Read failure and resumes ${requestTemplate.operation} cleanup on the same key`,
        () =>
          replayCase({}, (test) =>
            Effect.gen(function* withdrawalFailure() {
              const { agentId } = test;
              const external = test.cleanup;

              const request = { ...requestTemplate, principalId: agentId };
              external.failStep = 'proposals';
              expect(yield* test.run(request).pipe(Effect.flip)).toBeInstanceOf(ConnectionsUnavailable);
              expect((yield* test.snapshot).status).toBe(request.operation === 'delete' ? 'archived' : 'disabled');
              expect(external.connections).toEqual([]);
              expect((yield* test.snapshot).proposals).toBe(1);
              expect(external.events).not.toContain('confirm-archived');
              expect(test.proposalActions).toHaveLength(0);
              external.events = [];
              yield* test.run(request);
              expect(external.events.slice(0, 6)).toEqual([
                'administrator',
                'action',
                'projection',
                'connections',
                'proposals',
                'withdraw-action',
              ]);
              expect((yield* test.snapshot).proposals).toBe(0);
              expect((yield* test.snapshot).committed).toHaveLength(2);
              if (request.operation === 'delete') {
                expect(external.events.at(-1)).toBe('confirm-archived');
              }
            }),
          ),
        300_000,
      );
    }

    suite.effect(
      'withdraws every native-discovered batch across pages without fabricating targets or changing ingress identity',
      () =>
        replayCase({ batchCount: 40 }, (test) =>
          Effect.gen(function* completeWithdrawal() {
            const { agentId, principal } = test;
            const external = test.cleanup;

            const archive = { ...archiveTemplate, principalId: agentId };
            const batchIds = (yield* test.snapshot).rows.map(({ batchId }) => batchId);
            yield* test.run(archive);
            const recoveryInputs = batchIds.map((batchId) => ({
              idempotencyKey: proposalSubcommandKey(transport.idempotencyKey, 'withdraw-pending-of-agent', batchId),
              mode: 'command-recovery',
              payload: {
                batchId,
                note: `Agent byl smazán: ${archive.reason}`,
                operation: 'withdraw-pending-of-agent',
              },
            }));
            expect(test.readInputs.map(({ input }) => input)).toEqual([
              { agentPrincipalId: agentId, mode: 'withdrawal-batches' },
              ...recoveryInputs.slice(0, 31),
              { afterBatchId: batchIds[30], agentPrincipalId: agentId, mode: 'withdrawal-batches' },
              ...recoveryInputs.slice(31),
            ]);
            for (const read of test.readInputs) {
              expect(read.principal).toBe(principal);
              expect(read.transport).toBe(readTransport);
            }
            expect(test.proposalActions.map(({ payload }) => payload)).toEqual(
              batchIds.map((batchId) => ({
                batchId,
                note: `Agent byl smazán: ${archive.reason}`,
                operation: 'withdraw-pending-of-agent',
              })),
            );
            for (const [index, action] of test.proposalActions.entries()) {
              expect(action.principal).toBe(principal);
              const batchId = batchIds[index];
              if (batchId === undefined) {
                throw new TypeError('Native discovery returned an unexpected batch');
              }
              expect(action.transport).toEqual({
                correlationId: transport.correlationId,
                idempotencyKey: proposalSubcommandKey(transport.idempotencyKey, 'withdraw-pending-of-agent', batchId),
              });
            }
            expect(
              (yield* test.snapshot).rows.every(
                (row) => row.status === 'rejected' && row.decidedByPrincipalId === principal.principalId,
              ),
            ).toBe(true);
            expect((yield* test.snapshot).committed).toHaveLength(41);
            expect((yield* test.snapshot).readEvidence).toBe(42);
            expect(external.events.at(-1)).toBe('confirm-archived');
          }),
        ),
      300_000,
    );

    suite.effect(
      'keeps a native claimed sibling intact while withdrawing unclaimed proposals in its complete batch',
      () =>
        replayCase({ claimedSibling: true }, (test) =>
          Effect.gen(function* claimedSibling() {
            const { agentId } = test;

            const disable = { ...disableTemplate, principalId: agentId };

            const claimed = (yield* test.snapshot).rows.find((row) => row.decidedAt !== null);
            yield* test.run(disable);
            expect((yield* test.snapshot).rows.filter((row) => row.status === 'rejected')).toHaveLength(1);
            expect((yield* test.snapshot).rows.find((row) => row.proposalId === claimed?.proposalId)).toEqual(claimed);
            expect(test.proposalActions).toHaveLength(1);
            expect((yield* test.snapshot).committed).toHaveLength(2);
          }),
        ),
      300_000,
    );
  },
);

it('requires an explicit non-archived expected status in the actual delete wire contract', () => {
  const valid = Schema.is(ManageAgentEntityRequestSchema);
  expect(valid(archiveTemplate)).toBe(true);
  expect(valid({ ...archiveTemplate, expectedStatus: 'disabled' })).toBe(true);
  expect(valid({ operation: 'delete', principalId: AgentPrincipalIdSchema.make(wireAgentId), reason: 'Důvod' })).toBe(
    false,
  );
  expect(valid({ ...archiveTemplate, expectedStatus: 'archived' })).toBe(false);
  expect(valid({ ...archiveTemplate, expectedStatus: null })).toBe(false);
  expect(valid({ ...archiveTemplate, expectedStatus: 'inactive' })).toBe(false);
});
