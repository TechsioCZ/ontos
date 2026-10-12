import { describe, expect, it } from "vitest";
import { formatCartProductName } from "@/features/checkout/cart-product-name";

describe("checkout product names", () => {
  it("uses sentence case for uppercase catalogue names while preserving standards and materials", () => {
    expect(formatCartProductName("VRUTY SE ZÁPUSTNOU HLAVOU S KŘÍŽOVOU DRÁŽKOU DIN 7997/A2")).toBe(
      "Vruty se zápustnou hlavou s křížovou drážkou DIN 7997/A2",
    );
    expect(formatCartProductName("MATICE ŠESTIHRANNÉ DIN934/A2")).toBe(
      "Matice šestihranné DIN934/A2",
    );
    expect(formatCartProductName("OCEL DLE ČSN EN 10088 A AISI 304")).toBe(
      "Ocel dle ČSN EN 10088 a AISI 304",
    );
    expect(formatCartProductName("KOHOUT PN 16 DN 20 A MAZACÍ HLAVICE H 90°")).toBe(
      "Kohout PN 16 DN 20 a mazací hlavice H 90°",
    );
  });

  it("keeps existing mixed-case names and embedded brand spelling", () => {
    expect(formatCartProductName("Úchyt na fotovoltaické panely")).toBe(
      "Úchyt na fotovoltaické panely",
    );
    expect(formatCartProductName("Spojka TechBrand DN 20")).toBe("Spojka TechBrand DN 20");
  });
});
