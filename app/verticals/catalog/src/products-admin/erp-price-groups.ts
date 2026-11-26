// The company's Price Groups the ERP editor lists one Price row each for: Price Group Catalog's source associations of
// the company's Symmy price-list route (each group the ERP price lists created), read with the staff member's session.
import { makeOperationGateway } from '@app/shared-contracts';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect, Redacted, Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

import type { ErpOffer } from './erp-offer.ts';

const RefSchema = Schema.Struct({
  moduleId: Schema.String,
  resourceId: Schema.String,
  resourceType: Schema.String,
  tenantId: Schema.String,
});

const PriceGroupSourceAssociationsApi = HttpApi.make('PriceGroupSourceAssociationsApi').add(
  HttpApiGroup.make('priceGroupSourceAssociations').add(
    HttpApiEndpoint.post('execute', '/reads/price-group-source-associations', {
      payload: Schema.Struct({
        issuer: Schema.String,
        limit: Schema.Number,
        namespace: Schema.String,
        offset: Schema.Number,
        routeId: Schema.String,
      }),
      success: Schema.Struct({
        associations: Schema.Array(
          Schema.Struct({ priceGroupRef: RefSchema, sourceCorrelation: Schema.Struct({ recordKey: Schema.String }) }),
        ),
        count: Schema.Number,
      }),
    }),
  ),
);

/** The Symmy price-list route each company's ERP price groups were imported through (AKROS only today). */
const priceGroupSources: Readonly<Record<string, { issuer: string; namespace: string; routeId: string }>> = {
  akros: { issuer: 'symmy-akros', namespace: 'akros-erp', routeId: '9e355544-4242-4704-a9d3-0ef0832fc328' },
};

const gateway = makeOperationGateway('price-group-catalog');

export interface ErpPriceGroup {
  readonly label: string;
  readonly priceGroupRef: typeof RefSchema.Type;
}

/** The company's Price Groups by their ERP code, or none when the offer's company has no ERP price-list route. */
export const readErpPriceGroups = (offer: ErpOffer, requestCorrelation: string) => {
  const source = priceGroupSources[offer.customerConfigurationId];
  if (source === undefined) {
    return Effect.succeed<readonly ErpPriceGroup[]>([]);
  }
  return gateway
    .invoke((credential, { apiBaseUrl, compositionRevision }) =>
      makeGovernedEffectBffClient(
        {
          api: PriceGroupSourceAssociationsApi,
          credential: Redacted.make(credential),
          defaultApiPrefix: '/price-group-catalog-api',
          requestCorrelation,
        },
        { baseUrl: apiBaseUrl, compositionRevision },
      ).pipe(
        Effect.flatMap((client) =>
          client.priceGroupSourceAssociations.execute({ payload: { ...source, limit: 100, offset: 0 } }),
        ),
      ),
    )
    .pipe(
      Effect.map(({ associations }) => {
        const seen = new Set<string>();
        return associations.flatMap(({ priceGroupRef, sourceCorrelation }): ErpPriceGroup[] => {
          if (seen.has(priceGroupRef.resourceId)) {
            return [];
          }
          seen.add(priceGroupRef.resourceId);
          return [{ label: sourceCorrelation.recordKey, priceGroupRef }];
        });
      }),
    );
};
