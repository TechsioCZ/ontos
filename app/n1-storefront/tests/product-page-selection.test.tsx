import { beforeEach, expect, it, rs } from "@rstest/core";
import { renderToStaticMarkup } from "react-dom/server";
import ProductPage from "../src/app/[locale]/produkt/[slug]/page";
import { projectCatalog } from "../src/ontos/catalog-model";

const boundary = rs.hoisted(() => ({
  getCatalog: rs.fn(),
  notFound: rs.fn(() => {
    throw new Error("product-route-not-found");
  }),
}));

rs.mock("next/navigation", () => ({ notFound: boundary.notFound }));
rs.mock("../src/ontos/catalog", () => ({ getCatalog: boundary.getCatalog }));
rs.mock("../src/features/product-view", () => ({
  ProductView: (props: { variantId?: string }) => (
    <output data-present={Object.hasOwn(props, "variantId")} data-variant={props.variantId} />
  ),
}));

const catalog = projectCatalog(
  {
    market: { configured: true, currency: "CZK", marketId: "owner-market" },
    products: [{ id: "product", name: "Owner product", slug: "owner-product" }],
  },
  [],
);
const page = (search: { variantId?: string | string[] }) =>
  ProductPage({
    params: Promise.resolve({ locale: "cs", slug: "owner-product" }),
    searchParams: Promise.resolve(search),
  });

beforeEach(() => {
  boundary.getCatalog.mockResolvedValue({ catalog, state: "ready" });
  boundary.notFound.mockClear();
});

it("leaves the variant prop absent only when the query selector is absent", async () => {
  const html = renderToStaticMarkup(await page({}));
  expect(html).toContain('data-present="false"');
  expect(html).not.toContain("data-variant=");
  expect(boundary.notFound).not.toHaveBeenCalled();
});

it("preserves an explicit unknown string for the blocked-selection view", async () => {
  const html = renderToStaticMarkup(await page({ variantId: "unknown-owner-variant" }));
  expect(html).toContain('data-present="true"');
  expect(html).toContain('data-variant="unknown-owner-variant"');
  expect(boundary.notFound).not.toHaveBeenCalled();
});

it.each([{ variantId: [] }, { variantId: ["variant"] }, { variantId: ["a", "b"] }])(
  "rejects a plural query selector instead of converting it to implicit selection: %j",
  async (search) => {
    await expect(page(search)).rejects.toThrow("product-route-not-found");
    expect(boundary.notFound).toHaveBeenCalledOnce();
  },
);
