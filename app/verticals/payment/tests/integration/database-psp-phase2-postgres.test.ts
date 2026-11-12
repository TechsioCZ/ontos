import type { ScopedRoutineInvoker } from '@app/core-runtime';
import type { PgClient } from '@effect/sql-pg';
import { Array as EffectArray, Effect, Option, Order, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import {
  GatewayProviderAccountBindingIdSchema,
  GatewayProviderAccountRefSchema,
} from '../../shared/domain/psp-configuration.ts';
import type {
  GatewayProviderAccountBindingId,
  GatewayProviderAccountRef,
} from '../../shared/domain/psp-configuration.ts';
import {
  pspHasUnresolvedRefund,
  pspPrepareDispatch,
  pspReadOperationForExecution,
  pspRecordDispatchOutcome,
  pspRecordNotSent,
  pspRegisterCancel,
} from '../../src/persistence/psp-worker-routines.ts';
import type { PspPrepareDispatchInput, PspWorkerOrigin } from '../../src/persistence/psp-worker-routines.ts';
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

/*
 * Phase 2 database objects (plan D-P2..D-P5): the transient payer contact, the binding route, the per-family
 * refund serialisation and the cross-Tenant reconciliation due listing. Values are obviously fake.
 */

type PaymentGatewayProviderFamily = typeof PaymentGatewayProviderFamilySchema.Type;
type PaymentTestTransaction = Parameters<Parameters<PaymentTestDatabase['transaction']>[0]>[0];

const WORKER_KEY = 'payment.core.execute-gateway-operation';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

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

const MERCHANT_IDENTITIES = {
  COMGATE: '{"_tag":"COMGATE","merchantId":"123456"}',
  GOPAY: '{"_tag":"GOPAY","goid":"8123456789"}',
  STRIPE: '{"_tag":"STRIPE","accountId":"acct_1TestAccount"}',
} as const satisfies Record<PaymentGatewayProviderFamily, string>;

interface BindingFixture {
  readonly accountRef: GatewayProviderAccountRef;
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly family: PaymentGatewayProviderFamily;
}

interface CollectFixture {
  readonly binding: BindingFixture;
  readonly materialHash: string;
  readonly operationId: string;
  readonly paymentId: string;
}

/** A 43-character base64url route key (fake, derived from two random UUIDs). */
const routeKeyOf = Effect.all([randomUuid, randomUuid], { concurrency: 1 }).pipe(
  Effect.map(([first, second]) => `${first.replaceAll('-', '')}${second.replaceAll('-', '')}`.slice(0, 43)),
);

const insertRoute = (
  runtimeClient: PgClient.PgClient,
  scope: PaymentTestScope,
  binding: BindingFixture,
  routeKey: string,
  overrides: { readonly family?: string; readonly tenantId?: string } = {},
) =>
  inScope(
    runtimeClient,
    scope,
    runtimeClient.unsafe(
      `insert into payment.psp_binding_routes (tenant_id, legal_entity_id, binding_id, route_key, provider_family, environment)
       values ($1, $2, $3, $4, $5, 'SANDBOX')`,
      [
        overrides.tenantId ?? scope.tenantId,
        scope.legalEntityId,
        binding.bindingId,
        routeKey,
        overrides.family ?? binding.family,
      ],
    ),
  );

/** One CURRENT binding with its ACTIVE credential, without a route. */
const unroutedBindingFixture = Effect.fn('PspPhase2Fixture.unroutedBinding')(function* unroutedBindingFixture(
  runtimeClient: PgClient.PgClient,
  scope: PaymentTestScope,
  family: PaymentGatewayProviderFamily,
) {
  const [refSeed, bindingSeed] = yield* Effect.all([randomUuid, randomUuid], { concurrency: 1 });
  const binding: BindingFixture = {
    accountRef: yield* Schema.decodeEffect(GatewayProviderAccountRefSchema)(`pab_${refSeed.replaceAll('-', '')}`),
    bindingId: yield* Schema.decodeEffect(GatewayProviderAccountBindingIdSchema)(bindingSeed),
    family,
  };
  yield* inScope(
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
          binding.bindingId,
          MERCHANT_IDENTITIES[family],
          binding.accountRef,
          family,
        ],
      );
      yield* runtimeClient.unsafe(
        `insert into payment.psp_credential_revisions (tenant_id, legal_entity_id, action_invocation_id,
           actor_principal_id, composition_revision, binding_id, recorded_at, revision, secret_ref, status)
         values ($1, $2, gen_random_uuid(), $3, $4, $5, now(), 1, 'sandbox-credential-1', 'ACTIVE')`,
        [scope.tenantId, scope.legalEntityId, scope.principalId, COMPOSITION_REVISION, binding.bindingId],
      );
    }),
  );
  return binding;
});

/** One CURRENT binding with its ACTIVE credential and its route, as configuration creates them. */
const bindingFixture = Effect.fn('PspPhase2Fixture.binding')(function* bindingFixture(
  runtimeClient: PgClient.PgClient,
  scope: PaymentTestScope,
  family: PaymentGatewayProviderFamily,
) {
  const binding = yield* unroutedBindingFixture(runtimeClient, scope, family);
  yield* insertRoute(runtimeClient, scope, binding, yield* routeKeyOf);
  return binding;
});

const executionBindingOf = (binding: BindingFixture) =>
  ({
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: binding.accountRef,
    providerFamily: binding.family,
  }) as const;

/** A new Payment with its pending COLLECT through `binding`. */
const collectFixture = Effect.fn('PspPhase2Fixture.collect')(function* collectFixture(
  runtime: PaymentTestDatabase,
  scope: PaymentTestScope,
  binding: BindingFixture,
) {
  const executionBinding = executionBindingOf(binding);
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
    binding,
    materialHash: collected.record.materialHash,
    operationId: collected.record.operationId,
    paymentId,
  } satisfies CollectFixture;
});

/** A provider request without a replay window (GoPay/Comgate style). */
const prepareInput = (
  target: { readonly materialHash: string; readonly operationId: string },
  binding: BindingFixture,
  origin: PspWorkerOrigin,
  providerPaymentRef: Option.Option<string> = Option.none(),
): PspPrepareDispatchInput => ({
  bindingId: binding.bindingId,
  credentialRevision: 1,
  endpointRef: `${binding.family.toLowerCase()}:request`,
  idempotencyKeyHash: Option.none(),
  materialHash: target.materialHash,
  operationId: target.operationId,
  origin,
  providerPaymentRef,
  replayRequest: Option.none(),
  requestHash: 'a'.repeat(64),
  returnToken: Option.none(),
});

const expectTagged = <Value extends { readonly _tag: string }, Tag extends Value['_tag']>(value: Value, tag: Tag) =>
  Effect.sync(() => expect(Predicate.isTagged(value, tag)).toBe(true)).pipe(
    Effect.andThen(Predicate.isTagged(value, tag) ? Effect.succeed(value) : Effect.never),
  );

const recordOutcome = (
  runtime: PaymentTestDatabase,
  scope: PaymentTestScope,
  origin: PspWorkerOrigin,
  operationId: string,
  to: 'ACKNOWLEDGED' | 'OUTCOME_UNKNOWN',
  providerPaymentRef: Option.Option<string> = Option.none(),
) =>
  withRoutines(runtime, scope, (invoker) =>
    pspRecordDispatchOutcome(invoker, {
      customerRedirectUrl: Option.none(),
      deliveryId: origin.deliveryId,
      operationId,
      providerPaymentRef,
      providerRefundRef: Option.none(),
      to,
    }),
  );

const insertContact = (
  runtimeClient: PgClient.PgClient,
  scope: PaymentTestScope,
  operationId: string,
  fullName: string,
) =>
  inScope(
    runtimeClient,
    scope,
    runtimeClient.unsafe(
      `insert into payment.psp_operation_payer_contacts (tenant_id, legal_entity_id, operation_id, full_name, email)
       values ($1, $2, $3, $4, 'payer@example.test') on conflict do nothing`,
      [scope.tenantId, scope.legalEntityId, operationId, fullName],
    ),
  );

const storedContactCount = (admin: PgClient.PgClient, operationId: string) =>
  admin
    .unsafe<{ count: number }>(
      'select count(*)::integer as count from payment.psp_operation_payer_contacts where operation_id = $1',
      [operationId],
    )
    .pipe(Effect.map((rows) => rows[0]?.count ?? -1));

const contactOf = (runtime: PaymentTestDatabase, scope: PaymentTestScope, operationId: string) =>
  withRoutines(runtime, scope, (invoker) => pspReadOperationForExecution(invoker, operationId)).pipe(
    Effect.map(Option.flatMap((operation) => operation.payerContact)),
  );

it.live(
  '#1157/#1153 The payer contact is reachable only through routines and is deleted at PREPARED and NOT_SENT',
  () =>
    Effect.scoped(
      Effect.gen(function* payerContactLifecycle() {
        const { admin, runtime: runtimeClient } = yield* testDatabaseClients;
        const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
        const scope = yield* makeTestScope;
        const binding = yield* bindingFixture(runtimeClient, scope, 'COMGATE');
        const prepared = yield* collectFixture(runtime, scope, binding);
        const origin = yield* workerOrigin;

        // The Action inserts in its own scoped transaction; a replay inserts nothing and the first contact wins.
        yield* insertContact(runtimeClient, scope, prepared.operationId, 'Test Payer');
        yield* insertContact(runtimeClient, scope, prepared.operationId, 'Other Payer');
        expect(yield* contactOf(runtime, scope, prepared.operationId)).toEqual(
          Option.some({ email: 'payer@example.test', fullName: 'Test Payer' }),
        );
        // The runtime role can neither read, change nor delete it directly.
        const runtimeSql = (statement: string) =>
          inScope(runtimeClient, scope, runtimeClient.unsafe(statement, [prepared.operationId]));
        yield* expectSqlFailure(
          runtimeSql('select full_name from payment.psp_operation_payer_contacts where operation_id = $1'),
          '42501',
        );
        yield* expectSqlFailure(
          runtimeSql("update payment.psp_operation_payer_contacts set full_name = 'Changed' where operation_id = $1"),
          '42501',
        );
        yield* expectSqlFailure(
          runtimeSql('delete from payment.psp_operation_payer_contacts where operation_id = $1'),
          '42501',
        );
        // An empty contact is not a contact.
        const empty = yield* collectFixture(runtime, scope, binding);
        yield* expectSqlFailure(
          inScope(
            runtimeClient,
            scope,
            runtimeClient.unsafe(
              'insert into payment.psp_operation_payer_contacts (tenant_id, legal_entity_id, operation_id) values ($1, $2, $3)',
              [scope.tenantId, scope.legalEntityId, empty.operationId],
            ),
          ),
          '23514',
          'payment_psp_payer_contacts_present_ck',
        );

        // PREPARED deletes it in the same transaction.
        yield* expectTagged(
          yield* withRoutines(runtime, scope, (invoker) =>
            pspPrepareDispatch(invoker, prepareInput(prepared, binding, origin)),
          ),
          'PREPARED',
        );
        expect(yield* storedContactCount(admin, prepared.operationId)).toBe(0);
        expect(yield* contactOf(runtime, scope, prepared.operationId)).toEqual(Option.none());

        // NOT_SENT deletes it.
        const notSentScope = yield* makeTestScope;
        const notSentBinding = yield* bindingFixture(runtimeClient, notSentScope, 'COMGATE');
        const notSent = yield* collectFixture(runtime, notSentScope, notSentBinding);
        yield* insertContact(runtimeClient, notSentScope, notSent.operationId, 'Test Payer');
        expect(yield* storedContactCount(admin, notSent.operationId)).toBe(1);
        yield* expectTagged(
          yield* withRoutines(runtime, notSentScope, (invoker) =>
            pspRecordNotSent(invoker, {
              bindingId: notSentBinding.bindingId,
              materialHash: notSent.materialHash,
              operationId: notSent.operationId,
              origin,
              reason: 'PREPARE_UNAVAILABLE',
            }),
          ),
          'RECORDED',
        );
        expect(yield* storedContactCount(admin, notSent.operationId)).toBe(0);

        // A COLLECT withheld for a registered cancel deletes it too.
        const withheldScope = yield* makeTestScope;
        const withheldBinding = yield* bindingFixture(runtimeClient, withheldScope, 'COMGATE');
        const withheld = yield* collectFixture(runtime, withheldScope, withheldBinding);
        yield* insertContact(runtimeClient, withheldScope, withheld.operationId, 'Test Payer');
        const provenance = yield* provenanceFor(withheldScope);
        const cancel = yield* withPersistence(runtime, withheldScope, (persistence) =>
          persistence.insertOperation({
            amount: { amountMinor: 0, currency: 'CZK' },
            binding: executionBindingOf(withheldBinding),
            initialOutcome: 'PENDING',
            kind: 'CANCEL_OR_VOID',
            materialRequest: { kind: 'CANCEL_OR_VOID', targetOperationId: withheld.operationId },
            operationKey: 'cancel-1',
            paymentId: withheld.paymentId,
            provenance,
            targetOperationId: withheld.operationId,
          }),
        );
        yield* expectTagged(
          yield* withRoutines(runtime, withheldScope, (invoker) =>
            pspRegisterCancel(invoker, {
              bindingId: withheldBinding.bindingId,
              materialHash: cancel.record.materialHash,
              operationId: cancel.record.operationId,
              origin,
            }),
          ),
          'REGISTERED',
        );
        yield* expectTagged(
          yield* withRoutines(runtime, withheldScope, (invoker) =>
            pspPrepareDispatch(invoker, prepareInput(withheld, withheldBinding, origin)),
          ),
          'WITHHELD',
        );
        expect(yield* storedContactCount(admin, withheld.operationId)).toBe(0);
      }),
    ),
);

it.live('#1157 Expired payer contacts are purged by age only, and never from inside a scope', () =>
  Effect.scoped(
    Effect.gen(function* purgeExpiredContacts() {
      const { admin, runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const binding = yield* bindingFixture(runtimeClient, scope, 'COMGATE');
      const expired = yield* collectFixture(runtime, scope, binding);
      const secondPayment = yield* collectFixture(runtime, scope, binding);
      yield* insertContact(runtimeClient, scope, expired.operationId, 'Expired Payer');
      yield* insertContact(runtimeClient, scope, secondPayment.operationId, 'Recent Payer');
      yield* admin.unsafe(
        `update payment.psp_operation_payer_contacts
         set created_at = case when operation_id = $1 then now() - interval '49 hours' else now() - interval '47 hours' end
         where operation_id in ($1, $2)`,
        [expired.operationId, secondPayment.operationId],
      );

      const purge = (maxAge: string) =>
        runtimeClient.unsafe<{ deleted: number }>(
          'select payment.purge_expired_payer_contacts($1::interval) as deleted',
          [maxAge],
        );
      yield* expectSqlFailure(inScope(runtimeClient, scope, purge('48 hours')), '42501');
      yield* expectSqlFailure(purge('30 minutes').pipe(runtimeClient.withTransaction), '22023');
      expect(yield* storedContactCount(admin, expired.operationId)).toBe(1);

      const [purged] = yield* purge('48 hours').pipe(runtimeClient.withTransaction);
      expect(purged?.deleted).toBeGreaterThanOrEqual(1);
      expect(yield* storedContactCount(admin, expired.operationId)).toBe(0);
      expect(yield* storedContactCount(admin, secondPayment.operationId)).toBe(1);
    }),
  ),
);

it.live('#1155 Binding routes are Tenant-isolated, insert-once and keep the binding family', () =>
  Effect.scoped(
    Effect.gen(function* routeIsolation() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const scope = yield* makeTestScope;
      const otherTenant = yield* makeTestScope;
      const sameTenantOtherLegalEntity = { ...(yield* makeTestScope), tenantId: scope.tenantId };
      const binding = yield* bindingFixture(runtimeClient, scope, 'GOPAY');
      const visibleRoutes = (reader: PaymentTestScope) =>
        inScope(
          runtimeClient,
          reader,
          runtimeClient.unsafe<{ route_key: string }>(
            'select route_key from payment.psp_binding_routes where binding_id = $1',
            [binding.bindingId],
          ),
        );

      const [own] = yield* visibleRoutes(scope);
      expect(own?.route_key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      // The route Read has no Legal Entity scope: the route resolves anywhere inside its Tenant, nowhere else.
      expect(yield* visibleRoutes(sameTenantOtherLegalEntity)).toHaveLength(1);
      expect(yield* visibleRoutes(otherTenant)).toHaveLength(0);
      const routeKey = own?.route_key ?? '';
      const tenantRead = (reader: PaymentTestScope) =>
        inScope(
          runtimeClient,
          reader,
          runtimeClient.unsafe<{ binding_id: string }>(
            'select binding_id from payment.psp_binding_routes where route_key = $1',
            [routeKey],
          ),
        );
      expect(yield* tenantRead(otherTenant)).toHaveLength(0);

      // One route per binding, one route key per Tenant, a well-formed key and the binding's own family.
      const fresh = yield* routeKeyOf;
      yield* expectSqlFailure(
        insertRoute(runtimeClient, scope, binding, fresh),
        '23505',
        'payment_psp_binding_routes_binding_uk',
      );
      yield* expectSqlFailure(
        insertRoute(runtimeClient, scope, binding, 'short-key'),
        '23514',
        'payment_psp_binding_routes_key_ck',
      );
      const otherBinding = yield* bindingFixture(runtimeClient, sameTenantOtherLegalEntity, 'STRIPE');
      const [otherRoute] = yield* inScope(
        runtimeClient,
        sameTenantOtherLegalEntity,
        runtimeClient.unsafe<{ route_key: string }>(
          'select route_key from payment.psp_binding_routes where binding_id = $1',
          [otherBinding.bindingId],
        ),
      );
      expect(otherRoute?.route_key).not.toBe(routeKey);
      yield* expectSqlFailure(
        inScope(
          runtimeClient,
          scope,
          runtimeClient.unsafe('delete from payment.psp_binding_routes where binding_id = $1', [binding.bindingId]),
        ),
        '42501',
      );
      yield* expectSqlFailure(
        inScope(
          runtimeClient,
          scope,
          runtimeClient.unsafe('update payment.psp_binding_routes set route_revision = 2 where binding_id = $1', [
            binding.bindingId,
          ]),
        ),
        '42501',
      );
      // Another family than the binding's, or another Tenant than the installed one, is refused.
      const unrouted = yield* unroutedBindingFixture(runtimeClient, scope, 'COMGATE');
      yield* expectSqlFailure(
        insertRoute(runtimeClient, scope, unrouted, yield* routeKeyOf, { family: 'STRIPE' }),
        '23503',
        'payment_psp_binding_routes_binding_fk',
      );
      yield* expectSqlFailure(
        insertRoute(runtimeClient, scope, unrouted, yield* routeKeyOf, { tenantId: otherTenant.tenantId }),
        '42501',
      );
      // The same route key under another Tenant is that Tenant's own key space.
      const foreign = yield* unroutedBindingFixture(runtimeClient, otherTenant, 'COMGATE');
      yield* insertRoute(runtimeClient, otherTenant, foreign, routeKey);
      expect(yield* tenantRead(scope)).toEqual([{ binding_id: binding.bindingId }]);
      expect(yield* tenantRead(otherTenant)).toEqual([{ binding_id: foreign.bindingId }]);
      yield* expectSqlFailure(
        insertRoute(runtimeClient, scope, unrouted, routeKey),
        '23505',
        'payment_psp_binding_routes_pk',
      );
    }),
  ),
);

/** A COLLECT through `binding` that the provider acknowledged, confirmed, plus refunds of it. */
const refundableFixture = Effect.fn('PspPhase2Fixture.refundable')(function* refundableFixture(
  runtime: PaymentTestDatabase,
  runtimeClient: PgClient.PgClient,
  scope: PaymentTestScope,
  family: PaymentGatewayProviderFamily,
  providerPaymentRef: string,
) {
  const binding = yield* bindingFixture(runtimeClient, scope, family);
  const collect = yield* collectFixture(runtime, scope, binding);
  const origin = yield* workerOrigin;
  yield* expectTagged(
    yield* withRoutines(runtime, scope, (invoker) =>
      pspPrepareDispatch(invoker, prepareInput(collect, binding, origin)),
    ),
    'PREPARED',
  );
  yield* recordOutcome(runtime, scope, origin, collect.operationId, 'ACKNOWLEDGED', Option.some(providerPaymentRef));
  const executionBinding = executionBindingOf(binding);
  const [confirm, refundExecutionRoute] = yield* Effect.all(
    [provenanceFor(scope), configuredRefundExecutionRouteFor(runtime, scope, executionBinding)],
    { concurrency: 1 },
  );
  yield* withPersistence(runtime, scope, (persistence) =>
    persistence.transitionOperationOutcome({
      causedBy: { kind: 'OBSERVATION', sourceId: 'observation:captured' },
      expectedOutcomeRevision: 1,
      operationId: collect.operationId,
      paymentId: collect.paymentId,
      provenance: confirm,
      to: 'EFFECT_CONFIRMED',
    }),
  );
  const refund = Effect.fn('PspPhase2Fixture.refund')(function* refund(itemRef: string) {
    const provenance = yield* provenanceFor(scope);
    const created = yield* withPersistence(runtime, scope, (persistence) =>
      persistence.insertOperation({
        amount: { amountMinor: 10_000, currency: 'CZK' },
        binding: executionBinding,
        initialOutcome: 'PENDING',
        kind: 'REFUND',
        materialRequest: { itemRefs: [itemRef], kind: 'REFUND', operationKey: `refund-${itemRef}` },
        operationKey: `refund-${itemRef}`,
        paymentId: collect.paymentId,
        provenance,
        refundBasis: {
          _tag: 'REFUNDABLE_ITEMS',
          items: [{ amountMinor: 10_000, currency: 'CZK', itemRef, sourceEvidenceRef: `order:item:${itemRef}` }],
        },
        refundExecutionRoute,
        targetOperationId: collect.operationId,
      }),
    );
    return { materialHash: created.record.materialHash, operationId: created.record.operationId };
  });
  const prepareRefund = (operation: { readonly materialHash: string; readonly operationId: string }) =>
    withRoutines(runtime, scope, (invoker) =>
      pspPrepareDispatch(invoker, prepareInput(operation, binding, origin, Option.some(providerPaymentRef))),
    );
  return { binding, origin, prepareRefund, refund };
});

it.live('#1158 A Comgate refund waits only for a prepared or unknown refund, GoPay also for an acknowledged one', () =>
  Effect.scoped(
    Effect.gen(function* familyRefundSerialisation() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const comgate = yield* refundableFixture(runtime, runtimeClient, scope, 'COMGATE', 'AB12-CD34-EF56');
      const [first, second, third] = yield* Effect.all(
        [comgate.refund('A'), comgate.refund('B'), comgate.refund('C')],
        { concurrency: 1 },
      );

      yield* expectTagged(yield* comgate.prepareRefund(first), 'PREPARED');
      const behindPrepared = yield* expectTagged(yield* comgate.prepareRefund(second), 'DEFERRED');
      expect(behindPrepared.unresolvedRefundOperationIds).toEqual([first.operationId]);
      yield* recordOutcome(runtime, scope, comgate.origin, first.operationId, 'OUTCOME_UNKNOWN');
      yield* expectTagged(yield* comgate.prepareRefund(second), 'DEFERRED');
      // Acknowledged by Comgate (code 0) without statement proof yet: no longer blocks the next refund.
      yield* recordOutcome(runtime, scope, comgate.origin, first.operationId, 'ACKNOWLEDGED');
      yield* expectTagged(yield* comgate.prepareRefund(second), 'PREPARED');
      const unresolved = yield* withRoutines(runtime, scope, (invoker) =>
        pspHasUnresolvedRefund(invoker, {
          bindingId: comgate.binding.bindingId,
          excludingOperationId: Option.some(third.operationId),
          providerPaymentRef: 'AB12-CD34-EF56',
        }),
      );
      expect(unresolved).toEqual({ operationIds: [second.operationId], unresolved: true });

      // GoPay keeps the strict rule: an acknowledged refund without terminal evidence still blocks.
      const gopayScope = yield* makeTestScope;
      const gopay = yield* refundableFixture(runtime, runtimeClient, gopayScope, 'GOPAY', '3000006529');
      const [gopayFirst, gopaySecond] = yield* Effect.all([gopay.refund('A'), gopay.refund('B')], {
        concurrency: 1,
      });
      yield* expectTagged(yield* gopay.prepareRefund(gopayFirst), 'PREPARED');
      yield* recordOutcome(runtime, gopayScope, gopay.origin, gopayFirst.operationId, 'ACKNOWLEDGED');
      const behindAcknowledged = yield* expectTagged(yield* gopay.prepareRefund(gopaySecond), 'DEFERRED');
      expect(behindAcknowledged.unresolvedRefundOperationIds).toEqual([gopayFirst.operationId]);
    }),
  ),
);

interface DueRow {
  readonly legal_entity_id: string;
  readonly operation_id: string;
  readonly payment_id: string;
  readonly provider_family: string;
  readonly recommended_trigger: string;
  readonly round: number;
  readonly route_key: string;
  readonly tenant_id: string;
}

const listDue = (
  runtimeClient: PgClient.PgClient,
  cursor: readonly [string, string, string] | readonly [null, null, null],
  pageLimit: number,
  maxRounds: number,
) =>
  runtimeClient.unsafe<DueRow>('select * from payment.list_due_gateway_reconciliation($1, $2, $3, $4, $5)', [
    ...cursor,
    pageLimit,
    maxRounds,
  ]);

const dueKey = (row: { readonly legal_entity_id: string; readonly operation_id: string; readonly tenant_id: string }) =>
  `${row.tenant_id}/${row.legal_entity_id}/${row.operation_id}`;

const scopeOf = (collect: CollectFixture, scope: PaymentTestScope) => ({
  legal_entity_id: scope.legalEntityId,
  operation_id: collect.operationId,
  payment_id: collect.paymentId,
  tenant_id: scope.tenantId,
});

/** A new scope (Legal Entity and principal) inside `tenantId`. */
const scopeIn = (tenantId: string) =>
  makeTestScope.pipe(Effect.map((scope): PaymentTestScope => ({ ...scope, tenantId })));

/** A Tenant id under `prefix`, so the listing can start right before this test's Tenants. */
const tenantUnder = (prefix: string) => randomUuid.pipe(Effect.map((uuid) => `${prefix}${uuid.slice(8)}`));

it.live(
  '#1158/#1234 The due listing pages across Tenants and excludes resolved, held, backed-off and exhausted rows',
  () =>
    Effect.scoped(
      Effect.gen(function* dueReconciliation() {
        const { admin, runtime: runtimeClient } = yield* testDatabaseClients;
        const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
        const prefix = (yield* randomUuid).slice(0, 8);
        const [firstTenant, secondTenant] = yield* Effect.all([tenantUnder(prefix), tenantUnder(prefix)], {
          concurrency: 1,
        });
        const main = yield* scopeIn(firstTenant);
        const scopes = [main, yield* scopeIn(firstTenant), yield* scopeIn(secondTenant), yield* scopeIn(secondTenant)];
        const origin = yield* workerOrigin;

        /** A COLLECT whose dispatch reached the given ledger state. */
        const collectIn = Effect.fn('PspPhase2Fixture.dueCollect')(function* collectIn(
          scope: PaymentTestScope,
          binding: BindingFixture,
          state: 'ACKNOWLEDGED' | 'NOT_SENT' | 'OUTCOME_UNKNOWN',
        ) {
          const collect = yield* collectFixture(runtime, scope, binding);
          if (state === 'NOT_SENT') {
            yield* withRoutines(runtime, scope, (invoker) =>
              pspRecordNotSent(invoker, {
                bindingId: binding.bindingId,
                materialHash: collect.materialHash,
                operationId: collect.operationId,
                origin,
                reason: 'PREPARE_UNAVAILABLE',
              }),
            );
            return collect;
          }
          yield* withRoutines(runtime, scope, (invoker) =>
            pspPrepareDispatch(invoker, prepareInput(collect, binding, origin)),
          );
          yield* recordOutcome(
            runtime,
            scope,
            origin,
            collect.operationId,
            state,
            state === 'ACKNOWLEDGED' ? Option.some(`ref-${collect.operationId}`) : Option.none(),
          );
          return collect;
        });
        /** Recovery requests of `collect` at the given ages, written as the recovery Action writes them. */
        const recoveredAt = (scope: PaymentTestScope, collect: CollectFixture, ages: readonly string[]) =>
          Effect.forEach(
            ages,
            (age) =>
              inScope(
                admin,
                scope,
                admin.unsafe(
                  `insert into payment.recovery_requests (tenant_id, legal_entity_id, action_invocation_id, actor_principal_id,
                   composition_revision, binding_snapshot, mode, operation_id, payment_id, reason, requested_at)
                 values ($1, $2, gen_random_uuid(), $3, $4, '{}'::jsonb, 'AUTHORITATIVE_LOOKUP', $5, $6,
                   'Gateway reconciliation test round', now() - $7::interval)`,
                  [
                    scope.tenantId,
                    scope.legalEntityId,
                    scope.principalId,
                    COMPOSITION_REVISION,
                    collect.operationId,
                    collect.paymentId,
                    age,
                  ],
                ),
              ),
            { concurrency: 1, discard: true },
          );

        const scoped = yield* Effect.forEach(
          scopes,
          (scope) => bindingFixture(runtimeClient, scope, 'STRIPE').pipe(Effect.map((binding) => ({ binding, scope }))),
          { concurrency: 1 },
        );
        const mainBinding = yield* bindingFixture(runtimeClient, main, 'GOPAY');
        // Due in every scope: an unknown outcome never recovered yet (round 0).
        const unknowns = yield* Effect.forEach(
          scoped,
          ({ binding, scope }) =>
            collectIn(scope, binding, 'OUTCOME_UNKNOWN').pipe(Effect.map((collect) => scopeOf(collect, scope))),
          { concurrency: 1 },
        );
        // Due: never sent while the outcome is pending; recommended as overdue.
        const notSentScope = yield* scopeIn(secondTenant);
        const notSentBinding = yield* bindingFixture(runtimeClient, notSentScope, 'COMGATE');
        const notSent = yield* collectIn(notSentScope, notSentBinding, 'NOT_SENT');
        // Due again: one round 16 minutes ago (15 minute backoff), two rounds with the last 31 minutes ago (30 minutes).
        const roundOne = yield* collectIn(main, mainBinding, 'OUTCOME_UNKNOWN');
        yield* recoveredAt(main, roundOne, ['16 minutes']);
        const roundTwo = yield* collectIn(main, mainBinding, 'OUTCOME_UNKNOWN');
        yield* recoveredAt(main, roundTwo, ['2 days', '31 minutes']);
        // Not due: resolved, held by an open case, inside its backoff, out of rounds, acknowledged within budget.
        const resolved = yield* collectIn(main, mainBinding, 'OUTCOME_UNKNOWN');
        const confirm = yield* provenanceFor(main);
        yield* withPersistence(runtime, main, (persistence) =>
          persistence.transitionOperationOutcome({
            causedBy: { kind: 'OBSERVATION', sourceId: 'observation:captured' },
            expectedOutcomeRevision: 1,
            operationId: resolved.operationId,
            paymentId: resolved.paymentId,
            provenance: confirm,
            to: 'EFFECT_CONFIRMED',
          }),
        );
        const held = yield* collectIn(main, mainBinding, 'OUTCOME_UNKNOWN');
        yield* inScope(
          admin,
          main,
          admin.unsafe(
            `insert into payment.reconciliation_cases (tenant_id, legal_entity_id, action_invocation_id, actor_principal_id,
             composition_revision, case_kind, opened_at, operation_id, payment_id, revision, status)
           values ($1, $2, gen_random_uuid(), $3, $4, 'UNRESOLVED_OPERATION', now(), $5, $6, 1, 'OPEN')`,
            [
              main.tenantId,
              main.legalEntityId,
              main.principalId,
              COMPOSITION_REVISION,
              held.operationId,
              held.paymentId,
            ],
          ),
        );
        const backingOff = yield* collectIn(main, mainBinding, 'OUTCOME_UNKNOWN');
        yield* recoveredAt(main, backingOff, ['14 minutes']);
        const exhausted = yield* collectIn(main, mainBinding, 'OUTCOME_UNKNOWN');
        yield* recoveredAt(main, exhausted, ['3 days', '2 days', '1 day']);
        const acknowledged = yield* collectIn(main, mainBinding, 'ACKNOWLEDGED');

        const ours = (row: DueRow) => row.tenant_id === firstTenant || row.tenant_id === secondTenant;
        const start = [`${prefix}-0000-0000-0000-000000000000`, ZERO_UUID, ZERO_UUID] as const;
        // Page with a small limit until the listing leaves this test's Tenants.
        const pageFrom = (
          cursor: readonly [string, string, string],
          collected: readonly DueRow[],
        ): Effect.Effect<readonly DueRow[], unknown> =>
          listDue(runtimeClient, cursor, 3, 3).pipe(
            runtimeClient.withTransaction,
            Effect.flatMap((rows) => {
              const next = [...collected, ...rows.filter(ours)];
              const last = rows.at(-1);
              return last === undefined || rows.length < 3 || !rows.every(ours)
                ? Effect.succeed(next)
                : pageFrom([last.tenant_id, last.legal_entity_id, last.operation_id], next);
            }),
          );
        const paged = yield* pageFrom(start, []);
        const single = (yield* listDue(runtimeClient, start, 500, 3).pipe(runtimeClient.withTransaction)).filter(ours);

        const expectedDue = EffectArray.sort(
          [...unknowns, scopeOf(notSent, notSentScope), scopeOf(roundOne, main), scopeOf(roundTwo, main)].map(dueKey),
          Order.String,
        );
        expect(paged.map(dueKey)).toEqual(expectedDue);
        expect(single.map(dueKey)).toEqual(expectedDue);
        for (const excluded of [resolved, held, backingOff, exhausted, acknowledged]) {
          expect(single.map((row) => row.operation_id)).not.toContain(excluded.operationId);
        }
        const byOperation = new Map(single.map((row) => [row.operation_id, row]));
        expect(byOperation.get(roundOne.operationId)?.round).toBe(1);
        expect(byOperation.get(roundTwo.operationId)?.round).toBe(2);
        expect(byOperation.get(notSent.operationId)?.recommended_trigger).toBe('OUTCOME_OVERDUE');
        const firstUnknown = byOperation.get(unknowns[0]?.operation_id ?? '');
        expect([firstUnknown?.round, firstUnknown?.recommended_trigger, firstUnknown?.provider_family]).toEqual([
          0,
          'EXECUTION_OUTCOME_UNKNOWN',
          'STRIPE',
        ]);
        expect(firstUnknown?.payment_id).toBe(unknowns[0]?.payment_id);
        expect(firstUnknown?.route_key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(byOperation.get(roundOne.operationId)?.provider_family).toBe('GOPAY');
        // A bigger round budget lets the exhausted operation in; its backoff (24 h cap) has passed.
        const wider = (yield* listDue(runtimeClient, start, 500, 4).pipe(runtimeClient.withTransaction)).filter(ours);
        expect(wider.map((row) => row.operation_id)).toContain(exhausted.operationId);

        // Inside any operational scope the listing refuses; a partial cursor is refused too.
        yield* expectSqlFailure(inScope(runtimeClient, main, listDue(runtimeClient, start, 10, 3)), '42501');
        yield* expectSqlFailure(
          runtimeClient
            .unsafe('select * from payment.list_due_gateway_reconciliation($1, null, null, 10, 3)', [firstTenant])
            .pipe(runtimeClient.withTransaction),
          '22023',
        );
      }),
    ),
);
