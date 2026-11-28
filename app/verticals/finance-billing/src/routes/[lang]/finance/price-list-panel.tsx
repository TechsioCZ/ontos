import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { financeBrowserAtomRuntime, financeBrowserRuntime } from '../../../runtime/browser.ts';
import { DateTime, Effect, Option, Schema } from 'effect';
import {
  SaveBar,
  SectionCard,
  UnsavedChangesDialog,
  dialogCloseLabel,
  EmptyState,
  formatMoney,
  saveLabelsFor,
  useDraftSave,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import {
  FlaggedTextField,
  FormBuilder,
  FormReact,
  FormRoot,
  TextField,
  useAtomSet,
  useAtomSubscribe,
} from '@app/core-runtime/ui/form';
import { Table } from '@techsio/ui-kit/organisms/table';
import { useEffect, useRef, useState } from 'react';
import type { PriceListItem } from '../../../../shared/apis/records.ts';
import { defaultLineVatChoice, lineVatOf } from '../../../../shared/domain/line-vat.ts';
import { lineDiscountMinor } from '../../../../shared/domain/invoice-totals.ts';
import { invoiceLineKey, isPendingApproval, outcomeNotice, withOccurrenceKeys } from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceNotice, FinanceViewModel } from './finance-ui.tsx';
import type { CommandOutcome } from './use-finance-records.ts';
import { FinanceTableScroll } from './finance-table-scroll.tsx';
import { useFormDraft } from './finance-form-draft.tsx';
import {
  emptyItem,
  financeSaveOutcome,
  itemCommandOf,
  itemDraftOf,
  itemProblems,
  itemUnchangedSince,
  sameItemDraft,
} from './price-list-draft.ts';
import type { ItemDraft } from './price-list-draft.ts';
import { choicesOf, useVatChoices } from './use-vat-choices.ts';
import type { VatChoicesState } from './use-vat-choices.ts';
import { LineVatChoiceSchema, VatChoiceField, VatLabel } from './vat-choice-select.tsx';

/** The company's VAT today: a price-list item stores the classification, its rate as Tax publishes it today. */
const useTodayVatChoices = (vm: FinanceViewModel): VatChoicesState =>
  useVatChoices(vm.scope, vm.referenceDate === '' ? DateTime.formatIsoDateUtc(DateTime.nowUnsafe()) : vm.referenceDate);

/** One price list item as typed; the dialog's save bar sends it, so the form only holds it. */
const makeItemForm = () =>
  FormReact.make(
    FormBuilder.empty
      .addField('code', Schema.String)
      .addField('name', Schema.String)
      .addField('price', Schema.String)
      .addField('unit', Schema.String)
      .addField('vat', LineVatChoiceSchema),
    {
      fields: {
        code: TextField,
        name: FlaggedTextField,
        price: FlaggedTextField,
        unit: TextField,
        vat: VatChoiceField,
      },
      onSubmit: () => Effect.void,
      runtime: financeBrowserAtomRuntime,
    },
  );

/**
 * The edit and the create dialog each have their own form, so a draft typed in one never shows in the other. One
 * dialog of each kind is open at a time: the panel opens a single edited item and a single new item.
 */
const itemEditForm = makeItemForm();
const itemCreateForm = makeItemForm();
type ItemForm = typeof itemEditForm;

/** The fields of one price list item, shared by the create dialog and the edit dialog: the form's bound fields. */
const PriceItemFields = ({
  draft,
  fields,
  showErrors,
  vat,
}: {
  readonly draft: ItemDraft;
  readonly fields: ItemForm;
  readonly showErrors: boolean;
  readonly vat: VatChoicesState;
}) => {
  const { t } = useModernI18n();
  const problems = itemProblems(draft);
  const nameInvalid = showErrors && problems.name;
  const priceInvalid = showErrors && problems.price;
  return (
    <>
      <fields.name
        helpText={nameInvalid ? t('finance-billing.financeUi.priceList.nameRequired') : undefined}
        id="price-name"
        invalid={nameInvalid}
        label={t('finance-billing.financeUi.priceList.serviceName')}
        placeholder={t('finance-billing.financeUi.priceList.serviceExample')}
        size="sm"
      />
      <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
        <fields.code id="price-code" label={t('finance-billing.financeUi.priceList.code')} size="sm" />
        <fields.unit
          id="price-unit"
          label={t('finance-billing.financeUi.priceList.unit')}
          placeholder={t('finance-billing.financeUi.priceList.unitExamples')}
          size="sm"
        />
      </div>
      <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
        <fields.price
          helpText={priceInvalid ? t('finance-billing.financeUi.priceList.priceRequired') : undefined}
          id="price-amount"
          inputMode="decimal"
          invalid={priceInvalid}
          label={t('finance-billing.financeUi.priceList.netPrice')}
          size="sm"
        />
        <fields.vat
          direction="OUTGOING"
          invalid={showErrors && lineVatOf(draft.vat, choicesOf(vat)) === undefined}
          name="price-vat"
          vat={vat}
        />
      </div>
    </>
  );
};

/** Exactly the same input in every field; the draft's own equality ignores surrounding spaces. */
const sameTyped = (left: ItemDraft, right: ItemDraft) =>
  left.code === right.code &&
  left.name === right.name &&
  left.price === right.price &&
  left.unit === right.unit &&
  sameItemDraft(left, right);

/**
 * Keeps the edit form's values and the record draft the same: typing goes into the draft, and a draft the record
 * replaced (Zahodit změny, Načíst aktuální verzi, a newer server version) goes back into the form.
 */
const DraftValues = ({
  draft,
  onTyped,
}: {
  readonly draft: ItemDraft;
  readonly onTyped: (value: ItemDraft) => void;
}) => {
  const setValues = useAtomSet(itemEditForm.setValues);
  const shown = useRef(draft);
  useAtomSubscribe(
    itemEditForm.values,
    (values) => {
      if (Option.isSome(values) && !sameTyped(values.value, shown.current)) {
        shown.current = values.value;
        onTyped(values.value);
      }
    },
    // Immediate: a subscription that does not read the value first never hears a change of a value not read yet.
    { immediate: true },
  );
  useEffect(() => {
    if (!sameTyped(draft, shown.current)) {
      shown.current = draft;
      setValues(draft);
    }
  }, [draft, setValues]);
  return null;
};

/**
 * Edit one price list item. Changes stay on screen until Uložit; leaving with unsaved changes asks first. The save
 * is sent only while the price list still has the item as the draft started from; when someone else changed it, the
 * dialog offers the current version.
 */
const PriceItemEditDialog = ({
  item,
  onClose,
  vm,
}: {
  readonly item: PriceListItem;
  readonly onClose: () => void;
  readonly vm: FinanceViewModel;
}) => {
  const { language, t } = useModernI18n();
  const [error, setError] = useState<FinanceNotice>();
  const vat = useTodayVatChoices(vm);
  const choices = choicesOf(vat);
  const server = itemDraftOf(item);
  /** The version of the item the draft builds on: what it opened with, last saved or reloaded. */
  const base = useRef(server);
  const settle = (value: ItemDraft, outcome: CommandOutcome) => {
    // The status line already reports a conflict and a proposal waiting for approval.
    setError(
      outcome.ok || outcome.feedback === 'conflict' || isPendingApproval(outcome)
        ? undefined
        : outcomeNotice(vm, outcome),
    );
    if (outcome.ok) {
      base.current = value;
    }
  };
  const send = (value: ItemDraft, command: FinanceCommandDraft<'UpsertPriceListItem'>) =>
    itemUnchangedSince(item.id, base.current)(vm.snapshot?.state.priceList ?? [])
      ? vm.execute(command).pipe(
          Effect.tap((outcome) => Effect.sync(() => settle(value, outcome))),
          Effect.map(financeSaveOutcome),
        )
      : Effect.succeed<SaveOutcome>('conflict');
  const record = useRecordDraft<ItemDraft, never>({
    equals: sameItemDraft,
    isValid: (value) => Option.isSome(itemCommandOf(value, choices, item, vm.actorLabel)),
    runtime: financeBrowserRuntime,
    save: (value) =>
      Option.match(itemCommandOf(value, choices, item, vm.actorLabel), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: (command) => send(value, command),
      }),
    server,
  });
  const settledOnServer = !record.pending && sameItemDraft(record.draft, server);
  useEffect(() => {
    if (settledOnServer) {
      base.current = server;
    }
  }, [base, server, settledOnServer]);
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  const close = () => {
    guard.request(onClose);
  };
  const labels = saveLabelsFor(language);
  const handleReloadLatest = record.reloadLatest;
  const handleSave = record.save;
  const handleTyped = record.setDraft;
  return (
    <>
      <Dialog
        actions={
          <>
            <Button appearance="outline" onClick={close} severity="secondary">
              {t('finance-billing.financeUi.priceList.close')}
            </Button>
            <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={t('finance-billing.financeUi.priceList.priceHint')}
        onOpenChange={(details) => {
          if (!details.open) {
            close();
          }
        }}
        open
        placement="center"
        size="md"
        title={t('finance-billing.financeUi.priceList.editTitle')}
      >
        <FormRoot
          className="flex flex-col gap-150"
          defaultValues={record.draft}
          form={itemEditForm}
          translateMessage={t}
        >
          <DraftValues draft={record.draft} onTyped={handleTyped} />
          {error !== undefined && (
            <StatusText showIcon size="sm" status={error.status}>
              {error.text}
            </StatusText>
          )}
          <PriceItemFields draft={record.draft} fields={itemEditForm} showErrors vat={vat} />
        </FormRoot>
      </Dialog>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

/**
 * A new price list item. The draft stays on screen until Uložit; leaving with unsaved input asks first. Uložit sends
 * the item once and closes the dialog when the price list accepted it.
 */
const PriceItemCreateDialog = ({
  initial,
  onClose,
  vm,
}: {
  readonly initial: ItemDraft;
  readonly onClose: () => void;
  readonly vm: FinanceViewModel;
}) => {
  const { language, t } = useModernI18n();
  const { draft, ready, reset } = useFormDraft(itemCreateForm, initial);
  const [error, setError] = useState<FinanceNotice>();
  const vat = useTodayVatChoices(vm);
  const choices = choicesOf(vat);
  const settle = (outcome: Parameters<typeof financeSaveOutcome>[0]) => {
    setError(outcome.ok ? undefined : outcomeNotice(vm, outcome));
    if (outcome.ok) {
      onClose();
    }
  };
  const settled = (outcome: Parameters<typeof financeSaveOutcome>[0]) => Effect.sync(() => settle(outcome));
  const record = useDraftSave<ItemDraft, never>({
    isValid: (value) => Option.isSome(itemCommandOf(value, choices, undefined, vm.actorLabel)),
    runtime: financeBrowserRuntime,
    save: (value) =>
      Option.match(itemCommandOf(value, choices, undefined, vm.actorLabel), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: (command) =>
          vm.execute(command, 'Položka ceníku přidána').pipe(Effect.tap(settled), Effect.map(financeSaveOutcome)),
      }),
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: () => reset(initial) });
  const labels = saveLabelsFor(language);
  const close = () => {
    guard.request(onClose);
  };
  const handleSave = record.save;
  return (
    <>
      <Dialog
        actions={
          <>
            <Button appearance="outline" onClick={close} severity="secondary">
              {t('finance-billing.financeUi.priceList.cancel')}
            </Button>
            <SaveBar labels={labels} onReloadLatest={() => reset(initial)} onSave={handleSave} status={record.status} />
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={t('finance-billing.financeUi.priceList.priceHint')}
        onOpenChange={(details) => {
          if (!details.open) {
            close();
          }
        }}
        open
        placement="center"
        size="md"
        title={t('finance-billing.financeUi.priceList.addTitle')}
      >
        <FormRoot className="flex flex-col gap-150" defaultValues={initial} form={itemCreateForm} translateMessage={t}>
          {ready}
          {error !== undefined && (
            <StatusText showIcon size="sm" status={error.status}>
              {error.text}
            </StatusText>
          )}
          <PriceItemFields
            draft={draft}
            fields={itemCreateForm}
            showErrors={record.status === 'invalid' || error?.status === 'error'}
            vat={vat}
          />
        </FormRoot>
      </Dialog>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

/** S07.R4: the company price list; invoice lines copy a snapshot of an item, discounts are approved per line. */
const usePriceListPanel = ({ vm }: { readonly vm: FinanceViewModel }) => {
  const items = (vm.snapshot?.state.priceList ?? []).toSorted(
    (left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name, 'cs'),
  );
  /** A new item being opened; an existing item is edited in its own dialog. */
  const [draft, setDraft] = useState<ItemDraft>();
  const [editingId, setEditingId] = useState<string>();
  const discounted = (vm.snapshot?.state.invoices ?? [])
    .flatMap((invoice) =>
      (invoice.businessState === 'VOIDED' ? [] : (invoice.lines ?? [])).flatMap((line) =>
        line.discount === undefined ? [] : [{ invoice, line, minor: lineDiscountMinor(line) }],
      ),
    )
    .slice(0, 12);

  const toggle = (item: PriceListItem) => {
    const upsertPriceListItemCommand: FinanceCommandDraft<'UpsertPriceListItem'> = {
      _tag: 'UpsertPriceListItem',
      active: !item.active,
      id: item.id,
      name: item.name,
      unitPriceMinor: item.unitPriceMinor,
      // Offering or withdrawing an item leaves its VAT exactly as stored.
      vatRate: item.vatRate,
    };
    if (item.vatClassification !== undefined) {
      upsertPriceListItemCommand.vatClassification = item.vatClassification;
    }
    if (item.vatTreatment !== undefined) {
      upsertPriceListItemCommand.vatTreatment = item.vatTreatment;
    }
    if (item.code !== undefined) {
      upsertPriceListItemCommand.code = item.code;
    }
    if (item.unit !== undefined) {
      upsertPriceListItemCommand.unit = item.unit;
    }
    void financeBrowserRuntime.runPromise(
      vm.execute(upsertPriceListItemCommand, item.active ? 'Položka vyřazena z nabídky' : 'Položka znovu v nabídce'),
    );
  };
  return { discounted, draft, editingId, items, setDraft, setEditingId, toggle, vm };
};

export const PriceListPanel = (props: { readonly vm: FinanceViewModel }) => {
  const { t } = useModernI18n();
  const { discounted, draft, editingId, items, setDraft, setEditingId, toggle, vm } = usePriceListPanel(props);
  const editing = items.find((item) => item.id === editingId);
  return (
    <div className="flex flex-col gap-500">
      <SectionCard
        actions={
          vm.canWrite ? (
            <Button
              icon="icon-[mdi--plus]"
              onClick={() => {
                setDraft(emptyItem(defaultLineVatChoice('OUTGOING')));
              }}
              severity="primary"
              size="sm"
            >
              {t('finance-billing.financeUi.priceList.addTitle')}
            </Button>
          ) : undefined
        }
        flush
        title={t('finance-billing.financeUi.priceList.title')}
      >
        <p className="px-250 pb-150 text-fg-secondary text-sm">
          Položku ceníku vyberete na řádku faktury (Z ceníku). Řádek si uloží kopii ceny – pozdější změna ceníku už
          vystavené doklady nemění. Slevu schvalujete na řádku dokladu i s důvodem.
        </p>
        {items.length === 0 ? (
          <div className="px-250 pb-250">
            <EmptyState
              description="Přidejte první službu, kterou fakturujete."
              title={t('finance-billing.financeUi.priceList.empty')}
            />
          </div>
        ) : (
          <FinanceTableScroll label={t('finance-billing.financeUi.priceList.title')}>
            <Table appearance="line" size="sm">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader className="whitespace-nowrap">Položka</Table.ColumnHeader>
                  <Table.ColumnHeader className="whitespace-nowrap">Jednotka</Table.ColumnHeader>
                  <Table.ColumnHeader align="end" className="whitespace-nowrap">
                    Cena bez DPH
                  </Table.ColumnHeader>
                  <Table.ColumnHeader align="end" className="whitespace-nowrap">
                    DPH
                  </Table.ColumnHeader>
                  <Table.ColumnHeader className="whitespace-nowrap">Stav</Table.ColumnHeader>
                  <Table.ColumnHeader align="end" className="whitespace-nowrap" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {items.map((item) => (
                  <Table.Row key={item.id}>
                    <Table.Cell>
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium">{item.name}</span>
                        {item.code !== undefined && <span className="text-fg-secondary text-xs">{item.code}</span>}
                      </span>
                    </Table.Cell>
                    <Table.Cell>{item.unit ?? '—'}</Table.Cell>
                    <Table.Cell align="end" className="whitespace-nowrap tabular-nums">
                      {formatMoney(item.unitPriceMinor)}
                    </Table.Cell>
                    <Table.Cell align="end" className="tabular-nums">
                      <VatLabel line={item} />
                    </Table.Cell>
                    <Table.Cell>
                      <Badge severity={item.active ? 'success' : 'warning'} size="sm">
                        {item.active ? 'V nabídce' : 'Vyřazeno'}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell align="end">
                      {vm.canWrite && (
                        <span className="flex justify-end gap-50">
                          <Button
                            appearance="ghost"
                            aria-label={`Upravit ${item.name}`}
                            icon="icon-[mdi--pencil-outline]"
                            onClick={() => setEditingId(item.id)}
                            severity="secondary"
                            size="sm"
                          />
                          <Button
                            appearance="ghost"
                            className="whitespace-nowrap"
                            onClick={() => toggle(item)}
                            severity="secondary"
                            size="sm"
                          >
                            {item.active ? 'Vyřadit' : 'Obnovit'}
                          </Button>
                        </span>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </FinanceTableScroll>
        )}
      </SectionCard>
      <SectionCard flush title={t('finance-billing.financeUi.priceList.approvedDiscounts')}>
        {discounted.length === 0 ? (
          <p className="px-250 pb-250 text-fg-secondary text-sm">Zatím žádný doklad nemá schválenou slevu.</p>
        ) : (
          <FinanceTableScroll label={t('finance-billing.financeUi.priceList.approvedDiscounts')}>
            <Table appearance="line" size="sm">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader className="whitespace-nowrap">Doklad</Table.ColumnHeader>
                  <Table.ColumnHeader className="whitespace-nowrap">Položka</Table.ColumnHeader>
                  <Table.ColumnHeader className="whitespace-nowrap">Sleva</Table.ColumnHeader>
                  <Table.ColumnHeader align="end" className="whitespace-nowrap">
                    Částka slevy
                  </Table.ColumnHeader>
                  <Table.ColumnHeader className="whitespace-nowrap">Důvod</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {withOccurrenceKeys(
                  discounted,
                  ({ invoice, line }) => `${invoice.ref.resourceId}:${invoiceLineKey(line)}`,
                ).map(({ key, value: { invoice, line, minor } }) => (
                  <Table.Row key={key}>
                    <Table.Cell className="whitespace-nowrap">
                      <Link href={`?resourceId=${encodeURIComponent(invoice.ref.resourceId)}`} size="current">
                        {invoice.number ?? invoice.documentNumber}
                      </Link>
                    </Table.Cell>
                    <Table.Cell>{line.description}</Table.Cell>
                    <Table.Cell className="whitespace-nowrap">
                      {line.discount?.kind === 'PERCENT' ? `${line.discount.value} %` : 'částkou'}
                    </Table.Cell>
                    <Table.Cell align="end" className="whitespace-nowrap tabular-nums">
                      − {formatMoney(minor)}
                    </Table.Cell>
                    <Table.Cell className="max-w-64">{line.discount?.reason}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </FinanceTableScroll>
        )}
      </SectionCard>
      {draft !== undefined && <PriceItemCreateDialog initial={draft} onClose={() => setDraft(undefined)} vm={vm} />}
      {editing !== undefined && (
        <PriceItemEditDialog item={editing} key={editing.id} onClose={() => setEditingId(undefined)} vm={vm} />
      )}
    </div>
  );
};
