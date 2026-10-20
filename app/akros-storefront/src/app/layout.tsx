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
  description: "Klikací ukázka e-shopu AKROS s nerezovým, hutním a spojovacím materiálem.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="cs" className={`${inter.variable} light`} data-scroll-behavior="smooth">
      <body>
        <CartProvider>
          {children}
          <CartNotifications />
        </CartProvider>
      </body>
    </html>
  );
}
