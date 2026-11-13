import { sha256 as sha256Hash } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Hex } from 'effect/encoding';

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
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { canonicalizeApplicationComposition } from '../../src/modules/application-composition.ts';
import { OntosModuleDeploymentContractSchema } from '../../src/modules/manifest.ts';
import { ActionAuthority } from '../../src/permissions/action-authority.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import type { AccessDecisionService, GateInput } from '../../src/access/enforcement/contract.ts';
import { makeTestAccessDecision } from '../../src/access/enforcement/testing.ts';
import { testAccessSpecOf } from '../../src/testing/access-gate.ts';
import type { TestAccessOutcome } from '../../src/testing/access-gate.ts';
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

/** A protected Action of the fixture module, published at `/<appId>/actions/<slug>`. */
const taskAction = (slug: string) =>
  ({
    // A v2 protected Action: the capability lives in the declaration, never in a legacy
    // `action_execution` provisioning intent (O62).
    accessDeclaration: {
      key: `work.tasks.task.${slug}`,
      kind: 'action',
      modes: ['run'],
      placement: { group: 'tasks', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    actionKey: `work.tasks.${slug}`,
    auditProfile: 'standard',
    entrypoint: {
      access: 'write',
      authorization: { kind: 'protected' },
      entrypointKey: `work.tasks.${slug}`,
      moduleKey: 'work.tasks',
      role: 'action',
      scope: 'tenant',
    },
    idempotency: 'required',
    legalEntityScope: 'required',
    owningModuleId: 'work.tasks',
    schemaVersion: '1',
  }) as const;

// A session-setting role installs its scope and reads back the connected role in one statement.
const installAndReadScopeSql =
  "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id";
const compositionFixture = (
  slugs: readonly string[] = ['update'],
  /** `stale`: a contract from before the module published its command map. */
  commandActions: Readonly<Record<string, readonly string[]>> | 'stale' = {},
) => {
  const base = makeOutboxWorkerComposition([{ appId: 'tasks', moduleId: 'work.tasks' }]);
  const release = base.modules.at(0);
  if (release === undefined) {
    throw new TypeError('Expected fixture release');
  }
  const tasksMcp = {
    approvals: true,
    description: { cs: 'Tasks', en: 'Tasks' },
    keywords: '',
    label: { cs: 'Tasks', en: 'Tasks' },
    toolCatalog: { path: '/.well-known/ontos-module-mcp-tools.json', sha256: 'a'.repeat(64), toolCount: 0 },
  } as const;
  const mcp = commandActions === 'stale' ? tasksMcp : { ...tasksMcp, commandActions };
  const codec = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
  const contract = Schema.decodeSync(codec)(release.contractDocument);
  const contractDocument = Schema.encodeSync(codec)(
    Schema.decodeSync(OntosModuleDeploymentContractSchema)({
      ...contract,
      manifest: {
        ...contract.manifest,
        publicSurface: {
          ...contract.manifest.publicSurface,
          actions: slugs.map(taskAction),
          mcp,
        },
      },
    }),
  );
  const sha256 = Hex.encode(sha256Hash(utf8ToBytes(contractDocument)));
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
    revision: Hex.encode(
      sha256Hash(utf8ToBytes(canonicalizeApplicationComposition({ ...next, revision: '0'.repeat(64) }))),
    ),
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
/** A gate no lifecycle-free command may ask: only withdrawal asks the agent administration right. */
const unaskedGate: AccessDecisionService = {
  ...makeTestAccessDecision(),
  decide: () => Effect.die('Only an agent withdrawal asks the gate here'),
};
/** The gate answering `core.identity.agent-status.manage`, and recording what it was asked. */
const agentStatusGate = (
  outcome: TestAccessOutcome,
  asked: GateInput[],
  transactionOpen: () => boolean,
): AccessDecisionService => {
  const scripted = makeTestAccessDecision(testAccessSpecOf({ 'core.identity.agent-status.manage': outcome }));
  return {
    ...scripted,
    decide: (input: GateInput) => {
      // The authority is asked outside any SQL transaction, as every remote question is.
      expect(transactionOpen()).toBe(false);
      asked.push(input);
      return scripted.decide(input);
    },
  };
};

// Capture one real preparation service in the native test scope so prepare/consume share its one-shot state.
const makePreparation = Effect.fn('AgentProposalCommandPreparationTest.make')(function* makePreparation(
  database: (typeof CoreDatabase.Service)['executor'],
  gate: AccessDecisionService,
  authority: typeof ActionAuthority.Service,
  fixture: typeof composition = composition,
) {
  const services = yield* Layer.build(
    AgentProposalCommandPreparationLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(CoreDatabase, { executor: database }),
          Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
          outboxWorkerCompositionLayer(fixture),
          Layer.succeed(AccessDecisionGate, gate),
          Layer.succeed(ActionAuthority, authority),
        ),
      ),
    ),
  );
  return Context.get(services, AgentProposalCommandPreparation);
});

for (const [outcome, expected] of [
  ['allowed', 'not_applicable'],
  ['denied', 'denied'],
] as const) {
  it.effect(`withdrawal is decided by the agent administration right (${outcome}), never by business execute`, () =>
    Effect.gen(function* administration() {
      const asked: GateInput[] = [];
      let transactionOpen = false;
      const database = yield* makeTestDatabase((sql, params) => {
        if (sql === 'BEGIN') {
          transactionOpen = true;
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          transactionOpen = false;
        }
        if (sql === installAndReadScopeSql) {
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
            agentStatusGate(outcome, asked, () => transactionOpen),
            {
              checkActionAuthorities: forbiddenContext,
              checkActionProposalPermission: forbiddenContext,
            },
          ),
        ),
      );
      // The one question is the agent-status right, in the request's own company.
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({
        carrier: { accessDeclaration: { key: 'core.identity.agent-status.manage' } },
        legalEntityScope: 'required',
        scope: { legalEntityId, principalId: humanId, tenantId },
      });
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
        if (sql === installAndReadScopeSql) {
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
          yield* makePreparation(database, unaskedGate, {
            // One gate question over the acting request's own trusted scope (O66): the Action key is
            // the only scalar the caller names, and `insert` reads the Action's own propose answer.
            checkActionAuthorities: (query) => {
              expect(query.actionKeys).toEqual(['work.tasks.update']);
              expect(query.scope.legalEntityId).toBe(legalEntityId);
              expect(query.scope.principalId).toBe(agentId);
              expect(query.scope.tenantId).toBe(tenantId);
              return Effect.succeed(
                query.actionKeys.map((actionKey) => ({ actionKey, execute: 'denied' as const, propose })),
              );
            },
            checkActionProposalPermission: forbiddenContext,
          }),
        ),
      );
      expect(result.outcome).toBe(propose === 'allowed' ? 'not_applicable' : 'denied');
      expect(duplicateReads).toBe(1);
    }),
  );
}

// `apply-command` keeps creation only; renaming moved to its own command-union Action `manage`, and decisions on the
// module's own AI changes to `review`.
const splitComposition = compositionFixture(['apply-command', 'manage', 'review', 'update'], {
  AiDecideChanges: ['review'],
  CreateTask: ['apply-command'],
  RenameTask: ['manage'],
});
const decision = { _tag: 'AiDecideChanges', changeIds: ['c-1'], decision: 'approve' };
for (const [name, actionSlug, command, expectedActions, fixture] of [
  [
    'a split command on the Action that owns it',
    'manage',
    { _tag: 'RenameTask', title: 'New' },
    ['work.tasks.manage'],
    'published',
  ],
  [
    'a command of an unsplit apply-command',
    'apply-command',
    { _tag: 'CreateTask', title: 'New' },
    ['work.tasks.apply-command'],
    'published',
  ],
  ['a named Action payload', 'update', { title: 'New' }, ['work.tasks.update'], 'published'],
  [
    'a split command addressed to apply-command',
    'apply-command',
    { _tag: 'RenameTask', title: 'New' },
    [],
    'published',
  ],
  ['a command its named Action does not own', 'manage', { _tag: 'CreateTask', title: 'New' }, [], 'published'],
  ['a tagged command on a named Action', 'update', { _tag: 'RenameTask', title: 'New' }, [], 'published'],
  [
    'a self-wrapped human-only decision on its Action',
    'review',
    { command: decision, expectedRevision: 3 },
    [],
    'published',
  ],
  ['a self-wrapped human-only decision on a named Action', 'update', { command: decision }, [], 'published'],
  [
    'a self-wrapped ordinary command',
    'apply-command',
    { command: { _tag: 'CreateTask' }, expectedRevision: 1 },
    [],
    'published',
  ],
  ['any payload of a module whose contract has no command map', 'update', { title: 'New' }, [], 'stale'],
] as const) {
  it.effect(`agent submission of ${name} asks only the owning Action`, () =>
    Effect.gen(function* splitSubmit() {
      const agentScope = { ...scope, principalId: agentId };
      const payload = {
        batchId,
        instruction: 'Requested',
        operation: 'insert' as const,
        proposals: [
          {
            actionSlug,
            appId: 'tasks',
            command,
            diff: [],
            moduleKey: 'work.tasks',
            proposalId,
            reason: 'Requested',
            risk: 'low' as const,
            summary: 'Change',
            targetLabel: 'Task',
          },
        ],
      };
      const database = yield* makeTestDatabase((sql) => {
        if (sql === installAndReadScopeSql) {
          return Effect.succeed([{ legal_entity_id: legalEntityId, role: 'ontos_runtime', tenant_id: tenantId }]);
        }
        if (sql.includes('from "core"."principals"')) {
          return Effect.succeed([{ displayName: 'Agent', kind: 'agent', principalId: agentId, status: 'active' }]);
        }
        expect(sql.startsWith('insert')).toBe(false);
        return Effect.succeed([]);
      });
      const asked: string[][] = [];
      const result = yield* Effect.gen(function* prepareInsert() {
        const preparation = yield* AgentProposalCommandPreparation;
        return yield* preparation.prepare({ ...preflightInput(), payload, principal: agentScope, scope: agentScope });
      }).pipe(
        Effect.provideService(
          AgentProposalCommandPreparation,
          yield* makePreparation(
            database,
            unaskedGate,
            {
              checkActionAuthorities: (query) => {
                asked.push([...query.actionKeys]);
                return Effect.succeed(
                  query.actionKeys.map((actionKey) => ({
                    actionKey,
                    execute: 'denied' as const,
                    propose: 'allowed' as const,
                  })),
                );
              },
              checkActionProposalPermission: forbiddenContext,
            },
            fixture === 'published' ? splitComposition : compositionFixture(['update'], fixture),
          ),
        ),
      );
      expect(result.outcome).toBe(expectedActions.length === 0 ? 'denied' : 'not_applicable');
      expect(asked).toEqual(expectedActions.length === 0 ? [] : [expectedActions]);
    }),
  );
}

it.effect(
  'a tenant owner proposes through an approval connection on the Action answer, not a legacy module tuple',
  () =>
    Effect.gen(function* ownerApprovalInsert() {
      const grantId = '80000000-0000-4000-8000-000000000001';
      // The stage owner of a one-module tenant exists only in the v2 model: it holds role cells and memberships,
      // never the retired `module_access` relation, so that relation denies.
      const ownerScope = {
        ...(yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
          authBindingId: '40000000-0000-4000-8000-000000000002',
          authContextRef: `oauth-grant:${grantId}`,
          authMethod: 'oauth_connection',
          connection: {
            clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
            clientName: 'Claude Code',
            grantId,
            modules: [{ access: 'write', moduleId: 'work.tasks' }],
            writePolicy: 'approval',
          },
          legalEntityId,
          principalId: humanId,
          tenantId,
        })),
        correlationId: 'owner-approval-insert',
      };
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
      const database = yield* makeTestDatabase((sql) => {
        if (sql === installAndReadScopeSql) {
          return Effect.succeed([{ legal_entity_id: legalEntityId, role: 'ontos_runtime', tenant_id: tenantId }]);
        }
        if (sql.includes('from "core"."principals"')) {
          return Effect.succeed([{ displayName: 'Owner', kind: 'human', principalId: humanId, status: 'active' }]);
        }
        expect(sql.startsWith('insert')).toBe(false);
        return Effect.succeed([]);
      });
      const result = yield* Effect.gen(function* prepareInsert() {
        const preparation = yield* AgentProposalCommandPreparation;
        return yield* preparation.prepare({ ...preflightInput(), payload, principal: ownerScope, scope: ownerScope });
      }).pipe(
        Effect.provideService(
          AgentProposalCommandPreparation,
          yield* makePreparation(database, unaskedGate, {
            checkActionAuthorities: (query) => {
              expect(query.scope).toBe(ownerScope);
              return Effect.succeed(
                query.actionKeys.map((actionKey) => ({
                  actionKey,
                  execute: 'allowed' as const,
                  propose: 'allowed' as const,
                })),
              );
            },
            checkActionProposalPermission: forbiddenContext,
          }),
        ),
      );
      expect(result.outcome).toBe('not_applicable');
    }),
);

for (const [name, execute, proposerPermission, expected] of [
  ['human execution authority', 'allowed', 'allowed', 'not_applicable'],
  ['agent proposal authority is not execution', 'denied', 'allowed', 'denied'],
  ['revoked proposer authority', 'allowed', 'denied', 'denied'],
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
        if (sql === installAndReadScopeSql) {
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
            // The Action's own answer is its module's; no legacy relation is asked at all.
            unaskedGate,
            {
              // The actor and, for a claim, the proposer each ask in their own scope; one call per
              // identity is what the runner proves happened, and the transaction is already closed.
              checkActionAuthorities: (query) => {
                expect(transactionOpen).toBe(false);
                checks.push(query.scope.principalId);
                expect(query.actionKeys).toEqual(['work.tasks.update']);
                expect(query.scope.legalEntityId).toBe(legalEntityId);
                expect(query.scope.tenantId).toBe(tenantId);
                return Effect.succeed(
                  query.actionKeys.map((actionKey) => ({ actionKey, execute, propose: proposerPermission })),
                );
              },
              checkActionProposalPermission: () => Effect.die('Use exact bulk Action authority'),
            },
          ),
        ),
      );
      const admittedChecks = execute === 'denied' ? [humanId] : [humanId, agentId];
      expect(checks).toEqual(admittedChecks);
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
        if (sql === installAndReadScopeSql) {
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
          yield* makePreparation(database, unaskedGate, {
            checkActionAuthorities: forbiddenContext,
            checkActionProposalPermission: forbiddenContext,
          }),
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
        yield* makePreparation(database, unaskedGate, {
          checkActionAuthorities: forbiddenContext,
          checkActionProposalPermission: forbiddenContext,
        }),
      ),
    );
  }),
);

for (const mismatch of ['payload', 'scope', 'composition'] as const) {
  it.effect(`one-shot preparation binds the exact ${mismatch}`, () =>
    Effect.gen(function* exactProof() {
      const database = yield* makeTestDatabase((sql, params) => {
        if (sql === installAndReadScopeSql) {
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
          yield* makePreparation(database, unaskedGate, {
            checkActionAuthorities: (query) =>
              Effect.succeed(
                query.actionKeys.map((actionKey) => ({
                  actionKey,
                  execute: 'allowed' as const,
                  propose: 'allowed' as const,
                })),
              ),
            checkActionProposalPermission: forbiddenContext,
          }),
        ),
      );
    }),
  );
}
