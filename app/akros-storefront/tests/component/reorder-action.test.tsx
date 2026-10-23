import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Toaster, toaster } from "@techsio/ui-kit/molecules/toast";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { mockOrders } from "@/mock-storefront/fixtures/account";
import {
  ReorderAction,
  type ReorderResult,
  type RepeatOrder,
} from "@/features/account/reorder-action";

function CurrentCart() {
  const { cart } = useCart();
  return (
    <output aria-label="Cart contents">
      {cart.lines.map((line) => `${line.variantId}:${line.quantity}`).join(",")}
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

describe("repeat order frontend", () => {
  afterEach(() => {
    act(() => toaster.remove("akros-reorder-feedback"));
    cleanup();
  });
  it("repeats a seeded order into the real cart and merges a subsequent repeat", async () => {
    render(
      <DemoCart>
        <ReorderAction orderNumber={mockOrders[0].number} />
        <CurrentCart />
      </DemoCart>,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: `Objednat znovu ${mockOrders[0].number}` });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await user.dblClick(button);
    expect(screen.getByLabelText("Cart contents").textContent).toBe(
      "item-4746:20,item-5419:40,item-5294:10",
    );
    expect(screen.getByText("Přidáno položek: 3.")).toBeTruthy();
    await user.click(button);
    expect(screen.getByLabelText("Cart contents").textContent).toBe(
      "item-4746:40,item-5419:80,item-5294:20",
    );
  });
  it("explains unavailable integration without changing the cart", async () => {
    render(
      <DemoCart>
        <ReorderAction orderNumber="#ABC" />
      </DemoCart>,
    );
    const button = await screen.findByRole("button", { name: "Objednat znovu #ABC" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      document.getElementById(button.getAttribute("aria-describedby")!)?.textContent,
    ).toContain("nejsou dostupné");
  });

  it("passes the exact order and cart once and displays service restrictions", async () => {
    let finish!: (result: ReorderResult) => void;
    const repeatOrder = vi.fn<RepeatOrder>(
      () =>
        new Promise<ReorderResult>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <DemoCart>
        <ReorderAction orderNumber="#XYZ" repeatOrder={repeatOrder} />
      </DemoCart>,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Objednat znovu #XYZ" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await user.dblClick(button);
    expect(repeatOrder).toHaveBeenCalledExactlyOnceWith("#XYZ", "default");
    finish({ addedLines: 2, notices: ["Varianta ABC není skladem."] });
    expect(await screen.findByText("Přidáno položek: 2.")).toBeTruthy();
    expect(screen.getByText("Varianta ABC není skladem.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Přejít do košíku" }).getAttribute("href")).toBe(
      "/kosik",
    );
  });

  it("offers retry after service failure without claiming success", async () => {
    const repeatOrder = vi
      .fn<RepeatOrder>()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue({ addedLines: 0, notices: ["Zboží již není v nabídce."] });
    render(
      <DemoCart>
        <ReorderAction orderNumber="#ERR" repeatOrder={repeatOrder} />
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
