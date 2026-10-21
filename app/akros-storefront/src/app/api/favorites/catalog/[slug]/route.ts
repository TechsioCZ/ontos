import { getProductBySlug, toProductSummary } from "@/mock-storefront/catalog";
import type { FavoriteCatalogProduct } from "@/features/favorites/catalog";

// Read-only public demo catalog. No account data or mutations are served here.
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = getProductBySlug(slug);
  if (!product) return Response.json({ error: "Produkt nebyl nalezen." }, { status: 404 });
  const body: FavoriteCatalogProduct = {
    product: toProductSummary(product),
    variants: product.detail.variants.length
      ? product.detail.variants
      : [
          {
            id: product.id,
            sourceId: product.id,
            sku: product.sku,
            label: product.name,
            minimumQuantity: product.minimumQuantity,
            packageQuantity: product.packageQuantity,
            priceMinor: product.priceMinor,
            originalPriceMinor: product.originalPriceMinor,
            stockCount: product.stockCount,
            unit: product.unit,
            priceTiers: product.detail.priceTiers,
            parameters: product.detail.parameters,
            isAction: product.isAction,
            isRecommended: product.isRecommended,
            isSale: product.isSale,
            isNew: product.isNew,
          },
        ],
  };
  return Response.json(body);
}
