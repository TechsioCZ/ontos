import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AgentProposalCommandError } from '../../src/auth/agent-proposal-command-error.ts';
import {
  loadProposalCommandSnapshot,
  loadProposalCommandRecovery,
  loadProposalCommandReservations,
  proposalCommandsFromTransaction,
  proposalSnapshotHash,
} from '../../src/auth/agent-proposal-command-persistence.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import {
  agentId,
  batchId,
  humanId,
  laterTime,
  legalEntityId,
  nextInvocationId,
  operationTime,
  otherHumanId,
  proposalId,
  proposalRow,
  proposalSqlRow,
  reservationAudit,
  reservationId,
  scope,
  tenantId,
} from '../support/agent-proposal-command-fixture.ts';
import { makeTestDatabase } from '../support/database.ts';

const claim = { batchId, operation: 'claim-approval' as const, proposalId };
const actorRows = (params: readonly unknown[], agentStatus = 'active') => {
  const isAgent = params.includes(agentId);
  return [
    {
      displayName: isAgent ? 'Agent' : 'Human',
      kind: isAgent ? 'agent' : 'human',
      principalId: isAgent ? agentId : humanId,
      status: isAgent ? agentStatus : 'active',
    },
  ];
};
const scopeRows = [{ legal_entity_id: legalEntityId, role: 'ontos_runtime', tenant_id: tenantId }];

for (const changed of ['tenantId', 'legalEntityId'] as const) {
  it.effect(`command recovery denies foreign ${changed} before reading native facts`, () =>
    Effect.gen(function* recoveryScope() {
      const database = yield* makeTestDatabase((sql) => {
        if (sql.includes('current_setting')) {
          return Effect.succeed(scopeRows);
        }
        expect(sql).not.toContain('from "core"."action_invocations"');
        return Effect.succeed([]);
      });
      const failure = yield* database
        .transaction((transaction) =>
          Effect.gen(function* recover() {
            const scoped = yield* installOperationalScope(transaction, scope);
            return yield* loadProposalCommandRecovery(
              scoped,
              { ...scope, [changed]: batchId },
              { idempotencyKey: 'original-claim', payload: claim },
            );
          }),
        )
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ code: 'agent_proposal_invalid' });
    }),
  );
}

it.effect('a foreign caller cannot resolve another person’s retained result with the same idempotency key', () =>
  Effect.gen(function* foreignCaller() {
    const database = yield* makeTestDatabase((sql, params) => {
      if (sql.includes('current_setting')) {
        return Effect.succeed(scopeRows);
      }
      if (sql.includes('from "core"."action_invocations"')) {
        expect(params).toContain(otherHumanId);
        expect(params).not.toContain(humanId);
        expect(params).toContain(tenantId);
        expect(params).toContain(legalEntityId);
        expect(params).toContain('original-claim');
      }
      return Effect.succeed([]);
    });
    const result = yield* database.transaction((transaction) =>
      Effect.gen(function* recover() {
        const scoped = yield* installOperationalScope(transaction, scope);
        return yield* loadProposalCommandRecovery(
          scoped,
          { ...scope, principalId: otherHumanId },
          { idempotencyKey: 'original-claim', payload: claim },
        );
      }),
    );
    expect(result).toEqual({ retryCommand: true, state: 'NOT_STARTED' });
  }),
);

for (const operation of ['claim-approval', 'claim-batch-revert'] as const) {
  it.effect(`projects the exact current ${operation} rather than a superseded same-caller claim`, () =>
    Effect.gen(function* currentReservation() {
      const database = yield* makeTestDatabase((sql, params) => {
        if (sql.includes('current_setting')) {
          return Effect.succeed(scopeRows);
        }
        if (sql.includes('from "core"."audit_events"')) {
          expect(params).toContain(operation);
          expect(params).toContain(batchId);
          expect(params).toContain(tenantId);
          expect(params).toContain(legalEntityId);
          return Effect.succeed([
            { evidence: { ...reservationAudit(operation), reservationId: nextInvocationId, revision: 9 } },
          ]);
        }
        if (sql.includes('from "core"."action_invocations"')) {
          for (const parameter of [
            tenantId,
            legalEntityId,
            humanId,
            nextInvocationId,
            'succeeded',
            'core.identity.mutate-agent-proposals',
          ]) {
            expect(params).toContain(parameter);
          }
          return Effect.succeed([{ invocationId: nextInvocationId }]);
        }
        return Effect.succeed([]);
      });
      const result = yield* database.transaction((transaction) =>
        Effect.gen(function* reservations() {
          const scoped = yield* installOperationalScope(transaction, scope);
          const row =
            operation === 'claim-approval'
              ? proposalRow({ decidedAt: operationTime, decidedByPrincipalId: humanId })
              : proposalRow({ batchRevertedAt: operationTime, batchRevertedByPrincipalId: humanId, status: 'applied' });
          return yield* loadProposalCommandReservations(scoped, scope, [row]);
        }),
      );
      expect(result).toEqual([{ operation, proposalIds: [proposalId], reservationId: nextInvocationId, revision: 9 }]);
    }),
  );
}

it.effect('locks the proposer, rereads the admitted snapshot and scopes every mutation predicate', () =>
  Effect.gen(function* claimSql() {
    const queries: string[] = [];
    const database = yield* makeTestDatabase((sql, params) => {
      queries.push(sql);
      if (sql.includes('current_setting')) {
        return Effect.succeed(scopeRows);
      }
      if (sql.includes('for update')) {
        expect(params).toEqual([tenantId, agentId, 1]);
        return Effect.succeed([{ principalId: agentId }]);
      }
      if (sql.includes('clock_timestamp()')) {
        return Effect.succeed([{ now: laterTime.toISOString() }]);
      }
      if (sql.includes('from "core"."principals"')) {
        return Effect.succeed(actorRows(params));
      }
      if (sql.includes('from "core"."agent_proposals"')) {
        return Effect.succeed([proposalSqlRow(proposalRow())]);
      }
      if (sql.startsWith('update "core"."agent_proposals"')) {
        expect(sql).toContain('"tenant_id"');
        expect(sql).toContain('"legal_entity_id"');
        expect(sql).toContain('"batch_id"');
        expect(sql).toContain('"agent_principal_id"');
        expect(params).toEqual([
          humanId,
          laterTime.toISOString(),
          tenantId,
          legalEntityId,
          batchId,
          agentId,
          proposalId,
        ]);
        return Effect.succeed([{ proposalId }]);
      }
      return Effect.succeed([]);
    });
    const result = yield* database.transaction((transaction) =>
      Effect.gen(function* mutate() {
        const scoped = yield* installOperationalScope(transaction, scope);
        const snapshot = yield* loadProposalCommandSnapshot(scoped, scope, claim);
        return yield* proposalCommandsFromTransaction(scoped).execute(claim, {
          actionInvocationId: nextInvocationId,
          scope,
          snapshot,
        });
      }),
    );
    expect(result).toEqual({
      affectedProposalIds: [proposalId],
      batchId,
      outcome: 'changed',
      proposalIds: [proposalId],
      reservationId: nextInvocationId,
      revision: 1,
    });
    const lockIndex = queries.findIndex((query) => query.includes('for update'));
    expect(lockIndex).toBeGreaterThan(0);
    expect(queries.slice(lockIndex + 1).some((query) => query.includes('from "core"."agent_proposals"'))).toBe(true);
  }),
);

for (const [name, patch] of [
  ['command facts', { commandJson: { title: 'Raced' } }],
  ['approval version', { decidedAt: operationTime, decidedByPrincipalId: humanId }],
  ['a sibling revert reservation', { batchRevertedAt: operationTime, batchRevertedByPrincipalId: humanId }],
] as const) {
  it.effect(`fails closed when ${name} change after preparation`, () =>
    Effect.gen(function* racedSnapshot() {
      let raced = false;
      let updates = 0;
      const database = yield* makeTestDatabase((sql, params) => {
        if (sql.includes('current_setting')) {
          return Effect.succeed(scopeRows);
        }
        if (sql.includes('for update')) {
          raced = true;
          return Effect.succeed([{ principalId: agentId }]);
        }
        if (sql.includes('from "core"."principals"')) {
          return Effect.succeed(actorRows(params));
        }
        if (sql.includes('from "core"."agent_proposals"')) {
          return Effect.succeed([proposalSqlRow(proposalRow(raced ? patch : {}))]);
        }
        if (sql.startsWith('update')) {
          updates += 1;
        }
        return Effect.succeed([]);
      });
      const failure = yield* database
        .transaction((transaction) =>
          Effect.gen(function* race() {
            const scoped = yield* installOperationalScope(transaction, scope);
            const snapshot = yield* loadProposalCommandSnapshot(scoped, scope, claim);
            return yield* proposalCommandsFromTransaction(scoped).execute(claim, {
              actionInvocationId: nextInvocationId,
              scope,
              snapshot,
            });
          }),
        )
        .pipe(Effect.flip);
      expect(Schema.is(AgentProposalCommandError)(failure)).toBe(true);
      expect(updates).toBe(0);
    }),
  );
}

it.effect('uses canonical successful native audit evidence for exact approval reservation completion', () =>
  Effect.gen(function* auditReservation() {
    const payload = {
      applyResult: { id: 'changed' },
      batchId,
      operation: 'mark-applied' as const,
      proposalId,
      reservationId,
    };
    let reservationQueries = 0;
    const database = yield* makeTestDatabase((sql, params) => {
      if (sql.includes('current_setting')) {
        return Effect.succeed(scopeRows);
      }
      if (sql.includes('for update')) {
        return Effect.succeed([{ principalId: agentId }]);
      }
      if (sql.includes('clock_timestamp()')) {
        return Effect.succeed([{ now: laterTime.toISOString() }]);
      }
      if (sql.includes('from "core"."principals"')) {
        return Effect.succeed(actorRows(params));
      }
      if (sql.includes('from "core"."agent_proposals"')) {
        return Effect.succeed([
          proposalSqlRow(proposalRow({ decidedAt: operationTime, decidedByPrincipalId: humanId })),
        ]);
      }
      if (sql.includes('from "core"."audit_events"')) {
        expect(params).toContain(tenantId);
        expect(params).toContain(legalEntityId);
        expect(params).toContain('core.identity.mutate-agent-proposals');
        expect(params).toContain(batchId);
        if (params.includes('claim-approval')) {
          reservationQueries += 1;
          expect(sql).toContain("->>'outcome' = 'changed'");
          expect(sql).toContain("->'affectedProposalIds' ?");
          expect(params).toContain(proposalId);
        }
        return Effect.succeed([
          {
            evidence: {
              ...reservationAudit(),
              actionKey: 'core.identity.mutate-agent-proposals',
              resultHash: 'canonical-result-hash',
            },
          },
        ]);
      }
      if (sql.startsWith('update')) {
        return Effect.succeed([{ proposalId }]);
      }
      return Effect.succeed([]);
    });
    const result = yield* database.transaction((transaction) =>
      Effect.gen(function* complete() {
        const scoped = yield* installOperationalScope(transaction, scope);
        const snapshot = yield* loadProposalCommandSnapshot(scoped, scope, payload);
        return yield* proposalCommandsFromTransaction(scoped).execute(payload, {
          actionInvocationId: nextInvocationId,
          scope,
          snapshot,
        });
      }),
    );
    expect(result.outcome).toBe('changed');
    expect(result.revision).toBe(2);
    expect(reservationQueries).toBe(1);
  }),
);

it.effect(
  'withdraws one bounded batch of a disabled historical proposer without granting people-management powers',
  () =>
    Effect.gen(function* withdraw() {
      const payload = { batchId, note: 'Agent disabled', operation: 'withdraw-pending-of-agent' as const };
      const database = yield* makeTestDatabase((sql, params) => {
        if (sql.includes('current_setting')) {
          return Effect.succeed(scopeRows);
        }
        if (sql.includes('for update')) {
          return Effect.succeed([{ principalId: agentId }]);
        }
        if (sql.includes('clock_timestamp()')) {
          return Effect.succeed([{ now: laterTime.toISOString() }]);
        }
        if (sql.includes('from "core"."principals"')) {
          if (params.includes(agentId)) {
            expect(sql).not.toContain('"principal_company_memberships"."status" =');
          }
          return Effect.succeed(actorRows(params, 'disabled'));
        }
        if (sql.includes('from "core"."agent_proposals"')) {
          expect(params).toEqual([tenantId, legalEntityId, batchId, 51]);
          return Effect.succeed([proposalSqlRow(proposalRow())]);
        }
        if (sql.startsWith('update')) {
          return Effect.succeed([{ proposalId }]);
        }
        return Effect.succeed([]);
      });
      const result = yield* database.transaction((transaction) =>
        Effect.gen(function* close() {
          const scoped = yield* installOperationalScope(transaction, scope);
          const snapshot = yield* loadProposalCommandSnapshot(scoped, scope, payload);
          return yield* proposalCommandsFromTransaction(scoped).execute(payload, {
            actionInvocationId: nextInvocationId,
            scope,
            snapshot,
          });
        }),
      );
      expect(result.affectedProposalIds).toEqual([proposalId]);
    }),
);

it.effect('deduplicates the complete ordered run and never replays a run with changed commands', () =>
  Effect.gen(function* runIdentity() {
    const row = proposalRow({ runId: 'run-one' });
    const agentScope = { ...scope, principalId: agentId };
    const payload = {
      batchId,
      instruction: 'Requested',
      operation: 'insert' as const,
      proposals: [
        {
          actionSlug: row.actionSlug,
          appId: row.appId,
          command: row.commandJson,
          diff: [],
          moduleKey: row.moduleKey,
          proposalId,
          reason: row.reason,
          risk: 'low' as const,
          summary: row.summary,
          targetLabel: row.targetLabel,
        },
      ],
      runId: 'run-one',
    };
    let inserts = 0;
    const database = yield* makeTestDatabase((sql, params) => {
      if (sql.includes('current_setting')) {
        return Effect.succeed(scopeRows);
      }
      if (sql.includes('for update')) {
        return Effect.succeed([{ principalId: agentId }]);
      }
      if (sql.includes('from "core"."principals"')) {
        return Effect.succeed(actorRows(params));
      }
      if (sql.includes('from "core"."agent_proposals"')) {
        const identity = params.includes('run-one') ? [agentId, 'run-one'] : [batchId];
        expect(params).toEqual([tenantId, legalEntityId, ...identity, 51]);
        return Effect.succeed([proposalSqlRow(row)]);
      }
      if (sql.startsWith('insert')) {
        inserts += 1;
      }
      return Effect.succeed([]);
    });
    yield* database.transaction((transaction) =>
      Effect.gen(function* replay() {
        const scoped = yield* installOperationalScope(transaction, agentScope);
        const snapshot = yield* loadProposalCommandSnapshot(scoped, agentScope, payload);
        const result = yield* proposalCommandsFromTransaction(scoped).execute(payload, {
          actionInvocationId: nextInvocationId,
          scope: agentScope,
          snapshot,
        });
        expect(result.outcome).toBe('replayed');
        const failure = yield* loadProposalCommandSnapshot(scoped, agentScope, {
          ...payload,
          proposals: payload.proposals.map((proposal) => ({ ...proposal, command: { title: 'Changed' } })),
        }).pipe(Effect.flip);
        expect(Schema.is(AgentProposalCommandError)(failure)).toBe(true);
      }),
    );
    expect(inserts).toBe(0);
  }),
);

it.effect('serializes batch identity across proposers and inserts only native scoped ownership', () =>
  Effect.gen(function* insert() {
    const agentScope = { ...scope, principalId: agentId };
    const payload = {
      batchId,
      instruction: 'Requested',
      operation: 'insert' as const,
      proposals: [
        {
          actionSlug: 'update',
          appId: 'tasks',
          command: { title: 'New' },
          diff: [],
          moduleKey: 'work.tasks',
          proposalId,
          reason: 'Requested',
          risk: 'low' as const,
          summary: 'Update',
          targetLabel: 'Task',
        },
      ],
    };
    const queryOrder: string[] = [];
    const database = yield* makeTestDatabase((sql, params) => {
      if (sql.includes('current_setting')) {
        return Effect.succeed(scopeRows);
      }
      if (sql.includes('for update')) {
        queryOrder.push('proposer-lock');
        return Effect.succeed([{ principalId: agentId }]);
      }
      if (sql.includes('pg_advisory_xact_lock')) {
        expect(sql).toContain('hashtextextended');
        expect(params).toContain(tenantId);
        expect(params).toContain(agentId);
        queryOrder.push('batch-lock');
        return Effect.succeed([{ lock: null }]);
      }
      if (sql.includes('from "core"."principals"')) {
        return Effect.succeed(actorRows(params));
      }
      if (sql.includes('from "core"."agent_proposals"')) {
        if (sql.includes('group by p.batch_id')) {
          expect(sql).toContain('having count(*)');
          expect(sql).toContain("bool_and(p.status = 'pending' and p.batch_reverted_at is null");
          expect(params).toContain('work.tasks');
          expect(params).toContain('tasks');
          expect(params).toContain('update');
          expect(params).toContain('{"title":"New"}');
        } else {
          expect(params).toEqual([tenantId, legalEntityId, batchId, 1]);
          queryOrder.push('batch-collision-check');
        }
      }
      if (sql.startsWith('insert "core"') || sql.startsWith('insert into "core"')) {
        expect(params).toContain(tenantId);
        expect(params).toContain(legalEntityId);
        expect(params).toContain(agentId);
        expect(params).not.toContain(humanId);
        expect(params).toContain(batchId);
        expect(params).toContain(proposalId);
        queryOrder.push('insert');
        return Effect.succeed([{ proposalId }]);
      }
      return Effect.succeed([]);
    });
    const result = yield* database.transaction((transaction) =>
      Effect.gen(function* persist() {
        const scoped = yield* installOperationalScope(transaction, agentScope);
        const snapshot = yield* loadProposalCommandSnapshot(scoped, agentScope, payload);
        return yield* proposalCommandsFromTransaction(scoped).execute(payload, {
          actionInvocationId: nextInvocationId,
          scope: agentScope,
          snapshot,
        });
      }),
    );
    expect(queryOrder).toEqual(['proposer-lock', 'batch-lock', 'batch-collision-check', 'insert']);
    expect(result).toEqual({
      affectedProposalIds: [proposalId],
      batchId,
      outcome: 'changed',
      proposalIds: [proposalId],
      revision: 1,
    });
  }),
);

it.effect('rejects a caller scope different from the installed Core transaction before reading owner rows', () =>
  Effect.gen(function* scopeMismatch() {
    const database = yield* makeTestDatabase((sql) => {
      if (sql.includes('current_setting')) {
        return Effect.succeed(scopeRows);
      }
      expect(sql).not.toContain('from "core"."agent_proposals"');
      expect(sql).not.toContain('from "core"."principals"');
      return Effect.succeed([]);
    });
    yield* database.transaction((transaction) =>
      Effect.gen(function* rejectMismatchedScope() {
        const scoped = yield* installOperationalScope(transaction, scope);
        const failure = yield* loadProposalCommandSnapshot(
          scoped,
          { ...scope, legalEntityId: '20000000-0000-4000-8000-000000000002' },
          claim,
        ).pipe(Effect.flip);
        expect(failure).toMatchObject({ code: 'agent_proposal_invalid' });
      }),
    );
  }),
);

it.effect('does not mistake a run-filtered subset for the complete stored batch', () =>
  Effect.gen(function* completeRun() {
    const row = proposalRow({ runId: 'run-one' });
    const agentScope = { ...scope, principalId: agentId };
    const payload = {
      batchId,
      instruction: 'Requested',
      operation: 'insert' as const,
      proposals: [
        {
          actionSlug: row.actionSlug,
          appId: row.appId,
          command: row.commandJson,
          diff: [],
          moduleKey: row.moduleKey,
          proposalId,
          reason: row.reason,
          risk: 'low' as const,
          summary: row.summary,
          targetLabel: row.targetLabel,
        },
      ],
      runId: 'run-one',
    };
    const database = yield* makeTestDatabase((sql, params) => {
      if (sql.includes('current_setting')) {
        return Effect.succeed(scopeRows);
      }
      if (sql.includes('from "core"."principals"')) {
        return Effect.succeed(actorRows(params));
      }
      if (sql.includes('from "core"."agent_proposals"')) {
        const rows = params.includes('run-one')
          ? [row]
          : [row, proposalRow({ position: 1, proposalId: '60000000-0000-4000-8000-000000000002' })];
        return Effect.succeed(rows.map(proposalSqlRow));
      }
      return Effect.succeed([]);
    });
    yield* database.transaction((transaction) =>
      Effect.gen(function* refusePartial() {
        const scoped = yield* installOperationalScope(transaction, agentScope);
        const failure = yield* loadProposalCommandSnapshot(scoped, agentScope, payload).pipe(Effect.flip);
        expect(failure.code).toBe('agent_proposal_conflict');
      }),
    );
  }),
);

it('snapshot revisions include persisted chronology and the latest native audit revision', () => {
  const actor = { displayName: 'Actor', kind: 'human', principalId: humanId, status: 'active' } as const;
  const proposer = { ...actor, kind: 'agent', principalId: agentId } as const;
  const snapshot = { actor, previous: null, proposer, rows: [proposalRow()] };
  expect(proposalSnapshotHash(snapshot)).not.toBe(
    proposalSnapshotHash({ ...snapshot, rows: [proposalRow({ decidedAt: operationTime })] }),
  );
  expect(proposalSnapshotHash(snapshot)).not.toBe(proposalSnapshotHash({ ...snapshot, previous: reservationAudit() }));
});
