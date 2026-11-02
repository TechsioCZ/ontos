"use client";

import { useMemo, useState } from "react";
import StoreLink from "@/components/store-link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { DataTable, type ColumnDef } from "@techsio/ui-kit/organisms/data-table";
import { AccountHeading } from "./account-content";
import { ReorderAction } from "./reorder-action";
import { CheckoutSelect } from "@/features/checkout/checkout-select";
import type { Dictionary } from "@/i18n";
import { formatPrice } from "@/lib/format";
import { useDictionary, useMarket } from "@/ontos/market-context";
import {
  orderHref,
  orderMoney,
  orderStatusLabels,
  type CustomerOrder,
  type OntosOrderStatus,
} from "@/ontos/order-model";

const PAGE_SIZE = 50;
const linkClass = "underline underline-offset-4 hover:no-underline";
/** Calendar month of an order in the browser's time zone (`2026-10`), matching the shown date. */
const orderMonth = (order: CustomerOrder) => {
  const date = new Date(order.createdAt);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};
const statuses = Object.keys(orderStatusLabels) as OntosOrderStatus[];

function OrderActions({ order, cs }: { order: CustomerOrder; cs: Dictionary }) {
  return (
    <div className="sf-order-actions">
      <ReorderAction orderId={order.id} orderNumber={order.number} lineCount={order.lines.length} />
      <StoreLink className={linkClass} href={orderHref(order)}>
        {cs.account.orders.open}
        <span className="sr-only"> {cs.account.orders.openOrder(order.number)}</span>
      </StoreLink>
    </div>
  );
}

export function AccountOrders({
  orders,
  total,
  offset = 0,
}: {
  orders: CustomerOrder[];
  total: number;
  offset?: number;
}) {
  const cs = useDictionary();
  const locale = useMarket()?.formatLocale ?? "cs-CZ";
  const text = cs.account.orders;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [month, setMonth] = useState("all");
  const formatDate = (order: CustomerOrder) => new Date(order.createdAt).toLocaleDateString(locale);
  const months = useMemo(() => {
    const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" });
    return [...new Set(orders.map(orderMonth))]
      .sort()
      .reverse()
      .map((value) => {
        const [year, monthNumber] = value.split("-").map(Number);
        const label = monthLabel.format(new Date(year, monthNumber - 1, 1));
        return { value, label: label.charAt(0).toLocaleUpperCase(locale) + label.slice(1) };
      });
  }, [orders, locale]);
  const columns = useMemo<ColumnDef<CustomerOrder>[]>(
    () => [
      {
        accessorKey: "number",
        header: text.number,
        cell: ({ row }) => (
          <StoreLink className={linkClass} href={orderHref(row.original)}>
            {row.original.number}
          </StoreLink>
        ),
      },
      {
        accessorKey: "createdAt",
        header: text.date,
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(locale),
      },
      {
        id: "items",
        accessorFn: (order) => order.lines.length,
        header: text.items,
        meta: { align: "end" },
        cell: ({ row }) => <span className="tabular-nums">{row.original.lines.length}</span>,
      },
      {
        accessorKey: "totalMinor",
        header: text.total,
        meta: { align: "end" },
        cell: ({ row }) => (
          <strong className="whitespace-nowrap tabular-nums">
            {formatPrice(row.original.totalMinor, orderMoney(row.original))}
          </strong>
        ),
      },
      {
        accessorKey: "status",
        header: text.state,
        cell: ({ row }) => cs.account.orderStatus[row.original.status],
      },
      {
        id: "actions",
        header: text.actions,
        enableSorting: false,
        cell: ({ row }) => <OrderActions order={row.original} cs={cs} />,
      },
    ],
    [cs, text, locale],
  );
  const visible = orders.filter(
    (order) =>
      order.number.toLowerCase().includes(query.trim().toLowerCase()) &&
      (status === "all" || status === order.status) &&
      (month === "all" || orderMonth(order) === month),
  );
  const filtered = Boolean(query || status !== "all" || month !== "all");
  const clear = () => {
    setQuery("");
    setStatus("all");
    setMonth("all");
  };
  const latest = offset === 0 ? orders[0] : undefined;
  return (
    <>
      <AccountHeading title={text.title} description={text.description}>
        {latest && (
          <LinkButton
            as={StoreLink}
            href={`/sledovani-zasilky?order=${encodeURIComponent(latest.id)}`}
            data-account-action
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {text.trackLatest}
          </LinkButton>
        )}
      </AccountHeading>
      {orders.length > 0 && (
        <div className="grid gap-(--dimension-24) rounded-(--dimension-8) bg-(--sf-account-surface) p-(--dimension-24) md:grid-cols-3 max-sm:p-(--dimension-16)">
          <FormInput
            id="account-order-search"
            label={text.search}
            size="sm"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <CheckoutSelect
            id="account-order-month"
            label={text.period}
            value={month}
            onChange={setMonth}
            items={[{ value: "all", label: text.allPeriods }, ...months]}
          />
          <CheckoutSelect
            id="account-order-status"
            label={text.status}
            value={status}
            onChange={setStatus}
            items={[
              { value: "all", label: text.allStatuses },
              ...statuses.map((value) => ({ value, label: cs.account.orderStatus[value] })),
            ]}
          />
        </div>
      )}
      <div className="my-(--dimension-24) flex flex-wrap items-center justify-between gap-(--dimension-16)">
        <output className="text-(length:--dimension-16) text-(--sf-account-muted)">
          {text.shown(visible.length, total)}
          {total > orders.length && ` · ${text.pageFiltersNote}`}
        </output>
        {filtered && (
          <Button size="sm" theme="unstyled" onClick={clear} className="underline">
            {text.clearFilters}
          </Button>
        )}
      </div>
      {orders.length === 0 ? (
        <p className="rounded-(--dimension-8) bg-(--sf-account-surface) p-(--dimension-24)">
          {text.empty}
        </p>
      ) : visible.length === 0 ? (
        <div className="rounded-(--dimension-8) bg-(--sf-account-surface) p-(--dimension-24)">
          <h2 className="font-bold">{text.noMatchTitle}</h2>
          <p className="mt-(--dimension-8)">{text.noMatchText}</p>
        </div>
      ) : (
        <>
          <div data-account-table className="hidden min-w-0 xl:block">
            <DataTable
              data={visible}
              columns={columns}
              size="sm"
              variant="line"
              enableSorting
              translations={{ emptyTitle: text.noMatchTitle }}
            />
          </div>
          <ul
            data-account-order-cards
            className="grid gap-(--dimension-24) md:grid-cols-2 xl:hidden"
          >
            {visible.map((order) => (
              <li
                key={order.id}
                className="min-w-0 rounded-(--dimension-8) bg-(--sf-account-surface) p-(--dimension-24) max-sm:p-(--dimension-16)"
              >
                <h2 className="font-bold">
                  <StoreLink className={linkClass} href={orderHref(order)}>
                    {order.number}
                  </StoreLink>
                </h2>
                <p className="mt-(--dimension-8) text-(--sf-account-muted)">{formatDate(order)}</p>
                <dl className="my-(--dimension-24) grid gap-(--dimension-8)">
                  <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                    <dt>{text.items}</dt>
                    <dd className="tabular-nums">{order.lines.length}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                    <dt>{text.total}</dt>
                    <dd className="font-bold tabular-nums">
                      {formatPrice(order.totalMinor, orderMoney(order))}
                    </dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                    <dt>{text.state}</dt>
                    <dd>{cs.account.orderStatus[order.status]}</dd>
                  </div>
                </dl>
                <div className="sf-order-actions">
                  <ReorderAction
                    orderId={order.id}
                    orderNumber={order.number}
                    lineCount={order.lines.length}
                  />
                  <LinkButton
                    as={StoreLink}
                    href={orderHref(order)}
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                    data-account-action
                  >
                    {text.detail}
                  </LinkButton>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {(offset > 0 || offset + orders.length < total) && (
        <nav aria-label={text.pages} className="mt-(--dimension-24) flex gap-(--dimension-24)">
          {offset > 0 && (
            <StoreLink
              className={linkClass}
              href={`/historie-objednavek?offset=${Math.max(0, offset - PAGE_SIZE)}`}
            >
              {text.newer}
            </StoreLink>
          )}
          {offset + orders.length < total && (
            <StoreLink
              className={linkClass}
              href={`/historie-objednavek?offset=${offset + PAGE_SIZE}`}
            >
              {text.older}
            </StoreLink>
          )}
        </nav>
      )}
    </>
  );
}
