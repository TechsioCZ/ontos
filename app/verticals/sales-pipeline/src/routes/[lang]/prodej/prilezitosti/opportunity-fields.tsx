// The opportunity form of the create and the edit panel: the opportunity's fields, its product lines and the line
// being picked for adding, as one effect-form form. Each field is checked by the Action payload's own schema and
// reports the module's own message.
import { formatMoney, formatNumber, requiredLabelFor, surfaceTileClassName } from '@app/admin-ui';
import {
  ChoiceField,
  ComboboxField,
  FormBuilder,
  FormReact,
  FormRoot,
  NumericField,
  TextAreaField,
  TextField,
  makeItemNumericField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { CalendarDateSchema } from '@app/shared-contracts';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  OpportunityLineSchema,
  OpportunityNoteSchema,
  OpportunityTitleSchema,
  VatRateSchema,
  opportunityAmountMinor,
} from '../../../../../shared/model/opportunity.ts';
import type { OpportunityLine } from '../../../../../shared/model/opportunity.ts';
import { PartyIdSchema } from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { sameOpportunityDraft, shownQuantity, withQuantity } from './opportunity-draft.ts';
import type { FormDraft, LineEntry } from './opportunity-draft.ts';
import { PickerFrame, usePicker } from './pipeline-combobox.tsx';
import {
  MAX_LINE_QUANTITY,
  filterItemsByQuery,
  isSafeOpportunityAmount,
  isValidQuantity,
  manualOpportunityLine,
} from './pipeline-model.ts';
import type { CustomerOption, EmployeeOption, LoadState, ProductOption } from './pipeline-references.ts';

export type { CreateCommand } from './opportunity-draft.ts';

export const RESIZE_LABEL_KEY = 'sales-pipeline.sidePanel.resize';

export const SELECT_PLACEHOLDER = 'sales-pipeline.selectPlaceholder';

export const K = 'sales-pipeline.pages.records';

/** The scrolling form inside a panel. The small inline padding keeps focus rings from being clipped by its edge. */
export const formClassName = '-mx-100 flex min-h-0 flex-1 flex-col gap-200 overflow-y-auto px-100 py-200';

/** The owner choice that leaves the opportunity unassigned. */
export const NONE = '__none__';

const isTitle = Schema.is(OpportunityTitleSchema);
const isNote = Schema.is(OpportunityNoteSchema);

/** A text field the payload schema `valid` accepts; otherwise it reports `create.errors.<error>`. */
const checkedText = (valid: (value: string) => boolean, error: string) =>
  Schema.String.check(Schema.makeFilter(valid, { message: `${K}.create.errors.${error}` }));

const LineEntrySchema = Schema.Struct({
  invalidAmount: Schema.optionalKey(Schema.Boolean),
  invalidQuantity: Schema.optionalKey(Schema.Number),
  key: Schema.String,
  line: Schema.toType(OpportunityLineSchema),
});

/** The quantity input of every line row; a typed quantity may also flag the line, see `withQuantity`. */
const LineQuantityField = makeItemNumericField<LineEntry>({
  identify: (entry) => entry.key,
  read: shownQuantity,
  write: withQuantity,
});

/**
 * The opportunity form. It is never submitted: Uložit sends the draft through the panel's draft save, and Enter
 * sends nothing. The lines are checked as a whole by the panel's save rule; their rows report their own problems.
 */
const opportunityForm = FormReact.make(
  FormBuilder.empty
    .addField(
      'partyId',
      checkedText((value) => Option.isSome(Schema.decodeOption(PartyIdSchema)(value)), 'customerRequired'),
    )
    .addField(
      'title',
      checkedText((value) => isTitle(value.trim()), 'titleRequired'),
    )
    .addField('ownerEmployeeId', Schema.String)
    .addField(
      'expectedCloseDate',
      checkedText((value) => Option.isSome(Schema.decodeOption(CalendarDateSchema)(value)), 'dateRequired'),
    )
    .addField(
      'note',
      checkedText((value) => isNote(value.trim()), 'noteTooLong'),
    )
    .addField('lines', Schema.Array(LineEntrySchema))
    .addField('pickProductId', Schema.String)
    .addField('lineQuantity', Schema.Number)
    .addField('rentDescription', Schema.String)
    .addField('rentPrice', Schema.Number)
    .addField('rentVat', Schema.String),
  {
    fields: {
      expectedCloseDate: TextField,
      lineQuantity: NumericField,
      lines: LineQuantityField,
      note: TextAreaField,
      ownerEmployeeId: ChoiceField,
      partyId: ComboboxField,
      pickProductId: ComboboxField,
      rentDescription: TextField,
      rentPrice: NumericField,
      rentVat: ChoiceField,
      title: TextField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

type OpportunityValues = typeof opportunityForm.schema.Encoded;

/** The line being picked, as it starts and as it starts again once it was added. */
const emptyPick = {
  lineQuantity: 1,
  pickProductId: '',
  rentDescription: '',
  rentPrice: 0,
  rentVat: '21',
} as const satisfies Partial<OpportunityValues>;

/** The opportunity's own fields showing `draft`; the line being picked is left as it is. */
const draftValuesOf = (draft: FormDraft) =>
  ({
    expectedCloseDate: draft.closeText,
    lines: draft.lines,
    note: draft.note,
    ownerEmployeeId: draft.ownerId ?? NONE,
    partyId: draft.customerId ?? '',
    title: draft.title,
  }) satisfies Partial<OpportunityValues>;

/** The form showing `draft`, with a fresh line pick. */
const valuesOf = (draft: FormDraft): OpportunityValues => ({ ...emptyPick, ...draftValuesOf(draft) });

/** Drafts the form shows alike: unlike `sameOpportunityDraft`, surrounding spaces count. */
const sameShownDraft = (left: FormDraft, right: FormDraft): boolean =>
  left.title === right.title && left.note === right.note && sameOpportunityDraft(left, right);

/** The draft the form shows; the line being picked is not part of it. */
const draftOf = (values: OpportunityValues): FormDraft => ({
  closeText: values.expectedCloseDate,
  customerId: values.partyId === '' ? null : values.partyId,
  lines: values.lines,
  note: values.note,
  ownerId: values.ownerEmployeeId === '' || values.ownerEmployeeId === NONE ? null : values.ownerEmployeeId,
  title: values.title,
});

/** The draft the form shows, or `opened` until the form holds values. */
const draftOrOpened = (values: Option.Option<OpportunityValues>, opened: FormDraft): FormDraft =>
  Option.match(values, { onNone: () => opened, onSome: draftOf });

const opportunityFields = {
  lineQuantity: opportunityForm.getFieldAtoms(opportunityForm.fields.lineQuantity),
  lines: opportunityForm.getFieldAtoms(opportunityForm.fields.lines),
  ownerEmployeeId: opportunityForm.getFieldAtoms(opportunityForm.fields.ownerEmployeeId),
  partyId: opportunityForm.getFieldAtoms(opportunityForm.fields.partyId),
  pickProductId: opportunityForm.getFieldAtoms(opportunityForm.fields.pickProductId),
  rentDescription: opportunityForm.getFieldAtoms(opportunityForm.fields.rentDescription),
  rentPrice: opportunityForm.getFieldAtoms(opportunityForm.fields.rentPrice),
  rentVat: opportunityForm.getFieldAtoms(opportunityForm.fields.rentVat),
};

/**
 * ui-kit parses a number field with `parseFloat` unless it gets format options, which reads `1,5` as `1`.
 * With these options the parser follows cs-CZ, so a decimal stays visible and is reported as invalid.
 */
const quantityFormatOptions = { maximumFractionDigits: 3 };
const priceFormatOptions = { maximumFractionDigits: 2 };

const vatItems = [0, 12, 21].map((rate) => ({ label: `${rate} %`, value: String(rate) }));

interface LineRowProps {
  readonly entry: LineEntry;
  readonly onRemove: () => void;
}

const LineRow = ({ entry, onRemove }: LineRowProps) => {
  const { t } = useModernI18n();
  const { invalidAmount, invalidQuantity, line } = entry;
  const quantityInvalid = invalidQuantity !== undefined && invalidAmount !== true;
  return (
    <li className={`${surfaceTileClassName} flex flex-col gap-100 p-150`}>
      <div className="flex items-center gap-150">
        <div className="flex min-w-0 flex-1 flex-col gap-50">
          <span className="truncate font-medium text-sm">{line.productName}</span>
          <span className="text-fg-secondary text-xs tabular-nums">
            {t(`${K}.create.lineMeta`, {
              price: formatMoney(line.unitPriceMinor),
              quantity: formatNumber(line.quantity),
              vat: line.vatRate,
            })}
          </span>
        </div>
        <div className="w-32 shrink-0">
          <opportunityForm.lines
            clampValueOnBlur={false}
            entry={entry.key}
            formatOptions={quantityFormatOptions}
            inputProps={{ 'aria-label': t(`${K}.create.fields.quantity`) }}
            invalid={quantityInvalid || invalidAmount === true}
            locale="cs-CZ"
            max={MAX_LINE_QUANTITY}
            min={1}
            size="sm"
            step={1}
          />
        </div>
        {/* A minimum width keeps totals aligned across rows; a longer total grows instead of running into the delete button. */}
        <span className="min-w-28 shrink-0 whitespace-nowrap text-end font-medium text-sm tabular-nums">
          {formatMoney(line.quantity * line.unitPriceMinor)}
        </span>
        <Button
          appearance="ghost"
          aria-label={t(`${K}.create.removeLine`)}
          icon="icon-[mdi--delete-outline]"
          onClick={onRemove}
          severity="secondary"
          size="sm"
          type="button"
        />
      </div>
      {invalidAmount === true && (
        <StatusText showIcon size="sm" status="error">
          {t(`${K}.create.errors.amountRange`)}
        </StatusText>
      )}
      {quantityInvalid && (
        <StatusText showIcon size="sm" status="error">
          {t(`${K}.create.errors.quantityRange`, { max: formatNumber(MAX_LINE_QUANTITY) })}
        </StatusText>
      )}
    </li>
  );
};

/**
 * The picked product as plain text. It changes only when the pick does: the field's own value atom reports every
 * change of the form.
 */
const pickedProductId = opportunityFields.pickProductId.value.pipe(Atom.map(Option.getOrElse(() => '')));

const valueOr = <A,>(value: Option.Option<A>, fallback: A): A => Option.getOrElse(value, () => fallback);

/**
 * Product lines of an opportunity, inside the `FormRoot` of `opportunityForm`. A line copies the product's current
 * price and VAT when it is added; that price then stays on the line, so later price changes do not reach it. The
 * line being picked lives in the form too, but is not part of the opportunity until it is added.
 */
const LinesEditor = ({ products }: { readonly products: LoadState<readonly ProductOption[]> }) => {
  const { t } = useModernI18n();
  const lines = valueOr(useAtomValue(opportunityFields.lines.value), []);
  const productId = valueOr(useAtomValue(opportunityFields.pickProductId.value), '');
  const quantity = valueOr(useAtomValue(opportunityFields.lineQuantity.value), emptyPick.lineQuantity);
  const description = valueOr(useAtomValue(opportunityFields.rentDescription.value), '');
  const price = valueOr(useAtomValue(opportunityFields.rentPrice.value), emptyPick.rentPrice);
  const vat = valueOr(useAtomValue(opportunityFields.rentVat.value), emptyPick.rentVat);
  const setLines = useAtomSet(opportunityFields.lines.setValue);
  const setProductId = useAtomSet(opportunityFields.pickProductId.setValue);
  const setQuantity = useAtomSet(opportunityFields.lineQuantity.setValue);
  const setDescription = useAtomSet(opportunityFields.rentDescription.setValue);
  const setPrice = useAtomSet(opportunityFields.rentPrice.setValue);
  const setVat = useAtomSet(opportunityFields.rentVat.setValue);
  // Why the last "Přidat" added nothing; picking another product clears it.
  const [lineError, setLineError] = useState<string>();
  useAtomSubscribe(pickedProductId, () => setLineError(undefined), { immediate: false });
  /** Local React keys for draft lines; never sent to the server. */
  const keySequence = useRef(0);

  const activeProducts = products.status === 'ready' ? products.items.filter((item) => item.active) : [];
  const manual = products.status === 'ready' && activeProducts.length === 0;
  const pickedProduct = activeProducts.find((item) => item.id === productId);
  const productItems = activeProducts.map((product) => ({
    id: product.id,
    label: `${product.sku} – ${product.name}`,
    value: product.id,
  }));
  const productPicker = usePicker({ items: productItems, value: productId });
  // The list filters on the typed text here, not inside Combobox, so it always follows the input.
  const shownProductItems = filterItemsByQuery(
    productItems,
    productPicker.text,
    productItems.find((item) => item.value === productId)?.label,
  );
  const total = opportunityAmountMinor(lines.map((entry) => entry.line));
  // The typed quantity is kept as entered so an invalid value is reported, not silently replaced.
  const quantityValid = isValidQuantity(quantity);

  /** The picked product, or the typed rent, as a line; none while something is missing. */
  const pickedLine = (): Option.Option<OpportunityLine> => {
    if (manual) {
      const rate = Number(vat);
      return Schema.is(VatRateSchema)(rate) ? manualOpportunityLine(description, quantity, price, rate) : Option.none();
    }
    return pickedProduct === undefined
      ? Option.none()
      : Schema.decodeOption(OpportunityLineSchema)({
          productId: pickedProduct.id,
          productName: pickedProduct.name,
          quantity,
          unitPriceMinor: pickedProduct.currentPriceMinor,
          vatRate: pickedProduct.vatRate,
        });
  };

  /** Adds the picked product. A missing product says so here; an invalid quantity is already reported on its field. */
  const addLine = () => {
    if (!quantityValid) {
      return;
    }
    const line = pickedLine();
    if (Option.isNone(line)) {
      setLineError(t(`${K}.create.errors.${manual ? 'manualLine' : 'productRequired'}`));
      return;
    }
    if (!isSafeOpportunityAmount([...lines.map((entry) => entry.line), line.value])) {
      setLineError(t(`${K}.create.errors.amountRange`));
      return;
    }
    setLineError(undefined);
    keySequence.current += 1;
    const entry: LineEntry = {
      key: `line-${keySequence.current}`,
      line: line.value,
    };
    setLines([...lines, entry]);
    setProductId(emptyPick.pickProductId);
    setQuantity(emptyPick.lineQuantity);
    setDescription(emptyPick.rentDescription);
    setPrice(emptyPick.rentPrice);
    setVat(emptyPick.rentVat);
    productPicker.changeText('');
  };

  /**
   * Enter here adds the line rather than submitting the whole opportunity. The capture handler leaves zag's own key
   * handling (arrows, Home, End) on the field in place.
   */
  const addOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addLine();
    }
  };

  return (
    <section className="flex flex-col gap-150 border-border-primary border-t pt-200">
      <div className="flex flex-wrap items-baseline justify-between gap-100">
        <h2 className="font-semibold text-md">{t(`${K}.create.fields.lines`)}</h2>
        <span className="text-fg-secondary text-xs">{t(`${K}.create.priceFixedHint`)}</span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-end gap-150">
        <div className="min-w-0">
          {manual ? (
            <opportunityForm.rentDescription
              helpText={t(`${K}.create.rentHint`)}
              id="opportunity-rent-description"
              label={t(`${K}.create.fields.rentDescription`)}
              maxLength={300}
            />
          ) : (
            <PickerFrame picker={productPicker}>
              <opportunityForm.pickProductId
                {...productPicker.props}
                error={products.status === 'error' ? t(`${K}.create.productsFailed`) : undefined}
                filterBehavior="external"
                items={shownProductItems}
                label={t(`${K}.create.fields.product`)}
                loading={products.status === 'loading'}
                loadingMessage={t('sales-pipeline.loading')}
                noResultsMessage={t(`${K}.create.noProductMatch`)}
                placeholder={t(`${K}.create.productPlaceholder`)}
              />
            </PickerFrame>
          )}
        </div>
        <div className="min-w-0">
          <opportunityForm.lineQuantity
            clampValueOnBlur={false}
            formatOptions={quantityFormatOptions}
            helpText={
              quantityValid
                ? undefined
                : t(`${K}.create.errors.quantityRange`, { max: formatNumber(MAX_LINE_QUANTITY) })
            }
            id="opportunity-line-quantity"
            inputProps={{ onKeyDownCapture: addOnEnter }}
            invalid={!quantityValid}
            label={t(`${K}.create.fields.quantity`)}
            locale="cs-CZ"
            max={MAX_LINE_QUANTITY}
            min={1}
            step={1}
          />
        </div>
      </div>
      {manual && (
        <div className="grid grid-cols-2 items-end gap-150">
          <opportunityForm.rentPrice
            clampValueOnBlur={false}
            formatOptions={priceFormatOptions}
            id="opportunity-rent-price"
            label={t(`${K}.create.fields.price`)}
            locale="cs-CZ"
            min={0}
          />
          <opportunityForm.rentVat items={vatItems} label={t(`${K}.create.fields.vat`)} />
        </div>
      )}
      <div className="flex items-center justify-between gap-150">
        <p className="min-w-0 text-fg-secondary text-xs">
          {pickedProduct !== undefined &&
            t(`${K}.create.currentPrice`, {
              price: formatMoney(pickedProduct.currentPriceMinor),
              vat: pickedProduct.vatRate,
            })}
        </p>
        {/* Never disabled: a click without a product explains what is missing instead of doing nothing. */}
        <Button
          appearance="outline"
          icon="icon-[mdi--plus]"
          onClick={addLine}
          severity="secondary"
          size="sm"
          type="button"
        >
          {t(`${K}.create.addLine`)}
        </Button>
      </div>
      {lineError !== undefined && (
        <StatusText showIcon status="error">
          {lineError}
        </StatusText>
      )}

      {lines.length === 0 ? (
        <p className="text-fg-secondary text-sm">{t(`${K}.create.noLines`)}</p>
      ) : (
        <ul className="flex flex-col gap-100">
          {lines.map((entry) => (
            <LineRow
              entry={entry}
              key={entry.key}
              onRemove={() => setLines(lines.filter((item) => item.key !== entry.key))}
            />
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-150 font-semibold text-sm">
        <span>{t(`${K}.create.total`)}</span>
        <span className="tabular-nums">{formatMoney(total)}</span>
      </div>
    </section>
  );
};

/** ui-kit's Select label takes no size, so its text is sized here to match the FormInput and Combobox labels. */
export const formLabelClassName = 'text-label-md';

const customerLabel = (customer: CustomerOption, unknownName: string): string => {
  const name = customer.name ?? unknownName;
  return customer.companyId === null ? name : `${name} (IČO ${customer.companyId})`;
};

export interface OpportunityReferences {
  readonly customers: LoadState<readonly CustomerOption[]>;
  readonly employees: LoadState<readonly EmployeeOption[]>;
  readonly products: LoadState<readonly ProductOption[]>;
}

/**
 * The fields of one opportunity, inside the `FormRoot` of `opportunityForm`. Their messages show once the form was
 * checked: the create panel checks it when its draft turns invalid, the edit panel as it opens.
 */
const OpportunityFields = ({
  customers,
  employees,
  isEdit,
  products,
}: OpportunityReferences & { readonly isEdit: boolean }) => {
  const { language, t } = useModernI18n();
  const requiredLabel = requiredLabelFor(language);
  const customerId = Option.getOrElse(useAtomValue(opportunityFields.partyId.value), () => '');
  const ownerId = Option.getOrElse(useAtomValue(opportunityFields.ownerEmployeeId.value), () => NONE);
  const unknownCustomer = t(`${K}.create.unknownCustomer`);
  const unknownOwner = t(`${K}.unknownOwner`);

  const customerItems =
    customers.status === 'ready'
      ? customers.items.flatMap((customer) =>
          customer.archived && customer.id !== customerId
            ? []
            : [{ id: customer.id, label: customerLabel(customer, unknownCustomer), value: customer.id }],
        )
      : [];
  const customerPicker = usePicker({ items: customerItems, value: customerId });

  // The list filters on the typed text here, not inside Combobox, so it always follows the input.
  const shownCustomerItems = filterItemsByQuery(
    customerItems,
    customerPicker.text,
    customerItems.find((item) => item.value === customerId)?.label,
  );

  const ownerItems = [
    { label: t(`${K}.owner.none`), value: NONE },
    ...(employees.status === 'ready'
      ? employees.items.flatMap((employee) =>
          employee.active || employee.id === ownerId
            ? [{ label: employee.fullName || unknownOwner, value: employee.id }]
            : [],
        )
      : []),
  ];

  return (
    <>
      <PickerFrame picker={customerPicker}>
        <opportunityForm.partyId
          {...customerPicker.props}
          error={customers.status === 'error' ? t(`${K}.create.customersFailed`) : undefined}
          filterBehavior="external"
          items={shownCustomerItems}
          label={t(`${K}.create.fields.customer`)}
          loading={customers.status === 'loading'}
          loadingMessage={t('sales-pipeline.loading')}
          noResultsMessage={t(`${K}.create.noCustomerMatch`)}
          placeholder={t(`${K}.create.customerPlaceholder`)}
          required
          requiredLabel={requiredLabel}
        />
      </PickerFrame>
      <opportunityForm.title
        autoComplete="off"
        id="opportunity-title"
        label={t(`${K}.create.fields.title`)}
        required
        requiredLabel={requiredLabel}
      />
      {/* A Select, like the Obchodník filter, so a click anywhere on the field opens the list. */}
      <div className="flex flex-col gap-50">
        <opportunityForm.ownerEmployeeId
          disabled={isEdit}
          items={ownerItems}
          label={<span className={formLabelClassName}>{t(`${K}.create.fields.assignee`)}</span>}
          placeholder={t(SELECT_PLACEHOLDER)}
        />
        {isEdit && <p className="text-fg-secondary text-xs">{t(`${K}.create.ownerEditHint`)}</p>}
      </div>
      <opportunityForm.expectedCloseDate
        id="opportunity-close-date"
        label={t(`${K}.create.fields.expectedClose`)}
        required
        requiredLabel={requiredLabel}
        type="date"
      />
      <opportunityForm.note autoComplete="off" id="opportunity-note" label={t(`${K}.create.fields.note`)} rows={3} />
      <LinesEditor products={products} />
    </>
  );
};

/**
 * The opportunity form of a panel, opened with `opened`. It has no submit button, so Enter never sends the
 * opportunity: only the panel's Uložit does. `children` come before the fields, such as the server's refusal.
 */
export const OpportunityForm = ({
  children,
  isEdit,
  opened,
  ...references
}: OpportunityReferences & {
  readonly children?: ReactNode;
  readonly isEdit: boolean;
  readonly opened: FormDraft;
}) => {
  const { t } = useModernI18n();
  return (
    <FormRoot
      className={formClassName}
      defaultValues={valuesOf(opened)}
      form={opportunityForm}
      translateMessage={(message) => t(message, { defaultValue: message })}
    >
      {children}
      <OpportunityFields {...references} isEdit={isEdit} />
    </FormRoot>
  );
};

/** The draft the opportunity form shows, or `opened` until the form holds values. */
export const useOpportunityDraft = (opened: FormDraft): FormDraft =>
  draftOrOpened(useAtomValue(opportunityForm.values), opened);

/** Checks the whole opportunity form: from then on every field shows its message. */
export const useCheckOpportunity = (): (() => void) => useAtomSet(opportunityForm.validate);

/**
 * The edit panel's draft and its form as one, once the form was initialized for this panel (`ready`): every change in
 * the form changes the draft at once, and a draft that moves without the form (a server refresh, Zahodit změny, the
 * latest version) shows in the form, keeping the line being picked.
 */
export const useOpportunityDraftSync = ({
  draft,
  ready,
  setDraft,
}: {
  readonly draft: FormDraft;
  readonly ready: boolean;
  readonly setDraft: (draft: FormDraft) => void;
}) => {
  const values = useAtomValue(opportunityForm.values);
  const setValues = useAtomSet(opportunityForm.setValues);
  useAtomSubscribe(
    opportunityForm.values,
    (next) => {
      if (ready && Option.isSome(next)) {
        setDraft(draftOf(next.value));
      }
    },
    { immediate: false },
  );
  const shownDraft = useRef(draft);
  useEffect(() => {
    if (!ready || shownDraft.current === draft) {
      return;
    }
    shownDraft.current = draft;
    if (Option.isSome(values) && !sameShownDraft(draftOf(values.value), draft)) {
      setValues({ ...values.value, ...draftValuesOf(draft) });
    }
  }, [draft, ready, setValues, values]);
};
