"use client";
import { useCartQuote } from "@/ontos/cart-revalidation";
import type { CheckoutTotals } from "@/features/checkout/checkout-state";

/**
 * Net, VAT and the grand total are the owner's dry-run totals from the cart quote; the browser only adds up
 * displayed gross prices and never computes tax.
 */
export function useServerTotals(local: CheckoutTotals): { totals: CheckoutTotals; note: string } {
  const quote = useCartQuote();
  if (!quote?.enabled) return { totals: local, note: "" };
  const server = quote.status === "ready" && quote.quote?.canCheckout ? quote.quote.totals : null;
  const pending = { ...local, net: null, vat: null };
  if (!server)
    return {
      totals: pending,
      note:
        quote.status === "checking"
          ? "DPH spočítá OntOS po ověření košíku…"
          : "DPH a cenu bez daně ukážeme, až OntOS potvrdí celý košík.",
    };
  // Goods-only totals while no supported shipping method is chosen yet.
  if (local.shipping !== null && server.shippingMinor === null)
    return {
      totals: pending,
      note: "Zvolený způsob dopravy OntOS nepotvrdil; vyberte dopravu z aktuální nabídky.",
    };
  return {
    totals: {
      ...local,
      shipping: server.shippingMinor ?? local.shipping,
      total: server.totalMinor,
      net: server.netMinor,
      vat: server.totalVatMinor,
    },
    note: "",
  };
}
