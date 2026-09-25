import { findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, desc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  InventorySourceConflictNotFound,
  InventorySourceConflictRejected,
  InventorySourceConflictSchema,
  InventorySourceConflictUnavailable,
  StockPositionFactConflictScopeSchema,
  inventorySourceConflictsHaveSameOpenEvidence,
} from '../../shared/domain/inventory-source-conflict.ts';
import type { InventorySourceConflict } from '../../shared/domain/inventory-source-conflict.ts';
import type { InventorySourceConflictRef } from '../../shared/resources/inventory-source-conflict.ts';
import type { InventorySourceConflictPersistence } from '../services/inventory-source-conflict.service.ts';
import { inventorySourceConflictRevisions } from './inventory-source-conflict-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const unavailable = (reason: string, cause?: unknown) => {
  const failure = new InventorySourceConflictUnavailable({
    code: 'inventory_source_conflict_unavailable',
    reason,
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const rejected = (conflictRef: InventorySourceConflictRef, reason: InventorySourceConflictRejected['reason']) =>
  new InventorySourceConflictRejected({ code: 'inventory_source_conflict_rejected', conflictRef, reason });

const notFound = (conflictRef: InventorySourceConflictRef) =>
  new InventorySourceConflictNotFound({ code: 'inventory_source_conflict_not_found', conflictRef });

const mapWriteError = (conflictRef: InventorySourceConflictRef, cause: unknown) => {
  const uniqueViolationSqlState = ['23', '505'].join('');
  const identity = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_source_conflict_revisions_pk',
  );
  return Option.isSome(identity)
    ? rejected(conflictRef, 'CONFLICT_REVISION_CONFLICT')
    : unavailable('Inventory Source Conflict evidence could not be persisted', cause);
};

const valuesFor = (conflict: InventorySourceConflict) => ({
  conflictId: conflict.conflictRef.resourceId,
  conflictJson: conflict,
  conflictType: conflict.conflictType,
  currentTruth: conflict.currentTruth,
  customerConfigurationId: conflict.scope.customerConfigurationId,
  detectedAt: DateTime.toDateUtc(DateTime.makeUnsafe(conflict.detectedAt)),
  factMeaning: Schema.is(StockPositionFactConflictScopeSchema)(conflict.scope) ? conflict.scope.factMeaning : null,
  positionId: Schema.is(StockPositionFactConflictScopeSchema)(conflict.scope)
    ? conflict.scope.positionRef.resourceId
    : null,
  resolvedAt:
    conflict.status === 'RESOLVED' ? DateTime.toDateUtc(DateTime.makeUnsafe(conflict.resolution.resolvedAt)) : null,
  revision: conflict.revision,
  status: conflict.status,
  tenantId: conflict.conflictRef.tenantId,
});

const decode = (row: typeof inventorySourceConflictRevisions.$inferSelect) =>
  Schema.decodeEffect(InventorySourceConflictSchema)(row.conflictJson).pipe(
    Effect.mapError((cause) => unavailable('Stored Inventory Source Conflict evidence is invalid', cause)),
  );

export const inventorySourceConflictPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: Pick<OperationalScope, 'tenantId'>,
): InventorySourceConflictPersistence => {
  const readRows = (conflictRef: InventorySourceConflictRef, lock: boolean) => {
    const query = transaction
      .select()
      .from(inventorySourceConflictRevisions)
      .where(
        and(
          eq(inventorySourceConflictRevisions.tenantId, scope.tenantId),
          eq(inventorySourceConflictRevisions.conflictId, conflictRef.resourceId),
        ),
      )
      .orderBy(desc(inventorySourceConflictRevisions.revision))
      .limit(1);
    return (lock ? query.for('update') : query).pipe(
      Effect.mapError((cause) => unavailable('Inventory Source Conflict evidence is unavailable', cause)),
    );
  };

  const findLatest: InventorySourceConflictPersistence['findLatest'] = Effect.fn(
    'InventorySourceConflictPersistence.findLatest',
  )(function* findLatestConflict(conflictRef) {
    if (conflictRef.tenantId !== scope.tenantId) {
      return yield* unavailable('Inventory Source Conflict Tenant scope does not match the trusted scope');
    }
    const [row] = yield* readRows(conflictRef, false);
    return row === undefined ? Option.none<InventorySourceConflict>() : Option.some(yield* decode(row));
  });

  const appendOpen: InventorySourceConflictPersistence['appendOpen'] = Effect.fn(
    'InventorySourceConflictPersistence.appendOpen',
  )(function* appendOpenConflict(conflict) {
    if (conflict.conflictRef.tenantId !== scope.tenantId || conflict.revision !== 1 || conflict.status !== 'OPEN') {
      return yield* rejected(conflict.conflictRef, 'TENANT_SCOPE_MISMATCH');
    }
    const [inserted] = yield* transaction
      .insert(inventorySourceConflictRevisions)
      .values(valuesFor(conflict))
      .onConflictDoNothing()
      .returning()
      .pipe(Effect.mapError((cause) => mapWriteError(conflict.conflictRef, cause)));
    if (inserted !== undefined) {
      const decoded = yield* decode(inserted);
      return decoded.status === 'OPEN'
        ? decoded
        : yield* unavailable('New Inventory Source Conflict was not stored as OPEN');
    }
    const [existing] = yield* readRows(conflict.conflictRef, true);
    if (existing === undefined) {
      return yield* unavailable('Conflicting Inventory Source Conflict identity could not be read');
    }
    const decoded = yield* decode(existing);
    return decoded.status === 'OPEN' && inventorySourceConflictsHaveSameOpenEvidence(decoded, conflict)
      ? decoded
      : yield* rejected(conflict.conflictRef, 'CONFLICT_ID_CONFLICT');
  });

  const appendResolution: InventorySourceConflictPersistence['appendResolution'] = Effect.fn(
    'InventorySourceConflictPersistence.appendResolution',
  )(function* appendResolutionRevision(expected, resolved) {
    const [row] = yield* readRows(expected.conflictRef, true);
    if (row === undefined) {
      return yield* notFound(expected.conflictRef);
    }
    const latest = yield* decode(row);
    if (latest.status === 'RESOLVED') {
      return yield* rejected(expected.conflictRef, 'ALREADY_RESOLVED');
    }
    if (latest.revision !== expected.revision || !inventorySourceConflictsHaveSameOpenEvidence(latest, expected)) {
      return yield* rejected(expected.conflictRef, 'CONFLICT_REVISION_CONFLICT');
    }
    const [inserted] = yield* transaction
      .insert(inventorySourceConflictRevisions)
      .values(valuesFor(resolved))
      .returning()
      .pipe(Effect.mapError((cause) => mapWriteError(resolved.conflictRef, cause)));
    if (inserted === undefined) {
      return yield* unavailable('Inventory Source Conflict resolution insert returned no row');
    }
    const decoded = yield* decode(inserted);
    return decoded.status === 'RESOLVED'
      ? decoded
      : yield* unavailable('Inventory Source Conflict resolution was not terminal');
  });

  return Object.freeze({ appendOpen, appendResolution, findLatest });
};
