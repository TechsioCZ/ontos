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
import { MiniLogin } from "../src/features/mini-login";
import { getDictionary } from "../src/i18n";
import type { CustomerProfilePageState } from "../src/ontos/customer-profile";
import { CustomerOrderSchema } from "../src/ontos/customer-orders";
import type { CustomerOrdersView } from "../src/ontos/customer-orders";
import { CustomerAddressCommandSchema } from "../src/ontos/customer-addresses";
import type {
  CustomerAddress,
  CustomerAddressCommand,
  CustomerAddressesRead,
} from "../src/ontos/customer-addresses";
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
      revision: 1,
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
let addressWriter: ((command: CustomerAddressCommand) => Response) | null;
let addressRows: readonly CustomerAddress[];
let accountGate: ReturnType<typeof holdAccountRead> | null;
const ownerReads: string[] = [];
let container: HTMLDivElement;
let root: Root;
let previousInterceptor: typeof window.happyDOM.settings.fetch.interceptor;

const fetchOwner = async (request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/api/customer-addresses" && addressWriter !== null) {
    return addressWriter(
      Schema.decodeUnknownSync(CustomerAddressCommandSchema)(await request.json()),
    );
  }
  if (request.method !== "GET") {
    throw new Error(`Unexpected account write: ${request.method} ${request.url}`);
  }
  ownerReads.push(path);
  switch (path) {
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
      return Response.json({ ...addresses, addresses: addressRows });
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
  ownerReads.length = 0;
  accountGate = null;
  addressRows = addresses.addresses;
  addressWriter = null;
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

it("replaces the header login popover with a localized profile link for an admitted customer", async () => {
  const gate = holdAccountRead();
  accountGate = gate;
  const onOpenChange = rs.fn((_open: boolean): void => {});
  await mount(<MiniLogin dictionary={dictionary} locale="en" onOpenChange={onOpenChange} open />);
  await gate.arrived.promise;
  expect(container.querySelector('[aria-haspopup="dialog"]')).not.toBeNull();
  expect(container.querySelector('a[href="/en/ucet"]')).toBeNull();
  await admit(gate);

  await eventually(() => {
    expect(container.querySelector('[aria-haspopup="dialog"]')).toBeNull();
    const link = container.querySelector('a[href="/en/ucet"]');
    expect(link?.getAttribute("aria-label")).toBe(dictionary.account);
    expect(document.activeElement).toBe(link);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
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

const click = (label: string, scope: ParentNode = container) => {
  const button = [...scope.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  act(() => {
    button?.click();
  });
};
const selectAccountTab = async (label: string) => {
  const trigger = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (button) => button.textContent?.trim() === label,
  );
  expect(trigger).toBeDefined();
  await act(async () => {
    trigger?.click();
  });
};

it("reuses already loaded address and order reads while navigating tabs in the same session", async () => {
  await mount(
    <AccountView dictionary={dictionary} initial={initial} initialTab="addresses" locale="cs" />,
  );
  await eventually(() => expectPanel("addresses"));
  await selectAccountTab(dictionary.accountPage.orders);
  await eventually(() => expectPanel("orders"));
  await selectAccountTab(dictionary.accountPage.addresses);
  expectPanel("addresses");
  await selectAccountTab(dictionary.accountPage.orders);
  expectPanel("orders");
  await act(async () => {
    await nextTurn(0);
  });

  expect(ownerReads).toEqual(["/api/account", "/api/customer-addresses", "/api/customer-orders"]);
});

it("makes one admission read for a focus and visibility pair before reading private data again", async () => {
  await mount(
    <AccountView dictionary={dictionary} initial={initial} initialTab="addresses" locale="cs" />,
  );
  await eventually(() => expectPanel("addresses"));
  const gate = holdAccountRead();
  accountGate = gate;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await gate.arrived.promise;
  });
  expect(container.textContent).not.toContain("PRIVATE_ADDRESS_RECORD");
  await admit(gate);
  await eventually(() => expectPanel("addresses"));
  expect(ownerReads).toEqual([
    "/api/account",
    "/api/customer-addresses",
    "/api/account",
    "/api/customer-addresses",
  ]);
});

const field = (name: string) => {
  const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (input === null) {
    throw new Error(`Expected an address form with the ${name} field`);
  }
  return input;
};

it("adds an address, edits the latest revision and removes it after confirmation", async () => {
  addressRows = [];
  const commands: CustomerAddressCommand[] = [];
  const addressId = "new-address";
  addressWriter = (command) => {
    commands.push(command);
    addressRows =
      command.operation === "remove"
        ? []
        : [
            {
              id: addressId,
              isBillingDefault: false,
              isDeliveryDefault: false,
              location: { address: command.postalAddress, state: "available" },
              purposes: command.purposes,
              revision: command.operation === "add" ? 1 : command.revision + 1,
            },
          ];
    return Response.json({ outcome: "SAVED" });
  };
  await mount(
    <AccountView dictionary={dictionary} initial={initial} initialTab="addresses" locale="cs" />,
  );
  await eventually(() =>
    expect(container.textContent).toContain(dictionary.accountPage.emptyAddresses),
  );
  const labels = dictionary.accountPage.addressEditor;
  click(labels.add);
  field("addressLine1").value = "Testovací 10";
  field("city").value = "Praha";
  field("postalCode").value = "11000";
  act(() => {
    field("addressLine1").form?.requestSubmit();
  });
  await eventually(() => expect(container.textContent).toContain("Testovací 10"));

  click(labels.editAction);
  expect(field("addressLine1").value).toBe("Testovací 10");
  field("addressLine1").value = "Testovací 20";
  act(() => {
    field("addressLine1").form?.requestSubmit();
  });
  await eventually(() => expect(container.textContent).toContain("Testovací 20"));

  click(labels.removeAction);
  expect(commands).toHaveLength(2);
  await eventually(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
  const dialog = document.querySelector('[role="alertdialog"]');
  if (dialog === null) {
    throw new Error("Expected a confirmation dialog before deleting the address");
  }
  click(labels.remove, dialog);
  await eventually(() =>
    expect(container.textContent).toContain(dictionary.accountPage.emptyAddresses),
  );
  expect(commands).toMatchObject([
    { operation: "add", postalAddress: { addressLine1: "Testovací 10", countryCode: "CZ" } },
    {
      addressId,
      operation: "update",
      postalAddress: { addressLine1: "Testovací 20", countryCode: "CZ" },
      revision: 1,
    },
    { addressId, operation: "remove", revision: 2 },
  ]);
  expect(new Set(commands.map((command) => command.operationId)).size).toBe(3);
});
