import type { ReactNode } from "react";
import { getDictionary } from "@/i18n";
import { getCatalog } from "@/ontos/catalog";
import { StorefrontShell } from "@/features/shell";
import { CartProvider } from "@/features/cart-provider";
import { PortalSessionProvider } from "@/features/auth-view";
import { RequiredLabelProvider } from "@/features/form-controls";
import { getCartScope } from "@/ontos/cart-quote-server";
import { storefrontRuntime } from "@/ontos/runtime";
import { withOwnerOperation } from "@/ontos/owner-operation";
import { createSharedRead } from "@/ontos/shared-read";
import { Effect } from "effect";

export const dynamic = "force-dynamic";

type CartScope = Effect.Success<ReturnType<typeof getCartScope>>;
const sharedRead = createSharedRead<CartScope | null>();

const LocaleLayout = async ({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) => {
  const { locale } = await params;
  const dictionary = getDictionary(locale);
  const [result, scope] = await Promise.all([
    getCatalog(locale, JSON.stringify({ featured: true })),
    // The market's cart scope (tenant, market, currency) is the same for every shopper: shared for a minute.
    sharedRead(
      `cart-scope:${locale}`,
      60_000,
      async (operation) =>
        await storefrontRuntime.runPromise(
          withOwnerOperation(getCartScope(locale), { operation }).pipe(
            Effect.match({ onFailure: () => null, onSuccess: (value) => value }),
          ),
        ),
      { keep: (value) => value !== null, stale: true },
    ),
  ]);
  const imageHosts = (process.env.STOREFRONT_IMAGE_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  const demoNotice =
    locale === "en"
      ? "Sales demo: nothing is paid or delivered. Orders are demo-only."
      : "Demo prodejní ukázka: nic se neplatí ani nedoručuje. Objednávky jsou pouze ukázkové.";
  return (
    <CartProvider imageHosts={imageHosts} key={JSON.stringify(scope)} locale={locale} scope={scope}>
      <PortalSessionProvider>
        <p className="bg-black px-4 py-2 text-center text-sm font-medium text-white" role="note">
          {demoNotice}
        </p>
        <RequiredLabelProvider requiredLabel={dictionary.requiredLabel}>
          <StorefrontShell
            categories={result.state === "ready" ? result.catalog.categories : []}
            dictionary={dictionary}
            locale={locale}
          >
            {children}
          </StorefrontShell>
        </RequiredLabelProvider>
      </PortalSessionProvider>
    </CartProvider>
  );
};

export default LocaleLayout;
