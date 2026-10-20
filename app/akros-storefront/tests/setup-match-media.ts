import { beforeEach, vi } from "vitest";

// jsdom does not implement the media queries used by UI-kit motion preferences.
beforeEach(() => {
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

// Component suites exercise Kai's prototype, outside Next's RSC runtime and root layout.
// Live source-of-truth behavior is covered separately by ontos-catalog and headless BFF checks.
vi.mock("@/ontos/catalog-provider", async () => {
  const model = await import("@/mock-storefront/catalog");
  return { useCatalog: () => model, useDataSource: () => "mock" };
});
vi.mock("@/ontos/catalog-server", async () => {
  const model = await import("@/mock-storefront/catalog");
  return { getCatalog: async () => model };
});
