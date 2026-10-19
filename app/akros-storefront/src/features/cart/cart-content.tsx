"use client";
import NextLink from "next/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { useCart } from "./cart-provider";
import { CartItemsTable } from "@/features/checkout/cart-items-table";
import { CartServices } from "@/features/checkout/cart-services";

export function CartContent() {
  const { cart, ready } = useCart();
  if (!ready) return <output>Načítám košík…</output>;
  if (!cart.lines.length)
    return (
      <section className="grid justify-items-center gap-6 rounded-sm bg-(--color-base) px-6 py-12 text-center">
        <h1 className="text-lg font-medium">Nákupní košík</h1>
        <p>Košík je zatím prázdný.</p>
        <LinkButton
          as={NextLink}
          href="/kategorie/nerezovy-spojovaci-material"
          size="sm"
          variant="primary"
        >
          Zpět do katalogu
        </LinkButton>
      </section>
    );
  return (
    <section
      className="rounded-sm bg-(--color-base) p-(--akros-checkout-panel-padding)"
      aria-labelledby="cart-title"
    >
      <h1
        id="cart-title"
        className="mb-(--dimension-32) text-(length:--akros-checkout-heading-size) leading-(--akros-checkout-heading-leading) font-medium"
      >
        Obsah košíku
      </h1>
      <CartItemsTable />
      <CartServices />
    </section>
  );
}

export function CartNavigation() {
  return (
    <div
      data-akros-cart-navigation
      className="order-3 mt-(--dimension-24) flex flex-wrap justify-between gap-(--dimension-24) pt-(--dimension-16) leading-(--akros-checkout-heading-leading) xl:col-start-1"
    >
      <LinkButton
        as={NextLink}
        href="/"
        variant="secondary"
        size="sm"
        className="w-full sm:w-(--akros-checkout-back-width)"
        uppercase
      >
        Zpět do obchodu
      </LinkButton>
      <LinkButton
        as={NextLink}
        href="/kosik/doprava-platba"
        variant="primary"
        size="sm"
        className="w-full sm:w-(--akros-checkout-continue-width)"
        uppercase
      >
        Vybrat dopravu a platbu
      </LinkButton>
    </div>
  );
}
