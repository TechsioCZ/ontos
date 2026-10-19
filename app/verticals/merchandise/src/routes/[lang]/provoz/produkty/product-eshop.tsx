// E-shop product administration: real variants (SKU, price, stock, active), images, publication and availability.
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { formatDateTime, formatMoney, SectionCard } from '@app/admin-ui';
import { DateTime } from 'effect';
import { useState } from 'react';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type { Availability, ProductVariant, VariantId } from '../../../../../shared/domain/merchandise-model.ts';
import { grossUnitPriceMinor, isRealVariant } from '../../../../../shared/domain/merchandise-model.ts';
import { MONEY_FORMAT, WHOLE_NUMBER_FORMAT, moneyInputText } from '../../../../form-number.ts';
import { runCommand } from './products-api.ts';
import { useCommandFailure } from './product-forms.tsx';

/** The customer storefront (apps/eshop-storefront) serves product images and pages. */
export const STOREFRONT_ORIGIN = 'http://localhost:3060';

export const imageUrl = (reference: string): string =>
  /^https?:\/\//u.test(reference) ? reference : `${STOREFRONT_ORIGIN}${reference.startsWith('/') ? '' : '/'}${reference}`;

const availabilityPresentation: Readonly<
  Record<Availability, { readonly label: string; readonly variant: 'danger' | 'outline' | 'success' | 'warning' }>
> = {
  IN_STOCK: { label: 'Skladem', variant: 'success' },
  LOW_STOCK: { label: 'Poslední kusy', variant: 'warning' },
  OUT_OF_STOCK: { label: 'Nedostupné', variant: 'danger' },
  UNKNOWN: { label: 'Nelze ověřit', variant: 'outline' },
};

export const AvailabilityBadge = ({ value }: { readonly value: Availability | undefined }) => {
  const presentation = availabilityPresentation[value ?? 'UNKNOWN'];
  return (
    <Badge size="sm" variant={presentation.variant}>
      {presentation.label}
    </Badge>
  );
};

const parseCzk = (text: string): number | null => {
  const normalized = text.replace(/\s/gu, '').replace(',', '.');
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

const variantDraftsOf = (product: ProductRecord): readonly VariantDraft[] =>
  (product.variants ?? []).filter(isRealVariant).map((variant) => ({
    active: variant.active !== false,
    attributes: variant.attributes,
    id: variant.id,
    key: variant.id,
    name: variant.name,
    priceText: moneyInputText(variant.priceMinor / 100),
    sku: variant.sku ?? '',
  }));

interface PanelProps {
  readonly canWrite: boolean;
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  readonly product: ProductRecord;
  readonly revision: number;
}

/**
 * Real variants: each has its own identity, SKU, net price (gross shown), stock and active flag. Saving sends one
 * UpdateProduct; the server keeps a per-variant price history, so a price change stays traceable.
 */
export const VariantsPanel = ({ canWrite, onCommitted, onReload, product, revision }: PanelProps) => {
  const failure = useCommandFailure();
  const [drafts, setDrafts] = useState<readonly VariantDraft[]>(() => variantDraftsOf(product));
  const [sequence, setSequence] = useState(0);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const records = new Map((product.variantRecords ?? []).map((record) => [record.id, record] as const));
  const legacy = (product.variants ?? []).filter((variant) => !isRealVariant(variant));
  const patchDraft = (key: string, next: Partial<VariantDraft>) =>
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...next } : draft)));

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
        const original = (product.variants ?? []).find((variant) => variant.id !== undefined && variant.id === draft.id);
        return {
          active: draft.active,
          attributes: draft.attributes.trim(),
          ...(draft.id === undefined ? {} : { id: draft.id }),
          name: draft.name.trim(),
          ...(original?.priceHistory === undefined ? {} : { priceHistory: original.priceHistory }),
          priceMinor: parseCzk(draft.priceText) ?? 0,
          sku: draft.sku.trim(),
        };
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

  return (
    <div className="flex flex-col gap-250">
      <StatusText showIcon status="default">
        Varianta má vlastní SKU, cenu, sklad a stav. Cena se zadává bez DPH, zákazník v e-shopu vidí cenu s DPH ({product.vatRate} %),
        kterou spočítá server.
      </StatusText>
      <SectionCard flush title={`Varianty (${drafts.length})`}>
        {drafts.length === 0 ? (
          <p className="p-200 text-fg-secondary text-sm">
            Produkt zatím nemá prodejní varianty — v e-shopu se prodává jako jeden kus za cenu produktu. Přidejte variantu,
            pokud se prodává například ve více gramážích nebo provedeních.
          </p>
        ) : (
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
              {drafts.map((draft, index) => {
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
                          placeholder="např. 250 g / zrnková"
                          size="sm"
                          value={draft.name}
                          {...(submitted && error?.name === true ? { helpText: 'Zadejte název', validateStatus: 'error' as const } : {})}
                        />
                        <FormInput
                          disabled={!canWrite}
                          id={`variant-attrs-${draft.key}`}
                          label={<span className="sr-only">Vlastnosti varianty</span>}
                          name={`variant-attrs-${draft.key}`}
                          onChange={(event) => patchDraft(draft.key, { attributes: event.target.value })}
                          placeholder="Hmotnost: 250 g; Forma: zrnková"
                          size="sm"
                          value={draft.attributes}
                        />
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="w-36">
                        <FormInput
                          disabled={!canWrite}
                          id={`variant-sku-${draft.key}`}
                          label={<span className="sr-only">SKU</span>}
                          name={`variant-sku-${draft.key}`}
                          onChange={(event) => patchDraft(draft.key, { sku: event.target.value })}
                          size="sm"
                          value={draft.sku}
                          {...(submitted && error?.sku === true ? { helpText: 'Zadejte SKU', validateStatus: 'error' as const } : {})}
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
                          {...(submitted && error?.price === true ? { helpText: 'Zadejte cenu', validateStatus: 'error' as const } : {})}
                        >
                          <NumericInput.Control>
                            <NumericInput.Input />
                          </NumericInput.Control>
                        </FormNumericInput>
                      </div>
                    </Table.Cell>
                    <Table.Cell align="end" className="tabular-nums">
                      {price === null ? '—' : formatMoney(grossUnitPriceMinor(price, product.vatRate))}
                    </Table.Cell>
                    <Table.Cell align="end" className="tabular-nums">
                      {record === undefined ? <span className="text-fg-secondary">nová</span> : `${record.stockOnHand} ks`}
                    </Table.Cell>
                    <Table.Cell>
                      {record === undefined ? <span className="text-fg-secondary">—</span> : <AvailabilityBadge value={record.availability} />}
                    </Table.Cell>
                    <Table.Cell>
                      <Switch
                        checked={draft.active}
                        disabled={!canWrite}
                        name={`variant-active-${draft.key}`}
                        onCheckedChange={(checked: boolean) => patchDraft(draft.key, { active: checked })}
                      >
                        <span className="sr-only">Aktivní</span>
                      </Switch>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
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
          <Button
            icon="icon-[mdi--plus]"
            onClick={() => {
              setDrafts((current) => [
                ...current,
                {
                  active: true,
                  attributes: '',
                  key: `new-${sequence}`,
                  name: '',
                  priceText: moneyInputText(product.currentPriceMinor / 100),
                  sku: `${product.sku}-${current.length + 1}`,
                },
              ]);
              setSequence(sequence + 1);
            }}
            theme="outlined"
            type="button"
            variant="secondary"
          >
            Přidat variantu
          </Button>
          <Button isLoading={busy} loadingText="Ukládám…" onClick={save} type="button" variant="primary">
            Uložit varianty
          </Button>
        </div>
      )}
      {(product.variantRecords ?? []).length > 0 && (
        <VariantStockForm canWrite={canWrite} onCommitted={onCommitted} onReload={onReload} product={product} revision={revision} />
      )}
      {(product.variantRecords ?? []).length > 0 && <VariantPriceHistory product={product} />}
    </div>
  );
};

type MovementReason = 'RECEIPT' | 'ISSUE' | 'ADJUSTMENT';
const reasonLabels: Readonly<Record<MovementReason, string>> = {
  ADJUSTMENT: 'Korekce (inventura)',
  ISSUE: 'Výdej',
  RECEIPT: 'Příjem',
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
  const quantity = Number(quantityText.replace(/\s/gu, '').replace(',', '.'));
  const valid = variant !== undefined && Number.isInteger(quantity) && quantity !== 0 && (reason === 'ADJUSTMENT' || quantity > 0);

  const submit = () => {
    if (!valid || variant === undefined || busy) {
      setError('Zadejte celé nenulové množství.');
      return;
    }
    const delta = reason === 'ISSUE' ? -Math.abs(quantity) : reason === 'RECEIPT' ? Math.abs(quantity) : quantity;
    setBusy(true);
    setError(null);
    runCommand(
      { _tag: 'RecordStockMovement', delta, note: `Varianta ${variant.name}`, productId: product.id, reason, variantId: variant.id },
      revision,
      (outcome) => {
        setBusy(false);
        if (!outcome.ok) {
          setError(outcome.reason === 'rejected' ? 'Sklad varianty nesmí klesnout pod nulu.' : failure(outcome.reason, onReload));
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
          items={(Object.keys(reasonLabels) as MovementReason[]).map((value) => ({ label: reasonLabels[value], value }))}
          label="Typ pohybu"
          name="stockReason"
          onValueChange={(details) => {
            const next = (Object.keys(reasonLabels) as MovementReason[]).find((value) => value === details.value[0]);
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
        <Button isLoading={busy} loadingText="Zapisuji…" onClick={submit} theme="outlined" type="button" variant="secondary">
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

const VariantPriceHistory = ({ product }: { readonly product: ProductRecord }) => {
  const rows = (product.variantRecords ?? []).flatMap((variant) =>
    variant.priceHistory.map((entry, index) => ({
      at: entry.effectiveFrom,
      gross: grossUnitPriceMinor(entry.priceMinor, product.vatRate),
      key: `${variant.id}-${index}`,
      name: variant.name,
      net: entry.priceMinor,
      previous: index === 0 ? undefined : variant.priceHistory[index - 1]?.priceMinor,
    })),
  );
  const sorted = rows.toSorted((left, right) => DateTime.toEpochMillis(right.at) - DateTime.toEpochMillis(left.at));
  return (
    <SectionCard flush title="Historie cen variant">
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
    </SectionCard>
  );
};

/** Storefront presentation: images, publication, slug and how availability is reported. */
export const EshopPanel = ({ canWrite, onCommitted, onReload, product, revision }: PanelProps) => {
  const failure = useCommandFailure();
  const [images, setImages] = useState<readonly string[]>(() => product.images ?? []);
  const [newImage, setNewImage] = useState('');
  const [slug, setSlug] = useState(product.slug ?? '');
  const [published, setPublished] = useState(product.published !== false);
  const [stockTracked, setStockTracked] = useState(product.stockTracked !== false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const storefrontHref = `${STOREFRONT_ORIGIN}/produkt/${product.slug ?? product.id}`;
  const slugInvalid = slug.trim() !== '' && !/^[a-z0-9-]{1,120}$/u.test(slug.trim());

  const save = () => {
    if (busy || slugInvalid) {
      return;
    }
    setBusy(true);
    setServerError(null);
    runCommand(
      {
        _tag: 'UpdateProduct',
        id: product.id,
        patch: {
          images: [...images],
          published,
          stockTracked,
          ...(slug.trim() === '' ? {} : { slug: slug.trim() }),
        },
      },
      revision,
      (outcome) => {
        setBusy(false);
        if (!outcome.ok) {
          setServerError(failure(outcome.reason, onReload));
          return;
        }
        onCommitted('Nastavení e-shopu uloženo. Změnu uvidí zákazník po obnovení stránky.');
      },
    );
  };

  return (
    <div className="flex flex-col gap-250">
      <SectionCard title="Jak produkt vidí zákazník">
        <div className="flex flex-wrap items-center gap-150">
          <span className="font-semibold text-lg tabular-nums">
            {product.grossPriceMinor === undefined ? 'cena není dostupná' : `${(product.variantRecords ?? []).length > 0 ? 'od ' : ''}${formatMoney(product.grossPriceMinor)}`}
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
          <Link className="ml-auto" external href={storefrontHref} target="_blank">
            Otevřít v e-shopu
          </Link>
        </div>
      </SectionCard>

      <SectionCard title={`Obrázky (${images.length})`}>
        {images.length === 0 ? (
          <div className="flex h-32 items-center justify-center rounded-md border border-border-primary border-dashed text-fg-secondary text-sm">
            Produkt nemá obrázek — e-shop zobrazí zástupný obrázek „bez obrázku“.
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-200 sm:grid-cols-4">
            {images.map((image, index) => (
              <li className="flex flex-col gap-100" key={`${image}-${index}`}>
                <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md border border-border-primary bg-surface-subtle">
                  {broken.has(image) ? (
                    <span className="p-100 text-center text-fg-secondary text-xs">Náhled se nenačetl (e-shop neběží?)</span>
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
                <div className="flex items-center justify-between gap-100">
                  <span className="truncate text-fg-secondary text-xs" title={image}>
                    {index === 0 ? 'Hlavní · ' : ''}
                    {image}
                  </span>
                  {canWrite && (
                    <Button
                      aria-label={`Odebrat obrázek ${index + 1}`}
                      icon="icon-[mdi--delete-outline]"
                      onClick={() => setImages(images.filter((_, position) => position !== index))}
                      size="sm"
                      theme="borderless"
                      type="button"
                      variant="secondary"
                    />
                  )}
                </div>
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
            />
            <Button
              disabled={newImage.trim() === '' || images.length >= 20}
              icon="icon-[mdi--image-plus-outline]"
              onClick={() => {
                setImages([...images, newImage.trim()]);
                setNewImage('');
              }}
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
            {...(slugInvalid ? { helpText: 'Jen malá písmena bez diakritiky, číslice a pomlčky', validateStatus: 'error' as const } : {})}
          />
          <Switch checked={published} disabled={!canWrite} name="published" onCheckedChange={(checked: boolean) => setPublished(checked)}>
            Zveřejnit v e-shopu
          </Switch>
          <Switch checked={stockTracked} disabled={!canWrite} name="stockTracked" onCheckedChange={(checked: boolean) => setStockTracked(checked)}>
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
