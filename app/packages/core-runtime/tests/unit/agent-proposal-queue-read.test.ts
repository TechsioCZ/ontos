import { NodeCrypto } from '@effect/platform-node';
import { sha256 as sha256Hash } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Hex } from 'effect/encoding';

import { getTableColumns } from 'drizzle-orm';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ActionPermissionCheckError } from '../../src/actions/errors.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { computeActionRequestHash, computeCanonicalValueHash } from '../../src/actions/repository.ts';
import { AgentProposalCommandPayloadSchema } from '../../src/auth/agent-proposal-command-contract.ts';
import type {
  AgentProposalCommandPayload,
  AgentProposalCommandResult,
} from '../../src/auth/agent-proposal-command-contract.ts';
import type { AgentProposalQueueInput } from '../../src/auth/agent-proposal-queue-contract.ts';
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
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import type { GateInput } from '../../src/access/enforcement/contract.ts';
import { makeTestAccessDecision } from '../../src/access/enforcement/testing.ts';
import { testAccessSpecOf } from '../../src/testing/access-gate.ts';
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
  traceId: 'original-proposal-queue-trace',
};
const transport = { correlationId: scope.correlationId, traceId: scope.traceId };
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

/** One protected v2 Action of `moduleId`, by slug. */
const ownAction = (moduleId: string, slug: string) => ({
  accessDeclaration: {
    key: `${moduleId}.task.${slug}`,
    kind: 'action' as const,
    modes: ['run' as const],
    placement: { group: 'tasks', level: 'basic' as const },
    risk: 'routine' as const,
    selectors: [],
  },
  actionKey: `${moduleId}.${slug}`,
  auditProfile: 'standard' as const,
  entrypoint: {
    access: 'write' as const,
    authorization: { kind: 'protected' as const },
    entrypointKey: `${moduleId}.${slug}`,
    moduleKey: moduleId,
    role: 'action' as const,
    scope: 'tenant' as const,
  },
  idempotency: 'required' as const,
  legalEntityScope: 'required' as const,
  owningModuleId: moduleId,
  schemaVersion: '1' as const,
});

const executableComposition = Effect.fn('AgentProposalQueueReadTest.composition')(function* executableComposition(
  privateRecords: boolean | 'no-review' = 'no-review',
  /** More Actions of the same module, by slug, besides `update`. */
  additionalSlugs: readonly string[] = [],
  /** A second module with one `update` Action of its own and no approval review. */
  second?: { readonly appId: string; readonly moduleId: string },
) {
  const base = makeOutboxWorkerComposition([
    { appId: 'task-service', moduleId: 'work.tasks' },
    ...(second === undefined ? [] : [second]),
  ]);
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
        // A v2 protected Action: the capability lives in the declaration, never in a legacy
        // `action_execution` provisioning intent (O62).
        accessDeclaration: {
          key: 'work.tasks.task.update',
          kind: 'action',
          modes: ['run'],
          placement: { group: 'tasks', level: 'basic' },
          risk: 'routine',
          selectors: [],
        },
        actionKey: 'work.tasks.update',
        auditProfile: 'standard',
        entrypoint: {
          access: 'write',
          authorization: { kind: 'protected' },
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
      ...additionalSlugs.map((slug) => ownAction('work.tasks', slug)),
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
  const withSurface = Effect.fn('AgentProposalQueueReadTest.withSurface')(function* withSurface(
    target: (typeof base.modules)[number],
    surface: typeof publicSurface | { readonly actions: readonly ReturnType<typeof ownAction>[] },
  ) {
    const own = yield* Schema.decodeEffect(codec)(target.contractDocument);
    const contractDocument = yield* Schema.encodeEffect(codec)(
      yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)({
        ...own,
        manifest: { ...own.manifest, publicSurface: { ...own.manifest.publicSurface, ...surface } },
      }),
    );
    const sha256 = Hex.encode(sha256Hash(utf8ToBytes(contractDocument)));
    return {
      ...target,
      contract: { ...target.contract, sha256 },
      contractDocument,
      publicContract: { ...target.publicContract, sha256 },
    };
  });
  const secondModule = base.modules.at(1);
  const next = {
    ...base,
    modules: [
      yield* withSurface(module, publicSurface),
      ...(second === undefined || secondModule === undefined
        ? []
        : [yield* withSurface(secondModule, { actions: [ownAction(second.moduleId, 'update')] })]),
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
  checkActionAuthorities: (query) =>
    Effect.succeed(query.actionKeys.map((actionKey) => ({ actionKey, execute, propose: 'allowed' as const }))),
  checkActionProposalPermission: () => Effect.die('Proposal permission never authorizes queue reads'),
});

/** Execution rights for exactly `executable`, recording the Action keys of every question in `calls`. */
const recordingAuthority = (executable: ReadonlySet<string>, calls: string[][]): ActionAuthorityService => ({
  checkActionAuthorities: (query) =>
    Effect.sync(() => {
      calls.push([...query.actionKeys]);
      return query.actionKeys.map((actionKey) => ({
        actionKey,
        execute: executable.has(actionKey) ? ('allowed' as const) : ('denied' as const),
        propose: 'allowed' as const,
      }));
    }),
  checkActionProposalPermission: () => Effect.die('Proposal permission never authorizes queue reads'),
});

/** Nine more work-tasks Actions besides `update`: the ninth (`s9`) lies beyond `prepare`'s first round of eight. */
const LATE_SLUGS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'];

/** The `index`-th row of the table's batch, naming the work-tasks Action `slug`. */
const tableRow = (slug: string, index: number) =>
  driverRow({
    ...rawProposal,
    actionSlug: slug,
    position: index,
    proposalId: `60000000-0000-4000-8000-00000000000${index + 1}`,
  });

/** Owner SQL of an exact read over `rows`: the admitted person, no retained command (not started), then the rows. */
const tableQueries = (rows: readonly ReturnType<typeof driverRow>[]) => (query: { readonly sql: string }) => {
  if (query.sql.includes('from "core"."principals"')) {
    return Effect.succeed([{ principalId }]);
  }
  return Effect.succeed(query.sql.includes('from "core"."action_invocations"') ? [] : rows);
};

/** An exact read of the table's batch in `mode`. */
const tableInput = (mode: 'batch' | 'batch-state' | 'command-recovery'): AgentProposalQueueInput =>
  mode === 'command-recovery'
    ? { idempotencyKey: 'table-subcommand', mode, payload: recoveryPayload }
    : { batchId, mode };

/** How a read ended: refused, unavailable, or another failure. */
const outcomeOfFailure = (failure: { readonly _tag: string }) => {
  if (failure._tag === 'ReadPermissionDenied') {
    return 'denied';
  }
  return failure._tag === 'ReadHandlerUnavailable' ? 'unavailable' : 'failed';
};

/**
 * Forty-eight more work-tasks Actions besides `update`: forty-nine in all, so `prepare` asks them in three rounds of
 * eight (`update`, `m1`–`m7`), thirty-two (`m8`–`m39`) and the nine left (`m40`–`m48`).
 */
const MANY_SLUGS = Array.from({ length: 48 }, (_, index) => `m${index + 1}`);

/** Every Action key of the forty-nine-Action composition, in its declared order. */
const MANY_ACTIONS = ['work.tasks.update', ...MANY_SLUGS.map((slug) => `work.tasks.${slug}`)];

/** As `recordingAuthority`, but the `failing`-th question (counted from one) cannot be answered. */
const failingAuthority = (
  executable: ReadonlySet<string>,
  calls: string[][],
  failing: number,
): ActionAuthorityService => {
  const answering = recordingAuthority(executable, calls);
  return {
    ...answering,
    checkActionAuthorities: (query) =>
      Effect.suspend(() =>
        calls.length + 1 === failing
          ? Effect.sync(() => calls.push([...query.actionKeys])).pipe(
              Effect.andThen(
                Effect.fail(
                  new ActionPermissionCheckError({ code: 'action_permission_check_failed', reason: 'engine down' }),
                ),
              ),
            )
          : answering.checkActionAuthorities(query),
      ),
  };
};

/**
 * One exact `batch` read of rows naming `rowSlugs` per authority in `authorities`, in turn over one harness and the
 * forty-nine-Action composition: each read's outcome and whether that read loaded any proposal row.
 */
const manyActionReads = Effect.fn('AgentProposalQueueReadTest.manyActionReads')(function* manyActionReads(
  rowSlugs: readonly string[],
  authorities: readonly ActionAuthorityService[],
) {
  const harness = yield* makeReadTestHarness({
    executeOwnerQuery: tableQueries(rowSlugs.map((slug, index) => tableRow(slug, index))),
    operationTime,
    ownerAuthorizationDecision: 'allowed',
    permissionDecision: 'allowed',
    scope,
  });
  const services = yield* Layer.build(
    Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(yield* executableComposition('no-review', MANY_SLUGS))),
  );
  const reads: { readonly loaded: boolean; readonly outcome: string }[] = [];
  for (const actionAuthority of authorities) {
    const before = harness.snapshot().ownerQueries.length;
    const outcome = yield* harness.runtime
      .runRead({ input: tableInput('batch'), principal: scope, registration: agentProposalQueueRead, transport })
      .pipe(
        Effect.provideService(ActionAuthority, actionAuthority),
        Effect.provide(services),
        Effect.match({ onFailure: outcomeOfFailure, onSuccess: (read) => `rows ${read.proposals.length}` }),
      );
    const loaded = harness
      .snapshot()
      .ownerQueries.slice(before)
      .some(({ sql }) => sql.includes('"agent_proposals"'));
    reads.push({ loaded, outcome });
  }
  return reads;
});

/** A person who exists only in the v2 model holds no `module_access` tuple: that retired relation denies. */
const retiredModuleRelation = (asked: string[]) => (target: { readonly moduleIds: readonly string[] }) =>
  Effect.sync(() => {
    asked.push(...target.moduleIds);
    return target.moduleIds.map((key) => ({ decision: 'denied' as const, key }));
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
    Layer.succeed(AccessDecisionGate, {
      ...makeTestAccessDecision(),
      decide: () => Effect.die('Only lifecycle withdrawal asks the gate'),
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

  const connectionScope = {
    ...Schema.decodeSync(TrustedPrincipalContextSchema)({
      authBindingId: '40000000-0000-4000-8000-000000000001',
      authContextRef: 'oauth-grant:80000000-0000-4000-8000-000000000001',
      authMethod: 'oauth_connection',
      connection: {
        clientId: 'proposal-client',
        clientName: 'Proposal client',
        grantId: '80000000-0000-4000-8000-000000000001',
        modules: [{ access: 'write', moduleId: 'work.tasks' }],
        writePolicy: 'approval',
      },
      legalEntityId,
      principalId,
      tenantId,
    }),
    correlationId: scope.correlationId,
  };

  suite.effect("a person's approval connection reads back only that person's own proposals", () =>
    Effect.gen(function* approvalConnectionOwnRead() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: (query) => {
          if (query.sql.includes('from "core"."principals"')) {
            expect(query.params).toContain('agent');
            expect(query.params).toContain('human');
            return Effect.succeed([{ principalId }]);
          }
          expect(query.sql).toContain('"agent_principal_id" = $');
          expect(query.params).toContain(principalId);
          return Effect.succeed([driverRow()]);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope: connectionScope,
      });
      const result = yield* harness.runtime.runRead({
        input: { mode: 'own-recent' },
        principal: connectionScope,
        registration: agentProposalQueueRead,
        transport,
      });
      expect(result.proposals).toHaveLength(1);
    }),
  );

  for (const input of [
    { mode: 'queue', request: {} },
    { batchId, mode: 'batch' },
    { batchId, mode: 'batch-state' },
    { idempotencyKey: 'original-subcommand', mode: 'command-recovery', payload: recoveryPayload },
    { agentPrincipalId: principalId, mode: 'withdrawal-batches' },
  ] as const) {
    suite.effect(`a connection never reads ${input.mode} beyond its own proposals`, () =>
      Effect.gen(function* connectionQueueDenied() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: () => Effect.die('A connection reached proposal SQL'),
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope: connectionScope,
        });
        const failure = yield* harness.runtime
          .runRead({ input, principal: connectionScope, registration: agentProposalQueueRead, transport })
          .pipe(Effect.flip);
        expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
        expect(harness.snapshot().ownerQueries).toEqual([]);
      }),
    );
  }

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

  suite.effect('decides a batch on the Actions the person may run, never on a retired legacy module tuple', () =>
    Effect.gen(function* v2OnlyReviewer() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: (query) =>
          Effect.succeed(query.sql.includes('from "core"."principals"') ? [{ principalId }] : [driverRow()]),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const services = yield* Layer.build(
        Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(yield* executableComposition())),
      );
      const contextAccess = Context.get(services, ContextAccess);
      const legacyModuleQuestions: string[] = [];
      const read = (execute: 'allowed' | 'denied') =>
        harness.runtime
          .runRead({
            input: { batchId, mode: 'batch' },
            principal: scope,
            registration: agentProposalQueueRead,
            transport,
          })
          .pipe(
            Effect.provideService(ContextAccess, {
              ...contextAccess,
              modules: retiredModuleRelation(legacyModuleQuestions),
            }),
            Effect.provideService(ActionAuthority, authority(execute)),
            Effect.provide(services),
          );
      const allowed = yield* read('allowed');
      expect(allowed.proposals.map((row) => row.proposalId)).toEqual([proposalId]);
      const denied = yield* read('denied').pipe(Effect.flip);
      expect(Schema.is(ReadPermissionDenied)(denied)).toBe(true);
      expect(legacyModuleQuestions).toEqual([]);
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
                expect(
                  Schema.decodeUnknownSync(TrustedPrincipalContextSchema, { onExcessProperty: 'error' })(
                    input.principal,
                  ),
                ).toEqual(Schema.decodeUnknownSync(TrustedPrincipalContextSchema)(scope));
                expect(input.principal).not.toHaveProperty('correlationId');
                expect(input.principal).not.toHaveProperty('traceId');
                expect(input.transport.correlationId).toBe(transport.correlationId);
                expect(input.transport.traceId).toBe(transport.traceId);
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

  /*
   * An exact batch read refuses a person who may run no Action at all in `prepare`, before any row is loaded or
   * locked, and then authorizes exactly the Actions its rows name. It gives the same allow/deny answer the read gave
   * when `prepare` asked every Action of the release: refused unless the person may run at least one Action and every
   * row's declared Action. That rule is written out below as the reference; running this table against the read as it
   * was before these changes gave the same allow/deny outcomes (only the Actions it asked differed). The one known
   * difference is an authority outage confined to a round that is never asked; see `holdsAnyExecutableAction`.
   */
  for (const scenario of [
    { executable: ['update', 'archive'], rows: ['update'] },
    { executable: ['archive'], rows: ['update'] },
    { executable: [], rows: ['update'] },
    { executable: ['update'], rows: ['update', 'update'] },
    { executable: ['archive'], rows: [] },
    { executable: [], rows: [] },
    { executable: ['update', 'archive'], rows: ['other'] },
  ] as const) {
    for (const mode of ['batch', 'batch-state', 'command-recovery'] as const) {
      suite.effect(
        `gives a ${mode} read the same allow/deny answer as asking every Action (${JSON.stringify(scenario)})`,
        () =>
          Effect.gen(function* exactBatchAuthority() {
            const rows = scenario.rows.map((slug, index) => tableRow(slug, index));
            const harness = yield* makeReadTestHarness({
              executeOwnerQuery: tableQueries(rows),
              operationTime,
              ownerAuthorizationDecision: 'allowed',
              permissionDecision: 'allowed',
              scope,
            });
            const services = yield* Layer.build(
              Layer.mergeAll(
                harness.layer,
                outboxWorkerCompositionLayer(yield* executableComposition('no-review', ['archive'])),
              ),
            );
            const calls: string[][] = [];
            const outcome = yield* harness.runtime
              .runRead({ input: tableInput(mode), principal: scope, registration: agentProposalQueueRead, transport })
              .pipe(
                Effect.provideService(
                  ActionAuthority,
                  recordingAuthority(new Set(scenario.executable.map((slug) => `work.tasks.${slug}`)), calls),
                ),
                Effect.provide(services),
                Effect.match({ onFailure: outcomeOfFailure, onSuccess: (read) => `rows ${read.proposals.length}` }),
              );
            const declared = new Set(['update', 'archive']);
            const runnable = new Set<string>(scenario.executable);
            const everyRowRunnable = scenario.rows.every((slug) => declared.has(slug) && runnable.has(slug));
            const allowed = runnable.size > 0 && everyRowRunnable;
            expect(outcome).toBe(allowed ? `rows ${mode === 'batch-state' ? 0 : scenario.rows.length}` : 'denied');
            // `prepare` asks whether any Action at all may run (both declared ones fit its first round).
            expect(calls[0]).toEqual(['work.tasks.update', 'work.tasks.archive']);
            const loadedProposals = harness
              .snapshot()
              .ownerQueries.some(({ sql }) => sql.includes('"agent_proposals"'));
            if (runnable.size === 0) {
              // Refused before any row is loaded or locked: an existing and a missing batch cost the same.
              expect(calls).toHaveLength(1);
              expect(loadedProposals).toBe(false);
              return;
            }
            expect(loadedProposals).toBe(true);
            // Both declared Actions were answered in `prepare`'s first round: `finish` applies those answers to the rows,
            // as the read always applied `prepare`'s, and asks nothing more.
            expect(calls.slice(1)).toEqual([]);
          }),
      );
    }
  }

  suite.effect("refuses a batch spanning two modules when one row's Action may not run, having asked that Action", () =>
    Effect.gen(function* twoModules() {
      const rows = [
        tableRow('update', 0),
        { ...tableRow('update', 1), appId: 'party-service', moduleKey: 'party.registry' },
      ];
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: tableQueries(rows),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const composition = yield* executableComposition('no-review', [], {
        appId: 'party-service',
        moduleId: 'party.registry',
      });
      const services = yield* Layer.build(Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(composition)));
      const calls: string[][] = [];
      const outcome = yield* harness.runtime
        .runRead({ input: tableInput('batch'), principal: scope, registration: agentProposalQueueRead, transport })
        .pipe(
          Effect.provideService(ActionAuthority, recordingAuthority(new Set(['work.tasks.update']), calls)),
          Effect.provide(services),
          Effect.match({ onFailure: outcomeOfFailure, onSuccess: () => 'allowed' }),
        );
      expect(outcome).toBe('denied');
      // The refused row's own Action was asked (so its denial is decided and recorded), with its sibling's.
      expect(new Set(calls.flat())).toEqual(new Set(['work.tasks.update', 'party.registry.update']));
    }),
  );

  suite.effect('refuses an exact batch whose private row the owner review hides', () =>
    Effect.gen(function* hiddenPrivateRow() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: tableQueries([tableRow('update', 0)]),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const services = yield* Layer.build(
        Layer.mergeAll(harness.layer, outboxWorkerCompositionLayer(yield* executableComposition(true))),
      );
      const outcome = yield* harness.runtime
        .runRead({ input: tableInput('batch'), principal: scope, registration: agentProposalQueueRead, transport })
        .pipe(
          Effect.provideService(ActionAuthority, authority()),
          Effect.provideService(AgentProposalQueueModuleReview, {
            review: (input) =>
              Effect.succeed({ items: input.subjects.map(({ key }) => ({ key, visible: false })), state: 'ok' }),
          }),
          Effect.provide(services),
          Effect.match({ onFailure: outcomeOfFailure, onSuccess: () => 'allowed' }),
        );
      expect(outcome).toBe('denied');
    }),
  );

  suite.effect("asks in finish exactly the rows' Actions prepare did not answer, and applies the others", () =>
    Effect.gen(function* lateRowAction() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: tableQueries([tableRow('s9', 0)]),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const services = yield* Layer.build(
        Layer.mergeAll(
          harness.layer,
          outboxWorkerCompositionLayer(yield* executableComposition('no-review', LATE_SLUGS)),
        ),
      );
      const calls: string[][] = [];
      const outcome = yield* harness.runtime
        .runRead({ input: tableInput('batch'), principal: scope, registration: agentProposalQueueRead, transport })
        .pipe(
          Effect.provideService(
            ActionAuthority,
            recordingAuthority(new Set(['work.tasks.update', 'work.tasks.s9']), calls),
          ),
          Effect.provide(services),
          Effect.match({ onFailure: outcomeOfFailure, onSuccess: (read) => `rows ${read.proposals.length}` }),
        );
      expect(outcome).toBe('rows 1');
      // `prepare`'s first round (eight Actions) found a right; `finish` asks only the row's Action it did not answer.
      expect(calls.map((call) => call.length)).toEqual([8, 1]);
      expect(calls[1]).toEqual(['work.tasks.s9']);
    }),
  );

  suite.effect(
    "answers an exact batch unavailable, never refused or allowed, when its rows' Actions cannot be asked",
    () =>
      Effect.gen(function* authorityUnavailable() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: tableQueries([tableRow('s9', 0)]),
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const services = yield* Layer.build(
          Layer.mergeAll(
            harness.layer,
            outboxWorkerCompositionLayer(yield* executableComposition('no-review', LATE_SLUGS)),
          ),
        );
        const asked = { count: 0 };
        const outcome = yield* harness.runtime
          .runRead({ input: tableInput('batch'), principal: scope, registration: agentProposalQueueRead, transport })
          .pipe(
            Effect.provideService(ActionAuthority, {
              ...authority(),
              // `prepare`'s question is answered; the rows' own one in `finish` cannot be.
              checkActionAuthorities: (query) =>
                Effect.suspend(() => {
                  asked.count += 1;
                  return asked.count === 1
                    ? authority().checkActionAuthorities(query)
                    : Effect.fail(
                        new ActionPermissionCheckError({
                          code: 'action_permission_check_failed',
                          reason: 'engine down',
                        }),
                      );
                }),
            }),
            Effect.provide(services),
            Effect.match({ onFailure: outcomeOfFailure, onSuccess: () => 'allowed' }),
          );
        expect(asked.count).toBe(2);
        expect(outcome).toBe('unavailable');
      }),
  );

  /*
   * A person whose only right lies beyond `prepare`'s first round: the rounds go on until one admits an Action, and
   * the rows' Actions are still decided one by one, each by its own answer (from `prepare` when it asked it, else in
   * `finish`).
   */
  for (const scenario of [
    { calls: [8, 32, 1], executable: ['m20', 'm45'], outcome: 'rows 2', round: 2, rows: ['m20', 'm45'] },
    { calls: [8, 32, 1], executable: ['m20'], outcome: 'denied', round: 2, rows: ['m20', 'm45'] },
    { calls: [8, 32, 9], executable: ['m45'], outcome: 'rows 1', round: 3, rows: ['m45'] },
    { calls: [8, 32, 9], executable: ['m45'], outcome: 'denied', round: 3, rows: ['m45', 'm3'] },
  ] as const) {
    suite.effect(
      `continues to round ${scenario.round} for a person whose only rights lie there (${JSON.stringify(scenario.rows)} -> ${scenario.outcome})`,
      () =>
        Effect.gen(function* laterRoundRight() {
          const calls: string[][] = [];
          const runnable = new Set(scenario.executable.map((slug) => `work.tasks.${slug}`));
          const [read] = yield* manyActionReads(scenario.rows, [recordingAuthority(runnable, calls)]);
          expect(read?.outcome).toBe(scenario.outcome);
          expect(read?.loaded).toBe(true);
          expect(calls.map((call) => call.length)).toEqual(scenario.calls);
          // Every Action asked once: `prepare`'s answers are applied, and `finish` asks only rows' Actions it did not.
          expect(calls.flat().toSorted()).toEqual([...new Set(calls.flat())].toSorted());
          if (scenario.round === 2) {
            // Round 2 found a right, so `finish` asks the row Action round 3 would have: nothing else.
            expect(calls[2]).toEqual(['work.tasks.m45']);
          }
        }),
    );
  }

  for (const rows of [['m1'], []]) {
    suite.effect(
      `asks a person with no right every one of more than eight Actions, each once, then refuses (${rows.length === 0 ? 'missing' : 'existing'} batch)`,
      () =>
        Effect.gen(function* noRightManyActions() {
          const calls: string[][] = [];
          const [read] = yield* manyActionReads(rows, [recordingAuthority(new Set(), calls)]);
          expect(read).toEqual({ loaded: false, outcome: 'denied' });
          // Every Action is asked, in its round, so every denial is decided (and so recorded by the real authority).
          expect(calls.map((call) => call.length)).toEqual([8, 32, 9]);
          expect(calls.flat()).toEqual(MANY_ACTIONS);
        }),
    );
  }

  for (const scenario of [
    { calls: [8], failing: 1, round: 1 },
    { calls: [8, 32, 9], failing: 3, round: 3 },
  ] as const) {
    suite.effect(
      `answers unavailable, never refused or allowed, when prepare's round ${scenario.round} cannot be asked, and keeps nothing for the next read`,
      () =>
        Effect.gen(function* prepareUnavailable() {
          const failed: string[][] = [];
          const next: string[][] = [];
          const runnable = new Set(['work.tasks.update']);
          const [unavailable, after] = yield* manyActionReads(
            ['update'],
            [failingAuthority(new Set(), failed, scenario.failing), recordingAuthority(runnable, next)],
          );
          expect(unavailable).toEqual({ loaded: false, outcome: 'unavailable' });
          expect(failed.map((call) => call.length)).toEqual(scenario.calls);
          // The next read starts over from the first round: no answer of the failed read was kept.
          expect(after).toEqual({ loaded: true, outcome: 'rows 1' });
          expect(next.map((call) => call.length)).toEqual([8]);
        }),
    );
  }

  suite.effect(
    'reads a missing batch as no rows when the authority is down only for a round that is never asked (accepted)',
    () =>
      Effect.gen(function* unaskedRoundOutage() {
        const calls: string[][] = [];
        const [read] = yield* manyActionReads([], [failingAuthority(new Set(['work.tasks.update']), calls, 2)]);
        // Round 1 admits `update`, so round 2 (whose question would fail) is never asked: 0 rows, not "unavailable".
        expect(read).toEqual({ loaded: true, outcome: 'rows 0' });
        expect(calls.map((call) => call.length)).toEqual([8]);
      }),
  );

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
      // The harness gate grants the agent administration right (permissionDecision: 'allowed').
      const services = yield* Layer.build(harness.layer);
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
      }).pipe(Effect.provide(services));
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
    suite.effect(
      `withdrawal discovery requires the agent administration right (${admin}), not business execution`,
      () =>
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
          const asked: GateInput[] = [];
          const scripted = makeTestAccessDecision(testAccessSpecOf({ 'core.identity.agent-status.manage': admin }));
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
              Effect.provideService(AccessDecisionGate, {
                ...scripted,
                decide: (input: GateInput) => {
                  asked.push(input);
                  return scripted.decide(input);
                },
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
              admin === 'denied'
                ? Schema.is(ReadPermissionDenied)(failure)
                : Schema.is(ReadHandlerUnavailable)(failure),
            ).toBe(true);
            expect(harness.snapshot().ownerQueries).toHaveLength(0);
          }
          // The one question is the right the same person uses to disable or archive the agent, in this company.
          expect(asked.map((input) => input.carrier.accessDeclaration?.key)).toEqual([
            'core.identity.agent-status.manage',
          ]);
          expect(asked[0]).toMatchObject({ legalEntityScope: 'required', scope: { legalEntityId, tenantId } });
        }),
    );
  }
});
