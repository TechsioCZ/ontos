import StoreLink from "@/components/store-link";
import { erpCopy } from "@/lib/erp-catalogue";
import { getErpOffer } from "@/ontos/erp-config";

export function ErpHomeStrip() {
  if (getErpOffer() === undefined) return null;
  return (
    <section
      className="sf-product-listing-section mt-12 grid gap-4"
      aria-labelledby="erp-home-title"
    >
      <div className="sf-section__heading">
        <h2 id="erp-home-title">{erpCopy.title}</h2>
        <StoreLink href="/novinky-z-erp">{erpCopy.showAll}</StoreLink>
      </div>
    </section>
  );
}
