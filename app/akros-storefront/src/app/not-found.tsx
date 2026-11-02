"use client";

import StoreLink from "@/components/store-link";
import { useRouter } from "next/navigation";
import { useDictionary, useStoreHref } from "@/ontos/market-context";
import type { FormEvent } from "react";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { SearchForm } from "@techsio/ui-kit/molecules/search-form";

import { StorefrontWideShell } from "@/components/storefront-shell";

export default function NotFoundPage() {
  const router = useRouter();
  const storeHref = useStoreHref();
  const { errorPages: copy, actions } = useDictionary();

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    const query = new FormData(event.currentTarget).get("q");

    if (typeof query === "string" && query.trim()) {
      router.push(storeHref(`/vyhledavani?q=${encodeURIComponent(query.trim())}`));
    }
  };

  return (
    <StorefrontWideShell fullBleed>
      <section className="sf-not-found" aria-labelledby="not-found-title">
        <div className="sf-not-found__code" aria-hidden="true">
          <span>4</span>
          <span className="sf-not-found__product">
            <span className="inline-block -rotate-[45deg] leading-none">🔩</span>
          </span>
          <span>4</span>
        </div>
        <div className="sf-not-found__copy">
          <h1 id="not-found-title">{copy.notFoundHeading}</h1>
          <p>{copy.notFoundText}</p>
        </div>
        <div className="sf-not-found__search">
          <strong>{copy.searchAgain}</strong>
          <SearchForm
            action={storeHref("/vyhledavani")}
            method="get"
            onSubmit={handleSearch}
            size="sm"
          >
            <SearchForm.Control>
              <SearchForm.Input name="q" placeholder={copy.searchPlaceholder} />
              <SearchForm.Button>{actions.search}</SearchForm.Button>
            </SearchForm.Control>
          </SearchForm>
        </div>
        <div className="sf-not-found__categories">
          <strong>{copy.categoriesIntro}</strong>
          <div>
            <LinkButton
              as={StoreLink}
              href="/kategorie/srouby"
              size="sm"
              theme="outlined"
              variant="primary"
            >
              {copy.screws}
            </LinkButton>
            <LinkButton
              as={StoreLink}
              href="/kategorie/matice"
              size="sm"
              theme="outlined"
              variant="primary"
            >
              {copy.nuts}
            </LinkButton>
            <LinkButton
              as={StoreLink}
              href="/zavitove-tyce"
              size="sm"
              theme="outlined"
              variant="primary"
            >
              {copy.threadedRods}
            </LinkButton>
          </div>
        </div>
        <LinkButton as={StoreLink} href="/" size="md" theme="solid" variant="primary">
          {copy.backHome}
        </LinkButton>
      </section>
    </StorefrontWideShell>
  );
}
