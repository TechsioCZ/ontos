import type { ScopedRoutineInvoker } from '@app/core-runtime';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ReservationShortageImpactEvaluationSchema,
  ReservationShortageImpactInputSchema,
} from '../../shared/domain/reservation-shortage-impact.ts';
import { reservationShortageImpactPersistenceForWorkerScope } from '../../src/persistence/reservation-shortage-impact-repository.ts';
import { ReservationShortageImpactTriggerSchema } from '../../src/services/reservation-shortage-impact.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const positionId = '33333333-3333-4333-8333-333333333333';
const changeId = '44444444-4444-4444-8444-444444444444';
const occurredAt = '2026-09-24T20:00:00.000Z';
const trigger = Schema.decodeUnknownSync(ReservationShortageImpactTriggerSchema)({
  changeId,
  changeKind: 'ISSUE',
  occurredAt,
  positionRef: {
    moduleId: 'commerce.inventory',
    resourceId: positionId,
    resourceType: 'commerce.inventory.stock-position',
    tenantId,
  },
});
const evaluationInput = Schema.decodeUnknownSync(ReservationShortageImpactInputSchema)({
  affectedPositionRef: trigger.positionRef,
  availableQuantity: {
    amount: '3',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '55555555-5555-4555-8555-555555555555',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
  candidates: [],
});
const evaluation = Schema.decodeUnknownSync(ReservationShortageImpactEvaluationSchema)({
  _tag: 'DETERMINATE',
  affectedPositionRef: trigger.positionRef,
  decisions: [],
  fencedAmount: '0',
});

describe('Reservation shortage impact worker persistence', () => {
  it.effect('uses only owner-scoped routines and preserves the exact material change identity', () =>
    Effect.gen(function* invokeExactRoutines() {
      const calls: { readonly args: readonly unknown[]; readonly key: string }[] = [];
      const routineInvoker: ScopedRoutineInvoker = {
        invoke: (routine, args) =>
          Effect.sync(() => {
            calls.push({ args, key: routine.routineKey });
            let rows: readonly unknown[] = [{ applied: true }];
            if (routine.routineKey === 'inventory.find-reservation-shortage-impact-for-worker') {
              rows = [{ found: false }];
            } else if (routine.routineKey === 'inventory.read-reservation-shortage-impact-context-for-worker') {
              rows = [
                {
                  context: {
                    causeEvidenceRef: 'erp:issue:42',
                    evaluationInput,
                    fencedAmount: '0',
                    positionRevision: 7,
                  },
                },
              ];
            }
            return Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(rows);
          }),
      };
      const scope: OutboxWorkerLegalEntityScope = {
        completionPublisher: { publish: () => Effect.die('unused completion publisher') },
        legalEntityId,
        routineInvoker,
        tenantId,
      };
      const persistence = reservationShortageImpactPersistenceForWorkerScope(scope);

      expect(Option.isNone(yield* persistence.findApplied(trigger))).toBe(true);
      const context = yield* persistence.readContext(trigger);
      yield* persistence.apply(trigger, context, evaluation);

      expect(context).toEqual({
        causeEvidenceRef: 'erp:issue:42',
        evaluationInput,
        fencedAmount: '0',
        positionRevision: 7,
      });
      expect(calls).toEqual([
        {
          args: ['ISSUE', changeId],
          key: 'inventory.find-reservation-shortage-impact-for-worker',
        },
        {
          args: ['ISSUE', changeId, positionId, occurredAt],
          key: 'inventory.read-reservation-shortage-impact-context-for-worker',
        },
        {
          args: ['ISSUE', changeId, positionId, occurredAt, evaluation],
          key: 'inventory.apply-reservation-shortage-impact-for-worker',
        },
      ]);
    }),
  );
});
