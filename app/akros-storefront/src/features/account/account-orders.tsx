"use client";

import { useState } from "react";
import NextLink from "next/link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { DataTable, type ColumnDef } from "@techsio/ui-kit/organisms/data-table";
import { CheckoutSelect } from "@/features/checkout/checkout-select";
import { AccountHeading } from "./account-content";
import { mockOrders } from "@/mock-storefront/fixtures/account";

type Order = (typeof mockOrders)[number];
export const orderHref = (order: Order) =>
  `/detail-objednavky?order=${encodeURIComponent(order.number.slice(1))}`;
const columns: ColumnDef<Order>[] = [
  {
    accessorKey: "number",
    header: "Objednávka",
    cell: ({ row }) => (
      <NextLink
        className="underline underline-offset-4 hover:no-underline"
        href={orderHref(row.original)}
      >
        {row.original.number}
      </NextLink>
    ),
  },
  {
    id: "date",
    accessorFn: (order) =>
      order.date
        .split(".")
        .reverse()
        .map((part) => part.trim().padStart(2, "0"))
        .join("-"),
    header: "Datum",
    cell: ({ row }) => row.original.date,
  },
  {
    accessorKey: "items",
    header: "Položky",
    meta: { align: "end" },
    cell: ({ row }) => <span className="tabular-nums">{row.original.items}</span>,
  },
  {
    id: "total",
    accessorFn: (order) => Number(order.total.replace(/\D/g, "")),
    header: "Cena celkem",
    meta: { align: "end" },
    cell: ({ row }) => (
      <strong className="whitespace-nowrap tabular-nums">{row.original.total}</strong>
    ),
  },
  { accessorKey: "status", header: "Stav" },
  {
    id: "actions",
    header: "Detail",
    enableSorting: false,
    cell: ({ row }) => (
      <NextLink
        className="underline underline-offset-4 hover:no-underline"
        href={orderHref(row.original)}
      >
        Otevřít<span className="sr-only"> objednávku {row.original.number}</span>
      </NextLink>
    ),
  },
];

export function AccountOrders() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [month, setMonth] = useState("all");
  const orders = mockOrders.filter(
    (order) =>
      order.number.toLowerCase().includes(query.trim().toLowerCase()) &&
      (status === "all" || order.status === status) &&
      (month === "all" || order.date.includes(month)),
  );
  const clear = () => {
    setQuery("");
    setStatus("all");
    setMonth("all");
  };
  return (
    <>
      <AccountHeading
        title="Objednávky"
        description="Vyhledejte objednávku nebo si otevřete její detail."
      >
        <LinkButton
          as={NextLink}
          href="/sledovani-zasilky"
          data-account-action
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          Sledovat poslední zásilku
        </LinkButton>
      </AccountHeading>
      <div className="grid gap-(--dimension-24) rounded-(--dimension-8) bg-(--akros-account-surface) p-(--dimension-24) md:grid-cols-3 max-sm:p-(--dimension-16)">
        <FormInput
          id="account-order-search"
          label="Číslo objednávky"
          placeholder="Např. 2024-00847"
          size="sm"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <CheckoutSelect
          id="account-order-month"
          label="Období"
          value={month}
          onChange={setMonth}
          items={[
            { value: "all", label: "Všechna období" },
            { value: "10. 2026", label: "Říjen 2026" },
            { value: "09. 2026", label: "Září 2026" },
            { value: "08. 2026", label: "Srpen 2026" },
          ]}
        />
        <CheckoutSelect
          id="account-order-status"
          label="Stav objednávky"
          value={status}
          onChange={setStatus}
          items={[
            { value: "all", label: "Všechny stavy" },
            { value: "Odesláno", label: "Odesláno" },
            { value: "Doručeno", label: "Doručeno" },
          ]}
        />
      </div>
      <div className="my-(--dimension-24) flex flex-wrap items-center justify-between gap-(--dimension-16)">
        <output className="text-(length:--dimension-16) text-(--akros-account-muted)">
          Zobrazeno {orders.length} z {mockOrders.length} objednávek
        </output>
        {(query || status !== "all" || month !== "all") && (
          <Button size="sm" theme="unstyled" onClick={clear} className="underline">
            Zrušit filtry
          </Button>
        )}
      </div>
      {orders.length === 0 ? (
        <div className="rounded-(--dimension-8) bg-(--akros-account-surface) p-(--dimension-24)">
          <h2 className="font-bold">Žádné objednávky neodpovídají filtrům</h2>
          <p className="mt-(--dimension-8)">Změňte číslo objednávky, období nebo stav.</p>
        </div>
      ) : (
        <>
          <div data-account-table className="hidden min-w-0 xl:block">
            <DataTable
              data={[...orders]}
              columns={columns}
              size="sm"
              variant="line"
              enableSorting
              translations={{ emptyTitle: "Žádné objednávky" }}
            />
          </div>
          <ul
            data-account-order-cards
            className="grid gap-(--dimension-24) md:grid-cols-2 xl:hidden"
          >
            {orders.map((order) => (
              <li
                key={order.number}
                className="min-w-0 rounded-(--dimension-8) bg-(--akros-account-surface) p-(--dimension-24) max-sm:p-(--dimension-16)"
              >
                <h2 className="font-bold">
                  <NextLink
                    className="underline underline-offset-4 hover:no-underline"
                    href={orderHref(order)}
                  >
                    {order.number}
                  </NextLink>
                </h2>
                <p className="mt-(--dimension-8) text-(--akros-account-muted)">{order.date}</p>
                <dl className="my-(--dimension-24) grid gap-(--dimension-8)">
                  <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                    <dt>Položky</dt>
                    <dd className="tabular-nums">{order.items}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                    <dt>Cena celkem</dt>
                    <dd className="font-bold tabular-nums">{order.total}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                    <dt>Stav</dt>
                    <dd>{order.status}</dd>
                  </div>
                </dl>
                <LinkButton
                  as={NextLink}
                  href={orderHref(order)}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                  data-account-action
                >
                  Detail objednávky
                </LinkButton>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
