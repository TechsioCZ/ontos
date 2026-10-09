import type { ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';

import type {
  CatalogToStockBindingPersistence,
  CatalogToStockBindingReader,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import type { ExactCatalogSelectionMeaning } from '../../shared/domain/stock-item.ts';
import { inventoryCatalogToStockBindings } from './catalog-to-stock-binding-table.ts';

type ScopedTransaction = Pick<Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0], 'select'>;

export interface BindingCorrectionScope {
  readonly exactSelectionMeaning: ExactCatalogSelectionMeaning;
  readonly tenantId: string;
}

export interface BindingCorrectionRequirementScope extends BindingCorrectionScope {
  readonly bindingId: string;
  readonly stockItemId: string;
}

const lockKey = ({ exactSelectionMeaning, tenantId }: BindingCorrectionScope) =>
  `commerce.inventory:binding-correction:${tenantId}:${exactSelectionMeaning.kind}:${exactSelectionMeaning.id}`;

const uniqueOrderedScopes = <Scope extends BindingCorrectionScope>(scopes: readonly Scope[]) =>
  [...new Map(scopes.map((scope) => [lockKey(scope), scope])).entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  );

/** Serializes Current binding resolution and every child write, including when no child row exists yet. */
export const lockBindingCorrectionScopes = Effect.fn('BindingCorrectionSerialization.lockScopes')(function* lockScopes(
  transaction: ScopedTransaction,
  scopes: readonly BindingCorrectionScope[],
) {
  yield* Effect.forEach(
    uniqueOrderedScopes(scopes),
    ([, scope]) =>
      transaction
        .select({ bindingId: inventoryCatalogToStockBindings.bindingId })
        .from(inventoryCatalogToStockBindings)
        .where(
          and(
            eq(inventoryCatalogToStockBindings.tenantId, scope.tenantId),
            eq(inventoryCatalogToStockBindings.exactSelectionKind, scope.exactSelectionMeaning.kind),
            eq(inventoryCatalogToStockBindings.exactSelectionMeaningId, scope.exactSelectionMeaning.id),
          ),
        )
        .for('update')
        .pipe(Effect.asVoid),
    { concurrency: 1 },
  );
});

export const currentBindingRequirementsMatch = Effect.fn('BindingCorrectionSerialization.requireCurrentBindings')(
  function* requireCurrentBindings(
    transaction: ScopedTransaction,
    requirements: readonly BindingCorrectionRequirementScope[],
  ) {
    const matches = yield* Effect.forEach(
      uniqueOrderedScopes(requirements).map(([, requirement]) => requirement),
      (requirement) =>
        transaction
          .select({
            bindingId: inventoryCatalogToStockBindings.bindingId,
            stockItemId: inventoryCatalogToStockBindings.stockItemId,
          })
          .from(inventoryCatalogToStockBindings)
          .where(
            and(
              eq(inventoryCatalogToStockBindings.tenantId, requirement.tenantId),
              eq(inventoryCatalogToStockBindings.exactSelectionKind, requirement.exactSelectionMeaning.kind),
              eq(inventoryCatalogToStockBindings.exactSelectionMeaningId, requirement.exactSelectionMeaning.id),
            ),
          )
          .for('update')
          .limit(2)
          .pipe(
            Effect.map(
              (rows) =>
                rows.length === 1 &&
                rows[0]?.bindingId === requirement.bindingId &&
                rows[0]?.stockItemId === requirement.stockItemId,
            ),
          ),
      { concurrency: 1 },
    );
    return matches.every(Boolean);
  },
);

export const serializeCatalogToStockBindingReader = <Reader extends CatalogToStockBindingReader>(
  transaction: ScopedTransaction,
  reader: Reader,
): Reader =>
  Object.freeze({
    ...reader,
    findCurrentByExactSelectionMeaning: (tenantId, exactSelectionMeaning) =>
      lockBindingCorrectionScopes(transaction, [{ exactSelectionMeaning, tenantId }]).pipe(
        Effect.andThen(reader.findCurrentByExactSelectionMeaning(tenantId, exactSelectionMeaning)),
      ),
  });

export const serializeCatalogToStockBindingPersistence = (
  transaction: ScopedTransaction,
  persistence: CatalogToStockBindingPersistence,
): CatalogToStockBindingPersistence => serializeCatalogToStockBindingReader(transaction, persistence);
