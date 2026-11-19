// @rstest-environment happy-dom
import { setTimeout as nextTurn } from "node:timers/promises";
import "@app/shared-contracts/testing/http-double";
import { afterEach, beforeEach, expect, it, rs } from "@rstest/core";
import { Schema } from "effect";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AccountView } from "../src/features/account-view";
import { CustomerOrderDetailView } from "../src/features/customer-order-detail";
import { PortalSessionProvider } from "../src/features/auth-view";
import { getDictionary } from "../src/i18n";
import type { CustomerProfilePageState } from "../src/ontos/customer-profile";
import { CustomerOrderSchema } from "../src/ontos/customer-orders";
import type { CustomerOrdersView } from "../src/ontos/customer-orders";
import type { CustomerAddressesRead } from "../src/ontos/customer-addresses";
import type { PortalOutcome } from "../src/ontos/portal";

const initial: CustomerProfilePageState = {
  profile: {
    contactEmail: "private-contact@example.test",
    displayName: "PRIVATE_PROFILE_NAME",
    phone: "+420777123456",
    version: "a".repeat(64),
  },
  state: "ready",
  viewerEmail: "owner@example.test",
};
const dictionary = getDictionary("cs");
const orderInitial: CustomerOrdersView = {
  data: {
    offset: 0,
    orders: [
      Schema.decodeSync(CustomerOrderSchema)({
        createdAt: "2026-11-04T12:00:00.000Z",
        currency: "CZK",
        detail: {
          billingAddress: null,
          contact: { email: "private-order-contact@example.test", name: "PRIVATE_ORDER_BUYER" },
          deliveryAddress: {
            city: "Praha",
            country: "CZ",
            postalCode: "11000",
            street: "PRIVATE_ORDER_STREET",
          },
          deliveryRecipient: null,
          lines: [],
          note: "PRIVATE_ORDER_NOTE",
        },
        id: "private-order-id",
        market: null,
        number: "PRIVATE_ORDER_NUMBER",
        preview: [
          {
            name: "PRIVATE_ORDER_RECORD",
            productId: "private-product-id",
            quantity: 1,
            sku: "PRIVATE-SKU",
            variantId: null,
            variantName: null,
          },
        ],
        pricesIncludeVat: true,
        shipping: null,
        status: "NEW",
        totalMinor: 100,
        totalVatMinor: 0,
        updatedAt: null,
      }),
    ],
    pageSize: 50,
    total: 1,
  },
  state: "ready",
  viewerEmail: "owner@example.test",
};

const addresses = {
  addresses: [
    {
      id: "private-address-id",
      isBillingDefault: false,
      isDeliveryDefault: true,
      label: "PRIVATE_ADDRESS_RECORD",
      location: {
        address: {
          addressLine1: "PRIVATE_ADDRESS_STREET",
          city: "Praha",
          countryCode: "CZ",
          postalCode: "11000",
        },
        state: "available",
      },
      purposes: ["DELIVERY"],
    },
  ],
  state: "ready",
  viewerEmail: "owner@example.test",
} satisfies CustomerAddressesRead;
const admission = {
  email: "owner@example.test",
  name: "PRIVATE_SESSION_NAME",
  state: "admitted",
} satisfies PortalOutcome;
const unexpectedNavigation = () => {
  throw new Error("Session guard must not navigate or refresh for its verified owner");
};
const router = {
  back: unexpectedNavigation,
  bfcacheId: "customer-account-session-guard",
  forward: unexpectedNavigation,
  prefetch: () => {},
  push: unexpectedNavigation,
  refresh: unexpectedNavigation,
  replace: unexpectedNavigation,
} satisfies AppRouterInstance;
const holdAccountRead = () => ({
  arrived: Promise.withResolvers<Request>(),
  response: Promise.withResolvers<Response>(),
});
let accountGate: ReturnType<typeof holdAccountRead> | null;
let container: HTMLDivElement;
let root: Root;
let previousInterceptor: typeof window.happyDOM.settings.fetch.interceptor;

const fetchOwner = async (request: Request): Promise<Response> => {
  if (request.method !== "GET") {
    throw new Error(`Unexpected account write: ${request.method} ${request.url}`);
  }
  switch (new URL(request.url).pathname) {
    case "/api/account": {
      const gate = accountGate;
      if (gate !== null) {
        gate.arrived.resolve(request);
        return await gate.response.promise;
      }
      return Response.json(admission);
    }
    case "/api/customer-orders": {
      return Response.json(orderInitial.data);
    }
    case "/api/customer-addresses": {
      return Response.json(addresses);
    }
    default: {
      throw new Error(`Unexpected customer HTTP request: ${request.url}`);
    }
  }
};
const mount = async (view: ReactNode) => {
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router}>
        <PortalSessionProvider>{view}</PortalSessionProvider>
      </AppRouterContext.Provider>,
    );
  });
};
const eventually = async (assertion: () => void) => {
  await rs.waitFor(
    async () => {
      await act(async () => {
        await nextTurn(0);
      });
      assertion();
    },
    { interval: 5, timeout: 3000 },
  );
};
const expectPanel = (tab: "profile" | "orders" | "addresses") => {
  expect(container.querySelector('[role="tablist"]')).not.toBeNull();
  expect(container.textContent).not.toContain(dictionary.accountPage.loading);
  if (tab === "profile") {
    expect(container.querySelector<HTMLInputElement>('input[name="contactEmail"]')?.value).toBe(
      "private-contact@example.test",
    );
    expect(container.querySelector<HTMLInputElement>('input[name="displayName"]')?.value).toBe(
      "PRIVATE_PROFILE_NAME",
    );
    expect(container.querySelector<HTMLInputElement>('input[name="phone"]')?.value).toBe(
      "+420777123456",
    );
  } else {
    expect(container.textContent).toContain(
      tab === "orders" ? "PRIVATE_ORDER_RECORD" : "PRIVATE_ADDRESS_RECORD",
    );
  }
};
const expectOrderDetail = () => {
  expect(container.textContent).not.toContain(dictionary.accountPage.loading);
  for (const privateValue of [
    "PRIVATE_ORDER_NUMBER",
    "PRIVATE_ORDER_STREET",
    "private-order-contact@example.test",
    "PRIVATE_ORDER_BUYER",
    "PRIVATE_ORDER_NOTE",
  ]) {
    expect(container.textContent).toContain(privateValue);
  }
  expect(container.textContent).toContain(dictionary.checkout.statuses.NEW);
};
const revalidate = async () => {
  const gate = holdAccountRead();
  accountGate = gate;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await gate.arrived.promise;
  });
  return gate;
};
const admit = async (gate: ReturnType<typeof holdAccountRead>) => {
  await act(async () => {
    gate.response.resolve(Response.json(admission));
  });
};

beforeEach(() => {
  accountGate = null;
  previousInterceptor = window.happyDOM.settings.fetch.interceptor;
  // Use happy-dom's HTTP boundary; no hook, panel, module or global is replaced.
  window.happyDOM.settings.fetch.interceptor = {
    beforeAsyncRequest: async ({ request, window }) => {
      const response = await fetchOwner(request);
      return new window.Response(await response.arrayBuffer(), {
        headers: [...response.headers],
        status: response.status,
        statusText: response.statusText,
      });
    },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    accountGate?.response.resolve(Response.json(admission));
    await nextTurn(0);
  });
  container.remove();
  window.happyDOM.settings.fetch.interceptor = previousInterceptor;
});

it.each(["profile", "orders", "addresses"] as const)(
  "hides all private account panels while session revalidation is pending on %s",
  async (tab) => {
    await mount(
      <AccountView dictionary={dictionary} initial={initial} initialTab={tab} locale="cs" />,
    );
    await eventually(() => expectPanel(tab));
    const gate = await revalidate();
    expect(container.textContent).toContain(dictionary.accountPage.loading);
    for (const privateValue of [
      "private-contact@example.test",
      "PRIVATE_PROFILE_NAME",
      "+420777123456",
      "PRIVATE_ORDER_RECORD",
      "PRIVATE_ADDRESS_RECORD",
      "PRIVATE_SESSION_NAME",
      "PRIVATE_ORDER_NUMBER",
      "PRIVATE_ADDRESS_STREET",
    ]) {
      expect(new XMLSerializer().serializeToString(container)).not.toContain(privateValue);
    }
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    await admit(gate);
    await eventually(() => expectPanel(tab));
  },
);

it.each([
  { content: "private-contact@example.test", tab: "profile" as const },
  { content: "PRIVATE_ORDER_RECORD", tab: "orders" as const },
])("shows the verified own $tab panel after session revalidation", async (control) => {
  const gate = holdAccountRead();
  accountGate = gate;
  await mount(
    <AccountView dictionary={dictionary} initial={initial} initialTab={control.tab} locale="cs" />,
  );
  await gate.arrived.promise;
  expect(container.textContent).toContain(dictionary.accountPage.loading);
  expect(new XMLSerializer().serializeToString(container)).not.toContain(control.content);
  await admit(gate);
  await eventually(() => expectPanel(control.tab));
  expect(new XMLSerializer().serializeToString(container)).toContain(control.content);
  expect(container.textContent).not.toContain(dictionary.accountPage.loading);
});

it("hides the actual order detail and contact/address PII while session revalidation is pending", async () => {
  await mount(
    <CustomerOrderDetailView dictionary={dictionary} initial={orderInitial} locale="cs" />,
  );
  await eventually(expectOrderDetail);
  const gate = await revalidate();
  expect(container.textContent).toContain(dictionary.accountPage.loading);
  for (const privateValue of [
    "PRIVATE_ORDER_NUMBER",
    "PRIVATE_ORDER_STREET",
    "private-order-contact@example.test",
    "PRIVATE_ORDER_BUYER",
    "PRIVATE_ORDER_NOTE",
  ]) {
    expect(new XMLSerializer().serializeToString(container)).not.toContain(privateValue);
  }
  await admit(gate);
  await eventually(expectOrderDetail);
});

it("shows the actual verified own order detail after session revalidation", async () => {
  const gate = holdAccountRead();
  accountGate = gate;
  await mount(
    <CustomerOrderDetailView dictionary={dictionary} initial={orderInitial} locale="cs" />,
  );
  await gate.arrived.promise;
  expect(container.textContent).toContain(dictionary.accountPage.loading);
  await admit(gate);
  await eventually(expectOrderDetail);
});
