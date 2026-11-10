import { beforeEach, vi } from "vitest";
import type { ActiveMarket } from "@/ontos/market";

// jsdom does not implement the media queries used by UI-kit motion preferences.
beforeEach(() => {
  if (typeof window === "undefined") return;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn<Window["matchMedia"]>((media) => ({
      matches: false,
      media,
      onchange: null,
      addListener: vi.fn<MediaQueryList["addListener"]>(),
      removeListener: vi.fn<MediaQueryList["removeListener"]>(),
      addEventListener: vi.fn<MediaQueryList["addEventListener"]>(),
      removeEventListener: vi.fn<MediaQueryList["removeEventListener"]>(),
      dispatchEvent: vi.fn<MediaQueryList["dispatchEvent"]>(() => true),
    })),
  });
});

// The UI-kit Toaster shows its live region as a manual popover. Browsers have the Popover API; jsdom does not.
if (typeof HTMLElement !== "undefined") {
  for (const method of ["showPopover", "hidePopover"] as const) {
    if (!(method in HTMLElement.prototype)) {
      Object.defineProperty(HTMLElement.prototype, method, { configurable: true, value: () => {} });
    }
  }
}

// The UI-kit carousel scrolls its track on mount. Browsers implement Element.scrollTo; jsdom does not.
if (typeof Element !== "undefined" && !("scrollTo" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: () => {} });
}

// Component suites render Kai's UI outside Next's RSC runtime and root layout, on the generated
// seed catalog. Owner reads are covered by ontos-catalog/ontos-catalog-server and the page suites.
vi.mock("@/ontos/catalog-provider", async () => {
  const { fixtureCatalog } = await import("./support/catalog-fixture");
  return { useCatalog: () => fixtureCatalog };
});
vi.mock("@/ontos/catalog-server", async () => {
  const { fixtureCatalog } = await import("./support/catalog-fixture");
  return {
    getCatalog: async () => fixtureCatalog,
    // Page suites mock the owner page read themselves; other suites must never reach it.
    getCatalogPage: async () => {
      throw new Error("getCatalogPage must be mocked by the suite");
    },
    getShellSnapshot: async () => {
      throw new Error("getShellSnapshot is only used by the root layout");
    },
  };
});

// Pages, routes and the cart quote resolve the request's market from Next request headers. Suites run outside a
// request: they get the Czech market (CZK, Czech chrome). Market resolution is covered by market-selection.
vi.mock("@/ontos/active-market", async () => {
  const { cs } = await import("@/i18n/cs");
  const { testMarket } = await import("./support/market-fixture");
  return {
    getActiveMarket: vi.fn<() => Promise<ActiveMarket>>(async () => testMarket),
    getMarketResolution: async () => ({ kind: "live", market: testMarket, live: [] }),
    getMoney: async () => ({ currency: testMarket.currency, locale: testMarket.formatLocale }),
    getDictionary: async () => cs,
    getStorePath: async () => "/",
    marketHref: async (href: string) => href,
  };
});

// Client chrome reads the brand from the root layout's BrandProvider. Suites render outside the root layout: they
// get the default AKROS brand unless they mount their own BrandProvider (brand suites do).
vi.mock("@/brand/brand-context", async (original) => {
  const actual = await original<typeof import("@/brand/brand-context")>();
  const { akros } = await import("@/brand/akros");
  const { toClientBrand } = await import("@/brand");
  const fallback = toClientBrand(akros, "cs");
  return { ...actual, useBrand: () => actual.useOptionalBrand() ?? fallback };
});
