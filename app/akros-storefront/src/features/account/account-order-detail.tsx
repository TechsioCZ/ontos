"use client";

import NextLink from "next/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Table } from "@techsio/ui-kit/organisms/table";
import { AccountHeading, AccountPanel } from "./account-content";
import { mockCustomer, mockOrderLines, mockOrders } from "@/mock-storefront/fixtures/account";

export function AccountOrderDetail({ order }: { order: (typeof mockOrders)[number] }) {
  const hasLines = order.number === mockOrders[0].number;
  return (
    <>
      <AccountHeading
        title={`Objednávka ${order.number}`}
        description={`Vytvořeno ${order.date} · ${order.status}`}
      >
        <LinkButton
          as={NextLink}
          href="/historie-objednavek"
          data-account-action
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          Zpět na objednávky
        </LinkButton>
        {hasLines && (
          <LinkButton
            as={NextLink}
            href="/sledovani-zasilky"
            data-account-action
            size="sm"
            variant="primary"
          >
            Sledovat zásilku
          </LinkButton>
        )}
      </AccountHeading>
      <div className="mb-(--dimension-32) grid gap-(--dimension-24) md:grid-cols-2">
        <AccountPanel title="Fakturační údaje">
          <p>
            {mockCustomer.name}
            <br />
            {mockCustomer.company}
            <br />
            {mockCustomer.address}
            <br />
            Česká republika
          </p>
        </AccountPanel>
        <AccountPanel title="Přehled objednávky">
          <dl className="grid gap-(--dimension-16)">
            <div className="flex flex-wrap justify-between gap-(--dimension-16)">
              <dt>Stav</dt>
              <dd className="font-bold">{order.status}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-(--dimension-16)">
              <dt>Počet položek</dt>
              <dd className="tabular-nums">{order.items}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-(--dimension-16)">
              <dt>Celkem s DPH</dt>
              <dd className="font-bold tabular-nums">{order.total}</dd>
            </div>
            {hasLines && (
              <>
                <div className="flex flex-wrap justify-between gap-(--dimension-16)">
                  <dt>Zboží</dt>
                  <dd className="tabular-nums">1 450 Kč</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-(--dimension-16)">
                  <dt>Doprava PPL</dt>
                  <dd className="tabular-nums">119 Kč</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-(--dimension-16)">
                  <dt>Platba</dt>
                  <dd>Kartou online</dd>
                </div>
              </>
            )}
          </dl>
        </AccountPanel>
      </div>
      <section aria-labelledby="account-order-lines">
        <h2
          id="account-order-lines"
          className="mb-(--dimension-24) text-(length:--akros-account-section-size) font-bold leading-(--akros-account-heading-leading)"
        >
          Objednané položky
        </h2>
        {hasLines ? (
          <>
            <div data-account-table className="hidden xl:block">
              <Table size="sm" variant="line">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Produkt</Table.ColumnHeader>
                    <Table.ColumnHeader numeric>Množství</Table.ColumnHeader>
                    <Table.ColumnHeader numeric>Cena za kus</Table.ColumnHeader>
                    <Table.ColumnHeader numeric>Celkem</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {mockOrderLines.map((line) => (
                    <Table.Row key={line.code}>
                      <Table.Cell>
                        <p>{line.name}</p>
                        <p className="text-(length:--dimension-16) text-(--akros-account-muted)">
                          Kód: {line.code}
                        </p>
                      </Table.Cell>
                      <Table.Cell numeric className="whitespace-nowrap tabular-nums">
                        {line.quantity}
                      </Table.Cell>
                      <Table.Cell numeric className="whitespace-nowrap tabular-nums">
                        {line.unitPrice}
                      </Table.Cell>
                      <Table.Cell numeric className="whitespace-nowrap font-bold tabular-nums">
                        {line.total}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
            <ul className="grid gap-(--dimension-24) xl:hidden">
              {mockOrderLines.map((line) => (
                <li
                  key={line.code}
                  className="rounded-(--dimension-8) bg-(--akros-account-surface) p-(--dimension-24) max-sm:p-(--dimension-16)"
                >
                  <h3 className="font-bold">{line.name}</h3>
                  <p className="mt-(--dimension-8) text-(length:--dimension-16) text-(--akros-account-muted)">
                    Kód: {line.code}
                  </p>
                  <dl className="mt-(--dimension-24) grid gap-(--dimension-8)">
                    <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                      <dt>Množství</dt>
                      <dd>{line.quantity}</dd>
                    </div>
                    <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                      <dt>Cena za kus</dt>
                      <dd>{line.unitPrice}</dd>
                    </div>
                    <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                      <dt>Celkem</dt>
                      <dd className="font-bold">{line.total}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="rounded-(--dimension-8) bg-(--akros-account-surface) p-(--dimension-24)">
            Položky této ukázkové objednávky nejsou v prototypu dostupné.
          </p>
        )}
      </section>
    </>
  );
}
