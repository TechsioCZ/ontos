import { NodeCrypto } from '@effect/platform-node';
import { sha256 as sha256Hash } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Hex } from 'effect/encoding';

import { getTableColumns } from 'drizzle-orm';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { computeActionRequestHash, computeCanonicalValueHash } from '../../src/actions/repository.ts';
import { AgentProposalCommandPayloadSchema } from '../../src/auth/agent-proposal-command-contract.ts';
import type {
  AgentProposalCommandPayload,
  AgentProposalCommandResult,
} from '../../src/auth/agent-proposal-command-contract.ts';
import {
  AgentProposalQueueInputSchema,
  AgentProposalQueueModuleReview,
  AgentProposalQueueRowSchema,
} from '../../src/auth/agent-proposal-queue-contract.ts';
import { agentProposalQueueRead } from '../../src/auth/agent-proposal-queue-read.ts';
import { agentProposalQueueUnavailable } from '../../src/auth/agent-proposal-queue-unavailable.ts';
import { agentProposals } from '../../src/db/schema.ts';
import { canonicalizeApplicationComposition } from '../../src/modules/application-composition.ts';
import { OntosModuleDeploymentContractSchema } from '../../src/modules/manifest.ts';
import { ActionAuthority } from '../../src/permissions/action-authority.ts';
import type { ActionAuthorityService } from '../../src/permissions/action-authority.ts';
import { ContextAccess } from '../../src/permissions/context-access.ts';
import { ReadHandlerUnavailable, ReadInputValidationError, ReadPermissionDenied } from '../../src/reads/errors.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';
import { makeOutboxWorkerComposition, outboxWorkerCompositionLayer } from '../support/outbox-worker-composition.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const batchId = '50000000-0000-4000-8000-000000000001';
const proposalId = '60000000-0000-4000-8000-000000000001';
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:proposal-queue',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  }),
  correlationId: 'original-proposal-queue-request',
};
const transport = { correlationId: scope.correlationId };
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-25T12:00:00.000Z'));

const rawProposal = {
  actionSlug: 'update',
  agentLabel: 'Agent',
  agentPrincipalId: principalId,
  appId: 'task-service',
  appliedAt: null,
  applyResultJson: null,
  batchId,
  batchInstruction: 'Update tasks',
  batchRevertedAt: null,
  batchRevertedByPrincipalId: null,
  batchRevertNote: null,
  commandJson: { title: 'New' },
  createdAt: operationTime,
  decidedAt: null,
  decidedByPrincipalId: null,
  decisionNote: null,
  diffJson: [{ after: 'New', before: 'Old', field: 'title', label: 'Title' }],
  failure: null,
  legalEntityId,
  moduleKey: 'work.tasks',
  position: 0,
  proposalId,
  reason: 'Requested',
  referenceAudiencesJson: [],
  revertedAt: null,
  revertedByPrincipalId: null,
  revertJson: null,
  risk: 'low',
  runId: 'run-original',
  status: 'pending',
  summary: 'Update',
  targetLabel: 'Task',
  tenantId,
};
const driverRow = (row: typeof agentProposals.$inferSelect = rawProposal) => {
  const columns = Object.keys(getTableColumns(agentProposals));
  return Object.fromEntries(
    Object.entries(row).toSorted(([left], [right]) => columns.indexOf(left) - columns.indexOf(right)),
  );
};

const executableComposition = Effect.fn('AgentProposalQueueReadTest.composition')(function* executableComposition(
  privateRecords: boolean | 'no-review' = 'no-review',
) {
  const base = makeOutboxWorkerComposition([{ appId: 'task-service', moduleId: 'work.tasks' }]);
  const module = base.modules.at(0);
  if (module === undefined) {
    throw new TypeError('Expected fixture module');
  }
  const codec = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
  const contract = yield* Schema.decodeEffect(codec)(module.contractDocument);
  const publicSurface = {
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
  };
  if (privateRecords !== 'no-review') {
    publicSurface.mcp = {
      approvalReview: { path: '/reads/agent-review', privateRecords },
      approvals: true,
      description: { cs: 'Tasks', en: 'Tasks' },
      keywords: '',
      label: { cs: 'Tasks', en: 'Tasks' },
      toolCatalog: { path: '/.well-known/ontos-module-mcp-tools.json', sha256: 'a'.repeat(64), toolCount: 0 },
    };
  }
  const contractDocument = yield* Schema.encodeEffect(codec)(
    yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)({
      ...contract,
      manifest: { ...contract.manifest, publicSurface },
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
});
const reservationId = '70000000-0000-4000-8000-000000000001';
const recoveryPayload = { batchId, operation: 'claim-approval' as const, proposalId };
const claimResult: AgentProposalCommandResult = {
  affectedProposalIds: [proposalId],
  batchId,
  outcome: 'changed',
  proposalIds: [proposalId],
  reservationId,
  revision: 1,
};
/** Driver facts for the real SQL projection, not an alternate recovery implementation. */
const retainedCommand = (
  payload: AgentProposalCommandPayload = recoveryPayload,
  result = claimResult,
  status = 'succeeded',
) => ({
  completedAt: status === 'succeeded' ? operationTime.toISOString() : null,
  evidence: {
    ...result,
    operation: payload.operation,
    proposerPrincipalId: principalId,
    resultHash: computeCanonicalValueHash(result),
  },
  invocationId: reservationId,
  requestHash: computeActionRequestHash({
    actionKey: 'core.identity.mutate-agent-proposals',
    normalizedPayload: payload,
    owningModuleKey: 'core.identity',
    principal: scope,
    schemaVersion: '1',
    target: {},
  }),
  status,
  targetModuleKey: null,
  targetResourceId: null,
  targetResourceType: null,
});

const authority = (execute: 'allowed' | 'denied' = 'allowed'): ActionAuthorityService => ({
  checkActionAuthorities: (targets) =>
    Effect.succeed(targets.map((target) => ({ ...target, execute, propose: 'allowed' }))),
  checkActionProposalPermission: () => Effect.die('Proposal permission never authorizes queue reads'),
});

it.layer(
  Layer.mergeAll(
    NodeCrypto.layer,
    outboxWorkerCompositionLayer(),
    Layer.succeed(ActionAuthority, authority()),
    Layer.succeed(AgentProposalQueueModuleReview, { review: () => Effect.die('Unexpected module review') }),
    Layer.succeed(ContextAccess, {
      legalEntities: () => Effect.die('Unexpected context access'),
      modules: () => Effect.die('Unexpected module access'),
      resources: () => Effect.die('Unexpected resource access'),
      tenants: () => Effect.die('Unexpected tenant access'),
    }),
  ),
)('Native proposal queue', (suite) => {
  it('admits only finite modes and canonical cursors, never caller-selected scope or authority', () => {
    const decode = Schema.decodeUnknownOption(AgentProposalQueueInputSchema, { onExcessProperty: 'error' });
    for (const input of [
      { mode: 'own-run', runId: 'run-original' },
      { mode: 'own-recent' },
      { mode: 'queue', request: { pendingOnly: true } },
      { batchId, mode: 'batch' },
      { batchId, mode: 'batch-state' },
      { idempotencyKey: 'original-subcommand', mode: 'command-recovery', payload: recoveryPayload },
      { agentPrincipalId: principalId, mode: 'withdrawal-batches' },
      { afterBatchId: batchId, agentPrincipalId: principalId, mode: 'withdrawal-batches' },
    ]) {
      expect(Option.isSome(decode(input))).toBe(true);
    }
    for (const input of [
      { mode: 'own-recent', principalId },
      { limit: 100_000, mode: 'own-recent' },
      { mode: 'queue', request: {}, visibleModules: ['work.tasks'] },
      { mode: 'queue', request: { cursor: { at: '2026-10-25', id: 'core:x' } } },
      { batchId: 'other', mode: 'batch' },
      { mode: 'own-run', runId: '' },
      { idempotencyKey: '', mode: 'command-recovery', payload: recoveryPayload },
      { idempotencyKey: 'original-subcommand', mode: 'command-recovery', payload: { ...recoveryPayload, tenantId } },
      { agentPrincipalId: principalId, limit: 100_000, mode: 'withdrawal-batches' },
      { afterBatchId: 'forged', agentPrincipalId: principalId, mode: 'withdrawal-batches' },
    ]) {
      expect(Option.isNone(decode(input))).toBe(true);
    }
    expect(agentProposalQueueRead.descriptor.legalEntityScope).toBe('required');
    expect(agentProposalQueueRead.descriptor.entrypoint.authorization).toEqual({ kind: 'authenticated_principal' });
    expect(agentProposalQueueRead.descriptor.evidencePolicy.captureMode).toBe('metadata_only');
  });

  suite.effect('rejects invalid input before owner SQL', () =>
    Effect.gen(function* invalidInput() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.die('Invalid input reached SQL'),
        operationTime,
        scope,
      });
      const failure = yield* harness.runtime
        .runRead({
          input: { mode: 'own-recent', tenantId },
          principal: scope,
          registration: agentProposalQueueRead,
          transport,
        })
        .pipe(Effect.flip);
      expect(Schema.is(ReadInputValidationError)(failure)).toBe(true);
      expect(harness.snapshot().ownerQueries).toEqual([]);
    }),
  );

  for (const mode of ['own-run', 'own-recent'] as const) {
    suite.effect(`${mode} binds the real scoped transaction to only the admitted active agent`, () =>
      Effect.gen(function* ownRead() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: (query) => {
            expect(query.scope).toEqual({ legalEntityId, tenantId });
            expect(query.params).toContain(tenantId);
            expect(query.params).toContain(principalId);
            if (query.sql.includes('from "core"."principals"')) {
              expect(query.params).toContain('agent');
              expect(query.params).toContain('active');
              return Effect.succeed([{ principalId }]);
            }
            expect(query.sql).toContain('from "core"."agent_proposals"');
            expect(query.params).toContain(legalEntityId);
            expect(query.params).toContain(mode === 'own-run' ? 'run-original' : 300);
            expect(query.sql).toContain('"position" asc');
            return Effect.succeed([driverRow()]);
          },
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const result = yield* harness.runtime.runRead({
          input: mode === 'own-run' ? { mode, runId: 'run-original' } : { mode },
          principal: scope,
          registration: agentProposalQueueRead,
          transport,
        });
        expect(result.proposals).toHaveLength(1);
        expect(Option.isNone(result.proposals.at(0)?.decidedAt ?? Option.none())).toBe(true);
        expect(result.proposals.at(0)?.runId).toEqual(Option.some('run-original'));
        expect(harness.snapshot().evidenceWrites).toBe(1);
        const first = result.proposals.at(0);
        if (first === undefined) {
          throw new TypeError('Expected one proposal');
        }
        const encoded = yield* Schema.encodeEffect(AgentProposalQueueRowSchema)(first);
        expect(encoded).toMatchObject({
          command: rawProposal.commandJson,
          revert: null,
          runId: 'run-original',
        });
      }),
    );
  }

  suite.effect('a human cannot select an own-agent read even with company access', () =>
    Effect.gen(function* notAnAgent() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: (query) => {
          expect(query.params).toContain('agent');
          return Effect.succeed([]);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const failure = yield* harness.runtime
        .runRead({ input: { mode: 'own-recent' }, principal: scope, registration: agentProposalQueueRead, transport })
        .pipe(Effect.flip);
      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
      expect(harness.snapshot().ownerQueries).toHaveLength(1);
    }),
  );

  for (const execute of ['allowed', 'denied'] as const) {
    suite.effect(`queue requires exact execution rights (${execute}), never proposal-only rights`, () =>
      Effect.gen(function* personRead() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: (query) => {
            if (query.sql.includes('from "core"."principals"')) {
              expect(query.params).toContain('human');
              return Effect.succeed([{ principalId }]);
            }
            expect(query.sql).toContain('bool_or(p.status');
            expect(query.sql).toContain("date_trunc('milliseconds', min(p.created_at))");
            expect(query.sql).toContain('collate "C"');
            for (const parameter of [
              tenantId,
              legalEntityId,
              'work.tasks',
              'task-service',
              'update',
              31,
              1551,
              `core:${batchId}`,
              '2026-10-25T12:00:00.000Z',
            ]) {
              expect(query.params).toContain(parameter);
            }
            return Effect.succeed([driverRow()]);
          },
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const services = yield* Layer.build(
          Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(yield* executableComposition())),
        );
        const read = harness.runtime
          .runRead({
            input: {
              mode: 'queue',
              request: {
                batchKey: `core:${batchId}`,
                cursor: { at: '2026-10-25T12:00:00.000Z', id: `core:${batchId}` },
                moduleKey: 'work.tasks',
                pendingOnly: true,
              },
            },
            principal: scope,
            registration: agentProposalQueueRead,
            transport,
          })
          .pipe(Effect.provideService(ActionAuthority, authority(execute)), Effect.provide(services));
        if (execute === 'denied') {
          const failure = yield* read.pipe(Effect.flip);
          expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
          expect(harness.snapshot().ownerQueries).toHaveLength(0);
        } else {
          const result = yield* read;
          expect(result.proposals).toHaveLength(1);
          expect(result.candidates).toEqual([{ at: operationTime.toISOString(), id: `core:${batchId}` }]);
          expect(harness.snapshot().evidenceWrites).toBe(1);
        }
      }),
    );
  }

  suite.effect('module access is independently required even with execution rights', () =>
    Effect.gen(function* noModuleAccess() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.die('No module access reached SQL'),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const services = yield* Layer.build(
        Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(yield* executableComposition())),
      );
      const contextAccess = Context.get(services, ContextAccess);
      const failure = yield* harness.runtime
        .runRead({
          input: { mode: 'queue', request: {} },
          principal: scope,
          registration: agentProposalQueueRead,
          transport,
        })
        .pipe(
          Effect.flip,
          Effect.provideService(ContextAccess, {
            ...contextAccess,
            modules: () => Effect.succeed([{ decision: 'denied', key: 'work.tasks' }]),
          }),
          Effect.provideService(ActionAuthority, authority()),
          Effect.provide(services),
        );
      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
    }),
  );

  for (const [privateRecords, visibility, expectedCount] of [
    [true, 'hidden', 0],
    [true, 'unavailable', 0],
    [false, 'unavailable', 1],
    [true, 'visible', 1],
  ] as const) {
    suite.effect(`review ${visibility}, private=${privateRecords} preserves owner visibility after commit`, () =>
      Effect.gen(function* moduleVisibility() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: (query) =>
            Effect.succeed(query.sql.includes('from "core"."principals"') ? [{ principalId }] : [driverRow()]),
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const composition = yield* executableComposition(privateRecords);
        const services = yield* Layer.build(Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(composition)));
        const result = yield* harness.runtime
          .runRead({
            input: { mode: 'queue', request: {} },
            principal: scope,
            registration: agentProposalQueueRead,
            transport,
          })
          .pipe(
            Effect.provideService(ActionAuthority, authority()),
            Effect.provideService(AgentProposalQueueModuleReview, {
              review: (input) => {
                expect(input.principal).toMatchObject(scope);
                expect(input.transport.correlationId).toBe(transport.correlationId);
                expect(input.compositionRevision).toBe(composition.revision);
                expect(input.path).toBe('/reads/agent-review');
                expect(input.subjects).toEqual([
                  { actionSlug: 'update', command: { title: 'New' }, key: proposalId, stage: 'proposed' },
                ]);
                const { statements } = harness.snapshot();
                expect(statements.some((statement) => statement.toLowerCase() === 'commit')).toBe(true);
                return visibility === 'unavailable'
                  ? Effect.fail(agentProposalQueueUnavailable('Module offline'))
                  : Effect.succeed({ items: [{ key: proposalId, visible: visibility === 'visible' }], state: 'ok' });
              },
            }),
            Effect.provide(services),
          );
        expect(result.proposals).toHaveLength(expectedCount);
        expect(result.candidates).toHaveLength(1);
      }),
    );
  }

  suite.effect('batch access refuses a partial owning-Action view instead of weakening revert-all', () =>
    Effect.gen(function* partialBatch() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: (query) =>
          Effect.succeed(
            query.sql.includes('from "core"."principals"')
              ? [{ principalId }]
              : [driverRow({ ...rawProposal, actionSlug: 'other' })],
          ),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const services = yield* Layer.build(
        Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(yield* executableComposition())),
      );
      const failure = yield* harness.runtime
        .runRead({
          input: { batchId, mode: 'batch' },
          principal: scope,
          registration: agentProposalQueueRead,
          transport,
        })
        .pipe(Effect.flip, Effect.provideService(ActionAuthority, authority()), Effect.provide(services));
      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
    }),
  );

  suite.effect('batch state keeps exact tenant/company/batch and never expires an unresolved approval', () =>
    Effect.gen(function* batchState() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: (query) => {
          if (query.sql.includes('from "core"."principals"')) {
            return Effect.succeed([{ principalId }]);
          }
          for (const parameter of [tenantId, legalEntityId, batchId]) {
            expect(query.params).toContain(parameter);
          }
          expect(query.sql).not.toContain('interval');
          expect(query.sql).not.toContain('now()');
          expect(query.sql).toContain('"position" asc');
          return Effect.succeed([
            driverRow({ ...rawProposal, batchRevertedAt: operationTime, decidedAt: operationTime }),
          ]);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const services = yield* Layer.build(
        Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(yield* executableComposition())),
      );
      const result = yield* harness.runtime
        .runRead({
          input: { batchId, mode: 'batch-state' },
          principal: scope,
          registration: agentProposalQueueRead,
          transport,
        })
        .pipe(Effect.provideService(ActionAuthority, authority()), Effect.provide(services));
      expect(result.approvalInProgress).toBe(true);
      expect(result.batchReverted).toBe(true);
      expect(result.proposals).toEqual([]);
      expect(harness.snapshot().evidenceWrites).toBe(1);
    }),
  );

  suite.effect('a full page keeps all 50 items in each of 31 candidate batches', () =>
    Effect.gen(function* completeCandidates() {
      const rows = Array.from({ length: 31 }, (_, index) => {
        const id = `50000000-0000-4000-8000-${(31 - index).toString().padStart(12, '0')}`;
        return Array.from({ length: 50 }, (_item, position) =>
          driverRow({
            ...rawProposal,
            batchId: id,
            position,
            proposalId: `60000000-0000-4000-8000-${(index * 50 + position + 1).toString().padStart(12, '0')}`,
          }),
        );
      }).flat();
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: (query) => {
          if (query.sql.includes('from "core"."principals"')) {
            return Effect.succeed([{ principalId }]);
          }
          expect(query.params).toContain(31);
          expect(query.params).toContain(1551);
          expect(query.sql).toContain(
            '"created_at" desc, "core"."agent_proposals"."batch_id" desc, "core"."agent_proposals"."position" asc',
          );
          return Effect.succeed(rows);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const services = yield* Layer.build(
        Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(yield* executableComposition())),
      );
      const result = yield* harness.runtime
        .runRead({
          input: { mode: 'queue', request: {} },
          principal: scope,
          registration: agentProposalQueueRead,
          transport,
        })
        .pipe(Effect.provideService(ActionAuthority, authority()), Effect.provide(services));
      expect(result.proposals).toHaveLength(1550);
      expect(result.candidates).toHaveLength(31);
      for (const candidate of result.candidates) {
        expect(result.proposals.filter((row) => `core:${row.batchId}` === candidate.id)).toHaveLength(50);
      }
    }),
  );

  suite.effect('a queue module filter only narrows admitted authority', () =>
    Effect.gen(function* narrowedModule() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: (query) => {
          expect(query.sql).toContain('from "core"."principals"');
          return Effect.succeed([{ principalId }]);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const services = yield* Layer.build(
        Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(yield* executableComposition())),
      );
      const result = yield* harness.runtime
        .runRead({
          input: { mode: 'queue', request: { moduleKey: 'private.other' } },
          principal: scope,
          registration: agentProposalQueueRead,
          transport,
        })
        .pipe(Effect.provideService(ActionAuthority, authority()), Effect.provide(services));
      expect(result.proposals).toEqual([]);
      expect(harness.snapshot().ownerQueries).toHaveLength(1);
    }),
  );

  suite.effect('oversized persisted batches fail instead of silently truncating a native batch', () =>
    Effect.gen(function* oversizedBatch() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: (query) =>
          Effect.succeed(
            query.sql.includes('from "core"."principals"')
              ? [{ principalId }]
              : Array.from({ length: 51 }, () => driverRow()),
          ),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const failure = yield* harness.runtime
        .runRead({
          input: { mode: 'own-run', runId: 'run-original' },
          principal: scope,
          registration: agentProposalQueueRead,
          transport,
        })
        .pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    }),
  );

  for (const operation of ['claim-approval', 'mark-applied', 'claim-batch-revert', 'mark-reverted'] as const) {
    suite.effect(`recovers the exact committed ${operation} result after the caller loses its response`, () =>
      Effect.gen(function* committedRecovery() {
        const payload = yield* Schema.decodeEffect(AgentProposalCommandPayloadSchema)({
          applyResult: { id: 'done' },
          batchId,
          operation,
          proposalId,
          reservationId,
        });
        const result: AgentProposalCommandResult = operation.startsWith('claim-')
          ? claimResult
          : {
              affectedProposalIds: [proposalId],
              batchId,
              outcome: 'changed',
              proposalIds: [proposalId],
              revision: 2,
            };
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: (query) => {
            if (query.sql.includes('from "core"."principals"')) {
              return Effect.succeed([{ principalId }]);
            }
            if (query.sql.includes('from "core"."audit_events"')) {
              return Effect.succeed([{ evidence: retainedCommand().evidence }]);
            }
            if (query.sql.includes('from "core"."action_invocations"')) {
              if (!query.sql.includes('left join')) {
                expect(query.params).toContain(reservationId);
                return Effect.succeed([{ invocationId: reservationId }]);
              }
              for (const parameter of [
                tenantId,
                legalEntityId,
                principalId,
                'core.identity.mutate-agent-proposals',
                'original-subcommand',
              ]) {
                expect(query.params).toContain(parameter);
              }
              expect(query.sql).toContain('left join "core"."audit_events"');
              return Effect.succeed([retainedCommand(payload, result)]);
            }
            return Effect.succeed([
              driverRow({ ...rawProposal, decidedAt: operationTime, decidedByPrincipalId: principalId }),
            ]);
          },
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const services = yield* Layer.build(
          Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(yield* executableComposition())),
        );
        const recovered = yield* harness.runtime
          .runRead({
            input: { idempotencyKey: 'original-subcommand', mode: 'command-recovery', payload },
            principal: scope,
            registration: agentProposalQueueRead,
            transport,
          })
          .pipe(Effect.provideService(ActionAuthority, authority()), Effect.provide(services));
        expect(recovered.commandRecovery).toEqual({
          invocationId: reservationId,
          result,
          retryCommand: false,
          state: 'COMMITTED',
        });
        expect(recovered.approvalInProgress).toBe(true);
        expect(recovered.reservations).toEqual([
          { operation: 'claim-approval', proposalIds: [proposalId], reservationId, revision: 1 },
        ]);
        expect(harness.snapshot().ownerQueries.some((query) => query.sql.includes('for share'))).toBe(true);
        expect(harness.snapshot().evidenceWrites).toBe(1);
      }),
    );
  }

  for (const [status, state, retryCommand] of [
    ['missing', 'NOT_STARTED', true],
    ['received', 'RETRYABLE', true],
    ['running', 'RUNNING', false],
    ['indeterminate', 'RUNNING', false],
    ['rejected', 'REJECTED', false],
    ['failed', 'REJECTED', false],
  ] as const) {
    suite.effect(`projects retained ${status} as ${state} without granting takeover`, () =>
      Effect.gen(function* runningRecovery() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: (query) => {
            if (query.sql.includes('from "core"."principals"')) {
              return Effect.succeed([{ principalId }]);
            }
            if (query.sql.includes('from "core"."action_invocations"')) {
              return Effect.succeed(
                status === 'missing' ? [] : [retainedCommand(recoveryPayload, claimResult, status)],
              );
            }
            return Effect.succeed([driverRow({ ...rawProposal, decidedAt: operationTime })]);
          },
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const services = yield* Layer.build(
          Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(yield* executableComposition())),
        );
        const result = yield* harness.runtime
          .runRead({
            input: { idempotencyKey: 'original-subcommand', mode: 'command-recovery', payload: recoveryPayload },
            principal: scope,
            registration: agentProposalQueueRead,
            transport,
          })
          .pipe(Effect.provideService(ActionAuthority, authority()), Effect.provide(services));
        expect(result.commandRecovery).toMatchObject({ retryCommand, state });
        expect(result.commandRecovery).not.toHaveProperty('result');
        expect(result.approvalInProgress).toBe(true);
        expect(harness.snapshot().ownerQueries.every((query) => !query.sql.startsWith('update'))).toBe(true);
      }),
    );
  }

  for (const corruption of ['request', 'result', 'missing-audit', 'partial-batch'] as const) {
    suite.effect(`refuses ${corruption} recovery evidence rather than fabricating success`, () =>
      Effect.gen(function* corruptRecovery() {
        const record = retainedCommand();
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: (query) => {
            if (query.sql.includes('from "core"."principals"')) {
              return Effect.succeed([{ principalId }]);
            }
            if (query.sql.includes('from "core"."action_invocations"')) {
              if (corruption === 'request') {
                return Effect.succeed([{ ...record, requestHash: 'different-request' }]);
              }
              if (corruption === 'result') {
                return Effect.succeed([{ ...record, evidence: { ...record.evidence, reservationId: batchId } }]);
              }
              if (corruption === 'missing-audit') {
                return Effect.succeed([{ ...record, evidence: null }]);
              }
              return Effect.succeed([record]);
            }
            return Effect.succeed(corruption === 'partial-batch' ? [] : [driverRow()]);
          },
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const services = yield* Layer.build(
          Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(yield* executableComposition())),
        );
        const failure = yield* harness.runtime
          .runRead({
            input: { idempotencyKey: 'original-subcommand', mode: 'command-recovery', payload: recoveryPayload },
            principal: scope,
            registration: agentProposalQueueRead,
            transport,
          })
          .pipe(Effect.flip, Effect.provideService(ActionAuthority, authority()), Effect.provide(services));
        expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      }),
    );
  }

  suite.effect('committed recovery still denies an invisible private sibling across the complete batch', () =>
    Effect.gen(function* privateRecovery() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: (query) => {
          if (query.sql.includes('from "core"."principals"')) {
            return Effect.succeed([{ principalId }]);
          }
          if (query.sql.includes('from "core"."action_invocations"')) {
            return Effect.succeed([retainedCommand()]);
          }
          return Effect.succeed([driverRow()]);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const services = yield* Layer.build(
        Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(yield* executableComposition(true))),
      );
      const failure = yield* harness.runtime
        .runRead({
          input: { idempotencyKey: 'original-subcommand', mode: 'command-recovery', payload: recoveryPayload },
          principal: scope,
          registration: agentProposalQueueRead,
          transport,
        })
        .pipe(
          Effect.flip,
          Effect.provideService(ActionAuthority, authority()),
          Effect.provideService(AgentProposalQueueModuleReview, {
            review: () => Effect.succeed({ items: [{ key: proposalId, visible: false }], state: 'ok' }),
          }),
          Effect.provide(services),
        );
      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
    }),
  );

  suite.effect('lifecycle withdrawal paginates real affected batches beyond the first fixed page', () =>
    Effect.gen(function* withdrawalPagination() {
      const ids = Array.from(
        { length: 40 },
        (_value, index) => `50000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
      );
      const targetAgentId = '30000000-0000-4000-8000-000000000002';
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: (query) => {
          if (query.sql.includes('from "core"."principals"')) {
            return Effect.succeed(query.params.includes('agent') ? [{ status: 'archived' }] : [{ principalId }]);
          }
          expect(query.params).toContain(targetAgentId);
          expect(query.params).toContain(tenantId);
          expect(query.params).toContain(legalEntityId);
          expect(query.params).toContain(32);
          const second = query.params.includes(ids[30]);
          if (second) {
            expect(query.sql).toContain('"batch_id" >');
          }
          return Effect.succeed((second ? ids.slice(31) : ids.slice(0, 32)).map((id) => ({ batchId: id })));
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const services = yield* Layer.build(harness.layer);
      const access = Context.get(services, ContextAccess);
      const pages = yield* Effect.gen(function* pages() {
        const first = yield* harness.runtime.runRead({
          input: { agentPrincipalId: targetAgentId, mode: 'withdrawal-batches' },
          principal: scope,
          registration: agentProposalQueueRead,
          transport,
        });
        const afterBatchId = first.withdrawalBatches?.nextAfterBatchId;
        if (afterBatchId === undefined) {
          throw new TypeError('Expected a real continuation');
        }
        const second = yield* harness.runtime.runRead({
          input: { afterBatchId, agentPrincipalId: targetAgentId, mode: 'withdrawal-batches' },
          principal: scope,
          registration: agentProposalQueueRead,
          transport,
        });
        return [first.withdrawalBatches, second.withdrawalBatches];
      }).pipe(
        Effect.provideService(ContextAccess, {
          ...access,
          legalEntities: (input) =>
            input.permission === 'manage_people'
              ? Effect.succeed([{ decision: 'allowed', key: legalEntityId }])
              : access.legalEntities(input),
        }),
        Effect.provide(services),
      );
      expect(pages[0]?.batchIds).toEqual(ids.slice(0, 31));
      expect(pages[1]).toEqual({ batchIds: ids.slice(31) });
      expect(new Set(pages.flatMap((page) => page?.batchIds ?? [])).size).toBe(40);
    }),
  );

  for (const [name, row] of [
    [
      'another caller',
      { ...rawProposal, decidedAt: operationTime, decidedByPrincipalId: '30000000-0000-4000-8000-000000000003' },
    ],
    ['no active reservation', rawProposal],
  ] as const) {
    suite.effect(`batch state never exposes reservation evidence of ${name}`, () =>
      Effect.gen(function* foreignReservation() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: (query) => {
            if (query.sql.includes('from "core"."principals"')) {
              return Effect.succeed([{ principalId }]);
            }
            expect(query.sql).toContain('from "core"."agent_proposals"');
            expect(query.sql).toContain('for share');
            return Effect.succeed([driverRow(row)]);
          },
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const services = yield* Layer.build(
          Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(yield* executableComposition())),
        );
        const result = yield* harness.runtime
          .runRead({
            input: { batchId, mode: 'batch-state' },
            principal: scope,
            registration: agentProposalQueueRead,
            transport,
          })
          .pipe(Effect.provideService(ActionAuthority, authority()), Effect.provide(services));
        expect(result.reservations).toEqual([]);
        expect(result.proposals).toEqual([]);
      }),
    );
  }

  for (const admin of ['allowed', 'denied', 'unavailable'] as const) {
    suite.effect(`withdrawal discovery requires live native administration (${admin}), not business execution`, () =>
      Effect.gen(function* lifecycleDiscovery() {
        const ids = Array.from(
          { length: 32 },
          (_value, index) => `50000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
        );
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: (query) => {
            if (query.sql.includes('from "core"."principals"')) {
              return Effect.succeed(query.params.includes('agent') ? [{ status: 'disabled' }] : [{ principalId }]);
            }
            expect(query.params).toContain(tenantId);
            expect(query.params).toContain(legalEntityId);
            expect(query.params).toContain(principalId);
            expect(query.params).toContain(32);
            expect(query.sql).toContain('"decided_at" is null');
            expect(query.sql).toContain('group by');
            return Effect.succeed(ids.map((id) => ({ batchId: id })));
          },
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const services = yield* Layer.build(harness.layer);
        const access = Context.get(services, ContextAccess);
        const read = harness.runtime
          .runRead({
            input: { agentPrincipalId: principalId, mode: 'withdrawal-batches' },
            principal: scope,
            registration: agentProposalQueueRead,
            transport,
          })
          .pipe(
            Effect.provideService(ActionAuthority, {
              checkActionAuthorities: () => Effect.die('Lifecycle must not require or confer business execution'),
              checkActionProposalPermission: () => Effect.die('Unexpected propose'),
            }),
            Effect.provideService(ContextAccess, {
              ...access,
              legalEntities: (input) =>
                input.permission === 'manage_people'
                  ? Effect.succeed([{ decision: admin, key: legalEntityId }])
                  : access.legalEntities(input),
              tenants: (input) =>
                input.permission === 'manage_identity'
                  ? Effect.succeed([{ decision: 'denied', key: tenantId }])
                  : access.tenants(input),
            }),
            Effect.provide(services),
          );
        if (admin === 'allowed') {
          const result = yield* read;
          expect(result.withdrawalBatches).toEqual({ batchIds: ids.slice(0, 31), nextAfterBatchId: ids[30] });
          expect(result.proposals).toEqual([]);
          expect(result.candidates).toEqual([]);
        } else {
          const failure = yield* read.pipe(Effect.flip);
          expect(
            admin === 'denied' ? Schema.is(ReadPermissionDenied)(failure) : Schema.is(ReadHandlerUnavailable)(failure),
          ).toBe(true);
          expect(harness.snapshot().ownerQueries).toHaveLength(0);
        }
      }),
    );
  }
});
