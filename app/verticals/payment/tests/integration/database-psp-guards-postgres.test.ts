import type { ScopedRoutineInvoker } from '@app/core-runtime';
import type { PgClient } from '@effect/sql-pg';
import { DateTime, Effect, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  GatewayProviderAccountBindingIdSchema,
  GatewayProviderAccountRefSchema,
} from '../../shared/domain/psp-configuration.ts';
import type {
  GatewayProviderAccountBindingId,
  GatewayProviderAccountRef,
} from '../../shared/domain/psp-configuration.ts';
import {
  PspEvidenceIdSchema,
  PspNotificationIdSchema,
  pspAppendEvidence,
  pspHasUnresolvedRefund,
  pspMarkEvidenceSubmission,
  pspPinEvidenceSubmissionExecutor,
  pspPrepareDispatch,
  pspReadDispatch,
  pspReadOperationForExecution,
  pspRecordDispatchOutcome,
  pspRegisterCancel,
  pspTransitionNotification,
} from '../../src/persistence/psp-worker-routines.ts';
import type {
  PspAppendEvidenceInput,
  PspPrepareDispatchInput,
  PspWorkerOrigin,
} from '../../src/persistence/psp-worker-routines.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import { configuredRefundExecutionRouteFor } from '../support/refund-execution-route.fixture.ts';
import {
  COMPOSITION_REVISION,
  collectInput,
  expectSqlFailure,
  inScope,
  makeTestScope,
  newPaymentInput,
  operationalScopeOf,
  paymentTestRelations,
  provenanceFor,
  randomUuid,
  withPersistence,
} from './database-fixture.ts';
import type { PaymentTestDatabase, PaymentTestScope } from './database-fixture.ts';

type PaymentGatewayProviderFamily = typeof PaymentGatewayProviderFamilySchema.Type;
type PaymentTestTransaction = Parameters<Parameters<PaymentTestDatabase['transaction']>[0]>[0];

const WORKER_KEY = 'payment.core.execute-gateway-operation';
const REQUEST_HASH = 'a'.repeat(64);

/** Runs scoped worker routines inside one Core-scoped runtime transaction, as the worker scope receives them. */
const withRoutines = <Value, Failure>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  operation: (invoker: ScopedRoutineInvoker) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PaymentTestTransaction) =>
    installOperationalScope(transaction, operationalScopeOf(scope)).pipe(Effect.flatMap(operation)),
  );

const workerOrigin = Effect.all([randomUuid, randomUuid], { concurrency: 1 }).pipe(
  Effect.map(([deliveryId, originActionInvocationId]): PspWorkerOrigin => ({
    compositionRevision: COMPOSITION_REVISION,
    deliveryId,
    originActionInvocationId,
    workerKey: WORKER_KEY,
  })),
);

const accountRefFrom = (uuid: string) =>
  Schema.decodeEffect(GatewayProviderAccountRefSchema)(`pab_${uuid.replaceAll('-', '')}`);

interface GatewayFixture {
  readonly accountRef: GatewayProviderAccountRef;
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly collectMaterialHash: string;
  readonly collectOperationId: string;
  readonly family: PaymentGatewayProviderFamily;
  readonly paymentId: string;
}

const MERCHANT_IDENTITIES = {
  COMGATE: '{"_tag":"COMGATE","merchantId":"123456"}',
  GOPAY: '{"_tag":"GOPAY","goid":"8123456789"}',
  STRIPE: '{"_tag":"STRIPE","accountId":"acct_1TestAccount"}',
} as const satisfies Record<PaymentGatewayProviderFamily, string>;

/** Inserts one CURRENT binding and its ACTIVE credential the way the configuration Action does. */
const insertBinding = (
  runtimeClient: PgClient.PgClient,
  scope: PaymentTestScope,
  input: {
    readonly accountRef: string;
    readonly bindingId: string;
    readonly family: PaymentGatewayProviderFamily;
    readonly merchantIdentity: string;
  },
) =>
  inScope(
    runtimeClient,
    scope,
    Effect.gen(function* insertBindingAndCredential() {
      yield* runtimeClient.unsafe(
        `insert into payment.psp_provider_account_bindings (tenant_id, legal_entity_id, action_invocation_id,
           actor_principal_id, composition_revision, binding_id, configured_at, current_credential_revision,
           environment, merchant_identity, notification_url, provider_account_ref, provider_family, reason, revision, status)
         values ($1, $2, gen_random_uuid(), $3, $4, $5, now(), 1, 'SANDBOX', $6::jsonb,
           'https://hooks.example.test/psp', $7, $8, 'Configure the sandbox gateway account', 1, 'CURRENT')`,
        [
          scope.tenantId,
          scope.legalEntityId,
          scope.principalId,
          COMPOSITION_REVISION,
          input.bindingId,
          input.merchantIdentity,
          input.accountRef,
          input.family,
        ],
      );
      yield* runtimeClient.unsafe(
        `insert into payment.psp_credential_revisions (tenant_id, legal_entity_id, action_invocation_id,
           actor_principal_id, composition_revision, binding_id, recorded_at, revision, secret_ref, status)
         values ($1, $2, gen_random_uuid(), $3, $4, $5, now(), 1, 'sandbox-credential-1', 'ACTIVE')`,
        [scope.tenantId, scope.legalEntityId, scope.principalId, COMPOSITION_REVISION, input.bindingId],
      );
    }),
  );

const gatewayFixture = Effect.fn('PspGuardsFixture.gateway')(function* gatewayFixture(
  runtime: PaymentTestDatabase,
  runtimeClient: PgClient.PgClient,
  scope: PaymentTestScope,
  family: PaymentGatewayProviderFamily = 'STRIPE',
) {
  const [refSeed, bindingSeed] = yield* Effect.all([randomUuid, randomUuid], { concurrency: 1 });
  const [accountRef, bindingId] = yield* Effect.all(
    [accountRefFrom(refSeed), Schema.decodeEffect(GatewayProviderAccountBindingIdSchema)(bindingSeed)],
    { concurrency: 1 },
  );
  const executionBinding = {
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: accountRef,
    providerFamily: family,
  } as const;
  yield* insertBinding(runtimeClient, scope, {
    accountRef,
    bindingId,
    family,
    merchantIdentity: MERCHANT_IDENTITIES[family],
  });
  const paymentInput = yield* newPaymentInput(scope);
  const created = yield* withPersistence(runtime, scope, (persistence) =>
    persistence.insertPayment({ ...paymentInput, executionBinding }),
  );
  const { paymentId } = created.record;
  const collect = yield* collectInput(scope, { amountMinor: 100_000, paymentId }, 'collect-1');
  const collected = yield* withPersistence(runtime, scope, (persistence) =>
    persistence.insertOperation({ ...collect, binding: executionBinding }),
  );
  return {
    accountRef,
    bindingId,
    collectMaterialHash: collected.record.materialHash,
    collectOperationId: collected.record.operationId,
    family,
    paymentId,
  } satisfies GatewayFixture;
});

const gatewayBindingOf = (fixture: GatewayFixture) =>
  ({
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: fixture.accountRef,
    providerFamily: fixture.family,
  }) as const;

const cancelOperation = Effect.fn('PspGuardsFixture.cancel')(function* cancelOperation(
  runtime: PaymentTestDatabase,
  scope: PaymentTestScope,
  fixture: GatewayFixture,
) {
  const provenance = yield* provenanceFor(scope);
  const cancelled = yield* withPersistence(runtime, scope, (persistence) =>
    persistence.insertOperation({
      amount: { amountMinor: 0, currency: 'CZK' },
      binding: gatewayBindingOf(fixture),
      initialOutcome: 'PENDING',
      kind: 'CANCEL_OR_VOID',
      materialRequest: { kind: 'CANCEL_OR_VOID', targetOperationId: fixture.collectOperationId },
      operationKey: 'cancel-1',
      paymentId: fixture.paymentId,
      provenance,
      targetOperationId: fixture.collectOperationId,
    }),
  );
  return { materialHash: cancelled.record.materialHash, operationId: cancelled.record.operationId };
});

const REQUEST_HEADERS = [
  { name: 'content-type', value: 'application/x-www-form-urlencoded' },
  { name: 'idempotency-key', value: 'ontos-pop-key' },
];

const prepareInput = (fixture: GatewayFixture, origin: PspWorkerOrigin): PspPrepareDispatchInput => ({
  bindingId: fixture.bindingId,
  credentialRevision: 1,
  endpointRef: 'stripe:checkout-session-create',
  idempotencyKeyHash: Option.some('b'.repeat(64)),
  materialHash: fixture.collectMaterialHash,
  operationId: fixture.collectOperationId,
  origin,
  providerPaymentRef: Option.none(),
  replayRequest: Option.some({
    body: new TextEncoder().encode('mode=payment&amount=100000'),
    headers: REQUEST_HEADERS,
    windowMs: 86_400_000,
  }),
  requestHash: REQUEST_HASH,
  returnToken: Option.some('AbCdEfGhIjKlMnOpQrStUv'),
});

/** The refusal reason of a CONFLICT outcome; none for every other outcome. */
const conflictReason = <Value extends { readonly _tag: string }>(value: Value) =>
  Predicate.isTagged(value, 'CONFLICT') && Predicate.hasProperty(value, 'reason')
    ? Option.some(value.reason)
    : Option.none();

/** Asserts the routine outcome and narrows to it; a different outcome fails the test. */
const expectTagged = <Value extends { readonly _tag: string }, Tag extends Value['_tag']>(value: Value, tag: Tag) =>
  Effect.sync(() => expect(Predicate.isTagged(value, tag)).toBe(true)).pipe(
    Effect.andThen(Predicate.isTagged(value, tag) ? Effect.succeed(value) : Effect.never),
  );

const dispatchCount = (runtimeClient: PgClient.PgClient, scope: PaymentTestScope, operationId: string) =>
  inScope(
    runtimeClient,
    scope,
    runtimeClient.unsafe<{ count: number }>(
      'select count(*)::integer as count from payment.psp_provider_dispatches where operation_id = $1',
      [operationId],
    ),
  ).pipe(Effect.map((rows) => rows[0]?.count ?? -1));

it.live('#1158 One dispatch per Payment Operation', () =>
  Effect.scoped(
    Effect.gen(function* oneDispatchPerOperation() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope);
      const [first, second] = yield* Effect.all([workerOrigin, workerOrigin], { concurrency: 1 });

      const prepared = yield* withRoutines(runtime, scope, (invoker) =>
        pspPrepareDispatch(invoker, prepareInput(fixture, first)),
      );
      const preparedRow = yield* expectTagged(prepared, 'PREPARED');
      expect(preparedRow.record.state).toBe('PREPARED');
      expect(preparedRow.record.orderReference).toBe(fixture.collectOperationId.replaceAll('-', ''));
      expect(preparedRow.record.materialHash).toBe(fixture.collectMaterialHash);
      expect(preparedRow.record.originActionInvocationId).toBe(first.originActionInvocationId);
      expect(
        Option.fromUndefinedOr(preparedRow.record.requestBody).pipe(
          Option.map((body) => new TextDecoder().decode(body)),
        ),
      ).toEqual(Option.some('mode=payment&amount=100000'));
      expect(preparedRow.record.requestHeaders).toEqual(REQUEST_HEADERS);
      expect(preparedRow.record.replayStartsAt).toEqual(preparedRow.record.preparedAt);
      expect(
        Option.all([
          Option.fromUndefinedOr(preparedRow.record.replayStartsAt),
          Option.fromUndefinedOr(preparedRow.record.replayExpiresAt),
        ]).pipe(Option.map(([starts, expires]) => DateTime.toEpochMillis(expires) - DateTime.toEpochMillis(starts))),
      ).toEqual(Option.some(86_400_000));

      // A redelivery (another delivery of the same admitted work) and a concurrent executor reuse the row.
      const [redelivered, concurrent] = yield* Effect.all(
        [
          withRoutines(runtime, scope, (invoker) => pspPrepareDispatch(invoker, prepareInput(fixture, second))),
          withRoutines(runtime, scope, (invoker) => pspPrepareDispatch(invoker, prepareInput(fixture, second))),
        ],
        { concurrency: 2 },
      );
      for (const repeated of [redelivered, concurrent]) {
        const existing = yield* expectTagged(repeated, 'EXISTING');
        expect(existing.record.dispatchId).toBe(preparedRow.record.dispatchId);
        expect(existing.record.deliveryId).toBe(first.deliveryId);
      }
      expect(yield* dispatchCount(runtimeClient, scope, fixture.collectOperationId)).toBe(1);
      const read = yield* withRoutines(runtime, scope, (invoker) =>
        pspReadDispatch(invoker, fixture.collectOperationId),
      );
      expect(read.pipe(Option.map((record) => record.dispatchId))).toEqual(Option.some(preparedRow.record.dispatchId));
    }),
  ),
);

it.live('#1158 Changed material under the same operation is a conflict', () =>
  Effect.scoped(
    Effect.gen(function* changedMaterialConflicts() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope);
      const origin = yield* workerOrigin;

      // Before any row exists, a material hash other than the C16 operation's is refused outright.
      const foreignMaterial = yield* withRoutines(runtime, scope, (invoker) =>
        pspPrepareDispatch(invoker, { ...prepareInput(fixture, origin), materialHash: 'c'.repeat(64) }),
      );
      expect(conflictReason(foreignMaterial)).toEqual(Option.some('material_mismatch'));
      expect(yield* dispatchCount(runtimeClient, scope, fixture.collectOperationId)).toBe(0);

      yield* withRoutines(runtime, scope, (invoker) => pspPrepareDispatch(invoker, prepareInput(fixture, origin)));
      const changedMaterial = yield* withRoutines(runtime, scope, (invoker) =>
        pspPrepareDispatch(invoker, { ...prepareInput(fixture, origin), materialHash: 'd'.repeat(64) }),
      );
      expect(conflictReason(changedMaterial)).toEqual(Option.some('material_mismatch'));
      const changedRequest = yield* withRoutines(runtime, scope, (invoker) =>
        pspPrepareDispatch(invoker, { ...prepareInput(fixture, origin), requestHash: 'e'.repeat(64) }),
      );
      expect(conflictReason(changedRequest)).toEqual(Option.some('request_mismatch'));
      const changedHeaders = yield* withRoutines(runtime, scope, (invoker) =>
        pspPrepareDispatch(invoker, {
          ...prepareInput(fixture, origin),
          replayRequest: Option.some({
            body: new TextEncoder().encode('mode=payment&amount=100000'),
            headers: [REQUEST_HEADERS[0] ?? { name: 'content-type', value: '' }],
            windowMs: 86_400_000,
          }),
        }),
      );
      expect(conflictReason(changedHeaders)).toEqual(Option.some('request_mismatch'));
      expect(yield* dispatchCount(runtimeClient, scope, fixture.collectOperationId)).toBe(1);
      const stored = yield* withRoutines(runtime, scope, (invoker) =>
        pspReadDispatch(invoker, fixture.collectOperationId),
      );
      expect(stored.pipe(Option.map((record) => [record.materialHash, record.requestHash]))).toEqual(
        Option.some([fixture.collectMaterialHash, REQUEST_HASH]),
      );
    }),
  ),
);

it.live('#1158 Illegal dispatch transitions are rejected by the routine and by PostgreSQL', () =>
  Effect.scoped(
    Effect.gen(function* illegalTransitions() {
      const { admin, runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope);
      const origin = yield* workerOrigin;
      yield* withRoutines(runtime, scope, (invoker) => pspPrepareDispatch(invoker, prepareInput(fixture, origin)));
      const outcome = (to: 'ACKNOWLEDGED' | 'OUTCOME_UNKNOWN' | 'TARGET_UNRESOLVED') =>
        withRoutines(runtime, scope, (invoker) =>
          pspRecordDispatchOutcome(invoker, {
            customerRedirectUrl:
              to === 'ACKNOWLEDGED' ? Option.some('https://checkout.example.test/c/1') : Option.none(),
            deliveryId: origin.deliveryId,
            operationId: fixture.collectOperationId,
            providerPaymentRef: to === 'ACKNOWLEDGED' ? Option.some('cs_test_1') : Option.none(),
            providerRefundRef: Option.none(),
            to,
          }),
        );

      expect(Predicate.isTagged(yield* outcome('TARGET_UNRESOLVED'), 'CONFLICT')).toBe(true);
      expect(Predicate.isTagged(yield* outcome('ACKNOWLEDGED'), 'RECORDED')).toBe(true);
      expect(Predicate.isTagged(yield* outcome('ACKNOWLEDGED'), 'UNCHANGED')).toBe(true);
      const regress = yield* outcome('OUTCOME_UNKNOWN');
      expect(conflictReason(regress)).toEqual(Option.some('illegal_transition'));

      // Even the owning migration identity cannot bypass the transition graph or rewrite identity.
      const ownerSql = (statement: string) =>
        inScope(admin, scope, admin.unsafe(statement, [scope.tenantId, fixture.collectOperationId]));
      yield* expectSqlFailure(
        ownerSql(
          "update payment.psp_provider_dispatches set state = 'PREPARED' where tenant_id = $1 and operation_id = $2",
        ),
        '23514',
        'payment_psp_dispatch_transition_ck',
      );
      yield* expectSqlFailure(
        ownerSql(
          "update payment.psp_provider_dispatches set material_hash = repeat('f', 64) where tenant_id = $1 and operation_id = $2",
        ),
        '23514',
        'payment_psp_dispatch_transition_ck',
      );
      yield* expectSqlFailure(
        ownerSql(
          "update payment.psp_provider_dispatches set provider_payment_ref = 'cs_test_other' where tenant_id = $1 and operation_id = $2",
        ),
        '23514',
        'payment_psp_dispatch_transition_ck',
      );
      yield* expectSqlFailure(
        ownerSql('delete from payment.psp_provider_dispatches where tenant_id = $1 and operation_id = $2'),
        '23514',
        'payment_append_only_ck',
      );
    }),
  ),
);

it.live('#1156 Cancellation races with collection', () =>
  Effect.scoped(
    Effect.gen(function* cancellationRaces() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const origin = yield* workerOrigin;
      const register = (
        scope: PaymentTestScope,
        fixture: GatewayFixture,
        cancel: { readonly materialHash: string; readonly operationId: string },
      ) =>
        withRoutines(runtime, scope, (invoker) =>
          pspRegisterCancel(invoker, {
            bindingId: fixture.bindingId,
            materialHash: cancel.materialHash,
            operationId: cancel.operationId,
            origin,
          }),
        );

      // Collection prepared first: the cancel registers and sees the in-flight target under the lock.
      const collectFirstScope = yield* makeTestScope;
      const collectFirst = yield* gatewayFixture(runtime, runtimeClient, collectFirstScope);
      const collectFirstCancel = yield* cancelOperation(runtime, collectFirstScope, collectFirst);
      const preparedFirst = yield* withRoutines(runtime, collectFirstScope, (invoker) =>
        pspPrepareDispatch(invoker, prepareInput(collectFirst, origin)),
      );
      expect(Predicate.isTagged(preparedFirst, 'PREPARED')).toBe(true);
      const registeredAfter = yield* register(collectFirstScope, collectFirst, collectFirstCancel);
      const afterCollect = yield* expectTagged(registeredAfter, 'REGISTERED');
      expect(afterCollect.cancel.state).toBe('AWAITING_TARGET');
      expect(afterCollect.target?.state).toBe('PREPARED');

      // Cancel registered first: the collection is withheld and never prepared for sending.
      const cancelFirstScope = yield* makeTestScope;
      const cancelFirst = yield* gatewayFixture(runtime, runtimeClient, cancelFirstScope);
      const cancelFirstCancel = yield* cancelOperation(runtime, cancelFirstScope, cancelFirst);
      const registeredBefore = yield* register(cancelFirstScope, cancelFirst, cancelFirstCancel);
      expect((yield* expectTagged(registeredBefore, 'REGISTERED')).target).toBeUndefined();
      const withheld = yield* withRoutines(runtime, cancelFirstScope, (invoker) =>
        pspPrepareDispatch(invoker, prepareInput(cancelFirst, origin)),
      );
      const withheldRow = yield* expectTagged(withheld, 'WITHHELD');
      expect([withheldRow.record.state, withheldRow.record.notSentReason]).toEqual([
        'NOT_SENT',
        'WITHHELD_FOR_CANCELLATION',
      ]);
      expect(withheldRow.record.requestHash).toBeUndefined();
      // The registered cancel is idempotent on redelivery and now sees the withheld target.
      const reRegistered = yield* register(cancelFirstScope, cancelFirst, cancelFirstCancel);
      expect((yield* expectTagged(reRegistered, 'EXISTING')).target?.notSentReason).toBe('WITHHELD_FOR_CANCELLATION');

      // Truly concurrent: the advisory lock serializes both decisions into one of the two consistent orders.
      const raceScope = yield* makeTestScope;
      const race = yield* gatewayFixture(runtime, runtimeClient, raceScope);
      const raceCancel = yield* cancelOperation(runtime, raceScope, race);
      const [raced, racedRegistration] = yield* Effect.all(
        [
          withRoutines(runtime, raceScope, (invoker) => pspPrepareDispatch(invoker, prepareInput(race, origin))),
          register(raceScope, race, raceCancel),
        ],
        { concurrency: 2 },
      );
      const racedTarget = (yield* expectTagged(racedRegistration, 'REGISTERED')).target;
      expect(
        (Predicate.isTagged(raced, 'PREPARED') && racedTarget?.state === 'PREPARED') ||
          (Predicate.isTagged(raced, 'WITHHELD') && racedTarget === undefined),
      ).toBe(true);
    }),
  ),
);

const insertNotification = (
  runtimeClient: PgClient.PgClient,
  scope: PaymentTestScope,
  input: {
    readonly accountRef: string;
    readonly bindingId: string;
    readonly deliveryIdentity: string;
    readonly family: string;
  },
) =>
  inScope(
    runtimeClient,
    scope,
    runtimeClient.unsafe<{ notification_id: string }>(
      `insert into payment.psp_provider_notifications (tenant_id, legal_entity_id, action_invocation_id,
         actor_principal_id, composition_revision, authenticity, binding_id, delivery_identity, environment, headers,
         provider_account_ref, provider_family, provider_refs, query, raw_body, received_at, state,
         transport_delivery_ref, verified_at)
       values ($1, $2, gen_random_uuid(), $3, $4, 'LOOKUP_REQUIRED', $5, $6, 'SANDBOX', '{}'::jsonb, $7, $8,
         '[]'::jsonb, '{}'::jsonb, convert_to('{}', 'UTF8'), now(), 'CAPTURED', 'relay-delivery-1', now())
       returning notification_id`,
      [
        scope.tenantId,
        scope.legalEntityId,
        scope.principalId,
        COMPOSITION_REVISION,
        input.bindingId,
        input.deliveryIdentity,
        input.accountRef,
        input.family,
      ],
    ),
  );

it.live('#1157 Notification delivery identity is unique per binding', () =>
  Effect.scoped(
    Effect.gen(function* notificationIdentity() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope);
      const [otherRefSeed, otherBindingId] = yield* Effect.all([randomUuid, randomUuid], { concurrency: 1 });
      const otherAccountRef = yield* accountRefFrom(otherRefSeed);
      yield* insertBinding(runtimeClient, scope, {
        accountRef: otherAccountRef,
        bindingId: otherBindingId,
        family: 'GOPAY',
        merchantIdentity: '{"_tag":"GOPAY","goid":"8123456789"}',
      });
      const deliveryIdentity = 'gopay:3000006529:relay-delivery-1';

      const [captured] = yield* insertNotification(runtimeClient, scope, {
        accountRef: fixture.accountRef,
        bindingId: fixture.bindingId,
        deliveryIdentity,
        family: 'STRIPE',
      });
      yield* expectSqlFailure(
        insertNotification(runtimeClient, scope, {
          accountRef: fixture.accountRef,
          bindingId: fixture.bindingId,
          deliveryIdentity,
          family: 'STRIPE',
        }),
        '23505',
        'payment_psp_notifications_delivery_uk',
      );
      // The same delivery identity under another binding is another delivery.
      const [otherBinding] = yield* insertNotification(runtimeClient, scope, {
        accountRef: otherAccountRef,
        bindingId: otherBindingId,
        deliveryIdentity,
        family: 'GOPAY',
      });
      expect(otherBinding?.notification_id).not.toBe(captured?.notification_id);

      // Processing columns move only through the routine; the runtime role cannot update them directly.
      yield* expectSqlFailure(
        inScope(
          runtimeClient,
          scope,
          runtimeClient.unsafe("update payment.psp_provider_notifications set state = 'SUBMITTED'"),
        ),
        '42501',
      );
      const notificationId = yield* Schema.decodeUnknownEffect(PspNotificationIdSchema)(captured?.notification_id);
      const origin = yield* workerOrigin;
      const held = yield* withRoutines(runtime, scope, (invoker) =>
        pspTransitionNotification(invoker, {
          correlatedOperationId: Option.none(),
          deliveryId: origin.deliveryId,
          notificationId,
          to: 'HELD_UNCORRELATED',
        }),
      );
      expect(Predicate.isTagged(held, 'TRANSITIONED')).toBe(true);
      const repeated = yield* withRoutines(runtime, scope, (invoker) =>
        pspTransitionNotification(invoker, {
          correlatedOperationId: Option.none(),
          deliveryId: origin.deliveryId,
          notificationId,
          to: 'HELD_UNCORRELATED',
        }),
      );
      expect(Predicate.isTagged(repeated, 'UNCHANGED')).toBe(true);
    }),
  ),
);

it.live('#1158 Provider evidence is append-only except its one submission step', () =>
  Effect.scoped(
    Effect.gen(function* evidenceAppendOnly() {
      const { admin, runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope);
      const origin = yield* workerOrigin;
      const evidence: PspAppendEvidenceInput = {
        bindingId: fixture.bindingId,
        discrepancy: Option.none(),
        economicEffectKey: Option.some('pi_test_1'),
        evidenceOrigin: 'NOTIFICATION_LOOKUP',
        factFamily: 'GATEWAY_OUTCOME',
        factKind: 'COLLECTION_CONFIRMED',
        notificationId: Option.none(),
        observedAmount: Option.some({ amountMinor: 100_000, currency: 'CZK' }),
        observedAt: DateTime.makeUnsafe('2026-11-12T10:00:00.000Z'),
        operationId: fixture.collectOperationId,
        origin,
        providerOccurredAt: Option.none(),
        providerRefs: [{ _tag: 'STRIPE_PAYMENT_INTENT', id: 'pi_test_1' }],
        reason: Option.none(),
        sourceOccurrenceId: 'stripe:evt:evt_test_1',
        sourceRevision: 0,
      };
      const append = (input: PspAppendEvidenceInput) =>
        withRoutines(runtime, scope, (invoker) => pspAppendEvidence(invoker, input));

      const appended = yield* append(evidence);
      const appendedRow = yield* expectTagged(appended, 'APPENDED');
      expect(appendedRow.record.submissionState).toBe('PENDING_SUBMISSION');
      expect(appendedRow.record.deliveryId).toBe(origin.deliveryId);
      // Without a notification, receipt and verification are the observation instant.
      expect([appendedRow.record.receivedAt, appendedRow.record.verifiedAt]).toEqual([
        evidence.observedAt,
        evidence.observedAt,
      ]);
      // The same fact proven again later is the same occurrence; the first receipt is kept.
      const repeated = yield* append({ ...evidence, observedAt: DateTime.makeUnsafe('2026-11-12T11:00:00.000Z') });
      expect((yield* expectTagged(repeated, 'EXISTING')).record.receivedAt).toEqual(evidence.observedAt);
      // The same statement read by the other lookup path is that occurrence too, not a conflict.
      const otherOrigin = yield* append({ ...evidence, evidenceOrigin: 'RECOVERY_LOOKUP' });
      expect((yield* expectTagged(otherOrigin, 'EXISTING')).record.evidenceId).toBe(appendedRow.record.evidenceId);
      const rewritten = yield* append({ ...evidence, factKind: 'COLLECTION_NOT_EFFECTED' });
      expect(conflictReason(rewritten)).toEqual(Option.some('occurrence_mismatch'));
      const otherCurrency = yield* append({
        ...evidence,
        observedAmount: Option.some({ amountMinor: 100_000, currency: 'EUR' }),
      });
      expect(conflictReason(otherCurrency)).toEqual(Option.some('occurrence_mismatch'));

      const mark = (state: 'ACCEPTED' | 'DENIED') =>
        withRoutines(runtime, scope, (invoker) =>
          pspMarkEvidenceSubmission(invoker, {
            deliveryId: origin.deliveryId,
            evidenceId: appendedRow.record.evidenceId,
            observationId: Option.none(),
            state,
          }),
        );
      expect(Predicate.isTagged(yield* mark('ACCEPTED'), 'MARKED')).toBe(true);
      expect(Predicate.isTagged(yield* mark('ACCEPTED'), 'UNCHANGED')).toBe(true);
      expect(Predicate.isTagged(yield* mark('DENIED'), 'CONFLICT')).toBe(true);

      const ownerSql = (statement: string) =>
        inScope(admin, scope, admin.unsafe(statement, [scope.tenantId, appendedRow.record.evidenceId]));
      yield* expectSqlFailure(
        ownerSql(
          "update payment.psp_provider_evidence set fact_kind = 'COLLECTION_NOT_EFFECTED' where tenant_id = $1 and evidence_id = $2",
        ),
        '23514',
        'payment_psp_evidence_transition_ck',
      );
      yield* expectSqlFailure(
        ownerSql(
          "update payment.psp_provider_evidence set submission_state = 'DENIED' where tenant_id = $1 and evidence_id = $2",
        ),
        '23514',
        'payment_psp_evidence_transition_ck',
      );
      yield* expectSqlFailure(
        ownerSql('delete from payment.psp_provider_evidence where tenant_id = $1 and evidence_id = $2'),
        '23514',
        'payment_append_only_ck',
      );
    }),
  ),
);

it.live('#1157 The submission executor is pinned once and survives the terminal submission step', () =>
  Effect.scoped(
    Effect.gen(function* executorPin() {
      const { admin, runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope);
      const origin = yield* workerOrigin;
      const [executor, otherExecutor, unknownEvidence] = yield* Effect.all([randomUuid, randomUuid, randomUuid], {
        concurrency: 1,
      });
      const appended = yield* withRoutines(runtime, scope, (invoker) =>
        pspAppendEvidence(invoker, {
          bindingId: fixture.bindingId,
          discrepancy: Option.none(),
          economicEffectKey: Option.some('pi_pin_1'),
          evidenceOrigin: 'NOTIFICATION_LOOKUP',
          factFamily: 'GATEWAY_OUTCOME',
          factKind: 'COLLECTION_CONFIRMED',
          notificationId: Option.none(),
          observedAmount: Option.some({ amountMinor: 100_000, currency: 'CZK' }),
          observedAt: DateTime.makeUnsafe('2026-11-12T10:00:00.000Z'),
          operationId: fixture.collectOperationId,
          origin,
          providerOccurredAt: Option.none(),
          providerRefs: [{ _tag: 'STRIPE_PAYMENT_INTENT', id: 'pi_pin_1' }],
          reason: Option.none(),
          sourceOccurrenceId: 'stripe:evt:evt_pin_1',
          sourceRevision: 0,
        }),
      );
      const { record } = yield* expectTagged(appended, 'APPENDED');
      expect(record.submissionExecutorPrincipalId).toBeUndefined();
      const pin = (evidenceId: string, principalId: string) =>
        withRoutines(runtime, scope, (invoker) =>
          Schema.decodeUnknownEffect(PspEvidenceIdSchema)(evidenceId).pipe(
            Effect.flatMap((id) => pspPinEvidenceSubmissionExecutor(invoker, { evidenceId: id, principalId })),
          ),
        );

      const pinned = yield* expectTagged(yield* pin(record.evidenceId, executor), 'PINNED');
      expect(pinned.record.submissionExecutorPrincipalId).toBe(executor);
      const unchanged = yield* expectTagged(yield* pin(record.evidenceId, executor), 'UNCHANGED');
      expect(unchanged.record.submissionExecutorPrincipalId).toBe(executor);
      const mismatch = yield* pin(record.evidenceId, otherExecutor);
      expect(conflictReason(mismatch)).toEqual(Option.some('executor_mismatch'));
      expect(Predicate.isTagged(yield* pin(unknownEvidence, executor), 'NOT_FOUND')).toBe(true);

      // The runtime role never updates evidence directly; only the routine pins.
      yield* expectSqlFailure(
        inScope(
          runtimeClient,
          scope,
          runtimeClient.unsafe(
            'update payment.psp_provider_evidence set submission_executor_principal_id = $3 where tenant_id = $1 and evidence_id = $2',
            [scope.tenantId, record.evidenceId, otherExecutor],
          ),
        ),
        '42501',
      );
      // Even the owner cannot re-pin, pin together with another column, or clear the executor on the terminal step.
      const ownerSql = (statement: string) =>
        inScope(admin, scope, admin.unsafe(statement, [scope.tenantId, record.evidenceId, otherExecutor]));
      yield* expectSqlFailure(
        ownerSql(
          'update payment.psp_provider_evidence set submission_executor_principal_id = $3 where tenant_id = $1 and evidence_id = $2',
        ),
        '23514',
        'payment_psp_evidence_transition_ck',
      );
      yield* expectSqlFailure(
        ownerSql(
          `update payment.psp_provider_evidence set submission_state = 'DENIED', submitted_at = now(),
             submitted_delivery_id = gen_random_uuid(), submission_executor_principal_id = null
           where tenant_id = $1 and evidence_id = $2 and $3::uuid is not null`,
        ),
        '23514',
        'payment_psp_evidence_transition_ck',
      );

      // The terminal step keeps the pinned executor; a settled row is never pinned again.
      const marked = yield* withRoutines(runtime, scope, (invoker) =>
        pspMarkEvidenceSubmission(invoker, {
          deliveryId: origin.deliveryId,
          evidenceId: record.evidenceId,
          observationId: Option.none(),
          state: 'DENIED',
        }),
      );
      expect((yield* expectTagged(marked, 'MARKED')).record.submissionExecutorPrincipalId).toBe(executor);
      expect(Predicate.isTagged(yield* pin(record.evidenceId, executor), 'UNCHANGED')).toBe(true);
      expect(conflictReason(yield* pin(record.evidenceId, otherExecutor))).toEqual(Option.some('executor_mismatch'));
    }),
  ),
);

it.live('#1157 A settled row without an executor is never pinned, and a pin cannot change another column', () =>
  Effect.scoped(
    Effect.gen(function* settledUnpinned() {
      const { admin, runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope);
      const origin = yield* workerOrigin;
      const executor = yield* randomUuid;
      const appended = yield* withRoutines(runtime, scope, (invoker) =>
        pspAppendEvidence(invoker, {
          bindingId: fixture.bindingId,
          discrepancy: Option.none(),
          economicEffectKey: Option.none(),
          evidenceOrigin: 'NOTIFICATION_LOOKUP',
          factFamily: 'GATEWAY_OUTCOME',
          factKind: 'COLLECTION_NOT_EFFECTED',
          notificationId: Option.none(),
          observedAmount: Option.none(),
          observedAt: DateTime.makeUnsafe('2026-11-12T10:00:00.000Z'),
          operationId: fixture.collectOperationId,
          origin,
          providerOccurredAt: Option.none(),
          providerRefs: [{ _tag: 'STRIPE_PAYMENT_INTENT', id: 'pi_pin_2' }],
          reason: Option.none(),
          sourceOccurrenceId: 'stripe:evt:evt_pin_2',
          sourceRevision: 0,
        }),
      );
      const { record } = yield* expectTagged(appended, 'APPENDED');
      // A pin that also changes another column is refused, even for the owner.
      const ownerPin = (statement: string) =>
        inScope(admin, scope, admin.unsafe(statement, [scope.tenantId, record.evidenceId, executor]));
      yield* expectSqlFailure(
        ownerPin(
          `update payment.psp_provider_evidence set submission_executor_principal_id = $3, reason = 'changed'
           where tenant_id = $1 and evidence_id = $2`,
        ),
        '23514',
        'payment_psp_evidence_transition_ck',
      );
      yield* withRoutines(runtime, scope, (invoker) =>
        pspMarkEvidenceSubmission(invoker, {
          deliveryId: origin.deliveryId,
          evidenceId: record.evidenceId,
          observationId: Option.none(),
          state: 'HELD',
        }),
      );
      const late = yield* withRoutines(runtime, scope, (invoker) =>
        Schema.decodeUnknownEffect(PspEvidenceIdSchema)(record.evidenceId).pipe(
          Effect.flatMap((evidenceId) =>
            pspPinEvidenceSubmissionExecutor(invoker, { evidenceId, principalId: executor }),
          ),
        ),
      );
      expect(conflictReason(late)).toEqual(Option.some('illegal_transition'));
    }),
  ),
);

it.live('#1158 The execution read carries the stored creation instant and original provenance', () =>
  Effect.scoped(
    Effect.gen(function* executionProvenance() {
      const { admin, runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope);
      const [stored] = yield* inScope(
        admin,
        scope,
        admin.unsafe<{ action_invocation_id: string; created_at: Date }>(
          'select action_invocation_id, created_at from payment.payment_operations where tenant_id = $1 and operation_id = $2',
          [scope.tenantId, fixture.collectOperationId],
        ),
      );
      const read = yield* withRoutines(runtime, scope, (invoker) =>
        pspReadOperationForExecution(invoker, fixture.collectOperationId),
      );
      expect(
        read.pipe(
          Option.map((operation) => [
            DateTime.toEpochMillis(operation.createdAt),
            operation.provenance.actionInvocationId,
            operation.provenance.actorPrincipalId,
            operation.provenance.compositionRevision,
          ]),
        ),
      ).toEqual(
        Option.some([
          stored?.created_at.getTime(),
          stored?.action_invocation_id,
          scope.principalId,
          COMPOSITION_REVISION,
        ]),
      );
    }),
  ),
);

it.live('#1155 Gateway rows are isolated per Selling Legal Entity (forced RLS)', () =>
  Effect.scoped(
    Effect.gen(function* legalEntityIsolation() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const otherLegalEntity = { ...(yield* makeTestScope), principalId: scope.principalId, tenantId: scope.tenantId };
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope);
      const origin = yield* workerOrigin;
      yield* withRoutines(runtime, scope, (invoker) => pspPrepareDispatch(invoker, prepareInput(fixture, origin)));

      for (const table of ['psp_provider_account_bindings', 'psp_credential_revisions', 'psp_provider_dispatches']) {
        const visible = yield* inScope(
          runtimeClient,
          otherLegalEntity,
          runtimeClient.unsafe<{ count: number }>(
            `select count(*)::integer as count from payment.${table} where binding_id = $1`,
            [fixture.bindingId],
          ),
        );
        expect(visible[0]?.count).toBe(0);
      }
      const foreignRead = yield* withRoutines(runtime, otherLegalEntity, (invoker) =>
        pspReadDispatch(invoker, fixture.collectOperationId),
      );
      expect(Option.isNone(foreignRead)).toBe(true);
      const foreignPrepare = yield* withRoutines(runtime, otherLegalEntity, (invoker) =>
        pspPrepareDispatch(invoker, prepareInput(fixture, origin)),
      );
      expect(conflictReason(foreignPrepare)).toEqual(Option.some('operation_unknown'));
      // A configuration row for another Legal Entity cannot be written from this scope.
      yield* expectSqlFailure(
        inScope(
          runtimeClient,
          scope,
          runtimeClient.unsafe(
            `insert into payment.psp_provider_account_bindings (tenant_id, legal_entity_id, action_invocation_id,
               actor_principal_id, composition_revision, configured_at, current_credential_revision, environment,
               merchant_identity, notification_url, provider_account_ref, provider_family, reason, revision, status)
             values ($1, $2, gen_random_uuid(), $3, $4, now(), 1, 'LIVE', '{"_tag":"STRIPE","accountId":"acct_1Other"}'::jsonb,
               'https://hooks.example.test/psp', $5, 'STRIPE', 'Foreign binding', 1, 'CURRENT')`,
            [
              scope.tenantId,
              otherLegalEntity.legalEntityId,
              scope.principalId,
              COMPOSITION_REVISION,
              fixture.accountRef,
            ],
          ),
        ),
        '42501',
      );
    }),
  ),
);

it.live('#1158 Scoped routines refuse arguments outside the installed scope', () =>
  Effect.scoped(
    Effect.gen(function* mismatchedScope() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const other = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope);

      // In its own scope the routine decodes into the typed C16 operation facts.
      const operation = yield* withRoutines(runtime, scope, (invoker) =>
        pspReadOperationForExecution(invoker, fixture.collectOperationId),
      );
      expect(
        operation.pipe(
          Option.map((read) => [read.operationId, read.kind, read.outcome, read.materialHash, read.amountMinor]),
        ),
      ).toEqual(Option.some([fixture.collectOperationId, 'COLLECT', 'PENDING', fixture.collectMaterialHash, 100_000]));
      expect(operation.pipe(Option.map((read) => read.binding))).toEqual(Option.some(gatewayBindingOf(fixture)));

      yield* expectSqlFailure(
        inScope(
          runtimeClient,
          scope,
          runtimeClient.unsafe('select * from payment.psp_read_dispatch($1, $2, $3)', [
            other.tenantId,
            scope.legalEntityId,
            fixture.collectOperationId,
          ]),
        ),
        '42501',
      );
      yield* expectSqlFailure(
        inScope(
          runtimeClient,
          scope,
          runtimeClient.unsafe('select * from payment.psp_read_operation_for_execution($1, $2, $3)', [
            scope.tenantId,
            other.legalEntityId,
            fixture.collectOperationId,
          ]),
        ),
        '42501',
      );
      // Without any installed scope the routine refuses even matching arguments.
      yield* expectSqlFailure(
        runtimeClient
          .unsafe('select * from payment.psp_read_dispatch($1, $2, $3)', [
            scope.tenantId,
            scope.legalEntityId,
            fixture.collectOperationId,
          ])
          .pipe(runtimeClient.withTransaction),
        '42501',
      );
      // Internal helpers are never executable by the runtime role.
      yield* expectSqlFailure(
        inScope(
          runtimeClient,
          scope,
          runtimeClient.unsafe('select payment.psp_lock_operation($1, $2)', [
            scope.tenantId,
            fixture.collectOperationId,
          ]),
        ),
        '42501',
      );
    }),
  ),
);

it.live('#1158 The runtime role cannot write worker-owned gateway rows directly', () =>
  Effect.scoped(
    Effect.gen(function* runtimeCannotWrite() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope);
      const origin = yield* workerOrigin;
      yield* withRoutines(runtime, scope, (invoker) => pspPrepareDispatch(invoker, prepareInput(fixture, origin)));
      const runtimeSql = (statement: string) =>
        inScope(runtimeClient, scope, runtimeClient.unsafe(statement, [scope.tenantId, fixture.collectOperationId]));

      yield* expectSqlFailure(
        runtimeSql(
          "update payment.psp_provider_dispatches set state = 'ACKNOWLEDGED' where tenant_id = $1 and operation_id = $2",
        ),
        '42501',
      );
      yield* expectSqlFailure(
        runtimeSql('delete from payment.psp_provider_dispatches where tenant_id = $1 and operation_id = $2'),
        '42501',
      );
      yield* expectSqlFailure(
        runtimeSql(
          `insert into payment.psp_provider_dispatches (tenant_id, legal_entity_id, delivery_id, origin_action_invocation_id,
             origin_composition_revision, worker_key, binding_id, environment, material_hash, operation_id, operation_kind,
             order_reference, payment_id, provider_account_ref, provider_family, state)
           select tenant_id, legal_entity_id, delivery_id, origin_action_invocation_id, origin_composition_revision, worker_key,
             binding_id, environment, material_hash, operation_id, operation_kind, order_reference, payment_id,
             provider_account_ref, provider_family, 'NOT_SENT'
           from payment.psp_provider_dispatches where tenant_id = $1 and operation_id = $2`,
        ),
        '42501',
      );
      yield* expectSqlFailure(
        runtimeSql(
          `insert into payment.psp_provider_evidence (tenant_id, legal_entity_id, delivery_id, origin_action_invocation_id,
             origin_composition_revision, worker_key, binding_id, environment, evidence_origin, fact_family, fact_kind,
             operation_id, payment_id, provider_account_ref, provider_family, provider_refs, source_occurrence_id,
             source_revision, submission_state)
           select tenant_id, legal_entity_id, delivery_id, origin_action_invocation_id, origin_composition_revision, worker_key,
             binding_id, environment, 'LOCAL_NOT_SENT', 'GATEWAY_OUTCOME', 'COLLECTION_NOT_EFFECTED', operation_id, payment_id,
             provider_account_ref, provider_family, '[]'::jsonb, 'forged', 0, 'PENDING_SUBMISSION'
           from payment.psp_provider_dispatches where tenant_id = $1 and operation_id = $2`,
        ),
        '42501',
      );
    }),
  ),
);

it.live('#1157 A notification only affects operations of the binding it was captured for', () =>
  Effect.scoped(
    Effect.gen(function* notificationBindingTie() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const stripe = yield* gatewayFixture(runtime, runtimeClient, scope, 'STRIPE');
      const gopay = yield* gatewayFixture(runtime, runtimeClient, scope, 'GOPAY');
      const origin = yield* workerOrigin;
      const [captured] = yield* insertNotification(runtimeClient, scope, {
        accountRef: gopay.accountRef,
        bindingId: gopay.bindingId,
        deliveryIdentity: 'gopay:3000006529:relay-delivery-1',
        family: 'GOPAY',
      });
      const notificationId = yield* Schema.decodeUnknownEffect(PspNotificationIdSchema)(captured?.notification_id);
      const transition = (operationId: string) =>
        withRoutines(runtime, scope, (invoker) =>
          pspTransitionNotification(invoker, {
            correlatedOperationId: Option.some(operationId),
            deliveryId: origin.deliveryId,
            notificationId,
            to: 'SUBMITTED',
          }),
        );

      // A GoPay notification cannot be correlated with an operation executed through the Stripe binding.
      expect(conflictReason(yield* transition(stripe.collectOperationId))).toEqual(Option.some('binding_mismatch'));
      const evidence: PspAppendEvidenceInput = {
        bindingId: stripe.bindingId,
        discrepancy: Option.none(),
        economicEffectKey: Option.none(),
        evidenceOrigin: 'NOTIFICATION_LOOKUP',
        factFamily: 'GATEWAY_OUTCOME',
        factKind: 'COLLECTION_PENDING',
        notificationId: Option.some(notificationId),
        observedAmount: Option.none(),
        observedAt: DateTime.makeUnsafe('2099-01-01T00:00:00.000Z'),
        operationId: stripe.collectOperationId,
        origin,
        providerOccurredAt: Option.none(),
        providerRefs: [],
        reason: Option.none(),
        sourceOccurrenceId: `gopay:NOTIFICATION_LOOKUP:3000006529:${stripe.collectOperationId}:COLLECTION_PENDING:100000`,
        sourceRevision: 0,
      };
      const foreign = yield* withRoutines(runtime, scope, (invoker) => pspAppendEvidence(invoker, evidence));
      expect(conflictReason(foreign)).toEqual(Option.some('notification_unknown'));

      // Inside its own binding the evidence keeps the notification's receipt and the lookup's verification.
      const own = yield* withRoutines(runtime, scope, (invoker) =>
        pspAppendEvidence(invoker, {
          ...evidence,
          bindingId: gopay.bindingId,
          operationId: gopay.collectOperationId,
          sourceOccurrenceId: `gopay:NOTIFICATION_LOOKUP:3000006529:${gopay.collectOperationId}:COLLECTION_PENDING:100000`,
        }),
      );
      const ownRow = yield* expectTagged(own, 'APPENDED');
      expect(ownRow.record.notificationId).toBe(notificationId);
      expect(ownRow.record.verifiedAt).toEqual(evidence.observedAt);
      expect(DateTime.toEpochMillis(ownRow.record.receivedAt)).toBeLessThan(
        DateTime.toEpochMillis(evidence.observedAt),
      );
      expect(Predicate.isTagged(yield* transition(gopay.collectOperationId), 'TRANSITIONED')).toBe(true);
    }),
  ),
);

it.live('#1156 GoPay refunds of one provider payment are serialized under the collection lock', () =>
  Effect.scoped(
    Effect.gen(function* refundSerialization() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope, 'GOPAY');
      const origin = yield* workerOrigin;
      const providerPaymentRef = '3000006529';
      const gopayRequest = {
        ...prepareInput(fixture, origin),
        endpointRef: 'gopay:payment-create',
        idempotencyKeyHash: Option.none(),
        replayRequest: Option.none(),
        returnToken: Option.none(),
      } satisfies PspPrepareDispatchInput;
      yield* expectTagged(
        yield* withRoutines(runtime, scope, (invoker) => pspPrepareDispatch(invoker, gopayRequest)),
        'PREPARED',
      );
      yield* expectTagged(
        yield* withRoutines(runtime, scope, (invoker) =>
          pspRecordDispatchOutcome(invoker, {
            customerRedirectUrl: Option.none(),
            deliveryId: origin.deliveryId,
            operationId: fixture.collectOperationId,
            providerPaymentRef: Option.some(providerPaymentRef),
            providerRefundRef: Option.none(),
            to: 'ACKNOWLEDGED',
          }),
        ),
        'RECORDED',
      );
      const binding = gatewayBindingOf(fixture);
      const [confirm, refundExecutionRoute] = yield* Effect.all(
        [provenanceFor(scope), configuredRefundExecutionRouteFor(runtime, scope, binding)],
        { concurrency: 1 },
      );
      yield* withPersistence(runtime, scope, (persistence) =>
        persistence.transitionOperationOutcome({
          causedBy: { kind: 'OBSERVATION', sourceId: 'observation:captured' },
          expectedOutcomeRevision: 1,
          operationId: fixture.collectOperationId,
          paymentId: fixture.paymentId,
          provenance: confirm,
          to: 'EFFECT_CONFIRMED',
        }),
      );
      const refund = Effect.fn('PspGuardsFixture.refund')(function* refund(itemRef: string) {
        const provenance = yield* provenanceFor(scope);
        const created = yield* withPersistence(runtime, scope, (persistence) =>
          persistence.insertOperation({
            amount: { amountMinor: 10_000, currency: 'CZK' },
            binding,
            initialOutcome: 'PENDING',
            kind: 'REFUND',
            materialRequest: { itemRefs: [itemRef], kind: 'REFUND', operationKey: `refund-${itemRef}` },
            operationKey: `refund-${itemRef}`,
            paymentId: fixture.paymentId,
            provenance,
            refundBasis: {
              _tag: 'REFUNDABLE_ITEMS',
              items: [{ amountMinor: 10_000, currency: 'CZK', itemRef, sourceEvidenceRef: `order:item:${itemRef}` }],
            },
            refundExecutionRoute,
            targetOperationId: fixture.collectOperationId,
          }),
        );
        return { materialHash: created.record.materialHash, operationId: created.record.operationId };
      });
      const [first, second] = yield* Effect.all([refund('A'), refund('B')], { concurrency: 1 });
      const prepareRefund = (operation: { readonly materialHash: string; readonly operationId: string }) =>
        withRoutines(runtime, scope, (invoker) =>
          pspPrepareDispatch(invoker, {
            ...gopayRequest,
            endpointRef: 'gopay:payment-refund',
            materialHash: operation.materialHash,
            operationId: operation.operationId,
            providerPaymentRef: Option.some(providerPaymentRef),
          }),
        );

      // Truly concurrent: exactly one refund is prepared, the other is deferred behind it.
      const raced = yield* Effect.all([prepareRefund(first), prepareRefund(second)], { concurrency: 2 });
      const preparedIndex = raced.findIndex((result) => Predicate.isTagged(result, 'PREPARED'));
      expect(preparedIndex).toBeGreaterThanOrEqual(0);
      const [winner, loser] = preparedIndex === 0 ? [first, second] : [second, first];
      const deferred = yield* expectTagged(raced[1 - preparedIndex] ?? raced[0], 'DEFERRED');
      expect(deferred.unresolvedRefundOperationIds).toEqual([winner.operationId]);
      expect(yield* dispatchCount(runtimeClient, scope, loser.operationId)).toBe(0);

      // Acknowledged without definitive refund evidence is still unresolved.
      yield* withRoutines(runtime, scope, (invoker) =>
        pspRecordDispatchOutcome(invoker, {
          customerRedirectUrl: Option.none(),
          deliveryId: origin.deliveryId,
          operationId: winner.operationId,
          providerPaymentRef: Option.none(),
          providerRefundRef: Option.none(),
          to: 'ACKNOWLEDGED',
        }),
      );
      yield* expectTagged(yield* prepareRefund(loser), 'DEFERRED');
      const unresolved = yield* withRoutines(runtime, scope, (invoker) =>
        pspHasUnresolvedRefund(invoker, {
          bindingId: fixture.bindingId,
          excludingOperationId: Option.some(loser.operationId),
          providerPaymentRef,
        }),
      );
      expect(unresolved).toEqual({ operationIds: [winner.operationId], unresolved: true });

      // Definitive refund evidence resolves it, and the next refund may be prepared.
      yield* withRoutines(runtime, scope, (invoker) =>
        pspAppendEvidence(invoker, {
          bindingId: fixture.bindingId,
          discrepancy: Option.none(),
          economicEffectKey: Option.some(`gopay-refund:${providerPaymentRef}:${winner.operationId}`),
          evidenceOrigin: 'RECOVERY_LOOKUP',
          factFamily: 'REFUND_EXECUTION',
          factKind: 'REFUND_CONFIRMED',
          notificationId: Option.none(),
          observedAmount: Option.some({ amountMinor: 10_000, currency: 'CZK' }),
          observedAt: DateTime.makeUnsafe('2026-11-12T10:00:00.000Z'),
          operationId: winner.operationId,
          origin,
          providerOccurredAt: Option.none(),
          providerRefs: [{ _tag: 'GOPAY_PAYMENT', id: providerPaymentRef }],
          reason: Option.none(),
          sourceOccurrenceId: `gopay:RECOVERY_LOOKUP:${providerPaymentRef}:${winner.operationId}:REFUND_CONFIRMED:10000`,
          sourceRevision: 0,
        }),
      );
      yield* expectTagged(yield* prepareRefund(loser), 'PREPARED');
    }),
  ),
);
