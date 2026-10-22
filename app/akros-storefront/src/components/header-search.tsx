"use client";

import Image from "next/image";
import StoreLink from "@/components/store-link";
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
import { describeOfferPrice } from "@/lib/format";
import type { RemoteCategorySuggestion, RemoteSearchResponse } from "@/ontos/search-suggestions";

type SuggestionData =
  | { kind: "category"; trail: string }
  | {
      kind: "product";
      imageSrc: string;
      priceMinor: number;
      priceIsFrom: boolean;
      priceUnavailableReason?: string;
      currency: "CZK";
    };

export function HeaderSearch() {
  const router = useRouter();
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const trimmedQuery = query.trim();
  const ready = trimmedQuery.length >= 2;
  // The browser only holds featured products and navigation, so all suggestions come from the BFF.
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
    if (!ready) return;
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
  }, [ready, trimmedQuery, searchAttempt]);
  const remoteCurrent = remote.query === trimmedQuery;
  const searchError = remoteCurrent ? remote.error : undefined;
  const searchLoading = ready && !remoteCurrent;
  const remoteItems = useMemo(() => (remoteCurrent ? remote.items : []), [remoteCurrent, remote]);
  const remoteTotal = remoteCurrent ? remote.total : 0;
  const remoteCategories = useMemo(
    () => (remoteCurrent ? remote.categories : []),
    [remoteCurrent, remote],
  );
  const groups = useMemo<SearchSuggestionGroup<SuggestionData>[]>(
    () => [
      {
        id: "categories",
        label: cs.search.categories,
        items: remoteCategories.map((category) => ({
          value: `category:${category.id}`,
          label: category.name,
          href: `/kategorie/${category.slug}`,
          data: { kind: "category" as const, trail: category.trail },
        })),
      },
      {
        id: "products",
        label: cs.search.suggestions,
        items: remoteItems.map((item) => {
          // A variant group opens with its variant table filtered by the query (when a variant matches).
          const params = new URLSearchParams({ variant: trimmedQuery });
          return {
            value: `product:${item.productId}`,
            label: item.name,
            href: `/produkt/${item.slug}${item.hasVariants ? `?${params}` : ""}`,
            data: {
              kind: "product",
              imageSrc: item.imageSrc,
              priceMinor: item.priceMinor,
              priceIsFrom: item.priceIsFrom,
              priceUnavailableReason: item.priceUnavailableReason,
              currency: item.currency,
            },
          };
        }),
      },
    ],
    [remoteCategories, remoteItems, trimmedQuery],
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
                <Link as={StoreLink} href={resultsHref} onClick={() => setOpen(false)}>
                  {cs.search.allResults(remoteTotal)}
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
                  </span>
                  {item.data.kind === "product" ? (
                    <SuggestionPrice {...item.data} />
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

function SuggestionPrice(data: Extract<SuggestionData, { kind: "product" }>) {
  const price = describeOfferPrice(data);
  return price.available ? (
    <strong className="shrink-0 whitespace-nowrap text-sm">{price.label}</strong>
  ) : (
    <span
      className="shrink-0 whitespace-nowrap text-xs text-(--color-fg-secondary)"
      data-akros-search-price-unavailable=""
      title={price.reason}
    >
      {price.label}
    </span>
  );
}
