"use client";
import StoreLink from "@/components/store-link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useDictionary, useStoreHref } from "@/ontos/market-context";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { FormInput } from "@/components/form-controls";
import { useCheckout } from "./checkout-provider";
import { AddressFields } from "./address-fields";
import { validateAddresses } from "@/features/checkout/checkout-state";
import { useCartQuote } from "@/ontos/cart-revalidation";

export function AddressStep() {
  const { draft, updateDraft, accountEmail } = useCheckout();
  const router = useRouter();
  const storeHref = useStoreHref();
  const { checkout } = useDictionary();
  const copy = checkout.address;
  const formRef = useRef<HTMLFormElement>(null);
  const [editing, setEditing] = useState(true);
  const [attempted, setAttempted] = useState(false);
  const quote = useCartQuote();
  const blocked = quote ? !quote.canContinue : false;
  const errors = attempted ? validateAddresses(draft, checkout.validation) : {};
  const focusError = () =>
    requestAnimationFrame(() =>
      formRef.current
        ?.querySelector<HTMLElement>('input[aria-invalid="true"], button[aria-invalid="true"]')
        ?.focus(),
    );
  function saveBilling() {
    const errors = validateAddresses(
      { ...draft, differentDeliveryAddress: false },
      checkout.validation,
    );
    if (Object.keys(errors).length) {
      setAttempted(true);
      focusError();
      return;
    }
    setEditing(false);
  }
  return (
    <form
      data-sf-checkout-address
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked) return;
        setAttempted(true);
        const invalid = validateAddresses(draft, checkout.validation);
        if (Object.keys(invalid).length) {
          if (Object.keys(invalid).some((key) => !key.startsWith("delivery."))) setEditing(true);
          focusError();
          return;
        }
        router.push(storeHref("/kosik/shrnuti"));
      }}
    >
      <section
        className="grid gap-(--dimension-60) rounded-sm bg-(--color-base) p-(--sf-checkout-panel-padding)"
        aria-labelledby="address-title"
      >
        <div>
          <h1
            id="address-title"
            className="mb-6 text-(length:--sf-checkout-heading-size) leading-(--sf-checkout-heading-leading) font-medium"
          >
            {checkout.steps.address}
          </h1>
          <p className="mb-4 rounded-sm border border-(--color-border-primary) p-4 text-sm">
            {accountEmail ? copy.accountIntro : copy.guestIntro}
          </p>
          {editing ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormInput
                id="checkout-email"
                label={checkout.email}
                type="email"
                autoComplete="email"
                size="sm"
                required
                value={draft.email}
                onChange={(event) =>
                  updateDraft((current) => ({ ...current, email: event.target.value }))
                }
                validateStatus={errors.email ? "error" : "default"}
                helpText={errors.email}
              />
              <FormInput
                id="checkout-company"
                label={copy.company}
                autoComplete="organization"
                size="sm"
                value={draft.company}
                onChange={(event) =>
                  updateDraft((current) => ({ ...current, company: event.target.value }))
                }
              />
              <FormInput
                id="checkout-company-id"
                label={copy.companyId}
                size="sm"
                value={draft.companyId}
                onChange={(event) =>
                  updateDraft((current) => ({ ...current, companyId: event.target.value }))
                }
                validateStatus={errors.companyId ? "error" : "default"}
                helpText={errors.companyId}
              />
              <FormInput
                id="checkout-vat-id"
                label={copy.vatId}
                size="sm"
                value={draft.vatId}
                onChange={(event) =>
                  updateDraft((current) => ({ ...current, vatId: event.target.value }))
                }
              />
            </div>
          ) : (
            <div className="text-sm leading-(--sf-checkout-body-leading)">
              <p>
                {draft.billing.firstName} {draft.billing.lastName}
              </p>
              <p>{draft.email}</p>
              {draft.company && <p>{draft.company}</p>}
              {draft.companyId && <p>{copy.companyIdValue(draft.companyId)}</p>}
              {draft.vatId && <p>{copy.vatIdValue(draft.vatId)}</p>}
              <p>{draft.billing.phone}</p>
            </div>
          )}
        </div>
        <div className="grid gap-4">
          <h2 className="text-(length:--sf-checkout-choice-size) leading-(--sf-checkout-heading-leading) font-bold">
            {copy.billingAddress}
          </h2>
          {editing ? (
            <AddressFields
              address={draft.billing}
              prefix="billing"
              errors={errors}
              onChange={(billing) => updateDraft((current) => ({ ...current, billing }))}
            />
          ) : (
            <div className="text-sm leading-(--sf-checkout-body-leading)">
              <p>{draft.billing.street}</p>
              <p>{draft.billing.city}</p>
              <p>{draft.billing.postalCode}</p>
            </div>
          )}
          <Button
            type="button"
            size="sm"
            theme="outlined"
            variant="secondary"
            uppercase
            data-sf-checkout-action
            className="w-fit min-w-40 leading-(--sf-checkout-heading-leading)"
            aria-label={editing ? copy.save : copy.editBilling}
            onClick={() => (editing ? saveBilling() : setEditing(true))}
          >
            {editing ? copy.save : copy.edit}
          </Button>
        </div>
        <div className="grid gap-4">
          <h2 className="text-(length:--sf-checkout-choice-size) leading-(--sf-checkout-heading-leading) font-bold">
            {copy.deliveryAddress}
          </h2>
          <FormCheckbox
            id="different-delivery-address"
            size="sm"
            label={copy.differentDelivery}
            checked={draft.differentDeliveryAddress}
            onCheckedChange={(differentDeliveryAddress) =>
              updateDraft((current) => ({ ...current, differentDeliveryAddress }))
            }
          />
          {draft.differentDeliveryAddress && (
            <AddressFields
              address={draft.delivery}
              prefix="delivery"
              errors={errors}
              onChange={(delivery) => updateDraft((current) => ({ ...current, delivery }))}
            />
          )}
        </div>
      </section>
      <div className="mt-6 flex flex-wrap justify-between gap-4">
        <LinkButton
          as={StoreLink}
          href="/kosik/doprava-platba"
          data-sf-checkout-action
          className="leading-(--sf-checkout-heading-leading)"
          variant="secondary"
          size="sm"
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
            aria-describedby={blocked ? "address-blocked" : undefined}
          >
            {copy.next}
          </Button>
          {blocked && (
            <p id="address-blocked" className="max-w-xs text-xs text-(--color-fg-secondary)">
              {quote?.blockedReason}
            </p>
          )}
        </div>
      </div>
    </form>
  );
}
