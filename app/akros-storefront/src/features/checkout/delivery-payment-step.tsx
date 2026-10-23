"use client";
import Image from "next/image";
import NextLink from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { RadioGroup } from "@techsio/ui-kit/molecules/radio-group";
import { useCheckout } from "./checkout-provider";
import { useCart } from "@/features/cart/cart-provider";
import { CheckoutSelect } from "./checkout-select";
import {
  getDelivery,
  getCheckoutTotals,
  selectDelivery,
  validateMethods,
} from "@/mock-storefront/checkout";
import {
  checkoutDeliveryMethods,
  checkoutPaymentMethods,
  checkoutPickupPoints,
} from "@/mock-storefront/fixtures/checkout";
import { formatCheckoutPrice } from "./checkout-format";

export function DeliveryPaymentStep() {
  const { draft, updateDraft } = useCheckout();
  const { cart } = useCart();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? validateMethods(draft) : {};
  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        const invalid = validateMethods(draft);
        if (Object.keys(invalid).length) {
          const selector = invalid.deliveryId
            ? 'input[name="delivery"]'
            : invalid.pickupPointId
              ? '[role="combobox"]'
              : 'input[name="payment"]';
          requestAnimationFrame(() =>
            formRef.current?.querySelector<HTMLElement>(selector)?.focus(),
          );
          return;
        }
        router.push("/kosik/dodaci-udaje");
      }}
    >
      <div
        data-akros-checkout-methods
        className="grid grid-cols-1 gap-(--dimension-60) rounded-sm bg-(--color-base) p-(--akros-checkout-panel-padding)"
      >
        <section aria-labelledby="delivery-title">
          <h1
            id="delivery-title"
            className="mb-4 text-(length:--akros-checkout-heading-size) leading-(--akros-checkout-heading-leading) font-medium"
          >
            Doprava
          </h1>
          <RadioGroup
            id="checkout-delivery"
            name="delivery"
            size="sm"
            value={draft.deliveryId}
            required
            validateStatus={errors.deliveryId ? "error" : "default"}
            onValueChange={(id) => {
              if (id) updateDraft((current) => selectDelivery(current, id));
            }}
          >
            <RadioGroup.Label className="sr-only">Způsob dopravy</RadioGroup.Label>
            <RadioGroup.ItemGroup>
              {checkoutDeliveryMethods.map((method) => {
                const price =
                  getCheckoutTotals(cart, { ...draft, deliveryId: method.id }).shipping ?? 0;
                return (
                  <RadioGroup.Item
                    key={method.id}
                    value={method.id}
                    className="min-h-20 items-center border-b border-(--color-border-primary) py-3 last:border-b-0"
                  >
                    <RadioGroup.ItemHiddenInput />
                    <RadioGroup.ItemControl />
                    <span className="col-start-2 row-start-1">
                      <Image
                        alt=""
                        src={method.logo}
                        width={140}
                        height={63}
                        className={`h-9 w-20 max-sm:h-6 max-sm:w-14 ${method.id === "osobni" ? "object-contain" : "object-cover"}`}
                      />
                    </span>
                    <RadioGroup.ItemContent className="col-start-3 max-[24rem]:col-span-2">
                      <RadioGroup.ItemText>{method.title}</RadioGroup.ItemText>
                      <RadioGroup.ItemDescription>{method.description}</RadioGroup.ItemDescription>
                    </RadioGroup.ItemContent>
                    <span
                      className={`col-start-4 row-start-1 whitespace-nowrap text-sm max-[24rem]:col-span-2 max-[24rem]:col-start-3 max-[24rem]:row-start-2 ${price === 0 ? "text-(--color-fg-status-success) uppercase" : "font-extrabold text-(--akros-checkout-muted)"}`}
                    >
                      {price === 0 ? "Zdarma" : formatCheckoutPrice(price)}
                    </span>
                  </RadioGroup.Item>
                );
              })}
            </RadioGroup.ItemGroup>
            {errors.deliveryId && (
              <RadioGroup.StatusText status="error">{errors.deliveryId}</RadioGroup.StatusText>
            )}
          </RadioGroup>
          {getDelivery(draft)?.pickup && (
            <div className="mt-4">
              <CheckoutSelect
                id="checkout-pickup"
                label="Výdejní místo (ukázková data)"
                value={draft.pickupPointId}
                onChange={(pickupPointId) =>
                  updateDraft((current) => ({ ...current, pickupPointId }))
                }
                error={errors.pickupPointId}
                items={checkoutPickupPoints
                  .filter((point) => point.deliveryId === draft.deliveryId)
                  .map((point) => ({ value: point.id, label: point.label }))}
              />
            </div>
          )}
        </section>
        <section aria-labelledby="payment-title">
          <h2
            id="payment-title"
            className="mb-4 text-(length:--akros-checkout-payment-heading-size) leading-(--akros-checkout-heading-leading) font-medium"
          >
            Platba
          </h2>
          <RadioGroup
            id="checkout-payment"
            name="payment"
            size="sm"
            value={draft.paymentId}
            required
            validateStatus={errors.paymentId ? "error" : "default"}
            onValueChange={(paymentId) => {
              if (paymentId) updateDraft((current) => ({ ...current, paymentId }));
            }}
          >
            <RadioGroup.Label className="sr-only">Způsob platby</RadioGroup.Label>
            <RadioGroup.ItemGroup>
              {checkoutPaymentMethods.map((method) => (
                <RadioGroup.Item
                  key={method.id}
                  value={method.id}
                  disabled={method.pickupOnly && draft.deliveryId !== "osobni"}
                  className="min-h-16 items-center border-b border-(--color-border-primary) py-3 last:border-b-0 data-disabled:opacity-50"
                >
                  <RadioGroup.ItemHiddenInput />
                  <RadioGroup.ItemControl />
                  <span className="col-start-2 row-start-1">
                    {method.logo && (
                      <Image
                        alt=""
                        src={method.logo}
                        width={140}
                        height={63}
                        className="h-9 w-20 object-cover max-sm:h-6 max-sm:w-14"
                      />
                    )}
                  </span>
                  <RadioGroup.ItemContent className="col-start-3 max-[24rem]:col-span-2">
                    <RadioGroup.ItemText>{method.title}</RadioGroup.ItemText>
                    {method.pickupOnly && draft.deliveryId !== "osobni" && (
                      <RadioGroup.ItemDescription>
                        Pouze s osobním odběrem
                      </RadioGroup.ItemDescription>
                    )}
                  </RadioGroup.ItemContent>
                  <span className="col-start-4 row-start-1 text-sm text-(--color-fg-status-success) uppercase max-[24rem]:col-span-2 max-[24rem]:col-start-3 max-[24rem]:row-start-2">
                    Zdarma
                  </span>
                </RadioGroup.Item>
              ))}
            </RadioGroup.ItemGroup>
            {errors.paymentId && (
              <RadioGroup.StatusText status="error">{errors.paymentId}</RadioGroup.StatusText>
            )}
          </RadioGroup>
        </section>
        <p className="text-xs text-(--color-fg-secondary)">
          Ukázkové metody pro doručení v ČR. Nejde o ověření dostupnosti přepravce ani skutečnou
          platbu.
        </p>
      </div>
      <div className="mt-6 flex flex-wrap justify-between gap-4">
        <LinkButton
          as={NextLink}
          href="/kosik"
          variant="secondary"
          size="sm"
          data-akros-checkout-action
          className="leading-(--akros-checkout-heading-leading)"
          uppercase
        >
          Vrátit se o krok zpět
        </LinkButton>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          data-akros-checkout-action
          className="leading-(--akros-checkout-heading-leading)"
          uppercase
        >
          Dodací údaje
        </Button>
      </div>
    </form>
  );
}
