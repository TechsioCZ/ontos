import type { OutboxPayload } from '@app/sales-pipeline/outbox/opportunity-stage-changed';
import { OutboxPayloadSchema } from '@app/sales-pipeline/outbox/opportunity-stage-changed';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Option, Schema } from 'effect';
import { FinanceCommandSchema } from '../../shared/actions/apply-command.ts';
import { narrowVatRate, opportunityWonInvoiceCommand } from '../../shared/outbox-consumers/opportunity-won-invoice.ts';

const opportunityId = 'c0000000-0000-4000-8000-000000000001';
const partyId = 'a0000000-0000-4000-8000-000000000012';
const productId = 'd0000000-0000-4000-8000-000000000001';
const otherProductId = 'd0000000-0000-4000-8000-000000000002';

const stageChanged = (toStage: OutboxPayload['toStage']): Effect.Effect<OutboxPayload, Schema.SchemaError> =>
  Schema.decodeEffect(OutboxPayloadSchema)({
    amountMinor: 250_000,
    changedAt: '2026-10-07T21:30:00.000Z',
    currency: 'CZK',
    fromStage: 'NEGOTIATION',
    lines: [
      { productId, productName: 'Roční servis', quantity: 2, unitPriceMinor: 100_000, vatRate: 21 },
      { productId: otherProductId, productName: 'Školení', quantity: 1, unitPriceMinor: 50_000, vatRate: 15 },
    ],
    opportunityId,
    partyId,
    revision: 4,
    toStage,
  });

describe('opportunityWonInvoiceCommand', () => {
  it.effect('maps a WON stage change to CreateInvoiceFromOpportunity from the line snapshot', () =>
    Effect.gen(function* wonMapsToCommand() {
      const command = yield* Effect.fromOption(opportunityWonInvoiceCommand(yield* stageChanged('WON')));
      expect(Schema.is(FinanceCommandSchema)(command)).toBe(true);
      expect(command.opportunityId).toBe(opportunityId);
      expect(command.partyId).toBe(partyId);
      expect(command.issueDate).toBe('2026-10-07');
      expect(command.lines).toEqual([
        { description: 'Roční servis', productId, quantity: 2, unitPriceMinor: 100_000, vatRate: 21 },
        { description: 'Školení', productId: otherProductId, quantity: 1, unitPriceMinor: 50_000, vatRate: 21 },
      ]);
    }),
  );

  it.effect('maps every redelivery of the same message to the identical command', () =>
    Effect.gen(function* deterministic() {
      const payload = yield* stageChanged('WON');
      const first = yield* Effect.fromOption(opportunityWonInvoiceCommand(payload));
      const again = yield* Effect.fromOption(opportunityWonInvoiceCommand(payload));
      expect(again.issueDate).toBe(first.issueDate);
      expect(again.lines).toEqual(first.lines);
    }),
  );

  it.effect('ignores every stage other than WON', () =>
    Effect.gen(function* otherStagesAreNoOps() {
      for (const stage of ['LEAD', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'LOST'] as const) {
        expect(Option.isNone(opportunityWonInvoiceCommand(yield* stageChanged(stage)))).toBe(true);
      }
    }),
  );

  it.effect('ignores a WON opportunity without lines instead of drafting an empty invoice', () =>
    Effect.gen(function* emptyWon() {
      const payload = yield* stageChanged('WON');
      expect(Option.isNone(opportunityWonInvoiceCommand({ ...payload, lines: [] }))).toBe(true);
    }),
  );

  it('narrows VAT rates to the Czech set with a 21 % fallback', () => {
    expect([0, 10, 12, 21, 15, 100].map(narrowVatRate)).toEqual([0, 10, 12, 21, 21, 21]);
  });
});
