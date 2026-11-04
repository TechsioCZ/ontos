"use client";

import type { ReactNode } from "react";
import NextImage from "next/image";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Image } from "@techsio/ui-kit/atoms/image";
import { Link } from "@techsio/ui-kit/atoms/link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Header } from "@techsio/ui-kit/organisms/header";
import { StorefrontFooter } from "./footer";
import { StorefrontSearch } from "./search";
import { MiniCart } from "./mini-cart";
import { MiniLogin } from "./mini-login";
import { MobileNavigation } from "./mobile-navigation";
import { changeHeaderPanel } from "./header-panel-state";
import type { HeaderPanel } from "./header-panel-state";
import type { Dictionary } from "@/i18n";

interface ShellProps {
  categories: readonly { id: string; name: string; parentId: string | null; slug: string }[];
  children: ReactNode;
  dictionary: Dictionary;
  locale: string;
}

/** N1 composition of existing kit components; no backend or primitive implementation lives here. */
export const StorefrontShell = ({ categories, children, dictionary: d, locale }: ShellProps) => {
  const pathname = usePathname();
  const compactContent = ["prihlaseni", "registrace", "kosik", "pokladna"].includes(
    pathname.split("/")[2] ?? "",
  );
  const [headerPanel, setHeaderPanel] = useState<HeaderPanel>(null);
  const mobileMenuOpen = headerPanel === "navigation";
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 48rem)");
    const closeOnDesktop = () => {
      if (mobileMenuOpen && desktop.matches) {
        setHeaderPanel((current) => changeHeaderPanel(current, "navigation", false));
      }
    };
    closeOnDesktop();
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, [mobileMenuOpen]);
  const roots = categories.filter((category) => category.parentId === null);
  const links = [
    ["obchodni-podminky", d.terms],
    ["novinky", d.news],
    ["kontakty", d.contacts],
  ];
  return (
    <div className="min-h-dvh w-full">
      <Link as={NextLink} className="sr-only focus:not-sr-only" href="#main">
        {d.skip}
      </Link>
      <Header direction="vertical" size="sm">
        <div className="flex h-n1-utility-height items-center gap-n1-utility-gap bg-highlight px-4 py-1.5 text-n1-utility text-white max-n1-compact:h-auto max-n1-compact:flex-wrap">
          <div className="flex shrink-0 flex-col items-start md:flex-row md:items-center md:gap-2">
            <Image
              alt=""
              as={NextImage}
              height={13}
              size="custom"
              src="/brand/email-outline.svg"
              width={13}
            />
            <Link href="mailto:office@n1shop.cz">office@n1shop.cz</Link>
          </div>
          {links.map(([slug, label]) => (
            <Link as={NextLink} href={`/${locale}/${slug}`} key={slug}>
              {label}
            </Link>
          ))}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Link aria-label="Čeština" as={NextLink} href="/cs">
              <Image
                alt=""
                as={NextImage}
                height={16}
                size="custom"
                src="/brand/flag-cs.png"
                width={24}
              />
            </Link>
            <Link aria-label="English" as={NextLink} href="/en">
              <Image
                alt=""
                as={NextImage}
                height={16}
                size="custom"
                src="/brand/flag-en.png"
                width={32}
              />
            </Link>
          </div>
        </div>
        <div className="flex h-n1-header items-center gap-1 px-n1-header-gutter md:gap-9">
          <div className="w-n1-mobile-logo min-w-0 shrink md:w-n1-logo md:shrink-0">
            <Link aria-label={d.home} as={NextLink} href={`/${locale}`}>
              <Image
                alt="N1 shop"
                as={NextImage}
                height={61}
                priority
                size="full"
                src="/brand/logo.png"
                width={256}
              />
            </Link>
          </div>
          <Header.Actions className="ml-auto md:order-last">
            <div className="md:hidden">
              <Header.ActionItem>
                <Button
                  aria-controls="n1-mobile-navigation"
                  aria-expanded={mobileMenuOpen}
                  aria-label={d.menu}
                  icon="token-icon-menu"
                  iconSize="xl"
                  onClick={() =>
                    setHeaderPanel((current) =>
                      changeHeaderPanel(current, "navigation", current !== "navigation"),
                    )
                  }
                  size="current"
                  theme="unstyled"
                  variant="tertiary"
                />
              </Header.ActionItem>
            </div>
            <Button
              aria-label={`${d.favorites}: ${d.featureUnavailable}`}
              disabled
              size="current"
              theme="unstyled"
              variant="tertiary"
            >
              <Image
                alt=""
                as={NextImage}
                height={24}
                size="custom"
                src="/brand/heart.svg"
                width={24}
              />
            </Button>
            <MiniLogin
              dictionary={d}
              locale={locale}
              onOpenChange={(open) =>
                setHeaderPanel((previous) => changeHeaderPanel(previous, "login", open))
              }
              open={headerPanel === "login"}
            />
            <MiniCart
              dictionary={d}
              locale={locale}
              onOpenChange={(open) =>
                setHeaderPanel((previous) => changeHeaderPanel(previous, "cart", open))
              }
              open={headerPanel === "cart"}
            />
          </Header.Actions>
          <div className="hidden w-full min-w-0 max-w-n1-search md:block">
            <StorefrontSearch dictionary={d} locale={locale} />
          </div>
        </div>
        <div className="hidden overflow-x-auto overflow-y-hidden border-t border-highlight px-n1-nav-padding md:flex md:h-n1-nav-height md:items-center">
          <Header.Nav aria-label={d.menu}>
            <Header.NavItem size="md">
              <Link as={NextLink} href={`/${locale}/novinky`}>
                {d.news}
              </Link>
            </Header.NavItem>
            {roots.map((category) => (
              <Header.NavItem key={category.id} size="md">
                <Link
                  as={NextLink}
                  href={`/${locale}/kategorie/${encodeURIComponent(category.slug)}`}
                >
                  {category.name}
                </Link>
              </Header.NavItem>
            ))}
          </Header.Nav>
        </div>
      </Header>
      <MobileNavigation
        categories={categories}
        dictionary={d}
        locale={locale}
        onOpenChange={(open) =>
          setHeaderPanel((current) => changeHeaderPanel(current, "navigation", open))
        }
        open={mobileMenuOpen}
      />
      <main className={compactContent ? undefined : "min-h-[50dvh]"} id="main">
        {children}
      </main>
      <StorefrontFooter dictionary={d} locale={locale} />
    </div>
  );
};
