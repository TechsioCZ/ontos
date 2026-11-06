import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { renderToStaticMarkup } from "react-dom/server";
import { MiniCart } from "../src/features/mini-cart";
import { useCart } from "../src/features/cart-provider";
import { getDictionary } from "../src/i18n";

rs.mock("next/navigation", () => ({ useRouter: () => ({ refresh: rs.fn() }) }));
rs.mock("../src/features/cart-provider", () => ({ useCart: rs.fn() }));

const entry = {
  expectedUnitPriceMinor: 130_700,
  image: null,
  minimumQuantity: 1,
  name: "Owner product",
  productId: "product",
  quantity: 4,
  sku: "SKU-S",
  slug: "owner-product",
  unit: "ks",
  variantId: "size-s",
  variantName: "S",
};
const cart: NonNullable<ReturnType<typeof useCart>> = {
  acceptPrice: () => false,
  add: () => true,
  clear: () => {},
  clearSubmitted: () => false,
  entries: [entry],
  error: false,
  imageHosts: [],
  loaded: true,
  remove: () => true,
  scope: { currency: "CZK", legalEntityId: "seller", marketId: "market", tenantId: "tenant" },
  update: () => true,
};
const render = () =>
  renderToStaticMarkup(
    <MiniCart dictionary={getDictionary("cs")} locale="cs" onOpenChange={() => {}} open={false} />,
  );

beforeEach(() => {
  rs.clearAllMocks();
  rs.mocked(useCart).mockReturnValue(cart);
});

describe("historical N1 cart item count", () => {
  it("shows the actual quantity for a single line instead of losing the count in a closed popup", () => {
    const html = render();
    expect(html).toContain('aria-label="Košík (4)"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Košík: 4");
    expect(html).toMatch(/>4<\/span>/u);
  });
  it("sums quantities across distinct variants", () => {
    rs.mocked(useCart).mockReturnValue({
      ...cart,
      entries: [entry, { ...entry, quantity: 2, variantId: "size-m" }],
    });
    expect(render()).toContain('aria-label="Košík (6)"');
  });
  it("caps the visual badge while retaining the full accessible count", () => {
    rs.mocked(useCart).mockReturnValue({ ...cart, entries: [{ ...entry, quantity: 125 }] });
    const html = render();
    expect(html).toContain('aria-label="Košík (125)"');
    expect(html).toMatch(/>99\+<\/span>/u);
  });
  it("does not show a stale badge for empty, unreadable or foreign-scope carts", () => {
    for (const current of [
      null,
      { ...cart, entries: [] },
      { ...cart, loaded: false },
      { ...cart, error: true },
      { ...cart, scope: null },
    ]) {
      rs.mocked(useCart).mockReturnValue(current);
      expect(render()).not.toContain('aria-label="Košík (4)"');
      expect(render()).not.toMatch(/>4<\/span>/u);
    }
  });
});
