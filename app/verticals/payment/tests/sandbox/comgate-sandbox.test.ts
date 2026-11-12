import { DateTime, Effect, Option, Redacted, Schema } from 'effect';
import type { Scope } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import type { TestContext } from 'effect-rstest';

import { ComgateCreatePaymentResponseFromJsonSchema } from '../../src/integrations/comgate/comgate-wire.ts';
import type { ProviderObjectRef } from '../../src/integrations/psp/psp-request.ts';
import type { ProviderFindingResult } from '../../src/integrations/psp/psp-result.ts';
import {
  ComgateTransactionRefSchema,
  HOSTED_PAYMENT_WAIT,
  HOSTED_POLL,
  HOSTED_SCENARIO_TIMEOUT_MS,
  SANDBOX_NOTIFICATION_URL,
  SANDBOX_RETURN_URL,
  announce,
  cancelExpected,
  cancelRequestOf,
  collectExpected,
  collectRequestOf,
  comgateSandboxCredentials,
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
  withheldObjectId,
} from './sandbox-harness.ts';
import type { ComgateSandboxCredentials, SandboxOperation, SandboxScenarioInput } from './sandbox-harness.ts';

/**
 * #1159 level 4: Comgate test payments (`https://payments.comgate.cz`, `test: true`) through the production
 * `ComgatePaymentService` (plan §6 Comgate). Needs `ONTOS_C17_SANDBOX_COMGATE_MERCHANT_ID` and
 * `ONTOS_C17_SANDBOX_COMGATE_SECRET` from a shop connection with test payments allowed, and this runner's
 * public IPv4 on the connection's allowed-IP list. The hosted step is done by a human on the payment page
 * or in the Client Portal (Tester role: simulate PAID).
 *
 * Comgate requires a payer contact (N9), so the scenarios send a synthetic one. A sandbox refund is only ever
 * REFUND_PENDING: statements exist only for production payments (D-P2). Comgate cannot be replayed and has no
 * order-reference lookup. A push carries the shop secret instead of a signature and can only reach a
 * public endpoint, so the push scenario verifies a push-shaped body built from the real payment.
 */

const COLLECT_AMOUNT = { amountMinor: 10_000, currency: 'CZK' } as const;
const REFUND_AMOUNT = { amountMinor: 4000, currency: 'CZK' } as const;
const PAYER_CONTACT = Option.some({
  email: Option.some('sandbox-payer@example.com'),
  fullName: Option.some('Sandbox Payer'),
  phone: Option.none(),
});

const setup = {
  credentials: comgateSandboxCredentials,
  material: (credentials: ComgateSandboxCredentials) => ({ _tag: 'COMGATE', secret: credentials.secret }) as const,
  target: (credentials: ComgateSandboxCredentials) =>
    sandboxTarget({
      merchantIdentity: { _tag: 'COMGATE', merchantId: credentials.merchantId },
      notificationUrl: SANDBOX_NOTIFICATION_URL,
      returnUrl: Option.some(SANDBOX_RETURN_URL),
    }),
};

type ComgateScenario = SandboxScenarioInput<ComgateSandboxCredentials>;

const comgate = <A, E>(ctx: TestContext, scenario: (input: ComgateScenario) => Effect.Effect<A, E, Scope.Scope>) =>
  sandboxScenario(ctx, setup, scenario);

const createPayment = ({ provider, target }: ComgateScenario) =>
  Effect.gen(function* createPaymentEffect() {
    const [operation, returnToken, issuedAt] = yield* Effect.all([newOperation, newReturnToken, sandboxNow], {
      concurrency: 1,
    });
    const prepared = yield* provider.adapter.prepareCollect(
      target,
      collectRequestOf({ amount: COLLECT_AMOUNT, issuedAt, operation, payerContact: PAYER_CONTACT, returnToken }),
    );
    const response = yield* provider.adapter.send(target, prepared, collectExpected(operation, COLLECT_AMOUNT));
    expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
    expect(response.finding.finding).toBe('CUSTOMER_ACTION_REQUIRED');
    const transaction: ProviderObjectRef = Option.getOrThrow(
      providerRefOf(response.finding, ComgateTransactionRefSchema),
    );
    const { redirectUrl } = Option.getOrThrow(response.finding.customerAction);
    return { issuedAt, operation, redirectUrl, transaction };
  });

const lookupCollection = (
  { provider, target }: ComgateScenario,
  operation: SandboxOperation,
  ref: ProviderObjectRef,
  dispatchedAt: DateTime.Utc,
) => provider.adapter.lookup(target, objectLookup(ref, collectExpected(operation, COLLECT_AMOUNT), dispatchedAt));

const orderReferenceOf = (findings: readonly ProviderFindingResult[], operation: SandboxOperation) =>
  Option.fromUndefinedOr(findings.find((finding) => finding.target.operationId === operation.operationId)).pipe(
    Option.flatMap((finding) => finding.orderReference),
  );

const decodeCreatedTransaction = (bodyText: string): Option.Option<ProviderObjectRef> =>
  Schema.decodeUnknownOption(ComgateCreatePaymentResponseFromJsonSchema)(bodyText).pipe(
    Option.flatMap((response) => Option.fromUndefinedOr(response.transId)),
    Option.map((transId) => ({ _tag: 'COMGATE_TRANSACTION', transId })),
  );

/** The transId of a COMGATE_TRANSACTION ref. */
const transIdOf = (ref: ProviderObjectRef): string =>
  Option.getOrThrow(Option.map(Schema.decodeUnknownOption(ComgateTransactionRefSchema)(ref), (known) => known.transId));

describe('#1159 Comgate sandbox conformance', () => {
  it.live('#1159 Comgate sandbox: create a one-shot test payment and retrieve it', (ctx) =>
    comgate(ctx, (input) =>
      Effect.gen(function* createAndRetrieve() {
        const created = yield* createPayment(input);
        const findings = yield* lookupCollection(input, created.operation, created.transaction, created.issuedAt);

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
    '#1159 Comgate sandbox: the hosted test payment is confirmed by lookup; a refund stays REFUND_PENDING',
    (ctx) =>
      comgate(ctx, (input) =>
        Effect.gen(function* hostedPaymentAndRefund() {
          const created = yield* createPayment(input);
          yield* announce([
            'Comgate hosted payment step (human): open this URL and complete the test payment, or mark',
            `transaction ${transIdOf(created.transaction)} PAID in the Client Portal (Tester role).`,
            `Polling lookup for up to ${HOSTED_PAYMENT_WAIT}.`,
            created.redirectUrl,
          ]);
          const paid = yield* pollUntil(
            lookupCollection(input, created.operation, created.transaction, created.issuedAt),
            (current) => findingKindFor(current, created.operation.operationId) === 'EFFECT_CONFIRMED',
            HOSTED_POLL,
          );
          expect(findingKindFor(paid, created.operation.operationId)).toBe('EFFECT_CONFIRMED');

          const refund = yield* newOperation;
          const prepared = yield* input.provider.adapter.prepareRefund(
            input.target,
            refundRequestOf({
              amount: REFUND_AMOUNT,
              collection: created.operation,
              providerTarget: created.transaction,
              refund,
            }),
          );
          const response = yield* input.provider.adapter.send(
            input.target,
            prepared,
            refundExpected(refund, REFUND_AMOUNT),
          );

          expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
          expect(response.finding.finding).toBe('ACCEPTED_PENDING');
          expect(response.finding.evidence.pipe(Option.map((evidence) => evidence.factKind))).toEqual(
            Option.some('REFUND_PENDING'),
          );
        }),
      ),
    HOSTED_SCENARIO_TIMEOUT_MS,
  );

  it.live('#1159 Comgate sandbox: cancel of a pending payment is confirmed by the status lookup', (ctx) =>
    comgate(ctx, (input) =>
      Effect.gen(function* cancelScenario() {
        const created = yield* createPayment(input);
        const cancel = yield* newOperation;
        const prepared = yield* input.provider.adapter.prepareCancel(
          input.target,
          cancelRequestOf({ cancel, collection: created.operation, providerTarget: created.transaction }),
        );
        const response = yield* input.provider.adapter.send(
          input.target,
          prepared,
          cancelExpected(cancel, created.operation, COLLECT_AMOUNT),
        );

        expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
        expect(response.finding.finding).toBe('EFFECT_CONFIRMED');
        expect(response.finding.evidence.pipe(Option.map((evidence) => evidence.factKind))).toEqual(
          Option.some('CANCEL_CONFIRMED'),
        );
      }),
    ),
  );

  it.live('#1159 Comgate sandbox: a push for a real payment verifies with the shop secret and only with it', (ctx) =>
    comgate(ctx, (input) =>
      Effect.gen(function* pushScenario() {
        const created = yield* createPayment(input);
        const receivedAt = yield* sandboxNow;
        const pushOf = (secret: string, merchant: string) =>
          rawNotification({
            contentType: Option.some('application/json'),
            family: 'COMGATE',
            paymentRef: Option.none(),
            rawBody: new TextEncoder().encode(
              JSON.stringify({
                curr: 'CZK',
                merchant,
                price: String(COLLECT_AMOUNT.amountMinor),
                refId: created.operation.correlation.orderReference,
                secret,
                status: 'PENDING',
                test: 'true',
                transId: transIdOf(created.transaction),
              }),
            ),
            receivedAt,
            stripeSignature: Option.none(),
            transportDeliveryRef: 'sandbox-push-1',
          });
        const secret = Redacted.value(input.credentials.secret);
        const trigger = yield* input.provider.adapter.verifyNotification(
          input.target,
          pushOf(secret, input.credentials.merchantId),
        );
        const wrongSecret = yield* Effect.flip(
          input.provider.adapter.verifyNotification(input.target, pushOf(`${secret}x`, input.credentials.merchantId)),
        );
        const wrongMerchant = yield* Effect.flip(
          input.provider.adapter.verifyNotification(input.target, pushOf(secret, `${input.credentials.merchantId}9`)),
        );

        expect(trigger).toMatchObject({ actionable: true, authenticity: 'SHARED_SECRET_VERIFIED', family: 'COMGATE' });
        expect(trigger.providerRefs).toContainEqual(created.transaction);
        expect(wrongSecret).toMatchObject({ reason: 'SECRET_MISMATCH' });
        expect(wrongMerchant).toMatchObject({ reason: 'MERCHANT_MISMATCH' });
      }),
    ),
  );

  it.live('#1159 Comgate sandbox: a lost create response is not replayed; the transId recovers it by lookup', (ctx) =>
    comgate(ctx, (input) =>
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
            payerContact: PAYER_CONTACT,
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
        const transaction = Option.getOrThrow(
          yield* withheldObjectId(input.provider.withheld, decodeCreatedTransaction),
        );
        const findings = yield* lookupCollection(input, operation, transaction, preparedAt);

        expect(lost).toMatchObject({ code: 'gateway_provider_outcome_unknown' });
        expect(replay).toMatchObject({ code: 'gateway_provider_unsupported' });
        expect(byOrderReference).toMatchObject({ code: 'gateway_provider_unsupported' });
        expect(orderReferenceOf(findings, operation)).toEqual(Option.some(operation.correlation.orderReference));
      }),
    ),
  );
});
