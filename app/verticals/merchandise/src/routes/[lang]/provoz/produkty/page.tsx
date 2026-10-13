import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Toaster, useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { DateTime, Schema } from 'effect';
import { useEffect, useState } from 'react';
import type { BulkProductPatch } from '../../../../../shared/actions/apply-command.ts';
import type { ProductRecord, RecordsResponse } from '../../../../../shared/apis/records.ts';
import csResource from '../../../../../locales/cs/merchandise.json';
import enResource from '../../../../../locales/en/merchandise.json';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';
import { loadProducts, runCommand } from './products-api.ts';
import type { FailureReason, LoadOutcome } from './products-api.ts';
import { ProductBulkBar } from './product-bulk-bar.tsx';
import { ProductDetailDialog } from './product-detail-dialog.tsx';
import { CategoryDialog, CreateProductDialog, PriceChangeDialog, ReceiptDialog } from './product-forms.tsx';
import { useProductFormat } from './products-format.ts';
import { ProductsTable } from './products-table.tsx';

const merchandiseI18nResources = {
  cs: { merchandise: csResource },
  en: { merchandise: enResource },
} as const;

const ALL_CATEGORIES = '__all__';
const DialogKind = Schema.Literals(['create', 'receipt', 'price', 'category']);

type LoadState =
  | { readonly reason: FailureReason; readonly status: 'error' }
  | { readonly response: RecordsResponse; readonly status: 'ready' }
  | { readonly status: 'loading' };

const toLoadState = (outcome: LoadOutcome): LoadState =>
  outcome.ok ? { response: outcome.response, status: 'ready' } : { reason: outcome.reason, status: 'error' };

const StatCard = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <div className="flex min-w-0 flex-col gap-100 rounded-lg border border-border-primary bg-surface p-200">
    <span className="text-fg-secondary text-sm">{label}</span>
    <span className="font-semibold text-xl tabular-nums">{value}</span>
  </div>
);

const RecordsPageContent = () => {
  const { t } = useModernI18n();
  const fmt = useProductFormat();
  const toaster = useToast();
  const k = (path: string) => t(`merchandise.pages.products.${path}`);

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [selection, setSelection] = useState<Record<string, true>>({});
  const [detailId, setDetailId] = useState<ProductRecord['id'] | null>(null);
  const [dialog, setDialog] = useState<typeof DialogKind.Type | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    loadProducts((outcome) => {
      setState(toLoadState(outcome));
    });
  }, []);

  // A refresh keeps the rows on screen; only the first load shows the loading state.
  const reload = () => {
    loadProducts((outcome) => {
      setState(toLoadState(outcome));
    });
  };

  const ready = state.status === 'ready' ? state.response : undefined;
  const products = ready?.products ?? [];
  const canWrite = ready?.canWrite === true;
  const revision = ready?.revision ?? 0;
  const categories = [...new Set(products.map((product) => product.category))].toSorted((left, right) =>
    left.localeCompare(right, 'cs'),
  );

  const query = search.trim().toLowerCase();
  const filtered = products.filter(
    (product) =>
      (query === '' || `${product.name} ${product.sku}`.toLowerCase().includes(query)) &&
      (category === ALL_CATEGORIES || product.category === category) &&
      (!lowStockOnly || product.lowStock),
  );
  const selectedIds = products.flatMap((product) => (selection[product.id] === true ? [product.id] : []));
  const filtersActive = query !== '' || category !== ALL_CATEGORIES || lowStockOnly;
  const detail = products.find((product) => product.id === detailId);

  const onCommitted = (message: string) => {
    toaster.create({ title: message, type: 'success' });
    reload();
  };
  const clearFilters = () => {
    setSearch('');
    setCategory(ALL_CATEGORIES);
    setLowStockOnly(false);
  };

  const runBulk = (patch: BulkProductPatch, message: string) => {
    if (ready === undefined || selectedIds.length === 0) {
      return;
    }
    setBulkBusy(true);
    runCommand({ _tag: 'BulkUpdateProducts', ids: selectedIds, patch }, ready.revision, (outcome) => {
      setBulkBusy(false);
      if (!outcome.ok) {
        if (outcome.reason === 'conflict') {
          reload();
        }
        toaster.create({
          title: outcome.reason === 'conflict' ? k('messages.conflict') : k('messages.failed'),
          type: 'error',
        });
        return;
      }
      setSelection({});
      onCommitted(message);
    });
  };

  const closeDialog = (open: boolean) => {
    if (!open) {
      setDialog(null);
    }
  };
  const clearSelectionThen = (message: string) => {
    setSelection({});
    onCommitted(message);
  };

  return (
    <>
      <UltramodernRouteHead />
      <div className="flex w-full min-w-0 flex-col gap-250">
        <header className="flex flex-wrap items-start justify-between gap-200">
          <div className="flex min-w-0 flex-col gap-100">
            <h1 className="font-semibold text-xl">{k('title')}</h1>
            <p className="max-w-prose text-fg-secondary text-sm">{k('description')}</p>
          </div>
          {canWrite && (
            <div className="flex flex-wrap items-center gap-100">
              <Button
                icon="icon-[mdi--package-down]"
                onClick={() => setDialog('receipt')}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {k('actions.receipt')}
              </Button>
              <Button icon="icon-[mdi--plus]" onClick={() => setDialog('create')} size="sm" variant="primary">
                {k('actions.newProduct')}
              </Button>
            </div>
          )}
        </header>

        <div className="grid grid-cols-2 gap-200 xl:grid-cols-4">
          <StatCard
            label={k('stats.products')}
            value={ready === undefined ? '—' : fmt.count(ready.indicators.productCount)}
          />
          <StatCard
            label={k('stats.stockValue')}
            value={ready === undefined ? '—' : fmt.money(ready.indicators.stockValueMinor)}
          />
          <StatCard
            label={k('stats.lowStock')}
            value={ready === undefined ? '—' : fmt.count(ready.indicators.lowStockCount)}
          />
          <StatCard
            label={k('stats.openOrders')}
            value={ready === undefined ? '—' : fmt.money(ready.indicators.openOrderValueMinor)}
          />
        </div>

        <div className="flex flex-wrap items-end gap-200">
          <div className="min-w-64 flex-1">
            <FormInput
              id="products-search"
              label={k('filters.search')}
              name="search"
              onChange={(event) => setSearch(event.target.value)}
              value={search}
            />
          </div>
          <div className="min-w-56">
            <SelectTemplate
              items={[
                { label: k('filters.allCategories'), value: ALL_CATEGORIES },
                ...categories.map((value) => ({ label: value, value })),
              ]}
              label={k('filters.category')}
              name="category"
              onValueChange={(details) => {
                const [next] = details.value;
                setCategory(next ?? ALL_CATEGORIES);
              }}
              value={[category]}
            />
          </div>
          <Switch checked={lowStockOnly} name="lowStockOnly" onCheckedChange={setLowStockOnly}>
            {k('filters.lowStockOnly')}
          </Switch>
        </div>

        <ProductBulkBar
          busy={bulkBusy}
          canWrite={canWrite}
          count={selectedIds.length}
          onChangeCategory={() => setDialog('category')}
          onChangePrice={() => setDialog('price')}
          onClear={() => setSelection({})}
          onSetActive={(active) => runBulk({ active }, k('messages.bulkUpdated'))}
        />

        {state.status === 'error' && state.reason === 'forbidden' && (
          <StatusText showIcon status="error">
            {k('states.forbidden')}
          </StatusText>
        )}

        <ProductsTable
          canWrite={canWrite}
          filtersActive={filtersActive}
          onClearFilters={clearFilters}
          onCreate={() => setDialog('create')}
          onOpen={setDetailId}
          onRetry={reload}
          onSelectionChange={setSelection}
          rows={filtered}
          selection={selection}
          status={state.status}
        />

        {ready !== undefined && (
          <>
            <CreateProductDialog
              onCommitted={onCommitted}
              onOpenChange={closeDialog}
              onReload={reload}
              open={dialog === 'create'}
              revision={revision}
            />
            <ReceiptDialog
              onCommitted={onCommitted}
              onOpenChange={closeDialog}
              onReload={reload}
              open={dialog === 'receipt'}
              products={products}
              revision={revision}
            />
            <PriceChangeDialog
              ids={selectedIds}
              onCommitted={clearSelectionThen}
              onOpenChange={closeDialog}
              onReload={reload}
              open={dialog === 'price'}
              revision={revision}
            />
            <CategoryDialog
              ids={selectedIds}
              onCommitted={clearSelectionThen}
              onOpenChange={closeDialog}
              onReload={reload}
              open={dialog === 'category'}
              revision={revision}
            />
          </>
        )}
        {ready !== undefined && detail !== undefined && (
          <ProductDetailDialog
            canWrite={canWrite}
            key={`${detail.id}:${DateTime.toEpochMillis(detail.updatedAt)}`}
            movements={ready.movements.filter((movement) => movement.productId === detail.id)}
            onCommitted={onCommitted}
            onOpenChange={(open) => {
              if (!open) {
                setDetailId(null);
              }
            }}
            onReload={reload}
            open
            product={detail}
            revision={revision}
          />
        )}
        <Toaster />
      </div>
    </>
  );
};

export const RecordsPage = () => {
  const location = useRouterState({ select: (router) => router.location.href });
  return (
    <FederatedI18nBoundary
      defaultNamespace="merchandise"
      fallbackLanguage="en"
      resources={merchandiseI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent key={location} />
    </FederatedI18nBoundary>
  );
};

export default RecordsPage;
