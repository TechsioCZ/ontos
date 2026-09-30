"use client";

import Image from "next/image";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { Link } from "@techsio/ui-kit/atoms/link";
import { Label } from "@techsio/ui-kit/atoms/label";
import { SearchForm } from "@techsio/ui-kit/molecules/search-form";
import { SearchSuggestions } from "@techsio/ui-kit/templates/search-suggestions";

import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import { searchCatalog } from "@/mock-storefront/catalog";

export function HeaderSearch() {
  const router = useRouter();
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const trimmedQuery = query.trim();
  const ready = trimmedQuery.length >= 2;
  const results = useMemo(() => (ready ? searchCatalog(trimmedQuery) : []), [ready, trimmedQuery]);
  const groups = useMemo(
    () => [
      {
        id: "products",
        label: cs.search.suggestions,
        items: results.slice(0, 6).map(({ product, matchingVariants }) => {
          const variant = matchingVariants.length === 1 ? matchingVariants[0] : undefined;
          const params = new URLSearchParams({ variant: variant?.sku ?? trimmedQuery });

          return {
            value: product.id,
            label: variant ? `${product.name} – ${variant.label}` : product.name,
            href: `/produkt/${product.slug}${matchingVariants.length ? `?${params}#product-variants` : ""}`,
            data: {
              imageSrc: variant?.imageSrc ?? product.imageSrc,
              variantSku: variant?.sku,
              priceMinor: variant?.priceMinor ?? product.priceMinor,
              priceIsFrom: !variant && product.detail.variants.length > 0,
              currency: product.currency,
            },
          };
        }),
      },
    ],
    [results, trimmedQuery],
  );
  const resultsHref = `/vyhledavani?q=${encodeURIComponent(trimmedQuery)}`;

  const submit = () => {
    if (!trimmedQuery) return;
    setOpen(false);
    router.push(resultsHref);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (
      event.key === "Enter" &&
      event.target instanceof HTMLInputElement &&
      !event.nativeEvent.isComposing &&
      !event.target.getAttribute("aria-activedescendant")
    ) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <SearchForm
      action="/vyhledavani"
      className="whitespace-normal"
      method="get"
      onKeyDown={handleKeyDown}
      onSubmit={submit}
      size="md"
    >
      <Label className="sr-only" htmlFor={`${id}-input`}>
        {cs.search.label}
      </Label>
      <input name="q" type="hidden" value={query} />
      <SearchForm.Control>
        {/* SearchSuggestions has no trigger-visibility prop; the existing submit button owns this action. */}
        <div className="min-w-0 flex-1 [&_[data-part=trigger]]:hidden [&_[data-part=control]]:rounded-e-none">
          <SearchSuggestions
            clearable={false}
            groups={groups}
            id={id}
            inputValue={query}
            navigate={({ href }) => {
              setOpen(false);
              const destination = new URL(href, window.location.origin);
              router.push(`${destination.pathname}${destination.search}${destination.hash}`);
            }}
            noResultsMessage={cs.search.noResults}
            onInputValueChange={(value) => {
              setQuery(value);
              setOpen(value.trim().length >= 2);
            }}
            onOpenChange={setOpen}
            open={open && ready}
            placeholder={cs.search.placeholder}
            size="md"
            allResultsLink={
              <Link as={NextLink} href={resultsHref} onClick={() => setOpen(false)}>
                {cs.search.allResults(results.length)}
              </Link>
            }
            resultSlot={(item) =>
              item.data && (
                <span className="flex w-full min-w-0 items-center gap-(--dimension-12)">
                  <Image
                    alt=""
                    className="size-(--dimension-48) shrink-0 rounded-sm bg-base object-contain"
                    height={48}
                    src={item.data.imageSrc}
                    width={48}
                  />
                  <span className="grid min-w-0 flex-1 gap-(--dimension-4)">
                    <span className="line-clamp-2 whitespace-normal text-sm leading-tight">
                      {item.label}
                    </span>
                    {item.data.variantSku && (
                      <span className="truncate text-xs">
                        {cs.product.sku}: {item.data.variantSku}
                      </span>
                    )}
                  </span>
                  <strong className="shrink-0 whitespace-nowrap text-sm">
                    {item.data.priceIsFrom && `${cs.product.from} `}
                    {formatPrice(item.data.priceMinor, item.data.currency)}
                  </strong>
                </span>
              )
            }
          />
        </div>
        <SearchForm.Button aria-label={cs.actions.search} iconSize="lg" showSearchIcon />
      </SearchForm.Control>
    </SearchForm>
  );
}
