// Detail of one business case (opportunity) with links to the task, contract and order/offer records it relates to.
import {
  DetailList,
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  SectionCard,
  SidePanel,
  StatusBadge,
} from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Table } from '@techsio/ui-kit/organisms/table';
import { DateTime } from 'effect';
import type { ReactNode } from 'react';
import type { Opportunity, OpportunityLine } from '../../../../../shared/model/opportunity.ts';
import { isOpenStage } from '../../../../../shared/model/opportunity.ts';
import { formatWholeKc } from './pipeline-model.ts';
import type { PipelineLookups } from './pipeline-table.tsx';
import type { RelatedContract, RelatedOrder, RelatedSection, RelatedTask } from './pipeline-related.ts';
import { useOpportunityRelated } from './pipeline-related.ts';

const opportunityLineIdentity = (line: OpportunityLine) =>
  [line.productId ?? '', line.productName, String(line.quantity), String(line.unitPriceMinor), String(line.vatRate)]
    .map((value) => `${value.length}:${value}`)
    .join('');

const contractStates = {
  ACTIVE: 'Platná',
  DRAFT: 'Návrh smlouvy',
  EXPIRED: 'Vypršela',
  TERMINATED: 'Ukončená',
} satisfies Readonly<Record<RelatedContract['lifecycleState'], string>>;

/** Repeated snapshots have no entity id, so disambiguate equal content within this list. */
const withOccurrenceKeys = <Item,>(items: readonly Item[], identity: (item: Item) => string) => {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const content = identity(item);
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    return { item, key: `${content}:${occurrence}` };
  });
};

interface RelatedListProps<Item> {
  readonly empty: string;
  readonly render: (item: Item) => ReactNode;
  readonly section: RelatedSection<Item>;
  readonly title: string;
  readonly unavailable: string;
}

/** One related list; renders nothing when the owning module is not part of this company. */
const RelatedList = <Item extends { readonly id: string }>({
  empty,
  render,
  section,
  title,
  unavailable,
}: RelatedListProps<Item>) => {
  if (section.status === 'absent') {
    return null;
  }
  return (
    <div className="flex flex-col gap-100">
      <h3 className="font-semibold text-sm">{title}</h3>
      {section.status === 'loading' && <p className="text-fg-secondary text-sm">Načítám…</p>}
      {section.status === 'unavailable' && <StatusText status="error">{unavailable}</StatusText>}
      {section.status === 'ready' && section.items.length === 0 && <p className="text-fg-secondary text-sm">{empty}</p>}
      {section.status === 'ready' && section.items.length > 0 && (
        <ul className="flex flex-col gap-100">
          {section.items.map((item) => (
            <li className="flex flex-wrap items-center gap-100 text-sm" key={item.id}>
              {render(item)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

interface PipelineDetailPanelProps {
  readonly canWrite: boolean;
  readonly lookups: PipelineLookups;
  readonly onClose: () => void;
  readonly onEdit: (opportunity: Opportunity) => void;
  readonly onStage: (opportunity: Opportunity) => void;
  readonly opportunity: Opportunity | undefined;
}

export const PipelineDetailPanel = ({
  canWrite,
  lookups,
  onClose,
  onEdit,
  onStage,
  opportunity,
}: PipelineDetailPanelProps) => {
  const { language, t } = useModernI18n();
  const customer = opportunity === undefined ? undefined : lookups.customerById.get(opportunity.partyId);
  const related = useOpportunityRelated(opportunity, customer?.counterpartyId);
  if (opportunity === undefined) {
    return null;
  }
  const owner =
    opportunity.ownerEmployeeId === undefined ? undefined : lookups.employeeById.get(opportunity.ownerEmployeeId);
  const open = isOpenStage(opportunity.stage);
  const anyRelated = [related.tasks, related.contracts, related.orders].some((section) => section.status !== 'absent');
  const workHref = (task: RelatedTask) => `/${language}/ukoly?resourceId=${encodeURIComponent(task.id)}`;
  const contractHref = (contract: RelatedContract) =>
    `/${language}/smlouvy?resourceId=${encodeURIComponent(contract.id)}`;
  const orderHref = (order: RelatedOrder) => `/${language}/prodej/objednavky?orderId=${encodeURIComponent(order.id)}`;

  return (
    <SidePanel
      actions={
        <div className="flex w-full flex-wrap justify-end gap-100">
          <Button className="shrink-0 whitespace-nowrap" onClick={onClose} theme="outlined" variant="secondary">
            Zavřít
          </Button>
          {canWrite && (
            <Button
              className="shrink-0 whitespace-nowrap"
              onClick={() => onStage(opportunity)}
              theme="outlined"
              variant="secondary"
            >
              Změnit fázi
            </Button>
          )}
          {canWrite && open && (
            <Button className="shrink-0 whitespace-nowrap" onClick={() => onEdit(opportunity)} variant="primary">
              Upravit
            </Button>
          )}
        </div>
      }
      description={customer?.name ?? undefined}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      resizeLabel={t('sales-pipeline.sidePanel.resize')}
      size="lg"
      title={opportunity.title}
    >
      <div className="flex flex-col gap-250 py-200">
        <div className="flex flex-wrap items-center gap-100">
          <StatusBadge kind="opportunity" value={opportunity.stage} />
          <span className="text-fg-secondary text-sm">
            Pravděpodobnost {formatPercent(opportunity.probability / 100)}
          </span>
        </div>
        <SectionCard title="Obchodní případ">
          <DetailList
            items={[
              {
                label: 'Zákazník',
                value:
                  customer === undefined ? (
                    '—'
                  ) : (
                    <span>
                      {customer.name ?? '—'}
                      {customer.companyId === null ? '' : ` · IČO ${customer.companyId}`}
                    </span>
                  ),
              },
              { label: 'Obchodník', value: owner?.fullName ?? 'Nepřiřazeno' },
              { label: 'Odhadovaná hodnota (bez DPH)', value: formatWholeKc(opportunity.amountMinor) },
              { label: 'Termín uzavření', value: formatDate(opportunity.expectedCloseDate) },
              { label: 'Založeno', value: formatDateTime(DateTime.formatIso(opportunity.createdAt)) },
              { label: 'Naposledy změněno', value: formatDateTime(DateTime.formatIso(opportunity.updatedAt)) },
              ...(opportunity.note === undefined || opportunity.note === ''
                ? []
                : [{ label: 'Poznámka', value: <span className="whitespace-pre-line">{opportunity.note}</span> }]),
            ]}
          />
        </SectionCard>

        {anyRelated && (
          <SectionCard title="Navazující záznamy">
            <div className="flex flex-col gap-250">
              <RelatedList
                empty="K případu ani k zákazníkovi zatím není žádný úkol."
                render={(task) => (
                  <>
                    <Link href={workHref(task)}>{task.title}</Link>
                    <StatusBadge kind="task" value={task.state} />
                    <Badge size="sm" variant={task.assignedToCase ? 'info' : 'outline'}>
                      {task.assignedToCase ? 'Přiřazený k případu' : 'Úkol zákazníka'}
                    </Badge>
                    {task.dueDate !== undefined && (
                      <span className="text-fg-secondary">termín {formatDate(task.dueDate)}</span>
                    )}
                  </>
                )}
                section={related.tasks}
                title="Úkoly"
                unavailable="Úkoly se nepodařilo načíst."
              />
              <RelatedList
                empty="Zákazník zatím nemá žádnou smlouvu."
                render={(contract) => (
                  <>
                    <Link href={contractHref(contract)}>
                      {contract.subject ?? (contract.kind === 'LEASE' ? 'Nájemní smlouva' : 'Smlouva')}
                    </Link>
                    <Badge size="sm" variant={contract.lifecycleState === 'ACTIVE' ? 'success' : 'outline'}>
                      {contractStates[contract.lifecycleState]}
                    </Badge>
                    <span className="text-fg-secondary">od {formatDate(contract.startDate)}</span>
                  </>
                )}
                section={related.contracts}
                title="Smlouvy"
                unavailable="Smlouvy se nepodařilo načíst."
              />
              <RelatedList
                empty="Z případu zatím nevznikla žádná objednávka."
                render={(order) => (
                  <>
                    <Link href={orderHref(order)}>{order.number}</Link>
                    <StatusBadge kind="order" value={order.status} />
                    <span className="text-fg-secondary tabular-nums">{formatMoney(order.totalMinor)}</span>
                  </>
                )}
                section={related.orders}
                title="Objednávky z případu"
                unavailable="Objednávky se nepodařilo načíst."
              />
            </div>
          </SectionCard>
        )}

        <SectionCard flush title="Nabídka – položky případu">
          {opportunity.lines.length === 0 ? (
            <p className="p-200 text-fg-secondary text-sm">
              Případ zatím nemá položky nabídky. Doplníte je přes Upravit.
            </p>
          ) : (
            /* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Approved demo/sales-crm policy: this named scroll region preserves keyboard access to horizontal table scrolling. */
            <section aria-label="Položky nabídky" className="overflow-x-auto" tabIndex={0}>
              {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
              <Table size="sm" variant="line">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Položka</Table.ColumnHeader>
                    <Table.ColumnHeader align="end">Množství</Table.ColumnHeader>
                    <Table.ColumnHeader align="end">Cena/j bez DPH</Table.ColumnHeader>
                    <Table.ColumnHeader align="end">Celkem bez DPH</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {withOccurrenceKeys(opportunity.lines, opportunityLineIdentity).map(({ item: line, key }) => (
                    <Table.Row key={key}>
                      <Table.Cell>{line.productName}</Table.Cell>
                      <Table.Cell align="end">{line.quantity}</Table.Cell>
                      <Table.Cell align="end">{formatMoney(line.unitPriceMinor)}</Table.Cell>
                      <Table.Cell align="end">{formatMoney(line.quantity * line.unitPriceMinor)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </section>
          )}
        </SectionCard>

        {opportunity.stageHistory.length > 0 && (
          <SectionCard title="Historie fází">
            <ul className="flex flex-col gap-50 text-sm">
              {withOccurrenceKeys(
                opportunity.stageHistory.toReversed(),
                (entry) => `${entry.stage}:${DateTime.toEpochMillis(entry.at)}`,
              ).map(({ item: entry, key }) => (
                <li className="flex flex-wrap items-center gap-100" key={key}>
                  <span className="text-fg-secondary tabular-nums">{formatDateTime(DateTime.formatIso(entry.at))}</span>
                  <StatusBadge kind="opportunity" value={entry.stage} />
                </li>
              ))}
            </ul>
          </SectionCard>
        )}
      </div>
    </SidePanel>
  );
};
