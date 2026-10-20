// Client-card "Objednávky" tab. OWNER: crm-imports (first read-only version committed by crm-clients; rewrite
// freely, keep the export name and ClientCardTabProps).
import { EmptyState, formatDate } from '@app/admin-ui';
import { Table } from '@techsio/ui-kit/organisms/table';
import type { ClientCardTabProps } from '../klienti/card-tab-props.ts';

export const ClientOrdersTab = ({ client, records }: ClientCardTabProps) => {
  const orders = records.state.imports.orders
    .filter((order) => order.clientId === client.id && order.pairing === 'paired')
    .toSorted((left, right) => (right.orderedAt ?? right.receivedAt).localeCompare(left.orderedAt ?? left.receivedAt));
  if (orders.length === 0) {
    return (
      <EmptyState
        description="Ke klientovi zatím není přiřazená žádná importovaná objednávka."
        title="Bez objednávek"
      />
    );
  }
  return (
    <Table size="sm" variant="line">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>Číslo</Table.ColumnHeader>
          <Table.ColumnHeader>Zdroj</Table.ColumnHeader>
          <Table.ColumnHeader>Datum</Table.ColumnHeader>
          <Table.ColumnHeader align="end">Částka</Table.ColumnHeader>
          <Table.ColumnHeader>Stav ve zdroji</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {orders.map((order) => (
          <Table.Row key={order.id}>
            <Table.Cell>{order.number ?? order.externalId}</Table.Cell>
            <Table.Cell>{order.source}</Table.Cell>
            <Table.Cell>{formatDate(order.orderedAt ?? order.receivedAt)}</Table.Cell>
            <Table.Cell align="end" className="tabular-nums">
              {order.amount === undefined ? 'údaj neposkytnut' : `${order.amount} ${order.currency ?? ''}`}
            </Table.Cell>
            <Table.Cell>{order.rawStatus}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
};
