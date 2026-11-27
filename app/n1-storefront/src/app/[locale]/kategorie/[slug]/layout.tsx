import type { ReactNode } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getCatalog } from "@/ontos/catalog";

/**
 * Outside this segment's loading boundary: a document request for a category the market does not list
 * answers 404 before the loading shell streams a 200. Soft navigations and prefetches skip it.
 */
const CategoryLayout = async ({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string; slug: string }>;
}) => {
  const requestHeaders = await headers();
  if (requestHeaders.get("x-n1-document") === "1") {
    const { locale, slug } = await params;
    const result = await getCatalog(locale, JSON.stringify({ categorySlug: slug, page: 1 }));
    if (
      result.state === "ready" &&
      result.catalog.configured &&
      !result.catalog.categories.some((item) => item.slug === slug)
    ) {
      notFound();
    }
  }
  return await children;
};

export default CategoryLayout;
