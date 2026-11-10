// The product exceptions of a market's price list. Switches and search change only the section's draft; its Save sends them.
import { pageDataPending } from '@app/shared-contracts/page-data';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Effect, Fiber } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import type { OfferEdit } from './assortment-save.ts';
import { failureText, useMarketText } from './market-ui.tsx';
import { EXCEPTIONS_PAGE_SIZE, marketExceptionsData, searchProducts, writeFailure } from './page-data.ts';
import type { ExceptionsInput, WriteFailure } from './page-data.ts';

type SearchResult = Effect.Success<ReturnType<typeof searchProducts>>['products'];

export type SetOffer = (productId: string, name: string, offered: boolean, currentlyOffered: boolean) => void;

export interface ExceptionsBlockProps {
  readonly canManage: boolean;
  readonly input: ExceptionsInput;
  readonly offeredByDefault: boolean;
  /** The section's draft offers: a changed product shows its drafted state until Save. */
  readonly offers: Readonly<Record<string, OfferEdit>>;
  readonly onOffset: (offset: number) => void;
  readonly onSetOffer: SetOffer;
}

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
  return (
    <ul className="divide-y divide-border-primary/60">
      {items.map((product) => {
        const edit: OfferEdit | undefined = offers[product.productId];
        const offered = edit?.offered ?? product.offered;
        const handleCheckedChange = (checked: boolean) =>
          onSetOffer(product.productId, product.name, checked, product.offered);
        return (
          <li className="flex flex-wrap items-center justify-between gap-150 py-100" key={product.productId}>
            <ProductLabel name={product.name} sku={product.sku} />
            <Switch
              checked={offered}
              disabled={!canManage}
              name={`market-offer-${product.sku}`}
              onCheckedChange={handleCheckedChange}
            >
              {text(offered ? 'detail.assortment.exceptions.offered' : 'detail.assortment.exceptions.notOffered')}
            </Switch>
          </li>
        );
      })}
    </ul>
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
      <Button disabled={offset === 0} onClick={handlePrevious} size="sm" theme="outlined" variant="secondary">
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
        disabled={offset + EXCEPTIONS_PAGE_SIZE >= total}
        onClick={handleNext}
        size="sm"
        theme="outlined"
        variant="secondary"
      >
        {text('detail.assortment.exceptions.next')}
      </Button>
    </div>
  );
};

/** Search the catalogue and make a product an exception (withdraw it, or add it to a selected-products market). */
const ProductSearch = ({
  offeredByDefault,
  onSetOffer,
}: Pick<ExceptionsBlockProps, 'offeredByDefault' | 'onSetOffer'>) => {
  const { text } = useMarketText();
  const [search, setSearch] = useState('');
  const results = useProductSearch(search);
  return (
    <div className="flex flex-col gap-100">
      <FormInput
        id="market-product-search"
        label={text('detail.assortment.exceptions.search')}
        name="productSearch"
        onChange={(event) => setSearch(event.target.value)}
        placeholder={text('detail.assortment.exceptions.searchPlaceholder')}
        size="sm"
        value={search}
      />
      {results?.kind === 'failed' && <StatusText status="error">{failureText(text, results.failure)}</StatusText>}
      {results?.kind === 'found' && results.products.length === 0 && (
        <p className="text-fg-secondary text-sm">{text('detail.assortment.exceptions.noResults')}</p>
      )}
      {results?.kind === 'found' && results.products.length > 0 && (
        <ul className="divide-y divide-border-primary/60">
          {results.products.map((product) => {
            // A product found by search is not an exception yet: it has the market's default offer.
            const handleClick = () => onSetOffer(product.id, product.name, !offeredByDefault, offeredByDefault);
            return (
              <li className="flex flex-wrap items-center justify-between gap-150 py-100" key={product.id}>
                <ProductLabel name={product.name} sku={product.sku} />
                <Button onClick={handleClick} size="sm" theme="outlined" variant="secondary">
                  {text(
                    offeredByDefault ? 'detail.assortment.exceptions.withdraw' : 'detail.assortment.exceptions.add',
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
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
