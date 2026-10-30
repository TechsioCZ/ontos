import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  BusinessPermissionRelationshipMutation,
  BusinessPermissionRelationshipMutationLive,
  GatewayAssertionReplayError,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { decodeSupportedGatewayContextClaims } from '@app/shared-contracts';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Reactivity } from 'effect/reactivity';
import { FetchHttpClient } from 'effect/http';
import { decodeJwt, SignJWT } from 'jose';
import { defineRelations, eq, sql } from 'drizzle-orm';
import {
  Config,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Redacted,
  Result,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it, rs } from 'effect-rstest';

import { makeGatewayAssertionRedemption } from '../../src/auth/gateway-assertion-redemption-runtime.ts';
import { gatewayAssertionRedemptions } from '../../src/database/schema.ts';
import defaultApi from '../../api/index.ts';
import { executeCounterpartyCommerceAccessListWithAuthorization } from '../../src/api/counterparty-commerce-access-list-client.ts';
import { CounterpartyCommerceAccessListRequestSchema } from '../../shared/apis/counterparty-commerce-access-list.ts';
import { makeEnrollmentAcceptanceFixture } from '../support/enrollment-acceptance-fixture.ts';
import {
  makeCounterpartyInvitationRealm,
  issueCounterpartyAccessInvitation,
  prepareCounterpartyInvitationClaimPayload,
  countCounterpartyInvitationClaims,
} from '../support/counterparty-invitation-acceptance.ts';
import { makeCapturingCounterpartyInvitationProofDelivery } from '../support/counterparty-invitation-proof-capture.ts';
import { enrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import {
  makeAcceptanceGatewayIssuer,
  issueAcceptanceGatewayAssertion,
} from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import {
  GatewayRedemptionRestartCommandSchema,
  GatewayRedemptionRestartResponseSchema,
  GatewayRedemptionRestartStageSchema,
  writeGatewayRedemptionRestartResponse,
  closeGatewayRedemptionRestartOutput,
} from '../support/gateway-redemption-restart-child.ts';

const issuer = 'https://commerce_customer_context-gateway-postgres.ontos.test';
const audience = 'commerce_customer_context-gateway-postgres';
const jti = '79700000-0000-4000-8000-000000000001';
const relations = defineRelations({ gatewayAssertionRedemptions });
const DatabaseEpochRowSchema = Schema.Struct({ nowEpochSeconds: Schema.FiniteFromString });

// These owner-specific pools use only the public configuration and native driver. A separate
// resource scope keeps the native client usable until every fixture cleanup has finished.
const redemptionClients = Effect.gen(function* acquireRedemptionClients() {
  const configuration = yield* loadDatabaseConnectionPair();
  const resources = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(resources, exit));
  const open = (connectionString: string) =>
    Layer.buildWithScope(
      PgClient.layerFrom(PgClient.make({ url: Redacted.make(connectionString) })).pipe(Layer.provide(Reactivity.layer)),
      resources,
    ).pipe(Effect.map((context) => Context.get(context, PgClient.PgClient)));
  const admin = yield* open(configuration.admin.connectionString);
  const runtime = yield* open(configuration.runtime.connectionString);
  return { admin, runtime };
});

interface GrantRow {
  readonly delete_allowed: boolean;
  readonly insert_allowed: boolean;
  readonly rls_enabled: boolean;
  readonly select_allowed: boolean;
  readonly update_allowed: boolean;
}

it.live('durably rejects replay through the exact global least-privilege table', () =>
  Effect.scoped(
    Effect.gen(function* gatewayAssertionPostgresProof() {
      const { admin: adminClient, runtime: runtimeClient } = yield* redemptionClients;
      const executor = yield* makeWithDefaults({ relations }).pipe(
        Effect.provideService(PgClient.PgClient, runtimeClient),
      );
      const redemption = makeGatewayAssertionRedemption(executor);
      const cleanup = adminClient.unsafe(
        'delete from commerce_customer_context.gateway_assertion_redemptions where issuer = $1',
        [issuer],
      );
      yield* cleanup;
      yield* Effect.addFinalizer(() => cleanup.pipe(Effect.orDie));

      const [databaseEpochRow] = yield* adminClient.unsafe(
        `select floor(extract(epoch from clock_timestamp()))::text as "nowEpochSeconds"`,
      );
      const { nowEpochSeconds } = yield* Schema.decodeUnknownEffect(DatabaseEpochRowSchema)(databaseEpochRow);
      const assertion = {
        audience,
        expiresAtEpochSeconds: nowEpochSeconds + 300,
        issuer,
        jti,
      };
      const attempts = yield* Effect.all(
        [redemption.consume(assertion).pipe(Effect.result), redemption.consume(assertion).pipe(Effect.result)],
        { concurrency: 'unbounded' },
      );
      expect(attempts.filter(Result.isSuccess)).toHaveLength(1);
      expect(attempts.filter(Result.isFailure)).toHaveLength(1);
      for (const attempt of attempts) {
        if (Result.isFailure(attempt)) {
          expect(Schema.is(GatewayAssertionReplayError)(attempt.failure)).toBe(true);
        }
      }
      // A different native pool proves cross-instance persistence; the separate-process case below proves restart.
      const secondClients = yield* redemptionClients;
      const restartedExecutor = yield* makeWithDefaults({ relations }).pipe(
        Effect.provideService(PgClient.PgClient, secondClients.runtime),
      );
      const replay = yield* makeGatewayAssertionRedemption(restartedExecutor).consume(assertion).pipe(Effect.flip);
      expect(Schema.is(GatewayAssertionReplayError)(replay)).toBe(true);

      yield* redemption.consume({ ...assertion, audience: `${audience}-other` });

      const [grant] = yield* adminClient.unsafe<GrantRow>(
        `select
           has_table_privilege('ontos_runtime', 'commerce_customer_context.gateway_assertion_redemptions', 'SELECT') as select_allowed,
           has_table_privilege('ontos_runtime', 'commerce_customer_context.gateway_assertion_redemptions', 'INSERT') as insert_allowed,
           has_table_privilege('ontos_runtime', 'commerce_customer_context.gateway_assertion_redemptions', 'UPDATE') as update_allowed,
           has_table_privilege('ontos_runtime', 'commerce_customer_context.gateway_assertion_redemptions', 'DELETE') as delete_allowed,
           relation.relrowsecurity as rls_enabled
         from pg_catalog.pg_class as relation
         join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = 'commerce_customer_context' and relation.relname = 'gateway_assertion_redemptions'`,
      );
      expect(grant).toEqual({
        delete_allowed: true,
        insert_allowed: true,
        rls_enabled: false,
        select_allowed: true,
        update_allowed: false,
      });
    }),
  ),
);

// Exercise the exported deployment root, with only its external configuration/source transport
// supplied by the fixture. No receiving, redemption, Core, or owner layer is replaced.
it.live('serves an authorized owner Read through the unchanged default API and rejects replay', () =>
  Effect.scoped(
    Effect.gen(function* defaultReceivingProof() {
      const snapshot = yield* enrollmentApplicationCompositionSnapshot;
      const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId: randomUUID() }, snapshot.composition.revision);
      const realm = yield* makeCounterpartyInvitationRealm(fixture, {
        recipientActionKeys: [],
        storefrontActionKeys: [],
      });
      const gateway = yield* makeAcceptanceGatewayIssuer('https://ccc-default-redemption.ontos.test', 'ccc-redemption');
      rs.stubEnv('ONTOS_GATEWAY_ISSUER', gateway.issuer);
      rs.stubEnv('ONTOS_GATEWAY_PUBLIC_JWKS', JSON.stringify({ keys: [gateway.publicJwk] }));
      rs.stubEnv('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL', 'https://composition.ccc-redemption.test/active');
      rs.stubGlobal('fetch', async () => Response.json(snapshot));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rs.unstubAllGlobals();
          rs.unstubAllEnvs();
        }),
      );
      const mutationContext = yield* Layer.build(BusinessPermissionRelationshipMutationLive);
      const mutation = Context.get(mutationContext, BusinessPermissionRelationshipMutation);
      const permission = {
        permission: 'counterparty.access.read' as const,
        principal: { principalId: realm.recipientPrincipalId, tenantId: realm.tenantId },
        target: {
          counterpartyId: realm.counterpartyResourceId,
          kind: 'counterparty' as const,
          legalEntityId: realm.legalEntityId,
          tenantId: realm.tenantId,
        },
      };
      yield* mutation.mutate({ ...permission, operation: 'grant' });
      yield* Effect.addFinalizer(() => mutation.mutate({ ...permission, operation: 'revoke' }).pipe(Effect.orDie));
      yield* fixture.admin.execute(
        sql`insert into commerce_customer_context.counterparty_commerce_access_grants
      (tenant_id, legal_entity_id, counterparty_purchasing_profile_id, lifecycle, permission_code, principal_id, revision, action_invocation_id, actor_principal_id)
      values (${realm.tenantId}::uuid, ${realm.legalEntityId}::uuid, ${realm.counterpartyPurchasingProfileId}::uuid, 'ACTIVE', 'counterparty.access.read', ${realm.recipientPrincipalId}::uuid, 1, ${randomUUID()}::uuid, ${realm.inviterPrincipalId}::uuid)`,
        'objects',
      );
      const runtime = defaultApi.createHandler();
      yield* Effect.addFinalizer(() => Effect.promise(async () => await runtime.dispose()));
      const principal = {
        authBindingId: realm.recipientAuthBindingId,
        authContextRef: `portal-session:${realm.recipientPrincipalId}`,
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        authMethod: 'session' as const,
        legalEntityId: realm.legalEntityId,
        principalId: realm.recipientPrincipalId,
        tenantId: realm.tenantId,
      };
      const fresh = (targetAudience = 'commerce-customer-context') =>
        issueAcceptanceGatewayAssertion(fixture.admin, gateway, targetAudience, principal);
      const request = (assertion: string) =>
        new Request('http://localhost:3020/reads/counterparty-commerce-access-list', {
          body: JSON.stringify({
            counterpartyRef: {
              moduleId: 'party.registry',
              resourceId: realm.counterpartyResourceId,
              resourceType: 'party.registry.counterparty',
              tenantId: realm.tenantId,
            },
            scope: { kind: 'counterparty' },
          }),
          headers: {
            authorization: `Bearer ${assertion}`,
            'content-type': 'application/json',
            'x-correlation-id': `redemption-${randomUUID()}`,
          },
          method: 'POST',
        });
      const invoke = (assertion: string) => Effect.promise(async () => await runtime.handler(request(assertion)));
      const assertion = yield* fresh();
      const first = yield* invoke(assertion);
      expect({
        body: yield* Effect.promise(async () => await first.clone().json()),
        status: first.status,
      }).toMatchObject({ status: 200 });
      const body = yield* Effect.promise(async () => await first.json());
      expect(body).toMatchObject({ grants: expect.any(Array) });
      const publicInput = yield* Schema.decodeUnknownEffect(CounterpartyCommerceAccessListRequestSchema)({
        counterpartyRef: {
          moduleId: 'party.registry',
          resourceId: realm.counterpartyResourceId,
          resourceType: 'party.registry.counterparty',
          tenantId: realm.tenantId,
        },
        scope: { kind: 'counterparty' },
      });
      const throughPublicClient = yield* executeCounterpartyCommerceAccessListWithAuthorization(
        publicInput,
        `Bearer ${yield* fresh()}`,
        `ccc-public-client-${randomUUID()}`,
        { baseUrl: 'http://localhost:3020', compositionRevision: snapshot.composition.revision },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, (input, init) => runtime.handler(new Request(input, init))));
      expect(throughPublicClient).toMatchObject({ grants: expect.any(Array) });

      expect((yield* invoke(assertion)).status).toBe(401);
      expect((yield* invoke(yield* fresh('another-audience'))).status).toBe(401);
      expect((yield* invoke('malformed')).status).toBe(401);
      const resign = (
        credential: string,
        changes: {
          readonly exp?: number;
          readonly iat?: number;
          readonly iss?: string;
          readonly principal?: typeof principal;
        },
      ) =>
        Effect.gen(function* signInvalidFixtureClaims() {
          const claims = yield* decodeSupportedGatewayContextClaims(decodeJwt(credential));
          return yield* Effect.promise(
            async () =>
              await new SignJWT({ ...claims, ...changes, jti: randomUUID() })
                .setProtectedHeader({ alg: 'EdDSA', kid: gateway.keyId, typ: 'JWT' })
                .sign(gateway.privateKey),
          );
        });
      expect((yield* invoke(yield* resign(yield* fresh(), { exp: 300, iat: 0 }))).status).toBe(401);
      expect((yield* invoke(yield* resign(yield* fresh(), { iss: 'https://foreign-gateway.ontos.test' }))).status).toBe(
        401,
      );
      const invalidTenant = yield* resign(yield* fresh(), { principal: { ...principal, tenantId: randomUUID() } });
      expect((yield* invoke(invalidTenant)).status).toBe(403);
      const invalidBinding = yield* resign(yield* fresh(), {
        principal: { ...principal, authBindingId: randomUUID() },
      });
      expect((yield* invoke(invalidBinding)).status).toBe(401);

      // Real native lock contention makes only the redemption store unavailable. No service is
      // substituted, and the unconsumed credential must work when the database lock is released.
      const native = yield* redemptionClients;
      const locked = yield* Deferred.make<true>();
      const release = yield* Deferred.make<true>();
      const lockFiber = yield* native.admin
        .withTransaction(
          Effect.gen(function* holdIngressStore() {
            yield* native.admin.unsafe(
              'lock table commerce_customer_context.gateway_assertion_redemptions in access exclusive mode',
            );
            yield* Deferred.succeed(locked, true);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Effect.addFinalizer(() => Deferred.succeed(release, true).pipe(Effect.asVoid));
      yield* Deferred.await(locked);
      const duringOutage = yield* fresh();
      const unavailable = yield* invoke(duringOutage);
      expect(unavailable.status).toBe(503);
      expect(yield* Effect.promise(async () => await unavailable.json())).toMatchObject({ retryable: true });
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(lockFiber);
      expect((yield* invoke(duringOutage)).status).toBe(200);

      // Valid durable redemption never grants the explicit Action executor relationship.
      const delivery = makeCapturingCounterpartyInvitationProofDelivery();
      const invitation = yield* issueCounterpartyAccessInvitation(
        realm,
        delivery,
        `ccc-redemption-${randomUUID()}@example.test`,
      );
      const payload = yield* prepareCounterpartyInvitationClaimPayload(fixture, realm, invitation);
      const deniedCredential = yield* fresh();
      const actionIdempotency = randomUUID();
      const actionRequest = (credential: string) =>
        new Request('http://localhost:3020/commerce-customer-context/actions/claim-counterparty-access-invitation', {
          body: JSON.stringify(payload),
          headers: {
            authorization: `Bearer ${credential}`,
            'content-type': 'application/json',
            'idempotency-key': actionIdempotency,
            'x-correlation-id': `redemption-denial-${randomUUID()}`,
          },
          method: 'POST',
        });
      const denied = yield* Effect.promise(async () => await runtime.handler(actionRequest(deniedCredential)));
      expect(denied.status).toBe(403);
      expect((yield* invoke(deniedCredential)).status).toBe(401);
      expect(yield* countCounterpartyInvitationClaims(fixture, realm, invitation.invitationId)).toBe(0);
      const freshBusinessRetry = yield* fresh();
      const retryDenied = yield* Effect.promise(async () => await runtime.handler(actionRequest(freshBusinessRetry)));
      expect(retryDenied.status).toBe(403);
      expect(yield* countCounterpartyInvitationClaims(fixture, realm, invitation.invitationId)).toBe(0);

      // A new credential may repeat business intent; the consumed credential never can.
      expect((yield* invoke(yield* fresh())).status).toBe(200);
      return yield* Effect.void;
    }),
  ),
);

const restartServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const restartAppRoot = fileURLToPath(new URL('../../../../', import.meta.url));
class RedemptionRestartTestFailure extends Schema.TaggedError<RedemptionRestartTestFailure>()(
  'RedemptionRestartTestFailure',
  {
    exitCode: Schema.Int,
    pid: Schema.Int,
    reason: Schema.Literal('REDEMPTION_RESTART_TEST_FAILED'),
    stage: GatewayRedemptionRestartStageSchema,
  },
) {}
const restartUnavailable = (stage: typeof GatewayRedemptionRestartStageSchema.Type, exitCode = -1, pid = -1) =>
  new RedemptionRestartTestFailure({ exitCode, pid, reason: 'REDEMPTION_RESTART_TEST_FAILED', stage });

const runRedemptionProcess = Effect.fn('GatewayRedemptionRestart.runProcess')(function* runRedemptionProcess(
  artifact: string,
  command: typeof GatewayRedemptionRestartCommandSchema.Type,
) {
  const document = yield* Schema.encodeEffect(Schema.fromJsonString(GatewayRedemptionRestartCommandSchema))(command);
  const child = yield* ChildProcess.make(process.execPath, [artifact, '--gateway-redemption-restart-child'], {
    additionalFds: {
      fd3: { type: 'output' },
      fd4: { stream: Stream.make(new TextEncoder().encode(`${document}\n`)), type: 'input' },
    },
    cwd: restartAppRoot,
    env: { NODE_ENV: 'test' },
    extendEnv: false,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [responses, exit] = yield* Effect.all(
    [
      child.getOutputFd(3).pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.length > 0),
        Stream.runCollect,
      ),
      child.exitCode,
      Stream.runDrain(child.stdout),
      Stream.runDrain(child.stderr),
    ],
    { concurrency: 4 },
  ).pipe(
    Effect.timeoutOrElse({
      duration: '15 seconds',
      orElse: () => Effect.fail(restartUnavailable('CHILD_TIMEOUT', -1, Number(child.pid))),
    }),
  );
  expect(yield* child.isRunning).toBe(false);
  if (responses.length !== 1) {
    return yield* restartUnavailable('CHILD_NO_RESPONSE', Number(exit), Number(child.pid));
  }
  const response = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayRedemptionRestartResponseSchema), {
    onExcessProperty: 'error',
  })(responses[0]).pipe(
    Effect.mapError(() => restartUnavailable('RESPONSE_PROTOCOL', Number(exit), Number(child.pid))),
  );
  expect(response.pid).toBe(Number(child.pid));
  expect(response.pid).not.toBe(process.pid);
  if (response.type === 'failed') {
    return yield* restartUnavailable(response.stage, Number(exit), response.pid);
  }
  expect(exit).toBe(0);
  return response;
});

it.effect('waits for the private redemption response to finish before closing its writable', () =>
  Effect.gen(function* responseWriteLifetime() {
    const started = yield* Deferred.make<true>();
    const completed = yield* Ref.make(false);
    let finishWrite: (() => void) | undefined;
    const output = new Writable({
      write(_chunk, _encoding, done) {
        finishWrite = () => done();
        Deferred.doneUnsafe(started, Effect.succeed(true));
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => output.destroy()));
    const sending = yield* writeGatewayRedemptionRestartResponse(output, {
      outcomes: ['accepted'],
      pid: process.pid,
      type: 'completed',
      version: 'ontos.ccc.redemption-restart.v1',
    }).pipe(
      Effect.tap(() => Ref.set(completed, true)),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* Effect.yieldNow;
    expect(yield* Ref.get(completed)).toBe(false);
    expect(output.writableFinished).toBe(false);
    if (finishWrite === undefined) {
      return yield* restartUnavailable('PRIVATE_OUTPUT');
    }
    finishWrite();
    yield* Fiber.join(sending);
    expect(output.writableFinished).toBe(true);
    yield* closeGatewayRedemptionRestartOutput(output);
    expect(output.closed).toBe(true);
    return yield* Effect.void;
  }),
);

it.effect('retains a private output close failure instead of treating finalization as successful', () =>
  Effect.gen(function* responseCloseFailure() {
    const output = new Writable({
      destroy(_error, done) {
        done(new Error('private fixture close failure'));
      },
    });
    const result = yield* closeGatewayRedemptionRestartOutput(output).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.stage).toBe('PRIVATE_OUTPUT');
      expect(result.failure.reason).toBe('REDEMPTION_RESTART_CHILD_FAILED');
    }
  }),
);

it.effect('keeps the redemption restart protocol closed and credential fields redacted', () =>
  Effect.gen(function* restartProtocolControls() {
    const compositionSnapshot = yield* enrollmentApplicationCompositionSnapshot;
    const command: typeof GatewayRedemptionRestartCommandSchema.Type = {
      compositionSnapshot,
      credentials: [Redacted.make('Bearer protocol-control')],
      databaseName: `ontos_test_party_gateway_${'a'.repeat(32)}`,
      issuer: 'https://ccc-restart.ontos.test',
      publicJwks: '{"keys":[]}',
      runtimeConnectionString: Redacted.make('postgresql://ontos_runtime:fixture@localhost/fixture'),
      runtimeUser: 'ontos_runtime',
      type: 'first-process',
      version: 'ontos.ccc.redemption-restart.v1',
    };
    const document = yield* Schema.encodeEffect(Schema.fromJsonString(GatewayRedemptionRestartCommandSchema))(command);
    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayRedemptionRestartCommandSchema))(
      document,
    );
    expect(Redacted.isRedacted(decoded.runtimeConnectionString)).toBe(true);
    expect(decoded.credentials.every(Redacted.isRedacted)).toBe(true);
    const encoded = yield* Schema.encodeEffect(GatewayRedemptionRestartCommandSchema)(command);
    for (const invalid of [
      { ...encoded, adminConnectionString: 'forbidden' },
      { ...encoded, sql: 'select forbidden' },
      { ...encoded, type: 'restarted-process' },
      { ...encoded, credentials: [] },
      { ...encoded, version: 'foreign-version' },
    ]) {
      const result = yield* Schema.decodeUnknownEffect(GatewayRedemptionRestartCommandSchema, {
        onExcessProperty: 'error',
      })(invalid).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }
    const failureResponse = {
      pid: process.pid,
      reason: 'REDEMPTION_RESTART_CHILD_FAILED',
      stage: 'STORE_LAYER',
      type: 'failed',
      version: command.version,
    };
    const safeFailure = yield* Schema.decodeUnknownEffect(GatewayRedemptionRestartResponseSchema, {
      onExcessProperty: 'error',
    })(failureResponse);
    expect(safeFailure).toEqual(failureResponse);
    for (const invalid of [
      { ...failureResponse, stage: 'arbitrary-diagnostic' },
      { ...failureResponse, cause: 'private-cause' },
      { ...failureResponse, credential: 'private-credential' },
    ]) {
      const result = yield* Schema.decodeUnknownEffect(GatewayRedemptionRestartResponseSchema, {
        onExcessProperty: 'error',
      })(invalid).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }
    expect(
      Schema.is(GatewayRedemptionRestartResponseSchema)({
        outcomes: ['accepted', 'replay'],
        pid: process.pid,
        type: 'completed',
        version: command.version,
      }),
    ).toBe(true);
  }),
);

it.live('retains signed assertion redemption after an actual process exits and a new process starts', () =>
  Effect.scoped(
    Effect.gen(function* actualRedemptionProcessRestart() {
      const snapshot = yield* enrollmentApplicationCompositionSnapshot;
      const isolated = yield* makeIsolatedNativeDatabaseFixture({
        compositionSnapshot: snapshot,
        mode: 'schema-only',
        purpose: 'stabilization-1231-redemption-restart',
      });
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          actionKeys: [],
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          allowedAudiences: ['commerce-customer-context'],
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: snapshot.composition.revision,
          moduleKeys: ['commerce.customer-context'],
          runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
        }),
        (resource) => resource.close().pipe(Effect.orDie),
      );
      const adminContext = yield* Layer.build(
        PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
          Layer.provideMerge(Reactivity.layer),
        ),
      );
      const adminExecutor = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
      const runtimeContext = yield* Layer.build(
        PgClient.layer({ url: Redacted.make(isolated.connections.runtime.connectionString) }).pipe(
          Layer.provideMerge(Reactivity.layer),
        ),
      );
      const executor = yield* makeWithDefaults({ relations }).pipe(Effect.provide(runtimeContext));
      const artifact = fileURLToPath(
        new URL(`../../node_modules/.cache/ontos-1231/${randomUUID()}.mjs`, import.meta.url),
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(artifact, { force: true })));
      const toolchainEnvironment: Record<string, string> = {};
      for (const key of ['PATH', 'HOME', 'MISE_DATA_DIR', 'MISE_CACHE_DIR', 'MISE_CONFIG_DIR', 'MISE_INSTALL_PATH']) {
        const value = yield* Config.option(Config.String(key));
        if (Option.isSome(value)) {
          toolchainEnvironment[key] = value.value;
        }
      }
      const bundle = yield* ChildProcess.make(
        'mise',
        [
          'exec',
          '--',
          'pnpm',
          'exec',
          'esbuild',
          'verticals/commerce-customer-context/tests/support/gateway-redemption-restart-child.ts',
          '--bundle',
          '--platform=node',
          '--format=esm',
          '--packages=external',
          `--outfile=${artifact}`,
        ],
        {
          cwd: restartAppRoot,
          // The bundler needs toolchain locations, never the runner's database or signing credentials.
          env: toolchainEnvironment,
          extendEnv: false,
          stderr: 'pipe',
          stdout: 'pipe',
        },
      );
      const [bundleExit] = yield* Effect.all(
        [bundle.exitCode, Stream.runDrain(bundle.stdout), Stream.runDrain(bundle.stderr)],
        { concurrency: 3 },
      );
      expect(bundleExit).toBe(0);
      const gateway = yield* makeAcceptanceGatewayIssuer(
        `https://ccc-restart-${randomUUID()}.ontos.test`,
        'ccc-restart',
      );
      const principal = { ...fixture.manager, authMethod: 'session' as const, legalEntityId: fixture.legalEntityId };
      const original = yield* issueAcceptanceGatewayAssertion(
        adminExecutor,
        gateway,
        'commerce-customer-context',
        principal,
      );
      const fresh = yield* issueAcceptanceGatewayAssertion(
        adminExecutor,
        gateway,
        'commerce-customer-context',
        principal,
      );
      const originalClaims = yield* decodeSupportedGatewayContextClaims(decodeJwt(original));
      const freshClaims = yield* decodeSupportedGatewayContextClaims(decodeJwt(fresh));
      expect(originalClaims.jti).not.toBe(freshClaims.jti);
      const common = {
        compositionSnapshot: snapshot,
        databaseName: isolated.connections.runtime.database,
        issuer: gateway.issuer,
        publicJwks: JSON.stringify({ keys: [gateway.publicJwk] }),
        runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
        runtimeUser: isolated.connections.runtime.user,
        version: 'ontos.ccc.redemption-restart.v1' as const,
      };
      const history = () =>
        executor
          .select()
          .from(gatewayAssertionRedemptions)
          .where(eq(gatewayAssertionRedemptions.issuer, gateway.issuer));
      expect((yield* history()).length).toBe(0);
      const first = yield* runRedemptionProcess(artifact, {
        ...common,
        credentials: [Redacted.make(`Bearer ${original}`)],
        type: 'first-process',
      });
      expect(first.outcomes).toEqual(['accepted']);
      // This query occurs after the child exited and closed its pool: only durable native evidence survives.
      const committed = yield* history();
      expect(committed.length).toBe(1);
      expect(committed[0]).toMatchObject({
        audience: 'commerce-customer-context',
        issuer: gateway.issuer,
        jti: originalClaims.jti,
      });
      expect(committed[0]?.expiresAt.getTime()).toBe(originalClaims.exp * 1000);
      const restarted = yield* runRedemptionProcess(artifact, {
        ...common,
        credentials: [Redacted.make(`Bearer ${original}`), Redacted.make(`Bearer ${fresh}`)],
        type: 'restarted-process',
      });
      expect(restarted.pid).not.toBe(first.pid);
      expect(restarted.outcomes).toEqual(['replay', 'accepted']);
      const retained = yield* history();
      expect(retained.length).toBe(2);
      expect(retained.find((row) => row.jti === originalClaims.jti)).toEqual(committed[0]);
      expect(retained.filter((row) => row.jti === originalClaims.jti).length).toBe(1);
      expect(retained.find((row) => row.jti === freshClaims.jti)).toMatchObject({
        audience: 'commerce-customer-context',
        issuer: gateway.issuer,
      });
      yield* isolated.assertClonedSchema();
    }),
  ).pipe(Effect.provide(restartServices)),
);
