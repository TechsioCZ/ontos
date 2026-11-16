import { OwnerActionApprovals } from '@app/core-runtime/access/approvals/owner-runtime';
import { defineDatabaseIdentityEnrollment, ActionRuntime, ReadRuntime } from '@app/core-runtime';
import { randomUUID } from 'node:crypto';

import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSource } from '@app/core-runtime/testing/application-composition-source';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, count, eq } from 'drizzle-orm';
import { ConfigProvider, Crypto, Effect, Layer, Schema } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { coreRelations, outboxMessages, tenantModuleStates } from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeModuleEntrypointGateway } from '../../../../packages/core-runtime/src/modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { makePaymentApiRuntime } from '../../api/index.ts';
import { paymentUnavailableOwnerPortsLive } from '../support/unavailable-owner-ports.fixture.ts';
import type { AcceptPaymentObservationPayloadSchema } from '../../shared/actions/accept-payment-observation.ts';
import type { RequestPaymentRefundPayloadSchema } from '../../shared/actions/request-payment-refund.ts';
import type { StartPaymentCollectionPayloadSchema } from '../../shared/actions/start-payment-collection.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../src/auth/gateway-assertion-redemption-runtime.ts';
import { gatewayAssertionRedemptions, observations, paymentOperations } from '../../src/database/schema.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { seedSourceAuthority } from '../support/refund-native-runtime.ts';
import { makeTestScope } from './database-fixture.ts';
import {
  BANK_BINDING,
  evidenceContextAccess,
  evidenceScenarioOf,
  principalOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase } from './evidence-native-support.ts';

/**
 * #1153 "Ingress credentials do not replace owner permission", through Payment's own public HTTP
 * assembly (`makePaymentApiRuntime`): a Shell-signed gateway assertion is verified and DURABLY redeemed
 * in `payment.gateway_assertion_redemptions`, then the real Core Action runtime on the worktree
 * PostgreSQL refuses the operation because the actor lacks the Payment permission, before any Payment
 * row, Domain Event or Outbox message exists. The control run with the permission granted creates the
 * business effect through the identical path, so the refusal is the permission and nothing else.
 */

const COMPOSITION = '9'.repeat(64);
type IngressBody =
  | typeof AcceptPaymentObservationPayloadSchema.Encoded
  | typeof RequestPaymentRefundPayloadSchema.Encoded
  | typeof StartPaymentCollectionPayloadSchema.Encoded;
const ISSUER = 'https://shell.payment-acceptance.test';

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

/** The real Core Action and Read runtimes; only the Payment permission decision varies. */
const makeRuntimes = Effect.fn('AcceptanceIngress.makeRuntimes')(function* makeRuntimes(
  database: EvidenceNativeDatabase,
  permission: 'allowed' | 'denied',
) {
  const crypto = yield* Crypto.Crypto;
  const accessDecision = makeScriptedBoundAccessGate(permission).bound;
  const moduleStateGate = makeModuleStateGate(makeTenantModuleStateService({ executor: database.coreAdmin }));
  const gateway = makeModuleEntrypointGateway(moduleStateGate);
  const actions: ActionRuntimeService = makeActionRuntime(
    { executor: database.database },
    makeActionRepository(crypto),
    { checkActionPermission: () => Effect.succeed(permission) },
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision,
      contextAccess: evidenceContextAccess,
      moduleEntrypointGateway: gateway,
      moduleStateGate,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
      resolveCompositionRevision: () => Effect.succeed(COMPOSITION),
    },
  );
  const reads: ReadRuntimeService = makeReadRuntime(
    { executor: database.database },
    gateway,
    testOperationalScopeResolver,
    evidenceContextAccess,
    {
      accessDecision,
      databaseIdentities: defineDatabaseIdentityEnrollment([]),
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actions, reads };
});

/** Payment's public HTTP assembly with durable assertion redemption and the production owner ports. */
const mountPaymentTransport = Effect.fn('AcceptanceIngress.mount')(function* mount(
  database: EvidenceNativeDatabase,
  runtimes: { readonly actions: ActionRuntimeService; readonly reads: ReadRuntimeService },
) {
  const compositionSnapshot = yield* makeApplicationCompositionSnapshotFixture(
    ['payment'],
    ultramodernApiMarker.buildMarker,
  );
  const compositionDocument = yield* Schema.encodeEffect(
    Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
  )(compositionSnapshot);
  const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
  const publicJwk = {
    ...(yield* Effect.promise(() => exportJWK(publicKey))),
    alg: 'EdDSA',
    kid: 'payment-acceptance-ingress',
    use: 'sig',
  };
  const assembled = makePaymentApiRuntime(
    Layer.succeed(ReadRuntime, runtimes.reads).pipe(Layer.provideMerge(paymentUnavailableOwnerPortsLive)),
    Layer.mergeAll(
      Layer.succeed(ActionRuntime, runtimes.actions),
      Layer.succeed(OwnerActionApprovals, {
        approve: () => Effect.die('owner action approvals are outside this proof'),
        inspect: () => Effect.die('owner action approvals are outside this proof'),
      }),
      Layer.succeed(ActiveApplicationCompositionSource, { load: Effect.succeed(compositionDocument) }),
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: ISSUER,
          ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            keys: [publicJwk],
          }),
        }),
      ),
    ).pipe(Layer.provideMerge(paymentUnavailableOwnerPortsLive)),
    GatewayAssertionRedemptionLive.pipe(
      Layer.provide(GatewayAssertionRedemptionDatabaseLive),
      Layer.provide(Layer.succeed(PgClient.PgClient, database.runtimeClient)),
    ),
  );
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(() => assembled.createHandler()),
    (resource) => Effect.promise(() => resource.dispose()).pipe(Effect.orDie),
  );
  /** A fresh Shell assertion (new JTI) for the trusted principal of the scope. */
  const signAssertion = Effect.fn('AcceptanceIngress.signAssertion')(function* signAssertion(
    principal: ReturnType<typeof principalOf>,
  ) {
    const jti = randomUUID();
    const token = yield* Effect.promise(() =>
      new SignJWT({
        compositionRevision: compositionSnapshot.composition.revision,
        // The Shell's version-1 staff assertion carries the trusted session context, without a namespace.
        principal: {
          authBindingId: principal.authBindingId,
          authContextRef: principal.authContextRef,
          authMethod: principal.authMethod,
          legalEntityId: principal.legalEntityId,
          principalId: principal.principalId,
          tenantId: principal.tenantId,
        },
        targetBuildMarker: ultramodernApiMarker.buildMarker,
        ver: 1,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: publicJwk.kid, typ: 'JWT' })
        .setIssuer(ISSUER)
        .setAudience('payment')
        .setSubject(principal.principalId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .setJti(jti)
        .sign(privateKey),
    );
    return { jti, token };
  });
  const post = Effect.fn('AcceptanceIngress.post')(function* post(path: string, body: IngressBody, token: string) {
    const response = yield* Effect.promise(() =>
      runtime.handler(
        new Request(`http://localhost${path}`, {
          body: JSON.stringify(body),
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
            'x-correlation-id': 'payment-acceptance-ingress',
          },
          method: 'POST',
        }),
      ),
    );
    const text = yield* Effect.promise(() => response.text());
    return { status: response.status, text };
  });
  return { post, signAssertion };
});

const ingressScenario = Effect.fn('AcceptanceIngress.scenario')(function* ingressScenario(
  permission: 'allowed' | 'denied',
) {
  const { admin, runtime } = yield* testDatabaseClients;
  const database = {
    coreAdmin: yield* makeTestDatabaseFromClient(admin, coreRelations),
    database: yield* makeTestDatabaseFromClient(runtime, coreRelations),
    runtimeClient: runtime,
  } satisfies EvidenceNativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  yield* database.coreAdmin
    .insert(tenantModuleStates)
    .values({ moduleKey: 'payment.core', state: 'active', tenantId: scope.tenantId });
  const runtimes = yield* makeRuntimes(database, permission);
  const evidence = evidenceScenarioOf({ native: database, r1: runtimes, r2: runtimes, scope });
  yield* seedSourceAuthority(database.database, scope, {
    accountRef: 'CZ6508000000192000145399',
    environment: 'production',
    factFamily: 'BANK_ACCOUNTING_RECEIPT',
    method: 'BANK_TRANSFER_ADVANCE',
    refundRoute: false,
    sourceKind: 'BANK_ACCOUNTING',
    sourceSystem: 'erp-acceptance',
  });
  const payment = yield* evidence.createPayment(100_000, BANK_BINDING, 'BANK_TRANSFER_ADVANCE');
  const transport = yield* mountPaymentTransport(database, runtimes);
  const principal = principalOf(scope);

  const redemptionRows = (jti: string) =>
    database.coreAdmin
      .select({ audience: gatewayAssertionRedemptions.audience, issuer: gatewayAssertionRedemptions.issuer })
      .from(gatewayAssertionRedemptions)
      .where(and(eq(gatewayAssertionRedemptions.jti, jti), eq(gatewayAssertionRedemptions.issuer, ISSUER)));
  const businessFootprint = Effect.all(
    {
      observations: database.coreAdmin
        .select({ rows: count() })
        .from(observations)
        .where(eq(observations.tenantId, scope.tenantId)),
      operations: database.coreAdmin
        .select({ rows: count() })
        .from(paymentOperations)
        .where(eq(paymentOperations.tenantId, scope.tenantId)),
      outbox: database.coreAdmin
        .select({ rows: count() })
        .from(outboxMessages)
        .where(eq(outboxMessages.tenantId, scope.tenantId)),
    },
    { concurrency: 1 },
  );
  return { businessFootprint, payment, principal, redemptionRows, transport };
});

const collectionOf = (paymentId: string) =>
  ({
    amount: { amountMinor: 100_000, currency: 'CZK' },
    method: 'BANK_TRANSFER_ADVANCE',
    operationKey: 'collect-ingress',
    paymentId,
  }) satisfies typeof StartPaymentCollectionPayloadSchema.Encoded;

it.live(
  '#1153 Ingress credentials do not replace owner permission: a valid durably redeemed assertion without the Payment permission is denied before any business effect',
  () =>
    native(
      Effect.gen(function* ingressWithoutPermission() {
        const scenario = yield* ingressScenario('denied');
        const before = yield* scenario.businessFootprint;
        const refund = {
          amount: { amountMinor: 100_000, currency: 'CZK' },
          basis: {
            _tag: 'REFUNDABLE_ITEMS',
            items: [
              {
                amountMinor: 100_000,
                currency: 'CZK',
                itemRef: 'order-item-1',
                sourceEvidenceRef: 'order-item-proof-1',
              },
            ],
          },
          operationKey: 'refund-ingress',
          paymentId: scenario.payment.paymentId,
          reason: 'Customer returned the item',
        } satisfies typeof RequestPaymentRefundPayloadSchema.Encoded;
        const callback = {
          amount: { amountMinor: 100_000, currency: 'CZK' },
          factFamily: 'BANK_ACCOUNTING_RECEIPT',
          factKind: 'COLLECTION_CONFIRMED',
          paymentId: scenario.payment.paymentId,
          source: {
            accountRef: 'CZ6508000000192000145399',
            environment: 'production',
            sourceKind: 'BANK_ACCOUNTING',
            sourceSystem: 'erp-acceptance',
          },
          sourceOccurrenceId: `bank-line-${randomUUID()}`,
          sourceRevision: 1,
        } satisfies typeof AcceptPaymentObservationPayloadSchema.Encoded;
        const calls = [
          { body: collectionOf(scenario.payment.paymentId), path: '/payment/actions/start-payment-collection' },
          { body: refund, path: '/payment/actions/request-payment-refund' },
          { body: callback, path: '/payment/actions/accept-payment-observation' },
        ];
        for (const call of calls) {
          const assertion = yield* scenario.transport.signAssertion(scenario.principal);
          const response = yield* scenario.transport.post(call.path, call.body, assertion.token);
          // The owner boundary refuses the actor with the Core permission refusal, not a business error.
          expect([call.path, response.status, response.text.includes('action_permission_denied')]).toEqual([
            call.path,
            403,
            true,
          ]);
          // The assertion itself was valid and durably redeemed before the permission decision.
          expect(yield* scenario.redemptionRows(assertion.jti)).toEqual([{ audience: 'payment', issuer: ISSUER }]);
          // The redeemed credential cannot be presented again, independent of the permission outcome.
          const replay = yield* scenario.transport.post(call.path, call.body, assertion.token);
          expect([call.path, replay.status]).toEqual([call.path, 401]);
        }
        // No COLLECT, REFUND, observation, Domain Event or Outbox message exists for the Tenant.
        expect(yield* scenario.businessFootprint).toEqual(before);
      }),
    ),
);

it.live(
  '#1153 Ingress control: the same redeemed assertion path with the Payment permission creates the business effect',
  () =>
    native(
      Effect.gen(function* ingressWithPermission() {
        const scenario = yield* ingressScenario('allowed');
        const assertion = yield* scenario.transport.signAssertion(scenario.principal);
        const response = yield* scenario.transport.post(
          '/payment/actions/start-payment-collection',
          collectionOf(scenario.payment.paymentId),
          assertion.token,
        );
        expect([response.status, response.text.includes('"COLLECT"')]).toEqual([200, true]);
        expect(yield* scenario.redemptionRows(assertion.jti)).toHaveLength(1);
        const footprint = yield* scenario.businessFootprint;
        expect([footprint.operations, footprint.outbox]).toEqual([[{ rows: 1 }], [{ rows: 1 }]]);
      }),
    ),
);
