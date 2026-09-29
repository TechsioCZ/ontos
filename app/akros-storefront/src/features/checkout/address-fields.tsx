"use client";
import Image from "next/image";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { PhoneInput } from "@techsio/ui-kit/molecules/phone-input";
import { CheckoutSelect } from "./checkout-select";
import type { CheckoutAddress, CheckoutErrors } from "@/mock-storefront/checkout";

const countries = [{ value: "CZ", label: "Česká republika" }];
const phoneCountries = [
  {
    value: "CZ" as const,
    label: "Česká republika",
    callingCode: "420",
    flag: <Image src="/akros/checkout/czechia.svg" width={40} height={40} alt="" />,
  },
];

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
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {(
        [
          ["firstName", "Jméno", "given-name"],
          ["lastName", "Příjmení", "family-name"],
          ["street", "Ulice, č.p.", "street-address"],
          ["city", "Město", "address-level2"],
          ["postalCode", "PSČ", "postal-code"],
        ] as const
      ).map(([key, label, autocomplete]) => (
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
      ))}
      <CheckoutSelect
        id={`${prefix}-country`}
        label="Země"
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
        <PhoneInput.Label>Telefon</PhoneInput.Label>
        <PhoneInput.Control>
          <PhoneInput.CountryPicker triggerProps={{ "aria-label": "Telefonní předvolba" }} />
          <PhoneInput.Input placeholder="Telefonní číslo" autoComplete={`${section} tel`} />
        </PhoneInput.Control>
        {errors[`${prefix}.phone`] && (
          <PhoneInput.StatusText status="error">{errors[`${prefix}.phone`]}</PhoneInput.StatusText>
        )}
      </PhoneInput>
    </div>
  );
}

export function AddressText({ address }: { address: CheckoutAddress }) {
  return (
    <address className="text-sm leading-relaxed not-italic">
      <p>
        {address.firstName} {address.lastName}
      </p>
      <p>{address.street}</p>
      <p>
        {address.postalCode} {address.city}
      </p>
      <p>Česká republika</p>
      <p>{address.phone}</p>
    </address>
  );
}
