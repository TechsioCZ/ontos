import { CustomerConfigurationIdSchema } from '@app/inventory/launch-scope';
import { makeOperationGateway } from '@app/shared-contracts';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect, Option, Redacted, Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

/** The Commerce Market the ERP prices were imported for (Pricing's stable market text). */
const ErpOfferMarketIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
  Schema.isTrimmed(),
).pipe(Schema.brand('ErpOfferMarketId'));

/** The Catalog Product Unit of the imported Price Unit basis. */
const ErpOfferUnitIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ErpOfferUnitId'));

/**
 * The ERP offer a staff member views the imported products under: the Inventory Customer Configuration whose stock
 * figures are shown and the exact Price key scope Symmy's price route imported its prices with (Channel, Commerce
 * Market, currency and Unit basis). The same fields as the storefront's ONTOS_STOREFRONT_ERP_OFFER; the page takes
 * them from the signed-in company's own data (`readCompanyErpOffer`), or from its URL query when that names a
 * complete offer.
 */
export const ErpOfferSchema = Schema.Struct({
  channelId: Schema.Literals(['B2C', 'B2B']),
  currencyCode: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u)),
  customerConfigurationId: CustomerConfigurationIdSchema,
  marketId: ErpOfferMarketIdSchema,
  unitId: ErpOfferUnitIdSchema,
  unitQuantity: Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u)),
});
export type ErpOffer = typeof ErpOfferSchema.Type;

const offerFields = ['channelId', 'currencyCode', 'customerConfigurationId', 'marketId', 'unitId', 'unitQuantity'];

const decodeOffer = Schema.decodeUnknownOption(ErpOfferSchema);

/** The complete offer a URL query names, or none; `unitQuantity` defaults to `1`. */
export const erpOfferFromSearch = (search: string): Option.Option<ErpOffer> => {
  const params = new URLSearchParams(search);
  const named = Object.fromEntries(
    offerFields.flatMap((field) => {
      const value = params.get(field);
      return value === null ? [] : [[field, value]];
    }),
  );
  return decodeOffer({ unitQuantity: '1', ...named });
};

const OfferJsonSchema = Schema.fromJsonString(ErpOfferSchema);

/** The offer as one text (a page data key); it is a valid offer, so it always encodes. */
export const encodeErpOffer = (offer: ErpOffer): string =>
  Option.getOrElse(Schema.encodeOption(OfferJsonSchema)(offer), () => '');

const EmptyPayloadSchema = Schema.Struct({});

/** Pricing's standing price source scopes of the selected company (`commerce.pricing.api.external-price-source-scopes`). */
const PricingScopesApi = HttpApi.make('ErpOfferPricingApi').add(
  HttpApiGroup.make('scopes').add(
    HttpApiEndpoint.post('read', '/reads/external-price-source-scopes', {
      payload: EmptyPayloadSchema,
      success: Schema.Struct({
        scopes: Schema.Array(
          Schema.Struct({
            channelId: Schema.String,
            currencyCode: Schema.String,
            marketId: Schema.String,
            unitId: Schema.String,
            unitQuantity: Schema.String,
          }),
        ),
      }),
    }),
  ),
);

/** Symmy's stock source of the selected company (`integration.symmy.api.symmy-company-stock-source`). */
const SymmyStockSourceApi = HttpApi.make('ErpOfferSymmyApi').add(
  HttpApiGroup.make('stock').add(
    HttpApiEndpoint.post('read', '/reads/symmy-company-stock-source', {
      payload: EmptyPayloadSchema,
      success: Schema.Struct({ customerConfigurationIds: Schema.Array(Schema.String) }),
    }),
  ),
);

const pricingGateway = makeOperationGateway('pricing');
const symmyGateway = makeOperationGateway('symmy-integration');

const pricingScopes = (requestCorrelation: string) =>
  pricingGateway.invoke((credential, { apiBaseUrl, compositionRevision }) =>
    makeGovernedEffectBffClient(
      {
        api: PricingScopesApi,
        credential: Redacted.make(credential),
        defaultApiPrefix: '/pricing-api',
        requestCorrelation,
      },
      { baseUrl: apiBaseUrl, compositionRevision },
    ).pipe(Effect.flatMap((client) => client.scopes.read({ payload: {} }))),
  );

const stockSources = (requestCorrelation: string) =>
  symmyGateway.invoke((credential, { apiBaseUrl, compositionRevision }) =>
    makeGovernedEffectBffClient(
      {
        api: SymmyStockSourceApi,
        credential: Redacted.make(credential),
        defaultApiPrefix: '/symmy-integration-api',
        requestCorrelation,
      },
      { baseUrl: apiBaseUrl, compositionRevision },
    ).pipe(Effect.flatMap((client) => client.stock.read({ payload: {} }))),
  );

/**
 * The ERP offer of the signed-in company, from its owners' data: the one standing base price source scope Pricing
 * holds for it and the one Inventory Customer Configuration its Symmy routes resolve stock in. None when either is
 * missing or ambiguous (nothing is guessed), or when the company has no access to them.
 */
export const readCompanyErpOffer = (requestCorrelation: string) =>
  Effect.all([pricingScopes(requestCorrelation), stockSources(requestCorrelation)], { concurrency: 2 }).pipe(
    Effect.map(([{ scopes }, { customerConfigurationIds }]) => {
      const [scope, ...otherScopes] = scopes;
      const [customerConfigurationId, ...otherSources] = customerConfigurationIds;
      return scope === undefined ||
        customerConfigurationId === undefined ||
        otherScopes.length > 0 ||
        otherSources.length > 0
        ? Option.none<ErpOffer>()
        : decodeOffer({ ...scope, customerConfigurationId });
    }),
    Effect.orElseSucceed(() => Option.none<ErpOffer>()),
  );

/**
 * The locale the product texts are paged in: the URL's `locale`, else `cs`. Catalog answers a text only in the exact
 * locale it was stored under, and the texts an ERP import sends carry the market's locale (`cs`), not a region tag.
 */
export const catalogLocaleFromSearch = (search: string): string => {
  const locale = new URLSearchParams(search).get('locale')?.trim();
  return locale === undefined || locale === '' ? 'cs' : locale;
};
