import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveProductFavorites, useFavorites } from "@/features/favorites/use-favorites";
import { favoritesStorageKey } from "@/mock-storefront/favorites";
import {
  replaceStoredProductReferences,
  useVariantReferences,
} from "@/features/products/use-variant-references";
import { productWatchStorageKey } from "@/mock-storefront/product-watch";

function Probe() {
  const { favorites } = useFavorites();
  return (
    <output>{favorites.map((item) => `${item.productId}:${item.variantId}`).join(",")}</output>
  );
}

function WatchProbe() {
  const { references } = useVariantReferences(productWatchStorageKey);
  return <output aria-label="Hlídání">{references.length}</output>;
}
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
describe("favorites browser store", () => {
  it("keeps watch and favorite subscriptions and records independent", () => {
    render(
      <>
        <Probe />
        <WatchProbe />
      </>,
    );
    act(() =>
      replaceStoredProductReferences(productWatchStorageKey, "p", [
        { productId: "p", productSlug: "product", variantId: "v" },
      ]),
    );
    expect(screen.getByLabelText("Hlídání").textContent).toBe("1");
    expect(localStorage.getItem(favoritesStorageKey)).toBeNull();
    act(() => saveProductFavorites("p", []));
    expect(screen.getByLabelText("Hlídání").textContent).toBe("1");
    expect(JSON.parse(localStorage.getItem(productWatchStorageKey)!)).toHaveLength(1);
  });
  it("updates all subscribers and reloads persisted state without losing other products", () => {
    const other = { productId: "q", productSlug: "other", variantId: null };
    localStorage.setItem(favoritesStorageKey, JSON.stringify([other]));
    render(<Probe />);
    expect(screen.getByRole("status").textContent).toBe("q:null");
    act(() =>
      saveProductFavorites("p", [{ productId: "p", productSlug: "product", variantId: "v" }]),
    );
    expect(screen.getByRole("status").textContent).toBe("q:null,p:v");
    cleanup();
    render(<Probe />);
    expect(screen.getByRole("status").textContent).toBe("q:null,p:v");
  });
  it("does not announce a successful change when browser storage rejects the write", () => {
    render(<Probe />);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() =>
      saveProductFavorites("p", [{ productId: "p", productSlug: "product", variantId: "v" }]),
    ).toThrow("quota");
    expect(screen.getByRole("status").textContent).toBe("");
  });
  it("responds to storage clear from another tab", () => {
    localStorage.setItem(
      favoritesStorageKey,
      JSON.stringify([{ productId: "p", productSlug: "product", variantId: "v" }]),
    );
    render(<Probe />);
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
