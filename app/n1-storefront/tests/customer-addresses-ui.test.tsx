import { expect, it } from "@rstest/core";
import { renderToStaticMarkup } from "react-dom/server";
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

it("renders read-only address content without inventing a recipient or CRUD controls", () => {
  const html = renderToStaticMarkup(
    <CustomerAddressesList addresses={[address]} dictionary={getDictionary("cs")} />,
  );
  for (const field of ["Domů", "Ulice 1", "Patro 2", "11000", "Praha", "CZ"]) {
    expect(html).toContain(field);
  }
  expect(html).not.toContain("Not a recipient");
  expect(html).not.toContain("<button");
  expect(html).not.toContain("<input");
  expect(html).not.toContain("mailto:");
});

it("distinguishes unresolved source data and a genuine empty book", () => {
  const d = getDictionary("en");
  const unresolved = renderToStaticMarkup(
    <CustomerAddressesList
      addresses={[{ ...address, location: { state: "unresolved" } }]}
      dictionary={d}
    />,
  );
  expect(unresolved).toContain(d.accountPage.addressUnresolved);
  expect(unresolved).not.toContain("Ulice 1");
  const empty = renderToStaticMarkup(<CustomerAddressesList addresses={[]} dictionary={d} />);
  expect(empty).toContain(d.accountPage.emptyAddresses);
  expect(empty).not.toContain(d.accountPage.addressUnavailable);
});
