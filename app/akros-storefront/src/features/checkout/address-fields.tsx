"use client";
import Image from "next/image";
import { FormInput, PhoneInputLabel } from "@/components/form-controls";
import { PhoneInput } from "@techsio/ui-kit/molecules/phone-input";
import { CheckoutSelect } from "./checkout-select";
import type { CheckoutAddress, CheckoutErrors } from "@/features/checkout/checkout-state";
import { AddressAutocomplete } from "./address-autocomplete";
import { useDictionary } from "@/ontos/market-context";

const czechiaFlag = <Image src="/storefront/checkout/czechia.svg" width={40} height={40} alt="" />;

export function AddressFields({
  address,
  prefix,
  onChange,
  errors,
}: {
  address: CheckoutAddress;
  prefix: "billing" | "delivery";
  onChange: (address: CheckoutAddress) => void;
  errors: CheckoutErrors;
}) {
  const section = prefix === "billing" ? "billing" : "shipping";
  const fields = useDictionary().checkout.fields;
  const countries = [{ value: "CZ", label: fields.czechia }];
  const phoneCountries = [
    { value: "CZ" as const, label: fields.czechia, callingCode: "420", flag: czechiaFlag },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {(
        [
          ["firstName", fields.firstName, "given-name"],
          ["lastName", fields.lastName, "family-name"],
          ["street", fields.street, "street-address"],
          ["city", fields.city, "address-level2"],
          ["postalCode", fields.postalCode, "postal-code"],
        ] as const
      ).map(([key, label, autocomplete]) =>
        key === "street" ? (
          <AddressAutocomplete
            key={key}
            id={`${prefix}-${key}`}
            label={label}
            value={address.street}
            country={address.country}
            error={errors[`${prefix}.${key}`]}
            onInput={(street) => onChange({ ...address, street })}
            onSelect={(parts) => onChange({ ...address, ...parts })}
          />
        ) : (
          <FormInput
            key={key}
            id={`${prefix}-${key}`}
            label={label}
            autoComplete={`${section} ${autocomplete}`}
            size="sm"
            required
            value={address[key]}
            onChange={(event) => onChange({ ...address, [key]: event.target.value })}
            validateStatus={errors[`${prefix}.${key}`] ? "error" : "default"}
            helpText={errors[`${prefix}.${key}`]}
          />
        ),
      )}
      <CheckoutSelect
        id={`${prefix}-country`}
        label={fields.country}
        value={address.country}
        items={countries}
        onChange={(country) => onChange({ ...address, country })}
        error={errors[`${prefix}.country`]}
      />
      <PhoneInput
        id={`${prefix}-phone`}
        countries={phoneCountries}
        defaultCountry="CZ"
        value={address.phone}
        onValueChange={({ value }) => onChange({ ...address, phone: value })}
        size="sm"
        required
        nativeValidation={false}
        validateStatus={errors[`${prefix}.phone`] ? "error" : "default"}
      >
        <PhoneInputLabel>{fields.phone}</PhoneInputLabel>
        <PhoneInput.Control>
          <PhoneInput.CountryPicker triggerProps={{ "aria-label": fields.phonePrefix }} />
          <PhoneInput.Input placeholder={fields.phonePlaceholder} autoComplete={`${section} tel`} />
        </PhoneInput.Control>
        {errors[`${prefix}.phone`] && (
          <PhoneInput.StatusText status="error">{errors[`${prefix}.phone`]}</PhoneInput.StatusText>
        )}
      </PhoneInput>
    </div>
  );
}

export function AddressText({ address }: { address: CheckoutAddress }) {
  const fields = useDictionary().checkout.fields;
  return (
    <address className="text-sm leading-(--sf-checkout-body-leading) not-italic">
      <p>
        {address.firstName} {address.lastName}
      </p>
      <p>{address.street}</p>
      <p>
        {address.postalCode} {address.city}
      </p>
      <p>{fields.czechia}</p>
      <p>{address.phone}</p>
    </address>
  );
}
