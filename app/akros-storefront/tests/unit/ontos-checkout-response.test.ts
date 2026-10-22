import { describe, expect, it } from "vitest";
import {
  CheckoutStockError,
  checkoutSaveError,
  readCheckoutQuote,
  readOrderResponse,
} from "@/ontos/checkout-response";

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
  it("shows the owner INSUFFICIENT_STOCK message when stock ran out after the cart check", async () => {
    const issue = {
      code: "INSUFFICIENT_STOCK",
      availableQuantity: 7,
      message: "Kartáč (dvouřadý): k dispozici je jen 7 ks.",
    };
    const error = await readOrderResponse(
      Response.json({ message: "ignored", issues: [issue] }, { status: 409 }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CheckoutStockError);
    expect((error as Error).message).toBe(
      "Kartáč (dvouřadý): k dispozici je jen 7 ks. Upravte množství v košíku a objednávku odešlete znovu.",
    );
  });
  it.each([
    { issues: [{ code: "PRICE_CHANGED", message: "Raw upstream text" }] },
    { issues: [{ code: "INSUFFICIENT_STOCK", message: "x".repeat(301) }] },
    { message: "k dispozici je jen 7 ks." },
  ])("keeps other 409 bodies behind the generic retry guidance %j", async (body) => {
    await expect(readOrderResponse(Response.json(body, { status: 409 }))).rejects.toThrow(
      checkoutSaveError,
    );
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
});
