import { Context } from 'effect';

import type { CartOpenSelectionPopulationPort } from './catalog-open-selection-population.ts';

/** Public Effect service key supplied by the deployment's Cart owner adapter. */
export class CartOpenSelectionPopulationService extends Context.Service<
  CartOpenSelectionPopulationService,
  CartOpenSelectionPopulationPort
>()('@app/catalog/shared/domain/cart-open-selection-population-service/CartOpenSelectionPopulationService') {}
