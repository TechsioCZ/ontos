import { defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { OutboxPayloadSchema } from '@app/payment/outbox/payment-core-operation-requested-v1';
import { NodeCrypto } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, Effect, Exit, Option, Schema } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { PaymentPayerContactRefused } from '../../shared/actions/start-payment-collection.ts';
import type { PaymentPayerContact } from '../../shared/domain/payment-payer-contact.ts';
import { createPaymentAction } from '../../src/actions/create-payment.action.ts';
import { startPaymentCollectionAction } from '../../src/actions/start-payment-collection.action.ts';
import { paymentApplicabilityPersistenceForTransaction } from '../../src/persistence/payment-applicability-persistence.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { makeLifecycleOwnerContractFixture } from '../support/lifecycle-owner-contract.fixture.ts';
import { credentialConfig, recordedGatewayAdapters, respond } from '../support/psp-conformance-provider.fixture.ts';
import {
  deliverExecution,
  dispatchStateOf,
  nativeBindingFor,
  nativeHarnessOf,
} from '../support/psp-native-gateway.fixture.ts';
import type { NativeBinding, NativeFamily } from '../support/psp-native-gateway.fixture.ts';
import { installPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
import { makeTestScope, operationalScopeOf, paymentTestRelations, purchasingContextFor } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  evidenceAllowedPermission,
  evidenceContextAccess,
  principalOf,
  seedCoreScope,
} from './evidence-native-support.ts';

/**
 * #1153 #1154 #1155 plan D-P3: the payer contact of `start-payment-collection` through the real Core Action runtime
 * on PostgreSQL. Payment's Actions, persistence, RLS, the insert-only contact table and the C17 routines are real;
 * only the C15 term evidence and the C17 enablement port answers come from the lifecycle owner fixture, which names
 * the real C17 bindings created here. The last test hands the committed Outbox payload to the production executor
 * with the production Comgate adapter over a recorded HttpClient.
 */

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const CUSTOMER_CONFIGURATION = 'customer-configuration-payer-contact';
const COMGATE_SECRET_REF = 'comgate.payer-contact.conformance';
const COMGATE_CREATE = 'POST https://payments.comgate.cz/v2.0/payment.json';
const OPERATION_REQUESTED = 'payment.core.operation-requested.v1';
const AMOUNT_MINOR = 10_000;
const EMAIL = 'payer@example.test';
const OTHER_EMAIL = 'other-payer@example.test';

const comgateCreateSuccess = readFileSync(new URL('../fixtures/comgate/create-success.json', import.meta.url), 'utf-8');

interface CountRow extends Record<string, unknown> {
  readonly count: number;
}

interface ContactRow extends Record<string, unknown> {
  readonly email: string | null;
  readonly full_name: string | null;
  readonly phone: string | null;
}

const setup = Effect.fn('PayerContact.setup')(function* setup() {
  const { admin, runtime: runtimeClient } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const coreDatabase = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
  const paymentDatabase = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
  const scope = yield* makeTestScope;
  yield* seedCoreScope({ coreAdmin, database: coreDatabase, runtimeClient }, scope);
  yield* paymentDatabase.transaction((transaction) =>
    installOperationalScope(transaction, operationalScopeOf(scope), defineDatabaseIdentityEnrollment([])).pipe(
      Effect.flatMap((scoped) =>
        paymentApplicabilityPersistenceForTransaction(scoped).configureEnablement({
          customerConfigurationId: CUSTOMER_CONFIGURATION,
          enabled: true,
          expectedRevision: Option.none(),
          method: 'ONLINE_GATEWAY',
          provenance: {
            actionInvocationId: randomUUID(),
            actorPrincipalId: scope.principalId,
            compositionRevision: COMPOSITION_R1,
          },
          reason: 'payer contact precondition: the merchant offers online gateway payments',
        }),
      ),
    ),
  );
  const harness = nativeHarnessOf(paymentDatabase, runtimeClient, scope);
  const bindings = {
    COMGATE: yield* nativeBindingFor(harness, 'COMGATE', COMGATE_SECRET_REF),
    GOPAY: yield* nativeBindingFor(harness, 'GOPAY', 'gopay.payer-contact.conformance'),
    STRIPE: yield* nativeBindingFor(harness, 'STRIPE', 'stripe.payer-contact.conformance'),
  } satisfies Record<NativeFamily, NativeBinding>;
  const owners = yield* makeLifecycleOwnerContractFixture({
    enabledBindings: Object.values(bindings).map((binding) => binding.executionBinding),
    gatewayAvailable: true,
    metadataRevision: 1,
    termUse: 'USABLE',
  });
  const crypto = yield* Crypto.Crypto;
  const actions = makeActionRuntime(
    { executor: coreDatabase },
    makeActionRepository(crypto),
    evidenceAllowedPermission,
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision: makeScriptedBoundAccessGate('allowed').bound,
      contextAccess: evidenceContextAccess,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
      resolveCompositionRevision: () => Effect.succeed(COMPOSITION_R1),
    },
  );
  const principal = principalOf(scope);
  const paymentTermRef = {
    moduleId: 'payment.term-catalog' as const,
    resourceId: randomUUID(),
    resourceType: 'payment.term-catalog.payment-term' as const,
    tenantId: scope.tenantId,
  };

  /** A new ONLINE_GATEWAY Payment intent on the real C17 binding of `family`. */
  const createPayment = (family: NativeFamily) => {
    const purchaseCorrelationId = `purchase-${randomUUID()}`;
    return actions
      .runAction({
        payload: {
          customerConfigurationId: CUSTOMER_CONFIGURATION,
          intentKey: `intent-${randomUUID()}`,
          payableAmount: { amountMinor: AMOUNT_MINOR, currency: 'CZK' as const },
          paymentTermRef,
          purchaseCorrelationId,
          purchasingContext: purchasingContextFor(scope, purchaseCorrelationId),
          selection: { method: 'ONLINE_GATEWAY' as const, selectedBinding: bindings[family].executionBinding },
        },
        principal,
        registration: createPaymentAction,
        transport: { correlationId: 'payer-contact-create', idempotencyKey: randomUUID() },
      })
      .pipe(
        Effect.provide(owners.layer),
        Effect.map((created) => created.payment.paymentId),
      );
  };

  /** One start-payment-collection invocation; `payerContact` is sent only when given. */
  const collect = (paymentId: string, operationKey: string, payerContact: Option.Option<PaymentPayerContact>) =>
    actions
      .runAction({
        payload: {
          amount: { amountMinor: AMOUNT_MINOR, currency: 'CZK' as const },
          method: 'ONLINE_GATEWAY' as const,
          operationKey,
          paymentId,
          ...Option.match(payerContact, { onNone: () => ({}), onSome: (contact) => ({ payerContact: contact }) }),
        },
        principal,
        registration: startPaymentCollectionAction,
        transport: { correlationId: 'payer-contact-collect', idempotencyKey: randomUUID() },
      })
      .pipe(Effect.provide(owners.layer));

  return { admin, bindings, collect, createPayment, harness, scope };
});

type Setup = Effect.Success<ReturnType<typeof setup>>;

const refusalCode = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  Effect.flip(operation).pipe(
    Effect.map((failure) => (Schema.is(PaymentPayerContactRefused)(failure) ? failure.code : failure)),
  );

const contactRows = (admin: PgClient.PgClient, operationId: string) =>
  admin.unsafe<ContactRow>(
    'select full_name, email, phone from payment.psp_operation_payer_contacts where operation_id = $1',
    [operationId],
  );

const contactRowsOfTenant = (s: Setup) =>
  s.admin
    .unsafe<CountRow>(
      'select count(*)::integer as count from payment.psp_operation_payer_contacts where tenant_id = $1',
      [s.scope.tenantId],
    )
    .pipe(Effect.map((rows) => rows[0]?.count ?? -1));

const operationsOf = (s: Setup, paymentId: string) =>
  s.admin
    .unsafe<CountRow>('select count(*)::integer as count from payment.payment_operations where payment_id = $1', [
      paymentId,
    ])
    .pipe(Effect.map((rows) => rows[0]?.count ?? -1));

/**
 * Rows of the tenant whose whole JSON text names `needle`: Core events, Outbox messages, Action invocations and
 * Payment's operation rows (material request and every projected column).
 */
const tracesOf = (s: Setup, needle: string) =>
  s.admin
    .unsafe<CountRow>(
      `select (
         (select count(*) from core.domain_events row where row.tenant_id = $1 and row_to_json(row)::text like $2)
       + (select count(*) from core.outbox_messages row where row.tenant_id = $1 and row_to_json(row)::text like $2)
       + (select count(*) from core.action_invocations row where row.tenant_id = $1 and row_to_json(row)::text like $2)
       + (select count(*) from payment.payment_operations row where row.tenant_id = $1 and row_to_json(row)::text like $2)
       + (select count(*) from payment.payments row where row.tenant_id = $1 and row_to_json(row)::text like $2)
       )::integer as count`,
      [s.scope.tenantId, `%${needle}%`],
    )
    .pipe(Effect.map((rows) => rows[0]?.count ?? -1));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const requestedPayloadOf = (s: Setup, operationId: string) =>
  s.admin
    .unsafe<{ readonly payload_json: unknown }>(
      `select payload_json from core.outbox_messages
        where tenant_id = $1 and topic = $2 and payload_json ->> 'operationId' = $3`,
      [s.scope.tenantId, OPERATION_REQUESTED, operationId],
    )
    .pipe(
      Effect.flatMap((rows) => Effect.fromOption(Option.fromUndefinedOr(rows[0]))),
      Effect.flatMap((row) => Schema.decodeUnknownEffect(OutboxPayloadSchema)(row.payload_json)),
    );

it.live(
  '#1153 H1094-01=A Stripe and GoPay collections need no contact, Comgate a full name and an email or phone',
  () =>
    native(
      Effect.gen(function* contactPerFamily() {
        yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
        const s = yield* setup();

        // Stripe: no contact needed; a supplied one is not applicable.
        const stripe = yield* s.createPayment('STRIPE');
        expect(yield* refusalCode(s.collect(stripe, 'collect-1', Option.some({ email: EMAIL })))).toBe(
          'payment_payer_contact_not_applicable',
        );
        const stripeCollected = yield* s.collect(stripe, 'collect-1', Option.none());
        expect(stripeCollected.replayed).toBe(false);
        expect(yield* contactRows(s.admin, stripeCollected.operation.operationId)).toEqual([]);

        // GoPay: like Stripe, no contact needed; a supplied one is not applicable.
        const gopay = yield* s.createPayment('GOPAY');
        expect(yield* refusalCode(s.collect(gopay, 'collect-1', Option.some({ email: EMAIL })))).toBe(
          'payment_payer_contact_not_applicable',
        );
        expect(yield* operationsOf(s, gopay)).toBe(0);
        const gopayCollected = yield* s.collect(gopay, 'collect-1', Option.none());
        expect(gopayCollected.replayed).toBe(false);
        expect(yield* contactRows(s.admin, gopayCollected.operation.operationId)).toEqual([]);

        // Comgate: a full name plus an email or a phone.
        const comgate = yield* s.createPayment('COMGATE');
        expect(yield* refusalCode(s.collect(comgate, 'collect-1', Option.none()))).toBe(
          'payment_payer_contact_required',
        );
        expect(yield* refusalCode(s.collect(comgate, 'collect-1', Option.some({ fullName: 'Test Payer' })))).toBe(
          'payment_payer_contact_required',
        );
        expect(yield* refusalCode(s.collect(comgate, 'collect-1', Option.some({ email: EMAIL })))).toBe(
          'payment_payer_contact_required',
        );
        expect(yield* operationsOf(s, comgate)).toBe(0);
        const comgateCollected = yield* s.collect(
          comgate,
          'collect-1',
          Option.some({ fullName: 'Test Payer', phone: '+420700000000' }),
        );
        expect(yield* contactRows(s.admin, comgateCollected.operation.operationId)).toEqual([
          { email: null, full_name: 'Test Payer', phone: '+420700000000' },
        ]);
        expect(yield* contactRowsOfTenant(s)).toBe(1);
      }),
    ),
);

it.live(
  '#1153 The contact stays out of Core events, Outbox messages, the Action invocation and Payment views; a replay inserts nothing',
  () =>
    native(
      Effect.gen(function* contactNotRetained() {
        yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
        const s = yield* setup();
        const paymentId = yield* s.createPayment('COMGATE');
        const first = yield* s.collect(paymentId, 'collect-1', Option.some({ email: EMAIL, fullName: 'Test Payer' }));
        const { operationId } = first.operation;

        // A replay of the same operation with another contact recovers the operation and keeps the first contact.
        const replay = yield* s.collect(
          paymentId,
          'collect-1',
          Option.some({ email: OTHER_EMAIL, fullName: 'Other Payer' }),
        );
        expect([replay.replayed, replay.operation.operationId]).toEqual([true, operationId]);
        expect(yield* contactRows(s.admin, operationId)).toEqual([
          { email: EMAIL, full_name: 'Test Payer', phone: null },
        ]);

        // Only the short-lived contact row holds it: the requested event and Outbox payload carry no contact, the
        // invocation keeps only its request hash, and neither the operation material nor the result view has it.
        for (const needle of [EMAIL, OTHER_EMAIL, 'Test Payer', 'Other Payer']) {
          expect(yield* tracesOf(s, needle)).toBe(0);
        }
        const requested = yield* requestedPayloadOf(s, operationId);
        expect(requested).not.toHaveProperty('payerContact');
        for (const view of [encodeJson(first), encodeJson(replay)]) {
          expect(view).not.toContain(EMAIL);
          expect(view).not.toContain('Test Payer');
        }
      }),
    ),
);

it.live(
  '#1154 A Comgate collect reaches the provider create with the caller contact, and PREPARED deletes the stored row',
  () =>
    native(
      Effect.gen(function* comgateCreateWithContact() {
        yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
        const s = yield* setup();
        const paymentId = yield* s.createPayment('COMGATE');
        const collected = yield* s.collect(
          paymentId,
          'collect-1',
          Option.some({ email: EMAIL, fullName: 'Test Payer' }),
        );
        const { operationId } = collected.operation;
        const payload = yield* requestedPayloadOf(s, operationId);

        const credentials = {
          [COMGATE_SECRET_REF]: { family: 'COMGATE', secret: 'comgate-payer-contact-not-a-secret' },
        };
        const step = yield* recordedGatewayAdapters({ [COMGATE_CREATE]: [respond(200, comgateCreateSuccess)] }).pipe(
          Effect.provide(credentialConfig(credentials)),
        );
        const exit = yield* deliverExecution(s.harness, payload, step.adapters).pipe(
          Effect.provide(credentialConfig(credentials)),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(step.sent.map(({ route }) => route)).toEqual([COMGATE_CREATE]);
        const body = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
          step.callsTo(COMGATE_CREATE)[0]?.body ?? '',
        );
        expect([body.fullName, body.email]).toEqual(['Test Payer', EMAIL]);
        expect((yield* dispatchStateOf(s.harness, operationId)).pipe(Option.map(([state]) => state))).toEqual(
          Option.some('ACKNOWLEDGED'),
        );
        expect(yield* contactRows(s.admin, operationId)).toEqual([]);
      }),
    ),
);
