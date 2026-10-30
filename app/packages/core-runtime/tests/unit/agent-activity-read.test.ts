import { NodeCrypto } from '@effect/platform-node';
import { sha256 as sha256Hash } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Hex } from 'effect/encoding';

import { Context, DateTime, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { agentActivityActorsRead } from '../../src/auth/agent-activity-actors-read.ts';
import {
  AgentActivityInputSchema,
  AgentActivityProposalSchema,
  AgentActivityRequestSchema,
  AgentActivityResultSchema,
} from '../../src/auth/agent-activity-contract.ts';
import { activityFromTransaction } from '../../src/auth/agent-activity-persistence.ts';
import { agentActivityRead } from '../../src/auth/agent-activity-read.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import { canonicalizeApplicationComposition } from '../../src/modules/application-composition.ts';
import { OntosModuleDeploymentContractSchema } from '../../src/modules/manifest.ts';
import { ActionAuthority } from '../../src/permissions/action-authority.ts';
import { ContextAccess } from '../../src/permissions/context-access.ts';
import type { ActionPermissionDecision } from '../../src/permissions/service.ts';
import { getReadPermissionTargetResolver } from '../../src/reads/definition.ts';
import { ReadInputValidationError, ReadPermissionDenied } from '../../src/reads/errors.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { makeTestDatabase } from '../support/database.ts';
import { makeOutboxWorkerComposition, outboxWorkerCompositionLayer } from '../support/outbox-worker-composition.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const agentId = '30000000-0000-4000-8000-000000000002';
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:agent-activity-read',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  }),
  correlationId: 'activity-original-request',
};
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-25T12:00:00.000Z'));
const transport = { correlationId: scope.correlationId };

it('keeps activity authorization separate from read_people and manage_people', () => {
  for (const resolver of [
    getReadPermissionTargetResolver(agentActivityRead),
    getReadPermissionTargetResolver(agentActivityActorsRead),
  ]) {
    if (!Predicate.isFunction(resolver)) {
      throw new TypeError('Expected selected-company permission');
    }
    expect(resolver({ request: {}, visibleModules: [] }, scope)).toEqual({ kind: 'legal_entity' });
  }
  for (const registration of [agentActivityRead, agentActivityActorsRead]) {
    expect(registration.descriptor.entrypoint.authorization).toEqual({ kind: 'authenticated_principal' });
    expect(registration.descriptor.legalEntityScope).toBe('required');
    expect(registration.descriptor.evidencePolicy.captureMode).toBe('metadata_only');
  }
  expect(Object.keys(AgentActivityInputSchema.fields)).toEqual(['request', 'visibleModules']);
});

it('rejects noncanonical cursors, invalid agent IDs, oversized module lists and caller-selected authority', () => {
  const decode = Schema.decodeUnknownOption(AgentActivityInputSchema, { onExcessProperty: 'error' });
  expect(Option.isSome(decode({ request: {}, visibleModules: ['work.tasks'] }))).toBe(true);
  expect(Option.isNone(decode({ request: { agentPrincipalId: 'other' }, visibleModules: [] }))).toBe(true);
  expect(Option.isNone(decode({ request: { cursor: { at: '2026-10-25', id: 'audit:x' } }, visibleModules: [] }))).toBe(
    true,
  );
  expect(Option.isNone(decode({ request: {}, visibleModules: Array.from({ length: 1001 }, () => 'work.tasks') }))).toBe(
    true,
  );
  expect(Option.isNone(decode({ request: {}, tenantId, visibleModules: [] }))).toBe(true);
  expect(Option.isNone(decode({ proposalOnlyAgentIds: [agentId], request: {}, visibleModules: [] }))).toBe(true);
  expect(Option.isNone(decode({ nativeModules: ['work.tasks'], request: {}, visibleModules: [] }))).toBe(true);
});

it('decodes persisted absence to Options and preserves null round trips for the Shell mapper', () => {
  const row = {
    actionSlug: 'apply-command',
    agentLabel: 'Agent',
    agentPrincipalId: agentId,
    appId: 'tasks',
    appliedAt: null,
    applyResult: null,
    batchId: '50000000-0000-4000-8000-000000000001',
    batchInstruction: 'Update tasks',
    batchRevertedAt: null,
    batchRevertedByPrincipalId: null,
    batchRevertNote: null,
    command: { _tag: 'UpdateTask', title: 'New' },
    createdAt: operationTime,
    decidedAt: null,
    decidedByPrincipalId: null,
    decisionNote: null,
    diff: [{ after: 'New', before: 'Old', field: 'title', label: 'Title' }],
    failure: null,
    legalEntityId,
    moduleKey: 'work.tasks',
    position: 0,
    proposalId: '60000000-0000-4000-8000-000000000001',
    reason: 'Requested',
    referenceAudiences: [],
    revert: null,
    revertedAt: null,
    revertedByPrincipalId: null,
    risk: 'low',
    runId: 'run-original',
    status: 'pending',
    summary: 'Update',
    targetLabel: 'Task',
    tenantId,
  };
  const decoded = Schema.decodeUnknownSync(AgentActivityProposalSchema)(row);
  expect(Option.isNone(decoded.appliedAt)).toBe(true);
  expect(Option.isNone(decoded.decidedAt)).toBe(true);
  expect(Option.isNone(decoded.revert)).toBe(true);
  expect(Option.getOrNull(decoded.runId)).toBe('run-original');
  expect(Schema.encodeSync(AgentActivityProposalSchema)(decoded)).toEqual(row);
  expect(Object.keys(AgentActivityResultSchema.fields)).toEqual([
    'access',
    'audit',
    'names',
    'proposalOnlyAgentIds',
    'proposals',
  ]);
});

it.layer(NodeCrypto.layer)('Actor read lifecycle', (suite) => {
  suite.effect('denies the actor read before owner SQL and commits denied evidence', () =>
    Effect.gen(function* deniedActors() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.die('Denied reads must not query actor rows'),
        operationTime,
        permissionDecision: 'allowed',
        scope,
      });
      const failure = yield* harness.runtime
        .runRead({ input: {}, principal: scope, registration: agentActivityActorsRead, transport })
        .pipe(Effect.flip);
      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
      expect(harness.snapshot().ownerQueries).toEqual([]);
      expect(harness.snapshot().evidenceWrites).toBe(1);
    }),
  );

  suite.effect('uses the real scoped actor factory and releases only labels/IDs after allowed evidence', () =>
    Effect.gen(function* actorLifecycle() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: (query) => {
          expect(query.scope).toEqual({ legalEntityId, tenantId });
          expect(query.params).toEqual([tenantId]);
          expect(query.sql).toContain('"core"."principals"');
          return Effect.succeed([
            { displayName: 'Agent', kind: 'agent', principalId: agentId },
            { displayName: 'Approver', kind: 'human', principalId },
          ]);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const result = yield* harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: agentActivityActorsRead,
        transport,
      });
      expect(result.agentIds).toEqual([agentId]);
      expect(result.names).toEqual([
        { displayName: 'Agent', principalId: agentId },
        { displayName: 'Approver', principalId },
      ]);
      expect(harness.snapshot().evidenceWrites).toBe(1);
      expect(harness.snapshot().stages.slice(-3)).toEqual(['handler_executed', 'result_decoded', 'evidence_persisted']);
    }),
  );
});

it.layer(Layer.merge(NodeCrypto.layer, outboxWorkerCompositionLayer(makeOutboxWorkerComposition())))(
  'Empty activity composition',
  (suite) => {
    suite.effect('rejects activity input before any SQL or native authority lookup', () =>
      Effect.gen(function* invalidActivity() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: () => Effect.die('Invalid input must not reach SQL'),
          operationTime,
          scope,
        });
        const services = yield* Layer.build(harness.layer);
        const failure = yield* harness.runtime
          .runRead({
            input: { request: { limit: 0 }, visibleModules: ['work.tasks'] },
            principal: scope,
            registration: agentActivityRead,
            transport,
          })
          .pipe(
            Effect.flip,
            Effect.provideService(ContextAccess, Context.get(services, ContextAccess)),
            Effect.provideService(ActionAuthority, {
              checkActionAuthorities: () => Effect.die('Invalid input must not check Action authority'),
              checkActionProposalPermission: () => Effect.die('Activity never uses proposal permission'),
            }),
          );
        expect(Schema.is(ReadInputValidationError)(failure)).toBe(true);
        expect(harness.snapshot().ownerQueries).toEqual([]);
        expect(harness.snapshot().evidenceWrites).toBe(0);
      }),
    );

    suite.effect('a requested module absent from approved authority cannot trigger activity SQL', () =>
      Effect.gen(function* noAuthority() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: () => Effect.die('A requested module is not authority'),
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const services = yield* Layer.build(harness.layer);
        const result = yield* harness.runtime
          .runRead({
            input: { request: {}, visibleModules: ['work.tasks'] },
            principal: scope,
            registration: agentActivityRead,
            transport,
          })
          .pipe(
            Effect.provideService(ContextAccess, Context.get(services, ContextAccess)),
            Effect.provideService(ActionAuthority, {
              checkActionAuthorities: (targets) => {
                expect(targets).toEqual([]);
                return Effect.succeed([]);
              },
              checkActionProposalPermission: () => Effect.die('Activity must never check proposal authority'),
            }),
          );
        expect(result).toEqual({ access: [], audit: [], names: [], proposalOnlyAgentIds: [], proposals: [] });
        expect(harness.snapshot().ownerQueries).toEqual([]);
        expect(harness.snapshot().evidenceWrites).toBe(1);
      }),
    );
  },
);

it.effect(
  'binds activity candidates to installed company/tenant/agent/module and pages decisions by event chronology',
  () =>
    Effect.gen(function* scopedSql() {
      const queries: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
      const database = yield* makeTestDatabase((sql, params) => {
        if (sql.includes('current_setting')) {
          return Effect.succeed([{ legal_entity_id: legalEntityId, role: 'ontos_runtime', tenant_id: tenantId }]);
        }
        queries.push({ params, sql });
        if (sql.includes('from "core"."principals"') && !sql.includes('join')) {
          return Effect.succeed([{ displayName: 'Agent', kind: 'agent', principalId: agentId }]);
        }
        return Effect.succeed([]);
      });
      const request = yield* Schema.decodeEffect(AgentActivityRequestSchema)({
        agentPrincipalId: agentId,
        cursor: { at: '2026-10-25T12:00:00.000Z', id: 'decision:60000000-0000-4000-8000-000000000001' },
        kind: 'decision',
        moduleKey: 'work.tasks',
      });
      const result = yield* database.transaction((transaction) =>
        installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
          Effect.flatMap((scoped) =>
            activityFromTransaction(scoped).load(request, {
              nativeModules: ['work.tasks'],
              visibleModules: ['work.tasks'],
            }),
          ),
        ),
      );
      expect(result.proposals).toEqual([]);
      const activity = queries.filter(({ sql }) => sql.includes('limit'));
      expect(activity).toHaveLength(3);
      for (const query of activity) {
        expect(query.params).toContain(tenantId);
        expect(query.params).toContain(legalEntityId);
        expect(query.params).toContain(agentId);
        expect(query.params).toContain('work.tasks');
        expect(query.params).toContain(31);
        expect(query.sql).toContain("date_trunc('milliseconds'");
        expect(query.sql).toContain('collate "C"');
      }
      const proposalQuery = activity.find(({ sql }) => sql.includes('from "core"."agent_proposals"'));
      expect(proposalQuery?.sql).toContain('"decided_at"');
      expect(proposalQuery?.sql).toContain('"reverted_at"');
      expect(proposalQuery?.sql).toContain("<> 'pending'");
      expect(proposalQuery?.params).toContain(request.cursor?.id);
      const audit = activity.find(({ sql }) => sql.includes('from "core"."audit_events"'));
      expect(audit?.sql).not.toContain('"evidence_json",');
      expect(audit?.sql).toContain('jsonb_typeof');
      expect(audit?.sql).toContain('"action_invocations"."tenant_id"');
    }),
);

const executableComposition = () => {
  const base = makeOutboxWorkerComposition([{ appId: 'task-service', moduleId: 'work.tasks' }]);
  const [module] = base.modules;
  if (module === undefined) {
    throw new TypeError('Expected one fixture module');
  }
  const codec = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
  const contract = Schema.decodeSync(codec)(module.contractDocument);
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
        },
      },
    }),
  );
  const sha256 = Hex.encode(sha256Hash(utf8ToBytes(contractDocument)));
  const next = {
    ...base,
    modules: [
      {
        ...module,
        contract: { ...module.contract, sha256 },
        contractDocument,
        publicContract: { ...module.publicContract, sha256 },
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

it.layer(Layer.merge(NodeCrypto.layer, outboxWorkerCompositionLayer(executableComposition())))(
  'Executable activity composition',
  (suite) => {
    for (const [name, execute, moduleDecision, sqlCount] of [
      ['execution right', 'allowed', 'allowed', 4],
      ['proposal right alone', 'denied', 'allowed', 0],
      ['execution without module access', 'allowed', 'denied', 0],
    ] as const) {
      suite.effect(`activity independently checks ${name}`, () =>
        Effect.gen(function* executableAdmission() {
          const harness = yield* makeReadTestHarness({
            executeOwnerQuery: (query) => {
              expect(query.scope).toEqual({ legalEntityId, tenantId });
              return Effect.succeed([]);
            },
            operationTime,
            ownerAuthorizationDecision: 'allowed',
            permissionDecision: 'allowed',
            scope,
          });
          const services = yield* Layer.build(harness.layer);
          const contextAccess = Context.get(services, ContextAccess);
          const executeDecision: ActionPermissionDecision = execute;
          const result = yield* harness.runtime
            .runRead({
              input: { request: {}, visibleModules: ['work.tasks'] },
              principal: scope,
              registration: agentActivityRead,
              transport,
            })
            .pipe(
              Effect.provideService(ContextAccess, {
                ...contextAccess,
                modules: (target) => {
                  expect(target).toEqual({ legalEntityId, moduleIds: ['work.tasks'], principalId, tenantId });
                  return Effect.succeed([{ decision: moduleDecision, key: 'work.tasks' }]);
                },
              }),
              Effect.provideService(ActionAuthority, {
                checkActionAuthorities: (targets) => {
                  expect(targets).toEqual(
                    moduleDecision === 'allowed'
                      ? [{ actionKey: 'work.tasks.update', legalEntityId, principalId, tenantId }]
                      : [],
                  );
                  return Effect.succeed(
                    targets.map((target) => ({ ...target, execute: executeDecision, propose: 'allowed' as const })),
                  );
                },
                checkActionProposalPermission: () => Effect.die('Activity never uses proposal permission'),
              }),
            );
          expect(result).toEqual({ access: [], audit: [], names: [], proposalOnlyAgentIds: [], proposals: [] });
          expect(harness.snapshot().ownerQueries).toHaveLength(sqlCount);
          expect(harness.snapshot().evidenceWrites).toBe(1);
        }),
      );
    }
  },
);
