import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Table } from '@techsio/ui-kit/organisms/table';
import { DetailList, formatDateTime, formatMoney, SectionCard, StatusBadge } from '@app/admin-ui';
import { DateTime } from 'effect';
import type { Order } from '../../../../../shared/apis/records.ts';
import type { OrderStatus } from '../../../../../shared/domain/merchandise-model.ts';
import { actionLabelKey, customerName, lineAmounts, transitionsFrom } from './orders-model.ts';

interface OrderDetailDialogProps {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly onClose: () => void;
  readonly onStatus: (order: Order, status: OrderStatus) => void;
  readonly order: Order | undefined;
}

/** Read-only snapshot of one order with its status actions. Lines show what was fixed at creation. */
export const OrderDetailDialog = ({ busy, canWrite, onClose, onStatus, order }: OrderDetailDialogProps) => {
  const { language, t } = useModernI18n();
  if (order === undefined) {
    return null;
  }

  const transitions = canWrite ? transitionsFrom(order.status) : [];
  const [primary, ...secondary] = transitions;
  const label = (status: OrderStatus) => {
    const labelKey = actionLabelKey(status);
    return labelKey === null ? status : t(labelKey);
  };
  const opportunityHref = `/${language}/prodej/prilezitosti`;

  const actions = (
    <>
      <Button onClick={onClose} theme="outlined" variant="secondary">
        {t('merchandise.pages.orders.detail.close')}
      </Button>
      {secondary.map((status) => (
        <Button disabled={busy} key={status} onClick={() => onStatus(order, status)} theme="outlined" variant="danger">
          {label(status)}
        </Button>
      ))}
      {primary !== undefined && (
        <Button
          isLoading={busy}
          loadingText={t('merchandise.pages.orders.create.submitting')}
          onClick={() => onStatus(order, primary)}
          variant="primary"
        >
          {label(primary)}
        </Button>
      )}
    </>
  );

  return (
    <Dialog
      actions={actions}
      customTrigger
      onOpenChange={({ open }) => {
        if (!open) {
          onClose();
        }
      }}
      open
      placement="right"
      size="lg"
      title={t('merchandise.pages.orders.detail.title', { number: order.number })}
    >
      <div className="flex flex-col gap-250 py-200">
        <div>
          <StatusBadge kind="order" value={order.status} />
        </div>
        <DetailList
          items={[
            { label: t('merchandise.pages.orders.detail.customer'), value: customerName(order.partyId) },
            {
              label: t('merchandise.pages.orders.detail.source'),
              value:
                order.opportunityId === undefined ? (
                  t('merchandise.pages.orders.source.manual')
                ) : (
                  <Link href={opportunityHref}>{t('merchandise.pages.orders.source.opportunity')}</Link>
                ),
            },
            {
              label: t('merchandise.pages.orders.detail.createdAt'),
              value: formatDateTime(DateTime.formatIso(order.createdAt)),
            },
            {
              label: t('merchandise.pages.orders.detail.updatedAt'),
              value: formatDateTime(DateTime.formatIso(order.updatedAt)),
            },
          ]}
        />
        <SectionCard flush title={t('merchandise.pages.orders.detail.lines')}>
          <Table size="sm" variant="line">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>{t('merchandise.pages.orders.detail.lineSku')}</Table.ColumnHeader>
                <Table.ColumnHeader>{t('merchandise.pages.orders.detail.lineName')}</Table.ColumnHeader>
                <Table.ColumnHeader align="end">{t('merchandise.pages.orders.detail.lineQuantity')}</Table.ColumnHeader>
                <Table.ColumnHeader align="end">
                  {t('merchandise.pages.orders.detail.lineUnitPrice')}
                </Table.ColumnHeader>
                <Table.ColumnHeader align="end">{t('merchandise.pages.orders.detail.lineVat')}</Table.ColumnHeader>
                <Table.ColumnHeader align="end">{t('merchandise.pages.orders.detail.lineTotal')}</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {order.lines.map((line) => (
                <Table.Row key={line.productId}>
                  <Table.Cell>{line.sku}</Table.Cell>
                  <Table.Cell>{line.productName}</Table.Cell>
                  <Table.Cell align="end" className="tabular-nums">
                    {line.quantity}
                  </Table.Cell>
                  <Table.Cell align="end" className="tabular-nums">
                    {formatMoney(line.unitPriceMinor)}
                  </Table.Cell>
                  <Table.Cell align="end" className="tabular-nums">
                    {`${line.vatRate} %`}
                  </Table.Cell>
                  <Table.Cell align="end" className="tabular-nums">
                    {formatMoney(lineAmounts(line.unitPriceMinor, line.quantity, line.vatRate).gross)}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </SectionCard>
        <DetailList
          items={[
            {
              label: t('merchandise.pages.orders.detail.netTotal'),
              value: <span className="tabular-nums">{formatMoney(order.totalMinor - order.totalVatMinor)}</span>,
            },
            {
              label: t('merchandise.pages.orders.detail.vatTotal'),
              value: <span className="tabular-nums">{formatMoney(order.totalVatMinor)}</span>,
            },
            {
              label: t('merchandise.pages.orders.detail.grossTotal'),
              value: <span className="tabular-nums">{formatMoney(order.totalMinor)}</span>,
            },
          ]}
        />
      </div>
    </Dialog>
  );
};
