"use client";
// Browser side of the brand: the root layout passes the server-resolved chrome once per document. There is no
// default brand, so no brand profile ever ships in the client bundle.
import { createContext, useContext, type ReactNode } from "react";
import type { ClientBrand } from "./types";

const BrandContext = createContext<ClientBrand | undefined>(undefined);

export function BrandProvider({ brand, children }: { brand: ClientBrand; children: ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

/** The brand chrome; only inside the root layout's BrandProvider. */
export function useBrand(): ClientBrand {
  const brand = useContext(BrandContext);
  if (brand === undefined) throw new Error("useBrand() is used outside BrandProvider");
  return brand;
}

/** The brand chrome when a BrandProvider is mounted (error boundaries may render without one). */
export const useOptionalBrand = (): ClientBrand | undefined => useContext(BrandContext);
