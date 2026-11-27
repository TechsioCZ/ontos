import "server-only";
import { getCatalog, getCatalogPage } from "@/ontos/catalog-server";
import { readErpProduct } from "@/ontos/erp-catalogue-server";
import { getErpOffer } from "@/ontos/erp-config";

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** The same reads the pages make (shared, 15 s): does this product, category or ERP product exist and sell? */
const exists = async (path: string): Promise<boolean> => {
  const [, kind, raw] = /^\/(produkt|kategorie|novinky-z-erp)\/([^/]+)\/?$/u.exec(path) ?? [];
  if (kind === undefined || raw === undefined) return true;
  const id = decodeURIComponent(raw);
  if (kind === "produkt")
    return (
      (await getCatalogPage({ slug: id, pageSize: 1 }, { fields: "full" })).model.getProductBySlug(
        id,
      ) !== undefined
    );
  if (kind === "kategorie") return (await getCatalog(id)).getCategoryBySlug(id) !== undefined;
  return getErpOffer() !== undefined && UUID.test(id) && (await readErpProduct(id)) !== undefined;
};

/** Proxy → here before a document render: 404 lets the proxy answer the not-found page with its real status. */
export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get("path") ?? "";
  const found = await exists(path).catch(() => true);
  return new Response(null, {
    status: found ? 204 : 404,
    headers: { "cache-control": "no-store" },
  });
}
