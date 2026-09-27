import type { Metadata } from "next";

import { AccountShell } from "@/components/account-shell";
import { ProductGrid } from "@/components/product-grid";
import { getProducts } from "@/mock-storefront/catalog";

export const metadata: Metadata = { title: "Oblíbené produkty" };

export default function FavoritesPage() {
  return (
    <AccountShell active="favorites">
      <header className="akros-account-heading">
        <div>
          <h1>Oblíbené produkty</h1>
          <p>Seznam položek, které odebíráte nejčastěji.</p>
        </div>
        <a href="#oblibene-produkty">Sdílet seznam</a>
      </header>
      <section className="akros-favorites-grid" id="oblibene-produkty">
        <ProductGrid products={getProducts().slice(0, 6)} />
      </section>
    </AccountShell>
  );
}
