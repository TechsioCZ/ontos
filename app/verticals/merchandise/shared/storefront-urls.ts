/** Non-secret build constants provided to browser and BFF bundles by modern.config.ts. */
declare global {
  var ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT: string | undefined;
  var ULTRAMODERN_PUBLIC_URL_ESHOP_STOREFRONT: string | undefined;
}

export const AKROS_STOREFRONT_ORIGIN =
  globalThis.ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT === ''
    ? undefined
    : globalThis.ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT;
export const STOREFRONT_ORIGIN =
  globalThis.ULTRAMODERN_PUBLIC_URL_ESHOP_STOREFRONT === ''
    ? undefined
    : globalThis.ULTRAMODERN_PUBLIC_URL_ESHOP_STOREFRONT;
