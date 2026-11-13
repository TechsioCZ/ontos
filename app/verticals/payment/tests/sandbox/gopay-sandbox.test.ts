import { DateTime, Effect, Option, Predicate, Schema } from 'effect';
import type { Scope } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import type { TestContext } from 'effect-rstest';

import { GopayPaymentFromJsonSchema } from '../../src/integrations/gopay/gopay-wire.ts';
import { GopayClientIdSchema } from '../../src/integrations/psp/credentials.ts';
import type { ProviderObjectRef } from '../../src/integrations/psp/psp-request.ts';
import type { ProviderFindingResult } from '../../src/integrations/psp/psp-result.ts';
import {
  GopayPaymentRefSchema,
  HOSTED_PAYMENT_WAIT,
  HOSTED_POLL,
  HOSTED_SCENARIO_TIMEOUT_MS,
  SANDBOX_NOTIFICATION_URL,
  SANDBOX_RETURN_URL,
  SETTLE_POLL,
  announce,
  announceHostedPage,
  cancelExpected,
  cancelRequestOf,
  collectExpected,
  collectRequestOf,
  dispatchOutcomeOf,
  findingKindFor,
  gopaySandboxCredentials,
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
  withheldObjectId,
} from './sandbox-harness.ts';
import type { GopaySandboxCredentials, SandboxOperation, SandboxScenarioInput } from './sandbox-harness.ts';

/**
 * #1159 level 4: the GoPay Payments API v4 sandbox (`https://gw.sandbox.gopay.com/gp-gw/api/4.0`, plan D-P1)
 * through the production `GopayPaymentService` and `GopayOAuthToken`. Needs `ONTOS_C17_SANDBOX_GOPAY_CLIENT_ID`,
 * `ONTOS_C17_SANDBOX_GOPAY_CLIENT_SECRET` and `ONTOS_C17_SANDBOX_GOPAY_GOID` of a v4 sandbox eshop; when the
 * optional public `ONTOS_C17_SANDBOX_GOPAY_NOTIFICATION_URL` is set, created payments name it as `notification_url`
 * so GoPay calls it on every state change.
 *
 * This run is the D-P1 merge gate: it proves v4 create, lookup, cancel (`DELETE` 204 then lookup CANCELED) and
 * refund with the merchant's own sandbox credentials, the token scopes `payment:read payment:write`, and the
 * `created_at` format the refund list matching relies on.
 *
 * GoPay has no order-reference lookup and no replay: those scenarios assert the typed Unsupported answers. An early
 * partial refund of a card payment is refused with 409, so the hosted payment must be paid by bank transfer for the
 * refund scenario to pass.
 */

/** Ends in 00, so the sandbox test card 5447 3800 0000 0006 pays it. */
const COLLECT_AMOUNT = { amountMinor: 10_000, currency: 'CZK' } as const;
const REFUND_AMOUNT = { amountMinor: 4000, currency: 'CZK' } as const;
/** `gopay:<id>:` plus 200 characters exceeds the 200-character stored delivery identity (plan §13.2). */
const OVERLONG_DELIVERY_REF = 'r'.repeat(200);
/** v4 create requires `customer.email`; a reserved example domain, never a real payer. */
const SANDBOX_PAYER = Option.some({
  email: Option.some('c17-sandbox-payer@example.test'),
  fullName: Option.none(),
  phone: Option.none(),
});
/** A GoPay v4 refund's own reference (it names its payment, which `Refund-Details` does not). */
const isGopayRefundRef = (ref: ProviderObjectRef): boolean => Predicate.isTagged(ref, 'GOPAY_REFUND');

const setup = {
  credentials: gopaySandboxCredentials,
  material: (credentials: GopaySandboxCredentials) =>
    ({
      _tag: 'GOPAY',
      clientId: Schema.decodeUnknownSync(GopayClientIdSchema)(credentials.clientId),
      clientSecret: credentials.clientSecret,
    }) as const,
  target: (credentials: GopaySandboxCredentials) =>
    sandboxTarget({
      merchantIdentity: { _tag: 'GOPAY', goid: credentials.goid },
      notificationUrl: Option.getOrElse(credentials.notificationUrl, () => SANDBOX_NOTIFICATION_URL),
      returnUrl: Option.some(SANDBOX_RETURN_URL),
    }),
};

type GopayScenario = SandboxScenarioInput<GopaySandboxCredentials>;

const gopay = <A, E>(ctx: TestContext, scenario: (input: GopayScenario) => Effect.Effect<A, E, Scope.Scope>) =>
  sandboxScenario(ctx, setup, scenario);

const createPayment = ({ provider, target }: GopayScenario) =>
  Effect.gen(function* createPaymentEffect() {
    const [operation, returnToken, issuedAt] = yield* Effect.all([newOperation, newReturnToken, sandboxNow], {
      concurrency: 1,
    });
    const prepared = yield* provider.adapter.prepareCollect(
      target,
      collectRequestOf({ amount: COLLECT_AMOUNT, issuedAt, operation, payerContact: SANDBOX_PAYER, returnToken }),
    );
    const response = yield* provider.adapter.send(target, prepared, collectExpected(operation, COLLECT_AMOUNT));
    expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
    expect(response.finding.finding).toBe('CUSTOMER_ACTION_REQUIRED');
    const payment: ProviderObjectRef = Option.getOrThrow(providerRefOf(response.finding, GopayPaymentRefSchema));
    const { redirectUrl } = Option.getOrThrow(response.finding.customerAction);
    return { issuedAt, operation, payment, redirectUrl };
  });

const lookupCollection = (
  { provider, target }: GopayScenario,
  operation: SandboxOperation,
  ref: ProviderObjectRef,
  dispatchedAt: DateTime.Utc,
) => provider.adapter.lookup(target, objectLookup(ref, collectExpected(operation, COLLECT_AMOUNT), dispatchedAt));

const orderReferenceOf = (findings: readonly ProviderFindingResult[], operation: SandboxOperation) =>
  Option.fromUndefinedOr(findings.find((finding) => finding.target.operationId === operation.operationId)).pipe(
    Option.flatMap((finding) => finding.orderReference),
  );

const decodeCreatedPayment = (bodyText: string): Option.Option<ProviderObjectRef> =>
  Option.map(Schema.decodeUnknownOption(GopayPaymentFromJsonSchema)(bodyText), (payment) => ({
    _tag: 'GOPAY_PAYMENT',
    id: payment.id,
  }));

describe('#1159 GoPay sandbox conformance', () => {
  it.live('#1159 GoPay sandbox: create a one-shot payment and retrieve it', (ctx) =>
    gopay(ctx, (input) =>
      Effect.gen(function* createAndRetrieve() {
        const created = yield* createPayment(input);
        const findings = yield* lookupCollection(input, created.operation, created.payment, created.issuedAt);

        expect(created.redirectUrl.startsWith('https://')).toBe(true);
        expect(['CUSTOMER_ACTION_REQUIRED', 'ACCEPTED_PENDING', 'INDETERMINATE']).toContain(
          findingKindFor(findings, created.operation.operationId),
        );
        expect(orderReferenceOf(findings, created.operation)).toEqual(
          Option.some(created.operation.correlation.orderReference),
        );
      }),
    ),
  );

  it.live(
    '#1159 GoPay sandbox: the hosted payment is confirmed by lookup and partially refunded',
    (ctx) =>
      gopay(ctx, (input) =>
        Effect.gen(function* hostedPaymentAndRefund() {
          const created = yield* createPayment(input);
          yield* announceHostedPage({
            lines: [
              'GoPay hosted payment step (human): open this URL and pay by BANK TRANSFER in the sandbox',
              '(partial refunds cannot be tested on card payments).',
              `Polling lookup for up to ${HOSTED_PAYMENT_WAIT}.`,
            ],
            provider: 'GOPAY',
            scenario: 'hosted-payment-and-refund',
            url: created.redirectUrl,
          });
          const paid = yield* pollUntil(
            lookupCollection(input, created.operation, created.payment, created.issuedAt),
            (current) => findingKindFor(current, created.operation.operationId) === 'EFFECT_CONFIRMED',
            HOSTED_POLL,
          );
          expect(findingKindFor(paid, created.operation.operationId)).toBe('EFFECT_CONFIRMED');

          const refund = yield* newOperation;
          const refundedAt = yield* sandboxNow;
          const prepared = yield* input.provider.adapter.prepareRefund(
            input.target,
            refundRequestOf({
              amount: REFUND_AMOUNT,
              collection: created.operation,
              providerTarget: created.payment,
              refund,
            }),
          );
          const response = yield* input.provider.adapter.send(
            input.target,
            prepared,
            refundExpected(refund, REFUND_AMOUNT),
          );
          expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
          expect(['EFFECT_CONFIRMED', 'ACCEPTED_PENDING']).toContain(response.finding.finding);
          // The 201 refund resource names the refund by its own GoPay id; completion is read from that refund.
          const refundRef = Option.getOrThrow(
            Option.fromUndefinedOr(response.finding.providerRefs.find(isGopayRefundRef)),
          );

          const settled = yield* pollUntil(
            input.provider.adapter.lookup(
              input.target,
              objectLookup(refundRef, refundExpected(refund, REFUND_AMOUNT), refundedAt),
            ),
            (current) => findingKindFor(current, refund.operationId) === 'EFFECT_CONFIRMED',
            SETTLE_POLL,
          );
          expect(findingKindFor(settled, refund.operationId)).toBe('EFFECT_CONFIRMED');
          // Without the refund id (a lost response), the payment's refund list finds the same single refund.
          const byList = yield* input.provider.adapter.lookup(
            input.target,
            objectLookup(created.payment, refundExpected(refund, REFUND_AMOUNT), refundedAt),
          );
          expect(findingKindFor(byList, refund.operationId)).toBe('EFFECT_CONFIRMED');
        }),
      ),
    HOSTED_SCENARIO_TIMEOUT_MS,
  );

  it.live('#1159 GoPay sandbox: a created payment is canceled by DELETE and the lookup shows CANCELED', (ctx) =>
    gopay(ctx, (input) =>
      Effect.gen(function* cancelPending() {
        const created = yield* createPayment(input);
        const cancel = yield* newOperation;
        const expected = cancelExpected(cancel, created.operation, COLLECT_AMOUNT);
        const prepared = yield* input.provider.adapter.prepareCancel(
          input.target,
          cancelRequestOf({ cancel, collection: created.operation, providerTarget: created.payment }),
        );
        const response = yield* input.provider.adapter.send(input.target, prepared, expected);

        expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
        expect(response.finding.finding).toBe('EFFECT_CONFIRMED');
        expect(response.finding.evidence.pipe(Option.map(({ factKind }) => factKind))).toEqual(
          Option.some('CANCEL_CONFIRMED'),
        );
        expect(
          response.targetFinding.pipe(
            Option.flatMap(({ evidence }) => evidence),
            Option.map(({ factKind }) => factKind),
          ),
        ).toEqual(Option.some('COLLECTION_NOT_EFFECTED'));
        // An independent lookup through the same binding agrees, and a second cancel is refused (409) by state.
        const findings = yield* lookupCollection(input, created.operation, created.payment, created.issuedAt);
        expect(findingKindFor(findings, created.operation.operationId)).toBe('NOT_EFFECTED');
        const again = yield* input.provider.adapter.send(input.target, prepared, expected);
        expect([dispatchOutcomeOf(again), again.finding.finding]).toEqual(['ACKNOWLEDGED', 'EFFECT_CONFIRMED']);
      }),
    ),
  );

  it.live(
    '#1159 GoPay sandbox: a callback for a real payment is a lookup trigger; an over-long one is MALFORMED',
    (ctx) =>
      gopay(ctx, (input) =>
        Effect.gen(function* notificationScenario() {
          const created = yield* createPayment(input);
          if (Option.isSome(input.credentials.notificationUrl)) {
            yield* announce([`GoPay will also call ${input.credentials.notificationUrl.value} for this payment.`]);
          }
          const receivedAt = yield* sandboxNow;
          const callbackOf = (transportDeliveryRef: string) =>
            rawNotification({
              contentType: Option.none(),
              family: 'GOPAY',
              paymentRef: Option.some(created.payment.id),
              rawBody: new Uint8Array(),
              receivedAt,
              stripeSignature: Option.none(),
              transportDeliveryRef,
            });
          const trigger = yield* input.provider.adapter.verifyNotification(
            input.target,
            callbackOf('sandbox-delivery-1'),
          );
          const overlong = yield* Effect.flip(
            input.provider.adapter.verifyNotification(input.target, callbackOf(OVERLONG_DELIVERY_REF)),
          );
          const findings = yield* lookupCollection(
            input,
            created.operation,
            Option.getOrThrow(Option.fromUndefinedOr(trigger.providerRefs[0])),
            created.issuedAt,
          );

          expect(trigger).toMatchObject({
            actionable: true,
            authenticity: 'LOOKUP_REQUIRED',
            deliveryIdentity: `gopay:${created.payment.id}:sandbox-delivery-1`,
          });
          expect(trigger.providerRefs).toEqual([created.payment]);
          expect(overlong).toMatchObject({ reason: 'MALFORMED' });
          expect(orderReferenceOf(findings, created.operation)).toEqual(
            Option.some(created.operation.correlation.orderReference),
          );
        }),
      ),
  );

  it.live('#1159 GoPay sandbox: a lost create response is not replayed; the callback id recovers it by lookup', (ctx) =>
    gopay(ctx, (input) =>
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
            payerContact: SANDBOX_PAYER,
            returnToken,
          }),
        );
        const expected = collectExpected(operation, COLLECT_AMOUNT);
        const lost = yield* Effect.flip(input.provider.lossy.send(input.target, prepared, expected));
        const replay = yield* Effect.flip(
          input.provider.adapter.replay(
            input.target,
            { prepared, window: { expiresAt: DateTime.add(preparedAt, { hours: 24 }), startsAt: preparedAt } },
            expected,
          ),
        );
        const byOrderReference = yield* Effect.flip(
          input.provider.adapter.lookup(input.target, orderReferenceLookup(operation, expected, preparedAt)),
        );
        const payment = Option.getOrThrow(yield* withheldObjectId(input.provider.withheld, decodeCreatedPayment));
        const findings = yield* lookupCollection(input, operation, payment, preparedAt);

        expect(lost).toMatchObject({ code: 'gateway_provider_outcome_unknown' });
        expect(replay).toMatchObject({ code: 'gateway_provider_unsupported' });
        expect(byOrderReference).toMatchObject({ code: 'gateway_provider_unsupported' });
        expect(orderReferenceOf(findings, operation)).toEqual(Option.some(operation.correlation.orderReference));
      }),
    ),
  );
});
