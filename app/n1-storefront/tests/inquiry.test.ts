import { Effect, Result } from "effect";
import type { InquiryOutcome } from "../src/ontos/inquiry";
import type { InquirySubmissionRef } from "../src/ontos/inquiry-client";
import { inquiryRuntime, startInquirySubmission } from "../src/ontos/inquiry-client";
import { describe, expect, it } from "effect-rstest";
import {
  confirmInquiryTask,
  decodeInquiry,
  InquiryFailure,
  inquiryIdempotencyKey,
  isInquiryOrigin,
  makeInquiryPayload,
  sendInquiry,
  resolveInquiryProduct,
} from "../src/ontos/inquiry-model";
import { projectCatalog } from "../src/ontos/catalog-model";
import { inquiryMessageMaximum, parseInquiryProductQuery } from "../src/ontos/inquiry";

const customer = {
  email: "shopper@example.com",
  locale: "en",
  message: "Please contact me about delivery.",
  name: "Shopper",
  phone: "+420123456789",
  requestId: "71000000-0000-4000-8000-000000000099",
};
const questionCatalog = projectCatalog(
  {
    market: { configured: true, currency: "CZK", marketId: "n1-market" },
    products: [
      {
        id: "product",
        name: "Actual owner product",
        slug: "actual-owner-product",
        variantRecords: [true, false].map((active) => ({
          active,
          attributes: "",
          availability: "OUT_OF_STOCK",
          grossPriceMinor: 0,
          id: active ? "n1legacy:variant:12" : "inactive-variant",
          name: active ? "M" : "S",
          sku: active ? "ACTUAL-M" : "ACTUAL-S",
          stockOnHand: 0,
        })),
      },
    ],
  },
  [],
);

describe("N1 canonical product questions", () => {
  it("keeps the exact single selected legacy variant in the contact URL", () => {
    expect(
      parseInquiryProductQuery({ productId: "product", variantIds: "n1legacy:variant:12" }),
    ).toEqual({
      selector: { productId: "product", variantIds: ["n1legacy:variant:12"] },
      state: "product",
    });
    expect(parseInquiryProductQuery({})).toEqual({ state: "none" });
    expect(parseInquiryProductQuery({ productId: "product" })).toEqual({
      selector: { productId: "product", variantIds: [] },
      state: "product",
    });
  });
  it.each([
    { productId: "" },
    { productId: ["product", "other"] },
    { variantIds: "variant" },
    { productId: "product", variantIds: ["variant"] },
    { productId: "product", variantIds: "first,second" },
    { productId: "product", variantIds: "" },
    { productId: "p".repeat(301) },
  ])("rejects ambiguous or incomplete URL selectors", (query) => {
    expect(parseInquiryProductQuery(query)).toEqual({ state: "invalid" });
  });
  it.effect(
    "resolves an out-of-stock legacy variant and ignores client presentation metadata",
    () =>
      Effect.gen(function* canonicalProductQuestion() {
        const input = yield* decodeInquiry({
          ...customer,
          product: {
            kind: "CONTACT",
            productId: "product",
            productName: "Forged product",
            productSlug: "forged-slug",
            variantIds: ["n1legacy:variant:12"],
          },
        });
        expect(input.product).toEqual({
          productId: "product",
          variantIds: ["n1legacy:variant:12"],
        });
        if (input.product === undefined) {
          throw new Error("Expected the decoded product selector");
        }
        const context = yield* resolveInquiryProduct(input.product, questionCatalog.details);
        const payload = yield* makeInquiryPayload(input, context);
        expect(payload).toEqual({
          description: [
            "Kontakt: Shopper <shopper@example.com>",
            "Telefon: +420123456789",
            "Variant: M (ACTUAL-M) [n1legacy:variant:12]",
            "",
            customer.message,
          ].join("\n"),
          storefrontInquiry: {
            email: customer.email,
            kind: "PRODUCT_QUESTION",
            message: customer.message,
            name: customer.name,
            productId: "product",
            productName: "Actual owner product",
            productSlug: "actual-owner-product",
            requestId: customer.requestId,
            subject: "N1 product enquiry",
          },
          title: "N1 product enquiry",
        });
      }),
  );
  for (const selector of [
    { productId: "foreign-product", variantIds: [] },
    { productId: "product", variantIds: ["foreign-variant"] },
    { productId: "product", variantIds: ["inactive-variant"] },
    { productId: "product", variantIds: ["n1legacy:variant:12", "inactive-variant"] },
  ]) {
    it.effect(
      "rejects unavailable product/variant identities without silently dropping selection",
      () =>
        Effect.gen(function* invalidProductIdentity() {
          const failure = yield* Effect.flip(
            resolveInquiryProduct(selector, questionCatalog.details),
          );
          expect(failure.reason).toBe("invalid");
        }),
    );
  }
  it.effect("allows a general product question without auto-selecting its first variant", () =>
    Effect.gen(function* unselectedProductQuestion() {
      const context = yield* resolveInquiryProduct(
        { productId: "product", variantIds: [] },
        questionCatalog.details,
      );
      expect(context).not.toHaveProperty("variant");
      const input = yield* decodeInquiry({
        ...customer,
        product: { productId: "product", variantIds: [] },
      });
      const payload = yield* makeInquiryPayload(input, context);
      expect(payload).toMatchObject({
        storefrontInquiry: { kind: "PRODUCT_QUESTION", productId: "product" },
      });
    }),
  );
  it.effect("does not reach Work Tasks when the current public product read is unavailable", () =>
    Effect.gen(function* unavailableProductRead() {
      const input = yield* decodeInquiry({
        ...customer,
        product: { productId: "product", variantIds: [] },
      });
      let writes = 0;
      const failure = yield* Effect.flip(
        sendInquiry(input, {
          product: () => Effect.fail(new InquiryFailure({ reason: "unavailable" })),
          submit: () =>
            Effect.sync(() => {
              writes += 1;
              return "unexpected";
            }),
        }),
      );
      expect(failure.reason).toBe("unavailable");
      expect(writes).toBe(0);
    }),
  );
  it.effect("reserves the native description budget and never truncates a customer's message", () =>
    Effect.gen(function* nativeDescriptionBudget() {
      const context = {
        productId: "product",
        productName: "Actual",
        productSlug: "actual",
        variant: {
          id: "v".repeat(300),
          name: "M".repeat(300),
          sku: "S".repeat(300),
        },
      };
      const limit = inquiryMessageMaximum(context, "en");
      const input = yield* decodeInquiry({
        ...customer,
        email: `${"e".repeat(243)}@example.cz`,
        message: "m".repeat(limit),
        name: "N".repeat(120),
        phone: "p".repeat(40),
        product: { productId: "product", variantIds: [context.variant.id] },
      });
      const payload = yield* makeInquiryPayload(input, context);
      expect(payload.description?.length).toBeLessThanOrEqual(2000);
      expect(payload.storefrontInquiry.message).toBe(input.message);
      const failure = yield* Effect.flip(
        makeInquiryPayload({ ...input, message: `${input.message}m` }, context),
      );
      expect(failure.reason).toBe("invalid");
    }),
  );
  it.effect(
    "rejects mismatched canonical context rather than attaching the message to another product",
    () =>
      Effect.gen(function* mismatchedProductContext() {
        const input = yield* decodeInquiry({
          ...customer,
          product: { productId: "product", variantIds: [] },
        });
        const failure = yield* Effect.flip(
          makeInquiryPayload(input, {
            productId: "other",
            productName: "Other",
            productSlug: "other",
          }),
        );
        expect(failure.reason).toBe("invalid");
      }),
  );
});
describe("N1 contact owner integration", () => {
  it.effect("rejects a malformed product question instead of silently sending a contact task", () =>
    Effect.gen(function* malformedProductQuestion() {
      const failure = yield* Effect.flip(
        decodeInquiry({ ...customer, product: { productId: "", variantIds: [] } }),
      );
      expect(failure.reason).toBe("invalid");
    }),
  );
  it.effect("requires canonical product resolution before writing to the task owner", () =>
    Effect.gen(function* productResolutionRequired() {
      const input = yield* decodeInquiry({
        ...customer,
        product: { productId: "product", variantIds: ["variant"] },
      });
      let writes = 0;
      const outcome = yield* sendInquiry(input, {
        submit: () =>
          Effect.sync(() => {
            writes += 1;
            return "unexpected";
          }),
      }).pipe(Effect.result);
      expect(writes).toBe(0);
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  );
  it.effect("rejects invalid customer input before reaching the owner", () =>
    Effect.gen(function* invalidInput() {
      const failure = yield* Effect.flip(decodeInquiry({ ...customer, email: "not-email" }));
      expect(failure.reason).toBe("invalid");
    }),
  );
  it.effect("sends only the action's own fields and retains the optional phone", () =>
    Effect.gen(function* customerFieldsOnly() {
      const input = yield* decodeInquiry({
        ...customer,
        subject: "attacker",
        tenantId: "attacker",
        title: "attacker",
      });
      const payload = yield* makeInquiryPayload(input);
      // The owner answers any other field (_tag, priority, command, expectedRevision, tenant) with a 400.
      expect(payload).toEqual({
        description:
          "Kontakt: Shopper <shopper@example.com>\nTelefon: +420123456789\n\nPlease contact me about delivery.",
        storefrontInquiry: {
          email: customer.email,
          kind: "CONTACT",
          message: customer.message,
          name: customer.name,
          requestId: customer.requestId,
          subject: "N1 contact inquiry",
        },
        title: "N1 contact inquiry",
      });
    }),
  );
  for (const reason of ["unconfirmed", "forbidden", "unavailable", "invalid"] as const) {
    it.effect(`never repeats a write that ended ${reason}`, () =>
      Effect.gen(function* terminalWrite() {
        const input = yield* decodeInquiry(customer);
        const keys: string[] = [];
        const failure = yield* Effect.flip(
          sendInquiry(input, {
            submit: (_payload, key) =>
              Effect.sync(() => {
                keys.push(key);
              }).pipe(Effect.andThen(Effect.fail(new InquiryFailure({ reason })))),
          }),
        );
        expect(failure.reason).toBe(reason);
        expect(keys).toEqual([inquiryIdempotencyKey(customer.requestId)]);
      }),
    );
  }
  for (const reason of ["committed", "conflict"] as const) {
    it.effect(`resends a ${reason} refusal once under a new key with the same request id`, () =>
      Effect.gen(function* resentWrite() {
        const input = yield* decodeInquiry(customer);
        const attempts: { key: string; requestId: string }[] = [];
        const receipt = yield* sendInquiry(input, {
          submit: (payload, key) => {
            attempts.push({ key, requestId: payload.storefrontInquiry.requestId });
            return attempts.length === 1
              ? Effect.fail(new InquiryFailure({ reason }))
              : Effect.succeed("task-confirmed");
          },
        });
        const firstKey = `n1-inquiry-${customer.requestId}`;
        expect(receipt.taskId).toBe("task-confirmed");
        expect(attempts).toHaveLength(2);
        expect(attempts[0]).toEqual({ key: firstKey, requestId: customer.requestId });
        expect(attempts[1]?.key).toMatch(new RegExp(`^${firstKey}-[\\da-f-]{36}$`, "u"));
        expect(attempts[1]?.requestId).toBe(customer.requestId);
      }),
    );
  }
  for (const [first, second, expected] of [
    // Two definite refusals: nothing was saved, the form may be sent again.
    ["conflict", "conflict", "unavailable"],
    ["conflict", "forbidden", "forbidden"],
    ["conflict", "unconfirmed", "unconfirmed"],
    // A committed key means a saved task; a failed read-back is never reported as not sent.
    ["conflict", "committed", "unconfirmed"],
    ["committed", "committed", "unconfirmed"],
    ["committed", "conflict", "unconfirmed"],
    ["committed", "forbidden", "unconfirmed"],
    ["committed", "unavailable", "unconfirmed"],
  ] as const) {
    it.effect(`stops after one resend: ${first} then ${second} ends ${expected}`, () =>
      Effect.gen(function* boundedResend() {
        const input = yield* decodeInquiry(customer);
        let writes = 0;
        const failure = yield* Effect.flip(
          sendInquiry(input, {
            submit: () =>
              Effect.suspend(() => {
                writes += 1;
                return Effect.fail(new InquiryFailure({ reason: writes === 1 ? first : second }));
              }),
          }),
        );
        expect(failure.reason).toBe(expected);
        expect(writes).toBe(2);
      }),
    );
  }
});

for (const result of [
  {},
  { requestId: customer.requestId },
  { requestId: customer.requestId, taskRef: { resourceId: "task-1", tenantId: "other-tenant" } },
  { requestId: "other-request", taskRef: { resourceId: "task-1", tenantId: "n1" } },
  { requestId: customer.requestId, taskRef: { resourceId: "", tenantId: "n1" } },
  { taskRef: { resourceId: "task-1", tenantId: "n1" } },
]) {
  it.effect("requires a matching owner receipt", () =>
    Effect.gen(function* verifiesReceipt() {
      const failure = yield* Effect.flip(confirmInquiryTask(result, "n1", customer.requestId));
      expect(failure.reason).toBe("unconfirmed");
    }),
  );
}

it("requires the same complete origin", () => {
  expect(isInquiryOrigin("https://n1.example", "https://n1.example/api/inquiries")).toBe(true);
  expect(isInquiryOrigin("http://n1.example", "https://n1.example/api/inquiries")).toBe(false);
  expect(isInquiryOrigin("https://n1.example:8443", "https://n1.example/api/inquiries")).toBe(
    false,
  );
  expect(isInquiryOrigin(undefined, "https://n1.example/api/inquiries")).toBe(false);
  expect(isInquiryOrigin("not a URL", "https://n1.example/api/inquiries")).toBe(false);
});

it.effect("confirms the matching persisted task", () =>
  Effect.gen(function* confirmsSavedTask() {
    const taskId = yield* confirmInquiryTask(
      { requestId: customer.requestId, taskRef: { resourceId: "saved-task", tenantId: "n1" } },
      "n1",
      customer.requestId,
    );
    expect(taskId).toBe("saved-task");
  }),
);

it.effect(
  "allows a valid retry after warmed-runtime whitespace validation finishes synchronously",
  () =>
    Effect.gen(function* synchronousValidationRetry() {
      yield* Effect.promise(async () => await inquiryRuntime.runPromise(Effect.void));
      const active: InquirySubmissionRef = { current: null };
      const outcomes: InquiryOutcome["state"][] = [];
      let submissions = 0;
      const onOutcome = (outcome: InquiryOutcome) => {
        outcomes.push(outcome.state);
      };
      const program = (name: string) =>
        decodeInquiry({ ...customer, name }).pipe(
          Effect.flatMap(() =>
            Effect.sync((): InquiryOutcome => {
              submissions += 1;
              return { state: "unavailable" };
            }),
          ),
          Effect.catchTag("InquiryFailure", () =>
            Effect.succeed<InquiryOutcome>({ state: "invalid" }),
          ),
        );
      startInquirySubmission(active, onOutcome, program("   "));
      expect(active.current).toBeNull();
      expect(outcomes).toEqual(["invalid"]);
      expect(submissions).toBe(0);
      startInquirySubmission(active, onOutcome, program("Shopper"));
      expect(active.current).toBeNull();
      expect(outcomes).toEqual(["invalid", "unavailable"]);
      expect(submissions).toBe(1);
    }),
);
