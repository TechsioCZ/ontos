"use client";

import NextLink from "next/link";
import { useEffect, useState } from "react";
import { Effect, Exit, Fiber, Match } from "effect";
import { HttpApiClient } from "effect/http-api";
import { Badge } from "@techsio/ui-kit/atoms/badge";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Icon } from "@techsio/ui-kit/atoms/icon";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { StatusText } from "@techsio/ui-kit/atoms/status-text";
import { Table } from "@techsio/ui-kit/organisms/table";
import type { Dictionary } from "@/i18n";
import { CustomerOrdersApi } from "@/ontos/customer-orders";
import type { CustomerOrder, CustomerOrdersResult } from "@/ontos/customer-orders";
import { clientRuntime } from "@/ontos/client-runtime";
import { formatMarketAmount } from "./price-props";
import { customerOrderDate } from "./customer-order-date";

const client = HttpApiClient.make(CustomerOrdersApi);
interface OrdersRequest {
  offset: number;
}
const readOrders = (locale: string, request: OrdersRequest) =>
  client.pipe(
    Effect.flatMap((api) =>
      api.customerOrders.list({
        query: { locale: locale === "en" ? "en" : "cs", offset: request.offset },
      }),
    ),
    Effect.timeout("35 seconds"),
  );
type OrderPageState =
  | { state: "loading" }
  | { data: CustomerOrdersResult; state: "ready" }
  | { state: "anonymous" | "forbidden" | "unavailable" };
const readFailure = (error: Effect.Error<ReturnType<typeof readOrders>>): OrderPageState =>
  Match.value(error).pipe(
    Match.tag("CustomerOrdersAnonymousProblem", () => ({ state: "anonymous" as const })),
    Match.tag("CustomerOrdersForbiddenProblem", () => ({ state: "forbidden" as const })),
    Match.orElse(() => ({ state: "unavailable" as const })),
  );
export const CustomerOrderStatus = ({
  dictionary: d,
  size = "md",
  status,
}: {
  dictionary: Dictionary;
  size?: "sm" | "md";
  status: CustomerOrder["status"];
}) => (
  <Badge size={size} variant={status === "CANCELLED" ? "danger" : "info"}>
    {d.checkout.statuses[status]}
  </Badge>
);

const OrderPreview = ({ order }: { order: CustomerOrder }) => (
  <div className="flex min-w-0 flex-col gap-1">
    {order.preview.map((line) => (
      <div key={JSON.stringify([line.productId, line.variantId, line.sku])}>
        <p className="text-sm wrap-break-word">{line.name}</p>
        <p className="text-xs text-fg-secondary">
          {line.variantName}
          {line.variantName !== null && line.variantName !== "" ? " · " : ""}
          {line.quantity}×
        </p>
      </div>
    ))}
  </div>
);
const DetailLink = ({
  dictionary: d,
  locale,
  order,
}: {
  dictionary: Dictionary;
  locale: string;
  order: CustomerOrder;
}) => (
  <LinkButton
    as={NextLink}
    href={`/${locale}/ucet/objednavky/${encodeURIComponent(order.id)}`}
    size="md"
    theme="solid"
    variant="secondary"
  >
    {d.detail}
  </LinkButton>
);

export const CustomerOrdersList = ({
  data,
  dictionary: d,
  locale,
}: {
  data: CustomerOrdersResult;
  dictionary: Dictionary;
  locale: string;
}) => (
  <div className="n1-order-history flex min-w-0 flex-col gap-4">
    <div className="flex flex-col items-start gap-4 border-b border-border-secondary pb-4 md:flex-row md:items-end md:justify-between">
      <div>
        <h3 className="text-xl font-semibold">{d.accountPage.history}</h3>
        <p className="text-sm text-fg-secondary">{d.accountPage.historyDescription}</p>
      </div>
      <div className="flex items-baseline gap-2 md:flex-col md:items-end md:gap-0">
        <p className="text-sm text-fg-secondary">{d.accountPage.totalSpend}</p>
        <p className="text-sm font-semibold">{d.accountPage.unknown}</p>
      </div>
    </div>
    <p className="flex items-center gap-2 text-sm">
      <Icon icon="icon-[mdi--shopping-outline]" size="sm" />
      {data.total} {d.accountPage.totalOrders}
    </p>
    {data.orders.length === 0 ? (
      <div className="flex flex-col items-center gap-2 rounded-xs border border-border-secondary p-4 text-center">
        <Icon color="secondary" icon="icon-[mdi--archive-outline]" size="2xl" />
        <h3 className="text-md font-medium">{d.accountPage.emptyOrdersHeading}</h3>
        <p className="text-sm leading-normal text-fg-secondary">{d.accountPage.emptyOrders}</p>
        <LinkButton as={NextLink} href={`/${locale}`} size="md" theme="solid" variant="secondary">
          {d.accountPage.startShopping}
        </LinkButton>
      </div>
    ) : (
      <>
        <div className="hidden min-w-0 overflow-x-auto lg:block">
          <Table size="md" variant="outline">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>{d.accountPage.orderNumber}</Table.ColumnHeader>
                <Table.ColumnHeader>{d.accountPage.createdAt}</Table.ColumnHeader>
                <Table.ColumnHeader>{d.accountPage.items}</Table.ColumnHeader>
                <Table.ColumnHeader numeric>{d.accountPage.total}</Table.ColumnHeader>
                <Table.ColumnHeader>{d.detail}</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.orders.map((order) => (
                <Table.Row key={order.id}>
                  <Table.Cell>
                    <div className="flex flex-col items-start gap-1">
                      <span>{order.number}</span>
                      <CustomerOrderStatus dictionary={d} size="sm" status={order.status} />
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    {customerOrderDate(order.createdAt, locale, d.accountPage.unknown)}
                  </Table.Cell>
                  <Table.Cell>
                    <OrderPreview order={order} />
                  </Table.Cell>
                  <Table.Cell numeric>
                    {formatMarketAmount(order.totalMinor, locale, order.currency)}
                  </Table.Cell>
                  <Table.Cell>
                    <DetailLink dictionary={d} locale={locale} order={order} />
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
        <div className="flex min-w-0 flex-col gap-3 lg:hidden">
          {data.orders.map((order) => (
            <article
              className="flex min-w-0 flex-col gap-3 rounded-xs border border-border-secondary p-3"
              key={order.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm wrap-break-word">
                    {d.accountPage.orderNumber} {order.number}
                  </h3>
                  <p className="text-xs text-fg-secondary">
                    {customerOrderDate(order.createdAt, locale, d.accountPage.unknown)}
                  </p>
                </div>
                <CustomerOrderStatus dictionary={d} size="sm" status={order.status} />
              </div>
              <OrderPreview order={order} />
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-secondary pt-2">
                <p className="font-semibold">
                  {formatMarketAmount(order.totalMinor, locale, order.currency)}
                </p>
                <DetailLink dictionary={d} locale={locale} order={order} />
              </div>
            </article>
          ))}
        </div>
      </>
    )}
  </div>
);

export const CustomerOrdersPanel = ({
  dictionary: d,
  locale,
}: {
  dictionary: Dictionary;
  locale: string;
}) => {
  const [request, setRequest] = useState<OrdersRequest>({ offset: 0 });
  const [snapshot, setSnapshot] = useState<{
    locale: string;
    request: OrdersRequest;
    result: OrderPageState;
  } | null>(null);
  useEffect(() => {
    let current = true;
    const fiber = clientRuntime.runFork(
      readOrders(locale, request).pipe(
        Effect.match({
          onFailure: readFailure,
          onSuccess: (data): OrderPageState => ({ data, state: "ready" }),
        }),
      ),
    );
    fiber.addObserver((exit) => {
      if (current) {
        setSnapshot({
          locale,
          request,
          result: Exit.isSuccess(exit) ? exit.value : { state: "unavailable" },
        });
      }
    });
    return () => {
      current = false;
      clientRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [locale, request]);
  const state: OrderPageState =
    snapshot?.request === request && snapshot.locale === locale
      ? snapshot.result
      : { state: "loading" };
  const { offset } = request;
  let body;
  if (state.state === "ready") {
    body = (
      <>
        <CustomerOrdersList data={state.data} dictionary={d} locale={locale} />
        {(state.data.total > state.data.pageSize || offset > 0) && (
          <nav aria-label={d.accountPage.orders} className="flex flex-wrap justify-between gap-2">
            <Button
              disabled={offset === 0}
              onClick={() =>
                setRequest((previous) => ({
                  offset: Math.max(0, previous.offset - state.data.pageSize),
                }))
              }
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {d.accountPage.previous}
            </Button>
            <Button
              disabled={offset + state.data.pageSize >= state.data.total}
              onClick={() =>
                setRequest((previous) => ({ offset: previous.offset + state.data.pageSize }))
              }
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {d.accountPage.next}
            </Button>
          </nav>
        )}
      </>
    );
  } else if (state.state === "loading") {
    body = <output>{d.accountPage.loading}</output>;
  } else if (state.state === "unavailable") {
    body = (
      <div className="n1-order-error flex flex-col items-center gap-2 rounded-xs border border-danger p-4 font-medium">
        <StatusText align="center" showIcon={false} size="md" status="error">
          {d.accountPage.ordersUnavailable}
        </StatusText>
        <Button
          onClick={() => setRequest((previous) => ({ ...previous }))}
          size="sm"
          theme="solid"
          variant="secondary"
        >
          {d.retry}
        </Button>
      </div>
    );
  } else {
    const message = state.state === "anonymous" ? d.accountPage.anonymous : d.accountPage.forbidden;
    body = (
      <div className="flex flex-col items-start gap-4">
        <output>{message}</output>
        <Button
          onClick={() => setRequest((previous) => ({ ...previous }))}
          size="md"
          theme="outlined"
          variant="secondary"
        >
          {d.accountPage.reload}
        </Button>
      </div>
    );
  }
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <h2 className="text-lg leading-normal font-semibold">{d.accountPage.orders}</h2>
      {body}
    </section>
  );
};
