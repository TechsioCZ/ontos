"use client";

import { useId, useState } from "react";
import { StatusText } from "@techsio/ui-kit/atoms/status-text";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { Select } from "@techsio/ui-kit/molecules/select";
import type { Dictionary } from "@/i18n";
import { checkoutFieldAttributes, checkoutFieldError } from "./checkout-field-validation";

type Field = keyof typeof checkoutFieldAttributes;

const countryNames = {
  cs: new Intl.DisplayNames(["cs"], { type: "region" }),
  en: new Intl.DisplayNames(["en"], { type: "region" }),
};
/** Guest fields supported by the native order; three optional Figma fields are deliberately omitted. */
export const CheckoutFields = ({
  countryCodes,
  dictionary: d,
  disabled,
  locale,
  onEdit,
}: {
  countryCodes: readonly string[];
  dictionary: Dictionary;
  disabled: boolean;
  locale: string;
  onEdit: () => void;
}) => {
  const id = useId();
  const [errors, setErrors] = useState<Partial<Record<Field, string | null>>>({});
  const countries = countryCodes.map((value) => ({
    label: countryNames[locale === "en" ? "en" : "cs"].of(value) ?? value,
    value,
  }));
  const input = (field: Field) => {
    const error = errors[field] ?? undefined;
    const errorId = `${id}-${field}-error`;
    // The dotted-domain constraint matches the existing public checkout contact schema.
    const pattern = field === "email" ? String.raw`[^\s@]+@[^\s@]+\.[^\s@]+` : String.raw`.*\S.*`;
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <FormInput
          {...checkoutFieldAttributes[field]}
          aria-describedby={error === undefined ? undefined : errorId}
          disabled={disabled}
          id={`${id}-${field}`}
          label={d.checkout[field]}
          name={field}
          onBlur={(event) => {
            const message = checkoutFieldError(field, event.currentTarget.validity, d);
            setErrors((previous) => ({ ...previous, [field]: message }));
          }}
          onChange={() => {
            setErrors((previous) => ({ ...previous, [field]: null }));
            onEdit();
          }}
          onInvalid={(event) => {
            const message = checkoutFieldError(field, event.currentTarget.validity, d);
            setErrors((previous) => ({ ...previous, [field]: message }));
          }}
          pattern={field === "phone" ? undefined : pattern}
          size="md"
          validateStatus={error === undefined ? "default" : "error"}
        />
        {error === undefined ? null : (
          <StatusText id={errorId} showIcon size="sm" status="error">
            {error}
          </StatusText>
        )}
      </div>
    );
  };
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-xs border border-border-secondary bg-fill-surface p-4">
      <h2 className="text-lg font-semibold">{d.checkout.address}</h2>
      <div className="grid min-w-0 grid-cols-2 gap-3">
        <div className="min-w-0">{input("firstName")}</div>
        <div className="min-w-0">{input("lastName")}</div>
      </div>
      {input("street")}
      <div className="grid min-w-0 grid-cols-2 gap-3">
        <div className="min-w-0">{input("city")}</div>
        <div className="min-w-0">
          <Select
            defaultValue={countryCodes.length === 1 ? [countryCodes[0] ?? ""] : []}
            disabled={disabled}
            id={`${id}-country`}
            items={countries}
            name="country"
            onValueChange={() => onEdit()}
            required
            size="lg"
          >
            <Select.Label>{d.checkout.country}</Select.Label>
            <Select.Control>
              <Select.Trigger>
                <Select.ValueText placeholder={d.checkout.countryPlaceholder} />
              </Select.Trigger>
            </Select.Control>
            <Select.Positioner>
              <Select.Content>
                {countries.map((item) => (
                  <Select.Item item={item} key={item.value}>
                    <Select.ItemText />
                    <Select.ItemIndicator />
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Select>
        </div>
      </div>
      {input("postalCode")}
      {input("phone")}
      {input("email")}
      <p className="text-sm text-fg-secondary">{d.checkout.guest}</p>
    </section>
  );
};
