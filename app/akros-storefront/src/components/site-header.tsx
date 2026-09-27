"use client";

import NextLink from "next/link";
import { Icon } from "@techsio/ui-kit/atoms/icon";
import { Link } from "@techsio/ui-kit/atoms/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { SearchForm } from "@techsio/ui-kit/molecules/search-form";

import { useCart } from "@/features/cart/cart-provider";
import { cs } from "@/i18n/cs";

const utilityLinks = [
  { href: "/", label: cs.header.home },
  { href: "/obchodni-podminky", label: cs.header.terms },
  { href: "/o-nas", label: cs.header.about },
  { href: "/kategorie/nerezovy-spojovaci-material", label: cs.header.fasteners },
  { href: "/kategorie/nerezovy-hutni-material", label: cs.header.steel },
  { href: "/blog", label: cs.header.blog },
  { href: "/partnersky-program", label: cs.header.partnerProgram },
  { href: "/kategorie/akroscz-vyroba", label: cs.header.production },
  { href: "/reklamace", label: cs.header.claims },
  { href: "/kontakty", label: cs.header.contacts },
];

export function SiteHeader() {
  const { itemCount } = useCart();

  return (
    <header className="akros-header">
      <div className="akros-header__utility">
        <nav className="akros-header__utility-links" aria-label="Pomocná navigace">
          {utilityLinks.map((item) => (
            <Link key={item.href} as={NextLink} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
        <LinkButton as={NextLink} href="/prihlaseni" size="sm" variant="primary">
          {cs.header.login}
        </LinkButton>
      </div>

      <div className="akros-header__main">
        <NextLink className="akros-brand" href="/" aria-label="AKROS – domovská stránka">
          <span className="akros-brand__wordmark">AKROS</span>
          <span className="akros-brand__stock">{cs.header.stock}</span>
        </NextLink>

        <div className="akros-header__search">
          <SearchForm action="/vyhledavani" gapped method="get" size="md">
            <SearchForm.Label className="sr-only">{cs.search.label}</SearchForm.Label>
            <SearchForm.Control>
              <SearchForm.Input name="q" placeholder={cs.search.placeholder} />
              <SearchForm.Button>{cs.actions.search}</SearchForm.Button>
            </SearchForm.Control>
          </SearchForm>
        </div>

        <div className="akros-header__actions">
          <Link as={NextLink} href="/kategorie/nerezovy-spojovaci-material">
            {cs.header.quickSelect}
          </Link>
          <NextLink
            className="akros-header__cart"
            href="/kosik"
            aria-label={`${cs.header.cart}, ${itemCount}`}
          >
            <Icon icon="token-icon-cart-button" size="md" aria-hidden="true" />
            <span className="akros-header__cart-label">{cs.header.cart}</span>
            <span className="akros-header__cart-count" aria-live="polite">
              {itemCount}
            </span>
          </NextLink>
        </div>

        <details className="akros-header__mobile-menu">
          <summary>{cs.header.openNavigation}</summary>
          <nav className="akros-header__mobile-links" aria-label="Mobilní navigace">
            {utilityLinks.map((item) => (
              <Link key={item.href} as={NextLink} href={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
        </details>
      </div>
    </header>
  );
}
