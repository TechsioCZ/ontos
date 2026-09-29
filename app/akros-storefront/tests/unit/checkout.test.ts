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
  it("starts with no shipping or payment and an editable valid demo contact", () => {
    const draft = createCheckoutDraft();
    expect(draft.deliveryId).toBe("");
    expect(draft.paymentId).toBe("");
    expect(draft.newsletter).toBe(false);
    expect(validateAddresses(draft)).toEqual({});
    expect(getCheckoutTotals(cart, draft)).toMatchObject({
      subtotal: 61,
      total: 61,
      net: 50,
      vat: 11,
      shipping: null,
    });
  });

  it("requires a matching pickup point and compatible payment", () => {
    const draft = { ...createCheckoutDraft(), deliveryId: "zasilkovna", paymentId: "gopay" };
    expect(validateMethods(draft)).toHaveProperty("pickupPointId");
    expect(validateMethods({ ...draft, pickupPointId: "balikovna-praha" })).toHaveProperty(
      "pickupPointId",
    );
    expect(validateMethods({ ...draft, pickupPointId: "zasilkovna-praha" })).toEqual({});
    expect(validateMethods({ ...draft, paymentId: "store-card" })).toHaveProperty("paymentId");
  });

  it("invalidates payment and pickup when changing delivery", () => {
    const draft = {
      ...createCheckoutDraft(),
      deliveryId: "osobni",
      paymentId: "store-card",
      pickupPointId: "zasilkovna-praha",
    };
    expect(selectDelivery(draft, "dpd")).toMatchObject({
      deliveryId: "dpd",
      paymentId: "",
      pickupPointId: "",
    });
  });

  it("guards direct URLs and skipped steps but permits going back", () => {
    const draft = createCheckoutDraft();
    expect(getReachableStep(3, cart, draft)).toBe(1);
    const methods = { ...draft, deliveryId: "dpd", paymentId: "gopay" };
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

  it("does not invent VAT when an old cart snapshot lacks a net price", () => {
    const oldCart = {
      ...cart,
      lines: cart.lines.map(({ priceExcludingVatMinor: _net, ...line }) => line),
    };
    expect(getCheckoutTotals(oldCart, createCheckoutDraft())).toMatchObject({
      net: null,
      vat: null,
      total: 61,
    });
  });

  it("adds the selected demo shipping price and tax only once", () => {
    const draft = { ...createCheckoutDraft(), deliveryId: "dpd", paymentId: "gopay" };
    expect(getCheckoutTotals(cart, draft)).toMatchObject({
      shipping: 7900,
      payment: 0,
      total: 7961,
      net: 6579,
      vat: 1382,
    });
  });

  it("round trips incomplete drafts and safely rejects corrupted storage", () => {
    const draft = { ...createCheckoutDraft(), email: "unfinished", newsletter: true };
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
