import { beforeEach, expect, it, rs } from "@rstest/core";
import { renderToStaticMarkup } from "react-dom/server";
import { Schema } from "effect";
import { AccountView } from "../src/features/account-view";
import { CustomerOrderDetailView } from "../src/features/customer-order-detail";
import { getDictionary } from "../src/i18n";
import type { CustomerProfile, CustomerProfilePageState } from "../src/ontos/customer-profile";
import { CustomerOrderSchema } from "../src/ontos/customer-orders";
import type { CustomerOrdersView } from "../src/ontos/customer-orders";

const session = rs.hoisted(() => ({ pending: false, refresh: rs.fn(), run: rs.fn() }));

rs.mock("next/navigation", () => ({ useRouter: () => ({ refresh: session.refresh }) }));
rs.mock("../src/features/auth-view", () => ({
  usePortalAuth: () => ({
    loaded: true,
    outcome: { email: "owner@example.test", name: "PRIVATE_SESSION_NAME", state: "admitted" },
    pending: session.pending,
    run: session.run,
  }),
}));
rs.mock("../src/features/customer-profile-form", () => ({
  CustomerProfileForm: ({ profile }: { profile: CustomerProfile }) => (
    <p>
      {profile.displayName} {profile.contactEmail} {profile.phone}
    </p>
  ),
}));
rs.mock("../src/features/customer-orders-panel", () => ({
  CustomerOrdersPanel: () => <p>PRIVATE_ORDER_RECORD</p>,
  CustomerOrderStatus: () => <span>PRIVATE_ORDER_STATUS</span>,
}));
rs.mock("../src/features/customer-addresses-panel", () => ({
  CustomerAddressesPanel: () => <p>PRIVATE_ADDRESS_RECORD</p>,
}));

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
        preview: [],
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

beforeEach(() => {
  session.pending = false;
  rs.clearAllMocks();
});

for (const tab of ["profile", "orders", "addresses"] as const) {
  it(`hides all private account panels while session revalidation is pending on ${tab}`, () => {
    session.pending = true;
    const html = renderToStaticMarkup(
      <AccountView dictionary={dictionary} initial={initial} initialTab={tab} locale="cs" />,
    );
    expect(html).toContain(dictionary.accountPage.loading);
    for (const privateValue of [
      "private-contact@example.test",
      "PRIVATE_PROFILE_NAME",
      "+420777123456",
      "PRIVATE_ORDER_RECORD",
      "PRIVATE_ADDRESS_RECORD",
      "PRIVATE_SESSION_NAME",
    ]) {
      expect(html).not.toContain(privateValue);
    }
    expect(html).not.toContain('role="tablist"');
  });
}

for (const control of [
  { content: "private-contact@example.test", tab: "profile" as const },
  { content: "PRIVATE_ORDER_RECORD", tab: "orders" as const },
]) {
  it(`shows the verified own ${control.tab} panel after session revalidation`, () => {
    const html = renderToStaticMarkup(
      <AccountView
        dictionary={dictionary}
        initial={initial}
        initialTab={control.tab}
        locale="cs"
      />,
    );
    expect(html).toContain(control.content);
    expect(html).not.toContain(dictionary.accountPage.loading);
  });
}

it("hides the actual order detail and contact/address PII while session revalidation is pending", () => {
  session.pending = true;
  const html = renderToStaticMarkup(
    <CustomerOrderDetailView dictionary={dictionary} initial={orderInitial} locale="cs" />,
  );
  expect(html).toContain(dictionary.accountPage.loading);
  for (const privateValue of [
    "PRIVATE_ORDER_NUMBER",
    "PRIVATE_ORDER_STREET",
    "private-order-contact@example.test",
    "PRIVATE_ORDER_BUYER",
    "PRIVATE_ORDER_NOTE",
  ]) {
    expect(html).not.toContain(privateValue);
  }
});

it("shows the actual verified own order detail after session revalidation", () => {
  const html = renderToStaticMarkup(
    <CustomerOrderDetailView dictionary={dictionary} initial={orderInitial} locale="cs" />,
  );
  expect(html).not.toContain(dictionary.accountPage.loading);
  for (const privateValue of [
    "PRIVATE_ORDER_NUMBER",
    "PRIVATE_ORDER_STREET",
    "private-order-contact@example.test",
    "PRIVATE_ORDER_BUYER",
    "PRIVATE_ORDER_NOTE",
  ]) {
    expect(html).toContain(privateValue);
  }
});
