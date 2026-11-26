"use client";
import Image from "next/image";
import StoreLink from "@/components/store-link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useDictionary, useMoney, useStoreHref } from "@/ontos/market-context";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Icon } from "@techsio/ui-kit/atoms/icon";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { StatusText } from "@techsio/ui-kit/atoms/status-text";
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
      <div data-sf-checkout-methods className="sf-checkout-panel sf-checkout-section-stack">
        <section aria-labelledby="delivery-title">
          <h1 id="delivery-title" className="sf-checkout-section-heading">
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
                  <RadioGroup.Item key={method.id} value={method.id} data-sf-checkout-method>
                    <RadioGroup.ItemHiddenInput />
                    <RadioGroup.ItemControl />
                    <span data-sf-checkout-method-mark aria-hidden="true">
                      {method.id === "PPL" ? (
                        <Image alt="" src="/akros/footer/ppl.png" width={80} height={43} />
                      ) : (
                        <Icon icon="token-icon-sf-checkout-shipping" size="lg" />
                      )}
                    </span>
                    <RadioGroup.ItemContent data-sf-checkout-method-name>
                      <RadioGroup.ItemText>{method.title}</RadioGroup.ItemText>
                    </RadioGroup.ItemContent>
                    <span data-sf-checkout-method-price data-free={price === 0 || undefined}>
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
          {!methods.length && <output>{methodsError || copy.loading}</output>}
          <StatusText className="sf-checkout-section-note" size="sm">
            {copy.carrierNote}
          </StatusText>
        </section>
        <section aria-labelledby="payment-title">
          <h2 id="payment-title" className="sf-checkout-section-heading">
            {copy.paymentTitle}
          </h2>
          <div data-sf-checkout-payment-note>
            <strong>{copy.noOnlinePayment}</strong>
            <StatusText size="sm">{copy.paymentNote}</StatusText>
          </div>
        </section>
      </div>
      <div className="sf-checkout-actions">
        <LinkButton
          as={StoreLink}
          href="/kosik"
          variant="secondary"
          size="sm"
          data-sf-checkout-action
          className="sf-checkout-back"
          uppercase
        >
          {copy.back}
        </LinkButton>
        <div className="sf-checkout-next">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            data-sf-checkout-action
            uppercase
            disabled={blocked}
            aria-describedby={blocked ? "methods-blocked" : undefined}
          >
            {copy.next}
          </Button>
          {blocked && (
            <StatusText id="methods-blocked" size="sm">
              {quote?.blockedReason}
            </StatusText>
          )}
        </div>
      </div>
    </form>
  );
}
