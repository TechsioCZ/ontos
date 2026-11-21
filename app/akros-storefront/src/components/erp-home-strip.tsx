import StoreLink from "@/components/store-link";
import { ErpProductGrid } from "@/components/erp-product-grid";
import { erpCopy } from "@/lib/erp-catalogue";
import { readErpCataloguePage } from "@/ontos/erp-catalogue-server";
import { getErpOffer } from "@/ontos/erp-config";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

/** A short strip of ERP products on the home page; the home page never waits on or fails with it. */
export async function ErpHomeStrip() {
  if (getErpOffer() === undefined) return null;
  let products;
  try {
    ({ products } = await readErpCataloguePage(0, 4));
  } catch (error) {
    console.error("[AKROS] novinky z ERP", isError(error) ? error.message : error);
    return null;
  }
  if (products.length === 0) return null;
  return (
    <section
      className="sf-product-listing-section mt-12 grid gap-4"
      aria-labelledby="erp-home-title"
    >
      <div className="sf-section__heading">
        <h2 id="erp-home-title">{erpCopy.title}</h2>
        <StoreLink href="/novinky-z-erp">{erpCopy.showAll}</StoreLink>
      </div>
      <ErpProductGrid products={products} />
    </section>
  );
}
