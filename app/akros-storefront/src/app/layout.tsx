import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

import { CartProvider } from "@/features/cart/cart-provider";
import { CartNotifications } from "@/features/cart/cart-notifications";

export const metadata: Metadata = {
  title: {
    default: "AKROS | Nerezový a spojovací materiál",
    template: "%s | AKROS",
  },
  description: "Klikací ukázka e-shopu AKROS s nerezovým, hutním a spojovacím materiálem.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="cs" className="light" data-scroll-behavior="smooth">
      <body>
        <CartProvider>
          {children}
          <CartNotifications />
        </CartProvider>
      </body>
    </html>
  );
}
