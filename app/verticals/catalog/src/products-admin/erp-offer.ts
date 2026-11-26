import { CustomerConfigurationIdSchema } from '@app/inventory/launch-scope';
import { Option, Schema } from 'effect';

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
 * them from its URL query and remembers the last complete offer in this browser.
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

/** The offer as the text the browser remembers it by; it is a valid offer, so it always encodes. */
export const encodeErpOffer = (offer: ErpOffer): string =>
  Option.getOrElse(Schema.encodeOption(OfferJsonSchema)(offer), () => '');

export const decodeStoredErpOffer = (stored: string | null): Option.Option<ErpOffer> =>
  stored === null ? Option.none() : Schema.decodeUnknownOption(OfferJsonSchema)(stored);

const offerStorageKey = 'ontos.catalog.products.erp-offer';

/**
 * The ERP offer each company's storefront sells under, the same as the storefront's ONTOS_STOREFRONT_ERP_OFFERS
 * (app/zerops.yaml), so staff see ERP price and stock without naming the offer in the address.
 */
const akrosCompanyId = 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7';
const akrosStorefrontOffer = {
  channelId: 'B2C',
  currencyCode: 'CZK',
  customerConfigurationId: 'akros',
  marketId: 'e57c614d-3911-5a52-941e-29168b1db5e4',
  unitId: '43d5c797-2b36-4877-85ad-caac3a674d9c',
  unitQuantity: '1',
};

/** The offer the signed-in company's storefront sells under, or none. */
export const companyErpOffer = (legalEntityId: string): Option.Option<ErpOffer> =>
  legalEntityId === akrosCompanyId ? decodeOffer(akrosStorefrontOffer) : Option.none();

/** The last complete offer this browser was opened with. Browser only. */
export const rememberedErpOffer = (): Option.Option<ErpOffer> =>
  decodeStoredErpOffer(globalThis.localStorage.getItem(offerStorageKey));

/** Remembers a complete offer so the navigation entry opens the page with it. Browser only. */
export const rememberErpOffer = (offer: ErpOffer): void => {
  globalThis.localStorage.setItem(offerStorageKey, encodeErpOffer(offer));
};

/**
 * The locale the product texts are paged in: the URL's `locale`, else `cs`. Catalog answers a text only in the exact
 * locale it was stored under, and the texts an ERP import sends carry the market's locale (`cs`), not a region tag.
 */
export const catalogLocaleFromSearch = (search: string): string => {
  const locale = new URLSearchParams(search).get('locale')?.trim();
  return locale === undefined || locale === '' ? 'cs' : locale;
};
