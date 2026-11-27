import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
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
import {
  Field,
  FormBuilder,
  FormReact,
  FormRoot,
  NumberTextSchema,
  NumericField,
  TextAreaField,
  TextField,
  unrenderedField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import type { NumberText } from '@app/core-runtime/ui/form';
import { CzVatClassificationCodeSchema } from '@app/shared-contracts/cz-vat-classifications';
import { useEffect, useRef, useState } from 'react';
import { constVoid } from 'effect/Function';
import { createPortal } from 'react-dom';
import type { Order, ProductRecord } from '../../../../../shared/apis/records.ts';
import type { ProductId, ShippingMethod, VariantId } from '../../../../../shared/domain/merchandise-model.ts';
import { convertGrossMinor } from '../../../../../shared/domain/market-offers.ts';
import {
  orderCurrency,
  ProductIdSchema,
  shippingMethodFor,
  ShippingMethodSchema,
  shippingMethods,
  VariantIdSchema,
} from '../../../../../shared/domain/merchandise-model.ts';
import {
  firstOrderableQuantity,
  isOrderQuantityValid,
  orderQuantityRules,
} from '../../../../../shared/domain/order-quantity.ts';
import { recordGrossForQuantity } from '../../../../../shared/domain/unit-price.ts';
import { fullOrderTotals, lineGrossMinor } from '../../../../../shared/domain/order-totals.ts';
import { MONEY_FORMAT, moneyInputText } from '../../../../form-number.ts';
import { shippingOptions } from './order-eshop.ts';
import { addressIncomplete, contactIncomplete, draftOf, parseAmount, parseQuantity } from './order-edit-draft.ts';
import type { Draft, DraftLine } from './order-edit-draft.ts';
import { useOrderEditDraft } from './order-edit-save.ts';
import { activeVariants, lineClassification } from './order-line-draft.ts';
import { loadProductRecord, readProductRecord } from '../../provoz/produkty/product-reads.ts';
import type { ProductRecordState } from '../../provoz/produkty/product-reads.ts';
import { ProductSearchCombobox } from '../../provoz/produkty/product-search.tsx';
import { useTaxLabels } from '../../provoz/produkty/product-tax-classification.ts';
import type { CompanyVat, TaxLabels } from '../../provoz/produkty/product-tax-classification.ts';
import { DateTime, Effect, Option, Schema } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useRecordForm } from '../../../../ui/record-form.ts';

/** A catalog CZK amount in the order's currency: market orders keep their own price list (as the server reprices). */
const inOrderCurrency = (order: Pick<Order, 'market'>, czkMinor: number): number =>
  order.market === undefined ? czkMinor : convertGrossMinor(czkMinor, order.market);

interface SellableUnit {
  /** The record's price including VAT below its first quantity break (what the storefront shows), when it has one. */
  readonly grossMinor?: number;
  readonly name: string;
  readonly netMinor: number;
  readonly productId: ProductId;
  readonly sku: string;
  readonly taxClassificationCode: DraftLine['taxClassificationCode'];
  /** Its quantity breaks: a gross-priced order charges the break a line's quantity reaches. */
  readonly tiers?: ProductRecord['priceTiers'];
  readonly variantId?: VariantId;
  readonly variantName?: string;
  readonly vatRate: DraftLine['vatRate'];
}

/** Products read again at once after a refused save (an order edit adds a handful of lines). */
const OFFER_READS_AT_ONCE = 4;

/**
 * An added line at a newly offered price: the price staff left at the old offer follows the new one, a price they
 * typed themselves stays.
 */
const withOffer = (line: DraftLine, offer: number): DraftLine => {
  const text = moneyInputText(offer / 100);
  const typed =
    line.offeredPriceText !== undefined && parseAmount(line.priceText) !== parseAmount(line.offeredPriceText);
  return { ...line, offeredPriceText: text, priceText: typed ? line.priceText : text };
};

/** A line's price field: no price typed, or (an added line) no price including VAT for its quantity. */
const lineFieldError = (price: number | null, priceMissing: boolean, missingText: string) => {
  if (priceMissing) {
    return { helpText: missingText, invalid: true };
  }
  return price === null ? { helpText: 'Zadejte cenu', invalid: true } : {};
};

/** The quantity a picked unit is added at: the smallest quantity it can be ordered in. */
const firstQuantityOf = (picked: ProductRecord, offeredUnit: SellableUnit) =>
  firstOrderableQuantity(
    offeredUnit.variantId === undefined
      ? picked
      : (picked.variantRecords?.find((entry) => entry.id === offeredUnit.variantId) ?? picked),
  );

interface RepricedLine {
  readonly name: string;
  readonly price: number;
}

/** The current offer of every added line whose product can be read and sold now, by line key. */
const currentOffers = (
  lines: readonly DraftLine[],
  offerOf: (product: ProductRecord, line: DraftLine) => number | undefined,
): Effect.Effect<ReadonlyMap<string, number>> =>
  Effect.forEach(
    lines.filter((line) => line.offeredPriceText !== undefined),
    (line) =>
      readProductRecord(line.productId).pipe(
        Effect.map((product) => Option.fromUndefinedOr(product === undefined ? product : offerOf(product, line))),
        // A product that cannot be read keeps its line as it is; staff see the refusal and can pick it again.
        Effect.orElseSucceed(() => Option.none<number>()),
        Effect.map((offer) =>
          Option.match(offer, { onNone: () => [], onSome: (price) => [[line.key, price] as const] }),
        ),
      ),
    { concurrency: OFFER_READS_AT_ONCE },
  ).pipe(Effect.map((offers) => new Map(offers.flat())));

/** A line named as staff see it. */
const lineName = (line: DraftLine): string =>
  line.variantName === undefined ? line.name : `${line.name} (${line.variantName})`;

/** The added lines a new offer changes the price of, named as staff see them. */
const repricedLines = (lines: readonly DraftLine[], offers: ReadonlyMap<string, number>): RepricedLine[] =>
  lines.flatMap((line) => {
    const price = offers.get(line.key);
    return price === undefined || price === parseAmount(line.offeredPriceText ?? '')
      ? []
      : [{ name: lineName(line), price }];
  });

/**
 * The added lines whose new price the form could not take after the server refused their old one: a product that can
 * no longer be read, and, when no line got a new price at all, every added line (the product reads at the price the
 * line already carries, e.g. one without a stored gross priced at a rate the server no longer uses). Saving again
 * would be refused the same way, so staff remove those lines and add them again.
 */
const unrepricedLines = (lines: readonly DraftLine[], offers: ReadonlyMap<string, number>): string[] => {
  const added = lines.filter((line) => line.offeredPriceText !== undefined);
  const noneRepriced = repricedLines(added, offers).length === 0;
  return added.flatMap((line) => (noneRepriced || !offers.has(line.key) ? [lineName(line)] : []));
};

/**
 * Why the picked product cannot be added: it names no VAT classification, or its classification has no usable rate.
 * Nothing while no product is picked or it can be added.
 */
const pickedRateMessage = (
  product: ProductRecord | null,
  classification: ReturnType<typeof lineClassification>,
  labels: TaxLabels,
): string | undefined => {
  if (product === null) {
    return undefined;
  }
  if (classification === null) {
    return labels.noClassification;
  }
  return classification.current === undefined
    ? labels.rateMissing(classification.code, classification.problem)
    : undefined;
};

/**
 * The unit a pick adds: the product itself, or its chosen active variant, with the rate Tax gives the product's
 * classification today. Undefined until that choice is complete, and while the classification has no rate in force.
 */
const sellableUnit = (
  product: ProductRecord,
  variantId: VariantId | null,
  vatRate: number | undefined,
): SellableUnit | undefined => {
  if (vatRate === undefined) {
    return undefined;
  }
  const variants = activeVariants(product);
  if (variants.length === 0) {
    const unit: SellableUnit = {
      name: product.name,
      netMinor: product.currentPriceMinor,
      productId: product.id,
      sku: product.sku,
      taxClassificationCode: product.taxClassificationCode,
      tiers: product.priceTiers,
      vatRate,
    };
    return product.grossPriceMinor === undefined ? unit : { ...unit, grossMinor: product.grossPriceMinor };
  }
  const variant = variants.find((entry) => entry.id === variantId);
  if (variant === undefined) {
    return undefined;
  }
  const unit: SellableUnit = {
    name: product.name,
    netMinor: variant.priceMinor,
    productId: product.id,
    sku: variant.sku,
    taxClassificationCode: product.taxClassificationCode,
    tiers: variant.priceTiers,
    variantId: variant.id,
    variantName: variant.name,
    vatRate,
  };
  return variant.grossPriceMinor === undefined ? unit : { ...unit, grossMinor: variant.grossPriceMinor };
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
  const totalsInput = {
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
  return fullOrderTotals(
    shippingMethod !== null && shippingPrice !== null
      ? { ...totalsInput, shipping: { label: '', method: shippingMethod, priceMinor: shippingPrice, vatRate: 21 } }
      : totalsInput,
  );
};

/** One line of the order as the form holds it: the quantity and price as typed, and the line's product as it is. */
const EditLineSchema = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  offeredPriceText: Schema.OptionFromNullOr(Schema.String),
  price: NumberTextSchema,
  productId: ProductIdSchema,
  quantity: NumberTextSchema,
  sku: Schema.String,
  taxClassificationCode: Schema.OptionFromNullOr(CzVatClassificationCodeSchema),
  variantId: Schema.OptionFromNullOr(VariantIdSchema),
  variantName: Schema.OptionFromNullOr(Schema.String),
  vatRate: Schema.Number,
});

/**
 * The editable fields of the order. Typing changes only this form; the Save button sends the draft it stands for, and
 * Enter in a field is the same one save. The shipping method is picked in a select that writes its field; a line's
 * product, its offer and VAT are the line's own and never rendered as fields.
 */
const orderEditForm = FormReact.make(
  FormBuilder.empty
    .addField('city', Schema.String)
    .addField('country', Schema.String)
    .addField('email', Schema.String)
    .addField(Field.makeArrayField('lines', EditLineSchema))
    .addField('name', Schema.String)
    .addField('note', Schema.String)
    .addField('phone', Schema.String)
    .addField('postalCode', Schema.String)
    .addField('reason', Schema.String)
    .addField('shippingMethod', Schema.OptionFromNullOr(ShippingMethodSchema))
    .addField('shippingPrice', NumberTextSchema)
    .addField('street', Schema.String),
  {
    fields: {
      city: TextField,
      country: TextField,
      email: TextField,
      // `key` names a line; the line's product, offer and VAT are not edited here.
      lines: {
        key: unrenderedField<string>(),
        name: unrenderedField<string>(),
        offeredPriceText: unrenderedField<string | null>(),
        price: NumericField,
        productId: unrenderedField<string>(),
        quantity: NumericField,
        sku: unrenderedField<string>(),
        taxClassificationCode: unrenderedField<typeof CzVatClassificationCodeSchema.Encoded | null>(),
        variantId: unrenderedField<string | null>(),
        variantName: unrenderedField<string | null>(),
        vatRate: unrenderedField<number>(),
      },
      name: TextField,
      note: TextAreaField,
      phone: TextField,
      postalCode: TextField,
      reason: TextField,
      shippingMethod: unrenderedField<ShippingMethod | null>(),
      shippingPrice: NumericField,
      street: TextField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type EditValues = typeof orderEditForm.schema.Encoded;
type EditRow = EditValues['lines'][number];

const linesField = orderEditForm.getFieldAtoms(orderEditForm.fields.lines);
const shippingMethodField = orderEditForm.getFieldAtoms(orderEditForm.fields.shippingMethod);
const shippingPriceField = orderEditForm.getFieldAtoms(orderEditForm.fields.shippingPrice);
/** The form's lines, as a value of their own. */
const linesAtom = orderEditForm.values.pipe(
  Atom.map(Option.match({ onNone: (): readonly EditRow[] => [], onSome: (values) => values.lines })),
);

/** A quantity's display format: up to six decimals, as the order's quantities allow. */
const QUANTITY_FORMAT = { maximumFractionDigits: 6 };

/** A number field's value for a text the form holds: the text, and the number it reads as. */
const numberTextOf = (text: string): NumberText => {
  const normalized = text.replaceAll(/\s/gu, '').replace(',', '.');
  return { number: normalized === '' ? Number.NaN : Number(normalized), text };
};

const rowOf = (line: DraftLine): EditRow => ({
  key: line.key,
  name: line.name,
  offeredPriceText: line.offeredPriceText ?? null,
  price: numberTextOf(line.priceText),
  productId: line.productId,
  quantity: numberTextOf(line.quantityText),
  sku: line.sku,
  taxClassificationCode: line.taxClassificationCode ?? null,
  variantId: line.variantId ?? null,
  variantName: line.variantName ?? null,
  vatRate: line.vatRate,
});

const decodeEditLine = Schema.decodeOption(EditLineSchema);

/** The draft line a form line stands for. */
const draftLineOfRow = (row: EditRow): Option.Option<DraftLine> =>
  decodeEditLine(row).pipe(
    Option.map((line): DraftLine => {
      const base = {
        key: line.key,
        name: line.name,
        priceText: line.price.text,
        productId: line.productId,
        quantityText: line.quantity.text,
        sku: line.sku,
        taxClassificationCode: Option.getOrUndefined(line.taxClassificationCode),
        vatRate: line.vatRate,
      } satisfies DraftLine;
      const withOffered = Option.match(line.offeredPriceText, {
        onNone: (): DraftLine => base,
        onSome: (offeredPriceText) => ({ ...base, offeredPriceText }),
      });
      const withVariant = Option.match(line.variantId, {
        onNone: () => withOffered,
        onSome: (variantId) => ({ ...withOffered, variantId }),
      });
      return Option.match(line.variantName, {
        onNone: () => withVariant,
        onSome: (variantName) => ({ ...withVariant, variantName }),
      });
    }),
  );

/** The form's values for a draft. */
const editValuesOf = (draft: Draft): EditValues => ({
  city: draft.city,
  country: draft.country,
  email: draft.email,
  lines: draft.lines.map(rowOf),
  name: draft.name,
  note: draft.note,
  phone: draft.phone,
  postalCode: draft.postalCode,
  reason: draft.reason,
  shippingMethod: draft.shippingMethod,
  shippingPrice: numberTextOf(draft.shippingPriceText),
  street: draft.street,
});

/** The draft the form's values stand for. */
const editDraftOf = (values: EditValues): Draft => ({
  city: values.city,
  country: values.country,
  email: values.email,
  lines: values.lines.flatMap((row) =>
    Option.match(draftLineOfRow(row), { onNone: () => [], onSome: (line) => [line] }),
  ),
  name: values.name,
  note: values.note,
  phone: values.phone,
  postalCode: values.postalCode,
  reason: values.reason,
  shippingMethod: values.shippingMethod,
  shippingPriceText: values.shippingPrice.text,
  street: values.street,
});

/**
 * Changes the form's lines from their current rows. `useAtomSet` calls a function it is given with the setter's own
 * value, so the update goes in as the result of one: the field's setter then applies it to the field's current rows.
 */
const useLinesUpdate = () => {
  const setValue = useAtomSet(linesField.setValue);
  return (update: (rows: readonly EditRow[]) => readonly EditRow[]) => setValue(() => update);
};

/** A form line changed as the draft line it stands for. */
const updatedRow = (row: EditRow, update: (line: DraftLine) => DraftLine): EditRow =>
  Option.match(draftLineOfRow(row), { onNone: () => row, onSome: (line) => rowOf(update(line)) });

/** The form lines with their new offers taken (`withOffer`). */
const rowsWithOffers = (rows: readonly EditRow[], offers: ReadonlyMap<string, number>): EditRow[] =>
  rows.map((row) => {
    const offer = offers.get(row.key);
    return offer === undefined ? row : updatedRow(row, (line) => withOffer(line, offer));
  });

/** A line whose quantity alone changed since `before`: a change that set its offer too is priced already. */
const quantityAloneChanged = (row: EditRow, before: readonly EditRow[]): boolean => {
  const earlier = before.find((entry) => entry.key === row.key);
  return (
    earlier !== undefined &&
    earlier.quantity.text !== row.quantity.text &&
    earlier.offeredPriceText === row.offeredPriceText
  );
};

/**
 * An added line follows the price of the quantity break its changed quantity reaches: a price staff left at the old
 * offer takes the new one, a price they typed stays (`withOffer`). `offerFor` is the line's offer now, undefined
 * for a line of the order itself or one whose product cannot go on the order now.
 */
const useRepriceOnQuantity = (opening: readonly EditRow[], offerFor: (line: DraftLine) => number | undefined): void => {
  const setLines = useLinesUpdate();
  const previous = useRef(opening);
  useAtomSubscribe(
    linesAtom,
    (rows) => {
      const before = previous.current;
      previous.current = rows;
      const offers = new Map(
        rows.flatMap((row) => {
          const line = quantityAloneChanged(row, before) ? draftLineOfRow(row) : Option.none<DraftLine>();
          const offer = Option.flatMapNullishOr(line, offerFor);
          return Option.match(offer, { onNone: () => [], onSome: (price) => [[row.key, price] as const] });
        }),
      );
      if (offers.size > 0) {
        setLines((current) => rowsWithOffers(current, offers));
      }
    },
    { immediate: false },
  );
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
  /** The company's VAT rates (current and scheduled); a new line's rate comes from its product's classification. */
  readonly vat: CompanyVat;
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
  vat,
}: OrderEditFormProps) => {
  const { language, t } = useModernI18n();
  const taxLabels = useTaxLabels();
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
  // A product whose classification has no rate in force cannot go on the order: the server snapshots that rate.
  const pickedClassification = lineClassification(pickedProduct, vat, DateTime.nowUnsafe());
  const ratesConfirmation = taxLabels.confirmation(vat, DateTime.nowUnsafe());
  const pickedRateMissing = pickedRateMessage(pickedProduct, pickedClassification, taxLabels);
  const unit =
    pickedProduct === null
      ? undefined
      : sellableUnit(pickedProduct, pickedVariantId, pickedClassification?.current?.ratePercent);
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
   * The price an added line of `quantity` is offered at: what the server prices it at in this order. A gross-priced
   * order takes the shared price function through the record (`recordGrossForQuantity`, the record's held-aware rate);
   * undefined where the server and the storefront refuse the quantity for want of a price.
   */
  const offerOf = (offeredUnit: SellableUnit, quantity: number): number | undefined => {
    if (!gross) {
      return inOrderCurrency(order, offeredUnit.netMinor);
    }
    const czk = recordGrossForQuantity(
      { grossPriceMinor: offeredUnit.grossMinor, priceTiers: offeredUnit.tiers },
      quantity,
    );
    return czk === undefined ? undefined : inOrderCurrency(order, czk);
  };
  /** An added line's offer as its product prices it now; undefined when the product cannot go on the order now. */
  const currentOfferOf = (product: ProductRecord, line: DraftLine) => {
    const current = sellableUnit(
      product,
      line.variantId ?? null,
      lineClassification(product, vat, DateTime.nowUnsafe())?.current?.ratePercent,
    );
    return current === undefined ? undefined : offerOf(current, parseQuantity(line.quantityText) ?? 1);
  };
  // A unit with no price including VAT at the quantity it would be added at cannot go on a gross-priced order.
  const pickedPriceMissing =
    unit !== undefined && pickedProduct !== null && offerOf(unit, firstQuantityOf(pickedProduct, unit)) === undefined;
  /** An added line of a gross-priced order whose quantity has no price including VAT (the server would refuse it). */
  const priceMissingFor = (line: DraftLine) => {
    const product =
      gross && line.offeredPriceText !== undefined
        ? addedProducts.find((entry) => entry.id === line.productId)
        : undefined;
    return product !== undefined && currentOfferOf(product, line) === undefined;
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
      const priceMissing = valid && priceMissingFor(line);
      return { line, price: parseAmount(line.priceText), priceMissing, quantity: valid ? quantity : null, rules };
    });
    const linesInvalid =
      value.lines.length === 0 ||
      parsedLines.some((entry) => entry.price === null || entry.quantity === null || entry.priceMissing);
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
  // The added lines whose price changed meanwhile, with the price they carry now; shown until the next save is sent.
  const [repriced, setRepriced] = useState<readonly RepricedLine[]>([]);
  // The added lines whose new price could not be read after a refusal; shown until a save succeeds.
  const [unrepriced, setUnrepriced] = useState<readonly string[]>([]);
  // Set once `record` exists: takes newly read offers into the draft.
  const takeOffers = useRef<(offers: ReadonlyMap<string, number>) => void>(constVoid);
  const { record, savedOnce } = useOrderEditDraft({
    isValid: (value, confirmed) => draftValidation(value, confirmed).valid,
    onSaveSucceeded: () => setUnrepriced([]),
    onSend: () => setRepriced([]),
    // The server refused an added line whose price changed after it was picked: read those products again.
    onOfferedPriceChanged: (value) =>
      currentOffers(value.lines, currentOfferOf).pipe(
        Effect.flatMap((offers) => Effect.sync(() => takeOffers.current(offers))),
      ),
    order,
    revision,
  });
  // The form holds what the fields show; the record owns the draft, its save, conflicts and kept versions.
  useRecordForm({
    draft: record.draft,
    draftOf: editDraftOf,
    form: orderEditForm,
    setDraft: record.setDraft,
    valuesOf: editValuesOf,
  });
  const values = Option.getOrElse(useAtomValue(orderEditForm.values), () => editValuesOf(record.draft));
  const draft = editDraftOf(values);
  const setLines = useLinesUpdate();
  const setShippingMethod = useAtomSet(shippingMethodField.setValue);
  const setShippingPrice = useAtomSet(shippingPriceField.setValue);
  /** Changes the line `key` of the form, as the draft line it stands for. */
  const updateLine = (key: string, update: (line: DraftLine) => DraftLine) =>
    setLines((rows) => rows.map((row) => (row.key === key ? updatedRow(row, update) : row)));
  useEffect(() => {
    takeOffers.current = (offers) => {
      setRepriced(repricedLines(draft.lines, offers));
      setUnrepriced(unrepricedLines(draft.lines, offers));
      setLines((rows) => rowsWithOffers(rows, offers));
    };
  }, [draft.lines, setLines]);
  useRepriceOnQuantity(values.lines, (line) => {
    const product =
      line.offeredPriceText === undefined ? undefined : addedProducts.find((entry) => entry.id === line.productId);
    return product === undefined ? undefined : currentOfferOf(product, line);
  });
  // Enter in a field is the Save button.
  useAtomSubscribe(
    orderEditForm.submit,
    (result) => {
      if (AsyncResult.isSuccess(result) && !result.waiting) {
        record.save();
      }
    },
    { immediate: false },
  );
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
      const more = { ...existing, quantityText: String(quantity + rulesFor(existing).step) };
      const offer = offerOf(unit, quantity + rulesFor(existing).step);
      // A line added in this edit takes the product's price as it is now; the order's own lines keep theirs.
      updateLine(existing.key, () =>
        existing.offeredPriceText === undefined || offer === undefined ? more : withOffer(more, offer),
      );
      clearPick();
      return;
    }
    // A gross-priced order (storefront) takes the price including VAT for this quantity, exactly as the server does.
    const quantity = firstQuantityOf(pickedProduct, unit);
    const offer = offerOf(unit, quantity);
    if (offer === undefined) {
      return;
    }
    const offered = moneyInputText(offer / 100);
    const added = {
      key: `new-${sequence.current}`,
      name: unit.name,
      offeredPriceText: offered,
      priceText: offered,
      productId: unit.productId,
      quantityText: String(quantity),
      sku: unit.sku,
      taxClassificationCode: unit.taxClassificationCode,
      vatRate: unit.vatRate,
    } satisfies DraftLine;
    const withVariant = unit.variantId === undefined ? added : { ...added, variantId: unit.variantId };
    const line: DraftLine =
      unit.variantName === undefined ? withVariant : { ...withVariant, variantName: unit.variantName };
    setLines((rows) => [...rows, rowOf(line)]);
    sequence.current += 1;
    clearPick();
  };
  const removeLine = (key: string) => setLines((rows) => rows.filter((row) => row.key !== key));
  const chooseShipping = (method: ShippingMethod) => {
    setShippingMethod(method);
    setShippingPrice(
      numberTextOf(moneyInputText(inOrderCurrency(order, shippingMethods[method].grossPriceMinor) / 100)),
    );
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
    chooseShipping,
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
    pick,
    pickedPriceMissing,
    pickedRateMissing,
    pickedVariantId,
    pickedVariants,
    pickProduct,
    preview,
    ratesConfirmation,
    record,
    removeLine,
    repriced,
    setPickedVariantId,
    shippingInvalid,
    t,
    taxLabels,
    unit,
    unrepriced,
    values,
  };
};

const renderOrderShipping = ({
  chooseShipping,
  currencyUnit,
  draft,
  methodItems,
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
            chooseShipping(method.method);
          }
        }}
        placeholder={t('merchandise.ui.selectShipping')}
        size="sm"
        value={draft.shippingMethod === null ? [] : [draft.shippingMethod]}
      />
      <orderEditForm.shippingPrice
        formatOptions={MONEY_FORMAT}
        id="edit-shipping-price"
        label={t('merchandise.ui.shippingPriceInclVat', { currency: currencyUnit })}
        locale="cs-CZ"
        min={0}
        name="shippingPrice"
        size="sm"
        {...(shippingInvalid ? { helpText: 'Zadejte cenu', invalid: true } : {})}
      />
    </div>
  </SectionCard>
);

const renderOrderAddress = ({ addressInvalid, t }: ReturnType<typeof useOrderEditForm>) => (
  <SectionCard title={t('merchandise.ui.deliveryAddress')}>
    <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
      <orderEditForm.street id="edit-street" label={t('merchandise.ui.streetNumber')} name="street" />
      <orderEditForm.city id="edit-city" label={t('merchandise.ui.city')} name="city" />
      <orderEditForm.postalCode id="edit-postal" label={t('merchandise.ui.postalCode')} name="postalCode" />
      <orderEditForm.country id="edit-country" label={t('merchandise.ui.country')} name="country" />
    </div>
    {addressInvalid && (
      <StatusText showIcon status="error">
        Vyplňte ulici, město i PSČ.
      </StatusText>
    )}
  </SectionCard>
);

const renderOrderContact = ({ contactInvalid, t }: ReturnType<typeof useOrderEditForm>) => (
  <SectionCard title={t('merchandise.ui.demoCustomerContact')}>
    <div className="grid grid-cols-1 gap-200 sm:grid-cols-3">
      <orderEditForm.name id="edit-name" label={t('merchandise.ui.contactName')} name="name" />
      <orderEditForm.email id="edit-email" label={t('merchandise.ui.email')} name="email" type="email" />
      <orderEditForm.phone id="edit-phone" label={t('merchandise.ui.phone')} name="phone" />
    </div>
    {contactInvalid && (
      <StatusText showIcon status="error">
        Zadejte jméno a platný e-mail.
      </StatusText>
    )}
  </SectionCard>
);

/** One line of the order: its quantity and price fields are the form's `lines` item at `index`. */
const EditLineRow = ({
  canRemove,
  entry: { line, price, priceMissing, quantity, rules },
  index,
  onRemove,
  order,
}: {
  readonly canRemove: boolean;
  readonly entry: ReturnType<typeof useOrderEditForm>['parsedLines'][number];
  readonly index: number;
  readonly onRemove: () => void;
  readonly order: Order;
}) => {
  const { t } = useModernI18n();
  const taxLabels = useTaxLabels();
  return (
    <orderEditForm.lines.Item index={index}>
      <Table.Row>
        <Table.Cell>
          <div className="flex min-w-32 flex-col">
            <span className="font-medium">{line.name}</span>
            <span className="text-fg-secondary text-xs">
              {line.variantName === undefined ? line.sku : `${line.variantName} · ${line.sku}`}
            </span>
            <span className="text-fg-secondary text-xs">
              {`${t('merchandise.pages.orders.detail.lineVat')} ${taxLabels.line(line.taxClassificationCode, line.vatRate)}`}
            </span>
          </div>
        </Table.Cell>
        <Table.Cell align="end">
          <div className="ml-auto" style={{ minWidth: 100 }}>
            <orderEditForm.lines.quantity
              clampValueOnBlur={false}
              formatOptions={QUANTITY_FORMAT}
              hideValueMax
              id={`edit-qty-${line.key}`}
              label={<span className="sr-only">Množství</span>}
              locale="cs-CZ"
              min={rules.minimum}
              name={`qty-${line.key}`}
              size="sm"
              step={rules.step}
              {...(quantity === null
                ? {
                    helpText: `Minimum ${rules.minimum.toLocaleString('cs-CZ')}, balení po ${rules.step.toLocaleString('cs-CZ')}, dostupné ${rules.maximum.toLocaleString('cs-CZ')}`,
                    invalid: true,
                  }
                : {})}
            />
          </div>
        </Table.Cell>
        <Table.Cell align="end">
          <div className="ml-auto w-24">
            <orderEditForm.lines.price
              formatOptions={MONEY_FORMAT}
              id={`edit-price-${line.key}`}
              label={<span className="sr-only">Cena za jednotku</span>}
              locale="cs-CZ"
              min={0}
              name={`price-${line.key}`}
              size="sm"
              {...lineFieldError(price, priceMissing, t('merchandise.pages.orders.create.noPriceForQuantity'))}
            />
          </div>
        </Table.Cell>
        <Table.Cell align="end" className="tabular-nums">
          {price === null || quantity === null
            ? '—'
            : formatMoney(
                lineGrossMinor({ quantity, unitPriceMinor: price, vatRate: line.vatRate }, order.pricesIncludeVat),
                orderCurrency(order),
              )}
        </Table.Cell>
        <Table.Cell align="end">
          <Button
            appearance="ghost"
            aria-label={`Odebrat ${line.name}`}
            disabled={!canRemove}
            icon="icon-[mdi--delete-outline]"
            onClick={onRemove}
            severity="secondary"
            size="sm"
            type="button"
          />
        </Table.Cell>
      </Table.Row>
    </orderEditForm.lines.Item>
  );
};

const OrderEditFields = (props: OrderEditFormProps) => {
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
    pick,
    pickedPriceMissing,
    pickedRateMissing,
    pickedVariantId,
    pickedVariants,
    pickProduct,
    preview,
    ratesConfirmation,
    record,
    removeLine,
    repriced,
    setPickedVariantId,
    t,
    unit,
    unrepriced,
    values,
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
      <Button appearance="outline" onClick={leave} severity="secondary" type="button">
        {t('merchandise.pages.orders.detail.backToDetail')}
      </Button>
      <SaveBar labels={labels} onReloadLatest={reloadLatest} onSave={handleSave} status={record.status} />
    </>
  );

  return (
    <>
      <p className="text-fg-secondary text-sm">
        Úprava DEMO objednávky. Součty přepočítá server, změna se zapíše do historie s autorem a časem. Ceník se nemění.{' '}
        {movesStock
          ? 'Objednávka už zboží odepsala ze skladu: přidané kusy se ze skladu odepíšou, ubrané se vrátí (uvidíte je v Pohybech produktu).'
          : 'Tato objednávka sklad neodepsala, změna množství zásoby nemění.'}
      </p>
      <SectionCard flush title={t('merchandise.ui.items')}>
        <ScrollRegion label={t('merchandise.ui.orderItems')}>
          <Table appearance="line" size="sm">
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
              {parsedLines.map((entry) => (
                <EditLineRow
                  canRemove={draft.lines.length > 1}
                  entry={entry}
                  index={values.lines.findIndex((row) => row.key === entry.line.key)}
                  key={entry.line.key}
                  onRemove={() => removeLine(entry.line.key)}
                  order={order}
                />
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
              appearance="outline"
              disabled={unit === undefined || pickedPriceMissing}
              icon="icon-[mdi--plus]"
              onClick={addLine}
              severity="secondary"
              type="button"
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
          {pickedRateMissing !== undefined && (
            <StatusText showIcon status="error">
              {pickedRateMissing}
            </StatusText>
          )}
          {pickedPriceMissing && (
            <StatusText showIcon status="error">
              {t('merchandise.pages.orders.create.noPriceAtMinimum')}
            </StatusText>
          )}
          {ratesConfirmation !== undefined && (
            <StatusText showIcon size="sm" status="warning">
              {ratesConfirmation}
            </StatusText>
          )}
          {pick?.record.status === 'error' && (
            <StatusText showIcon status="error">
              Produkt se nepodařilo načíst. Vyberte ho znovu.
            </StatusText>
          )}
          {repriced.length > 0 && (
            <StatusText showIcon status="warning">
              {t('merchandise.ui.offeredPriceChanged', {
                lines: repriced
                  .map((entry) => `${entry.name}: ${formatMoney(entry.price, orderCurrency(order))}`)
                  .join(', '),
              })}
            </StatusText>
          )}
          {unrepriced.length > 0 && (
            <StatusText showIcon status="error">
              {t('merchandise.ui.offeredPriceUnreadable', { lines: unrepriced.join(', ') })}
            </StatusText>
          )}
        </div>
      </SectionCard>

      {renderOrderShipping(model)}

      {renderOrderAddress(model)}

      {renderOrderContact(model)}

      <orderEditForm.note id="edit-note" label={t('merchandise.ui.orderNote')} maxLength={1000} name="note" />
      <orderEditForm.reason
        id="edit-reason"
        label={t('merchandise.ui.changeReason')}
        maxLength={500}
        name="reason"
        placeholder={t('merchandise.ui.changeReasonPlaceholder')}
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
        {actionsSlot === undefined && <div className="flex flex-wrap items-center justify-end gap-150">{actions}</div>}
      </div>
      {actionsSlot !== undefined && actionsSlot !== null && createPortal(actions, actionsSlot)}
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

/**
 * The order edit form. Its fields, the save bar and the leave question render inside it, so whatever reads the form's
 * values reads this order's. Enter in a field is the Save button.
 */
export const OrderEditForm = (props: OrderEditFormProps) => {
  const { t } = useModernI18n();
  return (
    <FormRoot
      className="flex flex-col gap-250"
      defaultValues={editValuesOf(draftOf(props.order))}
      form={orderEditForm}
      id="order-edit-form"
      translateMessage={t}
    >
      <OrderEditFields {...props} />
    </FormRoot>
  );
};
