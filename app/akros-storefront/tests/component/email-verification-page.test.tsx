import { cleanup, render, screen } from "@testing-library/react";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { afterEach, expect, it } from "vitest";
import EmailVerificationPage from "@/app/overeni-emailu/page";
import { CartProvider } from "@/features/cart/cart-provider";
import { CatalogProvider } from "@/ontos/catalog-provider";
import { nextRequest } from "../support/next-request";
import { StorefrontProviders } from "../support/storefront";

afterEach(cleanup);

const unexpectedNavigation = (): never => {
  throw new Error("Unexpected navigation");
};
const router = {
  bfcacheId: "verification-landing",
  back: unexpectedNavigation,
  forward: unexpectedNavigation,
  refresh: unexpectedNavigation,
  hmrRefresh: unexpectedNavigation,
  push: unexpectedNavigation,
  replace: unexpectedNavigation,
  prefetch: unexpectedNavigation,
};

async function landing(stav?: string | string[]) {
  const request = nextRequest("http://shop.test/cs/overeni-emailu", {
    headers: { "x-akros-market-locale": "cs" },
  });
  try {
    const page = await request.run(() =>
      EmailVerificationPage({ searchParams: Promise.resolve({ stav }) }),
    );
    render(
      <AppRouterContext.Provider value={router}>
        <PathnameContext.Provider value="/cs/overeni-emailu">
          <CatalogProvider
            snapshot={{
              catalog: { products: [], homepageFeaturedProductIds: [] },
              categories: { categories: [] },
            }}
          >
            <CartProvider storage={null}>{page}</CartProvider>
          </CatalogProvider>
        </PathnameContext.Provider>
      </AppRouterContext.Provider>,
      { wrapper: StorefrontProviders },
    );
  } finally {
    await request.close();
  }
}

it("explains successful verification in Czech and offers the real login page", async () => {
  await landing("overeno");
  expect(screen.getByRole("heading", { name: "E-mail byl ověřen" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Poslat ověřovací e-mail znovu" })).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Nyní se můžete přihlásit");
  expect(screen.getByRole("link", { name: "Přejít k přihlášení" }).getAttribute("href")).toBe(
    "/cs/prihlaseni",
  );
});

it.each([undefined, "neplatne", "unknown", ["overeno", "neplatne"]])(
  "never presents missing, invalid or ambiguous verification status %j as success",
  async (status) => {
    await landing(status);
    expect(screen.getByRole("heading", { name: "E-mail nebyl ověřen" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("platnost vypršela");
    expect(screen.getByRole("button", { name: "Poslat ověřovací e-mail znovu" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Kontaktovat podporu" }).getAttribute("href")).toBe(
      "/cs/kontakty",
    );
  },
);

it.each([
  ["nedostupne", "dočasně nedostupné"],
  ["limit", "Příliš mnoho pokusů"],
  ["podpora", "kontaktujte naši podporu"],
])("gives an actionable Czech message for %s", async (status, message) => {
  await landing(status);
  expect(screen.getByRole("status").textContent).toContain(message);
  expect(screen.queryByRole("heading", { name: "E-mail byl ověřen" })).toBeNull();
});
