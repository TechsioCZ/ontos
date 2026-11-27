import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@app/admin-ui/form-controls';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { selectItem } from '../../../../ui/select-item.ts';
import {
  formatDate,
  formatMoney,
  PageHeader,
  requiredLabelFor,
  SaveBar,
  saveLabelsFor,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import {
  Field,
  FormBuilder,
  FormInputField,
  FormReact,
  FormRoot,
  FormTextareaField,
  NumberTextSchema,
  NumericField,
  SwitchField,
  unrenderedField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { CzVatClassificationCodeSchema } from '@app/shared-contracts/cz-vat-classifications';
import { DateTime, Effect, Option, Schema } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { reloadKeepingDrafts } from '@app/shared-contracts';
import type { Dispatch, SetStateAction } from 'react';

import type { CategoryTrail, LedgerMovement, ProductRecord } from '../../../../../shared/apis/records.ts';
import { ProductUnitSchema } from '../../../../../shared/domain/merchandise-model.ts';
import type { ProductVariant } from '../../../../../shared/domain/merchandise-model.ts';
import { MONEY_FORMAT, WHOLE_NUMBER_FORMAT } from '../../../../form-number.ts';
import { useProductDetailDraft } from './product-detail-save.ts';
import { detailDraftInvalid, measurementInvalid, detailGrossOf, detailVatOf } from './product-detail-draft.ts';
import type { DetailDraft } from './product-detail-draft.ts';
import {
  PRODUCT_LIMITS,
  UNITS,
  fieldVerdict,
  lowStockErrorKey,
  priceErrorKey,
  tooLongMessage,
} from './product-form-validation.ts';
import { useProductLabel } from './product-form-labels.ts';
import { rateAt, useTaxLabels } from './product-tax-classification.ts';
import type { CompanyVat } from './product-tax-classification.ts';
import { TaxClassificationSelect } from './product-tax-classification-select.tsx';
import { MovementForm, MovementsTable, useMovementDraft } from './product-movements.tsx';
import { AvailabilityBadge, VariantsPanel, VariantPriceHistory } from './product-eshop.tsx';
import { StorefrontStatusPanel } from './storefront-status.tsx';
import { ErpCodeLine, SymmyImportedBadge, SymmyWriteThroughNote } from './symmy-provenance.tsx';
import { EshopPanel } from './product-eshop-panel.tsx';
import { resolveProductVariantDestination } from './product-variant-destination.ts';
import { CatalogContentPanel } from './product-catalog-content.tsx';
import { SalesTermsPanel } from './product-sales-terms.tsx';
import { MarketsPanel } from './product-markets.tsx';
import type { ProductMarket } from '../../../../../shared/domain/market-offers.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useRecordForm } from '../../../../ui/record-form.ts';

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
  /** Path labels of the product's categories (additional ones included). */
  readonly categoryTrails?: readonly CategoryTrail[];
  readonly hasCategoryTree?: boolean;
  /** The newest page of the product's ledger (oldest first) and whether older movements exist (loaded on request). */
  readonly ledger: { readonly hasOlder: boolean; readonly movements: readonly LedgerMovement[] };
  /**
   * The product's offer and price in every configured market of the company, and whether the viewer may switch it
   * (records `canManageMarkets`).
   */
  readonly markets?: ProductMarketsAccess;
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
  /** The company's VAT rates from the staff records read (current and scheduled periods); Tax owns them. */
  readonly vat: CompanyVat;
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
const NO_TRAILS: readonly CategoryTrail[] = [];
const REQUIRED_MESSAGE_KEY = 'validation.required';
const grossLabelKeys = {
  fromVariants: 'fields.priceGrossFromVariants',
  preview: 'fields.priceGrossPreview',
  stored: 'fields.priceGross',
} as const;

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
    <Table appearance="line" size="sm">
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

/**
 * The editable fields of the open product. Typing changes only this form; the Save button under it sends the draft,
 * and Enter in a field is the same one save. The unit and the VAT classification are picked in selects that write
 * their fields.
 */
const productDetailForm = FormReact.make(
  FormBuilder.empty
    .addField('active', Schema.Boolean)
    .addField('category', Schema.String)
    .addField('description', Schema.String)
    .addField('heightMm', Schema.String)
    .addField('lengthMm', Schema.String)
    .addField('lowStock', NumberTextSchema)
    .addField('name', Schema.String)
    .addField('nextVariantId', Schema.Number)
    .addField('price', NumberTextSchema)
    .addField('shortDescription', Schema.String)
    .addField('sku', Schema.String)
    .addField('taxClassificationCode', CzVatClassificationCodeSchema)
    .addField('unit', ProductUnitSchema)
    .addField(
      Field.makeArrayField(
        'variants',
        Schema.Struct({ attributes: Schema.String, key: Schema.Number, name: Schema.String }),
      ),
    )
    .addField('weightGrams', Schema.String)
    .addField('widthMm', Schema.String),
  {
    fields: {
      active: SwitchField,
      category: FormInputField,
      description: FormTextareaField,
      heightMm: FormInputField,
      lengthMm: FormInputField,
      lowStock: NumericField,
      name: FormInputField,
      nextVariantId: unrenderedField<number>(),
      price: NumericField,
      shortDescription: FormTextareaField,
      sku: FormInputField,
      taxClassificationCode: unrenderedField<DetailDraft['taxClassificationCode']>(),
      unit: unrenderedField<DetailDraft['unit']>(),
      // `key` names a variant row.
      variants: { attributes: FormInputField, key: unrenderedField<number>(), name: FormInputField },
      weightGrams: FormInputField,
      widthMm: FormInputField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type DetailValues = typeof productDetailForm.schema.Encoded;

const detailValuesOf = (draft: DetailDraft): DetailValues => ({
  active: draft.active,
  category: draft.category,
  description: draft.description,
  heightMm: draft.heightMm,
  lengthMm: draft.lengthMm,
  lowStock: { number: draft.lowStock, text: draft.lowStockText },
  name: draft.name,
  nextVariantId: draft.nextVariantId,
  price: { number: draft.priceCzk, text: draft.priceText },
  shortDescription: draft.shortDescription,
  sku: draft.sku,
  taxClassificationCode: draft.taxClassificationCode,
  unit: draft.unit,
  variants: draft.variants,
  weightGrams: draft.weightGrams,
  widthMm: draft.widthMm,
});

const detailDraftOf = (values: DetailValues, realVariants: readonly ProductVariant[]): DetailDraft => ({
  active: values.active,
  category: values.category,
  description: values.description,
  heightMm: values.heightMm,
  lengthMm: values.lengthMm,
  lowStock: values.lowStock.number,
  lowStockText: values.lowStock.text,
  name: values.name,
  nextVariantId: values.nextVariantId,
  priceCzk: values.price.number,
  priceText: values.price.text,
  realVariants,
  shortDescription: values.shortDescription,
  sku: values.sku,
  taxClassificationCode: values.taxClassificationCode,
  unit: values.unit,
  variants: values.variants,
  weightGrams: values.weightGrams,
  widthMm: values.widthMm,
});

const unitField = productDetailForm.getFieldAtoms(productDetailForm.fields.unit);
const variantsField = productDetailForm.getFieldAtoms(productDetailForm.fields.variants);
const nextVariantIdField = productDetailForm.getFieldAtoms(productDetailForm.fields.nextVariantId);
const nextVariantIdValue = nextVariantIdField.value.pipe(Atom.map(Option.getOrElse(() => 0)));
/** The four measurements: whole numbers typed as text, each checked on its own. */
const measurementFields = [
  ['weightGrams', productDetailForm.weightGrams],
  ['lengthMm', productDetailForm.lengthMm],
  ['widthMm', productDetailForm.widthMm],
  ['heightMm', productDetailForm.heightMm],
] as const;
const taxClassificationField = productDetailForm.getFieldAtoms(productDetailForm.fields.taxClassificationCode);

interface DetailFormProps {
  readonly canWrite: boolean;
  /**
   * The record's draft (`useRecordDraft`), which owns it: a reloaded product, Zahodit změny and a rebase replace it,
   * and the form then shows that draft. Every edit in the form becomes the record's draft.
   */
  readonly draft: DetailDraft;
  /** The form was submitted (Enter in a field): the same one save as the Save button. */
  readonly onSave: () => void;
  readonly product: ProductRecord;
  readonly setDraft: Dispatch<SetStateAction<DetailDraft>>;
  readonly vat: CompanyVat;
}

/**
 * The product's own variant labels (name and attributes), edited in the detail draft. A product with sellable variants
 * edits them on the "Varianty a ceny" tab instead.
 */
const DetailVariants = ({
  canWrite,
  draftInvalid,
  realVariants,
}: {
  readonly canWrite: boolean;
  readonly draftInvalid: boolean;
  /** How many sellable variants the product has. */
  readonly realVariants: number;
}) => {
  const k = useProductLabel();
  const { language } = useModernI18n();
  const requiredLabel = requiredLabelFor(language);
  const disabled = !canWrite;
  const variants = Option.match(useAtomValue(productDetailForm.values), {
    onNone: () => [],
    onSome: (values) => values.variants,
  });
  const setVariants = useAtomSet(variantsField.setValue);
  const nextVariantId = useAtomValue(nextVariantIdValue);
  const setNextVariantId = useAtomSet(nextVariantIdField.setValue);
  return realVariants > 0 ? (
    <div className="flex flex-col gap-100 lg:col-span-2">
      <h2 className="font-semibold">{k('fields.variants')}</h2>
      <p className="text-fg-secondary text-sm">
        Produkt má {realVariants} prodejní varianty s vlastní cenou a skladem — upravte je na kartě „Varianty a ceny“.
      </p>
    </div>
  ) : (
    <div className="flex flex-col gap-200 lg:col-span-2">
      <h2 className="font-semibold">{k('fields.variants')}</h2>
      <p className="text-fg-secondary text-sm">{k('detail.variantsExplanation')}</p>
      {variants.map((variant, index) => (
        <productDetailForm.variants.Item index={index} key={variant.key}>
          <div className="grid grid-cols-1 items-end gap-150 sm:grid-cols-3">
            <productDetailForm.variants.name
              disabled={disabled}
              id={`variant-name-${variant.key}`}
              label={k('fields.variantName')}
              maxLength={100}
              name={`variant-name-${variant.key}`}
              required
              requiredLabel={requiredLabel}
              {...fieldVerdict(true, variant.name.trim() === '' ? k(REQUIRED_MESSAGE_KEY) : undefined)}
            />
            <productDetailForm.variants.attributes
              disabled={disabled}
              id={`variant-attributes-${variant.key}`}
              label={k('fields.variantAttributes')}
              maxLength={1000}
              name={`variant-attributes-${variant.key}`}
            />
            {canWrite && (
              <Button
                appearance="outline"
                onClick={() => setVariants(variants.filter((current) => current.key !== variant.key))}
                severity="secondary"
                type="button"
              >
                {k('detail.removeVariant')}
              </Button>
            )}
          </div>
        </productDetailForm.variants.Item>
      ))}
      {canWrite && (
        <Button
          appearance="outline"
          disabled={variants.length >= 50}
          onClick={() => {
            setNextVariantId(nextVariantId + 1);
            setVariants([...variants, { attributes: '', key: nextVariantId, name: '' }]);
          }}
          severity="secondary"
          type="button"
        >
          {k('detail.addVariant')}
        </Button>
      )}
      {draftInvalid && <StatusText status="error">{k('validation.metadata')}</StatusText>}
    </div>
  );
};

const DetailFields = ({ canWrite, draft: recordDraft, onSave, product, setDraft, vat }: DetailFormProps) => {
  const k = useProductLabel();
  const { language } = useModernI18n();
  const requiredLabel = requiredLabelFor(language);
  const taxLabels = useTaxLabels();
  const disabled = !canWrite;
  const values = Option.getOrElse(useAtomValue(productDetailForm.values), () => detailValuesOf(recordDraft));
  const setUnit = useAtomSet(unitField.setValue);
  const setTaxClassification = useAtomSet(taxClassificationField.setValue);
  useRecordForm({
    draft: recordDraft,
    draftOf: (next, current) => detailDraftOf(next, current.realVariants),
    form: productDetailForm,
    setDraft,
    valuesOf: detailValuesOf,
  });
  // Enter in a field is the Save button.
  useAtomSubscribe(
    productDetailForm.submit,
    (result) => {
      if (AsyncResult.isSuccess(result) && !result.waiting) {
        onSave();
      }
    },
    { immediate: false },
  );
  const draft = detailDraftOf(values, recordDraft.realVariants);
  const { category, lowStock, name, priceCzk, taxClassificationCode } = draft;

  const nameError = name.trim() === '' ? k(REQUIRED_MESSAGE_KEY) : tooLongMessage(k, name, PRODUCT_LIMITS.name);
  const categoryError =
    category.trim() === '' ? k(REQUIRED_MESSAGE_KEY) : tooLongMessage(k, category, PRODUCT_LIMITS.category);
  const priceKey = priceErrorKey(priceCzk);
  const priceError = priceKey === undefined ? undefined : k(priceKey);
  const lowStockKey = lowStockErrorKey(lowStock);
  const lowStockError = lowStockKey === undefined ? undefined : k(lowStockKey);
  const priceMinor = Math.round(priceCzk * 100);
  const draftInvalid = detailDraftInvalid(draft);
  const detailVat = detailVatOf(
    product,
    taxClassificationCode,
    rateAt(vat, taxClassificationCode, DateTime.nowUnsafe())?.ratePercent,
  );
  const gross = detailGrossOf(product, priceMinor, detailVat.appliedRate);
  const grossText = gross.minor === null ? taxLabels.notSet : formatMoney(gross.minor);
  // Only a stored gross stays the same on a classification change; with none ("not set") there is no share to keep.
  const grossNote =
    gross.kind !== 'preview' && gross.minor !== null && taxClassificationCode !== product.taxClassificationCode
      ? k('detail.vatShareOnly')
      : undefined;

  return (
    <>
      <productDetailForm.sku
        autoComplete="off"
        disabled={disabled}
        id="detail-sku"
        label={k('fields.sku')}
        maxLength={64}
        name="sku"
        required
        requiredLabel={requiredLabel}
        {...fieldVerdict(true, draft.sku.trim() === '' ? k(REQUIRED_MESSAGE_KEY) : undefined)}
      />
      <productDetailForm.name
        autoComplete="off"
        disabled={disabled}
        id="detail-name"
        label={k('fields.name')}
        name="name"
        required
        requiredLabel={requiredLabel}
        {...fieldVerdict(true, nameError)}
      />
      <productDetailForm.category
        autoComplete="off"
        disabled={disabled}
        id="detail-category"
        label={k('fields.category')}
        name="category"
        required
        requiredLabel={requiredLabel}
        {...fieldVerdict(true, categoryError)}
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
          value={[values.unit]}
        />
        {/* The same draft path as every other field: the Save button sends it, leaving with it unsaved asks first. */}
        <TaxClassificationSelect
          disabled={disabled}
          onChange={setTaxClassification}
          value={taxClassificationCode}
          vat={vat}
        />
      </div>
      {detailVat.held && detailVat.appliedRate !== undefined && (
        <p className="text-fg-secondary text-sm">
          {k('detail.heldRate', { rate: detailVat.appliedRate })} {k('detail.heldRateExplanation')}
        </p>
      )}
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <productDetailForm.price
          disabled={disabled}
          formatOptions={MONEY_FORMAT}
          hideValueMax
          id="detail-price"
          label={k('fields.priceNet')}
          locale="cs-CZ"
          min={0}
          name="price"
          required
          requiredLabel={requiredLabel}
          step={1}
          {...fieldVerdict(true, priceError)}
        />
        <productDetailForm.lowStock
          clampValueOnBlur={false}
          disabled={disabled}
          formatOptions={WHOLE_NUMBER_FORMAT}
          hideValueMax
          id="detail-low-stock"
          label={k('fields.lowStock')}
          locale="cs-CZ"
          min={0}
          name="lowStock"
          step={1}
          {...fieldVerdict(true, lowStockError)}
        />
      </div>
      {/* Read only: the price including VAT is the stored one, a preview of an edited net price, or the lowest price
          of the product's variants ("Cena od"). It is shown, never typed. */}
      <FormInput
        disabled
        id="detail-price-gross"
        label={k(grossLabelKeys[gross.kind])}
        name="grossPrice"
        value={grossText}
        {...(grossNote === undefined ? {} : { helpText: grossNote })}
      />
      {/* A product with variants sells at its variants' prices: its own net price stores no gross that staff see. */}
      {gross.kind !== 'fromVariants' && <p className="text-fg-secondary text-sm">{k('detail.priceExplanation')}</p>}
      <SymmyWriteThroughNote product={product} />
      <productDetailForm.shortDescription
        disabled={disabled}
        id="detail-short-description"
        label={k('fields.shortDescription')}
        maxLength={500}
        name="shortDescription"
      />
      <productDetailForm.description
        disabled={disabled}
        id="detail-description"
        label={k('fields.description')}
        maxLength={20_000}
        name="description"
      />
      {measurementFields.map(([field, MeasurementField]) => (
        <MeasurementField
          disabled={disabled}
          id={`detail-${field}`}
          key={field}
          label={k(`fields.${field}`)}
          min={1}
          name={field}
          step={1}
          type="number"
          {...fieldVerdict(true, measurementInvalid(draft[field]) ? k('validation.measurement') : undefined)}
        />
      ))}
      <DetailVariants canWrite={canWrite} draftInvalid={draftInvalid} realVariants={draft.realVariants.length} />
      <productDetailForm.active disabled={disabled} name="active">
        {k('detail.active')}
      </productDetailForm.active>
    </>
  );
};

/**
 * The product fields as a form. noValidate (FormRoot): the save bar and the field messages say what is missing; native
 * validation would only add a second, differently worded set of messages.
 */
const DetailForm = (props: DetailFormProps) => {
  const { t } = useModernI18n();
  return (
    <FormRoot
      className="grid grid-cols-1 gap-200 lg:grid-cols-2"
      defaultValues={detailValuesOf(props.draft)}
      form={productDetailForm}
      id={DETAIL_FORM_ID}
      translateMessage={t}
    >
      <DetailFields {...props} />
    </FormRoot>
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
  categoryTrails = NO_TRAILS,
  hasCategoryTree = false,
  ledger,
  markets = NO_MARKETS,
  onBack,
  onCommitted,
  onReload,
  onTabChange,
  product,
  revision,
  storefrontOrigin,
  tab,
  variantId,
  vat,
}: ProductDetailViewProps) => {
  const k = useProductLabel();
  const { language } = useModernI18n();
  const labels = saveLabelsFor(language);
  const movement = useMovementDraft();
  const variantDestination = resolveProductVariantDestination(product, variantId);
  // The page re-reads the product after each save; the editor stays mounted across that reload
  // (`useProductDetailDraft`).
  const { record, reloadLatest, writeThroughError } = useProductDetailDraft({ onReload, product, revision });
  // The Pricing/Inventory variant a stock movement of this Symmy product writes through to; none for other products.
  const symmyStockTarget = (movementVariantId: string | undefined) => {
    const catalogVariantId =
      movementVariantId === undefined
        ? product.catalogVariantId
        : product.variants?.find((variant) => variant.id === movementVariantId)?.catalogVariantId;
    return product.importedVia !== 'symmy' || product.catalogProductId === undefined || catalogVariantId === undefined
      ? undefined
      : { catalogProductId: product.catalogProductId, catalogVariantId };
  };
  // A half-filled stock movement is its own command with its own button; leaving would lose it all the same.
  const movementDirty = movement.dirty;
  const dirty = record.dirty || movementDirty;
  // Router navigation, including browser Back and Shell links, asks the same question as every other way out. The
  // guard owns the browser's prompt for a closing tab.
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => {
      record.discard();
      movement.discard();
    },
    otherChanges: movementDirty,
  });

  const handleSave = record.save;
  const handleReloadLatest = reloadLatest;

  return (
    <>
      <div className="flex w-full min-w-0 flex-col gap-250">
        <PageHeader
          actions={
            <Button
              appearance="outline"
              className="shrink-0 whitespace-nowrap"
              onClick={() => onBack()}
              severity="secondary"
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
              <SymmyImportedBadge product={product} />
              <ErpCodeLine product={product} />
            </span>
          }
          title={product.name}
        />
        <StorefrontStatusPanel product={product} />
        <Tabs
          appearance="line"
          onValueChange={(value) => {
            if (isProductDetailTab(value)) {
              onTabChange(value);
            }
          }}
          value={tab}
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
              draft={record.draft}
              onSave={handleSave}
              product={product}
              setDraft={record.setDraft}
              vat={vat}
            />
            {/* The form's footer: the one Save button of the product fields, with the state of the draft. */}
            {writeThroughError !== null && <StatusText status="error">{writeThroughError}</StatusText>}
            {canWrite && (
              <SaveBar
                labels={labels}
                onReloadKeepingDrafts={reloadKeepingDrafts}
                onReloadLatest={handleReloadLatest}
                onSave={handleSave}
                status={record.status}
              />
            )}
          </Tabs.Content>
          <Tabs.Content className="flex flex-col gap-200 py-200" value="variants">
            <SymmyWriteThroughNote product={product} />
            <VariantsPanel
              active={tab === 'variants'}
              canMoveStock={canMoveStock}
              canWrite={canWrite}
              onCommitted={onCommitted}
              onReload={onReload}
              product={product}
              revision={revision}
              variantDestination={variantDestination}
              vat={vat}
            />
          </Tabs.Content>
          <Tabs.Content className="flex flex-col gap-250 py-200" value="eshop">
            {/* Pictures and e-shop settings are one draft with one Uložit. Every staff writer curates product photos,
                also where catalog data stays with administrators. */}
            <EshopPanel
              {...(storefrontOrigin === undefined ? {} : { storefrontOrigin })}
              active={tab === 'eshop'}
              canWrite={canWrite}
              canWriteImages={canMoveStock}
              onArchived={onBack}
              onCommitted={onCommitted}
              onReload={onReload}
              product={product}
              revision={revision}
            />
          </Tabs.Content>
          <Tabs.Content className="py-200" value="content">
            <CatalogContentPanel
              active={tab === 'content'}
              canWrite={canWrite}
              category={category}
              categoryTrails={categoryTrails}
              hasCategoryTree={hasCategoryTree}
              onCommitted={onCommitted}
              onReload={onReload}
              product={product}
              revision={revision}
            />
          </Tabs.Content>
          <Tabs.Content className="py-200" value="markets">
            <MarketsPanel
              active={tab === 'markets'}
              canManage={markets.canManage}
              markets={markets.entries}
              onCommitted={onCommitted}
              onReload={onReload}
              product={product}
              revision={revision}
            />
          </Tabs.Content>
          <Tabs.Content className="flex flex-col gap-250 py-200" value="prices">
            <SalesTermsPanel
              active={tab === 'prices'}
              canWrite={canWrite}
              onCommitted={onCommitted}
              onReload={onReload}
              product={product}
              revision={revision}
              vat={vat}
            />
            <PriceHistory product={product} />
          </Tabs.Content>
          <Tabs.Content className="flex flex-col gap-200 py-200" value="movements">
            <SymmyWriteThroughNote product={product} />
            <MovementsTable
              hasOlder={ledger.hasOlder}
              key={ledger.movements.at(-1)?.id ?? ''}
              movements={ledger.movements}
              productId={product.id}
              variants={product.variantRecords}
            />
            {canMoveStock && (
              <MovementForm
                onCommitted={onCommitted}
                onReload={onReload}
                productId={product.id}
                revision={revision}
                stockOnHand={product.stockOnHand}
                symmyTarget={symmyStockTarget}
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
