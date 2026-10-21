import "server-only";
import type { ReactNode } from "react";
import { CatalogBranchProvider } from "./catalog-provider";
import { getCategoryBranch } from "./catalog-server";
import { isOntos } from "./config";

/** OntOS mode: ships only the active category branch to the browser navigation. Mock mode: no-op. */
export async function CategoryBranch({
  activeSlug,
  children,
}: {
  activeSlug?: string;
  children: ReactNode;
}) {
  if (!isOntos() || !activeSlug) return children;
  return (
    <CatalogBranchProvider categories={await getCategoryBranch(activeSlug)}>
      {children}
    </CatalogBranchProvider>
  );
}
