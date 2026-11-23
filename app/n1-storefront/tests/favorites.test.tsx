// @rstest-environment happy-dom
// @rstest-environment-options {"url":"https://shop.example.test"}
import { browserNetwork, serveApi } from "@app/shared-contracts/testing/http-double";
import { HttpApiBuilder } from "@modern-js/bff-effect/effect-edge";
import { rs } from "@rstest/core";
import { ToastProvider } from "@techsio/ui-kit/molecules/toast";
import { afterEach, expect, it } from "effect-rstest";
import { Effect } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { FavoriteToggle } from "../src/features/favorite-toggle";
import { FavoritesView } from "../src/features/favorites-view";
import { getDictionary } from "../src/i18n";
import { CardVariantsApi } from "../src/ontos/card-variants";
import type { CardVariantsQuery, FavoriteCard } from "../src/ontos/card-variants";
import { projectCatalog } from "../src/ontos/catalog-model";

const d = getDictionary("cs");
const card: FavoriteCard = {
  currency: "CZK",
  image: null,
  name: "Owner product",
  priceFrom: false,
  priceMinor: 25_000,
  sku: "M",
  stock: "available",
};
const {
  details: [product],
} = projectCatalog(
  {
    market: { configured: true, currency: "CZK", marketId: "n1" },
    products: [
      {
        id: "owner-product",
        name: card.name,
        slug: "owner-slug",
        variantRecords: [
          {
            active: true,
            attributes: "size=M",
            availability: "IN_STOCK",
            grossPriceMinor: 12_000,
            id: "size-m",
            name: "M",
            sku: "M",
            stockOnHand: 2,
          },
        ],
        variantSummary: { count: 1, minGrossPriceMinor: 12_000, stockOnHand: 2 },
      },
    ],
  },
  [],
);

let container: HTMLDivElement;
let root: Root;
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
});

const button = (label: string, scope: ParentNode = container) => {
  const control = [...scope.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  if (control === undefined) {
    throw new Error(`Missing button ${label}`);
  }
  return control;
};

it("lets the shopper save a variant from an unselected product", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <ToastProvider>
        <FavoriteToggle dictionary={d} product={product} variantId={undefined} />
        <FavoriteToggle dictionary={d} product={product} variantId="size-m" />
      </ToastProvider>,
    ),
  );
  await act(async () => button(d.favoriteItems.variants).click());
  const dialog = document.querySelector('[role="dialog"][data-state="open"]');
  const checkbox = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox).toBeDefined();
  await act(async () => checkbox?.click());
  await act(async () => button(d.favoriteItems.saveSelection, document).click());
  expect(button(d.favoriteItems.remove).getAttribute("aria-pressed")).toBe("true");
});

it.live("restores a selected variant and displays its current catalogue price before removal", () =>
  Effect.gen(function* favoritesFlow() {
    const queries: CardVariantsQuery[] = [];
    const handlers = HttpApiBuilder.group(CardVariantsApi, "cardVariants", (group) =>
      group.handle("read", ({ query }) =>
        Effect.sync(() => {
          queries.push(query);
          return {
            productId: product.id,
            slug: product.slug,
            state: "ready",
            variants: [{ favoriteCard: card, id: "size-m", name: "M" }],
          };
        }),
      ),
    );
    yield* Effect.promise(async () => {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () =>
        root.render(
          <ToastProvider>
            <FavoriteToggle dictionary={d} product={product} variantId="size-m" />
          </ToastProvider>,
        ),
      );
      expect(queries).toEqual([]);
      await act(async () => button(d.addToFavorites).click());
      expect(button(d.favoriteItems.remove).getAttribute("aria-pressed")).toBe("true");
      await act(async () =>
        root.render(
          <ToastProvider>
            <FavoritesView dictionary={d} locale="cs" />
          </ToastProvider>,
        ),
      );
      await rs.waitFor(async () => {
        await act(async () => {});
        expect(container.querySelector("a[href*='variantId=size-m']")?.textContent).toBe(card.name);
      });
      expect(container.textContent).toContain("250");
      expect(queries).toEqual([
        { details: "true", locale: "cs", productId: product.id, slug: product.slug },
      ]);
      await act(async () => button(d.favoriteItems.remove).click());
      expect(container.textContent).toContain(d.favoriteItems.empty);
    }).pipe(Effect.provide(browserNetwork(serveApi(CardVariantsApi, handlers))));
  }),
);
