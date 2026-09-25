import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import type { Effect as EffectType } from 'effect';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import { OwnerOrderKeyEvidenceSchema } from '../../shared/domain/inventory-source-assertion.ts';
import {
  OntosWmsCorrectionCoverageEvidenceSchema,
  OntosWmsStockCorrectionSourceEvidenceSchema,
  StockCorrectionUnavailable,
} from '../../shared/domain/stock-correction.ts';
import type {
  OntosWmsStockCorrectionSourceEvidence,
  StockCorrectionSourceEvidenceId,
} from '../../shared/domain/stock-correction.ts';
import type { StockCorrectionSourceEvidencePersistence } from '../services/stock-correction.service.ts';
import {
  inventoryStockCorrectionSourceEvidence,
  inventoryStockCorrectionSourceEvidenceCoverage,
  inventoryStockCorrectionSourceEvidenceCurrent,
} from './stock-correction-source-evidence-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

/** This writer is private to the trusted OntOS WMS owner boundary; Action payloads never receive it. */
export interface TrustedStockCorrectionSourceEvidencePersistence extends StockCorrectionSourceEvidencePersistence {
  readonly appendTrusted: (
    evidence: OntosWmsStockCorrectionSourceEvidence,
  ) => EffectType.Effect<OntosWmsStockCorrectionSourceEvidence, StockCorrectionUnavailable>;
}

const unavailable = (evidenceId?: StockCorrectionSourceEvidenceId, cause?: unknown) => {
  const failure = new StockCorrectionUnavailable({
    code: 'stock_correction_unavailable',
    reason:
      evidenceId === undefined
        ? 'OntOS WMS correction evidence is temporarily unavailable'
        : `OntOS WMS correction evidence ${evidenceId} is temporarily unavailable`,
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const instantAsDate = (instant: string) => DateTime.toDateUtc(DateTime.makeUnsafe(instant));

const orderingValue = (evidence: OntosWmsStockCorrectionSourceEvidence) =>
  Match.value(evidence.orderingEvidence).pipe(
    Match.tag('OWNER_ORDER_KEY', ({ key }) => key),
    Match.tag('SOURCE_REVISION', ({ revision }) => revision),
    Match.exhaustive,
  );

const evidenceValues = (evidence: OntosWmsStockCorrectionSourceEvidence) => ({
  authorityConfigurationId: evidence.authorityConfiguration.configurationId,
  businessObservedAt: instantAsDate(evidence.businessObservedAt),
  customerConfigurationId: evidence.customerConfigurationId,
  evidenceId: evidence.evidenceId,
  evidenceJson: evidence,
  factMeaning: evidence.factMeaning,
  issuerBackendId: evidence.issuer.backendId,
  issuerBackendKind: evidence.issuer.backendKind,
  orderingEvidenceKind: evidence.orderingEvidence._tag,
  orderingEvidenceValue: orderingValue(evidence),
  ownerEvidenceRef: evidence.ownerEvidenceRef,
  positionId: evidence.positionRef.resourceId,
  quantityAmount: evidence.quantity.amount,
  receivedAt: instantAsDate(evidence.receivedAt),
  sourceReference: evidence.sourceReference,
  stockItemId: evidence.stockItemRef.resourceId,
  stockLocationId: evidence.stockLocationRef.resourceId,
  tenantId: evidence.positionRef.tenantId,
  unitModuleId: evidence.quantity.unitRef.moduleId,
  unitResourceId: evidence.quantity.unitRef.resourceId,
  unitResourceType: evidence.quantity.unitRef.resourceType,
  unitTenantId: evidence.quantity.unitRef.tenantId,
});

const coverageMatches = (
  expected: OntosWmsStockCorrectionSourceEvidence['coverage'],
  actual: readonly (typeof inventoryStockCorrectionSourceEvidenceCoverage.$inferSelect)[],
) =>
  expected.length === actual.length &&
  expected.every((entry) =>
    actual.some(
      (row) =>
        row.evidenceId === entry.evidenceId &&
        row.effectId === entry.effectId &&
        row.ownerEvidenceRef === entry.ownerEvidenceRef &&
        row.relation === entry.relation,
    ),
  );

const isTrustedAppend = (evidence: OntosWmsStockCorrectionSourceEvidence, tenantId: string) =>
  Schema.is(OntosWmsStockCorrectionSourceEvidenceSchema)(evidence) &&
  evidence.positionRef.tenantId === tenantId &&
  evidence.authorityConfiguration.tenantId === tenantId &&
  evidence.authorityConfiguration.selection.backend === 'ontos_wms' &&
  evidence.authorityConfiguration.selection.stockCorrectionCapability === 'SUPPORTED' &&
  Schema.is(OwnerOrderKeyEvidenceSchema)(evidence.orderingEvidence) &&
  DateTime.toEpochMillis(DateTime.makeUnsafe(evidence.businessObservedAt)) >=
    DateTime.toEpochMillis(DateTime.makeUnsafe(evidence.authorityConfiguration.selectedAt));

export const stockCorrectionSourceEvidencePersistenceForScope = (
  transaction: ScopedTransaction,
  scope: Pick<OperationalScope, 'tenantId'>,
): TrustedStockCorrectionSourceEvidencePersistence => {
  const findCurrentById: StockCorrectionSourceEvidencePersistence['findCurrentById'] = Effect.fn(
    'StockCorrectionSourceEvidencePersistence.findCurrentById',
  )(function* findCurrentStockCorrectionSourceEvidence(evidenceId) {
    const [row] = yield* transaction
      .select({ evidenceJson: inventoryStockCorrectionSourceEvidence.evidenceJson })
      .from(inventoryStockCorrectionSourceEvidence)
      .innerJoin(
        inventoryStockCorrectionSourceEvidenceCurrent,
        and(
          eq(inventoryStockCorrectionSourceEvidenceCurrent.tenantId, inventoryStockCorrectionSourceEvidence.tenantId),
          eq(
            inventoryStockCorrectionSourceEvidenceCurrent.customerConfigurationId,
            inventoryStockCorrectionSourceEvidence.customerConfigurationId,
          ),
          eq(
            inventoryStockCorrectionSourceEvidenceCurrent.authorityConfigurationId,
            inventoryStockCorrectionSourceEvidence.authorityConfigurationId,
          ),
          eq(
            inventoryStockCorrectionSourceEvidenceCurrent.positionId,
            inventoryStockCorrectionSourceEvidence.positionId,
          ),
          eq(
            inventoryStockCorrectionSourceEvidenceCurrent.evidenceId,
            inventoryStockCorrectionSourceEvidence.evidenceId,
          ),
          eq(
            inventoryStockCorrectionSourceEvidenceCurrent.orderingEvidenceKind,
            inventoryStockCorrectionSourceEvidence.orderingEvidenceKind,
          ),
          eq(
            inventoryStockCorrectionSourceEvidenceCurrent.orderingEvidenceValue,
            inventoryStockCorrectionSourceEvidence.orderingEvidenceValue,
          ),
        ),
      )
      .where(
        and(
          eq(inventoryStockCorrectionSourceEvidence.tenantId, scope.tenantId),
          eq(inventoryStockCorrectionSourceEvidence.evidenceId, evidenceId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError((cause) => unavailable(evidenceId, cause)));
    if (row === undefined) {
      return Option.none<OntosWmsStockCorrectionSourceEvidence>();
    }
    const coverage = yield* transaction
      .select()
      .from(inventoryStockCorrectionSourceEvidenceCoverage)
      .where(
        and(
          eq(inventoryStockCorrectionSourceEvidenceCoverage.tenantId, scope.tenantId),
          eq(inventoryStockCorrectionSourceEvidenceCoverage.evidenceId, evidenceId),
        ),
      )
      .pipe(Effect.mapError((cause) => unavailable(evidenceId, cause)));
    if (!coverageMatches(row.evidenceJson.coverage, coverage)) {
      return yield* unavailable(evidenceId);
    }
    const decodedCoverage = yield* Effect.forEach(
      coverage,
      (entry) =>
        Schema.decodeUnknownEffect(OntosWmsCorrectionCoverageEvidenceSchema)({
          effectId: entry.effectId,
          evidenceId: entry.evidenceId,
          ownerEvidenceRef: entry.ownerEvidenceRef,
          relation: entry.relation,
        }).pipe(Effect.mapError((cause) => unavailable(evidenceId, cause))),
      { concurrency: 1 },
    );
    const decoded = yield* Schema.decodeEffect(OntosWmsStockCorrectionSourceEvidenceSchema)({
      ...row.evidenceJson,
      coverage: decodedCoverage,
    }).pipe(Effect.mapError((cause) => unavailable(evidenceId, cause)));
    return Option.some(decoded);
  });

  const appendTrusted: TrustedStockCorrectionSourceEvidencePersistence['appendTrusted'] = Effect.fn(
    'StockCorrectionSourceEvidencePersistence.appendTrusted',
  )(function* appendTrustedStockCorrectionSourceEvidence(evidence) {
    if (!isTrustedAppend(evidence, scope.tenantId)) {
      return yield* unavailable(evidence.evidenceId);
    }
    const [inserted] = yield* transaction
      .insert(inventoryStockCorrectionSourceEvidence)
      .values(evidenceValues(evidence))
      .returning({ evidenceJson: inventoryStockCorrectionSourceEvidence.evidenceJson })
      .pipe(Effect.mapError((cause) => unavailable(evidence.evidenceId, cause)));
    if (inserted === undefined) {
      return yield* unavailable(evidence.evidenceId);
    }
    if (evidence.coverage.length > 0) {
      yield* transaction
        .insert(inventoryStockCorrectionSourceEvidenceCoverage)
        .values(
          evidence.coverage.map((entry) => ({
            effectId: entry.effectId,
            evidenceId: entry.evidenceId,
            ownerEvidenceRef: entry.ownerEvidenceRef,
            relation: entry.relation,
            tenantId: scope.tenantId,
          })),
        )
        .pipe(Effect.mapError((cause) => unavailable(evidence.evidenceId, cause)));
    }
    const now = DateTime.toDateUtc(yield* DateTime.now);
    yield* transaction
      .insert(inventoryStockCorrectionSourceEvidenceCurrent)
      .values({
        authorityConfigurationId: evidence.authorityConfiguration.configurationId,
        customerConfigurationId: evidence.customerConfigurationId,
        evidenceId: evidence.evidenceId,
        orderingEvidenceKind: evidence.orderingEvidence._tag,
        orderingEvidenceValue: orderingValue(evidence),
        positionId: evidence.positionRef.resourceId,
        tenantId: scope.tenantId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: {
          evidenceId: evidence.evidenceId,
          orderingEvidenceKind: evidence.orderingEvidence._tag,
          orderingEvidenceValue: orderingValue(evidence),
          updatedAt: now,
        },
        target: [
          inventoryStockCorrectionSourceEvidenceCurrent.tenantId,
          inventoryStockCorrectionSourceEvidenceCurrent.customerConfigurationId,
          inventoryStockCorrectionSourceEvidenceCurrent.authorityConfigurationId,
          inventoryStockCorrectionSourceEvidenceCurrent.positionId,
        ],
      })
      .pipe(Effect.mapError((cause) => unavailable(evidence.evidenceId, cause)));
    return yield* Schema.decodeEffect(OntosWmsStockCorrectionSourceEvidenceSchema)(inserted.evidenceJson).pipe(
      Effect.mapError((cause) => unavailable(evidence.evidenceId, cause)),
    );
  });

  return Object.freeze({ appendTrusted, findCurrentById });
};
