import { Effect, Ref } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { advanceReservationConfirmationHealth } from '../../shared/domain/reservation-confirmation.ts';
import { makeBindingCorrectionImpactService } from '../../src/services/binding-correction-impact.service.ts';
import {
  buildInventoryOwnerAcceptanceBindingCorrectionLineage,
  inventoryOwnerAcceptanceBindingCorrectionFixture,
} from '../support/inventory-owner-acceptance-binding-correction.ts';

const correctionInput = {
  correctedBinding: inventoryOwnerAcceptanceBindingCorrectionFixture.correctedBinding,
  correctionEvidenceRef: 'catalog-binding-correction:owner-acceptance-1',
  previousBinding: inventoryOwnerAcceptanceBindingCorrectionFixture.originalBinding,
} as const;

describe('Binding correction impact service', () => {
  it.effect('marks each linked owner proof once and appends durable committed mismatch debt idempotently', () =>
    Effect.gen(function* propagateOnce() {
      const lineage = yield* buildInventoryOwnerAcceptanceBindingCorrectionLineage;
      const confirmation = yield* Ref.make(lineage.confirmation);
      const protection = yield* Ref.make(lineage.protection);
      const confirmationWrites = yield* Ref.make(0);
      const protectionWrites = yield* Ref.make(0);
      const debtRecorded = yield* Ref.make(false);
      const service = makeBindingCorrectionImpactService({
        appendCommittedReconciliation: () =>
          Ref.modify(debtRecorded, (recorded) => [recorded ? 'EXACT_REPLAY' : 'APPENDED', true] as const),
        lockAffected: () =>
          Effect.all([Ref.get(confirmation), Ref.get(protection)]).pipe(
            Effect.map(([currentConfirmation, currentProtection]) => [
              {
                confirmation: currentConfirmation,
                lifecycleMeaning: 'COMMITTED_OBLIGATION' as const,
                obligationId: lineage.reservation.ref.resourceId,
                protection: currentProtection,
                purchaseDemandOccurrenceId: inventoryOwnerAcceptanceBindingCorrectionFixture.purchaseDemandOccurrenceId,
                subjectResourceType: 'commerce.inventory.inventory-reservation' as const,
              },
              {
                confirmation: currentConfirmation,
                lifecycleMeaning: 'PROVISIONAL_RESERVATION' as const,
                obligationId: lineage.reservation.ref.resourceId,
                protection: currentProtection,
                purchaseDemandOccurrenceId: 'duplicate-requirement-observation',
                subjectResourceType: 'commerce.inventory.inventory-reservation' as const,
              },
            ]),
          ),
        saveConfirmation: (_current, next) =>
          Ref.set(confirmation, next).pipe(
            Effect.andThen(Ref.update(confirmationWrites, (count) => count + 1)),
            Effect.as(next),
          ),
        saveProtection: (_current, next) =>
          Ref.set(protection, next).pipe(
            Effect.andThen(Ref.update(protectionWrites, (count) => count + 1)),
            Effect.as(next),
          ),
      });

      const first = yield* service.apply(correctionInput);
      const replay = yield* service.apply(correctionInput);
      const currentConfirmation = yield* Ref.get(confirmation);
      const currentProtection = yield* Ref.get(protection);

      expect(first).toMatchObject({
        affectedRequirements: 2,
        committedReconciliations: 1,
        confirmationsAtRisk: 1,
        protectionsAtRisk: 1,
      });
      expect(first.confirmationChanges).toHaveLength(1);
      expect(first.confirmationChanges[0]).toMatchObject({ ref: lineage.confirmation.ref, revision: 2 });
      expect(first.protectionChanges).toHaveLength(1);
      expect(first.protectionChanges[0]).toMatchObject({ ref: lineage.protection.ref, revision: 2 });
      expect(first.committedReconciliationChanges).toHaveLength(1);
      expect(first.committedReconciliationChanges[0]).toMatchObject({
        obligationId: lineage.reservation.ref.resourceId,
        purchaseDemandOccurrenceId: inventoryOwnerAcceptanceBindingCorrectionFixture.purchaseDemandOccurrenceId,
        subjectResourceType: 'commerce.inventory.inventory-reservation',
      });
      expect(replay).toMatchObject({
        affectedRequirements: 2,
        committedReconciliations: 0,
        confirmationsAtRisk: 0,
        protectionsAtRisk: 0,
      });
      expect(replay.confirmationChanges).toEqual([]);
      expect(replay.protectionChanges).toEqual([]);
      expect(replay.committedReconciliationChanges).toEqual([]);
      expect(yield* Ref.get(confirmationWrites)).toBe(1);
      expect(yield* Ref.get(protectionWrites)).toBe(1);
      expect(currentConfirmation).toMatchObject({
        health: { observation: { _tag: 'BINDING_CORRECTION' }, state: 'AT_RISK' },
        revision: 2,
      });
      expect(currentProtection).toMatchObject({
        health: { observation: { _tag: 'BINDING_CORRECTION' }, reconciliationRequired: true, state: 'AT_RISK' },
        revision: 2,
      });
      expect(currentConfirmation.reservation.requirements).toEqual(lineage.reservation.requirements);
      expect(currentProtection.confirmation.reservation.requirements).toEqual(lineage.reservation.requirements);
    }),
  );

  it.effect('leaves terminal Confirmations unchanged while still recording committed mismatch debt', () =>
    Effect.gen(function* preserveTerminalConfirmation() {
      const lineage = yield* buildInventoryOwnerAcceptanceBindingCorrectionLineage;
      const revoked = yield* advanceReservationConfirmationHealth(lineage.confirmation, {
        _tag: 'DEFINITIVE_REVOCATION',
        decision: 'DEFINITIVE',
        effectiveAt: '2026-09-25T10:04:00.000Z',
        ownerEvidenceRef: 'owner-revocation:1',
      });
      const confirmationWrites = yield* Ref.make(0);
      const service = makeBindingCorrectionImpactService({
        appendCommittedReconciliation: () => Effect.succeed('APPENDED'),
        lockAffected: () =>
          Effect.succeed([
            {
              confirmation: revoked,
              lifecycleMeaning: 'COMMITTED_OBLIGATION' as const,
              obligationId: lineage.reservation.ref.resourceId,
              purchaseDemandOccurrenceId: inventoryOwnerAcceptanceBindingCorrectionFixture.purchaseDemandOccurrenceId,
              subjectResourceType: 'commerce.inventory.inventory-reservation' as const,
            },
          ]),
        saveConfirmation: (_current, next) =>
          Ref.update(confirmationWrites, (count) => count + 1).pipe(Effect.as(next)),
        saveProtection: () => Effect.die('no Protection exists'),
      });

      const result = yield* service.apply(correctionInput);

      expect(result).toMatchObject({
        affectedRequirements: 1,
        committedReconciliations: 1,
        confirmationsAtRisk: 0,
        protectionsAtRisk: 0,
      });
      expect(result.confirmationChanges).toEqual([]);
      expect(result.protectionChanges).toEqual([]);
      expect(result.committedReconciliationChanges).toHaveLength(1);
      expect(yield* Ref.get(confirmationWrites)).toBe(0);
      expect(revoked.health.state).toBe('REVOKED');
    }),
  );
});
