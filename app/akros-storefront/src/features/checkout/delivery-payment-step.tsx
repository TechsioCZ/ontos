"use client";
import StoreLink from "@/components/store-link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { RadioGroup } from "@techsio/ui-kit/molecules/radio-group";
import { useCheckout } from "./checkout-provider";
import { selectDelivery, validateMethods } from "@/features/checkout/checkout-state";
import { formatCheckoutPrice } from "./checkout-format";
import { useCartQuote } from "@/ontos/cart-revalidation";

export function DeliveryPaymentStep() {
  const { draft, methods, methodsError, updateDraft } = useCheckout();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? validateMethods(draft, methods) : {};
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
        const invalid = validateMethods(draft, methods);
        if (Object.keys(invalid).length) {
          const selector = invalid.deliveryId ? 'input[name="delivery"]' : '[role="combobox"]';
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
        className="grid gap-(--dimension-60) rounded-sm bg-(--color-base) p-(--akros-checkout-panel-padding)"
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
                    <RadioGroup.ItemContent className="col-start-3">
                      <RadioGroup.ItemText>{method.title}</RadioGroup.ItemText>
                      <RadioGroup.ItemDescription>
                        Cena podle aktuálního ceníku OntOS
                      </RadioGroup.ItemDescription>
                    </RadioGroup.ItemContent>
                    <span
                      className={`col-start-4 row-start-1 whitespace-nowrap text-sm ${price === 0 ? "text-(--color-fg-status-success) uppercase" : "font-extrabold text-(--akros-checkout-muted)"}`}
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
          {!methods.length && (
            <p role="status">{methodsError || "Načítám aktuální dopravu z OntOS…"}</p>
          )}
          <p className="mt-4 text-sm">
            Rezervace dopravce, výdejní místa a termín doručení nejsou v OntOS dostupné. Volba
            dopravy se uloží do objednávky; automatickou expedici nezajišťuje.
          </p>
        </section>
        <section aria-labelledby="payment-title">
          <h2
            id="payment-title"
            className="mb-4 text-(length:--akros-checkout-payment-heading-size) leading-(--akros-checkout-heading-leading) font-medium"
          >
            Platba
          </h2>
          <div className="rounded-sm border border-(--color-border-primary) p-4">
            <p className="font-bold">Online platba není dostupná</p>
            <p className="mt-2 text-sm text-(--color-fg-secondary)">
              OntOS zde nemá platební metodu ani evidenci úhrady. Odesláním vznikne objednávka,
              nikoli úhrada.
            </p>
          </div>
        </section>
      </div>
      <div className="mt-6 flex flex-wrap justify-between gap-4">
        <LinkButton
          as={StoreLink}
          href="/kosik"
          variant="secondary"
          size="sm"
          data-akros-checkout-action
          className="leading-(--akros-checkout-heading-leading)"
          uppercase
        >
          Vrátit se o krok zpět
        </LinkButton>
        <div className="grid gap-2">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            data-akros-checkout-action
            className="leading-(--akros-checkout-heading-leading)"
            uppercase
            disabled={blocked}
            aria-describedby={blocked ? "methods-blocked" : undefined}
          >
            Dodací údaje
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
