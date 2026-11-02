import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq, or } from 'drizzle-orm';
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
import { inventorySourceAssertions } from './inventory-source-assertion-table.ts';
import { inventorySourceAssertionPersistenceForScope } from './inventory-source-assertion-repository.ts';
import {
  inventorySourceAssertionsClaimSameIdentityOrRevision,
  inventorySourceAssertionsHaveSameMaterialContent,
} from '../../shared/domain/inventory-source-ordering.ts';

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

  const findPersistedSourceHistory: InventorySourceImportLedgerPersistence['findPersistedSourceHistory'] = Effect.fn(
    'InventorySourceImportLedger.findPersistedSourceHistory',
  )(function* findPersistedSourceHistory(proposal) {
    if (proposal.positionRef.tenantId !== scope.tenantId) {
      return [];
    }
    const rows = yield* transaction
      .select({ entry: inventorySourceImportLedger })
      .from(inventorySourceImportLedger)
      .innerJoin(
        inventorySourceAssertions,
        and(
          eq(inventorySourceAssertions.tenantId, inventorySourceImportLedger.tenantId),
          eq(inventorySourceAssertions.assertionId, inventorySourceImportLedger.assertionId),
        ),
      )
      .where(
        and(
          eq(inventorySourceImportLedger.tenantId, scope.tenantId),
          eq(inventorySourceImportLedger.status, 'INDETERMINATE'),
          or(
            eq(inventorySourceImportLedger.assertionId, proposal.assertionId),
            and(
              eq(inventorySourceImportLedger.customerConfigurationId, proposal.customerConfigurationId),
              eq(inventorySourceImportLedger.issuerBackendKind, proposal.issuer.backendKind),
              eq(inventorySourceImportLedger.issuerBackendId, proposal.issuer.backendId),
              eq(inventorySourceImportLedger.factMeaning, proposal.factMeaning),
              eq(inventorySourceImportLedger.positionId, proposal.positionRef.resourceId),
            ),
          ),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    const assertions = inventorySourceAssertionPersistenceForScope(transaction, scope);
    const readPersistedEntry = Effect.fn('InventorySourceImportLedger.readPersistedEntry')(function* readPersistedEntry(
      row: (typeof rows)[number],
    ) {
      const entry = yield* decodeEntry(row.entry);
      if (!inventorySourceAssertionsClaimSameIdentityOrRevision(proposal, entry.proposal)) {
        return Option.none<InventorySourceImportLedgerEntry>();
      }
      const stored = yield* assertions.findById(entry.proposal.assertionId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(stored) || !inventorySourceAssertionsHaveSameMaterialContent(stored.value, entry.proposal)) {
        return yield* unavailable();
      }
      return Option.some(entry);
    });
    const entries = yield* Effect.all(rows.map(readPersistedEntry), { concurrency: 1 });
    return entries.flatMap((entry) => Option.toArray(entry));
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

  return Object.freeze({ append, findByInvocationItem, findPersistedSourceHistory, lockAndReadAcceptedHistory });
};
