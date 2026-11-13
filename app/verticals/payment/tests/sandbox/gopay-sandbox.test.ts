import { DateTime, Effect, Option, Schema } from 'effect';
import type { Scope } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import type { TestContext } from 'effect-rstest';

import { GopayPaymentFromJsonSchema, gopayProviderObjectId } from '../../src/integrations/gopay/gopay-wire.ts';
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
  cancelRequestOf,
  collectExpected,
  collectRequestOf,
  dispatchOutcomeOf,
  findingKindFor,
  gopaySandboxCredentials,
  lastProviderBody,
  newOperation,
  newReturnToken,
  objectLookup,
  orderReferenceLookup,
  pollUntil,
  providerCallMark,
  providerCallsSince,
  providerRefOf,
  rawNotification,
  refundExpected,
  refundRequestOf,
  sandboxNow,
  sandboxScenario,
  sandboxTarget,
  withheldObjectId,
} from './sandbox-harness.ts';
import type {
  GopaySandboxCredentials,
  SandboxAmount,
  SandboxOperation,
  SandboxProviderCall,
  SandboxScenarioInput,
} from './sandbox-harness.ts';

/**
 * #1159 level 4: the GoPay sandbox (`https://gw.sandbox.gopay.com/api`) through the production
 * `GopayPaymentService` and `GopayOAuthToken` (plan §6 GoPay). Needs `ONTOS_C17_SANDBOX_GOPAY_CLIENT_ID`,
 * `ONTOS_C17_SANDBOX_GOPAY_CLIENT_SECRET` and `ONTOS_C17_SANDBOX_GOPAY_GOID`; when the optional public
 * `ONTOS_C17_SANDBOX_GOPAY_NOTIFICATION_URL` is set, created payments name it as `notification_url` so GoPay
 * calls it on every state change.
 *
 * GoPay has no cancel/void API (N8), no order-reference lookup and no replay: those scenarios assert the
 * typed Unsupported answers.
 *
 * Hosted pages (https://help.gopay.com/en/articles/16847061-making-payments-in-the-test-environment) can be
 * completed by an automated browser only with the two documented sandbox instruments:
 * - the offline bank-transfer simulator (choose bank transfer, then the offline transfer; the simulator takes its
 *   published fictitious payer account and the payment id as variable symbol). An online bank redirects to the
 *   bank's real login and cannot be completed.
 * - the sandbox card 5447 3800 0000 0006, any future expiry, any three-digit CVC. An amount ending in 00 is
 *   approved, one ending in 04 is declined. Card payments can only be refunded in full.
 * So the partial refund runs on the bank-transfer route and the full refund on the card route.
 *
 * Refund confirmation (real sandbox, 2026-11-13): the refund history row id is not the payment id and
 * `date_requested` is a date only (`2026-11-13`), so a refund cannot be placed after its dispatch by date. A refund
 * is confirmed only when, compared with the history read before the refund was sent, exactly one new SUCCESS
 * row of the exact amount appears. Each refund scenario reads that baseline through the adapter before it
 * dispatches and checks the provider history itself, independently of the adapter's verdict.
 */

const GOPAY_TEST_ENVIRONMENT_DOC =
  'https://help.gopay.com/en/articles/16847061-making-payments-in-the-test-environment';
/** Ends in 00, so the sandbox test card 5447 3800 0000 0006 pays it. */
const COLLECT_AMOUNT = { amountMinor: 10_000, currency: 'CZK' } as const;
const PARTIAL_REFUND_AMOUNT = { amountMinor: 4000, currency: 'CZK' } as const;
/** Ends in 04: the documented decline control of the sandbox test card. */
const DECLINED_CARD_AMOUNT = { amountMinor: 10_004, currency: 'CZK' } as const;
/** 1 599,50 CZK: a create and lookup must keep the haléř part. */
const FRACTIONAL_AMOUNT = { amountMinor: 159_950, currency: 'CZK' } as const;
/** `gopay:<id>:` plus 200 characters exceeds the 200-character stored delivery identity (plan §13.2). */
const OVERLONG_DELIVERY_REF = 'r'.repeat(200);

const BANK_TRANSFER_INSTRUCTIONS = [
  'Pay by BANK TRANSFER with the OFFLINE bank-transfer simulator (an online bank opens a real bank login that',
  'cannot be completed): use the simulator’s published fictitious payer account and the payment id as',
  `variable symbol (${GOPAY_TEST_ENVIRONMENT_DOC}).`,
] as const;
const SANDBOX_CARD_INSTRUCTIONS = [
  'Pay by CARD with the sandbox card 5447 3800 0000 0006, any future expiry and any three-digit CVC',
  `(${GOPAY_TEST_ENVIRONMENT_DOC}).`,
] as const;

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
type GopayPaymentRef = typeof GopayPaymentRefSchema.Type;

const gopay = <A, E>(ctx: TestContext, scenario: (input: GopayScenario) => Effect.Effect<A, E, Scope.Scope>) =>
  sandboxScenario(ctx, setup, scenario);

const createPayment = ({ provider, target }: GopayScenario, amount: SandboxAmount = COLLECT_AMOUNT) =>
  Effect.gen(function* createPaymentEffect() {
    const [operation, returnToken, issuedAt] = yield* Effect.all([newOperation, newReturnToken, sandboxNow], {
      concurrency: 1,
    });
    const prepared = yield* provider.adapter.prepareCollect(
      target,
      collectRequestOf({ amount, issuedAt, operation, payerContact: Option.none(), returnToken }),
    );
    const response = yield* provider.adapter.send(target, prepared, collectExpected(operation, amount));
    expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
    expect(response.finding.finding).toBe('CUSTOMER_ACTION_REQUIRED');
    const payment = Option.getOrThrow(providerRefOf(response.finding, GopayPaymentRefSchema));
    const { redirectUrl } = Option.getOrThrow(response.finding.customerAction);
    return { amount, issuedAt, operation, payment, redirectUrl };
  });

type CreatedPayment = Effect.Success<ReturnType<typeof createPayment>>;

const lookupCollection = (
  { provider, target }: GopayScenario,
  operation: SandboxOperation,
  ref: ProviderObjectRef,
  dispatchedAt: DateTime.Utc,
  amount: SandboxAmount = COLLECT_AMOUNT,
) => provider.adapter.lookup(target, objectLookup(ref, collectExpected(operation, amount), dispatchedAt));

const findingFor = (findings: readonly ProviderFindingResult[], operationId: string) =>
  Option.fromUndefinedOr(findings.find((finding) => finding.target.operationId === operationId));

const orderReferenceOf = (findings: readonly ProviderFindingResult[], operation: SandboxOperation) =>
  findingFor(findings, operation.operationId).pipe(Option.flatMap((finding) => finding.orderReference));

const factKindOf = (findings: readonly ProviderFindingResult[], operationId: string) =>
  findingFor(findings, operationId).pipe(
    Option.flatMap((finding) => finding.evidence),
    Option.map((evidence) => evidence.factKind),
  );

const decodeCreatedPayment = (bodyText: string): Option.Option<ProviderObjectRef> =>
  Option.map(Schema.decodeUnknownOption(GopayPaymentFromJsonSchema)(bodyText), (payment) => ({
    _tag: 'GOPAY_PAYMENT',
    id: gopayProviderObjectId(payment.id),
  }));

// ---------------------------------------------------------------------------------------------------
// Provider truth read from the adapter's own calls (decoded here, independently of the adapter)
// ---------------------------------------------------------------------------------------------------

/** The fields of a GoPay payment body the scenarios check against the adapter's verdict. */
const ObservedPaymentSchema = Schema.Struct({
  amount: Schema.Number,
  currency: Schema.String,
  id: Schema.Number,
  state: Schema.String,
});
const decodeObservedPayment = Schema.decodeUnknownOption(Schema.fromJsonString(ObservedPaymentSchema));

/** One `GET /payments/payment/{id}/refunds` row: `id` is a history-row id, not the payment id. */
const ObservedRefundRowSchema = Schema.Struct({
  amount: Schema.Number,
  currency: Schema.String,
  id: Schema.Number,
  state: Schema.String,
});
type ObservedRefundRow = typeof ObservedRefundRowSchema.Type;
const decodeObservedRefundHistory = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ObservedRefundRowSchema)),
);

const isPaymentRead = (payment: GopayPaymentRef) => (call: SandboxProviderCall) =>
  call.kind === 'read' && call.url.endsWith(`/payments/payment/${payment.id}`);
const isRefundHistoryRead = (payment: GopayPaymentRef) => (call: SandboxProviderCall) =>
  call.kind === 'read' && call.url.endsWith(`/payments/payment/${payment.id}/refunds`);

/** The refund history GoPay last returned to the adapter for `payment` among `calls`. */
const refundHistoryIn = (calls: readonly SandboxProviderCall[], payment: GopayPaymentRef) =>
  lastProviderBody(calls, isRefundHistoryRead(payment), decodeObservedRefundHistory);

/** Rows of `after` that `baseline` did not contain, by history-row id. */
const newRowsSince = (baseline: readonly ObservedRefundRow[], after: readonly ObservedRefundRow[]) =>
  after.filter((row) => !baseline.some((known) => known.id === row.id));

// ---------------------------------------------------------------------------------------------------
// Hosted payment and refund
// ---------------------------------------------------------------------------------------------------

/** Prints the hosted page with its instrument, then polls lookup until the collection is decided as `decided`. */
const payHosted = (
  input: GopayScenario,
  created: CreatedPayment,
  page: {
    readonly decided: 'EFFECT_CONFIRMED' | 'NOT_EFFECTED';
    readonly instructions: readonly string[];
    readonly scenario: string;
  },
) =>
  Effect.gen(function* payHostedEffect() {
    yield* announceHostedPage({
      lines: [
        `GoPay hosted payment step (human or browser agent), payment ${created.payment.id}:`,
        ...page.instructions,
        `Polling lookup for up to ${HOSTED_PAYMENT_WAIT}.`,
      ],
      provider: 'GOPAY',
      scenario: page.scenario,
      url: created.redirectUrl,
    });
    return yield* pollUntil(
      lookupCollection(input, created.operation, created.payment, created.issuedAt, created.amount),
      (current) => findingKindFor(current, created.operation.operationId) === page.decided,
      HOSTED_POLL,
    );
  });

/**
 * Refunds `amount` of a paid payment through the adapter. The adapter's prepare reads the refund history before
 * the send (the baseline it persists with the prepared request); the scenario decodes that same provider answer
 * itself and checks it equals `prepared.refundBaseline`. After the send, lookups carry that baseline exactly as the
 * ledger hands it over for an acknowledged refund. The scenario passes only when GoPay shows exactly one new SUCCESS
 * row of the exact amount AND the adapter confirms the refund. An unproven refund must never be confirmed.
 */
const refundAndProve = (input: GopayScenario, created: CreatedPayment, amount: SandboxAmount) =>
  Effect.gen(function* refundAndProveEffect() {
    const refund = yield* newOperation;
    const prepareMark = yield* providerCallMark(input.provider);
    const refundedAt = yield* sandboxNow;
    // A history read that is not a decodable 200 fails prepare (nothing is sent), so this also checks the
    // unverified assumption that a never-refunded payment answers `200 []`.
    const prepared = yield* input.provider.adapter.prepareRefund(
      input.target,
      refundRequestOf({ amount, collection: created.operation, providerTarget: created.payment, refund }),
    );
    const baseline = Option.getOrThrow(
      refundHistoryIn(yield* providerCallsSince(input.provider, prepareMark), created.payment),
    );
    expect(prepared.refundBaseline).toEqual(Option.some({ rowIds: baseline.map((row) => `${row.id}`) }));

    const response = yield* input.provider.adapter.send(input.target, prepared, refundExpected(refund, amount));
    expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
    expect(['EFFECT_CONFIRMED', 'ACCEPTED_PENDING']).toContain(response.finding.finding);

    const settledMark = yield* providerCallMark(input.provider);
    const settled = yield* pollUntil(
      input.provider.adapter.lookup(
        input.target,
        objectLookup(created.payment, refundExpected(refund, amount), refundedAt, prepared.refundBaseline),
      ),
      (current) => findingKindFor(current, refund.operationId) === 'EFFECT_CONFIRMED',
      SETTLE_POLL,
    );
    const after = Option.getOrThrow(
      refundHistoryIn(yield* providerCallsSince(input.provider, settledMark), created.payment),
    );
    const added = newRowsSince(baseline, after);

    // Provider truth first: exactly one new SUCCESS row of the exact amount, under a row id of its own.
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ amount: amount.amountMinor, currency: amount.currency, state: 'SUCCESS' });
    // Then the adapter's verdict, which may rest only on that row.
    expect(findingKindFor(settled, refund.operationId)).toBe('EFFECT_CONFIRMED');
    expect(factKindOf(settled, refund.operationId)).toEqual(Option.some('REFUND_CONFIRMED'));
    return { after, refund };
  });

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

  it.live('#1159 GoPay sandbox: a fractional amount (1 599,50 CZK) is created and retrieved exactly', (ctx) =>
    gopay(ctx, (input) =>
      Effect.gen(function* fractionalAmount() {
        const mark = yield* providerCallMark(input.provider);
        const created = yield* createPayment(input, FRACTIONAL_AMOUNT);
        const findings = yield* lookupCollection(
          input,
          created.operation,
          created.payment,
          created.issuedAt,
          FRACTIONAL_AMOUNT,
        );
        const calls = yield* providerCallsSince(input.provider, mark);
        const createdBody = lastProviderBody(
          calls,
          (call) => call.kind === 'mutate' && call.url.endsWith('/payments/payment'),
          decodeObservedPayment,
        );
        const inquiry = lastProviderBody(calls, isPaymentRead(created.payment), decodeObservedPayment);

        // Not paid: the approved sandbox card needs an amount ending in 00, so no PAID claim is made here.
        expect(['CUSTOMER_ACTION_REQUIRED', 'ACCEPTED_PENDING', 'INDETERMINATE']).toContain(
          findingKindFor(findings, created.operation.operationId),
        );
        expect(createdBody.pipe(Option.map(({ amount, currency }) => ({ amount, currency })))).toEqual(
          Option.some({ amount: 159_950, currency: 'CZK' }),
        );
        expect(inquiry.pipe(Option.map(({ amount, currency }) => ({ amount, currency })))).toEqual(
          Option.some({ amount: 159_950, currency: 'CZK' }),
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
          const paid = yield* payHosted(input, created, {
            decided: 'EFFECT_CONFIRMED',
            instructions: [...BANK_TRANSFER_INSTRUCTIONS, 'Partial refunds are not possible on card payments.'],
            scenario: 'hosted-payment-and-refund',
          });
          expect(findingKindFor(paid, created.operation.operationId)).toBe('EFFECT_CONFIRMED');

          yield* refundAndProve(input, created, PARTIAL_REFUND_AMOUNT);
        }),
      ),
    HOSTED_SCENARIO_TIMEOUT_MS,
  );

  it.live(
    '#1159 GoPay sandbox: the hosted card payment is confirmed by lookup and fully refunded',
    (ctx) =>
      gopay(ctx, (input) =>
        Effect.gen(function* hostedCardFullRefund() {
          const created = yield* createPayment(input);
          const paid = yield* payHosted(input, created, {
            decided: 'EFFECT_CONFIRMED',
            instructions: SANDBOX_CARD_INSTRUCTIONS,
            scenario: 'hosted-card-full-refund',
          });
          expect(findingKindFor(paid, created.operation.operationId)).toBe('EFFECT_CONFIRMED');

          const { after } = yield* refundAndProve(input, created, COLLECT_AMOUNT);
          expect(after.filter((row) => row.state === 'SUCCESS')).toHaveLength(1);
        }),
      ),
    HOSTED_SCENARIO_TIMEOUT_MS,
  );

  it.live(
    '#1159 GoPay sandbox: the documented declined card (amount ending 04) ends CANCELED and NOT_EFFECTED',
    (ctx) =>
      gopay(ctx, (input) =>
        Effect.gen(function* declinedCard() {
          const created = yield* createPayment(input, DECLINED_CARD_AMOUNT);
          const mark = yield* providerCallMark(input.provider);
          const findings = yield* payHosted(input, created, {
            decided: 'NOT_EFFECTED',
            instructions: [...SANDBOX_CARD_INSTRUCTIONS, 'The amount ends in 04, so GoPay must decline the card.'],
            scenario: 'hosted-card-declined',
          });
          const inquiry = lastProviderBody(
            yield* providerCallsSince(input.provider, mark),
            isPaymentRead(created.payment),
            decodeObservedPayment,
          );

          expect(inquiry.pipe(Option.map(({ amount, state }) => ({ amount, state })))).toEqual(
            Option.some({ amount: 10_004, state: 'CANCELED' }),
          );
          expect(findingKindFor(findings, created.operation.operationId)).toBe('NOT_EFFECTED');
          expect(factKindOf(findings, created.operation.operationId)).toEqual(Option.some('COLLECTION_NOT_EFFECTED'));
        }),
      ),
    HOSTED_SCENARIO_TIMEOUT_MS,
  );

  it.live('#1159 GoPay sandbox: cancel is UNSUPPORTED and leaves the payment open', (ctx) =>
    gopay(ctx, (input) =>
      Effect.gen(function* cancelUnsupported() {
        const created = yield* createPayment(input);
        const cancel = yield* newOperation;
        const refused = yield* Effect.flip(
          input.provider.adapter.prepareCancel(
            input.target,
            cancelRequestOf({ cancel, collection: created.operation, providerTarget: created.payment }),
          ),
        );
        const findings = yield* lookupCollection(input, created.operation, created.payment, created.issuedAt);

        expect(refused).toMatchObject({
          capability: 'CANCEL_OR_VOID',
          code: 'gateway_provider_unsupported',
          reason: 'provider_cancel_unsupported',
        });
        expect(findingKindFor(findings, created.operation.operationId)).not.toBe('NOT_EFFECTED');
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
            payerContact: Option.none(),
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
