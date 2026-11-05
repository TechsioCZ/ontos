import type { OperationalScope } from '@app/core-runtime';
import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CartOpenSelectionPopulationUnavailable } from './catalog-open-selection-population.ts';

/**
 * The deployment's Cart owner adapter. It is handed the operational scope of the Catalog action that
 * asks for the population, so the Cart call carries that action's subject.
 */
export interface CartOpenSelectionPopulationOwnerPort {
  readonly read: (input: {
    readonly scope: OperationalScope;
    readonly tenantId: string;
  }) => Effect.Effect<unknown, CartOpenSelectionPopulationUnavailable>;
}

/** Public Effect service key supplied by the deployment's Cart owner adapter. */
export class CartOpenSelectionPopulationService extends Context.Service<
  CartOpenSelectionPopulationService,
  CartOpenSelectionPopulationOwnerPort
>()('@app/catalog/shared/domain/cart-open-selection-population-service/CartOpenSelectionPopulationService') {}
