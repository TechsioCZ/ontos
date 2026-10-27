"use client";

import { useState } from "react";
import StoreLink from "@/components/store-link";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { DataTable, type ColumnDef } from "@techsio/ui-kit/organisms/data-table";
import { AccountHeading } from "./account-content";
import { CheckoutSelect } from "@/features/checkout/checkout-select";
import { formatPrice } from "@/lib/format";
import { orderHref, orderStatusLabels, type CustomerOrder } from "@/ontos/order-model";
import { ReorderAction } from "./reorder-action";
export { orderHref } from "@/ontos/order-model";

const columns: ColumnDef<CustomerOrder>[] = [
  {
    accessorKey: "number",
    header: "Objednávka",
    cell: ({ row }) => (
      <StoreLink className="underline" href={orderHref(row.original)}>
        {row.original.number}
      </StoreLink>
    ),
  },
  {
    accessorKey: "createdAt",
    header: "Datum",
    cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString("cs-CZ"),
  },
  {
    id: "items",
    accessorFn: (order) => order.lines.length,
    header: "Položky",
    meta: { align: "end" },
    cell: ({ row }) => <span className="tabular-nums">{row.original.lines.length}</span>,
  },
  {
    accessorKey: "totalMinor",
    header: "Cena celkem",
    meta: { align: "end" },
    cell: ({ row }) => (
      <strong className="whitespace-nowrap tabular-nums">
        {formatPrice(row.original.totalMinor)}
      </strong>
    ),
  },
  {
    accessorKey: "status",
    header: "Stav",
    cell: ({ row }) => orderStatusLabels[row.original.status],
  },
  {
    id: "actions",
    header: "Akce",
    enableSorting: false,
    cell: ({ row }) => (
      <ReorderAction orderId={row.original.id}>
        <StoreLink className="whitespace-nowrap underline" href={orderHref(row.original)}>
          Otevřít
          <span className="sr-only"> objednávku {row.original.number}</span>
        </StoreLink>
      </ReorderAction>
    ),
  },
];

export function AccountOrders({
  orders,
  total,
  offset = 0,
}: {
  orders: CustomerOrder[];
  total: number;
  offset?: number;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const visible = orders.filter(
    (order) =>
      order.number.toLowerCase().includes(query.trim().toLowerCase()) &&
      (status === "all" || status === order.status),
  );
  return (
    <>
      <AccountHeading
        title="Objednávky"
        description="Vaše objednávky uložené v OntOS. Ceny jsou částky uložené při objednání."
      />
      <div className="grid gap-(--dimension-24) rounded-(--dimension-8) bg-(--akros-account-surface) p-(--dimension-24) md:grid-cols-2 max-sm:p-(--dimension-16)">
        <FormInput
          id="account-order-search"
          label="Číslo objednávky na této stránce"
          size="sm"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <CheckoutSelect
          id="account-order-status"
          label="Stav objednávky"
          value={status}
          onChange={setStatus}
          items={[
            { value: "all", label: "Všechny stavy" },
            ...Object.entries(orderStatusLabels).map(([value, label]) => ({ value, label })),
          ]}
        />
      </div>
      <p className="my-6">
        Zobrazeno {visible.length} z {total} objednávek
      </p>
      {!visible.length ? (
        <p>
          Žádné objednávky
          {query || status !== "all" ? " neodpovídají filtrům na této stránce" : " zatím nemáte"}.
        </p>
      ) : (
        <>
          <div data-account-table className="hidden min-w-0 xl:block">
            <DataTable data={visible} columns={columns} size="sm" variant="line" enableSorting />
          </div>
          <ul data-account-order-cards className="grid gap-6 md:grid-cols-2 xl:hidden">
            {visible.map((order) => (
              <li
                key={order.id}
                className="min-w-0 rounded-(--dimension-8) bg-(--akros-account-surface) p-(--dimension-24) max-sm:p-(--dimension-16)"
              >
                <h2 className="font-bold">
                  <StoreLink className="underline" href={orderHref(order)}>
                    {order.number}
                  </StoreLink>
                </h2>
                <p className="mt-(--dimension-8) text-(--akros-account-muted)">
                  {new Date(order.createdAt).toLocaleDateString("cs-CZ")}
                </p>
                <dl className="my-6 grid gap-2">
                  <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                    <dt>Položky</dt>
                    <dd className="tabular-nums">{order.lines.length}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                    <dt>Cena celkem</dt>
                    <dd className="font-bold tabular-nums">{formatPrice(order.totalMinor)}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                    <dt>Stav</dt>
                    <dd>{orderStatusLabels[order.status]}</dd>
                  </div>
                </dl>
                <ReorderAction orderId={order.id}>
                  <LinkButton
                    as={StoreLink}
                    href={orderHref(order)}
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                    data-account-action
                  >
                    Detail objednávky
                  </LinkButton>
                </ReorderAction>
              </li>
            ))}
          </ul>
        </>
      )}
      <nav aria-label="Stránky objednávek" className="mt-6 flex gap-6">
        {offset > 0 && (
          <StoreLink
            className="underline"
            href={`/historie-objednavek?offset=${Math.max(0, offset - 50)}`}
          >
            Novější objednávky
          </StoreLink>
        )}
        {offset + orders.length < total && (
          <StoreLink className="underline" href={`/historie-objednavek?offset=${offset + 50}`}>
            Starší objednávky
          </StoreLink>
        )}
      </nav>
    </>
  );
}
