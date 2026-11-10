import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { selectItem } from '../../../../ui/select-item.ts';
import {
  formatDate,
  formatMoney,
  PageHeader,
  SaveBar,
  saveLabelsFor,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import { DateTime, Schema } from 'effect';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { useState } from 'react';
import type { CategoryTrail, ProductRecord, StockMovement } from '../../../../../shared/apis/records.ts';
import type { ProductUnit, VatRate } from '../../../../../shared/domain/merchandise-model.ts';
import { orderLineVatMinor } from '../../../../../shared/domain/order-totals.ts';
import { MONEY_FORMAT, WHOLE_NUMBER_FORMAT } from '../../../../form-number.ts';
import { useProductDetailDraft } from './product-detail-save.ts';
import { detailDraftInvalid, draftOf, measurementInvalid } from './product-detail-draft.ts';
import type { DetailDraft } from './product-detail-draft.ts';
import {
  PRODUCT_LIMITS,
  UNITS,
  VAT_RATES,
  fieldError,
  lowStockErrorKey,
  priceErrorKey,
  tooLongMessage,
} from './product-form-validation.ts';
import { useProductLabel } from './product-form-labels.ts';
import { MovementForm, MovementsTable } from './product-movements.tsx';
import { EMPTY_MOVEMENT_DRAFT, isMovementDraftDirty } from './product-movement-draft.ts';
import { AvailabilityBadge, EshopPanel, VariantsPanel, VariantPriceHistory } from './product-eshop.tsx';
import { resolveProductVariantDestination } from './product-variant-destination.ts';
import { ProductImageGallery } from './product-image-gallery.tsx';
import { CatalogContentPanel } from './product-catalog-content.tsx';
import { MarketsPanel } from './product-markets.tsx';
import type { ProductMarket } from '../../../../../shared/domain/market-offers.ts';
import type { MovementDraft } from './product-movement-draft.ts';

const ProductDetailTabSchema = Schema.Literals([
  'detail',
  'variants',
  'eshop',
  'content',
  'markets',
  'prices',
  'movements',
]);
/** The tabs of the product editor, owned by the page so the active tab survives a product reload. */
export type ProductDetailTab = typeof ProductDetailTabSchema.Type;
const isProductDetailTab = Schema.is(ProductDetailTabSchema);

export interface ProductDetailViewProps {
  readonly canMoveStock?: boolean;
  readonly canWrite: boolean;
  /** The product's tree category with its path label; null when it has none. */
  readonly category?: CategoryTrail | null;
  readonly hasCategoryTree?: boolean;
  /**
   * The product's offer and price in every configured market of the company, and whether the viewer may switch it
   * (records `canManageMarkets`).
   */
  readonly markets?: ProductMarketsAccess;
  readonly movements: readonly StockMovement[];
  readonly onBack: () => void;
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  /** Called when the user picks another tab; the page keeps the active tab across product reloads. */
  readonly onTabChange: (tab: ProductDetailTab) => void;
  readonly product: ProductRecord;
  readonly revision: number;
  readonly storefrontOrigin?: string;
  /** The active tab, owned by the page so that it survives the remount after a product reload. */
  readonly tab: ProductDetailTab;
  /** The opaque variant target from the URL; resolution happens against the current authorized product. */
  readonly variantId?: string | undefined;
}

/** Writable subset of ProductPatch, filled field by field so only changed values are sent. */

/** Tab contents stay mounted so unsaved fields survive tab switches. */
const DETAIL_FORM_ID = 'product-detail-form';
/** A product's markets on the detail page and whether the viewer may switch its offer in them. */
export interface ProductMarketsAccess {
  readonly canManage: boolean;
  readonly entries: readonly ProductMarket[];
}
const NO_MARKETS: ProductMarketsAccess = { canManage: false, entries: [] };
const REQUIRED_MESSAGE_KEY = 'validation.required';

const PriceHistory = ({ product }: { readonly product: ProductRecord }) => {
  const k = useProductLabel();
  if ((product.variantRecords ?? []).length > 0) {
    return <VariantPriceHistory product={product} />;
  }
  const rows = product.priceHistory.toSorted(
    (left, right) => DateTime.toEpochMillis(right.effectiveFrom) - DateTime.toEpochMillis(left.effectiveFrom),
  );

  if (rows.length === 0) {
    return <p className="text-fg-secondary text-sm">{k('prices.empty')}</p>;
  }
  return (
    <Table size="sm" variant="line">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader align="end">{k('prices.columnPrice')}</Table.ColumnHeader>
          <Table.ColumnHeader>{k('prices.columnValidFrom')}</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((entry) => (
          <Table.Row key={DateTime.toEpochMillis(entry.effectiveFrom)}>
            <Table.Cell align="end" className="tabular-nums">
              {formatMoney(entry.priceMinor)}
            </Table.Cell>
            <Table.Cell>{formatDate(DateTime.formatIso(entry.effectiveFrom))}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
};

/** The editable fields of the product. The view keeps the draft; only the Save button under the form sends it. */
interface DetailFormProps {
  readonly canWrite: boolean;
  readonly draft: DetailDraft;
  readonly onDraftChange: (patch: Partial<DetailDraft>) => void;
  /** The form was submitted (Enter in a field): the same one save as the Save button. */
  readonly onSave: () => void;
  readonly product: ProductRecord;
}

const DetailForm = ({ canWrite, draft, onDraftChange, onSave, product }: DetailFormProps) => {
  const k = useProductLabel();
  const disabled = !canWrite;
  const { active, category, lowStock, lowStockText, name, priceCzk, priceText, unit, vatRate } = draft;
  const setActive = (value: boolean) => {
    onDraftChange({ active: value });
  };
  const setCategory = (value: string) => {
    onDraftChange({ category: value });
  };
  const setName = (value: string) => {
    onDraftChange({ name: value });
  };
  const setUnit = (value: ProductUnit) => {
    onDraftChange({ unit: value });
  };
  const setVatRate = (value: VatRate) => {
    onDraftChange({ vatRate: value });
  };

  const nameError = name.trim() === '' ? k(REQUIRED_MESSAGE_KEY) : tooLongMessage(k, name, PRODUCT_LIMITS.name);
  const categoryError =
    category.trim() === '' ? k(REQUIRED_MESSAGE_KEY) : tooLongMessage(k, category, PRODUCT_LIMITS.category);
  const priceKey = priceErrorKey(priceCzk);
  const priceError = priceKey === undefined ? undefined : k(priceKey);
  const lowStockKey = lowStockErrorKey(lowStock);
  const lowStockError = lowStockKey === undefined ? undefined : k(lowStockKey);
  const priceMinor = Math.round(priceCzk * 100);
  const draftInvalid = detailDraftInvalid(draft);
  const grossMinor =
    Number.isFinite(priceMinor) && priceMinor >= 0
      ? priceMinor + orderLineVatMinor({ quantity: 1, unitPriceMinor: priceMinor, vatRate })
      : null;

  // noValidate: the save bar and the field messages say what is missing; native validation would only add a second,
  // differently worded set of messages.
  return (
    <form
      className="grid grid-cols-1 gap-200 lg:grid-cols-2"
      id={DETAIL_FORM_ID}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <FormInput disabled id="detail-sku" label={k('fields.sku')} name="sku" value={product.sku} />
      <FormInput
        autoComplete="off"
        disabled={disabled}
        id="detail-name"
        label={k('fields.name')}
        name="name"
        onChange={(event) => setName(event.target.value)}
        required
        value={name}
        {...fieldError(true, nameError)}
      />
      <FormInput
        autoComplete="off"
        disabled={disabled}
        id="detail-category"
        label={k('fields.category')}
        name="category"
        onChange={(event) => setCategory(event.target.value)}
        required
        value={category}
        {...fieldError(true, categoryError)}
      />
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <SelectTemplate
          disabled={disabled}
          items={UNITS.map((value) => selectItem(value, value))}
          label={k('fields.unit')}
          name="unit"
          onValueChange={(details) => {
            const [next] = details.value;
            const picked = UNITS.find((value) => value === next);
            if (picked !== undefined) {
              setUnit(picked);
            }
          }}
          placeholder={k('selectPlaceholder')}
          value={[unit]}
        />
        <SelectTemplate
          disabled={disabled}
          items={VAT_RATES.map((rate) => selectItem(String(rate), `${rate} %`))}
          label={k('fields.vat')}
          name="vat"
          onValueChange={(details) => {
            const [next] = details.value;
            const picked = VAT_RATES.find((rate) => String(rate) === next);
            if (picked !== undefined) {
              setVatRate(picked);
            }
          }}
          placeholder={k('selectPlaceholder')}
          value={[String(vatRate)]}
        />
      </div>
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <FormNumericInput
          disabled={disabled}
          formatOptions={MONEY_FORMAT}
          id="detail-price"
          label={k('fields.priceNet')}
          locale="cs-CZ"
          min={0}
          name="price"
          onValueChange={(details) => {
            onDraftChange({ priceCzk: details.valueAsNumber, priceText: details.value });
          }}
          required
          step={1}
          value={priceText}
          {...fieldError(true, priceError)}
        >
          <NumericInput.Control>
            <NumericInput.Input aria-valuemax={undefined} />
          </NumericInput.Control>
        </FormNumericInput>
        <FormNumericInput
          clampValueOnBlur={false}
          disabled={disabled}
          formatOptions={WHOLE_NUMBER_FORMAT}
          id="detail-low-stock"
          label={k('fields.lowStock')}
          locale="cs-CZ"
          min={0}
          name="lowStock"
          onValueChange={(details) => {
            onDraftChange({ lowStock: details.valueAsNumber, lowStockText: details.value });
          }}
          step={1}
          value={lowStockText}
          {...fieldError(true, lowStockError)}
        >
          <NumericInput.Control>
            <NumericInput.Input aria-valuemax={undefined} />
          </NumericInput.Control>
        </FormNumericInput>
      </div>
      <FormInput
        disabled
        id="detail-price-gross"
        label={k('fields.priceGross')}
        name="grossPrice"
        value={grossMinor === null ? '—' : formatMoney(grossMinor)}
      />
      <p className="text-fg-secondary text-sm">{k('detail.priceExplanation')}</p>
      <FormTextarea
        disabled={disabled}
        id="detail-short-description"
        label={k('fields.shortDescription')}
        maxLength={500}
        name="shortDescription"
        onChange={(event) => onDraftChange({ shortDescription: event.target.value })}
        value={draft.shortDescription}
      />
      <FormTextarea
        disabled={disabled}
        id="detail-description"
        label={k('fields.description')}
        maxLength={20_000}
        name="description"
        onChange={(event) => onDraftChange({ description: event.target.value })}
        value={draft.description}
      />
      {(['weightGrams', 'lengthMm', 'widthMm', 'heightMm'] as const).map((field) => (
        <FormInput
          disabled={disabled}
          id={`detail-${field}`}
          key={field}
          label={k(`fields.${field}`)}
          min={1}
          name={field}
          onChange={(event) => onDraftChange({ [field]: event.target.value })}
          step={1}
          type="number"
          value={draft[field]}
          {...fieldError(true, measurementInvalid(draft[field]) ? k('validation.measurement') : undefined)}
        />
      ))}
      {draft.realVariants.length > 0 ? (
        <div className="flex flex-col gap-100 lg:col-span-2">
          <h2 className="font-semibold">{k('fields.variants')}</h2>
          <p className="text-fg-secondary text-sm">
            Produkt má {draft.realVariants.length} prodejní varianty s vlastní cenou a skladem — upravte je na kartě
            „Varianty a ceny“.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-200 lg:col-span-2">
          <h2 className="font-semibold">{k('fields.variants')}</h2>
          <p className="text-fg-secondary text-sm">{k('detail.variantsExplanation')}</p>
          {draft.variants.map((variant) => (
            <div className="grid grid-cols-1 items-end gap-150 sm:grid-cols-3" key={variant.key}>
              <FormInput
                disabled={disabled}
                id={`variant-name-${variant.key}`}
                label={k('fields.variantName')}
                maxLength={100}
                name={`variant-name-${variant.key}`}
                onChange={(event) =>
                  onDraftChange({
                    variants: draft.variants.map((current) =>
                      current.key === variant.key ? { ...current, name: event.target.value } : current,
                    ),
                  })
                }
                required
                value={variant.name}
                {...fieldError(true, variant.name.trim() === '' ? k(REQUIRED_MESSAGE_KEY) : undefined)}
              />
              <FormInput
                disabled={disabled}
                id={`variant-attributes-${variant.key}`}
                label={k('fields.variantAttributes')}
                maxLength={1000}
                name={`variant-attributes-${variant.key}`}
                onChange={(event) =>
                  onDraftChange({
                    variants: draft.variants.map((current) =>
                      current.key === variant.key ? { ...current, attributes: event.target.value } : current,
                    ),
                  })
                }
                value={variant.attributes}
              />
              {canWrite && (
                <Button
                  onClick={() =>
                    onDraftChange({ variants: draft.variants.filter((current) => current.key !== variant.key) })
                  }
                  theme="outlined"
                  type="button"
                  variant="secondary"
                >
                  {k('detail.removeVariant')}
                </Button>
              )}
            </div>
          ))}
          {canWrite && (
            <Button
              disabled={draft.variants.length >= 50}
              onClick={() =>
                onDraftChange({
                  nextVariantId: draft.nextVariantId + 1,
                  variants: [...draft.variants, { attributes: '', key: draft.nextVariantId, name: '' }],
                })
              }
              theme="outlined"
              type="button"
              variant="secondary"
            >
              {k('detail.addVariant')}
            </Button>
          )}
          {draftInvalid && <StatusText status="error">{k('validation.metadata')}</StatusText>}
        </div>
      )}
      <Switch checked={active} disabled={disabled} name="active" onCheckedChange={setActive}>
        {k('detail.active')}
      </Switch>
    </form>
  );
};

/**
 * Full-page product editor, keyed by product id. Editing the fields changes only the draft on screen; the Save
 * button under the form sends it, and leaving with unsaved changes asks first. The editor stays mounted while its
 * product reloads. A reloaded product replaces an untouched draft; a draft with unsaved changes stays, and its save
 * still expects the revision it was based on, so a change someone else made in the meantime ends in a conflict
 * instead of being overwritten. The active tab is owned by the page.
 */
export const ProductDetailView = ({
  canWrite,
  canMoveStock = canWrite,
  category = null,
  hasCategoryTree = false,
  markets = NO_MARKETS,
  movements,
  onBack,
  onCommitted,
  onReload,
  onTabChange,
  product,
  revision,
  storefrontOrigin,
  tab,
  variantId,
}: ProductDetailViewProps) => {
  const k = useProductLabel();
  const { language } = useModernI18n();
  const labels = saveLabelsFor(language);
  const [movementDraft, setMovementDraft] = useState(EMPTY_MOVEMENT_DRAFT);
  const variantDestination = resolveProductVariantDestination(product, variantId);
  // The page re-reads the product after each save; the editor stays mounted across that reload
  // (`useProductDetailDraft`).
  const { draft, followStockCommit, record } = useProductDetailDraft({ product, revision });
  // A half-filled stock movement is its own command with its own button; leaving would lose it all the same.
  const movementDirty = isMovementDraftDirty(movementDraft);
  const dirty = record.dirty || movementDirty;
  // Router navigation, including browser Back and Shell links, asks the same question as every other way out. The
  // guard owns the browser's prompt for a closing tab.
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => {
      record.discard();
      setMovementDraft(EMPTY_MOVEMENT_DRAFT);
    },
    otherChanges: movementDirty,
  });
  const updateDraft = (patch: Partial<DetailDraft>) => {
    record.setDraft((current) => ({ ...current, ...patch }));
  };
  const updateMovementDraft = (patch: Partial<MovementDraft>) => {
    setMovementDraft((current) => ({ ...current, ...patch }));
  };

  const handleSave = record.save;
  const handleReloadLatest = () => {
    record.adopt(draftOf(product));
    onReload();
  };

  return (
    <>
      <div className="flex w-full min-w-0 flex-col gap-250">
        <PageHeader
          actions={
            <Button
              className="shrink-0 whitespace-nowrap"
              onClick={() => onBack()}
              theme="outlined"
              variant="secondary"
            >
              {k('detail.back')}
            </Button>
          }
          description={
            <span className="flex flex-wrap items-center gap-100">
              <span>{`${product.sku} · ${product.category} · ${
                product.grossPriceMinor === undefined
                  ? formatMoney(product.currentPriceMinor)
                  : `${(product.variantRecords ?? []).length > 0 ? 'od ' : ''}${formatMoney(product.grossPriceMinor)} s DPH`
              }`}</span>
              <AvailabilityBadge value={product.availability} />
            </span>
          }
          title={product.name}
        />
        <Tabs
          onValueChange={(value) => {
            if (isProductDetailTab(value)) {
              onTabChange(value);
            }
          }}
          value={tab}
          variant="line"
        >
          <div style={{ overflowX: 'auto' }}>
            <Tabs.List style={{ minWidth: '100%', width: 'max-content' }}>
              <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="detail">
                {k('detail.tab')}
              </Tabs.Trigger>
              <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="variants">
                Varianty a ceny
              </Tabs.Trigger>
              <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="eshop">
                E-shop a obrázky
              </Tabs.Trigger>
              <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="content">
                Obsah e-shopu
              </Tabs.Trigger>
              <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="markets">
                {k('markets.tab')}
              </Tabs.Trigger>
              <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="prices">
                {k('prices.tab')}
              </Tabs.Trigger>
              <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="movements">
                {k('movements.tab')}
              </Tabs.Trigger>
              <Tabs.Indicator />
            </Tabs.List>
          </div>
          <Tabs.Content className="flex flex-col gap-200 py-200" value="detail">
            <DetailForm
              canWrite={canWrite}
              draft={draft}
              onDraftChange={updateDraft}
              onSave={handleSave}
              product={product}
            />
            {/* The form's footer: the one Save button of the product fields, with the state of the draft. */}
            {canWrite && (
              <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
            )}
          </Tabs.Content>
          <Tabs.Content className="py-200" value="variants">
            <VariantsPanel
              canMoveStock={canMoveStock}
              canWrite={canWrite}
              key={`variants-${DateTime.formatIso(product.updatedAt)}`}
              onCommitted={onCommitted}
              onReload={onReload}
              onStockCommitted={followStockCommit}
              product={product}
              revision={revision}
              variantDestination={variantDestination}
            />
          </Tabs.Content>
          <Tabs.Content className="flex flex-col gap-250 py-200" value="eshop">
            {/* Every staff writer curates product photos, also where catalog data stays with administrators. */}
            <ProductImageGallery
              canWrite={canMoveStock}
              images={product.images ?? []}
              onChanged={onReload}
              productId={product.id}
              productName={product.name}
            />
            <EshopPanel
              {...(storefrontOrigin === undefined ? {} : { storefrontOrigin })}
              canWrite={canWrite}
              key={`eshop-${DateTime.formatIso(product.updatedAt)}`}
              onArchived={onBack}
              onCommitted={onCommitted}
              onReload={onReload}
              product={product}
              revision={revision}
            />
          </Tabs.Content>
          <Tabs.Content className="py-200" value="content">
            <CatalogContentPanel
              canWrite={canWrite}
              category={category}
              hasCategoryTree={hasCategoryTree}
              key={`content-${DateTime.formatIso(product.updatedAt)}`}
              onCommitted={onCommitted}
              onReload={onReload}
              product={product}
              revision={revision}
            />
          </Tabs.Content>
          <Tabs.Content className="py-200" value="markets">
            <MarketsPanel
              canManage={markets.canManage}
              markets={markets.entries}
              onCommitted={onCommitted}
              onReload={onReload}
              product={product}
              revision={revision}
            />
          </Tabs.Content>
          <Tabs.Content className="py-200" value="prices">
            <PriceHistory product={product} />
          </Tabs.Content>
          <Tabs.Content className="flex flex-col gap-200 py-200" value="movements">
            <MovementsTable movements={movements} variants={product.variantRecords} />
            {canMoveStock && (
              <MovementForm
                draft={movementDraft}
                onCommitted={onCommitted}
                onDraftChange={updateMovementDraft}
                onReload={onReload}
                onStockCommitted={followStockCommit}
                productId={product.id}
                revision={revision}
                stockOnHand={product.stockOnHand}
                variants={product.variantRecords}
              />
            )}
          </Tabs.Content>
        </Tabs>
      </div>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
