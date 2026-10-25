import { createHash } from 'node:crypto';

import { Context, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  agentProposalCommandActionKey,
  AgentProposalCommandPayloadSchema,
} from '../../src/auth/agent-proposal-command-contract.ts';
import {
  AgentProposalCommandPreparation,
  AgentProposalCommandPreparationLive,
} from '../../src/auth/agent-proposal-command-preparation.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { canonicalizeApplicationComposition } from '../../src/modules/application-composition.ts';
import { OntosModuleDeploymentContractSchema } from '../../src/modules/manifest.ts';
import { ActionAuthority } from '../../src/permissions/action-authority.ts';
import { ContextAccess } from '../../src/permissions/context-access.ts';
import {
  agentId,
  batchId,
  humanId,
  legalEntityId,
  nextInvocationId,
  proposalId,
  proposalRow,
  proposalSqlRow,
  scope,
  tenantId,
} from '../support/agent-proposal-command-fixture.ts';
import { makeTestDatabase } from '../support/database.ts';
import { makeOutboxWorkerComposition, outboxWorkerCompositionLayer } from '../support/outbox-worker-composition.ts';

const compositionFixture = () => {
  const base = makeOutboxWorkerComposition([{ appId: 'tasks', moduleId: 'work.tasks' }]);
  const release = base.modules.at(0);
  if (release === undefined) {
    throw new TypeError('Expected fixture release');
  }
  const codec = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
  const contract = Schema.decodeSync(codec)(release.contractDocument);
  const contractDocument = Schema.encodeSync(codec)(
    Schema.decodeSync(OntosModuleDeploymentContractSchema)({
      ...contract,
      manifest: {
        ...contract.manifest,
        publicSurface: {
          ...contract.manifest.publicSurface,
          actions: [
            {
              actionKey: 'work.tasks.update',
              auditProfile: 'standard',
              entrypoint: {
                access: 'write',
                authorization: { kind: 'action_execution', provisioning: 'explicit' },
                entrypointKey: 'work.tasks.update',
                moduleKey: 'work.tasks',
                role: 'action',
                scope: 'tenant',
              },
              idempotency: 'required',
              legalEntityScope: 'required',
              owningModuleId: 'work.tasks',
              schemaVersion: '1',
            },
          ],
          mcp: {
            approvals: true,
            description: { cs: 'Tasks', en: 'Tasks' },
            keywords: '',
            label: { cs: 'Tasks', en: 'Tasks' },
            toolCatalog: { path: '/.well-known/ontos-module-mcp-tools.json', sha256: 'a'.repeat(64), toolCount: 0 },
          },
        },
      },
    }),
  );
  const sha256 = createHash('sha256').update(contractDocument).digest('hex');
  const next = {
    ...base,
    modules: [
      {
        ...release,
        contract: { ...release.contract, sha256 },
        contractDocument,
        publicContract: { ...release.publicContract, sha256 },
      },
    ],
  };
  return {
    ...next,
    revision: createHash('sha256')
      .update(canonicalizeApplicationComposition({ ...next, revision: '0'.repeat(64) }))
      .digest('hex'),
  };
};
const composition = compositionFixture();
const claimPayload = { batchId, operation: 'claim-approval' as const, proposalId };
const preflightInput = (payload: Schema.Json = claimPayload) => ({
  actionInvocationId: nextInvocationId,
  actionKey: agentProposalCommandActionKey,
  correlationId: scope.correlationId,
  payload,
  principal: scope,
  scope,
});
const forbiddenContext = () => Effect.die('No people, tenant or resource permissions authorize lifecycle commands');

// Capture one real preparation service in the native test scope so prepare/consume share its one-shot state.
const makePreparation = Effect.fn('AgentProposalCommandPreparationTest.make')(function* makePreparation(
  database: (typeof CoreDatabase.Service)['executor'],
  contextAccess: typeof ContextAccess.Service,
  authority: typeof ActionAuthority.Service,
) {
  const services = yield* Layer.build(
    AgentProposalCommandPreparationLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(CoreDatabase, { executor: database }),
          outboxWorkerCompositionLayer(composition),
          Layer.succeed(ContextAccess, contextAccess),
          Layer.succeed(ActionAuthority, authority),
        ),
      ),
    ),
  );
  return Context.get(services, AgentProposalCommandPreparation);
});

for (const [people, identity, expected] of [
  ['allowed', 'denied', 'not_applicable'],
  ['denied', 'allowed', 'not_applicable'],
  ['denied', 'denied', 'denied'],
] as const) {
  it.effect(
    `withdrawal uses native manage_people=${people} or manage_identity=${identity}, never business execute`,
    () =>
      Effect.gen(function* administration() {
        let transactionOpen = false;
        const database = yield* makeTestDatabase((sql, params) => {
          if (sql === 'BEGIN') {
            transactionOpen = true;
          }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            transactionOpen = false;
          }
          if (sql.includes('current_setting')) {
            return Effect.succeed([{ legal_entity_id: legalEntityId, role: 'ontos_runtime', tenant_id: tenantId }]);
          }
          if (sql.includes('from "core"."principals"')) {
            const isAgent = params.includes(agentId);
            return Effect.succeed([
              {
                displayName: 'Actor',
                kind: isAgent ? 'agent' : 'human',
                principalId: isAgent ? agentId : humanId,
                status: isAgent ? 'disabled' : 'active',
              },
            ]);
          }
          // Lifecycle withdrawal remains possible after the business module has left the composition.
          return Effect.succeed(
            sql.includes('from "core"."agent_proposals"')
              ? [proposalSqlRow(proposalRow({ appId: 'removed', moduleKey: 'removed.module' }))]
              : [],
          );
        });
        yield* Effect.gen(function* preparedWithdrawal() {
          const preparation = yield* AgentProposalCommandPreparation;
          const payload = { batchId, note: 'Agent disabled', operation: 'withdraw-pending-of-agent' as const };
          const decision = yield* preparation.prepare(preflightInput(payload));
          expect(decision.outcome).toBe(expected);
          if (expected === 'not_applicable') {
            // NOT_APPLICABLE preserves the real Action's explicit execution gate; this is not a permission grant.
            const snapshot = yield* preparation.consume({
              actionInvocationId: nextInvocationId,
              compositionRevision: composition.revision,
              payload,
              scope,
            });
            expect(snapshot.proposer.status).toBe('disabled');
          }
        }).pipe(
          Effect.provideService(
            AgentProposalCommandPreparation,
            yield* makePreparation(
              database,
              {
                legalEntities: (input) => {
                  expect(transactionOpen).toBe(false);
                  expect(input).toEqual({
                    legalEntityIds: [legalEntityId],
                    permission: 'manage_people',
                    principalId: humanId,
                    tenantId,
                  });
                  return Effect.succeed([{ decision: people, key: legalEntityId }]);
                },
                modules: forbiddenContext,
                resources: forbiddenContext,
                tenants: (input) => {
                  expect(transactionOpen).toBe(false);
                  expect(input).toEqual({ permission: 'manage_identity', principalId: humanId, tenantIds: [tenantId] });
                  return Effect.succeed([{ decision: identity, key: tenantId }]);
                },
              },
              {
                checkActionAuthorities: forbiddenContext,
                checkActionProposalPermission: forbiddenContext,
              },
            ),
          ),
        );
      }),
  );
}

for (const propose of ['allowed', 'denied'] as const) {
  it.effect(`agent submission requires propose=${propose} independently of human execution`, () =>
    Effect.gen(function* submit() {
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
      let duplicateReads = 0;
      const database = yield* makeTestDatabase((sql, params) => {
        if (sql.includes('current_setting')) {
          return Effect.succeed([{ legal_entity_id: legalEntityId, role: 'ontos_runtime', tenant_id: tenantId }]);
        }
        if (sql.includes('from "core"."principals"')) {
          return Effect.succeed([{ displayName: 'Agent', kind: 'agent', principalId: agentId, status: 'active' }]);
        }
        if (sql.includes('from "core"."agent_proposals"')) {
          duplicateReads += 1;
          expect(params).toContain(tenantId);
          expect(params).toContain(legalEntityId);
          expect(params).toContain(agentId);
          expect(sql).toContain('bool_and(p.status');
        }
        expect(sql.startsWith('insert')).toBe(false);
        return Effect.succeed([]);
      });
      const result = yield* Effect.gen(function* prepareInsert() {
        const preparation = yield* AgentProposalCommandPreparation;
        return yield* preparation.prepare({ ...preflightInput(), payload, principal: agentScope, scope: agentScope });
      }).pipe(
        Effect.provideService(
          AgentProposalCommandPreparation,
          yield* makePreparation(
            database,
            {
              legalEntities: forbiddenContext,
              modules: (target) => {
                expect(target).toEqual({ legalEntityId, moduleIds: ['work.tasks'], principalId: agentId, tenantId });
                return Effect.succeed([{ decision: 'allowed', key: 'work.tasks' }]);
              },
              resources: forbiddenContext,
              tenants: forbiddenContext,
            },
            {
              checkActionAuthorities: (targets) => {
                expect(targets).toEqual([
                  { actionKey: 'work.tasks.update', legalEntityId, principalId: agentId, tenantId },
                ]);
                return Effect.succeed(targets.map((target) => ({ ...target, execute: 'denied', propose })));
              },
              checkActionProposalPermission: forbiddenContext,
            },
          ),
        ),
      );
      expect(result.outcome).toBe(propose === 'allowed' ? 'not_applicable' : 'denied');
      expect(duplicateReads).toBe(1);
    }),
  );
}

for (const [name, execute, moduleDecision, proposerPermission, expected] of [
  ['human execution authority', 'allowed', 'allowed', 'allowed', 'not_applicable'],
  ['agent proposal authority is not execution', 'denied', 'allowed', 'allowed', 'denied'],
  ['execution without module visibility', 'allowed', 'denied', 'allowed', 'denied'],
  ['revoked proposer authority', 'allowed', 'allowed', 'denied', 'denied'],
] as const) {
  it.effect(`native preparation enforces ${name}`, () =>
    Effect.gen(function* authorization() {
      let transactionOpen = false;
      const checks: string[] = [];
      const database = yield* makeTestDatabase((sql, params) => {
        if (sql === 'BEGIN') {
          transactionOpen = true;
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          transactionOpen = false;
        }
        if (sql.includes('current_setting')) {
          return Effect.succeed([{ legal_entity_id: legalEntityId, role: 'ontos_runtime', tenant_id: tenantId }]);
        }
        if (sql.includes('from "core"."principals"')) {
          expect(transactionOpen).toBe(true);
          expect(params).toContain(tenantId);
          expect(params).toContain(legalEntityId);
          const isAgent = params.includes(agentId);
          return Effect.succeed([
            {
              displayName: isAgent ? 'Agent' : 'Human',
              kind: isAgent ? 'agent' : 'human',
              principalId: isAgent ? agentId : humanId,
              status: 'active',
            },
          ]);
        }
        if (sql.includes('from "core"."agent_proposals"')) {
          expect(params).toEqual([tenantId, legalEntityId, batchId, 51]);
          return Effect.succeed([proposalSqlRow(proposalRow())]);
        }
        return Effect.succeed([]);
      });
      const program = Effect.gen(function* prepareAndConsume() {
        const preparation = yield* AgentProposalCommandPreparation;
        const result = yield* preparation.prepare(preflightInput());
        expect(result.outcome).toBe(expected);
        if (result.outcome === 'not_applicable') {
          const snapshot = yield* preparation.consume({
            actionInvocationId: nextInvocationId,
            compositionRevision: composition.revision,
            payload: claimPayload,
            scope,
          });
          expect(snapshot.rows.map((row) => row.proposalId)).toEqual([proposalId]);
          const reused = yield* preparation
            .consume({
              actionInvocationId: nextInvocationId,
              compositionRevision: composition.revision,
              payload: claimPayload,
              scope,
            })
            .pipe(Effect.flip);
          expect(reused.code).toBe('agent_proposal_unavailable');
        }
      });
      yield* program.pipe(
        Effect.provideService(
          AgentProposalCommandPreparation,
          yield* makePreparation(
            database,
            {
              legalEntities: forbiddenContext,
              modules: (target) => {
                expect(transactionOpen).toBe(false);
                expect(target).toEqual({
                  legalEntityId,
                  moduleIds: ['work.tasks'],
                  principalId: target.principalId,
                  tenantId,
                });
                expect([humanId, agentId]).toContain(target.principalId);
                return Effect.succeed([{ decision: moduleDecision, key: 'work.tasks' }]);
              },
              resources: forbiddenContext,
              tenants: forbiddenContext,
            },
            {
              checkActionAuthorities: (targets) => {
                expect(transactionOpen).toBe(false);
                checks.push(...targets.map((target) => target.principalId));
                for (const target of targets) {
                  expect(target.actionKey).toBe('work.tasks.update');
                  expect(target.legalEntityId).toBe(legalEntityId);
                  expect(target.tenantId).toBe(tenantId);
                }
                return Effect.succeed(targets.map((target) => ({ ...target, execute, propose: proposerPermission })));
              },
              checkActionProposalPermission: () => Effect.die('Use exact bulk Action authority'),
            },
          ),
        ),
      );
      const admittedChecks = execute === 'denied' ? [humanId] : [humanId, agentId];
      expect(checks).toEqual(moduleDecision === 'denied' ? [] : admittedChecks);
    }),
  );
}

for (const [name, patch] of [
  ['a spoofed stored module', { moduleKey: 'other.module' }],
  ['a spoofed deployment', { appId: 'other-app' }],
  ['an unpublished Action', { actionSlug: 'not-published' }],
] as const) {
  it.effect(`native preparation denies ${name} before graph lookup`, () =>
    Effect.gen(function* spoofedFacts() {
      const database = yield* makeTestDatabase((sql, params) => {
        if (sql.includes('current_setting')) {
          return Effect.succeed([{ legal_entity_id: legalEntityId, role: 'ontos_runtime', tenant_id: tenantId }]);
        }
        if (sql.includes('from "core"."principals"')) {
          const isAgent = params.includes(agentId);
          return Effect.succeed([
            {
              displayName: 'Actor',
              kind: isAgent ? 'agent' : 'human',
              principalId: isAgent ? agentId : humanId,
              status: 'active',
            },
          ]);
        }
        return Effect.succeed(
          sql.includes('from "core"."agent_proposals"') ? [proposalSqlRow(proposalRow(patch))] : [],
        );
      });
      const result = yield* Effect.gen(function* prepare() {
        return yield* (yield* AgentProposalCommandPreparation).prepare(preflightInput());
      }).pipe(
        Effect.provideService(
          AgentProposalCommandPreparation,
          yield* makePreparation(
            database,
            {
              legalEntities: forbiddenContext,
              modules: forbiddenContext,
              resources: forbiddenContext,
              tenants: forbiddenContext,
            },
            {
              checkActionAuthorities: forbiddenContext,
              checkActionProposalPermission: forbiddenContext,
            },
          ),
        ),
      );
      expect(result.outcome).toBe('denied');
    }),
  );
}

it.effect('requires the original admitted principal and rejects authority-shaped excess input before SQL', () =>
  Effect.gen(function* originalCarrier() {
    const database = yield* makeTestDatabase(() => Effect.die('Invalid carrier/input must not open SQL'));
    yield* Effect.gen(function* prepare() {
      const preparation = yield* AgentProposalCommandPreparation;
      const mismatch = yield* preparation.prepare({ ...preflightInput(), scope: { ...scope, principalId: agentId } });
      expect(mismatch.outcome).toBe('denied');
      const excess = yield* preparation.prepare(preflightInput({ ...claimPayload, tenantId })).pipe(Effect.flip);
      expect(excess.code).toBe('action_permission_check_failed');
      expect((yield* preparation.prepare({ ...preflightInput(), actionKey: 'other.action' })).outcome).toBe(
        'not_applicable',
      );
    }).pipe(
      Effect.provideService(
        AgentProposalCommandPreparation,
        yield* makePreparation(
          database,
          {
            legalEntities: forbiddenContext,
            modules: forbiddenContext,
            resources: forbiddenContext,
            tenants: forbiddenContext,
          },
          {
            checkActionAuthorities: forbiddenContext,
            checkActionProposalPermission: forbiddenContext,
          },
        ),
      ),
    );
  }),
);

for (const mismatch of ['payload', 'scope', 'composition'] as const) {
  it.effect(`one-shot preparation binds the exact ${mismatch}`, () =>
    Effect.gen(function* exactProof() {
      const database = yield* makeTestDatabase((sql, params) => {
        if (sql.includes('current_setting')) {
          return Effect.succeed([{ legal_entity_id: legalEntityId, role: 'ontos_runtime', tenant_id: tenantId }]);
        }
        if (sql.includes('from "core"."principals"')) {
          const isAgent = params.includes(agentId);
          return Effect.succeed([
            {
              displayName: 'Actor',
              kind: isAgent ? 'agent' : 'human',
              principalId: isAgent ? agentId : humanId,
              status: 'active',
            },
          ]);
        }
        return Effect.succeed(sql.includes('from "core"."agent_proposals"') ? [proposalSqlRow(proposalRow())] : []);
      });
      yield* Effect.gen(function* checkBinding() {
        const preparation = yield* AgentProposalCommandPreparation;
        yield* preparation.prepare(preflightInput());
        const payload = yield* Schema.decodeEffect(AgentProposalCommandPayloadSchema)(
          mismatch === 'payload' ? { ...claimPayload, operation: 'mark-rejected' } : claimPayload,
        );
        const failure = yield* preparation
          .consume({
            actionInvocationId: nextInvocationId,
            compositionRevision: mismatch === 'composition' ? 'a'.repeat(64) : composition.revision,
            payload,
            scope: mismatch === 'scope' ? { ...scope, authContextRef: 'a-different-admitted-request' } : scope,
          })
          .pipe(Effect.flip);
        expect(failure.code).toBe('agent_proposal_unavailable');
        const consumed = yield* preparation
          .consume({
            actionInvocationId: nextInvocationId,
            compositionRevision: composition.revision,
            payload: claimPayload,
            scope,
          })
          .pipe(Effect.flip);
        expect(consumed.code).toBe('agent_proposal_unavailable');
      }).pipe(
        Effect.provideService(
          AgentProposalCommandPreparation,
          yield* makePreparation(
            database,
            {
              legalEntities: forbiddenContext,
              modules: () => Effect.succeed([{ decision: 'allowed', key: 'work.tasks' }]),
              resources: forbiddenContext,
              tenants: forbiddenContext,
            },
            {
              checkActionAuthorities: (targets) =>
                Effect.succeed(targets.map((target) => ({ ...target, execute: 'allowed', propose: 'allowed' }))),
              checkActionProposalPermission: forbiddenContext,
            },
          ),
        ),
      );
    }),
  );
}
