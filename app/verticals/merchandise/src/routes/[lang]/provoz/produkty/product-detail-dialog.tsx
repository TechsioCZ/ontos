import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { dialogCloseLabel, formatDate, formatMoney, PageHeader } from '@app/admin-ui';
import { DateTime, Option, Schema } from 'effect';
import { isRealVariant, ProductMetadataSchema } from '../../../../../shared/domain/merchandise-model.ts';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { useEffect, useRef, useState } from 'react';
import type { ProductPatch } from '../../../../../shared/actions/apply-command.ts';
import type { ProductRecord, StockMovement } from '../../../../../shared/apis/records.ts';
import type {
  CategoryNode,
  ProductMetadata,
  ProductUnit,
  ProductVariant,
  VatRate,
} from '../../../../../shared/domain/merchandise-model.ts';
import { orderLineVatMinor } from '../../../../../shared/domain/order-totals.ts';
import { MONEY_FORMAT, WHOLE_NUMBER_FORMAT, moneyInputText } from '../../../../form-number.ts';
import { runCommand } from './products-api.ts';
import type { CommandOutcome, FailureReason } from './products-api.ts';
import {
  PRODUCT_LIMITS,
  UNITS,
  VAT_RATES,
  fieldError,
  focusFirstInvalid,
  lowStockErrorKey,
  priceErrorKey,
  tooLongMessage,
  useCommandFailure,
  useProductLabel,
} from './product-forms.tsx';
import { EMPTY_MOVEMENT_DRAFT, MovementForm, MovementsTable, isMovementDraftDirty } from './product-movements.tsx';
import { AvailabilityBadge, EshopPanel, VariantsPanel, VariantPriceHistory } from './product-eshop.tsx';
import { CatalogContentPanel } from './product-catalog-content.tsx';
import type { MovementDraft } from './product-movements.tsx';

export interface ProductDetailViewProps {
  readonly storefrontOrigin?: string;
  readonly canWrite: boolean;
  readonly canMoveStock?: boolean;
  readonly categories?: readonly CategoryNode[];
  readonly movements: readonly StockMovement[];
  readonly onBack: () => void;
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  readonly product: ProductRecord;
  readonly revision: number;
}

/** Writable subset of ProductPatch, filled field by field so only changed values are sent. */
type PatchDraft = { -readonly [Key in keyof ProductPatch]?: ProductPatch[Key] };

/**
 * The page header submits this form by id. Tab contents stay mounted so unsaved fields survive tab switches.
 */
const DETAIL_FORM_ID = 'product-detail-form';
const REQUIRED_MESSAGE_KEY = 'validation.required';

const PriceHistory = ({ product }: { readonly product: ProductRecord }) => {
  const k = useProductLabel();
  if ((product.variantRecords ?? []).length > 0) return <VariantPriceHistory product={product} />;
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

/** Editable product fields as typed. The page owns the draft for navigation and unload protection. */
interface DetailDraft {
  readonly active: boolean;
  readonly category: string;
  readonly description: string;
  readonly heightMm: string;
  readonly lengthMm: string;
  readonly lowStock: number;
  /** The minimum-stock input's text, kept as typed so "2,5" reaches validation instead of becoming 25. */
  readonly lowStockText: string;
  readonly name: string;
  readonly nextVariantId: number;
  readonly priceCzk: number;
  /** The price input's text, kept as typed so the two-decimal display never fights the keyboard. */
  readonly priceText: string;
  /** Real (sellable) variants are edited on the Varianty tab; the detail form passes them through unchanged. */
  readonly realVariants: readonly ProductVariant[];
  readonly shortDescription: string;
  readonly unit: ProductUnit;
  readonly variants: readonly { readonly attributes: string; readonly key: number; readonly name: string }[];
  readonly vatRate: VatRate;
  readonly weightGrams: string;
  readonly widthMm: string;
}

const measurementText = (value: Option.Option<number> | undefined): string =>
  Option.match(value ?? Option.none(), { onNone: () => '', onSome: String });

const draftOf = (product: ProductRecord): DetailDraft => ({
  active: product.active,
  category: product.category,
  description: product.description ?? '',
  heightMm: measurementText(product.heightMm),
  lengthMm: measurementText(product.lengthMm),
  lowStock: product.lowStockThreshold,
  lowStockText: String(product.lowStockThreshold),
  name: product.name,
  nextVariantId: product.variants?.length ?? 0,
  priceCzk: product.currentPriceMinor / 100,
  priceText: moneyInputText(product.currentPriceMinor / 100),
  realVariants: (product.variants ?? []).filter(isRealVariant),
  shortDescription: product.shortDescription ?? '',
  unit: product.unit,
  variants: (product.variants ?? [])
    .filter((variant) => !isRealVariant(variant))
    .map((variant, key) => ({ attributes: variant.attributes, key, name: variant.name })),
  vatRate: product.vatRate,
  weightGrams: measurementText(product.weightGrams),
  widthMm: measurementText(product.widthMm),
});

const measurementOf = (value: string): number | null => (value.trim() === '' ? null : Number(value));
const metadataOf = (draft: DetailDraft): ProductMetadata => ({
  description: draft.description.trim(),
  heightMm: Option.fromNullOr(measurementOf(draft.heightMm)),
  lengthMm: Option.fromNullOr(measurementOf(draft.lengthMm)),
  shortDescription: draft.shortDescription.trim(),
  variants: [
    ...draft.realVariants,
    ...draft.variants.map(({ attributes, name }) => ({ attributes: attributes.trim(), name: name.trim() })),
  ],
  weightGrams: Option.fromNullOr(measurementOf(draft.weightGrams)),
  widthMm: Option.fromNullOr(measurementOf(draft.widthMm)),
});
const metadataEquivalent = Schema.toEquivalence(ProductMetadataSchema);
const metadataChanged = (draft: DetailDraft, product: ProductRecord): boolean =>
  !metadataEquivalent(metadataOf(draft), metadataOf(draftOf(product)));
const measurementInvalid = (value: string): boolean => {
  const number = measurementOf(value);
  return number !== null && (!Number.isInteger(number) || number < 1 || number > 1_000_000_000);
};

/** True when Save would send something: a changed field or a changed price. */
const isDraftDirty = (draft: DetailDraft, product: ProductRecord): boolean =>
  metadataChanged(draft, product) ||
  draft.name.trim() !== product.name ||
  draft.category.trim() !== product.category ||
  draft.unit !== product.unit ||
  draft.vatRate !== product.vatRate ||
  draft.lowStock !== product.lowStockThreshold ||
  Math.round(draft.priceCzk * 100) !== product.currentPriceMinor ||
  draft.active !== product.active;

/**
 * Editable product fields. Changed fields go to UpdateProduct; a changed price follows as ChangePrice. The two
 * commands run one after the other and can take a few seconds, so a persistent "Ukládám změny…" toast shows
 * from the first click until the outcome replaces it.
 */
interface DetailFormProps {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly draft: DetailDraft;
  /** Close without saving: asks first when another tab still holds an unsent draft. */
  readonly onClose: () => void;
  readonly onCommitted: (message: string) => void;
  readonly onDraftChange: (patch: Partial<DetailDraft>) => void;
  readonly onReload: () => void;
  /** Called after a successful save; the page checks for an unsaved movement before returning. */
  readonly onSaved: () => void;
  readonly product: ProductRecord;
  readonly revision: number;
  readonly setBusy: (busy: boolean) => void;
}

interface DetailValidation {
  readonly categoryError: string | undefined;
  readonly lowStockError: string | undefined;
  readonly metadataError: boolean;
  readonly nameError: string | undefined;
  readonly priceError: string | undefined;
  readonly priceMinor: number;
}

/** Application handler owns patch construction, sequential revision use, and partial failure reporting. */
const saveDetailProduct = ({
  busy,
  draft,
  failure,
  k,
  onClose,
  onCommitted,
  onReload,
  onSaved,
  product,
  revision,
  setBusy,
  setServerError,
  setSubmitted,
  toaster,
  validation,
}: DetailFormProps & {
  readonly failure: ReturnType<typeof useCommandFailure>;
  readonly k: ReturnType<typeof useProductLabel>;
  readonly setServerError: (value: string | null) => void;
  readonly setSubmitted: (value: boolean) => void;
  readonly toaster: ReturnType<typeof useToast>;
  readonly validation: DetailValidation;
}) => {
  const { active, category, lowStock, name, unit, vatRate } = draft;
  const { categoryError, lowStockError, metadataError, nameError, priceError, priceMinor } = validation;

  if (busy) {
    return;
  }
  setSubmitted(true);
  if (metadataError || [nameError, categoryError, priceError, lowStockError].some((message) => message !== undefined)) {
    focusFirstInvalid([
      ['detail-name', nameError !== undefined],
      ['detail-category', categoryError !== undefined],
      ['detail-price', priceError !== undefined],
      ['detail-low-stock', lowStockError !== undefined],
    ]);
    return;
  }
  const patch: PatchDraft = metadataChanged(draft, product) ? { ...metadataOf(draft) } : {};
  if (name.trim() !== product.name) {
    patch.name = name.trim();
  }
  if (category.trim() !== product.category) {
    patch.category = category.trim();
  }
  if (unit !== product.unit) {
    patch.unit = unit;
  }
  if (vatRate !== product.vatRate) {
    patch.vatRate = vatRate;
  }
  if (lowStock !== product.lowStockThreshold) {
    patch.lowStockThreshold = lowStock;
  }
  if (active !== product.active) {
    patch.active = active;
  }
  const hasPatch = Object.keys(patch).length > 0;
  const priceChanged = priceMinor !== product.currentPriceMinor;
  if (!hasPatch && !priceChanged) {
    onClose();
    return;
  }
  setBusy(true);
  setServerError(null);
  const savingToast = toaster.create({
    duration: Number.POSITIVE_INFINITY,
    title: k('messages.saving'),
    type: 'info',
  });
  const finish = (reason: FailureReason | null) => {
    setBusy(false);
    toaster.dismiss(savingToast);
    if (reason !== null) {
      setServerError(failure(reason, onReload));
      return;
    }
    onSaved();
    onCommitted(k('messages.updated'));
  };
  const afterPatch = (outcome: CommandOutcome) => {
    if (!outcome.ok) {
      finish(outcome.reason);
      return;
    }
    if (!priceChanged) {
      finish(null);
      return;
    }
    runCommand({ _tag: 'ChangePrice', id: product.id, priceMinor }, outcome.revision, (second) =>
      finish(second.ok ? null : second.reason),
    );
  };
  if (hasPatch) {
    runCommand({ _tag: 'UpdateProduct', id: product.id, patch }, revision, afterPatch);
  } else {
    afterPatch({ ok: true, revision });
  }
};

const invalidMetadata = (draft: DetailDraft): boolean =>
  draft.description.trim().length > 20_000 ||
  draft.shortDescription.trim().length > 500 ||
  draft.variants.length > 50 ||
  draft.variants.some(
    (variant) =>
      variant.name.trim() === '' || variant.name.trim().length > 100 || variant.attributes.trim().length > 1000,
  ) ||
  [draft.weightGrams, draft.lengthMm, draft.widthMm, draft.heightMm].some(measurementInvalid);

const DetailForm = (props: DetailFormProps) => {
  const { busy, canWrite, draft, onDraftChange, product } = props;
  const k = useProductLabel();
  const failure = useCommandFailure();
  const toaster = useToast();
  const disabled = !canWrite || busy;
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
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const nameError = name.trim() === '' ? k(REQUIRED_MESSAGE_KEY) : tooLongMessage(k, name, PRODUCT_LIMITS.name);
  const categoryError =
    category.trim() === '' ? k(REQUIRED_MESSAGE_KEY) : tooLongMessage(k, category, PRODUCT_LIMITS.category);
  const priceKey = priceErrorKey(priceCzk);
  const priceError = priceKey === undefined ? undefined : k(priceKey);
  const lowStockKey = lowStockErrorKey(lowStock);
  const lowStockError = lowStockKey === undefined ? undefined : k(lowStockKey);
  const priceMinor = Math.round(priceCzk * 100);
  const metadataError = invalidMetadata(draft);
  const grossMinor =
    Number.isFinite(priceMinor) && priceMinor >= 0
      ? priceMinor + orderLineVatMinor({ quantity: 1, unitPriceMinor: priceMinor, vatRate })
      : null;

  const save = () =>
    saveDetailProduct({
      ...props,
      failure,
      k,
      setServerError,
      setSubmitted,
      toaster,
      validation: { categoryError, lowStockError, metadataError, nameError, priceError, priceMinor },
    });

  // noValidate: the form may sit in a hidden tab when the footer submits it, and native validation would
  // block that silently; save() validates and shows the Czech messages instead.
  return (
    <form
      className="grid grid-cols-1 gap-200 lg:grid-cols-2"
      id={DETAIL_FORM_ID}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {serverError !== null && (
        <StatusText showIcon status="error">
          {serverError}
        </StatusText>
      )}
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
        {...fieldError(submitted, nameError)}
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
        {...fieldError(submitted, categoryError)}
      />
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <SelectTemplate
          disabled={disabled}
          items={UNITS.map((value) => ({ label: value, value }))}
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
          items={VAT_RATES.map((rate) => ({ label: `${rate} %`, value: String(rate) }))}
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
          {...fieldError(submitted, priceError)}
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
          {...fieldError(submitted, lowStockError)}
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
          {...fieldError(submitted, measurementInvalid(draft[field]) ? k('validation.measurement') : undefined)}
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
                {...fieldError(submitted, variant.name.trim() === '' ? k(REQUIRED_MESSAGE_KEY) : undefined)}
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
                  disabled={busy}
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
              disabled={draft.variants.length >= 50 || busy}
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
          {submitted && metadataError && <StatusText status="error">{k('validation.metadata')}</StatusText>}
        </div>
      )}
      <Switch checked={active} disabled={disabled} name="active" onCheckedChange={setActive}>
        {k('detail.active')}
      </Switch>
    </form>
  );
};

/**
 * Full-page product editor, keyed by product id. Refreshes retain the active tab and unsaved fields.
 */
export const ProductDetailView = ({
  storefrontOrigin,
  canWrite,
  canMoveStock = canWrite,
  categories = [],
  movements,
  onBack,
  onCommitted,
  onReload,
  product,
  revision,
}: ProductDetailViewProps) => {
  const k = useProductLabel();
  const { t } = useModernI18n();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(() => draftOf(product));
  // Variants are saved from their own tab; after the reload the detail draft must carry the saved ones, otherwise
  // the unchanged detail form would count as dirty and ask to discard on navigation.
  const savedRealVariantsKey = JSON.stringify((product.variants ?? []).filter(isRealVariant));
  const latestProduct = useRef(product);
  latestProduct.current = product;
  useEffect(() => {
    setDraft((current) => ({
      ...current,
      realVariants: (latestProduct.current.variants ?? []).filter(isRealVariant),
    }));
  }, [savedRealVariantsKey]);
  const [movementDraft, setMovementDraft] = useState(EMPTY_MOVEMENT_DRAFT);
  // A detail save finishes seconds after the click; it reads the movement draft as it is then, not at the click.
  const movementDraftRef = useRef(movementDraft);
  useEffect(() => {
    movementDraftRef.current = movementDraft;
  }, [movementDraft]);
  const [tab, setTab] = useState('detail');
  const dirty = isDraftDirty(draft, product) || isMovementDraftDirty(movementDraft);
  const allowNavigation = useRef(false);
  const blocker = useBlocker({
    enableBeforeUnload: () => dirty && !allowNavigation.current,
    shouldBlockFn: () => dirty && !allowNavigation.current,
    withResolver: true,
  });
  const updateDraft = (patch: Partial<DetailDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const updateMovementDraft = (patch: Partial<MovementDraft>) => {
    setMovementDraft((current) => ({ ...current, ...patch }));
  };

  // Router navigation, including browser Back and Shell links, uses the same discard prompt.
  const requestClose = (_next: boolean) => {
    onBack();
  };

  // After a detail save, an unsent movement keeps the page on the movement tab instead of being dropped.
  const closeAfterSave = () => {
    if (isMovementDraftDirty(movementDraftRef.current)) {
      setTab('movements');
      return;
    }
    allowNavigation.current = true;
    onBack();
  };

  return (
    <>
      <div className="flex w-full min-w-0 flex-col gap-250">
        <PageHeader
          actions={
            <div className="flex flex-wrap items-center gap-150">
              <Button
                className="shrink-0 whitespace-nowrap"
                onClick={() => requestClose(false)}
                theme="outlined"
                variant="secondary"
              >
                {k('detail.back')}
              </Button>
              {canWrite && tab === 'detail' && (
                <Button
                  className="shrink-0 whitespace-nowrap"
                  form={DETAIL_FORM_ID}
                  isLoading={busy}
                  loadingText={k('messages.saving')}
                  type="submit"
                  variant="primary"
                >
                  {k('common.save')}
                </Button>
              )}
            </div>
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
        <Tabs onValueChange={setTab} value={tab} variant="line">
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
              <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="prices">
                {k('prices.tab')}
              </Tabs.Trigger>
              <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="movements">
                {k('movements.tab')}
              </Tabs.Trigger>
              <Tabs.Indicator />
            </Tabs.List>
          </div>
          <Tabs.Content className="py-200" value="detail">
            <DetailForm
              busy={busy}
              canWrite={canWrite}
              draft={draft}
              onClose={() => requestClose(false)}
              onCommitted={onCommitted}
              onDraftChange={updateDraft}
              onReload={onReload}
              onSaved={closeAfterSave}
              product={product}
              revision={revision}
              setBusy={setBusy}
            />
          </Tabs.Content>
          <Tabs.Content className="py-200" value="variants">
            <VariantsPanel
              canWrite={canWrite}
              canMoveStock={canMoveStock}
              key={`variants-${DateTime.formatIso(product.updatedAt)}`}
              onCommitted={onCommitted}
              onReload={onReload}
              product={product}
              revision={revision}
            />
          </Tabs.Content>
          <Tabs.Content className="py-200" value="eshop">
            <EshopPanel
              {...(storefrontOrigin === undefined ? {} : { storefrontOrigin })}
              onArchived={onBack}
              canWrite={canWrite}
              key={`eshop-${DateTime.formatIso(product.updatedAt)}`}
              onCommitted={onCommitted}
              onReload={onReload}
              product={product}
              revision={revision}
            />
          </Tabs.Content>
          <Tabs.Content className="py-200" value="content">
            <CatalogContentPanel
              canWrite={canWrite}
              categories={categories}
              key={`content-${DateTime.formatIso(product.updatedAt)}`}
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
                productId={product.id}
                revision={revision}
                stockOnHand={product.stockOnHand}
                variants={product.variantRecords}
              />
            )}
          </Tabs.Content>
        </Tabs>
      </div>
      <Dialog
        actions={
          <>
            <Button onClick={() => blocker.reset?.()} theme="outlined" variant="secondary">
              {k('detail.discardKeep')}
            </Button>
            <Button
              onClick={() => {
                blocker.proceed?.();
              }}
              variant="danger"
            >
              {k('detail.discardAction')}
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={k('detail.discardDescription')}
        onOpenChange={({ open: next }) => {
          if (!next) {
            blocker.reset?.();
          }
        }}
        open={blocker.status === 'blocked'}
        role="alertdialog"
        size="sm"
        title={t('merchandise.pages.products.detail.discardTitle', { name: product.name })}
      />
    </>
  );
};
