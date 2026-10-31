import "server-only";
import type { ReactNode } from "react";
import { CatalogBranchProvider } from "./catalog-provider";
import { getCategoryBranch } from "./catalog-server";

/** Ships only the active category branch to the browser navigation, not the whole tree. */
export async function CategoryBranch({
  activeSlug,
  children,
}: {
  activeSlug?: string;
  children: ReactNode;
}) {
  if (!activeSlug) return children;
  return (
    <CatalogBranchProvider categories={await getCategoryBranch(activeSlug)}>
      {children}
    </CatalogBranchProvider>
  );
}
