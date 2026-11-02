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
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { selectItem } from '../../../../ui/select-item.ts';
import { AutosaveStatus, dialogCloseLabel, formatDate, formatMoney, PageHeader, useAutosave } from '@app/admin-ui';
import type { AutosaveOutcome } from '@app/admin-ui';
import { DateTime, Effect, Predicate, Random, Schema } from 'effect';
import { isRealVariant } from '../../../../../shared/domain/merchandise-model.ts';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { useEffect, useRef, useState } from 'react';
import { ApplyCommandPayloadSchema } from '../../../../../shared/actions/apply-command.ts';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import type { CategoryTrail, ProductRecord, StockMovement } from '../../../../../shared/apis/records.ts';
import type { ProductUnit, VatRate } from '../../../../../shared/domain/merchandise-model.ts';
import { orderLineVatMinor } from '../../../../../shared/domain/order-totals.ts';
import { MONEY_FORMAT, WHOLE_NUMBER_FORMAT } from '../../../../form-number.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import {
  detailDraftInvalid,
  detailSaveOf,
  draftOf,
  measurementInvalid,
  sameDetailDraft,
} from './product-detail-draft.ts';
import type { DetailDraft } from './product-detail-draft.ts';
import {
  PRODUCT_LIMITS,
  UNITS,
  VAT_RATES,
  fieldError,
  lowStockErrorKey,
  priceErrorKey,
  tooLongMessage,
  useProductLabel,
} from './product-forms.tsx';
import { EMPTY_MOVEMENT_DRAFT, MovementForm, MovementsTable, isMovementDraftDirty } from './product-movements.tsx';
import { AvailabilityBadge, EshopPanel, VariantsPanel, VariantPriceHistory } from './product-eshop.tsx';
import { ProductImageGallery } from './product-image-gallery.tsx';
import { CatalogContentPanel } from './product-catalog-content.tsx';
import { MarketsPanel } from './product-markets.tsx';
import type { ProductMarket } from '../../../../../shared/domain/market-offers.ts';
import type { MovementDraft } from './product-movements.tsx';

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
  readonly product: ProductRecord;
  readonly revision: number;
  readonly storefrontOrigin?: string;
}

/** Writable subset of ProductPatch, filled field by field so only changed values are sent. */

/**
 * The page header submits this form by id. Tab contents stay mounted so unsaved fields survive tab switches.
 */
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

/** The editable fields of the product. The view keeps the draft and every change saves itself. */
interface DetailFormProps {
  readonly canWrite: boolean;
  readonly draft: DetailDraft;
  /** Sends a pending draft now: a field lost focus. */
  readonly onBlur: () => void;
  readonly onDraftChange: (patch: Partial<DetailDraft>) => void;
  readonly product: ProductRecord;
}

const DetailForm = ({ canWrite, draft, onBlur, onDraftChange, product }: DetailFormProps) => {
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

  // noValidate: the form may sit in a hidden tab, and native validation would block the autosave silently; the
  // inline autosave line and the field messages say what is missing instead.
  return (
    <form
      className="grid grid-cols-1 gap-200 lg:grid-cols-2"
      id={DETAIL_FORM_ID}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onBlur();
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

type CommandFailure = Effect.Error<ReturnType<typeof executeApplyCommand>>;

const idempotencyKey = Effect.all({ now: DateTime.now, random: Random.nextInt }, { concurrency: 1 }).pipe(
  Effect.map(({ now, random }) => `merchandise:product:${DateTime.toEpochMillis(now)}:${random}`),
);

/** One merchandise command; the revision the server answered with is the one the next command must expect. */
const runProductCommand = (command: MerchandiseCommand, expectedRevision: number) =>
  idempotencyKey.pipe(
    Effect.flatMap((key) =>
      Schema.encodeEffect(ApplyCommandPayloadSchema)({ command, expectedRevision }).pipe(
        Effect.flatMap((payload) => executeApplyCommand(payload, key, { idempotencyKey: key })),
      ),
    ),
    Effect.map((result) => result.revision),
  );

const failureOutcome = (error: CommandFailure): AutosaveOutcome =>
  Predicate.isTagged(error, 'ApplyCommandActionConflictProblem') && error.code !== 'merchandise_lifecycle_conflict'
    ? 'conflict'
    : 'failed';

/**
 * One autosave of the detail form: the changed basic fields first, then a changed price, each against the revision
 * the previous command or the page left. A conflict keeps the draft and offers the version someone else saved.
 */
const saveDetailEffect = (
  value: DetailDraft,
  product: ProductRecord,
  revisionRef: { current: number },
): Effect.Effect<AutosaveOutcome> => {
  const { patch, priceChanged, priceMinor } = detailSaveOf(value, product);
  if (Object.keys(patch).length === 0 && !priceChanged) {
    return Effect.succeed('saved');
  }
  const update: Effect.Effect<number, CommandFailure> =
    Object.keys(patch).length === 0
      ? Effect.succeed(revisionRef.current)
      : runProductCommand({ _tag: 'UpdateProduct', id: product.id, patch }, revisionRef.current);
  return update.pipe(
    Effect.flatMap((revision) => {
      revisionRef.current = revision;
      return priceChanged
        ? runProductCommand({ _tag: 'ChangePrice', id: product.id, priceMinor }, revision)
        : Effect.succeed(revision);
    }),
    Effect.tap((revision) =>
      Effect.sync(() => {
        revisionRef.current = revision;
      }),
    ),
    Effect.match({
      onFailure: failureOutcome,
      onSuccess: (): AutosaveOutcome => 'saved',
    }),
  );
};

/**
 * Full-page product editor, keyed by product id. Refreshes retain the active tab and unsaved fields.
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
  product,
  revision,
  storefrontOrigin,
}: ProductDetailViewProps) => {
  const k = useProductLabel();
  const { t } = useModernI18n();
  const [editableDraft, setEditableDraft] = useState(() => draftOf(product));
  // Real variants are read-only on this tab and always come from the latest product.
  // Deriving them preserves unsaved detail fields when the variants tab commits a change.
  const draft = { ...editableDraft, realVariants: (product.variants ?? []).filter(isRealVariant) };
  const [movementDraft, setMovementDraft] = useState(EMPTY_MOVEMENT_DRAFT);
  const [tab, setTab] = useState('detail');
  // The revision the next save must expect: the one the page passed, then the one each save returns.
  const revisionRef = useRef(revision);
  useEffect(() => {
    revisionRef.current = Math.max(revisionRef.current, revision);
  }, [revision]);
  // Every change of the product fields saves itself, debounced; the page re-reads the product after each save.
  const autosave = useAutosave<DetailDraft, never>({
    equals: sameDetailDraft,
    isValid: (value) => !detailDraftInvalid(value),
    runtime: browserRuntime,
    save: (value): Effect.Effect<AutosaveOutcome> => saveDetailEffect(value, product, revisionRef),
    value: draft,
  });
  const dirty = autosave.pending || isMovementDraftDirty(movementDraft);
  const blocker = useBlocker({ enableBeforeUnload: () => dirty, shouldBlockFn: () => dirty, withResolver: true });
  const updateDraft = (patch: Partial<DetailDraft>) => {
    setEditableDraft((current) => ({ ...current, ...patch }));
  };
  const updateMovementDraft = (patch: Partial<MovementDraft>) => {
    setMovementDraft((current) => ({ ...current, ...patch }));
  };

  // Router navigation, including browser Back and Shell links, uses the same discard prompt.
  const requestClose = (_next: boolean) => {
    onBack();
  };

  const handleRetry = autosave.retry;
  const handleBlur = autosave.flush;
  const handleReloadLatest = () => {
    autosave.adopt(draftOf(product));
    onReload();
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
                <AutosaveStatus onReloadLatest={handleReloadLatest} onRetry={handleRetry} status={autosave.status} />
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
          <Tabs.Content className="py-200" value="detail">
            <DetailForm
              canWrite={canWrite}
              draft={draft}
              onBlur={handleBlur}
              onDraftChange={updateDraft}
              product={product}
            />
          </Tabs.Content>
          <Tabs.Content className="py-200" value="variants">
            <VariantsPanel
              canMoveStock={canMoveStock}
              canWrite={canWrite}
              key={`variants-${DateTime.formatIso(product.updatedAt)}`}
              onCommitted={onCommitted}
              onReload={onReload}
              product={product}
              revision={revision}
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
