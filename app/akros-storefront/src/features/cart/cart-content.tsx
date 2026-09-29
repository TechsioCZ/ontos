"use client";
import NextLink from "next/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { useCart } from "./cart-provider";
import { CartItemsTable } from "@/features/checkout/cart-items-table";

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
    <>
      <section className="rounded-sm bg-(--color-base) p-4 md:p-6" aria-labelledby="cart-title">
        <h1 id="cart-title" className="mb-4 text-md font-medium">
          Obsah košíku
        </h1>
        <CartItemsTable />
      </section>
      <div className="mt-6 flex flex-wrap justify-between gap-4">
        <LinkButton as={NextLink} href="/" variant="secondary" size="sm" uppercase>
          Zpět do obchodu
        </LinkButton>
        <LinkButton
          as={NextLink}
          href="/kosik/doprava-platba"
          variant="primary"
          size="sm"
          uppercase
        >
          Vybrat dopravu a platbu
        </LinkButton>
      </div>
    </>
  );
}
