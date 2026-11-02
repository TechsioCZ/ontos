import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Toaster, toaster } from "@techsio/ui-kit/molecules/toast";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import type { CartLine } from "@/features/cart/cart-state";
import {
  ReorderAction,
  type ReorderResult,
  type RepeatOrder,
} from "@/features/account/reorder-action";

function CurrentCart() {
  const { cart } = useCart();
  return (
    <output aria-label="Cart contents">
      {cart.lines.map((line) => `${line.variantId}:${line.quantity}:${line.priceMinor}`).join(",")}
    </output>
  );
}

function DemoCart({ children }: { children: ReactNode }) {
  return (
    <CartProvider storage={null}>
      {children}
      <Toaster />
    </CartProvider>
  );
}

const line = (variantId: string, quantity: number): CartLine => ({
  productId: "p",
  variantId,
  slug: "srouby",
  name: "Šrouby",
  sku: `SKU-${variantId}`,
  imageSrc: "/srouby.png",
  imageAlt: "Šrouby",
  unit: "ks",
  minimumQuantity: 10,
  stockCount: 1000,
  priceMinor: 121,
  quantity,
});
const fetchMock = vi.fn<typeof fetch>();
const respond = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(Response.json(body, { status }));

describe("repeat order", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    act(() => toaster.remove("sf-reorder-feedback"));
    cleanup();
    vi.unstubAllGlobals();
  });

  it("puts the resolved OntOS order lines into the active cart and merges a repeat", async () => {
    const resolution = { items: [line("a", 20), line("b", 40)], skipped: [] };
    respond(resolution);
    respond(resolution);
    render(
      <DemoCart>
        <ReorderAction orderId="o1" orderNumber="2026-001" lineCount={2} />
        <CurrentCart />
      </DemoCart>,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Objednat znovu 2026-001" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await user.dblClick(button);
    expect(await screen.findByText("Přidáno položek: 2.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ontos/account/reorder");
    expect(JSON.parse(String(init?.body))).toEqual({ orderId: "o1" });
    expect(screen.getByLabelText("Cart contents").textContent).toBe("a:20:121,b:40:121");
    expect(screen.getByRole("link", { name: "Přejít do košíku" }).getAttribute("href")).toBe(
      "/kosik",
    );
    await user.click(button);
    await waitFor(() =>
      expect(screen.getByLabelText("Cart contents").textContent).toBe("a:40:121,b:80:121"),
    );
  });

  it("reports lines OntOS no longer offers and adds the rest", async () => {
    respond({ items: [line("a", 20)], skipped: [{ sku: "OLD-1", reason: "not-offered" }] });
    render(
      <DemoCart>
        <ReorderAction orderId="o2" orderNumber="2026-002" />
        <CurrentCart />
      </DemoCart>,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Objednat znovu 2026-002" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await user.click(button);
    expect(await screen.findByText("OLD-1: varianta již není v nabídce.")).toBeTruthy();
    expect(screen.getByText("Přidáno položek: 1.")).toBeTruthy();
    expect(screen.getByLabelText("Cart contents").textContent).toBe("a:20:121");
  });

  it("never changes the cart when OntOS cannot resolve the order", async () => {
    respond({ message: "outage" }, 503);
    render(
      <DemoCart>
        <ReorderAction orderId="o3" orderNumber="2026-003" />
        <CurrentCart />
      </DemoCart>,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Objednat znovu 2026-003" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await user.click(button);
    expect(await screen.findByText("Objednávku se nepodařilo zopakovat.")).toBeTruthy();
    expect(screen.getByLabelText("Cart contents").textContent).toBe("");
  });

  it("explains an order without lines", async () => {
    render(
      <DemoCart>
        <ReorderAction orderId="o4" orderNumber="2026-004" lineCount={0} />
      </DemoCart>,
    );
    const button = await screen.findByRole("button", { name: "Objednat znovu 2026-004" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      document.getElementById(button.getAttribute("aria-describedby")!)?.textContent,
    ).toContain("nejsou dostupné");
  });

  it("passes the exact order and cart once to an injected service and shows its restrictions", async () => {
    let finish!: (result: ReorderResult) => void;
    const repeatOrder = vi.fn<RepeatOrder>(
      () =>
        new Promise<ReorderResult>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <DemoCart>
        <ReorderAction orderId="o5" orderNumber="#XYZ" repeatOrder={repeatOrder} />
      </DemoCart>,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Objednat znovu #XYZ" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await user.dblClick(button);
    expect(repeatOrder).toHaveBeenCalledExactlyOnceWith("o5", "default");
    finish({ addedLines: 2, notices: ["Varianta ABC není skladem."] });
    expect(await screen.findByText("Přidáno položek: 2.")).toBeTruthy();
    expect(screen.getByText("Varianta ABC není skladem.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers retry after service failure without claiming success", async () => {
    const repeatOrder = vi
      .fn<RepeatOrder>()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue({ addedLines: 0, notices: ["Zboží již není v nabídce."] });
    render(
      <DemoCart>
        <ReorderAction orderId="o6" orderNumber="#ERR" repeatOrder={repeatOrder} />
      </DemoCart>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Objednat znovu #ERR" }));
    expect(await screen.findByText("Objednávku se nepodařilo zopakovat.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Objednat znovu #ERR" }));
    expect(await screen.findByText("Přidáno položek: 0.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Přejít do košíku" })).toBeNull();
  });
});
