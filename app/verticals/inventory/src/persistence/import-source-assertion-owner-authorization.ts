import {
  OwnerAuthorizationOverlay,
  failClosedOwnerAuthorizationOverlay,
  transactionalOwnerAuthorization,
} from '@app/core-runtime';
import type {
  OwnerAuthorizationDecision,
  OwnerAuthorizationInput,
  OwnerAuthorizationOverlayService,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Layer, Option, Result, Schema } from 'effect';

import { StockPositionRefSchema } from '../../shared/resources/stock-position.ts';
import { inventoryBackendConfigurationPersistenceForScope } from './inventory-backend-configuration-repository.ts';
import { stockPositionPersistenceForScope } from './stock-position-repository.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

/** Owner-state admission only; Core still checks the executor and exact business permission. */
export const authorizeImportSourceAssertionOwner = Effect.fn('InventoryImportOwnerAuthorization.authorize')(
  function* authorize(
    transaction: ScopedTransactionExecutor,
    input: OwnerAuthorizationInput,
  ): Effect.fn.Return<OwnerAuthorizationDecision> {
    if (
      input.operation !== 'action' ||
      input.operationKey !== 'commerce.inventory.import-source-assertion' ||
      input.owningModuleKey !== 'commerce.inventory'
    ) {
      const failClosed = yield* failClosedOwnerAuthorizationOverlay.prepare(input);
      return yield* failClosed(transaction, input.operationAt);
    }
    const [target, ...unexpected] = input.targets;
    if (
      target === undefined ||
      unexpected.length !== 0 ||
      target.kind !== 'business_permission' ||
      target.target.kind !== 'inventory_resource'
    ) {
      return 'unavailable';
    }
    if (
      target.permission !== 'inventory.migration.manage' ||
      target.target.tenantId !== input.scope.tenantId ||
      input.scope.legalEntityId !== undefined ||
      input.scope.trustedStorefrontId !== undefined ||
      target.trustedStorefrontId !== undefined
    ) {
      return 'denied';
    }
    const decoded = Schema.decodeUnknownResult(StockPositionRefSchema)({
      ...target.target.resource,
      tenantId: target.target.tenantId,
    });
    if (Result.isFailure(decoded)) {
      return 'denied';
    }
    const ref = decoded.success;
    return yield* Effect.gen(function* checkCanonicalImportOwner() {
      // Hold the exact owner row until the enclosing Core Action commits or rolls back.
      const [locked] = yield* transaction
        .select({ positionId: inventoryStockPositions.stockPositionId })
        .from(inventoryStockPositions)
        .where(
          and(
            eq(inventoryStockPositions.tenantId, input.scope.tenantId),
            eq(inventoryStockPositions.stockPositionId, ref.resourceId),
          ),
        )
        .limit(1)
        .for('update');
      if (locked === undefined) {
        return 'unavailable' as const;
      }
      const position = yield* stockPositionPersistenceForScope(transaction, input.scope).read(ref);
      if (Option.isNone(position)) {
        return 'unavailable' as const;
      }
      const selected = yield* inventoryBackendConfigurationPersistenceForScope(transaction, input.scope).findCurrent(
        position.value.scope.customerConfigurationId,
      );
      if (Option.isNone(selected)) {
        return 'unavailable' as const;
      }
      // Historical source issuers remain valid evidence; do not require a particular backend mode
      // or turn this ownership check into a CURRENT-only stock policy.
      return selected.value.configurationId === position.value.onHand.ownerConfigurationRef.resourceId
        ? ('allowed' as const)
        : ('denied' as const);
    }).pipe(
      Effect.catchTags({
        EffectDrizzleQueryError: () => Effect.succeed('unavailable' as const),
        InventoryBackendConfigurationPersistenceUnavailable: () => Effect.succeed('unavailable' as const),
        StockPositionPersistenceUnavailable: () => Effect.succeed('unavailable' as const),
        StockPositionRejected: () => Effect.succeed('unavailable' as const),
      }),
    );
  },
);

/** The owner decision reads only owner database state, so all of it runs inside Core's transaction. */
export const importSourceAssertionOwnerAuthorizationOverlay: OwnerAuthorizationOverlayService =
  transactionalOwnerAuthorization(authorizeImportSourceAssertionOwner);

export const importSourceAssertionOwnerAuthorizationOverlayLive = Layer.succeed(
  OwnerAuthorizationOverlay,
  importSourceAssertionOwnerAuthorizationOverlay,
);
