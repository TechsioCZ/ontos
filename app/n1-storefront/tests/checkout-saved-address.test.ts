import { describe, expect, it } from "@rstest/core";
import { Struct } from "effect";
import type { CustomerAddress } from "../src/ontos/customer-addresses";
import type {
  CustomerAddressIdentity,
  CustomerAddressesSnapshot,
} from "../src/ontos/customer-addresses-client";
import {
  checkoutPostalForIdentity,
  checkoutSavedAddress,
  checkoutSavedAddressItems,
  copyCheckoutSavedAddress,
  editCheckoutPostal,
  initialCheckoutPostalDraft,
} from "../src/features/checkout-saved-address";
import { getDictionary } from "../src/i18n";

const identity: CustomerAddressIdentity = {
  email: "owner@example.test",
  name: "Not a recipient",
  state: "admitted",
};
const postal = {
  addressLine1: "Saved street 1",
  city: "London",
  countryCode: "GB",
  postalCode: "SW1A 1AA",
};
const address: CustomerAddress = {
  id: "saved",
  isBillingDefault: false,
  isDeliveryDefault: true,
  label: "Not a recipient either",
  location: { address: postal, state: "available" },
  purposes: ["DELIVERY"],
};
const snapshot: CustomerAddressesSnapshot = {
  identity,
  result: { addresses: [address], state: "ready", viewerEmail: identity.email },
};
const selection = (overrides: Partial<Parameters<typeof copyCheckoutSavedAddress>[0]> = {}) =>
  copyCheckoutSavedAddress({
    addressId: address.id,
    countryCodes: ["CZ", "GB"],
    disabled: false,
    identity,
    snapshot,
    ...overrides,
  });

describe("saved checkout postal addresses", () => {
  it("copies exactly the four supported postal fields and the actual selected country", () => {
    const result = checkoutSavedAddress(address, ["CZ", "GB"]);
    expect(result).toEqual({
      fields: { city: "London", country: "GB", postalCode: "SW1A 1AA", street: "Saved street 1" },
      state: "available",
    });
    expect(result).not.toHaveProperty("firstName");
    expect(result).not.toHaveProperty("lastName");
    expect(result).not.toHaveProperty("email");
    expect(result).not.toHaveProperty("phone");
  });

  it.each([{ addressLine2: "Apartment 2" }, { region: "London" }])(
    "refuses meaningful extra fields instead of dropping or concatenating them: %j",
    (extra) => {
      expect(
        checkoutSavedAddress(
          { ...address, location: { address: { ...postal, ...extra }, state: "available" } },
          ["GB"],
        ),
      ).toEqual({ reason: "extraFields", state: "unavailable" });
    },
  );

  it("accepts empty optional lines without inventing recipient values", () => {
    expect(
      checkoutSavedAddress(
        {
          ...address,
          location: {
            address: { ...postal, addressLine2: " \t", region: "" },
            state: "available",
          },
        },
        ["GB"],
      ).state,
    ).toBe("available");
  });

  it("does not change an unsupported country to the market default", () => {
    expect(checkoutSavedAddress(address, ["CZ"])).toEqual({
      reason: "country",
      state: "unavailable",
    });
  });

  it.each([
    { addressLine1: "" },
    { addressLine1: "x".repeat(201) },
    { city: "   " },
    { city: "x".repeat(121) },
    { postalCode: "12" },
    { postalCode: "x".repeat(13) },
  ])("applies the actual native order address validation: %j", (invalid) => {
    expect(
      checkoutSavedAddress(
        { ...address, location: { address: { ...postal, ...invalid }, state: "available" } },
        ["GB"],
      ),
    ).toEqual({ reason: "invalid", state: "unavailable" });
  });

  it("does not turn an unresolved Party address into manual address data", () => {
    expect(checkoutSavedAddress({ ...address, location: { state: "unresolved" } }, ["GB"])).toEqual(
      {
        reason: "unresolved",
        state: "unavailable",
      },
    );
  });

  it("never applies a stale read to a later login with the same email", () => {
    expect(selection({ identity: { ...identity } })).toBeNull();
    expect(
      selection({
        snapshot: {
          identity,
          result: { addresses: [address], state: "ready", viewerEmail: "other@example.test" },
        },
      }),
    ).toBeNull();
    expect(selection({ identity: null })).toBeNull();
    expect(selection({ disabled: true })).toBeNull();
    expect(selection()).not.toBeNull();
  });

  it("refuses ambiguous or empty native IDs without a synthetic manual sentinel", () => {
    expect(
      selection({
        snapshot: {
          identity,
          result: {
            addresses: [address, { ...address }],
            state: "ready",
            viewerEmail: identity.email,
          },
        },
      }),
    ).toBeNull();
    expect(selection({ addressId: "" })).toBeNull();
    expect(selection({ addressId: "missing" })).toBeNull();
  });

  it.each(["cs", "en"])("keeps unusable rows visible with a localized reason in %s", (locale) => {
    const labels = getDictionary(locale).checkout.savedAddresses;
    const items = checkoutSavedAddressItems(
      [
        address,
        {
          ...address,
          id: "extra",
          location: { address: { ...postal, addressLine2: "Flat 2" }, state: "available" },
        },
        { ...Struct.omit(address, ["label"]), id: "unresolved", location: { state: "unresolved" } },
      ],
      ["GB"],
      1,
      labels,
    );
    expect(items[0]?.disabled).toBe(false);
    expect(items[1]?.disabled).toBe(true);
    expect(items[1]?.label).toContain("Flat 2");
    expect(items[1]?.label).toContain(labels.reasons.extraFields);
    expect(items[2]?.label).toContain(labels.reasons.unresolved);
    expect(items[2]?.label).toContain(labels.unnamed.replace("{number}", "3"));
  });

  it("isolates collection values between reads even when IDs or labels collide", () => {
    const labels = getDictionary("en").checkout.savedAddresses;
    const addresses = [
      address,
      { ...address },
      { ...address, id: "" },
      { ...address, id: "manual" },
    ];
    const first = checkoutSavedAddressItems(addresses, ["GB"], 1, labels);
    const second = checkoutSavedAddressItems(addresses, ["GB"], 2, labels);
    expect(new Set(first.map((item) => item.value)).size).toBe(4);
    expect(first.map((item) => item.disabled)).toEqual([true, true, true, false]);
    for (const item of first) {
      expect(second.some((next) => next.value === item.value)).toBe(false);
    }
  });

  it("retains copied provenance after manual postal editing and clears all copied fields for B", () => {
    const copied = selection();
    expect(copied).not.toBeNull();
    if (copied === null) {
      return;
    }
    const edited = editCheckoutPostal(copied, identity, ["CZ", "GB"], "city", "Edited city");
    expect(edited.selectedAddressId).toBeNull();
    expect(edited.copiedForIdentity).toBe(identity);
    expect(edited.fields).toEqual({ ...copied.fields, city: "Edited city" });
    const cleared = checkoutPostalForIdentity(edited, { ...identity }, ["CZ", "GB"]);
    expect(cleared).toEqual(initialCheckoutPostalDraft(["CZ", "GB"]));
    expect(checkoutPostalForIdentity(cleared, identity, ["CZ", "GB"])).toBe(cleared);
    expect(checkoutPostalForIdentity(edited, null, ["CZ", "GB"])).toEqual(cleared);
  });

  it("preserves wholly manual postal input across auth changes and never chooses an address on arrival", () => {
    const initial = initialCheckoutPostalDraft(["GB"]);
    const manual = editCheckoutPostal(initial, null, ["GB"], "street", "Typed street");
    expect(manual.copiedForIdentity).toBeNull();
    expect(manual.selectedAddressId).toBeNull();
    expect(checkoutPostalForIdentity(manual, identity, ["GB"])).toBe(manual);
    expect(checkoutPostalForIdentity(manual, { ...identity }, ["GB"])).toBe(manual);
  });

  it("clears a copied address that is no longer representable by the current market countries", () => {
    const copied = selection();
    expect(copied).not.toBeNull();
    if (copied === null) {
      return;
    }
    expect(checkoutPostalForIdentity(copied, identity, ["CZ"])).toEqual(
      initialCheckoutPostalDraft(["CZ"]),
    );
  });

  it("returns a fresh explicit copy even when selecting identical postal data again", () => {
    const first = selection();
    const second = selection();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});
