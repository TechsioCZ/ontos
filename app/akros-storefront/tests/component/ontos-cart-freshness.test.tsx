import { setTimeout } from "node:timers/promises";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CartProvider } from "@/features/cart/cart-provider";
import type { CartState } from "@/features/cart/cart-state";
import { CartQuoteProvider, useCartQuote } from "@/ontos/cart-revalidation";
import { browserAt, serveHttp } from "../support/http";
import { renderStorefront as render } from "../support/storefront";

const cart: CartState = {
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
let network: Awaited<ReturnType<typeof serveHttp>> | undefined;
afterEach(async () => {
  cleanup();
  await network?.idle();
  await network?.close();
  network = undefined;
  localStorage.clear();
});
it("refreshes before ten seconds without blinking, expires on failure, then revalidates on focus", async () => {
  let fail = false;
  const failedRefresh = Promise.withResolvers<void>();
  network = await serveHttp(async (request) => {
    if (new URL(request.url).pathname !== "/api/ontos/cart" || request.method !== "POST")
      return new Response("Unknown endpoint", { status: 404 });
    const { cart: posted }: { cart: CartState } = await request.json();
    if (fail) {
      failedRefresh.resolve();
      return new Response("owner unavailable", { status: 503 });
    }
    return Response.json({
      cart: posted,
      priceChanged: false,
      issues: [],
      canCheckout: true,
      totals: { totalMinor: 121, totalVatMinor: 21, netMinor: 100, shippingMinor: null },
    });
  });
  browserAt(network.origin);
  localStorage.setItem("akros-demo-cart-v3", JSON.stringify(cart));
  render(
    <CartProvider>
      <CartQuoteProvider>
        <Probe />
      </CartQuoteProvider>
    </CartProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText("Verified amount").textContent).toBe("121"));
  expect(screen.getByLabelText("Verified amount").textContent).toBe("121");
  fail = true;
  await act(async () => {
    await failedRefresh.promise;
  });
  await network.idle();
  expect(network.requests).toHaveLength(2);
  expect(screen.getByLabelText("Status").textContent).toBe("ready");
  expect(screen.getByLabelText("Verified amount").textContent).toBe("121");
  await waitFor(
    () => expect(screen.getByLabelText("Verified amount").textContent).toBe("unverified"),
    { timeout: 4_000 },
  );
  expect(screen.getByLabelText("Verified amount").textContent).toBe("unverified");
  expect(screen.getByLabelText("Continue").textContent).toBe("false");
  fail = false;
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(screen.getByLabelText("Verified amount").textContent).toBe("121"));
  expect(screen.getByLabelText("Verified amount").textContent).toBe("121");
  expect(screen.getByLabelText("Continue").textContent).toBe("true");
}, 20_000);
it("keeps a freshly verified amount visible when the owner refresh updates stock metadata", async () => {
  const refreshArrived = Promise.withResolvers<void>();
  const releaseRefresh = Promise.withResolvers<void>();
  network = await serveHttp(async (request) => {
    if (new URL(request.url).pathname !== "/api/ontos/cart" || request.method !== "POST")
      return new Response("Unknown endpoint", { status: 404 });
    const { cart: posted }: { cart: CartState } = await request.json();
    if (posted.lines[0]?.stockCount === 9) {
      refreshArrived.resolve();
      await releaseRefresh.promise;
    }
    return Response.json({
      cart: {
        ...posted,
        lines: posted.lines.map((line) => ({ ...line, stockCount: 9 })),
      },
      priceChanged: false,
      issues: [],
      canCheckout: true,
      totals: { totalMinor: 121, totalVatMinor: 21, netMinor: 100, shippingMinor: null },
    });
  });
  browserAt(network.origin);
  localStorage.setItem("akros-demo-cart-v3", JSON.stringify(cart));
  try {
    render(
      <CartProvider>
        <CartQuoteProvider>
          <Probe />
        </CartQuoteProvider>
      </CartProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("Verified amount").textContent).toBe("121"));
    expect(screen.getByLabelText("Verified amount").textContent).toBe("121");
    await act(async () => {
      await refreshArrived.promise;
      await setTimeout(200);
    });
    expect(network.requests).toHaveLength(2);
    expect(await network.requests[1]?.json()).toMatchObject({
      cart: { lines: [{ stockCount: 9 }] },
    });
    expect(screen.getByLabelText("Verified amount").textContent).toBe("121");
    expect(screen.getByLabelText("Continue").textContent).toBe("true");
  } finally {
    await act(async () => {
      releaseRefresh.resolve();
      await network?.idle();
    });
  }
});
