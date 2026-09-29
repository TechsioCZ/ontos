"use client";

import NextLink from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { Link } from "@techsio/ui-kit/atoms/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { SearchForm } from "@techsio/ui-kit/molecules/search-form";

import { MiniCart } from "@/features/cart/mini-cart";
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
  const router = useRouter();

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    const query = new FormData(event.currentTarget).get("q");

    if (typeof query === "string" && query.trim()) {
      router.push(`/vyhledavani?q=${encodeURIComponent(query.trim())}`);
    }
  };

  return (
    <header className="akros-header">
      <div className="akros-header__utility-bar">
        <div className="akros-header__utility">
          <nav className="akros-header__utility-links" aria-label="Pomocná navigace">
            {utilityLinks.map((item) => (
              <Link key={item.href} as={NextLink} href={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
          <LinkButton
            as={NextLink}
            className="text-xs"
            href="/prihlaseni"
            size="sm"
            variant="primary"
          >
            {cs.header.login}
          </LinkButton>
        </div>
      </div>

      <div className="akros-header__main">
        <NextLink className="akros-brand" href="/" aria-label="AKROS – domovská stránka">
          <Image
            alt=""
            className="akros-brand__logo"
            height={61}
            priority
            src="/akros/logo-akros.png"
            width={380}
          />
        </NextLink>

        <div className="akros-header__actions">
          <div className="akros-header__search">
            <SearchForm action="/vyhledavani" method="get" onSubmit={handleSearch} size="md">
              <SearchForm.Label className="sr-only">{cs.search.label}</SearchForm.Label>
              <SearchForm.Control>
                <SearchForm.Input
                  aria-label={cs.search.label}
                  className="rounded-s-xs border-(--color-fg-primary) hover:border-(--color-fg-primary) focus:border-(--color-fg-primary)"
                  name="q"
                  placeholder={cs.search.placeholder}
                />
                <SearchForm.Button
                  aria-label={cs.actions.search}
                  className="rounded-e-xs"
                  iconSize="lg"
                  showSearchIcon
                />
              </SearchForm.Control>
            </SearchForm>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <nav
              aria-label={cs.header.personalNavigation}
              className="flex items-center gap-2 max-md:hidden"
            >
              <LinkButton
                as={NextLink}
                aria-label={cs.header.account}
                className="h-12 w-12 rounded-sm p-2"
                href="/muj-ucet"
                icon="icon-[mdi-light--account]"
                iconSize="xl"
                size="current"
                theme="borderless"
              />
              <LinkButton
                as={NextLink}
                aria-label={cs.header.favorites}
                className="h-12 w-12 rounded-sm p-2"
                href="/oblibene"
                icon="icon-[mdi-light--heart]"
                iconSize="xl"
                size="current"
                theme="borderless"
              />
            </nav>
            <MiniCart />
          </div>
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
