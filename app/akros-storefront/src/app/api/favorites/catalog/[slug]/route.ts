import "server-only";
import { getCatalogPage } from "@/ontos/catalog-server";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const headers = { "cache-control": "no-store" };
  try {
    const { model } = await getCatalogPage({ slug, pageSize: 1 }, { fields: "full" });
    const product = model.getProductBySlug(slug);
    if (!product)
      return Response.json({ message: "Produkt není dostupný." }, { status: 404, headers });
    // A standalone product is a concrete sellable item too; this view supplies the same row anatomy.
    const variants = product.detail.variants.length
      ? product.detail.variants
      : [
          {
            ...product,
            sourceId: product.sku,
            label: product.name,
            priceTiers: product.detail.priceTiers,
            parameters: product.detail.parameters,
          },
        ];
    return Response.json({ product: model.toProductSummary(product), variants }, { headers });
  } catch {
    return Response.json({ message: "Katalog nyní nelze načíst." }, { status: 503, headers });
  }
}
