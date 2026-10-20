// Client-card "Objednávky" tab. OWNER: crm-imports. Props contract: ClientCardTabProps (crm-clients).
// Shows the orders paired to the client (C04): number, source, date, amount + currency, raw source state; a click
// expands the state history and lines. Facts only – no derived "repeat customer" labels (C07 is parked).
import { EmptyState, formatDate, formatDateTime } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Fragment, useState } from 'react';
import type { ImportedOrder } from '../../../../../shared/domain/imports.ts';
import { needsReview } from '../../../../../shared/domain/imports.ts';
import { clientSalesFacts } from '../../../../../shared/domain/reports.ts';
import type { ClientCardTabProps } from '../klienti/card-tab-props.ts';
import { NOT_PROVIDED, formatAmount, orderDate, orderTitle } from './order-model.ts';
import { RawStatusBadge } from './order-panels.tsx';

const OrderHistory = ({ order }: { readonly order: ImportedOrder }) => (
  <div className="grid grid-cols-1 gap-200 py-150 md:grid-cols-2">
    <div className="flex flex-col gap-100">
      <span className="font-medium text-xs">Historie stavů ze zdroje</span>
      <ol className="flex flex-col gap-50">
        {order.statusHistory.toReversed().map((event, index) => (
          <li className="flex flex-wrap items-center gap-100 text-xs" key={`${event.batchId}-${String(index)}`}>
            <RawStatusBadge status={event.rawStatus} />
            <span>{event.eventAt === undefined ? 'čas neposkytnut' : formatDateTime(event.eventAt)}</span>
            <span className="text-fg-secondary">{`načteno ${formatDateTime(event.importedAt)}`}</span>
            {event.review === true && (
              <Badge size="sm" variant={event.resolution === undefined ? 'warning' : 'outline'}>
                {event.resolution === undefined ? 'Vyžaduje kontrolu' : 'Rozhodnuto ručně'}
              </Badge>
            )}
          </li>
        ))}
      </ol>
    </div>
    <div className="flex flex-col gap-100">
      <span className="font-medium text-xs">Položky</span>
      {order.lines === undefined || order.lines.length === 0 ? (
        <span className="text-fg-secondary text-xs">Položky neposkytnuty</span>
      ) : (
        <ul className="flex flex-col gap-50 text-xs">
          {order.lines.map((line, index) => (
            <li className="flex justify-between gap-150" key={`${line.sku ?? line.name}-${String(index)}`}>
              <span>{`${line.quantity.replace('.', ',')} × ${line.name}`}</span>
              <span className="tabular-nums">{formatAmount(line.amount, order.currency)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  </div>
);

export const ClientOrdersTab = ({ client, records }: ClientCardTabProps) => {
  const [openId, setOpenId] = useState<string | undefined>();
  const orders = records.state.imports.orders
    .filter((order) => order.clientId === client.id && order.pairing === 'paired')
    .toSorted((left, right) => (right.orderedAt ?? right.receivedAt).localeCompare(left.orderedAt ?? left.receivedAt));
  if (orders.length === 0) {
    return (
      <EmptyState
        description="Ke klientovi zatím není přiřazená žádná importovaná objednávka. Objednávky přicházejí CSV importem z e-shopu a účetního systému."
        title="Bez objednávek"
      />
    );
  }
  // Share the report's exact-decimal arithmetic and confirmed-binding rules (C04/C05).
  const facts = clientSalesFacts(records.state, client.id);
  return (
    <div className="flex flex-col gap-200">
      <div className="grid grid-cols-2 gap-150 sm:grid-cols-3">
        <div className="flex flex-col gap-50 rounded-lg border border-border-primary p-150">
          <span className="text-fg-secondary text-xs">Evidované objednávky</span>
          <span className="font-semibold text-lg tabular-nums">{facts.orderCount}</span>
        </div>
        <div className="flex flex-col gap-50 rounded-lg border border-border-primary p-150">
          <span className="text-fg-secondary text-xs">Poslední objednávka</span>
          <span className="font-semibold text-sm">
            {facts.lastOrderAt === undefined ? NOT_PROVIDED : formatDate(facts.lastOrderAt)}
          </span>
        </div>
        <div className="flex flex-col gap-50 rounded-lg border border-border-primary p-150">
          <span className="text-fg-secondary text-xs">Hodnota evidovaných objednávek</span>
          {facts.totals.length === 0 ? (
            <span className="text-fg-secondary text-sm">{NOT_PROVIDED}</span>
          ) : (
            facts.totals.map(({ amount, currency }) => (
              <span className="font-semibold text-sm tabular-nums" key={currency}>
                {formatAmount(amount, currency)}
              </span>
            ))
          )}
        </div>
      </div>
      <span className="text-fg-secondary text-xs">
        Součet importovaných částek po měnách, včetně stornovaných – není to realizovaná tržba. Zdroj objednávek zůstává
        autoritou; CRM je jen zobrazuje.
      </span>
      <div className="overflow-auto rounded-lg border border-border-primary">
        <table className="w-full text-sm">
          <thead className="bg-surface text-fg-secondary text-xs">
            <tr>
              <th className="px-150 py-100 text-left font-normal">Číslo</th>
              <th className="px-150 py-100 text-left font-normal">Zdroj</th>
              <th className="px-150 py-100 text-left font-normal">Datum</th>
              <th className="px-150 py-100 text-right font-normal">Částka</th>
              <th className="px-150 py-100 text-left font-normal">Stav ve zdroji</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              const open = openId === order.id;
              return (
                <Fragment key={order.id}>
                  <tr
                    aria-expanded={open}
                    className="cursor-pointer border-border-primary border-t"
                    onClick={() => setOpenId(open ? undefined : order.id)}
                  >
                    <td className="px-150 py-100">
                      <span className="flex items-center gap-50">
                        <span
                          aria-hidden="true"
                          className={`size-200 text-fg-secondary ${open ? 'icon-[mdi--chevron-down]' : 'icon-[mdi--chevron-right]'}`}
                        />
                        <span className="font-medium">{orderTitle(order)}</span>
                        {order.duplicateOf !== undefined && (
                          <Badge size="sm" variant="outline">
                            Duplicita
                          </Badge>
                        )}
                        {needsReview(order) && (
                          <Badge size="sm" variant="warning">
                            Kontrola
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="px-150 py-100">{order.source}</td>
                    <td className="px-150 py-100">{orderDate(order)}</td>
                    <td
                      className={`px-150 py-100 text-right tabular-nums ${order.amount === undefined ? 'text-fg-secondary' : ''}`}
                    >
                      {formatAmount(order.amount, order.currency)}
                    </td>
                    <td className="px-150 py-100">
                      <RawStatusBadge status={order.rawStatus} />
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-base">
                      <td className="px-150" colSpan={5}>
                        <OrderHistory order={order} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
