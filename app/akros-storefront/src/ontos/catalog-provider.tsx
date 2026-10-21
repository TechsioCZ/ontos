"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createCatalog } from "./catalog-model";
import type { CatalogCategory } from "@/mock-storefront/types";
import type { CatalogSnapshot } from "./catalog-server";
const Context = createContext<CatalogSnapshot | null>(null);
export function CatalogProvider({
  snapshot,
  children,
}: {
  snapshot: CatalogSnapshot;
  children: ReactNode;
}) {
  return (
    <Context.Provider value={snapshot}>
      {snapshot.mode === "ontos" && (
        <p role="note" className="bg-base-dark p-2 text-center text-sm text-base-light">
          DEMO – objednávky se jen ukládají pro ukázku; nic neplatíte a nic vám nedoručíme. Katalog,
          ceny a sklad: OntOS. Účet a přihlášení: simulace.
        </p>
      )}
      {children}
    </Context.Provider>
  );
}
/** Adds one active category branch (trail + children) to the slim layout navigation. */
export function CatalogBranchProvider({
  categories,
  children,
}: {
  categories: CatalogCategory[];
  children: ReactNode;
}) {
  const parent = useContext(Context);
  const value = useMemo(() => {
    if (!parent || categories.length === 0) return parent;
    const known = new Set(parent.categories.categories.map((category) => category.id));
    return {
      ...parent,
      categories: {
        ...parent.categories,
        categories: [
          ...parent.categories.categories,
          ...categories.filter((category) => !known.has(category.id)),
        ],
      },
    };
  }, [parent, categories]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useCatalog() {
  const s = useContext(Context);
  if (!s) throw new Error("CatalogProvider missing");
  return useMemo(() => createCatalog(s.catalog, s.categories), [s]);
}
export function useDataSource() {
  return useContext(Context)?.mode ?? "mock";
}
