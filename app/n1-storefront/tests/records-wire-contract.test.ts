import { RecordsResponseSchema } from "@app/merchandise/contracts/records";
import { SellerVatRegimeSchema } from "@app/shared-contracts/cz-vat-classifications";
import { DateTime, Effect, Option, Schema } from "effect";
import { expect, it } from "effect-rstest";

// The Merchandise records read keeps its JSON: an absent VAT regime, rate confirmation or rate source is `null` on
// the wire and `None` in the decoded record.
const wireRecord = {
  actorPrincipalRef: {
    principalId: "20000000-0000-4000-8000-000000000002",
    tenantId: "20000000-0000-4000-8000-000000000001",
  },
  canWrite: false,
  indicators: {
    lowStockCount: 0,
    openOrderValueMinor: 0,
    orderCount: 0,
    productCount: 0,
    stockValueMinor: 0,
  },
  movements: [],
  orders: [],
  products: [],
  revision: 3,
};

it.effect("encodes an absent VAT regime and rate provenance as null in the records JSON", () =>
  Effect.gen(function* encodesAbsentAsNull() {
    const record = yield* Schema.decodeUnknownEffect(RecordsResponseSchema)(wireRecord);
    const encoded = yield* Schema.encodeEffect(RecordsResponseSchema)({
      ...record,
      sellerVatRegime: Option.none(),
      taxRatesConfirmedAt: Option.none(),
      taxRatesSource: Option.none(),
    });
    expect(encoded).toEqual({
      ...wireRecord,
      sellerVatRegime: null,
      taxRatesConfirmedAt: null,
      taxRatesSource: null,
    });
  }),
);

it.effect("decodes null VAT regime and rate provenance in the records JSON as None", () =>
  Effect.gen(function* decodesNullAsNone() {
    const record = yield* Schema.decodeUnknownEffect(RecordsResponseSchema)({
      ...wireRecord,
      sellerVatRegime: null,
      taxRatesConfirmedAt: null,
      taxRatesSource: null,
    });
    expect(record.sellerVatRegime).toEqual(Option.none());
    expect(record.taxRatesConfirmedAt).toEqual(Option.none());
    expect(record.taxRatesSource).toEqual(Option.none());
  }),
);

it.effect("keeps present VAT regime and rate provenance as plain JSON values", () =>
  Effect.gen(function* keepsPresentValues() {
    const confirmedAt = "2026-11-01T08:00:00.000Z";
    const wire = {
      ...wireRecord,
      sellerVatRegime: "VAT_PAYER",
      taxRatesConfirmedAt: confirmedAt,
      taxRatesSource: "TAX",
    };
    const record = yield* Schema.decodeUnknownEffect(RecordsResponseSchema)(wire);
    expect(record.sellerVatRegime).toEqual(Option.some("VAT_PAYER"));
    expect(record.taxRatesConfirmedAt).toEqual(Option.some(DateTime.makeUnsafe(confirmedAt)));
    expect(record.taxRatesSource).toEqual(Option.some("TAX"));
    expect(yield* Schema.encodeEffect(RecordsResponseSchema)(record)).toEqual(wire);
  }),
);

it.effect("encodes the shared seller VAT regime None as null and decodes null as None", () =>
  Effect.gen(function* sellerVatRegimeWire() {
    expect(yield* Schema.encodeEffect(SellerVatRegimeSchema)(Option.none())).toBeNull();
    expect(yield* Schema.decodeUnknownEffect(SellerVatRegimeSchema)(null)).toEqual(Option.none());
    expect(yield* Schema.encodeEffect(SellerVatRegimeSchema)(Option.some("NON_PAYER"))).toBe(
      "NON_PAYER",
    );
  }),
);
