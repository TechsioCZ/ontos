import { pendingProposalMessage } from '../../../../api/action-result.ts';
import { companyVatOf } from './product-tax-classification.ts';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState, useNavigate } from '@modern-js/plugin-tanstack/runtime';
import type { RegisteredRouter } from '@tanstack/react-router';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { PageHeader, StatCard, StatRow, formatNumber, Toaster } from '@app/admin-ui';
import { BulkTagDialog, TagFilter, useTagCatalog } from '@app/tagging/components/tag-controls';
import {
  BareTextField,
  CheckboxField,
  FormBuilder,
  FormReact,
  FormRoot,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { Effect, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import { modulePagePreload } from '@app/shared-contracts/page-data';
import type { ModulePageContext, ModulePageProps } from '@app/shared-contracts/page-data';
import type { TanstackTable } from '@techsio/ui-kit/organisms/data-table';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { legalEntityOf } from '../../../../runtime/page-data-hooks.ts';
import { useState } from 'react';
import type { BulkProductPatch } from '../../../../../shared/actions/apply-command.ts';
import type { CategoryTrail, ProductRecord, RecordsResponse } from '../../../../../shared/apis/records.ts';
import { ProductIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import csResource from '../../../../../locales/cs/merchandise.json';
import enResource from '../../../../../locales/en/merchandise.json';
import { toSubjectIds, useSubjectTagFilter, useSubjectTags } from '../../../../tags/subject-tags.ts';
import type { SubjectTagFilter } from '../../../../tags/subject-tags.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { formatKc } from '../../../../list-format.ts';
import {
  categoryChoicesData,
  firstProductPage,
  productListData,
  runCommand,
  productNavigationFailureKey,
  productScope,
  productDetailIntent,
  productDetailSearch,
  productCategoryKey,
  useProductDetailsPrefetch,
} from './products-api.ts';
import type { CategoryChoices, FailureReason, ProductListQuery, ProductSort } from './products-api.ts';
import { useCategoryChoices, useProductPage } from './product-list-page.ts';
import type { ProductLoadState } from './product-list-page.ts';
import { CategorySearchCombobox } from './category-search-combobox.tsx';
import { useDebounced } from './product-reads.ts';
import { ProductBulkBar } from './product-bulk-bar.tsx';
import { CategoryAdminButton } from './category-admin-panel.tsx';
import { CategoryDialog, CreateProductDialog, PriceChangeDialog, ReceiptDialog } from './product-forms.tsx';
import { ALL_CATEGORIES, DEFAULT_SORT, SORTS, sortSelectItems } from './select-items.ts';
import { selectItem } from '../../../../ui/select-item.ts';
import type { ProductsTableStatus } from './products-table.tsx';
import { ProductsTable } from './products-table.tsx';

const merchandiseI18nResources = {
  cs: { merchandise: csResource },
  en: { merchandise: enResource },
} as const;

const PAGE_SIZE = 50;
const isProductId = Schema.is(ProductIdSchema);
const DialogKind = Schema.Literals(['create', 'receipt', 'price', 'category', 'tags']);
/** The category filter keeps its label for assistive tech only, so it lines up with the other filter controls. */
const srOnlyLabelProps = { className: 'sr-only' };

/** Label filter options of a company without a storefront tree: the product category labels with their counts. */
const labelOptions = (choices: CategoryChoices) =>
  choices.labels.flatMap((entry) =>
    entry.name.trim() === '' ? [] : [selectItem(entry.name, `${entry.name} (${entry.productCount})`)],
  );

/** With a tag filter active, row tags still loading read as loading and a failed load as error, never as no match. */
const tableStatusFor = (
  productsStatus: ProductLoadState['status'],
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

/**
 * The list's search text and its switches. A change filters the list at once; the form itself is never
 * submitted.
 */
const productFiltersForm = FormReact.make(
  FormBuilder.empty
    .addField('archived', Schema.Boolean)
    .addField('lowStockOnly', Schema.Boolean)
    .addField('search', Schema.String)
    .addField('symmyOnly', Schema.Boolean),
  {
    fields: {
      archived: CheckboxField,
      lowStockOnly: CheckboxField,
      search: BareTextField,
      symmyOnly: CheckboxField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
const noFilters = { archived: false, lowStockOnly: false, search: '', symmyOnly: false };
const filters = productFiltersForm.values.pipe(Atom.map(Option.getOrElse(() => noFilters)));
/** One filter as a plain value, which changes only when that filter does. */
const filterOf = <K extends keyof typeof noFilters>(name: K) =>
  filters.pipe(Atom.map((values): (typeof noFilters)[K] => values[name]));
const searchFilter = filterOf('search');
const lowStockFilter = filterOf('lowStockOnly');
const archivedFilter = filterOf('archived');
const symmyFilter = filterOf('symmyOnly');

interface RecordsPageContentProps {
  readonly context?: ModulePageContext | undefined;
  readonly legalEntityId: string;
}

/** True from the first render `answered` holds on, so what it shows never disappears again. */
const useShownOnceAnswered = (answered: boolean) => {
  const [shown, setShown] = useState(false);
  if (answered && !shown) {
    setShown(true);
  }
  return shown || answered;
};

const useProductListPage = ({ context, legalEntityId }: RecordsPageContentProps) => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const toaster = useToast();
  const k = (path: string) => t(`merchandise.pages.products.${path}`);

  const { archived, lowStockOnly, search, symmyOnly } = useAtomValue(filters);
  const setFilters = useAtomSet(productFiltersForm.setValues);
  /** A storefront tree category, or a product category label when the company has no tree. */
  const [treeCategory, setTreeCategory] = useState<CategoryTrail | null>(null);
  const [labelCategory, setLabelCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<ProductSort | null>(null);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: PAGE_SIZE });
  const [table, setTable] = useState<TanstackTable<ProductRecord>>();
  const [selection, setSelection] = useState<Record<string, true>>({});
  const [dialog, setDialog] = useState<typeof DialogKind.Type | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const settledSearch = useDebounced(search);
  const tagFilter = useSubjectTagFilter('product');
  const {
    choices,
    reload: reloadCategories,
    settled: choicesSettled,
  } = useCategoryChoices(productCategoryKey(legalEntityId, context));
  const byTree = choices.hasTree;
  const treeCategoryId = byTree ? (treeCategory?.id ?? null) : null;
  const category = byTree ? null : labelCategory;
  const taggedIds = tagFilter.ids;
  const query: ProductListQuery = {
    archived,
    category,
    categoryId: treeCategoryId,
    limit: pagination.pageSize,
    lowStockOnly,
    offset: pagination.pageIndex * pagination.pageSize,
    search: settledSearch,
    sort,
    symmyOnly,
    taggedIds,
  };
  const { reload, state, viewKey } = useProductPage(legalEntityId, query, context);

  /** A filter change starts again at the first page. */
  const firstPage = () =>
    setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
  useAtomSubscribe(searchFilter, firstPage, { immediate: false });
  useAtomSubscribe(lowStockFilter, firstPage, { immediate: false });
  useAtomSubscribe(symmyFilter, firstPage, { immediate: false });
  /** The archived list is a list of its own: the selection and the page start again. */
  useAtomSubscribe(
    archivedFilter,
    () => {
      setSelection({});
      firstPage();
    },
    { immediate: false },
  );

  const ready = state.status === 'ready' ? state.response : undefined;
  const products = ready?.products ?? [];
  const canWrite = (ready?.canManageCatalog ?? ready?.canWrite) === true;
  const productTags = useSubjectTags('product', canWrite ? products.map((product) => product.id) : []);
  const revision = ready?.revision ?? 0;
  const labelItems = labelOptions(choices);
  const productTagCatalog = useTagCatalog('product', true);
  // The filters beside the search depend on the category choices (tree or labels), the first page (write rights,
  // Symmy products) and the tag catalogue (the tag filter). They appear together once all answered, so none of them
  // shifts another one later, and once shown they stay.
  const filtersSettled = useShownOnceAnswered(
    choicesSettled && state.status !== 'loading' && productTagCatalog.status !== 'loading',
  );

  const selectedIds = Object.keys(selection).filter(isProductId);
  const filtersActive = [
    search.trim() !== '',
    treeCategory !== null,
    labelCategory !== null,
    lowStockOnly,
    archived,
    symmyOnly,
    tagFilter.tagId !== null,
  ].includes(true);
  const stale = state.status === 'ready' && state.query !== query;
  const tableStatus = stale ? 'loading' : tableStatusFor(state.status, tagFilter.status);
  useProductDetailsPrefetch(context, revision, viewKey, table, products, tableStatus === 'ready');
  const rowIntent = productDetailIntent(context, revision, table, products, tableStatus === 'ready');

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
    setFilters(noFilters);
    setTreeCategory(null);
    setLabelCategory(null);
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
        toaster.create({
          title:
            outcome.proposal === undefined
              ? k(bulkFailureKey(outcome.reason))
              : (pendingProposalMessage(outcome.proposal) ?? 'Awaiting approval. No changes have been applied.'),
          type: 'error',
        });
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
    const navigateToProduct = navigate<RegisteredRouter, string>;
    void browserRuntime.runPromise(
      Effect.tryPromise(
        navigateToProduct.bind(undefined, {
          search: productDetailSearch(context, revision),
          to: `/${language ?? 'cs'}/provoz/produkty/${encodeURIComponent(id)}`,
        }),
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

  return {
    archived,
    bulkBusy,
    byTree,
    canWrite,
    clearFilters,
    clearSelectionThen,
    closeDialog,
    dialog,
    filtersActive,
    filtersSettled,
    firstPage,
    k,
    labelCategory,
    labelItems,
    onCategoriesCommitted,
    onCommitted,
    openDetail,
    openDialog,
    pagination,
    products,
    productTagCatalog,
    productTags,
    ready,
    reload,
    revision,
    rowIntent,
    runBulk,
    selectedIds,
    selection,
    setLabelCategory,
    setPagination,
    setSelection,
    setSort,
    setTable,
    setTreeCategory,
    sort,
    state,
    t,
    tableStatus,
    tagFilter,
    treeCategory,
  };
};

type ProductListPage = ReturnType<typeof useProductListPage>;

/** The search and the filters beside it; the switches live in the filters form, the pickers in the page's state. */
const ProductFilters = ({ page }: { readonly page: ProductListPage }) => {
  const {
    byTree,
    canWrite,
    filtersSettled,
    firstPage,
    k,
    labelCategory,
    labelItems,
    productTagCatalog,
    ready,
    setLabelCategory,
    setSort,
    setTreeCategory,
    sort,
    t,
    tagFilter,
    treeCategory,
  } = page;
  return (
    <FormRoot
      className="flex flex-wrap items-start gap-150"
      defaultValues={noFilters}
      form={productFiltersForm}
      translateMessage={t}
    >
      <productFiltersForm.search
        aria-label={k('filters.search')}
        className="w-64"
        placeholder={k('filters.search')}
        size="sm"
        type="search"
      />
      {filtersSettled && (
        <>
          {byTree && (
            <div className="w-64">
              <CategorySearchCombobox
                allLabel={k('filters.allCategories')}
                errorMessage={k('filters.categoryError')}
                hiddenLabel
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
                items={[selectItem(ALL_CATEGORIES, k('filters.allCategories')), ...labelItems]}
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
              items={sortSelectItems(k)}
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
            <TagFilter
              catalog={productTagCatalog}
              kind="product"
              onChange={(tagId) => {
                tagFilter.setTagId(tagId);
                firstPage();
              }}
              value={tagFilter.tagId}
            />
          )}
          <productFiltersForm.lowStockOnly className="self-center" label={k('filters.lowStockOnly')} size="sm" />
          {(ready?.symmyProductCount ?? 0) > 0 && (
            <productFiltersForm.symmyOnly className="self-center" label={k('filters.symmyOnly')} size="sm" />
          )}
          {canWrite && <productFiltersForm.archived className="self-center" label={k('filters.archived')} size="sm" />}
        </>
      )}
    </FormRoot>
  );
};

const RecordsPageContent = (props: RecordsPageContentProps) => {
  const page = useProductListPage(props);
  const {
    archived,
    bulkBusy,
    byTree,
    canWrite,
    clearFilters,
    clearSelectionThen,
    closeDialog,
    dialog,
    filtersActive,
    k,
    onCategoriesCommitted,
    onCommitted,
    openDetail,
    openDialog,
    pagination,
    products,
    productTags,
    ready,
    reload,
    revision,
    rowIntent,
    runBulk,
    selectedIds,
    selection,
    setPagination,
    setSelection,
    setTable,
    state,
    tableStatus,
    tagFilter,
  } = page;

  return (
    <>
      <UltramodernRouteHead />
      <div className="flex h-[calc(var(--height-sidebar-viewport)_-_2*var(--spacing-250))] min-h-0 w-full min-w-0 flex-col gap-250">
        <PageHeader
          actions={
            canWrite ? (
              <div className="flex flex-wrap items-center gap-100">
                <CategoryAdminButton onCommitted={onCategoriesCommitted} />
                <Button
                  appearance="outline"
                  icon="icon-[mdi--package-down]"
                  onClick={() => openDialog('receipt')}
                  severity="secondary"
                  size="sm"
                >
                  {k('actions.receipt')}
                </Button>
                <Button icon="icon-[mdi--plus]" onClick={() => openDialog('create')} severity="primary" size="sm">
                  {k('actions.newProduct')}
                </Button>
              </div>
            ) : undefined
          }
          description={k('description')}
          title={k('title')}
        />

        <ProductStats indicators={ready?.indicators} label={k} />

        <ProductFilters page={page} />
        {tagFilter.status === 'error' && (
          <StatusText showIcon status="error">
            {k('states.tagFilterFailed')}
          </StatusText>
        )}

        <ProductBulkBar
          busy={bulkBusy}
          canWrite={canWrite && !archived}
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
            <Button onClick={() => window.location.reload()} severity="secondary">
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
          onReady={setTable}
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
          rowIntent={rowIntent}
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
              vat={companyVatOf(ready)}
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
              symmyProducts={products.filter(
                (product) => product.importedVia === 'symmy' && selectedIds.includes(product.id),
              )}
              variantProducts={products.filter(
                (product) => (product.variantCount ?? 0) > 0 && selectedIds.includes(product.id),
              )}
            />
            <CategoryDialog
              hasTree={byTree}
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

/** The Shell prepares the first page with the header indicators and the category filter before it reveals the page. */
export const preloadPage = modulePagePreload(
  (props) =>
    productListData.preload({
      legalEntityId: legalEntityOf(props),
      query: firstProductPage(PAGE_SIZE),
      scope: productScope(props.context),
    }),
  (props) => categoryChoicesData.preload(productCategoryKey(legalEntityOf(props), props.context)),
);

export const RecordsPage = (props: Partial<ModulePageProps>) => {
  const location = useRouterState({ select: (router) => router.location.href });
  return (
    <FederatedI18nBoundary
      defaultNamespace="merchandise"
      fallbackLanguage="en"
      resources={merchandiseI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent
        context={props.context}
        key={`${productScope(props.context) ?? ''}|${location}`}
        legalEntityId={legalEntityOf(props)}
      />
    </FederatedI18nBoundary>
  );
};

export default RecordsPage;
