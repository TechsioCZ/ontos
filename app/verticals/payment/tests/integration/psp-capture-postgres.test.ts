import { NodeCrypto } from '@effect/platform-node';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { and, eq } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Layer, Match, Option, Predicate, Redacted, Schema } from 'effect';
import type { Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations, outboxMessages } from '../../../../packages/core-runtime/src/db/schema.ts';
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
import type { GatewayProviderAdapter } from '../../src/integrations/psp/psp-adapter.ts';
import { GatewayNotificationRejected, GatewayProviderUnavailable } from '../../src/integrations/psp/psp-errors.ts';
import { decodeStripeEvent } from '../../src/integrations/stripe/stripe-event.ts';
import { verifyStripeSignature } from '../../src/integrations/stripe/stripe-webhook-signature.ts';
import { pspBindingPersistenceForTransaction } from '../../src/persistence/psp-binding-persistence.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import {
  stripeBalanceObject,
  stripeEventEnvelope,
  STRIPE_FIXTURE_EVENT_CREATED,
} from '../fixtures/stripe/stripe-events.ts';
import { stripePaymentIntentObject } from '../fixtures/stripe/stripe-objects.ts';
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
      return yield* decodeStripeEvent({
        environment: notification.environment,
        rawBody: notification.rawBody,
        verifiedAt,
      });
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

/** A Stripe SANDBOX Provider Account Binding of the scope, created through the binding owner persistence. */
const createStripeBinding = Effect.fn('PspCaptureNative.createStripeBinding')(function* createStripeBinding(
  database: EvidenceNativeDatabase,
  scope: PaymentTestScope,
) {
  const provenance = yield* provenanceFor(scope);
  const merchantIdentity = yield* Schema.decodeUnknownEffect(GatewayMerchantIdentitySchema)({
    _tag: 'STRIPE',
    accountId: 'acct_1C17CaptureFixture',
  });
  const created = yield* database.database.transaction((transaction) =>
    installOperationalScope(transaction, operationalScopeOf(scope)).pipe(
      Effect.flatMap((scoped) =>
        pspBindingPersistenceForTransaction(scoped).createBinding({
          environment: 'SANDBOX',
          merchantIdentity,
          notificationUrl: 'https://hooks.example.test/psp/stripe',
          provenance,
          reason: 'Configure the sandbox Stripe account',
          replaces: Option.none(),
          secretRef: STRIPE_SECRET_REF,
        }),
      ),
    ),
  );
  return created.binding.view;
});

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
  readonly body: Uint8Array;
  readonly family?: GatewayFamily;
  readonly idempotencyKey: string;
  readonly providerAccountRef: GatewayProviderAccountRef;
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
    environment: 'SANDBOX',
    family: input.family ?? 'STRIPE',
    headers: { contentType: 'application/json; charset=utf-8', stripeSignature: input.signature },
    providerAccountRef: input.providerAccountRef,
    query: {},
    rawBody: encodeBase64(input.body),
    transportDeliveryRef: `relay-${input.idempotencyKey}`,
  };
  return yield* Effect.gen(function* receiveAtFixedInstant() {
    yield* TestClock.setTime(RECEIVED_AT_SECONDS * 1000);
    return yield* actions.runAction({
      payload,
      principal: principalOf(scope),
      registration: captureProviderNotificationAction,
      transport: { correlationId: 'payment-psp-capture', idempotencyKey: input.idempotencyKey },
    });
  }).pipe(Effect.provide(Layer.merge(AdaptersLive, TestClock.layer())));
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
        const scoped = yield* installOperationalScope(transaction, operationalScopeOf(scope));
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
          signature: signatureOf(balance, WEBHOOK_SECRET),
        };
        const ignored = yield* deliver(actions, scope, { ...unmapped, idempotencyKey: 'capture-ignored' });
        const ignoredAgain = yield* deliver(actions, scope, { ...unmapped, idempotencyKey: 'capture-ignored-again' });
        expect(summaryOf(ignored)[0]).toBe('IGNORED');
        expect(summaryOf(ignoredAgain)).toEqual(['DUPLICATE', notificationIdOf(ignored)]);
        const states = (yield* notificationRows(database, scope.tenantId)).map((row) => row.state);
        expect(new Set(states)).toEqual(new Set(['CAPTURED', 'IGNORED']));
        expect(yield* capturedMessages(database, scope.tenantId)).toHaveLength(1);
      }),
    ),
  );

  it.live('#1157 Forged Stripe signature cannot mutate', () =>
    native(
      Effect.gen(function* forgedSignature() {
        const { actions, binding, database, scope } = yield* scenario();
        const body = bodyOf(succeededEvent('evt_c17_capture_forged'));
        const { providerAccountRef } = binding;
        // Signed with a secret that is not the binding's webhook secret.
        const forged = yield* deliver(actions, scope, {
          body,
          idempotencyKey: 'capture-forged',
          providerAccountRef,
          signature: signatureOf(body, 'whsec_attacker_controlled_secret'),
        });
        // A genuine signature over other bytes does not cover a tampered body.
        const tampered = yield* deliver(actions, scope, {
          body,
          idempotencyKey: 'capture-tampered',
          providerAccountRef,
          signature: signatureOf(bodyOf(succeededEvent('evt_c17_capture_other')), WEBHOOK_SECRET),
        });
        const malformed = yield* deliver(actions, scope, {
          body,
          idempotencyKey: 'capture-malformed',
          providerAccountRef,
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
});
