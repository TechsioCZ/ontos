import { cleanup, render, screen } from "@testing-library/react";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { afterEach, expect, it, vi } from "vitest";
import EmailVerificationPage from "@/app/overeni-emailu/page";
import { CartProvider } from "@/features/cart/cart-provider";
import { CatalogProvider } from "@/ontos/catalog-provider";

// Exercise the real providers, not the legacy suite-wide catalog substitution.
vi.unmock("@/ontos/catalog-provider");
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
  const page = await EmailVerificationPage({ searchParams: Promise.resolve({ stav }) });
  render(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/overeni-emailu">
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
  );
}

it("explains successful verification in Czech and offers the real login page", async () => {
  await landing("overeno");
  expect(screen.getByRole("heading", { name: "E-mail byl ověřen" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Poslat ověřovací e-mail znovu" })).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Nyní se můžete přihlásit");
  expect(screen.getByRole("link", { name: "Přejít k přihlášení" }).getAttribute("href")).toBe(
    "/prihlaseni",
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
      "/kontakty",
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
