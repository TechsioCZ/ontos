import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { Effect, Option } from 'effect';
import { SaveBar, dialogCloseLabel, EmptyState, formatMoney, SectionCard, useRecordDraft } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { useEffect, useRef, useState } from 'react';
import type { PriceListItem, VatRate } from '../../../../shared/apis/records.ts';
import { lineDiscountMinor } from '../../../../shared/domain/invoice-totals.ts';
import { invoiceLineKey, isPendingApproval, outcomeNotice, withOccurrenceKeys } from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceNotice, FinanceViewModel } from './finance-ui.tsx';
import type { CommandOutcome } from './use-finance-records.ts';
import { FinanceTableScroll } from './finance-table-scroll.tsx';
import {
  emptyItem,
  financeAutosaveOutcome,
  itemCommandOf,
  itemDraftOf,
  itemProblems,
  itemUnchangedSince,
  sameItemDraft,
} from './price-list-draft.ts';
import type { ItemDraft } from './price-list-draft.ts';

const VAT_CHOICES: readonly VatRate[] = [21, 12, 0];

/** Error props for a field, spread so `validateStatus` is absent (not undefined) when the field is valid. */
const invalidField = (invalid: boolean, message: string) =>
  invalid ? { helpText: message, validateStatus: 'error' as const } : {};

/** The fields of one price list item, shared by the create dialog and the autosaving edit dialog. */
const PriceItemFields = ({
  draft,
  onChange,
  showErrors,
}: {
  readonly draft: ItemDraft;
  readonly onChange: (patch: Partial<ItemDraft>) => void;
  readonly showErrors: boolean;
}) => {
  const { t } = useModernI18n();
  const problems = itemProblems(draft);
  return (
    <>
      <FormInput
        id="price-name"
        label={t('finance-billing.financeUi.priceList.serviceName')}
        onChange={(event) => onChange({ name: event.target.value })}
        placeholder={t('finance-billing.financeUi.priceList.serviceExample')}
        size="sm"
        value={draft.name}
        {...invalidField(showErrors && problems.name, t('finance-billing.financeUi.priceList.nameRequired'))}
      />
      <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
        <FormInput
          id="price-code"
          label={t('finance-billing.financeUi.priceList.code')}
          onChange={(event) => onChange({ code: event.target.value })}
          size="sm"
          value={draft.code}
        />
        <FormInput
          id="price-unit"
          label={t('finance-billing.financeUi.priceList.unit')}
          onChange={(event) => onChange({ unit: event.target.value })}
          placeholder={t('finance-billing.financeUi.priceList.unitExamples')}
          size="sm"
          value={draft.unit}
        />
      </div>
      <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
        <FormInput
          id="price-amount"
          inputMode="decimal"
          label={t('finance-billing.financeUi.priceList.netPrice')}
          onChange={(event) => onChange({ price: event.target.value })}
          size="sm"
          value={draft.price}
          {...invalidField(showErrors && problems.price, t('finance-billing.financeUi.priceList.priceRequired'))}
        />
        <SelectTemplate
          items={VAT_CHOICES.map((rate) => ({
            displayValue: `${rate} %`,
            label: `${rate} %`,
            value: String(rate),
          }))}
          label={t('finance-billing.financeUi.common.vatRate')}
          labelProps={{ className: 'font-label text-label-md' }}
          onValueChange={({ value }) => {
            const rate = VAT_CHOICES.find((entry) => String(entry) === value[0]);
            if (rate !== undefined) {
              onChange({ vatRate: rate });
            }
          }}
          size="sm"
          value={[String(draft.vatRate)]}
        />
      </div>
    </>
  );
};

/**
 * Edit one price list item. Changes save themselves (debounced, on blur and on Zavřít) only while the price list
 * still has the item as the draft started from; when someone else changed it, the dialog offers the current version.
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
  const { t } = useModernI18n();
  const [error, setError] = useState<FinanceNotice>();
  const server = itemDraftOf(item);
  /** The version of the item the draft builds on: what it opened with, last saved or reloaded. */
  const base = useRef(server);
  const settle = (value: ItemDraft, outcome: CommandOutcome) => {
    // The autosave status line already reports a conflict and a proposal waiting for approval.
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
          Effect.map(financeAutosaveOutcome),
        )
      : Effect.succeed<SaveOutcome>('conflict');
  const autosave = useRecordDraft<ItemDraft, never>({
    equals: sameItemDraft,
    isValid: (value) => Option.isSome(itemCommandOf(value, item, vm.actorLabel)),
    runtime: financeBrowserRuntime,
    save: (value) =>
      Option.match(itemCommandOf(value, item, vm.actorLabel), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: (command) => send(value, command),
      }),
    server,
  });
  const settledOnServer = !autosave.pending && sameItemDraft(autosave.draft, server);
  useEffect(() => {
    if (settledOnServer) {
      base.current = server;
    }
  }, [base, server, settledOnServer]);
  const close = () => {
    onClose();
  };
  const handleChange = (patch: Partial<ItemDraft>) => autosave.setDraft((current) => ({ ...current, ...patch }));
  const handleSave = autosave.save;
  const handleReloadLatest = autosave.reloadLatest;
  return (
    <Dialog
      actions={
        <>
          <SaveBar onReloadLatest={handleReloadLatest} onSave={handleSave} status={autosave.status} />
          <Button onClick={close} theme="outlined" variant="secondary">
            {t('finance-billing.financeUi.priceList.close')}
          </Button>
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
      <div className="flex flex-col gap-150">
        {error !== undefined && (
          <StatusText showIcon size="sm" status={error.status}>
            {error.text}
          </StatusText>
        )}
        <PriceItemFields draft={autosave.draft} onChange={handleChange} showErrors />
      </div>
    </Dialog>
  );
};

/** S07.R4: the company price list; invoice lines copy a snapshot of an item, discounts are approved per line. */
const priceListPanelSaveProgram = Effect.fn('Finance.save')(function* priceListPanelSaveProgram(
  context: Pick<ReturnType<typeof usePriceListPanel>, 'draft' | 'setDraft' | 'setError' | 'vm'>,
) {
  const { draft, setDraft, setError, vm } = context;
  if (draft === undefined) {
    return;
  }
  const command = itemCommandOf(draft, undefined, vm.actorLabel);
  if (Option.isNone(command)) {
    setError({ status: 'error', text: 'Vyplňte název a cenu bez DPH (např. 1 500 nebo 1 500,50).' });
    return;
  }
  const outcome = yield* vm.execute(command.value, 'Položka ceníku přidána');
  if (outcome.ok) {
    setDraft(undefined);
    setError(undefined);
  } else {
    setError(outcomeNotice(vm, outcome));
  }
});

const usePriceListPanel = ({ vm }: { readonly vm: FinanceViewModel }) => {
  const items = (vm.snapshot?.state.priceList ?? []).toSorted(
    (left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name, 'cs'),
  );
  /** A new item being created; an existing item is edited (and autosaved) in its own dialog. */
  const [draft, setDraft] = useState<ItemDraft>();
  const [editingId, setEditingId] = useState<string>();
  const [error, setError] = useState<FinanceNotice>();
  const discounted = (vm.snapshot?.state.invoices ?? [])
    .flatMap((invoice) =>
      (invoice.businessState === 'VOIDED' ? [] : (invoice.lines ?? [])).flatMap((line) =>
        line.discount === undefined ? [] : [{ invoice, line, minor: lineDiscountMinor(line) }],
      ),
    )
    .slice(0, 12);

  const save = (): void => {
    void financeBrowserRuntime.runPromise(priceListPanelSaveProgram({ draft, setDraft, setError, vm }));
  };

  const toggle = (item: PriceListItem) => {
    const upsertPriceListItemCommand: FinanceCommandDraft<'UpsertPriceListItem'> = {
      _tag: 'UpsertPriceListItem',
      active: !item.active,
      id: item.id,
      name: item.name,
      unitPriceMinor: item.unitPriceMinor,
      vatRate: item.vatRate,
    };
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
  return { discounted, draft, editingId, error, items, save, setDraft, setEditingId, setError, toggle, vm };
};

export const PriceListPanel = (props: { readonly vm: FinanceViewModel }) => {
  const { t } = useModernI18n();
  const { discounted, draft, editingId, error, items, save, setDraft, setEditingId, setError, toggle, vm } =
    usePriceListPanel(props);
  const editing = items.find((item) => item.id === editingId);
  return (
    <div className="flex flex-col gap-500">
      <SectionCard
        actions={
          vm.canWrite ? (
            <Button
              icon="icon-[mdi--plus]"
              onClick={() => {
                setError(undefined);
                setDraft(emptyItem);
              }}
              size="sm"
              variant="primary"
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
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Položka</Table.ColumnHeader>
                  <Table.ColumnHeader>Jednotka</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Cena bez DPH</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">DPH</Table.ColumnHeader>
                  <Table.ColumnHeader>Stav</Table.ColumnHeader>
                  <Table.ColumnHeader align="end" />
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
                      {item.vatRate} %
                    </Table.Cell>
                    <Table.Cell>
                      <Badge size="sm" variant={item.active ? 'success' : 'warning'}>
                        {item.active ? 'V nabídce' : 'Vyřazeno'}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell align="end">
                      {vm.canWrite && (
                        <span className="flex justify-end gap-50">
                          <Button
                            aria-label={`Upravit ${item.name}`}
                            icon="icon-[mdi--pencil-outline]"
                            onClick={() => setEditingId(item.id)}
                            size="sm"
                            theme="borderless"
                            variant="secondary"
                          />
                          <Button
                            className="whitespace-nowrap"
                            onClick={() => toggle(item)}
                            size="sm"
                            theme="borderless"
                            variant="secondary"
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
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Doklad</Table.ColumnHeader>
                  <Table.ColumnHeader>Položka</Table.ColumnHeader>
                  <Table.ColumnHeader>Sleva</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Částka slevy</Table.ColumnHeader>
                  <Table.ColumnHeader>Důvod</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {withOccurrenceKeys(
                  discounted,
                  ({ invoice, line }) => `${invoice.ref.resourceId}:${invoiceLineKey(line)}`,
                ).map(({ key, value: { invoice, line, minor } }) => (
                  <Table.Row key={key}>
                    <Table.Cell className="whitespace-nowrap">
                      <a className="underline" href={`?resourceId=${encodeURIComponent(invoice.ref.resourceId)}`}>
                        {invoice.number ?? invoice.documentNumber}
                      </a>
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
      <Dialog
        actions={
          <>
            <Button onClick={() => setDraft(undefined)} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button
              isLoading={vm.busy}
              onClick={() => {
                save();
              }}
              variant="primary"
            >
              {t('finance-billing.financeUi.priceList.save')}
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={t('finance-billing.financeUi.priceList.priceHint')}
        onOpenChange={(details) => {
          if (!details.open) {
            setDraft(undefined);
          }
        }}
        open={draft !== undefined}
        placement="center"
        size="md"
        title={t('finance-billing.financeUi.priceList.addTitle')}
      >
        {draft !== undefined && (
          <div className="flex flex-col gap-150">
            {error !== undefined && (
              <StatusText showIcon size="sm" status={error.status}>
                {error.text}
              </StatusText>
            )}
            <PriceItemFields
              draft={draft}
              onChange={(patch) => setDraft({ ...draft, ...patch })}
              showErrors={error?.status === 'error'}
            />
          </div>
        )}
      </Dialog>
      {editing !== undefined && (
        <PriceItemEditDialog item={editing} key={editing.id} onClose={() => setEditingId(undefined)} vm={vm} />
      )}
    </div>
  );
};
