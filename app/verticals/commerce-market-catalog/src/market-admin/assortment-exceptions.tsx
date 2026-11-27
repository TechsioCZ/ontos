// The product exceptions of a market's price list. Switches and search change only the section's draft; its Save sends them.
import {
  EntrySwitchField,
  FormBuilder,
  FormReact,
  FormRoot,
  TextField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { pageDataPending } from '@app/shared-contracts/page-data';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Fiber, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { browserAtomRuntime, browserRuntime } from '../runtime/browser-effect-runtime.ts';
import type { OfferEdit } from './assortment-save.ts';
import { failureText, useMarketText } from './market-ui.tsx';
import { EXCEPTIONS_PAGE_SIZE, marketExceptionsData, searchProducts, writeFailure } from './page-data.ts';
import type { ExceptionsInput, WriteFailure } from './page-data.ts';

type SearchResult = Effect.Success<ReturnType<typeof searchProducts>>['products'];

/** `currentlyOffered` is the offer as read; a search hit leaves it out, as it did not read the offer. */
export type SetOffer = (productId: string, name: string, offered: boolean, currentlyOffered?: boolean) => void;

export interface ExceptionsBlockProps {
  readonly canManage: boolean;
  readonly input: ExceptionsInput;
  readonly offeredByDefault: boolean;
  /** The section's draft offers: a changed product shows its drafted state until Save. */
  readonly offers: Readonly<Record<string, OfferEdit>>;
  readonly onOffset: (offset: number) => void;
  readonly onSetOffer: SetOffer;
}

/**
 * The offer switches of the shown page: one entry per product, as the section's draft shows it. A switch changes only
 * the draft, so the form itself is never submitted.
 */
const offersForm = FormReact.make(FormBuilder.empty.addField('offers', Schema.Record(Schema.String, Schema.Boolean)), {
  fields: { offers: EntrySwitchField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});

type ShownOffers = Readonly<Record<string, boolean>>;

const sameOffers = (left: ShownOffers, right: ShownOffers): boolean =>
  Object.keys(left).length === Object.keys(right).length &&
  Object.entries(left).every(([productId, offered]) => right[productId] === offered);

/** The catalogue search text; it only narrows the products listed under it and is never submitted. */
const productSearchForm = FormReact.make(FormBuilder.empty.addField('search', Schema.String), {
  fields: { search: TextField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});

const searchText = productSearchForm
  .getFieldAtoms(productSearchForm.fields.search)
  .value.pipe(Atom.map(Option.getOrElse(() => '')));

const SEARCH_DELAY = '400 millis';
const SEARCH_MIN_LENGTH = 2;

type SearchState =
  | { readonly failure: WriteFailure; readonly kind: 'failed'; readonly search: string }
  | { readonly kind: 'found'; readonly products: SearchResult; readonly search: string };

/** Products matching the typed text, loaded after a short pause in typing; none for a too short text. */
const useProductSearch = (search: string) => {
  const trimmed = search.trim();
  const [state, setState] = useState<SearchState | null>(null);
  useEffect(() => {
    const fiber = browserRuntime.runFork(
      trimmed.length < SEARCH_MIN_LENGTH
        ? Effect.void
        : Effect.sleep(SEARCH_DELAY).pipe(
            Effect.andThen(searchProducts(trimmed)),
            Effect.match({
              onFailure: (error) => setState({ failure: writeFailure(error), kind: 'failed', search: trimmed }),
              onSuccess: (found) => setState({ kind: 'found', products: found.products, search: trimmed }),
            }),
          ),
    );
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [trimmed]);
  return trimmed.length < SEARCH_MIN_LENGTH || state?.search !== trimmed ? null : state;
};

const ProductLabel = ({ name, sku }: { readonly name: string; readonly sku: string }) => (
  <span className="text-sm">
    <span className="font-medium">{name}</span>
    <span className="text-fg-secondary"> · {sku}</span>
  </span>
);

interface ListedProduct {
  readonly name: string;
  readonly offered: boolean;
  readonly productId: string;
}

/**
 * Keeps the switches and the section's draft one set of offers: a switch changes the draft, and a draft that moves
 * without a switch (Zahodit změny, the latest version, a refresh) moves the switches. Rendered inside the form, after
 * it started.
 */
const OffersDraft = ({
  items,
  onSetOffer,
  shown,
}: {
  readonly items: readonly ListedProduct[];
  readonly onSetOffer: SetOffer;
  readonly shown: ShownOffers;
}) => {
  const values = useAtomValue(offersForm.values);
  const setValues = useAtomSet(offersForm.setValues);
  useAtomSubscribe(
    offersForm.values,
    (next) => {
      if (Option.isNone(next)) {
        return;
      }
      for (const product of items) {
        const offered = next.value.offers[product.productId];
        if (offered !== undefined && offered !== shown[product.productId]) {
          onSetOffer(product.productId, product.name, offered, product.offered);
        }
      }
    },
    { immediate: false },
  );
  useEffect(() => {
    if (Option.exists(values, (current) => !sameOffers(current.offers, shown))) {
      setValues({ offers: shown });
    }
  }, [setValues, shown, values]);
  return null;
};

/** The products that are the exception of the market's offer mode, one page at a time. */
const ExceptionsList = ({
  canManage,
  input,
  offers,
  onSetOffer,
}: Pick<ExceptionsBlockProps, 'canManage' | 'input' | 'offers' | 'onSetOffer'>) => {
  const { text } = useMarketText();
  const exceptions = useSyncExternalStore(
    marketExceptionsData.subscribe,
    () => marketExceptionsData.snapshot(input),
    () => pageDataPending,
  );
  const { legalEntityId, marketId, offset, tenantId } = input;
  useEffect(
    () => marketExceptionsData.ensure({ legalEntityId, marketId, offset, tenantId }),
    [legalEntityId, marketId, offset, tenantId],
  );
  if (exceptions.state === 'failed') {
    return <StatusText status="error">{text('detail.assortment.unavailable')}</StatusText>;
  }
  if (exceptions.state === 'pending') {
    return <StatusText>{text('detail.loading')}</StatusText>;
  }
  const items = exceptions.value.marketExceptions?.items ?? [];
  if (items.length === 0) {
    return <p className="text-fg-secondary text-sm">{text('detail.assortment.exceptions.empty')}</p>;
  }
  // A changed product shows its drafted offer until Save.
  const shown: ShownOffers = Object.fromEntries(
    items.map((product) => {
      const edit: OfferEdit | undefined = offers[product.productId];
      return [product.productId, edit?.offered ?? product.offered];
    }),
  );
  return (
    <FormRoot
      // Another page starts its own switches.
      defaultValues={{ offers: shown }}
      form={offersForm}
      key={items.map((product) => product.productId).join('|')}
      translateMessage={(message) => text(message)}
    >
      <OffersDraft items={items} onSetOffer={onSetOffer} shown={shown} />
      <ul className="divide-y divide-border-primary/60">
        {items.map((product) => (
          <li className="flex flex-wrap items-center justify-between gap-150 py-100" key={product.productId}>
            <ProductLabel name={product.name} sku={product.sku} />
            <offersForm.offers
              disabled={!canManage}
              entry={product.productId}
              label={text(
                shown[product.productId] === true
                  ? 'detail.assortment.exceptions.offered'
                  : 'detail.assortment.exceptions.notOffered',
              )}
              name={`market-offer-${product.sku}`}
            />
          </li>
        ))}
      </ul>
    </FormRoot>
  );
};

/** Previous / next page of the exceptions, shown only when they do not fit one page. */
const ExceptionsPager = ({
  input,
  onOffset,
}: {
  readonly input: ExceptionsInput;
  readonly onOffset: (offset: number) => void;
}) => {
  const { text } = useMarketText();
  const exceptions = useSyncExternalStore(
    marketExceptionsData.subscribe,
    () => marketExceptionsData.snapshot(input),
    () => pageDataPending,
  );
  const total = exceptions.state === 'ready' ? (exceptions.value.marketExceptions?.total ?? 0) : 0;
  if (total <= EXCEPTIONS_PAGE_SIZE) {
    return null;
  }
  const { offset } = input;
  const handlePrevious = () => onOffset(Math.max(0, offset - EXCEPTIONS_PAGE_SIZE));
  const handleNext = () => onOffset(offset + EXCEPTIONS_PAGE_SIZE);
  return (
    <div className="flex items-center gap-150 text-sm">
      <Button appearance="outline" disabled={offset === 0} onClick={handlePrevious} severity="secondary" size="sm">
        {text('detail.assortment.exceptions.previous')}
      </Button>
      <span>
        {text('detail.assortment.exceptions.page', {
          from: offset + 1,
          to: Math.min(total, offset + EXCEPTIONS_PAGE_SIZE),
          total,
        })}
      </span>
      <Button
        appearance="outline"
        disabled={offset + EXCEPTIONS_PAGE_SIZE >= total}
        onClick={handleNext}
        severity="secondary"
        size="sm"
      >
        {text('detail.assortment.exceptions.next')}
      </Button>
    </div>
  );
};

/** The products matching the search text; rendered inside the search form, after it started. */
const SearchResults = ({
  offeredByDefault,
  onSetOffer,
}: Pick<ExceptionsBlockProps, 'offeredByDefault' | 'onSetOffer'>) => {
  const { text } = useMarketText();
  const search = useAtomValue(searchText);
  const results = useProductSearch(search);
  return (
    <>
      {results?.kind === 'failed' && <StatusText status="error">{failureText(text, results.failure)}</StatusText>}
      {results?.kind === 'found' && results.products.length === 0 && (
        <p className="text-fg-secondary text-sm">{text('detail.assortment.exceptions.noResults')}</p>
      )}
      {results?.kind === 'found' && results.products.length > 0 && (
        <ul className="divide-y divide-border-primary/60">
          {results.products.map((product) => {
            // A search hit may already be an exception: its offer is not known here, so none is claimed as read.
            const handleClick = () => onSetOffer(product.id, product.name, !offeredByDefault);
            return (
              <li className="flex flex-wrap items-center justify-between gap-150 py-100" key={product.id}>
                <ProductLabel name={product.name} sku={product.sku} />
                <Button appearance="outline" onClick={handleClick} severity="secondary" size="sm" type="button">
                  {text(
                    offeredByDefault ? 'detail.assortment.exceptions.withdraw' : 'detail.assortment.exceptions.add',
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
};

/** Search the catalogue and make a product an exception (withdraw it, or add it to a selected-products market). */
const ProductSearch = ({
  offeredByDefault,
  onSetOffer,
}: Pick<ExceptionsBlockProps, 'offeredByDefault' | 'onSetOffer'>) => {
  const { text } = useMarketText();
  return (
    <FormRoot
      className="flex flex-col gap-100"
      defaultValues={{ search: '' }}
      form={productSearchForm}
      translateMessage={(message) => text(message)}
    >
      <productSearchForm.search
        id="market-product-search"
        label={text('detail.assortment.exceptions.search')}
        name="productSearch"
        placeholder={text('detail.assortment.exceptions.searchPlaceholder')}
        size="sm"
      />
      <SearchResults offeredByDefault={offeredByDefault} onSetOffer={onSetOffer} />
    </FormRoot>
  );
};

/** The exceptions block of the price list: the hint, the list of the page, its pager and the product search. */
export const ExceptionsBlock = ({
  canManage,
  input,
  offeredByDefault,
  offers,
  onOffset,
  onSetOffer,
}: ExceptionsBlockProps) => {
  const { text } = useMarketText();
  return (
    <section className="flex flex-col gap-150">
      <h3 className="font-semibold text-sm">{text('detail.assortment.exceptions.title')}</h3>
      <p className="text-fg-secondary text-sm">
        {text(
          offeredByDefault ? 'detail.assortment.exceptions.wholeHint' : 'detail.assortment.exceptions.selectedHint',
        )}
      </p>
      <ExceptionsList canManage={canManage} input={input} offers={offers} onSetOffer={onSetOffer} />
      <ExceptionsPager input={input} onOffset={onOffset} />
      {canManage && <ProductSearch offeredByDefault={offeredByDefault} onSetOffer={onSetOffer} />}
    </section>
  );
};
