import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CartProvider } from "@/features/cart/cart-provider";
import { CartQuoteProvider, useCartQuote } from "@/ontos/cart-revalidation";

const cart = {
  version: 3,
  lines: [
    {
      productId: "p",
      name: "Test product",
      slug: "p",
      sku: "p",
      unit: "ks",
      quantity: 1,
      minimumQuantity: 1,
      stockCount: 10,
      priceMinor: 121,
      imageSrc: "",
      imageAlt: "",
    },
  ],
};
function Probe() {
  const state = useCartQuote()!;
  return (
    <>
      <output aria-label="Status">{state.status}</output>
      <output aria-label="Continue">{String(state.canContinue)}</output>
      <output aria-label="Verified amount">
        {state.quote?.totals?.totalMinor ?? "unverified"}
      </output>
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});
it("refreshes before ten seconds without blinking, expires on failure, then revalidates on focus", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  localStorage.setItem("akros-demo-cart-v3", JSON.stringify(cart));
  let fail = false;
  const request = vi.fn(async (_url: string, init: RequestInit) => {
    const { cart } = JSON.parse(String(init.body));
    if (fail) throw new Error("owner unavailable");
    return Response.json({
      cart,
      priceChanged: false,
      issues: [],
      canCheckout: true,
      totals: { totalMinor: 121, totalVatMinor: 21, netMinor: 100, shippingMinor: null },
    });
  });
  vi.stubGlobal("fetch", request);
  render(
    <CartProvider>
      <CartQuoteProvider>
        <Probe />
      </CartQuoteProvider>
    </CartProvider>,
  );
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(screen.getByLabelText("Verified amount").textContent).toBe("121");
  fail = true;
  await act(() => vi.advanceTimersByTimeAsync(7000));
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText("Status").textContent).toBe("ready");
  expect(screen.getByLabelText("Verified amount").textContent).toBe("121");
  await act(() => vi.advanceTimersByTimeAsync(3100));
  expect(screen.getByLabelText("Verified amount").textContent).toBe("unverified");
  expect(screen.getByLabelText("Continue").textContent).toBe("false");
  fail = false;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
  });
  expect(screen.getByLabelText("Verified amount").textContent).toBe("121");
  expect(screen.getByLabelText("Continue").textContent).toBe("true");
});
it("keeps a freshly verified amount visible when the owner refresh updates stock metadata", async () => {
  vi.useFakeTimers();
  localStorage.setItem("akros-demo-cart-v3", JSON.stringify(cart));
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      reads++;
      if (reads > 1) return new Promise<Response>(() => {});
      const { cart: posted } = JSON.parse(String(init.body));
      return Response.json({
        cart: {
          ...posted,
          lines: posted.lines.map((line: object) => ({ ...line, stockCount: 9 })),
        },
        priceChanged: false,
        issues: [],
        canCheckout: true,
        totals: { totalMinor: 121, totalVatMinor: 21, netMinor: 100, shippingMinor: null },
      });
    }),
  );
  render(
    <CartProvider>
      <CartQuoteProvider>
        <Probe />
      </CartQuoteProvider>
    </CartProvider>,
  );
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(screen.getByLabelText("Verified amount").textContent).toBe("121");
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(reads).toBe(2);
  expect(screen.getByLabelText("Verified amount").textContent).toBe("121");
  expect(screen.getByLabelText("Continue").textContent).toBe("true");
});
