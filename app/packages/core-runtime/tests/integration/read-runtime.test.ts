import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { DateTime, Deferred, Effect, Fiber, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeSystemPrincipalContextResolver, registerSystemWorkload } from '../../src/auth/system-principal-context.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { defineGlobalPolicy, denyPolicy } from '../../src/actions/policy.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { applicationCompositionAuthority, coreRelations, dataAccessEvents } from '../../src/db/schema.ts';
import {
  drainApplicationCompositionAuthority,
  lockApplicationCompositionPublication,
} from '../../src/modules/application-composition-authority.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { makeOperationalScopeRepository, makeOperationalScopeResolver } from '../../src/operations/context.ts';
import { OperationContextUnavailable } from '../../src/operations/errors.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { ReadHandlerUnavailable, ReadPermissionDenied, ReadPolicyDenied } from '../../src/reads/errors.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';

const readDatabaseClients = Effect.gen(function* acquireReadDatabaseClients() {
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const admin = yield* makeTestPgClient(connections.admin.connectionString);
  const runtime = yield* makeTestPgClient(connections.runtime.connectionString);
  return { admin, runtime };
});

it('standalone governed-read evidence permits no Action invocation and requires outcome fields', () => {
  const config = getTableConfig(dataAccessEvents);
  const column = (name: string) => config.columns.find((candidate) => candidate.name === name);
  expect(column('action_invocation_id')?.notNull).toBe(false);
  expect(column('outcome')?.notNull).toBe(true);
  expect(column('outcome_stage')?.notNull).toBe(true);
  expect(column('outcome_code')?.notNull).toBe(true);
});

it.live('commits live allowed evidence before releasing a governed read result', () =>
  Effect.gen(function* readRuntime1() {
    const { admin, runtime: runtimeClient } = yield* readDatabaseClients;
    const runtimeDatabase = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
    const tenantId = randomUUID();
    const principalId = randomUUID();
    const readKey = `core.shell.integration.${randomUUID()}`;
    const correlationId = randomUUID();
    const registration = defineRead(
      {
        accessKind: 'list',
        entrypoint: defineSystemModuleEntrypoint({
          access: 'read',
          authorization: {
            kind: 'context_permission',
            permission: 'module.access',
          },
          entrypointKey: readKey,
          moduleKey: 'core.shell',
          role: 'api',
        }),
        evidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: `${readKey}.v1`,
        },
        inputSchema: Schema.Struct({}),
        legalEntityScope: 'forbidden',
        owningModuleKey: 'core.shell',
        permissionTarget: 'module',
        policies: [],
        readKey,
        resultSchema: Schema.Array(Schema.String),
        schemaVersion: '1',
      },
      () => Effect.succeed({ evidence: { resultCount: 1 }, result: ['visible'] }),
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* readRuntime2() {
        yield* admin.unsafe('delete from core.data_access_events where tenant_id = $1', [tenantId]);
        yield* admin.unsafe('delete from core.principals where tenant_id = $1', [tenantId]);
        yield* admin.unsafe('delete from core.tenants where tenant_id = $1', [tenantId]);
      }).pipe(Effect.orDie),
    );

    yield* admin.unsafe(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Read runtime tenant', 'active', 'en')`,
      [tenantId, `read-runtime-${tenantId}`],
    );
    yield* admin.unsafe(
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, 'system', 'Read runtime principal', 'active')`,
      [principalId, tenantId],
    );
    const contextAccess = {
      legalEntities: () => Effect.succeed([]),
      modules: () => Effect.succeed([]),
      resources: () => Effect.succeed([]),
      tenants: () => Effect.succeed([]),
    };
    const principal = yield* makeSystemPrincipalContextResolver({
      executor: runtimeDatabase,
    }).resolve({
      principalId,
      registration: registerSystemWorkload({
        jobKey: 'read-runtime-integration',
      }),
      runReference: readKey,
      tenantId,
    });
    const runtime = makeReadRuntime(
      { executor: runtimeDatabase },
      openModuleEntrypointGateway,
      makeOperationalScopeResolver(makeOperationalScopeRepository({ executor: runtimeDatabase }), contextAccess),
      contextAccess,
    );
    expect(
      yield* runtime.runRead({
        input: {},
        principal,
        registration,
        transport: { correlationId },
      }),
    ).toEqual(['visible']);
    const evidence = yield* admin.unsafe<{
      action_invocation_id: null;
      outcome: string;
      outcome_code: string;
      query_hash: null;
      result_count: number;
    }>(
      `select action_invocation_id, outcome, outcome_code, query_hash, result_count from core.data_access_events where tenant_id = $1 and evidence_policy_key = $2`,
      [tenantId, `${readKey}.v1`],
    );
    expect(evidence).toEqual([
      {
        action_invocation_id: null,
        outcome: 'allowed',
        outcome_code: 'read_allowed',
        query_hash: null,
        result_count: 1,
      },
    ]);
  }),
);

const fixtureReadConnectionFailure = (cause: EffectDrizzleQueryError) =>
  Object.defineProperty(
    new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason: 'Unable to observe the native Read fixture connection',
    }),
    'cause',
    { value: cause },
  );

it.live('holds native Read authority through policies and commits denial evidence under active authority', () =>
  Effect.gen(function* readCompositionFence() {
    const { admin, runtime: runtimeClient } = yield* readDatabaseClients;
    const database = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
    const publisher = yield* makeTestDatabaseFromClient(admin, coreRelations);
    const tenantId = randomUUID();
    const principalId = randomUUID();
    const authBindingId = randomUUID();
    const revision = 'a'.repeat(64);
    const nextRevision = 'b'.repeat(64);
    const readKey = `core.shell.composition-read.${randomUUID()}`;
    const [clock] = yield* publisher.execute<{ readonly now: Date }>(sql`select clock_timestamp() as now`, 'objects');
    const now = DateTime.makeUnsafe(Option.getOrThrow(Option.fromNullishOr(clock)).now);
    const validUntil = DateTime.toDateUtc(DateTime.add(now, { hours: 1 }));
    yield* Effect.acquireRelease(
      publisher.transaction(
        Effect.fn(function* seedReadCompositionAuthority(transaction) {
          yield* lockApplicationCompositionPublication(transaction);
          const [previous] = yield* transaction.select().from(applicationCompositionAuthority);
          const values = {
            authorityKey: 'active',
            phase: 'active' as const,
            revision,
            subscriptionsJson: [],
            validUntil,
          };
          yield* transaction.insert(applicationCompositionAuthority).values(values).onConflictDoUpdate({
            set: values,
            target: applicationCompositionAuthority.authorityKey,
          });
          return previous;
        }),
      ),
      (previous) =>
        publisher
          .transaction(
            Effect.fn(function* restoreReadCompositionAuthority(transaction) {
              yield* lockApplicationCompositionPublication(transaction);
              yield* previous === undefined
                ? transaction.delete(applicationCompositionAuthority)
                : transaction.insert(applicationCompositionAuthority).values(previous).onConflictDoUpdate({
                    set: previous,
                    target: applicationCompositionAuthority.authorityKey,
                  });
            }),
          )
          .pipe(Effect.orDie),
    );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* removeReadFenceFixture() {
        yield* admin.unsafe('delete from core.data_access_events where tenant_id = $1', [tenantId]);
        yield* admin.unsafe('delete from core.principal_auth_bindings where tenant_id = $1', [tenantId]);
        yield* admin.unsafe('delete from core.principals where tenant_id = $1', [tenantId]);
        yield* admin.unsafe('delete from core.tenants where tenant_id = $1', [tenantId]);
      }).pipe(Effect.orDie),
    );
    yield* admin.unsafe(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Read fence tenant', 'active', 'en')`,
      [tenantId, `read-fence-${tenantId}`],
    );
    yield* admin.unsafe(
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, 'human', 'Read fence principal', 'active')`,
      [principalId, tenantId],
    );
    yield* admin.unsafe(
      `insert into core.principal_auth_bindings (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, provider_subject_id, subject_type, status) values ($1, $2, $3, 'read-fence.fixture', 'better_auth', $4, 'user', 'active')`,
      [authBindingId, tenantId, principalId, authBindingId],
    );
    const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId,
      authContextRef: `better-auth-session:${authBindingId}`,
      authMethod: 'session',
      principalId,
      tenantId,
    });
    const policyStarted = yield* Deferred.make<null>();
    const policyRelease = yield* Deferred.make<null>();
    const ownerBackend = yield* Deferred.make<number>();
    const drainStarted = yield* Deferred.make<null>();
    let factoryCalls = 0;
    let handlerCalls = 0;
    let policyCalls = 0;
    let currentOwnerBackend: number | undefined;
    let policyDenial = false;
    let ownerAuthorizationDecision: 'allowed' | 'denied' = 'allowed';
    const policy = defineGlobalPolicy<Readonly<Record<string, never>>>({
      evaluate: () =>
        Effect.gen(function* heldReadPolicy() {
          policyCalls += 1;
          const [backend] = yield* database
            .execute<{ readonly pid: number }>(sql`select pg_backend_pid() as pid`, 'objects')
            .pipe(Effect.orDie);
          currentOwnerBackend = Option.getOrThrow(Option.fromNullishOr(backend)).pid;
          yield* Deferred.succeed(ownerBackend, currentOwnerBackend);
          yield* Deferred.succeed(policyStarted, null);
          yield* Deferred.await(policyRelease);
          if (policyDenial) {
            return yield* denyPolicy('native-policy-denied', 'The owner Policy denies this admitted Read');
          }
          return yield* Effect.void;
        }),
      policyKey: `${readKey}.authority-held-policy.v1`,
    });
    const registration = defineRead(
      {
        accessKind: 'list',
        entrypoint: defineSystemModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'context_permission', permission: 'module.access' },
          entrypointKey: readKey,
          moduleKey: 'core.shell',
          role: 'api',
        }),
        evidencePolicy: { captureMode: 'metadata_only', policyKey: `${readKey}.v1` },
        inputSchema: Schema.Struct({}),
        legalEntityScope: 'forbidden',
        owningModuleKey: 'core.shell',
        permissionTarget: 'module',
        policies: [{ denialStatus: 422, policyKey: policy.policyKey }],
        readKey,
        resultSchema: Schema.Array(Schema.String),
        schemaVersion: '1',
      },
      () =>
        Effect.sync(() => {
          handlerCalls += 1;
          return { evidence: { resultCount: 1 }, result: ['visible'] };
        }),
      (transaction) =>
        Effect.gen(function* nativeReadFactory() {
          factoryCalls += 1;
          const [backend] = yield* transaction
            .select({ pid: sql<number>`pg_backend_pid()` })
            .from(applicationCompositionAuthority)
            .pipe(Effect.mapError(fixtureReadConnectionFailure));
          expect(Option.getOrThrow(Option.fromNullishOr(backend)).pid).toBe(currentOwnerBackend);
          return {};
        }),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
      undefined,
      [policy],
    );
    const contextAccess = {
      legalEntities: () => Effect.succeed([]),
      modules: () => Effect.succeed([]),
      resources: () => Effect.succeed([]),
      tenants: () => Effect.succeed([]),
    };
    const runtime = makeReadRuntime(
      { executor: database },
      openModuleEntrypointGateway,
      testOperationalScopeResolver,
      contextAccess,
      {
        ownerAuthorizationOverlay: {
          authorize: () => Effect.sync(() => ownerAuthorizationDecision),
        },
      },
    );
    const run = (signedRevision: string) =>
      runtime.runRead({
        input: {},
        principal: trustVerifiedGatewayPrincipalContext(principal, signedRevision),
        registration,
        transport: { correlationId: randomUUID() },
      });
    yield* Effect.scoped(
      Effect.gen(function* verifyReadCompositionFence() {
        const read = yield* run(revision).pipe(Effect.forkScoped);
        yield* Deferred.await(policyStarted);
        const ownerPid = yield* Deferred.await(ownerBackend);
        const drain = yield* publisher
          .transaction(
            Effect.fn(function* drainWithNativeReadInFlight(transaction) {
              yield* Deferred.succeed(drainStarted, null);
              yield* drainApplicationCompositionAuthority(transaction, revision);
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(drainStarted);
        let blocked = false;
        for (let observation = 0; observation < 1000 && !blocked; observation += 1) {
          const [status] = yield* publisher.execute<{ readonly blocked: boolean }>(
            sql`select exists (
              select 1 from pg_locks where locktype = 'advisory' and not granted
                and ${ownerPid} = any(pg_blocking_pids(pid))
            ) as blocked`,
            'objects',
          );
          blocked = status?.blocked === true;
        }
        expect(blocked).toBe(true);
        expect(drain.pollUnsafe()).toBeUndefined();
        expect(factoryCalls).toBe(0);
        expect(handlerCalls).toBe(0);
        yield* Deferred.succeed(policyRelease, null);
        expect(yield* Fiber.join(read)).toEqual(['visible']);
        yield* Fiber.join(drain);
      }).pipe(Effect.ensuring(Deferred.succeed(policyRelease, null))),
    );
    expect(Schema.is(ReadHandlerUnavailable)(yield* Effect.flip(run(revision)))).toBe(true);
    const authorityCases = [
      { phase: 'sealed' as const, revision, validUntil },
      { phase: 'migrated' as const, revision, validUntil },
      { phase: 'active' as const, revision: nextRevision, validUntil },
      { phase: 'active' as const, revision, validUntil: DateTime.toDateUtc(DateTime.subtract(now, { seconds: 1 })) },
    ];
    for (const values of authorityCases) {
      yield* publisher.transaction(
        Effect.fn(function* changeReadAuthorityFixture(transaction) {
          yield* lockApplicationCompositionPublication(transaction);
          yield* transaction
            .update(applicationCompositionAuthority)
            .set(values)
            .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
        }),
      );
      expect(Schema.is(ReadHandlerUnavailable)(yield* Effect.flip(run(revision)))).toBe(true);
    }
    expect(factoryCalls).toBe(1);
    expect(handlerCalls).toBe(1);
    expect(policyCalls).toBe(1);
    yield* publisher.transaction(
      Effect.fn(function* admitNextReadFixture(transaction) {
        yield* lockApplicationCompositionPublication(transaction);
        yield* transaction
          .update(applicationCompositionAuthority)
          .set({ phase: 'active', revision: nextRevision, validUntil })
          .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
      }),
    );
    expect(yield* run(nextRevision)).toEqual(['visible']);
    expect(factoryCalls).toBe(2);
    expect(handlerCalls).toBe(2);
    expect(policyCalls).toBe(2);
    policyDenial = true;
    expect(Schema.is(ReadPolicyDenied)(yield* Effect.flip(run(nextRevision)))).toBe(true);
    policyDenial = false;
    ownerAuthorizationDecision = 'denied';
    expect(Schema.is(ReadPermissionDenied)(yield* Effect.flip(run(nextRevision)))).toBe(true);
    expect(factoryCalls).toBe(2);
    expect(handlerCalls).toBe(2);
    expect(policyCalls).toBe(4);
    const evidence = yield* admin.unsafe<{ readonly outcome: string; readonly outcome_code: string }>(
      'select outcome, outcome_code from core.data_access_events where tenant_id = $1 order by occurred_at, data_access_event_id',
      [tenantId],
    );
    expect(evidence).toEqual([
      { outcome: 'allowed', outcome_code: 'read_allowed' },
      { outcome: 'allowed', outcome_code: 'read_allowed' },
      { outcome: 'denied', outcome_code: 'native-policy-denied' },
      { outcome: 'denied', outcome_code: 'read_permission_denied' },
    ]);
  }),
);
