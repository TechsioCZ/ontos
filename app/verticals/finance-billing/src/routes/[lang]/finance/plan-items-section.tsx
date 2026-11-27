import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { dialogCloseLabel, EmptyState, formatDate, formatMoney, SectionCard } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Table } from '@techsio/ui-kit/organisms/table';
import { useState } from 'react';
import type { PlanItem } from '../../../../shared/apis/records.ts';
import { planItemWeightedMinor } from '../../../../shared/domain/finance-planning.ts';
import type { FinanceViewModel } from './finance-ui.tsx';
import { FinanceTableScroll } from './finance-table-scroll.tsx';
import { objectSummary } from './object-fields.tsx';
import { editPlanItemDraft, newPlanDraft } from './plan-item-draft.ts';
import type { PlanDraft } from './plan-item-draft.ts';
import { PlanItemEditor } from './plan-item-editor.tsx';

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

const usePlanItems = ({ vm }: { readonly vm: FinanceViewModel }) => {
  const items = (vm.snapshot?.state.planItems ?? []).toSorted((left, right) =>
    left.expectedDate.localeCompare(right.expectedDate),
  );
  const today = vm.referenceDate === '' ? '2026-10-21' : vm.referenceDate;
  const [draft, setDraft] = useState<PlanDraft>();
  const [deleteTarget, setDeleteTarget] = useState<PlanItem>();
  const totalIn = items
    .filter((item) => item.kind === 'REVENUE')
    .reduce((sum, item) => sum + planItemWeightedMinor(item), 0);
  const totalOut = items
    .filter((item) => item.kind === 'COST')
    .reduce((sum, item) => sum + planItemWeightedMinor(item), 0);

  return { deleteTarget, draft, items, setDeleteTarget, setDraft, today, totalIn, totalOut, vm };
};

export const PlanItemsSection = (props: { readonly vm: FinanceViewModel }) => {
  const { t } = useModernI18n();
  const { deleteTarget, draft, items, setDeleteTarget, setDraft, today, totalIn, totalOut, vm } = usePlanItems(props);
  return (
    <SectionCard
      actions={
        vm.canWrite ? (
          <Button icon="icon-[mdi--plus]" onClick={() => setDraft(newPlanDraft(today))} size="sm" variant="primary">
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
                            onClick={() => setDraft(editPlanItemDraft(item))}
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
      {draft !== undefined && <PlanItemEditor initial={draft} onClose={() => setDraft(undefined)} vm={vm} />}
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
