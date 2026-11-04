import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductPurchase } from "../src/features/product-purchase";
import { selectProductDetail } from "../src/features/product-selection";
import { useCart } from "../src/features/cart-provider";
import { projectCatalog } from "../src/ontos/catalog-model";
import { getDictionary } from "../src/i18n";

const feedback = rs.hoisted(() => {
  const actions: (() => void)[] = [];
  return { actions, create: rs.fn() };
});
rs.mock("@techsio/ui-kit/molecules/toast", () => ({
  useToast: () => ({ create: feedback.create }),
}));
rs.mock("@techsio/ui-kit/atoms/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => {
    feedback.actions.push(onClick);
    return <button type="button">{children}</button>;
  },
}));
rs.mock("../src/features/cart-provider", () => ({ useCart: rs.fn() }));

const {
  details: [product],
} = projectCatalog(
  {
    market: { configured: true, currency: "CZK", marketId: "market" },
    products: [
      {
        availability: "IN_STOCK",
        currency: "CZK",
        grossPriceMinor: 10_000,
        id: "p1",
        minimumQuantity: 1,
        name: "Owner item",
        slug: "item",
        stockOnHand: 2,
        stockTracked: true,
        unit: "ks",
      },
    ],
  },
  [],
);

beforeEach(() => {
  rs.clearAllMocks();
  feedback.actions.length = 0;
});

describe("product purchase feedback", () => {
  for (const saved of [true, false]) {
    it(`announces ${saved ? "saved" : "failed"} cart changes through a toast`, () => {
      const add = rs.fn(() => saved);
      rs.mocked(useCart).mockReturnValue({
        acceptPrice: () => false,
        add,
        clear: () => {},
        clearSubmitted: () => false,
        entries: [],
        error: false,
        imageHosts: [],
        loaded: true,
        remove: () => false,
        scope: { currency: "CZK", legalEntityId: "legal", marketId: "market", tenantId: "tenant" },
        update: () => false,
      });
      const d = getDictionary("cs");
      const html = renderToStaticMarkup(
        <ProductPurchase
          dictionary={d}
          locale="cs"
          product={product}
          selection={selectProductDetail(product, product.variants[0]?.id)}
        />,
      );
      feedback.actions[0]?.();
      expect(add).toHaveBeenCalledTimes(1);
      expect(feedback.create).toHaveBeenCalledTimes(1);
      expect(feedback.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: saved ? d.shopping.added : d.shopping.addFailed,
          type: saved ? "success" : "error",
        }),
      );
      expect(html).not.toContain('href="/cs/kosik"');
      expect(html).not.toContain(d.shopping.unverified);
      expect(html).not.toContain('id="purchase-unavailable"');
    });
  }
});
