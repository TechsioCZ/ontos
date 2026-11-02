// Uploaded OntOS product photos (`media:<asset>` gallery references) are served from the storefront's own origin.
export const ASSET_ID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
export const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const MEDIA_REFERENCE = /^media:(.+)$/u;

/** Storefront address of an uploaded product photo; undefined for any other image reference. */
export const productMediaPath = (productId: string, reference: string): string | undefined => {
  const assetId = MEDIA_REFERENCE.exec(reference)?.[1];
  if (assetId === undefined || !ASSET_ID.test(assetId) || !PRODUCT_ID.test(productId))
    return undefined;
  return `/obrazky/${encodeURIComponent(productId)}/${assetId}`;
};
