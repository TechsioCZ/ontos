import { settleBrowser } from "../support/browser";
import "next/dist/client/app-bootstrap";
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentAppRouterState } from "next/dist/client/components/app-router-instance";
import { NextRouter, flightResponse } from "../support/router";
import { browserAt, serveHttp } from "../support/http";
import { withRetryClock } from "../support/clock";
import { renderStorefront } from "../support/storefront";
import { cs } from "@/i18n/cs";
import { CartProvider } from "@/features/cart/cart-provider";
import { AddressStep } from "@/features/checkout/address-step";
import { CheckoutLayout } from "@/features/checkout/checkout-layout";
import { CheckoutProvider } from "@/features/checkout/checkout-provider";
import { ReviewStep } from "@/features/checkout/review-step";
import { createCheckoutDraft } from "@/features/checkout/checkout-state";

// Shipping methods expire 9.75 s after their request started; refreshes run every 7 s and are
// skipped while the tab is hidden. happy-dom offers no visibility control, so a hidden tab is
// covered by its observable effect: the virtual clock passes expiry without a fresh list landing.
const ppl = { id: "PPL", title: "PPL", priceMinor: 12900 };
const dpd = { id: "DPD", title: "DPD", priceMinor: 9900 };
const billing = {
  firstName: "Test",
  lastName: "Customer",
  street: "Test 1",
  city: "Brno",
  postalCode: "60200",
  country: "CZ",
  phone: "+420777123456",
};
const steps = {
  address: { path: "/cs/kosik/dodaci-udaje", page: <AddressStep /> },
  summary: { path: "/cs/kosik/shrnuti", page: <ReviewStep /> },
};

/** Each shipping-list request waits for its own reply, so a test decides what every refresh returns. */
function replies() {
  const calls: { arrived: PromiseWithResolvers<void>; reply: PromiseWithResolvers<Response> }[] =
    [];
  let served = 0;
  const call = (index: number) =>
    (calls[index] ??= { arrived: Promise.withResolvers(), reply: Promise.withResolvers() });
  return {
    call,
    serve() {
      const current = call(served++);
      current.arrived.resolve();
      return current.reply.promise;
    },
  };
}

let network: Awaited<ReturnType<typeof serveHttp>>;
let shipping: ReturnType<typeof replies>;
const navigated = flightResponse("Navigated");

beforeEach(async () => {
  shipping = replies();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(
    "akros-demo-cart-v3",
    JSON.stringify({
      version: 3,
      lines: [
        {
          productId: "p",
          slug: "p",
          name: "Šroub",
          sku: "s",
          imageSrc: "/s.jpg",
          imageAlt: "Šroub",
          unit: "ks",
          minimumQuantity: 1,
          stockCount: 100,
          priceMinor: 121,
          priceExcludingVatMinor: 100,
          quantity: 1,
        },
      ],
    }),
  );
  sessionStorage.setItem(
    "sf-checkout-v2",
    JSON.stringify({
      version: 1,
      draft: {
        ...createCheckoutDraft(),
        deliveryId: "PPL",
        email: "verified@example.test",
        billing,
      },
    }),
  );
  network = await serveHttp(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/ontos/account")
      return Response.json({ account: { email: "verified@example.test" } });
    if (pathname === "/api/ontos/checkout") return shipping.serve();
    if (pathname === "/api/ontos/cart")
      return Response.json({ canCheckout: true, priceChanged: false, issues: [] });
    if (pathname === "/api/ontos/orders")
      return Response.json({
        outcome: "PLACED",
        orderId: "order-1",
        orderNumber: "OBJ-1",
        totalMinor: 13021,
        totalVatMinor: 21,
      });
    return (await navigated).clone();
  });
});

afterEach(async () => {
  cleanup();
  await network.idle();
  await network.close();
});

async function openCheckout(step: keyof typeof steps) {
  browserAt(`${network.origin}${steps[step].path}`);
  await act(async () => {
    renderStorefront(
      <NextRouter>
        <CartProvider>
          <CheckoutProvider>
            <CheckoutLayout recommendations={[]}>{steps[step].page}</CheckoutLayout>
          </CheckoutProvider>
        </CartProvider>
      </NextRouter>,
    );
  });
}

const route = () => getCurrentAppRouterState()?.canonicalUrl;
const pathsOf = (filter: (pathname: string) => boolean) =>
  network.requests
    // Link prefetches are not navigations; only router pushes and replaces are.
    .filter((request) => request.headers.get("next-router-prefetch") === null)
    .map((request) => new URL(request.url).pathname)
    .filter(filter);
const navigations = () => pathsOf((pathname) => !pathname.startsWith("/api/"));
const orderCalls = () =>
  pathsOf((pathname) => pathname === "/api/ontos/cart" || pathname === "/api/ontos/orders");
const savedDraft = () => JSON.parse(sessionStorage.getItem("sf-checkout-v2") ?? "null").draft;
const stepHeading = (step: keyof typeof steps) =>
  screen.queryByRole("heading", { level: 1, name: cs.checkout.steps[step] });
const submitButton = () => screen.getByRole("button", { name: cs.checkout.review.submit });
/** Refreshes the way a returning customer does: the window regains focus. */
const refocus = () => act(async () => window.dispatchEvent(new Event("focus")));
/** Virtual time only; real HTTP keeps running between timer advances. */
const passExpiry = () => new Promise((resolve) => setTimeout(resolve, 10_000));

describe("checkout shipping-method expiry", () => {
  it.each(["address", "summary"] as const)(
    "keeps the %s step and its draft while an expired list's refresh is in flight and then fails",
    async (step) => {
      shipping.call(0).reply.resolve(Response.json({ shippingMethods: [ppl] }));
      await openCheckout(step);
      await network.idle();
      expect(stepHeading(step)).not.toBeNull();
      await withRetryClock(async () => {
        await passExpiry();
        await refocus();
        await shipping.call(1).arrived.promise;
        // The list has expired and nothing fresh has arrived: the step must not fall back.
        expect(stepHeading(step)).not.toBeNull();
        expect(route()).toBe(steps[step].path);
        shipping.call(1).reply.resolve(new Response(null, { status: 503 }));
        await network.idle();
        expect(stepHeading(step)).not.toBeNull();
        expect(route()).toBe(steps[step].path);
        expect(navigations()).toEqual([]);
        expect(savedDraft()).toMatchObject({ deliveryId: "PPL", billing });
      });
    },
  );

  it("refuses to place an order with an expired list and accepts it once a fresh list confirms the method", async () => {
    shipping.call(0).reply.resolve(Response.json({ shippingMethods: [ppl] }));
    await openCheckout("summary");
    await network.idle();
    await withRetryClock(async () => {
      await passExpiry();
      shipping.call(1).reply.resolve(new Response(null, { status: 503 }));
      await refocus();
      await network.idle();
      await act(async () => submitButton().click());
      await network.idle();
      expect(screen.getByRole("alert").textContent).toBe(cs.checkout.errors.methodsUnavailable);
      expect(orderCalls()).toEqual([]);
      expect(sessionStorage.getItem("akros-ontos-pending:default")).toBeNull();
      expect(route()).toBe(steps.summary.path);

      shipping.call(2).reply.resolve(Response.json({ shippingMethods: [ppl] }));
      await refocus();
      await network.idle();
      await act(async () => submitButton().click());
      await network.idle();
      expect(orderCalls()).toEqual(["/api/ontos/cart", "/api/ontos/orders"]);
      const order = network.requests.find(
        (request) => new URL(request.url).pathname === "/api/ontos/orders",
      );
      expect(JSON.parse(await order!.text()).draft.deliveryId).toBe("PPL");
    });
  });

  it("sends the customer back to delivery when a successful refresh no longer offers the chosen method", async () => {
    shipping.call(0).reply.resolve(Response.json({ shippingMethods: [ppl] }));
    await openCheckout("summary");
    await network.idle();
    expect(navigations()).toEqual([]);
    shipping.call(1).reply.resolve(Response.json({ shippingMethods: [dpd] }));
    await refocus();
    await network.idle();
    expect(navigations()).toEqual(["/cs/kosik/doprava-platba"]);
    expect(route()).toBe("/cs/kosik/doprava-platba");
    expect(savedDraft()).toMatchObject({ billing });
  });

  it("holds a deep link until the first list loads, showing why it waits when loading fails", async () => {
    shipping.call(0).reply.resolve(new Response(null, { status: 503 }));
    await openCheckout("summary");
    await network.idle();
    expect(stepHeading("summary")).toBeNull();
    expect(screen.getByText(cs.checkout.errors.methodsUnavailable)).not.toBeNull();
    expect(route()).toBe(steps.summary.path);
    expect(navigations()).toEqual([]);

    shipping.call(1).reply.resolve(Response.json({ shippingMethods: [ppl] }));
    await refocus();
    await network.idle();
    expect(stepHeading("summary")).not.toBeNull();
    expect(route()).toBe(steps.summary.path);
    expect(navigations()).toEqual([]);
  });
});
