import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { Effect } from 'effect';
import { dialogCloseLabel, EmptyState, formatDate, formatMoney, SectionCard } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { PlanItem } from '../../../../shared/apis/records.ts';
import { planItemWeightedMinor } from '../../../../shared/domain/finance-planning.ts';
import { minorToInput, outcomeMessage, parseAmountMinor } from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';
import { FinanceTableScroll } from './finance-table-scroll.tsx';
import { emptyObjectSelection, objectAnchors, ObjectFields, objectSummary } from './object-fields.tsx';
import type { ObjectSelection } from './object-fields.tsx';

interface PlanDraft {
  readonly amount: string;
  readonly existing?: Pick<PlanItem, 'contractRef' | 'propertyRef' | 'unitRef'>;
  readonly expectedDate: PlanItem['expectedDate'];
  readonly id?: string;
  readonly kind: PlanItem['kind'];
  readonly note: string;
  readonly object: ObjectSelection;
  readonly probability: string;
  readonly projectName: string;
  readonly title: string;
}

const newPlanDraft = (date: string): PlanDraft => ({
  amount: '',
  expectedDate: date,
  kind: 'REVENUE',
  note: '',
  object: emptyObjectSelection,
  probability: '',
  projectName: '',
  title: '',
});

export const editPlanItemDraft = (item: PlanItem): PlanDraft => ({
  amount: minorToInput(item.amountMinor),
  existing: item,
  expectedDate: item.expectedDate,
  id: item.id,
  kind: item.kind,
  note: item.note ?? '',
  object: {
    contractId: item.contractRef?.resourceId ?? '',
    costCenter: '',
    propertyId: item.propertyRef?.resourceId ?? '',
    unitId: item.unitRef?.resourceId ?? '',
  },
  probability: item.probabilityPercent === undefined ? '' : String(item.probabilityPercent),
  projectName: item.projectName ?? '',
  title: item.title,
});

const relationText = (vm: FinanceViewModel, item: PlanItem) =>
  [
    objectSummary(vm.objects, item),
    item.contractRef === undefined
      ? undefined
      : `smlouva ${vm.objects.contractName(item.contractRef.resourceId) ?? '(bez přístupu k názvu)'}`,
    item.projectName === undefined ? undefined : `projekt ${item.projectName}`,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');

export const buildPlanItemCommand = ({
  amountMinor,
  draft,
  probability,
  vm,
}: {
  readonly amountMinor: number;
  readonly draft: PlanDraft;
  readonly probability?: number | undefined;
  readonly vm: Pick<FinanceViewModel, 'actorLabel' | 'objects'>;
}): FinanceCommandDraft<'UpsertPlanItem'> => {
  const upsertPlanItemCommand: FinanceCommandDraft<'UpsertPlanItem'> = {
    _tag: 'UpsertPlanItem',
    amountMinor,
    currency: 'CZK',
    expectedDate: draft.expectedDate,
    kind: draft.kind,
    title: draft.title.trim(),
    ...(({ costCenter: _costCenter, ...anchors }) => anchors)(
      objectAnchors(vm.objects, draft.object, draft.id === undefined ? undefined : draft.existing),
    ),
  };
  if (vm.actorLabel !== undefined) {
    upsertPlanItemCommand.actorLabel = vm.actorLabel;
  }
  if (draft.id !== undefined) {
    upsertPlanItemCommand.id = draft.id;
  }
  if (draft.note.trim() !== '') {
    upsertPlanItemCommand.note = draft.note.trim();
  }
  if (probability !== undefined) {
    upsertPlanItemCommand.probabilityPercent = probability;
  }
  if (draft.projectName.trim() !== '') {
    upsertPlanItemCommand.projectName = draft.projectName.trim();
  }
  return upsertPlanItemCommand;
};

/** S09 item 1: expected income/expense with amount, currency, expected date, optional probability and relation. */
const planItemsSaveProgram = Effect.fn('Finance.save')(function* planItemsSaveProgram(
  context: Pick<ReturnType<typeof usePlanItems>, 'draft' | 'setDraft' | 'setError' | 'vm'>,
) {
  const { draft, setDraft, setError, vm } = context;
  if (draft === undefined) {
    return;
  }
  const amountMinor = parseAmountMinor(draft.amount);
  const probability = draft.probability.trim() === '' ? undefined : Number(draft.probability.replace('%', '').trim());
  if (draft.title.trim() === '' || amountMinor === undefined || amountMinor === 0 || draft.expectedDate === '') {
    setError('Vyplňte název, kladnou částku a očekávané datum.');
    return;
  }
  if (probability !== undefined && (!Number.isInteger(probability) || probability < 1 || probability > 100)) {
    setError('Pravděpodobnost zadejte jako celé číslo 1–100 %, nebo ji nechte prázdnou.');
    return;
  }
  const upsertPlanItemCommand = buildPlanItemCommand({ amountMinor, draft, probability, vm });
  const outcome = yield* vm.execute(
    upsertPlanItemCommand,
    draft.id === undefined ? 'Položka finančního plánu přidána' : 'Položka finančního plánu uložena',
  );
  if (outcome.ok) {
    setDraft(undefined);
    setError(undefined);
  } else {
    setError(outcomeMessage(vm, outcome));
  }
});

const usePlanItems = ({ vm }: { readonly vm: FinanceViewModel }) => {
  const items = (vm.snapshot?.state.planItems ?? []).toSorted((left, right) =>
    left.expectedDate.localeCompare(right.expectedDate),
  );
  const today = vm.referenceDate === '' ? '2026-10-21' : vm.referenceDate;
  const [draft, setDraft] = useState<PlanDraft>();
  const [deleteTarget, setDeleteTarget] = useState<PlanItem>();
  const [error, setError] = useState<string>();
  const totalIn = items
    .filter((item) => item.kind === 'REVENUE')
    .reduce((sum, item) => sum + planItemWeightedMinor(item), 0);
  const totalOut = items
    .filter((item) => item.kind === 'COST')
    .reduce((sum, item) => sum + planItemWeightedMinor(item), 0);

  const save = (): void => {
    void financeBrowserRuntime.runPromise(planItemsSaveProgram({ draft, setDraft, setError, vm }));
  };

  return { deleteTarget, draft, error, items, save, setDeleteTarget, setDraft, setError, today, totalIn, totalOut, vm };
};

export const PlanItemsSection = (props: { readonly vm: FinanceViewModel }) => {
  const { t } = useModernI18n();
  const { deleteTarget, draft, error, items, save, setDeleteTarget, setDraft, setError, today, totalIn, totalOut, vm } =
    usePlanItems(props);
  return (
    <SectionCard
      actions={
        vm.canWrite ? (
          <Button
            icon="icon-[mdi--plus]"
            onClick={() => {
              setError(undefined);
              setDraft(newPlanDraft(today));
            }}
            size="sm"
            variant="primary"
          >
            Nová položka plánu
          </Button>
        ) : undefined
      }
      title={t('finance-billing.financeUi.plan.title')}
    >
      <p className="text-fg-secondary text-sm">
        Ruční plán mimo vystavené doklady, např. očekávaný nájem nové haly nebo plánovaná oprava. Do cash-flow se
        započítá v měsíci očekávaného data, vážený pravděpodobností. Nejde o účetní skutečnost.
      </p>
      {items.length === 0 ? (
        <EmptyState
          description="Přidejte očekávaný příjem nebo výdaj."
          title={t('finance-billing.financeUi.plan.empty')}
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-300 text-sm">
            <span>
              Očekávané příjmy (vážené) <strong className="tabular-nums">{formatMoney(totalIn)}</strong>
            </span>
            <span>
              Očekávané výdaje (vážené) <strong className="tabular-nums">{formatMoney(totalOut)}</strong>
            </span>
          </div>
          <FinanceTableScroll label={t('finance-billing.financeUi.plan.table')}>
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Položka</Table.ColumnHeader>
                  <Table.ColumnHeader>Typ</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Částka</Table.ColumnHeader>
                  <Table.ColumnHeader>Očekávané datum</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Pravděpodobnost</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Vážená částka</Table.ColumnHeader>
                  <Table.ColumnHeader>Vztah</Table.ColumnHeader>
                  <Table.ColumnHeader align="end" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {items.map((item) => (
                  <Table.Row key={item.id}>
                    <Table.Cell>
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium">{item.title}</span>
                        {item.note !== undefined && <span className="text-fg-secondary text-xs">{item.note}</span>}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge size="sm" variant={item.kind === 'COST' ? 'warning' : 'success'}>
                        {item.kind === 'COST' ? 'Výdaj' : 'Příjem'}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell align="end" className="whitespace-nowrap tabular-nums">
                      {formatMoney(item.amountMinor)} {item.currency === 'CZK' ? '' : item.currency}
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap">{formatDate(item.expectedDate)}</Table.Cell>
                    <Table.Cell align="end" className="tabular-nums">
                      {item.probabilityPercent === undefined ? 'jisté' : `${item.probabilityPercent} %`}
                    </Table.Cell>
                    <Table.Cell align="end" className="whitespace-nowrap tabular-nums">
                      {formatMoney(planItemWeightedMinor(item))}
                    </Table.Cell>
                    <Table.Cell className="max-w-64 text-sm">{relationText(vm, item) || '—'}</Table.Cell>
                    <Table.Cell align="end">
                      {vm.canWrite && (
                        <span className="flex justify-end gap-50">
                          <Button
                            aria-label={`Upravit ${item.title}`}
                            icon="icon-[mdi--pencil-outline]"
                            onClick={() => {
                              setError(undefined);
                              setDraft(editPlanItemDraft(item));
                            }}
                            size="sm"
                            theme="borderless"
                            variant="secondary"
                          />
                          <Button
                            aria-label={`Smazat ${item.title}`}
                            icon="icon-[mdi--delete-outline]"
                            onClick={() => setDeleteTarget(item)}
                            size="sm"
                            theme="borderless"
                            variant="secondary"
                          />
                        </span>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </FinanceTableScroll>
        </>
      )}
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
              Uložit
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description="Očekávaný příjem nebo výdaj. Měna CZK."
        onOpenChange={(details) => {
          if (!details.open) {
            setDraft(undefined);
          }
        }}
        open={draft !== undefined}
        placement="center"
        size="md"
        title={draft?.id === undefined ? 'Nová položka finančního plánu' : 'Upravit položku plánu'}
      >
        {draft !== undefined && (
          <div className="flex flex-col gap-150">
            {error !== undefined && (
              <StatusText showIcon size="sm" status="error">
                {error}
              </StatusText>
            )}
            <div className="grid grid-cols-1 gap-150 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <SelectTemplate
                items={[
                  { displayValue: 'Příjem', label: 'Příjem', value: 'REVENUE' },
                  { displayValue: 'Výdaj', label: 'Výdaj', value: 'COST' },
                ]}
                label={t('finance-billing.financeUi.common.type')}
                labelProps={{ className: 'font-label text-label-md' }}
                onValueChange={({ value }) => {
                  const [next] = value;
                  if (next === 'COST' || next === 'REVENUE') {
                    setDraft({ ...draft, kind: next });
                  }
                }}
                size="sm"
                value={[draft.kind]}
              />
              <FormInput
                id="plan-title"
                label={t('finance-billing.financeUi.common.name')}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                placeholder={t('finance-billing.financeUi.plan.titleExample')}
                size="sm"
                value={draft.title}
              />
            </div>
            <div className="grid grid-cols-1 gap-150 sm:grid-cols-3">
              <FormInput
                id="plan-amount"
                inputMode="decimal"
                label={t('finance-billing.financeUi.common.amount')}
                onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
                size="sm"
                value={draft.amount}
              />
              <FormInput
                id="plan-date"
                label={t('finance-billing.financeUi.plan.expectedDate')}
                onChange={(event) => setDraft({ ...draft, expectedDate: event.target.value })}
                size="sm"
                type="date"
                value={draft.expectedDate}
              />
              <FormInput
                helpText="Nepovinné, 1–100"
                id="plan-probability"
                inputMode="numeric"
                label={t('finance-billing.financeUi.plan.probability')}
                onChange={(event) => setDraft({ ...draft, probability: event.target.value })}
                size="sm"
                value={draft.probability}
              />
            </div>
            <ObjectFields
              idPrefix="plan-object"
              objects={vm.objects}
              onChange={(next) => setDraft({ ...draft, object: next })}
              showContract
              showCostCenter={false}
              value={draft.object}
            />
            <FormInput
              id="plan-project"
              label={t('finance-billing.financeUi.plan.project')}
              onChange={(event) => setDraft({ ...draft, projectName: event.target.value })}
              placeholder={t('finance-billing.financeUi.plan.projectExample')}
              size="sm"
              value={draft.projectName}
            />
            <FormInput
              id="plan-note"
              label={t('finance-billing.financeUi.common.note')}
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              size="sm"
              value={draft.note}
            />
          </div>
        )}
      </Dialog>
      <Dialog
        actions={
          <>
            <Button onClick={() => setDeleteTarget(undefined)} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button
              onClick={() => {
                if (deleteTarget !== undefined) {
                  void financeBrowserRuntime.runPromise(
                    vm.execute({ _tag: 'DeletePlanItem', id: deleteTarget.id }, 'Položka plánu smazána'),
                  );
                }
                setDeleteTarget(undefined);
              }}
              variant="danger"
            >
              Smazat
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={`Smazat položku „${deleteTarget?.title ?? ''}“ z finančního plánu?`}
        onOpenChange={(details) => {
          if (!details.open) {
            setDeleteTarget(undefined);
          }
        }}
        open={deleteTarget !== undefined}
        placement="center"
        role="alertdialog"
        size="sm"
        title={t('finance-billing.financeUi.plan.deleteItem')}
      />
    </SectionCard>
  );
};
