"use client";

import StoreLink from "@/components/store-link";
import type { ReactNode } from "react";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { useDictionary } from "@/ontos/market-context";

/** Account tabs; the label is the `account.shell` dictionary key, tabs without `href` are not in the prototype. */
const navigation = [
  { key: "overview", href: "/muj-ucet/prehled" },
  { key: "profile", href: "/muj-ucet" },
  { key: "orders", href: "/historie-objednavek" },
  { key: "invoices" },
  { key: "watchdog" },
  { key: "claims", href: "/muj-ucet/reklamace" },
  { key: "commission" },
  { key: "service" },
] as const;
type AccountSection = "overview" | "profile" | "orders" | "favorites" | "tracking" | "claims";

export function AccountShell({
  active,
  title: customTitle,
  children,
}: {
  active: AccountSection;
  title?: string;
  children: ReactNode;
}) {
  const { header, account } = useDictionary();
  const labels = account.shell;
  const title = customTitle ?? labels[active];
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
              { label: header.home, href: "/" },
              ...(active === "profile" ? [] : [{ label: labels.profile, href: "/muj-ucet" }]),
              { label: title },
            ]}
          />
          <section
            aria-label={title}
            className="min-w-0 rounded-(--dimension-8) bg-(--color-base) p-(--dimension-32) max-sm:p-(--dimension-16)"
          >
            <nav
              aria-label={labels.navigation}
              data-account-navigation
              className="mb-(--dimension-40) flex flex-wrap border-b border-(--sf-account-divider)"
            >
              {navigation.map((item) => (
                <LinkButton
                  as={StoreLink}
                  key={item.key}
                  href={"href" in item ? item.href : "#"}
                  disabled={!("href" in item)}
                  title={"href" in item ? undefined : labels.unavailableSection}
                  size="sm"
                  theme="unstyled"
                  aria-current={item.key === parent ? "page" : undefined}
                  className="shrink-0 whitespace-nowrap hover:underline data-disabled:opacity-50 aria-[current=page]:border-b-(length:--sf-account-tab-border) aria-[current=page]:border-(--sf-account-accent)"
                >
                  {labels[item.key]}
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
