/** Non-secret build constants provided to browser and BFF bundles by modern.config.ts. */
declare global {
  var ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT: string | undefined;
  var ULTRAMODERN_PUBLIC_URL_SHOP_STOREFRONT: string | undefined;
}

export const AKROS_STOREFRONT_ORIGIN =
  globalThis.ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT === ''
    ? undefined
    : globalThis.ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT;

/** The pseudonymous demo e-shop of the demo company (ŠroubShop); none where it is not deployed. */
export const SHOP_STOREFRONT_ORIGIN =
  globalThis.ULTRAMODERN_PUBLIC_URL_SHOP_STOREFRONT === ''
    ? undefined
    : globalThis.ULTRAMODERN_PUBLIC_URL_SHOP_STOREFRONT;
