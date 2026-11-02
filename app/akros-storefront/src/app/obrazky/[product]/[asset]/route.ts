import "server-only";
import { readProductImage } from "@/ontos/product-media";

// An asset's bytes never change (a new photo is a new asset), so browsers and proxies may keep a copy for a year.
const immutable = "public, max-age=31536000, immutable";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ asset: string; product: string }> },
) {
  const { asset, product } = await params;
  const size =
    new URL(request.url).searchParams.get("velikost") === "nahled" ? "thumbnail" : "full";
  try {
    const image = await readProductImage(decodeURIComponent(product), asset, size);
    if (!image)
      return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(image.bytes, {
      headers: {
        "cache-control": immutable,
        "content-type": image.mimeType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("[ontos] product image unavailable", error);
    return new Response(null, {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "5" },
    });
  }
}
