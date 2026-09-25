import { findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  StockSharingEligibilityRejected,
  StockSharingEligibilitySchema,
} from '../../shared/domain/stock-sharing-eligibility.ts';
import type {
  StockSharingEligibility,
  StockSharingEligibilityError,
  StockSharingEligibilityPersistence,
} from '../../shared/domain/stock-sharing-eligibility.ts';
import { StockSharingEligibilityUnavailable } from '../../shared/domain/stock-sharing-eligibility-unavailable.ts';
import type { StockSharingEligibilityRef } from '../../shared/resources/stock-sharing-eligibility.ts';
import {
  inventoryStockSharingEligibilities,
  inventoryStockSharingEligibilityHistory,
  inventoryStockSharingEligibilityScopeTriggerContract,
} from './stock-sharing-eligibility-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type EligibilityRow = typeof inventoryStockSharingEligibilities.$inferSelect;
type HistoryRow = typeof inventoryStockSharingEligibilityHistory.$inferSelect;
const INVENTORY_MODULE_ID = 'commerce.inventory' as const;

const unavailable = (cause?: unknown) => {
  const failure = new StockSharingEligibilityUnavailable({
    code: 'stock_sharing_eligibility_unavailable',
    reason: 'Stock Sharing Eligibility persistence or owner validation is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const reject = (reason: StockSharingEligibilityRejected['reason'], relationRef?: StockSharingEligibilityRef) =>
  relationRef === undefined
    ? new StockSharingEligibilityRejected({ code: 'stock_sharing_eligibility_rejected', reason })
    : new StockSharingEligibilityRejected({ code: 'stock_sharing_eligibility_rejected', reason, relationRef });

const uniqueViolationSqlState = ['23', '505'].join('');
const foreignKeyViolationSqlState = ['23', '503'].join('');
const checkViolationSqlState = ['23', '514'].join('');

export const mapStockSharingEligibilityWriteError = (cause: unknown): StockSharingEligibilityError => {
  const identity = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState &&
      ['stock_sharing_eligibilities_pkey', 'inventory_stock_sharing_eligibilities_scope_id_uk'].includes(
        constraint ?? '',
      ),
  );
  if (Option.isSome(identity)) {
    return reject('RELATION_IDENTITY_CONFLICT');
  }
  const revision = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_stock_sharing_eligibility_history_revision_uk',
  );
  if (Option.isSome(revision)) {
    return reject('REVISION_CONFLICT');
  }
  const { constraintNames } = inventoryStockSharingEligibilityScopeTriggerContract;
  const scope = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      (code === foreignKeyViolationSqlState &&
        [
          'inventory_stock_sharing_eligibilities_backend_configuration_fk',
          'inventory_stock_sharing_eligibilities_position_fk',
        ].includes(constraint ?? '')) ||
      (code === checkViolationSqlState &&
        (constraint === constraintNames.backend || constraint === constraintNames.position)),
  );
  return Option.isSome(scope) ? reject('POSITION_SCOPE_MISMATCH') : unavailable(cause);
};

const instantAsDate = (instant: string) => DateTime.toDateUtc(DateTime.makeUnsafe(instant));

const valuesFor = (relation: StockSharingEligibility) => ({
  channel: relation.subject.channel,
  commerceMarketId: relation.subject.commerceMarketRef?.resourceId ?? null,
  commerceValidationEvidenceRef: relation.commerceValidation.evidenceRef,
  commerceValidationObservedAt: instantAsDate(relation.commerceValidation.observedAt),
  currentRevision: relation.revision,
  customerConfigurationId: relation.scope.customerConfigurationId,
  effectiveFrom: instantAsDate(relation.effectivePeriod.from),
  effectiveTo: relation.effectivePeriod.to === null ? null : instantAsDate(relation.effectivePeriod.to),
  eligibilityId: relation.ref.resourceId,
  lifecycleState: relation.lifecycle,
  ownerConfigurationId: relation.scope.ownerConfigurationRef.resourceId,
  sellingLegalEntityId: relation.subject.sellingLegalEntityRef.resourceId,
  stockPositionId: relation.scope.positionRef.resourceId,
  storefrontAppId: relation.subject.storefrontRef?.appId ?? null,
  tenantId: relation.ref.tenantId,
});

const subjectFor = (row: EligibilityRow) => {
  const required = {
    channel: row.channel,
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: row.sellingLegalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId: row.tenantId,
    },
  };
  const commerceMarketRef =
    row.commerceMarketId === null
      ? undefined
      : {
          moduleId: 'commerce.market-catalog' as const,
          resourceId: row.commerceMarketId,
          resourceType: 'commerce.market-catalog.market' as const,
          tenantId: row.tenantId,
        };
  const storefrontRef =
    row.storefrontAppId === null ? undefined : { appId: row.storefrontAppId, tenantId: row.tenantId };
  if (commerceMarketRef === undefined && storefrontRef === undefined) {
    return required;
  }
  if (commerceMarketRef !== undefined && storefrontRef === undefined) {
    return { ...required, commerceMarketRef };
  }
  if (commerceMarketRef === undefined && storefrontRef !== undefined) {
    return { ...required, storefrontRef };
  }
  return {
    ...required,
    commerceMarketRef,
    storefrontRef,
  };
};

const decodeRow = (row: EligibilityRow) =>
  Schema.decodeUnknownEffect(StockSharingEligibilitySchema)({
    commerceValidation: {
      evidenceRef: row.commerceValidationEvidenceRef,
      observedAt: row.commerceValidationObservedAt.toISOString(),
      verification: 'OWNER_VERIFIED_CURRENT',
    },
    effectivePeriod: {
      from: row.effectiveFrom.toISOString(),
      to: row.effectiveTo?.toISOString() ?? null,
    },
    lifecycle: row.lifecycleState,
    ref: {
      moduleId: INVENTORY_MODULE_ID,
      resourceId: row.eligibilityId,
      resourceType: 'commerce.inventory.stock-sharing-eligibility',
      tenantId: row.tenantId,
    },
    revision: row.currentRevision,
    scope: {
      customerConfigurationId: row.customerConfigurationId,
      ownerConfigurationRef: {
        moduleId: INVENTORY_MODULE_ID,
        resourceId: row.ownerConfigurationId,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId: row.tenantId,
      },
      positionRef: {
        moduleId: INVENTORY_MODULE_ID,
        resourceId: row.stockPositionId,
        resourceType: 'commerce.inventory.stock-position',
        tenantId: row.tenantId,
      },
    },
    subject: subjectFor(row),
  }).pipe(Effect.mapError(unavailable));

export const decodeStockSharingEligibilityHistoryRows = (rows: readonly HistoryRow[]) =>
  Effect.forEach(
    rows,
    (row) => Schema.decodeEffect(StockSharingEligibilitySchema)(row.snapshot).pipe(Effect.mapError(unavailable)),
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap((snapshots) =>
      Effect.forEach(
        snapshots,
        (snapshot, index) => {
          const successor = rows[index + 1];
          if (successor === undefined || snapshot.effectivePeriod.to !== null) {
            return Effect.succeed(snapshot);
          }
          return Schema.decodeEffect(StockSharingEligibilitySchema)({
            ...snapshot,
            effectivePeriod: {
              from: snapshot.effectivePeriod.from,
              to: successor.transitionAt.toISOString(),
            },
            lifecycle: 'ENDED',
          }).pipe(Effect.mapError(unavailable));
        },
        { concurrency: 1 },
      ),
    ),
  );

export const stockSharingEligibilityPersistenceForScope = (
  transaction: ScopedTransaction,
  operationScope: OperationalScope,
): StockSharingEligibilityPersistence => {
  const requireTenant = (
    tenantId: string,
    relationRef?: StockSharingEligibilityRef,
  ): Effect.Effect<void, StockSharingEligibilityRejected> =>
    tenantId === operationScope.tenantId ? Effect.void : Effect.fail(reject('TENANT_SCOPE_MISMATCH', relationRef));

  const findByRef: StockSharingEligibilityPersistence['findByRef'] = Effect.fn(
    'StockSharingEligibilityPersistence.findByRef',
  )(function* findRelation(relationRef) {
    yield* requireTenant(relationRef.tenantId, relationRef);
    const [row] = yield* transaction
      .select()
      .from(inventoryStockSharingEligibilities)
      .where(
        and(
          eq(inventoryStockSharingEligibilities.tenantId, operationScope.tenantId),
          eq(inventoryStockSharingEligibilities.eligibilityId, relationRef.resourceId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    return row === undefined ? Option.none<StockSharingEligibility>() : Option.some(yield* decodeRow(row));
  });

  const appendHistory = (relation: StockSharingEligibility, transitionAt: string) =>
    transaction
      .insert(inventoryStockSharingEligibilityHistory)
      .values({
        eligibilityId: relation.ref.resourceId,
        revision: relation.revision,
        snapshot: relation,
        tenantId: relation.ref.tenantId,
        transitionAt: instantAsDate(transitionAt),
      })
      .pipe(Effect.mapError(mapStockSharingEligibilityWriteError), Effect.asVoid);

  const insertCurrent: StockSharingEligibilityPersistence['insertCurrent'] = Effect.fn(
    'StockSharingEligibilityPersistence.insertCurrent',
  )(function* insertCurrentRelation(relation) {
    yield* requireTenant(relation.ref.tenantId, relation.ref);
    const [row] = yield* transaction
      .insert(inventoryStockSharingEligibilities)
      .values(valuesFor(relation))
      .returning()
      .pipe(Effect.mapError(mapStockSharingEligibilityWriteError));
    if (row === undefined) {
      return yield* unavailable();
    }
    const persisted = yield* decodeRow(row);
    yield* appendHistory(persisted, persisted.effectivePeriod.from);
    return persisted;
  });

  const listCurrent: StockSharingEligibilityPersistence['listCurrent'] = (scope) =>
    requireTenant(scope.positionRef.tenantId).pipe(
      Effect.flatMap(() =>
        transaction
          .select()
          .from(inventoryStockSharingEligibilities)
          .where(
            and(
              eq(inventoryStockSharingEligibilities.tenantId, operationScope.tenantId),
              eq(inventoryStockSharingEligibilities.customerConfigurationId, scope.customerConfigurationId),
              eq(inventoryStockSharingEligibilities.ownerConfigurationId, scope.ownerConfigurationRef.resourceId),
              eq(inventoryStockSharingEligibilities.stockPositionId, scope.positionRef.resourceId),
              eq(inventoryStockSharingEligibilities.lifecycleState, 'CURRENT'),
            ),
          )
          .pipe(
            Effect.mapError(unavailable),
            Effect.flatMap((rows) => Effect.forEach(rows, decodeRow, { concurrency: 1 })),
          ),
      ),
    );

  const readHistory: StockSharingEligibilityPersistence['readHistory'] = (relationRef) =>
    requireTenant(relationRef.tenantId, relationRef).pipe(
      Effect.flatMap(() =>
        transaction
          .select()
          .from(inventoryStockSharingEligibilityHistory)
          .where(
            and(
              eq(inventoryStockSharingEligibilityHistory.tenantId, operationScope.tenantId),
              eq(inventoryStockSharingEligibilityHistory.eligibilityId, relationRef.resourceId),
            ),
          )
          .orderBy(asc(inventoryStockSharingEligibilityHistory.revision))
          .pipe(Effect.mapError(unavailable), Effect.flatMap(decodeStockSharingEligibilityHistoryRows)),
      ),
    );

  const saveRevision: StockSharingEligibilityPersistence['saveRevision'] = Effect.fn(
    'StockSharingEligibilityPersistence.saveRevision',
  )(function* saveEligibilityRevision({ current, next }) {
    yield* requireTenant(current.ref.tenantId, current.ref);
    const [row] = yield* transaction
      .update(inventoryStockSharingEligibilities)
      .set(valuesFor(next))
      .where(
        and(
          eq(inventoryStockSharingEligibilities.tenantId, operationScope.tenantId),
          eq(inventoryStockSharingEligibilities.eligibilityId, current.ref.resourceId),
          eq(inventoryStockSharingEligibilities.currentRevision, current.revision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(mapStockSharingEligibilityWriteError));
    if (row === undefined) {
      return yield* reject('REVISION_CONFLICT', current.ref);
    }
    const persisted = yield* decodeRow(row);
    const transitionAt = persisted.effectivePeriod.to ?? persisted.effectivePeriod.from;
    yield* appendHistory(persisted, transitionAt);
    return persisted;
  });

  return Object.freeze({ findByRef, insertCurrent, listCurrent, readHistory, saveRevision });
};
