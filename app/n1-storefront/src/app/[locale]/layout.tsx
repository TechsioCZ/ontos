import type { ReactNode } from "react";
import { getDictionary } from "@/i18n";
import { getCatalog } from "@/ontos/catalog";
import { StorefrontShell } from "@/features/shell";

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
  const result = await getCatalog(locale, JSON.stringify({ featured: true }));
  return (
    <StorefrontShell
      categories={result.state === "ready" ? result.catalog.categories : []}
      dictionary={dictionary}
      locale={locale}
    >
      {children}
    </StorefrontShell>
  );
};

export default LocaleLayout;
