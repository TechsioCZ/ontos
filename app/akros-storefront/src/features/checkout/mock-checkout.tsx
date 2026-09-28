"use client";

import Image from "next/image";
import NextLink from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { RadioGroup } from "@techsio/ui-kit/molecules/radio-group";

import { useCart } from "@/features/cart/cart-provider";
import { formatPrice } from "@/lib/format";
import { getCartSubtotal } from "@/mock-storefront/cart";
import {
  getProductById,
  getProductUnitPrice,
  getProductVariantById,
} from "@/mock-storefront/catalog";
import { mockDeliveryMethods, mockPaymentMethods } from "@/mock-storefront/fixtures/account";

function ShippingInformationStep() {
  return (
    <section className="akros-checkout-card" aria-labelledby="billing-heading">
      <h2 id="billing-heading">Fakturační údaje</h2>
      <div className="akros-form-grid">
        <FormInput
          autoComplete="name"
          defaultValue="Jan Novák"
          id="checkout-name"
          label="Jméno a příjmení"
          required
          size="sm"
        />
        <FormInput
          autoComplete="organization"
          defaultValue="Stavebniny s.r.o."
          id="checkout-company"
          label="Název firmy (volitelné)"
          size="sm"
        />
        <FormInput defaultValue="12345678" id="checkout-company-id" label="IČO" size="sm" />
        <FormInput defaultValue="CZ12345678" id="checkout-vat-id" label="DIČ" size="sm" />
        <FormInput
          autoComplete="street-address"
          defaultValue="Průmyslová 1420"
          id="checkout-address"
          label="Ulice a číslo popisné"
          required
          size="sm"
        />
        <FormInput
          autoComplete="address-level2"
          defaultValue="Praha"
          id="checkout-city"
          label="Město"
          required
          size="sm"
        />
        <FormInput
          autoComplete="postal-code"
          defaultValue="102 00"
          id="checkout-postcode"
          label="PSČ"
          required
          size="sm"
        />
        <FormInput
          autoComplete="country-name"
          defaultValue="Česká republika"
          id="checkout-country"
          label="Země"
          required
          size="sm"
        />
        <FormInput
          autoComplete="email"
          defaultValue="novak@stavebniny.cz"
          id="checkout-email"
          label="E-mail"
          required
          size="sm"
          type="email"
        />
        <FormInput
          autoComplete="tel"
          defaultValue="+420 777 123 456"
          id="checkout-phone"
          label="Telefonní číslo"
          required
          size="sm"
          type="tel"
        />
      </div>
      <FormCheckbox label="Doručit na jinou adresu než fakturační" size="sm" />
    </section>
  );
}

function DeliveryMethodStep({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <section className="akros-checkout-card" aria-labelledby="delivery-heading">
      <h2 id="delivery-heading">Způsob doručení</h2>
      <RadioGroup onValueChange={(next) => next && onChange(next)} value={value}>
        <RadioGroup.ItemGroup className="akros-option-list">
          {mockDeliveryMethods.map((method) => (
            <RadioGroup.Item className="akros-option-card" key={method.id} value={method.id}>
              <RadioGroup.ItemHiddenInput />
              <RadioGroup.ItemControl />
              <RadioGroup.ItemContent>
                <RadioGroup.ItemText>{method.title}</RadioGroup.ItemText>
                <RadioGroup.ItemDescription>{method.description}</RadioGroup.ItemDescription>
              </RadioGroup.ItemContent>
              <strong>{method.priceMinor === 0 ? "Zdarma" : formatPrice(method.priceMinor)}</strong>
            </RadioGroup.Item>
          ))}
        </RadioGroup.ItemGroup>
      </RadioGroup>
    </section>
  );
}

function PaymentMethodStep({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <section className="akros-checkout-card" aria-labelledby="payment-heading">
      <h2 id="payment-heading">Způsob platby</h2>
      <RadioGroup onValueChange={(next) => next && onChange(next)} value={value}>
        <RadioGroup.ItemGroup className="akros-option-list">
          {mockPaymentMethods.map((method) => (
            <RadioGroup.Item className="akros-option-card" key={method.id} value={method.id}>
              <RadioGroup.ItemHiddenInput />
              <RadioGroup.ItemControl />
              <RadioGroup.ItemContent>
                <RadioGroup.ItemText>{method.title}</RadioGroup.ItemText>
                <RadioGroup.ItemDescription>{method.description}</RadioGroup.ItemDescription>
              </RadioGroup.ItemContent>
            </RadioGroup.Item>
          ))}
        </RadioGroup.ItemGroup>
      </RadioGroup>
    </section>
  );
}

export function MockCheckout() {
  const router = useRouter();
  const { cart, dispatch, ready } = useCart();
  const [deliveryId, setDeliveryId] = useState("ppl");
  const [paymentId, setPaymentId] = useState("card");
  const rows = cart.lines.flatMap((line) => {
    const product = getProductById(line.productId);
    const variant = getProductVariantById(line.productId, line.variantId);
    return product ? [{ line, product, variant }] : [];
  });
  const subtotal = getCartSubtotal(cart, getProductUnitPrice);
  const delivery =
    mockDeliveryMethods.find((method) => method.id === deliveryId) ?? mockDeliveryMethods[0];
  const total = subtotal + delivery.priceMinor;

  if (!ready) return <p className="akros-empty-state">Načítám košík…</p>;
  if (rows.length === 0)
    return (
      <div className="akros-empty-state akros-empty-state--cart">
        <h1>Pokladna</h1>
        <p>Nejdříve přidejte alespoň jednu položku do košíku.</p>
        <NextLink href="/kategorie/nerezovy-spojovaci-material">Zpět do katalogu</NextLink>
      </div>
    );

  return (
    <form
      className="akros-checkout"
      onSubmit={(event) => {
        event.preventDefault();
        dispatch({ type: "clear" });
        router.push("/potvrzeni-objednavky");
      }}
    >
      <header className="akros-checkout-heading">
        <NextLink href="/kosik">← Zpět do košíku</NextLink>
        <ol>
          <li>1. Doručení</li>
          <li>2. Platba</li>
          <li>3. Shrnutí</li>
        </ol>
      </header>
      <div className="akros-checkout-layout">
        <div className="akros-checkout-steps">
          <ShippingInformationStep />
          <DeliveryMethodStep onChange={setDeliveryId} value={deliveryId} />
          <PaymentMethodStep onChange={setPaymentId} value={paymentId} />
        </div>
        <aside className="akros-checkout-summary" aria-labelledby="checkout-summary-title">
          <h2 id="checkout-summary-title">Objednané položky</h2>
          <div className="akros-checkout-items">
            {rows.map(({ line, product, variant }) => {
              const unitPrice = variant?.priceMinor ?? product.priceMinor;

              return (
                <article key={`${product.id}:${variant?.id ?? "base"}`}>
                  <Image alt={product.imageAlt} height={48} src={product.imageSrc} width={48} />
                  <div>
                    <strong>{product.name}</strong>
                    <small>
                      {variant && <>{variant.label} · </>}
                      Množství: {line.quantity} {product.unit}
                    </small>
                  </div>
                  <b>{formatPrice(unitPrice * line.quantity)}</b>
                </article>
              );
            })}
          </div>
          <dl>
            <div>
              <dt>Mezisoučet produktů</dt>
              <dd>{formatPrice(subtotal)}</dd>
            </div>
            <div>
              <dt>Zvolená doprava</dt>
              <dd>{formatPrice(delivery.priceMinor)}</dd>
            </div>
            <div>
              <dt>Celková cena s DPH</dt>
              <dd>{formatPrice(total)}</dd>
            </div>
          </dl>
          <p className="akros-checkout-payment">
            Platba: {mockPaymentMethods.find((method) => method.id === paymentId)?.title}
          </p>
          <Button block size="md" type="submit" variant="primary">
            Dokončit ukázkovou objednávku
          </Button>
          <small>Jde o lokální prototyp. Platba se neodesílá ani nezpracovává.</small>
        </aside>
      </div>
    </form>
  );
}
