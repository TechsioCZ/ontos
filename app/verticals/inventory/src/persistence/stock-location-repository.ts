import { findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import type { Effect as EffectType } from 'effect';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import { ActiveLifecycleSchema, StockLocationSchema } from '../../shared/domain/stock-location.ts';
import type {
  ExternalStockLocationKey,
  StockLocation,
  StockLocationCorrelation,
} from '../../shared/domain/stock-location.ts';
import type { StockLocationRef } from '../../shared/resources/stock-location.ts';
import { StockLocationPersistenceRejected } from './stock-location-persistence-rejected.ts';
import { inventoryStockLocationRevisions, inventoryStockLocations } from './stock-location-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type StockLocationRow = typeof inventoryStockLocations.$inferSelect;

export class StockLocationPersistenceUnavailable extends Schema.TaggedError<StockLocationPersistenceUnavailable>()(
  'StockLocationPersistenceUnavailable',
  {
    code: Schema.Literal('stock_location_persistence_unavailable'),
    reason: Schema.String,
  },
) {}

/** Transaction-scoped owner port. Implementations must append a revision when saving a transition. */
export interface StockLocationPersistence {
  readonly create: (
    location: StockLocation,
  ) => EffectType.Effect<StockLocation, StockLocationPersistenceRejected | StockLocationPersistenceUnavailable>;
  readonly read: (
    ref: StockLocationRef,
  ) => EffectType.Effect<
    Option.Option<StockLocation>,
    StockLocationPersistenceRejected | StockLocationPersistenceUnavailable
  >;
  readonly readHistory: (
    ref: StockLocationRef,
  ) => EffectType.Effect<
    readonly StockLocation[],
    StockLocationPersistenceRejected | StockLocationPersistenceUnavailable
  >;
  readonly saveTransition: (input: {
    readonly expectedRevision: number;
    readonly next: StockLocation;
  }) => EffectType.Effect<StockLocation, StockLocationPersistenceRejected | StockLocationPersistenceUnavailable>;
}

/** Narrow seam onto explicit Connector Registry correlations; it cannot perform fuzzy matching. */
export interface StockLocationCorrelationReader {
  readonly readExplicit: (
    source: ExternalStockLocationKey,
  ) => EffectType.Effect<readonly StockLocationCorrelation[], StockLocationPersistenceUnavailable>;
}

const unavailable = (cause: unknown): StockLocationPersistenceUnavailable => {
  const failure = new StockLocationPersistenceUnavailable({
    code: 'stock_location_persistence_unavailable',
    reason: 'Stock Location persistence is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const reject = (
  locationRef: StockLocationRef,
  reason: StockLocationPersistenceRejected['reason'],
  actualRevision?: number,
) =>
  actualRevision === undefined
    ? new StockLocationPersistenceRejected({ locationRef, reason })
    : new StockLocationPersistenceRejected({ actualRevision, locationRef, reason });

const refFor = (tenantId: string, stockLocationId: string) => ({
  moduleId: 'commerce.inventory' as const,
  resourceId: stockLocationId,
  resourceType: 'commerce.inventory.stock-location' as const,
  tenantId,
});

const rowLifecycle = (row: StockLocationRow) => {
  if (row.lifecycleState === 'ACTIVE') {
    return { _tag: 'ACTIVE' as const };
  }
  if (row.lifecycleState === 'RETIRED') {
    return {
      _tag: 'RETIRED' as const,
      reason: row.transitionReason ?? '',
      transitionedAt: row.transitionedAt?.toISOString() ?? '',
    };
  }
  const successorRef = refFor(row.tenantId, row.successorStockLocationId ?? '');
  return row.lifecycleState === 'REPLACED'
    ? {
        _tag: 'REPLACED' as const,
        reason: row.transitionReason ?? '',
        successorRef,
        transitionedAt: row.transitionedAt?.toISOString() ?? '',
      }
    : {
        _tag: 'MERGED' as const,
        reason: row.transitionReason ?? '',
        successorRef,
        transitionedAt: row.transitionedAt?.toISOString() ?? '',
      };
};

const decodeRow = (row: StockLocationRow) => {
  const candidate = {
    displayName: row.displayName,
    lifecycle: rowLifecycle(row),
    operationalScope: { _tag: row.scopeKind, physicalSiteKeys: row.physicalSiteKeys },
    ref: refFor(row.tenantId, row.stockLocationId),
    revision: row.currentRevision,
  };
  return Schema.decodeUnknownEffect(StockLocationSchema)(
    row.addressEvidence === null ? candidate : { ...candidate, addressEvidence: row.addressEvidence },
  ).pipe(Effect.mapError(unavailable));
};

const lifecycleColumns = (location: StockLocation) =>
  Match.value(location.lifecycle).pipe(
    Match.tag('ACTIVE', () => ({
      lifecycleState: 'ACTIVE',
      successorStockLocationId: null,
      transitionedAt: null,
      transitionReason: null,
    })),
    Match.tag('RETIRED', ({ reason, transitionedAt }) => ({
      lifecycleState: 'RETIRED',
      successorStockLocationId: null,
      transitionedAt: DateTime.toDateUtc(DateTime.makeUnsafe(transitionedAt)),
      transitionReason: reason,
    })),
    Match.tag('REPLACED', ({ reason, successorRef, transitionedAt }) => ({
      lifecycleState: 'REPLACED',
      successorStockLocationId: successorRef.resourceId,
      transitionedAt: DateTime.toDateUtc(DateTime.makeUnsafe(transitionedAt)),
      transitionReason: reason,
    })),
    Match.tag('MERGED', ({ reason, successorRef, transitionedAt }) => ({
      lifecycleState: 'MERGED',
      successorStockLocationId: successorRef.resourceId,
      transitionedAt: DateTime.toDateUtc(DateTime.makeUnsafe(transitionedAt)),
      transitionReason: reason,
    })),
    Match.exhaustive,
  );

const rowValues = (location: StockLocation) => ({
  addressEvidence: location.addressEvidence ?? null,
  currentRevision: location.revision,
  displayName: location.displayName,
  ...lifecycleColumns(location),
  physicalSiteKeys: location.operationalScope.physicalSiteKeys,
  scopeKind: location.operationalScope._tag,
  stockLocationId: location.ref.resourceId,
  tenantId: location.ref.tenantId,
});

const appendRevision = (transaction: ScopedTransaction, location: StockLocation) =>
  transaction
    .insert(inventoryStockLocationRevisions)
    .values({
      revision: location.revision,
      snapshot: location,
      stockLocationId: location.ref.resourceId,
      tenantId: location.ref.tenantId,
    })
    .pipe(Effect.mapError(unavailable));

const mapCreateError = (locationRef: StockLocationRef, cause: unknown) => {
  const uniqueViolation = ['23', '505'].join('');
  const matched = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolation &&
      ['stock_locations_pkey', 'inventory_stock_locations_scope_id_uk'].includes(constraint ?? ''),
  );
  return Option.isSome(matched) ? reject(locationRef, 'IDENTITY_CONFLICT') : unavailable(cause);
};

/** Concrete owner-local Drizzle adapter; its transaction is installed only after governed scope validation. */
export const stockLocationPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): StockLocationPersistence => {
  const requireTenant = (ref: StockLocationRef) =>
    ref.tenantId === scope.tenantId ? Effect.void : Effect.fail(reject(ref, 'TENANT_SCOPE_MISMATCH'));

  const readCurrentRow = (ref: StockLocationRef) =>
    transaction
      .select()
      .from(inventoryStockLocations)
      .where(
        and(
          eq(inventoryStockLocations.tenantId, scope.tenantId),
          eq(inventoryStockLocations.stockLocationId, ref.resourceId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));

  const create: StockLocationPersistence['create'] = Effect.fn('StockLocationPersistence.create')(
    function* createStockLocation(location) {
      yield* requireTenant(location.ref);
      if (
        !Schema.is(StockLocationSchema)(location) ||
        location.revision !== 1 ||
        !Schema.is(ActiveLifecycleSchema)(location.lifecycle)
      ) {
        return yield* reject(location.ref, 'INVALID_CREATE');
      }
      const [row] = yield* transaction
        .insert(inventoryStockLocations)
        .values(rowValues(location))
        .returning()
        .pipe(Effect.mapError((cause) => mapCreateError(location.ref, cause)));
      if (row === undefined) {
        return yield* unavailable('Stock Location insert returned no row');
      }
      const created = yield* decodeRow(row);
      yield* appendRevision(transaction, created);
      return created;
    },
  );

  const read: StockLocationPersistence['read'] = Effect.fn('StockLocationPersistence.read')(
    function* readStockLocation(ref) {
      yield* requireTenant(ref);
      const [row] = yield* readCurrentRow(ref);
      return row === undefined ? Option.none<StockLocation>() : Option.some(yield* decodeRow(row));
    },
  );

  const readHistory: StockLocationPersistence['readHistory'] = Effect.fn('StockLocationPersistence.readHistory')(
    function* readStockLocationHistory(ref) {
      yield* requireTenant(ref);
      const rows = yield* transaction
        .select({ snapshot: inventoryStockLocationRevisions.snapshot })
        .from(inventoryStockLocationRevisions)
        .where(
          and(
            eq(inventoryStockLocationRevisions.tenantId, scope.tenantId),
            eq(inventoryStockLocationRevisions.stockLocationId, ref.resourceId),
          ),
        )
        .orderBy(asc(inventoryStockLocationRevisions.revision))
        .pipe(Effect.mapError(unavailable));
      return yield* Effect.forEach(
        rows,
        ({ snapshot }) => Schema.decodeEffect(StockLocationSchema)(snapshot).pipe(Effect.mapError(unavailable)),
        { concurrency: 1 },
      );
    },
  );

  const saveTransition: StockLocationPersistence['saveTransition'] = Effect.fn(
    'StockLocationPersistence.saveTransition',
  )(function* saveStockLocationTransition({ expectedRevision, next }) {
    yield* requireTenant(next.ref);
    if (
      !Schema.is(StockLocationSchema)(next) ||
      next.revision !== expectedRevision + 1 ||
      Schema.is(ActiveLifecycleSchema)(next.lifecycle)
    ) {
      return yield* reject(next.ref, 'INVALID_TRANSITION');
    }
    const [row] = yield* transaction
      .update(inventoryStockLocations)
      .set({ ...rowValues(next), updatedAt: DateTime.toDateUtc(yield* DateTime.now) })
      .where(
        and(
          eq(inventoryStockLocations.tenantId, scope.tenantId),
          eq(inventoryStockLocations.stockLocationId, next.ref.resourceId),
          eq(inventoryStockLocations.currentRevision, expectedRevision),
          eq(inventoryStockLocations.lifecycleState, 'ACTIVE'),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      const [observed] = yield* readCurrentRow(next.ref);
      if (observed === undefined) {
        return yield* reject(next.ref, 'NOT_FOUND');
      }
      return yield* reject(next.ref, 'REVISION_CONFLICT', observed.currentRevision);
    }
    const saved = yield* decodeRow(row);
    yield* appendRevision(transaction, saved);
    return saved;
  });

  return Object.freeze({ create, read, readHistory, saveTransition });
};
