import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState, useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { PageHeader, StatCard, StatRow, formatNumber, Toaster } from '@app/admin-ui';
import { BulkTagDialog, TagFilter } from '@app/tagging/components/tag-controls';
import { Effect, Schema } from 'effect';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BulkProductPatch } from '../../../../../shared/actions/apply-command.ts';
import type { CategoryTrail, ProductCategoryCount, ProductRecord, RecordsResponse } from '../../../../../shared/apis/records.ts';
import { ProductIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import csResource from '../../../../../locales/cs/merchandise.json';
import enResource from '../../../../../locales/en/merchandise.json';
import { toSubjectIds, useSubjectTagFilter, useSubjectTags } from '../../../../tags/subject-tags.ts';
import type { SubjectTagFilter } from '../../../../tags/subject-tags.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';
import { formatKc } from '../../../../list-cells.tsx';
import { loadCategoryChoices, loadProducts, runCommand, productNavigationFailureKey } from './products-api.ts';
import type { FailureReason, ProductListQuery, ProductSort } from './products-api.ts';
import { CategorySearchCombobox } from './category-search-combobox.tsx';
import { useDebounced } from './product-reads.ts';
import { ProductBulkBar } from './product-bulk-bar.tsx';
import { CategoryAdminButton } from './category-admin-panel.tsx';
import { CategoryDialog, CreateProductDialog, PriceChangeDialog, ReceiptDialog } from './product-forms.tsx';
import type { ProductsTableStatus } from './products-table.tsx';
import { ProductsTable } from './products-table.tsx';

const merchandiseI18nResources = {
  cs: { merchandise: csResource },
  en: { merchandise: enResource },
} as const;

const ALL_CATEGORIES = '__all__';
const DEFAULT_SORT = '__default__';
const PAGE_SIZE = 50;
const SORTS: readonly ProductSort[] = [
  'name',
  'sku',
  'price-asc',
  'price-desc',
  'stock-asc',
  'stock-desc',
  'updated-desc',
];
const isProductId = Schema.is(ProductIdSchema);
const DialogKind = Schema.Literals(['create', 'receipt', 'price', 'category', 'tags']);
/** The category filter keeps its label for assistive tech only, so it lines up with the other filter controls. */
const srOnlyLabelProps = { className: 'sr-only' };

type LoadState =
  | { readonly reason: FailureReason; readonly status: 'error' }
  | { readonly query: ProductListQuery; readonly response: RecordsResponse; readonly status: 'ready' }
  | { readonly status: 'loading' };

const NO_PRODUCT_CATEGORIES: readonly ProductCategoryCount[] = [];

interface CategoryChoices {
  /** The company has a storefront tree: the filter searches it on the server. */
  readonly hasTree: boolean;
  /** Distinct product category labels; the filter offers them when the company has no storefront tree. */
  readonly labels: readonly ProductCategoryCount[];
}
const NO_CHOICES: CategoryChoices = { hasTree: false, labels: NO_PRODUCT_CATEGORIES };

type SetLoadState = (next: LoadState) => void;

/** Reads one page; only the newest read may land, so a slow earlier page never replaces the page the user moved to. */
const readPage = (query: ProductListQuery, generation: { current: number }, setState: SetLoadState): void => {
  generation.current += 1;
  const requested = generation.current;
  loadProducts(query, (outcome) => {
    if (requested !== generation.current) {
      return;
    }
    setState(
      outcome.ok ? { query, response: outcome.response, status: 'ready' } : { reason: outcome.reason, status: 'error' },
    );
  });
};

/** The products page for `query`. A refresh keeps the rows on screen; only the first load shows the loading state. */
const useProductPage = (query: ProductListQuery) => {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const generation = useRef(0);
  useEffect(() => {
    readPage(query, generation, setState);
  }, [query]);
  return { reload: () => readPage(query, generation, setState), state };
};

const readChoices = (setChoices: (next: CategoryChoices) => void): void =>
  loadCategoryChoices((outcome) => {
    if (outcome.ok) {
      setChoices({
        hasTree: outcome.response.hasCategoryTree === true,
        labels: outcome.response.productCategories ?? NO_PRODUCT_CATEGORIES,
      });
    }
  });

/** The category filter's choices; reread after the category panel or a product's category changes. */
const useCategoryChoices = () => {
  const [choices, setChoices] = useState<CategoryChoices>(NO_CHOICES);
  useEffect(() => {
    readChoices(setChoices);
  }, []);
  return { choices, reload: () => readChoices(setChoices) };
};

/** Label filter options of a company without a storefront tree: the product category labels with their counts. */
const labelOptions = (choices: CategoryChoices) =>
  choices.labels.flatMap((entry) =>
    entry.name.trim() === '' ? [] : [{ label: `${entry.name} (${entry.productCount})`, value: entry.name }],
  );

/** With a tag filter active, row tags still loading read as loading and a failed load as error, never as no match. */
const tableStatusFor = (
  productsStatus: LoadState['status'],
  tagStatus: SubjectTagFilter['status'],
): ProductsTableStatus => {
  if (tagStatus === 'error') {
    return 'error';
  }
  if (productsStatus !== 'ready') {
    return productsStatus;
  }
  return tagStatus === 'loading' ? 'loading' : 'ready';
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

/**
 * Success toasts stay 5 s instead of zag's 2 s default. Most of them fire as a side panel closes, and the closing
 * modal still hides the rest of the page for part of that time, so a 2 s toast was easy to miss.
 */
const SUCCESS_TOAST_MS = 5000;

/** Toast text for a refused bulk command: stale data, a refused business rule, or a generic failure. */
const bulkFailureKey = (reason: FailureReason): string => {
  if (reason === 'conflict') {
    return 'messages.conflict';
  }
  return reason === 'rejected' ? 'messages.rejected' : 'messages.failed';
};

const RecordsPageContent = () => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const toaster = useToast();
  const k = (path: string) => t(`merchandise.pages.products.${path}`);

  const [search, setSearch] = useState('');
  /** A storefront tree category, or a product category label when the company has no tree. */
  const [treeCategory, setTreeCategory] = useState<CategoryTrail | null>(null);
  const [labelCategory, setLabelCategory] = useState<string | null>(null);
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [sort, setSort] = useState<ProductSort | null>(null);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: PAGE_SIZE });
  const [selection, setSelection] = useState<Record<string, true>>({});
  const [dialog, setDialog] = useState<typeof DialogKind.Type | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const settledSearch = useDebounced(search);
  const tagFilter = useSubjectTagFilter('product');
  const { choices, reload: reloadCategories } = useCategoryChoices();
  const byTree = choices.hasTree;
  const treeCategoryId = byTree ? (treeCategory?.id ?? null) : null;
  const category = byTree ? null : labelCategory;
  const taggedIds = tagFilter.ids;
  const query = useMemo<ProductListQuery>(
    () => ({
      category,
      categoryId: treeCategoryId,
      limit: pagination.pageSize,
      lowStockOnly,
      offset: pagination.pageIndex * pagination.pageSize,
      search: settledSearch,
      sort,
      taggedIds,
    }),
    [category, lowStockOnly, pagination, settledSearch, sort, taggedIds, treeCategoryId],
  );
  const { reload, state } = useProductPage(query);

  /** A filter change starts again at the first page. */
  const firstPage = () =>
    setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));

  const ready = state.status === 'ready' ? state.response : undefined;
  const products = ready?.products ?? [];
  const canWrite = (ready?.canManageCatalog ?? ready?.canWrite) === true;
  const productTags = useSubjectTags('product', canWrite ? products.map((product) => product.id) : []);
  const revision = ready?.revision ?? 0;
  const labelItems = useMemo(() => labelOptions(choices), [choices]);

  const selectedIds = Object.keys(selection).filter(isProductId);
  const filtersActive =
    search.trim() !== '' || treeCategory !== null || labelCategory !== null || lowStockOnly || tagFilter.tagId !== null;
  const stale = state.status === 'ready' && state.query !== query;
  const tableStatus = stale ? 'loading' : tableStatusFor(state.status, tagFilter.status);

  const onCommitted = (message: string) => {
    toaster.create({ duration: SUCCESS_TOAST_MS, title: message, type: 'success' });
    reload();
    if (!byTree) {
      // New products and category changes can add or empty a product category label.
      reloadCategories();
    }
  };
  const onCategoriesCommitted = (message: string) => {
    onCommitted(message);
    reloadCategories();
  };
  const clearFilters = () => {
    setSearch('');
    setTreeCategory(null);
    setLabelCategory(null);
    setLowStockOnly(false);
    tagFilter.setTagId(null);
    firstPage();
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
        toaster.create({ title: k(bulkFailureKey(outcome.reason)), type: 'error' });
        return;
      }
      setSelection({});
      onCommitted(message);
    });
  };

  // Toasts sit bottom-right, where a panel keeps its primary action; a panel opening clears the earlier ones.
  const openDialog = (kind: typeof DialogKind.Type) => {
    toaster.dismiss();
    setDialog(kind);
  };
  const openDetail = (id: ProductRecord['id']) => {
    toaster.dismiss();
    void browserRuntime.runPromise(
      Effect.tryPromise(
        navigate.bind(undefined, { to: `/${language ?? 'cs'}/provoz/produkty/${encodeURIComponent(id)}` }),
      ).pipe(
        Effect.timeout('10 seconds'),
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              const messageKey = productNavigationFailureKey(error);
              toaster.create({ title: k(messageKey), type: 'error' });
            }),
          onSuccess: Effect.succeed,
        }),
      ),
    );
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
                <CategoryAdminButton onCommitted={onCategoriesCommitted} />
                <Button
                  icon="icon-[mdi--package-down]"
                  onClick={() => openDialog('receipt')}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  {k('actions.receipt')}
                </Button>
                <Button icon="icon-[mdi--plus]" onClick={() => openDialog('create')} size="sm" variant="primary">
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
            onChange={(event) => {
              setSearch(event.target.value);
              firstPage();
            }}
            placeholder={k('filters.search')}
            size="sm"
            type="search"
            value={search}
          />
          {byTree && (
            // The label stays for assistive tech only, so the field lines up with the other filter controls.
            <div className="w-64 [&_label]:sr-only">
              <CategorySearchCombobox
                allLabel={k('filters.allCategories')}
                errorMessage={k('filters.categoryError')}
                id="products-category-filter"
                label={k('filters.category')}
                loadingMessage={t('merchandise.loading')}
                moreMessage={(shown, total) => t('merchandise.pages.products.filters.categoryMore', { shown, total })}
                noResultsMessage={k('filters.categoryNoResults')}
                onSelect={(next) => {
                  setTreeCategory(next);
                  firstPage();
                }}
                placeholder={k('filters.categorySearch')}
                retryLabel={k('filters.categoryRetry')}
                selected={treeCategory}
                size="sm"
              />
            </div>
          )}
          {!byTree && labelItems.length > 0 && (
            <div className="w-64">
              <SelectTemplate
                items={[{ label: k('filters.allCategories'), value: ALL_CATEGORIES }, ...labelItems]}
                label={k('filters.category')}
                labelProps={srOnlyLabelProps}
                name="category"
                onValueChange={(details) => {
                  const [next] = details.value;
                  setLabelCategory(next === undefined || next === ALL_CATEGORIES ? null : next);
                  firstPage();
                }}
                placeholder={t('merchandise.selectPlaceholder')}
                size="sm"
                value={[labelCategory ?? ALL_CATEGORIES]}
              />
            </div>
          )}
          <div className="w-48">
            <SelectTemplate
              items={[
                { label: k('sort.default'), value: DEFAULT_SORT },
                ...SORTS.map((value) => ({ label: k(`sort.${value}`), value })),
              ]}
              label={k('sort.label')}
              labelProps={srOnlyLabelProps}
              name="sort"
              onValueChange={(details) => {
                const [next] = details.value;
                setSort(SORTS.find((candidate) => candidate === next) ?? null);
                firstPage();
              }}
              placeholder={t('merchandise.selectPlaceholder')}
              size="sm"
              value={[sort ?? DEFAULT_SORT]}
            />
          </div>
          {canWrite && (
            <div className="w-48">
              <TagFilter
                kind="product"
                onChange={(tagId) => {
                  tagFilter.setTagId(tagId);
                  firstPage();
                }}
                value={tagFilter.tagId}
              />
            </div>
          )}
          <Switch
            checked={lowStockOnly}
            name="lowStockOnly"
            onCheckedChange={(checked) => {
              setLowStockOnly(checked);
              firstPage();
            }}
          >
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
          onChangeCategory={() => openDialog('category')}
          onChangePrice={() => openDialog('price')}
          onClear={() => setSelection({})}
          onSetActive={(active) => runBulk({ active }, k('messages.bulkUpdated'))}
          onTags={() => openDialog('tags')}
        />

        {state.status === 'error' && state.reason === 'reload-required' && (
          <div className="flex flex-col gap-200">
            <StatusText showIcon status="warning">
              {k('states.reloadRequired')}
            </StatusText>
            <Button onClick={() => window.location.reload()} variant="secondary">
              {k('common.reloadPage')}
            </Button>
          </div>
        )}
        {state.status === 'error' && state.reason === 'forbidden' && (
          <StatusText showIcon status="error">
            {k('states.forbidden')}
          </StatusText>
        )}

        <ProductsTable
          canWrite={canWrite}
          filtersActive={filtersActive}
          onClearFilters={clearFilters}
          onCreate={() => openDialog('create')}
          onOpen={openDetail}
          onPaginationChange={setPagination}
          onRetry={() => {
            if (state.status === 'error' && state.reason === 'reload-required') {
              window.location.reload();
              return;
            }
            reload();
            productTags.refetch();
            tagFilter.refetch();
          }}
          onSelectionChange={setSelection}
          pagination={pagination}
          rowCount={ready?.totalProducts ?? products.length}
          rows={products}
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
                if (tagFilter.tagId !== null) {
                  // The selected tag gained or lost products: read its subjects (and so the page) again.
                  tagFilter.refetch();
                }
              }}
              onOpenChange={closeDialog}
              open={dialog === 'tags'}
              subjectIds={toSubjectIds(selectedIds)}
            />
          </>
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
