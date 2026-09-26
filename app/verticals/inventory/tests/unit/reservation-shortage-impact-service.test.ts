import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ReservationShortageImpactEvaluationSchema,
  ReservationShortageImpactInputSchema,
} from '../../shared/domain/reservation-shortage-impact.ts';
import { ExactStockQuantityAmountSchema } from '../../shared/domain/stock-position.ts';
import {
  ReservationShortageImpactTriggerSchema,
  ReservationShortageImpactUnavailable,
  makeReservationShortageImpactService,
} from '../../src/services/reservation-shortage-impact.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const positionRef = {
  moduleId: 'commerce.inventory' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.inventory.stock-position' as const,
  tenantId,
};
const trigger = Schema.decodeUnknownSync(ReservationShortageImpactTriggerSchema)({
  changeId: '33333333-3333-4333-8333-333333333333',
  changeKind: 'ISSUE',
  occurredAt: '2026-09-24T20:00:00.000Z',
  positionRef,
});
const evaluationInput = Schema.decodeUnknownSync(ReservationShortageImpactInputSchema)({
  affectedPositionRef: positionRef,
  availableQuantity: {
    amount: '1',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '44444444-4444-4444-8444-444444444444',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
  candidates: [],
});
const zeroFencedAmount = Schema.decodeUnknownSync(ExactStockQuantityAmountSchema)('0');
const staleFencedAmount = Schema.decodeUnknownSync(ExactStockQuantityAmountSchema)('1');

describe('Reservation shortage impact service', () => {
  it.effect('durably evaluates one material stock change and exact replay does not duplicate transitions', () =>
    Effect.gen(function* evaluateOnce() {
      let reads = 0;
      let writes = 0;
      const service = makeReservationShortageImpactService({
        persistence: {
          apply: (_input, _context, result) => {
            writes += 1;
            expect(Schema.is(ReservationShortageImpactEvaluationSchema)(result)).toBe(true);
            return Effect.void;
          },
          findApplied: () => {
            const applied = reads === 0 ? Option.none() : Option.some({ trigger });
            reads += 1;
            return Effect.succeed(applied);
          },
          readContext: () =>
            Effect.succeed({
              causeEvidenceRef: 'erp:effect:1',
              evaluationInput,
              fencedAmount: zeroFencedAmount,
              positionRevision: 2,
            }),
        },
      });

      yield* service.evaluate(trigger);
      yield* service.evaluate(trigger);

      expect(writes).toBe(1);
    }),
  );

  it.effect('fails closed when authoritative context cannot be loaded', () =>
    Effect.gen(function* unavailableContext() {
      const service = makeReservationShortageImpactService({
        persistence: {
          apply: () => Effect.die('must not write without authoritative context'),
          findApplied: () => Effect.succeedNone,
          readContext: () =>
            Effect.fail(
              new ReservationShortageImpactUnavailable({
                changeId: trigger.changeId,
                code: 'reservation_shortage_impact_unavailable',
                reason: 'Authoritative Stock Position truth is unavailable',
                retryable: true,
              }),
            ),
        },
      });

      const failure = yield* Effect.flip(service.evaluate(trigger));
      expect(Schema.is(ReservationShortageImpactUnavailable)(failure)).toBe(true);
      if (Schema.is(ReservationShortageImpactUnavailable)(failure)) {
        expect(failure.retryable).toBe(true);
      }
    }),
  );

  it.effect('rejects a fenced Quantity that does not match the evaluated candidate truth', () =>
    Effect.gen(function* rejectChangedFence() {
      const service = makeReservationShortageImpactService({
        persistence: {
          apply: () => Effect.die('must not persist a stale fence'),
          findApplied: () => Effect.succeedNone,
          readContext: () =>
            Effect.succeed({
              causeEvidenceRef: 'erp:effect:1',
              evaluationInput,
              fencedAmount: staleFencedAmount,
              positionRevision: 2,
            }),
        },
      });

      const failure = yield* Effect.flip(service.evaluate(trigger));
      expect(Schema.is(ReservationShortageImpactUnavailable)(failure)).toBe(true);
    }),
  );
});
