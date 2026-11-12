import { NodeCrypto } from '@effect/platform-node';
import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime';
import { OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/sales-pipeline/outbox/opportunity-stage-changed';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FinanceReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import { FinanceStateSchema } from '../../shared/apis/records.ts';
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
import { baselineVatChoices } from '../support/finance-tax-rates.ts';
import { outboxFailureStatus } from '../../../../packages/core-runtime/src/outbox/repository.ts';
import type { OutboxClaim, OutboxRepositoryService } from '../../../../packages/core-runtime/src/outbox/repository.ts';
import { makeOutboxRuntime } from '../../../../packages/core-runtime/src/outbox/runtime.ts';

const tenantId = '21000000-0000-4000-8000-000000000001';
const legalEntityId = '31000000-0000-4000-8000-000000000001';
const opportunityId = '41000000-0000-4000-8000-000000000002';

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
  producerModuleKey: outboxProducerModuleKey,
  tenantId,
  tenantSequenceNo: 1n,
  topic: outboxTopic,
  workerKey: draftInvoiceFromWonOpportunityWorker.descriptor.workerKey,
});

const wonMessage = (vatRate: number) =>
  ({
    amountMinor: 100_000,
    changedAt: '2026-11-02T09:00:00.000Z',
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
    opportunityId,
    partyId: '41000000-0000-4000-8000-000000000003',
    revision: 1,
    toStage: 'WON',
  }) satisfies typeof OutboxPayloadSchema.Encoded;

const wonPayload = (vatRate: number) => Schema.decodeEffect(OutboxPayloadSchema)(wonMessage(vatRate));

/** One company's finance ledger, saved with a revision check exactly like the worker routines. */
const SaveParametersSchema = Schema.Tuple([Schema.Int, Schema.Unknown]);

/** The stored ledger row: its revision, how often a delivery saved it, and its encoded finance state. */
interface StoredLedger {
  revision: number;
  saves: number;
  state: unknown;
}

const makeLedger = () => {
  const ledger: StoredLedger = {
    revision: 0,
    saves: 0,
    state: { financialPlanEntries: [], invoices: [] },
  };
  const scope: OutboxWorkerLegalEntityScope = {
    completionPublisher: { publish: () => Effect.die('Invoice drafting must not publish completion evidence') },
    legalEntityId,
    routineInvoker: {
      invoke: (routine, parameters) => {
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
  scope: OutboxWorkerLegalEntityScope,
  tax: FinanceTaxRates['Service'],
  payload: typeof OutboxPayloadSchema.Type,
) =>
  handleDraftInvoiceFromWonOpportunity(payload, won).pipe(
    Effect.provideService(FinanceTaxRates, tax),
    Effect.provideService(OpportunityInvoiceLedger, opportunityInvoiceLedgerLive),
    Effect.provideService(OutboxWorkerLegalEntityScopeFanout, {
      forEachScope: (_claim, observe) => observe(scope),
    }),
  );

/** The first claim of the won message, as Core's Outbox hands it to this worker. */
const firstClaim = (vatRate: number): OutboxClaim => ({
  attemptId: '51000000-0000-4000-8000-000000000006',
  attemptNumber: 1,
  claimId: won.claimId,
  consumerModuleKey: 'finance.billing',
  deliveryId: won.deliveryId,
  domainEventId: won.domainEventId,
  messageId: won.messageId,
  originatorInvocationId: '51000000-0000-4000-8000-000000000005',
  payloadJson: wonMessage(vatRate),
  producerModuleKey: outboxProducerModuleKey,
  retryPolicy: draftInvoiceFromWonOpportunityWorker.descriptor.retryPolicy,
  tenantId,
  tenantSequenceNo: 1n,
  topic: outboxTopic,
  workerKey: draftInvoiceFromWonOpportunityWorker.descriptor.workerKey,
});

/**
 * One Outbox cycle of Core's runtime over the first claim of the won message: the real worker registration, settled
 * by the Outbox repository's own rule for where a failed attempt goes (dead or pending for a retry).
 */
const settleFirstAttempt = (scope: OutboxWorkerLegalEntityScope, tax: FinanceTaxRates['Service'], vatRate: number) => {
  const claims = [firstClaim(vatRate)];
  const outbox: OutboxRepositoryService = {
    claimNext: () => Effect.sync(() => Option.fromNullishOr(claims.shift())),
    complete: () => Effect.void,
    fail: (claim, _message, _now, disposition) => Effect.succeed(outboxFailureStatus(claim, disposition ?? 'retry')),
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
        forEachScope: (_claim, observe) => observe(scope),
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

/** Core keeps the delivery pending for weeks, retrying at least daily, instead of giving up within seconds. */
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
  suite.effect('a company without a declared VAT regime is retried as not ready, never refused or finished', () =>
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
  suite.effect('a genuinely invalid line ends its delivery as dead on the first attempt', () =>
    Effect.gen(function* invalidLineDead() {
      const { ledger, scope } = makeLedger();
      const tax = taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02'));
      expect(yield* settleFirstAttempt(scope, tax, 10)).toEqual({ dead: 1, retried: 0, succeeded: 0 });
      expect(ledger.saves).toBe(0);
    }),
  );

  suite.effect('a company without a declared VAT regime is retried', () =>
    Effect.gen(function* notReadyRetried() {
      const { scope } = makeLedger();
      const tax = taxAnswering(() => baselineVatChoices(tenantId, '2026-11-02', 'NOT_DECLARED'));
      expect(yield* settleFirstAttempt(scope, tax, 21)).toEqual({ dead: 0, retried: 1, succeeded: 0 });
    }),
  );

  suite.effect('no published rate for the classification is retried', () =>
    Effect.gen(function* noRateRetried() {
      const { scope } = makeLedger();
      const tax = taxAnswering(() => ({ ...baselineVatChoices(tenantId, '2026-11-02'), rates: [] }));
      expect(yield* settleFirstAttempt(scope, tax, 21)).toEqual({ dead: 0, retried: 1, succeeded: 0 });
    }),
  );

  suite.effect('Tax being unavailable is retried', () =>
    Effect.gen(function* taxDownRetried() {
      const { scope } = makeLedger();
      const tax = FinanceTaxRates.of({ choices: down, choicesFor: down });
      expect(yield* settleFirstAttempt(scope, tax, 21)).toEqual({ dead: 0, retried: 1, succeeded: 0 });
    }),
  );
});
