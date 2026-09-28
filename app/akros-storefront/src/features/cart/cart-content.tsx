"use client";

import Image from "next/image";
import NextLink from "next/link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";

import { useCart } from "@/features/cart/cart-provider";
import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import { getCartSubtotal } from "@/mock-storefront/cart";

const shippingMinor = 11_900;

export function CartContent() {
  const { cart, dispatch, ready } = useCart();
  const subtotal = getCartSubtotal(cart);
  const shipping = cart.lines.length > 0 ? shippingMinor : 0;

  if (!ready) return <p className="akros-empty-state">{cs.cart.loading}</p>;

  if (cart.lines.length === 0) {
    return (
      <div className="akros-empty-state akros-empty-state--cart">
        <p>{cs.cart.empty}</p>
        <LinkButton
          as={NextLink}
          href="/kategorie/nerezovy-spojovaci-material"
          size="md"
          variant="primary"
        >
          {cs.actions.backToCatalog}
        </LinkButton>
      </div>
    );
  }

  return (
    <div className="akros-cart-layout">
      <section className="akros-cart-card" aria-label={cs.cart.title}>
        <div className="akros-cart-table-heading" aria-hidden="true">
          <span>{cs.cart.product}</span>
          <span>{cs.cart.quantity}</span>
          <span>{cs.cart.unitPrice}</span>
          <span>{cs.cart.total}</span>
          <span />
        </div>
        <div className="akros-cart-lines">
          {cart.lines.map((line) => (
            <article
              className="akros-cart-line"
              key={`${line.productId}:${line.variantId ?? "base"}`}
            >
              <Image
                alt={line.imageAlt}
                height={80}
                loading="lazy"
                src={line.imageSrc}
                width={80}
              />
              <div className="akros-cart-line__details">
                <NextLink href={`/produkt/${line.slug}`}>{line.name}</NextLink>
                <small>
                  {line.variantLabel && <>{line.variantLabel} · </>}
                  {cs.product.sku}: {line.sku} · {cs.product.inStock}:{" "}
                  {line.stockCount.toLocaleString("cs-CZ")} {line.unit}
                </small>
              </div>
              <NumericInput
                aria-label={`${cs.cart.quantity}: ${line.name}`}
                min={1}
                onChange={(quantity) =>
                  dispatch({
                    type: "set-quantity",
                    productId: line.productId,
                    variantId: line.variantId,
                    quantity,
                  })
                }
                size="sm"
                value={line.quantity}
              >
                <NumericInput.Control>
                  <NumericInput.Input />
                  <NumericInput.TriggerContainer>
                    <NumericInput.IncrementTrigger />
                    <NumericInput.DecrementTrigger />
                  </NumericInput.TriggerContainer>
                </NumericInput.Control>
              </NumericInput>
              <span className="akros-cart-line__unit-price">{formatPrice(line.priceMinor)}</span>
              <strong className="akros-cart-line__total">
                {formatPrice(line.priceMinor * line.quantity)}
              </strong>
              <Button
                aria-label={`${cs.actions.remove} ${line.name.split(" ").slice(0, 2).join(" ")}`}
                onClick={() =>
                  dispatch({
                    type: "remove",
                    productId: line.productId,
                    variantId: line.variantId,
                  })
                }
                size="sm"
                theme="borderless"
                variant="danger"
              >
                ×
              </Button>
            </article>
          ))}
        </div>
      </section>

      <aside className="akros-cart-summary" aria-labelledby="cart-summary-title">
        <h2 id="cart-summary-title">{cs.cart.summary}</h2>
        <dl>
          <div>
            <dt>{cs.cart.subtotal}</dt>
            <dd>{formatPrice(subtotal)}</dd>
          </div>
          <div>
            <dt>{cs.cart.shipping}</dt>
            <dd>{formatPrice(shipping)}</dd>
          </div>
          <div className="akros-cart-summary__total">
            <dt>{cs.cart.totalWithVat}</dt>
            <dd>{formatPrice(subtotal + shipping)}</dd>
          </div>
        </dl>
        <LinkButton as={NextLink} block href="/pokladna" size="md" variant="primary">
          {cs.actions.proceedToCheckout}
        </LinkButton>
        <p>Pokladna pracuje pouze s lokálními mock daty a neprovádí skutečnou platbu.</p>
      </aside>
    </div>
  );
}
