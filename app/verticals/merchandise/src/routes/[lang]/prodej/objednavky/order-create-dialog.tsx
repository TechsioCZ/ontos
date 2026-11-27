import { pendingProposalMessage } from '../../../../api/action-result.ts';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Combobox } from '@app/admin-ui/form-controls';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import {
  DetailList,
  formatMoney,
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  comboboxTranslations,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import {
  Field,
  FormBuilder,
  FormReact,
  FormRoot,
  NumberTextSchema,
  NumericField,
  unrenderedField,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { DateTime, Effect, Option, Schema, Struct } from 'effect';
import { constVoid } from 'effect/Function';
import { useRef, useState } from 'react';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { CustomerDirectory, CustomerEntry } from './customers-directory.ts';
import { lineAmounts, sumAmounts } from './orders-model.ts';
import { PartyIdSchema, ProductRecordSchema, VariantIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import type { ProductId, VariantId } from '../../../../../shared/domain/merchandise-model.ts';
import type { ProductRecordState } from '../../provoz/produkty/product-reads.ts';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type { NewOrderLine } from './orders-records.ts';
import { createOrder, isRevisionConflict } from './orders-records.ts';
import { OrderLineEditor } from './order-line-editor.tsx';
import { WHOLE_NUMBER_FORMAT } from '../../../../form-number.ts';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { activeVariants, lineClassification, lineProduct } from './order-line-draft.ts';
import { useTaxLabels } from '../../provoz/produkty/product-tax-classification.ts';
import type { CompanyVat } from '../../provoz/produkty/product-tax-classification.ts';
import type { DraftLine } from './order-line-draft.ts';

/** The product a line picked, as its search shows it. */
const PickedProductSchema = ProductRecordSchema.mapFields(Struct.pick(['id', 'name', 'sku']));

const CreateLineSchema = Schema.Struct({
  key: Schema.String,
  picked: Schema.OptionFromNullOr(PickedProductSchema),
  quantity: NumberTextSchema,
  variantId: Schema.OptionFromNullOr(VariantIdSchema),
});

/**
 * The customer and the lines of the new order. The customer and each line's product and variant are picked in
 * comboboxes and selects that write their fields; the quantity is a number field. Nothing submits the form: the
 * dialog's Uložit sends the draft.
 */
const createOrderForm = FormReact.make(
  FormBuilder.empty
    .addField(Field.makeArrayField('lines', CreateLineSchema))
    .addField('partyId', Schema.OptionFromNullOr(PartyIdSchema)),
  {
    fields: {
      // `key` names a line.
      lines: {
        key: unrenderedField<string>(),
        picked: unrenderedField<typeof PickedProductSchema.Encoded | null>(),
        quantity: NumericField,
        variantId: unrenderedField<string | null>(),
      },
      partyId: unrenderedField<string | null>(),
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

type CreateOrderValues = typeof createOrderForm.schema.Encoded;
type CreateLineValues = CreateOrderValues['lines'][number];

const createLinesField = createOrderForm.getFieldAtoms(createOrderForm.fields.lines);
const createPartyField = createOrderForm.getFieldAtoms(createOrderForm.fields.partyId);

/** A line with no product yet, one piece. */
const blankLine = (key: string): CreateLineValues => ({
  key,
  picked: null,
  quantity: { number: 1, text: '1' },
  variantId: null,
});

/** The record a line's pick read, by line key: kept only for the product the line still has picked. */
type LoadedRecords = Readonly<Record<string, { readonly productId: ProductId; readonly record: ProductRecordState }>>;

const decodeLine = Schema.decodeOption(CreateLineSchema);

/** A line of the form with the record of its picked product: loading until that product's record arrived. */
const draftLineOf = (row: CreateLineValues, loaded: LoadedRecords): DraftLine => {
  const line = decodeLine(row);
  const picked = line.pipe(
    Option.flatMap((entry) => entry.picked),
    Option.getOrNull,
  );
  const variantId = line.pipe(
    Option.flatMap((entry) => entry.variantId),
    Option.getOrNull,
  );
  const entry = loaded[row.key];
  const pickedRecord: ProductRecordState =
    entry !== undefined && entry.productId === picked?.id ? entry.record : { status: 'loading' };
  return {
    key: row.key,
    picked,
    quantity: row.quantity.number,
    quantityText: row.quantity.text,
    record: picked === null ? { status: 'idle' } : pickedRecord,
    variantId,
  };
};

const key = (path: string) => `merchandise.pages.orders.${path}`;

interface Draft {
  readonly lines: readonly DraftLine[];
  readonly partyId: string;
}

const isValidQuantity = (quantity: number) => Number.isInteger(quantity) && quantity >= 1;

const firstValue = (value: string | string[]) => (Array.isArray(value) ? value[0] : value);

/** The form opens with one empty line and no customer; anything picked or typed after that is the draft. */
const openingValues: CreateOrderValues = { lines: [blankLine('line-1')], partyId: null };

/** The form's values with each line's product record: what the dialog shows, checks and sends. */
const draftOf = (values: CreateOrderValues, loaded: LoadedRecords): Draft => ({
  lines: values.lines.map((row) => draftLineOf(row, loaded)),
  partyId: values.partyId ?? '',
});

const blankDraft = draftOf(openingValues, {});

/** What the user chose: the customer and, per line, product, variant and quantity. A loading product record is not. */
const sameDraft = (left: Draft, right: Draft): boolean =>
  left.partyId === right.partyId &&
  left.lines.length === right.lines.length &&
  left.lines.every((line, index) => {
    const other = right.lines[index];
    return (
      other !== undefined &&
      line.picked?.id === other.picked?.id &&
      line.variantId === other.variantId &&
      line.quantityText === other.quantityText
    );
  });

/** The order lines the draft sends: lines without a product are not sent. */
const linesOf = (value: Draft) =>
  value.lines.flatMap((line) => {
    if (line.picked === null) {
      return [];
    }
    const next = { productId: line.picked.id, quantity: line.quantity } satisfies NewOrderLine;
    return [line.variantId === null ? next : { ...next, variantId: line.variantId }];
  });

interface OrderCreateDialogProps {
  readonly customers: CustomerDirectory;
  readonly onCreated: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly revision: number;
  /** The company's VAT rates from the staff records read; each line's VAT comes from its product's classification. */
  readonly vat: CompanyVat;
}

/** The lines of the form and the records their picks read, with the ways to change them. */
const useCreateLines = () => {
  const values = Option.getOrElse(useAtomValue(createOrderForm.values), () => openingValues);
  const setValues = useAtomSet(createOrderForm.setValues);
  const setLinesValue = useAtomSet(createLinesField.setValue);
  // `useAtomSet` calls a function it is given with the setter's own value, so the update goes in as the result of one:
  // the field's setter then applies it to the field's current lines.
  const setLines = (update: (rows: readonly CreateLineValues[]) => readonly CreateLineValues[]) =>
    setLinesValue(() => update);
  const setPartyId = useAtomSet(createPartyField.setValue);
  // The full record each line's pick read; a record that arrives after the line picked another product is dropped.
  const [loaded, setLoaded] = useState<LoadedRecords>({});
  const lineSequence = useRef(1);
  const nextKey = () => {
    lineSequence.current += 1;
    return `line-${lineSequence.current}`;
  };
  const updateLine = (
    lineKey: string,
    update: (row: CreateOrderValues['lines'][number]) => CreateOrderValues['lines'][number],
  ) => setLines((current) => current.map((row) => (row.key === lineKey ? update(row) : row)));
  const pick = (lineKey: string, picked: ProductRecord | null) => {
    updateLine(lineKey, (row) => ({
      ...row,
      picked: picked === null ? null : { id: picked.id, name: picked.name, sku: picked.sku },
      variantId: null,
    }));
    if (picked !== null) {
      setLoaded((current) => ({ ...current, [lineKey]: { productId: picked.id, record: { status: 'loading' } } }));
    }
  };
  const receiveRecord = (lineKey: string, productId: ProductId, record: ProductRecordState) =>
    setLoaded((current) =>
      current[lineKey]?.productId === productId ? { ...current, [lineKey]: { productId, record } } : current,
    );
  const chooseVariant = (lineKey: string, variantId: VariantId | null) =>
    updateLine(lineKey, (row) => ({ ...row, variantId }));
  const removeLine = (lineKey: string) => setLines((current) => current.filter((row) => row.key !== lineKey));
  const addLine = () => {
    const lineKey = nextKey();
    setLines((current) => [...current, blankLine(lineKey)]);
  };
  /** An empty form with a fresh line; returns its draft. */
  const clear = (): Draft => {
    const next: CreateOrderValues = { lines: [blankLine(nextKey())], partyId: null };
    setValues(next);
    setLoaded({});
    return draftOf(next, {});
  };
  return {
    addLine,
    chooseVariant,
    clear,
    draft: draftOf(values, loaded),
    pick,
    receiveRecord,
    removeLine,
    setPartyId,
  };
};

const CreatePanel = ({ customers, onCreated, onOpenChange, open, revision, vat }: OrderCreateDialogProps) => {
  const { language, t } = useModernI18n();
  const taxLabels = useTaxLabels();
  const ratesConfirmation = taxLabels.confirmation(vat, DateTime.nowUnsafe());
  const now = DateTime.nowUnsafe();
  const toaster = useToast();

  // The order is only on screen until Uložit sends it; picking and typing never write.
  const { addLine, chooseVariant, clear, draft, pick, receiveRecord, removeLine, setPartyId } = useCreateLines();
  const [serverError, setServerError] = useState<string | null>(null);

  const partyErrorOf = (value: Draft) => (value.partyId.trim() === '' ? t(key('create.errorCustomer')) : undefined);
  // The server snapshots the rate Tax gives the classification; without a usable one the line cannot be ordered.
  const rateErrorOf = (product: ProductRecord) => {
    const classification = lineClassification(product, vat, now);
    if (classification === null) {
      return taxLabels.noClassification;
    }
    return classification.current === undefined
      ? taxLabels.rateMissing(classification.code, classification.problem)
      : undefined;
  };

  const lineErrorsOf = (value: Draft) =>
    value.lines.map((line) => {
      if (line.picked === null) {
        return t(key('create.errorProduct'));
      }
      const product = lineProduct(line);
      if (product === null) {
        return t(key(line.record.status === 'error' ? 'create.productFailed' : 'create.productLoading'));
      }
      if (activeVariants(product).length > 0 && line.variantId === null) {
        return t(key('create.errorVariant'));
      }
      return rateErrorOf(product) ?? (isValidQuantity(line.quantity) ? undefined : t(key('create.errorQuantity')));
    });
  const partyError = partyErrorOf(draft);
  const lineErrors = lineErrorsOf(draft);

  const priced = draft.lines.flatMap((line) => {
    const product = lineProduct(line);
    const variant = product?.variantRecords?.find((entry) => entry.id === line.variantId);
    const vatRate = lineClassification(product, vat, now)?.current?.ratePercent;
    return product === null || vatRate === undefined || !isValidQuantity(line.quantity)
      ? []
      : [lineAmounts(variant?.priceMinor ?? product.currentPriceMinor, line.quantity, vatRate)];
  });
  const totals = sumAmounts(priced);

  const createFrom = (value: Draft): Effect.Effect<SaveOutcome> =>
    createOrder({ lines: linesOf(value), partyId: value.partyId.trim(), revision }).pipe(
      Effect.match({
        onFailure: (error): SaveOutcome => {
          const proposal = pendingProposalMessage(error);
          setServerError(proposal ?? (isRevisionConflict(error) ? t(key('create.conflict')) : t(key('create.failed'))));
          return proposal === undefined ? 'failed' : 'proposed';
        },
        onSuccess: (): SaveOutcome => {
          setServerError(null);
          toaster.create({ title: t(key('toast.created')), type: 'success' });
          return 'saved';
        },
      }),
    );

  const save = useDraftSave<Draft, never>({
    equals: sameDraft,
    initial: blankDraft,
    isValid: (value) => partyErrorOf(value) === undefined && lineErrorsOf(value).every((error) => error === undefined),
    // The panel stays mounted while closed: only the open panel asks before leaving.
    open,
    runtime: browserRuntime,
    save: createFrom,
    value: draft,
  });
  // Field messages show once the draft cannot be sent.
  const submitted = save.status === 'invalid';

  /** Every way out (Zrušit, the panel's dismissal, a created order) starts the next open from an empty form. */
  const startOver = () => {
    setServerError(null);
    save.adopt(clear());
  };
  const leave = () => {
    startOver();
    onOpenChange(false);
  };
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => save.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: save, navigation: blocker, onDiscard: startOver });
  const labels = saveLabelsFor(language);
  const handleSave = () => {
    save.save();
    save.afterSave((status) => {
      if (status === 'saved') {
        leave();
        onCreated();
      }
    });
  };

  return (
    <>
      <SidePanel
        actions={
          <>
            <Button appearance="outline" onClick={() => guard.request(leave)} severity="secondary">
              {t(key('create.cancel'))}
            </Button>
            <SaveBar
              error={serverError}
              labels={labels}
              onReloadLatest={constVoid}
              onSave={handleSave}
              status={save.status}
            />
          </>
        }
        description={t(key('create.description'))}
        guard={guard}
        onOpenChange={(next) => {
          if (!next) {
            leave();
          }
        }}
        open={open}
        resizeLabel={t('merchandise.sidePanel.resize')}
        size="lg"
        title={t(key('create.title'))}
      >
        <div className="flex flex-col gap-200 py-200">
          {/* Not clearable: ui-kit names the clear control "Clear value" in English; picking another customer replaces it. */}
          <Combobox<CustomerEntry>
            clearable={false}
            error={customers.status === 'error' ? t(key('create.customersFailed')) : undefined}
            helpText={submitted && partyError !== undefined ? partyError : t(key('create.customerHelp'))}
            items={customers.active.map((customer) => ({
              data: customer,
              label: customer.name ?? t('merchandise.pages.orders.customers.unknown'),
              value: customer.partyId,
            }))}
            label={t(key('create.customer'))}
            loading={customers.status === 'loading'}
            loadingMessage={t('merchandise.loading')}
            noResultsMessage={t(key('create.noCustomerMatch'))}
            onChange={(values) => {
              const partyId = firstValue(values) ?? '';
              setPartyId(partyId === '' ? null : partyId);
            }}
            onRetry={() => customers.reload()}
            placeholder={t(key('create.customerPlaceholder'))}
            renderItem={(item) => (
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{item.label}</span>
                {item.data?.companyId !== null && item.data?.companyId !== undefined && item.data.companyId !== '' && (
                  <span className="text-fg-secondary text-xs">{`IČO ${item.data.companyId}`}</span>
                )}
              </span>
            )}
            required
            retryLabel={t(key('states.retry'))}
            translations={comboboxTranslations}
            validateStatus={submitted && partyError !== undefined ? 'error' : 'default'}
            value={draft.partyId === '' ? [] : [draft.partyId]}
          />

          <div className="flex flex-col gap-150">
            <span className="font-medium text-sm">{t(key('create.lines'))}</span>
            {ratesConfirmation !== undefined && (
              <StatusText showIcon size="sm" status="warning">
                {ratesConfirmation}
              </StatusText>
            )}
            {draft.lines.map((line, index) => (
              <OrderLineEditor
                canRemove={draft.lines.length > 1}
                error={submitted ? lineErrors[index] : undefined}
                key={line.key}
                line={line}
                onPick={(picked) => pick(line.key, picked)}
                onRecord={(productId, record) => receiveRecord(line.key, productId, record)}
                onRemove={() => removeLine(line.key)}
                onVariant={(variantId) => chooseVariant(line.key, variantId)}
                quantityField={
                  <createOrderForm.lines.Item index={index}>
                    <createOrderForm.lines.quantity
                      formatOptions={WHOLE_NUMBER_FORMAT}
                      hideValueMax
                      id={`orders-create-qty-${line.key}`}
                      label={t(key('create.quantity'))}
                      locale="cs-CZ"
                      min={1}
                      name="quantity"
                      step={1}
                    />
                  </createOrderForm.lines.Item>
                }
                vat={vat}
              />
            ))}
            <div>
              <Button appearance="outline" icon="icon-[mdi--plus]" onClick={addLine} severity="secondary" size="sm">
                {t(key('create.addLine'))}
              </Button>
            </div>
          </div>

          <DetailList
            items={[
              {
                label: t(key('detail.netTotal')),
                value: <span className="tabular-nums">{formatMoney(totals.net)}</span>,
              },
              {
                label: t(key('detail.vatTotal')),
                value: <span className="tabular-nums">{formatMoney(totals.vat)}</span>,
              },
              {
                label: t(key('detail.grossTotal')),
                value: <span className="tabular-nums">{formatMoney(totals.gross)}</span>,
              },
            ]}
          />
          <p className="text-fg-secondary text-xs">{t(key('create.priceNote'))}</p>
        </div>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

/**
 * The new order panel. Its form holds the customer and the lines; the panel, its save bar and the leave question
 * render inside it, so all of them read this panel's draft. The panel renders in a portal, so the form's own box
 * takes no room.
 */
export const OrderCreateDialog = (props: OrderCreateDialogProps) => {
  const { t } = useModernI18n();
  return (
    <FormRoot className="contents" defaultValues={openingValues} form={createOrderForm} translateMessage={t}>
      <CreatePanel {...props} />
    </FormRoot>
  );
};
