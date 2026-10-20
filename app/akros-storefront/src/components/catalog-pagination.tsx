"use client";

import NextLink from "next/link";
import { createPaginationGetPageUrl, Pagination } from "@techsio/ui-kit/molecules/pagination";

import { cs } from "@/i18n/cs";

export function CatalogPagination({
  currentPage,
  itemCount,
  pageSize,
  pathname,
  searchParams,
}: {
  currentPage: number;
  itemCount: number;
  pageSize: number;
  pathname: string;
  searchParams?: Record<string, string>;
}) {
  const totalPages = Math.ceil(itemCount / pageSize);
  if (totalPages <= 1) return null;

  const getPageUrl = createPaginationGetPageUrl({
    pathname,
    searchParams: searchParams && new URLSearchParams(searchParams),
  });

  return (
    <Pagination
      className="akros-pagination akros-catalog-pagination"
      count={itemCount}
      getPageUrl={getPageUrl}
      linkAs={NextLink}
      page={currentPage}
      pageSize={pageSize}
      size="sm"
      translations={{
        itemLabel: ({ page, totalPages: pages }) => cs.pagination.page(page, pages),
        nextTriggerLabel: cs.pagination.next,
        prevTriggerLabel: cs.pagination.previous,
        rootLabel: cs.pagination.label,
      }}
      variant="filled"
    />
  );
}
