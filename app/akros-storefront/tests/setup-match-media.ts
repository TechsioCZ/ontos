import { beforeEach, vi } from "vitest";

// jsdom has no layout observer. UI-kit DataTable's DnD adapter imports it eagerly;
// actual sizing and overflow remain covered in Chromium.
if (typeof window !== "undefined" && typeof ResizeObserver === "undefined") {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
}

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
