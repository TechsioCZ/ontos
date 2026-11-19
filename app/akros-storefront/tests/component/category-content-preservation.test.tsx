// @vitest-environment node
import { Window, type Document } from "happy-dom";
import { renderToReadableStream } from "react-dom/server.node";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { adaptForAppRouterInstance } from "next/dist/shared/lib/router/adapters";
import singletonRouter from "next/router";
import { expect, it, vi } from "vitest";

import type { CatalogCategory } from "@/ontos/catalog-types";
import { serveHttp } from "../support/http";

const categories: CatalogCategory[] = [
  {
    id: "material",
    parentId: null,
    hasChildren: true,
    slug: "nerezovy-spojovaci-material",
    name: "Nerezový spojovací materiál",
    position: 1,
  },
  {
    id: "srouby",
    parentId: "material",
    hasChildren: true,
    slug: "srouby",
    name: "Šrouby",
    position: 1,
    description: "Šrouby z nerezové oceli pro venkovní spoje.",
  },
  {
    id: "a2",
    parentId: "srouby",
    hasChildren: false,
    slug: "srouby-a2",
    name: "Šrouby A2",
    position: 1,
    imageSrc: "/storefront/categories/srouby-a2.jpg",
    imageAlt: "Nerezové šrouby A2",
  },
  {
    id: "a4",
    parentId: "srouby",
    hasChildren: false,
    slug: "srouby-a4",
    name: "Šrouby A4",
    position: 2,
    imageSrc: "/storefront/categories/srouby-a4.jpg",
    imageAlt: "Nerezové šrouby A4",
  },
  {
    id: "naradi",
    parentId: null,
    hasChildren: false,
    slug: "nerezovy-hutni-material",
    name: "Nerezový hutní materiál",
    position: 2,
  },
];

async function renderCategory(compact: boolean) {
  // Each representation gets fresh real catalog caches and the same native Next/React runtime.
  vi.resetModules();
  const [
    { default: CategoryPage },
    { getShellSnapshot },
    { CatalogProvider },
    { MarketProvider },
    { BrandProvider },
    { akros },
    { toClientBrand },
    { CartProvider },
    { nextRequest },
  ] = await Promise.all([
    import("@/app/kategorie/[slug]/page"),
    import("@/ontos/catalog-server"),
    import("@/ontos/catalog-provider"),
    import("@/ontos/market-context"),
    import("@/brand/brand-context"),
    import("@/brand/akros"),
    import("@/brand"),
    import("@/features/cart/cart-provider"),
    import("../support/next-request"),
  ]);
  const navigation = categories.map(
    ({ description: _description, imageSrc: _src, imageAlt: _alt, ...node }) => node,
  );
  const content = categories.filter((node) => node.id === "srouby" || node.parentId === "srouby");
  const headers = {
    "x-ontos-gateway-context": JSON.stringify({
      apiBaseUrl: "/shell-super-app-api/merchandise",
      token: "category-content-test",
      compositionRevision: "a".repeat(64),
      expiresAt: Date.now() + 60_000,
    }),
  };
  const network = await serveHttp(async (incoming) => {
    const body = await incoming.json();
    if (body.audience === "commerce-market-catalog")
      return Response.json({ markets: [], associations: [] }, { headers });
    const query = body.query.view.storefrontCatalog;
    return Response.json(
      {
        products: [],
        total: 0,
        page: 1,
        pageSize: 24,
        homepageFeaturedProductIds: [],
        ...(query.mode === "categories"
          ? { categories: compact ? navigation : categories }
          : query.includeCategoryContent
            ? { categories: compact ? content : categories }
            : {}),
      },
      { headers },
    );
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "category-content-test-key");
  const request = nextRequest(`${network.origin}/cs/kategorie/srouby`, {
    headers: { "x-akros-market-locale": "cs" },
  });
  const browser = new Window();
  try {
    return await request.run(async () => {
      // Warm the price-free layout navigation before the category's bounded content read.
      const snapshot = await getShellSnapshot();
      const page = await CategoryPage({
        params: Promise.resolve({ slug: "srouby" }),
        searchParams: Promise.resolve({}),
      });
      const Component = () => (
        <MarketProvider
          market={{
            locale: "cs",
            marketCode: "",
            currency: "CZK",
            formatLocale: "cs-CZ",
            configured: true,
            live: [],
          }}
        >
          <BrandProvider brand={toClientBrand(akros, "cs")}>
            <CatalogProvider snapshot={snapshot}>
              <CartProvider storage={null}>{page}</CartProvider>
            </CatalogProvider>
          </BrandProvider>
        </MarketProvider>
      );
      const errors: unknown[] = [];
      const stream = await renderToReadableStream(
        <AppRouterContext.Provider value={adaptForAppRouterInstance(singletonRouter)}>
          <Component />
        </AppRouterContext.Provider>,
        {
          onError: (error) => {
            errors.push(error);
          },
        },
      );
      await stream.allReady;
      const html = await new Response(stream).text();
      if (errors.length) throw new AggregateError(errors, "Category server render failed");
      const document = new browser.DOMParser().parseFromString(html, "text/html");
      await network.idle();
      const queries = await Promise.all(
        network.requests.map(async (read) => (await read.json()).query?.view?.storefrontCatalog),
      );
      expect(queries.filter((query) => query?.mode === "categories")).toHaveLength(1);
      expect(queries).toContainEqual(
        expect.objectContaining({
          categorySlug: "srouby",
          includeCategories: false,
          includeCategoryContent: true,
        }),
      );
      return categoryInformation(document);
    });
  } finally {
    await request.close();
    await network.close();
    await browser.happyDOM.close();
    vi.unstubAllEnvs();
  }
}

function categoryInformation(document: Document) {
  const heading = document.querySelector('section[aria-labelledby="category-title"]');
  const links = (selector: string) =>
    [...document.querySelectorAll(selector)].map((link) => ({
      label: link.textContent?.trim(),
      href: link.getAttribute("href"),
    }));
  return {
    title: document.querySelector("h1")?.textContent,
    description: heading?.querySelector("p")?.textContent,
    children: links("main .sf-category-card"),
    images: [...document.querySelectorAll("main .sf-category-card img")].map((image) => ({
      alt: image.getAttribute("alt"),
      src: new URL(image.getAttribute("src") ?? "", "http://shop.test").searchParams.get("url"),
    })),
    navigation: links('aside a[href*="/kategorie/"]'),
  };
}

it("preserves category content, child images and navigation with a cached compact tree", async () => {
  const full = await renderCategory(false);
  const compact = await renderCategory(true);

  expect(compact).toEqual(full);
  expect(compact).toMatchObject({
    title: "Šrouby",
    description: "Šrouby z nerezové oceli pro venkovní spoje.",
    children: [
      { label: "Šrouby A2", href: "/cs/kategorie/srouby-a2" },
      { label: "Šrouby A4", href: "/cs/kategorie/srouby-a4" },
    ],
    images: [
      { alt: "Nerezové šrouby A2", src: "/storefront/categories/srouby-a2.jpg" },
      { alt: "Nerezové šrouby A4", src: "/storefront/categories/srouby-a4.jpg" },
    ],
  });
  expect(compact.navigation).toEqual(
    expect.arrayContaining([
      { label: "Nerezový spojovací materiál", href: "/cs/kategorie/nerezovy-spojovaci-material" },
      { label: "Šrouby", href: "/cs/kategorie/srouby" },
      { label: "Šrouby A2", href: "/cs/kategorie/srouby-a2" },
      { label: "Šrouby A4", href: "/cs/kategorie/srouby-a4" },
      { label: "Nerezový hutní materiál", href: "/cs/kategorie/nerezovy-hutni-material" },
    ]),
  );
});
