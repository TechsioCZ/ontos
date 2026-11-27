// „Na e-shopu: ano/ne“ of an ERP product on the Akros storefront. The storefront rule is
// akros-storefront/src/lib/erp-catalogue.ts `isErpProductShown`: the product is ACTIVE (a DRAFT „Koncept“ is never
// sold) and it has a Variant that is not RETIRED. Such a product is on „Novinky z ERP“, has its own
// page and is found by the header search and the search results page; a Variant without a price shows „Cena na dotaz“.
import { Option } from 'effect';
import type { ProductPageItem } from '../../shared/apis/product-page.ts';
import type { ErpOffer } from './erp-offer.ts';

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

/** None for a company whose e-shop does not sell ERP products: one without an ERP offer. */
export const erpStorefrontStatus = (
  item: ProductPageItem,
  offer: Option.Option<ErpOffer>,
): Option.Option<ErpStorefrontStatus> => {
  if (Option.isNone(offer)) {
    return Option.none();
  }
  const reasons: { fix: string; why: string }[] = [];
  if (item.lifecycle === 'DRAFT') {
    reasons.push({
      fix: 'V Upravit nastavte stav na „Aktivní (ACTIVE)“ a uložte.',
      why: 'Produkt je ve stavu Koncept; e-shop prodává jen aktivní produkty.',
    });
  }
  if (item.lifecycle === 'RETIRED') {
    reasons.push({
      fix: 'V Upravit produkt obnovte a nastavte stav na „Aktivní (ACTIVE)“.',
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
        'Z e-shopu ho stáhnete stavem Koncept nebo Vyřazený.',
        'Varianta bez ceny z ERP se v e-shopu ukáže jako „Cena na dotaz“ (ceny vidíte v Zobrazit varianty).',
      ]
    : [];
  // The Akros shop is Czech: its own links name the market locale, so this one opens the page without a redirect.
  const status: ErpStorefrontStatus = { notes, reasons, visible };
  if (visible && akrosOrigin !== '') {
    Object.assign(status, {
      href: `${akrosOrigin}/cs/novinky-z-erp/${encodeURIComponent(item.productRef.resourceId)}`,
    });
  }
  return Option.some(status);
};
