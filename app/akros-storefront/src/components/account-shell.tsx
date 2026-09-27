import NextLink from "next/link";
import type { ReactNode } from "react";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { mockCustomer } from "@/mock-storefront/fixtures/account";

const accountLinks = [
  { href: "/muj-ucet", label: "Přehled", key: "overview" },
  { href: "/historie-objednavek", label: "Historie objednávek", key: "orders" },
  { href: "/oblibene", label: "Oblíbené", key: "favorites" },
  { href: "/sledovani-zasilky", label: "Sledování zásilky", key: "tracking" },
  { href: "/muj-ucet#osobni-udaje", label: "Osobní údaje", key: "profile" },
  { href: "/muj-ucet#adresy", label: "Adresy", key: "addresses" },
  { href: "/muj-ucet#zmena-hesla", label: "Změna hesla", key: "password" },
  { href: "/prihlaseni", label: "Odhlásit se", key: "logout" },
] as const;

export function AccountShell({ active, children }: { active: string; children: ReactNode }) {
  return (
    <div className="akros-shell">
      <SiteHeader />
      <main className="akros-account-layout">
        <aside className="akros-account-sidebar" aria-label="Navigace zákaznického účtu">
          <div className="akros-account-user">
            <span aria-hidden="true">{mockCustomer.initials}</span>
            <div>
              <strong>{mockCustomer.name}</strong>
              <small>Zákazník č. {mockCustomer.customerNumber}</small>
            </div>
          </div>
          <nav>
            {accountLinks.map((link) => (
              <NextLink
                aria-current={link.key === active ? "page" : undefined}
                href={link.href}
                key={link.key}
              >
                {link.label}
              </NextLink>
            ))}
          </nav>
        </aside>
        <div className="akros-account-content">{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}
