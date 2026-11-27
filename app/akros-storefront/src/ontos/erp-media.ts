import type { OperationOptions } from "@ontos/storefront-runtime";
import "server-only";
// Images of ERP-imported Catalog products: Core Media Assets that a Catalog media assignment names, served from the
// storefront's own origin through Catalog's governed image read (commerce.catalog.api.catalog-media-content).
import { OntosError, readRecords } from "./gateway";
import { ASSET_ID } from "./media-path";

const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const UUID = ASSET_ID;

export interface ErpImage {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: string;
}

/** One rendition of a Product's assigned image; undefined when Catalog does not serve it (removed, retired). */
export const readErpProductImage = async (
  tenantId: string,
  productId: string,
  assetId: string,
  size: "full" | "thumbnail",
  options: OperationOptions = {},
): Promise<ErpImage | undefined> => {
  if (!UUID.test(productId) || !ASSET_ID.test(assetId) || !/^[\da-f-]{36}$/u.test(tenantId))
    return undefined;
  try {
    const body = (await readRecords(
      "catalog",
      "catalog-media-content",
      {
        assetId,
        productRef: {
          moduleId: "commerce.catalog",
          resourceId: productId,
          resourceType: "commerce.catalog.product",
          tenantId,
        },
        rendition: size,
      },
      options,
    )) as { contentBase64?: unknown; mimeType?: unknown };
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
