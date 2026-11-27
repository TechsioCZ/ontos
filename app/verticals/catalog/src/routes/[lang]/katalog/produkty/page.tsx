import { hasKeptDraft, keepDraftOnReload, keptDraft } from '@app/shared-contracts';
import { modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps, PageData } from '@app/shared-contracts/page-data';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Effect, Option } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import type { ProductPageItem } from '../../../../../shared/apis/product-page.ts';
import { catalogI18nResources } from '../../../../i18n/resources';
import {
  catalogLocaleFromSearch,
  companyErpOffer,
  erpOfferFromSearch,
  rememberedErpOffer,
  rememberErpOffer,
} from '../../../../products-admin/erp-offer.ts';
import type { ErpOffer } from '../../../../products-admin/erp-offer.ts';
import { productListData, variantFiguresData } from '../../../../products-admin/page-data.ts';
import { erpStorefrontStatus } from '../../../../products-admin/erp-storefront-status.ts';
import { ErpVariantEditor, erpVariantKeepKey } from '../../../../products-admin/erp-variant-editor.tsx';
import { ProductEditDialog, erpProductKeepKey } from '../../../../products-admin/product-edit-dialog.tsx';
import type { ProductListInput, VariantFiguresInput } from '../../../../products-admin/page-data.ts';
import {
  formatPrice,
  formatQuantity,
  PRODUCT_PAGE_SIZE,
  productName,
  variantRows,
} from '../../../../products-admin/products-model.ts';
import type { PriceCell, StockCell } from '../../../../products-admin/products-model.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';

const key = 'catalog.pages.products';

/** What the Shell passes the page; a standalone render of the remote passes nothing. */
type ProductsPageProps = Partial<Pick<ModulePageProps, 'context' | 'search'>>;

const firstPage = (props: ProductsPageProps): ProductListInput | undefined =>
  props.context === undefined
    ? undefined
    : {
        legalEntityId: props.context.legalEntityId,
        locale: catalogLocaleFromSearch(props.search ?? ''),
        offset: 0,
        search: '',
      };

/** The Shell prepares the first page of products before it reveals the page. */
export const preloadPage = modulePagePreload((props) => {
  const input = firstPage(props);
  return input === undefined ? Effect.void : productListData.preload(input);
});

const useData = <I, A, E>(store: Pick<PageData<I, A, E>, 'ensure' | 'snapshot' | 'subscribe'>, input: I) => {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    () => store.snapshot(input),
    () => pageDataPending,
  );
  useEffect(() => store.ensure(input), [store, input]);
  return snapshot;
};

/** The offer the URL names, remembered in this browser; else the company's storefront offer; else the last remembered one. */
const useErpOffer = (search: string, legalEntityId: string): Option.Option<ErpOffer> => {
  const named = erpOfferFromSearch(search);
  const [remembered, setRemembered] = useState(Option.none<ErpOffer>);
  useEffect(() => {
    Option.match(erpOfferFromSearch(search), {
      onNone: () => setRemembered(rememberedErpOffer()),
      onSome: rememberErpOffer,
    });
  }, [search]);
  if (Option.isSome(named)) {
    return named;
  }
  const company = companyErpOffer(legalEntityId);
  return Option.isSome(company) ? company : remembered;
};

/** Says what is missing; the same layout as the Shell's empty states. */
const EmptyState = ({ description, title }: { readonly description: ReactNode; readonly title: string }) => (
  <div className="flex flex-col items-center gap-150 p-450 text-center">
    <p className="font-semibold text-md">{title}</p>
    <div className="max-w-prose text-fg-secondary text-sm">{description}</div>
  </div>
);

const lifecycleVariant = (lifecycle: string) => {
  if (lifecycle === 'ACTIVE') {
    return 'success' as const;
  }
  return lifecycle === 'RETIRED' ? ('outline' as const) : ('warning' as const);
};

const StockText = ({ cell }: { readonly cell: StockCell }) => {
  const { language, t } = useModernI18n();
  if (cell.kind === 'ON_HAND') {
    return <>{t(`${key}.stock.ON_HAND`, { quantity: formatQuantity(cell.quantity, language ?? 'cs') })}</>;
  }
  return <span className="text-fg-secondary">{t(`${key}.stock.${cell.kind}`)}</span>;
};

const PriceText = ({ cell }: { readonly cell: PriceCell }) => {
  const { language, t } = useModernI18n();
  if (cell.kind === 'PRICE') {
    return <>{formatPrice(cell.amount, cell.currencyCode, language ?? 'cs')}</>;
  }
  return <span className="text-fg-secondary">{t(`${key}.price.${cell.kind}`)}</span>;
};

const VariantTable = ({ input }: { readonly input: VariantFiguresInput }) => {
  const { t } = useModernI18n();
  const figures = useData(variantFiguresData, input);
  // After "Načíst novou verzi a obnovit úpravy" the Variant dialog that was open opens again with its figures.
  const [editing, setEditing] = useState<string | null>(
    () =>
      input.item.variants.find(({ variantRef }) => hasKeptDraft(erpVariantKeepKey(variantRef.resourceId)))?.variantRef
        .resourceId ?? null,
  );
  if (figures.state === 'pending') {
    return <StatusText status="default">{t(`${key}.variants.loading`)}</StatusText>;
  }
  if (figures.state === 'failed') {
    return <StatusText status="error">{t(`${key}.variants.failed`)}</StatusText>;
  }
  const rows = variantRows(input.item, figures.value);
  return (
    <Table size="sm" variant="line">
      <Table.Caption>{t(`${key}.variants.caption`)}</Table.Caption>
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>{t(`${key}.variants.sku`)}</Table.ColumnHeader>
          <Table.ColumnHeader>{t(`${key}.variants.options`)}</Table.ColumnHeader>
          <Table.ColumnHeader>{t(`${key}.variants.lifecycle`)}</Table.ColumnHeader>
          <Table.ColumnHeader>{t(`${key}.variants.price`)}</Table.ColumnHeader>
          <Table.ColumnHeader>{t(`${key}.variants.stock`)}</Table.ColumnHeader>
          <Table.ColumnHeader />
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((row) => (
          <Table.Row key={row.variantId}>
            <Table.Cell>{row.sku ?? t(`${key}.variants.noSku`)}</Table.Cell>
            <Table.Cell>{row.options === '' ? (row.name ?? '—') : row.options}</Table.Cell>
            <Table.Cell>
              <Badge size="sm" variant={lifecycleVariant(row.lifecycle)}>
                {t(`${key}.variantLifecycle.${row.lifecycle}`)}
              </Badge>
            </Table.Cell>
            <Table.Cell>
              <PriceText cell={row.price} />
            </Table.Cell>
            <Table.Cell>
              <StockText cell={row.stock} />
            </Table.Cell>
            <Table.Cell>
              {Option.isSome(input.offer) && (
                <Button
                  onClick={() => setEditing(row.variantId)}
                  size="sm"
                  theme="outlined"
                  type="button"
                  variant="secondary"
                >
                  Cena a sklad
                </Button>
              )}
              {editing === row.variantId && Option.isSome(input.offer) && (
                <ErpVariantEditor
                  item={input.item}
                  offer={input.offer.value}
                  onClose={() => setEditing(null)}
                  variantId={row.variantId}
                />
              )}
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
};

const ProductRows = ({
  categories,
  item,
  legalEntityId,
  locale,
  offer,
}: {
  readonly categories: ProductPageItem['categories'];
  readonly item: ProductPageItem;
  readonly legalEntityId: string;
  readonly locale: string;
  readonly offer: Option.Option<ErpOffer>;
}) => {
  const { t } = useModernI18n();
  // A dialog open before "Načíst novou verzi a obnovit úpravy" opens again with what was typed in it.
  const [open, setOpen] = useState(() =>
    item.variants.some(({ variantRef }) => hasKeptDraft(erpVariantKeepKey(variantRef.resourceId))),
  );
  const [editing, setEditing] = useState(() => hasKeptDraft(erpProductKeepKey(item)));
  const name = productName(item.localized);
  const toggle = () => setOpen((current) => !current);
  return (
    <>
      <Table.Row>
        <Table.Cell>{name ?? t(`${key}.noName`)}</Table.Cell>
        <Table.Cell>
          <Badge size="sm" variant={lifecycleVariant(item.lifecycle)}>
            {t(`${key}.lifecycle.${item.lifecycle}`)}
          </Badge>
        </Table.Cell>
        <Table.Cell>{item.variants.length}</Table.Cell>
        <Table.Cell>
          {Option.match(erpStorefrontStatus(item, legalEntityId), {
            onNone: () => '—',
            onSome: (status) => (
              <span
                className="flex flex-col gap-50"
                data-storefront-status={status.visible ? 'visible' : 'hidden'}
                title={[...status.reasons.map((reason) => `${reason.why} ${reason.fix}`), ...status.notes].join('\n')}
              >
                <span className="flex items-center gap-100">
                  <Badge size="sm" variant={status.visible ? 'success' : 'warning'}>
                    {status.visible ? 'Na e-shopu: ano' : 'Na e-shopu: ne'}
                  </Badge>
                  {status.href !== undefined && (
                    <Link external href={status.href} target="_blank">
                      Otevřít
                    </Link>
                  )}
                </span>
                {status.reasons.map((reason) => (
                  <span className="text-fg-secondary text-xs" key={reason.why}>
                    {reason.why} {reason.fix}
                  </span>
                ))}
              </span>
            ),
          })}
        </Table.Cell>
        <Table.Cell>
          <Button aria-expanded={open} onClick={toggle} size="sm" theme="borderless" type="button" variant="secondary">
            {t(open ? `${key}.hideVariants` : `${key}.showVariants`)}
          </Button>
          <Button onClick={() => setEditing(true)} size="sm" theme="outlined" type="button" variant="secondary">
            Upravit
          </Button>
          {editing && (
            <ProductEditDialog
              categories={categories}
              item={item}
              legalEntityId={legalEntityId}
              locale={locale}
              onClose={() => setEditing(false)}
            />
          )}
        </Table.Cell>
      </Table.Row>
      {open && (
        <Table.Row>
          <Table.Cell colSpan={5}>
            <VariantTable input={{ item, legalEntityId, offer }} />
          </Table.Cell>
        </Table.Row>
      )}
    </>
  );
};

const ProductsList = ({
  input,
  offer,
}: {
  readonly input: ProductListInput;
  readonly offer: Option.Option<ErpOffer>;
}) => {
  const { t } = useModernI18n();
  const page = useData(productListData, input);
  if (page.state === 'pending') {
    return <StatusText status="default">{t(`${key}.loading`)}</StatusText>;
  }
  if (page.state === 'failed') {
    return <EmptyState description={t(`${key}.failedDescription`)} title={t(`${key}.failed`)} />;
  }
  if (page.value.items.length === 0) {
    return <EmptyState description={t(`${key}.emptyDescription`)} title={t(`${key}.empty`)} />;
  }
  const pageCategories = [
    ...new Map(
      page.value.items.flatMap(({ categories }) =>
        categories.map((category) => [category.categoryRef.resourceId, category] as const),
      ),
    ).values(),
  ];
  return (
    <Table size="sm" variant="line">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>{t(`${key}.columns.name`)}</Table.ColumnHeader>
          <Table.ColumnHeader>{t(`${key}.columns.lifecycle`)}</Table.ColumnHeader>
          <Table.ColumnHeader>{t(`${key}.columns.variants`)}</Table.ColumnHeader>
          <Table.ColumnHeader>Na e-shopu</Table.ColumnHeader>
          <Table.ColumnHeader>{t(`${key}.columns.detail`)}</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {page.value.items.map((item) => (
          <ProductRows
            categories={pageCategories}
            item={item}
            key={item.productRef.resourceId}
            legalEntityId={input.legalEntityId}
            locale={input.locale}
            offer={offer}
          />
        ))}
      </Table.Body>
    </Table>
  );
};

const Pager = ({
  input,
  onOffset,
}: {
  readonly input: ProductListInput;
  readonly onOffset: (offset: number) => void;
}) => {
  const { t } = useModernI18n();
  const page = useData(productListData, input);
  const count = page.state === 'ready' ? page.value.count : 0;
  const shown = page.state === 'ready' ? page.value.items.length : 0;
  const previous = () => onOffset(Math.max(0, input.offset - PRODUCT_PAGE_SIZE));
  const next = () => onOffset(input.offset + PRODUCT_PAGE_SIZE);
  return (
    <div className="flex flex-wrap items-center justify-between gap-150">
      <span className="text-fg-secondary text-sm">
        {shown === 0
          ? t(`${key}.rangeEmpty`)
          : t(`${key}.range`, { from: input.offset + 1, to: input.offset + shown, total: count })}
      </span>
      <div className="flex gap-100">
        <Button
          disabled={input.offset === 0}
          onClick={previous}
          size="sm"
          theme="outlined"
          type="button"
          variant="secondary"
        >
          {t(`${key}.previous`)}
        </Button>
        <Button
          disabled={input.offset + shown >= count}
          onClick={next}
          size="sm"
          theme="outlined"
          type="button"
          variant="secondary"
        >
          {t(`${key}.next`)}
        </Button>
      </div>
    </div>
  );
};

/** The list page a reload that keeps drafts comes back to, so the row of a kept dialog is on screen again. */
const QUERY_KEEP_KEY = 'catalog:erp-products:query';

interface ListQuery {
  readonly offset: number;
  readonly search: string;
}

const ProductsPageContent = (props: ProductsPageProps) => {
  const { language, t } = useModernI18n();
  const search = props.search ?? '';
  const offer = useErpOffer(search, props.context?.legalEntityId ?? '');
  const [keptQuery] = useState(() => keptDraft<ListQuery>(QUERY_KEEP_KEY));
  const [draft, setDraft] = useState(() => keptQuery?.search ?? '');
  const [query, setQuery] = useState<ListQuery>(() => keptQuery ?? { offset: 0, search: '' });
  useEffect(
    () => keepDraftOnReload(QUERY_KEEP_KEY, () => (query.offset === 0 && query.search === '' ? undefined : query)),
    [query],
  );
  if (props.context === undefined) {
    return <EmptyState description={t(`${key}.noCompanyDescription`)} title={t(`${key}.noCompany`)} />;
  }
  const input: ProductListInput = {
    legalEntityId: props.context.legalEntityId,
    locale: catalogLocaleFromSearch(search),
    offset: query.offset,
    search: query.search,
  };
  const setOffset = (offset: number) => setQuery((current) => ({ ...current, offset }));
  return (
    <div className="flex flex-col gap-250">
      <header className="flex flex-col gap-100">
        <h1 className="font-semibold text-xl">{t(`${key}.title`)}</h1>
        <p className="max-w-prose text-fg-secondary text-sm">{t(`${key}.intro`)}</p>
        <Link href={`/${language ?? 'cs'}/provoz/produkty`}>{t(`${key}.editorLink`)}</Link>
      </header>
      <section className="flex flex-col gap-200 rounded-lg border border-border-primary p-250">
        <form
          className="flex flex-wrap items-end gap-150"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery({ offset: 0, search: draft });
          }}
        >
          <Input
            aria-label={t(`${key}.search`)}
            className="w-64"
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t(`${key}.search`)}
            size="sm"
            value={draft}
          />
          <Button size="sm" theme="outlined" type="submit" variant="secondary">
            {t(`${key}.searchSubmit`)}
          </Button>
        </form>
        <ProductsList input={input} offer={offer} />
        <Pager input={input} onOffset={setOffset} />
      </section>
    </div>
  );
};

export const ProductsPage = (props: ProductsPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="catalog"
    fallbackLanguage="en"
    resources={catalogI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <UltramodernRouteHead />
    <ProductsPageContent {...props} />
  </FederatedI18nBoundary>
);

export default ProductsPage;
