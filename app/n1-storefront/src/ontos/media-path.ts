// Uploaded product photos (`media:<asset>` references, Core Media Assets) are served from the storefront's own origin,
// through the governed owner media read. Any other image source must be a public HTTPS address on an allowed host.
export const ASSET_ID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
export const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const MEDIA_REFERENCE = /^media:(?<asset>.+)$/u;
const STOREFRONT_MEDIA_PATH = /^\/obrazky\/(?<product>[^/]+)\/(?<asset>[^/]+)$/u;

/** Storefront address of an uploaded product photo; undefined for any other image reference. */
export const productMediaPath = (productId: string, reference: string): string | undefined => {
  const assetId = MEDIA_REFERENCE.exec(reference)?.groups?.asset;
  if (assetId === undefined || !ASSET_ID.test(assetId) || !PRODUCT_ID.test(productId)) {
    return undefined;
  }
  return `/obrazky/${encodeURIComponent(productId)}/${assetId}`;
};

/** Whether a source already is a storefront photo address that `productMediaPath` produced. */
export const isStorefrontMediaPath = (source: string): boolean => {
  const match = STOREFRONT_MEDIA_PATH.exec(source);
  if (match === null) {
    return false;
  }
  const { asset = "", product = "" } = match.groups ?? {};
  let productId: string;
  try {
    productId = decodeURIComponent(product);
  } catch {
    return false;
  }
  return PRODUCT_ID.test(productId) && ASSET_ID.test(asset);
};
