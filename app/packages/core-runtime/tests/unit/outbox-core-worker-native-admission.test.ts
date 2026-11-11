import { NodeServices } from '@effect/platform-node';
import { Crypto, DateTime, Deferred, Effect, Fiber, Layer, Match, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { AccessOperationIdSchema, AccessScopeIdSchema, CommandDigestSchema } from '../../src/access/ids.ts';
import { AccessProjectionWriter } from '../../src/access/intent/projection-writer.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { refuseInsideDatabaseTransaction } from '../../src/db/transaction-io-guard.ts';
import { ActiveApplicationCompositionService } from '../../src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionUnavailableError } from '../../src/modules/active-application-composition-errors.ts';
import { buildApplicationCompositionCatalog } from '../../src/modules/application-composition-catalog.ts';
import type { OntosDeploymentIdentitySchema } from '../../src/modules/manifest.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { isGenuineCoreOutboxWorker } from '../../src/modules/module-operation-execution.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { corePeopleSearchOutboxWorkers, coreSystemOutboxWorkers } from '../../src/outbox/core-system-worker-entry.ts';
import { outboxWorkerTenantScope } from '../../src/outbox/core-authorization-projection.ts';
import { CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS } from '../../src/outbox/core-system-subscriptions.ts';
import { defineOutboxWorker, isVerifiedOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import type { OutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { defineOutboxWorkerEntry } from '../../src/outbox/process.ts';
import { makeOutboxRepository } from '../../src/outbox/repository.ts';
import type { OutboxClaim } from '../../src/outbox/repository.ts';
import { makeOutboxRuntime, OutboxRuntime } from '../../src/outbox/runtime.ts';
import type { OutboxCycleError, OutboxCycleResult, OutboxRuntimeService } from '../../src/outbox/runtime.ts';
import { OutboxWorkerTenantScope, OutboxWorkerTenantScopeLive } from '../../src/outbox/tenant-scope.ts';
import type { OutboxWorkerTenantScopeView } from '../../src/outbox/tenant-scope.ts';
import { prepareNativeOutboxClaimAdmission } from '../../src/outbox/worker-runtime-binding.ts';
import { PeopleSearchProjector } from '../../src/people/people-search-projection.ts';
import { peopleSearchUnavailable } from '../../src/people/people-search-contract.ts';
import { ActionAuthorizationLifecycleLive } from '../../src/permissions/action-authorization-lifecycle.ts';
import { makeTestDatabase } from '../support/database.ts';
import {
  freshOutboxWorkerCompositionSnapshot,
  makeOutboxWorkerComposition,
} from '../support/outbox-worker-composition.ts';
import { makeNativeOutboxWorkerFixture } from '../support/outbox-worker-native-fixture.ts';

const workers = Object.freeze([...coreSystemOutboxWorkers, ...corePeopleSearchOutboxWorkers]);
type CoreWorker = (typeof workers)[number];
const composition = makeOutboxWorkerComposition();
const tenantId = '10000000-0000-4000-8000-000000000001';
const actorPrincipalId = '10000000-0000-4000-8000-000000000002';
const invocationId = '10000000-0000-4000-8000-000000000003';

const payloadFor = (registration: CoreWorker) =>
  Match.value(registration.descriptor.workerKey).pipe(
    Match.when('core.authorization.reconcile-module-installation', () => ({ data: { moduleKey: 'core.identity' } })),
    Match.when('core.authorization.reconcile-principal-binding', () => ({
      data: {
        authBindingId: '10000000-0000-4000-8000-000000000004',
        authenticationNamespaceId: 'test.staff.better-auth.v1',
        bindingRevision: 2,
        newStatus: 'active',
        previousStatus: 'pending',
        principalId: actorPrincipalId,
        tenantId,
        transitionRef: invocationId,
      },
    })),
    Match.when('core.identity.rebuild-people-search', () => ({ data: { operation: 'rebuild' } })),
    Match.orElse(() => ({ data: { principalId: actorPrincipalId } })),
  );

interface FixtureOptions {
  readonly authority?: 'expired' | 'revision-changed' | 'unavailable';
  readonly deployment?: typeof OntosDeploymentIdentitySchema.Type;
  readonly due?: boolean;
  readonly registrations?: readonly CoreWorker[];
  readonly selected?: CoreWorker;
  readonly sqlAuthority?: 'expired' | 'sealed' | 'stale';
}

const runEntry = Effect.fn('TestCoreOutbox.runEntry')(function* runEntry(options: FixtureOptions = {}) {
  const statements: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
  const reconciled: OperationalScope[] = [];
  const observed: OutboxWorkerHandlerContext[] = [];
  const failures: OutboxCycleError[] = [];
  const claims: OutboxClaim[] = [];
  const results: OutboxCycleResult[] = [];
  const { selected } = options;
  let openTransactions = 0;
  let claimed = false;
  let completed = false;
  let authorityLoads = 0;
  const candidateRows = () => {
    if (selected === undefined || claimed) {
      return [];
    }
    return [
      {
        actionInvocationId: invocationId,
        attemptsCount: 0,
        consumerModuleKey: selected.descriptor.consumerModuleKey,
        deliveryId: 'delivery-1',
        domainEventId: 'event-1',
        messageId: 'message-1',
        payloadJson: payloadFor(selected),
        producerModuleKey: selected.descriptor.producerModuleKey,
        status: 'pending',
        tenantId,
        tenantSequenceNo: 1n,
        topic: selected.descriptor.topic,
        workerKey: selected.descriptor.workerKey,
      },
    ];
  };
  const database = yield* makeTestDatabase((statement, params) =>
    Effect.sync(() => {
      statements.push({ params, sql: statement });
      if (/^begin/iu.test(statement)) {
        openTransactions += 1;
        return [];
      }
      if (/^(?:commit|rollback)/iu.test(statement)) {
        openTransactions -= 1;
        return [];
      }
      if (statement.includes("current_setting('transaction_isolation')")) {
        return [{ isolation: 'read committed' }];
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return [
          {
            phase: options.sqlAuthority === 'sealed' ? 'sealed' : 'active',
            revision: options.sqlAuthority === 'stale' ? 'b'.repeat(64) : composition.revision,
            subscriptionsJson: [],
            unexpired: options.sqlAuthority !== 'expired',
          },
        ];
      }
      if (statement.includes('skip locked')) {
        // This fixture has no Core consumer module row. Never fabricate a
        // candidate that a required installation join would have discarded.
        expect(statement).not.toContain('inner join "core"."tenant_module_states"');
        return candidateRows();
      }
      if (statement.startsWith('select "core"."outbox_deliveries"."outbox_delivery_id" from')) {
        expect(statement).not.toContain('inner join "core"."tenant_module_states"');
        return options.due === false ? [] : [{ deliveryId: 'delivery-1' }];
      }
      if (statement.startsWith('update "core"."outbox_deliveries"')) {
        if (!claimed) {
          claimed = true;
          return [{ attemptsCount: 1 }];
        }
        completed = params.includes('done');
        return [{ deliveryId: 'delivery-1' }];
      }
      if (statement.startsWith('insert into "core"."outbox_attempts"')) {
        return [{ attemptId: 'attempt-1' }];
      }
      if (statement.includes('from "core"."action_invocations"')) {
        return [{ actorPrincipalId, correlationId: 'core-worker-native-admission' }];
      }
      if (statement.includes('from "core"."outbox_deliveries"')) {
        return statement.includes('inner join')
          ? [{ status: 'done', tenantSequenceNo: 1n }]
          : [{ deliveryId: 'delivery-1' }];
      }
      if (statement.startsWith('update "core"."outbox_attempts"')) {
        return [{ attemptId: 'attempt-1' }];
      }
      if (statement.includes("set_config('ontos.tenant_id'")) {
        return [{ legal_entity_id: '', tenant_id: tenantId }];
      }
      if (statement.includes('from "core"."tenants"')) {
        return [{ status: 'active', tenantId }];
      }
      if (statement.includes('"core"."worker_checkpoints"')) {
        return [];
      }
      throw new Error(`Unexpected Core worker fixture statement: ${statement}`);
    }),
  );
  const crypto = yield* Crypto.Crypto;
  const repository = makeOutboxRepository(database, crypto);
  const runtime = makeOutboxRuntime({
    ...repository,
    claimNext: (...input) =>
      repository.claimNext(...input).pipe(
        Effect.tap((claim) =>
          Effect.sync(() => {
            if (Option.isSome(claim)) {
              claims.push(claim.value);
            }
          }),
        ),
      ),
  });
  const observedRuntime: OutboxRuntimeService = {
    ...runtime,
    runCycle: (input) =>
      runtime.runCycle(input).pipe(
        Effect.tap((result) => Effect.sync(() => results.push(result))),
        Effect.tapError((failure) => Effect.sync(() => failures.push(failure))),
      ),
  };
  const tenantScope = OutboxWorkerTenantScopeLive.pipe(
    Layer.provide(Layer.succeed(CoreDatabase, { executor: database })),
  );
  const lifecycle = ActionAuthorizationLifecycleLive.pipe(
    Layer.provide(
      Layer.succeed(AccessProjectionWriter, {
        reconcileTenant: ({ scope }) =>
          refuseInsideDatabaseTransaction('spicedb', 'scripted-core-projection').pipe(
            Effect.andThen(
              Effect.sync(() => {
                expect(openTransactions).toBe(0);
                reconciled.push(scope);
                return {
                  deletions: 0,
                  digest: CommandDigestSchema.make('a'.repeat(64)),
                  operationId: AccessOperationIdSchema.make(invocationId),
                  projectionToken: 'scripted-projection-token',
                  resumed: false,
                  scopeId: AccessScopeIdSchema.make(tenantId),
                  touches: 0,
                  units: [],
                  verified: true,
                };
              }),
            ),
          ),
      }),
    ),
  );
  const observePeople = (context: OutboxWorkerHandlerContext, view: OutboxWorkerTenantScopeView) =>
    Effect.sync(() => {
      expect(openTransactions).toBe(1);
      expect(view.tenantId).toBe(tenantId);
      expect(isVerifiedOutboxWorkerHandlerContext(context)).toBe(true);
      observed.push(context);
    });
  const projector = Layer.effect(
    PeopleSearchProjector,
    OutboxWorkerTenantScope.pipe(
      Effect.map((scope) => ({
        project: (context: OutboxWorkerHandlerContext) =>
          scope.run(context, observePeople.bind(undefined, context)).pipe(Effect.mapError(peopleSearchUnavailable)),
      })),
    ),
  ).pipe(Layer.provide(tenantScope));
  const firstCycle = yield* Deferred.make<'failed' | 'succeeded'>();
  const entry = defineOutboxWorkerEntry({
    claimOwnerPrefix: 'core-worker-native-admission',
    expectedDeployment: options.deployment ?? composition.shell.deployment,
    layer: Layer.mergeAll(
      TestClock.layer(),
      Layer.succeed(OutboxRuntime, observedRuntime),
      lifecycle,
      projector,
      Layer.succeed(ActiveApplicationCompositionService, {
        load: Effect.suspend(() => {
          expect(openTransactions).toBe(0);
          authorityLoads += 1;
          if (authorityLoads > 1 && options.authority === 'unavailable') {
            return Effect.fail(new ActiveApplicationCompositionUnavailableError({ reason: 'Source unavailable' }));
          }
          if (authorityLoads > 1 && options.authority === 'expired') {
            return DateTime.now.pipe(
              Effect.map((now) => ({
                composition,
                observedAt: DateTime.subtract(now, { seconds: 2 }),
                validUntil: DateTime.subtract(now, { seconds: 1 }),
              })),
            );
          }
          return freshOutboxWorkerCompositionSnapshot(
            authorityLoads > 1 && options.authority === 'revision-changed'
              ? makeOutboxWorkerComposition([{ appId: 'other-worker', moduleId: 'worker.other' }])
              : composition,
          );
        }),
      }),
    ),
    registrations: options.registrations ?? workers,
    subscriptions: CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS,
  });
  const running = yield* entry
    .runLoop({
      config: { claimOwner: 'core-worker-native-admission:test', maxDeliveries: 1, pollIntervalMs: 10 },
      health: {
        cycleFailed: Deferred.succeed(firstCycle, 'failed').pipe(Effect.asVoid),
        cycleSucceeded: Deferred.succeed(firstCycle, 'succeeded').pipe(Effect.asVoid),
      },
    })
    .pipe(Effect.forkChild);
  const outcome = yield* Deferred.await(firstCycle).pipe(
    Effect.raceFirst(Fiber.join(running)),
    Effect.ensuring(Fiber.interrupt(running)),
  );
  expect(openTransactions).toBe(0);
  // The process-local binding must not survive interruption, even for its original worker values.
  const afterExit = yield* Effect.flip(
    repository.claimNext(workers, 'after-entry-exit', DateTime.toDateUtc(DateTime.makeUnsafe(0)), composition.revision),
  );
  expect(afterExit._tag).toBe('ApplicationCompositionAuthorityError');
  return { claimed, claims, completed, failures, observed, outcome, reconciled, results, statements };
});

it.layer(NodeServices.layer, { excludeTestServices: true })('Core native Outbox worker admission', (suite) => {
  suite.effect('derives the bounded run reference from the complete native claim without replacing its evidence', () =>
    Effect.gen(function* safeNativeClaimReference() {
      const claimId = 'core-worker-native-admission:test:10000000-0000-4000-8000-000000000004';
      const scope = yield* outboxWorkerTenantScope({ actorPrincipalId, claimId, tenantId });
      expect(scope).toEqual({
        authContextRef:
          'job:core.authorization.outbox:run:0bf3800089fead9475c4bfd154954f06ff8a310527a96074dee351c05d9465b6',
        authMethod: 'system',
        correlationId: `core.authorization.outbox:${claimId}`,
        principalId: actorPrincipalId,
        tenantId,
      });
      expect(yield* outboxWorkerTenantScope({ actorPrincipalId, claimId, tenantId })).toEqual(scope);
      const otherOwner = yield* outboxWorkerTenantScope({
        actorPrincipalId,
        claimId: 'other-owner:test:10000000-0000-4000-8000-000000000004',
        tenantId,
      });
      expect(otherOwner.authContextRef).not.toBe(scope.authContextRef);
      const otherClaim = yield* outboxWorkerTenantScope({
        actorPrincipalId,
        claimId: 'core-worker-native-admission:test:10000000-0000-4000-8000-000000000005',
        tenantId,
      });
      expect(otherClaim.authContextRef).not.toBe(scope.authContextRef);
      const longestNativeClaimId = `${'x'.repeat(200)}:10000000-0000-4000-8000-000000000004`;
      const longScope = yield* outboxWorkerTenantScope({
        actorPrincipalId,
        claimId: longestNativeClaimId,
        tenantId,
      });
      expect(longScope.authContextRef).toMatch(/^job:core\.authorization\.outbox:run:[a-f0-9]{64}$/u);
      expect(longScope.correlationId).toBe(`core.authorization.outbox:${longestNativeClaimId}`);
    }),
  );

  suite.effect('still rejects missing actors, empty claim references and malformed identity scope', () =>
    Effect.gen(function* invalidCoreClaimScope() {
      for (const input of [
        { claimId: 'owner:claim', tenantId },
        { actorPrincipalId, claimId: '', tenantId },
        { actorPrincipalId: 'not-a-principal', claimId: 'owner:claim', tenantId },
        { actorPrincipalId, claimId: 'owner:claim', tenantId: 'not-a-tenant' },
      ]) {
        const failure = yield* Effect.flip(outboxWorkerTenantScope(input));
        expect(failure._tag).toBe('CoreAuthorizationProjectionError');
      }
    }),
  );

  suite.effect('recognizes only the original shipped Core worker values, not recreated or copied registrations', () =>
    Effect.gen(function* originalCoreWorkerIdentities() {
      const catalog = yield* buildApplicationCompositionCatalog(composition);
      for (const worker of workers) {
        expect(yield* isGenuineCoreOutboxWorker(worker)).toBe(true);
        expect(catalog.getByModuleId(worker.descriptor.consumerModuleKey)).toBeUndefined();
        expect(yield* isGenuineCoreOutboxWorker({ ...worker })).toBe(false);
      }
      const recreated = defineOutboxWorker(coreSystemOutboxWorkers[0].descriptor, () => Effect.void);
      expect(yield* isGenuineCoreOutboxWorker(recreated)).toBe(false);
    }),
  );

  suite.effect('retains original tenant-worker owner admission and its exact intrinsic provider closure', () =>
    Effect.gen(function* originalTenantWorkerOwner() {
      const moduleKey = 'worker.tenant-control';
      const tenantWorker = defineOutboxWorker(
        {
          consumerModuleKey: moduleKey,
          entrypoint: defineTenantModuleEntrypoint({
            access: 'background',
            authorization: { kind: 'owner_local_background' },
            entrypointKey: `${moduleKey}.project`,
            moduleKey,
            role: 'worker',
          }),
          leaseDurationMs: 1000,
          payloadSchema: Schema.Void,
          producerModuleKey: 'provider.tenant-control',
          retryPolicy: coreSystemOutboxWorkers[0].descriptor.retryPolicy,
          topic: 'provider.tenant-control.changed',
          workerKey: `${moduleKey}.project`,
        },
        () => Effect.void,
      );
      const fixture = makeNativeOutboxWorkerFixture([tenantWorker], {
        additionalModules: [{ moduleId: 'provider.tenant-control' }],
        requirements: {
          [moduleKey]: {
            coreCapabilities: [],
            intrinsic: [{ moduleId: 'provider.tenant-control', requiredOperations: [] }],
            operations: [],
            schemaVersion: '1',
          },
        },
      });
      const admission = yield* fixture.bind(
        [tenantWorker],
        prepareNativeOutboxClaimAdmission([tenantWorker], fixture.revision),
      );
      expect(admission.intrinsic.get(moduleKey)).toEqual(['provider.tenant-control']);
      expect(yield* isGenuineCoreOutboxWorker(tenantWorker)).toBe(false);
      const statements: string[] = [];
      const database = yield* makeTestDatabase((statement) =>
        Effect.sync(() => {
          statements.push(statement);
          if (statement.includes("current_setting('transaction_isolation')")) {
            return [{ isolation: 'read committed' }];
          }
          if (statement.includes('from "core"."application_composition_authority"')) {
            return [{ phase: 'active', revision: fixture.revision, subscriptionsJson: [], unexpired: true }];
          }
          if (statement.includes('from "core"."outbox_deliveries"') && !statement.includes('skip locked')) {
            expect(statement).toContain('inner join "core"."tenant_module_states"');
            return [{ deliveryId: 'delivery-1' }];
          }
          return [];
        }),
      );
      const repository = makeOutboxRepository(database, yield* Crypto.Crypto);
      yield* fixture.bind(
        [tenantWorker],
        repository.claimNext(
          [tenantWorker],
          'tenant-worker-control',
          DateTime.toDateUtc(DateTime.makeUnsafe(0)),
          fixture.revision,
        ),
      );
      const claim = statements.find((statement) => statement.includes('skip locked'));
      expect(claim).toContain('inner join "core"."tenant_module_states"');
      expect(claim).toContain('for update skip locked');
      expect(claim).toContain('exists (select 1 from "core"."tenant_module_states"');
      const recreated = defineOutboxWorker(tenantWorker.descriptor, () => Effect.void);
      const refusal = yield* fixture.bind(
        [tenantWorker],
        Effect.flip(prepareNativeOutboxClaimAdmission([recreated], fixture.revision)),
      );
      expect(refusal.code).toBe('module_operation_requirement_unavailable');
    }),
  );

  suite.effect('admits all shipped Core workers against Shell without a tenant module contract', () =>
    Effect.gen(function* admitCoreWorkerClaims() {
      const fixture = yield* runEntry();
      expect(fixture.outcome).toBe('succeeded');
      expect(fixture.failures).toEqual([]);
      expect(fixture.results[0]?.claimed).toBe(0);
      const claim = fixture.statements.find(({ sql }) => sql.includes('skip locked'));
      expect(claim?.sql).not.toContain('inner join "core"."tenant_module_states"');
      expect(claim?.sql).toContain('from "core"."tenants"');
      expect(claim?.sql).toContain('"core"."tenants"."status" = \'active\'');
      for (const worker of workers) {
        expect(claim?.params).toContain(worker.descriptor.workerKey);
      }
      const lock = fixture.statements.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock_shared'));
      const authority = fixture.statements.findIndex(({ sql }) =>
        sql.includes('from "core"."application_composition_authority"'),
      );
      const candidates = fixture.statements.findIndex(({ sql }) => sql.includes('skip locked'));
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(authority).toBeGreaterThan(lock);
      expect(candidates).toBeGreaterThan(authority);
    }),
  );

  suite.effect('an idle Core worker probes without a consumer installation and does not take the claim fence', () =>
    Effect.gen(function* idleCoreWorker() {
      const fixture = yield* runEntry({ due: false });
      expect(fixture.outcome).toBe('succeeded');
      expect(fixture.failures).toEqual([]);
      expect(fixture.statements.some(({ sql }) => sql.includes('from "core"."outbox_deliveries"'))).toBe(true);
      expect(fixture.statements.some(({ sql }) => sql.includes('skip locked'))).toBe(false);
      expect(fixture.statements.some(({ sql }) => sql.includes('pg_advisory_xact_lock_shared'))).toBe(false);
    }),
  );

  for (const worker of workers) {
    suite.effect(`executes and settles the genuine ${worker.descriptor.workerKey} handler after claim commit`, () =>
      Effect.gen(function* deliverCoreWorkerClaim() {
        const fixture = yield* runEntry({ selected: worker });
        expect(fixture.outcome).toBe('succeeded');
        expect(fixture.failures).toEqual([]);
        if (coreSystemOutboxWorkers.some((candidate) => candidate === worker)) {
          const [claim] = fixture.claims;
          expect(claim).toBeDefined();
          if (claim !== undefined) {
            yield* outboxWorkerTenantScope(claim);
          }
        }
        expect(fixture.completed).toBe(true);
        expect(fixture.results[0]).toMatchObject({ claimed: 1, failed: 0, succeeded: 1 });
        if (coreSystemOutboxWorkers.some((candidate) => candidate === worker)) {
          expect(fixture.reconciled).toHaveLength(1);
          expect(fixture.reconciled[0]).toMatchObject({
            authMethod: 'system',
            principalId: actorPrincipalId,
            tenantId,
          });
          expect(fixture.reconciled[0]?.authBindingId).toBeUndefined();
          expect(fixture.observed).toEqual([]);
        } else {
          expect(fixture.reconciled).toEqual([]);
          expect(fixture.observed).toHaveLength(1);
          expect(fixture.observed[0]).toMatchObject({
            actorPrincipalId,
            compositionRevision: composition.revision,
            originatorInvocationId: invocationId,
            tenantId,
            workerKey: worker.descriptor.workerKey,
          });
          expect(fixture.statements.some(({ sql }) => sql.includes("set_config('ontos.tenant_id'"))).toBe(true);
        }
      }),
    );
  }

  for (const authority of ['expired', 'revision-changed', 'unavailable'] as const) {
    suite.effect(`rejects ${authority} composition observed between process admission and native claiming`, () =>
      Effect.gen(function* rejectChangedClaimAuthority() {
        const fixture = yield* runEntry({ authority });
        expect(fixture.outcome).toBe('failed');
        expect(fixture.failures[0]?._tag).toBe('ApplicationCompositionAuthorityError');
        expect(fixture.statements).toEqual([]);
        expect(fixture.reconciled).toEqual([]);
        expect(fixture.observed).toEqual([]);
      }),
    );
  }

  for (const sqlAuthority of ['expired', 'sealed', 'stale'] as const) {
    suite.effect(`retains the real SQL publication fence for ${sqlAuthority} authority`, () =>
      Effect.gen(function* rejectSqlAuthority() {
        const fixture = yield* runEntry({ selected: coreSystemOutboxWorkers[0], sqlAuthority });
        expect(fixture.outcome).toBe('failed');
        expect(fixture.failures[0]?._tag).toBe('ApplicationCompositionAuthorityError');
        expect(fixture.statements.some(({ sql }) => /rollback/iu.test(sql))).toBe(true);
        expect(fixture.statements.some(({ sql }) => sql.includes('skip locked'))).toBe(false);
        expect(fixture.claimed).toBe(false);
        expect(fixture.reconciled).toEqual([]);
        expect(fixture.observed).toEqual([]);
      }),
    );
  }

  for (const deployment of [
    { ...composition.shell.deployment, appId: 'foreign-shell' },
    { ...composition.shell.deployment, buildMarker: 'foreign-build' },
  ]) {
    suite.effect(`rejects an unapproved Shell artifact ${deployment.appId}/${deployment.buildMarker}`, () =>
      Effect.gen(function* rejectForeignDeployment() {
        const fixture = yield* runEntry({ deployment });
        expect(fixture.outcome).toBe('failed');
        expect(fixture.statements).toEqual([]);
        expect(fixture.reconciled).toEqual([]);
        expect(fixture.observed).toEqual([]);
      }),
    );
  }

  suite.effect('rejects a replacement Core handler even when every published subscription byte is unchanged', () =>
    Effect.gen(function* rejectRecreatedCoreWorker() {
      const replacement = defineOutboxWorker(coreSystemOutboxWorkers[0].descriptor, () =>
        Effect.die('A replacement Core worker must never resolve'),
      );
      const fixture = yield* runEntry({
        registrations: [replacement, ...workers.filter((worker) => worker !== coreSystemOutboxWorkers[0])],
      });
      expect(fixture.outcome).toBe('failed');
      expect(fixture.failures[0]?._tag).toBe('ApplicationCompositionAuthorityError');
      expect(fixture.statements).toEqual([]);
      expect(fixture.reconciled).toEqual([]);
      expect(fixture.observed).toEqual([]);
    }),
  );
});
