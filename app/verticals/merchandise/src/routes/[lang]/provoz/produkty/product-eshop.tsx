// E-shop product administration: real variants (SKU, price, stock, active), images, publication and availability.
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Tooltip } from '@techsio/ui-kit/atoms/tooltip';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { formatDateTime, formatMoney, SectionCard, surfaceTileClassName } from '@app/admin-ui';
import { DateTime } from 'effect';
import { useRef, useState } from 'react';
import type { ProductPatch } from '../../../../../shared/actions/apply-command.ts';
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
import { useCommandFailure } from './product-forms.tsx';
import { moveImage } from './product-images.ts';

import { AKROS_STOREFRONT_ORIGIN, STOREFRONT_ORIGIN } from '../../../../../shared/storefront-urls.ts';

export const imageUrl = (reference: string): string | undefined => {
  if (/^https?:\/\//u.test(reference)) {
    return reference;
  }
  const path = reference.startsWith('/') ? reference : `/${reference}`;
  const origin = path.startsWith('/akros/') ? AKROS_STOREFRONT_ORIGIN : STOREFRONT_ORIGIN;
  return origin === undefined ? undefined : `${origin}${path}`;
};

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

interface PanelProps {
  readonly canMoveStock?: boolean;
  readonly canWrite: boolean;
  readonly onArchived?: () => void;
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  readonly product: ProductRecord;
  readonly revision: number;
  readonly storefrontOrigin?: string;
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
  const failure = useCommandFailure();
  const variants = product.variantRecords ?? [];
  const [variantId, setVariantId] = useState<string>(variants[0]?.id ?? '');
  const [reason, setReason] = useState<MovementReason>('RECEIPT');
  const [quantityText, setQuantityText] = useState('10');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
              : failure(outcome.reason, onReload),
          );
          return;
        }
        onCommitted(`Pohyb zapsán: ${variant.name} ${delta > 0 ? '+' : ''}${delta} ks`);
      },
    );
  };

  return (
    <SectionCard title="Skladový pohyb varianty">
      <div className="grid grid-cols-1 items-end gap-200 sm:grid-cols-[minmax(0,1fr)_12rem_8rem_auto]">
        <SelectTemplate
          items={variants.map((entry) => ({ label: `${entry.name} (${entry.stockOnHand} ks)`, value: entry.id }))}
          label="Varianta"
          name="stockVariant"
          onValueChange={(details) => setVariantId(details.value[0] ?? '')}
          placeholder="Vyberte variantu"
          size="sm"
          value={variantId === '' ? [] : [variantId]}
        />
        <SelectTemplate
          items={movementReasons.map((value) => ({
            label: reasonLabels[value],
            value,
          }))}
          label="Typ pohybu"
          name="stockReason"
          onValueChange={(details) => {
            const next = movementReasons.find((value) => value === details.value[0]);
            if (next !== undefined) {
              setReason(next);
            }
          }}
          placeholder="Typ"
          size="sm"
          value={[reason]}
        />
        <FormNumericInput
          formatOptions={WHOLE_NUMBER_FORMAT}
          id="variant-stock-quantity"
          label="Množství (ks)"
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
    </SectionCard>
  );
};

export const VariantPriceHistory = ({ product }: { readonly product: ProductRecord }) => {
  const variantRows = (product.variantRecords ?? []).flatMap((variant) =>
    variant.priceHistory.map((entry, index) => ({
      at: entry.effectiveFrom,
      gross: grossUnitPriceMinor(entry.priceMinor, product.vatRate),
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
      gross: grossUnitPriceMinor(entry.priceMinor, product.vatRate),
      key: `product-${index}`,
      name: `Základní cena produktu · ${product.sku}`,
      net: entry.priceMinor,
      previous: entry.previousPriceMinor ?? product.priceHistory[index - 1]?.priceMinor,
    })),
  ];
  const sorted = rows.toSorted((left, right) => DateTime.toEpochMillis(right.at) - DateTime.toEpochMillis(left.at));
  return (
    <SectionCard flush title="Historie cen variant">
      {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Approved demo/sales-crm exception: this named overflow viewport needs keyboard scrolling. */}
      <section aria-label="Historie cen variant" style={{ overflowX: 'auto' }} tabIndex={0}>
        {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
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
                  {formatMoney(row.gross)}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </section>
    </SectionCard>
  );
};

/**
 * Real variants: each has its own identity, SKU, net price (gross shown), stock and active flag. Saving sends one
 * UpdateProduct; the server keeps a per-variant price history, so a price change stays traceable.
 */
const useVariantsPanel = ({
  canWrite,
  canMoveStock = canWrite,
  onCommitted,
  onReload,
  product,
  revision,
}: PanelProps) => {
  const failure = useCommandFailure();
  const [drafts, setDrafts] = useState<readonly VariantDraft[]>(() => variantDraftsOf(product));
  const [variantPage, setVariantPage] = useState(0);
  const [variantSearch, setVariantSearch] = useState('');
  const sequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const records = new Map((product.variantRecords ?? []).map((record) => [record.id, record] as const));
  const legacy = (product.variants ?? []).filter((variant) => !isRealVariant(variant));
  const patchDraft = (key: string, next: Partial<VariantDraft>) =>
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...next } : draft)));

  const visibleDrafts = drafts.filter((draft) =>
    `${draft.name} ${draft.sku}`.toLocaleLowerCase('cs').includes(variantSearch.toLocaleLowerCase('cs')),
  );
  const pageCount = Math.max(1, Math.ceil(visibleDrafts.length / 20));
  const currentPage = Math.min(variantPage, pageCount - 1);
  const errors = drafts.map((draft) => ({
    name: draft.name.trim() === '' || draft.name.trim().length > 100,
    price: parseCzk(draft.priceText) === null,
    sku: draft.sku.trim() === '' || draft.sku.trim().length > 64,
  }));
  const skus = drafts.map((draft) => draft.sku.trim().toLowerCase());
  const duplicateSku = skus.some((sku, index) => sku !== '' && skus.indexOf(sku) !== index);
  const invalid = duplicateSku || errors.some((entry) => entry.name || entry.price || entry.sku);

  const save = () => {
    setSubmitted(true);
    if (invalid || busy) {
      return;
    }
    const variants: ProductVariant[] = [
      ...drafts.map((draft): ProductVariant => {
        const original = (product.variants ?? []).find(
          (variant) => variant.id !== undefined && variant.id === draft.id,
        );
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
      ...legacy,
    ];
    setBusy(true);
    setServerError(null);
    runCommand({ _tag: 'UpdateProduct', id: product.id, patch: { variants } }, revision, (outcome) => {
      setBusy(false);
      if (!outcome.ok) {
        setServerError(failure(outcome.reason, onReload));
        return;
      }
      setSubmitted(false);
      onCommitted('Varianty uloženy. Nové ceny uvidí zákazník v e-shopu po obnovení stránky.');
    });
  };

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
    busy,
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
    serverError,
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

const variantGrossPrice = (
  price: number | null,
  record: VariantRecord | undefined,
  vatRate: ProductRecord['vatRate'],
) => {
  if (price === null) {
    return '—';
  }
  return formatMoney(record?.priceMinor === price ? record.grossPriceMinor : grossUnitPriceMinor(price, vatRate));
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

export const VariantsPanel = (props: PanelProps) => {
  const {
    addDraft,
    busy,
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
    serverError,
    setVariantPage,
    setVariantSearch,
    submitted,
    variantSearch,
    visibleDrafts,
  } = useVariantsPanel(props);
  const placeholders = variantPlaceholders(product);

  return (
    <div className="flex flex-col gap-250">
      <p className="text-fg-secondary text-sm">
        Varianta má vlastní SKU, cenu, sklad a stav. Cena se zadává bez DPH, zákazník v e-shopu vidí cenu s DPH (
        {product.vatRate} %), kterou spočítá server.
      </p>
      <div className="flex flex-wrap items-center gap-150">
        <FormInput
          id="variant-search"
          label="Hledat variantu"
          name="variant-search"
          onChange={(event) => {
            setVariantSearch(event.target.value);
            setVariantPage(0);
          }}
          placeholder="SKU nebo název varianty"
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
          /* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Approved demo/sales-crm exception: this named overflow viewport needs keyboard scrolling. */
          <section
            aria-label="Varianty — posuňte vodorovně pro cenu, sklad a aktivitu"
            style={{ maxWidth: '100%', overflowX: 'auto' }}
            tabIndex={0}
          >
            {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
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
                    <Table.Row key={draft.key}>
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
                        {variantGrossPrice(price, record, product.vatRate)}
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
          </section>
        )}
      </SectionCard>
      {submitted && duplicateSku && (
        <StatusText showIcon status="error">
          SKU variant se nesmí opakovat.
        </StatusText>
      )}
      {serverError !== null && (
        <StatusText showIcon status="error">
          {serverError}
        </StatusText>
      )}
      {canWrite && (
        <div className="flex flex-wrap justify-between gap-150">
          <Button icon="icon-[mdi--plus]" onClick={addDraft} theme="outlined" type="button" variant="secondary">
            Přidat variantu
          </Button>
          <Button isLoading={busy} loadingText="Ukládám…" onClick={save} type="button" variant="primary">
            Uložit varianty
          </Button>
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

const slugFieldError = (invalid: boolean, taken: boolean) => {
  if (invalid) {
    return { helpText: 'Jen malá písmena bez diakritiky, číslice a pomlčky', validateStatus: 'error' as const };
  }
  if (taken) {
    return { helpText: 'Tuto adresu už má jiný produkt', validateStatus: 'error' as const };
  }
  return {};
};

interface GalleryImage {
  readonly id: number;
  readonly reference: string;
}

/** Storefront presentation: images, publication, slug and how availability is reported. */
const useEshopPanel = ({
  canWrite,
  onArchived,
  onCommitted,
  onReload,
  product,
  revision,
  storefrontOrigin = STOREFRONT_ORIGIN,
}: PanelProps) => {
  const failure = useCommandFailure();
  const [images, setImages] = useState<readonly GalleryImage[]>(() =>
    (product.images ?? []).map((reference, id) => ({ id, reference })),
  );
  const nextImageId = useRef(product.images?.length ?? 0);
  const [newImage, setNewImage] = useState('');
  const newImageInvalid = newImage.trim() !== '' && !/^(?:\/(?!\/)|https:\/\/)\S+$/u.test(newImage.trim());
  const [slug, setSlug] = useState(product.slug ?? '');
  const [published, setPublished] = useState(product.published !== false);
  const [stockTracked, setStockTracked] = useState(product.stockTracked !== false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const storefrontHref =
    storefrontOrigin === undefined ? undefined : `${storefrontOrigin}/produkt/${product.slug ?? product.id}`;
  const [archiveReason, setArchiveReason] = useState('');
  const slugInvalid = slug.trim() !== '' && !/^[a-z0-9-]{1,120}$/u.test(slug.trim());
  // The slug the server refused because another product uses it; editing the field clears the message.
  const [takenSlug, setTakenSlug] = useState<string | null>(null);
  const slugTakenNow = takenSlug !== null && takenSlug === slug.trim();

  const save = () => {
    if (busy || slugInvalid || slugTakenNow) {
      return;
    }
    setBusy(true);
    setServerError(null);
    const patch: { -readonly [Key in keyof ProductPatch]: ProductPatch[Key] } = {
      images: images.map((image) => image.reference),
      published,
      stockTracked,
    };
    if (slug.trim() !== '') {
      patch.slug = slug.trim();
    }
    runCommand({ _tag: 'UpdateProduct', id: product.id, patch }, revision, (outcome) => {
      setBusy(false);
      if (!outcome.ok) {
        // The only business refusal of this save is a slug another product already uses.
        if (outcome.reason === 'rejected' && slug.trim() !== '' && slug.trim() !== (product.slug ?? '')) {
          setTakenSlug(slug.trim());
          setServerError('Adresu produktu už používá jiný produkt. Zvolte jinou adresu, nic se neuložilo.');
          return;
        }
        setServerError(failure(outcome.reason, onReload));
        return;
      }
      onCommitted('Nastavení e-shopu uloženo. Změnu uvidí zákazník po obnovení stránky.');
    });
  };

  const archive = () => {
    setBusy(true);
    runCommand({ _tag: 'ArchiveDemoProduct', id: product.id, reason: archiveReason.trim() }, revision, (outcome) => {
      setBusy(false);
      if (!outcome.ok) {
        setServerError(failure(outcome.reason, onReload));
        return;
      }
      onCommitted('DEMO produkt archivován. Audit a skladové pohyby zachovány.');
      onArchived?.();
    });
  };

  const addImage = () => {
    const id = nextImageId.current;
    nextImageId.current += 1;
    setImages([...images, { id, reference: newImage.trim() }]);
    setNewImage('');
  };

  return {
    addImage,
    archive,
    archiveReason,
    broken,
    busy,
    canWrite,
    images,
    newImage,
    newImageInvalid,
    product,
    published,
    save,
    serverError,
    setArchiveReason,
    setBroken,
    setImages,
    setNewImage,
    setPublished,
    setSlug,
    setStockTracked,
    slug,
    slugInvalid,
    slugTakenNow,
    stockTracked,
    storefrontHref,
  };
};

export const EshopPanel = (props: PanelProps) => {
  const {
    addImage,
    archive,
    archiveReason,
    broken,
    busy,
    canWrite,
    images,
    newImage,
    newImageInvalid,
    product,
    published,
    save,
    serverError,
    setArchiveReason,
    setBroken,
    setImages,
    setNewImage,
    setPublished,
    setSlug,
    setStockTracked,
    slug,
    slugInvalid,
    slugTakenNow,
    stockTracked,
    storefrontHref,
  } = useEshopPanel(props);

  return (
    <div className="flex flex-col gap-250">
      <SectionCard title="Jak produkt vidí zákazník">
        <div className="flex flex-wrap items-center gap-150">
          <span className="font-semibold text-lg tabular-nums">
            {product.grossPriceMinor === undefined
              ? 'cena není dostupná'
              : `${(product.variantRecords ?? []).length > 0 ? 'od ' : ''}${formatMoney(product.grossPriceMinor)}`}
          </span>
          <span className="text-fg-secondary text-sm">s DPH</span>
          <AvailabilityBadge value={product.availability} />
          {published && product.active ? (
            <Badge size="sm" variant="info">
              Zveřejněno v e-shopu
            </Badge>
          ) : (
            <Badge size="sm" variant="outline">
              Skryto v e-shopu
            </Badge>
          )}
          {storefrontHref !== undefined && (
            <Link className="ml-auto" external href={storefrontHref} target="_blank">
              Otevřít v e-shopu
            </Link>
          )}
        </div>
      </SectionCard>

      {canWrite && !product.active && product.published === false && (
        <SectionCard title="Archivace DEMO produktu">
          <p className="text-fg-secondary text-sm">
            Produkt zmizí ze seznamu i e-shopu. Skladové pohyby, objednávky a audit zůstanou zachovány.
          </p>
          <FormInput
            id="demo-archive-reason"
            label="Důvod archivace"
            maxLength={500}
            name="archiveReason"
            onChange={(event) => setArchiveReason(event.target.value)}
            value={archiveReason}
          />
          <Button
            disabled={busy || archiveReason.trim().length < 5}
            onClick={archive}
            theme="outlined"
            variant="danger"
          >
            Archivovat DEMO produkt
          </Button>
        </SectionCard>
      )}
      <SectionCard title={`Obrázky (${images.length})`}>
        <p className="mb-150 text-fg-secondary text-sm">
          První obrázek je hlavní. E-shop po uložení a obnovení stránky ukáže všechny obrázky v tomto pořadí.
        </p>
        {images.length === 0 ? (
          <div className="flex h-32 items-center justify-center rounded-md border border-border-primary border-dashed text-fg-secondary text-sm">
            Produkt nemá obrázek — e-shop zobrazí zástupný obrázek „bez obrázku“.
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-200 sm:grid-cols-4">
            {images.map(({ id, reference: image }, index) => (
              <li className="flex flex-col gap-100" key={id}>
                <div
                  className={`${surfaceTileClassName} flex aspect-square items-center justify-center overflow-hidden`}
                >
                  {broken.has(image) || imageUrl(image) === undefined ? (
                    <span className="p-100 text-center text-fg-secondary text-xs">
                      Náhled se nenačetl (e-shop neběží?)
                    </span>
                  ) : (
                    <img
                      alt={`${product.name} – obrázek ${index + 1}`}
                      className="size-full object-cover"
                      loading="lazy"
                      onError={() => setBroken((current) => new Set([...current, image]))}
                      src={imageUrl(image)}
                    />
                  )}
                </div>
                <Tooltip content={image}>
                  <span className="truncate text-fg-secondary text-xs">
                    {index === 0 ? 'Hlavní · ' : ''}
                    {image}
                  </span>
                </Tooltip>
                {canWrite && (
                  <div className="flex flex-wrap items-center gap-50">
                    {index > 0 && (
                      <Button
                        aria-label={`Nastavit obrázek ${index + 1} jako hlavní`}
                        icon="icon-[mdi--star-outline]"
                        onClick={() => setImages(moveImage(images, index, 0))}
                        size="sm"
                        theme="borderless"
                        title="Nastavit jako hlavní"
                        type="button"
                        variant="secondary"
                      />
                    )}
                    <Button
                      aria-label={`Posunout obrázek ${index + 1} dopředu`}
                      disabled={index === 0}
                      icon="icon-[mdi--arrow-left]"
                      onClick={() => setImages(moveImage(images, index, index - 1))}
                      size="sm"
                      theme="borderless"
                      title="Posunout dopředu"
                      type="button"
                      variant="secondary"
                    />
                    <Button
                      aria-label={`Posunout obrázek ${index + 1} dozadu`}
                      disabled={index === images.length - 1}
                      icon="icon-[mdi--arrow-right]"
                      onClick={() => setImages(moveImage(images, index, index + 1))}
                      size="sm"
                      theme="borderless"
                      title="Posunout dozadu"
                      type="button"
                      variant="secondary"
                    />
                    <Button
                      aria-label={`Odebrat obrázek ${index + 1}`}
                      icon="icon-[mdi--delete-outline]"
                      onClick={() => setImages(images.filter((_, position) => position !== index))}
                      size="sm"
                      theme="borderless"
                      title="Odebrat"
                      type="button"
                      variant="secondary"
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <div className="mt-200 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-150">
            <FormInput
              id="eshop-new-image"
              label="Přidat obrázek (cesta v e-shopu nebo URL)"
              name="newImage"
              onChange={(event) => setNewImage(event.target.value)}
              placeholder={`/img/${product.slug ?? 'produkt'}.svg`}
              size="sm"
              value={newImage}
              {...(newImageInvalid
                ? {
                    helpText: 'Zadejte cestu začínající „/“ nebo adresu začínající „https://“.',
                    validateStatus: 'error' as const,
                  }
                : {})}
            />
            <Button
              disabled={newImage.trim() === '' || newImageInvalid || images.length >= 20}
              icon="icon-[mdi--image-plus-outline]"
              onClick={addImage}
              theme="outlined"
              type="button"
              variant="secondary"
            >
              Přidat
            </Button>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Zveřejnění a dostupnost">
        <div className="flex flex-col gap-200">
          <FormInput
            disabled={!canWrite}
            id="eshop-slug"
            label="Adresa produktu v e-shopu (slug)"
            name="slug"
            onChange={(event) => setSlug(event.target.value)}
            value={slug}
            {...slugFieldError(slugInvalid, slugTakenNow)}
          />
          <Switch
            checked={published}
            disabled={!canWrite}
            name="published"
            onCheckedChange={(checked: boolean) => setPublished(checked)}
          >
            Zveřejnit v e-shopu
          </Switch>
          <Switch
            checked={stockTracked}
            disabled={!canWrite}
            name="stockTracked"
            onCheckedChange={(checked: boolean) => setStockTracked(checked)}
          >
            Sklad je evidovaný (vypnuto = zákazník uvidí „dostupnost nyní nelze ověřit“ a nemůže objednat)
          </Switch>
        </div>
      </SectionCard>
      {serverError !== null && (
        <StatusText showIcon status="error">
          {serverError}
        </StatusText>
      )}
      {canWrite && (
        <div className="flex justify-end">
          <Button isLoading={busy} loadingText="Ukládám…" onClick={save} type="button" variant="primary">
            Uložit nastavení e-shopu
          </Button>
        </div>
      )}
    </div>
  );
};
