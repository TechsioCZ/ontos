"use client";

import StoreLink from "@/components/store-link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Table } from "@techsio/ui-kit/organisms/table";
import { AccountHeading, AccountPanel } from "./account-content";
import { ReorderAction } from "./reorder-action";
import { formatQuantity } from "@/features/cart/cart-state";
import { formatPrice } from "@/lib/format";
import { useDictionary, useMarket } from "@/ontos/market-context";
import { orderMoney, type CustomerOrder } from "@/ontos/order-model";

const lineKey = (line: CustomerOrder["lines"][number]) =>
  `${line.productId}:${line.variantId ?? ""}`;
const lineName = (line: CustomerOrder["lines"][number]) =>
  `${line.productName}${line.variantName ? ` – ${line.variantName}` : ""}`;

export function AccountOrderDetail({
  order,
  repeatable = true,
}: {
  order: CustomerOrder;
  /** „Objednat znovu“ in the account; the order confirmation right after checkout hides it. */
  repeatable?: boolean;
}) {
  const cs = useDictionary();
  const text = cs.account.orderDetail;
  const locale = useMarket()?.formatLocale ?? "cs-CZ";
  const address = order.deliveryAddress;
  const money = orderMoney(order);
  const status = cs.account.orderStatus[order.status];
  const lineTotal = (line: CustomerOrder["lines"][number]) =>
    formatPrice(Math.round(line.unitPriceMinor * line.quantity), money);
  return (
    <>
      <AccountHeading
        title={text.title(order.number)}
        description={text.created(new Date(order.createdAt).toLocaleDateString(locale), status)}
      >
        {repeatable && (
          <ReorderAction
            orderId={order.id}
            orderNumber={order.number}
            lineCount={order.lines.length}
          />
        )}
        <LinkButton
          as={StoreLink}
          href="/historie-objednavek"
          data-account-action
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {text.back}
        </LinkButton>
        <LinkButton
          as={StoreLink}
          href={`/sledovani-zasilky?order=${encodeURIComponent(order.id)}`}
          data-account-action
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {order.status === "SHIPPED" ? text.trackShipment : text.orderState}
        </LinkButton>
      </AccountHeading>
      <div className="mb-(--dimension-32) grid gap-(--dimension-24) md:grid-cols-2">
        <AccountPanel title={text.contact}>
          {order.contact && (
            <p className="wrap-anywhere">
              {order.contact.name}
              <br />
              {order.contact.email}
              {order.contact.phone && (
                <>
                  <br />
                  {order.contact.phone}
                </>
              )}
            </p>
          )}
          {address && (
            <p className="mt-(--dimension-16)">
              {address.street}
              <br />
              {address.postalCode} {address.city}
              {address.country && (
                <>
                  <br />
                  {address.country}
                </>
              )}
            </p>
          )}
        </AccountPanel>
        <AccountPanel title={text.summary}>
          <dl className="grid gap-(--dimension-16)">
            <div className="flex flex-wrap justify-between gap-(--dimension-16)">
              <dt>{text.status}</dt>
              <dd className="font-bold">{status}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-(--dimension-16)">
              <dt>{text.lineCount}</dt>
              <dd className="tabular-nums">{order.lines.length}</dd>
            </div>
            {order.shipping && (
              <div className="flex flex-wrap justify-between gap-(--dimension-16)">
                <dt>{order.shipping.label}</dt>
                <dd className="tabular-nums">{formatPrice(order.shipping.priceMinor, money)}</dd>
              </div>
            )}
            <div className="flex flex-wrap justify-between gap-(--dimension-16)">
              <dt>{text.vat}</dt>
              <dd className="tabular-nums">{formatPrice(order.totalVatMinor, money)}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-(--dimension-16)">
              <dt>{text.totalWithVat}</dt>
              <dd className="font-bold tabular-nums">{formatPrice(order.totalMinor, money)}</dd>
            </div>
          </dl>
          <p className="mt-(--dimension-16) text-(length:--dimension-16) text-(--sf-account-muted)">
            {text.savedAmounts}
          </p>
        </AccountPanel>
      </div>
      <section aria-labelledby="account-order-lines">
        <h2
          id="account-order-lines"
          className="mb-(--dimension-24) text-(length:--sf-account-section-size) font-bold leading-(--sf-account-heading-leading)"
        >
          {text.lines}
        </h2>
        <div data-account-table className="hidden xl:block">
          <Table size="sm" variant="line">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>{text.product}</Table.ColumnHeader>
                <Table.ColumnHeader numeric>{text.quantity}</Table.ColumnHeader>
                <Table.ColumnHeader numeric>{text.unitPrice}</Table.ColumnHeader>
                <Table.ColumnHeader numeric>{text.lineTotal}</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {order.lines.map((line) => (
                <Table.Row key={lineKey(line)}>
                  <Table.Cell>
                    <p>{lineName(line)}</p>
                    <p className="text-(length:--dimension-16) text-(--sf-account-muted)">
                      {text.code(line.sku)}
                    </p>
                  </Table.Cell>
                  <Table.Cell numeric className="whitespace-nowrap tabular-nums">
                    {formatQuantity(line.quantity)}
                  </Table.Cell>
                  <Table.Cell numeric className="whitespace-nowrap tabular-nums">
                    {formatPrice(line.unitPriceMinor, money)}
                  </Table.Cell>
                  <Table.Cell numeric className="whitespace-nowrap font-bold tabular-nums">
                    {lineTotal(line)}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
        <ul className="grid gap-(--dimension-24) xl:hidden">
          {order.lines.map((line) => (
            <li
              key={lineKey(line)}
              className="min-w-0 wrap-anywhere rounded-(--dimension-8) bg-(--sf-account-surface) p-(--dimension-24) max-sm:p-(--dimension-16)"
            >
              <h3 className="font-bold">{lineName(line)}</h3>
              <p className="mt-(--dimension-8) text-(length:--dimension-16) text-(--sf-account-muted)">
                {text.code(line.sku)}
              </p>
              <dl className="mt-(--dimension-24) grid gap-(--dimension-8)">
                <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                  <dt>{text.quantity}</dt>
                  <dd className="tabular-nums">{formatQuantity(line.quantity)}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                  <dt>{text.unitPrice}</dt>
                  <dd className="tabular-nums">{formatPrice(line.unitPriceMinor, money)}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                  <dt>{text.lineTotal}</dt>
                  <dd className="font-bold tabular-nums">{lineTotal(line)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
