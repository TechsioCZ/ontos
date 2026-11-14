"use client";
import StoreLink from "@/components/store-link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useDictionary, useMoney, useStoreHref } from "@/ontos/market-context";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { RadioGroup } from "@techsio/ui-kit/molecules/radio-group";
import { RadioGroupLabel } from "@/components/form-controls";
import { useCheckout } from "./checkout-provider";
import { selectDelivery, validateMethods } from "@/features/checkout/checkout-state";
import { formatCheckoutPrice } from "./checkout-format";
import { useCartQuote } from "@/ontos/cart-revalidation";

export function DeliveryPaymentStep() {
  const money = useMoney();
  const { checkout } = useDictionary();
  const copy = checkout.delivery;
  const { draft, methods, methodsError, updateDraft } = useCheckout();
  const router = useRouter();
  const storeHref = useStoreHref();
  const formRef = useRef<HTMLFormElement>(null);
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? validateMethods(draft, methods, checkout.validation) : {};
  const quote = useCartQuote();
  const blocked = !methods.length || (quote ? !quote.canContinue : true);
  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked) return;
        setAttempted(true);
        const invalid = validateMethods(draft, methods, checkout.validation);
        if (Object.keys(invalid).length) {
          const selector = invalid.deliveryId ? 'input[name="delivery"]' : '[role="combobox"]';
          requestAnimationFrame(() =>
            formRef.current?.querySelector<HTMLElement>(selector)?.focus(),
          );
          return;
        }
        router.push(storeHref("/kosik/dodaci-udaje"));
      }}
    >
      <div
        data-sf-checkout-methods
        className="grid grid-cols-1 gap-(--dimension-60) rounded-sm bg-(--color-base) p-(--sf-checkout-panel-padding)"
      >
        <section aria-labelledby="delivery-title">
          <h1
            id="delivery-title"
            className="mb-4 text-(length:--sf-checkout-heading-size) leading-(--sf-checkout-heading-leading) font-medium"
          >
            {copy.title}
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
            <RadioGroupLabel className="sr-only">{copy.methodLabel}</RadioGroupLabel>
            <RadioGroup.ItemGroup>
              {methods.map((method) => {
                const price = method.priceMinor;
                return (
                  <RadioGroup.Item
                    key={method.id}
                    value={method.id}
                    className="min-h-20 items-center border-b border-(--color-border-primary) py-3 last:border-b-0"
                  >
                    <RadioGroup.ItemHiddenInput />
                    <RadioGroup.ItemControl />
                    <RadioGroup.ItemContent className="col-start-3 max-[24rem]:col-span-2">
                      <RadioGroup.ItemText>{method.title}</RadioGroup.ItemText>
                      <RadioGroup.ItemDescription>{copy.priceNote}</RadioGroup.ItemDescription>
                    </RadioGroup.ItemContent>
                    <span
                      className={`col-start-4 row-start-1 whitespace-nowrap text-sm max-[24rem]:col-span-2 max-[24rem]:col-start-3 max-[24rem]:row-start-2 ${price === 0 ? "text-(--color-fg-status-success) uppercase" : "font-extrabold text-(--sf-checkout-muted)"}`}
                    >
                      {price === 0 ? copy.free : formatCheckoutPrice(price, money)}
                    </span>
                  </RadioGroup.Item>
                );
              })}
            </RadioGroup.ItemGroup>
            {errors.deliveryId && (
              <RadioGroup.StatusText status="error">{errors.deliveryId}</RadioGroup.StatusText>
            )}
          </RadioGroup>
          {!methods.length && <p role="status">{methodsError || copy.loading}</p>}
          <p className="mt-4 text-sm">{copy.carrierNote}</p>
        </section>
        <section aria-labelledby="payment-title">
          <h2
            id="payment-title"
            className="mb-4 text-(length:--sf-checkout-payment-heading-size) leading-(--sf-checkout-heading-leading) font-medium"
          >
            {copy.paymentTitle}
          </h2>
          <div className="rounded-sm border border-(--color-border-primary) p-4">
            <p className="font-bold">{copy.noOnlinePayment}</p>
            <p className="mt-2 text-sm text-(--color-fg-secondary)">{copy.paymentNote}</p>
          </div>
        </section>
      </div>
      <div className="mt-6 flex flex-wrap justify-between gap-4">
        <LinkButton
          as={StoreLink}
          href="/kosik"
          variant="secondary"
          size="sm"
          data-sf-checkout-action
          className="leading-(--sf-checkout-heading-leading)"
          uppercase
        >
          {copy.back}
        </LinkButton>
        <div className="grid gap-2">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            data-sf-checkout-action
            className="leading-(--sf-checkout-heading-leading)"
            uppercase
            disabled={blocked}
            aria-describedby={blocked ? "methods-blocked" : undefined}
          >
            {copy.next}
          </Button>
          {blocked && (
            <p id="methods-blocked" className="max-w-xs text-xs text-(--color-fg-secondary)">
              {quote?.blockedReason}
            </p>
          )}
        </div>
      </div>
    </form>
  );
}
