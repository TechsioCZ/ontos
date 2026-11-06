"use client";

import { useId, useState } from "react";
import NextImage from "next/image";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { Image } from "@techsio/ui-kit/atoms/image";
import { Label } from "@techsio/ui-kit/atoms/label";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { PriceBlock } from "@techsio/ui-kit/molecules/price-block";
import type { ComboboxItem } from "@techsio/ui-kit/molecules/combobox";
import { SearchSuggestions } from "@techsio/ui-kit/templates/search-suggestions";
import type { Dictionary } from "@/i18n";
import type { ProductCardModel } from "@/ontos/catalog-model";
import { priceProps } from "./price-props";
import { useSearchSuggestions } from "./use-search-suggestions";

const renderProductResult = (item: ComboboxItem<ProductCardModel>, d: Dictionary, locale: string) =>
  item.data && (
    <div className="flex w-full min-w-0 items-center gap-2">
      <div className="relative size-n1-suggestion-image shrink-0">
        {item.data.image !== null && (
          <Image
            alt=""
            as={NextImage}
            fill
            objectFit="contain"
            size="full"
            sizes="48px"
            src={item.data.image}
          />
        )}
      </div>
      <span className="min-w-0 flex-1">{item.label}</span>
      <PriceBlock {...priceProps(item.data, d, locale)} />
    </div>
  );

/** App-owned reads/routing around the existing navigation Combobox template. */
export const StorefrontSearch = ({
  dictionary: d,
  locale,
}: {
  dictionary: Dictionary;
  locale: string;
}) => {
  const router = useRouter();
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const result = useSearchSuggestions(locale, query);
  const hasResults = result.state === "ready" && result.products.length > 0;
  const noResultsMessage =
    result.state === "unavailable"
      ? d.suggestionsUnavailable
      : d.suggestionsEmpty.replace("{query}", () => query.trim());
  const renderResult = (item: ComboboxItem<ProductCardModel>) =>
    renderProductResult(item, d, locale);
  const href = `/${locale}/vyhledavani?${new URLSearchParams({ q: query.trim() })}`;
  const groups =
    result.state === "ready"
      ? [
          {
            id: "products",
            items: result.products.map((product) => ({
              data: product,
              href: `/${locale}/produkt/${encodeURIComponent(product.slug)}`,
              label: product.name,
              value: product.id,
            })),
            label: d.suggestionsProducts,
          },
        ]
      : [];

  return (
    <form
      action={`/${locale}/vyhledavani`}
      className={hasResults ? "n1-search-suggestions n1-search-results" : "n1-search-suggestions"}
      method="get"
      onSubmit={(event) => {
        event.preventDefault();
        setOpen(false);
        router.push(href);
      }}
    >
      <Label className="sr-only" htmlFor={`${id}-input`} id={`${id}-label`}>
        {d.searchLabel}
      </Label>
      <SearchSuggestions<ProductCardModel>
        allResultsLink={
          query.trim().length > 0 ? (
            <LinkButton
              as={NextLink}
              block
              href={href}
              icon="token-icon-search"
              iconPosition="left"
              iconSize="xs"
              onClick={() => setOpen(false)}
              size="md"
              theme="solid"
              variant="secondary"
            >
              {d.allResults}
            </LinkButton>
          ) : undefined
        }
        clearable={false}
        groups={groups}
        id={id}
        inputValue={query}
        loading={result.state === "loading"}
        loadingMessage={d.suggestionsLoading}
        navigate={({ href: target }) => {
          setOpen(false);
          router.push(target);
        }}
        noResultsMessage={noResultsMessage}
        onInputValueChange={(value) => {
          setQuery(value);
          setOpen(value.trim().length > 0);
        }}
        onOpenChange={setOpen}
        open={open && query.trim().length > 0}
        placeholder={d.searchPlaceholder}
        resultSlot={renderResult}
        size="sm"
        translations={{
          noResults: noResultsMessage,
          resultsCount: () => d.suggestionsReady,
          triggerLabel: d.search,
        }}
        triggerIcon="token-icon-search"
        triggerIconSize="md"
      />
    </form>
  );
};
