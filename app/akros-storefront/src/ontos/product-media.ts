import "server-only";
// Product photos uploaded in OntOS are Core Media Assets. The storefront serves them from its own origin through the
// governed media read; OntOS records every read (the storefront's service principal, the asset and its content hash).
import { OntosError, readRecords } from "./gateway";

import { ASSET_ID, PRODUCT_ID } from "./media-path";

const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type ProductImageSize = "full" | "thumbnail";

export interface ProductImage {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: string;
}

/** One rendition of a published product's photo; undefined when OntOS does not serve it (removed, unpublished). */
export const readProductImage = async (
  productId: string,
  assetId: string,
  size: ProductImageSize,
): Promise<ProductImage | undefined> => {
  if (!PRODUCT_ID.test(productId) || !ASSET_ID.test(assetId)) return undefined;
  try {
    const body = (await readRecords("merchandise", "media", {
      image: `media:${assetId}`,
      productId,
      rendition: size,
    })) as { contentBase64?: unknown; mimeType?: unknown };
    if (
      typeof body.contentBase64 !== "string" ||
      typeof body.mimeType !== "string" ||
      !MIME_TYPES.has(body.mimeType)
    )
      throw new OntosError("Media response is malformed", 502, "media_malformed");
    return {
      bytes: new Uint8Array(Buffer.from(body.contentBase64, "base64")),
      mimeType: body.mimeType,
    };
  } catch (error) {
    if (OntosError.is(error) && (error.status === 404 || error.status === 403)) return undefined;
    throw error;
  }
};
