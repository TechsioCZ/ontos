"use client";

import { useEffect, useRef, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import NextImage from "next/image";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Link } from "@/features/plain-link";
import { Image } from "@techsio/ui-kit/atoms/image";
import { LineItem } from "@techsio/ui-kit/organisms/line-item";
import { PriceBlock } from "@techsio/ui-kit/molecules/price-block";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { StatusText } from "@techsio/ui-kit/atoms/status-text";
import { CartSummary } from "./cart-summary";
import { EmptyCartView } from "./empty-cart-view";
import type { Dictionary } from "@/i18n";
import type { CartQuote } from "@/ontos/cart-quote";
import { publicImage } from "@/ontos/catalog-model";
import { useCart } from "./cart-provider";
import { CartQuoteFeedback } from "./cart-quote-feedback";
import { requestForCart } from "./cart-quote-request";
import { verifiedCartQuote } from "./cart-quote-state";
import { cartLineKey, cartQuantityMaximum, cartQuantityStep } from "./cart-state";
import type { CartEntry } from "./cart-state";
import { useCartQuote } from "./use-cart-quote";

import {
  cartIssueText,
  cartEntryWithStock,
  hasInvalidCartDraft,
  issuesForCartEntry,
  invalidCartQuantityText,
  quantityDraftForEntry,
  reconcileQuantityDrafts,
  removeQuantityDraft,
  validCartQuantity,
} from "./cart-validation";
import type { QuantityDraft, QuantityDrafts } from "./cart-validation";

const issueText = (code: string, d: Dictionary) =>
  cartIssueText(code, d.shopping.issues, d.shopping.rejected);
const money = (amount: number, locale: string, currency = "CZK") =>
  new Intl.NumberFormat(locale, { currency, style: "currency" }).format(amount / 100);

const EMPTY_CART_ENTRIES: readonly CartEntry[] = [];

const quantityErrorText = (
  invalid: boolean,
  saveError: boolean,
  draft: QuantityDraft | undefined,
  d: Dictionary,
  entry: CartEntry,
) => {
  let error: string | undefined;
  if (invalid) {
    error = invalidCartQuantityText(Number(draft?.value ?? entry.quantity), entry, d);
  } else if (saveError || draft?.saveError === true) {
    error = d.shopping.addFailed;
  }
  return error;
};

const CartRow = ({
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
  const [saveError, setSaveError] = useState(false);
  const value = draft?.value ?? String(entry.quantity);
  const quantity = Number(value);
  const maximum = cartQuantityMaximum(entry.stockQuantity, entry.packageQuantity);
  const invalid = !validCartQuantity(
    quantity,
    entry.minimumQuantity,
    entry.packageQuantity,
    maximum,
  );
  const image = publicImage(entry.image ?? undefined, cart?.imageHosts ?? []);
  const changedPrice = issues.find(
    (issue) => issue.code === "PRICE_CHANGED",
  )?.currentUnitPriceMinor;
  const pathname = `/${locale}/produkt/${encodeURIComponent(entry.slug)}`;
  const href =
    entry.variantId === undefined
      ? pathname
      : `${pathname}?${new URLSearchParams({ variantId: entry.variantId })}`;
  const quantityError = quantityErrorText(invalid, saveError, draft, d, entry);
  const feedbackId = `cart-${encodeURIComponent(cartLineKey(entry))}-feedback`;
  const uniqueIssues = [...new Map(issues.map((issue) => [issue.code, issue])).values()];
  return (
    <LineItem title={entry.name}>
      {image !== null && (
        <LineItem.Image className="hidden n1-compact:block">
          <Image alt="" as={NextImage} height={96} src={image} width={96} />
        </LineItem.Image>
      )}
      <LineItem.Body className="col-span-full n1-compact:col-span-1">
        <LineItem.Heading>
          <LineItem.Title>
            <Link as={NextLink} href={href}>
              {entry.name}
            </Link>
          </LineItem.Title>
          <LineItem.Price>
            <PriceBlock
              amountLabel={money(entry.expectedUnitPriceMinor, locale, cart?.scope?.currency)}
              state="known"
            />
          </LineItem.Price>
        </LineItem.Heading>
        <LineItem.Options>
          {entry.variantName}
          {entry.sku ? ` · ${entry.sku}` : ""}
        </LineItem.Options>
        <LineItem.Controls>
          <LineItem.Quantity readOnlyLabel={`${entry.quantity} ${entry.unit}`}>
            <div className="n1-product-quantity-desktop flex items-center gap-2">
              <NumericInput
                allowOverflow={false}
                clampValueOnBlur
                className="w-26 pointer-coarse:w-40"
                density="compact"
                disabled={cart === null}
                formatOptions={{ maximumFractionDigits: 20, useGrouping: false }}
                invalid={quantityError !== undefined}
                locale={locale}
                max={Math.max(entry.minimumQuantity ?? 0.001, maximum)}
                min={entry.minimumQuantity ?? 0.001}
                onValueChange={({ value: next }) => {
                  const parsed = Number(next);
                  const valid = validCartQuantity(
                    parsed,
                    entry.minimumQuantity,
                    entry.packageQuantity,
                    maximum,
                  );
                  const saved = valid && (cart?.update(entry, parsed) ?? false);
                  onDraft({
                    quantity: saved ? parsed : entry.quantity,
                    saveError: valid && !saved,
                    value: next,
                  });
                  setSaveError(false);
                }}
                size="md"
                step={cartQuantityStep(entry.packageQuantity)}
                value={value}
              >
                <NumericInput.Control>
                  <NumericInput.DecrementTrigger
                    aria-label={d.shopping.decreaseQuantity}
                    icon="token-icon-minus"
                    iconSize="sm"
                  />
                  <NumericInput.Input
                    aria-describedby={feedbackId}
                    aria-label={`${d.quantity}: ${entry.name}`}
                  />
                  <NumericInput.IncrementTrigger
                    aria-label={d.shopping.increaseQuantity}
                    icon="token-icon-plus"
                    iconSize="sm"
                  />
                </NumericInput.Control>
              </NumericInput>
              <span>{entry.unit}</span>
            </div>
          </LineItem.Quantity>
          <LineItem.Actions>
            <LineItem.Remove
              label={d.shopping.remove}
              onClick={onRemove}
              size="md"
              theme="borderless"
              variant="tertiary"
            />
          </LineItem.Actions>
        </LineItem.Controls>
        <div id={feedbackId}>
          {quantityError !== undefined && <StatusText status="error">{quantityError}</StatusText>}
        </div>
        {uniqueIssues.map((issue) => (
          <p className="text-sm" key={issue.code}>
            {issueText(issue.code, d)}
          </p>
        ))}
        {changedPrice !== undefined && changedPrice > 0 && (
          <Button
            onClick={() => {
              const accepted = cart?.acceptPrice(entry, changedPrice) ?? false;
              setSaveError(!accepted);
            }}
            size="md"
            theme="outlined"
            variant="secondary"
          >
            {d.shopping.acceptPrice}: {money(changedPrice, locale, cart?.scope?.currency)}
          </Button>
        )}
      </LineItem.Body>
    </LineItem>
  );
};

type Cart = ReturnType<typeof useCart>;
type Quote = ReturnType<typeof useCartQuote>;
const emptyCart = (cart: Cart) =>
  cart !== null && cart.scope !== null && cart.loaded && cart.entries.length === 0 && !cart.error;
const CartContent = ({
  cart,
  dictionary: d,
  drafts,
  invalid,
  locale,
  mutationError,
  onDraft,
  onRemove,
  quote,
}: {
  cart: Cart;
  dictionary: Dictionary;
  drafts: QuantityDrafts;
  invalid: boolean;
  locale: string;
  mutationError: boolean;
  onDraft: (entry: CartEntry, draft: QuantityDraft) => void;
  onRemove: (entry: CartEntry) => void;
  quote: Quote;
}) => {
  const router = useRouter();
  if (cart === null || cart.scope === null) {
    return (
      <>
        <p>{d.shopping.scopeUnavailable}</p>
        <Button onClick={() => router.refresh()} size="md" theme="outlined" variant="secondary">
          {d.contact.retry}
        </Button>
      </>
    );
  }
  if (!cart.loaded) {
    return <output>{d.shopping.loading}</output>;
  }
  if (cart.error) {
    return (
      <>
        <p role="alert">{d.shopping.storageError}</p>
        <Button onClick={() => cart.clear()} size="md" theme="outlined" variant="secondary">
          {d.shopping.clear}
        </Button>
      </>
    );
  }
  const verified = verifiedCartQuote(quote, invalid);
  return (
    <>
      <CartQuoteFeedback dictionary={d} invalid={invalid} quote={quote} />
      {mutationError && <p role="alert">{d.shopping.addFailed}</p>}
      {quote.state === "scope-mismatch" && (
        <Button onClick={() => router.refresh()} size="md" theme="outlined" variant="secondary">
          {d.contact.retry}
        </Button>
      )}
      <div className="grid min-w-0 gap-8 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          {cart.entries.map((entry) => (
            <CartRow
              dictionary={d}
              draft={quantityDraftForEntry(drafts, entry)}
              entry={cartEntryWithStock(
                entry,
                quote.stocks,
                quote.state === "ready" && quote.result?.stocks !== undefined,
              )}
              issues={issuesForCartEntry(quote.result?.issues ?? [], entry)}
              key={cartLineKey(entry)}
              locale={locale}
              onDraft={(value) => onDraft(entry, value)}
              onRemove={() => onRemove(entry)}
            />
          ))}
        </div>
        <CartSummary
          currency={cart.scope.currency}
          dictionary={d}
          invalid={invalid}
          locale={locale}
          quote={quote}
          verified={verified}
        />
      </div>
    </>
  );
};
/** This stage edits a cart and verifies goods; it never places an order. */
export const CartView = ({ dictionary: d, locale }: { dictionary: Dictionary; locale: string }) => {
  const cart = useCart();
  const [drafts, setDrafts] = useState<QuantityDrafts>({});
  const [mutationError, setMutationError] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [removal, setRemoval] = useState(0);
  const entries = cart?.entries ?? EMPTY_CART_ENTRIES;
  const reconciledDrafts = reconcileQuantityDrafts(drafts, entries);
  if (reconciledDrafts !== drafts) {
    setDrafts(reconciledDrafts);
  }
  // Quote the saved selection; unfinished input is gated separately below.
  const quote = useCartQuote(requestForCart(cart, locale, false), true);
  const invalid = hasInvalidCartDraft(
    drafts,
    entries.map((entry) =>
      cartEntryWithStock(
        entry,
        quote.stocks,
        quote.state === "ready" && quote.result?.stocks !== undefined,
      ),
    ),
  );
  useEffect(() => {
    if (removal > 0 && document.activeElement === document.body) {
      heading.current?.focus();
    }
  }, [removal]);
  if (emptyCart(cart)) {
    return <EmptyCartView dictionary={d} headingRef={heading} locale={locale} />;
  }
  return (
    <article className="mx-auto flex min-h-n1-cart-empty-mobile max-w-n1-product-content md:min-h-n1-cart-empty flex-col gap-4 p-5">
      <h1 className="text-xl font-bold" ref={heading} tabIndex={-1}>
        {d.cart}
      </h1>
      <CartContent
        cart={cart}
        dictionary={d}
        drafts={drafts}
        invalid={invalid}
        locale={locale}
        mutationError={mutationError}
        onDraft={(entry, draft) =>
          setDrafts((previous) => ({ ...previous, [cartLineKey(entry)]: draft }))
        }
        onRemove={(entry) => {
          const success = cart?.remove(entry) ?? false;
          setMutationError(!success);
          if (success) {
            setDrafts((previous) => removeQuantityDraft(previous, entry));
            setRemoval((value) => value + 1);
          }
        }}
        quote={quote}
      />
    </article>
  );
};
