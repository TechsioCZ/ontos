import "server-only";
import { getCatalog, getCatalogPage } from "@/ontos/catalog-server";

/** The same reads the pages make (shared, 15 s): does this product or category exist and sell? */
const exists = async (path: string): Promise<boolean> => {
  const [, kind, raw] = /^\/(produkt|kategorie)\/([^/]+)\/?$/u.exec(path) ?? [];
  if (kind === undefined || raw === undefined) return true;
  const id = decodeURIComponent(raw);
  if (kind === "produkt")
    return (
      (await getCatalogPage({ slug: id, pageSize: 1 }, { fields: "full" })).model.getProductBySlug(
        id,
      ) !== undefined
    );
  return (await getCatalog(id)).getCategoryBySlug(id) !== undefined;
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
