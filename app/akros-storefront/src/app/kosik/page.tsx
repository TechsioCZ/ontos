import type { Metadata } from "next";

import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { CartContent } from "@/features/cart/cart-content";
import { cs } from "@/i18n/cs";

export const metadata: Metadata = { title: cs.cart.title };

export default function CartPage() {
  return (
    <StorefrontWideShell>
      <StorefrontBreadcrumbs
        items={[{ href: "/", label: cs.header.home }, { label: cs.cart.title }]}
      />
      <header className="akros-page-heading">
        <h1>{cs.cart.title}</h1>
      </header>
      <CartContent />
    </StorefrontWideShell>
  );
}
