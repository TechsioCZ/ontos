// @effect-diagnostics strictEffectProvide:off -- The test captures the worker's log lines with its own Logger layer; expires: 2027-03-31.
import { NodeCrypto } from '@effect/platform-node';
import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime';
import { OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/sales-pipeline/outbox/opportunity-stage-changed';
import { Effect, Exit, Logger, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { FinanceReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import { FinanceStateSchema } from '../../shared/apis/records.ts';
import type { InvoiceLine } from '../../shared/apis/records.ts';
import type { VatChoices } from '../../shared/apis/vat-choices.ts';
import { FinanceTaxRates } from '../../src/integrations/tax-rates.ts';
import {
  DraftInvoiceFromWonOpportunityRejected,
  draftInvoiceFromWonOpportunityWorker,
  handleDraftInvoiceFromWonOpportunity,
} from '../../src/workers/draft-invoice-from-won-opportunity.worker.ts';
import {
  OpportunityInvoiceLedger,
  opportunityInvoiceLedgerLive,
  saveFinanceStateForWorkerRoutine,
} from '../../src/workers/opportunity-invoice-ledger.ts';
import { baselineVatChoices, testTaxRuleRevisionRef } from '../support/finance-tax-rates.ts';
import { CZ_VAT_STANDARD } from '@app/shared-contracts/cz-vat-classifications';
import { forSellerRegime, lineVatOf } from '../../shared/domain/line-vat.ts';
import type { OutboxClaim, OutboxRepositoryService } from '../../../../packages/core-runtime/src/outbox/repository.ts';
import { getOutboxWorkerHandler } from '../../../../packages/core-runtime/src/outbox/definition.ts';
import { makeOutboxRuntime } from '../../../../packages/core-runtime/src/outbox/runtime.ts';

const tenantId = '21000000-0000-4000-8000-000000000001';
const legalEntityId = '31000000-0000-4000-8000-000000000001';
const opportunityId = '41000000-0000-4000-8000-000000000002';
/** When, and which opportunity, the message reports won. */
type WonOn = Pick<typeof OutboxPayloadSchema.Encoded, 'changedAt' | 'opportunityId'>;
const wonOn2Nov: WonOn = { changedAt: '2026-11-02T09:00:00.000Z', opportunityId };

/** A second company of the same Tenant, ordered before the opportunity's (by id). */
const otherLegalEntityId = '31000000-0000-4000-8000-000000000000';

const won: OutboxWorkerHandlerContext = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: '51000000-0000-4000-8000-000000000001',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'finance.billing',
  deliveryId: '51000000-0000-4000-8000-000000000002',
  domainEventId: '51000000-0000-4000-8000-000000000003',
  legalEntityScope: 'required',
  messageId: '51000000-0000-4000-8000-000000000004',
  originatorInvocationId: '51000000-0000-4000-8000-000000000005',
  // The company the person who marked the opportunity won acted in: the opportunity's company.
  originatorLegalEntityId: legalEntityId,
  producerModuleKey: outboxProducerModuleKey,
  tenantId,
  tenantSequenceNo: 1n,
  topic: outboxTopic,
  workerKey: draftInvoiceFromWonOpportunityWorker.descriptor.workerKey,
});

const wonMessage = (vatRate: number, when: WonOn = wonOn2Nov) =>
  ({
    amountMinor: 100_000,
    changedAt: when.changedAt,
    currency: 'CZK',
    fromStage: 'NEGOTIATION',
    lines: [
      {
        productId: '41000000-0000-4000-8000-000000000004',
        productName: 'Roční servis',
        quantity: 1,
        unitPriceMinor: 100_000,
        vatRate,
      },
    ],
    opportunityId: when.opportunityId,
    partyId: '41000000-0000-4000-8000-000000000003',
    revision: 1,
    toStage: 'WON',
  }) satisfies typeof OutboxPayloadSchema.Encoded;

const wonPayload = (vatRate: number, when?: WonOn) =>
  Schema.decodeEffect(OutboxPayloadSchema)(wonMessage(vatRate, when));

/** One company's finance ledger, saved with a revision check exactly like the worker routines. */
const SaveParametersSchema = Schema.Tuple([Schema.Int, Schema.Unknown]);

/** The stored ledger row: its revision, how often a delivery saved it, and its encoded finance state. */
interface StoredLedger {
  revision: number;
  saves: number;
  state: unknown;
}

const makeLedger = (company: string = legalEntityId, keepsLedger = true) => {
  const ledger: StoredLedger = {
    revision: 0,
    saves: 0,
    state: { financialPlanEntries: [], invoices: [] },
  };
  const scope: OutboxWorkerLegalEntityScope = {
    completionPublisher: { publish: () => Effect.die('Invoice drafting must not publish completion evidence') },
    legalEntityId: company,
    routineInvoker: {
      invoke: (routine, parameters) => {
        if (!keepsLedger) {
          return Effect.succeed([]);
        }
        if (routine.routineKey === saveFinanceStateForWorkerRoutine.routineKey) {
          const [expected, state] = Schema.decodeUnknownSync(SaveParametersSchema)(parameters);
          if (expected !== ledger.revision) {
            return Effect.succeed([]);
          }
          ledger.revision += 1;
          ledger.saves += 1;
          ledger.state = state;
          return Effect.succeed(
            Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([{ revision: ledger.revision }]),
          );
        }
        return Effect.succeed(
          Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([
            { revision: ledger.revision, state: ledger.state },
          ]),
        );
      },
    },
    tenantId,
  };
  const invoices = () => Schema.decodeUnknownSync(FinanceStateSchema)(ledger.state).invoices;
  return { invoices, ledger, scope };
};

/** Tax as the company currently stands: a regime (declared or not), with or without published rates. */
const taxAnswering = (current: () => VatChoices) =>
  FinanceTaxRates.of({
    choices: () => Effect.die('The worker asks Tax for the originator only'),
    choicesFor: () => Effect.succeed(current()),
  });

/** One Outbox delivery attempt of the won message against this ledger. */
const deliver = (
  scope: OutboxWorkerLegalEntityScope | readonly OutboxWorkerLegalEntityScope[],
  tax: FinanceTaxRates['Service'],
  payload: typeof OutboxPayloadSchema.Type,
) =>
  handleDraftInvoiceFromWonOpportunity(payload, won).pipe(
    Effect.provideService(FinanceTaxRates, tax),
    Effect.provideService(OpportunityInvoiceLedger, opportunityInvoiceLedgerLive),
    Effect.provideService(OutboxWorkerLegalEntityScopeFanout, {
      forEachScope: (_claim, observe) =>
        Effect.forEach(Array.isArray(scope) ? scope : [scope], observe, { discard: true }),
    }),
  );

/** The first claim of the won message, as Core's Outbox hands it to this worker. */
const firstClaim = (message: typeof OutboxPayloadSchema.Encoded): OutboxClaim => ({
  attemptId: '51000000-0000-4000-8000-000000000006',
  attemptNumber: 1,
  claimId: won.claimId,
  consumerModuleKey: 'finance.billing',
  deliveryId: won.deliveryId,
  domainEventId: won.domainEventId,
  messageId: won.messageId,
  originatorInvocationId: '51000000-0000-4000-8000-000000000005',
  originatorLegalEntityId: legalEntityId,
  payloadJson: message,
  producerModuleKey: outboxProducerModuleKey,
  retryPolicy: draftInvoiceFromWonOpportunityWorker.descriptor.retryPolicy,
  tenantId,
  tenantSequenceNo: 1n,
  topic: outboxTopic,
  workerKey: draftInvoiceFromWonOpportunityWorker.descriptor.workerKey,
});

/**
 * One Outbox cycle of Core's runtime over the first claim of the won message: the real worker registration, settled
 * by the Outbox repository's own rule for where a failed attempt goes (dead or pending for a retry). Logs are kept.
 */
const settleFirstAttempt = (
  scope: OutboxWorkerLegalEntityScope | readonly OutboxWorkerLegalEntityScope[],
  tax: FinanceTaxRates['Service'],
  message: typeof OutboxPayloadSchema.Encoded,
) => {
  const claims = [firstClaim(message)];
  const scopes = Array.isArray(scope) ? scope : [scope];
  const outbox: OutboxRepositoryService = {
    claimNext: () => Effect.sync(() => Option.fromNullishOr(claims.shift())),
    complete: () => Effect.void,
    // The repository's own rule: dead only once the retry policy has no attempt left.
    fail: (claim) => Effect.succeed(claim.attemptNumber >= claim.retryPolicy.maxAttempts ? 'dead' : 'pending'),
    matchUnmatched: () => Effect.succeed({ deliveriesCreated: 0, messagesMatched: 0 }),
  };
  return makeOutboxRuntime(outbox)
    .runCycle({
      claimOwner: 'won-opportunity-vat-readiness',
      compositionRevision: won.compositionRevision,
      registrations: [draftInvoiceFromWonOpportunityWorker],
      subscriptions: [draftInvoiceFromWonOpportunityWorker.descriptor],
    })
    .pipe(
      Effect.map(({ dead, retried, succeeded }) => ({ dead, retried, succeeded })),
      Effect.provideService(FinanceTaxRates, tax),
      Effect.provideService(OpportunityInvoiceLedger, opportunityInvoiceLedgerLive),
      Effect.provideService(OutboxWorkerLegalEntityScopeFanout, {
        forEachScope: (_claim, observe) => Effect.forEach(scopes, observe, { discard: true }),
      }),
    );
};

const DAY_MS = 86_400_000;

/** Tax cannot answer for the originator (unreachable, not installed or refusing). */
const down = () =>
  Effect.fail(new FinanceReferenceUnavailable({ code: 'finance_reference_unavailable', reason: 'down' }));

/**
 * How long Core keeps retrying this worker's failed delivery before it marks it dead: Core's exponential back-off
 * (packages/core-runtime/src/outbox/definition.ts retryBackoffMs) after every attempt but the last.
 */
const retrySpanMs = () => {
  const policy = draftInvoiceFromWonOpportunityWorker.descriptor.retryPolicy;
  let span = 0;
  for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
    span += Math.min(policy.maxBackoffMs, Math.round(policy.initialBackoffMs * policy.multiplier ** (attempt - 1)));
  }
  return span;
};

/**
 * Core's retry policy keeps a retryable delivery pending for weeks, at least daily, instead of giving up within seconds;
 * a not-ready one the worker itself ends 72 hours after the win (see the 72-hour suite below).
 */
const expectRetriedForWeeks = () => {
  expect(draftInvoiceFromWonOpportunityWorker.descriptor.retryPolicy.maxBackoffMs).toBe(DAY_MS);
  expect(retrySpanMs()).toBeGreaterThan(60 * DAY_MS);
};

const failureOf = <Requirements>(effect: Effect.Effect<void, DraftInvoiceFromWonOpportunityRejected, Requirements>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((failure) => {
      expect(Schema.is(DraftInvoiceFromWonOpportunityRejected)(failure)).toBe(true);
      return { code: failure.code, reason: failure.reason, retryable: failure.retryable };
    }),
  );

it.layer(NodeCrypto.layer)('Won opportunity before the company has set up VAT', (suite) => {
  suite.effect(
    'a company without a declared VAT regime is retried as not ready within 72 hours of the win, never refused',
    () =>
      Effect.gen(function* undeclared() {
        const { invoices, ledger, scope } = makeLedger();
        const tax = taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02', 'NOT_DECLARED'));
        expect(yield* failureOf(deliver(scope, tax, yield* wonPayload(21)))).toEqual({
          code: 'VAT_NOT_READY',
          reason: 'vat_regime_not_declared',
          retryable: true,
        });
        expect(ledger.saves).toBe(0);
        expect(invoices()).toEqual([]);
        expectRetriedForWeeks();
      }),
  );

  suite.effect('declaring the regime later drafts the invoice on the next redelivery, exactly once', () =>
    Effect.gen(function* declaredLater() {
      const { invoices, ledger, scope } = makeLedger();
      let choices = baselineVatChoices(tenantId, '2026-11-02', 'NOT_DECLARED');
      // Declared, but Tax has no rate for the line's classification yet: still not ready.
      const tax = taxAnswering(() => choices);
      const payload = yield* wonPayload(21);
      expect((yield* failureOf(deliver(scope, tax, payload))).code).toBe('VAT_NOT_READY');
      choices = { ...baselineVatChoices(tenantId, '2026-11-02'), rates: [] };
      expect(yield* failureOf(deliver(scope, tax, payload))).toEqual({
        code: 'VAT_NOT_READY',
        reason: 'vat_rate_changed',
        retryable: true,
      });
      expect(ledger.saves).toBe(0);
      choices = baselineVatChoices(tenantId, '2026-11-02');
      yield* deliver(scope, tax, payload);
      // A second redelivery (lease lost after the save) converges on the same invoice.
      yield* deliver(scope, tax, payload);
      expect(ledger.saves).toBe(1);
      expect(invoices().map((invoice) => invoice.opportunityId)).toEqual([opportunityId]);
    }),
  );

  suite.effect('Tax being down is still retried, now for as long as an undeclared company', () =>
    Effect.gen(function* taxDown() {
      const { ledger, scope } = makeLedger();
      const tax = FinanceTaxRates.of({ choices: down, choicesFor: down });
      expect(yield* failureOf(deliver(scope, tax, yield* wonPayload(21)))).toEqual({
        code: 'TAX_UNAVAILABLE',
        reason: 'down',
        retryable: true,
      });
      expect(ledger.saves).toBe(0);
      expectRetriedForWeeks();
    }),
  );

  suite.effect('a genuinely invalid line is still refused, not mistaken for a company that is not ready', () =>
    Effect.gen(function* invalidLine() {
      const { ledger, scope } = makeLedger();
      const tax = taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02'));
      // 10 % names no Czech VAT classification: no later Tax setup makes this line valid.
      expect(yield* failureOf(deliver(scope, tax, yield* wonPayload(10)))).toEqual({
        code: 'FINANCE_REJECTED',
        reason: 'vat_classification_required',
        retryable: false,
      });
      expect(ledger.saves).toBe(0);
    }),
  );
});

it.layer(NodeCrypto.layer)('How Core settles a won opportunity the worker cannot draft yet', (suite) => {
  suite.effect('a genuinely invalid line completes its delivery without a draft: never retried, never dead', () =>
    Effect.gen(function* invalidLineSettled() {
      const { ledger, scope } = makeLedger();
      const tax = taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02'));
      expect(yield* settleFirstAttempt(scope, tax, wonMessage(10))).toEqual({ dead: 0, retried: 0, succeeded: 1 });
      expect(ledger.saves).toBe(0);
    }),
  );

  suite.effect('a company without a declared VAT regime is retried', () =>
    Effect.gen(function* notReadyRetried() {
      const { scope } = makeLedger();
      const tax = taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02', 'NOT_DECLARED'));
      expect(yield* settleFirstAttempt(scope, tax, wonMessage(21))).toEqual({ dead: 0, retried: 1, succeeded: 0 });
    }),
  );

  suite.effect('no published rate for the classification is retried', () =>
    Effect.gen(function* noRateRetried() {
      const { scope } = makeLedger();
      const tax = taxAnswering(() => ({ ...baselineVatChoices(tenantId, '2026-11-02'), rates: [] }));
      expect(yield* settleFirstAttempt(scope, tax, wonMessage(21))).toEqual({ dead: 0, retried: 1, succeeded: 0 });
    }),
  );

  suite.effect('Tax being unavailable is retried', () =>
    Effect.gen(function* taxDownRetried() {
      const { scope } = makeLedger();
      const tax = FinanceTaxRates.of({ choices: down, choicesFor: down });
      expect(yield* settleFirstAttempt(scope, tax, wonMessage(21))).toEqual({ dead: 0, retried: 1, succeeded: 0 });
    }),
  );
});

/** The VAT fields a stored invoice line carries (absent fields stay absent). */
const vatKeys: ReadonlySet<string> = new Set(['taxRuleRevisionRef', 'vatClassification', 'vatRate', 'vatTreatment']);
const vatOf = (line: Partial<InvoiceLine>) =>
  Object.fromEntries(Object.entries(line).filter(([key]) => vatKeys.has(key)));

/** What the invoice form stores for a new standard-rate line of this seller (forSellerRegime, then lineVatOf). */
const formLineVat = (choices: VatChoices) => {
  const vat = lineVatOf(
    forSellerRegime({ vat: { code: CZ_VAT_STANDARD, kind: 'classification' } as const }, choices.regime).vat,
    choices,
  );
  return vatOf(vat ?? {});
};

it.layer(NodeCrypto.layer)('Won opportunity priced exactly as the invoice form prices it for the seller', (suite) => {
  suite.effect("a VAT payer gets the classification's rate with its Tax rule revision", () =>
    Effect.gen(function* payer() {
      const { invoices, scope } = makeLedger();
      const choices = baselineVatChoices(tenantId, '2026-11-02');
      yield* deliver(
        scope,
        taxAnswering(() => choices),
        yield* wonPayload(21),
      );
      const [line] = invoices()[0]?.lines ?? [];
      expect(vatOf(line ?? {})).toEqual({
        taxRuleRevisionRef: testTaxRuleRevisionRef(tenantId, CZ_VAT_STANDARD),
        vatClassification: CZ_VAT_STANDARD,
        vatRate: 21,
      });
      expect(vatOf(line ?? {})).toEqual(formLineVat(choices));
    }),
  );

  suite.effect('a company that is not a VAT payer gets the non-payer treatment at 0 %, never a refusal', () =>
    Effect.gen(function* nonPayer() {
      const { invoices, scope } = makeLedger();
      const choices = baselineVatChoices(tenantId, '2026-11-02', 'NON_PAYER');
      yield* deliver(
        scope,
        taxAnswering(() => choices),
        yield* wonPayload(21),
      );
      const [invoice] = invoices();
      const [line] = invoice?.lines ?? [];
      expect(vatOf(line ?? {})).toEqual({
        vatRate: 0,
        vatTreatment: 'NON_PAYER',
      });
      expect(vatOf(line ?? {})).toEqual(formLineVat(choices));
      expect(invoice?.vatMinor ?? 0).toBe(0);
    }),
  );

  suite.effect('each opportunity is priced by the regime on its own won date', () =>
    Effect.gen(function* regimeChange() {
      const { invoices, scope } = makeLedger();
      // Not a VAT payer until it registers on 5. 11. 2026; a payer from then on.
      const choicesOn = (on: string) => baselineVatChoices(tenantId, on, on < '2026-11-05' ? 'NON_PAYER' : 'VAT_PAYER');
      const tax = FinanceTaxRates.of({
        choices: () => Effect.die('The worker asks Tax for the originator only'),
        choicesFor: (_call, on) => Effect.succeed(choicesOn(on)),
      });
      const before = wonOn2Nov;
      const after = { changedAt: '2026-11-10T09:00:00.000Z', opportunityId: '41000000-0000-4000-8000-000000000012' };
      yield* deliver(scope, tax, yield* wonPayload(21, before));
      yield* deliver(scope, tax, yield* wonPayload(21, after));
      const lineVat = (id: string) => {
        const line = invoices().find((invoice) => invoice.opportunityId === id)?.lines?.[0];
        return vatOf(line ?? {});
      };
      expect(lineVat(before.opportunityId)).toEqual({
        vatRate: 0,
        vatTreatment: 'NON_PAYER',
      });
      expect(lineVat(after.opportunityId)).toEqual({
        taxRuleRevisionRef: testTaxRuleRevisionRef(tenantId, CZ_VAT_STANDARD),
        vatClassification: CZ_VAT_STANDARD,
        vatRate: 21,
      });
      expect(lineVat(before.opportunityId)).toEqual(formLineVat(choicesOn('2026-11-02')));
      expect(lineVat(after.opportunityId)).toEqual(formLineVat(choicesOn('2026-11-10')));
    }),
  );
});

const HOUR_MS = 3_600_000;
const wonAtMs = Date.parse(wonOn2Nov.changedAt);

it.layer(NodeCrypto.layer)('A company that has not set up VAT within 72 hours of the win', (suite) => {
  suite.effect('71 hours after the win a company without a declared regime is still retried', () =>
    Effect.gen(function* withinWindow() {
      yield* TestClock.setTime(wonAtMs + 71 * HOUR_MS);
      const { ledger, scope } = makeLedger();
      const tax = taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02', 'NOT_DECLARED'));
      expect(yield* settleFirstAttempt(scope, tax, wonMessage(21))).toEqual({ dead: 0, retried: 1, succeeded: 0 });
      expect((yield* failureOf(deliver(scope, tax, yield* wonPayload(21)))).retryable).toBe(true);
      expect(ledger.saves).toBe(0);
    }),
  );

  suite.effect('72 hours after the win the delivery completes without a draft, naming the company in its log', () =>
    Effect.gen(function* afterWindow() {
      yield* TestClock.setTime(wonAtMs + 72 * HOUR_MS);
      const { invoices, ledger, scope } = makeLedger();
      const tax = taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02', 'NOT_DECLARED'));
      expect(yield* settleFirstAttempt(scope, tax, wonMessage(21))).toEqual({ dead: 0, retried: 0, succeeded: 1 });
      const failure = yield* failureOf(deliver(scope, tax, yield* wonPayload(21)));
      expect(failure).toEqual({
        code: 'VAT_NOT_SET_UP',
        reason: `VAT is not set up for company ${legalEntityId} (no declared regime or no rate) after 72 hours; the won opportunity's invoice was not drafted`,
        retryable: false,
      });
      expect(ledger.saves).toBe(0);
      expect(invoices()).toEqual([]);
    }),
  );

  suite.effect('no published rate 72 hours after the win also completes without a draft, the company named', () =>
    Effect.gen(function* noRateAfterWindow() {
      yield* TestClock.setTime(wonAtMs + 80 * HOUR_MS);
      const { scope } = makeLedger();
      const tax = taxAnswering(() => ({ ...baselineVatChoices(tenantId, '2026-11-02'), rates: [] }));
      expect(yield* settleFirstAttempt(scope, tax, wonMessage(21))).toEqual({ dead: 0, retried: 0, succeeded: 1 });
      const failure = yield* failureOf(deliver(scope, tax, yield* wonPayload(21)));
      expect(failure.reason).toContain('VAT is not set up');
      expect(failure.reason).toContain(legalEntityId);
    }),
  );

  suite.effect('Tax still unavailable 72 hours after the win completes without a draft too', () =>
    Effect.gen(function* taxDownAfterWindow() {
      yield* TestClock.setTime(wonAtMs + 72 * HOUR_MS);
      const { scope } = makeLedger();
      const tax = FinanceTaxRates.of({ choices: down, choicesFor: down });
      expect(yield* settleFirstAttempt(scope, tax, wonMessage(21))).toEqual({ dead: 0, retried: 0, succeeded: 1 });
      const failure = yield* failureOf(deliver(scope, tax, yield* wonPayload(21)));
      expect(failure.code).toBe('TAX_STILL_UNAVAILABLE');
      expect(failure.reason).toContain(legalEntityId);
    }),
  );

  suite.effect('a company that sets VAT up within the window gets its invoice', () =>
    Effect.gen(function* setUpInTime() {
      yield* TestClock.setTime(wonAtMs + 71 * HOUR_MS);
      const { invoices, scope } = makeLedger();
      yield* deliver(
        scope,
        taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02')),
        yield* wonPayload(21),
      );
      expect(invoices().map((invoice) => invoice.opportunityId)).toEqual([opportunityId]);
    }),
  );
});

/** The same opportunity moved from WON to `toStage` at Sales Pipeline revision `revision`. */
const leftWonMessage = (toStage: 'LOST' | 'NEGOTIATION', revision: number) =>
  ({
    ...wonMessage(21),
    changedAt: '2026-11-03T09:00:00.000Z',
    fromStage: 'WON',
    revision,
    toStage,
  }) satisfies typeof OutboxPayloadSchema.Encoded;

/** Tax that must not be asked, counting any call. */
const taxNeverAsked = () => {
  const calls = { count: 0 };
  const refuse = () =>
    Effect.sync(() => {
      calls.count += 1;
    }).pipe(Effect.andThen(Effect.die('Tax must not be asked')));
  return { calls, tax: FinanceTaxRates.of({ choices: refuse, choicesFor: refuse }) };
};

it.layer(NodeCrypto.layer)('A won opportunity that later left WON', (suite) => {
  suite.effect('its older won delivery, still waiting to retry, completes without a draft or a Tax call', () =>
    Effect.gen(function* lostAfterWon() {
      const { invoices, scope } = makeLedger();
      const { calls, tax } = taxNeverAsked();
      // The opportunity is marked LOST at revision 2 while its won message (revision 1) waits for VAT.
      expect(yield* settleFirstAttempt(scope, tax, leftWonMessage('LOST', 2))).toEqual({
        dead: 0,
        retried: 0,
        succeeded: 1,
      });
      expect(yield* settleFirstAttempt(scope, tax, wonMessage(21))).toEqual({ dead: 0, retried: 0, succeeded: 1 });
      const failure = yield* failureOf(deliver(scope, tax, yield* wonPayload(21)));
      expect(failure).toMatchObject({ code: 'OPPORTUNITY_NO_LONGER_WON', retryable: false });
      expect(invoices()).toEqual([]);
      expect(calls.count).toBe(0);
    }),
  );

  suite.effect('won again after a reopen, its newer won message drafts the invoice', () =>
    Effect.gen(function* reopenedThenWon() {
      const { invoices, scope } = makeLedger();
      const tax = taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02'));
      yield* deliver(scope, tax, yield* Schema.decodeEffect(OutboxPayloadSchema)(leftWonMessage('NEGOTIATION', 2)));
      const wonAgain = yield* Schema.decodeEffect(OutboxPayloadSchema)({ ...wonMessage(21), revision: 3 });
      yield* deliver(scope, tax, wonAgain);
      expect(invoices().map((invoice) => invoice.opportunityId)).toEqual([opportunityId]);
    }),
  );

  suite.effect('leaving WON after the invoice was drafted changes nothing', () =>
    Effect.gen(function* lostAfterDraft() {
      const { invoices, ledger, scope } = makeLedger();
      const tax = taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02'));
      yield* deliver(scope, tax, yield* wonPayload(21));
      yield* deliver(scope, tax, yield* Schema.decodeEffect(OutboxPayloadSchema)(leftWonMessage('LOST', 2)));
      expect(ledger.saves).toBe(1);
      expect(invoices().map((invoice) => invoice.opportunityId)).toEqual([opportunityId]);
    }),
  );
});

it.layer(NodeCrypto.layer)("A won opportunity is drafted only in the opportunity's own company", (suite) => {
  suite.effect('another company keeps the only ledger: completed at once, no draft and no Tax call', () =>
    Effect.gen(function* otherCompanyOnly() {
      const other = makeLedger(otherLegalEntityId);
      const own = makeLedger(legalEntityId, false);
      const { calls, tax } = taxNeverAsked();
      expect(yield* settleFirstAttempt([other.scope, own.scope], tax, wonMessage(21))).toEqual({
        dead: 0,
        retried: 0,
        succeeded: 1,
      });
      expect(yield* failureOf(deliver([other.scope, own.scope], tax, yield* wonPayload(21)))).toEqual({
        code: 'OPPORTUNITY_COMPANY_WITHOUT_LEDGER',
        reason: `The won opportunity belongs to company ${legalEntityId}, which keeps no finance ledger; its invoice is never drafted into another company (${otherLegalEntityId} keeps one)`,
        retryable: false,
      });
      expect(other.ledger.saves).toBe(0);
      expect(other.invoices()).toEqual([]);
      expect(calls.count).toBe(0);
    }),
  );

  suite.effect("both keep a ledger: the invoice goes to the opportunity's company, not the first by id", () =>
    Effect.gen(function* bothKeepLedgers() {
      const other = makeLedger(otherLegalEntityId);
      const own = makeLedger(legalEntityId);
      const asked: (string | undefined)[] = [];
      const tax = FinanceTaxRates.of({
        choices: () => Effect.die('The worker asks Tax for the originator only'),
        choicesFor: (call, on) =>
          Effect.sync(() => {
            asked.push(call.subject._tag === 'Originator' ? call.subject.legalEntityId : undefined);
            return baselineVatChoices(tenantId, on);
          }),
      });
      expect(yield* settleFirstAttempt([other.scope, own.scope], tax, wonMessage(21))).toEqual({
        dead: 0,
        retried: 0,
        succeeded: 1,
      });
      expect(other.invoices()).toEqual([]);
      expect(own.invoices().map((invoice) => invoice.opportunityId)).toEqual([opportunityId]);
      expect(new Set(asked)).toEqual(new Set([legalEntityId]));
    }),
  );

  suite.effect('the same company as the ledger: drafted as before', () =>
    Effect.gen(function* sameCompany() {
      const { invoices, scope } = makeLedger();
      const tax = taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02'));
      expect(yield* settleFirstAttempt(scope, tax, wonMessage(21))).toEqual({ dead: 0, retried: 0, succeeded: 1 });
      expect(invoices().map((invoice) => invoice.opportunityId)).toEqual([opportunityId]);
    }),
  );
});

/** The registered worker (what Core's Outbox runs) over one won message, with every log line it writes. */
const runRegistered = (
  scope: OutboxWorkerLegalEntityScope | readonly OutboxWorkerLegalEntityScope[],
  tax: FinanceTaxRates['Service'],
  payload: typeof OutboxPayloadSchema.Type,
  context: OutboxWorkerHandlerContext = won,
) => {
  const entries: string[] = [];
  const logged = Logger.layer([
    Logger.make((options) => {
      entries.push(JSON.stringify(Logger.formatStructured.log(options)));
    }),
  ]);
  return getOutboxWorkerHandler(draftInvoiceFromWonOpportunityWorker)(payload, context).pipe(
    Effect.provideService(FinanceTaxRates, tax),
    Effect.provideService(OpportunityInvoiceLedger, opportunityInvoiceLedgerLive),
    Effect.provideService(OutboxWorkerLegalEntityScopeFanout, {
      forEachScope: (_claim, observe) =>
        Effect.forEach(Array.isArray(scope) ? scope : [scope], observe, { discard: true }),
    }),
    Effect.exit,
    Effect.provide(logged),
    Effect.map((exit) => ({ entries, succeeded: Exit.isSuccess(exit) })),
  );
};

const outcome = (entries: readonly string[]) =>
  entries.map((entry) => {
    const parsed = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ level: Schema.String, message: Schema.Array(Schema.Json) })),
    )(entry);
    return { level: parsed.level, message: parsed.message };
  });
const fields = (code: string, company: string | null = legalEntityId) => [
  "Won opportunity's invoice not drafted",
  { code, company, opportunityId, tenantId },
];

it.layer(NodeCrypto.layer)('Business outcomes complete the delivery; only system failures are retried', (suite) => {
  suite.effect('each business outcome completes with exactly one line: its code, tenant, company and opportunity', () =>
    Effect.gen(function* settledOutcomes() {
      yield* TestClock.setTime(wonAtMs + 72 * HOUR_MS);
      const notDeclared = taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02', 'NOT_DECLARED'));
      const cases = [
        ['VAT_NOT_SET_UP', 'WARN', makeLedger().scope, notDeclared, yield* wonPayload(21)],
        [
          'TAX_STILL_UNAVAILABLE',
          'WARN',
          makeLedger().scope,
          FinanceTaxRates.of({ choices: down, choicesFor: down }),
          yield* wonPayload(21),
        ],
        [
          'FINANCE_REJECTED',
          'WARN',
          makeLedger().scope,
          taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02')),
          yield* wonPayload(10),
        ],
        [
          'OPPORTUNITY_COMPANY_WITHOUT_LEDGER',
          'WARN',
          [makeLedger(otherLegalEntityId).scope, makeLedger(legalEntityId, false).scope],
          taxNeverAsked().tax,
          yield* wonPayload(21),
        ],
      ] as const;
      for (const [code, level, scope, tax, payload] of cases) {
        const run = yield* runRegistered(scope, tax, payload);
        expect([code, run.succeeded, outcome(run.entries)]).toEqual([code, true, [{ level, message: fields(code) }]]);
      }
      // Lost after it was won: simply nothing to draft, logged as information.
      const lost = makeLedger();
      yield* deliver(
        lost.scope,
        taxNeverAsked().tax,
        yield* Schema.decodeEffect(OutboxPayloadSchema)(leftWonMessage('LOST', 2)),
      );
      const noLongerWon = yield* runRegistered(lost.scope, taxNeverAsked().tax, yield* wonPayload(21));
      expect([noLongerWon.succeeded, outcome(noLongerWon.entries)]).toEqual([
        true,
        [{ level: 'INFO', message: fields('OPPORTUNITY_NO_LONGER_WON') }],
      ]);
      // A stage change that names no company: nothing to draft there.
      const { originatorLegalEntityId: _company, ...withoutCompany } = won;
      void _company;
      const unnamed = yield* runRegistered(
        makeLedger().scope,
        taxNeverAsked().tax,
        yield* wonPayload(21),
        attestOutboxWorkerHandlerContext(withoutCompany),
      );
      expect([unnamed.succeeded, outcome(unnamed.entries)]).toEqual([
        true,
        [{ level: 'WARN', message: fields('OPPORTUNITY_WITHOUT_COMPANY', null) }],
      ]);
    }),
  );

  suite.effect('a system failure, and VAT not ready within the window, still fail and are retried', () =>
    Effect.gen(function* systemFailures() {
      yield* TestClock.setTime(wonAtMs + 71 * HOUR_MS);
      const notReady = yield* runRegistered(
        makeLedger().scope,
        taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02', 'NOT_DECLARED')),
        yield* wonPayload(21),
      );
      expect([notReady.succeeded, notReady.entries]).toEqual([false, []]);
      const noLedgerAnywhere = yield* runRegistered(
        makeLedger(legalEntityId, false).scope,
        taxNeverAsked().tax,
        yield* wonPayload(21),
      );
      expect([noLedgerAnywhere.succeeded, noLedgerAnywhere.entries]).toEqual([false, []]);
      const foreign = yield* runRegistered(
        makeLedger().scope,
        taxNeverAsked().tax,
        yield* wonPayload(21),
        attestOutboxWorkerHandlerContext({ ...won, topic: 'another.topic' }),
      );
      expect(foreign.succeeded).toBe(false);
    }),
  );
});
