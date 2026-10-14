import type { Metadata } from "next";
import { AccountLink } from "@/features/account/account-link";
import { AccountShell } from "@/components/account-shell";
import { ProductGrid } from "@/components/product-grid";
import { AccountHeading } from "@/features/account/account-content";
import { getProducts, toProductSummary } from "@/mock-storefront/catalog";

export const metadata: Metadata = { title: "Oblíbené produkty" };
export default function FavoritesPage() {
  return (
    <AccountShell active="favorites">
      <AccountHeading
        title="Oblíbené produkty"
        description="Ukázkový seznam často nakupovaných produktů."
      >
        <AccountLink
          href="/muj-ucet/prehled"
          data-account-action
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          Zpět na přehled
        </AccountLink>
      </AccountHeading>
      <div data-account-products>
        <ProductGrid
          products={getProducts().slice(0, 6).map(toProductSummary)}
          columns="featured"
        />
      </div>
    </AccountShell>
  );
}
