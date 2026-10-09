import { findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  ExternalStockCorrelationSchema,
  ExternalStockItemTargetSchema,
  ExternalStockLocationTargetSchema,
} from '../../shared/domain/external-stock-correlation.ts';
import type {
  ExternalStockCorrelation,
  ExternalStockCorrelationPersistence,
  ExternalStockCorrelationPersistenceError,
  ExternalStockKey,
} from '../../shared/domain/external-stock-correlation.ts';
import { ExternalStockCorrelationPersistenceUnavailable } from '../../shared/domain/external-stock-correlation-persistence-unavailable.ts';
import { ExternalStockCorrelationRejected } from '../../shared/domain/external-stock-correlation-rejected.ts';
import type { ExternalStockCorrelationRef } from '../../shared/resources/external-stock-correlation.ts';
import { inventoryExternalStockCorrelations } from './external-stock-correlation-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type CorrelationRow = typeof inventoryExternalStockCorrelations.$inferSelect;
const INVENTORY_MODULE_ID = 'commerce.inventory' as const;

const unavailable = (cause?: unknown) => {
  const failure = new ExternalStockCorrelationPersistenceUnavailable({
    code: 'external_stock_correlation_persistence_unavailable',
    reason: 'External Stock Correlation persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const reject = (reason: ExternalStockCorrelationRejected['reason'], correlationRef?: ExternalStockCorrelationRef) =>
  correlationRef === undefined
    ? new ExternalStockCorrelationRejected({ code: 'external_stock_correlation_rejected', reason })
    : new ExternalStockCorrelationRejected({
        code: 'external_stock_correlation_rejected',
        correlationRef,
        reason,
      });

const uniqueViolationSqlState = ['23', '505'].join('');
const foreignKeyViolationSqlState = ['23', '503'].join('');
const exclusionViolationSqlState = ['23', 'P01'].join('');
const overlapConstraint = 'inventory_external_stock_correlations_current_key_uk';

export const mapExternalStockCorrelationWriteError = (cause: unknown): ExternalStockCorrelationPersistenceError => {
  const targetMissing = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === foreignKeyViolationSqlState &&
      ['inventory_external_stock_correlations_item_fk', 'inventory_external_stock_correlations_location_fk'].includes(
        constraint ?? '',
      ),
  );
  if (Option.isSome(targetMissing)) {
    return reject('TARGET_NOT_FOUND');
  }
  const overlap = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      (code === uniqueViolationSqlState && constraint === overlapConstraint) ||
      (code === exclusionViolationSqlState &&
        constraint === 'inventory_external_stock_correlations_effective_period_excl'),
  );
  if (Option.isSome(overlap)) {
    return reject('OVERLAPPING_EFFECTIVE_PERIOD');
  }
  const identity = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState &&
      ['external_stock_correlations_pkey', 'inventory_external_stock_correlations_scope_id_uk'].includes(
        constraint ?? '',
      ),
  );
  return Option.isSome(identity) ? reject('CORRELATION_IDENTITY_CONFLICT') : unavailable(cause);
};

const instantAsDate = (instant: string) => DateTime.toDateUtc(DateTime.makeUnsafe(instant));

const correlationRefFor = (row: CorrelationRow) => ({
  moduleId: INVENTORY_MODULE_ID,
  resourceId: row.correlationId,
  resourceType: 'commerce.inventory.external-stock-correlation' as const,
  tenantId: row.tenantId,
});

const targetFor = (row: CorrelationRow) =>
  row.identifierKind === 'ITEM'
    ? {
        _tag: 'STOCK_ITEM' as const,
        ref: {
          moduleId: INVENTORY_MODULE_ID,
          resourceId: row.stockItemId ?? '',
          resourceType: 'commerce.inventory.stock-item' as const,
          tenantId: row.tenantId,
        },
      }
    : {
        _tag: 'STOCK_LOCATION' as const,
        ref: {
          moduleId: INVENTORY_MODULE_ID,
          resourceId: row.stockLocationId ?? '',
          resourceType: 'commerce.inventory.stock-location' as const,
          tenantId: row.tenantId,
        },
      };

const decodeRow = (row: CorrelationRow) =>
  Schema.decodeUnknownEffect(ExternalStockCorrelationSchema)({
    confirmedAt: row.confirmedAt.toISOString(),
    correlationRef: correlationRefFor(row),
    effectivePeriod: {
      from: row.effectiveFrom.toISOString(),
      to: row.effectiveTo?.toISOString() ?? null,
    },
    externalKey: {
      customerConfigurationId: row.customerConfigurationId,
      externalScope: row.externalScope,
      externalValue: row.externalValue,
      identifierKind: row.identifierKind,
      issuer: { backendId: row.issuerBackendId, backendKind: row.issuerBackendKind },
      namespace: row.namespace,
      tenantId: row.tenantId,
    },
    lifecycle: row.lifecycleState,
    ownerEvidenceRef: row.ownerEvidenceRef,
    revision: row.revision,
    target: targetFor(row),
  }).pipe(Effect.mapError(unavailable));

const insertValues = (correlation: ExternalStockCorrelation) => ({
  confirmedAt: instantAsDate(correlation.confirmedAt),
  correlationId: correlation.correlationRef.resourceId,
  customerConfigurationId: correlation.externalKey.customerConfigurationId,
  effectiveFrom: instantAsDate(correlation.effectivePeriod.from),
  effectiveTo: correlation.effectivePeriod.to === null ? null : instantAsDate(correlation.effectivePeriod.to),
  externalScope: correlation.externalKey.externalScope,
  externalValue: correlation.externalKey.externalValue,
  identifierKind: correlation.externalKey.identifierKind,
  issuerBackendId: correlation.externalKey.issuer.backendId,
  issuerBackendKind: correlation.externalKey.issuer.backendKind,
  lifecycleState: correlation.lifecycle,
  namespace: correlation.externalKey.namespace,
  ownerEvidenceRef: correlation.ownerEvidenceRef,
  revision: correlation.revision,
  stockItemId: Schema.is(ExternalStockItemTargetSchema)(correlation.target) ? correlation.target.ref.resourceId : null,
  stockLocationId: Schema.is(ExternalStockLocationTargetSchema)(correlation.target)
    ? correlation.target.ref.resourceId
    : null,
  tenantId: correlation.correlationRef.tenantId,
});

const exactKeyPredicate = (externalKey: ExternalStockKey) =>
  and(
    eq(inventoryExternalStockCorrelations.tenantId, externalKey.tenantId),
    eq(inventoryExternalStockCorrelations.customerConfigurationId, externalKey.customerConfigurationId),
    eq(inventoryExternalStockCorrelations.issuerBackendKind, externalKey.issuer.backendKind),
    eq(inventoryExternalStockCorrelations.issuerBackendId, externalKey.issuer.backendId),
    eq(inventoryExternalStockCorrelations.namespace, externalKey.namespace),
    eq(inventoryExternalStockCorrelations.externalScope, externalKey.externalScope),
    eq(inventoryExternalStockCorrelations.identifierKind, externalKey.identifierKind),
    eq(inventoryExternalStockCorrelations.externalValue, externalKey.externalValue),
  );

export const externalStockCorrelationPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): ExternalStockCorrelationPersistence => {
  const requireTenant = (tenantId: string, correlationRef?: ExternalStockCorrelationRef) =>
    tenantId === scope.tenantId ? Effect.void : Effect.fail(reject('TENANT_SCOPE_MISMATCH', correlationRef));

  const findByRef: ExternalStockCorrelationPersistence['findByRef'] = Effect.fn(
    'ExternalStockCorrelationPersistence.findByRef',
  )(function* findCorrelationByRef(correlationRef) {
    yield* requireTenant(correlationRef.tenantId, correlationRef);
    const [row] = yield* transaction
      .select()
      .from(inventoryExternalStockCorrelations)
      .where(
        and(
          eq(inventoryExternalStockCorrelations.tenantId, scope.tenantId),
          eq(inventoryExternalStockCorrelations.correlationId, correlationRef.resourceId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    return row === undefined ? Option.none<ExternalStockCorrelation>() : Option.some(yield* decodeRow(row));
  });

  const findEffective: ExternalStockCorrelationPersistence['findEffective'] = Effect.fn(
    'ExternalStockCorrelationPersistence.findEffective',
  )(function* findEffectiveCorrelation(externalKey, asOf) {
    yield* requireTenant(externalKey.tenantId);
    const instant = instantAsDate(asOf);
    const rows = yield* transaction
      .select()
      .from(inventoryExternalStockCorrelations)
      .where(
        and(
          exactKeyPredicate(externalKey),
          lte(inventoryExternalStockCorrelations.effectiveFrom, instant),
          or(
            isNull(inventoryExternalStockCorrelations.effectiveTo),
            gt(inventoryExternalStockCorrelations.effectiveTo, instant),
          ),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    return yield* Effect.forEach(rows, decodeRow, { concurrency: 1 });
  });

  const insertCurrent: ExternalStockCorrelationPersistence['insertCurrent'] = Effect.fn(
    'ExternalStockCorrelationPersistence.insertCurrent',
  )(function* insertCurrentCorrelation(correlation) {
    yield* requireTenant(correlation.correlationRef.tenantId, correlation.correlationRef);
    const [row] = yield* transaction
      .insert(inventoryExternalStockCorrelations)
      .values(insertValues(correlation))
      .returning()
      .pipe(Effect.mapError(mapExternalStockCorrelationWriteError));
    return row === undefined
      ? yield* unavailable('External Stock Correlation insert returned no row')
      : yield* decodeRow(row);
  });

  const endRow = Effect.fn('ExternalStockCorrelationPersistence.endRow')(function* endCorrelationRow(
    current: ExternalStockCorrelation,
    endedAt: string,
  ) {
    yield* requireTenant(current.correlationRef.tenantId, current.correlationRef);
    const [row] = yield* transaction
      .update(inventoryExternalStockCorrelations)
      .set({
        effectiveTo: instantAsDate(endedAt),
        lifecycleState: 'ENDED',
        revision: current.revision + 1,
      })
      .where(
        and(
          eq(inventoryExternalStockCorrelations.tenantId, scope.tenantId),
          eq(inventoryExternalStockCorrelations.correlationId, current.correlationRef.resourceId),
          eq(inventoryExternalStockCorrelations.revision, current.revision),
          eq(inventoryExternalStockCorrelations.lifecycleState, 'CURRENT'),
          isNull(inventoryExternalStockCorrelations.effectiveTo),
        ),
      )
      .returning()
      .pipe(Effect.mapError(mapExternalStockCorrelationWriteError));
    return row === undefined
      ? yield* reject('CORRELATION_REVISION_CONFLICT', current.correlationRef)
      : yield* decodeRow(row);
  });

  const endCurrent: ExternalStockCorrelationPersistence['endCurrent'] = ({ current, endedAt }) =>
    endRow(current, endedAt);

  const replaceCurrent: ExternalStockCorrelationPersistence['replaceCurrent'] = Effect.fn(
    'ExternalStockCorrelationPersistence.replaceCurrent',
  )(function* replaceCurrentCorrelation({ current, endedAt, replacement }) {
    yield* endRow(current, endedAt);
    return yield* insertCurrent(replacement);
  });

  const saveConfirmation: ExternalStockCorrelationPersistence['saveConfirmation'] = Effect.fn(
    'ExternalStockCorrelationPersistence.saveConfirmation',
  )(function* saveCorrelationConfirmation({ expectedRevision, next }) {
    yield* requireTenant(next.correlationRef.tenantId, next.correlationRef);
    const [row] = yield* transaction
      .update(inventoryExternalStockCorrelations)
      .set({
        confirmedAt: instantAsDate(next.confirmedAt),
        ownerEvidenceRef: next.ownerEvidenceRef,
        revision: next.revision,
      })
      .where(
        and(
          eq(inventoryExternalStockCorrelations.tenantId, scope.tenantId),
          eq(inventoryExternalStockCorrelations.correlationId, next.correlationRef.resourceId),
          eq(inventoryExternalStockCorrelations.revision, expectedRevision),
          eq(inventoryExternalStockCorrelations.lifecycleState, 'CURRENT'),
        ),
      )
      .returning()
      .pipe(Effect.mapError(mapExternalStockCorrelationWriteError));
    return row === undefined
      ? yield* reject('CORRELATION_REVISION_CONFLICT', next.correlationRef)
      : yield* decodeRow(row);
  });

  return Object.freeze({ endCurrent, findByRef, findEffective, insertCurrent, replaceCurrent, saveConfirmation });
};
