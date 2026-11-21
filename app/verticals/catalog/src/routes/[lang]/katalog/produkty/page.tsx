import { modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps, PageData } from '@app/shared-contracts/page-data';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Effect, Option } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import type { ProductPageItem } from '../../../../../shared/apis/product-page.ts';
import { catalogI18nResources } from '../../../../i18n/resources';
import {
  catalogLocaleFromSearch,
  erpOfferFromSearch,
  rememberedErpOffer,
  rememberErpOffer,
} from '../../../../products-admin/erp-offer.ts';
import type { ErpOffer } from '../../../../products-admin/erp-offer.ts';
import { productListData, variantFiguresData } from '../../../../products-admin/page-data.ts';
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

/** The offer the URL names, remembered in this browser; else the last remembered one. */
const useErpOffer = (search: string): Option.Option<ErpOffer> => {
  const named = erpOfferFromSearch(search);
  const [remembered, setRemembered] = useState(Option.none<ErpOffer>);
  useEffect(() => {
    Option.match(erpOfferFromSearch(search), {
      onNone: () => setRemembered(rememberedErpOffer()),
      onSome: rememberErpOffer,
    });
  }, [search]);
  return Option.isSome(named) ? named : remembered;
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
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
};

const ProductRows = ({
  item,
  legalEntityId,
  offer,
}: {
  readonly item: ProductPageItem;
  readonly legalEntityId: string;
  readonly offer: Option.Option<ErpOffer>;
}) => {
  const { t } = useModernI18n();
  const [open, setOpen] = useState(false);
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
          <Button aria-expanded={open} onClick={toggle} size="sm" theme="borderless" type="button" variant="secondary">
            {t(open ? `${key}.hideVariants` : `${key}.showVariants`)}
          </Button>
        </Table.Cell>
      </Table.Row>
      {open && (
        <Table.Row>
          <Table.Cell colSpan={4}>
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
  return (
    <Table size="sm" variant="line">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>{t(`${key}.columns.name`)}</Table.ColumnHeader>
          <Table.ColumnHeader>{t(`${key}.columns.lifecycle`)}</Table.ColumnHeader>
          <Table.ColumnHeader>{t(`${key}.columns.variants`)}</Table.ColumnHeader>
          <Table.ColumnHeader>{t(`${key}.columns.detail`)}</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {page.value.items.map((item) => (
          <ProductRows item={item} key={item.productRef.resourceId} legalEntityId={input.legalEntityId} offer={offer} />
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

const ProductsPageContent = (props: ProductsPageProps) => {
  const { t } = useModernI18n();
  const search = props.search ?? '';
  const offer = useErpOffer(search);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState({ offset: 0, search: '' });
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
      </header>
      {Option.isNone(offer) && <StatusText status="warning">{t(`${key}.offerMissing`)}</StatusText>}
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
