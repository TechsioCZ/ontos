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
          severity="primary"
        >
          {cs.actions.backToCatalog}
        </LinkButton>
      </section>
    );
  return (
    <section className="sf-checkout-panel" aria-labelledby="cart-title">
      <h1 id="cart-title" className="sf-checkout-section-heading">
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
    <div data-sf-cart-navigation className="sf-checkout-actions">
      <LinkButton
        as={StoreLink}
        href="/"
        severity="secondary"
        size="sm"
        className="sf-checkout-back"
        data-sf-checkout-action
        uppercase
      >
        {cs.cart.backToShop}
      </LinkButton>
      {blocked ? (
        <div className="sf-checkout-next">
          <Button
            type="button"
            severity="primary"
            size="sm"
            data-sf-checkout-action
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
        <div className="sf-checkout-next">
          <LinkButton
            as={StoreLink}
            href="/kosik/doprava-platba"
            severity="primary"
            size="sm"
            data-sf-checkout-action
            uppercase
          >
            {cs.cart.chooseDelivery}
          </LinkButton>
        </div>
      )}
    </div>
  );
}
