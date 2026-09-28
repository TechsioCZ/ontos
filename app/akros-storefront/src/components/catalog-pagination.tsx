import NextLink from "next/link";
import { buttonVariants } from "@techsio/ui-kit/atoms/button";

export function CatalogPagination({
  currentPage,
  totalPages,
  hrefForPage,
}: {
  currentPage: number;
  totalPages: number;
  hrefForPage: (page: number) => string;
}) {
  if (totalPages <= 1) return null;

  return (
    <nav className="akros-pagination" aria-label="Stránkování produktů">
      {currentPage > 1 && (
        <NextLink
          className={buttonVariants({ size: "sm", variant: "secondary" })}
          href={hrefForPage(currentPage - 1)}
        >
          Předchozí
        </NextLink>
      )}
      <span>
        Strana {currentPage.toLocaleString("cs-CZ")} z {totalPages.toLocaleString("cs-CZ")}
      </span>
      {currentPage < totalPages && (
        <NextLink
          className={buttonVariants({ size: "sm", variant: "secondary" })}
          href={hrefForPage(currentPage + 1)}
        >
          Další
        </NextLink>
      )}
    </nav>
  );
}
