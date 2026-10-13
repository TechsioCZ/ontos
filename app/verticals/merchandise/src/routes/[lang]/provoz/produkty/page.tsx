import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Toaster, useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { PageHeader, StatCard, StatRow, formatNumber } from '@app/admin-ui';
import { BulkTagDialog, TagFilter } from '@app/tagging/components/tag-controls';
import { DateTime, Schema } from 'effect';
import { useEffect, useState } from 'react';
import type { BulkProductPatch } from '../../../../../shared/actions/apply-command.ts';
import type { ProductRecord, RecordsResponse } from '../../../../../shared/apis/records.ts';
import csResource from '../../../../../locales/cs/merchandise.json';
import enResource from '../../../../../locales/en/merchandise.json';
import { toSubjectIds, useSubjectTagFilter, useSubjectTags } from '../../../../tags/subject-tags.ts';
import type { SubjectTagFilter } from '../../../../tags/subject-tags.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';
import { formatKc } from '../../../../list-cells.tsx';
import { loadProducts, runCommand } from './products-api.ts';
import type { FailureReason, LoadOutcome } from './products-api.ts';
import { ProductBulkBar } from './product-bulk-bar.tsx';
import { ProductDetailDialog } from './product-detail-dialog.tsx';
import { CategoryDialog, CreateProductDialog, PriceChangeDialog, ReceiptDialog } from './product-forms.tsx';
import type { ProductsTableStatus } from './products-table.tsx';
import { ProductsTable } from './products-table.tsx';

const merchandiseI18nResources = {
  cs: { merchandise: csResource },
  en: { merchandise: enResource },
} as const;

const ALL_CATEGORIES = '__all__';
const DialogKind = Schema.Literals(['create', 'receipt', 'price', 'category', 'tags']);

type LoadState =
  | { readonly reason: FailureReason; readonly status: 'error' }
  | { readonly response: RecordsResponse; readonly status: 'ready' }
  | { readonly status: 'loading' };

const toLoadState = (outcome: LoadOutcome): LoadState =>
  outcome.ok ? { response: outcome.response, status: 'ready' } : { reason: outcome.reason, status: 'error' };

/** With a tag filter active, row tags still loading read as loading and a failed load as error, never as no match. */
const tableStatusFor = (
  productsStatus: LoadState['status'],
  tagStatus: SubjectTagFilter['status'],
): ProductsTableStatus => {
  if (productsStatus !== 'ready') {
    return productsStatus;
  }
  if (tagStatus === 'loading') {
    return 'loading';
  }
  return tagStatus === 'error' ? 'error' : 'ready';
};

interface ProductStatsProps {
  readonly indicators: RecordsResponse['indicators'] | undefined;
  readonly label: (path: string) => string;
}

/** Header KPIs. Dashes until the first read lands. */
const ProductStats = ({ indicators, label }: ProductStatsProps) => (
  <StatRow>
    <StatCard
      label={label('stats.products')}
      value={indicators === undefined ? '—' : formatNumber(indicators.productCount)}
    />
    <StatCard
      label={label('stats.stockValue')}
      value={indicators === undefined ? '—' : formatKc(indicators.stockValueMinor)}
    />
    <StatCard
      label={label('stats.lowStock')}
      value={indicators === undefined ? '—' : formatNumber(indicators.lowStockCount)}
    />
    <StatCard
      label={label('stats.openOrders')}
      value={indicators === undefined ? '—' : formatKc(indicators.openOrderValueMinor)}
    />
  </StatRow>
);

const RecordsPageContent = () => {
  const { t } = useModernI18n();
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
  const productTags = useSubjectTags(
    'product',
    products.map((product) => product.id),
  );
  const tagFilter = useSubjectTagFilter(productTags);
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
      (!lowStockOnly || product.lowStock) &&
      tagFilter.matches(product.id),
  );
  const selectedIds = products.flatMap((product) => (selection[product.id] === true ? [product.id] : []));
  const filtersActive = query !== '' || category !== ALL_CATEGORIES || lowStockOnly || tagFilter.tagId !== null;
  const tableStatus = tableStatusFor(state.status, tagFilter.status);
  const detail = products.find((product) => product.id === detailId);

  const onCommitted = (message: string) => {
    toaster.create({ title: message, type: 'success' });
    reload();
  };
  const clearFilters = () => {
    setSearch('');
    setCategory(ALL_CATEGORIES);
    setLowStockOnly(false);
    tagFilter.setTagId(null);
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
        <PageHeader
          actions={
            canWrite ? (
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
            ) : undefined
          }
          description={k('description')}
          title={k('title')}
        />

        <ProductStats indicators={ready?.indicators} label={k} />

        <div className="flex flex-wrap items-end gap-150">
          <Input
            aria-label={k('filters.search')}
            className="w-64"
            onChange={(event) => setSearch(event.target.value)}
            placeholder={k('filters.search')}
            size="sm"
            type="search"
            value={search}
          />
          <div className="w-48">
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
              placeholder={t('merchandise.selectPlaceholder')}
              size="sm"
              value={[category]}
            />
          </div>
          <div className="w-48">
            <TagFilter kind="product" onChange={(tagId) => tagFilter.setTagId(tagId)} value={tagFilter.tagId} />
          </div>
          <Switch checked={lowStockOnly} name="lowStockOnly" onCheckedChange={setLowStockOnly}>
            {k('filters.lowStockOnly')}
          </Switch>
        </div>
        {tagFilter.status === 'error' && (
          <StatusText showIcon status="error">
            {k('states.tagFilterFailed')}
          </StatusText>
        )}

        <ProductBulkBar
          busy={bulkBusy}
          canWrite={canWrite}
          count={selectedIds.length}
          onChangeCategory={() => setDialog('category')}
          onChangePrice={() => setDialog('price')}
          onClear={() => setSelection({})}
          onSetActive={(active) => runBulk({ active }, k('messages.bulkUpdated'))}
          onTags={() => setDialog('tags')}
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
          onRetry={() => {
            reload();
            productTags.refetch();
          }}
          onSelectionChange={setSelection}
          rows={filtered}
          selection={selection}
          status={tableStatus}
          tagsOf={productTags.tagsOf}
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
            <BulkTagDialog
              kind="product"
              onDone={() => {
                setSelection({});
                productTags.refetch();
              }}
              onOpenChange={closeDialog}
              open={dialog === 'tags'}
              subjectIds={toSubjectIds(selectedIds)}
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
