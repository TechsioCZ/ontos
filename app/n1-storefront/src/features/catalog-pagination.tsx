"use client";

import NextLink from "next/link";
import { Pagination, createPaginationGetPageUrl } from "@techsio/ui-kit/molecules/pagination";
import type { Dictionary } from "@/i18n";

/** Real owner pagination, preserving the current query and using compact links on narrow screens. */
export const CatalogPagination = ({
  count,
  dictionary: d,
  mobileAlignment = "end",
  page,
  pageSize,
  pathname,
  query = "",
}: {
  count: number;
  dictionary: Dictionary;
  mobileAlignment?: "start" | "end";
  page: number;
  pageSize: number;
  pathname: string;
  query?: string;
}) => {
  if (count <= pageSize) {
    return null;
  }
  const getPageUrl = createPaginationGetPageUrl({ pathname, searchParams: query });
  const translations = {
    itemLabel: ({ page: target }: { page: number }) => `${d.page} ${target}`,
    nextTriggerLabel: d.next,
    prevTriggerLabel: d.previous,
  };
  return (
    <div
      className={
        mobileAlignment === "start"
          ? "flex justify-start pt-8 md:justify-end"
          : "flex justify-end pt-8"
      }
    >
      <div className="n1-compact:hidden">
        <Pagination
          aria-label={d.page}
          compact
          compactLabel={({ page: current, totalPages }) => `${current} / ${totalPages}`}
          count={count}
          getPageUrl={getPageUrl}
          linkAs={NextLink}
          page={page}
          pageSize={pageSize}
          size="sm"
          translations={translations}
          variant="filled"
        />
      </div>
      <div className="hidden n1-compact:block">
        <Pagination
          aria-label={d.page}
          count={count}
          getPageUrl={getPageUrl}
          linkAs={NextLink}
          page={page}
          pageSize={pageSize}
          siblingCount={1}
          size="sm"
          translations={translations}
          variant="filled"
        />
      </div>
    </div>
  );
};
