import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Match, Option, Schema } from 'effect';

import {
  InventorySourceImportLedgerEntrySchema,
  InventorySourceImportUnavailable,
} from '../../shared/domain/inventory-source-import-outcome.ts';
import type {
  InventorySourceImportLedgerEntry,
  InventorySourceImportLedgerPersistence,
} from '../../shared/domain/inventory-source-import-outcome.ts';
import type { InventorySourceAssertionProposal } from '../../shared/domain/inventory-source-assertion.ts';
import { inventoryStockPositions } from './stock-position-table.ts';
import { inventorySourceImportLedger } from './inventory-source-import-ledger-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const unavailable = (cause?: unknown) => {
  const failure = new InventorySourceImportUnavailable({
    code: 'inventory_source_import_unavailable',
    reason: 'Inventory Source Import persistence is temporarily unavailable',
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const orderingValue = (proposal: InventorySourceAssertionProposal) =>
  Match.value(proposal.orderingEvidence).pipe(
    Match.tag('SOURCE_REVISION', ({ revision }) => revision),
    Match.tag('OWNER_ORDER_KEY', ({ key }) => key),
    Match.exhaustive,
  );

const rowValues = (entry: InventorySourceImportLedgerEntry) => ({
  actionInvocationId: entry.actionInvocationId,
  assertionId: entry.proposal.assertionId,
  customerConfigurationId: entry.proposal.customerConfigurationId,
  factMeaning: entry.proposal.factMeaning,
  issuerBackendId: entry.proposal.issuer.backendId,
  issuerBackendKind: entry.proposal.issuer.backendKind,
  itemIndex: entry.itemIndex,
  orderingEvidenceKind: entry.proposal.orderingEvidence._tag,
  orderingEvidenceValue: orderingValue(entry.proposal),
  outcomeJson: entry.outcome,
  positionId: entry.proposal.positionRef.resourceId,
  proposalJson: entry.proposal,
  sourceReference: entry.proposal.sourceReference,
  status: entry.outcome.status,
  tenantId: entry.proposal.positionRef.tenantId,
});

const decodeEntry = (row: typeof inventorySourceImportLedger.$inferSelect) =>
  Schema.decodeEffect(InventorySourceImportLedgerEntrySchema)({
    actionInvocationId: row.actionInvocationId,
    itemIndex: row.itemIndex,
    outcome: row.outcomeJson,
    proposal: row.proposalJson,
  }).pipe(Effect.mapError(unavailable));

export const inventorySourceImportLedgerPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: Pick<OperationalScope, 'tenantId'>,
): InventorySourceImportLedgerPersistence => {
  const findByInvocationItem: InventorySourceImportLedgerPersistence['findByInvocationItem'] = Effect.fn(
    'InventorySourceImportLedger.findByInvocationItem',
  )(function* findByInvocationItem(actionInvocationId, itemIndex) {
    const [row] = yield* transaction
      .select()
      .from(inventorySourceImportLedger)
      .where(
        and(
          eq(inventorySourceImportLedger.tenantId, scope.tenantId),
          eq(inventorySourceImportLedger.actionInvocationId, actionInvocationId),
          eq(inventorySourceImportLedger.itemIndex, itemIndex),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    return row === undefined ? Option.none() : Option.some(yield* decodeEntry(row));
  });

  const lockAndReadAcceptedHistory: InventorySourceImportLedgerPersistence['lockAndReadAcceptedHistory'] = Effect.fn(
    'InventorySourceImportLedger.lockAndReadAcceptedHistory',
  )(function* lockAndReadAcceptedHistory(proposal) {
    if (proposal.positionRef.tenantId !== scope.tenantId) {
      return [];
    }
    yield* transaction
      .select({ positionId: inventoryStockPositions.stockPositionId })
      .from(inventoryStockPositions)
      .where(
        and(
          eq(inventoryStockPositions.tenantId, scope.tenantId),
          eq(inventoryStockPositions.stockPositionId, proposal.positionRef.resourceId),
        ),
      )
      .for('update')
      .pipe(Effect.mapError(unavailable));
    const rows = yield* transaction
      .select()
      .from(inventorySourceImportLedger)
      .where(
        and(
          eq(inventorySourceImportLedger.tenantId, scope.tenantId),
          eq(inventorySourceImportLedger.customerConfigurationId, proposal.customerConfigurationId),
          eq(inventorySourceImportLedger.issuerBackendKind, proposal.issuer.backendKind),
          eq(inventorySourceImportLedger.issuerBackendId, proposal.issuer.backendId),
          eq(inventorySourceImportLedger.factMeaning, proposal.factMeaning),
          eq(inventorySourceImportLedger.positionId, proposal.positionRef.resourceId),
          eq(inventorySourceImportLedger.status, 'ACCEPTED'),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach's curried overload takes concurrency options, not Array#forEach thisArg; expires: 2027-03-31.
    return yield* Effect.forEach((row: (typeof rows)[number]) => decodeEntry(row), { concurrency: 1 })(rows);
  });

  const append: InventorySourceImportLedgerPersistence['append'] = Effect.fn('InventorySourceImportLedger.append')(
    function* append(entry) {
      if (
        entry.proposal.positionRef.tenantId !== scope.tenantId ||
        !Schema.is(InventorySourceImportLedgerEntrySchema)(entry)
      ) {
        return yield* unavailable();
      }
      const [inserted] = yield* transaction
        .insert(inventorySourceImportLedger)
        .values(rowValues(entry))
        .returning()
        .pipe(Effect.mapError(unavailable));
      if (inserted === undefined) {
        return yield* unavailable();
      }
      return yield* decodeEntry(inserted);
    },
  );

  return Object.freeze({ append, findByInvocationItem, lockAndReadAcceptedHistory });
};
