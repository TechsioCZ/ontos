import { withOwnerOperation } from "./owner-operation";
import "server-only";
import { OrderSchema } from "@app/merchandise/contracts/records";
import type { RecordsViewSchema } from "@app/merchandise/contracts/records";
import { orderCurrency } from "@app/merchandise/domain/merchandise-model";
import { Effect, Schema } from "effect";
import type { StorefrontConfiguration } from "./config";
import { readConfiguration } from "./config";
import { CustomerOrdersInputSchema, CustomerOrdersResultSchema } from "./customer-orders";
import type {
  CustomerOrdersInput,
  CustomerOrder,
  CustomerOrdersResult,
  CustomerOrdersView,
} from "./customer-orders";
import { readOwner } from "./gateway";
import { readOrderedProducts } from "./ordered-product-server";
import { portalFailureOutcome, readPortalIdentityWithConfiguration } from "./portal-server";
import type { PortalRequestContext } from "./portal-server";
import { storefrontRuntime } from "./runtime";

export class CustomerOrdersFailure extends Schema.TaggedError<CustomerOrdersFailure>()(
  "CustomerOrdersFailure",
  { state: Schema.Literals(["invalid", "anonymous", "forbidden", "unavailable"]) },
) {}

const snapshotSchema = Schema.Struct({
  movements: Schema.Array(Schema.Never),
  orders: Schema.Array(OrderSchema).check(Schema.isMaxLength(50)),
  products: Schema.Array(Schema.Never),
  totalOrders: Schema.Int.check(Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })),
});

type CustomerOrdersFilter = NonNullable<
  (typeof RecordsViewSchema.Encoded)["storefrontCustomerOrders"]
>;

/** Project already-owned native data without carrying account, Party or invocation identifiers. */
const projectCustomerOrder = (order: typeof OrderSchema.Type, includeDetail: boolean) =>
  Effect.gen(function* projectCustomerOrderProgram() {
    const stored = yield* Schema.encodeEffect(OrderSchema)(order).pipe(
      Effect.mapError(() => new CustomerOrdersFailure({ state: "unavailable" })),
    );
    const result: CustomerOrder = {
      createdAt: stored.createdAt,
      currency: orderCurrency(order),
      detail: includeDetail
        ? {
            billingAddress: stored.billingAddress ?? null,
            contact: stored.contact ?? null,
            deliveryAddress: stored.deliveryAddress ?? null,
            deliveryRecipient: stored.deliveryRecipient ?? null,
            lines: stored.lines,
            note: stored.note ?? null,
          }
        : null,
      id: stored.id,
      market: stored.market ?? null,
      number: stored.number,
      preview: stored.lines.map((line) => ({
        name: line.productName,
        productId: line.productId,
        quantity: line.quantity,
        sku: line.sku,
        variantId: line.variantId ?? null,
        variantName: line.variantName ?? null,
      })),
      pricesIncludeVat: stored.pricesIncludeVat ?? null,
      shipping: stored.shipping ?? null,
      status: stored.status,
      totalMinor: stored.totalMinor,
      totalVatMinor: stored.totalVatMinor,
      updatedAt: stored.updatedAt,
    };
    return result;
  });

const marketKey = (market: NonNullable<CustomerOrder["market"]>) =>
  `${market.marketId}:${market.currency}`;

/** Resolve public presentation only after all returned orders pass customer ownership checks. */
const presentOrderProducts = (config: StorefrontConfiguration, orders: readonly CustomerOrder[]) =>
  Effect.gen(function* presentOrderProductsProgram() {
    const groups = new Map<
      string,
      { market: NonNullable<CustomerOrder["market"]>; products: Set<string> }
    >();
    for (const order of orders) {
      if (order.market === null) {
        continue;
      }
      const key = marketKey(order.market);
      let group = groups.get(key);
      if (group === undefined) {
        group = { market: order.market, products: new Set() };
        groups.set(key, group);
      }
      for (const line of order.preview) {
        group.products.add(line.productId);
      }
    }
    const resolved = yield* Effect.forEach(
      [...groups.entries()].slice(0, 4),
      ([key, { market, products }]) =>
        readOrderedProducts(config, market, [...products].slice(0, 50)).pipe(
          Effect.map((items) => [key, items] as const),
        ),
      { concurrency: 4 },
    );
    const byMarket = new Map(resolved);
    return orders.map((order) => {
      const products = order.market === null ? undefined : byMarket.get(marketKey(order.market));
      const ownIds = new Set(order.preview.map((line) => line.productId));
      const presentation = products?.filter((product) => ownIds.has(product.productId)) ?? [];
      return presentation.length === 0 ? order : { ...order, productPresentation: presentation };
    });
  });

/** The owner binds tenant/seller from the gateway assertion; customer ownership is checked again here. */
const readCustomerOrdersSnapshot = (
  config: StorefrontConfiguration,
  input: CustomerOrdersInput,
  request: PortalRequestContext,
) =>
  withOwnerOperation(
    Effect.gen(function* readCustomerOrdersProgram() {
      const selection = yield* Schema.decodeEffect(CustomerOrdersInputSchema, {
        onExcessProperty: "error",
      })(input).pipe(Effect.mapError(() => new CustomerOrdersFailure({ state: "invalid" })));
      const requestedOrderId =
        selection.orderId === undefined
          ? undefined
          : yield* Schema.decodeEffect(OrderSchema.fields.id)(selection.orderId).pipe(
              Effect.mapError(() => new CustomerOrdersFailure({ state: "invalid" })),
            );
      const identity = yield* readPortalIdentityWithConfiguration(config, request).pipe(
        Effect.mapError(
          (error) =>
            new CustomerOrdersFailure({
              state: portalFailureOutcome(error).state === "refused" ? "forbidden" : "unavailable",
            }),
        ),
      );
      if (identity.state === "anonymous") {
        return yield* new CustomerOrdersFailure({ state: "anonymous" });
      }
      if (identity.account.tenantId !== config.tenantId) {
        return yield* new CustomerOrdersFailure({ state: "unavailable" });
      }
      const pageOffset = selection.offset ?? 0;
      const baseFilter = {
        customerAccountId: identity.account.id,
        offset: pageOffset,
      } satisfies CustomerOrdersFilter;
      const filter =
        requestedOrderId === undefined
          ? baseFilter
          : ({ ...baseFilter, orderId: requestedOrderId } satisfies CustomerOrdersFilter);
      const snapshot = yield* readOwner(
        config,
        "merchandise",
        "records",
        { view: { storefront: true, storefrontCustomerOrders: filter } },
        snapshotSchema,
      ).pipe(
        Effect.mapError(
          (error) =>
            new CustomerOrdersFailure({
              state: error.reason === "forbidden" ? "forbidden" : "unavailable",
            }),
        ),
      );
      if (
        new Set(snapshot.orders.map((order) => order.id)).size !== snapshot.orders.length ||
        snapshot.orders.length > Math.min(50, Math.max(0, snapshot.totalOrders - pageOffset)) ||
        (requestedOrderId !== undefined && snapshot.totalOrders > 1)
      ) {
        return yield* new CustomerOrdersFailure({ state: "unavailable" });
      }
      const orders: CustomerOrdersResult["orders"][number][] = [];
      for (const order of snapshot.orders) {
        if (
          order.channel !== "STOREFRONT" ||
          order.customerAccountId !== identity.account.id ||
          order.demoCleanup !== undefined ||
          (requestedOrderId !== undefined && order.id !== requestedOrderId)
        ) {
          return yield* new CustomerOrdersFailure({ state: "unavailable" });
        }
        orders.push(yield* projectCustomerOrder(order, requestedOrderId !== undefined));
      }
      const data = yield* Schema.decodeEffect(CustomerOrdersResultSchema)({
        offset: pageOffset,
        orders: yield* presentOrderProducts(config, orders),
        pageSize: 50,
        total: snapshot.totalOrders,
      }).pipe(Effect.mapError(() => new CustomerOrdersFailure({ state: "unavailable" })));
      return { data, viewerEmail: identity.account.email };
    }),
  ).pipe(
    Effect.catchTags({
      OperationError: () => Effect.fail(new CustomerOrdersFailure({ state: "unavailable" })),
      SchemaError: () => Effect.fail(new CustomerOrdersFailure({ state: "unavailable" })),
    }),
  );

export const readCustomerOrdersWithConfiguration = (
  config: StorefrontConfiguration,
  input: CustomerOrdersInput,
  request: PortalRequestContext,
) =>
  withOwnerOperation(
    readCustomerOrdersSnapshot(config, input, request).pipe(
      Effect.map((snapshot) => snapshot.data),
    ),
  ).pipe(
    Effect.catchTags({
      OperationError: () => Effect.fail(new CustomerOrdersFailure({ state: "unavailable" })),
      SchemaError: () => Effect.fail(new CustomerOrdersFailure({ state: "unavailable" })),
    }),
  );

const configuration = readConfiguration(process.env).pipe(
  Effect.mapError(() => new CustomerOrdersFailure({ state: "unavailable" })),
);

export const readCustomerOrders = (input: CustomerOrdersInput, request: PortalRequestContext) =>
  configuration.pipe(
    Effect.flatMap((config) => readCustomerOrdersWithConfiguration(config, input, request)),
  );

/** Uncached SSR edge: every request performs fresh owner admission, including its cookie context. */
export const getCustomerOrders = async (
  input: CustomerOrdersInput,
  request: PortalRequestContext,
): Promise<CustomerOrdersView> =>
  await storefrontRuntime.runPromise(
    configuration.pipe(
      Effect.flatMap((config) => readCustomerOrdersSnapshot(config, input, request)),
      Effect.match({
        onFailure: (error): CustomerOrdersView => ({
          state: error.state === "invalid" ? "unavailable" : error.state,
        }),
        onSuccess: (snapshot): CustomerOrdersView => ({ ...snapshot, state: "ready" }),
      }),
    ),
  );
