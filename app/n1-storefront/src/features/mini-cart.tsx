"use client";

import { useEffect, useRef, useState } from "react";
import NextImage from "next/image";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { Struct } from "effect";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Badge } from "@techsio/ui-kit/atoms/badge";
import { Image } from "@techsio/ui-kit/atoms/image";
import { Link } from "@techsio/ui-kit/atoms/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { Popover } from "@techsio/ui-kit/molecules/popover";
import { PriceBlock } from "@techsio/ui-kit/molecules/price-block";
import { TotalsSummary } from "@techsio/ui-kit/molecules/totals-summary";
import type { Dictionary } from "@/i18n";
import type { CartQuote } from "@/ontos/cart-quote";
import { publicImage } from "@/ontos/catalog-model";
import { useCart } from "./cart-provider";
import { CartQuoteFeedback } from "./cart-quote-feedback";
import { cartLineKey, cartQuantityStep } from "./cart-state";
import type { CartEntry } from "./cart-state";
import {
  cartIssueText,
  hasInvalidCartDraft,
  issuesForCartEntry,
  quantityDraftForEntry,
  reconcileQuantityDrafts,
  removeQuantityDraft,
  validCartQuantity,
} from "./cart-validation";
import type { QuantityDraft, QuantityDrafts } from "./cart-validation";
import { miniCartState } from "./header-panel-state";
import { useCartQuote } from "./use-cart-quote";

const noEntries: readonly CartEntry[] = [];
const cartCountFormats = {
  cs: new Intl.NumberFormat("cs", { maximumSignificantDigits: 15 }),
  en: new Intl.NumberFormat("en", { maximumSignificantDigits: 15 }),
};
const cartCount = (entries: readonly CartEntry[], locale: string) => {
  const quantity = entries.reduce((total, entry) => total + entry.quantity, 0);
  const label = cartCountFormats[locale === "en" ? "en" : "cs"].format(quantity);
  return { badge: quantity > 99 ? "99+" : label, label };
};

const MiniCartTrigger = ({
  count,
  state,
  title,
}: {
  count: ReturnType<typeof cartCount>;
  state: ReturnType<typeof miniCartState>;
  title: string;
}) => (
  <Popover.Trigger
    aria-label={state === "filled" ? `${title} (${count.label})` : title}
    size="current"
    theme="unstyled"
    variant="tertiary"
  >
    <span className="relative inline-flex">
      <Image alt="" as={NextImage} height={28} size="custom" src="/brand/cart.svg" width={28} />
      {state === "filled" && (
        <span className="n1-cart-count absolute -right-2 -top-2 grid min-h-5 min-w-5">
          <Badge aria-hidden="true" size="sm" variant="primary">
            {count.badge}
          </Badge>
        </span>
      )}
    </span>
    <span aria-atomic="true" aria-live="polite" className="sr-only">
      {state === "filled" || state === "empty" ? `${title}: ${count.label}` : ""}
    </span>
  </Popover.Trigger>
);
const formatMoney = (amount: number, currency: string, locale: string) =>
  new Intl.NumberFormat(locale, { currency, style: "currency" }).format(amount / 100);

const MiniCartLine = ({
  dictionary: d,
  draft,
  entry,
  issues,
  locale,
  onDraft,
  onRemove,
}: {
  dictionary: Dictionary;
  draft: QuantityDraft | undefined;
  entry: CartEntry;
  issues: CartQuote["issues"];
  locale: string;
  onDraft: (draft: QuantityDraft) => void;
  onRemove: () => void;
}) => {
  const cart = useCart();
  const value = draft?.value ?? String(entry.quantity);
  const invalid = !validCartQuantity(Number(value), entry.minimumQuantity, entry.packageQuantity);
  const inputId = `mini-cart-${encodeURIComponent(cartLineKey(entry))}`;
  const image = publicImage(entry.image ?? undefined, cart?.imageHosts ?? []);
  const href = `/${locale}/produkt/${encodeURIComponent(entry.slug)}`;
  const target =
    entry.variantId === undefined
      ? href
      : `${href}?${new URLSearchParams({ variantId: entry.variantId })}`;
  const issueMessages = [
    ...new Set(
      issues.map((issue) => cartIssueText(issue.code, d.shopping.issues, d.shopping.rejected)),
    ),
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-start gap-3">
        <div className="relative h-16 w-16 shrink-0">
          {image !== null && (
            <Image alt="" as={NextImage} fill objectFit="contain" sizes="64px" src={image} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <Link as={NextLink} href={target}>
            {entry.name}
          </Link>
          <p className="truncate text-xs">{entry.variantName}</p>
          <PriceBlock
            amountLabel={formatMoney(
              entry.expectedUnitPriceMinor,
              cart?.scope?.currency ?? "CZK",
              locale,
            )}
            state="known"
          />
        </div>
        <div className="w-23 shrink-0 self-center">
          <NumericInput
            allowOverflow={false}
            clampValueOnBlur={false}
            disabled={cart === null}
            id={inputId}
            invalid={invalid || draft?.saveError === true}
            locale={locale}
            max={1_000_000}
            min={entry.minimumQuantity ?? 0.001}
            onValueChange={({ value: next }) => {
              const quantity = Number(next);
              const valid = validCartQuantity(
                quantity,
                entry.minimumQuantity,
                entry.packageQuantity,
              );
              const saved = valid && (cart?.update(entry, quantity) ?? false);
              onDraft({
                quantity: saved ? quantity : entry.quantity,
                saveError: valid && !saved,
                value: next,
              });
            }}
            size="sm"
            step={cartQuantityStep(entry.packageQuantity)}
            value={value}
          >
            <div className="flex w-7 shrink-0">
              <NumericInput.DecrementTrigger
                aria-label={d.shopping.decreaseQuantity}
                block
                icon="token-icon-minus"
                theme="outlined"
                variant="secondary"
              />
            </div>
            <div className="w-9 shrink-0">
              <NumericInput.Control>
                <NumericInput.Input
                  aria-describedby={`${inputId}-feedback`}
                  aria-label={`${d.quantity}: ${entry.name}`}
                />
              </NumericInput.Control>
            </div>
            <div className="flex w-7 shrink-0">
              <NumericInput.IncrementTrigger
                aria-label={d.shopping.increaseQuantity}
                block
                icon="token-icon-plus"
                theme="outlined"
                variant="secondary"
              />
            </div>
          </NumericInput>
        </div>
        <div className="flex h-7 w-7 shrink-0">
          <Button
            aria-label={`${d.shopping.remove}: ${entry.name}`}
            block
            icon="token-icon-trash"
            iconSize="sm"
            onClick={onRemove}
            size="current"
            theme="borderless"
            variant="secondary"
          />
        </div>
      </div>
      <div className="text-sm" id={`${inputId}-feedback`}>
        {invalid && (
          <p>
            {d.shopping.invalidQuantity}
            {entry.minimumQuantity !== undefined &&
              ` ${d.minimumQuantity}: ${entry.minimumQuantity} ${entry.unit}`}
          </p>
        )}
        {draft?.saveError === true && <p>{d.shopping.addFailed}</p>}
        {issueMessages.map((message) => (
          <p key={message}>{message}</p>
        ))}
      </div>
    </div>
  );
};

const MiniCartTotals = ({
  currency,
  dictionary: d,
  locale,
  quote,
}: {
  currency: string;
  dictionary: Dictionary;
  locale: string;
  quote: ReturnType<typeof useCartQuote>;
}) => {
  let net = d.shopping.unresolved;
  let vat = d.shopping.unresolved;
  let total = d.shopping.unresolved;
  if (
    quote.state === "ready" &&
    quote.result?.outcome === "VALID" &&
    quote.result.totalMinor !== null &&
    quote.result.totalVatMinor !== null
  ) {
    total = formatMoney(quote.result.totalMinor, currency, locale);
    net = formatMoney(quote.result.totalMinor - quote.result.totalVatMinor, currency, locale);
    vat = formatMoney(quote.result.totalVatMinor, currency, locale);
  }
  return (
    <TotalsSummary
      className="n1-mini-cart-totals"
      footer={d.shopping.feesNote}
      rows={[
        { id: "net", label: d.shopping.net, value: net },
        { id: "shipping", label: d.shopping.shipping, value: d.shopping.chooseShipping },
        { id: "vat", label: d.shopping.vat, value: vat },
      ]}
      totalLabel={d.shopping.subtotal}
      totalValue={total}
    />
  );
};

const MiniCartStatus = ({
  dictionary: d,
  onClear,
  onContinue,
  onRefresh,
  state,
}: {
  dictionary: Dictionary;
  onClear: () => void;
  onContinue: () => void;
  onRefresh: () => void;
  state: Exclude<ReturnType<typeof miniCartState>, "filled">;
}) => (
  <div className="flex flex-col items-center gap-3 text-center">
    <Image alt="" as={NextImage} height={24} size="custom" src="/brand/cart-empty.svg" width={24} />
    {state === "empty" && (
      <>
        <p className="text-md leading-n1-copy font-medium">{d.shopping.emptyPreview}</p>
        <p className="text-sm leading-n1-copy text-fg-secondary">
          {d.shopping.emptyPreviewDescription}
        </p>
      </>
    )}
    {state === "loading" && <output>{d.shopping.loading}</output>}
    {state === "unavailable" && <p>{d.shopping.scopeUnavailable}</p>}
    {state === "error" && (
      <>
        <p role="alert">{d.shopping.storageError}</p>
        <Button onClick={onClear} size="sm" theme="outlined" variant="secondary">
          {d.shopping.clear}
        </Button>
      </>
    )}
    {state === "unavailable" && (
      <Button onClick={onRefresh} size="sm" theme="outlined" variant="secondary">
        {d.contact.retry}
      </Button>
    )}
    <Button
      block
      density="compact"
      onClick={onContinue}
      size="sm"
      theme="solid"
      variant="secondary"
    >
      {d.shopping.continueShopping}
    </Button>
  </div>
);

/** A real scoped local selection; missing owner context never masquerades as an empty cart. */
export const MiniCart = ({
  dictionary: d,
  locale,
  onOpenChange,
  open,
}: {
  dictionary: Dictionary;
  locale: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) => {
  const cart = useCart();
  const router = useRouter();
  const state = miniCartState(cart);
  const entries = cart?.entries ?? noEntries;
  const count = cartCount(entries, locale);
  const [storedDrafts, setStoredDrafts] = useState<QuantityDrafts>({});
  const drafts = reconcileQuantityDrafts(storedDrafts, entries);
  if (drafts !== storedDrafts) {
    setStoredDrafts(drafts);
  }
  const invalid = hasInvalidCartDraft(drafts, entries);
  const request =
    open && state === "filled" && cart?.scope !== null && cart !== null && !invalid
      ? {
          lines: entries.map((entry) =>
            Struct.pick(entry, ["productId", "variantId", "quantity", "expectedUnitPriceMinor"]),
          ),
          locale: locale === "en" ? ("en" as const) : ("cs" as const),
          scope: cart.scope,
        }
      : null;
  const quote = useCartQuote(request, true);
  const [removal, setRemoval] = useState(0);
  const [mutationError, setMutationError] = useState(false);
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (removal > 0 && document.activeElement === document.body) {
      heading.current?.focus();
    }
  }, [removal]);
  const continueShopping = () => onOpenChange(false);
  return (
    <Popover
      border
      onOpenChange={({ open: next }) => onOpenChange(next)}
      open={open}
      placement="bottom-end"
      shadow={false}
      size="sm"
    >
      <MiniCartTrigger count={count} state={state} title={d.cart} />
      <Popover.Positioner>
        <Popover.Content className="n1-header-popover">
          <Popover.Arrow />
          <div className="flex w-n1-header-panel-content max-w-n1-header-panel-viewport flex-col gap-4">
            <Popover.Title ref={heading} tabIndex={-1}>
              {d.cart}
              {state === "filled" ? ` (${count.label})` : ""}
            </Popover.Title>
            {state === "filled" && cart?.scope && (
              <>
                {entries.map((entry) => (
                  <MiniCartLine
                    dictionary={d}
                    draft={quantityDraftForEntry(drafts, entry)}
                    entry={entry}
                    issues={issuesForCartEntry(quote.result?.issues ?? [], entry)}
                    key={cartLineKey(entry)}
                    locale={locale}
                    onDraft={(draft) =>
                      setStoredDrafts((previous) => ({ ...previous, [cartLineKey(entry)]: draft }))
                    }
                    onRemove={() => {
                      const removed = cart.remove(entry);
                      setMutationError(!removed);
                      if (removed) {
                        setStoredDrafts((previous) => removeQuantityDraft(previous, entry));
                        setRemoval((value) => value + 1);
                      }
                    }}
                  />
                ))}
                <CartQuoteFeedback dictionary={d} invalid={invalid} quote={quote} />
                {mutationError && <p role="alert">{d.shopping.addFailed}</p>}
                {quote.state === "scope-mismatch" && (
                  <Button
                    onClick={() => router.refresh()}
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                  >
                    {d.contact.retry}
                  </Button>
                )}
                <hr className="border-0 border-t border-border-secondary" />
                <MiniCartTotals
                  currency={cart.scope.currency}
                  dictionary={d}
                  locale={locale}
                  quote={quote}
                />
                <div className="flex flex-col gap-3">
                  <LinkButton
                    as={NextLink}
                    block
                    href={`/${locale}/kosik`}
                    onClick={continueShopping}
                    size="md"
                    theme="solid"
                    variant="secondary"
                  >
                    {d.shopping.openCart}
                  </LinkButton>
                  <Button
                    block
                    density="compact"
                    onClick={continueShopping}
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                  >
                    {d.shopping.continueShopping}
                  </Button>
                </div>
              </>
            )}
            {state !== "filled" && (
              <MiniCartStatus
                dictionary={d}
                onClear={() => cart?.clear()}
                onContinue={continueShopping}
                onRefresh={() => router.refresh()}
                state={state}
              />
            )}
          </div>
        </Popover.Content>
      </Popover.Positioner>
    </Popover>
  );
};
