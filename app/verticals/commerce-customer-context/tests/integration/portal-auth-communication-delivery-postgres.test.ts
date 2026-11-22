import { randomUUID } from 'node:crypto';

import { loadActiveApplicationComposition } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import { extractOutboxWorkerSubscriptions } from '@app/core-runtime/outbox/worker';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { and, eq, sql } from 'drizzle-orm';
import { Clock, ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Option, Ref, Result, Schema } from 'effect';
import type { Duration, Scope } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { NetAddress } from 'effect/net';
import type { ChildProcessSpawner } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import {
  accessScopeFences,
  accessScopes,
  coreRelations,
  outboxDeliveries,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { getVerticalRuntimeOutboxWorkers } from '../../../../packages/core-runtime/src/modules/runtime-registration.ts';
import { bindAccessGate } from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import type { AccessEnforcementPorts } from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import { makeOutboxRepository } from '../../../../packages/core-runtime/src/outbox/repository.ts';
import { makeOutboxRuntime } from '../../../../packages/core-runtime/src/outbox/runtime.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { makeNativeOutboxWorkerFixture } from '../../../../packages/core-runtime/tests/support/outbox-worker-native-fixture.ts';
import { PortalAuthIssuanceRefSchema } from '../../shared/portal-auth-communications.ts';
import { relayPortalAuthCommunicationRequestAction } from '../../src/actions/relay-portal-auth-communication-request.action.ts';
import type { PortalAuthIssuance } from '../../src/portal-auth/communications/issuance.ts';
import { portalAuthCommunicationRequest } from '../../src/portal-auth/communications/request.ts';
import { PortalAuthCommunicationSourceGatewayLive } from '../../src/workers/portal-auth-communication-source-gateway.ts';
import { submitPortalAuthCommunicationRequestWorker } from '../../src/workers/submit-portal-auth-communication-request.worker.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

/*
 * #1406 D1 (review A1, A3): the production hops of the Portal Auth transport after the Auth-local outbox, on native PostgreSQL.
 *
 * What is REAL: the `relay-portal-auth-communication-request` Action through Core's own Action runtime under Core's real access
 * decision service (its declared registered workload `commerce.customer-context.portal-auth-communication-relay`), the Domain
 * Event and Outbox Message Core commits for it, Core's own outbox matching, claim, lease, retry, deferral and dead-letter
 * settlement of that delivery, the module's registered `submit-portal-auth-communication-request` worker, and its production
 * source gateway (`PortalAuthCommunicationSourceGatewayLive`): the delegated registered-workload request it sends to the Shell
 * and the public Action call it sends to Communications, over real HTTP.
 *
 * LABELLED: the workload registry port answers the relay principal's workload in ONE Tenant (Core's registry would, under
 * row-level security); the Shell and Communications are one loopback HTTP peer that records what it is sent, issues a FICTIONAL
 * token and answers 503 for a scripted outage (or a FICTIONAL stored decision). The Shell sealing the worker's delivery and the
 * Communications handler's admission of that sealed caller are NOT run here: they are proven by Communications'
 * `registered-source-worker-admission.test.ts` (Core's access decision and the real handler) and the D1 E2E suites.
 */

const RELAY_WORKLOAD = 'commerce.customer-context.portal-auth-communication-relay';
const MODULE = 'commerce.customer-context';
const TOPIC = 'commerce.customer-context.portal-auth-communication-requested.v1';
const WORKER_KEY = 'commerce.customer-context.submit-portal-auth-communication-request';
const SUBMIT_PATH = '/communications/actions/submit-communication-request';
const DELEGATION_PATH = '/shell-super-app-api/auth/delegated/gateway-context';
const SHELL_PREFIX = '/shell-super-app-api';

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const native = <A, E>(
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope>,
) => Effect.scoped(effect).pipe(Effect.provide(services));

/** One request the loopback Shell/Communications peer received. */
interface Received {
  readonly authorization: string | undefined;
  readonly body: unknown;
  readonly idempotencyKey: string | undefined;
  readonly path: string;
}

const JsonSchema = Schema.fromJsonString(Schema.Unknown);
const ClaimedSubjectSchema = Schema.Struct({
  subject: Schema.Struct({ claimId: Schema.String.pipe(Schema.brand('OutboxClaimId')) }),
});

/**
 * The Shell and Communications as ONE loopback HTTP peer (labelled): the Shell issues a FICTIONAL delegated token for the
 * admitted release, and Communications answers 503 while `outage` says so, then one FICTIONAL stored decision.
 */
const servePeers = Effect.fnUntraced(function* servePeers(compositionRevision: string, outage: Ref.Ref<number>) {
  const received = yield* Ref.make<readonly Received[]>([]);
  const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
  yield* server.serve(
    HttpServerRequest.HttpServerRequest.use((request) =>
      Effect.gen(function* answer() {
        const text = yield* request.text;
        const path = new URL(request.url, 'http://peer.test').pathname;
        yield* Ref.update(received, (all) => [
          ...all,
          {
            authorization: request.headers.authorization,
            body: Schema.decodeUnknownOption(JsonSchema)(text).pipe(Option.getOrUndefined),
            idempotencyKey: request.headers['idempotency-key'],
            path,
          },
        ]);
        if (path === DELEGATION_PATH) {
          return yield* HttpServerResponse.json({
            apiBaseUrl: '/communications-api',
            compositionRevision,
            // a fixed far-future expiry (2099-01-01): the peer's token never depends on this live test's clock
            expiresAt: 4_070_908_800,
            token: 'fictional-delegated-workload-token',
          });
        }
        if (path.endsWith(SUBMIT_PATH)) {
          const remaining = yield* Ref.getAndUpdate(outage, (left) => Math.max(0, left - 1));
          if (remaining > 0) {
            return HttpServerResponse.empty({ status: 503 });
          }
          return yield* HttpServerResponse.json({
            decision: { kind: 'NO_MESSAGE', reason: 'FICTIONAL_STORED_DECISION' },
            decisionId: '5d000000-0000-4000-8000-0000000000a1',
            outcome: 'DECIDED',
            replayed: false,
            requestId: '5d000000-0000-4000-8000-0000000000a2',
          });
        }
        return HttpServerResponse.empty({ status: 404 });
      }).pipe(Effect.orDie),
    ),
  );
  if (!NetAddress.isInetAddress(server.address)) {
    return yield* Effect.die('The loopback peer must bind one TCP server');
  }
  return { origin: `http://127.0.0.1:${server.address.port}`, received };
});

/** A clock frozen at `now` (sleeps stay real), so the worker and Core settle the same instant of a fast-forwarded cycle. */
const frozenClock = (real: Clock.Clock, now: Date): Clock.Clock => {
  const millis = now.getTime();
  return {
    currentTimeMillis: Effect.succeed(millis),
    currentTimeMillisUnsafe: () => millis,
    currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
    monotonicTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
    sleep: (duration: Duration.Duration) => real.sleep(duration),
  };
};

const scenario = Effect.fn('PortalAuthCommunicationDeliveryTest.scenario')(function* scenario(input: {
  readonly outageCalls: number;
  readonly validForMinutes: number;
}) {
  const fixture = makeNativeOutboxWorkerFixture(getVerticalRuntimeOutboxWorkers(commerceCustomerContextRegistration));
  const snapshot = yield* loadActiveApplicationComposition(fixture.authority);
  const { revision } = snapshot.composition;
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1229-payment-entitlement',
    sourceConnections: yield* loadDatabaseConnectionPair(),
  });
  const admin = yield* makeTestPgClient(isolated.connections.admin.connectionString);
  const runtime = yield* makeTestPgClient(isolated.connections.runtime.connectionString);
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  const tenantId = randomUUID();
  const relayPrincipalId = randomUUID();
  const unboundPrincipalId = randomUUID();
  const tenantScopeId = randomUUID();
  yield* coreAdmin.insert(tenants).values({
    defaultLocale: 'en',
    name: 'FICTIONAL Portal Auth delivery tenant',
    slug: `portal-auth-delivery-${tenantId}`,
    status: 'active',
    tenantId,
  });
  yield* coreAdmin.insert(accessScopes).values({ scopeId: tenantScopeId, tenantContextId: tenantId, tenantId });
  yield* coreAdmin.insert(accessScopeFences).values({ revision: 1, scopeId: tenantScopeId, state: 'Ready', tenantId });
  // the relay principal and a second system principal of the same Tenant that holds no relay workload
  for (const principalId of [relayPrincipalId, unboundPrincipalId]) {
    yield* coreAdmin.insert(principals).values({
      displayName: 'FICTIONAL Portal Auth relay',
      kind: 'system',
      principalId,
      status: 'active',
      tenantId,
    });
    yield* coreAdmin.insert(principalAuthBindings).values({
      authenticationNamespaceId: 'test.portal-auth-delivery.v1',
      principalAuthBindingId: principalId,
      principalId,
      provider: 'better_auth',
      providerSubjectId: `fictional-relay-api-key-${principalId}`,
      status: 'active',
      subjectType: 'api_key',
      tenantId,
    });
  }
  yield* coreAdmin.insert(tenantModuleStates).values({ moduleKey: MODULE, state: 'active', tenantId });

  // Core's REAL access decision service; only its registry port is scripted: the relay principal holds the relay
  // workload in THIS Tenant and nothing else anywhere
  const authority = {
    readCells: () => Effect.die('the workload path read grant cells'),
    readConnection: () => Effect.die('the workload path read a connection'),
    readScope: () => Effect.die('the workload path read a scope'),
    readTeamIds: () => Effect.die('the workload path read teams'),
  };
  const ports: AccessEnforcementPorts = {
    candidates: { listCandidateIds: () => Effect.succeed([]) },
    check: { checkBulk: () => Effect.die('the workload path asked the grant engine') },
    decisionLog: { record: () => Effect.void },
    intent: { authorityFor: () => authority },
    principalKinds: { readKind: () => Effect.succeed(Option.some('system')) },
    workloadBindings: {
      readActiveWorkloadKeys: (query) =>
        Effect.succeed(
          new Set(query.principalId === relayPrincipalId && query.tenantId === tenantId ? [RELAY_WORKLOAD] : []),
        ),
    },
  };
  const decisions = makeAccessDecisionService({
    authorityFor: ports.intent.authorityFor,
    check: ports.check,
    decisionLog: ports.decisionLog,
    legalEntities: ports.candidates,
    principalKinds: ports.principalKinds,
    workloadBindings: ports.workloadBindings,
  });
  const crypto = yield* Crypto.Crypto;
  const actions = makeActionRuntime(
    { executor: database },
    makeActionRepository(crypto),
    { checkActionPermission: () => Effect.succeed('allowed' as const) },
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision: bindAccessGate(decisions, ports),
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: commerceCustomerContextRegistration,
      resolveCompositionRevision: () => Effect.succeed(revision),
    },
  );
  // Core stamps its rows with PostgreSQL's clock; the scenario starts at that same instant
  const [started] = yield* coreAdmin.execute<{ readonly now: string }>(
    sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`,
    'objects',
  );
  const issuedAt = yield* Effect.fromOption(Option.flatMap(Option.fromUndefinedOr(started?.now), DateTime.make));
  const issuance: PortalAuthIssuance = {
    expiresAt: DateTime.add(issuedAt, { minutes: input.validForMinutes }),
    flow: 'reset-password',
    issuanceRef: Schema.decodeSync(PortalAuthIssuanceRefSchema)(`pa-delivery-${tenantId.slice(0, 8)}`),
    issuedAt,
    providerSubjectId: 'FICTIONAL-subject-delivery',
  };
  const request = yield* portalAuthCommunicationRequest(issuance, { tenantId });
  const relayAs = (principalId: string) => {
    const principal: TrustedPrincipalContext = {
      authBindingId: principalId,
      authContextRef: 'fictional-api-key:portal-auth-relay',
      authMethod: 'api_key',
      principalId,
      tenantId,
    };
    return actions
      .runAction({
        payload: { request },
        principal,
        registration: relayPortalAuthCommunicationRequestAction,
        transport: { correlationId: 'portal-auth-delivery', idempotencyKey: request.idempotency.key },
      })
      .pipe(Effect.result);
  };
  const outage = yield* Ref.make(input.outageCalls);
  const peers = yield* servePeers(revision, outage);
  // the worker host's configuration: read when the gateway layer is built AND when each delegation is acquired
  const configuration = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      ONTOS_COMMUNICATIONS_API_BASE_URL: peers.origin,
      ONTOS_GATEWAY_MODULE_API_KEY: 'fictional-module-api-key',
      ONTOS_SHELL_GATEWAY_BASE_URL: `${peers.origin}${SHELL_PREFIX}`,
    }),
  );
  const gateway = PortalAuthCommunicationSourceGatewayLive.pipe(Layer.provideMerge(configuration));
  const outbox = makeOutboxRuntime(makeOutboxRepository(database, crypto));
  const registrations = [submitPortalAuthCommunicationRequestWorker];
  const realClock = yield* Clock.Clock;
  /** One Core delivery cycle at `now`, with the worker's clock frozen at the same instant. */
  const deliverAt = (now: Date) =>
    fixture
      .bind(
        registrations,
        outbox.runCycle({
          claimOwner: 'portal-auth-delivery-worker',
          compositionRevision: revision,
          maxDeliveries: 1,
          now,
          registrations,
          subscriptions: extractOutboxWorkerSubscriptions(registrations),
        }),
      )
      .pipe(Effect.provide(gateway), Effect.provideService(Clock.Clock, frozenClock(realClock, now)));
  const delivery = coreAdmin
    .select({
      attemptsCount: outboxDeliveries.attemptsCount,
      availableAt: outboxDeliveries.availableAt,
      outboxDeliveryId: outboxDeliveries.outboxDeliveryId,
      status: outboxDeliveries.status,
    })
    .from(outboxDeliveries)
    .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
    .where(and(eq(outboxMessages.tenantId, tenantId), eq(outboxDeliveries.workerKey, WORKER_KEY)));
  const messages = coreAdmin
    .select({ payloadJson: outboxMessages.payloadJson, topic: outboxMessages.topic })
    .from(outboxMessages)
    .where(eq(outboxMessages.tenantId, tenantId));
  return {
    deliverAt,
    delivery,
    issuance,
    messages,
    outbox,
    peers,
    relayAs,
    relayPrincipalId,
    request,
    revision,
    startedAt: DateTime.toDateUtc(issuedAt),
    unboundPrincipalId,
  };
});

/** Delivers due work until the delivery settles, fast-forwarding Core's clock to each due time; returns the statuses seen. */
const settleDelivery = Effect.fn('PortalAuthCommunicationDeliveryTest.settle')(function* settleDelivery(
  world: Effect.Success<ReturnType<typeof scenario>>,
  start: Date,
) {
  const seen: string[] = [];
  let now = start;
  for (let cycle = 0; cycle < 20; cycle += 1) {
    yield* world.outbox.matchMessages({ compositionRevision: world.revision, now });
    yield* world.deliverAt(now);
    const [row] = yield* world.delivery;
    if (row === undefined) {
      return yield* Effect.die('Core matched no delivery for the source worker');
    }
    seen.push(row.status);
    if (row.status !== 'pending') {
      return { attempts: row.attemptsCount, deliveryId: row.outboxDeliveryId, seen, status: row.status };
    }
    now = new Date(Math.max(row.availableAt.getTime(), now.getTime() + 1));
  }
  return yield* Effect.die(`The delivery did not settle: ${seen.join(', ')}`);
});

it.live(
  'A1/A3: a delivery that outlives its retry budget during an outage is deferred, never dead-lettered, and submits the same request once Communications answers',
  () =>
    native(
      Effect.gen(function* recovers() {
        // seven unavailable answers: four ordinary retries spend the budget of five, then three deferrals, then the answer
        const world = yield* scenario({ outageCalls: 7, validForMinutes: 30 });
        // a principal without the relay workload is refused by Core and queues nothing
        const refused = yield* world.relayAs(world.unboundPrincipalId);
        expect(Result.isFailure(refused)).toBe(true);
        expect(refused).toMatchObject({ failure: { _tag: 'ActionPermissionDenied' } });
        expect(yield* world.messages).toHaveLength(0);
        // the relay principal's Action commits ONE Domain Event + self-Outbox Message; a repeated relay commits nothing new
        const relayed = yield* world.relayAs(world.relayPrincipalId);
        expect(Result.isSuccess(relayed)).toBe(true);
        expect(relayed).toMatchObject({ success: { outcome: 'RELAYED' } });
        yield* world.relayAs(world.relayPrincipalId);
        const committed = yield* world.messages;
        expect(committed).toHaveLength(1);
        expect(committed[0]).toMatchObject({ payloadJson: { request: world.request }, topic: TOPIC });

        const settled = yield* settleDelivery(world, world.startedAt);
        expect(settled.seen).not.toContain('dead');
        expect(settled.status).toBe('done');
        expect(settled.seen.filter((status) => status === 'pending').length).toBeGreaterThanOrEqual(7);
        // the deferrals did not charge the ordinary budget: the delivery ended within it
        expect(settled.attempts).toBeLessThanOrEqual(5);
        const received = yield* Ref.get(world.peers.received);
        const submissions = received.filter(({ path }) => path.endsWith(SUBMIT_PATH));
        const delegations = received.filter(({ path }) => path === DELEGATION_PATH);
        expect(submissions).toHaveLength(8);
        // every attempt submitted the SAME request under the SAME idempotency key with the fresh delegated token
        for (const submission of submissions) {
          expect(submission.body).toStrictEqual(world.request);
          expect(submission.idempotencyKey).toBe(world.request.idempotency.key);
          expect(submission.authorization).toBe('Bearer fictional-delegated-workload-token');
        }
        // each attempt asked the Shell for a registered-workload assertion of THIS worker's genuine Core delivery (its own
        // claim each time) and of the declaration the Communications Action declares beside its workload
        expect(delegations).toHaveLength(8);
        for (const delegation of delegations) {
          expect(delegation.body).toMatchObject({
            audience: 'communications',
            compositionRevision: world.revision,
            legalEntityScope: 'subject',
            subject: {
              _tag: 'RegisteredWorkload',
              declarationKey: 'communications.core.communication-request.submit',
              deliveryId: settled.deliveryId,
              tenantId: world.request.scope.tenantId,
              workerKey: WORKER_KEY,
            },
          });
        }
        const claims = delegations.map(({ body }) =>
          Schema.decodeUnknownOption(ClaimedSubjectSchema)(body).pipe(Option.map(({ subject }) => subject.claimId)),
        );
        expect(new Set(claims.map(Option.getOrUndefined)).size).toBe(8);
        expect(claims.every(Option.isSome)).toBe(true);
      }),
    ),
  { timeout: 180_000 },
);

it.live(
  'A1: past the issuance expiry an exhausted delivery is no longer deferred and ends dead, nothing is sent',
  () =>
    native(
      Effect.gen(function* expires() {
        // the issuance is usable for one minute only and Communications never answers
        const world = yield* scenario({ outageCalls: 1000, validForMinutes: 1 });
        yield* world.relayAs(world.relayPrincipalId);
        const settled = yield* settleDelivery(world, world.startedAt);
        expect(settled.status).toBe('dead');
        const received = yield* Ref.get(world.peers.received);
        expect(received.filter(({ path }) => path.endsWith(SUBMIT_PATH)).length).toBeGreaterThanOrEqual(5);
      }),
    ),
  { timeout: 180_000 },
);
