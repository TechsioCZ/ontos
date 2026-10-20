"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createCatalog } from "./catalog-model";
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
          DEMO – objednávka nebude doručena. Katalog, ceny a sklad: OntOS. Účet a přihlášení:
          simulace.
        </p>
      )}
      {children}
    </Context.Provider>
  );
}
export function useCatalog() {
  const s = useContext(Context);
  if (!s) throw new Error("CatalogProvider missing");
  return useMemo(() => createCatalog(s.catalog, s.categories), [s]);
}
export function useDataSource() {
  return useContext(Context)?.mode ?? "mock";
}
