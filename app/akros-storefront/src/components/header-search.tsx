"use client";

import Image from "next/image";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { Link } from "@techsio/ui-kit/atoms/link";
import { Label } from "@techsio/ui-kit/atoms/label";
import { Icon } from "@techsio/ui-kit/atoms/icon";
import { SearchForm } from "@techsio/ui-kit/molecules/search-form";
import {
  SearchSuggestions,
  type SearchSuggestionGroup,
} from "@techsio/ui-kit/templates/search-suggestions";

import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import { normalizeCatalogSearchTerm } from "@/lib/product-variant-search";
import { useCatalog, useDataSource } from "@/ontos/catalog-provider";
import type { RemoteCategorySuggestion, RemoteSearchResponse } from "@/ontos/search-suggestions";

type SuggestionData =
  | { kind: "category"; trail: string }
  | {
      kind: "product";
      imageSrc: string;
      variantSku?: string;
      priceMinor: number;
      priceIsFrom: boolean;
      currency: "CZK";
    };

export function HeaderSearch() {
  const { getCategories, getCategoryTrail, searchCatalog } = useCatalog();
  const searchableCategories = getCategories().map((category) => ({
    category,
    normalizedName: normalizeCatalogSearchTerm(category.name),
  }));

  const router = useRouter();
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const trimmedQuery = query.trim();
  const ready = trimmedQuery.length >= 2;
  // OntOS mode: the browser only holds featured products, so product suggestions come from the BFF.
  const ontos = useDataSource() === "ontos";
  const [remote, setRemote] = useState<
    RemoteSearchResponse & {
      query: string;
      categories: RemoteCategorySuggestion[];
      /** Set when the OntOS search failed: shown as an error with „Zkusit znovu“, never as 0 results. */
      error?: string;
    }
  >({
    query: "",
    items: [],
    total: 0,
    categories: [],
  });
  const [searchAttempt, setSearchAttempt] = useState(0);
  useEffect(() => {
    if (!ontos || !ready) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch("/api/ontos/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: trimmedQuery }),
        signal: controller.signal,
      })
        .then(async (response) => {
          const body = (await response
            .json()
            .catch(() => ({}))) as Partial<RemoteSearchResponse> & {
            message?: unknown;
          };
          if (!response.ok || !Array.isArray(body.items))
            throw new Error(
              typeof body.message === "string" && body.message
                ? body.message
                : "Vyhledávání v OntOS je teď nedostupné.",
            );
          return body;
        })
        .then((body) =>
          setRemote({
            query: trimmedQuery,
            items: body.items ?? [],
            total: typeof body.total === "number" ? body.total : 0,
            categories: Array.isArray(body.categories) ? body.categories : [],
          }),
        )
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setRemote({
            query: trimmedQuery,
            items: [],
            total: 0,
            categories: [],
            error:
              error instanceof Error && error.name !== "TypeError" && error.message
                ? error.message
                : "Vyhledávání v OntOS je teď nedostupné.",
          });
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [ontos, ready, trimmedQuery, searchAttempt]);
  const remoteCurrent = ontos && remote.query === trimmedQuery;
  const searchError = remoteCurrent ? remote.error : undefined;
  const searchLoading = ontos && ready && !remoteCurrent;
  const remoteItems = useMemo(
    () => (ontos && remote.query === trimmedQuery ? remote.items : []),
    [ontos, remote, trimmedQuery],
  );
  const remoteTotal = ontos && remote.query === trimmedQuery ? remote.total : 0;
  // OntOS mode: the browser holds only the navigation, so category matches come from the BFF too.
  const remoteCategories = useMemo(
    () => (ontos && remote.query === trimmedQuery ? remote.categories : []),
    [ontos, remote, trimmedQuery],
  );
  const results = useMemo(
    () => (ready && !ontos ? searchCatalog(trimmedQuery) : []),
    [ready, ontos, trimmedQuery],
  );
  const categories = useMemo(() => {
    if (!ready || ontos) return [];
    const normalizedQuery = normalizeCatalogSearchTerm(trimmedQuery);
    const rank = (normalizedName: string) => {
      return normalizedName === normalizedQuery
        ? 0
        : normalizedName.startsWith(normalizedQuery)
          ? 1
          : 2;
    };
    return searchableCategories
      .filter(({ normalizedName }) => normalizedName.includes(normalizedQuery))
      .sort((left, right) => rank(left.normalizedName) - rank(right.normalizedName))
      .slice(0, 4)
      .map(({ category }) => category);
  }, [ready, ontos, trimmedQuery]);
  const groups = useMemo<SearchSuggestionGroup<SuggestionData>[]>(
    () => [
      {
        id: "categories",
        label: cs.search.categories,
        items: ontos
          ? remoteCategories.map((category) => ({
              value: `category:${category.id}`,
              label: category.name,
              href: `/kategorie/${category.slug}`,
              data: { kind: "category" as const, trail: category.trail },
            }))
          : categories.map((category) => ({
              value: `category:${category.id}`,
              label: category.name,
              href: `/kategorie/${category.slug}`,
              data: {
                kind: "category",
                trail: getCategoryTrail(category)
                  .slice(0, -1)
                  .map((parent) => parent.name)
                  .join(" › "),
              },
            })),
      },
      {
        id: "products",
        label: cs.search.suggestions,
        items: ontos
          ? remoteItems.map((item) => {
              const params = new URLSearchParams({ variant: item.variant?.sku ?? trimmedQuery });
              return {
                value: `product:${item.productId}`,
                label: item.variant ? `${item.name} – ${item.variant.label}` : item.name,
                href: `/produkt/${item.slug}${item.matchingVariantCount ? `?${params}#product-variants` : ""}`,
                data: {
                  kind: "product",
                  imageSrc: item.imageSrc,
                  variantSku: item.variant?.sku,
                  priceMinor: item.priceMinor,
                  priceIsFrom: item.priceIsFrom,
                  currency: item.currency,
                },
              };
            })
          : results.slice(0, 6).map(({ product, matchingVariants }) => {
              const variant = matchingVariants.length === 1 ? matchingVariants[0] : undefined;
              const params = new URLSearchParams({ variant: variant?.sku ?? trimmedQuery });

              return {
                value: `product:${product.id}`,
                label: variant ? `${product.name} – ${variant.label}` : product.name,
                href: `/produkt/${product.slug}${matchingVariants.length ? `?${params}#product-variants` : ""}`,
                data: {
                  kind: "product",
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
    [categories, ontos, remoteCategories, remoteItems, results, trimmedQuery],
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
        <div className="min-w-0 flex-1 [&_[data-part=trigger]]:hidden [&_[data-part=content]]:max-h-[min(70vh,var(--dimension-container-xl),var(--available-height))]">
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
            noResultsMessage={cs.search.noSuggestions}
            loading={searchLoading}
            loadingMessage="Hledám v katalogu OntOS…"
            error={
              searchError ? (
                <span data-akros-search-error="">
                  <strong>Vyhledávání se nepodařilo.</strong> {searchError}
                </span>
              ) : undefined
            }
            retryLabel="Zkusit znovu"
            onRetry={() => {
              setRemote((current) => ({ ...current, query: "", error: undefined }));
              setSearchAttempt((attempt) => attempt + 1);
            }}
            onInputValueChange={(value) => {
              setQuery(value);
              setOpen(value.trim().length >= 2);
            }}
            onOpenChange={setOpen}
            open={open && ready}
            placeholder={cs.search.placeholder}
            size="md"
            allResultsLink={
              searchError || searchLoading ? undefined : (
                <Link as={NextLink} href={resultsHref} onClick={() => setOpen(false)}>
                  {cs.search.allResults(ontos ? remoteTotal : results.length)}
                </Link>
              )
            }
            resultSlot={(item) =>
              item.data && (
                <span
                  data-akros-search-result=""
                  className="flex w-full min-w-0 items-center gap-(--dimension-12)"
                >
                  {item.data.kind === "category" ? (
                    <span className="flex size-(--dimension-32) shrink-0 items-center justify-center rounded-sm bg-(--color-fill-surface)">
                      <Icon icon="icon-[mdi--folder-outline]" size="lg" />
                    </span>
                  ) : (
                    <Image
                      alt=""
                      className="size-(--dimension-48) shrink-0 rounded-sm bg-base object-contain"
                      height={48}
                      src={item.data.imageSrc}
                      width={48}
                    />
                  )}
                  <span
                    data-akros-search-result-label=""
                    className="grid min-w-0 flex-1 gap-(--dimension-4)"
                  >
                    <span className="line-clamp-2 whitespace-normal text-sm leading-tight">
                      {item.label}
                    </span>
                    {item.data.kind === "category" && item.data.trail && (
                      <span className="truncate text-xs text-(--color-fg-secondary)">
                        {item.data.trail}
                      </span>
                    )}
                    {item.data.kind === "product" && item.data.variantSku && (
                      <span className="truncate text-xs">
                        {cs.product.sku}: {item.data.variantSku}
                      </span>
                    )}
                  </span>
                  {item.data.kind === "product" ? (
                    <strong className="shrink-0 whitespace-nowrap text-sm">
                      {item.data.priceIsFrom && `${cs.product.from} `}
                      {formatPrice(item.data.priceMinor, item.data.currency)}
                    </strong>
                  ) : (
                    <Icon className="shrink-0" icon="token-icon-chevron-right" size="sm" />
                  )}
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
