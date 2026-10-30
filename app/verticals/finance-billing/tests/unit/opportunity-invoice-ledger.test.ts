import { NodeCrypto } from '@effect/platform-node';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Crypto, Effect, PlatformError, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FinancePersistenceUnavailable } from '../../shared/actions/apply-command.ts';
import type { CreateInvoiceFromOpportunityCommand } from '../../shared/outbox-consumers/opportunity-won-invoice.ts';
import {
  draftOpportunityInvoiceInScope,
  readFinanceStateForWorkerRoutine,
} from '../../src/workers/opportunity-invoice-ledger.ts';

const command: CreateInvoiceFromOpportunityCommand = {
  _tag: 'CreateInvoiceFromOpportunity',
  issueDate: '2026-10-07',
  lines: [{ description: 'Roční servis', quantity: 2, unitPriceMinor: 100_000, vatRate: 21 }],
  opportunityId: 'c0000000-0000-4000-8000-000000000001',
  partyId: 'a0000000-0000-4000-8000-000000000012',
};
const scope: OutboxWorkerLegalEntityScope = {
  completionPublisher: { publish: () => Effect.die('Invoice drafting must not publish completion evidence') },
  legalEntityId: 'a0000000-0000-4000-8000-000000000002',
  routineInvoker: {
    invoke: (routine) => {
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

it.layer(NodeCrypto.layer)('Opportunity invoice ledger cryptography', (suite) => {
  suite.effect('maps native UUID failure to a typed Finance failure before saving state', () =>
    Effect.gen(function* uuidFailure() {
      const crypto = yield* Crypto.Crypto;
      const cause = PlatformError.systemError({ _tag: 'Unknown', method: 'randomUUIDv4', module: 'Crypto' });
      const failure = yield* draftOpportunityInvoiceInScope(scope, command).pipe(
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
