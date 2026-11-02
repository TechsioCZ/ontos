import { afterEach, expect, it, vi } from "vitest";
import { loadFavoriteProduct } from "@/features/favorites/catalog";
import { MARKET_LOCALE_HEADER } from "@/ontos/market-locale";

const originalPath = window.location.pathname;

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", originalPath);
});

it.each(["cs", "sk", "en"])("loads variant choices in the current %s market", async (locale) => {
  window.history.replaceState(null, "", `/${locale}/produkt/vrut`);
  const catalog = { product: { id: "p" }, variants: [{ id: "v" }] };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(catalog));
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();

  expect(await loadFavoriteProduct("vrut", controller.signal)).toEqual(catalog);
  expect(fetcher).toHaveBeenCalledWith("/api/favorites/catalog/vrut", {
    signal: controller.signal,
    headers: { [MARKET_LOCALE_HEADER]: locale },
  });
});
