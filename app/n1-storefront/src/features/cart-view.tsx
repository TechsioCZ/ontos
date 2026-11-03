"use client";

import { useEffect, useRef, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import NextImage from "next/image";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Link } from "@techsio/ui-kit/atoms/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Image } from "@techsio/ui-kit/atoms/image";
import { LineItem } from "@techsio/ui-kit/organisms/line-item";
import { PriceBlock } from "@techsio/ui-kit/molecules/price-block";
import { QuantityField } from "@techsio/ui-kit/molecules/quantity-field";
import { CartSummary } from "./cart-summary";
import type { Dictionary } from "@/i18n";
import type { CartQuoteRequest, CartQuote } from "@/ontos/cart-quote";
import { publicImage } from "@/ontos/catalog-model";
import { useCart } from "./cart-provider";
import { cartLineKey } from "./cart-state";
import type { CartEntry } from "./cart-state";
import { useCartQuote } from "./use-cart-quote";

import {
  cartIssueText,
  globalCartIssues,
  hasInvalidCartDraft,
  issuesForCartEntry,
  quantityDraftForEntry,
  reconcileQuantityDrafts,
  removeQuantityDraft,
  validCartQuantity,
} from "./cart-validation";
import type { QuantityDraft, QuantityDrafts } from "./cart-validation";

const issueText = (code: string, d: Dictionary) =>
  cartIssueText(code, d.shopping.issues, d.shopping.rejected);
const money = (amount: number, locale: string, currency: string) =>
  new Intl.NumberFormat(locale, { currency, style: "currency" }).format(amount / 100);

const EMPTY_CART_ENTRIES: readonly CartEntry[] = [];

const quantityErrorText = (
  invalid: boolean,
  saveError: boolean,
  draft: QuantityDraft | undefined,
  d: Dictionary,
) => {
  let error: string | undefined;
  if (invalid) {
    error = d.shopping.invalidQuantity;
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
  const invalid = !validCartQuantity(quantity);
  const image = publicImage(entry.image ?? undefined, cart?.imageHosts ?? []);
  const changedPrice = issues.find(
    (issue) => issue.code === "PRICE_CHANGED",
  )?.currentUnitPriceMinor;
  const pathname = `/${locale}/produkt/${encodeURIComponent(entry.slug)}`;
  const href =
    entry.variantId === undefined
      ? pathname
      : `${pathname}?${new URLSearchParams({ variantId: entry.variantId })}`;
  const quantityError = quantityErrorText(invalid, saveError, draft, d);
  const uniqueIssues = [...new Map(issues.map((issue) => [issue.code, issue])).values()];
  return (
    <LineItem title={entry.name}>
      {image !== null && (
        <LineItem.Image>
          <Image alt="" as={NextImage} height={64} src={image} width={64} />
        </LineItem.Image>
      )}
      <LineItem.Body>
        <LineItem.Heading>
          <LineItem.Title>
            <Link as={NextLink} href={href}>
              {entry.name}
            </Link>
          </LineItem.Title>
          <LineItem.Price>
            <PriceBlock
              amountLabel={money(
                entry.expectedUnitPriceMinor,
                locale,
                cart?.scope?.currency ?? "CZK",
              )}
              state="known"
            />
            <p className="text-xs text-fg-secondary">{d.shopping.draftPrice}</p>
          </LineItem.Price>
        </LineItem.Heading>
        <LineItem.Options>
          {entry.variantName}
          {entry.sku ? ` · ${entry.sku}` : ""}
        </LineItem.Options>
        <LineItem.Controls>
          <LineItem.Quantity readOnlyLabel={`${entry.quantity} ${entry.unit}`}>
            <QuantityField
              error={quantityError}
              label={`${d.quantity}: ${entry.name}`}
              max={1_000_000}
              min={0.001}
              onValueChange={({ value: next }) => {
                const parsed = Number(next);
                const valid = validCartQuantity(parsed);
                const saved = valid && (cart?.update(entry, parsed) ?? false);
                onDraft({
                  quantity: saved ? parsed : entry.quantity,
                  saveError: valid && !saved,
                  value: next,
                });
                setSaveError(false);
              }}
              size="md"
              step={1}
              unitLabel={entry.unit}
              value={value}
            />
          </LineItem.Quantity>
          <LineItem.Actions>
            <LineItem.Remove label={`${d.shopping.remove}: ${entry.name}`} onClick={onRemove} />
          </LineItem.Actions>
        </LineItem.Controls>
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
            {d.shopping.acceptPrice}: {money(changedPrice, locale, cart?.scope?.currency ?? "CZK")}
          </Button>
        )}
      </LineItem.Body>
    </LineItem>
  );
};

type Cart = ReturnType<typeof useCart>;
type Quote = ReturnType<typeof useCartQuote>;
const requestForCart = (cart: Cart, locale: string, invalid: boolean): CartQuoteRequest | null => {
  if (
    cart === null ||
    cart.scope === null ||
    !cart.loaded ||
    cart.entries.length === 0 ||
    invalid
  ) {
    return null;
  }
  return {
    lines: cart.entries.map((entry) => {
      const line = {
        expectedUnitPriceMinor: entry.expectedUnitPriceMinor,
        productId: entry.productId,
        quantity: entry.quantity,
      };
      if (entry.variantId === undefined) {
        return line;
      }
      return { ...line, variantId: entry.variantId };
    }),
    locale: locale === "en" ? "en" : "cs",
    scope: cart.scope,
  };
};
const cartNotice = (quote: Quote, invalid: boolean, d: Dictionary) => {
  if (invalid) {
    return d.shopping.invalidDraft;
  }
  if (quote.state === "pending") {
    return d.shopping.checking;
  }
  if (quote.state === "scope-mismatch") {
    return d.shopping.marketChanged;
  }
  if (quote.state === "unavailable") {
    return d.shopping.unavailable;
  }
  if (quote.result?.outcome === "VALID") {
    return d.shopping.verified;
  }
  if (quote.result?.outcome === "REJECTED") {
    return d.shopping.rejected;
  }
  return d.shopping.unverified;
};
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
  if (cart.entries.length === 0) {
    return (
      <>
        <p className="text-fg-secondary">{d.shopping.emptyDescription}</p>
        <div>
          <LinkButton as={NextLink} href={`/${locale}`} size="md" theme="solid" variant="primary">
            {d.shopping.backHome}
          </LinkButton>
        </div>
      </>
    );
  }
  const verified =
    quote.state === "ready" && quote.result?.outcome === "VALID" && !invalid ? quote.result : null;
  return (
    <>
      <output aria-live="polite">{cartNotice(quote, invalid, d)}</output>
      {mutationError && <p role="alert">{d.shopping.addFailed}</p>}
      {quote.state === "scope-mismatch" && (
        <Button onClick={() => router.refresh()} size="md" theme="outlined" variant="secondary">
          {d.contact.retry}
        </Button>
      )}
      {[...new Set(globalCartIssues(quote.result?.issues ?? []).map((issue) => issue.code))].map(
        (code) => (
          <p key={code}>{issueText(code, d)}</p>
        ),
      )}
      <div className="grid min-w-0 gap-8 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          {cart.entries.map((entry) => (
            <CartRow
              dictionary={d}
              draft={quantityDraftForEntry(drafts, entry)}
              entry={entry}
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
  const invalid = hasInvalidCartDraft(drafts, entries);
  const reconciledDrafts = reconcileQuantityDrafts(drafts, entries);
  if (reconciledDrafts !== drafts) {
    setDrafts(reconciledDrafts);
  }
  const quote = useCartQuote(requestForCart(cart, locale, invalid));
  useEffect(() => {
    if (removal > 0 && document.activeElement === document.body) {
      heading.current?.focus();
    }
  }, [removal]);
  return (
    <article className="mx-auto flex min-h-n1-cart-empty-mobile max-w-n1-product-content md:min-h-n1-cart-empty flex-col gap-4 p-5">
      <h1 className="text-xl font-bold" ref={heading} tabIndex={-1}>
        {emptyCart(cart) ? d.shopping.empty : d.cart}
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
