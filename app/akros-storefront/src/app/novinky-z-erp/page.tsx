import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ErpProductGrid } from "@/components/erp-product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { erpCopy } from "@/lib/erp-catalogue";
import { getDictionary } from "@/ontos/active-market";
import { readErpCataloguePage } from "@/ontos/erp-catalogue-server";
import { getErpOffer } from "@/ontos/erp-config";

export const metadata: Metadata = { title: erpCopy.title };

/** The ACTIVE products Symmy imported into Catalog, with their ERP price and stock. */
export default async function ErpCataloguePage() {
  if (getErpOffer() === undefined) notFound();
  const [{ products }, cs] = await Promise.all([readErpCataloguePage(0, 48), getDictionary()]);
  return (
    <StorefrontShell>
      <StorefrontBreadcrumbs
        className="sf-product-detail-breadcrumb"
        items={[{ href: "/", label: cs.header.home }, { label: erpCopy.title }]}
      />
      <section
        className="sf-product-listing-section grid gap-4"
        aria-labelledby="erp-products-title"
      >
        <div className="sf-section__heading">
          <h1 id="erp-products-title">{erpCopy.title}</h1>
        </div>
        <p className="m-0 text-sm leading-normal">{erpCopy.intro}</p>
        {products.length > 0 ? <ErpProductGrid products={products} /> : <p>{erpCopy.empty}</p>}
      </section>
    </StorefrontShell>
  );
}
