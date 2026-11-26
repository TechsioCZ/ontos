// @rstest-environment happy-dom
import { setTimeout as nextTurn } from "node:timers/promises";
import "@app/shared-contracts/testing/http-double";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { CheckoutView } from "../src/features/checkout-view";
import { CartProvider } from "../src/features/cart-provider";
import { PortalSessionProvider } from "../src/features/auth-view";
import { cartStorageKey } from "../src/features/cart-state";
import { checkoutGuardKey } from "../src/features/checkout-guard";
import type { CheckoutGuard, CheckoutLockManager } from "../src/features/checkout-guard";
import { CheckoutRequestSchema } from "../src/ontos/checkout";
import type { CheckoutRecoverySchema, CheckoutResultSchema } from "../src/ontos/checkout";
import type { CheckoutOptions } from "../src/ontos/checkout-server";
import type { PortalOutcome } from "../src/ontos/portal";
import type { CustomerAddressesRead } from "../src/ontos/customer-addresses";
import type { CustomerProfileRead } from "../src/ontos/customer-profile";
import { getDictionary } from "../src/i18n";

const unexpectedNavigation = () => {
  throw new Error("Checkout must not navigate without a user action");
};
const router = {
  back: unexpectedNavigation,
  bfcacheId: "checkout-view",
  forward: unexpectedNavigation,
  prefetch: () => {},
  push: unexpectedNavigation,
  refresh: unexpectedNavigation,
  replace: unexpectedNavigation,
} satisfies AppRouterInstance;
const options = {
  countryCodes: ["CZ"],
  paymentAvailable: false,
  scope: {
    currency: "CZK",
    legalEntityId: "71000000-0000-4000-8000-000000000099",
    marketId: "market-cz",
    tenantId: "70000000-0000-4000-8000-000000000099",
  },
  shippingMethods: [{ id: "PPL", priceMinor: 12_900, title: "PPL" }],
  state: "ready",
} satisfies CheckoutOptions;
const d = getDictionary("cs");
const line = { expectedUnitPriceMinor: 100, productId: "p1", quantity: 1 };
const entry = {
  ...line,
  image: null,
  name: "Unverified cart item",
  sku: "P1",
  slug: "item",
  unit: "ks",
  variantName: "",
};
const guard = {
  clientRequestId: "71000000-0000-4000-8000-000000000096",
  lines: [line],
  scope: options.scope,
  version: 1,
} satisfies CheckoutGuard;
const confirmed = {
  issues: [],
  lines: [
    {
      lineTotalMinor: 100,
      name: "Saved owner item",
      productId: "p1",
      quantity: 1,
      sku: "P1",
      unitPriceMinor: 100,
    },
  ],
  orderId: "o1",
  orderNumber: "N1-1",
  outcome: "REPLAYED",
  receipt: null,
  scope: options.scope,
  shippingPriceMinor: 12_900,
  status: "NEW",
  totalMinor: 13_000,
  totalVatMinor: 2256,
} satisfies typeof CheckoutResultSchema.Encoded;
const requests: Request[] = [];
const ownerAdmission = {
  customerKey: "a".repeat(64),
  email: "owner@example.test",
  name: "Jan Novák",
  state: "admitted",
} satisfies PortalOutcome & { customerKey: string };
let admission: PortalOutcome = { state: "anonymous" };
const savedAddresses = {
  addresses: [
    {
      id: "delivery-home",
      isBillingDefault: false,
      isDeliveryDefault: true,
      label: "Home",
      location: {
        address: {
          addressLine1: "Saved street 1",
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
const ownerProfile = {
  profile: {
    contactEmail: "contact@example.test",
    displayName: "Jan Novák",
    phone: "+420123456789",
    version: "a".repeat(64),
  },
  state: "ready",
} satisfies CustomerProfileRead;
let addresses: CustomerAddressesRead = {
  addresses: [],
  state: "ready",
  viewerEmail: "owner@example.test",
};
let profile: CustomerProfileRead = ownerProfile;
let profileGate: Promise<Response> | null = null;
let recovery: typeof CheckoutRecoverySchema.Encoded = { state: "unconfirmed" };
let accountGate: Promise<Response> | null = null;
let recoveryGate: Promise<Response> | null = null;
let quoteGate: Promise<Response> | null = null;
let root: Root;
/** One browser's Web Locks: a second request for a held name is refused, as `ifAvailable` asks. */
const inMemoryLocks = (): CheckoutLockManager => {
  const held = new Set<string>();
  return {
    request: async (name, _options, onLock) => {
      if (held.has(name)) {
        return await onLock(null);
      }
      held.add(name);
      try {
        return await onLock({ mode: "exclusive", name });
      } finally {
        held.delete(name);
      }
    },
  };
};
let locks = inMemoryLocks();
let container: HTMLDivElement;
let previousInterceptor: typeof window.happyDOM.settings.fetch.interceptor;

// Public HTTP is answered in process and the tabs' Web Locks are an in-memory lock manager passed through the
// checkout's own `locks` prop (happy-dom has none); React, all hooks and both providers are real.
const fetchOwner = async (request: Request): Promise<Response> => {
  requests.push(request.clone());
  switch (new URL(request.url).pathname) {
    case "/api/account": {
      return await (accountGate ?? Promise.resolve(Response.json(admission)));
    }
    case "/api/customer-addresses": {
      return Response.json(addresses);
    }
    case "/api/customer-profile": {
      return await (profileGate ?? Promise.resolve(Response.json(profile)));
    }
    case "/api/checkout/status": {
      return await (recoveryGate ?? Promise.resolve(Response.json(recovery)));
    }
    case "/api/cart-quote": {
      const payload = await request.json();
      const { shipping } = payload;
      const shippingPriceMinor = shipping?.method === "PPL" ? 12_900 : 0;
      const result = {
        issues: [],
        outcome: "VALID",
        scope: options.scope,
        totalMinor: 100 + shippingPriceMinor,
        totalVatMinor: shippingPriceMinor === 0 ? 17 : 2256,
      };
      if (shipping !== undefined) {
        Object.assign(result, { shippingPriceMinor });
      }
      return Response.json(result);
    }
    case "/api/checkout": {
      if (quoteGate !== null) {
        return await quoteGate;
      }
      throw new Error("Unexpected checkout write");
    }
    default: {
      throw new Error(`Unexpected checkout HTTP request: ${request.url}`);
    }
  }
};
const seed = ({ edited = false, guarded = true } = {}) => {
  const savedEntry = { ...entry };
  if (edited) {
    Object.assign(savedEntry, { expectedUnitPriceMinor: 999, quantity: 2 });
  }
  window.localStorage.setItem(
    cartStorageKey(options.scope),
    JSON.stringify({
      entries: [savedEntry],
      scope: options.scope,
      version: 1,
    }),
  );
  if (guarded) {
    window.localStorage.setItem(checkoutGuardKey(options.scope), JSON.stringify(guard));
  }
};
const mount = async (checkoutOptions: CheckoutOptions = options) => {
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router}>
        <PortalSessionProvider>
          <CartProvider imageHosts={[]} scope={options.scope}>
            <CheckoutView dictionary={d} locale="cs" locks={locks} options={checkoutOptions} />
          </CartProvider>
        </PortalSessionProvider>
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
const button = (label: string) => {
  const result = [...container.querySelectorAll("button")].find(
    (control) => control.getAttribute("aria-label") === label || control.textContent === label,
  );
  if (result === undefined) {
    throw new Error(`Missing checkout button: ${label}`);
  }
  return result;
};
const amount = (label: string) =>
  [...container.querySelectorAll("dt")].find((term) => term.textContent === label)
    ?.nextElementSibling?.textContent;
const ordersLink = () => container.querySelector('a[href="/cs/ucet?tab=orders"]');
const expectConfirmed = () => {
  expect(container.querySelector("h1")?.textContent).toBe(d.checkout.previousOrder);
  expect(container.textContent).not.toContain(d.checkout.thankYou);
  expect(container.querySelector('button[type="submit"]')).toBeNull();
  expect(container.textContent).not.toContain(d.checkout.uncertain);
};

beforeEach(() => {
  requests.length = 0;
  admission = { state: "anonymous" };
  recovery = { state: "unconfirmed" };
  accountGate = null;
  recoveryGate = null;
  quoteGate = null;
  profileGate = null;
  profile = ownerProfile;
  addresses = { addresses: [], state: "ready", viewerEmail: "owner@example.test" };
  previousInterceptor = window.happyDOM.settings.fetch.interceptor;
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
  window.localStorage.clear();
  locks = inMemoryLocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  window.localStorage.clear();
  window.happyDOM.settings.fetch.interceptor = previousInterceptor;
});

const checkoutInput = (name: string) => {
  const control = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (control === null) {
    throw new Error(`Missing checkout input: ${name}`);
  }
  return control;
};
const editCheckoutFields = async (fields: Record<string, string>) => {
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (nativeValue?.set === undefined) {
    throw new Error("Native input value setter is unavailable");
  }
  await act(async () => {
    for (const [name, value] of Object.entries(fields)) {
      const control = checkoutInput(name);
      nativeValue.set?.call(control, value);
      control.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
};
const savedAddressTrigger = () => {
  const label = [...container.querySelectorAll("label")].find(
    (item) => item.textContent === d.checkout.savedAddresses.label,
  );
  const trigger =
    label === undefined
      ? null
      : container.querySelector<HTMLButtonElement>(
          `[role="combobox"][aria-labelledby="${label.id}"]`,
        );
  if (trigger === null) {
    throw new Error("Missing saved address selector");
  }
  return trigger;
};
const selectSavedAddress = async () => {
  await eventually(() => expect(savedAddressTrigger()).toBeDefined());
  await act(async () => savedAddressTrigger().click());
  await eventually(() => expect(document.querySelector('[role="option"]')).not.toBeNull());
  await act(async () => {
    const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
      item.textContent?.includes("Saved street 1"),
    );
    if (row === undefined) {
      throw new Error("Missing saved delivery address");
    }
    row.click();
  });
  await eventually(() => expect(checkoutInput("street").value).toBe("Saved street 1"));
};

const completeNextPurchase = async (cycle: number) => {
  await eventually(() => {
    expect(container.querySelector("h1")?.textContent).toBe(d.checkout.heading);
    expect(button(d.checkout.verify).disabled).toBe(false);
  });
  const form = container.querySelector("form");
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (form === null || nativeValue?.set === undefined) {
    throw new Error("Expected an editable checkout form");
  }
  await act(async () => {
    for (const [name, value] of Object.entries({
      city: "Praha",
      email: "buyer@example.test",
      firstName: "Jan",
      lastName: "Novák",
      postalCode: "11000",
      street: "Test 1",
    })) {
      const input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      nativeValue.set?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  quoteGate = Promise.resolve(
    Response.json({
      ...confirmed,
      orderId: null,
      orderNumber: null,
      outcome: "VALID",
      status: null,
    }),
  );
  await act(async () => form.requestSubmit());
  await eventually(() => expect(button(d.checkout.confirm).disabled).toBe(false));
  const result = {
    ...confirmed,
    orderId: `order-${cycle}`,
    orderNumber: `N1-${cycle + 2}`,
    outcome: "PLACED" as const,
  };
  quoteGate = Promise.resolve(Response.json(result));
  recovery = { result, state: "confirmed" };
  await act(async () => form.requestSubmit());
  await eventually(() =>
    expect(container.querySelector("h1")?.textContent).toBe(d.checkout.confirmed),
  );
  const guardValue = JSON.parse(
    window.localStorage.getItem(checkoutGuardKey(options.scope)) ?? "{}",
  );
  const submittedId: string = guardValue.clientRequestId;
  expect(window.localStorage.getItem(cartStorageKey(options.scope))).toBeNull();
  await act(async () => root.unmount());
  root = createRoot(container);
  seed({ guarded: false });
  quoteGate = null;
  await mount();
  return submittedId;
};

describe("checkout through public session, cart and owner boundaries", () => {
  it("shows owner-confirmed totals before contact entry and still requires explicit checkout verification", async () => {
    seed({ guarded: false });
    await mount();
    await eventually(() => {
      expect(amount(d.checkout.total)).toBe("130\u00A0Kč");
      expect(amount(d.checkout.netIncludesShipping)).toBe("107,44\u00A0Kč");
      expect(amount(d.shopping.vat)).toBe("22,56\u00A0Kč");
      expect(amount(d.checkout.shippingIncluded)).toBe("129\u00A0Kč");
    });
    expect(checkoutInput("email").value).toBe("");
    expect(checkoutInput("firstName").value).toBe("");
    expect(button(d.checkout.verify).disabled).toBe(false);
    expect(container.querySelector(`button[aria-label="${d.checkout.confirm}"]`)).toBeNull();
    expect(
      requests.filter((request) => new URL(request.url).pathname === "/api/checkout"),
    ).toHaveLength(0);
    const previews = await Promise.all(
      requests
        .filter((request) => new URL(request.url).pathname === "/api/cart-quote")
        .map((request) => request.json()),
    );
    expect(previews).toContainEqual({
      lines: [line],
      locale: "cs",
      scope: options.scope,
      shipping: { expectedPriceMinor: 12_900, method: "PPL" },
    });
    await editCheckoutFields({
      city: "Praha",
      email: "buyer@example.test",
      firstName: "Jan",
      lastName: "Novák",
      postalCode: "11000",
      street: "Test 1",
    });
    quoteGate = Promise.resolve(
      Response.json({
        ...confirmed,
        orderId: null,
        orderNumber: null,
        outcome: "VALID",
        status: null,
      }),
    );
    await act(async () => container.querySelector("form")?.requestSubmit());
    await eventually(() => expect(button(d.checkout.confirm).disabled).toBe(false));
    const writes = await Promise.all(
      requests
        .filter((request) => new URL(request.url).pathname === "/api/checkout")
        .map((request) => request.json()),
    );
    expect(writes.map((payload) => payload.mode)).toEqual(["quote"]);
    expect(window.localStorage.getItem(checkoutGuardKey(options.scope))).toBeNull();
  });

  it("refreshes checkout preview totals for the selected shipping method before contact entry", async () => {
    seed({ guarded: false });
    await mount({
      ...options,
      shippingMethods: [
        ...options.shippingMethods,
        { id: "OSOBNI_ODBER", priceMinor: 0, title: "Pickup" },
      ],
    });
    await eventually(() => expect(amount(d.checkout.total)).toBe("130\u00A0Kč"));
    const pickup = container.querySelector<HTMLInputElement>(
      'input[name="shippingMethod"][value="OSOBNI_ODBER"]',
    );
    if (pickup === null) {
      throw new Error("Missing pickup shipping option");
    }
    await act(async () => pickup.click());
    await eventually(() => {
      expect(amount(d.checkout.total)).toBe("1\u00A0Kč");
      expect(amount(d.checkout.netIncludesShipping)).toBe("0,83\u00A0Kč");
      expect(amount(d.shopping.vat)).toBe("0,17\u00A0Kč");
      expect(amount(d.checkout.shippingIncluded)).toBe("0\u00A0Kč");
    });
    const previews = await Promise.all(
      requests
        .filter((request) => new URL(request.url).pathname === "/api/cart-quote")
        .map((request) => request.json()),
    );
    expect(previews).toContainEqual({
      lines: [line],
      locale: "cs",
      scope: options.scope,
      shipping: { expectedPriceMinor: 0, method: "OSOBNI_ODBER" },
    });
    expect(checkoutInput("email").value).toBe("");
    expect(
      requests.filter((request) => new URL(request.url).pathname === "/api/checkout"),
    ).toHaveLength(0);
  });

  it.each(["focus", "visibilitychange"])(
    "retains selected address and edited contact fields after same-customer %s refresh",
    async (event) => {
      seed({ guarded: false });
      admission = { ...ownerAdmission };
      addresses = savedAddresses;
      await mount();
      await selectSavedAddress();
      const edited = {
        email: "order@example.test",
        firstName: "Eva",
        lastName: "Kupující",
        phone: "+420987654321",
      };
      await editCheckoutFields(edited);
      const response = Promise.withResolvers<Response>();
      accountGate = response.promise;
      await act(async () => {
        (event === "focus" ? window : document).dispatchEvent(new Event(event));
      });
      await eventually(() =>
        expect(
          requests.filter((request) => new URL(request.url).pathname === "/api/account"),
        ).toHaveLength(2),
      );
      await act(async () => response.resolve(Response.json({ ...admission })));
      await eventually(() => {
        for (const [name, value] of Object.entries(edited)) {
          expect(checkoutInput(name).value).toBe(value);
        }
        expect(checkoutInput("street").value).toBe("Saved street 1");
        expect(checkoutInput("city").value).toBe("Praha");
        expect(checkoutInput("postalCode").value).toBe("11000");
        expect(savedAddressTrigger().textContent).toContain("Saved street 1");
      });
    },
  );

  it("retains manually entered contact and postal fields after same-customer refresh", async () => {
    seed({ guarded: false });
    admission = { ...ownerAdmission };
    await mount();
    await eventually(() => expect(button(d.checkout.verify).disabled).toBe(false));
    const edited = {
      city: "Brno",
      email: "order@example.test",
      firstName: "Eva",
      lastName: "Kupující",
      postalCode: "60200",
      street: "Manual street 2",
    };
    await editCheckoutFields(edited);
    const response = Promise.withResolvers<Response>();
    accountGate = response.promise;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => response.resolve(Response.json({ ...admission })));
    await eventually(() => {
      for (const [name, value] of Object.entries(edited)) {
        expect(checkoutInput(name).value).toBe(value);
      }
    });
  });

  it.each(["anonymous", "other-customer", "same-display-customer"])(
    "clears previous customer's edited checkout data when refresh resolves to %s",
    async (nextActor) => {
      seed({ guarded: false });
      admission = { ...ownerAdmission };
      addresses = savedAddresses;
      await mount();
      await selectSavedAddress();
      const edited = {
        email: "private@example.test",
        firstName: "Private",
        lastName: "Buyer",
        phone: "+420987654321",
        street: "Private street 2",
      };
      await editCheckoutFields(edited);
      const nextAdmission =
        nextActor === "same-display-customer"
          ? { ...ownerAdmission, customerKey: "b".repeat(64) }
          : {
              ...ownerAdmission,
              customerKey: "b".repeat(64),
              email: "other@example.test",
              name: "Petr Nový",
            };
      admission = nextActor === "anonymous" ? { state: "anonymous" } : nextAdmission;
      addresses = { addresses: [], state: "ready", viewerEmail: nextAdmission.email };
      profile =
        nextActor === "anonymous"
          ? { state: "anonymous" }
          : {
              ...ownerProfile,
              profile: {
                ...ownerProfile.profile,
                contactEmail: nextAdmission.email,
                displayName: nextAdmission.name,
              },
            };
      await act(async () => window.dispatchEvent(new Event("focus")));
      await eventually(() => {
        expect(button(d.checkout.verify).disabled).toBe(false);
        for (const [name, value] of Object.entries({
          ...edited,
          city: "Praha",
          postalCode: "11000",
        })) {
          expect(checkoutInput(name).value).not.toBe(value);
        }
      });
      await editCheckoutFields({ email: "fresh-order@example.test" });
      expect(checkoutInput("email").disabled).toBe(false);
      expect(checkoutInput("email").readOnly).toBe(false);
      expect(checkoutInput("email").value).toBe("fresh-order@example.test");
    },
  );

  it("prefills editable checkout contact details from the admitted customer's profile", async () => {
    seed({ guarded: false });
    admission = { ...ownerAdmission };
    await mount();
    await eventually(() => {
      expect(checkoutInput("email").value).toBe("contact@example.test");
      expect(checkoutInput("firstName").value).toBe("Jan");
      expect(checkoutInput("lastName").value).toBe("Novák");
    });
    await editCheckoutFields({
      email: "order@example.test",
      firstName: "Eva",
      lastName: "Kupující",
    });
    expect(checkoutInput("email").value).toBe("order@example.test");
    expect(checkoutInput("firstName").value).toBe("Eva");
    expect(checkoutInput("lastName").value).toBe("Kupující");
  });

  it("fills only untouched contact fields when the customer profile arrives after editing", async () => {
    seed({ guarded: false });
    admission = { ...ownerAdmission };
    const response = Promise.withResolvers<Response>();
    profileGate = response.promise;
    await mount();
    await eventually(() => expect(button(d.checkout.verify).disabled).toBe(false));
    await editCheckoutFields({ email: "order@example.test", firstName: "Eva" });
    await act(async () => response.resolve(Response.json(ownerProfile)));
    await eventually(() => {
      expect(checkoutInput("email").value).toBe("order@example.test");
      expect(checkoutInput("firstName").value).toBe("Eva");
      expect(checkoutInput("lastName").value).toBe("Novák");
    });
  });

  it("keeps checkout confirmation when a delayed profile cannot change edited contact fields", async () => {
    seed({ guarded: false });
    admission = { ...ownerAdmission };
    const response = Promise.withResolvers<Response>();
    profileGate = response.promise;
    await mount();
    await eventually(() => expect(button(d.checkout.verify).disabled).toBe(false));
    const editedContact = {
      email: "order@example.test",
      firstName: "Eva",
      lastName: "Kupující",
      phone: "+420987654321",
    };
    await editCheckoutFields({
      ...editedContact,
      city: "Praha",
      postalCode: "11000",
      street: "Test 1",
    });
    quoteGate = Promise.resolve(
      Response.json({
        ...confirmed,
        orderId: null,
        orderNumber: null,
        outcome: "VALID",
        status: null,
      }),
    );
    await act(async () => container.querySelector("form")?.requestSubmit());
    await eventually(() => expect(button(d.checkout.confirm).disabled).toBe(false));
    await act(async () => {
      response.resolve(Response.json(ownerProfile));
      await nextTurn(0);
    });
    await eventually(() => {
      expect(button(d.checkout.confirm).disabled).toBe(false);
      for (const [field, value] of Object.entries(editedContact)) {
        expect(checkoutInput(field).value).toBe(value);
      }
    });
  });

  it.each([true, false])(
    "starts a new checkout after confirming a saved previous order (edited: %s)",
    async (edited) => {
      seed({ edited });
      recovery = { result: confirmed, state: "confirmed" };
      const editedCart = window.localStorage.getItem(cartStorageKey(options.scope));
      await mount();
      await eventually(() => {
        expect(container.querySelector("h1")?.textContent).toBe(d.checkout.heading);
        expect(container.querySelector("form")).not.toBeNull();
      });
      expect(window.localStorage.getItem(checkoutGuardKey(options.scope))).toBeNull();
      expect(window.localStorage.getItem(cartStorageKey(options.scope))).toBe(editedCart);
      expect(
        requests.filter((request) => new URL(request.url).pathname === "/api/checkout"),
      ).toHaveLength(0);
    },
  );

  it("allows two further checkout submissions after a legacy receipt, including identical cart lines", async () => {
    seed();
    recovery = { result: confirmed, state: "confirmed" };
    await mount();
    const firstSubmission = await completeNextPurchase(0);
    const secondSubmission = await completeNextPurchase(1);
    const submittedIds = [firstSubmission, secondSubmission];
    await eventually(() => expect(button(d.checkout.verify).disabled).toBe(false));
    expect(new Set(submittedIds).size).toBe(2);
    expect(submittedIds).not.toContain(guard.clientRequestId);
    const writes = await Promise.all(
      requests
        .filter((request) => new URL(request.url).pathname === "/api/checkout")
        .map((request) => request.json()),
    );
    expect(writes.map((payload) => payload.mode)).toEqual(["quote", "place", "quote", "place"]);
    expect(window.localStorage.getItem(checkoutGuardKey(options.scope))).toBeNull();
  });

  it("keeps an uncertain persisted order blocked until a recovery read confirms it", async () => {
    seed();
    await mount();
    await eventually(() => {
      expect(button(d.checkout.checkResult).disabled).toBe(false);
      expect(container.textContent).toContain(d.checkout.uncertain);
    });
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toContain(d.shopping.empty);
    expect(window.localStorage.getItem(checkoutGuardKey(options.scope))).toBe(
      JSON.stringify(guard),
    );
    recovery = { result: confirmed, state: "confirmed" };
    await act(async () => {
      button(d.checkout.checkResult).click();
    });
    await eventually(expectConfirmed);
    expect(amount(d.checkout.total)).toBe("130\u00A0Kč");
    expect(amount(d.checkout.netIncludesShipping)).toBe("107,44\u00A0Kč");
    expect(amount(d.shopping.vat)).toBe("22,56\u00A0Kč");
    expect(ordersLink()).toBeNull();
    expect(window.localStorage.getItem(cartStorageKey(options.scope))).not.toBeNull();
    expect(window.localStorage.getItem(checkoutGuardKey(options.scope))).toBe(
      JSON.stringify(guard),
    );
    expect(
      requests.filter((request) => new URL(request.url).pathname === "/api/checkout"),
    ).toHaveLength(0);
    const reads = requests.filter(
      (request) => new URL(request.url).pathname === "/api/checkout/status",
    );
    expect(reads).toHaveLength(2);
    expect(await reads[1]?.json()).toEqual({
      clientRequestId: guard.clientRequestId,
      locale: "cs",
      scope: options.scope,
    });
  });

  it("preserves confirmed prices and an edited cart while receipt enrichment fails, then succeeds", async () => {
    seed({ edited: true });
    await mount();
    await eventually(() => expect(button(d.checkout.checkResult).disabled).toBe(false));
    recovery = { result: confirmed, state: "confirmed" };
    await act(async () => button(d.checkout.checkResult).click());
    await eventually(expectConfirmed);
    expect(container.textContent).toContain(d.checkout.cartPreserved);
    expect(container.textContent).toContain("Saved owner item");
    const retainedCart = window.localStorage.getItem(cartStorageKey(options.scope));
    const response = Promise.withResolvers<Response>();
    recoveryGate = response.promise;
    await act(async () => {
      button(d.checkout.loadReceipt).click();
    });
    expectConfirmed();
    expect(container.textContent).not.toContain(d.checkout.loadReceipt);
    expect(amount(d.checkout.total)).toBe("130\u00A0Kč");
    await act(async () => {
      response.resolve(Response.json({ state: "unconfirmed" }));
    });
    await eventually(() => {
      expectConfirmed();
      expect(button(d.checkout.loadReceipt).disabled).toBe(false);
      expect(container.textContent).toContain(d.checkout.unavailable);
    });
    recoveryGate = null;
    recovery = {
      result: {
        ...confirmed,
        receipt: {
          contact: { email: "buyer@example.test", name: "Saved buyer" },
          createdAt: "2026-11-09T12:00:00.000Z",
          deliveryAddress: {
            city: "Praha",
            country: "CZ",
            postalCode: "11000",
            street: "Saved street 1",
          },
          shippingMethod: "PPL",
        },
      },
      state: "confirmed",
    };
    await act(async () => {
      button(d.checkout.loadReceipt).click();
    });
    await eventually(() => {
      expectConfirmed();
      expect(container.textContent).toContain("Saved street 1");
      expect(container.textContent).not.toContain(d.checkout.loadReceipt);
    });
    expect(amount(d.checkout.total)).toBe("130\u00A0Kč");
    expect(window.localStorage.getItem(cartStorageKey(options.scope))).toBe(retainedCart);
  });

  it("hides account navigation during real session revalidation and after admission is lost", async () => {
    seed();
    window.localStorage.removeItem(cartStorageKey(options.scope));
    admission = { email: "owner@example.test", name: "Owner", state: "admitted" };
    recovery = { result: confirmed, state: "confirmed" };
    await mount();
    await eventually(() => {
      expectConfirmed();
      expect(ordersLink()).not.toBeNull();
    });
    const response = Promise.withResolvers<Response>();
    accountGate = response.promise;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(ordersLink()).toBeNull();
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    await act(async () => {
      response.resolve(Response.json({ state: "anonymous" }));
    });
    await eventually(expectConfirmed);
    expect(ordersLink()).toBeNull();
    expect(window.localStorage.getItem(checkoutGuardKey(options.scope))).toBe(
      JSON.stringify(guard),
    );
  });

  it("disables checkout during an actual quote and never offers placement from a refused price", async () => {
    seed({ guarded: false });
    const response = Promise.withResolvers<Response>();
    quoteGate = response.promise;
    await mount();
    await eventually(() => {
      expect(button(d.checkout.verify).disabled).toBe(false);
    });
    const form = container.querySelector("form");
    if (form === null) {
      throw new Error("Expected the loaded checkout form");
    }
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (nativeValue?.set === undefined) {
      throw new Error("Native input value setter is unavailable");
    }
    await act(async () => {
      for (const [name, value] of Object.entries({
        city: "Praha",
        email: "buyer@example.test",
        firstName: "Jan",
        lastName: "Novák",
        postalCode: "11000",
        street: "Test 1",
      })) {
        const input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
        if (input === null) {
          throw new TypeError(`Missing checkout input: ${name}`);
        }
        nativeValue.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    expect(form.checkValidity()).toBe(true);
    await act(async () => {
      form.requestSubmit();
    });
    await eventually(() => {
      expect(button(d.checkout.checking).disabled).toBe(true);
      expect(button(d.checkout.checking).getAttribute("aria-busy")).toBe("true");
      expect(
        requests.filter((request) => new URL(request.url).pathname === "/api/checkout"),
      ).toHaveLength(1);
    });
    // No way back to the cart while the owner is answering: the link becomes a disabled button.
    expect(container.querySelector('a[href="/cs/kosik"]')).toBeNull();
    expect(button(d.checkout.back).disabled).toBe(true);
    await act(async () => {
      response.resolve(
        Response.json({
          ...confirmed,
          issues: [{ code: "PRICE_CHANGED", productId: "p1" }],
          lines: [],
          orderId: null,
          orderNumber: null,
          outcome: "REJECTED",
          shippingPriceMinor: null,
          status: null,
          totalMinor: null,
          totalVatMinor: null,
        }),
      );
    });
    await eventually(() => {
      expect(button(d.checkout.verify).disabled).toBe(false);
      expect(container.textContent).toContain(d.checkout.rejected);
    });
    expect(container.querySelector('a[href="/cs/kosik"]')).not.toBeNull();
    expect(container.querySelector(`button[aria-label="${d.checkout.confirm}"]`)).toBeNull();
    expect(amount(d.checkout.total)).toBe(d.shopping.unresolved);
    expect(window.localStorage.getItem(checkoutGuardKey(options.scope))).toBeNull();
    const write = requests.find((request) => new URL(request.url).pathname === "/api/checkout");
    const sent = Schema.decodeUnknownSync(CheckoutRequestSchema)(await write?.json());
    expect(sent.mode).toBe("quote");
    expect(sent.lines).toEqual([line]);
  });

  it("never calls corrupt saved order storage an empty cart or permits submission", async () => {
    window.localStorage.setItem(checkoutGuardKey(options.scope), "not-json");
    await mount();
    await eventually(() => {
      expect(container.textContent).toContain(d.checkout.storage);
    });
    expect(container.textContent).not.toContain(d.shopping.empty);
    expect(container.querySelector('a[href="/cs"]')).toBeNull();
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    expect(window.localStorage.getItem(checkoutGuardKey(options.scope))).toBe("not-json");
  });
});
