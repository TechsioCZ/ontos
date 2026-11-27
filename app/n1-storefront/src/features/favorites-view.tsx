"use client";

import NextImage from "next/image";
import NextLink from "next/link";
import { useEffect, useState } from "react";
import { Effect } from "effect";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { StatusText } from "@techsio/ui-kit/atoms/status-text";
import { AvailabilityStatus } from "@techsio/ui-kit/molecules/availability-status";
import { PriceBlock } from "@techsio/ui-kit/molecules/price-block";
import { ProductCard } from "@techsio/ui-kit/molecules/product-card";
import { useToast } from "@techsio/ui-kit/molecules/toast";
import type { Dictionary } from "@/i18n";
import type { CardVariantsResult, FavoriteCard } from "@/ontos/card-variants";
import { loadFavoriteCard } from "@/ontos/card-variants-client";
import { clientRuntime } from "@/ontos/client-runtime";
import { Link } from "./plain-link";
import { priceProps } from "./price-props";
import { favoriteKey, setFavorite, useFavorites } from "./favorites-store";
import type { FavoriteReference } from "./favorites-store";

type CatalogItem = Extract<CardVariantsResult, { state: "ready" }>;

const loadFavorites = (references: readonly FavoriteReference[], locale: "cs" | "en") => {
  const queries = new Map<string, FavoriteReference>();
  for (const reference of references) {
    queries.set(JSON.stringify([reference.productId, reference.slug]), reference);
  }
  return Effect.forEach(
    queries,
    ([key, { productId, slug }]) =>
      loadFavoriteCard({ locale, productId, slug }).pipe(
        Effect.match({
          onFailure: () => [key, null] as const,
          onSuccess: (result) => [key, result.state === "ready" ? result : null] as const,
        }),
      ),
    { concurrency: 4 },
  ).pipe(Effect.map((results) => new Map(results)));
};

const resolveFavorite = (product: CatalogItem | null | undefined, variantId: string | null) => {
  const variant = product?.variants.find((item) => item.id === variantId);
  return {
    card: variantId === null ? product?.favoriteCard : variant?.favoriteCard,
    label: variant?.name,
  };
};

const FavoriteRow = ({
  card,
  dictionary: d,
  label,
  locale,
  reference,
}: {
  card?: FavoriteCard | undefined;
  dictionary: Dictionary;
  label?: string | undefined;
  locale: string;
  reference: FavoriteReference;
}) => {
  const toaster = useToast();
  const search =
    reference.variantId === null
      ? ""
      : `?${new URLSearchParams({ variantId: reference.variantId })}`;
  const href = `/${locale}/produkt/${encodeURIComponent(reference.slug)}${search}`;
  const remove = () => {
    const success = setFavorite(reference, false);
    toaster.create({
      title: success ? d.favoriteItems.removed : d.favoriteItems.saveFailed,
      type: success ? "success" : "error",
    });
  };
  const removeButton = (
    <Button appearance="outline" onClick={remove} severity="secondary" size="sm" type="button">
      {d.favoriteItems.remove}
    </Button>
  );
  if (card === undefined) {
    return (
      <section className="grid gap-2 rounded-xs border border-border-secondary p-4">
        <p className="break-all">{reference.slug}</p>
        <StatusText showIcon status="warning">
          {d.favoriteItems.missing}
        </StatusText>
        <div>{removeButton}</div>
      </section>
    );
  }
  return (
    <ProductCard layout="column" shadow={false}>
      {card.image === null ? (
        <p className="py-12 text-center text-fg-secondary">{d.imageUnavailable}</p>
      ) : (
        <div className="relative aspect-4/3 w-full">
          <ProductCard.Image
            alt={card.name}
            as={NextImage}
            fill
            loading="lazy"
            objectFit="contain"
            sizes="(max-width: 639px) 100vw, (max-width: 1023px) 50vw, 33vw"
            src={card.image}
          />
        </div>
      )}
      <ProductCard.Name>
        <Link as={NextLink} href={href}>
          {card.name}
        </Link>
      </ProductCard.Name>
      {label !== undefined && label !== card.name && <p>{label}</p>}
      <PriceBlock {...priceProps(card, d, locale, card.priceExcludingVatMinor ?? null)} />
      <AvailabilityStatus label={d.stock[card.stock]} status={card.stock} />
      <ProductCard.Actions>{removeButton}</ProductCard.Actions>
    </ProductCard>
  );
};

export const FavoritesView = ({
  dictionary: d,
  locale,
}: {
  dictionary: Dictionary;
  locale: "cs" | "en";
}) => {
  const { available, ready, references } = useFavorites();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    attempt: number;
    catalog: ReadonlyMap<string, CatalogItem | null>;
    locale: string;
    references: readonly FavoriteReference[];
  }>();
  useEffect(() => {
    const fiber =
      references.length === 0
        ? null
        : clientRuntime.runFork(
            loadFavorites(references, locale).pipe(
              Effect.tap((catalog) =>
                Effect.sync(() => setLoaded({ attempt, catalog, locale, references })),
              ),
            ),
          );
    return () => fiber?.interruptUnsafe();
  }, [attempt, locale, references]);
  const rows = references.map((reference) => ({
    ...resolveFavorite(
      loaded?.catalog.get(JSON.stringify([reference.productId, reference.slug])),
      reference.variantId,
    ),
    reference,
  }));
  const pending =
    !ready ||
    (references.length > 0 &&
      (loaded?.references !== references ||
        loaded.locale !== locale ||
        loaded.attempt !== attempt));
  let body;
  if (!available) {
    body = (
      <StatusText showIcon status="error">
        {d.favoriteItems.storageUnavailable}
      </StatusText>
    );
  } else if (pending) {
    body = <output>{d.favoriteItems.loading}</output>;
  } else if (references.length === 0) {
    body = (
      <div className="grid justify-items-start gap-4">
        <p>{d.favoriteItems.empty}</p>
        <LinkButton as={NextLink} href={`/${locale}`} severity="primary">
          {d.favoriteItems.browse}
        </LinkButton>
      </div>
    );
  } else {
    body = (
      <>
        {rows.some(({ card }) => card === undefined) && (
          <div>
            <Button
              appearance="outline"
              onClick={() => setAttempt((value) => value + 1)}
              severity="secondary"
            >
              {d.favoriteItems.retry}
            </Button>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(({ card, label, reference }) => (
            <FavoriteRow
              card={card}
              dictionary={d}
              key={favoriteKey(reference)}
              label={label}
              locale={locale}
              reference={reference}
            />
          ))}
        </div>
      </>
    );
  }
  return (
    <section className="mx-auto grid max-w-n1-product-content gap-5 p-4 md:py-6">
      <h1 className="text-xl font-bold">{d.favorites}</h1>
      {body}
    </section>
  );
};
