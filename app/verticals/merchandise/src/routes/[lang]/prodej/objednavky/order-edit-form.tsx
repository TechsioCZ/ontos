import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { formatMoney, SectionCard, surfaceTileClassName } from '@app/admin-ui';
import { Effect } from 'effect';
import { useRef, useState } from 'react';
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
import { activeVariants } from './order-line-editor.tsx';
import { loadProductRecord } from '../../provoz/produkty/product-reads.ts';
import type { ProductRecordState } from '../../provoz/produkty/product-reads.ts';
import { ProductSearchCombobox } from '../../provoz/produkty/product-search.tsx';

type EditCommand = Extract<MerchandiseCommand, { readonly _tag: 'EditOrder' }>;
type EditLine = NonNullable<EditCommand['lines']>[number];
type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

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
  const normalized = text.replaceAll(/\s/gu, '').replace(',', '.');
  if (normalized === '') {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
};

const parseQuantity = (text: string): number | null => {
  const value = Number(text.replaceAll(/\s/gu, '').replace(',', '.'));
  return Number.isFinite(value) && value > 0 && value <= 1_000_000 ? value : null;
};

const draftLineOf = (line: Order['lines'][number], index: number): DraftLine => {
  const draft: Mutable<DraftLine> = {
    key: `existing-${index}`,
    name: line.productName,
    priceText: moneyInputText(line.unitPriceMinor / 100),
    productId: line.productId,
    quantityText: String(line.quantity),
    sku: line.sku,
    vatRate: line.vatRate,
  };
  if (line.variantId !== undefined) {
    draft.variantId = line.variantId;
  }
  if (line.variantName !== undefined) {
    draft.variantName = line.variantName;
  }
  return draft;
};

const draftOf = (order: Order): Draft => ({
  city: order.deliveryAddress?.city ?? '',
  country: order.deliveryAddress?.country ?? '',
  email: order.contact?.email ?? '',
  lines: order.lines.map((line, index) => draftLineOf(line, index)),
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
  readonly name: string;
  readonly netMinor: number;
  readonly productId: ProductId;
  readonly sku: string;
  readonly variantId?: VariantId;
  readonly variantName?: string;
  readonly vatRate: DraftLine['vatRate'];
}

/** The unit a pick adds: the product itself, or its chosen active variant. Undefined until that choice is complete. */
const sellableUnit = (product: ProductRecord, variantId: VariantId | null): SellableUnit | undefined => {
  const variants = activeVariants(product);
  if (variants.length === 0) {
    return {
      name: product.name,
      netMinor: product.currentPriceMinor,
      productId: product.id,
      sku: product.sku,
      vatRate: product.vatRate,
    };
  }
  const variant = variants.find((entry) => entry.id === variantId);
  return variant === undefined
    ? undefined
    : {
        name: product.name,
        netMinor: variant.priceMinor,
        productId: product.id,
        sku: variant.sku,
        variantId: variant.id,
        variantName: variant.name,
        vatRate: product.vatRate,
      };
};

const sameAddress = (order: Order, draft: Draft) =>
  (order.deliveryAddress?.street ?? '') === draft.street.trim() &&
  (order.deliveryAddress?.city ?? '') === draft.city.trim() &&
  (order.deliveryAddress?.postalCode ?? '') === draft.postalCode.trim() &&
  (order.deliveryAddress?.country ?? '') === draft.country.trim();

const sameContact = (order: Order, draft: Draft) =>
  (order.contact?.name ?? '') === draft.name.trim() &&
  (order.contact?.email ?? '') === draft.email.trim() &&
  (order.contact?.phone ?? '') === draft.phone.trim();

interface ParsedLine {
  readonly line: DraftLine;
  readonly price: number | null;
  readonly quantity: number | null;
}

const previewTotals = (
  order: Order,
  parsedLines: readonly ParsedLine[],
  shippingMethod: ShippingMethod | null,
  shippingPrice: number | null,
) => {
  const input: Mutable<Parameters<typeof fullOrderTotals>[0]> = {
    lines: parsedLines.flatMap(({ line, price, quantity }) =>
      price === null || quantity === null
        ? []
        : [
            {
              productId: line.productId,
              productName: '',
              quantity,
              sku: '',
              unitPriceMinor: price,
              vatRate: line.vatRate,
            },
          ],
    ),
    pricesIncludeVat: order.pricesIncludeVat,
  };
  if (shippingMethod !== null && shippingPrice !== null) {
    input.shipping = { label: '', method: shippingMethod, priceMinor: shippingPrice, vatRate: 21 };
  }
  return fullOrderTotals(input);
};

const editLineOf = (
  productId: ProductId,
  quantity: number,
  unitPriceMinor: number,
  variantId: VariantId | undefined,
): EditLine => {
  const line: Mutable<EditLine> = { productId, quantity, unitPriceMinor };
  if (variantId !== undefined) {
    line.variantId = variantId;
  }
  return line;
};

const editAddress = (draft: Draft): NonNullable<EditCommand['deliveryAddress']> => {
  const address: Mutable<NonNullable<EditCommand['deliveryAddress']>> = {
    city: draft.city.trim(),
    postalCode: draft.postalCode.trim(),
    street: draft.street.trim(),
  };
  if (draft.country.trim() !== '') {
    address.country = draft.country.trim();
  }
  return address;
};

const editContact = (draft: Draft): NonNullable<EditCommand['contact']> => {
  const contact: Mutable<NonNullable<EditCommand['contact']>> = { email: draft.email.trim(), name: draft.name.trim() };
  if (draft.phone.trim() !== '') {
    contact.phone = draft.phone.trim();
  }
  return contact;
};

const editCommandOf = (
  order: Order,
  draft: Draft,
  parsedLines: readonly ParsedLine[],
  shippingPrice: number | null,
  addressTouched: boolean,
  contactTouched: boolean,
): EditCommand | null => {
  const lines = parsedLines.map(({ line, price, quantity }) =>
    editLineOf(line.productId, quantity ?? 1, price ?? 0, line.variantId),
  );
  const original = order.lines.map((line) =>
    editLineOf(line.productId, line.quantity, line.unitPriceMinor, line.variantId),
  );
  const linesChanged =
    lines.length !== original.length ||
    lines.some((line, index) => {
      const previous = original[index];
      return (
        previous === undefined ||
        line.productId !== previous.productId ||
        line.quantity !== previous.quantity ||
        line.unitPriceMinor !== previous.unitPriceMinor ||
        line.variantId !== previous.variantId
      );
    });
  const shippingChanged =
    draft.shippingMethod !== null &&
    shippingPrice !== null &&
    (draft.shippingMethod !== order.shipping?.method || shippingPrice !== order.shipping.priceMinor);
  const noteChanged = draft.note.trim() !== (order.note ?? '');
  const reason = draft.reason.trim();
  const command: Mutable<EditCommand> = { _tag: 'EditOrder', expectedUpdatedAt: order.updatedAt, id: order.id };
  if (linesChanged) {
    command.lines = lines;
  }
  if (shippingChanged && draft.shippingMethod !== null && shippingPrice !== null) {
    command.shipping = { method: draft.shippingMethod, priceMinor: shippingPrice };
  }
  if (addressTouched) {
    command.deliveryAddress = editAddress(draft);
  }
  if (contactTouched) {
    command.contact = editContact(draft);
  }
  if (noteChanged) {
    command.note = draft.note.trim();
  }
  if (reason !== '') {
    command.reason = reason;
  }
  return linesChanged || shippingChanged || addressTouched || contactTouched || noteChanged ? command : null;
};

interface OrderEditFormProps {
  /** The order wrote ORDER stock movements; quantity edits then move stock the same way. */
  readonly movesStock: boolean;
  readonly onCancel: () => void;
  readonly onSaved: (message: string) => void;
  readonly order: Order;
  /** Full records of the products on the order's lines. */
  readonly products: readonly ProductRecord[];
  readonly revision: number;
}

/**
 * Admin edit of a DEMO order. Sends one EditOrder command with only the changed parts; the server recomputes the
 * totals and writes a before/after history entry per changed area. The price list never changes; when the order
 * already took goods from stock, quantity changes write the matching ORDER movements.
 */
const useOrderEditForm = ({ movesStock, onCancel, onSaved, order, products, revision }: OrderEditFormProps) => {
  const { t } = useModernI18n();
  const [draft, setDraft] = useState<Draft>(() => draftOf(order));
  const sequence = useRef(0);
  // The product picked for a new line, with its full record (variants) read on pick.
  const [pick, setPick] = useState<{
    readonly product: Pick<ProductRecord, 'id' | 'name' | 'sku'>;
    readonly record: ProductRecordState;
  } | null>(null);
  const [pickedVariantId, setPickedVariantId] = useState<VariantId | null>(null);
  // Products added in this edit, so their quantity rules are known next to the order's own line products.
  const [addedProducts, setAddedProducts] = useState<readonly ProductRecord[]>([]);
  const pickedProduct = pick?.record.status === 'ready' ? pick.record.product : null;
  const pickProduct = (next: Pick<ProductRecord, 'id' | 'name' | 'sku'> | null) => {
    setPickedVariantId(null);
    setPick(next === null ? null : { product: next, record: { status: 'loading' } });
    if (next !== null) {
      // A record that arrives after another pick is dropped.
      loadProductRecord(next.id, (record) =>
        setPick((current) => (current?.product.id === next.id ? { ...current, record } : current)),
      );
    }
  };
  const pickedVariants = activeVariants(pickedProduct);
  const unit = pickedProduct === null ? undefined : sellableUnit(pickedProduct, pickedVariantId);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const gross = order.pricesIncludeVat === true;
  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));
  const patchLine = (key: string, next: Partial<DraftLine>) =>
    patch({ lines: draft.lines.map((line) => (line.key === key ? { ...line, ...next } : line)) });

  const rulesFor = (line: Pick<DraftLine, 'productId' | 'variantId'>) => {
    const product = [...products, ...addedProducts].find((entry) => entry.id === line.productId);
    const stockUnit =
      line.variantId === undefined ? product : product?.variantRecords?.find((entry) => entry.id === line.variantId);
    const original = order.lines.find(
      (entry) => entry.productId === line.productId && entry.variantId === line.variantId,
    );
    return orderQuantityRules(stockUnit ?? { stockOnHand: 1_000_000 }, movesStock ? (original?.quantity ?? 0) : 0);
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

  const preview = previewTotals(order, parsedLines, draft.shippingMethod, shippingPrice);

  const buildCommand = () => editCommandOf(order, draft, parsedLines, shippingPrice, addressTouched, contactTouched);

  const save = () => {
    setSubmitted(true);
    if (linesInvalid || shippingInvalid || addressInvalid || contactInvalid || busy) {
      const invalid = parsedLines.find((entry) => entry.quantity === null || entry.price === null);
      if (invalid !== undefined) {
        const field = document.querySelector<HTMLElement>(
          `[id="edit-${invalid.quantity === null ? 'qty' : 'price'}-${invalid.line.key}"]`,
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

  const clearPick = () => pickProduct(null);
  const addLine = () => {
    if (unit === undefined || pickedProduct === null) {
      return;
    }
    setAddedProducts((current) => [...current.filter((entry) => entry.id !== pickedProduct.id), pickedProduct]);
    const existing = draft.lines.find((line) => line.productId === unit.productId && line.variantId === unit.variantId);
    if (existing !== undefined) {
      const quantity = parseQuantity(existing.quantityText) ?? 0;
      patchLine(existing.key, { quantityText: String(quantity + rulesFor(existing).step) });
      clearPick();
      return;
    }
    const rules = orderQuantityRules(
      unit.variantId === undefined
        ? pickedProduct
        : (pickedProduct.variantRecords?.find((entry) => entry.id === unit.variantId) ?? pickedProduct),
    );
    const unitPrice = gross ? grossUnitPriceMinor(unit.netMinor, unit.vatRate) : unit.netMinor;
    const line: Mutable<DraftLine> = {
      key: `new-${sequence.current}`,
      name: unit.name,
      priceText: moneyInputText(unitPrice / 100),
      productId: unit.productId,
      quantityText: String(Math.ceil(rules.minimum / rules.step) * rules.step),
      sku: unit.sku,
      vatRate: unit.vatRate,
    };
    if (unit.variantId !== undefined) {
      line.variantId = unit.variantId;
    }
    if (unit.variantName !== undefined) {
      line.variantName = unit.variantName;
    }
    patch({ lines: [...draft.lines, line] });
    sequence.current += 1;
    clearPick();
  };

  const akros = products.some((product) => product.sourceGroupId !== undefined);
  const methodItems = shippingOptions.map((option) => ({
    label: `${shippingMethodFor(option.method, akros).label} · ${formatMoney(option.priceMinor)}`,
    value: option.method,
  }));

  return {
    addLine,
    addressInvalid,
    busy,
    contactInvalid,
    draft,
    gross,
    linesInvalid,
    methodItems,
    movesStock,
    onCancel,
    order,
    parsedLines,
    patch,
    patchLine,
    pick,
    pickedVariantId,
    pickedVariants,
    pickProduct,
    preview,
    save,
    serverError,
    setPickedVariantId,
    shippingInvalid,
    submitted,
    t,
    unit,
  };
};

const renderOrderShipping = ({
  draft,
  methodItems,
  patch,
  shippingInvalid,
  submitted,
  t,
}: ReturnType<typeof useOrderEditForm>) => (
  <SectionCard title={t('merchandise.ui.shipping')}>
    <div className="grid grid-cols-1 gap-200 sm:grid-cols-[minmax(0,1fr)_10rem]">
      <SelectTemplate
        items={methodItems}
        label={t('merchandise.ui.shippingMethod')}
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
        placeholder={t('merchandise.ui.selectShipping')}
        size="sm"
        value={draft.shippingMethod === null ? [] : [draft.shippingMethod]}
      />
      <FormNumericInput
        formatOptions={MONEY_FORMAT}
        id="edit-shipping-price"
        label={t('merchandise.ui.shippingPriceInclVat')}
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
);

const renderOrderAddress = ({ addressInvalid, draft, patch, submitted, t }: ReturnType<typeof useOrderEditForm>) => (
  <SectionCard title={t('merchandise.ui.deliveryAddress')}>
    <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
      <FormInput
        id="edit-street"
        label={t('merchandise.ui.streetNumber')}
        name="street"
        onChange={(event) => patch({ street: event.target.value })}
        value={draft.street}
      />
      <FormInput
        id="edit-city"
        label={t('merchandise.ui.city')}
        name="city"
        onChange={(event) => patch({ city: event.target.value })}
        value={draft.city}
      />
      <FormInput
        id="edit-postal"
        label={t('merchandise.ui.postalCode')}
        name="postalCode"
        onChange={(event) => patch({ postalCode: event.target.value })}
        value={draft.postalCode}
      />
      <FormInput
        id="edit-country"
        label={t('merchandise.ui.country')}
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
);

const renderOrderContact = ({ contactInvalid, draft, patch, submitted, t }: ReturnType<typeof useOrderEditForm>) => (
  <SectionCard title={t('merchandise.ui.demoCustomerContact')}>
    <div className="grid grid-cols-1 gap-200 sm:grid-cols-3">
      <FormInput
        id="edit-name"
        label={t('merchandise.ui.contactName')}
        name="name"
        onChange={(event) => patch({ name: event.target.value })}
        value={draft.name}
      />
      <FormInput
        id="edit-email"
        label={t('merchandise.ui.email')}
        name="email"
        onChange={(event) => patch({ email: event.target.value })}
        type="email"
        value={draft.email}
      />
      <FormInput
        id="edit-phone"
        label={t('merchandise.ui.phone')}
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
);

export const OrderEditForm = (props: OrderEditFormProps) => {
  const model = useOrderEditForm(props);
  const {
    addLine,
    busy,
    draft,
    gross,
    linesInvalid,
    movesStock,
    onCancel,
    order,
    parsedLines,
    patch,
    patchLine,
    pick,
    pickedVariantId,
    pickedVariants,
    pickProduct,
    preview,
    save,
    serverError,
    setPickedVariantId,
    submitted,
    t,
    unit,
  } = model;

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
        Úprava DEMO objednávky. Součty přepočítá server, změna se zapíše do historie s autorem a časem. Ceník se nemění.{' '}
        {movesStock
          ? 'Objednávka už zboží odepsala ze skladu: přidané kusy se ze skladu odepíšou, ubrané se vrátí (uvidíte je v Pohybech produktu).'
          : 'Tato objednávka sklad neodepsala, změna množství zásoby nemění.'}
      </p>
      <SectionCard flush title={t('merchandise.ui.items')}>
        {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Pending scoped exception approval: this named overflow viewport needs keyboard scrolling. */}
        <section aria-label={t('merchandise.ui.orderItems')} style={{ overflowX: 'auto' }} tabIndex={0}>
          {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
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
                        clampValueOnBlur={false}
                        formatOptions={{ maximumFractionDigits: 6 }}
                        id={`edit-qty-${line.key}`}
                        label={<span className="sr-only">Množství</span>}
                        locale="cs-CZ"
                        min={rules.minimum}
                        name={`qty-${line.key}`}
                        onValueChange={(details) => patchLine(line.key, { quantityText: details.value })}
                        size="sm"
                        step={rules.step}
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
        </section>
        <div className="flex flex-col gap-150 p-200">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-150">
            <ProductSearchCombobox
              activeOnly
              errorMessage="Produkty se nepodařilo načíst."
              id="order-edit-add-product"
              label={t('merchandise.ui.addItem')}
              loadingMessage="Načítám…"
              noResultsMessage="Žádný produkt neodpovídá."
              onSelect={pickProduct}
              placeholder={t('merchandise.ui.searchProduct')}
              retryLabel="Zkusit znovu"
              selected={pick?.product ?? null}
            />
            <Button
              disabled={unit === undefined}
              icon="icon-[mdi--plus]"
              onClick={addLine}
              theme="outlined"
              type="button"
              variant="secondary"
            >
              Přidat
            </Button>
          </div>
          {pickedVariants.length > 0 && (
            <SelectTemplate
              items={pickedVariants.map((entry) => ({ label: `${entry.name} (${entry.sku})`, value: entry.id }))}
              label={t('merchandise.ui.variant')}
              name="order-edit-add-variant"
              onValueChange={(details) => {
                const [next] = details.value;
                setPickedVariantId(pickedVariants.find((entry) => entry.id === next)?.id ?? null);
              }}
              placeholder={t('merchandise.ui.selectVariant')}
              size="sm"
              value={pickedVariantId === null ? [] : [pickedVariantId]}
            />
          )}
          {pick?.record.status === 'error' && (
            <StatusText showIcon status="error">
              Produkt se nepodařilo načíst. Vyberte ho znovu.
            </StatusText>
          )}
        </div>
      </SectionCard>

      {renderOrderShipping(model)}

      {renderOrderAddress(model)}

      {renderOrderContact(model)}

      <FormTextarea
        id="edit-note"
        label={t('merchandise.ui.orderNote')}
        maxLength={1000}
        name="note"
        onChange={(event) => patch({ note: event.target.value })}
        value={draft.note}
      />
      <FormInput
        id="edit-reason"
        label={t('merchandise.ui.changeReason')}
        maxLength={500}
        name="reason"
        onChange={(event) => patch({ reason: event.target.value })}
        placeholder={t('merchandise.ui.changeReasonPlaceholder')}
        value={draft.reason}
      />

      <div className={`${surfaceTileClassName} flex flex-wrap items-center justify-between gap-150 p-200`}>
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
