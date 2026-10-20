"use client";

import NextLink from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { SearchForm } from "@techsio/ui-kit/molecules/search-form";

import { StorefrontWideShell } from "@/components/storefront-shell";

export default function NotFoundPage() {
  const router = useRouter();

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    const query = new FormData(event.currentTarget).get("q");

    if (typeof query === "string" && query.trim()) {
      router.push(`/vyhledavani?q=${encodeURIComponent(query.trim())}`);
    }
  };

  return (
    <StorefrontWideShell fullBleed>
      <section className="akros-not-found" aria-labelledby="not-found-title">
        <div className="akros-not-found__code" aria-hidden="true">
          <span>4</span>
          <span className="akros-not-found__product">
            <span className="inline-block -rotate-[45deg] leading-none">🔩</span>
          </span>
          <span>4</span>
        </div>
        <div className="akros-not-found__copy">
          <h1 id="not-found-title">Vypadá to, že jste se ztratili v našem skladu...</h1>
          <p>
            Požadovaná stránka nebyla nalezena. Pravděpodobně byla přesunuta, smazána, nebo odkaz,
            na který jste klikli, je nesprávný.
          </p>
        </div>
        <div className="akros-not-found__search">
          <strong>Zkuste vyhledat materiál znovu:</strong>
          <SearchForm action="/vyhledavani" method="get" onSubmit={handleSearch} size="sm">
            <SearchForm.Control>
              <SearchForm.Input name="q" placeholder="Hledat matici, šroub…" />
              <SearchForm.Button>Hledat</SearchForm.Button>
            </SearchForm.Control>
          </SearchForm>
        </div>
        <div className="akros-not-found__categories">
          <strong>Nebo přejděte rovnou do hlavních kategorií:</strong>
          <div>
            <LinkButton
              as={NextLink}
              href="/kategorie/srouby"
              size="sm"
              theme="outlined"
              variant="primary"
            >
              Nerezové šrouby
            </LinkButton>
            <LinkButton
              as={NextLink}
              href="/kategorie/matice"
              size="sm"
              theme="outlined"
              variant="primary"
            >
              Nerezové matice
            </LinkButton>
            <LinkButton
              as={NextLink}
              href="/zavitove-tyce"
              size="sm"
              theme="outlined"
              variant="primary"
            >
              Závitové tyče
            </LinkButton>
          </div>
        </div>
        <LinkButton as={NextLink} href="/" size="md" theme="solid" variant="primary">
          Zpět na hlavní stránku
        </LinkButton>
      </section>
    </StorefrontWideShell>
  );
}
