import { unitRoutedFetch } from '@app/core-runtime/unit-service-fetch';
import { Config, Effect, Layer, Option, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { PRICE_GROUP_CATALOG_SERVICE_BINDING } from '../shared/deployment-paths.ts';

/**
 * Commerce's outbound fetch. In a Worker, calls under the configured Price Group Catalog base URL
 * travel over that unit's service binding; Node and every other destination keep the global fetch.
 */
export const CommerceUnitTransportLive = Layer.effect(
  FetchHttpClient.Fetch,
  Config.option(Config.schema(Schema.URLFromString, 'ONTOS_PRICE_GROUP_CATALOG_BASE_URL')).pipe(
    // A malformed base URL is the Price Group Catalog port's typed failure when the catalog is used;
    // with nothing valid to route, every call keeps the global fetch.
    Effect.catchTag('ConfigError', () => Effect.succeedNone),
    Effect.map((priceGroupCatalogBaseUrl) =>
      unitRoutedFetch(
        Option.toArray(priceGroupCatalogBaseUrl).map((baseUrl) => ({
          baseUrl,
          serviceBinding: PRICE_GROUP_CATALOG_SERVICE_BINDING,
        })),
      ),
    ),
  ),
);
