// Present-state body and actions of one business case. The quick-view panel and the full-page detail both render it.
import {
  DetailList,
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  ScrollRegion,
  SectionCard,
  StatusBadge,
} from '@app/admin-ui';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
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
import { referenceText, resolveReference } from './pipeline-reference-labels.ts';
import type { PipelineLookups } from './pipeline-table.tsx';
import type { RelatedContract, RelatedOrder, RelatedSection, RelatedTask } from './pipeline-related.ts';
import { useOpportunityRelated } from './pipeline-related.ts';

const opportunityLineIdentity = (line: OpportunityLine) =>
  [line.productId ?? '', line.productName, String(line.quantity), String(line.unitPriceMinor), String(line.vatRate)]
    .map((value) => `${value.length}:${value}`)
    .join('');

const contractStateKeys = {
  ACTIVE: 'sales-pipeline.detail.contractState.ACTIVE',
  DRAFT: 'sales-pipeline.detail.contractState.DRAFT',
  EXPIRED: 'sales-pipeline.detail.contractState.EXPIRED',
  TERMINATED: 'sales-pipeline.detail.contractState.TERMINATED',
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
  const { t } = useModernI18n();
  if (section.status === 'absent') {
    return null;
  }
  return (
    <div className="flex flex-col gap-100">
      <h3 className="font-semibold text-sm">{title}</h3>
      {section.status === 'loading' && <p className="text-fg-secondary text-sm">{t('sales-pipeline.loading')}</p>}
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

export interface PipelineDetailBodyProps {
  readonly context?: ModulePageContext | undefined;
  readonly lookups: PipelineLookups;
  readonly opportunity: Opportunity;
  readonly revision: number;
}

/** Facts, related records, offer lines and stage history of one present opportunity. */
export const PipelineDetailBody = ({ context, lookups, opportunity, revision }: PipelineDetailBodyProps) => {
  const { language, t } = useModernI18n();
  const customer = lookups.customerById.get(opportunity.partyId);
  const related = useOpportunityRelated(opportunity, customer?.counterpartyId, context, revision);
  const texts = (unknown: string) => ({
    loading: '—',
    unavailable: t('sales-pipeline.pages.records.referenceUnavailable'),
    unknown,
  });
  const customerFallback = referenceText(
    resolveReference(lookups.customerById, lookups.customersStatus, opportunity.partyId),
    () => '',
    texts(t('sales-pipeline.pages.records.create.unknownCustomer')),
  );
  const ownerValue =
    opportunity.ownerEmployeeId === undefined
      ? t('sales-pipeline.detail.unassigned')
      : referenceText(
          resolveReference(lookups.employeeById, lookups.employeesStatus, opportunity.ownerEmployeeId),
          (employee) => employee.fullName,
          texts(t('sales-pipeline.pages.records.unknownOwner')),
        );
  const anyRelated = [related.tasks, related.contracts, related.orders].some((section) => section.status !== 'absent');
  const workHref = (task: RelatedTask) => `/${language}/ukoly?resourceId=${encodeURIComponent(task.id)}`;
  const contractHref = (contract: RelatedContract) =>
    `/${language}/smlouvy?resourceId=${encodeURIComponent(contract.id)}`;
  const orderHref = (order: RelatedOrder) => `/${language}/prodej/objednavky?orderId=${encodeURIComponent(order.id)}`;

  return (
    <div className="flex flex-col gap-250 py-200">
      <div className="flex flex-wrap items-center gap-100">
        <StatusBadge kind="opportunity" value={opportunity.stage} />
        <span className="text-fg-secondary text-sm">
          {t('sales-pipeline.detail.probability', { value: formatPercent(opportunity.probability / 100) })}
        </span>
      </div>
      <SectionCard title={t('sales-pipeline.detail.title')}>
        <DetailList
          items={[
            {
              label: t('sales-pipeline.detail.customer'),
              value:
                customer === undefined ? (
                  customerFallback
                ) : (
                  <span>
                    {customer.name ?? '—'}
                    {customer.companyId === null
                      ? ''
                      : ` · ${t('sales-pipeline.detail.companyId', { id: customer.companyId })}`}
                  </span>
                ),
            },
            { label: t('sales-pipeline.detail.owner'), value: ownerValue },
            { label: t('sales-pipeline.detail.amount'), value: formatWholeKc(opportunity.amountMinor) },
            { label: t('sales-pipeline.detail.closeDate'), value: formatDate(opportunity.expectedCloseDate) },
            {
              label: t('sales-pipeline.detail.createdAt'),
              value: formatDateTime(DateTime.formatIso(opportunity.createdAt)),
            },
            {
              label: t('sales-pipeline.detail.updatedAt'),
              value: formatDateTime(DateTime.formatIso(opportunity.updatedAt)),
            },
            ...(opportunity.note === undefined || opportunity.note === ''
              ? []
              : [
                  {
                    label: t('sales-pipeline.detail.note'),
                    value: <span className="whitespace-pre-line">{opportunity.note}</span>,
                  },
                ]),
          ]}
        />
      </SectionCard>

      {anyRelated && (
        <SectionCard title={t('sales-pipeline.detail.relatedRecords')}>
          <div className="flex flex-col gap-250">
            <RelatedList
              empty={t('sales-pipeline.detail.emptyTasks')}
              render={(task) => (
                <>
                  <Link href={workHref(task)}>{task.title}</Link>
                  <StatusBadge kind="task" value={task.state} />
                  <Badge size="sm" variant={task.assignedToCase ? 'info' : 'outline'}>
                    {task.assignedToCase
                      ? t('sales-pipeline.detail.taskAssignedToCase')
                      : t('sales-pipeline.detail.taskCustomer')}
                  </Badge>
                  {task.dueDate !== undefined && (
                    <span className="text-fg-secondary">
                      {t('sales-pipeline.detail.taskDue', { date: formatDate(task.dueDate) })}
                    </span>
                  )}
                </>
              )}
              section={related.tasks}
              title={t('sales-pipeline.detail.tasks')}
              unavailable={t('sales-pipeline.detail.unavailableTasks')}
            />
            <RelatedList
              empty={t('sales-pipeline.detail.emptyContracts')}
              render={(contract) => (
                <>
                  <Link href={contractHref(contract)}>
                    {contract.subject ??
                      t(
                        contract.kind === 'LEASE'
                          ? 'sales-pipeline.detail.contractLease'
                          : 'sales-pipeline.detail.contractDefault',
                      )}
                  </Link>
                  <Badge size="sm" variant={contract.lifecycleState === 'ACTIVE' ? 'success' : 'outline'}>
                    {t(contractStateKeys[contract.lifecycleState])}
                  </Badge>
                  <span className="text-fg-secondary">
                    {t('sales-pipeline.detail.contractFrom', { date: formatDate(contract.startDate) })}
                  </span>
                </>
              )}
              section={related.contracts}
              title={t('sales-pipeline.detail.contracts')}
              unavailable={t('sales-pipeline.detail.unavailableContracts')}
            />
            <RelatedList
              empty={t('sales-pipeline.detail.emptyOrders')}
              render={(order) => (
                <>
                  <Link href={orderHref(order)}>{order.number}</Link>
                  <StatusBadge kind="order" value={order.status} />
                  <span className="text-fg-secondary tabular-nums">{formatMoney(order.totalMinor)}</span>
                </>
              )}
              section={related.orders}
              title={t('sales-pipeline.detail.orders')}
              unavailable={t('sales-pipeline.detail.unavailableOrders')}
            />
          </div>
        </SectionCard>
      )}

      <SectionCard flush title={t('sales-pipeline.detail.offerLinesTitle')}>
        {opportunity.lines.length === 0 ? (
          <p className="p-200 text-fg-secondary text-sm">{t('sales-pipeline.detail.noOfferLines')}</p>
        ) : (
          <ScrollRegion label={t('sales-pipeline.detail.offerLinesLabel')}>
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{t('sales-pipeline.detail.lineItem')}</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">{t('sales-pipeline.detail.lineQuantity')}</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">{t('sales-pipeline.detail.lineUnitPrice')}</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">{t('sales-pipeline.detail.lineTotal')}</Table.ColumnHeader>
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
          </ScrollRegion>
        )}
      </SectionCard>

      {opportunity.stageHistory.length > 0 && (
        <SectionCard title={t('sales-pipeline.detail.stageHistory')}>
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
  );
};

export interface PipelineDetailActionsProps {
  readonly canWrite: boolean;
  /** Set in the side panel, which keeps its own close button; the full page leaves the back link to the list. */
  readonly onClose?: (() => void) | undefined;
  readonly onEdit: (opportunity: Opportunity) => void;
  readonly onStage: (opportunity: Opportunity) => void;
  readonly opportunity: Opportunity;
}

/** Close, change-stage and edit actions of one opportunity. Writes stay hidden without the write permission. */
export const PipelineDetailActions = ({
  canWrite,
  onClose,
  onEdit,
  onStage,
  opportunity,
}: PipelineDetailActionsProps) => {
  const { t } = useModernI18n();
  const open = isOpenStage(opportunity.stage);
  return (
    <>
      {onClose !== undefined && (
        <Button className="shrink-0 whitespace-nowrap" onClick={onClose} theme="outlined" variant="secondary">
          {t('sales-pipeline.pages.records.edit.close')}
        </Button>
      )}
      {canWrite && (
        <Button
          className="shrink-0 whitespace-nowrap"
          onClick={() => onStage(opportunity)}
          theme="outlined"
          variant="secondary"
        >
          {t('sales-pipeline.pages.records.actions.changeStage')}
        </Button>
      )}
      {canWrite && open && (
        <Button className="shrink-0 whitespace-nowrap" onClick={() => onEdit(opportunity)} variant="primary">
          {t('sales-pipeline.pages.records.actions.edit')}
        </Button>
      )}
    </>
  );
};
