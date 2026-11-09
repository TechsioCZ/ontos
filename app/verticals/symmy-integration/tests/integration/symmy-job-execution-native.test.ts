import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  ActionRuntime,
  ActiveApplicationCompositionService,
  GatewayAssertionRedemptionService,
  OutboxRepositoryLive,
  OutboxRuntime,
  OutboxRuntimeLive,
  ReadRuntime,
  SystemPrincipalContextResolverLive,
  TrustedPrincipalContextSchema,
  matchOutboxMessages,
} from '@app/core-runtime';
import type { OutboxCycleError, OutboxCycleResult } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  OutboxWorkerTenantScopeLive,
  defineOutboxWorkerEntry,
  extractOutboxWorkerSubscriptions,
} from '@app/core-runtime/outbox/worker';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
import type { SymmyOwnerEffectRef } from '@app/shared-contracts/symmy';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { assert, expect, it } from 'effect-rstest';
import {
  Clock,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { SymmyJobNotificationLive } from '../../src/services/symmy-job-notification.service.ts';
import { SymmyJobNotificationStoreLive } from '../../src/services/symmy-job-notification-store.ts';

import { AdmitSymmyJobPayloadSchema } from '../../shared/domain/symmy-job-admission.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { admitSymmyJobAction } from '../../src/actions/admit-symmy-job.action.ts';
import { symmyJobStatusRead } from '../../src/api/symmy-job-status.read.ts';
import { GatewayAssertionRedemptionLive } from '../../src/auth/gateway-assertion-redemption-runtime.ts';
import {
  SymmyEffectAdapters,
  SymmyJobWorkerError,
  SymmyJobWorkerLive,
  SymmyJobExecutionPersistenceLive,
  SymmyWorkerIdentity,
  makeSymmyWorkerIdentity,
} from '../../src/services/symmy-job-worker.service.ts';
import type { SymmyEffectAdapterInput } from '../../src/services/symmy-job-worker.service.ts';
import { outboxWorkers } from '../../src/workers/index.ts';
import {
  SymmyJobPrivacyDispatchGateway,
  symmyJobPrivacyDispatchGatewayService,
} from '../../src/services/symmy-job-privacy-dispatch-gateway.service.ts';
import {
  fixtureEffectAction,
  fixtureOperation,
  fixtureRecoveryRead,
  fixtureWorkload,
  makeNativeExecutionRegistration,
  makeNativeExecutionSnapshot,
  nativeGovernedRuntimes,
} from '../support/symmy-job-execution-native.fixture.ts';

const appRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const workers = outboxWorkers;
const subscriptions = extractOutboxWorkerSubscriptions(workers);
const encoded = (value: string) => Buffer.from(value).toString('base64url');
const signalCycleCompletion = (completed: Deferred.Deferred<OutboxCycleResult, OutboxCycleError>) =>
  Effect.onExit((exit: Exit.Exit<OutboxCycleResult, OutboxCycleError>) => Deferred.done(completed, exit));
// The host registers every actual own worker. This proof emits only business-job deliveries;
// Privacy dispatch still has its genuine transport dependency, rather than an omitted registration.
const privacyDispatchGatewayLive = Layer.effect(
  SymmyJobPrivacyDispatchGateway,
  Effect.gen(function* bindPrivacyDispatchTransport() {
    const crypto = yield* Crypto.Crypto;
    const httpClient = yield* HttpClient.HttpClient;
    const operations = yield* symmyJobPrivacyDispatchGatewayService();
    return SymmyJobPrivacyDispatchGateway.of({
      execute: (handoff, context) =>
        operations
          .execute(handoff, context)
          .pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.provideService(HttpClient.HttpClient, httpClient)),
      load: (handoff, context) =>
        operations
          .load(handoff, context)
          .pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.provideService(HttpClient.HttpClient, httpClient)),
      report: (outcome, context) =>
        operations
          .report(outcome, context)
          .pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.provideService(HttpClient.HttpClient, httpClient)),
    });
  }),
);
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
);

const migrateOwner = Effect.fn('SymmyExecutionNative.migrate')(function* migrate(databaseAdminUrl: string) {
  const migration = yield* ChildProcess.make(
    'mise',
    ['exec', '--', 'pnpm', '--filter', '@app/symmy-integration', 'db:migrate'],
    {
      cwd: appRoot,
      env: { APP_ENV_PATH: '/dev/null', DATABASE_ADMIN_URL: databaseAdminUrl },
      extendEnv: true,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [status] = yield* Effect.all(
    [migration.exitCode, Stream.runDrain(migration.stdout), Stream.runDrain(migration.stderr)],
    { concurrency: 3 },
  );
  expect(Number(status)).toBe(0);
});

const seedFixture = Effect.fn('SymmyExecutionNative.seed')(function* seed(admin: PgClient.PgClient) {
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const systemId = randomUUID();
  const authBindingId = randomUUID();
  const providerSubjectId = randomUUID();
  const slug = `native-symmy-${tenantId}`;
  yield* admin`insert into core.tenants (tenant_id, name, slug, status, default_locale)
    values (${tenantId}, 'Native Symmy worker fixture', ${slug}, 'active', 'en')`;
  yield* admin`insert into core.tenant_module_states (tenant_id, module_key, state) values (${tenantId}, 'integration.symmy', 'active')`;
  const accessScopeId = randomUUID();
  yield* admin`insert into core.access_scopes (scope_id, tenant_id, tenant_context_id)
    values (${accessScopeId}, ${tenantId}, ${tenantId})`;
  yield* admin`insert into core.access_scope_fences (scope_id, tenant_id, state, revision)
    values (${accessScopeId}, ${tenantId}, 'Ready', 1)`;
  yield* admin`insert into core.principals (principal_id, tenant_id, kind, status, display_name)
    values (${integrationId}, ${tenantId}, 'integration', 'active', 'Native fixture submitter'),
      (${systemId}, ${tenantId}, 'system', 'active', 'Native fixture worker')`;
  yield* admin`insert into core.principal_auth_bindings
    (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, subject_type, provider_subject_id, status)
    values (${authBindingId}, ${tenantId}, ${integrationId}, ${STAFF_AUTHENTICATION_NAMESPACE_ID}, 'better_auth', 'api_key', ${providerSubjectId}, 'active')`;
  for (const [principalId, workload] of [
    [integrationId, 'integration.symmy-admit'],
    [integrationId, 'integration.symmy-poll'],
    [systemId, 'integration.symmy.execute-symmy-job'],
    [systemId, fixtureWorkload],
  ] as const) {
    yield* admin`insert into core.access_workload_bindings (binding_id, incarnation, principal_id, tenant_id, workload_key, status)
      values (${randomUUID()}, ${randomUUID()}, ${principalId}, ${tenantId}, ${workload}, 'active')`;
  }
  yield* admin`create table symmy_integration.native_effect_receipts (effect_id uuid primary key, tenant_id uuid not null, reference jsonb not null)`;
  yield* admin`alter table symmy_integration.native_effect_receipts enable row level security`;
  yield* admin`alter table symmy_integration.native_effect_receipts force row level security`;
  yield* admin`create policy native_effect_scope on symmy_integration.native_effect_receipts
    using (tenant_id::text = current_setting('ontos.tenant_id', true))
    with check (tenant_id::text = current_setting('ontos.tenant_id', true))`;
  yield* admin`grant select, insert on symmy_integration.native_effect_receipts to ontos_runtime`;
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authBindingId,
    authContextRef: `better-auth-api-key:${providerSubjectId}`,
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'api_key',
    principalId: integrationId,
    tenantId,
  });
  return { integrationId, principal, systemId, tenantId };
});

it.live(
  'executes verified durable work and recovers the exact original effect after a committed response is lost',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeExecution() {
        const owner = makeNativeExecutionRegistration(workers);
        const snapshot = yield* makeNativeExecutionSnapshot(owner);
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'implementation-1118-symmy-job-admission',
        });
        yield* isolated.migrateCoreSchema();
        yield* migrateOwner(isolated.connections.admin.connectionString);
        yield* isolated.publishInitialComposition(snapshot);
        const admin = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) });
        const fixture = yield* seedFixture(admin);
        const redemptionClient = yield* PgClient.make({
          url: Redacted.make(isolated.connections.runtime.connectionString),
        });
        const redemption = Context.get(
          yield* Layer.build(
            GatewayAssertionRedemptionLive.pipe(Layer.provide(Layer.succeed(PgClient.PgClient, redemptionClient))),
          ),
          GatewayAssertionRedemptionService,
        );
        const pair = generateKeyPairSync('ed25519');
        const kid = 'native-symmy-worker';
        const issuer = 'https://native-symmy-worker.ontos.test';
        const jwks = JSON.stringify({
          keys: [{ ...pair.publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid, use: 'sig' }],
        });
        const verifier = bindGatewayPrincipalVerifier('symmy-integration', ultramodernApiMarker);
        const freshPrincipal = Effect.fn('SymmyExecutionNative.freshPrincipal')(function* freshPrincipal() {
          const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
          const body = encoded(
            JSON.stringify({
              aud: 'symmy-integration',
              compositionRevision: snapshot.composition.revision,
              exp: issuedAt + GATEWAY_ASSERTION_TTL_SECONDS,
              iat: issuedAt,
              iss: issuer,
              jti: randomUUID(),
              principal: fixture.principal,
              sub: fixture.integrationId,
              targetBuildMarker: ultramodernApiMarker.buildMarker,
              ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
            }),
          );
          const message = `${encoded(JSON.stringify({ alg: 'EdDSA', kid, typ: 'JWT' }))}.${body}`;
          const token = `Bearer ${message}.${sign(null, Buffer.from(message), pair.privateKey).toString('base64url')}`;
          return yield* verifier
            .verifyAndRedeem(Redacted.make(token), {
              environment: { ONTOS_GATEWAY_ISSUER: issuer, ONTOS_GATEWAY_PUBLIC_JWKS: jwks },
              redemption,
            })
            .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
        });
        const originalTarget = {
          moduleId: 'integration.symmy',
          resourceId: randomUUID(),
          resourceType: 'integration.symmy.fixture-target',
          tenantId: fixture.tenantId,
        };
        const plan = yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)({
          items: [
            {
              effects: [
                { effectKey: 'accepted-sibling', operation: fixtureOperation, originalTarget },
                { effectKey: 'lost-response', operation: fixtureOperation, originalTarget },
              ],
              itemKey: 'native-source-item',
              source: {
                entityKind: 'internal-fixture',
                issuerId: 'native-fixture-issuer',
                sourceNamespace: 'native-test',
                sourceRecordId: 'private-fixture-record',
              },
            },
          ],
        });
        yield* admin`insert into symmy_integration.job_routes
    (tenant_id, principal_id, active, fixture_ids, fixture_plan, mapping_version, route_key, route_revision)
    values (${fixture.tenantId}, ${fixture.integrationId}, true, array['native-execution'], ${JSON.stringify(plan)}::jsonb, 'original-map-v1', 'productsBatch', 'original-route-v1')`;

        const runtimeLayer = nativeGovernedRuntimes(isolated.connections.runtime, snapshot, owner.registration);
        const admit = (idempotencyKey: string, fixtureId = 'native-execution') =>
          Effect.gen(function* admitJob() {
            const runtime = yield* ActionRuntime;
            return yield* runtime.runAction({
              payload: yield* Schema.decodeUnknownEffect(AdmitSymmyJobPayloadSchema)({
                fixtureId,
                idempotencyKey,
                routeKey: 'productsBatch',
              }),
              principal: yield* freshPrincipal(),
              registration: admitSymmyJobAction,
              transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
            });
          }).pipe(Effect.provide(runtimeLayer), Effect.scoped);
        const poll = (jobId: string) =>
          Effect.gen(function* pollJob() {
            const runtime = yield* ReadRuntime;
            return yield* runtime.runRead({
              input: { jobId },
              principal: yield* freshPrincipal(),
              registration: symmyJobStatusRead,
              transport: { correlationId: randomUUID() },
            });
          }).pipe(Effect.provide(runtimeLayer), Effect.scoped);

        expect(Exit.isFailure(yield* admit('refused', 'missing-fixture').pipe(Effect.exit))).toBe(true);
        const receipt = yield* admit('native-execution-1');
        expect(yield* admit('native-execution-1')).toEqual(receipt);
        const [admission] = yield* admin<{ readonly jobs: number; readonly messages: number }>`select
    (select count(*)::integer from symmy_integration.import_jobs) as jobs,
    (select count(*)::integer from core.outbox_messages) as messages`;
        expect(admission).toEqual({ jobs: 1, messages: 1 });
        expect((yield* isolated.composition.observe()).pendingDurableWork).toHaveLength(1);

        const calls: { readonly mode: 'execute' | 'recover'; readonly ref: SymmyOwnerEffectRef }[] = [];
        let recoveryUnavailable = false;
        let loseBeforeCommit = false;
        // Faults affect only the internal fixture transport. The Action transaction has already committed
        // before its response is discarded; neither the worker nor recovery reads this local control.
        const adapters = (
          loseResponse: boolean,
          governed: Context.Context<Layer.Success<ReturnType<typeof nativeGovernedRuntimes>>>,
        ) => ({
          adapters: [
            {
              execute: Effect.fn('SymmyExecutionNative.execute')(function* execute({
                effect,
                principal,
              }: SymmyEffectAdapterInput) {
                calls.push({ mode: 'execute', ref: effect.ref });
                if (loseBeforeCommit && effect.effectKey === 'lost-response') {
                  return {
                    effectId: effect.ref.effectId,
                    owner: effect.ref.operation.moduleId,
                    status: 'indeterminate' as const,
                  };
                }
                const outcome = yield* Context.get(governed, ActionRuntime)
                  .runAction({
                    payload: effect.ref,
                    principal,
                    registration: fixtureEffectAction,
                    transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
                  })
                  .pipe(
                    Effect.provideContext(governed),
                    Effect.mapError(
                      () =>
                        new SymmyJobWorkerError({
                          code: 'symmy_job_worker_unavailable',
                          reason: 'The internal governed fixture Action is unavailable',
                        }),
                    ),
                  );
                return loseResponse && effect.effectKey === 'lost-response'
                  ? {
                      effectId: effect.ref.effectId,
                      owner: effect.ref.operation.moduleId,
                      status: 'indeterminate' as const,
                    }
                  : outcome;
              }),
              operation: fixtureOperation,
              recover: Effect.fn('SymmyExecutionNative.recover')(function* recover({
                effect,
                principal,
              }: SymmyEffectAdapterInput) {
                calls.push({ mode: 'recover', ref: effect.ref });
                if (recoveryUnavailable) {
                  return { status: 'unavailable' as const };
                }
                const result = yield* Context.get(governed, ReadRuntime)
                  .runRead({
                    input: effect.ref,
                    principal,
                    registration: fixtureRecoveryRead,
                    transport: { correlationId: randomUUID() },
                  })
                  .pipe(
                    Effect.provideContext(governed),
                    Effect.mapError(
                      () =>
                        new SymmyJobWorkerError({
                          code: 'symmy_job_worker_unavailable',
                          reason: 'The internal governed fixture Read is unavailable',
                        }),
                    ),
                  );
                return Option.isNone(result.outcome)
                  ? { status: 'not_committed' as const }
                  : { outcome: result.outcome.value, status: 'settled' as const };
              }),
            },
          ],
        });

        let cycleNumber = 0;
        // Every invocation creates fresh pools and worker services, then discards them. The native Core
        // entry verifies its release and database claim before invoking the actual registered worker.
        const deliver = (loseResponse: boolean, systemPrincipalId = fixture.systemId) =>
          Effect.scoped(
            Effect.gen(function* deliverCycle() {
              const runtime = yield* PgClient.make({
                url: Redacted.make(isolated.connections.runtime.connectionString),
              });
              const executor = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, runtime));
              const database = { executor };
              const governed = yield* Layer.build(runtimeLayer);
              const identity = yield* makeSymmyWorkerIdentity(systemPrincipalId).pipe(
                Effect.provide(SystemPrincipalContextResolverLive),
                Effect.provideService(CoreDatabase, database),
              );
              const workerLayer = SymmyJobWorkerLive.pipe(
                Layer.provideMerge(SymmyJobExecutionPersistenceLive),
                Layer.provideMerge(Layer.succeed(SymmyEffectAdapters, adapters(loseResponse, governed))),
                Layer.provideMerge(Layer.succeed(SymmyWorkerIdentity, identity)),
                Layer.provideMerge(SymmyJobNotificationLive),
                Layer.provideMerge(SymmyJobNotificationStoreLive),
                Layer.provideMerge(privacyDispatchGatewayLive),
                Layer.provideMerge(OutboxWorkerTenantScopeLive),
                Layer.provideMerge(FetchHttpClient.layer),
                Layer.provideMerge(
                  Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
                ),
                Layer.provideMerge(NodeCrypto.layer),
              );
              const workerServices = yield* Layer.build(
                workerLayer.pipe(Layer.provideMerge(Layer.succeed(CoreDatabase, database))),
              );
              const outboxLayer = OutboxRuntimeLive.pipe(
                Layer.provide(OutboxRepositoryLive),
                Layer.provide(Layer.mergeAll(Layer.succeed(CoreDatabase, database), NodeCrypto.layer)),
              );
              const outbox = Context.get(yield* Layer.build(outboxLayer), OutboxRuntime);
              yield* matchOutboxMessages({ compositionRevision: snapshot.composition.revision }).pipe(
                Effect.provideService(OutboxRuntime, outbox),
              );
              const completed = yield* Deferred.make<OutboxCycleResult, OutboxCycleError>();
              cycleNumber += 1;
              const claimOwner = `symmy-native-${cycleNumber}`;
              const now = DateTime.toDateUtc(
                DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + cycleNumber * 3_600_000),
              );
              const entry = defineOutboxWorkerEntry({
                claimOwnerPrefix: claimOwner,
                expectedDeployment: ultramodernApiMarker,
                layer: Layer.mergeAll(
                  Layer.succeedContext(workerServices),
                  Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
                  Layer.succeed(OutboxRuntime, {
                    ...outbox,
                    runCycle: () =>
                      outbox
                        .runCycle({
                          claimOwner,
                          compositionRevision: snapshot.composition.revision,
                          maxDeliveries: 1,
                          now,
                          registrations: workers,
                          subscriptions,
                        })
                        .pipe(Effect.provideContext(workerServices), signalCycleCompletion(completed)),
                  }),
                ),
                ownerRegistration: owner.registration,
                registrations: workers,
                subscriptions,
              });
              return yield* Deferred.await(completed).pipe(
                Effect.raceFirst(
                  entry
                    .runLoop({ config: { claimOwner, maxDeliveries: 1, pollIntervalMs: 1000 } })
                    .pipe(Effect.andThen(Effect.never)),
                ),
              );
            }),
          );

        expect(yield* deliver(true)).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
        const [committed] = yield* admin<{ readonly invocations: number; readonly receipts: number }>`select
          (select count(*)::integer from symmy_integration.native_effect_receipts) as receipts,
          (select count(*)::integer from core.action_invocations where action_key = 'integration.symmy.fixture-effect' and status = 'succeeded') as invocations`;
        expect(committed).toEqual({ invocations: 2, receipts: 2 });
        const acceptedCalls = calls.filter(({ mode }) => mode === 'execute');
        expect(acceptedCalls).toHaveLength(2);
        expect((yield* isolated.composition.observe()).pendingDurableWork).toHaveLength(1);
        const uncertain = yield* poll(receipt.jobId);
        expect(uncertain).toMatchObject({ phase: 'indeterminate' });
        expect(JSON.stringify(uncertain)).not.toContain('private-fixture-record');
        expect(JSON.stringify(uncertain)).not.toContain(originalTarget.resourceId);

        // Operator configuration drift must not change the owner operation, target or mapping of recovery.
        const replacementPlan = {
          items: plan.items.map((item) => ({
            ...item,
            effects: item.effects.map((effect) => ({
              ...effect,
              operation: { ...effect.operation, schemaVersion: '2' },
              originalTarget: { ...originalTarget, resourceId: randomUUID() },
            })),
          })),
        };
        yield* admin`update symmy_integration.job_routes set mapping_version = 'replacement-map-v2', route_revision = 'replacement-route-v2', fixture_plan = ${JSON.stringify(replacementPlan)}::jsonb
    where tenant_id = ${fixture.tenantId}`;
        recoveryUnavailable = true;
        expect(yield* deliver(false)).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
        expect(yield* poll(receipt.jobId)).toMatchObject({ phase: 'indeterminate' });
        recoveryUnavailable = false;
        expect(yield* deliver(false)).toMatchObject({ claimed: 1, succeeded: 1 });
        expect(calls.filter(({ mode }) => mode === 'execute')).toEqual(acceptedCalls);
        const recoveryCalls = calls.filter(({ mode }) => mode === 'recover');
        assert.isOk(recoveryCalls.length > 0);
        for (const call of recoveryCalls) {
          expect(call.ref).toEqual(acceptedCalls.find(({ ref }) => ref.effectId === call.ref.effectId)?.ref);
          expect(call.ref).toMatchObject({
            mappingVersion: 'original-map-v1',
            originalTarget,
            routeRevision: 'original-route-v1',
          });
        }
        expect(yield* poll(receipt.jobId)).toMatchObject({ phase: 'completed_all' });
        expect((yield* isolated.composition.observe()).pendingDurableWork).toEqual([]);
        expect(yield* deliver(false)).toMatchObject({ claimed: 0, succeeded: 0 });
        // A new occurrence pins new IDs, even for the same source record. Missing original acceptance
        // can be retried only after both exact recovery and current admission authority agree.
        yield* admin`update symmy_integration.job_routes set fixture_plan = ${JSON.stringify(plan)}::jsonb where tenant_id = ${fixture.tenantId}`;
        const second = yield* admit('native-execution-2');
        yield* admin`update core.access_workload_bindings set status = 'revoked', revoked_at = clock_timestamp()
    where principal_id = ${fixture.systemId} and workload_key = 'integration.symmy.execute-symmy-job'`;
        const beforeRevokedWorker = calls.length;
        expect(yield* deliver(false)).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
        expect(calls).toHaveLength(beforeRevokedWorker);
        yield* admin`update core.access_workload_bindings set status = 'active', revoked_at = null
    where principal_id = ${fixture.systemId} and workload_key = 'integration.symmy.execute-symmy-job'`;
        // The fixture owner has its own protected gate, independent of worker admission.
        yield* admin`update core.access_workload_bindings set status = 'revoked', revoked_at = clock_timestamp()
    where principal_id = ${fixture.systemId} and workload_key = ${fixtureWorkload}`;
        expect(yield* deliver(false)).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
        const [afterDeniedOwner] = yield* admin<{
          readonly count: number;
        }>`select count(*)::integer as count from symmy_integration.native_effect_receipts`;
        expect(afterDeniedOwner?.count).toBe(2);
        yield* admin`update core.access_workload_bindings set status = 'active', revoked_at = null
    where principal_id = ${fixture.systemId} and workload_key = ${fixtureWorkload}`;
        loseBeforeCommit = true;
        expect(yield* deliver(false)).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
        const [beforeAbsentRetry] = yield* admin<{
          readonly count: number;
        }>`select count(*)::integer as count from symmy_integration.native_effect_receipts`;
        expect(beforeAbsentRetry?.count).toBe(3);
        const attemptsBeforeRevocation = calls.filter(({ mode }) => mode === 'execute').length;
        yield* admin`update core.access_workload_bindings set status = 'revoked', revoked_at = clock_timestamp()
    where principal_id = ${fixture.integrationId} and workload_key = 'integration.symmy-admit'`;
        loseBeforeCommit = false;
        expect(yield* deliver(false)).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
        expect(calls.filter(({ mode }) => mode === 'execute')).toHaveLength(attemptsBeforeRevocation);
        expect(yield* poll(second.jobId)).toMatchObject({ phase: 'indeterminate' });
        yield* admin`update core.access_workload_bindings set status = 'active', revoked_at = null
    where principal_id = ${fixture.integrationId} and workload_key = 'integration.symmy-admit'`;
        yield* admin`update core.principals set kind = 'service' where principal_id = ${fixture.integrationId}`;
        expect(yield* deliver(false)).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
        expect(calls.filter(({ mode }) => mode === 'execute')).toHaveLength(attemptsBeforeRevocation);
        yield* admin`update core.principals set kind = 'integration', status = 'disabled' where principal_id = ${fixture.integrationId}`;
        expect(yield* deliver(false)).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
        expect(calls.filter(({ mode }) => mode === 'execute')).toHaveLength(attemptsBeforeRevocation);
        yield* admin`update core.principals set status = 'active' where principal_id = ${fixture.integrationId}`;
        const foreignTenantId = randomUUID();
        const foreignSystemId = randomUUID();
        const foreignSlug = `foreign-symmy-${foreignTenantId}`;
        yield* admin`insert into core.tenants (tenant_id, name, slug, status, default_locale)
          values (${foreignTenantId}, 'Foreign native worker fixture', ${foreignSlug}, 'active', 'en')`;
        yield* admin`insert into core.principals (principal_id, tenant_id, kind, status, display_name)
          values (${foreignSystemId}, ${foreignTenantId}, 'system', 'active', 'Foreign native system principal')`;
        yield* admin`insert into core.access_workload_bindings (binding_id, incarnation, principal_id, tenant_id, workload_key, status)
          values (${randomUUID()}, ${randomUUID()}, ${foreignSystemId}, ${foreignTenantId}, 'integration.symmy.execute-symmy-job', 'active')`;
        const beforeForeignWorker = calls.length;
        expect(yield* deliver(false, foreignSystemId)).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
        expect(calls).toHaveLength(beforeForeignWorker);
        expect(yield* deliver(false)).toMatchObject({ claimed: 1, succeeded: 1 });
        expect(yield* poll(second.jobId)).toMatchObject({ phase: 'completed_all' });
        const [allCommitted] = yield* admin<{
          readonly count: number;
        }>`select count(*)::integer as count from symmy_integration.native_effect_receipts`;
        expect(allCommitted?.count).toBe(4);
        expect((yield* isolated.composition.observe()).pendingDurableWork).toEqual([]);
        const third = yield* admit('native-execution-3');
        yield* admin`update symmy_integration.job_routes set active = false where tenant_id = ${fixture.tenantId}`;
        const beforeInactiveRoute = calls.length;
        expect(yield* deliver(false)).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
        expect(calls).toHaveLength(beforeInactiveRoute);
        expect(yield* poll(third.jobId)).toMatchObject({ phase: 'blocked' });
        const [inactiveRoute] = yield* admin<{
          readonly count: number;
        }>`select count(*)::integer as count from symmy_integration.native_effect_receipts`;
        expect(inactiveRoute?.count).toBe(4);
        yield* admin`update symmy_integration.job_routes set active = true where tenant_id = ${fixture.tenantId}`;
        expect(yield* deliver(false)).toMatchObject({ claimed: 1, succeeded: 1 });
        expect(yield* poll(third.jobId)).toMatchObject({ phase: 'completed_all' });
        const [afterReactivation] = yield* admin<{
          readonly count: number;
        }>`select count(*)::integer as count from symmy_integration.native_effect_receipts`;
        expect(afterReactivation?.count).toBe(6);
        expect((yield* isolated.composition.observe()).pendingDurableWork).toEqual([]);
      }),
    ).pipe(Effect.provide(services)),
  180_000,
);
