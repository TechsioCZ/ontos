import { OwnerAuthorizationOverlay, failClosedOwnerAuthorizationOverlay } from '@app/core-runtime';
import type {
  OwnerAuthorizationDecision,
  OwnerAuthorizationInput,
  OwnerAuthorizationOverlayService,
  OwnerAccessFacts,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Layer, Option, Result, Schema } from 'effect';

import { StockPositionRefSchema } from '../../shared/resources/stock-position.ts';
import { inventoryBackendConfigurationPersistenceForScope } from './inventory-backend-configuration-repository.ts';
import { stockPositionPersistenceForScope } from './stock-position-repository.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

/** The one capability this owner rule is about: importing an external source assertion (O31). */
const IMPORT_SOURCE_ASSERTION_CAPABILITY = 'commerce.inventory.source-assertion.import';

/**
 * The Stock Position the payload asserts against. Core resolves these facts from the decoded payload
 * and the trusted scope (O70); they name the owner record the rule reads, they grant nothing.
 */
const positionFactsOf = (facts: OwnerAccessFacts | undefined) =>
  facts === undefined
    ? undefined
    : {
        moduleId: facts['inventoryPositionModuleId'],
        resourceId: facts['inventoryPositionResourceId'],
        resourceType: facts['inventoryPositionResourceType'],
        tenantId: facts['inventoryPositionTenantId'],
      };

/**
 * Owner-state admission only: Core still decides the Action's own capability in the one access gate
 * (O67-Q2), and this seam answers the owner's rule over its own state — the imported assertion may
 * only land on a Position whose on-hand authority is the currently selected Inventory Backend
 * configuration (O20/O31).
 */
export const importSourceAssertionOwnerAuthorizationOverlay: OwnerAuthorizationOverlayService = Object.freeze({
  authorize: Effect.fn('InventoryImportOwnerAuthorization.authorize')(function* authorize(
    transaction: ScopedTransactionExecutor,
    input: OwnerAuthorizationInput,
  ): Effect.fn.Return<OwnerAuthorizationDecision> {
    if (
      input.operation !== 'action' ||
      input.capabilityKey !== IMPORT_SOURCE_ASSERTION_CAPABILITY ||
      input.owningModuleKey !== 'commerce.inventory'
    ) {
      return yield* failClosedOwnerAuthorizationOverlay.authorize(transaction, input);
    }
    const positional = positionFactsOf(input.ownerFacts);
    if (
      positional === undefined ||
      input.scope.legalEntityId !== undefined ||
      input.scope.trustedStorefrontId !== undefined
    ) {
      return 'unavailable';
    }
    if (positional.tenantId !== input.scope.tenantId) {
      return 'denied';
    }
    const decoded = Schema.decodeUnknownResult(StockPositionRefSchema)(positional);
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
  }),
});

export const importSourceAssertionOwnerAuthorizationOverlayLive = Layer.succeed(
  OwnerAuthorizationOverlay,
  importSourceAssertionOwnerAuthorizationOverlay,
);
