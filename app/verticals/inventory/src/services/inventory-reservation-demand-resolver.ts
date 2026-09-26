import type { Effect } from 'effect';

import type {
  CatalogStockDemand,
  CatalogToStockBindingRejected,
  ResolvedCatalogStockDemand,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import type { CatalogToStockBindingUnavailable } from '../../shared/domain/catalog-to-stock-binding-unavailable.ts';

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- The reservation Action factory receives this owner-local resolver dependency directly; it has no independent runtime Context identity; expires: 2027-03-31.
export interface InventoryReservationDemandResolver {
  readonly resolve: (
    demand: CatalogStockDemand,
  ) => Effect.Effect<ResolvedCatalogStockDemand, CatalogToStockBindingRejected | CatalogToStockBindingUnavailable>;
}
