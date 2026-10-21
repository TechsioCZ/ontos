import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { comboboxTranslations, formatMoney, SectionCard } from '@app/admin-ui';
import { Effect } from 'effect';
import { useState } from 'react';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import type { Order, ProductRecord } from '../../../../../shared/apis/records.ts';
import type { ProductId, ShippingMethod, VariantId } from '../../../../../shared/domain/merchandise-model.ts';
import {
  grossUnitPriceMinor,
  shippingMethodFor,
  shippingMethods,
} from '../../../../../shared/domain/merchandise-model.ts';
import { isOrderQuantityValid, orderQuantityRules } from '../../../../../shared/domain/order-quantity.ts';
import { fullOrderTotals, lineGrossMinor } from '../../../../../shared/domain/order-totals.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { MONEY_FORMAT, moneyInputText } from '../../../../form-number.ts';
import { shippingOptions } from './order-eshop.ts';
import { editOrder, isRevisionConflict } from './orders-records.ts';

type EditCommand = Extract<MerchandiseCommand, { readonly _tag: 'EditOrder' }>;

interface DraftLine {
  readonly key: string;
  readonly name: string;
  readonly priceText: string;
  readonly productId: ProductId;
  readonly quantityText: string;
  readonly sku: string;
  readonly variantId?: VariantId;
  readonly variantName?: string;
  readonly vatRate: Order['lines'][number]['vatRate'];
}

interface Draft {
  readonly city: string;
  readonly country: string;
  readonly email: string;
  readonly lines: readonly DraftLine[];
  readonly name: string;
  readonly note: string;
  readonly phone: string;
  readonly postalCode: string;
  readonly reason: string;
  readonly shippingMethod: ShippingMethod | null;
  readonly shippingPriceText: string;
  readonly street: string;
}

const parseCzk = (text: string): number | null => {
  const normalized = text.replace(/\s/gu, '').replace(',', '.');
  if (normalized === '') {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
};

const parseQuantity = (text: string): number | null => {
  const value = Number(text.replace(/\s/gu, '').replace(',', '.'));
  return Number.isFinite(value) && value > 0 && value <= 1_000_000 ? value : null;
};

const draftOf = (order: Order): Draft => ({
  city: order.deliveryAddress?.city ?? '',
  country: order.deliveryAddress?.country ?? '',
  email: order.contact?.email ?? '',
  lines: order.lines.map((line, index) => ({
    key: `existing-${index}`,
    name: line.productName,
    priceText: moneyInputText(line.unitPriceMinor / 100),
    productId: line.productId,
    quantityText: String(line.quantity),
    sku: line.sku,
    ...(line.variantId === undefined ? {} : { variantId: line.variantId }),
    ...(line.variantName === undefined ? {} : { variantName: line.variantName }),
    vatRate: line.vatRate,
  })),
  name: order.contact?.name ?? '',
  note: order.note ?? '',
  phone: order.contact?.phone ?? '',
  postalCode: order.deliveryAddress?.postalCode ?? '',
  reason: '',
  shippingMethod: order.shipping?.method ?? null,
  shippingPriceText: order.shipping === undefined ? '' : moneyInputText(order.shipping.priceMinor / 100),
  street: order.deliveryAddress?.street ?? '',
});

interface SellableUnit {
  readonly label: string;
  readonly name: string;
  readonly netMinor: number;
  readonly productId: ProductId;
  readonly sku: string;
  readonly value: string;
  readonly variantId?: VariantId;
  readonly variantName?: string;
  readonly vatRate: DraftLine['vatRate'];
}

const sellableUnits = (products: readonly ProductRecord[]): readonly SellableUnit[] =>
  products
    .filter((product) => product.active)
    .flatMap((product): SellableUnit[] => {
      const variants = (product.variantRecords ?? []).filter((variant) => variant.active);
      if (variants.length === 0) {
        return [
          {
            label: `${product.name} (${product.sku})`,
            name: product.name,
            netMinor: product.currentPriceMinor,
            productId: product.id,
            sku: product.sku,
            value: product.id,
            vatRate: product.vatRate,
          },
        ];
      }
      return variants.map((variant) => ({
        label: `${product.name} — ${variant.name} (${variant.sku})`,
        name: product.name,
        netMinor: variant.priceMinor,
        productId: product.id,
        sku: variant.sku,
        value: `${product.id}|${variant.id}`,
        variantId: variant.id,
        variantName: variant.name,
        vatRate: product.vatRate,
      }));
    });

const sameAddress = (order: Order, draft: Draft) =>
  (order.deliveryAddress?.street ?? '') === draft.street.trim() &&
  (order.deliveryAddress?.city ?? '') === draft.city.trim() &&
  (order.deliveryAddress?.postalCode ?? '') === draft.postalCode.trim() &&
  (order.deliveryAddress?.country ?? '') === draft.country.trim();

const sameContact = (order: Order, draft: Draft) =>
  (order.contact?.name ?? '') === draft.name.trim() &&
  (order.contact?.email ?? '') === draft.email.trim() &&
  (order.contact?.phone ?? '') === draft.phone.trim();

interface OrderEditFormProps {
  /** The order wrote ORDER stock movements; quantity edits then move stock the same way. */
  readonly movesStock: boolean;
  readonly onCancel: () => void;
  readonly onSaved: (message: string) => void;
  readonly order: Order;
  readonly products: readonly ProductRecord[];
  readonly revision: number;
}

/**
 * Admin edit of a DEMO order. Sends one EditOrder command with only the changed parts; the server recomputes the
 * totals and writes a before/after history entry per changed area. The price list never changes; when the order
 * already took goods from stock, quantity changes write the matching ORDER movements.
 */
export const OrderEditForm = ({ movesStock, onCancel, onSaved, order, products, revision }: OrderEditFormProps) => {
  const [draft, setDraft] = useState<Draft>(() => draftOf(order));
  const [sequence, setSequence] = useState(0);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const gross = order.pricesIncludeVat === true;
  const units = sellableUnits(products);
  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));
  const patchLine = (key: string, next: Partial<DraftLine>) =>
    patch({ lines: draft.lines.map((line) => (line.key === key ? { ...line, ...next } : line)) });

  const rulesFor = (line: Pick<DraftLine, 'productId' | 'variantId'>) => {
    const product = products.find((entry) => entry.id === line.productId);
    const unit =
      line.variantId === undefined ? product : product?.variantRecords?.find((entry) => entry.id === line.variantId);
    return orderQuantityRules(unit ?? { stockOnHand: 1_000_000 });
  };
  const parsedLines = draft.lines.map((line) => {
    const quantity = parseQuantity(line.quantityText);
    const original = order.lines.find(
      (entry) => entry.productId === line.productId && entry.variantId === line.variantId,
    );
    const rules = rulesFor(line);
    const valid = quantity !== null && (quantity === original?.quantity || isOrderQuantityValid(quantity, rules));
    return { line, price: parseCzk(line.priceText), quantity: valid ? quantity : null, rules };
  });
  const linesInvalid =
    draft.lines.length === 0 || parsedLines.some((entry) => entry.price === null || entry.quantity === null);
  const shippingPrice = parseCzk(draft.shippingPriceText);
  const shippingInvalid = draft.shippingMethod !== null && shippingPrice === null;
  const addressTouched = !sameAddress(order, draft);
  const addressInvalid =
    addressTouched && [draft.street, draft.city, draft.postalCode].some((value) => value.trim() === '');
  const contactTouched = !sameContact(order, draft);
  const contactInvalid =
    contactTouched && (draft.name.trim() === '' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(draft.email.trim()));

  const previewLines = parsedLines.flatMap(({ line, price, quantity }) =>
    price === null || quantity === null ? [] : [{ quantity, unitPriceMinor: price, vatRate: line.vatRate }],
  );
  const previewShipping =
    draft.shippingMethod === null || shippingPrice === null
      ? undefined
      : { label: '', method: draft.shippingMethod, priceMinor: shippingPrice, vatRate: 21 as const };
  const preview = fullOrderTotals({
    lines: previewLines.map((line) => ({ ...line, productId: '' as ProductId, productName: '', sku: '' })),
    pricesIncludeVat: order.pricesIncludeVat,
    ...(previewShipping === undefined ? {} : { shipping: previewShipping }),
  });

  const buildCommand = (): EditCommand | null => {
    const lines = parsedLines.map(({ line, price, quantity }) => ({
      productId: line.productId,
      quantity: quantity ?? 1,
      unitPriceMinor: price ?? 0,
      ...(line.variantId === undefined ? {} : { variantId: line.variantId }),
    }));
    const original = order.lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      ...(line.variantId === undefined ? {} : { variantId: line.variantId }),
    }));
    const linesChanged = JSON.stringify(lines) !== JSON.stringify(original);
    const shippingChanged =
      draft.shippingMethod !== null &&
      shippingPrice !== null &&
      (draft.shippingMethod !== order.shipping?.method || shippingPrice !== order.shipping.priceMinor);
    const noteChanged = draft.note.trim() !== (order.note ?? '');
    const reason = draft.reason.trim();
    const command: EditCommand = {
      _tag: 'EditOrder',
      expectedUpdatedAt: order.updatedAt,
      id: order.id,
      ...(linesChanged ? { lines } : {}),
      ...(shippingChanged && draft.shippingMethod !== null && shippingPrice !== null
        ? { shipping: { method: draft.shippingMethod, priceMinor: shippingPrice } }
        : {}),
      ...(addressTouched
        ? {
            deliveryAddress: {
              city: draft.city.trim(),
              postalCode: draft.postalCode.trim(),
              street: draft.street.trim(),
              ...(draft.country.trim() === '' ? {} : { country: draft.country.trim() }),
            },
          }
        : {}),
      ...(contactTouched
        ? {
            contact: {
              email: draft.email.trim(),
              name: draft.name.trim(),
              ...(draft.phone.trim() === '' ? {} : { phone: draft.phone.trim() }),
            },
          }
        : {}),
      ...(noteChanged ? { note: draft.note.trim() } : {}),
      ...(reason === '' ? {} : { reason }),
    };
    return linesChanged || shippingChanged || addressTouched || contactTouched || noteChanged ? command : null;
  };

  const save = () => {
    setSubmitted(true);
    if (linesInvalid || shippingInvalid || addressInvalid || contactInvalid || busy) {
      const invalid = parsedLines.find((entry) => entry.quantity === null || entry.price === null);
      if (invalid !== undefined) {
        const field = document.getElementById(
          `edit-${invalid.quantity === null ? 'qty' : 'price'}-${invalid.line.key}`,
        );
        field?.scrollIntoView({ block: 'center' });
        field?.focus();
      }
      return;
    }
    const command = buildCommand();
    if (command === null) {
      onCancel();
      return;
    }
    setBusy(true);
    setServerError(null);
    void browserRuntime.runPromise(
      editOrder(command, revision).pipe(
        Effect.match({
          onFailure: (error) => {
            setBusy(false);
            setServerError(
              isRevisionConflict(error)
                ? 'Tuto objednávku mezitím změnil někdo jiný. Zavřete úpravy, načtěte data znovu a změnu zopakujte.'
                : 'Změnu se nepodařilo uložit. Nic nebylo změněno, zkuste to prosím znovu.',
            );
          },
          onSuccess: () => {
            setBusy(false);
            onSaved(`Objednávka ${order.number} upravena — změna je zapsána v historii`);
          },
        }),
      ),
    );
  };

  const addLine = () => {
    const unit = units.find((entry) => entry.value === pick);
    if (unit === undefined) {
      return;
    }
    const existing = draft.lines.find((line) => line.productId === unit.productId && line.variantId === unit.variantId);
    if (existing !== undefined) {
      const quantity = parseQuantity(existing.quantityText) ?? 0;
      patchLine(existing.key, { quantityText: String(quantity + rulesFor(existing).step) });
      setPick(null);
      return;
    }
    const unitPrice = gross ? grossUnitPriceMinor(unit.netMinor, unit.vatRate) : unit.netMinor;
    patch({
      lines: [
        ...draft.lines,
        {
          key: `new-${sequence}`,
          name: unit.name,
          priceText: moneyInputText(unitPrice / 100),
          productId: unit.productId,
          quantityText: String(Math.ceil(rulesFor(unit).minimum / rulesFor(unit).step) * rulesFor(unit).step),
          sku: unit.sku,
          ...(unit.variantId === undefined ? {} : { variantId: unit.variantId }),
          ...(unit.variantName === undefined ? {} : { variantName: unit.variantName }),
          vatRate: unit.vatRate,
        },
      ],
    });
    setSequence(sequence + 1);
    setPick(null);
  };

  const akros = products.some((product) => product.sourceGroupId !== undefined);
  const methodItems = shippingOptions.map((option) => ({
    label: `${shippingMethodFor(option.method, akros).label} · ${formatMoney(option.priceMinor)}`,
    value: option.method,
  }));

  return (
    <form
      className="flex flex-col gap-250"
      id="order-edit-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <p className="text-fg-secondary text-sm">
        Úprava DEMO objednávky. Součty přepočítá server, změna se zapíše do historie s autorem a časem. Ceník se
        nemění.{' '}
        {movesStock
          ? 'Objednávka už zboží odepsala ze skladu: přidané kusy se ze skladu odepíšou, ubrané se vrátí (uvidíte je v Pohybech produktu).'
          : 'Tato objednávka sklad neodepsala, změna množství zásoby nemění.'}
      </p>
      <SectionCard flush title="Položky">
        <div role="region" aria-label="Položky objednávky" tabIndex={0} style={{ overflowX: 'auto' }}>
          <Table size="sm" variant="line">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Položka</Table.ColumnHeader>
                <Table.ColumnHeader align="end">Množství</Table.ColumnHeader>
                <Table.ColumnHeader align="end">
                  {gross ? 'Cena/j s DPH (Kč)' : 'Cena/j bez DPH (Kč)'}
                </Table.ColumnHeader>
                <Table.ColumnHeader align="end">Celkem s DPH</Table.ColumnHeader>
                <Table.ColumnHeader align="end">
                  <span className="sr-only">Akce</span>
                </Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {parsedLines.map(({ line, price, quantity, rules }) => (
                <Table.Row key={line.key}>
                  <Table.Cell>
                    <div className="flex min-w-32 flex-col">
                      <span className="font-medium">{line.name}</span>
                      <span className="text-fg-secondary text-xs">
                        {line.variantName === undefined ? line.sku : `${line.variantName} · ${line.sku}`}
                      </span>
                    </div>
                  </Table.Cell>
                  <Table.Cell align="end">
                    <div className="ml-auto" style={{ minWidth: 100 }}>
                      <FormNumericInput
                        formatOptions={{ maximumFractionDigits: 6 }}
                        id={`edit-qty-${line.key}`}
                        label={<span className="sr-only">Množství</span>}
                        locale="cs-CZ"
                        min={rules.minimum}
                        name={`qty-${line.key}`}
                        onValueChange={(details) => patchLine(line.key, { quantityText: details.value })}
                        size="sm"
                        step={rules.step}
                        clampValueOnBlur={false}
                        value={line.quantityText}
                        {...(submitted && quantity === null
                          ? {
                              helpText: `Minimum ${rules.minimum.toLocaleString('cs-CZ')}, balení po ${rules.step.toLocaleString('cs-CZ')}, dostupné ${rules.maximum.toLocaleString('cs-CZ')}`,
                              validateStatus: 'error' as const,
                            }
                          : {})}
                      >
                        <NumericInput.Control>
                          <NumericInput.Input aria-valuemax={undefined} />
                        </NumericInput.Control>
                      </FormNumericInput>
                    </div>
                  </Table.Cell>
                  <Table.Cell align="end">
                    <div className="ml-auto w-24">
                      <FormNumericInput
                        formatOptions={MONEY_FORMAT}
                        id={`edit-price-${line.key}`}
                        label={<span className="sr-only">Cena za jednotku</span>}
                        locale="cs-CZ"
                        min={0}
                        name={`price-${line.key}`}
                        onValueChange={(details) => patchLine(line.key, { priceText: details.value })}
                        size="sm"
                        value={line.priceText}
                        {...(submitted && price === null
                          ? { helpText: 'Zadejte cenu', validateStatus: 'error' as const }
                          : {})}
                      >
                        <NumericInput.Control>
                          <NumericInput.Input />
                        </NumericInput.Control>
                      </FormNumericInput>
                    </div>
                  </Table.Cell>
                  <Table.Cell align="end" className="tabular-nums">
                    {price === null || quantity === null
                      ? '—'
                      : formatMoney(
                          lineGrossMinor(
                            { quantity, unitPriceMinor: price, vatRate: line.vatRate },
                            order.pricesIncludeVat,
                          ),
                        )}
                  </Table.Cell>
                  <Table.Cell align="end">
                    <Button
                      aria-label={`Odebrat ${line.name}`}
                      disabled={draft.lines.length <= 1}
                      icon="icon-[mdi--delete-outline]"
                      onClick={() => patch({ lines: draft.lines.filter((entry) => entry.key !== line.key) })}
                      size="sm"
                      theme="borderless"
                      type="button"
                      variant="secondary"
                    />
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-150 p-200">
          <Combobox
            clearable={false}
            items={units.map((unit) => ({ id: unit.value, label: unit.label, value: unit.value }))}
            label="Přidat položku"
            noResultsMessage="Žádný produkt neodpovídá."
            onChange={(values) => {
              const next = Array.isArray(values) ? values[0] : values;
              setPick(next ?? null);
            }}
            placeholder="Hledat produkt nebo variantu…"
            translations={comboboxTranslations}
            value={pick === null ? [] : [pick]}
          />
          <Button
            disabled={pick === null}
            icon="icon-[mdi--plus]"
            onClick={addLine}
            theme="outlined"
            type="button"
            variant="secondary"
          >
            Přidat
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Doprava (simulace)">
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <SelectTemplate
            items={methodItems}
            label="Způsob dopravy"
            name="shippingMethod"
            onValueChange={(details) => {
              const [next] = details.value;
              const method = shippingOptions.find((option) => option.method === next);
              if (method !== undefined) {
                patch({
                  shippingMethod: method.method,
                  shippingPriceText: moneyInputText(shippingMethods[method.method].grossPriceMinor / 100),
                });
              }
            }}
            placeholder="Vyberte dopravu"
            size="sm"
            value={draft.shippingMethod === null ? [] : [draft.shippingMethod]}
          />
          <FormNumericInput
            formatOptions={MONEY_FORMAT}
            id="edit-shipping-price"
            label="Cena dopravy s DPH (Kč)"
            locale="cs-CZ"
            min={0}
            name="shippingPrice"
            onValueChange={(details) => patch({ shippingPriceText: details.value })}
            size="sm"
            value={draft.shippingPriceText}
            {...(submitted && shippingInvalid ? { helpText: 'Zadejte cenu', validateStatus: 'error' as const } : {})}
          >
            <NumericInput.Control>
              <NumericInput.Input />
            </NumericInput.Control>
          </FormNumericInput>
        </div>
      </SectionCard>

      <SectionCard title="Doručovací adresa">
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <FormInput
            id="edit-street"
            label="Ulice a číslo"
            name="street"
            onChange={(event) => patch({ street: event.target.value })}
            value={draft.street}
          />
          <FormInput
            id="edit-city"
            label="Město"
            name="city"
            onChange={(event) => patch({ city: event.target.value })}
            value={draft.city}
          />
          <FormInput
            id="edit-postal"
            label="PSČ"
            name="postalCode"
            onChange={(event) => patch({ postalCode: event.target.value })}
            value={draft.postalCode}
          />
          <FormInput
            id="edit-country"
            label="Země"
            name="country"
            onChange={(event) => patch({ country: event.target.value })}
            value={draft.country}
          />
        </div>
        {submitted && addressInvalid && (
          <StatusText showIcon status="error">
            Vyplňte ulici, město i PSČ.
          </StatusText>
        )}
      </SectionCard>

      <SectionCard title="Kontakt zákazníka (fiktivní údaje)">
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-3">
          <FormInput
            id="edit-name"
            label="Jméno"
            name="name"
            onChange={(event) => patch({ name: event.target.value })}
            value={draft.name}
          />
          <FormInput
            id="edit-email"
            label="E-mail"
            name="email"
            onChange={(event) => patch({ email: event.target.value })}
            type="email"
            value={draft.email}
          />
          <FormInput
            id="edit-phone"
            label="Telefon"
            name="phone"
            onChange={(event) => patch({ phone: event.target.value })}
            value={draft.phone}
          />
        </div>
        {submitted && contactInvalid && (
          <StatusText showIcon status="error">
            Zadejte jméno a platný e-mail.
          </StatusText>
        )}
      </SectionCard>

      <FormTextarea
        id="edit-note"
        label="Poznámka k objednávce"
        maxLength={1000}
        name="note"
        onChange={(event) => patch({ note: event.target.value })}
        value={draft.note}
      />
      <FormInput
        id="edit-reason"
        label="Důvod změny (zapíše se do historie)"
        maxLength={500}
        name="reason"
        onChange={(event) => patch({ reason: event.target.value })}
        placeholder="Např. zákazník telefonicky změnil množství"
        value={draft.reason}
      />

      <div className="flex flex-wrap items-center justify-between gap-150 rounded-md border border-border-primary p-200">
        <div className="flex flex-col">
          <span className="text-fg-secondary text-sm">Náhled celkové částky s DPH (přepočte server)</span>
          <span className="font-semibold text-lg tabular-nums">
            {linesInvalid ? 'Zkontrolujte množství a ceny položek' : formatMoney(preview.totalMinor)}
          </span>
        </div>
        <div className="flex gap-150">
          <Button disabled={busy} onClick={onCancel} theme="outlined" type="button" variant="secondary">
            Zrušit úpravy
          </Button>
          <Button isLoading={busy} loadingText="Ukládám…" type="submit" variant="primary">
            Uložit změny
          </Button>
        </div>
      </div>
      {serverError !== null && (
        <StatusText showIcon status="error">
          {serverError}
        </StatusText>
      )}
    </form>
  );
};
