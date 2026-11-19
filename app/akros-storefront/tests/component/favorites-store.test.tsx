// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { saveProductFavorites, useFavorites } from "@/features/favorites/use-favorites";
import { favoritesStorageKey } from "@/features/favorites/favorite-references";
import {
  replaceStoredProductReferences,
  useVariantReferences,
} from "@/features/products/use-variant-references";
import { productWatchStorageKey } from "@/features/products/product-watch";

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
    render(
      <>
        <Probe />
        <Probe />
      </>,
    );
    expect(screen.getAllByRole("status").map((output) => output.textContent)).toEqual([
      "q:null",
      "q:null",
    ]);
    act(() =>
      saveProductFavorites("p", [{ productId: "p", productSlug: "product", variantId: "v" }]),
    );
    expect(screen.getAllByRole("status").map((output) => output.textContent)).toEqual([
      "q:null,p:v",
      "q:null,p:v",
    ]);
    cleanup();
    render(<Probe />);
    expect(screen.getByRole("status").textContent).toBe("q:null,p:v");
  });
  it("does not announce a successful change when browser storage rejects the write", () => {
    localStorage.setItem(favoritesStorageKey, "[]");
    const fillerKey = "quota-filler";
    // Fill jsdom's real 5,000,000-code-unit storage quota without replacing Storage.
    localStorage.setItem(
      fillerKey,
      "x".repeat(5_000_000 - fillerKey.length - favoritesStorageKey.length - 2),
    );
    render(<Probe />);
    expect(() =>
      saveProductFavorites("p", [{ productId: "p", productSlug: "product", variantId: "v" }]),
    ).toThrow("quota");
    expect(screen.getByRole("status").textContent).toBe("");
    expect(localStorage.getItem(favoritesStorageKey)).toBe("[]");
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
