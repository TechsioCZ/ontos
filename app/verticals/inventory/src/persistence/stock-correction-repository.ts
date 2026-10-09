import { findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import {
  PhysicalStockEffectIdSchema,
  PhysicalStockEffectRecordSchema,
} from '../../shared/domain/physical-stock-effect.ts';
import type { PhysicalStockEffectRecord } from '../../shared/domain/physical-stock-effect.ts';
import {
  AppliedStockCorrectionSchema,
  IndeterminateStockCorrectionSchema,
  StockCorrectionConflict,
  StockCorrectionRecordSchema,
  StockCorrectionRejected,
  StockCorrectionUnavailable,
} from '../../shared/domain/stock-correction.ts';
import type { StockCorrectionId, StockCorrectionRecord } from '../../shared/domain/stock-correction.ts';
import {
  CurrentOnHandEvidenceSchema,
  IndeterminateOnHandEvidenceSchema,
  StockPositionSchema,
} from '../../shared/domain/stock-position.ts';
import type { StockPosition, StockPositionOnHandEvidence } from '../../shared/domain/stock-position.ts';
import type { StockPositionRef } from '../../shared/resources/stock-position.ts';
import type { StockCorrectionPersistence } from '../services/stock-correction.service.ts';
import { inventoryPhysicalStockEffects } from './physical-stock-effect-table.ts';
import { inventoryStockCorrectionOpenReconciliations, inventoryStockCorrections } from './stock-correction-table.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type StockPositionRow = typeof inventoryStockPositions.$inferSelect;

const INVENTORY_MODULE_ID = 'commerce.inventory' as const;
const STOCK_POSITION_RESOURCE_TYPE = 'commerce.inventory.stock-position' as const;

const unavailable = (correctionId?: StockCorrectionId, cause?: unknown) => {
  const failure =
    correctionId === undefined
      ? new StockCorrectionUnavailable({
          code: 'stock_correction_unavailable',
          reason: 'Stock Correction persistence is temporarily unavailable',
          retryable: true,
        })
      : new StockCorrectionUnavailable({
          code: 'stock_correction_unavailable',
          correctionId,
          reason: 'Stock Correction persistence is temporarily unavailable',
          retryable: true,
        });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const conflict = (correctionId: StockCorrectionId, reason: StockCorrectionConflict['reason'], cause?: unknown) => {
  const failure = new StockCorrectionConflict({ code: 'stock_correction_conflict', correctionId, reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const rejected = (correctionId: StockCorrectionId, reason: StockCorrectionRejected['reason'], cause?: unknown) => {
  const failure = new StockCorrectionRejected({ code: 'stock_correction_rejected', correctionId, reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const uniqueViolationSqlState = ['23', '505'].join('');
const checkViolationSqlState = ['23', '514'].join('');
const foreignKeyViolationSqlState = ['23', '503'].join('');

const mapCorrectionWriteError = (correctionId: StockCorrectionId, cause: unknown) => {
  const postgres = findPostgresFailure(cause, () => true);
  if (Option.isNone(postgres)) {
    return unavailable(correctionId, cause);
  }
  const { code, constraint } = postgres.value;
  if (code === uniqueViolationSqlState) {
    if (constraint === 'inventory_stock_corrections_assertion_uk') {
      return conflict(correctionId, 'ASSERTION_ALREADY_USED', cause);
    }
    if (constraint === 'inventory_stock_corrections_source_evidence_uk') {
      return conflict(correctionId, 'EVIDENCE_ALREADY_USED', cause);
    }
    if (constraint === 'inventory_stock_corrections_reconciles_uk') {
      return conflict(correctionId, 'OPEN_RECONCILIATION_MISMATCH', cause);
    }
    if (constraint === 'stock_corrections_pkey' || constraint === 'inventory_stock_corrections_tenant_id_uk') {
      return conflict(correctionId, 'CORRECTION_ID_CONFLICT', cause);
    }
  }
  if (code === foreignKeyViolationSqlState) {
    if (constraint === 'inventory_stock_corrections_assertion_fk') {
      return rejected(correctionId, 'SOURCE_ASSERTION_NOT_FOUND', cause);
    }
    if (constraint === 'inventory_stock_corrections_source_evidence_fk') {
      return rejected(correctionId, 'SOURCE_EVIDENCE_NOT_FOUND', cause);
    }
    if (constraint === 'inventory_stock_corrections_position_fk') {
      return rejected(correctionId, 'POSITION_NOT_FOUND', cause);
    }
    if (constraint === 'inventory_stock_corrections_authority_fk') {
      return rejected(correctionId, 'AUTHORITY_NOT_SELECTED', cause);
    }
    if (constraint === 'inventory_stock_corrections_reconciles_fk') {
      return conflict(correctionId, 'OPEN_RECONCILIATION_MISMATCH', cause);
    }
  }
  if (code === checkViolationSqlState && constraint === 'inventory_stock_correction_open_transition_ck') {
    return conflict(correctionId, 'OPEN_RECONCILIATION_MISMATCH', cause);
  }
  if (code === checkViolationSqlState && constraint === 'inventory_stock_corrections_exact_scope_ck') {
    return rejected(correctionId, 'SOURCE_ASSERTION_SCOPE_MISMATCH', cause);
  }
  if (code === checkViolationSqlState && constraint === 'inventory_stock_corrections_evidence_ck') {
    return rejected(correctionId, 'CORRECTION_NOT_PERMITTED', cause);
  }
  return unavailable(correctionId, cause);
};

const positionRefFor = (row: StockPositionRow) => ({
  moduleId: INVENTORY_MODULE_ID,
  resourceId: row.stockPositionId,
  resourceType: STOCK_POSITION_RESOURCE_TYPE,
  tenantId: row.tenantId,
});

const unitRefFor = (row: StockPositionRow) => ({
  moduleId: row.stockUnitModuleId,
  resourceId: row.stockUnitResourceId,
  resourceType: row.stockUnitResourceType,
  tenantId: row.stockUnitTenantId,
});

const authorityRefFor = (row: StockPositionRow) => ({
  moduleId: INVENTORY_MODULE_ID,
  resourceId: row.ownerConfigurationId,
  resourceType: 'commerce.inventory.inventory-backend-configuration' as const,
  tenantId: row.tenantId,
});

const storedNumericPattern = /^(?<integer>[0-9]+)(?:\.(?<fraction>[0-9]+))?$/u;

const canonicalAmount = (amount: string | null): string => {
  if (amount === null) {
    return '';
  }
  const groups = storedNumericPattern.exec(amount)?.groups;
  if (groups?.['integer'] === undefined) {
    return amount;
  }
  const integer = BigInt(groups['integer']).toString();
  const fraction = (groups['fraction'] ?? '').replace(/0+$/u, '');
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
};

const onHandFor = (row: StockPositionRow) => {
  const ownerConfigurationRef = authorityRefFor(row);
  const unitRef = unitRefFor(row);
  if (row.onHandState === 'CURRENT') {
    return {
      _tag: 'CURRENT',
      evidenceRef: row.onHandEvidenceRef ?? '',
      meaning: 'ON_HAND',
      observedAt: row.onHandObservedAt?.toISOString() ?? '',
      ownerConfigurationRef,
      quantity: { amount: canonicalAmount(row.onHandAmount), unitRef },
    } as const;
  }
  if (row.onHandState === 'STALE') {
    return {
      _tag: 'STALE',
      evidenceRef: row.onHandEvidenceRef ?? '',
      lastKnownQuantity: { amount: canonicalAmount(row.onHandAmount), unitRef },
      lastObservedAt: row.onHandObservedAt?.toISOString() ?? '',
      meaning: 'ON_HAND',
      ownerConfigurationRef,
    } as const;
  }
  return { _tag: row.onHandState, meaning: 'ON_HAND' as const, ownerConfigurationRef, unitRef };
};

const decodePositionRow = (row: StockPositionRow) =>
  Schema.decodeUnknownEffect(StockPositionSchema)({
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    lifecycle: row.lifecycleState,
    onHand: onHandFor(row),
    ref: positionRefFor(row),
    revision: row.revision,
    scope: {
      customerConfigurationId: row.customerConfigurationId,
      stockItemRef: {
        moduleId: INVENTORY_MODULE_ID,
        resourceId: row.stockItemId,
        resourceType: 'commerce.inventory.stock-item',
        tenantId: row.tenantId,
      },
      stockLocationRef: {
        moduleId: INVENTORY_MODULE_ID,
        resourceId: row.stockLocationId,
        resourceType: 'commerce.inventory.stock-location',
        tenantId: row.tenantId,
      },
      unitRef: unitRefFor(row),
    },
  }).pipe(Effect.mapError((cause) => unavailable(undefined, cause)));

const evidenceValues = (onHand: StockPositionOnHandEvidence) =>
  Match.value(onHand).pipe(
    Match.tag('CURRENT', (current) => ({
      onHandAmount: current.quantity.amount,
      onHandEvidenceRef: current.evidenceRef,
      onHandObservedAt: DateTime.toDateUtc(DateTime.makeUnsafe(current.observedAt)),
      onHandState: current._tag,
      ownerConfigurationId: current.ownerConfigurationRef.resourceId,
    })),
    Match.tag('STALE', (stale) => ({
      onHandAmount: stale.lastKnownQuantity.amount,
      onHandEvidenceRef: stale.evidenceRef,
      onHandObservedAt: DateTime.toDateUtc(DateTime.makeUnsafe(stale.lastObservedAt)),
      onHandState: stale._tag,
      ownerConfigurationId: stale.ownerConfigurationRef.resourceId,
    })),
    Match.tag('UNKNOWN', 'MISSING', 'INDETERMINATE', (indeterminate) => ({
      onHandAmount: null,
      onHandEvidenceRef: null,
      onHandObservedAt: null,
      onHandState: indeterminate._tag,
      ownerConfigurationId: indeterminate.ownerConfigurationRef.resourceId,
    })),
    Match.exhaustive,
  );

const decodeCorrectionRow = (row: typeof inventoryStockCorrections.$inferSelect) =>
  Schema.decodeEffect(StockCorrectionRecordSchema)(row.recordJson).pipe(
    Effect.mapError((cause) => unavailable(undefined, cause)),
  );

const physicalEffectCandidate = (row: typeof inventoryPhysicalStockEffects.$inferSelect) => {
  if (row.state === 'APPLIED') {
    return { _tag: row.state, evidence: row.evidenceJson, request: row.requestJson };
  }
  if (row.state === 'REJECTED' || row.state === 'INDETERMINATE') {
    return { _tag: row.state, reason: row.terminalReason, request: row.requestJson };
  }
  return { _tag: 'REQUESTED', request: row.requestJson };
};

const decodePhysicalEffectRow = (row: typeof inventoryPhysicalStockEffects.$inferSelect) =>
  Schema.decodeEffect(PhysicalStockEffectIdSchema)(row.effectId).pipe(
    Effect.mapError((cause) => unavailable(undefined, cause)),
    Effect.flatMap(() =>
      Schema.decodeUnknownEffect(PhysicalStockEffectRecordSchema)(physicalEffectCandidate(row)).pipe(
        Effect.mapError((cause) => unavailable(undefined, cause)),
      ),
    ),
  );

const sameRef = (
  left: { readonly resourceId: string; readonly tenantId: string },
  right: { readonly resourceId: string; readonly tenantId: string },
) => left.resourceId === right.resourceId && left.tenantId === right.tenantId;

const sameUnit = (left: StockPosition['scope']['unitRef'], right: StockPosition['scope']['unitRef']) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const validEvidenceBranch = (correction: StockCorrectionRecord): boolean => {
  if (correction.evidenceKind === 'EXTERNAL_SOURCE_ASSERTION') {
    return correction.sourceAssertionId !== null && correction.issuer.backendKind === 'external_business_system';
  }
  return correction.sourceAssertionId === null && correction.issuer.backendKind === 'ontos_wms';
};

const validateCorrectionOutcome = (correction: StockCorrectionRecord, nextPosition: StockPosition) => {
  if (Schema.is(AppliedStockCorrectionSchema)(correction)) {
    if (!Schema.is(CurrentOnHandEvidenceSchema)(nextPosition.onHand)) {
      return rejected(correction.correctionId, 'CORRECTION_NOT_PERMITTED');
    }
    if (!sameUnit(correction.correctedQuantity.unitRef, nextPosition.onHand.quantity.unitRef)) {
      return rejected(correction.correctionId, 'UNIT_MISMATCH');
    }
    return correction.correctedQuantity.amount === nextPosition.onHand.quantity.amount
      ? null
      : rejected(correction.correctionId, 'SOURCE_ASSERTION_SCOPE_MISMATCH');
  }
  return Schema.is(IndeterminateOnHandEvidenceSchema)(nextPosition.onHand)
    ? null
    : rejected(correction.correctionId, 'CORRECTION_NOT_PERMITTED');
};

const validateApply = (
  correction: StockCorrectionRecord,
  nextPosition: StockPosition,
  expectedPositionRevision: number,
  reconcilesCorrectionId: StockCorrectionId | undefined,
  tenantId: string,
) => {
  if (correction.positionRef.tenantId !== tenantId || nextPosition.ref.tenantId !== tenantId) {
    return rejected(correction.correctionId, 'TENANT_SCOPE_MISMATCH');
  }
  if (
    !Schema.is(StockCorrectionRecordSchema)(correction) ||
    !Schema.is(StockPositionSchema)(nextPosition) ||
    !sameRef(correction.positionRef, nextPosition.ref)
  ) {
    return rejected(correction.correctionId, 'SOURCE_ASSERTION_SCOPE_MISMATCH');
  }
  if (
    correction.customerConfigurationId !== nextPosition.scope.customerConfigurationId ||
    correction.authorityConfigurationRef.resourceId !== nextPosition.onHand.ownerConfigurationRef.resourceId
  ) {
    return rejected(correction.correctionId, 'CUSTOMER_CONFIGURATION_MISMATCH');
  }
  if (
    correction.expectedPositionRevision !== expectedPositionRevision ||
    correction.positionRevisionAfter !== nextPosition.revision ||
    nextPosition.revision !== expectedPositionRevision + 1
  ) {
    return conflict(correction.correctionId, 'POSITION_REVISION_CONFLICT');
  }
  if (nextPosition.lifecycle !== 'CURRENT' || nextPosition.endedAt !== null) {
    return rejected(correction.correctionId, 'POSITION_NOT_CURRENT');
  }
  if (correction.reconcilesCorrectionId !== (reconcilesCorrectionId ?? null)) {
    return conflict(correction.correctionId, 'OPEN_RECONCILIATION_MISMATCH');
  }
  if (!validEvidenceBranch(correction)) {
    return rejected(correction.correctionId, 'CORRECTION_NOT_PERMITTED');
  }
  return validateCorrectionOutcome(correction, nextPosition);
};

/** Keeps the mutually exclusive owner-evidence identity explicit in the relational insert. */
export const stockCorrectionEvidenceIdentityValues = (
  correction: Pick<StockCorrectionRecord, 'evidenceKind' | 'sourceAssertionId' | 'sourceEvidenceId'>,
) => ({
  evidenceKind: correction.evidenceKind,
  sourceAssertionId: correction.sourceAssertionId,
  sourceEvidenceId: correction.sourceEvidenceId,
});

export const stockCorrectionPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: Pick<OperationalScope, 'tenantId'>,
): StockCorrectionPersistence => {
  const correctionRows = (correctionId: StockCorrectionId) =>
    transaction
      .select()
      .from(inventoryStockCorrections)
      .where(
        and(
          eq(inventoryStockCorrections.tenantId, scope.tenantId),
          eq(inventoryStockCorrections.correctionId, correctionId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError((cause) => unavailable(correctionId, cause)));

  const positionRows = (positionRef: StockPositionRef) =>
    transaction
      .select()
      .from(inventoryStockPositions)
      .where(
        and(
          eq(inventoryStockPositions.tenantId, scope.tenantId),
          eq(inventoryStockPositions.stockPositionId, positionRef.resourceId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError((cause) => unavailable(undefined, cause)));

  const read: StockCorrectionPersistence['read'] = (correctionId) =>
    correctionRows(correctionId).pipe(
      Effect.flatMap(([row]) =>
        row === undefined ? Effect.succeedNone : decodeCorrectionRow(row).pipe(Effect.asSome),
      ),
    );

  const openReconciliationRows = (positionRef: StockPositionRef, forUpdate: boolean) => {
    const query = transaction
      .select({ correction: inventoryStockCorrections })
      .from(inventoryStockCorrectionOpenReconciliations)
      .innerJoin(
        inventoryStockCorrections,
        and(
          eq(inventoryStockCorrections.tenantId, inventoryStockCorrectionOpenReconciliations.tenantId),
          eq(inventoryStockCorrections.correctionId, inventoryStockCorrectionOpenReconciliations.correctionId),
        ),
      )
      .where(
        and(
          eq(inventoryStockCorrectionOpenReconciliations.tenantId, scope.tenantId),
          eq(inventoryStockCorrectionOpenReconciliations.positionId, positionRef.resourceId),
        ),
      )
      .limit(1);
    return (forUpdate ? query.for('update') : query).pipe(Effect.mapError((cause) => unavailable(undefined, cause)));
  };

  const findOpenIndeterminate: StockCorrectionPersistence['findOpenIndeterminate'] = (positionRef) => {
    if (positionRef.tenantId === scope.tenantId) {
      return openReconciliationRows(positionRef, false).pipe(
        Effect.flatMap(([row]) =>
          row === undefined ? Effect.succeedNone : decodeCorrectionRow(row.correction).pipe(Effect.asSome),
        ),
      );
    }
    return Effect.fail(unavailable());
  };

  const listAppliedEffectsForPosition: StockCorrectionPersistence['listAppliedEffectsForPosition'] = (positionRef) => {
    if (positionRef.tenantId !== scope.tenantId) {
      return Effect.fail(unavailable());
    }
    return transaction
      .select()
      .from(inventoryPhysicalStockEffects)
      .where(
        and(
          eq(inventoryPhysicalStockEffects.tenantId, scope.tenantId),
          eq(inventoryPhysicalStockEffects.positionId, positionRef.resourceId),
          eq(inventoryPhysicalStockEffects.state, 'APPLIED'),
        ),
      )
      .orderBy(asc(inventoryPhysicalStockEffects.requestedAt), asc(inventoryPhysicalStockEffects.effectId))
      .pipe(
        Effect.mapError((cause) => unavailable(undefined, cause)),
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodePhysicalEffectRow(row), { concurrency: 1 })),
        Effect.map((effects): readonly PhysicalStockEffectRecord[] => effects),
      );
  };

  const readCurrentPosition = Effect.fn('StockCorrectionPersistence.readCurrentPosition')(function* readPosition(
    positionRef: StockPositionRef,
    correctionId: StockCorrectionId,
  ) {
    const [row] = yield* positionRows(positionRef);
    if (row === undefined) {
      return yield* rejected(correctionId, 'POSITION_NOT_FOUND');
    }
    return yield* decodePositionRow(row).pipe(Effect.mapError((cause) => unavailable(correctionId, cause)));
  });

  const apply: StockCorrectionPersistence['apply'] = Effect.fn('StockCorrectionPersistence.apply')(
    function* applyCorrection(correction, nextPosition, expectedPositionRevision, reconcilesCorrectionId) {
      const invalid = validateApply(
        correction,
        nextPosition,
        expectedPositionRevision,
        reconcilesCorrectionId,
        scope.tenantId,
      );
      if (invalid !== null) {
        return yield* invalid;
      }

      const [known] = yield* correctionRows(correction.correctionId);
      if (known !== undefined) {
        return {
          correction: yield* decodeCorrectionRow(known),
          outcome: 'EXISTING' as const,
          position: yield* readCurrentPosition(correction.positionRef, correction.correctionId),
        };
      }

      const [open] = yield* openReconciliationRows(correction.positionRef, true);
      const openCorrectionId = open?.correction.correctionId;
      if (openCorrectionId !== reconcilesCorrectionId) {
        return yield* conflict(correction.correctionId, 'OPEN_RECONCILIATION_MISMATCH');
      }

      const [inserted] = yield* transaction
        .insert(inventoryStockCorrections)
        .values({
          actionInvocationId: correction.actionInvocationId,
          appliedAt: DateTime.toDateUtc(DateTime.makeUnsafe(correction.appliedAt)),
          authorityConfigurationId: correction.authorityConfigurationRef.resourceId,
          businessObservedAt: DateTime.toDateUtc(DateTime.makeUnsafe(correction.businessObservedAt)),
          correctedQuantityAmount: Match.value(correction).pipe(
            Match.tag('APPLIED', ({ correctedQuantity }) => correctedQuantity.amount),
            Match.tag('INDETERMINATE', () => null),
            Match.exhaustive,
          ),
          correctionId: correction.correctionId,
          coverageEvidenceJson: correction.coverageEvidence,
          customerConfigurationId: correction.customerConfigurationId,
          evaluatedMaterialEffectIdsJson: correction.evaluatedMaterialEffectIds,
          ...stockCorrectionEvidenceIdentityValues(correction),
          expectedPositionRevision,
          issuerBackendId: correction.issuer.backendId,
          issuerBackendKind: correction.issuer.backendKind,
          ownerEvidenceRef: correction.ownerEvidenceRef,
          positionId: correction.positionRef.resourceId,
          positionRevisionAfter: correction.positionRevisionAfter,
          principalId: correction.principalId,
          reconcilesCorrectionId: reconcilesCorrectionId ?? null,
          recordJson: correction,
          sourceReference: correction.sourceReference,
          state: correction._tag,
          tenantId: scope.tenantId,
        })
        .onConflictDoNothing({ target: inventoryStockCorrections.correctionId })
        .returning()
        .pipe(Effect.mapError((cause) => mapCorrectionWriteError(correction.correctionId, cause)));

      if (inserted === undefined) {
        const [existing] = yield* correctionRows(correction.correctionId);
        if (existing === undefined) {
          return yield* unavailable(correction.correctionId);
        }
        return {
          correction: yield* decodeCorrectionRow(existing),
          outcome: 'EXISTING' as const,
          position: yield* readCurrentPosition(correction.positionRef, correction.correctionId),
        };
      }

      const now = DateTime.toDateUtc(yield* DateTime.now);
      const [updatedPosition] = yield* transaction
        .update(inventoryStockPositions)
        .set({ ...evidenceValues(nextPosition.onHand), revision: nextPosition.revision, updatedAt: now })
        .where(
          and(
            eq(inventoryStockPositions.tenantId, scope.tenantId),
            eq(inventoryStockPositions.stockPositionId, nextPosition.ref.resourceId),
            eq(inventoryStockPositions.lifecycleState, 'CURRENT'),
            eq(inventoryStockPositions.revision, expectedPositionRevision),
          ),
        )
        .returning()
        .pipe(Effect.mapError((cause) => mapCorrectionWriteError(correction.correctionId, cause)));
      if (updatedPosition === undefined) {
        const [observed] = yield* positionRows(correction.positionRef);
        if (observed === undefined) {
          return yield* rejected(correction.correctionId, 'POSITION_NOT_FOUND');
        }
        if (observed.lifecycleState === 'CURRENT') {
          return yield* conflict(correction.correctionId, 'POSITION_REVISION_CONFLICT');
        }
        return yield* rejected(correction.correctionId, 'POSITION_NOT_CURRENT');
      }

      if (Schema.is(IndeterminateStockCorrectionSchema)(correction)) {
        yield* transaction
          .insert(inventoryStockCorrectionOpenReconciliations)
          .values({
            correctionId: correction.correctionId,
            positionId: correction.positionRef.resourceId,
            tenantId: scope.tenantId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            set: { correctionId: correction.correctionId, updatedAt: now },
            target: [
              inventoryStockCorrectionOpenReconciliations.tenantId,
              inventoryStockCorrectionOpenReconciliations.positionId,
            ],
          })
          .pipe(Effect.mapError((cause) => mapCorrectionWriteError(correction.correctionId, cause)));
      } else if (openCorrectionId !== undefined) {
        yield* transaction
          .delete(inventoryStockCorrectionOpenReconciliations)
          .where(
            and(
              eq(inventoryStockCorrectionOpenReconciliations.tenantId, scope.tenantId),
              eq(inventoryStockCorrectionOpenReconciliations.positionId, correction.positionRef.resourceId),
              eq(inventoryStockCorrectionOpenReconciliations.correctionId, openCorrectionId),
            ),
          )
          .pipe(Effect.mapError((cause) => mapCorrectionWriteError(correction.correctionId, cause)));
      }

      return {
        correction: yield* decodeCorrectionRow(inserted),
        outcome: 'INSERTED' as const,
        position: yield* decodePositionRow(updatedPosition).pipe(
          Effect.mapError((cause) => unavailable(correction.correctionId, cause)),
        ),
      };
    },
  );

  return Object.freeze({ apply, findOpenIndeterminate, listAppliedEffectsForPosition, read });
};
