import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  icons: { icon: "/brand/logo.png" },
  robots: { follow: false, index: false },
  title: { default: "N1 shop", template: "%s | N1 shop" },
};

const RootLayout = async ({ children }: { children: ReactNode }) => {
  const requestHeaders = await headers();
  const locale = requestHeaders.get("x-n1-locale") === "en" ? "en" : "cs";
  return (
    <html className="light" data-theme="n1" lang={locale}>
      <body>{children}</body>
    </html>
  );
};

export default RootLayout;
