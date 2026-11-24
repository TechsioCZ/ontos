"use client";

import { Predicate } from "effect";
import type { SubmitEvent } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import type { Dictionary } from "@/i18n";
import type { CustomerAddress, CustomerAddressCommand } from "@/ontos/customer-addresses";
import { FormInput } from "./form-controls";

type PostalCommand = Extract<CustomerAddressCommand, { operation: "add" | "update" }>;
interface OptionalPostalFields {
  addressLine2?: string;
  region?: string;
}

export const CustomerAddressForm = ({
  address,
  dictionary: d,
  disabled,
  error,
  onCancel,
  onSubmit,
  pending,
}: {
  address: CustomerAddress | undefined;
  dictionary: Dictionary;
  disabled: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (command: PostalCommand) => void;
  pending: boolean;
}) => {
  const postal = address?.location.state === "available" ? address.location.address : undefined;
  const labels = d.accountPage.addressEditor;
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const value = (field: string) => {
      const entry = values.get(field);
      return Predicate.isString(entry) ? entry.trim() : "";
    };
    const addressLine2 = value("addressLine2");
    const region = value("region");
    const optional: OptionalPostalFields = {};
    if (addressLine2 !== "") {
      optional.addressLine2 = addressLine2;
    }
    if (region !== "") {
      optional.region = region;
    }
    const fields = {
      operationId: crypto.randomUUID(),
      postalAddress: {
        addressLine1: value("addressLine1"),
        ...optional,
        city: value("city"),
        countryCode: value("countryCode").toUpperCase(),
        postalCode: value("postalCode"),
      },
      purposes: address?.purposes ?? (["BILLING", "DELIVERY"] as const),
    };
    onSubmit(
      address === undefined
        ? { ...fields, operation: "add" }
        : { ...fields, addressId: address.id, operation: "update", revision: address.revision },
    );
  };
  return (
    <form
      className="grid w-full gap-3 border border-border-primary bg-fill-surface p-4"
      onSubmit={submit}
    >
      <h3 className="text-md font-semibold">{address === undefined ? labels.add : labels.edit}</h3>
      <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2" disabled={disabled || pending}>
        <div className="sm:col-span-2">
          <FormInput
            autoComplete="address-line1"
            defaultValue={postal?.addressLine1}
            label={d.checkout.street}
            maxLength={300}
            name="addressLine1"
            pattern={String.raw`.*\S.*`}
            required
          />
        </div>
        <div className="sm:col-span-2">
          <FormInput
            autoComplete="address-line2"
            defaultValue={postal?.addressLine2}
            label={labels.addressLine2}
            maxLength={300}
            name="addressLine2"
          />
        </div>
        <FormInput
          autoComplete="address-level2"
          defaultValue={postal?.city}
          label={d.checkout.city}
          maxLength={300}
          name="city"
          pattern={String.raw`.*\S.*`}
          required
        />
        <FormInput
          autoComplete="postal-code"
          defaultValue={postal?.postalCode}
          label={d.checkout.postalCode}
          maxLength={300}
          name="postalCode"
          pattern={String.raw`.*\S.*`}
          required
        />
        <FormInput
          autoComplete="address-level1"
          defaultValue={postal?.region}
          label={labels.region}
          maxLength={300}
          name="region"
        />
        <FormInput
          autoComplete="country"
          defaultValue={postal?.countryCode ?? "CZ"}
          label={labels.countryCode}
          maxLength={2}
          name="countryCode"
          pattern="[A-Za-z]{2}"
          required
        />
      </fieldset>
      {error !== null && <output className="text-fg-secondary">{error}</output>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={onCancel} size="sm" type="button" variant="secondary">
          {labels.cancel}
        </Button>
        <Button
          disabled={disabled || pending}
          isLoading={pending}
          loadingText={d.accountPage.saving}
          size="sm"
          type="submit"
          variant="primary"
        >
          {d.accountPage.save}
        </Button>
      </div>
    </form>
  );
};
