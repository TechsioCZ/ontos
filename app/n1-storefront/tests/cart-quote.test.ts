import { rs } from "@rstest/core";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-rstest";
import { ApplyCommandResultSchema } from "@app/merchandise/contracts/apply-command";
import {
  CartQuoteDiagnosticSchema,
  CartQuoteRequestSchema,
  CartQuoteSchema,
  CartScopeSchema,
} from "../src/ontos/cart-quote";
import { confirmCartQuote } from "../src/ontos/cart-quote-server";

rs.mock("server-only", () => ({}));
const scope = {
  currency: "CZK",
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  marketId: "71000000-0000-4000-8000-000000000097",
  tenantId: "71000000-0000-4000-8000-000000000098",
};
const line = { expectedUnitPriceMinor: 1210, productId: "product-1", quantity: 2 };
const request = { lines: [line], locale: "cs", scope };

describe("cart quote wire and owner verdict", () => {
  it.effect("allows only the declared finite phase diagnostics", () =>
    Effect.gen(function* closedDiagnosticContract() {
      for (const diagnostic of [
        "context-read-forbidden",
        "context-read-unavailable",
        "gateway-context-forbidden",
        "gateway-context-unavailable",
        "native-action-forbidden",
        "native-action-unavailable",
      ]) {
        expect(yield* Schema.decodeUnknownEffect(CartQuoteDiagnosticSchema)(diagnostic)).toBe(
          diagnostic,
        );
      }
      for (const untrusted of ["PRIVATE_PROVIDER_ERROR", { token: "PRIVATE_TOKEN" }, 403]) {
        const failure = yield* Effect.flip(
          Schema.decodeUnknownEffect(CartQuoteDiagnosticSchema)(untrusted),
        );
        expect(failure._tag).toBe("SchemaError");
      }
    }),
  );
  it("rejects repeated product/variant pairs while allowing distinct variants", () => {
    expect(Schema.is(CartQuoteRequestSchema)({ ...request, lines: [line, line] })).toBe(false);
    expect(
      Schema.is(CartQuoteRequestSchema)({
        ...request,
        lines: [
          { ...line, variantId: "v1" },
          { ...line, variantId: "v2" },
        ],
      }),
    ).toBe(true);
  });
  for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_001]) {
    it(`rejects invalid stored quantity ${quantity}`, () => {
      expect(
        Schema.is(CartQuoteRequestSchema)({ ...request, lines: [{ ...line, quantity }] }),
      ).toBe(false);
    });
  }
  it("does not accept free/unsafe prices, empty carts or excess lines", () => {
    expect(
      Schema.is(CartQuoteRequestSchema)({
        ...request,
        lines: [{ ...line, expectedUnitPriceMinor: 0 }],
      }),
    ).toBe(false);
    expect(
      Schema.is(CartQuoteRequestSchema)({
        ...request,
        lines: [{ ...line, expectedUnitPriceMinor: Number.MAX_SAFE_INTEGER + 1 }],
      }),
    ).toBe(false);
    expect(Schema.is(CartQuoteRequestSchema)({ ...request, lines: [] })).toBe(false);
    expect(
      Schema.is(CartQuoteRequestSchema)({
        ...request,
        lines: Array.from({ length: 51 }, (_, index) => ({ ...line, productId: `p${index}` })),
      }),
    ).toBe(false);
  });
  it("requires real owner totals and coherent VAT for VALID", () => {
    expect(
      Schema.is(CartQuoteSchema)({
        issues: [],
        outcome: "VALID",
        scope,
        totalMinor: null,
        totalVatMinor: null,
      }),
    ).toBe(false);
    expect(
      Schema.is(CartQuoteSchema)({
        issues: [],
        outcome: "VALID",
        scope,
        totalMinor: 10,
        totalVatMinor: 11,
      }),
    ).toBe(false);
  });
  it.effect("preserves REJECTED issues without inventing missing goods totals", () =>
    Effect.gen(function* rejectedWithoutTotals() {
      const validatedScope = yield* Schema.decodeUnknownEffect(CartScopeSchema)(scope);
      const verdict = yield* Schema.decodeUnknownEffect(ApplyCommandResultSchema)({
        entityIds: [],
        revision: 7,
        storefrontOrder: {
          issues: [
            {
              code: "PRICE_CHANGED",
              currentUnitPriceMinor: 1300,
              message: "Changed",
              productId: line.productId,
            },
          ],
          lines: [],
          outcome: "REJECTED",
        },
      });
      const quote = yield* confirmCartQuote(validatedScope, verdict);
      expect(quote).toMatchObject({
        issues: [{ code: "PRICE_CHANGED", currentUnitPriceMinor: 1300, productId: line.productId }],
        outcome: "REJECTED",
        totalMinor: null,
        totalVatMinor: null,
      });
    }),
  );
  for (const shippingPriceMinor of [undefined, 99]) {
    it.effect(
      `does not present shipping-inclusive VALID totals as goods (${shippingPriceMinor})`,
      () =>
        Effect.gen(function* rejectsShippingAmount() {
          const validatedScope = yield* Schema.decodeUnknownEffect(CartScopeSchema)(scope);
          const order =
            shippingPriceMinor === undefined
              ? { issues: [], lines: [], outcome: "VALID", totalMinor: 2420, totalVatMinor: 420 }
              : {
                  issues: [],
                  lines: [],
                  outcome: "VALID",
                  shippingPriceMinor,
                  totalMinor: 2420,
                  totalVatMinor: 420,
                };
          const verdict = yield* Schema.decodeUnknownEffect(ApplyCommandResultSchema)({
            entityIds: [],
            revision: 7,
            storefrontOrder: order,
          });
          const error = yield* Effect.flip(confirmCartQuote(validatedScope, verdict));
          expect(error.state).toBe("unavailable");
        }),
    );
  }
  for (const outcome of ["PLACED", "REPLAYED"]) {
    it.effect(`refuses ${outcome} as evidence of a non-saving quote`, () =>
      Effect.gen(function* refusesSavedOrderVerdict() {
        const validatedScope = yield* Schema.decodeUnknownEffect(CartScopeSchema)(scope);
        const verdict = yield* Schema.decodeUnknownEffect(ApplyCommandResultSchema)({
          entityIds: [],
          revision: 7,
          storefrontOrder: {
            issues: [],
            lines: [],
            outcome,
            shippingPriceMinor: 0,
            totalMinor: 2420,
            totalVatMinor: 420,
          },
        });
        const error = yield* Effect.flip(confirmCartQuote(validatedScope, verdict));
        expect(error.state).toBe("unavailable");
      }),
    );
  }
});
