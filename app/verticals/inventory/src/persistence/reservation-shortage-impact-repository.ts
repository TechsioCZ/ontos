import { defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import {
  ReservationShortageImpactInputSchema,
  deriveReservationShortageFencedAmount,
} from '../../shared/domain/reservation-shortage-impact.ts';
import type { PhysicalStockEffectEvidence } from '../../shared/domain/physical-stock-effect.ts';
import { advanceReservationConfirmationHealth } from '../../shared/domain/reservation-confirmation.ts';
import { ExactStockQuantityAmountSchema } from '../../shared/domain/stock-position.ts';
import { reservationConfirmationPersistenceForScope } from './reservation-confirmation-repository.ts';
import {
  ReservationShortageImpactTriggerSchema,
  ReservationShortageImpactUnavailable,
} from '../services/reservation-shortage-impact.service.ts';
import type {
  ReservationShortageImpactPersistence,
  ReservationShortageImpactTrigger,
} from '../services/reservation-shortage-impact.service.ts';
import { inventoryObligationAllocations, inventoryObligations } from './inventory-obligation-table.ts';
import { inventoryPhysicalStockEffects } from './physical-stock-effect-table.ts';
import { inventoryReservationConfirmations } from './reservation-confirmation-table.ts';
import { inventoryReservationReleaseEffects } from './reservation-release-effect-table.ts';
import {
  inventoryReservationShortageImpactDecisions,
  inventoryReservationShortageImpacts,
} from './reservation-shortage-impact-table.ts';
import { inventoryStockCorrections } from './stock-correction-table.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
const INVENTORY_MODULE_ID = 'commerce.inventory' as const;

const contextRowSchema = Schema.Struct({
  context: Schema.Struct({
    causeEvidenceRef: Schema.String,
    evaluationInput: ReservationShortageImpactInputSchema,
    fencedAmount: ExactStockQuantityAmountSchema,
    positionRevision: Schema.Int,
  }),
});
const appliedRowSchema = Schema.Struct({ found: Schema.Boolean });
const applyRowSchema = Schema.Struct({ applied: Schema.Boolean });

export const findReservationShortageImpactForWorkerRoutine = defineScopedRoutine({
  name: 'find_reservation_shortage_impact_for_worker',
  ownerModuleKey: INVENTORY_MODULE_ID,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: appliedRowSchema,
  routineKey: 'inventory.find-reservation-shortage-impact-for-worker',
  schema: 'inventory',
});

export const readReservationShortageImpactContextForWorkerRoutine = defineScopedRoutine({
  name: 'read_reservation_shortage_impact_context_for_worker',
  ownerModuleKey: INVENTORY_MODULE_ID,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'timestamptz' },
  ],
  resultSchema: contextRowSchema,
  routineKey: 'inventory.read-reservation-shortage-impact-context-for-worker',
  schema: 'inventory',
});

export const applyReservationShortageImpactForWorkerRoutine = defineScopedRoutine({
  name: 'apply_reservation_shortage_impact_for_worker',
  ownerModuleKey: INVENTORY_MODULE_ID,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: applyRowSchema,
  routineKey: 'inventory.apply-reservation-shortage-impact-for-worker',
  schema: 'inventory',
});

const unavailable = (trigger?: ReservationShortageImpactTrigger, cause?: unknown) => {
  const failure =
    trigger === undefined
      ? new ReservationShortageImpactUnavailable({
          code: 'reservation_shortage_impact_unavailable',
          reason: 'Reservation shortage impact persistence is temporarily unavailable',
          retryable: true,
        })
      : new ReservationShortageImpactUnavailable({
          changeId: trigger.changeId,
          code: 'reservation_shortage_impact_unavailable',
          reason: 'Reservation shortage impact persistence is temporarily unavailable',
          retryable: true,
        });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const instantAsDate = (instant: string) => DateTime.toDateUtc(DateTime.makeUnsafe(instant));
const instantAsString = (instant: Date) => DateTime.formatIso(DateTime.fromDateUnsafe(instant));

const sourceValues = (trigger: ReservationShortageImpactTrigger) =>
  trigger.changeKind === 'CORRECTION'
    ? { physicalEffectId: null, stockCorrectionId: trigger.changeId }
    : { physicalEffectId: trigger.changeId, stockCorrectionId: null };

const triggerForRow = (row: typeof inventoryReservationShortageImpacts.$inferSelect) =>
  Schema.decodeUnknownEffect(ReservationShortageImpactTriggerSchema)({
    changeId: row.changeId,
    changeKind: row.changeKind,
    occurredAt: instantAsString(row.occurredAt),
    positionRef: {
      moduleId: INVENTORY_MODULE_ID,
      resourceId: row.positionId,
      resourceType: 'commerce.inventory.stock-position',
      tenantId: row.tenantId,
    },
  }).pipe(Effect.mapError((cause) => unavailable(undefined, cause)));

const healthEvidenceRef = (trigger: ReservationShortageImpactTrigger, causeEvidenceRef: string) =>
  `stock-change:${trigger.changeKind.toLowerCase()}:${causeEvidenceRef}`.slice(0, 300);

const exactPositionSourceEvidence = (
  source:
    | { readonly appliedAt: Date; readonly evidenceRef: string; readonly observedAt: Date }
    | {
        readonly record: Pick<PhysicalStockEffectEvidence, 'appliedAt' | 'backendEvidenceRef'> | null;
      },
) => {
  if ('evidenceRef' in source) {
    return { evidenceRef: source.evidenceRef, observedAt: source.observedAt, occurredAt: source.appliedAt };
  }
  if (source.record === null) {
    return null;
  }
  const appliedAt = instantAsDate(source.record.appliedAt);
  return { evidenceRef: source.record.backendEvidenceRef, observedAt: appliedAt, occurredAt: appliedAt };
};

export const reservationShortageImpactPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): ReservationShortageImpactPersistence => {
  const findApplied: ReservationShortageImpactPersistence['findApplied'] = Effect.fn(
    'ReservationShortageImpactPersistence.findApplied',
  )(function* findAppliedImpact(trigger) {
    if (trigger.positionRef.tenantId !== scope.tenantId) {
      return yield* unavailable(trigger);
    }
    const [row] = yield* transaction
      .select()
      .from(inventoryReservationShortageImpacts)
      .where(
        and(
          eq(inventoryReservationShortageImpacts.tenantId, scope.tenantId),
          eq(inventoryReservationShortageImpacts.changeKind, trigger.changeKind),
          eq(inventoryReservationShortageImpacts.changeId, trigger.changeId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError((cause) => unavailable(trigger, cause)));
    return row === undefined ? Option.none() : Option.some({ trigger: yield* triggerForRow(row) });
  });

  const readContext: ReservationShortageImpactPersistence['readContext'] = Effect.fn(
    'ReservationShortageImpactPersistence.readContext',
  )(function* readImpactContext(trigger) {
    if (trigger.positionRef.tenantId !== scope.tenantId) {
      return yield* unavailable(trigger);
    }
    const [position] = yield* transaction
      .select()
      .from(inventoryStockPositions)
      .where(
        and(
          eq(inventoryStockPositions.tenantId, scope.tenantId),
          eq(inventoryStockPositions.stockPositionId, trigger.positionRef.resourceId),
          eq(inventoryStockPositions.lifecycleState, 'CURRENT'),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError((cause) => unavailable(trigger, cause)));
    if (position?.onHandState !== 'CURRENT' || position.onHandAmount === null) {
      return yield* unavailable(trigger);
    }

    const sourceRows =
      trigger.changeKind === 'CORRECTION'
        ? yield* transaction
            .select({
              appliedAt: inventoryStockCorrections.appliedAt,
              evidenceRef: inventoryStockCorrections.ownerEvidenceRef,
              observedAt: inventoryStockCorrections.businessObservedAt,
            })
            .from(inventoryStockCorrections)
            .where(
              and(
                eq(inventoryStockCorrections.tenantId, scope.tenantId),
                eq(inventoryStockCorrections.correctionId, trigger.changeId),
                eq(inventoryStockCorrections.positionId, trigger.positionRef.resourceId),
                eq(inventoryStockCorrections.state, 'APPLIED'),
                eq(inventoryStockCorrections.appliedAt, instantAsDate(trigger.occurredAt)),
              ),
            )
            .limit(1)
            .pipe(Effect.mapError((cause) => unavailable(trigger, cause)))
        : yield* transaction
            .select({ record: inventoryPhysicalStockEffects.evidenceJson })
            .from(inventoryPhysicalStockEffects)
            .where(
              and(
                eq(inventoryPhysicalStockEffects.tenantId, scope.tenantId),
                eq(inventoryPhysicalStockEffects.effectId, trigger.changeId),
                eq(inventoryPhysicalStockEffects.positionId, trigger.positionRef.resourceId),
                eq(inventoryPhysicalStockEffects.kind, trigger.changeKind),
                eq(inventoryPhysicalStockEffects.state, 'APPLIED'),
              ),
            )
            .limit(1)
            .pipe(Effect.mapError((cause) => unavailable(trigger, cause)));
    const [source] = sourceRows;
    const exactSource = source === undefined ? undefined : exactPositionSourceEvidence(source);
    if (
      exactSource === undefined ||
      exactSource === null ||
      exactSource.occurredAt.getTime() !== instantAsDate(trigger.occurredAt).getTime() ||
      position.onHandEvidenceRef !== exactSource.evidenceRef ||
      position.onHandObservedAt?.getTime() !== exactSource.observedAt.getTime()
    ) {
      return yield* unavailable(trigger);
    }

    const rows = yield* transaction
      .select({
        confirmation: inventoryReservationConfirmations.snapshot,
        lifecycleMeaning: inventoryObligations.lifecycleMeaning,
      })
      .from(inventoryReservationConfirmations)
      .innerJoin(
        inventoryObligations,
        and(
          eq(inventoryObligations.tenantId, inventoryReservationConfirmations.tenantId),
          eq(inventoryObligations.obligationId, inventoryReservationConfirmations.reservationId),
        ),
      )
      .innerJoin(
        inventoryObligationAllocations,
        and(
          eq(inventoryObligationAllocations.tenantId, inventoryReservationConfirmations.tenantId),
          eq(inventoryObligationAllocations.obligationId, inventoryReservationConfirmations.reservationId),
          eq(inventoryObligationAllocations.stockPositionId, trigger.positionRef.resourceId),
        ),
      )
      .leftJoin(
        inventoryReservationReleaseEffects,
        and(
          eq(inventoryReservationReleaseEffects.tenantId, inventoryReservationConfirmations.tenantId),
          eq(inventoryReservationReleaseEffects.reservationId, inventoryReservationConfirmations.reservationId),
        ),
      )
      .where(
        and(
          eq(inventoryReservationConfirmations.tenantId, scope.tenantId),
          or(
            isNull(inventoryReservationReleaseEffects.releaseEffectRecordId),
            ne(inventoryReservationReleaseEffects.currentState, 'RELEASED'),
          ),
        ),
      )
      .pipe(Effect.mapError((cause) => unavailable(trigger, cause)));
    const candidatesById = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      candidatesById.set(row.confirmation.ref.resourceId, row);
    }
    const evaluationInput = yield* Schema.decodeUnknownEffect(ReservationShortageImpactInputSchema)({
      affectedPositionRef: trigger.positionRef,
      availableQuantity: {
        amount: position.onHandAmount,
        unitRef: {
          moduleId: position.stockUnitModuleId,
          resourceId: position.stockUnitResourceId,
          resourceType: position.stockUnitResourceType,
          tenantId: position.stockUnitTenantId,
        },
      },
      candidates: [...candidatesById.values()].map(({ confirmation, lifecycleMeaning }) => ({
        allocations: confirmation.reservation.requirements.flatMap(({ allocations }) => allocations),
        confirmation,
        poolBoundary: lifecycleMeaning === 'COMMITTED_OBLIGATION' ? 'COMMITTED_OBLIGATION' : 'NONE',
      })),
    }).pipe(Effect.mapError((cause) => unavailable(trigger, cause)));
    const fencedAmount = yield* deriveReservationShortageFencedAmount(evaluationInput).pipe(
      Effect.mapError((cause) => unavailable(trigger, cause)),
    );
    return {
      causeEvidenceRef: exactSource.evidenceRef,
      evaluationInput,
      fencedAmount,
      positionRevision: position.revision,
    };
  });

  const apply: ReservationShortageImpactPersistence['apply'] = Effect.fn('ReservationShortageImpactPersistence.apply')(
    function* applyImpact(trigger, context, evaluation) {
      const evaluationMetadata = Match.value(evaluation).pipe(
        Match.tag('DETERMINATE', ({ decisions }) => ({
          decisionCount: decisions.length,
          reason: null,
          reconciliationRequired: false,
          status: 'DETERMINATE' as const,
        })),
        Match.tag('INDETERMINATE', ({ candidateRefs, reason }) => ({
          decisionCount: candidateRefs.length,
          reason,
          reconciliationRequired: true,
          status: 'INDETERMINATE' as const,
        })),
        Match.exhaustive,
      );
      const [inserted] = yield* transaction
        .insert(inventoryReservationShortageImpacts)
        .values({
          availableAmount: context.evaluationInput.availableQuantity.amount,
          changeId: trigger.changeId,
          changeKind: trigger.changeKind,
          fencedAmount: context.fencedAmount,
          occurredAt: instantAsDate(trigger.occurredAt),
          positionId: trigger.positionRef.resourceId,
          positionRevision: context.positionRevision,
          tenantId: scope.tenantId,
          ...evaluationMetadata,
          ...sourceValues(trigger),
        })
        .onConflictDoNothing()
        .returning()
        .pipe(Effect.mapError((cause) => unavailable(trigger, cause)));
      if (inserted === undefined) {
        return;
      }

      const confirmationPersistence = reservationConfirmationPersistenceForScope(transaction, scope);
      const candidates = new Map(
        context.evaluationInput.candidates.map((candidate) => [candidate.confirmation.ref.resourceId, candidate]),
      );
      /* oxlint-disable effect-native/prefer-effect-fn-for-operations, sonarjs/no-nested-functions -- This ordered transaction fold must retain the preceding Confirmation revision before writing each decision; expires: 2027-03-31. */
      const decisionValues = yield* Match.value(evaluation).pipe(
        Match.tag('DETERMINATE', ({ decisions }) =>
          Effect.forEach(
            decisions,
            (decision, index) =>
              Effect.gen(function* makeDeterminateDecision() {
                const candidate = candidates.get(decision.confirmationRef.resourceId);
                if (candidate === undefined) {
                  return yield* unavailable(trigger);
                }
                const before = candidate.confirmation;
                const after =
                  decision.capacity === 'SHORTAGE' && before.health.state === 'VALID'
                    ? yield* advanceReservationConfirmationHealth(before, {
                        _tag: 'MATERIAL_IMPAIRMENT',
                        effectiveAt: trigger.occurredAt,
                        ownerEvidenceRef: healthEvidenceRef(trigger, context.causeEvidenceRef),
                      }).pipe(Effect.mapError((cause) => unavailable(trigger, cause)))
                    : before;
                if (after.revision !== before.revision) {
                  yield* confirmationPersistence
                    .saveRevision({ current: before, next: after })
                    .pipe(Effect.mapError((cause) => unavailable(trigger, cause)));
                }
                return {
                  affectedAmount: decision.affectedQuantity.amount,
                  changeId: trigger.changeId,
                  changeKind: trigger.changeKind,
                  confirmationId: decision.confirmationRef.resourceId,
                  confirmationRevisionAfter: after.revision,
                  confirmationRevisionBefore: before.revision,
                  decision: decision.capacity,
                  healthAfter: after.health.state,
                  healthBefore: before.health.state,
                  priorityOrdinal: index + 1,
                  rankIssuedAt: instantAsDate(decision.issuanceRank.issuedAt),
                  rankOwnerEvidenceRef: decision.issuanceRank.ownerEvidenceRef,
                  tenantId: scope.tenantId,
                } satisfies typeof inventoryReservationShortageImpactDecisions.$inferInsert;
              }),
            { concurrency: 1 },
          ),
        ),
        Match.tag('INDETERMINATE', ({ candidateRefs }) =>
          Effect.forEach(
            candidateRefs,
            (confirmationRef) => {
              const candidate = candidates.get(confirmationRef.resourceId);
              if (candidate === undefined) {
                return Effect.fail(unavailable(trigger));
              }
              const { confirmation } = candidate;
              return Effect.succeed({
                affectedAmount: null,
                changeId: trigger.changeId,
                changeKind: trigger.changeKind,
                confirmationId: confirmation.ref.resourceId,
                confirmationRevisionAfter: confirmation.revision,
                confirmationRevisionBefore: confirmation.revision,
                decision: 'ORDER_UNRESOLVABLE',
                healthAfter: confirmation.health.state,
                healthBefore: confirmation.health.state,
                priorityOrdinal: null,
                rankIssuedAt: instantAsDate(confirmation.issuanceRank.issuedAt),
                rankOwnerEvidenceRef: confirmation.issuanceRank.ownerEvidenceRef,
                tenantId: scope.tenantId,
              } satisfies typeof inventoryReservationShortageImpactDecisions.$inferInsert);
            },
            { concurrency: 1 },
          ),
        ),
        Match.exhaustive,
      );
      /* oxlint-enable effect-native/prefer-effect-fn-for-operations, sonarjs/no-nested-functions */
      if (decisionValues.length > 0) {
        yield* transaction
          .insert(inventoryReservationShortageImpactDecisions)
          .values(decisionValues)
          .pipe(Effect.mapError((cause) => unavailable(trigger, cause)));
      }
    },
  );

  return Object.freeze({ apply, findApplied, readContext });
};

export const reservationShortageImpactPersistenceForWorkerScope = (
  scope: OutboxWorkerLegalEntityScope,
): ReservationShortageImpactPersistence => ({
  apply: (trigger, _context, evaluation) =>
    scope.routineInvoker
      .invoke(applyReservationShortageImpactForWorkerRoutine, [
        trigger.changeKind,
        trigger.changeId,
        trigger.positionRef.resourceId,
        trigger.occurredAt,
        evaluation,
      ])
      .pipe(
        Effect.mapError((cause) => unavailable(trigger, cause)),
        Effect.flatMap(([row]) => (row?.applied === true ? Effect.void : Effect.fail(unavailable(trigger)))),
      ),
  findApplied: (trigger) =>
    scope.routineInvoker
      .invoke(findReservationShortageImpactForWorkerRoutine, [trigger.changeKind, trigger.changeId])
      .pipe(
        Effect.mapError((cause) => unavailable(trigger, cause)),
        Effect.map(([row]) => (row?.found === true ? Option.some({ trigger }) : Option.none())),
      ),
  readContext: (trigger) =>
    scope.routineInvoker
      .invoke(readReservationShortageImpactContextForWorkerRoutine, [
        trigger.changeKind,
        trigger.changeId,
        trigger.positionRef.resourceId,
        trigger.occurredAt,
      ])
      .pipe(
        Effect.mapError((cause) => unavailable(trigger, cause)),
        Effect.flatMap(([row]) =>
          row === undefined ? Effect.fail(unavailable(trigger)) : Effect.succeed(row.context),
        ),
      ),
});
