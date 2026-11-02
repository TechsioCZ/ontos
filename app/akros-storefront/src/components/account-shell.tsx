"use client";

import StoreLink from "@/components/store-link";
import type { ReactNode } from "react";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";

const navigation = [
  { key: "overview", label: "Přehled účtu", href: "/muj-ucet/prehled" },
  { key: "profile", label: "Můj účet", href: "/muj-ucet" },
  { key: "orders", label: "Objednávky", href: "/historie-objednavek" },
  { key: "invoices", label: "Přehled faktur" },
  { key: "watchdog", label: "Hlídací pes" },
  { key: "claims", label: "Reklamace", href: "/muj-ucet/reklamace" },
  { key: "commission", label: "Komisní prodej" },
  { key: "service", label: "Servisní knížka" },
];
type AccountSection = "overview" | "profile" | "orders" | "favorites" | "tracking" | "claims";
const titles: Record<AccountSection, string> = {
  overview: "Přehled účtu",
  profile: "Můj účet",
  orders: "Objednávky",
  favorites: "Oblíbené produkty",
  tracking: "Sledování zásilky",
  claims: "Reklamace",
};

export function AccountShell({
  active,
  title = titles[active],
  children,
}: {
  active: AccountSection;
  title?: string;
  children: ReactNode;
}) {
  const parent = active === "favorites" ? "overview" : active === "tracking" ? "orders" : active;
  return (
    <div className="min-h-screen bg-(--color-base)">
      <SiteHeader />
      <main
        data-sf-account
        className="bg-(--sf-account-surface) px-(--dimension-16) pt-(--dimension-40) pb-(--dimension-80) text-(length:--sf-account-body-size) font-medium leading-(--sf-account-leading) text-fg-primary [font-optical-sizing:var(--sf-account-optical-sizing)]"
      >
        <div data-sf-account-body className="mx-auto w-full max-w-(--sf-account-width)">
          <StorefrontBreadcrumbs
            className="mb-(--dimension-20)"
            items={[
              { label: "Domů", href: "/" },
              ...(active === "profile" ? [] : [{ label: "Můj účet", href: "/muj-ucet" }]),
              { label: title },
            ]}
          />
          <section
            aria-label={title}
            className="min-w-0 rounded-(--dimension-8) bg-(--color-base) p-(--dimension-32) max-sm:p-(--dimension-16)"
          >
            <nav
              aria-label="Navigace účtu"
              data-account-navigation
              className="mb-(--dimension-40) flex flex-wrap border-b border-(--sf-account-divider)"
            >
              {navigation.map((item) => (
                <LinkButton
                  as={StoreLink}
                  key={item.key}
                  href={item.href ?? "#"}
                  disabled={!item.href}
                  title={!item.href ? "Tato sekce není v prototypu dostupná" : undefined}
                  size="sm"
                  theme="unstyled"
                  aria-current={item.key === parent ? "page" : undefined}
                  className="shrink-0 whitespace-nowrap hover:underline data-disabled:opacity-50 aria-[current=page]:border-b-(length:--sf-account-tab-border) aria-[current=page]:border-(--sf-account-accent)"
                >
                  {item.label}
                </LinkButton>
              ))}
            </nav>
            {children}
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
