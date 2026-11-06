"use client";

import NextImage from "next/image";
import NextLink from "next/link";
import type { ReactNode } from "react";
import { Image } from "@techsio/ui-kit/atoms/image";
import { Link } from "@techsio/ui-kit/atoms/link";
import { RadioCard } from "@techsio/ui-kit/molecules/radio-card";
import { TotalsSummary } from "@techsio/ui-kit/molecules/totals-summary";
import type { Dictionary } from "@/i18n";
import type { CheckoutResult } from "@/ontos/checkout";
import type { CheckoutOptions } from "@/ontos/checkout-server";
import { publicImage } from "@/ontos/catalog-model";
import { cartLineKey } from "./cart-state";
import type { CartEntry } from "./cart-state";
import { formatMarketAmount } from "./price-props";

type ReadyOptions = Extract<CheckoutOptions, { state: "ready" }>;

export const CheckoutShipping = ({
  dictionary: d,
  disabled,
  locale,
  onChange,
  options,
  value,
}: {
  dictionary: Dictionary;
  disabled: boolean;
  locale: string;
  onChange: (value: string | null) => void;
  options: ReadyOptions;
  value: string | null;
}) => (
  <section className="min-w-0 rounded-xs border border-border-secondary bg-fill-surface p-4">
    <h2 className="mb-4 text-lg font-semibold">{d.checkout.shipping}</h2>
    <RadioCard
      disabled={disabled}
      name="shippingMethod"
      onValueChange={onChange}
      required
      size="sm"
      value={value}
      variant="outline"
    >
      <div className="sr-only">
        <RadioCard.Label>{d.checkout.shipping}</RadioCard.Label>
      </div>
      <div className="grid min-w-0 gap-2 md:grid-cols-2">
        {options.shippingMethods.map((method) => (
          <RadioCard.Item key={method.id} value={method.id}>
            <RadioCard.ItemHiddenInput />
            <RadioCard.ItemControl>
              <RadioCard.ItemContent>
                <div className="flex w-full min-w-0 justify-between gap-2">
                  <RadioCard.ItemText>{method.title}</RadioCard.ItemText>
                  <p className="shrink-0 text-sm">
                    {formatMarketAmount(method.priceMinor, locale, options.scope.currency)}
                  </p>
                </div>
                <RadioCard.ItemDescription>
                  {d.fulfillment.shippingDescriptions[method.id]}
                </RadioCard.ItemDescription>
              </RadioCard.ItemContent>
            </RadioCard.ItemControl>
          </RadioCard.Item>
        ))}
      </div>
    </RadioCard>
    {options.shippingMethods.length === 0 && <p>{d.fulfillment.noShipping}</p>}
  </section>
);

export const CheckoutItems = ({
  currency,
  dictionary: d,
  entries,
  imageHosts,
  locale,
  result,
}: {
  currency: ReadyOptions["scope"]["currency"];
  dictionary: Dictionary;
  entries: readonly CartEntry[];
  imageHosts: readonly string[];
  locale: string;
  result: CheckoutResult | null;
}) => {
  const verified = result !== null && result.outcome !== "REJECTED";
  const rows = verified
    ? result.lines
    : entries.map((entry) => ({ ...entry, unitPriceMinor: entry.expectedUnitPriceMinor }));
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {rows.map((line) => {
        const entry = entries.find((item) => cartLineKey(item) === cartLineKey(line));
        const presentation = result?.productPresentation?.find(
          (item) => item.productId === line.productId,
        );
        const image = publicImage(entry?.image ?? presentation?.image ?? undefined, imageHosts);
        const variantSuffix =
          line.variantId === undefined
            ? ""
            : `?${new URLSearchParams({ variantId: line.variantId })}`;
        const slug = entry?.slug ?? presentation?.slug;
        const target =
          slug === undefined
            ? null
            : `/${locale}/produkt/${encodeURIComponent(slug)}${variantSuffix}`;
        return (
          <div className="flex min-w-0 items-start gap-2" key={cartLineKey(line)}>
            {image !== null && (
              <div className="relative size-(--dimension-64) shrink-0">
                <Image alt="" as={NextImage} fill objectFit="contain" sizes="64px" src={image} />
              </div>
            )}
            <div className="min-w-0 flex-1">
              {target === null ? (
                <p>{line.name}</p>
              ) : (
                <Link as={NextLink} href={target}>
                  {line.name}
                </Link>
              )}
              {line.variantName !== undefined && line.variantName !== "" && (
                <p className="text-xs text-fg-secondary">{line.variantName}</p>
              )}
              <p className="text-xs text-fg-secondary">
                {d.checkout.quantity}: {line.quantity}
              </p>
            </div>
            <p className="shrink-0 text-sm font-semibold">
              {formatMarketAmount(line.unitPriceMinor, locale, currency)}
            </p>
          </div>
        );
      })}
    </div>
  );
};

export const CheckoutTotals = ({
  actions,
  currency,
  dictionary: d,
  locale,
  result,
}: {
  actions?: ReactNode;
  currency: ReadyOptions["scope"]["currency"];
  dictionary: Dictionary;
  locale: string;
  result: CheckoutResult | null;
}) => {
  const known =
    result !== null &&
    result.outcome !== "REJECTED" &&
    result.totalMinor !== null &&
    result.totalVatMinor !== null &&
    result.shippingPriceMinor !== null;
  const money = (amount: number) => formatMarketAmount(amount, locale, currency);
  const { unresolved } = d.shopping;
  return (
    <TotalsSummary
      actions={actions}
      rows={[
        {
          id: "net",
          label: d.checkout.netIncludesShipping,
          value: known ? money(result.totalMinor - result.totalVatMinor) : unresolved,
        },
        {
          id: "vat",
          label: d.shopping.vat,
          value: known ? money(result.totalVatMinor) : unresolved,
        },
        {
          id: "shipping",
          label: d.checkout.shippingIncluded,
          value: known ? money(result.shippingPriceMinor) : unresolved,
        },
      ]}
      totalLabel={d.checkout.total}
      totalValue={known ? money(result.totalMinor) : unresolved}
    />
  );
};
