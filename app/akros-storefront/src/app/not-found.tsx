"use client";

import Image from "next/image";
import NextLink from "next/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { SearchForm } from "@techsio/ui-kit/molecules/search-form";

import { StorefrontWideShell } from "@/components/storefront-shell";

export default function NotFoundPage() {
  return (
    <StorefrontWideShell>
      <section className="akros-not-found" aria-labelledby="not-found-title">
        <div className="akros-not-found__code" aria-hidden="true">
          <span>4</span>
          <span className="akros-not-found__product">
            <Image alt="" height={96} src="/akros/products/hex-bolt-din-933.png" width={96} />
          </span>
          <span>4</span>
        </div>
        <h1 id="not-found-title">Vypadá to, že jste se ztratili v našem skladu…</h1>
        <p>
          Požadovaná stránka nebyla nalezena. Pravděpodobně byla přesunuta, smazána, nebo je odkaz
          nesprávný.
        </p>
        <div className="akros-not-found__search">
          <strong>Zkuste vyhledat materiál znovu:</strong>
          <SearchForm action="/vyhledavani" gapped method="get" size="md">
            <SearchForm.Control>
              <SearchForm.Input name="q" placeholder="Hledat matici, šroub…" />
              <SearchForm.Button>Hledat</SearchForm.Button>
            </SearchForm.Control>
          </SearchForm>
        </div>
        <div className="akros-not-found__categories">
          <strong>Nebo přejděte rovnou do hlavních kategorií:</strong>
          <div>
            <LinkButton as={NextLink} href="/kategorie/srouby" theme="outlined" variant="secondary">
              Nerezové šrouby
            </LinkButton>
            <LinkButton as={NextLink} href="/kategorie/matice" theme="outlined" variant="secondary">
              Nerezové matice
            </LinkButton>
            <LinkButton
              as={NextLink}
              href="/kategorie/zavitove-tyce"
              theme="outlined"
              variant="secondary"
            >
              Závitové tyče
            </LinkButton>
          </div>
        </div>
        <LinkButton as={NextLink} href="/" variant="primary">
          Zpět na hlavní stránku
        </LinkButton>
      </section>
    </StorefrontWideShell>
  );
}
