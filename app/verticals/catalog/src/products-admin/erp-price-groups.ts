// The company's customer Price Groups the ERP editor lists one Price row each for: Price Group Catalog's source
// associations of the company's Symmy price-list route (every group the ERP price lists created), each named by its
// current definition, read with the staff member's session and company.
import { makeOperationGateway } from '@app/shared-contracts';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { DateTime, Effect, Redacted, Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

import type { ErpOffer } from './erp-offer.ts';

const PriceGroupRefSchema = Schema.Struct({
  moduleId: Schema.Literal('pricing.price-group-catalog'),
  resourceId: Schema.String,
  resourceType: Schema.Literal('pricing.price-group-catalog.price-group'),
  tenantId: Schema.String,
});

/** The most associations one page answers (the read's own limit). */
const pageSize = 100;

const PriceGroupCatalogApi = HttpApi.make('ErpPriceGroupCatalogApi').add(
  HttpApiGroup.make('priceGroups')
    .add(
      HttpApiEndpoint.post('associations', '/reads/price-group-source-associations', {
        payload: Schema.Struct({
          issuer: Schema.String,
          limit: Schema.Number,
          namespace: Schema.String,
          offset: Schema.Number,
          routeId: Schema.String,
        }),
        success: Schema.Struct({
          associations: Schema.Array(Schema.Struct({ priceGroupRef: PriceGroupRefSchema })),
          count: Schema.Number,
        }),
      }),
    )
    .add(
      HttpApiEndpoint.post('definition', '/reads/price-group-definition', {
        payload: Schema.Struct({ priceGroupRef: PriceGroupRefSchema, trustedOperationAt: Schema.String }),
        success: Schema.Struct({
          definition: Schema.Struct({ displayName: Schema.String }),
          identity: Schema.Struct({ lifecycle: Schema.Struct({ state: Schema.String }) }),
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
  readonly priceGroupRef: typeof PriceGroupRefSchema.Type;
}

const clientOf = (credential: string, requestCorrelation: string, baseUrl: string, compositionRevision: string) =>
  makeGovernedEffectBffClient(
    {
      api: PriceGroupCatalogApi,
      credential: Redacted.make(credential),
      defaultApiPrefix: '/price-group-catalog-api',
      requestCorrelation,
    },
    { baseUrl, compositionRevision },
  );

type PriceGroupCatalogClient = Effect.Success<ReturnType<typeof clientOf>>;

/** One request under its own Shell assertion: an assertion is single-use, so every page and every definition read
 * acquires a fresh one. */
const withClient = <Success, Failure>(
  requestCorrelation: string,
  call: (client: PriceGroupCatalogClient) => Effect.Effect<Success, Failure>,
) =>
  gateway.invoke((credential, { apiBaseUrl, compositionRevision }) =>
    clientOf(credential, requestCorrelation, apiBaseUrl, compositionRevision).pipe(Effect.flatMap(call)),
  );

type PriceGroupRef = typeof PriceGroupRefSchema.Type;

/** One page of the route's associations. */
const readAssociationsPage = (requestCorrelation: string, source: (typeof priceGroupSources)[string], offset: number) =>
  withClient(requestCorrelation, (client) =>
    client.priceGroups.associations({ payload: { ...source, limit: pageSize, offset } }),
  );

/** Every Price Group the route's associations name, once each, in the order the catalog answers them; page by page. */
const associatedGroups = (
  requestCorrelation: string,
  source: (typeof priceGroupSources)[string],
  offset = 0,
  seen: ReadonlyMap<string, PriceGroupRef> = new Map(),
): Effect.Effect<readonly PriceGroupRef[], Effect.Error<ReturnType<typeof readAssociationsPage>>> =>
  readAssociationsPage(requestCorrelation, source, offset).pipe(
    Effect.flatMap((page) => {
      const refs = new Map([
        ...seen,
        ...page.associations.map(({ priceGroupRef }) => [priceGroupRef.resourceId, priceGroupRef] as const),
      ]);
      return page.associations.length < pageSize || offset + pageSize >= page.count
        ? Effect.succeed([...refs.values()])
        : associatedGroups(requestCorrelation, source, offset + pageSize, refs);
    }),
  );

/** The groups that are active now, each by its current definition's name. */
const namedGroups = (requestCorrelation: string, refs: readonly PriceGroupRef[]) =>
  Effect.gen(function* named() {
    const trustedOperationAt = DateTime.formatIso(yield* DateTime.now);
    const groups = yield* Effect.forEach(
      refs,
      (priceGroupRef) =>
        withClient(requestCorrelation, (client) =>
          client.priceGroups.definition({ payload: { priceGroupRef, trustedOperationAt } }),
        ).pipe(
          Effect.map(({ definition, identity }): readonly ErpPriceGroup[] =>
            identity.lifecycle.state === 'ACTIVE' ? [{ label: definition.displayName, priceGroupRef }] : [],
          ),
        ),
      { concurrency: 4 },
    );
    return groups.flat().toSorted((left, right) => left.label.localeCompare(right.label, 'cs'));
  });

/**
 * The company's active Price Groups by their catalog name, or none when the offer's company has no ERP price-list
 * route. A failed read fails the whole list, so a group is never silently missing.
 */
export const readErpPriceGroups = (offer: ErpOffer, requestCorrelation: string) => {
  const source = priceGroupSources[offer.customerConfigurationId];
  if (source === undefined) {
    return Effect.succeed<readonly ErpPriceGroup[]>([]);
  }
  return associatedGroups(requestCorrelation, source).pipe(
    Effect.flatMap((refs) => namedGroups(requestCorrelation, refs)),
    Effect.mapError((problem) => `Cenové skupiny: ${problem._tag}`),
  );
};
