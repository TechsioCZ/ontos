"use client";

import StoreLink from "@/components/store-link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Drawer } from "@techsio/ui-kit/molecules/drawer";
import { CatalogHelpNavigation, CatalogNavigation } from "@/components/catalog-sidebar";
import { HeaderSearch } from "@/components/header-search";

import { MiniCart } from "@/features/cart/mini-cart";
import { cs } from "@/i18n/cs";
import { useCatalog } from "@/ontos/catalog-provider";

const isElement = (value: EventTarget): value is Element => Element.prototype.isPrototypeOf(value);

const utilityLinks = [
  { href: "/obchodni-podminky", label: cs.header.terms },
  { href: "/o-nas", label: cs.header.about },
  { href: "/blog", label: cs.header.blog },
  { href: "/partnersky-program", label: cs.header.partnerProgram },
  { href: "/reklamace", label: cs.header.claims },
  { href: "/kontakty", label: cs.header.contacts },
];

function MobileNavigation({ pathname }: { pathname: string }) {
  const { getSidebarCategories } = useCatalog();
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
    <div className="akros-header__mobile-menu">
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
            <Drawer.Content data-akros-mobile-menu="" draggable={false}>
              <Drawer.Header className="flex-row items-center justify-between">
                <Drawer.Title>{cs.header.menu}</Drawer.Title>
                <Drawer.CloseTrigger
                  aria-label={cs.header.closeNavigation}
                  ref={closeRef}
                  size="lg"
                />
              </Drawer.Header>
              <Drawer.Body
                data-akros-mobile-menu-body=""
                onClick={(event) => {
                  if (isElement(event.target) && event.target.closest("a[href]")) setOpen(false);
                }}
              >
                <section>
                  <h3 className="akros-mobile-menu__section-title">{cs.catalog.title}</h3>
                  <CatalogNavigation
                    activeSlug={activeSlug}
                    categories={categories}
                    expandRoots={false}
                    navigationId="catalog-mobile"
                  />
                  <CatalogHelpNavigation />
                </section>
                <section>
                  <h3 className="akros-mobile-menu__section-title">
                    {cs.header.personalNavigation}
                  </h3>
                  <nav
                    aria-label={cs.header.personalNavigation}
                    className="akros-mobile-menu__links"
                  >
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
                  <h3 className="akros-mobile-menu__section-title">{cs.header.information}</h3>
                  <nav aria-label="Mobilní navigace" className="akros-mobile-menu__links">
                    {utilityLinks.map((item) => (
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
  const pathname = usePathname();

  return (
    <header className="akros-header">
      <div className="akros-header__utility-bar">
        <div className="akros-header__utility">
          <nav className="akros-header__utility-links" aria-label="Pomocná navigace">
            {utilityLinks.map((item) => (
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
          <LinkButton
            as={StoreLink}
            data-akros-header-login
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

      <div className="akros-header__main">
        <div className="akros-header__top-row">
          <MobileNavigation key={pathname} pathname={pathname} />
          <StoreLink className="akros-brand" href="/" aria-label="AKROS – domovská stránka">
            <Image
              alt=""
              className="akros-brand__logo"
              height={61}
              priority
              src="/akros/logo-akros.png"
              width={380}
            />
          </StoreLink>

          <div className="akros-header__cart-actions flex shrink-0 items-center gap-3">
            <nav
              aria-label={cs.header.personalNavigation}
              className="akros-header__personal-navigation flex items-center"
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
        <div className="akros-header__search">
          <HeaderSearch />
        </div>
      </div>
    </header>
  );
}
