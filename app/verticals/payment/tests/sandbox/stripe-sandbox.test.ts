import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { DateTime, Effect, Option, Redacted, Schema } from 'effect';
import type { Scope } from 'effect';
import { HttpClientRequest } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';
import type { TestContext } from 'effect-rstest';

import type { ProviderHttpContract } from '../../src/integrations/psp/provider-http.ts';
import { ProviderObjectIdSchema } from '../../src/integrations/psp/psp-request.ts';
import type { ProviderObjectRef } from '../../src/integrations/psp/psp-request.ts';
import {
  HOSTED_PAYMENT_WAIT,
  HOSTED_POLL,
  HOSTED_SCENARIO_TIMEOUT_MS,
  SANDBOX_NOTIFICATION_URL,
  SANDBOX_RETURN_URL,
  SETTLE_POLL,
  StripeCheckoutSessionRefSchema,
  StripeRefundRefSchema,
  announceHostedPage,
  cancelExpected,
  cancelRequestOf,
  collectExpected,
  collectRequestOf,
  dispatchOutcomeOf,
  findingKindFor,
  newOperation,
  newReturnToken,
  objectLookup,
  orderReferenceLookup,
  pollUntil,
  providerRefOf,
  rawNotification,
  refundExpected,
  refundRequestOf,
  sandboxNow,
  sandboxScenario,
  sandboxTarget,
  stripeSandboxCredentials,
  withheldObjectId,
} from './sandbox-harness.ts';
import type { SandboxOperation, SandboxScenarioInput, StripeSandboxCredentials } from './sandbox-harness.ts';

/**
 * #1159 level 4: Stripe test mode through the production `StripePaymentService` (plan §6 Stripe).
 * Needs `ONTOS_C17_SANDBOX_STRIPE_SECRET_KEY` (`sk_test_`/`rk_test_` with write access to Checkout Sessions,
 * PaymentIntents and Refunds), `ONTOS_C17_SANDBOX_STRIPE_WEBHOOK_SECRET` (`whsec_`) and
 * `ONTOS_C17_SANDBOX_STRIPE_ACCOUNT_ID` (`acct_`).
 *
 * The refund scenario confirms its PaymentIntent through the API with the documented test PaymentMethod
 * `pm_card_visa`, so only the hosted Checkout scenario needs a human (test card 4242 4242 4242 4242).
 *
 * Account route only (plan D-P6), for the three variables above:
 * 1. Create or use a Stripe account and open its sandbox in the Dashboard.
 * 2. API keys (sandbox): copy the `sk_test_` secret key, or a restricted `rk_test_` key with the scopes above.
 * 3. `ONTOS_C17_SANDBOX_STRIPE_ACCOUNT_ID`: the `acct_` value from Settings → Account, or `GET /v1/account` with the key.
 * 4. `ONTOS_C17_SANDBOX_STRIPE_WEBHOOK_SECRET`: `stripe listen --print-secret` on an authenticated Stripe CLI (`stripe login`).
 * Do not use the anonymous `stripe sandbox create` keys (`rkcs_test_`): the adapter accepts only `sk_test_` and `rk_test_`.
 */

const COLLECT_AMOUNT = { amountMinor: 10_000, currency: 'CZK' } as const;
const REFUND_AMOUNT = { amountMinor: 4000, currency: 'CZK' } as const;
const STRIPE_API = 'https://api.stripe.com';

const setup = {
  credentials: stripeSandboxCredentials,
  material: (credentials: StripeSandboxCredentials) =>
    ({
      _tag: 'STRIPE',
      secretKey: credentials.secretKey,
      webhookSigningSecret: credentials.webhookSecret,
    }) as const,
  target: (credentials: StripeSandboxCredentials) =>
    sandboxTarget({
      merchantIdentity: { _tag: 'STRIPE', accountId: credentials.accountId },
      notificationUrl: SANDBOX_NOTIFICATION_URL,
      returnUrl: Option.some(SANDBOX_RETURN_URL),
    }),
};

type StripeScenario = SandboxScenarioInput<StripeSandboxCredentials>;

const stripe = <A, E>(ctx: TestContext, scenario: (input: StripeScenario) => Effect.Effect<A, E, Scope.Scope>) =>
  sandboxScenario(ctx, setup, scenario);

/** Creates one Checkout Session through the adapter. */
const createSession = ({ provider, target }: StripeScenario) =>
  Effect.gen(function* createSessionEffect() {
    const [operation, returnToken, issuedAt] = yield* Effect.all([newOperation, newReturnToken, sandboxNow], {
      concurrency: 1,
    });
    const prepared = yield* provider.adapter.prepareCollect(
      target,
      collectRequestOf({ amount: COLLECT_AMOUNT, issuedAt, operation, payerContact: Option.none(), returnToken }),
    );
    const response = yield* provider.adapter.send(target, prepared, collectExpected(operation, COLLECT_AMOUNT));
    expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
    expect(response.finding.finding).toBe('CUSTOMER_ACTION_REQUIRED');
    const session = Option.getOrThrow(providerRefOf(response.finding, StripeCheckoutSessionRefSchema));
    const { redirectUrl } = Option.getOrThrow(response.finding.customerAction);
    return { issuedAt, operation, redirectUrl, session };
  });

const lookupCollection = (
  { provider, target }: StripeScenario,
  operation: SandboxOperation,
  ref: ProviderObjectRef,
  dispatchedAt: DateTime.Utc,
) => provider.adapter.lookup(target, objectLookup(ref, collectExpected(operation, COLLECT_AMOUNT), dispatchedAt));

// ---------------------------------------------------------------------------------------------------
// Raw Stripe fixture calls (not adapter operations)
// ---------------------------------------------------------------------------------------------------

const StripeObjectSchema = Schema.Struct({ id: Schema.String, status: Schema.String });
const decodeStripeObject = Schema.decodeUnknownOption(Schema.fromJsonString(StripeObjectSchema));

const StripeEventListSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ data: Schema.Struct({ object: Schema.Struct({ id: Schema.String }) }), id: Schema.String }),
  ),
});
const decodeEventList = Schema.decodeUnknownOption(Schema.fromJsonString(StripeEventListSchema));

/** A PaymentIntent confirmed through the API with the documented test PaymentMethod `pm_card_visa`. */
const confirmedTestPaymentIntent = (
  http: ProviderHttpContract,
  credentials: StripeSandboxCredentials,
  operation: SandboxOperation,
) =>
  Effect.gen(function* confirmedTestPaymentIntentEffect() {
    const response = yield* http.mutate({
      family: 'STRIPE',
      operationId: operation.operationId,
      request: HttpClientRequest.post(`${STRIPE_API}/v1/payment_intents`).pipe(
        HttpClientRequest.bearerToken(credentials.secretKey),
        HttpClientRequest.bodyUrlParams({
          amount: String(COLLECT_AMOUNT.amountMinor),
          confirm: 'true',
          currency: 'czk',
          'metadata[ontos_order_reference]': operation.correlation.orderReference,
          payment_method: 'pm_card_visa',
          'payment_method_types[]': 'card',
        }),
      ),
    });
    expect(response.status).toBe(200);
    const intent = Option.getOrThrow(decodeStripeObject(response.bodyText));
    expect(intent.status).toBe('succeeded');
    return {
      _tag: 'STRIPE_PAYMENT_INTENT',
      id: Schema.decodeUnknownSync(ProviderObjectIdSchema)(intent.id),
    } satisfies ProviderObjectRef;
  });

const readStripe = (http: ProviderHttpContract, credentials: StripeSandboxCredentials, path: string) =>
  http.read({
    family: 'STRIPE',
    request: HttpClientRequest.get(`${STRIPE_API}${path}`).pipe(HttpClientRequest.bearerToken(credentials.secretKey)),
  });

/** The id of the `checkout.session.expired` event Stripe emitted for `sessionId`, polled for up to 2 minutes. */
const expiredEventIdOf = (http: ProviderHttpContract, credentials: StripeSandboxCredentials, sessionId: string) =>
  pollUntil(
    Effect.map(readStripe(http, credentials, '/v1/events?type=checkout.session.expired&limit=50'), (response) =>
      decodeEventList(response.bodyText).pipe(
        Option.flatMap((list) => Option.fromUndefinedOr(list.data.find((event) => event.data.object.id === sessionId))),
        Option.map((event) => event.id),
      ),
    ),
    Option.isSome,
    SETTLE_POLL,
  );

/** Stripe's documented `v1` scheme: HMAC-SHA256(secret, `${t}.` || body) in lower-case hex. */
const stripeSignatureOf = (rawBody: Uint8Array, secret: Redacted.Redacted, signedAtSeconds: number): string => {
  const prefix = utf8ToBytes(`${signedAtSeconds}.`);
  const signed = new Uint8Array(prefix.length + rawBody.length);
  signed.set(prefix);
  signed.set(rawBody, prefix.length);
  return `t=${signedAtSeconds},v1=${bytesToHex(hmac(sha256, utf8ToBytes(Redacted.value(secret)), signed))}`;
};

// ---------------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------------

describe('#1159 Stripe sandbox conformance', () => {
  it.live('#1159 Stripe sandbox: create a one-shot Checkout Session and retrieve it', (ctx) =>
    stripe(ctx, (input) =>
      Effect.gen(function* createAndRetrieve() {
        const created = yield* createSession(input);
        const findings = yield* lookupCollection(input, created.operation, created.session, created.issuedAt);

        expect(created.redirectUrl.startsWith('https://')).toBe(true);
        expect(['CUSTOMER_ACTION_REQUIRED', 'ACCEPTED_PENDING', 'INDETERMINATE']).toContain(
          findingKindFor(findings, created.operation.operationId),
        );
      }),
    ),
  );

  it.live(
    '#1159 Stripe sandbox: the hosted Checkout payment is confirmed by lookup',
    (ctx) =>
      stripe(ctx, (input) =>
        Effect.gen(function* hostedPayment() {
          const created = yield* createSession(input);
          yield* announceHostedPage({
            lines: [
              'Stripe hosted payment step (human): open this URL and pay with test card 4242 4242 4242 4242,',
              `any future expiry and any CVC. Polling lookup for up to ${HOSTED_PAYMENT_WAIT}.`,
            ],
            provider: 'STRIPE',
            scenario: 'hosted-payment',
            url: created.redirectUrl,
          });
          const findings = yield* pollUntil(
            lookupCollection(input, created.operation, created.session, created.issuedAt),
            (current) => findingKindFor(current, created.operation.operationId) === 'EFFECT_CONFIRMED',
            HOSTED_POLL,
          );

          expect(findingKindFor(findings, created.operation.operationId)).toBe('EFFECT_CONFIRMED');
        }),
      ),
    HOSTED_SCENARIO_TIMEOUT_MS,
  );

  it.live('#1159 Stripe sandbox: a confirmed PaymentIntent is found by order reference and refunded', (ctx) =>
    stripe(ctx, (input) =>
      Effect.gen(function* refundScenario() {
        const collection = yield* newOperation;
        const dispatchedAt = yield* sandboxNow;
        const intent = yield* confirmedTestPaymentIntent(input.provider.http, input.credentials, collection);
        const byOrderReference = yield* pollUntil(
          input.provider.adapter.lookup(
            input.target,
            orderReferenceLookup(collection, collectExpected(collection, COLLECT_AMOUNT), dispatchedAt),
          ),
          (current) => findingKindFor(current, collection.operationId) === 'EFFECT_CONFIRMED',
          SETTLE_POLL,
        );
        expect(findingKindFor(byOrderReference, collection.operationId)).toBe('EFFECT_CONFIRMED');

        const refund = yield* newOperation;
        const refundedAt = yield* sandboxNow;
        const prepared = yield* input.provider.adapter.prepareRefund(
          input.target,
          refundRequestOf({ amount: REFUND_AMOUNT, collection, providerTarget: intent, refund }),
        );
        const response = yield* input.provider.adapter.send(
          input.target,
          prepared,
          refundExpected(refund, REFUND_AMOUNT),
        );
        expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
        const refundRef = Option.getOrThrow(providerRefOf(response.finding, StripeRefundRefSchema));
        const settled = yield* pollUntil(
          input.provider.adapter.lookup(
            input.target,
            objectLookup(refundRef, refundExpected(refund, REFUND_AMOUNT), refundedAt),
          ),
          (current) => findingKindFor(current, refund.operationId) === 'EFFECT_CONFIRMED',
          SETTLE_POLL,
        );

        expect(findingKindFor(settled, refund.operationId)).toBe('EFFECT_CONFIRMED');
      }),
    ),
  );

  it.live('#1159 Stripe sandbox: cancel expires an open session, and a second cancel is decided by lookup', (ctx) =>
    stripe(ctx, (input) =>
      Effect.gen(function* cancelScenario() {
        const created = yield* createSession(input);
        const cancelOnce = (cancel: SandboxOperation) =>
          Effect.flatMap(
            input.provider.adapter.prepareCancel(
              input.target,
              cancelRequestOf({ cancel, collection: created.operation, providerTarget: created.session }),
            ),
            (prepared) =>
              input.provider.adapter.send(
                input.target,
                prepared,
                cancelExpected(cancel, created.operation, COLLECT_AMOUNT),
              ),
          );
        const [first, second] = yield* Effect.all([newOperation, newOperation], { concurrency: 1 });
        const expired = yield* cancelOnce(first);
        const again = yield* cancelOnce(second);

        expect(dispatchOutcomeOf(expired)).toBe('ACKNOWLEDGED');
        expect(expired.finding.finding).toBe('EFFECT_CONFIRMED');
        expect(dispatchOutcomeOf(again)).toBe('ACKNOWLEDGED');
        expect(again.finding.finding).toBe('EFFECT_CONFIRMED');
      }),
    ),
  );

  it.live('#1159 Stripe sandbox: a real checkout.session.expired event verifies with the webhook secret', (ctx) =>
    stripe(ctx, (input) =>
      Effect.gen(function* webhookScenario() {
        const created = yield* createSession(input);
        const cancel = yield* newOperation;
        const prepared = yield* input.provider.adapter.prepareCancel(
          input.target,
          cancelRequestOf({ cancel, collection: created.operation, providerTarget: created.session }),
        );
        yield* input.provider.adapter.send(
          input.target,
          prepared,
          cancelExpected(cancel, created.operation, COLLECT_AMOUNT),
        );
        const eventId = Option.getOrThrow(
          yield* expiredEventIdOf(input.provider.http, input.credentials, created.session.id),
        );
        const event = yield* readStripe(input.provider.http, input.credentials, `/v1/events/${eventId}`);
        expect(event.status).toBe(200);

        const now = yield* sandboxNow;
        const signedAt = Math.floor(DateTime.toEpochMillis(now) / 1000);
        const rawBody = utf8ToBytes(event.bodyText);
        const notificationOf = (body: Uint8Array, signature: string) =>
          rawNotification({
            contentType: Option.some('application/json'),
            family: 'STRIPE',
            paymentRef: Option.none(),
            rawBody: body,
            receivedAt: now,
            stripeSignature: Option.some(signature),
            transportDeliveryRef: `sandbox-${eventId}`,
          });
        const signature = stripeSignatureOf(rawBody, input.credentials.webhookSecret, signedAt);
        const trigger = yield* input.provider.adapter.verifyNotification(
          input.target,
          notificationOf(rawBody, signature),
        );
        const tampered = yield* Effect.flip(
          input.provider.adapter.verifyNotification(input.target, notificationOf(utf8ToBytes('{}'), signature)),
        );
        const foreignSecret = yield* Effect.flip(
          input.provider.adapter.verifyNotification(
            input.target,
            notificationOf(
              rawBody,
              stripeSignatureOf(rawBody, Redacted.make('whsec_not_the_endpoint_secret'), signedAt),
            ),
          ),
        );

        expect(trigger).toMatchObject({
          actionable: true,
          authenticity: 'SIGNATURE_VERIFIED',
          deliveryIdentity: `stripe:evt:${eventId}`,
          family: 'STRIPE',
        });
        expect(trigger.providerRefs).toContainEqual(created.session);
        expect(tampered).toMatchObject({ reason: 'SIGNATURE_INVALID' });
        expect(foreignSecret).toMatchObject({ reason: 'SIGNATURE_INVALID' });
      }),
    ),
  );

  it.live('#1159 Stripe sandbox: a lost create response is recovered by exact replay inside the window', (ctx) =>
    stripe(ctx, (input) =>
      Effect.gen(function* lostResponse() {
        const [operation, returnToken, preparedAt] = yield* Effect.all([newOperation, newReturnToken, sandboxNow], {
          concurrency: 1,
        });
        const prepared = yield* input.provider.adapter.prepareCollect(
          input.target,
          collectRequestOf({
            amount: COLLECT_AMOUNT,
            issuedAt: preparedAt,
            operation,
            payerContact: Option.none(),
            returnToken,
          }),
        );
        const expected = collectExpected(operation, COLLECT_AMOUNT);
        const lost = yield* Effect.flip(input.provider.lossy.send(input.target, prepared, expected));
        expect(lost).toMatchObject({ code: 'gateway_provider_outcome_unknown' });
        const createdId = Option.getOrThrow(
          yield* withheldObjectId(input.provider.withheld, (body) =>
            Option.map(decodeStripeObject(body), (object) => object.id),
          ),
        );

        const searched = yield* input.provider.adapter.lookup(
          input.target,
          orderReferenceLookup(operation, expected, preparedAt),
        );
        expect(['INDETERMINATE', 'ACCEPTED_PENDING', 'CUSTOMER_ACTION_REQUIRED']).toContain(
          findingKindFor(searched, operation.operationId),
        );

        const replayed = yield* input.provider.adapter.replay(
          input.target,
          {
            prepared,
            window: { expiresAt: DateTime.add(preparedAt, { hours: 24 }), startsAt: preparedAt },
          },
          expected,
        );
        expect(dispatchOutcomeOf(replayed)).toBe('ACKNOWLEDGED');
        expect(Option.getOrThrow(providerRefOf(replayed.finding, StripeCheckoutSessionRefSchema)).id).toBe(createdId);
      }),
    ),
  );
});
