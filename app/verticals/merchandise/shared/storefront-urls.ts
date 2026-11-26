/** Non-secret lexical build constants supplied to browser and BFF bundles by modern.config.ts. */
declare const ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT: string | undefined;
declare const ULTRAMODERN_PUBLIC_URL_SHOP_STOREFRONT: string | undefined;

// An unbundled import has no lexical definition; reading that identifier is the only operation that can throw.
const akros = (() => {
  try {
    return ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT;
  } catch {
    return '';
  }
})();
export const AKROS_STOREFRONT_ORIGIN = akros === '' ? undefined : akros;

/** The pseudonymous demo e-shop of the demo company (ŠroubShop); none where it is not deployed. */
const shop = (() => {
  try {
    return ULTRAMODERN_PUBLIC_URL_SHOP_STOREFRONT;
  } catch {
    return '';
  }
})();
export const SHOP_STOREFRONT_ORIGIN = shop === '' ? undefined : shop;
