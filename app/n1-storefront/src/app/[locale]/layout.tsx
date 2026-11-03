import type { ReactNode } from "react";
import { getDictionary } from "@/i18n";
import { getCatalog } from "@/ontos/catalog";
import { StorefrontShell } from "@/features/shell";
import { CartProvider } from "@/features/cart-provider";
import { PortalSessionProvider } from "@/features/auth-view";
import { getCartScope } from "@/ontos/cart-quote-server";
import { storefrontRuntime } from "@/ontos/runtime";
import { Effect } from "effect";

export const dynamic = "force-dynamic";

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
    storefrontRuntime.runPromise(
      getCartScope(locale).pipe(
        Effect.match({ onFailure: () => null, onSuccess: (value) => value }),
      ),
    ),
  ]);
  const imageHosts = (process.env.STOREFRONT_IMAGE_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return (
    <CartProvider imageHosts={imageHosts} key={JSON.stringify(scope)} scope={scope}>
      <PortalSessionProvider>
        <StorefrontShell
          categories={result.state === "ready" ? result.catalog.categories : []}
          dictionary={dictionary}
          locale={locale}
        >
          {children}
        </StorefrontShell>
      </PortalSessionProvider>
    </CartProvider>
  );
};

export default LocaleLayout;
