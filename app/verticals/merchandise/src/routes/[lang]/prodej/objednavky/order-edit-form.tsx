import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput, FormNumericInput, FormTextarea } from '@app/admin-ui/form-controls';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { selectItem } from '../../../../ui/select-item.ts';
import {
  formatMoney,
  SaveBar,
  saveLabelsFor,
  ScrollRegion,
  SectionCard,
  surfaceTileClassName,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Order, ProductRecord } from '../../../../../shared/apis/records.ts';
import type { ProductId, ShippingMethod, VariantId } from '../../../../../shared/domain/merchandise-model.ts';
import { convertGrossMinor } from '../../../../../shared/domain/market-offers.ts';
import {
  grossUnitPriceMinor,
  orderCurrency,
  shippingMethodFor,
  shippingMethods,
} from '../../../../../shared/domain/merchandise-model.ts';
import { isOrderQuantityValid, orderQuantityRules } from '../../../../../shared/domain/order-quantity.ts';
import { fullOrderTotals, lineGrossMinor } from '../../../../../shared/domain/order-totals.ts';
import { MONEY_FORMAT, moneyInputText } from '../../../../form-number.ts';
import { shippingOptions } from './order-eshop.ts';
import { addressIncomplete, contactIncomplete, parseAmount, parseQuantity } from './order-edit-draft.ts';
import type { Draft, DraftLine } from './order-edit-draft.ts';
import { useOrderEditDraft } from './order-edit-save.ts';
import { activeVariants } from './order-line-draft.ts';
import { loadProductRecord } from '../../provoz/produkty/product-reads.ts';
import type { ProductRecordState } from '../../provoz/produkty/product-reads.ts';
import { ProductSearchCombobox } from '../../provoz/produkty/product-search.tsx';

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

/** A catalog CZK amount in the order's currency: market orders keep their own price list (as the server reprices). */
const inOrderCurrency = (order: Pick<Order, 'market'>, czkMinor: number): number =>
  order.market === undefined ? czkMinor : convertGrossMinor(czkMinor, order.market);

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

interface OrderEditFormProps {
  /**
   * Where the form's actions (back to the detail, the save bar) go when its host has a footer of its own: the side
   * panel's footer. `null` while that footer is not on screen yet; left out, the actions sit in the form's own footer.
   */
  readonly actionsSlot?: HTMLElement | null | undefined;
  /** The order wrote ORDER stock movements; quantity edits then move stock the same way. */
  readonly movesStock: boolean;
  readonly onCancel: () => void;
  readonly onSaved: (message: string) => void;
  readonly order: Order;
  /** The e-shop brand that names personal pickup of this company's orders (`shippingMethodFor`). */
  readonly pickupBrand?: string | undefined;
  /** Full records of the products on the order's lines. */
  readonly products: readonly ProductRecord[];
  readonly revision: number;
}

/**
 * Admin edit of a DEMO order. Sends one EditOrder command with only the changed parts; the server recomputes the
 * totals and writes a before/after history entry per changed area. The price list never changes; when the order
 * already took goods from stock, quantity changes write the matching ORDER movements.
 *
 * Editing changes only the draft on screen: the Save button sends it, and every way out of the form asks first
 * while something is unsaved. The form stays mounted while the order reloads. `useOrderEditDraft` owns the draft: an
 * untouched draft takes the reloaded order, a changed one stays and saves against the order version it was typed over.
 */
const useOrderEditForm = ({
  movesStock,
  onCancel,
  onSaved,
  order,
  pickupBrand,
  products,
  revision,
}: OrderEditFormProps) => {
  const { language, t } = useModernI18n();
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
  const gross = order.pricesIncludeVat === true;
  const currencyUnit = t(`merchandise.ui.currencyUnit.${orderCurrency(order)}`);
  const rulesFor = (line: Pick<DraftLine, 'productId' | 'variantId'>) => {
    const product = [...products, ...addedProducts].find((entry) => entry.id === line.productId);
    const stockUnit =
      line.variantId === undefined ? product : product?.variantRecords?.find((entry) => entry.id === line.variantId);
    const original = order.lines.find(
      (entry) => entry.productId === line.productId && entry.variantId === line.variantId,
    );
    return orderQuantityRules(stockUnit ?? { stockOnHand: 1_000_000 }, movesStock ? (original?.quantity ?? 0) : 0);
  };
  /**
   * Everything one draft needs: its parsed lines, what is invalid, and whether it may be sent at all. `confirmed` is
   * the draft the server last confirmed, which the sent edit is compared with.
   */
  const draftValidation = (value: Draft, confirmed: Draft) => {
    const parsedLines = value.lines.map((line) => {
      const quantity = parseQuantity(line.quantityText);
      const original = order.lines.find(
        (entry) => entry.productId === line.productId && entry.variantId === line.variantId,
      );
      const rules = rulesFor(line);
      const valid = quantity !== null && (quantity === original?.quantity || isOrderQuantityValid(quantity, rules));
      return { line, price: parseAmount(line.priceText), quantity: valid ? quantity : null, rules };
    });
    const linesInvalid =
      value.lines.length === 0 || parsedLines.some((entry) => entry.price === null || entry.quantity === null);
    const shippingPrice = parseAmount(value.shippingPriceText);
    const shippingInvalid = value.shippingMethod !== null && shippingPrice === null;
    // An address or contact left as the server last confirmed it is not sent, so only an edited one has to be
    // complete. The order on the page is not that base: until the reload after the form's own save lands it still
    // shows the version before that save, and the edit is compared with the confirmed draft (`editCommandOf`).
    const addressInvalid = addressIncomplete(value, confirmed);
    const contactInvalid = contactIncomplete(value, confirmed);
    return {
      addressInvalid,
      contactInvalid,
      linesInvalid,
      parsedLines,
      shippingInvalid,
      shippingPrice,
      valid: !linesInvalid && !shippingInvalid && !addressInvalid && !contactInvalid,
    };
  };
  const { record, savedOnce } = useOrderEditDraft({
    isValid: (value, confirmed) => draftValidation(value, confirmed).valid,
    order,
    revision,
  });
  const { draft } = record;
  const patch = (next: Partial<Draft>) => record.setDraft((current) => ({ ...current, ...next }));
  const patchLine = (key: string, next: Partial<DraftLine>) =>
    patch({ lines: draft.lines.map((line) => (line.key === key ? { ...line, ...next } : line)) });
  const { addressInvalid, contactInvalid, linesInvalid, parsedLines, shippingInvalid, shippingPrice } = draftValidation(
    draft,
    record.confirmed,
  );

  const preview = previewTotals(order, parsedLines, draft.shippingMethod, shippingPrice);

  // Browser Back and links ask the same question as the form's own way out and the panel's close button.
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  /** Back to the order detail, once nothing is unsaved; an order edited in this session is reloaded there. */
  const leave = () => {
    guard.request(() => {
      if (savedOnce.current) {
        onSaved(`Objednávka ${order.number} upravena — změna je zapsána v historii`);
        return;
      }
      onCancel();
    });
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
    const unitPrice = inOrderCurrency(order, gross ? grossUnitPriceMinor(unit.netMinor, unit.vatRate) : unit.netMinor);
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

  const methodItems = shippingOptions.map((option) =>
    selectItem(
      option.method,
      `${shippingMethodFor(option.method, pickupBrand).label} · ${formatMoney(inOrderCurrency(order, option.priceMinor), orderCurrency(order))}`,
    ),
  );

  return {
    addLine,
    addressInvalid,
    contactInvalid,
    currencyUnit,
    draft,
    gross,
    guard,
    labels: saveLabelsFor(language),
    leave,
    linesInvalid,
    methodItems,
    movesStock,
    order,
    parsedLines,
    patch,
    patchLine,
    pick,
    pickedVariantId,
    pickedVariants,
    pickProduct,
    preview,
    record,
    setPickedVariantId,
    shippingInvalid,
    t,
    unit,
  };
};

const renderOrderShipping = ({
  currencyUnit,
  draft,
  methodItems,
  order,
  patch,
  shippingInvalid,
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
              shippingPriceText: moneyInputText(
                inOrderCurrency(order, shippingMethods[method.method].grossPriceMinor) / 100,
              ),
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
        label={t('merchandise.ui.shippingPriceInclVat', { currency: currencyUnit })}
        locale="cs-CZ"
        min={0}
        name="shippingPrice"
        onValueChange={(details) => patch({ shippingPriceText: details.value })}
        size="sm"
        value={draft.shippingPriceText}
        {...(shippingInvalid ? { helpText: 'Zadejte cenu', validateStatus: 'error' as const } : {})}
      >
        <NumericInput.Control>
          <NumericInput.Input />
        </NumericInput.Control>
      </FormNumericInput>
    </div>
  </SectionCard>
);

const renderOrderAddress = ({ addressInvalid, draft, patch, t }: ReturnType<typeof useOrderEditForm>) => (
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
    {addressInvalid && (
      <StatusText showIcon status="error">
        Vyplňte ulici, město i PSČ.
      </StatusText>
    )}
  </SectionCard>
);

const renderOrderContact = ({ contactInvalid, draft, patch, t }: ReturnType<typeof useOrderEditForm>) => (
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
    {contactInvalid && (
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
    currencyUnit,
    draft,
    gross,
    guard,
    labels,
    leave,
    linesInvalid,
    movesStock,
    order,
    parsedLines,
    patch,
    patchLine,
    pick,
    pickedVariantId,
    pickedVariants,
    pickProduct,
    preview,
    record,
    setPickedVariantId,
    t,
    unit,
  } = model;
  const { actionsSlot } = props;
  const handleSave = record.save;
  /** Someone else changed the order: close the editor on their version and let the list reload it. */
  const reloadLatest = () => {
    props.onSaved(`Objednávka ${order.number}: načtena aktuální verze`);
  };
  // The one way out of the form and its one Save button, in the host's footer or the form's own.
  const actions = (
    <>
      <Button onClick={leave} theme="outlined" type="button" variant="secondary">
        {t('merchandise.pages.orders.detail.backToDetail')}
      </Button>
      <SaveBar labels={labels} onReloadLatest={reloadLatest} onSave={handleSave} status={record.status} />
    </>
  );

  return (
    <>
      <form
        className="flex flex-col gap-250"
        id="order-edit-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          handleSave();
        }}
      >
        <p className="text-fg-secondary text-sm">
          Úprava DEMO objednávky. Součty přepočítá server, změna se zapíše do historie s autorem a časem. Ceník se
          nemění.{' '}
          {movesStock
            ? 'Objednávka už zboží odepsala ze skladu: přidané kusy se ze skladu odepíšou, ubrané se vrátí (uvidíte je v Pohybech produktu).'
            : 'Tato objednávka sklad neodepsala, změna množství zásoby nemění.'}
        </p>
        <SectionCard flush title={t('merchandise.ui.items')}>
          <ScrollRegion label={t('merchandise.ui.orderItems')}>
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Položka</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Množství</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">
                    {`${gross ? 'Cena/j s DPH' : 'Cena/j bez DPH'} (${currencyUnit})`}
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
                          {...(quantity === null
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
                          {...(price === null ? { helpText: 'Zadejte cenu', validateStatus: 'error' as const } : {})}
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
                            orderCurrency(order),
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
          </ScrollRegion>
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
                items={pickedVariants.map((entry) => selectItem(entry.id, `${entry.name} (${entry.sku})`))}
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
              {linesInvalid
                ? 'Zkontrolujte množství a ceny položek'
                : formatMoney(preview.totalMinor, orderCurrency(order))}
            </span>
          </div>
          {actionsSlot === undefined && (
            <div className="flex flex-wrap items-center justify-end gap-150">{actions}</div>
          )}
        </div>
      </form>
      {actionsSlot !== undefined && actionsSlot !== null && createPortal(actions, actionsSlot)}
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
