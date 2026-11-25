import { expect, it } from "@rstest/core";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomerAddressForm } from "../src/features/customer-address-form";
import { CustomerAddressesList } from "../src/features/customer-addresses-panel";
import { customerAddressesForIdentity } from "../src/ontos/customer-addresses-client";
import type {
  CustomerAddressIdentity,
  CustomerAddressesSnapshot,
} from "../src/ontos/customer-addresses-client";
import { getDictionary } from "../src/i18n";

const identity: CustomerAddressIdentity = {
  email: "owner@example.test",
  name: "Not a recipient",
  state: "admitted",
};
const address = {
  id: "address",
  isBillingDefault: false,
  isDeliveryDefault: true,
  label: "Domů",
  location: {
    address: {
      addressLine1: "Ulice 1",
      addressLine2: "Patro 2",
      city: "Praha",
      countryCode: "CZ",
      postalCode: "11000",
      region: "Praha",
    },
    state: "available" as const,
  },
  purposes: ["DELIVERY" as const],
  revision: 1,
};
const snapshot: CustomerAddressesSnapshot = {
  identity,
  result: { addresses: [address], state: "ready", viewerEmail: identity.email },
};

it("hides a stale auth instance even if the next login has the same email", () => {
  expect(customerAddressesForIdentity(snapshot, { ...identity })).toEqual({ state: "loading" });
  expect(customerAddressesForIdentity(snapshot, identity)).toEqual(snapshot.result);
  expect(
    customerAddressesForIdentity(
      {
        identity,
        result: {
          ...snapshot.result,
          addresses: [address],
          state: "ready",
          viewerEmail: "other@example.test",
        },
      },
      identity,
    ),
  ).toEqual({ state: "unavailable" });
});

it("distinguishes unresolved source data and a genuine empty book", () => {
  const d = getDictionary("en");
  const unresolved = renderToStaticMarkup(
    <CustomerAddressesList
      addresses={[{ ...address, location: { state: "unresolved" } }]}
      dictionary={d}
      locale="en"
    />,
  );
  expect(unresolved).toContain(d.accountPage.addressUnresolved);
  expect(unresolved).not.toContain("Ulice 1");
  const empty = renderToStaticMarkup(
    <CustomerAddressesList addresses={[]} dictionary={d} locale="en" />,
  );
  expect(empty).toContain(d.accountPage.emptyAddresses);
  expect(empty).not.toContain(d.accountPage.addressUnavailable);
});

it("keeps an existing country code selectable when editing an address", () => {
  const markup = renderToStaticMarkup(
    <CustomerAddressForm
      address={{
        ...address,
        location: {
          ...address.location,
          address: { ...address.location.address, countryCode: "XK" },
        },
      }}
      dictionary={getDictionary("cs")}
      disabled={false}
      error={null}
      locale="cs"
      onCancel={() => {}}
      onSubmit={() => {}}
      pending={false}
    />,
  );
  expect(markup).toContain('name="countryCode"');
  expect(markup).toContain('<option value="XK" selected="">Kosovo</option>');
  expect(markup).toContain('<option value="CZ">Česko</option>');
});
