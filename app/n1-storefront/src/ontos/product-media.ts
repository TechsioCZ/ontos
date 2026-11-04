import "server-only";
import { Effect, Schema } from "effect";
import { readConfiguration } from "./config";
import { readOwner } from "./gateway";
import { ASSET_ID, PRODUCT_ID } from "./media-path";
import { storefrontRuntime } from "./runtime";

// Product photos are Core Media Assets. The storefront reads each rendition through the governed owner media read with
// its own service key, and OntOS records every read (the asset and the bytes' SHA-256).
const MediaResponse = Schema.Struct({
  contentBase64: Schema.String,
  contentSha256: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  mimeType: Schema.Literals(["image/jpeg", "image/png", "image/webp"]),
});

export type ProductImageSize = "full" | "thumbnail";

export interface ProductImage {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: string;
}

const readProductImageProgram = (productId: string, assetId: string, size: ProductImageSize) =>
  Effect.gen(function* readProductImageEffect() {
    const config = yield* readConfiguration(process.env);
    const media = yield* readOwner(
      config,
      "merchandise",
      "media",
      { image: `media:${assetId}`, productId, rendition: size },
      MediaResponse,
    );
    return {
      bytes: new Uint8Array(Buffer.from(media.contentBase64, "base64")),
      mimeType: media.mimeType,
    };
  });

/** One rendition of a published product's photo; undefined when OntOS does not serve it (removed, unpublished). */
export const readProductImage = async (
  productId: string,
  assetId: string,
  size: ProductImageSize,
): Promise<ProductImage | undefined> => {
  if (!PRODUCT_ID.test(productId) || !ASSET_ID.test(assetId)) {
    return undefined;
  }
  return await storefrontRuntime.runPromise(
    readProductImageProgram(productId, assetId, size).pipe(
      Effect.catchTag("StorefrontReadUnavailable", (failure) =>
        failure.status === 403 || failure.status === 404
          ? Effect.succeed(undefined)
          : Effect.fail(failure),
      ),
    ),
  );
};
