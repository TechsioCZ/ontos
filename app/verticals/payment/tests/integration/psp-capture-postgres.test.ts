import { defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { and, eq } from 'drizzle-orm';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { Crypto, DateTime, Effect, Layer, Match, Option, Predicate, Redacted, Schema } from 'effect';
import type { Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  actionInvocations,
  auditEvents,
  coreRelations,
  dataAccessEvents,
  domainEvents,
  outboxMessages,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { CaptureProviderNotificationResultSchema } from '../../shared/actions/capture-provider-notification.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import { GatewayMerchantIdentitySchema } from '../../shared/domain/psp-configuration.ts';
import type { GatewayProviderAccountRef } from '../../shared/domain/psp-configuration.ts';
import { captureProviderNotificationAction } from '../../src/actions/capture-provider-notification.action.ts';
import { pspProviderNotifications } from '../../src/database/schema.ts';
import { GATEWAY_LAUNCH_CAPABILITIES } from '../../src/integrations/psp/capability-matrix.ts';
import {
  ProviderNotificationIdSchema,
  ProviderNotificationStore,
} from '../../src/integrations/psp/notification-store.ts';
import { ProviderNotificationStoreLive } from '../../src/integrations/psp/notification-store-live.ts';
import { GatewayProviderAdapters } from '../../src/integrations/psp/psp-adapter.ts';
import type {
  GatewayProviderAdapter,
  GatewayProviderAdaptersContract,
} from '../../src/integrations/psp/psp-adapter.ts';
import { GatewayNotificationRejected, GatewayProviderUnavailable } from '../../src/integrations/psp/psp-errors.ts';
import { decodeStripeEvent, stripeRetainedBodyOf } from '../../src/integrations/stripe/stripe-event.ts';
import { verifyStripeSignature } from '../../src/integrations/stripe/stripe-webhook-signature.ts';
import { pspBindingPersistenceForTransaction } from '../../src/persistence/psp-binding-persistence.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import {
  stripeBalanceObject,
  stripeEventEnvelope,
  STRIPE_FIXTURE_EVENT_CREATED,
} from '../fixtures/stripe/stripe-events.ts';
import { stripePaymentIntentObject } from '../fixtures/stripe/stripe-objects.ts';
import { credentialConfig, recordedGatewayAdapters } from '../support/psp-conformance-provider.fixture.ts';
import {
  CAPTURE_ROUTE_OPERATION,
  routeScopedPrincipalOf,
  testNotificationRouteOf,
} from '../support/route-scope.fixture.ts';
import { installPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
import { makeTestScope, operationalScopeOf, provenanceFor } from './database-fixture.ts';
import type { PaymentTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  evidenceAllowedPermission,
  evidenceContextAccess,
  principalOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase } from './evidence-native-support.ts';

/**
 * #1157 native evidence for `capture-provider-notification` on the worktree PostgreSQL: the registered
 * Action runs through the real Core Action runtime (invocation ledger, scoped transaction, forced RLS,
 * completion-bound Outbox) under an installed Composition authority. Authenticity is decided by a Stripe
 * adapter built from the real v1 signature verifier and event decoder over a fixture signing secret, so a
 * forged signature is refused exactly as in production. Workload admission and the Module State gate are
 * proven by the unit suite through the Core gate.
 */

type GatewayFamily = typeof PaymentGatewayProviderFamilySchema.Type;
type StripeEvent = ReturnType<typeof stripeEventEnvelope>;

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

/** The fixture webhook signing secret of the binding's credential reference; no real account. */
const STRIPE_SECRET_REF = 'stripe-sandbox-1';
const WEBHOOK_SECRET = 'whsec_c17_capture_fixture_secret';
const STRIPE_TOLERANCE_SECONDS = 300;
/** The virtual instant every delivery is received at: one minute after the fixture events were created. */
const RECEIVED_AT_SECONDS = STRIPE_FIXTURE_EVENT_CREATED + 60;

const unavailable = (family: GatewayFamily, reason: string) =>
  new GatewayProviderUnavailable({ code: 'gateway_provider_unavailable', family, reason });
const rejected = (reason: 'BINDING_UNKNOWN' | 'ENVIRONMENT_MISMATCH' | 'MALFORMED') =>
  new GatewayNotificationRejected({ code: 'gateway_notification_rejected', family: 'STRIPE', reason });
const unused = () => Effect.die('Only notification verification is exercised by the capture suite');

/** The production Stripe verification steps over the fixture secret: header, v1 HMAC, tolerance, event decoding. */
const stripeAdapter: GatewayProviderAdapter = {
  capabilities: GATEWAY_LAUNCH_CAPABILITIES.STRIPE,
  family: 'STRIPE',
  lookup: unused,
  prepareCancel: unused,
  prepareCollect: unused,
  prepareRefund: unused,
  readOrderReference: unused,
  replay: unused,
  send: unused,
  verifyNotification: (target, notification) =>
    Effect.gen(function* verifyFixtureStripeNotification() {
      if (notification.providerAccountRef !== target.binding.providerAccountRef) {
        return yield* rejected('BINDING_UNKNOWN');
      }
      if (notification.environment !== target.binding.environment) {
        return yield* rejected('ENVIRONMENT_MISMATCH');
      }
      if (target.credentialSecretRef !== STRIPE_SECRET_REF) {
        return yield* unavailable('STRIPE', 'credential_unavailable');
      }
      const header = yield* Effect.fromOption(notification.headers.stripeSignature, () => rejected('MALFORMED'));
      const verifiedAt = yield* DateTime.now;
      yield* verifyStripeSignature({
        header,
        rawBody: notification.rawBody,
        secret: Redacted.make(WEBHOOK_SECRET),
        toleranceSeconds: STRIPE_TOLERANCE_SECONDS,
        verifiedAt,
      });
      const trigger = yield* decodeStripeEvent({
        environment: notification.environment,
        rawBody: notification.rawBody,
        verifiedAt,
      });
      return { ...trigger, retainedBody: stripeRetainedBodyOf(trigger, notification.rawBody) };
    }),
};

const AdaptersLive = Layer.succeed(GatewayProviderAdapters, {
  forFamily: (family) =>
    family === 'STRIPE' ? Effect.succeed(stripeAdapter) : Effect.fail(unavailable(family, 'adapter_not_installed')),
});

/** The real Core Action runtime under the installed Composition revision. */
const makeActions = Effect.fn('PspCaptureNative.makeActions')(function* makeActions(database: EvidenceNativeDatabase) {
  return makeActionRuntime(
    { executor: database.database },
    makeActionRepository(yield* Crypto.Crypto),
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
});
type CaptureActions = Effect.Success<ReturnType<typeof makeActions>>;

const nativeDatabase = Effect.gen(function* nativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  return {
    coreAdmin: yield* makeTestDatabaseFromClient(admin, coreRelations),
    database: yield* makeTestDatabaseFromClient(runtime, coreRelations),
    runtimeClient: runtime,
  } satisfies EvidenceNativeDatabase;
});

/** A SANDBOX Provider Account Binding of the scope for `merchantIdentity`, through the binding owner persistence. */
const createBinding = Effect.fn('PspCaptureNative.createBinding')(function* createBinding(
  database: EvidenceNativeDatabase,
  scope: PaymentTestScope,
  merchantIdentityDocument: Schema.Json,
  secretRef: string,
) {
  const provenance = yield* provenanceFor(scope);
  const merchantIdentity = yield* Schema.decodeUnknownEffect(GatewayMerchantIdentitySchema)(merchantIdentityDocument);
  const created = yield* database.database.transaction((transaction) =>
    installOperationalScope(transaction, operationalScopeOf(scope), defineDatabaseIdentityEnrollment([])).pipe(
      Effect.flatMap((scoped) =>
        pspBindingPersistenceForTransaction(scoped).createBinding({
          environment: 'SANDBOX',
          merchantIdentity,
          provenance,
          reason: 'Configure the sandbox gateway account',
          replaces: Option.none(),
          route: testNotificationRouteOf(scope.tenantId, merchantIdentity._tag),
          secretRef,
        }),
      ),
    ),
  );
  return created.binding.view;
});

/** A Stripe SANDBOX Provider Account Binding of the scope, created through the binding owner persistence. */
const createStripeBinding = (database: EvidenceNativeDatabase, scope: PaymentTestScope) =>
  createBinding(database, scope, { _tag: 'STRIPE', accountId: 'acct_1C17CaptureFixture' }, STRIPE_SECRET_REF);

const encodeBase64 = Schema.encodeSync(Schema.Uint8ArrayFromBase64);
const bodyOf = (event: StripeEvent) => utf8ToBytes(JSON.stringify(event));

/** A `t=<receipt second>,v1=<hmac>` header over the exact body, as Stripe signs it. */
const signatureOf = (body: Uint8Array, secret: string) => {
  const prefix = utf8ToBytes(`${RECEIVED_AT_SECONDS}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix, 0);
  message.set(body, prefix.length);
  return `t=${RECEIVED_AT_SECONDS},v1=${bytesToHex(hmac(sha256, utf8ToBytes(secret), message))}`;
};

/** Scope fields a malicious relay body might try to carry; they are not part of the contract. */
interface SmuggledScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

interface DeliveryInput {
  /** The verifying adapters; the fixture Stripe adapter unless given (the production set for Comgate). */
  readonly adapters?: GatewayProviderAdaptersContract;
  readonly body: Uint8Array;
  readonly environment?: 'LIVE' | 'SANDBOX';
  readonly family?: GatewayFamily;
  /** The relay headers; when absent, a JSON body with `signature` as its Stripe-Signature header. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
  /** The invoking context; the relay principal with the signed route of `routeBindingId` unless given. */
  readonly principal?: TrustedPrincipalContext;
  readonly providerAccountRef: GatewayProviderAccountRef;
  /** The binding whose route Shell signed for this delivery. */
  readonly routeBindingId: string;
  readonly signature: string;
  readonly smuggled?: SmuggledScope;
}

/** One relay invocation, received at the virtual instant `RECEIVED_AT_SECONDS`. */
const deliver = Effect.fn('PspCaptureNative.deliver')(function* deliver(
  actions: CaptureActions,
  scope: PaymentTestScope,
  input: DeliveryInput,
) {
  // The relay's JSON body, exactly as the HTTP runner hands its encoded form to the Core runtime.
  const payload = {
    ...input.smuggled,
    environment: input.environment ?? 'SANDBOX',
    family: input.family ?? 'STRIPE',
    headers: input.headers ?? { contentType: 'application/json; charset=utf-8', stripeSignature: input.signature },
    providerAccountRef: input.providerAccountRef,
    query: {},
    rawBody: encodeBase64(input.body),
    transportDeliveryRef: `relay-${input.idempotencyKey}`,
  };
  return yield* Effect.gen(function* receiveAtFixedInstant() {
    yield* TestClock.setTime(RECEIVED_AT_SECONDS * 1000);
    return yield* actions.runAction({
      payload,
      principal:
        input.principal ??
        routeScopedPrincipalOf(scope, {
          bindingId: input.routeBindingId,
          compositionRevision: COMPOSITION_R1,
          operation: CAPTURE_ROUTE_OPERATION,
        }),
      registration: captureProviderNotificationAction,
      transport: { correlationId: 'payment-psp-capture', idempotencyKey: input.idempotencyKey },
    });
  }).pipe(
    Effect.provide(
      Layer.merge(
        input.adapters === undefined ? AdaptersLive : Layer.succeed(GatewayProviderAdapters, input.adapters),
        TestClock.layer(),
      ),
    ),
  );
});

/** The result as `[tag, notificationId | rejection reason]`. */
const summaryOf = (result: Effect.Success<ReturnType<typeof deliver>>) =>
  Match.valueTags(Schema.decodeUnknownSync(CaptureProviderNotificationResultSchema)(result), {
    CAPTURED: ({ notificationId }) => ['CAPTURED', notificationId],
    DUPLICATE: ({ notificationId }) => ['DUPLICATE', notificationId],
    IGNORED: ({ notificationId }) => ['IGNORED', notificationId],
    REJECTED: ({ reason }) => ['REJECTED', reason],
  });
const notificationIdOf = (result: Effect.Success<ReturnType<typeof deliver>>) => summaryOf(result)[1];

const notificationRows = (database: EvidenceNativeDatabase, tenantId: string) =>
  database.coreAdmin.select().from(pspProviderNotifications).where(eq(pspProviderNotifications.tenantId, tenantId));

const onlyRow = <Row>(rows: readonly Row[]) =>
  rows.length === 1 && rows[0] !== undefined
    ? Effect.succeed(rows[0])
    : Effect.die(`expected one row, got ${rows.length}`);

const capturedMessages = (database: EvidenceNativeDatabase, tenantId: string) =>
  database.coreAdmin
    .select({
      completionConsumerModuleKey: outboxMessages.completionConsumerModuleKey,
      completionOriginalRevision: outboxMessages.completionOriginalRevision,
      payloadJson: outboxMessages.payloadJson,
    })
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.tenantId, tenantId),
        eq(outboxMessages.topic, 'payment.core.provider-notification-captured.v1'),
      ),
    );

const succeededEvent = (eventId: string) =>
  stripeEventEnvelope({
    id: eventId,
    object: stripePaymentIntentObject({ orderReference: 'a'.repeat(32), status: 'succeeded' }),
    type: 'payment_intent.succeeded',
  });

/** The stored notification as the processing worker reads it through its scoped routine. */
const readAsWorker = (database: EvidenceNativeDatabase, scope: PaymentTestScope, notificationId: string) =>
  database.database
    .transaction((transaction) =>
      Effect.gen(function* readNotificationAsWorker() {
        const scoped = yield* installOperationalScope(
          transaction,
          operationalScopeOf(scope),
          defineDatabaseIdentityEnrollment([]),
        );
        const store = yield* ProviderNotificationStore;
        return yield* store.read({
          notificationId: yield* Schema.decodeUnknownEffect(ProviderNotificationIdSchema)(notificationId),
          scope: {
            completionPublisher: { publish: () => Effect.die('unused completion publisher') },
            legalEntityId: scope.legalEntityId,
            routineInvoker: scoped,
            tenantId: scope.tenantId,
          },
        });
      }),
    )
    .pipe(Effect.provide(ProviderNotificationStoreLive));

/** Seeds one Tenant and Selling Legal Entity with a Stripe binding under an installed authority. */
const scenario = Effect.fn('PspCaptureNative.scenario')(function* scenario() {
  yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
  const database = yield* nativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const binding = yield* createStripeBinding(database, scope);
  const actions = yield* makeActions(database);
  return { actions, binding, database, scope };
});

/** The fixture Comgate shop secret of the binding's credential reference; an obvious fake, no real account. */
const COMGATE_SECRET_REF = 'comgate-sandbox-1';
const COMGATE_FAKE_SECRET = 'FAKE-comgate-shop-secret-c17-never-stored';
const COMGATE_MERCHANT_ID = '123456';
const COMGATE_TRANS_ID = 'AB12-CD34-EF56';

/** A Comgate push of the binding's merchant as Comgate sends it: the shop secret travels in the body. */
const comgatePushFields = (secret: string, status: string) => ({
  curr: 'CZK',
  merchant: COMGATE_MERCHANT_ID,
  price: '10000',
  refId: 'c17-capture-order',
  secret,
  status,
  test: 'true',
  transId: COMGATE_TRANS_ID,
});
const comgateJsonPush = (secret: string, status: string) =>
  utf8ToBytes(JSON.stringify(comgatePushFields(secret, status)));
const comgateFormPush = (secret: string, status: string) =>
  utf8ToBytes(new URLSearchParams(comgatePushFields(secret, status)).toString());

/**
 * The production adapter set, verifying with the fake Comgate secret from the credential deployment value. No
 * provider route is scripted: verifying a push never calls Comgate.
 */
const comgateAdapters = recordedGatewayAdapters({}).pipe(
  Effect.map(({ adapters }) => adapters),
  Effect.provide(credentialConfig({ [COMGATE_SECRET_REF]: { family: 'COMGATE', secret: COMGATE_FAKE_SECRET } })),
);

/**
 * Everything this Tenant's captures wrote, as text: notification rows (the body decoded as UTF-8 and as hex), the
 * domain events and Outbox messages, the Action invocations and the audit and data-access evidence.
 */
const storedTextOf = Effect.fn('PspCaptureNative.storedTextOf')(function* storedTextOf(
  database: EvidenceNativeDatabase,
  tenantId: string,
) {
  const admin = database.coreAdmin;
  const notifications = yield* notificationRows(database, tenantId);
  const tables = yield* Effect.all(
    [
      // Every text and JSON column of the domain events (their bigint sequence number carries no text).
      admin
        .select({
          eventType: domainEvents.eventType,
          payloadJson: domainEvents.payloadJson,
          subjectResourceId: domainEvents.subjectResourceId,
        })
        .from(domainEvents)
        .where(eq(domainEvents.tenantId, tenantId)),
      admin.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
      admin.select().from(actionInvocations).where(eq(actionInvocations.tenantId, tenantId)),
      admin.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
      admin.select().from(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId)),
    ],
    { concurrency: 1 },
  );
  const rows = notifications.map((row) => ({
    ...row,
    rawBody: new TextDecoder().decode(row.rawBody),
    rawBodyHex: bytesToHex(new Uint8Array(row.rawBody)),
  }));
  return JSON.stringify([rows, tables]);
});

describe('#1157 capture-provider-notification through the Core Action runtime', () => {
  it.live('#1157 Authentic notification is durably captured before ACK', () =>
    native(
      Effect.gen(function* authenticCaptured() {
        const { actions, binding, database, scope } = yield* scenario();
        const body = bodyOf(succeededEvent('evt_c17_capture_authentic'));
        const signature = signatureOf(body, WEBHOOK_SECRET);
        const result = yield* deliver(actions, scope, {
          body,
          idempotencyKey: 'capture-authentic',
          providerAccountRef: binding.providerAccountRef,
          routeBindingId: binding.bindingId,
          signature,
        });
        const row = yield* onlyRow(yield* notificationRows(database, scope.tenantId));
        expect(summaryOf(result)).toEqual(['CAPTURED', row.notificationId]);

        // The committed row: exact bytes, allow-listed headers, verified trigger facts and the capture provenance.
        expect([row.legalEntityId, row.bindingId, row.providerFamily, row.environment]).toEqual([
          scope.legalEntityId,
          binding.bindingId,
          'STRIPE',
          'SANDBOX',
        ]);
        expect([row.state, row.authenticity, row.deliveryIdentity, row.providerOccurrenceId]).toEqual([
          'CAPTURED',
          'SIGNATURE_VERIFIED',
          'stripe:evt:evt_c17_capture_authentic',
          'stripe:evt:evt_c17_capture_authentic',
        ]);
        expect(new Uint8Array(row.rawBody)).toEqual(body);
        expect([row.headers, row.query]).toEqual([
          { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': signature },
          {},
        ]);
        // receivedAt is OntOS's own clock at receipt; never a field of the relay body.
        expect([row.receivedAt.getTime(), row.verifiedAt.getTime(), row.providerEventAt]).toEqual([
          RECEIVED_AT_SECONDS * 1000,
          RECEIVED_AT_SECONDS * 1000,
          new Date(STRIPE_FIXTURE_EVENT_CREATED * 1000),
        ]);
        expect([row.actorPrincipalId, row.compositionRevision]).toEqual([scope.principalId, COMPOSITION_R1]);

        // One completion-bound processing message for payment.core under the invocation's revision.
        expect(yield* capturedMessages(database, scope.tenantId)).toEqual([
          {
            completionConsumerModuleKey: 'payment.core',
            completionOriginalRevision: COMPOSITION_R1,
            payloadJson: { data: { notificationId: row.notificationId } },
          },
        ]);

        // The processing worker reads the same trigger back through its scoped routine.
        const stored = yield* readAsWorker(database, scope, row.notificationId);
        expect(
          stored.pipe(
            Option.map((notification) => [
              notification.state,
              notification.trigger.actionable,
              notification.trigger.deliveryIdentity,
              Option.isSome(notification.trigger.signedObject),
            ]),
          ),
        ).toEqual(Option.some(['CAPTURED', true, 'stripe:evt:evt_c17_capture_authentic', true]));
      }),
    ),
  );

  it.live('#1157 Duplicate delivery is acknowledged idempotently', () =>
    native(
      Effect.gen(function* duplicateDelivery() {
        const { actions, binding, database, scope } = yield* scenario();
        const body = bodyOf(succeededEvent('evt_c17_capture_duplicate'));
        const delivery = {
          body,
          providerAccountRef: binding.providerAccountRef,
          routeBindingId: binding.bindingId,
          signature: signatureOf(body, WEBHOOK_SECRET),
        };
        const first = yield* deliver(actions, scope, { ...delivery, idempotencyKey: 'capture-first' });
        // The provider redelivers the same event through a new relay delivery.
        const again = yield* deliver(actions, scope, { ...delivery, idempotencyKey: 'capture-redelivered' });
        expect(summaryOf(first)[0]).toBe('CAPTURED');
        expect(summaryOf(again)).toEqual(['DUPLICATE', notificationIdOf(first)]);
        expect(yield* notificationRows(database, scope.tenantId)).toHaveLength(1);
        expect(yield* capturedMessages(database, scope.tenantId)).toHaveLength(1);

        // An authentic but unmapped event is stored IGNORED with no processing message; its repeat is DUPLICATE.
        const balance = bodyOf(
          stripeEventEnvelope({
            id: 'evt_c17_capture_balance',
            object: stripeBalanceObject,
            type: 'balance.available',
          }),
        );
        const unmapped = {
          body: balance,
          providerAccountRef: binding.providerAccountRef,
          routeBindingId: binding.bindingId,
          signature: signatureOf(balance, WEBHOOK_SECRET),
        };
        const ignored = yield* deliver(actions, scope, { ...unmapped, idempotencyKey: 'capture-ignored' });
        const ignoredAgain = yield* deliver(actions, scope, { ...unmapped, idempotencyKey: 'capture-ignored-again' });
        expect(summaryOf(ignored)[0]).toBe('IGNORED');
        expect(summaryOf(ignoredAgain)).toEqual(['DUPLICATE', notificationIdOf(ignored)]);
        // The actionable event keeps its exact signed body for the worker; the IGNORED one keeps none.
        const stored = (yield* notificationRows(database, scope.tenantId)).map((row) => [
          row.state,
          row.rawBody.length,
        ]);
        expect(new Set(stored.map((entry) => entry.join(':')))).toEqual(
          new Set([`CAPTURED:${body.length}`, 'IGNORED:0']),
        );
        expect(yield* capturedMessages(database, scope.tenantId)).toHaveLength(1);
      }),
    ),
  );

  it.live('#1157 Forged Stripe signature cannot mutate', () =>
    native(
      Effect.gen(function* forgedSignature() {
        const { actions, binding, database, scope } = yield* scenario();
        const body = bodyOf(succeededEvent('evt_c17_capture_forged'));
        const { bindingId: routeBindingId, providerAccountRef } = binding;
        // Signed with a secret that is not the binding's webhook secret.
        const forged = yield* deliver(actions, scope, {
          body,
          idempotencyKey: 'capture-forged',
          providerAccountRef,
          routeBindingId,
          signature: signatureOf(body, 'whsec_attacker_controlled_secret'),
        });
        // A genuine signature over other bytes does not cover a tampered body.
        const tampered = yield* deliver(actions, scope, {
          body,
          idempotencyKey: 'capture-tampered',
          providerAccountRef,
          routeBindingId,
          signature: signatureOf(bodyOf(succeededEvent('evt_c17_capture_other')), WEBHOOK_SECRET),
        });
        const malformed = yield* deliver(actions, scope, {
          body,
          idempotencyKey: 'capture-malformed',
          providerAccountRef,
          routeBindingId,
          signature: 'v1=not-a-signature',
        });
        expect([forged, tampered, malformed].map(summaryOf)).toEqual([
          ['REJECTED', 'SIGNATURE_INVALID'],
          ['REJECTED', 'SIGNATURE_INVALID'],
          ['REJECTED', 'MALFORMED'],
        ]);
        expect(yield* notificationRows(database, scope.tenantId)).toHaveLength(0);
        expect(yield* capturedMessages(database, scope.tenantId)).toHaveLength(0);
      }),
    ),
  );

  it.live('#1157 Tenant cannot be selected from webhook fields', () =>
    native(
      Effect.gen(function* tenantFromScopeOnly() {
        const { actions, binding, database, scope } = yield* scenario();
        // Another Tenant's relay invocation names the first Tenant's binding.
        const other = yield* makeTestScope;
        yield* seedCoreScope(database, other);
        const body = bodyOf(succeededEvent('evt_c17_capture_foreign'));
        const delivery = {
          body,
          providerAccountRef: binding.providerAccountRef,
          routeBindingId: binding.bindingId,
          signature: signatureOf(body, WEBHOOK_SECRET),
        };
        // Scope fields in the relay body are not part of the contract: the request is refused before any read.
        const smuggled = yield* deliver(actions, other, {
          ...delivery,
          idempotencyKey: 'capture-smuggled',
          smuggled: { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId },
        }).pipe(Effect.flip);
        expect(Predicate.isTagged(smuggled, 'ActionPayloadValidationError')).toBe(true);
        // Without them, the first Tenant's binding ref is simply unknown in the other Tenant's scope.
        const foreign = yield* deliver(actions, other, { ...delivery, idempotencyKey: 'capture-foreign' });
        // The route family must match the binding too: a GoPay route never reaches the Stripe binding.
        const wrongFamily = yield* deliver(actions, scope, {
          ...delivery,
          family: 'GOPAY',
          idempotencyKey: 'capture-wrong-family',
        });
        expect([foreign, wrongFamily].map(summaryOf)).toEqual([
          ['REJECTED', 'BINDING_UNKNOWN'],
          ['REJECTED', 'BINDING_UNKNOWN'],
        ]);
        expect(yield* notificationRows(database, scope.tenantId)).toHaveLength(0);
        expect(yield* notificationRows(database, other.tenantId)).toHaveLength(0);

        // The same delivery under the binding's own scope is stored there, and only there.
        const own = yield* deliver(actions, scope, { ...delivery, idempotencyKey: 'capture-own' });
        expect(summaryOf(own)[0]).toBe('CAPTURED');
        const rows = yield* notificationRows(database, scope.tenantId);
        expect(rows.map((row) => [row.tenantId, row.legalEntityId])).toEqual([[scope.tenantId, scope.legalEntityId]]);
        expect(yield* notificationRows(database, other.tenantId)).toHaveLength(0);
      }),
    ),
  );
  it.live('#1155 #1157 A Comgate push is captured without its shop secret', () =>
    native(
      Effect.gen(function* comgateSecretNeverStored() {
        yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
        const database = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        yield* seedCoreScope(database, scope);
        const binding = yield* createBinding(
          database,
          scope,
          { _tag: 'COMGATE', merchantId: COMGATE_MERCHANT_ID },
          COMGATE_SECRET_REF,
        );
        const actions = yield* makeActions(database);
        const adapters = yield* comgateAdapters;
        // A Comgate push has no signature header; only its content type reaches the capture.
        const comgate = {
          adapters,
          family: 'COMGATE',
          providerAccountRef: binding.providerAccountRef,
          routeBindingId: binding.bindingId,
          signature: 'not-sent-by-comgate',
        } as const;
        const credentials = credentialConfig({
          [COMGATE_SECRET_REF]: { family: 'COMGATE', secret: COMGATE_FAKE_SECRET },
        });
        const deliverComgate = (input: Omit<DeliveryInput, keyof typeof comgate>) =>
          deliver(actions, scope, { ...comgate, ...input }).pipe(Effect.provide(credentials));

        // Authentic pushes (REST v2 JSON and v1 form) carry the shop secret in their bodies.
        const paid = yield* deliverComgate({
          body: comgateJsonPush(COMGATE_FAKE_SECRET, 'PAID'),
          headers: { contentType: 'application/json' },
          idempotencyKey: 'comgate-paid',
        });
        const cancelled = yield* deliverComgate({
          body: comgateFormPush(COMGATE_FAKE_SECRET, 'CANCELLED'),
          headers: { contentType: 'application/x-www-form-urlencoded; charset=UTF-8' },
          idempotencyKey: 'comgate-cancelled',
        });
        // The same source occurrence redelivered is still recognised without its body.
        const redelivered = yield* deliverComgate({
          body: comgateJsonPush(COMGATE_FAKE_SECRET, 'PAID'),
          headers: { contentType: 'application/json' },
          idempotencyKey: 'comgate-paid-again',
        });
        // Not authentic: a wrong secret, and the right secret for another merchant. Nothing of either is stored.
        const wrongSecret = yield* deliverComgate({
          body: comgateJsonPush(`${COMGATE_FAKE_SECRET}-guess`, 'PAID'),
          headers: { contentType: 'application/json' },
          idempotencyKey: 'comgate-wrong-secret',
        });
        const otherMerchant = yield* deliverComgate({
          body: utf8ToBytes(JSON.stringify({ ...comgatePushFields(COMGATE_FAKE_SECRET, 'PAID'), merchant: '654321' })),
          headers: { contentType: 'application/json' },
          idempotencyKey: 'comgate-other-merchant',
        });
        expect([paid, cancelled].map((result) => summaryOf(result)[0])).toEqual(['CAPTURED', 'CAPTURED']);
        expect([redelivered, wrongSecret, otherMerchant].map(summaryOf)).toEqual([
          ['DUPLICATE', notificationIdOf(paid)],
          ['REJECTED', 'SECRET_MISMATCH'],
          ['REJECTED', 'MERCHANT_MISMATCH'],
        ]);

        // The shop secret appears nowhere this Tenant's captures wrote, in any column or payload.
        const rows = yield* notificationRows(database, scope.tenantId);
        expect(
          new Set(rows.map((row) => [row.deliveryIdentity, row.authenticity, row.rawBody.length].join(' '))),
        ).toEqual(
          new Set([
            `comgate:${COMGATE_TRANS_ID}:CANCELLED SHARED_SECRET_VERIFIED 0`,
            `comgate:${COMGATE_TRANS_ID}:PAID SHARED_SECRET_VERIFIED 0`,
          ]),
        );
        const stored = yield* storedTextOf(database, scope.tenantId);
        expect(stored).toContain(`comgate:${COMGATE_TRANS_ID}:PAID`);
        expect(stored).not.toContain(COMGATE_FAKE_SECRET);
        expect(stored).not.toContain(bytesToHex(utf8ToBytes(COMGATE_FAKE_SECRET)));
        expect(yield* capturedMessages(database, scope.tenantId)).toHaveLength(2);

        // The worker still has everything it needs: the transaction to look up through the binding, and the
        // pushed status to compare with that lookup.
        const read = yield* readAsWorker(database, scope, notificationIdOf(paid));
        expect(
          read.pipe(
            Option.map((notification) => [
              notification.bindingId,
              notification.trigger.providerRefs,
              notification.trigger.claimedStatus,
              notification.trigger.signedObject,
            ]),
          ),
        ).toEqual(
          Option.some([
            binding.bindingId,
            [{ _tag: 'COMGATE_TRANSACTION', transId: COMGATE_TRANS_ID }],
            Option.some('PAID'),
            Option.none(),
          ]),
        );
      }),
    ),
  );

  it.live('#1157 #1153 capture rechecks the signed binding route before anything is stored', () =>
    native(
      Effect.gen(function* routeRecheck() {
        const { actions, binding, database, scope } = yield* scenario();
        const body = bodyOf(succeededEvent('evt_c17_capture_route'));
        const delivery = {
          body,
          providerAccountRef: binding.providerAccountRef,
          routeBindingId: binding.bindingId,
          signature: signatureOf(body, WEBHOOK_SECRET),
        };
        // A relay invocation without a verified route scope is refused before any read or write.
        const unrouted = yield* deliver(actions, scope, {
          ...delivery,
          idempotencyKey: 'capture-unrouted',
          principal: principalOf(scope),
        }).pipe(Effect.flip);
        expect(Predicate.isTagged(unrouted, 'PaymentUnavailable')).toBe(true);

        // Another merchant's binding in the same Selling Legal Entity: its signed route never reaches this binding.
        const other = yield* createBinding(
          database,
          scope,
          { _tag: 'COMGATE', merchantId: COMGATE_MERCHANT_ID },
          COMGATE_SECRET_REF,
        );
        const crossed = yield* deliver(actions, scope, {
          ...delivery,
          idempotencyKey: 'capture-crossed',
          routeBindingId: other.bindingId,
        });
        // The binding's own route at a revision it never had.
        const stale = yield* deliver(actions, scope, {
          ...delivery,
          idempotencyKey: 'capture-stale-route',
          principal: routeScopedPrincipalOf(scope, {
            bindingId: binding.bindingId,
            compositionRevision: COMPOSITION_R1,
            operation: CAPTURE_ROUTE_OPERATION,
            routeRevision: 2,
          }),
        });
        // A payload naming another environment than the routed binding's.
        const crossEnvironment = yield* deliver(actions, scope, {
          ...delivery,
          environment: 'LIVE',
          idempotencyKey: 'capture-cross-environment',
        });
        expect([crossed, stale, crossEnvironment].map(summaryOf)).toEqual([
          ['REJECTED', 'BINDING_UNKNOWN'],
          ['REJECTED', 'BINDING_UNKNOWN'],
          ['REJECTED', 'BINDING_UNKNOWN'],
        ]);
        expect(yield* notificationRows(database, scope.tenantId)).toHaveLength(0);
        expect(yield* capturedMessages(database, scope.tenantId)).toHaveLength(0);

        // The verified notification is still captured under its own route.
        const own = yield* deliver(actions, scope, { ...delivery, idempotencyKey: 'capture-routed' });
        expect(summaryOf(own)[0]).toBe('CAPTURED');
      }),
    ),
  );
});
