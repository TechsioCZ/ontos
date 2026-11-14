"use client";
import StoreLink from "@/components/store-link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { useCartQuote } from "@/ontos/cart-revalidation";
import { useCart } from "./cart-provider";
import { CartItemsTable } from "@/features/checkout/cart-items-table";
import { CartServices } from "@/features/checkout/cart-services";
import { useDictionary } from "@/ontos/market-context";
import { CartWeight } from "./cart-weight";

export function CartContent() {
  const cs = useDictionary();
  const { cart, ready } = useCart();
  if (!ready) return <output>{cs.cart.loading}</output>;
  if (!cart.lines.length)
    return (
      <section className="grid justify-items-center gap-6 rounded-sm bg-(--color-base) px-6 py-12 text-center">
        <h1 className="text-lg font-medium">{cs.cart.title}</h1>
        <p>{cs.cart.empty}</p>
        <LinkButton
          as={StoreLink}
          href="/kategorie/nerezovy-spojovaci-material"
          size="sm"
          variant="primary"
        >
          {cs.actions.backToCatalog}
        </LinkButton>
      </section>
    );
  return (
    <section
      className="rounded-sm bg-(--color-base) p-(--sf-checkout-panel-padding)"
      aria-labelledby="cart-title"
    >
      <h1
        id="cart-title"
        className="mb-(--dimension-32) text-(length:--sf-checkout-heading-size) leading-(--sf-checkout-heading-leading) font-medium"
      >
        {cs.cart.itemsTitle}
      </h1>
      <CartItemsTable />
      <CartWeight />
      <CartServices />
    </section>
  );
}

export function CartNavigation() {
  const cs = useDictionary();
  const quote = useCartQuote();
  const blocked = quote ? !quote.canContinue : false;
  return (
    <div
      data-sf-cart-navigation
      className="order-3 mt-(--dimension-24) flex flex-wrap justify-between gap-(--dimension-24) pt-(--dimension-16) leading-(--sf-checkout-heading-leading) xl:col-start-1"
    >
      <LinkButton
        as={StoreLink}
        href="/"
        variant="secondary"
        size="sm"
        className="w-full sm:w-(--sf-checkout-back-width)"
        uppercase
      >
        {cs.cart.backToShop}
      </LinkButton>
      {blocked ? (
        <div className="grid w-full gap-2 sm:w-(--sf-checkout-continue-width)">
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="w-full"
            uppercase
            disabled
            aria-describedby="cart-continue-blocked"
          >
            {cs.cart.chooseDelivery}
          </Button>
          <p id="cart-continue-blocked" className="text-xs text-(--color-fg-secondary)">
            {quote?.blockedReason}
          </p>
        </div>
      ) : (
        <LinkButton
          as={StoreLink}
          href="/kosik/doprava-platba"
          variant="primary"
          size="sm"
          className="w-full sm:w-(--sf-checkout-continue-width)"
          uppercase
        >
          {cs.cart.chooseDelivery}
        </LinkButton>
      )}
    </div>
  );
}
