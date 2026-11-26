import "server-only";
import { readErpProductImage } from "@/ontos/erp-media";

// An asset's bytes never change (a new photo is a new asset), so browsers and proxies may keep a copy for a year.
const immutable = "public, max-age=31536000, immutable";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ asset: string; product: string }> },
) {
  const { asset, product } = await params;
  const url = new URL(request.url);
  const size = url.searchParams.get("velikost") === "nahled" ? "thumbnail" : "full";
  try {
    const image = await readErpProductImage(
      url.searchParams.get("tenant") ?? "",
      decodeURIComponent(product),
      asset,
      size,
      { signal: request.signal },
    );
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
    console.error("[ontos] ERP product image unavailable", error);
    return new Response(null, {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "5" },
    });
  }
}
