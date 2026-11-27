import { redirect } from "next/navigation";

import { marketHref } from "@/ontos/active-market";
import { readProducts } from "@/ontos/catalog-server";

interface ErpProductPageProps {
  params: Promise<{ productId: string }>;
}

/**
 * An old „Novinky z ERP“ link names a main Catalog product. Its Symmy import is the merchandise product
 * `symmy-<Catalog product id>`: the link opens that product's normal page, or the shop when it is not sold.
 */
export default async function ErpProductPage({ params }: ErpProductPageProps): Promise<never> {
  const productId = decodeURIComponent((await params).productId).trim();
  const page =
    productId === ""
      ? undefined
      : await readProducts(
          { productIds: [`symmy-${productId}`], page: 1, pageSize: 1 },
          "card",
        ).catch(() => undefined);
  const slug = page?.products[0]?.slug;
  redirect(await marketHref(slug === undefined ? "/" : `/produkt/${encodeURIComponent(slug)}`));
}
