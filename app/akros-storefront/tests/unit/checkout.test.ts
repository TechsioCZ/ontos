import { describe, expect, it } from "vitest";
import type { CartState } from "@/mock-storefront/cart";
import {
  createCheckoutDraft,
  getCheckoutTotals,
  getReachableStep,
  parseCheckoutDraft,
  selectDelivery,
  validateAddresses,
  validateMethods,
} from "@/mock-storefront/checkout";

const cart: CartState = {
  version: 3,
  lines: [
    {
      productId: "chain",
      slug: "chain",
      name: "Řetěz",
      sku: "A4",
      imageSrc: "/chain.jpg",
      imageAlt: "Řetěz",
      unit: "m",
      minimumQuantity: 0.5,
      stockCount: 10,
      priceMinor: 121,
      priceExcludingVatMinor: 100,
      quantity: 0.5,
    },
  ],
};

describe("four-step checkout", () => {
  it("starts with no shipping and an editable valid demo contact", () => {
    const draft = createCheckoutDraft();
    expect(draft.deliveryId).toBe("");
    expect(validateAddresses(draft)).toEqual({});
    expect(getCheckoutTotals(cart, draft)).toMatchObject({
      subtotal: 61,
      total: 61,
      net: null,
      vat: null,
      shipping: null,
    });
  });

  it("requires a supported delivery and a matching pickup point", () => {
    expect(validateMethods({ ...createCheckoutDraft(), deliveryId: "dpd" })).toHaveProperty(
      "deliveryId",
    );
    const draft = { ...createCheckoutDraft(), deliveryId: "zasilkovna" };
    expect(validateMethods(draft)).toHaveProperty("pickupPointId");
    expect(validateMethods({ ...draft, pickupPointId: "balikovna-praha" })).toHaveProperty(
      "pickupPointId",
    );
    expect(validateMethods({ ...draft, pickupPointId: "zasilkovna-praha" })).toEqual({});
    expect(validateMethods({ ...draft, deliveryId: "osobni" })).toEqual({});
  });

  it("invalidates the pickup point when changing delivery", () => {
    const draft = {
      ...createCheckoutDraft(),
      deliveryId: "zasilkovna",
      pickupPointId: "zasilkovna-praha",
    };
    expect(selectDelivery(draft, "zasilkovna")).toMatchObject({
      pickupPointId: "zasilkovna-praha",
    });
    expect(selectDelivery(draft, "osobni")).toMatchObject({
      deliveryId: "osobni",
      pickupPointId: "",
    });
  });

  it("guards direct URLs and skipped steps but permits going back", () => {
    const draft = createCheckoutDraft();
    expect(getReachableStep(3, cart, draft)).toBe(1);
    const methods = { ...draft, deliveryId: "osobni" };
    expect(getReachableStep(3, cart, methods)).toBe(3);
    expect(getReachableStep(3, cart, { ...methods, email: "invalid" })).toBe(2);
    expect(getReachableStep(0, cart, methods)).toBe(0);
    expect(getReachableStep(3, { version: 3, lines: [] }, methods)).toBe(0);
  });

  it("validates another address only while it is enabled without losing the draft", () => {
    const draft = { ...createCheckoutDraft(), differentDeliveryAddress: true };
    expect(validateAddresses(draft)).toHaveProperty("delivery.firstName");
    expect(validateAddresses({ ...draft, differentDeliveryAddress: false })).toEqual({});
  });

  it("adds the selected demo shipping to the gross total and leaves tax to the OntOS quote", () => {
    const draft = { ...createCheckoutDraft(), deliveryId: "zasilkovna" };
    expect(getCheckoutTotals(cart, draft)).toEqual({
      subtotal: 61,
      shipping: 7900,
      payment: 0,
      total: 7961,
      net: null,
      vat: null,
    });
    expect(getCheckoutTotals(cart, { ...draft, deliveryId: "osobni" })).toMatchObject({
      shipping: 0,
      total: 61,
    });
  });

  it("round trips incomplete drafts and safely rejects corrupted storage", () => {
    const draft = { ...createCheckoutDraft(), email: "unfinished" };
    expect(parseCheckoutDraft(JSON.stringify({ version: 1, draft }))).toEqual(draft);
    expect(parseCheckoutDraft("broken")).toEqual(createCheckoutDraft());
    expect(parseCheckoutDraft(JSON.stringify({ version: 99, draft }))).toEqual(
      createCheckoutDraft(),
    );
    expect(
      parseCheckoutDraft(JSON.stringify({ version: 1, draft: { ...draft, billing: null } })),
    ).toEqual(createCheckoutDraft());
  });
});
