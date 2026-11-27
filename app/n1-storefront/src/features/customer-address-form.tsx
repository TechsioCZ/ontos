"use client";

import { Predicate } from "effect";
import type { SubmitEvent } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Select } from "@techsio/ui-kit/molecules/select";
import type { Dictionary } from "@/i18n";
import { countryName } from "@/i18n/country-name";
import type { CustomerAddress, CustomerAddressCommand } from "@/ontos/customer-addresses";
import { FormInput } from "./form-controls";

type PostalCommand = Extract<CustomerAddressCommand, { operation: "add" | "update" }>;
interface OptionalPostalFields {
  addressLine2?: string;
  region?: string;
}

// ISO 3166-1 alpha-2. The address book accepts addresses outside the current delivery market.
const postalCountryCodes = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ " +
  "BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
  "DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
  "HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY " +
  "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA " +
  "RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
  "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ " +
  "VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

export const CustomerAddressForm = ({
  address,
  dictionary: d,
  disabled,
  error,
  locale,
  onCancel,
  onSubmit,
  pending,
}: {
  address: CustomerAddress | undefined;
  dictionary: Dictionary;
  disabled: boolean;
  error: string | null;
  locale: string;
  onCancel: () => void;
  onSubmit: (command: PostalCommand) => void;
  pending: boolean;
}) => {
  const postal = address?.location.state === "available" ? address.location.address : undefined;
  const labels = d.accountPage.addressEditor;
  const selectedCountry = postal?.countryCode ?? "CZ";
  const countries = [...new Set([...postalCountryCodes, selectedCountry])]
    .map((value) => ({ label: countryName(value, locale), value }))
    .toSorted((a, b) => a.label.localeCompare(b.label, locale));
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
      <fieldset className="grid min-w-0 grid-cols-2 items-end gap-3" disabled={disabled || pending}>
        <div className="col-span-2">
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
        <div className="col-span-2">
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
        <Select
          className="min-w-0"
          defaultValue={[selectedCountry]}
          disabled={disabled || pending}
          items={countries}
          name="countryCode"
          required
        >
          <Select.Label>{labels.country}</Select.Label>
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
        <FormInput
          autoComplete="address-level1"
          defaultValue={postal?.region}
          label={labels.region}
          maxLength={300}
          name="region"
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
      </fieldset>
      {error !== null && <output className="text-fg-secondary">{error}</output>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={pending} onClick={onCancel} size="sm" type="button" severity="secondary">
          {labels.cancel}
        </Button>
        <Button
          disabled={disabled || pending}
          isLoading={pending}
          loadingText={d.accountPage.saving}
          size="sm"
          type="submit"
          severity="primary"
        >
          {address === undefined ? labels.create : d.accountPage.save}
        </Button>
      </div>
    </form>
  );
};
