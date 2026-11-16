import { NodeCrypto } from '@effect/platform-node';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Crypto, Effect, Option, PlatformError, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  FinancePersistenceUnavailable,
  FinanceReferenceUnavailable,
  FinanceRejected,
} from '../../shared/actions/apply-command.ts';
import type { CreateInvoiceFromOpportunityCommand } from '../../shared/outbox-consumers/opportunity-won-invoice.ts';
import { FinanceTaxRates } from '../../src/integrations/tax-rates.ts';
import {
  draftOpportunityInvoiceInScope,
  readFinanceStateForWorkerRoutine,
  saveFinanceStateForWorkerRoutine,
} from '../../src/workers/opportunity-invoice-ledger.ts';
import { baselineVatChoices, standardLineVat } from '../support/finance-tax-rates.ts';

/** The sales-pipeline invocation that marked the opportunity won. */
const originator = {
  actionInvocationId: 'd0000000-0000-4000-8000-000000000001',
  compositionRevision: 'a'.repeat(64),
};

/** The Sales Pipeline revision of the won message. */
const wonRevision = 1;

const command: CreateInvoiceFromOpportunityCommand = {
  _tag: 'CreateInvoiceFromOpportunity',
  issueDate: '2026-10-07',
  // As opportunityWonInvoiceCommand maps a 21 % line: the standard classification.
  lines: [
    {
      description: 'Roční servis',
      quantity: 2,
      unitPriceMinor: 100_000,
      vatClassification: 'cz.vat.standard',
      vatRate: 21,
    },
  ],
  opportunityId: 'c0000000-0000-4000-8000-000000000001',
  partyId: 'a0000000-0000-4000-8000-000000000012',
};
const saved: unknown[] = [];
const scope: OutboxWorkerLegalEntityScope = {
  completionPublisher: { publish: () => Effect.die('Invoice drafting must not publish completion evidence') },
  legalEntityId: 'a0000000-0000-4000-8000-000000000002',
  routineInvoker: {
    invoke: (routine, parameters) => {
      if (routine.routineKey === saveFinanceStateForWorkerRoutine.routineKey) {
        saved.push(parameters);
        return Effect.succeed(Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([{ revision: 1 }]));
      }
      expect(routine).toBe(readFinanceStateForWorkerRoutine);
      return Effect.succeed(
        Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([
          { revision: 0, state: { financialPlanEntries: [], invoices: [] } },
        ]),
      );
    },
  },
  tenantId: 'a0000000-0000-4000-8000-000000000001',
};

/** Tax cannot answer for the originator (unreachable, not installed or refusing). */
const down = () =>
  Effect.fail(new FinanceReferenceUnavailable({ code: 'finance_reference_unavailable', reason: 'down' }));
const taxUnavailable = FinanceTaxRates.of({ choices: down, choicesFor: down });
/** Tax answering with the baseline. */
const taxBaseline = FinanceTaxRates.of({
  choices: (taxScope, on) => Effect.succeed(baselineVatChoices(taxScope.tenantId, on)),
  choicesFor: (_call, on) => Effect.succeed(baselineVatChoices(scope.tenantId, on)),
});

it.layer(NodeCrypto.layer)('Opportunity invoice ledger cryptography', (suite) => {
  suite.effect('maps native UUID failure to a typed Finance failure before saving state', () =>
    Effect.gen(function* uuidFailure() {
      const crypto = yield* Crypto.Crypto;
      const cause = PlatformError.systemError({ _tag: 'Unknown', method: 'randomUUIDv4', module: 'Crypto' });
      const failure = yield* draftOpportunityInvoiceInScope(scope, command, originator, wonRevision).pipe(
        Effect.provideService(FinanceTaxRates, taxBaseline),
        Effect.provideService(Crypto.Crypto, Crypto.Crypto.of({ ...crypto, randomUUIDv4: () => Effect.fail(cause) })),
        Effect.flip,
      );
      expect(Schema.is(FinancePersistenceUnavailable)(failure)).toBe(true);
      expect(failure).toMatchObject({
        code: 'finance_persistence_unavailable',
        reason: 'Finance persistence is temporarily unavailable',
      });
    }),
  );
});

it.layer(NodeCrypto.layer)('Opportunity invoice VAT from Tax', (suite) => {
  suite.effect('stores each line with the rate and the Tax rule revision Tax gives on the issue date', () =>
    Effect.gen(function* priced() {
      saved.length = 0;
      const invoice = yield* draftOpportunityInvoiceInScope(scope, command, originator, wonRevision).pipe(
        Effect.provideService(FinanceTaxRates, taxBaseline),
      );
      expect(Option.getOrUndefined(invoice)?.lines).toEqual([
        { description: 'Roční servis', quantity: 2, unitPriceMinor: 100_000, ...standardLineVat(scope.tenantId) },
      ]);
      expect(saved.length).toBe(1);
    }),
  );

  suite.effect('stores nothing while Tax cannot answer, so the delivery retries later', () =>
    Effect.gen(function* unavailable() {
      saved.length = 0;
      const failure = yield* draftOpportunityInvoiceInScope(scope, command, originator, wonRevision).pipe(
        Effect.provideService(FinanceTaxRates, taxUnavailable),
        Effect.flip,
      );
      expect(Schema.is(FinanceReferenceUnavailable)(failure)).toBe(true);
      expect(saved).toEqual([]);
    }),
  );

  suite.effect('refuses a line whose rate names no classification instead of storing it without Tax', () =>
    Effect.gen(function* unclassified() {
      saved.length = 0;
      const failure = yield* draftOpportunityInvoiceInScope(
        scope,
        { ...command, lines: [{ description: 'Kniha', quantity: 1, unitPriceMinor: 49_000, vatRate: 10 }] },
        originator,
        wonRevision,
      ).pipe(Effect.provideService(FinanceTaxRates, taxBaseline), Effect.flip);
      expect(Schema.is(FinanceRejected)(failure)).toBe(true);
      expect(failure).toMatchObject({ reason: 'vat_classification_required' });
      expect(saved).toEqual([]);
    }),
  );
});
