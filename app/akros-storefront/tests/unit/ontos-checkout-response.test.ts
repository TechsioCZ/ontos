import { describe, expect, it } from "vitest";
import { checkoutSaveError, readCheckoutQuote, readOrderResponse } from "@/ontos/checkout-response";
import { demoPayment } from "@/ontos/demo-checkout";
import { createCheckoutDraft, getPayment, validateMethods } from "@/mock-storefront/checkout";

const valid = {
  outcome: "PLACED",
  orderNumber: "OBJ-2026-0020",
  totalMinor: 12100,
  totalVatMinor: 2100,
};
describe("connected checkout response boundary", () => {
  it.each([
    [503, { error: "unavailable" }],
    [422, { message: "English error" }],
    [200, null],
    [200, []],
    [200, {}],
    [200, { ...valid, orderNumber: "" }],
    [200, { ...valid, outcome: "REJECTED" }],
    [200, { ...valid, totalMinor: "12100" }],
    [200, { ...valid, totalVatMinor: -1 }],
    [200, { ...valid, totalVatMinor: 99999 }],
  ])("rejects invalid HTTP/shape %j with Czech retry guidance", async (status, body) => {
    await expect(
      readOrderResponse(Response.json(body, { status: status as number })),
    ).rejects.toThrow(checkoutSaveError);
  });
  it("keeps the OntOS order id for the live status when the owner returns it", async () => {
    expect(
      await readOrderResponse(
        Response.json({ ...valid, orderId: "e12a77c6-c624-46bf-88fe-13d8c386e099" }),
      ),
    ).toEqual({
      orderId: "e12a77c6-c624-46bf-88fe-13d8c386e099",
      orderNumber: valid.orderNumber,
      totalMinor: 12100,
      totalVatMinor: 2100,
    });
  });
  it("rejects non-JSON success without inventing a local order", async () => {
    await expect(readOrderResponse(new Response("<html>error</html>"))).rejects.toThrow(
      checkoutSaveError,
    );
  });
  it.each(["PLACED", "REPLAYED"])("accepts verified %s", async (outcome) => {
    expect(await readOrderResponse(Response.json({ ...valid, outcome }))).toEqual({
      orderNumber: valid.orderNumber,
      totalMinor: 12100,
      totalVatMinor: 2100,
    });
  });
  it.each([
    {},
    null,
    { canCheckout: true },
    { canCheckout: true, priceChanged: true, issues: [] },
    { canCheckout: true, priceChanged: false, issues: ["blocked"] },
  ])("rejects invalid quotes %j", async (body) => {
    await expect(readCheckoutQuote(Response.json(body))).rejects.toThrow(checkoutSaveError);
  });
  it("recognizes the inactive demo method without changing prototype choices", () => {
    const draft = { ...createCheckoutDraft(), deliveryId: "osobni", paymentId: demoPayment.id };
    expect(getPayment(draft)?.title).toBe("Nic neplatíte (DEMO)");
    expect(validateMethods(draft)).toEqual({});
    expect(getPayment({ ...draft, paymentId: "gopay" })?.title).toBe("GoPay");
  });
});
