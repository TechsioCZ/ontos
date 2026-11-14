import "server-only";
import { Effect } from "effect";
import { readProductImage } from "@/ontos/product-media";
import { storefrontRuntime } from "@/ontos/runtime";

// An asset's bytes never change (a new photo is a new asset), so browsers and proxies may keep a copy for a year.
const immutable = "public, max-age=31536000, immutable";

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ asset: string; product: string }> },
) => {
  const { asset, product } = await params;
  const size =
    new URL(request.url).searchParams.get("velikost") === "nahled" ? "thumbnail" : "full";
  try {
    const image = await readProductImage(decodeURIComponent(product), asset, size);
    if (!image) {
      return new Response(null, { headers: { "cache-control": "no-store" }, status: 404 });
    }
    return new Response(image.bytes, {
      headers: {
        "cache-control": immutable,
        "content-type": image.mimeType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    await storefrontRuntime.runPromise(Effect.logWarning("N1 product image unavailable"));
    return new Response(null, {
      headers: { "cache-control": "no-store", "retry-after": "5" },
      status: 503,
    });
  }
};
