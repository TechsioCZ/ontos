import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductVariantActions } from "@/components/product-variant-actions";
import { ProductShare } from "@/components/product-share";

const { push } = vi.hoisted(() => ({ push: vi.fn<(href: string) => void>() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const props = { productId: "native-product", productName: "Bolt", productSlug: "bolt" };
describe("concrete product actions", () => {
  it("opens a native product inquiry directly for a standalone item", async () => {
    render(<ProductVariantActions {...props} variantId={null} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Dotaz na produkt" }));
    expect(push).toHaveBeenCalledWith("/kontakty?productId=native-product#primy-kontakt");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("preserves the exact native variant ID in its inquiry link", async () => {
    render(<ProductVariantActions {...props} variantId="variant-8" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Dotaz na variantu" }));
    expect(push).toHaveBeenCalledWith(
      "/kontakty?productId=native-product&variantIds=variant-8#primy-kontakt",
    );
  });
  it("shares a standalone product without manufacturing a variant selection", async () => {
    render(<ProductShare {...props} variantId={null} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sdílet" }));
    const href = screen.getByRole("link", { name: "E-mail" }).getAttribute("href");
    const query = new URLSearchParams(href?.split("?")[1]);
    expect(new URL(query.get("body")!).pathname).toBe("/produkt/bolt");
    expect(new URL(query.get("body")!).search).toBe("");
    expect(screen.queryByText("Sdílet varianty")).toBeNull();
  });
});
