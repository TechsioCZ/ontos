// "Sortiment a ceník" of the market detail: the merchandise price list of the market and its product exceptions
// (DESIGN 3.2). Commands go through the merchandise apply-command Action; switches are disabled for non-managers.
import { AutosaveStatus, SectionCard, useAutosaveDraft } from '@app/admin-ui';
import type { RevisionedSaveResult } from '@app/admin-ui';
import type { MarketSettings } from '@app/merchandise/domain/market-offers';
import type { RecordsResponse } from '@app/merchandise/contracts/records';
import { pageDataPending } from '@app/shared-contracts/page-data';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Effect, Fiber } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import type { CurrentMarket } from './eshops-model.ts';
import { PricingFields } from './market-fields.tsx';
import { configureMarketCommand, defaultPricingForm, pricingFormOf, pricingIssues } from './market-form.ts';
import type { MarketPricingForm } from './market-form.ts';
import { failureText, useMarketText } from './market-ui.tsx';
import {
  EXCEPTIONS_PAGE_SIZE,
  marketExceptionsData,
  merchandiseCommand,
  runMerchandiseCommand,
  searchProducts,
  writeFailure,
} from './page-data.ts';
import type { ExceptionsInput, MarketInput, WriteFailure } from './page-data.ts';

type SearchResult = Effect.Success<ReturnType<typeof searchProducts>>['products'];

interface AssortmentSectionProps {
  readonly input: MarketInput;
  readonly market: CurrentMarket;
  readonly onDone: (message: string) => void;
  readonly records: RecordsResponse | undefined;
  readonly recordsFailed: boolean;
  /** Re-reads the price lists (records `markets`). */
  readonly refreshSettings: Effect.Effect<void>;
}

interface PriceListProps {
  readonly canManage: boolean;
  readonly market: CurrentMarket;
  readonly onDone: (message: string) => void;
  readonly refresh: Effect.Effect<void>;
  readonly revision: number;
}

/** The configured price list: edits autosave as one ConfigureMarket over the market's own revision. */
const PriceListEditor = ({
  canManage,
  market,
  refresh,
  revision,
  settings,
}: Omit<PriceListProps, 'onDone'> & { readonly settings: MarketSettings }) => {
  const { text } = useMarketText();
  const autosave = useAutosaveDraft<MarketPricingForm, never>({
    isValid: (value) => pricingIssues(value).length === 0,
    refresh,
    revision: settings.revision,
    runtime: browserRuntime,
    save: (value, expectedRevision) =>
      merchandiseCommand(
        configureMarketCommand({
          expectedRevision,
          form: value,
          marketCode: market.marketCode,
          marketId: market.marketRef.resourceId,
        }),
        revision,
      ).pipe(
        Effect.match({
          onFailure: (reason): RevisionedSaveResult => (reason === 'conflict' ? 'conflict' : 'failed'),
          onSuccess: (result): RevisionedSaveResult => result.marketRevision ?? 'saved',
        }),
      ),
    server: pricingFormOf(settings),
  });
  const issues = pricingIssues(autosave.draft);
  if (!canManage) {
    const mode = text(`form.offerMode${settings.offerMode}`);
    const summary = text('detail.assortment.summary', {
      currency: settings.currency,
      rate: settings.exchangeRate,
      rounding: settings.roundingMinor,
    });
    return <p className="text-sm">{[mode, summary].join(' · ')}</p>;
  }
  const handleBlur = () => autosave.flush();
  const handleReloadLatest = () => autosave.reloadLatest();
  const handleRetry = () => autosave.retry();
  return (
    <div className="flex flex-col gap-150" onBlur={handleBlur}>
      <PricingFields
        form={autosave.draft}
        issues={issues}
        onChange={(form) => autosave.setDraft(form)}
        prefix="market-pricing"
        showIssues={issues.length > 0}
      />
      <AutosaveStatus onReloadLatest={handleReloadLatest} onRetry={handleRetry} status={autosave.status} />
    </div>
  );
};

const PriceList = ({
  canManage,
  market,
  onDone,
  refresh,
  revision,
  settings,
}: PriceListProps & { readonly settings: MarketSettings | undefined }) => {
  const { text } = useMarketText();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const editable = canManage && market.lifecycle !== 'RETIRED';
  if (settings !== undefined) {
    return (
      <PriceListEditor
        canManage={editable}
        key={market.marketRef.resourceId}
        market={market}
        refresh={refresh}
        revision={revision}
        settings={settings}
      />
    );
  }
  /** Starts the price list from the defaults (whole catalogue, catalogue prices); edits then autosave. */
  const configure = () => {
    setBusy(true);
    setFailure(null);
    runMerchandiseCommand(
      configureMarketCommand({
        expectedRevision: 0,
        form: defaultPricingForm(),
        marketCode: market.marketCode,
        marketId: market.marketRef.resourceId,
      }),
      revision,
      (outcome) => {
        setBusy(false);
        if (outcome.ok) {
          onDone(text('detail.assortment.saved', { code: market.marketCode }));
          return;
        }
        setFailure(outcome.reason);
      },
    );
  };
  return (
    <div className="flex flex-col gap-150">
      <div className="flex flex-wrap items-center justify-between gap-150">
        <p className="text-sm">{text('detail.assortment.notConfigured')}</p>
        {editable && (
          <Button isLoading={busy} loadingText={text('form.saving')} onClick={configure} size="sm" variant="secondary">
            {text('detail.assortment.configure')}
          </Button>
        )}
      </div>
      {failure !== null && (
        <StatusText showIcon status="error">
          {failureText(text, failure)}
        </StatusText>
      )}
    </div>
  );
};

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

interface OfferChange {
  readonly disabled: boolean;
  readonly onSetOffer: (productId: string, name: string, offered: boolean) => void;
}

const ProductLabel = ({ name, sku }: { readonly name: string; readonly sku: string }) => (
  <span className="text-sm">
    <span className="font-medium">{name}</span>
    <span className="text-fg-secondary"> · {sku}</span>
  </span>
);

/** The products that are the exception of the market's offer mode, one page at a time. */
const ExceptionsList = ({
  canManage,
  change,
  input,
}: {
  readonly canManage: boolean;
  readonly change: OfferChange;
  readonly input: ExceptionsInput;
}) => {
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
        const handleCheckedChange = (checked: boolean) => change.onSetOffer(product.productId, product.name, checked);
        return (
          <li className="flex flex-wrap items-center justify-between gap-150 py-100" key={product.productId}>
            <ProductLabel name={product.name} sku={product.sku} />
            <Switch
              checked={product.offered}
              disabled={!canManage || change.disabled}
              name={`market-offer-${product.sku}`}
              onCheckedChange={handleCheckedChange}
            >
              {text(
                product.offered ? 'detail.assortment.exceptions.offered' : 'detail.assortment.exceptions.notOffered',
              )}
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
  change,
  offeredByDefault,
}: {
  readonly change: OfferChange;
  readonly offeredByDefault: boolean;
}) => {
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
        value={search}
      />
      {results?.kind === 'failed' && <StatusText status="error">{failureText(text, results.failure)}</StatusText>}
      {results?.kind === 'found' && results.products.length === 0 && (
        <p className="text-fg-secondary text-sm">{text('detail.assortment.exceptions.noResults')}</p>
      )}
      {results?.kind === 'found' && results.products.length > 0 && (
        <ul className="divide-y divide-border-primary/60">
          {results.products.map((product) => {
            const handleClick = () => change.onSetOffer(product.id, product.name, !offeredByDefault);
            return (
              <li className="flex flex-wrap items-center justify-between gap-150 py-100" key={product.id}>
                <ProductLabel name={product.name} sku={product.sku} />
                <Button disabled={change.disabled} onClick={handleClick} size="sm" theme="outlined" variant="secondary">
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

export const AssortmentSection = ({
  input,
  market,
  onDone,
  records,
  recordsFailed,
  refreshSettings,
}: AssortmentSectionProps) => {
  const { text } = useMarketText();
  const [offset, setOffset] = useState(0);
  const [pendingProduct, setPendingProduct] = useState<string | null>(null);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  if (records === undefined) {
    return (
      <SectionCard title={text('detail.assortment.title')}>
        <StatusText status={recordsFailed ? 'error' : 'default'}>
          {text(recordsFailed ? 'detail.assortment.unavailable' : 'detail.loading')}
        </StatusText>
      </SectionCard>
    );
  }
  const page: ExceptionsInput = { ...input, offset };
  const settings = records.markets?.find((candidate) => candidate.marketId === input.marketId);
  const canManage = records.canManageCatalog === true && market.lifecycle !== 'RETIRED';
  const change: OfferChange = {
    disabled: pendingProduct !== null,
    onSetOffer: (productId, name, offered) => {
      setPendingProduct(productId);
      setFailure(null);
      runMerchandiseCommand(
        { _tag: 'SetProductMarketOffer', marketId: input.marketId, offered, productId },
        records.revision,
        (outcome) => {
          setPendingProduct(null);
          if (outcome.ok) {
            browserRuntime.runFork(marketExceptionsData.refresh(page));
            onDone(
              text(
                offered ? 'detail.assortment.exceptions.offeredSaved' : 'detail.assortment.exceptions.withdrawnSaved',
                {
                  name,
                },
              ),
            );
            return;
          }
          setFailure(outcome.reason);
        },
      );
    },
  };
  const offeredByDefault = settings?.offerMode !== 'SELECTED_PRODUCTS';
  return (
    <SectionCard title={text('detail.assortment.title')}>
      <PriceList
        canManage={records.canManageCatalog === true}
        market={market}
        onDone={onDone}
        refresh={refreshSettings}
        revision={records.revision}
        settings={settings}
      />
      {!canManage && settings !== undefined && (
        <p className="text-fg-secondary text-sm">{text('detail.assortment.readOnly')}</p>
      )}
      {settings !== undefined && (
        <section className="flex flex-col gap-150">
          <h3 className="font-semibold text-sm">{text('detail.assortment.exceptions.title')}</h3>
          <p className="text-fg-secondary text-sm">
            {text(
              offeredByDefault ? 'detail.assortment.exceptions.wholeHint' : 'detail.assortment.exceptions.selectedHint',
            )}
          </p>
          <ExceptionsList canManage={canManage} change={change} input={page} />
          <ExceptionsPager input={page} onOffset={setOffset} />
          {canManage && <ProductSearch change={change} offeredByDefault={offeredByDefault} />}
          {failure !== null && (
            <StatusText showIcon status="error">
              {failureText(text, failure)}
            </StatusText>
          )}
        </section>
      )}
    </SectionCard>
  );
};
