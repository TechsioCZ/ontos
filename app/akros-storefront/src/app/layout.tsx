import { getShellSnapshot } from "@/ontos/catalog-server";
import { CatalogProvider } from "@/ontos/catalog-provider";
import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import "./globals.css";

import { CartProvider } from "@/features/cart/cart-provider";
import { CartNotifications } from "@/features/cart/cart-notifications";

const inter = localFont({
  src: "../fonts/InterVariable.woff2",
  weight: "400 900",
  style: "normal",
  display: "swap",
  variable: "--font-akros",
});

export const metadata: Metadata = {
  title: {
    default: "AKROS | Nerezový a spojovací materiál",
    template: "%s | AKROS",
  },
  robots: { index: false, follow: false, nocache: true },
  description: "Klikací ukázka e-shopu AKROS s nerezovým, hutním a spojovacím materiálem.",
};

export const dynamic = "force-dynamic";
export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const snapshot = await getShellSnapshot();
  return (
    <html lang="cs" className={`${inter.variable} light`} data-scroll-behavior="smooth">
      <body>
        <CatalogProvider snapshot={snapshot}>
          <CartProvider>
            {children}
            <CartNotifications />
          </CartProvider>
        </CatalogProvider>
      </body>
    </html>
  );
}
