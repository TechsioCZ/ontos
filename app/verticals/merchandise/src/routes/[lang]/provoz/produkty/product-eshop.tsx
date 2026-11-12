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
import { DateTime } from 'effect';
import { useEffect, useRef, useState } from 'react';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type {
  Availability,
  ProductVariant,
  StockMovementReason,
  VariantId,
} from '../../../../../shared/domain/merchandise-model.ts';
import { grossUnitPriceMinor, isRealVariant } from '../../../../../shared/domain/merchandise-model.ts';
import { MONEY_FORMAT, WHOLE_NUMBER_FORMAT, moneyInputText } from '../../../../form-number.ts';
import { runCommand } from './products-api.ts';
import { useCommandFailure } from './product-form-labels.ts';
import { useCommandInputGuard } from './command-input-guard.tsx';
import { ProductTabSaveBar, useProductTabSave } from './product-tab-save.tsx';
import type { ProductVariantDestination } from './product-variant-destination.ts';
import {
  DEFAULT_TAX_CLASSIFICATION,
  classificationChoice,
  rateAt,
  useTaxLabels,
} from './product-tax-classification.ts';
import type { CompanyVat } from './product-tax-classification.ts';

const availabilityPresentation = {
  IN_STOCK: { label: 'Skladem', variant: 'success' },
  LOW_STOCK: { label: 'Poslední kusy', variant: 'warning' },
  OUT_OF_STOCK: { label: 'Nedostupné', variant: 'danger' },
  UNKNOWN: { label: 'Nelze ověřit', variant: 'outline' },
} as const satisfies Readonly<
  Record<Availability, { readonly label: string; readonly variant: 'danger' | 'outline' | 'success' | 'warning' }>
>;

export const AvailabilityBadge = ({ value }: { readonly value: Availability | undefined }) => {
  const presentation = availabilityPresentation[value ?? 'UNKNOWN'];
  return (
    <Badge size="sm" variant={presentation.variant}>
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

interface VariantDraft {
  readonly active: boolean;
  readonly attributes: string;
  readonly id?: VariantId;
  readonly key: string;
  readonly name: string;
  readonly priceText: string;
  readonly sku: string;
}

const variantDraftsOf = (product: ProductRecord): readonly VariantDraft[] => {
  const drafts: VariantDraft[] = [];
  for (const variant of product.variants ?? []) {
    if (isRealVariant(variant)) {
      drafts.push({
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
  /** A variant stock movement replaced catalog revision `expectedRevision` with `revision`; it changed stock only. */
  readonly onStockCommitted?: ((expectedRevision: number, revision: number) => void) | undefined;
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
const VariantStockForm = ({ canWrite, onCommitted, onReload, onStockCommitted, product, revision }: PanelProps) => {
  const { t } = useModernI18n();
  const failure = useCommandFailure();
  const variants = product.variantRecords ?? [];
  const [variantId, setVariantId] = useState<string>(variants[0]?.id ?? '');
  const [reason, setReason] = useState<MovementReason>('RECEIPT');
  const [quantityText, setQuantityText] = useState('10');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstVariant = variants[0]?.id ?? '';
  const clear = () => {
    setVariantId(firstVariant);
    setReason('RECEIPT');
    setQuantityText('10');
  };
  // The movement keeps its own button; leaving with a half-filled one asks before the input is lost.
  const typed = variantId !== firstVariant || reason !== 'RECEIPT' || quantityText !== '10';
  const { dialog } = useCommandInputGuard(canWrite && typed, clear);
  if (!canWrite) {
    return null;
  }
  const variant = variants.find((entry) => entry.id === variantId);
  const quantity = Number(quantityText.replaceAll(/\s/gu, '').replace(',', '.'));
  const valid =
    variant !== undefined && Number.isInteger(quantity) && quantity !== 0 && (reason === 'ADJUSTMENT' || quantity > 0);

  const submit = () => {
    if (!valid || variant === undefined || busy) {
      setError('Zadejte celé nenulové množství.');
      return;
    }
    const delta = variantMovementDelta(reason, quantity);
    setBusy(true);
    setError(null);
    runCommand(
      {
        _tag: 'RecordStockMovement',
        delta,
        note: `Varianta ${variant.name}`,
        productId: product.id,
        reason,
        variantId: variant.id,
      },
      revision,
      (outcome) => {
        setBusy(false);
        if (!outcome.ok) {
          setError(
            outcome.reason === 'rejected'
              ? 'Sklad varianty nesmí klesnout pod nulu.'
              : failure(outcome.reason, onReload, outcome.proposal),
          );
          return;
        }
        onStockCommitted?.(revision, outcome.revision);
        clear();
        onCommitted(`Pohyb zapsán: ${variant.name} ${delta > 0 ? '+' : ''}${delta} ks`);
      },
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
          formatOptions={WHOLE_NUMBER_FORMAT}
          id="variant-stock-quantity"
          label={t('merchandise.ui.quantityPieces')}
          locale="cs-CZ"
          name="variantStockQuantity"
          onValueChange={(details) => setQuantityText(details.value)}
          size="sm"
          value={quantityText}
        >
          <NumericInput.Control>
            <NumericInput.Input aria-valuemax={undefined} />
          </NumericInput.Control>
        </FormNumericInput>
        <Button
          isLoading={busy}
          loadingText="Zapisuji…"
          onClick={submit}
          theme="outlined"
          type="button"
          variant="secondary"
        >
          Zapsat pohyb
        </Button>
      </div>
      {error !== null && (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
      {dialog}
    </SectionCard>
  );
};

/** Gross price at the rate Tax gave the product's classification at `at`; none when that period is not published. */
const grossAt = (netMinor: number, product: ProductRecord, vat: CompanyVat, at: DateTime.Utc): number | undefined => {
  const rate = rateAt(vat, product.taxClassificationCode, at);
  return rate === undefined ? undefined : grossUnitPriceMinor(netMinor, rate.ratePercent);
};

export const VariantPriceHistory = ({
  product,
  vat,
}: {
  readonly product: ProductRecord;
  readonly vat: CompanyVat;
}) => {
  const { t } = useModernI18n();
  const variantRows = (product.variantRecords ?? []).flatMap((variant) =>
    variant.priceHistory.map((entry, index) => ({
      at: entry.effectiveFrom,
      gross: grossAt(entry.priceMinor, product, vat, entry.effectiveFrom),
      key: `${variant.id}-${index}`,
      name: `${variant.name} · ${variant.sku}`,
      net: entry.priceMinor,
      previous: entry.previousPriceMinor ?? (index === 0 ? undefined : variant.priceHistory[index - 1]?.priceMinor),
    })),
  );
  const rows = [
    ...variantRows,
    ...product.priceHistory.map((entry, index) => ({
      at: entry.effectiveFrom,
      gross: grossAt(entry.priceMinor, product, vat, entry.effectiveFrom),
      key: `product-${index}`,
      name: `Základní cena produktu · ${product.sku}`,
      net: entry.priceMinor,
      previous: entry.previousPriceMinor ?? product.priceHistory[index - 1]?.priceMinor,
    })),
  ];
  const sorted = rows.toSorted((left, right) => DateTime.toEpochMillis(right.at) - DateTime.toEpochMillis(left.at));
  return (
    <SectionCard flush title={t('merchandise.ui.variantPriceHistory')}>
      <ScrollRegion label={t('merchandise.ui.variantPriceHistory')}>
        <Table size="sm" variant="line">
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

const variantErrorsOf = (drafts: readonly VariantDraft[]) =>
  drafts.map((draft) => ({
    name: draft.name.trim() === '' || draft.name.trim().length > 100,
    price: parseCzk(draft.priceText) === null,
    sku: draft.sku.trim() === '' || draft.sku.trim().length > 64,
  }));

const duplicateSkuOf = (drafts: readonly VariantDraft[]) => {
  const skus = drafts.map((draft) => draft.sku.trim().toLowerCase());
  return skus.some((sku, index) => sku !== '' && skus.indexOf(sku) !== index);
};

const variantsInvalid = (drafts: readonly VariantDraft[]) =>
  duplicateSkuOf(drafts) || variantErrorsOf(drafts).some((entry) => entry.name || entry.price || entry.sku);

/** The variants an UpdateProduct sends for `drafts`; the product's legacy variants stay as they are. */
const variantsOf = (drafts: readonly VariantDraft[], product: ProductRecord): ProductVariant[] => [
  ...drafts.map((draft): ProductVariant => {
    const original = (product.variants ?? []).find((variant) => variant.id !== undefined && variant.id === draft.id);
    const variant: { -readonly [Key in keyof ProductVariant]: ProductVariant[Key] } = {
      ...original,
      active: draft.active,
      attributes: draft.attributes.trim(),
      name: draft.name.trim(),
      priceMinor: parseCzk(draft.priceText) ?? 0,
      sku: draft.sku.trim(),
    };
    if (draft.id !== undefined) {
      variant.id = draft.id;
    }
    return variant;
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
    isValid: (value) => !variantsInvalid(value),
    onReload,
    onSaved: () => onCommitted('Varianty uloženy. Nové ceny uvidí zákazník v e-shopu po obnovení stránky.'),
    reset: setDrafts,
    revision,
    server: variantDraftsOf(product),
    value: drafts,
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

const renderVariantPriceTiers = (record: VariantRecord | undefined, unit: ProductRecord['unit']) => {
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
    </div>
  );
};

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
  const taxLabels = useTaxLabels();
  // The product's classification with the rate Tax gives it today; it names the gross preview of an edited price.
  // Staff records always name the classification; only storefront records omit it.
  const classification = classificationChoice(
    props.vat,
    product.taxClassificationCode ?? DEFAULT_TAX_CLASSIFICATION,
    DateTime.nowUnsafe(),
  );
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
        Varianta má vlastní SKU, cenu, sklad a stav. Cena se zadává bez DPH, zákazník v e-shopu vidí cenu s DPH (sazba{' '}
        {taxLabels.choice(classification)}), kterou spočítá server.
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
          disabled={currentPage === 0}
          onClick={() => setVariantPage(currentPage - 1)}
          theme="outlined"
          variant="secondary"
        >
          Předchozí
        </Button>
        <span className="text-fg-secondary text-sm">
          Strana {currentPage + 1} z {pageCount} · {visibleDrafts.length} variant
        </span>
        <Button
          disabled={currentPage + 1 >= pageCount}
          onClick={() => setVariantPage(currentPage + 1)}
          theme="outlined"
          variant="secondary"
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
            <Table size="sm" variant="line">
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
                  return (
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
                            <Badge size="sm" variant="info">
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
                          {renderVariantPriceTiers(record, product.unit)}
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
                          <Badge size="sm" variant={draft.active ? 'success' : 'outline'}>
                            {draft.active ? 'Aktivní' : 'Neaktivní'}
                          </Badge>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  );
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
      {canWrite && (
        <div className="flex flex-wrap items-center justify-between gap-150">
          <Button icon="icon-[mdi--plus]" onClick={addDraft} theme="outlined" type="button" variant="secondary">
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
          onStockCommitted={props.onStockCommitted}
          product={product}
          revision={revision}
        />
      )}
      {(product.variantRecords ?? []).length > 0 && <VariantPriceHistory product={product} vat={props.vat} />}
    </div>
  );
};
