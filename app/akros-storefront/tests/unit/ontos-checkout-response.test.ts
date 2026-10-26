import { describe, expect, it } from "vitest";
import {
  CheckoutStockError,
  CheckoutRejectionError,
  CheckoutPriceError,
  checkoutSaveError,
  readCheckoutQuote,
  readOrderResponse,
} from "@/ontos/checkout-response";

const valid = {
  outcome: "PLACED",
  orderId: "e12a77c6-c624-46bf-88fe-13d8c386e099",
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
  it.each(["INSUFFICIENT_STOCK", "OUT_OF_STOCK"])(
    "shows the owner %s message when stock ran out after the cart check",
    async (code) => {
      const issue = {
        code,
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
    },
  );
  it.each(["PRICE_CHANGED", "SHIPPING_PRICE_CHANGED"])(
    "requires fresh price acceptance for %s without exposing upstream text",
    async (code) => {
      const error = await readOrderResponse(
        Response.json({ issues: [{ code, message: "Raw upstream text" }] }, { status: 409 }),
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(CheckoutPriceError);
      expect((error as Error).message).toContain("Cena zboží nebo dopravy se změnila");
      expect((error as Error).message).not.toContain("Raw upstream text");
    },
  );
  it.each([
    { issues: [{ code: "UNKNOWN_REJECTION", message: "Private upstream text" }] },
    { issues: [{ code: "OUT_OF_STOCK" }, { code: "UNKNOWN_REJECTION" }] },
    { issues: [] },
    { message: "k dispozici je jen 7 ks." },
  ])("keeps other 409 bodies behind the generic retry guidance %j", async (body) => {
    await expect(readOrderResponse(Response.json(body, { status: 409 }))).rejects.toThrow(
      checkoutSaveError,
    );
  });
  it.each([undefined, "", "x".repeat(301)])(
    "retires a recognized stock rejection with safe guidance when its message is invalid: %j",
    async (message) => {
      const error = await readOrderResponse(
        Response.json({ issues: [{ code: "OUT_OF_STOCK", message }] }, { status: 409 }),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CheckoutRejectionError);
      expect(error).toBeInstanceOf(CheckoutStockError);
      expect((error as Error).message).toContain("Zboží již není dostupné");
      expect((error as Error).message).not.toContain("x".repeat(301));
    },
  );
  it("keeps the OntOS order id for the live status when the owner returns it", async () => {
    expect(
      await readOrderResponse(
        Response.json({ ...valid, orderId: "e12a77c6-c624-46bf-88fe-13d8c386e099" }),
      ),
    ).toEqual({
      orderId: valid.orderId,
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
      orderId: valid.orderId,
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
