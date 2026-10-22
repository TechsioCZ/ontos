import type { ActionPrepareContext, OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect } from 'effect';

import type { CartOpenSelectionPopulationPort } from '../../shared/domain/catalog-open-selection-population.ts';
import {
  CartOpenSelectionPopulationUnavailable,
  cartOpenSelectionPopulationFromEnvironment,
} from '../../shared/domain/catalog-open-selection-population.ts';

/** Read the foreign owner once, before BEGIN. Keep failure lazy so existing domain checks retain their order. */
export const prepareCatalogActionOpenSelections = Effect.fn('CatalogAction.prepareOpenSelections')(
  function* prepareCatalogActionOpenSelections<Payload>(_payload: Payload, context: ActionPrepareContext) {
    const population = yield* cartOpenSelectionPopulationFromEnvironment;
    if (population === undefined) {
      return population;
    }
    const { tenantId } = context.scope;
    const observed = yield* Effect.result(population.read({ tenantId }));
    return {
      read: (input) =>
        input.tenantId === tenantId
          ? Effect.fromResult(observed)
          : Effect.fail(
              new CartOpenSelectionPopulationUnavailable({
                code: 'cart_open_selection_population_unavailable',
                reason: 'Prepared Cart population belongs to a different Tenant',
              }),
            ),
    } satisfies CartOpenSelectionPopulationPort;
  },
);

/** Bind owner DB services to the prepared snapshot, never to a live foreign owner port. */
export const catalogServicesForPreparedOpenSelections =
  <Services>(
    makeServices: (
      transaction: ScopedTransactionExecutor,
      input: { readonly population: CartOpenSelectionPopulationPort | undefined; readonly scope: OperationalScope },
    ) => Effect.Effect<Services>,
  ) =>
  (transaction: ScopedTransactionExecutor, scope: OperationalScope) =>
    Effect.succeed((population?: CartOpenSelectionPopulationPort) => makeServices(transaction, { population, scope }));
