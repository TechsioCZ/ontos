"use client";

import StoreLink from "@/components/store-link";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Drawer } from "@techsio/ui-kit/molecules/drawer";
import { CatalogHelpNavigation, CatalogNavigation } from "@/components/catalog-sidebar";
import { HeaderSearch } from "@/components/header-search";

import { useBrand } from "@/brand/brand-context";
import { MiniCart } from "@/features/cart/mini-cart";
import type { Dictionary } from "@/i18n";
import { useCatalog } from "@/ontos/catalog-provider";
import { useDictionary, useStorePathname } from "@/ontos/market-context";
import { MarketSwitcher } from "@/ontos/market-switcher";

const isElement = (value: EventTarget): value is Element => Element.prototype.isPrototypeOf(value);

// Informational pages only: home stays on the logo, catalogue entries live in the catalogue navigation.
const utilityLinks = (cs: Dictionary) => [
  { href: "/obchodni-podminky", label: cs.header.terms },
  { href: "/o-nas", label: cs.header.about },
  { href: "/blog", label: cs.header.blog },
  { href: "/partnersky-program", label: cs.header.partnerProgram },
  { href: "/reklamace", label: cs.header.claims },
  { href: "/kontakty", label: cs.header.contacts },
];

function MobileNavigation({ pathname }: { pathname: string }) {
  const { getSidebarCategories } = useCatalog();
  const cs = useDictionary();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const activeSlug = pathname.startsWith("/kategorie/") ? pathname.split("/")[2] : undefined;
  const categories = useMemo(
    () => getSidebarCategories(activeSlug),
    [activeSlug, getSidebarCategories],
  );

  useEffect(() => {
    if (!window.matchMedia) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  return (
    <div className="sf-header__mobile-menu">
      <Drawer
        closeOnEscape
        closeOnInteractOutside
        initialFocusEl={() => closeRef.current}
        modal
        onOpenChange={({ open: nextOpen }) => setOpen(nextOpen)}
        open={open}
        placement="start"
        preventScroll
        size="sm"
        trapFocus
      >
        <Drawer.Trigger
          aria-label={cs.header.openNavigation}
          icon="icon-[mdi--menu]"
          iconSize="lg"
          size="sm"
          theme="borderless"
          variant="secondary"
        />
        <Drawer.Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content data-sf-mobile-menu="" draggable={false}>
              <Drawer.Header className="flex-row items-center justify-between">
                <Drawer.Title>{cs.header.menu}</Drawer.Title>
                <Drawer.CloseTrigger
                  aria-label={cs.header.closeNavigation}
                  ref={closeRef}
                  size="lg"
                />
              </Drawer.Header>
              <Drawer.Body
                data-sf-mobile-menu-body=""
                onClick={(event) => {
                  if (isElement(event.target) && event.target.closest("a[href]")) setOpen(false);
                }}
              >
                <section>
                  <h3 className="sf-mobile-menu__section-title">{cs.catalog.title}</h3>
                  <CatalogNavigation
                    activeSlug={activeSlug}
                    categories={categories}
                    expandRoots={false}
                    navigationId="catalog-mobile"
                  />
                  <CatalogHelpNavigation />
                </section>
                <section>
                  <h3 className="sf-mobile-menu__section-title">{cs.header.personalNavigation}</h3>
                  <nav aria-label={cs.header.personalNavigation} className="sf-mobile-menu__links">
                    <LinkButton
                      as={StoreLink}
                      block
                      className="justify-start"
                      href="/prihlaseni"
                      size="sm"
                      theme="borderless"
                      variant="secondary"
                    >
                      {cs.header.login}
                    </LinkButton>
                    <LinkButton
                      as={StoreLink}
                      block
                      className="justify-start"
                      href="/muj-ucet"
                      size="sm"
                      theme="borderless"
                      variant="secondary"
                    >
                      {cs.header.account}
                    </LinkButton>
                    <LinkButton
                      as={StoreLink}
                      block
                      className="justify-start"
                      href="/oblibene"
                      size="sm"
                      theme="borderless"
                      variant="secondary"
                    >
                      {cs.header.favorites}
                    </LinkButton>
                  </nav>
                </section>
                <section>
                  <h3 className="sf-mobile-menu__section-title">{cs.header.information}</h3>
                  <nav aria-label={cs.header.mobileNavigation} className="sf-mobile-menu__links">
                    {utilityLinks(cs).map((item) => (
                      <LinkButton
                        key={item.href}
                        as={StoreLink}
                        aria-current={pathname === item.href ? "page" : undefined}
                        block
                        className="justify-start"
                        href={item.href}
                        size="sm"
                        theme="borderless"
                        variant="secondary"
                      >
                        {item.label}
                      </LinkButton>
                    ))}
                  </nav>
                </section>
              </Drawer.Body>
            </Drawer.Content>
          </Drawer.Positioner>
        </Drawer.Portal>
      </Drawer>
    </div>
  );
}

export function SiteHeader() {
  // Without the market prefix, so current-page state matches Kai's unprefixed routes.
  const pathname = useStorePathname();
  const cs = useDictionary();
  const brand = useBrand();

  return (
    <header className="sf-header">
      <div className="sf-header__utility-bar">
        <div className="sf-header__utility">
          <nav className="sf-header__utility-links" aria-label={cs.header.utilityNavigation}>
            {utilityLinks(cs).map((item) => (
              <LinkButton
                key={item.href}
                as={StoreLink}
                aria-current={pathname === item.href ? "page" : undefined}
                className="leading-(--text-sm--line-height) underline"
                href={item.href}
                size="sm"
                theme="borderless"
                variant="secondary"
              >
                {item.label}
              </LinkButton>
            ))}
          </nav>
          <MarketSwitcher />
          <LinkButton
            as={StoreLink}
            data-sf-header-login
            href="/prihlaseni"
            icon="icon-[mdi--lock]"
            iconSize="sm"
            size="sm"
            variant="secondary"
          >
            {cs.header.login}
          </LinkButton>
        </div>
      </div>

      <div className="sf-header__main">
        <div className="sf-header__top-row">
          <MobileNavigation key={pathname} pathname={pathname} />
          <StoreLink className="sf-brand" href="/" aria-label={cs.footer.homeLinkLabel(brand.name)}>
            {brand.logo ? (
              <Image
                alt=""
                className="sf-brand__logo"
                height={61}
                priority
                src={brand.logo.header}
                width={380}
              />
            ) : (
              <span aria-hidden="true" className="sf-brand__wordmark">
                {brand.name}
              </span>
            )}
          </StoreLink>

          <div className="sf-header__cart-actions flex shrink-0 items-center gap-3">
            <nav
              aria-label={cs.header.personalNavigation}
              className="sf-header__personal-navigation flex items-center"
            >
              <LinkButton
                as={StoreLink}
                aria-label={cs.header.account}
                className="w-10"
                href="/muj-ucet"
                icon="icon-[mdi-light--account]"
                iconSize="xl"
                size="md"
                theme="borderless"
              />
              <LinkButton
                as={StoreLink}
                aria-label={cs.header.favorites}
                className="w-12"
                href="/oblibene"
                icon="icon-[mdi-light--heart]"
                iconSize="xl"
                size="md"
                theme="borderless"
              />
            </nav>
            <MiniCart />
          </div>
        </div>
        <div className="sf-header__search">
          <HeaderSearch />
        </div>
      </div>
    </header>
  );
}
