import { isStockQuantity, MAX_QUANTITY, MIN_STOCK_QUANTITY } from '../../../../../shared/domain/order-quantity.ts';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
// E-shop product administration: real variants (SKU, price, stock, active), publication and availability.
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput, FormNumericInput, Switch } from '@app/admin-ui/form-controls';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { selectItem } from '../../../../ui/select-item.ts';
import { formatDateTime, formatMoney, ScrollRegion, SectionCard } from '@app/admin-ui';
import { DateTime, Effect } from 'effect';
import { useEffect, useRef, useState } from 'react';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type {
  Availability,
  ProductVariant,
  StockMovementReason,
  VariantId,
} from '../../../../../shared/domain/merchandise-model.ts';
import { grossUnitPriceMinor, isRealVariant } from '../../../../../shared/domain/merchandise-model.ts';
import { MONEY_FORMAT, QUANTITY_FORMAT, moneyInputText } from '../../../../form-number.ts';
import { productVersionOf, runCommand } from './products-api.ts';
import type { CommandOutcome } from './products-api.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { writeThroughSymmyVariant } from './symmy-write-through.ts';
import { fieldError } from './product-form-validation.ts';
import { formatDelta } from './products-format.ts';
import { useCommandFailure } from './product-form-labels.ts';
import { useCommandInputGuard } from './command-input-guard.tsx';
import { ProductTabSaveBar, useProductTabSave } from './product-tab-save.tsx';
import { mergeKeyedDrafts } from './product-draft-merge.ts';
import type { ProductVariantDestination } from './product-variant-destination.ts';
import { DEFAULT_TAX_CLASSIFICATION, classificationChoice, useTaxLabels } from './product-tax-classification.ts';
import type { CompanyVat } from './product-tax-classification.ts';
import { priceHistoryRows } from './product-price-history.ts';
import { VariantDetailEditor, VariantDetailsToggle } from './product-variant-editor.tsx';
import type { VariantDetailDraft } from './product-variant-editor.tsx';
import {
  czkText,
  parseCzkText,
  parseQuantityText,
  priceTiersOf,
  tierDraftsOf,
  tierRowsInvalid,
  variantTiersShown,
} from './product-sales-terms-draft.ts';

const availabilityPresentation = {
  IN_STOCK: { label: 'Skladem', variant: 'success' },
  LOW_STOCK: { label: 'Poslední kusy', variant: 'warning' },
  OUT_OF_STOCK: { label: 'Nedostupné', variant: 'danger' },
  UNKNOWN: { label: 'Nelze ověřit', variant: 'neutral' },
} as const satisfies Readonly<
  Record<Availability, { readonly label: string; readonly variant: 'danger' | 'neutral' | 'success' | 'warning' }>
>;

export const AvailabilityBadge = ({ value }: { readonly value: Availability | undefined }) => {
  const presentation = availabilityPresentation[value ?? 'UNKNOWN'];
  return (
    <Badge severity={presentation.variant} size="sm">
      {presentation.label}
    </Badge>
  );
};

const parseCzk = (text: string): number | null => {
  const normalized = text.replaceAll(/\s/gu, '').replace(',', '.');
  if (normalized === '') {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
};

/**
 * The Catalog variant a staff price or stock change of this variant is written to first (Pricing, Inventory): a variant
 * the ERP connector Symmy imported or linked by SKU. Other variants, also of the same product, save as ordinary ones.
 */
const symmyVariantTarget = (product: ProductRecord, variantId: string | undefined) => {
  const catalogVariantId = (product.variants ?? []).find(
    (variant) => variant.id !== undefined && variant.id === variantId,
  )?.catalogVariantId;
  return product.importedVia !== 'symmy' ||
    product.catalogProductId === undefined ||
    catalogVariantId === undefined ||
    catalogVariantId === ''
    ? undefined
    : { catalogProductId: product.catalogProductId, catalogVariantId };
};

/** A product Symmy created (not a shop product linked by SKU): the ERP owns its variant list, so none is added here. */
const variantsOwnedBySymmy = (product: ProductRecord) =>
  product.importedVia === 'symmy' && product.id.startsWith('symmy-');

interface VariantDraft extends VariantDetailDraft {
  readonly active: boolean;
  readonly attributes: string;
  readonly id?: VariantId;
  readonly key: string;
  readonly name: string;
  readonly priceText: string;
  readonly sku: string;
}

const EMPTY_VARIANT_DETAILS: VariantDetailDraft = {
  description: '',
  flags: { isAction: false, isNew: false, isRecommended: false, isSale: false },
  imageSrc: '',
  minimumQuantityText: '',
  originalPriceText: '',
  packageQuantityText: '',
  parameters: [],
  sourceUnit: '',
  tiers: [],
  tiersEdited: false,
  tiersMinimumText: '',
  unit: '',
  weightGramsText: '',
};

const optionalText = (value: number | undefined): string => (value === undefined ? '' : String(value));

const variantDetailsOf = (variant: ProductVariant): VariantDetailDraft => ({
  description: variant.description ?? '',
  flags: {
    isAction: variant.isAction === true,
    isNew: variant.isNew === true,
    isRecommended: variant.isRecommended === true,
    isSale: variant.isSale === true,
  },
  imageSrc: variant.imageSrc ?? '',
  minimumQuantityText: optionalText(variant.minimumQuantity),
  originalPriceText:
    variant.originalPriceMinor === undefined || variant.originalPriceMinor === 0
      ? ''
      : czkText(variant.originalPriceMinor),
  packageQuantityText: optionalText(variant.packageQuantity),
  parameters: (variant.parameters ?? []).map((parameter, index) => ({ ...parameter, key: index })),
  sourceUnit: variant.sourceUnit ?? '',
  tiers: tierDraftsOf(variant.priceTiers),
  tiersEdited: false,
  tiersMinimumText: optionalText(variant.minimumQuantity),
  unit: variant.unit ?? '',
  weightGramsText: variant.weightGrams === undefined || variant.weightGrams === 0 ? '' : String(variant.weightGrams),
});

const variantDraftsOf = (product: ProductRecord): readonly VariantDraft[] => {
  const drafts: VariantDraft[] = [];
  for (const variant of product.variants ?? []) {
    if (isRealVariant(variant)) {
      drafts.push({
        ...variantDetailsOf(variant),
        active: variant.active !== false,
        attributes: variant.attributes,
        id: variant.id,
        key: variant.id,
        name: variant.name,
        priceText: moneyInputText(variant.priceMinor / 100),
        sku: variant.sku ?? '',
      });
    }
  }
  return drafts;
};

export interface PanelProps {
  readonly active?: boolean;
  readonly canMoveStock?: boolean;
  readonly canWrite: boolean;
  /** Product photos: every staff writer curates them, also where catalog data stays with administrators. */
  readonly canWriteImages?: boolean;
  readonly onArchived?: () => void;
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  readonly product: ProductRecord;
  readonly revision: number;
  readonly storefrontOrigin?: string;
  readonly variantDestination?: ProductVariantDestination | undefined;
}

type MovementReason = Exclude<StockMovementReason, 'ORDER'>;
const reasonLabels = {
  ADJUSTMENT: 'Korekce (inventura)',
  ISSUE: 'Výdej',
  RECEIPT: 'Příjem',
} as const satisfies Readonly<Record<MovementReason, string>>;
const movementReasons = Object.keys(reasonLabels).filter(
  (value): value is MovementReason => value === 'ADJUSTMENT' || value === 'ISSUE' || value === 'RECEIPT',
);
const variantMovementDelta = (reason: MovementReason, quantity: number) => {
  if (reason === 'ISSUE') {
    return -Math.abs(quantity);
  }
  return reason === 'RECEIPT' ? Math.abs(quantity) : quantity;
};

/** Stock movement for one variant (ledger entry with variantId). */
const VariantStockForm = ({ canWrite, onCommitted, onReload, product, revision }: PanelProps) => {
  const { t } = useModernI18n();
  const failure = useCommandFailure();
  const variants = product.variantRecords ?? [];
  const [variantId, setVariantId] = useState<string>(variants[0]?.id ?? '');
  const [reason, setReason] = useState<MovementReason>('RECEIPT');
  const [quantityText, setQuantityText] = useState('10');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // A refused quantity is marked on its field until it is typed again.
  const [quantityRefused, setQuantityRefused] = useState(false);
  const firstVariant = variants[0]?.id ?? '';
  const clear = () => {
    setVariantId(firstVariant);
    setReason('RECEIPT');
    setQuantityText('10');
    setQuantityRefused(false);
  };
  // The movement keeps its own button; leaving with a half-filled one asks before the input is lost.
  const typed = variantId !== firstVariant || reason !== 'RECEIPT' || quantityText !== '10';
  const { dialog } = useCommandInputGuard(canWrite && typed, clear);
  if (!canWrite) {
    return null;
  }
  const variant = variants.find((entry) => entry.id === variantId);
  const quantity = Number(quantityText.replaceAll(/\s/gu, '').replace(',', '.'));
  const quantityValid = isStockQuantity(quantity) && (reason === 'ADJUSTMENT' || quantity > 0);
  const quantityError = t(
    reason === 'ADJUSTMENT'
      ? 'merchandise.pages.products.validation.delta'
      : 'merchandise.pages.products.validation.quantity',
  );

  const submit = () => {
    if (!quantityValid || variant === undefined || busy) {
      setQuantityRefused(!quantityValid);
      return;
    }
    const delta = variantMovementDelta(reason, quantity);
    setBusy(true);
    setError(null);
    setDone(null);
    const refused = (outcome: Extract<CommandOutcome, { readonly ok: false }>) => {
      setBusy(false);
      setError(
        outcome.reason === 'rejected'
          ? 'Sklad varianty nesmí klesnout pod nulu.'
          : failure(outcome.reason, onReload, outcome.proposal),
      );
    };
    const record = (at: number, corrected?: number) =>
      runCommand(
        {
          _tag: 'RecordStockMovement',
          delta,
          note: `Varianta ${variant.name}`,
          productId: product.id,
          reason,
          variantId: variant.id,
        },
        at,
        (outcome) => {
          if (!outcome.ok) {
            refused(outcome);
            return;
          }
          setBusy(false);
          clear();
          const message = `Pohyb zapsán: ${variant.name} ${formatDelta(delta)} ks${
            corrected === undefined ? '' : `, stav ve skladu ERP je nyní ${corrected} ks`
          }.`;
          setDone(message);
          onCommitted(message);
        },
      );
    const target = symmyVariantTarget(product, variant.id);
    if (target === undefined) {
      record(revision);
      return;
    }
    // A variant from Symmy: the movement is applied to Inventory's CURRENT on-hand first (never to this row's figure,
    // which can lag behind the ERP); when that fails nothing is recorded here. A row that differed from the ERP is first
    // corrected to the ERP figure, so after the save both hold the same on-hand.
    void browserRuntime.runPromise(
      writeThroughSymmyVariant({ ...target, reason: `Varianta ${variant.name}`, stockDelta: delta }).pipe(
        Effect.match({
          onFailure: (message) => {
            setBusy(false);
            setError(`Pohyb nebyl zapsán, sklad v ERP ho nepřijal: ${message}`);
          },
          onSuccess: ({ stock }) => {
            const correction = stock === undefined ? 0 : Math.round((stock.before - variant.stockOnHand) * 1000) / 1000;
            if (stock === undefined || correction === 0) {
              record(revision, stock?.after);
              return;
            }
            runCommand(
              {
                _tag: 'RecordStockMovement',
                delta: correction,
                note: 'Srovnání se stavem skladu v ERP',
                productId: product.id,
                reason: 'ADJUSTMENT',
                variantId: variant.id,
              },
              revision,
              (outcome) => {
                if (!outcome.ok) {
                  refused(outcome);
                  return;
                }
                record(outcome.revision, stock.after);
              },
            );
          },
        }),
      ),
    );
  };

  return (
    <SectionCard title={t('merchandise.ui.variantStockMovement')}>
      <div className="grid grid-cols-1 items-end gap-200 sm:grid-cols-[minmax(0,1fr)_12rem_8rem_auto]">
        <SelectTemplate
          items={variants.map((entry) => selectItem(entry.id, `${entry.name} (${entry.stockOnHand} ks)`))}
          label={t('merchandise.ui.variant')}
          name="stockVariant"
          onValueChange={(details) => setVariantId(details.value[0] ?? '')}
          placeholder={t('merchandise.ui.selectVariant')}
          size="sm"
          value={variantId === '' ? [] : [variantId]}
        />
        <SelectTemplate
          items={movementReasons.map((value) => selectItem(value, reasonLabels[value]))}
          label={t('merchandise.ui.movementType')}
          name="stockReason"
          onValueChange={(details) => {
            const next = movementReasons.find((value) => value === details.value[0]);
            if (next !== undefined) {
              setReason(next);
            }
          }}
          placeholder={t('merchandise.ui.type')}
          size="sm"
          value={[reason]}
        />
        <FormNumericInput
          clampValueOnBlur={false}
          formatOptions={QUANTITY_FORMAT}
          id="variant-stock-quantity"
          label={t('merchandise.ui.quantityPieces')}
          locale="cs-CZ"
          max={MAX_QUANTITY}
          min={reason === 'ADJUSTMENT' ? -MAX_QUANTITY : MIN_STOCK_QUANTITY}
          name="variantStockQuantity"
          onValueChange={(details) => {
            setQuantityText(details.value);
            setQuantityRefused(false);
          }}
          size="sm"
          step={1}
          value={quantityText}
          {...fieldError(quantityRefused && !quantityValid, quantityError)}
        >
          <NumericInput.Control>
            <NumericInput.Input aria-valuemax={undefined} />
          </NumericInput.Control>
        </FormNumericInput>
        <Button
          appearance="outline"
          isLoading={busy}
          loadingText="Zapisuji…"
          onClick={submit}
          severity="secondary"
          type="button"
        >
          Zapsat pohyb
        </Button>
      </div>
      {error !== null && (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
      {done !== null && (
        <StatusText showIcon status="success">
          {done}
        </StatusText>
      )}
      {dialog}
    </SectionCard>
  );
};

export const VariantPriceHistory = ({ product }: { readonly product: ProductRecord }) => {
  const { t } = useModernI18n();
  const sorted = priceHistoryRows(product);
  return (
    <SectionCard flush title={t('merchandise.ui.variantPriceHistory')}>
      <ScrollRegion label={t('merchandise.ui.variantPriceHistory')}>
        <Table appearance="line" size="sm">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Platí od</Table.ColumnHeader>
              <Table.ColumnHeader>Varianta</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Původní cena bez DPH</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Cena bez DPH</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Cena s DPH</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {sorted.map((row) => (
              <Table.Row key={row.key}>
                <Table.Cell>{formatDateTime(DateTime.formatIso(row.at))}</Table.Cell>
                <Table.Cell>{row.name}</Table.Cell>
                <Table.Cell align="end" className="tabular-nums">
                  {row.previous === undefined ? 'počáteční cena' : formatMoney(row.previous)}
                </Table.Cell>
                <Table.Cell align="end" className="tabular-nums">
                  {formatMoney(row.net)}
                </Table.Cell>
                <Table.Cell align="end" className="tabular-nums">
                  {row.gross === undefined ? '—' : formatMoney(row.gross)}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </ScrollRegion>
    </SectionCard>
  );
};

const weightInvalid = (text: string) => {
  if (text.trim() === '') {
    return false;
  }
  const weight = Number(text.trim());
  return !Number.isInteger(weight) || weight < 0 || weight > 1_000_000_000;
};

const optionalQuantityInvalid = (text: string) => text.trim() !== '' && parseQuantityText(text) === null;

/** The draft with the tier rows it saves: rows that followed a changed minimum are sent like edited ones. */
const withShownTiers = <Draft extends VariantDetailDraft>(draft: Draft): Draft => {
  const tiers = variantTiersShown(draft);
  return tiers === draft.tiers ? draft : { ...draft, tiers, tiersEdited: true };
};

/** Whether the detail fields of a variant cannot be saved. */
const variantDetailsInvalid = (draft: VariantDetailDraft) => {
  const saved = withShownTiers(draft);
  return (
    // Imported parameters may carry an empty value; only a value without a name blocks the save.
    draft.parameters.some((parameter) => parameter.label.trim() === '' && parameter.value.trim() !== '') ||
    optionalQuantityInvalid(draft.minimumQuantityText) ||
    optionalQuantityInvalid(draft.packageQuantityText) ||
    (saved.tiersEdited && tierRowsInvalid(saved.tiers, parseQuantityText(draft.minimumQuantityText) ?? 1)) ||
    weightInvalid(draft.weightGramsText) ||
    (draft.originalPriceText.trim() !== '' && parseCzkText(draft.originalPriceText) === null) ||
    draft.description.trim().length > 2000
  );
};

const variantErrorsOf = (drafts: readonly VariantDraft[]) =>
  drafts.map((draft) => ({
    details: variantDetailsInvalid(draft),
    name: draft.name.trim() === '' || draft.name.trim().length > 100,
    price: parseCzk(draft.priceText) === null,
    sku: draft.sku.trim() === '' || draft.sku.trim().length > 64,
  }));

const duplicateSkuOf = (drafts: readonly VariantDraft[]) => {
  const skus = drafts.map((draft) => draft.sku.trim().toLowerCase());
  return skus.some((sku, index) => sku !== '' && skus.indexOf(sku) !== index);
};

const variantsInvalid = (drafts: readonly VariantDraft[]) =>
  duplicateSkuOf(drafts) ||
  variantErrorsOf(drafts).some((entry) => entry.details || entry.name || entry.price || entry.sku);

type EditableVariant = { -readonly [Key in keyof ProductVariant]?: ProductVariant[Key] };

/**
 * The variant with the detail fields of its draft. A save replaces the whole variant list, so an emptied field drops
 * the key; tiers are sent only when edited (otherwise the server keeps or rescales the stored ones).
 */
const withVariantDetails = (kept: ProductVariant | EditableVariant, draft: VariantDetailDraft): EditableVariant => {
  const {
    description: _description,
    imageSrc: _imageSrc,
    isAction: _isAction,
    isNew: _isNew,
    isRecommended: _isRecommended,
    isSale: _isSale,
    minimumQuantity: _minimumQuantity,
    originalPriceMinor: _originalPriceMinor,
    packageQuantity: _packageQuantity,
    parameters: _parameters,
    sourceUnit: _sourceUnit,
    unit: _unit,
    weightGrams: _weightGrams,
    ...rest
  } = kept;
  const variant: EditableVariant = { ...rest };
  const parameters: { label: string; unit: string; value: string }[] = [];
  for (const { label, unit, value } of draft.parameters) {
    if (label.trim() !== '') {
      parameters.push({ label: label.trim(), unit: unit.trim(), value: value.trim() });
    }
  }
  if (parameters.length > 0) {
    variant.parameters = parameters;
  }
  if (draft.imageSrc !== '') {
    variant.imageSrc = draft.imageSrc;
  }
  for (const flag of ['isAction', 'isNew', 'isRecommended', 'isSale'] as const) {
    if (draft.flags[flag]) {
      variant[flag] = true;
    }
  }
  const minimum = parseQuantityText(draft.minimumQuantityText);
  if (minimum !== null) {
    variant.minimumQuantity = minimum;
  }
  const packageQuantity = parseQuantityText(draft.packageQuantityText);
  if (packageQuantity !== null) {
    variant.packageQuantity = packageQuantity;
  }
  if (draft.unit.trim() !== '') {
    variant.unit = draft.unit.trim();
  }
  if (draft.sourceUnit.trim() !== '') {
    variant.sourceUnit = draft.sourceUnit.trim();
  }
  if (draft.description.trim() !== '') {
    variant.description = draft.description.trim();
  }
  const weight = Number(draft.weightGramsText.trim());
  if (draft.weightGramsText.trim() !== '' && weight > 0) {
    variant.weightGrams = weight;
  }
  const original = parseCzkText(draft.originalPriceText);
  if (original !== null && original > 0) {
    variant.originalPriceMinor = original;
  }
  if (draft.tiersEdited) {
    variant.priceTiers = priceTiersOf(draft.tiers);
  }
  return variant;
};

/** The variants an UpdateProduct sends for `drafts`; the product's legacy variants stay as they are. */
const variantsOf = (drafts: readonly VariantDraft[], product: ProductRecord): ProductVariant[] => [
  ...drafts.map((draft): ProductVariant => {
    const original = (product.variants ?? []).find((variant) => variant.id !== undefined && variant.id === draft.id);
    const priceMinor = parseCzk(draft.priceText) ?? 0;
    const { priceTiers: inheritedTiers, ...originalFields } = original ?? {};
    const kept = original?.priceMinor === priceMinor ? original : originalFields;
    void inheritedTiers;
    // Edited tiers are sent as typed, so the row that repeats the old price follows the new one (the server rescales
    // only tiers it is not sent).
    const oldPrice = original?.priceMinor;
    const saved = withShownTiers(draft);
    const details =
      saved.tiersEdited && oldPrice !== undefined && oldPrice > 0 && oldPrice !== priceMinor
        ? {
            ...saved,
            tiers: saved.tiers.map((tier) =>
              parseCzkText(tier.netText) === oldPrice
                ? {
                    ...tier,
                    grossText: czkText(Math.round(((parseCzkText(tier.grossText) ?? 0) * priceMinor) / oldPrice)),
                    netText: czkText(priceMinor),
                  }
                : tier,
            ),
          }
        : saved;
    const variant = {
      ...withVariantDetails(kept, details),
      active: draft.active,
      attributes: draft.attributes.trim(),
      name: draft.name.trim(),
      priceMinor,
      sku: draft.sku.trim(),
    } satisfies ProductVariant;
    return draft.id === undefined ? variant : { ...variant, id: draft.id };
  }),
  ...(product.variants ?? []).filter((variant) => !isRealVariant(variant)),
];

/**
 * Real variants: each has its own identity, SKU, net price (gross shown), stock and active flag. Editing changes the
 * draft only; the Save button sends one UpdateProduct. The server keeps a per-variant price history, so a price
 * change stays traceable.
 */
const useVariantsPanel = ({
  canWrite,
  canMoveStock = canWrite,
  onCommitted,
  onReload,
  product,
  revision,
}: PanelProps) => {
  const [drafts, setDrafts] = useState<readonly VariantDraft[]>(() => variantDraftsOf(product));
  const [variantPage, setVariantPage] = useState(0);
  const [variantSearch, setVariantSearch] = useState('');
  const sequence = useRef(0);
  const records = new Map((product.variantRecords ?? []).map((record) => [record.id, record] as const));
  const patchDraft = (key: string, next: Partial<VariantDraft>) =>
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...next } : draft)));
  const save = useProductTabSave<readonly VariantDraft[]>({
    commandOf: (value) => ({ _tag: 'UpdateProduct', id: product.id, patch: { variants: variantsOf(value, product) } }),
    // A product Symmy created: no variant may be added (the ERP owns its variant list).
    isValid: (value) =>
      !variantsInvalid(value) && (!variantsOwnedBySymmy(product) || value.every((draft) => draft.id !== undefined)),
    // A changed price of a variant from Symmy goes to Pricing first, one variant after another; when Pricing refuses,
    // nothing of the draft is saved.
    keepAs: `variants:${product.id}`,
    writeThrough: (value, confirmed) =>
      Effect.forEach(
        value,
        (draft) => {
          const target = symmyVariantTarget(product, draft.id);
          const before = confirmed.find((entry) => entry.key === draft.key);
          const priceMinor = parseCzk(draft.priceText);
          return target === undefined ||
            priceMinor === null ||
            (before !== undefined && parseCzk(before.priceText) === priceMinor)
            ? Effect.void
            : writeThroughSymmyVariant({
                ...target,
                priceNet: (priceMinor / 100).toFixed(2),
                reason: `Změna ceny varianty ${draft.name.trim()}`,
              }).pipe(Effect.mapError((message) => `Cena varianty ${draft.name.trim()} nebyla uložena: ${message}`));
        },
        { discard: true },
      ),
    // Two operators edit different variants of one product: each variant merges on its own.
    merge: mergeKeyedDrafts,
    onReload,
    onSaved: () => onCommitted('Varianty uloženy. Nové ceny uvidí zákazník v e-shopu po obnovení stránky.'),
    reset: setDrafts,
    revision,
    server: variantDraftsOf(product),
    value: drafts,
    version: productVersionOf(product),
  });

  const visibleDrafts = drafts.filter((draft) =>
    `${draft.name} ${draft.sku}`.toLocaleLowerCase('cs').includes(variantSearch.toLocaleLowerCase('cs')),
  );
  const pageCount = Math.max(1, Math.ceil(visibleDrafts.length / 20));
  const currentPage = Math.min(variantPage, pageCount - 1);
  const errors = variantErrorsOf(drafts);
  const duplicateSku = duplicateSkuOf(drafts);
  // The field messages show once the draft is changed and holds the Save button back.
  const submitted = save.draft.status === 'invalid';

  const addDraft = () => {
    const key = `new-${sequence.current}`;
    setDrafts((current) => [
      ...current,
      {
        active: true,
        attributes: '',
        key,
        name: '',
        ...EMPTY_VARIANT_DETAILS,
        priceText: moneyInputText(product.currentPriceMinor / 100),
        sku: `${product.sku}-${current.length + 1}`,
      },
    ]);
    sequence.current += 1;
  };

  return {
    addDraft,
    canMoveStock,
    canWrite,
    currentPage,
    drafts,
    duplicateSku,
    errors,
    onCommitted,
    onReload,
    pageCount,
    patchDraft,
    product,
    records,
    revision,
    save,
    setVariantPage,
    setVariantSearch,
    submitted,
    variantSearch,
    visibleDrafts,
  };
};

type VariantRecord = NonNullable<ProductRecord['variantRecords']>[number];

const variantFieldError = (submitted: boolean, helpText: string, invalid = false) => {
  if (submitted && invalid) {
    return { helpText, validateStatus: 'error' as const };
  }
  return {};
};

/** The gross price a variant row shows: the server's for a saved price, else the preview at today's rate. */
const variantGrossPrice = (
  price: number | null,
  record: VariantRecord | undefined,
  vatRate: number | undefined,
  notSet: string,
) => {
  if (price === null) {
    return '—';
  }
  if (record?.priceMinor === price) {
    return record.grossPriceMinor === undefined ? notSet : formatMoney(record.grossPriceMinor);
  }
  return vatRate === undefined ? notSet : formatMoney(grossUnitPriceMinor(price, vatRate));
};

const variantPlaceholders = (product: ProductRecord) => {
  if (product.sourceGroupId === undefined) {
    return { attributes: 'Hmotnost: 250 g; Forma: zrnková', name: 'např. 250 g / zrnková' };
  }
  return { attributes: 'Vlastnosti varianty (nepovinné)', name: 'např. M6 × 20 / A2' };
};

const variantStockText = (record: VariantRecord | undefined, unit: ProductRecord['unit']) =>
  record === undefined ? (
    <span className="text-fg-secondary">nová</span>
  ) : (
    `${record.stockOnHand} ${record.sourceUnit ?? unit}`
  );

/** The variant's quantity tiers; a changed base price says the tiers follow it when it is saved. */
const renderVariantPriceTiers = (
  record: VariantRecord | undefined,
  unit: ProductRecord['unit'],
  rescaledNote: string | null,
) => {
  if (record?.priceTiers === undefined) {
    return null;
  }
  return (
    <div className="text-fg-secondary text-xs">
      <p>
        Minimum {record.minimumQuantity ?? 1} {record.sourceUnit ?? unit}
        {record.packageQuantity === undefined ? '' : ` · balení ${record.packageQuantity}`}
      </p>
      {record.priceTiers.map((tier) => (
        <p key={tier.minimumQuantity}>
          Od {tier.minimumQuantity} {record.sourceUnit ?? unit}: {formatMoney(tier.priceMinor)} s DPH ·{' '}
          {formatMoney(tier.priceExcludingVatMinor)} bez DPH
        </p>
      ))}
      {rescaledNote === null ? null : <p className="text-fg-primary">{rescaledNote}</p>}
    </div>
  );
};

/** The gallery, then every photo the product has shown as the server keeps it, then photos unsaved drafts picked. */
const variantImageChoicesOf = (product: ProductRecord, drafts: readonly { readonly imageSrc?: string }[]) => [
  ...new Set([
    ...(product.images ?? []),
    ...(product.photoLibrary ?? []),
    ...[...(product.variantRecords ?? []), ...drafts].flatMap((variant) =>
      variant.imageSrc === undefined || variant.imageSrc === '' ? [] : [variant.imageSrc],
    ),
  ]),
];

export const VariantsPanel = (props: PanelProps & { readonly vat: CompanyVat }) => {
  const { t } = useModernI18n();
  const {
    addDraft,
    canMoveStock,
    canWrite,
    currentPage,
    drafts,
    duplicateSku,
    errors,
    onCommitted,
    onReload,
    pageCount,
    patchDraft,
    product,
    records,
    revision,
    save,
    setVariantPage,
    setVariantSearch,
    submitted,
    variantSearch,
    visibleDrafts,
  } = useVariantsPanel(props);
  const placeholders = variantPlaceholders(product);
  const variantImageChoices = variantImageChoicesOf(product, drafts);
  const taxLabels = useTaxLabels();
  // The product's classification with the rate Tax gives it today; it names the gross preview of an edited price.
  // Staff records always name the classification; only storefront records omit it.
  const classification = classificationChoice(
    props.vat,
    product.taxClassificationCode ?? DEFAULT_TAX_CLASSIFICATION,
    DateTime.nowUnsafe(),
  );
  const [openDetails, setOpenDetails] = useState<string | null>(null);
  const vatRate = classification.current?.ratePercent;
  const variantDestination = props.variantDestination ?? { kind: 'none' };
  const selectedKey = variantDestination.kind === 'selected' ? variantDestination.draftKey : undefined;
  const [appliedTarget, setAppliedTarget] = useState<string | null>(null);
  const currentTarget = selectedKey ?? null;
  if (currentTarget !== appliedTarget) {
    setAppliedTarget(currentTarget);
    if (selectedKey !== undefined) {
      const index = drafts.findIndex((draft) => draft.key === selectedKey);
      if (index !== -1) {
        setVariantSearch('');
        setVariantPage(Math.floor(index / 20));
      }
    }
  }
  useEffect(() => {
    if (selectedKey !== undefined) {
      document.querySelector<HTMLElement>('[data-variant-target="selected"]')?.focus();
    }
  }, [selectedKey]);

  return (
    <div className="flex flex-col gap-250">
      {variantDestination.kind === 'unavailable' ? (
        <StatusText showIcon status="warning">
          {t('merchandise.pages.products.detail.variantUnavailable')}
        </StatusText>
      ) : null}
      <p className="text-fg-secondary text-sm">
        {t('merchandise.ui.variantsIntro', { vat: taxLabels.choice(classification) })}
      </p>
      <div className="flex flex-wrap items-center gap-150">
        <FormInput
          id="variant-search"
          label={t('merchandise.ui.searchVariants')}
          name="variant-search"
          onChange={(event) => {
            setVariantSearch(event.target.value);
            setVariantPage(0);
          }}
          placeholder={t('merchandise.ui.variantSearchPlaceholder')}
          value={variantSearch}
        />
        <Button
          appearance="outline"
          disabled={currentPage === 0}
          onClick={() => setVariantPage(currentPage - 1)}
          severity="secondary"
        >
          Předchozí
        </Button>
        <span className="text-fg-secondary text-sm">
          Strana {currentPage + 1} z {pageCount} · {visibleDrafts.length} variant
        </span>
        <Button
          appearance="outline"
          disabled={currentPage + 1 >= pageCount}
          onClick={() => setVariantPage(currentPage + 1)}
          severity="secondary"
        >
          Další
        </Button>
      </div>
      <SectionCard flush title={`Varianty (${drafts.length})`}>
        {drafts.length === 0 ? (
          <p className="p-200 text-fg-secondary text-sm">
            Produkt zatím nemá prodejní varianty — v e-shopu se prodává jako jeden kus za cenu produktu. Přidejte
            variantu, pokud se prodává například ve více gramážích nebo provedeních.
          </p>
        ) : (
          <ScrollRegion label={t('merchandise.ui.variantsScrollLabel')}>
            <Table appearance="line" size="sm">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Název a vlastnosti</Table.ColumnHeader>
                  <Table.ColumnHeader>SKU</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Cena bez DPH (Kč)</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">S DPH</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Sklad</Table.ColumnHeader>
                  <Table.ColumnHeader>Dostupnost</Table.ColumnHeader>
                  <Table.ColumnHeader>Aktivní</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {visibleDrafts.slice(currentPage * 20, (currentPage + 1) * 20).map((draft) => {
                  const index = drafts.indexOf(draft);
                  const record = draft.id === undefined ? undefined : records.get(draft.id);
                  const price = parseCzk(draft.priceText);
                  const error = errors[index];
                  return [
                    <Table.Row
                      aria-current={draft.key === selectedKey}
                      className={draft.key === selectedKey ? 'bg-primary/10' : ''}
                      data-variant-target={draft.key === selectedKey ? 'selected' : 'none'}
                      key={draft.key}
                      selected={draft.key === selectedKey}
                      tabIndex={-1}
                    >
                      <Table.Cell>
                        <div className="flex min-w-48 flex-col gap-50">
                          <FormInput
                            disabled={!canWrite}
                            id={`variant-label-${draft.key}`}
                            label={<span className="sr-only">Název varianty</span>}
                            name={`variant-label-${draft.key}`}
                            onChange={(event) => patchDraft(draft.key, { name: event.target.value })}
                            placeholder={placeholders.name}
                            size="sm"
                            value={draft.name}
                            {...variantFieldError(submitted, 'Zadejte název', error?.name)}
                          />
                          {draft.key === selectedKey ? (
                            <Badge severity="info" size="sm">
                              {t('merchandise.pages.products.detail.variantSelected')}
                            </Badge>
                          ) : null}
                          <FormInput
                            disabled={!canWrite}
                            id={`variant-attrs-${draft.key}`}
                            label={<span className="sr-only">Vlastnosti varianty</span>}
                            name={`variant-attrs-${draft.key}`}
                            onChange={(event) => patchDraft(draft.key, { attributes: event.target.value })}
                            placeholder={placeholders.attributes}
                            size="sm"
                            value={draft.attributes}
                          />
                          <VariantDetailsToggle
                            invalid={error?.details === true}
                            onToggle={() => setOpenDetails((current) => (current === draft.key ? null : draft.key))}
                            open={openDetails === draft.key}
                          />
                          {renderVariantPriceTiers(
                            record,
                            product.unit,
                            record !== undefined && price !== null && price !== record.priceMinor
                              ? t('merchandise.ui.variantTiersRescaled')
                              : null,
                          )}
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="w-48">
                          <FormInput
                            disabled={!canWrite}
                            id={`variant-sku-${draft.key}`}
                            label={<span className="sr-only">SKU</span>}
                            name={`variant-sku-${draft.key}`}
                            onChange={(event) => patchDraft(draft.key, { sku: event.target.value })}
                            size="sm"
                            value={draft.sku}
                            {...variantFieldError(submitted, 'Zadejte SKU', error?.sku)}
                          />
                        </div>
                      </Table.Cell>
                      <Table.Cell align="end">
                        <div className="ml-auto w-32">
                          <FormNumericInput
                            // A variant from Symmy saves its price to the ERP (Pricing) first; see writeThrough.
                            disabled={!canWrite}
                            formatOptions={MONEY_FORMAT}
                            id={`variant-price-${draft.key}`}
                            label={<span className="sr-only">Cena bez DPH</span>}
                            locale="cs-CZ"
                            min={0}
                            name={`variant-price-${draft.key}`}
                            onValueChange={(details) => patchDraft(draft.key, { priceText: details.value })}
                            size="sm"
                            value={draft.priceText}
                            {...variantFieldError(submitted, 'Zadejte cenu', error?.price)}
                          >
                            <NumericInput.Control>
                              <NumericInput.Input />
                            </NumericInput.Control>
                          </FormNumericInput>
                        </div>
                      </Table.Cell>
                      <Table.Cell align="end" className="tabular-nums">
                        {variantGrossPrice(price, record, classification.current?.ratePercent, taxLabels.notSet)}
                      </Table.Cell>
                      <Table.Cell align="end" className="tabular-nums">
                        {variantStockText(record, product.unit)}
                      </Table.Cell>
                      <Table.Cell>
                        {record === undefined ? (
                          <span className="text-fg-secondary">—</span>
                        ) : (
                          <AvailabilityBadge value={record.availability} />
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {canWrite ? (
                          <Switch
                            checked={draft.active}
                            disabled={!canWrite}
                            name={`variant-active-${draft.key}`}
                            onCheckedChange={(checked: boolean) => patchDraft(draft.key, { active: checked })}
                          >
                            <span className="sr-only">Aktivní</span>
                          </Switch>
                        ) : (
                          <Badge severity={draft.active ? 'success' : 'neutral'} size="sm">
                            {draft.active ? 'Aktivní' : 'Neaktivní'}
                          </Badge>
                        )}
                      </Table.Cell>
                    </Table.Row>,
                    openDetails === draft.key ? (
                      <Table.Row key={`${draft.key}-details`}>
                        <Table.Cell colSpan={7}>
                          <VariantDetailEditor
                            disabled={!canWrite}
                            draft={draft}
                            idPrefix={`variant-${draft.key}`}
                            images={variantImageChoices}
                            mainImage={product.images?.[0]}
                            onChange={(next) => patchDraft(draft.key, next)}
                            productId={product.id}
                            vatRate={vatRate}
                          />
                        </Table.Cell>
                      </Table.Row>
                    ) : null,
                  ];
                })}
              </Table.Body>
            </Table>
          </ScrollRegion>
        )}
      </SectionCard>
      {submitted && duplicateSku && (
        <StatusText showIcon status="error">
          SKU variant se nesmí opakovat.
        </StatusText>
      )}
      {variantsOwnedBySymmy(product) && (
        <p className="text-fg-secondary text-sm">Varianty tohoto produktu přidává ERP (Symmy).</p>
      )}
      {canWrite && (
        <div className="flex flex-wrap items-center justify-between gap-150">
          <Button
            appearance="outline"
            disabled={variantsOwnedBySymmy(product)}
            icon="icon-[mdi--plus]"
            onClick={addDraft}
            severity="secondary"
            type="button"
          >
            Přidat variantu
          </Button>
          <ProductTabSaveBar active={props.active ?? true} save={save} />
        </div>
      )}
      {(product.variantRecords ?? []).length > 0 && (
        <VariantStockForm
          canWrite={canMoveStock}
          onCommitted={onCommitted}
          onReload={onReload}
          product={product}
          revision={revision}
        />
      )}
      {(product.variantRecords ?? []).length > 0 && <VariantPriceHistory product={product} />}
    </div>
  );
};
