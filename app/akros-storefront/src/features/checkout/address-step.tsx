"use client";
import NextLink from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { useCheckout } from "./checkout-provider";
import { AddressFields } from "./address-fields";
import { validateAddresses } from "@/mock-storefront/checkout";

export function AddressStep() {
  const { draft, updateDraft } = useCheckout();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [editing, setEditing] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? validateAddresses(draft) : {};
  const focusError = () =>
    requestAnimationFrame(() =>
      formRef.current
        ?.querySelector<HTMLElement>('input[aria-invalid="true"], button[aria-invalid="true"]')
        ?.focus(),
    );
  function saveBilling() {
    const errors = validateAddresses({ ...draft, differentDeliveryAddress: false });
    if (Object.keys(errors).length) {
      setAttempted(true);
      focusError();
      return;
    }
    setEditing(false);
  }
  return (
    <form
      data-akros-checkout-address
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        const invalid = validateAddresses(draft);
        if (Object.keys(invalid).length) {
          if (Object.keys(invalid).some((key) => !key.startsWith("delivery."))) setEditing(true);
          focusError();
          return;
        }
        router.push("/kosik/shrnuti");
      }}
    >
      <section
        className="grid gap-(--dimension-60) rounded-sm bg-(--color-base) p-(--akros-checkout-panel-padding)"
        aria-labelledby="address-title"
      >
        <div>
          <h1
            id="address-title"
            className="mb-6 text-(length:--akros-checkout-heading-size) leading-(--akros-checkout-heading-leading) font-medium"
          >
            Dodací údaje
          </h1>
          {editing ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormInput
                id="checkout-email"
                label="E-mail"
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
                label="Firma (volitelné)"
                autoComplete="organization"
                size="sm"
                value={draft.company}
                onChange={(event) =>
                  updateDraft((current) => ({ ...current, company: event.target.value }))
                }
              />
              <FormInput
                id="checkout-company-id"
                label="IČ (volitelné)"
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
                label="DIČ (volitelné)"
                size="sm"
                value={draft.vatId}
                onChange={(event) =>
                  updateDraft((current) => ({ ...current, vatId: event.target.value }))
                }
              />
            </div>
          ) : (
            <div className="text-sm leading-(--akros-checkout-body-leading)">
              <p>
                {draft.billing.firstName} {draft.billing.lastName}
              </p>
              <p>{draft.email}</p>
              {draft.company && <p>{draft.company}</p>}
              {draft.companyId && <p>IČ: {draft.companyId}</p>}
              {draft.vatId && <p>DIČ: {draft.vatId}</p>}
              <p>{draft.billing.phone}</p>
            </div>
          )}
        </div>
        <div className="grid gap-4">
          <h2 className="text-(length:--akros-checkout-choice-size) leading-(--akros-checkout-heading-leading) font-bold">
            Fakturační adresa
          </h2>
          {editing ? (
            <AddressFields
              address={draft.billing}
              prefix="billing"
              errors={errors}
              onChange={(billing) => updateDraft((current) => ({ ...current, billing }))}
            />
          ) : (
            <div className="text-sm leading-(--akros-checkout-body-leading)">
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
            data-akros-checkout-action
            className="w-fit min-w-40 leading-(--akros-checkout-heading-leading)"
            aria-label={editing ? "Uložit údaje" : "Změnit fakturační údaje"}
            onClick={() => (editing ? saveBilling() : setEditing(true))}
          >
            {editing ? "Uložit údaje" : "Změnit"}
          </Button>
        </div>
        <div className="grid gap-4">
          <h2 className="text-(length:--akros-checkout-choice-size) leading-(--akros-checkout-heading-leading) font-bold">
            Dodací adresa
          </h2>
          <FormCheckbox
            id="different-delivery-address"
            size="sm"
            label="Zboží chci doručit na jinou adresu než fakturační"
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
          as={NextLink}
          href="/kosik/doprava-platba"
          data-akros-checkout-action
          className="leading-(--akros-checkout-heading-leading)"
          variant="secondary"
          size="sm"
          uppercase
        >
          Zpět k dopravě a platbě
        </LinkButton>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          data-akros-checkout-action
          className="leading-(--akros-checkout-heading-leading)"
          uppercase
        >
          Souhrn objednávky
        </Button>
      </div>
    </form>
  );
}
