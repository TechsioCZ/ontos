"use client";
import { createContext, useContext, type ReactNode } from "react";

/** Whether this storefront shows ERP products (its server has an ERP offer configured). */
const ErpCatalogueContext = createContext(false);

export function ErpCatalogueProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return <ErpCatalogueContext.Provider value={enabled}>{children}</ErpCatalogueContext.Provider>;
}

export const useErpCatalogue = (): boolean => useContext(ErpCatalogueContext);
