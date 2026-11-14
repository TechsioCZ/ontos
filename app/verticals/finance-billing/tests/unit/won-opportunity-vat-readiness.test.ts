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
import { Cause, DateTime, Duration, Effect, Exit, Fiber, Logger, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { FinanceReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import { FinanceStateSchema } from '../../shared/apis/records.ts';
import type { InvoiceLine } from '../../shared/apis/records.ts';
import type { VatChoices } from '../../shared/apis/vat-choices.ts';
import { FinanceTaxRates, TAX_NOT_INSTALLED_REASON, taxUnavailableReasonOf } from '../../src/integrations/tax-rates.ts';
import { GATEWAY_MODULE_NOT_INSTALLED_TYPE } from '@app/shared-contracts';
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
  /** Each won opportunity's recorded wait for VAT: when Tax first said "not ready". */
  const awaiting = () =>
    (Schema.decodeUnknownSync(FinanceStateSchema)(ledger.state).opportunitiesAwaitingVat ?? []).map((record) => [
      record.opportunityId,
      DateTime.formatIso(record.firstNotReadyAt),
    ]);
  return { awaiting, invoices, ledger, scope };
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
  context: OutboxWorkerHandlerContext = won,
) =>
  handleDraftInvoiceFromWonOpportunity(payload, context).pipe(
    Effect.provideService(FinanceTaxRates, tax),
    Effect.provideService(OpportunityInvoiceLedger, opportunityInvoiceLedgerLive),
    Effect.provideService(OutboxWorkerLegalEntityScopeFanout, {
      forEachScope: (_claim, observe) =>
        Effect.forEach(Array.isArray(scope) ? scope : [scope], observe, { discard: true }),
    }),
  );

/** The first claim of the won message, as Core's Outbox hands it to this worker. */
const firstClaim = (message: typeof OutboxPayloadSchema.Encoded, attemptNumber = 1): OutboxClaim => ({
  attemptId: '51000000-0000-4000-8000-000000000006',
  attemptNumber,
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
  attemptNumber = 1,
) => {
  const claims = [firstClaim(message, attemptNumber)];
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
 * a not-ready one the worker itself ends 72 hours after Tax first said so (see the 72-hour suite below).
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
        // The one save is the recorded wait: when Tax first said the company is not ready.
        expect(ledger.saves).toBe(1);
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
      // Only the first "not ready" is recorded; a later one leaves the record as it is.
      expect(ledger.saves).toBe(1);
      choices = baselineVatChoices(tenantId, '2026-11-02');
      yield* deliver(scope, tax, payload);
      // A second redelivery (lease lost after the save) converges on the same invoice.
      yield* deliver(scope, tax, payload);
      expect(ledger.saves).toBe(2);
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

/** The registered worker (what Core's Outbox runs) over one won message, with every log line it writes. */
const runRegistered = (
  scope: OutboxWorkerLegalEntityScope | readonly OutboxWorkerLegalEntityScope[],
  tax: FinanceTaxRates['Service'],
  payload: typeof OutboxPayloadSchema.Type,
  context: OutboxWorkerHandlerContext = won,
  ledger: OpportunityInvoiceLedger['Service'] = opportunityInvoiceLedgerLive,
) => {
  const entries: string[] = [];
  const logged = Logger.layer([
    Logger.make((options) => {
      entries.push(JSON.stringify(Logger.formatStructured.log(options)));
    }),
  ]);
  return getOutboxWorkerHandler(draftInvoiceFromWonOpportunityWorker)(payload, context).pipe(
    Effect.provideService(FinanceTaxRates, tax),
    Effect.provideService(OpportunityInvoiceLedger, ledger),
    Effect.provideService(OutboxWorkerLegalEntityScopeFanout, {
      forEachScope: (_claim, observe) =>
        Effect.forEach(Array.isArray(scope) ? scope : [scope], observe, { discard: true }),
    }),
    Effect.exit,
    Effect.provide(logged),
    Effect.map((exit) => ({
      entries,
      failure: Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
      succeeded: Exit.isSuccess(exit),
    })),
  );
};

/** Any attempt number: the wait is real time recorded in the ledger, never derived from how many attempts there were. */
const attempt = (attemptNumber: number): OutboxWorkerHandlerContext =>
  attestOutboxWorkerHandlerContext({ ...won, attemptNumber });
const notDeclared = () => taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02', 'NOT_DECLARED'));
/** Tax not installed for the Tenant: the Shell's own answer, not an outage. */
const notInstalled = () =>
  FinanceTaxRates.of({
    choices: () => Effect.die('The worker asks Tax for the originator only'),
    choicesFor: () =>
      Effect.fail(
        new FinanceReferenceUnavailable({
          code: 'finance_reference_unavailable',
          reason: TAX_NOT_INSTALLED_REASON,
        }),
      ),
  });
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** When Tax first says "not ready" in these tests. */
const firstNotReadyMs = Date.parse('2026-11-02T10:00:00.000Z');

it.layer(NodeCrypto.layer)(
  'A won opportunity waits 72 hours after Tax first said its company is not ready',
  (suite) => {
    suite.effect(
      '19 lease re-claims in ten minutes, then "not declared": still waiting, from the recorded first answer',
      () =>
        Effect.gen(function* quickReclaims() {
          const { awaiting, scope } = makeLedger();
          yield* TestClock.setTime(firstNotReadyMs);
          expect((yield* failureOf(deliver(scope, notDeclared(), yield* wonPayload(21), attempt(1)))).code).toBe(
            'VAT_NOT_READY',
          );
          for (let reclaim = 2; reclaim <= 20; reclaim += 1) {
            yield* TestClock.setTime(firstNotReadyMs + Math.round(((reclaim - 1) * 10 * MINUTE_MS) / 19));
            const failure = yield* failureOf(deliver(scope, notDeclared(), yield* wonPayload(21), attempt(reclaim)));
            expect([reclaim, failure.code]).toEqual([reclaim, 'VAT_NOT_READY']);
          }
          expect(awaiting()).toEqual([[opportunityId, '2026-11-02T10:00:00.000Z']]);
          expect(yield* settleFirstAttempt(scope, notDeclared(), wonMessage(21), 20)).toEqual({
            dead: 0,
            retried: 1,
            succeeded: 0,
          });
        }),
    );

    suite.effect(
      '72 hours after the first "not ready" the delivery completes without a draft, and its record is gone',
      () =>
        Effect.gen(function* afterWindow() {
          const { awaiting, invoices, scope } = makeLedger();
          yield* TestClock.setTime(firstNotReadyMs);
          yield* failureOf(deliver(scope, notInstalled(), yield* wonPayload(21)));
          yield* TestClock.setTime(firstNotReadyMs + 71 * HOUR_MS);
          expect((yield* failureOf(deliver(scope, notDeclared(), yield* wonPayload(21)))).code).toBe('VAT_NOT_READY');
          yield* TestClock.setTime(firstNotReadyMs + 72 * HOUR_MS);
          expect(yield* settleFirstAttempt(scope, notDeclared(), wonMessage(21), 2)).toEqual({
            dead: 0,
            retried: 0,
            succeeded: 1,
          });
          expect([invoices(), awaiting()]).toEqual([[], []]);
        }),
    );

    suite.effect('the company sets VAT up in between: drafted exactly once, and the record is gone', () =>
      Effect.gen(function* setUpInTime() {
        const { awaiting, invoices, ledger, scope } = makeLedger();
        yield* TestClock.setTime(firstNotReadyMs);
        yield* failureOf(deliver(scope, notDeclared(), yield* wonPayload(21)));
        expect(awaiting()).toEqual([[opportunityId, '2026-11-02T10:00:00.000Z']]);
        yield* TestClock.setTime(firstNotReadyMs + 30 * HOUR_MS);
        const declared = taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02'));
        yield* deliver(scope, declared, yield* wonPayload(21));
        yield* deliver(scope, declared, yield* wonPayload(21));
        expect([invoices().map((invoice) => invoice.opportunityId), awaiting(), ledger.saves]).toEqual([
          [opportunityId],
          [],
          2,
        ]);
      }),
    );

    suite.effect('a message won ten days ago, first seen now, gets its whole 72 hours', () =>
      Effect.gen(function* oldMessage() {
        const { awaiting, scope } = makeLedger();
        const tenDaysAgo: WonOn = { changedAt: '2026-10-23T10:00:00.000Z', opportunityId };
        yield* TestClock.setTime(firstNotReadyMs);
        expect((yield* failureOf(deliver(scope, notDeclared(), yield* wonPayload(21, tenDaysAgo)))).code).toBe(
          'VAT_NOT_READY',
        );
        yield* TestClock.setTime(firstNotReadyMs + 71 * HOUR_MS);
        expect((yield* failureOf(deliver(scope, notDeclared(), yield* wonPayload(21, tenDaysAgo)))).code).toBe(
          'VAT_NOT_READY',
        );
        expect(awaiting()).toEqual([[opportunityId, '2026-11-02T10:00:00.000Z']]);
      }),
    );

    suite.effect('Tax unreachable, suspended or quarantined is never ended by the wait: it keeps retrying', () =>
      Effect.gen(function* taxDown() {
        const { awaiting, scope } = makeLedger();
        const tax = FinanceTaxRates.of({ choices: down, choicesFor: down });
        yield* TestClock.setTime(firstNotReadyMs + 100 * HOUR_MS);
        expect(yield* settleFirstAttempt(scope, tax, wonMessage(21), 60)).toEqual({
          dead: 0,
          retried: 1,
          succeeded: 0,
        });
        expect((yield* failureOf(deliver(scope, tax, yield* wonPayload(21), attempt(60)))).code).toBe(
          'TAX_UNAVAILABLE',
        );
        expect(awaiting()).toEqual([]);
      }),
    );

    suite.effect(
      'a backlog after a deploy: won ten days ago, Tax down at the first attempt, retried, then drafted',
      () =>
        Effect.gen(function* backlogAfterDeploy() {
          const { invoices, scope } = makeLedger();
          const tenDaysAgo: WonOn = { changedAt: '2026-10-23T09:00:00.000Z', opportunityId };
          yield* TestClock.setTime(Date.parse('2026-11-02T09:00:00.000Z'));
          expect(
            yield* settleFirstAttempt(
              scope,
              FinanceTaxRates.of({ choices: down, choicesFor: down }),
              wonMessage(21, tenDaysAgo),
            ),
          ).toEqual({ dead: 0, retried: 1, succeeded: 0 });
          yield* deliver(
            scope,
            taxAnswering(() => baselineVatChoices(tenantId, '2026-10-23')),
            yield* wonPayload(21, tenDaysAgo),
          );
          expect(invoices().map((invoice) => invoice.opportunityId)).toEqual([opportunityId]);
        }),
    );

    suite.effect(
      'an attempt slower than its deadline ends as Tax unavailable, retried, well before its lease ends',
      () =>
        Effect.gen(function* slowAttempt() {
          const { scope } = makeLedger();
          const slow = FinanceTaxRates.of({
            choices: () => Effect.die('The worker asks Tax for the originator only'),
            choicesFor: () =>
              Effect.sleep(Duration.seconds(45)).pipe(Effect.as(baselineVatChoices(tenantId, '2026-11-02'))),
          });
          const running = yield* runRegistered(scope, slow, yield* wonPayload(21)).pipe(Effect.forkChild);
          yield* TestClock.adjust(Duration.seconds(31));
          const run = yield* Fiber.join(running);
          expect([run.succeeded, run.entries]).toEqual([false, []]);
          expect(run.failure).toMatchObject({
            code: 'TAX_UNAVAILABLE',
            reason: 'The attempt did not finish within its 30s deadline (lease 60 s); retried after the back-off',
            retryable: true,
          });
          expect(draftInvoiceFromWonOpportunityWorker.descriptor.leaseDurationMs).toBe(60_000);
        }),
    );
  },
);

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
  suite.effect('won, not ready, lost, won again five days later and still not ready: a fresh 72-hour wait', () =>
    Effect.gen(function* wonAgainAfterWait() {
      const { awaiting, scope } = makeLedger();
      yield* TestClock.setTime(firstNotReadyMs);
      expect((yield* failureOf(deliver(scope, notDeclared(), yield* wonPayload(21)))).code).toBe('VAT_NOT_READY');
      expect(awaiting()).toEqual([[opportunityId, '2026-11-02T10:00:00.000Z']]);
      // Lost at revision 2: its wait ends with it.
      yield* deliver(scope, notDeclared(), yield* Schema.decodeEffect(OutboxPayloadSchema)(leftWonMessage('LOST', 2)));
      expect(awaiting()).toEqual([]);
      // Won again at revision 3, five days after the first "not ready": a new wait starts now, not one long over.
      yield* TestClock.setTime(firstNotReadyMs + 5 * 24 * HOUR_MS);
      const wonAgain = yield* Schema.decodeEffect(OutboxPayloadSchema)({ ...wonMessage(21), revision: 3 });
      expect((yield* failureOf(deliver(scope, notDeclared(), wonAgain))).code).toBe('VAT_NOT_READY');
      expect(awaiting()).toEqual([[opportunityId, '2026-11-07T10:00:00.000Z']]);
      yield* TestClock.setTime(firstNotReadyMs + (5 * 24 + 71) * HOUR_MS);
      expect((yield* failureOf(deliver(scope, notDeclared(), wonAgain))).code).toBe('VAT_NOT_READY');
    }),
  );

  suite.effect('an older won message settled as no longer won, or lines refused, ends a wait it left behind', () =>
    Effect.gen(function* settledEndsWait() {
      // The wait of revision 1, recorded before the move out of WON was known to this ledger.
      const { awaiting, scope } = makeLedger();
      yield* TestClock.setTime(firstNotReadyMs);
      yield* failureOf(deliver(scope, notDeclared(), yield* wonPayload(21)));
      const lostAt = yield* Schema.decodeUnknownEffect(FinanceStateSchema)({
        financialPlanEntries: [],
        invoices: [],
        opportunitiesAwaitingVat: [{ firstNotReadyAt: '2026-11-02T10:00:00.000Z', opportunityId }],
        opportunitiesLeftWon: [{ leftAt: '2026-11-02T11:00:00.000Z', opportunityId, revision: 2 }],
      });
      const stale = makeLedger();
      stale.ledger.state = yield* Schema.encodeEffect(FinanceStateSchema)(lostAt);
      expect((yield* failureOf(deliver(stale.scope, notDeclared(), yield* wonPayload(21)))).code).toBe(
        'OPPORTUNITY_NO_LONGER_WON',
      );
      expect(stale.awaiting()).toEqual([]);
      // Lines Finance refuses for good (10 % names no classification) end the wait too.
      expect(awaiting()).toEqual([[opportunityId, '2026-11-02T10:00:00.000Z']]);
      const declared = taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02'));
      expect((yield* failureOf(deliver(scope, declared, yield* wonPayload(10)))).code).toBe('FINANCE_REJECTED');
      expect(awaiting()).toEqual([]);
    }),
  );

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
            asked.push(Predicate.isTagged(call.subject, 'Originator') ? call.subject.legalEntityId : undefined);
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

const outcome = (entries: readonly string[]) =>
  entries.map((entry) => {
    const parsed = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ level: Schema.String, message: Schema.Array(Schema.Json) })),
    )(entry);
    return { level: parsed.level, message: parsed.message };
  });
const fields = (code: string, reason: string, company: string | null = legalEntityId) => [
  "Won opportunity's invoice not drafted",
  { code, company, opportunityId, reason, tenantId },
];

it.layer(NodeCrypto.layer)('Business outcomes complete the delivery; only system failures are retried', (suite) => {
  suite.effect('each business outcome completes with exactly one line: its code, tenant, company and opportunity', () =>
    Effect.gen(function* settledOutcomes() {
      // VAT not set up: Tax first said "not ready" 72 hours ago, and still says so.
      const waited = makeLedger();
      yield* TestClock.setTime(firstNotReadyMs);
      yield* failureOf(deliver(waited.scope, notDeclared(), yield* wonPayload(21)));
      yield* TestClock.setTime(firstNotReadyMs + 72 * HOUR_MS);
      const cases = [
        ['VAT_NOT_SET_UP', 'WARN', waited.scope, notDeclared(), yield* wonPayload(21)],
        [
          'FINANCE_LEDGER_MISSING',
          'WARN',
          makeLedger(legalEntityId, false).scope,
          taxNeverAsked().tax,
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
          // A free-text line is not in the message, so its lines bill less than the won amount: nothing is drafted.
          'OPPORTUNITY_LINES_INCOMPLETE',
          'WARN',
          makeLedger().scope,
          taxNeverAsked().tax,
          { ...(yield* wonPayload(21)), amountMinor: 150_000 },
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
        expect([code, run.succeeded, outcome(run.entries).map(({ level: logged }) => logged)]).toEqual([
          code,
          true,
          [level],
        ]);
        expect(outcome(run.entries)[0]?.message[1]).toMatchObject({
          code,
          company: legalEntityId,
          opportunityId,
          tenantId,
        });
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
        [
          {
            level: 'INFO',
            message: fields(
              'OPPORTUNITY_NO_LONGER_WON',
              'The opportunity left WON at Sales Pipeline revision 2, after this won message (revision 1); its invoice was not drafted',
            ),
          },
        ],
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
        [
          {
            level: 'WARN',
            message: fields(
              'OPPORTUNITY_WITHOUT_COMPANY',
              'The stage change names no company of the opportunity',
              null,
            ),
          },
        ],
      ]);
    }),
  );

  suite.effect('a system failure, and VAT not ready within the window, still fail and are retried', () =>
    Effect.gen(function* systemFailures() {
      const notReady = yield* runRegistered(makeLedger().scope, notDeclared(), yield* wonPayload(21));
      expect([notReady.succeeded, notReady.entries]).toEqual([false, []]);
      // A ledger that exists and still yields no invoice is a failure, not an outcome of selling.
      const draftsNothing = yield* runRegistered(makeLedger().scope, taxNeverAsked().tax, yield* wonPayload(21), won, {
        draft: () => Effect.succeed(Option.none()),
        endVatWait: () => Effect.die('Nothing settles without a draft here'),
        holds: () => Effect.succeed(true),
        recordLeftWon: () => Effect.succeed(true),
        vatNotReady: () => Effect.die('Tax is never asked here'),
      });
      // The wait cannot be recorded (the ledger save fails): retried, never completed.
      const unrecorded = yield* runRegistered(makeLedger().scope, notDeclared(), yield* wonPayload(21), won, {
        ...opportunityInvoiceLedgerLive,
        vatNotReady: () =>
          Effect.fail(
            new FinanceReferenceUnavailable({ code: 'finance_reference_unavailable', reason: 'save failed' }),
          ),
      });
      expect([unrecorded.succeeded, unrecorded.entries]).toEqual([false, []]);
      expect([draftsNothing.succeeded, draftsNothing.entries]).toEqual([false, []]);
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

/** The Shell's 403 problem for a refused delegated call to Tax. */
const forbiddenProblem = (type: string, reason: string) => ({
  _tag: 'GatewayForbiddenProblem',
  reason,
  status: 403,
  type,
});

it("only the Shell's not-installed answer reads as not installed; Tax suspended or quarantined is an outage", () => {
  expect(
    taxUnavailableReasonOf(forbiddenProblem(GATEWAY_MODULE_NOT_INSTALLED_TYPE, 'audience_module_not_installed')),
  ).toBe(TAX_NOT_INSTALLED_REASON);
  expect(
    taxUnavailableReasonOf(
      forbiddenProblem('https://ontos.dev/problems/gateway-forbidden', 'audience_module_not_active'),
    ),
  ).not.toBe(TAX_NOT_INSTALLED_REASON);
});

/** The Shell's refusal for each state Tax can be in for the tenant, as the issuer answers it. */
const shellRefusalFor = (state: 'absent' | 'archived' | 'inactive' | 'quarantined' | 'suspended') =>
  state === 'suspended' || state === 'quarantined'
    ? forbiddenProblem('https://ontos.dev/problems/gateway-forbidden', 'audience_module_not_active')
    : forbiddenProblem(GATEWAY_MODULE_NOT_INSTALLED_TYPE, 'audience_module_not_installed');
/** Tax refused by the Shell in that state, as Finance's Tax client reports it. */
const taxIn = (state: Parameters<typeof shellRefusalFor>[0]) => {
  const refused = () =>
    Effect.fail(
      new FinanceReferenceUnavailable({
        code: 'finance_reference_unavailable',
        reason: taxUnavailableReasonOf(shellRefusalFor(state)),
      }),
    );
  return FinanceTaxRates.of({ choices: refused, choicesFor: refused });
};

it.layer(NodeCrypto.layer)('Tax in each state the tenant can hold it in', (suite) => {
  for (const state of ['absent', 'inactive', 'archived'] as const) {
    suite.effect(`${state}: lasting, so not ready; the delivery completes 72 hours after the first answer`, () =>
      Effect.gen(function* lastingState() {
        const { awaiting, scope } = makeLedger();
        yield* TestClock.setTime(firstNotReadyMs);
        expect((yield* failureOf(deliver(scope, taxIn(state), yield* wonPayload(21)))).code).toBe('VAT_NOT_READY');
        yield* TestClock.setTime(firstNotReadyMs + 72 * HOUR_MS);
        expect(yield* settleFirstAttempt(scope, taxIn(state), wonMessage(21), 2)).toEqual({
          dead: 0,
          retried: 0,
          succeeded: 1,
        });
        expect(awaiting()).toEqual([]);
      }),
    );
  }
  for (const state of ['suspended', 'quarantined'] as const) {
    suite.effect(`${state}: temporary, so an outage; retried however long it lasts, never completed`, () =>
      Effect.gen(function* temporaryState() {
        const { awaiting, scope } = makeLedger();
        yield* TestClock.setTime(firstNotReadyMs + 100 * HOUR_MS);
        expect((yield* failureOf(deliver(scope, taxIn(state), yield* wonPayload(21)))).code).toBe('TAX_UNAVAILABLE');
        expect(yield* settleFirstAttempt(scope, taxIn(state), wonMessage(21), 60)).toEqual({
          dead: 0,
          retried: 1,
          succeeded: 0,
        });
        expect(awaiting()).toEqual([]);
      }),
    );
  }
});
