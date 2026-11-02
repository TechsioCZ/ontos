import "server-only";
import type { FavoriteCatalogProduct } from "@/features/favorites/catalog";
import { createCatalog } from "@/ontos/catalog-model";
import { readProducts } from "@/ontos/catalog-server";
import type { CatalogProductVariant } from "@/ontos/catalog-types";
import { problem, RequestError } from "@/ontos/http";

const noStore = { "cache-control": "no-store" };

/**
 * One product's live OntOS card and variants in the request market (the variant chooser of favorites, watches,
 * questions and sharing, and the favorites list). Read-only public catalog data; no account data, no mutations.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    if (!slug || slug.length > 200) throw new RequestError(400, "Neplatný produkt.");
    const catalog = createCatalog(await readProducts({ slug, pageSize: 1 }, "full"), {
      categories: [],
    });
    const product = catalog.getProductBySlug(slug);
    if (!product) throw new RequestError(404, "Produkt nebyl nalezen.");
    // A product without variants is itself the one concrete item (same OntOS values, nothing invented).
    const standalone: CatalogProductVariant = {
      vatRate: product.vatRate,
      id: product.id,
      sourceId: product.id,
      sku: product.sku,
      label: product.name,
      sourceNetWeight: product.netWeight,
      minimumQuantity: product.minimumQuantity,
      packageQuantity: product.packageQuantity,
      quantityStep: product.quantityStep,
      priceMinor: product.priceMinor,
      originalPriceMinor: product.originalPriceMinor,
      stockCount: product.stockCount,
      availabilityUnknown: product.availabilityUnknown,
      priceUnavailableReason: product.priceUnavailableReason,
      unit: product.unit,
      priceTiers: product.detail.priceTiers,
      parameters: product.detail.parameters,
      isAction: product.isAction,
      isRecommended: product.isRecommended,
      isSale: product.isSale,
      isNew: product.isNew,
    };
    const body: FavoriteCatalogProduct = {
      product: catalog.toProductSummary(product),
      variants: product.detail.variants.length ? product.detail.variants : [standalone],
    };
    return Response.json(body, { headers: noStore });
  } catch (error) {
    return problem(error, "Katalog OntOS je teď nedostupný. Zkuste to prosím za chvíli.");
  }
}
