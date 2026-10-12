"use client";

import { Icon } from "@techsio/ui-kit/atoms/icon";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { useCart } from "@/features/cart/cart-provider";
import { getCartSubtotal } from "@/mock-storefront/cart";
import {
  demoExtendedReturn,
  demoFreeShippingThresholdMinor,
} from "@/mock-storefront/fixtures/checkout";
import { useCheckout } from "./checkout-provider";
import { formatCheckoutPrice } from "./checkout-format";

export function CartServices() {
  const { cart } = useCart();
  const { draft, updateDraft } = useCheckout();
  const subtotal = getCartSubtotal(cart);
  const remaining = Math.max(0, demoFreeShippingThresholdMinor - subtotal);
  return (
    <div
      data-akros-cart-services
      className="@container/cart-services grid gap-(--dimension-24) pt-(--dimension-8) font-medium leading-(--akros-checkout-body-leading)"
    >
      <div className="flex items-center gap-(--dimension-32) border-b border-(--akros-checkout-divider) pb-(--dimension-24) pl-(--dimension-16) max-sm:gap-(--dimension-16) max-sm:pl-0">
        <span className="shrink-0 text-(length:--akros-checkout-shipping-icon-size) text-(--akros-checkout-muted)">
          <Icon icon="token-icon-akros-checkout-shipping" size="current" />
        </span>
        <div className="grid min-w-0 flex-1 gap-(--dimension-12)">
          <p
            data-akros-free-shipping-text
            className="text-(length:--akros-checkout-body-size) text-(--akros-checkout-service-title-color)"
            aria-live="polite"
          >
            {remaining > 0
              ? `K dopravě zdarma chybí ještě ${formatCheckoutPrice(remaining)}`
              : "Dopravu máte zdarma"}
          </p>
          <progress
            aria-label="Doprava zdarma"
            max={demoFreeShippingThresholdMinor}
            value={Math.min(subtotal, demoFreeShippingThresholdMinor)}
            aria-valuetext={
              remaining > 0 ? `Chybí ${formatCheckoutPrice(remaining)}` : "Doprava zdarma"
            }
            className="block h-(--akros-checkout-progress-height) w-full max-w-(--akros-checkout-progress-width) appearance-none overflow-hidden rounded-(--akros-checkout-progress-radius) border-0 bg-(--akros-checkout-progress-track) [&::-webkit-progress-bar]:rounded-(--akros-checkout-progress-radius) [&::-webkit-progress-bar]:bg-(--akros-checkout-progress-track) [&::-webkit-progress-value]:rounded-(--akros-checkout-progress-radius) [&::-webkit-progress-value]:bg-(--color-button-bg-primary-base) [&::-moz-progress-bar]:rounded-(--akros-checkout-progress-radius) [&::-moz-progress-bar]:bg-(--color-button-bg-primary-base)"
          >
            {formatCheckoutPrice(subtotal)} z {formatCheckoutPrice(demoFreeShippingThresholdMinor)}
          </progress>
        </div>
      </div>
      <div data-akros-extended-return className="pl-(--dimension-16) max-sm:pl-0">
        <FormCheckbox
          id="checkout-extended-return"
          size="sm"
          checked={draft.extendedReturn ?? false}
          onCheckedChange={(extendedReturn) =>
            updateDraft((current) => ({ ...current, extendedReturn }))
          }
          aria-describedby="checkout-extended-return-description"
          className="[&_[data-part=label]]:min-w-0 [&_[data-part=label]]:flex-1 [&_[data-part=control]]:border-(length:--border-width-checkbox)"
          label={
            <span className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-(--dimension-32) @max-[40rem]/cart-services:grid-cols-[auto_minmax(0,1fr)] @max-[40rem]/cart-services:gap-(--dimension-16)">
              <span
                aria-hidden="true"
                className="text-(length:--akros-checkout-return-icon-size) text-(--akros-checkout-muted)"
              >
                <Icon icon="token-icon-akros-checkout-return" size="current" />
              </span>
              <span className="grid min-w-0 gap-(--dimension-8)">
                <span
                  data-akros-return-title
                  className="text-(length:--akros-checkout-body-size) text-(--akros-checkout-service-title-color)"
                >
                  Prodloužená doba vrácení
                </span>
                <span
                  id="checkout-extended-return-description"
                  className="text-(length:--akros-checkout-small-size) text-(--akros-checkout-muted)"
                >
                  Nestačí vám 30 dní na vrácení zboží? Dopřejte si 60 dnů na rozmyšlenou.
                </span>
              </span>
              <span
                data-akros-return-price
                className="pl-(--dimension-32) text-(length:--akros-checkout-body-size) whitespace-nowrap @max-[40rem]/cart-services:col-start-2 @max-[40rem]/cart-services:pl-0"
              >
                + {formatCheckoutPrice(demoExtendedReturn.priceMinor)}
              </span>
            </span>
          }
        />
      </div>
    </div>
  );
}
