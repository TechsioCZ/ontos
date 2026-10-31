import { getShellSnapshot } from "@/ontos/catalog-server";
import { CatalogProvider } from "@/ontos/catalog-provider";
import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import "./globals.css";

import { CartProvider } from "@/features/cart/cart-provider";
import { CartNotifications } from "@/features/cart/cart-notifications";

// Inter is split into two pre-built files (see app/scripts/fonts/subset-fonts.mjs): a preloaded core
// with ASCII, Latin-1, Latin Extended-A and the punctuation Czech copy needs, plus a lazily fetched
// extended file behind unicode-range. Together they keep the complete non-CJK coverage of the
// upstream InterVariable-latin.woff2, so every character the shop can render keeps the same outlines,
// widths and metrics. The extended face lives in fonts/inter-extended.generated.css.
//
// next/font/local only accepts literal option values, so the core range is written out below;
// `node app/scripts/fonts/subset-fonts.mjs` rewrites it when the subset changes.
const inter = localFont({
  src: "../fonts/InterVariable-core.woff2",
  weight: "400 900",
  style: "normal",
  display: "swap",
  variable: "--font-akros",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0020-007E, U+00A0-00AC, U+00AE-0148, U+014A-017F, U+0192, U+0218-021B, U+2010, U+2013-2014, U+2018-201A, U+201C-201E, U+2022, U+2026, U+20AC",
    },
  ],
});

export const metadata: Metadata = {
  title: {
    default: "AKROS | Nerezový a spojovací materiál",
    template: "%s | AKROS",
  },
  robots: { index: false, follow: false, nocache: true },
  description:
    "E-shop AKROS s nerezovým, hutním a spojovacím materiálem v prezentačním prostředí OntOS.",
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
