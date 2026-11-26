// „Na e-shopu: ano/ne“ of an ERP product on the Akros storefront. The storefront rule is
// akros-storefront/src/lib/erp-catalogue.ts `isErpProductShown`: Catalog answers the product to the storefront's page
// read (DRAFT or ACTIVE) and it has a Variant that is not RETIRED. Such a product is on „Novinky z ERP“, has its own
// page and is found by the header search and the search results page; a Variant without a price shows „Cena na dotaz“.
import { Option } from 'effect';
import type { ProductPageItem } from '../../shared/apis/product-page.ts';
import { companyErpOffer } from './erp-offer.ts';

declare const ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT: string | undefined;
const akrosOrigin = (() => {
  try {
    return ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT ?? '';
  } catch {
    return '';
  }
})();

export interface ErpStorefrontStatus {
  readonly href?: string;
  readonly notes: readonly string[];
  readonly reasons: readonly { readonly fix: string; readonly why: string }[];
  readonly visible: boolean;
}

/** None for a company whose e-shop does not sell ERP products. */
export const erpStorefrontStatus = (
  item: ProductPageItem,
  legalEntityId: string,
): Option.Option<ErpStorefrontStatus> => {
  if (Option.isNone(companyErpOffer(legalEntityId))) {
    return Option.none();
  }
  const reasons: { fix: string; why: string }[] = [];
  if (item.lifecycle === 'RETIRED') {
    reasons.push({
      fix: 'V Upravit nastavte stav produktu na Aktivní (nebo Koncept).',
      why: 'Produkt je vyřazený.',
    });
  }
  if (!item.variants.some((variant) => variant.lifecycle !== 'RETIRED')) {
    reasons.push({ fix: 'V Upravit obnovte aspoň jednu variantu.', why: 'Všechny varianty produktu jsou vyřazené.' });
  }
  const visible = reasons.length === 0;
  const notes = visible
    ? [
        'Najdete ho v sekci Novinky z ERP, ve vyhledávání e-shopu (název, SKU, parametry) a na jeho vlastní stránce.',
        ...(item.lifecycle === 'DRAFT'
          ? ['Demo e-shop ukazuje i produkty ve stavu Koncept. Skrýt ho jde jen vyřazením.']
          : []),
        'Varianta bez ceny z ERP se v e-shopu ukáže jako „Cena na dotaz“ (ceny vidíte v Zobrazit varianty).',
      ]
    : [];
  return Option.some({
    notes,
    reasons,
    visible,
    ...(visible && akrosOrigin !== ''
      ? { href: `${akrosOrigin}/novinky-z-erp/${encodeURIComponent(item.productRef.resourceId)}` }
      : {}),
  });
};
