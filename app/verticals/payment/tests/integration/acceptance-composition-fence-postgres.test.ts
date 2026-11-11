import { OwnerActionApprovals } from '@app/core-runtime/access/approvals/owner-runtime';
import { defineDatabaseIdentityEnrollment, ActionRuntime, ReadRuntime } from '@app/core-runtime';
import { randomUUID } from 'node:crypto';

import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSource } from '@app/core-runtime/testing/application-composition-source';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, count, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { ConfigProvider, Crypto, DateTime, Effect, Exit, Layer, Schema } from 'effect';
import type { Scope } from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import {
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
  coreRelations,
  outboxMessages,
  tenantModuleStates,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  isApplicationCompositionDurableWorkDrained,
  lockApplicationCompositionAuthority,
} from '../../../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { makeModuleEntrypointGateway } from '../../../../packages/core-runtime/src/modules/module-entrypoint-gateway.ts';
import { makeOutboxRepository } from '../../../../packages/core-runtime/src/outbox/repository.ts';
import { makeModuleStateGate } from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import type { TenantModuleState } from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { makePaymentApiRuntime } from '../../api/index.ts';
import { paymentUnavailableOwnerPortsLive } from '../../api/payment-production-layers.ts';
import type { StartPaymentCollectionPayloadSchema } from '../../shared/actions/start-payment-collection.ts';
import type { CurrentPaymentRequestSchema } from '../../shared/apis/current-payment.ts';
import type { PaymentHistoryRequestSchema } from '../../shared/apis/payment-history.ts';
import type { PaymentGatewayAccountBinding } from '../../shared/domain/payment-execution-binding.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { startPaymentCollectionAction } from '../../src/actions/start-payment-collection.action.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../src/auth/gateway-assertion-redemption-runtime.ts';
import { paymentOperations } from '../../src/database/schema.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { makeLifecycleOwnerContractFixture } from '../support/lifecycle-owner-contract.fixture.ts';
import { failureCodeOf, makeTestScope } from './database-fixture.ts';
import {
  BANK_BINDING,
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  principalOf,
  RECOVERY_REQUESTED,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase } from './evidence-native-support.ts';

/**
 * #1153 TECH-02 "Composition phase/expiry/fence is independent from Tenant Module State" and the #1153
 * BDD "An unsafe unresolved task still prevents false completion" (TECH-01), on a disposable
 * schema-only clone of the worktree database (Core and Payment schema, no data) whose own Application
 * Composition authority row is the one under test. Nothing touches the shared database's authority.
 *
 * Every Payment call uses the real Core `lockApplicationCompositionAuthority`, never the always-open
 * fixture authority of the other suites. Reads and historical reads reach it through Payment's public
 * HTTP assembly with a Shell-signed, durably redeemed gateway assertion that carries the Composition
 * revision, exactly as in production. The Tenant Module State is decided by the real module-state gate.
 * The authority row is moved between phases by the publisher's admin connection of this owned clone,
 * as Core's own fence suite does; the drain scenario uses the real Core publication controls.
 */

const ISSUER = 'https://shell.payment-composition.test';
/** The exact GoPay account of `GATEWAY_BINDING`, as the C17 owner fixture enables it. */
const GOPAY_ACCOUNT: PaymentGatewayAccountBinding = {
  _tag: 'GATEWAY_ACCOUNT',
  environment: 'production',
  providerAccountRef: 'gopay-account-1',
  providerFamily: 'GOPAY',
};
type PublicCallBody =
  | typeof CurrentPaymentRequestSchema.Encoded
  | typeof PaymentHistoryRequestSchema.Encoded
  | typeof StartPaymentCollectionPayloadSchema.Encoded;

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const native = <A, E>(
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope>,
) => Effect.scoped(effect).pipe(Effect.provide(nativeServices));

/** A disposable clone with the approved Composition R1 published as its only authority. */
const isolatedPayment = Effect.fn('AcceptanceCompositionFence.isolated')(function* isolatedPayment() {
  const snapshot = yield* makeApplicationCompositionSnapshotFixture(['payment'], ultramodernApiMarker.buildMarker);
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1229-payment-entitlement',
    sourceConnections: yield* loadDatabaseConnectionPair(),
  });
  const admin = yield* makeTestPgClient(isolated.connections.admin.connectionString);
  const runtime = yield* makeTestPgClient(isolated.connections.runtime.connectionString);
  const database: EvidenceNativeDatabase = {
    coreAdmin: yield* makeTestDatabaseFromClient(admin, coreRelations),
    database: yield* makeTestDatabaseFromClient(runtime, coreRelations),
    runtimeClient: runtime,
  };
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  yield* database.coreAdmin
    .insert(tenantModuleStates)
    .values({ moduleKey: 'payment.core', state: 'active', tenantId: scope.tenantId });
  const { revision } = snapshot.composition;

  const moduleStateGate = makeModuleStateGate(makeTenantModuleStateService({ executor: database.coreAdmin }));
  const gateway = makeModuleEntrypointGateway(moduleStateGate);
  const accessDecision = makeScriptedBoundAccessGate('allowed').bound;
  const actions: ActionRuntimeService = makeActionRuntime(
    { executor: database.database },
    makeActionRepository(yield* Crypto.Crypto),
    evidenceAllowedPermission,
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision,
      contextAccess: evidenceContextAccess,
      lockCompositionAuthority: lockApplicationCompositionAuthority,
      moduleEntrypointGateway: gateway,
      moduleStateGate,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
      resolveCompositionRevision: () => Effect.succeed(revision),
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
  const evidence = evidenceScenarioOf({
    native: database,
    r1: { actions, reads },
    r2: { actions, reads },
    scope,
  });

  /** The publisher's view of this clone's single authority row. */
  const authority = database.coreAdmin
    .select({
      durableWorkAdmission: applicationCompositionAuthority.durableWorkAdmission,
      phase: applicationCompositionAuthority.phase,
      revision: applicationCompositionAuthority.revision,
    })
    .from(applicationCompositionAuthority)
    .pipe(Effect.map(([row]) => row));
  const setPhase = (phase: 'draining' | 'sealed') =>
    database.coreAdmin
      .update(applicationCompositionAuthority)
      .set({ phase })
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
  const setValidUntil = (validUntil: SQL) =>
    database.coreAdmin
      .update(applicationCompositionAuthority)
      .set({ validUntil })
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
  const expireAuthority = setValidUntil(sql`clock_timestamp() - interval '1 second'`);
  const renewAuthority = setValidUntil(sql`clock_timestamp() + interval '1 hour'`);
  const setModuleState = (state: TenantModuleState) =>
    database.coreAdmin
      .update(tenantModuleStates)
      .set({ state })
      .where(and(eq(tenantModuleStates.tenantId, scope.tenantId), eq(tenantModuleStates.moduleKey, 'payment.core')));

  return {
    actions,
    authority,
    database,
    evidence,
    expireAuthority,
    isolated,
    principal: principalOf(scope),
    reads,
    renewAuthority,
    revision,
    scope,
    setModuleState,
    setPhase,
    snapshot,
  };
});
type IsolatedPayment = Effect.Success<ReturnType<typeof isolatedPayment>>;

/** Payment's public HTTP assembly over the clone, with durable assertion redemption. */
const mountPaymentTransport = Effect.fn('AcceptanceCompositionFence.mount')(function* mount(payment: IsolatedPayment) {
  const compositionDocument = yield* Schema.encodeEffect(
    Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
  )(payment.snapshot);
  const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
  const publicJwk = {
    ...(yield* Effect.promise(() => exportJWK(publicKey))),
    alg: 'EdDSA',
    kid: 'payment-composition-fence',
    use: 'sig',
  };
  const assembled = makePaymentApiRuntime(
    Layer.succeed(ReadRuntime, payment.reads).pipe(Layer.provideMerge(paymentUnavailableOwnerPortsLive)),
    Layer.mergeAll(
      Layer.succeed(ActionRuntime, payment.actions),
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
      Layer.provide(Layer.succeed(PgClient.PgClient, payment.database.runtimeClient)),
    ),
  );
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(() => assembled.createHandler()),
    (resource) => Effect.promise(() => resource.dispose()).pipe(Effect.orDie),
  );
  const signAssertion = Effect.promise(() =>
    new SignJWT({
      compositionRevision: payment.revision,
      principal: {
        authBindingId: payment.principal.authBindingId,
        authContextRef: payment.principal.authContextRef,
        authMethod: payment.principal.authMethod,
        legalEntityId: payment.principal.legalEntityId,
        principalId: payment.principal.principalId,
        tenantId: payment.principal.tenantId,
      },
      targetBuildMarker: ultramodernApiMarker.buildMarker,
      ver: 1,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: publicJwk.kid, typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience('payment')
      .setSubject(payment.principal.principalId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti(randomUUID())
      .sign(privateKey),
  );
  /** One public call with a fresh assertion; the status and Problem body are what a client sees. */
  const post = Effect.fn('AcceptanceCompositionFence.post')(function* post(path: string, body: PublicCallBody) {
    const token = yield* signAssertion;
    const response = yield* Effect.promise(() =>
      runtime.handler(
        new Request(`http://localhost${path}`, {
          body: JSON.stringify(body),
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
            'x-correlation-id': 'payment-composition-fence',
          },
          method: 'POST',
        }),
      ),
    );
    return { status: response.status, text: yield* Effect.promise(() => response.text()) };
  });
  return { post };
});

it.live(
  '#1153 Composition phase and expiry fence every Payment write, read and historical read independently of Tenant Module State',
  () =>
    native(
      Effect.gen(function* compositionFence() {
        const payment = yield* isolatedPayment();
        const transport = yield* mountPaymentTransport(payment);
        const target = yield* payment.evidence.createPayment(100_000, BANK_BINDING, 'BANK_TRANSFER_ADVANCE');
        /** The three declared entrypoint classes, each against a fresh Payment for the write. */
        const matrix = Effect.gen(function* callMatrix() {
          const fresh = yield* payment.evidence.createPayment(100_000, BANK_BINDING, 'BANK_TRANSFER_ADVANCE');
          const write = yield* transport.post('/payment/actions/start-payment-collection', {
            amount: { amountMinor: 100_000, currency: 'CZK' },
            method: 'BANK_TRANSFER_ADVANCE',
            operationKey: 'collect-fence',
            paymentId: fresh.paymentId,
          } satisfies typeof StartPaymentCollectionPayloadSchema.Encoded);
          const read = yield* transport.post('/reads/current-payment', { paymentId: target.paymentId });
          const history = yield* transport.post('/reads/payment-history', { paymentId: target.paymentId });
          return { history: history.status, read: read.status, write: write.status };
        });
        const operations = payment.database.coreAdmin
          .select({ rows: count() })
          .from(paymentOperations)
          .where(eq(paymentOperations.tenantId, payment.scope.tenantId))
          .pipe(Effect.map(([row]) => row?.rows ?? 0));

        // Active, unexpired R1 and an active Tenant Module State: every class is admitted.
        expect(yield* matrix).toEqual({ history: 200, read: 200, write: 200 });
        expect(yield* operations).toBe(1);

        // Tenant Module State alone: `inactive` denies read and write but keeps history while R1 admits all.
        yield* payment.setModuleState('inactive');
        const beforeInactive = yield* operations;
        expect(yield* matrix).toEqual({ history: 200, read: 403, write: 403 });
        expect(yield* operations).toBe(beforeInactive);
        yield* payment.setModuleState('active');

        // Composition alone: each refusal below happens with the Tenant Module State `active`.
        const refusedByComposition = Effect.gen(function* refused() {
          const before = yield* operations;
          const statuses = yield* matrix;
          expect(statuses).toEqual({ history: 503, read: 503, write: 503 });
          // A refused write leaves no Payment Operation behind.
          expect(yield* operations).toBe(before);
        });
        yield* payment.expireAuthority;
        yield* refusedByComposition;
        // An expired authority even refuses the historical projection `inactive` would still allow.
        yield* payment.setModuleState('inactive');
        expect((yield* matrix).history).toBe(503);
        yield* payment.setModuleState('active');

        // The refusal was the expiry: the renewed authority admits every class again.
        yield* payment.renewAuthority;
        expect(yield* matrix).toEqual({ history: 200, read: 200, write: 200 });

        yield* payment.setPhase('draining');
        yield* refusedByComposition;
        yield* payment.setPhase('sealed');
        yield* refusedByComposition;
        expect(yield* payment.authority).toMatchObject({ phase: 'sealed', revision: payment.revision });
      }),
    ),
  { timeout: 120_000 },
);

it.live(
  '#1153 An unsafe unresolved task still prevents false completion: closing admission and asking for drain keeps the COLLECT debt explicit',
  () =>
    native(
      Effect.gen(function* unresolvedTaskHoldsDrain() {
        const payment = yield* isolatedPayment();
        const { evidence } = payment;
        const owners = yield* makeLifecycleOwnerContractFixture({
          enabledBindings: [GOPAY_ACCOUNT],
          gatewayAvailable: true,
          metadataRevision: 1,
          termUse: 'USABLE',
        });
        // Accepted original work: a gateway COLLECT admitted under R1 whose provider response was lost.
        const created = yield* evidence.createPayment();
        const { operation: collect } = yield* payment.actions
          .runAction({
            payload: {
              amount: { amountMinor: 100_000, currency: 'CZK' },
              method: 'ONLINE_GATEWAY',
              operationKey: 'collect-unresolved',
              paymentId: created.paymentId,
            },
            principal: payment.principal,
            registration: startPaymentCollectionAction,
            transport: { correlationId: 'payment-composition-collect', idempotencyKey: randomUUID() },
          })
          .pipe(Effect.provide(owners.layer));
        const recovery = {
          operationId: collect.operationId,
          paymentId: created.paymentId,
          reason: 'The provider create response was lost and lookup credentials are missing',
        };
        yield* evidence.recover({ ...recovery, trigger: 'EXECUTION_OUTCOME_UNKNOWN' });
        const held = yield* evidence.recover({ ...recovery, trigger: 'LOOKUP_AUTHORITY_UNAVAILABLE' });
        expect(held).toMatchObject({ heldForReconciliation: true, operationOutcome: 'INDETERMINATE' });
        const [openCase] = yield* evidence.rows.cases(created.paymentId);
        const debtBefore = {
          cases: yield* evidence.rows.cases(created.paymentId),
          operations: yield* evidence.rows.operations(created.paymentId),
          transitions: yield* evidence.rows.transitions(collect.operationId),
        };
        expect(debtBefore.operations.map((row) => [row.outcome, row.compositionRevision])).toEqual([
          ['INDETERMINATE', payment.revision],
        ]);
        const paymentMessages = payment.database.coreAdmin
          .select({ matchedAt: outboxMessages.matchedAt, topic: outboxMessages.topic })
          .from(outboxMessages)
          .where(
            and(
              eq(outboxMessages.tenantId, payment.scope.tenantId),
              eq(outboxMessages.producerModuleKey, 'payment.core'),
            ),
          );
        expect(new Set((yield* paymentMessages).map((message) => message.topic))).toEqual(
          new Set(['payment.core.operation-requested.v1', RECOVERY_REQUESTED]),
        );
        const trackedPaymentWork = payment.database.coreAdmin
          .select({ workId: applicationCompositionDurableWork.workId })
          .from(applicationCompositionDurableWork)
          .where(
            and(
              eq(applicationCompositionDurableWork.ownerModuleKey, 'payment.core'),
              eq(applicationCompositionDurableWork.originalRevision, payment.revision),
            ),
          );
        // The unknown effect is Core durable work of payment.core under the revision that admitted it.
        const unknownCollectWork = [`payment-operation:${payment.scope.tenantId}:${collect.operationId}`];
        expect((yield* trackedPaymentWork).map((work) => work.workId)).toEqual(unknownCollectWork);

        // Publication closes new durable admission and asks for drain completion through Core.
        yield* payment.isolated.composition.closeAdmission();
        expect(yield* payment.authority).toMatchObject({ durableWorkAdmission: 'closed', phase: 'active' });
        const durableWorkDrained = payment.database.coreAdmin.transaction((transaction) =>
          isApplicationCompositionDurableWorkDrained(transaction, payment.revision),
        );
        // The tracked unknown effect holds R1: drain cannot start, drain is not complete, R1 cannot seal.
        expect(Exit.isFailure(yield* Effect.exit(payment.isolated.composition.drain()))).toBe(true);
        expect(yield* durableWorkDrained).toBe(false);
        expect(Exit.isFailure(yield* Effect.exit(payment.isolated.composition.seal()))).toBe(true);
        expect(yield* payment.authority).toMatchObject({ phase: 'active', revision: payment.revision });

        // The original debt stays explicit: no fake DONE, no deleted work, no R1-to-R2 relabelling.
        expect({
          cases: yield* evidence.rows.cases(created.paymentId),
          operations: yield* evidence.rows.operations(created.paymentId),
          transitions: yield* evidence.rows.transitions(collect.operationId),
        }).toEqual(debtBefore);
        expect((yield* paymentMessages).every((message) => message.matchedAt === null)).toBe(true);
        expect(openCase?.status).toBe('OPEN');
        // No privileged bypass: closing the case is refused while the obligation is unresolved.
        const closeCase = yield* failureCodeOf(
          evidence.decide({
            caseId: openCase?.caseId ?? '',
            decision: { _tag: 'CLOSE_CASE', evidenceRef: 'operator-release-note' },
            reason: 'Close the case so the release can drain',
          }),
        );
        expect(closeCase).toBe('payment_reconciliation_obligation_unresolved');
        expect(yield* evidence.rows.cases(created.paymentId)).toEqual(debtBefore.cases);

        // Core's real Outbox matcher keeps running while admission is closed. No consumer of Payment's
        // topics is in this composition, so it records the rows as matched with zero deliveries: that is
        // delivery bookkeeping, never completion of the Payment work.
        const matched = yield* makeOutboxRepository(payment.database.database, yield* Crypto.Crypto).matchUnmatched(
          payment.revision,
          yield* DateTime.nowAsDate,
        );
        expect(matched).toEqual({ deliveriesCreated: 0, messagesMatched: 2 });
        expect((yield* paymentMessages).every((message) => message.matchedAt !== null)).toBe(true);
        // Matched Outbox rows do not release R1: the unknown COLLECT is still tracked, so it neither
        // drains nor seals.
        expect(yield* durableWorkDrained).toBe(false);
        expect(Exit.isFailure(yield* Effect.exit(payment.isolated.composition.drain()))).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(payment.isolated.composition.seal()))).toBe(true);
        expect((yield* trackedPaymentWork).map((work) => work.workId)).toEqual(unknownCollectWork);
        expect({
          cases: yield* evidence.rows.cases(created.paymentId),
          operations: yield* evidence.rows.operations(created.paymentId),
          transitions: yield* evidence.rows.transitions(collect.operationId),
        }).toEqual(debtBefore);
      }),
    ),
  { timeout: 120_000 },
);
